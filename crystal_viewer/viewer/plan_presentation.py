"""Geometric factorization and coordinate formulas from the same shadow plan.

This is renderer-independent presentation data, not a replacement for the
existing UI's conventional ITC/Schoenflies names or its MathML renderer.
Displayed fractions are explicitly numerical candidates with recorded errors.
"""
from dataclasses import dataclass
import struct
from fractions import Fraction

import numpy as np

from crystal_viewer.affine_math import compose
from crystal_viewer.symmetry_model import PreparationError
from crystal_viewer.viewer.operation_plan import _rotation


@dataclass(frozen=True)
class DisplayNumber:
    text: str
    provenance: str
    model_numeric_value: float
    candidate_error: float


@dataclass(frozen=True)
class PresentedStage:
    kind: str
    point: tuple
    direction: tuple
    plane_offset: DisplayNumber | None
    angle_degrees: DisplayNumber | None
    translation: tuple
    affine_matrix: tuple = ()
    coordinate_formula: tuple = ()


@dataclass(frozen=True)
class PlanPresentation:
    model_id: str
    frame_id: str
    plan_id: str
    coordinate_space: str
    coordinate_formula: tuple
    coefficients: tuple
    constants: tuple
    stages: tuple[PresentedStage, ...]
    factorization_text: str
    geometry_matrix_residual: float
    geometry_translation_residual_A: float
    formula_matrix_residual: float
    formula_translation_residual_A: float


def _number(value, candidates):
    value = float(value)
    fraction = Fraction(value).limit_denominator(120)
    if candidates and abs(float(fraction)-value) <= 1e-12:
        return DisplayNumber(str(fraction), "rational_candidate", value, abs(float(fraction)-value))
    return DisplayNumber(repr(value), "numeric", value, 0.)


class NumberFormatter:
    """Exact-input memoization for one projection; never caches validation.

    Binary keys preserve signed zero and distinguish nearby floats. Values
    are frozen DisplayNumber objects. No global or persistent cache is used.
    """
    def __init__(self):
        self._numbers = {}
        self._values = {}

    def __call__(self, value, candidates):
        key = (struct.pack("!d", float(value)), candidates)
        if key not in self._numbers:
            self._numbers[key] = _number(value, candidates)
        return self._numbers[key]

    def value(self, number):
        # Parse the displayed spelling, never substitute model_numeric_value.
        if number.text not in self._values:
            self._values[number.text] = _value(number)
        return self._values[number.text]


class PresentationContext:
    """Coordinate bases for one projection; no plan or validation is cached."""
    def __init__(self, model):
        self.model = model
        self._bases = {}

    def basis(self, model, space):
        if model is not self.model:
            raise ValueError("presentation context belongs to another model")
        if space not in self._bases:
            B = np.array(model.lattice).T if space == "fractional" else np.eye(3)
            inverse = np.linalg.inv(B)
            B.setflags(write=False)
            inverse.setflags(write=False)
            self._bases[space] = B, inverse
        return self._bases[space]


def _value(number):
    return float(Fraction(number.text))


def _array(numbers, value_reader=_value):
    return np.array([value_reader(n) for n in numbers])


def _expression(coefficients, constant, value_reader=_value):
    result = ""
    for number, variable in list(zip(coefficients, "xyz"))+[(constant, "")]:
        value = value_reader(number)
        if value == 0:
            continue
        magnitude = number.text.removeprefix("-")
        term = (variable if abs(value) == 1 else f"({magnitude})*{variable}") if variable else magnitude
        result += ((" - " if value < 0 else " + ") if result else "-" if value < 0 else "")+term
    return result or "0"


def _endpoint(stages, B, *, value_reader=_value):
    def array(numbers):
        return _array(numbers, value_reader)
    total = (np.eye(3), np.zeros(3))
    for stage in stages:
        if stage.kind == "translation":
            pair = (np.eye(3), B@array(stage.translation))
        elif stage.kind == "inversion":
            pair = (-np.eye(3), 2*B@array(stage.point))
        elif stage.kind == "reflection":
            h = array(stage.direction)
            normal = np.linalg.solve(B.T, h)
            norm = np.linalg.norm(normal)
            normal /= norm
            pair = (np.eye(3)-2*np.outer(normal, normal),
                    2*normal*value_reader(stage.plane_offset)/norm)
        elif stage.kind == "affine":
            pair = (B@np.array([array(row) for row in stage.affine_matrix])@np.linalg.inv(B),
                    B@array(stage.translation))
        elif stage.kind == "rotation":
            n = B@array(stage.direction); n /= np.linalg.norm(n)
            R = _rotation(n, np.deg2rad(value_reader(stage.angle_degrees)))
            center = B@array(stage.point)
            pair = (R, center-R@center)
        else:
            raise ValueError("unknown plan stage")
        total = compose(pair, total)
    return total


