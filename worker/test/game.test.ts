import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  QUARANTINE_LIST,
  calculateGEI,
  cleanName,
  getPBP,
  peekCachedPBP,
} from "../src/lib/games";

afterEach(() => {
  vi.restoreAllMocks();
});

const jsonResponse = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  });

async function clearKv() {
  const k1 = await env.LEAGUE_DATA.list();
  for (const k of k1.keys) await env.LEAGUE_DATA.delete(k.name);
  const k2 = await env.SUMMARY_LAST_UPDATED.list();
  for (const k of k2.keys) await env.SUMMARY_LAST_UPDATED.delete(k.name);
}

const sampleGameInfo = (overrides: Record<string, unknown> = {}) => ({
  id: "401628412",
  date: "2024-09-07T00:00Z",
  status: { type: { name: "STATUS_FINAL", completed: true, detail: "Final" } },
  competitors: [
    {
      team: { id: "61", abbreviation: "UGA", nickname: "Bulldogs", color: "BA0C2F" },
      score: 28,
    },
    {
      team: { id: "333", abbreviation: "ALA", nickname: "Crimson Tide", color: "9E1B32" },
      score: 21,
    },
  ],
  broadcasts: [{ media: { shortName: "ESPN" } }],
  ...overrides,
});

const espnEnvelope = (overrides: Record<string, unknown> = {}) => ({
  gamepackageJSON: {
    header: {
      season: { year: 2024 },
      week: 2,
      competitions: [sampleGameInfo()],
      ...overrides,
    },
  },
});

describe("games lib", () => {
  it("cleanName lowercases nicknames for Georgia (id 61) only", () => {
    expect(cleanName({ id: 61, nickname: "Bulldogs" })).toBe("bulldogs");
    expect(cleanName({ id: "61", nickname: "Bulldogs" })).toBe("bulldogs");
    expect(cleanName({ id: 333, nickname: "Crimson Tide" })).toBe("Crimson Tide");
    expect(cleanName({ id: 61 })).toBe("");
  });

  it("QUARANTINE_LIST contains the well-known IDs", () => {
    expect(QUARANTINE_LIST.has("401411157")).toBe(true);
    expect(QUARANTINE_LIST.has("401628398")).toBe(true);
    expect(QUARANTINE_LIST.has("000000")).toBe(false);
  });

  describe("calculateGEI", () => {
    it("returns 0 for an empty plays array", () => {
      expect(calculateGEI([], "61")).toBe(0);
    });

    it("normalizes by 179.0177/plays and sums absolute home-WP swings", () => {
      const plays = [
        { pos_team: "61", homeScore: 0, awayScore: 0, winProbability: { before: 0.5 } },
        { pos_team: "61", homeScore: 7, awayScore: 0, winProbability: { before: 0.6 } },
        { pos_team: "333", homeScore: 7, awayScore: 0, winProbability: { before: 0.4 } },
      ];
      // Expected mechanics (matches games.js:199-241):
      //   homeWP per play (Georgia=home=61):
      //     play0: pos=home, off=0.5 → home=0.5
      //     play1: pos=home, off=0.6 → home=0.6
      //     play2: pos=away, off=0.4 → home=1-0.4=0.6
      //   For the LAST play, finalWP is computed from the box-of-the-
      //   moment, not from "who actually wins the game". On a play
      //   where home leads but pos=away, finalWP=0.0 (offense's WP).
      //   diffs:
      //     i=0: nextPlayHomeWP=0.6, this=0.5 → +0.1
      //     i=1: nextPlayHomeWP=0.6, this=0.6 →  0.0
      //     i=2: finalWP=0.0,        this=0.6 → -0.6
      //   sum-abs = 0.7; normalize = 179.0177/3 ≈ 59.673.
      //   GEI ≈ 41.77.
      const gei = calculateGEI(plays, "61");
      expect(gei).toBeGreaterThan(41.5);
      expect(gei).toBeLessThan(42.0);
    });
  });

  describe("getPBP / peekCachedPBP", () => {
    beforeEach(async () => {
      await clearKv();
    });

    it("returns the KV-cached payload without hitting Python", async () => {
      const sample = { gameInfo: { status: { type: { completed: true } } }, plays: [] };
      await env.LEAGUE_DATA.put("cfb-game-401001", JSON.stringify(sample));
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const data = await getPBP(env.LEAGUE_DATA, "http://python:7000", "401001");
      expect(data).toEqual(sample);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("calls Python on cache miss and writes through to KV", async () => {
      const pythonResponse = {
        plays: [],
        boxScore: {},
        box_score: {},
        header: { season: { year: 2024 }, competitions: [{ status: { type: { completed: false } } }] },
        homeTeamId: "61",
        awayTeamId: "333",
      };
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async () => jsonResponse(pythonResponse));
      const data = await getPBP(env.LEAGUE_DATA, "http://python:7000", "401002");
      expect(data).not.toBeNull();
      expect(data!.gameInfo?.status?.type?.completed).toBe(false);
      expect(fetchSpy).toHaveBeenCalledOnce();
      const cached = await env.LEAGUE_DATA.get("cfb-game-401002");
      expect(cached).not.toBeNull();
      // The reshape should have stripped box_score and added scoringPlays.
      const parsed = JSON.parse(cached!) as { box_score?: unknown; scoringPlays?: unknown };
      expect(parsed.box_score).toBeUndefined();
      expect(Array.isArray(parsed.scoringPlays)).toBe(true);
    });

    it("returns null when Python fails", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(
        async () => new Response("nope", { status: 503 }),
      );
      const data = await getPBP(env.LEAGUE_DATA, "http://python:7000", "401003");
      expect(data).toBeNull();
    });

    it("peekCachedPBP returns null on cache miss and the parsed payload on hit", async () => {
      expect(await peekCachedPBP(env.LEAGUE_DATA, "missing")).toBeNull();
      await env.LEAGUE_DATA.put("cfb-game-hit", JSON.stringify({ gameInfo: {} }));
      expect(await peekCachedPBP(env.LEAGUE_DATA, "hit")).toEqual({ gameInfo: {} });
    });

    it("pins the last play's WP after to 1.0 on a completed game where home wins", async () => {
      const pythonResponse = {
        plays: [
          {
            pos_team: "61",
            homeScore: 28,
            awayScore: 21,
            winProbability: { before: 0.95 },
          },
        ],
        boxScore: {},
        header: { competitions: [{ status: { type: { completed: true } } }] },
        homeTeamId: "61",
        awayTeamId: "333",
      };
      vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse(pythonResponse));
      const data = await getPBP(env.LEAGUE_DATA, "http://python:7000", "401004");
      expect(data!.plays![0].winProbability!.after).toBe(1.0);
    });
  });
});

