"""Cell-intersecting representatives of verified periodic operations.

Only t' = t + (I-W)s, s in Z^3, is allowed. The integer image test uses
determinantal divisors, not a floating solution rounded to a lattice vector.
Each operation is optimized independently; the selected integer offsets then
transport the *entire* verified atom action and product cocycle together.
"""
from dataclasses import dataclass, replace
from itertools import combinations, product
from math import gcd, prod

import numpy as np

from crystal_viewer.affine_math import integer_nullspace
from crystal_viewer.symmetry_model import (
    PreparationError, _id, _tuple, _validate_atom_composition,
)

POLICY = "cell-intersection-v1"
VERTICES = np.array(list(product((0., 1.), repeat=3)))
EDGES = tuple((i, j) for i in range(8) for j in range(i)
              if np.count_nonzero(VERTICES[i] != VERTICES[j]) == 1)
GEOMETRY_TOLERANCE = 1e-10


def _det(rows):
    if not rows:
        return 1
    return sum((-1)**j * value * _det([r[:j]+r[j+1:] for r in rows[1:]])
               for j, value in enumerate(rows[0]))


def _minors(A, size):
    return [_det([[int(A[i, j]) for j in cols] for i in rows])
            for rows in combinations(range(3), size)
            for cols in combinations(range(3), size)]


def _minor_coefficients(A, size):
    """Coefficients of minors whose last column is the candidate offset."""
    result = []
    for rows in combinations(range(3), size):
        for cols in combinations(range(3), size-1):
            coefficients = [0, 0, 0]
            for i, row in enumerate(rows):
                rest = rows[:i]+rows[i+1:]
                coefficients[row] = (-1)**(i+size-1) * _det(
                    [[int(A[r, j]) for j in cols] for r in rest])
            result.append(coefficients)
    return np.array(result, dtype=np.int64).reshape(-1, 3)


class IntegerImage:
    """Exact membership in A Z^3 via rank and the gcd of maximal minors.

    Appending n must preserve the rational span and its lattice index. The
    new rank-r minors are linear in n and must be divisible by the existing
    determinantal divisor; all rank-(r+1) minors must vanish.
    """
    def __init__(self, A):
        raw = np.asarray(A)
        if raw.shape != (3, 3) or not np.all(np.isfinite(raw)) or not np.array_equal(raw, np.rint(raw)):
            raise PreparationError("integer 3x3 lattice map required")
        # Crystallographic matrices are small. Reject arithmetic that would
        # overflow the exact int64 minor/offset calculations.
        if max(abs(int(v)) for v in raw.flat) > 10000:
            raise PreparationError("lattice map exceeds exact arithmetic bound")
        self.A = raw.astype(np.int64)
        self.rank = next((r for r in (3, 2, 1) if any(_minors(self.A, r))), 0)
        self.divisor = gcd(*_minors(self.A, self.rank)) if self.rank else 1
        self.divisibility = _minor_coefficients(self.A, self.rank) if self.rank else np.eye(3, dtype=np.int64)
        self.zero = _minor_coefficients(self.A, self.rank+1) if self.rank < 3 else np.empty((0, 3), dtype=np.int64)

    def contains(self, offset):
        value = np.asarray(offset)
        if value.shape != (3,) or not np.all(np.isfinite(value)) or not np.array_equal(value, np.rint(value)):
            return False
        if max(abs(int(v)) for v in value) > 1000000:
            raise PreparationError("representative offset exceeds exact arithmetic bound")
        n = value.astype(np.int64)
        return not (np.any((self.divisibility @ n) % self.divisor) or np.any(self.zero @ n))


