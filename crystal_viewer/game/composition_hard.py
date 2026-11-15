"""Hard questions from shared finite masters, with one fixed center per model.

Only table IDs are composed during candidate search. Whole-space transforms,
Custom inputs and paths remain bound to the chosen operation, without wrapping
translations or fitting a separate center for each question.
"""
import numpy as np

from crystal_viewer.symmetry_model import PreparationError
from crystal_viewer.game.composition_masters import MASTERS
from crystal_viewer.viewer.custom_plan import build_custom_plan, check_plan, compose_plans, plan_components
from crystal_viewer.viewer.operation_plan import _finite_plan, _rotation

_PER_ANSWER = 2


def _operand_operation(model, plan):
    kinds = [s.kind for s in plan.stages]
    if kinds in (['reflection'], ['inversion']):
        kind = 'mirror' if kinds == ['reflection'] else 'inversion'
        return dict(kind=kind, order=None, symbol='sigma' if kind=='mirror' else 'i', notation='sigma' if kind=='mirror' else 'i')
    if kinds in (['rotation'], ['rotation', 'inversion']):
        angle = abs(plan.stages[0].angle_rad)
        order = next((n for n in (2,3,4,6) if abs(angle-2*np.pi/n)<1e-10), None)
        if order is not None and (len(kinds)==1 or order in (3,4,6)):
            kind = 'rotation' if len(kinds)==1 else 'rotoinversion'
            symbol = ('C' if kind=='rotation' else '-')+str(order)
            return dict(kind=kind, order=order, symbol=symbol, notation=symbol)
    raise PreparationError('Hard operand requires a crystallographic point operation')


def _fixed_center(model, B):
    if model.periodic:
        return np.zeros(3)
    # One common fixed point of the complete molecular group, not one fit per
    # target. The minimum-norm choice is reproducible for planar/linear groups.
    rows = np.concatenate([np.eye(3)-np.array(W) for W in model.matrices if W is not None])
    vectors = np.concatenate([np.array(t) for W,t in zip(model.matrices, model.translations) if W is not None])
    center = np.linalg.lstsq(rows, vectors, rcond=None)[0]
    if np.max(abs(rows@center-vectors)) > 1e-8:
        raise PreparationError('molecular operations require a common fixed center')
    return center


