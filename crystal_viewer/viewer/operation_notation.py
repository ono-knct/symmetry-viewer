"""Conventional names with explicit geometry and unreduced translations.

Names are annotations on the common plan, never alternative operations. The
numeric angle remains authoritative; a finite name has a recorded angular
residual. Numeric Custom angles need not receive a finite-order name.
"""
from dataclasses import dataclass
from fractions import Fraction
from functools import reduce
from math import gcd, lcm

import numpy as np

from crystal_viewer.affine_math import integer_nullspace
from crystal_viewer.symmetry_model import _tuple
from crystal_viewer.viewer.plan_presentation import PlanPresentation, present_plan, NumberFormatter, PresentationContext


@dataclass(frozen=True)
class NamedFactor:
    symbol: str
    # Rotation R(2*pi*k/n), then the indicated reflection/inversion factors.
    rotation_n: int | None
    rotation_k: int | None
    angle_residual_rad: float | None
    rotation_provenance: str = "not_applicable"


@dataclass(frozen=True)
class OperationNotation:
    model_id: str
    frame_id: str
    plan_id: str
    name: str
    factors: tuple[NamedFactor, ...]
    geometry: PlanPresentation
    intrinsic_translation: tuple
    axial_period: tuple | None
    axial_period_fraction: tuple | None
    period_membership_residual: float | None
    screw_subscript: int | None
    screw_remainder: tuple | None
    glide_letter: str | None
    provenance: str = "derived_from_plan_numeric"


def _rotation_name(angle, periodic):
    turns = Fraction(float(angle/(2*np.pi))).limit_denominator(120)
    error = float(abs(angle-2*np.pi*float(turns)))
    if error > 1e-10:
        return NamedFactor("R(angle)", None, None, None, "numeric_angle")
    n, k = turns.denominator, turns.numerator
    symbol = (str(n) if periodic else f"C_{n}") + (f"^{k}" if k != 1 else "")
    return NamedFactor(symbol, n, k, error, "rational_turn_candidate")


class NotationContext:
    """Common inputs/results for one projection of one immutable model.

    The view keeps this local to _project; it is never published or shared
    between cells, requests or quiz sessions. Full plan notation is not cached.
    """
    def __init__(self, model):
        self.model = model
        self._centering = None
        self._periods = {}
        self.number_formatter = NumberFormatter()
        self.presentation_context = PresentationContext(model)

    def require_model(self, model):
        if model is not self.model:
            raise ValueError("notation context belongs to another model")

    def axis_period(self, model, W):
        self.require_model(model)
        key = tuple(tuple(row) for row in W)
        if key not in self._periods:
            if self._centering is None:
                self._centering = [np.array(t) for A, t in zip(model.matrices, model.translations)
                                   if np.array_equal(np.array(A), np.eye(3))]
            result = _axis_period(model, W, centering=self._centering)
            if result is not None:
                result[0].setflags(write=False)
            self._periods[key] = result
        return self._periods[key]


