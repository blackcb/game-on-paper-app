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
//
// Production-divergent overrides (necessary because the vitest pool
// can't start Cloudflare Containers — see leaderboard.test.ts +
// player-leaderboard.test.ts which mock globalThis.fetch and assume
// the droplet backend path):
//   - SUMMARY_BACKEND = "droplet" so lib/backends.ts returns the
//     fetch-based callable that globalThis.fetch can spy on, rather
//     than getContainer(env.SUMMARY_CONTAINER) which can't start.
// PYTHON_BACKEND is left as "container" — the game.test.ts suite is
// designed around that path and mocks the Container fetch differently.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: {
          SUMMARY_BACKEND: "droplet",
        },
      },
    }),
  ],
});
