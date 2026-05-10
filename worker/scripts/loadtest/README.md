# Game-day load-test harness

Fan out 50 simulated viewers across US AWS regions and measure
`/cfb/game/:gameId` against three architectures back-to-back:

| ID | What | URL pattern |
|---|---|---|
| A | Cloudflare Worker + service-binding to Container, `caches.default` per-PoP | `https://sports.unseen-university.org/cfb/game/<id>?replay=<ts>&arch=baseline` |
| B | Same Worker, but JSON fetched via public URL with `cf:{cacheEverything,cacheTtlByStatus}` so tiered cache pools the response | `https://sports.unseen-university.org/cfb/game/<id>?replay=<ts>&arch=tiered` |
| D | Legacy DigitalOcean droplet (Express + Flask + Redis) | `https://gameonpaper.com/cfb/game/<id>` |

Architecture C (CF Workers + DO Python via fetch+cf) is **not** built
— see the planning conversation in
[`docs/migration-plan.md`](../../../docs/migration-plan.md) for the
why.

The harness drives **synthetic real-time PBP**: a fixture's plays are
revealed gradually over the run window so each cache cycle sees a body
that has changed by ~2-3 plays. This exercises the SWR refresh path
that production hits during a live in-progress game; without it the
test would just hammer a static cache entry.

## Layout

```
scripts/loadtest/
├── README.md                this file
├── driver.mjs               the per-region driver. CLI + library entry.
├── analyze.py               post-run analysis (Pandas + matplotlib).
└── lambda/
    ├── handler.mjs          AWS Lambda wrapper around runDriver()
    ├── package.json         depends on @aws-sdk/client-s3 only
    ├── main.tf              terraform: 6 regional Lambdas + S3 bucket
    └── run.sh               fan-out invoker; one run = one S3 prefix
```

The Worker side is wired up in `worker/src/index.tsx` —
`/cfb/game/:gameId` honors `?replay=<unix_ts>&arch=<baseline|tiered>`
and routes through `serveLoadTestGame`. The Python side is wired up
in `python/app.py` — `/cfb/process/replay` returns a fixture
truncated by wallclock. Production traffic doesn't carry these query
params, so the production code path is untouched.

## Prerequisites

1. **Worker deployed with these changes.** The harness's `?replay=`
   query string is dead until the new code is in production. From the
   `worker/` directory:
   ```sh
   wrangler deploy
   ```
   Confirm by hitting:
   ```sh
   curl -sI "https://sports.unseen-university.org/cfb/game/401520434?replay=$(date +%s)&arch=baseline" | grep x-arch
   ```
   You should see `x-arch: baseline`. Without that header, production
   is on the old code and the harness will be measuring the wrong
   thing.

2. **Python deployed with `/cfb/process/replay`.** Two surfaces need
   the new endpoint:

   - **CF Container** (Architecture A path): rebuild the image and
     bump the `image = "...:slim-replay"` tag in
     `worker/wrangler.toml`, then `wrangler deploy`.
   - **Legacy droplet** at `python.unseen-university.org`
     (Architecture B path): pushing to the
     `instrument-plus-cloudflare-cdn` branch auto-deploys the droplet
     via `.github/workflows/fork-deploy.yml`. Once that workflow
     finishes the new endpoint is live there too.

   Confirm with:
   ```sh
   # Architecture A backing
   curl -sI "http://localhost:7000/cfb/process/replay?gameId=401520434&replay_started_at=$(date +%s)" | head -1
   # Architecture B backing
   curl -sI -H "X-Worker-Secret: $WORKER_SHARED_SECRET" \
     "https://python.unseen-university.org/cfb/process/replay?gameId=401520434&replay_started_at=$(date +%s)"
   ```
   Both should return 200.

3. **AWS credentials.** Default profile or env vars; `aws sts
   get-caller-identity` works.

4. **Tools on the operator machine**: `terraform >= 1.5`, `node >= 20`,
   `npm`, `aws` CLI v2, `jq`, `python >= 3.10` with `pandas` and
   `matplotlib` (or use `uv run --with pandas --with matplotlib ...`).

## End-to-end run

```sh
cd worker/scripts/loadtest/lambda
npm install                              # @aws-sdk/client-s3 only
terraform init
terraform apply                          # ~1 min: 6 Lambdas + S3 bucket

./run.sh 2026-08-30-saturday-noon         # fans out, blocks ~25 min
                                          # results land in S3

# Pull and analyze
aws s3 sync s3://$(terraform output -raw results_bucket)/runs/2026-08-30-saturday-noon/ \
  ../results/2026-08-30-saturday-noon/

cd ..
python analyze.py --run-dir results/2026-08-30-saturday-noon \
                  --output-dir analysis/2026-08-30-saturday-noon

# Open analysis/<run-tag>/ttfb_box.png and tail_p99.csv

terraform destroy                        # tear down Lambdas + bucket
```

