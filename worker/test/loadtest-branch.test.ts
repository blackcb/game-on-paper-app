// Tests for the harness-gated load-test branch on /cfb/game/:gameId.
//
// The branch is dead for normal traffic (gated on `?replay=<unix_ts>`),
// so these tests exercise an architectural seam, not user-visible
// behavior. They confirm:
//   - The branch correctly skips the ESPN STATUS probe
//   - `?arch=baseline` uses caches.default + service-binding shape
//   - `?arch=tiered` skips caches.default and uses fetch+cf
//   - `x-arch` response header faithfully reports which path served
//   - Replay propagation: the upstream request hits /cfb/process/replay
//     with the right query params
//
// See worker/scripts/loadtest/README.md for end-to-end context.

import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vitest-pool-workers does not currently start a real Container DO for
// the production-default `PYTHON_BACKEND="container"` config. Force the
// dropletFetch path (HTTPS to PYTHON_BASE_URL via globalThis.fetch) so
// the harness branch is exercised end-to-end through a mock the test
// can intercept. The same pre-existing limitation breaks 4 of 17 tests
// in game.test.ts; this override is the local fix.
beforeEach(() => {
  (env as { PYTHON_BACKEND?: string }).PYTHON_BACKEND = "droplet";
});

afterEach(() => {
  vi.restoreAllMocks();
});

const jsonResponse = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  });

// Same minimal in-progress payload shape /cfb/process/replay returns.
// The Worker's reshape pipeline only requires a few fields to render
// the Game template successfully; replay's truncated fixture is shape-
// compatible because it's a slice of an `expected.json` snapshot.
const inProgressReplayResponse = (overrides: Record<string, unknown> = {}) => ({
  plays: [
    {
      game_play_number: 1,
      period: 1,
      pos_team: "61",
      clock: { displayValue: "12:34", minutes: "12", seconds: "34" },
      type: { text: "Pass Reception" },
      text: "Carson Beck 22 yard pass",
      scoringPlay: false,
      homeScore: 0,
      awayScore: 0,
      pass: 1,
      start: {
        down: 1,
        distance: 10,
        yardsToEndzone: 22,
        pos_team: { id: "61" },
        team: { id: "61" },
        pos_team_score: 0,
        def_pos_team_score: 0,
      },
      end: { yardsToEndzone: 0, team: { id: "61" } },
      expectedPoints: { added: 4.2, before: 1.8, after: 6.0 },
      winProbability: { added: 0.15, before: 0.45, after: 0.6 },
      EPA: 4.2,
      "drive.id": "1",
    },
  ],
  boxScore: {},
  box_score: { team: [], situational: [], drives: [], defensive: [], turnover: [] },
  drives: { previous: [], current: null },
  header: {
    season: { year: 2024 },
    competitions: [
      {
        id: "401520434",
        date: "2024-09-07T00:00Z",
        status: {
          type: {
            completed: false,
            description: "In Progress",
            detail: "In Progress",
            name: "STATUS_IN_PROGRESS",
            state: "in",
          },
        },
        competitors: [
          {
            homeAway: "home",
            team: { id: "61", abbreviation: "UGA", nickname: "Bulldogs", color: "BA0C2F" },
            score: 0,
          },
          {
            homeAway: "away",
            team: { id: "333", abbreviation: "ALA", nickname: "Crimson Tide", color: "9E1B32" },
            score: 0,
          },
        ],
        broadcasts: [{ media: { shortName: "ESPN" } }],
      },
    ],
  },
  homeTeamId: "61",
  awayTeamId: "333",
  ...overrides,
});

let nextGameId = 401990000;
const uniqueGameId = (): string => String(nextGameId++);

