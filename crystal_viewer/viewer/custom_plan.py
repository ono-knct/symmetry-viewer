"""Custom input, composition and Check on the displayed immutable model.

This preparation API is not wired into the legacy HTTP/UI. It never changes
an entered transform to a symmetry operation, even when Check finds a match.
Coordinates are fractional for crystals and Cartesian Angstrom for molecules;
plane normals are covectors in that same coordinate space.
"""
from dataclasses import dataclass
import itertools
import json
from math import prod

import numpy as np

from crystal_viewer.affine_math import compare_operations, compose
from crystal_viewer.symmetry_model import PreparationError, SymmetryModel, _json, _tuple
from crystal_viewer.viewer.operation_plan import (
    DecompositionPlan, PrimitiveStage, _finish_plan, _rotation,
)


def plan_components(model, plan):
    """Complete endpoint in model coordinates, including integer translations."""
    plan.require_model(model)
    endpoint = (np.eye(3), np.zeros(3))
    for stage in plan.stages:
        endpoint = compose((stage.matrix, stage.translation), endpoint)
    B = np.array(model.lattice).T if model.periodic else np.eye(3)
    return np.linalg.solve(B, endpoint[0]@B), np.linalg.solve(B, endpoint[1])


def _finite(value, shape):
    array = np.array(value, dtype=float)
    if array.shape != shape or not np.all(np.isfinite(array)):
        raise ValueError(f"finite input with shape {shape} required")
    return array


@dataclass(frozen=True)
class CustomInput:
    input_json: str
    plan: DecompositionPlan


def build_custom_plan(model, kind, params, *, expected_components=None):
    """Build once from parameters; optionally verify a duplicate W/t payload.

    A general matrix, including a singular one, is a valid animation input.
    Check separately reports whether it is an isometry and maps the atoms.
    """
    if not isinstance(model, SymmetryModel):
        raise TypeError("verified SymmetryModel required")
    if not isinstance(params, dict):
        raise ValueError("parameter object required")
    snapshot = _json(dict(kind=kind, params=params))
    params = json.loads(snapshot)["params"]
    B = np.array(model.lattice).T if model.periodic else np.eye(3)
    I = np.eye(3)
    stages = []

    def vector(name, default=None):
        return _finite(params[name] if default is None else params.get(name, default), (3,))

    def add(stage_kind, matrix, *, point=None, axis=None, angle=0., translation=None):
        point = np.zeros(3) if point is None else point
        axis = np.zeros(3) if axis is None else axis
        translation = point-matrix@point if translation is None else translation
        stages.append(PrimitiveStage(stage_kind, _tuple(matrix), _tuple(translation),
                                     _tuple(point), _tuple(axis), float(angle)))

    if kind in ("identity", "translation"):
        add("translation", I, translation=np.zeros(3) if kind == "identity" else B@vector("vector"))
    elif kind == "inversion":
        add("inversion", -I, point=B@vector("center", [0, 0, 0]))
    elif kind in ("rotation", "screw", "rotoinversion", "mirror", "glide"):
        rotating = kind in ("rotation", "screw", "rotoinversion")
        entered_axis = vector("axis" if rotating else "normal")
        axis_scale = np.max(abs(entered_axis))
        if axis_scale == 0:
            raise ValueError("finite nonzero direction required")
        axis = B@(entered_axis/axis_scale) if rotating else np.linalg.solve(B.T, entered_axis/axis_scale)
        norm = np.linalg.norm(axis)
        if not np.isfinite(norm) or norm == 0:
            raise ValueError("finite nonzero direction required")
        axis /= norm
        point = B@vector("center" if kind == "rotoinversion" else "point", [0, 0, 0])
        if rotating:
            angle = float(_finite(params["angle"], ())) * (np.pi/180)
            if not np.isfinite(angle):
                raise ValueError("finite angle required")
            add("rotation", _rotation(axis, angle), point=point, axis=axis, angle=angle)
        else:
            add("reflection", I-2*np.outer(axis, axis), point=point, axis=axis)
        if kind == "rotoinversion":
            add("inversion", -I, point=point)
        elif kind in ("screw", "glide"):
            add("translation", I, translation=B@vector(kind, [0, 0, 0]))
    elif kind == "matrix":
        add("affine", B@_finite(params["W"], (3, 3))@np.linalg.inv(B),
            translation=B@vector("t"))
    else:
        raise ValueError("unknown Custom input type")
    M, v = I.copy(), np.zeros(3)
    for stage in stages:
        M, v = compose((stage.matrix, stage.translation), (M, v))
    if not np.all(np.isfinite(M)) or not np.all(np.isfinite(v)):
        raise ValueError("non-finite Custom endpoint")
    if expected_components is not None:
        W, t = expected_components
        em = np.max(abs(B@_finite(W, (3, 3))@np.linalg.inv(B)-M))
        et = np.max(abs(B@_finite(t, (3,))-v))
        if em > 1e-10 or et > 1e-8:
            raise PreparationError("Custom parameters and supplied W/t disagree")
    plan = _finish_plan(model, None, "custom:"+kind, stages, M, v,
                        identity_context=snapshot)
    return CustomInput(snapshot, plan)


