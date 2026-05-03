// Helpers for the game page's advanced box score, slim box score,
// scoring/play tables, and drive chart. Ports the inline EJS code from
// frontend/views/pages/cfb/{game.ejs,slim_box_score.ejs}. Behavior is
// kept bit-for-bit so rendered numbers and color classes match the
// Express side at cutover (sub-phase 2H).

import { roundNumber, retrieveValue } from "./leaderboard";

export { roundNumber, retrieveValue };

// Plays whose `type.text` value classifies the play as a turnover for
// shading purposes. Lifted verbatim from game.ejs:177-200.
export const TURNOVER_VEC = new Set<string>([
  "Blocked Field Goal",
  "Blocked Field Goal Touchdown",
  "Blocked Punt",
  "Blocked Punt Touchdown",
  "Field Goal Missed",
  "Missed Field Goal Return",
  "Missed Field Goal Return Touchdown",
  "Fumble Recovery (Opponent)",
  "Fumble Recovery (Opponent) Touchdown",
  "Fumble Return Touchdown",
  "Defensive 2pt Conversion",
  "Interception",
  "Interception Return",
  "Interception Return Touchdown",
  "Pass Interception Return",
  "Pass Interception Return Touchdown",
  "Kickoff Team Fumble Recovery",
  "Kickoff Team Fumble Recovery Touchdown",
  "Punt Touchdown",
  "Punt Return Touchdown",
  "Sack Touchdown",
  "Uncategorized Touchdown",
]);

