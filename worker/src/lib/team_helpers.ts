// Shared formatting helpers for team-flavored views (team_card,
// team_player_cards, team_slice, game_thumb). The roundNumber +
// generateColorRampValue already live in leaderboard.ts; this module
// covers helpers specific to single-team rendering and the per-game
// schedule thumbnail.

import { roundNumber } from "./leaderboard";

const LOWERCASE_TEAMS = new Set([61]);

export function cleanLocation(team: { id?: unknown; location?: unknown }): string {
  const location = String(team.location ?? "");
  if (LOWERCASE_TEAMS.has(parseInt(String(team.id ?? ""), 10))) {
    return location.toLocaleLowerCase();
  }
  return location;
}

// Same lowercase rule, but applied to the team's `abbreviation` field
// (used in game_thumb headers).
export function cleanAbbreviation(team: { id?: unknown; abbreviation?: unknown }): string {
  const abbr = String(team.abbreviation ?? "");
  if (LOWERCASE_TEAMS.has(parseInt(String(team.id ?? ""), 10))) {
    return abbr.toLocaleLowerCase();
  }
  return abbr;
}

// English-ordinal suffix: 1 → 1st, 2 → 2nd, 11 → 11th, etc.
// Matches getNumberWithOrdinal at team_card.ejs:5-9.
export function getNumberWithOrdinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

interface RGB {
  r: number;
  g: number;
  b: number;
}

export function hexToRgb(hex: string | null | undefined): RGB | null {
  if (hex == null) return null;
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!result) return null;
  return {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16),
  };
}

// `maxTeams` historical FBS membership counts — used by team_card's
// `generateColorRampValue` so a Top-130 ranking colors uniformly
// regardless of the season's expansion. team_card.ejs:10-15.
export function maxTeamsForSeason(season: number | string): number {
  const s = typeof season === "string" ? parseInt(season, 10) : season;
  if (s === 2022) return 131;
  if (s < 2022) return 130;
  return 134;
}

// Always-prefix-positive variant for the team_card differential row.
// Distinct from leaderboard.generateMarginalString — that one only
// prefixes when type === "differential"; team_card always operates on
// differential data so the prefix is unconditional.
export function teamCardMarginal(
  input: unknown,
  power10: number,
  fixed: number,
): string {
  if (typeof input === "number" && input >= 0) {
    return `+${roundNumber(input, power10, fixed)}`;
  }
  if (typeof input === "string" && parseFloat(input) >= 0) {
    return `+${roundNumber(input, power10, fixed)}`;
  }
  return roundNumber(input, power10, fixed);
}

// Maps the stat key to its display label inside the team_slice table
// rows. Falls back to the key itself if not in the mapping.
export const STAT_KEY_TITLE_MAPPING: Record<string, string> = {
  totalPlays: "Plays",
  playsPerGame: "Plays/Game",
  totalEPA: "Total EPA",
  epaPerPlay: "EPA/Play",
  epaPerGame: "EPA/Game",
  successRate: "Success Rate",
  startingFP: "Starting FP",
};

export type SliceTarget = "offensive" | "defensive" | "differential";
export type SliceSituation = "overall" | "passing" | "rushing";

// Column lists by target+situation, exactly mirroring team_slice.ejs:100-117.
// Differential drops the *Plays counts; everything else is identical.
export const TEAM_SLICE_COLUMNS: Record<
  SliceTarget,
  Record<SliceSituation, string[]>
> = {
  offensive: {
    overall: ["totalPlays", "playsPerGame", "totalEPA", "epaPerPlay", "epaPerGame", "successRate", "startingFP"],
    passing: ["totalPlays", "playsPerGame", "totalEPA", "epaPerPlay", "epaPerGame", "successRate"],
    rushing: ["totalPlays", "playsPerGame", "totalEPA", "epaPerPlay", "epaPerGame", "successRate"],
  },
  defensive: {
    overall: ["totalPlays", "playsPerGame", "totalEPA", "epaPerPlay", "epaPerGame", "successRate", "startingFP"],
    passing: ["totalPlays", "playsPerGame", "totalEPA", "epaPerPlay", "epaPerGame", "successRate"],
    rushing: ["totalPlays", "playsPerGame", "totalEPA", "epaPerPlay", "epaPerGame", "successRate"],
  },
  differential: {
    overall: ["totalEPA", "epaPerPlay", "epaPerGame", "successRate", "startingFP"],
    passing: ["totalEPA", "epaPerPlay", "epaPerGame", "successRate"],
    rushing: ["totalEPA", "epaPerPlay", "epaPerGame", "successRate"],
  },
};

