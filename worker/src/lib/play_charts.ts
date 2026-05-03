// Server-side aggregations for the per-team pass / rush matrices and
// the per-drive field chart. Ports the inline EJS in
// frontend/views/partials/{pass_chart,rush_chart,field}.ejs and the
// drive-row/play-row helpers in game.ejs.

export interface PassMatrixCell {
  attempts: number;
  completions: number;
  yards: number;
  EPA: number;
  TD: number;
}

export type PassMatrix = {
  short: { left: PassMatrixCell; middle: PassMatrixCell; right: PassMatrixCell };
  deep: { left: PassMatrixCell; middle: PassMatrixCell; right: PassMatrixCell };
  countableAttempts: number;
};

const DEPTH_REGEX = /\s(short|deep)\s/g;
const DIRECTION_REGEX = /\s(left|middle|right)\s/g;

function newPassCell(): PassMatrixCell {
  return { attempts: 0, completions: 0, yards: 0, EPA: 0, TD: 0 };
}

// Mirrors pass_chart.ejs:12-124. Returns `countableAttempts === 0`
// when there's no usable depth/direction data — caller suppresses the
// matrix entirely in that case (matches the EJS `if (countableAttempts > 0)`
// gate at line 166).
export function computePassMatrix(plays: Array<Record<string, unknown>>): PassMatrix {
  const matrix: PassMatrix = {
    short: { left: newPassCell(), middle: newPassCell(), right: newPassCell() },
    deep: { left: newPassCell(), middle: newPassCell(), right: newPassCell() },
    countableAttempts: 0,
  };

  for (const p of plays) {
    if (p.pass !== 1) continue;
    const text = String(p.text ?? "");
    const depthMatches = text.match(DEPTH_REGEX);
    if (!depthMatches || depthMatches.length === 0) continue;
    const depth = depthMatches[0].trim() as "short" | "deep";
    const directionMatches = text.match(DIRECTION_REGEX);
    if (!directionMatches || directionMatches.length === 0) continue;
    const direction = directionMatches[0].trim() as "left" | "middle" | "right";
    if (!matrix[depth] || !matrix[depth][direction]) continue;

    matrix.countableAttempts += 1;
    const cell = matrix[depth][direction];
    cell.attempts += 1;
    cell.EPA += parseFloat(String(p.EPA ?? 0)) || 0;
    cell.TD += parseInt(String(p.pass_td ?? 0), 10) || 0;
    cell.yards += parseFloat(String(p.yds_passing ?? 0)) || 0;
    if ((p.completion ?? 0) === 1) cell.completions += 1;
  }
  return matrix;
}

export interface RushMatrixCell {
  attempts: number;
  yards: number;
  EPA: number;
  TD: number;
}

export type RushMatrix = {
  left: RushMatrixCell;
  middle: RushMatrixCell;
  right: RushMatrixCell;
  countableAttempts: number;
};

function newRushCell(): RushMatrixCell {
  return { attempts: 0, yards: 0, EPA: 0, TD: 0 };
}

// Mirrors rush_chart.ejs:12-63. Same suppression-on-empty contract as
// the pass matrix.
export function computeRushMatrix(plays: Array<Record<string, unknown>>): RushMatrix {
  const matrix: RushMatrix = {
    left: newRushCell(),
    middle: newRushCell(),
    right: newRushCell(),
    countableAttempts: 0,
  };
  for (const p of plays) {
    if (p.rush !== 1) continue;
    const text = String(p.text ?? "");
    const directionMatches = text.match(DIRECTION_REGEX);
    if (!directionMatches || directionMatches.length === 0) continue;
    const direction = directionMatches[0].trim() as "left" | "middle" | "right";
    if (!matrix[direction]) continue;
    matrix.countableAttempts += 1;
    const cell = matrix[direction];
    cell.attempts += 1;
    cell.EPA += parseFloat(String(p.EPA ?? 0)) || 0;
    cell.TD += parseInt(String(p.rush_td ?? 0), 10) || 0;
    cell.yards += parseFloat(String(p.yds_rushed ?? 0)) || 0;
  }
  return matrix;
}

