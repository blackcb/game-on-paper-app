# Claude Code project notes

## What this repo is

Game on Paper — college football play-by-play analytics. Three services in Docker
Compose deployed to a DigitalOcean droplet:

- `frontend/` — Express 4 + EJS, port 8000. SSR for all pages. Entry: [frontend/server.js](frontend/server.js), routes in [frontend/cfb/routes.js](frontend/cfb/routes.js).
- `python/` — Flask, port 7000. Single endpoint `/cfb/process` that runs `sportsdataverse.cfb.cfb_pbp.CFBPlayProcess` (XGBoost EP/WP/QBR models + heavy pandas pipeline). Entry: [python/app.py](python/app.py).
- `redis/` — two Redis instances: LRU (port 6379, league/team summaries, 3-day TTL) and game cache (port 6380, per-game PBP, 60s TTL).
- Plus an external `summary` container (`ghcr.io/akeaswaran/akeaswaran/cfb-team-summaries`) for team aggregates.

Deploy: GH Actions → SCP `docker-compose.do.yml` → SSH `docker compose up -d`. See [.github/workflows/deploy.yml](.github/workflows/deploy.yml).

## Active work

Three parallel plans live under `docs/`. All use the same resume convention:
checkboxes (`☐`/`☑`), per-section Status block at the top, per-section Notes
subsection for decisions, `> USER ACTION:` and destructive-step gates honored
even in autopilot.

- **[docs/replica-deploy-plan.md](docs/replica-deploy-plan.md)** — DONE.
  `sports.unseen-university.org` is live and serving. DigitalOcean
  droplet at 137.184.138.84, Caddy reverse proxy with Cloudflare Origin
  Cert, UFW locked to Cloudflare IPs only, GitHub Actions auto-deploys
  on push to `instrument-plus-cloudflare-cdn`. A 5-min mobile Lighthouse
  run is the only optional follow-up.
- **[docs/perf-plan.md](docs/perf-plan.md)** — **DONE**. All 5 days
  shipped. Day 1 baseline + instrumentation. Day 2 Python snapshot
  tests with three captured ESPN fixtures. Day 3 Playwright E2E.
  Day 4 JSON Schema contract (pydantic + ajv). Day 5 Lighthouse CI
  with warn-level thresholds and a perf-score floor. Re-baseline +
  tighten Lighthouse thresholds after each migration phase per the
  schedule in Day 5 Notes.
- **[docs/migration-plan.md](docs/migration-plan.md)** — Multi-phase plan
  to migrate to Cloudflare (CDN → quick-win bug fixes → Worker rewrite →
  Containers → optional ONNX port). **Phase 0 (CDN cache rules) is now
  unblocked** — the replica gives us a real before/after frame. Phase 1
  has accumulated five fork-discovered upstream bugs. When asked to
  "continue the migration", start at Phase 0.

If unsure which plan an ambiguous request maps to, ask. Recommended order:
replica deploy → perf-plan day 2+ in parallel with migration phase 0+.

## Conventions

- Tests live in [python/tests/](python/tests/) (pytest, `pytest.ini` configures
  the `integration` marker — deselected by default; opt-in with `-m integration`).
- No frontend tests exist yet (Day 3 of the perf plan adds Playwright).
- Python uses `ruff`-compatible style; no formatter configured.
- Frontend has no lockfile checked in yet.

## Things to know before changing code

- `/cfb/process` exception handling collapses any `KeyError` into a 404 with
  message "ESPN payload is malformed" ([app.py:260-269](python/app.py#L260)).
  This masks real bugs in the per-record reshape — don't trust 404s as
  upstream-data issues without reading the trace.
- The per-record reshape ([app.py:82-205](python/app.py#L82)) is fragile to
  sportsdataverse column renames; the snapshot tests added in Day 2 of the
  perf plan are designed to catch this.
- `Games.getPBP(req, res)` is called in the POST handler at
  [routes.js:490](frontend/cfb/routes.js#L490) but the function expects a
  string `gameId` — likely a latent bug.
- Two Redis instances, but only one has an eviction policy. The "cache"
  instance ([redis/cache.conf](redis/cache.conf)) has no `maxmemory-policy`,
  so writes past 1GB return OOM errors instead of evicting.
- `frontend/public/assets` ships ~17MB including Bootstrap source maps and
  duplicate JS bundles — most of it is never used. Asset cleanup is part of
  the broader Cloudflare migration plan, not the perf plan.
