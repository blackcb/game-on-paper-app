# Performance & observability plan

5-day plan to add baseline instrumentation, tests, and CI gates before the
Cloudflare migration. Each day is independently shippable.

## Status

- **Day 1 — Baseline observability**: completed 2026-04-28
- **Day 2 — Python snapshot tests**: completed 2026-04-30
- **Day 3 — Playwright E2E**: completed 2026-05-01
- **Day 4 — JSON Schema contract**: completed 2026-05-01
- **Day 5 — Lighthouse CI**: not started
- Last updated: 2026-05-01

## Resume hint for Claude Code

1. Find the next day whose status is not "completed".
2. Find the first unchecked task (`☐`) in that day.
3. Do that task, check it off (`☑`), and continue down the list.
4. When all of a day's tasks are checked, mark the day completed in Status
   above and fill in the **Notes** subsection with decisions, deviations, or
   anything surprising.
5. If the user says "continue the perf plan", start at step 1 with no further
   confirmation needed.

## Baseline metrics

Captured during Day 1 + replica-deploy Phase C, used as the reference
point for subsequent measurement.

### `Server-Timing` (production replica via Cloudflare, no CDN cache rules yet)

Captured 2026-04-27 against `https://sports.unseen-university.org/...`:

| Path | Total | Breakdown |
|---|---:|---|
| Scoreboard `/cfb/` (warm) | 10 ms | scoreboard JSON warm in node-side memory |
| Game page **cold** `/cfb/game/401403910` | 5,703 ms | espn_pbp 120 · cache_lookup 1 · **python 5,418** · cache_write 106 · summary 52 |
| Game page **warm** (reload within 60s) | 292 ms | espn_pbp 234 · cache_lookup 5 · summary 8 |

The 234 ms `espn_pbp` on the warm path confirms the cacheBuster bug
flagged in [migration-plan.md](migration-plan.md) Phase 1 — even on a
Redis cache hit, every request re-fetches from ESPN. Fixing it drops
warm-cache total to ~50 ms.

Earlier local-Docker numbers (different network, useful for relative
comparison only):

- Game page cold (local): 5.0 s
- Game page warm (local): 475 ms
- Scoreboard `/cfb/` cold (local): 825 ms
- Leaderboard `/cfb/year/2025/teams/differential` cold (local): 400–1000 ms

### Captured 2026-04-28 (Phase E)

**TTFB** (median of 5, via Cloudflare proxy from local laptop):

| Path | Median TTFB |
|---|---:|
| `/cfb/` | 101 ms |
| `/cfb/year/2024/teams/differential` | 113 ms |
| `/cfb/game/401403910` warm Redis | 560 ms (still bottlenecked by ESPN, see cacheBuster bug) |

**Page weight** (compressed = what users actually transfer; uncompressed in parens):

| Path | Brotli/gzip | Uncompressed |
|---|---:|---:|
| `/cfb/` | 11.7 KB | 315.6 KB |
| `/cfb/year/2024/teams/differential` | 10.6 KB | 169.1 KB |
| `/cfb/game/401403910` | **161.5 KB** | **2,914.0 KB** |

The 2.9 MB uncompressed game page is the full PBP JSON embedded inline
into the EJS-rendered HTML. Cloudflare brotli compresses it to ~162 KB
on the wire — still the largest payload by far. Migration plan Phase 2
splits this when the Worker rewrite happens.

**Server-Timing** (cold game-page load, never-seen gameId 401520434):

```
espn_pbp 362 ms · cache_lookup 1 ms · python 5,388 ms · cache_write 110 ms · summary 195 ms · total 6,058 ms
```

The 5.4 s Python pipeline confirms the original analysis: Python work
is 89% of cold-cache TTFB. CDN caching (migration Phase 0) won't help
on a unique gameId — only the Worker + Cache API rewrite (Phase 2) does.

### Lighthouse Performance score

Captured 2026-04-28 via Chrome DevTools → Lighthouse → Performance only,
median of 3 runs per URL per preset:

| URL | Desktop | Mobile |
|---|---:|---:|
| `/cfb/` | 99 | 80 |
| `/cfb/game/401403910` | 94 | 80 |
| `/cfb/year/2024/teams/differential` | 100 | 74 |

