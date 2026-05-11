// Tests for the python.unseen-university.org → PYTHON_CONTAINER proxy.
//
// Architecture B's tiered-cache fetch path targets
// python.unseen-university.org/cfb/process; this middleware lets us
// retire the legacy DigitalOcean droplet by serving that hostname
// from the same Worker via a service-binding to the Cloudflare
// Container.
//
// The handler runs as the first middleware in src/index.tsx,
// gated on `Host: python.unseen-university.org`. Requests to any
// other host fall through to the existing route table.

import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SECRET = "test-shared-secret";

beforeEach(() => {
  (env as { WORKER_SHARED_SECRET?: string }).WORKER_SHARED_SECRET = SECRET;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("python.unseen-university.org proxy", () => {
  it("rejects with 401 when X-Worker-Secret header is missing", async () => {
    const res = await SELF.fetch("https://python.unseen-university.org/cfb/process?gameId=401520434");
    expect(res.status).toBe(401);
  });

  it("rejects with 401 when X-Worker-Secret value is wrong", async () => {
    const res = await SELF.fetch(
      "https://python.unseen-university.org/cfb/process?gameId=401520434",
      { headers: { "X-Worker-Secret": "not-the-secret" } },
    );
    expect(res.status).toBe(401);
  });

  it("rejects with 401 when WORKER_SHARED_SECRET is unset on the Worker (fail-closed)", async () => {
    // Fail-closed: an empty secret in the env can't match any value
    // the caller sends. Production must have the secret configured
    // via `wrangler secret put WORKER_SHARED_SECRET`; this test
    // ensures a misconfigured deploy 401s rather than silently
    // accepting any value.
    (env as { WORKER_SHARED_SECRET?: string }).WORKER_SHARED_SECRET = "";
    const res = await SELF.fetch(
      "https://python.unseen-university.org/cfb/process?gameId=401520434",
      { headers: { "X-Worker-Secret": SECRET } },
    );
    expect(res.status).toBe(401);
  });

  it("requests to other hostnames do NOT hit the proxy (fall through to existing routes)", async () => {
    // /cfb/glossary on sports.example.com renders the GlossaryPage —
    // proves the proxy middleware only engages on the python.* host.
    const res = await SELF.fetch("https://sports.example.com/cfb/glossary");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  // The actual service-binding path is hard to exercise in the
  // vitest pool because the Container DO doesn't start under
  // @cloudflare/vitest-pool-workers (same constraint that affects
  // game.test.ts and loadtest-branch.test.ts). We verify the secret
  // gate + hostname routing above; the Container forward is
  // exercised by the production smoke after deploy.
});
