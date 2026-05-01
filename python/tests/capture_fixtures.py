"""Capture ESPN fixtures for snapshot tests.

Wraps sportsdataverse.dl_utils.download with a recorder that saves every
URL → response pair it sees while running the full /cfb/process pipeline.
The captured fixtures plus the resulting `expected.json` are what
test_process_snapshot.py replays against without touching the network.

Usage:
    cd python && source .venv/bin/activate
    python tests/capture_fixtures.py 401403910 [401520434 ...]

For each gameId, this writes:
    tests/fixtures/<gameId>/manifest.json     # url -> filename map
    tests/fixtures/<gameId>/<filename>.json   # one per captured URL
    tests/fixtures/<gameId>/expected.json     # the /cfb/process response
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

# Make `app` importable from the parent dir, same trick as conftest.py.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import sportsdataverse.dl_utils  # noqa: E402

FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures"


def normalize_url(url: str) -> str:
    """Return a stable identifier for a URL across runs.

    Strips sportsdataverse / frontend cache-buster query params (a bare
    numeric `&1777599119301` appears as a key with empty value when parsed)
    and sorts the remaining params so {scheme}://{host}{path}?{qs} is
    deterministic.
    """
    parsed = urlparse(url)
    params = parse_qsl(parsed.query, keep_blank_values=True)
    # Drop the cache-buster: a key that's entirely digits with an empty value.
    params = [(k, v) for k, v in params if not (v == "" and k.isdigit())]
    params.sort()
    return urlunparse(
        parsed._replace(query=urlencode(params), fragment="")
    )


def url_to_filename(url: str) -> str:
    """Stable, recognizable filename for a captured URL.

    Strategy: strip query string for a hint, append a short hash so distinct
    URLs that share a path don't collide.
    """
    normalized = normalize_url(url)
    # Strip schema + host for readability.
    path = normalized.split("://", 1)[-1]
    path = path.split("?", 1)[0]
    # Replace path separators with dashes.
    safe = path.replace("/", "_").replace(":", "_")
    digest = hashlib.sha1(normalized.encode("utf-8")).hexdigest()[:8]
    return f"{safe}__{digest}.json"


def capture(game_id: int) -> None:
    out_dir = FIXTURES_DIR / str(game_id)
    out_dir.mkdir(parents=True, exist_ok=True)

    captured: dict[str, str] = {}  # normalized_url -> response text
    original_download = sportsdataverse.dl_utils.download

    def recording_download(url, params=None, num_retries=15):
        # `params` is documented as default {} but treat None defensively.
        if params is None:
            params = {}
        body = original_download(url, params=params, num_retries=num_retries)
        # Normalize bytes -> str so json.loads works downstream.
        if isinstance(body, (bytes, bytearray)):
            body = body.decode("utf-8")
        captured[normalize_url(url)] = body
        return body

    sportsdataverse.dl_utils.download = recording_download
    # cfb_pbp imports `download` as a module-level symbol so monkeypatching
    # the dl_utils namespace alone isn't enough — also patch the imported ref.
    import sportsdataverse.cfb.cfb_pbp as cfb_mod
    cfb_mod.download = recording_download
    try:
        # Run the pipeline through the same code path /cfb/process uses.
        # Importing app here (inside the patched scope) makes sure `process()`
        # sees the recording version of download.
        from app import app as flask_app

        client = flask_app.test_client()
        response = client.post("/cfb/process", json={"gameId": int(game_id)})
        if response.status_code != 200:
            raise RuntimeError(
                f"/cfb/process failed for {game_id}: "
                f"{response.status_code} {response.get_data(as_text=True)[:500]}"
            )
        expected = response.get_json()
    finally:
        sportsdataverse.dl_utils.download = original_download
        cfb_mod.download = original_download

    # Write each captured URL into its own file, with a manifest mapping
    # normalized_url -> filename so the test fixture can dispatch.
    manifest: dict[str, str] = {}
    for normalized, body in captured.items():
        filename = url_to_filename(normalized)
        (out_dir / filename).write_text(body, encoding="utf-8")
        manifest[normalized] = filename

    (out_dir / "manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8"
    )
    (out_dir / "expected.json").write_text(
        json.dumps(expected, indent=2, sort_keys=True), encoding="utf-8"
    )

    print(
        f"[{game_id}] captured {len(captured)} URLs, "
        f"expected.json has {len(expected.get('plays', []))} plays"
    )
    for url in sorted(captured):
        print(f"  {url}")


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    for arg in sys.argv[1:]:
        capture(int(arg))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
