# Season-mode wrangler profiles

Cloudflare Containers' `sleepAfter`, `max_instances`, and (eventually)
the cron-warm cadence depend on whether college football is in
season and on what day of the week traffic peaks. We run three
deployment profiles to capture that:

| Mode | When active | `sleepAfter` | `max_instances` (Python) | `max_instances` (summary) | Cron-warm (Layers B+C) |
| --- | --- | --- | --- | --- | --- |
| `peak` | Saturdays in-season (Aug–Jan) | `1h` | 10 | 5 | enabled, gameday window |
| `normal` | Weekdays in-season | `10m` | 5 | 3 | enabled, weekday-evening window only |
| `offseason` | Feb–Jul | `5m` | 2 | 2 | disabled |

`SEASON_MODE` is exported as an env var so the `Container<Env>`
subclass can read it at construction time and set `sleepAfter`
without a redeploy-of-code being needed to change *just* the mode.

## Deploy procedure

We use **three separate config files**: `wrangler.toml` (= `normal`
profile, the bare-`wrangler deploy` default), plus
`wrangler.peak.toml` and `wrangler.offseason.toml` alongside it.
Each file is self-contained — same `name = "sports"`, same KV
bindings, same DO + migration block — so all three deploy to
the same Worker, just with different config.

Wrangler **environments** (`[env.peak]`, etc.) were considered and
rejected: each env produces a *separate* Worker (`sports-peak`,
`sports-normal`), which would force route plumbing changes on
every season flip and lose the production hostname binding. Three
files keep all three modes pointing at the same `sports` Worker.

```sh
# Switch to peak mode (Saturday morning before kickoff)
cd worker && wrangler deploy --config wrangler.peak.toml

# Back to weekday cadence (Sunday morning post-games)
cd worker && wrangler deploy   # uses wrangler.toml = normal

# End of season (early February)
cd worker && wrangler deploy --config wrangler.offseason.toml
```

## What differs between the files

The three files share Worker name, account, KV bindings,
`[[durable_objects.bindings]]`, `[[migrations]]`, `[assets]`,
`[observability]`, `[triggers]`, `[dev]`, and the container image
+ `instance_type` + `constraints.regions`. They differ only on:

| Field | `wrangler.toml` (normal) | `wrangler.peak.toml` | `wrangler.offseason.toml` |
| --- | --- | --- | --- |
| `vars.SEASON_MODE` | `"normal"` | `"peak"` | `"offseason"` |
| `vars.PYTHON_BACKEND` | `"droplet"` (until 3D)¹ | `"container"` | `"container"` |
| `vars.SUMMARY_BACKEND` | `"droplet"` (until 3D)¹ | `"container"` | `"container"` |
| `vars.CRON_WARM_ENABLED` | `"0"` (until 3C ships) | `"1"` | `"0"` |
| `vars.PREWARM_TOP_N` | `"0"` (until 3C ships) | `"10"` | `"0"` |
| Python `max_instances` | 5 | 10 | 2 |
| Summary `max_instances` | 3 | 5 | 2 |

¹ At 3D cutover, flip `wrangler.toml`'s `PYTHON_BACKEND` and
`SUMMARY_BACKEND` from `"droplet"` to `"container"` and redeploy.
That step is the single point of no return for the migration.

## Container code reads `SEASON_MODE`

`worker/src/containers.ts` (new file in 3B wiring):

```ts
import { Container } from "@cloudflare/containers";

const SLEEP_AFTER: Record<string, string> = {
  peak: "1h",
  normal: "10m",
  offseason: "5m",
};

export class PythonContainer extends Container<Env> {
  defaultPort = 7000;
  // env.SEASON_MODE is set by the active wrangler env (`peak` etc.).
  // Default to `normal` if unset (e.g., local dev).
  sleepAfter = SLEEP_AFTER[(this.env as any).SEASON_MODE ?? "normal"] ?? "10m";
}

export class SummaryContainer extends Container<Env> {
  defaultPort = 3000;
  sleepAfter = SLEEP_AFTER[(this.env as any).SEASON_MODE ?? "normal"] ?? "10m";
}
```

## Why three modes and not two

Considered collapsing peak + normal into a single "in-season" mode
that just relies on `sleepAfter` being long enough. Decided against
because:

- A 1h `sleepAfter` during a Tuesday lunch hour bills idle memory
  for an hour after a single curious user clicks a game page from
  Twitter. Most weekdays barely warrant `10m`.
- Top-N pre-warm (Layer C) is only worth the active-CPU cost on
  Saturdays when there are 50+ games to choose from. On a Wednesday
  with one MAC midweek game, pre-warming 10 things wastes
  90% of those calls.

Three modes is the smallest set that lets us avoid both.

## Calendar trigger (manual)

For now, the operator manually deploys the right env on the right
weekend. If this becomes a chore, a tiny Workers Cron + GitHub
Action or scheduled deploy could automate the swap based on the
day of week + month. Out of scope for 3B; revisit if the manual
flips become annoying.
