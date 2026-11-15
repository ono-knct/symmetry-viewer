"""Analytic axial symmetry for linear molecules, with symbolic C-infinity.

The listed representatives need not close. Their products live in O(2) acting
transversely, times the optional axial reversal. All rotations fix the entire
reconstructed atomic line, independently of a sampling of rotation angles.
"""
from dataclasses import asdict, dataclass
import json

import numpy as np

from crystal_viewer.symmetry_model import (
    ModelCorrespondence, PreparationError, SymmetryModel, ValidationReport,
    _atom_action, _id, _json, _max, _tuple,
)


@dataclass(frozen=True)
class AxialElement:
    angle_rad: float
    transverse_reflection: bool = False
    axial_sign: int = 1

    def after(self, before):
        return AxialElement(self.angle_rad + (-1 if self.transverse_reflection else 1)*before.angle_rad,
                            self.transverse_reflection != before.transverse_reflection,
                            self.axial_sign*before.axial_sign)


@dataclass(frozen=True)
class AxialGroup:
    center: tuple
    direction: tuple
    transverse: tuple
    axial_reversal: bool
    elements: tuple  # None means an unresolved family, never an identity matrix
    family_operation_indices: tuple
    line_residual_A: float

    def components(self, angle_rad, transverse_reflection=False, axial_sign=1):
        if not np.isfinite(angle_rad) or axial_sign not in (-1, 1):
            raise PreparationError("invalid axial element")
        if axial_sign == -1 and not self.axial_reversal:
            raise PreparationError("axial reversal is not a symmetry of this model")
        n, q = np.array(self.direction), np.array(self.transverse)
        basis = np.column_stack((q, np.cross(n, q), n))
        c, s = np.cos(angle_rad), np.sin(angle_rad)
        local = np.array([[c, -s, 0], [s, c, 0], [0, 0, axial_sign]])
        if transverse_reflection:
            local[:, 1] *= -1
        matrix = basis @ local @ basis.T
        center = np.array(self.center)
        return matrix, center-matrix @ center


