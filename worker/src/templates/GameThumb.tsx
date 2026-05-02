import type { FC, Child } from "hono/jsx";
import { roundNumber } from "../lib/leaderboard";
import {
  calculateSpiceLevel,
  cleanAbbreviation,
  CONFERENCE_MAP,
  SPICE,
  type ScheduleEvent,
} from "../lib/team_helpers";

// Reproduces frontend/views/pages/cfb/game_thumb.ejs. Used by both
// the team_season schedule grid and (after the scoreboard port) the
// /cfb/ scoreboard. Lifted out of TeamSeason.tsx into its own module
// so multiple pages can share one definition.

export interface GameThumbProps {
  game: ScheduleEvent;
}

const SICKOS_GOTW: Array<string | number> = [];

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
const INDY_CONFS = new Set([18, 35, 80, 81]);

const formatScore = (score: unknown, winner: boolean, complete: boolean): Child => {
  const text = String(score);
  if (winner && complete) return <strong>{text}</strong>;
  if (!winner && complete) return <span style="opacity: 0.5;">{text}</span>;
  return <span>{text}</span>;
};

const recordString = (
  competitor: { records?: Array<{ type?: string; summary?: string }>; team?: { conferenceId?: string | number } },
): Child => {
  const records = competitor.records ?? [];
  const overallStuff = records.find((r) => r.type === "total");
  const overall = overallStuff?.summary ?? "0-0";
  let base = overall;
  const confStuff = records.find((r) => r.type === "vsconf");
  const confRec = confStuff?.summary ?? "0-0";
  const confId = parseInt(String(competitor.team?.conferenceId ?? 0), 10);
  const conf = CONFERENCE_MAP[confId];
  if (confStuff && conf && !INDY_CONFS.has(confId)) {
    base = `${base}, ${confRec} ${conf}`;
  } else if (conf) {
    base = `${base} ${conf}`;
  }
  return <span class="small text-muted h6">{base}</span>;
};

