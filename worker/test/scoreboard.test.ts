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

// Caches.default is shared across the test file (workers-runtime
// mock). The renderScoreboard route now caches rendered HTML keyed
// by request URL, so a prior test's populated render bleeds into
// the next test's empty-state assertion unless we clear matching
// keys here.
async function clearScoreboardCache(...urls: string[]) {
  for (const url of urls) {
    await caches.default.delete(new Request(url, { method: "GET" }));
  }
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
    await clearScoreboardCache(
      "http://localhost/cfb/",
      "http://localhost/cfb/?group=8",
      "http://localhost/cfb/?group=-1",
    );
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

  it("skips luxon.min.js, bootstrap.bundle.min.js, and date-replace.js (no-deps page)", async () => {
    // Scoreboard renders no nav-header dropdowns (no Bootstrap JS
    // needed) and formats dates via an inline native
    // Intl.DateTimeFormat formatter (no Luxon needed). Guards
    // against re-introducing the ~150 kB of unused library JS.
    // Match on the actual <script src="..."> reference, not bare
    // substring — the inline formatter's comment legitimately
    // mentions the old filenames.
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      jsonResponse({ events: [sampleGame()] }),
    );
    const res = await SELF.fetch("http://localhost/cfb/");
    const body = await res.text();
    expect(body).not.toMatch(/<script[^>]+luxon\.min\.js/);
    expect(body).not.toMatch(/<script[^>]+bootstrap\.bundle\.min\.js/);
    expect(body).not.toMatch(/<script[^>]+date-replace\.js/);
  });

  it("omits the site-wide nav-header (matches upstream gameonpaper.com)", async () => {
    // The legacy `frontend/views/pages/cfb/index.ejs` deliberately did
    // not include `nav-header.ejs`; the live upstream still ships that
    // way. Without `hideHeader` the page renders two "Game on Paper"
    // branding sections AND two elements sharing `id="game-id-form"` /
    // `id="inputGameId"` (invalid HTML). Guard against re-introducing
    // either.
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      jsonResponse({ events: [sampleGame()] }),
    );
    const res = await SELF.fetch("http://localhost/cfb/");
    const body = await res.text();
    expect(body).not.toContain("blog-header-logo");
    expect(body.match(/id="game-id-form"/g)?.length ?? 0).toBe(1);
    expect(body.match(/id="inputGameId"/g)?.length ?? 0).toBe(1);
  });

  it("caches rendered HTML in caches.default and serves repeats with x-worker-cache=HIT", async () => {
    // The bare /cfb/ route is the main landing page; before this
    // wrap it re-rendered JSX on every request. Confirms (1) the
    // first hit produces a Cache-Control header consistent with
    // the data shape (no active games → pregame TTL), (2) the
    // second hit serves from caches.default with the HIT signal,
    // (3) only one upstream KV/ESPN call happens across both hits.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => jsonResponse({ events: [sampleGame()] }));
    const url = "http://localhost/cfb/";
    const r1 = await SELF.fetch(url);
    expect(r1.status).toBe(200);
    expect(r1.headers.get("x-worker-cache")).toBe(null);
    expect(r1.headers.get("cache-control")).toContain("max-age=300");
    // Drain so cache.put resolves before the second fetch
    // (see loadtest-branch.test.ts:200 for the same pattern).
    await r1.text();
    const r2 = await SELF.fetch(url);
    expect(r2.status).toBe(200);
    expect(r2.headers.get("x-worker-cache")).toBe("HIT");
    // ESPN was only consulted once across both hits.
    const espnCalls = fetchSpy.mock.calls.filter(([input]) => {
      const u = typeof input === "string" ? input : (input as Request).url;
      return u.includes("scoreboard") || u.includes("schedule");
    });
    expect(espnCalls.length).toBe(1);
  });

  it("uses the in-progress (30s + SWR 60) TTL when the scoreboard has active games", async () => {
    // The page reloads itself every 60 s during active games; a
    // 30 s TTL + 60 s SWR keeps most repeats in the instant-serve
    // SWR window without ever serving wildly-stale lines.
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      jsonResponse({
        events: [
          sampleGame({
            status: { type: { name: "STATUS_IN_PROGRESS", completed: false, detail: "Q2" }, period: 2 },
          }),
        ],
      }),
    );
    const res = await SELF.fetch("http://localhost/cfb/");
    expect(res.headers.get("cache-control")).toContain("max-age=30");
    expect(res.headers.get("cache-control")).toContain("stale-while-revalidate=60");
  });

  it("does NOT cache the empty 'No games scheduled.' render", async () => {
    // A transient ESPN/KV hiccup that renders empty must not lock
    // the user into that state for the TTL. errorNoStore on the
    // header + skip cache.put — confirmed by issuing a second
    // request with a populated mock and seeing real games render.
    //
    // Use ?group=8 to bypass `getCachedCurrentScoreboard`'s KV
    // write-through (which would persist the empty result across
    // both fetches via KV, not the HTML cache we're testing).
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockImplementationOnce(async () => jsonResponse({ events: [] }));
    fetchSpy.mockImplementation(async () => jsonResponse({ events: [sampleGame()] }));
    const url = "http://localhost/cfb/?group=8";
    const r1 = await SELF.fetch(url);
    expect(r1.headers.get("cache-control")).toContain("no-store");
    expect(await r1.text()).toContain("No games scheduled.");
    const r2 = await SELF.fetch(url);
    // Second request hits the populated mock — proves the empty
    // render was NOT written to caches.default.
    expect(r2.headers.get("x-worker-cache")).toBe(null);
    expect(await r2.text()).toContain(">uga</strong>");
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
  beforeEach(async () => {
    await clearScoreboardCache(
      "http://localhost/cfb/year/2024/type/2/week/2",
      "http://localhost/cfb/year/2016/type/2/week/6",
    );
  });

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
  beforeEach(async () => {
    await clearScoreboardCache("http://localhost/cfb/year/2024");
  });

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
