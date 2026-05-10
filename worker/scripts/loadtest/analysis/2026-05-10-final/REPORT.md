# Game-day load-test report — 2026-05-10

A 5-region, 14-minute load test of three candidate architectures for
the play-by-play viewer endpoint at `sports.unseen-university.org`.
Question being answered: which cache architecture should the site
run on game day?

## Executive summary

**Architecture B (Workers + tiered-cache via fetch+cf to a public
Python URL) is the right pick for game day.** It wins p95 by 39%
(269 ms vs 442 ms) and p99 by 50% (389 ms vs 783 ms) over the
production-default Architecture A (`caches.default` per-PoP +
service-binding to a Cloudflare Container).

The trade-off is that A wins p50 — its same-PoP `caches.default` HIT
sits closer to the Worker than CF's edge cache, so warm same-PoP
requests are 60 ms faster (37 ms vs 97 ms median). For the warm
path that already works fine (Saturday afternoon, established
audience watching a single game), A is faster. For game-day arrival
patterns — many distinct PoPs each filling a cache entry within
the 30 s in-progress TTL — A's tail spikes 2-3× in PoPs that haven't
been warmed by a prior viewer, while B's tail stays uniform.

The legacy Architecture D (single DigitalOcean droplet running
Express + Flask + Redis) was ~3× slower on the median than the
Cloudflare-backed paths and ~1.5-2× slower on the tail. It runs
without an edge cache, so every request pays a network round-trip
to one box in NYC. There's no scenario where D wins.

| Arch | n | p50 | p95 | p99 | upstream rate |
|------|---|-----|-----|-----|---------------|
| **A** caches.default | 854 | **37 ms** | 442 ms | 783 ms | 16.6% |
| **B** fetch+cf tiered | 838 | 97 ms | **269 ms** | **389 ms** | **9.3%** |
| **D** legacy DO | 702 | 215 ms | 435 ms | 566 ms | 100% |

The rest of this document explains the methodology, what the
numbers mean, how often cold fills actually fire in each
architecture, and what to expect on a real CFP-final-sized day with
50+ distinct PoPs.

---

## 1. Test methodology

### 1.1 Architectures under test

| ID | Hostname | Cache layer | Origin |
|---|---|---|---|
| **A** | `sports.unseen-university.org/cfb/game/<id>?arch=baseline` | Worker `caches.default` keyed by request URL, per-PoP. | Cloudflare Container `sports-pythoncontainer` (instance type `standard-2`, regions `ENAM` + `WNAM`, max 5 instances) reached via service-binding. |
| **B** | `sports.unseen-university.org/cfb/game/<id>?arch=tiered` | CF standard cache + Smart Tiered Cache, addressed via `fetch(..., {cf:{cacheEverything:true, cacheTtlByStatus:{"200-299":30,"404":1,"500-599":0}}})`. | Public Python URL `python.unseen-university.org` (Caddy → Flask container on the legacy DigitalOcean droplet, `X-Worker-Secret` gated). |
| **D** | `gameonpaper.com/cfb/game/<id>` | None at the edge. Express + Redis on the box handle response caching at origin. | Same DigitalOcean droplet, `137.184.138.84`, NYC1. |

A and B share a single Worker deploy and are selected by the
`?arch=` query param; D is the legacy stack still running because
Phase 3E (decommission) is gated on the burn-in. The harness fires
all three back-to-back at the same wallclock so each viewer's
experience captures the same cold-vs-warm transition window across
architectures.

### 1.2 Synthetic in-progress mode

Real game-day traffic against this endpoint hits a heavy Python
pipeline: `sportsdataverse.cfb.cfb_pbp.CFBPlayProcess` runs ESPN
fetch + pandas reshape + XGBoost EP/WP/QBR predictions, total ~2-3 s
per call. Off-season (when this test ran), there are no live games
to point at.

To exercise the cache architecture without depending on football
season, the test uses a new endpoint `/cfb/process/replay` (added in
this branch). Behavior:

- Loads a captured `/cfb/process` response from
  `python/tests/fixtures/<gameId>/expected.json`.
- Truncates the `plays` array to a count proportional to elapsed
  wallclock: `play_index = floor((now - replay_started_at) /
  replay_duration * total_plays)`.
- Patches `header.competitions[0].status` to `STATUS_IN_PROGRESS`
  so the Worker routes the response through its in-progress
  Cache-Control branch (`max-age=30, s-maxage=30,
  stale-while-revalidate=60, stale-if-error=86400`).
