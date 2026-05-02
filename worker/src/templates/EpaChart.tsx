import type { FC } from "hono/jsx";
import { Layout } from "./Layout";
import { CURRENT_SEASON, MIN_SEASON } from "../lib/season";

export interface EpaChartTeam {
  teamId: number | string;
  team: string;
  fbsClass: string;
  adjOffEpa: number | null | undefined;
  adjDefEpa: number | null | undefined;
}

interface Props {
  teams: EpaChartTeam[];
  season: number;
  lastUpdated: string | null;
}

export const EpaChartPage: FC<Props> = ({ teams, season, lastUpdated }) => {
  const leaderTitleText = "Adj EPA/Play Comparison";
  const title = `${leaderTitleText} | ${season} | Game on Paper`;
  const subtitle = `${leaderTitleText} during the ${season} season`;
  const canonical = `https://gameonpaper.com/cfb/year/${season}/charts/team/epa`;
  const yearOptions: number[] = [];
  for (let y = CURRENT_SEASON; y >= MIN_SEASON; y--) yearOptions.push(y);

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

  // Two charts: P4/P5 (top conference tier) and G6/G5 (everyone else).
  // The 2024+ split is P4/G6 (after big-conf realignment); pre-2024
  // is P5/G5. Logic preserved verbatim from epa_chart.ejs:117-141.
  const extraScripts = (
    <>
      <script src="/assets/js/date-replace.js"></script>
      <script src="/assets/js/feather.min.js" crossorigin="anonymous"></script>
      <script src="/assets/js/Chart.min.js" crossorigin="anonymous"></script>
      <script src="/assets/js/common.js" crossorigin="anonymous"></script>
      <script src="/assets/js/epa_chart.js" crossorigin="anonymous"></script>
      <script
        dangerouslySetInnerHTML={{
          __html: `
            const teams = ${JSON.stringify(teams)};
            (function() {
              'use strict';
              feather.replace();
              const season = ${season};
              if (season >= 2024) {
                const p4 = teams.filter(t => t.adjOffEpa && t.adjDefEpa && t.fbsClass == 'P4');
                const g6 = teams.filter(t => t.adjOffEpa && t.adjDefEpa && t.fbsClass != 'P4');
                new Chart(document.getElementById('p4_chart_canvas'), generateConfig("Opponent Adjusted EPA/Play (P4) - " + season, p4));
                new Chart(document.getElementById('g6_chart_canvas'), generateConfig("Opponent Adjusted EPA/Play (G6) - " + season, g6));
              } else {
                const p5 = teams.filter(t => t.adjOffEpa && t.adjDefEpa && t.fbsClass == 'P5');
                const g5 = teams.filter(t => t.adjOffEpa && t.adjDefEpa && t.fbsClass != 'P5');
                new Chart(document.getElementById('p4_chart_canvas'), generateConfig("Opponent Adjusted EPA/Play (P5) - " + season, p5));
                new Chart(document.getElementById('g6_chart_canvas'), generateConfig("Opponent Adjusted EPA/Play (G5) - " + season, g5));
              }
            })();
          `,
        }}
      />
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
            <li class="breadcrumb-item" aria-current="page">Charts</li>
            <li class="breadcrumb-item" aria-current="page">
              <a href={`/cfb/year/${season}/charts/team/epa`}>{leaderTitleText}</a>
            </li>
          </ol>
        </nav>
      </div>
      <div class="container">
        <div class="row mb-3">
          <div class="col-lg-6 col-xs-12 mb-xs-3">
            <h2>{leaderTitleText}</h2>
            <p class="m-0 mb-2 text-muted text-small">
              Data from <a href="https://github.com/sportsdataverse/cfbfastR">cfbfastR</a>, may differ from ESPN due to data availability/quality.
            </p>
            <p class="m-0 mb-2 text-muted text-small">
              Adj EPA/Play methodology adapted from <a href="https://makennnahack.github.io/makenna-hack.github.io/publications/opp_adj_rank_project/">this article</a> by <a href="https://twitter.com/makennnahack">Makenna Hack</a> and <a href="https://blog.collegefootballdata.com/opponent-adjusted-stats-ridge-regression/">this article</a> from <a href="https://twitter.com/jbuddavis">Bud Davis</a>, accounting for home-field advantage, quality of opponent, and garbage time. Only considers FBS vs FBS games -- FBS teams that have not played FBS opponents are at the bottom.
            </p>
            <p class="m-0 mb-2 text-muted text-small">
              <strong>Warning: </strong>This page is best viewed on desktop.
            </p>
            <p class="mt-0 text-muted text-small game-context">
              Last updated: <abbr title="If this is more than one week out of date during the season, please let us know at @gameonpaper on Twitter."><span class="game-date">{lastUpdated ?? "unknown"}</span></abbr>
            </p>
          </div>
          <div class="ms-auto col-lg-6 col-xs-12">
            <form class="mb-3 d-flex justify-content-lg-end justify-content-xs-start" id="dropdown-form">
              <div class="row">
                <div class="col-lg-auto">
                  <select class="form-select form-select-md" id="yearSelect">
                    <option value="-1">Choose Season...</option>
                    {yearOptions.map((yr) => (
                      <option value={String(yr)} selected={yr === season}>
                        {yr}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </form>
          </div>
        </div>
      </div>
      <div class="container">
        <div class="row mb-3">
          <div class="col-12">
            <canvas
              id="p4_chart_canvas"
              style="display: block; box-sizing: border-box; height: 1200px; width: 800px;"
              width="1200"
              height="800"
            ></canvas>
          </div>
        </div>
        <div class="row mb-3">
          <div class="col-12">
            <canvas
              id="g6_chart_canvas"
              style="display: block; box-sizing: border-box; height: 1200px; width: 800px;"
              width="1200"
              height="800"
            ></canvas>
          </div>
        </div>
      </div>
    </Layout>
  );
};
