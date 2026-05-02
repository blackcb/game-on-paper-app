// Replaces frontend/cfb/schedule.js. The Express side reads
// schedule.json and groups.json from disk on boot — Workers can't
// read disk, so we import the JSON directly. wrangler bundles it
// into the worker (~75KB schedule + ~2KB groups; trivial).

import scheduleJson from "../data/schedule.json";
import groupsJson from "../data/groups.json";
import type { ScheduleEvent } from "./team_helpers";

export interface WeekEntry {
  title: string;
  label: string;
  value: string | number;
  type: string | number;
}

export interface RawWeekEntry {
  label: string;
  detail?: string;
  value: string | number;
  type: string | number;
  [key: string]: unknown;
}

export interface GroupEntry {
  id: number;
  name: string;
}

const SCHEDULE = scheduleJson as Record<string, RawWeekEntry[]>;
const GROUPS = groupsJson as GroupEntry[];

// Mirrors schedule.js:36-49. Per-year list of weeks with their
// `(label) (detail)` long form for the dropdown.
export function getWeeksMap(): Record<string, WeekEntry[]> {
  const result: Record<string, WeekEntry[]> = {};
  for (const [year, weeks] of Object.entries(SCHEDULE)) {
    result[year] = weeks.map((wk) => ({
      title: wk.label,
      label: `${wk.label} (${wk.detail ?? ""})`,
      value: wk.value,
      type: wk.type,
    }));
  }
  return result;
}

export function getGroups(): GroupEntry[] {
  return GROUPS;
}

// Mirrors schedule.js:75-110 (current scoreboard branch). When year
// or week is null, fall through to ESPN's site-API scoreboard
// endpoint, which is what /cfb/ uses. Caching (Cache API) is
// reserved for sub-phase 2D — for now this hits ESPN every request.
async function fetchCurrentScoreboard(group: number | string): Promise<ScheduleEvent[]> {
  const espnGroup = parseInt(String(group), 10) < 0 ? 80 : group;
  const url = `https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?groups=${espnGroup}&size=100000`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`ESPN scoreboard returned ${res.status}`);
  }
  const data = (await res.json()) as { events?: ScheduleEvent[] };
  return data.events ?? [];
}

// Mirrors schedule.js:111-168 (year/week branch). Calls the cdn.espn
// schedule endpoint and flattens its date-keyed `content.schedule`
// shape into a plain array.
async function fetchHistoricalSchedule(
  year: string | number,
  week: string | number,
  type: string | number,
  group: number | string,
): Promise<ScheduleEvent[]> {
  const espnGroup = parseInt(String(group), 10) < 0 ? 80 : group;
  const params = new URLSearchParams({
    year: String(year),
    week: String(week),
    group: String(espnGroup),
    type: String(type ?? 2),
    seasontype: String(type ?? 2),
    xhr: "1",
    render: "false",
    userab: "18",
  });
  const url = `https://cdn.espn.com/core/college-football/schedule?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`ESPN schedule returned ${res.status}`);
  }
  const text = await res.text();
  // The Express side detects HTML payloads — same defense here.
  if (text.toLocaleLowerCase().includes("<html>")) {
    throw new Error("Data returned from ESPN was HTML, not valid JSON.");
  }
  const data = JSON.parse(text) as {
    content?: { schedule?: Record<string, { games?: ScheduleEvent[] }> };
  };
  const schedule = data.content?.schedule ?? {};
  const result: ScheduleEvent[] = [];
  for (const [, day] of Object.entries(schedule)) {
    if (day?.games) result.push(...day.games);
  }
  return result;
}

export interface GamesParams {
  year?: string | number | null;
  week?: string | number | null;
  type?: string | number | null;
  group?: string | number | null;
}

// Top-25 filter — Express schedule.js:101-107 / 158-164. group=-1
// filters the full FBS list down to games featuring at least one
// team currently ranked.
function filterTop25(games: ScheduleEvent[]): ScheduleEvent[] {
  return games.filter((g) => {
    const home = g.competitions?.[0]?.competitors?.[0];
    const away = g.competitions?.[0]?.competitors?.[1];
    return (
      (home?.curatedRank?.current ?? 99) < 26 ||
      (away?.curatedRank?.current ?? 99) < 26
    );
  });
}

export async function getGames(params: GamesParams = {}): Promise<ScheduleEvent[]> {
  const group = params.group ?? 80;
  const games =
    params.year == null || params.week == null
      ? await fetchCurrentScoreboard(group)
      : await fetchHistoricalSchedule(params.year, params.week, params.type ?? 2, group);
  if (parseInt(String(group), 10) === -1) return filterTop25(games);
  return games;
}

// Filter+sort logic from routes.js:48-93. Drops games with negative
// competitor IDs (ESPN sentinels for TBD opponents) and orders by
// status (in-progress > end-of-period > halftime > others) with a
// date and status-id tiebreaker. Used by every scoreboard-shaped
// route.
export function prepareGameList(games: ScheduleEvent[]): ScheduleEvent[] {
  const filtered = games.filter((g) => {
    const comp = g.competitions?.[0];
    const home = comp?.competitors?.[0];
    const away = comp?.competitors?.[1];
    return parseFloat(String(home?.id ?? -1)) >= 0 && parseFloat(String(away?.id ?? -1)) >= 0;
  });

  const statusBucket = (g: ScheduleEvent): number => {
    const name = g.status?.type?.name ?? "";
    if (name.includes("IN_PROGRESS")) return 0;
    if (name.includes("END_OF") || name.includes("END_PERIOD")) return 1;
    if (name.includes("STATUS_HALFTIME")) return 2;
    return 3;
  };

  return filtered.sort((a, b) => {
    const aBucket = statusBucket(a);
    const bBucket = statusBucket(b);
    if (aBucket !== bBucket) return aBucket - bBucket;
    const aDate = Date.parse(a.date ?? "");
    const bDate = Date.parse(b.date ?? "");
    if (aDate !== bDate) return aDate - bDate;
    const aId = parseInt(String(a.status?.type?.id ?? 0), 10);
    const bId = parseInt(String(b.status?.type?.id ?? 0), 10);
    return aId - bId;
  });
}

// Scoreboard auto-refresh trigger — index.ejs:124-127. Excludes
// completed/scheduled/cancelled/postponed/delayed states.
export function hasActiveGames(games: ScheduleEvent[]): boolean {
  return games.some((g) => {
    const t = g.status?.type;
    if (!t) return false;
    if (t.completed === true) return false;
    const name = t.name ?? "";
    return !(
      name.includes("SCHEDULED") ||
      name.includes("CANCEL") ||
      name.includes("POSTPONE") ||
      name.includes("DELAY")
    );
  });
}
