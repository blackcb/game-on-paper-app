from flask import Flask, request, jsonify
from flask_compress import Compress
import numpy as np
from datetime import datetime as dt, timezone as tz
from flask_logs import LogSetup
from sportsdataverse.cfb.cfb_pbp import CFBPlayProcess
import os
import logging
import json
import time

from pydantic import ValidationError
from schemas import ProcessResponse

app = Flask(__name__)
app.config["LOG_TYPE"] = os.environ.get("LOG_TYPE", "stream")
app.config["LOG_LEVEL"] = os.environ.get("LOG_LEVEL", "INFO")
# Compress response bodies (Brotli, then gzip fallback). /cfb/process
# returns multi-MB JSON (3 MB raw on a typical game page) that
# compresses 5-10x. Cuts the python -> node hop's wire bytes
# proportionally and shaves real time off node's response render.
Compress(app)

logs = LogSetup()
logs.init_app(app)


@app.after_request
def after_request(response):
    logger = logging.getLogger("app.access")
    logger.info(
        "[python] %s [%s] %s %s %s",
        request.remote_addr,
        dt.now(tz=tz.utc).strftime("%d/%b/%Y:%H:%M:%S.%f")[:-3],
        request.method,
        request.path,
        response.status,
    )
    return response


def _validate_response_shape(result, gameId):
    """Validate `result` against ProcessResponse.

    Behavior is controlled by the STRICT_SCHEMA env var:
      - STRICT_SCHEMA=1 → re-raise ValidationError (used in tests so any
        drift fails fast).
      - default → log a structured warning with the first 10 errors and
        return; we still serve the response. The downstream Node side
        also validates via ajv as a defense-in-depth check.

    Returns nothing; effects are logging + (optionally) raising.
    """
    try:
        ProcessResponse.model_validate(result)
    except ValidationError as exc:
        if os.environ.get("STRICT_SCHEMA") == "1":
            raise
        # Best-effort logging — never let the validator path break a
        # 200 response. Limit to the first 10 errors to keep log lines
        # bounded for genuinely-mangled payloads.
        try:
            errors = exc.errors(include_url=False)[:10]
            logging.getLogger("app.metrics").warning(
                json.dumps(
                    {
                        "event": "schema_validation_failure",
                        "gameId": gameId,
                        "error_count": exc.error_count(),
                        "errors": errors,
                    },
                    default=str,
                )
            )
        except Exception:
            pass


def _emit_metrics(timings, gameId, status, error=None):
    # Logging must never break a response — swallow any failure (formatter,
    # handler, disk full, etc.) so we don't turn a successful 200 into a 500.
    try:
        line = {
            "event": "process",
            "gameId": gameId,
            "status": status,
            **{f"{k}_ms": int(v * 1000) for k, v in timings.items()},
        }
        if error is not None:
            line["error"] = error
        logging.getLogger("app.metrics").info(json.dumps(line))
    except Exception:
        pass


def _server_timing_header(timings):
    return ", ".join(f"{k};dur={int(v * 1000)}" for k, v in timings.items())


