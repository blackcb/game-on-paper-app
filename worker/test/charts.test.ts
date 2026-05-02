import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPercentileKey } from "../src/lib/leaderboard";
import type { PercentileRow } from "../src/lib/summary";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getPercentileKey", () => {
  it("maps known dotted metrics to flat keys", () => {
    expect(getPercentileKey("overall.epaPerPlay")).toBe("epaPerPlay");
    expect(getPercentileKey("passing.epaPerPlay")).toBe("epaPerDropback");
    expect(getPercentileKey("rushing.epaPerPlay")).toBe("epaPerRush");
    expect(getPercentileKey("rushing.lineYards")).toBe("lineYards");
    expect(getPercentileKey("overall.thirdDownDistance")).toBe("thirdDownDistance");
  });

  it("passes through unknown metrics unchanged", () => {
    expect(getPercentileKey("foo.bar")).toBe("foo.bar");
  });
});

const samplePctRows = (pctile: number): PercentileRow[] => [
  { season: 2022, pctile, epaPerPlay: 0.1 + pctile, epaPerDropback: 0.2 + pctile },
  { season: 2023, pctile, epaPerPlay: 0.12 + pctile, epaPerDropback: 0.22 + pctile },
  { season: 2024, pctile, epaPerPlay: 0.15 + pctile, epaPerDropback: 0.25 + pctile },
];

describe("/cfb/charts/trends", () => {
  beforeEach(async () => {
    const k1 = await env.LEAGUE_DATA.list();
    for (const k of k1.keys) await env.LEAGUE_DATA.delete(k.name);
    const k2 = await env.SUMMARY_LAST_UPDATED.list();
    for (const k of k2.keys) await env.SUMMARY_LAST_UPDATED.delete(k.name);
  });

  it("returns 200 HTML with breadcrumb and inline percentiles JSON", async () => {
    // Seed all 5 pctile bands in KV so no fetch happens.
    for (const p of [0.01, 0.25, 0.5, 0.75, 0.99]) {
      await env.LEAGUE_DATA.put(
        `percentiles-${p}`,
        JSON.stringify(samplePctRows(p)),
      );
    }
    await env.SUMMARY_LAST_UPDATED.put(
      "summary-last-updated",
      JSON.stringify({ last_updated: "2026-04-30T12:00:00Z" }),
    );

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await SELF.fetch("http://localhost/cfb/charts/trends");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("National Trends");
    expect(body).toContain("breadcrumb");
    expect(body).toContain("metric_chart_canvas");
    // Inline percentiles JSON for the client-side Chart.js code.
    expect(body).toMatch(/const percentiles = \[/);
    // 2022, 2023, 2024 across 5 pctile bands = 15 rows; verify
    // they're inlined.
    expect(body).toContain('"season":2022');
    expect(body).toContain('"season":2024');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rewrites type=differential to offensive", async () => {
    for (const p of [0.01, 0.25, 0.5, 0.75, 0.99]) {
      await env.LEAGUE_DATA.put(
        `percentiles-${p}`,
        JSON.stringify(samplePctRows(p)),
      );
    }
    const res = await SELF.fetch("http://localhost/cfb/charts/trends?type=differential");
    const body = await res.text();
    // Differential silently rewrites to offensive — the dropdown
    // should mark "offensive" as selected.
    expect(body).toContain('<option value="offensive" selected="">');
  });

  it("emits JSON when ?json=1", async () => {
    for (const p of [0.01, 0.25, 0.5, 0.75, 0.99]) {
      await env.LEAGUE_DATA.put(
        `percentiles-${p}`,
        JSON.stringify(samplePctRows(p)),
      );
    }
    const res = await SELF.fetch("http://localhost/cfb/charts/trends?json=1");
    expect(res.headers.get("content-type") ?? "").toContain("application/json");
    const data = (await res.json()) as Array<{ season: number; pctile: number; value: number }>;
    // 3 seasons * 5 pctiles = 15 entries.
    expect(data).toHaveLength(15);
    expect(data[0]).toHaveProperty("season");
    expect(data[0]).toHaveProperty("pctile");
    expect(data[0]).toHaveProperty("value");
  });

  it("filters out percentiles missing the requested metric key", async () => {
    // One season has the metric, another doesn't. The latter should
    // be dropped by the value !== undefined filter.
    for (const p of [0.01, 0.25, 0.5, 0.75, 0.99]) {
      await env.LEAGUE_DATA.put(
        `percentiles-${p}`,
        JSON.stringify([
          { season: 2022, pctile: p, epaPerPlay: 0.1 + p },
          { season: 2023, pctile: p }, // no epaPerPlay
        ]),
      );
    }
    const res = await SELF.fetch("http://localhost/cfb/charts/trends?metric=overall.epaPerPlay&json=1");
    const data = (await res.json()) as unknown[];
    expect(data).toHaveLength(5); // only 2022 (5 bands), 2023 dropped
  });
});

describe("/cfb/year/:year/charts/team/epa", () => {
  beforeEach(async () => {
    const k1 = await env.LEAGUE_DATA.list();
    for (const k of k1.keys) await env.LEAGUE_DATA.delete(k.name);
    const k2 = await env.SUMMARY_LAST_UPDATED.list();
    for (const k of k2.keys) await env.SUMMARY_LAST_UPDATED.delete(k.name);
  });

  it("renders the EPA scatter chart with inline teams JSON", async () => {
    await env.LEAGUE_DATA.put(
      "2024-overall",
      JSON.stringify([
        {
          teamId: 333,
          team: "Alabama",
          fbsClass: "P4",
          offensive: { overall: { adjEpaPerPlay: 0.5 } },
          defensive: { overall: { adjEpaPerPlay: -0.2 } },
        },
        {
          teamId: 99,
          team: "Auburn",
          fbsClass: "P4",
          offensive: { overall: { adjEpaPerPlay: 0.2 } },
          defensive: { overall: { adjEpaPerPlay: 0.05 } },
        },
      ]),
    );
    const res = await SELF.fetch("http://localhost/cfb/year/2024/charts/team/epa");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Adj EPA/Play Comparison");
    expect(body).toContain("p4_chart_canvas");
    expect(body).toContain("g6_chart_canvas");
    // Projected shape inlined for the client.
    expect(body).toMatch(/const teams = \[/);
    expect(body).toContain('"teamId":333');
    expect(body).toContain('"adjOffEpa":0.5');
    expect(body).toContain('"adjDefEpa":-0.2');
    expect(body).toContain('"fbsClass":"P4"');
  });

  it("uses P5/G5 split for pre-2024 seasons (post-realignment shift)", async () => {
    await env.LEAGUE_DATA.put("2022-overall", JSON.stringify([]));
    const res = await SELF.fetch("http://localhost/cfb/year/2022/charts/team/epa");
    const body = await res.text();
    // The client-side code has the season >= 2024 branch for P4/G6
    // and the < 2024 branch for P5/G5. Both branches' string literals
    // must be present so the inlined JS can pick the right one.
    expect(body).toContain("P5");
    expect(body).toContain("G5");
  });
});
