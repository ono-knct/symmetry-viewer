"""Answers the viewer's /api/... requests inside the browser (Pyodide).

The request handler is tools/view_json_server.py's own, unchanged: this module
only feeds it requests without a socket and replaces the few things a browser
cannot do.

- Analysing a CIF/XYZ needs pymatgen and spglib, which Pyodide does not have.
  The bundled examples are analysed at build time (web_static/build.py), and
  the server's worker functions are pointed at those results.  Importing a
  user's own file is not supported.
- Cell setting conversion is precomputed the same way. Only exact bundled
  source inputs may select those historical results. ModelLoads prepares and
  validates the complete new model; missing frame correspondence stays unknown.
- Analysis and mapping quizzes use independent ModelSession/API2/ModelView
  states, as in normal HTTP. Legacy summaries belong to the other quiz host. Its background
  work is queued and run after the response because Pyodide has no threads.
- Two lookups that use pymatgen at run time -- element radii and the point group
  of the crystal as the quiz draws it -- read tables made at build time.

Anything else that reaches pymatgen, spglib or scipy fails with an error naming
the module, rather than with a bare ImportError deep inside the handler.
"""

from __future__ import annotations

import base64
import importlib.abc
import importlib.machinery
import io
import json
import sys
import threading
import types
from pathlib import Path
from urllib.parse import urlparse

UNAVAILABLE_PACKAGES = ("pymatgen", "spglib", "scipy", "pyvista", "vtk", "imageio")
# Imported at module level by the server's import chain, but only used to
# analyse a new structure.
ANALYSIS_MODULES = ("crystal_viewer.structure_analysis", "crystal_viewer.molecule_analysis")

_handler_class = None
_pending: list = []


class UnavailableInWebVersion(RuntimeError):
    pass


def _unavailable(name: str):
    def fail(*_args, **_kwargs):
        raise UnavailableInWebVersion(f"{name} is not available in the web version")
    return fail


class _StubModule(types.ModuleType):
    """A module whose every attribute fails when used, not when imported."""

    def __getattr__(self, attr: str):
        if attr.startswith("__"):
            raise AttributeError(attr)
        return _unavailable(f"{self.__name__}.{attr}")


class _StubFinder(importlib.abc.MetaPathFinder, importlib.abc.Loader):
    def find_spec(self, name, path, target=None):
        if name.split(".")[0] in UNAVAILABLE_PACKAGES or name in ANALYSIS_MODULES:
            return importlib.machinery.ModuleSpec(name, self, is_package=True)
        return None

    def create_module(self, spec):
        return _StubModule(spec.name)

    def exec_module(self, module):
        module.__path__ = []


def _install_element_table(radii: dict[int, float | None]) -> None:
    """pymatgen.core.Element, as far as crystal_viewer/viewer/atom_style.py uses it."""

    class Element:
        def __init__(self, atomic_number: int):
            self.Z = atomic_number
            self.atomic_radius = radii.get(atomic_number)
            self.atomic_radius_calculated = None

        @classmethod
        def from_Z(cls, atomic_number: int) -> "Element":
            return cls(int(atomic_number))

    import pymatgen.core  # a stub module, see _StubFinder

    pymatgen.core.Element = Element


class _DeferredThread:
    """threading.Thread for the server module: run the target after the response."""

    def __init__(self, target=None, args=(), kwargs=None, daemon=None):
        self._call = (target, args, kwargs or {})

    def start(self) -> None:
        _pending.append(self._call)


def prepared_cell_basis_info(render_data: dict, data_dir: Path) -> dict:
    """Compare bundled cells without invoking pymatgen inside Pyodide."""
    from crystal_viewer.export_pipeline import slug_from_path
    from crystal_viewer.viewer.cell_basis import compare_cell_bases

    source_file = (render_data.get("metadata") or {}).get("source_file")
    if not source_file or not render_data.get("unit_cell"):
        return {"mode": "unknown", "equivalent": False}
    try:
        directory = data_dir / "cells" / slug_from_path(source_file)
        cells = [json.loads((directory / f"{mode}.json").read_text())["render_data"]
                 for mode in ("primitive", "conventional")]
        return compare_cell_bases(
            render_data,
            cells[0]["unit_cell"]["lattice"], len(cells[0]["atoms"]),
            cells[1]["unit_cell"]["lattice"], len(cells[1]["atoms"]),
        )
    except (OSError, KeyError, ValueError):
        return {"mode": "unknown", "equivalent": False}


