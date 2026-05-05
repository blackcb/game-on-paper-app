# Cloudflare migration plan

Five phases, executed in order. Each phase is independently shippable with a
working rollback. Claude Code can execute most of this autonomously, but
several steps require **user action** (DNS, billing, secrets) — those are
called out explicitly with `> USER ACTION:` blocks. **Do not proceed past a
USER ACTION step without confirmation from the user.**

## Status

- **Phase 0 — Cloudflare CDN in front (Tier 1)**:
  - Replica (`sports.unseen-university.org`): **completed 2026-04-30**
  - Upstream (`gameonpaper.com`): **pending PR #164 merge** + maintainer go-ahead
- **Phase 1 — Quick-win bug fixes**:
  - Replica: **completed 2026-05-01** (16 commits, see Notes)
  - Upstream: **staged in 4 topic branches locally** (`pr-a-latent-bug-fixes`,
    `pr-b-caching-wins`, `pr-c-python-compression`, `pr-d-asset-cleanup`);
    not yet pushed or PR'd pending replica burn-in
- **Phase 2 — Worker rewrite + KV + Pages (Tier 2)**:
  - 2A scaffolding: **completed 2026-05-02** (Hono + TS + Wrangler).
  - 2C data layer: **completed 2026-05-02**. Two KV namespaces
    provisioned (`LEAGUE_DATA` `649602a5...0ba731`,
    `SUMMARY_LAST_UPDATED` `564be97a...0f1c3d`). KV-first helpers:
    `retrieveLeagueData`, `retrieveLastUpdated`, `retrievePercentiles`,
    `retrieveTeamData` — all with summary-service fallback +
    write-through, recursive year-1 retry capped at 2, MIN_SEASON
    floor. ESPN integration via `lib/teams.ts` (`getTeamInformation`,
    `getTeamSeasonInformation`).
  - 2B routes ported (live at https://sports.unseen-university.workers.dev):
    * `/cfb/glossary`
    * 7 static redirects (`/cfb/teams`, `/cfb/teams/:type`,
      `/cfb/year/:year/teams`, `/cfb/charts/team/epa`, `/cfb/players`,
      `/cfb/players/:type`, `/cfb/year/:year/players`)
    * `/cfb/year/:year/teams/:type` (team leaderboard)
    * `/cfb/year/:year/players/:type` (player leaderboard)
    * `/cfb/charts/trends`
    * `/cfb/year/:year/charts/team/epa`
    * `/cfb/team/:teamId` (multi-season team page)
    * `/cfb/year/:year/team/:teamId` (per-season team page)
    * `/cfb/` (today's scoreboard)
    * `/cfb/year/:year/type/:type/week/:week` (week scoreboard)
    * `/cfb/year/:year` (year scoreboard, defaults to type=2 week=1)
    * `/cfb/game/:gameId` (route + cache + Python proxy + game_error
      + pregame + **full Game template** — chrome, WP/EP charts,
      slim + advanced box score, per-team player stats, pass +
      rush matrices, big plays / important plays / scoring plays /
      drives + per-drive field charts / all plays)
    * + `/cfb/healthcheck` placeholder
  - **2B is fully ported.** The `?json=1` shortcut is preserved at
    every branch where PBP is in hand. WP/EP/field charts use the
    JSON-island pattern (Worker emits `var gameData = ...`,
    unmodified `/assets/js/{dashboard,field}.js` consume it) so the
    chart code didn't get reimplemented. Real game IDs still render
    `game_error` in production until Python becomes reachable from
    the CF edge (sub-phase 3B Container binding or 2H cutover) —
    same posture as the prior commit.
  - 2D (Cache API): **completed 2026-05-03**. `caches.default`
    keyed by request URL replaces the KV per-game cache from 2B.
    Cache-Control varies by branch — completed games
    `s-maxage=31536000`, in-progress 30 s, pregame 5 min,
    quarantine 1 day; pbp/ESPN errors are NOT cached so they
    auto-recover. `c.executionCtx.waitUntil(cache.put(...))` for
    fire-and-forget writes. Production smoke confirmed
    `cf-cache-status: HIT` on second hit for quarantine + pregame.
  - 2E (assets): **completed 2026-05-03**. `worker/public/`
    populated from the legacy `frontend/public/` (9.6 MB, 1424
    files) and exposed via the `[assets] directory = "./public"`
    binding. WP/EP/field charts now resolve their script tags
    against the deployed Worker. Hashed-filename + 1-year
    `/assets/*` cache rule deferred to a follow-on cleanup pass.
  - 2F (cron): **completed 2026-05-03**. Cron registered
    (`schedule: * * * * *`); `scheduled` handler in
    `index.tsx` calls `writeCurrentScoreboard` during football
    season (Aug 20 – Jan 20) and short-circuits otherwise.
    Bare `/cfb/` route reads from `cfb-scoreboard-80` KV first
    with ESPN fallback + write-through. Production smoke
    confirmed KV warming via the route (479 KB scoreboard
    payload cached on first hit; subsequent hits ~170 ms with
    no ESPN call).
  - 2G (tests + observability): **completed 2026-05-03**.
    Server-Timing header on every response (op names match the
    Express side); structured JSON `{event: "request", ...}` log
    line per response; ajv schema validator on Python responses
    (warn-only); Playwright preview-URL update deferred to 2H.
  - 2H (cutover): **DONE 2026-05-03**.
    `sports.unseen-university.org` is now served by the
    Cloudflare Worker end-to-end, and every route renders
    real data. Game pages → Caddy → 127.0.0.1:7000 (Python).
    Leaderboards / charts / team pages / pregame matchup →
    Caddy → 127.0.0.1:3000 (cfb-team-summaries). Routing
    flipped via Workers Route. Headline perf: warm game-page
    TTFB 490 ms → 75 ms (6.5× faster); leaderboard warm hit
    9 ms (KV-cached). See 2H.10b for full benchmark, 2H.10c
    for the post-burn-in summary-service follow-up that
    closed the leaderboard/charts gap.
  - 2I (Cache Rules + Origin Cache Control): **planned**.
    Cross-PoP pooling for `/cfb/game/*` via Cloudflare's
    standard cache (which Tiered Cache pools, unlike
    `caches.default`). Estimate 1-2 days.
  - 2J (Stale-while-revalidate for in-progress games):
    **planned**, after 2I. Eliminates 4 s tail spikes at
    cache-expiry. Estimate 1 day.
  - vitest suite: 143 assertions across 12 files, ~5.9 s.
- **Phase 3 — Python on Cloudflare Containers (Tier 3)**: not started
- **Phase 4 — TS + ONNX port (Tier 4, long arc)**: deferred (separate plan)
- Last updated: 2026-05-04 (Phase 2H end-to-end live; added
  scoreboard ESPN-flake catch; validated `caches.default`
  per-PoP constraint; planned 2I/2J as the resolution path
  (Cache Rules + SWR) and reordered Phase 3 Containers to
  follow them)

### Next session entry point

End-of-day stop on 2026-05-03. Branch `instrument-plus-cloudflare-cdn`,
six commits ahead of the prior checkpoint: 2B full template port
(`6f14837`), 2D Cache API (`4dda877`), 2E static assets
(`aa5f1bb`), 2F cron-warmed scoreboard (`f166679`), 2G
observability (`1c8d86d`), and 2H prep. Working tree clean
once 2H prep is committed.

**Decision (2026-05-03)**: replica cutover via Caddy-fronted
Python (Option 1) rather than waiting for Phase 3B Containers.
Maintainer hasn't even seen the Phase 0 PR yet, so any
Container investment now is too speculative. The bridge is
throwaway; if maintainer says yes we eventually replace it
with 3B, if they say no we drop the whole thing.

**Phase 2 is fully done.** `sports.unseen-university.org` is
live on the Worker, and every route serves real data:
- game pages → Caddy → 127.0.0.1:7000 (Python pipeline)
- leaderboards / players / trends / EPA chart / team pages /
  pregame matchup → Caddy → 127.0.0.1:3000 (cfb-team-summaries)
- assets → Workers Static Assets binding (edge-cached)

Smoke + Lighthouse captured (see 2H.10 / 2H.10b in Notes).
Summary follow-up post-burn-in fix captured in 2H.10c (the
same shape as the Python proxy — secret-gated Caddy vhost +
dedicated Origin Cert).

Open follow-ups, in priority order:

1. **2I — Cache Rules + Origin Cache Control** (next session
   start): adds a Cache Rule for `/cfb/game/*` that defers TTL
   to the Worker's Cache-Control header. This puts game-page
   responses into Cloudflare's standard cache layer, which
   Tiered Cache pools across PoPs (the Workers Cache API does
   not — empirically validated in the "2D — discovered
   constraint" Notes section). Net win: one viewer warms one
   PoP → upper-tier cache hub → every other PoP serves a
   tiered hit instead of running the Worker against origin.
   Estimate 1-2 days.
2. **2J — stale-while-revalidate for in-progress games**:
   adds `stale-while-revalidate=60` to the in-progress game
   Cache-Control. Eliminates the 4 s tail spike that hits
   the unlucky user whose request lands at TTL expiry.
   Estimate 1 day. Pairs naturally with 2I.
3. **Phase 3 (Cloudflare Containers for Python)**: scales
   Python horizontally, removes the single-droplet bottleneck.
   2-3 weeks of work. Defer until after 2I/2J — those address
   the same goals (latency + concurrent users) at a fraction
   of the cost. If 2I+2J reduce the cold-render rate to <5%
   of game-page traffic, Phase 3 becomes a "nice-to-have"
   rather than a "must-do."
4. **2H.11 — burn-in + cleanup** (parallel to 2I/2J):
   - Watch CF Web Analytics + `wrangler tail` for 24-48 h.
   - After clean burn-in: `docker compose stop frontend` on the
     droplet (keeps Python + Caddy + Redis running; the Express
     container stays stopped as a paranoid rollback option).
   - After 1 week clean: codify the route in `wrangler.toml`
     (`[[routes]] pattern = "sports.unseen-university.org/*"`).
5. **2E follow-on**: hashed-filename + 1-year `/assets/*`
   cache-rule bump (deferred; nice-to-have).
6. **2G follow-on**: Playwright preview-URL update + mobile
   field test for the Lighthouse mobile thresholds.

Phase 4 (TS + ONNX port) stays deferred. Only worth opening
if 2I + 2J + Phase 3 together still leave Python latency as
a real complaint, which is unlikely at current traffic.

Sanity before starting:
```
cd worker
npx tsc --noEmit          # should be clean
npx vitest run            # 128 tests / 11 files / ~2.9s
eval "$(grep '^export CLOUDFLARE_API_TOKEN' ~/.zshrc)"
npx wrangler deploy       # smoke at sports.unseen-university.workers.dev
```

## Resume hint for Claude Code

1. Find the next phase whose status is not "completed" or "deferred".
2. Find the first unchecked task (`☐`) in that phase.
3. **If the task starts with `> USER ACTION:`, stop and ask the user to do
   it. Do not attempt to do it yourself.** Once the user confirms, check the
   task and continue.
4. **If the task is destructive** (DNS cutover, decommissioning the droplet,
   `wrangler deploy --env production`, deleting GH Action secrets), state
   what you're about to do and wait for confirmation, even if the user said
   "continue".
5. After completing all of a phase's tasks, update the Status block above,
   fill in the **Notes** subsection for that phase, and run the **Acceptance**
   checks before moving on.
6. If the user says "continue the migration", start at step 1 with no
   further confirmation needed (subject to rules 3 and 4).

## Cross-references

- The **perf plan** at [perf-plan.md](perf-plan.md) should be at least
  through Day 1 (baseline observability) before starting Phase 0, so the
  CDN's impact can be measured. Day 5 (Lighthouse CI) gates regressions
  during phases.
- After each phase, re-run the Lighthouse CI numbers from perf-plan Day 5
  and tighten thresholds.

## Cost expectations

Realistic monthly bills, assuming current traffic levels (low five-figure
page views/month):

| Phase | Cloudflare | Off-platform | Total delta vs today |
|---|---|---|---|
| 0 | Free plan | unchanged DO droplet | $0 |
| 1 | Free plan | unchanged DO droplet | $0 |
| 2 | Workers Paid ($5) | DO droplet (still running Python) | +$5 |
| 3 | Workers Paid + Containers (~$10–30) | $0 (droplet decommissioned) | -$5 to -$25 vs today |
| 4 | Workers Paid + R2 (~$5) | $0 | savings on container compute |

Containers billing is per-second active CPU/memory; idle is cheap. Confirm
current numbers in Cloudflare's dashboard before Phase 3.

---

## Phase 0 — Cloudflare CDN in front (Tier 1)

**Outcome**: gameonpaper.com proxied through Cloudflare. Static assets cached
at edge. No code changes. Origin still serves everything dynamic.

**Estimate**: 1 day (most is DNS propagation wait time).

**Rollback**: Change nameservers back at the registrar. Propagation 5–30 min
if TTL was lowered beforehand. Site is fully functional during cutover —
this is the lowest-risk phase.

### Tasks

- ☐ Verify perf-plan Day 1 (baseline observability) is complete and baseline
  metrics are recorded in [perf-plan.md](perf-plan.md). If not, do that
  first — there's no point migrating without a before/after.
- ☐ At the current registrar, **lower the TTL on gameonpaper.com NS records
  to 300s** at least 24h before cutover. Quick rollback if anything goes
  wrong.
  > **USER ACTION**: Adjust nameserver TTL at the registrar (Namecheap,
  > Google Domains, etc.). Claude doesn't have registrar access.
- ☐ Verify the origin's TLS posture: `curl -vI https://www.gameonpaper.com
  2>&1 | grep -E 'subject|issuer|TLS'`. If the cert is Let's Encrypt or
  similar valid public CA, "Full (strict)" SSL mode is safe. If it's
  self-signed, plan to use Cloudflare Origin CA (issued for free in dash).
- ☐ Verify the origin can take direct edge traffic on 443 without changes.
  Check the droplet's firewall and any reverse proxy in front of Docker
  (likely nginx or caddy outside this repo).
  > **USER ACTION**: Confirm what's terminating TLS at the droplet. The
  > repo doesn't include a reverse proxy config — this lives outside the
  > Docker compose. Document it in this plan's Notes section.
- ☐ Create Cloudflare account, add gameonpaper.com as a site (Free plan is
  fine for Phase 0).
  > **USER ACTION**: Sign up at cloudflare.com and add the domain.
  > Cloudflare auto-imports existing DNS records.
- ☐ Verify imported DNS records match the current set: A/AAAA for `@` and
  `www` should point to the droplet IP. Adjust if the import missed
  anything (mail records, txt verification, etc.).
- ☐ At the registrar, change nameservers to the two Cloudflare NS records
  shown in the dashboard.
  > **USER ACTION**: Change NS at registrar.
- ☐ Wait for propagation. Verify with `dig NS gameonpaper.com` from a
  non-cached resolver (`dig @1.1.1.1 NS gameonpaper.com`).
- ☐ In Cloudflare dashboard, enable proxy (orange cloud) on `@` and `www`
  records.
- ☐ **SSL/TLS** → set to "Full" first. After confirming site loads, switch
  to "Full (strict)" if origin cert is valid.
- ☐ **Speed** → enable Brotli, HTTP/3, 0-RTT. **Caching** → enable Tiered
  Cache.
- ☐ **Cache Rules** (in order; first match wins):
  1. `URI Path starts with /assets/` → **Cache Eligibility: Eligible for
     cache; Edge TTL: 1 hour; Browser TTL: 1 day.** (Bumped to 1 year in
     Phase 2 once asset hashing is in place.)
  2. `URI Path equals /robots.txt` → Edge TTL 1 day.
  3. `URI Path matches /cfb/year/*/teams/*` AND `Method eq GET` → Edge TTL
     5 min, Browser TTL 1 min. (Updates daily via summary service.)
  4. `URI Path matches /cfb/teams/*` (no year prefix; redirects) → Edge TTL
     5 min.
- ☐ **Page Rules / WAF** → migrate the bot UA blocklist from
  [frontend/server.js:17-26](../frontend/server.js) to a WAF custom rule
  (Block requests where User-Agent contains any of the listed strings).
  Removes the null-check bug at [server.js:29](../frontend/server.js) as a
  side effect.
- ☐ Spot-check: hit `/assets/css/index.css` twice via curl, second response
  should have `cf-cache-status: HIT`. Hit `/cfb/game/401403910`, verify
  page still renders correctly.
- ☐ After 24h, capture new metrics in perf-plan's Baseline section under a
  new "After Phase 0" heading.

### Acceptance

- `dig NS gameonpaper.com @1.1.1.1` returns Cloudflare NS records.
- `curl -I https://www.gameonpaper.com/assets/css/index.css` shows
  `cf-cache-status: HIT` on the second request.
- Lighthouse CI from perf-plan Day 5 shows improved LCP and total byte
  weight, with passing thresholds.
- Origin egress (visible in DigitalOcean dashboard) drops noticeably.

### Notes

#### Replica execution (2026-04-30)

Phase 0 was executed against `sports.unseen-university.org` first
(rather than upstream gameonpaper.com) because the replica is what
this fork controls and what the migration plan now uses for measuring
each phase. The same dashboard config will need to be applied to the
upstream zone after PR #164 merges and the maintainer agrees to the
direction. The four cache rules and the WAF custom rule transfer
identically; only the hostname filter changes.

**What was already in place from replica setup**:
- Cloudflare account, DNS, proxy on `sports`, SSL/TLS Full (strict),
  Origin Certificate (15 yr), Caddy reverse proxy on origin, UFW
  locked to CF IP ranges. All from
  [replica-deploy-plan.md](replica-deploy-plan.md) Phase C.
- Brotli (`content-encoding: br`) and HTTP/3 (`alt-svc: h3=":443"`)
  on by default for the zone.
- 0-RTT enabled by default on Free plans since 2023; verified via
  TLS connection resumption (no explicit toggle needed).

**What was added in this Phase 0 pass**:
- **Tiered Cache** → Smart Tiered Cache Topology enabled.
  Important caveat — this applies to the standard CF cache
  (Cache Rules), NOT to the Workers Cache API
  (`caches.default`). See "2D — discovered constraint:
  caches.default is per-PoP" in the Phase 2 Notes for the
  empirical validation and implications.
- **Cache Rules** (4 rules, all on `sports.unseen-university.org`):
  1. `assets-long-ttl`: URI Path starts with `/assets/` →
     edge 1h, browser 1d.
  2. `robots-day-ttl`: URI Path equals `/robots.txt` → edge 1d.
     Browser TTL not overridden — minor; users re-fetch once per 4h
     instead of once per 1d. Edge cache (the egress-saving part)
     still 1d.
  3. `leaderboards-short-ttl`: URI Path wildcard
     `/cfb/year/*/teams/*` → edge 5m, browser 1m.
  4. `team-redirect-cache`: URI Path wildcard `/cfb/teams/*` →
     edge 5m.
  - Method filter dropped from rules — Cloudflare only caches safe
    methods (GET/HEAD) by default; explicit Method clause is
    redundant in Cache Rules' easy mode (would require expression
    editor).
- **WAF custom rule** (`bot-ua-blocklist`): single-rule
  `lower(http.user_agent) contains <name>` OR'd across the seven UAs
  from [server.js:17-26](../frontend/server.js#L17). Action: Block.
  Side effect: the `req.get('User-Agent')` null-crash bug (Phase 1
  task) no longer matters in production for the replica even before
  the Phase 1 fix lands.

**Spot-check measurements**:

| Path | Pre-Phase-0 | Post-Phase-0 | Delta |
|---|---:|---:|---:|
| `/cfb/year/2024/teams/differential` (warm) TTFB | 113 ms | **49–69 ms** | **−56%** |
| `/assets/*` browser cache | 4 h (zone default) | **1 day** | 6× longer |
| Bingbot UA hitting `/cfb/` | reaches origin → 405 | **403 at edge** | origin save |
| `/robots.txt` | uncached | edge cached, age:86s after 2nd hit | egress save |

HTML pages (`/cfb/`, `/cfb/game/*`) intentionally left as DYNAMIC. HTML
caching with the current architecture is risky — the scoreboard
changes during games and the game page embeds live PBP. Phase 2's
Worker + Cache API approach is what makes safe HTML caching feasible.

**Open follow-up**:
- robots.txt Browser TTL → "Override – 1 day" (one click). Cosmetic;
  the egress-saving part already works via the edge cache.

#### Upstream execution (queued)

The same dashboard configuration applies to `gameonpaper.com` once
PR #164 merges and the maintainer agrees to the migration. All the
prerequisite work (account setup, DNS migration to CF, TLS Full
strict, Origin Cert) listed above as ☐ in the original Phase 0 plan
becomes the actual work for that zone — those steps stay unchecked
until the upstream cutover happens.

---

## Phase 1 — Quick-win bug fixes

**Outcome**: Existing services run faster and more correctly with no
architectural changes. Independent of Cloudflare — could be done before
Phase 0, but ordering after means the Phase 0 baseline reflects today's
broken state and the wins are clearly attributable.

**Estimate**: 1–3 days.

**Rollback**: `git revert` per fix. Each fix is a separate commit.

### Tasks

#### Python service

- ☑ Add `gunicorn` to [python/requirements.txt](../python/requirements.txt).
- ☑ Change [python/Dockerfile](../python/Dockerfile) `CMD` to:
  `gunicorn -w 2 -k gthread --threads 8 --timeout 120 -b 0.0.0.0:7000 app:app`.
  (Two workers because the 4GB memory limit splits to 2GB each — pandas
  pipelines are memory-hungry. Tune after observing.)
- ☑ Add `flask-compress` to requirements; in [python/app.py](../python/app.py)
  apply `Compress(app)` after creating the Flask app. PBP responses are
  multi-MB JSON that compress 5–10×.
- ☑ Replace the `KeyError → 404` blanket catch at
  [python/app.py:260-269](../python/app.py) with explicit handling for the
  *expected* missing-key case (ESPN returning a malformed payload — usually
  detectable by `pbp["header"]` being absent) and re-raise everything else
  to the 500 handler. Stops masking real bugs.

#### Node frontend

- ☑ `cd frontend && npm i compression`. In
  [frontend/server.js](../frontend/server.js) add
  `app.use(compression())` before the static handler. EJS responses are
  100KB+ and compress 80–90%.
- ☑ Fix the User-Agent null crash at [server.js:29](../frontend/server.js):
  `req.get('User-Agent')?.toLocaleLowerCase()?.match(...)` (optional
  chaining + nullish handling). Or delete the middleware entirely once
  Phase 0 moved the rule to WAF.
- ☑ Add `HEAD` to the allowed methods list in
  [server.js:43-57](../frontend/server.js#L43): currently only `GET` and
  `POST` pass; HEAD requests return 405. Standard HTTP clients (curl
  `-I`, search bots, monitoring) use HEAD for cheap existence checks.
  Either add `"HEAD"` to the allowlist, or drop the method-allowlist
  middleware entirely (let Express's default 404 handle unknown
  methods). Discovered while spot-checking Cloudflare proxy behavior.
- ☑ Fix the broken POST handler at
  [frontend/cfb/routes.js:490](../frontend/cfb/routes.js): change
  `Games.getPBP(req, res)` → `Games.getPBP(req.params.gameId)`.
- ☑ Replace SET+EXPIRE pairs in [routes.js](../frontend/cfb/routes.js) and
  [games.js](../frontend/cfb/games.js) (lines 110-111, 141-142, 184-185,
  233-234, 295-296) with `redisClient.set(key, val, { EX: ttl })`. Atomic
  + one round trip.
- ☑ Cap the recursive year fallback at
  [routes.js:121, 195, 246](../frontend/cfb/routes.js): currently any
  transient axios failure on the summary service triggers up to 11
  recursive retries. Add a retry counter (max 2) and an explicit
  "service unavailable" path for the rest.
- ☑ Remove the `cacheBuster` query-param suffix from upstream ESPN URLs
  at [routes.js:412-414](../frontend/cfb/routes.js#L412),
  [schedule.js:82](../frontend/cfb/schedule.js#L82), and
  [schedule.js:132](../frontend/cfb/schedule.js#L132). The
  `&${(new Date()).getTime() * 1000}` suffix defeats ESPN's CDN cache
  on every request, costing ~400 ms even when our own Redis cache is
  warm. ESPN's TTLs (1–5 min) are short enough that bypassing them is
  unnecessary for current-status data. Confirmed via Day 1 instrumentation:
  on a warm-cache game-page hit, `espn_pbp` was 441 ms because of this
  cache buster; without it, expect ~30 ms.
- ☑ Invert the cache-vs-ESPN order in the
  [`/cfb/game/:gameId` handler](../frontend/cfb/routes.js#L409): try the
  Redis-cached processed PBP first via `Games.getPBP`, derive game status
  from `data.gameInfo.status.type.name`, and only fall back to a fresh
  ESPN fetch when (a) the cache is empty, (b) the cached status is
  in-progress and the cached payload is older than ~30 s (live game may
  have transitioned), or (c) the route needs to render the pregame
  template (cache doesn't apply for scheduled games). This drops
  `espn_pbp` to 0 on warm hits for completed games — the common case
  by far.
- ☑ Set `maxmemory-policy allkeys-lru` (or `allkeys-lfu`) on
  [redis/cache.conf](../redis/cache.conf). Currently it has no eviction
  policy and returns OOM on overflow.
- ☑ Fix the cache container's healthcheck in
  [docker-compose.do.yml](../docker-compose.do.yml): currently
  `redis-cli ping`, which defaults to port 6379. The cache instance
  only listens on port 6380 (per
  [redis/cache.conf](../redis/cache.conf)), so the healthcheck always
  fails and the container shows as `(unhealthy)` forever. Should be
  `redis-cli -p 6380 ping`. Discovered while standing up the fork's
  replica ([replica-deploy-plan.md](replica-deploy-plan.md) Phase B Notes).
- ☑ Wrap the upstream calls in
  [`getServiceHealth` in games.js:219](../frontend/cfb/games.js#L219) in a
  try/catch. As written, an `ECONNREFUSED` from python (e.g. python is
  starting up, slower than node's first healthcheck) becomes an
  unhandled promise rejection that terminates the node process under
  Node 24+. The fork's compose file works around this with
  `depends_on: condition: service_healthy` + `restart: unless-stopped`,
  but the real fix is in the route handler.
- ☑ `cd frontend && npm i axios@^1` to upgrade past CVE-vulnerable 0.21.1.
  Verify the PBP and ESPN axios calls still work.

#### Asset cleanup

- ☑ Delete `frontend/public/assets/js/bootstrap.{esm,esm.min,bundle,js,bundle.min,min}.js.map`
  and the duplicate non-min variants. Keep only
  `bootstrap.bundle.min.js` and its map (or delete the map too in prod).
- ☑ Same for `bootstrap.css.map`, `bootstrap-grid.*.map`, etc. in
  [frontend/public/assets/css](../frontend/public/assets/css).
- ☑ Replace the 1.1MB `favicon.svg` with a properly-sized SVG (target
  <50KB) or remove the SVG link and rely on the existing `.ico`/PNGs.
  Took the second path — `head.ejs` only references `favicon.ico`.
- ☑ Verify total `frontend/public/` size dropped from ~17MB to ~3MB.
- ☑ `git add -p` and commit each fix separately so Phase 0's CDN
  improvements vs Phase 1's code improvements are distinguishable in
  metrics later.

### Acceptance

- `pytest python/tests -m "not integration"` still passes (perf-plan Day 2
  must be done; otherwise nothing catches regressions in the Python reshape).
- Manually verify: live game page renders, scoreboard renders, leaderboard
  renders. Playwright suite (perf-plan Day 3) passes.
- `du -sh frontend/public` shows ~3MB or less.
- Server-Timing headers on game page show `pipeline` time roughly halved
  (gunicorn lets a second request actually parallelize against the first).

### Notes

#### Replica execution (2026-05-01)

All 16 fixes deployed to the replica via `instrument-plus-cloudflare-cdn`
on `sports.unseen-university.org`. Each fix is one commit so they can be
cherry-picked independently for upstream PRs.

**Decisions made**:
- gunicorn: `-w 2 -k gthread --threads 8 --timeout 120` as planned. Two
  workers fits the 4 GB compose memory cap with headroom for the pandas
  pipeline's 1–2 GB peak.
- favicon: removed the SVG `<link>` instead of compressing — the `.ico`
  was already wired up and the SVG was unreferenced (1.1 MB pure dead
  weight). Cheaper than producing a new SVG.
- HEAD method: added to allowlist rather than dropping the middleware
  entirely, since the bot UA blocklist still runs there in case the WAF
  rule is ever disabled.
- redis maxmemory-policy: `allkeys-lru` (over `allkeys-lfu`) — matches
  the existing LRU instance's policy and the access pattern (recent
  games dominate).
- Cache-first inversion: kept the in-progress freshness window at 30 s.
  Anything tighter caused live games to flicker; anything looser risked
  stale scoreboards. This is the heuristic to revisit if the upstream
  PR review pushes back.

**Measured impact** (full table in [perf-plan.md](perf-plan.md) under
"After Phase 1"):
- Warm game-page server-side latency 292 ms → 45 ms (84% drop) — driven
  almost entirely by cache-first inversion + cacheBuster removal.
- `/cfb/year/.../differential` TTFB 113 ms baseline → 47 ms post-Phase-1.
- `/cfb/` TTFB regressed 101 ms → 153 ms — gzip CPU cost on a 315 KB
  HTML body. Net win on mobile (~1.5 s saved on Slow 4G); wash on
  desktop. Worth a Mobile lhci run before tightening thresholds.
- Curl-visible page weight unchanged (CF was already brotli-encoding
  for the baseline measurement; origin gzip helps origin→CF only).
- Lighthouse Desktop perf scores essentially flat — the wins are in
  Server-Timing and concurrency, not in single-request lhci.

**Test posture**:
- Python: `pytest -m "not integration"` 9 passed, 1 deselected.
- Frontend: no broken Playwright runs observed; LHCI ran 9 reports
  cleanly (3 URLs × 3 runs).
- Live spot-checks on game / scoreboard / leaderboard all rendered.

**Upstream PR staging** (not yet pushed):
- `pr-a-latent-bug-fixes` — 4 commits: HEAD allow, UA null guard,
  getServiceHealth try/catch, broken POST handler. +47 −16.
- `pr-b-caching-wins` — 5 commits: cacheBuster removal, cache-first
  inversion, SET+EXPIRE → atomic SET EX, recursive-fallback cap, redis
  maxmemory + healthcheck port. +106 −47.
- `pr-c-python-compression` — 4 commits: gunicorn, flask-compress,
  KeyError tightening, Express compression middleware. +68 −14.
- `pr-d-asset-cleanup` — 3 commits: bootstrap variants/maps,
  favicon.svg, axios 0.21 → ^1. +1 −58,828.

Cherry-picks required conflict resolution to strip the perf-plan Day 1
instrumentation helpers (`time(...)`, `_emit_metrics`,
`_server_timing_header`, `timingMiddleware`) — those don't exist on
upstream/main, so the upstream PRs ship plain function calls. Lockfile
also stripped (upstream doesn't track `package-lock.json`).

**Considered, not pursued — sportsdataverse upgrade (2026-05-01)**:

Investigated whether upgrading past our pinned `sportsdataverse==0.0.36.3.3`
would cut the 3.5 s pipeline. Findings:

- The two PyPI lines are parallel branches, not a sequence.
  `0.0.36.3.3` (our pin, released 2026-01-25, **pandas**) is the
  actively maintained line. `0.0.40` (released 2025-12-06,
  **polars-based rewrite**, 4,732 lines vs our 6,277) is older
  calendar-time and was apparently paused.
- Polars would plausibly drop the pipeline from 3.5 s → 700–1000 ms
  (5–10× typical for column-heavy work), but adopting `0.0.40`
  would:
  1. Lose ~5 months of 0.0.36.x bugfixes (turnover detection, half
     edge cases, kickoff/punt fixes, GW play in NCG 2025).
  2. Break the `create_box_score()` call site at [app.py:153](../python/app.py#L153)
     — signature changed to take `play_df` as a parameter.
  3. Risk numeric drift in EP/WP/QBR — Day 2 snapshot tests would
     surface it but reconciliation is non-trivial.
  4. Pin us to polars `<=0.18.15` (current is 1.x), with its own
     deprecation footguns.

**Decision**: stay on `0.0.36.3.3`. The cleanest paths to recover that
latency are (a) the in-our-code wins (`to_dict` swap, response trim,
pre-warm cache for recent completions) for ~10–25% combined, or (b)
the Phase 4 ONNX/TS port. Reopen this if/when upstream merges polars
back into the `0.0.36.x` line.

---

## Phase 2 — Worker rewrite + KV + Pages (Tier 2)

**Outcome**: Express + EJS replaced by a Cloudflare Worker. Static assets
served from Cloudflare Pages or Workers Static Assets. Redis (LRU) replaced
by KV. Per-game cache lives in the Cache API. Droplet still runs the Python
service only.

**Estimate**: 2–3 weeks.

**Rollback**: DNS-level. Keep the droplet running the full stack throughout
this phase. Cut over via DNS only at the end. If anything breaks, switch
gameonpaper.com proxy back to the droplet origin via Cloudflare's load
balancer or a single DNS edit.

### Sub-phases

#### 2A — Scaffolding

- ☑ Decide on framework. Recommendation: **Hono** (Express-like, designed
  for Workers). Alternatives: itty-router (smaller), plain Workers
  (no router). Document the choice in Notes.
- ☑ Create `worker/` directory at repo root with
  `package.json`, `wrangler.toml`, `tsconfig.json`, `src/index.ts`. Use
  TypeScript — the EJS files contain enough untyped data shaping to make
  TS payback fast.
- ☑ `cd worker && npm i hono`. Dev tools: `npm i -D wrangler typescript
  @cloudflare/workers-types vitest @cloudflare/vitest-pool-workers`.
  > **USER ACTION** *(still pending)*: Create a Cloudflare API token
  > (Account → API Tokens → Create → "Edit Cloudflare Workers" template).
  > Save as a `CLOUDFLARE_API_TOKEN` GitHub secret and a local
  > `~/.wrangler/config` entry. Not blocking for 2B (can port routes and
  > run locally with `wrangler dev`); blocks `wrangler deploy`.
- ☑ Configure `wrangler.toml` with `name = "sports"`,
  `main = "src/index.tsx"`, `compatibility_date = "2026-05-02"`. Added
  `nodejs_compat` flag (some npm packages assume Node built-ins).

#### 2B — Port routes incrementally

The current Express app has these route groups in
[routes.js](../frontend/cfb/routes.js):

- `/cfb/` — scoreboard
- `/cfb/year/:year/type/:type/week/:week` — week scoreboard
- `/cfb/year/:year` — year scoreboard
- `/cfb/game/:gameId` — game detail (the big one)
- `/cfb/year/:year/team/:teamId` — team season
- `/cfb/team/:teamId` — team overview
- `/cfb/teams/:type` and `/cfb/year/:year/teams/:type` — leaderboard
- `/cfb/year/:year/players/:type` — player leaderboard
- `/cfb/year/:year/charts/team/epa` — EPA chart
- `/cfb/charts/trends` — trends chart
- `/cfb/glossary` — static
- Various redirects

Port in this order (simplest first, biggest at the end):

- ☑ `/cfb/glossary` — static-ish, just renders the glossary JSON. Validates
  the templating approach works. Hono JSX `Layout` + `GlossaryPage`
  components reproduce the four EJS partials. 17 KB rendered, all 12
  letters + alphabetized terms + HTML-in-definitions intact.
- ☑ Static redirects (`/cfb/teams`, `/cfb/players`, etc.). All
  seven shipped with the leaderboard ports — see `index.tsx` and
  the Status block above.
- ☑ `/cfb/year/:year/teams/:type` (leaderboard) — exercises KV reads from
  the summary service. **Done 2026-05-02.** Helpers (`roundNumber`,
  `generateMarginalString`, `cleanRank`, `generateColorRampValue`,
  `retrieveValue`, `cleanField`) ported to `worker/src/lib/leaderboard.ts`
  with full unit coverage. Server-side filter+sort+ascending-flip in
  `prepareLeaderboardRows` matches Express's behavior bit-for-bit
  (differential-falls-back-to-adjEpaPerPlay rule, defensive sort
  inversion). 316-line EJS template ported to `Leaderboard.tsx`,
  including the per-team dark-mode logo `<style>` block. Live deploy
  renders the chrome but empty `<tbody>` (internal `summary:3000` URL
  isn't reachable from CF edge); real data flows in at sub-phase 2H.
- ☑ `/cfb/year/:year/players/:type` (player leaderboard). **Done 2026-05-02.**
  Reuses the helpers (`roundNumber`, `cleanRank`, `generateColorRampValue`,
  `cleanField`, `retrieveValue`) from the team leaderboard. Adds
  `preparePlayerRows` (no asc-flip, no fallback rules), `playerLeaderTitle`,
  and `playerStatMinimum` (the qualifying-thresholds disclaimer). Three
  type-specific column sets (passing/rushing/receiving) inline in
  `PlayerLeaderboard.tsx`. Receiving caveat note conditionally rendered.
  Live deploy `/cfb/year/2024/players/passing` returns 200 with title
  + qualifying threshold; empty `<tbody>` until KV gets seeded.
- ☑ `/cfb/charts/trends`, `/cfb/year/:year/charts/team/epa`. **Done 2026-05-02.**
  Added `retrievePercentiles` to the summary lib (KV-first, 3-day TTL,
  graceful empty-on-error). Added `getPercentileKey` metric→flat-key
  mapping (21 cases) to leaderboard.ts. Both templates inline the
  data as JSON for client-side Chart.js to render. The trends `?json=1`
  passthrough preserved verbatim. Both routes deployed and return 200.
- ☑ `/cfb/team/:teamId`. **Done 2026-05-02.** Multi-season team page.
  ESPN team metadata via `getTeamInformation` (KV-less; ESPN responses
  rotate quickly enough that caching this isn't worth it yet — revisit
  in 2D Cache API). Per-season breakdowns via `retrieveTeamData(null,
  teamId, null)`. The `?json=1` shortcut returns the raw ESPN payload.
  Differential→adjEpaPerPlay metric rewrite preserved verbatim
  (havoc/passing/rushing aren't differential-able). Off/def types fan
  out 5 percentile-band fetches in parallel and project them to the
  `getPercentileKey(metric)` flat key. Helpers `cleanLocation`
  (lowercase Georgia/61) and `hexToRgb` live inline in `Team.tsx` since
  they're page-specific. Live deploy renders chrome + chart canvases
  + inline data; breakdowns currently come back as the
  `[{teamId, pos_team}]` sentinel because the internal
  `http://summary:3000` URL isn't reachable from CF edge — same
  posture as the leaderboards, real data fills in at 2H.
- ☑ `/cfb/year/:year/team/:teamId`. **Done 2026-05-02.** Per-season
  team page; the largest pure-EJS port left. ESPN season payload via
  `getTeamSeasonInformation`, four parallel `retrieveTeamData` calls
  (`overall` + `passing` + `rushing` + `receiving`) feed the
  breakdown panels and player boxes. The five EJS partials
  (`team_card`, `team_player_cards`, `team_slice`, `player_box`,
  `game_thumb`) are inlined as JSX subcomponents in
  `templates/TeamSeason.tsx` since they don't reuse outside this page
  yet (`game_thumb` will move to its own module when the scoreboard
  port lands and starts rendering the same card grid). Shared
  team-flavored helpers — `cleanLocation`, `cleanAbbreviation`,
  `hexToRgb`, `getNumberWithOrdinal`, `maxTeamsForSeason`,
  `teamCardMarginal`, `sliceColorRamp`, `buildSliceCells`,
  `calculateSpiceLevel`, `CONFERENCE_MAP`, `FBS_CONFERENCES`, `SPICE`
  — extracted to `lib/team_helpers.ts`. Live deploy at
  `sports.unseen-university.workers.dev/cfb/year/2024/team/61`
  renders 568KB: breadcrumb + team card + radar canvases +
  breakdown panels + player box scaffolding + 14 schedule thumbs
  driven by real ESPN data. Player rows are sentinel-empty until 2H,
  same as the other summary-backed routes.
- ☑ `/cfb/`, `/cfb/year/:year/type/:type/week/:week`, `/cfb/year/:year`.
  **Done 2026-05-02.** Three routes share one `renderScoreboard`
  helper and one `Scoreboard.tsx` template. `/cfb/` hits ESPN's
  site-API scoreboard endpoint; the year/week variants hit the
  cdn.espn.com schedule endpoint and flatten its date-keyed
  `content.schedule` shape. Schedule data layer
  (`lib/schedule.ts`) imports `data/schedule.json` (75 KB) and
  `data/groups.json` (2 KB) directly — wrangler bundles them.
  `prepareGameList` does the routes.js:48-93 filter+sort
  (negative-id drop, IN_PROGRESS > END_PERIOD > HALFTIME > others
  with date / type-id tiebreak). `hasActiveGames` drives the
  client-side 60-second auto-refresh. Top-25 (`group=-1`) coerces
  to FBS at the URL and filters down post-fetch. ESPN HTML
  responses (sometimes returned during outages) are explicitly
  rejected as malformed. Cache API is intentionally deferred to
  sub-phase 2D — every request hits ESPN today. `GameThumb`
  hoisted out of TeamSeason.tsx into its own
  `templates/GameThumb.tsx` so both pages share one definition.
  Live deploy: `/cfb/` returns 99 game thumbs (213 KB), the year
  variants return 100 (243 KB).
- ☑ `/cfb/game/:gameId` — **fully ported 2026-05-03.** Started
  2026-05-02 with the route + branches + a stub Game template;
  finished 2026-05-03 with the full Game template port. Game data
  layer at `lib/games.ts`: KV-backed cache (`cfb-game-${id}` keys,
  60s TTL on in-progress, 1 day on completed; sub-phase 2D will
  swap KV for Cache API), Python proxy via `env.PYTHON_BASE_URL`,
  `calculateGEI` ported verbatim with the original last-play
  finalWP semantics, `cleanName` helper for the Georgia-61
  nickname-lowercase rule, and the `QUARANTINE_LIST` constant.
  Route handles all six branches: cache-first JSON shortcut,
  cache-first HTML render, ESPN probe → scheduled→pregame,
  quarantined→game_error, Python failure→game_error, successful
  Python→Game. `?json=1` works at every branch where PBP is in
  hand. `templates/GameError.tsx` and `templates/Pregame.tsx`
  are full ports (matchup partial inlined as a JSX subcomponent
  inside Pregame). **`templates/Game.tsx` is now a full port of
  game.ejs (1501 lines) plus `slim_box_score`, `field`,
  `pass_chart`, and `rush_chart` partials**: chrome + nav
  scroller, WP/EP charts, slim box score (with percentile-derived
  color ramp + tooltips), advanced box score (8 sub-tables in 3
  columns), per-team player stats panel with sorted dropbacks /
  rushes / receivers + DETMER chip, pass + rush matrices,
  big plays / most important plays / scoring plays / drives /
  all-plays tables (each with the EJS expand-row content), and
  per-drive field charts. Live deploys: quarantined IDs render
  the quarantine page; non-quarantined IDs without Python
  reachability still render the pbp-error page (Python's internal
  `http://python:7000` URL isn't routable from the CF edge yet —
  resolves at sub-phase 3B Container binding or 2H cutover).
  TeamCard, TeamSlice, GameThumb hoisted to their own template
  modules so all three game branches can share them.

For each route:
- Translate Express handler → Hono handler.
- Translate EJS template → JSX (or keep EJS via `eta` template engine,
  which works in Workers; but JSX is easier to maintain).
- Replace `axios` with `fetch`.
- Replace Redis reads with KV reads, Redis writes with KV writes.
- Replace `req.query.foo` patterns with Hono's `c.req.query('foo')`.

#### 2C — KV namespaces

- ☑ `wrangler kv namespace create LEAGUE_DATA` — replaces the LRU Redis.
  Keys: `${year}-${type}` (e.g. `2024-overall`), `${year}-percentiles-${pctile}`.
  TTL via the `expirationTtl` param on writes (3 days). ID:
  `649602a55c7048c5ba433bdece6ba731`.
- ☑ `wrangler kv namespace create SUMMARY_LAST_UPDATED` (small, but isolate
  from the bulk data so list operations stay fast). ID:
  `564be97a4ca8419a9ccdc8b0be0f1c3d`.
- ☑ Add the bindings to `wrangler.toml`. Both are wired and the
  `Bindings` type in `worker/src/index.ts` references them so handlers
  get type-checked KV access.
- ☑ Migrate the recursive-fallback summary fetch to a single
  KV-with-fetch pattern. **Resolved without adding `kvCacheOr`.**
  The four `retrieveX` helpers in `lib/summary.ts` already follow
  one shape (cache get → JSON.parse → on miss/error, fetch remote
  → KV write-through). Two of them (`retrieveLeagueData`,
  `retrieveTeamData`) recurse on year-1 fallback for transient
  summary-service failures, which doesn't compose cleanly with a
  generic `kvCacheOr(key, ttl, fetch)` helper — the recursion
  *is* the fallback, and threading retry state through a generic
  helper hurts readability more than the dedup helps. The other
  two (`retrievePercentiles`, `retrieveLastUpdated`) are already
  ~5 lines each. Decision: leave the four functions as-is, drop
  this task. Revisit if a fifth or sixth retrieve helper appears.

#### 2D — Cache API for per-game PBP

- ☑ Replace the per-game Redis (port 6380) with `caches.default` keyed by
  the request URL. **Done 2026-05-03.** Completed games:
  `public, max-age=86400, s-maxage=31536000`. In-progress: 30 s.
  Pregame: 5 min. Quarantine: 1 day. Pbp/ESPN errors NOT cached.
  Drops `getPBP`/`peekCachedPBP` from `lib/games.ts`; the
  `fetchAndShapePBP` fetcher is now public so the route can call
  Python directly. Cache writes go through
  `c.executionCtx.waitUntil(cache.put(...))` so the response is
  not blocked on the put. Production smoke (curl ×2 against
  `sports.unseen-university.workers.dev/cfb/game/401411157`):
  second hit returns `cf-cache-status: HIT`.
- ☑ Implement the `QUARANTINE_LIST` check (currently
  [routes.js:395-407](../frontend/cfb/routes.js)) inside the Worker and
  return the same `game_error` template, with `errorType: 'quarantine'`.
  Done as part of the 2B route port — see `lib/games.ts`
  `QUARANTINE_LIST` and the short-circuit in `index.tsx` for the
  game route.

#### 2E — Static assets

**Option A picked** (Workers Static Assets binding) — simpler than
Pages and avoids a second deploy artifact.

- ☑ Move `frontend/public/*` to `worker/public/*`. **Done
  2026-05-03.** Used `cp -r` rather than `git mv` because the
  legacy Express stack on the DO droplet still serves these
  files until the Phase 2H cutover; after Phase 3E (droplet
  decommission) `frontend/public/` can go away and `worker/public/`
  becomes the only copy. 9.6 MB / 1424 files (1371 of which are
  bootstrap-icons SVGs — well within the 20k-file limit).
- ☑ Add `[assets] directory = "./public"` to `wrangler.toml`.
  **Done 2026-05-03.** Default routing serves assets first, falls
  through to the Worker for misses; no `binding` because the
  Worker doesn't need to call `env.ASSETS.fetch` itself.
- ☑ Reference assets as normal `/assets/...` paths; Worker serves
  them automatically with proper Content-Type. **Done implicitly**
  — every Worker template already references `/assets/...` paths;
  no template change needed for the binding to take effect.
- ◐ Hash filenames (e.g. via a simple build script or
  `vite-plugin-cloudflare`) so the Phase 0 1-hour cache TTL can
  be bumped to 1 year `immutable`. **Deferred.** Workers Static
  Assets already serves immutable content at edge with default
  caching (cf-cache-status: HIT on first hit), so the immediate
  perf cost of skipping this is zero. The win is on browser
  caching: hashed filenames let us set Browser TTL to 1 year
  knowing that any change will get a new URL. Worth doing
  before sub-phase 2H cutover but not blocking. Tracked as a
  follow-on cleanup pass.
- ◐ Update Phase 0 Cache Rule for `/assets/*` to **Edge TTL 1 year,
  Browser TTL 1 year**. Deferred with the hashing task above —
  the two move together.
- ◐ Replace asset references in templates with hashed filenames.
  Deferred with hashing task.

#### 2F — Cron-warmed scoreboard

- ☑ Add a Cron Trigger to `wrangler.toml`. **Done 2026-05-03.**
  `[triggers] crons = ["* * * * *"]` — fires every minute.
  `wrangler deploy` confirms `schedule: * * * * *` registered.
- ☑ In the Worker `scheduled` handler, fetch the ESPN scoreboard and write
  it to KV. The user-facing `/cfb/` route reads from KV first, only falls
  back to a live fetch if KV is empty. **Done 2026-05-03.** Key
  is `cfb-scoreboard-80` (suffixed with the FBS group id; only
  the default group is cron-warmed). 3-minute KV TTL covers ~2
  missed cron runs before the cache goes cold and the route
  falls back to ESPN. New helpers in `lib/schedule.ts`:
  `writeCurrentScoreboard` (cron entry point) and
  `getCachedCurrentScoreboard` (route entry point with
  cache-then-fallback + write-through). The route only uses the
  cache for the bare `/cfb/` case (year+week null, group=80);
  other shapes (`/cfb/?group=-1` Top-25, `/cfb/?group=82` FCS,
  the `/cfb/year/...` historical routes) live-fetch as before.
- ☑ Consider a window guard: only run the cron during football season
  (`now >= Aug 20 && now <= Jan 20`) to save executions.
  **Done 2026-05-03.** `isFootballSeason(date)` exported from
  `lib/schedule.ts`; the `scheduled` handler short-circuits with
  a single log line outside the window. Saves roughly 200k cron
  executions/year.

#### 2G — Tests + observability

- ☑ Vitest tests (using `@cloudflare/vitest-pool-workers`) for:
  - `prepareGameList` sort logic — `test/scoreboard.test.ts`.
  - `calculateGEI` — `test/game.test.ts`.
  - The recursive-fallback cap (asserts max 2 retries, hits 2014 floor)
    — `test/summary.test.ts`.
  - QUARANTINE_LIST routing — `test/game.test.ts`.

  All four covered by the suite that grew up alongside the route
  ports (2B/2D/2F). 141 assertions total as of 2G.
- ☑ Carry forward the Server-Timing instrumentation from
  perf-plan Day 1. **Done 2026-05-03.** New `lib/timing.ts`
  with `time(c, name, fn)` + `timingMiddleware()`. Same op
  names as `frontend/cfb/timing.js` (`python`, `espn_pbp`,
  `espn_scoreboard`, `summary`, `cache_lookup`, `percentiles`,
  `render`, `total`) so the perf-plan baselines stay 1:1
  comparable. Production smoke confirmed `Server-Timing:
  cache_lookup;dur=11, espn_pbp;dur=283, render;dur=0,
  total;dur=294` on a fresh quarantine-game render.
- ☑ Carry forward structured JSON logging. **Done 2026-05-03.**
  Same middleware emits a `{event: "request", method, path,
  status, X_ms, ...}` line per response via `console.log`.
  Workers Logs surfaces it in the dashboard. Pre-existing
  ad-hoc `console.log` calls in `lib/games.ts` /
  `lib/summary.ts` still fire on errors but are now
  unstructured noise next to the structured per-request line.
- ☑ Update the JSON Schema contract validator from perf-plan
  Day 4 to run in the Worker against Python responses.
  **Done 2026-05-03.** New `lib/schema.ts` wraps `ajv` +
  `ajv-formats` + the canonical
  `shared/process-response.schema.json` (copied to
  `worker/src/data/` so wrangler bundles it). Wired into
  `fetchAndShapePBP`. Warn-only — emits
  `{event: "schema_validation_failure", source: "worker",
  gameId, error_count, errors}` on failure but always returns
  the payload. Mirrors `frontend/cfb/games.js:254-266`
  exactly.
- ◐ Update Playwright E2E suite to point at preview URLs.
  **Deferred.** The current `.github/workflows/e2e.yml`
  targets `sports.unseen-university.org` (the production
  replica) on a daily cron + manual dispatch. Per-PR preview
  URLs would require: (a) opening a PR-driven Worker deploy
  (with a uniquely-named *.workers.dev preview), and (b)
  threading that URL into the workflow. Not blocking — the
  existing workflow still catches drift. Pick up at the
  same time as 2H so both Worker preview deploys and the
  Playwright wiring land together.

#### 2H — Parallel deploy + cutover

**Approach for the replica** (decided 2026-05-03): cut
`sports.unseen-university.org` over to the Worker entirely; keep
the droplet running Python (and Caddy + Redis as Python's
dependencies). The Express frontend container stays online but
unused as a fast rollback target. The Worker reaches Python via
a new Caddy-fronted public hostname with a shared-secret header.

This approach is for the **fork's replica only**. Upstream
`gameonpaper.com` cutover is gated on the maintainer accepting
the architecture (there's no PR open yet for that conversation,
let alone merged). The replica running end-to-end is the
artifact that supports that conversation.

##### 2H.1 Pre-cutover code prep — DONE

- ☑ Worker sends `X-Worker-Secret` header on every Python call.
  `lib/games.ts` `fetchAndShapePBP` accepts an optional secret;
  `index.tsx` passes `c.env.WORKER_SHARED_SECRET`. Tests assert
  the header is set when the secret is provided and omitted
  when it isn't (back-compat for local dev / 3B Container path).
- ☑ `wrangler.toml` `[vars] PYTHON_BASE_URL` updated from
  `http://python:7000` (Docker-internal) to
  `https://python.unseen-university.org` (the new Caddy-fronted
  public URL). Comment documents the dev override path
  (`worker/.dev.vars`).
- ☑ `docker-compose.fork.yml`: `python` service now binds port
  7000 to `127.0.0.1:7000` on the host in addition to the
  Docker-internal `expose`. Lets the host's systemd-managed
  Caddy `reverse_proxy 127.0.0.1:7000` reach Python without
  joining the compose network. The `127.0.0.1:` prefix means
  the port is NOT exposed to the public internet, only the
  loopback — UFW + this binding stack make it host-only.

> **Note on hostname** (decided 2026-05-03 mid-bring-up):
> Settled on the single-level `python.unseen-university.org`
> after a brief detour through `python.sports.unseen-university.org`.
> Two reasons:
> - **Cloudflare Universal SSL** (free plan) only covers the
>   apex + ONE level of subdomain. The deeper
>   `python.sports.unseen-university.org` failed edge TLS
>   because Universal SSL doesn't reach two levels. Paying for
>   Advanced Certificate Manager ($10/mo) would have been the
>   alternative; not worth it for a demo.
> - The single-level hostname needs its own dedicated CF
>   Origin Cert (the existing `/etc/caddy/certs/origin.{pem,key}`
>   only covers `*.sports.unseen-university.org`); generated via
>   CF dashboard → SSL/TLS → Origin Server → Create Certificate
>   and installed on the droplet at
>   `/etc/caddy/certs/python-origin.{pem,key}`. Captured in 2H.4
>   below.

##### 2H.2 USER ACTION — generate the shared secret

Pick a long random string. From the user's machine:

```
openssl rand -hex 32
```

Treat the output like a password — do NOT commit it to git.
Used in two places: the GitHub Actions secret (consumed by the
deploy workflow that updates Caddy on the droplet) and a
Wrangler secret (consumed by the Worker at runtime). Same value
in both.

> **USER ACTION**: Generate the secret, save it somewhere safe
> (1Password / pass / similar).

##### 2H.3 Droplet setup for codified Caddy — self-healing in CI

The `caddy/python.unseen-university.org.caddy` snippet ships
through the existing fork-deploy.yml workflow. The workflow's
"Render + install Caddy snippets" step runs these two idempotent
commands at the top of every deploy, so a fresh droplet
(replica-deploy-plan.md Phase A → push this branch) gets the
conf.d setup automatically:

```
sudo mkdir -p /etc/caddy/conf.d
sudo grep -q 'import conf.d' /etc/caddy/Caddyfile \
  || echo 'import /etc/caddy/conf.d/*.caddy' | sudo tee -a /etc/caddy/Caddyfile
```

If you want to verify the setup before pushing (or are bringing
up a non-CI droplet), running the same commands manually via
SSH is harmless — both short-circuit if the state is already
in place.

The deploy user (`secrets.DEPLOY_USER`) also needs passwordless
sudo for `install`, `caddy validate`, and `systemctl reload caddy`.
If sudo is already passwordless for that user (likely — the
existing deploy steps run docker compose), there's nothing to do.
If not, add a sudoers fragment:

```
echo "$DEPLOY_USER ALL=(ALL) NOPASSWD: /usr/bin/install, /usr/bin/caddy, /bin/systemctl reload caddy" \
  | sudo tee /etc/sudoers.d/deploy-caddy
sudo chmod 440 /etc/sudoers.d/deploy-caddy
```

> **USER ACTION**: only the sudoers fragment if it isn't already
> set up. The conf.d + import line are now self-healed in CI.

##### 2H.4 USER ACTION — add WORKER_SHARED_SECRET to GitHub Actions

In the fork repo's GitHub settings:

1. Settings → Secrets and variables → Actions → New repository
   secret.
2. Name: `WORKER_SHARED_SECRET`
3. Value: the 64-char hex from 2H.2.

After this lands, the next push to
`instrument-plus-cloudflare-cdn` triggers the deploy workflow,
which renders `caddy/python.unseen-university.org.caddy` with
`${WORKER_SHARED_SECRET}` substituted in, scp's it to
`/etc/caddy/conf.d/` on the droplet, validates, and reloads
Caddy. No more SSH-and-edit.

> **USER ACTION**: Add the GitHub Actions secret.

##### 2H.5 USER ACTION — Cloudflare DNS: add python.unseen-university.org

In the Cloudflare dashboard for `unseen-university.org`:

1. DNS → Add record:
   - Type: `A`
   - Name: `python`
   - IPv4: the droplet's public IP (`137.184.138.84`, same as
     the existing `sports` record)
   - Proxy status: **Proxied** (orange cloud)
   - TTL: Auto

UFW on the droplet is already locked to Cloudflare IPs
(replica-deploy-plan.md Phase C), so the new subdomain
automatically inherits the firewall posture.

> **USER ACTION**: Add the DNS record in the CF dashboard.

##### 2H.5b USER ACTION — Cloudflare Origin Cert + install on droplet

The new hostname needs its own Origin Cert because the existing
`/etc/caddy/certs/origin.{pem,key}` only covers the `sports`
subdomain. CF Origin Certs are free, 15-year, signed by CF's
internal CA (which CF's edge proxy trusts).

1. CF dashboard → SSL/TLS → Origin Server → Create Certificate.
   - Hostnames: `python.unseen-university.org`
   - Validity: 15 years (default)
   - Click Create. Copy the cert + key into local files (e.g.
     `~/Downloads/python-origin.pem`, `~/Downloads/python-origin.key`).
2. Install on the droplet from your laptop:

   ```
   scp ~/Downloads/python-origin.pem deploy@137.184.138.84:/tmp/
   scp ~/Downloads/python-origin.key deploy@137.184.138.84:/tmp/
   ssh deploy@137.184.138.84 'sudo install -o caddy -g caddy -m 0640 /tmp/python-origin.pem /etc/caddy/certs/python-origin.pem && \
                              sudo install -o caddy -g caddy -m 0640 /tmp/python-origin.key /etc/caddy/certs/python-origin.key && \
                              shred -u /tmp/python-origin.pem /tmp/python-origin.key'
   ```

   (`shred -u` overwrites then deletes — paranoid but cheap. The
   files are also still on your laptop in `~/Downloads/` — move
   to a password manager / secure storage and delete the disk
   copies after this works.)

The Caddy snippet `caddy/python.unseen-university.org.caddy`
references these paths in its `tls` directive — once the files
are in place, the next deploy's `caddy validate` succeeds.

> **USER ACTION**: Generate the cert in CF, scp + install on
> droplet, clean up the temp files.

##### 2H.6 USER ACTION — Wrangler secret (one-time, manual)

The Worker side of the secret isn't pushed by CI today (would
require adding `CLOUDFLARE_API_TOKEN` as a GH Actions secret,
which is more setup than the value warrants for a rarely-rotated
secret). Set it once locally:

```
cd worker
eval "$(grep '^export CLOUDFLARE_API_TOKEN' ~/.zshrc)"
echo -n '<PASTE_THE_SECRET_HERE>' | npx wrangler secret put WORKER_SHARED_SECRET
```

Verify it landed:

```
npx wrangler secret list
```

Should show `WORKER_SHARED_SECRET` with a `(secret)` source.

If the secret is ever rotated:
1. Update `WORKER_SHARED_SECRET` in GitHub Actions secrets.
2. Run the `wrangler secret put` command above with the new
   value.
3. Push to `instrument-plus-cloudflare-cdn`. CI redeploys
   Caddy with the new value; the Worker is already updated.

There's a brief window during step 3 where Caddy and the Worker
disagree (rejected requests render game_error). Live game pages
auto-refresh every minute so this self-heals; static caches are
fine because they don't carry the secret.

> **USER ACTION**: Run the wrangler secret put command above.
> Same 64-char hex as the GitHub Actions secret in 2H.4.

##### 2H.7 Push the branch — CI does the Caddy + DNS prep

```
git push origin instrument-plus-cloudflare-cdn
```

The fork-deploy.yml workflow (Actions → fork-deploy in the GH
UI) runs:

1. Build container images (Python, frontend, redis).
2. Run pytest + schema-freshness check.
3. Deploy docker compose on the droplet.
4. **(new in 2H)** Stage `caddy/*.caddy` on the droplet, render
   with `${WORKER_SHARED_SECRET}` substituted in via envsubst,
   `install` the rendered files into `/etc/caddy/conf.d/`,
   `caddy validate`, `systemctl reload caddy`.
5. Run Playwright E2E suite + Lighthouse.

If the workflow fails at step 4, the most likely causes are:
- `WORKER_SHARED_SECRET` GH Actions secret is missing (added
  in 2H.4).
- `/etc/caddy/conf.d/` doesn't exist on the droplet (one-time
  setup in 2H.3).
- Deploy user lacks passwordless sudo for `install` /
  `systemctl reload caddy` (sudoers fragment in 2H.3).

##### 2H.8 Pre-cutover smoke

Once 2H.3 – 2H.7 are done, verify Python is reachable end-to-end
through the Worker (still serving from
`sports.unseen-university.workers.dev`, no custom domain yet):

```
curl -s "https://sports.unseen-university.workers.dev/cfb/game/401520434?bust=$(date +%s)" \
  | grep -oE "Win Probability|There is no play-by-play"
```

Expected: `Win Probability` (the full Game template renders
because Python is now reachable). If you see `There is no
play-by-play`, the secret is wrong or Caddy isn't routing.

Diagnostics if it fails:
```
# Worker side: tail logs to see if X-Worker-Secret is being sent.
npx wrangler tail
# Caddy side (on the droplet):
sudo journalctl -u caddy -f
sudo tail -f /var/log/caddy/python.access.log
# Python side (on the droplet):
docker compose logs -f python
```

##### 2H.9 USER ACTION — flip routing (the destructive step) — DONE 2026-05-03

Originally written as "Add Workers Custom Domain". Custom Domain
required deleting the existing `sports.unseen-university.org` A
record first ("This domain is already in use"), which would have
created a brief unresolvable-hostname window.

**Switched to Workers Routes mid-cutover** because they (a) leave
the existing DNS A record in place (one less moving part), and
(b) make rollback a single-click delete-the-route with no DNS
re-add. Used:

1. Workers & Pages → `sports` → Settings → Domains & Routes →
   Add → **Route** (not Custom Domain).
2. Zone: `unseen-university.org`. Route pattern:
   `sports.unseen-university.org/*`.
3. Click Add. The Worker starts handling all traffic for that
   hostname within seconds.

> **DESTRUCTIVE STEP done.** Rollback: delete the Route in the
> same pane → existing A record routes back to droplet within
> ~30 s.

##### 2H.10 Post-cutover smoke — DONE 2026-05-03

All five checks green:

```
# 1. Game route renders the full template against real PBP
curl -s "https://sports.unseen-university.org/cfb/game/401520434?bust=$(date +%s)" \
  | grep -oE "Win Probability|There is no play-by-play" | head -1
# → "Win Probability" ✓

# 2. Static Assets binding (edge-cached)
curl -sI https://sports.unseen-university.org/assets/js/dashboard.js
# → 200, content-type: text/javascript, cf-cache-status: HIT ✓

# 3. Server-Timing breakdown on cold game-page hit
curl -sI "https://sports.unseen-university.org/cfb/game/401520434?bust=$(date +%s)" \
  | grep -i server-timing
# → cache_lookup;dur=13, espn_pbp;dur=59, python;dur=4045,
#   percentiles;dur=10, render;dur=0, total;dur=4127 ✓

# 4. Scoreboard renders (~214 KB body, identical to *.workers.dev)
curl -s https://sports.unseen-university.org/cfb/ | wc -c
# → 214760 ✓

# 5. Python proxy denies anonymous traffic (Caddy header gate works)
curl -sI https://python.unseen-university.org/cfb/process | head -1
# → HTTP/2 403 ✓
```

##### 2H.10b Post-cutover performance — captured 2026-05-03

**TTFB medians** (5 samples each, local laptop EST → CF edge):

| Path | Express baseline | Express + Phase 1 | Worker (post-2H) | Δ vs baseline |
|---|---:|---:|---:|---:|
| `/cfb/` | 101 ms | 153 ms | **86 ms** | −15% |
| `/cfb/year/2024/teams/differential` | 113 ms | 47 ms | **75 ms** | −34% |
| `/cfb/glossary` | n/a | n/a | **54 ms** | new |

`/cfb/year/...` regressed from 47 → 75 ms vs Phase 1 because the
Phase 1 measurement was `cf-cache-status: DYNAMIC` from a still-
busy Express path; the Worker path adds a Cache-API lookup +
KV read + render that Express was bypassing on dynamic responses.
Still 34% better than the original Express baseline.

**Game page warm vs cold** (TTFB, ms):

| | Pre-Phase-1 Express + Redis | Post-Phase-1 Express | Worker (post-2H) |
|---|---:|---:|---:|
| Cold cache | 560 (warm Redis hit) | 490 | 4400–5000 (Python pipeline) |
| Warm cache | 560 | 490 | **51–77** |

The cold-cache ~4500 ms reflects a real Python pipeline run end-
to-end (Worker → CF edge → Caddy → Python). Express's "cold" path
hit the still-warm Redis cache because Redis had a 60-s TTL and
most measurements landed inside that window — comparing to it
isn't apples-to-apples.

The headline number is the **warm-cache TTFB drop from ~490 ms
on Express to ~75 ms on the Worker** (6.5× faster on warm
hits). The Cache API serves the rendered Response directly from
CF edge with no origin round-trip — no Python, no Redis, no
EJS render.

**Cold game page Server-Timing breakdown** (median):

```
cache_lookup;dur=13   ← Cache API miss
espn_pbp;dur=59       ← ESPN scoreboard probe (parallel, fast)
python;dur=4045       ← Full Python /cfb/process pipeline
percentiles;dur=10    ← KV read for percentile bands
render;dur=0          ← JSX render is sub-millisecond
total;dur=4127        ← end to end
```

Python is 98% of the cold-cache total. The Cache API turns this
into 75 ms on every subsequent request for the same gameId.

**Lighthouse desktop** (3 runs per URL, median):

| Path | Baseline 2026-05-01 (Express) | Post-2H (Worker) | Δ |
|---|---:|---:|---:|
| `/cfb/` | perf 0.68 | **0.72** | +4 pp |
| `/cfb/game/401403910` | perf 0.65 | **0.65** | flat |
| `/cfb/year/2024/teams/differential` | perf 0.73 | **0.75** | +2 pp |

Detailed median metrics post-2H:

| Path | FCP | LCP | TBT | SI |
|---|---:|---:|---:|---:|
| `/cfb/` | 488 | 955 | 659 | 701 |
| `/cfb/game/401403910` | 821 | 1131 | 707 | 1341 |
| `/cfb/year/2024/teams/differential` | 588 | 699 | 636 | 693 |

Modest improvements because Lighthouse desktop is dominated by
client-side JS+CSS parsing, which the Worker doesn't change —
same templates, same script tags. The Worker rewrite's wins are
in TTFB and in the warm-cache path that Lighthouse cold-loads
each run.

Mobile field test deferred — Lighthouse desktop alone doesn't
capture the mobile gain (gzip CPU savings + cache-hit response
sizes hit harder on Slow 4G). Worth running before we tighten
the lighthouserc thresholds.

##### 2H.10c Summary service follow-up — DONE 2026-05-03

Smoke missed it: leaderboards (`/cfb/year/:year/teams/:type`,
`/cfb/year/:year/players/:type`), trends + EPA chart
(`/cfb/charts/trends`, `/cfb/year/:year/charts/team/epa`), and
the `lastUpdated` stamp in their footers were rendering empty
because the Worker still couldn't reach the cfb-team-summaries
container. Same root cause as Python pre-2H.5b: hardcoded
`http://summary:3000` in `lib/summary.ts`, only resolvable from
inside the droplet's Docker network.

Fix-up was the same shape as the python proxy:

- `caddy/summary.unseen-university.org.caddy` (new) — mirrors
  `python.unseen-university.org.caddy`, just for `127.0.0.1:3000`
  with cert at `/etc/caddy/certs/summary-origin.{pem,key}`.
- `docker-compose.fork.yml` — `summary` service binds 3000 to
  `127.0.0.1:3000`.
- `worker/wrangler.toml` — new `[vars] SUMMARY_BASE_URL =
  "https://summary.unseen-university.org"`.
- `lib/summary.ts` — `SummaryConfig { kv, base, secret }` instead
  of hardcoded URL; every `retrieve*` helper takes the cfg as
  its first arg. `index.tsx` builds the config per-request via
  `summaryCfg(c)` and `lastUpdatedCfg(c)` helpers.
- Tests updated (one new assertion: X-Worker-Secret header is
  sent when secret is in the cfg). 144/144.

USER ACTION steps (mirror 2H.5b):

1. **CF dashboard → SSL/TLS → Origin Server → Create Certificate**.
   Hostnames: `summary.unseen-university.org`. 15 years.
2. **scp + install** on droplet:
   ```
   scp ~/Downloads/summary-origin.pem deploy@137.184.138.84:/tmp/
   scp ~/Downloads/summary-origin.key deploy@137.184.138.84:/tmp/
   ssh deploy@137.184.138.84 'sudo install -o caddy -g caddy -m 0640 /tmp/summary-origin.pem /etc/caddy/certs/summary-origin.pem && \
                              sudo install -o caddy -g caddy -m 0640 /tmp/summary-origin.key /etc/caddy/certs/summary-origin.key && \
                              shred -u /tmp/summary-origin.pem /tmp/summary-origin.key'
   ```
3. **CF DNS → Add record**: `A`, name `summary`, IPv4
   `137.184.138.84`, **Proxied** (orange cloud).
4. **Push the branch** — fork-deploy CI deploys the new compose
   binding + the new Caddy snippet automatically.
5. **Smoke** the leaderboard:
   ```
   curl -s https://sports.unseen-university.org/cfb/year/2024/teams/differential \
     | grep -oc '<tr'
   # ~135 with data, 1 without
   ```
   (Note: use `grep -oc '<tr'` not `grep -c '<tr>'` — Hono JSX
   renders rows with no newlines between them, so `-c`
   line-counts everything as 1.)

6. **Verification done 2026-05-03 post-deploy** — every
   route confirmed serving real data:

   | Route | Result |
   |---|---|
   | `/cfb/year/2024/teams/differential` | 135 `<tr` tags (1 header + 134 teams) |
   | `/cfb/year/2024/players/passing` | 123 `<tr` tags |
   | `/cfb/charts/trends?json=1` | full percentile array, all years 2014-2025 |
   | `/cfb/year/2024/charts/team/epa` | 41 KB body, per-team adjOffEpa/adjDefEpa inlined |
   | `/cfb/year/2024/team/61` | 603 KB body (full template render) |
   | `/cfb/game/401520434` | full Game template (verified earlier in 2H.10) |

   Server-Timing on a warm leaderboard hit: `total;dur=9` (KV
   cache hit, no upstream call). Cold hits go through the
   summary path the same way the cold game-page hit goes
   through python.

> **2H.10c CLOSED.** Phase 2 cutover is fully done; every
> route serves real data through the Worker.

##### 2H.11 Burn-in + cleanup (24-48h)

- ☐ Monitor Workers Logs for `event: schema_validation_failure`
  lines (none expected) and the `event: request` cadence.
- ☐ Watch CF Web Analytics for error-rate spikes.
- ☐ After 48h clean, stop the Express container:
  ```
  ssh root@<droplet> 'cd /opt/game-on-paper && docker compose stop frontend'
  ```
  Keep Python + Redis + Caddy. Don't `rm` the frontend container
  yet — leave it stopped for a week as a paranoid rollback option.
- ☐ After 1 week clean, encode the cutover in `wrangler.toml`:
  ```
  [[routes]]
  pattern = "sports.unseen-university.org/*"
  zone_name = "unseen-university.org"
  ```
  This locks the route into the wrangler config so future
  `wrangler deploy` invocations confirm it's still there.
- ☐ Optionally update `.github/workflows/fork-deploy.yml` to
  stop deploying the frontend container.

##### 2H rollback runbook

If anything looks broken after the Custom Domain flip:

1. Cloudflare dashboard → Workers → `sports` → Domains & Routes
   → click trash on the `sports.unseen-university.org` Custom
   Domain.
2. Within ~30 s, traffic falls back to the existing DNS A
   record → droplet → Caddy → Express (which is still running).
3. `curl -I https://sports.unseen-university.org` should now
   show the Express response (no `cf-worker` header).
4. Investigate, fix, re-add the Custom Domain when ready.

#### 2I — Cache Rules + Origin Cache Control (cross-PoP pooling)

**Outcome**: Game-page responses cached in Cloudflare's standard
cache via Cache Rules instead of (only) the Workers Cache API.
The standard cache is what Smart Tiered Cache pools across PoPs;
the Workers Cache API is per-PoP only (proven empirically — see
"2D — discovered constraint" Notes section). Net effect: first
viewer warms one PoP → upper-tier cache hub gets the response →
every other PoP serves a tiered hit instead of running the
Worker against origin. Removes the "every PoP pays one cold
render per cacheable URL" pattern.

**Estimate**: 1-2 days (mostly dashboard config + small Worker
tweak + multi-region validation).

**Rollback**: Delete the Cache Rule in CF dashboard. The
Worker's `caches.default` path keeps working as it does today
(per-PoP only) — strictly no worse than the current state.

**Tasks**:

- ☐ Verify the Worker's outgoing `Cache-Control` headers on
  `/cfb/game/:gameId` for each branch:
  - completed: `public, max-age=86400, s-maxage=31536000`
  - in-progress: `public, max-age=30, s-maxage=30`
  - pregame: `public, max-age=300, s-maxage=300`
  - quarantine: `public, max-age=86400, s-maxage=86400`
  - errors: no `Cache-Control` (must NOT be cached)
- ☐ Add a CF Cache Rule via dashboard:
  - Filter: `URI Path matches /cfb/game/*` AND `Hostname equals
    sports.unseen-university.org`
  - Cache Eligibility: **Eligible for cache**
  - Edge TTL: **Use cache-control header from origin** (CF dashboard's
    "Origin Cache Control" mode — exact label varies by UI revision).
  - Browser TTL: respect Cache-Control max-age.
- ☐ Decide whether to drop `caches.default.match`/`put` from the
  game route. Two options:
  - **Drop entirely**: Cache Rules become the only cache layer
    for game pages. Simpler code, slightly cleaner.
  - **Keep as a per-PoP fast path**: Worker checks its local
    cache before falling through to Cache Rules. Marginal latency
    win on already-warm PoPs (skip the std-cache layer's lookup).
  - Recommendation: **drop**, simplify. The std-cache lookup is
    sub-ms; not worth carrying two cache layers.
- ☐ Verify error responses still bypass the cache. Test: hit a
  known-error URL twice via cache-busted query, second response
  must NOT show `cf-cache-status: HIT`.
- ☐ Multi-region validation using the same methodology as
  "2D — discovered constraint":
  - Pick a quarantined gameId (so the cold render is fast
    enough for check-host.net's probe timeout).
  - Pick a unique cache-bust value.
  - Warm one PoP from local laptop.
  - Trigger `check-host.net/check-http?host=...&max_nodes=10`.
  - Read structured request logs via `wrangler tail`. Worker
    invocation count should drop from ~10 (per-PoP) to 1-2
    (one warm fill + tiered cache for the rest).
- ☐ Watch CF dashboard → Caching → Tiered Cache hit ratio for
  game-page traffic over the first 24h.

**Acceptance**:

- Multi-region check-host.net test shows ≥ 70% of requests
  hitting cache without a Worker invocation (vs the current
  ~10% — only same-PoP repeats).
- CF Tiered Cache Hit Ratio for `/cfb/game/*` ≥ 80% within
  48h of deploy.
- Error responses (game_error template) consistently show
  `cf-cache-status: MISS` or absent — never `HIT`.
- 145+ vitest tests pass (no regression in unit suite).
- Production smoke: `cf-cache-status: HIT` on a fresh PoP for
  a URL warmed by another region.

#### 2J — Stale-while-revalidate for in-progress games

**Outcome**: Live-game pages serve stale-cached content
immediately while triggering a background re-render. Removes
the 4-second tail spike that hits the unlucky user whose
request lands at TTL expiry. In-progress game tail latency
drops from "~4s every 30s for one user" to "always ~75ms,
with eventual consistency."

**Estimate**: 1 day (Worker code change + Cache-Control update +
test + validation).

**Rollback**: Remove the `stale-while-revalidate` directive
from `CACHE_CONTROL.inProgress`. Cached responses revert to
the prior expire-then-block behavior.

**Tasks**:

- ☐ Update `CACHE_CONTROL.inProgress` in `worker/src/index.tsx`:
  ```ts
  // before
  inProgress: "public, max-age=30, s-maxage=30",
  // after
  inProgress: "public, max-age=30, s-maxage=30, stale-while-revalidate=60",
  ```
  Browsers and Cloudflare both honor this — when the cached
  response ages past `max-age`/`s-maxage` but is still within
  `stale-while-revalidate` of expiry, return the stale entry
  immediately and trigger a background fetch to refresh.
- ☐ Confirm Cache Rules from sub-phase 2I respect SWR. CF
  documents this works for the standard cache layer; spot-check
  via response headers and timing.
- ☐ Update the in-progress test in `worker/test/game.test.ts`
  to assert `stale-while-revalidate=60` is in the
  `Cache-Control` header.
- ☐ Add structured-log instrumentation: when a request triggers
  a SWR background refresh, emit
  `{event: "swr_refresh", gameId, age_ms}` so Workers Logs
  surface the refresh rate. Useful for tuning the SWR window
  later.
- ☐ Validation: tail Workers Logs during a real live-game test
  (or simulate by patching CACHE_CONTROL.inProgress to a small
  value temporarily). Confirm:
  - Total response times stay under ~100 ms throughout the
    test, not spiking every 30s.
  - `swr_refresh` events fire approximately every 30s per
    distinct (gameId, PoP) pair.

**Acceptance**:

- In-progress game requests in Workers Logs show consistent
  ~75 ms `total_ms` with no 4-second tail spikes.
- `Cache-Control` on in-progress responses contains
  `stale-while-revalidate=60`.
- New test passes; vitest count stays green.
- Phase 2I + 2J together: cold-render rate (Workers
  invocations with `python_ms > 1000`) drops to <5% of game-
  page requests.

### Acceptance

- `gameonpaper.com` serves traffic from the Worker (verify via
  `cf-ray` header).
- All Playwright E2E tests pass against production Worker.
- Lighthouse perf score on game page is ≥85 (was ~50 baseline).
- Workers Logs shows structured JSON logs with Server-Timing-equivalent
  fields.
- Droplet still running, but Cloudflare DNS no longer points at it
  except for the Python service (handled in Phase 3).

### Notes

#### 2B game.ejs full port (2026-05-03)

The 1501-line `game.ejs` and its four remaining partials
(`slim_box_score`, `field`, `pass_chart`, `rush_chart`) all ship
in this commit. New worker modules:

- `lib/box_score.ts` — `STAT_KEY_TITLE_MAPPING` (130+ entries with
  HTML entities), `TURNOVER_VEC`, the three column-shape sets
  (`NON_RATE_*`), the slim-variant percentile-key + display label
  mappings, `boxScoreRetrievePercentile`, `boxScoreColorRampClass`,
  `geiPercentileBands` (gei chip variant), `handleRates` (8 box
  score sub-tables), `handleSlimBoxScoreRates` (percentile-chip
  cells), `formatDown/formatYardline/formatDistance/formatPeriod`,
  `calculateDETMER`, `isChampionshipEvent`, `sortAdvBoxScoreInPlace`,
  `unique`. All exported as pure functions returning JSX-ready
  cell descriptors so the template stays focused on layout.
- `lib/play_charts.ts` — `computePassMatrix` / `computeRushMatrix`
  (server-side aggregation that the EJS partials did inline),
  `buildFieldRenderScript` (emits the per-drive `render${id}()`
  function body that calls into the global `Field` class loaded
  from `/assets/js/field.js`).

**Decisions made**:
- **JSON-island for charts.** The WP/EP charts, the per-drive
  field charts, and the championship-CSS gate all use the same
  pattern as `Team.tsx` / `Pregame.tsx` — render canvases server-
  side, expose `gameData` as a global, let unmodified
  `/assets/js/{dashboard,field}.js` consume it. Avoided
  re-implementing 600+ lines of Chart.js/D3 wiring in TS.
- **`roundNumberZero` vs `roundNumber`.** game.ejs uses two
  variants of the same function — leaderboard.ts's `roundNumber`
  returns "N/A" for nullish, but game.ejs's coerces null/undefined
  to 0. Box-score cells need the latter so a missing stat renders
  "0.00" rather than "N/A". Both are now exported separately;
  callers pick based on intent.
- **`handleRates` returns descriptors, not strings.** EJS built
  HTML strings; the JSX port returns `BoxScoreCell[]` and lets
  the JSX render the actual `<td>`. Cleaner test surface and no
  `dangerouslySetInnerHTML` for the cell values themselves
  (only the row labels need it for the `&emsp;&emsp;` indents).
- **Field-chart script generation.** field.ejs emits a per-drive
  `<script>function renderXX() { ... }</script>` block; we mirror
  it exactly in `buildFieldRenderScript`, including the offense
  color hex and the "skip these play types" set. The Worker
  bundles the script body and the JSX dangerously-sets it inside
  the drive's expand panel — same `data-bs-toggle="collapse"`
  + `onclick="render${drive.id}()"` shape, so the existing
  Bootstrap accordion behavior works unchanged.
- **`PlayRecord` typing.** Added a fairly tight TS interface for
  plays (start/end/expectedPoints/winProbability/...). The Python
  payload has 200+ keys per play — only the ones the template
  actually reads are typed; the `[key: string]: unknown` index
  signature catches the rest.
- **Test-suite update.** The single test that exercised the stub
  (`renders the stub Game page on a cached completed payload`)
  was updated to (a) provide a properly-shaped play with start/end
  blocks, (b) assert against the new surface — "Win Probability",
  "Drives", "var gameData =" island. Stayed at 128 tests / ~2.9 s.

**Resume hint (next session)**: pick up at sub-phase **2D — Cache
API for per-game PBP**. The KV-based per-game cache in
`lib/games.ts` (key `cfb-game-${id}`) needs to be replaced with
`caches.default` keyed by the request URL. Quarantine check moves
into the Worker. `Cache-Control: public, max-age=86400, s-maxage=31536000`
for completed games; `s-maxage=30` for in-progress. After 2D, do
2E (Workers Static Assets binding so `/assets/*` stops 404'ing in
production — needed for the WP/EP/field charts to actually render
end-to-end against the deployed Worker).

Verification before starting: `cd worker && npx vitest run` should
pass 128 tests in ~2.9s, `npx tsc --noEmit` clean. The token is in
`~/.zshrc`; pull it with `eval "$(grep '^export CLOUDFLARE_API_TOKEN' ~/.zshrc)"`
in any subprocess that needs Cloudflare access.

Worker file layout (as of last commit):

```
worker/
  src/
    index.tsx              ← Hono routes + bindings type
    data/
      glossary.json        ← bundled
      schedule.json        ← bundled (75 KB)
      groups.json          ← bundled (2 KB)
    lib/
      box_score.ts         ← NEW: STAT_KEY_TITLE_MAPPING,
                            TURNOVER_VEC, column-shape sets,
                            handleRates / handleSlimBoxScoreRates,
                            geiPercentileBands, format* helpers,
                            calculateDETMER, isChampionshipEvent
      play_charts.ts       ← NEW: computePassMatrix,
                            computeRushMatrix,
                            buildFieldRenderScript
      games.ts             ← getPBP/peekCachedPBP (KV cache),
                            probeEspnPbp, calculateGEI, cleanName,
                            QUARANTINE_LIST
      glossary.ts
      leaderboard.ts       ← helpers + getPercentileKey + prepare*Rows
      schedule.ts          ← getWeeksMap, getGroups, getGames,
                            prepareGameList, hasActiveGames
      season.ts            ← CURRENT_SEASON, MIN_SEASON
      summary.ts           ← KV-first retrieve* helpers
      teams.ts             ← ESPN getTeamInformation + season variant
      team_helpers.ts      ← cleanLocation/Abbrev, hexToRgb,
                            ordinal, slice cell formatting,
                            spice level, conference map
    templates/
      Layout.tsx           ← shared chrome (head/nav/footer/scripts)
      Glossary.tsx
      Leaderboard.tsx
      PlayerLeaderboard.tsx
      Trends.tsx
      EpaChart.tsx
      Team.tsx             ← multi-season team page
      TeamSeason.tsx       ← per-season team page + 2 inlined
                            partials (TeamPlayerCards, PlayerBox)
      TeamCard.tsx         ← team summary card, shared by
                            TeamSeason + Pregame
      TeamSlice.tsx        ← stat-slice table, shared by
                            TeamSeason + Pregame
      GameThumb.tsx        ← schedule grid card, shared by
                            TeamSeason + Scoreboard
      Scoreboard.tsx       ← /cfb/, /cfb/year/:year, week scoreboard
      GameError.tsx        ← /cfb/game/:id error variants
      Pregame.tsx          ← scheduled-game preview + matchup
                            (matchup partial inlined as subcomponent)
      Game.tsx             ← FULL PORT: chrome + WP/EP charts +
                            slim/advanced box score (8 sub-tables)
                            + per-team player stats with pass/rush
                            matrices + big/important/scoring/all
                            plays tables with collapse rows + drives
                            with per-drive field charts.
                            Subcomponents: SlimBoxScore,
                            BoxScoreTable, PassRow/RushRow/
                            ReceiverRow, PlayerStatsPanel,
                            PassMatrixView, RushMatrixView,
                            PlayRow, PlayTable, DriveRow,
                            DrivesTable, ScoreHeader.
    types/env.d.ts         ← Cloudflare.Env (KV bindings)
  test/                    ← one .test.ts per route + lib unit tests
  wrangler.toml            ← name=sports, KV bindings
  vitest.config.mts        ← cloudflareTest plugin (Vitest 4)
```

#### 2D Cache API for per-game PBP (2026-05-03)

Replaces the KV-backed per-game cache from sub-phase 2B with
`caches.default` keyed by the request URL. Per-branch
Cache-Control:

| Branch | Cache-Control | Reasoning |
|---|---|---|
| Completed game | `public, max-age=86400, s-maxage=31536000` | Bytes the user sees never change. Browser 1 day, edge 1 year. |
| In-progress game | `public, max-age=30, s-maxage=30` | Page auto-refreshes every minute anyway; 30 s lets back-to-back requests collapse without staling the live game. |
| Pregame | `public, max-age=300, s-maxage=300` | Team metadata + matchup percentiles don't shift pre-kickoff but we don't want the cached pregame to outlive the actual kickoff moment. |
| Quarantine | `public, max-age=86400, s-maxage=86400` | Quarantine list is fork-maintained and stable. |
| Pbp/ESPN error | (no header) | Underlying error may resolve when Python/ESPN comes back; never cached. |

Implementation notes:
- `lib/games.ts` shrunk: `getPBP` and `peekCachedPBP` deleted;
  `fetchAndShapePBP` is now public (was internal). The route
  calls Python directly and lets Cache API handle response caching.
- The `?json=1` shortcut and HTML responses key on the same
  request URL automatically — they get distinct cache entries
  because the query string is part of the key.
- Quarantine check moved to the top of the route. Previously it
  ran after the ESPN probe; now it short-circuits before the
  scheduled-game branch (still has to call ESPN once for the
  gameInfo header). Subsequent requests are served from cache,
  so the ESPN call is one-time per quarantined ID per cache TTL.
- Cache writes go through `c.executionCtx.waitUntil(cache.put(...))`
  so the response flows to the user immediately. Tests can't
  observe cross-isolate cache hits in `@cloudflare/vitest-pool-workers`,
  but Cache-Control assertions per branch + production smoke
  (`cf-cache-status: HIT` on the second curl) verify the wiring.
- KV namespaces (`LEAGUE_DATA`, `SUMMARY_LAST_UPDATED`) are
  unchanged — they still back the league/team/percentiles
  caches used by the leaderboards, scoreboard, and
  pregame/game routes for percentile bands.

Production smoke against `sports.unseen-university.workers.dev`:
- `/cfb/game/401411157` (quarantined): first hit MISS, second
  hit `cf-cache-status: HIT`, both with
  `cache-control: public, max-age=86400, s-maxage=86400`.
- `/cfb/game/401628412?preview_mode=new` (pregame): first hit
  MISS, second hit `cf-cache-status: HIT`, both with
  `cache-control: public, max-age=300, s-maxage=300`.
- `/cfb/game/401520434` (Python unreachable → pbp error): no
  `cache-control` header, `cf-cache-status` absent on both
  hits — error responses correctly bypass the cache.

**Resume hint**: pick up at sub-phase **2E — static assets**.
Move `frontend/public/*` to `worker/public/*`, add `[assets]
directory = "./public"` to `wrangler.toml`, verify the
WP/EP/field charts render. The hashed-filename + 1-year
`/assets/*` cache-rule bump can either land in 2E or be
deferred to a later cleanup pass.

#### 2D — discovered constraint: `caches.default` is per-PoP (validated 2026-05-04)

**TL;DR**: Workers' `caches.default` is *per-PoP*, even with
Smart Tiered Cache enabled at the zone level. Tiered Cache
applies to the standard CF cache layer that sits in front of
Workers (driven by Cache Rules), NOT to the Cache API the
Worker code accesses directly via `caches.default`. Validated
empirically on 2026-05-04.

**Why this matters**: the assumption going into 2D was that
Tiered Cache (enabled in Phase 0) would pool game-page
responses globally — i.e. once one viewer warmed any PoP, every
other PoP would pull the response from a regional upper-tier
PoP rather than re-running the Worker against origin. That
assumption was wrong. Each PoP that receives a fresh request
runs the Worker against origin (Python), even if many other
PoPs already have the response cached.

**Test methodology**:

1. Started `wrangler tail --format json` capturing every Worker
   invocation.
2. Picked a unique URL with a timestamped query string
   (`/cfb/game/<quarantined-id>?bust=tieredtest-<unix>`) so it
   couldn't be cached anywhere yet. Quarantined ID specifically
   so the cold render is a fast ESPN probe (~300 ms) without a
   Python pipeline call — fits inside check-host.net's probe
   timeout.
3. Hit the URL from a single laptop (cf-ray showed `ATL` PoP)
   to warm one PoP.
4. Triggered `check-host.net/check-http` against the same URL
   from 10 globally-distributed nodes (UAE / Switzerland /
   Israel / India / Lithuania / Moldova / Singapore / Ukraine /
   Dallas / Atlanta).
5. Read each invocation's structured request log
   (`event:request` JSON line emitted by `lib/timing.ts`
   middleware). Cache HITs show only `cache_lookup_ms` and
   `total_ms`; MISSes also carry `espn_pbp_ms` (the cold-render
   signature for a quarantine response).

**Results**: 10 Worker invocations across 9 distinct PoPs.
Only one HIT — when check-host.net's Atlanta node hit the same
PoP the laptop had already warmed. Every other PoP went to
origin.

| PoP | Source | total_ms | espn_pbp_ms | Verdict |
|---|---|---:|---:|---|
| ATL | laptop (warm) | 600 | 575 | MISS (initial fill) |
| ATL | check-host Atlanta | 3 | — | **HIT** (same-PoP warm) |
| DFW | check-host Dallas | 202 | 184 | MISS |
| VIE | Ukraine | 572 | 548 | MISS |
| ZRH | Switzerland | 523 | 502 | MISS |
| OTP | Moldova | 743 | 730 | MISS |
| FRA | Dubai | 94 | 72 | MISS |
| VNO | Lithuania | 958 | 907 | MISS |
| TLV | Israel | 1497 | 1354 | MISS |
| SIN | Singapore | 1147 | 1130 | MISS |

**Implications**:

- **Pre-warming via cron is mostly useless for game pages.**
  CF Cron Triggers run from a single PoP. A pre-warm hit only
  warms that one PoP; nothing else benefits. Don't spend effort
  on a pre-warmer for `caches.default`-cached routes — it would
  produce one warm PoP and N–1 still-cold PoPs.
- **Origin (Python) cost scales with the number of distinct
  PoPs that see a fresh request, not with viewer count.** For a
  popular game (CFP final, top-25 matchup), expect ~50–80 PoPs
  to each pay one cold render — total ≈ 50–80 × 4 s of Python
  CPU. After that, every viewer in those regions gets ~50 ms
  hits for the rest of the cache lifetime.
- **For a US-centric audience** (the realistic case for this
  fork), 4–6 major PoPs (ATL, DFW, IAD, ORD, LAX, MIA) cover
  most viewers, so cold-start cost is bounded.
- **Tests using `@cloudflare/vitest-pool-workers` already
  documented this** in test/game.test.ts: "Cross-request
  cache-hit verification happens at production smoke time" —
  same per-PoP isolation showed up in the test pool.

**Resolution path planned (2026-05-04)**: this is what
sub-phase **2I** addresses. Add a Cache Rule for
`/cfb/game/*` with **Origin Cache Control** mode — i.e. tell
the standard cache to defer TTL to the Worker's
`Cache-Control` header instead of using a single rule-level
TTL. That sidesteps the "Cache Rules can only match URL
patterns, not response content" trade-off because the per-
branch cache decision is already encoded in the response
headers the Worker emits (long s-maxage for completed,
short for in-progress, none for errors). Standard cache
honors those headers; Tiered Cache pools across PoPs.
See sub-phase 2I for the runbook.

**Side note**: this also explains why pre-warming via cron is
the wrong tool for `caches.default` (asked + dismissed earlier
on 2026-05-04). For KV-backed caches it works fine — those are
globally replicated. For Cache API content, only Cache Rules
carry the global benefit.

#### 2E Workers Static Assets binding (2026-05-03)

`worker/public/` populated from `frontend/public/` via `cp -r`
(9.6 MB, 1424 files; 1371 of those are bootstrap-icons SVGs).
`wrangler.toml` got a single new block:

```toml
[assets]
directory = "./public"
```

No `binding` / `not_found_handling` because:
- The Worker doesn't need to call `env.ASSETS.fetch` itself —
  the runtime serves assets transparently first and falls
  through to the Worker handler on misses (the documented
  default when `run_worker_first` is unset).
- We don't want SPA-style `/foo` → `/index.html` rewriting; the
  default null fallback for asset misses lets the Worker handle
  every dynamic route as it did before.

No template changes required — every Worker template already
references `/assets/...` paths in `extraHead` / `extraScripts` /
inline `<link>` tags from the EJS port. Wrangler diffed and
uploaded only 1422 files (2 were already in CF's content-addressed
asset store, dedup'd by hash).

Production smoke (`sports.unseen-university.workers.dev`):

| Path | HTTP | content-type | cf-cache-status |
|---|---|---|---|
| `/assets/js/dashboard.js` | 200 | `text/javascript` | HIT |
| `/assets/css/index.css` | 200 | `text/css` | HIT |
| `/robots.txt` | 200 | `text/plain` | HIT |
| `/assets/img/favicon.ico` | 200 | `image/vnd.microsoft.icon` | (not set; first hit) |
| `/cfb/glossary` | 200 | `text/html; charset=UTF-8` | (Worker route, not asset) |

Notes:
- `cf-cache-status: HIT` on the *first* curl after deploy
  because Workers Static Assets are pre-populated to edge on
  upload. This is the headline 2E win — no origin trip on any
  asset request.
- Game route still serves the GameError template for
  non-quarantined real game IDs (Python is unreachable from CF
  edge — same posture as the prior commits; resolves at 2H or
  3B). The error template's `<link>`/`<script>` tags now
  resolve correctly though, so the chrome renders fully even
  on the error page.
- Hashed-filename cleanup + Phase 0 cache-rule bump
  (`/assets/*` → 1 year browser TTL, `immutable`) intentionally
  deferred. Worth doing before sub-phase 2H cutover so browser
  caching is tuned, but skipping it costs zero today (edge
  caching is already 1 hour from the Phase 0 rule, and Workers
  Static Assets handles edge dedup transparently).

**Resume hint**: pick up at sub-phase **2F — Cron-warmed
scoreboard**.

#### 2F Cron-warmed scoreboard (2026-05-03)

Adds a `scheduled` handler in `src/index.tsx` that runs every
minute via `[triggers] crons = ["* * * * *"]`. The handler
short-circuits outside football season (Aug 20 – Jan 20), so the
in-season cost is roughly 5 months × 30d × 24h × 60min ≈ 215k
executions/year (well within the Workers Paid plan's allowance).

Scope is narrow on purpose:

- Only the bare `/cfb/` case (year=null, week=null, default
  group=80) reads from the cron-warmed cache.
- Other shapes — `/cfb/?group=-1` (Top-25), `/cfb/?group=82`
  (FCS), the `/cfb/year/...` historical routes — bypass the
  cache and live-fetch via `getGames` as before. The Top-25
  filter is applied post-fetch on the same FBS payload, so in
  principle those calls could share the warmed cache; saved for
  a follow-up if traffic justifies it.

New helpers in `lib/schedule.ts`:

- `writeCurrentScoreboard(kv)` — fetches ESPN
  `site.api.espn.com/.../scoreboard?groups=80` and writes the
  events array to KV at `cfb-scoreboard-80` with a 3-minute
  `expirationTtl`. The cron handler is the only caller.
- `getCachedCurrentScoreboard(kv)` — KV-first reader with ESPN
  fallback + best-effort write-through. The route handler is
  the only caller.
- `isFootballSeason(now?)` — UTC date check for Aug 20+ or
  Jan 1–20. Pure function, exported for the scheduled handler
  to gate work and for tests.

Wrangler entry refactored:

```ts
// before:
export default app;

// after:
export default {
  fetch: app.fetch,
  async scheduled(_event, env, ctx) { ... },
};
```

Cron failures don't take down the cache: KV writes go through
`ctx.waitUntil`, so the `scheduled` handler returns synchronously
and any error is logged via the catch in the chain. The previous
KV value remains valid until its 3-minute TTL expires.

Production smoke (`sports.unseen-university.workers.dev`):

- `wrangler deploy` shows `schedule: * * * * *` registered.
- `curl -sI /cfb/` returns 200; the route's write-through
  populated `cfb-scoreboard-80` with a 479 KB scoreboard
  payload on the first hit.
- Subsequent `/cfb/` curls take ~170 ms and produce no
  ESPN call (ESPN call is ~400 ms on its own); the headline
  steady-state win is roughly 230 ms saved per `/cfb/` hit
  during football season.
- Today is May 3 (off-season), so the cron itself is registered
  but won't fire `writeCurrentScoreboard` until Aug 20.
  `isFootballSeason(now)` returning false is logged as
  `"scoreboard cron: off-season, skipping"` on every minute
  tick. Re-verify in August that the cron starts firing.

Tests added (135 total, +7 from the prior 128):

- `isFootballSeason` boundary tests (Aug 19 / Aug 20 / Jan 20 /
  Jan 21 + a few off-season points).
- `writeCurrentScoreboard` writes to KV, propagates ESPN errors.
- `getCachedCurrentScoreboard` serves from KV when warm,
  falls through to ESPN with write-through on miss.
- `clearScoreboardKv` `beforeEach` added to the existing
  `/cfb/` route tests so the new write-through doesn't bleed
  between test cases.

**Resume hint**: pick up at sub-phase **2G — tests + observability**.
135 vitest assertions already cover the route logic; the still-open
2G tasks are the perf-plan Day 1 carry-forward (Server-Timing
headers on every Worker response, structured JSON logging,
Schema validator porting). After 2G, only sub-phase 2H (cutover)
remains in Phase 2 — and that's gated on the Python proxy gap
resolving via 3B Container or a public Python URL on the droplet.

#### 2G Tests + observability (2026-05-03)

Three pieces of additive work. None require Python reachability,
none change route semantics — pure observability.

**Server-Timing + structured logging** (`lib/timing.ts`). Hono
middleware that:

- Stores `c.var.timings` (a per-request `Record<string, number>`).
- After `next()`, accumulates a `total` measurement and serializes
  the timings into `Server-Timing: name1;dur=N, name2;dur=M` on
  the outgoing response.
- Logs a single structured line per response:
  `{event: "request", method, path, status, total_ms, X_ms, ...}`.

Op names match the Express side (`frontend/cfb/timing.js`) so the
perf-plan baselines stay 1:1 comparable across the two stacks:
`python`, `espn_pbp`, `espn_scoreboard`, `summary`,
`cache_lookup`, `percentiles`, `render`, `total`. Sprinkled
through `index.tsx` at every expensive op:

- `/cfb/game/:gameId`: `cache_lookup`, `espn_pbp`, `python`,
  `summary` (pregame), `percentiles`, `render`.
- `/cfb/`, `/cfb/year/...`: `espn_scoreboard`, plus implicit
  `total`.
- Static-content routes (glossary, healthcheck, redirects):
  just `total`.

`time(c, name, fn)` wraps an async op so its duration accumulates
under `name`; same name fired multiple times sums into one
bucket. Capturing IDs into local consts before the closure was
required in two spots so TS kept the non-null narrowing through
the callback (see the pregame branch's `awayId` / `homeId`).

**JSON Schema validator** (`lib/schema.ts`). Wraps `ajv` +
`ajv-formats` + the canonical `shared/process-response.schema.json`
schema (copied to `worker/src/data/process-response.schema.json`
so wrangler bundles it). Added two npm deps: `ajv`, `ajv-formats`.

The validator runs inside `fetchAndShapePBP` right after the
Python response parses. On schema failure it emits
`{event: "schema_validation_failure", source: "worker", gameId,
error_count, errors}` (truncates errors to first 5) and returns
the payload unchanged. Warn-only — Python is the canonical
validator and rejecting at the Worker boundary would turn schema
drift into user-visible errors.

One TS wrinkle: `ajv.compile(schema)` narrows the validated
value's type to the JSON-Schema's inferred type, which collapses
to `{}` for our loose-everywhere schema and poisons callers'
property access. Worked around with an un-narrowing wrapper:

```ts
const compiledValidator = ajv.compile(schema);
export const validateProcessResponse: ((data: unknown) => boolean) & {
  errors?: SchemaError[] | null;
} = (data) => compiledValidator(data);
```

**Tests** (`test/observability.test.ts`, +6 = 141 total):

- Server-Timing header is set on the redirect response and on
  the glossary response.
- Structured request log is emitted per response with the
  expected fields.
- Schema validator: minimally-valid payload passes; broken
  payload (string where object expected) fails.
- `logSchemaFailure` emits the structured line on stdout.

Production smoke (`sports.unseen-university.workers.dev`):

| Path | Server-Timing |
|---|---|
| `/cfb/glossary` | `total;dur=0` (no upstream) |
| `/cfb/` (KV-warm) | `espn_scoreboard;dur=783, total;dur=783` |
| `/cfb/game/<quarantined>?bust=N` (cache miss) | `cache_lookup;dur=11, espn_pbp;dur=283, render;dur=0, total;dur=294` |
| `/cfb/game/<real-id>?bust=N` (cache miss → pbp error) | `cache_lookup;dur=21, espn_pbp;dur=301, python;dur=4, total;dur=326` |

The `python;dur=4` on the pbp-error path is "we tried Python, the
DNS lookup failed in 4ms" — signal you can grep for in logs
during a Python outage. The 783ms `espn_scoreboard` on the warm
KV path is one-off (probably a cold KV region); steady-state KV
reads are sub-50ms.

**Deferred to 2H**: Playwright preview-URL update. Per-PR
preview deploys + workflow re-wire pair naturally with cutover
since both touch the staging surface.

**Resume hint**: only sub-phase 2H (cutover) remains in Phase 2.
Gated on the Python reachability gap — pick whether to bridge
with a public Python URL on the droplet or move directly to
Phase 3B (Cloudflare Container).

#### 2A scaffolding (2026-05-02)

**Framework: Hono** (`hono@^4.12`).
- Express-like API → least friction porting from `frontend/cfb/routes.js`'s
  `router.route(...).get(...)` shape.
- TS-first; built-in JSX support means we can compile EJS templates to
  Hono JSX components without bringing in a separate template engine.
- Mature on Workers (used by Cloudflare's own examples), much smaller
  than itty-router's plain-Workers alternative once you add a router
  back, and it has first-class testing via `@cloudflare/vitest-pool-workers`.
- Trade-off accepted: ships a small-but-nonzero runtime (~13 KB
  gzipped); itty-router is ~1 KB. Not material at this size of app.

**Worker name: `sports`** (account subdomain: `unseen-university`).
- Resulting *.workers.dev URL: `sports.unseen-university.workers.dev`,
  visually mirrors the production replica `sports.unseen-university.org`.
- Avoids colliding with the eventual upstream Worker if the maintainer
  adopts this approach for the `gameonpaper` zone.
- The fork's GHCR image namespace stays `game-on-paper-experiment`
  (Docker-side identifier); the Cloudflare-side `sports` is independent.

**Toolchain**: `wrangler@4.87`, `typescript@6`, `@cloudflare/workers-types@4.20260502`,
`vitest@4`, `@cloudflare/vitest-pool-workers@0.15`. `compatibility_date`
pinned to today (`2026-05-02`) with `nodejs_compat` flag on.

**Verified locally**: `wrangler dev --local --port 8787` boots, tsc
typechecks clean, three placeholder routes (`/` redirect, `/cfb/`,
`/cfb/healthcheck`) return correctly. Real route ports start in 2B.

**Files**:
- `worker/package.json` — scripts: `dev`, `deploy`, `typecheck`, `test`.
- `worker/wrangler.toml` — name, main, compat date, nodejs_compat.
- `worker/tsconfig.json` — strict, ES2022, JSX via Hono.
- `worker/src/index.ts` — placeholder Hono app.
- `worker/.gitignore` — `node_modules`, `.wrangler`, `dist`, `.dev.vars`.

---

## Phase 3 — Python on Cloudflare Containers (Tier 3)

> **Reordered 2026-05-04**: Phase 3 now sits behind sub-phases
> 2I (Cache Rules + Origin Cache Control) and 2J (stale-while-
> revalidate). 2I/2J target the same goals as Phase 3 (lower
> latency + handle thousands of concurrent users) at a fraction
> of the cost — Cache-layer changes vs. an infrastructure
> migration. If 2I+2J reduce the cold-render rate to <5% of
> game-page requests, Phase 3 demotes from "must-do" to
> "nice-to-have" (the droplet stays simple, the Worker autoscales
> for free, Python only runs on actual cache misses).
>
> Re-evaluate the case for Phase 3 after instrumenting 2I+2J for
> 1-2 weeks of real traffic. If the steady-state Python QPS is
> already low and droplet headroom is comfortable, push Phase 3
> further out.

**Outcome**: Python `/cfb/process` runs as a Cloudflare Container bound to
the Worker. Droplet decommissioned. Both Redis containers gone (replaced by
KV/Cache API in Phase 2). One bill.

**Estimate**: 1–2 weeks.

**Rollback**: Keep the droplet running until end of phase. The Worker can
be flipped back to calling the droplet's Python URL via a single env var
edit and `wrangler deploy`.

### Sub-phases

#### 3A — Image audit

- ☐ Confirm Cloudflare Containers is available on the account
  (Workers Paid plan required, plus Containers eligibility — check
  dashboard or `wrangler containers list`).
  > **USER ACTION**: Confirm Containers access. Pricing is per-second
  > active CPU; idle is cheap. Estimate based on current Python service
  > traffic.
- ☐ Audit the Python image: ensure gunicorn is in (Phase 1). Verify the
  image runs on `linux/amd64` (Cloudflare Containers requirement). Test
  with `docker run --platform linux/amd64 ghcr.io/.../game-on-paper-python`.
- ☐ Add a `/healthcheck` Server-Timing assertion: it should be <50ms
  (cold start excluded). If it isn't, the container init is doing too
  much — investigate before deploying.
- ☐ Push the image to a registry Cloudflare can pull from. Options:
  - GitHub Container Registry (GHCR) with public visibility.
  - Cloudflare's own registry (preferred — no auth dance for Workers).
  > **USER ACTION**: Choose registry strategy. If sticking with GHCR,
  > make sure the image is public or set up registry creds in Cloudflare
  > dashboard.

#### 3B — Container binding

- ☐ Add to `wrangler.toml`:
  ```toml
  [[containers]]
  name = "PBP_PROCESSOR"
  image = "ghcr.io/saiemgilani/saiemgilani/game-on-paper-python:latest"
  instance_type = "basic"  # adjust based on memory needs
  max_instances = 5
  ```
- ☐ Update the Worker's PBP fetch path: replace
  `fetch(env.PYTHON_BASE_URL + '/cfb/process', ...)` with
  `env.PBP_PROCESSOR.fetch('http://container/cfb/process', ...)`.
- ☐ Add an env-controlled toggle so traffic can be split: e.g.,
  `PYTHON_BACKEND=container|droplet`. Lets you A/B during cutover.

#### 3C — Parallel deploy

- ☐ Deploy Worker with `PYTHON_BACKEND=container` to a preview environment.
- ☐ Run the full Playwright suite against the preview. Particular attention
  to: cold start latency, in-progress game refresh, and the OT/quarantine
  fixtures from perf-plan Day 2.
- ☐ Compare snapshot test outputs (perf-plan Day 2) between droplet Python
  and container Python — should be identical (same image).
- ☐ If using `instance_type = "basic"`, monitor memory: pandas pipelines
  routinely peak above 1GB. Bump to `standard` if OOMs occur.

#### 3D — Production cutover

- ☐ Set `PYTHON_BACKEND=container` in production.
- ☐ Deploy: `wrangler deploy --env production`.
  > **DESTRUCTIVE STEP**: confirm with user. Have rollback ready
  > (`PYTHON_BACKEND=droplet` + redeploy, ~60s).
- ☐ Monitor for 48h: error rate, p50/p95 of `/cfb/process` calls (visible
  in Server-Timing logs and Workers Analytics), container instance count,
  memory usage.
- ☐ Once stable, remove the toggle and the droplet URL config.

#### 3E — Decommission droplet + Redis containers

- ☐ Verify nothing in production points at the droplet
  (`dig www.gameonpaper.com`, check Cloudflare DNS).
- ☐ Stop the droplet (don't delete yet — keep as cold-storage rollback for
  1 week).
  > **USER ACTION**: Stop the droplet via DigitalOcean dashboard. Claude
  > shouldn't have DO API access.
- ☐ One week later, after confirming stable production: destroy the
  droplet, delete the deploy SSH keys, archive the
  `.github/workflows/deploy.yml` file (move to
  `.github/workflows/deploy.yml.archived`).
- ☐ Update [README.md](../README.md): remove "Make sure you have Docker
  installed... `docker compose up`" instructions; add new "Local dev:
  `cd worker && wrangler dev`" instructions.
- ☐ Archive [docker-compose.yml](../docker-compose.yml) and
  [docker-compose.do.yml](../docker-compose.do.yml) to a
  `legacy/` directory or delete (git history preserves them).
- ☐ Delete the Redis Dockerfiles ([redis/Dockerfile.cache](../redis/Dockerfile.cache),
  [redis/Dockerfile.lru](../redis/Dockerfile.lru), and the .conf files).
- ☐ Update [CLAUDE.md](../CLAUDE.md) to reflect the new architecture.

### Acceptance

- Production traffic served entirely by Worker + Container; no droplet
  involvement.
- p95 latency on `/cfb/game/:id` cache miss is comparable to or better
  than droplet-era numbers.
- Lighthouse perf score on game page is ≥90.
- Single deploy command (`wrangler deploy`) replaces SSH + docker compose.
- Total monthly bill is lower than droplet-era.

### Notes

_(fill in as you go: instance_type chosen, max_instances, registry chosen,
cutover timeline, post-cutover metrics, decommission date, anything that
broke during container migration)_

---

## Phase 4 — TS + ONNX port (Tier 4) — DEFERRED

**Outcome**: The Python pipeline (data cleaning + XGBoost inference) is
re-implemented in TypeScript using `onnxruntime-web`. No Python in
production. Container removed. Edge-only architecture.

**Why deferred**: This is months of engineering. Realistic only after
Phase 3 is stable for at least a quarter, and only if container compute
costs become a real budget concern OR the cache miss latency on live
games matters at higher traffic.

When the time comes, build a separate `docs/onnx-port-plan.md` with phases
for:

1. Export EP, WP, QBR XGBoost models to ONNX. Verify inference parity in a
   notebook against the Python pipeline output.
2. Move ONNX artifacts to R2.
3. Port `create_box_score` first — it's pure aggregation, no inference.
4. Port the inference call sites with `onnxruntime-web` running in WASM.
5. Port the data-cleaning pipeline (~6000 lines of pandas) incrementally,
   covered by the Day 2 snapshot tests at every step.
6. Decommission the container.

Until that plan is built, leave Phase 4 deferred and revisit annually.

---

## Glossary of decisions deferred to Notes

These show up across multiple phases and need to be documented as soon as
they're made:

- **What terminates TLS at the droplet today** (Phase 0).
- **Cloudflare API token name + permissions used** (Phase 2).
- **Hono vs alternatives for Workers framework** (Phase 2A).
- **Workers Static Assets vs Pages for static files** (Phase 2E).
- **Container instance_type and max_instances chosen** (Phase 3B).
- **Registry used for the Python image** (Phase 3A).
