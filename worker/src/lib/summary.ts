// Replaces the LRU Redis (port 6379) helpers from
// frontend/cfb/routes.js (`retrieveLeagueData`, `retrieveLastUpdated`,
// the `retrieveRemote*` family) with KV-backed equivalents. KV writes
// use `expirationTtl` to match the Express side's 3-day TTL.
//
// Sub-phase 2H follow-up (2026-05-03): the summary service used to be
// reachable at the Docker-internal `http://summary:3000` from inside
// the Express container's compose network. Post-cutover the Worker
// runs at CF edge and can't resolve that hostname. Same fix shape as
// Python (lib/games.ts): expose summary publicly via Caddy on the
// droplet at `https://summary.unseen-university.org`, gated on the
// shared `X-Worker-Secret` header. Each `retrieve*` function now
// takes a SummaryConfig (kv + base URL + secret) so the URL is
// passed in by the route handler from c.env rather than hardcoded.

import { MIN_SEASON } from "./season";

// Three-day TTL on summary data — matches frontend/cfb/routes.js's
// `EX: 60 * 60 * 24 * 3` on every redisClient.set.
const TTL_SECONDS = 60 * 60 * 24 * 3;

// Cap year-1 fallback recursion at 2 hops. Mirrors the Phase 1
// REMOTE_YEAR_RETRY_BUDGET on the Express side. Pre-cap, any transient
// summary-service hiccup amplified into a 10s page load that
// saturated the summary container.
const REMOTE_YEAR_RETRY_BUDGET = 2;

// Bundles everything the retrieve* helpers need: the KV namespace
// holding the cached results, the public summary base URL, and the
// shared secret to prove the request originated from the Worker.
// Built once per request by the route handler from c.env (see
// summaryCfg() / lastUpdatedCfg() in index.tsx).
export interface SummaryConfig {
  kv: KVNamespace;
  base: string;
  secret?: string | null;
}

export interface TeamLeagueRow {
  teamId: number | string;
  team: string;
  // The actual stats live under namespaced sub-objects (overall,
  // passing, rushing, defensive, ...). We don't pin the schema here
  // because the summary service's response varies by `type` — the
  // route handler picks the relevant slice and the template walks it
  // with retrieveValue("foo.bar.baz")-style dotted keys.
  [key: string]: unknown;
}

interface SummaryListResponse {
  results: TeamLeagueRow[];
}

interface LastUpdatedResponse {
  last_updated: string;
}

function authHeaders(secret: string | null | undefined, extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  if (secret) headers["X-Worker-Secret"] = secret;
  return headers;
}

async function postSummaryForm(
  cfg: SummaryConfig,
  payload: Record<string, string>,
): Promise<TeamLeagueRow[]> {
  const body = new URLSearchParams(payload);
  const response = await fetch(`${cfg.base}/`, {
    method: "POST",
    headers: authHeaders(cfg.secret, { "Content-Type": "application/x-www-form-urlencoded" }),
    body,
  });
  if (!response.ok) {
    throw new Error(`summary POST returned ${response.status}`);
  }
  const data = (await response.json()) as SummaryListResponse;
  return data.results ?? [];
}

async function fetchRemoteLeagueData(
  cfg: SummaryConfig,
  year: number,
  type: string,
  retriesRemaining = REMOTE_YEAR_RETRY_BUDGET,
): Promise<TeamLeagueRow[]> {
  try {
    const content = await postSummaryForm(cfg, { year: String(year), type });
    await cfg.kv.put(`${year}-${type}`, JSON.stringify(content), {
      expirationTtl: TTL_SECONDS,
    });
    return content;
  } catch (err) {
    console.log(
      JSON.stringify({
        event: "summary_failure",
        endpoint: "league_data",
        year,
        type,
        retries_remaining: retriesRemaining,
        error: (err as Error).message,
      }),
    );
    if (retriesRemaining <= 0 || year - 1 < MIN_SEASON) {
      return [];
    }
    return fetchRemoteLeagueData(cfg, year - 1, type, retriesRemaining - 1);
  }
}

// KV-first reader. Cache miss falls back to the summary service via
// fetchRemoteLeagueData, which writes through to KV on success.
export async function retrieveLeagueData(
  cfg: SummaryConfig,
  year: number,
  type: string,
): Promise<TeamLeagueRow[]> {
  const key = `${year}-${type}`;
  const cached = await cfg.kv.get(key);
  if (cached) {
    try {
      return JSON.parse(cached) as TeamLeagueRow[];
    } catch {
      // Bad JSON in KV — fall through and refetch. The Express side
      // does the same: any throw goes to the catch block that calls
      // retrieveRemoteLeagueData.
    }
  }
  return fetchRemoteLeagueData(cfg, year, type);
}

// Percentile rows. Schema is summary-service-defined, fields vary by
// metric. Only the keys used by getPercentileKey() are accessed.
export interface PercentileRow {
  season: number;
  pctile: number | string;
  [key: string]: unknown;
}

