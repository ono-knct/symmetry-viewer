"""Identify the displayed cell without changing its basis or atom positions."""
from __future__ import annotations

from itertools import permutations, product

import numpy as np


def cell_basis_info(render_data: dict) -> dict:
    if not render_data.get("unit_cell") or not render_data.get("atoms"):
        return {"mode": "unknown", "equivalent": False}
    try:
        from pymatgen.symmetry.analyzer import SpacegroupAnalyzer
        from crystal_viewer.viewer.cell_settings import _structure_from_render_data

        structure = _structure_from_render_data(render_data)
        analyzer = SpacegroupAnalyzer(structure, symprec=1e-3, angle_tolerance=5.0)
        primitive = analyzer.get_primitive_standard_structure()
        conventional = analyzer.get_conventional_standard_structure()
        return compare_cell_bases(
            render_data,
            primitive.lattice.matrix, len(primitive),
            conventional.lattice.matrix, len(conventional),
        )
    except Exception:
        # An unavailable/failed analysis must not prevent loading a structure.
        return {"mode": "unknown", "equivalent": False}


def compare_cell_bases(render_data, primitive_lattice, primitive_count,
                       conventional_lattice, conventional_count) -> dict:
    lattice = np.asarray(render_data["unit_cell"]["lattice"], dtype=float)
    primitive = np.asarray(primitive_lattice, dtype=float)
    conventional = np.asarray(conventional_lattice, dtype=float)
    count = len(render_data["atoms"])
    volume = abs(float(np.linalg.det(lattice)))
    primitive_volume = abs(float(np.linalg.det(primitive)))
    conventional_volume = abs(float(np.linalg.det(conventional)))
    same_volume = lambda a, b: bool(np.isclose(a, b, rtol=1e-4, atol=1e-6))
    equivalent = primitive_count == conventional_count and same_volume(primitive_volume, conventional_volume)
    mode = "other"
    # A conventional-volume supercell or sheared cell need not be Bravais.
    # Compare shapes independently of Cartesian rotation, axis order and sign.
    if count == conventional_count and same_volume(volume, conventional_volume):
        gram = lattice @ lattice.T
        reference = conventional @ conventional.T
        for order in permutations(range(3)):
            for signs in product((-1, 1), repeat=3):
                transform = np.diag(signs) @ np.eye(3)[list(order)]
                if np.allclose(gram, transform @ reference @ transform.T, rtol=1e-4, atol=1e-5):
                    return {"mode": "conventional", "equivalent": equivalent}
    # Any lattice basis with the primitive volume is a valid primitive cell.
    if count == primitive_count and same_volume(volume, primitive_volume):
        mode = "primitive"
    return {"mode": mode, "equivalent": equivalent}
