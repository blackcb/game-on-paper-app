#!/usr/bin/env node
// Cold-start perception probe for /cfb/game/:gameId.
//
// Lighthouse CI (frontend/lighthouserc.json) measures full-page load
// across LCP/FCP/CLS/Speed Index — but it runs 3× in burst against
// the same URL, so all 3 hits land warm. That misses the exact thing
// the 2026-05-09 cold-start mask is meant to hide: the *first* user
// landing on a game page after a Cloudflare-Container resume.
//
// This probe complements LHCI by measuring the user-visible TTFB
// across cache states the LHCI burst never reaches:
//   - "miss" path:  unique cache-buster → caches.default MISS →
//                   Worker → Container → Python. Captures the cold-
//                   resume tail when sleepAfter has expired.
//   - "hit"  path:  same URL repeated → caches.default HIT (or
//                   REVALIDATED if SWR fires). The dominant
//                   user-perceived case post-edge-population.
//
// Output columns:
//   ttfb        wall-clock from fetch start to response headers
//   total       wall-clock through body read
//   python      `python;dur=N` from Server-Timing (origin only;
//                cache hits return the cached origin value)
//   cf-cache    response cf-cache-status (HIT / MISS / EXPIRED / -)
//
// Usage:
//   node worker/scripts/perf-coldstart.mjs              # default URLs
//   node worker/scripts/perf-coldstart.mjs <id> [...]   # custom IDs
//   BASE_URL=https://staging.example node ...           # custom host

import { performance } from "node:perf_hooks";

const BASE_URL =
  process.env.BASE_URL ?? "https://sports.unseen-university.org";

// Mix of game IDs from prior baselines. Duplicates intentional —
// the per-iteration cache-buster keeps each request a fresh MISS,
// and re-running the same gameId measures variance in the Python
// pipeline cost across runs (different game = different play count
// → different DataFrame size).
const DEFAULT_GAME_IDS = [
  "401520434", // 3D cutover smoke (completed)
  "401403910", // python/tests fixture (completed)
  "401520222", // 3D schema-drift observation (completed)
  "401520434",
  "401403910",
];

const gameIds =
  process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_GAME_IDS;

async function probe(url) {
  const t0 = performance.now();
  const res = await fetch(url);
  const tHeaders = performance.now();
  const body = await res.text();
  const tTotal = performance.now();
  return {
    status: res.status,
    ttfb: Math.round(tHeaders - t0),
    total: Math.round(tTotal - t0),
    cfCache: res.headers.get("cf-cache-status") ?? "-",
    serverTiming: res.headers.get("server-timing") ?? "-",
    bytes: body.length,
  };
}

function parsePython(serverTiming) {
  // Example: "espn_pbp;dur=99, python;dur=2064, render;dur=0, total;dur=2174"
  const m = /python;dur=(\d+(?:\.\d+)?)/.exec(serverTiming);
  return m ? Math.round(parseFloat(m[1])) : null;
}

const cacheBuster = `_perf=${Date.now().toString(36)}`;

console.log(`probing ${BASE_URL} with ${gameIds.length} game IDs`);
console.log();
console.log(
  "  #  game-id    state  cf-cache    ttfb       total      python     bytes",
);
console.log(
  "  -- ---------- ------ ---------- ---------- ---------- ---------- ------",
);

const rows = [];
for (let i = 0; i < gameIds.length; i++) {
  const id = gameIds[i];
  const url = `${BASE_URL}/cfb/game/${id}?${cacheBuster}-${i}`;
  const miss = await probe(url);
  const hit = await probe(url);
  rows.push({ id, miss, hit });

  for (const [state, p] of [
    ["miss", miss],
    ["hit", hit],
  ]) {
    const py = parsePython(p.serverTiming);
    console.log(
      `  ${String(i + 1).padStart(2)} ${id.padEnd(10)} ${state.padEnd(6)} ` +
        `${p.cfCache.padEnd(10)} ${(p.ttfb + "ms").padStart(8)}   ` +
        `${(p.total + "ms").padStart(7)}    ${
          py != null ? (py + "ms").padStart(7) : "      -"
        }    ${String(p.bytes).padStart(6)}`,
    );
  }
}

function pct(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

const misses = rows.map((r) => r.miss.ttfb);
const hits = rows.map((r) => r.hit.ttfb);
const pythons = rows.map((r) => parsePython(r.miss.serverTiming)).filter((x) => x != null);

console.log();
console.log("distribution:");
console.log(
  `  miss-path TTFB:    p50=${pct(misses, 50)}ms  p95=${pct(misses, 95)}ms  max=${Math.max(...misses)}ms`,
);
console.log(
  `  hit-path  TTFB:    p50=${pct(hits, 50)}ms  p95=${pct(hits, 95)}ms  max=${Math.max(...hits)}ms`,
);
if (pythons.length > 0) {
  console.log(
    `  Python container:  p50=${pct(pythons, 50)}ms  p95=${pct(pythons, 95)}ms  max=${Math.max(...pythons)}ms`,
  );
}

// A miss with python;dur near or above 10s is the cold-resume signal.
const coldHits = rows.filter((r) => {
  const py = parsePython(r.miss.serverTiming);
  return py != null && py >= 10000;
});
if (coldHits.length > 0) {
  console.log();
  console.log(
    `  ⚠ ${coldHits.length} hit(s) with python;dur ≥ 10s — likely cold-resume`,
  );
  console.log(
    `    pre-mask baseline (3D cutover): 14–19s. Cold-start mask should drop this.`,
  );
}
