"""Builds the static web version of the viewer, for GitHub Pages or any file host.

    .venv/bin/python web_static/build.py            # -> build/web-static/
    python3 -m http.server -d build/web-static 8000 # try it at http://localhost:8000/

The page, its JavaScript and its Python are the ones the local server uses; see
web_static/README.md for how the browser runs them.  This script only collects
them, analyses the bundled examples with pymatgen/spglib ahead of time, and adds
a pinned copy of Pyodide, so the result needs no server and no CDN.

Needs the development environment (requirements.txt) and, on the first run, an
internet connection to download Pyodide into build/pyodide-cache/.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(PROJECT_ROOT), str(PROJECT_ROOT / "tools")]

import view_json_server as server  # noqa: E402
from crystal_viewer.export_pipeline import default_json_output_path, slug_from_path  # noqa: E402
from crystal_viewer.source_kinds import SOURCE_KIND_CRYSTAL  # noqa: E402
from crystal_viewer.web.browser_ui import HTML  # noqa: E402

PYODIDE_VERSION = "314.0.7"
PYODIDE_CORE_SHA256 = "2abdcc2e35208af406e07724cffa85bc582ced97e9028383ecf5462541393f95"
PYODIDE_CORE_URL = (
    f"https://github.com/pyodide/pyodide/releases/download/{PYODIDE_VERSION}/"
    f"pyodide-core-{PYODIDE_VERSION}.tar.bz2"
)
PYODIDE_PACKAGE_URL = f"https://cdn.jsdelivr.net/pyodide/v{PYODIDE_VERSION}/full/"
PYODIDE_CORE_FILES = ("pyodide.mjs", "pyodide.asm.mjs", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json")
# numpy for everything, Pillow because view_json_server imports it (GIF export).
PYODIDE_PACKAGES = ("numpy", "pillow")
CELL_SETTINGS = ("native", "primitive", "conventional")
# The same values server.main() uses by default.
TOLERANCE_CART = 1e-2
CACHE_DIR = PROJECT_ROOT / "build" / "pyodide-cache"
WEB_DIR = PROJECT_ROOT / "crystal_viewer" / "web"
HERE = Path(__file__).resolve().parent
BUILD_MARKER = ".web-static-build"


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download_verified(url: str, path: Path, sha256: str) -> Path:
    if not path.exists() or sha256_of(path) != sha256:
        print(f"  downloading {url}")
        partial = path.with_suffix(path.suffix + ".part")
        with urllib.request.urlopen(url, timeout=120) as response, partial.open("wb") as handle:
            shutil.copyfileobj(response, handle)
        if sha256_of(partial) != sha256:
            partial.unlink()
            raise RuntimeError(f"SHA-256 mismatch for {url}")
        partial.replace(path)
    return path


def copy_pyodide(out: Path) -> None:
    """Pyodide core and the packages the viewer loads, checked against pinned hashes."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    archive = download_verified(
        PYODIDE_CORE_URL,
        CACHE_DIR / f"pyodide-core-{PYODIDE_VERSION}.tar.bz2",
        PYODIDE_CORE_SHA256,
    )
    target = out / "pyodide"
    target.mkdir(parents=True)
    with tarfile.open(archive, "r:bz2") as tar:
        for name in PYODIDE_CORE_FILES:
            member = tar.getmember(f"pyodide/{name}")
            source = tar.extractfile(member)
            (target / name).write_bytes(source.read())
    # The lock file inside the verified archive pins each package's hash.
    lock = json.loads((target / "pyodide-lock.json").read_text(encoding="utf-8"))
    wanted, queue = set(), list(PYODIDE_PACKAGES)
    while queue:
        name = queue.pop()
        if name not in wanted:
            wanted.add(name)
            queue.extend(lock["packages"][name].get("depends", []))
    for name in sorted(wanted):
        entry = lock["packages"][name]
        cached = download_verified(
            PYODIDE_PACKAGE_URL + entry["file_name"],
            CACHE_DIR / entry["file_name"],
            entry["sha256"],
        )
        shutil.copy2(cached, target / entry["file_name"])


