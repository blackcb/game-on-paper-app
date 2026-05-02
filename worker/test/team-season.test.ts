import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSliceCells,
  calculateSpiceLevel,
  cleanAbbreviation,
  cleanLocation,
  getNumberWithOrdinal,
  hexToRgb,
  maxTeamsForSeason,
  SPICE,
  sliceColorRamp,
  teamCardMarginal,
} from "../src/lib/team_helpers";

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

describe("team_helpers", () => {
  it("getNumberWithOrdinal handles 1/2/3 + teens + 21/22/23", () => {
    expect(getNumberWithOrdinal(1)).toBe("1st");
    expect(getNumberWithOrdinal(2)).toBe("2nd");
    expect(getNumberWithOrdinal(3)).toBe("3rd");
    expect(getNumberWithOrdinal(11)).toBe("11th");
    expect(getNumberWithOrdinal(12)).toBe("12th");
    expect(getNumberWithOrdinal(21)).toBe("21st");
    expect(getNumberWithOrdinal(101)).toBe("101st");
  });

  it("cleanLocation lowercases Georgia (id 61) only", () => {
    expect(cleanLocation({ id: 61, location: "Georgia" })).toBe("georgia");
    expect(cleanLocation({ id: "61", location: "Georgia" })).toBe("georgia");
    expect(cleanLocation({ id: 333, location: "Alabama" })).toBe("Alabama");
  });

  it("cleanAbbreviation lowercases UGA only", () => {
    expect(cleanAbbreviation({ id: 61, abbreviation: "UGA" })).toBe("uga");
    expect(cleanAbbreviation({ id: 333, abbreviation: "ALA" })).toBe("ALA");
  });

  it("hexToRgb parses 6-char hex with/without leading hash", () => {
    expect(hexToRgb("BA0C2F")).toEqual({ r: 186, g: 12, b: 47 });
    expect(hexToRgb("#000000")).toEqual({ r: 0, g: 0, b: 0 });
    expect(hexToRgb(null)).toBeNull();
    expect(hexToRgb("FFF")).toBeNull();
  });

  it("maxTeamsForSeason follows the FBS-expansion table", () => {
    expect(maxTeamsForSeason(2021)).toBe(130);
    expect(maxTeamsForSeason(2022)).toBe(131);
    expect(maxTeamsForSeason(2023)).toBe(134);
    expect(maxTeamsForSeason(2025)).toBe(134);
    expect(maxTeamsForSeason("2022")).toBe(131);
  });

  it("teamCardMarginal prefixes + only for non-negatives", () => {
    expect(teamCardMarginal(0.45, 2, 2)).toBe("+0.45");
    expect(teamCardMarginal(0, 2, 2)).toBe("+0.00");
    expect(teamCardMarginal(-0.12, 2, 2)).toBe("-0.12");
    expect(teamCardMarginal("0.5", 2, 2)).toBe("+0.50");
  });

  it("sliceColorRamp returns null in the middle band, level-N otherwise", () => {
    expect(sliceColorRamp(null)).toBeNull();
    expect(sliceColorRamp(undefined)).toBeNull();
    expect(sliceColorRamp(1)).toBe("hulk-bg-level-9"); // best
    expect(sliceColorRamp(130)).toBe("hulk-bg-level-0"); // worst
    expect(sliceColorRamp(65)).toBeNull(); // step 4 → null
  });

  describe("buildSliceCells", () => {
    const offensive = {
      offensive: {
        overall: {
          totalPlays: 800,
          totalPlaysRank: 5,
          successRate: 0.45,
          successRateRank: 12,
          startingFP: 30,
          startingFPRank: 8,
          epaPerPlay: 0.18,
          epaPerPlayRank: 3,
        },
      },
    };

    it("formats EPA cells to 2 decimals, no margin sign", () => {
      const [cell] = buildSliceCells("epaPerPlay", [offensive], "offensive", "overall");
      expect(cell).not.toBeNull();
      expect(cell!.text).toBe("0.18");
      expect(cell!.sign).toBe("");
      expect(cell!.colorClass).toMatch(/hulk-bg-level-/);
      expect(cell!.rankString).toContain("#3");
    });

    it("formats success rate as percent with 1 decimal", () => {
      const [cell] = buildSliceCells("successRate", [offensive], "offensive", "overall");
      expect(cell!.text).toBe("45.0%");
    });

    it("formats startingFP as 'Own/Opp NN' for non-differential", () => {
      const [cell] = buildSliceCells("startingFP", [offensive], "offensive", "overall");
      // value < 50 → "Opp 30"
      expect(cell!.text).toBe("Opp 30");
    });

    it("for differential, prefixes positives with + and uses green class", () => {
      const diff = {
        differential: {
          overall: {
            epaPerPlay: 0.12,
            epaPerPlayRank: 5,
          },
        },
      };
      const [cell] = buildSliceCells("epaPerPlay", [diff], "differential", "overall");
      expect(cell!.sign).toBe("+");
      expect(cell!.colorClass).toBe("hulk-bg-green");
      expect(cell!.text).toBe("0.12");
    });

    it("emits null when the requested target is missing", () => {
      const empty = {};
      const cells = buildSliceCells("epaPerPlay", [empty], "offensive", "overall");
      expect(cells[0]).toBeNull();
    });
  });

  describe("calculateSpiceLevel", () => {
    const baseEvent = (overrides: Record<string, unknown>) => ({
      status: { type: { name: "STATUS_IN_PROGRESS", completed: false, detail: "" }, period: 4, clock: 100 },
      competitions: [
        {
          competitors: [
            { id: "1", score: 21, team: { conferenceId: "8" }, rank: 5 },
            { id: "2", score: 20, team: { conferenceId: "1" }, rank: 10 },
          ],
        },
      ],
      ...overrides,
    });

    it("returns BELL for completed games", () => {
      expect(
        calculateSpiceLevel({
          ...baseEvent({}),
          status: { type: { completed: true, name: "STATUS_FINAL", detail: "Final" }, period: 4 },
        }),
      ).toBe(SPICE.BELL);
    });

    it("returns BELL for scheduled games", () => {
      expect(
        calculateSpiceLevel({
          ...baseEvent({}),
          status: { type: { name: "STATUS_SCHEDULED", detail: "" }, period: 0 },
        }),
      ).toBe(SPICE.BELL);
    });

    it("returns SERRANO for late-half close games", () => {
      // 1-pt game, 100s left in Q4, both teams unranked.
      const result = calculateSpiceLevel({
        status: { type: { name: "STATUS_IN_PROGRESS", completed: false, detail: "" }, period: 4, clock: 100 },
        competitions: [
          {
            competitors: [
              { id: "1", score: 21, team: { conferenceId: "8" }, rank: 99 },
              { id: "2", score: 20, team: { conferenceId: "1" }, rank: 99 },
            ],
          },
        ],
      });
      expect(result).toBe(SPICE.SERRANO);
    });

    it("returns GHOST for late-half close games with both teams ranked", () => {
      const result = calculateSpiceLevel({
        status: { type: { name: "STATUS_IN_PROGRESS", completed: false, detail: "" }, period: 4, clock: 100 },
        competitions: [
          {
            competitors: [
              { id: "1", score: 21, team: { conferenceId: "8" }, rank: 5 },
              { id: "2", score: 20, team: { conferenceId: "1" }, rank: 10 },
            ],
          },
        ],
      });
      expect(result).toBe(SPICE.GHOST);
    });

    it("returns BELL for blowouts past the cliff thresholds", () => {
      const result = calculateSpiceLevel({
        status: { type: { name: "STATUS_IN_PROGRESS", completed: false, detail: "" }, period: 4, clock: 100 },
        competitions: [
          {
            competitors: [
              { id: "1", score: 60, team: { conferenceId: "8" }, rank: 5 },
              { id: "2", score: 30, team: { conferenceId: "1" }, rank: 10 },
            ],
          },
        ],
      });
      expect(result).toBe(SPICE.BELL);
    });
  });
});

