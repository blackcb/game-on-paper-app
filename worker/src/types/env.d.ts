// Project-specific bindings declared inline rather than via the
// 13K-line `wrangler types` output. The runtime API surface (Fetcher,
// KVNamespace, ExecutionContext, etc.) comes from
// @cloudflare/workers-types, so we only need to declare what's
// project-specific here.
//
// Keep in sync with wrangler.toml [[kv_namespaces]] bindings. When new
// bindings get added (Cache API, container, secrets) extend this same
// interface.
declare namespace Cloudflare {
  interface Env {
    LEAGUE_DATA: KVNamespace;
    SUMMARY_LAST_UPDATED: KVNamespace;
  }
}

// Re-export so cloudflare:test's `env: Cloudflare.Env` resolves to the
// fully-typed shape inside test files, and so route handlers can refer
// to `Env` directly without going through `Cloudflare.Env`.
interface Env extends Cloudflare.Env {}