// Stat-key → display label. Values may contain HTML entities and
// anchor tags; render with dangerouslySetInnerHTML when emitting.
// Kept identical to game.ejs:60-176 except duplicate keys deduped.
export const STAT_KEY_TITLE_MAPPING: Record<string, string> = {
  EPA_plays: "Total Plays",
  scrimmage_plays: "Scrimmage Plays",
  EPA_overall_total: "Total EPA",
  EPA_overall_off: "&emsp;&emsp;EPA",
  EPA_overall_offense: "&emsp;&emsp;Offensive EPA",
  EPA_passing_overall: "&emsp;&emsp;EPA",
  EPA_rushing_overall: "&emsp;&emsp;EPA",
  EPA_per_play: "&emsp;&emsp;EPA/Play",
  EPA_passing_per_play: "&emsp;&emsp;EPA/Play",
  EPA_rushing_per_play: "&emsp;&emsp;EPA/Play",
  rushes: "Rushes",
  rushing_power: "&emsp;&emsp;Power Run Attempts (Down &#8805; 3, Distance &#8804; 2)",
  rushing_power_success: "&emsp;&emsp;Successful Power Runs (Rate)",
  rushing_stuff: "&emsp;&emsp;Stuffed Runs (Yds Gained &#8804; 0)",
  rushing_stopped: "&emsp;&emsp;Stopped Runs (Yds Gained &#8804; 2)",
  rushing_opportunity: "&emsp;&emsp;Opportunity Runs (Yds Gained &#8805; 4)",
  rushing_highlight: "&emsp;&emsp;Highlight Runs (Yds Gained &#8805; 8)",
  havoc_total: "Havoc Plays Created",
  havoc_total_pass: "&emsp;&emsp;Passing",
  havoc_total_rush: "&emsp;&emsp;Rushing",
  EPA_penalty: "&emsp;&emsp;Penalty EPA",
  special_teams_plays: "Total Plays",
  EPA_sp: "Total EPA",
  EPA_special_teams: "&emsp;&emsp;Special Teams EPA",
  EPA_fg: "&emsp;&emsp;Field Goal EPA",
  EPA_punt: "&emsp;&emsp;Punting EPA",
  EPA_kickoff: "&emsp;&emsp;Kickoff Return EPA",
  TFL: "TFLs Generated",
  TFL_pass: "&emsp;&emsp;Passing",
  TFL_rush: "&emsp;&emsp;Rushing",
  EPA_success: "Successful Plays (EPA > 0)",
  EPA_success_pass: "&emsp;&emsp;When Passing",
  EPA_success_rush: "&emsp;&emsp;When Rushing",
  EPA_success_standard_down: "&emsp;&emsp;On Standard Downs",
  EPA_success_passing_down: "&emsp;&emsp;On Passing Downs",
  EPA_success_early_down: "&emsp;&emsp;On Early Downs",
  EPA_success_early_down_pass: "&emsp;&emsp;Successful Passes (Rate)",
  EPA_success_early_down_rush: "&emsp;&emsp;Successful Rushes (Rate)",
  early_downs: "Early Downs",
  early_down_pass: "&emsp;&emsp;Passes",
  early_down_rush: "&emsp;&emsp;Rushes",
  EPA_success_late_down: "&emsp;&emsp;On Late Downs",
  EPA_success_late_down_pass: "&emsp;&emsp;Successful Passes (Rate)",
  EPA_success_late_down_rush: "&emsp;&emsp;Successful Rushes (Rate)",
  late_downs: "Late Downs",
  late_down_pass: "&emsp;&emsp;Passes",
  late_down_rush: "&emsp;&emsp;Rushes",
  EPA_explosive: "Explosive Plays",
  EPA_explosive_passing: "&emsp;&emsp;When Passing (EPA > 2.4)",
  EPA_explosive_rushing: "&emsp;&emsp;When Rushing (EPA > 1.8)",
  scoring_opps_opportunities: "Scoring Opps",
  scoring_opps_points: "&emsp;&emsp;Total Points",
  scoring_opps_pts_per_opp: "&emsp;&emsp;Points per Opp",
  field_pos_avg_start: "Avg Starting FP",
  field_pos_avg_starting_predicted_pts: "&emsp;&emsp;Predicted Points",
  sacks: "Sacks Generated",
  turnovers: "Turnovers",
  expected_turnovers: "Expected Turnovers",
  turnover_margin: "Turnover Margin",
  expected_turnover_margin: "Expected Turnover Margin",
  turnover_luck: "Turnover Luck (pts)",
  PD: "Passes Defensed",
  INT: "&emsp;&emsp;Interceptions",
  Int: "&emsp;&emsp;Interceptions",
  def_int: "Interceptions",
  fumbles: "Fumbles Forced",
  total_fumbles: "&emsp;&emsp;Fumbles",
  fumbles_lost: "&emsp;&emsp;Fumbles Lost",
  fumbles_recovered: "&emsp;&emsp;Fumbles Recovered",
  middle_8: '"Middle 8" Plays',
  middle_8_pass: "&emsp;&emsp;Passes",
  middle_8_rush: "&emsp;&emsp;Rushes",
  EPA_middle_8: "&emsp;&emsp;EPA",
  EPA_middle_8_success: '&emsp;&emsp;During "Middle 8"',
  EPA_middle_8_success_pass: "&emsp;&emsp;Successful Passes (Rate)",
  EPA_middle_8_success_rush: "&emsp;&emsp;Successful Rushes (Rate)",
  EPA_middle_8_per_play: "&emsp;&emsp;EPA/play",
  EPA_early_down: "&emsp;&emsp;EPA",
  EPA_early_down_per_play: "&emsp;&emsp;EPA/Play",
  EPA_late_down: "&emsp;&emsp;EPA",
  EPA_late_down_per_play: "&emsp;&emsp;EPA/Play",
  late_down_avg_distance: "&emsp;&emsp;Avg Distance",
  first_downs_created: "First Downs Created",
  early_down_first_down: "&emsp;&emsp;First Downs Created",
  passes: "Passes",
  drives: "Total",
  drive_total_gained_yards_rate: "Available Yards %",
  yards_per_drive: "Yards/Drive",
  plays_per_drive: "Plays/Drive",
  avg_field_position: "Avg Starting Field Position",
  rushing_highlight_yards:
    '<a href="https://www.footballstudyhall.com/2018/2/2/16963820/college-football-advanced-stats-glossary">Highlight Yards</a>',
  rushing_highlight_yards_per_opp: "&emsp;&emsp;Per Rush Opportunity",
  line_yards:
    '<a href="https://www.footballstudyhall.com/2018/2/2/16963820/college-football-advanced-stats-glossary">OL Line Yards</a>',
  line_yards_per_carry: "&emsp;&emsp;Per Carry",
  yards_per_rush: "&emsp;&emsp;Yards/Play",
  yards_per_pass: "&emsp;&emsp;Yards/Play",
  yards_per_play: "&emsp;&emsp;Yards/Play",
  off_yards: "&emsp;&emsp;Yards",
  rush_yards: "&emsp;&emsp;Yards",
  pass_yards: "&emsp;&emsp;Yards",
  total_yards: "Total Yards",
  total_off_yards: "&emsp;&emsp;Offensive Yards",
  total_sp_yards: "&emsp;&emsp;Special Teams Yards",
  total_pen_yards: "&emsp;&emsp;Penalty Yards",
  EPA_misc: "&emsp;&emsp;Non-Scrimmage/Misc EPA",
  open_field_yards: "Open-Field Yards",
  second_level_yards: "Second-Level Yards",
  drive_stopped_rate:
    '<a href="https://theathletic.com/2419632/2021/03/02/college-football-defense-rankings-stop-rate/">Stop Rate</a>',
  EPA_non_explosive: "EPA w/o Explosive Plays",
  EPA_non_explosive_per_play: "&emsp;&emsp;EPA/Play",
  EPA_non_explosive_passing: "&emsp;&emsp;When Passing",
  EPA_non_explosive_passing_per_play: "&emsp;&emsp;&emsp;&emsp;EPA/Play",
  EPA_non_explosive_rushing: "&emsp;&emsp;When Rushing",
  EPA_non_explosive_rushing_per_play: "&emsp;&emsp;&emsp;&emsp;EPA/Play",
};