async function fetchRemotePercentiles(
  cfg: SummaryConfig,
  year: number | null,
  pctile: number | null,
): Promise<PercentileRow[]> {
  const params = new URLSearchParams();
  if (year != null) params.set("year", String(year));
  if (pctile != null) params.set("pctile", String(pctile));
  const response = await fetch(`${cfg.base}/percentiles?${params}`, {
    headers: authHeaders(cfg.secret),
  });
  if (!response.ok) {
    throw new Error(`summary /percentiles returned ${response.status}`);
  }
  const data = (await response.json()) as { results: PercentileRow[] };
  const content = data.results ?? [];
  // Same key shape as the Express side: `${year}-percentiles-${pctile}`,
  // with empty segments for null inputs filtered by generateKey.
  const keyParts = [year, "percentiles", pctile].filter((p) => p != null);
  if (keyParts.length > 0) {
    await cfg.kv.put(keyParts.join("-"), JSON.stringify(content), {
      expirationTtl: TTL_SECONDS,
    });
  }
  return content;
}

// KV-first percentile reader. Mirrors `retrievePercentiles` in
// frontend/cfb/routes.js:135. Either `year` or `pctile` (or both) must
// be provided — calling with both null returns []. The trends route
// calls this 5x with year=null, pctile=0.01/0.25/0.5/0.75/0.99.
export async function retrievePercentiles(
  cfg: SummaryConfig,
  year: number | null,
  pctile: number | null,
): Promise<PercentileRow[]> {
  if (year == null && pctile == null) return [];
  const keyParts = [year, "percentiles", pctile].filter((p) => p != null);
  const key = keyParts.join("-");
  const cached = await cfg.kv.get(key);
  if (cached) {
    try {
      return JSON.parse(cached) as PercentileRow[];
    } catch {
      // Bad JSON in KV — fall through and refetch.
    }
  }
  try {
    return await fetchRemotePercentiles(cfg, year, pctile);
  } catch (err) {
    console.log(
      JSON.stringify({
        event: "summary_failure",
        endpoint: "percentiles",
        year,
        pctile,
        error: (err as Error).message,
      }),
    );
    return [];
  }
}

async function fetchRemoteTeamData(
  cfg: SummaryConfig,
  year: number | null,
  teamId: string | number,
  type: string | null,
  retriesRemaining = REMOTE_YEAR_RETRY_BUDGET,
): Promise<TeamLeagueRow[]> {
  try {
    const payload: Record<string, string> = { team: String(teamId) };
    if (year != null) payload.year = String(year);
    if (type != null) payload.type = type;
    const content = await postSummaryForm(cfg, payload);
    // generateKey-equivalent: skip null parts.
    const keyParts = [year, teamId, type].filter((p) => p != null);
    if (keyParts.length > 0) {
      await cfg.kv.put(keyParts.join("-"), JSON.stringify(content), {
        expirationTtl: TTL_SECONDS,
      });
    }
    return content;
  } catch (err) {
    console.log(
      JSON.stringify({
        event: "summary_failure",
        endpoint: "team_data",
        year,
        teamId,
        type,
        retries_remaining: retriesRemaining,
        error: (err as Error).message,
      }),
    );
    if (retriesRemaining <= 0 || year == null || year - 1 < MIN_SEASON) {
      // Express returns `[{ pos_team: team_id }]` on hard failure,
      // not [] — preserve that quirk so consumers that expect
      // a non-empty list don't crash.
      return [{ teamId, team: "", pos_team: teamId } as TeamLeagueRow];
    }
    return fetchRemoteTeamData(cfg, year - 1, teamId, type, retriesRemaining - 1);
  }
}

// KV-first team-data reader. Mirrors `retrieveTeamData` in
// frontend/cfb/routes.js:256. Either year and/or teamId required;
// `type` may be null (multi-season aggregate). Cache key shape:
// `${year-or-empty}-${teamId-or-empty}-${type-or-empty}` with empty
// segments stripped.
export async function retrieveTeamData(
  cfg: SummaryConfig,
  year: number | null,
  teamId: string | number,
  type: string | null,
): Promise<TeamLeagueRow[]> {
  if (year == null && teamId == null) return [];
  const keyParts = [year, teamId, type].filter((p) => p != null);
  if (keyParts.length === 0) return [];
  const key = keyParts.join("-");
  const cached = await cfg.kv.get(key);
  if (cached) {
    try {
      return JSON.parse(cached) as TeamLeagueRow[];
    } catch {
      // Bad JSON — refetch.
    }
  }
  return fetchRemoteTeamData(cfg, year, teamId, type);
}

async function fetchRemoteLastUpdated(cfg: SummaryConfig): Promise<string | null> {
  const response = await fetch(`${cfg.base}/updated`, {
    headers: authHeaders(cfg.secret),
  });
  if (!response.ok) return null;
  const content = (await response.json()) as LastUpdatedResponse;
  await cfg.kv.put("summary-last-updated", JSON.stringify(content), {
    expirationTtl: TTL_SECONDS,
  });
  return content.last_updated;
}

export async function retrieveLastUpdated(cfg: SummaryConfig): Promise<string | null> {
  try {
    const cached = await cfg.kv.get("summary-last-updated");
    if (cached) {
      const parsed = JSON.parse(cached) as LastUpdatedResponse;
      return parsed.last_updated;
    }
  } catch {
    // Fall through to refetch on any KV / parse failure.
  }
  try {
    return await fetchRemoteLastUpdated(cfg);
  } catch (err) {
    console.log(
      JSON.stringify({
        event: "summary_failure",
        endpoint: "updated",
        error: (err as Error).message,
      }),
    );
    return null;
  }
}
