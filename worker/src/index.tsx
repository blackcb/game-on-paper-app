// Phase 2 worker entry. Routes are ported in the order documented in
// docs/migration-plan.md sub-phase 2B; this file wires them up.

import { Hono, type Context } from "hono";
import { getGlossary } from "./lib/glossary";
import {
  getPercentileKey,
  preparePlayerRows,
  prepareLeaderboardRows,
  type LeaderboardType,
  type PlayerLeaderboardType,
} from "./lib/leaderboard";
import {
  QUARANTINE_LIST,
  fetchAndShapePBP,
  probeEspnPbp,
  type EspnPbpEnvelope,
  type ProcessedGameData,
} from "./lib/games";
import {
  getCachedCurrentScoreboard,
  getGames,
  getGroups,
  getWeeksMap,
  hasActiveGames,
  isFootballSeason,
  prepareGameList,
  writeCurrentScoreboard,
} from "./lib/schedule";
import type { ScheduleEvent } from "./lib/team_helpers";
import { CURRENT_SEASON, MIN_SEASON } from "./lib/season";
import {
  retrieveLastUpdated,
  retrieveLeagueData,
  retrievePercentiles,
  retrieveTeamData,
} from "./lib/summary";
import { getTeamInformation, getTeamSeasonInformation } from "./lib/teams";
import { EpaChartPage, type EpaChartTeam } from "./templates/EpaChart";
import { GlossaryPage } from "./templates/Glossary";
import { LeaderboardPage } from "./templates/Leaderboard";
import { PlayerLeaderboardPage } from "./templates/PlayerLeaderboard";
import { GameErrorPage, type GameErrorGameInfo } from "./templates/GameError";
import {
  GamePage,
  type GameData as RenderableGameData,
} from "./templates/Game";
import {
  PregamePage,
  type PregameData,
} from "./templates/Pregame";
import { ScoreboardPage } from "./templates/Scoreboard";
import { TeamPage, type TeamData } from "./templates/Team";
import {
  TeamSeasonPage,
  type PlayersByType,
  type TeamData as SeasonTeamData,
} from "./templates/TeamSeason";
import { TrendsPage } from "./templates/Trends";
import { time, timingMiddleware } from "./lib/timing";

type Bindings = {
  // KV namespaces (2C). Bulk league/team summary cache + a small
  // isolated namespace for the last-updated stamp, mirroring the
  // wrangler.toml [[kv_namespaces]] entries.
  LEAGUE_DATA: KVNamespace;
  SUMMARY_LAST_UPDATED: KVNamespace;
  // Python /cfb/process URL. Plain var for 2B; sub-phase 3B replaces
  // this with a Container binding (`PBP_PROCESSOR.fetch(...)`) and
  // the env var goes away.
  PYTHON_BASE_URL: string;
  // Sub-phase 2H: when Python is exposed publicly through a Caddy
  // proxy on the droplet (so the Worker can reach it from CF
  // edge), Caddy enforces an X-Worker-Secret header. The Worker
  // sends c.env.WORKER_SHARED_SECRET on every Python call. Set
  // via `wrangler secret put WORKER_SHARED_SECRET`. Optional so
  // local dev or a future Container binding (3B) doesn't need it.
  WORKER_SHARED_SECRET?: string;
  // Same shape as PYTHON_BASE_URL but for the summary service
  // (cfb-team-summaries container at summary:3000 on the droplet).
  // Caddy fronts it at https://summary.unseen-university.org with
  // the same X-Worker-Secret gate. Sub-phase 3B will replace this
  // alongside Python when both move to Cloudflare Containers.
  SUMMARY_BASE_URL: string;
};

// Bundle the per-request summary-client config so route handlers
// can pass one object into the lib/summary.ts retrieve* helpers
// instead of threading three params.
function summaryCfg(c: Context<{ Bindings: Bindings }>) {
  return {
    kv: c.env.LEAGUE_DATA,
    base: c.env.SUMMARY_BASE_URL,
    secret: c.env.WORKER_SHARED_SECRET,
  };
}

