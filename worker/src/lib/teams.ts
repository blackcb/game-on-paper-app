// Replaces frontend/cfb/teams.js. Pulls team metadata + roster +
// schedule from ESPN's two API surfaces:
//   - sports.core.api.espn.com (records, athletes, ranks, leaders)
//   - site.api.espn.com (schedule by season type)
// Both are public, no auth needed.

const ESPN_CORE = "https://sports.core.api.espn.com/v2/sports/football/leagues/college-football";
const ESPN_SITE = "https://site.api.espn.com/apis/site/v2/sports/football/college-football";

async function populate(
  endpoint: string,
  season: number | null,
  teamId: string | number,
  type: string | null = null,
): Promise<Record<string, unknown>> {
  const seasonStr = season != null ? `/seasons/${season}` : "";
  const seasonType = type != null ? `/types/${type}` : "";
  const url = `${ESPN_CORE}${seasonStr}${seasonType}/teams/${teamId}/${endpoint}?lang=en&region=us`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`ESPN ${endpoint || "team"} returned ${response.status}`);
  }
  return (await response.json()) as Record<string, unknown>;
}

// Multi-season team info (no season scoping). Shape: location, name,
// color, logos, etc. — used by the multi-season /cfb/team/:teamId page.
export async function getTeamInformation(
  teamId: string | number,
): Promise<Record<string, unknown> | null> {
  try {
    const result = await populate("", null, teamId);
    return result ?? null;
  } catch (err) {
    console.log(`getTeamInformation failed for ${teamId}: ${(err as Error).message}`);
    return null;
  }
}

// Single-season team info: base team + record + athletes + ranks +
// leaders + schedule (regular season + postseason). Mirrors
// teams.js:26-66 — same call sequence, same season-type IDs (record
// and leaders use type 2 = regular season; schedule fetches both 2
// and 3 = postseason).
export async function getTeamSeasonInformation(
  season: number,
  teamId: string | number,
): Promise<Record<string, unknown> | null> {
  let result: Record<string, unknown>;
  try {
    result = await populate("", season, teamId);
  } catch (err) {
    console.log(`getTeamSeasonInformation base fetch failed: ${(err as Error).message}`);
    return null;
  }

  const populatableKeys = ["record", "athletes", "ranks", "leaders"];
  const typeKeys = new Set(["record", "leaders"]);
  const valPromises = populatableKeys.map((item) =>
    populate(item, season, teamId, typeKeys.has(item) ? "2" : null).catch((err) => {
      console.log(`team-${item} fetch failed: ${(err as Error).message}`);
      // Return an empty `items` shape so the spread below doesn't NPE.
      return { items: [] };
    }),
  );
  const populatingValues = await Promise.all(valPromises);
  populatableKeys.forEach((item, idx) => {
    result[item] = (populatingValues[idx] as { items?: unknown }).items ?? [];
  });

  // Schedule: regular (2) + postseason (3). The site API returns
  // `events` as an object keyed by date string, with each value being
  // a game record. We flatten to an array and surface
  // competitions[0].status as game.status (matches the Express side).
  const schedulePromises = [2, 3].map((seasonType) => {
    const params = new URLSearchParams({ seasontype: String(seasonType) });
    if (season) params.append("season", String(season));
    return fetch(`${ESPN_SITE}/teams/${teamId}/schedule?${params}`).then((r) => {
      if (!r.ok) throw new Error(`ESPN schedule type ${seasonType} returned ${r.status}`);
      return r.json() as Promise<{ events?: Record<string, ScheduleEvent> }>;
    }).catch((err) => {
      console.log(`schedule type=${seasonType} failed: ${(err as Error).message}`);
      return { events: {} as Record<string, ScheduleEvent> };
    });
  });
  const responses = await Promise.all(schedulePromises);

  const events: ScheduleEvent[] = [];
  for (const response of responses) {
    for (const [, game] of Object.entries(response.events ?? {})) {
      if (game?.competitions?.[0] != null) {
        game.status = game.competitions[0].status;
        events.push(game);
      }
    }
  }
  result.events = events;
  return result;
}

interface ScheduleEvent {
  competitions?: Array<{ status?: unknown }>;
  status?: unknown;
  [key: string]: unknown;
}
