# Claude Code project notes

## What this repo is

Game on Paper — college football play-by-play analytics, running on
Cloudflare Workers + Containers.

- `worker/` — Hono on Cloudflare Workers. SSR for all pages, KV-backed
  league/team data, `caches.default` for per-game PBP, static assets
  via the `[assets]` binding, cron-warmed scoreboard. Entry:
  [worker/src/index.tsx](worker/src/index.tsx). Config:
  [worker/wrangler.toml](worker/wrangler.toml).
- `python/` — Flask, port 7000. Single endpoint `/cfb/process` that runs
  `sportsdataverse.cfb.cfb_pbp.CFBPlayProcess` (XGBoost EP/WP/QBR
  models + heavy pandas pipeline). Runs as the
  `sports-pythoncontainer` Cloudflare Container, called from the
  Worker via `env.PBP_PROCESSOR.fetch(...)`. Entry:
  [python/app.py](python/app.py).
- `summary/` — team-aggregates Node service, runs as the
  `sports-summarycontainer` Cloudflare Container.
- KV namespaces: `LEAGUE_DATA` (league/team summaries) and
  `SUMMARY_LAST_UPDATED` (small isolated namespace for
  list-stable lookups).
- Per-game PBP cache: `caches.default`, keyed by request URL.
  Cache-Control varies by branch (completed games 1y, in-progress 30s
  + `stale-while-revalidate=60`, pregame 5min, quarantine 1d; errors
  not cached).

Deploy: `cd worker && wrangler deploy`. Production hostname is
`sports.unseen-university.org` (Cloudflare Workers route).

> **Transition note (until ~2026-05-17)**: Phase 3D cutover landed
> 2026-05-08. The DigitalOcean droplet at 137.184.138.84 still runs
> the legacy Express+Flask+Redis stack as a rollback fallback,
> deployed by [.github/workflows/fork-deploy.yml](.github/workflows/fork-deploy.yml)
> on every push to `instrument-plus-cloudflare-cdn`. The legacy code
> lives in `frontend/`, `redis/`, `caddy/`, and `docker-compose*.yml`.
> After the droplet is decommissioned, this note + those legacy
> directories go away. See [docs/migration-plan.md](docs/migration-plan.md)
> Phase 3E for the decommission checklist.

## Active work

[docs/migration-plan.md](docs/migration-plan.md) — multi-phase
Cloudflare migration. Currently in **Phase 3D burn-in** (cutover
2026-05-08, burn-in ends ~2026-05-10). Phase 3E (decommission) is
next; partial doc-update pass landed 2026-05-08, destructive teardown
gated on burn-in success + 1 week of stable production. The
replica-deploy-plan and perf-plan are both DONE; their files are
preserved as historical record.

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
- During the burn-in window, `frontend/` and `redis/` are still
  built + deployed by `fork-deploy.yml`. Don't delete files in those
  trees yet — they're load-bearing for the rollback path until
  ~2026-05-17.
