from __future__ import annotations

import argparse
import base64
import binascii
import io
import json
import os
import subprocess
import sys
import threading
import tempfile
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

try:
    import _bootstrap  # noqa: F401
except ModuleNotFoundError:
    from tools import _bootstrap  # noqa: F401

import logging
import numpy as np
from PIL import Image

from crystal_viewer.export_pipeline import (
    DEFAULT_JSON_EXPORT_DIR,
    default_json_output_path,
    export_analysis_to_json,
    slug_from_path,
)
from crystal_viewer.json_export import EXPORT_SCHEMA_VERSION, to_jsonable
from crystal_viewer.source_kinds import (
    SOURCE_KIND_CRYSTAL,
    SOURCE_KIND_MOLECULE,
    normalize_source_kind,
)
from crystal_viewer.symmetry_operations import (
    compose_operation_sequence,
    find_matching_operation_index,
    find_operation_sequence_bfs,
)
from crystal_viewer.viewer.animation_context import animation_paths
from crystal_viewer.viewer.animation_path import evaluate_path, phase_fraction, two_phase_geometry
from crystal_viewer.viewer.display_atoms import display_fractional_bounds
from crystal_viewer.viewer.cell_placement import placement_choices, translated_payload
from crystal_viewer.viewer.animation_api import (
    animation_path_response,
    custom_animation_path_response,
    symmetry_elements_response,
)
from crystal_viewer.game.catalog import PUZZLE_COUNT_KEYS
from crystal_viewer.game.axis_orders import ROTATION_ORDER_OPTIONS
from crystal_viewer.game.axis_orders import axis_questions as axis_order_questions
from crystal_viewer.game.axis_orders import check_answer as check_axis_order_answer
from crystal_viewer.game.operation_identify import check_answer as check_operation_answer
from crystal_viewer.game.operation_identify import public_questions as public_operation_questions
from crystal_viewer.game.composition import check_answer as check_composition_answer
from crystal_viewer.game.composition import public_questions as public_composition_questions
from crystal_viewer.game.atom_mapping import check_answer as check_mapping_answer
from crystal_viewer.game.atom_mapping import public_questions as public_mapping_questions
from crystal_viewer.game.point_group import check_answer as check_point_group_answer
from crystal_viewer.game.point_group import public_questions as public_point_group_questions
from crystal_viewer.viewer.custom_operation import (
    build_custom_operation_frac,
    check_custom_operation,
    custom_operation_visuals,
)
from crystal_viewer.web.browser_ui import HTML
from crystal_viewer.viewer.operation_lookup import operation_by_index, selected_mapping
from crystal_viewer.viewer.render_state import (
    apply_render_state_update,
    initial_render_state,
    preserved_render_state,
)
from crystal_viewer.viewer.session import ViewerSession
from crystal_viewer.viewer.cell_setting_cache import CellSettingCache, conversion_key, read_precomputed_cell

from crystal_viewer.viewer.model_helpers import (
    custom_operation_tolerance, empty_viewer_payload, atom_api_items, atom_render_style_items, display_atom_api_items, display_unit_cell_api_item, update_view_coordinate_state,
)

logging.getLogger("pyvista").setLevel(logging.ERROR)
logging.getLogger("vtkmodules").setLevel(logging.ERROR)


# True inside the packaged build (packaging/symmetry_view.spec). There every
# file sits under sys._MEIPASS rather than next to this script, and the program
# can be started from any working directory.
FROZEN = bool(getattr(sys, "frozen", False))
PROJECT_ROOT = Path(getattr(sys, "_MEIPASS", "")) if FROZEN else Path(__file__).resolve().parents[1]
UPLOAD_CIF_DIR = Path(tempfile.gettempdir()) / "symmetry_view_cif_uploads"
UPLOAD_MOLECULE_DIR = Path(tempfile.gettempdir()) / "symmetry_view_molecule_uploads"
# Bundled examples are exported here; anchored so the cwd does not matter.
EXAMPLE_JSON_DIR = PROJECT_ROOT / DEFAULT_JSON_EXPORT_DIR
# The packaged build keeps browser imports next to the uploads instead of
# writing into its own folder, so deleting that folder removes everything.
DEFAULT_BROWSER_IMPORT_JSON_DIR = (
    Path(tempfile.gettempdir()) / "symmetry_view_imported_json"
    if FROZEN
    else DEFAULT_JSON_EXPORT_DIR / "imported"
)
# The packaged executable cannot run tools/export_*.py with a Python it does not
# have, so it re-runs itself as `symmetry_view --worker <script> ...` instead.
WORKER_FLAG = "--worker"
DEFAULT_ANALYSIS_TIMEOUT_SEC = 120.0
MAX_REQUEST_BODY_BYTES = 128 * 1024 * 1024
EXAMPLE_DIRS = {
    SOURCE_KIND_CRYSTAL: PROJECT_ROOT / "examples/cif",
    SOURCE_KIND_MOLECULE: PROJECT_ROOT / "examples/molecules",
}
EXAMPLE_SUFFIXES = {
    SOURCE_KIND_CRYSTAL: ".cif",
    SOURCE_KIND_MOLECULE: ".xyz",
}
EXAMPLE_CATALOG_PATH = PROJECT_ROOT / "examples/example_catalog.json"
EMPTY_VIEWER_JSON_PATH = Path(tempfile.gettempdir()) / "symmetry_view_empty.json"
DEBUG_IMPORT_TIMING = os.environ.get("CRYSTAL_VIEWER_DEBUG_IMPORT") == "1"
_EXAMPLE_CATALOG_CACHE: dict[str, list[dict]] | None = None




def custom_operation_matrix_error(W_frac: object, t_frac: object) -> str | None:
    """Validate externally supplied affine-operation data before it is composed."""
    try:
        W = np.asarray(W_frac, dtype=float)
        t = np.asarray(t_frac, dtype=float)
    except (TypeError, ValueError) as exc:
        return f"Operation matrix parameters must be numeric: {exc}"
    if W.shape != (3, 3) or not np.all(np.isfinite(W)):
        return "Operation matrix W must be a finite 3x3 matrix"
    if t.shape != (3,) or not np.all(np.isfinite(t)):
        return "Operation translation t must be a finite vector of length 3"
    return None


def debug_import_timing(label: str, start: float) -> None:
    if DEBUG_IMPORT_TIMING:
        print(f"[import] {label} {time.monotonic() - start:.3f}s", flush=True)


def replace_shared_state_for_load(shared_state: dict, next_state: dict, request_id: int) -> None:
    next_state["load_request_id"] = request_id
    shared_state.clear()
    shared_state.update(next_state)




def write_empty_viewer_json() -> Path:
    EMPTY_VIEWER_JSON_PATH.write_text(json.dumps(empty_viewer_payload(), indent=2), encoding="utf-8")
    return EMPTY_VIEWER_JSON_PATH










def atom_motion_api_items(
    render_data: dict,
    atom_mappings: dict | None,
    operation_index: int | None,
    *,
    paths: dict[int, dict] | None = None,
) -> list[dict]:
    mapping = selected_mapping(atom_mappings, operation_index)
    if mapping is None:
        return []
    atoms_by_index = {atom["index"]: atom for atom in render_data.get("atoms", [])}
    inverse_lattice = None
    unit_cell = render_data.get("unit_cell")
    if unit_cell is not None:
        try:
            inverse_lattice = np.linalg.inv(np.asarray(unit_cell["lattice"], dtype=float))
        except np.linalg.LinAlgError:
            inverse_lattice = None
    items = []
    for entry in mapping.get("entries", []):
        source_index = entry.get("source_atom")
        source_atom = atoms_by_index.get(source_index, {})
        item = {
            "source_atom": source_index,
            "target_atom": entry.get("target_atom"),
            "start_frac": source_atom.get("frac"),
            "start_cart": source_atom.get("cart"),
            "target_frac": entry.get("animation_frac") or entry.get("transformed_frac") or entry.get("wrapped_frac"),
            "target_cart": entry.get("transformed_cart"),
            "wrapped_frac": entry.get("wrapped_frac"),
            "animation_frac": entry.get("animation_frac"),
            "distance": entry.get("distance"),
        }
        path = (paths or {}).get(int(source_index)) if source_index is not None else None
        item["stages"] = compound_path_stage_items(path, inverse_lattice=inverse_lattice)
        items.append(item)
    return items


def compound_path_stage_items(
    path: dict | None,
    *,
    inverse_lattice: np.ndarray | None,
) -> list[dict]:
    if path is None or path.get("type") not in {"screw", "glide", "rotoinversion", "rotoreflection"}:
        return []
    start = np.asarray(path["start"], dtype=float)
    _, _, first_length, second_length = two_phase_geometry(path, start)
    progress = float(path.get("phase_fraction", phase_fraction(first_length, second_length)))
    position_cart = evaluate_path(path, progress)
    position_frac = None if inverse_lattice is None else position_cart @ inverse_lattice
    return [{
        "progress": progress,
        "cart": position_cart.tolist(),
        "frac": None if position_frac is None else position_frac.tolist(),
    }]


def compose_operation_indices(
    render_data: dict,
    operation_indices: list[int],
    tolerance_cart: float,
) -> dict:
    if not operation_indices:
        return {"error": "Operation sequence is empty"}
    unit_cell = render_data.get("unit_cell")
    if unit_cell is None:
        return {"error": "No unit cell in render_data"}
    operations = render_data.get("operations", [])
    selected_operations = []
    for index in operation_indices:
        operation = operation_by_index(operations, index)
        if operation is None:
            return {"error": f"Operation index not found: {index}"}
        if operation.get("matrix_frac") is None or operation.get("translation_frac") is None:
            return {"error": f"Operation {index} does not have fractional matrix data"}
        selected_operations.append(operation)

    composed = compose_operation_sequence(selected_operations)
    check_result = check_custom_operation(
        render_data,
        composed.W,
        composed.t,
        tolerance_cart,
    )
    check_result["W_frac"] = composed.W.tolist()
    check_result["t_frac"] = composed.t.tolist()
    check_result.update(cartesian_operation_items(unit_cell, composed.W, composed.t))
    check_result["operation_indices"] = operation_indices
    check_result["matching_operation_index"] = find_matching_operation_index(
        composed.W,
        composed.t,
        operations,
    )
    return check_result


def compose_operation_sequence_items(
    render_data: dict,
    sequence_items: list[dict],
    tolerance_cart: float,
) -> dict:
    if not sequence_items:
        return {"error": "Operation sequence is empty"}
    unit_cell = render_data.get("unit_cell")
    if unit_cell is None:
        return {"error": "No unit cell in render_data"}
    operations = render_data.get("operations", [])
    selected_operations = []
    labels = []
    for item in sequence_items:
        kind = str(item.get("type") or "operation")
        if kind == "operation":
            try:
                index = int(item["index"])
            except (KeyError, TypeError, ValueError) as exc:
                return {"error": f"Operation item requires an integer index: {exc}"}
            operation = operation_by_index(operations, index)
            if operation is None:
                return {"error": f"Operation index not found: {index}"}
            if operation.get("matrix_frac") is None or operation.get("translation_frac") is None:
                return {"error": f"Operation {index} does not have fractional matrix data"}
            selected_operations.append(operation)
            labels.append(f"op {index}")
        elif kind == "custom":
            if item.get("W_frac") is None or item.get("t_frac") is None:
                return {"error": "Custom operation item requires W_frac and t_frac"}
            matrix_error = custom_operation_matrix_error(item["W_frac"], item["t_frac"])
            if matrix_error is not None:
                return {"error": matrix_error}
            selected_operations.append({
                "matrix_frac": item["W_frac"],
                "translation_frac": item["t_frac"],
            })
            labels.append(str(item.get("label") or "custom"))
        else:
            return {"error": f"Unknown sequence item type: {kind}"}

    composed = compose_operation_sequence(selected_operations)
    check_result = check_custom_operation(
        render_data,
        composed.W,
        composed.t,
        tolerance_cart,
    )
    check_result["W_frac"] = composed.W.tolist()
    check_result["t_frac"] = composed.t.tolist()
    check_result.update(cartesian_operation_items(unit_cell, composed.W, composed.t))
    check_result["sequence_items"] = sequence_items
    check_result["sequence_labels"] = labels
    check_result["matching_operation_index"] = find_matching_operation_index(
        composed.W,
        composed.t,
        operations,
    )
    return check_result


