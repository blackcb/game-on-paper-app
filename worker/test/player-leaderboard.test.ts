import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  playerLeaderTitle,
  playerStatMinimum,
  preparePlayerRows,
} from "../src/lib/leaderboard";
import type { TeamLeagueRow } from "../src/lib/summary";

afterEach(() => {
  vi.restoreAllMocks();
});

const samplePassing: TeamLeagueRow[] = [
  {
    teamId: 333,
    team: "Alabama",
    name: "QB One",
    statistics: { games: 12, dropbacks: 400, sackAdjustedYards: 3000, dropbacksRank: 1 },
    advanced: {
      epaPerPlay: 0.45,
      epaPerPlayRank: 1,
      totalEPA: 100,
      totalEPARank: 1,
      successRate: 0.55,
      successRateRank: 1,
    },
  },
  {
    teamId: 99,
    team: "Auburn",
    name: "QB Two",
    statistics: { games: 11, dropbacks: 320, sackAdjustedYards: 2200 },
    advanced: {
      epaPerPlay: 0.18,
      epaPerPlayRank: 30,
      totalEPA: 40,
      totalEPARank: 25,
      successRate: 0.42,
      successRateRank: 60,
    },
  },
  {
    teamId: 77,
    team: "Ole Miss",
    name: "QB Three",
    statistics: { games: 10, dropbacks: 250 },
    // No advanced stats — should be filtered out for advanced.epaPerPlay sort.
  },
];

describe("preparePlayerRows", () => {
  it("filters out rows with null value or rank for the requested sort", () => {
    const rows = preparePlayerRows(samplePassing, "advanced.epaPerPlay");
    // Third row missing advanced entirely → dropped.
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.teamId)).toEqual([333, 99]);
  });

  it("sorts descending (highest first)", () => {
    const rows = preparePlayerRows(samplePassing, "advanced.totalEPA");
    expect(rows[0].teamId).toBe(333); // 100
    expect(rows[1].teamId).toBe(99); // 40
  });

  it("treats string 'NA' as null (matches summary service shape)", () => {
    const data: TeamLeagueRow[] = [
      {
        teamId: 1,
        team: "x",
        name: "A",
        advanced: { epaPerPlay: "NA", epaPerPlayRank: "NA" },
      },
      {
        teamId: 2,
        team: "y",
        name: "B",
        advanced: { epaPerPlay: 0.3, epaPerPlayRank: 5 },
      },
    ];
    const rows = preparePlayerRows(data, "advanced.epaPerPlay");
    expect(rows).toHaveLength(1);
    expect(rows[0].teamId).toBe(2);
  });
});

describe("playerLeaderTitle / playerStatMinimum", () => {
  it("returns the right title per type", () => {
    expect(playerLeaderTitle("passing")).toBe("Passing Statistics");
    expect(playerLeaderTitle("rushing")).toBe("Rushing Statistics");
    expect(playerLeaderTitle("receiving")).toBe("Receiving Statistics");
  });

  it("emits the qualifying-minimum disclaimer with link", () => {
    expect(playerStatMinimum("passing")).toContain("min. 14 dropbacks per team-game");
    expect(playerStatMinimum("rushing")).toContain("min. 6.25 carries per team-game");
    expect(playerStatMinimum("receiving")).toContain("min. 1.875 targets per team-game");
    expect(playerStatMinimum("passing")).toContain("Pro Football Reference");
  });
});

describe("/cfb/year/:year/players/:type", () => {
  beforeEach(async () => {
    const k1 = await env.LEAGUE_DATA.list();
    for (const k of k1.keys) await env.LEAGUE_DATA.delete(k.name);
    const k2 = await env.SUMMARY_LAST_UPDATED.list();
    for (const k of k2.keys) await env.SUMMARY_LAST_UPDATED.delete(k.name);
  });

  it("renders passing leaderboard from KV-cached data", async () => {
    await env.LEAGUE_DATA.put("2024-passing", JSON.stringify(samplePassing));
    await env.SUMMARY_LAST_UPDATED.put(
      "summary-last-updated",
      JSON.stringify({ last_updated: "2026-04-30T12:00:00Z" }),
    );
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const res = await SELF.fetch("http://localhost/cfb/year/2024/players/passing");
    expect(res.status).toBe(200);
    const body = await res.text();

    expect(body).toContain("Passing Statistics");
    expect(body).toContain("min. 14 dropbacks per team-game");
    expect(body).toContain("QB One");
    expect(body).toContain("QB Two");
    // Ole Miss QB Three filtered out (no advanced stats).
    expect(body).not.toContain("QB Three");
    // Last updated rendered
    expect(body).toContain("2026-04-30T12:00:00Z");
    // Sort dropdown showing the active key
    expect(body).toContain('<option value="advanced.epaPerPlay" selected="">');

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("renders the receiving caveat note only on receiving views", async () => {
    await env.LEAGUE_DATA.put("2024-receiving", JSON.stringify([]));
    const res = await SELF.fetch("http://localhost/cfb/year/2024/players/receiving");
    const body = await res.text();
    expect(body).toContain("ESPN does not consistently mark targeted receivers");
    expect(body).toContain("min. 1.875 targets per team-game");
  });

  it("rushing view does NOT show the receiving caveat", async () => {
    await env.LEAGUE_DATA.put("2024-rushing", JSON.stringify([]));
    const res = await SELF.fetch("http://localhost/cfb/year/2024/players/rushing");
    const body = await res.text();
    expect(body).not.toContain("ESPN does not consistently mark targeted receivers");
    expect(body).toContain("min. 6.25 carries per team-game");
  });

  it("falls back to summary service on KV miss + writes through", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.endsWith("/updated")) {
        return new Response(JSON.stringify({ last_updated: "2026-05-02T08:00:00Z" }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ results: samplePassing }), {
        headers: { "content-type": "application/json" },
      });
    });

    const res = await SELF.fetch("http://localhost/cfb/year/2024/players/passing");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("QB One");
    expect(body).toContain("2026-05-02T08:00:00Z");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const cached = await env.LEAGUE_DATA.get("2024-passing");
    expect(JSON.parse(cached!)).toEqual(samplePassing);
  });
});