def line_cell_section(point, direction, lower=0., margin=0.):
    """Fractional line clipped to the actual (possibly oblique) basis cell."""
    lo, hi = -np.inf, np.inf
    minimum, maximum = lower-margin, lower+1+margin
    for p, d in zip(point, direction):
        if abs(d) < GEOMETRY_TOLERANCE:
            if p < minimum-GEOMETRY_TOLERANCE or p > maximum+GEOMETRY_TOLERANCE:
                return None
        else:
            a, b = sorted(((minimum-p)/d, (maximum-p)/d))
            lo, hi = max(lo, a), min(hi, b)
    if hi < lo-GEOMETRY_TOLERANCE:
        return None
    return float(lo), float(max(lo, hi))


def plane_cell_section(normal, offset, B, lower=0.):
    vertices = VERTICES+lower
    values = vertices @ normal-offset
    points = []
    for i, j in EDGES:
        a, b = values[i], values[j]
        if abs(a) <= GEOMETRY_TOLERANCE:
            points.append(vertices[i])
        if abs(b) <= GEOMETRY_TOLERANCE:
            points.append(vertices[j])
        if a*b < 0 and abs(a) > GEOMETRY_TOLERANCE and abs(b) > GEOMETRY_TOLERANCE:
            points.append(vertices[i]+a/(a-b)*(vertices[j]-vertices[i]))
    unique = []
    for p in points:
        if not any(np.max(abs(p-q)) <= GEOMETRY_TOLERANCE for q in unique):
            unique.append(p)
    if not unique:
        return np.empty((0, 3)), 0.
    xyz = np.array(unique) @ B.T
    if len(xyz) < 3:
        return xyz, 0.
    center = xyz.mean(axis=0)
    n = np.linalg.solve(B.T, normal)
    n /= np.linalg.norm(n)
    v = xyz[0]-center
    v /= np.linalg.norm(v)
    u = np.cross(n, v)
    xyz = xyz[np.argsort(np.arctan2((xyz-center) @ u, (xyz-center) @ v))]
    area = abs(float(np.dot(np.cross(xyz-center, np.roll(xyz, -1, axis=0)-center).sum(axis=0), n)))/2
    return xyz, area


class _Geometry:
    def __init__(self, W):
        self.image = IntegerImage(np.eye(3, dtype=int)-W)
        self.A = self.image.A
        power, total = np.eye(3, dtype=int), np.zeros((3, 3), dtype=int)
        for order in range(1, 121):
            total += power
            power = W @ power
            if np.array_equal(power, np.eye(3, dtype=int)):
                break
        else:
            raise PreparationError("representative matrix order is not finite")
        self.P = total/order
        self.inverse = np.linalg.pinv(self.A)
        kernel = integer_nullspace(self.A)
        self.direction = np.array(kernel[0], dtype=float) if self.image.rank == 2 else None
        improper_kernel = integer_nullspace(W+np.eye(3, dtype=int))
        self.improper_axis = np.array(improper_kernel[0], dtype=float) if len(improper_kernel) == 1 else None

    def score(self, t, B, lower):
        local = t-self.P @ t
        point = self.inverse @ local
        center = np.full(3, lower+.5)
        rank = self.image.rank
        if rank == 3:
            if np.any(point < lower-GEOMETRY_TOLERANCE) or np.any(point > lower+1+GEOMETRY_TOLERANCE):
                return None
            length = 0.
            if self.improper_axis is not None:
                section = line_cell_section(point, self.improper_axis, lower)
                if section:
                    length = (section[1]-section[0])*np.linalg.norm(B @ self.improper_axis)
            return length, float(np.linalg.norm(B @ (point-center))), B @ point
        if rank == 2:
            d = self.direction
            section = line_cell_section(point, d, lower)
            if section is None:
                return None
            dc, delta = B @ d, B @ (center-point)
            parameter = float(np.dot(delta, dc)/np.dot(dc, dc))
            anchor = point+np.clip(parameter, *section)*d
            distance = np.linalg.norm(delta-dc*parameter)
            return (section[1]-section[0])*float(np.linalg.norm(dc)), float(distance), B @ anchor
        row = int(np.argmax(np.linalg.norm(self.A, axis=1)))
        h, offset = self.A[row], local[row]
        polygon, area = plane_cell_section(h, offset, B, lower)
        if not len(polygon):
            return None
        normal = np.linalg.solve(B.T, h)
        projected = B @ center-normal*((np.dot(h, center)-offset)/np.dot(normal, normal))
        fractional = np.linalg.solve(B, projected)
        if np.any(fractional < lower-GEOMETRY_TOLERANCE) or np.any(fractional > lower+1+GEOMETRY_TOLERANCE):
            # The closest point of the finite polygon is on an edge.
            candidates = []
            for a, b in zip(polygon, np.roll(polygon, -1, axis=0)):
                edge = b-a
                q = a+edge*np.clip(np.dot(projected-a, edge)/np.dot(edge, edge), 0, 1) if np.dot(edge, edge) else a
                candidates.append(q)
            projected = min(candidates, key=lambda q: np.linalg.norm(q-B @ center))
        distance = abs(float(np.dot(h, center)-offset))/np.linalg.norm(normal)
        return area, distance, projected