// Per-column rendering decisions for the advanced box score (game.ejs:745-747).
// Each list is a "this column is X-shaped" marker; first match wins
// inside handleRates.
export const NON_RATE_DECIMAL_COLUMNS = new Set<string>([
  "expected_turnovers",
  "expected_turnover_margin",
  "turnover_luck",
  "EPA_middle_8_per_play",
  "EPA_middle_8",
  "EPA_early_down_per_play",
  "EPA_early_down",
  "EPA_late_down_per_play",
  "EPA_late_down",
  "late_down_avg_distance",
  "EPA_sp",
  "EPA_special_teams",
  "EPA_kickoff",
  "EPA_punt",
  "EPA_fg",
  "EPA_overall_off",
  "EPA_per_play",
  "EPA_passing_overall",
  "EPA_passing_per_play",
  "EPA_rushing_overall",
  "EPA_rushing_per_play",
  "points_per_drive",
  "yards_per_drive",
  "plays_per_drive",
  "avg_field_position",
  "rushing_highlight_yards_per_opp",
  "line_yards_per_carry",
  "yards_per_rush",
  "yards_per_pass",
  "yards_per_play",
  "drive_stopped_rate",
  "EPA_non_explosive",
  "EPA_non_explosive_passing",
  "EPA_non_explosive_rushing",
  "EPA_non_explosive_per_play",
  "EPA_non_explosive_passing_per_play",
  "EPA_non_explosive_rushing_per_play",
  "EPA_overall_total",
  "EPA_overall_offense",
  "EPA_penalty",
]);

