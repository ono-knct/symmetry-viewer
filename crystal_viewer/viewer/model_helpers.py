"""Shared display adapters for HTTP, standalone GUI and verified export.

These functions replicate display atoms and styles; they do not classify or
factor symmetry operations. Historical empty UI data retains its own schema.
"""
import numpy as np
from crystal_viewer.json_export import EXPORT_SCHEMA_VERSION, to_jsonable
from crystal_viewer.source_kinds import SOURCE_KIND_EMPTY
from crystal_viewer.viewer.atom_style import atom_color, display_atom_radius
from crystal_viewer.viewer.operation_labels import atom_frac_label
from crystal_viewer.viewer.display_atoms import display_atom_instances, display_fractional_bounds, display_scene_center

CUSTOM_OPERATION_TOLERANCE_MIN = .001
CUSTOM_OPERATION_TOLERANCE_MAX = 2.

def custom_operation_tolerance(value: object) -> tuple[float | None, str | None]:
    """Parse the browser's Custom Operation tolerance without accepting NaN/Inf."""
    try:
        tolerance = float(value)
    except (TypeError, ValueError) as exc:
        return None, f"Tolerance must be a number: {exc}"
    if not np.isfinite(tolerance):
        return None, "Tolerance must be a finite number"
    if not CUSTOM_OPERATION_TOLERANCE_MIN <= tolerance <= CUSTOM_OPERATION_TOLERANCE_MAX:
        return None, (
            "Tolerance must be between "
            f"{CUSTOM_OPERATION_TOLERANCE_MIN:g} and {CUSTOM_OPERATION_TOLERANCE_MAX:g} Å"
        )
    return tolerance, None


