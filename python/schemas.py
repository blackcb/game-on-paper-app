"""Pydantic models for the public /cfb/process JSON contract.

The actual response is much wider than what's enumerated here — each
play record has ~376 keys from the pandas DataFrame's flat column
namespace, plus dozens of computed metrics. We only validate the
*contract* fields: the ones produced by the per-record reshape in
`app.py:process()` (the nested `clock`, `type`, `expectedPoints`,
`winProbability`, `modelInputs`, `start`, `end` blocks) and the
top-level keys that the Node frontend depends on.

`extra='allow'` everywhere means unknown / future fields don't break
validation — the snapshot tests already catch byte-level changes;
this layer catches *shape* changes, which matter when the Node
frontend or the upstream PR changes how it reads the response.

The exported JSON Schema (`shared/process-response.schema.json`) is
consumed by ajv on the Node side. Regenerate it with:

    cd python && python -m schemas > ../shared/process-response.schema.json
"""

from __future__ import annotations

import json
import sys
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict


_ALLOW_EXTRA = ConfigDict(extra="allow")


class Clock(BaseModel):
    """The reshaped play.clock block from app.py.

    Source columns are typed inconsistently in pandas (sometimes int,
    sometimes string like "15"/"00"); the contract is that the keys
    are present.
    """

    model_config = _ALLOW_EXTRA
    displayValue: Optional[str] = None
    minutes: Optional[Any] = None
    seconds: Optional[Any] = None


class TypeBlock(BaseModel):
    model_config = _ALLOW_EXTRA
    id: Optional[str] = None
    text: Optional[str] = None
    abbreviation: Optional[str] = None


class ExpectedPoints(BaseModel):
    model_config = _ALLOW_EXTRA
    before: Optional[float] = None
    after: Optional[float] = None
    added: Optional[float] = None


class WinProbability(BaseModel):
    model_config = _ALLOW_EXTRA
    before: Optional[float] = None
    after: Optional[float] = None
    added: Optional[float] = None


class ModelInputsSide(BaseModel):
    """Either play.modelInputs.start or play.modelInputs.end.

    Inputs the EP/WP models consume — keys must be present even if
    the value is null/NaN, because the model wrappers in
    sportsdataverse.cfb.cfb_pbp coerce types downstream.
    """

    model_config = _ALLOW_EXTRA
    down: Optional[Any] = None
    distance: Optional[Any] = None
    yardsToEndzone: Optional[Any] = None
    TimeSecsRem: Optional[Any] = None
    adj_TimeSecsRem: Optional[Any] = None
    pos_score_diff: Optional[Any] = None
    posTeamTimeouts: Optional[Any] = None
    defTeamTimeouts: Optional[Any] = None
    ExpScoreDiff: Optional[Any] = None
    ExpScoreDiff_Time_Ratio: Optional[Any] = None
    spread_time: Optional[Any] = None
    pos_team_receives_2H_kickoff: Optional[Any] = None
    is_home: Optional[Any] = None
    period: Optional[Any] = None


class ModelInputs(BaseModel):
    model_config = _ALLOW_EXTRA
    start: ModelInputsSide
    end: ModelInputsSide


class TeamRef(BaseModel):
    """A {id, name} reference inside play.start.pos_team and similar.

    `id` is *usually* a string but ESPN occasionally serves it as an int
    (observed for a single play in the 401403910 fixture: an int `142` on
    the last play's `end.def_pos_team.id`). Accept Any.
    """

    model_config = _ALLOW_EXTRA
    id: Optional[Any] = None
    name: Optional[str] = None


class StartSide(BaseModel):
    """The play.start block produced by the reshape."""

    model_config = _ALLOW_EXTRA
    distance: Optional[Any] = None
    yardLine: Optional[Any] = None
    down: Optional[Any] = None
    yardsToEndzone: Optional[Any] = None
    homeScore: Optional[Any] = None
    awayScore: Optional[Any] = None
    pos_team_score: Optional[Any] = None
    def_pos_team_score: Optional[Any] = None
    pos_score_diff: Optional[Any] = None
    posTeamTimeouts: Optional[Any] = None
    defTeamTimeouts: Optional[Any] = None
    ExpScoreDiff: Optional[Any] = None
    ExpScoreDiff_Time_Ratio: Optional[Any] = None
    shortDownDistanceText: Optional[Any] = None
    possessionText: Optional[Any] = None
    downDistanceText: Optional[Any] = None
    posTeamSpread: Optional[Any] = None
    pos_team: Optional[TeamRef] = None
    def_pos_team: Optional[TeamRef] = None
    team: Optional[dict] = None  # {id} only at start