describe("/cfb/year/:year/team/:teamId", () => {
  beforeEach(async () => {
    await clearKv();
  });

  const stubEspnSeasonFetches = (overrides?: Record<string, (url: string) => Response>) => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      // Custom override matchers go first so tests can short-circuit.
      if (overrides) {
        for (const [match, fn] of Object.entries(overrides)) {
          if (url.includes(match)) return fn(url);
        }
      }
      if (url.includes("/record")) return jsonResponse({ items: [{ type: "total", displayValue: "11-2" }] });
      if (url.includes("/athletes")) return jsonResponse({ items: [] });
      if (url.includes("/ranks")) return jsonResponse({ items: [] });
      if (url.includes("/leaders")) return jsonResponse({ items: [] });
      if (url.includes("/schedule")) return jsonResponse({ events: {} });
      // Base team payload (no /<endpoint> on the URL).
      return jsonResponse({
        id: "61",
        location: "Georgia",
        abbreviation: "UGA",
        color: "BA0C2F",
        alternateColor: "000000",
      });
    });
  };

  it("returns the ESPN team payload as JSON when ?json=1", async () => {
    stubEspnSeasonFetches();
    const res = await SELF.fetch("http://localhost/cfb/year/2024/team/61?json=1");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("application/json");
    const data = (await res.json()) as { id: string; record: unknown };
    expect(data.id).toBe("61");
    expect(data.record).toEqual([{ type: "total", displayValue: "11-2" }]);
  });

  it("renders the season HTML with breadcrumb + radar canvases + breakdown sections", async () => {
    // Seed all 4 KV slices so no summary POST is needed.
    const breakdownSample = [
      {
        season: 2024,
        teamId: 61,
        team: "Georgia",
        differential: {
          overall: {
            epaPerPlay: 0.12,
            epaPerPlayRank: 5,
            yardsPerPlay: 0.5,
            yardsPerPlayRank: 6,
            availableYardsPct: 0.05,
            availableYardsPctRank: 8,
            successRate: 0.04,
            successRateRank: 9,
            totalEPA: 50,
            totalEPARank: 4,
            epaPerGame: 4.2,
            epaPerGameRank: 4,
            startingFP: 5,
            startingFPRank: 8,
          },
        },
        offensive: {
          overall: {
            totalPlays: 900,
            totalPlaysRank: 4,
            playsPerGame: 70,
            playsPerGameRank: 4,
            totalEPA: 100,
            totalEPARank: 3,
            epaPerPlay: 0.2,
            epaPerPlayRank: 3,
            epaPerGame: 8.4,
            epaPerGameRank: 3,
            successRate: 0.5,
            successRateRank: 5,
            startingFP: 30,
            startingFPRank: 7,
          },
        },
        defensive: {
          overall: {
            totalPlays: 800,
            totalPlaysRank: 6,
            playsPerGame: 65,
            playsPerGameRank: 6,
            totalEPA: -50,
            totalEPARank: 8,
            epaPerPlay: -0.08,
            epaPerPlayRank: 7,
            epaPerGame: -4.1,
            epaPerGameRank: 7,
            successRate: 0.4,
            successRateRank: 9,
            startingFP: 25,
            startingFPRank: 11,
          },
        },
      },
    ];
    await env.LEAGUE_DATA.put("2024-61-overall", JSON.stringify(breakdownSample));
    await env.LEAGUE_DATA.put(
      "2024-61-passing",
      JSON.stringify([
        {
          name: "Carson Beck",
          playerId: "4685720",
          statistics: { plays: 400, completions: 250, attempts: 380, yards: 3000, touchdowns: 24, interceptions: 10, sacks: 18, detmer: 0.45, yardsPerDropback: 7.4, completionPct: 0.658 },
          advanced: { epaPerPlay: 0.22, totalEPA: 88, successRate: 0.51 },
        },
      ]),
    );
    await env.LEAGUE_DATA.put(
      "2024-61-rushing",
      JSON.stringify([
        {
          name: "Trevor Etienne",
          playerId: "4683078",
          statistics: { plays: 150, yards: 800, touchdowns: 9, fumbles: 1, yardsPerPlay: 5.3 },
          advanced: { epaPerPlay: 0.12, totalEPA: 18, successRate: 0.49 },
        },
      ]),
    );
    await env.LEAGUE_DATA.put(
      "2024-61-receiving",
      JSON.stringify([
        {
          name: "Arian Smith",
          playerId: "4685555",
          statistics: { plays: 60, catches: 40, targets: 60, yards: 700, touchdowns: 5, fumbles: 0, catchPct: 0.667, yardsPerPlay: 11.7 },
          advanced: { epaPerPlay: 0.31, totalEPA: 19, successRate: 0.55 },
        },
      ]),
    );

    stubEspnSeasonFetches();
    const res = await SELF.fetch("http://localhost/cfb/year/2024/team/61");
    expect(res.status).toBe(200);
    const body = await res.text();

    // Breadcrumb: Teams > <link to /cfb/team/61> > 2024
    expect(body).toContain('href="/cfb/team/61"');
    expect(body).toContain("breadcrumb");
    // CleanLocation: Georgia → georgia.
    expect(body).toContain("georgia");
    // Radar canvases (breakdown is non-empty).
    expect(body).toContain("offensive-canvas");
    expect(body).toContain("defensive-canvas");
    // Breakdown panels.
    expect(body).toContain("Breakdown");
    expect(body).toContain("Offensive");
    expect(body).toContain("Against the Pass");
    // Player boxes.
    expect(body).toContain("Carson Beck");
    expect(body).toContain("Trevor Etienne");
    expect(body).toContain("Arian Smith");
    // DETMER abbr label is present.
    expect(body).toContain("DETMER");
  });

  it("hides the radar canvases when the breakdown is empty", async () => {
    // Empty KV → retrieveTeamData returns the [{teamId, pos_team}]
    // sentinel, which has no `differential` key, so hasBreakdown is
    // true (length=1) and radars still render. To exercise the
    // "no breakdown" branch we need to seed an explicit empty array.
    await env.LEAGUE_DATA.put("2024-61-overall", JSON.stringify([]));
    await env.LEAGUE_DATA.put("2024-61-passing", JSON.stringify([]));
    await env.LEAGUE_DATA.put("2024-61-rushing", JSON.stringify([]));
    await env.LEAGUE_DATA.put("2024-61-receiving", JSON.stringify([]));

    stubEspnSeasonFetches();
    const res = await SELF.fetch("http://localhost/cfb/year/2024/team/61");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain("offensive-canvas");
    expect(body).not.toContain("defensive-canvas");
  });

  it("renders 'No games scheduled' when the schedule is empty", async () => {
    await env.LEAGUE_DATA.put("2024-61-overall", JSON.stringify([]));
    await env.LEAGUE_DATA.put("2024-61-passing", JSON.stringify([]));
    await env.LEAGUE_DATA.put("2024-61-rushing", JSON.stringify([]));
    await env.LEAGUE_DATA.put("2024-61-receiving", JSON.stringify([]));
    stubEspnSeasonFetches();

    const res = await SELF.fetch("http://localhost/cfb/year/2024/team/61");
    const body = await res.text();
    expect(body).toContain("No games scheduled for this team");
  });

  it("returns 500 when the ESPN base fetch fails", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response("nope", { status: 503 }),
    );
    const res = await SELF.fetch("http://localhost/cfb/year/2024/team/99999");
    expect(res.status).toBe(500);
  });
});