def cartesian_operation_items(unit_cell: dict, W_frac, t_frac) -> dict:
    lattice = np.asarray(unit_cell["lattice"], dtype=float)
    W = np.asarray(W_frac, dtype=float)
    t = np.asarray(t_frac, dtype=float)
    W_cart = lattice.T @ W @ np.linalg.inv(lattice.T)
    t_cart = t @ lattice
    return {
        "matrix_cart": W_cart.tolist(),
        "translation_cart": t_cart.tolist(),
    }




def gif_bytes_from_data_urls(frames: list[str], frame_duration_ms: int) -> bytes:
    if not frames or len(frames) > 180:
        raise ValueError("GIF export requires between 1 and 180 frames")
    # GIF stores a 16-bit delay in hundredths of a second. Do not silently
    # accelerate long distance-based playback by clamping frames to one second.
    frame_duration_ms = max(20, int(frame_duration_ms))
    if frame_duration_ms > 655350:
        raise ValueError("GIF frame duration exceeds the format limit")
    images = []
    try:
        for frame in frames:
            prefix = "data:image/png;base64,"
            if not isinstance(frame, str) or not frame.startswith(prefix):
                raise ValueError("GIF frames must be PNG data URLs")
            encoded = frame[len(prefix):]
            if len(encoded) > 8_000_000:
                raise ValueError("A GIF frame is too large")
            with Image.open(io.BytesIO(base64.b64decode(encoded, validate=True))) as source:
                image = source.convert("RGB")
            images.append(image)
        output = io.BytesIO()
        images[0].save(
            output,
            format="GIF",
            save_all=True,
            append_images=images[1:],
            duration=frame_duration_ms,
            loop=0,
            optimize=False,
        )
        return output.getvalue()
    except (ValueError, TypeError, binascii.Error, OSError) as exc:
        raise ValueError(f"Invalid GIF frame data: {exc}") from exc
    finally:
        for image in images:
            image.close()


def find_operation_sequence_for_target(
    render_data: dict,
    target_operation_index: int,
    generator_indices: list[int],
    max_depth: int,
) -> dict:
    if not generator_indices:
        return {"error": "Generator sequence is empty"}
    operations = render_data.get("operations", [])
    target = operation_by_index(operations, target_operation_index)
    if target is None:
        return {"error": f"Target operation index not found: {target_operation_index}"}

    generators = []
    for index in generator_indices:
        operation = operation_by_index(operations, index)
        if operation is None:
            return {"error": f"Generator operation index not found: {index}"}
        generators.append(operation)

    sequence = find_operation_sequence_bfs(
        target,
        generators,
        operations,
        max_depth=max_depth,
    )
    return {
        "target_operation_index": target_operation_index,
        "generator_indices": generator_indices,
        "max_depth": max_depth,
        "sequence": None if sequence is None else list(sequence),
        "found": sequence is not None,
    }


def puzzle_public_questions(
    render_data: dict,
    atom_mappings: dict | None,
    puzzle_type: str,
    *,
    display_mode: str = "source",
    cell_origin_mode: str = "center",
    improper_mode: str = "auto",
) -> list[dict]:
    """Public puzzle questions (correct answer withheld).

    The highlighted axis geometry is taken from the SAME per-operation
    computation the legacy quiz reveal uses (``symmetry_elements_response``), so the
    displayed axis coincides with the reveal animation. ``render_data["axes"]``
    can list several symmetry-equivalent parallel axes and the axis grouping may
    pick a different one than the operation actually acts on, which is what made
    the drawn axis and the animation disagree for crystals such as MgHPO3.
    """
    questions = axis_order_questions(render_data, puzzle_type)
    public: list[dict] = []
    for index, question in enumerate(questions):
        direction = question["direction_cart"]
        point = question["point_cart"]
        op_index = question["reveal_operations"].get(max(question["correct_orders"])) if question["correct_orders"] else None
        if op_index is not None:
            try:
                elements = symmetry_elements_response(
                    render_data,
                    atom_mappings,
                    op_index,
                    improper_mode=improper_mode,
                    display_mode=display_mode,
                    cell_origin_mode=cell_origin_mode,
                )
            except (ValueError, KeyError, TypeError):
                elements = None
            axes = (elements or {}).get("axes") or []
            if axes:
                direction = axes[0]["direction_cart"]
                point = axes[0]["point_cart"]
        public.append(
            {
                "id": index,
                "direction_cart": direction,
                "point_cart": point,
                "options": list(ROTATION_ORDER_OPTIONS),
                "equivalent_count": question["equivalent_count"],
                "infinite": question["infinite"],
            }
        )
    return public


def example_catalog() -> dict[str, list[dict]]:
    global _EXAMPLE_CATALOG_CACHE
    if _EXAMPLE_CATALOG_CACHE is not None:
        return _EXAMPLE_CATALOG_CACHE
    if EXAMPLE_CATALOG_PATH.exists():
        loaded = json.loads(EXAMPLE_CATALOG_PATH.read_text(encoding="utf-8"))
        _EXAMPLE_CATALOG_CACHE = normalize_example_catalog(loaded)
    else:
        _EXAMPLE_CATALOG_CACHE = filesystem_example_catalog()
    return _EXAMPLE_CATALOG_CACHE


def normalize_example_catalog(loaded: dict) -> dict[str, list[dict]]:
    catalog = {SOURCE_KIND_CRYSTAL: [], SOURCE_KIND_MOLECULE: []}
    for kind in (SOURCE_KIND_CRYSTAL, SOURCE_KIND_MOLECULE):
        for raw in loaded.get(kind, []):
            path = str(raw.get("path") or "")
            if not path:
                continue
            item = {
                "kind": kind,
                "name": str(raw.get("name") or Path(path).stem),
                "path": path,
                "formula": str(raw.get("formula") or ""),
                "display_formula": str(raw.get("display_formula") or raw.get("formula") or ""),
                "symmetry": str(raw.get("symmetry") or ""),
                "point_group": str(raw.get("point_group") or ""),
            }
            # Absent means playable, matching the puzzle_counts convention.
            item["beyond_quiz_vocabulary"] = bool(raw.get("beyond_quiz_vocabulary"))
            counts = raw.get("puzzle_counts")
            if isinstance(counts, dict):
                # Absent counts mean "unknown", and the picker treats unknown as
                # playable; only pass on counts we actually have.
                item["puzzle_counts"] = {
                    key: int(counts.get(key, 0)) for key in PUZZLE_COUNT_KEYS
                }
            availability = raw.get("quiz_availability")
            if isinstance(availability, dict):
                # Playable quiz/difficulty pairs; absent means "check on load".
                item["quiz_availability"] = {
                    quiz: {level: bool((levels or {}).get(level)) for level in ("normal", "hard")}
                    for quiz, levels in availability.items() if quiz in ("operation", "composition", "mapping", "point_group")
                }
            if raw.get("error"):
                item["error"] = str(raw["error"])
            catalog[kind].append(item)
    return catalog


def filesystem_example_catalog() -> dict[str, list[dict]]:
    return {
        SOURCE_KIND_CRYSTAL: filesystem_example_items(SOURCE_KIND_CRYSTAL),
        SOURCE_KIND_MOLECULE: filesystem_example_items(SOURCE_KIND_MOLECULE),
    }


def filesystem_example_items(kind: str) -> list[dict]:
    directory = EXAMPLE_DIRS[kind]
    suffix = EXAMPLE_SUFFIXES[kind]
    items: list[dict] = []
    for path in sorted(directory.glob(f"*{suffix}")):
        items.append({
            "kind": kind,
            "name": path.stem,
            "path": str(path),
            "formula": "",
            "symmetry": "",
            "point_group": "",
        })
    return items


def resolve_example_path(kind: str, requested_path: str) -> Path:
    kind = normalize_source_kind(kind)
    if kind not in EXAMPLE_DIRS:
        raise ValueError(f"unsupported example kind: {kind}")
    base = EXAMPLE_DIRS[kind].resolve()
    path = Path(requested_path)
    if not path.is_absolute():
        path = PROJECT_ROOT / path
    path = path.resolve()
    if path.suffix.lower() != EXAMPLE_SUFFIXES[kind]:
        raise ValueError(f"example must be a {EXAMPLE_SUFFIXES[kind]} file")
    if path.parent != base:
        raise ValueError("example path is outside the allowed examples directory")
    if not path.exists():
        raise FileNotFoundError(f"example not found: {requested_path}")
    return path


def write_uploaded_text(filename: str, content: str, *, upload_dir: Path, suffix: str, label: str) -> Path:
    if not content.strip():
        raise ValueError(f"{label} content is empty.")
    if len(content.encode("utf-8")) > 20 * 1024 * 1024:
        raise ValueError(f"{label} upload is too large.")
    slug = slug_from_path(filename or "uploaded_structure")
    path = upload_dir / f"{slug}{suffix}"
    path.parent.mkdir(parents=True, exist_ok=True)
    # The browser sends the file's text with its newlines intact, so a file
    # written on Windows arrives with CRLF.  Writing that back in text mode on
    # Windows translates every "\n" into "\r\n" a second time: the file on disk
    # holds "\r\r\n" and reads back with a blank line between every line, which
    # the XYZ parser cannot take (IndexError in pymatgen's frame parser).
    # Normalize the newlines and write them through unchanged so the bytes on
    # disk are the same on every platform.
    content = content.replace("\r\n", "\n").replace("\r", "\n")
    path.write_text(content, encoding="utf-8", newline="\n")
    return path


def write_uploaded_cif(filename: str, content: str) -> Path:
    return write_uploaded_text(filename, content, upload_dir=UPLOAD_CIF_DIR, suffix=".cif", label="CIF")


def write_uploaded_molecule(filename: str, content: str) -> Path:
    return write_uploaded_text(filename, content, upload_dir=UPLOAD_MOLECULE_DIR, suffix=".xyz", label="Molecule")


def parse_load_request_id(payload: dict, *, now_ms: float | None = None) -> int:
    """The load request id a client sent, validated and clamped to our clock.

    A non-integer id used to raise out of the request handler, which answered
    nothing at all and dropped the connection.  An id far in the future used to
    be stored as-is, and every later load lost the max(stored, incoming)
    comparison and came back {"ok": false, "stale": true} until the real clock
    caught up.
    """
    raw = payload.get("request_id") or 0
    try:
        request_id = int(raw)
    except (TypeError, ValueError):
        raise ValueError(f"request_id must be an integer: {raw!r}") from None
    if request_id < 0:
        raise ValueError(f"request_id must not be negative: {request_id}")
    if now_ms is None:
        now_ms = time.time() * 1000.0
    # An id ahead of our own clock counts as "now".  Ordering still holds --
    # a load that arrives later clamps to a later "now" -- and no single load
    # can park load_request_id in the future, where it would discard every
    # later load.  Allowing a skew window here would not do: loads sent inside
    # that window would still be dropped in silence.
    return min(request_id, int(now_ms))


