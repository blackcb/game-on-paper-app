#!/usr/bin/env bash
# Fan out a single load-test run against PRODUCTION (gameonpaper.com)
# across every region in main.tf.
#
# Usage:
#   ./run-prod.sh <run-tag> [gameId ...]
#
# Unlike run.sh (the A/B/D architecture comparison against the fork's
# replica), this targets one host with NO replay params. Production
# serves game pages at /game/<id> as STATIC, edge-cached HTML (verified
# 2026-08-15: cf-cache-status HIT, no origin involvement). So this is a
# pure CDN cache-tail benchmark — cross-PoP cold-MISS behavior and warm
# HIT latency — NOT the fork's dynamic-origin / SWR test.
#
# analyze.py caveat: the origin_amplification.csv and
# body_hash_convergence.csv outputs are MEANINGLESS here — production
# has no origin to amplify and no PBP updating the body. Read only
# tail_p99.csv (p50/p95/p99 TTFB per region) and ttfb_box.png (the
# cold-PoP-MISS cliff). The static page is large (~13.7 MB uncompressed,
# zstd on the wire), so a full run moves real edge bandwidth.
#
# Game IDs default to the captured-fixture set but SHOULD be overridden
# on the CLI with a real gameId that 200s on production, e.g.:
#   ./run-prod.sh 2026-08-30-noon 401762841
# (Fork fixture IDs like 401520434 return 404 on production.)
#
# LOADTEST_TOKEN (optional): if the prod Cloudflare zone has a WAF Skip
# rule keyed on the X-Loadtest-Token header, export the token so the
# Lambda IPs get through Bot Fight Mode. See README.md.
#
# Env knobs:
#   RUN_DURATION=<s>   run length (default 600)
#   VIEWERS=<n>        viewers per region (default 17; 2 in cache-bust mode)
#   CYCLE=<s>          seconds between a viewer's requests (default 30; 60 in cache-bust)
#   CACHE_BUST=1       force origin MISS on every request — ORIGIN LOAD TEST.
#                      Each request becomes a full origin generation (~8s on
#                      gameonpaper.com), so concurrency = origin load. DANGEROUS
#                      against production; needs the origin owner's sign-off.
#                      Defaults drop to 2 viewers / 60s cycle when enabled.
#                      Example (deliberately small):
#                        CACHE_BUST=1 VIEWERS=1 CYCLE=30 RUN_DURATION=120 \
#                          bash run-prod.sh 2026-08-30-origin 401762841

set -euo pipefail

RUN_TAG="${1:-}"
if [[ -z "${RUN_TAG}" ]]; then
  echo "usage: $0 <run-tag> [gameId ...]" >&2
  echo "example: $0 2026-08-30-noon 401756846 401756901" >&2
  exit 1
fi
shift || true

# Remaining args are gameIds. Fall back to the fixture set if none given.
if [[ "$#" -gt 0 ]]; then
  GAME_IDS_JSON=$(printf '%s\n' "$@" | jq -R . | jq -sc .)
else
  GAME_IDS_JSON='["401520434","401403910","401628329"]'
fi

# Single production target: no arch flag, no replay. Production serves
# game pages at /game/<id> (NOT the fork's /cfb/game/<id>), and www
# 301-redirects to the apex, so target the apex directly to skip a hop.
TARGETS_JSON='[{"label":"PROD","baseUrl":"https://gameonpaper.com","arch":null,"replay":false,"pathTemplate":"/game/{gameId}"}]'

# Run length in seconds. Default 600 (not the Lambda-max-adjacent 850):
# production game pages are ~13.7 MB — ~100x the fork's dynamic pages the
# harness was originally tuned for — so at 850s the driver didn't wind
# down before the 900s Lambda timeout and every region died without
# writing to S3. 600s leaves a wide margin. Override for quick tests,
# e.g. RUN_DURATION=300.
RUN_DURATION="${RUN_DURATION:-600}"

# CACHE_BUST mode. When enabled, every request carries a unique query
# param so it's a distinct Cloudflare cache key → MISS → the ORIGIN
# generates the page. This tests the origin/miss path (measured ~8s per
# generation on gameonpaper.com) instead of the edge/HIT path.
#
# DANGER: each miss is a full origin generation, so concurrency multiplies
# directly into origin load — VIEWERS × 5 regions simultaneous ~8s runs.
# That can overwhelm a production origin. Only run against an origin you
# are authorised to load, with the maintainer's sign-off. When CACHE_BUST
# is on we default to LOW concurrency (2 viewers) and a SLOW cycle (60s);
# override VIEWERS / CYCLE deliberately, not by accident.
case "${CACHE_BUST:-}" in
  ""|0|false|no) CACHE_BUST_JSON=false; VIEWERS="${VIEWERS:-17}"; CYCLE="${CYCLE:-30}" ;;
  *)             CACHE_BUST_JSON=true;  VIEWERS="${VIEWERS:-2}";  CYCLE="${CYCLE:-60}" ;;
esac

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${HERE}"
BUCKET="$(terraform output -raw results_bucket)"
FUNCTION_NAME="$(terraform output -raw function_name)"
REGIONS=$(terraform output -json regions | jq -r '.[]')
REGION_COUNT=$(echo "${REGIONS}" | wc -w | tr -d ' ')

