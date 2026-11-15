import {ModelSnapshotBoundary} from "/static/model_snapshot.js";
import {compilePlayback} from "/static/playback_schedule.js";

export const modelViewEnabled = document.querySelector('meta[name="model-view"]')?.content === "api2";
export function createModelViewClient({prefix = "/api/view", eventName = "symmetry-model-exchange", contextKeys = [], bindLoadIdentity = true} = {}) {
  const modelBoundary = new ModelSnapshotBoundary();
  let initialization;
  let currentState = {};
  let stateQueue = Promise.resolve();
  const acquiredPlans = new Map();
  const context = {};
  let quizPlayback = null;
  let quizPlans = {};
  function setQuizPlayback(role) {
    if (role !== quizPlayback) modelBoundary.select();
    quizPlayback = role;
  }
  function bind(body) { for (const key of contextKeys) if (key in body) context[key] = body[key]; }
  function currentModelViewState() { return currentState; }

  async function post(endpoint, payload) {
    const response = await fetch(`${prefix}/${endpoint}`, {method: "POST",
      headers: {"Content-Type": "application/json"}, body: JSON.stringify({api_version: 2, ...context, ...payload})});
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || error.error);
    }
    return response;
  }
  function exchange(bundle, ticket) {
    if (ticket !== modelBoundary.generation) throw new Error("stale_model_response");
    const render = bundle.render_payload;
    if (render && bundle.model_snapshot && (
        ["model_id", "source_model_id", "frame_id", "structure_revision", "math_version"]
          .some(key => render[key] !== bundle.model_snapshot[key] || render[key] !== bundle.state[key]) ||
        ["api_version", "schema_version"].some(key => render[key] !== bundle.model_snapshot[key]) ||
        render.view_revision !== bundle.state.view_revision || render.coordinate_space !== "cartesian" ||
        render.display_mode !== bundle.state.display_mode || render.cell_origin_mode !== bundle.state.cell_origin_mode ||
        "operations" in render.render_data)) throw new Error("mixed_view_response");
    acquiredPlans.clear();
    quizPlans = {};
    quizPlayback = null;
    if (bundle.model_snapshot) modelBoundary.commit(ticket, bundle.model_snapshot);
    else { modelBoundary.active = null; modelBoundary.select(); }
    bind(bundle);
    currentState = bundle.state;
    if (render) render.render_data = {...render.render_data, operations: bundle.operations};
    window.dispatchEvent(new CustomEvent(eventName, {detail: bundle}));
    return bundle;
  }
  async function initializeModelView() {
    if (!modelViewEnabled) return;
    if (!initialization) initialization = (async () => {
      const ticket = modelBoundary.begin();
      return exchange(await (await post("bootstrap", {})).json(), ticket);
    })();
    return initialization;
  }

  async function viewFetch(path, options = {}) {
    if (!modelViewEnabled) return fetch(path, options);
    await initializeModelView();
    if (new URL(path, location.href).pathname === "/api/state") {
      const requestedGeneration = modelBoundary.generation;
      const pending = stateQueue.catch(() => {}).then(() => {
        if (requestedGeneration !== modelBoundary.generation) throw new Error("stale_view_response");
        return requestView(path, options);
      });
      stateQueue = pending;
      return pending;
    }
    return requestView(path, options);
  }

  async function requestView(path, options) {
    const url = new URL(path, location.href);
    const endpoint = url.pathname.replace(/^\/api\//, "");
    const input = options.body ? JSON.parse(options.body) : {};
    const query = Object.fromEntries(url.searchParams);
    for (const key of ["operation_index", "repetitions"]) if (query[key] !== undefined) query[key] = Number(query[key]);
    const loading = ["load_json", "open_example", "import_cif", "import_molecule", "cell_setting", "reset_analysis"].includes(endpoint)
      || (endpoint === "cell_placement" && input.placement)
      || (endpoint === "state" && "cell_origin_mode" in input && modelBoundary.active?.cell_representatives);
    const selectionChange = endpoint === "select_question" || endpoint === "state" && ["operation_index", "operation_repetitions", "improper_mode", "scope", "selected_atoms", "active_mode", "custom_op_animate", "clear_custom_check", "display_mode", "include_boundary_images", "element_hidden", "atom_hidden", "range_highlight"].some(k => k in input);
    if (selectionChange) modelBoundary.select();
    const ticket = loading ? modelBoundary.begin() : modelBoundary.generation;
    const selection = modelBoundary.selection;
    const identity = modelBoundary.active && (bindLoadIdentity || !loading) ? modelBoundary.request() : {api_version: 2};
    const payload = {...identity, selection_revision: selection, ...query, ...(endpoint === "state" ? {update: input} : input)};
    try {
      let expectedPlan;
      if (quizPlayback && ["animation_path", "atom_motion", "symmetry_elements"].includes(endpoint)) {
        expectedPlan = quizPlans[quizPlayback];
        if (!expectedPlan) throw new Error("quiz_playback_unavailable");
        payload.quiz_playback = quizPlayback;
        payload.expected_plan_id = expectedPlan;
      } else if (modelBoundary.active && ["animation_path", "atom_motion", "symmetry_elements", "powers"].includes(endpoint)) {
        const index = Number(query.operation_index ?? currentState.operation_index);
        const mode = currentState.improper_mode || "default";
        const operation = modelBoundary.active.operations.find(op => op.operation_index === index);
        const request = modelBoundary.operationRequest(index, mode);
        expectedPlan = operation.plans.find(plan => plan.mode === mode)?.plan_id;
        if (!expectedPlan) {
          const key = JSON.stringify(request);
          expectedPlan = acquiredPlans.get(key);
          if (!expectedPlan) {
            const acquired = await (await post("plan", request)).json();
            modelBoundary.accept(ticket, selection, acquired, acquired.plan_id);
            expectedPlan = acquired.plan_id;
            acquiredPlans.set(key, expectedPlan);
          }
        }
        payload.plan_request = {...request, plan_id: expectedPlan};
      } else if (["custom_animation_path", "custom_powers"].includes(endpoint)) {
        expectedPlan = currentState.custom_op_result?.plan_id;
        if (!expectedPlan) throw new Error("custom_plan_not_checked");
        payload.expected_plan_id = expectedPlan;
      }
      const response = await post(endpoint, payload);
      if (endpoint === "export_gif") return response;
      const body = await response.json();
      if (loading) exchange(body, ticket);
      else if (ticket !== modelBoundary.generation || ((body.plan_id || endpoint === "select_question" || endpoint === "check") && selection !== modelBoundary.selection)) throw new Error("stale_view_response");
      if (!loading && body.model_id && modelBoundary.active &&
          ["model_id", "source_model_id", "frame_id", "structure_revision", "math_version"].some(k => body[k] !== identity[k])) throw new Error("mixed_view_response");
      if (body.plan_id) {
        // Check and composition acquire a plan for the exact Custom input.
        if (["check_operation", "compose_operations"].includes(endpoint)) expectedPlan = body.plan_id;
        modelBoundary.accept(ticket, selection, body, expectedPlan);
        if (body.playback) {
          modelBoundary.accept(ticket, selection, body.playback, expectedPlan);
          const compiled = compilePlayback(body.playback, {...identity, plan_id: expectedPlan});
          // A renderer gets the validated schedule; no old path is synthesized.
          const bound = {...compiled};
          Object.defineProperty(bound, "boundary", {value: modelBoundary});
          body.compiledPlayback = Object.freeze(bound);
        }
      }
      if (endpoint === "select_question") { quizPlans = {}; quizPlayback = null; }
      if (body.playbacks) quizPlans = {...quizPlans, ...body.playbacks};
      bind(body);
      const responseBody = endpoint === "state" && loading ? body.state : body;
      if (endpoint === "state" || endpoint === "select_question") currentState = responseBody;
      return {ok: true, status: 200, json: async () => responseBody, text: async () => JSON.stringify(responseBody)};
    } catch (error) {
      error.obsolete = ticket !== modelBoundary.generation || selection !== modelBoundary.selection || /^stale_/.test(error.message);
      if (loading && ticket === modelBoundary.generation) modelBoundary.fail(ticket, String(error.message || error));
      throw error;
    }
  }

  return {modelBoundary, viewFetch, currentModelViewState, initializeModelView, setQuizPlayback};
}
export const analysisClient = createModelViewClient();
export const modelBoundary = analysisClient.modelBoundary;
export const viewFetch = analysisClient.viewFetch;
export const currentModelViewState = analysisClient.currentModelViewState;
export const initializeModelView = analysisClient.initializeModelView;

