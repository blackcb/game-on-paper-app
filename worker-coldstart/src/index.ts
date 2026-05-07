// Throwaway Worker for Phase 3A cold-start measurement.
//
// Proxies any /python/* request to a Cloudflare Container running our
// Python /cfb/process image, with timing data exposed via a custom
// `X-Cold-Start-Timing` response header. Lets us measure:
//   - first request after deploy (full image pull + container boot)
//   - first request after instance idle (container boot only)
//   - warm requests (steady-state)
//
// Delete this directory after cold-start data is captured in the
// migration plan.

import { Container, getContainer } from "@cloudflare/containers";

export class PythonContainer extends Container<Env> {
  // Container is reachable on this internal port. Matches gunicorn
  // bind in python/Dockerfile (-b 0.0.0.0:7000).
  defaultPort = 7000;

  // Auto-stop instance after N seconds of no traffic. Lower number =
  // more frequent cold starts (good for measuring); production setting
  // would be much higher.
  sleepAfter = "60s";
}

interface Env {
  PYTHON_CONTAINER: DurableObjectNamespace<PythonContainer>;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Health probe — proxies to /healthcheck on the container.
    if (url.pathname === "/healthcheck" || url.pathname === "/python/healthcheck") {
      const t0 = performance.now();
      const container = getContainer(env.PYTHON_CONTAINER);
      const upstreamStart = performance.now();
      const upstream = await container.fetch(
        new Request("http://container/healthcheck", { method: "GET" }),
      );
      const upstreamMs = performance.now() - upstreamStart;
      const totalMs = performance.now() - t0;
      const body = await upstream.text();
      return new Response(body, {
        status: upstream.status,
        headers: {
          "content-type": upstream.headers.get("content-type") ?? "text/plain",
          "x-cold-start-timing": `total=${Math.round(totalMs)}ms upstream=${Math.round(upstreamMs)}ms`,
          "cache-control": "no-store",
        },
      });
    }

    // Process probe — full PBP pipeline against a known good gameId.
    // Use ?gameId=NNN to override.
    if (url.pathname === "/process") {
      const gameId = url.searchParams.get("gameId") ?? "401628412";
      const t0 = performance.now();
      const container = getContainer(env.PYTHON_CONTAINER);
      const upstreamStart = performance.now();
      const upstream = await container.fetch(
        new Request("http://container/cfb/process", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ gameId }),
        }),
      );
      const upstreamMs = performance.now() - upstreamStart;
      const totalMs = performance.now() - t0;
      const bodyLen = (await upstream.arrayBuffer()).byteLength;
      return new Response(
        JSON.stringify({
          gameId,
          status: upstream.status,
          total_ms: Math.round(totalMs),
          upstream_ms: Math.round(upstreamMs),
          body_bytes: bodyLen,
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-cold-start-timing": `total=${Math.round(totalMs)}ms upstream=${Math.round(upstreamMs)}ms body=${bodyLen}b`,
            "cache-control": "no-store",
          },
        },
      );
    }

    return new Response(
      "GET /healthcheck — container /healthcheck (cheap)\n" +
        "GET /process?gameId=NNN — container /cfb/process (heavy)\n",
      { headers: { "content-type": "text/plain" } },
    );
  },
};