def init(app_root: str = "/app") -> None:
    global _handler_class
    root = Path(app_root)
    sys.path[:0] = [str(root), str(root / "tools")]
    sys.meta_path.insert(0, _StubFinder())
    data_dir = root / "web_static_data"
    tables = json.loads((data_dir / "tables.json").read_text(encoding="utf-8"))
    _install_element_table({int(k): v for k, v in tables["element_radii"].items()})

    import view_json_server as server
    from crystal_viewer.export_pipeline import slug_from_path, default_json_output_path
    from crystal_viewer.game import point_group
    from crystal_viewer.viewer.render_state import initial_render_state
    from crystal_viewer.viewer import render_state
    from crystal_viewer.viewer.session import ViewerSession
    from crystal_viewer.viewer.api2 import API2
    from crystal_viewer.viewer.model_session import ModelSession
    from crystal_viewer.viewer.model_loading import ModelLoads
    from crystal_viewer.viewer.model_view import ModelView

    render_state.cell_basis_info = lambda data: prepared_cell_basis_info(data, data_dir)

    def example_export(input_path, *, mode, output_path, **_kwargs):
        if not Path(output_path).exists():
            raise UnavailableInWebVersion(f"{Path(input_path).name} is not bundled with the web version")
        return Path(output_path), None

    def cell_setting_export(base_payload, *, cell_setting, **_kwargs):
        source_file = base_payload["render_data"]["metadata"]["source_file"]
        directory = data_dir / "cells" / slug_from_path(source_file)
        path = directory / f"{cell_setting}.json"
        if not path.exists():
            raise UnavailableInWebVersion(f"cell setting {cell_setting!r} was not prepared for {source_file}")
        # These are historical analysis inputs, not a signature-validated
        # conversion cache. Never select one just from an arbitrary filename.
        candidates = [default_json_output_path(Path(source_file), server.EXAMPLE_JSON_DIR)]
        candidates.extend(directory / f"{mode}.json" for mode in ("native", "primitive", "conventional"))
        if not any(candidate.exists() and json.loads(candidate.read_text(encoding="utf-8")) == base_payload
                   for candidate in candidates):
            raise UnavailableInWebVersion("cell conversion was not prepared for this exact source")
        return json.loads(path.read_text(encoding="utf-8"))

    displayed_point_groups = tables["displayed_point_groups"]

    def displayed_point_group(render_data):
        source_file = (render_data.get("metadata") or {}).get("source_file", "")
        entry = displayed_point_groups.get(slug_from_path(source_file)) if source_file else None
        # Prepared for the example as bundled; another cell of it draws differently.
        if entry is None or entry["atom_count"] != len(render_data.get("atoms", [])):
            return None
        return entry["symbol"]

    server.export_analysis_to_json_worker_cached = example_export
    server.export_analysis_to_json_worker = _unavailable("importing a structure file")
    server.export_cell_setting_json_worker = cell_setting_export
    def crystal_input(input_path=None, *, source_payload=None, cell_setting=None, **_kwargs):
        if source_payload is None:
            _unavailable("importing a structure file")()
        return cell_setting_export(source_payload, cell_setting=cell_setting)
    server.prepare_crystal_input_worker = crystal_input
    server.prepare_molecule_input_worker = _unavailable("importing a structure file")
    server.threading = types.SimpleNamespace(Thread=_DeferredThread, Lock=threading.Lock)
    point_group._displayed_point_group = displayed_point_group

    # The legacy session is empty until the separate quiz host uses it.
    json_path = server.write_empty_viewer_json()
    payload = json.loads(json_path.read_text(encoding="utf-8"))
    session = ViewerSession(json_path, payload)
    shared_state = initial_render_state(payload, initial_operation=None, display_mode="source")
    shared_state["reset"] = False
    shared_state["reload_request_id"] = 0
    shared_state["json_path"] = str(json_path)
    shared_state["pyvista_enabled"] = False
    models = ModelSession(cell_representatives=True)
    api2 = API2(models)
    loads = ModelLoads(models, analysis_context={"host": "static_web", "historical_analysis_conditions": "unknown"},
                       mapping_tolerance_A=.1, operation_match_tolerance=.01)
    model_view = ModelView(api2, server, display_mode="source")
    handler = server.make_handler(
        session,
        shared_state,
        threading.Lock(),
        json_dir=server.EXAMPLE_JSON_DIR,
        import_json_dir=root / server.DEFAULT_BROWSER_IMPORT_JSON_DIR,
        tolerance_cart=1e-2,
        indent=2,
        analysis_timeout_sec=server.DEFAULT_ANALYSIS_TIMEOUT_SEC,
        default_display_mode="source",
        initial_app_mode="select",
        api2=api2, model_loads=loads, model_view=model_view,
    )

    class WebHandler(handler):
        def __init__(self, method: str, path: str, body: bytes):
            self.command = method
            self.path = path
            self.headers = {"Content-Length": str(len(body))}
            self.rfile = io.BytesIO(body)
            self.response = (500, "application/json", b'{"ok": false, "error": "no response"}')

        def send_bytes(self, body: bytes, *, content_type: str) -> None:
            self.response = (200, content_type, body)

        def send_api2_json(self, status: int, body: dict) -> None:
            self.response = (status, "application/json", json.dumps(server.to_jsonable(body), allow_nan=False).encode("utf-8"))

        def send_json_error(self, message: str, *, status: int = 500) -> None:
            body = json.dumps({"ok": False, "error": message}).encode("utf-8")
            self.response = (status, "application/json", body)

        def send_error(self, code: int, message=None, explain=None) -> None:
            self.response = (code, "text/plain", (message or "").encode("utf-8"))

    _handler_class = WebHandler


def handle(method: str, url: str, body: str | bytes = b"") -> tuple[int, str, bytes]:
    """One request, as (status, content type, body)."""
    if isinstance(body, str):
        body = body.encode("utf-8")
    request = _handler_class(method, url, bytes(body or b""))
    try:
        if method == "GET":
            request.do_GET()
        elif method == "POST":
            request.do_POST()
        else:
            request.send_error(405)
    except Exception as exc:  # do_GET has no catch-all of its own
        request.send_json_error(f"unexpected error in {urlparse(url).path}: {exc}", status=500)
    return request.response


def handle_for_js(method: str, url: str, body: str = "") -> tuple[int, str, str, bool]:
    """handle(), with the body as text, or as base64 when it is binary (GIF)."""
    status, content_type, data = handle(method, url, body)
    if content_type.startswith(("application/json", "text/")):
        return status, content_type, data.decode("utf-8"), False
    return status, content_type, base64.b64encode(data).decode("ascii"), True


def has_pending() -> bool:
    return bool(_pending)


def run_pending() -> None:
    """Run the work the server would have left to a background thread."""
    while _pending:
        target, args, kwargs = _pending.pop(0)
        target(*args, **kwargs)
