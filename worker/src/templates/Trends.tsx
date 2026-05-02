import type { FC } from "hono/jsx";
import { Layout } from "./Layout";

interface TrendPoint {
  season: number;
  pctile: number | string;
  value: unknown;
}

interface Props {
  seasons: number[];
  percentiles: TrendPoint[];
  type: string;
  metric: string;
  lastUpdated: string | null;
}

const METRIC_OPTIONS_OFF_DEF: Array<{ value: string; label: string; group: string }> = [
  { group: "Passing", value: "passing.epaPerPlay", label: "EPA/DB" },
  { group: "Passing", value: "passing.yardsPerPlay", label: "Yards/DB" },
  { group: "Passing", value: "passing.successRate", label: "Pass SR%" },
  { group: "Passing", value: "passing.explosiveRate", label: "Pass Expl %" },
  { group: "Rushing", value: "rushing.epaPerPlay", label: "EPA/Rush" },
  { group: "Rushing", value: "rushing.yardsPerPlay", label: "Yards/Rush" },
  { group: "Rushing", value: "rushing.successRate", label: "Rush SR%" },
  { group: "Rushing", value: "rushing.explosiveRate", label: "Rush Expl %" },
  { group: "Rushing", value: "rushing.opportunityRate", label: "Opportunity %" },
  { group: "Rushing", value: "rushing.lineYards", label: "Line Yards" },
  { group: "Rushing", value: "rushing.stuffedPlayRate", label: "Stuffed %" },
  { group: "Other", value: "overall.havocRate", label: "Havoc %" },
  { group: "Other", value: "overall.explosiveRate", label: "Explosive %" },
  { group: "Other", value: "overall.nonExplosiveEpaPerPlay", label: "Non-Expl EPA/Play" },
  { group: "Other", value: "overall.earlyDownEPAPerPlay", label: "Early Downs EPA/Play" },
  { group: "Other", value: "overall.lateDownSuccessRate", label: "Late Downs SR%" },
  { group: "Other", value: "overall.thirdDownDistance", label: "Avg Distance (3rd)" },
];

