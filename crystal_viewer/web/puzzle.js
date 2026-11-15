import {Vector3} from "/vendor/three/three.module.js";
import { StaticStructureView } from "/static/three_view.js";
import { PUZZLE_RING_COLORS } from "/static/colors.js";
import {loadLegacyQuizComposition, legacyQuizDurationMs} from "/static/animation_path.js";
import {ANIMATION_SPEED_STEPS} from "/static/playback_schedule.js";
import {quizWaiting, modelViewEnabled, createModelViewClient} from "/static/view_api.js";

// All four current quizzes use independent, question-bound API2 models.
// Analysis loads its own model and never shares mutable quiz state.
// Only an explicit API1 host uses the legacy quiz preparation below.
const quizClient = modelViewEnabled ? createModelViewClient({prefix: "/api/quiz/model",
  eventName: "symmetry-quiz-model-exchange", contextKeys: ["round_id", "question_token"],
  bindLoadIdentity: false}) : null;
if (quizClient) {
  window.symmetryQuizModelBoundary = quizClient.modelBoundary;
  window.symmetryMappingModelBoundary = quizClient.modelBoundary; // retained diagnostic alias
}

let view = null;
let started = false;
let catalog = null;
let currentQuiz = "operation"; // "axis" | "operation" | "composition" | "mapping" | "point_group"
let currentPointGroupDifficulty = "normal";
let currentCompositionDifficulty = "normal";
let currentMappingDifficulty = "normal";
let mappingChoiceGeneration = 0;
let mappingPlaybackScope = "target";
let mappingGuessPosition = null;
let mappingTargetPosition = null;
// Shown only after a point-group answer (the name would give the answer away).
let pointGroupStructureLabel = "";
let mappingDestinationCell = null;
let compositionChoiceGeneration = 0;
let compositionAnswer = null;
let pointGroupLoadGeneration = 0;
let pointGroupAnalysisIndex = null;
let puzzleShowPeriodicNeighbors = false;
let currentOperationDifficulty = "normal"; // "normal" | "hard"
let currentKind = "molecule"; // structure picker toggle
let currentSourceKind = "molecule"; // kind of the loaded structure (for answer options)
let questions = [];
let currentQuestion = null;
let revealOperation = null; // operation index to animate for the reveal
let revealAnim = null; // active reveal animation token
// Presentation-only preference, independent of both API2 model states.
// Quiz playback speed, kept separately for molecules and crystals (11月10日:
// crystals start at 1.25× because their larger cells play slowly). Each value
// is kept across questions, structures, quizzes and analysis; reload resets it.
const puzzlePlaybackSpeeds = {molecule: 0.75, crystal: 1.25};
const puzzleSpeedKind = () => currentSourceKind === "crystal" ? "crystal" : "molecule";
const puzzlePlaybackSpeed = () => puzzlePlaybackSpeeds[puzzleSpeedKind()];
let roundGeneration = 0; // invalidates async work from prior rounds/screens
let operationAnswered = false;
let mappingLoadGeneration = 0;
let mappingLoadControls = null;
let analysisLoadControls = null;
let mappingGuess = null; // mapping quiz: the atom the player clicked
let mappingRevealTarget = null; // mapping quiz: the correct target atom (after answering)
let mappingAnswerCorrect = false;
let compositionPlaybackGeneration = 0;
let compositionQuestionReady = false;
let compositionPlaybackMode = "operation1";
// Composition quiz: A and B share a sequential path. Each atom starts B at its
// endpoint from A; the slider reserves half its range for each operation.
let compositionSnapshot = null;
let compositionActiveSnapshot = null;
let compositionLabelA = "";
let compositionLabelB = "";
let mappingPlaybackGeneration = 0;
let currentExample = null;
// Crystals default to unit-cell atoms only (periodic images off); the camera
// overlay's toggle flips this per structure, reset on every new startStructure().
let puzzleShowBoundaryImages = false;
let boundaryDisplayGeneration = 0;
// Display-instance keys, independent of analysis selection and playback scope.
const coordinateSelection = new Set();
let puzzleInitialCamera = null;
let openOrderPanel = null;
let coordinateAtom = null;
let coordinateInverse = null;

const INFINITE = "inf";
const SHIFT_OPTIONS = ["1/6", "1/4", "1/3", "1/2", "2/3", "3/4", "5/6"];
// Mapping uses the shared orange selection ring, with purple for the question
// atom and green for the correct site. All three share the selection geometry.
const PICK_SOURCE_COLOR = PUZZLE_RING_COLORS.source;
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
    ...(currentQuiz === "composition" ? [{kind: "identity", label: "恒等", orders: null}] : []),
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
  const schoenflies = text.match(/^([CDSTOI])((?:\d+|∞)?[a-z]*)$/);
  if (schoenflies && schoenflies[2]) return `${schoenflies[1]}<sub>${schoenflies[2]}</sub>`;
  return text.replace(/-([0-9]+)/g, '<span class="overline">$1</span>');
}

function formatOperationAnswer(kind, order, shift = null, notation = null) {
  let text = kind;
  if (kind === "identity") text = "恒等";
  if (kind === "translation") text = "並進";
  if (kind === "rotation") text = `${order}回回転`;
  if (kind === "mirror") text = "鏡映";
  if (kind === "inversion") text = "反転";
  if (kind === "screw") text = `${order}回らせん`;
  if (kind === "glide") text = "映進";
  const improper = kind === "rotoreflection" || kind === "rotoinversion";
  let label = improper ? improperOperationLabel(kind, order) : escapeHtml(text);
  if (shift) label += `、並進 ${escapeHtml(shift)}`;
  // Keep the existing infinite-rotation notation; finite operations need no
  // parenthesized symbol or alternative name beside their primary label.
  return notation && (order === INFINITE || order === "∞" || String(notation).includes("∞"))
    ? `${label}（${formatOperationNotation(notation)}）` : label;
}

function formatOperationAnswers(answers) {
  // Coincident motions accept more than one name (e.g. CO2: 反転 or 鏡映).
  return (answers || [])
    .map((a) => formatOperationAnswer(a.kind, a.order, a.shift, a.notation || a.symbol))
    .join(" または ");
}

function formatBarSymbol(order) {
  const n = Number(order);
  return `<span class="overline" aria-label="バー${n}">${n}</span>`;
}

function improperOperationLabel(kind, order, symbolOnly = false) {
  const n = Number(order);
  if (kind === "rotoreflection") {
    const symbol = `S<sub>${n}</sub>`;
    return symbolOnly ? symbol : `回映 ${symbol}`;
  }
  const symbol = formatBarSymbol(n);
  return symbolOnly ? symbol : `${n}回回反 ${symbol}`;
}

function formatCompositionAnswers(answers) {
  return (answers || []).map(answer => {
    if (answer.kind !== "rotoreflection" && answer.kind !== "rotoinversion") {
      return formatOperationAnswer(answer.kind, answer.order, answer.shift, answer.notation || answer.symbol);
    }
    const preferred = currentSourceKind === "crystal" ? "rotoinversion" : "rotoreflection";
    const order = answer.kind === preferred ? answer.order : {3: 6, 4: 4, 6: 3}[answer.order];
    return improperOperationLabel(preferred, order);
  }).join(" または ");
}

function displayLabel(example) {
  // display_formula is the formula as a chemist writes it (C6H6, not the
  // reduced HC); the analysis layer computes it, so there is no table here.
  return formatFormula(example.display_formula || example.formula || example.name);
}

// The point-group reveal names the structure; where another structure of the
// same kind shares the formula (TiO2 rutile/anatase, C diamond/graphite), add
// the structure name as the picker does.
function pointGroupRevealLabel(example, kind) {
  const label = displayLabel(example);
  const sharing = (catalog?.[kind] || []).filter(item => displayLabel(item) === label).length;
  return sharing > 1 ? `${label} <span class="puzzle-structure-note">${escapeHtml(example.name)}</span>` : label;
}

// Which catalog count decides whether the current quiz can use a structure.
function puzzleCountKey() {
  if (currentQuiz === "operation") {
    return currentOperationDifficulty === "hard" ? "operation_hard" : "operation_normal";
  }
  return currentQuiz === "axis" ? "axis" : currentQuiz;
}

// Normal/Hard is chosen on the picker for these quizzes (point group keeps
// its own difficulty screen because it picks a random structure).
// The picker's choice is kept apart from the loaded round's difficulty, so a
// failed load that keeps the previous question also keeps its difficulty.
const pickerLevels = {operation: "normal", composition: "normal", mapping: "normal"};

// One line beside the picker's toggle says what the selected level asks.
const DIFFICULTY_NOTES = {
  operation: {normal: "回転・鏡映・反転・回反", hard: "らせん・映進"},
  composition: {normal: "対称操作どうしの合成", hard: "単独では対称操作でない2つの操作の合成"},
  mapping: {normal: "単位格子内への移動", hard: "単位格子の外への移動"},
};

function pickerDifficulty() {
  return pickerLevels[currentQuiz] || null;
}

function setPickerDifficulty(level) {
  if (currentQuiz in pickerLevels) pickerLevels[currentQuiz] = level;
}

// Difficulty of the round on screen (or the one being reloaded).
function roundDifficulty() {
  return {operation: currentOperationDifficulty, composition: currentCompositionDifficulty,
    mapping: currentMappingDifficulty}[currentQuiz] || "normal";
}

// The catalog records, from the live quiz generators, which quiz/difficulty
// pairs each structure can pose. Unknown (older catalog) counts as playable.
function isAvailable(example, level, quiz = currentQuiz) {
  const availability = example.quiz_availability?.[quiz];
  return availability ? Boolean(availability[level]) : true;
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
  // A structure with no question at either difficulty is not offered at all.
  // (The point-group quiz filters by its chosen difficulty in eligibleExamples.)
  if (currentQuiz !== "point_group" && example.quiz_availability?.[currentQuiz])
    return isAvailable(example, "normal") || isAvailable(example, "hard");
  // Composition availability comes from the selected model, not legacy counts.
  if (currentQuiz === "composition" && modelViewEnabled) return true;
  if (currentQuiz === "mapping" && modelViewEnabled && example.kind === "crystal") return true;
  // Counts come from the catalog, which the export step computes by running the
  // real question generators. Without them (filesystem fallback catalog) assume
  // playable rather than hiding everything.
  const counts = example.puzzle_counts;
  if (!counts) return true;
  // Hard can factor a single moving symmetry even when Normal has no pair.
  // Counts only shortlist structures; both difficulties are checked on a model.
  if (currentQuiz === "composition") return Number(counts.composition || 0) > 0 || Number(counts.operation_normal || 0) > 0;
  return Number(counts[puzzleCountKey()] || 0) > 0;
}

function eligibleExamples(kind, pointGroupDifficulty = currentPointGroupDifficulty) {
  if (currentQuiz === "point_group" && (catalog?.[kind] || []).every(example => example.quiz_availability)) {
    // A random point-group structure must have a question at the chosen level.
    return (catalog?.[kind] || []).filter(example => isAvailable(example, pointGroupDifficulty, "point_group"));
  }
  if (currentQuiz === "point_group" && pointGroupDifficulty === "hard") {
    // A catalog count is only a cheap candidate hint. The verified model must
    // establish Hard eligibility; no stored input or catalog is regenerated.
    return kind === "crystal" ? (catalog?.crystal || []).filter(example => example.quiz_availability
      ? isAvailable(example, "hard", "point_group")
      : !example.puzzle_counts || Number(example.puzzle_counts.operation_hard || 0) > 0) : [];
  }
  return (catalog?.[kind] || []).filter(isEligible);
}

// --- Screens: quiz select -> structure picker -> play ---

// Navigation drops old cursor tokens; late completions cannot clear a new wait.
const clearPuzzleLoading = () => {
  quizWaiting.clear(); compositionChoiceGeneration += 1; mappingChoiceGeneration += 1;
  // Suspending a mapping question preserves its model and answer, while stale
  // path preparation must not commit or start playback behind another screen.
  if (currentQuiz === "mapping" && currentQuestion && view) {
    mappingPlaybackGeneration += 1;
    view.pathGeneration += 1;
    cancelReveal();
    if (operationAnswered) el("puzzle-replay").disabled = false;
  }
};
const withPuzzleLoading = work => quizWaiting.run(work);

function restoreMappingControls() {
  if (!mappingLoadControls) return;
  for (const [control, disabled] of mappingLoadControls) control.disabled = disabled;
  mappingLoadControls = null;
  syncPuzzleSpeedControls();
}