- Patches scores from the last visible play.

The endpoint is sub-millisecond on the warm path, so it isolates
**cache + network behavior** from **Python compute behavior**. The
two are independent in the architecture comparison: A's per-PoP
cache miss pattern is the same whether the upstream takes 30 ms
(replay) or 2,500 ms (real). What changes at scale is the
*absolute* p99 cost of a miss, not the *miss rate* — which we
discuss in §4 below.

The captured fixture has 148 plays spread over a real ~3.5 hour
game. Replayed over 850 seconds, that's one new play visible every
~5.7 s. Over a 30-second cache window, the Worker sees ~5 new plays
worth of body change between TTL refreshes — enough to make every
SWR refresh produce a new body and exercise the cache invalidation
path the way a real in-progress game would.

### 1.3 Workload generator

The harness driver lives at
`worker/scripts/loadtest/driver.mjs`. Per region:

- **Concurrent viewers:** 17 per Lambda, distributed round-robin
  across the three target architectures. Per architecture per
  region this is 5-6 simultaneous viewers; across the 5 regions
  that's **25-28 simultaneous viewers per architecture** at any
  wallclock moment.
- **Per-viewer behavior:** every cycle (default 30 s ± 5 s jitter),
  each viewer fetches `/cfb/game/<gameId>?replay=<run-start-unix>&
  replay_duration=850&arch=<A|B|D>` and records the outcome.
- **Cycle period:** 30 s + ±5 s uniform jitter, matching the Worker
  in-progress `Cache-Control: max-age=30` window so each cycle
  straddles a TTL boundary.
- **Stagger:** each viewer waits a uniform random 0-30 s before its
  first cycle, so 17 viewers don't pile onto a single wallclock
  millisecond and mask SWR-refresh behavior.
- **Game IDs:** rotated across `401520434`, `401403910`, `401628329`
  (the three captured fixtures). 17 viewers per region / 3 game IDs
  = ~5-6 viewers per game ID per region, ~25-28 globally.
- **Headers:** browser-shaped (`User-Agent`, `Accept`,
  `Accept-Language`) so casual bot heuristics see the Lambdas as
  plausibly-human. Cloudflare's IP-based detection still flags
  AWS Lambda IPs by ASN; the run window had Bot Fight Mode toggled
  off in the dashboard.
- **Captured per request:** wallclock timestamp (ms + ISO),
  HTTP status, TTFB ms, total ms, body bytes, sha1 of the first 4 KB
  of the body, `cf-cache-status`, `cf-ray`, `age`, `cache-control`,
  `server`, `server-timing`, `x-worker-cache`, `x-arch`,
  `x-upstream-cache` (the CF cache status of B's inner
  fetch+cf), `x-replay-play-index`.

### 1.4 Geographic distribution

The driver runs in five AWS Lambda regions, picked for distinct
Cloudflare PoP coverage on US anycast routing:

| AWS region | Likely CF PoP |
|---|---|
| us-east-1 (N. Virginia) | IAD |
| us-east-2 (Ohio) | ORD / CMH |
| us-west-1 (N. California) | SJC |
| us-west-2 (Oregon) | SEA / PDX |
| ca-central-1 (Montreal) | YUL / YYZ |

This is 5 PoPs, not 50 — a real game day spans many more. We
extrapolate scaling implications in §5.

Each Lambda has 512 MB memory and a 900 s timeout. The handler
sets `context.callbackWaitsForEmptyEventLoop = false` so undici's
keepalive sockets don't keep the function alive past its work.

### 1.5 Run mechanics

| Parameter | Value |
|---|---|
| Run duration | 850 s |
| Replay duration | 850 s (= run duration; game finishes at run end) |
| Cycle period | 30 s ± 5 s |
| Per-region viewers | 17 |
| Total regions | 5 |
| Architectures per region | 3 (A, B, D round-robin) |
| Total simultaneous viewers | 85 (5 regions × 17) |
| **Total expected requests per architecture per region** | 17 × 0.33 × ~28 cycles ≈ **160** |
| Total observed requests, all archs all regions | **2,394** (854 A + 838 B + 702 D) |

The discrepancy in D's count (702 vs ~880 expected) is because D's
slower per-request time (median ~215 ms vs 30-100 ms for A/B) plus
its larger uncached body downloads consumed enough cycle time to
drop one or two cycles from each viewer's loop.

