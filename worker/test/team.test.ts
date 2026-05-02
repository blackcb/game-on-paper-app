import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hexToRgb } from "../src/templates/Team";

afterEach(() => {
  vi.restoreAllMocks();
});

const jsonResponse = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  });

const sampleTeam = {
  id: "61",
  location: "Georgia",
  name: "Bulldogs",
  color: "BA0C2F",
  alternateColor: "000000",
};

const sampleBreakdowns = [
  {
    season: 2022,
    teamId: 61,
    team: "Georgia",
    overall: { adjEpaPerPlay: 0.31 },
  },
  {
    season: 2023,
    teamId: 61,
    team: "Georgia",
    overall: { adjEpaPerPlay: 0.28 },
  },
  {
    season: 2024,
    teamId: 61,
    team: "Georgia",
    overall: { adjEpaPerPlay: 0.22 },
  },
];

const samplePercentiles = (pctile: number) => [
  { season: 2022, pctile, epaPerPlay: 0.1 + pctile },
  { season: 2023, pctile, epaPerPlay: 0.12 + pctile },
  { season: 2024, pctile, epaPerPlay: 0.15 + pctile },
];

async function clearKv() {
  const k1 = await env.LEAGUE_DATA.list();
  for (const k of k1.keys) await env.LEAGUE_DATA.delete(k.name);
  const k2 = await env.SUMMARY_LAST_UPDATED.list();
  for (const k of k2.keys) await env.SUMMARY_LAST_UPDATED.delete(k.name);
}

describe("hexToRgb", () => {
  it("parses a 6-char hex with no leading hash", () => {
    expect(hexToRgb("BA0C2F")).toEqual({ r: 186, g: 12, b: 47 });
  });
  it("accepts a leading hash", () => {
    expect(hexToRgb("#000000")).toEqual({ r: 0, g: 0, b: 0 });
  });
  it("returns null for invalid input", () => {
    expect(hexToRgb("not-a-color")).toBeNull();
    expect(hexToRgb("FFF")).toBeNull(); // 3-char short form not supported
    expect(hexToRgb(null)).toBeNull();
    expect(hexToRgb(undefined)).toBeNull();
  });
});

describe("/cfb/team/:teamId", () => {
  beforeEach(async () => {
    await clearKv();
  });

  it("returns the ESPN team payload as JSON when ?json=1", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("sports.core.api.espn.com")) {
        return jsonResponse(sampleTeam);
      }
      return jsonResponse({ results: sampleBreakdowns });
    });
    const res = await SELF.fetch("http://localhost/cfb/team/61?json=1");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("application/json");
    const data = (await res.json()) as typeof sampleTeam;
    expect(data.id).toBe("61");
    expect(data.location).toBe("Georgia");
  });

  it("renders the multi-season HTML page with breadcrumb + chart canvases + inlined breakdowns", async () => {
    // Seed everything in KV so no network fetches are needed.
    // retrieveTeamData with year=null, type=null reduces to a single
    // key segment: just the teamId.
    await env.LEAGUE_DATA.put("61", JSON.stringify(sampleBreakdowns));
    await env.SUMMARY_LAST_UPDATED.put(
      "summary-last-updated",
      JSON.stringify({ last_updated: "2026-04-30T12:00:00Z" }),
    );

    // The route still calls ESPN for team metadata. Use
    // mockImplementation so each call constructs a fresh Response —
    // workerd disallows reusing one Response across requests.
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse(sampleTeam));

    const res = await SELF.fetch("http://localhost/cfb/team/61");
    expect(res.status).toBe(200);
    const body = await res.text();

    expect(body).toContain('href="/cfb/teams"'); // breadcrumb link
    expect(body).toContain("metric_chart_canvas");
    expect(body).toContain("offensive-canvas");
    expect(body).toContain("defensive-canvas");
    expect(body).toContain("Available Seasons:");
    // yearRange string
    expect(body).toContain("2022 to 2024");
    // Last updated propagated.
    expect(body).toContain("2026-04-30T12:00:00Z");
    // Inlined breakdowns JSON for client-side Chart.js.
    expect(body).toMatch(/const breakdowns = \[/);
    expect(body).toContain('"season":2022');
    expect(body).toContain('"season":2024');
    // Default type=differential → no percentiles, but the variable is
    // still inlined as []/{}.
    expect(body).toMatch(/const percentiles = \[/);
    // CleanLocation: Georgia (id 61) lowercased.
    expect(body).toContain("georgia");
    // Default type=differential preserved in the type select.
    expect(body).toContain('<option value="differential" selected="">');
  });

  it("inlines percentiles when type=offensive (non-differential)", async () => {
    // retrieveTeamData with year=null, type=null reduces to a single
    // key segment: just the teamId.
    await env.LEAGUE_DATA.put("61", JSON.stringify(sampleBreakdowns));
    for (const p of [0.01, 0.25, 0.5, 0.75, 0.99]) {
      await env.LEAGUE_DATA.put(
        `percentiles-${p}`,
        JSON.stringify(samplePercentiles(p)),
      );
    }
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse(sampleTeam));

    // Pick a metric whose flat percentile key is present in the
    // sample (epaPerPlay). The default overall.adjEpaPerPlay would
    // pass through unchanged and miss the sample's epaPerPlay field.
    const res = await SELF.fetch(
      "http://localhost/cfb/team/61?type=offensive&metric=overall.epaPerPlay",
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    // Off/def-only metric optgroups should be present.
    expect(body).toContain("Passing");
    expect(body).toContain("Rushing");
    // Percentiles inlined: 3 seasons × 5 bands.
    expect(body).toMatch(/const percentiles = \[/);
    expect(body).toContain('"pctile":0.99');
  });

  it("rewrites differential + a non-overall metric back to overall.adjEpaPerPlay", async () => {
    // retrieveTeamData with year=null, type=null reduces to a single
    // key segment: just the teamId.
    await env.LEAGUE_DATA.put("61", JSON.stringify(sampleBreakdowns));
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse(sampleTeam));

    const res = await SELF.fetch(
      "http://localhost/cfb/team/61?type=differential&metric=passing.epaPerPlay",
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    // Forced back to overall.adjEpaPerPlay — the dropdown should mark it.
    expect(body).toContain('<option value="overall.adjEpaPerPlay" selected="">');
    // The original passing.epaPerPlay should not be selected, since
    // off/def optgroups are not even rendered for differential.
    expect(body).not.toContain('<option value="passing.epaPerPlay" selected="">');
  });

  it("rewrites differential + havocRate back to adjEpaPerPlay (havoc not differential-able)", async () => {
    // retrieveTeamData with year=null, type=null reduces to a single
    // key segment: just the teamId.
    await env.LEAGUE_DATA.put("61", JSON.stringify(sampleBreakdowns));
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse(sampleTeam));

    const res = await SELF.fetch(
      "http://localhost/cfb/team/61?type=differential&metric=overall.havocRate",
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('<option value="overall.adjEpaPerPlay" selected="">');
  });

  it("returns 500 when the ESPN team fetch fails (getTeamInformation → null)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response("nope", { status: 503 }),
    );
    const res = await SELF.fetch("http://localhost/cfb/team/99999");
    // Hono's default error handler returns 500 on thrown errors.
    expect(res.status).toBe(500);
  });
});
