from __future__ import annotations

from typing import Any

import numpy as np

from crystal_viewer.geometry import rotation_axis_sin_component
from crystal_viewer.json_export import to_jsonable
from crystal_viewer.source_kinds import SOURCE_KIND_MOLECULE, normalize_source_kind
from crystal_viewer.viewer.animation_context import animation_paths, display_equivalent_operation_context, select_animation_context
from crystal_viewer.viewer.custom_animation import build_custom_animation_paths, build_sequence_paths
from crystal_viewer.viewer.animation_path import (
    decomposition_elements,
    improper_rotation_angle,
    maximum_travel_distance,
    normalized_animation_duration_seconds,
)
from crystal_viewer.viewer.display_atoms import display_atom_instances, display_scene_span
from crystal_viewer.viewer.operation_lookup import operation_by_index, selected_mapping
from crystal_viewer.viewer.operation_labels import (
    is_pure_translation_operation,
    operation_focus_point_cart,
    operation_notation_order,
    operation_view_direction_cart,
    visual_translation_direction_cart,
)
from crystal_viewer.viewer.symmetry_elements import display_symmetry_elements, glide_translation_cart


ANIMATION_PATH_SCHEMA_VERSION = 1
ANIMATION_COORDINATE_SPACE = "cartesian"
CRYSTAL_PERIODIC_IMAGE_POLICY = "transform_with_source"
MOLECULE_PERIODIC_IMAGE_POLICY = "not_applicable"


def animation_path_response(
    render_data: dict,
    atom_mappings: dict | None,
    operation_index: int,
    *,
    scope: str = "displayed",
    selected_atoms: tuple[int, ...] = (),
    improper_mode: str = "auto",
    display_mode: str = "source",
    cell_origin_mode: str = "center",
    include_boundary_images: bool = False,
    repetitions: int = 1,
) -> dict[str, Any]:
    repetitions = int(repetitions)
    if not 1 <= repetitions <= 120:
        raise ValueError("Repetitions must be between 1 and 120")
    operation = operation_by_index(render_data.get("operations", []), operation_index)
    if operation is None:
        raise ValueError(f"Operation index not found: {operation_index}")
    mapping = selected_mapping(atom_mappings, operation_index)
    if mapping is None:
        raise ValueError(f"Atom mapping not found for operation: {operation_index}")

    source_kind = normalize_source_kind(
        str((render_data.get("metadata") or {}).get("mode") or "crystal")
    )
    animation_scope, effective_selected_atoms, representative_atom, unit_cell_only = _scope_options(
        render_data,
        scope,
        selected_atoms,
    )
    paths = animation_paths(
        render_data,
        operation,
        mapping,
        animation_scope=animation_scope,
        representative_atom=representative_atom,
        selected_atoms=effective_selected_atoms,
        improper_mode=improper_mode,
        display_mode=display_mode,
        cell_origin_mode=cell_origin_mode,
    )
    if repetitions > 1:
        axis, plane, center, _, _, angle = select_animation_context(
            render_data, operation, mapping,
            {atom["index"]: atom for atom in render_data["atoms"]},
            representative_atom=representative_atom, element_index=None,
        )
        context = {"operation": operation, "axis": axis, "plane": plane, "center": center,
                   "matrix": np.asarray(operation["matrix_cart"]),
                   "translation": np.asarray(operation["translation_cart"]),
                   "angle_override": angle, "label": f"op {operation_index}"}
        paths = build_sequence_paths(render_data, paths.keys(), [context] * repetitions,
                                     unit_cell_only, improper_mode, align_affine_elements=True)
        # Each application has the same duration, including stationary atoms.
        for path in paths.values():
            path["segment_weights"] = [1] * repetitions
    entries_by_source = {
        int(entry["source_atom"]): entry
        for entry in mapping.get("entries", [])
    }
    items = []
    for source_atom, path in sorted(paths.items()):
        public_path = serialize_animation_path(path)
        if unit_cell_only:
            public_path["unit_cell_only"] = True
        entry = entries_by_source.get(int(source_atom), {})
        target_atom = entry.get("target_atom")
        for _ in range(repetitions - 1):
            target_atom = entries_by_source.get(target_atom, {}).get("target_atom")
        items.append(
            {
                "source_atom": int(source_atom),
                "target_atom": target_atom,
                "path": public_path,
            }
        )

    travel = maximum_travel_distance(
        render_data,
        paths,
        display_mode=display_mode,
        cell_origin_mode=cell_origin_mode,
        include_boundary_images=include_boundary_images,
        unit_cell_only=unit_cell_only,
    )

    if repetitions > 1:
        first_paths = {source: path["segments"][0] for source, path in paths.items()}
        first_travel = maximum_travel_distance(
            render_data, first_paths, display_mode=display_mode, cell_origin_mode=cell_origin_mode,
            include_boundary_images=include_boundary_images, unit_cell_only=unit_cell_only,
        )
    else:
        first_travel = travel
    return {
        "schema_version": ANIMATION_PATH_SCHEMA_VERSION,
        "source_kind": source_kind,
        "coordinate_space": ANIMATION_COORDINATE_SPACE,
        "periodic_image_policy": (
            MOLECULE_PERIODIC_IMAGE_POLICY
            if source_kind == SOURCE_KIND_MOLECULE
            else CRYSTAL_PERIODIC_IMAGE_POLICY
        ),
        "operation_index": int(operation_index),
        "repetitions": repetitions,
        "maximum_travel_distance": travel,
        "animation_duration_seconds": normalized_animation_duration_seconds(
            first_travel,
            display_scene_span(render_data, display_mode, cell_origin_mode),
        ) * repetitions,
        "boundary": {"mode": "continuous"},
        "scope": scope,
        "paths": items,
    }