function restoreAnalysisControls() {
  if (!analysisLoadControls) return;
  for (const [control, disabled] of analysisLoadControls) control.disabled = disabled;
  analysisLoadControls = null;
  syncPuzzleSpeedControls();
}

function invalidatePuzzleWork() {
  pointGroupLoadGeneration += 1;
  compositionChoiceGeneration += 1;
  mappingChoiceGeneration += 1;
  compositionAnswer = null;
  pointGroupAnalysisIndex = null;
  el("puzzle-periodic-neighbors-toggle").hidden = true;
  el("puzzle-mapping-operation").hidden = true;
  el("puzzle-mapping-cell-toggle").hidden = true;
  el("puzzle-mapping-cell").checked = false;
  mappingDestinationCell = null;
  view?.setDestinationCell(null);
  closeOrderPanel();
  restoreAnalysisControls();
  mappingLoadGeneration += 1;
  restoreMappingControls();
  roundGeneration += 1;
  compositionPlaybackGeneration += 1;
  mappingPlaybackGeneration += 1;
  compositionQuestionReady = false;
  compositionPlaybackMode = "operation1";
  el("puzzle-composition-playback").hidden = true;
  syncOperandButtons();
  el("puzzle-slider").disabled = false;
  closePuzzleStructureInfo();
  el("puzzle-structure-details").hidden = true;
  el("puzzle-structure-info").hidden = true;
  el("puzzle-atom-coordinate").hidden = true;
  coordinateSelection.clear();
  coordinateAtom = null;
  coordinateInverse = null;
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
  clearPuzzleLoading();
  invalidatePuzzleWork();
  el("puzzle-quiz-select").hidden = false;
  el("puzzle-point-group-kind").hidden = true;
  el("puzzle-point-group-difficulty").hidden = true;
  el("puzzle-picker").hidden = true;
  el("puzzle-play").hidden = true;
  el("puzzle-back").hidden = false;
  updateModeTitle();
}





function showPointGroupKind() {
  clearPuzzleLoading();
  invalidatePuzzleWork();
  setPointGroupLoading(false);
  el("puzzle-quiz-select").hidden = true;
  el("puzzle-point-group-kind").hidden = false;
  el("puzzle-point-group-difficulty").hidden = true;
  el("puzzle-picker").hidden = true;
  el("puzzle-play").hidden = true;
  el("puzzle-back").hidden = false;
  updateModeTitle();
}



function setPointGroupLoading(busy, message = "") {
  for (const card of document.querySelectorAll("[data-point-group-difficulty]")) card.disabled = busy;
  el("puzzle-point-group-load-status").hidden = !message;
  el("puzzle-point-group-load-status").textContent = message;
}

function showPointGroupDifficulty() {
  clearPuzzleLoading();
  invalidatePuzzleWork();
  setPointGroupLoading(false);
  for (const card of document.querySelectorAll("[data-point-group-difficulty]")) {
    card.hidden = !eligibleExamples("crystal", card.dataset.pointGroupDifficulty).length;
  }
  el("puzzle-quiz-select").hidden = true;
  el("puzzle-point-group-kind").hidden = true;
  el("puzzle-point-group-difficulty").hidden = false;
  el("puzzle-picker").hidden = true;
  el("puzzle-play").hidden = true;
  el("puzzle-back").hidden = false;
  updateModeTitle();
}

function pointGroupLoadError(error) {
  if (error.obsolete) return;
  if (!el("puzzle-point-group-difficulty").hidden) setPointGroupLoading(false, "読み込めませんでした。もう一度選んでください。");
  else showError(error);
}

function showPicker() {
  clearPuzzleLoading();
  // Browsing another example suspends the current question. Replace it only
  // after a new model is ready, so a failed load leaves an answerable round.
  if (currentQuestion) cancelReveal();
  else invalidatePuzzleWork();
  el("puzzle-quiz-select").hidden = true;
  el("puzzle-point-group-kind").hidden = true;
  el("puzzle-point-group-difficulty").hidden = true;
  el("puzzle-picker").hidden = false;
  el("puzzle-play").hidden = true;
  el("puzzle-back").hidden = false;
  updateModeTitle();
}

// The top bar names the current quiz; during play it also names the difficulty.
const QUIZ_TITLES = {operation: "操作あてクイズ", composition: "合成クイズ", mapping: "移り先クイズ",
  point_group: "点群あてクイズ", axis: "回転軸クイズ"};

function playDifficulty() {
  if (currentQuiz === "composition") return currentCompositionDifficulty;
  if (currentSourceKind !== "crystal") return null;
  if (currentQuiz === "operation") return currentOperationDifficulty;
  if (currentQuiz === "mapping") return currentMappingDifficulty;
  if (currentQuiz === "point_group") return currentPointGroupDifficulty;
  return null;
}

function updateModeTitle({ play = false } = {}) {
  const title = el("puzzle-mode-title");
  if (!title) return;
  const quiz = QUIZ_TITLES[currentQuiz];
  if (!quiz || !el("puzzle-quiz-select").hidden) {
    title.textContent = "クイズモード";
    return;
  }
  const difficulty = play ? playDifficulty() : null;
  title.textContent = difficulty ? `${quiz}・${difficulty === "hard" ? "Hard" : "Normal"}` : quiz;
}


function showPlay() {
  el("puzzle-quiz-select").hidden = true;
  el("puzzle-point-group-kind").hidden = true;
  el("puzzle-point-group-difficulty").hidden = true;
  el("puzzle-picker").hidden = true;
  el("puzzle-play").hidden = false;
  syncPuzzleSpeedControls();
  // Every screen keeps a single 戻る visible (see goBack()) so there is always
  // exactly one way back to wherever the player came from, never zero and
  // never two competing buttons with different targets (2026-09-09 follow-up).
  el("puzzle-back").hidden = false;
  updateModeTitle({play: true});
}

// Which screen led into the round currently showing on #puzzle-play, so
// goBack() can undo exactly that one step. Fixed by currentQuiz/currentSourceKind
// rather than a general navigation stack: the puzzle flow's shape is small and
// static (quiz-select is the only screen with more than one possible child), so
// hardcoding each screen's single parent is simpler than a generic history stack
// and just as correct.
function playParentScreen() {
  if (currentQuiz === "point_group") return currentKind === "crystal" ? "pointGroupDifficulty" : "pointGroupKind";
  // Other quizzes pick Normal/Hard on the structure picker itself.
  return "picker";
}

// The single 戻る button's handler: undo exactly one step, to whichever screen
// led into the one currently showing. This replaces two earlier buttons that
// could show at once with conflicting targets (#puzzle-back, which always
// jumped straight to the hub, and #puzzle-picker-back, which stepped back to
// quiz-select only) — see docs/archive/sessions/SESSION_REPORT_2026-09-09.md.
function goBack() {
  if (!el("puzzle-play").hidden) {
    const parent = playParentScreen();
    if (parent === "pointGroupDifficulty") return showPointGroupDifficulty();
    if (parent === "pointGroupKind") return showPointGroupKind();
    return showPicker();
  }
  if (!el("puzzle-point-group-difficulty").hidden) return showPointGroupKind();
  if (!el("puzzle-picker").hidden || !el("puzzle-point-group-kind").hidden) return showQuizSelect();
  window.setAppMode("select"); // already on quiz-select: one more step back is the hub
}

async function getJson(url, options) {
  return withPuzzleLoading(() => getJsonReady(url, options));
}

async function getJsonReady(url, options) {
  if (currentQuiz !== "axis" && quizClient) {
    const path = new URL(url, location.href).pathname;
    const endpoint = path === "/api/open_example" ? "open_example"
      : /^\/api\/puzzle\/(mapping|operations|composition|point_group)$/.test(path) ? "questions"
      : /^\/api\/puzzle\/(mapping|operations|composition|point_group)\/check$/.test(path) ? "check" : null;
    if (endpoint) return (await quizClient.viewFetch("/api/"+endpoint, options)).json();
  }
  if (document.querySelector('meta[name="model-view"]')?.content === "api2") url = url.replace(/^\/api\//, "/api/quiz/");
  const response = await fetch(url, options);
  if (!response.ok) throw new Error((await response.text()) || `${response.status} ${response.statusText}`);
  return response.json();
}

const STRUCTURE_KINDS = [
  { kind: "molecule", label: "分子" },
  { kind: "crystal", label: "結晶" },
];

async function buildPicker() {
  return withPuzzleLoading(() => buildPickerReady());
}

async function buildPickerReady() {
  if (!catalog) catalog = await getJson("/api/examples");
  const root = el("puzzle-picker");
  root.innerHTML = "";
  // Offer kinds with eligible candidates; composition and crystal mapping
  // establish their actual difficulty availability on the selected model.
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
  // A kind with no Hard question (molecules in 操作あて・移り先) shows no
  // toggle and plays Normal; the chosen level is kept for the other kind.
  const chosenLevel = pickerDifficulty();
  const showToggle = Boolean(chosenLevel) && eligibleExamples(currentKind).some(example => isAvailable(example, "hard"));
  const level = chosenLevel && !showToggle ? "normal" : chosenLevel;
  if (showToggle) {
    const toggle = document.createElement("div");
    toggle.className = "puzzle-difficulty-toggle";
    toggle.setAttribute("role", "group");
    toggle.setAttribute("aria-label", "難度");
    const description = document.createElement("span");
    description.className = "puzzle-difficulty-desc";
    description.textContent = DIFFICULTY_NOTES[currentQuiz]?.[level] || "";
    kindRow.appendChild(description);
    for (const [value, text] of [["normal", "Normal"], ["hard", "Hard"]]) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.pickerDifficulty = value;
      button.textContent = text;
      button.setAttribute("aria-pressed", String(level === value));
      button.addEventListener("click", () => {
        if (pickerDifficulty() === value) return;
        setPickerDifficulty(value);
        buildPicker();
      });
      toggle.appendChild(button);
    }
    kindRow.appendChild(toggle);
  }
  root.appendChild(kindRow);

  const heading = document.createElement("h2");
  heading.className = "puzzle-picker-title";
  heading.textContent = currentKind === "crystal" ? "結晶を選んでください" : "分子を選んでください";
  root.appendChild(heading);
  const list = document.createElement("div");
  list.className = "puzzle-picker-list";
  // The buttons show formulae, so list them in formula order (then by name).
  const formulaKey = example => example.display_formula || example.formula || example.name;
  const examples = [...eligibleExamples(currentKind)].sort((a, b) =>
    formulaKey(a).localeCompare(formulaKey(b), "en", {numeric: true}) || a.name.localeCompare(b.name, "en"));
  if (level && examples.length && !examples.some(example => isAvailable(example, level))) {
    const note = document.createElement("p");
    note.className = "puzzle-picker-note";
    note.textContent = `${currentKind === "crystal" ? "結晶" : "分子"}には${level === "hard" ? "Hard" : "Normal"}の問題がありません。`;
    root.appendChild(note);
  }
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
    if (level && !isAvailable(example, level)) {
      button.disabled = true;
      button.title = `${level === "hard" ? "Hard" : "Normal"}の問題はありません`;
    }
    button.addEventListener("click", () => {
      // The picker's Normal/Hard toggle decides the difficulty directly.
      startStructure(example, label + suffix, level || "normal").catch(showError);
    });
    list.appendChild(button);
  }
  root.appendChild(list);
}

async function buildPointGroupKindScreen() {
  return withPuzzleLoading(() => buildPointGroupKindScreenReady());
}

async function buildPointGroupKindScreenReady() {
  if (!catalog) catalog = await getJson("/api/examples");
  for (const button of document.querySelectorAll("[data-point-group-kind]")) {
    const kind = button.dataset.pointGroupKind;
    button.hidden = !eligibleExamples(kind, "normal").length && !eligibleExamples(kind, "hard").length;
  }
}

async function startRandomPointGroupStructure(kind) {
  return withPuzzleLoading(() => startRandomPointGroupStructureReady(kind));
}

