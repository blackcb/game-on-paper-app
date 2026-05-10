"""Unit tests for synthetic-in-progress replay slicing.

Exercises replay.truncate_replay against captured fixtures. No Flask, no
sportsdataverse — these tests run in the same `pytest` invocation as the
snapshot tests but don't require the full /cfb/process dependency stack.
"""
import os
import pytest

from replay import load_replay_fixture, truncate_replay


FIXTURE_DIR = os.path.join(os.path.dirname(__file__), "fixtures")
GAME_ID = "401520434"


@pytest.fixture(scope="module")
def fixture():
    cache = {}
    data = load_replay_fixture(FIXTURE_DIR, GAME_ID, cache)
    assert data is not None, f"no fixture at {FIXTURE_DIR}/{GAME_ID}"
    return data


def test_load_returns_none_for_missing(tmp_path):
    assert load_replay_fixture(str(tmp_path), "999999") is None


def test_truncate_zero_elapsed_yields_one_play(fixture):
    truncated, idx = truncate_replay(fixture, elapsed_s=0, duration_s=600)
    # Floor((0/600) * N) = 0, but we clamp to 1 so the response has at
    # least one play — pre-kickoff is the Worker's pregame branch, not
    # this endpoint's responsibility. A 0-play STATUS_IN_PROGRESS body
    # would render an empty game page, which is a worse signal than
    # "first play of game" to a viewer simulator.
    assert idx == 1
    assert len(truncated["plays"]) == 1
    assert truncated["count"] == 1


def test_truncate_full_duration_returns_completed(fixture):
    truncated, idx = truncate_replay(fixture, elapsed_s=601, duration_s=600)
    assert idx == len(fixture["plays"])
    # When elapsed >= duration the fixture passes through unchanged, so
    # the original STATUS_FINAL completed=True survives. Worker routes
    # this through the completed-game Cache-Control branch (max-age=86400).
    # The Worker derives its gameInfo from header.competitions[0] (see
    # games.ts:157), so that's the load-bearing status field. The
    # serialized `gameInfo` block in the fixture is just venue/attendance.
    final_status = truncated["header"]["competitions"][0]["status"]
    assert final_status["type"]["completed"] is True


def test_truncate_midgame_marks_in_progress(fixture):
    n = len(fixture["plays"])
    # Halfway through: roughly N/2 plays, status flipped to in-progress.
    truncated, idx = truncate_replay(fixture, elapsed_s=300, duration_s=600)
    assert idx == n // 2 or idx == (n // 2) + 1  # int() truncation tolerance
    # The Worker's branch logic (lib/games.ts:157 + index.tsx) reads
    # gameInfo.status from header.competitions[0] post-fetch. This is
    # the status field truncate_replay must patch for the Worker to
    # route the response through its in-progress Cache-Control branch.
    header_status = truncated["header"]["competitions"][0]["status"]
    assert header_status["type"]["completed"] is False
    assert header_status["type"]["name"] == "STATUS_IN_PROGRESS"


def test_score_reflects_last_visible_play(fixture):
    # Past the first scoring play but well before the end.
    truncated, idx = truncate_replay(fixture, elapsed_s=300, duration_s=600)
    last = truncated["plays"][-1]
    competitors = truncated["header"]["competitions"][0]["competitors"]
    by_side = {c["homeAway"]: c for c in competitors}
    if "home" in by_side and last.get("homeScore") is not None:
        assert by_side["home"]["score"] == str(last["homeScore"])
    if "away" in by_side and last.get("awayScore") is not None:
        assert by_side["away"]["score"] == str(last["awayScore"])


def test_truncate_does_not_mutate_input(fixture):
    original_plays_len = len(fixture["plays"])
    original_status = fixture["header"]["competitions"][0]["status"]["type"]["completed"]
    truncate_replay(fixture, elapsed_s=120, duration_s=600)
    # Caller's fixture must survive intact for re-use across requests
    # — the Flask handler caches it in process memory.
    assert len(fixture["plays"]) == original_plays_len
    new_status = fixture["header"]["competitions"][0]["status"]["type"]["completed"]
    assert new_status == original_status


def test_truncate_progresses_monotonically(fixture):
    # Body-hash divergence is the signal the harness uses to detect
    # cache-coherence problems. To make that signal real, every
    # increment of elapsed_s past a play boundary must produce a
    # strictly-larger plays array.
    n = len(fixture["plays"])
    sizes = []
    for elapsed in (10, 60, 120, 300, 480, 599):
        truncated, _ = truncate_replay(fixture, elapsed_s=elapsed, duration_s=600)
        sizes.append(len(truncated["plays"]))
    assert sizes == sorted(sizes)
    assert sizes[0] >= 1
    assert sizes[-1] <= n