@dataclass(frozen=True)
class PlanSequence:
    plan: DecompositionPlan
    input_plan_ids: tuple
    stage_ranges: tuple


def compose_plans(model, plans):
    """Apply plans in input order; reject the entire mixed/invalid sequence."""
    plans = tuple(plans)
    if not plans:
        raise ValueError("empty operation sequence")
    stages, ranges = [], []
    endpoint = (np.eye(3), np.zeros(3))
    for plan in plans:
        plan.require_model(model)
        start = len(stages)
        stages.extend(plan.stages)
        ranges.append((start, len(stages)))
        for stage in plan.stages:
            endpoint = compose((stage.matrix, stage.translation), endpoint)
    if not all(np.all(np.isfinite(a)) for a in endpoint):
        raise ValueError("non-finite composed endpoint")
    ids = tuple(plan.plan_id for plan in plans)
    result = _finish_plan(model, None, "custom_sequence", stages, *endpoint,
                          identity_context=dict(input_plan_ids=ids, stage_ranges=ranges))
    return PlanSequence(result, ids, tuple(ranges))


@dataclass(frozen=True)
class AtomCheck:
    atom_index: int
    transformed: tuple
    # Every candidate in the requested radius is retained; no arbitrary tie.
    candidates: tuple  # (target atom index, integer cell image, residual_A)


@dataclass(frozen=True)
class PlanCheck:
    model_id: str
    frame_id: str
    plan_id: str
    coordinate_space: str
    matrix: tuple
    translation: tuple
    atom_checks: tuple[AtomCheck, ...]
    atom_mapping_status: str
    inverse_atom_checks: tuple[AtomCheck, ...]
    periodic_bijection: bool | None
    isometry_residual: float
    lattice_preserved: bool | None
    is_symmetry: bool
    mapping_tolerance_A: float
    numeric_tolerance: float
    lattice_membership_tolerance_A: float | None
    match_translation_units: str
    operation_matches: tuple  # (model operation index, OperationRelation)


def _candidates(model, W, t, tolerance_A):
    B = np.array(model.lattice).T if model.periodic else np.eye(3)
    bound = np.linalg.norm(np.linalg.inv(B), axis=1)*tolerance_A
    if not np.all(np.isfinite(bound)):
        raise PreparationError("non-finite image search bound")
    result = []
    indices = model.correspondence.atom_indices
    for i, point in enumerate(model.positions):
        transformed = W@point+t
        if not np.all(np.isfinite(transformed)):
            raise PreparationError("non-finite transformed atom")
        candidates = []
        for j, target in enumerate(model.positions):
            if model.species[i] != model.species[j]:
                continue
            delta = transformed-target
            limits = ([(int(np.ceil(d-b-1e-12)), int(np.floor(d+b+1e-12)))
                       for d, b in zip(delta, bound)] if model.periodic else [(0, 0)]*3)
            if prod(max(0, hi-lo+1) for lo, hi in limits) > 10000:
                raise PreparationError("image search exceeds preparation bound")
            ranges = [range(lo, hi+1) for lo, hi in limits]
            for image in itertools.product(*ranges):
                error = float(np.linalg.norm(B@(delta-image)))
                if error <= tolerance_A:
                    candidates.append((indices[j], tuple(int(v) for v in image), error))
        result.append(AtomCheck(indices[i], _tuple(transformed), tuple(candidates)))
    return tuple(result)