async function startRandomPointGroupStructureReady(kind) {
  const load = ++pointGroupLoadGeneration;
  if (!catalog) catalog = await getJson("/api/examples");
  if (load !== pointGroupLoadGeneration) return;
  currentKind = kind;
  const examples = eligibleExamples(kind);
  if (!examples.length) throw new Error("この種類には出題できる構造がありません。");
  if (currentPointGroupDifficulty !== "hard") {
    const example = examples[Math.floor(Math.random() * examples.length)];
    await startStructure(example, pointGroupRevealLabel(example, kind));
    return;
  }
  const remaining = [...examples];
  setPointGroupLoading(true);
  try {
    while (remaining.length && load === pointGroupLoadGeneration) {
      const index = Math.floor(Math.random() * remaining.length);
      const [example] = remaining.splice(index, 1);
      const result = await startStructure(example, pointGroupRevealLabel(example, kind));
      if (result !== false) return;
    }
    if (load === pointGroupLoadGeneration) throw new Error("点群Hardを出題できる構造がありません。");
  } finally {
    // Successful loading invalidates the picker generation. Cards are reset
    // whenever their screen is entered again; a newer load owns its controls.
    if (load === pointGroupLoadGeneration) setPointGroupLoading(false);
  }
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
  syncLegendVisibility();
}

function syncLegendVisibility() {
  const visible = el("puzzle-legend-visible").checked;
  el("puzzle-legend").hidden = !visible;
  el("puzzle-legend-toggle").title = visible ? "凡例と座標軸を非表示" : "凡例と座標軸を表示";
  view.showCoordinateAxes = visible;
  view.syncCellAxisGuideVisibility();
  view.renderCellAxisGuide();
}

function showError(error) {
  if (error.obsolete) return;
  const result = el("puzzle-result");
  result.hidden = false;
  result.className = "puzzle-result miss";
  // A dropped connection reads as a load failure, not a raw browser message.
  result.textContent = error instanceof TypeError && /fetch|network/i.test(String(error.message))
    ? "読み込めませんでした。もう一度選んでください。" : `エラー: ${error.message || error}`;
}

// The "please choose" prompts go away as soon as the player chooses something.
// Phones (same condition as the phone layouts) say タップ instead of クリック.
const PHONE_LAYOUT_QUERY = window.matchMedia(
  "(max-width: 560px), (max-width: 980px) and (max-height: 560px) and (pointer: coarse)");
const pickAtomPrompt = () => `移り先の原子を${PHONE_LAYOUT_QUERY.matches ? "タップ" : "クリック"}してください。`;
const SELECTION_PROMPTS = new Set(["操作の種類を選んでください。", "次数を選んでください。", "並進も選んでください。",
  "点群を1つ選んでください。", "移り先の原子をクリックしてください。", "移り先の原子をタップしてください。"]);

function clearSelectionPrompt() {
  const result = el("puzzle-result");
  if (!result.hidden && SELECTION_PROMPTS.has(result.textContent)) result.hidden = true;
}

function showPrompt(message) {
  const result = el("puzzle-result");
  result.hidden = false;
  // A failed send is an error (red box); everything else is a plain prompt.
  result.className = `puzzle-result ${message.startsWith("回答を送信できませんでした") ? "miss" : "prompt"}`;
  result.textContent = message;
}

async function startStructure(example, label = displayLabel(example), requestedDifficulty = roundDifficulty()) {
  return withPuzzleLoading(() => startStructureReady(example, label, requestedDifficulty));
}

async function startStructureReady(example, label = displayLabel(example), requestedDifficulty = roundDifficulty()) {
  let mappingPrepared = false;
  if (currentQuiz !== "axis" && quizClient) {
    const quiz = currentQuiz;
    const difficulty = quiz === "point_group" ? currentPointGroupDifficulty : requestedDifficulty;
    const before = roundGeneration;
    const compositionChoice = compositionChoiceGeneration;
    const mappingChoice = mappingChoiceGeneration;
    const loadGeneration = ++mappingLoadGeneration;
    if (!mappingLoadControls) mappingLoadControls = [...el("puzzle-play").querySelectorAll("button, input, select")]
      .map(control => [control, control.disabled]);
    mappingLoadControls.forEach(([control]) => {control.disabled = true;});
    try {
      await (await quizClient.viewFetch("/api/open_example", {method: "POST",
        body: JSON.stringify({kind: example.kind, path: example.path, quiz_type: quiz, difficulty})})).json();
    } catch (error) {
      if (quiz === "composition" && compositionChoice !== compositionChoiceGeneration
          || quiz === "mapping" && mappingChoice !== mappingChoiceGeneration) {
        error.obsolete = true;
        throw error;
      }
      if (quiz === "point_group" && difficulty === "hard" && error.message === "no_hard_point_group_question") return false;
      if (before === roundGeneration && loadGeneration === mappingLoadGeneration) {
        showPlay();
        if (!currentQuestion) {
          el("puzzle-question").textContent = "構造を読み込めませんでした。別の物質を選んでください。";
          el("puzzle-options").innerHTML = "";
          for (const id of ["puzzle-check", "puzzle-again", "puzzle-playback", "puzzle-open-analysis"])
            el(id).hidden = true;
        }
      }
      throw error;
    } finally {
      if (before === roundGeneration && loadGeneration === mappingLoadGeneration) restoreMappingControls();
    }
    if (before !== roundGeneration || currentQuiz !== quiz || loadGeneration !== mappingLoadGeneration
        || quiz === "composition" && compositionChoice !== compositionChoiceGeneration
        || quiz === "mapping" && mappingChoice !== mappingChoiceGeneration) return;
    mappingPrepared = true;
  }
  const generation = invalidatePuzzleWork();
  // Only a successful load changes the round's difficulty.
  if (currentQuiz === "operation") currentOperationDifficulty = requestedDifficulty;
  if (currentQuiz === "composition") currentCompositionDifficulty = requestedDifficulty;
  if (currentQuiz === "mapping") currentMappingDifficulty = requestedDifficulty;
  puzzleInitialCamera = null;
  puzzleShowPeriodicNeighbors = false;
  el("puzzle-periodic-neighbors").checked = false;
  view.rangeHighlightEnabled = false;
  view.setModelClient(currentQuiz !== "axis" ? quizClient : null);
  showPlay();
  // Point-group questions must stay anonymous; the other quizzes show a name/formula.
  pointGroupStructureLabel = label;
  el("puzzle-structure-title").innerHTML = currentQuiz === "point_group" ? "" : label;
  el("puzzle-question").textContent = "";
  el("puzzle-options").innerHTML = "";
  el("puzzle-result").hidden = true;
  el("puzzle-check").hidden = false;
  el("puzzle-check").disabled = true;
  el("puzzle-again").hidden = true;
  el("puzzle-open-analysis").hidden = true;
  el("puzzle-analysis-error").hidden = true;
  el("puzzle-playback").hidden = true;
  setStageCaption("");
  if (!mappingPrepared) await getJson("/api/open_example", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: example.kind, path: example.path, request_id: Date.now() }),
  });
  if (generation !== roundGeneration) return;
  currentExample = {...example};
  // Render with the shared analysis-mode view (atoms + unit cell + fitted camera).
  // Crystals default to showing the periodic boundary atoms — a bare unit cell
  // can look incomplete or cut off — while molecules have no periodic images
  // at all, so the flag is moot for them either way. The camera overlay's
  // toggle (below) still lets the player turn it off per structure.
  puzzleShowBoundaryImages = example.kind === "crystal";
  view.showAnimationTargets = example.kind === "crystal";
  view.showAnimationTargetCopies = false;
  view.showTrajectories = false;
  // Nothing moves in the point-group quiz, so the moving-copy option has no use there.
  el("puzzle-target-copies-toggle").hidden = example.kind !== "crystal" || currentQuiz === "point_group";
  el("puzzle-boundary-images-toggle").hidden = example.kind !== "crystal";
  el("puzzle-trajectories-toggle").hidden = true;
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
      ? `/api/puzzle/axis_orders${example.kind === "crystal" ? "?display_mode=source&cell_origin_mode=center" : ""}`
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
  if (!el("puzzle-play").hidden) updateModeTitle({play: true});
  syncPuzzleSpeedControls();
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
  await beginRound();
  return true;
}