def serialize_animation_path(path: dict) -> dict[str, Any]:
    """Convert an internal NumPy/radian path to the public JSON schema."""
    result = {}
    for key, value in path.items():
        if key == "angle":
            result["angle_deg"] = float(np.rad2deg(value))
        elif key == "segments":
            result[key] = [serialize_animation_path(segment) for segment in value]
        else:
            result[key] = to_jsonable(value)
    return result


def custom_animation_path_response(
    render_data: dict,
    atom_mappings: dict | None,
    request: dict,
    *,
    improper_mode: str = "auto",
    display_mode: str = "source",
    cell_origin_mode: str = "center",
    include_boundary_images: bool = False,
) -> dict[str, Any]:
    paths = build_custom_animation_paths(
        render_data, atom_mappings, request, improper_mode=improper_mode,
        display_mode=display_mode, cell_origin_mode=cell_origin_mode,
    )
    items = [{"source_atom": source, "path": serialize_animation_path(path)} for source, path in sorted(paths.items())]
    maximum = maximum_travel_distance(
        render_data,
        paths,
        display_mode=display_mode,
        cell_origin_mode=cell_origin_mode,
        include_boundary_images=include_boundary_images,
    )
    return {
        "schema_version": ANIMATION_PATH_SCHEMA_VERSION,
        "coordinate_space": ANIMATION_COORDINATE_SPACE,
        "animate_id": request.get("animate_id"),
        "maximum_travel_distance": maximum,
        "animation_duration_seconds": normalized_animation_duration_seconds(
            maximum, display_scene_span(render_data, display_mode, cell_origin_mode)
        ),
        "boundary": {"mode": "continuous"},
        "paths": items,
    }


_DIRECTIONAL_ROTATION_KINDS = ("rotation_", "screw_", "improper_", "rotoinversion", "rotoreflection")


def axis_rotation_sign(operation: dict, axis: dict | None) -> int | None:
    """+1/-1 sense of ``operation``'s rotation about ``axis``, or ``None``.

    Only order > 2 rotations (proper or improper) have a rotation sense a
    static picture can fail to convey — a 2-fold (or mirror/inversion, whose
    "order" is None) is its own inverse, so there is nothing to disambiguate.
    Read directly from ``axis["direction_cart"]`` (Cartesian, no lattice
    needed) so it works for molecules too, and stays consistent with whichever
    equivalent axis copy display selected — the arrow drawn from this axis's
    own direction is correct regardless of which parallel copy that is.

    Uses ``rotation_axis_sin_component`` rather than
    ``signed_rotation_angle_from_matrix`` because the latter's cos(theta) —
    read from the matrix trace — is wrong for an *improper* rotation (Sn):
    only the sign is needed here, and the sin-based component stays correct
    for both proper and improper operations (see its docstring).
    """
    if axis is None:
        return None
    kind = str(operation.get("kind", ""))
    if not kind.startswith(_DIRECTIONAL_ROTATION_KINDS):
        return None
    order = operation_notation_order(operation)
    if order is None or order <= 2:
        return None
    matrix_cart = operation.get("matrix_cart")
    if matrix_cart is None:
        return None
    direction = np.asarray(axis.get("direction_cart"), dtype=float)
    if direction.shape != (3,):
        return None
    sin_component = rotation_axis_sin_component(np.asarray(matrix_cart, dtype=float), direction)
    if abs(sin_component) < 1e-6:
        return None
    return 1 if sin_component > 0 else -1


