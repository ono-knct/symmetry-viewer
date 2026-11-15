"""Explicit standard-setting witnesses for a source analysis conversion.

Conversion steps or two analyzer datasets supply frame candidates.
A Hall number alone does not identify a common standard atomic origin.
No atom/operation is selected as an origin landmark. This
is provenance, not proof that two reconstructed models are equivalent; the
whole-model correspondence validator makes that separate decision.
"""
from copy import deepcopy

import numpy as np

from crystal_viewer.symmetry_model import PreparationError
from crystal_viewer.viewer.cell_setting_cache import payload_digest

FRAME_FIELD = "model_frame_change"


def target_digest(payload):
    copy = deepcopy(payload)
    copy["render_data"].setdefault("metadata", {}).pop(FRAME_FIELD, None)
    return payload_digest(copy)


def attach_frame_witness(source, target, *, symprec, angle_tolerance, cell_setting=None, source_analyzer=None):
    # Keep the analysis dependency out of runtime model/session imports.
    from pymatgen.symmetry.analyzer import SpacegroupAnalyzer
    from crystal_viewer.viewer.cell_settings import _structure_from_render_data
    result = dict(version=1, source_digest=payload_digest(source), target_digest=target_digest(target),
                  symprec_A=symprec, angle_tolerance_deg=angle_tolerance,
                  provenance="two analyzer transformations to one Hall setting")
    try:
        if cell_setting == "native":
            # Native is a copy, not a second standardization with a potentially
            # different choice among allowed standard origins.
            result.update(status="available", provenance="native copy", basis=np.eye(3).tolist(),
                          origin=[0., 0., 0.], cartesian_rotation=np.eye(3).tolist())
            target["render_data"].setdefault("metadata", {})[FRAME_FIELD] = result
            return target
        analyzers = [source_analyzer if source_analyzer is not None else SpacegroupAnalyzer(
            _structure_from_render_data(source["render_data"]), symprec=symprec, angle_tolerance=angle_tolerance),
            SpacegroupAnalyzer(_structure_from_render_data(target["render_data"]),
                               symprec=symprec, angle_tolerance=angle_tolerance)]
        datasets = [analyzer.get_symmetry_dataset() for analyzer in analyzers]
        a, b = datasets
        if analyzers[0].get_lattice_type() == "cubic" and cell_setting in ("primitive", "conventional"):
            # Pymatgen's cubic conventional conversion sorts the refined axes,
            # then replaces the lattice by the corresponding orthorhombic one.
            # Its primitive conversion changes basis at fixed Cartesian sites.
            # Trace those zero-origin steps from ONE source dataset: reanalyzing
            # the target can choose a different standard motif (e.g. diamond).
            refined = analyzers[0].get_refined_structure()
            if np.max(abs(refined.lattice.matrix-a.std_lattice)) > 1e-9:
                raise PreparationError("refined lattice differs from source standard frame")
            axes = sorted(range(3), key=lambda i: refined.lattice.abc[i])
            C = np.eye(3)[axes].T
            conventional = analyzers[0].get_conventional_standard_structure()
            F = (analyzers[0].get_conventional_to_primitive_transformation_matrix().T
                 if cell_setting == "primitive" else np.eye(3))
            P = np.linalg.solve(a.transformation_matrix, C@F)
            o = np.linalg.solve(a.transformation_matrix, -a.origin_shift)
            R = a.std_lattice.T@C@np.linalg.inv(conventional.lattice.matrix.T)
            Q = a.std_rotation_matrix.T@R
            result.update(provenance="source standardization and cubic conversion steps",
                          refined_to_conventional_basis=C.tolist(), conventional_to_target_basis=F.tolist())
        else:
            if a.hall_number != b.hall_number:
                raise PreparationError("source and target use different Hall settings")
            P = np.linalg.solve(a.transformation_matrix, b.transformation_matrix)
            o = np.linalg.solve(a.transformation_matrix, b.origin_shift-a.origin_shift)
            Q = a.std_rotation_matrix.T @ b.std_rotation_matrix
        if not all(np.all(np.isfinite(value)) for value in (P, o, Q)):
            raise PreparationError("non-finite analyzer frame")
        result.update(status="available", basis=P.tolist(), origin=o.tolist(), cartesian_rotation=Q.tolist(),
            hall_number=int(a.hall_number),
            source_to_standard=dict(matrix=a.transformation_matrix.tolist(), origin=a.origin_shift.tolist(),
                                    cartesian_rotation=a.std_rotation_matrix.tolist()),
            target_to_standard=dict(matrix=b.transformation_matrix.tolist(), origin=b.origin_shift.tolist(),
                                    cartesian_rotation=b.std_rotation_matrix.tolist()))
    except (ValueError, AttributeError, np.linalg.LinAlgError) as exc:
        result.update(status="unavailable", reason=str(exc))
    target["render_data"].setdefault("metadata", {})[FRAME_FIELD] = result
    return target


def read_frame_witness(source, target):
    value = target["render_data"].get("metadata", {}).get(FRAME_FIELD)
    if value is None:
        return None
    if not isinstance(value, dict) or value.get("status") not in ("available", "unavailable"):
        raise PreparationError("invalid explicit cell frame witness status")
    if (value.get("version") != 1 or value.get("source_digest") != payload_digest(source)
            or value.get("target_digest") != target_digest(target)):
        raise PreparationError("cell frame witness does not belong to this input/output")
    if value.get("status") == "unavailable":
        return None
    try:
        P, o, Q = (np.asarray(value[key], dtype=float) for key in ("basis", "origin", "cartesian_rotation"))
    except (KeyError, TypeError, ValueError, OverflowError) as exc:
        raise PreparationError("invalid explicit cell frame witness") from exc
    if (P.shape != (3, 3) or o.shape != (3,) or Q.shape != (3, 3) or
            not all(np.all(np.isfinite(item)) for item in (P, o, Q)) or
            abs(np.linalg.det(P)) < 1e-12 or np.max(abs(Q.T@Q-np.eye(3))) > 1e-9 or np.linalg.det(Q) < 0):
        raise PreparationError("invalid explicit cell frame witness")
    return dict(basis=P.tolist(), origin=o.tolist(), cartesian_rotation=Q.tolist())
