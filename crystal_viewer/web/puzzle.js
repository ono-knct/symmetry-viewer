import { StaticStructureView } from "/static/three_view.js";
import { PUZZLE_RING_COLORS } from "/static/colors.js";
import { pathBreakpoints } from "/static/animation_path.js";

// Puzzle mode reuses the analysis-mode StaticStructureView for atoms,
// unit cells and periodic-aware animation. The visible quizzes are operation
// identification, composition, atom mapping and point-group identification.
// Axis-order questions are also supported by the internal quiz API.

let view = null;
let started = false;
let catalog = null;
let currentQuiz = "operation"; // "axis" | "operation" | "composition" | "mapping" | "point_group"
let currentOperationDifficulty = "normal"; // "normal" | "hard"
let currentKind = "molecule"; // structure picker toggle
let currentSourceKind = "molecule"; // kind of the loaded structure (for answer options)
let questions = [];
let currentQuestion = null;
let revealOperation = null; // operation index to animate for the reveal
let revealAnim = null; // active reveal animation token
let roundGeneration = 0; // invalidates async work from prior rounds/screens
let operationAnswered = false;
let mappingGuess = null; // mapping quiz: the atom the player clicked
let mappingRevealTarget = null; // mapping quiz: the correct target atom (after answering)
let compositionPlaybackGeneration = 0;
let compositionQuestionReady = false;
let compositionPlaybackMode = "sequence";
// Composition quiz: A and B share a sequential path. Each atom starts B at its
// endpoint from A; the slider reserves half its range for each operation.
let compositionSnapshot = null;
let compositionActiveSnapshot = null;
let compositionLabelA = "";
let compositionLabelB = "";
let mappingPlaybackGeneration = 0;
let pendingOperationExample = null; // operation quiz: structure picked, awaiting difficulty
let pendingOperationLabel = "";
// Crystals default to unit-cell atoms only (periodic images off); the camera
// overlay's toggle flips this per structure, reset on every new startStructure().
let puzzleShowBoundaryImages = false;

const REVEAL_DURATION_MS = 1600;
const INFINITE = "inf";
const SHIFT_OPTIONS = ["1/6", "1/4", "1/3", "1/2", "2/3", "3/4", "5/6"];
// Mapping quiz: ring colours (source / player's guess / correct target). Colours
// come from colors.js so they cannot silently collide with the symmetry-element
// colours three_view.js draws in the same view (a blue guess ring used to sit
// almost on top of the axis colour before that module existed).
const PICK_SOURCE_COLOR = PUZZLE_RING_COLORS.source;
const PICK_GUESS_COLOR = PUZZLE_RING_COLORS.guess;
const PICK_TARGET_COLOR = PUZZLE_RING_COLORS.target;

// Operation-identify answer vocabulary (canonical kinds match game/operation_identify.py).
// `orders` lists the folds offered for that kind (null = kind only). The improper
// kind shown depends on the structure: molecules use rotoreflection Sn (回映),
// crystals use rotoinversion -n (回反).
const OP_KIND_MOLECULE = { kind: "rotoreflection", label: "回映", orders: [3, 4, 6] };
const OP_KIND_CRYSTAL = { kind: "rotoinversion", label: "回反", orders: [3, 4, 6] };

function operationKinds() {
  if (currentOperationDifficulty === "hard") {
    return [
      { kind: "screw", label: "らせん", orders: [2, 3, 4, 6] },
      { kind: "glide", label: "映進", orders: null },
    ];
  }
  // Linear molecules have a C∞ axis, so molecules offer ∞ as a rotation fold;
  // the crystallographic restriction means crystals never do.
  const rotationOrders = currentSourceKind === "crystal" ? [2, 3, 4, 6] : [2, 3, 4, 6, INFINITE];
  return [
    { kind: "rotation", label: "回転", orders: rotationOrders },
    { kind: "mirror", label: "鏡映", orders: null },
    { kind: "inversion", label: "反転", orders: null },
    currentSourceKind === "crystal" ? OP_KIND_CRYSTAL : OP_KIND_MOLECULE,
  ];
}

function el(id) {
  return document.getElementById(id);
}

function formatFormula(text) {
  // Render a chemical formula with subscripted digit runs (C6H6 -> C₆H₆).
  return String(text).replace(/(\d+)/g, "<sub>$1</sub>");
}

function formatOrder(order) {
  return order === INFINITE ? "無限回" : `${order}回`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatOperationNotation(notation) {
  return escapeHtml(notation).replace(/sigma/gi, "σ").replace(/_([0-9]+)/g, "<sub>$1</sub>");
}

// Point-group symbols: Schoenflies (C3v) gets a subscript; HM/ITC (-3, m-3m) use
// the ASCII "-n" convention for a barred numeral (n̄), which browser_ui.js already
// renders as a real overline via the shared `.overline` CSS class (text-decoration:
// overline) — mirrored here since puzzle.js is a separate module and cannot import
// browser_ui.js's non-module formatGroupSymbol(). Without this, "-3" reads as
// "minus 3" instead of the crystallographic bar-3.
function formatPointGroupSymbol(symbol) {
  const text = escapeHtml(symbol);
  const schoenflies = text.match(/^([CDS])(\d+|∞)([a-z]*)$/);
  if (schoenflies) return `${schoenflies[1]}<sub>${schoenflies[2]}${schoenflies[3]}</sub>`;
  return text.replace(/-([0-9]+)/g, '<span class="overline">$1</span>');
}

function formatOperationAnswer(kind, order, shift = null, notation = null) {
  let text = kind;
  if (kind === "rotation") text = `${order}回回転`;
  if (kind === "mirror") text = "鏡映";
  if (kind === "inversion") text = "反転";
  if (kind === "rotoreflection") text = `回映（S${order}）`;
  if (kind === "rotoinversion") text = `回反（-${order}）`;
  if (kind === "screw") text = `${order}回らせん`;
  if (kind === "glide") text = "映進";
  if (shift) text += `、並進成分 ${shift}`;
  const escaped = escapeHtml(text);
  // The kind label already spells out Sn / -n, so repeating the notation would
  // read "回映（S3）（S3）". Compare loosely so a unicode minus or stray spacing
  // in the notation still counts as the same text.
  const canonical =
    kind === "rotoreflection" ? `S${order}` : kind === "rotoinversion" ? `-${order}` : null;
  const normalize = (value) => String(value).replace(/\s+/g, "").replace(/[−–—]/g, "-");
  const redundantNotation = canonical !== null && normalize(notation) === normalize(canonical);
  return notation && !redundantNotation
    ? `${escaped}（${formatOperationNotation(notation)}）`
    : escaped;
}

function formatOperationAnswers(answers) {
  // Coincident motions accept more than one name (e.g. CO2: 反転 or 鏡映).
  return (answers || [])
    .map((a) => formatOperationAnswer(a.kind, a.order, a.shift, a.notation || a.symbol))
    .join(" または ");
}

function displayLabel(example) {
  // display_formula is the formula as a chemist writes it (C6H6, not the
  // reduced HC); the analysis layer computes it, so there is no table here.
  return formatFormula(example.display_formula || example.formula || example.name);
}

// Which catalog count decides whether the current quiz can use a structure.
function puzzleCountKey() {
  if (currentQuiz === "operation") {
    return currentOperationDifficulty === "hard" ? "operation_hard" : "operation_normal";
  }
  return currentQuiz === "axis" ? "axis" : currentQuiz;
}

function isEligible(example) {
  // Structures carrying symmetry the answer vocabulary cannot name are analysis
  // only. This is not the same test as "has no questions": an icosahedral
  // cluster has plenty of C2/C3 questions, and asking only those would teach
  // that its 5-fold axes are not there.
  // The point-group quiz is the one exception: naming the whole structure's
  // point group (e.g. "Ih") never asks for a fold from the closed vocabulary,
  // so a 5-fold axis does not make that question a lie the way it would for
  // the other four (see beyond_quiz_vocabulary() in game/catalog.py).
  if (currentQuiz !== "point_group" && example.beyond_quiz_vocabulary) return false;
  // Counts come from the catalog, which the export step computes by running the
  // real question generators. Without them (filesystem fallback catalog) assume
  // playable rather than hiding everything.
  const counts = example.puzzle_counts;
  if (!counts) return true;
  return Number(counts[puzzleCountKey()] || 0) > 0;
}

function eligibleExamples(kind) {
  return (catalog?.[kind] || []).filter(isEligible);
}

// --- Screens: quiz select -> structure picker -> play ---

function invalidatePuzzleWork() {
  roundGeneration += 1;
  compositionPlaybackGeneration += 1;
  mappingPlaybackGeneration += 1;
  compositionQuestionReady = false;
  compositionPlaybackMode = "sequence";
  el("puzzle-composition-playback").hidden = true;
  el("puzzle-slider").disabled = false;
  el("puzzle-lattice-info").hidden = true;
  el("puzzle-structure-info").hidden = true;
  el("puzzle-atom-coordinate").hidden = true;
  cancelReveal();
  operationAnswered = false;
  currentQuestion = null;
  if (view) {
    view.pathGeneration += 1;
    view.animationPaths.clear();
    view.setAnimationSourceAtoms(null);
    view.onAtomPick = null;
    view.clearPickMarkers();
    view.clearTargetMarkers();
    view.clearSymmetryElements();
    view.resetAnimation();
  }
  return roundGeneration;
}

function showQuizSelect() {
  invalidatePuzzleWork();
  el("puzzle-quiz-select").hidden = false;
  el("puzzle-operation-difficulty").hidden = true;
  el("puzzle-point-group-kind").hidden = true;
  el("puzzle-picker").hidden = true;
  el("puzzle-play").hidden = true;
  el("puzzle-back").hidden = false;
}

function showOperationDifficulty() {
  invalidatePuzzleWork();
  el("puzzle-quiz-select").hidden = true;
  el("puzzle-point-group-kind").hidden = true;
  el("puzzle-operation-difficulty").hidden = false;
  el("puzzle-picker").hidden = true;
  el("puzzle-play").hidden = true;
  el("puzzle-back").hidden = false;
  // Molecules never score operation_hard (no screws/glides), but by the time this
  // screen shows a specific crystal has already been picked, so hide "hard" too
  // when that particular crystal has no hard questions of its own.
  const hardCard = document.querySelector('[data-operation-difficulty="hard"]');
  const counts = pendingOperationExample?.puzzle_counts;
  hardCard.hidden = counts ? Number(counts.operation_hard || 0) === 0 : false;
}

function showPointGroupKind() {
  invalidatePuzzleWork();
  el("puzzle-quiz-select").hidden = true;
  el("puzzle-operation-difficulty").hidden = true;
  el("puzzle-point-group-kind").hidden = false;
  el("puzzle-picker").hidden = true;
  el("puzzle-play").hidden = true;
  el("puzzle-back").hidden = false;
}

function showPicker() {
  invalidatePuzzleWork();
  el("puzzle-quiz-select").hidden = true;
  el("puzzle-operation-difficulty").hidden = true;
  el("puzzle-point-group-kind").hidden = true;
  el("puzzle-picker").hidden = false;
  el("puzzle-play").hidden = true;
  el("puzzle-back").hidden = false;
}

function showPlay() {
  el("puzzle-quiz-select").hidden = true;
  el("puzzle-operation-difficulty").hidden = true;
  el("puzzle-point-group-kind").hidden = true;
  el("puzzle-picker").hidden = true;
  el("puzzle-play").hidden = false;
  // Every screen keeps a single 戻る visible (see goBack()) so there is always
  // exactly one way back to wherever the player came from, never zero and
  // never two competing buttons with different targets (2026-09-09 follow-up).
  el("puzzle-back").hidden = false;
}

// Which screen led into the round currently showing on #puzzle-play, so
// goBack() can undo exactly that one step. Fixed by currentQuiz/currentSourceKind
// rather than a general navigation stack: the puzzle flow's shape is small and
// static (quiz-select is the only screen with more than one possible child), so
// hardcoding each screen's single parent is simpler than a generic history stack
// and just as correct.
function playParentScreen() {
  if (currentQuiz === "point_group") return "pointGroupKind";
  // Only crystals visit the difficulty screen (molecules skip straight from the
  // picker into play, see the picker's structure-button handler below).
  if (currentQuiz === "operation" && currentSourceKind === "crystal") return "operationDifficulty";
  return "picker";
}

// The 戻る button returns to the screen that led to the current one.
function goBack() {
  if (!el("puzzle-play").hidden) {
    const parent = playParentScreen();
    if (parent === "pointGroupKind") return showPointGroupKind();
    if (parent === "operationDifficulty") return showOperationDifficulty();
    return showPicker();
  }
  if (!el("puzzle-operation-difficulty").hidden) return showPicker();
  if (!el("puzzle-picker").hidden || !el("puzzle-point-group-kind").hidden) return showQuizSelect();
  window.setAppMode("select"); // already on quiz-select: one more step back is the hub
}

async function getJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error((await response.text()) || `${response.status} ${response.statusText}`);
  return response.json();
}

