import type { FC, Child } from "hono/jsx";
import { Layout } from "./Layout";
import { roundNumber } from "../lib/leaderboard";
import {
  STAT_KEY_TITLE_MAPPING,
  TEAM_SLICE_COLUMNS,
  buildSliceCells,
  calculateSpiceLevel,
  cleanAbbreviation,
  cleanLocation,
  CONFERENCE_MAP,
  getNumberWithOrdinal,
  hexToRgb,
  maxTeamsForSeason,
  SPICE,
  sliceColorRamp,
  teamCardMarginal,
  type ScheduleEvent,
  type SliceSituation,
  type SliceTarget,
} from "../lib/team_helpers";

// Reproduces frontend/views/pages/cfb/team_season.ejs and the five
// EJS partials it composes (team_card, team_player_cards,
// team_slice ×6, player_box ×3, game_thumb ×N). All inlined as
// subcomponents in this file because they don't reuse outside this
// page (game_thumb will move to its own module when /cfb/ scoreboard
// gets ported and starts rendering the same card grid).

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

// ---------- team_card ------------------------------------------------

interface TeamCardProps {
  teamData: TeamData;
  breakdown: Array<Record<string, unknown>>;
  season: number | string;
  hideNavigation: boolean;
}

const TeamCard: FC<TeamCardProps> = ({ teamData, breakdown, season, hideNavigation }) => {
  const team = teamData;
  const location = cleanLocation({ id: team.id, location: team.location });
  const maxTeams = maxTeamsForSeason(season);
  const records = teamData.record ?? [];
  const overallStuff = records.find((r) => r.type === "total");
  const overall = overallStuff?.displayValue ?? "0-0";
  const finishStat = overallStuff?.stats?.find((s) => s.name === "playoffSeed");
  const finish = finishStat
    ? getNumberWithOrdinal(parseInt(String(finishStat.displayValue), 10))
    : "N/A";
  const confRecs = records.filter((r) => r.type === "vsconf");
  const conf = confRecs.length > 0 ? ` (Conf: ${confRecs[0].displayValue})` : "";

  const first = (breakdown[0] ?? {}) as Record<string, Record<string, Record<string, unknown>> | unknown>;
  const isBreakdownAvailable = first.differential != null;
  const diff = (first.differential as Record<string, Record<string, unknown>> | undefined)?.overall ?? {};
  const yearPrefix =
    (first as { season?: unknown }).season &&
    String(season) !== String((first as { season?: unknown }).season)
      ? `${(first as { season?: unknown }).season} `
      : "";

  const rampClass = (rank: unknown): string => {
    const c = sliceColorRamp(rank);
    if (!c) return "";
    // The EJS variant divides by maxTeams (130/131/134) instead of the
    // hardcoded 130 in sliceColorRamp. Recompute here for fidelity.
    if (rank == null || rank === "") return "";
    const value = (maxTeams - parseFloat(String(rank))) / maxTeams;
    const step = Math.round(value / 0.1);
    const clamped = Math.min(Math.max(step, 0), 9);
    if (clamped === 4 || clamped === 5) return "";
    return ` hulk-bg-level-${clamped}`;
  };

  const cell = (
    statKey: string,
    formatter: (n: number) => string,
  ) => {
    const stat = diff[statKey] as number | undefined;
    const rank = diff[`${statKey}Rank`];
    return (
      <td class={`numeral text-center${rampClass(rank)}`} style="width: 33%">
        {formatter(parseFloat(String(stat ?? 0)))}
        {rank != null && (
          <small class="align-self-center" style="opacity: 50%">
            {" "}
            #{rank as Child}
          </small>
        )}
      </td>
    );
  };

  return (
    <div class="card border rounded">
      <div class="card-body">
        <div class="card-title mb-0">
          <div class="d-flex align-items-center justify-content-between">
            <h2>{location}</h2>
            <img
              class={`h2 img img-fluid me-1 team-logo-${team.id}`}
              width="50px"
              src={`https://a.espncdn.com/i/teamlogos/ncaa/500/${team.id}.png`}
            />
          </div>
        </div>
        <div class="table-responsive">
          <table class="table table-sm table-responsive">
            <thead>
              <th class="text-center" style="width: 33%">{season} Record</th>
              <th class="text-center" style="width: 33%">{season} Conf Finish</th>
              <th class="text-center" style="width: 33%">{yearPrefix}EPA/Play</th>
            </thead>
            <tbody>
              <tr>
                <td class="numeral text-center" style="width: 33%">
                  {overall}
                  {conf}
                </td>
                <td class="numeral text-center" style="width: 33%">{finish}</td>
                {cell("epaPerPlay", (n) => teamCardMarginal(n, 2, 2))}
              </tr>
            </tbody>
          </table>
        </div>
        <div class="table-responsive pe-0">
          <table class="table table-sm table-responsive">
            <caption class="text-small text-muted">
              <small>
                <p class="mb-0">
                  Stats shown as margins. AY% (available yards pct) concept from Brian Fremeau (
                  <a href="http://bcftoys.com">http://bcftoys.com</a>).
                </p>
              </small>
            </caption>
            <thead>
              <th class="text-center" style="width: 33%">{yearPrefix}Yards/Play</th>
              <th class="text-center" style="width: 33%">{yearPrefix}AY%</th>
              <th class="text-center" style="width: 33%">{yearPrefix}Success %</th>
            </thead>
            <tbody>
              <tr>
                {cell("yardsPerPlay", (n) => teamCardMarginal(n, 2, 2))}
                {cell("availableYardsPct", (n) => `${teamCardMarginal(100 * n, 2, 1)}%`)}
                {cell("successRate", (n) => `${teamCardMarginal(100 * n, 2, 1)}%`)}
              </tr>
            </tbody>
          </table>
        </div>
        {isBreakdownAvailable && !hideNavigation && (
          <a class="text-left" href={`/cfb/year/${season}/team/${team.id}`}>View full profile</a>
        )}
      </div>
    </div>
  );
};

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

// ---------- team_slice ----------------------------------------------

interface TeamSliceProps {
  breakdown: Array<Record<string, unknown>>;
  title: string;
  target: SliceTarget;
  situation: SliceSituation;
}

const TeamSlice: FC<TeamSliceProps> = ({ breakdown, title, target, situation }) => {
  const columns = TEAM_SLICE_COLUMNS[target][situation];
  return (
    <div class="table-responsive">
      <table class="table table-sm table-responsive">
        <thead>
          <tr>
            <th style="text-align: left; width: 50%;">{title}</th>
            <th style="width: 50%">
              <span hidden>Value</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {columns.map((item) => {
            const cells = buildSliceCells(item, breakdown, target, situation);
            return (
              <tr>
                <td style="text-align: left; width: 50%;">
                  {STAT_KEY_TITLE_MAPPING[item] ?? item}
                </td>
                {cells.map((c) =>
                  c == null ? (
                    <td class="numeral" style="text-align: center;width: 50%;">
                      N/A{" "}
                      <small class="align-self-center" style="opacity: 50%">
                        {" "}
                        N/A
                      </small>
                    </td>
                  ) : (
                    <td
                      class={`align-self-center numeral${c.colorClass ? ` ${c.colorClass}` : ""}`}
                      style="text-align: center;width: 50%;"
                    >
                      {c.sign}
                      {c.text}
                      {c.rankString && (
                        <small class="align-self-center" style="opacity: 50%">
                          {c.rankString}
                        </small>
                      )}
                    </td>
                  ),
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
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

// ---------- game_thumb (schedule grid card) -------------------------

interface GameThumbProps {
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

const ESPN_NETWORK_MARKERS = ["ESPN", "LHN", "Longhorn Network", "ACCN", "ACC Network", "SEC Network", "SECN", "BIG12", "ABC"];
const INDY_CONFS = new Set([18, 35, 80, 81]);

const formatScore = (score: unknown, winner: boolean, complete: boolean): Child => {
  const text = String(score);
  if (winner && complete) return <strong>{text}</strong>;
  if (!winner && complete) return <span style="opacity: 0.5;">{text}</span>;
  return <span>{text}</span>;
};

const recordString = (competitor: { records?: Array<{ type?: string; summary?: string }>; team?: { conferenceId?: string | number } }): Child => {
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

const GameThumb: FC<GameThumbProps> = ({ game }) => {
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
                {hasBall && (
                  <span class={`ms-1 ${possessionClass}`}>{"•"}</span>
                )}
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

  // Network display branching — picks the right CTA per network kind.
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
    <div class={`row border rounded m-2 mb-4 ${isChampionship ? "outline-championship" : ""} ${borderClass}`}>
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