PAYLOAD=$(jq -nc \
  --arg prefix "runs/${RUN_TAG}" \
  --arg bucket "${BUCKET}" \
  --arg token "${LOADTEST_TOKEN:-}" \
  --argjson targets "${TARGETS_JSON}" \
  --argjson gameIds "${GAME_IDS_JSON}" \
  --argjson dur "${RUN_DURATION}" \
  --argjson viewers "${VIEWERS}" \
  --argjson cycle "${CYCLE}" \
  --argjson cachebust "${CACHE_BUST_JSON}" \
  '{
    viewerCount: $viewers,
    runDurationSeconds: $dur,
    cyclePeriodSeconds: $cycle,
    cycleJitterSeconds: 5,
    replayDurationSeconds: $dur,
    cacheBust: $cachebust,
    targets: $targets,
    gameIds: $gameIds,
    resultsBucket: $bucket,
    resultsPrefix: $prefix,
    loadtestToken: (if $token == "" then null else $token end)
  }')

# NOTE: the value MUST always be produced. The original form
# `($token | select(. != ""))` yields EMPTY when the token is empty, and
# in jq an empty field value collapses the WHOLE object to empty output —
# so an empty LOADTEST_TOKEN silently produced a blank payload, the
# Lambda ran on all-defaults (runDurationSeconds 1500 → 900s timeout),
# and every run died with no results. `if/else` always yields a value.
# (run.sh has the same latent bug; it only dodged it because the A/B/D
# runs always set a token.)

echo "Run tag:  ${RUN_TAG}"
echo "Target:   https://gameonpaper.com (PROD, no replay)"
echo "Games:    ${GAME_IDS_JSON}"
echo "Duration: ${RUN_DURATION}s"
echo "Viewers:  ${VIEWERS} per region × ${REGION_COUNT} regions"
echo "Cycle:    ${CYCLE}s"
echo "Mode:     $([ "${CACHE_BUST_JSON}" = true ] && echo 'CACHE-BUST → forces origin MISS (origin load test)' || echo 'normal (edge cache)')"
echo "Bucket:   s3://${BUCKET}/runs/${RUN_TAG}"
echo "Regions:  ${REGIONS}"
echo

if [[ "${CACHE_BUST_JSON}" = true ]]; then
  PEAK=$(( VIEWERS * REGION_COUNT ))
  echo "  ┌──────────────────────────────────────────────────────────────┐"
  echo "  │  ⚠  CACHE-BUST MODE — this loads the ORIGIN, not the cache.   │"
  echo "  │                                                              │"
  printf '  │  Up to ~%-3s concurrent origin generations (%s viewers × %s    │\n' "${PEAK}" "${VIEWERS}" "${REGION_COUNT}"
  echo "  │  regions), each ~8s on gameonpaper.com. This can degrade or   │"
  echo "  │  take down a production origin.                               │"
  echo "  │                                                              │"
  echo "  │  Only proceed with the origin owner's sign-off. Raise load    │"
  echo "  │  with VIEWERS=/CYCLE= deliberately. Ctrl-C now to abort.      │"
  echo "  └──────────────────────────────────────────────────────────────┘"
  echo
fi

# ASYNC dispatch. `--invocation-type Event` hands each Lambda off to
# AWS and returns immediately (HTTP 202) — the client does NOT stay
# connected for the ~14 min run. This is deliberate: a synchronous
# (RequestResponse) invoke requires the caller to block for the whole
# run, which fails under any 2-minute-capped shell (e.g. Claude Code's
# `!` runner kills it and the invocations may never dispatch). Async
# means the Lambdas run detached and PUT their own results to S3 at the
# end; we poll S3 rather than wait on the client.
#
# Trade-off: no synchronous per-region result echo, and a Lambda that
# errors is auto-retried up to 2x by AWS (async default) — check S3 /
# CloudWatch if a region's file never appears.
EXIT=0
for REGION in ${REGIONS}; do
  OUT=$(mktemp)
  if aws lambda invoke \
      --region "${REGION}" \
      --function-name "${FUNCTION_NAME}" \
      --invocation-type Event \
      --cli-binary-format raw-in-base64-out \
      --cli-connect-timeout 60 \
      --payload "${PAYLOAD}" \
      "${OUT}" >/dev/null 2>&1; then
    echo "[${REGION}] dispatched (async)"
  else
    echo "[${REGION}] DISPATCH FAILED" >&2
    EXIT=1
  fi
  rm -f "${OUT}"
done

echo
if [[ "${EXIT}" -eq 0 ]]; then
  echo "All 5 regions dispatched. They run ~${RUN_DURATION}s, then write to S3."
else
  echo "One or more regions failed to dispatch — see above." >&2
fi
echo
echo "Poll for completion (expect ${RUN_TAG} to fill with 5 .jsonl files):"
echo "  aws s3 ls s3://${BUCKET}/runs/${RUN_TAG}/"
echo "Then pull + analyze:"
echo "  aws s3 sync s3://${BUCKET}/runs/${RUN_TAG}/ ../results/${RUN_TAG}/"
exit "${EXIT}"
