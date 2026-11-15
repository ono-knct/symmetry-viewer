"""Generator summaries from verified finite or continuous models, before publish."""
from collections import deque

import numpy as np

from crystal_viewer.symmetry_model import PreparationError
from crystal_viewer.viewer.operation_notation import name_plan


def generator_slots(table):
    """The existing greedy selection order, using the verified product table."""
    table = np.asarray(table, dtype=int)
    size = len(table)
    identity = next(i for i in range(size) if np.array_equal(table[i], np.arange(size))
                    and np.array_equal(table[:, i], np.arange(size)))
    selected, generated = [], {identity}
    while len(generated) < size:
        best, best_closure = None, generated
        for candidate in range(size):
            if candidate in generated:
                continue
            closure = set(generated)
            queue = deque(sorted(closure))
            generators = selected + [candidate]
            while queue:
                element = queue.popleft()
                for generator in generators:
                    product = int(table[element, generator])
                    if product not in closure:
                        closure.add(product)
                        queue.append(product)
            if len(closure) > len(best_closure):
                best, best_closure = candidate, closure
        if best is None:
            raise PreparationError("verified generator coverage is incomplete")
        selected.append(best)
        generated = best_closure
    return selected


def model_metadata(model, plans):
    if model.periodic:
        return crystal_metadata(model, plans)
    if model.continuous is not None:
        generators = ["C∞", "σv"]
        if model.continuous.axial_reversal:
            generators.append("σh")
        return dict(point_group_generators=generators)
    selected = generator_slots(model.product_table)
    plan_by_index = {p.operation_index: p for p in plans if p.mode == "rotoreflection"}
    labels = []
    for slot in selected:
        index = model.correspondence.operation_indices[slot]
        plan = plan_by_index[index]
        notation = name_plan(model, plan)
        kinds = [s.kind for s in plan.stages if s.kind != "translation"]
        if kinds == ["rotation", "reflection"]:
            order = next(f.rotation_n for f in notation.factors if f.rotation_n)
            labels.append("i" if order == 2 else f"S{order}")
        elif kinds == ["reflection"]:
            labels.append("σ")
        elif kinds == ["rotation"]:
            order = next(f.rotation_n for f in notation.factors if f.rotation_n)
            labels.append(f"C{order}")
        elif not kinds:
            labels.append("E")
        else:
            raise PreparationError("unknown molecular generator geometry")
    return dict(point_group_generators=labels or ["identity only"],
        generator_operations=dict(point=[model.correspondence.operation_indices[i] for i in selected]))


def crystal_metadata(model, plans):
    if not model.periodic:
        return {}
    table = np.asarray(model.product_table, dtype=int)
    classes, representatives, class_of = {}, [], []
    for slot, W in enumerate(model.matrices):
        key = tuple(tuple(row) for row in W)
        if key not in classes:
            classes[key] = len(representatives)
            representatives.append(slot)
        class_of.append(classes[key])
    class_of = np.asarray(class_of)
    point_table = class_of[table[np.ix_(representatives, representatives)]]
    chosen = dict(space=generator_slots(table),
                  point=[representatives[i] for i in generator_slots(point_table)])
    plan_by_key = {(p.operation_index, p.mode): p for p in plans}

    def label(slot, point=False):
        index = model.correspondence.operation_indices[slot]
        plan = plan_by_key[index, "default"]
        notation = name_plan(model, plan)
        kinds = [s.kind for s in plan.stages if s.kind != "translation"]
        vector = next(("("+",".join(n.text for n in stage.translation)+")"
                       for stage in notation.geometry.stages if stage.kind == "translation"), "(0,0,0)")
        if not kinds:
            return "E" if point else "t"+vector
        if kinds == ["inversion"]:
            return "i"
        if kinds == ["reflection"]:
            return "σ" if point else ("g"+vector if any(s.kind == "translation" for s in plan.stages) else "m")
        if kinds == ["rotation", "inversion"]:
            # The point-group S_n notation refers to the rotoreflection angle.
            alternative = name_plan(model, plan_by_key[index, "rotoreflection"])
            order = next(f.rotation_n for f in alternative.factors if f.rotation_n)
            return f"S{order}"
        if kinds == ["rotation"]:
            if point:
                order = next(f.rotation_n for f in notation.factors if f.rotation_n)
                return f"C{order}"
            return notation.name.split("; full t=")[0].removesuffix("^-1")
        raise PreparationError("unknown crystal generator geometry")

    return dict(space_group_generators=[label(i) for i in chosen["space"]] or ["identity only"],
                point_group_generators=[label(i, point=True) for i in chosen["point"]] or ["identity only"],
                generator_operations={key: [model.correspondence.operation_indices[i] for i in slots]
                                      for key, slots in chosen.items()})