// One drive's renderable description for the per-drive field chart.
// The EJS partial inlines a `<canvas>` plus a `<script>function renderXX()`
// block per drive that pushes plays into the global `Field` class
// defined in /assets/js/field.js. We mirror the script's body server-
// side and emit it as a single string the JSX can dangerously-set.
export interface FieldChartTeam {
  id: string | number;
  abbreviation?: string;
  color?: string;
}

export interface FieldChartPlay {
  type?: { text?: string };
  start: { yardsToEndzone: number; team?: { id: string | number } };
  end: { yardsToEndzone: number; team?: { id: string | number } };
  pass?: 0 | 1;
  rush?: 0 | 1;
}

const FIELD_BOISE_STATE_ID = 68;
const FIELD_COASTAL_CAROLINA_ID = 324;
const FIELD_SKIP_TYPES = new Set([
  "Kickoff",
  "Timeout",
  "Kickoff Return (Offense)",
  "Field Goal Good",
  "Field Goal Missed",
]);

// Mirrors field.ejs in full. Returns the JS function body that renders
// one drive into a `<canvas id="football-field-${id}">`. The caller
// emits `function render${id}() { ... }` around it.
export function buildFieldRenderScript(args: {
  driveId: string | number;
  plays: FieldChartPlay[];
  offense: FieldChartTeam;
  defense: FieldChartTeam;
  homeTeamId: string | number;
  result: string;
  isNeutralSite: boolean;
  subtitle: string;
}): string {
  const { driveId, plays, offense, defense, homeTeamId, result, isNeutralSite, subtitle } = args;

  let fieldColor = "rgb(0, 153, 41)";
  const homeIdNum = parseInt(String(homeTeamId), 10);
  if (!isNeutralSite && homeIdNum === FIELD_BOISE_STATE_ID) fieldColor = "#12329A";
  else if (!isNeutralSite && homeIdNum === FIELD_COASTAL_CAROLINA_ID) fieldColor = "#307077";

  const lines: string[] = [];
  lines.push(
    `let field = new Field('football-field-${driveId}', ${JSON.stringify(fieldColor)}, ${JSON.stringify(offense)}, ${JSON.stringify(defense)}, baseLineWidth = 10, subtitle = ${JSON.stringify(subtitle)});`,
  );
  for (let i = 0; i < plays.length; i++) {
    const play = plays[i];
    const annotation = i === plays.length - 1 ? JSON.stringify(result) : "null";
    let text: string = "null";
    if (play.rush === 1) text = JSON.stringify("R");
    if (play.pass === 1) text = JSON.stringify("P");

    const startYTE = play.start.yardsToEndzone;
    const endTeamId = String(play.end.team?.id ?? "");
    const startTeamId = String(play.start.team?.id ?? "");
    const sameSide = endTeamId === startTeamId;

    let endYardsToEndzone =
      !sameSide ? 100 - play.end.yardsToEndzone : play.end.yardsToEndzone;
    if (sameSide && play.end.yardsToEndzone === 99) endYardsToEndzone = 0;
    const playTypeText = play.type?.text ?? "";
    if (playTypeText.includes("Punt") || (!sameSide && play.end.yardsToEndzone === 99)) {
      endYardsToEndzone = play.start.yardsToEndzone;
    }

    if (!FIELD_SKIP_TYPES.has(playTypeText)) {
      lines.push(
        `field.markPlay('#${offense.color ?? "000000"}', ${startYTE}, ${endYardsToEndzone}, text = ${text}, annotation = ${annotation});`,
      );
    } else if (playTypeText === "Field Goal Good" || playTypeText === "Field Goal Missed") {
      lines.push(
        `field.markPlay('#${offense.color ?? "000000"}', ${startYTE}, ${startYTE}, text = ${text}, annotation = ${annotation});`,
      );
    }
  }
  return lines.join("\n");
}
