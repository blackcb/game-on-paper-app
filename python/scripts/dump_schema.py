#!/usr/bin/env python3
"""Regenerate the JSON Schema artifacts.

Writes the same schema to two locations because each consumer lives
in a different filesystem scope:
  - shared/process-response.schema.json       — canonical, repo root
  - frontend/cfb/process-response.schema.json — inside the frontend Docker
                                                build context, so the
                                                runtime ajv load can
                                                require() it from games.js

Run via:
    cd python && python scripts/dump_schema.py
or via the make-style alias in the python README.

CI verifies the two files match each other AND match `python -m schemas`,
so any drift between schema source and committed copies fails fast.
"""

from __future__ import annotations

import sys
from pathlib import Path

# Make `schemas` importable when invoked from the python/ dir.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from schemas import _dump_schema  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[2]
TARGETS = [
    REPO_ROOT / "shared" / "process-response.schema.json",
    REPO_ROOT / "frontend" / "cfb" / "process-response.schema.json",
]


def main() -> int:
    payload = _dump_schema()
    for path in TARGETS:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(payload, encoding="utf-8")
        print(f"wrote {path.relative_to(REPO_ROOT)} ({len(payload)} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
