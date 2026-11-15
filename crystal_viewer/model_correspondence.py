"""Verified correspondence across nested periodic cells in explicit frames.

This records a relation; it does not convert, reanalyse or mutate either model.
The caller supplies x_source=P*x_target+o and a Cartesian frame rotation Q.
Correction performed by either model builder remains a separate record.
"""
from dataclasses import dataclass
from itertools import product

import numpy as np

from crystal_viewer.affine_math import change_coordinates
from crystal_viewer.symmetry_model import PreparationError, _id, _max, _tuple


@dataclass(frozen=True)
class AtomCellRelation:
    source_atom: int
    target_atom: int
    source_cell_shift: tuple | None
    target_cell_shift: tuple | None
    residual_A: float


@dataclass(frozen=True)
class OperationCellRelation:
    source_operation: int
    source_cell_lift: tuple
    target_operation: int
    target_cell_shift: tuple
    matrix_residual: float
    translation_residual_A: float


@dataclass(frozen=True)
class CellCorrespondence:
    correspondence_id: str
    from_model_id: str
    to_model_id: str
    from_frame_id: str
    to_frame_id: str
    from_source_model_id: str
    to_source_model_id: str
    basis: tuple
    origin: tuple
    cartesian_rotation: tuple
    lattice_residual_A: float
    atoms: tuple[AtomCellRelation, ...]
    operations: tuple[OperationCellRelation, ...]
    tolerance_A: float
    component_tolerance: float

    def require_models(self, source, target):
        source.require_identity(model_id=self.from_model_id, frame_id=self.from_frame_id)
        target.require_identity(model_id=self.to_model_id, frame_id=self.to_frame_id)


def relate_cells(source, target, *, basis, origin, cartesian_rotation=None,
                 tolerance_A=1e-8, component_tolerance=1e-10):
    if not source.periodic or not target.periodic:
        raise PreparationError("cell correspondence requires two periodic models")
    P, o = np.array(basis, dtype=float), np.array(origin, dtype=float)
    Q = np.eye(3) if cartesian_rotation is None else np.array(cartesian_rotation, dtype=float)
    if (P.shape != (3, 3) or o.shape != (3,) or Q.shape != (3, 3) or
            not all(np.all(np.isfinite(a)) for a in (P, o, Q)) or
            not np.isfinite(tolerance_A) or tolerance_A <= 0 or
            not np.isfinite(component_tolerance) or component_tolerance <= 0 or
            abs(np.linalg.det(P)) < 1e-12 or _max(Q.T@Q-np.eye(3)) > component_tolerance or
            np.linalg.det(Q) < 0):
        raise PreparationError("invalid basis/origin/Cartesian frame")
    Bs, Bt = np.array(source.lattice).T, np.array(target.lattice).T
    lattice_error = float(np.max(np.linalg.norm(Bs@P-Q@Bt, axis=0)))
    if lattice_error > tolerance_A:
        raise PreparationError("coordinate change does not match the two lattices")
    inv = np.linalg.inv(P)
    target_supercell = _max(P-np.rint(P)) <= component_tolerance
    source_supercell = _max(inv-np.rint(inv)) <= component_tolerance
    if not target_supercell and not source_supercell:
        raise PreparationError("non-nested cells need a common-cell construction")
    determinant = abs(np.linalg.det(P))
    factor = int(round(determinant if target_supercell else 1/determinant))
    if factor < 1 or factor > 64:
        raise PreparationError("cell multiplicity is outside the verified construction range")
    atoms = []
    source_counts, target_counts = np.zeros(len(source.positions), int), np.zeros(len(target.positions), int)
    for i, xs in enumerate(source.positions):
        for j, xt in enumerate(target.positions):
            if source.species[i] != target.species[j]:
                continue
            delta = np.array(xs)-(P@xt+o)
            coordinate = delta if target_supercell else inv@delta
            image = np.rint(coordinate).astype(int)
            residual = float(np.linalg.norm((Bs if target_supercell else Q@Bt)@(coordinate-image)))
            if residual <= tolerance_A:
                source_counts[i] += 1; target_counts[j] += 1
                atoms.append(AtomCellRelation(source.correspondence.atom_indices[i],
                    target.correspondence.atom_indices[j], _tuple(image) if target_supercell else None,
                    None if target_supercell else _tuple(image), residual))
    expected_source, expected_target = (factor, 1) if target_supercell else (1, factor)
    if not (np.all(source_counts == expected_source) and np.all(target_counts == expected_target)):
        raise PreparationError("cell atom coverage/multiplicity is absent or ambiguous")
    # Z_source / P Z_target supplies the extra source-cell translations when
    # a larger target display cell lists more representatives of the same group.
    lifts = [(0, 0, 0)]
    if target_supercell and factor > 1:
        lifts, classes = [], []
        for lift in product(range(factor), repeat=3):
            fractional = inv@lift
            if not any(_max(fractional-c-np.rint(fractional-c)) <= component_tolerance for c in classes):
                lifts.append(lift); classes.append(fractional)
            if len(lifts) == factor:
                break
        if len(lifts) != factor:
            raise PreparationError("source-cell translation cosets could not be enumerated")
    operations = []
    covered = set()
    target_W, target_t = np.array(target.matrices), np.array(target.translations)
    for i, index in enumerate(source.correspondence.operation_indices):
        for lift in lifts:
            matrix, translation = change_coordinates((source.matrices[i], np.array(source.translations[i])+lift), P, o)
            matrix_errors = np.max(abs(target_W-matrix), axis=(1, 2))
            delta = translation-target_t
            cells = np.rint(delta).astype(int)
            errors = np.linalg.norm((delta-cells)@Bt.T, axis=1)
            matches = np.flatnonzero((matrix_errors <= component_tolerance) & (errors <= tolerance_A))
            if len(matches) != 1:
                raise PreparationError("operation correspondence is absent or ambiguous")
            k = int(matches[0]); covered.add(k)
            operations.append(OperationCellRelation(index, lift, target.correspondence.operation_indices[k],
                _tuple(cells[k]), float(matrix_errors[k]), float(errors[k])))
    if len(covered) != len(target.matrices):
        raise PreparationError("target operation coverage is incomplete")
    identity = dict(version=1, source=source.model_id, target=target.model_id,
                    basis=_tuple(P), origin=_tuple(o), rotation=_tuple(Q),
                    tolerance_A=tolerance_A, component_tolerance=component_tolerance)
    return CellCorrespondence(_id("correspondence", identity), source.model_id, target.model_id,
        source.frame_id, target.frame_id, source.source_model_id, target.source_model_id,
        _tuple(P), _tuple(o), _tuple(Q), lattice_error,
        tuple(atoms), tuple(operations), tolerance_A, component_tolerance)
