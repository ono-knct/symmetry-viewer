"""Opt-in load transactions; the legacy viewer never consumes these models.

Source analysis/conversion payloads remain input and diagnosis. Each change
prepares the whole model anew before publishing, under the user-approved
provisional correction limits. Normal-screen activation remains separate.
"""
from dataclasses import asdict
import json
import threading

import numpy as np

from crystal_viewer.symmetry_model import _id, _json
from crystal_viewer.viewer.cell_frame import read_frame_witness
from crystal_viewer.viewer.cell_placement import placement_choices, translated_payload
from crystal_viewer.viewer.cell_setting_cache import CellSettingCache, conversion_key
from crystal_viewer.viewer.model_session import MATH_VERSION, ModelConflict
from crystal_viewer.viewer.model_policy import CorrectionLimits


def identity_frame():
    return dict(basis=np.eye(3).tolist(), origin=[0., 0., 0.], cartesian_rotation=np.eye(3).tolist())


def compose_frame(outer, inner):
    if outer is None or inner is None:
        return None
    A, a, Q = (np.asarray(outer[key]) for key in ("basis", "origin", "cartesian_rotation"))
    B, b, R = (np.asarray(inner[key]) for key in ("basis", "origin", "cartesian_rotation"))
    return dict(basis=(A@B).tolist(), origin=(A@b+a).tolist(), cartesian_rotation=(Q@R).tolist())


def relative_frame(old, new):
    if old is None or new is None:
        return None
    A, a, Q = (np.asarray(old[key]) for key in ("basis", "origin", "cartesian_rotation"))
    B, b, R = (np.asarray(new[key]) for key in ("basis", "origin", "cartesian_rotation"))
    return dict(basis=np.linalg.solve(A, B).tolist(), origin=np.linalg.solve(A, b-a).tolist(),
                cartesian_rotation=(Q.T@R).tolist())


