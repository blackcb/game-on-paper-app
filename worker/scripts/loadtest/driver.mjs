#!/usr/bin/env node
// Game-day load-test driver. Runs N concurrent viewers against a
// configurable target matrix for T minutes; emits JSONL metrics on
// stdout (one line per request, plus run-start and run-end summary
// lines).
//
// Designed to run from any host — laptop, Docker, AWS Lambda — with
// no dependencies beyond Node 18+. The Lambda wrapper in
// scripts/loadtest/lambda/ is just a thin invoker around `runDriver()`.
//
// Three targets compose the architecture comparison defined in
// docs/migration-plan.md (and the planning conversation that produced
// this harness):
//
//   - A (Workers + service-binding Container + caches.default)
//   - B (Workers + public Python via fetch+cf, tiered cache)
//   - D (legacy DigitalOcean Express+Flask+Redis)
//
// Architectures A and B share a Worker; the harness picks between
// them with `?arch=baseline` vs `?arch=tiered`. D is hit at a
// separate hostname with no arch flag (the legacy stack ignores it).
//
// The test sends `?replay=<unix_ts>&replay_duration=<s>` to A and B
// to drive the synthetic-in-progress mode in python/app.py. D doesn't
// support replay (no synthetic mode on the legacy stack), so for D
// we hit a static completed-game URL — measures warm-cache TTFB only,
// not SWR-during-PBP-update behavior. That asymmetry is called out
// in the analysis notebook.

import { setTimeout as sleep } from "node:timers/promises";
import crypto from "node:crypto";

// ----- defaults that the Lambda invoker (or CLI) overrides -----

export const DEFAULT_CONFIG = {
  region: process.env.LOADTEST_REGION ?? "local",
  // 30-min run, 50 viewers spread across 3 architectures = ~17 viewers
  // per arch. Within a region this gives ~6 PoP-distinct viewers per
  // arch (rough US PoP count for AWS-region distribution).
  viewerCount: 17,
  runDurationSeconds: 30 * 60,
  // Cycle interval matches the Worker's in-progress max-age=30 + swr=60
  // window. Adding ±5s of jitter so we don't pin all viewers to the
  // same wallclock TTL boundary; that artifact would mask SWR
  // behavior.
  cyclePeriodSeconds: 30,
  cycleJitterSeconds: 5,
  // Replay duration mirrors the run length so the simulated game
  // finishes right at run-end. 148 plays (typical fixture) over
  // 30 min = 1 play every ~12s, ~2-3 plays per cache TTL.
  replayDurationSeconds: 30 * 60,
  // Default architecture matrix. The harness assigns each viewer to
  // a target round-robin so ~17 viewers hit each target.
  targets: [
    {
      label: "A",
      baseUrl: "https://sports.unseen-university.org",
      arch: "baseline",
      replay: true,
    },
    {
      label: "B",
      baseUrl: "https://sports.unseen-university.org",
      arch: "tiered",
      replay: true,
    },
    {
      label: "D",
      baseUrl: "https://gameonpaper.com",
      arch: null,
      replay: false,
    },
  ],
  // Game IDs rotate across viewers so the warm-cache pool isn't a
  // single URL — a real game day spreads load across a slate. The
  // captured fixtures (python/tests/fixtures/) are the only valid
  // replay targets; if you add a fixture, add it here too.
  gameIds: ["401520434", "401403910", "401628329"],
  // Hard caps on what a single Lambda invocation will do. Lambda's
  // default timeout is 15 min; runDurationSeconds caps us inside that.
  // viewerCount * cyclePeriod requests is the rough upper bound on
  // concurrency.
  perViewerTimeoutMs: 20_000,
  // Optional bypass token. When set, harness sends X-Loadtest-Token
  // on every request. The Cloudflare WAF Skip rule keyed on this
  // header lets the harness through Bot Fight Mode / managed
  // challenges without disabling them zone-wide. Plumb via the
  // Lambda invocation payload — never bake the literal token into
  // the image.
  loadtestToken: process.env.LOADTEST_TOKEN ?? null,
  // Body-hash window size. The first 4 KB of HTML/JSON is enough to
  // detect content-version changes (PBP plays array start, status
  // block, etc.) without storing 200+ KB hashes per request.
  bodyHashBytes: 4096,
};

