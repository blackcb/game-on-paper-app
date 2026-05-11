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
runs pytest + schema-freshness on every push to
`instrument-plus-cloudflare-cdn`. Worker + Container deploys are
manual (`wrangler deploy`).

See [docs/migration-plan.md](docs/migration-plan.md) for the
multi-phase history that got us here.
