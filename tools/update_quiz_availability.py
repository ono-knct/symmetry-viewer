"""Record which quiz/difficulty pairs each example can pose in the catalog.

Only the ``quiz_availability`` field of ``examples/example_catalog.json`` is
rewritten. The exports and every other catalog field stay as they are, so this
is safe to run after any change to the quiz question generators.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import _bootstrap  # noqa: F401

from crystal_viewer.export_pipeline import default_json_output_path
from crystal_viewer.viewer.quiz_session import QuizSession


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_JSON_DIR = PROJECT_ROOT / "exports/json"
DEFAULT_CATALOG_PATH = PROJECT_ROOT / "examples/example_catalog.json"


def availability_for(export_path: Path) -> dict:
    from tools import view_json_server as host

    payload = json.loads(export_path.read_text(encoding="utf-8"))
    return QuizSession(host).quiz_availability(lambda: (export_path, payload))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--json-dir", type=Path, default=DEFAULT_JSON_DIR)
    parser.add_argument("--catalog", type=Path, default=DEFAULT_CATALOG_PATH)
    parser.add_argument("--indent", type=int, default=2)
    args = parser.parse_args()
    catalog = json.loads(args.catalog.read_text(encoding="utf-8"))
    for kind, entries in catalog.items():
        for entry in entries:
            export = default_json_output_path(Path(entry["path"]), args.json_dir)
            entry["quiz_availability"] = availability_for(export)
            flags = " ".join(f"{quiz}:{''.join('N' if v['normal'] else '-')}{'H' if v['hard'] else '-'}"
                             for quiz, v in entry["quiz_availability"].items())
            print(f"{kind}\t{entry['name']}\t{flags}")
    args.catalog.write_text(json.dumps(catalog, ensure_ascii=False, indent=args.indent) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
