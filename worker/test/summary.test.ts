import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  retrieveLastUpdated,
  retrieveLeagueData,
  type TeamLeagueRow,
} from "../src/lib/summary";

// vitest-pool-workers 0.15 (Vitest 4) doesn't expose the legacy
// `fetchMock` symbol from `cloudflare:test`. We stub `globalThis.fetch`
// per-test with vi.spyOn instead — equivalent semantics for our needs
// (intercept outbound HTTP, assert on URL/method, return canned JSON)
// without dragging undici MockAgent setup into every test file.

afterEach(() => {
  vi.restoreAllMocks();
});

const sampleRows: TeamLeagueRow[] = [
  {
    teamId: 333,
    team: "Alabama",
    overall: { adjEpaPerPlay: 0.42, adjEpaPerPlayRank: 1 },
  },
  {
    teamId: 99,
    team: "Auburn",
    overall: { adjEpaPerPlay: 0.18, adjEpaPerPlayRank: 47 },
  },
];

const jsonResponse = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  });

describe("retrieveLeagueData", () => {
  it("returns KV-cached data without hitting the summary service", async () => {
    await env.LEAGUE_DATA.put("2024-overall", JSON.stringify(sampleRows));
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await retrieveLeagueData(env.LEAGUE_DATA, 2024, "overall");
    expect(result).toEqual(sampleRows);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("on KV miss, POSTs the summary service and writes through to KV", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ results: sampleRows }));

    const result = await retrieveLeagueData(env.LEAGUE_DATA, 2023, "overall");
    expect(result).toEqual(sampleRows);

    // Verify the POST shape: x-www-form-urlencoded body with year + type.
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("http://summary:3000/");
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const body = (init?.body as URLSearchParams).toString();
    expect(body).toBe("year=2023&type=overall");

    // Write-through verified by KV read.
    const cached = await env.LEAGUE_DATA.get("2023-overall");
    expect(JSON.parse(cached!)).toEqual(sampleRows);
  });

  it("recursively walks year backward on summary failure, capped at 2 retries", async () => {
    // 2018 (initial) -> 2017 (retry 1) -> 2016 (retry 2) -> stop.
    // Same shape as Express's REMOTE_YEAR_RETRY_BUDGET.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("summary down", { status: 503 }));
    const result = await retrieveLeagueData(env.LEAGUE_DATA, 2018, "overall");
    expect(result).toEqual([]);
    // Three total attempts: initial + two retries.
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("respects the MIN_SEASON floor (won't walk below 2014)", async () => {
    // 2015 (initial) -> 2014 (retry 1) -> stop because 2013 < MIN_SEASON.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("summary down", { status: 503 }));
    const result = await retrieveLeagueData(env.LEAGUE_DATA, 2015, "overall");
    expect(result).toEqual([]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe("retrieveLastUpdated", () => {
  it("returns the cached last_updated timestamp on KV hit", async () => {
    await env.SUMMARY_LAST_UPDATED.put(
      "summary-last-updated",
      JSON.stringify({ last_updated: "2026-04-30T12:00:00Z" }),
    );
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await retrieveLastUpdated(env.SUMMARY_LAST_UPDATED);
    expect(result).toBe("2026-04-30T12:00:00Z");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("falls back to the summary /updated endpoint on KV miss", async () => {
    await env.SUMMARY_LAST_UPDATED.delete("summary-last-updated");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ last_updated: "2026-05-02T08:00:00Z" }));

    const result = await retrieveLastUpdated(env.SUMMARY_LAST_UPDATED);
    expect(result).toBe("2026-05-02T08:00:00Z");
    expect(fetchSpy).toHaveBeenCalledWith("http://summary:3000/updated");
  });
});
