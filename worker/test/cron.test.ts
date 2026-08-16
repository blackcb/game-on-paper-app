import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isGameWindow, prewarmTopGames } from "../src/lib/cron";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isGameWindow", () => {
  // UTC dates so the test isn't dependent on the runner's TZ.
  // Game window is Sat 15:00 UTC → Sun 08:00 UTC.

  it("is true at Saturday 15:00 UTC (window opens)", () => {
    expect(isGameWindow(new Date("2026-09-05T15:00:00Z"))).toBe(true);
  });

  it("is true mid-Saturday afternoon", () => {
    expect(isGameWindow(new Date("2026-09-05T20:30:00Z"))).toBe(true);
  });

  it("is true at Sunday 03:00 UTC (late-night Pac-12)", () => {
    expect(isGameWindow(new Date("2026-09-06T03:00:00Z"))).toBe(true);
  });

  it("is true at Sunday 07:59 UTC (one minute before close)", () => {
    expect(isGameWindow(new Date("2026-09-06T07:59:00Z"))).toBe(true);
  });

  it("is false at Sunday 08:00 UTC (window closes)", () => {
    expect(isGameWindow(new Date("2026-09-06T08:00:00Z"))).toBe(false);
  });

  it("is false at Saturday 14:00 UTC (one hour before window)", () => {
    expect(isGameWindow(new Date("2026-09-05T14:00:00Z"))).toBe(false);
  });

  it("is false on a weekday afternoon (before evening window)", () => {
    expect(isGameWindow(new Date("2026-09-08T20:00:00Z"))).toBe(false); // Tue 20:00 UTC
    expect(isGameWindow(new Date("2026-09-10T20:00:00Z"))).toBe(false); // Thu
    expect(isGameWindow(new Date("2026-09-11T20:00:00Z"))).toBe(false); // Fri
  });

  it("is false on Sunday afternoon", () => {
    expect(isGameWindow(new Date("2026-09-06T18:00:00Z"))).toBe(false);
  });

  // Weekday-evening window (added 2026-05-09): Tue–Fri 22:00 UTC →
  // Wed–Sat 04:00 UTC, covering MAC midweeks + Thu/Fri primetime.
  it("is true at Tuesday 22:00 UTC (weekday-evening window opens)", () => {
    expect(isGameWindow(new Date("2026-09-08T22:00:00Z"))).toBe(true);
  });

  it("is true at Friday 23:30 UTC (Friday primetime)", () => {
    expect(isGameWindow(new Date("2026-09-11T23:30:00Z"))).toBe(true);
  });

  it("is true at Wednesday 03:00 UTC (Tue-night MAC bleed-over)", () => {
    expect(isGameWindow(new Date("2026-09-09T03:00:00Z"))).toBe(true);
  });

  it("is false at Wednesday 04:00 UTC (weekday-evening window closes)", () => {
    expect(isGameWindow(new Date("2026-09-09T04:00:00Z"))).toBe(false);
  });

  it("is false at Tuesday 21:59 UTC (one minute before weekday open)", () => {
    expect(isGameWindow(new Date("2026-09-08T21:59:00Z"))).toBe(false);
  });

  it("is false on Monday evening (no Monday window)", () => {
    expect(isGameWindow(new Date("2026-09-07T22:00:00Z"))).toBe(false);
    expect(isGameWindow(new Date("2026-09-07T23:30:00Z"))).toBe(false);
  });
});