// retrieveLastUpdated reads from a different KV namespace
// (SUMMARY_LAST_UPDATED) so it gets its own helper.
function lastUpdatedCfg(c: Context<{ Bindings: Bindings }>) {
  return {
    kv: c.env.SUMMARY_LAST_UPDATED,
    base: c.env.SUMMARY_BASE_URL,
    secret: c.env.WORKER_SHARED_SECRET,
  };
}

const app = new Hono<{ Bindings: Bindings }>();

// 2G: per-request Server-Timing + structured-JSON request log on
// every response. Op names match the Express side (`python`,
// `espn_pbp`, `kv_lookup`, `summary`, `render`, `total`) so the
// perf-plan baselines in docs/perf-plan.md stay 1:1 comparable.
app.use("*", timingMiddleware());

app.get("/", (c) => c.redirect("/cfb/"));

app.get("/cfb/healthcheck", (c) => c.json({ status: "ok", source: "worker-scaffold" }));

// Scoreboard family — three routes that render the same template
// with different year/type/week parameters. Mirrors routes.js:310-384.
//
// The bare /cfb/ case (year=null, week=null, default group) reads
// from the cron-warmed `cfb-scoreboard-80` KV key first. Other
// shapes (group=-1 Top-25, group=82 FCS, year/week historical) hit
// ESPN directly — those aren't cron-warmed.
async function renderScoreboard(
  c: Context<{ Bindings: Bindings }>,
  opts: {
    year: string | number | null;
    week: string | number | null;
    seasontype: string | number;
    title: string | null;
  },
) {
  const groupParam = c.req.query("group");
  const group = groupParam ?? 80;
  const isDefaultCurrent =
    opts.year == null &&
    opts.week == null &&
    parseInt(String(group), 10) === 80;
  // ESPN's historical schedule endpoint (cdn.espn.com/.../schedule)
  // hands out 503s and HTML-instead-of-JSON often enough that
  // letting them surface as 5xxs to the user is the wrong default.
  // Catch and render the empty-state ("No games scheduled.") so a
  // transient ESPN hiccup looks like a quiet day instead of a
  // broken site. The structured log line gives forensics for when
  // someone reports a blank scoreboard. The bare /cfb/ path
  // (isDefaultCurrent) is mostly insulated by KV cache from
  // getCachedCurrentScoreboard, but the same catch applies for
  // the case where KV is also cold (off-season, fresh deploy).
  let games: ScheduleEvent[] = [];
  try {
    if (isDefaultCurrent) {
      games = await time(c, "espn_scoreboard", () =>
        getCachedCurrentScoreboard(c.env.LEAGUE_DATA),
      );
    } else {
      games = await time(c, "espn_scoreboard", () =>
        getGames({
          year: opts.year,
          week: opts.week,
          type: opts.seasontype,
          group,
        }),
      );
    }
  } catch (err) {
    console.log(
      JSON.stringify({
        event: "espn_scoreboard_failure",
        year: opts.year,
        week: opts.week,
        type: opts.seasontype,
        group,
        error: (err as Error).message,
      }),
    );
    // games stays []; the template renders the "No games
    // scheduled." path.
  }
  const scoreboard = prepareGameList(games);
  return c.html(
    <ScoreboardPage
      scoreboard={scoreboard}
      weekList={getWeeksMap()}
      groups={getGroups()}
      year={opts.year}
      week={opts.week}
      seasontype={opts.seasontype}
      group={group}
      title={opts.title}
      hasActiveGames={hasActiveGames(scoreboard)}
    />,
  );
}

app.get("/cfb/", (c) =>
  renderScoreboard(c, { year: null, week: null, seasontype: 2, title: null }),
);

app.get("/cfb/year/:year/type/:type/week/:week", async (c) => {
  const year = c.req.param("year");
  const type = c.req.param("type");
  const week = c.req.param("week");
  const weeks = getWeeksMap();
  const weekTitle =
    weeks[year]?.find(
      (w) => parseInt(String(w.type), 10) === parseInt(type, 10) && parseInt(String(w.value), 10) === parseInt(week, 10),
    )?.title ?? null;
  return renderScoreboard(c, { year, week, seasontype: type, title: weekTitle });
});