export const NON_RATE_COLUMNS = new Set<string>([
  "EPA_plays",
  "scrimmage_plays",
  "expected_turnover_margin",
  "turnover_margin",
  "turnovers",
  "expected_turnovers",
  "turnover_luck",
  "early_downs",
  "late_downs",
  "fumbles",
  "INT",
  "PD",
  "middle_8",
  "EPA_middle_8_per_play",
  "EPA_middle_8",
  "EPA_early_down_per_play",
  "EPA_early_down",
  "EPA_late_down_per_play",
  "EPA_late_down",
  "fumbles_lost",
  "fumbles_recovered",
  "Int",
  "TFL",
  "TFL_pass",
  "TFL_rush",
  "total_fumbles",
  "def_int",
  "points_per_drive",
  "drives",
  "yards_per_drive",
  "plays_per_drive",
  "drive_total_gained_yards_rate",
  "avg_field_position",
  "rushing_highlight_yards",
  "line_yards",
  "yards_per_rush",
  "yards_per_pass",
  "yards_per_play",
  "off_yards",
  "pass_yards",
  "rush_yards",
  "second_level_yards",
  "open_field_yards",
  "drive_stopped_rate",
  "EPA_non_explosive",
  "EPA_non_explosive_passing",
  "EPA_non_explosive_rushing",
  "EPA_non_explosive_per_play",
  "EPA_non_explosive_passing_per_play",
  "EPA_non_explosive_rushing_per_play",
]);

export const NON_RATE_PERCENT_COLUMNS = new Set<string>([
  "drive_total_gained_yards_rate",
  "drive_stopped_rate",
]);

// Slim box score's column-shape sets diverge slightly from the full
// box score's: it adds two situational rate keys that are stored as
// 0-1 floats in the data and need ×100 in the renderer.
export const SLIM_NON_RATE_PERCENT_COLUMNS = new Set<string>([
  "drive_total_gained_yards_rate",
  "drive_stopped_rate",
  "EPA_success_rate_third",
  "EPA_success_rate_rz",
]);

// Shapes the slim box score's column → percentile-key lookup
// (slim_box_score.ejs:40-52).
export const PERCENTILE_TITLE_KEY_MAPPING: Record<string, string> = {
  EPA_per_play: "epaPerPlay",
  EPA_passing_per_play: "epaPerDropback",
  EPA_rushing_per_play: "epaPerRush",
  havoc_total: "havocRate",
  EPA_success: "successRate",
  EPA_explosive: "explosivePlayRate",
  yards_per_pass: "yardsPerDropback",
  yards_per_play: "yardsPerPlay",
  rushing_stuff: "playStuffedRate",
  EPA_success_rate_third: "thirdDownSuccessRate",
  EPA_success_rate_rz: "redZoneSuccessRate",
};

// Display labels for the slim box score's eleven rows
// (slim_box_score.ejs:54-66).
export const SLIM_TITLE_MAPPING: Record<string, string> = {
  EPA_per_play: "EPA/Play",
  EPA_passing_per_play: "EPA/Dropback",
  EPA_rushing_per_play: "EPA/Rush",
  "defensive.havoc_total": "Havoc Rate",
  rushing_stuff: "Def Run Stuff Rate",
  "situational.EPA_success": "Success Rate",
  "situational.EPA_success_rate_third": "3rd Down Success Rate",
  "situational.EPA_success_rate_rz": "Red Zone Success Rate",
  EPA_explosive: "Explosive Play Rate",
  yards_per_pass: "Yards/Dropback",
  yards_per_play: "Yards/Play",
};

const ORDINAL_SUFFIXES = ["th", "st", "nd", "rd"];

export function getNumberWithOrdinal(n: number | string): string {
  const num = typeof n === "number" ? n : parseInt(String(n), 10);
  if (Number.isNaN(num)) return String(n);
  const v = num % 100;
  return num + (ORDINAL_SUFFIXES[(v - 20) % 10] || ORDINAL_SUFFIXES[v] || ORDINAL_SUFFIXES[0]);
}

