// Phase 2A scaffold — placeholder app to confirm the Hono + Wrangler
// + TypeScript toolchain runs end-to-end. Real routes get ported in
// the order documented in docs/migration-plan.md sub-phase 2B,
// starting with /cfb/glossary.

import { Hono } from "hono";

type Bindings = {
  // KV / Container / secrets bindings get added here in 2B–2D.
};

const app = new Hono<{ Bindings: Bindings }>();

app.get("/", (c) => c.redirect("/cfb/"));

app.get("/cfb/", (c) =>
  c.text("gameonpaper Worker scaffold — port in progress (see docs/migration-plan.md Phase 2)."),
);

app.get("/cfb/healthcheck", (c) => c.json({ status: "ok", source: "worker-scaffold" }));

export default app;
