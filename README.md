# Game on Paper
---

College football play-by-play analytics, running on Cloudflare
Workers + Containers. Production: <https://sports.unseen-university.org>.

## Development

### Worker (primary)

The Worker runs SSR for every page and proxies `/cfb/process`
through to the Python container.

```Shell
cd worker
npm install
npx wrangler dev
```

Listens on `localhost:8787`. By default `wrangler dev` proxies
KV reads + container `fetch` calls to the deployed remote
bindings, so you don't need to run Python or summary locally
unless you're editing them.

See [worker/SEASON-MODES.md](worker/SEASON-MODES.md) for the
season-driven cron + `sleepAfter` toggles
(`wrangler.peak.toml` / `wrangler.offseason.toml`).

### Python service (when editing `/cfb/process`)

```Shell
cd python
pip install -r requirements.txt -r requirements-dev.txt
flask run --port 7000
```

Then point the Worker at it by setting `PYTHON_BASE_URL=http://localhost:7000`
in `worker/.dev.vars` (and `PYTHON_BACKEND=url`).

## Tests

```Shell
cd worker && npm test          # vitest (Workers pool)
cd python && pytest             # pytest; integration tests are
                                # marked and deselected by default
```

## Deployment

```Shell
cd worker && npx wrangler deploy
```

CI: [`.github/workflows/fork-deploy.yml`](.github/workflows/fork-deploy.yml)
deploys the legacy Docker stack to the rollback droplet on every push to
`instrument-plus-cloudflare-cdn`; that workflow goes away with the
droplet decommission.

## Legacy Docker stack (transitional, retiring ~2026-05-17)

Until the rollback droplet is decommissioned, the original
Express+Flask+Redis stack still builds and deploys. To run a full
local mirror of the rollback environment:

```Shell
docker compose -f docker-compose.fork.yml pull
docker compose -f docker-compose.fork.yml up --build
```

Frontend on `localhost:8000`, Python on `localhost:7000`.
This path is deprecated — once Phase 3E decommission completes,
`frontend/`, `redis/`, the `docker-compose*.yml` files, and
`fork-deploy.yml` all go away.

See [docs/migration-plan.md](docs/migration-plan.md) for the
full migration history and decommission checklist.