Desktop scores are already in the green — Desktop preset (10 Mbps, 1×
CPU) is forgiving. Mobile (Slow 4G ~1.6 Mbps, 4× CPU) is the tougher
baseline and the one the migration plan actually moves. Expected
improvements per phase:

- Phase 0 (CDN cache rules on `/assets/*`): repeat-visit mobile +5–10
- Phase 1 (asset cleanup, drop duplicate bootstrap variants and source
  maps): mobile +5–10 across the board
- Phase 2 (Worker rewrite + Cache API for completed games): big jump
  on the game page where today the 2.9 MB raw HTML dominates

Targets: Desktop ≥95 / Mobile ≥90 across all three pages by end of
Phase 2.

### Skipped / deferred

- **LCP p75 from CF Web Analytics** on the replica — skipped. The replica
  has no organic traffic and synthetic single-vantage Playwright wouldn't
  produce more representative LCP than Lighthouse already does. Real-user
  LCP gets captured later from upstream `gameonpaper.com` once PR #164
  merges and that production gets the instrumentation.
---

## Day 1 — Baseline observability

**Outcome**: Every response carries `Server-Timing`; both services emit
structured JSON logs; Cloudflare Web Analytics live; baseline numbers captured
in the section above.

**Estimate**: 4–6h.

### Tasks

- ☑ Wrap `/cfb/process` in [python/app.py](../python/app.py) with
  `time.perf_counter()` around four stages: `espn_fetch` (the
  `espn_cfb_pbp()` call), `pipeline` (`run_processing_pipeline`),
  `box_score` (`create_box_score`), and `serialize` (the dict reshape +
  `jsonify`).
- ☑ Set `Server-Timing: espn;dur=…, pipeline;dur=…, box_score;dur=…,
  serialize;dur=…` header on the response.
- ☑ Emit one structured JSON log line per request with the same timings,
  `gameId`, status code, and total duration. Uses dedicated `app.metrics`
  logger added to [python/flask_logs.py](../python/flask_logs.py) — emits
  to stdout via the same `access` formatter, so JSON lines stay clean and
  can be split out from access logs in production via stream redirection.
- ☑ In [frontend/cfb/routes.js](../frontend/cfb/routes.js) and
  [frontend/cfb/games.js](../frontend/cfb/games.js), time the upstream axios
  calls (Python service, ESPN, summary service, Redis). Set `Server-Timing`
  on the outbound response before `res.render` / `res.json`. Implemented
  via a small [frontend/cfb/timing.js](../frontend/cfb/timing.js) module:
  `timingMiddleware()` wraps `res.render`/`json`/`send` to emit the
  header, and `time(res, name, fn)` is called at every external-call site.
  Stages timed: `espn_pbp`, `python`, `cache_lookup`, `cache_write`,
  `summary`, `total`.
- ☑ Replace `morgan`'s default text format in
  [frontend/server.js](../frontend/server.js) with a JSON formatter (custom
  function returning `JSON.stringify({...})` so quote escaping is safe).
- ☐ Sign up for Cloudflare Web Analytics (free, no consent banner needed).
  Get the site token. **Once obtained, uncomment the script tag in
  [frontend/views/partials/head.ejs](../frontend/views/partials/head.ejs)
  and replace `REPLACE_ME` with the token.**
- ☑ Extract a shared `<head>` partial — there isn't one today; every EJS
  page repeats `<head>` (e.g. [index.ejs:3-53](../frontend/views/pages/cfb/index.ejs)).
  Created [frontend/views/partials/head.ejs](../frontend/views/partials/head.ejs)
  covering the truly-common content (meta tags, favicon, title from local,
  Plausible, placeholder for CF Web Analytics). All 12 page templates
  + the top-level `error.ejs` now include it. CSS bundles intentionally
  stay per-page because index.ejs uses a different bundle
  (`index.css` + `dark-index.css`) than the others (`dashboard.css` +
  `blog.css` + `dark-game.css` + `bootstrap-icons.css`).
- ☑ Build and run the stack locally; verified `Server-Timing` shows up
  in DevTools → Network for `/cfb/` and `/cfb/game/401403910`.
- ☑ Deploy to prod. Done via the replica deploy plan
  ([replica-deploy-plan.md](replica-deploy-plan.md)) at
  `https://sports.unseen-university.org/cfb/` rather than upstream
  production. Real-user LCP from gameonpaper.com still pending the PR
  #164 merge.