class EndSide(BaseModel):
    """The play.end block produced by the reshape.

    Differs from StartSide in two ways:
      - field is `defPosTeamTimeouts` instead of `defTeamTimeouts`
        (legacy naming inherited from upstream — fix in Phase 1)
      - no `posTeamSpread` (only on start side)
    """

    model_config = _ALLOW_EXTRA
    distance: Optional[Any] = None
    yardLine: Optional[Any] = None
    down: Optional[Any] = None
    yardsToEndzone: Optional[Any] = None
    homeScore: Optional[Any] = None
    awayScore: Optional[Any] = None
    pos_team_score: Optional[Any] = None
    def_pos_team_score: Optional[Any] = None
    pos_score_diff: Optional[Any] = None
    posTeamTimeouts: Optional[Any] = None
    defPosTeamTimeouts: Optional[Any] = None
    ExpScoreDiff: Optional[Any] = None
    ExpScoreDiff_Time_Ratio: Optional[Any] = None
    shortDownDistanceText: Optional[Any] = None
    possessionText: Optional[Any] = None
    downDistanceText: Optional[Any] = None
    pos_team: Optional[TeamRef] = None
    def_pos_team: Optional[TeamRef] = None
    team: Optional[dict] = None


class Play(BaseModel):
    """One play in the response.plays array.

    Only the reshape blocks are validated structurally — the rest of
    the play's ~370 columns from the pandas DataFrame are passed
    through under `extra='allow'`.
    """

    model_config = _ALLOW_EXTRA
    clock: Clock
    type: TypeBlock
    modelInputs: ModelInputs
    expectedPoints: ExpectedPoints
    winProbability: WinProbability
    start: StartSide
    end: EndSide


class ProcessResponse(BaseModel):
    """The /cfb/process response on success.

    Required: id, count, plays. Everything else is Optional because
    individual ESPN payloads can be missing fields (broadcasts, videos,
    standings) for unusual game states.

    `id` is echoed straight from the request body's `gameId` without
    coercion (app.py: `result["id"] = body.get("gameId")`), so the
    type matches whatever the caller sent. Worker callers send string
    (URL path segment from `/cfb/game/:gameId`), the integration test
    sends int. Both shapes are valid; the original `id: int`
    declaration was wrong and produced spurious
    `schema_validation_failure` events on every Worker request after
    the 3D cutover.
    """

    model_config = _ALLOW_EXTRA
    id: int | str
    count: int
    plays: list[Play]
    box_score: Any = None
    homeTeamId: Optional[str] = None
    awayTeamId: Optional[str] = None
    drives: Any = None
    scoringPlays: Optional[list] = None
    winprobability: Optional[list] = None
    boxScore: Any = None
    # ESPN sometimes serializes spread/total as a single float instead of
    # a list-of-bookmaker-prices. Accept either.
    homeTeamSpread: Any = None
    overUnder: Any = None
    header: Optional[dict] = None
    broadcasts: Optional[list] = None
    videos: Optional[list] = None
    standings: Any = None
    pickcenter: Optional[list] = None
    espnWinProbability: Optional[list] = None
    gameInfo: Any = None
    season: Any = None


def _dump_schema() -> str:
    """Return the JSON Schema for ProcessResponse, sorted + indented.

    Used by `python -m schemas` and the `make schema` target. Output
    is byte-stable so a CI step can `git diff --exit-code` against the
    committed copy at `shared/process-response.schema.json`.
    """
    schema = ProcessResponse.model_json_schema()
    return json.dumps(schema, indent=2, sort_keys=True) + "\n"


if __name__ == "__main__":
    sys.stdout.write(_dump_schema())