// game.ejs:228-230 / slim_box_score.ejs:36-38. Differs from
// `roundNumber` in leaderboard.ts only in the value-coalescing default:
// this one treats `null`/`undefined` as 0 instead of returning "N/A".
// The Express side uses two implementations of roundNumber for this
// reason — preserve both behaviors so cells that should display "0.00"
// don't render as "N/A".
export function roundNumberZero(value: unknown, power10: number, fixed: number): string {
  const factor = Math.pow(10, power10);
  return (Math.round(parseFloat(String(value || 0)) * factor) / factor).toFixed(fixed);
}

// game.ejs:24-28. Different from leaderboard.ts's roundNumber → no
// "N/A" fallback; coerces null/undefined to 0.
export function calculateDETMER(boxScore: Record<string, unknown>): number {
  // yds/(400#games) (TD+INT)/(1+|TD-INT|). Mirrors game.ejs:204-207.
  const yds = parseFloat(String(boxScore.Yds ?? 0));
  const passTd = parseFloat(String(boxScore.Pass_TD ?? 0));
  const ints = parseFloat(String(boxScore.Int ?? 0));
  return (yds / 400) * ((passTd + ints) / (1 + Math.abs(passTd - ints)));
}

export interface PercentileBands {
  pctl: number | null;
  min: number | null;
  mid: number | null;
  max: number | null;
}

// slim_box_score.ejs:69-125. Looks up where `value` falls in the
// distribution of `key` across the supplied percentiles array (one
// entry per FBS team for the season). Returns null pctl/bands if the
// key isn't in the percentile-key mapping or no data is available.
export function boxScoreRetrievePercentile(
  value: unknown,
  key: string,
  percentiles: Array<Record<string, unknown>>,
): PercentileBands {
  if (percentiles.length === 0) return { pctl: null, min: null, mid: null, max: null };
  const adjKey = PERCENTILE_TITLE_KEY_MAPPING[key];
  if (!adjKey) return { pctl: null, min: null, mid: null, max: null };

  const basePctls = percentiles
    .map((item) => parseFloat(String(retrieveValue(item, adjKey) ?? "")))
    .filter((n) => !Number.isNaN(n))
    .sort((a, b) => a - b);

  if (basePctls.length === 0) return { pctl: null, min: null, mid: null, max: null };

  const filtered = basePctls.filter((item) => item <= parseFloat(String(value ?? 0)));
  return {
    pctl: filtered.length,
    min: basePctls[0],
    mid: basePctls[Math.floor(basePctls.length / 2)],
    max: basePctls[basePctls.length - 1],
  };
}

// slim_box_score.ejs:13-34. Maps a percentile (0-100) into a
// `hulk-bg-level-N` Bootstrap utility class — the green/red color
// gradient. Middle band (steps 4-5) returns null so cells stay
// uncolored. The original takes max/midColor params we ignore (max is
// always 100 at the call sites).
export function boxScoreColorRampClass(input: number | null): string {
  if (input == null) return "";
  const value = input / 100;
  const step = Math.round(value / 0.1);
  const clampedStep = Math.min(Math.max(step, 0), 9);
  if (clampedStep === 4 || clampedStep === 5) return "";
  return ` hulk-bg-level-${clampedStep}`;
}

// game.ejs:509-570. GEI percentile lookup for the score-header chip.
// Differs from boxScoreRetrievePercentile in that it (a) reads the
// raw `gei` field rather than going through PERCENTILE_TITLE_KEY_MAPPING,
// and (b) returns the color ramp class directly alongside the bands.
export function geiPercentileBands(
  input: number,
  percentiles: Array<Record<string, unknown>>,
): PercentileBands & { ramp_class: string } {
  if (percentiles.length === 0) {
    return { pctl: null, ramp_class: "", min: null, mid: null, max: null };
  }
  const basePctls = percentiles
    .map((item) => parseFloat(String(item.gei ?? "")))
    .filter((n) => !Number.isNaN(n))
    .sort((a, b) => a - b);

  if (basePctls.length === 0) {
    return { pctl: null, ramp_class: "", min: null, mid: null, max: null };
  }

  const filtered = basePctls.filter((item) => item <= input);
  const value = filtered.length / 100;
  const step = Math.round(value / 0.1);
  const clampedStep = Math.min(Math.max(step, 0), 9);
  const rampClass = clampedStep === 4 || clampedStep === 5 ? "" : ` hulk-bg-level-${clampedStep}`;
  return {
    pctl: filtered.length,
    ramp_class: rampClass,
    min: basePctls[0],
    mid: basePctls[Math.floor(basePctls.length / 2)],
    max: basePctls[basePctls.length - 1],
  };
}

