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
  getPBP,
  peekCachedPBP,
  probeEspnPbp,
  type EspnPbpEnvelope,
} from "./lib/games";
import {
  getGames,
  getGroups,
  getWeeksMap,
  hasActiveGames,
  prepareGameList,
} from "./lib/schedule";
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
};

const app = new Hono<{ Bindings: Bindings }>();

app.get("/", (c) => c.redirect("/cfb/"));

app.get("/cfb/healthcheck", (c) => c.json({ status: "ok", source: "worker-scaffold" }));

// Scoreboard family — three routes that render the same template
// with different year/type/week parameters. Mirrors routes.js:310-384.
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
  const games = await getGames({
    year: opts.year,
    week: opts.week,
    type: opts.seasontype,
    group,
  });
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

  const baseData = await retrieveLeagueData(c.env.LEAGUE_DATA, year, "overall");
  const { rows, sortKey } = prepareLeaderboardRows(baseData, type, requestedSort);
  const lastUpdated = await retrieveLastUpdated(c.env.SUMMARY_LAST_UPDATED);

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
    await Promise.all(PCTILES.map((p) => retrievePercentiles(c.env.LEAGUE_DATA, null, p)))
  ).flat();

  const pctlKey = getPercentileKey(metric);
  const selectedPercentiles = allPctls
    .map((p) => ({ season: p.season, pctile: p.pctile, value: p[pctlKey] }))
    .filter((p) => p.value !== undefined && p.value !== null);

  const jsonParam = c.req.query("json");
  if (jsonParam === "true" || jsonParam === "1") {
    return c.json(selectedPercentiles);
  }

  const lastUpdated = await retrieveLastUpdated(c.env.SUMMARY_LAST_UPDATED);
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
  const baseData = await retrieveLeagueData(c.env.LEAGUE_DATA, year, "overall");
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
  const lastUpdated = await retrieveLastUpdated(c.env.SUMMARY_LAST_UPDATED);
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

  const breakdowns = await retrieveTeamData(c.env.LEAGUE_DATA, null, teamId, null);
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
        PCTILES.map((p) => retrievePercentiles(c.env.LEAGUE_DATA, null, p)),
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

  const lastUpdated = await retrieveLastUpdated(c.env.SUMMARY_LAST_UPDATED);

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
    retrieveTeamData(c.env.LEAGUE_DATA, year, teamId, "overall"),
    retrieveTeamData(c.env.LEAGUE_DATA, year, teamId, "passing"),
    retrieveTeamData(c.env.LEAGUE_DATA, year, teamId, "rushing"),
    retrieveTeamData(c.env.LEAGUE_DATA, year, teamId, "receiving"),
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
//   1. cache-first fast path: if KV has the processed PBP AND the
//      cached snapshot reports completed=true (and the gameId isn't
//      quarantined), skip ESPN entirely and render. Saves ~400 ms.
//   2. quarantined gameId → game_error template, errorType=quarantine.
//   3. ESPN PBP probe to determine status. If STATUS_SCHEDULED (or
//      `?preview_mode={old,new}`), fetch the two team breakdowns from
//      summary and render the pregame template.
//   4. otherwise, call Python via getPBP (cache-aware). Render
//      game.ejs equivalent. On any error, fall back to game_error
//      with errorType=pbp.
//
// `?json=1` short-circuits the HTML render at any branch where
// processed PBP is in hand and returns it as JSON.
//
// The full game template (charts/box score/PBP table) is mid-port —
// see Game.tsx. The chrome + scoring summary render today; the
// chart-heavy sections land in a follow-up commit.
function clampSeason(input: number | undefined): number {
  if (input == null || Number.isNaN(input)) return CURRENT_SEASON;
  return Math.min(Math.max(input, MIN_SEASON), CURRENT_SEASON);
}

function gameInfoFromEspnEnvelope(envelope: EspnPbpEnvelope) {
  const competition = envelope.gamepackageJSON?.header?.competitions?.[0];
  return competition;
}

