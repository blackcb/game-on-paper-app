import type { FC, Child } from "hono/jsx";
import { Layout } from "./Layout";
import { cleanName } from "../lib/games";
import { roundNumber } from "../lib/leaderboard";
import {
  DETMER_TOOLTIP,
  STAT_KEY_TITLE_MAPPING,
  TURNOVER_VEC,
  calculateDETMER,
  formatDistance,
  formatPeriod,
  formatYardline,
  geiPercentileBands,
  getNumberWithOrdinal,
  handleRates,
  handleSlimBoxScoreRates,
  isChampionshipEvent,
  roundNumberZero,
  sortAdvBoxScoreInPlace,
  unique,
  type BoxScoreCell,
} from "../lib/box_score";
import {
  buildFieldRenderScript,
  computePassMatrix,
  computeRushMatrix,
  type FieldChartPlay,
  type FieldChartTeam,
  type PassMatrix,
  type RushMatrix,
} from "../lib/play_charts";

// Full port of frontend/views/pages/cfb/game.ejs (1501 lines) +
// the four remaining partials (slim_box_score, field, pass_chart,
// rush_chart). Ships the chrome, WP/EP charts (data island consumed
// by the existing /assets/js/dashboard.js), full advanced box score,
// per-team player stats with pass/rush matrices, big plays / most
// important plays / scoring plays / drives / all-plays tables, and
// the per-drive field charts.
//
// The chart-heavy sections all follow the JSON-island pattern used by
// Team.tsx and Pregame.tsx — the JSX renders the canvases and inlines
// the data, then unmodified scripts in /assets/js/{dashboard,field}.js
// consume those globals to draw. Sub-phase 2E moves /assets/* under
// the Worker via Static Assets binding so those scripts stop 404'ing
// in production.

export interface GameTeam {
  id?: string | number;
  abbreviation?: string;
  nickname?: string;
  location?: string;
  color?: string;
  alternateColor?: string;
  [key: string]: unknown;
}

export interface GameCompetitor {
  team?: GameTeam;
  score?: number | string;
  homeAway?: string;
  records?: Array<{ type?: string; summary?: string }>;
  [key: string]: unknown;
}

export interface GameInfo {
  id?: string | number;
  date?: string;
  status?: { type?: { name?: string; completed?: boolean; detail?: string; description?: string } };
  competitors?: GameCompetitor[];
  broadcasts?: Array<{ media?: { shortName?: string } }>;
  gei?: number;
  neutralSite?: boolean;
  [key: string]: unknown;
}

interface ScoringPlay {
  scoringType?: { displayName?: string; abbreviation?: string };
  text?: string;
  homeScore?: number;
  awayScore?: number;
  pos_team?: string | number;
  period?: { number?: number };
  clock?: { displayValue?: string };
  [key: string]: unknown;
}

export interface PlayRecord {
  game_play_number?: number | string;
  pos_team?: string | number;
  period?: number;
  clock?: { displayValue?: string; minutes?: string | number; seconds?: string | number };
  type?: { text?: string };
  text?: string;
  scoringPlay?: boolean;
  scoring_play?: boolean;
  change_of_poss?: number | boolean;
  homeScore?: number;
  awayScore?: number;
  pass?: 0 | 1;
  rush?: 0 | 1;
  start: {
    down: number;
    distance: number;
    yardsToEndzone: number;
    pos_team?: { id: string | number };
    pos_team_score?: number;
    def_pos_team_score?: number;
    posTeamTimeouts?: number;
    defTeamTimeouts?: number;
    posTeamSpread?: number;
    awayScore?: number;
    homeScore?: number;
    ExpScoreDiff?: number;
    pos_score_diff?: number;
    team?: { id: string | number };
  };
  end: {
    yardsToEndzone: number;
    posTeamTimeouts?: number;
    defPosTeamTimeouts?: number;
    pos_score_diff?: number;
    ExpScoreDiff?: number;
    team?: { id: string | number };
  };
  drive_play_index?: number | string;
  drive_total_yards?: number | string;
  drive_start?: number;
  expectedPoints?: { added?: number; before?: number; after?: number };
  winProbability?: { added?: number; before?: number; after?: number };
  EPA?: number;
  EPA_success?: number;
  WPA?: number;
  modelInputs?: { start?: { pos_team_receives_2H_kickoff?: number; is_home?: number } };
  overUnder?: number | string;
  season?: number | string;
  penalty_assessed_on_kickoff?: boolean;
  statYardage?: number | string;
  ["drive.id"]?: string | number;
  [key: string]: unknown;
}

interface DriveRecord {
  id: string | number;
  description?: string;
  result?: string;
  displayResult?: string;
  start?: {
    period?: { number?: number };
    clock?: { displayValue?: string; game_play_number?: number | string };
  };
  [key: string]: unknown;
}

interface AdvBoxScore {
  team?: Array<Record<string, unknown>>;
  defensive?: Array<Record<string, unknown>>;
  drives?: Array<Record<string, unknown>>;
  pass?: Array<Record<string, unknown>>;
  receiver?: Array<Record<string, unknown>>;
  rush?: Array<Record<string, unknown>>;
  situational?: Array<Record<string, unknown>>;
  turnover?: Array<Record<string, unknown>>;
  [key: string]: Array<Record<string, unknown>> | undefined;
}

export interface GameData {
  gameInfo?: GameInfo;
  header?: { season?: { year?: number }; week?: number; gameNote?: string; [key: string]: unknown };
  homeTeamId?: string | number;
  awayTeamId?: string | number;
  homeTeamSpread?: number | string;
  overUnder?: number | string;
  plays?: PlayRecord[];
  scoringPlays?: ScoringPlay[];
  boxScore?: unknown;
  advBoxScore?: AdvBoxScore;
  drives?: { current?: DriveRecord; previous?: DriveRecord[] };
  [key: string]: unknown;
}

interface Props {
  gameData: GameData;
  percentiles: Array<Record<string, unknown>>;
  season: number;
}

const NETWORK_MAPPINGS: Record<string, string> = {
  FOX: "https://www.foxsports.com/live",
  FS1: "https://www.foxsports.com/live/fs1",
  FS2: "https://www.foxsports.com/live/fs2",
  BTN: "https://www.foxsports.com/live/btn",
  NBC: "https://www.nbcsports.com/live",
  Peacock: "https://www.peacocktv.com",
  CBSSN: "https://www.cbssports.com/cbs-sports-network/",
  CBS: "https://www.cbssports.com/live/",
  PAC12: "https://pac-12.com/live",
  "NFL NET": "https://www.nfl.com/network/watch/nfl-network-live",
  "CW NETWORK": "https://www.cwtv.com/sports/",
  "THE CW NETWORK": "https://www.cwtv.com/sports/",
  "The CW Network": "https://www.cwtv.com/sports/",
  MWSN: "https://themw.com/watch/",
  MWN: "https://themw.com/watch/",
  "MWN App": "https://themw.com/watch/",
  truTV: "https://www.trutv.com/watchtrutv",
  TNT: "https://www.tntdrama.com/watchtnt",
};

const ESPN_NETWORK_MARKERS = [
  "ESPN",
  "LHN",
  "Longhorn Network",
  "ACCN",
  "ACC Network",
  "SEC Network",
  "SECN",
  "BIG12",
  "ABC",
];

// Georgia-61 nickname/abbreviation lowercase rule (game.ejs:209-214).
const CLEAN_LIST = new Set([61]);
function cleanField(team: GameTeam, field: "abbreviation" | "location" | "nickname"): string {
  const val = String(team[field] ?? "");
  if (CLEAN_LIST.has(parseInt(String(team.id ?? ""), 10))) return val.toLocaleLowerCase();
  return val;
}
const cleanAbbreviation = (team: GameTeam) => cleanField(team, "abbreviation");
const cleanLocation = (team: GameTeam) => cleanField(team, "location");

// Box score header with logo link.
const TeamLogoTh: FC<{ teamId: string | number; season: number | string }> = ({ teamId, season }) => (
  <th class="text-center">
    <a href={`/cfb/year/${season}/team/${teamId}`}>
      <img
        class={`img-fluid team-logo-${teamId}`}
        width="35px"
        src={`https://a.espncdn.com/i/teamlogos/ncaa/500/${teamId}.png`}
        alt={`ESPN team id ${teamId}`}
      />
    </a>
  </th>
);

