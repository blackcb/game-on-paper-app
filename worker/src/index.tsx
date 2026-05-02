// Phase 2 worker entry. Routes are ported in the order documented in
// docs/migration-plan.md sub-phase 2B; this file wires them up.

import { Hono } from "hono";
import { getGlossary } from "./lib/glossary";
import {
  preparePlayerRows,
  prepareLeaderboardRows,
  type LeaderboardType,
  type PlayerLeaderboardType,
} from "./lib/leaderboard";
import { CURRENT_SEASON } from "./lib/season";
import { retrieveLastUpdated, retrieveLeagueData } from "./lib/summary";
import { GlossaryPage } from "./templates/Glossary";
import { LeaderboardPage } from "./templates/Leaderboard";
import { PlayerLeaderboardPage } from "./templates/PlayerLeaderboard";

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
