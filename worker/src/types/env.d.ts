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
    // Container DO bindings (3B). Optional so test envs that don't
    // configure containers still type-check; lib/backends.ts gates
    // the container codepath on the backend toggle anyway.
    PYTHON_CONTAINER?: DurableObjectNamespace;
    SUMMARY_CONTAINER?: DurableObjectNamespace;
    PYTHON_BACKEND?: string;
    SUMMARY_BACKEND?: string;
    SEASON_MODE?: string;
    CRON_WARM_ENABLED?: string;
    PREWARM_TOP_N?: string;
    PREWARM_BASE_URL?: string;
    PYTHON_BASE_URL: string;
    SUMMARY_BASE_URL: string;
    WORKER_SHARED_SECRET?: string;
  }
}

// Re-export so cloudflare:test's `env: Cloudflare.Env` resolves to the
// fully-typed shape inside test files, and so route handlers can refer
// to `Env` directly without going through `Cloudflare.Env`.
interface Env extends Cloudflare.Env {}
