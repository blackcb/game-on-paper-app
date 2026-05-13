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
  fetchAndShapePBPLoadTest,
  fetchAndShapePBPTiered,
  probeEspnPbp,
  type EspnPbpEnvelope,
  type ProcessedGameData,
  type TieredFetchMetadata,
} from "./lib/games";
import { readCachedGameHtml, writeCachedGameHtml } from "./lib/html-cache";
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
import { pythonBackend, summaryBackend } from "./lib/backends";
import { isGameWindow, pingContainer, pingContainers, prewarmTopGames } from "./lib/cron";
import { PythonContainer, SummaryContainer } from "./containers";

// Re-export the Container DO subclasses so wrangler can find them
// at the Worker entry point (required by `[[durable_objects.bindings]]`
// resolution and the `[[migrations]] new_sqlite_classes` step).
export { PythonContainer, SummaryContainer };

type Bindings = {
  // KV namespaces (2C). Bulk league/team summary cache + a small
  // isolated namespace for the last-updated stamp, mirroring the
  // wrangler.toml [[kv_namespaces]] entries.
  LEAGUE_DATA: KVNamespace;
  SUMMARY_LAST_UPDATED: KVNamespace;
  // Python /cfb/process URL. Used when PYTHON_BACKEND === "droplet".
  PYTHON_BASE_URL: string;
  // Sub-phase 2H: when Python is exposed publicly through a Caddy
  // proxy on the droplet (so the Worker can reach it from CF
  // edge), Caddy enforces an X-Worker-Secret header. lib/backends.ts
  // stamps it on droplet-path requests. Set via
  // `wrangler secret put WORKER_SHARED_SECRET`. Optional so local
  // dev or the container path doesn't need it.
  WORKER_SHARED_SECRET?: string;
  // Same shape as PYTHON_BASE_URL but for the summary service.
  SUMMARY_BASE_URL: string;
  // Sub-phase 3B: Cloudflare Container DO bindings. Defined in
  // src/containers.ts; reachable via getContainer(env.X). Optional
  // here so callers without container blocks in their wrangler
  // config (e.g. a test env that skips them) still type-check.
  PYTHON_CONTAINER?: DurableObjectNamespace<PythonContainer>;
  SUMMARY_CONTAINER?: DurableObjectNamespace<SummaryContainer>;
  // Backend toggle vars. lib/backends.ts reads these to pick
  // droplet vs. container per-request. Defaulting to "droplet"
  // anywhere unset preserves the pre-3B behavior; the cutover
  // (3D) flips them to "container".
  PYTHON_BACKEND?: string;
  SUMMARY_BACKEND?: string;
  // Architecture B migration (2026-05-10). "service" (default) selects
  // the production-historical service-binding-to-Container path;
  // "tiered" selects the fetch+cf path that participates in CF's
  // standard cache + Smart Tiered Cache. See lib/games.ts and
  // docs/migrate-to-tiered-cache.md.
  PYTHON_FETCH_MODE?: string;
  // Drives sleepAfter on the Container DO subclasses (see
  // src/containers.ts and SEASON-MODES.md). Only meaningful when
  // PYTHON_BACKEND/SUMMARY_BACKEND === "container".
  SEASON_MODE?: string;
  // Cron-warm kill-switch + Layer C top-N knob (3C).
  CRON_WARM_ENABLED?: string;
  PREWARM_TOP_N?: string;
  // Layer C self-fetch target. Defaults to the prod hostname; the
  // perftest profile points at its own workers.dev URL so prewarms
  // hit the perftest Worker instead of bleeding into prod.
  PREWARM_BASE_URL?: string;
};

// Bundle the per-request summary-client config so route handlers
// can pass one object into the lib/summary.ts retrieve* helpers.
// Sub-phase 3B: `fetch` is a `BackendFetch` from lib/backends.ts that
// transparently routes through either the droplet HTTPS path or the
// Cloudflare Container DO binding based on env.SUMMARY_BACKEND.
function summaryCfg(c: Context<{ Bindings: Bindings }>) {
  return {
    kv: c.env.LEAGUE_DATA,
    fetch: summaryBackend(c.env),
  };
}

