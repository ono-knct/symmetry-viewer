"""Cell placement in the current basis, without reanalysis or operation reordering."""
from __future__ import annotations

from copy import deepcopy

import numpy as np


FACE_CENTERS = (
    ("face_ab", "C", [0.5, 0.5, 0.0]),
    ("face_ac", "B", [0.5, 0.0, 0.5]),
    ("face_bc", "A", [0.0, 0.5, 0.5]),
)


def placement_choices(render_data: dict, atom_index: int) -> list[dict]:
    """Merge faces only under cell-preserving operations of the selected site.

    A signed permutation preserves this basis parallelepiped. General fractional
    rotations (e.g. a hexagonal 60-degree rotation) need not preserve that cell.
    Opposite faces are represented by the basis planes through the origin.
    """
    atom = next(a for a in render_data["atoms"] if a["index"] == atom_index)
    site = np.asarray(atom["frac"], dtype=float)
    parent = list(range(3))

    def root(i):
        while parent[i] != i:
            i = parent[i]
        return i

    normals = (2, 1, 0)  # ab, ac, bc
    for op in render_data["operations"]:
        W = np.asarray(op["matrix_frac"], dtype=float)
        t = np.asarray(op["translation_frac"], dtype=float)
        delta = W @ site + t - site
        absolute = np.abs(W)
        if not (np.allclose(delta, np.rint(delta), atol=1e-7, rtol=0)
                and np.allclose(absolute, np.rint(absolute), atol=1e-7, rtol=0)
                and np.allclose(absolute.sum(axis=0), 1, atol=1e-7, rtol=0)
                and np.allclose(absolute.sum(axis=1), 1, atol=1e-7, rtol=0)):
            continue
        for i, normal in enumerate(normals):
            j = normals.index(int(np.argmax(absolute[:, normal])))
            parent[root(j)] = root(i)
    groups = {}
    for i in range(3):
        groups.setdefault(root(i), []).append(i)
    faces = []
    for group in sorted(groups.values(), key=lambda items: items[0]):
        key, _, target = FACE_CENTERS[group[0]]
        faces.append({"key": key,
                      "label": "Face" if len(group) == 3 else f"Face ({FACE_CENTERS[group[0]][1]})",
                      "target": target,
                      "members": [FACE_CENTERS[i][0] for i in group]})
    return [
        {"key": "initial", "label": "Initial", "target": None},
        {"key": "center", "label": "Center", "target": [0.5, 0.5, 0.5]},
        {"key": "corner", "label": "Corner", "target": [0.0, 0.0, 0.0]},
        *faces,
        {"key": "custom", "label": "Coordinates", "target": None},
    ]


def translated_payload(payload: dict, origin_frac) -> dict:
    """Express the same operations and geometry in x_new = x_old - origin.

    Source coordinates stay unwrapped so mapping entries retain their periodic
    branches. Display instances alone choose images in the 0..1 cell. Translation
    parts are never reduced modulo the lattice; accumulated translations matter.
    The reference cell vertices describe the new basis cell, not the old cell.
    """
    shifted = deepcopy(payload)
    data = shifted["render_data"]
    origin = np.asarray(origin_frac, dtype=float)
    if origin.shape != (3,) or not np.all(np.isfinite(origin)):
        raise ValueError("Origin must contain three finite coordinates")
    cart = origin @ np.asarray(data["unit_cell"]["lattice"], dtype=float)
    data.setdefault("metadata", {})["display_origin_frac"] = origin.tolist()
    for key in ("atoms", "asymmetric_atoms"):
        for atom in data.get(key, []):
            atom["frac"] = (np.asarray(atom["frac"]) - origin).tolist()
            atom["cart"] = (np.asarray(atom["cart"]) - cart).tolist()
    for op in data["operations"]:
        for space, offset in (("frac", origin), ("cart", cart)):
            W = np.asarray(op["matrix_" + space])
            op["translation_" + space] = (
                np.asarray(op["translation_" + space]) + W @ offset - offset
            ).tolist()
    for key in ("axes", "planes", "centers"):
        for element in data.get(key, []):
            element["point_cart"] = (np.asarray(element["point_cart"]) - cart).tolist()
    for key in ("bounds_min", "bounds_max"):
        if data.get(key) is not None:
            data[key] = (np.asarray(data[key]) - cart).tolist()
    for mapping in (shifted.get("atom_mappings") or {}).get("mappings", []):
        for entry in mapping["entries"]:
            for key in ("transformed_frac", "wrapped_frac", "animation_frac"):
                if entry.get(key) is not None:
                    entry[key] = (np.asarray(entry[key]) - origin).tolist()
            if entry.get("transformed_cart") is not None:
                entry["transformed_cart"] = (np.asarray(entry["transformed_cart"]) - cart).tolist()
    return shifted
