"""Independent verified quiz models, private answers and question-bound plans."""
from dataclasses import dataclass
import threading
import json
from uuid import uuid4

from crystal_viewer.game.model_mapping import mapping_questions, public_questions
from crystal_viewer.game import model_operations
from crystal_viewer.viewer.custom_plan import compose_plans, plan_components
from crystal_viewer.viewer.operation_plan import decompose_composition
from crystal_viewer.viewer.api2 import API2
from crystal_viewer.viewer.model_loading import ModelLoads
from crystal_viewer.viewer.model_session import ModelSession, ModelConflict
from crystal_viewer.viewer.model_view import ModelView


@dataclass
class QuizRound:
    round_id: str
    view: ModelView
    questions: tuple
    quiz_type: str = "mapping"
    difficulty: str = "normal"
    playback_plans: dict | None = None
    answered: bool = False
    question_token: str | None = None
    question_id: int | None = None
    selection_revision: int = -1


class QuizSession:
    def __init__(self, helpers):
        self.helpers = helpers
        self.lock = threading.RLock()
        self.generation = 0
        self.active = None

    def load(self, loader, identity=None, *, quiz_type="mapping", difficulty="normal"):
        if quiz_type not in ("mapping", "operation", "composition", "point_group"):
            raise ValueError("unknown quiz type")
        if difficulty not in ("normal", "hard"):
            raise ValueError("unknown quiz difficulty")
        with self.lock:
            if identity is not None:
                if self.active is None:
                    raise ModelConflict("quiz model not prepared")
                self.active.view.session.snapshot(identity)
            self.generation += 1
            generation = self.generation
        round_id = uuid4().hex
        # Use the same verified, cell-intersecting representatives as analysis.
        # Keep the session separate so quiz selection never changes analysis.
        models = ModelSession(cell_representatives=True)
        view = ModelView(API2(models), self.helpers, display_mode="source")
        loads = ModelLoads(models, analysis_context=dict(host="model_quiz", round_id=round_id,
            historical_analysis_conditions="unknown"), mapping_tolerance_A=.1, operation_match_tolerance=.01,
            model_view=view)
        loads.load(loader, provenance=dict(quiz=quiz_type))
        snapshot = models.snapshot()
        bundle = view.bundle()
        if quiz_type == "mapping":
            questions = mapping_questions(snapshot.model, snapshot.plans, difficulty)
            if not questions:
                raise ValueError("no mapping questions for this structure")
        elif quiz_type == "operation":
            questions = model_operations.identify_questions(snapshot.model, snapshot.plans, difficulty)
        elif quiz_type == "composition":
            questions = model_operations.composition_questions(snapshot.model, snapshot.plans, difficulty)
            if difficulty == "hard" and not questions:
                raise ValueError("no_hard_composition_question")
        else:
            questions = model_operations.point_group_questions(view, difficulty)
            if difficulty == "hard" and not questions:
                raise ValueError("no_hard_point_group_question")
        candidate = QuizRound(round_id, view, questions, quiz_type, difficulty)
        bundle.update(round_id=round_id, question_token=None)
        with self.lock:
            if generation != self.generation:
                raise ModelConflict("obsolete quiz load")
            self.active = candidate
        return bundle

    def composition_options(self, loader):
        # Probe in a private session; the live question and its IDs stay intact.
        probe = QuizSession(self.helpers)
        probe.load(loader, quiz_type="composition", difficulty="normal")
        snapshot = probe.active.view.snapshot
        hard = model_operations.composition_questions(snapshot.model, snapshot.plans, "hard")
        return dict(normal=bool(probe.active.questions), hard=bool(hard))

    def quiz_availability(self, loader):
        """Which quiz/difficulty pairs this structure can pose, from the same
        verified model and question generators the live quiz uses. Stored in the
        example catalog so the picker can offer only playable choices."""
        probe = QuizSession(self.helpers)
        probe.load(loader, quiz_type="operation")
        snapshot, view = probe.active.view.snapshot, probe.active.view
        levels = ("normal", "hard")
        return {
            "operation": {d: bool(model_operations.identify_questions(snapshot.model, snapshot.plans, d)) for d in levels},
            "composition": {d: bool(model_operations.composition_questions(snapshot.model, snapshot.plans, d)) for d in levels},
            "mapping": {d: bool(mapping_questions(snapshot.model, snapshot.plans, d)) for d in levels},
            "point_group": {d: bool(model_operations.point_group_questions(view, d)) for d in levels},
        }

    def mapping_options(self, loader):
        probe = QuizSession(self.helpers)
        probe.load(loader, quiz_type="operation")
        snapshot = probe.active.view.snapshot
        return {level: bool(mapping_questions(snapshot.model, snapshot.plans, level))
                for level in ("normal", "hard")}

    def dispatch(self, endpoint, payload):
        with self.lock:
            active = self.active
            if endpoint == "bootstrap":
                if active is None:
                    return dict(ok=True, model_snapshot=None, state={}, round_id=None, question_token=None)
                return dict(active.view.bundle(), round_id=active.round_id, question_token=active.question_token)
            if active is None:
                raise ModelConflict("quiz model not prepared")
            snapshot = active.view.session.snapshot(payload)
            if payload.get("round_id") != active.round_id:
                raise ModelConflict("quiz round mismatch")
            if endpoint == "questions":
                public = public_questions if active.quiz_type == "mapping" else model_operations.public_questions
                return dict(snapshot.identity(), round_id=active.round_id,
                            source_kind="crystal" if snapshot.model.periodic else "molecule",
                            questions=public(active.questions))
            if endpoint == "select_question":
                index, revision = payload.get("question_id"), payload.get("selection_revision")
                if type(index) is not int or not 0 <= index < len(active.questions):
                    raise ValueError("unknown quiz question")
                if type(revision) is not int or revision <= active.selection_revision:
                    raise ModelConflict("obsolete question selection")
                question = active.questions[index]
                selected_index = question.get("operation_index", question.get("operation_index_a", active.view.state["operation_index"]))
                playback_plans = {}
                if active.quiz_type == "composition":
                    by_index = {p.operation_index: p for p in snapshot.plans if p.mode == "default"}
                    if active.difficulty == "hard":
                        operands = tuple(item.plan for item in question["_hard_operands"])
                        product = question["_hard_product"]
                        selected_index = active.view.state["operation_index"]
                    else:
                        operands = tuple(by_index[question[key]] for key in ("operation_index_a", "operation_index_b"))
                        product = decompose_composition(snapshot.model, operands)
                    playback_plans = dict(sequence=compose_plans(snapshot.model, operands).plan,
                                          product=product, operands=operands,
                                          operation1=operands[0], operation2=operands[1])
                state = active.view.dispatch("state", dict(snapshot.identity(), update=dict(
                    operation_index=selected_index, improper_mode="default",
                    playing=False, operation_repetitions=1, reset=True)))
                active.playback_plans, active.answered = playback_plans, False
                active.question_id, active.selection_revision = index, revision
                active.question_token = uuid4().hex
                return dict(state, round_id=active.round_id, question_token=active.question_token,
                            question_id=index, playbacks={role: playback_plans[role].plan_id for role in ("sequence", "operation1", "operation2")}
                            if playback_plans else {})
            if endpoint in ("render_data", "operations", "atoms", "state"):
                if endpoint == "state" and payload.get("update"):
                    raise ValueError("quiz state is controlled by the selected question")
                if endpoint == "render_data" and "periodic_neighbors" in payload:
                    if active.quiz_type != "point_group" or active.difficulty != "hard" or not snapshot.model.periodic:
                        raise ValueError("periodic neighbors require a Hard crystal point-group quiz")
                    if str(payload["periodic_neighbors"]) not in ("0", "1"):
                        raise ValueError("invalid periodic neighbor flag")
                    active.view.dispatch("state", dict(snapshot.identity(), update=dict(
                        display_mode="expanded_axes:4,4,4" if str(payload["periodic_neighbors"]) == "1" else "source")))
                if endpoint == "render_data" and "boundary_images" in payload:
                    if str(payload["boundary_images"]) not in ("0", "1"):
                        raise ValueError("invalid boundary image flag")
                    active.view.dispatch("state", dict(snapshot.identity(), update=dict(
                        include_boundary_images=str(payload["boundary_images"]) == "1")))
                return active.view.dispatch(endpoint, payload)
            if (active.question_id is None or payload.get("question_token") != active.question_token):
                raise ModelConflict("quiz question mismatch")
            question = active.questions[active.question_id]
            if endpoint == "check":
                if type(payload.get("question_id")) is not int or payload["question_id"] != active.question_id:
                    raise ModelConflict("quiz question mismatch")
                if active.quiz_type == "point_group":
                    from crystal_viewer.game.point_group import _explanation, _CRYSTAL_PROPS, _SCHOENFLIES
                    table = _CRYSTAL_PROPS if snapshot.model.periodic else _SCHOENFLIES
                    result = dict(correct=payload.get("selected") == question["correct"], answer=question["correct"],
                                  explanation=_explanation(question["correct"], table))
                    if active.difficulty == "hard":
                        result["analysis_operation_index"] = question["representative_operation_index"]
                        order = question['screw_order']
                        result["explanation"] += f"{order}回らせんの回転部分が、{order}回軸にあたります。"
                elif active.quiz_type in ("operation", "composition"):
                    result = model_operations.check_answer(question, payload)
                    if active.quiz_type == "composition":
                        plan = active.playback_plans["product"]
                        W, t = plan_components(snapshot.model, plan)
                        matrix_key, translation_key = (("matrix_frac", "translation_frac") if snapshot.model.periodic
                                                       else ("matrix_cart", "translation_cart"))
                        result.update(product_index=question["product_index"],
                            product_transform={matrix_key: W.tolist(), translation_key: t.tolist()},
                            operation_index_a=question["operation_index_a"], operation_index_b=question["operation_index_b"],
                            playbacks=dict(product=plan.plan_id))
                        if active.difficulty == "hard":
                            transforms = []
                            for operand in active.playback_plans["operands"]:
                                A, a = plan_components(snapshot.model, operand)
                                transforms.append({matrix_key: A.tolist(), translation_key: a.tolist()})
                            result.update(operand_transforms=transforms,
                                analysis_sequence=[json.loads(item.input_json) for item in question["_hard_operands"]])
                            # Do not expose the unrelated Standard operation selected
                            # solely to keep the view projection's state valid.
                            result.update(operation_a=question["operation_a"], operation_b=question["operation_b"])
                    else:
                        result["operation_index"] = question["operation_index"]
                else:
                    selected = payload.get("selected_atom_index")
                    if type(selected) is not int or selected not in snapshot.model.correspondence.atom_indices:
                        raise ValueError("invalid selected atom")
                    result = dict(correct=selected == question["target_atom_index"],
                        **{key: question[key] for key in ("operation_index", "source_atom_index", "target_atom_index")})
                    if snapshot.model.periodic:
                        result.update(actual_target_frac=question["_actual_target_frac"],
                                      target_frac=question["_target_frac"], target_image=question["_target_image"])
                active.answered = True
                return dict(snapshot.identity(), round_id=active.round_id, question_token=active.question_token, **result)
            if endpoint not in ("plan", "animation_path", "symmetry_elements", "atom_motion"):
                raise ValueError("unsupported quiz endpoint")
            if active.quiz_type == "composition":
                role = payload.get("quiz_playback")
                if role not in ("sequence", "product", "operation1", "operation2") or (role == "product" and not active.answered):
                    raise ModelConflict("quiz playback unavailable")
                plan = active.playback_plans[role]
                if payload.get("expected_plan_id") != plan.plan_id:
                    raise ModelConflict("quiz plan identity mismatch")
                if any(key in payload for key in ("custom", "sequence", "plan_request")) or payload.get("repetitions", 1) != 1:
                    raise ValueError("quiz requires its question-bound plan")
                if endpoint not in ("animation_path", "symmetry_elements", "atom_motion"):
                    raise ValueError("unsupported composition endpoint")
                self._scope(active, snapshot, payload)
                return active.view.dispatch(endpoint, payload, verified_plan=plan,
                    plan_groups=active.playback_plans["operands"] if role == "sequence" else None)
            if active.quiz_type == "point_group":
                raise ValueError("point-group quiz has no operation playback")
            request = payload.get("plan_request", payload)
            if request.get("operation_index") != question["operation_index"]:
                raise ModelConflict("quiz operation mismatch")
            if (request.get("mode", "default") != "default" or
                    any(key in request for key in ("custom", "sequence", "family_angle_rad")) or
                    payload.get("repetitions", 1) != 1):
                raise ValueError("quiz requires the selected Standard operation")
            if endpoint != "plan" and "plan_request" not in payload:
                raise ValueError("snapshot-bound plan_request required")
            if endpoint == "plan":
                result = active.view.api.dispatch("/api/plan", payload)
                status, body = result
                if status != 200:
                    raise ValueError(body.get("message", body.get("error")))
                return body
            if payload.get("operation_index", question["operation_index"]) != question["operation_index"]:
                raise ModelConflict("quiz operation mismatch")
            active.view.api._plan(snapshot, request)
            if request.get("plan_id") is None:
                raise ValueError("snapshot-bound plan ID required")
            self._scope(active, snapshot, payload)
            return active.view.dispatch(endpoint, payload)

    @staticmethod
    def _scope(active, snapshot, payload):
        if "scope" not in payload:
            return
        if payload["scope"] not in ("unit_cell", "displayed"):
            raise ValueError("invalid quiz animation scope")
        active.view.dispatch("state", dict(snapshot.identity(), update=dict(scope=payload["scope"])))
