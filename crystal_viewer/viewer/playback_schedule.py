"""Reference-dependent timing for one immutable model/plan snapshot.

Geometry never depends on repetition count. Zero-duration stages remain in
the plan and execute in input order. Presentation holds are separate from
movement; no browser application-boundary holds are inserted here.
"""
from dataclasses import asdict, dataclass

import numpy as np

from crystal_viewer.affine_math import compose
from crystal_viewer.symmetry_model import PreparationError, _id, _tuple
from crystal_viewer.viewer.animation_path import (
    NORMALIZED_TRAVEL_SPEED_PER_SECOND, STATIONARY_ANIMATION_SECONDS,
)
from crystal_viewer.viewer.operation_plan import evaluate_stage


@dataclass(frozen=True)
class ReferencePoints:
    model_id: str
    frame_id: str
    points_cart_A: tuple

    @classmethod
    def from_model(cls, model, *, atom_indices=None, cell_images=((0, 0, 0),)):
        indices = model.correspondence.atom_indices if atom_indices is None else tuple(atom_indices)
        images = np.array(cell_images)
        if images.ndim != 2 or images.shape[1] != 3 or not np.all(np.isfinite(images)) or not np.array_equal(images, np.rint(images)):
            raise ValueError("integer cell images required")
        if not model.periodic and np.any(images != 0):
            raise ValueError("molecules do not have periodic images")
        B = np.array(model.lattice).T if model.periodic else np.eye(3)
        points = []
        for index in indices:
            slot = model.correspondence.atom_indices.index(index)
            points.extend(B@(np.array(model.positions[slot])+image) for image in images)
        return cls(model.model_id, model.frame_id, _tuple(np.array(points).reshape(-1, 3)))


@dataclass(frozen=True)
class ApplicationSchedule:
    prefix_matrix: tuple
    prefix_translation_A: tuple
    stage_durations_seconds: tuple
    stage_max_motion_A: tuple
    movement_duration_seconds: float
    presentation_hold_seconds: float
    duration_seconds: float


@dataclass(frozen=True)
class PlaybackSchedule:
    schedule_id: str
    model_id: str
    frame_id: str
    plan_id: str
    reference_id: str
    applications: tuple[ApplicationSchedule, ...]
    movement_duration_seconds: float
    presentation_hold_seconds: float
    duration_seconds: float
    stationary_tolerance_A: float
    boundary_tolerance_seconds: float
    step_boundaries_seconds: tuple
    status: str


def _stage_lengths(stage, points):
    if stage.kind == "rotation":
        delta = points-np.array(stage.center)
        n = np.array(stage.direction)
        radii = np.linalg.norm(delta-(delta@n)[:, None]*n, axis=1)
        return radii*abs(stage.angle_rad)
    return np.linalg.norm(evaluate_stage(stage, points, 1)-points, axis=1)


def model_structure_span_A(model):
    """Primary-atom Cartesian extent, independent of display and motion scope.

    Keep the existing 1 A floor for single atoms and small/degenerate inputs.
    Cell/model changes may change this scale; replication, hiding and selection
    do not. The same fixed scale is used throughout all stages and repetitions.
    """
    points = np.array(model.positions, dtype=float).reshape(-1, 3)
    if model.periodic:
        points = points @ np.array(model.lattice)
    return max(1., float(np.max(np.ptp(points, axis=0)))) if len(points) else 1.


