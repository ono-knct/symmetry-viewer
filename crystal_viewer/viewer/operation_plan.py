"""Shared plans from a verified model; no legacy presentation inputs.

Every stage carries a whole-space affine endpoint and its own geometry.
An explicit cell anchor must preserve that complete endpoint.
"""
from dataclasses import asdict, dataclass

import numpy as np

from crystal_viewer.affine_math import compose, integer_nullspace
from crystal_viewer.symmetry_model import PreparationError, SymmetryModel, _id, _tuple


@dataclass(frozen=True)
class PrimitiveStage:
    kind: str
    matrix: tuple
    translation: tuple
    center: tuple
    direction: tuple
    angle_rad: float


@dataclass(frozen=True)
class DecompositionPlan:
    plan_id: str
    model_id: str
    frame_id: str
    operation_index: int | None
    mode: str
    stages: tuple[PrimitiveStage, ...]
    matrix_residual: float
    translation_residual_A: float

    def require_model(self, model):
        model.require_identity(model_id=self.model_id, frame_id=self.frame_id)


def _readonly(array):
    array.setflags(write=False)
    return array


@dataclass(frozen=True)
class _LinearInputs:
    matrix: np.ndarray
    total: np.ndarray
    order: int
    determinant: float
    identity: bool
    inversion: bool
    mirror: bool
    direction: np.ndarray | None
    reflection: np.ndarray | None


@dataclass(frozen=True)
class _FiniteInputs:
    linear: _LinearInputs
    vector: np.ndarray
    intrinsic: np.ndarray
    point: np.ndarray


class PlanContext:
    """Preprocessing for one preparation of one immutable model, not plans.

    Matrix keys preserve every input bit. Translations have separate keys and
    anchors remain per-call inputs. Each mode still builds and verifies a plan.
    """
    def __init__(self, model):
        if not isinstance(model, SymmetryModel):
            raise TypeError("verified SymmetryModel required")
        self.model = model
        self.basis = _readonly(np.array(model.lattice).T if model.periodic else np.eye(3))
        self.inverse = _readonly(np.linalg.inv(self.basis))
        self._linear = {}
        self._finite = {}

    def require_model(self, model):
        if model is not self.model:
            raise ValueError("plan context belongs to another model")

    def inputs(self, model, W, t):
        self.require_model(model)
        key = (W.dtype.str, W.shape, W.tobytes())
        if key not in self._linear:
            self._linear[key] = _linear_inputs(model, W, self.basis, self.inverse)
        full_key = (key, t.dtype.str, t.shape, t.tobytes())
        if full_key not in self._finite:
            self._finite[full_key] = _finite_inputs(self.basis, self._linear[key], t)
        return self._finite[full_key]


def _rotation(n, angle):
    x, y, z = n
    skew = np.array([[0, -z, y], [z, 0, -x], [-y, x, 0]])
    return np.eye(3)*np.cos(angle) + (1-np.cos(angle))*np.outer(n, n) + np.sin(angle)*skew


def _angle(matrix, n):
    skew = np.array([matrix[2, 1]-matrix[1, 2], matrix[0, 2]-matrix[2, 0],
                     matrix[1, 0]-matrix[0, 1]])
    sine, cosine = np.dot(n, skew)/2, (np.trace(matrix)-1)/2
    # Resolve the +/- pi branch of a verified half-turn consistently. This
    # affects the chosen path, not the selected operation's endpoint. Arbitrary
    # continuous input angles bypass this principal-angle extraction entirely.
    if abs(sine) <= 1e-12 and cosine < 0:
        return float(np.pi)
    return float(np.arctan2(sine, cosine))


def evaluate_stage(stage, points, progress):
    """Evaluate a single stage; even a zero-time stage has a full endpoint."""
    points = np.asarray(points)
    u = float(np.clip(progress, 0, 1))
    if stage.kind == "rotation":
        center = np.array(stage.center)
        return (points-center) @ _rotation(np.array(stage.direction), stage.angle_rad*u).T + center
    endpoint = points @ np.array(stage.matrix).T + np.array(stage.translation)
    return points + u*(endpoint-points)


