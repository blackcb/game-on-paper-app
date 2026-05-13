import type { FC } from "hono/jsx";
import { Layout } from "./Layout";
import { GameThumb } from "./GameThumb";
import type { GroupEntry, WeekEntry } from "../lib/schedule";
import type { ScheduleEvent } from "../lib/team_helpers";

// Reproduces frontend/views/pages/cfb/index.ejs. Used by all three
// scoreboard-shaped routes: /cfb/, /cfb/year/:year, and
// /cfb/year/:year/type/:type/week/:week — they pass different
// year/week/seasontype combinations, but the page shell is identical.

interface Props {
  scoreboard: ScheduleEvent[];
  weekList: Record<string, WeekEntry[]>;
  groups: GroupEntry[];
  year: number | string | null;
  week: number | string | null;
  seasontype: number | string;
  group: number | string;
  title: string | null;
  hasActiveGames: boolean;
}

// Years offered in the season dropdown — matches index.ejs:54
// (`range(2002, 2025)` reversed).
const YEAR_RANGE_END = 2025;
const YEAR_RANGE_START = 2002;

export const ScoreboardPage: FC<Props> = ({
  scoreboard,
  weekList,
  groups,
  year,
  week,
  seasontype,
  group,
  title,
  hasActiveGames,
}) => {
  const titleParts: string[] = [];
  if (year != null) titleParts.push(String(year));
  if (title) titleParts.push(title);
  titleParts.push("College Football", "Game on Paper");
  const fullTitle = titleParts.join(" | ");
  const subtitle = title ? `${title} scoreboard` : "College football scoreboard";
  const canonical = `https://gameonpaper.com/cfb/${
    year != null ? `year/${year}/type/${seasontype}/week/${week}` : ""
  }`;

  // Per-game dark-mode logo override. The EJS version emits one
  // declaration per home + away team across the whole scoreboard;
  // collapse to a Set so each team appears once.
  const teamIds = new Set<string | number>();
  for (const game of scoreboard) {
    const comp = game.competitions?.[0];
    const home = comp?.competitors?.[0]?.team?.id;
    const away = comp?.competitors?.[1]?.team?.id;
    if (home != null) teamIds.add(home);
    if (away != null) teamIds.add(away);
  }
  const darkLogoCss = `@media (prefers-color-scheme: dark) {\n${[...teamIds]
    .map(
      (id) =>
        `  img.team-logo-${id} { content: url('https://a.espncdn.com/i/teamlogos/ncaa/500-dark/${id}.png'); }`,
    )
    .join("\n")}\n}\nimg.team-logo-61 { content: url('/assets/img/ennui-uga.png'); }`;

  const yrRange: number[] = [];
  for (let y = YEAR_RANGE_END; y >= YEAR_RANGE_START; y--) yrRange.push(y);

  const extraHead = (
    <>
      <link href="/assets/css/bootstrap.min.css" rel="stylesheet" crossorigin="anonymous" />
      <link href="/assets/css/index.css" rel="stylesheet" />
      {/*
        dark-index.css is 81 kB of DarkReader auto-generated dark-mode
        overrides — see the ASCII-art header at the top of the file.
        Its entire content is already wrapped in `@media (prefers-
        color-scheme: dark) { ... }`, so the rules never match for
        light-mode users. But without an outer `media` attribute the
        browser still treats the <link> as render-blocking and waits
        for the download. `media="(prefers-color-scheme: dark)"`
        lets light-mode users — likely the majority — skip the block:
        the file is still fetched but at a lower priority and doesn't
        gate first paint. Dark-mode users are unaffected.

        Long-term TODO: rewrite this file by hand. The DarkReader
        export contains thousands of noise rules (grid-gutter re-
        declarations, `border-color: initial` resets); the actual
        color-relevant rules are maybe ~200 lines.
      */}
      <link
        href="/assets/css/dark-index.css"
        rel="stylesheet"
        media="(prefers-color-scheme: dark)"
      />
      <style dangerouslySetInnerHTML={{ __html: darkLogoCss }} />
    </>
  );

  const weekDataJson = JSON.stringify(weekList);
  const yearJson = year == null ? "null" : JSON.stringify(String(year));
  const weekJson = week == null ? "null" : JSON.stringify(String(week));
  const seasonTypeJson = JSON.stringify(String(seasontype));

  const extraScripts = (
    <>
      <script
        dangerouslySetInnerHTML={{
          __html: `
            // Inline replacement for /assets/js/date-replace.js +
            // luxon.min.js (~70 kB) — same behavior with native
            // Intl.DateTimeFormat. STATUS_FINAL games get a date-only
            // render; everything else (STATUS_SCHEDULED with a future
            // kickoff) gets date + time. Browser locale + timezone
            // are honored just like Luxon's toLocaleString.
            //
            // Don't use dateStyle:"short" — it emits a 2-digit year
            // in en-US ("8/29/26"), whereas Luxon's DATE_SHORT /
            // DATETIME_SHORT presets emit 4-digit ("8/29/2026").
            // Explicit per-field opts preserve upstream's format.
            (function() {
              var dateOpts = { year: "numeric", month: "numeric", day: "numeric" };
              var dateTimeOpts = { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" };
              var ctxs = document.getElementsByClassName("game-context");
              for (var i = 0; i < ctxs.length; i++) {
                var ctx = ctxs[i];
                var dateSpan = ctx.querySelector(".game-date");
                if (!dateSpan) continue;
                var d = new Date(dateSpan.textContent.trim());
                if (isNaN(d.getTime())) continue;
                var statusSpan = ctx.querySelector(".game-status");
                var statusText = statusSpan ? statusSpan.textContent.trim() : "";
                var isFinal = statusText.indexOf("FINAL") >= 0 || statusText.charAt(0) === "F";
                dateSpan.textContent = isFinal
                  ? d.toLocaleDateString([], dateOpts)
                  : d.toLocaleString([], dateTimeOpts);
              }
            })();
          `,
        }}
      ></script>
      <script
        dangerouslySetInnerHTML={{
          __html: `
            const weekData = ${weekDataJson};
            const selYear = ${yearJson};
            const selWeek = ${weekJson};
            const selSeasonType = ${seasonTypeJson};
            const availYearKeys = Object.keys(weekData).reverse();

            function clearSelect(id) {
              var select = document.getElementById(id);
              var length = select.options.length;
              for (var i = length-1; i >= 0; i--) {
                if (parseInt(select.options[i].value) != -1) {
                  select.options[i] = null;
                }
              }
              select.selectedIndex = 0;
            }

            function populateWeekSelect(val) {
              var yr = val || availYearKeys[0];
              clearSelect("weekSelect");
              if (parseInt(yr) != -1) {
                if (yr == null) yr = availYearKeys[availYearKeys.length - 1];
                var selWeeks = weekData[String(yr)] || [];
                var weekSelect = document.getElementById("weekSelect");
                var selIndex = -1;
                selWeeks.forEach(function(wk, idx) {
                  var option = document.createElement("option");
                  option.text = wk.label;
                  option.value = wk.type + ";" + wk.value;
                  if (parseInt(selSeasonType) == parseInt(wk.type) && parseInt(selWeek) == parseInt(wk.value)) {
                    selIndex = idx + 1;
                  }
                  weekSelect.add(option);
                });
                weekSelect.selectedIndex = selIndex;
              }
            }

            document.getElementById("yearSelect").selectedIndex = 0;
            if (selYear != null) {
              availYearKeys.forEach(function(yr, idx) {
                if (selYear == yr) {
                  document.getElementById("yearSelect").selectedIndex = idx + 1;
                }
              });
            }
            populateWeekSelect(selYear || -1);
          `,
        }}
      ></script>
      <script
        dangerouslySetInnerHTML={{
          __html: `
            document.getElementById("dropdown-form").addEventListener("submit", function(e) {
              e.preventDefault();
              var year = document.getElementById("yearSelect").value;
              var week = document.getElementById("weekSelect").value;
              var group = document.getElementById("groupSelect").value;
              var baseUrl = "/cfb/";
              if (year != "-1" && week != "-1") {
                baseUrl += "year/" + year + "/type/";
                var parts = week.split(";");
                baseUrl += parts[0] + "/week/" + parts[1];
              }
              if (group != null) baseUrl += "?group=" + group;
              window.location = baseUrl;
            });

            // Function-form setTimeout + bare location.reload().
            // The string form was eval'd (CSP-unfriendly) and
            // reload(true) takes a deprecated argument. Bigger lift
            // (fetch JSON, diff, patch the DOM without losing scroll
            // position) is queued for football season (Aug 20+),
            // when we can validate against live games.
            if (${hasActiveGames ? "true" : "false"}) {
              setTimeout(function() { location.reload(); }, 60 * 1000);
            }
          `,
        }}
      ></script>
      <script
        dangerouslySetInnerHTML={{
          __html: `
            document.getElementById("game-id-form").addEventListener("submit", function(e) {
              e.preventDefault();
              var rawGameId = document.getElementById("inputGameId").value;
              if (!rawGameId) return;
              var gameId = parseInt(rawGameId);
              if (!gameId) return;
              window.location.href = "/cfb/game/" + gameId;
            });
          `,
        }}
      ></script>
    </>
  );

  return (
    <Layout
      title={fullTitle}
      subtitle={subtitle}
      canonical={canonical}
      extraHead={extraHead}
      extraScripts={extraScripts}
      hideHeader={true}
      minimalScripts={true}
    >
      <div class="container">
        <div class="row text-center mb-3">
          <div class="form-signin col-12">
            <h1 class="mb-3 fw-normal">Game on Paper</h1>
            <form id="game-id-form">
              <label for="inputGameId" class="visually-hidden">Game ID</label>
              <input
                type="text"
                id="inputGameId"
                class="form-control mb-3"
                placeholder="Provide a valid ESPN Game ID for a CFB game"
                required={true}
              />
              <button class="w-100 btn btn-lg btn-primary" type="submit">
                View Stats
              </button>
            </form>
          </div>
        </div>
        <div class="row mb-1">
          <h3 class="text-center"> -- OR -- </h3>
        </div>
        <div class="row justify-content-center">
          <div class="col-lg-3 col-xs-12 mb-3">
            <a href="/cfb/teams" class="w-100 btn btn-lg btn-primary">Team Leaderboards</a>
          </div>
          <div class="col-lg-3 col-xs-12 mb-3">
            <a href="/cfb/players" class="w-100 btn btn-lg btn-primary">Player Leaderboards</a>
          </div>
        </div>
        <div class="row mb-1">
          <h3 class="text-center"> -- OR -- </h3>
        </div>
        <form class="form-picker mb-3" id="dropdown-form">
          <div class="row">
            <div class="col-lg-auto mb-3">
              <select
                class="form-select form-select-lg"
                id="yearSelect"
                onchange="populateWeekSelect(this.value);"
              >
                <option value="-1">Choose Season...</option>
                {yrRange.map((yr) => (
                  <option value={String(yr)}>{yr}</option>
                ))}
              </select>
            </div>
            <div class="col-lg-auto mb-3">
              <select class="form-select form-select-lg" id="weekSelect">
                <option value="-1" selected={week == null || seasontype == null}>
                  Choose Week...
                </option>
              </select>
            </div>
            <div class="col-lg-auto mb-3">
              <select class="form-select form-select-lg" id="groupSelect">
                {groups.map((g) => (
                  <option
                    value={String(g.id)}
                    selected={String(group) === String(g.id) || (group == null && g.id === 80)}
                  >
                    {g.name}
                  </option>
                ))}
              </select>
            </div>
            <div class="col-lg-auto mb-3">
              <button type="submit" class="btn btn-lg btn-primary">
                View
              </button>
            </div>
          </div>
        </form>
        <div class="row mb-3">
          {scoreboard.length > 0 ? (
            scoreboard.map((game) => (
              <div class="col-xl-3 col-lg-6">
                <GameThumb game={game} />
              </div>
            ))
          ) : (
            <p class="text-center text-muted">No games scheduled.</p>
          )}
        </div>
        {hasActiveGames && (
          <div class="row mb-3">
            <div class="col-12">
              <p class="text-small text-muted">
                Because there are active games, page will auto-refresh every minute.
              </p>
            </div>
          </div>
        )}
        <div class="row text-muted">
          <div class="col-12">
            <caption>
              Game border color guide:
              <ul>
                <li>
                  <strong>Gray</strong> - normal
                </li>
                <li>
                  <strong>Green</strong> - Close game late
                </li>
                <li>
                  <strong>Yellow</strong> - Ranked Upset
                </li>
                <li>
                  <strong>Orange</strong> - Ranked Opponents + close game late
                </li>
                <li>
                  <strong>Red</strong> - FCS Upset
                </li>
              </ul>
            </caption>
          </div>
        </div>
      </div>
    </Layout>
  );
};