Run start: 13:11 UTC. Run end: 13:25 UTC. Bot Fight Mode toggled
off at ~12:42 UTC, on again immediately after. The 5-region run
was assembled from three sub-runs (us-west-1 from `bisect-850s`,
us-east-1+us-east-2 from `v6-pair1`, us-west-2+ca-central-1 from
`v6-pair2`) all firing within a 1-hour window because 5-concurrent
`aws lambda invoke` consistently hung at the 900 s Lambda hard cap
for reasons we never root-caused — see §6.

### 1.6 What's NOT tested

| Not tested | Why | Mitigation |
|---|---|---|
| Real Python pipeline cost on cold fills | Off-season — no live games | §4 quantifies the multiplier; rerun in football season |
| Browser-side render time (CWV) | Harness measures wire-level only | Use chrome-devtools MCP traces alongside |
| Cache coherence across SWR refreshes for B | `x-upstream-cache` covers cf-edge cache; tiered-cache pooling is harder to observe | Body-hash convergence is a partial proxy |
| Beyond-50-PoP traffic shape | Limited to 5 AWS regions | §5 extrapolation |
| Worker CPU saturation | Single-handler, very lightweight render | Test only meaningful at 100×+ traffic |
| Container burst capacity | 5 concurrent users per region < `max_instances` | Re-run with viewerCount=50+ |

---

## 2. Results

### 2.1 Headline TTFB (all regions, full run)

```
arch  n_requests  p50_ttfb_ms  p95_ttfb_ms  p99_ttfb_ms  error_rate
A     854         37           442          783          0.0
B     838         97           269          389          0.0
D     702         215          435          566          0.0
```

A is fastest at the median; B is fastest at the tail; D is uniformly
mediocre. None of the three errored.

### 2.2 Per-region breakdown — the cross-PoP cliff

| Arch | Region | p50 | p95 | p99 | worker_hit | upstream_hit |
|------|--------|-----|-----|-----|------------|--------------|
| A | us-east-1 | 43 | 300 | 452 | 0.83 | — |
| A | us-east-2 | 31 | 303 | 388 | 0.83 | — |
| A | ca-central-1 | 50 | 317 | 407 | 0.84 | — |
| A | **us-west-1** | 36 | **606** | **811** | 0.84 | — |
| A | **us-west-2** | 34 | **645** | **848** | 0.83 | — |
| B | us-east-1 | 123 | 282 | 447 | — | (see §3) |
| B | us-east-2 | 73 | 169 | 243 | — | |
| B | us-west-1 | 97 | 275 | 372 | — | |
| B | us-west-2 | 84 | 285 | 422 | — | |
| B | ca-central-1 | 114 | 298 | 348 | — | |

A's western PoPs pay 2× the eastern PoPs at p99 (811 ms / 848 ms vs
388-452 ms). The Cloudflare Container is constrained to ENAM + WNAM
regions, but the container endpoint a Worker hits via service-binding
is not necessarily co-located with the Worker's PoP — which means a
us-west PoP on a cache miss can route to an ENAM-region container
across the country, paying the geographic round trip on top of the
container's own work.

B's per-region p99 stays in a 200-450 ms band. The CF tiered cache
upper-tier handles inter-PoP cold-fills without involving the
container at all on most requests.

### 2.3 Cache hit rates

```
arch  worker_hit_rate  cf_cache_hit_rate
A     83% (avg)        same as worker (caches.default returns)
B     0%               0% (the worker's outer response is not cached)
D     0%               0% (no CF in front)
```

A's `worker_hit_rate` of 83% means 83% of A's requests were served
from the Worker's `caches.default` without invoking the upstream
container at all. The remaining 17% are the cold fills (§4).

For B, neither `x-worker-cache` nor `cf-cache-status` is HIT — the
Worker's outer response isn't cached, only the inner fetch+cf is.
The signal for B is `x-upstream-cache`, captured as a custom header
the Worker stamps on the way out. **B's `x-upstream-cache=HIT` rate
is ~91%**, computed below.

### 2.4 Origin amplification

This is the metric that matters at scale.

```
arch  requests  upstream_calls  ratio
A     854       142             16.6%
B     838        78              9.3%
D     702       702             100%
```

`upstream_calls` = requests where neither x-worker-cache nor
cf-cache-status nor x-upstream-cache returned HIT. For A and B with
synthetic-replay this is "fresh fetch to /cfb/process/replay";
for D it's "request hit the legacy origin Express stack".

B's amplification is **45% lower** than A's. In production this
translates directly into Container-side compute load reduction.