def prepare_linear_model(source, *, mapping_tolerance_A, residual_tolerance,
                         operation_match_tolerance):
    payload = json.loads(source.payload_json)
    data = payload.get("render_data", payload)
    if data.get("unit_cell"):
        raise PreparationError("continuous axial contract is molecular only")
    ops, atoms = data["operations"], data["atoms"]
    if any("infinite" in op.get("kind", "") and op["kind"] != "rotation_infinite" for op in ops):
        raise PreparationError("unsupported continuous family")
    indices = tuple(o["index"] for o in ops)
    atom_indices = tuple(a["index"] for a in atoms)
    if len(set(indices)) != len(indices) or len(set(atom_indices)) != len(atoms):
        raise PreparationError("duplicate atom/operation index")
    species = tuple(_json({k: v for k, v in a.items() if k in
                          ("element", "atomic_number", "occupancy", "species")}) for a in atoms)
    x = np.array([a["cart"] for a in atoms], dtype=float)
    if x.shape != (len(atoms), 3) or not np.all(np.isfinite(x)):
        raise PreparationError("invalid molecular positions")
    center = np.mean(x, axis=0)
    _, singular, vh = np.linalg.svd(x-center, full_matrices=False)
    if len(singular) == 0 or singular[0] <= residual_tolerance:
        raise PreparationError("atomic line is not uniquely determined")
    n = vh[0]
    if next(v for v in n if abs(v) > 1e-12) < 0:
        n = -n
    q = np.eye(3)[np.argmin(abs(n))]
    q = q-np.dot(n, q)*n
    q /= np.linalg.norm(q)
    basis = np.column_stack((q, np.cross(n, q), n))
    family = [i for i, o in enumerate(ops) if o.get("kind") == "rotation_infinite"]
    finite = [i for i in range(len(ops)) if i not in family]
    if not finite:
        raise PreparationError("linear representatives are missing")
    match = residual_tolerance if operation_match_tolerance is None else operation_match_tolerance
    axes = list(data.get("axes", []))
    for i in family:
        axis = ops[i].get("continuous_axis")
        if payload.get("model_input_version") is not None:
            if not isinstance(axis, dict) or "matrix_cart" in ops[i] or "translation_cart" in ops[i]:
                raise PreparationError("continuous family requires an explicit axis and no placeholder matrix")
            if not all(key in axis for key in ("point_cart", "direction_cart")):
                raise PreparationError("continuous family axis is incomplete")
        if axis is not None:
            axes.append(dict(axis, operation_indices=(indices[i],)))
    for axis in axes:
        if not set(axis.get("operation_indices", ())) & {indices[i] for i in family}:
            continue
        direction = np.array(axis["direction_cart"], dtype=float)
        point = np.array(axis["point_cart"], dtype=float)
        if (direction.shape != (3,) or point.shape != (3,) or
                not np.all(np.isfinite(direction)) or not np.all(np.isfinite(point)) or
                np.linalg.norm(direction) == 0 or
                np.linalg.norm(np.cross(direction/np.linalg.norm(direction), n)) > match or
                np.linalg.norm(np.cross(point-center, n)) > mapping_tolerance_A):
            raise PreparationError("source continuous axis does not correspond to the atomic line")
    W = np.array([ops[i]["matrix_cart"] for i in finite], dtype=float)
    t = np.array([ops[i]["translation_cart"] for i in finite], dtype=float)
    if W.shape != (len(finite), 3, 3) or t.shape != (len(finite), 3) or not all(
            np.all(np.isfinite(a)) for a in (W, t)):
        raise PreparationError("invalid molecular operations")
    permutations, images, source_error = _atom_action(x, species, W, t, np.eye(3), False,
                                                     mapping_tolerance_A)
    elements = []
    reversal = None
    for matrix, permutation in zip(W, permutations):
        local = basis.T @ matrix @ basis
        sign = 1 if local[2, 2] >= 0 else -1
        left, _, right = np.linalg.svd(local[:2, :2])
        block = left @ right
        canonical = np.zeros((3, 3)); canonical[:2, :2] = block; canonical[2, 2] = sign
        if _max(canonical-local) > match:
            raise PreparationError("representative does not preserve the atomic line")
        element = AxialElement(float(np.arctan2(block[1, 0], block[0, 0])),
                               bool(np.linalg.det(block) < 0), sign)
        elements.append(element)
        if sign == -1:
            if reversal is not None and not np.array_equal(reversal, permutation):
                raise PreparationError("inconsistent axial reversal permutations")
            reversal = permutation
        elif not np.array_equal(permutation, np.arange(len(x))):
            raise PreparationError("line-preserving representative changes axial atom order")
    z = (x-center) @ n
    if reversal is not None:
        if not np.array_equal(reversal[reversal], np.arange(len(x))):
            raise PreparationError("axial reversal is not involutive")
        z = (z-z[reversal])/2
    corrected = center+z[:, None]*n
    all_elements = [None] * len(ops)
    for i, element in zip(finite, elements):
        all_elements[i] = element
    group = AxialGroup(_tuple(center), _tuple(n), _tuple(q), reversal is not None,
                       tuple(all_elements), tuple(indices[i] for i in family),
                       float(np.max(np.linalg.norm(np.cross(corrected-center, n), axis=1))))
    pairs = [group.components(e.angle_rad, e.transverse_reflection, e.axial_sign) for e in elements]
    new_W, new_t = np.array([p[0] for p in pairs]), np.array([p[1] for p in pairs])
    new_perms, _, error = _atom_action(corrected, species, new_W, new_t, np.eye(3), False,
                                      residual_tolerance)
    if not np.array_equal(new_perms, permutations):
        raise PreparationError("linear reconstruction changed atom correspondence")
    em = et = 0.
    for g, a in enumerate(elements):
        for h, b in enumerate(elements):
            product = a.after(b)
            matrix, translation = group.components(product.angle_rad, product.transverse_reflection,
                                                     product.axial_sign)
            em = max(em, _max(new_W[g] @ new_W[h]-matrix))
            et = max(et, _max(new_W[g] @ new_t[h]+new_t[g]-translation))
            expected_perm = np.arange(len(x)) if product.axial_sign == 1 else reversal
            if not np.array_equal(permutations[g, permutations[h]], expected_perm):
                raise PreparationError("axial product/permutation mismatch")
    metric_error = max(_max(m.T @ m-np.eye(3)) for m in new_W)
    if (em > residual_tolerance or metric_error > residual_tolerance or
            et > residual_tolerance or group.line_residual_A > residual_tolerance):
        raise PreparationError("continuous whole-model validation failed")
    # The coefficient identity x_i=c+z_i*n proves invariance for *all* angles.
    # The finite products above validate representatives in that same algebra.
    displacement = corrected-x
    report = ValidationReport(
        mapping_tolerance_A=mapping_tolerance_A, residual_tolerance=residual_tolerance,
        source_mapping_max_A=source_error, atom_correction_max_A=float(np.max(np.linalg.norm(displacement, axis=1))),
        atom_correction_rms_A=float(np.sqrt(np.mean(np.sum(displacement**2, axis=1)))),
        total_cartesian_change_max_A=float(np.max(np.linalg.norm(displacement, axis=1))),
        operation_matrix_correction_max=_max(new_W-W),
        operation_translation_correction_max_A=float(np.max(np.linalg.norm(new_t-t, axis=1))),
        operation_match_tolerance=operation_match_tolerance,
        source_closure_matrix_residual=None, source_closure_translation_residual=None,
        closure_translation_unit="A", lattice_length_changes_A=(), lattice_angle_changes_deg=(),
        metric_relative_residual=metric_error, atom_residual_max_A=error,
        closure_matrix_residual=em, closure_translation_residual=et, composition_checks=len(finite)**2,
        numeric_provenance="constructed numeric axial O(2) family; symbolic rotation has no finite matrix; no inferred rationals")
    matrices, translations, perms = [None]*len(ops), [None]*len(ops), [tuple(range(len(x)))]*len(ops)
    for j, i in enumerate(finite):
        matrices[i], translations[i], perms[i] = _tuple(new_W[j]), _tuple(new_t[j]), _tuple(permutations[j])
    correspondence = ModelCorrespondence(atom_indices, indices, _tuple(displacement), None,
                                         _tuple(np.eye(3)), (0, 0, 0), ((0, 0, 0),)*len(ops))
    model_id = _id("symmetry", dict(version=2, source=source.source_model_id, axial=asdict(group),
        positions=_tuple(corrected), species=species, matrices=matrices, translations=translations,
        mapping_tolerance_A=mapping_tolerance_A, residual_tolerance=residual_tolerance,
        operation_match_tolerance=operation_match_tolerance))
    return SymmetryModel(model_id, source.source_model_id, _id("frame", [model_id, "cartesian"]),
                         False, None, _tuple(corrected), species, tuple(matrices), tuple(translations),
                         tuple(perms), (((0, 0, 0),)*len(x),)*len(ops), (), (), correspondence, report, group)
