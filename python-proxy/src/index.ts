// python.unseen-university.org → PythonContainer proxy.
//
// One job: validate X-Worker-Secret, forward to the cross-Worker
// PythonContainer DO. Lives in its own Worker (rather than as a
// middleware on `sports`) so the sports Worker's `fetch+cf` to this
// hostname crosses a script boundary and Architecture B's CF cache
// engages — same-Worker self-fetch bypasses the cache, which is the
// failure mode that broke Phase 3G. See docs/migration-plan.md §3H.

import { getContainer, Container } from "@cloudflare/containers";

// Mirror of worker/src/containers.ts:PythonContainer. We don't declare
// the DO here (script_name in wrangler.toml binds to the sports
// Worker's declaration), but TypeScript needs the class shape so the
// DurableObjectNamespace<PythonContainer> binding type-checks.
export class PythonContainer extends Container<Env> {
  override defaultPort = 7000;
  override sleepAfter = "10m";
}

type Env = {
  PYTHON_CONTAINER?: DurableObjectNamespace<PythonContainer>;
  WORKER_SHARED_SECRET?: string;
};

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // 2026-05-12 incident instrumentation, carried over from the
    // sports-Worker middleware (Phase 3G). Keep until 3H is closed and
    // a Saturday slate has run cleanly, then trim.
    console.log(JSON.stringify({
      event: "proxy_in",
      path: url.pathname,
      query: url.search,
      method: req.method,
    }));

    // Fail-closed secret check. Production sets WORKER_SHARED_SECRET
    // via `wrangler secret put`; local dev sets it in .dev.vars.
    const secret = req.headers.get("x-worker-secret");
    if (!env.WORKER_SHARED_SECRET || secret !== env.WORKER_SHARED_SECRET) {
      console.log(JSON.stringify({ event: "proxy_unauthorized" }));
      return new Response("unauthorized", { status: 401 });
    }

    if (!env.PYTHON_CONTAINER) {
      console.log(JSON.stringify({ event: "proxy_no_binding" }));
      return new Response("python container binding unavailable", { status: 503 });
    }

    // Forward to the Container DO via service binding. The
    // http://container origin is the CF convention placeholder; the
    // container's HTTP server keys off path+query+method+body.
    const stub = getContainer(env.PYTHON_CONTAINER);
    const forwarded = new Request(
      `http://container${url.pathname}${url.search}`,
      {
        method: req.method,
        headers: req.headers,
        body:
          req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
      },
    );

    console.log(JSON.stringify({ event: "proxy_pre_fetch" }));
    const t0 = Date.now();
    try {
      const response = await stub.fetch(forwarded);
      console.log(JSON.stringify({
        event: "proxy_post_fetch",
        ms: Date.now() - t0,
        status: response.status,
      }));
      return response;
    } catch (err) {
      console.log(JSON.stringify({
        event: "proxy_fetch_error",
        ms: Date.now() - t0,
        error: (err as Error).message,
      }));
      throw err;
    }
  },
};