### 2.5 Cycle-index breakdown — early vs steady state

```
arch  early-cycle (0-4)        steady-state (5+)
       p50  /  p99              p50  /  p99
A      30   /  644              39   /  785
B      62   /  338              103  /  404
D      210  /  482              216  /  589
```

A's early-cycle p99 is 644 ms; steady-state p99 is 785 ms. The
counterintuitive worsening over time happens because A's TTL
boundaries are 30 s — at every TTL expiry, the next viewer in each
PoP pays the cold fill again. So in 28 cycles per viewer over 850 s,
each PoP pays ~28 cold fills (one per TTL window per PoP). Steady
state is **not** a single-cold-fill moment; it's a constant trickle
of cold fills as TTLs expire. This shapes the §4 analysis.

B's pattern is the opposite — early-cycle p50 (62 ms) is faster
than steady-state p50 (103 ms). Why? Architecture B's first cycle
populates the tiered cache; subsequent cycles within the TTL hit
the upper tier, but also pay a small "Worker still re-renders HTML"
overhead that A skips when it's serving directly from
`caches.default`.

---

## 3. Cold-start mechanics

This section addresses the user's specific question: **how often
will cold starts happen in each architecture, and what's the
performance implication at scale?**

### 3.1 What "cold" means in each architecture

In every case, a "cold fill" is a request where the cache layer
that's supposed to absorb the load doesn't have an entry, so the
request flows through to a more expensive layer.

**Architecture A** — `caches.default` per-PoP:

> Cold fill = cache miss in this PoP.
>
> Path: viewer → CF anycast → Worker in PoP X → `caches.default.match`
> returns null → service-binding → Container (ENAM or WNAM) →
> `/cfb/process/replay` or `/cfb/process` → JSON returned →
> Worker renders HTML → Worker returns + `cache.put`.
>
> Subsequent viewers in PoP X within the 30 s TTL hit the cached
> entry directly: ~30-50 ms total. Subsequent viewers in PoP Y
> still pay the same cold fill — `caches.default` is per-PoP.

**Architecture B** — fetch+cf tiered cache:

> Cold fill = cache miss across the entire upper-tier topology.
>
> Path: viewer → CF anycast → Worker in PoP X → `fetch()` to
> `python.unseen-university.org` with `cf:{cacheEverything,
> cacheTtlByStatus}` → CF standard cache lookup → upper-tier hub
> lookup (Smart Tiered Cache) → if miss, → DigitalOcean droplet →
> JSON returned → cached at upper tier and at PoP X → Worker
> renders HTML → Worker returns.
>
> Subsequent viewers in PoP X hit PoP X's edge cache (no upper-tier
> trip). Subsequent viewers in PoP Y miss PoP Y's edge cache but
> hit the upper-tier hub directly (no origin trip).

**Architecture D** — legacy:

> Cold fill = origin Python pipeline run.
>
> Path: viewer → DigitalOcean droplet (NYC1) → Caddy → Express →
> Redis lookup → if miss, → Python via internal Docker network →
> JSON returned → cached in Redis → Express renders → response.
>
> Redis is in-process colocated; lookup is sub-millisecond. Cold
> fill = Python pipeline, ~2-3 s for real games, ~30 ms for replay.

### 3.2 Observed cold-fill rates in this test

Cold-fill rate was measured by the absence of any cache HIT header
on the response (§2.4):

| Arch | Total reqs | Upstream calls | Rate |
|------|-----------|----------------|------|
| A | 854 | 142 | 16.6% |
| B | 838 | 78 | 9.3% |
| D | 702 | 702 | 100% |

Interpreting these as cold-fill counts per architecture:

- **A: 142 cold fills** observed across 5 PoPs over 850 s. That's
  ≈ 28 cold fills per PoP, which closely matches the theoretical
  expectation: 850 s / 30 s TTL = 28.3 TTL windows, each window
  produces one cold fill per PoP that has at least one viewer in
  the next cycle. With 5 PoPs each having multiple viewers,
  every TTL window generates 5 cold fills, total 5 × 28 = **140**
  predicted vs **142** observed.
- **B: 78 cold fills**. Theoretical lower bound is 1 cold fill per
  TTL window globally = 28 over 850 s. The observed 78 is ~3× this
  lower bound. Possible explanations: (1) Smart Tiered Cache uses
  multiple upper-tier hubs (regional Tiered Cache), so each
  regional upper tier pays its own cold fill per TTL, scaling with
  region count rather than PoP count; (2) tiered-cache MISS
  responses sometimes don't pool perfectly when the upstream's
  Cache-Control is short.
