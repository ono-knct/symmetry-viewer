"""Atomic, opt-in API2 model boundary. No legacy payload is used for math.

Preparation is explicit: callers supply analysis provenance and numerical
search parameters. Publishing here does not approve a correction policy or
activate the legacy viewer. Source snapshots are retained for diagnosis.
"""
from dataclasses import asdict, dataclass
import json
import threading

import numpy as np

from crystal_viewer.symmetry_model import SourceModel, SymmetryModel, prepare_model, _json
from crystal_viewer.viewer.operation_plan import build_plan, PlanContext

MATH_VERSION = 1
MODES = ("default", "rotoinversion", "rotoreflection")


class ModelConflict(ValueError):
    """An obsolete request, candidate, plan or response was supplied."""


@dataclass(frozen=True)
class LoadReservation:
    structure_revision: int


@dataclass(frozen=True)
class PreparationRequest:
    structure_revision: int
    source: SourceModel
    parameters_json: str
    load_context_json: str = "{}"
    correction_limits_json: str | None = None


@dataclass(frozen=True)
class ActiveModelSnapshot:
    structure_revision: int
    source: SourceModel
    model: SymmetryModel
    parameters_json: str
    plans: tuple
    math_version: int = MATH_VERSION
    load_context_json: str = "{}"
    correction_limits_json: str | None = None
    model_change_json: str | None = None
    derived_metadata_json: str = "{}"
    input_model: SymmetryModel | None = None
    representatives_json: str | None = None

    def identity(self):
        return dict(model_id=self.model.model_id, source_model_id=self.source.source_model_id,
                    frame_id=self.model.frame_id, structure_revision=self.structure_revision,
                    math_version=self.math_version)

    def require(self, identity):
        if any(identity.get(k) != v or type(identity.get(k)) is not type(v)
               for k, v in self.identity().items()):
            raise ModelConflict("model/source/frame/revision/math version mismatch")


