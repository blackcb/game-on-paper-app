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

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${HERE}"
BUCKET="$(terraform output -raw results_bucket)"
FUNCTION_NAME="$(terraform output -raw function_name)"
REGIONS=$(terraform output -json regions | jq -r '.[]')

PAYLOAD=$(jq -nc \
  --arg prefix "runs/${RUN_TAG}" \
  --arg bucket "${BUCKET}" \
  --arg token "${LOADTEST_TOKEN:-}" \
  --argjson targets "${TARGETS_JSON}" \
  --argjson gameIds "${GAME_IDS_JSON}" \
  '{
    viewerCount: 17,
    runDurationSeconds: 850,
    cyclePeriodSeconds: 30,
    cycleJitterSeconds: 5,
    replayDurationSeconds: 850,
    targets: $targets,
    gameIds: $gameIds,
    resultsBucket: $bucket,
    resultsPrefix: $prefix,
    loadtestToken: ($token | select(. != ""))
  }')

echo "Run tag: ${RUN_TAG}"
echo "Target:  https://www.gameonpaper.com (PROD, no replay)"
echo "Games:   ${GAME_IDS_JSON}"
echo "Bucket:  s3://${BUCKET}/runs/${RUN_TAG}"
echo "Regions: ${REGIONS}"
echo

PIDS=()
for REGION in ${REGIONS}; do
  (
    OUT=$(mktemp)
    set -e
    aws lambda invoke \
      --region "${REGION}" \
      --function-name "${FUNCTION_NAME}" \
      --invocation-type RequestResponse \
      --cli-binary-format raw-in-base64-out \
      --cli-read-timeout 0 \
      --cli-connect-timeout 60 \
      --payload "${PAYLOAD}" \
      "${OUT}" >/dev/null
    echo "[${REGION}] $(cat "${OUT}")"
    rm -f "${OUT}"
  ) &
  PIDS+=($!)
done

EXIT=0
for PID in "${PIDS[@]}"; do
  wait "${PID}" || EXIT=$?
done

if [[ "${EXIT}" -eq 0 ]]; then
  echo
  echo "All regions complete. Pull results with:"
  echo "  aws s3 sync s3://${BUCKET}/runs/${RUN_TAG}/ ../results/${RUN_TAG}/"
fi
exit "${EXIT}"