app.get("/cfb/year/:year", async (c) => {
  const year = c.req.param("year");
  const weeks = getWeeksMap();
  const weekTitle =
    weeks[year]?.find(
      (w) => parseInt(String(w.type), 10) === 2 && parseInt(String(w.value), 10) === 1,
    )?.title ?? null;
  return renderScoreboard(c, { year, week: 1, seasontype: 2, title: weekTitle });
});

// First real port (sub-phase 2B). Static-ish page — validates that the
// Layout component, Hono JSX renderer, and JSON-data import path all
// work end-to-end before we tackle a route that hits ESPN or KV.
app.get("/cfb/glossary", (c) => c.html(<GlossaryPage glossary={getGlossary()} />));

// Static redirects from frontend/cfb/routes.js. All 302s (Express's
// res.redirect default and Hono's c.redirect default both 302). The
// 2025 hardcodes mirror the Express side; track via CURRENT_SEASON so
// the next-season bump is one constant edit.
app.get("/cfb/teams", (c) => c.redirect(`/cfb/year/${CURRENT_SEASON}/teams/differential`));
app.get("/cfb/teams/:type", (c) =>
  c.redirect(`/cfb/year/${CURRENT_SEASON}/teams/${c.req.param("type")}`),
);
app.get("/cfb/year/:year/teams", (c) =>
  c.redirect(`/cfb/year/${c.req.param("year")}/teams/differential`),
);
app.get("/cfb/charts/team/epa", (c) =>
  c.redirect(`/cfb/year/${CURRENT_SEASON}/charts/team/epa`),
);
app.get("/cfb/players", (c) => c.redirect(`/cfb/year/${CURRENT_SEASON}/players/passing`));
app.get("/cfb/players/:type", (c) =>
  c.redirect(`/cfb/year/${CURRENT_SEASON}/players/${c.req.param("type")}`),
);
app.get("/cfb/year/:year/players", (c) =>
  c.redirect(`/cfb/year/${c.req.param("year")}/players/passing`),
);

// First KV-using route. Pulls the season's "overall" league data from
// LEAGUE_DATA (KV-first, summary-service fallback), filters/sorts per
// the requested type+sort, and renders the leaderboard table.
app.get("/cfb/year/:year/teams/:type", async (c) => {
  const year = parseInt(c.req.param("year"), 10);
  const type = (c.req.param("type") || "differential") as LeaderboardType;
  const requestedSort = c.req.query("sort") || "overall.adjEpaPerPlay";

  const baseData = await retrieveLeagueData(summaryCfg(c), year, "overall");
  const { rows, sortKey } = prepareLeaderboardRows(baseData, type, requestedSort);
  const lastUpdated = await retrieveLastUpdated(lastUpdatedCfg(c));

  return c.html(
    <LeaderboardPage
      teams={rows}
      type={type}
      season={year}
      sort={sortKey}
      lastUpdated={lastUpdated}
    />,
  );
});

// National trends chart. Pulls 5 percentile bands (1/25/50/75/99) for
// the requested metric across all available seasons. Differential
// type silently rewrites to offensive (the chart can't represent
// differentials). Mirrors routes.js:719-760 — the JSON-by-query-param
// path is preserved at the top with `?json=1`.
app.get("/cfb/charts/trends", async (c) => {
  let type = c.req.query("type") || "offensive";
  if (type === "differential") type = "offensive";
  const metric = c.req.query("metric") || "overall.epaPerPlay";

  const PCTILES = [0.01, 0.25, 0.5, 0.75, 0.99];
  const allPctls = (
    await Promise.all(PCTILES.map((p) => retrievePercentiles(summaryCfg(c), null, p)))
  ).flat();

  const pctlKey = getPercentileKey(metric);
  const selectedPercentiles = allPctls
    .map((p) => ({ season: p.season, pctile: p.pctile, value: p[pctlKey] }))
    .filter((p) => p.value !== undefined && p.value !== null);

  const jsonParam = c.req.query("json");
  if (jsonParam === "true" || jsonParam === "1") {
    return c.json(selectedPercentiles);
  }

  const lastUpdated = await retrieveLastUpdated(lastUpdatedCfg(c));
  const seasons = selectedPercentiles
    .map((b) => b.season)
    .sort((a, b) => a - b);

  return c.html(
    <TrendsPage
      seasons={seasons}
      percentiles={selectedPercentiles}
      type={type}
      metric={metric}
      lastUpdated={lastUpdated}
    />,
  );
});