@app.route("/cfb/process", methods=["POST"])
def process():
    request_start = time.perf_counter()
    timings = {}
    gameId = None
    try:
        body = request.get_json(force=True) or {}
        gameId = body.get("gameId")
        if not gameId:
            timings["total"] = time.perf_counter() - request_start
            _emit_metrics(timings, gameId, 404, error="missing_gameId")
            response = jsonify({
                "status": "bad",
                "message": "ESPN payload is malformed. Data not available.",
            })
            response.headers["Server-Timing"] = _server_timing_header(timings)
            return response, 404

        t0 = time.perf_counter()
        processed_data = CFBPlayProcess(gameId=gameId)
        pbp = processed_data.espn_cfb_pbp()
        timings["espn_fetch"] = time.perf_counter() - t0

        # Validate ESPN's payload before trusting its shape downstream.
        # `header` is the canary — present on every healthy ESPN
        # response, missing when ESPN serves a stub or 404-equivalent
        # for an unknown / not-yet-scheduled gameId. Returning 404
        # here is the *only* legitimate "ESPN payload is malformed"
        # case; any KeyError raised later in the pipeline is a real
        # bug (a sportsdataverse column rename, a typo in our
        # reshape, etc.) and should surface as a 500 with traceback,
        # not be silently papered over as an ESPN issue.
        if not pbp.get("header"):
            timings["total"] = time.perf_counter() - request_start
            logging.getLogger("root").info(
                "ESPN returned no header for gameId=%s; returning 404", gameId
            )
            _emit_metrics(timings, gameId, 404, error="missing_header")
            response = jsonify({
                "status": "bad",
                "message": "ESPN payload is malformed. Data not available.",
            })
            response.headers["Server-Timing"] = _server_timing_header(timings)
            return response, 404

        t0 = time.perf_counter()
        processed_data.run_processing_pipeline()
        timings["pipeline"] = time.perf_counter() - t0

        t0 = time.perf_counter()
        tmp_json = processed_data.plays_json.to_json(orient="records")
        jsonified_df = json.loads(tmp_json)

        box = processed_data.create_box_score()
        timings["box_score"] = time.perf_counter() - t0

        t0 = time.perf_counter()
        # Flat sportsdataverse intermediate columns. The reshape loop
        # below re-nests their values into ESPN-shaped objects
        # (record["start"], record["end"], record["modelInputs"], etc.),
        # then we pop these from the record so the response matches the
        # pre-pipeline ESPN shape the frontend expects. Removing one
        # without removing its consumer in the loop will surface as a
        # KeyError; adding one without its source column ditto.
        bad_cols = [
            "start.distance",
            "start.yardLine",
            "start.team.id",
            "start.down",
            "start.yardsToEndzone",
            "start.posTeamTimeouts",
            "start.defTeamTimeouts",
            "start.shortDownDistanceText",
            "start.possessionText",
            "start.downDistanceText",
            "start.pos_team_timeouts",
            "start.def_pos_team_timeouts",
            "clock.displayValue",
            "type.id",
            "type.text",
            "type.abbreviation",
            "end.distance",
            "end.yardLine",
            "end.team.id",
            "end.down",
            "end.yardsToEndzone",
            "end.posTeamTimeouts",
            "end.defTeamTimeouts",
            "end.shortDownDistanceText",
            "end.possessionText",
            "end.downDistanceText",
            "end.pos_team_timeouts",
            "end.def_pos_team_timeouts",
            "expectedPoints.before",
            "expectedPoints.after",
            "expectedPoints.added",
            "winProbability.before",
            "winProbability.after",
            "winProbability.added",
            "scoringType.displayName",
            "scoringType.name",
            "scoringType.abbreviation",
        ]
        # Re-nest sportsdataverse's flat dot-keyed columns
        # (`start.distance`, `expectedPoints.before`, ...) back into
        # the nested objects the frontend's EJS templates expect
        # (`record["start"]["distance"]`, `record["expectedPoints"]["before"]`).
        # The Worker port must preserve this output shape exactly —
        # the snapshot tests in tests/test_process_snapshot.py compare
        # against fixtures captured from this loop. Fragile to
        # sportsdataverse column renames; if a key disappears here, the
        # snapshot test fails and you regenerate the fixture.
        for record in jsonified_df:
            record["clock"] = {
                "displayValue": record["clock.displayValue"],
                "minutes": record["clock.minutes"],
                "seconds": record["clock.seconds"],
            }

            record["type"] = {
                "id": record["type.id"],
                "text": record["type.text"],
                "abbreviation": record["type.abbreviation"],
            }
            record["modelInputs"] = {
                "start": {
                    "down": record["start.down"],
                    "distance": record["start.distance"],
                    "yardsToEndzone": record["start.yardsToEndzone"],
                    "TimeSecsRem": record["start.TimeSecsRem"],
                    "adj_TimeSecsRem": record["start.adj_TimeSecsRem"],
                    "pos_score_diff": record["pos_score_diff_start"],
                    "posTeamTimeouts": record["start.posTeamTimeouts"],
                    "defTeamTimeouts": record["start.defPosTeamTimeouts"],
                    "ExpScoreDiff": record["start.ExpScoreDiff"],
                    "ExpScoreDiff_Time_Ratio": record["start.ExpScoreDiff_Time_Ratio"],
                    "spread_time": record["start.spread_time"],
                    "pos_team_receives_2H_kickoff": record[
                        "start.pos_team_receives_2H_kickoff"
                    ],
                    "is_home": record["start.is_home"],
                    "period": record["period"],
                },
                "end": {
                    "down": record["end.down"],
                    "distance": record["end.distance"],
                    "yardsToEndzone": record["end.yardsToEndzone"],
                    "TimeSecsRem": record["end.TimeSecsRem"],
                    "adj_TimeSecsRem": record["end.adj_TimeSecsRem"],
                    "posTeamTimeouts": record["end.posTeamTimeouts"],
                    "defTeamTimeouts": record["end.defPosTeamTimeouts"],
                    "pos_score_diff": record["pos_score_diff_end"],
                    "ExpScoreDiff": record["end.ExpScoreDiff"],
                    "ExpScoreDiff_Time_Ratio": record["end.ExpScoreDiff_Time_Ratio"],
                    "spread_time": record["end.spread_time"],
                    "pos_team_receives_2H_kickoff": record[
                        "end.pos_team_receives_2H_kickoff"
                    ],
                    "is_home": record["end.is_home"],
                    "period": record["period"],
                },
            }

            record["expectedPoints"] = {
                "before": record["EP_start"],
                "after": record["EP_end"],
                "added": record["EPA"],
            }

            record["winProbability"] = {
                "before": record["wp_before"],
                "after": record["wp_after"],
                "added": record["wpa"],
            }

            record["start"] = {
                "team": {
                    "id": record["start.team.id"],
                },
                "pos_team": {
                    "id": record["start.pos_team.id"],
                    "name": record["start.pos_team.name"],
                },
                "def_pos_team": {
                    "id": record["start.def_pos_team.id"],
                    "name": record["start.def_pos_team.name"],
                },
                "distance": record["start.distance"],
                "yardLine": record["start.yardLine"],
                "down": record["start.down"],
                "yardsToEndzone": record["start.yardsToEndzone"],
                "homeScore": record["start.homeScore"],
                "awayScore": record["start.awayScore"],
                "pos_team_score": record["start.pos_team_score"],
                "def_pos_team_score": record["start.def_pos_team_score"],
                "pos_score_diff": record["pos_score_diff_start"],
                "posTeamTimeouts": record["start.posTeamTimeouts"],
                "defTeamTimeouts": record["start.defPosTeamTimeouts"],
                "ExpScoreDiff": record["start.ExpScoreDiff"],
                "ExpScoreDiff_Time_Ratio": record["start.ExpScoreDiff_Time_Ratio"],
                "shortDownDistanceText": record["start.shortDownDistanceText"],
                "possessionText": record["start.possessionText"],
                "downDistanceText": record["start.downDistanceText"],
                "posTeamSpread": record["start.pos_team_spread"],
            }

            record["end"] = {
                "team": {
                    "id": record["end.team.id"],
                },
                "pos_team": {
                    "id": record["end.pos_team.id"],
                    "name": record["end.pos_team.name"],
                },
                "def_pos_team": {
                    "id": record["end.def_pos_team.id"],
                    "name": record["end.def_pos_team.name"],
                },
                "distance": record["end.distance"],
                "yardLine": record["end.yardLine"],
                "down": record["end.down"],
                "yardsToEndzone": record["end.yardsToEndzone"],
                "homeScore": record["end.homeScore"],
                "awayScore": record["end.awayScore"],
                "pos_team_score": record["end.pos_team_score"],
                "def_pos_team_score": record["end.def_pos_team_score"],
                "pos_score_diff": record["pos_score_diff_end"],
                "posTeamTimeouts": record["end.posTeamTimeouts"],
                "defPosTeamTimeouts": record["end.defPosTeamTimeouts"],
                "ExpScoreDiff": record["end.ExpScoreDiff"],
                "ExpScoreDiff_Time_Ratio": record["end.ExpScoreDiff_Time_Ratio"],
                "shortDownDistanceText": record.get("end.shortDownDistanceText"),
                "possessionText": record.get("end.possessionText"),
                "downDistanceText": record.get("end.downDistanceText"),
            }

            # record["players"] = {
            #     'passer_player_name' : record["passer_player_name"],
            #     'rusher_player_name' : record["rusher_player_name"],
            #     'receiver_player_name' : record["receiver_player_name"],
            #     'sack_player_name' : record["sack_player_name"],
            #     'sack_player_name2' : record["sack_player_name2"],
            #     'pass_breakup_player_name' : record["pass_breakup_player_name"],
            #     'interception_player_name' : record["interception_player_name"],
            #     'fg_kicker_player_name' : record["fg_kicker_player_name"],
            #     'fg_block_player_name' : record["fg_block_player_name"],
            #     'fg_return_player_name' : record["fg_return_player_name"],
            #     'kickoff_player_name' : record["kickoff_player_name"],
            #     'kickoff_return_player_name' : record["kickoff_return_player_name"],
            #     'punter_player_name' : record["punter_player_name"],
            #     'punt_block_player_name' : record["punt_block_player_name"],
            #     'punt_return_player_name' : record["punt_return_player_name"],
            #     'punt_block_return_player_name' : record["punt_block_return_player_name"],
            #     'fumble_player_name' : record["fumble_player_name"],
            #     'fumble_forced_player_name' : record["fumble_forced_player_name"],
            #     'fumble_recovered_player_name' : record["fumble_recovered_player_name"],
            # }
            # remove added columns
            for col in bad_cols:
                record.pop(col, None)

        result = {
            "id": gameId,
            "count": len(jsonified_df),
            "plays": jsonified_df,
            "box_score": box,
            "homeTeamId": pbp["header"]["competitions"][0]["competitors"][0]["team"][
                "id"
            ],
            "awayTeamId": pbp["header"]["competitions"][0]["competitors"][1]["team"][
                "id"
            ],
            "drives": pbp["drives"],
            "scoringPlays": np.array(pbp["scoringPlays"]).tolist(),
            "winprobability": np.array(pbp["winprobability"]).tolist(),
            "boxScore": pbp["boxscore"],
            "homeTeamSpread": np.array(pbp["homeTeamSpread"]).tolist(),
            "overUnder": np.array(pbp["overUnder"]).tolist(),
            "header": pbp["header"],
            "broadcasts": np.array(pbp["broadcasts"]).tolist(),
            "videos": np.array(pbp["videos"]).tolist(),
            "standings": pbp["standings"],
            "pickcenter": np.array(pbp["pickcenter"]).tolist(),
            "espnWinProbability": np.array(pbp["espnWP"]).tolist(),
            "gameInfo": np.array(pbp["gameInfo"]).tolist(),
            "season": np.array(pbp["season"]).tolist(),
        }
        # Validate the response shape against the published contract.
        # Default behavior is warn-only so we don't turn 200s into 500s
        # on novel ESPN data; STRICT_SCHEMA=1 (tests, CI) raises.
        _validate_response_shape(result, gameId)
        response = jsonify(result)
        # The bulk of this stage is the per-record reshape loop; the result
        # dict assembly and jsonify are sub-millisecond.
        timings["reshape"] = time.perf_counter() - t0
        timings["total"] = time.perf_counter() - request_start
        response.headers["Server-Timing"] = _server_timing_header(timings)
        _emit_metrics(timings, gameId, 200)
        return response, 200
    except Exception as e:
        timings["total"] = time.perf_counter() - request_start
        logging.getLogger("root").error(
            "Error while processing PBP on Python side, threw 500: %r (%s)" % (e, e)
        )
        import traceback

        traceback.print_tb(e.__traceback__)
        _emit_metrics(timings, gameId, 500, error=repr(e))
        response = jsonify(
            {"status": "bad", "message": "Unknown error occurred, check logs."}
        )
        response.headers["Server-Timing"] = _server_timing_header(timings)
        return response, 500


@app.route("/healthcheck", methods=["GET"])
def healthcheck():
    return jsonify({"status": "ok"})


if __name__ == "__main__":
    app.run(port=7000, debug=False, host="0.0.0.0")