def copy_licenses(out: Path) -> None:
    """Collect notices for the exact runtime, including wheel-vendored libraries."""
    source = HERE / "licenses"
    manifest = json.loads((source / "sources.json").read_text(encoding="utf-8"))
    lock = json.loads((out / "pyodide" / "pyodide-lock.json").read_text(encoding="utf-8"))
    if (manifest["pyodide"] != PYODIDE_VERSION
            or manifest["core_sha256"] != PYODIDE_CORE_SHA256
            or manifest["python"] != lock["info"]["python"]):
        raise RuntimeError("Runtime changed: review web_static/licenses before building")
    wheels = {entry["file_name"]: name for name, entry in lock["packages"].items()}
    installed = {wheels[path.name] for path in (out / "pyodide").glob("*.whl")}
    if installed != set(manifest["packages"]):
        raise RuntimeError("Runtime packages changed: review web_static/licenses")
    for name, version in manifest["packages"].items():
        if lock["packages"][name]["version"] != version:
            raise RuntimeError(f"{name} changed: review web_static/licenses")
    for name, checksum in manifest["vendor_sha256"].items():
        if sha256_of(WEB_DIR / "vendor" / name) != checksum:
            raise RuntimeError(f"Vendor changed: review web_static/licenses ({name})")
    target = out / "licenses"
    target.mkdir()
    lines = [
        "# ライセンスとソースの取得先", "",
        "プログラムは [MITライセンス](symmetry-viewer-LICENSE.txt)です。",
        "収録構造の出典・加工内容・利用条件は [SOURCES.md](SOURCES.md) を参照してください。", "",
        f"実行環境：Pyodide {PYODIDE_VERSION} / CPython {manifest['python']}。",
        "Pyodideの配布物を使用し、本プロジェクトでは実行環境自体の変更は行っていません。",
        "CPythonのWebAssembly対応の変更は、下記のPyodideの作成設定・パッチで確認できます。",
        "PyodideとhiwireのソースはMPL 2.0の条件で、下記の固定版リンクから取得できます。", "",
        "## 実行環境に含まれる部品", "",
        "| 部品 | ライセンス・通知原文 | ソース（使用版） |", "|---|---|---|",
    ]
    for notice in manifest["notices"]:
        original = source / notice["file"]
        if sha256_of(original) != notice["sha256"]:
            raise RuntimeError(f"License checksum mismatch: {original.name}")
        shutil.copy2(original, target / original.name)
        lines.append(f"| {notice['name']} | [{original.name}]({original.name}) | [取得先]({notice['source']}) |")
    shutil.copy2(source / "sources.json", target / "sources.json")
    shutil.copy2(PROJECT_ROOT / "LICENSE", target / "symmetry-viewer-LICENSE.txt")
    shutil.copy2(PROJECT_ROOT / "examples" / "SOURCES.md", target / "SOURCES.md")
    # Keep the source table linked from SOURCES.md accessible in the site.
    (out / "tools").mkdir()
    shutil.copy2(PROJECT_ROOT / "tools" / "generate_example_structures.py",
                 out / "tools" / "generate_example_structures.py")
    lines.extend(["", "spglibの通知は、同梱する対称操作表の出典として収録しています。",
                  "各原文の取得元とSHA-256は [sources.json](sources.json) に記録しています。", "",
                  "## Pythonパッケージ", ""])
    for name, version in manifest["packages"].items():
        entry = lock["packages"][name]
        wheel = out / "pyodide" / entry["file_name"]
        if sha256_of(wheel) != entry["sha256"]:
            raise RuntimeError(f"Wheel checksum mismatch: {wheel.name}")
        copied = []
        with zipfile.ZipFile(wheel) as archive:
            for member in archive.infolist():
                path = Path(member.filename)
                if member.is_dir() or not any(
                    part.lower().startswith(("license", "licence", "copying", "copyright", "notice"))
                    for part in path.parts
                ):
                    continue
                if path.is_absolute() or ".." in path.parts:
                    raise RuntimeError(f"Unsafe license path: {member.filename}")
                destination = target / name / path
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(archive.read(member))
                copied.append(destination.relative_to(target).as_posix())
        if not copied:
            raise RuntimeError(f"No license in {wheel.name}")
        lines.extend([f"### {name} {version}", "",
                      f"[配布元とソース](https://pypi.org/project/{name}/{version}/#files)。同梱wheel内の通知原文：", ""])
        lines.extend(f"- [{path}]({path})" for path in sorted(copied))
        lines.append("")
    lines.extend([
        "## 描画・フォント", "",
        "- Three.js 0.185.1：[ライセンス](../vendor/three/LICENSE)、[変更内容](../vendor/three/README.md)、[配布元とソース](https://www.npmjs.com/package/three/v/0.185.1)。",
        "- Latin Modern Math 1.959：[GUST Font License](../vendor/latin-modern-math/GUST-FONT-LICENSE.txt)、[LPPL 1.3c](lppl.txt)、[通知](../vendor/latin-modern-math/README-Latin-Modern-Math.txt)、[取得先](https://www.gust.org.pl/projects/e-foundry/lm-math)。",
        "", "## 実行環境の作成設定・パッチ", "",
    ])
    lines.extend(f"- <{url}>" for url in manifest["build_sources"])
    (target / "README.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def bundled_examples() -> list[dict]:
    catalog = server.example_catalog()
    return [item for kind in catalog for item in catalog[kind]]


def precompute(app: Path, jobs: int) -> None:
    """Everything that needs pymatgen/spglib, done here instead of in the browser."""
    examples = bundled_examples()
    example_json_dir = app / server.DEFAULT_JSON_EXPORT_DIR
    example_json_dir.mkdir(parents=True)
    cells_dir = app / "web_static_data" / "cells"

    def export_example(item: dict) -> tuple[dict, dict]:
        input_path = PROJECT_ROOT / item["path"]
        output_path = default_json_output_path(input_path, example_json_dir)
        server.export_analysis_to_json_worker(
            input_path,
            mode=item["kind"],
            output_path=output_path,
            tolerance_cart=TOLERANCE_CART,
            indent=0,
        )
        return item, json.loads(output_path.read_text(encoding="utf-8"))

    def export_cell(task: tuple[dict, dict, str]) -> None:
        item, payload, mode = task
        converted = server.export_cell_setting_json_worker(
            payload,
            cell_setting=mode,
            tolerance_cart=TOLERANCE_CART,
            indent=0,
            require_distinct=False,
        )
        path = cells_dir / slug_from_path(item["path"]) / f"{mode}.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(converted, separators=(",", ":")), encoding="utf-8")

    with ThreadPoolExecutor(max_workers=jobs) as pool:
        print(f"  analysing {len(examples)} examples")
        exported = list(pool.map(export_example, examples))
        crystals = [(item, payload) for item, payload in exported if item["kind"] == SOURCE_KIND_CRYSTAL]
        print(f"  converting {len(crystals)} crystals to {', '.join(CELL_SETTINGS)} cells")
        list(pool.map(export_cell, [(item, payload, mode) for item, payload in crystals for mode in CELL_SETTINGS]))

    from crystal_viewer.game.point_group import _displayed_point_group
    from pymatgen.core import Element

    radii = {}
    for atomic_number in range(1, 119):
        element = Element.from_Z(atomic_number)
        radius = element.atomic_radius or element.atomic_radius_calculated
        radii[atomic_number] = float(radius) if radius is not None else None
    tables = {
        "element_radii": radii,
        "displayed_point_groups": {
            slug_from_path(item["path"]): {
                "symbol": _displayed_point_group(payload["render_data"]),
                "atom_count": len(payload["render_data"].get("atoms", [])),
            }
            for item, payload in crystals
        },
    }
    (app / "web_static_data" / "tables.json").write_text(json.dumps(tables), encoding="utf-8")


def copy_app_sources(app: Path) -> None:
    """The Python the browser runs: the package, the server, examples, backend."""
    for path in (PROJECT_ROOT / "crystal_viewer").rglob("*"):
        relative = path.relative_to(PROJECT_ROOT)
        if not path.is_file() or "__pycache__" in relative.parts or "vendor" in relative.parts:
            continue
        if path.suffix in (".js", ".css"):
            continue
        destination = app / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, destination)
    for name in ("view_json_server.py", "_bootstrap.py", "generate_example_structures.py"):
        (app / "tools").mkdir(exist_ok=True)
        shutil.copy2(PROJECT_ROOT / "tools" / name, app / "tools" / name)
    for item in bundled_examples():
        destination = app / item["path"]
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(PROJECT_ROOT / item["path"], destination)
    shutil.copy2(server.EXAMPLE_CATALOG_PATH, app / "examples" / "example_catalog.json")
    shutil.copy2(HERE / "backend.py", app / "backend.py")
    shutil.copy2(PROJECT_ROOT / "LICENSE", app / "LICENSE")
    shutil.copy2(PROJECT_ROOT / "examples" / "SOURCES.md", app / "examples" / "SOURCES.md")


