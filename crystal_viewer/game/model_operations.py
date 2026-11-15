"""Quiz vocabulary and questions derived only from verified common plans."""
from collections import defaultdict
from fractions import Fraction
import random

import numpy as np

from crystal_viewer.viewer.custom_plan import plan_components
from crystal_viewer.viewer.operation_notation import name_plan
from crystal_viewer.viewer.operation_plan import decompose_composition


def answer_key(answer):
    return (answer['kind'], answer['order'] or -1, answer.get('shift', ''))


def _fraction(value):
    fraction = Fraction(float(value)).limit_denominator(12)
    text = str(fraction)
    return text if abs(float(fraction)-value) < 1e-5 and text in (
        '1/6', '1/4', '1/3', '1/2', '2/3', '3/4', '5/6') else None


def operation_answer(model, plan, difficulty='normal', *, allow_identity=False):
    """A quiz name annotates this complete transform; it never changes W/t."""
    if allow_identity:
        W, t = plan_components(model, plan)
        # Whole-space identity only: neither unchanged atom positions nor
        # a translation reduced modulo the cell establishes E.
        if np.max(abs(W-np.eye(3))) < 1e-8 and np.max(abs(t)) < 1e-8:
            return dict(kind='identity', order=None, symbol='E', notation='E')
    notation = name_plan(model, plan)
    kinds = [s.kind for s in plan.stages if s.kind != 'translation']
    rotation = next((f for f in notation.factors if f.rotation_n), None)
    order = rotation.rotation_n if rotation else None
    # Powers such as S10^3 cannot be answered by the offered single-fold name.
    if rotation and abs(rotation.rotation_k) != 1:
        return None
    g = np.array(notation.intrinsic_translation)
    translated = np.linalg.norm(g) > 1e-10
    answer = None
    if kinds == ['rotation'] and order in (2, 3, 4, 6):
        answer = dict(kind='screw' if translated else 'rotation', order=order)
    elif kinds == ['reflection']:
        answer = dict(kind='glide' if translated else 'mirror', order=None)
    elif kinds == ['inversion']:
        answer = dict(kind='inversion', order=None)
    elif kinds in (['rotation', 'reflection'], ['rotation', 'inversion']) and order in (3, 4, 6):
        answer = dict(kind='rotoreflection' if kinds[-1] == 'reflection' else 'rotoinversion', order=order)
    if answer is None:
        return None
    if answer['kind'] in ('screw', 'glide'):
        # Same teaching scope as before: a full lattice translation is not a
        # fractional screw/glide answer, including centering translations.
        if any(np.max(abs(g-np.array(t)-np.rint(g-np.array(t)))) < 1e-4
               for W, t in zip(model.matrices, model.translations)
               if W is not None and np.max(abs(np.array(W)-np.eye(3))) < 1e-10):
            return None
        if difficulty == 'normal':
            return None
        if answer['kind'] == 'screw':
            shift = _fraction((notation.screw_subscript or 0)/order)
        else:
            # The quiz asks for the magnitude along the primitive direction;
            # centering here is only answer vocabulary, never playback input.
            v = (g+.5) % 1-.5
            fractions = [Fraction(float(x)).limit_denominator(12) for x in v]
            if max(abs(float(f)-x) for f, x in zip(fractions, v)) > 1e-5:
                return None
            from math import gcd, lcm
            from functools import reduce
            denominator = lcm(*(x.denominator for x in fractions))
            integers = [int(x*denominator) for x in fractions]
            shift = _fraction(reduce(gcd, integers)/denominator)
        if shift is None:
            return None
        answer['shift'] = shift
    elif difficulty == 'hard':
        return None
    symbol = notation.name.split('; full t=')[0].replace('bar(', '-').replace(')', '').replace('C_', 'C').replace('S_', 'S').removesuffix('^-1')
    if kinds == ['reflection'] and model.continuous:
        normal = next(s.direction for s in plan.stages if s.kind == 'reflection')
        projection = abs(np.dot(normal, model.continuous.direction))
        symbol = 'sigma_v' if projection < 1e-9 else 'sigma_h' if abs(projection-1) < 1e-9 else symbol
    return dict(answer, symbol=symbol, notation=symbol)


def _motion(model, plan):
    W, t = plan_components(model, plan)
    B = np.array(model.lattice).T if model.periodic else np.eye(3)
    starts = np.array(model.positions) @ B.T
    ends = (np.array(model.positions) @ W.T+t) @ B.T
    moving = bool(np.max(np.linalg.norm(ends-starts, axis=1), initial=0) > 1e-2)
    signature = (any(s.kind == 'rotation' for s in plan.stages), tuple(map(tuple, np.round(ends, 2))))
    return moving, signature


def identify_questions(model, plans, difficulty='normal'):
    groups = {}
    for plan in plans:
        if plan.mode != 'default':
            continue
        answer = operation_answer(model, plan, difficulty)
        if answer is None:
            continue
        moving, signature = _motion(model, plan)
        if not moving:
            continue
        group = groups.setdefault(signature, dict(operation_index=plan.operation_index, answers=[]))
        if not any(answer_key(a) == answer_key(answer) for a in group['answers']):
            group['answers'].append(answer)
    return _number_questions(groups.values())


def _number_questions(questions):
    groups = {}
    result = []
    for question in questions:
        key = tuple(sorted(answer_key(a) for a in question['answers']))
        group = groups.setdefault(key, len(groups))
        result.append(dict(question, id=len(result), group=group))
    return tuple(result)


