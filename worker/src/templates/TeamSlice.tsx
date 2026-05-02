import type { FC } from "hono/jsx";
import {
  buildSliceCells,
  STAT_KEY_TITLE_MAPPING,
  TEAM_SLICE_COLUMNS,
  type SliceSituation,
  type SliceTarget,
} from "../lib/team_helpers";

// Reproduces frontend/views/partials/team_slice.ejs. Used by the
// per-season team page (single team in `breakdown`) and the matchup
// partial (two teams in `breakdown`, with `showTeamLogos` so the
// header row carries each team's logo).

interface TeamSliceTeam {
  id?: string | number;
  [key: string]: unknown;
}

interface TeamSliceProps {
  breakdown: Array<Record<string, unknown>>;
  title: string;
  target: SliceTarget;
  situation: SliceSituation;
  // Matchup variant only — passes the two ESPN team objects so the
  // table header can surface their logos (team_slice.ejs:121-129).
  showTeamLogos?: boolean;
  homeTeam?: TeamSliceTeam;
  awayTeam?: TeamSliceTeam;
}

export const TeamSlice: FC<TeamSliceProps> = ({
  breakdown,
  title,
  target,
  situation,
  showTeamLogos = false,
  homeTeam,
  awayTeam,
}) => {
  const columns = TEAM_SLICE_COLUMNS[target][situation];
  const widthPct = showTeamLogos && homeTeam && awayTeam ? 33 : 50;

  return (
    <div class="table-responsive">
      <table class="table table-sm table-responsive">
        <thead>
          <tr>
            <th style={`text-align: left; width: ${widthPct}%;`}>{title}</th>
            {showTeamLogos && homeTeam && awayTeam ? (
              breakdown.map((group) => {
                const groupTeamId = (group as { teamId?: string | number }).teamId;
                const matchedId =
                  String(groupTeamId) === String(homeTeam.id) ? homeTeam.id : awayTeam.id;
                return (
                  <th style="text-align: center;">
                    <img
                      class={`img-fluid team-logo-${matchedId}`}
                      width="35px"
                      src={`https://a.espncdn.com/i/teamlogos/ncaa/500/${matchedId}.png`}
                      alt={`ESPN team id ${groupTeamId}`}
                    />
                  </th>
                );
              })
            ) : (
              <th style={`width: ${widthPct}%`}>
                <span hidden>Value</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {columns.map((item) => {
            const cells = buildSliceCells(item, breakdown, target, situation);
            return (
              <tr>
                <td style={`text-align: left; width: ${widthPct}%;`}>
                  {STAT_KEY_TITLE_MAPPING[item] ?? item}
                </td>
                {cells.map((c) =>
                  c == null ? (
                    <td class="numeral" style={`text-align: center;width: ${widthPct}%;`}>
                      N/A{" "}
                      <small class="align-self-center" style="opacity: 50%">
                        {" "}
                        N/A
                      </small>
                    </td>
                  ) : (
                    <td
                      class={`align-self-center numeral${c.colorClass ? ` ${c.colorClass}` : ""}`}
                      style={`text-align: center;width: ${widthPct}%;`}
                    >
                      {c.sign}
                      {c.text}
                      {c.rankString && (
                        <small class="align-self-center" style="opacity: 50%">
                          {c.rankString}
                        </small>
                      )}
                    </td>
                  ),
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};