def present_plan(model, plan, *, coordinate_space=None, number_formatter=None, context=None):
    plan.require_model(model)
    space = coordinate_space or ("fractional" if model.periodic else "cartesian_A")
    if space not in ("fractional", "cartesian_A") or (space == "fractional" and not model.periodic):
        raise ValueError("coordinate space is not available for this model")
    if context is None:
        B = np.array(model.lattice).T if space == "fractional" else np.eye(3)
        inv = np.linalg.inv(B)
    else:
        B, inv = context.basis(model, space)
    expected = (np.eye(3), np.zeros(3))
    for stage in plan.stages:
        expected = compose((stage.matrix, stage.translation), expected)
    raw_coefficients, raw_constants = inv@expected[0]@B, inv@expected[1]
    number = _number if number_formatter is None else number_formatter
    value = number_formatter.value if isinstance(number_formatter, NumberFormatter) else _value
    # Prefer readable fractions only when the entire displayed transform passes.
    for candidates in (True, False):
        def numbers(values):
            return tuple(number(v, candidates) for v in values)
        displayed = []
        stage_formulas_valid = True
        for stage in plan.stages:
            point = direction = translation = ()
            affine_matrix = ()
            offset = angle = None
            if stage.kind in ("rotation", "inversion"):
                point = numbers(inv@stage.center)
            if stage.kind == "rotation":
                vector = inv@stage.direction
                scale = next(abs(v) for v in vector if abs(v) > 1e-12)
                direction = numbers(vector/scale)
                angle = number(np.degrees(stage.angle_rad), candidates)
            elif stage.kind == "reflection":
                h = B.T@stage.direction
                scale = next(abs(v) for v in h if abs(v) > 1e-12)
                direction = numbers(h/scale)
                offset = number(np.dot(stage.direction, stage.center)/scale, candidates)
            elif stage.kind == "translation":
                translation = numbers(inv@stage.translation)
            elif stage.kind == "affine":
                affine_matrix = tuple(numbers(row) for row in inv@stage.matrix@B)
                translation = numbers(inv@stage.translation)
            stage_coefficients = tuple(numbers(row) for row in inv@stage.matrix@B)
            stage_constants = numbers(inv@stage.translation)
            stage_M = B@np.array([_array(row, value) for row in stage_coefficients])@inv
            stage_v = B@_array(stage_constants, value)
            stage_formulas_valid &= (np.max(abs(stage_M-stage.matrix)) <= 1e-10
                                     and np.max(abs(stage_v-stage.translation)) <= 1e-8)
            stage_formula = tuple(_expression(row, constant, value)
                                  for row, constant in zip(stage_coefficients, stage_constants))
            displayed.append(PresentedStage(stage.kind, point, direction, offset, angle,
                                            translation, affine_matrix, stage_formula))
        coefficients = tuple(numbers(row) for row in raw_coefficients)
        constants = numbers(raw_constants)
        actual = _endpoint(displayed, B, value_reader=value)
        formula_M = B@np.array([_array(row, value) for row in coefficients])@inv
        formula_v = B@_array(constants, value)
        errors = (float(np.max(abs(actual[0]-expected[0]))), float(np.max(abs(actual[1]-expected[1]))),
                  float(np.max(abs(formula_M-expected[0]))), float(np.max(abs(formula_v-expected[1]))))
        if stage_formulas_valid and errors[0] <= 1e-10 and errors[1] <= 1e-8 and errors[2] <= 1e-10 and errors[3] <= 1e-8:
            break
    else:
        raise PreparationError("displayed geometric/formula reconstruction failed")
    def vector(values): return "("+", ".join(n.text for n in values)+")"
    descriptions = []
    for stage in displayed:
        if stage.kind == "rotation":
            descriptions.append(f"R({stage.angle_degrees.text} deg; p={vector(stage.point)}, u={vector(stage.direction)})")
        elif stage.kind == "reflection":
            descriptions.append(f"m(h={vector(stage.direction)}, d={stage.plane_offset.text})")
        elif stage.kind == "inversion":
            descriptions.append(f"i(c={vector(stage.point)})")
        elif stage.kind == "affine":
            descriptions.append(f"A(W=[{', '.join(vector(row) for row in stage.affine_matrix)}], t={vector(stage.translation)})")
        else:
            descriptions.append(f"t{vector(stage.translation)}")
    return PlanPresentation(model.model_id, model.frame_id, plan.plan_id,
        space,
        tuple(_expression(row, constant, value) for row, constant in zip(coefficients, constants)),
        coefficients, constants, tuple(displayed), " -> ".join(descriptions), *errors)
