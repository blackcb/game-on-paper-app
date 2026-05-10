// Tests for the production /cfb/game/:gameId tiered-fetch migration.
// Distinct from worker/test/loadtest-branch.test.ts (which exercises
// the harness-gated query-param branch) and worker/test/game.test.ts
// (which exercises the production path). This file specifically
// covers the env-var-gated dispatch between service (today) and
// tiered (post-migration) on the production game route.

import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Same dropletFetch override the existing game.test.ts uses to work
// around the Container DO not being enabled in the vitest pool. See
// the comment on game.test.ts for the full story; tl;dr the test
// pool can't run the production-default container backend, so we
// route through PYTHON_BASE_URL via dropletFetch which DOES work
// against globalThis.fetch mocks.
beforeEach(() => {
  (env as { PYTHON_BACKEND?: string }).PYTHON_BACKEND = "droplet";
});

afterEach(() => {
  vi.restoreAllMocks();
  // Reset PYTHON_FETCH_MODE between tests so a test forgetting to
  // set it explicitly doesn't pick up the previous test's setting.
  (env as { PYTHON_FETCH_MODE?: string }).PYTHON_FETCH_MODE = "service";
});

const jsonResponse = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  });

// Same shape used by other game tests — minimal valid Python response
// the Worker can render successfully.
const espnEnvelope = (overrides: Record<string, unknown> = {}) => ({
  gamepackageJSON: {
    header: {
      season: { year: 2024 },
      week: 1,
      competitions: [
        {
          status: { type: { name: "STATUS_FINAL", completed: true, detail: "Final" } },
          competitors: [
            { team: { id: "61", abbreviation: "UGA", nickname: "Bulldogs", color: "BA0C2F" } },
            { team: { id: "333", abbreviation: "ALA", nickname: "Crimson Tide", color: "9E1B32" } },
          ],
          ...overrides,
        },
      ],
    },
  },
});

const pythonResponse = () => ({
  plays: [
    {
      game_play_number: 1,
      period: 1,
      pos_team: "61",
      clock: { displayValue: "12:34", minutes: "12", seconds: "34" },
      type: { text: "Pass Reception" },
      text: "Carson Beck 22 yard pass to Arian Smith for a TD",
      scoringPlay: true,
      homeScore: 7,
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
        id: "401628412",
        date: "2024-09-07T00:00Z",
        status: { type: { name: "STATUS_FINAL", completed: true, detail: "Final" } },
        competitors: [
          {
            homeAway: "home",
            team: { id: "61", abbreviation: "UGA", nickname: "Bulldogs", color: "BA0C2F" },
            score: 7,
          },
          {
            homeAway: "away",
            team: { id: "333", abbreviation: "ALA", nickname: "Crimson Tide", color: "9E1B32" },
            score: 0,
          },
        ],
      },
    ],
  },
  homeTeamId: "61",
  awayTeamId: "333",
});

let nextGameId = 401990500;
const uniqueGameId = (): string => String(nextGameId++);