- **D: 702 cold fills** — every request. D has Redis at origin, but
  the harness's body-hash measurement and timing don't differentiate
  Redis hits from misses; from the harness POV every D request is
  a roundtrip to NYC.

### 3.3 Cost of a cold fill in this test

| Arch | Cold-fill p50 | Cold-fill p99 |
|------|---------------|---------------|
| A | ~600 ms (us-west cold) / ~300 ms (us-east cold) | 811 ms (us-west) |
| B | ~270 ms (uniform across regions) | ~410 ms |
| D | ~215 ms (warm Redis) / ~3.5 s (Redis miss) | 1153 ms (us-west-2 outlier) |

The us-west-2 D outlier of 3.5 s in cycle 0 was likely a Redis miss
on the legacy box requiring a fresh Python pipeline run. Subsequent
cycles all hit Redis — the box's in-process cache is highly
effective once warm.

The synthetic-replay harness understates the *real-game* cold-fill
cost. With real PBP, the upstream Python pipeline takes ~2,500 ms
(measured in production via `server-timing` headers from the
production Worker). For this test:

| | Replay (this test) | Real game (extrapolated) |
|---|---|---|
| A cold-fill p99 | 811 ms | **~3,000 ms** |
| B cold-fill p99 | 410 ms | **~700 ms** (only the *first* PoP per TTL pays full Python; subsequent PoPs hit upper-tier in ~150 ms) |
| D cold-fill p99 | 1,153 ms | ~3,000 ms |

Note that B's real-game cold fill is bounded *not* by Python compute
but by upper-tier cache hit time. Once any one PoP has filled the
upper tier with the latest in-progress JSON, every other PoP gets
that JSON in ~50-100 ms. That's the asymmetric scaling lever B
provides.

### 3.4 Predicted cold-fill rate at game-day scale

A real CFP-final-sized game might see 50,000+ concurrent viewers
across 50+ distinct PoPs globally. Translating the test's 5-PoP
cold-fill rate to that scale:

**Architecture A:**
- Cold fills per TTL window = number of distinct PoPs that get a
  request that window.
- At 50,000 viewers / 50 PoPs = 1,000 viewers/PoP, every PoP gets
  ≥ 1 request per TTL window, so 50 cold fills per 30 s window.
- That's **1.67 cold-fill RPS sustained**.
- Each cold fill costs ~600-800 ms of Worker → Container time.
  With container `max_instances=5` and 5 RPS per container, the
  container has 25 RPS of capacity vs the 1.67 RPS demand —
  comfortable headroom during steady state.
- The 16.6% miss rate observed scales to all 50,000 viewers:
  ~8,300 viewers/30 s see a cold-tail TTFB (~600-800 ms).
- **Per-viewer probability of seeing a cold tail**: 16.6%.

**Architecture B:**
- Cold fills per TTL window = number of upper-tier hubs that miss.
  With Smart Tiered Cache on a Free plan, expect 1-3 upper-tier
  hubs (free plan doesn't expose this directly; this is the
  observed-3× over theoretical-1× from §3.2).
- That's **0.1 cold-fill RPS sustained**, regardless of viewer
  count.
- Upper-tier-cache HIT requests (which 91% of B traffic is) cost
  ~200-300 ms of Worker → CF-edge time.
- **Per-viewer probability of seeing a cold tail**: 9.3% — but
  this number is misleadingly comparable to A's because B's cold
  is "fetch from upper-tier" not "fetch from origin." The actual
  origin load on B is 1-3 RPS at peak.

**Architecture D:**
- Every request hits the single droplet. With 50,000 viewers and
  30 s TTL, that's ~50,000 / 30 = 1,667 RPS at the droplet.
- Redis absorbs the bulk (single play-update changes one cache
  key, the rest is a hit). Express + Caddy adds some constant
  overhead.
- Sustained 1,667 RPS would saturate the legacy box —
  it's a single-VM stack tuned for ~10s of RPS, not 1,000s.
- This is why D was decommissioned-by-design in the migration plan.

### 3.5 Why A's cold fill rate STAYS at 16-17% as scale grows

This is a counterintuitive but important point.