// Adj-EPA scatter for a season. Projects league-overall data to four
// fields per team, lets Chart.js do the rest.
app.get("/cfb/year/:year/charts/team/epa", async (c) => {
  const year = parseInt(c.req.param("year"), 10);
  const baseData = await retrieveLeagueData(summaryCfg(c), year, "overall");
  const teams: EpaChartTeam[] = baseData.map((t) => {
    const offensive = (t.offensive as Record<string, Record<string, unknown>> | undefined)?.overall;
    const defensive = (t.defensive as Record<string, Record<string, unknown>> | undefined)?.overall;
    return {
      teamId: t.teamId,
      team: String(t.team),
      fbsClass: String(t.fbsClass ?? ""),
      adjOffEpa: offensive?.adjEpaPerPlay as number | null | undefined,
      adjDefEpa: defensive?.adjEpaPerPlay as number | null | undefined,
    };
  });
  const lastUpdated = await retrieveLastUpdated(lastUpdatedCfg(c));
  return c.html(<EpaChartPage teams={teams} season={year} lastUpdated={lastUpdated} />);
});

// Multi-season team page. ESPN team metadata + summary-service
// per-season breakdowns + (when type != differential) percentile
// bands for the chosen metric. Mirrors routes.js:633-688 — the
// `?json=1` shortcut returns just the ESPN team payload, and the
// differential→adjEpaPerPlay metric rewrite preserves the EJS
// template's "can't differential havoc/passing/rushing" rule.
app.get("/cfb/team/:teamId", async (c) => {
  const teamId = c.req.param("teamId");
  const data = await getTeamInformation(teamId);
  if (data == null) {
    throw new Error(
      `Data not available for team ${teamId}. An internal service may be down.`,
    );
  }

  const jsonParam = c.req.query("json");
  if (jsonParam === "true" || jsonParam === "1") {
    return c.json(data);
  }

  const breakdowns = await retrieveTeamData(summaryCfg(c), null, teamId, null);
  const type = c.req.query("type") ?? "differential";
  let metric = c.req.query("metric") ?? "overall.adjEpaPerPlay";
  if (
    type === "differential" &&
    (!metric.includes("overall") || metric.includes("havocRate"))
  ) {
    metric = "overall.adjEpaPerPlay";
  }

  let selectedPercentiles: Array<{
    season: number | string;
    pctile: number | string;
    value: number;
  }> = [];
  if (type !== "differential") {
    const PCTILES = [0.01, 0.25, 0.5, 0.75, 0.99];
    const allPctls = (
      await Promise.all(
        PCTILES.map((p) => retrievePercentiles(summaryCfg(c), null, p)),
      )
    ).flat();
    const pctlKey = getPercentileKey(metric);
    selectedPercentiles = allPctls
      .map((p) => ({
        season: p.season,
        pctile: p.pctile,
        value: p[pctlKey] as number,
      }))
      .filter((p) => p.value !== undefined && p.value !== null);
  }

  const seasons = breakdowns
    .map((b) => Number(b.season))
    .filter((n) => !Number.isNaN(n))
    .sort((a, b) => a - b);

  const lastUpdated = await retrieveLastUpdated(lastUpdatedCfg(c));

  return c.html(
    <TeamPage
      teamData={data as TeamData}
      breakdowns={breakdowns as unknown as Array<Record<string, unknown> & { season: number | string }>}
      seasons={seasons}
      percentiles={selectedPercentiles}
      type={type}
      metric={metric}
      lastUpdated={lastUpdated}
    />,
  );
});

