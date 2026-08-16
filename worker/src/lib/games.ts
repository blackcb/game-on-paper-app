import type { BackendFetch } from "./backends";
import { espnFetch } from "./espn_fetch";
import { logSchemaFailure, validateProcessResponse } from "./schema";

// Replaces frontend/cfb/games.js. Per-game PBP retrieval: calls the
// Python `/cfb/process` service and reshapes the response into the
// ProcessedGameData shape the templates expect. As of sub-phase 2D
// the Worker no longer caches the JSON itself — `caches.default`
// (keyed by request URL) caches the rendered Response upstream of
// this module. Cache-Control set per-branch in the route handler
// dictates TTL: long s-maxage for completed games, 30 s for
// in-progress. The Express stack used Redis instance 2 for this
// role; that role is now split between the Cache API (response
// caching) and Python's own pipeline.

// Game IDs whose ESPN payload reproducibly crashes the Python pipeline
// (missing statYardage, broken drives, etc.). The Express side
// short-circuits these to the game_error template instead of paying
// the 5 s pipeline cost on every retry. Add new entries when a
// gameId reproducibly errors with an upstream-data cause; remove
// entries that ESPN has since re-published cleanly.
export const QUARANTINE_LIST = new Set<string>([
  "401411157",
  "401403861",
  "401628329",
  "401634301",
  "401634212",
  "401628398",
]);

const NICKNAME_LOWERCASE_TEAMS = new Set([61]);

// game_error.ejs / pregame.ejs / game.ejs all use this. Distinct from
// team_helpers.cleanAbbreviation: that one operates on the
// `abbreviation` field; this on the `nickname` field. Same Georgia-61
// rule, different upstream property.
export function cleanName(team: { id?: unknown; nickname?: unknown }): string {
  const nickname = String(team.nickname ?? "");
  if (NICKNAME_LOWERCASE_TEAMS.has(parseInt(String(team.id ?? ""), 10))) {
    return nickname.toLocaleLowerCase();
  }
  return nickname;
}

export interface ProcessedGameData {
  gameInfo?: {
    status?: { type?: { completed?: boolean; name?: string; detail?: string } };
    competitors?: Array<{ team?: { id?: string | number }; score?: number | string }>;
    [key: string]: unknown;
  };
  header?: {
    season?: { year?: number };
    competitions?: Array<unknown>;
    [key: string]: unknown;
  };
  plays?: Play[];
  scoringPlays?: Play[];
  homeTeamId?: string | number;
  awayTeamId?: string | number;
  boxScore?: unknown;
  advBoxScore?: unknown;
  [key: string]: unknown;
}

interface Play {
  pos_team?: string | number;
  homeScore?: number;
  awayScore?: number;
  scoringPlay?: boolean;
  winProbability?: { before?: number; after?: number };
  [key: string]: unknown;
}

// Game Excitement Index — sum of absolute home-team WP swings across
// all plays, normalized to a "standard-length" game (179.0177 plays
// is the historical mean). Last play's WP is forced to 1.0/0.0 by
// the caller so the final swing reflects the actual outcome rather
// than the model's pre-final estimate. Mirrors games.js:199-241.
const GEI_NORMALIZE_PLAY_COUNT = 179.01777401608126;

export function calculateGEI(plays: Play[], homeTeamId: string | number): number {
  if (plays.length === 0) return 0;

  const homeWP = (play: Play | null): number => {
    if (play == null) return 0.0;
    const offWP = play.winProbability?.before ?? 0.0;
    const defWP = 1.0 - offWP;
    return String(play.pos_team) === String(homeTeamId) ? offWP : defWP;
  };

  const wpDiffs: number[] = [];
  for (let i = 0; i < plays.length; i++) {
    const play = plays[i];
    const nextPlay = i + 1 >= plays.length ? null : plays[i + 1];
    let finalWP: number;
    if ((play.homeScore ?? 0) > (play.awayScore ?? 0)) {
      finalWP = String(play.pos_team) === String(homeTeamId) ? 1.0 : 0.0;
    } else {
      finalWP = String(play.pos_team) === String(homeTeamId) ? 0.0 : 1.0;
    }
    const nextWP = nextPlay != null ? homeWP(nextPlay) : finalWP;
    wpDiffs.push(nextWP - homeWP(play));
  }

  const normalize = GEI_NORMALIZE_PLAY_COUNT / plays.length;
  const total = wpDiffs.map((p) => Math.abs(p)).reduce((acc, v) => acc + v, 0);
  return normalize * total;
}

