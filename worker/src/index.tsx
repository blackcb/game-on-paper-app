// Phase 2 worker entry. Routes are ported in the order documented in
// docs/migration-plan.md sub-phase 2B; this file wires them up.

import { Hono } from "hono";
import { getGlossary } from "./lib/glossary";
import {
  getPercentileKey,
  preparePlayerRows,
  prepareLeaderboardRows,
  type LeaderboardType,
  type PlayerLeaderboardType,
} from "./lib/leaderboard";
import { CURRENT_SEASON } from "./lib/season";
import {
  retrieveLastUpdated,
  retrieveLeagueData,
  retrievePercentiles,
  retrieveTeamData,
} from "./lib/summary";
import { getTeamInformation } from "./lib/teams";
import { EpaChartPage, type EpaChartTeam } from "./templates/EpaChart";
import { GlossaryPage } from "./templates/Glossary";
import { LeaderboardPage } from "./templates/Leaderboard";
import { PlayerLeaderboardPage } from "./templates/PlayerLeaderboard";
import { TeamPage, type TeamData } from "./templates/Team";
import { TrendsPage } from "./templates/Trends";

type Bindings = {
  // KV namespaces (2C). Bulk league/team summary cache + a small
  // isolated namespace for the last-updated stamp, mirroring the
  // wrangler.toml [[kv_namespaces]] entries.
  LEAGUE_DATA: KVNamespace;
  SUMMARY_LAST_UPDATED: KVNamespace;
  // Container binding (3B), per-route secrets (2B+) get added below
  // as we port handlers.
};

const app = new Hono<{ Bindings: Bindings }>();

app.get("/", (c) => c.redirect("/cfb/"));

app.get("/cfb/", (c) =>
  c.text("gameonpaper Worker scaffold — port in progress (see docs/migration-plan.md Phase 2)."),
);

app.get("/cfb/healthcheck", (c) => c.json({ status: "ok", source: "worker-scaffold" }));

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
