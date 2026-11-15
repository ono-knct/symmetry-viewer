"""Check a built symmetry_view end to end through its HTTP API.

    python3 packaging/smoke_test.py dist/symmetry-viewer/symmetry-viewer
    python3 packaging/smoke_test.py --root . -- .venv/bin/python tools/view_json_server.py

Uses only the standard library, so any Python 3.11+ can run it. It starts the
given command with --no-browser and then, as the browser would:

- fetches the page and every script, stylesheet and Three.js file it loads;
- opens every bundled example, and fails if that re-ran the analysis instead of
  reading the bundled export (the export files must stay untouched);
- converts each bundled crystal to its primitive and Bravais cell;
- imports every bundled CIF/XYZ as if it were the user's own file, which runs
  the whole analysis in a worker process, so a module left out of the build
  shows up here;
- uploads one molecule three times, saved with LF, CRLF and CR newlines, and
  checks what the analysis made of it;
- writes a GIF of the loaded molecule and starts a round of each quiz.

It speaks the page's API version 2: every request carries the identity of
the structure it is about, as view_api.js does.

--quick keeps the cell and import steps to one crystal and one molecule.
--root is the folder holding examples/ and exports/json; for a built
executable it defaults to the _internal folder next to it.
"""

from __future__ import annotations

import argparse
import base64
import json
import locale
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path


STATIC_PATHS = (
    "/static/browser_ui.css",
    "/static/browser_ui.js",
    "/static/animation_path.js",
    "/static/colors.js",
    "/static/model_snapshot.js",
    "/static/operation_math.js",
    "/static/playback_schedule.js",
    "/static/puzzle.js",
    "/static/three_loader.js",
    "/static/three_view.js",
    "/static/view_api.js",
    "/vendor/three/three.module.js",
    "/vendor/three/three.core.js",
    "/vendor/three/addons/controls/TrackballControls.js",
)
# Every request after bootstrap carries the identity of the structure it is
# about (view_api.js / model_snapshot.js); a load answers with the new one.
IDENTITY_KEYS = ("model_id", "source_model_id", "frame_id", "structure_revision", "math_version")
QUIZ_TYPES = ("operation", "composition", "mapping", "point_group")
# A 1x1 PNG, enough for the GIF writer.
PIXEL_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=="
STARTUP_TIMEOUT_SEC = 120


def identity(bundle: dict) -> dict:
    snapshot = bundle.get("model_snapshot") or {}
    return {key: snapshot[key] for key in IDENTITY_KEYS if key in snapshot}


