// Tests for the KV-backed completed-game HTML cache.
//
// Three behaviors covered:
//   1. KV hit short-circuits the pipeline — no Python call, response
//      stamped x-html-cache: HIT.
//   2. KV miss runs the pipeline, then writes the rendered HTML to
//      KV — response stamped x-html-cache: MISS.
//   3. In-progress + pregame paths don't read/write KV.

import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Same dropletFetch override the other game tests use to work around
// the Container DO not starting in the vitest pool.
beforeEach(() => {
  (env as { PYTHON_BACKEND?: string; PYTHON_FETCH_MODE?: string }).PYTHON_BACKEND = "droplet";
  (env as { PYTHON_FETCH_MODE?: string }).PYTHON_FETCH_MODE = "service";
});

afterEach(async () => {
  vi.restoreAllMocks();
  // Clear LEAGUE_DATA between tests so KV state from one test doesn't
  // leak into the next.
  const list = await env.LEAGUE_DATA.list();
  for (const k of list.keys) await env.LEAGUE_DATA.delete(k.name);
});

const jsonResponse = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  });

const completedEspnEnvelope = () => ({
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
        },
      ],
    },
  },
});

const completedPythonResponse = () => ({
  plays: [
    {
      game_play_number: 1,
      period: 1,
      pos_team: "61",
      clock: { displayValue: "12:34", minutes: "12", seconds: "34" },
      type: { text: "Pass Reception" },
      text: "Carson Beck pass to Arian Smith",
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
          { homeAway: "home", team: { id: "61", abbreviation: "UGA", nickname: "Bulldogs", color: "BA0C2F" }, score: 7 },
          { homeAway: "away", team: { id: "333", abbreviation: "ALA", nickname: "Crimson Tide", color: "9E1B32" }, score: 0 },
        ],
      },
    ],
  },
  homeTeamId: "61",
  awayTeamId: "333",
});

let nextGameId = 401999500;
const uniqueGameId = (): string => String(nextGameId++);

describe("/cfb/game/:gameId KV-backed HTML cache", () => {
  it("KV HIT short-circuits the Python pipeline (no /cfb/process call)", async () => {
    const id = uniqueGameId();
    // Pre-seed KV with a known body.
    const SEEDED_HTML = "<html><body>SEEDED_FROM_KV</body></html>";
    await env.LEAGUE_DATA.put(`game-html:v2:${id}`, SEEDED_HTML);

    let pythonHits = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("cdn.espn.com/core/college-football/playbyplay")) {
        return jsonResponse(completedEspnEnvelope());
      }
      if (url.includes("/cfb/process")) {
        pythonHits += 1;
        return jsonResponse(completedPythonResponse());
      }
      return jsonResponse({ results: [] });
    });

    const res = await SELF.fetch(`https://example.com/cfb/game/${id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-html-cache")).toBe("HIT");
    const body = await res.text();
    expect(body).toBe(SEEDED_HTML);
    // Python was never called — the whole point of the layer.
    expect(pythonHits).toBe(0);
  });

  it("KV MISS runs the pipeline and writes the rendered HTML to KV", async () => {
    const id = uniqueGameId();
    let pythonHits = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("cdn.espn.com/core/college-football/playbyplay")) {
        return jsonResponse(completedEspnEnvelope());
      }
      if (url.includes("/cfb/process")) {
        pythonHits += 1;
        return jsonResponse(completedPythonResponse());
      }
      return jsonResponse({ results: [] });
    });

    const res = await SELF.fetch(`https://example.com/cfb/game/${id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-html-cache")).toBe("MISS");
    expect(pythonHits).toBe(1);

    // Drain the response body so the executionCtx.waitUntil callbacks
    // — including the KV.put — get a chance to settle.
    const body = await res.text();
    expect(body).toContain("Carson Beck");

    // Give the waitUntil-scheduled KV write a tick to complete. In
    // production this runs on the Worker's exec context; the vitest
    // pool resolves these synchronously enough that one await is
    // sufficient.
    await new Promise((r) => setTimeout(r, 50));
    const stored = await env.LEAGUE_DATA.get(`game-html:v2:${id}`);
    expect(stored).not.toBeNull();
    expect(stored).toContain("Carson Beck");
  });

  it("in-progress game does NOT read or write KV (volatile data)", async () => {
    const id = uniqueGameId();
    const inProgressEnvelope = {
      gamepackageJSON: {
        header: {
          season: { year: 2024 },
          week: 1,
          competitions: [
            {
              status: { type: { name: "STATUS_IN_PROGRESS", completed: false, detail: "Q3 5:21" } },
              competitors: [
                { team: { id: "61", abbreviation: "UGA", nickname: "Bulldogs", color: "BA0C2F" } },
                { team: { id: "333", abbreviation: "ALA", nickname: "Crimson Tide", color: "9E1B32" } },
              ],
            },
          ],
        },
      },
    };
    const inProgressPython = (() => {
      const r = completedPythonResponse();
      const comp = r.header.competitions[0];
      comp.status = { type: { name: "STATUS_IN_PROGRESS", completed: false, detail: "Q3 5:21" } };
      return r;
    })();

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("cdn.espn.com/core/college-football/playbyplay")) {
        return jsonResponse(inProgressEnvelope);
      }
      if (url.includes("/cfb/process")) {
        return jsonResponse(inProgressPython);
      }
      return jsonResponse({ results: [] });
    });

    const res = await SELF.fetch(`https://example.com/cfb/game/${id}`);
    expect(res.status).toBe(200);
    // No x-html-cache header at all — eligibility short-circuits on
    // STATUS_IN_PROGRESS, so neither HIT nor MISS gets stamped.
    expect(res.headers.get("x-html-cache")).toBeNull();
    // KV was never written.
    await new Promise((r) => setTimeout(r, 50));
    const stored = await env.LEAGUE_DATA.get(`game-html:v2:${id}`);
    expect(stored).toBeNull();
  });
});
