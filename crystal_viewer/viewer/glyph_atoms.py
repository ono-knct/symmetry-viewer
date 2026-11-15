from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pyvista as pv

from crystal_viewer.viewer.atom_instances import ElementInstanceBatch
from crystal_viewer.viewer.atom_style import display_atom_radius


@dataclass(frozen=True)
class ElementGlyphPreview:
    element: str
    atomic_number: int
    point_count: int
    glyph_point_count: int
    glyph_cell_count: int
    point_cloud: pv.PolyData
    glyph_mesh: pv.PolyData


def build_element_glyph_preview(
    batch: ElementInstanceBatch,
    render_data: dict,
    *,
    theta_resolution: int = 16,
    phi_resolution: int = 10,
) -> ElementGlyphPreview:
    atom = {
        "atomic_number": batch.atomic_number,
        "element": batch.element,
    }
    radius = display_atom_radius(atom, render_data)
    sphere = pv.Sphere(
        radius=radius,
        center=(0.0, 0.0, 0.0),
        theta_resolution=theta_resolution,
        phi_resolution=phi_resolution,
    )
    point_cloud = pv.PolyData(batch.positions.copy())
    glyph_mesh = point_cloud.glyph(geom=sphere, scale=False, orient=False)
    return ElementGlyphPreview(
        element=batch.element,
        atomic_number=batch.atomic_number,
        point_count=point_cloud.n_points,
        glyph_point_count=glyph_mesh.n_points,
        glyph_cell_count=glyph_mesh.n_cells,
        point_cloud=point_cloud,
        glyph_mesh=glyph_mesh,
    )
