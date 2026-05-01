"""Snapshot tests for /cfb/process.

For each captured fixture, the test mocks every ESPN URL the pipeline
touches and asserts the resulting /cfb/process response matches the
recorded `expected.json`. Catches sportsdataverse upgrades that rename
columns, change rounding, or alter the response shape.

Float comparison uses a small absolute tolerance (1e-5) to absorb
architecture-level noise: xgboost reorders sums of tree leaf values
differently across SIMD instruction sets, so Apple Silicon and Linux
x86_64 produce ~1e-7 differences in the same model output. Real
drift (version bump, retraining, column rename) is O(1e-3) or larger
and still fails the comparison.

If a snapshot mismatches, the actual response is written to
`expected.actual.json` next to `expected.json` and the first few diffs
are printed so a developer can `diff -u` for the full picture. To
regenerate: re-run `python tests/capture_fixtures.py`.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any, Iterator

import pytest

FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures"

# gameIds whose fixtures have been captured with capture_fixtures.py.
# Add more when you capture more.
SNAPSHOT_GAME_IDS = [
    401403910,  # completed regular-season game (existing test fixture)
    401520434,  # OT game — overtime period handling
    401628329,  # 2024 game from the upstream QUARANTINE_LIST
]

# Tolerance for cross-architecture float comparison. xgboost's tree sums
# reorder under different SIMD ISAs (Apple Silicon vs Linux x86_64) and
# produce ~1e-7 differences in identical model inputs. Anything bigger
# than this threshold is real drift, not noise.
_FLOAT_ABS_TOL = 1e-5
_FLOAT_REL_TOL = 1e-6


def _canonical_key(item: Any) -> str:
    """Stable sortable key for ordering list-of-dict elements.

    Used so list-of-dict comparisons are order-independent: pandas
    groupby + tie-break ordering varies across platforms (Mac vs Linux,
    libc differences) and produces the same set of records in different
    orders. We care about the records' contents, not their position.
    """
    return json.dumps(item, sort_keys=True, default=str)


def _diffs(a: Any, b: Any, path: str = "") -> Iterator[str]:
    """Yield human-readable diff descriptions between two JSON-shaped values."""
    # Match floats with tolerance. NaN-equal-NaN to avoid spurious diffs on
    # missing-data rows that pandas serializes as NaN.
    if isinstance(a, float) and isinstance(b, float):
        if math.isnan(a) and math.isnan(b):
            return
        if not math.isclose(a, b, rel_tol=_FLOAT_REL_TOL, abs_tol=_FLOAT_ABS_TOL):
            yield f"{path}: float {a!r} != {b!r} (delta={abs(a - b):.3g})"
        return
    if type(a) is not type(b):
        yield f"{path}: type {type(a).__name__} != {type(b).__name__}"
        return
    if isinstance(a, dict):
        all_keys = set(a) | set(b)
        for key in sorted(all_keys, key=str):
            if key not in a:
                yield f"{path}.{key}: missing in expected"
            elif key not in b:
                yield f"{path}.{key}: missing in actual"
            else:
                yield from _diffs(a[key], b[key], f"{path}.{key}")
        return
    if isinstance(a, list):
        if len(a) != len(b):
            yield f"{path}: list length {len(a)} != {len(b)}"
            return
        # When comparing a list of dicts, sort both by canonical JSON
        # so platform-dependent groupby orderings (e.g. pandas tie-break
        # on Mac vs Linux) don't surface as fake diffs. Lists of scalars
        # keep their original order — list[float] order is meaningful in
        # this codebase (winprobability time series, scoringPlays).
        if a and all(isinstance(x, dict) for x in a) and all(isinstance(x, dict) for x in b):
            a_sorted = sorted(a, key=_canonical_key)
            b_sorted = sorted(b, key=_canonical_key)
            for i, (x, y) in enumerate(zip(a_sorted, b_sorted)):
                yield from _diffs(x, y, f"{path}[{i}]")
        else:
            for i, (x, y) in enumerate(zip(a, b)):
                yield from _diffs(x, y, f"{path}[{i}]")
        return
    if a != b:
        yield f"{path}: {a!r} != {b!r}"


@pytest.mark.parametrize("game_id", SNAPSHOT_GAME_IDS)
def test_fixture_validates_against_schema(game_id):
    """Each committed expected.json must validate against the published schema.

    Catches the case where someone hand-edits a fixture but forgets to
    regenerate the schema, or vice versa. A failure here means the
    schema and the fixture have drifted and one of them needs updating.
    """
    from schemas import ProcessResponse

    fixtures_dir = FIXTURES_DIR / str(game_id)
    expected = json.loads(
        (fixtures_dir / "expected.json").read_text(encoding="utf-8")
    )
    # If validation fails, ValidationError surfaces a precise diff.
    ProcessResponse.model_validate(expected)


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

    diffs = list(_diffs(expected, actual))
    if diffs:
        # Persist the diverging output so a developer can `diff -u
        # expected.json expected.actual.json` to see exactly what moved.
        actual_path = fixtures_dir / "expected.actual.json"
        actual_path.write_text(
            json.dumps(actual, indent=2, sort_keys=True), encoding="utf-8"
        )
        # Show up to the first 20 diffs so failures are immediately
        # actionable without requiring developers to open the diff file.
        preview = "\n  ".join(diffs[:20])
        more = (
            f"\n  ...and {len(diffs) - 20} more"
            if len(diffs) > 20
            else ""
        )
        pytest.fail(
            f"/cfb/process response for game {game_id} no longer matches "
            f"snapshot ({len(diffs)} differences):\n  {preview}{more}\n\n"
            f"Actual saved to {actual_path}; diff with "
            f"{fixtures_dir / 'expected.json'} for the full picture. "
            f"If the new output is correct, regenerate with "
            f"`python tests/capture_fixtures.py {game_id}`."
        )