describe("/cfb/game/:gameId ?replay= load-test branch", () => {
  it("skips ESPN STATUS probe entirely (only Python /cfb/process/replay is called)", async () => {
    const id = uniqueGameId();
    const startedAt = Math.floor(Date.now() / 1000) - 60;
    const seenUrls: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      seenUrls.push(url);
      // The ESPN cdn URL must NEVER appear in the load-test branch —
      // replay always returns a known status, so the probe is dead
      // weight that would add a real-network round trip per cycle.
      if (url.includes("cdn.espn.com/core/college-football/playbyplay")) {
        throw new Error("ESPN probe must not run in load-test branch");
      }
      if (url.includes("/cfb/process/replay")) {
        // Confirm the right query-string params got propagated.
        const u = new URL(url);
        expect(u.searchParams.get("gameId")).toBe(id);
        expect(u.searchParams.get("replay_started_at")).toBe(String(startedAt));
        expect(u.searchParams.get("replay_duration")).toBe("1800");
        return jsonResponse(inProgressReplayResponse());
      }
      // summary's percentiles call is allowed to fall through; we're
      // not asserting on it here.
      return jsonResponse({ results: [] });
    });
    const res = await SELF.fetch(
      `https://example.com/cfb/game/${id}?replay=${startedAt}&replay_duration=1800&arch=baseline`,
    );
    if (res.status !== 200) {
      // Surface what came back + which URLs the worker called so the
      // failure line in CI tells you what to fix without running the
      // test locally.
      console.error("baseline test got", res.status, await res.text(), "urls:", seenUrls);
    }
    expect(res.status).toBe(200);
    expect(res.headers.get("x-arch")).toBe("baseline");
    // Cache-Control still reflects the in-progress branch — the
    // synthetic fixture's STATUS_IN_PROGRESS triggers the short-TTL
    // header just as a real in-progress response would.
    expect(res.headers.get("cache-control")).toContain("max-age=30");
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("?arch=tiered serves through the fetch+cf path with x-arch=tiered", async () => {
    const id = uniqueGameId();
    const startedAt = Math.floor(Date.now() / 1000) - 30;
    let cfObjectSeen: Record<string, unknown> | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/cfb/process/replay")) {
        // Architecture B is the cf-object-on-fetch path. The
        // RequestInit's `cf` field is what the harness's analysis is
        // measuring against — confirm it's actually set.
        cfObjectSeen = (init as { cf?: Record<string, unknown> } | undefined)?.cf;
        return jsonResponse(inProgressReplayResponse());
      }
      return jsonResponse({ results: [] });
    });
    const res = await SELF.fetch(
      `https://example.com/cfb/game/${id}?replay=${startedAt}&arch=tiered`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-arch")).toBe("tiered");
    expect(cfObjectSeen).toBeDefined();
    expect(cfObjectSeen?.cacheEverything).toBe(true);
    expect(cfObjectSeen?.cacheTtlByStatus).toMatchObject({
      "200-299": 30,
      "404": 1,
      "500-599": 0,
    });
  });

  it("?arch=baseline + repeat hit serves from caches.default with x-worker-cache=HIT", async () => {
    const id = uniqueGameId();
    const startedAt = Math.floor(Date.now() / 1000) - 30;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/cfb/process/replay")) {
        return jsonResponse(inProgressReplayResponse());
      }
      return jsonResponse({ results: [] });
    });
    const url = `https://example.com/cfb/game/${id}?replay=${startedAt}&arch=baseline`;
    const r1 = await SELF.fetch(url);
    expect(r1.status).toBe(200);
    // Drain the body so the response is fully realized in the test
    // pool's caches.default mock — without this, cache.put may not
    // resolve before the second SELF.fetch reads.
    await r1.text();
    const r2 = await SELF.fetch(url);
    expect(r2.status).toBe(200);
    expect(r2.headers.get("x-worker-cache")).toBe("HIT");
    expect(r2.headers.get("x-arch")).toBe("baseline");
    // The harness only counts requests that hit upstream Python as
    // "amplification"; this test is the proof that arch=baseline
    // amplifies origin once per cache TTL per PoP. Both calls should
    // not have produced two upstream replay calls — only one.
    const replayCalls = fetchSpy.mock.calls.filter(([input]) => {
      const u = typeof input === "string" ? input : (input as Request).url;
      return u.includes("/cfb/process/replay");
    });
    expect(replayCalls.length).toBe(1);
  });

  it("invalid replay value falls through to production code path (no x-arch header)", async () => {
    const id = uniqueGameId();
    // Production code path runs the ESPN probe, so the mock must
    // expose ESPN this time (lack of it would fail the production
    // handler with a 500 it doesn't catch in the same way as the
    // load-test path).
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("cdn.espn.com/core/college-football/playbyplay")) {
        return jsonResponse({
          gamepackageJSON: {
            header: {
              season: { year: 2024 },
              week: 1,
              competitions: [
                {
                  status: { type: { name: "STATUS_FINAL", completed: true, detail: "Final" } },
                  competitors: [
                    {
                      team: { id: "61", abbreviation: "UGA", nickname: "Bulldogs", color: "BA0C2F" },
                    },
                    {
                      team: { id: "333", abbreviation: "ALA", nickname: "Crimson Tide", color: "9E1B32" },
                    },
                  ],
                },
              ],
            },
          },
        });
      }
      if (url.includes("/cfb/process") && !url.includes("/cfb/process/replay")) {
        return jsonResponse(inProgressReplayResponse({
          header: {
            season: { year: 2024 },
            competitions: [
              {
                id: "401520434",
                date: "2024-09-07T00:00Z",
                status: { type: { name: "STATUS_FINAL", completed: true, detail: "Final" } },
                competitors: [
                  {
                    homeAway: "home",
                    team: { id: "61", abbreviation: "UGA", nickname: "Bulldogs", color: "BA0C2F" },
                    score: 28,
                  },
                  {
                    homeAway: "away",
                    team: { id: "333", abbreviation: "ALA", nickname: "Crimson Tide", color: "9E1B32" },
                    score: 21,
                  },
                ],
                broadcasts: [{ media: { shortName: "ESPN" } }],
              },
            ],
          },
        }));
      }
      return jsonResponse({ results: [] });
    });
    const res = await SELF.fetch(
      `https://example.com/cfb/game/${id}?replay=not-a-number`,
    );
    expect(res.status).toBe(200);
    // Production path does not stamp x-arch. If we accidentally
    // dispatched to the load-test branch with NaN, that header would
    // show up.
    expect(res.headers.get("x-arch")).toBeNull();
  });
});
