# Game-day load-test report — 2026-05-10

A 5-region, 14-minute load test of three candidate architectures for
the play-by-play viewer endpoint at `sports.unseen-university.org`.
Question being answered: which cache architecture should the site
run on game day?

> **Amendment 2026-05-10 (post-cutover)**: production observation
> at off-season click rates revealed that the original framing
> oversold B's tail latency. The synthetic-replay endpoint used in
> the test costs ~30 ms of server work per cold-fill; the real
> `/cfb/process` Python pipeline costs ~4-5 s. With sustained
> harness load the JSON cache stayed warm and per-incident cold
> cost rarely materialized in the numbers; with real off-season
> click traffic the cache TTL expires between clicks and each
> "cold" user clicks through a full ~5 s Python run. **B and A and
> D all pay roughly the same ~5 s per cold-fill incident; B's win
> is that it has fewer cold-fill incidents per unit time at game-
> day scale, not that each incident is cheaper.** See §3.6 for the
> off-season validation data and revised conclusion; the
> Executive Summary, §4.4, and §6 have been updated in place. The
> original synthetic-load data (§2, §3.1-3.5) is retained intact
> because it correctly characterizes the cache-architecture
> behavior — it just doesn't translate linearly to user-perceived
> tail latency on real PBP.

## Executive summary

**Architecture B (Workers + tiered-cache via fetch+cf to a public
Python URL) is the right pick for game day.** Not because each
cold-fill is cheaper — they aren't; A and B and D all pay roughly
the same ~5 s per real-PBP cold-fill — but because B has many
fewer cold-fills per TTL window globally. At a 50,000-viewer / 50-
PoP audience, B produces ~1 user/30s seeing the cold tail vs A's
~50 users/30s.

The synthetic-load test below measured **cache-architecture
efficiency**, not real-PBP tail latency. With the replay endpoint
(~30 ms server work per cold-fill) and sustained 17-viewer load
keeping caches warm, B's measured p99 came in at 389 ms — but that
number doesn't translate to production. With real PBP and off-season
click traffic (one click every few minutes, no warming load), each
cold-fill incident costs ~5 s of Python compute on **any** of the
three architectures. See §3.6 for the off-season validation that
established this.

The test data below correctly characterizes the cache-layer
behavior (hit rates, origin amplification, per-PoP cold-fill
distribution). It does not predict the per-user p99 a real viewer
will see — for that, the load-test methodology would need to drop
the `?replay=` param and pay real Python compute cost, which the
harness was designed to skip.