def composition_questions(model, plans, difficulty='normal'):
    if difficulty == 'hard':
        from crystal_viewer.game.composition_hard import hard_composition_questions
        return hard_composition_questions(model, plans)
    if difficulty != 'normal':
        raise ValueError('unknown composition difficulty')
    # Keep the existing operand-diverse sampling policy, without its old
    # composition, nearest-element lookup, classification or geometry.
    from crystal_viewer.game.composition import _select_product_candidates
    by_index = {p.operation_index: p for p in plans if p.mode == 'default'}
    answers, basis, seen = {}, [], set()
    for index, plan in by_index.items():
        answer = operation_answer(model, plan)
        answers[index] = answer
        moving, signature = _motion(model, plan)
        if answer and moving and signature not in seen:
            seen.add(signature)
            basis.append(index)
    product_answers = {index: answer or operation_answer(model, by_index[index], allow_identity=True)
                       for index, answer in answers.items()}
    candidates = defaultdict(list)
    indices = model.correspondence.operation_indices
    slots = {index: slot for slot, index in enumerate(indices)}
    cache = {}
    for a in basis:
        for b in basis:
            if model.product_table:
                slot = model.product_table[slots[b]][slots[a]]
                if slot is None:
                    continue
                product_index = indices[slot]
                shift = model.product_cell_shifts[slots[b]][slots[a]]
                key = (product_index, tuple(shift))
            else:
                # Linear groups have no finite multiplication table. Only the
                # finite moving operands are used here; match their complete
                # product to a verified finite operation without reducing t.
                A, a0 = model.operation_components(a)
                B, b0 = model.operation_components(b)
                W, t = B@A, B@a0+b0
                product_index = next((index for index, M, v in zip(indices,model.matrices,model.translations)
                    if M is not None and np.max(abs(W-np.array(M))) < 1e-8
                    and np.max(abs(t-np.array(v))) < 1e-8), None)
                key = (a,b)
            if not product_answers.get(product_index):
                continue
            if key not in cache:
                product = decompose_composition(model, (by_index[a], by_index[b]))
                answer = operation_answer(model, product, allow_identity=True)
                cache[key] = answer
            answer = cache[key]
            if not answer:
                continue
            question = dict(operation_index_a=a, operation_index_b=b, product_index=product_index,
                operation_a=answers[a], operation_b=answers[b], answers=[answer])
            candidates[answer_key(answer)].append((answer_key(answers[a])[:2], answer_key(answers[b])[:2], question))
    return _number_questions(q for entries in candidates.values() for q in _select_product_candidates(entries))


def rotation_requires_periodicity(matrix, translations):
    """Whether this proper rotation has no fixed-point representative modulo Z³.

    For primitive integer left axis k, (I-W)x=t+n is solvable for real x and
    integer n exactly when k·t is integral. Test every centering coset, retaining
    the complete input W/t. This is eligibility only, never playback/judging.
    """
    from crystal_viewer.affine_math import integer_nullspace
    from functools import reduce
    from math import gcd, lcm
    if not translations:
        return False
    kernel = integer_nullspace((np.eye(3)-np.asarray(matrix)).T)
    if len(kernel) != 1:
        return False
    denominator = lcm(*(v.denominator for v in kernel[0]))
    axis = [int(v*denominator) for v in kernel[0]]
    divisor = reduce(gcd, axis)
    axis = np.array([v//divisor for v in axis])
    return all(abs(float(axis @ t)-round(float(axis @ t))) > 1e-8 for t in translations)


def hard_point_group_questions(view):
    from crystal_viewer.game.point_group import _CRYSTAL_PROPS, _distractors
    snapshot = view.snapshot
    model = snapshot.model
    if not model.periodic:
        return ()
    symbol = str(view.data.get('metadata', {}).get('point_group_label', ''))
    if symbol not in _CRYSTAL_PROPS:
        return ()
    groups = {}
    for plan in snapshot.plans:
        if plan.mode != 'default' or [s.kind for s in plan.stages if s.kind != 'translation'] != ['rotation']:
            continue
        notation = name_plan(model, plan)
        order = next((f.rotation_n for f in notation.factors if f.rotation_n), None)
        if order not in (2, 3, 4, 6):
            continue
        W, t = model.operation_components(plan.operation_index)
        key = tuple(map(tuple, W))
        groups.setdefault(key, []).append((plan.operation_index, order, t))
    candidates = [(index, order) for W, entries in groups.items()
                  if rotation_requires_periodicity(W, [e[2] for e in entries])
                  for index, order, _ in entries]
    if not candidates:
        return ()
    index, order = min(candidates, key=lambda entry: (-entry[1], entry[0]))
    options = [symbol, *_distractors(symbol, _CRYSTAL_PROPS)]
    random.shuffle(options)
    return (dict(id=0, correct=symbol, options=options, difficulty='hard',
                 representative_operation_index=index, screw_order=order),)


def point_group_questions(view, difficulty="normal"):
    if difficulty == "hard":
        return hard_point_group_questions(view)
    # The existing shape eligibility and group-theory distractor table are pure
    # quiz policy. Their input is now the corrected common model's drawn atoms.
    from crystal_viewer.game.point_group import point_group_question
    question = point_group_question(view.data)
    if question is None:
        return ()
    options = list(question['options'])
    random.shuffle(options)
    return (dict(question, options=options, id=0),)


def public_questions(questions):
    return [{k: v for k, v in q.items() if not k.startswith('_') and k not in ('answers', 'correct', 'product_index', 'representative_operation_index', 'screw_order')}
            for q in questions]


def check_answer(question, payload):
    from crystal_viewer.game.operation_identify import _answer_matches
    return dict(correct=any(_answer_matches(a, payload.get('kind'), payload.get('order'), payload.get('shift'))
                            for a in question['answers']), answers=question['answers'])