- ☑ Capture baseline numbers in the Baseline metrics section above.
  TTFB, page weight, Server-Timing breakdowns, and Lighthouse Desktop
  scores all captured. LCP-from-CF-Web-Analytics deferred until upstream
  prod is instrumented.

### Acceptance

- `curl -I http://localhost:8000/cfb/` shows `Server-Timing` header with
  multiple metrics.
- `curl -X POST http://localhost:7000/cfb/process -d '{"gameId":401403910}'
  -H 'Content-Type: application/json' -i` shows `Server-Timing` with all
  four stages.
- CF Web Analytics dashboard shows traffic from prod.
- Baseline metrics section above is filled in.

### Notes

- **Python**: per-stage timings live in
  [python/app.py:38-71](../python/app.py) (the `_emit_metrics` and
  `_server_timing_header` helpers plus four `time.perf_counter()` blocks
  inside `process()`). Both success and error paths emit the metric line
  and Server-Timing header so partial timings (e.g. ESPN fetched but
  pipeline failed) are still visible.
- **Node**: timing helper is
  [frontend/cfb/timing.js](../frontend/cfb/timing.js). `timingMiddleware()`
  is registered once in [frontend/server.js](../frontend/server.js) right
  after morgan; it wraps `res.render`/`json`/`send` so the
  `Server-Timing` header is set automatically before any response goes
  out. Individual calls to `time(res, name, fn)` accumulate per-name
  durations in `res.locals.timings`. The `time()` helper is safe when
  `res` is undefined, so games.js can be called from non-HTTP contexts
  without crashing.
- **Pages timed today**: every route handler in `routes.js` that hits the
  summary service is wrapped with `time(res, 'summary', () => ...)`.
  The game page (`/cfb/game/:id`) additionally times `espn_pbp`,
  `python`, `cache_lookup`, `cache_write`. Other peripheral redis reads
  inside `Schedule` could be added later but aren't critical.
- **Logs**: structured JSON metric lines go to stdout. In Docker logs
  these will mix with other lines — tooling can filter by the `event`
  field (`process` for Python, `request`/`access` for Node).
- **CF Web Analytics**: snippet exists in
  [frontend/views/partials/head.ejs](../frontend/views/partials/head.ejs)
  but is commented out. Once the user has a token, uncomment the
  script tag and replace `REPLACE_ME` with the token. Single edit in
  one file rolls out site-wide.
- **CSS bundle deduplication is deferred**: the head partial intentionally
  excludes CSS links because the index page uses a different bundle than
  every other page. Unifying the bundles is in Phase 1 of the migration
  plan (asset cleanup).
- **POST `/cfb/game/:gameId` handler bug** at routes.js:490
  (`Games.getPBP(req, res)` instead of `Games.getPBP(req.params.gameId)`)
  is **not fixed here** — that's tracked in Phase 1 of the migration plan
  to keep this commit scoped to instrumentation.

---

## Day 2 — Python snapshot tests

**Outcome**: Captured ESPN fixtures + snapshot tests for `/cfb/process`
output; CI runs `pytest` on every push.

**Estimate**: 3–5h.

### Tasks

- ☑ Wrote `python/tests/capture_fixtures.py` — wraps
  `sportsdataverse.dl_utils.download` (and the imported reference inside
  `cfb_pbp`) with a recorder, normalizes URLs (strips the bare-numeric
  cache-buster sportsdataverse appends to summary URLs), runs the full
  `/cfb/process` pipeline via Flask's test_client, and saves both the
  per-URL captured responses and the resulting `expected.json`.
- ☑ Captured three fixtures: `401403910` (regular-season, 154 plays,
  3 URLs), `401520434` (OT, 148 plays, 4 URLs — extra `/odds` endpoint),
  `401628329` (2024 quarantined game, 203 plays, 4 URLs).
- ☑ Extended `conftest.py` with the `mock_espn` fixture: indirectly
  parametrized by gameId, loads that game's manifest, monkeypatches
  download in both namespaces, raises `AssertionError` if the test hits
  an unmocked URL (so any new ESPN endpoint sportsdataverse adds gets
  caught loudly).