// Per-season team page. Mirrors routes.js:556-583. ESPN season-scoped
// payload (record + athletes + ranks + leaders + schedule) plus four
// retrieveTeamData calls (overall + passing + rushing + receiving) for
// the breakdown panels and player_box rows. The `?json=1` shortcut
// returns the raw ESPN payload.
app.get("/cfb/year/:year/team/:teamId", async (c) => {
  const yearStr = c.req.param("year");
  const year = parseInt(yearStr, 10);
  const teamId = c.req.param("teamId");

  const data = await getTeamSeasonInformation(year, teamId);
  if (data == null) {
    throw new Error(
      `Data not available for team ${teamId} and season ${yearStr}. An internal service may be down.`,
    );
  }

  const jsonParam = c.req.query("json");
  if (jsonParam === "true" || jsonParam === "1") {
    return c.json(data);
  }

  // Four parallel summary fetches, one per stat slice.
  const [breakdown, passing, rushing, receiving] = await Promise.all([
    retrieveTeamData(summaryCfg(c), year, teamId, "overall"),
    retrieveTeamData(summaryCfg(c), year, teamId, "passing"),
    retrieveTeamData(summaryCfg(c), year, teamId, "rushing"),
    retrieveTeamData(summaryCfg(c), year, teamId, "receiving"),
  ]);

  const players: PlayersByType = {
    passing: passing as unknown as PlayersByType["passing"],
    rushing: rushing as unknown as PlayersByType["rushing"],
    receiving: receiving as unknown as PlayersByType["receiving"],
  };

  return c.html(
    <TeamSeasonPage
      teamData={data as SeasonTeamData}
      breakdown={breakdown as unknown as Array<Record<string, unknown>>}
      players={players}
      season={yearStr}
    />,
  );
});

// Per-game PBP page. Mirrors routes.js:414-553.
//
// Branches (in order):
//   1. Cache API fast path: `caches.default.match(request)` returns a
//      previously-rendered Response if it's still within Cache-Control
//      bounds. Replaces the KV-based per-game cache from sub-phase 2B.
//   2. quarantined gameId → game_error template, errorType=quarantine.
//      Cached at edge for 1 day (quarantine entries are stable).
//   3. ESPN PBP probe to determine status. If STATUS_SCHEDULED (or
//      `?preview_mode={old,new}`), fetch the two team breakdowns from
//      summary and render the pregame template. Cached 5 min.
//   4. otherwise, call Python (no cache layer in lib/games anymore;
//      the Cache API replaces it). Render game.ejs equivalent. On
//      any error, fall back to game_error with errorType=pbp; that
//      response is NOT cached because the underlying error may
//      resolve when Python or ESPN comes back.
//
// `?json=1` short-circuits the HTML render at any branch where
// processed PBP is in hand and returns it as JSON. Each variant
// gets its own cache entry because caches.default keys on the full
// request URL.
function clampSeason(input: number | undefined): number {
  if (input == null || Number.isNaN(input)) return CURRENT_SEASON;
  return Math.min(Math.max(input, MIN_SEASON), CURRENT_SEASON);
}

function gameInfoFromEspnEnvelope(envelope: EspnPbpEnvelope) {
  const competition = envelope.gamepackageJSON?.header?.competitions?.[0];
  return competition;
}

// Cache-Control directives by branch. Numbers chosen to mirror the
// Express-side TTLs (KV: 60 s in-progress, 1 day completed) but
// extended where it's safe to do so given the data's actual
// volatility.
const CACHE_CONTROL = {
  // Completed games: bytes the user sees never change. Browser 1
  // day, edge 1 year.
  completed: "public, max-age=86400, s-maxage=31536000",
  // In-progress: very short — the page auto-refreshes every minute
  // anyway. 30 s lets back-to-back requests collapse without
  // staling the live game.
  inProgress: "public, max-age=30, s-maxage=30",
  // Pregame: 5 min. Team metadata + matchup percentiles don't shift
  // pre-kickoff but we don't want to outlive the actual kickoff
  // moment (which would silently keep serving "scheduled" past the
  // real start).
  pregame: "public, max-age=300, s-maxage=300",
  // Quarantine entries are static (fork-maintained list); 1 day
  // matches the Express side's gut feel.
  quarantine: "public, max-age=86400, s-maxage=86400",
} as const;

// Wrap a JSX element in a Response with the chosen Cache-Control.
// Hono normally builds this via c.html(); we go through Response
// directly so we can attach headers before passing to cache.put.
function cachedHtml(body: string, cacheControl: string): Response {
  return new Response(body, {
    headers: {
      "content-type": "text/html; charset=UTF-8",
      "cache-control": cacheControl,
    },
  });
}