def build_plan(model: SymmetryModel, operation_index: int, *, mode="default",
               family_angle_rad=None, anchor_cart_A=None, context=None) -> DecompositionPlan:
    if not isinstance(model, SymmetryModel):
        raise TypeError("verified SymmetryModel required")
    if mode not in ("default", "rotoinversion", "rotoreflection"):
        raise ValueError("unknown decomposition mode")
    if context is not None:
        context.require_model(model)
    try:
        index = model.correspondence.operation_indices.index(operation_index)
    except ValueError:
        raise ValueError("operation index not present in this model") from None
    W, t = model.operation_components(operation_index, family_angle_rad=family_angle_rad)
    if family_angle_rad is not None:
        B = context.basis if context is not None else np.array(model.lattice).T if model.periodic else np.eye(3)
        inverse = context.inverse if context is not None else np.linalg.inv(B)
        M, v = B @ W @ inverse, B @ t
        group = model.continuous
        stage = PrimitiveStage("rotation", _tuple(M), _tuple(v), group.center,
                               group.direction, float(family_angle_rad))
        return _finish_plan(model, operation_index, mode, [stage], M, v)
    return _finite_plan(model, W, t, operation_index, mode, anchor_cart_A=anchor_cart_A, context=context)


def decompose_composition(model, plans):
    """Decompose the complete affine product of verified plans, without reduction."""
    from crystal_viewer.viewer.custom_plan import compose_plans, plan_components
    plans = tuple(plans)
    sequence = compose_plans(model, plans)
    W, t = np.eye(3), np.zeros(3)
    for plan in plans:
        if plan.operation_index is None:
            raise ValueError("composition decomposition requires Standard operands")
        # Multiply the verified native components, preserving integer crystal
        # matrices. Never round the Cartesian stage matrices into a new W.
        W, t = compose(model.operation_components(plan.operation_index), (W, t))
    actual_W, actual_t = plan_components(model, sequence.plan)
    B = np.array(model.lattice).T if model.periodic else np.eye(3)
    if np.max(abs(B@(actual_W-W)@np.linalg.inv(B))) > 1e-10 or np.max(abs(B@(actual_t-t))) > 1e-8:
        raise PreparationError("composition stages differ from complete Standard product")
    return _finite_plan(model, W, t, None, "default",
                        identity_context=dict(input_plan_ids=sequence.input_plan_ids))


def _linear_inputs(model, W, B, inverse, *, numeric_direction=False):
    M = B @ W @ inverse
    I = np.eye(3)
    power, total = I.copy(), np.zeros((3, 3))
    for order in range(1, 121):
        total += power
        power = W @ power
        if np.max(abs(power-I)) <= 1e-9:
            break
    else:
        raise PreparationError("finite matrix order not verified within 120")
    determinant = np.linalg.det(M)
    identity = np.max(abs(M-I)) <= 1e-10
    inversion = np.max(abs(M+I)) <= 1e-10
    mirror = determinant < 0 and abs(np.trace(M)-1) <= 1e-10
    n = H = None
    if not identity:
        if inversion:
            n = B[:, 2].copy()  # current c / molecular input z convention
        else:
            A = W-I if determinant > 0 else W+I
            if model.periodic and not numeric_direction:
                kernel = integer_nullspace(A)
                if len(kernel) != 1:
                    raise PreparationError("direction kernel is not one dimensional")
                n = B @ np.array(kernel[0], dtype=float)
            else:
                _, values, vectors = np.linalg.svd(A)
                if np.sum(values > 1e-10) != 2:
                    raise PreparationError("numeric direction kernel is not one dimensional")
                n = B @ vectors[-1] if model.periodic else vectors[-1]
        n /= np.linalg.norm(n)
        # Preserve the fractional-basis orientation even in a rotated
        # Cartesian frame; it determines the half-turn path's sign.
        canonical = np.linalg.solve(B, n) if model.periodic else n
        for value in canonical:
            if abs(value) > 1e-10:
                if value < 0:
                    n = -n
                break
        H = I - 2*np.outer(n, n)
        _readonly(n)
        _readonly(H)
    return _LinearInputs(_readonly(M), _readonly(total), order, determinant,
                         identity, inversion, mirror, n, H)


def _finite_inputs(B, linear, t):
    v = B @ t
    g = B @ (linear.total @ t / linear.order)
    point = np.linalg.lstsq(np.eye(3)-linear.matrix, v-g, rcond=1e-10)[0]
    return _FiniteInputs(linear, _readonly(v), _readonly(g), _readonly(point))


