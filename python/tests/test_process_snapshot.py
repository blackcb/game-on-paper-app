"""Snapshot tests for /cfb/process.

For each captured fixture, the test mocks every ESPN URL the pipeline
touches and asserts the resulting /cfb/process response matches the
recorded `expected.json` byte-for-byte. Catches sportsdataverse upgrades
that rename columns, change rounding, or alter the response shape.

If a snapshot mismatches, the actual response is written to
`expected.actual.json` next to `expected.json` so a diff is one
`diff -u` away. To regenerate: re-run `python tests/capture_fixtures.py`.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures"

# gameIds whose fixtures have been captured with capture_fixtures.py.
# Add more when you capture more.
SNAPSHOT_GAME_IDS = [
    401403910,  # completed regular-season game (existing test fixture)
    401520434,  # OT game — overtime period handling
    401628329,  # 2024 game from the upstream QUARANTINE_LIST
]


@pytest.mark.parametrize("mock_espn", SNAPSHOT_GAME_IDS, indirect=True)
def test_process_matches_snapshot(mock_espn, client):
    game_id = mock_espn
    fixtures_dir = FIXTURES_DIR / str(game_id)
    expected = json.loads(
        (fixtures_dir / "expected.json").read_text(encoding="utf-8")
    )

    response = client.post("/cfb/process", json={"gameId": game_id})
    assert response.status_code == 200, response.get_data(as_text=True)
    actual = response.get_json()

    if actual != expected:
        # Persist the diverging output so a developer can `diff -u
        # expected.json expected.actual.json` to see exactly what moved.
        actual_path = fixtures_dir / "expected.actual.json"
        actual_path.write_text(
            json.dumps(actual, indent=2, sort_keys=True), encoding="utf-8"
        )
        pytest.fail(
            f"/cfb/process response for game {game_id} no longer matches "
            f"snapshot. Actual saved to {actual_path}; diff with "
            f"{fixtures_dir / 'expected.json'} to see what changed. "
            f"If the new output is correct, regenerate with "
            f"`python tests/capture_fixtures.py {game_id}`."
        )
