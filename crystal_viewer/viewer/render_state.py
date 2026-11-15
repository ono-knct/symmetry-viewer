from __future__ import annotations

from crystal_viewer.source_kinds import SOURCE_KIND_CRYSTAL, normalize_source_kind
from crystal_viewer.viewer.cell_basis import cell_basis_info


STATE_UPDATE_KEYS = frozenset(
    {
        "operation_index",
        "playing",
        "reset",
        "selected_atoms",
        "element_colors",
        "atom_colors",
        "element_hidden",
        "atom_hidden",
        "speed",
        "projection_mode",
        "background_mode",
        "legend_visible",
        "cell_origin_mode",
        "cell_setting_mode",
        "improper_mode",
        "display_mode",
        "include_boundary_images",
        "pause_at_breakpoints",
        "show_trajectories",
        "range_highlight",
        "active_mode",
        "scope",
        "view_request_id",
        "reset_view_request_id",
        "view_direction_request_id",
        "view_direction_frac",
        "view_plane_request_id",
        "view_plane_hkl",
        "camera_request_id",
        "camera_direction",
        "camera_angle",
        "custom_op_check_id",
        "clear_custom_check",
        "custom_op_animate",
        "operation_repetitions",
        "reload_request_id",
        "import_status",
    }
)

# Preferences retained when the same structure is rebuilt in another cell
# basis. Keep this list as the single source of truth for that transition.
PRESERVED_STATE_KEYS = (
    "speed",
    "projection_mode",
    "background_mode",
    "legend_visible",
    "cell_origin_mode",
    "cell_setting_mode",
    "improper_mode",
    "display_mode",
    "include_boundary_images",
    "pause_at_breakpoints",
    "show_trajectories",
)


def preserved_render_state(state: dict) -> dict:
    return {key: state[key] for key in PRESERVED_STATE_KEYS if key in state}


def initial_render_state(
    payload: dict,
    *,
    initial_operation: int | None,
    display_mode: str,
    preserved: dict | None = None,
) -> dict:
    preserved = preserved or {}
    render_data = payload["render_data"]
    operations = render_data["operations"]
    first_operation = operations[0]["index"] if operations else 0
    selected_operation = (
        initial_operation
        if initial_operation is not None and operation_exists(operations, initial_operation)
        else first_operation
    )
    selected_atoms = [atom["index"] for atom in render_data["atoms"]]
    source_kind = normalize_source_kind(
        payload.get(
            "source_kind",
            render_data.get("metadata", {}).get("mode", SOURCE_KIND_CRYSTAL),
        )
    )
    improper_mode = preserved.get("improper_mode", "default")
    if improper_mode not in ("default", "rotoinversion", "rotoreflection"):
        improper_mode = "default"
    return {
        "operation_index": selected_operation,
        "playing": False,
        "reset": True,
        "source_kind": source_kind,
        "structure_loaded": bool(payload.get("structure_loaded", True)),
        "metadata": render_data.get("metadata", {}),
        "cell_basis": cell_basis_info(render_data),
        "scope": "displayed",
        "selected_atoms": selected_atoms,
        "element_colors": {},
        "atom_colors": {},
        "element_hidden": {},
        "atom_hidden": {},
        "speed": float(preserved.get("speed", 1.0)),
        "projection_mode": preserved.get("projection_mode", "perspective"),
        # Analysis is a field-work surface, not a terminal: start with the
        # same soft light ground as the browser workspace.  A preserved
        # setting is still honoured for old sessions and the optional native
        # viewer.
        "background_mode": preserved.get("background_mode", "light"),
        "legend_visible": bool(preserved.get("legend_visible", True)),
        "cell_origin_mode": preserved.get("cell_origin_mode", "corner"),
        "cell_setting_mode": preserved.get("cell_setting_mode", "native"),
        "cell_placement": "initial",
        "cell_placement_atom": None,
        "cell_placement_target": None,
        "cell_origin_frac": [0.0, 0.0, 0.0],
        "improper_mode": improper_mode,
        "display_mode": preserved.get("display_mode", display_mode),
        "include_boundary_images": bool(preserved.get("include_boundary_images", True)),
        "pause_at_breakpoints": bool(preserved.get("pause_at_breakpoints", False)),
        "show_trajectories": bool(preserved.get("show_trajectories", False)),
        "range_highlight": False,
        "active_mode": "standard",
        "status_message": "",
        "view_request_id": None,
        "reset_view_request_id": None,
        "view_direction_request_id": None,
        "view_direction_frac": None,
        "view_plane_request_id": None,
        "view_plane_hkl": None,
        "camera_request_id": None,
        "camera_direction": "",
        "camera_angle": 90.0,
        "custom_op_check_id": None,
        "custom_op_result": None,
        "custom_op_animate": None,
        "operation_repetitions": 1,
        "reload_request_id": preserved.get("reload_request_id"),
        "import_status": preserved.get("import_status", ""),
        "import_in_progress": False,
        "json_path": str(preserved.get("json_path", "")),
        "summaries_ready": True,
        "pyvista_enabled": bool(preserved.get("pyvista_enabled", False)),
    }


def operation_exists(operations: list[dict], operation_index: int) -> bool:
    return any(operation["index"] == operation_index for operation in operations)


def apply_render_state_update(state: dict, update: dict) -> None:
    for key, value in update.items():
        if key in STATE_UPDATE_KEYS:
            state[key] = value