const STRUCTURE_KINDS = [
  { kind: "molecule", label: "分子" },
  { kind: "crystal", label: "結晶" },
];

async function buildPicker() {
  if (!catalog) catalog = await getJson("/api/examples");
  const root = el("puzzle-picker");
  root.innerHTML = "";
  // Offer a kind only when it has a playable structure for this quiz. This
  // derives what used to be hardcoded: molecules never score operation_hard
  // (no screws or glides) and crystals never score mapping, so the hard
  // operation quiz stays crystal-only and the mapping quiz molecule-only.
  const structureKinds = STRUCTURE_KINDS.filter((item) => eligibleExamples(item.kind).length > 0);
  if (!structureKinds.some((item) => item.kind === currentKind)) {
    currentKind = structureKinds[0]?.kind || "molecule";
  }

  const kindRow = document.createElement("div");
  kindRow.className = "puzzle-kind-row";
  for (const item of structureKinds) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `puzzle-kind${item.kind === currentKind ? " selected" : ""}`;
    button.textContent = item.label;
    button.addEventListener("click", () => {
      if (currentKind === item.kind) return;
      currentKind = item.kind;
      buildPicker();
    });
    kindRow.appendChild(button);
  }
  root.appendChild(kindRow);

  const heading = document.createElement("h2");
  heading.className = "puzzle-picker-title";
  heading.textContent = currentKind === "crystal" ? "結晶を選んでください" : "分子を選んでください";
  root.appendChild(heading);
  const list = document.createElement("div");
  list.className = "puzzle-picker-list";
  const examples = eligibleExamples(currentKind);
  // Formulae are not unique (diamond and graphite are both C), so disambiguate
  // with the structure name, but only where a label actually repeats.
  const labelCounts = new Map();
  for (const example of examples) {
    const label = displayLabel(example);
    labelCounts.set(label, (labelCounts.get(label) || 0) + 1);
  }
  for (const example of examples) {
    const label = displayLabel(example);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "puzzle-structure";
    button.dataset.name = example.name;
    // Only the name/formula — the point/space group would give the answer away.
    const suffix =
      labelCounts.get(label) > 1 ? ` <span class="puzzle-structure-note">${escapeHtml(example.name)}</span>` : "";
    button.innerHTML = `<span class="puzzle-structure-name">${label}${suffix}</span>`;
    button.addEventListener("click", () => {
      // Screws/glides only exist in crystals, so the difficulty choice only makes
      // sense once a crystal has actually been picked; a molecule always plays
      // at normal difficulty and skips that screen entirely.
      if (currentQuiz === "operation" && example.kind === "crystal") {
        pendingOperationExample = example;
        pendingOperationLabel = label + suffix;
        showOperationDifficulty();
        return;
      }
      if (currentQuiz === "operation") currentOperationDifficulty = "normal";
      startStructure(example, label + suffix).catch(showError);
    });
    list.appendChild(button);
  }
  root.appendChild(list);
}

async function buildPointGroupKindScreen() {
  if (!catalog) catalog = await getJson("/api/examples");
  for (const button of document.querySelectorAll("[data-point-group-kind]")) {
    button.hidden = eligibleExamples(button.dataset.pointGroupKind).length === 0;
  }
}

async function startRandomPointGroupStructure(kind) {
  if (!catalog) catalog = await getJson("/api/examples");
  currentKind = kind;
  const examples = eligibleExamples(kind);
  if (!examples.length) throw new Error("この種類には出題できる構造がありません。");
  const example = examples[Math.floor(Math.random() * examples.length)];
  await startStructure(example);
}

function buildLegend() {
  const legend = el("puzzle-legend");
  if (!legend) return;
  legend.innerHTML = "";
  for (const [element, color] of view.legendItems || []) {
    const item = document.createElement("button");
    const visible = !view.hiddenElements?.has(element);
    item.type = "button";
    item.className = "puzzle-legend-item";
    item.dataset.visible = visible ? "true" : "false";
    item.title = `${element} の表示を切り替え`;
    item.innerHTML = `<span class="puzzle-legend-swatch" style="background:${color}"></span>${element}`;
    item.addEventListener("click", () => {
      const nextVisible = view.hiddenElements?.has(element);
      view.setElementVisibility(element, nextVisible);
      buildLegend();
    });
    legend.appendChild(item);
  }
}

function showError(error) {
  const result = el("puzzle-result");
  result.hidden = false;
  result.className = "puzzle-result miss";
  result.textContent = `エラー: ${error.message || error}`;
}