def make_handler(
    session: ViewerSession,
    shared_state: dict,
    state_lock: threading.Lock,
    *,
    json_dir: Path,
    import_json_dir: Path,
    tolerance_cart: float,
    indent: int,
    analysis_timeout_sec: float,
    default_display_mode: str,
    initial_app_mode: str = "select",
    api2=None,
    model_loads=None,
    model_view=None,
) -> type[BaseHTTPRequestHandler]:
    if model_loads is not None and (api2 is None or api2.session is not model_loads.session):
        raise ValueError("API2 and ModelLoads must share one ModelSession")
    if model_view is not None and (api2 is None or api2.session is not model_view.session):
        raise ValueError("API2 and ModelView must share one ModelSession")
    if model_loads is not None and model_view is not None:
        model_loads.bind_view(model_view)
    # import_in_progress has to follow the loads that are actually running.  It
    # used to be a plain flag that a load set on arrival and cleared only if it
    # was still the current one, so a load discarded as stale left it set for
    # good and every later cell-setting change was refused.  shared_state is
    # replaced wholesale on a load, so the count lives outside it.
    loads_in_flight = {"count": 0}
    cell_setting_cache = CellSettingCache()
    from crystal_viewer.viewer.quiz_session import QuizSession
    quiz_models = QuizSession(model_view.helpers) if model_view is not None else None

    class Handler(BaseHTTPRequestHandler):
        _cell_setting_cache = cell_setting_cache

        def do_GET(self) -> None:
            parsed_url = urlparse(self.path)
            path = parsed_url.path
            if path.startswith("/api/quiz/model/"):
                self.send_api2_json(406, {"error": "unsupported_contract", "api_version": 2,
                    "message": "Use POST with an API2 quiz request"})
                return
            quiz_request = model_view is not None and path.startswith("/api/quiz/")
            if quiz_request:
                path = "/api/"+path.removeprefix("/api/quiz/")
            if path == "/static/view_api.js":
                self.send_javascript_file(PROJECT_ROOT / "crystal_viewer" / "web" / "view_api.js")
                return
            version = parse_qs(parsed_url.query).get("api_version", ["1"])[0]
            if quiz_request and version != "1":
                self.send_api2_json(406, {"error": "unsupported_contract", "api_version": 1,
                    "message": "The quiz uses its separate API1 state"})
                return
            if path.startswith("/api/") and api2 is not None and version == "1" and not quiz_request:
                self.send_api2_json(406, {"error": "unsupported_contract", "api_version": 2})
                return
            if path.startswith("/api/") and version != "1":
                if version == "2" and path == "/api/model":
                    self.handle_api2(path, {"api_version": 2})
                else:
                    self.send_api2_json(406, {"error": "unsupported_contract", "api_version": 2,
                        "message": "Use POST with an API2 JSON request"})
                return
            if path == "/static/playback_schedule.js":
                self.send_javascript_file(PROJECT_ROOT / "crystal_viewer" / "web" / "playback_schedule.js")
                return
            if path == "/static/model_snapshot.js":
                self.send_javascript_file(PROJECT_ROOT / "crystal_viewer" / "web" / "model_snapshot.js")
                return
            if path == "/":
                page = HTML.replace("__INITIAL_APP_MODE__", json.dumps(initial_app_mode))
                if model_view is not None:
                    page = page.replace('name="model-view" content="legacy"', 'name="model-view" content="api2"')
                self.send_bytes(page.encode("utf-8"), content_type="text/html; charset=utf-8")
                return
            if path == "/favicon.ico":
                # Browsers ask for this on their own.  Answer "no content" so
                # the console does not carry a 404 nobody can act on.
                try:
                    self.send_response(204)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                except (BrokenPipeError, ConnectionResetError):
                    pass
                return
            if path == "/static/animation_path.js":
                module_path = PROJECT_ROOT / "crystal_viewer" / "web" / "animation_path.js"
                self.send_javascript_file(module_path)
                return
            if path == "/static/colors.js":
                module_path = PROJECT_ROOT / "crystal_viewer" / "web" / "colors.js"
                self.send_javascript_file(module_path)
                return
            if path == "/static/browser_ui.css":
                stylesheet_path = PROJECT_ROOT / "crystal_viewer" / "web" / "browser_ui.css"
                self.send_stylesheet_file(stylesheet_path)
                return
            if path == "/static/browser_ui.js":
                module_path = PROJECT_ROOT / "crystal_viewer" / "web" / "browser_ui.js"
                self.send_javascript_file(module_path)
                return
            if path == "/static/operation_math.js":
                self.send_javascript_file(PROJECT_ROOT / "crystal_viewer" / "web" / "operation_math.js")
                return
            if path == "/static/three_loader.js":
                module_path = PROJECT_ROOT / "crystal_viewer" / "web" / "three_loader.js"
                self.send_javascript_file(module_path)
                return
            if path == "/static/three_view.js":
                module_path = PROJECT_ROOT / "crystal_viewer" / "web" / "three_view.js"
                self.send_javascript_file(module_path)
                return
            if path == "/static/puzzle.js":
                module_path = PROJECT_ROOT / "crystal_viewer" / "web" / "puzzle.js"
                self.send_javascript_file(module_path)
                return
            if path == "/vendor/latin-modern-math/latinmodern-math.otf":
                font_path = PROJECT_ROOT / "crystal_viewer" / "web" / "vendor" / "latin-modern-math" / "latinmodern-math.otf"
                if not font_path.is_file():
                    self.send_json_error("The bundled math font is missing", status=404)
                    return
                self.send_bytes(font_path.read_bytes(), content_type="font/otf")
                return
            if path == "/vendor/three/three.module.js":
                module_path = PROJECT_ROOT / "crystal_viewer" / "web" / "vendor" / "three" / "three.module.js"
                self.send_javascript_file(module_path, vendor=True)
                return
            if path == "/vendor/three/three.core.js":
                module_path = PROJECT_ROOT / "crystal_viewer" / "web" / "vendor" / "three" / "three.core.js"
                self.send_javascript_file(module_path, vendor=True)
                return
            if path == "/vendor/three/addons/controls/TrackballControls.js":
                # Its bare `from 'three'` import is already rewritten in the
                # vendored copy; see crystal_viewer/web/vendor/three/README.md.
                module_path = PROJECT_ROOT / "crystal_viewer" / "web" / "vendor" / "three" / "addons" / "controls" / "TrackballControls.js"
                self.send_javascript_file(module_path, vendor=True)
                return
            if path == "/api/operations":
                with state_lock:
                    ready = shared_state.get("summaries_ready", True)
                    operations = session.operation_summary_items
                body = {
                    "operations": operations,
                    "summaries_ready": ready,
                }
                self.send_json(body)
                return
            if path == "/api/atoms":
                with state_lock:
                    atoms = list(session.atoms)
                body = {"atoms": atom_api_items(atoms)}
                self.send_json(body)
                return
            if path == "/api/render_data":
                with state_lock:
                    render_data = session.render_data
                    schema_version = session.payload.get("schema_version")
                    source_kind = session.source_kind
                    display_mode = str(shared_state.get("display_mode", "source"))
                    cell_origin_mode = str(shared_state.get("cell_origin_mode", "center"))
                    include_boundary_images = bool(shared_state.get("include_boundary_images", False))
                    element_colors = dict(shared_state.get("element_colors", {}))
                    atom_colors = dict(shared_state.get("atom_colors", {}))
                    element_hidden = dict(shared_state.get("element_hidden", {}))
                    atom_hidden = dict(shared_state.get("atom_hidden", {}))
                # An explicit ?boundary_images= overrides the shared analysis state
                # (the puzzle shows the cell's equivalent boundary atoms without
                # toggling the analysis mode's own setting).
                boundary_override = parse_qs(parsed_url.query).get("boundary_images")
                if boundary_override:
                    include_boundary_images = boundary_override[0] in ("1", "true", "True")
                display_override = parse_qs(parsed_url.query).get("display_mode")
                if display_override:
                    display_mode = str(display_override[0])
                origin_override = parse_qs(parsed_url.query).get("cell_origin_mode")
                if origin_override:
                    cell_origin_mode = str(origin_override[0])
                body = {
                    "schema_version": schema_version,
                    "source_kind": source_kind,
                    "coordinate_space": "cartesian",
                    "render_data": render_data,
                    "display_mode": display_mode,
                    "cell_origin_mode": cell_origin_mode,
                    "include_boundary_images": include_boundary_images,
                    "display_atoms": display_atom_api_items(
                        render_data,
                        display_mode=display_mode,
                        cell_origin_mode=cell_origin_mode,
                        include_boundary_images=include_boundary_images,
                        element_hidden=element_hidden,
                        atom_hidden=atom_hidden,
                    ),
                    "display_unit_cell": display_unit_cell_api_item(
                        render_data,
                        display_mode=display_mode,
                        cell_origin_mode=cell_origin_mode,
                    ),
                    "atom_styles": atom_render_style_items(
                        render_data,
                        element_colors=element_colors,
                        atom_colors=atom_colors,
                    ),
                }
                self.send_json(body)
                return
            if path == "/api/animation_path":
                query = parse_qs(parsed_url.query)
                try:
                    with state_lock:
                        operation_index = int(
                            query.get("operation_index", [shared_state.get("operation_index", 0)])[0]
                        )
                        render_data = session.render_data
                        atom_mappings = session.atom_mappings
                        # An explicit ?scope= overrides the shared analysis state
                        # (the puzzle forces "displayed" so its reveal always moves
                        # every atom, regardless of any selection left in analysis).
                        scope = str(query.get("scope", [shared_state.get("scope", "displayed")])[0])
                        selected_atoms = tuple(
                            int(index) for index in shared_state.get("selected_atoms", [])
                        )
                        improper_mode = str(shared_state.get("improper_mode", "auto"))
                        display_mode = str(shared_state.get("display_mode", "source"))
                        cell_origin_mode = str(shared_state.get("cell_origin_mode", "center"))
                        include_boundary_images = bool(shared_state.get("include_boundary_images", False))
                    display_override = query.get("display_mode")
                    if display_override:
                        display_mode = str(display_override[0])
                    origin_override = query.get("cell_origin_mode")
                    if origin_override:
                        cell_origin_mode = str(origin_override[0])
                    boundary_override = query.get("boundary_images")
                    if boundary_override:
                        include_boundary_images = boundary_override[0] in ("1", "true", "True")
                    body = animation_path_response(
                        render_data,
                        atom_mappings,
                        operation_index,
                        scope=scope,
                        selected_atoms=selected_atoms,
                        improper_mode=improper_mode,
                        display_mode=display_mode,
                        cell_origin_mode=cell_origin_mode,
                        include_boundary_images=include_boundary_images,
                        repetitions=int(query.get("repetitions", [1])[0]),
                    )
                except (TypeError, ValueError) as exc:
                    self.send_json_error(str(exc), status=400)
                    return
                self.send_json(body)
                return
            if path == "/api/custom_animation_path":
                with state_lock:
                    request = dict(shared_state.get("custom_op_animate") or {})
                    render_data = session.render_data
                    atom_mappings = session.atom_mappings
                    improper_mode = str(shared_state.get("improper_mode", "auto"))
                    display_mode = str(shared_state.get("display_mode", "source"))
                    cell_origin_mode = str(shared_state.get("cell_origin_mode", "center"))
                    include_boundary_images = bool(shared_state.get("include_boundary_images", False))
                if not request:
                    self.send_json_error("No custom animation is active", status=404)
                    return
                self.send_json(custom_animation_path_response(
                    render_data, atom_mappings, request, improper_mode=improper_mode,
                    display_mode=display_mode, cell_origin_mode=cell_origin_mode,
                    include_boundary_images=include_boundary_images,
                ))
                return
            if path == "/api/symmetry_elements":
                query = parse_qs(parsed_url.query)
                try:
                    with state_lock:
                        operation_index = int(
                            query.get("operation_index", [shared_state.get("operation_index", 0)])[0]
                        )
                        render_data = session.render_data
                        atom_mappings = session.atom_mappings
                        improper_mode = str(shared_state.get("improper_mode", "auto"))
                        display_mode = str(shared_state.get("display_mode", "source"))
                        cell_origin_mode = str(shared_state.get("cell_origin_mode", "center"))
                    display_override = query.get("display_mode")
                    if display_override:
                        display_mode = str(display_override[0])
                    origin_override = query.get("cell_origin_mode")
                    if origin_override:
                        cell_origin_mode = str(origin_override[0])
                    body = symmetry_elements_response(
                        render_data,
                        atom_mappings,
                        operation_index,
                        improper_mode=improper_mode,
                        display_mode=display_mode,
                        cell_origin_mode=cell_origin_mode,
                    )
                except (TypeError, ValueError) as exc:
                    self.send_json_error(str(exc), status=400)
                    return
                self.send_json(body)
                return
            if path == "/api/atom_motion":
                with state_lock:
                    render_data = session.render_data
                    atom_mappings = session.atom_mappings
                    operation_index = int(shared_state.get("operation_index", 0))
                    improper_mode = str(shared_state.get("improper_mode", "auto"))
                    display_mode = str(shared_state.get("display_mode", "source"))
                    cell_origin_mode = str(shared_state.get("cell_origin_mode", "center"))
                    repetitions = max(1, min(120, int(shared_state.get("operation_repetitions", 1))))
                operation = operation_by_index(render_data.get("operations", []), operation_index)
                mapping = selected_mapping(atom_mappings, operation_index)
                paths = {}
                kind = str((operation or {}).get("kind", ""))
                compound_operation = (
                    kind.startswith("screw")
                    or "glide" in kind
                    or "rotoinversion" in kind
                    or "rotoreflection" in kind
                    or "improper" in kind
                )
                if operation is not None and mapping is not None and compound_operation:
                    paths = animation_paths(
                        render_data,
                        operation,
                        mapping,
                        animation_scope="all",
                        improper_mode=improper_mode,
                        display_mode=display_mode,
                        cell_origin_mode=cell_origin_mode,
                    )
                entries = atom_motion_api_items(
                    render_data,
                    atom_mappings,
                    operation_index,
                    paths=paths,
                )
                if repetitions > 1 and operation is not None:
                    matrix = np.asarray(operation["matrix_cart"])
                    translation = np.asarray(operation["translation_cart"])
                    unit_cell = render_data.get("unit_cell")
                    inverse = None if unit_cell is None else np.linalg.inv(np.asarray(unit_cell["lattice"]))
                    targets = {entry["source_atom"]: entry.get("target_atom")
                               for entry in (mapping or {}).get("entries", [])}
                    for entry in entries:
                        target = np.asarray(entry["start_cart"], dtype=float)
                        target_index = entry["source_atom"]
                        for _ in range(repetitions):
                            target = matrix @ target + translation
                            target_index = targets.get(target_index)
                        entry.update(target_cart=target.tolist(),
                                     target_frac=None if inverse is None else (target @ inverse).tolist(),
                                     target_atom=target_index, stages=[])
                body = {"operation_index": operation_index, "entries": entries}
                self.send_json(body)
                return
            if path == "/api/puzzle/axis_orders":
                query = parse_qs(parsed_url.query)
                puzzle_type = query.get("type", ["rotation"])[0]
                if puzzle_type not in ("rotation", "improper"):
                    self.send_json_error("unknown puzzle type", status=400)
                    return
                with state_lock:
                    render_data = session.render_data
                    source_kind = session.source_kind
                    atom_mappings = session.atom_mappings
                    display_mode = str(shared_state.get("display_mode", "source"))
                    cell_origin_mode = str(shared_state.get("cell_origin_mode", "center"))
                    improper_mode = str(shared_state.get("improper_mode", "auto"))
                display_override = query.get("display_mode")
                if display_override:
                    display_mode = str(display_override[0])
                origin_override = query.get("cell_origin_mode")
                if origin_override:
                    cell_origin_mode = str(origin_override[0])
                # The correct answer stays server-side; it is revealed only on
                # /api/puzzle/axis_orders/check.
                questions = puzzle_public_questions(
                    render_data,
                    atom_mappings,
                    puzzle_type,
                    display_mode=display_mode,
                    cell_origin_mode=cell_origin_mode,
                    improper_mode=improper_mode,
                )
                self.send_json(
                    {
                        "source_kind": source_kind,
                        "puzzle_type": puzzle_type,
                        "questions": questions,
                    }
                )
                return
            if path == "/api/puzzle/operations":
                difficulty = parse_qs(parsed_url.query).get("difficulty", ["normal"])[0]
                with state_lock:
                    render_data = session.render_data
                    source_kind = session.source_kind
                # Each question carries only the operation index to animate; the
                # operation's name/fold is revealed on /api/puzzle/operations/check.
                self.send_json(
                    {
                        "source_kind": source_kind,
                        "difficulty": difficulty,
                        "questions": public_operation_questions(render_data, difficulty),
                    }
                )
                return
            if path == "/api/puzzle/composition":
                with state_lock:
                    render_data = session.render_data
                    source_kind = session.source_kind
                # Each question carries the two operation indices to animate; the
                # product's name/fold is revealed on /api/puzzle/composition/check.
                self.send_json(
                    {
                        "source_kind": source_kind,
                        "questions": public_composition_questions(render_data),
                    }
                )
                return
            if path == "/api/puzzle/mapping":
                with state_lock:
                    render_data = session.render_data
                    source_kind = session.source_kind
                # Each question carries the operation to animate and the atom to
                # highlight; the target atom is revealed on /api/puzzle/mapping/check.
                self.send_json(
                    {
                        "source_kind": source_kind,
                        "questions": public_mapping_questions(render_data),
                    }
                )
                return
            if path == "/api/puzzle/point_group":
                with state_lock:
                    render_data = session.render_data
                    source_kind = session.source_kind
                # The question carries only the answer choices; which one is
                # correct is revealed by /api/puzzle/point_group/check.
                self.send_json(
                    {
                        "source_kind": source_kind,
                        "questions": public_point_group_questions(render_data),
                    }
                )
                return
            if path == "/api/state":
                with state_lock:
                    body = dict(shared_state)
                self.send_json(body)
                return
            if path == "/api/cell_placement":
                with state_lock:
                    selected = shared_state.get("selected_atoms", [])
                    enabled = (session.source_kind == "crystal" and len(selected) == 1
                               and str(shared_state.get("scope", "")).startswith("selected"))
                    body = {"choices": placement_choices(
                        session.placement_payload["render_data"], int(selected[0])
                    ) if enabled else []}
                self.send_json(body)
                return
            if path == "/api/examples":
                self.send_json(example_catalog())
                return
            self.send_error(404)

        def do_POST(self) -> None:
            # An exception raised out of the handler answers nothing at all and
            # drops the connection, which reaches the browser as a network
            # error with no status to report.  Answer 500 instead.
            try:
                self.dispatch_post()
            except Exception as exc:
                logging.exception("Unhandled error while handling POST %s", self.path)
                self.send_json_error(f"unexpected server error: {exc}", status=500)

        def dispatch_post(self) -> None:
            parsed_url = urlparse(self.path)
            path = parsed_url.path
            model_quiz_request = path.startswith("/api/quiz/model/")
            quiz_request = model_view is not None and path.startswith("/api/quiz/")
            if quiz_request and not model_quiz_request:
                path = "/api/"+path.removeprefix("/api/quiz/")
            length = int(self.headers.get("Content-Length", "0"))
            if length > MAX_REQUEST_BODY_BYTES:
                self.send_json_error("request body is too large", status=413)
                return
            try:
                payload = json.loads(self.rfile.read(length) or b"{}")
            except json.JSONDecodeError as exc:
                self.send_json_error(f"invalid JSON request body: {exc}", status=400)
                return

            query_version = parse_qs(parsed_url.query).get("api_version", [None])[0]
            if path.startswith("/api/") and query_version is not None:
                if (query_version not in ("1", "2") or not isinstance(payload, dict) or
                        ("api_version" in payload and str(payload["api_version"]) != query_version)):
                    self.send_api2_json(406, {"error": "unsupported_contract", "api_version": 2})
                    return
                payload = {**payload, "api_version": int(query_version)}
            if model_quiz_request:
                self.handle_model_quiz(path, payload)
                return
            if quiz_request and (not isinstance(payload, dict) or payload.get("api_version", 1) != 1):
                self.send_api2_json(406, {"error": "unsupported_contract", "api_version": 1,
                    "message": "The quiz uses its separate API1 state"})
                return
            if path.startswith("/api/") and api2 is not None and not quiz_request and (
                    not isinstance(payload, dict) or payload.get("api_version", 1) == 1):
                self.send_api2_json(406, {"error": "unsupported_contract", "api_version": 2})
                return
            if isinstance(payload, dict) and payload.get("api_version", 1) != 1:
                self.handle_api2(path, payload)
                return

            if path == "/api/reset_analysis":
                empty_path = write_empty_viewer_json()
                empty_payload = empty_viewer_payload()
                empty_session = ViewerSession(empty_path, empty_payload)
                with state_lock:
                    session.replace_from(empty_session)
                    next_state = initial_render_state(
                        empty_payload,
                        initial_operation=None,
                        display_mode=default_display_mode,
                    )
                    next_state["reload_request_id"] = int(shared_state.get("reload_request_id") or 0) + 1
                    next_state["load_request_id"] = int(shared_state.get("load_request_id") or 0) + 1
                    next_state["json_path"] = str(empty_path)
                    shared_state.clear()
                    shared_state.update(next_state)
                    body = {
                        "ok": True,
                        "operations": session.operation_summary_items,
                        "atoms": atom_api_items(session.atoms),
                        "state": dict(shared_state),
                    }
                self.send_json(body)
                return

            if path == "/api/check_operation":
                with state_lock:
                    render_data = session.render_data
                unit_cell = render_data.get("unit_cell")
                if unit_cell is None:
                    self.send_json({"error": "No unit cell in render_data"})
                    return
                lattice = np.asarray(unit_cell["lattice"], dtype=float)
                op_type = str(payload.get("type", ""))
                params = payload.get("params", {})
                tolerance, tolerance_error = custom_operation_tolerance(payload.get("tolerance", 0.1))
                if tolerance_error is not None:
                    self.send_json({"error": tolerance_error})
                    return
                result = build_custom_operation_frac(op_type, params, lattice)
                if isinstance(result, str):
                    self.send_json({"error": result})
                    return
                W_frac, t_frac = result
                matrix_error = custom_operation_matrix_error(W_frac, t_frac)
                if matrix_error is not None:
                    self.send_json({"error": matrix_error})
                    return
                if payload.get("build_only"):
                    self.send_json({
                        "W_frac": W_frac.tolist(),
                        "t_frac": t_frac.tolist(),
                        **cartesian_operation_items(unit_cell, W_frac, t_frac),
                    })
                    return
                check_result = check_custom_operation(render_data, W_frac, t_frac, tolerance)
                visuals = custom_operation_visuals(op_type, params, lattice, W_frac, t_frac)
                # include the operation matrix so the browser can request animation
                check_result["W_frac"] = W_frac.tolist()
                check_result["t_frac"] = t_frac.tolist()
                check_result.update(cartesian_operation_items(unit_cell, W_frac, t_frac))
                check_result.update(visuals)
                # store result for PyVista highlight
                with state_lock:
                    if session.render_data is not render_data:
                        self.send_json_error("The coordinate system changed; check the custom operation again", status=400)
                        return
                    shared_state["custom_op_result"] = check_result
                self.send_json(check_result)
                return

            if path == "/api/export_gif":
                try:
                    gif_data = gif_bytes_from_data_urls(
                        payload.get("frames", []),
                        int(payload.get("frame_duration_ms", 100)),
                    )
                except (TypeError, ValueError) as exc:
                    self.send_json_error(str(exc), status=400)
                    return
                self.send_bytes(gif_data, content_type="image/gif")
                return

            if path == "/api/puzzle/axis_orders/check":
                with state_lock:
                    render_data = session.render_data
                try:
                    question_id = int(payload.get("question_id"))
                    selected = payload.get("selected_order")
                    puzzle_type = str(payload.get("type", "rotation"))
                    if puzzle_type not in ("rotation", "improper"):
                        raise ValueError("unknown puzzle type")
                    result = check_axis_order_answer(render_data, question_id, selected, puzzle_type)
                except (TypeError, ValueError) as exc:
                    self.send_json_error(f"invalid puzzle answer: {exc}", status=400)
                    return
                if result is None:
                    self.send_json_error("puzzle question not found", status=404)
                    return
                self.send_json(result)
                return

            if path == "/api/puzzle/operations/check":
                with state_lock:
                    render_data = session.render_data
                try:
                    question_id = int(payload.get("question_id"))
                    kind = str(payload.get("kind", ""))
                    order = payload.get("order")
                    difficulty = str(payload.get("difficulty", "normal"))
                    shift = payload.get("shift")
                    result = check_operation_answer(
                        render_data,
                        question_id,
                        kind,
                        order,
                        difficulty,
                        selected_shift=shift,
                    )
                except (TypeError, ValueError) as exc:
                    self.send_json_error(f"invalid puzzle answer: {exc}", status=400)
                    return
                if result is None:
                    self.send_json_error("puzzle question not found", status=404)
                    return
                self.send_json(result)
                return

            if path == "/api/puzzle/composition/check":
                with state_lock:
                    render_data = session.render_data
                try:
                    question_id = int(payload.get("question_id"))
                    kind = str(payload.get("kind", ""))
                    order = payload.get("order")
                    result = check_composition_answer(render_data, question_id, kind, order)
                except (TypeError, ValueError) as exc:
                    self.send_json_error(f"invalid puzzle answer: {exc}", status=400)
                    return
                if result is None:
                    self.send_json_error("puzzle question not found", status=404)
                    return
                self.send_json(result)
                return

            if path == "/api/puzzle/mapping/check":
                with state_lock:
                    render_data = session.render_data
                try:
                    question_id = int(payload.get("question_id"))
                    selected_atom = payload.get("selected_atom_index")
                    result = check_mapping_answer(render_data, question_id, selected_atom)
                except (TypeError, ValueError) as exc:
                    self.send_json_error(f"invalid puzzle answer: {exc}", status=400)
                    return
                if result is None:
                    self.send_json_error("puzzle question not found", status=404)
                    return
                self.send_json(result)
                return

            if path == "/api/puzzle/point_group/check":
                with state_lock:
                    render_data = session.render_data
                try:
                    question_id = int(payload.get("question_id"))
                    selected = payload.get("selected")
                    result = check_point_group_answer(render_data, question_id, selected)
                except (TypeError, ValueError) as exc:
                    self.send_json_error(f"invalid puzzle answer: {exc}", status=400)
                    return
                if result is None:
                    self.send_json_error("puzzle question not found", status=404)
                    return
                self.send_json(result)
                return

            if path == "/api/compose_operations":
                with state_lock:
                    render_data = session.render_data
                try:
                    operation_indices = [
                        int(index)
                        for index in payload.get("operation_indices", [])
                    ]
                except (TypeError, ValueError) as exc:
                    self.send_json({"error": f"Parameter error: {exc}"})
                    return
                tolerance, tolerance_error = custom_operation_tolerance(payload.get("tolerance", 0.1))
                if tolerance_error is not None:
                    self.send_json({"error": tolerance_error})
                    return
                if "sequence_items" in payload:
                    check_result = compose_operation_sequence_items(
                        render_data,
                        payload.get("sequence_items", []),
                        tolerance,
                    )
                else:
                    check_result = compose_operation_indices(render_data, operation_indices, tolerance)
                if "error" not in check_result and payload.get("store_custom_result"):
                    with state_lock:
                        if session.render_data is not render_data:
                            self.send_json_error("The coordinate system changed; compose the operations again", status=400)
                            return
                        shared_state["custom_op_result"] = check_result
                self.send_json(check_result)
                return

            if path == "/api/find_operation_sequence":
                with state_lock:
                    render_data = session.render_data
                try:
                    target_operation_index = int(payload.get("target_operation_index"))
                    generator_indices = [
                        int(index)
                        for index in payload.get("generator_indices", [])
                    ]
                    max_depth = int(payload.get("max_depth", 4))
                except (TypeError, ValueError) as exc:
                    self.send_json({"error": f"Parameter error: {exc}"})
                    return
                self.send_json(
                    find_operation_sequence_for_target(
                        render_data,
                        target_operation_index,
                        generator_indices,
                        max_depth,
                    )
                )
                return

            if path == "/api/import_cif":
                self.handle_import_cif(payload)
                return

            if path == "/api/import_molecule":
                self.handle_import_molecule(payload)
                return

            if path == "/api/open_example":
                self.handle_open_example(payload)
                return

            if path == "/api/cell_setting":
                self.handle_cell_setting(payload)
                return

            if path == "/api/cell_placement":
                self.handle_cell_placement(payload)
                return

            if path != "/api/state":
                self.send_error(404)
                return

            with state_lock:
                try:
                    candidate_state = dict(shared_state)
                    apply_render_state_update(candidate_state, payload)
                    update_view_coordinate_state(session.render_data, candidate_state, payload)
                    shared_state.clear()
                    shared_state.update(candidate_state)
                    body = dict(candidate_state)
                except (ValueError, np.linalg.LinAlgError) as exc:
                    body = None
                    error = str(exc)
            if body is None:
                self.send_json_error(error, status=400)
                return
            self.send_json(body)

        def handle_open_example(self, payload: dict) -> None:
            started_at = time.monotonic()
            try:
                request_id = self.reserve_load_request(payload)
            except ValueError as exc:
                self.send_json_error(str(exc), status=400)
                return
            kind = normalize_source_kind(str(payload.get("kind") or ""))
            requested_path = str(payload.get("path") or "")
            try:
                input_path = resolve_example_path(kind, requested_path)
                json_path = default_json_output_path(input_path, EXAMPLE_JSON_DIR)
                json_path, new_payload = export_analysis_to_json_worker_cached(
                    input_path,
                    mode=kind,
                    output_path=json_path,
                    tolerance_cart=tolerance_cart,
                    indent=indent,
                    timeout_sec=analysis_timeout_sec,
                )
                debug_import_timing("example export/cache", started_at)
                if new_payload is None:
                    new_payload = json.loads(json_path.read_text(encoding="utf-8"))
                    debug_import_timing("example read-json", started_at)
                else:
                    debug_import_timing("example cached-json", started_at)
                self.load_payload(json_path, new_payload, f"loaded example {input_path.name}", request_id=request_id)
                debug_import_timing("example response", started_at)
            except Exception as exc:
                with state_lock:
                    self.release_load_request_locked()
                    shared_state["import_status"] = f"example load failed: {exc}"
                    body = {"ok": False, "error": str(exc), "state": dict(shared_state)}
                self.send_json(body)
            finally:
                self.release_load_request()

        def reserve_load_request(self, payload: dict) -> int:
            request_id = parse_load_request_id(payload)
            with state_lock:
                loads_in_flight["count"] += 1
                self.load_request_released = False
                shared_state["load_request_id"] = max(
                    int(shared_state.get("load_request_id") or 0),
                    request_id,
                )
                shared_state["import_in_progress"] = True
            return request_id

        def release_load_request(self) -> None:
            with state_lock:
                self.release_load_request_locked()

        def release_load_request_locked(self) -> None:
            """Report this load as finished, however it ended.

            Called once per reserved load -- the second call is a no-op, so a
            handler can release early to answer with an accurate state and still
            keep the release in its finally clause.
            """
            if getattr(self, "load_request_released", True):
                return
            self.load_request_released = True
            loads_in_flight["count"] = max(0, loads_in_flight["count"] - 1)
            shared_state["import_in_progress"] = loads_in_flight["count"] > 0

        def load_request_is_current(self, request_id: int) -> bool:
            return request_id == 0 or request_id == int(shared_state.get("load_request_id") or 0)

        def handle_import_cif(self, payload: dict) -> None:
            started_at = time.monotonic()
            try:
                request_id = self.reserve_load_request(payload)
            except ValueError as exc:
                self.send_json_error(str(exc), status=400)
                return
            filename = str(payload.get("filename") or "uploaded_structure.cif")
            content = str(payload.get("content") or "")
            try:
                if not content.strip():
                    raise ValueError(f"empty CIF file: {filename}")
                cif_path = write_uploaded_cif(filename, content)
                debug_import_timing("cif write", started_at)
                json_path = default_json_output_path(cif_path, import_json_dir)
                json_path = export_analysis_to_json_worker(
                    cif_path,
                    mode=SOURCE_KIND_CRYSTAL,
                    output_path=json_path,
                    tolerance_cart=tolerance_cart,
                    indent=indent,
                    timeout_sec=analysis_timeout_sec,
                )
                debug_import_timing("cif export", started_at)
                new_payload = json.loads(json_path.read_text(encoding="utf-8"))
                debug_import_timing("cif read-json", started_at)
                self.load_payload(json_path, new_payload, f"loaded {filename} -> {json_path}", request_id=request_id)
                debug_import_timing("cif response", started_at)
            except Exception as exc:
                with state_lock:
                    self.release_load_request_locked()
                    shared_state["import_status"] = f"import failed: {exc}"
                    body = {"ok": False, "error": str(exc), "state": dict(shared_state)}
                self.send_json(body)
            finally:
                self.release_load_request()

        def handle_import_molecule(self, payload: dict) -> None:
            started_at = time.monotonic()
            try:
                request_id = self.reserve_load_request(payload)
            except ValueError as exc:
                self.send_json_error(str(exc), status=400)
                return
            filename = str(payload.get("filename") or "uploaded_molecule.xyz")
            content = str(payload.get("content") or "")
            try:
                if not content.strip():
                    raise ValueError(f"empty molecule file: {filename}")
                molecule_path = write_uploaded_molecule(filename, content)
                debug_import_timing("molecule write", started_at)
                json_path = default_json_output_path(molecule_path, import_json_dir)
                json_path = export_analysis_to_json_worker(
                    molecule_path,
                    mode=SOURCE_KIND_MOLECULE,
                    output_path=json_path,
                    tolerance_cart=tolerance_cart,
                    indent=indent,
                    timeout_sec=analysis_timeout_sec,
                )
                debug_import_timing("molecule export", started_at)
                new_payload = json.loads(json_path.read_text(encoding="utf-8"))
                debug_import_timing("molecule read-json", started_at)
                self.load_payload(json_path, new_payload, f"loaded {filename} -> {json_path}", request_id=request_id)
                debug_import_timing("molecule response", started_at)
            except Exception as exc:
                with state_lock:
                    self.release_load_request_locked()
                    shared_state["import_status"] = f"molecule import failed: {exc}"
                    body = {"ok": False, "error": str(exc), "state": dict(shared_state)}
                self.send_json(body)
            finally:
                self.release_load_request()

        def handle_cell_placement(self, payload: dict) -> None:
            try:
                key = str(payload.get("placement", ""))
                with state_lock:
                    selected = tuple(shared_state.get("selected_atoms", []))
                    if (shared_state.get("import_in_progress") or session.source_kind != "crystal"
                            or (key != "initial" and (len(selected) != 1
                                or not str(shared_state.get("scope", "")).startswith("selected")))):
                        raise ValueError("Select exactly one atom in a loaded crystal")
                    canonical = session.placement_payload
                    current = session.payload
                    reload_id = shared_state.get("reload_request_id")
                    atom_index = None
                    target = None
                    if key == "initial":
                        origin = np.zeros(3)
                    else:
                        atom_index = int(selected[0])
                        choices = placement_choices(canonical["render_data"], atom_index)
                        choice = next((item for item in choices if item["key"] == key), None)
                        if choice is None:
                            raise ValueError("Unknown placement")
                        target = payload.get("target") if key == "custom" else choice["target"]
                        target = np.asarray(target, dtype=float)
                        if (target.shape != (3,) or not np.all(np.isfinite(target))
                                or np.any(target < 0) or np.any(target > 1)):
                            raise ValueError("Enter three fractional coordinates between 0 and 1")
                        atom = next(a for a in canonical["render_data"]["atoms"] if a["index"] == atom_index)
                        origin = np.asarray(atom["frac"]) - target
                    base_payload = session.base_payload
                    json_path = session.json_path
                converted = translated_payload(canonical, origin)
                new_session = ViewerSession(json_path, converted, base_payload=base_payload,
                                            placement_payload=canonical)
                with state_lock:
                    if (session.payload is not current or shared_state.get("reload_request_id") != reload_id
                            or tuple(shared_state.get("selected_atoms", [])) != selected
                            or (key != "initial" and not str(shared_state.get("scope", "")).startswith("selected"))
                            or shared_state.get("import_in_progress")):
                        raise ValueError("Structure or selection changed; try placement again")
                    session.replace_from(new_session)
                    shared_state.update({
                        "cell_origin_mode": "corner", "cell_origin_frac": origin.tolist(),
                        "cell_placement": key, "cell_placement_atom": atom_index if key != "initial" else None,
                        "cell_placement_target": target.tolist() if isinstance(target, np.ndarray) else target,
                        "reload_request_id": int(reload_id or 0) + 1,
                        "playing": False, "reset": True, "active_mode": "standard",
                        "custom_op_result": None, "custom_op_animate": None,
                        "custom_op_check_id": None, "clear_custom_check": True,
                        "summaries_ready": True,
                    })
                    if key == "initial" and payload.get("reset_settings") is True:
                        shared_state["display_mode"] = "source"
                    body = {"ok": True, "operations": session.operation_summary_items,
                            "atoms": atom_api_items(session.atoms), "state": dict(shared_state)}
                self.send_json(body)
            except (ValueError, TypeError, StopIteration) as exc:
                self.send_json_error(str(exc), status=400)

        def handle_cell_setting(self, payload: dict) -> None:
            mode = str(payload.get("cell_setting_mode") or payload.get("mode") or "native")
            try:
                with state_lock:
                    if shared_state.get("import_in_progress"):
                        raise RuntimeError("A structure is still loading. Wait for it to finish before changing cell setting.")
                    base_payload = session.base_payload
                    current_payload = session.payload
                    placement_payload = session.placement_payload
                    current_json_path = session.json_path
                    current_reload_id = shared_state.get("reload_request_id")
                    preserved_status = shared_state.get("import_status", "")
                source_payload = base_payload if mode == "native" else placement_payload
                key = conversion_key(source_payload, mode, tolerance_cart)
                with state_lock:
                    converted_payload = cell_setting_cache.get(key)
                if converted_payload is None:
                    converted_payload = read_precomputed_cell(
                        PROJECT_ROOT, base_payload, source_payload, mode, tolerance_cart, key,
                    )
                if converted_payload is None:
                    converted_payload = export_cell_setting_json_worker(
                        source_payload,
                        cell_setting=mode,
                        tolerance_cart=tolerance_cart,
                        indent=indent,
                        timeout_sec=analysis_timeout_sec,
                        # Equivalent P cells still allow standardization via API.
                        require_distinct=False,
                    )
                new_session = ViewerSession(current_json_path, converted_payload, base_payload=base_payload)
                with state_lock:
                    if shared_state.get("import_in_progress"):
                        raise RuntimeError("A structure started loading before cell setting conversion finished.")
                    if (session.json_path != current_json_path or session.payload is not current_payload
                            or shared_state.get("reload_request_id") != current_reload_id):
                        raise RuntimeError("The loaded structure changed before cell setting conversion finished.")
                    preserved = {
                        **preserved_render_state(shared_state),
                        "cell_origin_mode": "corner",
                        "cell_setting_mode": mode,
                        "reload_request_id": shared_state.get("reload_request_id"),
                        "import_status": preserved_status,
                        "json_path": shared_state.get("json_path", str(current_json_path)),
                        "pyvista_enabled": bool(shared_state.get("pyvista_enabled", False)),
                    }
                    next_state = initial_render_state(
                        converted_payload,
                        initial_operation=None,
                        display_mode=default_display_mode,
                        preserved=preserved,
                    )
                    next_state["reload_request_id"] = int(shared_state.get("reload_request_id") or 0) + 1
                    next_state["structure_loaded"] = True
                    next_state["import_status"] = preserved_status
                    next_state["json_path"] = str(current_json_path)
                    session.replace_from(new_session)
                    cell_setting_cache.put(key, converted_payload)
                    shared_state.clear()
                    shared_state.update(next_state)
                    body = {
                        "ok": True,
                        "operations": session.operation_summary_items,
                        "atoms": atom_api_items(session.atoms),
                        "state": dict(shared_state),
                    }
                self.send_json(body)
            except Exception as exc:
                self.send_json_error(str(exc), status=400)

        def load_payload(
            self,
            json_path: Path,
            new_payload: dict,
            import_status: str,
            *,
            request_id: int = 0,
        ) -> None:
            started_at = time.monotonic()
            new_session = ViewerSession(json_path, new_payload, summarize_operations=False)
            debug_import_timing("session minimal summaries", started_at)
            with state_lock:
                if not self.load_request_is_current(request_id):
                    body = {"ok": False, "stale": True, "state": dict(shared_state)}
                    self.send_json(body)
                    return
                preserved = {
                    "reload_request_id": shared_state.get("reload_request_id"),
                    "pyvista_enabled": bool(shared_state.get("pyvista_enabled", False)),
                }
                session.replace_from(new_session)
                cell_setting_cache.clear()
                next_state = initial_render_state(
                    new_payload,
                    initial_operation=None,
                    display_mode="source",
                    preserved=preserved,
                )
                next_state["reload_request_id"] = int(shared_state.get("reload_request_id") or 0) + 1
                next_state["structure_loaded"] = True
                next_state["import_in_progress"] = False
                next_state["import_status"] = import_status_with_warnings(import_status, new_payload)
                next_state["json_path"] = str(json_path)
                next_state["summaries_ready"] = False
                replace_shared_state_for_load(shared_state, next_state, request_id)
                body = {
                    "ok": True,
                    "json_path": str(json_path),
                    "operations": session.operation_summary_items,
                    "atoms": atom_api_items(session.atoms),
                    "state": dict(shared_state),
                }
            self.compute_operation_summaries_async(new_session, request_id)
            self.send_json(body)

        def compute_operation_summaries_async(self, loaded_session: ViewerSession, request_id: int) -> None:
            def worker() -> None:
                try:
                    summaries = loaded_session.compute_operation_summaries()
                except Exception as exc:
                    logging.exception("Failed to compute operation summaries for %s", loaded_session.json_path)
                    with state_lock:
                        if (
                            self.load_request_is_current(request_id)
                            and session.json_path == loaded_session.json_path
                            and session.payload is loaded_session.payload
                        ):
                            shared_state["summaries_error"] = str(exc)
                            shared_state["summaries_ready"] = True
                    return
                with state_lock:
                    if not self.load_request_is_current(request_id):
                        return
                    if session.json_path != loaded_session.json_path:
                        return
                    if session.payload is not loaded_session.payload:
                        return
                    session.operation_summary_items = summaries
                    shared_state["summaries_ready"] = True

            threading.Thread(target=worker, daemon=True).start()

        def handle_model_quiz(self, path, payload):
            if not isinstance(payload, dict) or type(payload.get("api_version")) is not int or payload["api_version"] != 2:
                self.send_api2_json(406, dict(error="unsupported_contract", api_version=2))
                return
            from crystal_viewer.viewer.model_session import ModelConflict
            try:
                if quiz_models is None:
                    raise ModelConflict("quiz model host unavailable")
                json.dumps(payload, allow_nan=False)
                endpoint = path.removeprefix("/api/quiz/model/")
                if endpoint in ("open_example", "composition_options", "mapping_options"):
                    def loader():
                        source = resolve_example_path(payload.get("kind"), str(payload.get("path", "")))
                        output = default_json_output_path(source, EXAMPLE_JSON_DIR)
                        # Like the browser analysis picker, these are recorded
                        # source inputs, not a signature-validated conversion cache.
                        return output, json.loads(output.read_text(encoding="utf-8"))
                    if endpoint == "composition_options":
                        body = quiz_models.composition_options(loader)
                    elif endpoint == "mapping_options":
                        body = quiz_models.mapping_options(loader)
                    else:
                        body = quiz_models.load(loader, identity=payload if "model_id" in payload else None,
                                                quiz_type=payload.get("quiz_type", "mapping"), difficulty=payload.get("difficulty", "normal"))
                elif endpoint == "export_gif":
                    with quiz_models.lock:
                        active = quiz_models.active
                        if active is None or active.quiz_type != "operation":
                            raise ModelConflict("quiz GIF unavailable")
                        request = active.view.request()
                        request["plan_id"] = payload.get("plan_id")
                        playback = quiz_models.dispatch("animation_path", dict(payload, plan_request=request))["playback"]
                        if playback["plan_id"] != payload.get("plan_id") or playback["schedule"]["schedule_id"] != payload.get("schedule_id"):
                            raise ModelConflict("quiz GIF plan or references changed")
                        rendered = gif_bytes_from_data_urls(payload["frames"], int(payload["frame_duration_ms"]))
                    self.send_bytes(rendered, content_type="image/gif")
                    return
                else:
                    body = quiz_models.dispatch(endpoint, payload)
                self.send_api2_json(200, body)
            except Exception as exc:
                self.send_api2_json(409 if isinstance(exc, ModelConflict) else 400,
                    dict(error="state_mismatch" if isinstance(exc, ModelConflict) else "invalid_request",
                         message=str(exc), api_version=2))

        def handle_api2(self, path: str, payload: dict) -> None:
            if type(payload.get("api_version")) is not int or payload["api_version"] != 2:
                self.send_api2_json(406, {"error": "unsupported_contract", "api_version": 2})
                return
            if api2 is None:
                self.send_api2_json(409, {"error": "model_not_prepared", "api_version": 2})
                return
            try:
                json.dumps(payload, allow_nan=False)
            except (TypeError, ValueError) as exc:
                self.send_api2_json(400, dict(error="invalid_request", message=str(exc), api_version=2))
                return
            if path.startswith("/api/view/") and model_view is not None:
                endpoint = path.removeprefix("/api/view/")
                if endpoint in ("load_json", "open_example", "import_cif", "import_molecule", "cell_setting", "reset_analysis") or (endpoint == "cell_placement" and "placement" in payload):
                    if endpoint == "cell_placement" and "atom_index" not in payload:
                        with model_view.lock:
                            model_view.sync()
                            selected = model_view.state["selected_atoms"]
                            if len(selected) == 1:
                                payload["atom_index"] = selected[0]
                    self.handle_api2_load("/api/"+endpoint, payload, browser=True)
                    return
                try:
                    if (endpoint == "state" and "cell_origin_mode" in payload.get("update", {})
                            and model_view.snapshot is not None and model_view.snapshot.representatives_json):
                        update = dict(payload["update"])
                        mode = update.pop("cell_origin_mode")
                        body = model_loads.reference_cell(payload, mode, update=update)
                        self.send_api2_json(200, model_view.bundle(body))
                        return
                    if endpoint in ("animation_path", "atom_motion", "symmetry_elements", "powers") and model_view.snapshot is not None and "plan_request" not in payload:
                        raise ValueError("snapshot-bound plan_request required")
                    if endpoint == "custom_animation_path" and "expected_plan_id" not in payload:
                        raise ValueError("checked Custom plan ID required")
                    if endpoint == "examples":
                        body = example_catalog()
                    elif endpoint == "bootstrap":
                        body = model_view.bundle()
                    elif endpoint == "export_gif":
                        from crystal_viewer.viewer.model_session import ModelConflict
                        with model_view.lock:
                            model_view.session.snapshot(payload)
                            endpoint_path = "custom_animation_path" if model_view.state["active_mode"] == "custom" else "animation_path"
                            playback = model_view.dispatch(endpoint_path, payload)["playback"]
                            if playback["plan_id"] != payload.get("plan_id") or playback["schedule"]["schedule_id"] != payload.get("schedule_id"):
                                raise ModelConflict("GIF plan or references changed")
                            rendered = gif_bytes_from_data_urls(payload["frames"], int(payload["frame_duration_ms"]))
                            model_view.session.snapshot(payload)
                        self.send_bytes(rendered, content_type="image/gif")
                        return
                    else:
                        body = model_view.dispatch(endpoint, payload)
                    self.send_api2_json(200, body)
                except Exception as exc:
                    from crystal_viewer.viewer.model_session import ModelConflict
                    self.send_api2_json(409 if isinstance(exc, ModelConflict) else 400,
                        dict(error="state_mismatch" if isinstance(exc, ModelConflict) else "invalid_request", message=str(exc), api_version=2))
                return
            load_paths = {"/api/load_json", "/api/open_example", "/api/import_cif", "/api/import_molecule",
                          "/api/cell_setting", "/api/cell_placement", "/api/reset_analysis"}
            if path in load_paths and model_loads is not None:
                self.handle_api2_load(path, payload)
                return
            status, body = api2.dispatch(path, payload)
            self.send_api2_json(status, body)

        def handle_api2_load(self, path: str, payload: dict, *, browser=False) -> None:
            # These opt-in paths reuse only source analysis/conversion workers.
            # No legacy ViewerSession, summary worker or UI state is published.
            from crystal_viewer.viewer.model_session import ModelConflict
            from crystal_viewer.viewer.model_policy import CorrectionLimitError
            try:
                if path == "/api/cell_setting":
                    source_snapshot = model_loads.session.snapshot(payload)
                    source_context = json.loads(source_snapshot.load_context_json)
                    def converter(source, mode):
                        key = conversion_key(source, mode, tolerance_cart)
                        prepared = read_precomputed_cell(PROJECT_ROOT, source_context["base_payload"],
                            source, mode, tolerance_cart, key)
                        if prepared is not None:
                            from crystal_viewer.viewer.cell_frame import attach_frame_witness
                            attach_frame_witness(source, prepared, symprec=.001,
                                angle_tolerance=5., cell_setting=mode)
                            return prepared
                        return prepare_crystal_input_worker(source_payload=source, cell_setting=mode,
                            timeout_sec=analysis_timeout_sec)
                    body = model_loads.cell_setting(payload,
                        str(payload.get("cell_setting_mode", "native")), converter, tolerance_cart=tolerance_cart)
                elif path == "/api/cell_placement":
                    body = model_loads.cell_placement(payload, str(payload.get("placement", "")),
                        atom_index=payload.get("atom_index"), target=payload.get("target"))
                elif path == "/api/reset_analysis":
                    body = model_loads.reset(payload)
                else:
                    provenance = dict(entrypoint=path, export_mapping_tolerance_A=tolerance_cart)
                    def loader():
                        if path == "/api/load_json":
                            candidate = (json_dir / str(payload["path"])).resolve()
                            if not candidate.is_relative_to(json_dir.resolve()) or candidate.suffix.lower() != ".json":
                                raise ValueError("JSON path must be inside json_dir")
                            return candidate, json.loads(candidate.read_text(encoding="utf-8"))
                        if path == "/api/open_example":
                            kind = normalize_source_kind(str(payload.get("kind", "")))
                            input_path = resolve_example_path(kind, str(payload.get("path", "")))
                            provenance.update(filename=input_path.name, content=input_path.read_text(encoding="utf-8"))
                            output = default_json_output_path(input_path, EXAMPLE_JSON_DIR)
                            if browser:
                                # Opening an example must not regenerate recorded data.
                                return output, json.loads(output.read_text(encoding="utf-8"))
                            cached = cached_export_json_path(input_path, output, mode=kind)
                            if cached is not None:
                                return cached
                            worker = prepare_crystal_input_worker if kind == SOURCE_KIND_CRYSTAL else prepare_molecule_input_worker
                            return input_path, worker(input_path, timeout_sec=analysis_timeout_sec)
                        molecule = path == "/api/import_molecule"
                        filename = str(payload.get("filename") or ("uploaded_molecule.xyz" if molecule else "uploaded_structure.cif"))
                        content = str(payload.get("content", ""))
                        if not content.strip():
                            raise ValueError("empty uploaded structure")
                        from inspect import Parameter, signature
                        from crystal_viewer.source_inputs import crystal_input_from_cif, molecule_input_from_file
                        analysis = molecule_input_from_file if molecule else crystal_input_from_cif
                        provenance.update(filename=filename, content=content,
                            analysis_defaults={name: item.default for name, item in signature(analysis).parameters.items()
                                if item.kind == Parameter.KEYWORD_ONLY and item.default is not Parameter.empty})
                        input_path = (write_uploaded_molecule if molecule else write_uploaded_cif)(filename, content)
                        worker = prepare_molecule_input_worker if molecule else prepare_crystal_input_worker
                        return input_path, worker(input_path, timeout_sec=analysis_timeout_sec)
                    body = model_loads.load(loader, provenance=provenance,
                        identity=payload if "model_id" in payload else None)
                if (browser and path == "/api/cell_placement" and payload.get("placement") == "initial"
                        and payload.get("reset_settings") is True):
                    with model_view.lock:
                        identity = {key: body[key] for key in ("model_id", "source_model_id", "frame_id", "structure_revision", "math_version")}
                        model_view.dispatch("state", dict(identity,
                            update=dict(display_mode="source", range_highlight=False)))
                self.send_api2_json(200, model_view.bundle(body) if browser else body)
            except ModelConflict as exc:
                self.send_api2_json(409, {"error": "state_mismatch", "message": str(exc), "api_version": 2})
            except CorrectionLimitError as exc:
                self.send_api2_json(400, {"error": "correction_limit_exceeded", "message": str(exc),
                    "correction_policy": exc.report, "api_version": 2})
            except Exception as exc:
                self.send_api2_json(400, {"error": "model_preparation_failed", "message": str(exc), "api_version": 2})

        def send_api2_json(self, status: int, body: dict) -> None:
            encoded = json.dumps(to_jsonable(body), allow_nan=False).encode("utf-8")
            try:
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)
            except (BrokenPipeError, ConnectionResetError):
                return

        def send_json(self, body: dict) -> None:
            self.send_bytes(
                json.dumps(body, default=to_jsonable).encode("utf-8"),
                content_type="application/json",
            )

        def send_javascript_file(self, path: Path, *, vendor: bool = False, transform=None) -> None:
            try:
                text = path.read_text(encoding="utf-8")
            except FileNotFoundError:
                message = (
                    f"The vendored Three.js file is missing: crystal_viewer/web/vendor/three/.../{path.name}"
                    if vendor
                    else f"JavaScript asset not found: {path.name}"
                )
                self.send_json_error(message, status=503 if vendor else 404)
                return
            if transform is not None:
                text = transform(text)
            self.send_bytes(text.encode("utf-8"), content_type="text/javascript; charset=utf-8")

        def send_stylesheet_file(self, path: Path) -> None:
            try:
                text = path.read_text(encoding="utf-8")
            except FileNotFoundError:
                self.send_json_error(f"Stylesheet asset not found: {path.name}", status=404)
                return
            self.send_bytes(text.encode("utf-8"), content_type="text/css; charset=utf-8")

        def send_json_error(self, message: str, *, status: int = 500) -> None:
            body = json.dumps({"ok": False, "error": message}).encode("utf-8")
            try:
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                return

        def send_bytes(self, body: bytes, *, content_type: str) -> None:
            try:
                self.send_response(200)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                return

        def log_message(self, *args) -> None:
            return

    return Handler


