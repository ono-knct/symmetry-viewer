"""Explicit exports of the common validated model, not legacy analysis output.

Schema 8 retains the outer render_data/atom_mappings layout. Audit information
and plans are descriptive: loading always verifies the stored geometry again.
"""
from copy import deepcopy
from dataclasses import asdict
import json
import os
from pathlib import Path
import tempfile

import numpy as np

from crystal_viewer.json_export import to_jsonable
from crystal_viewer.viewer.api2 import API2
from crystal_viewer.viewer.model_loading import ModelLoads
from crystal_viewer.viewer.model_session import ModelSession
from crystal_viewer.viewer.model_view import ModelView, elements
from crystal_viewer.viewer.model_policy import correction_report, CorrectionLimits

VERIFIED_EXPORT_SCHEMA_VERSION = 8


def prepare_view(payload, *, path="input.json", tolerance_cart=.01, host="standalone"):
    if isinstance(tolerance_cart, bool) or not np.isfinite(tolerance_cart) or tolerance_cart <= 0:
        raise ValueError("positive finite atom mapping tolerance required")
    session = ModelSession()
    view = ModelView(API2(session))
    loads = ModelLoads(session, analysis_context=dict(host=host, historical_analysis_conditions="unknown"),
        mapping_tolerance_A=float(tolerance_cart), operation_match_tolerance=.01, model_view=view)
    loads.load(lambda: (Path(path), payload), provenance=dict(entrypoint=host))
    view.bundle()
    return view


def verified_export_payload(payload, *, tolerance_cart=.01):
    view = prepare_view(payload, tolerance_cart=tolerance_cart, host="verified_export")
    return export_view(view)


def export_view(view):
    """Serialize an already published common view; never trust saved plans."""
    snapshot = view.snapshot
    model = snapshot.model
    data = deepcopy(view.data)
    # A conversion witness belongs to the exact raw output, not this projection.
    data["metadata"].pop("model_frame_change", None)
    B = np.array(model.lattice).T if model.periodic else np.eye(3)
    inverse = np.linalg.inv(B)
    data.update(asymmetric_atoms=[], axes=[], planes=[], centers=[])
    plans = {(p.operation_index, p.mode): p for p in snapshot.plans}
    mappings = []
    for slot, operation in enumerate(data["operations"]):
        index = operation["index"]
        if model.matrices[slot] is None:
            # No arbitrary finite matrix or representative angle in the file.
            operation.update(kind="rotation_infinite", order=None, matrix_cart=None, translation_cart=None,
                continuous_axis=dict(point_cart=model.continuous.center, direction_cart=model.continuous.direction))
            geometry = dict(axes=[dict(point_cart=model.continuous.center,
                                      direction_cart=model.continuous.direction)], planes=[], centers=[])
            W, t = np.eye(3), np.zeros(3)  # atom action fixes the validated line for every angle
        else:
            geometry = elements(plans[index, "default"])
            W, t = model.operation_components(index)
        for kind in ("axes", "planes", "centers"):
            for item in geometry[kind]:
                item = dict(item, index=len(data[kind]), operation_indices=[index], label=operation["symbol"])
                if model.periodic:
                    item["point_frac"] = inverse@item["point_cart"]
                    if kind == "axes":
                        item["direction_frac"] = inverse@item["direction_cart"]
                    elif kind == "planes":
                        item["normal_frac"] = B.T@item["normal_cart"]
                        item["basis_frac"] = [inverse@item[key] for key in ("basis1_cart", "basis2_cart")]
                data[kind].append(item)
        entries = []
        for source_slot, position in enumerate(model.positions):
            end = W@position+t
            target_slot = model.permutations[slot][source_slot]
            target = np.array(model.positions[target_slot])
            image = np.array(model.image_shifts[slot][source_slot]) if model.periodic else np.zeros(3)
            distance = float(np.linalg.norm(B@(end-target-image)))
            if distance > model.validation.residual_tolerance:
                raise ValueError("verified export atom endpoint residual exceeded")
            entries.append(dict(source_atom=model.correspondence.atom_indices[source_slot],
                target_atom=model.correspondence.atom_indices[target_slot], distance=distance,
                transformed_cart=B@end, transformed_frac=end if model.periodic else None,
                wrapped_frac=end % 1 if model.periodic else None,
                animation_frac=end if model.periodic else None,
                cell_image=image.astype(int).tolist() if model.periodic else None))
        mappings.append(dict(mode="crystal" if model.periodic else "molecule", operation_index=index,
            operation_kind=operation["kind"], complete=True, atom_to_atom=[e["target_atom"] for e in entries],
            max_distance=max(e["distance"] for e in entries), unmatched_atoms=[], entries=entries,
            continuous_all_angles=model.matrices[slot] is None))
    result = dict(schema_version=VERIFIED_EXPORT_SCHEMA_VERSION,
        source_kind="crystal" if model.periodic else "molecule", render_data=data,
        atom_mappings=dict(mode="crystal" if model.periodic else "molecule", complete=True,
                           incomplete_operation_indices=[], mappings=mappings),
        verified_export=dict(version=1, math_version=snapshot.math_version,
            identity=snapshot.identity(), source_input=json.loads(snapshot.source.payload_json),
            analysis_context=json.loads(snapshot.source.analysis_context_json),
            preparation_parameters=json.loads(snapshot.parameters_json),
            validation=asdict(model.validation), correction_report=correction_report(snapshot.source, snapshot.input_model or model, CorrectionLimits()),
            cell_representatives=json.loads(snapshot.representatives_json) if snapshot.representatives_json else None,
            plans=[asdict(p) for p in snapshot.plans],
            stored_records_are_diagnostic=True))
    # One finite, independent JSON document; no mutable model references escape.
    return json.loads(json.dumps(to_jsonable(result), allow_nan=False))


def write_verified_export(path, payload, *, indent=2):
    """Replace an explicitly requested file only after complete serialization."""
    path = Path(path)
    document = json.dumps(payload, ensure_ascii=False, indent=indent, allow_nan=False)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                         prefix="."+path.name+".", suffix=".tmp", delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(document)
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return path
