"""Mapping questions from a verified model, independent of legacy geometry."""
from collections import defaultdict
import json
import numpy as np

from crystal_viewer.viewer.operation_notation import name_plan


def mapping_questions(model, plans, difficulty="normal"):
    if difficulty not in ("normal", "hard"):
        raise ValueError("unknown mapping difficulty")
    if model.periodic:
        return _crystal_questions(model, plans, difficulty)
    if difficulty == "hard":
        return ()
    by_index = {p.operation_index: p for p in plans if p.mode == "default"}
    candidates = defaultdict(list)
    for slot, index in enumerate(model.correspondence.operation_indices):
        if model.matrices[slot] is None:
            continue  # A symbolic axial rotation fixes every atom on the line.
        plan = by_index[index]
        kinds = [s.kind for s in plan.stages if s.kind != "translation"]
        notation = name_plan(model, plan)
        order = next((f.rotation_n for f in notation.factors if f.rotation_n), None)
        if kinds == ["rotation"] and order in (2, 3, 4, 6):
            answer = dict(kind="rotation", order=order, symbol=f"C{order}")
        elif kinds == ["reflection"]:
            answer = dict(kind="mirror", order=None, symbol="sigma")
            if model.continuous is not None:
                normal = next(stage.direction for stage in plan.stages if stage.kind == "reflection")
                projection = abs(sum(a*b for a, b in zip(normal, model.continuous.direction)))
                if projection < 1e-9:
                    answer["symbol"] = "sigma_v"
                elif abs(projection-1) < 1e-9:
                    answer["symbol"] = "sigma_h"
        elif kinds == ["inversion"]:
            answer = dict(kind="inversion", order=None, symbol="i")
        elif kinds == ["rotation", "reflection"] and order in (3, 4, 6):
            answer = dict(kind="rotoreflection", order=order, symbol=f"S{order}")
        else:
            continue
        answer["notation"] = answer["symbol"]
        for source, target in enumerate(model.permutations[slot]):
            if source == target:
                continue
            key = (answer["kind"], answer["order"])
            element = json.loads(model.species[source]).get("element", model.species[source])
            candidates[key].append(((index, element), dict(
                operation_index=index, source_atom_index=model.correspondence.atom_indices[source],
                target_atom_index=model.correspondence.atom_indices[target], operation=answer)))
    # Preserve the existing six-per-answer-group round-robin across operations
    # and chemical elements; no geometry or nearest-neighbour decision is made.
    questions = []
    for group, entries in enumerate(candidates.values()):
        strata = defaultdict(list)
        for stratum, question in entries:
            strata[stratum].append(question)
        selected = []
        offset = 0
        while len(selected) < 6:
            next_entries = [strata[key][offset] for key in sorted(strata) if offset < len(strata[key])]
            if not next_entries:
                break
            selected.extend(next_entries[:6-len(selected)])
            offset += 1
        for question in selected:
            questions.append(dict(question, id=len(questions), group=group))
    return tuple(questions)


def public_questions(questions):
    return [{key: value for key, value in q.items() if key != "target_atom_index" and not key.startswith("_")} for q in questions]


def _crystal_questions(model, plans, difficulty):
    """Classify complete endpoints in the closed reference cell, never W/t mod 1."""
    from crystal_viewer.game.model_operations import operation_answer
    positions = np.asarray(model.positions)
    basis = np.asarray(model.lattice).T
    by_index = {p.operation_index: p for p in plans if p.mode == "default"}
    candidates = defaultdict(lambda: defaultdict(list))
    tol = 1e-8
    for slot, index in enumerate(model.correspondence.operation_indices):
        W, t = np.asarray(model.matrices[slot]), np.asarray(model.translations[slot])
        if np.max(abs(W-np.eye(3))) < tol:
            # Existing fractional centering translations only; no new lattice steps.
            if np.max(abs(t-np.rint(t))) < tol:
                continue
            answer = dict(kind="translation", order=None, symbol="t", notation="t")
        else:
            answer = operation_answer(model, by_index[index], "normal") or operation_answer(model, by_index[index], "hard")
            if answer is None:
                continue
        for source, target in enumerate(model.permutations[slot]):
            endpoint = W@positions[source]+t
            if np.linalg.norm(basis@(endpoint-positions[source])) <= tol:
                continue
            outside = bool(np.any(endpoint < -tol) or np.any(endpoint > 1+tol))
            if outside != (difficulty == "hard"):
                continue
            # Repeated boundary images do not count as distinct answer choices.
            if sum(s == model.species[source] for s in model.species) < 2:
                continue
            image = np.asarray(model.image_shifts[slot][source], dtype=int)
            if model.species[source] != model.species[target] or np.linalg.norm(basis@(endpoint-positions[target]-image)) > tol:
                raise ValueError("inconsistent verified mapping endpoint")
            operation = dict(answer, translation_frac=t.tolist())
            # Intrinsic screw/glide direction is distinct from an off-origin axis.
            operation["intrinsic_translation_frac"] = list(name_plan(model, by_index[index]).intrinsic_translation)
            element = json.loads(model.species[source]).get("element", model.species[source])
            key = (answer["kind"], answer["order"])
            stratum = (index, element, source == target)
            candidates[key][stratum].append(dict(operation_index=index,
                source_atom_index=model.correspondence.atom_indices[source],
                target_atom_index=model.correspondence.atom_indices[target], operation=operation,
                _actual_target_frac=endpoint.tolist(), _target_frac=positions[target].tolist(),
                _target_image=image.tolist()))
    questions = []
    for group, strata in enumerate(candidates.values()):
        selected = []
        offset = 0
        while len(selected) < 6:
            batch = [values[offset] for values in strata.values() if offset < len(values)]
            if not batch:
                break
            selected.extend(batch[:6-len(selected)])
            offset += 1
        first_id = len(questions)
        questions.extend(dict(q, id=first_id+i, group=group) for i, q in enumerate(selected))
    return tuple(questions)