def open_url(url: str) -> None:
    """Open URL in the default browser.  On WSL, webbrowser.open() often fails
    because there is no Linux browser; use cmd.exe instead to open Windows Edge."""
    import platform
    import subprocess
    if "microsoft" in platform.uname().release.lower():
        try:
            subprocess.run(
                ["cmd.exe", "/c", "start", "", url],
                check=False,
                capture_output=True,
            )
            return
        except FileNotFoundError:
            pass
    webbrowser.open(url)


class ReusableThreadingHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True
    block_on_close = False


def start_server(host: str, port: int, handler: type[BaseHTTPRequestHandler]) -> ThreadingHTTPServer:
    server = ReusableThreadingHTTPServer((host, port), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


def worker_command(script_name: str) -> list[str]:
    """Start of the command that runs tools/<script_name> in a child process."""
    if FROZEN:
        # packaging/launcher.py dispatches this back to the script's main().
        return [sys.executable, WORKER_FLAG, script_name]
    return [sys.executable, str(Path(__file__).with_name(script_name))]


def prepare_crystal_input_worker(input_path=None, *, source_payload=None, cell_setting=None,
                                 timeout_sec=None):
    """Run API2 crystal acquisition in isolation; all products are temporary."""
    return _prepare_model_input_worker(input_path, source_payload=source_payload,
        cell_setting=cell_setting, timeout_sec=timeout_sec)


def prepare_molecule_input_worker(input_path, *, timeout_sec=None):
    return _prepare_model_input_worker(input_path, mode="molecule", timeout_sec=timeout_sec)


def _prepare_model_input_worker(input_path=None, *, source_payload=None, cell_setting=None,
                                mode="crystal", timeout_sec=None):
    if ((input_path is None) == (source_payload is None) or
            (source_payload is not None) != (cell_setting is not None)):
        raise ValueError("crystal file or a source payload with cell setting required")
    with tempfile.TemporaryDirectory(prefix="symmetry_model_input_") as directory:
        directory = Path(directory)
        if source_payload is not None:
            input_path = directory / "source.json"
            input_path.write_text(json.dumps(source_payload, allow_nan=False), encoding="utf-8")
        output = directory / "input.json"
        command = [*worker_command("prepare_model_input.py"), str(input_path), "--output", str(output), "--mode", mode]
        if cell_setting is not None:
            command += ["--cell-setting", cell_setting]
        try:
            result = subprocess.run(command, capture_output=True, text=True, timeout=timeout_sec)
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError(f"{mode} input analysis timed out") from exc
        if result.returncode != 0:
            raise RuntimeError((result.stderr or result.stdout or f"{mode} input preparation failed").strip())
        return json.loads(output.read_text(encoding="utf-8"))


def export_analysis_to_json_worker(
    input_path: Path,
    *,
    mode: str,
    output_path: Path,
    tolerance_cart: float,
    indent: int,
    timeout_sec: float | None = None,
) -> Path:
    command = [
        *worker_command("export_analysis_json.py"),
        "--legacy-contract",
        str(input_path),
        "--mode",
        mode,
        "--output",
        str(output_path),
        "--tolerance-cart",
        str(tolerance_cart),
        "--indent",
        str(indent),
    ]
    try:
        result = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout_sec,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(
            f"analysis timed out after {timeout_sec:g} seconds for {input_path}"
        ) from exc
    if result.returncode != 0:
        message = (result.stderr or result.stdout or "").strip()
        raise RuntimeError(message or f"export worker failed with exit code {result.returncode}")
    return output_path


def cached_export_json_path(
    input_path: Path,
    output_path: Path,
    *,
    mode: str,
) -> tuple[Path, dict] | None:
    if not output_path.exists():
        return None
    try:
        # The packaged build ships each example with its export and nothing edits
        # either afterwards, while the copies made on the way (build, archive,
        # unpacking) do not promise to keep the export the newer file.
        if not FROZEN and output_path.stat().st_mtime < input_path.stat().st_mtime:
            return None
        payload = json.loads(output_path.read_text(encoding="utf-8"))
    except Exception:
        return None
    if int(payload.get("schema_version") or 0) < EXPORT_SCHEMA_VERSION:
        return None

    render_data = payload.get("render_data") or {}
    metadata = render_data.get("metadata") or {}
    source_kind = normalize_source_kind(
        payload.get("source_kind", metadata.get("mode", ""))
    )
    if source_kind != mode:
        return None
    if not cached_source_matches(metadata.get("source_file"), input_path):
        return None
    return output_path, payload


def cached_source_matches(cached_source: object, input_path: Path) -> bool:
    if not cached_source:
        return False
    cached_path = Path(str(cached_source))
    if not cached_path.is_absolute():
        cached_path = PROJECT_ROOT / cached_path
    try:
        return cached_path.resolve() == input_path.resolve()
    except OSError:
        return str(cached_source) == str(input_path)


def export_analysis_to_json_worker_cached(
    input_path: Path,
    *,
    mode: str,
    output_path: Path,
    tolerance_cart: float,
    indent: int,
    timeout_sec: float | None = None,
) -> tuple[Path, dict | None]:
    cached = cached_export_json_path(input_path, output_path, mode=mode)
    if cached is not None:
        return cached
    exported_path = export_analysis_to_json_worker(
        input_path,
        mode=mode,
        output_path=output_path,
        tolerance_cart=tolerance_cart,
        indent=indent,
        timeout_sec=timeout_sec,
    )
    return exported_path, None


def export_cell_setting_json_worker(
    base_payload: dict,
    *,
    cell_setting: str,
    tolerance_cart: float,
    indent: int,
    timeout_sec: float | None = None,
    require_distinct: bool = False,
    include_frame_witness: bool = False,
) -> dict:
    with tempfile.NamedTemporaryFile(
        mode="w",
        suffix=".json",
        prefix="symmetry_view_cell_base_",
        dir=tempfile.gettempdir(),
        encoding="utf-8",
        delete=False,
    ) as base_file:
        json.dump(base_payload, base_file, ensure_ascii=False)
        base_path = Path(base_file.name)
    output_path = Path(tempfile.gettempdir()) / f"symmetry_view_cell_setting_{time.monotonic_ns()}.json"
    command = [
        *worker_command("export_cell_setting_json.py"),
        "--legacy-contract",
        str(base_path),
        "--cell-setting",
        cell_setting,
        "--output",
        str(output_path),
        "--tolerance-cart",
        str(tolerance_cart),
        "--indent",
        str(indent),
    ]
    if require_distinct:
        command.append("--require-distinct")
    if include_frame_witness:
        command.append("--include-frame-witness")
    try:
        try:
            result = subprocess.run(
                command,
                check=False,
                capture_output=True,
                text=True,
                timeout=timeout_sec,
            )
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError(
                f"cell setting conversion timed out after {timeout_sec:g} seconds"
            ) from exc
        if result.returncode != 0:
            message = (result.stderr or result.stdout or "").strip()
            raise RuntimeError(message or f"cell setting worker failed with exit code {result.returncode}")
        return json.loads(output_path.read_text(encoding="utf-8"))
    finally:
        for path in (base_path, output_path):
            try:
                path.unlink()
            except FileNotFoundError:
                pass


def import_status_with_warnings(import_status: str, payload: dict) -> str:
    metadata = (payload.get("render_data") or {}).get("metadata") or {}
    warnings = [str(item) for item in metadata.get("warnings") or [] if str(item)]
    if not warnings:
        return import_status
    return f"{import_status}; warning: {' | '.join(warnings)}"


def resolve_viewer_json_path(
    input_path: Path,
    *,
    json_output: Path | None,
    json_dir: Path,
    tolerance_cart: float,
    indent: int,
) -> Path:
    if not input_path.exists():
        raise FileNotFoundError(f"Input file not found: {input_path}")

    suffix = input_path.suffix.lower()
    if suffix == ".json":
        if json_output is not None:
            raise ValueError("--json-output can only be used when the input is a CIF or XYZ file.")
        return input_path

    if suffix == ".cif":
        output_path = (
            json_output
            if json_output is not None
            else default_json_output_path(input_path, json_dir)
        )
        if json_output is None:
            cached = cached_export_json_path(input_path, output_path, mode=SOURCE_KIND_CRYSTAL)
            if cached is not None:
                cached_path, _ = cached
                print(f"Using cached JSON: {cached_path}", flush=True)
                return cached_path
        print(f"Analyzing CIF: {input_path}", flush=True)
        output_path = export_analysis_to_json(
            input_path,
            mode=SOURCE_KIND_CRYSTAL,
            output_path=output_path,
            tolerance_cart=tolerance_cart,
            indent=indent,
        )
        print(f"Wrote JSON: {output_path}", flush=True)
        return output_path

    if suffix == ".xyz":
        output_path = (
            json_output
            if json_output is not None
            else default_json_output_path(input_path, json_dir)
        )
        if json_output is None:
            cached = cached_export_json_path(input_path, output_path, mode=SOURCE_KIND_MOLECULE)
            if cached is not None:
                cached_path, _ = cached
                print(f"Using cached JSON: {cached_path}", flush=True)
                return cached_path
        print(f"Analyzing molecule: {input_path}", flush=True)
        output_path = export_analysis_to_json(
            input_path,
            mode=SOURCE_KIND_MOLECULE,
            output_path=output_path,
            tolerance_cart=tolerance_cart,
            indent=indent,
        )
        print(f"Wrote JSON: {output_path}", flush=True)
        return output_path

    raise ValueError(f"Unsupported input file type: {input_path.suffix}. Use .json, .cif, or .xyz.")


def build_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Web symmetry viewer for exported JSON, CIF, or XYZ structures."
    )
    parser.add_argument(
        "input_path",
        type=Path,
        nargs="?",
        help="Exported JSON, or a CIF/XYZ file to analyze for the shared model.",
    )
    parser.add_argument("--operation", type=int, default=None, help="Initial operation index.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument(
        "--port",
        type=int,
        default=0,
        help="HTTP port. Defaults to an automatically selected free port.",
    )
    parser.add_argument("--no-browser", action="store_true", help="Do not open the browser automatically.")
    parser.add_argument(
        "--mode",
        choices=("analysis", "puzzle"),
        default=None,
        help="Open directly in this mode. Default: show the Analysis/Puzzle selection screen.",
    )
    view_backend = parser.add_mutually_exclusive_group()
    view_backend.add_argument(
        "--with-pyvista",
        dest="pyvista_enabled",
        action="store_true",
        help="Also open the legacy PyVista comparison window and enable legacy GIF export.",
    )
    view_backend.add_argument(
        "--web-only",
        dest="pyvista_enabled",
        action="store_false",
        help="Run only the Web viewer (default; retained for command compatibility).",
    )
    parser.set_defaults(pyvista_enabled=False)
    parser.add_argument(
        "--json-output",
        type=Path,
        default=None,
        help="Where to write the generated JSON when input_path is a CIF or XYZ file.",
    )
    parser.add_argument(
        "--json-dir",
        type=Path,
        default=DEFAULT_JSON_EXPORT_DIR,
        help="Directory for generated JSON when input_path is a CIF or XYZ file and --json-output is not set.",
    )
    parser.add_argument(
        "--import-json-dir",
        type=Path,
        default=DEFAULT_BROWSER_IMPORT_JSON_DIR,
        help="Directory for JSON generated by browser Open CIF/Open XYZ imports.",
    )
    parser.add_argument(
        "--tolerance-cart",
        type=float,
        default=1e-2,
        help="Atom mapping tolerance in Angstrom for generated CIF/XYZ exports.",
    )
    parser.add_argument(
        "--indent",
        type=int,
        default=2,
        help="JSON indentation for generated CIF/XYZ exports.",
    )
    parser.add_argument(
        "--analysis-timeout-sec",
        type=float,
        default=DEFAULT_ANALYSIS_TIMEOUT_SEC,
        help="Maximum seconds to wait for browser CIF/XYZ import analysis.",
    )
    parser.add_argument(
        "--expanded",
        action="store_true",
        help="Show quarter-cell periodic display clones. Slower, but useful for boundary checks.",
    )
    return parser