def _saved_records(payload, model):
    record = payload.get("verified_export", {}).get("cell_representatives")
    if record is None:
        return {}
    if not isinstance(record, dict) or record.get("policy") != POLICY or type(record.get("version")) is not int or record["version"] != 1:
        raise PreparationError("invalid saved representative policy")
    items = record.get("operations")
    if not isinstance(items, list) or len(items) != len(model.matrices):
        raise PreparationError("invalid saved representative operations")
    by_index = {}
    for item in items:
        if not isinstance(item, dict) or type(item.get("operation_index")) is not int or item["operation_index"] in by_index:
            raise PreparationError("invalid saved representative index")
        index = item["operation_index"]
        W, t = model.operation_components(index)
        source = np.asarray(item.get("source_translation"), dtype=float)
        selected = np.asarray(item.get("translation"), dtype=float)
        matrix = np.asarray(item.get("matrix"), dtype=float)
        if source.shape != (3,) or selected.shape != (3,) or matrix.shape != (3, 3) or not all(np.all(np.isfinite(v)) for v in (source, selected, matrix)):
            raise PreparationError("invalid saved representative geometry")
        delta = selected-source
        if (not np.array_equal(matrix, W) or np.max(abs(selected-t)) > 1e-10
                or np.max(abs(delta-np.rint(delta))) > 1e-10
                or not IntegerImage(np.eye(3)-W).contains(np.rint(delta))):
            raise PreparationError("saved representative does not match current verified operation")
        by_index[index] = item
    if set(by_index) != set(model.correspondence.operation_indices):
        raise PreparationError("saved representative coverage mismatch")
    return by_index


@dataclass(frozen=True)
class RepresentativeSelection:
    model: object
    anchors: tuple
    record: dict


