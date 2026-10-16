#!/usr/bin/env python3
"""Generate `server/data/openings_eco.json` from the lichess chess-openings data set.

Why this script exists
----------------------
`/explain` reports the opening of the game (`opening: {eco, name} | null`). The
name table is bundled as a plain JSON file — **no runtime dependency, no
network** — so this generator documents exactly how it was produced and makes
regeneration deterministic (same input files -> same output file).

Source (verified 2026-10-17)
----------------------------
* Repository: https://github.com/lichess-org/chess-openings
* Files: `a.tsv` … `e.tsv` (one per ECO volume; columns: eco, name, pgn)
* License: **CC0-1.0** (public domain dedication) — see `server/data/README.md`.
  The upstream README states: "As a collection of facts, this data set is in
  the public domain. Considerable effort was spent curating and cleaning the
  data. Insofar as that qualifies for copyright, the work is released under the
  CC0 Public Domain Dedication."

Output format
-------------
    {
      "version": 1,
      "source": "lichess-org/chess-openings a.tsv..e.tsv",
      "license": "CC0-1.0",
      "count": <int>,
      "openings": { "<san san san>": ["<eco>", "<name>"], ... }
    }

The key is the SAN move sequence of the opening's *shortest line* (both the
dataset's SAN and the key are normalized: trailing "+"/"#" stripped — opening
names never depend on a check marker). `explain_engine.opening_for_history()`
matches the **longest prefix** of the game's SAN sequence against these keys
(the lichess-recommended classification, restricted to move-sequence prefixes:
transpositions reached by a different move order than the dataset line are not
recognized — documented in docs/PROJECT.md).

Usage
-----
    server/.venv/bin/python server/tools/generate_openings.py            # downloads the TSVs
    server/.venv/bin/python server/tools/generate_openings.py --tsv-dir /path/to/tsvs
"""

from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import json
import re
import sys
import urllib.request
from pathlib import Path

try:
    import chess
except ImportError:  # pragma: no cover - guidance, not logic
    sys.exit("python-chess is required: run with the server venv")

REPO_ROOT = Path(__file__).resolve().parents[2]
DATA_PATH = REPO_ROOT / "server" / "data" / "openings_eco.json"

TABLES = ("a", "b", "c", "d", "e")
RAW_URL = "https://raw.githubusercontent.com/lichess-org/chess-openings/master/{table}.tsv"

MOVE_NUMBER = re.compile(r"^\d+\.(\.\.)?$")
RESULT_TOKENS = {"1-0", "0-1", "1/2-1/2", "*"}


def normalize_san(token: str) -> str:
    """Strip trailing check/mate markers (names never depend on them)."""
    return token.rstrip("+#")


def pgn_to_san_tokens(pgn: str) -> list[str]:
    tokens = []
    for raw in pgn.split():
        if MOVE_NUMBER.match(raw) or raw in RESULT_TOKENS:
            continue
        tokens.append(normalize_san(raw))
    return tokens


def load_table(path: Path) -> list[tuple[str, str, str]]:
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        eco, name, pgn = line.split("\t")
        if eco.strip() == "eco" and name.strip() == "name":  # header row
            continue
        rows.append((eco.strip(), name.strip(), pgn.strip()))
    return rows


def build_openings(rows: list[tuple[str, str, str]]) -> tuple[dict, dict]:
    """-> (openings dict, stats). Validates every line with python-chess."""
    openings: dict[str, list[str]] = {}
    stats = {"rows": 0, "used": 0, "illegal": 0, "duplicates": 0, "duplicate_examples": []}
    for eco, name, pgn in rows:
        stats["rows"] += 1
        tokens = pgn_to_san_tokens(pgn)
        board = chess.Board()
        legal = True
        try:
            for token in tokens:
                board.push_san(token)
        except ValueError:
            legal = False
        if not legal or not tokens:
            stats["illegal"] += 1
            print(f"skip (illegal/empty): {eco} {name!r} {pgn!r}", file=sys.stderr)
            continue
        key = " ".join(tokens)
        if key in openings:
            stats["duplicates"] += 1
            if len(stats["duplicate_examples"]) < 5:
                stats["duplicate_examples"].append({"key": key, "kept": openings[key], "dropped": [eco, name]})
            continue
        openings[key] = [eco, name]
        stats["used"] += 1
    return openings, stats


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--tsv-dir", type=Path, default=None, help="directory with a.tsv..e.tsv (default: download)")
    parser.add_argument("--out", type=Path, default=DATA_PATH, help=f"output JSON (default {DATA_PATH})")
    args = parser.parse_args()

    rows: list[tuple[str, str, str]] = []
    table_hashes: dict[str, str] = {}
    for table in TABLES:
        if args.tsv_dir is not None:
            source = args.tsv_dir / f"{table}.tsv"
            if not source.exists():
                sys.exit(f"missing {source}")
        else:
            print(f"fetching {RAW_URL.format(table=table)} …", flush=True)
            with urllib.request.urlopen(RAW_URL.format(table=table)) as response:  # noqa: S310 (fixed URL)
                source = Path("/tmp") / f"humanplay-openings-{table}.tsv"
                source.write_bytes(response.read())
        table_hashes[f"{table}.tsv"] = hashlib.sha256(source.read_bytes()).hexdigest()
        rows.extend(load_table(source))

    openings, stats = build_openings(rows)
    payload = {
        "version": 1,
        "source": "lichess-org/chess-openings (a.tsv..e.tsv), https://github.com/lichess-org/chess-openings",
        "license": "CC0-1.0",
        "generated": _dt.date.today().isoformat(),
        "source_sha256": table_hashes,
        "count": len(openings),
        "openings": dict(sorted(openings.items())),
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(payload, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(
        f"wrote {args.out} ({args.out.stat().st_size} bytes): "
        f"{stats['used']} openings from {stats['rows']} rows "
        f"(illegal {stats['illegal']}, duplicate keys skipped {stats['duplicates']})"
    )
    if stats["duplicate_examples"]:
        print("duplicate examples:", json.dumps(stats["duplicate_examples"], ensure_ascii=False))


if __name__ == "__main__":
    main()
