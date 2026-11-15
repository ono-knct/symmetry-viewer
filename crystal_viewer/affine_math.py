"""Small parser/viewer-independent affine primitives for the model migration."""
from dataclasses import dataclass
from fractions import Fraction

import numpy as np


def integer_nullspace(matrix):
    """Exact rational kernel of a supplied integer matrix, with no inference.

    Decimal-valued entries are rejected, never rationalized component by
    component after an SVD. Returned Fractions are constructed exact values.
    """
    array = np.asarray(matrix)
    if array.ndim != 2 or not np.all(np.isfinite(array.astype(float))):
        raise ValueError("finite matrix required")
    if any(value != int(value) for value in array.flat):
        raise ValueError("integer entries required")
    rows = [[Fraction(int(value)) for value in row] for row in array]
    pivots = []
    for col in range(array.shape[1]):
        rank = len(pivots)
        chosen = next((i for i in range(rank, len(rows)) if rows[i][col]), None)
        if chosen is None:
            continue
        rows[rank], rows[chosen] = rows[chosen], rows[rank]
        divisor = rows[rank][col]
        rows[rank] = [x / divisor for x in rows[rank]]
        for i in range(len(rows)):
            if i != rank:
                factor = rows[i][col]
                rows[i] = [x - factor*y for x, y in zip(rows[i], rows[rank])]
        pivots.append(col)
    basis = []
    for free in range(array.shape[1]):
        if free in pivots:
            continue
        vector = [Fraction(0)] * array.shape[1]
        vector[free] = Fraction(1)
        for row, pivot in zip(rows, pivots):
            vector[pivot] = -row[free]
        basis.append(tuple(vector))
    return tuple(basis)


def compose(after, before):
    """(W,t) composition in named order; retain complete translations."""
    Wa, ta = map(np.asarray, after)
    Wb, tb = map(np.asarray, before)
    return Wa @ Wb, Wa @ tb + ta


def change_coordinates(operation, basis, origin):
    """x_old = basis @ x_new + origin; this does not correct any geometry."""
    W, t = map(np.asarray, operation)
    P, o = np.asarray(basis), np.asarray(origin)
    return np.linalg.solve(P, W @ P), np.linalg.solve(P, t + (W - np.eye(3)) @ o)


@dataclass(frozen=True)
class OperationRelation:
    relation: str
    cell_translation: tuple | None
    matrix_residual: float
    translation_residual: float
    tolerance: float


def compare_operations(left, right, *, atol=1e-10):
    """Numerical relation in one frame; never substitutes an operation.

    A centering translation is deliberately not an integer-cell match.
    Frame/model identity is checked by callers before passing numeric arrays.
    """
    Wl, tl = map(np.asarray, left)
    Wr, tr = map(np.asarray, right)
    em = float(np.max(abs(Wl - Wr)))
    delta = tl - tr
    cell = np.rint(delta)
    if em <= atol and np.max(abs(delta)) <= atol:
        return OperationRelation("same_affine_numeric", (0, 0, 0), em, float(np.max(abs(delta))), atol)
    if em <= atol and np.max(abs(delta - cell)) <= atol:
        return OperationRelation("same_mod_cell_numeric", tuple(int(v) for v in cell), em,
                                 float(np.max(abs(delta - cell))), atol)
    return OperationRelation("different", None, em, float(np.max(abs(delta))), atol)
