// Replaces frontend/cfb/schedule.js. The Express side reads
// schedule.json and groups.json from disk on boot — Workers can't
// read disk, so we import the JSON directly. wrangler bundles it
// into the worker (~75KB schedule + ~2KB groups; trivial).

import scheduleJson from "../data/schedule.json";
import { espnFetch } from "./espn_fetch";
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
// endpoint, which is what /cfb/ uses.
async function fetchCurrentScoreboard(group: number | string): Promise<ScheduleEvent[]> {
  const espnGroup = parseInt(String(group), 10) < 0 ? 80 : group;
  // 2026-08-16: switched from site.api.espn.com to the cdn.espn.com
  // core scoreboard. site.api 403s Workers-egress fetches even with a
  // browser UA (verified via espn_scoreboard_failure in Workers Logs),
  // while the cdn.espn.com family accepts them — the same conclusion
  // upstream reached (their getCurrentScoreboard hits this exact URL,
  // credit @pseudo-r's Public-ESPN-API notes). Payload nests the old
  // response under content.sbData.
  const url = `https://cdn.espn.com/core/college-football/scoreboard?groups=${espnGroup}&size=1000&xhr=1`;
  const res = await espnFetch(url);
  if (!res.ok) {
    throw new Error(`ESPN scoreboard returned ${res.status}`);
  }
  const data = (await res.json()) as {
    content?: { sbData?: { events?: ScheduleEvent[] } };
  };
  return data.content?.sbData?.events ?? [];
}

// Sub-phase 2F: cron-warmed scoreboard.
//
// The scheduled() handler calls writeCurrentScoreboard once a minute
// during football season (see isFootballSeason); the / route calls
// getCachedCurrentScoreboard, which reads from KV first and falls
// back to a live ESPN fetch on miss (off-season, KV cold-start, or
// after the cron has been failing for >SCOREBOARD_KV_TTL_SECONDS).
//
// Scope is narrow on purpose: only group=80 (full FBS) gets warmed.
// group=-1 (Top-25) and any other group bypass the cache; the
// Top-25 filter is applied post-fetch so it could in principle
// share the FBS payload, but the simpler design is to live-fetch
// non-default groups and revisit if traffic patterns warrant.
const SCOREBOARD_KV_KEY = "cfb-scoreboard-80";

// 3 minutes — covers ~2 missed cron runs before the cache goes
// cold and the route falls back to ESPN. Cron itself is every
// minute, so the steady-state TTL refresh keeps this warm.
const SCOREBOARD_KV_TTL_SECONDS = 180;

export async function writeCurrentScoreboard(kv: KVNamespace): Promise<number> {
  const games = await fetchCurrentScoreboard(80);
  await kv.put(SCOREBOARD_KV_KEY, JSON.stringify(games), {
    expirationTtl: SCOREBOARD_KV_TTL_SECONDS,
  });
  return games.length;
}

// KV-first reader for the / route. Only the default FBS scoreboard
// is cached; other groups fall through to a live fetch via
// getGames in the route handler.
export async function getCachedCurrentScoreboard(
  kv: KVNamespace,
): Promise<ScheduleEvent[]> {
  const cached = await kv.get(SCOREBOARD_KV_KEY);
  if (cached) {
    try {
      return JSON.parse(cached) as ScheduleEvent[];
    } catch {
      // bad JSON in KV — fall through to a live fetch.
    }
  }
  const games = await fetchCurrentScoreboard(80);
  // Best-effort write-through; don't block the request if KV is
  // unavailable.
  try {
    await kv.put(SCOREBOARD_KV_KEY, JSON.stringify(games), {
      expirationTtl: SCOREBOARD_KV_TTL_SECONDS,
    });
  } catch (err) {
    console.log(
      JSON.stringify({
        event: "kv_write_failure",
        key: SCOREBOARD_KV_KEY,
        error: (err as Error).message,
      }),
    );
  }
  return games;
}

// Football season window. Aug 20 → Jan 20 covers preseason
// scheduling pulls through the CFP final. Outside this window the
// cron skips the ESPN call entirely (ESPN's cfb scoreboard
// endpoint returns yesterday's data anyway, so warming it would
// just thrash KV).
export function isFootballSeason(now: Date = new Date()): boolean {
  const month = now.getUTCMonth(); // 0-indexed
  const day = now.getUTCDate();
  // Aug 20+ (month=7, day>=20) through Dec
  if (month > 7 || (month === 7 && day >= 20)) return true;
  // Jan 1 – Jan 20 (month=0, day<=20)
  if (month === 0 && day <= 20) return true;
  return false;
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
  const res = await espnFetch(url);
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