function pickQuestion(previousQuestion = null) {
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
    // Composition: do not repeat what the player just saw (same two operation
    // names and the same answer bucket), unless nothing else is available.
    let pool = questions;
    if (currentQuiz === "composition" && questions.includes(previousQuestion)) {
      const key = q => JSON.stringify([q.operation_a?.kind, q.operation_a?.order,
        q.operation_b?.kind, q.operation_b?.order, q.group ?? q.id]);
      const previous = key(previousQuestion);
      const others = questions.filter(question => key(question) !== previous);
      if (others.length) pool = others;
    }
    const groups = new Map();
    for (const question of pool) {
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

async function beginRound() {
  return withPuzzleLoading(() => beginRoundReady());
}

async function beginRoundReady() {
  // Cleanup forgets the current question, so keep it for pickQuestion.
  const previousQuestion = currentQuestion;
  invalidatePuzzleWork();
  currentQuestion = pickQuestion(previousQuestion);
  revealOperation = null;
  view.showTrajectories = false;
  view.updateTrajectoryLines();
  view.updateAnimationTargetMarkers();
  mappingGuess = null;
  mappingGuessPosition = null;
  mappingRevealTarget = null;
  mappingAnswerCorrect = false;
  mappingTargetPosition = null;
  const result = el("puzzle-result");
  result.hidden = true;
  el("puzzle-options").innerHTML = "";
  el("puzzle-check").hidden = false;
  el("puzzle-check").disabled = false;
  el("puzzle-again").hidden = true;
  el("puzzle-again").textContent = currentQuiz === "axis" ? "もう一度" : "もう一問";
  el("puzzle-open-analysis").hidden = true;
  el("puzzle-analysis-error").hidden = true;
  el("puzzle-slider").value = "0";
  el("puzzle-slider").hidden = false;
  setPuzzleSliderBreakpoints([]);
  el("puzzle-replay").disabled = false;
  el("puzzle-trajectories-toggle").hidden = true;
  setStageCaption("");
  hidePuzzleGifButton();
  syncTrajectoriesButton();
  const generation = roundGeneration;
  if (quizClient && view.modelClient === quizClient) {
    for (const role of ["operation1", "operation2"]) el(`puzzle-${role}`).disabled = true;
    el("puzzle-check").disabled = true;
    el("puzzle-replay").disabled = true;
    el("puzzle-slider").disabled = true;
    await (await quizClient.viewFetch("/api/select_question", {method: "POST",
      body: JSON.stringify({question_id: currentQuestion.id})})).json();
    if (generation !== roundGeneration) return;
    view.state = {...quizClient.currentModelViewState()};
    el("puzzle-check").disabled = false;
    el("puzzle-replay").disabled = false;
    el("puzzle-slider").disabled = false;
  }
  if (currentQuiz === "operation" || currentQuiz === "composition") installCoordinateInspection();
  let preparation;
  if (currentQuiz === "axis") beginAxisRound();
  else if (currentQuiz === "composition") preparation = beginCompositionRound();
  else if (currentQuiz === "mapping") preparation = beginMappingRound();
  else if (currentQuiz === "point_group") beginPointGroupRound();
  else preparation = beginOperationRound();
  if (!puzzleInitialCamera) {
    puzzleInitialCamera = {
      position: view.activeCamera.position.clone(), up: view.activeCamera.up.clone(),
      target: view.controls.target.clone(), zoom: view.activeCamera.zoom,
      span: view.orthographicSpan,
    };
  }
  await preparation;
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

function coordinateKey(atom) {
  return JSON.stringify([atom.sourceAtom, atom.start]);
}

function refreshAtomCoordinates() {
  const output = el("puzzle-atom-coordinate");
  const atoms = [...view.atomInstances.entries()].filter(([, atom]) => coordinateSelection.has(coordinateKey(atom)));
  // Removed boundary images must not leave stale coordinates or return selected.
  coordinateSelection.clear();
  for (const [, atom] of atoms) coordinateSelection.add(coordinateKey(atom));
  output.hidden = atoms.length === 0;
  el("puzzle-structure-info").hidden = atoms.length === 0;
  const crystal = currentSourceKind === "crystal";
  coordinateAtom = atoms[0]?.[1] || null;
  coordinateInverse = crystal && coordinateAtom ? view.symmetryCellBasis().invert() : null;
  output.replaceChildren();
  if (coordinateAtom) {
    output.dataset.instanceId = String(atoms[0][0]);
    const row = document.createElement("p");
    row.className = "puzzle-coordinate-line";
    const element = document.createElement("span");
    element.textContent = `${coordinateAtom.element} `;
    const values = document.createElement("span");
    values.className = "puzzle-coordinate-values";
    for (const axis of ["x", "y", "z"]) {
      const value = document.createElement("span");
      value.dataset.axis = axis;
      values.append(value);
    }
    row.append(element, values);
    if (!crystal) row.append(" Å");
    output.append(row);
    updateAtomCoordinates();
  } else delete output.dataset.instanceId;
  // Mapping owns its answer rings; inspection must not replace them.
  if (currentQuiz !== "mapping") {
    view.setPickMarkers(atoms.map(([instanceId]) => ({instanceId, style: "selection"})));
  } else if (currentQuestion) {
    refreshMappingMarkers({revealTarget: mappingRevealTarget});
  }
}

function updateAtomCoordinates() {
  if (!coordinateAtom) return;
  const point = new Vector3(...coordinateAtom.current);
  if (coordinateInverse) point.applyMatrix4(coordinateInverse);
  const values = point.toArray();
  for (const [index, axis] of ["x", "y", "z"].entries()) {
    const cell = el("puzzle-atom-coordinate").querySelector(`[data-axis="${axis}"]`);
    if (!cell) return;
    const number = textNumber(values[index]);
    const text = `${index === 0 ? "(" : ""}${number}${index === 2 ? ")" : ", "}`;
    if (cell.textContent !== text) cell.textContent = text;
  }
}

window.addEventListener("symmetry-animation-progress-update", () => {
  if (document.body.classList.contains("in-puzzle")) updateAtomCoordinates();
});

function selectCoordinateAtom(atom) {
  coordinateSelection.clear();
  if (atom) coordinateSelection.add(coordinateKey(atom));
  refreshAtomCoordinates();
}

function installCoordinateInspection() {
  view.onAtomPick = (_atomIndex, instance, event) => selectCoordinateAtom(instance, event);
  refreshAtomCoordinates();
}

function showPointGroupStructureInfo() {
  el("puzzle-periodic-neighbors-toggle").hidden = !(currentSourceKind === "crystal" && currentPointGroupDifficulty === "hard");
  el("puzzle-structure-details").hidden = currentSourceKind !== "crystal";
  installCoordinateInspection();
}

// Read only the quiz view's current render data. Never use analysis state or
// render its metadata wholesale: names and symmetry labels would reveal answers.
function closePuzzleStructureInfo() {
  const dialog = el("puzzle-structure-dialog");
  if (dialog.open) dialog.close();
  el("puzzle-structure-lattice").replaceChildren();
  el("puzzle-structure-atoms").replaceChildren();
}

function openPuzzleStructureInfo() {
  if (currentQuiz !== "point_group" || currentSourceKind !== "crystal" || !currentQuestion) return;
  const data = view.renderData;
  const metadata = data.metadata || {};
  const lattice = metadata.display_lattice_parameters || metadata.lattice_parameters;
  const dimensions = el("puzzle-structure-lattice");
  dimensions.replaceChildren();
  for (const items of [
    [["a", "a", " Å"], ["b", "b", " Å"], ["c", "c", " Å"]],
    [["α", "alpha", "°"], ["β", "beta", "°"], ["γ", "gamma", "°"]],
  ]) {
    const row = document.createElement("div");
    row.className = "structure-lattice-row";
    for (const [label, key, unit] of items) {
      const item = document.createElement("div");
      item.className = "structure-lattice-item";
      const term = document.createElement("span");
      term.textContent = label;
      const value = document.createElement("span");
      value.textContent = lattice ? `${compositionMatrixNumber(lattice[key])}${unit}` : "—";
      item.append(term, value);
      row.append(item);
    }
    dimensions.append(row);
  }
  const atoms = data.atoms || [];
  el("puzzle-atoms-title").textContent = `原子 (${atoms.length})`;
  const list = el("puzzle-structure-atoms");
  list.replaceChildren();
  for (const atom of atoms) {
    const row = document.createElement("div");
    row.className = "structure-atom-row";
    row.dataset.atomIndex = atom.index;
    const name = document.createElement("strong");
    name.textContent = `${atom.element} ${atom.index}`;
    const coordinates = document.createElement("div");
    coordinates.className = "structure-atom-coordinates";
    coordinates.textContent = `(${atom.frac.map(compositionMatrixNumber).join(", ")})`;
    row.append(name, coordinates);
    list.append(row);
  }
  el("puzzle-structure-dialog").showModal();
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
  let result;
  try {
    result = await getJson("/api/puzzle/point_group/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question_id: currentQuestion.id, selected }),
    });
  } catch (error) {
    if (generation === roundGeneration && !error.obsolete) {
      el("puzzle-check").disabled = false;
      showPrompt("回答を送信できませんでした。もう一度押してください。");
    }
    return;
  }
  if (generation !== roundGeneration) return;
  const box = el("puzzle-result");
  box.hidden = false;
  box.className = `puzzle-result ${result.correct ? "hit" : "miss"}`;
  const verdict = result.correct ? "正解" : `不正解（答え：${formatPointGroupSymbol(result.answer)}）`;
  const explanation = result.explanation ? `<div class="puzzle-explanation">${escapeHtml(result.explanation)}</div>` : "";
  box.innerHTML = `${verdict}${explanation}`;
  // The name would have given the answer away; once answered, show it.
  el("puzzle-structure-title").innerHTML = pointGroupStructureLabel;
  pointGroupAnalysisIndex = Number.isInteger(result.analysis_operation_index) ? result.analysis_operation_index : null;
  el("puzzle-again").hidden = true;
  el("puzzle-open-analysis").hidden = false;
}

// Analysis prepares its own verified model from the same recorded input;
// quiz IDs and question state remain independent of the analysis model.
async function openCurrentStructureInAnalysis() {
  return withPuzzleLoading(() => openCurrentStructureInAnalysisReady());
}

async function openCurrentStructureInAnalysisReady() {
  if (!currentQuestion || !currentExample || analysisLoadControls) return;
  const button = el("puzzle-open-analysis");
  const generation = roundGeneration;
  const question = currentQuestion;
  const isCurrent = () => generation === roundGeneration && question === currentQuestion;
  cancelReveal();
  await Promise.resolve();
  const controls = [...el("puzzle-play").querySelectorAll("button, input, select"), el("puzzle-back")]
    .map(control => [control, control.disabled]);
  analysisLoadControls = controls;
  for (const [control] of controls) control.disabled = true;
  button.disabled = true;
  el("puzzle-analysis-error").hidden = true;
  try {
    if (modelViewEnabled) {
      const indices = currentQuiz === "composition"
        ? [question.operation_index_a, question.operation_index_b]
        : currentQuiz === "point_group" ? (pointGroupAnalysisIndex == null ? [] : [pointGroupAnalysisIndex]) : [question.operation_index];
      const model = view.modelClient.modelBoundary.active;
      const hardComposition = currentQuiz === "composition" && currentCompositionDifficulty === "hard";
      await window.openQuizInAnalysis({example: {...currentExample}, quiz: currentQuiz,
        operations: (hardComposition ? [compositionAnswer.product_index] : indices)
          .map(index => model.operations.find(op => op.operation_index === index)),
        customInputs: hardComposition ? compositionAnswer.analysis_sequence : null,
        customTransforms: hardComposition ? compositionAnswer.operand_transforms : null,
        sourceAtom: currentQuiz === "mapping" ? question.source_atom_index : null, isCurrent});
    } else if (isCurrent()) {
      window.setAppMode("analysis", {fromPuzzle: true});
    }
  } catch (error) {
    if (isCurrent() && !error.obsolete) {
      el("puzzle-analysis-error").textContent = "解析を開けませんでした";
      el("puzzle-analysis-error").hidden = false;
    }
  } finally {
    if (analysisLoadControls === controls) restoreAnalysisControls();
  }
}

function beginOperationRound() {
  el("puzzle-question").textContent = "どの対称操作ですか？";
  renderOperationOptions();
  // Prepare the question at rest; playback starts only on user input.
  revealOperation = currentQuestion.operation_index;
  el("puzzle-playback").hidden = false;
  return playReveal(false).catch(showError);
}

function closeOrderPanel(restoreFocus = false) {
  if (!openOrderPanel) return;
  const {panel, trigger} = openOrderPanel;
  openOrderPanel = null;
  panel.hidden = true;
  trigger.setAttribute("aria-expanded", "false");
  if (restoreFocus && trigger.isConnected) trigger.focus({preventScroll: true});
}

function renderOperationOptions() {
  closeOrderPanel();
  const root = el("puzzle-options");
  delete root.dataset.operationKind;
  delete root.dataset.operationOrder;
  const kinds = operationKinds();
  const kindRow = document.createElement("div");
  kindRow.className = "puzzle-op-group";
  const shiftRow = document.createElement("div");
  shiftRow.className = "puzzle-op-group puzzle-op-order";
  shiftRow.hidden = true;
  const triggers = new Map();

  function syncChoices() {
    const kind = root.dataset.operationKind;
    const order = root.dataset.operationOrder;
    for (const config of kinds) {
      const trigger = triggers.get(config.kind);
      const selected = kind === config.kind;
      const improper = ["rotoreflection", "rotoinversion"].includes(config.kind);
      const text = selected && order && config.orders
        ? improper ? improperOperationLabel(config.kind, order)
          : formatOperationAnswer(config.kind, order === INFINITE ? "∞" : order) : escapeHtml(config.label);
      trigger.innerHTML = text + (config.orders ? " ▾" : "");
      trigger.setAttribute("aria-pressed", String(selected));
    }
    shiftRow.hidden = !(kind === "screw" || kind === "glide");
  }
  function choose(kind, order = null) {
    if (root.dataset.operationKind !== kind || order !== null) {
      root.dataset.operationKind = kind;
      delete root.dataset.operationOrder;
      if (order !== null) root.dataset.operationOrder = String(order);
    }
    syncChoices();
    clearSelectionPrompt();
  }

  for (const config of kinds) {
    const {kind, label, orders} = config;
    const item = document.createElement("div");
    item.className = "puzzle-operation-choice";
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "puzzle-option puzzle-operation-trigger";
    trigger.dataset.operationKind = kind;
    trigger.setAttribute("aria-pressed", "false");
    triggers.set(kind, trigger);
    item.appendChild(trigger);
    if (orders) {
      const panel = document.createElement("div");
      panel.className = "puzzle-order-menu";
      panel.id = `puzzle-order-${kind}`;
      panel.hidden = true;
      panel.setAttribute("role", "menu");
      panel.setAttribute("aria-label", `${label}の次数`);
      trigger.setAttribute("aria-haspopup", "menu");
      trigger.setAttribute("aria-expanded", "false");
      trigger.setAttribute("aria-controls", panel.id);
      for (const order of orders) {
        const option = document.createElement("button");
        option.type = "button";
        option.className = "secondary";
        option.dataset.order = String(order);
        if (["rotoreflection", "rotoinversion"].includes(kind)) {
          option.innerHTML = improperOperationLabel(kind, order, true);
        } else option.textContent = order === INFINITE ? "∞" : String(order);
        option.setAttribute("role", "menuitemradio");
        option.addEventListener("click", () => {
          choose(kind, order);
          closeOrderPanel(true);
        });
        panel.appendChild(option);
      }
      trigger.addEventListener("click", () => {
        if (openOrderPanel?.panel === panel) return closeOrderPanel();
        closeOrderPanel();
        choose(kind);
        panel.hidden = false;
        trigger.setAttribute("aria-expanded", "true");
        openOrderPanel = {panel, trigger};
        const rect = trigger.getBoundingClientRect();
        const width = panel.offsetWidth, height = panel.offsetHeight;
        panel.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`;
        // Above the button, over the already-read question, so the answer and
        // translation rows stay visible; below only when there is no room.
        panel.style.top = `${rect.top - height - 6 >= 12
          ? rect.top - height - 6 : Math.min(rect.bottom + 6, window.innerHeight - height - 12)}px`;
        const options = [...panel.querySelectorAll("button")];
        for (const option of options) {
          const selected = option.dataset.order === root.dataset.operationOrder;
          option.setAttribute("aria-checked", String(selected));
          option.tabIndex = selected ? 0 : -1;
        }
        (options.find(option => option.tabIndex === 0) || options[0]).focus({preventScroll: true});
      });
      item.appendChild(panel);
    } else {
      trigger.addEventListener("click", () => { closeOrderPanel(); choose(kind); });
    }
    kindRow.appendChild(item);
  }
  root.appendChild(kindRow);
  if (currentOperationDifficulty === "hard") {
    shiftRow.innerHTML = `<span class="puzzle-op-label">並進</span>`;
    for (const shift of SHIFT_OPTIONS) {
      const item = document.createElement("label");
      item.className = "puzzle-option";
      item.innerHTML = `<input type="radio" name="op-shift" value="${shift}"><span>${shift}</span>`;
      shiftRow.appendChild(item);
    }
    root.appendChild(shiftRow);
  }
  syncChoices();
}

// --- Composition quiz ("A then B" -> which single operation?) ---

function setStageCaption(text) {
  const caption = el("puzzle-stage-caption");
  if (caption) {
    const value = currentQuiz === "composition" && operationAnswered ? "" : text || "";
    caption.textContent = value;
    caption.hidden = !value;
  }
}

function compositionStageLabel(stage, answer) {
  return stage;
}

function beginCompositionRound() {
  // The product is always a point operation, so answer with the normal vocabulary.
  currentOperationDifficulty = "normal";
  el("puzzle-question").textContent =
    "操作1→操作2を1回で行うと、どの対称操作になりますか？";
  renderOperationOptions();
  // Before answering, the slider scrubs the continuous A/B path. After checking
  // it scrubs the product. Dragging it stops playback and hands control to
  // the player without skipping either operation's contribution.
  el("puzzle-playback").hidden = false;
  el("puzzle-check").disabled = true;
  hidePuzzleGifButton();
  setPuzzleSliderBreakpoints([0.5]);
  syncOperandButtons();
  return playCompositionOperand("operation1", false).catch(showError);
}

async function playSingleOperation(operationIndex, generation, caption, isCurrent = null) {
  const stillCurrent = isCurrent || (() => generation === roundGeneration);
  if (!stillCurrent()) return false;
  view.setAnimationSourceAtoms(null);
  setStageCaption(caption);
  const pathGeneration = ++view.pathGeneration;
  await view.loadAnimationPaths(
    Number(operationIndex),
    pathGeneration,
    "displayed",
  );
  if (!stillCurrent()) return false;
  await view.loadSymmetryElements(Number(operationIndex), pathGeneration);
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
    operationIndex == null ? null : Number(operationIndex),
    generation,
    "displayed",
  );
  if (generation !== view.pathGeneration) return null;
  return {
    paths: view.animationPaths,
    breakpoints: view.animationBreakpoints,
    maxTravel: view.maximumTravelDistance,
    durationSeconds: view.baseAnimationDurationSeconds,
    operationIndex: view.animationOperationIndex,
  };
}

function activateCompositionSnapshot(snapshot) {
  view.animationPaths = snapshot.paths;
  view.animationBreakpoints = snapshot.breakpoints;
  view.maximumTravelDistance = snapshot.maxTravel;
  view.baseAnimationDurationSeconds = snapshot.durationSeconds;
  view.animationOperationIndex = snapshot.operationIndex;
  // The verified sequence already carries each whole operation's elements.
  // Use the same stage renderer as analysis Custom, only after answering.
  const path = snapshot.paths.values().next().value;
  if (operationAnswered && path?.type === "model_plan") {
    view.customRepresentativePath = path;
    view.customSegmentElements = path.segment_elements || [];
    view.customSegmentBoundaries = path.model_segment_boundaries || [];
    view.customSegmentIndex = null;
  }
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
  const boundary = snapshot.paths.values().next().value?.model_segment_boundaries?.[0];
  const progress = boundary === undefined ? clamped : clamped <= 0.5
    ? clamped * 2 * boundary : boundary + (clamped - 0.5) * 2 * (1-boundary);
  view.setAnimationProgress(progress);
}

// Inverse of the slider's half-for-A / half-for-B presentation mapping.
// Playback itself always advances along the unmodified schedule time.
function compositionSliderFraction(progress) {
  const boundary = compositionSnapshot?.paths.values().next().value?.model_segment_boundaries?.[0] ?? 0.5;
  if (progress <= 0) return 0;
  if (progress >= 1) return 1;
  return progress <= boundary ? progress / boundary / 2
    : 0.5 + (progress - boundary) / (1 - boundary) / 2;
}

function compositionCaptionForFraction(fraction) {
  return fraction <= 0.5 ? compositionLabelA : compositionLabelB;
}

function syncOperandButtons() {
  const separate = currentQuiz === "composition" && !operationAnswered;
  el("puzzle-composition-operands").hidden = !separate;
  el("puzzle-replay").hidden = currentQuiz === "composition";
  for (const role of ["operation1", "operation2"]) {
    el(`puzzle-${role}`).disabled = false;
    el(`puzzle-${role}`).setAttribute("aria-pressed", String(compositionPlaybackMode === role));
  }
}

async function playCompositionOperand(role, animate = true) {
  if (currentQuiz !== "composition" || operationAnswered || !currentQuestion) return;
  const generation = roundGeneration;
  const question = currentQuestion;
  const playback = ++compositionPlaybackGeneration;
  const isCurrent = () => generation === roundGeneration && playback === compositionPlaybackGeneration
    && question === currentQuestion && !operationAnswered && compositionPlaybackMode === role;
  compositionPlaybackMode = role;
  syncOperandButtons();
  compositionQuestionReady = false;
  cancelReveal();
  const gen = ++view.pathGeneration;
  view.resetAnimation();
  view.clearSymmetryElements();
  setSlider(0);
  setStageCaption("");
  setPuzzleSliderBreakpoints([]);
  el("puzzle-check").disabled = true;
  el("puzzle-slider").disabled = true;
  el("puzzle-replay").disabled = true;
  let prepared = false;
  try {
    view.modelClient?.setQuizPlayback(role);
    const index = role === "operation1" ? question.operation_index_a : question.operation_index_b;
    await view.loadAnimationPaths(index == null ? null : Number(index), gen, "displayed");
    if (!isCurrent()) return;
    view.resetAnimation();
    prepared = true;
    compositionQuestionReady = true;
    el("puzzle-check").disabled = false;
    el("puzzle-slider").disabled = false;
    if (animate) await animateReveal();
  } catch (error) {
    if (isCurrent()) throw error;
  } finally {
    if (isCurrent()) {
      compositionQuestionReady = prepared;
      el("puzzle-check").disabled = !prepared;
      el("puzzle-slider").disabled = !prepared;
      el("puzzle-replay").disabled = false;
    }
  }
}

async function playCompositionQuestion(animate = true) {
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
  let prepared = false;
  try {
    compositionLabelA = compositionStageLabel("操作1", question.operation_a);
    compositionLabelB = compositionStageLabel("操作2", question.operation_b);
    const gen = ++view.pathGeneration;
    setStageCaption(compositionLabelA);
    if (!modelViewEnabled) {
      compositionSnapshot = await loadLegacyQuizComposition(
        index => fetchOperationSnapshot(index, gen), question, isCurrent);
    } else {
      if (view.modelClient !== quizClient) throw new Error("missing_quiz_model");
      quizClient.setQuizPlayback("sequence");
      compositionSnapshot = await fetchOperationSnapshot(question.operation_index_a, gen);
    }
    if (!isCurrent() || !compositionSnapshot) return;
    applyCombinedCompositionProgress(0);
    prepared = true;
    compositionQuestionReady = !operationAnswered;
    el("puzzle-check").disabled = operationAnswered;
    el("puzzle-slider").disabled = false;
    if (animate) {
      await animateProgress({
        onProgress: progress => {
          setStageCaption(compositionCaptionForFraction(compositionSliderFraction(progress)));
        },
        sliderProgress: compositionSliderFraction,
        legacySequence: true,
        holdBoundaries: [compositionSnapshot.paths.values().next().value?.model_segment_boundaries?.[0] ?? 0.5],
      });
    }
    if (!isCurrent()) return;
    setStageCaption(`${compositionLabelA} → ${compositionLabelB}`);
  } finally {
    if (isCurrent()) {
      compositionQuestionReady = !operationAnswered && prepared;
      el("puzzle-check").disabled = operationAnswered || !prepared;
      el("puzzle-replay").disabled = false;
      el("puzzle-slider").disabled = !prepared;
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
    view.modelClient?.setQuizPlayback("product");
    if (!await playSingleOperation(revealOperation, generation, "合成の結果", isCurrent)) return;
    if (!isCurrent()) return;
    setStageCaption("合成の結果");
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

// Matrices and answer coordinates. Molecules use three decimals, so noise in
// the input coordinates below 0.001 Å reads as 0 (and drops "+ t").
function matrixNumber(value) {
  if (currentSourceKind === "crystal") return compositionMatrixNumber(value);
  const number = Number(value);
  if (!Number.isFinite(number)) return "?";
  if (Math.abs(number) < 1e-3) return "0";
  return String(Number(number.toFixed(3)));
}

// "−" (U+2212) for negative numbers written as text, not MathML.
const textNumber = value => matrixNumber(value).replace(/^-/, "−");

// --- Post-answer "行列で見る" (shared by the operation, composition and mapping quizzes) ---
// Crystals use fractional coordinates (as the atom coordinate readout does);
// molecules use Cartesian coordinates in Å.

function operationTransform(operationIndex, transform = null) {
  const operation = transform || view.renderData.operations.find(op => Number(op.index) === Number(operationIndex));
  const fractional = currentSourceKind === "crystal";
  const matrix = operation?.[fractional ? "matrix_frac" : "matrix_cart"];
  const translation = operation?.[fractional ? "translation_frac" : "translation_cart"];
  return matrix && translation ? { matrix, translation } : null;
}

// Matrices, symbols and signs use the analysis panel's MathML (Latin Modern Math);
// labels stay HTML above each term because operation names carry overbars/subscripts.
const MATH = globalThis.SymmetryMathMarkup;

const isZeroVector = values => values.every(value => matrixNumber(value) === "0");

function mathHtml(node) {
  const math = MATH.mathNode("math", node);
  return math.outerHTML;
}

function equationPiece(label, node, attributes = "") {
  return `<span class="puzzle-equation-label">${label}</span>`
    + `<span class="puzzle-equation-math"${attributes}>${mathHtml(node)}</span>`;
}

function equationMatrix(label, values, name) {
  const node = MATH.mathMatrix(values.map(row => row.map(matrixNumber)), String, name, true);
  return equationPiece(label, node, ` data-matrix="${name}"`);
}

function equationVector(label, values, name) {
  const node = MATH.mathMatrix(values.map(value => [matrixNumber(value)]), String, name, true);
  return equationPiece(label, node, ` data-vector="${name}"`);
}

// 4×4 form (W t; 0 1): one product carries both parts.
function equationAugmented(label, transform, name) {
  const values = [...transform.matrix.map((row, i) => [...row, transform.translation[i]]), [0, 0, 0, 1]];
  return equationMatrix(label, values, name);
}

function equationSign(sign) {
  return equationPiece("", MATH.mathNode("mo", sign));
}

// The ⓘ (shown only while open) opens one small window, the same for every quiz.
function matrixDetails(content, note = "") {
  return `<details class="puzzle-operation-details"><summary>行列で見る`
    + `<button type="button" class="puzzle-matrix-help" aria-haspopup="dialog" aria-label="行列の読み方">ⓘ</button></summary>`
    + `<div class="puzzle-equation">${content}</div>`
    + (note ? `<p class="puzzle-matrix-note">${note}</p>` : "") + `</details>`;
}

const tm = {
  mi: text => MATH.mathNode("mi", text),
  mo: text => MATH.mathNode("mo", text),
  expr: text => MATH.mathExpression(text, true),
  vec: values => MATH.mathMatrix(values.map(value => [value]), String, "", true),
  mat: rows => MATH.mathMatrix(rows, value => value, "", true),
  row: (...nodes) => MATH.mathNode("mrow", ...nodes),
};

const SYMBOL = {
  get x() { return MATH.inlineMath(MATH.vectorSymbol("x")); },
  get xp() { return MATH.inlineMath(MATH.vectorSymbol("x", true)); },
  get t() { return MATH.inlineMath(MATH.vectorSymbol("t")); },
  get W() { return MATH.inlineMath(tm.mi("W")); },
};

function openMatrixHelp(event) {
  if (!event.target.closest?.(".puzzle-matrix-help")) return;
  event.preventDefault(); // keep the <details> open
  MATH.openMatrixHelp();
}

function renderCompositionResult(result) {
  const box = el("puzzle-result");
  const answerText = formatCompositionAnswers(result.answers);
  const firstText = formatOperationAnswers([currentQuestion.operation_a]);
  let secondText = formatOperationAnswers([currentQuestion.operation_b]);
  // "3回回転 → 3回回転 ＝ 恒等" reads as a mistake: the two share an axis and
  // turn opposite ways. Say so only in this case (same name, product E).
  const a = currentQuestion.operation_a, b = currentQuestion.operation_b;
  if ((result.answers || []).some(answer => answer.kind === "identity")
      && a?.kind === b?.kind && Number(a?.order) === Number(b?.order) && Number(a?.order) > 2
      && ["rotation", "rotoreflection", "rotoinversion"].includes(a?.kind)) {
    secondText += "（逆向き）";
  }
  box.hidden = false;
  box.className = `puzzle-result ${result.correct ? "hit" : "miss"}`;
  box.innerHTML = `<div class="puzzle-composition-summary"><span>${result.correct ? "正解" : "不正解"}</span>`
    + `<span>${firstText} → ${secondText} ＝ <span class="puzzle-composition-answer">${answerText}</span></span></div>`;
  const first = operationTransform(currentQuestion.operation_index_a, result.operand_transforms?.[0]);
  const second = operationTransform(currentQuestion.operation_index_b, result.operand_transforms?.[1]);
  const product = operationTransform(result.product_index, result.product_transform);
  if (!first || !second || !product) return;
  const labels = [`答え：${answerText}`, `操作2：${secondText}`, `操作1：${firstText}`];
  const withTranslation = ![first, second, product].every(transform => isZeroVector(transform.translation));
  // Crystal Hard inputs need not keep the lattice, so their fractional entries
  // can be decimals; say so only when one appears.
  const irrational = currentSourceKind === "crystal" && currentCompositionDifficulty === "hard"
    && [first, second].some(transform => [...transform.matrix.flat(), ...transform.translation]
      .some(value => matrixNumber(value).includes(".")));
  const note = irrational ? "Hardの操作1・操作2は結晶の格子を保たない操作なので、分率座標では成分が分数にならないことがあります。" : "";
  if (!withTranslation) {
    box.innerHTML += matrixDetails(equationMatrix(labels[0], product.matrix, "W") + equationSign("=")
      + equationMatrix(labels[1], second.matrix, "W2") + equationMatrix(labels[2], first.matrix, "W1"), note);
    return;
  }
  box.innerHTML += matrixDetails(equationAugmented(labels[0], product, "W") + equationSign("=")
    + equationAugmented(labels[1], second, "W2") + equationAugmented(labels[2], first, "W1"), note);
}

async function onCheckComposition() {
  const generation = roundGeneration;
  if (!compositionQuestionReady) {
    showPrompt("再生を準備中です");
    return;
  }
  const { kind, order } = selectedOperationAnswer();
  if (!kind) {
    showPrompt("操作の種類を選んでください。");
    return;
  }
  const config = operationKinds().find((k) => k.kind === kind);
  if (config?.orders && order == null) {
    showPrompt("次数を選んでください。");
    return;
  }
  compositionQuestionReady = false;
  compositionPlaybackGeneration += 1;
  cancelReveal();
  view.pathGeneration += 1;
  el("puzzle-check").disabled = true;
  el("puzzle-replay").disabled = true;
  for (const role of ["operation1", "operation2"]) el(`puzzle-${role}`).disabled = true;
  let result;
  try {
    result = await getJson("/api/puzzle/composition/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question_id: currentQuestion.id, kind, order }),
    });
  } catch (error) {
    // A transient POST failure must not strand the round with both controls
    // disabled. Keep the prepared question answerable and replayable.
    if (generation === roundGeneration) {
      compositionQuestionReady = true;
      el("puzzle-check").disabled = false;
      el("puzzle-replay").disabled = false;
      syncOperandButtons();
      if (!error.obsolete) showPrompt("回答を送信できませんでした。もう一度押してください。");
    }
    return;
  }
  if (generation !== roundGeneration) return;
  compositionAnswer = result;
  renderCompositionResult(result);
  operationAnswered = true;
  syncOperandButtons();
  compositionPlaybackMode = "product";
  syncCompositionPlaybackButtons();
  el("puzzle-composition-playback").hidden = false;
  el("puzzle-again").hidden = false;
  // Reveal the product: play its animation, then show its symmetry element.
  revealOperation = result.product_index;
  await playCompositionProduct(generation);
  if (generation === roundGeneration) {
    el("puzzle-open-analysis").hidden = false;
    el("puzzle-trajectories-toggle").hidden = false;
  }
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

function animateProgress({onProgress = () => {},
    sliderProgress = progress => progress, legacySequence = false, holdBoundaries = []} = {}) {
  cancelReveal();
  const seconds = modelViewEnabled ? view.baseAnimationDurationSeconds : legacyQuizDurationMs(legacySequence) / 1000;
  const token = {};
  revealAnim = token;
  syncPuzzleSpeedControls();
  return view.playToEnd({speed: puzzlePlaybackSpeed(), durationSeconds: seconds,
    boundaries: holdBoundaries, onProgress: progress => {
      onProgress(progress);
      setSlider(sliderProgress(progress));
    }}).finally(() => {
    if (revealAnim !== token) return;
    revealAnim = null;
    syncPuzzleSpeedControls();
  });
}

function animateReveal() {
  return animateProgress();
}

function cancelReveal() {
  const anim = revealAnim;
  revealAnim = null;
  syncPuzzleSpeedControls();
  if (anim) view?.cancelPlayback();
}

function syncPuzzleSpeedControls() {
  el("puzzle-speed-settings").hidden = currentQuiz === "point_group";
  const output = el("puzzle-speed-value");
  output.value = `${puzzlePlaybackSpeed().toFixed(2)}×`;
  output.textContent = output.value;
  const busy = Boolean(revealAnim || mappingLoadControls || analysisLoadControls || view?.recording);
  el("puzzle-speed-previous").disabled = busy || puzzlePlaybackSpeed() <= ANIMATION_SPEED_STEPS[0];
  el("puzzle-speed-next").disabled = busy || puzzlePlaybackSpeed() >= ANIMATION_SPEED_STEPS.at(-1);
}

function stepPuzzleSpeed(direction) {
  if (revealAnim || mappingLoadControls || analysisLoadControls || view?.recording) return;
  const steps = direction > 0 ? ANIMATION_SPEED_STEPS : [...ANIMATION_SPEED_STEPS].reverse();
  const speed = steps.find(value => direction > 0 ? value > puzzlePlaybackSpeed() : value < puzzlePlaybackSpeed());
  if (speed === undefined) return;
  puzzlePlaybackSpeeds[puzzleSpeedKind()] = speed;
  syncPuzzleSpeedControls();
}

async function playReveal(animate = true) {
  if (revealOperation == null) return; // e.g. an infinite axis: nothing to play
  const generation = roundGeneration;
  let prepared = false;
  el("puzzle-slider").disabled = true;
  if (!animate) {
    el("puzzle-check").disabled = true;
  }
  el("puzzle-replay").disabled = true;
  if (!el("puzzle-save-gif").hidden) el("puzzle-save-gif").disabled = true;
  try {
    // Override the shared analysis selection so puzzle rounds animate their own
    // displayed/unit-cell atoms consistently.
    await view.loadAnimationPaths(Number(revealOperation), ++view.pathGeneration, "displayed");
    if (generation !== roundGeneration) return;
    view.resetAnimation();
    prepared = true;
    el("puzzle-slider").disabled = false;
    if (currentQuiz === "operation" && !operationAnswered) {
      el("puzzle-check").disabled = false;
    }
    if (animate) await animateReveal();
    revealOperationElements(generation);
  } finally {
    if (generation === roundGeneration) {
      if (!animate) {
        el("puzzle-check").disabled = !prepared;
      }
      el("puzzle-slider").disabled = !prepared;
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
  for (const [instanceId, instance] of view.atomInstances) {
    if (instance.sourceAtom === Number(sourceAtom) && instance.isPrimaryImage) {
      return { position: instance.start, radius: instance.radius, instanceId };
    }
  }
  return null;
}

// Before answering: purple question atom + orange choice. After answering only
// two rings remain: the orange answer and the green correct site. A correct
// answer shows one green ring on the clicked site (a boundary image counts as
// the same site). Later clicks only show coordinates, never another ring.
function refreshMappingMarkers({ revealTarget = null } = {}) {
  const common = {style: "selection", mergeGroup: "mapping"};
  const entries = [];
  const revealed = revealTarget != null;
  if (!revealed) {
    const source = atomStartMarker(currentQuestion.source_atom_index);
    if (source) entries.push({...common, instanceId: source.instanceId, color: PICK_SOURCE_COLOR, priority: 0});
  }
  // The answer marks a site, rather than the atom that later leaves it.
  const guess = mappingGuess != null ? mappingGuessPosition || atomStartMarker(mappingGuess) : null;
  if (guess) {
    entries.push({
      ...common,
      position: [...guess.position],
      radius: guess.radius,
      visibilityInstanceId: guess.instanceId,
      ...(revealed && mappingAnswerCorrect ? {color: PICK_TARGET_COLOR} : {}),
      priority: 1,
    });
  }
  if (revealed && !mappingAnswerCorrect) {
    // A fixed ring at the target atom's start position: the highlighted atom lands
    // inside it as the operation completes (the target atom itself moves away).
    const target = atomStartMarker(revealTarget);
    if (target) {
      entries.push({
        ...common,
        position: mappingTargetPosition || [...target.position],
        color: PICK_TARGET_COLOR,
        radius: target.radius,
        visibilityInstanceId: target.instanceId,
        priority: 3,
      });
    }
  }
  view.setPickMarkers(entries);
}

async function beginMappingRound() {
  const generation = roundGeneration;
  mappingGuess = null;
  const operation = currentQuestion.operation;
  const hard = currentSourceKind === "crystal" && currentMappingDifficulty === "hard";
  // Same operation names as the other quizzes, inside one natural question.
  const shift = operation?.intrinsic_translation_frac;
  const shiftText = shift?.some(x => Math.abs(x) > 1e-8) ? shift.map(compositionMatrixNumber).join(", ") : "";
  let operationName = formatOperationAnswer(operation.kind, operation.order);
  if (shiftText) {
    operationName = operation.kind === "translation"
      ? `並進（${escapeHtml(shiftText)}）` : `${operationName}（並進 ${escapeHtml(shiftText)}）`;
  }
  el("puzzle-question").innerHTML = hard
    ? `${operationName}で移った紫の円の原子は、単位格子内のどの原子にあたりますか？`
    : `${operationName}で、紫の円の原子はどこへ移りますか？`;
  setStageCaption("");
  el("puzzle-options").innerHTML = ""; // Pick an atom, then confirm with the answer button.
  el("puzzle-slider").hidden = true;
  el("puzzle-playback").hidden = true; // reveal controls appear after answering
  // Like the other quizzes, 回答 stays usable and an empty answer gets a prompt.
  el("puzzle-check").disabled = false;
  hidePuzzleGifButton();
  refreshMappingMarkers();
  // Show the operation's symmetry element (axis/plane/centre) up front, same as
  // the spec calls for — this is independent of the (now-removed) motion preview,
  // which only ever animated the atom, not this element.
  const elementsReady = view.loadSymmetryElements(Number(currentQuestion.operation_index), view.pathGeneration).catch(() => {});
  view.onAtomPick = (atomIndex, instance, event) => {
    if (operationAnswered) {
      selectCoordinateAtom(instance, event, false);
      return;
    }
    if (atomIndex == null) return;
    selectCoordinateAtom(instance, event, false);
    mappingGuess = Number(atomIndex);
    clearSelectionPrompt();
    mappingGuessPosition = instance ? {position: [...instance.start], radius: instance.radius,
      instanceId: [...view.atomInstances].find(([, atom]) => atom === instance)?.[0]} : atomStartMarker(atomIndex);
    el("puzzle-check").disabled = false;
    refreshMappingMarkers();
  };
  await elementsReady;
}

function applyMappingPlaybackScope() {
  view.setAnimationSourceAtoms(mappingPlaybackScope === "target" ? [currentQuestion.source_atom_index] : null,
    mappingPlaybackScope === "target");
}

function changeMappingPlaybackScope() {
  if (currentQuiz !== "mapping" || !operationAnswered || !currentQuestion) return;
  mappingPlaybackGeneration += 1;
  cancelReveal();
  mappingPlaybackScope = el("puzzle-mapping-scope").checked ? "all" : "target";
  const progress = view.animationProgress;
  applyMappingPlaybackScope();
  view.setAnimationProgress(progress);
  view.updateAnimationTargetMarkers();
  view.updateTrajectoryLines();
  view.showStartMarkers();
  refreshMappingMarkers({revealTarget: mappingRevealTarget});
  el("puzzle-replay").disabled = false;
}

async function playMappingReveal(generation = roundGeneration) {
  const playback = ++mappingPlaybackGeneration;
  const question = currentQuestion;
  const pathGeneration = ++view.pathGeneration;
  const isPreparedQuestion = () => generation === roundGeneration && question === currentQuestion
    && pathGeneration === view.pathGeneration && !el("puzzle-play").hidden && !el("puzzle-mode").hidden;
  const isCurrent = () =>
    isPreparedQuestion()
    && playback === mappingPlaybackGeneration
    && operationAnswered;
  cancelReveal();
  el("puzzle-replay").disabled = true;
  applyMappingPlaybackScope();
  try {
    // The now-removed playMappingPreview() (2026-09-09) used to load this once
    // per round, before the player could even click 回答 — nothing does that
    // any more, so the reveal has to load its own animation path, the same way
    // playReveal() does for the other quizzes. Without this, view.animationPaths
    // stays empty (cleared by invalidatePuzzleWork() at round start) and 再生
    // animates nothing.
    await view.loadAnimationPaths(Number(question.operation_index), pathGeneration, "displayed");
    if (!isPreparedQuestion()) return;
    // A local scope change stops autoplay, but keeps this same question's
    // prepared paths and applies its latest scope at the preserved progress.
    if (!isCurrent()) {
      applyMappingPlaybackScope();
      view.setAnimationProgress(view.animationProgress);
      view.showStartMarkers();
      refreshMappingMarkers({revealTarget: mappingRevealTarget});
      return;
    }
    view.resetAnimation();
    refreshMappingMarkers({ revealTarget: mappingRevealTarget });
    await animateProgress();
  } finally {
    if (isPreparedQuestion()) el("puzzle-replay").disabled = false;
  }
}

async function onCheckMapping() {
  const generation = roundGeneration;
  if (mappingGuess == null) {
    showPrompt(pickAtomPrompt());
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
      if (!error.obsolete) showPrompt("回答を送信できませんでした。もう一度押してください。");
    }
    return;
  }
  if (generation !== roundGeneration || el("puzzle-play").hidden || el("puzzle-mode").hidden) return;
  operationAnswered = true;
  const box = el("puzzle-result");
  box.hidden = false;
  box.className = `puzzle-result ${result.correct ? "hit" : "miss"}`;
  // Crystal Hard: the green ring sits on a displayed atom (the clicked one when
  // correct, the target's displayed image otherwise), which can be a different
  // boundary image from the server's in-cell representative. Name that ringed
  // atom and measure the lattice shift from it, so the text matches the ring.
  const hardCrystal = currentSourceKind === "crystal" && currentMappingDifficulty === "hard"
    && Array.isArray(result.actual_target_frac) && Array.isArray(result.target_frac);
  let ringedFrac = hardCrystal ? result.target_frac : null;
  let ringedPosition = null;
  if (hardCrystal) {
    const ringed = result.correct
      ? (mappingGuessPosition || atomStartMarker(mappingGuess))
      : atomStartMarker(result.target_atom_index);
    const B = view.symmetryCellBasis();
    if (ringed && B) {
      const approx = new Vector3(...ringed.position).applyMatrix4(B.clone().invert()).toArray();
      const image = result.actual_target_frac.map((value, i) => Math.round(value - approx[i]));
      ringedFrac = result.actual_target_frac.map((value, i) => value - image[i]);
      ringedPosition = [...ringed.position];
    }
  }
  const answerResult = ringedFrac ? {...result, target_frac: ringedFrac} : result;
  box.textContent = result.correct ? "正解" : `不正解（答え：${mappingAnswerText(answerResult)}）`;
  const shift = ringedFrac ? result.actual_target_frac.map((value, i) => Math.round(value - ringedFrac[i])) : null;
  if (shift && shift.some(value => value !== 0)) {
    box.innerHTML += `<div class="puzzle-explanation">移動先は、緑の円の原子を格子並進 (${shift.map(textNumber).join(", ")}) だけずらした位置です。</div>`;
  }
  box.innerHTML += mappingResultDetails(result);
  el("puzzle-again").hidden = false;
  mappingRevealTarget = result.target_atom_index;
  mappingAnswerCorrect = result.correct;
  if (result.actual_target_frac) {
    const frac = currentMappingDifficulty === "hard" ? result.target_frac : result.actual_target_frac;
    const origin = atomStartMarker(result.target_atom_index);
    const atom = view.renderData.atoms.find(a => Number(a.index) === result.target_atom_index);
    if (ringedPosition) mappingTargetPosition = ringedPosition;
    else if (origin && atom?.frac) {
      // Lattice vectors are shared with coordinate inspection (columns of B).
      const B = view.symmetryCellBasis();
      mappingTargetPosition = B ? new Vector3(...frac).applyMatrix4(B).toArray() : origin.position;
    }
  }
  el("puzzle-mapping-operation").hidden = false;
  el("puzzle-mapping-scope").checked = mappingPlaybackScope === "all";
  if (shift) {
    // The same shift as the text: the destination cell holds the endpoint where
    // the ringed atom sits in the original cell.
    mappingDestinationCell = shift;
    el("puzzle-mapping-cell-toggle").hidden = false;
  }
  el("puzzle-slider").hidden = false;
  // Reveal the full operation from rest: the yellow atom lands on the fixed green
  // destination ring while the rest of the molecule follows the same operation.
  el("puzzle-playback").hidden = false;
  await playMappingReveal(generation);
  if (generation === roundGeneration && !el("puzzle-play").hidden && !el("puzzle-mode").hidden) {
    el("puzzle-open-analysis").hidden = false;
    el("puzzle-trajectories-toggle").hidden = false;
  }
}

// The green ring's atom as text: Normal names the actual endpoint (possibly on a
// cell face), Hard the in-cell atom, a molecule its position in Å.
function mappingAnswerText(result) {
  const atom = view.renderData.atoms.find(item => Number(item.index) === Number(result.target_atom_index));
  const element = atom?.element || "";
  if (currentSourceKind !== "crystal") {
    return atom?.cart ? `${element} (${atom.cart.map(textNumber).join(", ")}) Å` : element;
  }
  const frac = (currentMappingDifficulty === "hard" ? result.target_frac : result.actual_target_frac) || atom?.frac;
  return Array.isArray(frac) ? `${element} (${frac.map(textNumber).join(", ")})` : element;
}

function mappingResultDetails(result) {
  const fractional = currentSourceKind === "crystal";
  const position = fractional ? "frac" : "cart";
  const source = view.renderData.atoms.find(atom => Number(atom.index) === Number(result.source_atom_index)
    && Array.isArray(atom[position]));
  const operation = operationTransform(result.operation_index);
  if (!source || !operation) return "";
  const before = source[position];
  const after = operation.matrix.map((row, i) => row.reduce((sum, value, j) => sum + value * before[j], operation.translation[i]));
  const withTranslation = !isZeroVector(operation.translation);
  const name = formatOperationAnswer(currentQuestion.operation.kind, currentQuestion.operation.order);
  return matrixDetails(equationVector(`操作後 ${SYMBOL.xp}`, after, "after") + equationSign("=")
    + equationMatrix(`${name} ${SYMBOL.W}`, operation.matrix, "W") + equationVector(`操作前 ${SYMBOL.x}`, before, "before")
    + (withTranslation ? equationSign("+") + equationVector(`並進 ${SYMBOL.t}`, operation.translation, "translation") : ""));
}

// x′ = W x + t for the operation that was played (the first listed name).
function operationResultDetails(result) {
  const operation = operationTransform(currentQuestion.operation_index);
  if (!operation) return "";
  const name = formatOperationAnswers(result.answers.slice(0, 1));
  const withTranslation = !isZeroVector(operation.translation);
  return matrixDetails(equationPiece(`操作後 ${SYMBOL.xp}`, tm.vec(["x′", "y′", "z′"])) + equationSign("=")
    + equationMatrix(`${name} ${SYMBOL.W}`, operation.matrix, "W") + equationPiece(`操作前 ${SYMBOL.x}`, tm.vec(["x", "y", "z"]))
    + (withTranslation ? equationSign("+") + equationVector(`並進 ${SYMBOL.t}`, operation.translation, "translation") : ""));
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
    if (!operationAnswered) return playCompositionOperand(compositionPlaybackMode);
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
    el("puzzle-trajectories-toggle").hidden = false;
    setPuzzleGifButtonReady(false);
    playReveal().catch(showError);
  }
}

function selectedOperationAnswer() {
  const root = el("puzzle-options");
  const kind = root.dataset.operationKind || null;
  const order = root.dataset.operationOrder || null;
  const shiftInput = root.querySelector('input[name="op-shift"]:checked');
  // Raw value ("2" or "inf"); the server normalises it.
  return {
    kind,
    order,
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
    showPrompt("次数を選んでください。");
    return;
  }
  if (currentOperationDifficulty === "hard" && shift == null) {
    showPrompt("並進も選んでください。");
    return;
  }
  el("puzzle-check").disabled = true;
  let result;
  try {
    result = await getJson("/api/puzzle/operations/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question_id: currentQuestion.id, kind, order, shift, difficulty: currentOperationDifficulty }),
    });
  } catch (error) {
    if (generation === roundGeneration && !error.obsolete) {
      el("puzzle-check").disabled = false;
      showPrompt("回答を送信できませんでした。もう一度押してください。");
    }
    return;
  }
  if (generation !== roundGeneration) return;
  const box = el("puzzle-result");
  box.hidden = false;
  box.className = `puzzle-result ${result.correct ? "hit" : "miss"}`;
  box.innerHTML = result.correct ? "正解" : `不正解（答え：${formatOperationAnswers(result.answers)}）`;
  if (result.answers.length > 1) {
    // More than one name is accepted because the atoms move alike.
    const names = result.answers.map(answer => formatOperationAnswers([answer]));
    const joined = `${names.slice(0, -1).join("、")}と${names.at(-1)}`;
    box.innerHTML += `<div class="puzzle-explanation">この構造では、${joined}で原子の動きが同じです。</div>`;
  }
  box.innerHTML += operationResultDetails(result);
  el("puzzle-again").hidden = false;
  el("puzzle-trajectories-toggle").hidden = false;
  operationAnswered = true;
  // Reveal where the operation's symmetry element sits (axis / plane / centre /
  // glide arrow) now that the answer is in — the same elements the analysis shows.
  revealOperationElements(generation);
  el("puzzle-open-analysis").hidden = false;
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
  button.title = next === "perspective" ? "平行投影に切り替える" : "透視投影に切り替える";
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
  const origin = view.modelClient?.currentModelViewState().cell_origin_mode || "center";
  const neighbors = currentQuiz === "point_group" && currentPointGroupDifficulty === "hard"
    ? `&periodic_neighbors=${puzzleShowPeriodicNeighbors ? 1 : 0}` : "";
  view.renderDataQuery = kind === "crystal" ? `?display_mode=source&cell_origin_mode=${origin}&boundary_images=${flag}${neighbors}` : "";
  view.animationPathQuery = kind === "crystal" ? `&display_mode=source&cell_origin_mode=${origin}&boundary_images=${flag}` : "";
  view.symmetryElementQuery = kind === "crystal" ? `&display_mode=source&cell_origin_mode=${origin}` : "";
}

function syncBoundaryImagesButton() {
  el("puzzle-boundary-images").checked = puzzleShowBoundaryImages;
  el("puzzle-boundary-images-toggle").title = puzzleShowBoundaryImages
    ? "境界上の原子を非表示" : "境界上の原子を表示";
}

async function toggleBoundaryImages() {
  puzzleShowBoundaryImages = el("puzzle-boundary-images").checked;
  syncBoundaryImagesButton();
  await refreshPuzzleDisplay();
}

async function togglePeriodicNeighbors() {
  puzzleShowPeriodicNeighbors = el("puzzle-periodic-neighbors").checked;
  await refreshPuzzleDisplay();
}

async function refreshPuzzleDisplay() {
  return withPuzzleLoading(() => refreshPuzzleDisplayReady());
}

async function refreshPuzzleDisplayReady() {
  const generation = roundGeneration;
  const request = ++boundaryDisplayGeneration;
  applyBoundaryImagesQuery(currentSourceKind);
  let payload;
  try {
    payload = await view.renderPayload();
  } catch (error) {
    if (generation !== roundGeneration || request !== boundaryDisplayGeneration || error.obsolete) return;
    throw error;
  }
  if (generation !== roundGeneration || request !== boundaryDisplayGeneration) return;
  // Rebuild only the display, using the current frame even if playback advanced
  // while render data was in flight. The question and its verified paths stay.
  view.rangeHighlightEnabled = currentQuiz === "point_group" && currentPointGroupDifficulty === "hard" && puzzleShowPeriodicNeighbors;
  await view.refresh(true, payload, true);
  if (currentQuiz === "point_group") showPointGroupStructureInfo();
  else refreshAtomCoordinates();
  if (currentQuiz === "mapping" && currentQuestion) refreshMappingMarkers({revealTarget: mappingRevealTarget});
}

function syncTrajectoriesButton() {
  const enabled = view.showTrajectories === true;
  el("puzzle-trajectories").checked = enabled;
  el("puzzle-trajectories-toggle").title = enabled ? "原子の移動経路を非表示" : "原子の移動経路を表示";
}

function toggleTrajectories() {
  view.showTrajectories = el("puzzle-trajectories").checked;
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
  const controls = [...el("puzzle-play").querySelectorAll("button, input, select")];
  const disabled = new Map(controls.map(control => [control, control.disabled]));
  for (const control of controls) control.disabled = true;
  button.disabled = true;
  button.textContent = "保存中…";
  try {
    await view.recordGif("puzzle-animation");
  } finally {
    for (const [control, wasDisabled] of disabled) control.disabled = wasDisabled;
    button.textContent = "GIFを保存";
  }
}

function puzzleCameraAngle() {
  const input = el("puzzle-cam-angle");
  const value = Number(input.value);
  const invalid = !input.value.trim() || !Number.isFinite(value) || value < 0 || value > 360;
  const error = el("puzzle-camera-angle-error");
  error.textContent = invalid ? "0〜360で入力" : "";
  error.hidden = !invalid;
  for (const id of Object.keys(CAMERA_DIRECTIONS)) el(id).disabled = invalid;
  if (invalid) {
    input.setAttribute("aria-invalid", "true");
    input.setAttribute("aria-errormessage", "puzzle-camera-angle-error");
  } else {
    input.removeAttribute("aria-invalid");
    input.removeAttribute("aria-errormessage");
  }
  return invalid ? null : value;
}

function resetPuzzleCamera() {
  if (!puzzleInitialCamera) return;
  const saved = puzzleInitialCamera;
  view.activeCamera.position.copy(saved.position);
  view.activeCamera.up.copy(saved.up);
  view.activeCamera.zoom = saved.zoom;
  view.orthographicSpan = saved.span;
  view.activeCamera.lookAt(saved.target);
  // Recreate controls so residual drag/zoom damping cannot undo the reset.
  view.createControls(saved.target);
  view.resize();
  view.render();
}

// On phones the 表示設定 sheet (browser_ui.css) covers only the question panel,
// so it starts where that panel starts and the structure stays visible.
function placePuzzleSettingsSheet() {
  const overlay = el("puzzle-camera-overlay");
  if (!overlay.open) return;
  const panel = document.querySelector("#puzzle-play .puzzle-panel").getBoundingClientRect();
  overlay.style.setProperty("--puzzle-settings-top", `${Math.max(0, Math.round(panel.top))}px`);
  // Used only sideways, where the panel sits to the right of the structure.
  overlay.style.setProperty("--puzzle-settings-left", `${Math.max(0, Math.round(panel.left))}px`);
}

// On phones only the question panel scrolls; bring a new result or prompt into
// view there, keeping its first line visible when it is taller than the panel.
function revealPuzzleResult() {
  const box = el("puzzle-result");
  const panel = document.querySelector("#puzzle-play .puzzle-panel");
  if (box.hidden || getComputedStyle(panel).overflowY !== "auto") return;
  const boxRect = box.getBoundingClientRect();
  const panelRect = panel.getBoundingClientRect();
  const overflow = boxRect.bottom - panelRect.bottom + 12;
  if (overflow > 0) panel.scrollBy({top: Math.min(overflow, boxRect.top - panelRect.top - 8), behavior: "smooth"});
}

function setupCameraControls() {
  new MutationObserver(() => requestAnimationFrame(revealPuzzleResult)).observe(
    el("puzzle-result"), {attributes: true, attributeFilter: ["hidden", "class"], childList: true});
  el("puzzle-camera-overlay").addEventListener("toggle", placePuzzleSettingsSheet);
  window.addEventListener("resize", placePuzzleSettingsSheet);
  new ResizeObserver(placePuzzleSettingsSheet).observe(document.querySelector("#puzzle-play .puzzle-top"));
  el("puzzle-camera-reset").addEventListener("click", resetPuzzleCamera);
  el("puzzle-cam-angle").addEventListener("input", puzzleCameraAngle);
  for (const [id, direction] of Object.entries(CAMERA_DIRECTIONS)) {
    el(id).addEventListener("click", () => {
      const angle = puzzleCameraAngle();
      if (angle !== null) view.rotateCamera(direction, angle);
    });
  }
}

function setupControls() {
  document.addEventListener("pointerdown", (event) => {
    if (openOrderPanel && !openOrderPanel.panel.contains(event.target) && !openOrderPanel.trigger.contains(event.target)) closeOrderPanel();
  });
  document.addEventListener("keydown", (event) => {
    if (!openOrderPanel) return;
    event.stopPropagation();
    if (event.key === "Escape") { event.preventDefault(); return closeOrderPanel(true); }
    if (event.key === "Tab") return closeOrderPanel();
    const options = [...openOrderPanel.panel.querySelectorAll("button")];
    const index = options.indexOf(document.activeElement);
    let next;
    if (["ArrowRight", "ArrowDown"].includes(event.key)) next = (index + 1) % options.length;
    else if (["ArrowLeft", "ArrowUp"].includes(event.key)) next = (index - 1 + options.length) % options.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = options.length - 1;
    if (next !== undefined) { event.preventDefault(); options[next].focus({preventScroll: true}); }
  }, true);
  document.addEventListener("focusin", (event) => {
    if (openOrderPanel && !openOrderPanel.panel.contains(event.target) && event.target !== openOrderPanel.trigger) closeOrderPanel();
  });
  window.addEventListener("resize", () => closeOrderPanel());
  window.addEventListener("scroll", () => closeOrderPanel(), true);
  document.addEventListener("keydown", (event) => {
    if (!document.body.classList.contains("in-puzzle") || event.defaultPrevented
        || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    const slider = el("puzzle-slider");
    if (!currentQuestion || el("puzzle-play").hidden || el("puzzle-playback").hidden
        || slider.hidden || slider.disabled || !view.animationPaths.size) return;
    const target = event.target;
    if (target instanceof HTMLElement && target !== slider && (target.isContentEditable
        || target.closest("button, input, select, textarea, summary"))) return;
    event.preventDefault();
    const current = Number(slider.value);
    const direction = event.key === "ArrowLeft" ? -1 : 1;
    let next = Math.max(0, Math.min(current + direction * 20, 1000));
    const stops = [...el("puzzle-slider-stops").options].map(option => Number(option.value))
      .filter(value => direction > 0 ? value > current && value < next : value < current && value > next);
    if (stops.length) next = direction > 0 ? Math.min(...stops) : Math.max(...stops);
    slider.value = String(next);
    // Reuse pointer scrubbing: cancel playback and apply the selected route's timeline.
    slider.dispatchEvent(new Event("input", {bubbles: true}));
  });
  el("puzzle-legend-visible").addEventListener("change", syncLegendVisibility);
  el("puzzle-projection").addEventListener("click", toggleProjection);
  el("puzzle-target-copies").addEventListener("change", toggleTargetCopies);
  el("puzzle-boundary-images").addEventListener("change", () => toggleBoundaryImages().catch(showError));
  el("puzzle-periodic-neighbors").addEventListener("change", () => togglePeriodicNeighbors().catch(showError));
  el("puzzle-trajectories").addEventListener("change", toggleTrajectories);
  el("puzzle-speed-previous").addEventListener("click", () => stepPuzzleSpeed(-1));
  el("puzzle-speed-next").addEventListener("click", () => stepPuzzleSpeed(1));
  setupCameraControls();
  el("puzzle-check").addEventListener("click", () => onCheck().catch(showError));
  el("puzzle-result").addEventListener("click", openMatrixHelp);
  // Point-group choices and the Hard translation are radio inputs.
  el("puzzle-options").addEventListener("change", clearSelectionPrompt);
  for (const role of ["operation1", "operation2"]) {
    el(`puzzle-${role}`).addEventListener("click", () => playCompositionOperand(role).catch(showError));
  }
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
    if (currentQuiz !== "point_group" && questions.length) beginRound().catch(showError);
  });
  el("puzzle-structure-details").addEventListener("click", openPuzzleStructureInfo);
  const structureDialog = el("puzzle-structure-dialog");
  el("puzzle-close-structure-details").addEventListener("click", closePuzzleStructureInfo);
  structureDialog.addEventListener("close", () => {
    el("puzzle-structure-lattice").replaceChildren();
    el("puzzle-structure-atoms").replaceChildren();
  });
  structureDialog.addEventListener("keydown", event => event.stopPropagation());
  const outsideStructureDialog = event => {
    const box = structureDialog.getBoundingClientRect();
    return event.target === structureDialog && (event.clientX < box.left || event.clientX > box.right
      || event.clientY < box.top || event.clientY > box.bottom);
  };
  let pressedOutsideStructure = false;
  structureDialog.addEventListener("pointerdown", event => { pressedOutsideStructure = outsideStructureDialog(event); });
  structureDialog.addEventListener("click", event => {
    if (pressedOutsideStructure && outsideStructureDialog(event)) closePuzzleStructureInfo();
    pressedOutsideStructure = false;
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
      startRandomPointGroupStructure(currentKind).catch(pointGroupLoadError);
    } else {
      showPicker();
    }
  });
  // A single 戻る button now handles every screen (see goBack()); browser_ui.js
  // used to own this button's click handler (a plain jump to the hub), but that
  // no longer fits now that it means "one step back" instead — see
  // docs/archive/sessions/SESSION_REPORT_2026-09-09.md.
  el("puzzle-back").addEventListener("click", () => goBack());
  for (const card of document.querySelectorAll("[data-quiz]")) {
    card.addEventListener("click", () => {
      currentQuiz = card.dataset.quiz;
      // Normal/Hard chosen on the picker is kept for the session.
      if (currentQuiz === "mapping") mappingPlaybackScope = "target";
      if (currentQuiz === "point_group") {
        buildPointGroupKindScreen().then(showPointGroupKind).catch(showError);
      } else {
        buildPicker().then(showPicker).catch(showError);
      }
    });
  }
  el("puzzle-mapping-scope").addEventListener("change", changeMappingPlaybackScope);
  el("puzzle-mapping-cell").addEventListener("change", () => {
    if (currentQuiz !== "mapping" || !operationAnswered) return;
    view.setDestinationCell(el("puzzle-mapping-cell").checked ? mappingDestinationCell : null);
  });
  for (const card of document.querySelectorAll("[data-point-group-difficulty]")) {
    card.addEventListener("click", () => {
      currentPointGroupDifficulty = card.dataset.pointGroupDifficulty;
      startRandomPointGroupStructure("crystal").catch(pointGroupLoadError);
    });
  }
  for (const card of document.querySelectorAll("[data-point-group-kind]")) {
    card.addEventListener("click", () => {
      currentPointGroupDifficulty = "normal";
      if (card.dataset.pointGroupKind === "crystal") showPointGroupDifficulty();
      else startRandomPointGroupStructure("molecule").catch(showError);
    });
  }
}

function enterPuzzle() {
  if (!started) {
    started = true;
    view = new StaticStructureView(el("puzzle-view"), {showMolecularAxes: true, clearMoleculeView: true});
    window.symmetryPuzzleView = view;
    view.setBackgroundMode("light");
    // Puzzle clicks are never analysis selections. The mapping round installs its
    // own hook; other current quizzes install coordinate inspection.
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
window.addEventListener("symmetry-exit-puzzle", () => {
  clearPuzzleLoading();
  closePuzzleStructureInfo();
  closeOrderPanel();
  view?.setActive(false);
});
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

// Only the visible quiz consumes global keyboard progress; analysis has its own
// renderer/client, and neither hidden view changes the other's playback.
window.addEventListener("symmetry-animation-progress", (event) => {
  if (!document.body.classList.contains("in-puzzle")) return;
  const progress = Number(event.detail?.progress) || 0;
  if (currentQuiz === "composition" && compositionPlaybackMode === "sequence") applyCombinedCompositionProgress(progress);
  else view?.setAnimationProgress(progress);
  setSlider(progress);
});

// In --mode puzzle the classic UI script can dispatch its entry event before this
// module has registered the listener. Recover from that ordering by inspecting the
// already-rendered screen; `started` keeps the path idempotent.
if (el("puzzle-mode")?.hidden === false) queueMicrotask(enterPuzzle);