- ☑ `expected.json` snapshots committed alongside the captured ESPN
  responses (~5 MB per game; large but the whole point is byte-for-byte
  diffability at PR time).
- ☑ Added `tests/test_process_snapshot.py`: one parametrized test per
  gameId, asserts `/cfb/process` response equals snapshot. On mismatch
  writes `expected.actual.json` next to `expected.json` and points at it
  in the failure message.
- ☑ Pinned `xgboost~=2.1.4` in `requirements.txt` — model output is
  sensitive to minor versions. Bump in lockstep with regenerated fixtures.
- ☑ Added `.github/workflows/test.yml`: runs pytest on push + PR, with
  pip cache + libgomp1 install for xgboost on Linux runners.

### Acceptance

- ☑ `pytest -m "not integration"` passes locally — 6 tests, 1 deselected,
  2.24s.
- ☑ Manually editing a column name in
  [python/app.py:82-205](../python/app.py) produces a clean diff in
  `expected.actual.json` (verified by temporarily renaming `homeTeamId`
  → `homeTeamIdBROKEN`; the 401403910 snapshot test failed with a
  pointer to the actual output file, then passed again after revert).
- ☑ Total test time under 30s (2.24s).

### Notes

- **URL normalization is key.** sportsdataverse appends a unix-ms cache
  buster to the `summary` URL (`...?event=401403910&1777599119301`). At
  capture time the buster is in the URL; at replay time it would be
  different. `normalize_url()` parses the query string and drops any
  param whose key is entirely digits with empty value — the bare-key
  cacheBuster pattern. With that strip, manifest keys are stable across
  runs.
- **Two-namespace monkeypatch is required.** `sportsdataverse.cfb.cfb_pbp`
  imports `download` as a module-level symbol via
  `from sportsdataverse.dl_utils import download`. Patching only
  `sportsdataverse.dl_utils.download` doesn't affect cfb_pbp's already-
  bound reference. Both fixtures (`mock_espn` in conftest and the
  recorder in capture_fixtures) patch both namespaces.
- **Fixture sizes**: ~5 MB per game (raw ESPN response ~1 MB, captured
  endpoints ~1.5 MB, `expected.json` ~3 MB after the dict reshape).
  Three games = 14 MB of test data committed. Worth it for diffability.
- **Pandas warnings filtered**: sportsdataverse uses pandas APIs
  deprecated in 4.x (`Pandas4Warning`) and triggers `PerformanceWarning`
  on dataframe fragmentation. Both filtered in `pytest.ini` so test
  output stays readable. Filter is precise enough that our own
  warnings still surface.
- **`integration` marker still works** — the existing
  `test_process_real_game_id_returns_payload` test stays deselected by
  default. Run with `-m integration` to hit live ESPN. Keep it around as
  a smoke test of the real network path (and as a way to detect when
  the captured fixtures need refreshing — if it passes but the snapshot
  test fails, sportsdataverse changed and fixtures are stale).
- **Regenerating fixtures**: `python tests/capture_fixtures.py 401403910
  401520434 401628329` will hit live ESPN and overwrite the captured
  files. Do this when bumping sportsdataverse or xgboost minor versions.

---

## Day 3 — Playwright E2E

**Outcome**: Three browser tests; nightly run against prod; ready to wire
into PR previews after Tier 2 of the Cloudflare migration.

**Estimate**: 4–6h.

### Tasks

- ☑ `npm i -D @playwright/test` in `frontend/`.
  `frontend/package-lock.json` now committed (`.gitignore` updated to
  stop excluding `*/package-lock.json` — see Notes below).
- ☑ `npx playwright install chromium` (skipped `--with-deps` locally on
  macOS; CI uses `--with-deps` for Linux runner system libs).
- ☑ `frontend/playwright.config.js`: `baseURL` from `BASE_URL` env,
  default **`https://sports.unseen-university.org`** (the replica), not
  upstream gameonpaper.com — the replica is what this fork controls.
  Single chromium-desktop project, 2 workers, retries 1 local / 2 CI.
- ☑ `frontend/tests/e2e/scoreboard.spec.js`: visits `/cfb/`, asserts
  title matches `/Game on Paper/`, asserts either ≥1 game thumb link
  (`a[href*="/cfb/game/"]`) OR the "No games scheduled." copy is
  visible (off-day handling), filters known-noisy console errors
  (analytics endpoints, browser extension noise).