interface ProcessResponse {
  plays?: Play[];
  box_score?: unknown;
  boxScore?: unknown;
  header?: ProcessedGameData["header"];
  homeTeamId?: string | number;
  awayTeamId?: string | number;
  records?: unknown;
  [key: string]: unknown;
}

// Reshape a /cfb/process Response into ProcessedGameData. Shared by
// the service-binding caller (fetchAndShapePBP) and the tiered-fetch
// caller (fetchAndShapePBPTiered) — they differ only in how they
// obtain the Response.
async function _reshapeProcessResponse(
  response: Response,
  gameId: string | number,
  pathLabel: string,
): Promise<ProcessedGameData> {
  if (!response.ok) {
    throw new Error(`Python ${pathLabel} returned ${response.status}`);
  }
  const data = (await response.json()) as ProcessResponse;
  if (!validateProcessResponse(data)) {
    logSchemaFailure(gameId, validateProcessResponse.errors ?? []);
  }
  const pbp: ProcessedGameData = { ...(data as ProcessedGameData) };
  pbp.plays = data.plays ?? [];
  pbp.advBoxScore = data.box_score;
  pbp.boxScore = data.boxScore;
  pbp.gameInfo = pbp.header?.competitions?.[0] as ProcessedGameData["gameInfo"];
  pbp.scoringPlays = pbp.plays.filter((p) => p.scoringPlay === true);
  delete pbp.records;
  delete (pbp as { box_score?: unknown }).box_score;

  if (pbp.plays.length > 0 && pbp.gameInfo?.status?.type?.completed === true) {
    const homeId = pbp.homeTeamId;
    const awayId = pbp.awayTeamId;
    const last = pbp.plays[pbp.plays.length - 1];
    if (last.winProbability == null) last.winProbability = {};
    if (
      String(last.pos_team) === String(homeId) &&
      (last.homeScore ?? 0) > (last.awayScore ?? 0)
    ) {
      last.winProbability.after = 1.0;
    } else if (
      String(last.pos_team) === String(awayId) &&
      (last.homeScore ?? 0) < (last.awayScore ?? 0)
    ) {
      last.winProbability.after = 1.0;
    } else {
      last.winProbability.after = 0.0;
    }
    if (homeId != null) {
      (pbp.gameInfo as { gei?: number }).gei = calculateGEI(pbp.plays, homeId);
    }
  }
  return pbp;
}

// Calls the Python /cfb/process endpoint. Returns the raw response
// reshaped into the ProcessedGameData shape the templates expect:
// plays array, derived gameInfo, scoring play subset, last-play WP
// pinned to 1.0/0.0 for completed games, GEI computed for completed.
// Mirrors games.js:129-171 (_remoteRetrievePBP). Public from sub-
// phase 2D onwards — was wrapped by getPBP/peekCachedPBP in 2B
// when KV was the cache layer.
//
// Schema validation (sub-phase 2G): the Python response is run
// through the JSON Schema contract validator before the reshape.
// Failures are warn-only — Python is the canonical validator so
// rejecting here would turn schema drift into user-visible errors.
export async function fetchAndShapePBP(
  // Sub-phase 3B: takes a `BackendFetch` from lib/backends.ts so the
  // call site doesn't have to know whether Python is reached via
  // HTTPS to the droplet (with X-Worker-Secret stamping) or via
  // a Cloudflare Container DO binding. The toggle lives in the env
  // (`PYTHON_BACKEND`); see SEASON-MODES.md for the deploy story.
  python: BackendFetch,
  gameId: string | number,
): Promise<ProcessedGameData> {
  const response = await python("/cfb/process", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ gameId }),
  });
  return _reshapeProcessResponse(response, gameId, "/cfb/process");
}

