import type { FC } from "hono/jsx";
import { Layout } from "./Layout";
import { cleanName } from "../lib/games";

// Reproduces frontend/views/pages/cfb/game_error.ejs. Two flavors:
// `pbp` (the default — "no play-by-play data available, check ESPN
// gamecast") and `quarantine` (the gameId is on QUARANTINE_LIST so
// we deliberately refuse to serve it). Same chrome either way.

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

export interface GameErrorTeam {
  id?: string | number;
  abbreviation?: string;
  nickname?: string;
}

export interface GameErrorGameInfo {
  id?: string | number;
  date?: string;
  status?: { type?: { name?: string; completed?: boolean; detail?: string } };
  competitors?: Array<{ team?: GameErrorTeam; score?: number | string }>;
  broadcasts?: Array<{ media?: { shortName?: string } }>;
}

interface Props {
  gameInfo: GameErrorGameInfo;
  errorType: "quarantine" | "pbp";
}

export const GameErrorPage: FC<Props> = ({ gameInfo, errorType }) => {
  const homeComp = gameInfo.competitors?.[0];
  const awayComp = gameInfo.competitors?.[1];
  const homeTeam = homeComp?.team ?? {};
  const awayTeam = awayComp?.team ?? {};
  const completed = gameInfo.status?.type?.completed === true;
  const inProgress = gameInfo.status?.type?.name?.includes("STATUS_IN_PROGRESS") ?? false;

  const homeName = cleanName(homeTeam);
  const awayName = cleanName(awayTeam);
  const title =
    completed || inProgress
      ? `Game: ${awayName} ${awayComp?.score ?? 0}, ${homeName} ${homeComp?.score ?? 0} | Game on Paper`
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
    </>
  );

  const extraScripts = (
    <>
      <script src="/assets/js/feather.min.js" crossorigin="anonymous"></script>
      <script src="/assets/js/Chart.min.js" crossorigin="anonymous"></script>
      <script src="/assets/js/date-replace.js" crossorigin="anonymous"></script>
    </>
  );

  return (
    <Layout
      title={title}
      subtitle={subtitle}
      canonical={canonical}
      extraHead={extraHead}
      extraScripts={extraScripts}
      hideHeader={true}
    >
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
                <h2>
                  {awayName} {awayComp?.score ?? 0} @ {homeName} {homeComp?.score ?? 0}
                </h2>
                {gameInfo.status?.type?.name?.includes("STATUS_SCHEDULED") ? (
                  <span class="game-date">{gameInfo.date}</span>
                ) : completed ? (
                  <>
                    <span class="game-status">{gameInfo.status?.type?.detail}</span> -{" "}
                    <span class="game-date">{gameInfo.date}</span>
                  </>
                ) : (
                  <span class="game-status">{gameInfo.status?.type?.detail}</span>
                )}
              </div>
            </div>
            <div class="col-2 d-flex justify-content-end align-items-center">
              {networkLink && (
                <a
                  class="btn btn-sm btn-outline-secondary"
                  href={networkLink}
                  target="_blank"
                >
                  Watch ({networkName})
                </a>
              )}
            </div>
          </div>
        </header>
      </div>
      <div class="container-fluid">
        <div class="row mb-3">
          <div class="offset-lg-4 col-lg-4 col-md-12">
            {errorType === "quarantine" ? (
              <p class="text-muted text-center">
                This game has been quarantined due to issues with underlying ESPN data. If you
                believe this is an error, please reach out to{" "}
                <a href="https://twitter.com/akeaswaran">@akeaswaran</a> or{" "}
                <a href="https://twitter.com/saiemgilani">@saiemgilani</a> on Twitter with the URL
                you're trying to access.
              </p>
            ) : (
              <p class="text-muted text-center">
                There is no play-by-play data available for this game. Please visit the{" "}
                <a href={`https://www.espn.com/college-football/game?gameId=${gameInfo.id}`}>
                  ESPN Gamecast
                </a>{" "}
                to confirm this. If there is data available on ESPN or you believe this is an error,
                please reach out to{" "}
                <a href="https://twitter.com/gameonpaper">@gameonpaper</a> on Twitter with the URL
                you're trying to access.
              </p>
            )}
          </div>
        </div>
      </div>
    </Layout>
  );
};