function cachedJson(body: unknown, cacheControl: string): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
      "cache-control": cacheControl,
    },
  });
}

app.get("/cfb/game/:gameId", async (c) => {
  const gameId = c.req.param("gameId");
  const isJsonShortcut =
    c.req.query("json") === "true" || c.req.query("json") === "1";
  const previewMode = c.req.query("preview_mode");

  // Cache API fast path. Keyed by the full request URL so
  // `?json=1` and `?preview_mode=...` get distinct entries
  // automatically.
  const cache = caches.default;
  const cacheKey = new Request(c.req.url, { method: "GET" });
  const cachedResponse = await time(c, "cache_lookup", () => cache.match(cacheKey));
  if (cachedResponse) return cachedResponse;

  // Quarantine gate runs before ESPN — short-circuits the probe
  // entirely. We still need the gameInfo for the error template's
  // score header, so a one-shot ESPN call sources it. The error
  // template itself caches for 1 day (quarantine list is stable).
  if (QUARANTINE_LIST.has(gameId)) {
    let envelope: EspnPbpEnvelope;
    try {
      envelope = await time(c, "espn_pbp", () => probeEspnPbp(gameId));
    } catch (err) {
      throw new Error(`ESPN PBP probe failed for ${gameId}: ${(err as Error).message}`);
    }
    const competition = gameInfoFromEspnEnvelope(envelope);
    if (competition == null) {
      throw new Error(`ESPN PBP envelope had no header.competitions[0] for ${gameId}`);
    }
    const html = await time(c, "render", async () =>
      (<GameErrorPage gameInfo={competition as GameErrorGameInfo} errorType="quarantine" />).toString(),
    );
    const response = cachedHtml(html, CACHE_CONTROL.quarantine);
    c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  }

  // Probe ESPN to decide pregame vs game vs error. Any failure here
  // means we can't even render an error page (the error page needs
  // the gameInfo for the score header), so let Hono's 500 handler
  // take it.
  let envelope: EspnPbpEnvelope;
  try {
    envelope = await time(c, "espn_pbp", () => probeEspnPbp(gameId));
  } catch (err) {
    throw new Error(`ESPN PBP probe failed for ${gameId}: ${(err as Error).message}`);
  }
  const competition = gameInfoFromEspnEnvelope(envelope);
  if (competition == null) {
    throw new Error(`ESPN PBP envelope had no header.competitions[0] for ${gameId}`);
  }
  const season = envelope.gamepackageJSON?.header?.season?.year ?? CURRENT_SEASON;
  const week = envelope.gamepackageJSON?.header?.week ?? 0;
  const homeComp = competition.competitors?.[0];
  const awayComp = competition.competitors?.[1];
  const homeTeam = homeComp?.team;
  const awayTeam = awayComp?.team;
  const isScheduled =
    competition.status?.type?.name === "STATUS_SCHEDULED" ||
    previewMode === "old" ||
    previewMode === "new";

  if (isScheduled && homeTeam?.id != null && awayTeam?.id != null) {
    // Pregame: pull both teams' summary breakdowns in parallel.
    // Capture IDs before the time() closure so TS keeps the
    // non-null narrowing through the callback.
    const awayId = awayTeam.id;
    const homeId = homeTeam.id;
    const [awayBreakdown, homeBreakdown] = await time(c, "summary", () =>
      Promise.all([
        retrieveTeamData(summaryCfg(c), season, awayId, "overall"),
        retrieveTeamData(summaryCfg(c), season, homeId, "overall"),
      ]),
    );
    const pregameData: PregameData = {
      gameInfo: competition as PregameData["gameInfo"],
      header: (envelope.gamepackageJSON?.header ?? {}) as PregameData["header"],
      matchup: {
        team: [
          ...(awayBreakdown as unknown as Array<Record<string, unknown>>),
          ...(homeBreakdown as unknown as Array<Record<string, unknown>>),
        ],
      },
    };
    const html = await time(c, "render", async () =>
      (<PregamePage gameData={pregameData} season={season} week={week} viewFull={previewMode === "old"} />).toString(),
    );
    const response = cachedHtml(html, CACHE_CONTROL.pregame);
    c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  }

  // Past or live game → fetch processed PBP via Python (no cache
  // layer in lib/games anymore — the Cache API above plays that
  // role). Errors render game_error and are NOT cached so a Python
  // outage doesn't pin the user to a stale error page once Python
  // recovers.
  let data: ProcessedGameData;
  try {
    data = await time(c, "python", () =>
      fetchAndShapePBP(c.env.PYTHON_BASE_URL, gameId, c.env.WORKER_SHARED_SECRET),
    );
  } catch (err) {
    console.log(`Python /cfb/process failed for ${gameId}: ${(err as Error).message}`);
    return c.html(
      <GameErrorPage gameInfo={competition as GameErrorGameInfo} errorType="pbp" />,
    );
  }
  if (data.gameInfo == null) {
    return c.html(
      <GameErrorPage gameInfo={competition as GameErrorGameInfo} errorType="pbp" />,
    );
  }

  const completed = data.gameInfo.status?.type?.completed === true;
  const cacheControl = completed ? CACHE_CONTROL.completed : CACHE_CONTROL.inProgress;

  if (isJsonShortcut) {
    const response = cachedJson(data, cacheControl);
    c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  }

  const headerSeason = data.header?.season?.year ?? season;
  const clamped = clampSeason(headerSeason);
  let percentiles: Array<Record<string, unknown>> = [];
  try {
    percentiles = await time(c, "percentiles", async () =>
      (await retrievePercentiles(summaryCfg(c), clamped, null)) as Array<Record<string, unknown>>,
    );
  } catch (err) {
    console.log(`percentiles fetch failed: ${(err as Error).message}`);
  }
  const html = await time(c, "render", async () =>
    (<GamePage gameData={data as unknown as RenderableGameData} percentiles={percentiles} season={clamped} />).toString(),
  );
  const response = cachedHtml(html, cacheControl);
  c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
});