describe("prewarmTopGames", () => {
  const SCOREBOARD_KV_KEY = "cfb-scoreboard-80";

  async function clearScoreboard() {
    await env.LEAGUE_DATA.delete(SCOREBOARD_KV_KEY);
  }

  it("no-ops when PREWARM_TOP_N is 0", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await prewarmTopGames({
      LEAGUE_DATA: env.LEAGUE_DATA,
      PREWARM_TOP_N: "0",
      PREWARM_BASE_URL: "https://example.test",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("no-ops when PREWARM_BASE_URL is unset", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await prewarmTopGames({
      LEAGUE_DATA: env.LEAGUE_DATA,
      PREWARM_TOP_N: "5",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("no-ops when the scoreboard returns 0 games (no candidates to warm)", async () => {
    // KV miss → getCachedCurrentScoreboard falls through to ESPN.
    // Mock that to an empty event list so prewarmTopGames sees 0
    // games and skips the self-fetch loop entirely.
    await clearScoreboard();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("cdn.espn.com/core/college-football/scoreboard")) {
        return new Response(JSON.stringify({ content: { sbData: { events: [] } } }), {
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    await prewarmTopGames({
      LEAGUE_DATA: env.LEAGUE_DATA,
      PREWARM_TOP_N: "5",
      PREWARM_BASE_URL: "https://example.test",
    });
    // ESPN scoreboard fetch happened (1 call); no prewarmOne calls.
    expect(fetchSpy.mock.calls.length).toBe(1);
    expect(String(fetchSpy.mock.calls[0]![0])).toContain("cdn.espn.com/core/college-football/scoreboard");
  });

  it("self-fetches /cfb/game/:id for the top N games", async () => {
    const games = [
      { id: "401001", status: { type: { name: "STATUS_SCHEDULED" } } },
      { id: "401002", status: { type: { name: "STATUS_IN_PROGRESS" } } },
      { id: "401003", status: { type: { name: "STATUS_FINAL", completed: true } } },
      { id: "401004", status: { type: { name: "STATUS_SCHEDULED" } } },
    ];
    await env.LEAGUE_DATA.put(SCOREBOARD_KV_KEY, JSON.stringify(games));
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok", { headers: { "content-length": "2" } }));

    await prewarmTopGames({
      LEAGUE_DATA: env.LEAGUE_DATA,
      PREWARM_TOP_N: "2",
      PREWARM_BASE_URL: "https://example.test",
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const calledUrls = fetchSpy.mock.calls.map(([u]) => String(u)).sort();
    // In-progress game (401002) ranks first; one of the SCHEDULED
    // games (401001 or 401004) takes the second slot. Both match
    // /cfb/game/:id with the example.test base.
    expect(calledUrls).toContain("https://example.test/cfb/game/401002");
    expect(calledUrls.length).toBe(2);
    for (const url of calledUrls) {
      expect(url).toMatch(/^https:\/\/example\.test\/cfb\/game\/\d+$/);
    }
  });

  it("filters out completed games before slicing top-N", async () => {
    // Completed games already have a 1y Cache-Control, so prewarming
    // them is pure waste. With PREWARM_TOP_N=3 against a scoreboard
    // of 2 completed + 1 scheduled, only the scheduled game fetches.
    const games = [
      { id: "final-1", status: { type: { name: "STATUS_FINAL", completed: true } } },
      { id: "final-2", status: { type: { name: "STATUS_FINAL", completed: true } } },
      { id: "scheduled", status: { type: { name: "STATUS_SCHEDULED" } } },
    ];
    await env.LEAGUE_DATA.put(SCOREBOARD_KV_KEY, JSON.stringify(games));
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok"));

    await prewarmTopGames({
      LEAGUE_DATA: env.LEAGUE_DATA,
      PREWARM_TOP_N: "3",
      PREWARM_BASE_URL: "https://example.test",
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]![0])).toBe(
      "https://example.test/cfb/game/scheduled",
    );
  });

  it("ranks in-progress games above scheduled when picking top-N", async () => {
    const games = [
      { id: "scheduled-A", status: { type: { name: "STATUS_SCHEDULED" } } },
      { id: "scheduled-B", status: { type: { name: "STATUS_SCHEDULED" } } },
      { id: "in-progress", status: { type: { name: "STATUS_IN_PROGRESS" } } },
    ];
    await env.LEAGUE_DATA.put(SCOREBOARD_KV_KEY, JSON.stringify(games));
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok"));

    await prewarmTopGames({
      LEAGUE_DATA: env.LEAGUE_DATA,
      PREWARM_TOP_N: "1",
      PREWARM_BASE_URL: "https://example.test",
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]![0])).toBe(
      "https://example.test/cfb/game/in-progress",
    );
  });
});
