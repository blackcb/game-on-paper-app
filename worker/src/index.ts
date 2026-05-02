// Phase 2A scaffold — placeholder app to confirm the Hono + Wrangler
// + TypeScript toolchain runs end-to-end. Real routes get ported in
// the order documented in docs/migration-plan.md sub-phase 2B,
// starting with /cfb/glossary.

import { Hono } from "hono";

type Bindings = {
  // KV namespaces (2C). Bulk league/team summary cache + a small
  // isolated namespace for the last-updated stamp, mirroring the
  // wrangler.toml [[kv_namespaces]] entries.
  LEAGUE_DATA: KVNamespace;
  SUMMARY_LAST_UPDATED: KVNamespace;
  // Container binding (3B), per-route secrets (2B+) get added below
  // as we port handlers.
};

const app = new Hono<{ Bindings: Bindings }>();

app.get("/", (c) => c.redirect("/cfb/"));

app.get("/cfb/", (c) =>
  c.text("gameonpaper Worker scaffold — port in progress (see docs/migration-plan.md Phase 2)."),
);

app.get("/cfb/healthcheck", (c) => c.json({ status: "ok", source: "worker-scaffold" }));

export default app;