class ModelLoads:
    def __init__(self, session, *, analysis_context, mapping_tolerance_A,
                 residual_tolerance=1e-9, operation_match_tolerance=None,
                 correction_limits=CorrectionLimits(), model_view=None):
        if not isinstance(correction_limits, CorrectionLimits):
            raise ValueError("CorrectionLimits required")
        self.session = session
        self._limits = correction_limits
        self._analysis = _json(analysis_context)
        self._parameters = _json(dict(mapping_tolerance_A=mapping_tolerance_A,
            residual_tolerance=residual_tolerance, operation_match_tolerance=operation_match_tolerance))
        self._lock = threading.RLock()
        self._cells = CellSettingCache()
        if model_view is None:
            from crystal_viewer.viewer.api2 import API2
            from crystal_viewer.viewer.model_view import ModelView
            model_view = ModelView(API2(session))
        self.bind_view(model_view)

    def bind_view(self, view):
        if view.session is not self.session:
            raise ValueError("ModelView and ModelLoads must share one ModelSession")
        self.view = view

    def _complete(self, ticket, payload, context, provenance, *, cache=None, clear_cache=False, previous=None,
                  representative_lower=None, view_update=None):
        if self.session.cell_representatives:
            context["representative_cell_lower"] = (representative_lower if representative_lower is not None else
                -.5 if previous is not None and self.view.state.get("cell_origin_mode") == "center" else 0.)
        request = self.session.begin(payload, analysis_context=dict(
            conditions=json.loads(self._analysis), provenance=provenance),
            reservation=ticket, load_context=context, correction_limits=self._limits, **json.loads(self._parameters))
        candidate = self.session.prepare(request, previous=previous)
        # Keep the current view intact until every display adapter has accepted
        # the candidate. A newer reservation can still invalidate this work.
        with self.view.lock:
            self.session.require_reservation(ticket)
            self.view.sync()
            staged = self.view.prepare(candidate)
            if view_update:
                staged._apply_state_update(view_update)
            with self._lock:
                self.session.publish(candidate)
                self.view.adopt(staged)
                if clear_cache:
                    self._cells.clear()
                if cache is not None:
                    key, serialized = cache
                    self._cells.put(key, {"payload_json": serialized})
        return self.session.initial(candidate)

    def load(self, loader, *, provenance, identity=None):
        """loader returns (path, analysis payload); reserve before invoking it."""
        with self._lock:
            if identity is not None:
                self.session.snapshot(identity)
            ticket = self.session.reserve()
        try:
            path, payload = loader()
            # Capture independent JSON copies before any external caller can
            # mutate a cached source after validation/publication.
            payload = json.loads(_json(payload))
            if not isinstance(payload, dict) or not isinstance(payload.get("render_data"), dict):
                raise ValueError("analysis output must contain render_data")
            context = dict(json_path=str(path), base_payload=payload, placement_payload=payload,
                root_load_revision=ticket.structure_revision, origin_frac=[0, 0, 0], cell_setting="native",
                frame_to_root=identity_frame(), placement_frame_to_root=identity_frame())
            return self._complete(ticket, payload, context, provenance, clear_cache=True)
        except Exception:
            self.session.abort(ticket)
            raise

    def _change(self, identity):
        with self._lock:
            snapshot = self.session.snapshot(identity)
            context = json.loads(snapshot.load_context_json)
            if not context:
                raise ValueError("load the source through ModelLoads before a cell change")
            if not snapshot.model.periodic:
                raise ValueError("cell changes require a periodic model")
            ticket = self.session.reserve()
            return snapshot, context, ticket

    def cell_setting(self, identity, mode, converter, *, tolerance_cart):
        snapshot, context, ticket = self._change(identity)
        try:
            if mode not in ("native", "primitive", "conventional"):
                raise ValueError("unknown cell setting")
            source = context["base_payload"] if mode == "native" else context["placement_payload"]
            key = _id("model_cell_input", [MATH_VERSION, context["root_load_revision"],
                self._analysis, self._parameters, asdict(self._limits), conversion_key(source, mode, tolerance_cart)])
            with self._lock:
                self.session.require_reservation(ticket)
                cached = self._cells.get(key)
                serialized = cached["payload_json"] if cached is not None else None
            if serialized is None:
                payload = converter(json.loads(_json(source)), mode)
                serialized = _json(payload)
            payload = json.loads(serialized)
            if not payload.get("render_data", {}).get("unit_cell"):
                raise ValueError("cell conversion must return a periodic source")
            witness = read_frame_witness(source, payload)
            source_frame = identity_frame() if mode == "native" else context.get("placement_frame_to_root")
            next_frame = compose_frame(source_frame, witness)
            if mode == "native":
                frame_change = relative_frame(context.get("frame_to_root"), next_frame)
            else:
                # The witness starts at placement_payload, before the current
                # placement origin was subtracted. This local frame is known
                # independently of any verified chain to the original load.
                current_to_placement = identity_frame()
                current_to_placement["origin"] = (-np.asarray(context["origin_frac"])).tolist()
                frame_change = compose_frame(current_to_placement, witness)
            context.update(frame_change=frame_change,
                           frame_to_root=next_frame, placement_frame_to_root=next_frame,
                           placement_payload=payload, origin_frac=[0, 0, 0], cell_setting=mode)
            return self._complete(ticket, payload, context, dict(entrypoint="cell_setting", mode=mode,
                parent=snapshot.identity(), conversion_tolerance_A=tolerance_cart), cache=(key, serialized), previous=snapshot)
        except Exception:
            self.session.abort(ticket)
            raise

    def cell_placement(self, identity, placement, *, atom_index=None, target=None):
        snapshot, context, ticket = self._change(identity)
        try:
            model = snapshot.model
            if placement == "initial":
                origin = np.zeros(3)
            else:
                if isinstance(atom_index, bool) or not isinstance(atom_index, int):
                    raise ValueError("one integer atom_index required")
                slot = model.correspondence.atom_indices.index(atom_index)
                previous_origin = np.array(context["origin_frac"])
                # Resolve site and face equivalence on the verified model,
                # expressed back in this basis's canonical placement frame.
                canonical = dict(atoms=[dict(index=index, frac=(np.array(x)+previous_origin).tolist())
                    for index, x in zip(model.correspondence.atom_indices, model.positions)],
                    operations=[dict(matrix_frac=W, translation_frac=(np.array(t)-(np.array(W)-np.eye(3))@previous_origin).tolist())
                        for W, t in zip(model.matrices, model.translations)])
                choices = placement_choices(canonical, atom_index)
                choice = next((item for item in choices if item["key"] == placement), None)
                if choice is None:
                    raise ValueError("unknown cell placement")
                destination = np.asarray(target if placement == "custom" else choice["target"], dtype=float)
                if destination.shape != (3,) or not np.all(np.isfinite(destination)) or np.any(destination < 0) or np.any(destination > 1):
                    raise ValueError("three fractional destination coordinates in 0..1 required")
                origin = np.array(model.positions[slot])+previous_origin-destination
            payload = translated_payload(context["placement_payload"], origin)
            saved = payload.get("verified_export", {}).get("cell_representatives")
            if saved is not None:
                # This in-memory payload now uses a different coordinate
                # origin. Transport both ends of the saved relation before
                # independently validating it against the new input.
                for item in saved.get("operations", []):
                    correction = (np.asarray(item["matrix"])-np.eye(3)) @ origin
                    for key in ("source_translation", "translation"):
                        item[key] = (np.asarray(item[key])+correction).tolist()
            frame = identity_frame()
            frame["origin"] = (origin-np.asarray(context["origin_frac"])).tolist()
            absolute = identity_frame()
            absolute["origin"] = origin.tolist()
            context.update(origin_frac=origin.tolist(), frame_change=frame,
                           frame_to_root=compose_frame(context.get("placement_frame_to_root"), absolute))
            return self._complete(ticket, payload, context, dict(entrypoint="cell_placement",
                parent=snapshot.identity(), origin_frac=origin.tolist(), placement=placement,
                atom_index=atom_index, target=None if placement == "initial" else destination.tolist()), previous=snapshot)
        except Exception:
            self.session.abort(ticket)
            raise

    def reference_cell(self, identity, mode, *, update=None):
        """Change only the displayed cell convention, retaining actual origin."""
        snapshot, context, ticket = self._change(identity)
        try:
            if not self.session.cell_representatives or mode not in ("corner", "center"):
                raise ValueError("unsupported representative reference cell")
            context["frame_change"] = identity_frame()
            payload = json.loads(snapshot.source.payload_json)
            state = self.view.state
            return self._complete(ticket, payload, context,
                dict(entrypoint="reference_cell", parent=snapshot.identity(),
                     placement=state["cell_placement"], atom_index=state["cell_placement_atom"],
                     target=state["cell_placement_target"]), previous=snapshot,
                representative_lower=-.5 if mode == "center" else 0., view_update=update)
        except Exception:
            self.session.abort(ticket)
            raise

    def reset(self, identity=None):
        with self._lock:
            try:
                current = self.session.snapshot()
            except ModelConflict:
                if identity and "model_id" in identity:
                    raise
            else:
                current.require(identity or {})
            ticket = self.session.reserve()
            self.session.clear(ticket)
            self._cells.clear()
        return dict(api_version=2, schema_version=2, math_version=MATH_VERSION,
                    structure_revision=ticket.structure_revision, model=None, ok=True)
