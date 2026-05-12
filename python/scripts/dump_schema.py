#!/usr/bin/env python3
"""Regenerate the JSON Schema artifact.

Writes the canonical schema to shared/process-response.schema.json.
The Worker imports it from there via a TypeScript JSON import.

Run via:
    cd python && python scripts/dump_schema.py

CI verifies the committed copy matches `python -m schemas`, so any
drift between schema source and committed copy fails fast.
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
]


def main() -> int:
    payload = _dump_schema()
    for path in TARGETS:
        if not path.parent.exists():
            print(f"::error::target dir missing: {path.parent}", file=sys.stderr)
            return 1
        path.write_text(payload, encoding="utf-8")
        print(f"wrote {path.relative_to(REPO_ROOT)} ({len(payload)} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
