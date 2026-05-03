// Per-request timing accumulator wired to a Server-Timing response
// header + a single structured-JSON log line on response. Hono port
// of frontend/cfb/timing.js — same op names so the perf-plan
// baselines stay 1:1 comparable across the Express and Worker
// stacks.
//
// Usage:
//   app.use('*', timingMiddleware());                 // once, before routes
//   const data = await time(c, 'python', () => ...);  // any handler
//
// On the way out the middleware reads the accumulated timings off
// `c.var.timings`, sets the Server-Timing header on the outgoing
// response, and writes a `{event: 'request', ...}` JSON line to
// stdout. Workers Logs surfaces the line in the dashboard; the
// header surfaces in DevTools' Network panel.

import type { Context, MiddlewareHandler } from "hono";

export type Timings = Record<string, number>;

// Hono `c.var.timings` shape — declared here so route handlers can
// `c.set('timings', ...)` typed access via module augmentation.
declare module "hono" {
  interface ContextVariableMap {
    timings: Timings;
  }
}

function nowMs(): number {
  return performance.now();
}

function header(timings: Timings): string {
  return Object.entries(timings)
    .map(([name, ms]) => `${name};dur=${ms.toFixed(0)}`)
    .join(", ");
}

interface RequestLog {
  event: "request";
  method: string;
  path: string;
  status: number;
  // Each timing key gets serialized as `${key}_ms` to match
  // frontend/cfb/timing.js:logMetrics — tooling on the perf-plan
  // side parses these field names.
  [key: string]: unknown;
}

function logRequest(
  method: string,
  path: string,
  status: number,
  timings: Timings,
): void {
  const line: RequestLog = {
    event: "request",
    method,
    path,
    status,
  };
  for (const [k, v] of Object.entries(timings)) {
    line[`${k}_ms`] = Math.round(v);
  }
  try {
    console.log(JSON.stringify(line));
  } catch {
    // logging must never break a response
  }
}

export function timingMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const requestStart = nowMs();
    c.set("timings", {});
    await next();
    // Hono swaps c.res for downstream-set responses; reading after
    // next() gives us the final outgoing Response. We mutate its
    // headers directly because c.res.headers is the live Headers
    // instance Hono will serialize.
    const timings = c.var.timings;
    timings.total = nowMs() - requestStart;
    const value = header(timings);
    if (value) {
      try {
        c.res.headers.set("Server-Timing", value);
      } catch {
        // immutable response (rare; e.g. cached Response from
        // caches.default.match) — header set is a best-effort.
      }
    }
    logRequest(c.req.method, c.req.path, c.res.status, timings);
  };
}

// Wrap an async op so its duration accumulates in c.var.timings
// under `name`. Same op name fired multiple times sums into one
// bucket (e.g. two summary fetches in parallel still surface as
// `summary;dur=N`).
export async function time<T>(
  c: Context,
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  const t0 = nowMs();
  try {
    return await fn();
  } finally {
    const ms = nowMs() - t0;
    const timings = c.var.timings;
    if (timings) {
      timings[name] = (timings[name] ?? 0) + ms;
    }
  }
}