def symmetry_elements_response(
    render_data: dict,
    atom_mappings: dict | None,
    operation_index: int,
    *,
    improper_mode: str = "auto",
    display_mode: str = "source",
    cell_origin_mode: str = "center",
) -> dict[str, Any]:
    operation = operation_by_index(render_data.get("operations", []), operation_index)
    if operation is None:
        raise ValueError(f"Operation index not found: {operation_index}")
    axes, planes, centers = display_symmetry_elements(
        render_data,
        atom_mappings,
        operation_index,
        None,
        improper_mode="auto",
    )
    mapping = selected_mapping(atom_mappings, operation_index)
    glide_translation = (
        glide_translation_cart(render_data, operation, planes[0], mapping=mapping)
        if planes and "glide" in str(operation.get("kind", ""))
        else None
    )
    _, axis, plane, center = display_equivalent_operation_context(
        render_data,
        operation,
        axes[0] if axes else None,
        planes[0] if planes else None,
        centers[0] if centers else None,
        display_mode,
        cell_origin_mode,
    )
    if improper_mode in ("rotoinversion", "rotoreflection"):
        axis, plane, center = decomposition_elements(operation, axis, plane, center, improper_mode, render_data)
        kind = str(operation.get("kind", ""))
        if kind in ("mirror", "inversion") or "glide" in kind or any(word in kind for word in ("improper", "roto")):
            if improper_mode == "rotoinversion":
                plane = None
                if kind == "inversion":
                    axis = None
            else:
                center = None
                if kind == "mirror" or "glide" in kind:
                    axis = None
    axes, planes, centers = ([axis] if axis is not None else [], [plane] if plane is not None else [], [center] if center is not None else [])
    view_direction = (
        visual_translation_direction_cart(render_data, operation, atom_mappings)
        if is_pure_translation_operation(operation)
        else None
    )
    if view_direction is None:
        view_direction = operation_view_direction_cart(render_data, operation, axes, planes, centers)
    focus_point = operation_focus_point_cart(
        render_data,
        operation,
        axes,
        planes,
        centers,
        display_mode,
        cell_origin_mode,
    )
    rotation_sign = axis_rotation_sign(operation, axis)
    if improper_mode in ("rotoinversion", "rotoreflection") and axis is not None and np.linalg.det(operation["matrix_cart"]) < 0:
        angle = improper_rotation_angle(operation, axis, improper_mode)
        rotation_sign = int(np.sign(angle)) if angle is not None and 1e-8 < abs(angle) < np.pi - 1e-8 else None
    axis_payload = {**axis, "rotation_sign": rotation_sign} if axis is not None else None
    return {
        "schema_version": ANIMATION_PATH_SCHEMA_VERSION,
        "coordinate_space": ANIMATION_COORDINATE_SPACE,
        "operation_index": int(operation_index),
        "axes": to_jsonable([axis_payload] if axis_payload is not None else []),
        "planes": to_jsonable([plane] if plane is not None else []),
        "centers": to_jsonable([center] if center is not None else []),
        "glide_translation_cart": to_jsonable(glide_translation),
        "view_direction_cart": to_jsonable(view_direction),
        "focus_point_cart": to_jsonable(focus_point),
    }


def _scope_options(
    render_data: dict,
    scope: str,
    selected_atoms: tuple[int, ...],
) -> tuple[str, tuple[int, ...], int | None, bool]:
    atom_indices = tuple(int(atom["index"]) for atom in render_data.get("atoms", []))
    effective_selected_atoms = tuple(int(index) for index in selected_atoms)
    animation_scope = scope
    unit_cell_only = scope in ("selected", "unit_cell", "representative")
    if scope in ("displayed", "unit_cell"):
        animation_scope = "selected"
        effective_selected_atoms = atom_indices
    elif scope == "selected_displayed":
        animation_scope = "selected"
    representative_atom = (
        effective_selected_atoms[0]
        if scope in ("selected", "selected_displayed") and effective_selected_atoms
        else None
    )
    return animation_scope, effective_selected_atoms, representative_atom, unit_cell_only
