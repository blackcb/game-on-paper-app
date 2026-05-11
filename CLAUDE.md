# Claude Code project notes

## What this repo is

Game on Paper — college football play-by-play analytics, running on
Cloudflare Workers + Containers.

- `worker/` — Hono on Cloudflare Workers. SSR for all pages, KV-backed
  league/team data, `caches.default` for per-game PBP, static assets
  via the `[assets]` binding, cron-warmed scoreboard. Entry:
  [worker/src/index.tsx](worker/src/index.tsx). Config:
  [worker/wrangler.toml](worker/wrangler.toml).
- `python/` — Flask, port 7000. `/cfb/process` (GET + POST) runs
  `sportsdataverse.cfb.cfb_pbp.CFBPlayProcess` (XGBoost EP/WP/QBR
  models + heavy pandas pipeline). `/cfb/process/replay` is the
  synthetic-in-progress fixture-replay endpoint used by the load-
  test harness. Runs both as the `sports-pythoncontainer` Cloudflare
  Container AND as the legacy DigitalOcean droplet behind
  `python.unseen-university.org` — the migration's tiered-cache
  fetch path uses the public droplet URL. Entry:
  [python/app.py](python/app.py).
- `summary/` — team-aggregates Node service, runs as the
  `sports-summarycontainer` Cloudflare Container.
- KV namespaces: `LEAGUE_DATA` (league/team summaries) and
  `SUMMARY_LAST_UPDATED` (small isolated namespace for
  list-stable lookups).
- Per-game PBP cache: **two layers** (post-2026-05-10 migration to
  Architecture B):
  1. `caches.default` keyed by request URL — wraps the rendered HTML
     for warm-path same-PoP HITs (~30 ms).
  2. CF standard cache + Smart Tiered Cache on a `fetch+cf` to
     `python.unseen-university.org/cfb/process?gameId=X` — pools the
     JSON across PoPs so cross-PoP cold-fills hit the upper-tier hub
     instead of the Container.
  Cache-Control varies by branch (completed games 1y, in-progress 30s
  + `stale-while-revalidate=60`, pregame 5min, quarantine 1d; errors
  not cached). The inner JSON cache uses 30s TTL on 200s, 1s on 404s,
  0 on 5xx (`cacheTtlByStatus` in lib/games.ts).
- Worker dispatch between the old service-binding path and the new
  fetch+cf path is gated by `PYTHON_FETCH_MODE` env var
  (`"service" | "tiered"`). Production is on `"tiered"` since
  2026-05-10; rollback is one wrangler.toml line.
  See [docs/migrate-to-tiered-cache.md](docs/migrate-to-tiered-cache.md)
  and the load-test report at
  [worker/scripts/loadtest/analysis/2026-05-10-final/REPORT.md](worker/scripts/loadtest/analysis/2026-05-10-final/REPORT.md).

Deploy: `cd worker && wrangler deploy`. Production hostname is
`sports.unseen-university.org` (Cloudflare Workers route).

> **Droplet retired 2026-05-11**: `python.unseen-university.org` now
> resolves to a Worker route on the `sports` Worker that service-binds
> to the `PythonContainer`. The legacy `frontend/`, `redis/`, `caddy/`,
> `docker-compose*.yml`, and `.github/workflows/e2e.yml` were deleted
> in the same pass. Once you've powered off the DigitalOcean droplet
> via the DO dashboard, that infra is fully retired. See
> [docs/migrate-to-tiered-cache.md](docs/migrate-to-tiered-cache.md).

## Active work

[docs/migration-plan.md](docs/migration-plan.md) — multi-phase
Cloudflare migration. **Phase 3D burn-in completed 2026-05-10.
Architecture B tiered-cache cutover landed 2026-05-10** (see
[docs/migrate-to-tiered-cache.md](docs/migrate-to-tiered-cache.md)).
Phase 3E partial decommission can proceed (frontend/, redis/, caddy/
removable; droplet's Python container stays as the tiered-cache
origin). The replica-deploy-plan and perf-plan are both DONE;
their files are preserved as historical record.

## Conventions

- Worker tests in [worker/test/](worker/test/) (vitest +
  `@cloudflare/vitest-pool-workers`, ~143 assertions). Run with
  `cd worker && npm test`.
- Python tests in [python/tests/](python/tests/) (pytest, `pytest.ini`
  configures the `integration` marker — deselected by default;
  opt-in with `-m integration`).
- Python uses `ruff`-compatible style; no formatter configured.
- TypeScript on the Worker side; vitest config is
  [worker/vitest.config.mts](worker/vitest.config.mts).

## Things to know before changing code

- `/cfb/process` exception handling collapses any `KeyError` into a 404
  with message "ESPN payload is malformed"
  ([app.py:260-269](python/app.py#L260)). This masks real bugs in the
  per-record reshape — don't trust 404s as upstream-data issues
  without reading the trace.
- The per-record reshape ([app.py:82-205](python/app.py#L82)) is fragile
  to sportsdataverse column renames; the snapshot tests in
  [python/tests/](python/tests/) (perf-plan Day 2) are designed to
  catch this.
- The `/cfb/process` JSON Schema contract validator
  ([worker/src/](worker/src/), via ajv) is currently warn-only and
  has known drift on the `id` field (Python returns string, schema
  expects integer). Tracked in the migration-plan Future backlog.
- The fork-deploy workflow is now just pytest + schema-freshness;
  the legacy build/deploy/e2e/lighthouse jobs were removed when the
  droplet was retired.
