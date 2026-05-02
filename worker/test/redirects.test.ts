import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { CURRENT_SEASON } from "../src/lib/season";

// One assertion per redirect from frontend/cfb/routes.js. We use
// `redirect: "manual"` so SELF.fetch returns the 302 itself instead of
// chasing the Location header into a route that may 404 in the
// in-progress port. The eventual cutover gate (re-pointing the
// existing Playwright suite at the worker) will validate that the
// redirect destinations resolve to a real page.

const cases: Array<{ from: string; to: string }> = [
  { from: "/cfb/teams", to: `/cfb/year/${CURRENT_SEASON}/teams/differential` },
  { from: "/cfb/teams/offensive", to: `/cfb/year/${CURRENT_SEASON}/teams/offensive` },
  { from: "/cfb/teams/defensive", to: `/cfb/year/${CURRENT_SEASON}/teams/defensive` },
  { from: "/cfb/year/2024/teams", to: `/cfb/year/2024/teams/differential` },
  { from: "/cfb/charts/team/epa", to: `/cfb/year/${CURRENT_SEASON}/charts/team/epa` },
  { from: "/cfb/players", to: `/cfb/year/${CURRENT_SEASON}/players/passing` },
  { from: "/cfb/players/rushing", to: `/cfb/year/${CURRENT_SEASON}/players/rushing` },
  { from: "/cfb/year/2018/players", to: `/cfb/year/2018/players/passing` },
];

describe("static redirects", () => {
  it.each(cases)("$from -> $to", async ({ from, to }) => {
    const res = await SELF.fetch(`http://localhost${from}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(to);
  });
});