// Down/yardline/distance formatters lifted from game.ejs:29-58. Used
// by the play table.
export function formatDown(down: number | string | null | undefined, playType: string): string {
  if (playType.includes("Kickoff")) return "Kickoff";
  if (playType.includes("Extra Point") || playType.includes("Conversion")) return "PAT";
  const n = typeof down === "number" ? down : parseInt(String(down ?? -1), 10);
  if (n > -1) return getNumberWithOrdinal(n);
  return String(down);
}

export function formatYardline(
  yardsToEndzone: number,
  offenseAbbrev: string,
  defenseAbbrev: string,
  playType: string | null | undefined,
): string {
  if (yardsToEndzone === 50) return "50";
  if (yardsToEndzone < 50) return `${defenseAbbrev} ${yardsToEndzone}`;
  if (playType?.includes("Kickoff")) return `${defenseAbbrev} ${100 - yardsToEndzone}`;
  return `${offenseAbbrev} ${100 - yardsToEndzone}`;
}

export function formatDistance(
  down: number | string | null | undefined,
  type: string,
  distance: number,
  yardline: number,
): string {
  const dist = distance === 0 || yardline <= distance ? "Goal" : distance;
  const downForm = formatDown(down, type);
  if (downForm.includes("Kickoff") || downForm.includes("PAT")) return downForm;
  return `${downForm} & ${dist}`;
}

// Period label for play/drive rows. game.ejs:240-247 / 314-324.
export function formatPeriod(period: number, clock?: { displayValue?: string } | null): string {
  if (period > 5) return `${period - 4}OT`;
  if (period === 5) return "OT";
  if (clock?.displayValue) return `Q${period} ${clock.displayValue}`;
  return `Q${period}`;
}

// game.ejs:19-23. Sort-then-dedupe.
export function unique<T>(a: T[]): T[] {
  return [...a].sort().filter((item, pos, ary) => !pos || item !== ary[pos - 1]);
}

// One row's worth of result for a stat-key in the advanced box score.
// Each call resolves to N cells, where N = number of teams in the
// teamInfo array (always 2 for cfb).
export interface BoxScoreCell {
  display: string;
  title?: string;
  className?: string;
  rampClass?: string;
}

