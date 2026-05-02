// Formatting helpers ported from frontend/views/pages/cfb/leaderboard.ejs.
// EJS embeds these inline in the template; in Hono JSX they live as TS
// functions imported by the component. Behavior must match the EJS
// version exactly so the rendered numbers, ranks, and color classes
// stay identical at cutover (sub-phase 2H).

import type { TeamLeagueRow } from "./summary";

export type LeaderboardType = "differential" | "offensive" | "defensive";

// Team IDs whose canonical team name is uppercased upstream but should
// render lowercased — currently just Georgia (61). Original CLEAN_LIST
// from leaderboard.ejs:40.
const LOWERCASE_TEAMS = new Set([61]);

export function roundNumber(
  value: unknown,
  power10: number,
  fixed: number,
): string {
  // EJS's `!value && value != 0` falsy-but-not-zero check, then
  // `parseFloat(value || 0)` — the `|| 0` is a no-op safety net.
  if (!value && value !== 0) return "N/A";
  const factor = Math.pow(10, power10);
  return (Math.round(parseFloat(String(value || 0)) * factor) / factor).toFixed(fixed);
}

export function generateMarginalString(
  input: unknown,
  power10: number,
  fixed: number,
  type: LeaderboardType,
): string {
  if (input == null) return "N/A";
  // Only the differential view prefixes positives with "+". The
  // numeric value itself is unchanged.
  if (typeof input === "number" && input >= 0 && type === "differential") {
    return `+${roundNumber(input, power10, fixed)}`;
  }
  return roundNumber(input, power10, fixed);
}

// Maps a rank into a Bootstrap-utility class name used to colorize
// table cells (greener = better, redder = worse). The EJS version
// returns null for the middle band (steps 4 and 5) so those cells stay
// uncolored. Logic preserved bit-for-bit.
export function generateColorRampValue(
  input: unknown,
  max: number,
): string | null {
  if (!input) return null;
  const value = (max - parseFloat(String(input))) / max;
  const step = Math.round(value / 0.1);
  const clampedStep = Math.min(Math.max(step, 0), 9);
  if (clampedStep === 4 || clampedStep === 5) return null;
  return `hulk-bg-level-${clampedStep}`;
}

// Walks a dotted path (e.g. "overall.adjEpaPerPlay") into a nested
// object. Returns undefined for any missing segment. Replaces
// retrieveValue() in leaderboard.ejs:31 and the duplicate at
// routes.js:705.
export function retrieveValue(dictionary: Record<string, unknown>, key: string): unknown {
  const segments = key.split(".");
  let sub: unknown = dictionary;
  for (const k of segments) {
    if (sub == null || typeof sub !== "object") return undefined;
    sub = (sub as Record<string, unknown>)[k];
  }
  return sub;
}

export function cleanField(team: TeamLeagueRow, field: string): string {
  const value = team[field];
  const display = typeof value === "string" ? value : String(value);
  if (LOWERCASE_TEAMS.has(Number(team.teamId))) {
    return display.toLocaleLowerCase();
  }
  return display;
}

// Converts a numeric rank into a display string. ".5" suffixes denote
// ties (the summary service emits `4.5` to mean "tied at 4"); we
// render those as "T-4". Other ranks are floored and zero-decimaled.
export function cleanRank(rank: unknown): string {
  if (rank == null) return "N/A";
  if (!rank && rank !== 0) return "N/A";
  const tied = String(rank).includes(".5");
  const numeric = Math.floor(parseFloat(String(rank)));
  if (tied) return `T-${roundNumber(numeric, 2, 0)}`;
  return roundNumber(numeric, 2, 0);
}

export function leaderTitle(type: LeaderboardType | string): string {
  if (type === "differential") return "Net Statistics";
  if (type === "offensive") return "Offensive Statistics";
  if (type === "defensive") return "Defensive Statistics";
  return type;
}

// Server-side sort+filter logic from routes.js:788-843. Mirrors the
// Express side bit-for-bit:
//   - "differential" can't sort by passing/rushing/havoc — those keys
//     fall back to overall.adjEpaPerPlay.
//   - "defensive" inverts sort direction (lower is better), unless
//     the sort key is overall.havocRate (higher is better even on
//     defense). "offensive" with havocRate flips the same way.
//   - For sort keys other than adjEpaPerPlay, drop rows where the
//     value or rank is null/"NA". For adjEpaPerPlay, keep everything
//     — teams without FBS opponents render with "N/A" cells but stay
//     in the table.
export function prepareLeaderboardRows(
  baseData: TeamLeagueRow[],
  type: LeaderboardType | string,
  requestedSort: string,
): { rows: TeamLeagueRow[]; sortKey: string; ascending: boolean } {
  let sortKey = requestedSort;
  if (
    type === "differential" &&
    (!sortKey.includes("overall") || sortKey.includes("havocRate"))
  ) {
    sortKey = "overall.adjEpaPerPlay";
  }
  const ascending =
    (type === "defensive" && sortKey !== "overall.havocRate") ||
    (type === "offensive" && sortKey === "overall.havocRate");

  const projected = baseData.map((t) => {
    const slice = (t[type] as Record<string, unknown> | undefined) ?? {};
    return { teamId: t.teamId, team: t.team, ...slice } as TeamLeagueRow;
  });

  const filtered = projected.filter((p) => {
    const value = retrieveValue(p, sortKey);
    const rank = retrieveValue(p, `${sortKey}Rank`);
    if (sortKey.includes("adjEpaPerPlay")) return true;
    return value != null && value !== "NA" && rank != null && rank !== "NA";
  });

  filtered.sort((a, b) => {
    const aVal = retrieveValue(a, sortKey);
    const bVal = retrieveValue(b, sortKey);
    if (aVal == null && bVal != null) return 1;
    if (aVal != null && bVal == null) return -1;
    if (aVal == null && bVal == null) return 0;
    const compVal = parseFloat(String(aVal)) - parseFloat(String(bVal));
    return ascending ? compVal : -1 * compVal;
  });

  return { rows: filtered, sortKey, ascending };
}