def select_representatives(model, payload, *, lower=0.):
    if not model.periodic:
        return RepresentativeSelection(model, (), {})
    if lower not in (0., -.5):
        raise PreparationError("unsupported representative cell bounds")
    saved = _saved_records(payload, model)
    B = np.array(model.lattice).T
    cache, translations, offsets, anchors, records = {}, [], [], [], []
    scale = max(1., float(np.linalg.norm(B, ord=2)))
    for index, raw_W, raw_t in zip(model.correspondence.operation_indices, model.matrices, model.translations):
        if max(abs(int(v)) for row in raw_W for v in row) > 9999:
            raise PreparationError("representative matrix exceeds exact arithmetic bound")
        W, t = np.array(raw_W, dtype=int), np.array(raw_t)
        key = tuple(W.flat)
        if key not in cache:
            cache[key] = _Geometry(W)
        geometry = cache[key]
        best = None
        if geometry.image.rank:
            # If the element meets the cell, t'=(I-W)p+g for a point p in
            # that cell. Linear extrema at its vertices give a complete,
            # finite bound on n=t'-t; there is no guessed nearby-cell radius.
            bounds = (VERTICES+lower) @ geometry.A.T+geometry.P @ t-t
            lo = np.ceil(bounds.min(axis=0)-GEOMETRY_TOLERANCE).astype(int)
            hi = np.floor(bounds.max(axis=0)+GEOMETRY_TOLERANCE).astype(int)
            if prod(max(0, b-a+1) for a, b in zip(lo, hi)) > 100000:
                raise PreparationError("representative candidate bound exceeds preparation limit")
            for n in product(*(range(a, b+1) for a, b in zip(lo, hi))):
                n = np.array(n, dtype=int)
                if not geometry.image.contains(n):
                    continue
                selected = t+n
                score = geometry.score(selected, B, lower)
                if score is None:
                    continue
                coverage, distance, anchor = score
                # Normalize physical scores before the numerical tie rule.
                dimension = 2 if geometry.image.rank == 1 else 1
                ranking = (-round(coverage/scale**dimension, 10), round(distance/scale, 10), tuple(selected))
                if best is None or ranking < best[0]:
                    best = ranking, selected, n, anchor
            if best is None:
                raise PreparationError("no cell-intersecting representative verified")
            _, selected, n, anchor = best
        else:
            selected, n, anchor = t, np.zeros(3, dtype=int), None
        translations.append(selected)
        offsets.append(n)
        anchors.append(None if anchor is None else _tuple(anchor))
        source = saved.get(index, {}).get("source_translation", t.tolist())
        records.append(dict(operation_index=index, matrix=W.tolist(), source_translation=source,
                            translation=selected.tolist(), cell_offset=np.rint(selected-source).astype(int).tolist()))

    W = np.array(model.matrices, dtype=int)
    old_t, new_t, n = np.array(model.translations), np.array(translations), np.array(offsets, dtype=int)
    table = np.array(model.product_table, dtype=int)
    shifts = np.array(model.product_cell_shifts, dtype=int)
    images = np.array(model.image_shifts, dtype=int)+n[:, None, :]
    # Transport the complete product cocycle. Check every g/h and every atom,
    # including integer periodic images, against the new full translations.
    new_shifts = shifts+n[:, None, :]+np.einsum("gij,hj->ghi", W, n)-n[table]
    closure_error = 0.
    for g in range(len(W)):
        residual = new_t @ W[g].T+new_t[g]-new_t[table[g]]-new_shifts[g]
        closure_error = max(closure_error, float(np.max(abs(residual))))
    tolerance = model.validation.residual_tolerance
    if closure_error > tolerance:
        raise PreparationError("representative product residual exceeded")
    permutations = np.array(model.permutations, dtype=int)
    _validate_atom_composition(W, permutations, images, table, new_shifts, tolerance)
    points = np.array(model.positions)
    residual = points[None, :, :] @ W.transpose(0, 2, 1)+new_t[:, None, :]-points[permutations]-images
    atom_error = float(np.max(np.linalg.norm(residual @ B.T, axis=2)))
    if atom_error > tolerance:
        raise PreparationError("representative atom residual exceeded")
    identity = _id("cell_representatives", [POLICY, model.model_id, lower, _tuple(new_t), anchors])
    selected_model = replace(model, model_id=identity, frame_id=_id("frame", [identity, "fractional"]),
        translations=_tuple(new_t),
        image_shifts=tuple(tuple(map(tuple, row)) for row in images.tolist()),
        product_cell_shifts=tuple(tuple(map(tuple, row)) for row in new_shifts.tolist()),
        correspondence=replace(model.correspondence, operation_cell_offsets=_tuple(n)),
        validation=replace(model.validation, atom_residual_max_A=atom_error,
            closure_translation_residual=closure_error,
            numeric_provenance=model.validation.numeric_provenance+"; verified integer-cell representative transport"))
    record = dict(version=1, policy=POLICY, cell_lower=lower,
                  source_model_id=model.model_id, operations=records)
    return RepresentativeSelection(selected_model, tuple(anchors), record)
