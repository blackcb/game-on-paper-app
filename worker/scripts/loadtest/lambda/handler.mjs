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

const s3 = new S3Client({});

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