class SmokeTest:
    """Talks to the server the way the page does (API version 2)."""

    def __init__(self, base_url: str) -> None:
        self.base_url = base_url
        self.failures: list[str] = []
        self.bundle: dict = {}  # the analysis structure currently loaded

    def request(self, path: str, payload: dict | None = None, *, timeout: float = 300) -> tuple[int, bytes]:
        data = None if payload is None else json.dumps({"api_version": 2, **payload}).encode("utf-8")
        request = urllib.request.Request(self.base_url + path, data=data)
        if data is not None:
            request.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read()

    def post(self, label: str, path: str, payload: dict, *, quiet: bool = False) -> dict | None:
        started = time.monotonic()
        status, body = self.request(path, payload)
        elapsed = time.monotonic() - started
        try:
            result = json.loads(body)
        except json.JSONDecodeError:
            result = {}
        if status == 200 and isinstance(result, dict) and "error" not in result:
            if not quiet:
                print(f"  ok    {label} ({elapsed:.1f}s)")
            return result
        error = (result.get("message") or result.get("error")) if isinstance(result, dict) else None
        self.fail(f"{label}: HTTP {status}: {error or body[:300].decode('utf-8', 'replace')}")
        return None

    def load(self, label: str, endpoint: str, payload: dict) -> dict | None:
        """open_example / import_* / cell_setting: answers with the new structure."""
        result = self.post(label, f"/api/view/{endpoint}", {**identity(self.bundle), **payload})
        if result is not None:
            if not result.get("model_snapshot"):
                self.fail(f"{label}: the answer has no structure")
                return None
            self.bundle = result
        return result

    def fail(self, message: str) -> None:
        print(f"  FAIL  {message}")
        self.failures.append(message)

    def check_static(self) -> None:
        print("page and assets")
        status, body = self.request("/")
        if status != 200 or b"<html" not in body.lower():
            self.fail(f"/: HTTP {status}")
        for path in STATIC_PATHS:
            status, body = self.request(path)
            if status != 200 or not body:
                self.fail(f"{path}: HTTP {status}, {len(body)} bytes")
        print(f"  checked / and {len(STATIC_PATHS)} assets")

    def bootstrap(self) -> None:
        print("analysis start")
        result = self.post("bootstrap", "/api/view/bootstrap", {})
        if result is not None:
            self.bundle = result

    def examples(self) -> dict[str, list[dict]]:
        catalog = self.post("example catalog", "/api/view/examples", identity(self.bundle), quiet=True) or {}
        print(f"examples: {len(catalog.get('crystal', []))} crystals, {len(catalog.get('molecule', []))} molecules")
        return catalog

    def open_examples(self, catalog: dict[str, list[dict]], root: Path) -> None:
        print("open every bundled example (must use the bundled exports)")
        exports = root / "exports" / "json"
        before = export_snapshot(exports)
        for kind in ("crystal", "molecule"):
            for item in catalog.get(kind, []):
                self.load(f"open {item['path']}", "open_example", {"kind": kind, "path": item["path"]})
        after = export_snapshot(exports)
        if not before:
            self.fail(f"no exports found under {exports}")
        elif before != after:
            changed = sorted(name for name in before.keys() | after.keys() if before.get(name) != after.get(name))
            self.fail(f"opening examples rewrote bundled exports: {', '.join(changed)}")

    def convert_cells(self, crystals: list[dict]) -> None:
        print("primitive and Bravais cells")
        for item in crystals:
            if self.load(f"open {item['path']}", "open_example", {"kind": "crystal", "path": item["path"]}) is None:
                continue
            for mode in ("primitive", "conventional"):
                self.load(f"  {mode}", "cell_setting", {"cell_setting_mode": mode})

    def import_files(self, root: Path, crystals: list[dict], molecules: list[dict]) -> None:
        print("import bundled files as the user's own (full analysis in a worker)")
        for items, endpoint in ((crystals, "import_cif"), (molecules, "import_molecule")):
            for item in items:
                source = root / item["path"]
                content = source.read_text(encoding="utf-8")
                self.load(f"import {source.name}", endpoint, {"filename": source.name, "content": content})

    def check_newlines(self) -> None:
        """Upload the same molecule with each newline convention.

        Notepad saves CRLF, so this is what a Windows user's own file looks
        like. It used to fail there and only there: the upload was written back
        in text mode, Windows turned every "\\n" into "\\r\\n" a second time, and
        the file read back with a blank line between every line, which the XYZ
        parser could not take. The bundled examples cannot cover this -- reading
        one with read_text() strips the carriage returns before the server ever
        sees them -- so build the content here instead. CIF goes through the
        same upload path, so guarding XYZ guards both.

        **On Linux this passes whether or not the fix is in place**, because
        nothing doubles the newlines on the way to disk and Python's universal
        newlines absorb a bare CR on the way back. It is the Windows run of this
        smoke test that does the work. Reproducing the Windows write on Linux
        (normalization removed, newline="\\r\\n") fails on CRLF alone, exactly as
        the machine did, so the check is known to catch the bug it guards.
        """
        print("uploads with each newline convention (a file saved on Windows arrives as CRLF)")
        water = (
            "3\nwater\n"
            "O 0.000000 0.000000 0.117300\n"
            "H 0.000000 0.757200 -0.469200\n"
            "H 0.000000 -0.757200 -0.469200\n"
        )
        for label, content in (
            ("LF", water),
            ("CRLF", water.replace("\n", "\r\n")),
            ("CR", water.replace("\n", "\r")),
        ):
            result = self.load(f"import a molecule saved with {label} newlines", "import_molecule",
                               {"filename": f"newline_{label}.xyz", "content": content})
            if result is None:
                continue
            # "ok" is not enough. A file that reaches the parser mangled can
            # still come back as a molecule -- just the wrong one.
            metadata = ((result.get("render_payload") or {}).get("render_data") or {}).get("metadata") or {}
            found = (
                metadata.get("display_formula") or metadata.get("formula"),
                metadata.get("point_group_label"),
                metadata.get("operation_count"),
            )
            if found == ("H2O", "C2v", 4):
                print(f"  ok    {label} -> H2O, C2v, 4 operations")
            else:
                self.fail(f"{label} newlines analyzed as {found}, expected ('H2O', 'C2v', 4)")

    def check_gif(self) -> None:
        """Write a GIF of the selected operation of the loaded structure."""
        print("GIF export")
        snapshot = self.bundle.get("model_snapshot") or {}
        index = (self.bundle.get("state") or {}).get("operation_index")
        operation = next((op for op in snapshot.get("operations", []) if op.get("operation_index") == index), None)
        plan = next((p for p in (operation or {}).get("plans", []) if p.get("mode") == "default"), None)
        if plan is None:
            self.fail("GIF export: no default plan for the selected operation")
            return
        plan_request = {**identity(self.bundle), "operation_index": index, "operation_id": operation["operation_id"],
                        "mode": "default", "plan_id": plan["plan_id"]}
        path = self.post("animation path", "/api/view/animation_path", {**identity(self.bundle), "plan_request": plan_request})
        if path is None:
            return
        status, body = self.request("/api/view/export_gif", {
            **identity(self.bundle), "plan_request": plan_request, "plan_id": plan["plan_id"],
            "schedule_id": path["playback"]["schedule"]["schedule_id"],
            "frames": [PIXEL_PNG, PIXEL_PNG], "frame_duration_ms": 100})
        if status != 200 or not body.startswith(b"GIF8"):
            self.fail(f"/api/view/export_gif: HTTP {status}, {body[:120]!r}")
        else:
            print(f"  ok    {len(body)} bytes")

    def check_quizzes(self, catalog: dict[str, list[dict]]) -> None:
        """Start a round of each quiz on the first example offering its Normal level."""
        print("quizzes")
        if self.post("quiz start", "/api/quiz/model/bootstrap", {}) is None:
            return
        for quiz in QUIZ_TYPES:
            item = next((item for kind in ("molecule", "crystal") for item in catalog.get(kind, [])
                         if (item.get("quiz_availability") or {}).get(quiz, {}).get("normal")), None)
            if item is None:
                self.fail(f"{quiz}: no example offers this quiz")
                continue
            opened = self.post(f"{quiz}: open {item['path']}", "/api/quiz/model/open_example", {
                "round_id": None, "question_token": None, "selection_revision": 1,
                "kind": item["kind"], "path": item["path"], "quiz_type": quiz, "difficulty": "normal"})
            if opened is None:
                continue
            questions = self.post(f"{quiz}: questions", "/api/quiz/model/questions", {
                **identity(opened), "round_id": opened.get("round_id"), "question_token": None, "selection_revision": 2})
            if questions is not None and not questions.get("questions"):
                self.fail(f"{quiz}: no questions for {item['path']}")