def _mapping_status(atoms):
    if not atoms or any(len(a.candidates) == 0 for a in atoms):
        return "unmatched"
    if any(len(a.candidates) != 1 for a in atoms):
        return "ambiguous"
    return "permutation" if len({a.candidates[0][0] for a in atoms}) == len(atoms) else "not_bijective"


def check_plan(model, plan, *, mapping_tolerance_A, numeric_tolerance=1e-9):
    """Diagnose this plan without modifying either the plan or its model.

    Mapping tolerance is a Cartesian radius. Isometry tolerance is separately
    dimensionless. A periodic isometry must also preserve the *full* translation
    lattice generated by cell vectors and verified centering translations.
    """
    if (not np.isfinite(mapping_tolerance_A) or mapping_tolerance_A <= 0 or
            not np.isfinite(numeric_tolerance) or numeric_tolerance <= 0):
        raise ValueError("positive finite Check tolerances required")
    W, t = plan_components(model, plan)
    B = np.array(model.lattice).T if model.periodic else np.eye(3)
    M = B@W@np.linalg.inv(B)
    metric_error = float(np.max(abs(M.T@M-np.eye(3))))
    atoms = _candidates(model, W, t, mapping_tolerance_A)
    status = _mapping_status(atoms)
    lattice_ok = None
    lattice_radius_A = None
    inverse_atoms = ()
    periodic_bijection = None
    if model.periodic:
        lattice_ok = False
        if metric_error <= numeric_tolerance:
            generators = list(np.eye(3))
            generators.extend(np.array(v) for A, v in zip(model.matrices, model.translations)
                              if np.max(abs(np.array(A)-np.eye(3))) <= numeric_tolerance)
            # Test translation membership on the same atoms, in both directions.
            lattice_radius_A = numeric_tolerance*max(1., float(np.linalg.norm(B, ord=2)))
            lattice_ok = all(_mapping_status(_candidates(model, np.eye(3), A@g, lattice_radius_A)) == "permutation"
                             for A in (W, np.linalg.inv(W)) for g in generators)
        periodic_bijection = False
        if lattice_ok:
            inverse_W = np.linalg.inv(W)
            inverse_atoms = _candidates(model, inverse_W, -inverse_W@t, mapping_tolerance_A)
            # W need not normalize the chosen cell's Z^3 subgroup. Distinct
            # sites can reach the same cell representative in different images.
            # With W Lambda = Lambda and invertible W, forward AND inverse
            # membership on every decorated site establishes the infinite
            # pattern bijection. The raw cell-index status stays diagnostic.
            periodic_bijection = all(len(a.candidates) == 1 for a in atoms+inverse_atoms)
    matches = []
    for index, A, v in zip(model.correspondence.operation_indices, model.matrices, model.translations):
        if A is None:
            continue  # no implicit angle for a continuous family
        relation = compare_operations((W, t), (A, v), atol=numeric_tolerance)
        if relation.relation == "same_mod_cell_numeric" and not model.periodic:
            continue
        if relation.relation != "different":
            matches.append((index, relation))
    return PlanCheck(model.model_id, model.frame_id, plan.plan_id,
        "fractional" if model.periodic else "cartesian_A", _tuple(W), _tuple(t), atoms,
        status, inverse_atoms, periodic_bijection, metric_error, lattice_ok,
        bool((periodic_bijection if model.periodic else status == "permutation")
             and metric_error <= numeric_tolerance),
        float(mapping_tolerance_A), float(numeric_tolerance), lattice_radius_A,
        "fractional" if model.periodic else "A", tuple(matches))