app.get("/cfb/game/:gameId", async (c) => {
  const gameId = c.req.param("gameId");
  const isJsonShortcut =
    c.req.query("json") === "true" || c.req.query("json") === "1";
  const previewMode = c.req.query("preview_mode");

  // Fast path: cached completed game, not quarantined.
  if (!QUARANTINE_LIST.has(gameId)) {
    const cached = await peekCachedPBP(c.env.LEAGUE_DATA, gameId);
    if (cached?.gameInfo?.status?.type?.completed === true) {
      if (isJsonShortcut) return c.json(cached);
      const season = clampSeason(cached.header?.season?.year);
      let percentiles: Array<Record<string, unknown>> = [];
      try {
        percentiles = (await retrievePercentiles(c.env.LEAGUE_DATA, season, null)) as Array<
          Record<string, unknown>
        >;
      } catch (err) {
        console.log(`percentiles fetch failed (cached path): ${(err as Error).message}`);
      }
      return c.html(
        <GamePage gameData={cached as unknown as RenderableGameData} percentiles={percentiles} season={season} />,
      );
    }
  }

  // Probe ESPN to decide pregame vs game vs error. Any failure here
  // means we can't even render an error page (the error page needs
  // the gameInfo for the score header), so let Hono's 500 handler
  // take it.
  let envelope: EspnPbpEnvelope;
  try {
    envelope = await probeEspnPbp(gameId);
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
    const [awayBreakdown, homeBreakdown] = await Promise.all([
      retrieveTeamData(c.env.LEAGUE_DATA, season, awayTeam.id, "overall"),
      retrieveTeamData(c.env.LEAGUE_DATA, season, homeTeam.id, "overall"),
    ]);
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
    return c.html(
      <PregamePage gameData={pregameData} season={season} week={week} viewFull={previewMode === "old"} />,
    );
  }

  // Quarantine gate: short-circuit before paying the Python cost.
  if (QUARANTINE_LIST.has(gameId)) {
    return c.html(
      <GameErrorPage gameInfo={competition as GameErrorGameInfo} errorType="quarantine" />,
    );
  }

  // Past or live game → fetch processed PBP via Python (cache-aware).
  const data = await getPBP(c.env.LEAGUE_DATA, c.env.PYTHON_BASE_URL, gameId);
  if (data == null || data.gameInfo == null) {
    return c.html(
      <GameErrorPage gameInfo={competition as GameErrorGameInfo} errorType="pbp" />,
    );
  }
  if (isJsonShortcut) return c.json(data);

  const headerSeason = data.header?.season?.year ?? season;
  const clamped = clampSeason(headerSeason);
  let percentiles: Array<Record<string, unknown>> = [];
  try {
    percentiles = (await retrievePercentiles(c.env.LEAGUE_DATA, clamped, null)) as Array<
      Record<string, unknown>
    >;
  } catch (err) {
    console.log(`percentiles fetch failed: ${(err as Error).message}`);
  }
  return c.html(
    <GamePage gameData={data as unknown as RenderableGameData} percentiles={percentiles} season={clamped} />,
  );
});

// Player leaderboard. Same KV-first → summary-fallback shape as the
// team leaderboard, but the data is shaped per-player (no t[type]
// projection step) and sort is always descending.
app.get("/cfb/year/:year/players/:type", async (c) => {
  const year = parseInt(c.req.param("year"), 10);
  const type = (c.req.param("type") || "passing") as PlayerLeaderboardType;
  const sortKey = c.req.query("sort") || "advanced.epaPerPlay";

  const baseData = await retrieveLeagueData(c.env.LEAGUE_DATA, year, type);
  const rows = preparePlayerRows(baseData, sortKey);
  const lastUpdated = await retrieveLastUpdated(c.env.SUMMARY_LAST_UPDATED);

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

export default app;