def hard_composition_questions(model, plans):
    from crystal_viewer.game.model_operations import answer_key, operation_answer, _motion, _number_questions
    B = np.array(model.lattice).T if model.periodic else np.eye(3)
    inverse = np.linalg.inv(B)
    center = _fixed_center(model, B)
    point = (inverse@center).tolist()
    starts = np.array(model.positions)@B.T
    actual = [(B@np.array(W)@inverse, B@np.array(t)) for W, t in zip(model.matrices, model.translations) if W is not None]

    def symmetry(M, v):
        for A, a in actual:
            if np.max(abs(M-A)) > 1e-8:
                continue
            delta = inverse@(v-a)
            if model.periodic:
                delta -= np.rint(delta)
            if np.max(abs(delta)) < 1e-8:
                return True
        return False

    def distance(M, v):
        # Visual ranking only; exact symmetry is checked separately. This
        # compares indistinguishable same-species atoms rather than labels.
        ends = starts@M.T+v
        delta = ends[:, None, :]-starts[None, :, :]
        if model.periodic:
            frac = delta@inverse.T
            delta = (frac-np.rint(frac))@B.T
        distances = np.linalg.norm(delta, axis=2)
        distances[np.array(model.species)[:, None] != np.array(model.species)[None, :]] = np.inf
        return float(np.mean(np.min(distances, axis=1)))

    targets = []
    for target in plans:
        if target.mode != 'default':
            continue
        answer = operation_answer(model, target, allow_identity=True)
        moving, signature = _motion(model, target)
        if answer is None:
            continue
        W, t = plan_components(model, target)
        M, v = B@W@inverse, B@t
        # No screws, glides, integer lifts or displaced axes are recentered.
        if np.max(abs((np.eye(3)-M)@center-v)) > 1e-8:
            continue
        targets.append((target, answer, moving, signature, M, v))

    counts, seen, questions = {}, set(), []
    embeddings = {}
    for target, answer, moving, signature, M, v in targets:
        key = answer_key(answer)
        sample_key = (key, moving)
        if counts.get(sample_key, 0) >= _PER_ANSWER or (key, signature) in seen:
            continue
        geometric = next((s for s in target.stages if s.kind in ('rotation', 'reflection')), None)
        axis = np.array(geometric.direction) if geometric else B[:, 0]/np.linalg.norm(B[:, 0])
        directions = list(B.T) if model.periodic else list(starts-center)
        x = next((d-axis*np.dot(d, axis) for d in directions
                  if np.linalg.norm(d-axis*np.dot(d, axis)) > 1e-8), None)
        if x is None:
            x = np.cross(axis, np.eye(3)[np.argmin(abs(axis))])
        x /= np.linalg.norm(x)
        base = np.column_stack((x, np.cross(axis, x), axis))
        candidates = []
        # The second frame bisects the target's elementary angular spacing.
        # It is a finite, structure-related embedding, not arbitrary 11° tilts.
        phases = (0., np.pi/(2*(answer.get('order') or 2)))
        for phase_index, phase in enumerate(phases):
            Q = _rotation(axis, phase)@base
            for master_index, master in enumerate(MASTERS):
                cache_key = (master_index, tuple(np.round(Q, 12).ravel()))
                if cache_key not in embeddings:
                    matrices = [Q@np.array(op['matrix'])@Q.T for op in master['operations']]
                    vectors = [center-A@center for A in matrices]
                    good = [symmetry(A, a) for A, a in zip(matrices, vectors)]
                    scores = [0. if ok else distance(A, a) for A, a, ok in zip(matrices, vectors, good)]
                    embeddings[cache_key] = matrices, vectors, good, scores
                matrices, vectors, good, scores = embeddings[cache_key]
                product_id = next((i for i, A in enumerate(matrices) if np.max(abs(A-M)) < 1e-8), None)
                if product_id is None:
                    continue
                for a, ok in enumerate(good):
                    if ok:
                        continue
                    b = master['table'][product_id][master['inverse'][a]]
                    if good[b]:
                        continue
                    # Favor clear single-operation endpoints in the natural
                    # frame, then repeated operations and simple pure rotations.
                    operations = master['operations']
                    priority = (phase_index, -round(min(scores[a], scores[b]), 6), a != b,
                                sum(operations[i]['kind'] != 'rotation' for i in (a,b)))
                    candidates.append((priority, master, Q, a, b))
        families = set()
        for _, master, Q, a, b in sorted(candidates, key=lambda item:item[0]):
            inputs = []
            for i in (a, b):
                op = master['operations'][i]
                kind = op['kind']
                if kind == 'inversion':
                    params = dict(center=point)
                else:
                    n = Q@np.array(op['direction'])
                    params = dict(normal=(B.T@n).tolist(), point=point) if kind == 'mirror' else dict(
                        axis=(inverse@n).tolist(), angle=op['angle'], **({'center':point} if kind=='rotoinversion' else {'point':point}))
                inputs.append(build_custom_plan(model, kind, params))
            operands = tuple(inputs)
            operations = tuple(_operand_operation(model, item.plan) for item in operands)
            family = tuple((o['kind'], o['order']) for o in operations)
            if family in families or any(not _motion(model, item.plan)[0]
                    or check_plan(model, item.plan, mapping_tolerance_A=.1).is_symmetry for item in operands):
                continue
            sequence = compose_plans(model, [item.plan for item in operands]).plan
            W, t = plan_components(model, sequence)
            if (np.max(abs(B@W@inverse-M)) > 1e-8 or np.max(abs(B@t-v)) > 1e-8
                    or not check_plan(model, sequence, mapping_tolerance_A=.1).is_symmetry):
                raise PreparationError('master product differs from the complete target transform')
            product = _finite_plan(model, W, t, None, 'default', numeric_direction=True,
                                   identity_context=dict(composition_hard=sequence.plan_id))
            product_answer = operation_answer(model, product, allow_identity=True)
            if product_answer is None or answer_key(product_answer) != key:
                raise PreparationError('master product classification differs from target')
            questions.append(dict(difficulty='hard', operation_index_a=None, operation_index_b=None,
                operation_a=operations[0], operation_b=operations[1], product_index=target.operation_index,
                answers=[product_answer],
                _hard_operands=operands, _hard_product=product))
            families.add(family)
            counts[sample_key] = counts.get(sample_key,0)+1
            if counts[sample_key] >= _PER_ANSWER:
                break
        seen.add((key, signature))
    return _number_questions(questions)
