import type { FC, Child } from "hono/jsx";
import { Layout } from "./Layout";
import { cleanName } from "../lib/games";
import { roundNumber } from "../lib/leaderboard";

// PARTIAL port of frontend/views/pages/cfb/game.ejs (1501 lines).
// This commit ships the chrome (head + score header + scoring plays
// summary table) and a stable JSON shortcut. The heavy ported
// surface — slim_box_score, field, pass_chart, rush_chart, win-prob
// chart, drive chart, advanced box score, play-by-play table — lands
// in a follow-up commit once the per-section partials are written.
//
// Keeping this in tree (rather than serving a 503) so:
// - the route's caching, error, and pregame branches can be smoke-
//   tested in production against real ESPN data
// - the game_id input form on /cfb/ can navigate to a working URL
// - the JSON shortcut is fully usable for downstream consumers
//
// Don't add features here without a plan to land them in the next
// commit; the goal is to keep this file deletable when the full
// port replaces it.

export interface GameTeam {
  id?: string | number;
  abbreviation?: string;
  nickname?: string;
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

export interface GameData {
  gameInfo?: GameInfo;
  header?: { season?: { year?: number }; week?: number; [key: string]: unknown };
  homeTeamId?: string | number;
  awayTeamId?: string | number;
  plays?: Array<unknown>;
  scoringPlays?: ScoringPlay[];
  boxScore?: unknown;
  advBoxScore?: unknown;
  [key: string]: unknown;
}

interface Props {
  gameData: GameData;
  percentiles: unknown[];
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

export const GamePage: FC<Props> = ({ gameData, percentiles, season }) => {
  const gameInfo = gameData.gameInfo ?? {};
  const homeComp = gameInfo.competitors?.[0] ?? {};
  const awayComp = gameInfo.competitors?.[1] ?? {};
  const homeTeam: GameTeam = homeComp.team ?? {};
  const awayTeam: GameTeam = awayComp.team ?? {};
  const homeName = cleanName(homeTeam);
  const awayName = cleanName(awayTeam);
  const completed = gameInfo.status?.type?.completed === true;
  const inProgress = gameInfo.status?.type?.name?.includes("STATUS_IN_PROGRESS") ?? false;
  const title =
    completed || inProgress
      ? `Game: ${awayName} ${awayComp.score ?? 0}, ${homeName} ${homeComp.score ?? 0} | Game on Paper`
      : `Game: ${awayName} vs ${homeName} | Game on Paper`;
  const subtitle = `${awayName} vs ${homeName}`;
  const canonical = `https://gameonpaper.com/cfb/game/${gameInfo.id}`;

  const networkName = gameInfo.broadcasts?.[0]?.media?.shortName ?? null;
  const networkLink = (() => {
    if (!networkName) return null;
    if (ESPN_NETWORK_MARKERS.some((m) => networkName.includes(m))) {
      return `https://www.espn.com/watch/player/_/eventCalendarId/${gameInfo.id}`;
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
      <meta
        property="og:image"
        content={`https://s.espncdn.com/stitcher/sports/football/college-football/events/${gameInfo.id}.png?templateId=espn.com.share.1`}
      />
      <style dangerouslySetInnerHTML={{ __html: darkLogoCss }} />
    </>
  );

  const extraScripts = (
    <>
      <script src="/assets/js/feather.min.js" crossorigin="anonymous"></script>
      <script src="/assets/js/Chart.min.js" crossorigin="anonymous"></script>
      <script src="/assets/js/date-replace.js" crossorigin="anonymous"></script>
    </>
  );

  const scoringPlays = gameData.scoringPlays ?? [];
  const homeId = String(homeTeam.id ?? "");
  const homeScoreCell = (sp: ScoringPlay): Child => {
    const isHomeScoring = String(sp.pos_team) === homeId;
    return (
      <td class="text-center">
        {isHomeScoring && <strong>{sp.homeScore ?? "-"}</strong>}
        {!isHomeScoring && (sp.homeScore ?? "-")}
      </td>
    );
  };
  const awayScoreCell = (sp: ScoringPlay): Child => {
    const isHomeScoring = String(sp.pos_team) === homeId;
    return (
      <td class="text-center">
        {!isHomeScoring && <strong>{sp.awayScore ?? "-"}</strong>}
        {isHomeScoring && (sp.awayScore ?? "-")}
      </td>
    );
  };

  return (
    <Layout title={title} subtitle={subtitle} canonical={canonical} extraHead={extraHead} extraScripts={extraScripts}>
      <div class="container-fluid">
        <header class="blog-header py-3 mb-3">
          <div class="row flex-nowrap justify-content-between align-items-center">
            <div class="col-2 pt-1">
              <a class="btn btn-sm btn-outline-primary align-middle" href="/">
                <i class="bi-arrow-left"></i>
              </a>
            </div>
            <div class="col-8 text-center">
              <div class="game-context">
                <h2 class="mb-0">
                  {awayName} {awayComp.score ?? 0} @ {homeName} {homeComp.score ?? 0}
                </h2>
                {gameInfo.status?.type?.name?.includes("STATUS_SCHEDULED") ? (
                  <p class="text-small mt-0 mb-0">
                    <span class="game-date">{gameInfo.date}</span>
                  </p>
                ) : completed ? (
                  <p class="text-small mt-0 mb-0">
                    <span class="game-status">{gameInfo.status?.type?.detail}</span> -{" "}
                    <span class="game-date">{gameInfo.date}</span>
                  </p>
                ) : (
                  <p class="text-small mt-0 mb-0">
                    <span class="game-status">{gameInfo.status?.type?.detail}</span>
                  </p>
                )}
                {gameInfo.gei != null && (
                  <p class="text-small mt-0 mb-0">
                    GEI: <strong>{roundNumber(gameInfo.gei, 2, 2)}</strong>
                  </p>
                )}
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

      {scoringPlays.length > 0 && (
        <div class="container-fluid">
          <div class="row mb-3">
            <div class="col-md-12 col-lg-12 px-md-4">
              <h2 class="d-inline">Scoring Summary</h2>
              <p class="text-small text-muted">Quarter-by-quarter scoring plays.</p>
              <div class="table-responsive">
                <table class="table table-sm">
                  <thead>
                    <tr>
                      <th class="text-center">Q</th>
                      <th class="text-center">Time</th>
                      <th>Play</th>
                      <th class="text-center">{awayName}</th>
                      <th class="text-center">{homeName}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {scoringPlays.map((sp) => (
                      <tr>
                        <td class="text-center">{sp.period?.number ?? "-"}</td>
                        <td class="text-center">{sp.clock?.displayValue ?? "-"}</td>
                        <td>{sp.text ?? "-"}</td>
                        {awayScoreCell(sp)}
                        {homeScoreCell(sp)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}

      <div class="container-fluid">
        <div class="row mb-3">
          <div class="offset-lg-3 col-lg-6 col-md-12">
            <div class="alert alert-info" role="alert">
              <strong>Heads-up:</strong> The full game page (charts, drive chart, advanced box
              score, play-by-play table) is mid-port to the Cloudflare Worker. For now you can
              still hit the production site at{" "}
              <a href={`https://gameonpaper.com/cfb/game/${gameInfo.id}`}>
                gameonpaper.com/cfb/game/{gameInfo.id}
              </a>
              , or grab the raw processed JSON via{" "}
              <a href={`/cfb/game/${gameInfo.id}?json=1`}>?json=1</a>.
            </div>
          </div>
        </div>
      </div>

      {/* `percentiles` is reserved for the next commit (chart bands).
          Inlining it here so the prop is visibly threaded — typecheck
          would flag noUnusedLocals otherwise. */}
      <script
        dangerouslySetInnerHTML={{
          __html: `window.__GOP_PERCENTILES__ = ${JSON.stringify(percentiles)};\nwindow.__GOP_SEASON__ = ${season};`,
        }}
      ></script>
    </Layout>
  );
};