// retrieveLastUpdated reads from a different KV namespace
// (SUMMARY_LAST_UPDATED) so it gets its own helper.
function lastUpdatedCfg(c: Context<{ Bindings: Bindings }>) {
  return {
    kv: c.env.SUMMARY_LAST_UPDATED,
    fetch: summaryBackend(c.env),
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
  // Per-PoP HTML cache, same shape as /cfb/game/:gameId. Before this
  // wrap landed, the bare /cfb/ route was the only major page that
  // re-rendered JSX on every request despite having KV-cached
  // upstream data — warm TTFB was ~render-cost across the board.
  // With caches.default in front, same-PoP repeats land in ~30 ms.
  //
  // TTL strategy: `inProgress` (30 s + SWR 60) when the page shows
  // live games — matches the page's own 60 s auto-reload cadence,
  // so most repeats fall in the SWR window. `pregame` (5 min)
  // otherwise. Empty scoreboards do NOT cache (errorNoStore) — a
  // transient ESPN/KV hiccup that renders "No games scheduled."
  // shouldn't lock the page into that state for the TTL window.
  const cache = caches.default;
  const cacheKey = new Request(c.req.url, { method: "GET" });
  const cached = await cache.match(cacheKey);
  if (cached != null) {
    const headers = new Headers(cached.headers);
    headers.set("x-worker-cache", "HIT");
    return new Response(cached.body, {
      status: cached.status,
      statusText: cached.statusText,
      headers,
    });
  }

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
  const active = hasActiveGames(scoreboard);
  const empty = scoreboard.length === 0;

  // Opportunistic Python container warm (2026-05-09 cold-start mask).
  // A user landing on the scoreboard is statistically about to click
  // into a game page — fire-and-forget a warmup ping so the Python
  // container is being resumed during the user's reading time. Gated
  // on CRON_WARM_ENABLED so the same kill-switch that disables Layer
  // B also disables this. The active-games gate filters the case
  // where the user is browsing a quiet historical week — no
  // click-through worth warming for.
  if (c.env.CRON_WARM_ENABLED === "1" && c.env.PYTHON_CONTAINER && active) {
    c.executionCtx.waitUntil(pingContainer(c.env.PYTHON_CONTAINER, "python"));
  }

  const html = await time(c, "render", async () =>
    (
      <ScoreboardPage
        scoreboard={scoreboard}
        weekList={getWeeksMap()}
        groups={getGroups()}
        year={opts.year}
        week={opts.week}
        seasontype={opts.seasontype}
        group={group}
        title={opts.title}
        hasActiveGames={active}
      />
    ).toString(),
  );

  const cacheControl = empty
    ? CACHE_CONTROL.errorNoStore
    : active
      ? CACHE_CONTROL.inProgress
      : CACHE_CONTROL.pregame;
  const response = cachedHtml(html, cacheControl);
  if (!empty) {
    c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));
  }
  return response;
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
  //
  // Sub-phase 3B Layer E: `stale-if-error=86400` lets caches serve
  // the last cached response for up to 24 h if the origin returns
  // 5xx (or times out). On Cloudflare Containers, a cache miss
  // landing on a freshly-redeployed PoP can hit the image-pull
  // cold-start window (>10 s) where the Worker times out the
  // container call — without stale-if-error that surfaces as a
  // user-facing error; with it, the user gets the stale cached
  // response while the cache transparently retries.
  //
  // Post-droplet cold-start mask (2026-05-09): `stale-while-revalidate`
  // hides the much more common case where a PoP's cache LRU evicts an
  // entry and the next user lands on a cold container. Completed-game
  // bytes are static, so SWR is semantically a no-op — the background
  // refresh produces an identical body — but the user gets the cached
  // response instantly while the container warms.
  completed: "public, max-age=86400, s-maxage=31536000, stale-while-revalidate=86400, stale-if-error=86400",
  // In-progress: very short — the page auto-refreshes every
  // minute anyway. 30 s lets back-to-back requests collapse
  // without staling the live game.
  //
  // Sub-phase 2J: `stale-while-revalidate=60` lets cache layers
  // (browser + caches.default at edge) serve the stale response
  // for up to 60 s past expiry while triggering a background
  // refresh. Without SWR, the unlucky user whose request lands
  // at TTL expiry waits ~4 s for a fresh Python pipeline run.
  // With SWR, that user gets the slightly-stale cached response
  // immediately (~75 ms) and the next request gets the fresh
  // one. Tail latency drops from "spike every 30 s" to
  // "always ~75 ms with eventual consistency."
  //
  // Sub-phase 3B Layer E: `stale-if-error=86400` — see `completed`.
  inProgress:
    "public, max-age=30, s-maxage=30, stale-while-revalidate=60, stale-if-error=86400",
  // Pregame: 5 min. Team metadata + matchup percentiles don't shift
  // pre-kickoff but we don't want to outlive the actual kickoff
  // moment (which would silently keep serving "scheduled" past the
  // real start).
  //
  // Post-droplet cold-start mask (2026-05-09): SWR + stale-if-error
  // matched to the 5-min TTL. Pregame hits the summary container
  // (matchup percentiles + team breakdowns); a PoP cache miss right
  // before kickoff can land on a cold summary container. SWR gives
  // the cached response instantly while the refresh runs in the
  // background. Capped at 300 s so the stale window can't outlive
  // an actual kickoff state transition.
  pregame: "public, max-age=300, s-maxage=300, stale-while-revalidate=300, stale-if-error=300",
  // Quarantine entries are static (fork-maintained list); 1 day
  // matches the Express side's gut feel.
  quarantine: "public, max-age=86400, s-maxage=86400",
  // Errors must NEVER be cached — the underlying Python/ESPN
  // failure may resolve in the next minute. Sub-phase 2I (Cache
  // Rules + Origin Cache Control) makes this header load-bearing:
  // without it, the standard CF cache could fall through to its
  // default-cacheable behavior on a 200-status error response.
  // `no-store` is stricter than `no-cache` — explicit "do not
  // store this response anywhere".
  errorNoStore: "no-store, max-age=0",
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

