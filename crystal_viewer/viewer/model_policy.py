"""User-approved operational correction limits, separate from math residuals."""
from dataclasses import asdict, dataclass
import json

import numpy as np

from crystal_viewer.symmetry_model import PreparationError


@dataclass(frozen=True)
class CorrectionLimits:
    atom_change_A: float = .01
    operation_translation_change_A: float = .01
    operation_matrix_component_change: float = .01
    lattice_edge_relative_change: float = .001
    lattice_angle_change_deg: float = .1

    def __post_init__(self):
        if any(isinstance(value, bool) or not np.isfinite(value) or value <= 0 for value in asdict(self).values()):
            raise ValueError("positive finite correction limits required")


class CorrectionLimitError(PreparationError):
    def __init__(self, report):
        self.report = report
        super().__init__("correction limit exceeded: "+", ".join(report["violations"]))


def correction_report(source, model, limits):
    validation = model.validation
    payload = json.loads(source.payload_json)
    data = payload.get("render_data", payload)
    lengths = np.linalg.norm(data["unit_cell"]["lattice"], axis=1) if model.periodic else []
    measures = dict(atom_change_A=max(validation.atom_correction_max_A, validation.total_cartesian_change_max_A),
        operation_translation_change_A=validation.operation_translation_correction_max_A,
        operation_matrix_component_change=validation.operation_matrix_correction_max,
        lattice_edge_relative_change=max((float(abs(delta)/length) for delta, length in
            zip(validation.lattice_length_changes_A, lengths)), default=0.),
        lattice_angle_change_deg=max(map(abs, validation.lattice_angle_changes_deg), default=0.))
    bounds = asdict(limits)
    violations = [key for key, value in measures.items() if not np.isfinite(value) or value > bounds[key]]
    return dict(limits=bounds, measures=measures, violations=violations,
                status="accepted" if not violations else "exceeded",
                provenance="user-approved provisional operational policy, not a symmetry proof")