// Architecture B path. Calls Python via fetch+cf so the JSON response
// participates in CF's standard cache + Smart Tiered Cache. Used when
// PYTHON_FETCH_MODE === "tiered". Selected by the route handler in
// index.tsx; production callers don't pick this directly.
//
// Mechanics:
//   - GET so the URL (containing gameId) is the cache key. POST bodies
//     can't differentiate cache entries on the Free plan.
//   - cf.cacheEverything: true forces caching even though the response
//     is JSON without an explicit Cache-Control directive Cloudflare
//     would otherwise honor.
//   - cf.cacheTtlByStatus splits TTL across status codes so the
//     in-progress 200s get the short TTL; 404s (ESPN-malformed)
//     barely cache; 5xxs never cache.
//   - X-Worker-Secret authorizes the public Python URL — the droplet's
//     Caddy config gates on this header. Worker secret manager holds
//     the value; non-secret env doesn't.
//
// Optional `metadata` output captures the inner fetch's
// cf-cache-status so the route handler can stamp x-upstream-cache on
// its outgoing response — gives observability into whether the inner
// cache is engaging without parsing server-timing strings.
export interface TieredFetchEnv {
  PYTHON_BASE_URL: string;
  WORKER_SHARED_SECRET?: string;
}

export interface TieredFetchMetadata {
  upstreamCacheStatus?: string | null;
  upstreamServerTiming?: string | null;
}

export async function fetchAndShapePBPTiered(
  env: TieredFetchEnv,
  gameId: string | number,
  metadata?: TieredFetchMetadata,
): Promise<ProcessedGameData> {
  const url = `${env.PYTHON_BASE_URL}/cfb/process?gameId=${encodeURIComponent(String(gameId))}`;
  const headers: Record<string, string> = {};
  if (env.WORKER_SHARED_SECRET) {
    headers["X-Worker-Secret"] = env.WORKER_SHARED_SECRET;
  }
  const response = await fetch(url, {
    method: "GET",
    headers,
    cf: {
      cacheEverything: true,
      // Numbers picked to match CACHE_CONTROL.inProgress.max-age in
      // index.tsx. The Worker's caches.default for the rendered HTML
      // carries the long-term cache for completed games (1y); the
      // JSON layer underneath stays short-TTL because we can't tell
      // a completed game from an in-progress one before fetching
      // (and using the response status would defeat the cache).
      cacheTtlByStatus: {
        "200-299": 30,
        "404": 1,
        "500-599": 0,
      },
    } as RequestInitCfProperties,
  });

  if (metadata) {
    metadata.upstreamCacheStatus = response.headers.get("cf-cache-status");
    metadata.upstreamServerTiming = response.headers.get("server-timing");
  }

  return _reshapeProcessResponse(response, gameId, "/cfb/process");
}

