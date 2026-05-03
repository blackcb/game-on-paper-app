import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getCachedCurrentScoreboard,
  getGroups,
  getWeeksMap,
  hasActiveGames,
  isFootballSeason,
  prepareGameList,
  writeCurrentScoreboard,
} from "../src/lib/schedule";
import type { ScheduleEvent } from "../src/lib/team_helpers";

afterEach(() => {
  vi.restoreAllMocks();
});

// Sub-phase 2F: the / route now reads from KV first. Clear that
// key between tests so a prior test's write doesn't bleed into
// the next test's "No games scheduled" / spy assertions.
async function clearScoreboardKv() {
  await env.LEAGUE_DATA.delete("cfb-scoreboard-80");
}

const jsonResponse = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  });

const sampleGame = (overrides: Record<string, unknown> = {}): ScheduleEvent => ({
  id: "401628412",
  date: "2024-09-07T00:00Z",
  status: { type: { name: "STATUS_FINAL", completed: true, detail: "Final" }, period: 4 },
  competitions: [
    {
      id: "401628412",
      competitors: [
        {
          id: "61",
          score: 28,
          team: { id: "61", abbreviation: "UGA", conferenceId: "8" },
          curatedRank: { current: 5 },
          records: [{ type: "total", summary: "11-2" }],
        },
        {
          id: "333",
          score: 21,
          team: { id: "333", abbreviation: "ALA", conferenceId: "8" },
          curatedRank: { current: 7 },
          records: [{ type: "total", summary: "10-3" }],
        },
      ],
      situation: undefined,
      notes: [],
      broadcasts: [],
    },
  ],
  ...overrides,
});

describe("schedule lib", () => {
  it("getWeeksMap: each season has at least one week with title/label/value/type", () => {
    const map = getWeeksMap();
    expect(Object.keys(map).length).toBeGreaterThan(20); // 2002–2025+
    const week2024 = map["2024"];
    expect(Array.isArray(week2024)).toBe(true);
    expect(week2024.length).toBeGreaterThan(0);
    expect(week2024[0]).toHaveProperty("title");
    expect(week2024[0]).toHaveProperty("label");
    expect(week2024[0]).toHaveProperty("value");
    expect(week2024[0]).toHaveProperty("type");
  });

  it("getGroups returns the static group list with FBS at id=80 and Top-25 at id=-1", () => {
    const groups = getGroups();
    expect(groups.find((g) => g.id === 80)?.name).toBe("FBS (I-A)");
    expect(groups.find((g) => g.id === -1)?.name).toBe("Top 25");
  });

  describe("prepareGameList", () => {
    it("filters out games with negative competitor IDs (TBD opponents)", () => {
      const valid = sampleGame({ id: "v" });
      const invalid: ScheduleEvent = {
        id: "tbd",
        date: "2024-09-08",
        status: { type: { name: "STATUS_SCHEDULED" }, period: 0 },
        competitions: [
          {
            competitors: [
              { id: "-1", team: { id: "-1" } },
              { id: "300", team: { id: "300" } },
            ],
          },
        ],
      };
      const sorted = prepareGameList([invalid, valid]);
      expect(sorted).toHaveLength(1);
      expect(sorted[0].id).toBe("v");
    });

    it("orders IN_PROGRESS before END_PERIOD before HALFTIME before everything else", () => {
      const inProgress = sampleGame({
        id: "in-progress",
        status: { type: { name: "STATUS_IN_PROGRESS" }, period: 3 },
      });
      const endPeriod = sampleGame({
        id: "end-period",
        status: { type: { name: "STATUS_END_PERIOD" }, period: 2 },
      });
      const halftime = sampleGame({
        id: "halftime",
        status: { type: { name: "STATUS_HALFTIME" }, period: 2 },
      });
      const final = sampleGame({ id: "final" });
      const out = prepareGameList([final, halftime, endPeriod, inProgress]);
      expect(out.map((g) => g.id)).toEqual(["in-progress", "end-period", "halftime", "final"]);
    });

    it("breaks status ties by date ascending then status.type.id ascending", () => {
      const earlier = sampleGame({
        id: "earlier",
        date: "2024-09-01T00:00Z",
        status: { type: { name: "STATUS_FINAL", id: "3", completed: true }, period: 4 },
      });
      const later = sampleGame({
        id: "later",
        date: "2024-09-08T00:00Z",
        status: { type: { name: "STATUS_FINAL", id: "3", completed: true }, period: 4 },
      });
      const sameDateLowerId = sampleGame({
        id: "lower-id",
        date: "2024-09-01T00:00Z",
        status: { type: { name: "STATUS_FINAL", id: "1", completed: true }, period: 4 },
      });
      const out = prepareGameList([later, earlier, sameDateLowerId]);
      expect(out.map((g) => g.id)).toEqual(["lower-id", "earlier", "later"]);
    });
  });

  describe("hasActiveGames", () => {
    it("returns false for an empty list", () => {
      expect(hasActiveGames([])).toBe(false);
    });
    it("returns false when all games are scheduled, completed, cancelled, or postponed", () => {
      const games: ScheduleEvent[] = [
        sampleGame({ status: { type: { name: "STATUS_SCHEDULED" } } }),
        sampleGame({ status: { type: { name: "STATUS_FINAL", completed: true } } }),
        sampleGame({ status: { type: { name: "STATUS_CANCELED" } } }),
        sampleGame({ status: { type: { name: "STATUS_POSTPONED" } } }),
      ];
      expect(hasActiveGames(games)).toBe(false);
    });
    it("returns true when any game is in progress", () => {
      const games: ScheduleEvent[] = [
        sampleGame({ status: { type: { name: "STATUS_FINAL", completed: true } } }),
        sampleGame({ status: { type: { name: "STATUS_IN_PROGRESS" }, period: 3 } }),
      ];
      expect(hasActiveGames(games)).toBe(true);
    });
  });
});

