const EPSILON = 1e-12;

function add(a, b) {
  return a.map((value, index) => value + b[index]);
}

function subtract(a, b) {
  return a.map((value, index) => value - b[index]);
}

function scale(vector, factor) {
  return vector.map(value => value * factor);
}

function dot(a, b) {
  return a.reduce((sum, value, index) => sum + value * b[index], 0);
}

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function normalize(vector) {
  const norm = Math.sqrt(dot(vector, vector));
  return norm < EPSILON ? [...vector] : scale(vector, 1 / norm);
}

function interpolate(start, target, s) {
  return start.map((value, index) => (1 - s) * value + s * target[index]);
}

function rotateAboutAxis(point, axisPoint, axisDirection, angleRad) {
  const direction = normalize(axisDirection);
  const relative = subtract(point, axisPoint);
  const cosAngle = Math.cos(angleRad);
  const sinAngle = Math.sin(angleRad);
  const rotated = add(
    add(scale(relative, cosAngle), scale(cross(direction, relative), sinAngle)),
    scale(direction, dot(direction, relative) * (1 - cosAngle)),
  );
  return add(axisPoint, rotated);
}

function reflectPoint(point, planePoint, planeNormal) {
  const normal = normalize(planeNormal);
  return subtract(point, scale(normal, 2 * dot(subtract(point, planePoint), normal)));
}

function multiplyMatrixVector(matrix, vector) {
  return matrix.map(row => dot(row, vector));
}

export function pathAppliesToDisplayInstance(path, instance) {
  return Boolean(path) && (!path.unit_cell_only || Boolean(instance.isPrimaryImage));
}

function angleRadians(path) {
  if (!Number.isFinite(path.angle_deg)) {
    throw new Error(`Path type ${path.type} requires angle_deg`);
  }
  return path.angle_deg * Math.PI / 180;
}

function rotationArcLength(path, start) {
  const direction = normalize(path.axis_direction);
  const relative = subtract(start, path.axis_point);
  const axial = scale(direction, dot(relative, direction));
  return Math.sqrt(dot(subtract(relative, axial), subtract(relative, axial))) * Math.abs(angleRadians(path));
}

function twoPhaseGeometry(path, start) {
  let midpoint;
  let endpoint;
  let firstLength;
  if (path.type === "glide") {
    midpoint = reflectPoint(start, path.plane_point, path.plane_normal);
    endpoint = add(midpoint, path.translation);
    firstLength = Math.sqrt(dot(subtract(midpoint, start), subtract(midpoint, start)));
  } else {
    midpoint = rotateAboutAxis(start, path.axis_point, path.axis_direction, angleRadians(path));
    firstLength = rotationArcLength(path, start);
    if (path.type === "screw") endpoint = add(midpoint, path.translation);
    else if (path.type === "rotoinversion") endpoint = subtract(scale(path.center, 2), midpoint);
    else endpoint = reflectPoint(midpoint, path.plane_point, path.plane_normal);
  }
  const secondDelta = subtract(endpoint, midpoint);
  return {midpoint, endpoint, firstLength, secondLength: Math.sqrt(dot(secondDelta, secondDelta))};
}

function pathLength(path, startOverride = null) {
  if (path.type === "sequential") {
    if (!path.segments?.length) throw new Error("Sequential path requires at least one segment");
    let segmentStart = startOverride === null ? [...path.segments[0].start] : [...startOverride];
    let length = 0;
    for (const segment of path.segments) {
      length += pathLength(segment, segmentStart);
      segmentStart = evaluatePath(segment, 1, segmentStart);
    }
    return length;
  }
  const start = startOverride === null ? [...path.start] : [...startOverride];
  if (path.type === "rotation") return rotationArcLength(path, start);
  if (["screw", "glide", "rotoinversion", "rotoreflection"].includes(path.type)) {
    const geometry = twoPhaseGeometry(path, start);
    return geometry.firstLength + geometry.secondLength;
  }
  const delta = subtract(evaluatePath(path, 1, start), start);
  return Math.sqrt(dot(delta, delta));
}

