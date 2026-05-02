import type { FC } from "hono/jsx";
import { Layout } from "./Layout";
import {
  cleanField,
  cleanRank,
  generateColorRampValue,
  generateMarginalString,
  playerLeaderTitle,
  playerStatMinimum,
  retrieveValue,
  type PlayerLeaderboardType,
} from "../lib/leaderboard";
import type { TeamLeagueRow } from "../lib/summary";
import { CURRENT_SEASON, MIN_SEASON } from "../lib/season";

interface Props {
  players: TeamLeagueRow[];
  type: PlayerLeaderboardType | string;
  season: number;
  sort: string;
  lastUpdated: string | null;
}

// Reproduces frontend/views/pages/cfb/player_leaderboard.ejs.
// Helpers come from leaderboard.ts; the type-specific column sets
// live inline because each (passing/rushing/receiving) is shaped
// distinctly enough that abstracting them would obscure rather than
// clarify.
export const PlayerLeaderboardPage: FC<Props> = ({
  players,
  type,
  season,
  sort,
  lastUpdated,
}) => {
  const title = `${playerLeaderTitle(type)} | ${season} | Game on Paper`;
  const subtitle = `${playerLeaderTitle(type)} during the ${season} season`;
  const canonical = `https://gameonpaper.com/cfb/year/${season}/players`;
  // Player view is always descending — Express's `asc = false` line is
  // commented-out alternative logic; honor that.
  const arrowIcon = <i class="bi bi-arrow-down"></i>;
  const sortArrow = (key: string) => (sort === key ? arrowIcon : null);
  const yearOptions: number[] = [];
  for (let y = CURRENT_SEASON; y >= MIN_SEASON; y--) yearOptions.push(y);

  const darkLogoCss = `@media (prefers-color-scheme: dark) {\n${players
    .map(
      (p) =>
        `  img.team-logo-${p.teamId} { content: url('https://a.espncdn.com/i/teamlogos/ncaa/500-dark/${p.teamId}.png'); }`,
    )
    .join("\n")}\n}\nimg.team-logo-61 { content: url('/assets/img/ennui-uga.png'); }`;

  const extraHead = (
    <>
      <link href="/assets/css/bootstrap.min.css" rel="stylesheet" crossorigin="anonymous" />
      <link href="/assets/css/dashboard.css" rel="stylesheet" />
      <link href="/assets/css/blog.css" rel="stylesheet" />
      <link href="/assets/css/dark-game.css" rel="stylesheet" />
      <link href="/assets/css/bootstrap-icons/bootstrap-icons.css" rel="stylesheet" />
      <style dangerouslySetInnerHTML={{ __html: darkLogoCss }} />
    </>
  );

  const extraScripts = (
    <>
      <script src="/assets/js/date-replace.js"></script>
      <script
        dangerouslySetInnerHTML={{
          __html: `
            document.getElementById("yearSelect").addEventListener("change", function(e) {
              e.preventDefault();
              var seasonKey = document.getElementById("yearSelect").value;
              if (seasonKey != "-1" && seasonKey != -1) {
                let cleanWindowLocation = window.location.href.replace("${season}", seasonKey);
                cleanWindowLocation = cleanWindowLocation.split("?")[0];
                window.location = cleanWindowLocation;
              }
            });
            document.getElementById("sortSelect").addEventListener("change", function(e) {
              e.preventDefault();
              var sortKey = document.getElementById("sortSelect").value;
              if (sortKey != "-1" && sortKey != -1) {
                const cleanWindowLocation = window.location.href.split("?")[0];
                window.location = cleanWindowLocation + "?sort=" + sortKey;
              }
            });
            document.getElementById("typeSelect").addEventListener("change", function(e) {
              e.preventDefault();
              var typeKey = document.getElementById("typeSelect").value;
              if (typeKey != "-1" && typeKey != -1) {
                let cleanWindowLocation = window.location.href.replace("${type}", typeKey);
                cleanWindowLocation = cleanWindowLocation.split("?")[0];
                window.location = cleanWindowLocation;
              }
            });
          `,
        }}
      />
    </>
  );

  return (
    <Layout
      title={title}
      subtitle={subtitle}
      canonical={canonical}
      extraHead={extraHead}
      extraScripts={extraScripts}
    >
      <div class="container">
        <nav aria-label="breadcrumb">
          <ol class="breadcrumb">
            <li class="breadcrumb-item" aria-current="page">Seasons</li>
            <li class="breadcrumb-item" aria-current="page">
              <a href={`/cfb/year/${season}`}>{season}</a>
            </li>
            <li class="breadcrumb-item" aria-current="page">
              <a href={`/cfb/year/${season}/${type}`}>{playerLeaderTitle(type)}</a>
            </li>
          </ol>
        </nav>
      </div>
      <div class="container">
        <div class="row mb-3">
          <div class="col-lg-6 col-xs-12 mb-xs-3">
            <h2>{playerLeaderTitle(type)}</h2>
            <p class="m-0 mb-2 text-muted text-small">
              Data from <a href="https://github.com/sportsdataverse/cfbfastR">cfbfastR</a>, may differ from ESPN due to data availability/quality. Note: metrics are <strong>not</strong> adjusted for quality of opponent. To qualify,{" "}
              <span dangerouslySetInnerHTML={{ __html: playerStatMinimum(type) }} />
            </p>
            {type === "receiving" && (
              <p class="m-0 mb-2 text-muted text-small">
                <strong>Note: </strong> ESPN does not consistently mark targeted receivers for incomplete passes, which affects Catch %, EPA/target and Yards/Target averages.
              </p>
            )}
            <p class="mt-0 text-muted text-small game-context">
              Last updated: <abbr title="If this is more than one week out of date during the season, please let us know at @gameonpaper on Twitter."><span class="game-date">{lastUpdated ?? "unknown"}</span></abbr>
            </p>
          </div>
          <div class="ms-auto col-lg-6 col-xs-12">
            <form class="d-flex justify-content-lg-end justify-content-xs-start" id="dropdown-form">
              <div class="row">
                <div class="col-lg-auto mb-3">
                  <select class="form-select form-select-md" id="yearSelect">
                    <option value="-1">Choose Season...</option>
                    {yearOptions.map((yr) => (
                      <option value={String(yr)} selected={yr === season}>
                        {yr}
                      </option>
                    ))}
                  </select>
                </div>
                <div class="col-lg-auto mb-3">
                  <select class="form-select form-select-md" id="typeSelect">
                    <option value="-1">Choose Type...</option>
                    <option value="passing" selected={type === "passing"}>Passing</option>
                    <option value="rushing" selected={type === "rushing"}>Rushing</option>
                    <option value="receiving" selected={type === "receiving"}>Receiving</option>
                  </select>
                </div>
                <div class="col-lg-auto mb-3">
                  <select class="form-select form-select-md" id="sortSelect">
                    <option value="-1">Choose Sort...</option>
                    {type === "passing" && (
                      <optgroup label="Passing">
                        <option value="statistics.sackAdjustedYards" selected={sort === "statistics.sackAdjustedYards"}>Sack-Adj Yds</option>
                        <option value="advanced.totalEPA" selected={sort === "advanced.totalEPA"}>EPA</option>
                        <option value="statistics.yardsPerDropback" selected={sort === "statistics.yardsPerDropback"}>Yards/DB</option>
                        <option value="advanced.epaPerPlay" selected={sort === "advanced.epaPerPlay"}>EPA/DB</option>
                        <option value="advanced.successRate" selected={sort === "advanced.successRate"}>Pass SR%</option>
                      </optgroup>
                    )}
                    {type === "rushing" && (
                      <optgroup label="Rushing">
                        <option value="statistics.yards" selected={sort === "statistics.yards"}>Yards</option>
                        <option value="advanced.totalEPA" selected={sort === "advanced.totalEPA"}>EPA</option>
                        <option value="statistics.yardsPerPlay" selected={sort === "statistics.yardsPerPlay"}>Yards/Rush</option>
                        <option value="advanced.epaPerPlay" selected={sort === "advanced.epaPerPlay"}>EPA/Rush</option>
                        <option value="advanced.successRate" selected={sort === "advanced.successRate"}>Rush SR%</option>
                      </optgroup>
                    )}
                    {type === "receiving" && (
                      <optgroup label="Receiving">
                        <option value="statistics.yards" selected={sort === "statistics.yards"}>Yards</option>
                        <option value="advanced.totalEPA" selected={sort === "advanced.totalEPA"}>EPA</option>
                        <option value="statistics.yardsPerPlay" selected={sort === "statistics.yardsPerPlay"}>Yards/Tgt</option>
                        <option value="advanced.epaPerPlay" selected={sort === "advanced.epaPerPlay"}>EPA/Tgt</option>
                        <option value="advanced.successRate" selected={sort === "advanced.successRate"}>Rec SR%</option>
                      </optgroup>
                    )}
                  </select>
                </div>
              </div>
            </form>
          </div>
        </div>
        <div class="row mb-3">
          <div class="col-12">
            <div class="table-responsive">
              <table class="table table-sm table-responsive">
                <thead>
                  <tr>
                    <th class="text-right" colspan={1}>Rk</th>
                    <th class="text-left" colspan={1}>Player</th>
                    <th class="text-center" colspan={1}>Games</th>
                    {type === "passing" && (
                      <>
                        <th class="text-center" colspan={1}>Dropbacks {sortArrow("statistics.dropbacks")}</th>
                        <th class="text-center" colspan={1}>Sack-Adj Yds {sortArrow("statistics.sackAdjustedYards")}</th>
                        <th class="text-center" colspan={1}>EPA {sortArrow("advanced.totalEPA")}</th>
                        <th class="text-center" colspan={1}>Yards/DB {sortArrow("statistics.yardsPerDropback")}</th>
                        <th class="text-center" colspan={1}>EPA/DB {sortArrow("advanced.epaPerPlay")}</th>
                        <th class="text-center" colspan={1}>SR% {sortArrow("advanced.successRate")}</th>
                      </>
                    )}
                    {type === "rushing" && (
                      <>
                        <th class="text-center" colspan={1}>Carries {sortArrow("statistics.plays")}</th>
                        <th class="text-center" colspan={1}>Yards {sortArrow("statistics.yards")}</th>
                        <th class="text-center" colspan={1}>EPA {sortArrow("advanced.totalEPA")}</th>
                        <th class="text-center" colspan={1}>Yards/Rush {sortArrow("statistics.yardsPerPlay")}</th>
                        <th class="text-center" colspan={1}>EPA/Rush {sortArrow("advanced.epaPerPlay")}</th>
                        <th class="text-center" colspan={1}>SR% {sortArrow("advanced.successRate")}</th>
                      </>
                    )}
                    {type === "receiving" && (
                      <>
                        <th class="text-center" colspan={1}>Catches {sortArrow("statistics.catches")}</th>
                        <th class="text-center" colspan={1}>Targets {sortArrow("statistics.targets")}</th>
                        <th class="text-center" colspan={1}>Catch % {sortArrow("statistics.catchPct")}</th>
                        <th class="text-center" colspan={1}>Yards {sortArrow("statistics.yards")}</th>
                        <th class="text-center" colspan={1}>EPA {sortArrow("advanced.totalEPA")}</th>
                        <th class="text-center" colspan={1}>Yards/Tgt {sortArrow("statistics.yardsPerPlay")}</th>
                        <th class="text-center" colspan={1}>EPA/Tgt {sortArrow("advanced.epaPerPlay")}</th>
                        <th class="text-center" colspan={1}>SR% {sortArrow("advanced.successRate")}</th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {players.map((t, idx) => {
                    const cellClass = (statKey: string) => {
                      const ramp = generateColorRampValue(
                        retrieveValue(t, `${statKey}Rank`),
                        players.length,
                      );
                      return `text-center${ramp ? ` ${ramp}` : ""}`;
                    };
                    return (
                      <tr key={`${t.teamId}-${idx}`}>
                        <td class="text-right" colspan={1}>
                          {cleanRank(retrieveValue(t, `${sort}Rank`))}
                        </td>
                        <td class="text-left" colspan={1}>
                          <a href={`/cfb/year/${season}/team/${t.teamId}`}>
                            <img
                              class={`img-fluid team-logo-${t.teamId} me-2`}
                              width="20px"
                              src={`https://a.espncdn.com/i/teamlogos/ncaa/500/${t.teamId}.png`}
                              alt={`ESPN team id ${t.teamId} ${cleanField(t, "team")}`}
                              title={String(t.team)}
                            />
                            <span class="visually-hidden">{cleanField(t, "team")}</span>
                          </a>{" "}
                          <strong>{cleanField(t, "name")}</strong>
                        </td>
                        <td class="text-center" colspan={1}>
                          {generateMarginalString(retrieveValue(t, "statistics.games"), 2, 0, type)}
                        </td>
                        {type === "passing" && (
                          <>
                            <td class={cellClass("statistics.dropbacks")} colspan={1}>{generateMarginalString(retrieveValue(t, "statistics.dropbacks"), 2, 0, type)}</td>
                            <td class={cellClass("statistics.sackAdjustedYards")} colspan={1}>{generateMarginalString(retrieveValue(t, "statistics.sackAdjustedYards"), 2, 1, type)}</td>
                            <td class={cellClass("advanced.totalEPA")} colspan={1}>{generateMarginalString(retrieveValue(t, "advanced.totalEPA"), 2, 2, type)}</td>
                            <td class={cellClass("statistics.yardsPerDropback")} colspan={1}>{generateMarginalString(retrieveValue(t, "statistics.yardsPerDropback"), 2, 2, type)}</td>
                            <td class={cellClass("advanced.epaPerPlay")} colspan={1}>{generateMarginalString(retrieveValue(t, "advanced.epaPerPlay"), 2, 2, type)}</td>
                            <td class={cellClass("advanced.successRate")} colspan={1}>{generateMarginalString((retrieveValue(t, "advanced.successRate") as number) * 100, 2, 1, type)}%</td>
                          </>
                        )}
                        {type === "rushing" && (
                          <>
                            <td class={cellClass("statistics.plays")} colspan={1}>{generateMarginalString(retrieveValue(t, "statistics.plays"), 2, 0, type)}</td>
                            <td class={cellClass("statistics.yards")} colspan={1}>{generateMarginalString(retrieveValue(t, "statistics.yards"), 2, 1, type)}</td>
                            <td class={cellClass("advanced.totalEPA")} colspan={1}>{generateMarginalString(retrieveValue(t, "advanced.totalEPA"), 2, 2, type)}</td>
                            <td class={cellClass("statistics.yardsPerPlay")} colspan={1}>{generateMarginalString(retrieveValue(t, "statistics.yardsPerPlay"), 2, 2, type)}</td>
                            <td class={cellClass("advanced.epaPerPlay")} colspan={1}>{generateMarginalString(retrieveValue(t, "advanced.epaPerPlay"), 2, 2, type)}</td>
                            <td class={cellClass("advanced.successRate")} colspan={1}>{generateMarginalString((retrieveValue(t, "advanced.successRate") as number) * 100, 2, 1, type)}%</td>
                          </>
                        )}
                        {type === "receiving" && (
                          <>
                            <td class={cellClass("statistics.catches")} colspan={1}>{generateMarginalString(retrieveValue(t, "statistics.catches"), 2, 0, type)}</td>
                            <td class={cellClass("statistics.targets")} colspan={1}>{generateMarginalString(retrieveValue(t, "statistics.targets"), 2, 0, type)}</td>
                            <td class={cellClass("statistics.catchPct")} colspan={1}>{generateMarginalString((retrieveValue(t, "statistics.catchPct") as number) * 100, 2, 1, type)}%</td>
                            <td class={cellClass("statistics.yards")} colspan={1}>{generateMarginalString(retrieveValue(t, "statistics.yards"), 2, 1, type)}</td>
                            <td class={cellClass("advanced.totalEPA")} colspan={1}>{generateMarginalString(retrieveValue(t, "advanced.totalEPA"), 2, 2, type)}</td>
                            <td class={cellClass("statistics.yardsPerPlay")} colspan={1}>{generateMarginalString(retrieveValue(t, "statistics.yardsPerPlay"), 2, 2, type)}</td>
                            <td class={cellClass("advanced.epaPerPlay")} colspan={1}>{generateMarginalString(retrieveValue(t, "advanced.epaPerPlay"), 2, 2, type)}</td>
                            <td class={cellClass("advanced.successRate")} colspan={1}>{generateMarginalString((retrieveValue(t, "advanced.successRate") as number) * 100, 2, 1, type)}%</td>
                          </>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </Layout>
  );
};
