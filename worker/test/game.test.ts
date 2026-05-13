import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  QUARANTINE_LIST,
  calculateGEI,
  cleanName,
  fetchAndShapePBP,
} from "../src/lib/games";
import { dropletFetch } from "../src/lib/backends";

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

// Each test that exercises the route uses a unique gameId so its
// cache key (the full request URL) doesn't collide with another
// test's cached entry. caches.default is workers-runtime-mocked and
// shared across the test file otherwise.
let nextGameId = 401900000;
const uniqueGameId = (): string => String(nextGameId++);

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

  describe("fetchAndShapePBP", () => {
    it("calls Python and reshapes the response (advBoxScore, scoringPlays, gameInfo from header)", async () => {
      const pythonResponse = {
        plays: [],
        boxScore: { players: [] },
        box_score: { team: [] },
        header: {
          season: { year: 2024 },
          competitions: [{ status: { type: { completed: false } } }],
        },
        homeTeamId: "61",
        awayTeamId: "333",
      };
      vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse(pythonResponse));
      const data = await fetchAndShapePBP(dropletFetch("http://python:7000"), "401002");
      expect(data.gameInfo?.status?.type?.completed).toBe(false);
      expect(Array.isArray(data.scoringPlays)).toBe(true);
      // box_score (snake) gets renamed to advBoxScore and removed from
      // the top-level shape — templates read advBoxScore exclusively.
      expect((data as { box_score?: unknown }).box_score).toBeUndefined();
      expect(data.advBoxScore).toEqual({ team: [] });
    });

    it("throws when Python returns non-2xx (caller renders game_error)", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(
        async () => new Response("nope", { status: 503 }),
      );
      await expect(
        fetchAndShapePBP(dropletFetch("http://python:7000"), "401003"),
      ).rejects.toThrow(/returned 503/);
    });

    it("sends the X-Worker-Secret header when a secret is provided", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
        jsonResponse({
          plays: [],
          boxScore: {},
          box_score: {},
          header: { competitions: [{ status: { type: { completed: false } } }] },
          homeTeamId: "61",
          awayTeamId: "333",
        }),
      );
      await fetchAndShapePBP(
        dropletFetch("https://python.example.com", "shhhh-its-a-secret"),
        "401005",
      );
      expect(fetchSpy).toHaveBeenCalledOnce();
      const init = fetchSpy.mock.calls[0]![1] as RequestInit;
      const headers = new Headers(init.headers as HeadersInit);
      expect(headers.get("X-Worker-Secret")).toBe("shhhh-its-a-secret");
      expect(headers.get("Content-Type")).toBe("application/json");
    });

    it("omits X-Worker-Secret when no secret is provided (back-compat with Docker-internal path)", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
        jsonResponse({
          plays: [],
          boxScore: {},
          box_score: {},
          header: { competitions: [{ status: { type: { completed: false } } }] },
          homeTeamId: "61",
          awayTeamId: "333",
        }),
      );
      await fetchAndShapePBP(dropletFetch("http://python:7000"), "401006");
      const init = fetchSpy.mock.calls[0]![1] as RequestInit;
      const headers = new Headers(init.headers as HeadersInit);
      expect(headers.get("X-Worker-Secret")).toBeNull();
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
      const data = await fetchAndShapePBP(dropletFetch("http://python:7000"), "401004");
      expect(data.plays![0].winProbability!.after).toBe(1.0);
    });
  });
});