function showPrompt(message) {
  const result = el("puzzle-result");
  result.hidden = false;
  result.className = "puzzle-result miss";
  result.textContent = message;
}

async function startStructure(example, label = displayLabel(example)) {
  const generation = invalidatePuzzleWork();
  showPlay();
  // Name/formula only; the point/space group would reveal the answer.
  el("puzzle-structure-title").innerHTML = label;
  el("puzzle-question").textContent = "読み込み中…";
  el("puzzle-options").innerHTML = "";
  el("puzzle-result").hidden = true;
  el("puzzle-check").hidden = false;
  el("puzzle-check").disabled = true;
  el("puzzle-again").hidden = true;
  el("puzzle-open-analysis").hidden = true;
  el("puzzle-playback").hidden = true;
  el("puzzle-view-along").hidden = true;
  setStageCaption("");
  await getJson("/api/open_example", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: example.kind, path: example.path, request_id: Date.now() }),
  });
  if (generation !== roundGeneration) return;
  // Render with the shared analysis-mode view (atoms + unit cell + fitted camera).
  // Crystals default to showing the periodic boundary atoms — a bare unit cell
  // can look incomplete or cut off — while molecules have no periodic images
  // at all, so the flag is moot for them either way. The camera overlay's
  // toggle (below) still lets the player turn it off per structure.
  puzzleShowBoundaryImages = example.kind === "crystal";
  view.showAnimationTargets = example.kind === "crystal";
  view.showAnimationTargetCopies = false;
  view.showTrajectories = false;
  el("puzzle-target-copies-toggle").hidden = example.kind !== "crystal";
  el("puzzle-boundary-images-toggle").hidden = example.kind !== "crystal";
  el("puzzle-trajectories").hidden = true;
  hidePuzzleGifButton();
  syncTargetCopiesButton();
  syncTrajectoriesButton();
  syncBoundaryImagesButton();
  applyBoundaryImagesQuery(example.kind);
  await view.refresh();
  if (generation !== roundGeneration) return;
  buildLegend();
  const endpoint =
    currentQuiz === "axis"
      ? `/api/puzzle/axis_orders${example.kind === "crystal" ? "?display_mode=source" : ""}`
      : currentQuiz === "composition"
        ? "/api/puzzle/composition"
        : currentQuiz === "mapping"
          ? "/api/puzzle/mapping"
          : currentQuiz === "point_group"
            ? "/api/puzzle/point_group"
            : `/api/puzzle/operations?difficulty=${currentOperationDifficulty}`;
  const payload = await getJson(endpoint);
  if (generation !== roundGeneration) return;
  currentSourceKind = payload.source_kind || example.kind;
  questions = payload.questions || [];
  if (!questions.length) {
    view.clearSymmetryElements();
    const noun = example.kind === "crystal" ? "結晶" : "分子";
    const what =
      currentQuiz === "axis"
        ? "回転軸"
        : currentQuiz === "composition"
          ? "2つの操作を合成してできる操作"
          : currentQuiz === "mapping"
            ? "移り先を答えられる原子"
            : currentQuiz === "point_group"
              ? "点群"
              : currentOperationDifficulty === "hard"
                ? "並進を含む操作（らせん・映進）"
                : "基本操作";
    el("puzzle-question").textContent = `この${noun}には出題できる${what}がありません。別の${noun}を選んでください。`;
    el("puzzle-options").innerHTML = "";
    el("puzzle-check").hidden = true;
    el("puzzle-again").hidden = true;
    el("puzzle-playback").hidden = true;
    return;
  }
  beginRound();
}

function pickQuestion() {
  // All four of these balance by answer type: a highly symmetric structure has
  // many equivalent operations (or axes, or products) of the common kinds, so
  // pick a random group (opaque answer-type bucket) first, then a random
  // question within it. Without this, benzene's axis quiz (two independent
  // "C2 only" axis classes vs one "C2/C3/C6" principal axis) drew "2回" twice
  // as often as the principal axis, purely from the raw axis count.
  if (
    currentQuiz === "operation"
    || currentQuiz === "composition"
    || currentQuiz === "mapping"
    || currentQuiz === "axis"
  ) {
    const groups = new Map();
    for (const question of questions) {
      const key = question.group ?? question.id;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(question);
    }
    const keys = [...groups.keys()];
    const bucket = groups.get(keys[Math.floor(Math.random() * keys.length)]);
    return bucket[Math.floor(Math.random() * bucket.length)];
  }
  return questions[Math.floor(Math.random() * questions.length)];
}

function beginRound() {
  invalidatePuzzleWork();
  currentQuestion = pickQuestion();
  revealOperation = null;
  view.showTrajectories = false;
  view.updateTrajectoryLines();
  view.updateAnimationTargetMarkers();
  mappingGuess = null;
  mappingRevealTarget = null;
  const result = el("puzzle-result");
  result.hidden = true;
  el("puzzle-options").innerHTML = "";
  el("puzzle-check").hidden = false;
  el("puzzle-check").disabled = false;
  el("puzzle-again").hidden = true;
  el("puzzle-open-analysis").hidden = true;
  el("puzzle-slider").value = "0";
  el("puzzle-slider").hidden = false;
  setPuzzleSliderBreakpoints([]);
  el("puzzle-replay").disabled = false;
  el("puzzle-trajectories").hidden = true;
  const viewAlong = el("puzzle-view-along");
  viewAlong.hidden = !(currentQuiz === "axis" || currentQuiz === "mapping");
  viewAlong.textContent = currentQuiz === "mapping" ? "操作要素方向から見る" : "軸方向から見る";
  setStageCaption("");
  hidePuzzleGifButton();
  syncTrajectoriesButton();
  if (currentQuiz === "axis") beginAxisRound();
  else if (currentQuiz === "composition") beginCompositionRound();
  else if (currentQuiz === "mapping") beginMappingRound();
  else if (currentQuiz === "point_group") beginPointGroupRound();
  else beginOperationRound();
}

function beginAxisRound() {
  view.addAxis(
    { direction_cart: currentQuestion.direction_cart, point_cart: currentQuestion.point_cart },
    view.sceneSpan(),
  );
  view.render();
  el("puzzle-question").textContent = "青い軸は何回回転軸ですか？（回転だけを数え、回映やらせんは数えません）";
  const options = el("puzzle-options");
  const choices = [...currentQuestion.options];
  if (currentQuestion.infinite) choices.push(INFINITE);
  for (const order of choices) {
    const label = document.createElement("label");
    label.className = "puzzle-option";
    label.innerHTML = `<input type="radio" name="puzzle-order" value="${order}"><span>${formatOrder(order)}</span>`;
    options.appendChild(label);
  }
  el("puzzle-playback").hidden = true; // reveal controls appear after answering
}

// --- Point-group quiz (bare structure, no highlighted element -- name the whole
// thing's point group from a small multiple-choice list) ---

function showPointGroupStructureInfo() {
  const latticeInfo = el("puzzle-lattice-info");
  const metadata = view.renderData.metadata || {};
  const lattice = metadata.display_lattice_parameters || metadata.lattice_parameters;
  latticeInfo.hidden = currentSourceKind !== "crystal" || !lattice;
  latticeInfo.textContent = latticeInfo.hidden ? "" :
    ["a", "b", "c"].map(key => `${key} = ${compositionMatrixNumber(lattice[key])} Å`).join("、")
    + " ／ " + [["α", "alpha"], ["β", "beta"], ["γ", "gamma"]]
      .map(([label, key]) => `${label} = ${compositionMatrixNumber(lattice[key])}°`).join("、");
  el("puzzle-structure-info").hidden = false;
  el("puzzle-atom-coordinate").hidden = true;
  view.clearPickMarkers();
  const selected = new Map();
  view.onAtomPick = (atomIndex, instance, event) => {
    const output = el("puzzle-atom-coordinate");
    const additive = event?.ctrlKey === true;
    if (!additive) selected.clear();
    if (instance) {
      if (additive && selected.has(instance)) selected.delete(instance);
      else selected.set(instance, atomIndex);
    }
    output.hidden = selected.size === 0;
    const crystal = currentSourceKind === "crystal";
    output.replaceChildren(...Array.from(selected, ([atom, index]) => {
      const row = document.createElement("p");
      const coords = crystal ? atom.frac : atom.start;
      row.textContent = `${atom.element} ${Number(index) + 1}：`
        + `${crystal ? "分率座標 (a, b, c)" : "直交座標 (x, y, z)"} = `
        + `(${coords.map(compositionMatrixNumber).join(", ")})${crystal ? "" : " Å"}`;
      return row;
    }));
    view.setPickMarkers(Array.from(selected.keys(), atom =>
      ({position: atom.start, radius: atom.radius, color: PICK_SOURCE_COLOR})));
    view.render();
  };
}

