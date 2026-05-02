import type { FC } from "hono/jsx";
import { Layout } from "./Layout";
import { cleanLocation, hexToRgb } from "../lib/team_helpers";

export { hexToRgb } from "../lib/team_helpers";

// Reproduces frontend/views/pages/cfb/team.ejs. Multi-season team
// page: metric-history line chart (Chart.js) plus season-selectable
// offensive/defensive radar pair. The heavy lifting is client-side —
// this component just inlines the data + config for team_chart.js
// and radar.js to render against.

export interface TeamData {
  id: string | number;
  location?: string;
  color?: string;
  alternateColor?: string;
  [key: string]: unknown;
}

interface Props {
  teamData: TeamData;
  breakdowns: Array<Record<string, unknown> & { season: number | string }>;
  seasons: number[]; // chronological (low → high)
  percentiles: Array<{
    season: number | string;
    pctile: number | string;
    value: number;
  }>;
  type: string;
  metric: string;
  lastUpdated: string | null;
}

export const TeamPage: FC<Props> = ({
  teamData,
  breakdowns,
  seasons,
  percentiles,
  type,
  metric,
  lastUpdated,
}) => {
  const location = cleanLocation({ id: teamData.id, location: teamData.location });
  const yearRange =
    seasons.length > 1 ? `${seasons[0]} to ${seasons[seasons.length - 1]}` : `${seasons[0] ?? ""}`;
  const title = `${location} | ${yearRange} | Game on Paper`;
  const subtitle = `${location} history`;
  const canonical = `https://gameonpaper.com/cfb/team/${teamData.id}`;

  // Reversed for the dropdown (most recent first); use a copy to keep
  // `seasons` chronological for callers/tests.
  const reversedSeasons = [...seasons].reverse();
  const newestSeason = reversedSeasons[0];

  const isOffOrDef = type === "offensive" || type === "defensive";

  // Per-team dark-mode logo CSS — same shape as Leaderboard.tsx but
  // for a single team plus the Georgia (61) UGA-ennui override.
  const darkLogoCss = `@media (prefers-color-scheme: dark) {
  img.team-logo-${teamData.id} { content: url('https://a.espncdn.com/i/teamlogos/ncaa/500-dark/${teamData.id}.png'); }
}
img.team-logo-61 { content: url('/assets/img/ennui-uga.png'); }`;

  const description = `Advanced stats for ${subtitle} (${yearRange})`;

  const extraHead = (
    <>
      <link href="/assets/css/bootstrap.min.css" rel="stylesheet" crossorigin="anonymous" />
      <link href="/assets/css/dashboard.css" rel="stylesheet" />
      <link href="/assets/css/blog.css" rel="stylesheet" />
      <link href="/assets/css/dark-game.css" rel="stylesheet" />
      <link href="/assets/css/bootstrap-icons/bootstrap-icons.css" rel="stylesheet" />
      <meta name="description" content={description} />
      <meta property="og:image" content={`https://a.espncdn.com/i/teamlogos/ncaa/500-dark/${teamData.id}.png`} />
      <meta property="og:image:width" content="512" />
      <meta property="og:image:height" content="512" />
      <style dangerouslySetInnerHTML={{ __html: darkLogoCss }} />
    </>
  );

  // Bootstrap inline data + chart bootstrapping. The trailing two
  // <script> blocks together reproduce the team.ejs body scripts —
  // we keep them inline (rather than emitting a JSON island) because
  // generateTeamChartConfig and generateConfig/generateDataset live
  // in unmodified /assets/js files that read these globals.
  const primRgb = JSON.stringify(hexToRgb(teamData.color ?? null));
  const altRgb = JSON.stringify(hexToRgb(teamData.alternateColor ?? "#000000"));
  const breakdownsJson = JSON.stringify(breakdowns);
  const percentilesJson = JSON.stringify(percentiles);
  const teamColor = `#${teamData.color ?? "000000"}`;
  const teamAltColor = teamData.alternateColor ?? "#000000";

  const extraScripts = (
    <>
      <script src="/assets/js/date-replace.js"></script>
      <script
        dangerouslySetInnerHTML={{
          __html: `
            document.getElementById("metricSelect").addEventListener("change", function(e) {
              e.preventDefault();
              var sortKey = document.getElementById("metricSelect").value;
              if (sortKey != "-1" && sortKey != -1) {
                const cleanWindowLocation = window.location.href.split("?")[0];
                window.location = cleanWindowLocation + "?metric=" + sortKey + "&type=${type}";
              }
            });
            document.getElementById("typeSelect").addEventListener("change", function(e) {
              e.preventDefault();
              var typeKey = document.getElementById("typeSelect").value;
              if (typeKey != "-1" && typeKey != -1) {
                const cleanWindowLocation = window.location.href.split("?")[0];
                window.location = cleanWindowLocation + "?metric=${metric}&type=" + typeKey;
              }
            });
          `,
        }}
      ></script>
      <script src="/assets/js/feather.min.js" crossorigin="anonymous"></script>
      <script src="/assets/js/Chart.min.js" crossorigin="anonymous"></script>
      <script src="/assets/js/d3-regression.min.js" crossorigin="anonymous"></script>
      <script src="/assets/js/common.js" crossorigin="anonymous"></script>
      <script src="/assets/js/Chart.BoxPlot.min.js" crossorigin="anonymous"></script>
      <script src="/assets/js/team_chart.js" crossorigin="anonymous"></script>
      <script
        dangerouslySetInnerHTML={{
          __html: `
            const prim = JSON.parse('${primRgb}');
            const alt = JSON.parse('${altRgb}');
            const breakdowns = ${breakdownsJson}.map(b => ({
              ...b,
              teamName: ${JSON.stringify(location)},
              alternateColor: ${JSON.stringify(teamAltColor)},
              color: ${JSON.stringify(teamData.color ?? "")}
            }));
          `,
        }}
      ></script>
      <script
        dangerouslySetInnerHTML={{
          __html: `
            const percentiles = ${percentilesJson};
            const color = ${JSON.stringify(teamColor)};
            (function() {
              'use strict';
              feather.replace();
              const teamChart = new Chart(
                document.getElementById('metric_chart_canvas'),
                generateTeamChartConfig(${JSON.stringify(location)}, color, breakdowns, percentiles, ${JSON.stringify(type)}, ${JSON.stringify(metric)})
              );
            })();
          `,
        }}
      ></script>
      <script src="/assets/js/radar.js" crossorigin="anonymous"></script>
      <script
        dangerouslySetInnerHTML={{
          __html: `
            const offRadarCtx = document.getElementById('offensive-canvas');
            const defRadarCtx = document.getElementById('defensive-canvas');

            let offRadarChart;
            let defRadarChart;

            function redrawRadars(season) {
              const selectedBreakdown = breakdowns.find(b => parseInt(b.season) == parseInt(season));
              if (selectedBreakdown) {
                console.log('redrawing radars for season ' + season);

                if (offRadarChart) offRadarChart?.destroy();
                offRadarChart = new Chart(
                  offRadarCtx,
                  generateConfig(
                    generateDataset([selectedBreakdown], "Offensive"),
                    ${JSON.stringify(location)} + ' ' + season + ' Offensive Profile'
                  )
                );

                if (defRadarChart) defRadarChart?.destroy();
                defRadarChart = new Chart(
                  defRadarCtx,
                  generateConfig(
                    generateDataset([selectedBreakdown], "Defensive"),
                    ${JSON.stringify(location)} + ' ' + season + ' Defensive Profile'
                  )
                );
              }
            }

            document.getElementById("radarSeasonSelect").addEventListener("change", function(e) {
              e.preventDefault();
              const season = document.getElementById("radarSeasonSelect").value;
              redrawRadars(season);
            });

            redrawRadars(${newestSeason ?? "null"});
          `,
        }}
      ></script>
    </>
  );

  const radarWidth = 400;
  const radarHalf = radarWidth / 2;

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
            <li class="breadcrumb-item" aria-current="page">
              <a href="/cfb/teams">Teams</a>
            </li>
            <li class="breadcrumb-item active" aria-current="page">{location}</li>
          </ol>
        </nav>
      </div>
      <div class="container">
        <div class="row mb-3">
          <div class="col-lg-6 col-xs-12 mb-xs-3">
            <h1>
              {location}{" "}
              <span class="d-inline text-muted h6">
                <small>
                  {" "}
                  <abbr title="Please report any issues/feedback to @gameonpaper.com on Bluesky!">(Beta)</abbr>
                </small>
              </span>
            </h1>
            <p class="m-0 text-muted">
              <strong>Available Seasons:</strong> {yearRange}
            </p>
            <p class="m-0 text-muted text-small game-context">
              Last updated:{" "}
              <abbr title="If this is more than one week out of date during the season, please let us know at @gameonpaper on Twitter.">
                <span class="game-date">{lastUpdated ?? "unknown"}</span>
              </abbr>
            </p>
          </div>
          <div class="col-lg-6 col-xs-12 mb-xs-3">
            <p class="m-0 mb-2 text-muted text-small">
              Data from <a href="https://github.com/sportsdataverse/cfbfastR">cfbfastR</a>, may differ from ESPN due to data availability/quality. Note: other than for Adj EPA/Play, metrics are <strong>not</strong> adjusted for quality of opponent or garbage time.
            </p>
            <p class="m-0 mb-2 text-muted text-small">
              Adj EPA/Play methodology adapted from <a href="https://makennnahack.github.io/makenna-hack.github.io/publications/opp_adj_rank_project/">this article</a> by <a href="https://twitter.com/makennnahack">Makenna Hack</a> and <a href="https://blog.collegefootballdata.com/opponent-adjusted-stats-ridge-regression/">this article</a> from <a href="https://twitter.com/jbuddavis">Bud Davis</a>, accounting for home-field advantage, quality of opponent, and garbage time. Only considers FBS vs FBS games -- as a result, adj EPA/Play and normal EPA/Play numbers may differ significantly until all teams have played multiple FBS vs FBS games.
            </p>
          </div>
        </div>
      </div>
      <div class="container">
        <div class="row mb-3">
          <div class="col-lg-6 col-xs-12">
            <h2 id="metricHistory" class="d-inline">Metric History</h2>
            <p class="text-small text-muted">Data shown is from FBS vs FBS games only.</p>
          </div>
          <div class="ms-auto col-lg-6 col-xs-12">
            <form class="d-flex justify-content-lg-end justify-content-xs-start" id="dropdown-form">
              <div class="row">
                <div class="col-lg-auto mb-3">
                  <select class="form-select form-select-md" id="typeSelect">
                    <option value="-1">Choose Type...</option>
                    <option value="differential" selected={type === "differential"}>Net Statistics</option>
                    <option value="offensive" selected={type === "offensive"}>Offensive</option>
                    <option value="defensive" selected={type === "defensive"}>Defensive</option>
                  </select>
                </div>
                <div class="col-lg-auto mb-3">
                  <select class="form-select form-select-md" id="metricSelect">
                    <option value="-1">Choose Metric...</option>
                    <optgroup label="Overall">
                      <option value="overall.adjEpaPerPlay" selected={metric === "overall.adjEpaPerPlay"}>Adj EPA/Play</option>
                      <option value="overall.epaPerPlay" selected={metric === "overall.epaPerPlay"}>EPA/Play</option>
                      <option value="overall.yardsPerPlay" selected={metric === "overall.yardsPerPlay"}>Yards/Play</option>
                      <option value="overall.successRate" selected={metric === "overall.successRate"}>SR%</option>
                    </optgroup>
                    {isOffOrDef && (
                      <>
                        <optgroup label="Passing">
                          <option value="passing.epaPerPlay" selected={metric === "passing.epaPerPlay"}>EPA/DB</option>
                          <option value="passing.yardsPerPlay" selected={metric === "passing.yardsPerPlay"}>Yards/DB</option>
                          <option value="passing.successRate" selected={metric === "passing.successRate"}>Pass SR%</option>
                          <option value="passing.explosiveRate" selected={metric === "passing.explosiveRate"}>Pass Expl %</option>
                        </optgroup>
                        <optgroup label="Rushing">
                          <option value="rushing.epaPerPlay" selected={metric === "rushing.epaPerPlay"}>EPA/Rush</option>
                          <option value="rushing.yardsPerPlay" selected={metric === "rushing.yardsPerPlay"}>Yards/Rush</option>
                          <option value="rushing.successRate" selected={metric === "rushing.successRate"}>Rush SR%</option>
                          <option value="rushing.explosiveRate" selected={metric === "rushing.explosiveRate"}>Rush Expl %</option>
                          <option value="rushing.opportunityRate" selected={metric === "rushing.opportunityRate"}>Opportunity %</option>
                          <option value="rushing.lineYards" selected={metric === "rushing.lineYards"}>Line Yards</option>
                          <option value="rushing.stuffedPlayRate" selected={metric === "rushing.stuffedPlayRate"}>Stuffed %</option>
                        </optgroup>
                        <optgroup label="Other">
                          <option value="overall.havocRate" selected={metric === "overall.havocRate"}>Havoc %</option>
                          <option value="overall.explosiveRate" selected={metric === "overall.explosiveRate"}>Explosive %</option>
                          <option value="overall.nonExplosiveEpaPerPlay" selected={metric === "overall.nonExplosiveEpaPerPlay"}>Non-Expl EPA/Play</option>
                          <option value="overall.earlyDownEPAPerPlay" selected={metric === "overall.earlyDownEPAPerPlay"}>Early Downs EPA/Play</option>
                          <option value="overall.lateDownSuccessRate" selected={metric === "overall.lateDownSuccessRate"}>Late Downs SR%</option>
                          <option value="overall.thirdDownDistance" selected={metric === "overall.thirdDownDistance"}>Avg Distance (3rd)</option>
                        </optgroup>
                      </>
                    )}
                  </select>
                </div>
              </div>
            </form>
          </div>
        </div>
        <canvas
          id="metric_chart_canvas"
          class="mb-3"
          style="display: block; box-sizing: border-box; height: 1200px; width: 800px;"
          width="1200"
          height="800"
        ></canvas>
      </div>
      <div class="container">
        <div class="row mb-3">
          <div class="col-lg-6 col-xs-12">
            <h2 id="radarHistory" class="d-inline">Profile History</h2>
            <p class="text-small text-muted">
              Data shown is from FBS vs FBS games only. Based on{" "}
              <a href="https://twitter.com/ESPN_BillC">Bill Connelly</a>'s team profile radars (
              <a href="https://www.sbnation.com/college-football/2018/7/16/17532360/georgia-tech-football-2018-preview-schedule-roster">example</a>
              ).
            </p>
          </div>
          <div class="ms-auto col-lg-2 col-xs-12">
            <select class="form-select form-select-md" id="radarSeasonSelect">
              <option value="-1">Choose Season...</option>
              {reversedSeasons.map((yr, i) => (
                <option value={String(yr)} selected={i === 0}>
                  {yr}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div class="row mb-3">
          <div class="col-lg-6 col-xs-12 mb-xs-3">
            <canvas
              id="offensive-canvas"
              style={`display: block; box-sizing: border-box; height: ${radarHalf}px; width: ${radarHalf}px;`}
              width={String(radarWidth)}
              height={String(radarWidth)}
            ></canvas>
          </div>
          <div class="col-lg-6 col-xs-12 mb-xs-3">
            <canvas
              id="defensive-canvas"
              style={`display: block; box-sizing: border-box; height: ${radarHalf}px; width: ${radarHalf}px;`}
              width={String(radarWidth)}
              height={String(radarWidth)}
            ></canvas>
          </div>
        </div>
      </div>
    </Layout>
  );
};