describe("/cfb/game/:gameId route (Cache API era)", () => {
  beforeEach(async () => {
    await clearKv();
  });

  // Helper: bare-minimum Python response shape with one realistic
  // play so the full Game template can render without throwing.
  const pythonPbpResponse = (overrides: Record<string, unknown> = {}) => ({
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
      competitions: [sampleGameInfo()],
    },
    homeTeamId: "61",
    awayTeamId: "333",
    ...overrides,
  });

  // Two-call mock: ESPN probe first, Python second. Returns a spy
  // so callers can assert call count / argument shapes.
  function mockEspnThenPython(
    gameInfo: ReturnType<typeof sampleGameInfo> | undefined,
    pythonBody: ReturnType<typeof pythonPbpResponse>,
  ) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("cdn.espn.com/core/college-football/playbyplay")) {
        const competition = gameInfo ?? sampleGameInfo();
        return jsonResponse(espnEnvelope({ competitions: [competition] }));
      }
      if (url.includes("/cfb/process")) {
        return jsonResponse(pythonBody);
      }
      return new Response("unexpected", { status: 500 });
    });
  }

  it("renders the full Game page on a successful Python fetch", async () => {
    const id = uniqueGameId();
    mockEspnThenPython(undefined, pythonPbpResponse());
    const res = await SELF.fetch(`https://example.com/cfb/game/${id}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Scoring Plays");
    expect(body).toContain("Carson Beck");
    expect(body).toContain("Win Probability");
    expect(body).toContain("var gameData =");
  });

  it("back-arrow button does history.back() if there's a referrer, else / fallback", async () => {
    // Inline progressive-enhancement on the bi-arrow-left button:
    // keep `href="/"` for no-JS / direct hits, but onclick falls
    // back to history.back() when a referrer exists so the user
    // returns to whatever scoreboard they came from (year/week
    // selection preserved) instead of being snapped to the current
    // week. Same markup on Game / Pregame / GameError templates.
    const id = uniqueGameId();
    mockEspnThenPython(undefined, pythonPbpResponse());
    const res = await SELF.fetch(`https://example.com/cfb/game/${id}`);
    const body = await res.text();
    expect(body).toMatch(/bi-arrow-left/);
    expect(body).toContain('onclick="if (document.referrer) { event.preventDefault(); history.back(); }"');
  });

  it("completed games set long s-maxage Cache-Control with SWR + stale-if-error (3B Layer E + 2026-05-09 cold-start mask)", async () => {
    const id = uniqueGameId();
    mockEspnThenPython(undefined, pythonPbpResponse());
    const res = await SELF.fetch(`https://example.com/cfb/game/${id}`);
    // Sub-phase 3B Layer E: `stale-if-error=86400` lets caches
    // serve the last cached body for up to 24 h if the origin
    // 5xxs. Closes the gap when a cache miss lands on a Cloudflare
    // Container in image-pull cold start.
    //
    // 2026-05-09 cold-start mask: `stale-while-revalidate=86400`
    // hides the LRU-eviction-then-cold-container case. Completed-
    // game bytes are static so SWR is a semantic no-op.
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=86400, s-maxage=31536000, stale-while-revalidate=86400, stale-if-error=86400",
    );
  });

  it("in-progress games set 30s Cache-Control with SWR=60 and stale-if-error=86400 (2J + 3B Layer E)", async () => {
    const id = uniqueGameId();
    const inProgressGameInfo = sampleGameInfo({
      status: { type: { name: "STATUS_IN_PROGRESS", completed: false, detail: "Q3 5:21" } },
    });
    const inProgressPython = pythonPbpResponse({
      header: {
        season: { year: 2024 },
        competitions: [inProgressGameInfo],
      },
    });
    mockEspnThenPython(inProgressGameInfo, inProgressPython);
    const res = await SELF.fetch(`https://example.com/cfb/game/${id}`);
    // 2J: SWR=60 lets the cache serve stale up to 60 s past expiry
    // while triggering a background refresh. The unlucky user
    // whose request lands at TTL expiry no longer waits 4 s for
    // the Python pipeline.
    // 3B Layer E: stale-if-error=86400 absorbs container 5xxs
    // (e.g., cold-start timeout) by serving last cached for 24 h.
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=30, s-maxage=30, stale-while-revalidate=60, stale-if-error=86400",
    );
  });

  it("?json=1 returns JSON with the same Cache-Control as the HTML variant", async () => {
    const id = uniqueGameId();
    mockEspnThenPython(undefined, pythonPbpResponse());
    const res = await SELF.fetch(`https://example.com/cfb/game/${id}?json=1`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=86400, s-maxage=31536000, stale-while-revalidate=86400, stale-if-error=86400",
    );
    const body = (await res.json()) as { gameInfo: { id: string } };
    expect(body.gameInfo.id).toBe("401628412");
  });

  it("scheduled game routes to pregame template (cached 5 min)", async () => {
    const id = uniqueGameId();
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
    const res = await SELF.fetch(`https://example.com/cfb/game/${id}`);
    expect(res.status).toBe(200);
    // 2026-05-09 cold-start mask: pregame hits the summary container
    // for matchup percentiles. SWR + stale-if-error capped at 300 s
    // so the stale window can't outlive an actual kickoff transition.
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=300, s-maxage=300, stale-while-revalidate=300, stale-if-error=300",
    );
    const body = await res.text();
    expect(body).toMatch(/view the full preview page/);
  });

  it("quarantined gameId returns the quarantine error template (cached 1 day)", async () => {
    // 401411157 is in QUARANTINE_LIST. Quarantine branch runs first
    // now (post-2D), so ESPN is hit only to get gameInfo for the
    // error header.
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      jsonResponse(espnEnvelope()),
    );
    const res = await SELF.fetch("https://example.com/cfb/game/401411157");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=86400, s-maxage=86400",
    );
    const body = await res.text();
    expect(body).toContain("quarantined due to issues with underlying ESPN data");
  });

  it("Python failure on a non-quarantined game routes to game_error pbp branch with no-store", async () => {
    const id = uniqueGameId();
    let firstCall = true;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (firstCall && url.includes("cdn.espn.com")) {
        firstCall = false;
        return jsonResponse(espnEnvelope());
      }
      return new Response("python down", { status: 503 });
    });
    const res = await SELF.fetch(`https://example.com/cfb/game/${id}`);
    expect(res.status).toBe(200);
    // Sub-phase 2I makes the error Cache-Control load-bearing:
    // when the standard CF cache is fronting the Worker via Cache
    // Rules + Origin Cache Control, an error response without
    // explicit Cache-Control could fall through to a default
    // cacheable behavior. `no-store` keeps the cache from holding
    // a stale error past the underlying issue resolving.
    expect(res.headers.get("cache-control")).toBe("no-store, max-age=0");
    const body = await res.text();
    expect(body).toContain("There is no play-by-play data available for this game");
  });

  it("returns 500 when ESPN itself fails (envelope-less, can't render error page)", async () => {
    const id = uniqueGameId();
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response("nope", { status: 503 }),
    );
    const res = await SELF.fetch(`https://example.com/cfb/game/${id}`);
    expect(res.status).toBe(500);
  });

  // Cross-request cache hit (worker writes via cache.put, subsequent
  // SELF.fetch should serve from cache.match) is not asserted here.
  // The vitest-pool-workers test pool runs the worker under SELF in
  // a separate isolate from the test runner; caches.default in each
  // isolate is a distinct backing store, so the worker's cache.put
  // is invisible to the test's caches.default.match. The behavior
  // is correct in production — the Cache-Control headers asserted
  // by the per-branch tests above tell the CDN how long to keep
  // each response. End-to-end cache-hit verification happens at
  // sub-phase 2H smoke time via `cf-cache-status: HIT` on a curl
  // against the deployed Worker.
});