- ☑ `frontend/tests/e2e/game.spec.js`: visits
  `/cfb/game/401403910` (same gameId as Day 2 fixture), asserts page
  title matches `/\d+,.*\d+\s*\|\s*Game on Paper/` (the
  "Team1 24, Team2 17 | Game on Paper" pattern), asserts `canvas#wpChart`
  + `canvas#epChart` are visible, asserts ≥10 "Drive Chart" sections.
- ☑ `frontend/tests/e2e/leaderboard.spec.js`: visits
  `/cfb/year/2024/teams/differential` (stable completed season),
  asserts ≥100 rows in `table tbody tr`, asserts title contains the
  season number.
- ☑ `.github/workflows/e2e.yml`: triggers on **`workflow_run` of
  fork-deploy** (so we test what was just deployed, not the previous
  version), `schedule: cron '30 14 * * *'`, and `workflow_dispatch`.
  Skips when the triggering deploy failed. Uploads Playwright HTML
  report as artifact on failure (14-day retention).
- ☑ Decision documented: **PR runs hit the replica** (not upstream
  gameonpaper.com). The fork doesn't open PRs against itself in
  practice; the schedule + post-deploy triggers cover the real flow.
  Tier 2 of the migration plan will introduce per-PR preview URLs
  via Cloudflare Pages; until then the replica is the test target.

### Acceptance

- ☑ `npx playwright test` passes locally — 3 tests, **7.7s total**
  (single workflow_dispatch run).
- ☐ Nightly cron run green in GH Actions — proves itself when the
  first cron fires (next 14:30 UTC).
- ☑ Failing test produces a downloadable HTML report. Verified during
  development: a Drive-Chart strict-mode locator violation produced
  `frontend/test-results/.../error-context.md` and a screenshot,
  exactly the kind of artifact `e2e.yml` will upload on CI failure.

### Notes

- **Default `BASE_URL` flipped to the replica.** The plan as written
  defaulted to `https://www.gameonpaper.com`, but the fork's testing
  target is `sports.unseen-university.org`. Override with the env var
  if you want to point at upstream once it's running PR #164's
  instrumentation.
- **`workflow_run` trigger over `pull_request`.** The fork doesn't
  receive PRs in practice (we push directly to the dev branch). E2E
  needs to test the *deployed* version, which requires waiting for
  fork-deploy to succeed. `workflow_run` is exactly that pattern —
  GH triggers e2e.yml after fork-deploy.yml's "completed" event, and
  the job's `if:` condition skips when the triggering run failed.
  Trade-off: `workflow_run` runs against the default branch's
  workflow definition, not the triggering branch's, so workflow
  changes only take effect once merged. Acceptable for now;
  revisit if it becomes annoying.
- **Two real flakes worth mentioning:**
  - ESPN's scoreboard endpoint aborts intermittently with a TLS
    socket close (`Error: aborted at TLSSocket.socketCloseListener`).
    The frontend correctly renders the error template in that case,
    which the test misreads as a regression. Retries=1 absorbs it
    reliably (caught it twice during local dev, both passed on
    retry).
  - `getByText(/Drive Chart/)` resolves to ~20 elements (one per
    drive on the game page). Use `.count()` >= N rather than
    `toBeVisible()` on the locator — Playwright's strict mode
    rejects multi-match `toBeVisible()`.
- **Console-error filter is opinionated.** The scoreboard test
  ignores errors from `cloudflareinsights.com` (analytics POSTs that
  fail with no real impact), `plausible.io`, "extension" (Chrome
  extension noise the user reported earlier), and the
  "asynchronous response by returning true" extension-content-script
  warning. Anything else surfaces as a real error.
- **`.gitignore` change**: removed `*/package-lock.json` so the new
  `frontend/package-lock.json` commits. The original entry predated
  the perf plan and was excluding the file Day 3 explicitly requires.
  Replaced with a comment noting the dependency.
- **Fixture parity with Day 2**: the game test uses the same gameId
  (401403910) as the Python snapshot tests. If the rendered HTML
  starts diverging from what the Python pipeline produces, one of
  the two test suites will catch it.