function sequentialWeights(path, lengths) {
  const supplied = path.segment_weights;
  if (Array.isArray(supplied) && supplied.length === lengths.length
      && supplied.every(value => Number.isFinite(Number(value)) && Number(value) >= 0)) {
    return supplied.map(Number);
  }
  return lengths;
}

function phaseFraction(firstLength, secondLength) {
  const total = firstLength + secondLength;
  return total > EPSILON ? firstLength / total : 0.5;
}

export function pathBreakpoints(path, startOverride = null) {
  const result = new Set([0, 1]);
  if (path.type === "sequential" && path.segments?.length) {
    let segmentStart = startOverride === null ? [...path.segments[0].start] : [...startOverride];
    const starts = [];
    const lengths = [];
    for (const segment of path.segments) {
      starts.push(segmentStart);
      lengths.push(pathLength(segment, segmentStart));
      segmentStart = evaluatePath(segment, 1, segmentStart);
    }
    const weights = sequentialWeights(path, lengths);
    const total = weights.reduce((sum, length) => sum + length, 0);
    let cumulative = 0;
    for (let index = 0; index < path.segments.length; index += 1) {
      const scale = total > EPSILON ? weights[index] / total : 1 / weights.length;
      for (const local of pathBreakpoints(path.segments[index], starts[index])) {
        result.add(cumulative + scale * local);
      }
      cumulative += scale;
    }
  } else if (["screw", "glide", "rotoinversion", "rotoreflection"].includes(path.type)) {
    const start = startOverride === null ? [...path.start] : [...startOverride];
    const geometry = twoPhaseGeometry(path, start);
    result.add(Math.max(0, Math.min(
      Number(path.phase_fraction ?? phaseFraction(geometry.firstLength, geometry.secondLength)),
      1,
    )));
  } else if (path.type === "mirror_after_hold") {
    result.add(Math.max(0, Math.min(Number(path.hold_fraction) || 0.3, 1)));
  }
  return [...result].sort((a, b) => a - b);
}

export function sequentialSegmentIndex(path, progress, startOverride = null) {
  if (path.type !== "sequential" || !path.segments?.length) return null;
  const s = Math.min(1, Math.max(0, Number(progress)));
  const boundaries = sequentialSegmentBoundaries(path, startOverride);
  return boundaries.findIndex(boundary => s <= boundary + EPSILON);
}

export function sequentialSegmentBoundaries(path, startOverride = null) {
  if (path.type !== "sequential" || !path.segments?.length) return [];
  let segmentStart = startOverride === null ? [...path.segments[0].start] : [...startOverride];
  const lengths = [];
  for (const segment of path.segments) {
    lengths.push(pathLength(segment, segmentStart));
    segmentStart = evaluatePath(segment, 1, segmentStart);
  }
  const weights = sequentialWeights(path, lengths);
  const total = weights.reduce((sum, length) => sum + length, 0);
  if (total <= EPSILON) return weights.map((_, index) => (index + 1) / weights.length);
  let cumulative = 0;
  return weights.map(weight => {
    cumulative += weight / total;
    return cumulative;
  });
}