describe("/cfb/ scoreboard route", () => {
  beforeEach(async () => {
    await clearScoreboardKv();
  });

  it("renders the scoreboard with chrome, dropdowns, and game cards", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      jsonResponse({ events: [sampleGame()] }),
    );
    const res = await SELF.fetch("http://localhost/cfb/");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Game on Paper");
    expect(body).toContain('id="yearSelect"');
    expect(body).toContain('id="weekSelect"');
    expect(body).toContain('id="groupSelect"');
    // Border guide caption renders.
    expect(body).toContain("Game border color guide");
    // Game thumb cell rendering for the sample game.
    // Georgia (id 61) is lowercased by cleanAbbreviation; Alabama isn't.
    expect(body).toContain(">uga</strong>");
    expect(body).toContain(">ALA<");
  });

  it("shows 'No games scheduled' when ESPN returns an empty event list", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse({ events: [] }));
    const res = await SELF.fetch("http://localhost/cfb/");
    const body = await res.text();
    expect(body).toContain("No games scheduled.");
  });

  it("hits the site.api scoreboard endpoint with the requested group", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => jsonResponse({ events: [] }));
    await SELF.fetch("http://localhost/cfb/?group=8");
    const url = String(fetchSpy.mock.calls[0]![0]);
    expect(url).toContain("site.api.espn.com");
    expect(url).toContain("scoreboard");
    expect(url).toContain("groups=8");
  });

  it("Top-25 (group=-1) coerces to FBS=80 at the edge but filters down post-fetch", async () => {
    // Two games: one with a top-25 team, one without.
    const ranked = sampleGame({ id: "ranked" });
    const unranked = sampleGame({
      id: "unranked",
      competitions: [
        {
          id: "c-2",
          competitors: [
            {
              id: "100",
              team: { id: "100", abbreviation: "AAA", conferenceId: "8" },
              curatedRank: { current: 99 },
              records: [],
            },
            {
              id: "200",
              team: { id: "200", abbreviation: "BBB", conferenceId: "8" },
              curatedRank: { current: 99 },
              records: [],
            },
          ],
          situation: undefined,
          notes: [],
          broadcasts: [],
        },
      ],
    });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => jsonResponse({ events: [ranked, unranked] }));
    const res = await SELF.fetch("http://localhost/cfb/?group=-1");
    expect(res.status).toBe(200);
    // Coerces -1 → 80 at the URL.
    const url = String(fetchSpy.mock.calls[0]![0]);
    expect(url).toContain("groups=80");
    // Body only includes the ranked game — UGA→uga from the ranked
    // sample and not AAA from the unranked one.
    const body = await res.text();
    expect(body).toContain(">uga</strong>");
    expect(body).not.toContain(">AAA<");
  });
});