// Color-ramp class from a rank, scoped to the slice (max=130 in the
// EJS — preserved verbatim even though current FBS is 134, since
// that's what the Express stack does).
export function sliceColorRamp(rank: unknown): string | null {
  if (rank == null || rank === "") return null;
  const max = 130;
  const value = (max - parseFloat(String(rank))) / max;
  const step = Math.round(value / 0.1);
  const clamped = Math.min(Math.max(step, 0), 9);
  if (clamped === 4 || clamped === 5) return null;
  return `hulk-bg-level-${clamped}`;
}

export interface SliceCell {
  text: string;
  rankString: string;
  colorClass: string | null;
  sign: string;
}

// Per-cell payload for team_slice's `handleRates`. Walks the breakdown
// array (1 entry for team_season; up to 2 in matchup) and emits one
// SliceCell per breakdown row, formatted per the stat type. The
// caller renders these to <td> elements — Hono JSX-friendly.
export function buildSliceCells(
  item: string,
  breakdown: Array<Record<string, unknown>>,
  baseKey: SliceTarget,
  subKey: SliceSituation,
): Array<SliceCell | null> {
  const isMargin = baseKey === "differential";
  return breakdown.map((teamData) => {
    if (!(baseKey in teamData)) {
      return null; // caller renders an N/A cell.
    }
    const slice = (teamData[baseKey] as Record<string, Record<string, unknown>>)[subKey] ?? {};
    const rawValue = slice[item] ?? 0;
    const numeric = parseFloat(String(rawValue));
    const rank = slice[`${item}Rank`];

    let colorClass: string | null = null;
    let sign = "";
    if (isMargin) {
      if (numeric > 0) {
        colorClass = "hulk-bg-green";
        sign = "+";
      } else if (numeric < 0) {
        colorClass = "hulk-bg-purple";
      }
    } else {
      colorClass = sliceColorRamp(rank);
    }

    let rankString = "";
    if (rank == null || (!rank && rank !== 0)) {
      rankString = "";
    } else if (String(rank).includes(".5")) {
      rankString = ` T-#${roundNumber(Math.floor(parseFloat(String(rank))), 2, 0)}`;
    } else {
      rankString = ` #${roundNumber(Math.floor(parseFloat(String(rank))), 2, 0)}`;
    }

    let text: string;
    if (item.includes("startingFP")) {
      if (isMargin) {
        text = `${roundNumber(numeric, 2, 0)}`;
      } else {
        const prefix = numeric >= 50 ? "Own" : "Opp";
        const printed = numeric >= 50 ? 100 - numeric : numeric;
        text = `${prefix} ${roundNumber(printed, 2, 0)}`;
      }
    } else if (item.toLocaleLowerCase().includes("epa")) {
      text = roundNumber(numeric, 2, 2);
    } else if (item.includes("success")) {
      text = `${roundNumber(numeric * 100, 2, 1)}%`;
    } else {
      text = roundNumber(numeric, 2, 0);
    }

    return { text, rankString, colorClass, sign };
  });
}

// Conferences enumerated in game_thumb.ejs:9-41. Used to label the
// conference + draw the FBS-vs-FCS spice-level branch.
export const CONFERENCE_MAP: Record<number, string> = {
  80: "FBS (I-A)",
  1: "ACC",
  151: "AAC",
  4: "Big 12",
  5: "B1G",
  12: "C-USA",
  18: "Independent",
  15: "MAC",
  17: "MWC",
  9: "Pac-12",
  8: "SEC",
  37: "Sun Belt",
  81: "FCS (I-AA)",
  176: "ASUN",
  20: "Big Sky",
  40: "Big South",
  48: "CAA",
  22: "Ivy",
  24: "MEAC",
  21: "MVFC",
  25: "NEC",
  // 26 collides — game_thumb.ejs has both OVC and WAC at 26;
  // the second declaration wins so this key resolves to "WAC".
  26: "WAC",
  27: "Patriot",
  28: "Pioneer",
  31: "SWAC",
  29: "Southern",
  30: "Southland",
  35: "Div II/III",
};

export const FBS_CONFERENCES = new Set([
  "1", "4", "5", "8", "9", "12", "15", "17", "37", "151", "80", "18",
]);

// game_thumb.ejs:54-61. Spice classes drive the bordered card color
// ramp on the schedule grid.
export const SPICE = {
  WATER: "testing",
  BELL: "none",
  SERRANO: "close-late",
  CAYENNE: "ranked-upset",
  GHOST: "ranked-close-late",
  REAPER: "fcs-upset",
} as const;

export type SpiceLevel = (typeof SPICE)[keyof typeof SPICE];

// game_thumb.ejs:64-66. Score may be a string or {displayValue}.
function cleanScore(comp: { score?: unknown }): number {
  const s = comp.score;
  if (s != null && typeof s === "object" && "displayValue" in (s as object)) {
    return parseInt(String((s as { displayValue: unknown }).displayValue), 10);
  }
  return parseInt(String(s), 10);
}

