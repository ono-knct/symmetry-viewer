"""Verified whole-model preparation, independent of parsers and viewers.

This stage-B preparation boundary projects positions for a verified finite
group (mod Z^3 for crystals). Finite molecular representations may be recovered
as a whole when explicitly requested. Source operation indices and complete
translations remain traceable. Activation and correction-limit policy belong
to the later session adapter.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import itertools
import json
from typing import TYPE_CHECKING

import numpy as np

if TYPE_CHECKING:
    from crystal_viewer.linear_symmetry import AxialGroup


def _json(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False, allow_nan=False)


def _id(kind, value):
    return kind + ":" + hashlib.sha256(_json(value).encode()).hexdigest()


def _tuple(value):
    return tuple(_tuple(x) if isinstance(x, list) else x for x in np.asarray(value).tolist())


class PreparationError(ValueError):
    """A candidate cannot be verified; does not prescribe any UI behaviour."""


@dataclass(frozen=True)
class SourceModel:
    source_model_id: str
    payload_json: str
    analysis_context_json: str

    @classmethod
    def capture(cls, payload: dict, *, analysis_context: dict) -> SourceModel:
        # An absent version is a deliberate historical input path. An explicit
        # version must never fall through to that path (including bool/string).
        if "schema_version" in payload and (
                type(payload["schema_version"]) is not int or payload["schema_version"] not in (7, 8)):
            raise PreparationError("unsupported saved JSON contract")
        if "model_input_version" in payload and (
                type(payload["model_input_version"]) is not int or payload["model_input_version"] != 1
                or payload.get("source_kind") not in ("crystal", "molecule") or "schema_version" in payload):
            raise PreparationError("unsupported model input contract")
        if payload.get("schema_version") == 8 or "verified_export" in payload:
            record = payload.get("verified_export")
            if (type(payload.get("schema_version")) is not int or payload["schema_version"] != 8
                    or not isinstance(record, dict) or type(record.get("version")) is not int or record["version"] != 1
                    or type(record.get("math_version")) is not int or record["math_version"] != 1
                    or payload.get("source_kind") not in ("crystal", "molecule")):
                raise PreparationError("unsupported verified export contract")
        # A full JSON snapshot preserves old mappings, analysis and auxiliary
        # elements for diagnosis. Missing historical settings stay missing.
        document, context = _json(payload), _json(analysis_context)
        return cls(_id("source", [document, context]), document, context)


@dataclass(frozen=True)
class ModelCorrespondence:
    # Same atom/order indices, same fractional (or molecular Cartesian) frame.
    # Cartesian strain of the lattice is a correction, not a basis change.
    atom_indices: tuple
    operation_indices: tuple
    atom_corrections_cart_A: tuple
    lattice_correction_A: tuple | None
    basis_change: tuple
    origin_shift: tuple
    operation_cell_offsets: tuple


@dataclass(frozen=True)
class ValidationReport:
    mapping_tolerance_A: float
    residual_tolerance: float
    source_mapping_max_A: float
    atom_correction_max_A: float
    atom_correction_rms_A: float
    total_cartesian_change_max_A: float
    operation_matrix_correction_max: float
    operation_translation_correction_max_A: float
    operation_match_tolerance: float | None
    source_closure_matrix_residual: float | None
    source_closure_translation_residual: float | None
    closure_translation_unit: str
    lattice_length_changes_A: tuple
    lattice_angle_changes_deg: tuple
    metric_relative_residual: float
    atom_residual_max_A: float
    closure_matrix_residual: float
    closure_translation_residual: float
    composition_checks: int
    numeric_provenance: str


@dataclass(frozen=True)
class SymmetryModel:
    model_id: str
    source_model_id: str
    frame_id: str
    periodic: bool
    lattice: tuple | None
    positions: tuple
    species: tuple
    matrices: tuple
    translations: tuple
    permutations: tuple
    image_shifts: tuple
    product_table: tuple
    product_cell_shifts: tuple
    correspondence: ModelCorrespondence
    validation: ValidationReport
    continuous: AxialGroup | None = None

    def require_identity(self, *, model_id: str, frame_id: str):
        if (model_id, frame_id) != (self.model_id, self.frame_id):
            raise PreparationError("model/frame mismatch")

    def operation_components(self, operation_index, *, family_angle_rad=None):
        index = self.correspondence.operation_indices.index(operation_index)
        if self.continuous is not None and self.continuous.elements[index] is None:
            if family_angle_rad is None or not np.isfinite(family_angle_rad):
                raise PreparationError("continuous rotation requires an explicit finite angle")
            return self.continuous.components(family_angle_rad)
        if family_angle_rad is not None:
            raise PreparationError("an angle is only valid for a continuous rotation family")
        return np.array(self.matrices[index]), np.array(self.translations[index])


def _max(value):
    return float(np.max(np.abs(value), initial=0.0))


def _sqrt_spd(value):
    eigenvalues, vectors = np.linalg.eigh(value)
    if np.min(eigenvalues) <= 0:
        raise PreparationError("non-positive metric")
    return (vectors * np.sqrt(eigenvalues)) @ vectors.T


def _cell_parameters(B):
    lengths = np.linalg.norm(B, axis=0)
    angles = [np.degrees(np.arccos(np.clip(np.dot(B[:, i], B[:, j]) /
              (lengths[i] * lengths[j]), -1, 1))) for i, j in ((1, 2), (0, 2), (0, 1))]
    return lengths, np.array(angles)


def _group(W, t, periodic, tol):
    count = len(W)
    table = np.empty((count, count), dtype=int)
    shifts = np.zeros((count, count, 3), dtype=int)
    matrix_error = translation_error = 0.0
    # Group representatives must be unique, including identity. Do not merge
    # separately numbered source operations silently.
    for g in range(count):
        delta = t[g] - t[:g]
        if periodic:
            delta -= np.rint(delta)
        if g and np.any((np.max(abs(W[g] - W[:g]), axis=(1, 2)) <= tol) &
                        (np.max(abs(delta), axis=1) <= tol)):
            raise PreparationError("duplicate operation representatives")
        matrices = W[g] @ W
        # Keep each original matrix-vector product's arithmetic order.
        translations = np.array([W[g] @ translation + t[g] for translation in t])
        # Compare every product's matrix with every representative. Only matrix
        # matches can satisfy the conjunction, so evaluate translation residuals
        # for those candidates, in the original order. No rounding/key-based
        # matrix lookup is used; the same tolerance applies to molecules too.
        # Bounded blocks avoid a count**3 matrix-valued temporary.
        for start in range(0, count, 64):
            end = min(start + 64, count)
            matrix_errors = np.zeros((end - start, count))
            for i in range(3):
                for j in range(3):
                    np.maximum(matrix_errors,
                        abs(W[None, :, i, j] - matrices[start:end, None, i, j]),
                        out=matrix_errors)
            candidate_rows, candidate_indices = np.nonzero(matrix_errors <= tol)
            delta = translations[start + candidate_rows] - t[candidate_indices]
            cells = np.rint(delta).astype(int) if periodic else np.zeros_like(delta, dtype=int)
            errors = np.max(abs(delta - cells), axis=1)
            accepted = errors <= tol
            rows, k = candidate_rows[accepted], candidate_indices[accepted]
            if np.any(np.bincount(rows, minlength=end - start) != 1):
                raise PreparationError("operations do not close uniquely at the residual tolerance")
            table[g, start:end], shifts[g, start:end] = k, cells[accepted]
            matrix_error = max(matrix_error, float(np.max(matrix_errors[rows, k])))
            translation_error = max(translation_error, float(np.max(errors[accepted])))
    identity = [g for g in range(count) if np.array_equal(table[g], np.arange(count))
                and np.array_equal(table[:, g], np.arange(count))]
    if len(identity) != 1 or any(not np.any((table[g] == identity[0]) &
                                          (table[:, g] == identity[0])) for g in range(count)):
        raise PreparationError("missing identity/inverse")
    for g in range(count):
        if not np.array_equal(table[table[g]], table[g, table]):
            raise PreparationError("candidate multiplication table is not associative")
    return table, shifts, matrix_error, translation_error


def _atom_action(x, species, W, t, B, periodic, tolerance):
    """Unique matching inside a Cartesian ball; no nearest-image assumption.

    The inverse-basis bound enumerates every possible integer image even in
    skew cells. Overlapping sites/large ambiguous tolerances are diagnostic
    failures rather than an arbitrary permutation.
    """
    permutations, shifts = [], []
    max_error = 0.0
    bound = np.linalg.norm(np.linalg.inv(B), axis=1) * tolerance
    for matrix, translation in zip(W, t):
        permutation, images = [], []
        for i, point in enumerate(x):
            transformed = matrix @ point + translation
            matches = []
            for j, target in enumerate(x):
                if species[i] != species[j]:
                    continue
                delta = transformed - target
                ranges = ([range(int(np.ceil(d - b - 1e-12)), int(np.floor(d + b + 1e-12)) + 1)
                           for d, b in zip(delta, bound)] if periodic else [[0]] * 3)
                # Reject pathological inputs before unbounded enumeration.
                if np.prod([len(r) for r in ranges]) > 10000:
                    raise PreparationError("image search exceeds preparation bound")
                for image in itertools.product(*ranges):
                    error = float(np.linalg.norm(B @ (delta - image)))
                    if error <= tolerance:
                        matches.append((j, image, error))
            if len(matches) != 1:
                raise PreparationError("atom correspondence is absent or ambiguous")
            j, image, error = matches[0]
            permutation.append(j)
            images.append(image)
            max_error = max(max_error, error)
        if len(set(permutation)) != len(x):
            raise PreparationError("atom correspondence is not a permutation")
        permutations.append(permutation)
        shifts.append(images)
    return np.array(permutations), np.array(shifts), max_error


def _validate_atom_composition(W, permutations, images, table, product_shifts, tolerance):
    """Check every product, retaining the scalar g/h/condition failure order."""
    for g in range(len(W)):
        for start in range(0, len(W), 64):
            end = min(start + 64, len(W))
            k = table[g, start:end]
            permuted = permutations[start:end]
            permutation_errors = np.any(permutations[g, permuted] != permutations[k], axis=1)
            composed_images = images[start:end] @ W[g].T + images[g, permuted]
            image_errors = np.max(abs(composed_images - images[k] -
                product_shifts[g, start:end, None, :]), axis=(1, 2), initial=0.) > tolerance
            failures = np.flatnonzero(permutation_errors | image_errors)
            if len(failures):
                if permutation_errors[failures[0]]:
                    raise PreparationError("atom permutation composition mismatch")
                raise PreparationError("integer image composition mismatch")


def _finite_molecular_representation(W, table, tol):
    """Recover one orthogonal representation of a verified abstract group.

    Average the rank-three approximate invariant subspace over the regular
    representation. Its isolated leading eigenspace is invariant. Restriction
    to that subspace gives *all* operations together; Procrustes alignment
    retains the source Cartesian convention. Final group/metric/atom checks
    remain mandatory. No individual operation angle is rounded.
    """
    count = len(W)
    for g in range(count):
        for h in range(count):
            if not np.array_equal(table[table[g, h]], table[g, table[h]]):
                raise PreparationError("candidate multiplication table is not associative")
    V = np.concatenate(W) / np.sqrt(count)
    actions = [(3 * table[:, h, None] + np.arange(3)).reshape(-1) for h in range(count)]
    projector = sum(V[action] @ V[action].T for action in actions) / count
    values, vectors = np.linalg.eigh(projector)
    if len(values) > 3 and values[-3] - values[-4] <= tol:
        raise PreparationError("no isolated three-dimensional representation")
    U = vectors[:, -3:]
    left, singular, right = np.linalg.svd(U.T @ V)
    if np.min(singular) <= tol:
        raise PreparationError("source representation alignment is singular")
    U = U @ left @ right
    return np.array([U.T @ U[action] for action in actions])


def prepare_model(source: SourceModel, *, mapping_tolerance_A: float,
                  residual_tolerance: float = 1e-9,
                  operation_match_tolerance: float | None = None) -> SymmetryModel:
    """Build and validate an immutable candidate, without activating it.

    mapping_tolerance_A is a source correspondence search radius, not an
    approved correction limit. residual_tolerance bounds numerical component
    errors (dimensionless matrices/fractional translations) and atom distances
    in Angstrom. Corrections are reported separately; no display acceptance
    threshold is inferred from either parameter.

    An explicit operation_match_tolerance enables finite molecular group
    recovery. It is a numerical search radius for the source multiplication
    table (matrix components and Cartesian translation components in A), not
    an allowed correction. Without it, source operations must already close.
    """
    if not (np.isfinite(mapping_tolerance_A) and mapping_tolerance_A > 0 and
            np.isfinite(residual_tolerance) and residual_tolerance > 0):
        raise PreparationError("tolerances must be finite and positive")
    if operation_match_tolerance is not None and not (
            np.isfinite(operation_match_tolerance) and operation_match_tolerance > 0):
        raise PreparationError("operation match tolerance must be finite and positive")
    payload = json.loads(source.payload_json)
    data = payload.get("render_data", payload)
    periodic = bool(data.get("unit_cell"))
    operations, atoms = data["operations"], data["atoms"]
    if not operations or not atoms:
        raise PreparationError("empty model")
    if any("infinite" in str(op.get("kind")) for op in operations):
        from crystal_viewer.linear_symmetry import prepare_linear_model
        return prepare_linear_model(source, mapping_tolerance_A=mapping_tolerance_A,
                                    residual_tolerance=residual_tolerance,
                                    operation_match_tolerance=operation_match_tolerance)
    atom_indices = tuple(atom["index"] for atom in atoms)
    op_indices = tuple(op["index"] for op in operations)
    if len(set(atom_indices)) != len(atoms) or len(set(op_indices)) != len(operations):
        raise PreparationError("duplicate atom/operation index")
    species = tuple(_json({k: v for k, v in atom.items() if k in
                          ("element", "atomic_number", "occupancy", "species")}) for atom in atoms)
    x = np.array([a["frac" if periodic else "cart"] for a in atoms], dtype=float)
    W = np.array([o["matrix_frac" if periodic else "matrix_cart"] for o in operations], dtype=float)
    t = np.array([o["translation_frac" if periodic else "translation_cart"] for o in operations], dtype=float)
    B = np.array(data["unit_cell"]["lattice"], dtype=float).T if periodic else np.eye(3)
    if (x.shape != (len(atoms), 3) or W.shape != (len(operations), 3, 3) or
            t.shape != (len(operations), 3) or B.shape != (3, 3) or
            not all(np.all(np.isfinite(a)) for a in (x, W, t, B))):
        raise PreparationError("invalid coordinate data")
    if abs(np.linalg.det(B)) < 1e-12:
        raise PreparationError("singular lattice")
    if np.any(abs(np.linalg.det(W)) < 1e-12):
        raise PreparationError("singular operation")
    if periodic and (not np.array_equal(W, np.rint(W)) or
                     np.any(abs(abs(np.linalg.det(W)) - 1) > residual_tolerance)):
        raise PreparationError("crystal matrices must be integral and unimodular")
    source_W, source_t = W.copy(), t.copy()
    match_tolerance = (operation_match_tolerance if operation_match_tolerance is not None
                       and not periodic else residual_tolerance)
    table, product_shifts, source_em, source_et = _group(W, t, periodic, match_tolerance)
    permutations, images, source_error = _atom_action(
        x, species, W, t, B, periodic, mapping_tolerance_A)
    _validate_atom_composition(W, permutations, images, table, product_shifts, residual_tolerance)
    if not periodic and operation_match_tolerance is not None:
        W = _finite_molecular_representation(W, table, residual_tolerance)
        center = np.mean(x, axis=0)
        t = np.array([center - matrix @ center for matrix in W])
    if periodic:
        # Crystal W/t and the group tolerance are unchanged in this preparation.
        # Reuse this input's complete validation, never a different model's result.
        em, et = source_em, source_et
    else:
        verified_table, product_shifts, em, et = _group(W, t, periodic, residual_tolerance)
        if not np.array_equal(verified_table, table):
            raise PreparationError("reconstructed operation correspondence changed")
    if periodic:
        # Reynolds-average the *distinct point group*, then use symmetric
        # positive Cartesian strain to retain the input cell orientation.
        point_group = np.unique(W, axis=0)
        G = B.T @ B
        reference = np.mean([matrix.T @ G @ matrix for matrix in point_group], axis=0)
        inverse = np.linalg.inv(B)
        new_B = _sqrt_spd(inverse.T @ reference @ inverse) @ B
    else:
        new_B = B.copy()
    # Reynolds projection of the entire atom configuration for the validated
    # permutation/image action, retaining each source site's integer image.
    corrected = np.mean([(x[permutation] + image - translation) @ np.linalg.inv(matrix).T
                         for matrix, translation, permutation, image in zip(W, t, permutations, images)], axis=0)
    metric = new_B.T @ new_B
    metric_error = max(_max(matrix.T @ metric @ matrix - metric) /
                       max(_max(metric), 1e-300) for matrix in W)
    atom_error = max(float(np.max(np.linalg.norm(
        (corrected @ matrix.T + translation - corrected[permutation] - image) @ new_B.T, axis=1)))
        for matrix, translation, permutation, image in zip(W, t, permutations, images))
    if metric_error > residual_tolerance or atom_error > residual_tolerance:
        raise PreparationError("whole-model residual exceeds numerical tolerance")
    # Atom correction excludes cell strain; total Cartesian change can be
    # recovered independently from new_B @ corrected - B @ x.
    displacement = (corrected - x) @ new_B.T
    total_change = corrected @ new_B.T - x @ B.T
    lengths, angles = _cell_parameters(B)
    new_lengths, new_angles = _cell_parameters(new_B)
    correspondence = ModelCorrespondence(
        atom_indices, op_indices, _tuple(displacement), _tuple((new_B - B).T) if periodic else None,
        _tuple(np.eye(3)), (0, 0, 0), _tuple(np.zeros_like(t, dtype=int)))
    report = ValidationReport(
        float(mapping_tolerance_A), float(residual_tolerance), source_error,
        float(np.max(np.linalg.norm(displacement, axis=1))),
        float(np.sqrt(np.mean(np.sum(displacement**2, axis=1)))),
        float(np.max(np.linalg.norm(total_change, axis=1))),
        max(_max(new_B @ matrix @ np.linalg.inv(new_B) - B @ old @ np.linalg.inv(B))
            for matrix, old in zip(W, source_W)),
        float(np.max(np.linalg.norm(t @ new_B.T - source_t @ B.T, axis=1))),
        operation_match_tolerance, source_em, source_et, "fractional" if periodic else "A",
        _tuple(new_lengths - lengths) if periodic else (),
        _tuple(new_angles - angles) if periodic else (), metric_error, atom_error,
        em, et, len(W)**2,
        ("input integer-valued W and floating t retained; metric/positions numerically projected" if periodic else
         "finite regular representation and positions numerically projected" if operation_match_tolerance is not None else
         "input floating M/t retained; positions numerically projected") + "; no inferred rationals")
    contents = dict(version=1, source=source.source_model_id, periodic=periodic,
                    lattice=_tuple(new_B.T) if periodic else None, positions=_tuple(corrected),
                    species=species, matrices=_tuple(W), translations=_tuple(t),
                    mapping_tolerance_A=mapping_tolerance_A, residual_tolerance=residual_tolerance,
                    operation_match_tolerance=operation_match_tolerance)
    model_id = _id("symmetry", contents)
    # Corrections change the model identity even when the coordinate convention
    # stays unchanged. Carry both identities through future plans/requests.
    frame_id = _id("frame", [model_id, "fractional" if periodic else "cartesian"])
    return SymmetryModel(model_id, source.source_model_id, frame_id, periodic,
                         contents["lattice"], contents["positions"], species,
                         contents["matrices"], contents["translations"], _tuple(permutations),
                         _tuple(images), _tuple(table), _tuple(product_shifts), correspondence, report)