// Mirrors game.ejs:748-796 (handleRates). Returns the rendered cell
// data for one (column, teamInfo, useSuffix) tuple. The full box
// score does NOT show percentile chips; the slim variant does.
export function handleRates(
  item: string,
  teamInfo: Array<Record<string, unknown>>,
  useSuffix: boolean,
  decimalPoints: number,
  advBoxScore: { team?: Array<Record<string, unknown>> } | null,
): BoxScoreCell[] {
  const finalDecimal = decimalPoints || 1;

  if (item === "EPA_misc") {
    return teamInfo.map((teamData) => {
      const overall = parseFloat(String(teamData.EPA_overall_total ?? 0)) || 0;
      const off = parseFloat(String(teamData.EPA_overall_offense ?? 0)) || 0;
      const sp = parseFloat(String(teamData.EPA_special_teams ?? 0)) || 0;
      const pen = parseFloat(String(teamData.EPA_penalty ?? 0)) || 0;
      return { display: roundNumberZero(overall - off - sp - pen, 2, 2) };
    });
  }
  if (item === "avg_field_position") {
    return teamInfo.map((teamData) => {
      const val = parseFloat(String(teamData[item] ?? 0)) || 0;
      const prefix = val >= 50 ? "Own" : "Opp";
      const printed = val >= 50 ? 100 - val : val;
      return { display: `${prefix} ${roundNumberZero(printed, 2, 0)}` };
    });
  }
  if (NON_RATE_PERCENT_COLUMNS.has(item)) {
    return teamInfo.map((teamData) => {
      const val = parseFloat(String(teamData[item] ?? 0)) || 0;
      return { display: `${roundNumberZero(val, 2, 0)}%` };
    });
  }
  if (NON_RATE_DECIMAL_COLUMNS.has(item)) {
    return teamInfo.map((teamData) => {
      const val = parseFloat(String(teamData[item] ?? 0)) || 0;
      return { display: roundNumberZero(val, 2, finalDecimal) };
    });
  }
  if (NON_RATE_COLUMNS.has(item)) {
    return teamInfo.map((teamData) => ({
      display: String(teamData[item] ?? 0),
    }));
  }
  // Default: count + (rate%) chip.
  return teamInfo.map((teamData) => {
    const val = parseFloat(String(teamData[item] ?? 0)) || 0;
    let rate = 0;
    if (useSuffix) {
      rate = 100 * parseFloat(String(teamData[`${item}_rate`] ?? 0));
    } else {
      const denom = parseFloat(
        String(teamData.scrimmage_plays ?? advBoxScore?.team?.[0]?.scrimmage_plays ?? 0),
      );
      rate = denom === 0 ? 0 : (100 * val) / denom;
    }
    return { display: `${val} (${roundNumberZero(rate, 2, 0)}%)` };
  });
}

// Mirrors slim_box_score.ejs:127-190 (handleBoxScoreRates). One row
// for one column across all teams, with percentile-derived color
// ramp class + tooltip title. The first segment of "section.column"
// keys (e.g. "situational.EPA_success") chooses which advBoxScore
// section to read from; bare keys default to "team".
export function handleSlimBoxScoreRates(
  item: string,
  advBoxScore: Record<string, Array<Record<string, unknown>>>,
  percentiles: Array<Record<string, unknown>>,
  decimalPoints: number,
): BoxScoreCell[] {
  const finalDecimal = decimalPoints || 1;
  let subKeys = item.split(".");
  if (subKeys.length === 1) subKeys = ["team", subKeys[0]];
  const finalKey = subKeys[1];
  let teamInfo = [...(advBoxScore[subKeys[0]] ?? [])];
  if (finalKey.includes("rushing_stuff")) teamInfo.reverse();

  if (SLIM_NON_RATE_PERCENT_COLUMNS.has(finalKey)) {
    return teamInfo.map((teamData) => {
      const raw = retrieveValue(teamData, finalKey);
      let rate = parseFloat(String(raw ?? 0));
      const pct = boxScoreRetrievePercentile(raw, finalKey, percentiles);
      const cls = boxScoreColorRampClass(pct.pctl);
      let { min, mid, max } = pct;
      if (finalKey.includes("_third") || finalKey.includes("_rz")) {
        rate *= 100;
        if (min != null) min *= 100;
        if (mid != null) mid *= 100;
        if (max != null) max *= 100;
      }
      const title = `Worst: ${roundNumberZero(min, 2, 0)}%\nMedian: ${roundNumberZero(mid, 2, 0)}%\nBest: ${roundNumberZero(max, 2, 0)}%`;
      const ord = pct.pctl != null ? getNumberWithOrdinal(pct.pctl) : "";
      return {
        display: `${roundNumberZero(rate, 2, 0)}% ${ord} %ile`,
        title,
        rampClass: cls,
      };
    });
  }
  if (NON_RATE_DECIMAL_COLUMNS.has(finalKey)) {
    return teamInfo.map((teamData) => {
      const val = retrieveValue(teamData, finalKey);
      const pct = boxScoreRetrievePercentile(val, finalKey, percentiles);
      const cls = boxScoreColorRampClass(pct.pctl);
      const title = `Worst: ${roundNumberZero(pct.min, 2, finalDecimal)}\nMedian: ${roundNumberZero(pct.mid, 2, finalDecimal)}\nBest: ${roundNumberZero(pct.max, 2, finalDecimal)}`;
      const ord = pct.pctl != null ? getNumberWithOrdinal(pct.pctl) : "";
      return {
        display: `${roundNumberZero(val, 2, finalDecimal)} ${ord} %ile`,
        title,
        rampClass: cls,
      };
    });
  }
  if (NON_RATE_COLUMNS.has(finalKey)) {
    return teamInfo.map((teamData) => {
      const val = retrieveValue(teamData, finalKey);
      const pct = boxScoreRetrievePercentile(val, finalKey, percentiles);
      const cls = boxScoreColorRampClass(pct.pctl);
      const title = `Worst: ${pct.min ?? ""}\nMedian: ${pct.mid ?? ""}\nBest: ${pct.max ?? ""}`;
      const ord = pct.pctl != null ? getNumberWithOrdinal(pct.pctl) : "";
      return {
        display: `${val ?? 0} ${ord} %ile`,
        title,
        rampClass: cls,
      };
    });
  }
  return teamInfo.map((teamData) => {
    const rateRaw = retrieveValue(teamData, `${finalKey}_rate`);
    const rate = parseFloat(String(rateRaw ?? 0));
    const pct = boxScoreRetrievePercentile(rate, finalKey, percentiles);
    const cls = boxScoreColorRampClass(pct.pctl);
    const title = `Worst: ${roundNumberZero(100 * (pct.min ?? 0), 2, 0)}%\nMedian: ${roundNumberZero(100 * (pct.mid ?? 0), 2, 0)}%\nBest: ${roundNumberZero(100 * (pct.max ?? 0), 2, 0)}%`;
    const ord = pct.pctl != null ? getNumberWithOrdinal(pct.pctl) : "";
    return {
      display: `${roundNumberZero(100 * rate, 2, 0)}% ${ord} %ile`,
      title,
      rampClass: cls,
    };
  });
  // suppress unused warning if val ever becomes lint-flagged (we
  // dereference it indirectly via retrieveValue above).
}

