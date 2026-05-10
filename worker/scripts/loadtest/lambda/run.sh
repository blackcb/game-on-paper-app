#!/usr/bin/env bash
# Fan out a single load-test run across every region in main.tf.
#
# Usage:
#   ./run.sh <run-tag>
#
# Each region's Lambda is invoked once via aws lambda invoke. They run
# concurrently — bash kicks off all of them in the background and
# `wait` blocks until every one has exited (or hit Lambda's 900 s
# timeout). Per-region results land in s3://<bucket>/runs/<run-tag>/<region>.jsonl
# automatically (the handler reads LOADTEST_RESULTS_BUCKET from its env,
# wired up by terraform).
#
# Safe to run from a laptop. AWS credentials must be available in the
# usual ways (env vars, ~/.aws/credentials, IAM role).

set -euo pipefail

RUN_TAG="${1:-}"
if [[ -z "${RUN_TAG}" ]]; then
  echo "usage: $0 <run-tag>" >&2
  echo "example: $0 2026-05-09-saturday-noon" >&2
  exit 1
fi

# Pull the bucket + function name from terraform output. Avoids pasting
# magic strings into this script — terraform is the source of truth.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${HERE}"
BUCKET="$(terraform output -raw results_bucket)"
FUNCTION_NAME="$(terraform output -raw function_name)"
REGIONS=$(terraform output -json regions | jq -r '.[]')

# Payload is the same across regions. Per-region Lambda picks up its
# AWS_REGION from the runtime env. resultsPrefix is the namespace
# under which all per-region jsonl files for this run cluster.
PAYLOAD=$(jq -nc \
  --arg prefix "runs/${RUN_TAG}" \
  --arg bucket "${BUCKET}" \
  --arg token "${LOADTEST_TOKEN:-}" \
  '{
    viewerCount: 17,
    runDurationSeconds: 850,
    cyclePeriodSeconds: 30,
    cycleJitterSeconds: 5,
    replayDurationSeconds: 850,
    resultsBucket: $bucket,
    resultsPrefix: $prefix,
    loadtestToken: ($token | select(. != ""))
  }')

echo "Run tag: ${RUN_TAG}"
echo "Bucket:  s3://${BUCKET}/runs/${RUN_TAG}"
echo "Regions: ${REGIONS}"
echo "Payload: ${PAYLOAD}"
echo

PIDS=()
for REGION in ${REGIONS}; do
  (
    OUT=$(mktemp)
    set -e
    # `--cli-read-timeout 0` disables aws CLI's default ~60s read
    # timeout. Without it, sync invocations of long-running Lambdas
    # (>60s) drop the connection client-side even though the Lambda
    # keeps running on the AWS side. The 850s run length blows past
    # that limit; setting 0 = wait forever.
    # `--cli-connect-timeout 60` keeps the *initial* connect timeout
    # short so a wedged region surfaces quickly instead of hanging.
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

# Wait for every region; if any one fails, exit non-zero so the user
# sees the failure instead of sailing on with partial data.
EXIT=0
for PID in "${PIDS[@]}"; do
  wait "${PID}" || EXIT=$?
done

if [[ "${EXIT}" -eq 0 ]]; then
  echo
  echo "All regions complete. Pull results with:"
  echo "  aws s3 sync s3://${BUCKET}/runs/${RUN_TAG}/ ./results/${RUN_TAG}/"
fi
exit "${EXIT}"