// Single advanced box-score table (one of the eight in the team-stats
// row). Plain numbers + optional title attr; no percentile chips.
const BoxScoreTable: FC<{
  title: string;
  columns: string[];
  data: Array<Record<string, unknown>>;
  useSuffix: boolean;
  decimalPoints: number;
  advBoxScore: AdvBoxScore;
  season: number | string;
  caption?: Child;
  teamKey?: "pos_team" | "def_pos_team";
}> = ({ title, columns, data, useSuffix, decimalPoints, advBoxScore, season, caption, teamKey = "pos_team" }) => {
  const teamIds = data.map((g) => g[teamKey] as string | number);
  return (
    <div class="table-responsive">
      <table class="table table-sm table-responsive">
        {caption}
        <thead>
          <tr>
            <th class="text-start" style="text-align: left;">
              {title}
            </th>
            {teamIds.map((id) => (
              <TeamLogoTh teamId={id} season={season} />
            ))}
          </tr>
        </thead>
        <tbody>
          {columns.map((item) => {
            const cells = handleRates(item, data, useSuffix, decimalPoints, advBoxScore);
            const label = STAT_KEY_TITLE_MAPPING[item] ?? item;
            return (
              <tr>
                <td style="text-align: left;" dangerouslySetInnerHTML={{ __html: label }}></td>
                {cells.map((c) => (
                  <td class="numeral" style="text-align: center;">
                    {c.display}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

// game.ejs:823-1086. Eight tables across three columns.
const SLIM_COLUMNS = [
  "EPA_per_play",
  "situational.EPA_success",
  "yards_per_play",
  "EPA_passing_per_play",
  "EPA_rushing_per_play",
  "yards_per_pass",
  "EPA_explosive",
  "situational.EPA_success_rate_third",
  "situational.EPA_success_rate_rz",
  "rushing_stuff",
  "defensive.havoc_total",
];

const SlimBoxScore: FC<{
  advBoxScore: AdvBoxScore;
  percentiles: Array<Record<string, unknown>>;
  season: number | string;
}> = ({ advBoxScore, percentiles, season }) => {
  const teamIds = (advBoxScore.team ?? []).map((g) => g.pos_team as string | number);
  const seasonForLink =
    (percentiles[0]?.season as number | string | undefined) ?? season;
  return (
    <div class="table-responsive">
      <table class="table table-sm table-responsive">
        <caption class="text-muted text-small">
          Concept from Robert Binion (
          <a href="https://twitter.com/robert_binion">@robert_binion</a>
          ). Data from GameOnPaper.com by Akshay Easwaran (
          <a href="https://twitter.com/akeaswaran">@akeaswaran</a>) and Saiem Gilani (
          <a href="https://twitter.com/saiemgilani">@saiemgilani</a>) with kneel downs removed.{" "}
          {percentiles.length > 0 && (
            <>
              Cell colors reflect the percentile of a team's performance against all single-game FBS
              vs FBS performances in that stat in {String(percentiles[0].season ?? "")}.
            </>
          )}
        </caption>
        <thead>
          <tr>
            <th style="text-align: left;">Overall</th>
            {teamIds.map((id) => (
              <TeamLogoTh teamId={id} season={seasonForLink} />
            ))}
          </tr>
        </thead>
        <tbody>
          {SLIM_COLUMNS.map((item) => {
            const cells = handleSlimBoxScoreRates(item, advBoxScore as Record<string, Array<Record<string, unknown>>>, percentiles, 2);
            const label = lookupSlimTitle(item);
            return (
              <tr>
                <td style="text-align: left;" dangerouslySetInnerHTML={{ __html: label }}></td>
                {cells.map((c) => (
                  <SlimCell cell={c} />
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

const SlimCell: FC<{ cell: BoxScoreCell }> = ({ cell }) => {
  const className = `numeral${cell.rampClass ?? ""}`;
  return (
    <td class={className} style="text-align: center;" title={cell.title}>
      {renderSlimCellDisplay(cell.display)}
    </td>
  );
};

// The slim-cell display string is "VALUE ORDth %ile" — split into a
// large number + small percentile chip to match the EJS markup
// without losing the i18n attribute we'd want around the whole cell.
function renderSlimCellDisplay(display: string): Child {
  const idx = display.lastIndexOf(" ");
  if (idx < 0 || !display.includes("%ile")) return display;
  const split = display.lastIndexOf(" ", display.indexOf("%ile") - 2);
  if (split <= 0) return display;
  const main = display.slice(0, split);
  const tail = display.slice(split + 1);
  return (
    <>
      {main}{" "}
      <small class="align-self-center" style="opacity: 50%">
        {tail}
      </small>
    </>
  );
}

import { SLIM_TITLE_MAPPING } from "../lib/box_score";
function lookupSlimTitle(item: string): string {
  return SLIM_TITLE_MAPPING[item] ?? item;
}

// Player stat row (Dropbacks / Rush attempts / Pass targets). Single
// component reused for both teams and all three categories. The EJS
// version branches on category; the cleaner port is one row component
// with category-specific stat-line rendering.
const PassRow: FC<{ p: Record<string, unknown> }> = ({ p }) => (
  <tr>
    <td style="text-align: left;">{String(p.passer_player_name ?? "")}</td>
    <td style="text-align: left;">
      {String(p.Comp ?? "")}/{String(p.Att ?? "")}, {String(p.Yds ?? "")} yd
      {Math.abs(parseFloat(String(p.Yds ?? 0))) === 1 ? "" : "s"}, {String(p.Pass_TD ?? "")} TD,{" "}
      {String(p.Int ?? "")} INT, {String(p.Sck ?? "")} Sck
      {Math.abs(parseFloat(String(p.Sck ?? 0))) === 1 ? "" : "s"},{" "}
      {roundNumber(parseFloat(String(p.exp_qbr ?? 0)), 2, 1)} xQBR,{" "}
      {roundNumber(calculateDETMER(p), 2, 2)}{" "}
      <abbr title={DETMER_TOOLTIP}>DETMER</abbr>
    </td>
    <PlayerStatCells p={p} primaryRate="YPA" />
  </tr>
);

const RushRow: FC<{ p: Record<string, unknown> }> = ({ p }) => (
  <tr>
    <td style="text-align: left;">{String(p.rusher_player_name ?? "")}</td>
    <td style="text-align: left;">
      {String(p.Car ?? "")} carr{parseInt(String(p.Car ?? 0), 10) === 1 ? "y" : "ies"},{" "}
      {String(p.Yds ?? "")} yd{Math.abs(parseFloat(String(p.Yds ?? 0))) === 1 ? "" : "s"},{" "}
      {String(p.Rush_TD ?? "")} TD, {String(p.Fum ?? "")} Fum ({String(p.Fum_Lost ?? "")} lost)
    </td>
    <PlayerStatCells p={p} primaryRate="YPC" />
  </tr>
);

const ReceiverRow: FC<{ p: Record<string, unknown> }> = ({ p }) => (
  <tr>
    <td style="text-align: left;">{String(p.receiver_player_name ?? "")}</td>
    <td style="text-align: left;">
      {String(p.Rec ?? "")} catch{parseInt(String(p.Rec ?? 0), 10) === 1 ? "" : "es"} (
      {String(p.Tar ?? "")} target{parseInt(String(p.Tar ?? 0), 10) === 1 ? "" : "s"}),{" "}
      {String(p.Yds ?? "")} yd{Math.abs(parseFloat(String(p.Yds ?? 0))) === 1 ? "" : "s"},{" "}
      {String(p.Rec_TD ?? "")} TD, {String(p.Fum ?? "")} Fum ({String(p.Fum_Lost ?? "")} lost)
    </td>
    <PlayerStatCells p={p} primaryRate="YPT" />
  </tr>
);

const PlayerStatCells: FC<{ p: Record<string, unknown>; primaryRate: string }> = ({ p, primaryRate }) => (
  <>
    <td class="numeral" style="text-align: center;">
      {roundNumber(parseFloat(String(p[primaryRate] ?? 0)), 2, 2)}
    </td>
    <td class="numeral" style="text-align: center;">
      {roundNumber(parseFloat(String(p.EPA_per_Play ?? 0)), 2, 2)}
    </td>
    <td class="numeral" style="text-align: center;">
      {roundNumber(parseFloat(String(p.EPA ?? 0)), 2, 2)}
    </td>
    <td class="numeral" style="text-align: center;">
      {roundNumber(parseFloat(String(p.SR ?? 0)) * 100, 2, 0)}%
    </td>
    <td class="numeral" style="text-align: center;">
      {roundNumber(parseFloat(String(p.WPA ?? 0)) * 100, 2, 1)}%
    </td>
  </>
);

// Per-team panel containing dropbacks/rushes/receivers tables plus
// pass and rush matrices. game.ejs:1108-1297 renders this twice
// (away then home) — same shape, parameterized.
const PlayerStatsPanel: FC<{
  team: GameTeam;
  collapseId: string;
  passRows: Array<Record<string, unknown>>;
  rushRows: Array<Record<string, unknown>>;
  receiverRows: Array<Record<string, unknown>>;
  plays: PlayRecord[];
  season: number | string;
}> = ({ team, collapseId, passRows, rushRows, receiverRows, plays, season }) => {
  const passMatrix = computePassMatrix(plays as Array<Record<string, unknown>>);
  const rushMatrix = computeRushMatrix(plays as Array<Record<string, unknown>>);
  return (
    <div class="col-lg-6 ms-sm-auto px-md-4 mb-xs-3 mb-lg-0">
      <div class="panel-group">
        <div class="panel panel-default">
          <div class="panel-heading">
            <div class="panel-title">
              <div class="d-flex justify-content-between">
                <h2 class="d-inline">
                  {cleanLocation(team)}{" "}
                  <span class="d-inline text-small h6">
                    <a
                      data-bs-toggle="collapse"
                      href={`#${collapseId}`}
                      style="text-decoration: none;"
                      role="button"
                      aria-expanded="true"
                    >
                      [show/hide]
                    </a>
                  </span>
                </h2>
                <th style="text-align: center;">
                  <a href={`/cfb/year/${season}/team/${team.id}`}>
                    <img
                      class={`img-fluid team-logo-${team.id}`}
                      width="35px"
                      src={`https://a.espncdn.com/i/teamlogos/ncaa/500/${team.id}.png`}
                      alt={`ESPN team id ${team.id}`}
                    />
                  </a>
                </th>
              </div>
            </div>
          </div>
          <div id={collapseId} class="panel-collapse show">
            <div class="panel-body">
              <div class="table-responsive">
                <table class="table table-sm table-responsive">
                  <thead>
                    <tr>
                      <th rowspan={1} colspan={1}></th>
                      <th rowspan={1} colspan={1} class="box-heading">
                        Stat line
                      </th>
                      <th rowspan={1} colspan={1} class="box-heading" style="text-align: center;">
                        Yards/play
                      </th>
                      <th rowspan={1} colspan={1} class="box-heading" style="text-align: center;" title="Expected Points Added per Play">
                        EPA/play
                      </th>
                      <th rowspan={1} colspan={1} class="box-heading" style="text-align: center;" title="Total Expected Points Added">
                        EPA
                      </th>
                      <th rowspan={1} colspan={1} class="box-heading" style="text-align: center;" title="Success Rate">
                        SR
                      </th>
                      <th rowspan={1} colspan={1} class="box-heading" style="text-align: center;" title="Win Probability Added">
                        WPA
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {passRows.length > 0 && (
                      <tr>
                        <td colspan={8} class="gt_group_heading" style="color: black; font-weight: bold;" title="Includes pass attempts and sacks.">
                          Dropbacks
                        </td>
                      </tr>
                    )}
                    {passRows
                      .filter((p) => String(p.passer_player_name ?? "").length > 0)
                      .map((p) => <PassRow p={p} />)}
                    {rushRows.length > 0 && (
                      <tr>
                        <td colspan={8} class="gt_group_heading" style="color: black; font-weight: bold;">
                          Rush attempts
                        </td>
                      </tr>
                    )}
                    {rushRows
                      .filter((p) => String(p.rusher_player_name ?? "").length > 0)
                      .map((p) => <RushRow p={p} />)}
                    {receiverRows.length > 0 && (
                      <tr>
                        <td colspan={8} class="gt_group_heading" style="color: black; font-weight: bold;">
                          Pass targets
                        </td>
                      </tr>
                    )}
                    {receiverRows
                      .filter((p) => String(p.receiver_player_name ?? "").length > 0)
                      .map((p) => <ReceiverRow p={p} />)}
                  </tbody>
                </table>
              </div>
              <PassMatrixView matrix={passMatrix} />
              <RushMatrixView matrix={rushMatrix} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

// pass_chart.ejs:166-222.
const PassMatrixView: FC<{ matrix: PassMatrix }> = ({ matrix }) => {
  if (matrix.countableAttempts === 0) return null;
  const renderCell = (cell: typeof matrix.short.left) => (
    <td class="align-middle tm-segment">
      <p class="m-0">
        <strong>{roundNumberZero(cell.EPA, 2, 2)} total EPA</strong>
      </p>
      <p class="m-0">
        <small>
          {cell.completions}/{cell.attempts}
        </small>
      </p>
      <p class="m-0">
        <small>{cell.yards} yds</small>
      </p>
    </td>
  );
  return (
    <>
      <h3 class="mt-3 mb-2">
        Target Matrix{" "}
        <span class="d-inline text-muted h6">
          <small>
            <abbr title="Please report any issues/feedback to @gameonpaper.com on Bluesky!">(Beta)</abbr>
          </small>
        </span>
      </h3>
      <div class="table table-responsive">
        <table class="table table-sm table-responsive text-center target-matrix">
          <tbody>
            <tr class="tm-row">
              <td class="tm-section-title">
                <span class="d-block">
                  <strong>Deep</strong>
                </span>
                <span class="text-muted">
                  <small>12+ air yards</small>
                </span>
              </td>
              {renderCell(matrix.deep.left)}
              {renderCell(matrix.deep.middle)}
              {renderCell(matrix.deep.right)}
            </tr>
            <tr>
              <td class="tm-section-title">
                <span class="d-block">
                  <strong>Short</strong>
                </span>
                <span class="text-muted">
                  <small>0-12 air yards</small>
                </span>
              </td>
              {renderCell(matrix.short.left)}
              {renderCell(matrix.short.middle)}
              {renderCell(matrix.short.right)}
            </tr>
            <tr>
              <th></th>
              <th class="align-middle">Left</th>
              <th class="align-middle">Middle</th>
              <th class="align-middle">Right</th>
            </tr>
          </tbody>
          <caption>
            Built off play-by-play data that started appearing in 2025. Sacks and passes that lack
            depth and direction information are not included.
          </caption>
        </table>
      </div>
    </>
  );
};

// rush_chart.ejs:67-94.
const RushMatrixView: FC<{ matrix: RushMatrix }> = ({ matrix }) => {
  if (matrix.countableAttempts === 0) return null;
  const renderCell = (cell: typeof matrix.left) => (
    <td class="align-middle tm-segment" style="padding-bottom: 3em !important; padding-top: 3em !important;">
      <p class="m-0">
        <strong>{roundNumberZero(cell.EPA, 2, 2)} total EPA</strong>
      </p>
      <p class="m-0">
        <small>
          {cell.attempts} {cell.attempts === 1 ? "carry" : "carries"}, {cell.yards} yds
        </small>
      </p>
    </td>
  );
  return (
    <>
      <h3 class="mt-3 mb-2">
        Rush Matrix{" "}
        <span class="d-inline text-muted h6">
          <small>
            <abbr title="Please report any issues/feedback to @gameonpaper.com on Bluesky!">(Beta)</abbr>
          </small>
        </span>
      </h3>
      <div class="table table-responsive">
        <table class="table table-sm table-responsive text-center target-matrix">
          <tbody>
            <tr class="tm-row">
              {renderCell(matrix.left)}
              {renderCell(matrix.middle)}
              {renderCell(matrix.right)}
            </tr>
            <tr>
              <th class="align-middle">Left</th>
              <th class="align-middle">Middle</th>
              <th class="align-middle">Right</th>
            </tr>
          </tbody>
          <caption>
            Built off play-by-play data that started appearing in 2025. Rush attempts that lack
            direction information are not included.
          </caption>
        </table>
      </div>
    </>
  );
};

// game.ejs:231-304. One play row + (optionally) an expandable detail
// panel with field metadata, EPS, score, drive, WP, fourth-down link.
function classifyPlay(play: PlayRecord): string {
  const playTypeText = play.type?.text ?? "";
  const text = play.text ?? "";
  const lcText = text.toLocaleLowerCase();
  const isTurnoverByVec = TURNOVER_VEC.has(playTypeText);
  const isFumbleAndChange = lcText.includes("fumble") && play.change_of_poss === 1;
  const isFailedFourth =
    play.start.down === 4 &&
    parseFloat(String(play.statYardage ?? 0)) < parseFloat(String(play.start.distance)) &&
    !playTypeText.includes("Punt") &&
    !playTypeText.includes("Timeout");
  if (isTurnoverByVec || isFumbleAndChange || isFailedFourth) return " table-danger";
  if (play.scoringPlay === true || play.scoring_play === true) return " table-success";
  if (lcText.includes("penalty")) return " table-warning";
  return "";
}

const PlayRow: FC<{
  play: PlayRecord;
  canCollapse: boolean;
  collapsePrefix: string;
  homeTeam: GameTeam;
  awayTeam: GameTeam;
}> = ({ play, canCollapse, collapsePrefix, homeTeam, awayTeam }) => {
  const classText = classifyPlay(play);
  const period = formatPeriod(play.period ?? 0, play.clock);
  const offense: GameTeam =
    String(play.start.pos_team?.id ?? "") === String(homeTeam.id) ? homeTeam : awayTeam;
  const defense: GameTeam =
    String(play.start.pos_team?.id ?? "") === String(homeTeam.id) ? awayTeam : homeTeam;

  const scoreText = (
    <>
      {" - "}
      {play.scoringPlay === true ? (
        <strong>
          {cleanAbbreviation(awayTeam)} {play.awayScore ?? 0}, {cleanAbbreviation(homeTeam)} {play.homeScore ?? 0}
        </strong>
      ) : (
        <>
          {cleanAbbreviation(awayTeam)} {play.awayScore ?? 0}, {cleanAbbreviation(homeTeam)} {play.homeScore ?? 0}
        </>
      )}
    </>
  );

  const collapseHref = `play-${collapsePrefix}-${play.game_play_number}`;
  const downText = play.penalty_assessed_on_kickoff
    ? "Assessed on Kickoff"
    : `${formatDistance(play.start.down, play.type?.text ?? "", play.start.distance, play.start.yardsToEndzone)} at ${formatYardline(play.start.yardsToEndzone, cleanAbbreviation(offense), cleanAbbreviation(defense), play.type?.text)}`;

  const fourthDownLink = `https://kazink.shinyapps.io/cfb_fourth_down/?team=${offense.location ?? ""}&pos_score=${play.start.pos_team_score ?? 0}&def_pos_score=${play.start.def_pos_team_score ?? 0}&pos_timeouts=${play.start.posTeamTimeouts ?? 0}&def_timeouts=${play.start.defTeamTimeouts ?? 0}&distance=${play.start.distance}&yards_to_goal=${play.start.yardsToEndzone}&qtr=${play.period ?? 0}&minutes=${play.clock?.minutes ?? 0}&seconds=${play.clock?.seconds ?? 0}&posteam_spread=${-1 * parseFloat(String(play.start.posTeamSpread ?? 0))}&vegas_ou=${play.overUnder ?? 0}&season=${play.season ?? 0}&pos_team_receives_2H_kickoff=${play.modelInputs?.start?.pos_team_receives_2H_kickoff ?? 0}&is_home=${play.modelInputs?.start?.is_home ?? 0}`;

  const rowProps: Record<string, unknown> = {
    class: `accordion-toggle${classText}`,
  };
  if (canCollapse) {
    rowProps["data-bs-toggle"] = "collapse";
    rowProps["href"] = `#${collapseHref}`;
  }
  return (
    <>
      <tr {...rowProps}>
        <td style="text-align: left;">{period}</td>
        <td style="text-align: center;">
          <a href={`/cfb/year/${play.season ?? ""}/team/${play.pos_team ?? ""}`}>
            <img
              class={`img-fluid team-logo-${play.pos_team}`}
              width="35px"
              src={`https://a.espncdn.com/i/teamlogos/ncaa/500/${play.pos_team}.png`}
              alt={`ESPN team id ${play.pos_team}`}
            />
          </a>
        </td>
        <td style="text-align: left;">
          ({downText}) {play.text}
          {scoreText}
        </td>
        <td class="numeral" style="text-align: center;">
          {roundNumber(parseFloat(String(play.expectedPoints?.added ?? 0)), 2, 2)}
        </td>
        <td class="numeral" style="text-align: center;">
          {roundNumber(parseFloat(String(play.winProbability?.before ?? 0)) * 100, 3, 1)}%
        </td>
        <td class="numeral" style="text-align: right;">
          {roundNumber(parseFloat(String(play.winProbability?.added ?? 0)) * 100, 3, 1)}%
        </td>
      </tr>
      {canCollapse && (
        <tr>
          <td colspan={6} class="hiddenRow">
            <div class="accordian-body collapse" id={collapseHref}>
              <div class="row p-1">
                <div class="ms-sm-auto col-lg-6">
                  <p style="text-align: center;">
                    <strong>Play Type:</strong> {play.type?.text}
                  </p>
                  <p style="text-align: center;">
                    <strong>Yards to End Zone (Before -&gt; After):</strong>{" "}
                    {play.start.yardsToEndzone} -&gt; {play.end.yardsToEndzone}
                  </p>
                  <p style="text-align: center;">
                    <strong>Started Drive at:</strong>{" "}
                    {formatYardline(play.drive_start ?? 0, cleanAbbreviation(offense), cleanAbbreviation(defense), play.type?.text)}
                  </p>
                  <p style="text-align: center;">
                    <strong>ExpPts (After - Before = Added):</strong>{" "}
                    {roundNumber(parseFloat(String(play.expectedPoints?.after ?? 0)), 2, 2)} -{" "}
                    {roundNumber(parseFloat(String(play.expectedPoints?.before ?? 0)), 2, 2)} ={" "}
                    {roundNumber(parseFloat(String(play.expectedPoints?.added ?? 0)), 2, 2)}
                  </p>
                  <p style="text-align: center;">
                    <strong>Score Difference (Before):</strong>{" "}
                    {play.start.pos_score_diff} (
                    {roundNumber(parseFloat(String(play.start.ExpScoreDiff ?? 0)), 2, 2)})
                  </p>
                  <p style="text-align: center;">
                    <strong>Score Difference (End):</strong> {play.end.pos_score_diff} (
                    {roundNumber(parseFloat(String(play.end.ExpScoreDiff ?? 0)), 2, 2)})
                  </p>
                  <p style="text-align: center;">
                    <strong>Change of Possession:</strong>{" "}
                    {play.change_of_poss === true || play.change_of_poss === 1 ? "1" : "0"}
                  </p>
                </div>
                <div class="ms-sm-auto col-lg-6">
                  <p style="text-align: center;">
                    <strong>Score:</strong> {cleanAbbreviation(awayTeam)} {play.awayScore ?? 0},{" "}
                    {cleanAbbreviation(homeTeam)} {play.homeScore ?? 0}
                  </p>
                  <p style="text-align: center;">
                    <strong>Drive Summary:</strong> {play.drive_play_index} play
                    {parseInt(String(play.drive_play_index ?? 0), 10) === 1 ? "" : "s"},{" "}
                    {play.drive_total_yards} yards
                  </p>
                  <p style="text-align: center;">
                    <strong>Win Probability (Before):</strong>{" "}
                    {roundNumber(parseFloat(String(play.winProbability?.before ?? 0)) * 100, 3, 1)}%
                  </p>
                  <p style="text-align: center;">
                    <strong>Win Probability (After):</strong>{" "}
                    {roundNumber(parseFloat(String(play.winProbability?.after ?? 0)) * 100, 3, 1)}%
                  </p>
                  <p style="text-align: center;">
                    <strong>Away Score:</strong> {play.start.awayScore ?? 0} ({play.awayScore ?? 0}){" "}
                    <strong>Home Score:</strong> {play.start.homeScore ?? 0} ({play.homeScore ?? 0})
                  </p>
                  <p style="text-align: center;">
                    <strong>Pos Team Timeouts:</strong> {play.end.posTeamTimeouts}{" "}
                    <strong>Defense Timeouts:</strong> {play.end.defPosTeamTimeouts}
                  </p>
                  {play.start.down === 4 && (
                    <p style="text-align: center;">
                      <strong>Fouth Down Decision Evaluation:</strong>{" "}
                      <a href={fourthDownLink} target="__blank">
                        link
                      </a>
                    </p>
                  )}
                </div>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
};

const PlayTable: FC<{
  plays: PlayRecord[] | undefined;
  prefix: string;
  expandable: boolean;
  errorMsg: string;
  showGuide: boolean;
  homeTeam: GameTeam;
  awayTeam: GameTeam;
}> = ({ plays, prefix, expandable, errorMsg, showGuide, homeTeam, awayTeam }) => {
  if (plays == null || plays.length === 0) {
    return <p class="text-center text-muted">{errorMsg}</p>;
  }
  return (
    <table class="table table-sm table-responsive" style="border-collapse:collapse;">
      {showGuide && (
        <caption>
          Play shading guide:
          <ul>
            <li>
              <strong>Yellow</strong> - penalty
            </li>
            <li>
              <strong>Red</strong> - turnover
            </li>
            <li>
              <strong>Green</strong> - scoring play
            </li>
          </ul>
        </caption>
      )}
      <thead>
        <tr>
          <th style="text-align: left;">Time</th>
          <th style="text-align: center;">Offense</th>
          <th style="text-align: left;">Play Description</th>
          <th style="text-align: center;">EPA</th>
          <th style="text-align: center;">WP%</th>
          <th style="text-align: right;">WPA</th>
        </tr>
      </thead>
      <tbody>
        {plays.map((p) => (
          <PlayRow
            play={p}
            canCollapse={expandable}
            collapsePrefix={prefix}
            homeTeam={homeTeam}
            awayTeam={awayTeam}
          />
        ))}
      </tbody>
    </table>
  );
};

// game.ejs:306-394. Drive row + expandable field-chart panel.
const DriveRow: FC<{
  drive: DriveRecord;
  canCollapse: boolean;
  collapsePrefix: string;
  plays: PlayRecord[];
  homeTeam: GameTeam;
  awayTeam: GameTeam;
  isNeutralSite: boolean;
}> = ({ drive, canCollapse, collapsePrefix, plays, homeTeam, awayTeam, isNeutralSite }) => {
  const drivePlays = plays.filter((p) => String(p["drive.id"]) === String(drive.id));
  if (drivePlays.length === 0) return null;
  const firstPlay = drivePlays[0];
  const offense: GameTeam = String(firstPlay.pos_team) === String(homeTeam.id) ? homeTeam : awayTeam;
  const defense: GameTeam = String(firstPlay.pos_team) === String(homeTeam.id) ? awayTeam : homeTeam;
  const period = formatPeriod(firstPlay.period ?? 0, firstPlay.clock);
  const result = String(drive.result ?? "");

  let classText = "";
  if (["TURNOVER", "DOWNS", "MISSED FG", "FUMBLE", "SAFETY", "INT"].includes(result)) {
    classText = " table-danger";
  } else if (["TD", "FG"].includes(result)) {
    classText = " table-success";
  }

  const maxEPAPlay = drivePlays.reduce<PlayRecord>(
    (prev, current) => (prev && (prev.EPA ?? -Infinity) > (current.EPA ?? -Infinity) ? prev : current),
    drivePlays[0],
  );
  const maxWPAPlay = drivePlays.reduce<PlayRecord>(
    (prev, current) => (prev && (prev.WPA ?? -Infinity) > (current.WPA ?? -Infinity) ? prev : current),
    drivePlays[0],
  );
  const epaDownText = maxEPAPlay.penalty_assessed_on_kickoff
    ? "Assessed on Kickoff"
    : `${formatDistance(maxEPAPlay.start.down, maxEPAPlay.type?.text ?? "", maxEPAPlay.start.distance, maxEPAPlay.start.yardsToEndzone)} at ${formatYardline(maxEPAPlay.start.yardsToEndzone, cleanAbbreviation(offense), cleanAbbreviation(defense), maxEPAPlay.type?.text)}`;
  const wpaDownText = maxWPAPlay.penalty_assessed_on_kickoff
    ? "Assessed on Kickoff"
    : `${formatDistance(maxWPAPlay.start.down, maxWPAPlay.type?.text ?? "", maxWPAPlay.start.distance, maxWPAPlay.start.yardsToEndzone)} at ${formatYardline(maxWPAPlay.start.yardsToEndzone, cleanAbbreviation(offense), cleanAbbreviation(defense), maxWPAPlay.type?.text)}`;

  const totalEPA = drivePlays.reduce((acc, p) => acc + (p.EPA ?? 0), 0);
  const avgEPA = drivePlays.length === 0 ? 0 : totalEPA / drivePlays.length;
  const totalSuccess = drivePlays.reduce((acc, p) => acc + (p.EPA_success ?? 0), 0);
  const avgSR = drivePlays.length === 0 ? 0 : totalSuccess / drivePlays.length;
  const startWP = drivePlays[0].winProbability?.before ?? 0;
  const lastPlay = drivePlays[drivePlays.length - 1];
  const endWP = lastPlay.winProbability?.after ?? 0;

  const driveCollapseId = `drive-${collapsePrefix}-${drive.id}`;
  const fieldScript = buildFieldRenderScript({
    driveId: drive.id,
    plays: drivePlays as unknown as FieldChartPlay[],
    offense: offense as FieldChartTeam,
    defense: defense as FieldChartTeam,
    homeTeamId: homeTeam.id ?? 0,
    result,
    isNeutralSite,
    subtitle: `${offense.abbreviation ?? ""} - ${result || drive.displayResult || "In Progress"} - ${drive.description ?? ""}`,
  });

  const rowProps: Record<string, unknown> = {
    class: `accordion-toggle${classText}`,
  };
  if (canCollapse) {
    rowProps["data-bs-toggle"] = "collapse";
    rowProps["href"] = `#${driveCollapseId}`;
    rowProps["onclick"] = `render${drive.id}()`;
  }

  return (
    <>
      <tr {...rowProps}>
        <td style="text-align: left;vertical-align:center;">{period}</td>
        <td style="text-align: center;vertical-align:center;">
          <img
            class={`img-fluid team-logo-${offense.id}`}
            width="35px"
            src={`https://a.espncdn.com/i/teamlogos/ncaa/500/${offense.id}.png`}
            alt={`ESPN team id ${offense.id}`}
          />
        </td>
        <td style="text-align: left;vertical-align:center;">{drive.displayResult || "In Progress"}</td>
        <td style="text-align: left;vertical-align:center;">{drive.description}</td>
        <td class="d-none d-xl-table-cell" style="text-align: center;vertical-align:center;">
          {roundNumber(totalEPA, 2, 2)}
        </td>
        <td class="d-none d-xl-table-cell" style="text-align: center;vertical-align:center;">
          {roundNumber(startWP * 100, 3, 1)}%
        </td>
        <td class="d-none d-xl-table-cell" style="text-align: center;vertical-align:center;">
          {roundNumber(endWP * 100, 3, 1)}%
        </td>
      </tr>
      {canCollapse && (
        <tr>
          <td colspan={7} class="hiddenRow">
            <div class="accordian-body collapse" id={driveCollapseId}>
              <div class="row p-1">
                <div class="ms-sm-auto col-12 mb-3">
                  <p class="m-0 mb-1">
                    <strong>Drive Chart</strong> <span>(Direction of play - left to right)</span>:
                  </p>
                  <canvas id={`football-field-${drive.id}`}></canvas>
                  <script
                    dangerouslySetInnerHTML={{
                      __html: `function render${drive.id}() {\n${fieldScript}\n}`,
                    }}
                  ></script>
                  <p class="m-0 text-muted">
                    <small>
                      Note: vertical position of plays on chart does not indicate actual vertical
                      position on field.
                    </small>
                  </p>
                </div>
                <p class="m-0">
                  <strong>EPA/Play:</strong> <span>{roundNumber(avgEPA, 2, 2)}</span>
                </p>
                <p class="m-0">
                  <strong>Success Rate:</strong> <span>{roundNumber(avgSR * 100, 3, 1)}%</span>
                </p>
                <p class="m-0">
                  <strong>Biggest Play:</strong>{" "}
                  <span>
                    ({epaDownText}) {maxEPAPlay.text} - EPA:{" "}
                    {roundNumber(parseFloat(String(maxEPAPlay.EPA ?? 0)), 2, 2)}
                  </span>
                </p>
                <p class="m-0">
                  <strong>Most Important Play:</strong>{" "}
                  <span>
                    ({wpaDownText}) {maxWPAPlay.text} - WPA:{" "}
                    {roundNumber(parseFloat(String(maxWPAPlay.winProbability?.added ?? 0)) * 100, 3, 1)}
                    %
                  </span>
                </p>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
};

const DrivesTable: FC<{
  drives: DriveRecord[] | undefined;
  prefix: string;
  expandable: boolean;
  errorMsg: string;
  showGuide: boolean;
  plays: PlayRecord[];
  homeTeam: GameTeam;
  awayTeam: GameTeam;
  isNeutralSite: boolean;
}> = ({ drives, prefix, expandable, errorMsg, showGuide, plays, homeTeam, awayTeam, isNeutralSite }) => {
  if (drives == null || drives.length === 0) {
    return <p class="text-center text-muted">{errorMsg}</p>;
  }
  // game.ejs:424-453: hydrate start.period.number and
  // start.clock.game_play_number from the first play of each drive,
  // then sort by period → game_play_number → id.
  const enriched = drives.map((d) => {
    const drivePlays = plays.filter((p) => String(p["drive.id"]) === String(d.id));
    const firstPlay = drivePlays[0];
    const next: DriveRecord = { ...d };
    next.start = {
      ...(d.start ?? {}),
      period: { ...(d.start?.period ?? {}), number: firstPlay?.period },
      clock: { ...(d.start?.clock ?? {}), game_play_number: firstPlay?.game_play_number },
    };
    return next;
  });
  enriched.sort((a, b) => {
    const ap = a.start?.period?.number ?? 0;
    const bp = b.start?.period?.number ?? 0;
    if (ap !== bp) return ap < bp ? -1 : 1;
    const ag = a.start?.clock?.game_play_number ?? 0;
    const bg = b.start?.clock?.game_play_number ?? 0;
    if (ag !== bg) return ag < bg ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });
  return (
    <table class="table table-sm table-responsive" style="border-collapse:collapse;">
      {showGuide && (
        <caption>
          Drive shading guide:
          <ul>
            <li>
              <strong>Red</strong> - turnover
            </li>
            <li>
              <strong>Green</strong> - scoring drive
            </li>
          </ul>
        </caption>
      )}
      <thead>
        <tr>
          <th style="text-align: left;vertical-align:center;">Start</th>
          <th style="text-align: center;vertical-align:center;">Offense</th>
          <th style="text-align: left;vertical-align:center;">Result</th>
          <th style="text-align: left;vertical-align:center;">Description</th>
          <th class="d-none d-xl-table-cell" style="text-align: center;vertical-align:center;">
            EPA
          </th>
          <th class="d-none d-xl-table-cell" style="text-align: center;vertical-align:center;">
            Start WP%
          </th>
          <th class="d-none d-xl-table-cell" style="text-align: center;vertical-align:center;">
            End WP%
          </th>
        </tr>
      </thead>
      <tbody>
        {enriched.map((d) => (
          <DriveRow
            drive={d}
            canCollapse={expandable}
            collapsePrefix={prefix}
            plays={plays}
            homeTeam={homeTeam}
            awayTeam={awayTeam}
            isNeutralSite={isNeutralSite}
          />
        ))}
      </tbody>
    </table>
  );
};

// game.ejs:618-672. The score header above the nav scroller.
const ScoreHeader: FC<{
  homeTeam: GameTeam;
  awayTeam: GameTeam;
  homeComp: GameCompetitor;
  awayComp: GameCompetitor;
  championship: boolean;
  gameNote: string;
  networkLink: string | null;
  networkName: string | null;
  actionPrefix: string | null;
}> = ({ homeTeam, awayTeam, homeComp, awayComp, championship, gameNote, networkLink, networkName, actionPrefix }) => (
  <header class="blog-header py-3">
    <div class="row flex-nowrap justify-content-between align-items-center">
      <div class="col-2 pt-1">
        <a class="btn btn-sm btn-outline-primary align-middle" href="/">
          <i class="bi-arrow-left"></i>
        </a>
      </div>
      <div class="col-8 text-center">
        <div>
          <h2 class="mb-0">
            {cleanName(awayTeam)} {awayComp.score ?? 0} @ {cleanName(homeTeam)} {homeComp.score ?? 0}
          </h2>
          {gameNote !== "" && (
            <p class={`text-small mt-0 mb-3 ${championship ? "championship-text" : "text-primary"}`}>
              <strong>{gameNote}</strong>
            </p>
          )}
          <p class="text-small m-0" id="game-date"></p>
        </div>
      </div>
      <div class="col-2 d-flex justify-content-end align-items-center">
        {networkLink && actionPrefix && (
          <a class="btn btn-sm btn-outline-secondary" href={networkLink} target="_blank">
            {actionPrefix} ({networkName})
          </a>
        )}
        {!networkLink && networkName != null && actionPrefix && NETWORK_MAPPINGS[networkName] && (
          <a class="btn btn-sm btn-outline-secondary" href={NETWORK_MAPPINGS[networkName]} target="_blank">
            {actionPrefix} ({networkName})
          </a>
        )}
      </div>
    </div>
  </header>
);

// Shorthand for the in-progress / live scoreboard subtitle. game.ejs:712-728.
function spreadDisplay(
  homeTeamSpread: number | string | undefined,
  homeTeam: GameTeam,
  awayTeam: GameTeam,
): string {
  const v = parseFloat(String(homeTeamSpread ?? 0));
  if (v > 0) return `${cleanAbbreviation(homeTeam)} -${homeTeamSpread}`;
  if (v < 0) return `${cleanAbbreviation(awayTeam)} ${homeTeamSpread}`;
  return "PUSH";
}

// Page status helpers.
function gameStarted(status: GameInfo["status"], plays: PlayRecord[]): boolean {
  const name = status?.type?.name ?? "";
  const completed = status?.type?.completed === true;
  const inProgress = name.includes("STATUS_IN_PROGRESS");
  const endPeriod = name.includes("STATUS_END_PERIOD");
  const halftime = name.includes("STATUS_HALFTIME");
  const delayed = name.includes("STATUS_DELAYED") && plays.length > 0;
  return completed || inProgress || endPeriod || halftime || delayed;
}

export const GamePage: FC<Props> = ({ gameData, percentiles, season }) => {
  const gameInfo = gameData.gameInfo ?? {};
  const homeComp = gameInfo.competitors?.[0] ?? {};
  const awayComp = gameInfo.competitors?.[1] ?? {};
  const homeTeam: GameTeam = homeComp.team ?? {};
  const awayTeam: GameTeam = awayComp.team ?? {};
  const homeTeamId = homeTeam.id ?? gameData.homeTeamId ?? "";
  const awayTeamId = awayTeam.id ?? gameData.awayTeamId ?? "";
  const isNeutralSite = gameInfo.neutralSite === true;
  const plays = gameData.plays ?? [];
  const completed = gameInfo.status?.type?.completed === true;
  const inProgress = (gameInfo.status?.type?.name ?? "").includes("STATUS_IN_PROGRESS");

  const advBoxScore = (gameData.advBoxScore ?? {}) as AdvBoxScore;
  // Sort once at render time so all eight box-score tables emit cells
  // in away-then-home order.
  if (homeTeamId && awayTeamId) {
    sortAdvBoxScoreInPlace(
      advBoxScore as Record<string, Array<Record<string, unknown>>>,
      awayTeamId,
      homeTeamId,
    );
  }
  const teamData = advBoxScore.team ?? [];

  const gameNote = String(gameData.header?.gameNote ?? "");
  const championship = isChampionshipEvent(gameNote);

  const title =
    completed || inProgress
      ? `Game: ${cleanName(awayTeam)} ${awayComp.score ?? 0}, ${cleanName(homeTeam)} ${homeComp.score ?? 0} | Game on Paper`
      : `Game: ${cleanName(awayTeam)} vs ${cleanName(homeTeam)} | Game on Paper`;
  const subtitle = `${cleanName(awayTeam)} vs ${cleanName(homeTeam)}`;
  const canonical = `https://gameonpaper.com/cfb/game/${gameInfo.id ?? ""}`;

  const networkName = gameInfo.broadcasts?.[0]?.media?.shortName ?? null;
  let actionPrefix: string | null = "Watch";
  if (completed) actionPrefix = "Replay";
  else if (
    !(inProgress || (gameInfo.status?.type?.name ?? "").includes("STATUS_END_PERIOD") || (gameInfo.status?.type?.name ?? "").includes("STATUS_HALFTIME"))
  ) {
    actionPrefix = null;
  }
  const networkLink = networkName != null && ESPN_NETWORK_MARKERS.some((m) => networkName.includes(m))
    ? `https://www.espn.com/watch/player/_/eventCalendarId/${gameInfo.id ?? ""}`
    : null;

  // Per-team dark-mode logo CSS (game.ejs is wired up via the `logos`
  // partial; we inline it here with the same Georgia override).
  const darkLogoCss = `@media (prefers-color-scheme: dark) {
  img.team-logo-${homeTeam.id} { content: url('https://a.espncdn.com/i/teamlogos/ncaa/500-dark/${homeTeam.id}.png'); }
  img.team-logo-${awayTeam.id} { content: url('https://a.espncdn.com/i/teamlogos/ncaa/500-dark/${awayTeam.id}.png'); }
}
img.team-logo-61 { content: url('/assets/img/ennui-uga.png'); }`;

  const extraHead = (
    <>
      <link href="/assets/css/bootstrap.min.css" rel="stylesheet" crossorigin="anonymous" />
      <link href="/assets/css/dashboard.css" rel="stylesheet" />
      <link href="/assets/css/blog.css" rel="stylesheet" />
      <link href="/assets/css/dark-game.css" rel="stylesheet" />
      <link href="/assets/css/bootstrap-icons/bootstrap-icons.css" rel="stylesheet" />
      {championship && <link href="/assets/css/championship.css" rel="stylesheet" />}
      {/* field.js exposes the global Field class consumed by the per-drive
          renderXXX() blocks emitted in DriveRow. Loaded in <head> so the
          inline scripts in <body> can call it without a defer race. */}
      <script src="/assets/js/field.js"></script>
      <meta property="og:image" content={`https://s.espncdn.com/stitcher/sports/football/college-football/events/${gameInfo.id ?? ""}.png?templateId=espn.com.share.1`} />
      <meta property="og:image:width" content="1200" />
      <meta property="og:image:height" content="630" />
      <style dangerouslySetInnerHTML={{ __html: darkLogoCss }} />
    </>
  );

  const extraScripts = (
    <>
      <script src="/assets/js/feather.min.js" crossorigin="anonymous"></script>
      <script src="/assets/js/Chart.min.js" crossorigin="anonymous"></script>
      <script
        dangerouslySetInnerHTML={{
          __html: `var gameData = ${JSON.stringify(gameData)};
const DateTime = luxon.DateTime;
var statusDetail = gameData.gameInfo.status.type.detail;
var statusDescription = gameData.gameInfo.status.type.description ?? "Scheduled";
if (gameData.gameInfo.status.type.completed == true || statusDescription.includes("Cancel") || statusDescription.includes("Postpone") || statusDescription.includes("Delay")) {
  document.body.querySelector("#game-date").innerText = statusDescription + " - " + DateTime.fromISO(gameData.gameInfo.date).toLocaleString(DateTime.DATETIME_FULL);
} else {
  document.body.querySelector("#game-date").innerText = "LIVE - " + statusDetail;
  setTimeout("location.reload(true);", 60 * 1000);
}`,
        }}
      ></script>
      <script src="/assets/js/dashboard.js"></script>
    </>
  );

  // WP / EP block visibility — game.ejs:692-742 gates on the player
  // having actual plays. Status-bar gates the block below.
  const showCharts = plays.length > 0;
  const showAfterCharts = gameStarted(gameInfo.status, plays);

  const lastPlay = plays[plays.length - 1] as PlayRecord | undefined;
  const geiVal = gameInfo.gei != null ? Math.round(gameInfo.gei * 100) / 100 : null;
  const geiBands = geiVal != null ? geiPercentileBands(geiVal, percentiles) : null;
  const geiTitle = geiBands
    ? `%ile: ${geiBands.pctl != null ? getNumberWithOrdinal(geiBands.pctl) : "N/A"}\nMost Boring: ${geiBands.min ?? ""}\nMedian: ${geiBands.mid ?? ""}\nMost Exciting: ${geiBands.max ?? ""}`
    : "";

  // Per-team player-stats data slices (game.ejs:1090-1107).
  const homeBox = {
    pass: [...(advBoxScore.pass ?? [])]
      .filter((g) => String(g.pos_team) === String(homeTeamId))
      .sort((a, b) => parseFloat(String(b.EPA ?? 0)) - parseFloat(String(a.EPA ?? 0))),
    rush: [...(advBoxScore.rush ?? [])]
      .filter((g) => String(g.pos_team) === String(homeTeamId))
      .sort((a, b) => parseFloat(String(b.EPA ?? 0)) - parseFloat(String(a.EPA ?? 0))),
    receiver: [...(advBoxScore.receiver ?? [])]
      .filter((g) => String(g.pos_team) === String(homeTeamId))
      .sort((a, b) => parseFloat(String(b.EPA ?? 0)) - parseFloat(String(a.EPA ?? 0))),
  };
  const awayBox = {
    pass: [...(advBoxScore.pass ?? [])]
      .filter((g) => String(g.pos_team) === String(awayTeamId))
      .sort((a, b) => parseFloat(String(b.EPA ?? 0)) - parseFloat(String(a.EPA ?? 0))),
    rush: [...(advBoxScore.rush ?? [])]
      .filter((g) => String(g.pos_team) === String(awayTeamId))
      .sort((a, b) => parseFloat(String(b.EPA ?? 0)) - parseFloat(String(a.EPA ?? 0))),
    receiver: [...(advBoxScore.receiver ?? [])]
      .filter((g) => String(g.pos_team) === String(awayTeamId))
      .sort((a, b) => parseFloat(String(b.EPA ?? 0)) - parseFloat(String(a.EPA ?? 0))),
  };

  // Big plays / most-important plays (game.ejs:1300-1325).
  const bigPlays = [...plays]
    .sort(
      (a, b) =>
        Math.abs(b.expectedPoints?.added ?? 0) - Math.abs(a.expectedPoints?.added ?? 0),
    )
    .slice(0, 10);
  const mostImpPlays = [...plays]
    .sort(
      (a, b) =>
        Math.abs(b.winProbability?.added ?? 0) - Math.abs(a.winProbability?.added ?? 0),
    )
    .slice(0, 10);

  // Drives section (game.ejs:1387-1402).
  const curDrive = gameData.drives?.current;
  const prevDrives = gameData.drives?.previous ?? [];
  const validCurrent =
    curDrive != null && prevDrives.find((d) => d.id === curDrive.id) === undefined ? [curDrive] : [];
  let gameDrives: DriveRecord[] = [...prevDrives, ...validCurrent];
  if (gameDrives.length > 0) {
    const validDriveIds = unique(plays.map((p) => p["drive.id"]).filter((x): x is string | number => x != null));
    const validSet = new Set(validDriveIds.map((x) => String(x)));
    gameDrives = gameDrives.filter((d) => validSet.has(String(d.id)));
  }
  const drivesSubtitle = !completed ? "Most recent drives first." : "";
  const playsForTable = !completed ? [...plays].reverse() : [...plays];
  if (!completed) gameDrives = [...gameDrives].reverse();

  const allPlaysSubtitle = !completed
    ? "Most recent plays first. Recent plays may have weird EPA/WPA results due to ESPN data weirdness."
    : "";

  const statusDetail = gameInfo.status?.type?.detail ?? "";
  const showAutoRefreshNote = !(
    statusDetail.includes("F") ||
    statusDetail.includes("Cancel") ||
    statusDetail.includes("Postpone") ||
    statusDetail.includes("Delay")
  );

  return (
    <Layout title={title} subtitle={subtitle} canonical={canonical} extraHead={extraHead} extraScripts={extraScripts}>
      <div class="container-fluid">
        <ScoreHeader
          homeTeam={homeTeam}
          awayTeam={awayTeam}
          homeComp={homeComp}
          awayComp={awayComp}
          championship={championship}
          gameNote={gameNote}
          networkLink={networkLink}
          networkName={networkName}
          actionPrefix={actionPrefix}
        />

        <div class="nav-scroller py-1 mb-3">
          <nav class="nav d-flex justify-content-between">
            <a href="#wpChart" class="p-2 link-secondary">WP Chart</a>
            <a href="#epChart" class="p-2 link-secondary">EPA Chart</a>
            <a href="#team-stats" class="p-2 link-secondary">Team Stats</a>
            <a href="#player-stats" class="p-2 link-secondary">Player Stats</a>
            <a href="#big-plays" class="p-2 link-secondary">Big Plays</a>
            <a href="#most-imp-plays" class="p-2 link-secondary">Most Important Plays</a>
            <a href="#scoring-plays" class="p-2 link-secondary">Scoring Plays</a>
            <a href="#drives" class="p-2 link-secondary">Drives</a>
            <a href="#all-plays" class="p-2 link-secondary">All Plays</a>
            <a href={`/cfb/game/${gameInfo.id ?? ""}?preview_mode=new`} class="p-2 link-secondary">Matchup Preview</a>
            <a class="p-2 link-secondary" href={`https://www.espn.com/college-football/game/_/gameId/${gameInfo.id ?? ""}`}>Gamecast</a>
          </nav>
        </div>
      </div>

      <div class="container-fluid">
        {showCharts && (
          <div class="row mb-3">
            <main class="ms-sm-auto col-lg-6 px-md-4">
              <div>
                <h2 class="mb-0">Win Probability</h2>
                {lastPlay?.gameSpreadAvailable === false && (
                  <p class="m-0 text-muted text-small">
                    ESPN does not list betting odds for this game, so we've used default values:{" "}
                    {cleanAbbreviation(homeTeam)} -2.5, O/U 55.5.
                  </p>
                )}
                <p class="text-small">
                  {completed && geiVal != null && geiBands && (
                    <>
                      <a
                        href="https://www.opensourcefootball.com/posts/2020-08-21-game-excitement-and-win-probability-in-the-nfl/"
                        title="Measures 'game excitement' by absolute changes in win probability. May not match eye-test in games with heavy favorites."
                      >
                        Game Excitement Index:
                      </a>{" "}
                      <span class={`px-1${geiBands.ramp_class}`} title={geiTitle}>
                        {geiVal.toFixed(2)}
                      </span>{" "}
                      |{" "}
                    </>
                  )}
                  Odds: {spreadDisplay(gameData.homeTeamSpread, homeTeam, awayTeam)}, O/U{" "}
                  {roundNumber(parseFloat(String(gameData.overUnder ?? 0)), 2, 1)}
                  {(inProgress ||
                    (gameInfo.status?.type?.name ?? "").includes("STATUS_END_PERIOD") ||
                    (gameInfo.status?.type?.name ?? "").includes("STATUS_HALFTIME")) &&
                    plays.length > 0 &&
                    lastPlay && (
                      <>
                        {" | Current: "}
                        {(lastPlay.winProbability?.before ?? 0) >= 0.5
                          ? `${String(lastPlay.pos_team) === String(homeTeamId) ? cleanAbbreviation(homeTeam) : cleanAbbreviation(awayTeam)} ${(Math.round((lastPlay.winProbability?.before ?? 0) * 1000) / 1000 * 100).toFixed(1)}%`
                          : `${String(lastPlay.pos_team) === String(homeTeamId) ? cleanAbbreviation(awayTeam) : cleanAbbreviation(homeTeam)} ${(Math.round((1 - (lastPlay.winProbability?.before ?? 0)) * 1000) / 1000 * 100).toFixed(1)}%`}
                      </>
                    )}{" "}
                  |{" "}
                  <a id="wp-download" download={`game-wp-${gameInfo.id ?? ""}.jpg`} href="">
                    Download Chart
                  </a>
                </p>
              </div>
              <canvas class="my-4 w-100" id="wpChart" width="900" height="380"></canvas>
            </main>
            <main class="ms-sm-auto col-lg-6 px-md-4">
              <div>
                <h2 class="mb-0">Expected Points</h2>
                <p class="text-small">
                  <a id="ep-download" download={`game-ep-${gameInfo.id ?? ""}.jpg`} href="">
                    Download Chart
                  </a>
                </p>
              </div>
              <canvas class="my-4 w-100" id="epChart" width="900" height="380"></canvas>
            </main>
          </div>
        )}

        {showAfterCharts && (
          <>
            <div id="team-stats" class="row mb-3">
              <div class="col-md-12 ms-sm-auto col-lg-12 px-md-4">
                <h2 class="d-inline">
                  Team Stats{" "}
                  <span class="d-inline text-small h6">
                    <a data-bs-toggle="collapse" href="#boxScoreContent" style="text-decoration: none;" role="button" aria-expanded="true">
                      [show/hide]
                    </a>
                  </span>
                </h2>
                <div class="panel-group">
                  <div class="panel panel-default">
                    <div id="boxScoreContent" class="panel-collapse show">
                      <div class="panel-body">
                        <div class="row">
                          <div class="col-md-4 ms-sm-auto col-lg-4">
                            <SlimBoxScore advBoxScore={advBoxScore} percentiles={percentiles} season={season} />
                            <BoxScoreTable
                              title="Expected Points"
                              columns={["EPA_plays", "EPA_overall_total", "EPA_overall_offense", "EPA_special_teams", "EPA_penalty"]}
                              data={teamData}
                              useSuffix={true}
                              decimalPoints={2}
                              advBoxScore={advBoxScore}
                              season={season}
                              caption={
                                <caption class="text-muted text-small">
                                  Totals may not add up due to plays fitting in multiple categories (e.g. a penalty on a punt).
                                </caption>
                              }
                            />
                            <BoxScoreTable
                              title="Production"
                              columns={["scrimmage_plays", "off_yards", "yards_per_play", "EPA_overall_off", "EPA_per_play", "passes", "pass_yards", "yards_per_pass", "EPA_passing_overall", "EPA_passing_per_play", "rushes", "rush_yards", "yards_per_rush", "EPA_rushing_overall", "EPA_rushing_per_play"]}
                              data={teamData}
                              useSuffix={true}
                              decimalPoints={2}
                              advBoxScore={advBoxScore}
                              season={season}
                            />
                            <BoxScoreTable
                              title="Rushing"
                              columns={["scrimmage_plays", "rushes", "rushing_power", "rushing_power_success", "rushing_stuff", "rushing_stopped", "rushing_opportunity", "line_yards", "line_yards_per_carry", "rushing_highlight_yards", "rushing_highlight_yards_per_opp"]}
                              data={teamData}
                              useSuffix={true}
                              decimalPoints={2}
                              advBoxScore={advBoxScore}
                              season={season}
                            />
                          </div>
                          <div class="col-md-4 ms-sm-auto col-lg-4">
                            <BoxScoreTable
                              title="Explosiveness"
                              columns={["EPA_plays", "scrimmage_plays", "EPA_explosive", "EPA_explosive_passing", "EPA_explosive_rushing", "EPA_non_explosive", "EPA_non_explosive_per_play", "EPA_non_explosive_passing", "EPA_non_explosive_passing_per_play", "EPA_non_explosive_rushing", "EPA_non_explosive_rushing_per_play"]}
                              data={teamData}
                              useSuffix={true}
                              decimalPoints={2}
                              advBoxScore={advBoxScore}
                              season={season}
                            />
                            <BoxScoreTable
                              title="Situational"
                              columns={[
                                "EPA_success",
                                "EPA_success_pass",
                                "EPA_success_rush",
                                "EPA_success_standard_down",
                                "EPA_success_passing_down",
                                "EPA_success_early_down",
                                "EPA_success_late_down",
                                "EPA_middle_8_success",
                                "early_downs",
                                "early_down_first_down",
                                "EPA_early_down",
                                "EPA_early_down_per_play",
                                "early_down_pass",
                                "early_down_rush",
                                "EPA_success_early_down_pass",
                                "EPA_success_early_down_rush",
                                "late_downs",
                                "EPA_late_down",
                                "EPA_late_down_per_play",
                                "late_down_pass",
                                "late_down_rush",
                                "EPA_success_late_down_pass",
                                "EPA_success_late_down_rush",
                                "late_down_avg_distance",
                                "middle_8",
                                "EPA_middle_8",
                                "EPA_middle_8_per_play",
                                "middle_8_pass",
                                "middle_8_rush",
                                "EPA_middle_8_success_pass",
                                "EPA_middle_8_success_rush",
                              ]}
                              data={advBoxScore.situational ?? []}
                              useSuffix={true}
                              decimalPoints={2}
                              advBoxScore={advBoxScore}
                              season={season}
                            />
                          </div>
                          <div class="col-md-4 ms-sm-auto col-lg-4">
                            <BoxScoreTable
                              title="Drives"
                              columns={["drives", "avg_field_position", "plays_per_drive", "yards_per_drive", "drive_total_gained_yards_rate"]}
                              data={advBoxScore.drives ?? []}
                              useSuffix={false}
                              decimalPoints={2}
                              advBoxScore={advBoxScore}
                              season={season}
                            />
                            <BoxScoreTable
                              title="Defensive"
                              columns={["scrimmage_plays", "drive_stopped_rate", "havoc_total", "havoc_total_pass", "havoc_total_rush", "TFL", "TFL_pass", "TFL_rush", "sacks", "PD", "def_int", "fumbles"]}
                              data={advBoxScore.defensive ?? []}
                              useSuffix={true}
                              decimalPoints={1}
                              advBoxScore={advBoxScore}
                              season={season}
                              teamKey="def_pos_team"
                            />
                            <BoxScoreTable
                              title="Turnovers"
                              columns={["turnovers", "total_fumbles", "fumbles_lost", "fumbles_recovered", "Int", "turnover_margin", "expected_turnovers", "expected_turnover_margin", "turnover_luck"]}
                              data={advBoxScore.turnover ?? []}
                              useSuffix={true}
                              decimalPoints={1}
                              advBoxScore={advBoxScore}
                              season={season}
                            />
                            <BoxScoreTable
                              title="Special Teams"
                              columns={["special_teams_plays", "EPA_sp", "EPA_fg", "EPA_punt", "EPA_kickoff"]}
                              data={teamData}
                              useSuffix={false}
                              decimalPoints={2}
                              advBoxScore={advBoxScore}
                              season={season}
                            />
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div id="player-stats" class="row mb-3">
              <PlayerStatsPanel
                team={awayTeam}
                collapseId="awayTeamCollapse"
                passRows={awayBox.pass}
                rushRows={awayBox.rush}
                receiverRows={awayBox.receiver}
                plays={plays.filter((p) => String(p.pos_team) === String(awayTeamId))}
                season={season}
              />
              <PlayerStatsPanel
                team={homeTeam}
                collapseId="homeTeamCollapse"
                passRows={homeBox.pass}
                rushRows={homeBox.rush}
                receiverRows={homeBox.receiver}
                plays={plays.filter((p) => String(p.pos_team) === String(homeTeamId))}
                season={season}
              />
            </div>
          </>
        )}

        <div class="row mb-3">
          <div class="col-lg-6 ms-sm-auto px-md-4" id="big-plays">
            <div class="panel-group">
              <div class="panel panel-default">
                <div class="panel-heading">
                  <div class="panel-title">
                    <h2>
                      Big Plays{" "}
                      <span class="d-inline text-small h6">
                        <a data-bs-toggle="collapse" href="#bigPlaysTable" style="text-decoration: none;" role="button" aria-expanded="true">
                          [show/hide]
                        </a>
                      </span>
                    </h2>
                    <p class="text-small">As determined by absolute EPA.</p>
                  </div>
                </div>
                <div id="bigPlaysTable" class="panel-collapse collapse">
                  <div class="panel-body">
                    <div class="table-responsive">
                      <PlayTable
                        plays={bigPlays}
                        prefix="big-play"
                        expandable={true}
                        errorMsg="No big plays listed for this game."
                        showGuide={false}
                        homeTeam={homeTeam}
                        awayTeam={awayTeam}
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div class="col-lg-6 ms-sm-auto px-md-4" id="most-imp-plays">
            <div class="panel-group">
              <div class="panel panel-default">
                <div class="panel-heading">
                  <div class="panel-title">
                    <h2>
                      Most Important Plays{" "}
                      <span class="d-inline text-small h6">
                        <a data-bs-toggle="collapse" href="#importantPlaysTable" style="text-decoration: none;" role="button" aria-expanded="true">
                          [show/hide]
                        </a>
                      </span>
                    </h2>
                    <p class="text-small">As determined by absolute WPA.</p>
                  </div>
                </div>
                <div id="importantPlaysTable" class="panel-collapse collapse">
                  <div class="panel-body">
                    <div class="table-responsive">
                      <PlayTable
                        plays={mostImpPlays}
                        prefix="most-imp-play"
                        expandable={true}
                        errorMsg="No important plays listed for this game."
                        showGuide={false}
                        homeTeam={homeTeam}
                        awayTeam={awayTeam}
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="row mb-3">
          <main class="col-lg-6 ms-sm-auto px-md-4">
            <div class="panel-group">
              <div class="panel panel-default">
                <div class="panel-heading">
                  <div class="panel-title">
                    <h2 id="scoring-plays">
                      Scoring Plays{" "}
                      <span class="d-inline text-small h6">
                        <a data-bs-toggle="collapse" href="#scoringPlayTable" style="text-decoration: none;" role="button" aria-expanded="true">
                          [show/hide]
                        </a>
                      </span>
                    </h2>
                  </div>
                </div>
                <div id="scoringPlayTable" class="panel-collapse collapse">
                  <div class="panel-body">
                    <div class="table-responsive">
                      <PlayTable
                        plays={(gameData.scoringPlays as PlayRecord[] | undefined) ?? []}
                        prefix="scoring-play"
                        expandable={true}
                        errorMsg="No scoring plays in this game."
                        showGuide={false}
                        homeTeam={homeTeam}
                        awayTeam={awayTeam}
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </main>
          <main class="col-lg-6 ms-sm-auto px-md-4">
            <div class="panel-group">
              <div class="panel panel-default">
                <div class="panel-heading">
                  <div class="panel-title">
                    <h2 id="drives">
                      Drives{" "}
                      <span class="d-inline text-small h6">
                        <a data-bs-toggle="collapse" href="#drivesTable" style="text-decoration: none;" role="button" aria-expanded="true">
                          [show/hide]
                        </a>
                      </span>
                    </h2>
                    {drivesSubtitle !== "" && <p class="text-small">{drivesSubtitle}</p>}
                  </div>
                </div>
                <div id="drivesTable" class="panel-collapse collapse">
                  <div class="panel-body">
                    <div class="table-responsive">
                      <DrivesTable
                        drives={gameDrives}
                        prefix="all"
                        expandable={true}
                        errorMsg="No drives in this game."
                        showGuide={true}
                        plays={plays}
                        homeTeam={homeTeam}
                        awayTeam={awayTeam}
                        isNeutralSite={isNeutralSite}
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </main>
        </div>

        <div class="row mb-3">
          <main class="col-md-12 ms-sm-auto col-lg-12 px-md-4">
            <div class="panel-group">
              <div class="panel panel-default">
                <div class="panel-heading">
                  <div class="panel-title">
                    <h2 id="all-plays">
                      All Plays{" "}
                      <span class="d-inline text-small h6">
                        <a data-bs-toggle="collapse" href="#allPlayTable" style="text-decoration: none;" role="button" aria-expanded="true">
                          [show/hide]
                        </a>
                      </span>
                    </h2>
                    {allPlaysSubtitle !== "" && <p class="text-small">{allPlaysSubtitle}</p>}
                  </div>
                </div>
                <div id="allPlayTable" class="panel-collapse collapse">
                  <div class="panel-body">
                    <div class="table-responsive">
                      <PlayTable
                        plays={playsForTable}
                        prefix="all"
                        expandable={true}
                        errorMsg="No plays in this game."
                        showGuide={true}
                        homeTeam={homeTeam}
                        awayTeam={awayTeam}
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </main>
        </div>

        {showAutoRefreshNote && (
          <div class="row mb-3">
            <div class="col-12">
              <p class="text-small text-muted">Page will auto-refresh every minute.</p>
            </div>
          </div>
        )}
      </div>
    </Layout>
  );
};
