import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getGroups,
  getWeeksMap,
  hasActiveGames,
  prepareGameList,
} from "../src/lib/schedule";
import type { ScheduleEvent } from "../src/lib/team_helpers";

afterEach(() => {
  vi.restoreAllMocks();
});

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

  it("rejects HTML responses from ESPN as malformed", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response("<html><body>error</body></html>", {
          headers: { "content-type": "text/html" },
        }),
    );
    const res = await SELF.fetch("http://localhost/cfb/year/2024/type/2/week/2");
    expect(res.status).toBe(500);
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
