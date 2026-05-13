import type { FC, Child } from "hono/jsx";
import { Layout } from "./Layout";
import { TeamCard } from "./TeamCard";
import { TeamSlice } from "./TeamSlice";
import { roundNumber } from "../lib/leaderboard";
import { cleanName } from "../lib/games";

// Reproduces frontend/views/pages/cfb/pregame.ejs and the matchup
// partial it embeds. Scheduled-game preview: two team_card panels at
// the top, two radar canvases, then either a 6-panel TeamSlice grid
// (`view_full=true`, the legacy "old" preview) or a per-team
// matchup table (the default). The matchup partial lives inline as
// a JSX subcomponent — it's only used here.

export interface PregameTeam {
  id?: string | number;
  abbreviation?: string;
  nickname?: string;
  color?: string;
  alternateColor?: string;
  [key: string]: unknown;
}

export interface PregameCompetitor {
  team?: PregameTeam;
  score?: number | string;
  record?: Array<{
    type?: string;
    displayValue?: string;
    stats?: Array<{ name?: string; displayValue?: string }>;
  }>;
  [key: string]: unknown;
}

export interface PregameGameInfo {
  id?: string | number;
  date?: string;
  status?: { type?: { name?: string; completed?: boolean; detail?: string; description?: string } };
  competitors?: PregameCompetitor[];
  broadcasts?: Array<{ media?: { shortName?: string } }>;
}

export interface PregameHeader {
  gameNote?: string;
  [key: string]: unknown;
}

export interface PregameData {
  gameInfo: PregameGameInfo;
  header: PregameHeader;
  matchup: { team: Array<Record<string, unknown>> };
}