def _axis_period(model, W, *, centering=None):
    """Shortest positive lattice vector on an integer primitive axis.

    For C pure-translation cosets, Lambda/Z^3 has order C, so every coset
    order divides C. A primitive integer axis can therefore be tested at
    k/C, k=1..C, without a guessed rational denominator or a bounded search.
    The coset membership itself is numerical and its residual is retained.
    """
    kernel = integer_nullspace(W-np.eye(3))
    if len(kernel) != 1:
        return None
    scale = lcm(*(v.denominator for v in kernel[0]))
    d = [int(v*scale) for v in kernel[0]]
    divisor = reduce(gcd, d)
    d = np.array([v//divisor for v in d])
    if next(v for v in d if v) < 0:
        d = -d
    if centering is None:
        centering = [np.array(t) for A, t in zip(model.matrices, model.translations)
                     if np.array_equal(np.array(A), np.eye(3))]
    count = len(centering)
    for k in range(1, count+1):
        q = Fraction(k, count)
        p = float(q)*d
        error = min(float(np.max(abs(p-t-np.rint(p-t)))) for t in centering)
        if error <= 1e-10:
            return p, (q.numerator, q.denominator), error
    raise ValueError("verified translation lattice has no axial cell period")


def _glide(model, g):
    # Inspect the actual g, never g modulo a shorter lattice translation.
    nonzero = np.flatnonzero(abs(g) > 1e-10)
    if not len(nonzero):
        return "m"
    values = abs(g[nonzero])
    if len(nonzero) == 1 and abs(values[0]-.5) <= 1e-10:
        return "abc"[nonzero[0]]
    if len(nonzero) in (2, 3) and np.max(abs(values-.5)) <= 1e-10:
        return "n"
    if len(nonzero) >= 2 and np.max(abs(values-.25)) <= 1e-10:
        # A diamond glide is half a nontrivial centering vector. A quarter
        # diagonal alone does not establish that lattice condition.
        for A, t in zip(model.matrices, model.translations):
            if np.array_equal(A, np.eye(3)):
                delta = 2*g-t
                if np.max(abs(delta-np.rint(delta))) <= 1e-10:
                    return "d"
    return "g"


def name_plan(model, plan, *, context=None):
    plan.require_model(model)
    if context is not None:
        context.require_model(model)
    if plan.operation_index is None and plan.mode != "default":
        raise ValueError("conventional names require a Standard or decomposed composition plan")
    geometry = present_plan(model, plan, number_formatter=None if context is None else context.number_formatter,
                            context=None if context is None else context.presentation_context)
    factors = []
    B = np.array(model.lattice).T if model.periodic else np.eye(3)
    g = np.zeros(3)
    for stage in plan.stages:
        if stage.kind == "rotation":
            factors.append(_rotation_name(stage.angle_rad, model.periodic))
        else:
            symbol = dict(reflection="m" if model.periodic else "sigma",
                          inversion="-1" if model.periodic else "i",
                          translation="t", affine="A")[stage.kind]
            factors.append(NamedFactor(symbol, None, None, None))
        if stage.kind == "translation":
            g += np.linalg.solve(B, stage.translation)
    active = [i for i, s in enumerate(plan.stages) if s.kind != "translation"]
    name = " -> ".join(factors[i].symbol for i in active) or ("1" if model.periodic else "E")
    period = fraction = membership = subscript = remainder = glide = None
    if len(active) == 2:
        first, second = active
        rotation, last = factors[first], plan.stages[second]
        if (plan.stages[first].kind == "rotation" and rotation.rotation_n is not None
                and abs(rotation.rotation_k) == 1):
            suffix = "^-1" if rotation.rotation_k < 0 else ""
            if last.kind == "inversion":
                name = f"bar({rotation.rotation_n})"+suffix
            elif last.kind == "reflection":
                name = f"S_{rotation.rotation_n}"+suffix
    elif len(active) == 1 and model.periodic and plan.operation_index is not None:
        stage = plan.stages[active[0]]
        if stage.kind == "rotation":
            W, _ = model.operation_components(plan.operation_index)
            # Only finite crystallographic matrices have integer kernels.
            if np.array_equal(W, np.rint(W)):
                result = _axis_period(model, W) if context is None else context.axis_period(model, W)
                if result is not None:
                    p, fraction, membership = result
                    period = _tuple(p)
                    angle = factors[active[0]]
                    ratio = float(np.dot(g, p)/np.dot(p, p))
                    step = ratio*(angle.rotation_n or 1)*np.sign(stage.angle_rad)
                    if (angle.rotation_n in (2, 3, 4, 6) and abs(angle.rotation_k) == 1
                            and np.max(abs(g-ratio*p)) <= 1e-10 and abs(step-round(step)) <= 1e-10):
                        subscript = int(round(step)) % angle.rotation_n
                        base = np.sign(stage.angle_rad)*subscript/angle.rotation_n*p
                        remainder = _tuple(g-base)
                        name = f"{angle.rotation_n}"+(f"_{subscript}" if subscript else "")
                        name += "^-1" if angle.rotation_k < 0 else ""
        elif stage.kind == "reflection":
            glide = _glide(model, g)
            name = glide
    # The compact name alone never hides full periods, sign, axis or position.
    # Its explicit translation is the whole g (not just screw_remainder).
    if np.any(g != 0):
        vector = ", ".join(n.text for n in geometry.stages[-1].translation) if plan.stages[-1].kind == "translation" else repr(_tuple(g))
        name += f"; full t=({vector})"
    return OperationNotation(model.model_id, model.frame_id, plan.plan_id, name,
        tuple(factors), geometry, _tuple(g), period, fraction, membership,
        subscript, remainder, glide)