// Sort-by-team helper used by both the full and slim box scores
// (game.ejs:798-813, slim_box_score.ejs:201-219). Mutates in place.
export function sortAdvBoxScoreInPlace(
  advBoxScore: Record<string, Array<Record<string, unknown>>>,
  awayTeamId: string | number,
  homeTeamId: string | number,
): void {
  for (const key of Object.keys(advBoxScore)) {
    const baseData = advBoxScore[key];
    if (!Array.isArray(baseData) || baseData.length === 0) continue;
    const teamKey = "def_pos_team" in baseData[0] ? "def_pos_team" : "pos_team";
    baseData.sort((a, b) => {
      if (a[teamKey] === awayTeamId && b[teamKey] === homeTeamId) return -1;
      if (b[teamKey] === awayTeamId && a[teamKey] === homeTeamId) return 1;
      return 0;
    });
  }
}

// game.ejs:201-203. Tooltip span seen on every QB stat line.
export const DETMER_TOOLTIP =
  "Stands for 'Downfield Eventful Throwing Metric Encouraging Ripping it'. Built to find the most sicko QB performances. Developed by the Moon Crew Discord & @SickosCommittee on Twitter.";

// game.ejs:8-17. Determines whether the score header should switch
// to the championship CSS theme.
export function isChampionshipEvent(gameNote: string): boolean {
  return (
    gameNote.includes("CFP") ||
    gameNote.includes("College Football Playoff") ||
    gameNote.includes("National Championship") ||
    gameNote.includes("FCS Championship") ||
    gameNote.includes("Celebration Bowl") ||
    gameNote.includes("Division II Championship") ||
    gameNote.includes("Division III Championship")
  );
}