function beginPointGroupRound() {
  showPointGroupStructureInfo();
  el("puzzle-question").textContent = "この構造の点群はどれですか？";
  const options = el("puzzle-options");
  for (const symbol of currentQuestion.options) {
    const label = document.createElement("label");
    label.className = "puzzle-option";
    label.innerHTML = `<input type="radio" name="puzzle-point-group" value="${escapeHtml(symbol)}"><span>${formatPointGroupSymbol(symbol)}</span>`;
    options.appendChild(label);
  }
  el("puzzle-playback").hidden = true; // nothing to animate for this quiz
}

function selectedPointGroup() {
  const checked = el("puzzle-options").querySelector('input[name="puzzle-point-group"]:checked');
  return checked ? checked.value : null;
}

async function onCheckPointGroup() {
  const generation = roundGeneration;
  const selected = selectedPointGroup();
  if (selected == null) {
    showPrompt("点群を1つ選んでください。");
    return;
  }
  el("puzzle-check").disabled = true;
  const result = await getJson("/api/puzzle/point_group/check", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question_id: currentQuestion.id, selected }),
  });
  if (generation !== roundGeneration) return;
  const box = el("puzzle-result");
  box.hidden = false;
  box.className = `puzzle-result ${result.correct ? "hit" : "miss"}`;
  const verdict = result.correct ? "正解" : `不正解（正解は ${formatPointGroupSymbol(result.answer)}）`;
  const explanation = result.explanation ? `<div class="puzzle-explanation">${escapeHtml(result.explanation)}</div>` : "";
  box.innerHTML = `${verdict}${explanation}`;
  el("puzzle-again").hidden = false;
  el("puzzle-open-analysis").hidden = false;
}

// The structure this question asked about is already open server-side (from
// startStructure()'s /api/open_example call, still current — nothing here has
// re-opened a different one since), so switching to analysis mode just needs
// to show it. window.setAppMode is browser_ui.js's own top-level function,
// implicitly global as a classic (non-module) script.
function openCurrentStructureInAnalysis() {
  // The quiz round underneath is left exactly as it was (still showing on
  // #puzzle-play, just covered by the analysis screen), so fromPuzzle: true
  // relabels #analysis-back into a way straight back to it instead of the
  // usual hub reset — see resumePuzzleMode() in browser_ui.js.
  window.setAppMode("analysis", { fromPuzzle: true });
}

function beginOperationRound() {
  el("puzzle-question").textContent =
    currentOperationDifficulty === "hard"
      ? "このアニメーションで示された対称操作の種類と並進成分を選んでください。"
      : "このアニメーションはどの操作ですか？";
  renderOperationOptions();
  // The animation IS the question, so show the playback controls and play it now.
  revealOperation = currentQuestion.operation_index;
  el("puzzle-playback").hidden = false;
  setPuzzleGifButtonReady(false);
  playReveal().catch(showError);
}

function renderOperationOptions() {
  const root = el("puzzle-options");
  const kinds = operationKinds();
  const kindRow = document.createElement("div");
  kindRow.className = "puzzle-op-group";
  kindRow.innerHTML = `<span class="puzzle-op-label">操作の種類</span>`;
  for (const { kind, label } of kinds) {
    const item = document.createElement("label");
    item.className = "puzzle-option";
    item.innerHTML = `<input type="radio" name="op-kind" value="${kind}"><span>${label}</span>`;
    kindRow.appendChild(item);
  }
  root.appendChild(kindRow);

  // The order row is always present (with reserved height) so selecting a kind
  // that needs a fold does not resize/shift the layout; only its contents change.
  const orderRow = document.createElement("div");
  orderRow.className = "puzzle-op-group puzzle-op-order";
  root.appendChild(orderRow);

  const shiftRow = document.createElement("div");
  shiftRow.className = "puzzle-op-group puzzle-op-order";
  if (currentOperationDifficulty === "hard") {
    shiftRow.hidden = true;
    shiftRow.innerHTML = `<span class="puzzle-op-label">並進成分</span>`;
    for (const shift of SHIFT_OPTIONS) {
      const item = document.createElement("label");
      item.className = "puzzle-option";
      item.innerHTML = `<input type="radio" name="op-shift" value="${shift}"><span>${shift}</span>`;
      shiftRow.appendChild(item);
    }
    root.appendChild(shiftRow);
  }

  kindRow.addEventListener("change", () => {
    const config = kinds.find((k) => k.kind === kindRow.querySelector("input:checked")?.value);
    orderRow.innerHTML = config?.orders ? `<span class="puzzle-op-label">回転次数</span>` : "";
    for (const order of config?.orders || []) {
      const item = document.createElement("label");
      item.className = "puzzle-option";
      item.innerHTML = `<input type="radio" name="op-order" value="${order}"><span>${formatOrder(order)}</span>`;
      orderRow.appendChild(item);
    }
    if (currentOperationDifficulty === "hard") {
      shiftRow.hidden = !(config?.kind === "screw" || config?.kind === "glide");
    }
  });
}

// --- Composition quiz ("A then B" -> which single operation?) ---

function setStageCaption(text) {
  const caption = el("puzzle-stage-caption");
  if (caption) caption.textContent = text || "";
}

function shortOperationLabel(answer) {
  const notation = answer?.notation || answer?.symbol;
  if (notation) return String(notation).replace(/sigma/gi, "σ").replace(/_/g, "");
  if (answer?.kind === "rotation") return `C${answer.order}`;
  if (answer?.kind === "mirror") return "σ";
  if (answer?.kind === "inversion") return "i";
  if (answer?.kind === "rotoreflection") return `S${answer.order}`;
  if (answer?.kind === "rotoinversion") return `-${answer.order}`;
  return "?";
}

function compositionStageLabel(stage, answer) {
  return `${stage}（${shortOperationLabel(answer)}）`;
}

function beginCompositionRound() {
  // The product is always a point operation, so answer with the normal vocabulary.
  currentOperationDifficulty = "normal";
  el("puzzle-question").textContent =
    "操作A を行い、続けて操作B を行うと、全体としてどの1つの操作と同じになりますか？";
  renderOperationOptions();
  // Before answering, the slider scrubs the continuous A/B path. After checking
  // it scrubs the product. Dragging it cancels auto-play and hands control to
  // the player without skipping either operation's contribution.
  el("puzzle-playback").hidden = false;
  el("puzzle-check").disabled = true;
  hidePuzzleGifButton();
  setPuzzleSliderBreakpoints([0.5]);
  playCompositionQuestion().catch(showError);
}

async function playSingleOperation(operationIndex, generation, caption, isCurrent = null) {
  const stillCurrent = isCurrent || (() => generation === roundGeneration);
  if (!stillCurrent()) return false;
  view.setAnimationSourceAtoms(null);
  setStageCaption(caption);
  await view.loadAnimationPaths(
    Number(operationIndex),
    ++view.pathGeneration,
    view.showAnimationTargets ? "unit_cell" : "displayed",
  );
  if (!stillCurrent()) return false;
  view.resetAnimation();
  el("puzzle-slider").disabled = false;
  await animateReveal();
  return stillCurrent();
}

// Load one operation's paths without touching the shared reveal state, and hand
// back a snapshot of everything loadAnimationPaths sets on `view` so it can be
// swapped back in later — this is what lets A and B share one slider instead of
// each fully replacing `view.animationPaths` at reveal time.
async function fetchOperationSnapshot(operationIndex, generation) {
  await view.loadAnimationPaths(
    Number(operationIndex),
    generation,
    view.showAnimationTargets ? "unit_cell" : "displayed",
  );
  if (generation !== view.pathGeneration) return null;
  return {
    paths: view.animationPaths,
    boundary: view.boundaryContext,
    breakpoints: view.animationBreakpoints,
    maxTravel: view.maximumTravelDistance,
    durationSeconds: view.baseAnimationDurationSeconds,
    operationIndex: view.animationOperationIndex,
  };
}

function activateCompositionSnapshot(snapshot) {
  view.animationPaths = snapshot.paths;
  view.boundaryContext = snapshot.boundary;
  view.animationBreakpoints = snapshot.breakpoints;
  view.maximumTravelDistance = snapshot.maxTravel;
  view.baseAnimationDurationSeconds = snapshot.durationSeconds;
  view.animationOperationIndex = snapshot.operationIndex;
  view.updateAnimationTargetMarkers();
  view.updateTrajectoryLines();
}

// fraction in [0, 0.5] scrubs A (progress = fraction*2); [0.5, 1] scrubs B.
function applyCombinedCompositionProgress(fraction) {
  const clamped = Math.max(0, Math.min(fraction, 1));
  const snapshot = compositionSnapshot;
  if (!snapshot) return; // still loading — nothing to show yet
  if (compositionActiveSnapshot !== snapshot) {
    activateCompositionSnapshot(snapshot);
    compositionActiveSnapshot = snapshot;
  }
  view.setAnimationProgress(clamped);
}

