from __future__ import annotations

import numpy as np

from crystal_viewer.viewer.animation_context import (
    animation_paths,
    select_animation_context,
    shared_step_translation,
)
from crystal_viewer.viewer.animation_path import (
    build_operation_path,
    effective_rotation_axis,
    evaluate_path,
    improper_inversion_center,
    improper_reflection_plane,
    normalize,
    preferred_improper_mode,
    render_source_kind,
)


def update_animated_atoms(
    animated_atoms: list[dict],
    paths: dict[int, dict],
    s: float,
) -> None:
    for item in animated_atoms:
        atom = item["atom"]
        path = paths.get(atom["index"])
        display_shift = item["display_shift_cart"]
        center = np.asarray(atom["cart"], dtype=float) + display_shift
        if path is not None and path_applies_to_display_item(path, item):
            center = evaluate_path(path, s, start_override=np.asarray(atom["cart"], dtype=float) + display_shift)
        previous = item.get("current_cart")
        item["position_dirty"] = previous is None or not np.allclose(previous, center, atol=1e-10, rtol=0.0)
        item["current_cart"] = center
        actor = item.get("actor")
        if actor is not None:
            actor.SetPosition(*center)

def path_applies_to_display_item(path: dict, item: dict) -> bool:
    if not path.get("unit_cell_only"):
        return True
    return bool(item.get("is_primary_image", False))