def empty_viewer_payload() -> dict:
    return {
        "schema_version": EXPORT_SCHEMA_VERSION,
        "source_kind": SOURCE_KIND_EMPTY,
        "structure_loaded": False,
        "render_data": {
            "metadata": {
                "mode": SOURCE_KIND_EMPTY,
                "source_file": "",
                "formula": "No structure",
                "symmetry_label": "",
                "operation_count": 1,
            },
            "atoms": [],
            "asymmetric_atoms": [],
            "operations": [
                {
                    "index": 0,
                    "label": "0: load a structure",
                    "kind": "identity",
                    "order": 1,
                    "angle_deg": 0.0,
                    "symbol": "load",
                    "matrix_frac": None,
                    "translation_frac": None,
                    "matrix_cart": [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
                    "translation_cart": [0.0, 0.0, 0.0],
                }
            ],
            "axes": [],
            "planes": [],
            "centers": [],
            "unit_cell": None,
            "bounds_min": [0.0, 0.0, 0.0],
            "bounds_max": [1.0, 1.0, 1.0],
        },
        "atom_mappings": {
            "mode": SOURCE_KIND_EMPTY,
            "complete": True,
            "incomplete_operation_indices": [],
            "mappings": [
                {
                    "mode": SOURCE_KIND_EMPTY,
                    "operation_index": 0,
                    "operation_kind": "identity",
                    "complete": True,
                    "atom_to_atom": [],
                    "max_distance": 0.0,
                    "unmatched_atoms": [],
                    "entries": [],
                }
            ],
        },
    }


def atom_api_items(atoms: list[dict]) -> list[dict]:
    return [
        {
            "index": atom["index"],
            "element": atom["element"],
            "frac": atom.get("frac"),
            "frac_label": atom_frac_label(atom),
            "cart": atom.get("cart"),
            "asymmetric_index": atom.get("asymmetric_index"),
            "default_color": atom_color(atom),
        }
        for atom in atoms
    ]


def atom_render_style_items(
    render_data: dict,
    *,
    element_colors: dict | None = None,
    atom_colors: dict | None = None,
) -> list[dict]:
    return [
        {
            "index": int(atom["index"]),
            "color": atom_color(atom, element_colors=element_colors, atom_colors=atom_colors),
            "radius": display_atom_radius(atom, render_data),
        }
        for atom in render_data.get("atoms", [])
    ]


def display_atom_api_items(
    render_data: dict,
    *,
    display_mode: str,
    cell_origin_mode: str,
    include_boundary_images: bool = False,
    element_hidden: dict | None = None,
    atom_hidden: dict | None = None,
) -> list[dict]:
    items = []
    for instance_id, item in enumerate(
        display_atom_instances(
            render_data,
            display_mode=display_mode,
            cell_origin_mode=cell_origin_mode,
            include_boundary_images=include_boundary_images,
        )
    ):
        atom = item["atom"]
        if (element_hidden or {}).get(str(atom.get("element", ""))):
            continue
        if (atom_hidden or {}).get(str(atom.get("index", ""))):
            continue
        items.append(
            {
                "instance_id": instance_id,
                "source_atom": int(atom["index"]),
                "element": atom["element"],
                "atomic_number": int(atom["atomic_number"]),
                "cart": item["cart"],
                "frac": np.asarray(atom["frac"], dtype=float) + item["display_shift_frac"]
                if atom.get("frac") is not None else None,
                "display_shift_cart": item["display_shift_cart"],
                "is_primary_image": bool(item["is_primary_image"]),
            }
        )
    return items


def display_unit_cell_api_item(
    render_data: dict,
    *,
    display_mode: str,
    cell_origin_mode: str,
) -> dict | None:
    unit_cell = render_data.get("unit_cell")
    if unit_cell is None:
        return None
    lattice = np.asarray(unit_cell["lattice"], dtype=float)
    # Match the current PyVista browser view: Cell Range expands atom/symmetry
    # display context, but the drawn reference unit cell itself remains the
    # source cell.  Only the origin convention changes the cell placement.
    lower, _ = display_fractional_bounds("source", cell_origin_mode)
    shift = np.asarray([lower, lower, lower], dtype=float) @ lattice
    return {
        "vertices_cart": np.asarray(unit_cell["vertices_cart"], dtype=float) + shift,
        "edges": unit_cell["edges"],
    }


def update_view_coordinate_state(render_data: dict, state: dict, update: dict) -> None:
    """Attach Python-computed Cartesian camera inputs to shared browser state."""
    unit_cell = render_data.get("unit_cell")
    lattice = None if unit_cell is None else np.asarray(unit_cell["lattice"], dtype=float)

    def vector(key: str) -> np.ndarray:
        value = np.asarray(update.get(key), dtype=float)
        if value.shape != (3,) or not np.all(np.isfinite(value)):
            raise ValueError(f"{key} must contain three finite numbers")
        return value

    if "reset_view_request_id" in update:
        state["reset_view_center_cart"] = display_scene_center(
            render_data,
            str(state.get("display_mode", "source")),
            str(state.get("cell_origin_mode", "center")),
        ).tolist()
    if "view_direction_request_id" in update:
        if lattice is None:
            raise ValueError("direction indices require a crystal unit cell")
        direction = vector("view_direction_frac") @ lattice
        if np.linalg.norm(direction) < 1e-10:
            raise ValueError("view direction must not be zero")
        state["view_direction_cart"] = (direction / np.linalg.norm(direction)).tolist()
        state["indexed_view_center_cart"] = display_scene_center(
            render_data,
            str(state.get("display_mode", "source")),
            str(state.get("cell_origin_mode", "center")),
        ).tolist()
    if "view_plane_request_id" in update:
        if lattice is None:
            raise ValueError("Miller indices require a crystal unit cell")
        normal = np.linalg.inv(lattice) @ vector("view_plane_hkl")
        if np.linalg.norm(normal) < 1e-10:
            raise ValueError("plane normal must not be zero")
        state["view_plane_normal_cart"] = (normal / np.linalg.norm(normal)).tolist()
        state["indexed_view_center_cart"] = display_scene_center(
            render_data,
            str(state.get("display_mode", "source")),
            str(state.get("cell_origin_mode", "center")),
        ).tolist()