function combineCompositionSnapshots(first, second) {
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

function compositionCaptionForFraction(fraction) {
  return fraction <= 0.5 ? compositionLabelA : compositionLabelB;
}

async function playCompositionQuestion() {
  const generation = roundGeneration;
  const question = currentQuestion;
  const playback = ++compositionPlaybackGeneration;
  const isCurrent = () =>
    generation === roundGeneration
    && playback === compositionPlaybackGeneration
    && question === currentQuestion
    && compositionPlaybackMode === "sequence";
  compositionQuestionReady = false;
  compositionSnapshot = null;
  compositionActiveSnapshot = null;
  el("puzzle-check").disabled = true;
  el("puzzle-replay").disabled = true;
  el("puzzle-slider").disabled = true;
  cancelReveal();
  view.clearSymmetryElements();
  setPuzzleSliderBreakpoints([0.5]);
  let completed = false;
  try {
    compositionLabelA = compositionStageLabel("操作A", question.operation_a);
    compositionLabelB = compositionStageLabel("操作B", question.operation_b);
    const gen = ++view.pathGeneration;
    setStageCaption(compositionLabelA);
    const first = await fetchOperationSnapshot(question.operation_index_a, gen);
    if (!isCurrent() || !first) return;
    const second = await fetchOperationSnapshot(question.operation_index_b, gen);
    if (!isCurrent() || !second) return;
    compositionSnapshot = combineCompositionSnapshots(first, second);
    applyCombinedCompositionProgress(0);
    el("puzzle-slider").disabled = false;
    await animateProgress(0, 1, REVEAL_DURATION_MS * 2, (fraction) => {
      applyCombinedCompositionProgress(fraction);
      setStageCaption(compositionCaptionForFraction(fraction));
    });
    if (!isCurrent()) return;
    setStageCaption(`${compositionLabelA} → ${compositionLabelB}`);
    completed = true;
  } finally {
    if (isCurrent()) {
      compositionQuestionReady = !operationAnswered && completed;
      el("puzzle-check").disabled = operationAnswered || !completed;
      el("puzzle-replay").disabled = false;
      el("puzzle-slider").disabled = false;
    }
  }
}

async function playCompositionProduct(generation = roundGeneration) {
  const playback = ++compositionPlaybackGeneration;
  const isCurrent = () =>
    generation === roundGeneration
    && playback === compositionPlaybackGeneration
    && operationAnswered
    && compositionPlaybackMode === "product"
    && revealOperation != null;
  cancelReveal();
  el("puzzle-replay").disabled = true;
  el("puzzle-slider").disabled = true;
  compositionActiveSnapshot = null;
  view.clearSymmetryElements();
  setPuzzleSliderBreakpoints([]); // the product is a single 0→1 animation, not an A/B pair
  try {
    if (!await playSingleOperation(revealOperation, generation, "合成の結果", isCurrent)) return;
    if (!isCurrent()) return;
    setStageCaption("合成の結果");
    revealOperationElements(generation);
  } finally {
    if (isCurrent()) {
      el("puzzle-replay").disabled = false;
      el("puzzle-slider").disabled = false;
    }
  }
}

function syncCompositionPlaybackButtons() {
  el("puzzle-composition-sequence").setAttribute("aria-pressed", String(compositionPlaybackMode === "sequence"));
  el("puzzle-composition-product").setAttribute("aria-pressed", String(compositionPlaybackMode === "product"));
}

async function selectCompositionPlayback(mode) {
  if (currentQuiz !== "composition" || !operationAnswered) return;
  compositionPlaybackMode = mode;
  syncCompositionPlaybackButtons();
  await onReplay();
}

function compositionMatrixNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "?";
  if (Math.abs(number - Math.round(number)) < 1e-8) return String(Math.round(number));
  if (currentSourceKind === "crystal") {
    for (const denominator of [2, 3, 4, 6, 8, 12, 24]) {
      const numerator = Math.round(number * denominator);
      if (Math.abs(number - numerator / denominator) < 1e-8) return `${numerator}/${denominator}`;
    }
  }
  return String(Number(number.toFixed(4)));
}

function compositionTransformCard(operationIndex, title) {
  const operation = view.renderData.operations.find(op => Number(op.index) === Number(operationIndex));
  const fractional = currentSourceKind === "crystal";
  const matrix = operation?.[fractional ? "matrix_frac" : "matrix_cart"];
  const translation = operation?.[fractional ? "translation_frac" : "translation_cart"];
  if (!matrix || !translation) return `<section class="puzzle-operation-card"><h4>${title}</h4>行列を取得できませんでした。</section>`;
  const rows = matrix.map(row => `<div class="operation-matrix-row" role="row">`
    + row.map(value => `<span role="cell">${compositionMatrixNumber(value)}</span>`).join("") + "</div>").join("");
  return `<section class="puzzle-operation-card"><h4>${title}</h4>`
    + `<div class="puzzle-operation-transform"><span>W =</span><div class="operation-matrix" role="table" aria-label="操作の行列 W">${rows}</div></div>`
    + `<div class="puzzle-operation-translation">t = (${translation.map(compositionMatrixNumber).join(", ")})${fractional ? "" : " Å"}</div></section>`;
}

function renderCompositionResult(result) {
  const box = el("puzzle-result");
  const answerText = formatOperationAnswers(result.answers);
  const firstText = formatOperationAnswers([currentQuestion.operation_a]);
  const secondText = formatOperationAnswers([currentQuestion.operation_b]);
  box.hidden = false;
  box.className = `puzzle-result ${result.correct ? "hit" : "miss"}`;
  box.innerHTML = `<div class="puzzle-composition-summary"><span>${result.correct ? "正解" : "不正解"}</span>`
    + `<span>操作A：${firstText} → 操作B：${secondText}</span><span>答え：${answerText}</span></div>`;
  const coordinateLabel = currentSourceKind === "crystal" ? "分率座標" : "直交座標（並進の単位：Å）";
  const periodicNote = currentSourceKind === "crystal"
    ? "<p>結晶の並進ベクトルは、格子並進だけ異なる値も等価として扱います。</p>" : "";
  box.innerHTML += `<details class="puzzle-operation-details"><summary>操作の詳細（行列）</summary>`
    + `<p>${coordinateLabel}。座標は x′ = W x + t で移ります。</p>`
    + `<div class="puzzle-operation-transforms">`
    + compositionTransformCard(currentQuestion.operation_index_a, `操作A：${firstText}`)
    + compositionTransformCard(currentQuestion.operation_index_b, `操作B：${secondText}`)
    + compositionTransformCard(result.product_index, `答え：${answerText}`)
    + `</div><p>Aの後にBを行うので、合成行列は W<sub>B</sub> × W<sub>A</sub> です。`
    + `並進ベクトルは W<sub>B</sub> t<sub>A</sub> + t<sub>B</sub> です。</p>${periodicNote}</details>`;
}

async function onCheckComposition() {
  const generation = roundGeneration;
  if (!compositionQuestionReady) {
    showPrompt("操作A・Bの再生が終わってから回答してください。");
    return;
  }
  const { kind, order } = selectedOperationAnswer();
  if (!kind) {
    showPrompt("操作の種類を選んでください。");
    return;
  }
  const config = operationKinds().find((k) => k.kind === kind);
  if (config?.orders && order == null) {
    showPrompt("回数も選んでください。");
    return;
  }
  compositionQuestionReady = false;
  compositionPlaybackGeneration += 1;
  cancelReveal();
  view.pathGeneration += 1;
  el("puzzle-check").disabled = true;
  el("puzzle-replay").disabled = true;
  let result;
  try {
    result = await getJson("/api/puzzle/composition/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question_id: currentQuestion.id, kind, order }),
    });
  } catch (error) {
    // A transient POST failure must not strand the round with both controls
    // disabled.  Keep the already-viewed question answerable and replayable.
    if (generation === roundGeneration) {
      compositionQuestionReady = true;
      el("puzzle-check").disabled = false;
      el("puzzle-replay").disabled = false;
    }
    throw error;
  }
  if (generation !== roundGeneration) return;
  renderCompositionResult(result);
  operationAnswered = true;
  compositionPlaybackMode = "product";
  syncCompositionPlaybackButtons();
  el("puzzle-composition-playback").hidden = false;
  el("puzzle-again").hidden = false;
  // Reveal the product: play its animation, then show its symmetry element.
  revealOperation = result.product_index;
  await playCompositionProduct(generation);
}

// --- Reveal animation (shared) ---

function setSlider(fraction) {
  el("puzzle-slider").value = String(Math.round(fraction * 1000));
}

