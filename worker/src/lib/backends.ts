// Toggleable backend layer for the Python and summary services.
//
// During the 3B/3D cutover both transports coexist: the legacy
// droplet path (HTTPS to Caddy + X-Worker-Secret) and the new
// Cloudflare Container path (DO `getContainer().fetch(...)`).
// `PYTHON_BACKEND` and `SUMMARY_BACKEND` env vars pick which one
// each request uses, defaulting to "droplet" so production
// behavior on first deploy is unchanged.
//
// Once the Containers cutover is stable (3D), the toggle env vars
// and the droplet path get deleted; backendFetch becomes a thin
// wrapper around getContainer().

import { getContainer } from "@cloudflare/containers";
import type { PythonContainer, SummaryContainer } from "../containers";

// Path-relative fetch: callers pass `/cfb/process` or
// `/percentiles?year=2024`, the backend prepends the right base
// (HTTPS host or `http://container`) and stamps auth headers when
// going through the droplet.
export type BackendFetch = (
  path: string,
  init?: RequestInit,
) => Promise<Response>;

// Subset of Env that the backend needs. Declared inline so this
// module doesn't require types/env.d.ts to have absorbed the
// container bindings before deploy-time.
interface BackendEnv {
  PYTHON_BACKEND?: string;
  SUMMARY_BACKEND?: string;
  PYTHON_BASE_URL: string;
  SUMMARY_BASE_URL: string;
  WORKER_SHARED_SECRET?: string;
  PYTHON_CONTAINER?: DurableObjectNamespace<PythonContainer>;
  SUMMARY_CONTAINER?: DurableObjectNamespace<SummaryContainer>;
}

// Exported so tests can construct a SummaryConfig that exercises
// the same droplet codepath production uses, so existing
// `globalThis.fetch` mocks keep working.
//
// Plain-object header merge (rather than `new Headers(...)`) so
// callers' fetch spies see the same `Record<string, string>` shape
// they did pre-3B — header-property assertions in test files
// continue to work without rewriting them.
export function dropletFetch(base: string, secret?: string | null): BackendFetch {
  return (path, init) => {
    const headers: Record<string, string> = {
      ...((init?.headers as Record<string, string> | undefined) ?? {}),
    };
    if (secret) headers["X-Worker-Secret"] = secret;
    return fetch(`${base}${path}`, { ...init, headers });
  };
}

function containerFetch<T extends PythonContainer | SummaryContainer>(
  binding: DurableObjectNamespace<T>,
): BackendFetch {
  const stub = getContainer(binding);
  // The container's HTTP server doesn't care about the host part
  // of the URL — only the path/query — but `fetch()` needs a valid
  // absolute URL. Use the conventional `http://container` prefix.
  return (path, init) => stub.fetch(`http://container${path}`, init);
}

export function pythonBackend(env: BackendEnv): BackendFetch {
  if (env.PYTHON_BACKEND === "container" && env.PYTHON_CONTAINER) {
    return containerFetch(env.PYTHON_CONTAINER);
  }
  return dropletFetch(env.PYTHON_BASE_URL, env.WORKER_SHARED_SECRET);
}

export function summaryBackend(env: BackendEnv): BackendFetch {
  if (env.SUMMARY_BACKEND === "container" && env.SUMMARY_CONTAINER) {
    return containerFetch(env.SUMMARY_CONTAINER);
  }
  return dropletFetch(env.SUMMARY_BASE_URL, env.WORKER_SHARED_SECRET);
}