export const GameThumb: FC<GameThumbProps> = ({ game }) => {
  const comp = game.competitions?.[0];
  if (!comp || !comp.competitors || comp.competitors.length < 2) return null;
  const homeComp = comp.competitors[0];
  const awayComp = comp.competitors[1];
  const homeScore =
    typeof homeComp.score === "object" && homeComp.score != null
      ? parseInt(String((homeComp.score as { displayValue?: unknown }).displayValue), 10)
      : parseInt(String(homeComp.score), 10);
  const awayScore =
    typeof awayComp.score === "object" && awayComp.score != null
      ? parseInt(String((awayComp.score as { displayValue?: unknown }).displayValue), 10)
      : parseInt(String(awayComp.score), 10);
  const homeTeam = homeComp.team ?? {};
  const awayTeam = awayComp.team ?? {};
  const completed = game.status?.type?.completed === true;
  const name = game.status?.type?.name ?? "";
  const detail = game.status?.type?.detail ?? "";
  const isCanceled = detail.includes("Cancel") || detail.includes("Postpone");
  const spice = calculateSpiceLevel(game);
  const note = comp.notes?.[0]?.headline ?? "";
  const isChampionship = [
    "CFP",
    "College Football Playoff",
    "National Championship",
    "FCS Championship",
    "Celebration Bowl",
    "Division II Championship",
    "Division III Championship",
  ].some((m) => note.includes(m));

  let borderClass = `spice-level-${spice}`;
  if (spice === SPICE.BELL && isChampionship) borderClass = "";
  const btnTheme = isChampionship ? "btn-outline-championship" : "btn-outline-primary";

  const cell = (
    competitor: typeof homeComp,
    score: number,
    winner: boolean,
    spacer: string | null,
  ): Child => {
    const rank = competitor.curatedRank?.current ?? 99;
    const team = competitor.team ?? {};
    const ballOwnerId = comp.situation?.lastPlay?.end?.team?.id;
    const hasBall = ballOwnerId != null && String(ballOwnerId) === String(competitor.id);
    const isRedZone = comp.situation?.isRedZone === true;
    const possessionClass = isRedZone ? "text-danger" : "text-primary";
    const scoreContent =
      name.includes("STATUS_SCHEDULED") || isCanceled
        ? null
        : formatScore(score, winner, completed);
    return (
      <div class={`m-0 ${spacer ?? ""} d-flex`}>
        <div class="d-flex me-auto">
          <img
            class={`float-start align-self-center me-2 team-logo-${competitor.id}`}
            height="30px"
            src={`https://a.espncdn.com/i/teamlogos/ncaa/500/${competitor.id}.png`}
          />
          <div class="d-flex flex-column me-3 align-self-center">
            <div class="d-flex align-items-center">
              <span class={`small text-muted${rank !== 99 ? " me-1" : ""}`}>
                {rank !== 99 ? `#${rank}` : ""}
              </span>
              <span class="align-self-center h4 mb-0">
                {formatScore(cleanAbbreviation(team), winner, completed)}
                {hasBall && <span class={`ms-1 ${possessionClass}`}>{"•"}</span>}
              </span>
            </div>
            {recordString(competitor)}
          </div>
        </div>
        <span class="align-self-center h4">
          <strong>{scoreContent}</strong>
        </span>
      </div>
    );
  };

  const lastPlay = comp.situation?.lastPlay;
  const hasLastPlay = comp.situation != null && lastPlay != null;
  const lastPlayText = lastPlay?.text ?? "";
  const isPATContext =
    lastPlayText.toLocaleLowerCase().includes("two-point conversion") ||
    lastPlayText.includes("KICK");
  const isKickoffContext = lastPlayText.toLocaleLowerCase().includes("kickoff");
  const noDownDistance =
    !comp.situation?.downDistanceText || comp.situation.downDistanceText.length === 0;

  const renderNetwork = (): Child => {
    const geoMedia = comp.geoBroadcasts?.[0]?.media;
    const geoName = geoMedia?.shortName;
    const fallbackMedia = comp.broadcasts?.[0]?.media;
    const fallbackName = fallbackMedia?.shortName;
    const networkName = geoName ?? fallbackName;
    if (!networkName) return null;
    if (NETWORK_MAPPINGS[networkName]) {
      return (
        <a
          class="btn btn-sm btn-outline-secondary"
          role="button"
          target="_blank"
          href={NETWORK_MAPPINGS[networkName]}
        >
          {networkName}
        </a>
      );
    }
    if (ESPN_NETWORK_MARKERS.some((m) => networkName.includes(m))) {
      return (
        <a
          class="btn btn-sm btn-outline-secondary"
          role="button"
          target="_blank"
          href={`https://www.espn.com/watch/player/_/eventCalendarId/${comp.id}`}
        >
          {networkName}
        </a>
      );
    }
    return <span class="badge bg-secondary bg-sm align-self-center">{networkName}</span>;
  };

  const previewDisabled =
    (name.includes("STATUS_DELAYED") && !hasLastPlay) ||
    isCanceled ||
    (name.includes("STATUS_IN_PROGRESS") && !hasLastPlay);

  return (
    <div
      class={`row border rounded m-2 mb-4 ${isChampionship ? "outline-championship" : ""} ${borderClass}`}
    >
      <div class="col p-3">
        <div class="d-flex justify-content-between">
          <strong
            class={`d-inline-block mb-2 ${isChampionship ? "text-championship" : "text-primary"} game-context small`}
          >
            {name.includes("STATUS_SCHEDULED") ? (
              <span class="game-date">{game.date}</span>
            ) : completed ? (
              <>
                <span class="game-status">{detail} -</span>{" "}
                <span class="game-date">{game.date}</span>
              </>
            ) : (
              detail
            )}
          </strong>
          {SICKOS_GOTW.includes(String(game.id ?? "")) && (
            <a href="https://twitter.com/sickoscommittee">
              <img
                class="rotate"
                height="25px"
                src="/assets/img/sickos.png"
                alt="Nominated as 'Sickos Game of the Week' by SickosCommittee."
                title="Nominated as 'Sickos Game of the Week' by SickosCommittee."
              />
            </a>
          )}
        </div>
        {cell(awayComp, awayScore, awayScore > homeScore, null)}
        {cell(homeComp, homeScore, awayScore < homeScore, "mb-2")}
        {!(completed || isCanceled) && hasLastPlay && (
          <div class="card-text mb-2">
            {isPATContext ? (
              <>
                <p class="mb-0 text-muted">
                  <strong>Last Play:</strong> {lastPlayText}
                </p>
                <p class="mb-0 text-muted">
                  <strong>Next:</strong> PAT
                </p>
              </>
            ) : isKickoffContext ? (
              <>
                <p class="mb-0 text-muted">
                  <strong>Last Play:</strong> {lastPlayText}
                </p>
                <p class="mb-0 text-muted">
                  <strong>Next:</strong> Kickoff
                </p>
              </>
            ) : noDownDistance ? (
              <p class="mb-0 text-muted">
                <strong>Last Play:</strong> {lastPlayText}
              </p>
            ) : (
              <>
                <p class="mb-0 text-muted">
                  <strong>Last Play:</strong> {lastPlayText}
                </p>
                <p class="mb-0 text-muted">
                  <strong>Next:</strong> {comp.situation?.downDistanceText}
                </p>
              </>
            )}
            {lastPlay?.probability && (() => {
              const home = lastPlay.probability.homeWinPercentage ?? 0;
              const away = lastPlay.probability.awayWinPercentage ?? 0;
              if (home > away) {
                return (
                  <p class="mb-0 text-muted">
                    <strong>ESPN WP%:</strong> {cleanAbbreviation(homeTeam)}{" "}
                    {roundNumber(home * 100, 2, 1)}%
                  </p>
                );
              }
              if (home < away) {
                return (
                  <p class="mb-0 text-muted">
                    <strong>ESPN WP%:</strong> {cleanAbbreviation(awayTeam)}{" "}
                    {roundNumber(away * 100, 2, 1)}%
                  </p>
                );
              }
              return (
                <p class="mb-0 text-muted">
                  <strong>ESPN WP%:</strong> 50%
                </p>
              );
            })()}
          </div>
        )}
        <div class="d-flex justify-content-between">
          <div class="text-left">
            {name.includes("STATUS_SCHEDULED") ? (
              <a class={`btn btn-sm ${btnTheme}`} role="button" href={`/cfb/game/${game.id}`}>
                Preview
              </a>
            ) : (
              <a
                class={`btn btn-sm ${btnTheme}${previewDisabled ? " disabled" : ""}`}
                role="button"
                href={`/cfb/game/${game.id}`}
              >
                Stats
              </a>
            )}
          </div>
          <div class="text-right">{renderNetwork()}</div>
        </div>
      </div>
    </div>
  );
};