// ----- single request probe -----

async function probe({ url, requestStart, signal, extraHeaders }) {
  const t0 = Date.now();
  // We could use undici with finer hooks for TCP/TLS phases, but
  // process.hrtime() round-trip + Date.now() for absolute clock is
  // sufficient for the architecture-comparison signal we want.
  const tHr = process.hrtime.bigint();
  const res = await fetch(url, {
    signal,
    redirect: "follow",
    headers: {
      // Browser-shaped headers so Cloudflare's heuristic bot detection
      // doesn't flag the Lambda IPs as datacenter automation. Bot
      // Fight Mode on the free plan still 403s known-datacenter ASNs,
      // so the operator should also add a WAF Skip rule keyed on
      // X-Loadtest-Token (or temporarily disable Bot Fight Mode); see
      // README.md for the runbook.
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) gameonpaper-loadtest",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      ...(extraHeaders ?? {}),
    },
  });
  const tHeadersHr = process.hrtime.bigint();
  const buf = await res.arrayBuffer();
  const tBodyHr = process.hrtime.bigint();

  const ttfbMs = Number(tHeadersHr - tHr) / 1e6;
  const totalMs = Number(tBodyHr - tHr) / 1e6;
  const bodyLen = buf.byteLength;
  const slice = new Uint8Array(buf, 0, Math.min(bodyLen, DEFAULT_CONFIG.bodyHashBytes));
  const bodyHashShort = crypto.createHash("sha1").update(slice).digest("hex").slice(0, 12);

  return {
    request_start_ms: t0,
    request_started_at: new Date(t0).toISOString(),
    request_started_at_offset_ms: t0 - requestStart,
    status: res.status,
    ttfb_ms: Math.round(ttfbMs * 100) / 100,
    total_ms: Math.round(totalMs * 100) / 100,
    body_bytes: bodyLen,
    body_hash_short: bodyHashShort,
    cf_cache_status: res.headers.get("cf-cache-status") ?? null,
    cf_ray: res.headers.get("cf-ray") ?? null,
    age: res.headers.get("age") ?? null,
    cache_control: res.headers.get("cache-control") ?? null,
    server: res.headers.get("server") ?? null,
    server_timing: res.headers.get("server-timing") ?? null,
    x_worker_cache: res.headers.get("x-worker-cache") ?? null,
    x_arch: res.headers.get("x-arch") ?? null,
    x_replay_play_index: res.headers.get("x-replay-play-index") ?? null,
    // Architecture B's load-bearing signal: the inner fetch+cf's cache
    // status, propagated by serveLoadTestGame. Architecture A returns
    // null here (service binding bypasses the edge cache).
    x_upstream_cache: res.headers.get("x-upstream-cache") ?? null,
    content_encoding: res.headers.get("content-encoding") ?? null,
  };
}

// ----- single viewer loop -----

async function runViewer({ viewerIndex, target, gameId, runConfig, runStartedAt, emit }) {
  const { cyclePeriodSeconds, cycleJitterSeconds, perViewerTimeoutMs, runDurationSeconds, replayDurationSeconds, region, loadtestToken } = runConfig;
  const extraHeaders = loadtestToken ? { "X-Loadtest-Token": loadtestToken } : undefined;
  const runEndsAt = runStartedAt + runDurationSeconds * 1000;
  let cycle = 0;

  // Stagger viewer start so 50 simultaneous launches don't pile onto
  // the same wallclock millisecond — that would mask the SWR-boundary
  // behavior the analysis notebook keys on.
  const stagger = Math.floor(Math.random() * cyclePeriodSeconds * 1000);
  await sleep(stagger);

  while (Date.now() < runEndsAt) {
    const url = buildUrl({ target, gameId, runStartedAt, replayDurationSeconds });
    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), perViewerTimeoutMs);
    try {
      const result = await probe({ url, requestStart: runStartedAt, signal: ac.signal, extraHeaders });
      emit({
        type: "request",
        region,
        viewer_index: viewerIndex,
        cycle,
        target_label: target.label,
        target_url: url,
        game_id: gameId,
        ...result,
      });
    } catch (err) {
      emit({
        type: "request_error",
        region,
        viewer_index: viewerIndex,
        cycle,
        target_label: target.label,
        target_url: url,
        game_id: gameId,
        error: err?.message ?? String(err),
        request_started_at: new Date(Date.now()).toISOString(),
      });
    } finally {
      clearTimeout(timeout);
    }
    cycle += 1;

    const jitter = (Math.random() * 2 - 1) * cycleJitterSeconds * 1000;
    const sleepMs = Math.max(1000, cyclePeriodSeconds * 1000 + jitter);
    // Don't sleep past run end. If the next cycle would push us over,
    // bail now — keeping the per-viewer cycle count predictable in
    // the analysis.
    if (Date.now() + sleepMs >= runEndsAt) break;
    await sleep(sleepMs);
  }
}