def zip_directory(source: Path, archive: Path) -> None:
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as bundle:
        for path in sorted(source.rglob("*")):
            if path.is_file():
                bundle.write(path, path.relative_to(source).as_posix())


def write_page(out: Path) -> None:
    page = HTML.replace("__INITIAL_APP_MODE__", json.dumps("select"))
    page = page.replace('name="model-view" content="legacy"', 'name="model-view" content="api2"')
    # The page may be served from a sub-path (https://<user>.github.io/<repo>/),
    # so root-relative URLs must become relative.  JS modules keep their own
    # "/static/..." imports; the import map redirects those.
    page = page.replace('href="/static/', 'href="static/').replace('src="/static/', 'src="static/')
    import_map = {"imports": {"/static/": "./static/", "/vendor/": "./vendor/"}}
    head = (
        f'  <script type="importmap">{json.dumps(import_map)}</script>\n'
        '  <link rel="stylesheet" href="static/web_static.css">\n'
        '  <script src="static/web_bridge.js"></script>\n'
    )
    if "</head>" not in page:
        raise RuntimeError("browser_ui.html has no </head>")
    page = page.replace("</head>", head + "</head>", 1)
    (out / "index.html").write_text(page, encoding="utf-8")

    static = out / "static"
    static.mkdir()
    for path in WEB_DIR.iterdir():
        if path.suffix in (".js", ".css"):
            shutil.copy2(path, static / path.name)
    shutil.copy2(HERE / "bridge.js", static / "web_bridge.js")
    shutil.copy2(HERE / "worker.js", static / "web_worker.js")
    shutil.copy2(HERE / "web_static.css", static / "web_static.css")
    shutil.copytree(WEB_DIR / "vendor", out / "vendor", ignore=shutil.ignore_patterns("__pycache__"))


