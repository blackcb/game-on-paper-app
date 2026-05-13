import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

// In-memory workerd via Miniflare. Same pool the sports Worker uses
// (worker/vitest.config.mts) — keeps the test runtime semantics
// identical so a passing test here ports cleanly if this proxy ever
// merges back into another Worker.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.test.toml" },
    }),
  ],
});
