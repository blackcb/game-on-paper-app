import type { BackendFetch } from "./backends";
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
  if (!response.ok) {
    throw new Error(`Python /cfb/process returned ${response.status}`);
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
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`ESPN PBP probe returned ${res.status}`);
  }
  return (await res.json()) as EspnPbpEnvelope;
}

export type { EspnPbpEnvelope };