def export_snapshot(directory: Path) -> dict[str, tuple[int, int]]:
    return {path.name: (path.stat().st_mtime_ns, path.stat().st_size) for path in directory.glob("*.json")}


def start(command: list[str]) -> tuple[subprocess.Popen, str]:
    process = subprocess.Popen(
        [*command, "--no-browser", "--port", "0"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        # The Windows launcher writes in the active ANSI code page (CP932 on
        # Japanese Windows). Decode it as the child process does, so printing
        # its banner cannot kill the thread before it discovers the address.
        encoding=locale.getpreferredencoding(False),
        errors="replace",
    )
    found: list[str] = []
    ready = threading.Event()

    def pump() -> None:
        for line in process.stdout:
            print(f"  [app] {line.rstrip()}")
            match = re.search(r"http://[\d.]+:\d+/", line)
            if match and not found:
                found.append(match.group(0).rstrip("/"))
                ready.set()
        ready.set()

    threading.Thread(target=pump, daemon=True).start()
    if not ready.wait(STARTUP_TIMEOUT_SEC) or not found:
        process.kill()
        raise SystemExit(f"the app did not print its address within {STARTUP_TIMEOUT_SEC}s")
    return process, found[0]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", nargs="+", help="The built executable, or a command that starts the server.")
    parser.add_argument("--root", type=Path, default=None, help="Folder holding examples/ and exports/json.")
    parser.add_argument("--quick", action="store_true", help="Convert and import only one crystal and one molecule.")
    args = parser.parse_args()

    root = args.root if args.root is not None else Path(args.command[0]).resolve().parent / "_internal"
    started = time.monotonic()
    process, base_url = start(args.command)
    print(f"started {base_url} in {time.monotonic() - started:.1f}s")
    test = SmokeTest(base_url)
    try:
        test.check_static()
        test.bootstrap()
        catalog = test.examples()
        crystals = catalog.get("crystal", [])
        molecules = catalog.get("molecule", [])
        if not crystals or not molecules:
            test.fail("the example catalog is missing crystals or molecules")
        test.open_examples(catalog, root)
        some_crystals = crystals[:1] if args.quick else crystals
        some_molecules = molecules[:1] if args.quick else molecules
        test.convert_cells(some_crystals)
        test.import_files(root, some_crystals, some_molecules)
        test.check_newlines()
        test.check_gif()
        test.check_quizzes(catalog)
    finally:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()

    print(f"\n{len(test.failures)} failure(s) in {time.monotonic() - started:.0f}s")
    for failure in test.failures:
        print(f"  - {failure}")
    return 1 if test.failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