// Load-test variant of fetchAndShapePBP. Used only by the harness-gated
// query-param branches in /cfb/game/:gameId (?arch=, ?replay=) for
// scripts/loadtest/. Production traffic does not reach this code path.
//
// Two orthogonal axes:
//
//   - Transport: "service" (Architecture A: BackendFetch via Container
//     DO binding, the production path) vs "fetch_cf" (Architecture B:
//     public-URL fetch with cf:{cacheEverything,cacheTtlByStatus,...}
//     so CF's standard cache + tiered cache pool the JSON across PoPs).
//
//   - Workload: "live" (real /cfb/process — heavy pipeline) vs "replay"
//     (synthetic /cfb/process/replay — fixture truncated by wallclock,
//     produces a body that grows over time so the harness exercises
//     SWR refresh behavior).
//
// All four combinations are valid. The Worker handler picks based on
// the request's query string so a single deploy serves every cell of
// the comparison matrix.
export interface LoadTestPBPOptions {
  // Service-binding transport (Arch A). Mutually exclusive with `cached`.
  // When set, mirrors the production call shape exactly.
  python?: BackendFetch;
  // Public-URL transport with edge cache (Arch B). Mutually exclusive
  // with `python`.
  cached?: {
    baseUrl: string;
    secret?: string;
    // Mirrors the route handler's CACHE_CONTROL split. cf.cacheTtlByStatus
    // requires us to express both the in-progress and completed TTLs;
    // since synthetic-replay sets STATUS_IN_PROGRESS until elapsed >=
    // duration, the in-progress TTL is the one the harness exercises
    // most. Errors get TTL=0 (don't cache).
    cacheTtlInProgress: number;
    cacheTtlCompleted: number;
  };
  // Synthetic replay (when set, points the call at /cfb/process/replay
  // instead of /cfb/process and passes startedAt/duration through).
  replay?: { startedAt: number; duration: number };
  // Output channel for upstream-fetch metadata. The handler that
  // wraps this function uses these fields to stamp custom headers on
  // its response so the harness can distinguish "B served from edge
  // cache" from "B fetched fresh from origin" — without it, the
  // Worker response gives no signal about the inner fetch's
  // cf-cache-status (the inner fetch's response headers don't
  // automatically propagate). Populated even on success so the
  // analysis can compute origin amplification correctly.
  metadata?: {
    upstreamCacheStatus?: string | null;
    upstreamServerTiming?: string | null;
  };
}

export async function fetchAndShapePBPLoadTest(
  gameId: string | number,
  opts: LoadTestPBPOptions,
): Promise<ProcessedGameData> {
  if ((opts.python == null) === (opts.cached == null)) {
    throw new Error("LoadTest: exactly one of {python, cached} required");
  }

  const path = opts.replay
    ? `/cfb/process/replay?gameId=${encodeURIComponent(String(gameId))}` +
      `&replay_started_at=${opts.replay.startedAt}` +
      `&replay_duration=${opts.replay.duration}`
    : "/cfb/process";

  let response: Response;
  if (opts.python) {
    // Architecture A. Replay mode uses GET on the path with query string;
    // live mode uses the existing POST + JSON-body shape.
    if (opts.replay) {
      response = await opts.python(path, { method: "GET" });
    } else {
      response = await opts.python(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameId }),
      });
    }
  } else if (opts.cached) {
    // Architecture B. fetch() with a `cf` object so the response goes
    // through CF's standard cache layer + tiered cache. GET only —
    // POST bodies don't differentiate cache keys without Enterprise
    // cf.cacheKey. The replay endpoint already supports GET; the
    // live endpoint is POST-only in production but the harness can
    // be configured to fall back to A-mode for ?arch=tiered+live (a
    // configuration we leave unbuilt for now since the harness's
    // primary case is replay).
    if (!opts.replay) {
      throw new Error(
        "LoadTest: Architecture B requires replay mode (live /cfb/process is POST-only)",
      );
    }
    const url = `${opts.cached.baseUrl}${path}`;
    const headers: Record<string, string> = {};
    if (opts.cached.secret) headers["X-Worker-Secret"] = opts.cached.secret;
    response = await fetch(url, {
      method: "GET",
      headers,
      cf: {
        cacheEverything: true,
        // Split TTL across status codes so the synthetic-replay's
        // in-progress responses (200 OK) get the short TTL, and 4xx/5xx
        // never poison the tiered cache. Numbers chosen to match the
        // Worker's CACHE_CONTROL constants in index.tsx.
        cacheTtlByStatus: {
          "200-299": opts.cached.cacheTtlInProgress,
          "404": 1,
          "500-599": 0,
        },
      } as IncomingRequestCfPropertiesCacheRules,
    });
  } else {
    throw new Error("LoadTest: no transport configured");
  }

  // Capture upstream-side cache status for the harness analysis.
  // For Architecture A (service binding) this is always null — the
  // service binding doesn't go through the CF edge cache. For
  // Architecture B (fetch+cf) this is "HIT", "MISS", "EXPIRED",
  // "REVALIDATED", etc. — the standard CF cache header on the inner
  // fetch's response. The handler propagates it as `x-upstream-cache`
  // on its outgoing response so the JSONL log captures it.
  if (opts.metadata) {
    opts.metadata.upstreamCacheStatus = response.headers.get("cf-cache-status");
    opts.metadata.upstreamServerTiming = response.headers.get("server-timing");
  }

  if (!response.ok) {
    throw new Error(
      `Python ${path} returned ${response.status} (${opts.cached ? "fetch_cf" : "service"})`,
    );
  }

  const data = (await response.json()) as ProcessResponse;
  if (!validateProcessResponse(data)) {
    logSchemaFailure(gameId, validateProcessResponse.errors ?? []);
  }
  const pbp: ProcessedGameData = { ...(data as ProcessedGameData) };
  pbp.plays = data.plays ?? [];
  pbp.advBoxScore = data.box_score;
  pbp.boxScore = data.boxScore;
  pbp.gameInfo = pbp.header?.competitions?.[0] as ProcessedGameData["gameInfo"];
  pbp.scoringPlays = pbp.plays.filter((p) => p.scoringPlay === true);
  delete pbp.records;
  delete (pbp as { box_score?: unknown }).box_score;

  if (pbp.plays.length > 0 && pbp.gameInfo?.status?.type?.completed === true) {
    const homeId = pbp.homeTeamId;
    const awayId = pbp.awayTeamId;
    const last = pbp.plays[pbp.plays.length - 1];
    if (last.winProbability == null) last.winProbability = {};
    if (
      String(last.pos_team) === String(homeId) &&
      (last.homeScore ?? 0) > (last.awayScore ?? 0)
    ) {
      last.winProbability.after = 1.0;
    } else if (
      String(last.pos_team) === String(awayId) &&
      (last.homeScore ?? 0) < (last.awayScore ?? 0)
    ) {
      last.winProbability.after = 1.0;
    } else {
      last.winProbability.after = 0.0;
    }
    if (homeId != null) {
      (pbp.gameInfo as { gei?: number }).gei = calculateGEI(pbp.plays, homeId);
    }
  }
  return pbp;
}

