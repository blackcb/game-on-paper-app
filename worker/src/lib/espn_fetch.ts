// Shared fetch wrapper for server-side ESPN requests.
//
// 2026-08-16: ESPN started 403ing UA-less fetches from Workers
// egress (verified via `espn_scoreboard_failure ... returned 403`
// in Workers Logs while the same URL returned 99 events from a
// residential IP). This matches the bot-blocking wave the upstream
// project is fighting — their fix is the same browser-UA stamp
// (upstream commit cc0ea1c "wrapping ESPN requests in some sample
// User Agents"). Route every ESPN call through this wrapper so the
// header can't drift per-call-site.
const ESPN_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";

export function espnFetch(url: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (!headers.has("User-Agent")) headers.set("User-Agent", ESPN_UA);
  return fetch(url, { ...init, headers });
}
