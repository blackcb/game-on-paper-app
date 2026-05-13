// Proxy auth-gate tests. Ported from
// worker/test/python-proxy.test.ts (which is deleted in the Phase 3H
// cutover commit) — the host-gate case is dropped because this Worker
// only serves one hostname.
//
// The Container forward is not exercised in the pool: cross-Worker
// DurableObject bindings (`script_name = "sports"`) require both
// scripts to be deployed, and the vitest pool only loads this one.
// Production smoke after deploy covers the happy path.

import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SECRET = "test-shared-secret";

beforeEach(() => {
  (env as { WORKER_SHARED_SECRET?: string }).WORKER_SHARED_SECRET = SECRET;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("python-proxy auth gate", () => {
  it("rejects with 401 when X-Worker-Secret header is missing", async () => {
    const res = await SELF.fetch(
      "https://python.unseen-university.org/cfb/process?gameId=401520434",
    );
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
    (env as { WORKER_SHARED_SECRET?: string }).WORKER_SHARED_SECRET = "";
    const res = await SELF.fetch(
      "https://python.unseen-university.org/cfb/process?gameId=401520434",
      { headers: { "X-Worker-Secret": SECRET } },
    );
    expect(res.status).toBe(401);
  });
});
