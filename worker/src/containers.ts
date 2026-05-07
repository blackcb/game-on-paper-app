// Cloudflare Container DO subclasses. Each container instance is
// fronted by one of these — `getContainer(env.PYTHON_CONTAINER)`
// returns a stub that proxies HTTP into the running container on
// `defaultPort`.
//
// `sleepAfter` decides how long an idle container stays warm before
// CF stops it. Cold-start cost on resume is ~14s on the slim image
// (3A.7 measurements), so longer = fewer user-visible cold starts at
// the cost of memory billing while warm. Driven by env.SEASON_MODE so
// we can flip without touching code: see worker/SEASON-MODES.md.
//
// 3B activation: once `[[containers]]` blocks land in wrangler.toml
// and `getContainer(env.PYTHON_CONTAINER).fetch(...)` is wired into
// the routes via lib/backends.ts, the user's request flow becomes
// Worker → DO (this class) → container HTTP → Python.

import { Container } from "@cloudflare/containers";

const SLEEP_AFTER: Record<string, string> = {
  peak: "1h",
  normal: "10m",
  offseason: "5m",
};

function sleepFor(env: { SEASON_MODE?: string }): string {
  return SLEEP_AFTER[env.SEASON_MODE ?? "normal"] ?? "10m";
}

export class PythonContainer extends Container<Env> {
  // Matches gunicorn bind in python/Dockerfile (-b 0.0.0.0:7000).
  defaultPort = 7000;
  // Resolved at construction-time from the env var. The `Container`
  // base class reads this once when the DO is spun up, so changing
  // SEASON_MODE requires a redeploy of the env profile (which is
  // exactly the season-flip workflow in SEASON-MODES.md).
  sleepAfter = sleepFor(this.env);
}

export class SummaryContainer extends Container<Env> {
  // Matches the `EXPOSE 3000` + `PORT=3000` in summary/Dockerfile.
  defaultPort = 3000;
  sleepAfter = sleepFor(this.env);
}