// Shared by the regular renderer, paths, targets, trails and GIF frames.
export function evaluateModelPath(path, progress, start) {
  if (!path?.compiledPlayback) throw new Error("missing_model_playback");
  const boundary = path.compiledPlayback.boundary || modelBoundary;
  if (["model_id", "source_model_id", "frame_id", "structure_revision", "math_version"]
      .some(key => path.compiledPlayback[key] !== boundary.active?.[key])) throw new Error("obsolete_model_playback");
  return path.compiledPlayback.evaluate(progress, [start])[0];
}

if (modelViewEnabled) window.symmetryModelBoundary = modelBoundary;

// Scoped feedback for asynchronous UI work; playback frames never own a token.
export function createWaitingCursor(root, className) {
  const pending = new Set();
  function sync() {
    const target = root();
    if (!target) return;
    target.classList.toggle(className, pending.size > 0);
    target.setAttribute("aria-busy", String(pending.size > 0));
  }
  function begin() {
    const token = {};
    pending.add(token);
    sync();
    return () => { pending.delete(token); sync(); };
  }
  async function run(work) {
    const finish = begin();
    try { return await work(); }
    finally { finish(); }
  }
  return {begin, run, clear() { pending.clear(); sync(); }};
}
export const quizWaiting = createWaitingCursor(() => document.getElementById("puzzle-mode"), "puzzle-loading");
export const analysisWaiting = createWaitingCursor(() => document.body, "analysis-loading");
export function waitingForView(container) {
  return container.id === "puzzle-view" ? quizWaiting : analysisWaiting;
}
