import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import app as flask_app

from tests.capture_fixtures import normalize_url

FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures"


@pytest.fixture
def app():
    flask_app.config.update(TESTING=True)
    return flask_app


@pytest.fixture
def client(app):
    return app.test_client()


@pytest.fixture
def mock_espn(monkeypatch, request):
    """Replay captured ESPN responses for the indirectly-parametrized gameId.

    Usage:
        @pytest.mark.parametrize("mock_espn", [401403910], indirect=True)
        def test_x(mock_espn, client):
            ...

    The fixture loads `tests/fixtures/<gameId>/manifest.json` and patches
    `sportsdataverse.dl_utils.download` (and the imported reference inside
    `cfb_pbp`) to dispatch each requested URL to its captured body. Any URL
    that wasn't captured raises so the test fails loudly instead of going
    to the network.
    """
    game_id = request.param
    fixtures_dir = FIXTURES_DIR / str(game_id)
    manifest_path = fixtures_dir / "manifest.json"
    if not manifest_path.exists():
        pytest.skip(f"no fixtures captured for game {game_id}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    bodies = {
        url: (fixtures_dir / filename).read_text(encoding="utf-8")
        for url, filename in manifest.items()
    }

    def fake_download(url, params=None, num_retries=15):
        key = normalize_url(url)
        if key not in bodies:
            raise AssertionError(
                f"unmocked ESPN URL during {game_id} snapshot test: {url}\n"
                f"normalized to: {key}\n"
                f"available keys: {list(bodies.keys())}"
            )
        return bodies[key]

    import sportsdataverse.dl_utils
    import sportsdataverse.cfb.cfb_pbp as cfb_mod

    monkeypatch.setattr(sportsdataverse.dl_utils, "download", fake_download)
    monkeypatch.setattr(cfb_mod, "download", fake_download)
    return game_id