// Mirrors analysis mode's #movement-progress <datalist> tick marks
// (setMovementBreakpoints() in browser_ui.js), scoped to #puzzle-slider.
// Composition is the only quiz whose slider spans more than one loaded
// animation (A in [0, 0.5], B in [0.5, 1]), so it is the only one with a
// breakpoint to show.
function setPuzzleSliderBreakpoints(values) {
  const list = el("puzzle-slider-stops");
  list.innerHTML = "";
  for (const value of values) {
    const option = document.createElement("option");
    option.value = String(Math.round(value * 1000));
    list.appendChild(option);
  }
}

function animateProgress(from, to, durationMs, apply = (fraction) => view.setAnimationProgress(fraction)) {
  cancelReveal();
  return new Promise((resolve) => {
    const token = { resolve, start: performance.now() };
    revealAnim = token;
    const step = (now) => {
      if (revealAnim !== token) return; // superseded/cancelled
      const k = Math.min((now - token.start) / durationMs, 1);
      const fraction = from + (to - from) * k;
      apply(fraction);
      setSlider(fraction);
      if (k >= 1) {
        revealAnim = null;
        resolve();
        return;
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

function animateReveal() {
  return animateProgress(0, 1, REVEAL_DURATION_MS);
}

function cancelReveal() {
  const anim = revealAnim;
  revealAnim = null;
  if (anim) anim.resolve();
}

async function playReveal() {
  if (revealOperation == null) return; // e.g. an infinite axis: nothing to play
  const generation = roundGeneration;
  el("puzzle-replay").disabled = true;
  if (!el("puzzle-save-gif").hidden) el("puzzle-save-gif").disabled = true;
  try {
    // Override the shared analysis selection so puzzle rounds animate their own
    // displayed/unit-cell atoms consistently.
    await view.loadAnimationPaths(Number(revealOperation), ++view.pathGeneration, view.showAnimationTargets ? "unit_cell" : "displayed");
    if (generation !== roundGeneration) return;
    view.resetAnimation();
    await animateReveal();
    revealOperationElements(generation);
  } finally {
    if (generation === roundGeneration) {
      el("puzzle-replay").disabled = false;
      if (!el("puzzle-save-gif").hidden) {
        el("puzzle-save-gif").disabled = !view.animationPaths.size;
      }
    }
  }
}

function revealOperationElements(generation = roundGeneration) {
  if (!operationAnswered || generation !== roundGeneration || revealOperation == null) return;
  // Use the current path generation. If a replay supersedes this request, the
  // StaticStructureView guard discards it, and replay completion calls us again.
  view.loadSymmetryElements(Number(revealOperation), view.pathGeneration).catch(() => {});
}

// --- Mapping quiz ("where does this atom go?") ---

function atomStartMarker(sourceAtom) {
  for (const instance of view.atomInstances.values()) {
    if (instance.sourceAtom === Number(sourceAtom)) {
      return { position: instance.start, radius: instance.radius };
    }
  }
  return null;
}

function refreshMappingMarkers({ revealTarget = null } = {}) {
  const entries = [{ atom: currentQuestion.source_atom_index, color: PICK_SOURCE_COLOR }];
  if (mappingGuess != null && mappingGuess !== currentQuestion.source_atom_index) {
    // The blue ring means "the destination I clicked", so keep it at that
    // original site while all atoms move during the reveal.  Following the atom
    // that happened to occupy the site would give the colour a different meaning.
    const guess = atomStartMarker(mappingGuess);
    if (guess) {
      entries.push({
        position: [...guess.position],
        color: PICK_GUESS_COLOR,
        // Sits inside the yellow ring, which the source atom carries at radius
        // 1.0. Leave the same visible gap the green answer ring has on the
        // outside, so a correct guess reads as three rings and not one band.
        radius: guess.radius * 0.84,
      });
    }
  }
  if (revealTarget != null) {
    // A fixed ring at the target atom's start position: the highlighted atom lands
    // inside it as the operation completes (the target atom itself moves away).
    const target = atomStartMarker(revealTarget);
    if (target) {
      entries.push({
        position: [...target.position],
        color: PICK_TARGET_COLOR,
        // A correct blue guess and the green answer are concentric.  Different
        // radii leave both visible instead of letting one ring completely hide.
        radius: target.radius * 1.18,
      });
    }
  }
  view.setPickMarkers(entries);
}

function orientPlanarMappingStructure() {
  const coords = (view.renderData?.atoms || [])
    .map((atom) => atom.cart?.map(Number))
    .filter((cart) => Array.isArray(cart) && cart.length === 3 && cart.every(Number.isFinite));
  if (coords.length < 2) return;
  const add = (a, b) => a.map((value, axis) => value + b[axis]);
  const subtract = (a, b) => a.map((value, axis) => value - b[axis]);
  const scale = (a, factor) => a.map((value) => value * factor);
  const dot = (a, b) => a.reduce((sum, value, axis) => sum + value * b[axis], 0);
  const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const length = (a) => Math.sqrt(dot(a, a));
  const center = scale(coords.reduce(add, [0, 0, 0]), 1 / coords.length);
  const centered = coords.map((point) => subtract(point, center));
  const primary = centered.reduce(
    (best, point) => (length(point) > length(best) ? point : best),
    [0, 0, 0],
  );
  const extent = length(primary);
  if (!(extent > 1e-10)) return;

  // A cross product finds the normal regardless of how the molecule is oriented
  // in Cartesian space.  If all points are collinear, choose a stable direction
  // perpendicular to the molecular line instead.
  let normal = centered.reduce(
    (best, point) => (length(cross(primary, point)) > length(best) ? cross(primary, point) : best),
    [0, 0, 0],
  );
  if (length(normal) <= extent * extent * 1e-8) {
    const leastAligned = Math.abs(primary[0]) <= Math.abs(primary[1])
      && Math.abs(primary[0]) <= Math.abs(primary[2])
      ? [1, 0, 0]
      : Math.abs(primary[1]) <= Math.abs(primary[2]) ? [0, 1, 0] : [0, 0, 1];
    normal = cross(primary, leastAligned);
  }
  const normalLength = length(normal);
  if (!(normalLength > 1e-10)) return;
  normal = scale(normal, 1 / normalLength);
  const thickness = Math.max(...centered.map((point) => Math.abs(dot(point, normal))));
  if (thickness > extent * 0.08) return;
  view.viewAlongCartesianDirection(normal, center);
}

function beginMappingRound() {
  mappingGuess = null;
  const operationLabel = shortOperationLabel(currentQuestion.operation);
  el("puzzle-question").textContent =
    `黄色の原子は、操作 ${operationLabel} でどの原子に移りますか？`
    + "移り先の原子をクリックして回答してください。";
  setStageCaption("");
  el("puzzle-options").innerHTML = ""; // the answer is a click, not a radio choice
  el("puzzle-slider").hidden = true;
  el("puzzle-playback").hidden = true; // reveal controls appear after answering
  el("puzzle-check").disabled = false;
  hidePuzzleGifButton();
  // Face planar/linear molecules along their thin axis so candidate sites do not
  // overlap (notably benzene's C/H rings in the default oblique camera).
  orientPlanarMappingStructure();
  refreshMappingMarkers();
  // Show the operation's axis, plane or centre before the player answers.
  view.loadSymmetryElements(Number(currentQuestion.operation_index), view.pathGeneration).catch(() => {});
  view.onAtomPick = (atomIndex) => {
    if (operationAnswered || atomIndex == null) return;
    mappingGuess = Number(atomIndex);
    refreshMappingMarkers();
  };
}

async function playMappingReveal(generation = roundGeneration) {
  const playback = ++mappingPlaybackGeneration;
  const isCurrent = () =>
    generation === roundGeneration
    && playback === mappingPlaybackGeneration
    && operationAnswered;
  cancelReveal();
  el("puzzle-replay").disabled = true;
  view.setAnimationSourceAtoms(null);
  try {
    // The now-removed playMappingPreview() (2026-09-09) used to load this once
    // per round, before the player could even click 回答 — nothing does that
    // any more, so the reveal has to load its own animation path, the same way
    // playReveal() does for the other quizzes. Without this, view.animationPaths
    // stays empty (cleared by invalidatePuzzleWork() at round start) and 再生
    // animates nothing.
    await view.loadAnimationPaths(Number(currentQuestion.operation_index), ++view.pathGeneration, "displayed");
    if (!isCurrent()) return;
    view.resetAnimation();
    refreshMappingMarkers({ revealTarget: mappingRevealTarget });
    await animateProgress(0, 1, REVEAL_DURATION_MS);
  } finally {
    if (isCurrent()) el("puzzle-replay").disabled = false;
  }
}

async function onCheckMapping() {
  const generation = roundGeneration;
  if (mappingGuess == null) {
    showPrompt("移り先の原子をクリックしてください。");
    return;
  }
  mappingPlaybackGeneration += 1;
  cancelReveal();
  view.pathGeneration += 1;
  el("puzzle-check").disabled = true;
  let result;
  try {
    result = await getJson("/api/puzzle/mapping/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question_id: currentQuestion.id, selected_atom_index: mappingGuess }),
    });
  } catch (error) {
    if (generation === roundGeneration) {
      el("puzzle-check").disabled = false;
    }
    throw error;
  }
  if (generation !== roundGeneration) return;
  operationAnswered = true;
  const box = el("puzzle-result");
  box.hidden = false;
  box.className = `puzzle-result ${result.correct ? "hit" : "miss"}`;
  box.textContent = result.correct ? "正解" : "不正解";
  box.innerHTML += mappingResultDetails(result);
  el("puzzle-again").hidden = false;
  mappingRevealTarget = result.target_atom_index; // keep the guess ring; add the target
  // Reveal the full operation from rest: the yellow atom lands on the fixed green
  // destination ring while the rest of the molecule follows the same operation.
  el("puzzle-playback").hidden = false;
  await playMappingReveal(generation);
}

function mappingResultDetails(result) {
  const atoms = view.renderData.atoms.filter(atom => Array.isArray(atom.cart));
  const source = atoms.find(atom => Number(atom.index) === Number(result.source_atom_index));
  const operation = view.renderData.operations.find(op => Number(op.index) === Number(result.operation_index));
  const transformed = source && operation?.matrix_cart && operation?.translation_cart
    ? operation.matrix_cart.map((row, i) => row.reduce((sum, value, j) => sum + value * source.cart[j], operation.translation_cart[i]))
    : null;
  const vector = (values, label, name) => `<div class="puzzle-equation-term"><span>${label}</span>`
    + `<div class="operation-matrix puzzle-column-vector" data-vector="${name}" aria-label="${label}">`
    + values.map(value => `<span>${compositionMatrixNumber(value)}</span>`).join("") + `</div></div>`;
  const matrix = operation?.matrix_cart.map(row => `<div class="operation-matrix-row" role="row">`
    + row.map(value => `<span role="cell">${compositionMatrixNumber(value)}</span>`).join("") + "</div>").join("");
  const equation = source && transformed ? `<div class="puzzle-mapping-equation" aria-label="操作後の位置は、操作行列と操作前の位置の積に並進を加えたものです">`
    + vector(transformed, "操作後 x′（緑色の位置）", "after")
    + `<span class="puzzle-equation-sign">=</span>`
    + `<div class="puzzle-equation-term"><span>操作行列 W</span><div class="operation-matrix" role="table" aria-label="操作の行列 W">${matrix}</div></div>`
    + `<span class="puzzle-equation-sign">×</span>` + vector(source.cart, "操作前 x（黄色）", "before")
    + `<span class="puzzle-equation-sign">+</span>` + vector(operation.translation_cart, "並進 t", "translation") + `</div>` : "";
  return `<details class="puzzle-operation-details puzzle-mapping-details"><summary>原子位置と操作行列</summary>`
    + `<p>対象原子：${escapeHtml(source?.element || "")} ${Number(result.source_atom_index) + 1}。直交座標（x, y, z の順、単位：Å）。</p>`
    + `<p>操作：${formatOperationAnswers([currentQuestion.operation])}。行列 W を操作前の位置に掛け、並進 t を加えると、操作後の位置になります。</p>`
    + equation + `</details>`;
}

// --- Checking answers ---

async function onCheck() {
  if (!currentQuestion) return;
  if (currentQuiz === "axis") return onCheckAxis();
  if (currentQuiz === "composition") return onCheckComposition();
  if (currentQuiz === "mapping") return onCheckMapping();
  if (currentQuiz === "point_group") return onCheckPointGroup();
  return onCheckOperation();
}

function onReplay() {
  // Composition replays its own two-phase sequence (or the product, once answered).
  if (currentQuiz === "composition") {
    if (operationAnswered && compositionPlaybackMode === "product" && revealOperation != null) {
      return playCompositionProduct();
    }
    return playCompositionQuestion();
  }
  if (currentQuiz === "mapping") {
    // #puzzle-playback (and its 再生 button) stays hidden until after answering,
    // so there is nothing to replay before then.
    if (!operationAnswered) return Promise.resolve();
    return playMappingReveal();
  }
  return playReveal();
}

function selectedOrder() {
  const checked = el("puzzle-options").querySelector('input[name="puzzle-order"]:checked');
  return checked ? checked.value : null;
}

async function onCheckAxis() {
  const generation = roundGeneration;
  const selected = selectedOrder();
  if (selected == null) {
    showPrompt("回数を1つ選んでください。");
    return;
  }
  el("puzzle-check").disabled = true;
  const result = await getJson("/api/puzzle/axis_orders/check", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question_id: currentQuestion.id, selected_order: selected }),
  });
  if (generation !== roundGeneration) return;
  const box = el("puzzle-result");
  box.hidden = false;
  box.className = `puzzle-result ${result.correct ? "hit" : "miss"}`;
  box.textContent = result.correct ? "正解" : `不正解（正解は ${formatOrder(result.answer)}）`;
  revealOperation = result.reveal_operation;
  el("puzzle-again").hidden = false;
  if (revealOperation == null) {
    el("puzzle-playback").hidden = true; // infinite axis: nothing to animate
  } else {
    el("puzzle-playback").hidden = false;
    el("puzzle-trajectories").hidden = false;
    setPuzzleGifButtonReady(false);
    playReveal().catch(showError);
  }
}

function selectedOperationAnswer() {
  const root = el("puzzle-options");
  const kind = root.querySelector('input[name="op-kind"]:checked')?.value || null;
  const orderInput = root.querySelector('input[name="op-order"]:checked');
  const shiftInput = root.querySelector('input[name="op-shift"]:checked');
  // Raw value ("2" or "inf"); the server normalises it.
  return {
    kind,
    order: orderInput ? orderInput.value : null,
    shift: shiftInput ? shiftInput.value : null,
  };
}

async function onCheckOperation() {
  const generation = roundGeneration;
  const { kind, order, shift } = selectedOperationAnswer();
  if (!kind) {
    showPrompt("操作の種類を選んでください。");
    return;
  }
  const config = operationKinds().find((k) => k.kind === kind);
  if (config?.orders && order == null) {
    showPrompt("回数も選んでください。");
    return;
  }
  if (currentOperationDifficulty === "hard" && shift == null) {
    showPrompt("並進成分も選んでください。");
    return;
  }
  el("puzzle-check").disabled = true;
  const result = await getJson("/api/puzzle/operations/check", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question_id: currentQuestion.id, kind, order, shift, difficulty: currentOperationDifficulty }),
  });
  if (generation !== roundGeneration) return;
  const box = el("puzzle-result");
  box.hidden = false;
  box.className = `puzzle-result ${result.correct ? "hit" : "miss"}`;
  const answerText = formatOperationAnswers(result.answers);
  if (result.correct) {
    // When a motion carries more than one valid name, say so.
    box.innerHTML = result.answers.length > 1 ? `正解（${answerText} のいずれも正解）` : `正解（${answerText}）`;
  } else {
    box.innerHTML = `不正解（正解は ${answerText}）`;
  }
  if (result.answers.length > 1) {
    // Merged because the atoms move alike, not because the operations are equal.
    box.innerHTML += `<br>原子の動きは同じに見えますが、${answerText} は別々の対称操作です。`;
  }
  el("puzzle-again").hidden = false;
  el("puzzle-trajectories").hidden = false;
  operationAnswered = true;
  // Reveal where the operation's symmetry element sits (axis / plane / centre /
  // glide arrow) now that the answer is in — the same elements the analysis shows.
  revealOperationElements(generation);
}