The trade-off vs A: A wins p50 on the test (`caches.default` HIT is
closer to the Worker than CF's edge cache; 37 ms vs 97 ms median).
A also has a ~1 s lower per-cold-fill cost in production because the
service binding to the Container doesn't have the extra "Worker →
CF edge → public Python URL → droplet" hop B introduces. A loses on
**volume** of cold-fills at scale: A pays once per PoP per TTL
window, B pays once globally per TTL window.

The legacy Architecture D (single DigitalOcean droplet running
Express + Flask + Redis) had test p50 215 ms / p99 566 ms. In live
off-season clicking, D's cold-fills are ~4 s vs B's ~5 s — D's
shorter network path wins by ~1 s when both pay the Python cost.
But D has no edge cache, so every user-distinct PoP request pays
that cost; D scales linearly with audience size, not with PoP
count.

| Arch | test n | test p50 | test p99 | live cold-fill (real PBP) | upstream rate (test) |
|------|--------|----------|----------|----------------------------|----------------------|
| **A** caches.default | 854 | **37 ms** | 783 ms | ~5 s | 16.6% |
| **B** fetch+cf tiered | 838 | 97 ms | **389 ms** | ~5 s | **9.3%** |
| **D** legacy DO | 702 | 215 ms | 435 ms | ~4 s | 100% |

The rest of this document explains the methodology, what the
synthetic numbers mean, how often cold fills actually fire in each
architecture, the post-cutover off-season validation that revealed
the per-incident framing limitation, and what to expect on a real
CFP-final-sized day with 50+ distinct PoPs.

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

### 3.6 Off-season validation (added 2026-05-10, post-cutover)

After deploying Architecture B to production, manual click-testing
at off-season traffic levels revealed that the per-incident
cold-fill cost on B is ~5 s, not the ~700 ms my synthetic
extrapolation in §4.2 originally suggested. This section documents
that observation and the framing correction.

**What was observed.** Clicking around the production site at
off-season traffic (~no concurrent users, individual clicks
minutes apart) consistently showed `server-timing: python;dur=4000-
5600ms` on `/cfb/game/<id>` cache misses. The legacy gameonpaper.com
showed similar 4 s cold-fills (Redis miss on the droplet → Python
pipeline), occasionally as low as 0.5 s on Redis HITs.

**Live measurement, 2026-05-10 16:55 UTC, ~35 s apart so the
30 s tiered-cache TTL expires each call:**

```
B (tiered, forced uncached via cache-buster):
  TTFB 6.5s   python;dur=5631 upstream-cache=EXPIRED
  TTFB 5.2s   python;dur=4667 upstream-cache=EXPIRED
  TTFB 5.2s   python;dur=4715 upstream-cache=EXPIRED
  TTFB 5.3s   python;dur=4412 upstream-cache=EXPIRED
  TTFB 4.7s   python;dur=4376 upstream-cache=EXPIRED

D (legacy, forced uncached):
  TTFB 4.1s
  TTFB 0.54s  (Redis HIT)
  TTFB 5.2s
  TTFB 0.83s  (Redis HIT)
  TTFB 8.2s
```

D wins per-cold-fill by ~1 s on average — its network path is
shorter (user → droplet → Python in-process). B's path goes
user → CF edge → CF cache MISS → upper-tier MISS → droplet → Python,
plus the Worker render after the Python response. The extra ~1 s
is the CF infrastructure overhead. D also benefits from Redis
holding recent games warm independent of CDN TTLs.

**Why the synthetic test missed this.**

1. **Replay endpoint cost.** `/cfb/process/replay` is ~30 ms of
   server work (load fixture, truncate, return). The synthetic
   "cold fill" measured in §3.3 was upper-tier-cache-fill cost
   (~270 ms median for B), not Python-pipeline cost. Real
   `/cfb/process` is ~100× slower per cold-fill.
2. **Sustained traffic kept caches warm.** 17 viewers × 30 s
   cycles × 5 regions = ~3.4 RPS sustained against the same 3
   game IDs. Each TTL window saw 100+ requests, so the cache was
   essentially always warm in the test. A real off-season click
   hits an expired cache by default.
3. **Three-game rotation.** The harness rotated 3 captured
   fixtures across 17 viewers per region. In production, users
   click on many different games; per-game cache miss probability
   is much higher.

**What this does NOT change.**

- The §2 cache-hit-rate measurements remain valid. A's 83% worker
  HIT rate and B's 91% upstream HIT rate describe how often the
  cache layer fires, regardless of upstream cost.
- The origin-amplification ratio (A: 16.6%, B: 9.3%, D: 100%)
  remains valid and predicts production behavior under sustained
  load.
- The §4.3 compute-cost projections remain valid: B burns ~17×
  less Python compute than A at game-day scale, **because B has
  fewer cold-fill incidents**, not because each one is cheaper.
- B is still the right pick for game day for the reason the report
  set out to prove: at 50,000 concurrent viewers across 50 PoPs,
  B produces ~1 cold-tail incident per 30 s vs A's ~50. Fewer
  affected users.

**What this DOES change.**

- **The per-user p99 numbers in §2.1 and §4.4 don't translate to
  production.** A user who happens to be the unlucky one paying a
  cold-fill sees ~5 s on either A or B with real PBP. The "B p99 =
  389 ms" is a property of the test setup, not a prediction.
- **At off-season traffic, B is slightly worse than D for
  individual user clicks** (~1 s extra network overhead on cold-
  fills). At sustained game-day load this is dominated by the
  cold-fill volume advantage and B wins overall, but for an
  audience of 5-10 simultaneous users (which is what off-season
  looks like) D would arguably feel snappier.
- **Pre-warming becomes attractive** as an off-season experience
  fix. The `PREWARM_TOP_N` env var (currently 0) was scaffolded
  for this case; flipping it on plus a cron task that fetches the
  top-N most-likely-to-be-clicked games every 25 s would keep B's
  caches hot during low traffic and eliminate the cold-fill-on-
  click experience entirely. Out of scope for this report; tracked
  as a follow-up.

**Validation TODO for football season.** Re-run the harness against
the live `/cfb/process` endpoint (drop the `?replay=` param so the
harness targets `/cfb/game/<id>` without it) during a real in-
progress game. Compare measured p99 against this report's
projections. If projections hold at sustained ~50,000-viewer
scale, the per-incident framing limitation matters less; the
*frequency* of cold-fills is the load-bearing metric for the
architecture choice. If they don't hold, expect to see B's
real-world p99 closer to A's than to the synthetic 389 ms.

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

### 4.4 Tail-latency at scale (corrected 2026-05-10)

**Earlier draft of this section misled by assuming B's cold-fill
cost was the upper-tier-cache fill time (~700 ms) rather than the
real Python pipeline cost (~5 s). The §3.6 off-season validation
established that B's cold-fill is ~5 s of Python compute, same as
A's. Corrected version below; original (synthetic-only) numbers
preserved in the "Test (replay)" column.**

For the unlucky-viewer experience — the one whose request happens
to be the first in their PoP (A) or first globally (B) that TTL
window — TTFB looks like:

| Audience | A user p99 | B user p99 | Per-30s-window unlucky count: A / B |
|---|---|---|---|
| 50 viewers, 5 PoPs (test, synthetic replay) | 783 ms | 389 ms | (test artifact, sustained warm) |
| 50 viewers, 5 PoPs (real PBP, projected) | ~5 s | ~5 s | 5 / 1 |
| 5,000 viewers, 50 PoPs (CFP semifinal) | ~5 s | ~5 s | 50 / ~3 |
| 50,000 viewers, 50 PoPs (CFP final) | ~5 s | ~5 s | 50 / ~3 |

**Per-cold-fill cost is roughly identical across A and B** when
real Python runs. The only differences:
- B has ~1 s of extra network overhead per cold-fill (Worker →
  CF edge → public droplet URL vs A's Worker → service-binding →
  Container).
- A's cold-fill volume scales with PoP count; B's stays roughly
  constant.

The "Per-30s-window unlucky count" column is the load-bearing
metric for architecture choice. At a CFP final with 50,000 viewers
distributed across 50 PoPs:

- **A**: every PoP pays one ~5 s cold-fill per TTL window. That's
  50 users every 30 s seeing a 5 s tail. Of 50,000 viewers, that's
  ~1 in 1,000 viewers per cycle, ~5 in 1,000 per 5 cycles, etc.
  ~3% of viewers see at least one ~5 s response over a 15-min
  in-progress window.
- **B**: roughly 1-3 upper-tier hubs each pay one ~5 s cold-fill
  per TTL window. That's ~3 users every 30 s seeing a 5 s tail.
  ~6 in 100,000 viewers per cycle. ~0.2% of viewers see at least
  one ~5 s response over a 15-min window.

So at scale, **15× fewer users feel the cold tail on B**. Not
faster cold-fills, but rarer ones.

**Takeaway:** at any audience size, A's and B's worst-case
experiences are similar in magnitude (~5 s). The architecture
choice matters at the *audience aggregate* level — B keeps the
fraction of users hit by a cold tail much smaller, which is what
makes the difference for engagement metrics on big games. For
small audiences (off-season, low-volume games), the
fraction-affected isn't very different and the per-user
experience is what matters most; here A's slightly lower
network overhead per cold-fill makes it marginally preferable.

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

**Status: production has been on Architecture B since 2026-05-10.**
Migration committed in `864c6059..926cb9c6` on
`instrument-plus-cloudflare-cdn`. The recommendations below are
written with the §3.6 off-season validation in mind, not as
pre-migration advice.

1. **Stay on Architecture B** (current production). The §3.6 finding
   that B's per-incident cold-fill cost is ~5 s (same as A and D)
   doesn't undermine the migration; it changes the framing from
   "B has a tighter tail" to "B has fewer tail incidents at scale."
   The fundamental load-shaping property — origin called once
   globally per TTL window vs once per PoP per TTL window — is
   still the load-bearing benefit and still motivates the
   migration for game-day traffic.
2. **Keep `caches.default` for the rendered HTML.** Already in
   place; warm same-PoP HITs return in 65-300 ms via the Worker's
   per-PoP cache. This is what makes "normal clicks" (repeat
   visits to the same URL) feel snappy. Without it, B's 65 ms
   warm path would become ~150 ms.
3. **Implement the pre-warm cron** (`PREWARM_TOP_N` env var,
   currently set to 0). At off-season traffic levels the tiered
   cache TTL expires between clicks and every user is
   effectively hitting a cold cache — see §3.6. A cron task that
   fetches the top-N games every 25 s (< 30 s TTL) keeps both
   caches.default AND the tiered cache hot, reducing real-world
   user cold-fills to near-zero outside of brand-new game IDs.
   Out-of-scope for this test; implementation is straightforward
   (Worker `scheduled` handler + KV-backed top-N list).
4. **Don't decommission the DigitalOcean droplet on schedule.**
   Architecture B's public Python URL is the legacy droplet at
   `python.unseen-university.org`. If Phase 3E decommissions the
   droplet, B's origin disappears. Either: (a) move B's origin to
   a public-facing Cloudflare Container route (a thin Worker
   proxy in front of the Container), or (b) keep the droplet as
   the Python-only origin and shift Phase 3E to deprecate only
   `frontend/`, `redis/`, `caddy/`. **CLAUDE.md and
   docs/migration-plan.md have already been amended to reflect
   option (b).**
5. **Re-run the harness during football season** with `?replay=`
   omitted to validate the §3.6 projections against real PBP
   traffic. The harness already supports a real-game target shape
   for D; extending it to A and B is small (drop the replay-mode
   conditional from the URL builder). This is the test that would
   convert the §3.6 corrections from "projected" to "measured".
6. **For potential rollback to A**, bump the Container's
   `max_instances` from 5 to ~15 before flipping the env var
   back. The observed 16.6% test cold rate would translate to
   occasional 1-2 RPS bursts at game start that the current
   5-instance cap could throttle. (No action needed unless you
   actually roll back.)
7. **The known issue (5-concurrent `aws lambda invoke` hang)
   deserves a real investigation** before the next test. Worth
   ~2 hours of debugging — try `aws lambda invoke
   --no-cli-auto-prompt`, confirm the AWS CLI isn't multiplexing
   connections, check account-level Lambda concurrency limits,
   look at whether the staggered firing pattern hits a
   Cloudflare side effect.

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
