import type { FC, Child } from "hono/jsx";
import { Layout } from "./Layout";
import { GameThumb } from "./GameThumb";
import { TeamCard } from "./TeamCard";
import { TeamSlice } from "./TeamSlice";
import { roundNumber } from "../lib/leaderboard";
import {
  cleanLocation,
  hexToRgb,
  type ScheduleEvent,
} from "../lib/team_helpers";

// Reproduces frontend/views/pages/cfb/team_season.ejs and two of its
// five EJS partials (team_player_cards, player_box). The other three
// — team_card, team_slice, and game_thumb — live in their own
// modules so other pages (Pregame, Scoreboard) can share them.

export interface TeamData {
  id: string | number;
  location?: string;
  abbreviation?: string;
  color?: string;
  alternateColor?: string;
  record?: Array<{
    type?: string;
    displayValue?: string;
    stats?: Array<{ name?: string; displayValue?: string }>;
  }>;
  events?: ScheduleEvent[];
  [key: string]: unknown;
}

export interface PlayerRow {
  name?: string;
  playerId?: string | number | null;
  statistics?: Record<string, unknown>;
  advanced?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface PlayersByType {
  passing: PlayerRow[];
  rushing: PlayerRow[];
  receiving: PlayerRow[];
}

interface Props {
  teamData: TeamData;
  breakdown: Array<Record<string, unknown>>;
  players: PlayersByType;
  season: number | string;
}


// ---------- team_player_cards ---------------------------------------

interface TeamPlayerCardsProps {
  teamData: TeamData;
  players: PlayersByType;
  season: number | string;
}

const TeamPlayerCards: FC<TeamPlayerCardsProps> = ({ teamData, players, season }) => {
  const location = cleanLocation({ id: teamData.id, location: teamData.location });
  const types: Array<keyof PlayersByType> = ["passing", "rushing", "receiving"];

  const playerLine = (t: keyof PlayersByType, p: PlayerRow): Child => {
    const stats = (p.statistics ?? {}) as Record<string, unknown>;
    const adv = (p.advanced ?? {}) as Record<string, unknown>;
    const epaPerPlay = roundNumber(adv.epaPerPlay, 2, 2);
    const yards = stats.yards as number | string;
    const yardsAbs = Math.abs(parseFloat(String(yards)));
    const yardSuffix = yardsAbs === 1 ? "" : "s";
    if (t === "passing") {
      const compPct = roundNumber(100 * parseFloat(String(stats.completionPct ?? 0)), 2, 0);
      return (
        <p>
          {epaPerPlay} EPA/Play, {compPct}% Comp%, {yards as Child} yd{yardSuffix},{" "}
          {stats.touchdowns as Child} TD, {roundNumber(stats.detmer, 2, 2)} DETMER
        </p>
      );
    }
    if (t === "rushing") {
      return (
        <p>
          {epaPerPlay} EPA/Play, {stats.plays as Child} Car, {yards as Child} yd{yardSuffix},{" "}
          {stats.touchdowns as Child} TD{" "}
        </p>
      );
    }
    const catchPct = roundNumber(100 * parseFloat(String(stats.catchPct ?? 0)), 2, 0);
    return (
      <p>
        {epaPerPlay} EPA/Play, {stats.catches as Child} Cat ({catchPct}% Catch%), {yards as Child} yd
        {yardSuffix}, {stats.touchdowns as Child} TD{" "}
      </p>
    );
  };

  return (
    <div class="card border rounded">
      <style
        dangerouslySetInnerHTML={{
          __html: `
.img-circle-bg { background: rgba(0, 0, 0, 0.1); width: 150px; -webkit-clip-path: circle(closest-side); clip-path: circle(closest-side); }
@media (prefers-color-scheme: dark) { .img-circle-bg { background: rgba(255, 255, 255, 0.1) !important; } }
`,
        }}
      />
      <div class="card-body">
        <div class="card-title mb-0">
          <div class="d-flex align-items-center justify-content-between">
            <h2>
              {season} {location} Leaders
            </h2>
            <img
              class={`h2 img img-fluid me-1 team-logo-${teamData.id}`}
              width="50px"
              src={`https://a.espncdn.com/i/teamlogos/ncaa/500/${teamData.id}.png`}
            />
          </div>
        </div>
        <div class="row">
          {types.map((t) => {
            const positional = (players[t] ?? [])
              .filter((p) => p.name != null && (p.name?.length ?? 0) > 0)
              .slice()
              .sort(
                (a, b) =>
                  parseInt(String((b.statistics as { plays?: unknown })?.plays ?? 0), 10) -
                  parseInt(String((a.statistics as { plays?: unknown })?.plays ?? 0), 10),
              );
            const p = positional[0];
            const heading = t.charAt(0).toUpperCase() + t.slice(1);
            return (
              <div class="col-lg-4">
                <div class="text-center">
                  <p class="box-heading">{heading}</p>
                  {p ? (
                    <>
                      {p.playerId && p.playerId !== "NA" ? (
                        <a href={`https://www.espn.com/college-football/player/_/id/${p.playerId}`}>
                          <img
                            class="img img-fluid img-circle-bg mb-3"
                            src={`https://a.espncdn.com/combiner/i?img=/i/headshots/college-football/players/full/${p.playerId}.png&w=150`}
                          />
                        </a>
                      ) : (
                        <img
                          class="img img-fluid img-circle-bg mb-3"
                          src="https://a.espncdn.com/combiner/i?img=/i/headshots/nophoto.png&w=150&scale=crop"
                        />
                      )}
                      <h5>{p.name}</h5>
                      {playerLine(t, p)}
                    </>
                  ) : (
                    <p class="text-muted">No data available.</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};


// ---------- player_box ----------------------------------------------

type PlayerCellRenderer = (p: PlayerRow) => Child[];

interface PlayerBoxProps {
  title: string;
  id: string;
  players: PlayerRow[];
  headers: string[]; // columns for `<thead>`. First is left-aligned (name).
  renderRow: PlayerCellRenderer;
}

const PlayerBox: FC<PlayerBoxProps> = ({ title, id, players, headers, renderRow }) => {
  return (
    <div class="panel-group ms-2">
      <div class="panel panel-default">
        <div class="panel-heading">
          <div class="panel-title">
            <h2 class="d-inline">
              {title}{" "}
              <span class="d-inline text-small h6">
                <a
                  data-bs-toggle="collapse"
                  href={`#${id}Collapse`}
                  style="text-decoration: none;"
                  role="button"
                  aria-expanded="true"
                >
                  [show/hide]
                </a>
              </span>
            </h2>
            <p class="text-small text-muted">Data shown is from FBS vs FBS games only.</p>
          </div>
        </div>
        <div id={`${id}Collapse`} class="panel-collapse show">
          <div class="panel-body">
            <div class="table-responsive">
              <table class="table table-sm table-responsive">
                <thead>
                  <tr>
                    <th rowspan={1} colspan={1}></th>
                    {headers.map((h) => (
                      <th rowspan={1} colspan={1} class="box-heading" style="text-align: center;">
                        {h === "DETMER" ? (
                          <abbr title="Stands for 'Downfield Eventful Throwing Metric Encouraging Ripping it'. Built to find the most sicko QB performances. Developed by the Moon Crew Discord & @SickosCommittee on Twitter.">
                            DETMER
                          </abbr>
                        ) : (
                          h
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {players.length > 0 ? (
                    players
                      .filter((p) => (p.name?.length ?? 0) > 0)
                      .map((p) => <tr>{renderRow(p)}</tr>)
                  ) : (
                    <tr>
                      <p class="text-muted">No data available.</p>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};


// ---------- TeamSeason page ----------------------------------------

export const TeamSeasonPage: FC<Props> = ({ teamData, breakdown, players, season }) => {
  const location = cleanLocation({ id: teamData.id, location: teamData.location });
  const title = `${location} | ${season} | Game on Paper`;
  const subtitle = `${location} during the ${season} season`;
  const canonical = `https://gameonpaper.com/cfb/year/${season}/team/${teamData.id}`;
  const description = `Advanced stats for ${subtitle}`;
  const hasBreakdown = (breakdown?.length ?? 0) > 0;

  const darkLogoCss = `@media (prefers-color-scheme: dark) {
  img.team-logo-${teamData.id} { content: url('https://a.espncdn.com/i/teamlogos/ncaa/500-dark/${teamData.id}.png'); }
}
img.team-logo-61 { content: url('/assets/img/ennui-uga.png'); }`;

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

  const primRgb = JSON.stringify(hexToRgb(teamData.color ?? null));
  const altRgb = JSON.stringify(hexToRgb(teamData.alternateColor ?? "#000000"));
  const breakdownJson = hasBreakdown ? JSON.stringify(breakdown[0]) : "{}";
  const altColor = teamData.alternateColor ?? "#000000";
  const teamColor = teamData.color ?? "";

  // Player_box headers + row formatters per discipline.
  const passingHeaders = [
    "Comp/Att",
    "Yds",
    "TD",
    "INT",
    "Sacks",
    "DETMER",
    "Yds/dropback",
    "EPA/dropback",
    "EPA",
    "SR",
  ];
  const passingRow = (p: PlayerRow): Child[] => {
    const stats = (p.statistics ?? {}) as Record<string, unknown>;
    const adv = (p.advanced ?? {}) as Record<string, unknown>;
    const attempts = parseInt(String(stats.attempts ?? 0), 10);
    const compPct = attempts === 0 ? 0 : parseFloat(String(stats.completions ?? 0)) / attempts;
    return [
      <td style="text-align: left;">{p.name}</td>,
      <td class="numeral" style="text-align: center;">
        {stats.completions as Child}/{stats.attempts as Child} ({roundNumber(compPct * 100, 2, 0)}% Comp)
      </td>,
      <td class="numeral" style="text-align: center;">{stats.yards as Child}</td>,
      <td class="numeral" style="text-align: center;">{stats.touchdowns as Child}</td>,
      <td class="numeral" style="text-align: center;">{stats.interceptions as Child}</td>,
      <td class="numeral" style="text-align: center;">{stats.sacks as Child}</td>,
      <td class="numeral" style="text-align: center;">{roundNumber(stats.detmer, 2, 2)}</td>,
      <td class="numeral" style="text-align: center;">{roundNumber(stats.yardsPerDropback, 2, 2)}</td>,
      <td class="numeral" style="text-align: center;">{roundNumber(adv.epaPerPlay, 2, 2)}</td>,
      <td class="numeral" style="text-align: center;">{roundNumber(adv.totalEPA, 2, 2)}</td>,
      <td class="numeral" style="text-align: center;">
        {roundNumber(parseFloat(String(adv.successRate ?? 0)) * 100, 2, 0)}%
      </td>,
    ];
  };

  const rushingHeaders = [
    "Carries",
    "Yds",
    "TD",
    "Fum",
    "Yds/rush",
    "EPA/rush",
    "EPA",
    "SR",
  ];
  const rushingRow = (p: PlayerRow): Child[] => {
    const stats = (p.statistics ?? {}) as Record<string, unknown>;
    const adv = (p.advanced ?? {}) as Record<string, unknown>;
    return [
      <td style="text-align: left;">{p.name}</td>,
      <td class="numeral" style="text-align: center;">{stats.plays as Child}</td>,
      <td class="numeral" style="text-align: center;">{stats.yards as Child}</td>,
      <td class="numeral" style="text-align: center;">{stats.touchdowns as Child}</td>,
      <td class="numeral" style="text-align: center;">{stats.fumbles as Child}</td>,
      <td class="numeral" style="text-align: center;">{roundNumber(stats.yardsPerPlay, 2, 2)}</td>,
      <td class="numeral" style="text-align: center;">{roundNumber(adv.epaPerPlay, 2, 2)}</td>,
      <td class="numeral" style="text-align: center;">{roundNumber(adv.totalEPA, 2, 2)}</td>,
      <td class="numeral" style="text-align: center;">
        {roundNumber(parseFloat(String(adv.successRate ?? 0)) * 100, 2, 0)}%
      </td>,
    ];
  };

  const receivingHeaders = [
    "Catches",
    "Targets",
    "Catch Rate",
    "Yds",
    "TD",
    "Fum",
    "Yds/play",
    "EPA/play",
    "EPA",
    "SR",
  ];
  const receivingRow = (p: PlayerRow): Child[] => {
    const stats = (p.statistics ?? {}) as Record<string, unknown>;
    const adv = (p.advanced ?? {}) as Record<string, unknown>;
    return [
      <td style="text-align: left;">{p.name}</td>,
      <td class="numeral" style="text-align: center;">{stats.catches as Child}</td>,
      <td class="numeral" style="text-align: center;">{stats.targets as Child}</td>,
      <td class="numeral" style="text-align: center;">
        {roundNumber(parseFloat(String(stats.catchPct ?? 0)) * 100, 2, 0)}%
      </td>,
      <td class="numeral" style="text-align: center;">{stats.yards as Child}</td>,
      <td class="numeral" style="text-align: center;">{stats.touchdowns as Child}</td>,
      <td class="numeral" style="text-align: center;">{stats.fumbles as Child}</td>,
      <td class="numeral" style="text-align: center;">{roundNumber(stats.yardsPerPlay, 2, 2)}</td>,
      <td class="numeral" style="text-align: center;">{roundNumber(adv.epaPerPlay, 2, 2)}</td>,
      <td class="numeral" style="text-align: center;">{roundNumber(adv.totalEPA, 2, 2)}</td>,
      <td class="numeral" style="text-align: center;">
        {roundNumber(parseFloat(String(adv.successRate ?? 0)) * 100, 2, 0)}%
      </td>,
    ];
  };

  const sortByPlays = (a: PlayerRow, b: PlayerRow) =>
    parseFloat(String((b.statistics as { plays?: unknown })?.plays ?? 0)) -
    parseFloat(String((a.statistics as { plays?: unknown })?.plays ?? 0));

  const radarWidth = 400;
  const radarHalf = radarWidth / 2;

  const extraScripts = (
    <>
      <script
        dangerouslySetInnerHTML={{
          __html: `
            var teamData = ${JSON.stringify(teamData)};
            const DateTime = luxon.DateTime;
            function formatDateTime(inputDate) {
              return DateTime.fromISO(inputDate).toLocaleString(DateTime.DATETIME_SHORT);
            }
            var gameDates = document.getElementsByClassName("game-date");
            if (gameDates.length > 0) {
              for (var i = 0; i < gameDates.length; i++) {
                var dateElem = gameDates[i];
                dateElem.innerText = formatDateTime(dateElem.innerText);
              }
            }
          `,
        }}
      ></script>
      <script src="/assets/js/feather.min.js" crossorigin="anonymous"></script>
      <script src="/assets/js/Chart.min.js" crossorigin="anonymous"></script>
      <script src="/assets/js/common.js" crossorigin="anonymous"></script>
      <script src="/assets/js/radar.js"></script>
      {hasBreakdown && (
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                'use strict';
                feather.replace();
                const prim = JSON.parse('${primRgb}');
                const alt = JSON.parse('${altRgb}');
                let breakdown = JSON.parse('${breakdownJson}');
                breakdown = {
                  ...breakdown,
                  teamName: ${JSON.stringify(location)},
                  alternateColor: ${JSON.stringify(altColor)},
                  color: ${JSON.stringify(teamColor)}
                };
                const offRadarCtx = document.getElementById('offensive-canvas');
                new Chart(
                  offRadarCtx,
                  generateConfig(generateDataset([breakdown], "Offensive"), ${JSON.stringify(`${location} ${season} Offensive Profile`)})
                );
                const defRadarCtx = document.getElementById('defensive-canvas');
                new Chart(
                  defRadarCtx,
                  generateConfig(generateDataset([breakdown], "Defensive"), ${JSON.stringify(`${location} ${season} Defensive Profile`)})
                );
              })();
            `,
          }}
        ></script>
      )}
    </>
  );

  return (
    <Layout title={title} subtitle={subtitle} canonical={canonical} extraHead={extraHead} extraScripts={extraScripts}>
      <div class="container">
        <nav aria-label="breadcrumb">
          <ol class="breadcrumb">
            <li class="breadcrumb-item" aria-current="page">Teams</li>
            <li class="breadcrumb-item" aria-current="page">
              <a href={`/cfb/team/${teamData.id}`}>{location}</a>
            </li>
            <li class="breadcrumb-item active" aria-current="page">{season}</li>
          </ol>
        </nav>
      </div>
      <div class="container">
        <div class="row my-3">
          <div class="col-lg-4 col-md-12 mb-md-3 mb-lg-0 margin-override">
            <TeamCard teamData={teamData} breakdown={breakdown} season={season} hideNavigation={true} />
          </div>
          <div class="col-lg-8 col-md-12">
            <TeamPlayerCards teamData={teamData} players={players} season={season} />
          </div>
        </div>
      </div>
      {hasBreakdown && (
        <div class="container">
          <div id="profile" class="row mb-3">
            <div class="col-md-12 col-lg-12 px-md-4">
              <h2 id="profile" class="d-inline">
                Profile{" "}
                <span class="d-inline text-small h6">
                  <a
                    data-bs-toggle="collapse"
                    href="#profileContent"
                    style="text-decoration: none;"
                    role="button"
                    aria-expanded="true"
                  >
                    [show/hide]
                  </a>
                </span>
              </h2>
              <p class="text-muted text-small m-0">
                Data from{" "}
                <a href="https://github.com/sportsdataverse/cfbfastR">cfbfastR</a> and{" "}
                <a href="https://collegefootballdata.com">collegefootballdata.com</a>. Based on{" "}
                <a href="https://twitter.com/ESPN_BillC">Bill Connelly</a>'s team profile radars (
                <a href="https://www.sbnation.com/college-football/2018/7/16/17532360/georgia-tech-football-2018-preview-schedule-roster">
                  example
                </a>
                ).
              </p>
              <div class="panel-group">
                <div class="panel panel-default">
                  <div id="profileContent" class="panel-collapse show">
                    <div class="panel-body">
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
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
      <div class="container">
        <div id="breakdown" class="row mb-3">
          <div class="col-md-12 col-lg-12 px-md-4">
            <h2 id="breakdown" class="d-inline">
              Breakdown{" "}
              <span class="d-inline text-small h6">
                <a
                  data-bs-toggle="collapse"
                  href="#breakdownContent"
                  style="text-decoration: none;"
                  role="button"
                  aria-expanded="true"
                >
                  [show/hide]
                </a>
              </span>
            </h2>
            <p class="text-small text-muted">Data shown is from FBS vs FBS games only.</p>
            <div class="panel-group">
              <div class="panel panel-default">
                <div id="breakdownContent" class="panel-collapse show">
                  <div class="panel-body">
                    <div class="row mb-3">
                      <div class="col-md-4 ms-sm-auto col-lg-4">
                        <TeamSlice breakdown={breakdown} title="Offensive" target="offensive" situation="overall" />
                      </div>
                      <div class="col-md-4 ms-sm-auto col-lg-4">
                        <TeamSlice breakdown={breakdown} title="When Passing" target="offensive" situation="passing" />
                      </div>
                      <div class="col-md-4 ms-sm-auto col-lg-4">
                        <TeamSlice breakdown={breakdown} title="When Rushing" target="offensive" situation="rushing" />
                      </div>
                    </div>
                    <div class="row">
                      <div class="col-md-4 ms-sm-auto col-lg-4">
                        <TeamSlice breakdown={breakdown} title="Defensive" target="defensive" situation="overall" />
                      </div>
                      <div class="col-md-4 ms-sm-auto col-lg-4">
                        <TeamSlice
                          breakdown={breakdown}
                          title="Against the Pass"
                          target="defensive"
                          situation="passing"
                        />
                      </div>
                      <div class="col-md-4 ms-sm-auto col-lg-4">
                        <TeamSlice
                          breakdown={breakdown}
                          title="Against the Run"
                          target="defensive"
                          situation="rushing"
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="container" id="player-breakdown">
        <div class="row mb-3">
          <div class="col-lg-12 col-md-12 mb-md-3 mb-lg-0 margin-override">
            <PlayerBox
              title="Passing"
              id="passing"
              players={(players.passing ?? []).slice().sort(sortByPlays)}
              headers={passingHeaders}
              renderRow={passingRow}
            />
          </div>
        </div>
        <div class="row mb-3">
          <div class="col-lg-12 col-md-12 mb-md-3 mb-lg-0 margin-override">
            <PlayerBox
              title="Rushing"
              id="rushing"
              players={(players.rushing ?? []).slice().sort(sortByPlays)}
              headers={rushingHeaders}
              renderRow={rushingRow}
            />
          </div>
        </div>
        <div class="row mb-3">
          <div class="col-lg-12 col-md-12 mb-md-3 mb-lg-0 margin-override">
            <PlayerBox
              title="Receiving"
              id="receiving"
              players={(players.receiving ?? []).slice().sort(sortByPlays)}
              headers={receivingHeaders}
              renderRow={receivingRow}
            />
          </div>
        </div>
      </div>
      <div class="container">
        <div id="schedule" class="row mb-3">
          <h2 class="ms-2">
            Schedule{" "}
            <span class="d-inline text-small h6">
              <a
                data-bs-toggle="collapse"
                href="#scheduleContent"
                style="text-decoration: none;"
                role="button"
                aria-expanded="true"
              >
                [show/hide]
              </a>
            </span>
          </h2>
          <div class="panel-group">
            <div class="panel panel-default">
              <div id="scheduleContent" class="panel-collapse show">
                <div class="panel-body">
                  <div class="row">
                    {(teamData.events ?? []).length > 0 ? (
                      (teamData.events ?? []).map((g) => (
                        <div class="col-xl-3 col-lg-6">
                          <GameThumb game={g} />
                        </div>
                      ))
                    ) : (
                      <p class="text-center text-muted">No games scheduled for this team.</p>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Layout>
  );
};