describe("/cfb/game/:gameId PYTHON_FETCH_MODE dispatch", () => {
  it("default (PYTHON_FETCH_MODE unset) goes through service path; x-fetch-mode header reflects it", async () => {
    const id = uniqueGameId();
    let cfObjectSeen: unknown = "not-set";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("cdn.espn.com/core/college-football/playbyplay")) {
        return jsonResponse(espnEnvelope());
      }
      if (url.includes("/cfb/process")) {
        cfObjectSeen = (init as { cf?: unknown } | undefined)?.cf ?? "no-cf";
        return jsonResponse(pythonResponse());
      }
      return jsonResponse({ results: [] });
    });
    // Default (env var unset) should be service mode.
    delete (env as { PYTHON_FETCH_MODE?: string }).PYTHON_FETCH_MODE;
    const res = await SELF.fetch(`https://example.com/cfb/game/${id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-fetch-mode")).toBe("service");
    // Service path uses POST without a cf object.
    expect(cfObjectSeen).toBe("no-cf");
    // No x-upstream-cache because service mode doesn't populate it.
    expect(res.headers.get("x-upstream-cache")).toBeNull();
  });

  it("PYTHON_FETCH_MODE=tiered uses fetch+cf with cacheEverything + cacheTtlByStatus", async () => {
    const id = uniqueGameId();
    let cfObjectSeen: Record<string, unknown> | undefined;
    let methodSeen: string | undefined;
    let urlSeen: string | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("cdn.espn.com/core/college-football/playbyplay")) {
        return jsonResponse(espnEnvelope());
      }
      if (url.includes("/cfb/process")) {
        urlSeen = url;
        methodSeen = (init as { method?: string } | undefined)?.method;
        cfObjectSeen = (init as { cf?: Record<string, unknown> } | undefined)?.cf;
        // Stamp a synthetic cf-cache-status so x-upstream-cache shows up.
        return jsonResponse(pythonResponse(), {
          headers: { "content-type": "application/json", "cf-cache-status": "MISS" },
        });
      }
      return jsonResponse({ results: [] });
    });
    (env as { PYTHON_FETCH_MODE?: string }).PYTHON_FETCH_MODE = "tiered";
    const res = await SELF.fetch(`https://example.com/cfb/game/${id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-fetch-mode")).toBe("tiered");
    // Tiered path = GET with gameId in URL, not POST with body.
    expect(methodSeen).toBe("GET");
    expect(urlSeen).toBeDefined();
    expect(urlSeen).toContain(`gameId=${id}`);
    expect(cfObjectSeen).toBeDefined();
    expect(cfObjectSeen?.cacheEverything).toBe(true);
    expect(cfObjectSeen?.cacheTtlByStatus).toMatchObject({
      "200-299": 30,
      "404": 1,
      "500-599": 0,
    });
    // The Worker propagates the inner fetch's cf-cache-status as the
    // x-upstream-cache header so operators can see whether the
    // tiered cache is engaging without parsing server-timing.
    expect(res.headers.get("x-upstream-cache")).toBe("MISS");
  });

  it("tiered mode JSON shortcut (?json=1) propagates x-fetch-mode + x-upstream-cache", async () => {
    const id = uniqueGameId();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("cdn.espn.com/core/college-football/playbyplay")) {
        return jsonResponse(espnEnvelope());
      }
      if (url.includes("/cfb/process")) {
        return jsonResponse(pythonResponse(), {
          headers: { "content-type": "application/json", "cf-cache-status": "HIT" },
        });
      }
      return jsonResponse({ results: [] });
    });
    (env as { PYTHON_FETCH_MODE?: string }).PYTHON_FETCH_MODE = "tiered";
    const res = await SELF.fetch(`https://example.com/cfb/game/${id}?json=1`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("x-fetch-mode")).toBe("tiered");
    expect(res.headers.get("x-upstream-cache")).toBe("HIT");
  });

  it("tiered mode failure path keeps the existing GameError fallback (no PYTHON_FETCH_MODE-specific divergence)", async () => {
    const id = uniqueGameId();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("cdn.espn.com/core/college-football/playbyplay")) {
        return jsonResponse(espnEnvelope());
      }
      if (url.includes("/cfb/process")) {
        return new Response("upstream broke", { status: 503 });
      }
      return jsonResponse({ results: [] });
    });
    (env as { PYTHON_FETCH_MODE?: string }).PYTHON_FETCH_MODE = "tiered";
    const res = await SELF.fetch(`https://example.com/cfb/game/${id}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    // GameError page renders. The unique signal is the no-store
    // Cache-Control documented on CACHE_CONTROL.errorNoStore.
    expect(res.headers.get("cache-control")).toContain("no-store");
    // GameError page contains the error-specific copy. We don't
    // pin a specific string because the template wording can change;
    // checking for the absence of "Win Probability" (a Game-page
    // marker) is the cleaner inversion.
    expect(body).not.toContain("Win Probability");
  });
});
