"""Synthetic in-progress replay support for /cfb/process/replay.

Pure-python: no Flask, no numpy, no sportsdataverse. Lets the replay
slicing be unit-tested in environments where the full /cfb/process
dependency chain (xgboost, pandas) doesn't have wheels (e.g. macOS
with Python 3.14 at the time of writing).

The Flask handler in app.py is a thin wiring layer over these
functions.
"""
import json
import os


def _fixture_path(fixture_dir, gameId):
    return os.path.join(fixture_dir, str(gameId), "expected.json")


def load_replay_fixture(fixture_dir, gameId, _cache=None):
    if _cache is not None and gameId in _cache:
        return _cache[gameId]
    path = _fixture_path(fixture_dir, gameId)
    if not os.path.isfile(path):
        return None
    with open(path) as fh:
        data = json.load(fh)
    if _cache is not None:
        _cache[gameId] = data
    return data


# Status block stamped onto the truncated response. Routes the Worker's
# /cfb/game/:id handler through the in-progress Cache-Control branch
# (max-age=30, s-maxage=30, swr=60) — the load-test target.
_IN_PROGRESS_STATUS = {
    "type": {
        "completed": False,
        "description": "In Progress",
        "detail": "In Progress",
        "id": "2",
        "name": "STATUS_IN_PROGRESS",
        "shortDetail": "In Progress",
        "state": "in",
    }
}


def truncate_replay(fixture, elapsed_s, duration_s):
    """Return (truncated_fixture, play_index_visible).

    `play_index_visible` is the count of plays included in the truncated
    response. Mapping is linear in plays vs wallclock — when
    elapsed_s >= duration_s, the original fixture passes through
    unchanged (status remains STATUS_FINAL/completed=True). When
    0 < elapsed_s < duration_s, plays are sliced to floor((e/d) * N)
    and the status is patched to STATUS_IN_PROGRESS so the Worker hits
    its in-progress Cache-Control branch.
    """
    plays = fixture.get("plays", [])
    total_plays = len(plays)
    if total_plays == 0:
        return fixture, 0
    if elapsed_s >= duration_s:
        return fixture, total_plays
    if elapsed_s <= 0:
        elapsed_s = 0
    play_index = int((elapsed_s / duration_s) * total_plays)
    play_index = max(1, min(play_index, total_plays))

    visible_plays = plays[:play_index]
    last_play = visible_plays[-1] if visible_plays else None

    truncated = dict(fixture)
    truncated["plays"] = visible_plays
    truncated["count"] = len(visible_plays)
    if last_play is not None:
        last_id = int(last_play.get("id", 0) or 0)
        truncated["scoringPlays"] = [
            p for p in fixture.get("scoringPlays", [])
            if int(p.get("id", 0) or 0) <= last_id
        ]
    else:
        truncated["scoringPlays"] = []

    if "header" in truncated and truncated["header"].get("competitions"):
        comp = dict(truncated["header"]["competitions"][0])
        comp["status"] = _IN_PROGRESS_STATUS
        if last_play is not None and comp.get("competitors"):
            home_score = last_play.get("homeScore")
            away_score = last_play.get("awayScore")
            new_competitors = []
            for c in comp["competitors"]:
                cc = dict(c)
                if cc.get("homeAway") == "home" and home_score is not None:
                    cc["score"] = str(home_score)
                elif cc.get("homeAway") == "away" and away_score is not None:
                    cc["score"] = str(away_score)
                new_competitors.append(cc)
            comp["competitors"] = new_competitors
        truncated["header"] = dict(truncated["header"])
        truncated["header"]["competitions"] = [comp]

    if "gameInfo" in truncated and isinstance(truncated["gameInfo"], dict):
        gi = dict(truncated["gameInfo"])
        gi["status"] = _IN_PROGRESS_STATUS
        truncated["gameInfo"] = gi

    return truncated, play_index
