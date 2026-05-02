// Replaces the LRU Redis (port 6379) helpers from
// frontend/cfb/routes.js (`retrieveLeagueData`, `retrieveLastUpdated`,
// the `retrieveRemote*` family) with KV-backed equivalents. KV writes
// use `expirationTtl` to match the Express side's 3-day TTL.

import { MIN_SEASON } from "./season";

const SUMMARY_BASE = "http://summary:3000";

// Three-day TTL on summary data — matches frontend/cfb/routes.js's
// `EX: 60 * 60 * 24 * 3` on every redisClient.set.
const TTL_SECONDS = 60 * 60 * 24 * 3;

// Cap year-1 fallback recursion at 2 hops. Mirrors the Phase 1
// REMOTE_YEAR_RETRY_BUDGET on the Express side. Pre-cap, any transient
// summary-service hiccup amplified into a 10s page load that
// saturated the summary container.
const REMOTE_YEAR_RETRY_BUDGET = 2;

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

async function postSummaryForm(payload: Record<string, string>): Promise<TeamLeagueRow[]> {
  const body = new URLSearchParams(payload);
  const response = await fetch(`${SUMMARY_BASE}/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) {
    throw new Error(`summary POST returned ${response.status}`);
  }
  const data = (await response.json()) as SummaryListResponse;
  return data.results ?? [];
}

async function fetchRemoteLeagueData(
  kv: KVNamespace,
  year: number,
  type: string,
  retriesRemaining = REMOTE_YEAR_RETRY_BUDGET,
): Promise<TeamLeagueRow[]> {
  try {
    const content = await postSummaryForm({ year: String(year), type });
    await kv.put(`${year}-${type}`, JSON.stringify(content), {
      expirationTtl: TTL_SECONDS,
    });
    return content;
  } catch (err) {
    console.log(
      `summary fetch failed for ${year}/${type}, retries remaining: ${retriesRemaining}, err: ${(err as Error).message}`,
    );
    if (retriesRemaining <= 0 || year - 1 < MIN_SEASON) {
      return [];
    }
    return fetchRemoteLeagueData(kv, year - 1, type, retriesRemaining - 1);
  }
}

// KV-first reader. Cache miss falls back to the summary service via
// fetchRemoteLeagueData, which writes through to KV on success.
export async function retrieveLeagueData(
  kv: KVNamespace,
  year: number,
  type: string,
): Promise<TeamLeagueRow[]> {
  const key = `${year}-${type}`;
  const cached = await kv.get(key);
  if (cached) {
    try {
      return JSON.parse(cached) as TeamLeagueRow[];
    } catch {
      // Bad JSON in KV — fall through and refetch. The Express side
      // does the same: any throw goes to the catch block that calls
      // retrieveRemoteLeagueData.
    }
  }
  return fetchRemoteLeagueData(kv, year, type);
}

// Percentile rows. Schema is summary-service-defined, fields vary by
// metric. Only the keys used by getPercentileKey() are accessed.
export interface PercentileRow {
  season: number;
  pctile: number | string;
  [key: string]: unknown;
}

async function fetchRemotePercentiles(
  kv: KVNamespace,
  year: number | null,
  pctile: number | null,
): Promise<PercentileRow[]> {
  const params = new URLSearchParams();
  if (year != null) params.set("year", String(year));
  if (pctile != null) params.set("pctile", String(pctile));
  const response = await fetch(`${SUMMARY_BASE}/percentiles?${params}`);
  if (!response.ok) {
    throw new Error(`summary /percentiles returned ${response.status}`);
  }
  const data = (await response.json()) as { results: PercentileRow[] };
  const content = data.results ?? [];
  // Same key shape as the Express side: `${year}-percentiles-${pctile}`,
  // with empty segments for null inputs filtered by generateKey.
  const keyParts = [year, "percentiles", pctile].filter((p) => p != null);
  if (keyParts.length > 0) {
    await kv.put(keyParts.join("-"), JSON.stringify(content), {
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
  kv: KVNamespace,
  year: number | null,
  pctile: number | null,
): Promise<PercentileRow[]> {
  if (year == null && pctile == null) return [];
  const keyParts = [year, "percentiles", pctile].filter((p) => p != null);
  const key = keyParts.join("-");
  const cached = await kv.get(key);
  if (cached) {
    try {
      return JSON.parse(cached) as PercentileRow[];
    } catch {
      // Bad JSON in KV — fall through and refetch.
    }
  }
  try {
    return await fetchRemotePercentiles(kv, year, pctile);
  } catch (err) {
    console.log(
      `summary /percentiles fetch failed for year=${year}, pctile=${pctile}: ${(err as Error).message}`,
    );
    return [];
  }
}

async function fetchRemoteLastUpdated(kv: KVNamespace): Promise<string | null> {
  const response = await fetch(`${SUMMARY_BASE}/updated`);
  if (!response.ok) return null;
  const content = (await response.json()) as LastUpdatedResponse;
  await kv.put("summary-last-updated", JSON.stringify(content), {
    expirationTtl: TTL_SECONDS,
  });
  return content.last_updated;
}

export async function retrieveLastUpdated(kv: KVNamespace): Promise<string | null> {
  try {
    const cached = await kv.get("summary-last-updated");
    if (cached) {
      const parsed = JSON.parse(cached) as LastUpdatedResponse;
      return parsed.last_updated;
    }
  } catch {
    // Fall through to refetch on any KV / parse failure.
  }
  try {
    return await fetchRemoteLastUpdated(kv);
  } catch (err) {
    console.log(`summary /updated fetch failed: ${(err as Error).message}`);
    return null;
  }
}