// Variants that take extra observability headers. Used by the
// /cfb/game/:gameId handler to stamp x-fetch-mode + x-upstream-cache
// on responses during the Architecture B migration.
function cachedHtmlWithHeaders(body: string, cacheControl: string, extra: Record<string, string>): Response {
  const headers = new Headers({
    "content-type": "text/html; charset=UTF-8",
    "cache-control": cacheControl,
  });
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(body, { headers });
}

function cachedJsonWithHeaders(body: unknown, cacheControl: string, extra: Record<string, string>): Response {
  const headers = new Headers({
    "content-type": "application/json",
    "cache-control": cacheControl,
  });
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(JSON.stringify(body), { headers });
}

// Load-test branch sentinel. When `?replay=<unix_ts>` is present on a
// /cfb/game/:gameId request, the handler routes through
// `fetchAndShapePBPLoadTest` instead of the production pipeline:
//
//   - Skips the ESPN STATUS probe (replay always returns
//     STATUS_IN_PROGRESS until elapsed >= duration, then
//     STATUS_FINAL — the Worker's pregame branch is never the
//     correct call here).
//   - Skips the quarantine check (synthetic fixtures are by
//     definition not quarantined).
//   - Reads `?arch=` to pick Architecture A (caches.default +
//     service-binding) vs Architecture B (fetch+cf via public URL).
//   - Reads `?replay_duration=` (default 1800) for fixture wallclock
//     mapping.
//
// Production traffic does not pass these query params, so the
// production code path below is unaffected. See worker/scripts/
// loadtest/README.md for the harness end-to-end story.
async function serveLoadTestGame(
  c: Context,
  gameId: string,
  isJsonShortcut: boolean,
  replayStartedAt: number,
): Promise<Response> {
  const arch = c.req.query("arch") === "tiered" ? "tiered" : "baseline";
  const replayDuration = parseFloat(
    c.req.query("replay_duration") ?? "1800",
  ) || 1800;

  // Architecture A's caches.default fast path. Mirror the production
  // route's wrap so the harness measures the same shape production
  // would see during a live in-progress game. Skipped under arch=tiered
  // (the cache layer for B lives inside the fetch+cf, not in the Worker).
  const cache = caches.default;
  const cacheKey = new Request(c.req.url, { method: "GET" });
  if (arch === "baseline") {
    const cached = await cache.match(cacheKey);
    if (cached != null) {
      const headers = new Headers(cached.headers);
      headers.set("x-worker-cache", "HIT");
      headers.set("x-arch", "baseline");
      return new Response(cached.body, {
        status: cached.status,
        statusText: cached.statusText,
        headers,
      });
    }
  }

  let data: ProcessedGameData;
  // Output channel for the inner fetch's cf-cache-status. Architecture
  // B's whole point is the inner fetch participating in tiered cache;
  // without surfacing this header on the Worker's outgoing response
  // the harness can't distinguish a B-edge-HIT from a B-origin-MISS.
  const metadata: { upstreamCacheStatus?: string | null; upstreamServerTiming?: string | null } = {};
  try {
    data = await time(c, "loadtest_pbp", () =>
      fetchAndShapePBPLoadTest(gameId, {
        python: arch === "baseline" ? pythonBackend(c.env) : undefined,
        cached: arch === "tiered"
          ? {
              baseUrl: c.env.PYTHON_BASE_URL,
              secret: c.env.WORKER_SHARED_SECRET,
              // Match the in-progress / completed CACHE_CONTROL TTLs.
              // 30 s in-progress lines up with caches.default's branch
              // for arch=baseline so the two architectures see the
              // same TTL pressure during a run.
              cacheTtlInProgress: 30,
              cacheTtlCompleted: 86400,
            }
          : undefined,
        replay: { startedAt: replayStartedAt, duration: replayDuration },
        metadata,
      }),
    );
  } catch (err) {
    console.log(
      JSON.stringify({
        event: "loadtest_failure",
        gameId,
        arch,
        error: (err as Error).message,
      }),
    );
    return new Response(
      JSON.stringify({ status: "bad", message: (err as Error).message }),
      { status: 502, headers: { "content-type": "application/json", "x-arch": arch } },
    );
  }

  const completed = data.gameInfo?.status?.type?.completed === true;
  const cacheControl = completed ? CACHE_CONTROL.completed : CACHE_CONTROL.inProgress;

  if (isJsonShortcut) {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "cache-control": cacheControl,
      "x-arch": arch,
    };
    if (metadata.upstreamCacheStatus) headers["x-upstream-cache"] = metadata.upstreamCacheStatus;
    const response = new Response(JSON.stringify(data), { headers });
    if (arch === "baseline") {
      c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));
    }
    return response;
  }

  const headerSeason = data.header?.season?.year ?? CURRENT_SEASON;
  const clamped = clampSeason(headerSeason);
  let percentiles: Array<Record<string, unknown>> = [];
  try {
    percentiles = await time(c, "percentiles", async () =>
      (await retrievePercentiles(summaryCfg(c), clamped, null)) as Array<
        Record<string, unknown>
      >,
    );
  } catch (err) {
    console.log(
      JSON.stringify({
        event: "loadtest_percentiles_failure",
        gameId,
        error: (err as Error).message,
      }),
    );
  }
  const html = await time(c, "render", async () =>
    (
      <GamePage
        gameData={data as unknown as RenderableGameData}
        percentiles={percentiles}
        season={clamped}
      />
    ).toString(),
  );
  const responseHeaders: Record<string, string> = {
    "content-type": "text/html; charset=UTF-8",
    "cache-control": cacheControl,
    "x-arch": arch,
  };
  if (metadata.upstreamCacheStatus) responseHeaders["x-upstream-cache"] = metadata.upstreamCacheStatus;
  const response = new Response(html, { headers: responseHeaders });
  if (arch === "baseline") {
    c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));
  }
  return response;
}

