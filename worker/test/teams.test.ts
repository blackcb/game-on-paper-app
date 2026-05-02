import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getTeamInformation, getTeamSeasonInformation } from "../src/lib/teams";
import { retrieveTeamData } from "../src/lib/summary";

afterEach(() => {
  vi.restoreAllMocks();
});

const jsonResponse = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  });

describe("getTeamInformation", () => {
  it("fetches the no-season team payload from ESPN core", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ id: "61", location: "Georgia" }));
    const data = await getTeamInformation(61);
    expect(data).toEqual({ id: "61", location: "Georgia" });
    const url = String(fetchSpy.mock.calls[0][0]);
    // No /seasons/ segment when year is null.
    expect(url).not.toContain("/seasons/");
    expect(url).toContain("/teams/61");
  });

  it("returns null on hard failure (so the route can render an error page)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("nope", { status: 503 }),
    );
    const data = await getTeamInformation(99999);
    expect(data).toBeNull();
  });
});

describe("getTeamSeasonInformation", () => {
  it("merges base + record + athletes + ranks + leaders + schedule", async () => {
    // 6 outbound calls in order: base, record, athletes, ranks, leaders,
    // then 2 schedule calls (seasontype 2 and 3) — but the populate
    // calls run in parallel after the base, so order isn't guaranteed.
    // URL-keyed mock keeps the test order-independent.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/record")) {
        return jsonResponse({ items: [{ wins: 11 }] });
      }
      if (url.includes("/athletes")) {
        return jsonResponse({ items: [{ id: "1", name: "QB" }] });
      }
      if (url.includes("/ranks")) {
        return jsonResponse({ items: [{ current: 5 }] });
      }
      if (url.includes("/leaders")) {
        return jsonResponse({ items: [{ stat: "passing" }] });
      }
      if (url.includes("/schedule")) {
        // Schedule shape: events keyed by date string.
        if (url.includes("seasontype=2")) {
          return jsonResponse({
            events: {
              "2024-09-01": {
                id: "401001",
                competitions: [{ status: { type: { name: "STATUS_FINAL" } } }],
              },
            },
          });
        }
        return jsonResponse({
          events: {
            "2025-01-01": {
              id: "401999",
              competitions: [{ status: { type: { name: "STATUS_SCHEDULED" } } }],
            },
          },
        });
      }
      // Base team payload.
      return jsonResponse({ id: "61", location: "Georgia", color: "BA0C2F" });
    });

    const data = await getTeamSeasonInformation(2024, 61);
    expect(data).not.toBeNull();
    expect(data!.id).toBe("61");
    expect(data!.record).toEqual([{ wins: 11 }]);
    expect(data!.athletes).toEqual([{ id: "1", name: "QB" }]);
    expect(data!.ranks).toEqual([{ current: 5 }]);
    expect(data!.leaders).toEqual([{ stat: "passing" }]);
    expect(Array.isArray(data!.events)).toBe(true);
    expect((data!.events as unknown[]).length).toBe(2);
  });

  it("returns null when the base team fetch fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("not found", { status: 404 }),
    );
    const data = await getTeamSeasonInformation(2024, 99999);
    expect(data).toBeNull();
  });

  it("survives a failed sub-fetch (athletes 503) by emitting empty for that key", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/athletes")) {
        return new Response("athletes service down", { status: 503 });
      }
      if (
        url.includes("/record") ||
        url.includes("/ranks") ||
        url.includes("/leaders")
      ) {
        return jsonResponse({ items: [] });
      }
      if (url.includes("/schedule")) {
        return jsonResponse({ events: {} });
      }
      return jsonResponse({ id: "61", location: "Georgia" });
    });
    const data = await getTeamSeasonInformation(2024, 61);
    expect(data).not.toBeNull();
    expect(data!.athletes).toEqual([]);
  });
});

describe("retrieveTeamData", () => {
  it("returns KV-cached data without hitting summary", async () => {
    const sample = [{ teamId: 333, team: "Alabama", overall: { adjEpaPerPlay: 0.4 } }];
    await env.LEAGUE_DATA.put("2024-333-overall", JSON.stringify(sample));
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const data = await retrieveTeamData(env.LEAGUE_DATA, 2024, 333, "overall");
    expect(data).toEqual(sample);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("falls back to summary POST + writes through to KV", async () => {
    const sample = [{ teamId: 99, team: "Auburn", overall: { adjEpaPerPlay: 0.2 } }];
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ results: sample }));
    const data = await retrieveTeamData(env.LEAGUE_DATA, 2023, 99, "overall");
    expect(data).toEqual(sample);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const cached = await env.LEAGUE_DATA.get("2023-99-overall");
    expect(JSON.parse(cached!)).toEqual(sample);
  });

  it("returns the [{teamId, pos_team}] sentinel on hard failure", async () => {
    // Match the Express quirk: failure with no fallback path returns
    // [{ pos_team: team_id }] not []. The team_season template expects
    // a non-empty array.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("nope", { status: 503 }),
    );
    const data = await retrieveTeamData(env.LEAGUE_DATA, 2015, 7777, "overall");
    expect(data.length).toBeGreaterThan(0);
    expect(data[0].teamId).toBe(7777);
    expect(data[0].pos_team).toBe(7777);
  });
});
