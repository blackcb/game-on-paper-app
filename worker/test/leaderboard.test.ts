import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanRank,
  generateColorRampValue,
  generateMarginalString,
  prepareLeaderboardRows,
  retrieveValue,
  roundNumber,
} from "../src/lib/leaderboard";
import type { TeamLeagueRow } from "../src/lib/summary";

afterEach(() => {
  vi.restoreAllMocks();
});

// ---- Helpers (pure, no KV needed) ---------------------------------------

describe("roundNumber", () => {
  it("returns 'N/A' for null/undefined but not 0", () => {
    expect(roundNumber(null, 2, 2)).toBe("N/A");
    expect(roundNumber(undefined, 2, 2)).toBe("N/A");
    expect(roundNumber(0, 2, 2)).toBe("0.00");
  });

  it("rounds to power10 + fixes decimals", () => {
    expect(roundNumber(0.42891, 2, 2)).toBe("0.43");
    expect(roundNumber(0.42449, 2, 2)).toBe("0.42");
    expect(roundNumber(123.456, 0, 0)).toBe("123");
  });
});

describe("generateMarginalString", () => {
  it("only prefixes positives with '+' on the differential view", () => {
    expect(generateMarginalString(0.42, 2, 2, "differential")).toBe("+0.42");
    expect(generateMarginalString(0.42, 2, 2, "offensive")).toBe("0.42");
    expect(generateMarginalString(-0.18, 2, 2, "differential")).toBe("-0.18");
  });

  it("returns 'N/A' on null", () => {
    expect(generateMarginalString(null, 2, 2, "differential")).toBe("N/A");
  });
});

describe("generateColorRampValue", () => {
  it("returns null for the middle band (steps 4 and 5)", () => {
    // step 4 = rank 60/100, step 5 = rank 50/100. Both are middle, no class.
    expect(generateColorRampValue(60, 100)).toBe(null);
    expect(generateColorRampValue(50, 100)).toBe(null);
  });

  it("returns class names for top/bottom bands", () => {
    expect(generateColorRampValue(1, 100)).toBe("hulk-bg-level-9");
    expect(generateColorRampValue(99, 100)).toBe("hulk-bg-level-0");
  });

  it("clamps out-of-range ranks", () => {
    expect(generateColorRampValue(150, 100)).toBe("hulk-bg-level-0");
    expect(generateColorRampValue(-10, 100)).toBe("hulk-bg-level-9");
  });

  it("returns null on falsy input", () => {
    expect(generateColorRampValue(null, 100)).toBe(null);
    expect(generateColorRampValue(0, 100)).toBe(null);
  });
});

describe("retrieveValue", () => {
  it("walks dotted paths into nested objects", () => {
    const t: TeamLeagueRow = {
      teamId: 1,
      team: "x",
      overall: { adjEpaPerPlay: 0.42 },
    };
    expect(retrieveValue(t, "overall.adjEpaPerPlay")).toBe(0.42);
  });

  it("returns undefined on any missing segment", () => {
    expect(retrieveValue({ teamId: 1, team: "x" }, "overall.adjEpaPerPlay")).toBe(undefined);
  });
});

describe("cleanRank", () => {
  it("renders ties with T- prefix", () => {
    expect(cleanRank(4.5)).toBe("T-4");
    expect(cleanRank("12.5")).toBe("T-12");
  });

  it("floors integer ranks", () => {
    expect(cleanRank(3)).toBe("3");
    expect(cleanRank("47")).toBe("47");
  });

  it("returns 'N/A' for null", () => {
    expect(cleanRank(null)).toBe("N/A");
  });
});

// ---- prepareLeaderboardRows (server-side filter + sort) -----------------

const sampleData: TeamLeagueRow[] = [
  {
    teamId: 1,
    team: "Alabama",
    differential: { adjEpaPerPlay: 0.42, adjEpaPerPlayRank: 1, epaPerPlay: 0.4, epaPerPlayRank: 1 },
    offensive: { adjEpaPerPlay: 0.6, adjEpaPerPlayRank: 1, epaPerPlay: 0.5, epaPerPlayRank: 2 },
    defensive: { adjEpaPerPlay: -0.2, adjEpaPerPlayRank: 5, epaPerPlay: -0.1, epaPerPlayRank: 3 },
  },
  {
    teamId: 2,
    team: "Auburn",
    differential: { adjEpaPerPlay: 0.1, adjEpaPerPlayRank: 50, epaPerPlay: 0.05, epaPerPlayRank: 60 },
    offensive: { adjEpaPerPlay: 0.3, adjEpaPerPlayRank: 25, epaPerPlay: 0.25, epaPerPlayRank: 30 },
    defensive: { adjEpaPerPlay: 0.2, adjEpaPerPlayRank: 100, epaPerPlay: 0.15, epaPerPlayRank: 80 },
  },
  {
    teamId: 3,
    team: "Tennessee",
    differential: { adjEpaPerPlay: -0.1, adjEpaPerPlayRank: 80, epaPerPlay: -0.2, epaPerPlayRank: 90 },
    offensive: { adjEpaPerPlay: 0.4, adjEpaPerPlayRank: 10, epaPerPlay: 0.35, epaPerPlayRank: 15 },
    defensive: { adjEpaPerPlay: 0.5, adjEpaPerPlayRank: 130, epaPerPlay: 0.55, epaPerPlayRank: 130 },
  },
];