export function evaluatePath(path, progress, startOverride = null) {
  const s = Math.min(1, Math.max(0, Number(progress)));
  const pathType = path.type;

  if (pathType === "sequential") {
    const segments = path.segments;
    if (!segments.length) {
      throw new Error("Sequential path requires at least one segment");
    }
    let segmentStart = startOverride === null ? [...segments[0].start] : [...startOverride];
    const starts = [];
    const lengths = [];
    for (const segment of segments) {
      starts.push(segmentStart);
      lengths.push(pathLength(segment, segmentStart));
      segmentStart = evaluatePath(segment, 1, segmentStart);
    }
    const weights = sequentialWeights(path, lengths);
    const total = weights.reduce((sum, length) => sum + length, 0);
    let index;
    let localS;
    if (total <= EPSILON) {
      index = Math.min(Math.floor(s * segments.length), segments.length - 1);
      localS = s * segments.length - index;
    } else {
      const distance = s * total;
      let cumulative = 0;
      index = segments.length - 1;
      localS = 1;
      for (let candidate = 0; candidate < segments.length; candidate += 1) {
        const length = weights[candidate];
        if (distance <= cumulative + length || candidate === segments.length - 1) {
          index = candidate;
          localS = length <= EPSILON ? 1 : (distance - cumulative) / length;
          break;
        }
        cumulative += length;
      }
    }
    return evaluatePath(segments[index], localS, starts[index]);
  }

  const start = startOverride === null ? [...path.start] : [...startOverride];
  if (pathType === "affine_linear") {
    const target = startOverride === null
      ? path.target
      : add(multiplyMatrixVector(path.matrix_cart, start), path.translation_cart);
    return interpolate(start, target, s);
  }
  if (pathType === "rotation") {
    return rotateAboutAxis(start, path.axis_point, path.axis_direction, angleRadians(path) * s);
  }
  if (["screw", "glide", "rotoinversion", "rotoreflection"].includes(pathType)) {
    const geometry = twoPhaseGeometry(path, start);
    const split = Math.max(0, Math.min(
      Number(path.phase_fraction ?? phaseFraction(geometry.firstLength, geometry.secondLength)),
      1,
    ));
    if (s <= split) {
      const localS = split > EPSILON ? s / split : 1;
      if (pathType === "glide") return interpolate(start, geometry.midpoint, localS);
      return rotateAboutAxis(start, path.axis_point, path.axis_direction, angleRadians(path) * localS);
    }
    const localS = split < 1 - EPSILON ? (s - split) / (1 - split) : 1;
    return interpolate(geometry.midpoint, geometry.endpoint, localS);
  }
  if (pathType === "mirror" || pathType === "mirror_after_hold") {
    if (pathType === "mirror_after_hold") {
      const holdFraction = Number(path.hold_fraction ?? 0.3);
      if (s <= holdFraction) {
        return [...start];
      }
      const localS = (s - holdFraction) / Math.max(1 - holdFraction, 1e-9);
      return interpolate(start, reflectPoint(start, path.plane_point, path.plane_normal), localS);
    }
    return interpolate(start, reflectPoint(start, path.plane_point, path.plane_normal), s);
  }
  if (pathType === "inversion") {
    return interpolate(start, subtract(scale(path.center, 2), start), s);
  }

  let target = [...path.target];
  if (startOverride !== null) {
    target = add(target, subtract(start, path.start));
  }
  return interpolate(start, target, s);
}

// Explicit API1 quiz compatibility only. Current API2 quizzes obtain a single
// verified composed plan from QuizSession and never synthesize legacy paths.
export function legacyQuizDurationMs(sequence = false) {
  return sequence ? 3200 : 1600;
}

export async function loadLegacyQuizComposition(fetchSnapshot, question, isCurrent) {
  const first = await fetchSnapshot(question.operation_index_a);
  if (!isCurrent() || !first) return null;
  const second = await fetchSnapshot(question.operation_index_b);
  if (!isCurrent() || !second) return null;
  return combineLegacyQuizSnapshots(first, second);
}

function combineLegacyQuizSnapshots(first, second) {
  const paths = new Map();
  for (const [sourceAtom, firstPath] of first.paths) {
    const secondPath = second.paths.get(sourceAtom);
    if (!secondPath) throw new Error("操作A・Bの原子の対応を読み込めませんでした。");
    // Sequential evaluation starts B at A's endpoint, including each periodic
    // display image. Equal weights keep the existing midpoint slider boundary.
    paths.set(sourceAtom, {
      type: "sequential",
      segments: [firstPath, secondPath],
      segment_weights: [1, 1],
      unit_cell_only: firstPath.unit_cell_only || secondPath.unit_cell_only,
    });
  }
  const representativePath = paths.values().next().value;
  return {
    ...first,
    paths,
    breakpoints: representativePath ? pathBreakpoints(representativePath) : [0, 0.5, 1],
    maxTravel: first.maxTravel + second.maxTravel,
    durationSeconds: first.durationSeconds + second.durationSeconds,
  };
}