// --- Camera controls (reuse StaticStructureView's own methods) ---

const CAMERA_DIRECTIONS = {
  "puzzle-cam-left": "left",
  "puzzle-cam-right": "right",
  "puzzle-cam-up": "up",
  "puzzle-cam-down": "down",
  "puzzle-cam-roll-left": "roll-left",
  "puzzle-cam-roll-right": "roll-right",
};

function toggleProjection() {
  const button = el("puzzle-projection");
  const next = button.dataset.projection === "perspective" ? "orthographic" : "perspective";
  view.setProjection(next);
  button.dataset.projection = next;
  button.textContent = next === "perspective" ? "透視投影" : "平行投影";
}

function syncTargetCopiesButton() {
  el("puzzle-target-copies").checked = view.showAnimationTargetCopies !== false;
}

// The checkbox's own click already flips el("puzzle-target-copies").checked
// before this "change" handler runs, so read it rather than negating state.
function toggleTargetCopies() {
  view.showAnimationTargetCopies = el("puzzle-target-copies").checked;
  view.updateAnimationTargetMarkers();
}

// Crystal-only: mirrors analysis mode's "周期境界セルの原子" (#include-boundary-images)
// toggle, including its checkbox + label styling. Puzzle mode has no
// server-side postState round trip for this, so it carries the flag as a
// query param on the view's own render_data/animation_path requests instead
// (same mechanism display_mode=source already uses here).
function applyBoundaryImagesQuery(kind) {
  const flag = puzzleShowBoundaryImages ? 1 : 0;
  view.renderDataQuery = kind === "crystal" ? `?display_mode=source&boundary_images=${flag}` : "";
  view.animationPathQuery = kind === "crystal" ? `&display_mode=source&boundary_images=${flag}` : "";
  view.symmetryElementQuery = kind === "crystal" ? "&display_mode=source" : "";
}

