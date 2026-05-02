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