A full run is ~14 min (850 s — fits inside Lambda's 900 s cap).
`run.sh` sets this in its payload. If you want a longer run, you'll
need to either chain two back-to-back invocations or refactor the
handler to stream-upload to S3 so a Lambda timeout doesn't lose data.

## Local smoke test

```sh
node driver.mjs \
  --region=local-laptop \
  --viewer_count=3 \
  --duration_s=20 \
  --cycle_s=8 \
  > /tmp/local-smoke.jsonl

python analyze.py --run-dir /tmp --output-dir /tmp/analysis
```

This won't tell you anything about cross-PoP behavior — every viewer
hits the same PoP your laptop's anycast lands on (ATL on the office
network). It's a sanity check: confirms the driver, the deployed
Worker, and the analysis pipeline all work end-to-end before you
spend $0.50 on Lambda.

## What the analysis answers

`analyze.py` emits four artifacts that, between them, answer the
"which architecture for game day" question:

1. **`tail_p99.csv`** — one row per architecture: n requests, p50/p95/p99
   TTFB, error rate. Read this first.
2. **`origin_amplification.csv`** — ratio of upstream Python calls to
   total requests. Architecture A's expected value is ~1/N where N is
   the number of viewers per PoP per cache TTL. Architecture B's
   should approach 1/N globally — the win condition.
3. **`ttfb_box.png`** — per-region TTFB box plots, log-y axis. Visual
   "is the cold-PoP cliff present?" check.
4. **`body_hash_convergence.csv`** — distinct content versions seen
   per 30 s wallclock bucket per architecture. Tells you whether SWR
   is refreshing the cache as PBP grows.

Predictions to hold the harness against (from the planning doc):

- **A**: cold-PoP TTFB ~2.5 s once per region, then steady ~250 ms
  p50, ~500 ms p95 within a region. Origin amplification ~1 per region
  per TTL.
- **B**: cold-PoP TTFB ~2.5 s **once globally**, then ~150 ms p50,
  ~300 ms p95 across all regions. Origin amplification ~1 per global
  TTL.
- **D**: steady ~600 ms p50, ~1.2 s p95 from any US region.

If those predictions hold, B wins game day. If A's p95 turns out
close to B's, the migration isn't worth doing.

## Cost

A single full run costs roughly:
- 6 regions × 1 Lambda × 25 min × 512 MB ≈ $0.05 of Lambda time
- ~12 MB of S3 PUTs and ~12 MB of egress on `terraform destroy`'s
  bucket teardown ≈ $0.001
- ~50 RPS sustained against `sports.unseen-university.org` for 25 min
  ≈ ~75k Worker invocations (well within Workers Paid plan)

Round to **<$0.10 per run, off Cloudflare's bill, and trivial AWS
cost.** The expensive thing is your time interpreting the results,
not the infrastructure.

## Failure modes

- **Lambda times out mid-run.** Lambda's hard cap is 900 s. `run.sh`
  asks for 850 s of run + ~50 s of margin for S3 PUT and node startup,
  which fits. If you bump `runDurationSeconds` past ~870 the Lambda
  will be killed before the S3 PUT, and you'll lose all of that
  region's data (the handler only PUTs once at run end). The fix is
  streaming uploads; for now, just keep the run length where it is.
- **CF tells the harness "rate limit"**. The default config is 17
  viewers × 6 regions × 1 cycle/30s = ~3.4 RPS sustained per Worker.
  Cloudflare's default zone limits don't trigger on this. If they do,
  you'll see HTTP 429s in the JSONL.
- **Worker rolling out mid-run**: if `wrangler deploy` runs during a
  test, viewers will mix old and new behavior. Don't do that. Tag
  runs with the deployed commit hash if you want to be paranoid.
- **PYTHON_BACKEND on staging vs prod**: B requires
  `python.unseen-university.org` (the public Python URL) to serve
  `/cfb/process/replay`. If it doesn't, B requests will 404 and the
  harness will record errors instead of cache misses. Confirm with:
  ```sh
  curl -sI "https://python.unseen-university.org/cfb/process/replay?gameId=401520434&replay_started_at=$(date +%s)" \
    -H "X-Worker-Secret: $(wrangler secret list | jq -r '.[0].name')"
  ```
  Should return 200.

## What's NOT in the harness

- **Browser-side timing**: the harness measures wire-level TTFB. It
  doesn't render the HTML, parse JS, lay out, or paint. CWV (LCP, INP,
  CLS) for a real user is something the chrome-devtools MCP perf
  traces handle better.
- **Live-game truth-checking**: synthetic replay returns truncated
  fixture data. It's representative for cache-architecture testing,
  not for the actual GameLogic / box-score correctness. When football
  season opens (~2026-08-30), re-run against a real top-25 noon
  kickoff with `replay=` omitted on each target — the legacy harness
  becomes the live-traffic harness for free.