function syncBoundaryImagesButton() {
  el("puzzle-boundary-images").checked = puzzleShowBoundaryImages;
}

async function toggleBoundaryImages() {
  puzzleShowBoundaryImages = el("puzzle-boundary-images").checked;
  applyBoundaryImagesQuery(currentSourceKind);
  await view.refresh();
  if (currentQuiz === "point_group") showPointGroupStructureInfo();
}

function syncTrajectoriesButton() {
  const button = el("puzzle-trajectories");
  const enabled = view.showTrajectories === true;
  button.dataset.enabled = enabled ? "true" : "false";
  button.textContent = enabled ? "軌道: 表示" : "軌道: 非表示";
}

function toggleTrajectories() {
  view.showTrajectories = view.showTrajectories !== true;
  view.updateTrajectoryLines();
  syncTrajectoriesButton();
}

function hidePuzzleGifButton() {
  const button = el("puzzle-save-gif");
  button.hidden = true;
  button.disabled = true;
  button.textContent = "GIFを保存";
}

function setPuzzleGifButtonReady(ready) {
  const button = el("puzzle-save-gif");
  button.hidden = false;
  button.disabled = !ready;
  button.textContent = "GIFを保存";
}

async function savePuzzleGif() {
  const button = el("puzzle-save-gif");
  if (view.recording) return;
  const controls = [...el("puzzle-play").querySelectorAll("button, input")];
  const disabled = new Map(controls.map(control => [control, control.disabled]));
  for (const control of controls) control.disabled = true;
  button.disabled = true;
  button.textContent = "保存中...";
  try {
    await view.recordGif("puzzle-animation");
  } finally {
    for (const [control, wasDisabled] of disabled) control.disabled = wasDisabled;
    button.textContent = "GIFを保存";
  }
}

function setupCameraControls() {
  for (const [id, direction] of Object.entries(CAMERA_DIRECTIONS)) {
    el(id).addEventListener("click", () => {
      view.rotateCamera(direction, Number(el("puzzle-cam-angle").value) || 0);
    });
  }
  el("puzzle-view-along").addEventListener("click", () => {
    if (!currentQuestion) return;
    if (currentQuiz === "axis") {
      view.viewAlongCartesianDirection(currentQuestion.direction_cart, currentQuestion.point_cart);
    } else if (currentQuiz === "mapping") {
      view.viewAlongCurrentOperation();
    }
  });
}

function setupControls() {
  el("puzzle-projection").addEventListener("click", toggleProjection);
  el("puzzle-target-copies").addEventListener("change", toggleTargetCopies);
  el("puzzle-boundary-images").addEventListener("change", () => toggleBoundaryImages().catch(showError));
  el("puzzle-trajectories").addEventListener("click", toggleTrajectories);
  setupCameraControls();
  el("puzzle-check").addEventListener("click", () => onCheck().catch(showError));
  el("puzzle-replay").addEventListener("click", () => onReplay().catch(showError));
  el("puzzle-composition-sequence").addEventListener("click", () => selectCompositionPlayback("sequence").catch(showError));
  el("puzzle-composition-product").addEventListener("click", () => selectCompositionPlayback("product").catch(showError));
  el("puzzle-save-gif").addEventListener("click", () => savePuzzleGif().catch(showError));
  el("puzzle-slider").addEventListener("input", (event) => {
    cancelReveal();
    const fraction = Number(event.target.value) / 1000;
    // The selected A/B route keeps its combined timeline after answering too.
    // Product playback and the other quizzes use a single operation.
    if (currentQuiz === "composition" && compositionPlaybackMode === "sequence") {
      applyCombinedCompositionProgress(fraction);
      setStageCaption(compositionCaptionForFraction(fraction));
    } else {
      view.setAnimationProgress(fraction);
    }
  });
  el("puzzle-again").addEventListener("click", () => {
    if (questions.length) beginRound();
  });
  el("puzzle-open-analysis").addEventListener("click", openCurrentStructureInAnalysis);
  el("puzzle-other").addEventListener("click", () => {
    // The point-group quiz never lets the player pick a structure by name
    // (that would let them recognise it and answer from memory instead of
    // looking at it), so there is no named list to show here. It used to send
    // "another structure" back to the molecule/crystal kind screen, but that
    // meant re-clicking the very kind already in play just to continue —
    // instead, re-roll a new random structure of the same kind in place.
    // Switching kind (or quiz) still works via 戻る, which showPlay() keeps
    // visible for this quiz precisely because it no longer visits a screen.
    if (currentQuiz === "point_group") {
      startRandomPointGroupStructure(currentKind).catch(showError);
    } else {
      showPicker();
    }
  });
  // goBack() resolves the parent screen for every quiz screen.
  el("puzzle-back").addEventListener("click", () => goBack());
  for (const card of document.querySelectorAll("[data-quiz]")) {
    card.addEventListener("click", () => {
      currentQuiz = card.dataset.quiz;
      if (currentQuiz === "operation") {
        // Structure first, difficulty second (only crystals ask): see the
        // picker's structure-button handler above.
        currentOperationDifficulty = "normal";
        buildPicker().then(showPicker).catch(showError);
      } else if (currentQuiz === "point_group") {
        buildPointGroupKindScreen().then(showPointGroupKind).catch(showError);
      } else {
        buildPicker().then(showPicker).catch(showError);
      }
    });
  }
  for (const card of document.querySelectorAll("[data-operation-difficulty]")) {
    card.addEventListener("click", () => {
      currentOperationDifficulty = card.dataset.operationDifficulty || "normal";
      if (!pendingOperationExample) return;
      startStructure(pendingOperationExample, pendingOperationLabel).catch(showError);
    });
  }
  for (const card of document.querySelectorAll("[data-point-group-kind]")) {
    card.addEventListener("click", () => {
      startRandomPointGroupStructure(card.dataset.pointGroupKind).catch(showError);
    });
  }
}

function enterPuzzle() {
  if (!started) {
    started = true;
    view = new StaticStructureView(el("puzzle-view"));
    view.setBackgroundMode("light");
    // Puzzle clicks are never analysis selections. The mapping round installs its
    // own hook, as does point-group coordinate inspection; other screens ignore clicks.
    view.disableAtomSelection = true;
    setupControls();
  } else if (view) {
    view.setActive(true);
    view.resize();
  }
  showQuizSelect();
}

window.addEventListener("symmetry-enter-puzzle", enterPuzzle);
// Leaving the puzzle hides this canvas but does not destroy it, so stop its
// frame loop; the analysis view resumes its own on the way in.
window.addEventListener("symmetry-exit-puzzle", () => view?.setActive(false));
// Dispatched by resumePuzzleMode() (browser_ui.js) when "クイズに戻る" is
// pressed from the analysis screen openCurrentStructureInAnalysis() jumped to
// — unlike symmetry-enter-puzzle, this does not call showQuizSelect(): the
// #puzzle-play screen and its round state were never torn down, so just
// reactivate the (already-built) view the same way switching back to any
// already-open screen does.
window.addEventListener("symmetry-resume-puzzle", () => {
  if (view) {
    view.setActive(true);
    view.resize();
  }
});

// browser_ui.js's global ArrowLeft/ArrowRight handler is not mode-aware: it
// dispatches this event on `window` whenever pressed, and three_view.js's
// StaticStructureView subscribes to it per-instance, so the puzzle view moves
// right along with the analysis one. But puzzle.js never listened for it, so
// #puzzle-slider was left showing the pre-keypress position. Sync it here —
// guarded by in-puzzle so a keypress taken while looking at analysis mode
// doesn't touch this (hidden, but still stale) slider.
window.addEventListener("symmetry-animation-progress", (event) => {
  if (!document.body.classList.contains("in-puzzle")) return;
  setSlider(Number(event.detail?.progress) || 0);
});

// In --mode puzzle the classic UI script can dispatch its entry event before this
// module has registered the listener. Recover from that ordering by inspecting the
// already-rendered screen; `started` keeps the path idempotent.
if (el("puzzle-mode")?.hidden === false) queueMicrotask(enterPuzzle);
