"""Explicit API2 dispatcher shared by HTTP and static adapters.

The host must supply a ModelSession prepared independently of the legacy UI.
No implicit preparation, correction policy, source-model fallback or legacy
path translation is performed. Error bodies are machine readable.
"""
from dataclasses import asdict
import json

from crystal_viewer.symmetry_model import PreparationError
from crystal_viewer.viewer.model_session import ModelConflict, operation_id
from crystal_viewer.viewer.custom_plan import build_custom_plan, check_plan, compose_plans
from crystal_viewer.viewer.operation_plan import build_plan
from crystal_viewer.viewer.operation_notation import name_plan
from crystal_viewer.viewer.plan_presentation import present_plan
from crystal_viewer.viewer.playback_schedule import ReferencePoints, build_schedule


class API2:
    def __init__(self, session):
        self.session = session

    def _plan(self, snapshot, request):
        if not isinstance(request, dict):
            raise ValueError("plan request object required")
        if sum(key in request for key in ("custom", "sequence", "operation_index")) != 1:
            raise ValueError("exactly one operation, Custom input or sequence required")
        plan = self._build_plan(snapshot, request)
        if "plan_id" in request and request["plan_id"] != plan.plan_id:
            raise ModelConflict("plan identity mismatch")
        return plan

    def _build_plan(self, snapshot, request):
        model = snapshot.model
        snapshot.require(request)
        if "custom" in request:
            custom = request["custom"]
            return build_custom_plan(model, custom["kind"], custom["params"]).plan
        if "sequence" in request:
            return compose_plans(model, [self._plan(snapshot, item) for item in request["sequence"]]).plan
        index = request["operation_index"]
        if isinstance(index, bool) or not isinstance(index, int):
            raise ValueError("integer operation_index required")
        if request.get("operation_id") != operation_id(model, index):
            raise ModelConflict("operation identity mismatch")
        mode = request.get("mode", "default")
        angle = request.get("family_angle_rad")
        if angle is not None:
            return build_plan(model, index, mode=mode, family_angle_rad=angle)
        # The only cache consists of plans built with the current snapshot.
        for plan in snapshot.plans:
            if (plan.operation_index, plan.mode) == (index, mode):
                plan.require_model(model)
                return plan
        return build_plan(model, index, mode=mode)

    def respond(self, path, request):
        if path == "/api/model":
            return self.session.initial()
        snapshot = self.session.snapshot(request)
        model = snapshot.model
        if path == "/api/operations":
            return self.session.finish(snapshot, dict(operations=[dict(operation_index=p.operation_index,
                operation_id=operation_id(model, p.operation_index), mode=p.mode, plan_id=p.plan_id,
                notation=asdict(name_plan(model, p))) for p in snapshot.plans],
                continuous_operations=[dict(operation_index=index, operation_id=operation_id(model, index),
                    requires_explicit_angle=True, plan_id=None)
                    for index, matrix in zip(model.correspondence.operation_indices, model.matrices) if matrix is None]))
        if path not in ("/api/plan", "/api/check", "/api/animation_path", "/api/atom_motion",
                        "/api/symmetry_elements", "/api/custom_plan", "/api/custom_animation_path"):
            raise LookupError("unsupported API2 endpoint")
        plan = self._plan(snapshot, request)
        # Plan acquisition is the one request allowed without a plan ID. All
        # consumers must echo it, even when model and operation are unchanged.
        if path not in ("/api/plan", "/api/custom_plan") or "plan_id" in request:
            if request.get("plan_id") != plan.plan_id:
                raise ModelConflict("plan identity mismatch")
        presentation = present_plan(model, plan, coordinate_space=request.get("coordinate_space"))
        body = dict(plan_id=plan.plan_id, plan=asdict(plan), presentation=asdict(presentation))
        if "custom" in request or "sequence" in request:
            body["input"] = {key: request[key] for key in ("custom", "sequence") if key in request}
        if path == "/api/symmetry_elements":
            body["symmetry_elements"] = asdict(presentation)["stages"]
        if plan.operation_index is not None:
            body.update(operation_id=operation_id(model, plan.operation_index),
                        operation_index=plan.operation_index, notation=asdict(name_plan(model, plan)))
        if path == "/api/check":
            body["check"] = asdict(check_plan(model, plan, mapping_tolerance_A=request["mapping_tolerance_A"]))
        if path in ("/api/animation_path", "/api/atom_motion", "/api/custom_animation_path"):
            references = ReferencePoints.from_model(model, atom_indices=request.get("atom_indices"),
                cell_images=request.get("cell_images", ((0, 0, 0),)))
            schedule = build_schedule(model, plan, references, scene_span_A=request["scene_span_A"],
                                      repetitions=request.get("repetitions", 1))
            body.update(schedule=asdict(schedule), references=asdict(references))
            # Complete endpoint, without replacement by correspondence targets.
            from crystal_viewer.viewer.playback_schedule import evaluate_schedule
            body["endpoint_cart_A"] = (evaluate_schedule(plan, schedule,
                references.points_cart_A, 1).tolist() if references.points_cart_A else [])
        return self.session.finish(snapshot, body)

    def dispatch(self, path, request):
        try:
            if not isinstance(request, dict):
                raise ValueError("JSON object required")
            if type(request.get("api_version")) is not int or request["api_version"] != 2:
                return 406, dict(error="unsupported_contract", api_version=2)
            request = json.loads(json.dumps(request, allow_nan=False))
            body = self.respond(path, request)
            # Validate JSON at the boundary, before a transport starts writing.
            return 200, json.loads(json.dumps(body, allow_nan=False))
        except ModelConflict as exc:
            return 409, dict(error="state_mismatch", message=str(exc), api_version=2)
        except LookupError as exc:
            # Missing request fields are bad requests, unknown routes are 406.
            return (400 if isinstance(exc, KeyError) else 406), dict(
                error="invalid_request" if isinstance(exc, KeyError) else "unsupported_contract",
                message=str(exc), api_version=2)
        except (PreparationError, ValueError, TypeError) as exc:
            return 400, dict(error="invalid_request", message=str(exc), api_version=2)
