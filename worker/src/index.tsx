// Phase 2 worker entry. Routes are ported in the order documented in
// docs/migration-plan.md sub-phase 2B; this file wires them up.

import { Hono } from "hono";
import { getGlossary } from "./lib/glossary";
import { GlossaryPage } from "./templates/Glossary";

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

// First real port (sub-phase 2B). Static-ish page — validates that the
// Layout component, Hono JSX renderer, and JSON-data import path all
// work end-to-end before we tackle a route that hits ESPN or KV.
app.get("/cfb/glossary", (c) => c.html(<GlossaryPage glossary={getGlossary()} />));

export default app;