def build_schedule(model, plan, references, *, scene_span_A, repetitions=1):
    plan.require_model(model)
    model.require_identity(model_id=references.model_id, frame_id=references.frame_id)
    if (isinstance(repetitions, bool) or int(repetitions) != repetitions or not 1 <= repetitions <= 120 or
            not np.isfinite(scene_span_A) or scene_span_A <= 0):
        raise ValueError("positive scene span and 1..120 integer repetitions required")
    points = np.array(references.points_cart_A, dtype=float).reshape(-1, 3)
    if not np.all(np.isfinite(points)):
        raise ValueError("finite reference points required")
    stationary = 1e-10*max(1., scene_span_A)
    reference_id = _id("references", asdict(references))
    applications, boundaries = [], []
    prefix = (np.eye(3), np.zeros(3))
    speed_A_per_second = scene_span_A * NORMALIZED_TRAVEL_SPEED_PER_SECOND
    elapsed = 0.
    for application in range(int(repetitions)):
        current = points@prefix[0].T+prefix[1]
        lengths = []
        for stage in plan.stages:
            lengths.append(_stage_lengths(stage, current))
            current = evaluate_stage(stage, current, 1)
        distances = np.array(lengths).reshape(len(plan.stages), len(points))
        maxima = np.max(distances, axis=1, initial=0.)
        motion = np.where(maxima <= stationary, 0., maxima)
        moving = bool(np.any(motion > 0))
        # Each elementary motion gets the same maximum atom speed, including
        # later applications whose accumulated starting positions differ.
        stage_times = motion / speed_A_per_second
        duration = float(np.sum(stage_times))
        hold = STATIONARY_ANIMATION_SECONDS if len(points) and not moving else 0.
        app = ApplicationSchedule(_tuple(prefix[0]), _tuple(prefix[1]), _tuple(stage_times), _tuple(maxima),
                                  duration, hold, duration+hold)
        applications.append(app)
        start = elapsed
        stage_elapsed = 0.
        positive = np.flatnonzero(stage_times > 0)
        for stage_index, stage_time in enumerate(stage_times):
            stage_elapsed += stage_time
            if stage_time > 0:
                boundaries.append(start+(duration if stage_index == positive[-1] else stage_elapsed))
        elapsed = start+app.duration_seconds
        if hold > 0:
            boundaries.append(elapsed)
        for stage in plan.stages:
            prefix = compose((stage.matrix, stage.translation), prefix)
    total_movement = sum(a.movement_duration_seconds for a in applications)
    total_hold = sum(a.presentation_hold_seconds for a in applications)
    # Use the same accumulation as application/step boundaries. Python's sum
    # may compensate roundoff while repeated timeline additions do not; after
    # many applications those totals can differ by more than boundary tolerance.
    total_duration = elapsed
    boundary_tolerance = float(8*np.spacing(max(1., total_duration)))
    contents = dict(version=2, model=model.model_id, frame=model.frame_id, plan=plan.plan_id,
                    reference=reference_id, scene_span_A=scene_span_A,
                    stationary_tolerance_A=stationary, boundary_tolerance_seconds=boundary_tolerance,
                    applications=[asdict(a) for a in applications])
    return PlaybackSchedule(_id("schedule", contents), model.model_id, model.frame_id, plan.plan_id,
        reference_id, tuple(applications), total_movement, total_hold, total_duration,
        stationary, boundary_tolerance, tuple(float(t) for t in sorted(set(boundaries))),
        "ready" if len(points) else "no_reference_points")


def evaluate_schedule(plan, schedule, points_cart_A, progress):
    if (plan.plan_id, plan.model_id, plan.frame_id) != (schedule.plan_id, schedule.model_id, schedule.frame_id):
        raise PreparationError("schedule/plan/model/frame mismatch")
    if not np.isfinite(progress):
        raise ValueError("finite progress required")
    u = float(np.clip(progress, 0, 1))
    points = np.array(points_cart_A, dtype=float)
    if u == 0:
        return points.copy()
    elapsed = u*schedule.duration_seconds
    epsilon = schedule.boundary_tolerance_seconds
    for i, app in enumerate(schedule.applications):
        if (u == 1 or elapsed+epsilon >= app.duration_seconds) and i < len(schedule.applications)-1:
            elapsed = max(0., elapsed-app.duration_seconds)
            continue
        current = points@np.array(app.prefix_matrix).T+app.prefix_translation_A
        for stage, seconds in zip(plan.stages, app.stage_durations_seconds):
            if u == 1 or seconds == 0 or elapsed+epsilon >= seconds:
                current = evaluate_stage(stage, current, 1)
                elapsed = max(0., elapsed-seconds)
            else:
                return evaluate_stage(stage, current, elapsed/seconds)
        return current
    return points.copy()