def main() -> int:
    args = build_argument_parser().parse_args()

    input_path = args.input_path if args.input_path is not None else write_empty_viewer_json()
    if input_path.suffix.lower() in (".cif", ".xyz") and args.json_output is None:
        json_path = input_path
        worker = prepare_crystal_input_worker if input_path.suffix.lower() == ".cif" else prepare_molecule_input_worker
        payload = worker(input_path, timeout_sec=args.analysis_timeout_sec)
    else:
        # Explicit full-JSON export retains its CLI contract.
        json_path = resolve_viewer_json_path(
            input_path, json_output=args.json_output, json_dir=args.json_dir,
            tolerance_cart=args.tolerance_cart, indent=args.indent)
        payload = json.loads(json_path.read_text(encoding="utf-8"))
    display_mode = "expanded_quarter" if args.expanded else "source"
    # The legacy host is reserved for explicit API1 compatibility. Analysis, including native,
    # does not prepare legacy summaries, mappings or paths from its source input.
    legacy_payload = empty_viewer_payload()
    session = ViewerSession(json_path, legacy_payload)

    state_lock = threading.Lock()
    shared_state = initial_render_state(
        legacy_payload,
        initial_operation=args.operation,
        display_mode=display_mode,
    )
    shared_state["reset"] = False
    shared_state["reload_request_id"] = 0
    shared_state["json_path"] = str(json_path)
    shared_state["pyvista_enabled"] = args.pyvista_enabled

    from crystal_viewer.viewer.api2 import API2
    from crystal_viewer.viewer.model_session import ModelSession
    from crystal_viewer.viewer.model_loading import ModelLoads
    from crystal_viewer.viewer.model_view import ModelView
    models = ModelSession(cell_representatives=True)
    api2 = API2(models)
    model_view = ModelView(api2, sys.modules[__name__], display_mode=display_mode,
                          initial_operation=args.operation, pyvista_enabled=args.pyvista_enabled)
    model_loads = ModelLoads(models, analysis_context={"host": "normal_http", "historical_analysis_conditions": "unknown"},
        mapping_tolerance_A=.1, operation_match_tolerance=.01, model_view=model_view)
    if payload.get("structure_loaded", True) and payload["render_data"]["atoms"]:
        try:
            model_loads.load(lambda: (json_path, payload), provenance={"entrypoint": "startup_json"})
        except ValueError as exc:
            model_view.state["import_status"] = str(exc)
            print(f"Model preparation failed: {exc}", file=sys.stderr)

    handler = make_handler(
        session,
        shared_state,
        state_lock,
        json_dir=args.json_dir,
        import_json_dir=args.import_json_dir,
        tolerance_cart=args.tolerance_cart,
        indent=args.indent,
        analysis_timeout_sec=args.analysis_timeout_sec,
        default_display_mode=display_mode,
        initial_app_mode=args.mode or "select",
        api2=api2, model_loads=model_loads, model_view=model_view,
    )
    example_catalog()
    server = start_server(args.host, args.port, handler)
    url = f"http://{args.host}:{server.server_port}/"
    # Flushed so a launcher or test reading this through a pipe sees it now.
    print(f"Control panel: {url}", flush=True)
    if not args.no_browser:
        open_url(url)

    try:
        if args.pyvista_enabled:
            try:
                from crystal_viewer.viewer.model_pyvista import ModelPyVistaViewer
            except ImportError as exc:
                # PyVista is an optional extra, so --with-pyvista is the one flag
                # that can fail on an otherwise complete install.
                print(
                    f"--with-pyvista needs the optional PyVista renderer, which is not installed ({exc}).\n"
                    "Install it with:\n"
                    "  .venv/bin/python -m pip install -r requirements-pyvista.txt\n"
                    "The Web viewer at the URL above works without it.",
                    file=sys.stderr,
                )
                return 1

            app = ModelPyVistaViewer(model_view)
            app.show()
        else:
            while True:
                time.sleep(0.5)
    except KeyboardInterrupt:
        pass
    finally:
        server.shutdown()
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
