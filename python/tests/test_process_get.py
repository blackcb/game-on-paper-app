"""Tests for the GET variant of /cfb/process.

Added 2026-05-10 alongside the Architecture B tiered-cache migration.
The Worker's tiered fetch path uses GET so Cloudflare's standard
cache + tiered cache keys on URL (not body), and gameId becomes
part of the cache key naturally.

The full processing pipeline is exercised by the existing snapshot
tests in tests/test_process_snapshot.py — those pass POST. These
tests cover only the request-parsing distinction between GET and
POST plus the malformed-input error path.
"""
import json
import pytest

# These tests only run in environments where Flask + sportsdataverse
# are available — the same environment the existing snapshot tests
# require. Skip if not (Mac dev with Python 3.14 + xgboost-cpu wheel
# unavailable).
pytest.importorskip("flask")
pytest.importorskip("sportsdataverse")


def _client():
    from app import app
    app.config.update(TESTING=True)
    return app.test_client()


def test_get_with_no_gameid_returns_404():
    client = _client()
    res = client.get("/cfb/process")
    assert res.status_code == 404
    body = res.get_json()
    assert body["status"] == "bad"


def test_post_with_no_gameid_still_returns_404():
    # Backwards compatibility — POST behavior unchanged.
    client = _client()
    res = client.post("/cfb/process", json={})
    assert res.status_code == 404
    body = res.get_json()
    assert body["status"] == "bad"


def test_get_reads_gameid_from_query_string(monkeypatch):
    """Confirm GET path reaches the pipeline with the right gameId.

    Mock CFBPlayProcess so the test doesn't actually fetch ESPN —
    we just need to verify the gameId extracted from the query
    string lands in the constructor.
    """
    from app import app

    captured = {}
    real_pp = None
    try:
        from sportsdataverse.cfb import cfb_pbp
        real_pp = cfb_pbp.CFBPlayProcess
    except Exception:
        pytest.skip("sportsdataverse not importable in this env")

    class FakePP:
        def __init__(self, gameId):
            captured["gameId"] = gameId

        def espn_cfb_pbp(self):
            # Returning a missing-header dict triggers the 404 branch
            # short of the heavy pipeline. We're not testing the
            # pipeline here — only the request-parsing.
            return {}

    monkeypatch.setattr(
        "app.CFBPlayProcess", FakePP,
    )

    app.config.update(TESTING=True)
    client = app.test_client()
    res = client.get("/cfb/process?gameId=401520434")
    assert captured.get("gameId") == "401520434"
    # The fake pipeline returns no header → ESPN-malformed 404
    # branch in app.py. That's expected; the assertion that matters
    # is the captured gameId.
    assert res.status_code == 404