app.get("/cfb/game/:gameId", async (c) => {
  const gameId = c.req.param("gameId");
  const isJsonShortcut =
    c.req.query("json") === "true" || c.req.query("json") === "1";
  const previewMode = c.req.query("preview_mode");

  // Load-test gate. Activated by `?replay=<unix_ts>`. Production
  // traffic doesn't carry this query string, so this branch is dead
  // for normal users. See `serveLoadTestGame` and worker/scripts/
  // loadtest/README.md.
  const replayRaw = c.req.query("replay");
  if (replayRaw != null && replayRaw !== "") {
    const startedAt = parseFloat(replayRaw);
    if (Number.isFinite(startedAt)) {
      return serveLoadTestGame(c, gameId, isJsonShortcut, startedAt);
    }
  }

  // Cache layer for /cfb/game/*: per-PoP `caches.default`,
  // populated by the Worker on render and read at the top of this
  // route. All four branches below (quarantine, pregame, game-
  // error, main game) call `cache.put`, so a single match here
  // covers any branch's prior put.
  //
  // History: Phase 2I tried to short-circuit HITs at the edge via
  // a Cache Rule running before the Worker, and on that bet we
  // DROPPED `caches.default.match` from this route. The Cache
  // Rule never engaged on this account (parked 2026-05-07; see
  // migration-plan §2I), which meant every game-page request was
  // running the full Worker → Container → Python pipeline —
  // confirmed 2026-05-09 by worker/scripts/perf-coldstart.mjs
  // (cf-cache-status: -, hit-path TTFB ≈ 2.5s on repeat hits).
  // Re-adding the match returns same-PoP HITs in ~50ms instead.
  //
  // Cross-PoP pooling still doesn't engage (Smart Tiered Cache
  // limitation on this plan, validated 2026-05-05) — first hit
  // per PoP still pays the container cost. Cron-warm + cold-start
  // mask cover that case.
  const cache = caches.default;
  const cacheKey = new Request(c.req.url, { method: "GET" });

  const cached = await cache.match(cacheKey);
  if (cached != null) {
    // Add a worker-cache HIT signal for logs and the perf probe;
    // CF's `cf-cache-status` won't appear because this response
    // is coming from the Worker, not the CDN edge.
    const headers = new Headers(cached.headers);
    headers.set("x-worker-cache", "HIT");
    return new Response(cached.body, {
      status: cached.status,
      statusText: cached.statusText,
      headers,
    });
  }

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
    // Opportunistic Python container warm (2026-05-09 cold-start mask).
    // User viewing a pregame is likely to come back at kickoff — by
    // then this PoP's cache may have expired (5-min pregame TTL) and
    // the container may be cold. Warm now so the kickoff hit lands on
    // a hot container. Same kill-switch as scoreboard warm (#5).
    if (c.env.CRON_WARM_ENABLED === "1" && c.env.PYTHON_CONTAINER) {
      c.executionCtx.waitUntil(pingContainer(c.env.PYTHON_CONTAINER, "python"));
    }

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

  // Layer 3 cache: KV-backed completed-game HTML cache. Completed
  // games are byte-stable; once we've rendered one anywhere globally,
  // every other PoP can serve from KV (~80 ms) instead of paying the
  // ~5 s Python pipeline. Gated on the ESPN probe saying the game
  // is completed (so we know the cached HTML, if present, is still
  // valid for this gameId).
  //
  // `caches.default` (Layer 1, per-PoP, 1y) sits in front of this.
  // KV (Layer 3) only fires when Layer 1 misses — typically the
  // "first user in this PoP for this game" case. The JSON tiered
  // cache (Layer 2, 30s) doesn't help here because completed games'
  // HTML doesn't change but the tiered TTL is shorter than caches.default.
  //
  // Skip for ?json=1 — the JSON-shortcut path returns raw data, not
  // rendered HTML, and isn't on the user-experience critical path.
  // Skip for in-progress games — their HTML is volatile.
  const completedPerEspn = competition.status?.type?.completed === true;
  const htmlCacheEligible = completedPerEspn && !isJsonShortcut;
  let kvHtml: string | null = null;
  if (htmlCacheEligible) {
    try {
      kvHtml = await time(c, "kv_html", async () =>
        await readCachedGameHtml(c.env.LEAGUE_DATA, gameId),
      );
    } catch (err) {
      // KV read failures shouldn't break the page — fall through to
      // the normal pipeline. Logged for visibility.
      console.log(
        JSON.stringify({
          event: "kv_html_read_failure",
          gameId,
          error: (err as Error).message,
        }),
      );
    }
  }
  if (kvHtml != null) {
    const response = cachedHtmlWithHeaders(kvHtml, CACHE_CONTROL.completed, {
      "x-html-cache": "HIT",
    });
    c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  }

  // Past or live game → fetch processed PBP via Python. Errors
  // render game_error with explicit no-store so the standard
  // cache (per Cache Rule from 2I) won't hold the failure past
  // the underlying Python/ESPN issue resolving.
  //
  // PYTHON_FETCH_MODE selects the transport:
  //   - "service" (default, today's behavior): service-binding to
  //     the Cloudflare Container, POST /cfb/process. Per-PoP cache
  //     via caches.default at the Worker layer.
  //   - "tiered" (Architecture B, post-migration target): public-URL
  //     fetch with cf:{cacheEverything,cacheTtlByStatus}. The JSON
  //     response participates in CF's standard cache + Smart Tiered
  //     Cache, pooling across PoPs. caches.default still wraps the
  //     rendered HTML at this layer for warm-path speed.
  // Cutover happens by flipping wrangler.toml; rollback is the same
  // edit in reverse. Per docs/migrate-to-tiered-cache.md.
  const pythonFetchMode = c.env.PYTHON_FETCH_MODE === "tiered" ? "tiered" : "service";
  const tieredMeta: TieredFetchMetadata = {};
  let data: ProcessedGameData;
  try {
    data = await time(c, "python", () =>
      pythonFetchMode === "tiered"
        ? fetchAndShapePBPTiered(c.env, gameId, tieredMeta)
        : fetchAndShapePBP(pythonBackend(c.env), gameId),
    );
  } catch (err) {
    console.log(
      JSON.stringify({
        event: "python_failure",
        gameId,
        mode: pythonFetchMode,
        error: (err as Error).message,
      }),
    );
    const html = (
      <GameErrorPage gameInfo={competition as GameErrorGameInfo} errorType="pbp" />
    ).toString();
    return cachedHtml(html, CACHE_CONTROL.errorNoStore);
  }
  if (data.gameInfo == null) {
    const html = (
      <GameErrorPage gameInfo={competition as GameErrorGameInfo} errorType="pbp" />
    ).toString();
    return cachedHtml(html, CACHE_CONTROL.errorNoStore);
  }

  const completed = data.gameInfo.status?.type?.completed === true;
  const cacheControl = completed ? CACHE_CONTROL.completed : CACHE_CONTROL.inProgress;

  // Build extra response headers for observability. x-fetch-mode lets
  // operators see which transport handled this request (especially
  // useful during the cutover smoke window). x-upstream-cache surfaces
  // the inner fetch's cf-cache-status when in tiered mode — gives
  // visibility into whether the JSON cache is engaging without parsing
  // server-timing strings.
  const extraHeaders: Record<string, string> = { "x-fetch-mode": pythonFetchMode };
  if (tieredMeta.upstreamCacheStatus) {
    extraHeaders["x-upstream-cache"] = tieredMeta.upstreamCacheStatus;
  }
  if (htmlCacheEligible) {
    // Reached here because the KV layer missed — flag MISS for
    // observability so analysis can compute the KV-hit rate.
    extraHeaders["x-html-cache"] = "MISS";
  }

  if (isJsonShortcut) {
    const response = cachedJsonWithHeaders(data, cacheControl, extraHeaders);
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
    console.log(
      JSON.stringify({
        event: "percentiles_failure",
        gameId,
        season: clamped,
        error: (err as Error).message,
      }),
    );
  }
  const html = await time(c, "render", async () =>
    (<GamePage gameData={data as unknown as RenderableGameData} percentiles={percentiles} season={clamped} />).toString(),
  );
  const response = cachedHtmlWithHeaders(html, cacheControl, extraHeaders);
  c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));
  // Write to KV for completed games. Confirmed by data.gameInfo this
  // time (not just the ESPN probe) so a game that finished BETWEEN the
  // probe and the Python fetch still gets correctly classified. The
  // `completed` flag is set from `data.gameInfo.status.type.completed`
  // above. KV write is fire-and-forget — failure is logged but doesn't
  // block the response.
  if (completed && htmlCacheEligible) {
    c.executionCtx.waitUntil(
      writeCachedGameHtml(c.env.LEAGUE_DATA, gameId, html).catch((err) => {
        console.log(
          JSON.stringify({
            event: "kv_html_write_failure",
            gameId,
            error: (err as Error).message,
          }),
        );
      }),
    );
  }
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
    console.log(JSON.stringify({ event: "cron_skipped", reason: "off_season" }));
    return;
  }
  ctx.waitUntil(
    writeCurrentScoreboard(env.LEAGUE_DATA)
      .then((count) =>
        console.log(JSON.stringify({ event: "cron_run", target: "scoreboard", games: count })),
      )
      .catch((err) =>
        console.log(
          JSON.stringify({
            event: "cron_failure",
            target: "scoreboard",
            error: (err as Error).message,
          }),
        ),
      ),
  );

  // Sub-phase 3C Layer B: keep containers warm during gameday window.
  // Gated on the env-var kill-switch + the in-window check so
  // (a) misconfigured deploys (CRON_WARM_ENABLED=0) don't ping, and
  // (b) off-window cron ticks don't waste container time.
  if (env.CRON_WARM_ENABLED === "1" && isGameWindow()) {
    ctx.waitUntil(pingContainers(env));

    // Sub-phase 3C Layer C: top-N game pre-warm. Materially more
    // expensive than Layer B (N full /cfb/process pipeline runs vs.
    // a healthcheck), so throttle to every 3 minutes within the
    // gameday window even though the cron itself fires per minute.
    // PREWARM_TOP_N=0 in env disables Layer C while keeping Layer B
    // active — used by the `normal` profile (weekday in-season).
    const minute = new Date().getUTCMinutes();
    if (minute % 3 === 0) {
      ctx.waitUntil(prewarmTopGames(env));
    }
  }
}

// Hono needs an explicit object export to expose both fetch and
// scheduled — `export default app` only exposes fetch.
export default {
  fetch: app.fetch,
  scheduled,
};