// Player leaderboard. Same KV-first → summary-fallback shape as the
// team leaderboard, but the data is shaped per-player (no t[type]
// projection step) and sort is always descending.
app.get("/cfb/year/:year/players/:type", async (c) => {
  const year = parseInt(c.req.param("year"), 10);
  const type = (c.req.param("type") || "passing") as PlayerLeaderboardType;
  const sortKey = c.req.query("sort") || "advanced.epaPerPlay";

  const baseData = await retrieveLeagueData(summaryCfg(c), year, type);
  const rows = preparePlayerRows(baseData, sortKey);
  const lastUpdated = await retrieveLastUpdated(lastUpdatedCfg(c));

  return c.html(
    <PlayerLeaderboardPage
      players={rows}
      type={type}
      season={year}
      sort={sortKey}
      lastUpdated={lastUpdated}
    />,
  );
});

// Sub-phase 2F: cron-warmed scoreboard.
//
// Wrangler's [triggers] crons = ["* * * * *"] fires this once a
// minute. Outside football season (Aug 20 – Jan 20) the handler
// short-circuits without touching ESPN — saves ~200k cron
// executions/year and avoids hammering ESPN's scoreboard endpoint
// with effectively-empty payloads in the off-season.
//
// On a Cron failure (ESPN timeout, fetch error, KV write error)
// the previous KV value remains valid until its 3-min TTL
// expires; the next-minute cron retries. After ~3 minutes of
// continuous failures the cache goes cold and the / route
// transparently falls through to a live ESPN fetch.
async function scheduled(
  _event: ScheduledController,
  env: Bindings,
  ctx: ExecutionContext,
): Promise<void> {
  if (!isFootballSeason()) {
    console.log("scoreboard cron: off-season, skipping");
    return;
  }
  ctx.waitUntil(
    writeCurrentScoreboard(env.LEAGUE_DATA)
      .then((count) => console.log(`scoreboard cron: wrote ${count} games to KV`))
      .catch((err) => console.log(`scoreboard cron failed: ${(err as Error).message}`)),
  );
}

// Hono needs an explicit object export to expose both fetch and
// scheduled — `export default app` only exposes fetch.
export default {
  fetch: app.fetch,
  scheduled,
};