interface ScheduleStatus {
  type?: { name?: string; completed?: boolean; detail?: string };
  period?: number | string;
  clock?: number | string;
}

interface ScheduleCompetitor {
  id?: string | number;
  score?: unknown;
  team?: {
    id?: string | number;
    abbreviation?: string;
    conferenceId?: string | number;
    location?: string;
  };
  rank?: number;
  curatedRank?: { current?: number };
  records?: Array<{ type?: string; summary?: string; displayValue?: string }>;
}

interface ScheduleSituation {
  lastPlay?: {
    text?: string;
    end?: { team?: { id?: string | number } };
    probability?: { homeWinPercentage?: number; awayWinPercentage?: number };
  };
  isRedZone?: boolean;
  downDistanceText?: string;
}

export interface ScheduleEvent {
  id?: string | number;
  date?: string;
  status?: ScheduleStatus;
  competitions?: Array<{
    id?: string | number;
    competitors?: ScheduleCompetitor[];
    situation?: ScheduleSituation;
    notes?: Array<{ headline?: string }>;
    geoBroadcasts?: Array<{ media?: { shortName?: string } }>;
    broadcasts?: Array<{ media?: { shortName?: string } }>;
  }>;
}

// Translate game_thumb.ejs:68-124 directly. Returns one of the SPICE
// values describing the matchup tier — the schedule grid card border
// uses the result as a CSS class.
export function calculateSpiceLevel(g: ScheduleEvent): SpiceLevel {
  const comp = g.competitions?.[0];
  const home = comp?.competitors?.[0] ?? {};
  const away = comp?.competitors?.[1] ?? {};
  const homeScore = cleanScore(home);
  const awayScore = cleanScore(away);
  const status = g.status ?? {};
  const period = parseInt(String(status.period ?? 0), 10);
  const clock = parseInt(String(status.clock ?? 0), 10);
  const name = status.type?.name ?? "";
  const detail = status.type?.detail ?? "";

  if (
    status.type?.completed === true ||
    period < 1 ||
    name.includes("STATUS_SCHEDULED") ||
    detail.includes("Cancel") ||
    detail.includes("Postpone")
  ) {
    return SPICE.BELL;
  }

  const margin = Math.abs(homeScore - awayScore);
  if (
    (period === 2 && margin > 38) ||
    (period === 3 && margin > 28) ||
    (period === 4 && margin > 22)
  ) {
    return SPICE.BELL;
  }

  const isLateInHalf =
    ((name.includes("STATUS_IN_PROGRESS") || name.includes("STATUS_HALFTIME")) && period > 4) ||
    (period === 2 && clock <= 300 && clock > 0) ||
    (period === 4 && clock <= 300 && clock > 0);
  const isMiddleHalf =
    name.includes("STATUS_IN_PROGRESS") && period >= 3 && clock <= 450 && clock > 0;
  const isEarlyGame =
    name.includes("STATUS_IN_PROGRESS") && period === 1 && clock >= 450;

  const oneScoreDriveTime = clock % 900 >= 60;
  const twoScoreDriveTime = clock % 900 >= 120;
  const oneScoreReachable = oneScoreDriveTime && margin >= 0 && margin <= 8;
  const twoScoreReachable = twoScoreDriveTime && margin >= 9 && margin <= 16;

  const homeConf = String(home.team?.conferenceId ?? "");
  const awayConf = String(away.team?.conferenceId ?? "");
  const fbsVsFcs =
    (!FBS_CONFERENCES.has(homeConf) && FBS_CONFERENCES.has(awayConf)) ||
    (!FBS_CONFERENCES.has(awayConf) && FBS_CONFERENCES.has(homeConf));
  const homeFcsLeading =
    !FBS_CONFERENCES.has(homeConf) && FBS_CONFERENCES.has(awayConf) && homeScore - awayScore >= 0;
  const awayFcsLeading =
    FBS_CONFERENCES.has(homeConf) && !FBS_CONFERENCES.has(awayConf) && homeScore - awayScore <= 0;

  const homeRank = home.rank ?? 99;
  const awayRank = away.rank ?? 99;

  if (
    isMiddleHalf &&
    (oneScoreReachable || twoScoreReachable) &&
    ((homeRank < 26 && awayRank > 25) || (awayRank < 26 && homeRank > 25))
  ) {
    return SPICE.CAYENNE;
  }
  if (!isEarlyGame && fbsVsFcs && (homeFcsLeading || awayFcsLeading)) {
    return SPICE.REAPER;
  }
  if (isLateInHalf && (oneScoreReachable || twoScoreReachable)) {
    return homeRank < 26 && awayRank < 26 ? SPICE.GHOST : SPICE.SERRANO;
  }
  if (isLateInHalf && margin >= 0 && margin < 8) {
    return SPICE.SERRANO;
  }
  return SPICE.BELL;
}