describe("/cfb/game/:gameId route", () => {
  beforeEach(async () => {
    await clearKv();
  });

  it("returns cached completed payload as JSON when ?json=1 (no Python or ESPN call)", async () => {
    const sample = {
      gameInfo: sampleGameInfo(),
      header: { season: { year: 2024 } },
      plays: [],
      scoringPlays: [],
    };
    await env.LEAGUE_DATA.put("cfb-game-401628412", JSON.stringify(sample));
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await SELF.fetch("http://localhost/cfb/game/401628412?json=1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { gameInfo: { id: string } };
    expect(body.gameInfo.id).toBe("401628412");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("renders the stub Game page on a cached completed payload", async () => {
    const sample = {
      gameInfo: sampleGameInfo(),
      header: { season: { year: 2024 } },
      plays: [],
      scoringPlays: [
        {
          period: { number: 1 },
          clock: { displayValue: "12:34" },
          text: "Carson Beck 22 yard pass to Arian Smith for a TD",
          homeScore: 7,
          awayScore: 0,
          pos_team: "61",
        },
      ],
    };
    await env.LEAGUE_DATA.put("cfb-game-401628412", JSON.stringify(sample));
    const res = await SELF.fetch("http://localhost/cfb/game/401628412");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Scoring Summary");
    expect(body).toContain("Carson Beck");
    // Stub notice tells the user the full template is mid-port.
    expect(body).toContain("mid-port");
  });

  it("scheduled game routes to pregame template", async () => {
    const scheduled = sampleGameInfo({
      status: { type: { name: "STATUS_SCHEDULED", completed: false, detail: "Sat 7:30 PM" } },
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("cdn.espn.com/core/college-football/playbyplay")) {
        return jsonResponse(espnEnvelope({ competitions: [scheduled] }));
      }
      // summary POSTs for the two breakdowns.
      return jsonResponse({ results: [] });
    });
    const res = await SELF.fetch("http://localhost/cfb/game/401628412");
    expect(res.status).toBe(200);
    const body = await res.text();
    // Pregame template renders the matchup section and "view the
    // full preview page" link.
    expect(body).toMatch(/view the full preview page/);
  });

  it("quarantined gameId returns the quarantine error template", async () => {
    // 401411157 is in QUARANTINE_LIST. Cache miss → ESPN probe →
    // quarantine branch.
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      jsonResponse(espnEnvelope()),
    );
    const res = await SELF.fetch("http://localhost/cfb/game/401411157");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("quarantined due to issues with underlying ESPN data");
  });

  it("Python failure on a non-quarantined game routes to game_error pbp branch", async () => {
    let firstCall = true;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (firstCall && url.includes("cdn.espn.com")) {
        firstCall = false;
        return jsonResponse(espnEnvelope());
      }
      // Subsequent fetch is the Python /cfb/process call → 503.
      return new Response("python down", { status: 503 });
    });
    const res = await SELF.fetch("http://localhost/cfb/game/401628412");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("There is no play-by-play data available for this game");
  });

  it("returns 500 when ESPN itself fails (envelope-less, can't render error page)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response("nope", { status: 503 }),
    );
    const res = await SELF.fetch("http://localhost/cfb/game/9999999");
    expect(res.status).toBe(500);
  });
});