class ModelSession:
    def __init__(self, *, cell_representatives=False):
        self.cell_representatives = bool(cell_representatives)
        self._lock = threading.RLock()
        self._revision = 0
        self._request = None
        self._reservation = None
        self._candidate = None
        self._active = None

    def reserve(self):
        """Invalidate pending work before an external analysis worker starts."""
        with self._lock:
            self._revision += 1
            self._reservation = LoadReservation(self._revision)
            self._request = None
            self._candidate = None
            return self._reservation

    def require_reservation(self, reservation):
        with self._lock:
            if reservation is None or reservation is not self._reservation:
                raise ModelConflict("obsolete load reservation")

    def abort(self, reservation):
        with self._lock:
            if reservation is self._reservation:
                self._reservation = self._request = self._candidate = None

    def clear(self, reservation):
        with self._lock:
            self.require_reservation(reservation)
            self._active = None
            self._reservation = self._request = self._candidate = None

    def begin(self, payload, *, analysis_context, mapping_tolerance_A,
              residual_tolerance=1e-9, operation_match_tolerance=None,
              reservation=None, load_context=None, correction_limits=None):
        source = SourceModel.capture(payload, analysis_context=analysis_context)
        parameters = _json(dict(mapping_tolerance_A=mapping_tolerance_A,
            residual_tolerance=residual_tolerance, operation_match_tolerance=operation_match_tolerance))
        context = _json(load_context or {})
        limits = _json(asdict(correction_limits)) if correction_limits is not None else None
        with self._lock:
            if reservation is None:
                reservation = self.reserve()
            self.require_reservation(reservation)
            self._request = PreparationRequest(self._revision, source, parameters, context, limits)
            self._candidate = None
            return self._request

    def prepare(self, request, *, previous=None):
        # Work outside the lock. No partial lattice/atoms/plans become visible.
        with self._lock:
            if request is not self._request:
                raise ModelConflict("obsolete preparation request")
        model = prepare_model(request.source, **json.loads(request.parameters_json))
        if request.correction_limits_json is not None:
            from crystal_viewer.viewer.model_policy import CorrectionLimits, CorrectionLimitError, correction_report
            report = correction_report(request.source, model, CorrectionLimits(**json.loads(request.correction_limits_json)))
            if report["violations"]:
                raise CorrectionLimitError(report)
        input_model, selection, anchors = model, None, {}
        if self.cell_representatives and model.periodic:
            from crystal_viewer.viewer.cell_representatives import select_representatives
            lower = json.loads(request.load_context_json).get("representative_cell_lower", 0.)
            selected = select_representatives(model, json.loads(request.source.payload_json), lower=lower)
            model, selection = selected.model, _json(selected.record)
            anchors = dict(zip(model.correspondence.operation_indices, selected.anchors))
        plan_context = PlanContext(model)
        plans = tuple(build_plan(model, index, mode=mode, anchor_cart_A=anchors.get(index), context=plan_context)
            for slot, index in enumerate(model.correspondence.operation_indices)
            if model.matrices[slot] is not None for mode in MODES)
        change = None
        if previous is not None:
            from crystal_viewer.model_correspondence import relate_cells
            context = json.loads(request.load_context_json)
            frame = context.get("frame_change")
            change = dict(previous=previous.identity(), current=dict(model_id=model.model_id,
                source_model_id=model.source_model_id, frame_id=model.frame_id,
                structure_revision=request.structure_revision, math_version=MATH_VERSION))
            if frame is None:
                change.update(status="unavailable", reason="no explicit frame witness for this conversion")
            else:
                try:
                    relation = relate_cells(previous.model, model, **frame)
                except ValueError as exc:
                    change.update(status="unavailable", reason=str(exc), frame_change=frame)
                else:
                    change.update(status="verified", correspondence=asdict(relation), frame_change=frame)
            if change["status"] != "verified":
                # A nominal analyzer frame is not a verified model chain.
                # Keep the independent new model, but do not propagate an
                # unproved root correspondence into subsequent changes.
                context["frame_to_root"] = None
                context["placement_frame_to_root"] = None
            prepared_context = _json(context)
        else:
            prepared_context = request.load_context_json
        from crystal_viewer.viewer.model_metadata import model_metadata
        derived_metadata = model_metadata(model, plans)
        candidate = ActiveModelSnapshot(request.structure_revision, request.source, model,
                                        request.parameters_json, plans,
                                        load_context_json=prepared_context,
                                        correction_limits_json=request.correction_limits_json,
                                        model_change_json=_json(change) if change is not None else None,
                                        derived_metadata_json=_json(derived_metadata),
                                        input_model=input_model, representatives_json=selection)
        with self._lock:
            if request is not self._request:
                raise ModelConflict("obsolete preparation result")
            self._candidate = candidate
        return candidate

    def publish(self, candidate):
        with self._lock:
            # Identity, not dataclass equality: cached/forged/replayed candidates
            # must pass the current complete preparation before publication.
            if candidate is not self._candidate or candidate.structure_revision != self._revision:
                raise ModelConflict("obsolete or unverified candidate")
            self._active = candidate
            self._reservation = None
            self._request = None
            self._candidate = None
            return candidate

    def snapshot(self, identity=None):
        with self._lock:
            if self._active is None:
                raise ModelConflict("model not prepared")
            if identity is not None:
                self._active.require(identity)
            return self._active

    def finish(self, snapshot, body):
        with self._lock:
            if self._active is not snapshot:
                raise ModelConflict("obsolete asynchronous response")
            return dict(api_version=2, schema_version=2, **snapshot.identity(), **body)

    def initial(self, snapshot=None):
        snapshot = self.snapshot() if snapshot is None else snapshot
        model = snapshot.model
        # Source-derived fields here are metadata only; all geometry and atom
        # correspondence come from the verified model.
        B = np.array(model.lattice).T if model.periodic else np.eye(3)
        atoms = [dict(index=index, species=json.loads(species), coordinates=point,
                      cart_A=(B @ point).tolist()) for index, species, point in
                 zip(model.correspondence.atom_indices, model.species, model.positions)]
        operations = [dict(operation_index=index, operation_id=operation_id(model, index),
            matrix=matrix, translation=translation, continuous=matrix is None,
            plans=[dict(mode=p.mode, plan_id=p.plan_id) for p in snapshot.plans if p.operation_index == index])
            for index, matrix, translation in zip(model.correspondence.operation_indices,
                                                  model.matrices, model.translations)]
        policy = None
        if snapshot.correction_limits_json is not None:
            from crystal_viewer.viewer.model_policy import CorrectionLimits, correction_report
            policy = correction_report(snapshot.source, snapshot.input_model or model, CorrectionLimits(**json.loads(snapshot.correction_limits_json)))
        return self.finish(snapshot, dict(periodic=model.periodic, lattice=model.lattice,
            correction_policy=policy,
            cell_representatives=json.loads(snapshot.representatives_json) if snapshot.representatives_json else None,
            model_change=json.loads(snapshot.model_change_json) if snapshot.model_change_json is not None else None,
            permutations=model.permutations, image_shifts=model.image_shifts,
            continuous_family=asdict(model.continuous) if model.continuous is not None else None,
            coordinate_space="fractional" if model.periodic else "cartesian_A",
            atoms=atoms, operations=operations, correspondence=asdict(model.correspondence),
            diagnostics=asdict(model.validation), analysis_context=json.loads(snapshot.source.analysis_context_json),
            preparation_parameters=json.loads(snapshot.parameters_json),
            activation_scope="api2_only"))


def operation_id(model, index):
    from crystal_viewer.symmetry_model import _id
    return _id("operation", [MATH_VERSION, model.model_id, model.frame_id, index])