export const TrendsPage: FC<Props> = ({ seasons, percentiles, type, metric, lastUpdated }) => {
  const yearRange =
    seasons.length > 1 ? `${seasons[0]} to ${seasons[seasons.length - 1]}` : `${seasons[0] ?? ""}`;
  const title = `National Trends | ${yearRange} | Game on Paper`;
  const subtitle = "National level metric history";
  const canonical = "https://gameonpaper.com/cfb/charts/trends";
  const isOffOrDef = type === "offensive" || type === "defensive";

  // Group OFF/DEF metric options by their group label so JSX can emit
  // <optgroup>s without re-walking the array per group.
  const groupedOffDef = new Map<string, typeof METRIC_OPTIONS_OFF_DEF>();
  for (const opt of METRIC_OPTIONS_OFF_DEF) {
    if (!groupedOffDef.has(opt.group)) groupedOffDef.set(opt.group, []);
    groupedOffDef.get(opt.group)!.push(opt);
  }

  const extraHead = (
    <>
      <link href="/assets/css/bootstrap.min.css" rel="stylesheet" crossorigin="anonymous" />
      <link href="/assets/css/dashboard.css" rel="stylesheet" />
      <link href="/assets/css/blog.css" rel="stylesheet" />
      <link href="/assets/css/dark-game.css" rel="stylesheet" />
      <link href="/assets/css/bootstrap-icons/bootstrap-icons.css" rel="stylesheet" />
    </>
  );

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
      />
      <script src="/assets/js/feather.min.js" crossorigin="anonymous"></script>
      <script src="/assets/js/Chart.min.js" crossorigin="anonymous"></script>
      <script src="/assets/js/d3-regression.min.js" crossorigin="anonymous"></script>
      <script src="/assets/js/common.js" crossorigin="anonymous"></script>
      <script src="/assets/js/Chart.BoxPlot.min.js" crossorigin="anonymous"></script>
      <script src="/assets/js/team_chart.js" crossorigin="anonymous"></script>
      <script
        dangerouslySetInnerHTML={{
          __html: `
            const percentiles = ${JSON.stringify(percentiles)};
            (function() {
              'use strict';
              feather.replace();
              const teamChart = new Chart(
                document.getElementById('metric_chart_canvas'),
                generateTeamChartConfig("National Trends", null, [], percentiles, "${type}", "${metric}")
              );
            })();
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
            <li class="breadcrumb-item" aria-current="page">Charts</li>
            <li class="breadcrumb-item active" aria-current="page">
              <a href="/cfb/charts/trends">National Trends</a>
            </li>
          </ol>
        </nav>
      </div>
      <div class="container">
        <div class="row mb-3">
          <div class="col-lg-6 col-xs-12 mb-xs-3">
            <h1>
              National Trends{" "}
              <span class="d-inline text-muted h6">
                <small>
                  {" "}
                  <abbr title="Please report any issues/feedback to @gameonpaper.com on Bluesky!">(Beta)</abbr>
                </small>
              </span>
            </h1>
            <p class="m-0 text-muted">
              <strong>Available Seasons:</strong> {yearRange} - Data shown is from FBS vs FBS games only.
            </p>
            <p class="m-0 mb-2 text-muted text-small">
              Data from <a href="https://github.com/sportsdataverse/cfbfastR">cfbfastR</a>, may differ from ESPN due to data availability/quality. Note: other than for Adj EPA/Play, metrics are <strong>not</strong> adjusted for quality of opponent or garbage time.
            </p>
            <p class="m-0 mb-2 text-muted text-small">
              Adj EPA/Play methodology adapted from <a href="https://makennnahack.github.io/makenna-hack.github.io/publications/opp_adj_rank_project/">this article</a> by <a href="https://twitter.com/makennnahack">Makenna Hack</a> and <a href="https://blog.collegefootballdata.com/opponent-adjusted-stats-ridge-regression/">this article</a> from <a href="https://twitter.com/jbuddavis">Bud Davis</a>, accounting for home-field advantage, quality of opponent, and garbage time. Only considers FBS vs FBS games -- as a result, adj EPA/Play and normal EPA/Play numbers may differ significantly until all teams have played multiple FBS vs FBS games.
            </p>
            <p class="m-0 mb-3 text-muted text-small game-context">
              Last updated: <abbr title="If this is more than one week out of date during the season, please let us know at @gameonpaper on Twitter."><span class="game-date">{lastUpdated ?? "unknown"}</span></abbr>
            </p>
          </div>
          <div class="ms-auto col-lg-6 col-xs-12">
            <form class="mb-3 d-flex justify-content-lg-end justify-content-xs-start" id="dropdown-form">
              <div class="row">
                <div class="col-auto mb-xs-3 mb-sm-0">
                  <select class="form-select form-select-md" id="typeSelect">
                    <option value="-1">Choose Type...</option>
                    <option value="offensive" selected={type === "offensive"}>Offensive</option>
                    <option value="defensive" selected={type === "defensive"}>Defensive</option>
                  </select>
                </div>
                <div class="col-auto mb-xs-3 mb-sm-0">
                  <select class="form-select form-select-md" id="metricSelect">
                    <option value="-1">Choose Metric...</option>
                    <optgroup label="Overall">
                      <option value="overall.epaPerPlay" selected={metric === "overall.epaPerPlay"}>EPA/Play</option>
                      <option value="overall.yardsPerPlay" selected={metric === "overall.yardsPerPlay"}>Yards/Play</option>
                      <option value="overall.successRate" selected={metric === "overall.successRate"}>SR%</option>
                    </optgroup>
                    {isOffOrDef &&
                      Array.from(groupedOffDef.entries()).map(([group, opts]) => (
                        <optgroup label={group}>
                          {opts.map((o) => (
                            <option value={o.value} selected={metric === o.value}>
                              {o.label}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                  </select>
                </div>
              </div>
            </form>
          </div>
        </div>
      </div>
      <div class="container">
        <canvas
          id="metric_chart_canvas"
          class="mb-3"
          style="display: block; box-sizing: border-box; height: 1200px; width: 800px;"
          width="1200"
          height="800"
        ></canvas>
      </div>
    </Layout>
  );
};