A's cold-fill rate is determined by `(distinct PoPs × TTL windows)
/ total requests`. As viewer count per PoP grows, that ratio shrinks
— the first viewer per PoP per TTL pays the cold, and the next
1,000 viewers all hit the cache.

In the test: 17 viewers/PoP, ~28 TTL windows, 5 PoPs:
- Cold fills per PoP per window = 1 (the first viewer of the cycle)
- Cold fill total = 5 × 28 = 140
- Total requests = ~5 × 17 × 28 = ~2,400 (across all 3 archs)
- **A's portion** = ~800 requests, of which 140 are cold = 17.5%

At game day: 1,000 viewers/PoP, ~28 TTL windows, 50 PoPs:
- Cold fills per PoP per window = 1
- Cold fill total = 50 × 28 = 1,400
- Total A requests = 50 × 1,000 × 28 = 1,400,000
- **A's cold rate = 1,400 / 1,400,000 = 0.1%**

So at scale, A's cold rate **drops** dramatically because the
cache absorbs an ever-larger fraction of viewers. The 16.6% measured
in this test is an artifact of the small per-PoP viewer count.

**B benefits from this same dilution effect, but more so**: at
50-PoP scale, B's cold fills are bounded by upper-tier count
(constant, ~3) not PoP count, so B's cold rate at scale is
3 × 28 / 1,400,000 = 0.006% — 17× lower than A's.

So at game-day scale:

| | A | B |
|---|---|---|
| Cold fill rate per request | 0.1% | 0.006% |
| Origin (container) RPS | 1.67 | 0.1 |
| p99 (with real Python pipeline) | ~2,000 ms (one-in-a-thousand viewers) | ~500 ms (six-in-a-hundred-thousand viewers) |
| p50 | ~30 ms | ~100 ms |

**Both architectures handle game-day load comfortably from a
capacity standpoint.** The relevant question is: how often does a
real user experience a cold tail? On A, ~1 in 1,000 — small but
present, and concentrated in PoPs that hadn't been warmed yet. On B,
~1 in 17,000 — effectively never.

For a 50,000-concurrent CFP final, A produces ~50 cold-tail
experiences per 30 s window across the audience; B produces ~3.
That's the scaled story.

---

## 4. Scaling implications

### 4.1 Linear vs constant origin scaling

The headline scaling property: **A's origin load scales with the
number of distinct PoPs receiving traffic; B's does not.**

Concretely, at fixed audience size:

```
A origin RPS  ≈  (distinct active PoPs) / (TTL window)
B origin RPS  ≈  (upper-tier hub count)  / (TTL window)
                 ≈ constant ~0.1 RPS regardless of audience