function buildUrl({ target, gameId, runStartedAt, replayDurationSeconds }) {
  // Path scheme is per-target so the fork's `/cfb/game/:id` and
  // production's `/game/:id` can be driven from the same harness.
  // `pathTemplate` uses `{gameId}` as the placeholder; defaults to the
  // fork route for back-compat with the A/B/D matrix.
  const template = target.pathTemplate ?? "/cfb/game/{gameId}";
  const u = new URL(template.replace("{gameId}", gameId), target.baseUrl);
  if (target.replay) {
    u.searchParams.set("replay", String(Math.floor(runStartedAt / 1000)));
    u.searchParams.set("replay_duration", String(replayDurationSeconds));
  }
  if (target.arch) {
    u.searchParams.set("arch", target.arch);
  }
  return u.toString();
}

// ----- top-level orchestrator -----

export async function runDriver(userConfig = {}, emitFn) {
  const config = { ...DEFAULT_CONFIG, ...userConfig };
  // Targets and gameIds passed via env or invoker must be JSON-encoded
  // arrays; surface decoding failures here, before the loop starts.
  if (typeof config.targets === "string") config.targets = JSON.parse(config.targets);
  if (typeof config.gameIds === "string") config.gameIds = JSON.parse(config.gameIds);

  const emit = emitFn ?? ((line) => process.stdout.write(JSON.stringify(line) + "\n"));
  const runId = crypto.randomBytes(6).toString("hex");
  const runStartedAt = Date.now();

  emit({
    type: "run_start",
    run_id: runId,
    region: config.region,
    started_at: new Date(runStartedAt).toISOString(),
    started_at_unix_ms: runStartedAt,
    viewer_count: config.viewerCount,
    duration_s: config.runDurationSeconds,
    cycle_period_s: config.cyclePeriodSeconds,
    replay_duration_s: config.replayDurationSeconds,
    targets: config.targets.map((t) => t.label),
    game_ids: config.gameIds,
  });

  const viewers = [];
  for (let i = 0; i < config.viewerCount; i++) {
    const target = config.targets[i % config.targets.length];
    const gameId = config.gameIds[i % config.gameIds.length];
    viewers.push(
      runViewer({
        viewerIndex: i,
        target,
        gameId,
        runConfig: config,
        runStartedAt,
        emit,
      }),
    );
  }
  await Promise.allSettled(viewers);

  emit({
    type: "run_end",
    run_id: runId,
    region: config.region,
    ended_at: new Date(Date.now()).toISOString(),
    duration_actual_s: (Date.now() - runStartedAt) / 1000,
  });

  return { runId, runStartedAt, runEndedAt: Date.now() };
}

// ----- CLI entry -----
// Skipped under Lambda (which imports `runDriver` directly).

const isCliInvocation =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("driver.mjs");

if (isCliInvocation) {
  const cli = {};
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (m) cli[m[1].replace(/-/g, "_")] = m[2];
  }
  const config = {};
  if (cli.region) config.region = cli.region;
  if (cli.viewer_count) config.viewerCount = parseInt(cli.viewer_count, 10);
  if (cli.duration_s) config.runDurationSeconds = parseInt(cli.duration_s, 10);
  if (cli.cycle_s) config.cyclePeriodSeconds = parseInt(cli.cycle_s, 10);
  if (cli.replay_duration_s) config.replayDurationSeconds = parseInt(cli.replay_duration_s, 10);
  if (cli.targets) config.targets = cli.targets;
  if (cli.game_ids) config.gameIds = cli.game_ids;

  runDriver(config).catch((err) => {
    process.stderr.write(`driver crashed: ${err?.stack ?? err}\n`);
    process.exit(1);
  });
}
