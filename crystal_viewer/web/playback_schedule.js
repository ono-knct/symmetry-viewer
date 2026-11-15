// API2 whole-space playback. Geometry and timing are supplied by the server.
// This module has no DOM/Three.js dependencies and never classifies operations,
// wraps cells, replaces endpoints by mapped atoms, or rebuilds stage timings.
const identityKeys = ["model_id", "source_model_id", "frame_id", "structure_revision", "math_version"];
export const ANIMATION_SPEED_STEPS = Object.freeze([0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3]);
const stageKinds = new Set(["rotation", "translation", "reflection", "inversion", "affine"]);

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}
function finite(value) { return typeof value === "number" && Number.isFinite(value); }
function nonnegative(value) { return finite(value) && value >= 0; }
function vector(value) { return Array.isArray(value) && value.length === 3 && value.every(finite); }
function matrix(value) { return Array.isArray(value) && value.length === 3 && value.every(vector); }
function points(value) { return Array.isArray(value) && value.every(vector); }
function near(a, b) {
  return Math.abs(a - b) <= 64 * Number.EPSILON * Math.max(1, Math.abs(a), Math.abs(b));
}
function sum(values) { return values.reduce((total, value) => total + value, 0); }
function affine(M, t, point) {
  return M.map((row, i) => row.reduce((value, a, j) => value + a * point[j], t[i]));
}
function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function stagePoint(stage, point, u) {
  if (stage.kind === "rotation") {
    // Quaternion rotation keeps the signed, complete entered angle. No angle
    // reduction or endpoint snapping is used, including for multiple turns.
    const half = stage.angle_rad * u / 2;
    const w = Math.cos(half), sine = Math.sin(half);
    const q = stage.direction.map(value => value * sine);
    const p = point.map((value, i) => value - stage.center[i]);
    const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
    const v = cross(q, p).map(value => 2 * value);
    const extra = cross(q, v);
    return p.map((value, i) => value + w*v[i] + extra[i] + stage.center[i]);
  }
  const end = affine(stage.matrix, stage.translation, point);
  return point.map((value, i) => value + u * (end[i] - value));
}