describe("prepareLeaderboardRows", () => {
  it("differential + adjEpaPerPlay sorts descending", () => {
    const { rows, sortKey, ascending } = prepareLeaderboardRows(
      sampleData,
      "differential",
      "overall.adjEpaPerPlay",
    );
    // Differential view doesn't use 'overall' nesting in production
    // — the projected row spreads t.differential to top level. So
    // sort key after projection is "overall.adjEpaPerPlay" but the
    // value lives at row.adjEpaPerPlay (no overall). Verify:
    // sortKey is preserved as requested (overall.adjEpaPerPlay) and
    // descending order holds for the projected adjEpaPerPlay values.
    expect(sortKey).toBe("overall.adjEpaPerPlay");
    expect(ascending).toBe(false);
    // For adjEpaPerPlay, no rows are dropped even when value is null.
    expect(rows).toHaveLength(3);
    expect(rows[0].teamId).toBe(1); // Alabama 0.42
    expect(rows[1].teamId).toBe(2); // Auburn 0.10
    expect(rows[2].teamId).toBe(3); // Tennessee -0.10
  });

  it("falls back to overall.adjEpaPerPlay when differential view requests passing/rushing/havoc", () => {
    const { sortKey } = prepareLeaderboardRows(
      sampleData,
      "differential",
      "passing.epaPerPlay",
    );
    expect(sortKey).toBe("overall.adjEpaPerPlay");
  });

  it("falls back when differential requests overall.havocRate", () => {
    const { sortKey } = prepareLeaderboardRows(
      sampleData,
      "differential",
      "overall.havocRate",
    );
    expect(sortKey).toBe("overall.adjEpaPerPlay");
  });

  it("defensive flips sort direction (lower is better) except for havocRate", () => {
    const epa = prepareLeaderboardRows(sampleData, "defensive", "overall.epaPerPlay");
    expect(epa.ascending).toBe(true);
    const havoc = prepareLeaderboardRows(sampleData, "defensive", "overall.havocRate");
    expect(havoc.ascending).toBe(false);
  });

  it("offensive only flips sort direction for havocRate", () => {
    const epa = prepareLeaderboardRows(sampleData, "offensive", "overall.epaPerPlay");
    expect(epa.ascending).toBe(false);
    const havoc = prepareLeaderboardRows(sampleData, "offensive", "overall.havocRate");
    expect(havoc.ascending).toBe(true);
  });
});

// ---- Full route + KV + rendered HTML ------------------------------------

const fullSeasonData: TeamLeagueRow[] = sampleData;

describe("/cfb/year/:year/teams/:type", () => {
  beforeEach(async () => {
    // Clear KV state between tests so writes from one don't leak
    // into another. Per-test KV isolation isn't on by default in
    // vitest-pool-workers 0.15.
    const keys = await env.LEAGUE_DATA.list();
    for (const k of keys.keys) await env.LEAGUE_DATA.delete(k.name);
    const keys2 = await env.SUMMARY_LAST_UPDATED.list();
    for (const k of keys2.keys) await env.SUMMARY_LAST_UPDATED.delete(k.name);
  });

  it("renders the leaderboard from KV-cached league data", async () => {
    await env.LEAGUE_DATA.put("2024-overall", JSON.stringify(fullSeasonData));
    await env.SUMMARY_LAST_UPDATED.put(
      "summary-last-updated",
      JSON.stringify({ last_updated: "2026-04-30T12:00:00Z" }),
    );

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await SELF.fetch("http://localhost/cfb/year/2024/teams/differential");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
    const body = await res.text();

    // Page chrome + breadcrumb
    expect(body).toContain("Net Statistics");
    expect(body).toContain('href="/cfb/year/2024"');

    // Last-updated rendered
    expect(body).toContain("2026-04-30T12:00:00Z");

    // All three teams present, each linking to their team season page
    expect(body).toContain("/cfb/year/2024/team/1");
    expect(body).toContain("/cfb/year/2024/team/2");
    expect(body).toContain("/cfb/year/2024/team/3");

    // No outbound HTTP (full KV-hit path)
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("falls back to summary service on KV miss + writes through", async () => {
    // URL-keyed mock so the test doesn't depend on which retrieve* call
    // happens first (retrieveLeagueData and retrieveLastUpdated both
    // hit fetch on a cold cache, and the order is implementation
    // detail).
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.endsWith("/updated")) {
        return new Response(JSON.stringify({ last_updated: "2026-05-01T08:00:00Z" }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ results: fullSeasonData }), {
        headers: { "content-type": "application/json" },
      });
    });

    const res = await SELF.fetch("http://localhost/cfb/year/2024/teams/offensive");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Offensive Statistics");
    expect(body).toContain("2026-05-01T08:00:00Z");

    // Both summary fetches happened
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    // Write-through: KV is now populated
    const cached = await env.LEAGUE_DATA.get("2024-overall");
    expect(JSON.parse(cached!)).toEqual(fullSeasonData);
  });

  it("preserves the requested sort + arrow direction in the rendered HTML", async () => {
    await env.LEAGUE_DATA.put("2024-overall", JSON.stringify(fullSeasonData));
    const res = await SELF.fetch(
      "http://localhost/cfb/year/2024/teams/defensive?sort=overall.havocRate",
    );
    const body = await res.text();
    // havocRate on defensive = NOT ascending (higher is better even on D),
    // so the arrow should be down.
    expect(body).toContain('<option value="overall.havocRate" selected="">');
    expect(body).toMatch(/Havoc % <i class="bi bi-arrow-down"><\/i>/);
  });

  it("falls back the sort key when differential is asked for passing.epaPerPlay", async () => {
    await env.LEAGUE_DATA.put("2024-overall", JSON.stringify(fullSeasonData));
    const res = await SELF.fetch(
      "http://localhost/cfb/year/2024/teams/differential?sort=passing.epaPerPlay",
    );
    const body = await res.text();
    // Active-sort selection landed back on adjEpaPerPlay in the dropdown.
    expect(body).toContain('<option value="overall.adjEpaPerPlay" selected="">');
  });
});