describe("sub-phase 2F: cron-warmed scoreboard helpers", () => {
  beforeEach(async () => {
    await clearScoreboardKv();
  });

  describe("isFootballSeason", () => {
    it("returns true Aug 20 onward", () => {
      expect(isFootballSeason(new Date("2024-08-20T00:00Z"))).toBe(true);
      expect(isFootballSeason(new Date("2024-08-25T00:00Z"))).toBe(true);
      expect(isFootballSeason(new Date("2024-12-31T23:59Z"))).toBe(true);
    });
    it("returns true through Jan 20", () => {
      expect(isFootballSeason(new Date("2025-01-01T00:00Z"))).toBe(true);
      expect(isFootballSeason(new Date("2025-01-20T23:59Z"))).toBe(true);
    });
    it("returns false in the off-season window", () => {
      expect(isFootballSeason(new Date("2024-01-21T00:00Z"))).toBe(false);
      expect(isFootballSeason(new Date("2024-04-15T00:00Z"))).toBe(false);
      expect(isFootballSeason(new Date("2024-07-31T23:59Z"))).toBe(false);
      expect(isFootballSeason(new Date("2024-08-19T23:59Z"))).toBe(false);
    });
  });

  describe("writeCurrentScoreboard", () => {
    it("calls the ESPN site-API scoreboard endpoint and writes the events to KV", async () => {
      const games = [sampleGame()];
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async () => jsonResponse({ events: games }));
      const count = await writeCurrentScoreboard(env.LEAGUE_DATA);
      expect(count).toBe(1);
      const url = String(fetchSpy.mock.calls[0]![0]);
      expect(url).toContain("site.api.espn.com");
      expect(url).toContain("groups=80");
      const cached = await env.LEAGUE_DATA.get("cfb-scoreboard-80");
      expect(cached).not.toBeNull();
      const parsed = JSON.parse(cached!) as ScheduleEvent[];
      expect(parsed[0].id).toBe("401628412");
    });

    it("propagates ESPN failures so the cron logs them", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(
        async () => new Response("nope", { status: 503 }),
      );
      await expect(writeCurrentScoreboard(env.LEAGUE_DATA)).rejects.toThrow(/returned 503/);
    });
  });

  describe("getCachedCurrentScoreboard", () => {
    it("returns the KV-cached payload when present (no ESPN call)", async () => {
      await env.LEAGUE_DATA.put(
        "cfb-scoreboard-80",
        JSON.stringify([sampleGame({ id: "from-kv" })]),
      );
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const games = await getCachedCurrentScoreboard(env.LEAGUE_DATA);
      expect(games).toHaveLength(1);
      expect(games[0].id).toBe("from-kv");
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("falls back to ESPN on KV miss and writes through", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
        jsonResponse({ events: [sampleGame({ id: "from-espn" })] }),
      );
      const games = await getCachedCurrentScoreboard(env.LEAGUE_DATA);
      expect(games[0].id).toBe("from-espn");
      const cached = await env.LEAGUE_DATA.get("cfb-scoreboard-80");
      expect(cached).not.toBeNull();
    });
  });
});

describe("/cfb/year/:year/type/:type/week/:week", () => {
  it("hits cdn.espn.com schedule with the year/type/week params and renders", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      // Historical ESPN payload shape: content.schedule keyed by date.
      const body = {
        content: {
          schedule: {
            "2024-09-07": { games: [sampleGame()] },
          },
        },
      };
      return new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
      });
    });
    const res = await SELF.fetch("http://localhost/cfb/year/2024/type/2/week/2");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Game on Paper");
    // Game thumb rendered (UGA → uga via cleanAbbreviation).
    expect(body).toContain(">uga</strong>");
    const url = String(fetchSpy.mock.calls[0]![0]);
    expect(url).toContain("cdn.espn.com/core/college-football/schedule");
    expect(url).toContain("year=2024");
    expect(url).toContain("week=2");
    expect(url).toContain("type=2");
  });

  it("treats HTML responses from ESPN as a soft failure (200 + empty state)", async () => {
    // ESPN sometimes serves HTML error pages instead of JSON.
    // fetchHistoricalSchedule throws; the route catches and renders
    // the "No games scheduled." state. Pre-2H.10d this returned 500.
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response("<html><body>error</body></html>", {
          headers: { "content-type": "text/html" },
        }),
    );
    const res = await SELF.fetch("http://localhost/cfb/year/2024/type/2/week/2");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("No games scheduled.");
  });

  it("treats ESPN 503 as a soft failure (200 + empty state)", async () => {
    // The actual user-reported case: cdn.espn.com returns 503 on the
    // historical schedule endpoint occasionally. Should NOT 500 the
    // user; render the empty-state instead.
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response("upstream busy", { status: 503 }),
    );
    const res = await SELF.fetch("http://localhost/cfb/year/2016/type/2/week/6");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("No games scheduled.");
    // Structured failure log emitted for forensics.
    const failureLines = logSpy.mock.calls
      .map((c) => String(c[0] ?? ""))
      .filter((line) => line.includes('"event":"espn_scoreboard_failure"'));
    expect(failureLines.length).toBeGreaterThan(0);
    const parsed = JSON.parse(failureLines[0]) as Record<string, unknown>;
    expect(parsed.year).toBe("2016");
    expect(parsed.week).toBe("6");
  });
});

describe("/cfb/year/:year", () => {
  it("renders the year scoreboard defaulting to type=2 week=1", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(
        JSON.stringify({ content: { schedule: { "2024-08-25": { games: [sampleGame()] } } } }),
        { headers: { "content-type": "application/json" } },
      );
    });
    const res = await SELF.fetch("http://localhost/cfb/year/2024");
    expect(res.status).toBe(200);
    const url = String(fetchSpy.mock.calls[0]![0]);
    expect(url).toContain("year=2024");
    expect(url).toContain("week=1");
    expect(url).toContain("type=2");
  });
});
