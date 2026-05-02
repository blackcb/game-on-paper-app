import type { FC } from "hono/jsx";
import { Layout } from "./Layout";
import {
  cleanField,
  cleanRank,
  generateColorRampValue,
  generateMarginalString,
  leaderTitle,
  retrieveValue,
  type LeaderboardType,
} from "../lib/leaderboard";
import type { TeamLeagueRow } from "../lib/summary";
import { MIN_SEASON, CURRENT_SEASON } from "../lib/season";

interface Props {
  teams: TeamLeagueRow[];
  type: LeaderboardType | string;
  season: number;
  sort: string;
  lastUpdated: string | null;
}

// Reproduces frontend/views/pages/cfb/leaderboard.ejs. The four-second
// "all teams + 12 stat columns" table is the heaviest part; everything
// else (breadcrumb, dropdowns, last-updated abbr) is straightforward.
export const LeaderboardPage: FC<Props> = ({
  teams,
  type,
  season,
  sort,
  lastUpdated,
}) => {
  const title = `${leaderTitle(type)} | ${season} | Game on Paper`;
  const subtitle = `${leaderTitle(type)} during the ${season} season`;
  const canonical = `https://gameonpaper.com/cfb/year/${season}/teams`;
  const isOffOrDef = type === "offensive" || type === "defensive";

  // Direction arrow on the active-sort column header. Defensive
  // (non-havoc) and offensive havoc are ascending → up arrow. Mirrors
  // leaderboard.ejs:208-211.
  const ascending =
    (type === "defensive" && sort !== "overall.havocRate") ||
    (type === "offensive" && sort === "overall.havocRate");
  const arrowIcon = (
    <i class={ascending ? "bi bi-arrow-up" : "bi bi-arrow-down"}></i>
  );
  const sortArrow = (key: string) => (sort === key ? arrowIcon : null);

  const yearOptions: number[] = [];
  for (let y = CURRENT_SEASON; y >= MIN_SEASON; y--) yearOptions.push(y);

  // Per-team dark-mode logo CSS. The EJS version emits one rule per
  // team inside a single @media block; preserved verbatim.
  const darkLogoCss = `@media (prefers-color-scheme: dark) {\n${teams
    .map(
      (t) =>
        `  img.team-logo-${t.teamId} { content: url('https://a.espncdn.com/i/teamlogos/ncaa/500-dark/${t.teamId}.png'); }`,
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
                if (typeKey == "differential" && (!cleanWindowLocation.includes("overall") || cleanWindowLocation.includes("havocRate"))) {
                  cleanWindowLocation = cleanWindowLocation.split("?")[0];
                }
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
              <a href={`/cfb/year/${season}/${type}`}>{leaderTitle(type)}</a>
            </li>
          </ol>
        </nav>
      </div>
      <div class="container">
        <div class="row mb-3">
          <div class="col-lg-6 col-xs-12 mb-xs-3">
            <h2>{leaderTitle(type)}</h2>
            <p class="m-0 mb-2 text-muted text-small">
              Data from <a href="https://github.com/sportsdataverse/cfbfastR">cfbfastR</a>, may differ from ESPN due to data availability/quality. Note: other than for Adj EPA/Play, metrics are <strong>not</strong> adjusted for quality of opponent or garbage time.
            </p>
            <p class="m-0 mb-2 text-muted text-small">
              Adj EPA/Play methodology adapted from <a href="https://makennnahack.github.io/makenna-hack.github.io/publications/opp_adj_rank_project/">this article</a> by <a href="https://twitter.com/makennnahack">Makenna Hack</a> and <a href="https://blog.collegefootballdata.com/opponent-adjusted-stats-ridge-regression/">this article</a> from <a href="https://twitter.com/jbuddavis">Bud Davis</a>, accounting for home-field advantage, quality of opponent, and garbage time. Only considers FBS vs FBS games -- as a result, adj EPA/Play and normal EPA/Play numbers may differ significantly until all teams have played multiple FBS vs FBS games. FBS teams that have not played FBS opponents are at the bottom.
            </p>
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
                    <option value="differential" selected={type === "differential"}>Net Statistics</option>
                    <option value="offensive" selected={type === "offensive"}>Offensive</option>
                    <option value="defensive" selected={type === "defensive"}>Defensive</option>
                  </select>
                </div>
                <div class="col-lg-auto mb-3">
                  <select class="form-select form-select-md" id="sortSelect">
                    <option value="-1">Choose Sort...</option>
                    <optgroup label="Overall">
                      <option value="overall.adjEpaPerPlay" selected={sort === "overall.adjEpaPerPlay"}>Adj EPA/Play</option>
                      <option value="overall.epaPerPlay" selected={sort === "overall.epaPerPlay"}>EPA/Play</option>
                      <option value="overall.yardsPerPlay" selected={sort === "overall.yardsPerPlay"}>Yards/Play</option>
                      <option value="overall.successRate" selected={sort === "overall.successRate"}>SR%</option>
                    </optgroup>
                    {isOffOrDef && (
                      <>
                        <optgroup label="Passing">
                          <option value="passing.epaPerPlay" selected={sort === "passing.epaPerPlay"}>EPA/DB</option>
                          <option value="passing.yardsPerPlay" selected={sort === "passing.yardsPerPlay"}>Yards/DB</option>
                          <option value="passing.successRate" selected={sort === "passing.successRate"}>Pass SR%</option>
                        </optgroup>
                        <optgroup label="Rushing">
                          <option value="rushing.epaPerPlay" selected={sort === "rushing.epaPerPlay"}>EPA/Rush</option>
                          <option value="rushing.yardsPerPlay" selected={sort === "rushing.yardsPerPlay"}>Yards/Rush</option>
                          <option value="rushing.successRate" selected={sort === "rushing.successRate"}>Rush SR%</option>
                        </optgroup>
                        <optgroup label="Other">
                          <option value="overall.havocRate" selected={sort === "overall.havocRate"}>Havoc %</option>
                        </optgroup>
                      </>
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
                    <th class="text-left" colspan={1}>Team</th>
                    <th class="text-center" colspan={1}>
                      <abbr title="Accounts for home-field advantange, accounting for home-field advantage, quality of opponent, and garbage time in FBS vs FBS games.">Adj EPA/Play</abbr>{" "}
                      {sortArrow("overall.adjEpaPerPlay")}
                    </th>
                    <th class="text-center" colspan={1}>EPA/Play {sortArrow("overall.epaPerPlay")}</th>
                    <th class="text-center" colspan={1}>Yards/Play {sortArrow("overall.yardsPerPlay")}</th>
                    <th class="text-center" colspan={1}>SR% {sortArrow("overall.successRate")}</th>
                    {isOffOrDef && (
                      <>
                        <th class="text-center" colspan={1}>
                          <abbr title="DB: Dropbacks, includes pass attempts and sacks.">EPA/DB</abbr>{" "}
                          {sortArrow("passing.epaPerPlay")}
                        </th>
                        <th class="text-center" colspan={1}>
                          <abbr title="DB: Dropbacks, includes pass attempts and sacks.">Yards/DB</abbr>{" "}
                          {sortArrow("passing.yardsPerPlay")}
                        </th>
                        <th class="text-center" colspan={1}>Pass SR% {sortArrow("passing.successRate")}</th>
                        <th class="text-center" colspan={1}>EPA/Rush {sortArrow("rushing.epaPerPlay")}</th>
                        <th class="text-center" colspan={1}>Yards/Rush {sortArrow("rushing.yardsPerPlay")}</th>
                        <th class="text-center" colspan={1}>Rush SR% {sortArrow("rushing.successRate")}</th>
                        <th class="text-center" colspan={1}>Havoc % {sortArrow("overall.havocRate")}</th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {teams.map((t) => {
                    const adjValue = retrieveValue(t, "overall.adjEpaPerPlay");
                    const adjStr = generateMarginalString(adjValue, 2, 2, type as LeaderboardType);
                    const adjEPAStr =
                      adjStr === "N/A" ? (
                        <abbr title="This team may not have played an FBS opponent yet. This value and their rank will be updated when they do.">N/A</abbr>
                      ) : (
                        adjStr
                      );

                    const rankRaw = cleanRank(retrieveValue(t, `${sort}Rank`));
                    const rankStr =
                      rankRaw === "N/A" && sort === "overall.adjEpaPerPlay" ? (
                        <abbr title="This team may not have played an FBS opponent yet. This value and their rank will be updated when they do.">N/A</abbr>
                      ) : (
                        rankRaw
                      );

                    const cellClass = (statKey: string) => {
                      const ramp = generateColorRampValue(
                        retrieveValue(t, `${statKey}Rank`),
                        teams.length,
                      );
                      return `text-center${ramp ? ` ${ramp}` : ""}`;
                    };

                    return (
                      <tr key={String(t.teamId)}>
                        <td class="text-right" colspan={1}>{rankStr}</td>
                        <td class="text-left" colspan={1}>
                          <a href={`/cfb/year/${season}/team/${t.teamId}`}>
                            <img
                              class={`img-fluid team-logo-${t.teamId} me-2`}
                              width="20px"
                              src={`https://a.espncdn.com/i/teamlogos/ncaa/500/${t.teamId}.png`}
                              alt={`ESPN team id ${t.teamId}`}
                            />
                            <strong>{cleanField(t, "team")}</strong>
                          </a>
                        </td>
                        <td class={cellClass("overall.adjEpaPerPlay")} colspan={1}>{adjEPAStr}</td>
                        <td class={cellClass("overall.epaPerPlay")} colspan={1}>
                          {generateMarginalString(retrieveValue(t, "overall.epaPerPlay"), 2, 2, type as LeaderboardType)}
                        </td>
                        <td class={cellClass("overall.yardsPerPlay")} colspan={1}>
                          {generateMarginalString(retrieveValue(t, "overall.yardsPerPlay"), 2, 2, type as LeaderboardType)}
                        </td>
                        <td class={cellClass("overall.successRate")} colspan={1}>
                          {generateMarginalString(
                            (retrieveValue(t, "overall.successRate") as number) * 100,
                            2,
                            1,
                            type as LeaderboardType,
                          )}
                          %
                        </td>
                        {isOffOrDef && (
                          <>
                            <td class={cellClass("passing.epaPerPlay")} colspan={1}>
                              {generateMarginalString(retrieveValue(t, "passing.epaPerPlay"), 2, 2, type as LeaderboardType)}
                            </td>
                            <td class={cellClass("passing.yardsPerPlay")} colspan={1}>
                              {generateMarginalString(retrieveValue(t, "passing.yardsPerPlay"), 2, 2, type as LeaderboardType)}
                            </td>
                            <td class={cellClass("passing.successRate")} colspan={1}>
                              {generateMarginalString(
                                (retrieveValue(t, "passing.successRate") as number) * 100,
                                2,
                                1,
                                type as LeaderboardType,
                              )}
                              %
                            </td>
                            <td class={cellClass("rushing.epaPerPlay")} colspan={1}>
                              {generateMarginalString(retrieveValue(t, "rushing.epaPerPlay"), 2, 2, type as LeaderboardType)}
                            </td>
                            <td class={cellClass("rushing.yardsPerPlay")} colspan={1}>
                              {generateMarginalString(retrieveValue(t, "rushing.yardsPerPlay"), 2, 2, type as LeaderboardType)}
                            </td>
                            <td class={cellClass("rushing.successRate")} colspan={1}>
                              {generateMarginalString(
                                (retrieveValue(t, "rushing.successRate") as number) * 100,
                                2,
                                1,
                                type as LeaderboardType,
                              )}
                              %
                            </td>
                            <td class={cellClass("overall.havocRate")} colspan={1}>
                              {generateMarginalString(
                                (retrieveValue(t, "overall.havocRate") as number) * 100,
                                2,
                                1,
                                type as LeaderboardType,
                              )}
                              %
                            </td>
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