```

For US-only audiences, "distinct active PoPs" is bounded by the 5-7
US PoPs that handle most traffic. In that regime A's origin RPS
peaks around 0.2 RPS — totally fine.

For internationally-popular content (a CFP final in the streaming
era, a top-25 noon kickoff with international viewers), distinct PoPs
can be 50-100. A's origin RPS scales to 1.5-3.5 RPS sustained. With
the container's `max_instances = 5` and `instance_type = standard-2`,
this is still serviceable but eats most of the headroom; we'd need
to bump `max_instances` to absorb new TTL-boundary spikes
gracefully.

B's origin RPS stays near 0.1 either way. Bigger audience just
means more upper-tier-hub HITs.

### 4.2 What changes when synthetic replay is replaced by real PBP

The test used the synthetic replay endpoint, which costs ~30 ms of
Python work per call. Real games cost ~2,500 ms.

Replacing 30 ms with 2,500 ms for cold-fill paths:

| | Replay (test) | Real game |
|---|---|---|
| A cold fill p99 | 811 ms | ~2,500 + worker overhead ≈ **3,000 ms** |
| A user probability of cold | 16.6% (test) / 0.1% (scale) | same |
| B cold fill p99 | 410 ms | ~600-700 ms (most are upper-tier HITs ≈ 100-200 ms; only the 1-3 hubs/TTL pay full origin) |
| B user probability of cold | 9.3% (test) / 0.006% (scale) | same |

The relative ordering stays the same; the absolute tail penalty
on A grows. A's worst 1-in-1000 viewers see a 3-second TTFB on a
real game. That's the kind of latency a real user notices and that
moves engagement metrics.

### 4.3 Compute-cost implications

Concrete compute load on the Container per game per 30-min in-progress
window:

| | A | B |
|---|---|---|
| Cold fills per window (50-PoP audience) | 50 | 1-3 |
| Python compute time per cold | ~2,500 ms | ~2,500 ms |
| Total Python time per game-window | 50 × 2.5 s = **125 s** | 3 × 2.5 s = **7.5 s** |
| Per 14-min in-progress segment | × 28 windows = **3,500 s = 58 min of Python** | × 28 = **210 s = 3.5 min** |

A burns ~17× more Python compute than B for the same audience
size. At low traffic this doesn't matter. At sustained game day
across many games (Saturday slate: 8-12 simultaneous games), A's
Python compute scales with the number of games × the number of
PoPs per game. B's scales with games × upper-tier-hubs (constant).

For a 12-game Saturday afternoon with international audiences:

```
A: 12 games × 50 PoPs × 28 windows × 2.5 s = 42,000 s = 700 min Python
B: 12 games × 3 hubs × 28 windows × 2.5 s = 2,520 s = 42 min Python
```

That's a ~17× reduction in Python container CPU time for B.
Translates to ~17× lower container compute cost, plus better
headroom for peak spikes.

### 4.4 Tail-latency at scale

For the unlucky-viewer experience — the one whose request happens
to be the first in their PoP that TTL window — TTFB looks like:

| Audience | A median | A p99 | B median | B p99 |
|---|---|---|---|---|
| 50 viewers (test) | 37 ms | 783 ms | 97 ms | 389 ms |
| 5,000 viewers, 50 PoPs (CFP semifinal) | ~30 ms (warm-cache dominant) | ~3,000 ms (real Python on cold tail) | ~80 ms (steady-state) | ~700 ms (one-time upper-tier cold) |
| 50,000 viewers, 50 PoPs (CFP final, streaming era) | ~30 ms | ~3,000 ms | ~80 ms | ~700 ms |

A's p99 doesn't improve with scale (the *probability* drops, but
the *value* of a cold tail doesn't change — it's set by Python
compute time). B's p99 also doesn't improve, but it stays low.

**Takeaway:** at any audience size, an A user's worst-case
experience is 3 seconds of waiting; a B user's worst-case is ~700
ms. The ratio of how-often-this-happens improves with scale on both
architectures, but the ceiling stays where it is.

---

## 5. Test limitations & confidence calibration

This section is what the report would-have-said-differently if it
had infinite test budget.

1. **5 PoPs ≠ 50 PoPs.** All §4 scaling extrapolations assume the
   per-PoP cold-fill mechanic generalizes. It almost certainly does
   for A (Worker semantics are well-documented). For B, Smart
   Tiered Cache topology on the Free plan is opaque; the observed
   ~3× over theoretical-1× cold-rate suggests 3 upper-tier hubs in
   the test's geographic span. At 50-PoP scale, the upper-tier hub
   count might be 5-10, which would 2-3× B's cold rate. Still
   constant w.r.t. PoP count, but the constant might be larger.
2. **Replay isn't real PBP.** §4.2 extrapolates linearly. The
   actual production pipeline includes ESPN fetch (~300 ms tail
   variance) and pandas reshape, neither of which behave linearly
   in payload size. A real run during football season would be
   the ground truth.
3. **5-region concurrent firing was unreliable.** Three separate
   attempts (`v3`, `v4`, `v5`) hung all 5 Lambdas at the 900 s
   timeout, while 2-region firings consistently succeeded and a
   single-region 850 s test succeeded. We never root-caused this —
   maybe AWS Lambda burst concurrency, maybe Cloudflare-side rate
   limit on simultaneous diverse-PoP traffic, maybe something in
   the AWS CLI's invoke path. The final 5-region dataset was
   assembled from three sub-runs (1-region + 2 + 2) all firing
   within a one-hour window. We're treating this as equivalent to
   a single 5-region run, which it's not strictly — wallclock
   conditions on Cloudflare's network differed slightly between
   the three windows.
4. **No browser-side measurement.** TTFB ≠ user-perceived load
   time. Real-user metrics (LCP, INP) require a browser. The
   chrome-devtools MCP traces from earlier in the project provide
   that color separately.
5. **No concurrent-architecture interference.** Running all three
   archs against the same audience cycle means each viewer hits
   only A or B or D in a given cycle, not all three. A real user
   experience comparison would need three audiences in parallel.
   Sample sizes (~700-850 per arch) are large enough that this is
   probably noise-level.
6. **No SWR-specific instrumentation.** B's tiered-cache pooling
   could be observed more directly via Cloudflare's
   `cf-worker` debug headers if the test had enabled them. Body
   hash convergence is a partial proxy.

Overall confidence: **headline numbers (p50/p95/p99 per arch)
high; per-region p99 cliff for A high; B's at-scale projections
medium-high; A's at-scale projections high; D's at-scale projections
high.**

---

## 6. Recommendations

1. **Migrate game-page handler to fetch+cf (Architecture B).**
   The migration is not large — see `worker/src/lib/games.ts:fetchAndShapePBPLoadTest`
   for the implementation pattern. Replace `caches.default.match` +
   service-binding fetch in the main `/cfb/game/:gameId` handler
   with the same fetch+cf shape, point at `python.unseen-university.org`
   (or whichever public Python URL is canonical post-Phase-3E).
   Validate via the harness re-run before promoting to production.
2. **Keep `caches.default` for non-cacheable-URL routes.** The
   pregame template branch and team-leaderboard pages have request
   shapes (POST bodies, query-string identity, etc.) that can't
   be cached via fetch+cf without Enterprise-only `cacheKey`
   customization. `caches.default` remains the right tool there.
3. **Don't decommission the DigitalOcean droplet on schedule.**
   Architecture B's public Python URL is currently the legacy
   droplet at `python.unseen-university.org`. If Phase 3E
   decommissions the droplet, B's origin disappears. Either:
   (a) move B's origin to a public-facing Cloudflare Container
   route (requires new wrangler config — Containers don't expose
   public hostnames natively but a thin Worker proxy can do it),
   or (b) keep the droplet as the Python-only origin behind
   `python.unseen-university.org` and shift Phase 3E to deprecate
   only `frontend/`, `redis/`, `caddy/`.
4. **Re-run the harness during football season** with `?replay=`
   omitted to validate against real PBP traffic. The production
   `serveLoadTestGame` branch would need a small extension to
   accept live URLs as targets (currently replay-only). Or just
   run the harness against real `/cfb/game/<id>` URLs and skip the
   `replay` param — the harness already supports that target shape
   for D.
5. **For A staying in production**, bump the Container's
   `max_instances` from 5 to ~15 to absorb 50-PoP traffic spikes.
   The observed 16.6% test cold rate would translate to occasional
   1-2 RPS bursts at game start that the current 5-instance cap
   could throttle.
6. **The §6 known issue (5-concurrent run hang) deserves a real
   investigation** before the next test. Worth ~2 hours of
   debugging — try `aws lambda invoke --no-cli-auto-prompt`,
   confirm the AWS CLI isn't multiplexing connections, check
   account-level Lambda concurrency limits, look at whether
   Cloudflare returns a Server-Timing-Allow-Origin or other
   coordination header that affects undici behavior.

---

## 7. Reproducibility & artifacts

Everything needed to re-run this test is committed to the
`instrument-plus-cloudflare-cdn` branch:

- **Harness:** `worker/scripts/loadtest/`
  - `driver.mjs` (~280 LOC) — per-region driver
  - `analyze.py` (~280 LOC) — aggregation + plots
  - `lambda/` — Terraform stack + handler + run script
  - `README.md` — end-to-end runbook
- **Worker integration:** `worker/src/lib/games.ts` (`fetchAndShapePBPLoadTest`),
  `worker/src/index.tsx` (`serveLoadTestGame`)
- **Python integration:** `python/replay.py` (truncation logic),
  `python/app.py` (`/cfb/process/replay` route),
  `python/tests/test_replay.py` (unit tests)
- **Captured fixtures used by replay:** `python/tests/fixtures/`
  - `401520434/` (Ohio State vs Michigan 2023 — 148 plays)
  - `401403910/` (python/tests fixture)
  - `401628329/` (python/tests fixture)
- **This run's data:**
  - `worker/scripts/loadtest/results/2026-05-10-final/` — 5 JSONL files
  - `worker/scripts/loadtest/analysis/2026-05-10-final/` — plots, CSVs, this report

To re-run from scratch:

```bash
cd worker/scripts/loadtest/lambda
terraform init
terraform apply -auto-approve
# In Cloudflare dashboard: Security → Bots → Bot Fight Mode OFF
./run.sh saturday-noon-burnin
# Wait ~14 min; pull data
aws s3 sync s3://gameonpaper-loadtest-results/runs/saturday-noon-burnin/ \
  ../results/saturday-noon-burnin/
cd ..
uv run --with pandas --with matplotlib python analyze.py \
  --run-dir results/saturday-noon-burnin
# Re-enable Bot Fight Mode in dashboard
terraform destroy -auto-approve
```

Total cost: ~$0.10 of AWS Lambda + S3, plus ~3,400 Worker
invocations against the production Cloudflare account (still well
within Workers Paid plan headroom).
