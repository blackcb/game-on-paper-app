# Migration: Architecture A → Architecture B (tiered cache via fetch+cf)

> **Historical snapshot.** This doc records the original Architecture B
> plan as written 2026-05-10. The final shipped shape diverges from
> the plan in two material ways — neither was foreseeable when this
> was drafted, both are documented in `migration-plan.md` rather than
> back-patched here:
>
> - The droplet did **not** stay up as the public Python origin.
>   It was retired 2026-05-11 and destroyed 2026-05-12.
>   `python.unseen-university.org` now resolves to the
>   `sports-python-proxy` Worker ([python-proxy/](../python-proxy/)),
>   which forwards to the `PythonContainer` DO in the `sports` Worker.
>   See [migration-plan.md §3H](migration-plan.md) for the final shape
>   (and §3G for the same-Worker-self-fetch regression that forced
>   splitting the proxy into its own Worker).
> - The legacy `frontend/`, `redis/`, and `caddy/` directories were
>   deleted in the 2026-05-11 cleanup; the GitHub Actions e2e workflow
>   went with them.
>
> Everything below this banner is the original plan, preserved as the
> record of how we got here. Read it for context, not for current
> truth.

Status: **superseded by [migration-plan.md §3H](migration-plan.md) on 2026-05-13**.
See [`worker/scripts/loadtest/analysis/2026-05-10-final/REPORT.md`](../worker/scripts/loadtest/analysis/2026-05-10-final/REPORT.md)
for the load-test data that justified this migration.

## Goal

Replace the Worker's per-PoP `caches.default` + service-binding-to-Container
path on `/cfb/game/:gameId` with a **hybrid** approach:

- Keep `caches.default` for the rendered HTML (preserves A's 37 ms
  same-PoP HIT p50).
- Replace the service-binding fetch to Python with a public-URL
  `fetch(..., {cf: {cacheEverything, cacheTtlByStatus}})` so the
  Python JSON response participates in CF's standard cache + Smart
  Tiered Cache (gives B's tighter p99 + 17× lower origin compute
  cost).

Net effect: same-PoP warm hits stay at A's speed; cross-PoP fills
go through the upper-tier hub instead of the Container, dropping
the cold-fill tail from ~3 s (A on real PBP) to ~700 ms (B's
upper-tier-cache-hit cost).

## Non-goals

- Replacing `caches.default` itself. The Worker's per-PoP cache is
  the right tool for the rendered HTML and we keep it.
- Decommissioning the Cloudflare Container. It stays as a
  rollback target via the `PYTHON_FETCH_MODE` env var.
- Migrating other routes (pregame, leaderboards, team pages).
  This migration is `/cfb/game/:gameId` only.

## Constraints discovered during planning

1. **CF cache requires GET, not POST.** The current `/cfb/process`
   is POST with `{gameId}` in the body. POST cache keys default to
   URL only (Enterprise-only `cf.cacheKey` would help but we're on
   Free); two requests for different games would collide on the
   same cache key. Solution: **add a GET variant of `/cfb/process`**
   that takes `gameId` from the query string. POST stays
   backward-compatible.
2. **The cached fetch target must be a public URL behind
   Cloudflare.** `python.unseen-university.org` (the legacy droplet)
   already works and is auth-gated by `X-Worker-Secret`. Cloudflare
   Containers don't expose public URLs natively, so going Container-
   only would require a new Worker proxy. **Decision: stay on the
   droplet for the public Python URL.** This means Phase 3E
   (droplet decommission) has to be amended — the droplet stays up
   for the foreseeable future, hosting only Python.
3. **Bot Fight Mode is fine.** Worker subrequests to
   `python.unseen-university.org` go through CF's internal request
   routing, not through Bot Fight Mode. Confirmed live 2026-05-10:
   `arch=tiered` returns 200 + `x-upstream-cache: MISS` even with
   Bot Fight Mode re-enabled.