export function compilePlayback(response, expected) {
  requireValue(response && response.api_version === 2 && response.schema_version === 2 &&
    response.math_version === 1, "unsupported_contract");
  requireValue(expected && identityKeys.every(key => response[key] !== undefined && response[key] === expected[key]) &&
    typeof response.plan_id === "string" && response.plan_id.length > 0 && response.plan_id === expected.plan_id &&
    Number.isSafeInteger(response.structure_revision) && response.structure_revision > 0 &&
    identityKeys.slice(0, 3).every(key => typeof response[key] === "string" && response[key].length > 0), "state_mismatch");
  const {plan, schedule, references} = response;
  requireValue(plan && schedule && references, "incomplete_playback");
  for (const item of [plan, schedule]) {
    requireValue(item.model_id === response.model_id && item.frame_id === response.frame_id &&
      item.plan_id === response.plan_id, "mixed_plan_response");
  }
  requireValue(references.model_id === response.model_id && references.frame_id === response.frame_id,
    "mixed_reference_points");
  requireValue(typeof schedule.schedule_id === "string" && schedule.schedule_id.length > 0 &&
    typeof schedule.reference_id === "string" && schedule.reference_id.length > 0 &&
    (expected.schedule_id === undefined || schedule.schedule_id === expected.schedule_id) &&
    (expected.reference_id === undefined || schedule.reference_id === expected.reference_id), "schedule_mismatch");
  requireValue(points(references.points_cart_A), "invalid_reference_points");
  requireValue(Array.isArray(plan.stages) && plan.stages.length > 0, "invalid_stages");
  for (const stage of plan.stages) {
    requireValue(stage && stageKinds.has(stage.kind) && matrix(stage.matrix) && vector(stage.translation) &&
      vector(stage.center) && vector(stage.direction) && finite(stage.angle_rad), "invalid_stage");
    if (stage.kind === "rotation") {
      requireValue(Math.abs(Math.hypot(...stage.direction) - 1) <= 1e-9, "invalid_rotation_axis");
    }
    if (stage.kind === "rotation" || stage.kind === "reflection") {
      requireValue(Math.abs(Math.hypot(...stage.direction) - 1) <= 1e-9, "invalid_stage_direction");
      const n = stage.direction;
      const c = Math.cos(stage.angle_rad), s = Math.sin(stage.angle_rad);
      const skew = [[0, -n[2], n[1]], [n[2], 0, -n[0]], [-n[1], n[0], 0]];
      const geometric = n.map((_, i) => n.map((_, j) => stage.kind === "rotation"
        ? c * Number(i === j) + (1-c)*n[i]*n[j] + s*skew[i][j]
        : Number(i === j) - 2*n[i]*n[j]));
      requireValue(geometric.every((row, i) => row.every((v, j) => Math.abs(v-stage.matrix[i][j]) <= 1e-9)) &&
        geometric.every((row, i) => Math.abs(stage.center[i] -
          sum(row.map((v, j) => v*stage.center[j])) - stage.translation[i]) <= 1e-8),
        "stage_geometry_mismatch");
    }
  }
  requireValue(Array.isArray(schedule.applications) && schedule.applications.length >= 1 &&
    schedule.applications.length <= 120 && nonnegative(schedule.boundary_tolerance_seconds) &&
    nonnegative(schedule.stationary_tolerance_A), "invalid_schedule");
  for (const app of schedule.applications) {
    requireValue(app && matrix(app.prefix_matrix) && vector(app.prefix_translation_A) &&
      Array.isArray(app.stage_durations_seconds) && app.stage_durations_seconds.length === plan.stages.length &&
      app.stage_durations_seconds.every(nonnegative) &&
      Array.isArray(app.stage_max_motion_A) && app.stage_max_motion_A.length === plan.stages.length &&
      app.stage_max_motion_A.every(nonnegative) && nonnegative(app.movement_duration_seconds) &&
      nonnegative(app.presentation_hold_seconds) && nonnegative(app.duration_seconds) &&
      near(sum(app.stage_durations_seconds), app.movement_duration_seconds) &&
      near(app.movement_duration_seconds + app.presentation_hold_seconds, app.duration_seconds), "invalid_application_timing");
  }
  requireValue(nonnegative(schedule.duration_seconds) && nonnegative(schedule.movement_duration_seconds) &&
    nonnegative(schedule.presentation_hold_seconds) &&
    near(sum(schedule.applications.map(app => app.duration_seconds)), schedule.duration_seconds) &&
    near(sum(schedule.applications.map(app => app.movement_duration_seconds)), schedule.movement_duration_seconds) &&
    near(sum(schedule.applications.map(app => app.presentation_hold_seconds)), schedule.presentation_hold_seconds), "invalid_total_timing");
  requireValue(Array.isArray(schedule.step_boundaries_seconds) && schedule.step_boundaries_seconds.every((value, i, values) =>
    nonnegative(value) && value <= schedule.duration_seconds + schedule.boundary_tolerance_seconds && (i === 0 || value > values[i - 1])), "invalid_step_boundaries");
  requireValue(schedule.status === (references.points_cart_A.length ? "ready" : "no_reference_points"), "invalid_reference_status");
  // Hold a private immutable copy so mutation of a response or cache entry
  // after validation cannot change a later frame.
  const data = freeze(JSON.parse(JSON.stringify({plan, schedule, references})));
  const evaluate = (progress, inputPoints = data.references.points_cart_A) => {
    requireValue(finite(progress), "invalid_progress");
    requireValue(points(inputPoints), "invalid_points");
    const u = Math.max(0, Math.min(1, progress));
    if (u === 0) return inputPoints.map(point => [...point]);
    let elapsed = u * data.schedule.duration_seconds;
    const epsilon = data.schedule.boundary_tolerance_seconds;
    for (let i = 0; i < data.schedule.applications.length; i++) {
      const app = data.schedule.applications[i];
      if ((u === 1 || elapsed + epsilon >= app.duration_seconds) && i < data.schedule.applications.length - 1) {
        elapsed = Math.max(0, elapsed - app.duration_seconds);
        continue;
      }
      let current = inputPoints.map(point => affine(app.prefix_matrix, app.prefix_translation_A, point));
      for (let j = 0; j < data.plan.stages.length; j++) {
        const seconds = app.stage_durations_seconds[j];
        // Zero-time stages remain in the composition and execute in order.
        if (u === 1 || seconds === 0 || elapsed + epsilon >= seconds) {
          current = current.map(point => stagePoint(data.plan.stages[j], point, 1));
          elapsed = Math.max(0, elapsed - seconds);
        } else {
          return current.map(point => stagePoint(data.plan.stages[j], point, elapsed / seconds));
        }
      }
      return current; // Any remaining time is the supplied presentation hold.
    }
    return inputPoints.map(point => [...point]);
  };
  return Object.freeze({model_id: response.model_id, source_model_id: response.source_model_id,
    frame_id: response.frame_id, math_version: response.math_version,
    plan_id: response.plan_id, structure_revision: response.structure_revision,
    schedule_id: data.schedule.schedule_id, reference_id: data.schedule.reference_id,
    duration_seconds: data.schedule.duration_seconds,
    step_boundaries_seconds: data.schedule.step_boundaries_seconds, evaluate});
}

// Shared wall-clock conversion for analysis and quiz playback. The schedule
// owns stage durations; presentation code must not redistribute their time.
export function playbackDurationMs(seconds, speed = 1) {
  return seconds * 1000 / Math.max(Number(speed) || 1, 0.1);
}

export function playbackProgressAt(timestamp, startedAt, durationMs) {
  if (durationMs <= 0) return 1;
  return Math.max(0, Math.min((timestamp - startedAt) / durationMs, 1));
}

// Presentation-only operation gaps. No stage or schedule timing is rewritten.
export function playbackStepAt(timestamp, startedAt, durationMs, previousProgress,
    {holdUntil = null, boundaries = []} = {}) {
  if (holdUntil != null) {
    if (timestamp < holdUntil) return {progress: previousProgress, startedAt, holdUntil, waiting: true};
    holdUntil = null;
    startedAt = timestamp - previousProgress * durationMs;
  }
  if (startedAt == null) startedAt = timestamp - previousProgress * durationMs;
  let progress = playbackProgressAt(timestamp, startedAt, durationMs);
  const boundary = boundaries.find(value => value > previousProgress + 1e-9
    && value < 1 - 1e-9 && value <= progress + 1e-9);
  if (boundary !== undefined) {
    progress = boundary;
    holdUntil = timestamp + 200;
  }
  return {progress, startedAt, holdUntil, waiting: false};
}
