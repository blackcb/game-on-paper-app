// Sub-phase 3C cron-warm: keep Cloudflare Containers from going
// idle during football season game hours, so the rare cache miss
// during gameday doesn't pay the ~14 s cold-start tax measured in
// 3A.7. Layered defense — Layer A (Cache API + SWR) absorbs most
// repeats already; cron-warm is a backstop for the long-tail miss.
//
// This module only contains the cron helpers; the scheduled handler
// in src/index.tsx decides whether to call them based on env vars
// (CRON_WARM_ENABLED, SEASON_MODE) and the game-hours window.

import { getContainer } from "@cloudflare/containers";
import type { PythonContainer, SummaryContainer } from "../containers";
import { getCachedCurrentScoreboard } from "./schedule";
import type { ScheduleEvent } from "./team_helpers";

// Football gameday window in UTC. Two segments:
//   - Saturday 15:00 UTC → Sunday 08:00 UTC: full Saturday slate +
//     late-night Pac-12 / Hawaii kickoffs.
//   - Tuesday–Friday 22:00 UTC → next-day 04:00 UTC: weekday evening
//     kickoffs (MAC midweeks, Thu/Fri primetime). 22 UTC ≈ 18 ET.
//     Added 2026-05-09 to close the gap SEASON-MODES.md promised
//     for `normal` mode but `isGameWindow` didn't actually cover.
//
// Off-window the cron-warm calls don't fire — Mon + Sun afternoons
// + early-morning hours rely on `sleepAfter` alone.
export function isGameWindow(now: Date = new Date()): boolean {
  const day = now.getUTCDay(); // 0=Sun, 6=Sat
  const hour = now.getUTCHours();
  // Saturday slate.
  if (day === 6 && hour >= 15) return true;
  if (day === 0 && hour < 8) return true;
  // Weekday primetime: Tue–Fri 22:00 UTC opens; Wed–Sat 04:00 UTC closes.
  // (i.e., the evening of day D extends into the early hours of D+1.)
  if (day >= 2 && day <= 5 && hour >= 22) return true;
  if (day >= 3 && day <= 6 && hour < 4) return true;
  return false;
}

// Subset of Bindings that pingContainers needs. Inline so this
// module doesn't require the full Bindings shape from index.tsx.
export interface CronWarmEnv {
  CRON_WARM_ENABLED?: string;
  PYTHON_CONTAINER?: DurableObjectNamespace<PythonContainer>;
  SUMMARY_CONTAINER?: DurableObjectNamespace<SummaryContainer>;
}

// Per-container warmup path. Python has a heavier `/warmup` route
// (added 2026-05-09) that exercises CFBPlayProcess + XGBoost model
// loads, so a cron-resumed container has the boosters in memory
// before the first user request. The summary container has no
// equivalent model-load cost, so a plain `/healthcheck` suffices.
function warmupPath(name: string): string {
  return name === "python" ? "/warmup" : "/healthcheck";
}

// Exported (2026-05-09) so `renderScoreboard` and the pregame branch
// in `src/index.tsx` can fire opportunistic background warms via
// `ctx.waitUntil(pingContainer(...))` — same mechanism as the cron
// path, just triggered by entry-page traffic instead of a schedule.
export async function pingContainer<T extends PythonContainer | SummaryContainer>(
  binding: DurableObjectNamespace<T> | undefined,
  name: string,
): Promise<void> {
  // Defensive: a wrangler config without the binding (e.g. the
  // pre-3B base wrangler.toml during a partial cutover) shouldn't
  // crash the cron handler.
  if (!binding) return;
  const start = Date.now();
  try {
    const stub = getContainer(binding);
    const res = await stub.fetch(`http://container${warmupPath(name)}`);
    console.log(
      JSON.stringify({
        event: "cron_warm",
        target: name,
        status: res.status,
        ms: Date.now() - start,
      }),
    );
  } catch (err) {
    console.log(
      JSON.stringify({
        event: "cron_warm_failure",
        target: name,
        error: (err as Error).message,
        ms: Date.now() - start,
      }),
    );
  }
}

// Layer B — fire `/healthcheck` against both containers in parallel.
// Caller (the scheduled handler in index.tsx) is expected to gate on
// env.CRON_WARM_ENABLED + isGameWindow() before calling.
//
// Each ping is 1 DO invocation + 1 cheap container HTTP roundtrip
// (~30 ms warm). Total cost across a 12-hour Saturday window
// firing every minute: ~720 invocations × ~30 ms = ~22 s of active
// container time. Negligible vs. the cold-start it prevents.
export async function pingContainers(env: CronWarmEnv): Promise<void> {
  await Promise.all([
    pingContainer(env.PYTHON_CONTAINER, "python"),
    pingContainer(env.SUMMARY_CONTAINER, "summary"),
  ]);
}

