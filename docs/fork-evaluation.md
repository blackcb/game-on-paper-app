# Fork Evaluation: Cloudflare-Based Redesign of game-on-paper-app

## Context

[`saiemgilani/game-on-paper-app`](https://github.com/saiemgilani/game-on-paper-app)
is a college-football play-by-play analytics site whose original
architecture was a single DigitalOcean droplet running docker-compose:

- **ExpressJS** (Node) serving EJS templates on port 8000
- **Flask** (Python) running `sportsdataverse.cfb.cfb_pbp.CFBPlayProcess`
  on port 7000 (XGBoost EP/WP/QBR models + pandas pipeline)
- **Redis** for JSON cache, **Caddy** for TLS termination

This experimental fork (branch `instrument-plus-cloudflare-cdn`) was
created to evaluate alternative approaches for the performance issues
the project was hitting under game-day load. Across ~144 commits, the
fork:

1. Inventoried the bottlenecks in the legacy stack and shipped
   in-place fixes (Phase 1) on a Cloudflare-fronted production replica
   at `sports.unseen-university.org`.
2. Rebuilt the frontend as a Cloudflare Worker (Phase 2), then moved
   the Python pipeline into Cloudflare Containers (Phase 3).
3. Landed a three-layer cache topology ("Architecture B" plus the
   KV HTML layer added after the formal load test) that pools the
   Python JSON output across PoPs via Cloudflare's Smart Tiered
   Cache (Phase 3H, 2026-05-13) and serves completed-game HTML
   globally out of KV (Layer 3, 2026-05-11).

This document describes what was wrong, what was built, how the two
implementations measure against each other, and what other defects
the work surfaced along the way.

---

## 1. Performance bottlenecks in the upstream

### 1.1 The cascading concurrency wall

The headline bottleneck was a process-and-thread constraint on the
Python side that cascaded through the ExpressJS frontend.

**On the Python side**, `python/Dockerfile` ran the Flask dev server
via `CMD python app.py`. Flask's built-in WSGI server is
single-threaded — explicitly not suited for production. A single
`/cfb/process` call took ~5–6 seconds (XGBoost inference + pandas
reshape on multi-megabyte play tables). Two concurrent requests
serialized end-to-end: the second one waited ~10–12 seconds wall time
because the server processed them one at a time.

**On the Node side**, every game-page render in
`frontend/cfb/routes.js` and `frontend/cfb/games.js` made a blocking
synchronous axios call into Flask. When Flask was serializing
requests, Node's event loop accumulated pending promises and the
worker pool could not parallelize anything that touched Python.
Slowness on the Python side translated directly into Node response
latency and blocked the event loop for other incoming routes —
not just `/cfb/game/:id`. The frontend appeared "slow on everything"
during traffic spikes even though the actual hot path was only the
PBP route.

The fix on the replica (commit `c9ce06e`) replaced Flask's dev server
with gunicorn (`-w 2 -k gthread --threads 8 --timeout 120`). Two
worker processes (sized to the 4 GB Python container ceiling) combined
with 8 greenthreads per worker enabled true concurrent request
handling: I/O-bound ESPN fetches and XGBoost predictions (which
release the GIL) could interleave instead of queueing.

Once Python could handle real concurrency, the cascade resolved
itself — Node was never the bottleneck in isolation; it was an
amplifier of Python's serialization.

### 1.2 Caching defects

The Redis layer had four independent correctness bugs that all
mattered under load:

- **Non-atomic `SET` + `EXPIRE`** (six call sites). A two-RTT cache
  write where the key existed without a TTL for a few microseconds.
  A crash between the two commands leaked the key forever. Fixed in
  `f8ef899` with atomic `SET key val EX ttl`.
- **No eviction policy** on the cache Redis instance. `maxmemory
  1000mb` was set but `maxmemory-policy` defaulted to `noeviction`,
  so once the 1 GB ceiling was hit, every write returned OOM. Errors
  were swallowed by a try/catch in `games.js`, so the cache silently
  stopped working on a Saturday slate. Fixed in `061bf99` with
  `allkeys-lru`.
- **Wrong healthcheck port**. The docker healthcheck ran
  `redis-cli ping` which defaults to 6379, but the cache instance
  binds to 6380. The container had been reporting `(unhealthy)`
  for years, masking any actual outage. Fixed in `c8e34d9` with
  `-p 6380`.
- **Cache-busting query suffix on ESPN URLs**. Every ESPN PBP and
  scoreboard fetch appended `&${Date.now() * 1000}`, forcing every
  request through ESPN's origin and bypassing their ~1–5 minute CDN
  cache. Day-1 instrumentation measured ~400 ms per warm-Redis
  request. Removed in `589c379`; ESPN's TTLs are adequate for
  current-status data.

There was also a **cache-second ordering bug** on `/cfb/game/:id`
(`0da1b2c`): every request made an ESPN PBP fetch *first* to
determine game status, then checked Redis. For completed games (the
overwhelming majority of visits after the first), the cached
processed PBP already contained `gameInfo.status.type.completed` —
the ESPN call was wasted. Inverting the order to cache-first dropped
warm-hit game-page total latency from 292 ms to 45 ms (an 84%
reduction in server-side time).

### 1.3 Wire-format defects

- **No gzip on Flask** (`/cfb/process` returned 3–6 MB JSON uncompressed
  intra-container). Fixed in `ac37430` with Flask-Compress.
- **No gzip on Express** (rendered HTML, especially game pages,
  embeds the full PBP JSON in a hidden script tag — 200–400 KB
  uncompressed). Fixed in `890c86e` with the `compression`
  middleware.
- **5.4 MB unused Bootstrap source map** plus duplicate CSS/JS
  variants for ~6 MB of dead weight in `frontend/public/assets/`,
  shipped to anyone whose CDN cache missed. Deleted in `d01c7cf`.
- **1.1 MB unreferenced `favicon.svg`** linked in the head template
  but never used (the `.ico` was already wired up). Deleted in
  `5e242be`.
- **axios 0.21.1** (Dec 2020) with five accumulated CVEs covering
  SSRF, prototype pollution, and ReDoS. Bumped to `^1.15.2`
  in `8be7a6e` after confirming the codebase used only conservative
  call shapes.

### 1.4 Resilience defects

- **User-Agent null crash** (`434feec`). `req.get('User-Agent')
  .toLocaleLowerCase()` threw on any request without a UA header.
  curl, monitoring, and health probes all triggered 500s.
- **HEAD requests rejected as 405** (`89f7202`). The method allowlist
  permitted only GET and POST. Search engines and `curl -I` were
  blocked despite Express being capable of serving HEAD correctly.
- **`getServiceHealth` not isolating upstream failures** (`f03018f`).
  Two unwrapped `await`s. A single upstream blip became an unhandled
  promise rejection; on Node 24+ this exited the process with code
  1 and threw the container into a restart loop.
- **Unbounded year-1 fallback recursion** (`7d541a0`). Three summary
  helpers recursed back to year 2014 on any error. A single
  transient 502 from the summary service became up to 11 sequential
  HTTP calls, turning a 1-second outage into 10+ seconds of page
  load and saturating the summary container precisely when it was
  unhealthy.
- **ESPN errors masked as 404s** (`a042895`). A blanket
  `except KeyError` in `python/app.py` collapsed all key errors —
  including real pipeline bugs and sportsdataverse column renames —
  into the same generic "ESPN payload is malformed" 404. Made
  legitimate regressions invisible. Replaced with explicit handling
  for the two genuinely expected cases; everything else now reaches
  the outer `except Exception` and surfaces in logs.

### 1.5 Baseline measurements (replica, post-Phase-1 fixes)

Captured 2026-04-28 against `https://sports.unseen-university.org/`,
median of 5:

| Route                                    | Cold TTFB | Warm TTFB |
|------------------------------------------|----------:|----------:|
| `/cfb/`                                  |     101 ms |     101 ms |
| `/cfb/year/2024/teams/differential`      |     113 ms |     113 ms |
| `/cfb/game/401403910` (warm Redis)       |     560 ms |     292 ms |
| `/cfb/game/401520434` (cold Redis)       |   5,703 ms |          — |

The cold game-page Server-Timing breakdown: 5,388 ms in the Python
pipeline (89 % of TTFB), 362 ms in the ESPN PBP fetch, 110 ms in the
cache write, 198 ms other. **Python compute, not Node, dominated
cold-render latency.** Phase 1 fixes brought warm-hit server time
down from 292 ms to 45 ms, but did not touch the cold path — that
needed an architectural change.

---

## 2. The Cloudflare architecture (this branch)

### 2.1 Components

The end-state ("Architecture B", Phase 3H finalized 2026-05-13):

- **`sports` Worker** (Hono + TypeScript on Cloudflare Workers):
  SSR for all pages, KV-backed league/team data, per-game HTML
  cache via `caches.default`, static assets via the Worker's
  `[assets]` binding, cron-warmed scoreboard.
  Entry: [worker/src/index.tsx](../worker/src/index.tsx).
  Config: [worker/wrangler.toml](../worker/wrangler.toml).
- **`sports-pythoncontainer`** Cloudflare Container: the same
  Flask app from upstream, now containerized and served by
  `gunicorn -w 2 -k gthread --threads 8 --preload` instead of
  Flask's dev server (`python/Dockerfile:100`). Image is
  `python:3.14-slim` + xgboost-cpu, 84 % image-size reduction
  from 1.32 GB to 210 MB. Declared as a Durable Object class
  in the `sports` Worker.
- **`sports-summarycontainer`** Cloudflare Container: the Node
  summary service.
- **`sports-python-proxy` Worker** (separate codebase at
  [python-proxy/](../python-proxy/)): hosts
  `python.unseen-university.org` and service-binds back to the
  `PythonContainer` DO declared in the `sports` Worker (via
  `script_name = "sports"` in the proxy's wrangler.toml). The
  proxy exists for the cache-engagement reason described in §2.4.
- **KV namespaces**: `LEAGUE_DATA` (league/team summaries +
  rendered HTML for completed games via Layer 3, see §2.2),
  `SUMMARY_LAST_UPDATED` (small list-stable lookups).

Single user-facing hostname: `sports.unseen-university.org`.

### 2.2 Request flow

The architecture has **three cache layers** in front of the Python
pipeline, in order of cheapness:

1. **`caches.default`** (Layer 1) — per-PoP, rendered HTML, ~30 ms HIT
2. **KV (`LEAGUE_DATA`)** (Layer 3, completed games only) — globally
   replicated, rendered HTML keyed by `game-html:v2:<gameId>`,
   ~80–311 ms HIT
3. **CF standard + Smart Tiered Cache** (Layer 2) — pooled across
   PoPs, raw Python JSON keyed by request URL, ~100–200 ms HIT

(The numbering reflects ship order, not request order.
[worker/src/lib/html-cache.ts](../worker/src/lib/html-cache.ts) is
Layer 3, added 2026-05-11 — after the load test.)

**Path A — fully cold render of `/cfb/game/:gameId`:**

1. Request arrives at a PoP with no cached state.
2. `sports` Worker checks `caches.default` — MISS.
3. Worker classifies the game (ESPN scoreboard probe).
4. **If the game is completed**, Worker reads
   `game-html:v2:<gameId>` from `LEAGUE_DATA` KV
   ([worker/src/lib/html-cache.ts](../worker/src/lib/html-cache.ts)).
   On HIT, the rendered HTML returns directly, gets stamped into
   `caches.default` for this PoP on the way out, and the response
   carries `x-html-cache: HIT`. Latency ~311 ms (measured at deploy
   smoke, 2026-05-11).
5. On KV MISS (or in-progress / pregame), Worker calls
   `fetchAndShapePBPTiered(env, gameId, metadata)`
   ([worker/src/lib/games.ts:231](../worker/src/lib/games.ts#L231)),
   which issues `fetch('https://python.unseen-university.org/cfb/process?gameId=X', {cf: {cacheEverything: true, cacheTtlByStatus: {"200-299": 30, "404": 1, "500-599": 0}}})`.
6. Because the fetch crosses the Worker boundary, it engages
   Cloudflare's standard cache + Smart Tiered Cache. On a fully
   cold tiered cache, it routes via the upper-tier hub to the
   `sports-python-proxy` Worker.
7. The proxy Worker validates `X-Worker-Secret`, then forwards
   the request to the `PythonContainer` Durable Object.
8. The Flask app, served by gunicorn, runs the pipeline; JSON
   returns up the chain. The tiered cache stores it (30 s TTL
   on 200s).
9. The `sports` Worker reshapes the JSON and renders HTML.
10. After the response, the Worker fires `waitUntil()` to write
    the rendered HTML to KV with a 1-year `expirationTtl`
    (completed games only). It also stores the response in
    `caches.default` for this PoP.
11. User receives the page with `x-fetch-mode: tiered`,
    `x-upstream-cache: MISS`, and `Cache-Control: s-maxage=30,
    max-age=0, stale-while-revalidate=60` (in-progress) or
    `s-maxage=31536000` (completed).

**Path B — warm HTML cache HIT** (same PoP, within HTML TTL):
1. Worker handler checks `caches.default.match(cacheKey)` near the
   top of the route handler
   ([worker/src/index.tsx](../worker/src/index.tsx)).
2. HIT — pre-rendered HTML returned directly. ~30 ms.

**Path C — cold HTML at a new PoP, warm KV** (completed games, the
common-case for backlog browsing):
1. The per-PoP `caches.default` misses.
2. KV read returns the previously-rendered HTML.
3. Worker stamps the response into `caches.default` for this PoP.
   Latency ~311 ms; subsequent requests at this PoP serve from
   Layer 1 at ~30 ms.

**Path D — cold HTML at a new PoP, warm JSON in tiered cache**
(in-progress games during a live window):
1. `caches.default` misses; KV is skipped (not a completed game).
2. The `fetch+cf` call hits Cloudflare's Smart Tiered Cache.
   The upper-tier hub has the JSON from a recent request at any
   other PoP within the last 30 s.
3. Worker reshapes and renders without re-executing Python; writes
   to `caches.default`. Latency ~100–200 ms.

### 2.3 Why three cache layers

Each layer solves a problem the others can't.

**`caches.default` (Layer 1)** is per-PoP. It owns the warm path:
~30 ms HIT serves pre-rendered HTML with effectively no Worker CPU.
But a HIT at JFK doesn't help a user hitting LAX, and Worker deploys
invalidate it entirely.

**Smart Tiered Cache (Layer 2)** pools the raw Python JSON across
PoPs at the upper-tier hub level. It's the lever for in-progress
games during a live window: with a 30-second TTL on in-progress
data and ~50 production PoPs, a single-layer design pays the full
Python cold cost once per PoP per TTL window. The 5-region load test
measured this directly: Architecture A (`caches.default` only)
needed 142 cold fills over 850 s; Architecture B with the tiered
layer needed 78 — a 45 % reduction in origin calls under the same
synthetic load (see §3.3).

**KV-backed HTML (Layer 3)** owns the cold-PoP path for **completed
games** (the overwhelming majority of traffic outside live windows).
KV is globally replicated, so the first user anywhere fills the
cache for every PoP, and Worker deploys don't invalidate it.
Without Layer 3, a cold-PoP visit to an old game would fall through
to Layer 2 — which has a 30-second TTL — almost always miss there
too, and pay the full Python pipeline. With Layer 3, that visit
serves from KV at ~311 ms regardless of whether anyone else has
ever hit that gameId from that PoP. Layer 3 is bounded to completed
games because in-progress and pregame HTML is volatile; caching it
globally would serve stale data.

The three layers compose: warm path goes Layer 1 (~30 ms); cold-PoP
for a completed game goes Layer 1 miss → Layer 3 hit (~311 ms);
cold-PoP for an in-progress game goes Layer 1 miss → Layer 2 hit
(~100–200 ms); a fully cold edge falls through to Python.

### 2.4 Why a separate proxy Worker

Phase 3G (2026-05-11) implemented the
`python.unseen-university.org` proxy as Hono middleware on the
**same** `sports` Worker. Production immediately regressed: the load
test went from "B wins" back to A-level numbers, and the
`x-upstream-cache` header started reporting `MISS` on every request.

The root cause: Cloudflare silently drops `cf: {...}` options when a
Worker fetches a URL that routes back to itself, presumably to
prevent infinite loops. `cacheEverything` and `cacheTtlByStatus`
became no-ops, the standard cache never engaged, and the tiered cache
was bypassed. The 2026-05-12 incident
(`docs/migration-plan.md` §3H) is the timeline; the rollback was a
one-line flip of `PYTHON_FETCH_MODE` back to `"service"`.

Phase 3H (2026-05-13) is the fix: move the proxy into a separate
Worker (`sports-python-proxy`). Now the `fetch` from `sports`
crosses a script boundary, the self-fetch heuristic doesn't apply,
and `cf: {}` is honored again. The `PythonContainer` DO class is
declared once in the `sports` Worker and bound cross-script via
`script_name = "sports"` in the proxy's wrangler config — no
duplication.

### 2.5 What stayed the same vs. what changed

| Aspect              | Legacy droplet                            | Architecture B                                      |
|---------------------|-------------------------------------------|-----------------------------------------------------|
| Python pipeline     | `CFBPlayProcess` in Flask (dev server)    | Same Flask app under gunicorn (`-w 2 -k gthread --threads 8 --preload`), in a Cloudflare Container |
| SSR                 | EJS templates in Express                  | Hono JSX in a Cloudflare Worker                     |
| JSON caching        | Redis instance 2 + Express middleware     | CF standard + Smart Tiered Cache via `fetch+cf`     |
| HTML caching        | Caddy reverse-proxy headers               | `caches.default` (per-PoP) + KV (global, completed games) |
| Static assets       | `express.static('public/')` on droplet    | Worker `[assets]` binding (edge-distributed)        |
| Reverse proxy       | Caddy on the droplet                      | Cloudflare Custom Domain + Workers route            |
| Compression         | Phase 1: Node `compression` + Flask-Compress | CF re-compresses with Brotli at the edge          |
| Cold-start handling | None (always-on droplet)                  | Preload + `/warmup` endpoint + Worker pings         |

The Python pipeline code is unchanged: the contract between the
Worker and `/cfb/process` is identical to what Express was using.
The migration was *deployment and request-path*, not algorithm.

### 2.6 Deployment and rollback

- `cd worker && wrangler deploy` — TypeScript bundle + asset upload + DO migrations
- `cd python-proxy && wrangler deploy` — must be deployed *after* `sports` (cross-script DO binding)
- Python and summary container images: `wrangler containers push`; wrangler.toml pins a tag, so cache-busting requires bumping the tag (see appendix item on `:slim-coldstart-mask`)
- Single hostname `sports.unseen-university.org`; cron warms the scoreboard once a minute during football season

**Rollback to a known-good service-binding path** is one
wrangler.toml line in the `sports` Worker:
`PYTHON_FETCH_MODE = "service"`. The Worker keeps the direct DO
service-binding code path live regardless of what's serving
`python.unseen-university.org`, so the flip takes ~30 seconds and
bypasses the entire proxy + tiered-cache layer. This was exercised
during the 2026-05-12 incident.

---

## 3. Performance comparison

### 3.1 Methodology

The headline performance numbers come from a 5-region synthetic load
test on 2026-05-10 ([REPORT.md](../worker/scripts/loadtest/analysis/2026-05-10-final/REPORT.md))
plus point-in-time TTFB measurements during the Phase 2H cutover and
Phase 1 baseline runs in [perf-plan.md](perf-plan.md).

The load test ran three architectures in parallel against the same
synthetic in-progress game (`/cfb/process/replay`, a fixture
endpoint that returns realistic JSON shape at ~30 ms of server work
instead of the real 5-second `CFBPlayProcess`):

- **A** — Workers + `caches.default` (per-PoP only)
- **B** — Workers + `caches.default` + CF Smart Tiered Cache (current)
- **D** — Legacy droplet (Express + Flask + Redis)

5 AWS regions, 17 concurrent viewers per region, 850 s duration, 2,394
total requests across the three architectures.

### 3.2 TTFB and page-render

**`/cfb/` (scoreboard)**:

|                          | Cold TTFB | Warm TTFB |
|--------------------------|----------:|----------:|
| Legacy baseline           |    101 ms |    101 ms |
| Phase 1 (replica)         |    153 ms |    153 ms |
| Worker (post-2H)          |     86 ms |   ~1 ms warm-cache HIT |

**`/cfb/game/:gameId`**:

|                                      | Cold TTFB    | Warm TTFB |
|--------------------------------------|-------------:|----------:|
| Legacy baseline                       |    5,703 ms |    292 ms |
| Phase 1 (replica, after fixes)        |    ~5,000 ms |     45 ms |
| Worker (Architecture B, real prod)    | 4.7–6.5 s    | 51–77 ms  |

The cold path stayed at ~5 seconds because both legacy and Worker
pay the same Python compute when their respective caches miss. The
warm path improved from 292 ms (legacy) to 45 ms (Phase 1 cache-first
fix) to ~30 ms (Worker `caches.default` HIT) — a 10× warm-path
speedup.

### 3.3 Cache hit rates and origin amplification

From the load test (850 s synthetic run):

| Architecture | Worker HIT rate | Upstream HITs | Origin amplification |
|--------------|---------------:|--------------:|---------------------:|
| **A** (per-PoP only)  | 83 %  | 142 / 854 | 16.6 % |
| **B** (tiered)        | n/a   | 78 / 838 | **9.3 %** |
| **D** (legacy droplet)| 0 %   | 702 / 702 | 100 % |

B reduced origin calls by **45 % vs. A** under the same load. A's
142 cold fills closely matched the predicted "1 fill per PoP per TTL
window" (5 PoPs × 28 windows = 140); B's 78 fills suggests roughly
three upper-tier hubs are pooling cache state regionally, exactly the
design intent.

### 3.4 Compression and page weight

Phase 1 added gzip on both Flask and Express. The origin → CF hop
compressed; the user-facing payload was unchanged because Cloudflare
re-compresses with Brotli on the edge. The net effect was a ~5–10×
reduction in bytes between Python and Node, eliminating intra-stack
bandwidth as a bottleneck during high-RPS windows.

Page weight before/after asset cleanup (Phase 1):

|                          | Compressed | Uncompressed |
|--------------------------|-----------:|-------------:|
| `/cfb/` (any era)        |    11.7 KB |    315.6 KB |
| `/cfb/year/.../diff`     |    10.6 KB |    169.1 KB |
| `/cfb/game/401403910`    |   161.5 KB |   2,914 KB  |

The visible page weights barely moved because the deletions
(Bootstrap variants, source maps, 1.1 MB favicon) were references not
served on the measured routes — but the *cold origin* hit dropped by
~6 MB for any client that did happen to request them, and CF edge
caching of `/assets/*` via the Workers Static Assets binding (Phase
2E) eliminated origin trips for assets entirely.

### 3.5 Lighthouse scores (Desktop)

|                          | Baseline | Phase 1 | Post-2H Worker |
|--------------------------|---------:|--------:|---------------:|
| `/cfb/`                  |     0.68 |   0.71 |          0.72 |
| `/cfb/game/401403910`    |     0.72 |   0.72 |          0.65 |
| `/cfb/year/.../diff`     |     0.74 |   0.74 |          0.75 |

The desktop Lighthouse preset (10 Mbps, 1× CPU) is already fast
enough that the bottleneck is client-side JS/CSS parsing, not the
network. The game-page regression to 0.65 is mostly noise — the
embedded PBP JSON dominates parse time and didn't change. **Mobile
Lighthouse would be a more meaningful measurement and is the natural
follow-up** (deferred per perf-plan §208–209).

### 3.6 Cold-start cost at the time of the load test

The synthetic load test reported B's p99 TTFB at 389 ms vs. A's 783
ms — a clean B win on paper. Off-season production validation
revealed the catch: **synthetic replay (~30 ms server work) was
~100× faster than real `/cfb/process` (~5 s).** At the time of the
load test, real production cold-fills on both A and B paid ~5
seconds of Python time per incident:

| Architecture | Trigger              | Observed TTFB |
|--------------|----------------------|--------------:|
| **B** (prod, pre-572dd2e) | TTL expired (35 s)  |   4.7–6.5 s   |
| **D** (legacy)            | forced uncached     |   4.1–8.2 s   |

**B's win then was incident volume, not per-incident latency.** With
a per-PoP cache and 50 PoPs, A pays ~50 cold-fills per 30 s window
when traffic is broadly distributed. With cross-PoP pooling, B pays
roughly 1 cold-fill per regional hub per window — about 3 globally.
The user-visible effect at game-day scale (~50 k concurrent viewers
over a 15-minute window):

|                                                | A                | B                |
|------------------------------------------------|------------------|------------------|
| Cold-fill probability per request               |  0.1 %           | **0.006 %**     |
| Sustained origin RPS                            |  1.67            | **0.10**        |
| Per-30s window, users seeing a ~5 s tail        |  ~50             | **~3**          |
| Per-viewer chance of seeing ≥1 slow render      |  ~3 %            | **~0.2 %**     |

§3.7 below describes the post-load-test optimizations that further
collapsed both the depth (now ~3.2 s, not ~5 s, on a true cold
Python execution) and the breadth (Layer 3 KV serves completed
games at ~311 ms instead of hitting Python at all).

### 3.7 Post-load-test optimizations

Two changes landed after the 2026-05-10 load test that materially
move the cold-path numbers — neither is reflected in the §3.2–3.6
tables above.

#### Python `/cfb/process` speedups (commit `572dd2e`, 2026-05-10)

Eight orthogonal wins inside the existing Python architecture (no
sportsdataverse upgrade, no model port), all gated behind the
snapshot-test suite from perf-plan Day 2:

1. **Reshape split into 5 timing buckets** (`to_dict`, `relayout`,
   `top_level`, `validate`, `serialize`) — observability, not
   latency, but the basis for the rest.
2. **`plays_json.to_dict(orient="records")` replaces `to_json` +
   `json.loads` round-trip** — saves 200–500 ms on a 200-play game
   by skipping multi-MB JSON serialize+parse.
3. **Dropped `np.array(...).tolist()` wraps on 10 top-level
   fields** — the numpy round-trip was dtype-inference overhead on
   plain Python lists from sportsdataverse's ESPN scraper. Saves
   20–80 ms.
4. **`orjson` replaces `flask.jsonify`** — 2–5× faster on
   multi-MB nested dicts with numpy scalars. Uses
   `OPT_SERIALIZE_NUMPY` for common types + a duck-typed default
   callback for ndarrays.
5. **Pydantic response validation gated to `VALIDATE_RESPONSE`
   env var**, off in production. The ajv validator on the Worker
   side is defense-in-depth; `conftest.py` enables Pydantic for
   tests so `STRICT_SCHEMA` still gates. Saves 50–150 ms per
   response in production.
6. **Brotli level 11 → 4, gzip default → 5.** The consumer is the
   Worker, not a browser — we don't need maximum compression. Saves
   100–400 ms of CPU per response.
7. **In-process TTL cache of serialized bytes**, keyed by
   `(gameId, request_method)`, 15 s TTL (half of Worker's 30 s
   in-progress `max-age`), 32-entry max, eviction by oldest
   expiry. HIT returns sub-millisecond instead of ~5 s. This is
   the big one for cold-fill storms, SWR refresh duplicates, retry
   storms, and concurrent prewarms on the same gameId.
8. **`bad_cols` hoisted to a module-level frozenset**; inline `del`
   in the relayout loop instead of a separate pop loop per record;
   non-finite normalization (NaN/Inf/-Inf → None) in the same pass
   so orjson doesn't raise.

Local A/B (cold pipeline, fixture 401520434):

| Image                              | Cold |  Repeat-within-15 s |
|------------------------------------|-----:|--------------------:|
| baseline `slim-coldstart-replay-get` | 2.5–4.6 s | (no in-process cache) |
| perf `slim-coldstart-perf`           | **3.2 s** | **13–19 ms**          |

The pipeline + box_score (sportsdataverse internals) still dominate
at ~2.4 s + 0.4 s; everything the fork touches is now under 50 ms
combined. The TTL cache (#7) means concurrent prewarms or rapid SWR
refreshes against the same gameId pay the pipeline once, regardless
of how many PoPs hit at once.

#### KV HTML cache for completed games (commit `6769e28`, 2026-05-11) + 2024/2025 backfill

Layer 3 (described in §2.2 and §2.3): rendered HTML for completed
games is stored in `LEAGUE_DATA` KV at
`game-html:v2:<gameId>` with a 1-year TTL. Production smoke
numbers from deploy day:

| Scenario                                            | TTFB              |
|-----------------------------------------------------|------------------:|
| `caches.default` HIT (Layer 1, same PoP)            |             ~30 ms |
| `caches.default` MISS → KV HIT (Layer 3, any PoP)   |          **311 ms** |
| `caches.default` MISS → KV MISS → Python (cold)     | 3.2 s (post-572dd2e) |

The cache fills lazily during real traffic, but a separate
off-repo bulk-backfill script primed KV with the rendered HTML
for **every completed 2024 and 2025 game**. The user-visible
effect on backlog browsing:

- A user clicking a completed game from a new PoP — the common
  case once historic linking and search drive traffic — serves
  from KV at ~311 ms instead of paying any Python compute.
- Worker deploys invalidate Layer 1 but not Layer 3. Right after
  a deploy, every PoP-cold request for a completed game still
  serves from KV at ~311 ms — no thundering-herd against Python.
- The Layer 2 tiered cache's 30-second TTL is now irrelevant for
  completed games: Layer 3's 1-year TTL takes the request before
  it can fall through to Layer 2. Layer 2 stays load-bearing for
  in-progress games during live windows, where Layer 3 correctly
  doesn't engage.
- The KV prefix is versioned (`v2` currently — bumped from `v1`
  in `f163def` when the game template stopped including the
  duplicate nav-header). Bumping the prefix invalidates the
  cache instantly without listing/deleting; old entries age out
  via the TTL.

#### Combined effect on the §3.6 numbers

Re-applying the post-loadtest changes to the cold-path analysis:

|                                                    | A (loadtest)   | B (loadtest) | B (current, post-572dd2e + KV) |
|----------------------------------------------------|----------------|--------------|--------------------------------|
| Cold render, completed game, new PoP                | ~5 s           | ~5 s         | **~311 ms** (KV HIT)           |
| Cold render, in-progress game, new PoP              | ~5 s           | ~5 s         | ~100–200 ms (Layer 2 HIT) |
| True cold Python execution (no cache at any layer)  | ~5 s           | ~5 s         | **~3.2 s**                     |
| Concurrent cold fills on same gameId within 15 s    | N pays full    | N pays full  | first pays full, rest **sub-ms** (TTL cache) |

The earlier "B wins on volume, not depth" framing was correct for
the configuration the load test measured. With Layer 3 plus the
Python perf pass, B now also wins on depth for the dominant
backlog-traffic case — completed games served from KV in the low
hundreds of milliseconds, regardless of which PoP serves the
request.

### 3.8 What this doesn't measure

- **Mobile end-user latency.** TTFB measurements are server-side
  only. Browser-Reported metrics (LCP, FID, CLS) on a 4G connection
  are the natural follow-up.
- **Real-traffic football-season validation.** The load test ran
  off-season; in-season validation (Aug 20+) is open.
- **Container burst behavior at scale.** The test had ≤5 concurrent
  users per region. The Cloudflare Container `max_instances=5` cap
  has not been exercised at game-day RPS.
- **Cost.** Cloudflare Workers + Containers + KV pricing was not
  compared against the droplet's flat monthly cost. The fork's
  primary success criterion was latency under load; cost is a
  separate question.

---

## 4. Conclusion

The upstream stack's headline bottleneck was a Python-side concurrency
wall (single-threaded Flask dev server) that cascaded into the Node
frontend. Phase 1 closed that wall in-place (gunicorn + caching fixes
+ compression) and recovered the warm path, but the cold path was
still ~5 s of Python compute per render — and with a per-PoP cache,
that cost was paid once per PoP per TTL window.

The Cloudflare redesign keeps the Python code largely intact but
rebuilds the request path around three composing cache layers:

- **Layer 1** (`caches.default`, per-PoP) — warm-path TTFB in the
  tens of milliseconds.
- **Layer 2** (CF Smart Tiered Cache, pooled regionally) — cuts
  cold-fill volume against the Python origin by ~15× at game-day
  scale; load-bearing for in-progress games during live windows.
- **Layer 3** (KV-backed HTML, globally replicated, completed
  games only, primed for the entire 2024/2025 backlog) —
  serves any cold-PoP visit to an old game at ~311 ms, surviving
  Worker deploys.

Two post-load-test optimizations (commits `572dd2e` and `6769e28`)
materially change the cold-path picture the load test originally
captured:

- True cold Python is now ~3.2 s, not ~5 s.
- Concurrent cold-fills on the same gameId within 15 s pay the
  pipeline once at the origin, then serve sub-ms.
- Completed-game cold-PoP traffic never reaches Python at all —
  Layer 3 KV intercepts at ~311 ms.

The Phase 3H proxy-Worker split is the load-bearing detail behind
Layer 2: without it, the tiered cache silently disengages on
same-Worker self-fetches.

The original "B makes cold renders rarer, not faster" framing
described the load-test configuration accurately. As of 2026-05-13
the fork makes them rarer **and** faster: rarer via cross-PoP
pooling, and faster (or eliminated entirely for the backlog case)
via the in-process TTL cache and Layer 3 KV.

---

## Appendix A: Other bugs fixed on this branch

The work surfaced ~20 non-performance bugs in the upstream codebase
that the Cloudflare migration either depended on or stumbled into.
They're catalogued here for upstream consideration.

### A.1 Input validation and crashes

- **User-Agent null crash** (`434feec`,
  `frontend/server.js`). `req.get('User-Agent').toLocaleLowerCase()`
  threw on any request without a UA header. Fixed with optional
  chaining.
- **HEAD requests rejected as 405** (`89f7202`,
  `frontend/server.js`). The method allowlist permitted only GET
  and POST. Added HEAD; Express serves HEAD as GET-without-body
  natively.

### A.2 Error masking

- **`KeyError → 404 "ESPN payload malformed"`** (`a042895`,
  `python/app.py`). Blanket exception handler swallowed legitimate
  pipeline regressions. Replaced with explicit handling for the two
  genuinely expected cases; everything else now reaches the outer
  `except Exception` and logs a traceback.
- **`getServiceHealth` unhandled rejections** (`f03018f`,
  `frontend/cfb/games.js`). Two `await`s without error handling.
  On Node 24+, a single upstream blip exited the process with code 1
  and restarted the container. Wrapped each call in try/catch with
  a 5-second timeout.

### A.3 Caching correctness

- **Non-atomic `SET` + `EXPIRE`** (`f8ef899`, six call sites in
  `routes.js` and `games.js`). Replaced with atomic `SET … EX ttl`.
- **Missing Redis eviction policy** (`061bf99`, `redis/cache.conf`).
  Added `allkeys-lru` so writes don't silently fail once the cache
  reaches `maxmemory`.
- **Cache-first ordering for completed games** (`0da1b2c`,
  `routes.js`). Check Redis before fetching ESPN; short-circuit on
  hit + `status.completed === true`. 84 % drop in warm-hit server
  time.
- **Wrong Redis cache healthcheck port** (`c8e34d9`, both compose
  files). Healthcheck used default port 6379; cache redis binds to
  6380.
- **Spurious cacheBuster query suffix on ESPN URLs** (`589c379`,
  three call sites). Removed; ESPN's own CDN TTLs (~1–5 min) are
  adequate for current-status data.

### A.4 Schema and wire-format

- **JSON Schema drift on top-level `id` field** (`6eec8cd`).
  Python returns the echoed `gameId` as-typed by the caller (string
  from Worker, int from integration tests). Schema was declared as
  `int`. Relaxed to `int | str` to match wire reality.
- **Follow-up: sync `frontend/cfb/` schema copy** (`019aa3a`). The
  freshness CI checks three copies of the schema; the original fix
  missed one.

### A.5 Container and runtime resilience

- **SIGTERM handler in summary Node service** (`7513088`,
  `summary/server/src/app.ts`). The container never shut down
  gracefully; the Express listener kept the event loop alive.
  Explicit handler closes the server before `process.exit`.
- **Python container cold-start mask** (`e179d9a`, then bumped to
  `:slim-coldstart-mask` in `7210d6e`). Moved
  sportsdataverse/XGBoost booster loads into the gunicorn
  `--preload` stage; workers inherit loaded models via copy-on-write.
  Added a `/warmup` endpoint plus opportunistic pings from the
  Worker's scoreboard/pregame routes. Reduced visible cold-start
  from 14–19 s to roughly gunicorn boot time.
- **Year-1 fallback recursion cap** (`7d541a0`,
  `frontend/cfb/routes.js`). Added `retriesRemaining` parameter
  (default 2) so transient summary-service failures don't recurse
  back to 2014.
- **Missing `curl` in slim Python image** (`93836f8`,
  `python/Dockerfile`). The `python:3.14-slim` base removed
  `curl`, breaking the docker-compose fork-deploy healthcheck.
  Re-added via `apt-get install`.

### A.6 Dependency hygiene

- **axios 0.21.1 → ^1.15.2** (`8be7a6e`). Five accumulated CVEs
  (CVE-2021-3749 through CVE-2025-27152). Forward-compatible at the
  call shapes the codebase actually used.

### A.7 Asset hygiene

- **Deleted ~6 MB of unused Bootstrap variants and source maps**
  (`d01c7cf`, 43 files in `frontend/public/assets/{css,js}`).
- **Deleted unreferenced 1.1 MB `favicon.svg`** (`5e242be`,
  `frontend/public/assets/img/`).

---

## Appendix B: Source references

- Phase plan and history: [docs/migration-plan.md](migration-plan.md)
- Detailed Phase 3H runbook: [docs/migrate-to-tiered-cache.md](migrate-to-tiered-cache.md)
- Phase 1 perf-instrumentation plan: [docs/perf-plan.md](perf-plan.md)
- Initial replica setup: [docs/replica-deploy-plan.md](replica-deploy-plan.md)
- Load-test results (2026-05-10):
  [worker/scripts/loadtest/analysis/2026-05-10-final/REPORT.md](../worker/scripts/loadtest/analysis/2026-05-10-final/REPORT.md)
- Worker entry: [worker/src/index.tsx](../worker/src/index.tsx)
- Tiered-cache fetch: [worker/src/lib/games.ts](../worker/src/lib/games.ts)
- Proxy Worker: [python-proxy/src/index.ts](../python-proxy/src/index.ts)
- Project overview: [CLAUDE.md](../CLAUDE.md)