def git_description() -> str:
    try:
        commit = subprocess.run(
            ["git", "-C", str(PROJECT_ROOT), "describe", "--always", "--dirty"],
            check=True, capture_output=True, text=True,
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        commit = "unknown"
    return commit


def prepare_output(out: Path) -> None:
    if out.exists():
        if not (out / BUILD_MARKER).exists() and any(out.iterdir()):
            raise SystemExit(f"{out} exists and was not made by this script; refusing to replace it")
        shutil.rmtree(out)
    out.mkdir(parents=True)
    (out / BUILD_MARKER).write_text("made by web_static/build.py\n", encoding="utf-8")
    # GitHub Pages would otherwise run Jekyll and drop files starting with "_".
    (out / ".nojekyll").write_text("", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--out", type=Path, default=PROJECT_ROOT / "build" / "web-static")
    parser.add_argument("--jobs", type=int, default=os.cpu_count() or 2)
    args = parser.parse_args()
    out = args.out.resolve()

    prepare_output(out)
    print("Pyodide")
    copy_pyodide(out)
    print("Licenses")
    copy_licenses(out)
    print("Precomputing")
    with tempfile.TemporaryDirectory(prefix="symmetry_view_web_") as temp:
        app = Path(temp) / "app"
        app.mkdir()
        precompute(app, args.jobs)
        copy_app_sources(app)
        zip_directory(app, out / "app.zip")
    print("Page")
    write_page(out)
    info = {
        "source": git_description(),
        "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "pyodide": PYODIDE_VERSION,
    }
    (out / "build-info.json").write_text(json.dumps(info, indent=2) + "\n", encoding="utf-8")
    size = sum(path.stat().st_size for path in out.rglob("*") if path.is_file())
    print(f"Built {out} ({size / 1e6:.1f} MB, source {info['source']})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
