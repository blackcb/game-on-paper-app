import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

// Vitest 4 + vitest-pool-workers 0.15 uses a plugin-based config: the
// pool wires itself in via `cloudflareTest(...)` rather than through
// `test.pool` / `test.poolOptions` (both removed in Vitest 4). Tests
// run inside an in-memory workerd via Miniflare, exercising the same
// runtime semantics as production (KV bindings, fetch handlers, JSX
// rendering) without booting wrangler dev or hitting Cloudflare.
//
// Pointing at wrangler.toml keeps the test env in sync with the
// production binding layout — when we add KV namespaces, secrets, or
// container bindings later, no test config changes needed.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
    }),
  ],
});