// ─── Layer C — top-N game pre-warm ──────────────────────────────────

export interface PrewarmEnv {
  PREWARM_TOP_N?: string;
  PREWARM_BASE_URL?: string;
  LEAGUE_DATA: KVNamespace;
}

// Active = currently being played, so users hitting the page get the
// most volatile data. Status-name strings come from ESPN's enum;
// these three cover the in-progress states we render with the
// `inProgress` cache directive in src/index.tsx.
function isActive(game: ScheduleEvent): boolean {
  const name = game.status?.type?.name ?? "";
  return (
    name === "STATUS_IN_PROGRESS" ||
    name === "STATUS_HALFTIME" ||
    name === "STATUS_END_PERIOD"
  );
}

// Completed games get a 1-year Cache-Control from src/index.tsx, so a
// prewarm self-fetch is guaranteed to be a no-op cache hit. Filter
// them out before slicing top-N — otherwise on a Saturday with only a
// few active games, PREWARM_TOP_N=10 burns slots on already-cached
// finals.
function isCompleted(game: ScheduleEvent): boolean {
  return game.status?.type?.completed === true;
}

// Rank: in-progress games first (most-volatile, most cache-pressure).
// Otherwise preserve scoreboard order — ESPN tends to return upcoming
// games sorted by start time, which is a sensible secondary key.
function rankForPrewarm(game: ScheduleEvent): number {
  return isActive(game) ? 0 : 1;
}

// Top-N self-fetch. Hits the Worker's own public URL so the request
// goes through the *full* render pipeline and lands a complete HTML
// response into `caches.default` — subsequent user requests at the
// same PoP get a cache hit, not a cold-container hit.
//
// Locality caveat: CF Crons fire from a single region; the self-
// fetch warms the PoP that handles the cron-originating request.
// Other PoPs see the cache miss on first user request. Acceptable
// for a first ship — log volume in Workers Analytics will tell us
// whether multi-region warming is worth building.
async function prewarmOne(base: string, gameId: string | number): Promise<void> {
  const start = Date.now();
  try {
    const res = await fetch(`${base}/cfb/game/${gameId}`);
    console.log(
      JSON.stringify({
        event: "prewarm",
        gameId,
        status: res.status,
        bytes: parseInt(res.headers.get("content-length") ?? "0", 10),
        ms: Date.now() - start,
      }),
    );
  } catch (err) {
    console.log(
      JSON.stringify({
        event: "prewarm_failure",
        gameId,
        error: (err as Error).message,
        ms: Date.now() - start,
      }),
    );
  }
}

// Layer C — read the cron-warmed scoreboard from KV (already populated
// by writeCurrentScoreboard at the top of `scheduled`), pick the top
// N games, fire parallel self-fetches against the Worker's public URL.
//
// Caller is expected to gate on env.CRON_WARM_ENABLED + isGameWindow()
// + a cadence check (e.g. minute % 3 === 0) before calling — Layer C
// is materially more expensive than Layer B, so don't fire on every
// per-minute cron tick.
//
// Cost (rough): N games × ~5 s active CPU per /cfb/process call.
// At N=10 firing every 3 minutes during a 13-hour Saturday window:
// 13 × 20 × 10 × 5 s ≈ 130 active container-minutes per Saturday.
// Real money but bounded; PREWARM_TOP_N=0 disables, smaller N
// proportionally smaller cost.
export async function prewarmTopGames(env: PrewarmEnv): Promise<void> {
  const n = parseInt(env.PREWARM_TOP_N ?? "0", 10);
  if (!n || n <= 0 || !env.PREWARM_BASE_URL) return;

  let games: ScheduleEvent[];
  try {
    games = await getCachedCurrentScoreboard(env.LEAGUE_DATA);
  } catch (err) {
    console.log(
      JSON.stringify({
        event: "prewarm_skip",
        reason: "scoreboard_read_failed",
        error: (err as Error).message,
      }),
    );
    return;
  }
  if (games.length === 0) {
    console.log(JSON.stringify({ event: "prewarm_skip", reason: "no_games" }));
    return;
  }

  const candidates = games.filter((g) => !isCompleted(g));
  const sorted = candidates.sort((a, b) => rankForPrewarm(a) - rankForPrewarm(b));
  const top = sorted.slice(0, n).filter((g) => g.id != null);

  await Promise.all(
    top.map((g) => prewarmOne(env.PREWARM_BASE_URL!, g.id!)),
  );
}
