"""Check that a static Web build analysed the examples the same way as the bundled exports.

    python web_static/check_build.py build/web-static

build.py re-analyses every example. spglib has changed the order of its
operations between releases, and the operation numbers shown on screen follow
that order, so a build made with other versions than the bundled exports
(exports/json/) would number the same operations differently from the
downloadable versions. Exits non-zero, listing the examples, if any differ.
"""
from __future__ import annotations

import json
import sys
import zipfile
from pathlib import Path

import numpy as np

PROJECT_ROOT = Path(__file__).resolve().parents[1]
EXPORTS = PROJECT_ROOT / "exports" / "json"


def operations(document: dict) -> list[tuple[np.ndarray, np.ndarray]]:
    return [(np.asarray(op["matrix_cart"], float), np.asarray(op["translation_cart"], float))
            for op in document["render_data"]["operations"]]


def same(built: dict, bundled: dict) -> bool:
    a, b = operations(built), operations(bundled)
    return len(a) == len(b) and all(
        np.allclose(m1, m2, atol=1e-6) and np.allclose(t1, t2, atol=1e-6) for (m1, t1), (m2, t2) in zip(a, b))


def main() -> int:
    site = Path(sys.argv[1]) if len(sys.argv) > 1 else PROJECT_ROOT / "build" / "web-static"
    differ, checked = [], 0
    with zipfile.ZipFile(site / "app.zip") as bundle:
        for name in bundle.namelist():
            if not (name.startswith("exports/json/") and name.endswith(".json")):
                continue
            bundled = EXPORTS / Path(name).name
            if not bundled.exists():
                continue
            checked += 1
            if not same(json.loads(bundle.read(name)), json.loads(bundled.read_text(encoding="utf-8"))):
                differ.append(Path(name).stem)
    if checked == 0:
        print("no bundled example found in the build")
        return 1
    if differ:
        print(f"operations differ from exports/json in {len(differ)} of {checked} examples: {', '.join(differ)}")
        return 1
    print(f"operations match exports/json in all {checked} examples")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