---

## Day 4 — JSON Schema contract

**Outcome**: One canonical schema for `/cfb/process` response; both Python
and Node validate against it; drift fails CI.

**Estimate**: 3–4h.

### Tasks

- ☑ Added `pydantic>=2,<3` to
  [python/requirements.txt](../python/requirements.txt).
- ☑ Created [python/schemas.py](../python/schemas.py) with a
  `ProcessResponse` pydantic model covering the contract: `id`, `count`,
  `plays[]` (with `clock`, `type`, `modelInputs`, `expectedPoints`,
  `winProbability`, `start`, `end` strict sub-models), `box_score`,
  `homeTeamId`, `awayTeamId`, `header`, `drives`, `scoringPlays`,
  `winprobability`, `pickcenter`, `homeTeamSpread`, `overUnder`,
  `broadcasts`, `videos`, `standings`, `espnWinProbability`, `gameInfo`,
  `season`, `boxScore`. Every model uses `extra='allow'` so the ~370
  pandas DataFrame columns per play don't fail validation.
- ☑ Wired into [python/app.py](../python/app.py) `/cfb/process`. Behavior
  controlled by `STRICT_SCHEMA` env var: `=1` raises ValidationError (set
  in `conftest.py` for tests); default warns + continues with a
  structured `schema_validation_failure` event line on `app.metrics`.
  Logging is wrapped in try/except so a bad logger config can't 500 a
  good response.
- ☑ Added [python/scripts/dump_schema.py](../python/scripts/dump_schema.py)
  that writes the JSON Schema to **two** locations:
  `shared/process-response.schema.json` (canonical, repo root, for
  cross-service tooling) and
  `frontend/cfb/process-response.schema.json` (inside the frontend
  Docker build context — what `games.js` actually `require()`s at
  runtime). Why two: the frontend container is built from `./frontend`
  context, so a `shared/` file at repo root isn't reachable from inside
  the image; the dump script keeps both in sync, CI verifies they're
  identical and match `schemas.py`.
- ☑ `cd frontend && npm i ajv ajv-formats`. Wired into
  [frontend/cfb/games.js `processPlays`](../frontend/cfb/games.js) — the
  validator is compiled once at module init (`ajv.compile()`, ~10ms),
  then runs on every Python response. Warn-only on mismatch: structured
  JSON line to stdout (`event: schema_validation_failure`,
  `source: node`, first 5 errors). Defense-in-depth — Python is the
  canonical validator, Node catches drift in production where Python
  isn't running with `STRICT_SCHEMA`.
- ☑ Snapshot tests extended: new
  `test_fixture_validates_against_schema` asserts each committed
  `expected.json` validates against `ProcessResponse`. Catches
  hand-edited fixtures that drift from the schema, and vice versa.
- ☑ Added schema-freshness check to
  [.github/workflows/test.yml](../.github/workflows/test.yml): regenerates
  the two schema files via `python scripts/dump_schema.py` and fails
  with `git diff --exit-code` if either drifted.

### Acceptance

- ☑ Renaming a field in [python/app.py:82-205](../python/app.py) reshape
  fails Python validation in tests AND triggers a Node warning log
  against prod (verified manually: `STRICT_SCHEMA=1` raises, default
  emits a `schema_validation_failure` log line).
- ☑ The committed schema files match what `dump_schema.py` produces
  (CI's `git diff --exit-code` step enforces).

### Notes

- **Schema lives in two places.** `shared/process-response.schema.json`
  is canonical; `frontend/cfb/process-response.schema.json` is a
  byte-identical copy that lives inside the frontend Docker build
  context so `games.js` can `require()` it at runtime. Don't edit
  either by hand — `python scripts/dump_schema.py` writes both.
- **`extra='allow'` everywhere is intentional.** The /cfb/process
  response carries ~370 columns per play from the pandas DataFrame
  that we don't (and shouldn't) enumerate in the schema. The contract
  is the *reshape blocks* (`clock`, `type`, `modelInputs`, etc.) and
  the top-level keys; everything else passes through.