interface Props {
  gameData: PregameData;
  season: number | string;
  week: number | string;
  viewFull: boolean;
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

// matchup.ejs:42-58. Always uses max=134 here (fixed in the EJS too).
function rankCell(rank: unknown, addClass = "", addStyle = ""): Child {
  if (rank == null || rank === "") {
    return (
      <td class={`${addClass} text-center`} style={addStyle}>
        N/A
      </td>
    );
  }
  const tied = String(rank).includes(".5");
  const numeric = Math.floor(parseFloat(String(rank)));
  const display = tied ? `T-#${roundNumber(numeric, 2, 0)}` : `#${roundNumber(numeric, 2, 0)}`;
  const max = 134;
  const value = (max - parseFloat(String(rank))) / max;
  const step = Math.round(value / 0.1);
  const clamped = Math.min(Math.max(step, 0), 9);
  const ramp = clamped === 4 || clamped === 5 ? "" : `hulk-bg-level-${clamped}`;
  return (
    <td class={`${ramp} ${addClass} text-center`} style={addStyle}>
      {display}
    </td>
  );
}

function matchupRoundNumber(value: unknown, power10: number, fixed: number): string {
  if (value == null || (!value && value !== 0)) return "N/A";
  return roundNumber(value, power10, fixed);
}

function formatYardline(yardsToGoal: unknown): string {
  const v = parseFloat(String(yardsToGoal ?? 0));
  const prefix = v >= 50 ? "Own" : "Opp";
  const printedVal = v >= 50 ? 100 - v : v;
  return `${prefix} ${roundNumber(printedVal, 2, 0)}`;
}

function generateMarginalString(input: unknown, power10: number, fixed: number): string {
  const v = parseFloat(String(input ?? 0));
  if (v >= 0) return `+${roundNumber(input, power10, fixed)}`;
  return roundNumber(input, power10, fixed);
}

function emptyBreakdown(): Record<string, Record<string, Record<string, unknown>>> {
  return {
    offensive: { overall: {}, passing: {}, rushing: {} },
    defensive: { overall: {}, passing: {}, rushing: {} },
    differential: { overall: {}, passing: {}, rushing: {} },
  };
}

interface MatchupRowProps {
  title: string;
  awayBreakdown: Record<string, Record<string, Record<string, unknown>>>;
  homeBreakdown: Record<string, Record<string, Record<string, unknown>>>;
  awaySideOfBall: "offensive" | "defensive";
  category: "overall" | "passing" | "rushing";
  statKey: string;
}

const MatchupRow: FC<MatchupRowProps> = ({
  title,
  awayBreakdown,
  homeBreakdown,
  awaySideOfBall,
  category,
  statKey,
}) => {
  const homeSideOfBall = awaySideOfBall === "offensive" ? "defensive" : "offensive";
  const homeRank = homeBreakdown[homeSideOfBall][category][`${statKey}Rank`];
  const awayRank = awayBreakdown[awaySideOfBall][category][`${statKey}Rank`];
  let homeValue: string = String(homeBreakdown[homeSideOfBall][category][statKey] ?? "N/A");
  let awayValue: string = String(awayBreakdown[awaySideOfBall][category][statKey] ?? "N/A");

  const rawHome = homeBreakdown[homeSideOfBall][category][statKey];
  const rawAway = awayBreakdown[awaySideOfBall][category][statKey];
  if (["epaPerPlay", "thirdDownDistance", "earlyDownEPAPerPlay"].includes(statKey)) {
    homeValue = matchupRoundNumber(rawHome, 2, 2);
    awayValue = matchupRoundNumber(rawAway, 2, 2);
  } else if (
    ["successRate", "thirdDownSuccessRate", "availableYardsPct", "lateDownSuccessRate"].includes(
      statKey,
    )
  ) {
    homeValue = `${matchupRoundNumber(parseFloat(String(rawHome ?? 0)) * 100, 2, 1)}%`;
    awayValue = `${matchupRoundNumber(parseFloat(String(rawAway ?? 0)) * 100, 2, 1)}%`;
  } else if (statKey === "startingFP") {
    homeValue = formatYardline(rawHome);
    awayValue = formatYardline(rawAway);
  }

  return (
    <tr>
      {rankCell(awayRank, "", "width: 10% !important;")}
      <td class="text-center" style="width: 20% !important;">
        {awayValue || "N/A"}
      </td>
      <td class="text-center" style="width: 40% !important;">
        {title}
      </td>
      <td class="text-center" style="width: 20% !important;">
        {homeValue || "N/A"}
      </td>
      {rankCell(homeRank, "", "width: 10% !important;")}
    </tr>
  );
};

const TeamSector: FC<{
  team: PregameTeam;
  breakdown: Record<string, Record<string, Record<string, unknown>>>;
}> = ({ team, breakdown }) => {
  const teamLogoLink = (
    <h4 class="d-inline">
      <a href={`/cfb/team/${team.id}`}>
        <img
          class={`img-fluid team-logo-${team.id}`}
          width="35px"
          src={`https://a.espncdn.com/i/teamlogos/ncaa/500/${team.id}.png`}
          alt={`ESPN team id ${team.id}`}
        />
      </a>{" "}
      {cleanName(team)}
    </h4>
  );

  return (
    <div class="col-md-12 ms-sm-auto col-lg-3">
      <div class="h4 text-center">{teamLogoLink}</div>
      <div class="table-responsive">
        <table class="table table-sm table-responsive">
          <tbody>
            <tr>
              <td class="text-left">Net EPA/Play</td>
              <td class="text-center">
                {generateMarginalString(breakdown.differential.overall.epaPerPlay, 2, 2)}
              </td>
              {rankCell(breakdown.differential.overall.epaPerPlayRank)}
            </tr>
            <tr>
              <td class="ps-4">Offense</td>
              <td class="text-center">
                {matchupRoundNumber(breakdown.offensive.overall.epaPerPlay, 2, 2)}
              </td>
              {rankCell(breakdown.offensive.passing.epaPerPlayRank)}
            </tr>
            <tr>
              <td class="ps-4">Defense</td>
              <td class="text-center">
                {matchupRoundNumber(breakdown.defensive.overall.epaPerPlay, 2, 2)}
              </td>
              {rankCell(breakdown.defensive.passing.epaPerPlayRank)}
            </tr>
          </tbody>
        </table>
      </div>
      <div class="table-responsive">
        <table class="table table-sm table-responsive">
          <tbody>
            <tr>
              <td>Offense Success</td>
              <td class="text-center">
                {matchupRoundNumber(
                  parseFloat(String(breakdown.offensive.overall.successRate ?? 0)) * 100,
                  2,
                  1,
                )}
                %
              </td>
              {rankCell(breakdown.offensive.overall.successRateRank)}
            </tr>
            <tr>
              <td class="ps-4">Pass</td>
              <td class="text-center">
                {matchupRoundNumber(
                  parseFloat(String(breakdown.offensive.passing.successRate ?? 0)) * 100,
                  2,
                  1,
                )}
                %
              </td>
              {rankCell(breakdown.offensive.passing.successRateRank)}
            </tr>
            <tr>
              <td class="ps-4">Rush</td>
              <td class="text-center">
                {matchupRoundNumber(
                  parseFloat(String(breakdown.offensive.rushing.successRate ?? 0)) * 100,
                  2,
                  1,
                )}
                %
              </td>
              {rankCell(breakdown.offensive.rushing.successRateRank)}
            </tr>
          </tbody>
        </table>
      </div>
      <div class="table-responsive">
        <table class="table table-sm table-responsive">
          <tbody>
            <tr>
              <td>Defense Success</td>
              <td class="text-center">
                {matchupRoundNumber(
                  parseFloat(String(breakdown.defensive.overall.successRate ?? 0)) * 100,
                  2,
                  1,
                )}
                %
              </td>
              {rankCell(breakdown.defensive.overall.successRateRank)}
            </tr>
            <tr>
              <td class="ps-4">Pass</td>
              <td class="text-center">
                {matchupRoundNumber(
                  parseFloat(String(breakdown.defensive.passing.successRate ?? 0)) * 100,
                  2,
                  1,
                )}
                %
              </td>
              {rankCell(breakdown.defensive.passing.successRateRank)}
            </tr>
            <tr>
              <td class="ps-4">Rush</td>
              <td class="text-center">
                {matchupRoundNumber(
                  parseFloat(String(breakdown.defensive.rushing.successRate ?? 0)) * 100,
                  2,
                  1,
                )}
                %
              </td>
              {rankCell(breakdown.defensive.rushing.successRateRank)}
            </tr>
          </tbody>
        </table>
      </div>
      <div class="table-responsive">
        <table class="table table-sm table-responsive">
          <tbody>
            <tr>
              <td class="w-50">Net Field Position</td>
              <td class="text-center">
                {generateMarginalString(breakdown.differential.overall.startingFP, 2, 1)}
              </td>
              {rankCell(breakdown.differential.overall.startingFPRank)}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
};

interface MatchupProps {
  gameId: string | number;
  homeTeam: PregameTeam;
  awayTeam: PregameTeam;
  breakdown: Array<Record<string, unknown>>;
}

const Matchup: FC<MatchupProps> = ({ gameId, homeTeam, awayTeam, breakdown }) => {
  const findTeam = (id: unknown) =>
    breakdown.find((p) => String((p as { teamId?: unknown }).teamId) === String(id)) as
      | (Record<string, Record<string, Record<string, unknown>>> & Record<string, unknown>)
      | undefined;
  const awayBreakdown =
    (findTeam(awayTeam.id) as Record<string, Record<string, Record<string, unknown>>> | undefined) ??
    emptyBreakdown();
  const homeBreakdown =
    (findTeam(homeTeam.id) as Record<string, Record<string, Record<string, unknown>>> | undefined) ??
    emptyBreakdown();
  // Re-fill any missing top-level slice the EJS cleanBreakdown does.
  const ensureSlices = (b: Record<string, Record<string, Record<string, unknown>>>) => {
    if (!b.offensive) Object.assign(b, emptyBreakdown());
    return b;
  };
  ensureSlices(awayBreakdown);
  ensureSlices(homeBreakdown);

  const teamLogoLink = (team: PregameTeam) => (
    <h3 class="d-inline">
      <a href={`/cfb/team/${team.id}`}>
        <img
          class={`img-fluid team-logo-${team.id}`}
          width="35px"
          src={`https://a.espncdn.com/i/teamlogos/ncaa/500/${team.id}.png`}
          alt={`ESPN team id ${team.id}`}
        />
      </a>
    </h3>
  );

  const breakdownSeason =
    (awayBreakdown as { season?: unknown }).season ?? (homeBreakdown as { season?: unknown }).season;

  return (
    <div class="container mb-3">
      <div class="row">
        <TeamSector team={awayTeam} breakdown={awayBreakdown} />
        <div class="col-md-12 ms-sm-auto col-lg-6">
          <div class="h3 text-center">
            {teamLogoLink(awayTeam)} Offense vs {teamLogoLink(homeTeam)} Defense
          </div>
          <div class="table-responsive">
            <table class="table table-sm table-responsive">
              <tbody>
                <MatchupRow title="EPA/Pass" awayBreakdown={awayBreakdown} homeBreakdown={homeBreakdown} awaySideOfBall="offensive" category="passing" statKey="epaPerPlay" />
                <MatchupRow title="EPA/Rush" awayBreakdown={awayBreakdown} homeBreakdown={homeBreakdown} awaySideOfBall="offensive" category="rushing" statKey="epaPerPlay" />
                <MatchupRow title="Available Yards %" awayBreakdown={awayBreakdown} homeBreakdown={homeBreakdown} awaySideOfBall="offensive" category="overall" statKey="availableYardsPct" />
                <MatchupRow title="Starting Field Position" awayBreakdown={awayBreakdown} homeBreakdown={homeBreakdown} awaySideOfBall="offensive" category="overall" statKey="startingFP" />
                <MatchupRow title="Early Downs EPA/Play" awayBreakdown={awayBreakdown} homeBreakdown={homeBreakdown} awaySideOfBall="offensive" category="overall" statKey="earlyDownEPAPerPlay" />
                <MatchupRow title="3rd/4th Down Success" awayBreakdown={awayBreakdown} homeBreakdown={homeBreakdown} awaySideOfBall="offensive" category="overall" statKey="lateDownSuccessRate" />
                <MatchupRow title="Avg 3rd Down Distance" awayBreakdown={awayBreakdown} homeBreakdown={homeBreakdown} awaySideOfBall="offensive" category="overall" statKey="thirdDownDistance" />
              </tbody>
            </table>
          </div>
          <div class="h3 text-center">
            {teamLogoLink(awayTeam)} Defense vs {teamLogoLink(homeTeam)} Offense
          </div>
          <div class="table-responsive">
            <table class="table table-sm table-responsive">
              <tbody>
                <MatchupRow title="EPA/Pass" awayBreakdown={awayBreakdown} homeBreakdown={homeBreakdown} awaySideOfBall="defensive" category="passing" statKey="epaPerPlay" />
                <MatchupRow title="EPA/Rush" awayBreakdown={awayBreakdown} homeBreakdown={homeBreakdown} awaySideOfBall="defensive" category="rushing" statKey="epaPerPlay" />
                <MatchupRow title="Available Yards %" awayBreakdown={awayBreakdown} homeBreakdown={homeBreakdown} awaySideOfBall="defensive" category="overall" statKey="availableYardsPct" />
                <MatchupRow title="Starting FP" awayBreakdown={awayBreakdown} homeBreakdown={homeBreakdown} awaySideOfBall="defensive" category="overall" statKey="startingFP" />
                <MatchupRow title="Early Downs EPA/Play" awayBreakdown={awayBreakdown} homeBreakdown={homeBreakdown} awaySideOfBall="defensive" category="overall" statKey="earlyDownEPAPerPlay" />
                <MatchupRow title="3rd/4th Down Success" awayBreakdown={awayBreakdown} homeBreakdown={homeBreakdown} awaySideOfBall="defensive" category="overall" statKey="thirdDownSuccessRate" />
                <MatchupRow title="Avg 3rd Down Distance" awayBreakdown={awayBreakdown} homeBreakdown={homeBreakdown} awaySideOfBall="defensive" category="overall" statKey="thirdDownDistance" />
              </tbody>
            </table>
          </div>
        </div>
        <TeamSector team={homeTeam} breakdown={homeBreakdown} />
      </div>
      <div class="row mb-3">
        <div class="col-12">
          <p class="m-0 text-muted text-small">
            <small>
              Matchup table concept adapted from{" "}
              <a href="https://sumersports.com/games/2024-01-BAL-KC/">SumerSports's NFL matchup pages</a>.
            </small>
            {breakdownSeason != null && <small> Ranks from {breakdownSeason as Child} season.</small>}
          </p>
          <p class="m-0 text-muted text-small">
            <small>
              Click <a href={`/cfb/game/${gameId}?preview_mode=old`}>here</a> to view the full preview page.
            </small>
          </p>
        </div>
      </div>
    </div>
  );
};

// ---------- Pregame page -------------------------------------------

const isChampionshipNote = (gameNote: string): boolean =>
  [
    "CFP",
    "College Football Playoff",
    "National Championship",
    "FCS Championship",
    "Celebration Bowl",
    "Division II Championship",
    "Division III Championship",
  ].some((m) => gameNote.includes(m));

export const PregamePage: FC<Props> = ({ gameData, season, week, viewFull }) => {
  const homeComp = gameData.gameInfo.competitors?.[0] ?? {};
  const awayComp = gameData.gameInfo.competitors?.[1] ?? {};
  const homeTeam: PregameTeam = homeComp.team ?? {};
  const awayTeam: PregameTeam = awayComp.team ?? {};
  const gameNote = gameData.header.gameNote ?? "";
  const isChampionship = isChampionshipNote(gameNote);

  const homeName = cleanName(homeTeam);
  const awayName = cleanName(awayTeam);
  const completed = gameData.gameInfo.status?.type?.completed === true;
  const inProgress = gameData.gameInfo.status?.type?.name?.includes("STATUS_IN_PROGRESS") ?? false;
  const title =
    completed || inProgress
      ? `Game: ${awayName} ${awayComp.score ?? 0}, ${homeName} ${homeComp.score ?? 0} | Game on Paper`
      : `Game: ${awayName} vs ${homeName} | Game on Paper`;
  const subtitle = `${awayName} vs ${homeName}`;
  const canonical = `https://gameonpaper.com/cfb/game/${gameData.gameInfo.id}`;

  const networkName = gameData.gameInfo.broadcasts?.[0]?.media?.shortName ?? null;
  const networkLink = (() => {
    if (!networkName) return null;
    if (ESPN_NETWORK_MARKERS.some((m) => networkName.includes(m))) {
      return `https://www.espn.com/watch/player/_/eventCalendarId/${gameData.gameInfo.id}`;
    }
    if (NETWORK_MAPPINGS[networkName]) return NETWORK_MAPPINGS[networkName];
    return null;
  })();

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
      {isChampionship && <link href="/assets/css/championship.css" rel="stylesheet" />}
      <meta
        property="og:image"
        content={`https://s.espncdn.com/stitcher/sports/football/college-football/events/${gameData.gameInfo.id}.png?templateId=espn.com.share.1`}
      />
      <style dangerouslySetInnerHTML={{ __html: darkLogoCss }} />
    </>
  );

  const matchupTeam = gameData.matchup?.team ?? [];

  // Inline data + chart bootstrap. Mirrors pregame.ejs:316-394.
  const breakdownsJson = JSON.stringify(matchupTeam);

  const extraScripts = (
    <>
      <script src="/assets/js/feather.min.js" crossorigin="anonymous"></script>
      <script src="/assets/js/Chart.min.js" crossorigin="anonymous"></script>
      <script src="/assets/js/date-replace.js" crossorigin="anonymous"></script>
      <script
        dangerouslySetInnerHTML={{
          __html: `
            var gameData = ${JSON.stringify(gameData)};
            var statusDetail = gameData.gameInfo.status.type.detail;
            var statusDescription = gameData.gameInfo.status.type.description ?? "Scheduled";
            if (gameData.gameInfo.status.type.completed == true ||
                statusDescription.includes("Cancel") ||
                statusDescription.includes("Postpone") ||
                statusDescription.includes("Delay") ||
                statusDescription.includes("Scheduled")) {
              document.body.querySelector("#game-date").innerText = statusDescription + " - " +
                luxon.DateTime.fromISO(gameData.gameInfo.date).toLocaleString(luxon.DateTime.DATETIME_FULL);
            } else {
              document.body.querySelector("#game-date").innerText = "LIVE - " + statusDetail;
              setTimeout("location.reload(true);", 60 * 1000);
            }
          `,
        }}
      ></script>
      <script src="/assets/js/common.js" crossorigin="anonymous"></script>
      <script src="/assets/js/radar.js"></script>
      <script
        dangerouslySetInnerHTML={{
          __html: `
            const firstCanvasTitle = ${JSON.stringify(`${awayName} Offense vs ${homeName} Defense`)};
            const secondCanvasTitle = ${JSON.stringify(`${homeName} Offense vs ${awayName} Defense`)};
            let breakdowns = ${breakdownsJson};
            if (breakdowns.length >= 2) {
              breakdowns = [{
                ...breakdowns[0],
                teamName: ${JSON.stringify(awayName)},
                alternateColor: ${JSON.stringify(awayTeam.alternateColor ?? "#000000")},
                color: ${JSON.stringify(awayTeam.color ?? "")}
              }, {
                ...breakdowns[1],
                teamName: ${JSON.stringify(homeName)},
                alternateColor: ${JSON.stringify(homeTeam.alternateColor ?? "#000000")},
                color: ${JSON.stringify(homeTeam.color ?? "")}
              }];
              feather.replace();
              new Chart(
                document.getElementById('offensive-canvas'),
                generateConfig(generateDataset(breakdowns, "Offensive", "Defensive"), firstCanvasTitle)
              );
              new Chart(
                document.getElementById('defensive-canvas'),
                generateConfig(generateDataset(breakdowns, "Defensive", "Offensive"), secondCanvasTitle)
              );
            }
          `,
        }}
      ></script>
    </>
  );

  const radarWidth = 200;
  const radarHalf = radarWidth / 2;
  const awayBreakdown = matchupTeam[0] ?? {};
  const homeBreakdown = matchupTeam[1] ?? {};

  return (
    <Layout title={title} subtitle={subtitle} canonical={canonical} extraHead={extraHead} extraScripts={extraScripts} hideHeader={true}>
      <div class="container-fluid">
        <header class="blog-header py-3 mb-3">
          <div class="row flex-nowrap justify-content-between align-items-center">
            <div class="col-2 pt-1">
              <a
                class="btn btn-sm btn-outline-primary align-middle"
                href="/"
                onclick="if (document.referrer) { event.preventDefault(); history.back(); }"
              >
                <i class="bi-arrow-left"></i>
              </a>
            </div>
            <div class="col-8 text-center">
              <div class="game-context">
                <h2 class="mb-0">
                  {awayName} {awayComp.score ?? 0} @ {homeName} {homeComp.score ?? 0}
                </h2>
                {gameNote !== "" && (
                  <p class={`text-small mt-0 mb-3 ${isChampionship ? "championship-text" : "text-primary"}`}>
                    <strong>{gameNote}</strong>
                  </p>
                )}
                <p class="text-small m-0" id="game-date"></p>
              </div>
            </div>
            <div class="col-2 d-flex justify-content-end align-items-center">
              {networkLink && (
                <a class="btn btn-sm btn-outline-secondary" href={networkLink} target="_blank">
                  Watch ({networkName})
                </a>
              )}
            </div>
          </div>
        </header>
      </div>
      <div class="container-fluid">
        <div class="row mb-3">
          <div class="col-lg-2 col-md-0"></div>
          <div class="col-lg-4 col-md-12 margin-override">
            <TeamCard teamData={awayComp} breakdown={[awayBreakdown]} season={season} hideNavigation={false} />
          </div>
          <div class="col-lg-4 col-md-12">
            <TeamCard teamData={homeComp} breakdown={[homeBreakdown]} season={season} hideNavigation={false} />
          </div>
        </div>
      </div>
      <div class="container-fluid mb-3">
        <div class="row mb-3">
          <div class="col-lg-2 col-md-0"></div>
          <div class="col-lg-4 col-xs-12 mb-xs-3">
            <canvas
              id="offensive-canvas"
              style={`display: block; box-sizing: border-box; height: ${radarHalf}px; width: ${radarHalf}px;`}
              width={String(radarWidth)}
              height={String(radarWidth)}
            ></canvas>
          </div>
          <div class="col-lg-4 col-xs-12 mb-xs-3">
            <canvas
              id="defensive-canvas"
              style={`display: block; box-sizing: border-box; height: ${radarHalf}px; width: ${radarHalf}px;`}
              width={String(radarWidth)}
              height={String(radarWidth)}
            ></canvas>
          </div>
        </div>
      </div>
      {viewFull ? (
        <div class="container-fluid">
          <div id="team-stats" class="row mb-3">
            <div class="col-md-12 ms-sm-auto col-lg-12 px-md-4">
              <div class="panel-group">
                <div class="panel panel-default">
                  <div id="boxScoreContent" class="panel-collapse show">
                    <div class="panel-body">
                      <div class="row mb-3">
                        <div class="col-md-4 ms-sm-auto col-lg-4">
                          <TeamSlice breakdown={matchupTeam} title="Offensive" target="offensive" situation="overall" showTeamLogos={true} homeTeam={homeTeam} awayTeam={awayTeam} />
                        </div>
                        <div class="col-md-4 ms-sm-auto col-lg-4">
                          <TeamSlice breakdown={matchupTeam} title="When Passing" target="offensive" situation="passing" showTeamLogos={true} homeTeam={homeTeam} awayTeam={awayTeam} />
                        </div>
                        <div class="col-md-4 ms-sm-auto col-lg-4">
                          <TeamSlice breakdown={matchupTeam} title="When Rushing" target="offensive" situation="rushing" showTeamLogos={true} homeTeam={homeTeam} awayTeam={awayTeam} />
                        </div>
                      </div>
                      <div class="row">
                        <div class="col-md-4 ms-sm-auto col-lg-4">
                          <TeamSlice breakdown={matchupTeam} title="Defensive" target="defensive" situation="overall" showTeamLogos={true} homeTeam={homeTeam} awayTeam={awayTeam} />
                        </div>
                        <div class="col-md-4 ms-sm-auto col-lg-4">
                          <TeamSlice breakdown={matchupTeam} title="Against the Pass" target="defensive" situation="passing" showTeamLogos={true} homeTeam={homeTeam} awayTeam={awayTeam} />
                        </div>
                        <div class="col-md-4 ms-sm-auto col-lg-4">
                          <TeamSlice breakdown={matchupTeam} title="Against the Run" target="defensive" situation="rushing" showTeamLogos={true} homeTeam={homeTeam} awayTeam={awayTeam} />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <Matchup
          gameId={gameData.gameInfo.id ?? ""}
          homeTeam={homeTeam}
          awayTeam={awayTeam}
          breakdown={matchupTeam}
        />
      )}
      {/* Suppress unused-var warnings in noUnusedLocals mode for `week` —
          referenced for parity with the EJS template even though nothing
          renders it directly (it goes into the future dropdown wiring). */}
      {/* eslint-disable-next-line @typescript-eslint/no-unused-vars */}
      <input type="hidden" data-week={String(week)} hidden={true} />
    </Layout>
  );
};