// Type aliasing the cf-property shape so the cast above is non-throwaway.
// Cloudflare's IncomingRequestCfProperties is an input shape (request.cf);
// for outbound fetch the cache properties are accepted on init.cf with the
// same field names but a slightly different intersection. RequestInitCfProperties
// is what Workers types ship for outbound fetch.
type IncomingRequestCfPropertiesCacheRules = NonNullable<
  RequestInitCfProperties
>;

// ESPN core PBP probe. Used to determine the game's pregame/in-progress
// state and pull team metadata for the pregame template. Mirrors
// the cdn.espn.com call at routes.js:468-477.
interface EspnPbpEnvelope {
  gamepackageJSON?: {
    header?: {
      season?: { year?: number };
      week?: number;
      competitions?: Array<{
        status?: { type?: { name?: string; completed?: boolean; detail?: string } };
        competitors?: Array<{
          team?: {
            id?: string | number;
            abbreviation?: string;
            nickname?: string;
            color?: string;
            alternateColor?: string;
          };
          score?: number | string;
        }>;
        broadcasts?: Array<{ media?: { shortName?: string } }>;
        [key: string]: unknown;
      }>;
      [key: string]: unknown;
    };
  };
}

export async function probeEspnPbp(gameId: string | number): Promise<EspnPbpEnvelope> {
  const url = `http://cdn.espn.com/core/college-football/playbyplay?gameId=${gameId}&xhr=1&render=false&userab=18`;
  const res = await espnFetch(url);
  if (!res.ok) {
    throw new Error(`ESPN PBP probe returned ${res.status}`);
  }
  return (await res.json()) as EspnPbpEnvelope;
}

export type { EspnPbpEnvelope };
