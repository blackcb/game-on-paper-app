// AWS Lambda entrypoint. Wraps `runDriver` from ../driver.mjs so the
// same code runs from a laptop (`node driver.mjs`) and from a Lambda
// fanned out across US regions.
//
// EventBridge / Step Functions invokes this with an event payload of:
//   {
//     viewerCount: 17,
//     runDurationSeconds: 1800,
//     replayDurationSeconds: 1800,
//     cyclePeriodSeconds: 30,
//     targets: [...],     // optional, JSON-encoded if from env
//     gameIds: [...],     // optional, JSON-encoded if from env
//     resultsBucket: "gameonpaper-loadtest-results",  // S3 bucket
//     resultsPrefix: "runs/<run_id>/<region>"          // S3 key prefix
//   }
//
// Region label is taken from the AWS_REGION env var that Lambda sets
// automatically. Results stream to S3 as JSONL — one PUT at the end of
// the run, since Lambda's free-tier outbound is plenty for ~30 min ×
// 17 viewers × ~120 KB each ≈ 2 MB.

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
// `./driver.mjs` because terraform's archive_file flattens
// scripts/loadtest/driver.mjs and scripts/loadtest/lambda/handler.mjs
// into the same /var/task/ directory in the Lambda zip — the relative
// path resolves at Lambda runtime, not at git-checkout layout.
import { runDriver } from "./driver.mjs";

// S3Client must use the bucket's region, not the Lambda's region.
// terraform creates the bucket in var.primary_region (us-east-1) and
// every regional Lambda writes to it cross-region. The default
// S3Client picks up AWS_REGION from the Lambda env, which is the
// Lambda's *own* region — so a us-west-1 Lambda writing to a
// us-east-1 bucket would get HTTP 301 PermanentRedirect at PutObject
// time. Hardcode us-east-1 here; the Lambda env var
// LOADTEST_BUCKET_REGION lets a future re-deploy override without
// code changes.
const BUCKET_REGION = process.env.LOADTEST_BUCKET_REGION ?? "us-east-1";
const s3 = new S3Client({ region: BUCKET_REGION });

export const handler = async (event = {}) => {
  const region = process.env.AWS_REGION ?? event.region ?? "unknown";
  const lines = [];
  const emit = (line) => lines.push(JSON.stringify(line));

  const config = {
    region,
    viewerCount: event.viewerCount ?? 17,
    runDurationSeconds: event.runDurationSeconds ?? 1500,
    cyclePeriodSeconds: event.cyclePeriodSeconds ?? 30,
    cycleJitterSeconds: event.cycleJitterSeconds ?? 5,
    replayDurationSeconds: event.replayDurationSeconds ?? 1500,
    perViewerTimeoutMs: event.perViewerTimeoutMs ?? 20_000,
  };
  if (event.targets) config.targets = event.targets;
  if (event.gameIds) config.gameIds = event.gameIds;
  // Optional Cloudflare WAF bypass token. Pass via the invocation
  // payload (run.sh sets it from a local env var) instead of baking
  // into the Lambda env so rotating it doesn't require a redeploy.
  if (event.loadtestToken) config.loadtestToken = event.loadtestToken;

  const result = await runDriver(config, emit);

  const bucket = event.resultsBucket ?? process.env.LOADTEST_RESULTS_BUCKET;
  const prefix = event.resultsPrefix ?? `runs/${result.runId}`;
  if (!bucket) {
    // Local-mode invocation (e.g. AWS SAM local). Echo to stdout.
    process.stdout.write(lines.join("\n") + "\n");
    return { runId: result.runId, region, lineCount: lines.length };
  }
  const key = `${prefix}/${region}.jsonl`;
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: lines.join("\n") + "\n",
      ContentType: "application/x-ndjson",
    }),
  );
  return {
    runId: result.runId,
    region,
    lineCount: lines.length,
    s3Url: `s3://${bucket}/${key}`,
  };
};
