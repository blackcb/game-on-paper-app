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


def _warmup_models():
    """Touch the heavy import + model-load machinery at app-import time
    so the gunicorn master populates them once and forked workers
    inherit via copy-on-write. Pairs with `--preload` in the
    Dockerfile CMD; without `--preload` each worker repeats this work.

    Idempotent + network-free: probes module-level XGBoost booster
    globals on `sportsdataverse.cfb.cfb_pbp` if they exist (different
    versions name them differently), but does not contact ESPN. Safe
    to call from `/warmup` after startup as well.
    """
    try:
        import xgboost  # noqa: F401
        import pandas  # noqa: F401
        import sportsdataverse.cfb.cfb_pbp as _cfb_pbp
        # Probe likely module-level booster names. `getattr` with a
        # default just touches the attribute; if `cfb_pbp` lazily
        # builds a property on first access, this triggers it.
        for attr in (
            "ep_model", "wp_model", "qbr_model",
            "_ep_model", "_wp_model", "_qbr_model",
            "ep_final_model", "wp_final_model",
        ):
            getattr(_cfb_pbp, attr, None)
        logging.getLogger("root").info(json.dumps({"event": "warmup_ok"}))
    except Exception as exc:
        # Never let warmup failure prevent the app from booting; the
        # first real /cfb/process call will surface any genuine
        # failure with a full traceback.
        logging.getLogger("root").warning(
            json.dumps({"event": "warmup_failed", "error": repr(exc)}),
        )


_warmup_models()


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


from replay import load_replay_fixture, truncate_replay  # noqa: E402

_REPLAY_FIXTURE_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "tests", "fixtures"
)
_REPLAY_FIXTURE_CACHE: dict = {}


@app.route("/cfb/process/replay", methods=["GET", "POST"])
def process_replay():
    """Synthetic in-progress endpoint for load-test harness use.

    Query params (or POST JSON body — both accepted so the same handler
    serves Architecture A's service-binding POST and Architecture B's
    fetch+cf GET):
      - gameId: which captured fixture to replay (must exist in
        python/tests/fixtures/<gameId>/expected.json)
      - replay_started_at: unix-seconds timestamp the synthetic game
        started. Required.
      - replay_duration: seconds of wallclock for the full game (default
        1800 = 30 min, matches the harness run length).

    The response is shape-compatible with /cfb/process. No ESPN calls,
    no XGBoost, no pandas pipeline — synthetic replay reads a cached
    fixture, slices the plays array, and patches status. Sub-millisecond
    on the warm path, so it isolates cache/network behavior from
    Python-compute behavior in load tests.

    NOT for production traffic. Bound by the same shared-secret check
    as /cfb/process when fronted by Caddy on the droplet.
    """
    request_start = time.perf_counter()
    timings = {}
    if request.method == "POST":
        body = request.get_json(force=True, silent=True) or {}
    else:
        body = {}

    def _param(name, default=None):
        if name in request.args:
            return request.args.get(name)
        return body.get(name, default)

    gameId = _param("gameId")
    started_at_raw = _param("replay_started_at")
    duration_raw = _param("replay_duration", 1800)

    if not gameId or started_at_raw is None:
        return jsonify({"status": "bad", "message": "gameId and replay_started_at required"}), 400
    try:
        started_at = float(started_at_raw)
        duration_s = float(duration_raw)
    except (TypeError, ValueError):
        return jsonify({"status": "bad", "message": "replay_started_at and replay_duration must be numeric"}), 400

    fixture = load_replay_fixture(_REPLAY_FIXTURE_DIR, gameId, _REPLAY_FIXTURE_CACHE)
    if fixture is None:
        return jsonify({
            "status": "bad",
            "message": f"no replay fixture for gameId={gameId}",
        }), 404

    elapsed_s = time.time() - started_at
    t0 = time.perf_counter()
    truncated, play_index = truncate_replay(fixture, elapsed_s, duration_s)
    timings["replay_truncate"] = time.perf_counter() - t0
    timings["total"] = time.perf_counter() - request_start

    response = jsonify(truncated)
    response.headers["Server-Timing"] = _server_timing_header(timings)
    response.headers["X-Replay-Play-Index"] = str(play_index)
    response.headers["X-Replay-Elapsed-S"] = f"{elapsed_s:.1f}"
    _emit_metrics(timings, gameId, 200)
    return response, 200


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


@app.route("/warmup", methods=["GET"])
def warmup():
    """Heavier healthcheck: re-runs `_warmup_models()` so a cron-warm
    ping from the Worker (Layer B in worker/src/lib/cron.ts) exercises
    the XGBoost-load codepath, not just Flask's reply path. With
    `--preload` the master already did this once at boot, so this is
    a no-op the second time — but a fully-stopped container resumed
    by a cron ping comes back through this route, and we want the
    boosters in memory before the first real /cfb/process call lands.
    """
    _warmup_models()
    return jsonify({"status": "ok", "warm": True})


if __name__ == "__main__":
    app.run(port=7000, debug=False, host="0.0.0.0")