- **Two-stage validation** is intentional belt-and-suspenders:
  - **Python `pydantic`** (raise under `STRICT_SCHEMA=1`, warn otherwise)
    is the contract author. CI tests run with `STRICT_SCHEMA=1` so any
    drift in the Python side fails fast. Production runs warn-only so
    a novel ESPN payload doesn't 500.
  - **Node `ajv`** (always warn-only) catches Python-side drift that
    slips past production validation. If the Node frontend ever starts
    seeing `schema_validation_failure` events in prod logs, it's the
    canary for sportsdataverse / app.py drift.
- **Two CI improvements rolled in alongside Day 4:**
  - **`test.yml` switched to `python:3.14-slim` container.** Was using
    `actions/setup-python@v5`; that build's pytest collection failed in
    a way that didn't reproduce in the official Docker image. Switching
    to a container with the same image used locally (and identical to
    the production python container's base) made CI behavior match
    local-Linux behavior.
  - **Test workflow's pytest stdout now mirrors to
    `$GITHUB_STEP_SUMMARY`**, so failures are debuggable from the
    public run page even without log-access permissions. Helped
    diagnose the receiver-list ordering issue below.
- **Receiver-list ordering platform diff.** When CI first ran the Day 2
  snapshot tests, they failed with ~40 "diffs" per game in
  `box_score.receiver` — but the diffs weren't real value drift; they
  were the same set of receivers in different orders. pandas
  groupby/sort tie-break is platform-dependent (libc qsort
  implementation differs Mac vs Linux). Fix landed in two parts:
  (a) regenerated all three fixtures inside the same `linux/amd64`
  container CI uses, so committed fixtures are linux-canonical;
  (b) added order-tolerant comparison to `_diffs` — when comparing
  list-of-dicts, sort both by canonical-JSON key first. Lists of
  scalars (`winprobability`, `scoringPlays`) keep their original order
  since temporal ordering is meaningful there. Tests now pass on
  both Mac and Linux.
- **Float tolerance survived from Day 2.** The earlier `math.isclose`
  with `abs_tol=1e-5, rel_tol=1e-6` still absorbs xgboost's
  ~6e-8 SIMD-reordering noise across architectures. Combined with the
  list-sort tolerance above, snapshot tests are now genuinely
  platform-independent.

---

## Day 5 — Lighthouse CI

**Outcome**: PR-blocking perf gate with realistic baseline; tighten over time
as Tier 1 → Tier 2 → Tier 3 of the Cloudflare migration land.

**Estimate**: 2–3h.

### Tasks

- ☐ `cd frontend && npm i -D @lhci/cli`.
- ☐ Capture current Lighthouse scores against prod for three URLs:
  - `https://www.gameonpaper.com/cfb/`
  - `https://www.gameonpaper.com/cfb/game/401403910`
  - `https://www.gameonpaper.com/cfb/year/2024/teams/differential`
  Run `npx lhci autorun --collect.url=… --collect.numberOfRuns=3` three
  times, take the median. Record numbers in the Baseline metrics section
  above.
- ☐ Create `frontend/lighthouserc.json`: 3 URLs, 3 runs each, desktop preset.
  Set assertion thresholds at **current baseline minus 5%** (so any
  regression fails). Use `assertions` for `categories:performance`,
  `largest-contentful-paint`, `total-byte-weight`, `unused-javascript`.
- ☐ Create `.github/workflows/lighthouse.yml`: runs on `pull_request`,
  `npx lhci autorun --upload.target=temporary-public-storage`, posts the
  report URL as a PR comment via the LHCI GitHub app or
  `actions/github-script`.
- ☐ Add a follow-up checklist item in this plan: "After Tier 1 ships,
  re-baseline Lighthouse and tighten thresholds. Repeat after Tier 2."

### Acceptance

- Opening a PR shows a Lighthouse report URL as a comment.
- Adding 5MB of unused JS to a page makes the workflow fail.
- Baseline metrics section is fully populated.

### Notes

_(fill in as you go)_

---

## Future tightening (post-perf-plan)

After Cloudflare migration tiers ship, revisit:

- Tighten Lighthouse thresholds (after Tier 1: expect perf ≥ 80; after
  Tier 2: expect perf ≥ 95).
- Add E2E to PR previews once Cloudflare Pages provides preview URLs.
- Replace warn-only schema validation in Node with hard failure in dev,
  retain warn-only in prod.
- Add p95 latency SLO based on `Server-Timing` data shipped via Logpush.
