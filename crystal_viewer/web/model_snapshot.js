// Opt-in transaction boundary for the future API2 client. No DOM mutation.
const identityKeys = ["model_id", "source_model_id", "frame_id", "structure_revision", "math_version"];
function identityMatches(a, b) {
  return identityKeys.every(key => a[key] !== undefined && a[key] === b[key]);
}
function requireVersion(value) {
  if (value.api_version !== 2 || value.schema_version !== 2 || value.math_version !== 1) {
    throw new Error("unsupported_contract");
  }
}
function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
export class ModelSnapshotBoundary {
  constructor() { this.generation = 0; this.active = null; this.selection = 0; this.failure = null; }
  begin() { this.selection += 1; this.failure = null; return ++this.generation; }
  commit(ticket, initial) {
    requireVersion(initial);
    if (ticket !== this.generation) throw new Error("stale_model_response");
    if (!identityMatches(initial, initial) || !Number.isSafeInteger(initial.structure_revision) ||
        initial.structure_revision < 1 || identityKeys.slice(0, 3).some(k => typeof initial[k] !== "string" || !initial[k]) ||
        !Array.isArray(initial.atoms) || !Array.isArray(initial.operations)) {
      throw new Error("incomplete_model");
    }
    if (this.active && initial.structure_revision < this.active.structure_revision) {
      throw new Error("stale_model_response");
    }
    // Clone before committing, so later mutation of a response cannot change
    // the snapshot underneath atom drawing and plan consumers.
    this.active = freeze(JSON.parse(JSON.stringify(initial)));
    this.selection += 1;
    this.failure = null;
    return this.active;
  }
  fail(ticket, message) {
    if (ticket !== this.generation) throw new Error("stale_model_response");
    if (typeof message !== "string" || !message.trim()) throw new Error("failure_reason_required");
    this.failure = Object.freeze({view: this.active ? "model" : "empty", reason: message,
      action: "choose_source", model_id: this.active?.model_id ?? null});
    return this.failure;
  }
  operationRequest(operationIndex, mode = "default") {
    if (!this.active) throw new Error("model_not_prepared");
    if (!Number.isSafeInteger(operationIndex) || !["default", "rotoinversion", "rotoreflection"].includes(mode)) {
      throw new Error("invalid_operation_request");
    }
    const operation = this.active.operations.find(item => item.operation_index === operationIndex);
    if (!operation || typeof operation.operation_id !== "string") throw new Error("unknown_operation");
    // The user chose stationary atom presentation for C-infinity, without an
    // angle input. An explicit 90-degree representative supplies the common
    // plan contract; the continuous family itself retains its null matrix.
    return this.request({operation_index: operationIndex, operation_id: operation.operation_id, mode,
      ...(operation.continuous ? {family_angle_rad: Math.PI / 2} : {})});
  }
  request(selection = {}) {
    if (!this.active) throw new Error("model_not_prepared");
    return {...selection, api_version: 2, ...Object.fromEntries(identityKeys.map(k => [k, this.active[k]]))};
  }
  select() { return ++this.selection; }
  accept(ticket, selection, response, planId) {
    requireVersion(response);
    if (typeof planId !== "string" || !planId || !this.active || ticket !== this.generation || selection !== this.selection ||
        !identityMatches(this.active, response) || response.plan_id !== planId) {
      throw new Error("stale_plan_response");
    }
    for (const key of ["plan", "presentation", "notation", "check", "schedule"]) {
      const value = response[key];
      if (value && (value.model_id !== response.model_id || value.frame_id !== response.frame_id || value.plan_id !== planId)) {
        throw new Error("mixed_plan_response");
      }
    }
    return response;
  }
}