4. **Production traffic must not regress during cutover.** The
   migration is gated behind a new `PYTHON_FETCH_MODE` env var.
   Default is `"service"` (today's behavior). Cutover flips to
   `"tiered"`. Rollback flips back.

## Phases

### Phase 1: Python — add GET to `/cfb/process`

**Change:** `python/app.py` — `@app.route("/cfb/process",
methods=["GET", "POST"])`. GET reads `gameId` from query string;
POST behavior unchanged.

**Test:** add `python/tests/test_process_get.py` covering both
methods + the error path (no gameId → 404).

**Deploy:** new container tag `:slim-coldstart-replay-get`,
push to CF registry, bump `wrangler.toml`, `wrangler deploy`.

**Verify:** `curl https://python.unseen-university.org/cfb/process?gameId=401520434`
(with X-Worker-Secret) returns 200 + a real PBP response.

**Rollback:** revert wrangler.toml image tag to `:slim-coldstart-replay`.

### Phase 2: Worker — tiered fetch path with feature flag

**Change:** `worker/src/lib/games.ts` — `fetchAndShapePBP` accepts
a new `mode` parameter (or reads env), and dispatches between:
- `service` (today): `pythonBackend(env)` returns containerFetch,
  POST `/cfb/process` with body.
- `tiered` (new): `fetch(${PYTHON_BASE_URL}/cfb/process?gameId=X,
  {cf: {cacheEverything: true, cacheTtlByStatus: {...}}, headers:
  {X-Worker-Secret}})`.

The handler in `index.tsx` reads `c.env.PYTHON_FETCH_MODE` and
passes it through. Default is `"service"` for backward compatibility.

**Cache TTLs for tiered mode:**

```ts
cacheTtlByStatus: {
  "200-299": 30,    // matches CACHE_CONTROL.inProgress max-age
  "404": 1,         // ESPN-malformed responses don't pollute cache
  "500-599": 0,     // never cache server errors
}
```

The 30 s TTL on 200s is the in-progress assumption. For completed
games the JSON is stable for hours/days — but we still cap at
30 s in the JSON cache because:
1. The Worker's `caches.default` for the rendered HTML carries a
   1-year TTL for completed games (`CACHE_CONTROL.completed`).
2. The JSON layer is invoked only when `caches.default` misses
   in this PoP.
3. A 30-s JSON TTL means the worst-case "stale data" window is
   30 s — fine for an in-progress game; for a completed game it
   doesn't matter because the response is identical anyway.

Going past 30 s on the JSON cache for completed games would require
sniffing `gameInfo.status.type.completed` *after* the fetch, which
defeats the cache. Easier to leave the TTL short and rely on the
HTML cache for the long-tail caching benefit.

**Tests:** `worker/test/tiered-fetch.test.ts` covering both modes
under the production handler shape (not the load-test branch).

**Deploy:** `wrangler deploy` with `PYTHON_FETCH_MODE=service` in
`wrangler.toml`. Verify nothing changes in production behavior.

**Rollback:** revert via `git revert` of the Worker change. Or
flip `PYTHON_FETCH_MODE` to a non-`tiered` value.

### Phase 3: Cutover

**Change:** `worker/wrangler.toml` — set `PYTHON_FETCH_MODE = "tiered"`.

**Deploy:** `wrangler deploy`.

**Smoke** (immediate):
1. Curl a quarantined gameId — should return GameError page (no
   path through Python). Confirms the quarantine branch unaffected.
2. Curl a real game — should return 200 with rendered HTML, normal
   cache headers, AND `x-upstream-cache: MISS` on the cold response,
   `x-upstream-cache: HIT` on subsequent cycles within 30 s.
3. Curl a pregame — should return 200 with PregamePage. The pregame
   branch doesn't go through fetchAndShapePBP, so this confirms
   we didn't break the pregame branch.
4. Curl a json variant (`?json=1`) — confirms the JSON shortcut
   works.

**Smoke** (30-min watch):
- `wrangler tail --format json | jq -c 'select(.event=="python_failure")'` — should be silent.
- A handful of curl probes per minute to confirm warm-cache hits
  return in <100 ms, cold misses (forced via cache-buster) return
  in <300 ms.

**Rollback:** flip `PYTHON_FETCH_MODE` back to `"service"` in
`wrangler.toml`, `wrangler deploy`. Takes ~30 s.

### Phase 4: Documentation — DONE

Folded into `docs/migration-plan.md` rather than re-documented here:
- `CLAUDE.md` per-game-cache section was updated as part of the
  2026-05-11 cleanup commit + the 3H cutover.
- `docs/migration-plan.md` §3F/§3G/§3H document the cutover, the
  same-Worker-self-fetch regression, and the proxy-split fix.
- `docs/replica-deploy-plan.md` is preserved as historical record
  and not amended — the droplet was destroyed instead of left up.

### Phase 5 (deferred): clean up dead code

Trigger: 1 week of stable production on the post-3H proxy
(unblocks ~2026-05-20 if no `python_failure` events appear in
`wrangler tail` between now and then).

- Remove the `service` branch from `fetchAndShapePBP`.
- Remove the `containerFetch` path from `lib/backends.ts`.
- Note: the Container's `[[durable_objects.bindings]]` block on
  the `sports` Worker can **not** be removed — `sports-python-proxy`
  binds to that same `PythonContainer` DO class via
  `script_name = "sports"`, so the class declaration is now
  load-bearing for the proxy, not just the legacy fallback.
- `wrangler containers delete` is similarly off the table: the
  Container is now the live origin behind the proxy, not a
  rollback target.

What this phase actually unblocks post-3H is narrower than
originally scoped: just the `service`-mode dispatch code. The
Container infrastructure itself stays.

This phase is **not** part of the autonomous migration. User
review before any of these destructive cleanups.

## Success criteria

| Metric | Target |
|---|---|
| `wrangler tail` shows no `python_failure` events for 30 min | yes |
| Curl probe of a real game URL returns 200 with `x-upstream-cache: HIT` on warm path | yes |
| Same URL ?cb=N forced-miss returns 200 with `x-upstream-cache: MISS` and TTFB < 1.5 s | yes |
| Existing vitest suite still passes (current 6 pre-existing failures unchanged) | yes |
| Production game pages render visually correct HTML | yes |

## Risk register

| Risk | Mitigation |
|---|---|
| Tiered fetch breaks in some edge case the test didn't cover | Feature-flagged; rollback is one wrangler.toml line + redeploy |
| Cloudflare cache on the droplet's `python.unseen-university.org` route doesn't actually pool across PoPs | Mitigated by `caches.default` on the Worker side keeping per-PoP HIT path fast |
| Droplet has a Caddy / Flask config issue we don't notice | Smoke tests + `wrangler tail` for 30 min after cutover |
| Phase 3E timeline drift (droplet decommission) | Updated docs in Phase 4 to reflect new constraint |
| Python container image needs update for GET handler | Phase 1 builds + pushes + deploys before Phase 2 |

## Out of scope

- Migrating routes other than `/cfb/game/:gameId` (pregame stays
  on summary container; leaderboards stay on KV; etc.)
- Cloudflare Tiered Cache topology configuration (we use whatever
  the Free plan gives us)
- Adding new cache layers (Cache Reserve, R2, etc.)
- Performance regressions in the Worker's HTML render path (the
  migration doesn't change how the HTML is rendered, only how the
  JSON gets there)