def _finite_plan(model, W, t, operation_index, mode, *, identity_context=None, anchor_cart_A=None, context=None,
                 numeric_direction=False):
    if context is None:
        B = np.array(model.lattice).T if model.periodic else np.eye(3)
        inputs = _finite_inputs(B, _linear_inputs(model, W, B, np.linalg.inv(B), numeric_direction=numeric_direction), t)
    else:
        inputs = context.inputs(model, W, t)
    linear = inputs.linear
    M, v, g, point = linear.matrix, inputs.vector, inputs.intrinsic, inputs.point
    determinant, identity, inversion, mirror = linear.determinant, linear.identity, linear.inversion, linear.mirror
    I = np.eye(3)
    stages = []

    def add(kind, matrix, center=None, direction=None, angle=0, translation=None):
        center = np.zeros(3) if center is None else center
        direction = np.zeros(3) if direction is None else direction
        translation = center - matrix @ center if translation is None else translation
        stages.append(PrimitiveStage(kind, _tuple(matrix), _tuple(translation),
                                     _tuple(center), _tuple(direction), float(angle)))

    if identity:
        add("translation", I, translation=v)
    elif inversion and mode != "rotoreflection":
        add("inversion", -I, v/2)
    else:
        n, H = linear.direction, linear.reflection
        center = v/2 if inversion else (v-g)/2 if mirror else point
        if anchor_cart_A is not None:
            center = np.asarray(anchor_cart_A, dtype=float)
            if center.shape != (3,) or not np.all(np.isfinite(center)):
                raise PreparationError("finite representative anchor required")
        if determinant > 0:
            angle = _angle(M, n)
            add("rotation", _rotation(n, angle), center, n, angle)
        elif mirror and mode != "rotoinversion":
            add("reflection", H, center, n)
        elif mode == "rotoinversion" or (mode == "default" and model.periodic):
            angle = _angle(-M, n)
            if abs(angle) > 1e-12:
                add("rotation", _rotation(n, angle), center, n, angle)
            add("inversion", -I, center)
        else:
            angle = _angle(H @ M, n)
            if abs(angle) > 1e-12:
                add("rotation", _rotation(n, angle), center, n, angle)
            add("reflection", H, center, n)
        if np.any(g != 0):
            add("translation", I, translation=g)
    return _finish_plan(model, operation_index, mode, stages, M, v, identity_context=identity_context)


def _finish_plan(model, operation_index, mode, stages, M, v, *, identity_context=None):
    combined = (np.eye(3), np.zeros(3))
    for stage in stages:
        # Playback rotates with angle/axis, while endpoints and mirrors use W/t.
        # Verify both descriptions before publishing a plan, including Custom.
        if stage.kind in ("rotation", "reflection"):
            n, center = np.array(stage.direction), np.array(stage.center)
            if (not np.all(np.isfinite(center))
                    or not np.isclose(np.linalg.norm(n), 1., rtol=0, atol=1e-9)):
                raise PreparationError("stage requires a unit direction")
            geometric = (_rotation(n, stage.angle_rad) if stage.kind == "rotation"
                         else np.eye(3)-2*np.outer(n, n))
            if (not np.all(np.isfinite(geometric))
                    or np.max(abs(geometric-stage.matrix)) > 1e-9
                    or np.max(abs(center-geometric@center-stage.translation)) > 1e-8):
                raise PreparationError("stage geometry differs from affine transform")
        combined = compose((stage.matrix, stage.translation), combined)
    em, et = float(np.max(abs(combined[0]-M))), float(np.max(abs(combined[1]-v)))
    if not np.all(np.isfinite(combined[0])) or not np.all(np.isfinite(combined[1])) or em > 1e-10 or et > 1e-8:
        raise PreparationError("plan endpoint differs from selected model operation")
    contents = dict(math_version=1, model=model.model_id, frame=model.frame_id,
                              operation=operation_index, mode=mode,
                              stages=[asdict(stage) for stage in stages])
    if identity_context is not None:
        contents["identity_context"] = identity_context
    plan_id = _id("plan", contents)
    return DecompositionPlan(plan_id, model.model_id, model.frame_id, operation_index,
                             mode, tuple(stages), em, et)
