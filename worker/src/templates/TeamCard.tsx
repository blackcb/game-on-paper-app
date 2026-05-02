import type { FC, Child } from "hono/jsx";
import {
  cleanLocation,
  getNumberWithOrdinal,
  maxTeamsForSeason,
  sliceColorRamp,
  teamCardMarginal,
} from "../lib/team_helpers";

// Reproduces frontend/views/partials/team_card.ejs. Used by both
// the per-season team page (TeamSeason) and the pregame matchup
// (Pregame). The original EJS accepted either an ESPN team object
// directly or a competitor object that has the team nested under
// `.team` — that branch (`Object.keys(teamData).includes('team')`)
// is preserved here so callers can pass either shape.

export interface TeamCardTeam {
  id?: string | number;
  location?: string;
  record?: Array<{
    type?: string;
    displayValue?: string;
    stats?: Array<{ name?: string; displayValue?: string }>;
  }>;
  [key: string]: unknown;
}

// `teamData` is either the team itself or a competitor wrapping it.
// `breakdown` is the summary-service slice array (typically length 1).
interface TeamCardProps {
  teamData: TeamCardTeam | { team?: TeamCardTeam; record?: TeamCardTeam["record"]; [key: string]: unknown };
  breakdown: Array<Record<string, unknown>>;
  season: number | string;
  hideNavigation: boolean;
}

export const TeamCard: FC<TeamCardProps> = ({ teamData, breakdown, season, hideNavigation }) => {
  // Express partial accepts either an ESPN team or a competitor that
  // wraps one. Same coalescence here. team_card.ejs:18.
  const wrapper = teamData as { team?: TeamCardTeam; record?: TeamCardTeam["record"] };
  const team: TeamCardTeam = wrapper.team ?? (teamData as TeamCardTeam);
  // record lives on the competitor, not on the nested team.
  const records =
    wrapper.record ?? (teamData as TeamCardTeam).record ?? [];
  const location = cleanLocation({ id: team.id, location: team.location });
  const maxTeams = maxTeamsForSeason(season);
  const overallStuff = records.find((r) => r.type === "total");
  const overall = overallStuff?.displayValue ?? "0-0";
  const finishStat = overallStuff?.stats?.find((s) => s.name === "playoffSeed");
  const finish = finishStat
    ? getNumberWithOrdinal(parseInt(String(finishStat.displayValue), 10))
    : "N/A";
  const confRecs = records.filter((r) => r.type === "vsconf");
  const conf = confRecs.length > 0 ? ` (Conf: ${confRecs[0].displayValue})` : "";

  const first = (breakdown[0] ?? {}) as Record<string, unknown>;
  const isBreakdownAvailable = first.differential != null;
  const diff = (first.differential as Record<string, Record<string, unknown>> | undefined)?.overall ?? {};
  const breakdownSeason = (first as { season?: unknown }).season;
  const yearPrefix =
    breakdownSeason && String(season) !== String(breakdownSeason)
      ? `${breakdownSeason} `
      : "";

  const rampClass = (rank: unknown): string => {
    const c = sliceColorRamp(rank);
    if (!c) return "";
    if (rank == null || rank === "") return "";
    const value = (maxTeams - parseFloat(String(rank))) / maxTeams;
    const step = Math.round(value / 0.1);
    const clamped = Math.min(Math.max(step, 0), 9);
    if (clamped === 4 || clamped === 5) return "";
    return ` hulk-bg-level-${clamped}`;
  };

  const cell = (statKey: string, formatter: (n: number) => string) => {
    const stat = diff[statKey] as number | undefined;
    const rank = diff[`${statKey}Rank`];
    return (
      <td class={`numeral text-center${rampClass(rank)}`} style="width: 33%">
        {formatter(parseFloat(String(stat ?? 0)))}
        {rank != null && (
          <small class="align-self-center" style="opacity: 50%">
            {" "}
            #{rank as Child}
          </small>
        )}
      </td>
    );
  };

  return (
    <div class="card border rounded">
      <div class="card-body">
        <div class="card-title mb-0">
          <div class="d-flex align-items-center justify-content-between">
            <h2>{location}</h2>
            <img
              class={`h2 img img-fluid me-1 team-logo-${team.id}`}
              width="50px"
              src={`https://a.espncdn.com/i/teamlogos/ncaa/500/${team.id}.png`}
            />
          </div>
        </div>
        <div class="table-responsive">
          <table class="table table-sm table-responsive">
            <thead>
              <th class="text-center" style="width: 33%">{season} Record</th>
              <th class="text-center" style="width: 33%">{season} Conf Finish</th>
              <th class="text-center" style="width: 33%">{yearPrefix}EPA/Play</th>
            </thead>
            <tbody>
              <tr>
                <td class="numeral text-center" style="width: 33%">
                  {overall}
                  {conf}
                </td>
                <td class="numeral text-center" style="width: 33%">{finish}</td>
                {cell("epaPerPlay", (n) => teamCardMarginal(n, 2, 2))}
              </tr>
            </tbody>
          </table>
        </div>
        <div class="table-responsive pe-0">
          <table class="table table-sm table-responsive">
            <caption class="text-small text-muted">
              <small>
                <p class="mb-0">
                  Stats shown as margins. AY% (available yards pct) concept from Brian Fremeau (
                  <a href="http://bcftoys.com">http://bcftoys.com</a>).
                </p>
              </small>
            </caption>
            <thead>
              <th class="text-center" style="width: 33%">{yearPrefix}Yards/Play</th>
              <th class="text-center" style="width: 33%">{yearPrefix}AY%</th>
              <th class="text-center" style="width: 33%">{yearPrefix}Success %</th>
            </thead>
            <tbody>
              <tr>
                {cell("yardsPerPlay", (n) => teamCardMarginal(n, 2, 2))}
                {cell("availableYardsPct", (n) => `${teamCardMarginal(100 * n, 2, 1)}%`)}
                {cell("successRate", (n) => `${teamCardMarginal(100 * n, 2, 1)}%`)}
              </tr>
            </tbody>
          </table>
        </div>
        {isBreakdownAvailable && !hideNavigation && (
          <a class="text-left" href={`/cfb/year/${season}/team/${team.id}`}>View full profile</a>
        )}
      </div>
    </div>
  );
};
