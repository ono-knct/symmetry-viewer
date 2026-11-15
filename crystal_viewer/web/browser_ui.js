import {analysisWaiting, viewFetch, modelViewEnabled, modelBoundary} from "/static/view_api.js";
import {ANIMATION_SPEED_STEPS} from "/static/playback_schedule.js";
// operation_math.js is a deferred classic script, so it has run before this module.
const {mathNode, mathExpression, mathMatrix, openMatrixHelp} = globalThis.SymmetryMathMarkup;

let operations = [];
let atoms = [];
let atomMotionBySource = new Map();
let lastAtomMotionRequestKey = "";
let pendingAtomMotionRequestKey = "";
let atomMotionRequestGeneration = 0;
let lastOperationRenderSignature = "";
let lastStructureInfoSignature = "";
let lastSelectedAtomStructureSignature = "";
let selectedAtomCardUpdates = [];
let structureDialogSignature = "";
let structureAtomUpdates = [];
let structureBatchUpdates = [];
let state = {};
let directionFilterValue = "";
let operationTypeFilterValue = "";
let customOperationSequence = [];
let quizCustomModelId = null;
let customOperationFilterValue = "";
let customSequenceRevision = 0;
let customSequenceToken = "";
let customSequenceTimer = null;
let customSequencePreparation = null;
let customComposeQueue = Promise.resolve();
let customSequenceStop = Promise.resolve(true);
let customPlaybackIntent = 0;
let summariesReady = false;
let activeMode = "standard";
let experienceMode = "beginner";
let fullImproperMode = "default";
let customUnmappedAtoms = new Set();
let sourceKind = "crystal";
let selectedStructureKind = "crystal";
let importInProgress = false;
let finishImportWaiting = null;
let importBusyControlId = "";
let gifPreparationBusy = false;
let gifExportBusy = false;
let refreshInProgress = false;
let analysisBootComplete = false;
let analysisRefreshInProgress = false;
let importRequestId = 0;
let exampleCatalog = {crystal: [], molecule: []};
let selectedExamplePath = "";
let revealedOperationKey = "";
// True once this page has opened a structure itself (example, import or quiz).
let structureOpenedInPage = false;
// Simple/Advanced before the quiz's 解析モードで確認 forced Advanced.
let experienceBeforeQuizAnalysis = "";
let movementBreakpoints = [0, 1];
let movementProgressValue = 0;
const MOVEMENT_FRAME_STEP = 0.02;
const LOOP_RESTART_DELAY_MS = 1000;
let loopRestartTimer = null;
let loopRestartInProgress = false;
let fullscreenOperationOptionsSignature = "";
let selectedAtomDetailsOpen = true;
let displayRangeUpdatePending = false;
let workspaceResizeFrame = null;
let speedUpdatePending = false;
const STRUCTURE_KIND_UI = JSON.parse(document.getElementById("structure-kind-config").textContent);
const threeViewPanel = document.getElementById("three-view-panel");
const viewPanel = document.getElementById("view-panel");
const fullscreenControls = document.getElementById("fullscreen-controls");
const fullscreenControlsContent = document.getElementById("fullscreen-controls-content");
const animationPanel = document.getElementById("animation-panel");
const utilityPanel = document.getElementById("utility-panel");
const improperModeControl = document.getElementById("improper-mode");
const improperModePlaceholder = document.createComment("improper-mode-placeholder");
improperModeControl.before(improperModePlaceholder);
const animationPanelPlaceholder = document.createComment("animation-panel-placeholder");
const cameraPanelPlaceholder = document.createComment("camera-panel-placeholder");
const utilityPanelPlaceholder = document.createComment("utility-panel-placeholder");
const fullscreenAnimationDetails = document.createElement("details");
fullscreenAnimationDetails.className = "fullscreen-animation-details";
const fullscreenAnimationSummary = document.createElement("summary");
fullscreenAnimationSummary.textContent = "Animation";
fullscreenAnimationDetails.append(fullscreenAnimationSummary);
// Display controls are secondary to playback, so they belong below Animation.
document.querySelector(".side-stack").appendChild(viewPanel);
viewPanel.after(utilityPanel);
animationPanel.before(animationPanelPlaceholder);
viewPanel.before(cameraPanelPlaceholder);
utilityPanel.before(utilityPanelPlaceholder);

const viewerWorkspace = document.querySelector(".viewer-workspace");
const workspaceControls = document.getElementById("workspace");
const structureInfoPanel = document.getElementById("structure-info-panel");
const operationInfoPanel = document.getElementById("operation-info-panel");
const mobilePanelPlaceholders = [structureInfoPanel, operationInfoPanel, workspaceControls].map(panel => {
  const placeholder = document.createComment(`${panel.id}-desktop-position`);
  panel.before(placeholder);
  return [panel, placeholder];
});
const mobileAnalysisControls = document.createElement("div");
mobileAnalysisControls.id = "mobile-analysis-controls";
mobileAnalysisControls.hidden = true;
mobileAnalysisControls.tabIndex = 0;
mobileAnalysisControls.setAttribute("role", "region");
mobileAnalysisControls.setAttribute("aria-label", "解析の操作パネル");
viewerWorkspace.append(mobileAnalysisControls);
// Phone Advanced: Selected operation opens in a near full-screen window from
// the ⓘ on the structure's "Selected" label instead of the scrolling list.
const selectedOperationDialog = document.createElement("dialog");
selectedOperationDialog.id = "selected-operation-dialog";
selectedOperationDialog.className = "selected-operation-dialog";
selectedOperationDialog.setAttribute("aria-label", "Selected operation");
const selectedOperationDialogClose = document.createElement("button");
selectedOperationDialogClose.type = "button";
selectedOperationDialogClose.id = "close-selected-operation";
selectedOperationDialogClose.className = "secondary selected-operation-dialog-close";
selectedOperationDialogClose.textContent = "×";
selectedOperationDialogClose.title = "閉じる";
selectedOperationDialogClose.setAttribute("aria-label", "閉じる");
selectedOperationDialogClose.addEventListener("click", () => selectedOperationDialog.close());
selectedOperationDialog.append(selectedOperationDialogClose);
document.body.append(selectedOperationDialog);
selectedOperationDialog.addEventListener("click", event => {
  if (event.target === selectedOperationDialog) selectedOperationDialog.close();
});
// In the window the panel always stays open; ‹ › still change the operation.
operationInfoPanel.querySelector("summary").addEventListener("click", event => {
  if (selectedOperationDialog.contains(operationInfoPanel) && !event.target.closest("button")) event.preventDefault();
});

function openSelectedOperationDialog() {
  if (!selectedOperationDialog.contains(operationInfoPanel) || operationInfoPanel.hidden) return;
  operationInfoPanel.open = true;
  if (!selectedOperationDialog.open) selectedOperationDialog.showModal();
}
const mobileAnalysisQuery = window.matchMedia(
  "(max-width: 560px), (max-width: 980px) and (max-height: 560px) and (pointer: coarse)",
);
let mobileAnalysisActive = false;
const analysisTopbar = document.querySelector(".topbar");
analysisTopbar.id = "analysis-topbar";
const analysisTopbarPlaceholder = document.createComment("analysis-topbar-desktop-position");
analysisTopbar.before(analysisTopbarPlaceholder);
const mobileHeaderFrame = document.createElement("div");
mobileHeaderFrame.id = "mobile-header-frame";
const mobileStructureInfo = document.createElement("details");
mobileStructureInfo.id = "mobile-structure-info";
mobileStructureInfo.hidden = true;
const mobileStructureSummary = document.createElement("summary");
mobileStructureSummary.textContent = "Structure info";
mobileStructureInfo.append(mobileStructureSummary);
analysisTopbar.append(mobileStructureInfo);
// Sideways phones keep the header on one line: this button (CSS shows it only
// there) opens the structure details window instead of the folded summary.
const mobileStructureInfoButton = document.createElement("button");
mobileStructureInfoButton.id = "mobile-structure-info-button";
mobileStructureInfoButton.type = "button";
mobileStructureInfoButton.className = "secondary";
mobileStructureInfoButton.textContent = "Structure info";
mobileStructureInfoButton.hidden = true;
mobileStructureInfoButton.setAttribute("aria-haspopup", "dialog");
mobileStructureInfoButton.addEventListener("click", () => {
  document.getElementById("open-structure-details")?.click();
});
analysisTopbar.append(mobileStructureInfoButton);
let mobileHeaderCollapsed = false;
let mobileHeaderLayoutPending = false;
let mobileHeaderLastScrollTop = 0;
let mobileHeaderScrollDirection = 0;
let mobileHeaderScrollDistance = 0;
let mobileScrollIntentUntil = 0;
let mobileHeaderAnimationTimer = null;
let mobileHeaderTouchY = null;

function finishMobileHeaderAnimation() {
  clearTimeout(mobileHeaderAnimationTimer);
  mobileHeaderAnimationTimer = null;
  mobileHeaderLastScrollTop = mobileAnalysisControls.scrollTop;
  mobileHeaderScrollDistance = 0;
  mobileHeaderScrollDirection = 0;
  mobileHeaderLayoutPending = false;
  document.body.classList.remove("mobile-header-animating");
  if (mobileAnalysisActive) window.symmetryThreeView?.resize();
}

function measureMobileHeader() {
  if (!mobileAnalysisActive) return;
  const height = `${analysisTopbar.offsetHeight + 8}px`;
  if (mobileHeaderFrame.style.getPropertyValue("--mobile-header-height") === height) return;
  mobileHeaderFrame.style.setProperty("--mobile-header-height", height);
  if (mobileHeaderLayoutPending) {
    clearTimeout(mobileHeaderAnimationTimer);
    mobileHeaderAnimationTimer = setTimeout(finishMobileHeaderAnimation, 320);
  }
}

mobileHeaderFrame.addEventListener("transitionend", event => {
  if (event.target === mobileHeaderFrame && event.propertyName === "height") finishMobileHeaderAnimation();
});

function setMobileHeaderCollapsed(collapsed) {
  const next = Boolean(collapsed && mobileAnalysisActive && !viewerWorkspace.hidden);
  if (next === mobileHeaderCollapsed) return;
  measureMobileHeader();
  const animate = mobileAnalysisActive && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  clearTimeout(mobileHeaderAnimationTimer);
  mobileHeaderLayoutPending = true;
  document.body.classList.toggle("mobile-header-animating", animate);
  mobileHeaderCollapsed = next;
  document.body.classList.toggle("mobile-header-collapsed", next);
  analysisTopbar.inert = next;
  if (next && analysisTopbar.contains(document.activeElement)) {
    mobileAnalysisControls.focus({preventScroll: true});
  }
  // Ignore scroll clamps for the whole transition, not just its first frame.
  if (animate) mobileHeaderAnimationTimer = setTimeout(finishMobileHeaderAnimation, 320);
  else if (mobileAnalysisActive) requestAnimationFrame(finishMobileHeaderAnimation);
  else finishMobileHeaderAnimation();
}

document.addEventListener("pointerdown", () => {
  mobileScrollIntentUntil = 0;
}, {capture: true});
mobileAnalysisControls.addEventListener("touchstart", event => {
  mobileHeaderTouchY = event.touches[0]?.clientY ?? null;
}, {passive: true});
for (const type of ["wheel", "touchmove"]) {
  mobileAnalysisControls.addEventListener(type, event => {
    mobileScrollIntentUntil = performance.now() + 700;
    const touchY = event.touches?.[0]?.clientY;
    const upwards = type === "wheel" ? event.deltaY < 0
      : mobileHeaderTouchY !== null && touchY > mobileHeaderTouchY + 4;
    if (touchY !== undefined) mobileHeaderTouchY = touchY;
    if (mobileHeaderLayoutPending && mobileHeaderCollapsed && upwards) setMobileHeaderCollapsed(false);
    // The header has no button: pulling down at the top always brings it back.
    else if (mobileHeaderCollapsed && upwards && mobileAnalysisControls.scrollTop <= 2) setMobileHeaderCollapsed(false);
  }, {passive: true});
}
mobileAnalysisControls.addEventListener("scroll", () => {
  const top = Math.max(0, mobileAnalysisControls.scrollTop);
  const delta = top - mobileHeaderLastScrollTop;
  mobileHeaderLastScrollTop = top;
  // Content that shrinks back to the top must not leave the header hidden.
  if (mobileHeaderCollapsed && !mobileHeaderLayoutPending && top <= 2) { setMobileHeaderCollapsed(false); return; }
  // Focus/scrollIntoView must not hide navigation while a control is used.
  if (!mobileAnalysisActive || mobileHeaderLayoutPending || performance.now() > mobileScrollIntentUntil) {
    mobileHeaderScrollDistance = 0;
    return;
  }
  if (top <= 2) { setMobileHeaderCollapsed(false); return; }
  if (!delta) return;
  const direction = Math.sign(delta);
  if (direction !== mobileHeaderScrollDirection) mobileHeaderScrollDistance = 0;
  mobileHeaderScrollDirection = direction;
  mobileHeaderScrollDistance += Math.abs(delta);
  if (mobileHeaderScrollDistance >= 24) setMobileHeaderCollapsed(direction > 0);
}, {passive: true});

function syncMobileAnalysisLayout() {
  const active = document.body.classList.contains("analysis-theme")
    && mobileAnalysisQuery.matches && !document.fullscreenElement;
  mobileStructureInfo.hidden = !active || structureInfoPanel.hidden;
  mobileStructureInfoButton.hidden = mobileStructureInfo.hidden;
  if (active === mobileAnalysisActive) {
    measureMobileHeader();
    if (viewerWorkspace.hidden) setMobileHeaderCollapsed(false);
    return;
  }
  mobileAnalysisActive = active;
  document.body.classList.toggle("mobile-analysis-layout", active);
  if (active) {
    analysisTopbarPlaceholder.after(mobileHeaderFrame);
    mobileHeaderFrame.append(analysisTopbar);
    measureMobileHeader();
    mobileAnalysisControls.append(workspaceControls);
    mobileStructureInfo.append(structureInfoPanel);
    selectedOperationDialog.append(operationInfoPanel);
  } else {
    setMobileHeaderCollapsed(false);
    finishMobileHeaderAnimation();
    if (selectedOperationDialog.open) selectedOperationDialog.close();
    analysisTopbarPlaceholder.after(analysisTopbar);
    mobileHeaderFrame.remove();
    for (const [panel, placeholder] of mobilePanelPlaceholders) placeholder.after(panel);
  }
  mobileAnalysisControls.hidden = !active;
  mobileHeaderLastScrollTop = mobileAnalysisControls.scrollTop;
  renderSelectedOperationOverlay();
}

function moveAnimationPanelIntoFullscreenControls() {
  if (fullscreenAnimationDetails.parentElement === animationPanel) return;
  fullscreenAnimationDetails.append(...animationPanel.childNodes);
  animationPanel.append(fullscreenAnimationDetails);
  fullscreenAnimationDetails.open = true;
}

function restoreAnimationPanelFromFullscreenControls() {
  if (fullscreenAnimationDetails.parentElement !== animationPanel) return;
  animationPanel.replaceChildren(
    ...[...fullscreenAnimationDetails.childNodes].filter(node => node !== fullscreenAnimationSummary),
  );
}

function syncFullscreenControlsLayout() {
  closeCameraSaveOptions();
  closeAnimationOptions();
  const fullscreen = document.fullscreenElement === threeViewPanel;
  if (fullscreen) {
    document.querySelector(".fullscreen-operations-heading").append(improperModeControl);
    fullscreenControlsContent.append(viewPanel, animationPanel, utilityPanel);
    moveAnimationPanelIntoFullscreenControls();
  } else {
    improperModePlaceholder.after(improperModeControl);
    cameraPanelPlaceholder.after(viewPanel);
    utilityPanelPlaceholder.after(utilityPanel);
    restoreAnimationPanelFromFullscreenControls();
    animationPanelPlaceholder.after(animationPanel);
    fullscreenControls.open = false;
  }
  threeViewPanel.classList.toggle("fullscreen-controls-open", fullscreen && fullscreenControls.open);
}

fullscreenControls.addEventListener("toggle", () => {
  if (document.fullscreenElement === threeViewPanel) {
    syncFullscreenControlsLayout();
  }
});

const fullscreenButton = document.getElementById("toggle-view-fullscreen");

function syncFullscreenButton() {
  const active = document.fullscreenElement === threeViewPanel;
  fullscreenButton.hidden = mobileAnalysisQuery.matches && !active;
  const path = active
    ? "M8 3v5H3m13-5v5h5M3 16h5v5m13-5h-5v5"
    : "M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5";
  fullscreenButton.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></svg>`;
  const label = active ? "全画面を終了する" : "全画面にする";
  fullscreenButton.setAttribute("aria-label", label);
  fullscreenButton.title = label;
}

window.addEventListener("symmetry-operation-view-change", event => {
  if (event.target !== document.getElementById("three-view")) return;
  const button = document.getElementById("view-direction");
  button.disabled = !event.detail.available;
  button.title = event.detail.available
    ? "選択中の対称操作に合わせて視点を変更"
    : "この操作には視点を合わせる方向がありません";
});

fullscreenButton.addEventListener("click", async () => {
  try {
    if (document.fullscreenElement === threeViewPanel) {
      await document.exitFullscreen();
    } else if (!mobileAnalysisQuery.matches) {
      await threeViewPanel.requestFullscreen();
    }
  } catch (error) {
    document.getElementById("status").textContent = `Full screen error: ${error.message || error}`;
  }
});
document.addEventListener("fullscreenchange", () => {
  const entering = document.fullscreenElement === threeViewPanel;
  if (entering) {
    fullscreenControls.open = false;
  }
  syncFullscreenButton();
  syncFullscreenControlsLayout();
  scheduleWorkspaceScrolling();
});
window.addEventListener("resize", () => {
  mobileScrollIntentUntil = 0;
  scheduleWorkspaceScrolling();
});
// Phones (same condition as the phone layouts) get touch wording in the
// guides under the analysis and quiz structures.
const interactionGuideLines = [
  document.querySelector(".structure-interaction-guide > p:first-child"),
  document.querySelector("#puzzle-interaction-guide > p"),
].filter(Boolean);
const desktopInteractionGuide = interactionGuideLines.map(line => line.textContent);
function syncInteractionGuideText() {
  interactionGuideLines.forEach((line, index) => {
    line.textContent = mobileAnalysisQuery.matches
      ? "1本指：回転／2本指：移動・拡大・縮小／タップ：選択"
      : desktopInteractionGuide[index];
  });
}
syncInteractionGuideText();
mobileAnalysisQuery.addEventListener("change", () => {
  syncInteractionGuideText();
  mobileScrollIntentUntil = 0;
  if (mobileAnalysisQuery.matches && document.fullscreenElement === threeViewPanel) {
    document.exitFullscreen().catch(error => {
      document.getElementById("status").textContent = `Full screen error: ${error.message || error}`;
    });
  }
  syncFullscreenButton();
  scheduleWorkspaceScrolling();
});
new ResizeObserver(scheduleWorkspaceScrolling).observe(document.querySelector(".topbar"));
new ResizeObserver(scheduleWorkspaceScrolling).observe(mobileHeaderFrame);
// Sideways, the one-line header keeps its size when structure info appears.
new MutationObserver(scheduleWorkspaceScrolling).observe(structureInfoPanel, {attributes: true, attributeFilter: ["hidden"]});
syncFullscreenButton();

function scheduleWorkspaceScrolling() {
  if (workspaceResizeFrame !== null) return;
  workspaceResizeFrame = requestAnimationFrame(syncWorkspaceScrolling);
}

function syncWorkspaceScrolling() {
  workspaceResizeFrame = null;
  syncMobileAnalysisLayout();
  const examplePicker = document.getElementById("example-picker");
  if (!examplePicker.querySelector(".rich-select-menu").hidden) positionRichSelectMenu(examplePicker);
  // Header/info changes can move the canvas without changing its size.
  // Refresh the pointer coordinates as well as the drawing viewport.
  if (mobileAnalysisActive) window.symmetryThreeView?.resize();
  const workspace = document.querySelector(".viewer-workspace");
  const active = document.body.matches(".analysis-theme.advanced-mode")
    && window.matchMedia("(min-width: 981px)").matches
    && !document.fullscreenElement && !workspace.hidden;
  document.body.classList.toggle("independent-primary-scroll", active);
  const region = document.querySelector(".viewer-primary");
  if (active) {
    region.tabIndex = 0;
    region.setAttribute("role", "region");
    region.setAttribute("aria-label", "構造と選択中の操作");
  } else {
    region.removeAttribute("tabindex");
    region.removeAttribute("role");
    region.removeAttribute("aria-label");
  }
  if (!active) return;
  const top = workspace.getBoundingClientRect().top + window.scrollY;
  workspace.style.setProperty("--analysis-workspace-top", `${top}px`);
  const bottom = parseFloat(getComputedStyle(document.querySelector("main")).paddingBottom) || 0;
  const height = `${Math.max(180, window.innerHeight - top - bottom)}px`;
  if (workspace.style.getPropertyValue("--analysis-workspace-height") !== height) {
    workspace.style.setProperty("--analysis-workspace-height", height);
  }
}

async function api(path, options) {
  // Periodic read-only state checks do not interrupt ordinary observation.
  if (path === "/api/state" && !options?.method) return apiReady(path, options);
  return analysisWaiting.run(() => apiReady(path, options));
}

async function apiReady(path, options) {
  const response = await viewFetch(path, options);
  if (response.status === 204) return null;
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch (_error) {
      body = null;
    }
  }
  if (!response.ok) {
    const message = body && (body.message || body.error) ? (body.message || body.error) : (text || `${response.status} ${response.statusText}`);
    throw new Error(message);
  }
  return body;
}

function operationPresentation(operation) {
  return operation.presentations?.default || null;
}

function presentationSymbol(operation, withSense = false) {
  const presentation = operationPresentation(operation);
  const explicitOperation = withSense && (presentation?.operation_symbol !== undefined || presentation?.itc_symbol !== undefined);
  const symbol = explicitOperation ? presentation.operation_symbol ?? presentation.itc_symbol : presentation?.symbol;
  if (!symbol) return "";
  const sense = withSense && presentation.notation_order > 2 ? `<sup>${presentation.rotation_angle_deg < 0 ? "−" : "+"}</sup>` : "";
  const base = symbol.replace(/\+t$/, "");
  return (sourceKind === "molecule" ? formatMolecularSymbol(base) : formatItcLikeSymbol(base)).replace(/S(\d+)/g, "S<sub>$1</sub>")
    .replace(/\^(\d+)/g, "<sup>$1</sup>") + sense + (explicitOperation ? presentation.translation_label :
      symbol.endsWith("+t") ? (withSense ? presentation.translation_label || "＋t" : "＋t") : "");
}

function optionText(operation) {
  const presentation = operationPresentation(operation);
  if (presentation) {
    if (experienceMode === "beginner") return beginnerOperationText(operation);
    const symbol = presentationSymbol(operation, true);
    return experienceMode === "beginner" ? symbol
      : `op ${operation.index}: ${symbol}${presentation.geometry ? " " + formatItcLikeSymbol(presentation.geometry) : ""}`;
  }
  if (sourceKind === "molecule") {
    const symbol = molecularSchoenfliesSymbol(operation);
    return experienceMode === "beginner" ? symbol : `op ${operation.index}: ${symbol}`;
  }
  if (experienceMode === "beginner") return beginnerOperationText(operation);
  const itc = operation.itc_like_summary || operation.itc_coordinate_summary;
  return `op ${operation.index}: ${formatItcLikeSymbol(itc || displayOperationSymbol(operation))}`;
}

function molecularSchoenfliesSymbol(operation) {
  return formatMolecularSymbol(operation.symbol || operation.display_symbol || "?");
}

function formatMolecularSymbol(value) {
  const symbol = String(value);
  const mirror = symbol.match(/^sigma(?:_([vhd]))?$/);
  if (mirror) return mirror[1] ? `σ<sub>${mirror[1]}</sub>` : "σ";
  const match = symbol.match(/^([CS])(\d+|∞)$/);
  return match ? `${match[1]}<sub>${match[2]}</sub>` : formatSymbol(symbol);
}

// Simple crystal rows add the axis [uvw] or plane (hkl) so that operations of
// the same kind can be told apart. Molecules get no suffix.
function beginnerOperationText(operation) {
  const text = beginnerOperationBaseText(operation);
  if (sourceKind !== "crystal") return text;
  const direction = crystalDirectionSuffix(operation);
  return direction ? `${text}　${direction}` : text;
}

function crystalDirectionSuffix(operation) {
  const match = String(operation.direction_sort_key || "").match(/^(axis|plane):(.+)$/);
  if (!match) return "";
  const indices = integerIndices(match[2].trim().split(/[\s,]+/).map(Number));
  if (!indices) return "";
  const text = indices.map(value => value < 0 ? `<span class="overline">${-value}</span>` : String(value)).join(" ");
  return match[1] === "axis" ? `[${text}]` : `(${text})`;
}

// Smallest integer vector parallel to the given one (first nonzero positive), or null.
function integerIndices(vector) {
  if (vector.length !== 3 || vector.some(value => !Number.isFinite(value))) return null;
  const largest = Math.max(...vector.map(Math.abs));
  if (largest < 1e-9) return null;
  const unit = vector.map(value => value / largest);
  for (let scale = 1; scale <= 12; scale += 1) {
    const scaled = unit.map(value => value * scale);
    if (!scaled.every(value => Math.abs(value - Math.round(value)) < 1e-6)) continue;
    let ints = scaled.map(value => Math.round(value) || 0);
    const gcd = (a, b) => b ? gcd(b, a % b) : a;
    const divisor = ints.reduce((value, item) => gcd(value, Math.abs(item)), 0) || 1;
    ints = ints.map(value => value / divisor);
    const first = ints.find(value => value !== 0);
    return first < 0 ? ints.map(value => -value || 0) : ints;
  }
  return null;
}

// Crystal lattice translations within the cell: 0 and centring vectors (t operations).
function cellLatticeTranslations() {
  return [[0, 0, 0], ...operations
    .filter(item => item.kind === "translation" && Array.isArray(item.translation_frac))
    .map(item => item.translation_frac)];
}

// A glide whose glide vector (t + Wt)/2 is a lattice translation; its element is a mirror.
function isLatticeGlide(operation) {
  if (sourceKind !== "crystal" || operation.kind !== "glide") return false;
  const W = operation.matrix_frac;
  const t = operation.translation_frac;
  if (!Array.isArray(W) || !Array.isArray(t)) return false;
  const glide = [0, 1, 2].map(i => (t[i] + W[i].reduce((sum, value, k) => sum + value * t[k], 0)) / 2);
  return cellLatticeTranslations().some(vector => glide.every((value, i) => {
    const difference = value - vector[i];
    return Math.abs(difference - Math.round(difference)) < 1e-6;
  }));
}

function beginnerOperationBaseText(operation) {
  const presentation = operationPresentation(operation);
  if (presentation) {
    if (isLatticeGlide(operation)) return "m（鏡映）：鏡写し＋格子並進";
    const symbol = operation.kind === "glide" ? "g" : presentationSymbol(operation);
    if (operation.continuous) return `${symbol}（無限回回転）：任意角度の回転`;
    const shortDescription = {identity: "変化なし", mirror: "鏡写し", inversion: "点対称移動"}[operation.kind];
    if (shortDescription) return `${symbol}（${presentation.reading}）：${shortDescription}`;
    // A "screw" whose axial shift is a whole lattice translation keeps the plain
    // symbol (e.g. 2, ITC 2(1/2,1/2,0)); its element is a rotation axis.
    const latticeScrew = operation.kind === "screw" && /^\d+$/.test(String(presentation.symbol || ""));
    const reading = latticeScrew ? String(presentation.reading).replace(/らせん$/, "回転") : presentation.reading;
    if (!Array.isArray(presentation.motion_steps)) return `${symbol}（${reading}）`;
    const actions = presentation.motion_steps.map(step => {
      if (step.kind === "rotation") {
        return `${Number(Math.abs(step.angle_degrees).toFixed(6))}°回転`;
      }
      if (step.kind === "translation" && latticeScrew) return "格子並進";
      return {reflection: "鏡映", inversion: "反転", translation: "平行移動"}[step.kind];
    });
    return `${symbol}（${reading}）：${actions.join("＋") || "恒等操作"}`;
  }
  const kind = String(operation.kind || "").toLowerCase();
  const reportedAngle = operation.angle_deg;
  const matrixOrder = Number(operation.order);
  const notationOrder = improperNotationOrder(operation);
  const fallbackOrder = isImproperOperation(operation) ? notationOrder : matrixOrder;
  const angle = isImproperOperation(operation) && Number.isFinite(notationOrder) && notationOrder > 1
    ? 360 / notationOrder
    : reportedAngle !== null && reportedAngle !== undefined && Number.isFinite(Number(reportedAngle))
      ? Math.abs(Number(reportedAngle))
      : (Number.isFinite(fallbackOrder) && fallbackOrder > 1 ? 360 / fallbackOrder : 0);
  const angleText = Number.isFinite(angle) && angle > 1e-6
    ? `${Math.round(angle)}°`
    : "";
  const symbol = beginnerOperationSymbol(operation);
  const reading = beginnerOperationReading(operation);
  const label = `${symbol} (${reading})`;
  if (kind === "identity") return `${label}:恒等操作`;
  if (kind.includes("screw")) return `${label}:${angleText}回転+平行移動`;
  if (kind.includes("glide")) return `${label}:鏡映+平行移動`;
  if (kind.includes("mirror")) return `${label}:鏡映`;
  if (kind.includes("inversion") && !kind.includes("roto")) return `${label}:反転`;
  if (kind.includes("improper") || kind.includes("rotoinversion") || kind.includes("rotoreflection")) {
    return `${label}:${angleText}回転+反転`;
  }
  if (kind.includes("rotation")) return `${label}:${angleText}回転`;
  if (kind.includes("translation")) return `${label}:平行移動`;
  return `${label}:対称操作`;
}

function beginnerOperationSymbol(operation) {
  const kind = String(operation.kind || "").toLowerCase();
  const order = improperNotationOrder(operation);
  if (kind.includes("glide")) return isLatticeGlide(operation) ? "m" : "g";
  if (kind.includes("improper") || kind.includes("rotoinversion") || kind.includes("rotoreflection")) {
    return `<span class="overline">${order}</span>`;
  }
  if (kind.includes("inversion")) return '<span class="overline">1</span>';
  return formatSymbol(operation.display_symbol || operation.symbol || "?");
}

function beginnerOperationReading(operation) {
  const presentation = operationPresentation(operation);
  if (presentation) {
    if (sourceKind === "crystal" && experienceMode === "advanced" && presentation.reading === "映進") {
      return `${presentation.symbol}映進`;
    }
    return presentation.reading;
  }
  const kind = String(operation.kind || "").toLowerCase();
  const order = isImproperOperation(operation) ? improperNotationOrder(operation) : (operation.order || "");
  if (kind === "identity") return "恒等";
  if (kind.includes("screw")) return `${order}回らせん`;
  if (kind.includes("glide")) return sourceKind === "crystal" && experienceMode === "advanced"
    ? `${operation.display_symbol || "g"}映進` : "映進";
  if (kind.includes("mirror")) return "鏡映";
  if (kind.includes("inversion") && !kind.includes("roto")) return "反転";
  if (kind.includes("improper") || kind.includes("rotoinversion") || kind.includes("rotoreflection")) {
    return `${order}回${sourceKind === "molecule" ? "回映" : "回反"}`;
  }
  if (kind.includes("rotation")) return `${order}回回転`;
  if (kind.includes("translation")) return "並進";
  return "対称操作";
}

function renderHtml(text) {
  const template = document.createElement("template");
  template.innerHTML = text;
  return template.content;
}

function positionRichSelectMenu(picker) {
  const menu = picker.querySelector(".rich-select-menu");
  if (mobileAnalysisActive && !menu.hidden) {
    const trigger = picker.querySelector(".rich-select-trigger").getBoundingClientRect();
    menu.style.maxHeight = `${Math.max(0, Math.min(320, window.innerHeight - trigger.bottom - 12))}px`;
  } else {
    menu.style.removeProperty("max-height");
  }
}

function setRichSelectOpen(pickerId, open) {
  const picker = document.getElementById(pickerId);
  const trigger = picker.querySelector(".rich-select-trigger");
  const menu = picker.querySelector(".rich-select-menu");
  menu.hidden = !open;
  trigger.setAttribute("aria-expanded", String(open));
  positionRichSelectMenu(picker);
}

function installRichSelectToggle(pickerId) {
  const picker = document.getElementById(pickerId);
  picker.querySelector(".rich-select-trigger").addEventListener("click", event => {
    event.stopPropagation();
    const menu = picker.querySelector(".rich-select-menu");
    for (const other of document.querySelectorAll(".rich-select")) {
      setRichSelectOpen(other.id, other === picker && menu.hidden);
    }
  });
}

installRichSelectToggle("example-picker");
document.addEventListener("click", () => {
  for (const picker of document.querySelectorAll(".rich-select")) setRichSelectOpen(picker.id, false);
});

function formatSymbol(symbol) {
  const subscripts = "₀₁₂₃₄₅₆";
  return String(symbol)
    .replace(/sigma/g, "σ")
    .replace(/_([0-6])/g, (_, digit) => subscripts[Number(digit)]);
}

function formatItcLikeSymbol(symbol) {
  return formatSymbol(symbol)
    .replace(/^\s*-([0-9]+)/, '<span class="overline">$1</span>')
    .replace(/-((?:\d+)?[xyz])/g, '<span class="overline">$1</span>')
    .replace(/^(\s*(?:<span class="overline">\d<\/span>|\d(?:[₀₁₂₃₄₅₆])?))([+-])/, '$1<sup>$2</sup>');
}

function formatPlainOverbar(symbol) {
  return String(symbol).replace(/-([0-9]+)/g, (_, digits) =>
    [...digits].map(digit => `${digit}\u0305`).join(""));
}

function stripHtmlWithOverbars(value) {
  const withUnicodeOverbars = String(value).replace(
    /<span class="overline">([^<]+)<\/span>/g,
    (_, text) => [...text].map(character => `${character}\u0305`).join(""),
  );
  return stripHtml(withUnicodeOverbars);
}

function formatGroupSymbol(symbol) {
  const text = String(symbol);
  // Schoenflies symbols, with or without "_": D6h, C_2h, O_h.
  const schoenflies = text.match(/^([CDSTOI])_?((?:\d+|∞)?[a-z]*)$/);
  if (schoenflies && schoenflies[2]) return `${schoenflies[1]}<sub>${schoenflies[2]}</sub>`;
  return text
    .replace(/sigma/g, "σ")
    // Hermann–Mauguin screw subscripts are one digit: P3_221 is P3₂21.
    .replace(/_([0-9])/g, "<sub>$1</sub>")
    .replace(/-([0-9]+)/g, '<span class="overline">$1</span>');
}

function resolvedImproperMode() {
  if (experienceMode === "beginner") return "default";
  return ["default", "rotoinversion", "rotoreflection"].includes(state.improper_mode)
    ? state.improper_mode : "default";
}

function isImproperOperation(operation) {
  const kind = String(operation.kind || "");
  return kind.includes("improper") || kind.includes("rotoinversion") || kind.includes("rotoreflection");
}

function improperNotationOrder(operation) {
  const suppliedOrder = Number(operation.notation_order);
  if (Number.isFinite(suppliedOrder) && suppliedOrder > 0) return suppliedOrder;
  const symbol = String(operation.symbol || operation.display_symbol || "");
  const match = symbol.match(/[0-9]+/);
  if (match) return Number(match[0]);
  const matrixOrder = Number(operation.order);
  return Number.isFinite(matrixOrder) ? matrixOrder : 0;
}

function displayOperationSymbol(operation) {
  return presentationSymbol(operation) || operation.display_symbol || operation.symbol || "";
}

function atomDisplayLabel(atom) {
  if (sourceKind !== "crystal" || atom.asymmetric_index === null || atom.asymmetric_index === undefined) {
    return atom.element;
  }
  const siteIndices = [...new Set(
    atoms
      .filter(item => item.element === atom.element && item.asymmetric_index !== null && item.asymmetric_index !== undefined)
      .map(item => Number(item.asymmetric_index))
  )].sort((a, b) => a - b);
  const ordinal = siteIndices.indexOf(Number(atom.asymmetric_index));
  if (siteIndices.length <= 1) return atom.element;
  return ordinal >= 0 ? `${atom.element}${ordinal + 1}` : atom.element;
}

function formatVector(values, formatter) {
  return `(${values.map(value => withMinusSign(formatter(value))).join(", ")})`;
}

// Display text uses U+2212 for negative signs (not inside exponents such as 1e-7).
function withMinusSign(text) {
  return String(text).replace(/(?<![eE])-/g, "−");
}

// Chemical formulas: digit runs become subscripts (SiO2 -> SiO₂).
function formatChemicalFormula(text) {
  return escapeText(text).replace(/(\d+)/g, "<sub>$1</sub>");
}

function escapeText(text) {
  return String(text).replace(/[&<>"']/g, character =>
    ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"})[character]);
}

function plainChemicalFormula(text) {
  return String(text).replace(/\d/g, digit => "₀₁₂₃₄₅₆₇₈₉"[Number(digit)]);
}

function formatFrac(value) {
  return fmtFrac(value);
}

function formatCoord(value) {
  const number = Number(value);
  return Number.isFinite(number) ? String(Number(number.toFixed(3))) : "?";
}

function normalizeColor(value, fallback = "#9aa5b1") {
  const text = String(value || "").trim();
  if (/^#[0-9a-fA-F]{6}$/.test(text)) return text.toLowerCase();
  return fallback;
}

function atomEffectiveColor(atom) {
  const atomColors = state.atom_colors || {};
  const elementColors = state.element_colors || {};
  return normalizeColor(
    atomColors[String(atom.index)] || elementColors[atom.element] || atom.default_color,
  );
}

function atomVisible(atom) {
  const atomHidden = state.atom_hidden || {};
  const elementHidden = state.element_hidden || {};
  return !elementHidden[atom.element] && !atomHidden[String(atom.index)];
}

function atomVisibilityUpdate(atom, visible) {
  const atomHidden = Object.assign({}, state.atom_hidden || {});
  const elementHidden = Object.assign({}, state.element_hidden || {});
  if (visible) {
    atomHidden[String(atom.index)] = true;
  } else {
    delete atomHidden[String(atom.index)];
    if (elementHidden[atom.element]) {
      delete elementHidden[atom.element];
      for (const peer of atoms) {
        if (peer.element === atom.element && peer.index !== atom.index) {
          atomHidden[String(peer.index)] = true;
        }
      }
    }
  }
  return {atom_hidden: atomHidden, element_hidden: elementHidden, playing: false, reset: true};
}

function resetAtomAppearance() {
  return postState({
    element_colors: {},
    atom_colors: {},
    element_hidden: {},
    atom_hidden: {},
    playing: false,
    reset: true,
  });
}

function visibilityButton(visible, title, onToggle) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `visibility-toggle${visible ? "" : " hidden"}`;
  button.textContent = visible ? "Visible" : "Hidden";
  button.title = title;
  button.setAttribute("aria-label", title);
  button.addEventListener("click", onToggle);
  return button;
}

async function selectStandardOperation(operation) {
  activeMode = "standard";
  operationInformationSignature = "";
  customUnmappedAtoms = new Set();
  invalidateCustomSequenceWork();
  syncActiveModeControls();
  await postState({
    active_mode: "standard",
    operation_index: operation.index,
    operation_repetitions: 1,
    playing: false,
    reset: true,
    clear_custom_check: true,
  });
}

function buildOperationRow(operation) {
  const text = optionText(operation);
  const entry = document.createElement("div");
  entry.className = "operation-entry";
  const row = document.createElement("button");
  row.type = "button";
  row.className = "operation-row";
  row.dataset.index = operation.index;
  row.setAttribute("role", "option");
  row.setAttribute("aria-selected", operation.index === state.operation_index ? "true" : "false");
  if (operation.index === state.operation_index) row.classList.add("selected");
  row.appendChild(renderHtml(text));
  row.title = stripHtmlWithOverbars(text);
  row.addEventListener("click", () => selectStandardOperation(operation));
  entry.appendChild(row);
  return entry;
}

function mathExponential(radius, exponent) {
  const exponentMath = mathExpression(exponent, true);
  exponentMath.setAttribute("class", "operation-math-exponent");
  const power = mathNode("msup", mathNode("mi", "e"), exponentMath);
  return radius === "1" ? power : mathNode("mrow", mathExpression(radius, true), mathNode("mo", "⁢"), power);
}

function compactPresentationExpression(text) {
  // Format only decimal tokens for reading. Keep validated fractions and the
  // original presentation/model data intact; a small nonzero stays nonzero.
  return String(text).replace(/\d+\.\d+(?:e[+-]?\d+)?|\d+e[+-]?\d+/gi,
    token => String(Number(Number(token).toPrecision(4))));
}

function renderInformationFormula(root, transform) {
  root.classList.add("math-formula");
  root.replaceChildren();
  if (!transform.W && !transform.coordinate_formula) return;
  const coordinates = transform.coordinate_formula || SymmetryOperationMath.coordinateExpressions(transform, true);
  root.setAttribute("role", "math");
  root.setAttribute("aria-label", transform.coordinate_formula
    ? `(x,y,z) ↦ (${coordinates.join(", ")})` : SymmetryOperationMath.formula(transform, true));
  const math = mathNode("math");
  const row = mathNode("mrow");
  function tuple(values) {
    row.append(mathNode("mo", "("));
    values.forEach((value, i) => {
      if (i) row.append(mathNode("mo", ","));
      const item = mathExpression(value, true);
      item.setAttribute("class", "mathml-coordinate");
      row.append(item);
    });
    row.append(mathNode("mo", ")"));
  }
  tuple(["x", "y", "z"]);
  row.append(mathNode("mo", "↦"));
  tuple(coordinates.map(compactPresentationExpression));
  // Compact tuple formulas; leave matrices and eigenspaces alone.
  for (const operator of row.querySelectorAll("mo")) {
    const text = operator.textContent;
    if (text === "(" || text === ")") {
      operator.setAttribute("stretchy", "false");
      operator.setAttribute("lspace", "0");
      operator.setAttribute("rspace", "0");
    } else if (text === ",") {
      operator.setAttribute("lspace", "0");
      operator.setAttribute("rspace", "0.08em");
    } else if (text === "↦") {
      operator.setAttribute("lspace", "0.2em");
      operator.setAttribute("rspace", "0.2em");
    } else if (text === "+" || text === "−") {
      operator.setAttribute("lspace", operator.previousElementSibling ? "0.08em" : "0");
      operator.setAttribute("rspace", "0.08em");
    }
  }
  math.append(row);
  root.append(math);
}

const EIGENSPACE_ROLES = {
  "回転軸方向": "回転軸に平行な方向",
  "軸に垂直（基底）": "回転軸に垂直な面を張るベクトル",
  "鏡映面に平行（基底）": "鏡映面を張るベクトル",
  "鏡映面の法線方向": "鏡映面に垂直な方向",
  "回転軸方向（反転）": "回反・回映の軸に平行な方向",
  "回転面内の複素方向": "実部と虚部が、回転軸に垂直な面を張る",
};

function hideEigenInfoTooltip() {
  document.getElementById("operation-eigen-tooltip")?.remove();
  document.querySelectorAll('.operation-eigen-info[aria-describedby]').forEach(info => info.removeAttribute("aria-describedby"));
}

function showEigenInfoTooltip(info) {
  hideEigenInfoTooltip();
  const tooltip = document.createElement("div");
  tooltip.id = "operation-eigen-tooltip";
  tooltip.setAttribute("role", "tooltip");
  tooltip.textContent = info.dataset.description;
  document.body.appendChild(tooltip);
  info.setAttribute("aria-describedby", tooltip.id);
  const anchor = info.getBoundingClientRect();
  const box = tooltip.getBoundingClientRect();
  tooltip.style.left = `${Math.max(8, Math.min(anchor.left, innerWidth - box.width - 8))}px`;
  const below = anchor.bottom + 6;
  tooltip.style.top = `${Math.max(8, below + box.height <= innerHeight - 8 ? below : anchor.top - box.height - 6)}px`;
}

window.addEventListener("scroll", hideEigenInfoTooltip, true);
window.addEventListener("resize", hideEigenInfoTooltip);

let operationMathLayoutFrame = 0;
let operationMathResizeObserver = null;
function scheduleOperationMathLayout() {
  if (!operationMathResizeObserver) {
    operationMathResizeObserver = new ResizeObserver(scheduleOperationMathLayout);
    operationMathResizeObserver.observe(document.getElementById("operation-info-panel"));
    document.fonts.addEventListener("loadingdone", scheduleOperationMathLayout);
    document.fonts.ready.then(scheduleOperationMathLayout);
  }
  if (operationMathLayoutFrame) return;
  operationMathLayoutFrame = requestAnimationFrame(() => {
    operationMathLayoutFrame = 0;
    fitOperationMath();
  });
}

function fitOperationMath() {
  const panel = document.getElementById("operation-info-panel");
  if (!panel?.open || !panel.getBoundingClientRect().width) return;
  for (const viewport of panel.querySelectorAll('.operation-playback-viewport')) {
    const rows = viewport.querySelectorAll('.operation-playback-step');
    if (rows.length > 3) {
      const css = getComputedStyle(viewport);
      const borders = parseFloat(css.borderTopWidth) + parseFloat(css.borderBottomWidth);
      const scrollbar = viewport.offsetHeight - viewport.clientHeight - borders;
      const fourth = rows[3].getBoundingClientRect();
      const height = fourth.top - rows[0].getBoundingClientRect().top + fourth.height / 2;
      viewport.style.maxHeight = `${height + parseFloat(css.paddingTop) + borders + scrollbar}px`;
    } else viewport.style.removeProperty('max-height');
  }
  // Measure the approved fixed-size layout without changing its font or arrangement.
  for (const card of panel.querySelectorAll(".operation-vector-transform")) {
    card.dataset.mathLayout = "side";
    const equation = card.querySelector(".operation-vector-equation > math");
    const eigen = card.querySelector(".operation-eigenpairs");
    if (!eigen) continue;
    const css = getComputedStyle(card);
    const available = card.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight);
    const required = equation.getBoundingClientRect().width + eigen.getBoundingClientRect().width + 20;
    card.dataset.mathFits = String(required <= available + 1);
    // Center only the divider in the visible gap; leave both formula regions in place.
    const mainBounds = equation.getBoundingClientRect();
    const eigenStart = eigen.querySelector("h5").getBoundingClientRect().left + eigen.scrollLeft;
    const equationBlock = equation.parentElement;
    const dividerCenter = (mainBounds.right + eigenStart) / 2;
    equationBlock.style.setProperty("--operation-divider-offset",
      `${dividerCenter - equationBlock.getBoundingClientRect().left}px`);
  }
}

function appendInformationTransform(root, transform, fractional, fractionalTransform = null, showEigenvectors = true) {
  const card = document.createElement("section");
  card.className = "operation-information-transform operation-vector-transform";
  card.classList.toggle('operation-vector-transform-no-caption', fractional);
  if (!fractional) {
    const title = document.createElement('h4');
    title.textContent = 'Cartesian (Å)';
    card.appendChild(title);
  }
  const equation = document.createElement("div");
  equation.className = "operation-vector-equation";
  equation.setAttribute("aria-label", "x′ = W x + t");
  const math = mathNode("math");
  math.setAttribute("display", "block");
  const expression = mathNode("mrow");
  function matrix(label, values, formatter = String) {
    expression.append(mathMatrix(values, formatter, label, true));
  }
  const operator = text => expression.append(mathNode("mo", text));
  matrix("x′", [["x′"], ["y′"], ["z′"]]);
  operator("=");
  matrix("W", transform.W, SymmetryOperationMath.number);
  matrix("x", [["x"], ["y"], ["z"]]);
  operator("+");
  matrix("t", transform.t.map(v => [v]), SymmetryOperationMath.number);
  operator("=");
  matrix("", SymmetryOperationMath.coordinateExpressions(transform, true).map(v => [v]));
  math.append(expression);
  const equationHeading = document.createElement("h5");
  equationHeading.textContent = "行列表示";
  // Same 「行列の読み方」 window as the quiz's 行列で見る.
  const help = document.createElement("button");
  help.type = "button";
  help.className = "puzzle-matrix-help";
  help.setAttribute("aria-haspopup", "dialog");
  help.setAttribute("aria-label", "行列の読み方");
  help.textContent = "ⓘ";
  help.addEventListener("click", openMatrixHelp);
  equationHeading.append(help);
  equation.append(equationHeading, math);
  if (!showEigenvectors) {
    card.classList.add("operation-transform-matrix-only");
    card.appendChild(equation);
    root.appendChild(card);
    scheduleOperationMathLayout();
    return;
  }
  const eigen = document.createElement("section");
  eigen.className = "operation-eigenpairs";
  const eigenHeading = document.createElement("h5");
  eigenHeading.textContent = "固有ベクトル";
  eigen.appendChild(eigenHeading);
  const exactPairs = SymmetryOperationMath.exactEigenpairs(transform.W);
  const referencePairs = fractionalTransform ? SymmetryOperationMath.exactEigenpairs(fractionalTransform.W) : null;
  const numericalPairs = SymmetryOperationMath.eigenpairs(transform.W);
  const pairs = exactPairs || numericalPairs;
  const spaces = new Map();
  for (const [index, pair] of pairs.entries()) {
    const key = JSON.stringify(pair.value);
    if (!spaces.has(key)) spaces.set(key, {
      value: pair.value,
      role: EIGENSPACE_ROLES[numericalPairs[index].description],
      exactValueText: pair.valueText ?? referencePairs?.[index]?.valueText,
      valueText: pair.valueText ?? referencePairs?.[index]?.valueText
        ?? SymmetryOperationMath.complexNumber(pair.value),
      basis: [],
    });
    spaces.get(key).basis.push(pair);
  }
  eigen.style.setProperty("--eigen-count", spaces.size);
  for (const space of spaces.values()) {
    const row = document.createElement("div");
    row.className = "operation-eigenpair";

    const value = document.createElement("span");
    value.className = "operation-eigenvalue";
    const exponent = SymmetryOperationMath.eigenvalueExponent(space.value, space.exactValueText);
    const eigenvalue = exponent ? mathExponential("1", exponent) : mathExpression(space.valueText);
    value.append(mathNode("math", mathNode("mrow", mathNode("mi", "λ"), mathNode("mo", "="), eigenvalue)));
    const combination = document.createElement("div");
    combination.className = "operation-eigenvector-line";
    const combinationMath = mathNode("math");
    combinationMath.setAttribute("display", "block");
    const combinationRow = mathNode("mrow");
    for (const [index, pair] of space.basis.entries()) {
      if (index) combinationRow.append(mathNode("mo", "+"));
      combinationRow.append(mathNode("mi", ["s", "t", "u"][index]));
      const components = pair.vector.map((component, i) => {
        const polar = SymmetryOperationMath.complexPolar(component, pair.vectorPolar?.[i]);
        return [polar ? mathExponential(polar.radius, polar.exponent)
          : mathExpression(pair.vectorText?.[i] ?? SymmetryOperationMath.complexNumber(component), true)];
      });
      combinationRow.append(mathMatrix(components, value => value));
    }
    combinationMath.append(combinationRow);
    combination.append(combinationMath);
    if (space.role) {
      const info = document.createElement("span");
      info.className = "operation-eigen-info";
      info.textContent = "ⓘ";
      info.dataset.description = space.role;
      info.setAttribute("role", "img");
      info.setAttribute("aria-label", info.dataset.description);
      info.tabIndex = 0;
      info.addEventListener("mouseenter", () => showEigenInfoTooltip(info));
      info.addEventListener("mouseleave", hideEigenInfoTooltip);
      info.addEventListener("focus", () => showEigenInfoTooltip(info));
      info.addEventListener("blur", hideEigenInfoTooltip);
      info.addEventListener("keydown", event => {
        if (event.key !== "Escape" || !document.getElementById("operation-eigen-tooltip")) return;
        // Close only the tooltip; a second Esc closes the phone Selected operation window.
        event.preventDefault();
        hideEigenInfoTooltip();
      });
      value.appendChild(info);
    }
    row.append(value, combination);
    eigen.appendChild(row);
  }
  card.append(equation, eigen);
  root.appendChild(card);
  scheduleOperationMathLayout();
}

function appendPlaybackReading(root, operation, repetitions = 1, resultReading = null) {
  const presentation = operation.presentations?.[resolvedImproperMode()];
  if (!presentation) return;
  const section = document.createElement("section");
  section.className = "operation-playback-reading";
  const heading = document.createElement("h3");
  heading.className = "operation-playback-caption";
  heading.textContent = resultReading || presentation.reading;
  const steps = document.createElement("ol");
  steps.className = "operation-playback-steps";
  const roles = {rotation: "軸", reflection: "面", inversion: "中心", translation: "移動量"};
  const names = {reflection: "鏡映", inversion: "反転", translation: "並進", affine: "行列指定"};
  const stages = Array.from({length: repetitions}, () => presentation.motion_labels || presentation.position_labels || []).flat();
  const single = stages.length === 1;
  const mergeHeading = single && names[stages[0].kind] === heading.textContent;
  steps.classList.toggle("operation-playback-steps-single", single);
  steps.classList.toggle("operation-playback-steps-merged", mergeHeading);
  function coordinate(text) {
    return compactPresentationExpression(text).replace(/\(([^()]+)\)\*([xyz])/g, (_, n, v) => n === "1/2" ? `${v}/2` : `${n}·${v}`);
  }
  for (const [index, stage] of stages.entries()) {
    const item = document.createElement("li");
    item.className = "operation-playback-step";
    if (!single) {
      const number = document.createElement("span");
      number.className = "operation-playback-number";
      number.setAttribute("aria-hidden", "true");
      number.textContent = String(index + 1);
      item.appendChild(number);
    }
    const name = mergeHeading ? heading : document.createElement("span");
    name.classList.add("operation-playback-action");
    if (!mergeHeading) name.textContent = stage.kind === "rotation" ? `${withMinusSign(compactPresentationExpression(stage.angle_degrees))}°回転` : names[stage.kind];
    const role = document.createElement("span");
    role.className = "operation-playback-role";
    role.textContent = roles[stage.kind];
    const position = document.createElement("span");
    position.className = "operation-playback-position";
    const coords = stage.coordinates.map(coordinate);
    if (stage.kind === "rotation") {
      position.textContent = stage.axis_equations.map(
        equation => `${equation.coordinate} = ${coordinate(equation.expression)}`).join(", ");
    } else if (stage.kind === "reflection") {
      position.textContent = coords.flatMap((v, i) => v === "xyz"[i] ? [] : [`${"xyz"[i]} = ${v}`]).join(", ");
    } else {
      position.textContent = `(${coords.join(", ")})`;
    }
    position.textContent = withMinusSign(position.textContent);
    const detail = document.createElement("span");
    detail.className = "operation-playback-detail";
    const element = document.createElement("span");
    element.className = "operation-playback-element";
    element.append(role, document.createTextNode("："), position);
    if (stage.kind !== "affine") detail.appendChild(element);
    if (stage.coordinate_formula?.length === 3) {
      const formula = document.createElement("span");
      formula.className = "operation-playback-transform";
      renderInformationFormula(formula, stage);
      detail.appendChild(formula);
    }
    if (!mergeHeading) item.appendChild(name);
    item.appendChild(detail);
    steps.appendChild(item);
  }
  if (!steps.children.length) {
    const unchanged = document.createElement("li");
    unchanged.className = "operation-playback-unchanged";
    unchanged.textContent = "変化なし";
    steps.appendChild(unchanged);
  }
  section.appendChild(heading);
  const viewport = document.createElement('div');
  viewport.className = 'operation-playback-viewport';
  viewport.tabIndex = 0;
  viewport.setAttribute('role', 'region');
  viewport.setAttribute('aria-label', '操作の順番と座標変換式');
  viewport.appendChild(steps);
  section.appendChild(viewport);
  root.appendChild(section);
}

function appendInformationName(root, operation, translation = null, {includePosition = true} = {}) {
  const name = document.createElement("div");
  name.className = "operation-information-name";
  const symbol = document.createElement("span");
  symbol.className = "operation-information-symbol";
  const presentation = operationPresentation(operation);
  const parts = !presentation && sourceKind === "crystal" && operation.itc_like_summary
    ? operation.itc_like_summary.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/) : null;
  symbol.appendChild(renderHtml(presentation ? presentationSymbol(operation, true) : sourceKind === "molecule"
    ? molecularSchoenfliesSymbol(operation)
    : formatItcLikeSymbol(parts?.[1] || displayOperationSymbol(operation))));
  name.append(symbol);
  if (includePosition && (presentation?.geometry || parts?.[2])) {
    const position = document.createElement("span");
    position.className = "operation-information-position";
    position.appendChild(renderHtml(formatItcLikeSymbol(` ${presentation?.geometry || parts[2]}`)));
    name.appendChild(position);
  }
  if (translation?.some(value => value !== 0)) {
    const shift = document.createElement("span");
    shift.className = "operation-information-shift";
    shift.textContent = `+ t(${translation.map(value => SymmetryOperationMath.number(value).replace(/^-/, "−")).join(", ")})`;
    name.appendChild(shift);
  }
  root.appendChild(name);
}

let operationInformationSignature = "";
let operationNavigationBusy = false;
let operationInformationRequest = 0;

function syncOperationInformation() {
  const panel = document.getElementById("operation-info-panel");
  panel.hidden = experienceMode !== "advanced" || !structureLoadedForSelectedKind();
  if (panel.hidden && selectedOperationDialog.open) selectedOperationDialog.close();
  if (panel.hidden) {
    operationInformationRequest++;
    operationInformationSignature = "";
    return;
  }
  if (activeMode === "custom") {
    const signature = JSON.stringify(["custom", copMatrix?.result?.plan_id, customSequenceRevision, state.operation_repetitions]);
    if (signature === operationInformationSignature) return;
    operationInformationSignature = signature;
    if (copMatrix?.result?.operation) showOperationInformation(copMatrix.result.operation);
    else renderCustomInformation();
    return;
  }
  const source = JSON.stringify([state.json_path, state.reload_request_id, sourceKind]);
  const operation = operations.find(item => Number(item.index) === Number(state.operation_index));
  const signature = JSON.stringify([source, operation, resolvedImproperMode(), summariesReady, state.operation_repetitions,
    document.getElementById("operation-sort").value, operationTypeFilterValue, directionFilterValue]);
  if (signature === operationInformationSignature) return;
  operationInformationSignature = signature;
  if (operation) showOperationInformation(operation);
}

async function showOperationInformation(operation) {
  const custom = Boolean(operation.custom);
  const customPlanId = copMatrix?.result?.plan_id;
  const sequenceRevision = customSequenceRevision;
  const requestId = ++operationInformationRequest;
  const repetitions = Number(state.operation_repetitions || 1);
  const revision = modelBoundary.active?.structure_revision;
  const modelId = modelBoundary.active?.model_id;
  const mode = resolvedImproperMode();
  const current = () => requestId === operationInformationRequest
    && (custom ? activeMode === "custom" && sequenceRevision === customSequenceRevision && copMatrix?.result?.plan_id === customPlanId
      : activeMode === "standard" && state.operation_index === operation.index) && resolvedImproperMode() === mode
    && Number(state.operation_repetitions || 1) === repetitions
    && revision === modelBoundary.active?.structure_revision && modelId === modelBoundary.active?.model_id;
  let modelPowers;
  if (modelViewEnabled) {
    try {
      modelPowers = await api(custom ? "/api/custom_powers" : `/api/powers?operation_index=${operation.index}`);
      if (!Array.isArray(modelPowers?.steps) || modelPowers.steps.length < 2) throw new Error("invalid_model_powers");
    } catch (error) {
      if (!current()) return;
      operationInformationSignature = "";
      if (!String(error).includes("stale_")) document.getElementById("status").textContent = String(error);
      return;
    }
    if (!current()) {
      if (requestId === operationInformationRequest) operationInformationSignature = "";
      return;
    }
  }
  hideEigenInfoTooltip();
  const panel = document.getElementById("operation-info-panel");
  const root = document.getElementById("operation-info-content");
  const math = SymmetryOperationMath;
  const crystal = sourceKind === "crystal";
  root.replaceChildren();
  const name = document.getElementById("operation-info-name");
  panel.dataset.operationIndex = operation.index;
  const reading = document.createElement("div");
  root.appendChild(reading);
  const selectedMatrices = document.createElement("div");
  selectedMatrices.className = "operation-information-grid operation-power-matrices";
  const fractional = crystal;
  const visible = sortedOperations().filter(item =>
    !(experienceMode === "beginner" && operationTypeFilterValue && operationSymbolFilterKey(item) !== operationTypeFilterValue)
    && !(experienceMode === "advanced" && directionFilterValue && operationFilterKey(item) !== directionFilterValue));
  const position = custom ? -1 : visible.findIndex(item => item.index === operation.index);
  async function navigate(offset) {
    const target = position < 0 ? null : visible[position + offset];
    if (!target || operationNavigationBusy) return;
    operationNavigationBusy = true;
    previous.disabled = true;
    next.disabled = true;
    try {
      await selectStandardOperation(target);
    } finally {
      operationNavigationBusy = false;
      operationInformationSignature = "";
      syncOperationInformation();
    }
  }
  const previous = document.getElementById("operation-info-prev");
  const next = document.getElementById("operation-info-next");
  previous.hidden = next.hidden = custom;
  previous.disabled = operationNavigationBusy || position <= 0;
  next.disabled = operationNavigationBusy || position < 0 || position >= visible.length - 1;
  previous.onclick = () => navigate(-1);
  next.onclick = () => navigate(1);
  panel.onkeydown = event => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.stopPropagation();
    if (event.target.closest(".operation-power-series, .operation-playback-viewport, .operation-vector-transform")) return;
    if (event.target.matches("input, select, textarea") || event.target.isContentEditable) return;
    event.preventDefault();
    navigate(event.key === "ArrowLeft" ? -1 : 1);
  };
  root.appendChild(selectedMatrices);
  const heading = document.createElement("h3");
  heading.className = "operation-repetition-title";
  heading.textContent = "操作の反復";
  root.appendChild(heading);
  const result = modelViewEnabled ? modelPowers : math.powers(operation, operations, crystal);
  // For an identity or lattice translation, also offer the second application.
  if (!modelViewEnabled && result.steps.length === 1) {
    const twice = math.compose(math.affine(operation, crystal), result.steps[0]);
    result.steps.push({...twice, n: 2, match: result.steps[0].match,
      latticeShift: crystal ? twice.t.map((value, i) => Math.round(value - math.affine(result.steps[0].match || operation, true).t[i])) : null});
  }
  const series = document.createElement("div");
  series.className = "operation-power-series";
  series.setAttribute("role", "group");
  series.setAttribute("aria-label", "繰り返し回数を選択");
  series.tabIndex = 0;
  root.appendChild(series);
  let cartesian = {W: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t: [0, 0, 0]};
  const buttons = [];
  function selectPower(step, reveal = true) {
    hideEigenInfoTooltip();
    name.replaceChildren();
    appendInformationName(name, operation, null, {includePosition: false});
    if (step.n > 1) {
      const count = document.createElement("span");
      count.className = "operation-information-repeat";
      count.textContent = `${step.n}回反復`;
      name.querySelector('.operation-information-symbol').after(count);
    }
    reading.replaceChildren();
    appendPlaybackReading(reading, operation, step.n, step.result_reading);
    buttons.forEach(button => button.setAttribute("aria-pressed", String(Number(button.dataset.power) === step.n)));
    selectedMatrices.replaceChildren();
    appendInformationTransform(selectedMatrices, fractional ? step : (step.cartesian || step), fractional, crystal ? step : null);
    selectedMatrices.querySelector('.operation-vector-transform').dataset.repetitions = step.n;
    if (reveal && panel.open) {
      const selected = buttons.find(button => Number(button.dataset.power) === step.n);
      const outer = series.getBoundingClientRect();
      const inner = selected?.getBoundingClientRect();
      if (inner && inner.left < outer.left) series.scrollLeft -= outer.left - inner.left;
      else if (inner && inner.right > outer.right) series.scrollLeft += inner.right - outer.right;
    }
  }
  for (const step of result.steps) {
    if (operation.matrix_cart && !modelViewEnabled) {
      cartesian = math.compose(math.affine(operation, false), cartesian);
      step.cartesian = cartesian;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "operation-power-choice";
    button.dataset.power = step.n;
    button.setAttribute("aria-pressed", "false");
    button.setAttribute("aria-label", `${step.n}回適用した結果を表示`);
    const content = document.createElement("span");
    content.className = "operation-power-choice-content";
    const count = document.createElement("span");
    count.className = "operation-power-count";
    count.textContent = step.n <= 20 ? String.fromCodePoint(0x2460+step.n-1)
      : step.n <= 35 ? String.fromCodePoint(0x3251+step.n-21)
      : step.n <= 50 ? String.fromCodePoint(0x32b1+step.n-36) : String(step.n);
    count.classList.toggle('operation-power-count-outlined', step.n > 50);
    content.appendChild(count);
    if (step.W.every((row, i) => row.every((v, j) => Math.abs(v - Number(i === j)) < 1e-9))) {
      const name = document.createElement("div");
      name.className = "operation-information-name";
      const symbol = document.createElement("span");
      symbol.className = "operation-information-symbol";
      symbol.textContent = step.t.some(v => Math.abs(v) > 1e-9)
        ? `t(${step.t.map(value => math.number(value).replace(/^-/, "−")).join(", ")})` : sourceKind === "crystal" ? "1" : "E";
      name.append(symbol);
      content.appendChild(name);
    } else if (step.match) appendInformationName(content, step.match, step.latticeShift, {includePosition: false});
    const formula = document.createElement("span");
    formula.className = "operation-information-formula";
    renderInformationFormula(formula, step);
    content.appendChild(formula);
    button.appendChild(content);
    button.addEventListener("click", async () => {
      selectPower(step);
      buttons.forEach(item => { item.disabled = true; });
      try {
        await postState({operation_repetitions: step.n, playing: false, reset: true});
      } catch (error) {
        document.getElementById("status").textContent = String(error);
      } finally {
        buttons.forEach(item => { item.disabled = false; });
      }
    });
    buttons.push(button);
    const node = document.createElement("span");
    node.className = "operation-power-node";
    node.appendChild(button);
    if (step.n < result.steps.length) {
      const arrow = document.createElement("span");
      arrow.className = "operation-power-arrow";
      arrow.textContent = "→";
      arrow.setAttribute("aria-hidden", "true");
      node.appendChild(arrow);
    }
    series.appendChild(node);
  }
  selectPower(result.steps.find(step => step.n === Number(state.operation_repetitions || 1)) || result.steps[0], false);
  if (!result.complete) {
    const limit = document.createElement("div");
    limit.className = "operation-information-limit";
    limit.textContent = "… 120回まで表示";
    root.appendChild(limit);
  }
}

function renderOperations() {
  syncOperationInformation();
  renderOperationTypeFilter();
  const root = document.getElementById("operations");
  const sorted = sortedOperations();
  renderFullscreenOperationSelector(sorted);
  const filtered = sorted.filter(operation =>
    !(experienceMode === "beginner" && operationTypeFilterValue && operationSymbolFilterKey(operation) !== operationTypeFilterValue)
    && !(experienceMode === "advanced" && directionFilterValue && operationFilterKey(operation) !== directionFilterValue)
  );
  renderOperationCount(filtered.length, sorted.length);
  // Driven by the 1 s poll and by every postState, so most calls have nothing
  // to change. Rebuilding the list anyway discards scroll position and hover.
  const signature = operationListRenderSignature(sorted);
  if (signature === lastOperationRenderSignature && root.childElementCount) {
    revealSelectedOperationRow();
    return;
  }
  lastOperationRenderSignature = signature;
  // Rows are rebuilt on every selection change; keep keyboard focus in the
  // list (for ↑↓) and reveal the selection in the new rows.
  const focusInList = root.contains(document.activeElement);
  root.innerHTML = "";
  for (const operation of filtered) {
    root.appendChild(buildOperationRow(operation));
  }
  if (focusInList) root.querySelector(".operation-row.selected")?.focus({preventScroll: true});
  revealedOperationKey = "";
  revealSelectedOperationRow();
  if (activeMode === "custom" && experienceMode === "advanced" && sourceKind === "crystal") {
    renderCustomSequenceControls();
  }
  renderSelectedOperationOverlay();
}

function renderSelectedOperationOverlay() {
  const overlay = document.getElementById("selected-operation-overlay");
  if (!overlay) return;
  if (!structureLoadedForSelectedKind()) {
    overlay.hidden = true;
    overlay.replaceChildren();
    return;
  }
  const operation = operations.find(item => Number(item.index) === Number(state.operation_index));
  const label = activeMode === "custom"
    ? "Custom operation"
    : (operation ? optionText(operation) : "Operation");
  overlay.replaceChildren();
  const caption = document.createElement("span");
  caption.className = "selected-operation-overlay-label";
  caption.textContent = "Selected";
  const value = document.createElement("strong");
  value.appendChild(renderHtml(label));
  overlay.append(caption, value);
  if (mobileAnalysisActive && experienceMode === "advanced") {
    const info = document.createElement("button");
    info.type = "button";
    info.id = "selected-operation-info";
    info.className = "puzzle-matrix-help selected-operation-info";
    info.textContent = "ⓘ";
    info.title = "選択中の操作の詳細";
    info.setAttribute("aria-label", info.title);
    info.setAttribute("aria-haspopup", "dialog");
    info.addEventListener("click", openSelectedOperationDialog);
    const row = document.createElement("span");
    row.className = "selected-operation-overlay-row";
    row.append(value, info);
    overlay.append(row);
  }
  overlay.hidden = !Boolean(state.legend_visible);
}

function renderFullscreenOperationSelector(sorted) {
  const select = document.getElementById("fullscreen-operation-select");
  if (!select) return;
  const signature = JSON.stringify({
    source: state.json_path || "",
    experienceMode,
    operations: sorted.map(operation => [operation.index, optionText(operation)]),
  });
  if (signature !== fullscreenOperationOptionsSignature) {
    fullscreenOperationOptionsSignature = signature;
    select.replaceChildren();
    for (const operation of sorted) {
      const option = document.createElement("option");
      option.value = String(operation.index);
      option.textContent = stripHtmlWithOverbars(optionText(operation));
      select.appendChild(option);
    }
  }
  select.value = String(state.operation_index);
}

function renderOperationCount(visibleCount, totalCount) {
  const output = document.getElementById("operations-count");
  if (!output) return;
  output.value = `${visibleCount} / ${totalCount}`;
  output.textContent = `${visibleCount} / ${totalCount}`;
}

function operationSymbolFilterKey(operation) {
  if (sourceKind === "molecule") return stripHtml(molecularSchoenfliesSymbol(operation));
  const kind = String(operation.kind || "").toLowerCase();
  if (kind.includes("glide")) return isLatticeGlide(operation) ? "m" : "g";
  if (kind.includes("improper") || kind.includes("rotoinversion") || kind.includes("rotoreflection")) {
    return `bar-${improperNotationOrder(operation)}`;
  }
  if (kind.includes("inversion")) return "bar-1";
  return sortableSymbol(operation);
}

function operationSymbolFilterLabel(operation) {
  if (sourceKind === "molecule") return molecularSchoenfliesSymbol(operation);
  return beginnerOperationSymbol(operation);
}

function operationFilterOrderRank(operation) {
  // Groups operations by symmetry order after grouping by type, so e.g. C2
  // sorts before C3 within rotations, and a finite order sorts before an
  // unresolved/infinite one (C∞, S∞) within the same type.
  if (isImproperOperation(operation)) {
    const order = improperNotationOrder(operation);
    return order > 0 ? order : Infinity;
  }
  const order = Number(operation.order);
  return Number.isFinite(order) && order > 0 ? order : Infinity;
}

function renderOperationTypeFilter() {
  const root = document.getElementById("operation-type-filter");
  if (!root) return;
  const scrollLeft = root.scrollLeft;
  const symbols = new Map();
  const ranks = new Map();
  for (const operation of operations) {
    const key = operationSymbolFilterKey(operation);
    if (!symbols.has(key)) {
      symbols.set(key, operationSymbolFilterLabel(operation));
      ranks.set(key, [beginnerOperationTypeRank(operation), operationFilterOrderRank(operation)]);
    }
  }
  const keys = [...symbols.keys()].sort((a, b) =>
    compareNumber(ranks.get(a)[0], ranks.get(b)[0])
    || compareNumber(ranks.get(a)[1], ranks.get(b)[1])
    || compareText(a, b)
  );
  if (operationTypeFilterValue && !keys.includes(operationTypeFilterValue)) operationTypeFilterValue = "";
  root.innerHTML = "";
  const allLabel = "All";
  for (const [key, label] of [["", allLabel], ...keys.map(key => [key, symbols.get(key)])]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `direction-chip${key === operationTypeFilterValue ? " selected" : ""}`;
    button.setAttribute("aria-pressed", String(key === operationTypeFilterValue));
    button.appendChild(renderHtml(label));
    button.addEventListener("click", () => {
      operationTypeFilterValue = key;
    renderOperations();
    });
    root.appendChild(button);
  }
  root.scrollLeft = scrollLeft;
  syncFilterFade(root);
}

function customOperationText(operation) {
  return optionText(operation).replace(/^op \d+:\s*/, "");
}

function syncCustomInputType() {
  closeCustomOperationMenu();
  const type = document.getElementById("cop-type").value;
  document.getElementById("custom-existing-input").hidden = type !== "existing";
  document.getElementById("custom-create-input").hidden = type === "existing";
  for (const el of document.querySelectorAll(".cop-fields")) el.hidden = true;
  const target = document.getElementById("cop-" + type);
  if (target) target.hidden = false;
}

function renderCustomOperationPicker(resetScroll = false) {
  const select = document.getElementById("cop-operation-select");
  const menu = document.getElementById("cop-operation-menu");
  const filter = document.getElementById("cop-operation-filter");
  const type = "symbol";
  const open = menu.matches(":popover-open");
  const activeValue = menu.querySelector(".picker-active")?.dataset.value;
  const focusInMenu = menu.contains(document.activeElement);
  const selectedValue = select.value;
  const initialized = select.dataset.initialized === "true";
  const scrollTop = resetScroll ? 0 : menu.scrollTop;
  const scrollLeft = filter.scrollLeft;
  const values = filterChipValues(type);
  if (customOperationFilterValue && !values.some(([key]) => key === customOperationFilterValue)) {
    customOperationFilterValue = "";
  }
  filter.replaceChildren();
  for (const [key, label] of [["", "All"], ...values]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `direction-chip${key === customOperationFilterValue ? " selected" : ""}`;
    button.dataset.value = key;
    button.setAttribute("aria-pressed", String(key === customOperationFilterValue));
    button.appendChild(renderHtml(label));
    button.addEventListener("click", () => {
      customOperationFilterValue = key;
      renderCustomOperationPicker(true);
      const selected = [...filter.children].find(item => item.dataset.value === key);
      selected?.focus({preventScroll: true});
    });
    filter.appendChild(button);
  }
  filter.scrollLeft = scrollLeft;
  select.replaceChildren();
  menu.replaceChildren();
  for (const operation of sortedOperations("symbol")) {
    const text = optionText(operation);
    const option = document.createElement("option");
    option.value = String(operation.index);
    option.textContent = stripHtmlWithOverbars(text);
    select.appendChild(option);
    if (customOperationFilterValue && operationFilterKey(operation, type) !== customOperationFilterValue) continue;
    const item = document.createElement("button");
    item.type = "button";
    item.className = "operation-row";
    item.dataset.value = String(operation.index);
    item.setAttribute("role", "option");
    item.appendChild(renderHtml(text));
    item.title = stripHtmlWithOverbars(text);
    item.addEventListener("click", () => {
      select.value = item.dataset.value;
      syncCustomOperationPicker();
      closeCustomOperationMenu(true);
    });
    menu.appendChild(item);
  }
  const initial = String(state.operation_index ?? "");
  select.value = initialized ? selectedValue
    : [...select.options].some(option => option.value === initial) ? initial : select.options[0]?.value ?? "";
  select.dataset.initialized = String(select.options.length > 0);
  syncCustomOperationPicker();
  menu.scrollTop = scrollTop;
  if (open) {
    positionCustomOperationMenu();
    const candidate = resetScroll ? menu.firstElementChild
      : [...menu.children].find(item => item.dataset.value === activeValue) || menu.querySelector(".selected") || menu.firstElementChild;
    setCustomOperationCandidate(candidate, resetScroll);
    if (focusInMenu) candidate?.focus({preventScroll: true});
  }
}

function renderCustomSequenceControls() {
  const list = document.getElementById("custom-sequence-list");
  const toggle = document.getElementById("custom-sequence-toggle");
  document.getElementById("custom-sequence-block").hidden = customOperationSequence.length === 0;
  document.getElementById("custom-sequence-title").textContent = `Sequence (${customOperationSequence.length})`;
  if (!customOperationSequence.length) toggle.setAttribute("aria-expanded", "true");
  list.hidden = toggle.getAttribute("aria-expanded") !== "true";
  renderCustomOperationPicker();

  list.innerHTML = "";
  let dragged = null;
  const clearDragMarks = () => {
    for (const row of list.children) {
      row.classList.remove("sequence-dragging", "sequence-drop-before", "sequence-drop-after");
    }
  };
  const operationsByIndex = new Map(operations.map(operation => [operation.index, operation]));
  if (customOperationSequence.length) {
    customOperationSequence.forEach((sequenceItem, position) => {
      const operation = sequenceItem.type === "operation" ? operationsByIndex.get(sequenceItem.index) : null;
      const row = document.createElement("div");
      row.className = "sequence-item";
      const label = document.createElement("span");
      label.textContent = `${position + 1}. ${operation ? stripHtmlWithOverbars(customOperationText(operation)) : customSequenceItemLabel(customOperationSequence[position])}`;
      label.draggable = true;
      label.className = "sequence-drag-label";
      label.title = "Drag to reorder";
      label.addEventListener("dragstart", event => {
        dragged = {position, revision: customSequenceRevision};
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", label.textContent);
        row.classList.add("sequence-dragging");
      });
      label.addEventListener("dragend", () => {
        dragged = null;
        clearDragMarks();
      });
      row.addEventListener("dragover", event => {
        if (!dragged || dragged.revision !== customSequenceRevision) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        clearDragMarks();
        list.children[dragged.position]?.classList.add("sequence-dragging");
        if (dragged.position !== position) {
          row.classList.add(dragged.position < position ? "sequence-drop-after" : "sequence-drop-before");
        }
      });
      row.addEventListener("dragleave", event => {
        if (!row.contains(event.relatedTarget)) {
          row.classList.remove("sequence-drop-before", "sequence-drop-after");
        }
      });
      row.addEventListener("drop", event => {
        if (!dragged || dragged.revision !== customSequenceRevision) return;
        event.preventDefault();
        event.stopPropagation();
        const from = dragged.position;
        dragged = null;
        clearDragMarks();
        if (from === position) return;
        const [item] = customOperationSequence.splice(from, 1);
        customOperationSequence.splice(position, 0, item);
        customSequenceChanged();
      });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "secondary";
      remove.textContent = "Remove";
      remove.title = "操作列から削除";
      remove.addEventListener("click", () => {
        customOperationSequence.splice(position, 1);
        customSequenceChanged();
      });
      row.appendChild(label);
      row.appendChild(remove);
      list.appendChild(row);
    });
  }
}

function syncCustomOperationPicker() {
  const select = document.getElementById("cop-operation-select");
  const items = [...document.getElementById("cop-operation-menu").children];
  const selected = items.find(item => item.dataset.value === select.value);
  if (!selected) select.value = "";
  document.getElementById("btn-add-existing-op").disabled = !selected;
  const trigger = document.getElementById("cop-operation-display");
  trigger.replaceChildren();
  if (selected) trigger.appendChild(renderHtml(selected.innerHTML));
  else trigger.textContent = "Select operation";
  for (const item of items) {
    const active = item === selected;
    item.classList.toggle("selected", active);
    item.setAttribute("aria-selected", String(active));
    item.tabIndex = -1;
  }
}

function setCustomOperationCandidate(item, reveal = true) {
  const menu = document.getElementById("cop-operation-menu");
  for (const row of menu.children) row.classList.toggle("picker-active", row === item);
  if (!item || !reveal) return;
  const outer = menu.getBoundingClientRect();
  const inner = item.getBoundingClientRect();
  if (inner.top < outer.top) menu.scrollTop -= outer.top - inner.top + 8;
  else if (inner.bottom > outer.bottom) menu.scrollTop += inner.bottom - outer.bottom + 8;
}

function closeCustomOperationMenu(restoreFocus = false) {
  const menu = document.getElementById("cop-operation-menu");
  if (!menu.matches(":popover-open")) return;
  menu.hidePopover();
  document.getElementById("cop-operation-display").setAttribute("aria-expanded", "false");
  setCustomOperationCandidate(null, false);
  if (restoreFocus) document.getElementById("cop-operation-display").focus({preventScroll: true});
}

function positionCustomOperationMenu() {
  const menu = document.getElementById("cop-operation-menu");
  if (!menu.matches(":popover-open")) return;
  const box = document.getElementById("cop-operation-picker").getBoundingClientRect();
  if (box.bottom <= 0 || box.top >= window.innerHeight) {
    closeCustomOperationMenu();
    return;
  }
  const below = window.innerHeight - box.bottom - 14;
  const above = box.top - 14;
  const upwards = below < 190 && above > below;
  const width = Math.min(box.width, window.innerWidth - 16);
  menu.style.width = `${width}px`;
  menu.style.maxHeight = `${Math.max(0, Math.min(190, upwards ? above : below))}px`;
  menu.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - width - 8))}px`;
  const height = menu.getBoundingClientRect().height;
  menu.style.top = `${upwards ? box.top - height - 6 : box.bottom + 6}px`;
}

function openCustomOperationMenu(focusCandidate = false, edge = null) {
  const menu = document.getElementById("cop-operation-menu");
  if (!menu.matches(":popover-open")) menu.showPopover();
  document.getElementById("cop-operation-display").setAttribute("aria-expanded", "true");
  positionCustomOperationMenu();
  const item = edge === "last" ? menu.lastElementChild : edge === "first" ? menu.firstElementChild
    : menu.querySelector(".selected") || menu.firstElementChild;
  setCustomOperationCandidate(item);
  if (focusCandidate) item?.focus({preventScroll: true});
}

document.getElementById("custom-sequence-toggle").addEventListener("click", () => {
  const toggle = document.getElementById("custom-sequence-toggle");
  const expanded = toggle.getAttribute("aria-expanded") !== "true";
  toggle.setAttribute("aria-expanded", String(expanded));
  document.getElementById("custom-sequence-list").hidden = !expanded;
});

document.getElementById("cop-operation-select").addEventListener("change", syncCustomOperationPicker);
document.getElementById("cop-operation-display").addEventListener("click", () => {
  if (document.getElementById("cop-operation-menu").matches(":popover-open")) closeCustomOperationMenu();
  else openCustomOperationMenu();
});
document.getElementById("cop-operation-display").addEventListener("keydown", event => {
  if (event.key === "Tab") { closeCustomOperationMenu(); return; }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  openCustomOperationMenu(true, event.key === "Home" ? "first" : event.key === "End" ? "last" : null);
});
document.getElementById("cop-operation-menu").addEventListener("keydown", event => {
  if (event.key === "Tab") { closeCustomOperationMenu(true); return; }
  const items = [...event.currentTarget.children];
  const current = items.indexOf(document.activeElement);
  if (!items.length || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
    : Math.max(0, Math.min(items.length - 1, current + (event.key === "ArrowDown" ? 1 : -1)));
  setCustomOperationCandidate(items[next]);
  items[next].focus({preventScroll: true});
});
document.addEventListener("pointerdown", event => {
  if (!event.target.closest("#cop-operation-display, #cop-operation-menu, #cop-operation-filter")) closeCustomOperationMenu();
});
document.addEventListener("focusin", event => {
  if (!event.target.closest("#cop-operation-display, #cop-operation-menu, #cop-operation-filter")) closeCustomOperationMenu();
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && document.getElementById("cop-operation-menu").matches(":popover-open")) {
    event.preventDefault();
    closeCustomOperationMenu(true);
  }
});
window.addEventListener("resize", positionCustomOperationMenu);
document.addEventListener("scroll", positionCustomOperationMenu, true);

function customSequenceItemLabel(item) {
  if (!item) return "unknown";
  if (item.type === "operation") return `op ${item.index}`;
  // Show the entered angle and direction so similar entries can be told apart.
  // item.label itself is sent to the server unchanged.
  const base = item.label || "custom";
  const params = item.op_params || {};
  const value = number => withMinusSign(SymmetryOperationMath.number(Number(number)));
  const list = (values, separator) => Array.isArray(values) ? values.map(value).join(separator) : "";
  if (item.op_type === "rotation" && Array.isArray(params.axis)) {
    return `${base}　${withMinusSign(String(Number(params.angle)))}°　[${list(params.axis, " ")}]`;
  }
  if (item.op_type === "mirror" && Array.isArray(params.normal)) return `${base}　(${list(params.normal, " ")})`;
  if (item.op_type === "translation" && Array.isArray(params.vector)) return `${base}　(${list(params.vector, ", ")})`;
  return base;
}

// One line under the sequence: whether the composed operation is a symmetry operation.
function customVerdictElement() {
  let element = document.getElementById("custom-verdict");
  if (!element) {
    element = document.createElement("div");
    element.id = "custom-verdict";
    element.setAttribute("aria-live", "polite");
    element.hidden = true;
    document.getElementById("cop-result").before(element);
  }
  return element;
}

function showCustomVerdict(result) {
  const element = customVerdictElement();
  if (!result || result.error) {
    element.hidden = true;
    return;
  }
  const operation = result.operation;
  if (operation) {
    const presentation = operationPresentation(operation);
    let reading = presentation?.reading || beginnerOperationReading(operation);
    if (isLatticeGlide(operation)) reading = "鏡映";
    else if (operation.kind === "screw" && /^\d+$/.test(String(presentation?.symbol || ""))) reading = reading.replace(/らせん$/, "回転");
    element.className = "cop-result ok";
    element.textContent = `対称操作：${reading}`;
  } else {
    element.className = "cop-result";
    element.textContent = "対称操作ではない";
  }
  element.hidden = false;
}

function hideCustomSequenceResult() {
  // A composition result is valid only for the exact sequence that produced
  // it.  Hiding the message alone left its matrix available to Start after an
  // add/remove/reorder, which replayed the old sequence.
  copMatrix = null;
  const div = document.getElementById("cop-result");
  if (div) div.hidden = true;
  const verdict = document.getElementById("custom-verdict");
  if (verdict) verdict.hidden = true;
}

function invalidateCustomSequenceWork() {
  customSequenceRevision += 1;
  customSequenceToken = `${Date.now()}:${customSequenceRevision}`;
  customPlaybackIntent += 1;
  window.clearTimeout(customSequenceTimer);
  customSequenceTimer = null;
  customSequencePreparation = null;
  hideCustomSequenceResult();
  document.getElementById("custom-panel").dataset.checkState = "empty";
}

function customSequenceChanged() {
  invalidateCustomSequenceWork();
  cancelLoopRestart();
  renderCustomSequenceControls();
  // Publish the edit before composing it. The backend rejects earlier tokens,
  // including requests that reach it after this clear has completed.
  const revision = customSequenceRevision;
  customSequenceStop = postState({playing: false, reset: true, clear_custom_check: true, operation_repetitions: 1,
    custom_sequence_token: customSequenceToken}).then(() => true).catch(error => {
      if (revision === customSequenceRevision) {
        const result = document.getElementById("cop-result");
        result.className = "cop-result fail";
        result.textContent = customOperationErrorMessage(error);
        result.hidden = false;
      }
      return false;
    });
  if (activeMode === "custom" && customOperationSequence.length) {
    const result = document.getElementById("cop-result");
    result.className = "cop-result";
    result.textContent = "確認中…";
    result.hidden = false;
    document.getElementById("custom-panel").dataset.checkState = "checking";
    customSequenceTimer = window.setTimeout(prepareCustomSequence, 150);
  }
  renderOperationDetails();
}

function prepareCustomSequence() {
  window.clearTimeout(customSequenceTimer);
  customSequenceTimer = null;
  if (!customOperationSequence.length || activeMode !== "custom") return Promise.resolve(false);
  if (copMatrix) return Promise.resolve(true);
  const revision = customSequenceRevision;
  if (customSequencePreparation?.revision === revision) return customSequencePreparation.promise;
  const structureKey = `${state.json_path || ""}|${state.reload_request_id || ""}`;
  const token = customSequenceToken;
  const stopped = customSequenceStop;
  // Only one composition runs at a time; superseded edits never start one.
  const promise = customComposeQueue.catch(() => false).then(async () => {
    if (!await stopped || !customSequenceContextIsCurrent(revision, structureKey)) return false;
    let ready;
    do {
      ready = await sendCustomSequenceCompose(revision, structureKey, token);
    } while (ready === null && customSequenceContextIsCurrent(revision, structureKey));
    return Boolean(ready);
  });
  customComposeQueue = promise;
  customSequencePreparation = {revision, promise};
  promise.then(ready => {
    if (!ready && customSequencePreparation?.promise === promise) customSequencePreparation = null;
  });
  return promise;
}

function customSequenceContextIsCurrent(revision, structureKey) {
  return revision === customSequenceRevision
    && activeMode === "custom"
    && structureKey === `${state.json_path || ""}|${state.reload_request_id || ""}`;
}

function syncFilterFade(root) {
  root.classList.toggle("filter-fade-left", root.scrollLeft > 1);
  root.classList.toggle("filter-fade-right", root.scrollLeft + root.clientWidth < root.scrollWidth - 1);
}

for (const id of ["operation-type-filter", "direction-filter"]) {
  const root = document.getElementById(id);
  root.addEventListener("scroll", () => syncFilterFade(root), {passive: true});
  new ResizeObserver(() => syncFilterFade(root)).observe(root);
}

// Advanced and Custom filter chips as [key, label]. Symbol chips follow the
// Simple order (type, then order); direction chips stay alphabetical.
function filterChipValues(type) {
  const representatives = new Map();
  for (const operation of operations) {
    const key = operationFilterKey(operation, type);
    if (key && key !== "none" && !representatives.has(key)) representatives.set(key, operation);
  }
  return [...representatives.entries()]
    .map(([value, operation]) => [value, operationFilterLabel(operation, type), operation])
    .sort((a, b) => type !== "symbol" ? compareText(a[1], b[1])
      : compareNumber(beginnerOperationTypeRank(a[2]), beginnerOperationTypeRank(b[2]))
        || compareNumber(operationFilterOrderRank(a[2]), operationFilterOrderRank(b[2]))
        || compareText(a[1], b[1]))
    .map(([value, label]) => [value, label]);
}

function renderDirectionFilter() {
  const root = document.getElementById("direction-filter");
  const scrollLeft = root.scrollLeft;
  const filterType = operationFilterType();
  document.getElementById("operation-filter-label").textContent =
    filterType === "symbol" ? "Symbol" : "Direction";
  const values = filterChipValues(filterType);
  root.innerHTML = "";
  const allButton = document.createElement("button");
  allButton.type = "button";
  allButton.className = `direction-chip${directionFilterValue ? "" : " selected"}`;
  allButton.setAttribute("aria-pressed", String(!directionFilterValue));
  allButton.textContent = "All";
  allButton.addEventListener("click", () => {
    directionFilterValue = "";
    renderDirectionFilter();
    renderOperations();
  });
  root.appendChild(allButton);
  for (const [value, label] of values) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `direction-chip${value === directionFilterValue ? " selected" : ""}`;
    button.setAttribute("aria-pressed", String(value === directionFilterValue));
    button.appendChild(renderHtml(label));
    button.addEventListener("click", () => {
      directionFilterValue = value;
      renderDirectionFilter();
      renderOperations();
    });
    root.appendChild(button);
  }
  root.scrollLeft = scrollLeft;
  syncFilterFade(root);
  if (directionFilterValue && !values.some(([value]) => value === directionFilterValue)) {
    directionFilterValue = "";
    renderDirectionFilter();
    renderOperations();
  }
}

function sortedOperations(mode = document.getElementById("operation-sort").value) {
  if (experienceMode === "beginner" || mode === "symbol") {
    // Use the same operation type order in Simple and Advanced's symbol sort.
    return [...operations].sort((a, b) =>
      compareNumber(beginnerOperationTypeRank(a), beginnerOperationTypeRank(b))
      || compareNumber(Number(operationPresentation(a)?.notation_order ?? a.order) || 0, Number(operationPresentation(b)?.notation_order ?? b.order) || 0)
      || compareNumber(Number(operationPresentation(a)?.angle_deg ?? a.angle_deg) || 0, Number(operationPresentation(b)?.angle_deg ?? b.angle_deg) || 0)
      || compareNumber(a.index, b.index)
    );
  }
  return [...operations].sort((a, b) => {
    if (mode === "element") {
      return compareText(a.element_sort_key || "", b.element_sort_key || "") || compareNumber(a.index, b.index);
    }
    return compareNumber(a.index, b.index);
  });
}

function beginnerOperationTypeRank(operation) {
  const presentation = operationPresentation(operation);
  if (presentation) return presentation.type_rank;
  const kind = String(operation.kind || "").toLowerCase();
  if (kind === "identity") return 0;
  if (kind.includes("rotation") && !kind.includes("improper")) return 1;
  if (kind.includes("screw")) return 2;
  if (kind.includes("mirror")) return 3;
  if (kind.includes("glide")) return 4;
  if (kind.includes("inversion") && !kind.includes("roto")) return 5;
  if (kind.includes("improper") || kind.includes("rotoinversion") || kind.includes("rotoreflection")) return 6;
  if (kind.includes("translation")) return 7;
  return 8;
}

function sortableSymbol(operation) {
  return stripHtml(`${displayOperationSymbol(operation)}`).replace(/_/g, "");
}

function operationFilterType(mode = document.getElementById("operation-sort").value) {
  if (sourceKind === "molecule") return "symbol";
  return mode === "symbol" ? "symbol" : "direction";
}

function operationListSymbol(operation) {
  return operationPresentation(operation)?.symbol || String(sourceKind === "molecule"
    ? (operation.symbol || operation.display_symbol || "")
    : (operation.display_symbol || operation.symbol || ""));
}

function operationFilterKey(operation, type = operationFilterType()) {
  // Keep signed raw symbols: stripping rendered overbars merges 3 with -3.
  if (type === "symbol") return operationListSymbol(operation);
  return operation.direction_family_key || "";
}

function operationFilterLabel(operation, type = operationFilterType()) {
  if (type === "symbol" && operationPresentation(operation)) return presentationSymbol(operation);
  if (sourceKind === "molecule") return molecularSchoenfliesSymbol(operation);
  if (type === "symbol") return formatItcLikeSymbol(operationListSymbol(operation));
  return operation.direction_family_label || "";
}

function stripHtml(text) {
  const template = document.createElement("template");
  template.innerHTML = text;
  return template.content.textContent || "";
}

function compareText(a, b) {
  return String(a).localeCompare(String(b), undefined, {numeric: true, sensitivity: "base"});
}

function compareNumber(a, b) {
  return Number(a) - Number(b);
}

function basename(path) {
  const text = String(path || "");
  if (!text) return "-";
  const parts = text.split(/[\\\\/]/);
  return parts[parts.length - 1] || text;
}

function structureDisplayName(path) {
  return exampleDisplayName(basename(path).replace(/\.(?:cif|xyz|json)$/i, ""));
}

// File-style names such as "boron_trifluoride" -> "Boron trifluoride".
function exampleDisplayName(name) {
  return String(name || "").replace(/_/g, " ").replace(/^[a-z]/, letter => letter.toUpperCase());
}

function formatLength(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toFixed(4)} Å` : "-";
}

function formatAngle(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toFixed(3)}°` : "-";
}

function structureLoadedForSelectedKind() {
  const loaded = state.structure_loaded !== false && sourceKind !== "empty";
  return loaded && sourceKind === selectedStructureKind;
}

function sourceKindConfig(kind) {
  return STRUCTURE_KIND_UI[kind] || STRUCTURE_KIND_UI.crystal;
}

function setDefaultOperationSortForSourceKind() {
  document.getElementById("operation-sort").value = "symbol";
  directionFilterValue = "";
}

const CRYSTAL_POINT_GROUP_LABELS = {
  "1": "C_1",
  "-1": "C_i",
  "2": "C_2",
  "m": "C_s",
  "2/m": "C_2h",
  "222": "D_2",
  "mm2": "C_2v",
  "mmm": "D_2h",
  "4": "C_4",
  "-4": "S_4",
  "4/m": "C_4h",
  "422": "D_4",
  "4mm": "C_4v",
  "-42m": "D_2d",
  "4/mmm": "D_4h",
  "3": "C_3",
  "-3": "S_6",
  "32": "D_3",
  "3m": "C_3v",
  "-3m": "D_3d",
  "6": "C_6",
  "-6": "C_3h",
  "6/m": "C_6h",
  "622": "D_6",
  "6mm": "C_6v",
  "-6m2": "D_3h",
  "6/mmm": "D_6h",
  "23": "T",
  "m-3": "T_h",
  "432": "O",
  "-43m": "T_d",
  "m-3m": "O_h",
};

function renderStructureInfo() {
  const panel = document.getElementById("structure-info-panel");
  const root = document.getElementById("structure-info");
  if (!structureLoadedForSelectedKind()) {
    panel.hidden = true;
    mobileStructureInfo.hidden = true;
    root.innerHTML = "";
    lastStructureInfoSignature = "";
    renderStructureDialog();
    return;
  }
  const metadata = state.metadata || {};
  const signature = JSON.stringify({
    experienceMode,
    sourceKind,
    selectedStructureKind,
    sourceFile: metadata.source_file || state.json_path,
    formula: metadataFormula(metadata),
    symmetryLabel: metadata.symmetry_label,
    pointGroupLabel: metadata.point_group_label,
    operationCount: metadata.operation_count || operations.length,
    latticeParameters: metadata.lattice_parameters,
    displayLatticeParameters: metadata.display_lattice_parameters,
    cellSettingMode: state.cell_setting_mode,
    reload: state.reload_request_id,
    atoms: atoms.map(atom => [atom.index, atom.element, atom.frac, atom.cart]),
  });
  if (signature === lastStructureInfoSignature && !panel.hidden) {
    renderStructureDialog();
    return;
  }
  lastStructureInfoSignature = signature;
  // Generators are shown only in Structure details.
  const pointGroup = symmetryLabelWithGenerators(
    metadata.point_group_label || metadata.symmetry_label || "-",
    [],
    {pointGroup: true, groupSymbol: sourceKind !== "crystal"},
  );
  const summaryItems = [
    ["Structure", structureDisplayName(metadata.source_file || state.json_path)],
    ["Formula", formatChemicalFormula(metadataFormula(metadata) || "-")],
    ["Point group", pointGroup],
  ];
  if (sourceKind === "crystal") {
    summaryItems.push(["Space group", formatGroupSymbol(
      String(metadata.symmetry_label || "-").replace(/^(\d+)\s+/, "No. $1 "),
    )]);
  }
  root.innerHTML = "";
  appendSummaryGrid(root, summaryItems, "primary");

  const button = document.createElement("button");
  button.type = "button";
  button.id = "open-structure-details";
  button.className = "secondary";
  button.textContent = "Structure details";
  button.title = "構造の詳細";
  button.setAttribute("aria-haspopup", "dialog");
  button.addEventListener("click", () => {
    document.getElementById("structure-details-dialog").showModal();
    renderStructureDialog();
  });
  root.appendChild(button);
  panel.hidden = false;
  mobileStructureInfo.hidden = !mobileAnalysisActive;
  renderStructureDialog();
}

function crystalSystemFromSymmetryLabel(label) {
  const match = String(label || "").match(/^([0-9]+)/);
  if (!match) return "-";
  const number = Number(match[1]);
  if (number <= 2) return "Triclinic";
  if (number <= 15) return "Monoclinic";
  if (number <= 74) return "Orthorhombic";
  if (number <= 142) return "Tetragonal";
  if (number <= 167) return "Trigonal";
  if (number <= 194) return "Hexagonal";
  if (number <= 230) return "Cubic";
  return "-";
}

function selectedAtomSet() {
  return String(state.scope).startsWith("selected")
    ? new Set((state.selected_atoms || []).map(Number)) : new Set();
}

function renderStructureDialogInformation(metadata) {
  const info = document.getElementById("structure-dialog-information");
  info.replaceChildren();
  const overview = document.createElement("div");
  overview.className = "structure-overview";
  const name = document.createElement("h3");
  name.id = "structure-information-title";
  name.textContent = structureDisplayName(metadata.source_file || state.json_path);
  const formula = document.createElement("div");
  formula.className = "structure-formula";
  formula.replaceChildren(renderHtml(formatChemicalFormula(metadataFormula(metadata) || "-")));
  const counts = new Map();
  for (const atom of atoms) counts.set(atom.element, (counts.get(atom.element) || 0) + 1);
  const composition = document.getElementById("structure-atom-composition");
  composition.textContent = [...counts].map(([element, count]) => `${element} × ${count}`).join(" · ");
  overview.append(name, formula);
  info.appendChild(overview);
  const group = title => {
    const section = document.createElement("section");
    section.className = "structure-information-group";
    const heading = document.createElement("h4");
    heading.textContent = title;
    const fields = document.createElement("dl");
    fields.className = "structure-information-fields";
    section.append(heading, fields);
    info.appendChild(section);
    return {section, fields};
  };
  const field = (fields, label, value, generators = []) => {
    const row = document.createElement("div");
    row.className = "structure-information-field";
    const term = document.createElement("dt");
    term.textContent = label;
    const description = document.createElement("dd");
    description.appendChild(renderHtml(String(value)));
    const generatorSet = formatGeneratorSet(generators);
    if (generatorSet) {
      const detail = document.createElement("span");
      detail.className = "structure-generators";
      detail.appendChild(renderHtml(`Generators <span class="structure-generator-set">${generatorSet}</span>`));
      description.appendChild(detail);
    }
    row.append(term, description);
    fields.appendChild(row);
  };
  const symmetry = group("Symmetry");
  field(symmetry.fields, "Point group", symmetryLabelWithGenerators(
    metadata.point_group_label || metadata.symmetry_label || "-", [],
    {pointGroup: sourceKind === "crystal", groupSymbol: sourceKind !== "crystal"},
  ), metadata.point_group_generators);
  if (sourceKind === "crystal") {
    field(symmetry.fields, "Space group", symmetryLabelWithGenerators(
      metadata.symmetry_label, [], {spaceGroup: true},
    ), metadata.space_group_generators);
  }
  field(symmetry.fields, "Operations", `${metadata.operation_count || operations.length}${String(metadata.point_group_label || "").includes("∞") ? "（無限群の代表のみ）" : ""}`);
  if (sourceKind !== "crystal") return;
  const cell = group("Cell");
  field(cell.fields, "Bravais lattice", bravaisLatticeLabel(metadata.symmetry_label));
  const lattice = metadata.display_lattice_parameters || metadata.lattice_parameters;
  if (!lattice) return;
  const dimensions = document.createElement("div");
  dimensions.className = "structure-lattice";
  for (const items of [
    [["a", formatLength(lattice.a)], ["b", formatLength(lattice.b)], ["c", formatLength(lattice.c)]],
    [["α", formatAngle(lattice.alpha)], ["β", formatAngle(lattice.beta)], ["γ", formatAngle(lattice.gamma)]],
  ]) {
    const row = document.createElement("div");
    row.className = "structure-lattice-row";
    for (const [label, value] of items) {
      const item = document.createElement("div");
      item.className = "structure-lattice-item";
      const term = document.createElement("span");
      term.textContent = label;
      const number = document.createElement("span");
      number.textContent = value;
      item.append(term, number);
      row.appendChild(item);
    }
    dimensions.appendChild(row);
  }
  cell.section.appendChild(dimensions);
}

function setStructureBatchOpen(open) {
  document.getElementById("structure-batch-panel").hidden = !open;
  document.getElementById("structure-batch-toggle").setAttribute("aria-expanded", String(open));
}

function clearStructureBatchControls() {
  setStructureBatchOpen(false);
  structureBatchUpdates = [];
  document.getElementById("structure-batch-rows").replaceChildren();
}

function renderStructureBatchControls() {
  clearStructureBatchControls();
  const elements = new Map();
  for (const atom of atoms) {
    if (!elements.has(atom.element)) elements.set(atom.element, []);
    elements.get(atom.element).push(atom);
  }
  const root = document.getElementById("structure-batch-rows");
  for (const [label, members] of [["All", atoms], ...elements]) {
    const row = document.createElement("div");
    row.className = "structure-batch-row";
    row.dataset.group = label;
    const selection = document.createElement("label");
    selection.className = "structure-batch-selection";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.setAttribute("aria-label", `Select ${label} atoms`);
    checkbox.addEventListener("change", () => {
      const next = selectedAtomSet();
      for (const atom of members) {
        if (checkbox.checked) next.add(Number(atom.index));
        else next.delete(Number(atom.index));
      }
      postState({selected_atoms: [...next].sort((a, b) => a - b),
        scope: next.size ? "selected_displayed" : "displayed", playing: false, reset: true});
    });
    const name = document.createElement("span");
    name.textContent = `${label} (${members.length})`;
    selection.append(checkbox, name);
    const colorControl = document.createElement("div");
    colorControl.className = "structure-batch-color";
    const color = document.createElement("input");
    color.type = "color";
    color.title = "原子の色を変更";
    color.setAttribute("aria-label", color.title);
    color.addEventListener("change", () => {
      const colors = {...(state.atom_colors || {})};
      for (const atom of members) colors[String(atom.index)] = color.value;
      postState({atom_colors: colors});
    });
    const mixed = document.createElement("span");
    mixed.className = "structure-batch-mixed";
    mixed.textContent = "Mixed";
    colorControl.append(color, mixed);
    const visibleButton = visibilityButton(true, "", () => {
      const hide = members.every(atomVisible);
      const atomHidden = {...(state.atom_hidden || {})};
      const elementHidden = {...(state.element_hidden || {})};
      for (const atom of members) {
        // A group contains every primary atom of its elements. Explicit atom
        // settings therefore also supersede any legacy element-level setting.
        delete elementHidden[atom.element];
        if (hide) atomHidden[String(atom.index)] = true;
        else delete atomHidden[String(atom.index)];
      }
      postState({atom_hidden: atomHidden, element_hidden: elementHidden, playing: false, reset: true});
    });
    let renderedColors = null;
    structureBatchUpdates.push(selected => {
      const selectedCount = members.filter(atom => selected.has(Number(atom.index))).length;
      checkbox.checked = members.length > 0 && selectedCount === members.length;
      checkbox.indeterminate = selectedCount > 0 && selectedCount < members.length;
      const colors = [...new Set(members.map(atomEffectiveColor))].sort();
      const colorKey = colors.join("|");
      // Retain native picker input through unrelated polling and state changes.
      if (colorKey !== renderedColors) {
        color.value = colors[0] || "#9aa5b1";
        renderedColors = colorKey;
      }
      const mixedColors = colors.length > 1;
      colorControl.classList.toggle("is-mixed", mixedColors);
      mixed.hidden = !mixedColors;
      color.setAttribute("aria-description", mixedColors ? "Mixed colors" : "");
      const visibleCount = members.filter(atomVisible).length;
      const allVisible = visibleCount === members.length;
      visibleButton.textContent = allVisible ? "Visible" : visibleCount ? "Mixed" : "Hidden";
      visibleButton.classList.toggle("hidden", visibleCount === 0);
      visibleButton.title = allVisible ? "原子を非表示" : "原子を表示";
      visibleButton.setAttribute("aria-label", visibleButton.title);
      checkbox.disabled = color.disabled = visibleButton.disabled = !members.length;
    });
    row.append(selection, colorControl, visibleButton);
    root.appendChild(row);
  }
}

function renderStructureDialog() {
  const dialog = document.getElementById("structure-details-dialog");
  if (!structureLoadedForSelectedKind()) {
    if (dialog.open) dialog.close();
    structureDialogSignature = "";
    structureAtomUpdates = [];
    clearStructureBatchControls();
    document.getElementById("structure-atom-list").replaceChildren();
    document.getElementById("structure-dialog-information").replaceChildren();
    return;
  }
  if (!dialog.open) {
    if (structureDialogSignature !== lastStructureInfoSignature) {
      // Do not keep the previous structure's full atom list alive while closed.
      structureDialogSignature = "";
      structureAtomUpdates = [];
      clearStructureBatchControls();
      document.getElementById("structure-atom-list").replaceChildren();
      document.getElementById("structure-dialog-information").replaceChildren();
    }
    return;
  }
  if (structureDialogSignature !== lastStructureInfoSignature) {
    structureDialogSignature = lastStructureInfoSignature;
    structureAtomUpdates = [];
    renderStructureBatchControls();
    const metadata = state.metadata || {};
    renderStructureDialogInformation(metadata);
    document.getElementById("structure-atoms-title").textContent = `Atoms (${atoms.length})`;
    document.getElementById("structure-coordinate-label").textContent = sourceKind === "crystal"
      ? "Fractional coordinates" : "Cartesian coordinates (Å)";
    const list = document.getElementById("structure-atom-list");
    list.replaceChildren();
    for (const atom of atoms) {
      const row = document.createElement("div");
      row.className = "structure-atom-row";
      row.dataset.atomIndex = atom.index;
      const selection = document.createElement("label");
      selection.className = "structure-atom-selection";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.setAttribute("aria-label", `Select atom ${atom.index}`);
      checkbox.addEventListener("change", () => {
        const next = selectedAtomSet();
        if (checkbox.checked) next.add(Number(atom.index));
        else next.delete(Number(atom.index));
        postState({selected_atoms: [...next].sort((a, b) => a - b),
          scope: next.size ? "selected_displayed" : "displayed", playing: false, reset: true});
      });
      row.addEventListener("click", event => {
        // Labels activate their checkbox themselves; controls keep their own action.
        if (event.target.closest("input, button, label")) return;
        checkbox.click();
      });
      const name = document.createElement("span");
      name.textContent = `${atomDisplayLabel(atom)} ${atom.index}`;
      selection.append(checkbox, name);
      const coordinates = document.createElement("div");
      coordinates.className = "structure-atom-coordinates";
      const from = document.createElement("span");
      from.className = "structure-atom-start";
      const arrow = document.createElement("span");
      arrow.textContent = " → ";
      const to = document.createElement("span");
      to.className = "structure-atom-target";
      coordinates.append(from, arrow, to);
      const controls = document.createElement("div");
      controls.className = "structure-atom-controls";
      const visibleButton = visibilityButton(atomVisible(atom), "", () => {
        postState(atomVisibilityUpdate(atom, atomVisible(atom)));
      });
      const color = document.createElement("input");
      color.type = "color";
      color.value = atomEffectiveColor(atom);
      color.title = `原子${atom.index}の色を変更`;
      color.setAttribute("aria-label", color.title);
      color.addEventListener("change", () => {
        postState({atom_colors: {...(state.atom_colors || {}), [String(atom.index)]: color.value}});
      });
      let renderedColor = color.value;
      structureAtomUpdates.push(selected => {
        const motion = activeMode === "standard" ? atomMotionBySource.get(atom.index) : null;
        const fractional = sourceKind === "crystal";
        const start = fractional ? (motion?.start_frac ?? atom.frac) : (motion?.start_cart ?? atom.cart);
        const target = fractional ? motion?.target_frac : motion?.target_cart;
        const formatter = fractional ? formatFrac : formatCoord;
        from.textContent = Array.isArray(start) ? formatVector(start, formatter) : "—";
        arrow.hidden = to.hidden = !Array.isArray(target);
        to.textContent = Array.isArray(target) ? formatVector(target, formatter) : "";
        const isSelected = selected.has(Number(atom.index));
        checkbox.checked = isSelected;
        row.classList.toggle("is-selected", isSelected);
        const visible = atomVisible(atom);
        row.classList.toggle("is-hidden", !visible);
        visibleButton.classList.toggle("hidden", !visible);
        visibleButton.textContent = visible ? "Visible" : "Hidden";
        visibleButton.title = visible ? "原子を非表示" : "原子を表示";
        visibleButton.setAttribute("aria-label", visibleButton.title);
        const effectiveColor = atomEffectiveColor(atom);
        // Preserve uncommitted native picker input, as the Animation cards do.
        if (effectiveColor !== renderedColor) {
          color.value = effectiveColor;
          renderedColor = effectiveColor;
        }
      });
      controls.append(color, visibleButton);
      row.append(selection, controls, coordinates);
      list.appendChild(row);
    }
  }
  const selected = selectedAtomSet();
  for (const update of structureAtomUpdates) update(selected);
  for (const update of structureBatchUpdates) update(selected);
  document.getElementById("structure-reset-appearance").hidden = !atoms.some(atom =>
    !atomVisible(atom) || atomEffectiveColor(atom) !== normalizeColor(atom.default_color));
}

function formatCellSettingLabel(value) {
  const mode = String(value || "native").toLowerCase();
  if (mode === "primitive") return "Primitive cell";
  if (mode === "conventional") return "Bravais cell";
  if (mode === "refined") return "Refined";
  if (mode === "hexagonal_conventional") return "Hexagonal conventional";
  return "As loaded";
}

function bravaisLatticeLabel(symmetryLabel) {
  const text = String(symmetryLabel || "").trim();
  const symbol = text.replace(/^\d+\s+/, "");
  const centering = (symbol.match(/^[PABCIFR]/) || ["P"])[0];
  const systemName = crystalSystemFromSymmetryLabel(symmetryLabel);
  const system = systemName.toLowerCase();
  const centeringName = {
    P: "Primitive", A: "Base-centered", B: "Base-centered", C: "Base-centered",
    I: "Body-centered", F: "Face-centered", R: "Rhombohedral",
  }[centering] || centering;
  if (centering === "R") return "Rhombohedral";
  // Trigonal P groups (e.g. quartz P3₂21) have the hexagonal lattice hP.
  if (system === "trigonal") return `${centeringName} hexagonal`;
  return `${centeringName} ${system}`;
}

function symmetryLabelWithGenerators(label, generators, options = {}) {
  const base = options.spaceGroup
    ? formatSpaceGroupLabel(label)
    : options.pointGroup
      ? formatCrystalPointGroupLabel(label)
      : options.groupSymbol
        ? formatGroupSymbol(label || "-")
        : formatSymbol(label || "-");
  const generatorSet = formatGeneratorSet(generators);
  return generatorSet ? `${base} ${generatorSet}` : base;
}

function formatSpaceGroupLabel(label) {
  const text = String(label || "-");
  const match = text.match(/^([0-9]+)\s+(.+)$/);
  if (!match) return formatGroupSymbol(text);
  return `No. ${match[1]} ${formatGroupSymbol(match[2])}`;
}

function formatCrystalPointGroupLabel(label) {
  const text = String(label || "-").trim();
  const schoenflies = CRYSTAL_POINT_GROUP_LABELS[text];
  return schoenflies ? `${formatGroupSymbol(schoenflies)} (${formatGroupSymbol(text)})` : formatGroupSymbol(text);
}

function formatGeneratorSet(generators) {
  if (!Array.isArray(generators) || !generators.length) return "";
  const values = generators.filter((value) => value && value !== "identity only");
  if (!values.length) return "";
  return `⟨${values.map((value) => formatSymbol(value)
    .replace(/^σ([vh])$/, "σ<sub>$1</sub>")
    .replace(/^([CS])(\d+|∞)$/, "$1<sub>$2</sub>")).join(", ")}⟩`;
}

function appendSummaryGrid(root, items, extraClass = "") {
  const grid = document.createElement("div");
  grid.className = extraClass ? `summary-grid ${extraClass}` : "summary-grid";
  for (const [label, value] of items) {
    grid.appendChild(summaryItem(label, value));
  }
  root.appendChild(grid);
}

function summaryItem(label, value) {
  const item = document.createElement("div");
  item.className = "summary-item";
  const labelEl = document.createElement("div");
  labelEl.className = "summary-label";
  labelEl.textContent = label;
  const valueEl = document.createElement("div");
  valueEl.className = "summary-value";
  valueEl.appendChild(renderHtml(String(value)));
  item.appendChild(labelEl);
  item.appendChild(valueEl);
  return item;
}

function syncStructureKindButtons() {
  const button = document.getElementById("structure-kind-toggle");
  const moleculeSelected = selectedStructureKind === "molecule";
  button.textContent = moleculeSelected ? "Molecule" : "Crystal";
  button.dataset.kind = moleculeSelected ? "crystal" : "molecule";
  button.title = moleculeSelected ? "結晶モードに切り替える" : "分子モードに切り替える";
  button.setAttribute("aria-label", button.title);
}

function setStructureKind(kind) {
  if (importInProgress) {
    document.getElementById("status").textContent = "Loading in progress. Wait for it to finish.";
    return;
  }
  selectedStructureKind = kind === "molecule" ? "molecule" : "crystal";
  if (!structureLoadedForSelectedKind() && activeMode === "custom") {
    activeMode = "standard";
    invalidateCustomSequenceWork();
    syncActiveModeControls();
  }
  syncSourceKindControls();
  renderExampleOptions();
  renderStructureInfo();
  renderStatus();
}

function syncImportControls() {
  for (const id of ["import-cif", "cif-file", "import-molecule", "molecule-file", "example-select"]) {
    document.getElementById(id).disabled = importInProgress;
  }
  for (const button of document.querySelectorAll(".structure-kind-button")) {
    button.disabled = importInProgress;
  }
  document.getElementById("example-select-display").disabled = importInProgress;
  for (const id of ["import-cif", "import-molecule", "example-select-display"]) {
    const control = document.getElementById(id);
    const busy = importInProgress && id === importBusyControlId;
    control.classList.toggle("is-busy", busy);
    control.setAttribute("aria-busy", String(busy));
  }
  document.getElementById("operation-sort").disabled = importInProgress;
}

function renderExampleOptions() {
  const select = document.getElementById("example-select");
  const menu = document.getElementById("example-select-menu");
  const items = sortedExampleItems(exampleCatalog[selectedStructureKind] || [], selectedStructureKind);
  select.innerHTML = "";
  menu.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Select example...";
  select.appendChild(placeholder);
  for (const item of items) {
    const option = document.createElement("option");
    option.value = item.path;
    option.textContent = exampleOptionText(item);
    if (item.error) option.title = item.error;
    select.appendChild(option);
    const menuItem = document.createElement("button");
    menuItem.type = "button";
    menuItem.className = "rich-select-option";
    menuItem.dataset.value = item.path;
    const prefix = document.createElement("span");
    const itemFormula = exampleFormula(item);
    prefix.replaceChildren(renderHtml(`${itemFormula ? `${formatChemicalFormula(itemFormula)} ` : ""}${escapeText(exampleDisplayName(item.name))}`));
    menuItem.appendChild(prefix);
    if (item.symmetry) {
      menuItem.appendChild(document.createTextNode(" — "));
      const symmetry = document.createElement("span");
      symmetry.appendChild(renderHtml(formatGroupSymbol(exampleSymmetryLabel(item))));
      menuItem.appendChild(symmetry);
    }
    menuItem.addEventListener("click", () => {
      if (importInProgress) return;
      select.value = item.path;
      select.dispatchEvent(new Event("change", {bubbles: true}));
    });
    menu.appendChild(menuItem);
  }
  const shownPath = selectedExamplePath || serverLoadedExamplePath(items);
  select.value = items.some(item => item.path === shownPath) ? shownPath : "";
  syncExamplePicker(items);
  document.getElementById("example-select-display").disabled = importInProgress || items.length === 0;
}

// After a page reload the server may still show an example opened earlier.
// Name it in the picker: examples are exported as exports/json/<slug>.json
// (imports go to a subfolder), with the slug of crystal_viewer.export_pipeline.
function serverLoadedExamplePath(items) {
  if (structureOpenedInPage || !structureLoadedForSelectedKind()) return "";
  const parts = String(state.json_path || "").split(/[\\/]/);
  if (parts.length < 3 || parts.at(-3) !== "exports" || parts.at(-2) !== "json") return "";
  const slug = parts.at(-1).replace(/\.json$/, "");
  const slugOf = path => String(path).split(/[\\/]/).pop().replace(/\.[^.]*$/, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "structure";
  return items.find(item => slugOf(item.path) === slug)?.path || "";
}

function syncExamplePicker(items = sortedExampleItems(exampleCatalog[selectedStructureKind] || [], selectedStructureKind)) {
  const select = document.getElementById("example-select");
  const selected = items.find(item => item.path === select.value);
  const trigger = document.getElementById("example-select-display");
  trigger.replaceChildren();
  if (!selected) {
    trigger.textContent = "Select example...";
  } else {
    const prefix = document.createElement("span");
    prefix.replaceChildren(renderHtml(`${exampleFormula(selected) ? `${formatChemicalFormula(exampleFormula(selected))} ` : ""}${escapeText(exampleDisplayName(selected.name))}`));
    trigger.appendChild(prefix);
    if (selected.symmetry) {
      trigger.appendChild(document.createTextNode(" — "));
      trigger.appendChild(renderHtml(formatGroupSymbol(exampleSymmetryLabel(selected))));
    }
  }
  for (const item of document.querySelectorAll("#example-select-menu .rich-select-option")) {
    item.classList.toggle("selected", item.dataset.value === select.value);
  }
}

function sortedExampleItems(items, kind) {
  const sorted = [...items];
  if (kind !== "crystal") return sorted;
  return sorted.sort((a, b) => {
    const numberA = spaceGroupNumber(a.symmetry);
    const numberB = spaceGroupNumber(b.symmetry);
    return compareNumber(numberA, numberB) || compareText(a.name || "", b.name || "");
  });
}

function spaceGroupNumber(label) {
  const match = String(label || "").match(/(?:No[.][ ]*)?([0-9]+)/);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function exampleFormula(item) {
  // display_formula keeps molecules readable (C6H6 rather than the reduced HC).
  return item.display_formula || item.formula || "";
}

function exampleSymmetryLabel(item) {
  const text = String(item.symmetry || "");
  return item.kind === "crystal" ? text.replace(/^(?:No\.?\s*)?\d+\s+/i, "") : text;
}

function exampleOptionText(item) {
  const formula = exampleFormula(item) ? `${plainChemicalFormula(exampleFormula(item))} ` : "";
  const symmetry = item.symmetry ? formatPlainOverbar(formatSymbol(exampleSymmetryLabel(item))) : "";
  const name = exampleDisplayName(item.name);
  return symmetry ? `${formula}${name} — ${symmetry}` : `${formula}${name}`;
}

function metadataFormula(metadata) {
  // display_formula keeps molecules readable (C6H6 rather than the reduced HC,
  // Mn12Al42 rather than Mn2Al7). The two agree for crystals. The example
  // picker already reads it through exampleFormula(); the structure panel and
  // the header subtitle have to agree with the name the picker showed.
  return metadata.display_formula || metadata.formula || "";
}

function beginImport(message, controlId = "example-select-display") {
  finishImportWaiting?.();
  finishImportWaiting = analysisWaiting.begin();
  importInProgress = true;
  importBusyControlId = controlId;
  // Take the id from the clock, not from a counter. puzzle.js stamps its own
  // loads with Date.now() and the server keeps max(stored, incoming) so that
  // the newest load wins; a counter starting at 1 is below every timestamp the
  // puzzle has sent, so after playing a quiz every analysis-mode load came back
  // {"ok": false, "stale": true} and was silently discarded — the old structure
  // simply stayed on screen. Stay monotonic so two loads in the same
  // millisecond still get distinct ids.
  const requestId = Math.max(Date.now(), importRequestId + 1);
  importRequestId = requestId;
  hideLoadError();
  syncImportControls();
  syncCellPlacementControls();
  document.getElementById("status").textContent = message;
  return requestId;
}

function finishImport(requestId) {
  if (requestId !== importRequestId) return;
  importInProgress = false;
  finishImportWaiting?.();
  finishImportWaiting = null;
  syncImportControls();
  syncCellPlacementControls();
}

function isCurrentImport(requestId) {
  return requestId === importRequestId;
}

function hideLoadError() {
  const panel = document.getElementById("load-error-panel");
  if (panel) panel.hidden = true;
}

document.getElementById("load-error-close").addEventListener("click", () => {
  const status = document.getElementById("status");
  if (status.textContent === document.getElementById("load-error-title").textContent) status.textContent = "";
  hideLoadError();
  document.getElementById("example-select-display").focus({preventScroll: true});
});

function showLoadError(title, rawError, context = {}) {
  const panel = document.getElementById("load-error-panel");
  if (!panel) return;
  const message = loadFailureMessage(title, String(rawError || ""), context);
  panel.lang = /[ぁ-んァ-ヶ一-龯]/.test(message) ? "ja" : "en";
  document.getElementById("load-error-title").textContent = message;
  panel.hidden = false;
  document.getElementById("status").textContent = message;
}

function showConnectionError(error) {
  if (error.obsolete || /^stale_/.test(error.message)) return;
  showLoadError("接続できませんでした", error);
}

function loadFailureMessage(title, errorText, context = {}) {
  // Classify known failures without showing parser output, paths or tracebacks.
  // Unknown failures keep a neutral message rather than guessing their cause.
  if (!/import|load|preparation/i.test(title)) return title;
  const lower = errorText.toLowerCase();
  if (lower.includes("correction limit exceeded") || lower.includes("correction_limit_exceeded")) {
    return "構造の補正量が上限を超えています";
  }
  if (lower.includes("timed out") || lower.includes("timeout")) {
    return "解析が制限時間内に完了しませんでした";
  }
  if (lower.includes("unsupported input file type")) {
    return "結晶はCIF、分子はXYZファイルを選んでください";
  }
  if (lower.includes("no such file") || lower.includes("not found")) {
    return "ファイルが見つかりませんでした";
  }
  if (lower.includes("empty") && (lower.includes("cif") || lower.includes("file"))) {
    return "ファイルにデータがありません";
  }
  if (lower.includes("not available in the web version")) {
    return "静的Web版ではファイルを取り込めません";
  }
  if (context.kind === "CIF") return "CIFファイルを読み込めませんでした";
  if (context.kind === "XYZ") return "XYZファイルを読み込めませんでした";
  return "構造を読み込めませんでした";
}

function syncOperationSelection() {
  for (const row of document.querySelectorAll("#operations .operation-row")) {
    const selected = Number(row.dataset.index) === state.operation_index;
    row.classList.toggle("selected", selected);
    row.setAttribute("aria-selected", selected ? "true" : "false");
  }
  revealSelectedOperationRow();
}

// When the selection changes without a click on its row (‹ ›, ↑↓, the quiz's
// 解析モードで確認), scroll only the list so the selected row is visible. The
// same selection is revealed once, so a user's own list scrolling is kept.
function revealSelectedOperationRow() {
  const root = document.getElementById("operations");
  const row = root?.querySelector(".operation-row.selected");
  if (!row || !root.clientHeight) return;
  const key = `${state.json_path || ""}|${state.reload_request_id || ""}|${experienceMode}|${state.operation_index}`;
  if (key === revealedOperationKey) return;
  revealedOperationKey = key;
  const outer = root.getBoundingClientRect();
  const inner = row.getBoundingClientRect();
  const margin = 8;
  if (inner.top >= outer.top && inner.bottom <= outer.bottom) return;
  // One step past an edge (‹ › / ↑↓) scrolls by that step. A distant row is
  // placed a third of the way down, which also survives the list becoming a
  // little shorter when the analysis prepared behind the quiz is shown.
  const near = inner.bottom > outer.top - inner.height && inner.top < outer.bottom + inner.height;
  if (!near) root.scrollTop += inner.top - outer.top - root.clientHeight / 3;
  else if (inner.top < outer.top) root.scrollTop -= outer.top - inner.top + margin;
  else root.scrollTop += inner.bottom - outer.bottom + margin;
}

// ↑↓ in the Standard list select the previous/next visible operation, like ‹ ›.
document.getElementById("operations").addEventListener("keydown", async event => {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  event.preventDefault();
  if (operationNavigationBusy) return;
  const rows = [...event.currentTarget.querySelectorAll(".operation-row")];
  const current = rows.findIndex(row => Number(row.dataset.index) === state.operation_index);
  const targetRow = rows[current < 0 ? 0 : current + (event.key === "ArrowDown" ? 1 : -1)];
  const target = targetRow && operations.find(item => item.index === Number(targetRow.dataset.index));
  if (!target) return;
  operationNavigationBusy = true;
  try {
    await selectStandardOperation(target);
  } finally {
    operationNavigationBusy = false;
    operationInformationSignature = "";
    syncOperationInformation();
  }
  document.querySelector(`#operations .operation-row[data-index="${target.index}"]`)?.focus({preventScroll: true});
});

function fmtFrac(v) {
  if (v === null || v === undefined) return "?";
  const r = Math.round(v * 1e9) / 1e9;
  if (Math.abs(r - Math.round(r)) < 1e-8) return String(Math.round(r) || 0);
  // try to express as a simple fraction with denominator ≤ 24
  for (const d of [2, 3, 4, 6, 8, 12, 24]) {
    const n = Math.round(r * d);
    if (Math.abs(n / d - r) < 1e-8) return n === 0 ? "0" : `${n}/${d}`;
  }
  return r.toFixed(4);
}

function renderOperationDetails() {
  syncOperationInformation();
}

function renderCustomInformation() {
  operationInformationRequest++;
  const panel = document.getElementById("operation-info-panel");
  const root = document.getElementById("operation-info-content");
  root.replaceChildren();
  document.getElementById("operation-info-name").textContent = "Custom";
  document.getElementById("operation-info-prev").hidden = true;
  document.getElementById("operation-info-next").hidden = true;
  delete panel.dataset.operationIndex;
  panel.onkeydown = null;
  const result = copMatrix?.result;
  if (!result) return;
  const transforms = document.createElement("div");
  transforms.className = "operation-information-grid";
  root.appendChild(transforms);
  appendInformationTransform(transforms, {W: result.W_frac, t: result.t_frac}, true,
    {W: result.W_frac, t: result.t_frac}, false);
  const heading = document.createElement("h3");
  heading.className = "custom-mapping-heading";
  heading.textContent = "原子の移動";
  const count = document.createElement("span");
  count.className = "custom-mapping-count";
  count.textContent = `不一致 ${result.unmapped.length} / ${result.total}`;
  heading.appendChild(count);
  root.appendChild(heading);
  const container = document.createElement("div");
  container.className = "custom-mapping-scroll";
  const table = document.createElement("table");
  table.className = "custom-mapping-table";
  const columns = document.createElement("colgroup");
  for (const name of ["atom", "movement", "match"]) {
    const column = document.createElement("col");
    column.className = `custom-mapping-${name}-column`;
    columns.appendChild(column);
  }
  table.appendChild(columns);
  const head = table.createTHead().insertRow();
  for (const text of ["原子", "元の位置 → 移動先", "対応"]) {
    const cell = document.createElement("th");
    cell.scope = "col"; cell.textContent = text; head.appendChild(cell);
  }
  const body = table.createTBody();
  const coordinates = values => formatVector(values, SymmetryOperationMath.number);
  for (const item of [...result.unmapped.map(item => ({...item, unmatched:true})), ...result.mapped]) {
    const row = body.insertRow();
    row.dataset.sourceAtom = item.source;
    row.classList.toggle("custom-mapping-unmatched", Boolean(item.unmatched));
    row.insertCell().textContent = `${item.element} ${item.source}`;
    row.insertCell().textContent = `${coordinates(item.source_frac)} → ${coordinates(item.transformed_frac)}`;
    const image = item.target_image?.some(value => value !== 0) ? ` + セル並進${coordinates(item.target_image)}` : "";
    row.insertCell().textContent = item.unmatched ? item.candidate_count > 1 ? "候補が複数" : "一致なし"
      : `${item.element} ${item.target}${image}と一致`;
  }
  container.appendChild(table);
  root.appendChild(container);
}


function renderSelectedAtomSummary() {
  const root = document.getElementById("selected-atom-summary");
  if (!root) return;
  const selected = selectedAtomSet();
  const signature = JSON.stringify({
    source: state.json_path,
    reload: state.reload_request_id,
    sourceKind,
    selected: [...selected].sort((a, b) => a - b),
    atoms: atoms.map(atom => [atom.index, atomDisplayLabel(atom), atom.frac, atom.cart, atom.default_color]),
  });
  // Keep native color inputs attached through polling, playback and color
  // changes. Rebuild only when the selected cards or their structure change.
  if (signature === lastSelectedAtomStructureSignature && root.childElementCount) {
    for (const update of selectedAtomCardUpdates) update();
    return;
  }
  lastSelectedAtomStructureSignature = signature;
  selectedAtomCardUpdates = [];
  root.innerHTML = "";
  const selectors = document.createElement("div");
  selectors.className = "atom-element-selectors";
  const selectionGroups = new Map();
  for (const atom of atoms) {
    const label = sourceKind === "crystal" ? atomDisplayLabel(atom) : atom.element;
    if (!selectionGroups.has(label)) selectionGroups.set(label, []);
    selectionGroups.get(label).push(Number(atom.index));
  }
  const selectionChoices = [
    ["All", atoms.map(atom => Number(atom.index))],
    ...[...selectionGroups.entries()].sort((a, b) => compareText(a[0], b[0])),
  ];
  for (const [label, indices] of selectionChoices) {
    const allSelected = indices.length > 0 && indices.every(index => selected.has(index));
    const button = document.createElement("button");
    button.type = "button";
    button.className = `atom-element-selector${allSelected ? " selected" : ""}`;
    button.textContent = label;
    const clearsSelection = allSelected && selected.size === indices.length;
    button.title = label === "All"
      ? clearsSelection ? "すべての原子の選択を解除" : "すべての原子を選択"
      : clearsSelection ? `${label}原子の選択を解除` : `${label}原子をまとめて選択`;
    button.addEventListener("click", event => {
      let next;
      if (event.ctrlKey || event.metaKey || event.shiftKey) {
        next = new Set(selected);
        for (const index of indices) {
          if (allSelected) next.delete(index);
          else next.add(index);
        }
      } else {
        next = allSelected && selected.size === indices.length ? new Set() : new Set(indices);
      }
      postState({
        selected_atoms: [...next].sort((a, b) => a - b),
        scope: next.size ? "selected_displayed" : "displayed",
        playing: false,
        reset: true,
      });
    });
    selectors.appendChild(button);
  }
  const resetAppearance = document.createElement("button");
  resetAppearance.type = "button";
  resetAppearance.className = "atom-element-selector reset-appearance-button";
  resetAppearance.textContent = "Reset appearance";
  resetAppearance.title = "全原子の色と表示状態を初期状態に戻す";
  resetAppearance.setAttribute("aria-label", resetAppearance.title);
  resetAppearance.addEventListener("click", resetAtomAppearance);
  selectors.appendChild(resetAppearance);
  root.appendChild(selectors);
  document.getElementById("atom-selection-guide").hidden = !selected.size;
  if (!selected.size) return;
  const details = document.createElement("details");
  details.className = "selected-atom-details";
  details.open = selectedAtomDetailsOpen;
  details.addEventListener("toggle", () => {
    selectedAtomDetailsOpen = details.open;
  });
  const summary = document.createElement("summary");
  summary.textContent = `Selected atoms (${selected.size})`;
  details.appendChild(summary);
  const cards = document.createElement("div");
  cards.className = "selected-atom-cards";
  for (const atom of atoms.filter(item => selected.has(Number(item.index)))) {
    const card = document.createElement("div");
    card.className = "selected-atom-card";
    const header = document.createElement("div");
    header.className = "selected-atom-card-header";
    const name = document.createElement("div");
    name.className = "selected-atom-name";
    name.textContent = `${atomDisplayLabel(atom)} ${atom.index}`;
    const controls = document.createElement("div");
    controls.className = "selected-atom-controls";
    const visible = atomVisible(atom);
    const visibleButton = visibilityButton(visible, visible ? "原子を非表示" : "原子を表示", () => {
      postState(atomVisibilityUpdate(atom, atomVisible(atom)));
    });
    const colorInput = document.createElement("input");
    colorInput.type = "color";
    colorInput.value = atomEffectiveColor(atom);
    colorInput.title = `原子${atom.index}の色を変更`;
    colorInput.setAttribute("aria-label", `原子${atom.index}の色を変更`);
    colorInput.addEventListener("change", () => {
      const next = Object.assign({}, state.atom_colors || {});
      next[String(atom.index)] = colorInput.value;
      postState({atom_colors: next});
    });
    controls.append(visibleButton, colorInput);
    header.append(name, controls);
    const coordinates = document.createElement("div");
    coordinates.className = "selected-atom-coordinates";
    let renderedColor = colorInput.value;
    const updateCard = () => {
      const motion = atomMotionBySource.get(atom.index);
      const start = sourceKind === "crystal" ? (motion?.start_frac ?? atom.frac) : (motion?.start_cart ?? atom.cart);
      const target = sourceKind === "crystal" ? motion?.target_frac : motion?.target_cart;
      const formatter = sourceKind === "crystal" ? formatFrac : formatCoord;
      const unit = sourceKind === "crystal" ? "" : " Å";
      const text = Array.isArray(start) && Array.isArray(target)
        ? `${formatVector(start, formatter)} → ${formatVector(target, formatter)}${unit}`
        : (Array.isArray(start) ? `${formatVector(start, formatter)}${unit}` : "座標情報を取得できません");
      if (coordinates.textContent !== text) coordinates.textContent = text;
      const visible = atomVisible(atom);
      visibleButton.classList.toggle("hidden", !visible);
      visibleButton.textContent = visible ? "Visible" : "Hidden";
      const title = visible ? "原子を非表示" : "原子を表示";
      visibleButton.title = title;
      visibleButton.setAttribute("aria-label", title);
      const color = atomEffectiveColor(atom);
      // An uncommitted picker value belongs to the user. Only synchronize
      // when the effective server color changes, including appearance reset.
      if (color !== renderedColor) {
        colorInput.value = color;
        renderedColor = color;
      }
    };
    updateCard();
    selectedAtomCardUpdates.push(updateCard);
    card.appendChild(header);
    card.appendChild(coordinates);
    cards.appendChild(card);
  }
  details.appendChild(cards);
  root.appendChild(details);
}

function operationListRenderSignature(sorted) {
  return JSON.stringify({
    // The rows must be keyed on what they say, not just how many there are.
    // `operations` and `state` are refreshed by separate responses, so there is
    // a moment when the new structure's json_path is paired with the previous
    // structure's operations; benzene and methane both have 24 operations
    // numbered 0-23, and indices alone left methane's rows on screen.
    source: state.json_path || "",
    reload: state.reload_request_id || 0,
    operations: sorted.map(operation => [
      operation.index,
      operation.symbol || "",
      operation.display_symbol || "",
    ]),
    selected: state.operation_index,
    operationTypeFilterValue,
    directionFilterValue,
    experienceMode,
    improperMode: state.improper_mode || "auto",
    // element_summary, the axis/plane/center group headers and the per-row
    // direction hint all read fields that only arrive once summaries are
    // ready. Without this, the first (pre-summary) render's signature still
    // matches once the real data lands, and the refresh that re-fetches
    // `operations` at that point (see refreshState) silently no-ops here.
    summariesReady,
  });
}

function syncSpeedButtons() {
  const speed = Number(state.speed || 1.0);
  const output = document.getElementById("animation-speed-value");
  output.value = `${speed.toFixed(2)}×`;
  output.textContent = output.value;
  document.getElementById("animation-speed-previous").disabled = speedUpdatePending || speed <= ANIMATION_SPEED_STEPS[0];
  document.getElementById("animation-speed-next").disabled = speedUpdatePending || speed >= ANIMATION_SPEED_STEPS.at(-1);
  document.getElementById("pause-at-breakpoints").checked = Boolean(state.pause_at_breakpoints);
  document.getElementById("show-trajectories").checked = Boolean(state.show_trajectories);
}

const displayRangeSteps = [
  {mode: "source", label: "Initial"},
  {mode: "expanded_quarter", label: "±1/4"},
  {mode: "expanded_half", label: "±1/2"},
  {mode: "expanded_0_75", label: "±3/4"},
  {mode: "expanded_1_0", label: "±1"},
];

function displayRangeIndices() {
  const mode = state.display_mode || "source";
  if (/^expanded_axes:[0-4],[0-4],[0-4]$/.test(mode)) {
    return mode.slice("expanded_axes:".length).split(",").map(Number);
  }
  const index = Math.max(0, displayRangeSteps.findIndex(step => step.mode === mode));
  return [index, index, index];
}

function displayedRangeIndex() {
  const indices = displayRangeIndices();
  const axis = document.getElementById("display-range-axis").value;
  if (axis !== "all") {
    return indices[Number(axis)];
  }
  // All's first click from Custom advances from the widest current range,
  // then applies that uniform value to all axes.
  return Math.max(...indices);
}

function syncDisplayButtons() {
  const allAxes = document.getElementById("display-range-axis").value === "all";
  const indices = displayRangeIndices();
  const mixed = !indices.every(index => index === indices[0]);
  const index = displayedRangeIndex();
  const axisSelect = document.getElementById("display-range-axis");
  const busy = displayRangeUpdatePending || cellSettingsResetBusy;
  axisSelect.disabled = busy;
  document.getElementById("display-range-value").textContent =
    allAxes && mixed ? "Custom" : displayRangeSteps[index].label;
  document.getElementById("display-range-decrease").disabled = busy || index === 0;
  document.getElementById("display-range-increase").disabled = busy
    || (index === displayRangeSteps.length - 1 && (!allAxes || !mixed));
  const boundary = document.getElementById("include-boundary-images");
  boundary.setAttribute("aria-pressed", String(Boolean(state.include_boundary_images)));
  boundary.title = state.include_boundary_images ? "境界上の原子を非表示" : "境界上の原子を表示";
  boundary.setAttribute("aria-label", boundary.title);
}

async function changeDisplayRange(offset) {
  if (displayRangeUpdatePending || cellSettingsResetBusy) return;
  const displayMode = state.display_mode || "source";
  const currentIndex = displayedRangeIndex();
  const nextIndex = Math.max(0, Math.min(displayRangeSteps.length - 1, currentIndex + offset));
  const indices = displayRangeIndices();
  const axis = document.getElementById("display-range-axis").value;
  if (axis !== "all") indices[Number(axis)] = nextIndex;
  else indices.fill(nextIndex);
  const nextMode = indices.every(index => index === indices[0])
    ? displayRangeSteps[indices[0]].mode : `expanded_axes:${indices.join(",")}`;
  if (nextMode === displayMode) return;
  displayRangeUpdatePending = true;
  state.display_mode = nextMode;
  syncDisplayButtons();
  syncCellSettingButtons();
  document.getElementById("display-range-decrease").disabled = true;
  document.getElementById("display-range-increase").disabled = true;
  try {
    await postState({
      display_mode: nextMode,
      playing: false,
      reset: true,
    });
  } catch (error) {
    state.display_mode = displayMode;
    throw error;
  } finally {
    displayRangeUpdatePending = false;
    syncDisplayButtons();
    syncCellSettingButtons();
  }
}

let cellPlacementChoices = [];
let cellPlacementChoicesKey = "";
let cellPlacementPendingKey = "";
let cellPlacementErrorKey = "";
let cellPlacementBusy = false;
let cellSettingBusy = false;
let cellSettingsResetBusy = false;
let cellPlacementAtomOptionsKey = "";

function placementSelectionKey() {
  return JSON.stringify([state.json_path, state.reload_request_id, state.scope, state.selected_atoms]);
}

function syncCellPlacementControls() {
  const selected = state.selected_atoms || [];
  const enabled = sourceKind === "crystal" && String(state.scope).startsWith("selected") && selected.length === 1;
  const atomSelector = document.getElementById("cell-placement-atom");
  const atomOptionsKey = JSON.stringify(atoms.map(atom => [atom.index, atom.element]));
  if (atomOptionsKey !== cellPlacementAtomOptionsKey) {
    const placeholder = new Option("Select atom", "");
    atomSelector.replaceChildren(placeholder, ...atoms.map(atom => new Option(`${atom.element} ${atom.index}`, String(atom.index))));
    cellPlacementAtomOptionsKey = atomOptionsKey;
  }
  atomSelector.value = enabled ? String(selected[0]) : "";
  atomSelector.disabled = sourceKind !== "crystal" || !atoms.length || cellPlacementBusy || cellSettingBusy || cellSettingsResetBusy || importInProgress;
  const key = placementSelectionKey();
  if (key !== cellPlacementChoicesKey) {
    cellPlacementChoicesKey = key;
    cellPlacementChoices = [];
    clearCellPlacementError();
  }
  if (enabled && !cellPlacementChoices.length && cellPlacementPendingKey !== key) {
    cellPlacementPendingKey = key;
    api("/api/cell_placement").then(result => {
      if (placementSelectionKey() !== key) return;
      cellPlacementChoices = result.choices || [];
      // An empty response can belong to an older server-side selection.
      // Leave the controls disabled until a later state refresh retries it.
      if (cellPlacementChoices.length) {
        if (cellPlacementErrorKey === key) {
          hideLoadError();
          cellPlacementErrorKey = "";
        }
        syncCellPlacementControls();
      }
    }).catch(error => {
      if (placementSelectionKey() === key) {
        cellPlacementErrorKey = key;
        showLoadError("配置の候補を取得できませんでした", error);
      }
    }).finally(() => {
      if (cellPlacementPendingKey === key) cellPlacementPendingKey = "";
    });
  }
  const current = state.cell_placement || "initial";
  const index = cellPlacementChoices.findIndex(choice => choice.key === current || choice.members?.includes(current));
  const currentChoice = cellPlacementChoices[index];
  const fallback = {initial: "Initial", center: "Center", corner: "Corner", custom: "Coordinates",
    face_ab: "Face (C)", face_ac: "Face (B)", face_bc: "Face (A)"};
  document.getElementById("cell-placement-value").textContent = currentChoice?.label || fallback[current] || "Initial";
  const disabled = !enabled || !cellPlacementChoices.length || cellPlacementBusy || cellSettingBusy || cellSettingsResetBusy || importInProgress;
  document.getElementById("cell-placement-previous").disabled = disabled || index <= 0;
  document.getElementById("cell-placement-next").disabled = disabled || index >= cellPlacementChoices.length - 1;
  document.getElementById("cell-placement-coordinates").hidden = current !== "custom";
  document.getElementById("cell-placement-apply").disabled = disabled;
  for (const axis of ["x", "y", "z"]) document.getElementById(`cell-placement-${axis}`).disabled = disabled;
}

async function changeCellPlacement(offset) {
  if (cellPlacementBusy) return;
  const current = state.cell_placement || "initial";
  const index = cellPlacementChoices.findIndex(choice => choice.key === current || choice.members?.includes(current));
  const choice = cellPlacementChoices[Math.max(0, Math.min(cellPlacementChoices.length - 1, index + offset))];
  if (!choice) return;
  clearCellPlacementError();
  if (choice.key === "custom") {
    for (const axis of ["x", "y", "z"]) document.getElementById(`cell-placement-${axis}`).value = "0";
  }
  await applyCellPlacement(choice.key);
}

function clearCellPlacementError() {
  const error = document.getElementById("cell-placement-error");
  error.hidden = true;
  error.textContent = "";
  for (const axis of ["x", "y", "z"]) {
    const input = document.getElementById(`cell-placement-${axis}`);
    input.removeAttribute("aria-invalid");
    input.removeAttribute("aria-errormessage");
  }
}

function cellPlacementTarget(focusInvalid = false) {
  clearCellPlacementError();
  let firstInvalid = null;
  const target = ["x", "y", "z"].map(axis => {
    const input = document.getElementById(`cell-placement-${axis}`);
    const value = Number(input.value);
    if (!input.value.trim() || !Number.isFinite(value) || value < 0 || value > 1) {
      input.setAttribute("aria-invalid", "true");
      input.setAttribute("aria-errormessage", "cell-placement-error");
      firstInvalid ??= input;
    }
    return value;
  });
  if (firstInvalid) {
    const error = document.getElementById("cell-placement-error");
    error.textContent = "0〜1で入力";
    error.hidden = false;
    if (focusInvalid) firstInvalid.focus();
    return null;
  }
  return target;
}

async function applyCellPlacement(placement) {
  if (cellPlacementBusy) return;
  const target = placement === "custom" ? cellPlacementTarget(true)
    : ["x", "y", "z"].map(axis => Number(document.getElementById(`cell-placement-${axis}`).value));
  if (!target) return;
  cellPlacementBusy = true;
  clearTimeout(loopRestartTimer);
  loopRestartTimer = null;
  syncCellPlacementControls();
  syncCellSettingButtons();
  try {
    const result = await api("/api/cell_placement", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({placement, target}),
    });
    await applyRebuiltStructure(result);
  } finally {
    cellPlacementBusy = false;
    syncCellPlacementControls();
    syncCellSettingButtons();
  }
}

function resetInputControls(root) {
  if (root.id === "cell-placement-coordinates") clearCellPlacementError();
  for (const input of root.querySelectorAll("input")) {
    input.value = input.defaultValue;
    input.checked = input.defaultChecked;
  }
  for (const select of root.querySelectorAll("select")) {
    const initial = [...select.options].findIndex(option => option.defaultSelected);
    select.selectedIndex = Math.max(0, initial);
  }
  if (root.id === "camera-settings") syncIndexedViewInputs();
}

async function resetCellSettings() {
  const highlight = document.getElementById("range-highlight");
  if (sourceKind !== "crystal" || cellSettingsResetBusy || cellPlacementBusy || cellSettingBusy
      || displayRangeUpdatePending || importInProgress || highlight.disabled) return;
  cellSettingsResetBusy = true;
  highlight.disabled = true;
  syncDisplayButtons();
  syncCellPlacementControls();
  syncCellSettingButtons();
  try {
    const placementChanged = state.cell_placement !== "initial"
      || (state.cell_origin_frac || []).some(value => Math.abs(Number(value)) > 1e-12);
    if (placementChanged) {
      const result = await api("/api/cell_placement", {
        method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({placement: "initial", reset_settings: true}),
      });
      await applyRebuiltStructure(result);
    } else if (state.display_mode !== "source" || highlight.checked) {
      await postState({display_mode: "source", range_highlight: false, playing: false, reset: true});
    }
    resetInputControls(document.getElementById("cell-placement-coordinates"));
    document.getElementById("display-range-axis").value = "all";
    highlight.checked = false;
    const view = window.symmetryThreeView;
    if (view) {
      await view.syncQueue;
      view.setRangeHighlight(false);
    }
  } finally {
    cellSettingsResetBusy = false;
    highlight.disabled = false;
    syncDisplayButtons();
    syncCellPlacementControls();
    syncCellSettingButtons();
  }
}

function resetCustomControls() {
  closeCustomOperationMenu();
  customOperationFilterValue = "";
  delete document.getElementById("cop-operation-select").dataset.initialized;
  document.getElementById("cop-operation-menu").scrollTop = 0;
  document.getElementById("cop-operation-filter").scrollLeft = 0;
  resetInputControls(document.getElementById("custom-panel"));
  document.getElementById("cop-type").dispatchEvent(new Event("change"));
  customOperationSequence = [];
  customUnmappedAtoms = new Set();
  copSelectedAtoms = new Set();
  copAllUnmapped = [];
  copMatrix = null;
  invalidateCustomSequenceWork();
  renderCustomSequenceControls();
}

function displayedCellSettingMode() {
  return state.cell_setting_mode && state.cell_setting_mode !== "native"
    ? state.cell_setting_mode : state.cell_basis?.mode;
}

function cellBasisSwitchIsUnnecessary() {
  return state.cell_basis?.equivalent
    && ["primitive", "conventional"].includes(displayedCellSettingMode());
}

function syncCellSettingButtons() {
  const cellSettingMode = displayedCellSettingMode();
  const button = document.getElementById("cell-setting-toggle");
  const control = document.getElementById("cell-setting-control");
  const help = document.getElementById("cell-setting-help");
  const crystal = sourceKind === "crystal";
  const reset = document.getElementById("reset-cell-settings");
  reset.hidden = !crystal;
  reset.disabled = cellSettingsResetBusy || cellSettingBusy || cellPlacementBusy
    || displayRangeUpdatePending || importInProgress || document.getElementById("range-highlight").disabled;
  button.hidden = !crystal;
  control.hidden = !crystal;
  button.textContent = cellSettingMode === "primitive" ? "Primitive"
    : cellSettingMode === "conventional" ? "Bravais" : "Cell basis";
  const nextMode = cellSettingMode === "primitive" ? "conventional" : "primitive";
  button.dataset.cellSettingMode = nextMode;
  help.textContent = cellBasisSwitchIsUnnecessary()
    ? "P格子なので、PrimitiveとBravaisは同じです。"
    : cellSettingMode === "other"
    ? "読み込んだセルはPrimitive／Bravaisのいずれでもありません。Primitiveに切り替える"
    : cellSettingMode === "unknown" || !cellSettingMode
      ? "セル基底を判定できませんでした。Primitiveに切り替える"
      : `${nextMode === "primitive" ? "Primitive" : "Bravais"}に切り替える`;
  button.disabled = cellSettingBusy || cellPlacementBusy || cellSettingsResetBusy || importInProgress || Boolean(cellBasisSwitchIsUnnecessary());
  control.tabIndex = button.disabled ? 0 : -1;
  if (!crystal) help.hidden = true;
}

const cellSettingControl = document.getElementById("cell-setting-control");
const cellSettingHelp = document.getElementById("cell-setting-help");
for (const event of ["mouseenter", "focusin"]) {
  cellSettingControl.addEventListener(event, () => { cellSettingHelp.hidden = false; });
}
for (const event of ["mouseleave", "focusout"]) {
  cellSettingControl.addEventListener(event, () => {
    if (!cellSettingControl.matches(":hover") && !cellSettingControl.contains(document.activeElement)) {
      cellSettingHelp.hidden = true;
    }
  });
}
cellSettingControl.addEventListener("keydown", event => {
  if (event.key === "Escape") cellSettingHelp.hidden = true;
});

function setCellSettingBusy(busy, mode = "") {
  cellSettingBusy = busy;
  syncCellSettingButtons();
  syncCellPlacementControls();
  if (busy) {
    document.getElementById("status").textContent =
      `Converting cell setting to ${formatCellSettingLabel(mode)}...`;
  }
}

function syncProjectionButtons() {
  const perspective = (state.projection_mode || "perspective") === "perspective";
  for (const button of document.querySelectorAll(".projection-button")) {
    if (button.id === "projection-toggle-overlay") {
      const path = perspective ? "M3 4l18 5M3 12h18M3 20l18-5" : "M3 4h18M3 12h18M3 20h18";
      button.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></svg>`;
    } else {
      button.textContent = perspective ? "Perspective" : "Orthographic";
    }
    button.dataset.projectionMode = perspective ? "orthographic" : "perspective";
    button.title = perspective ? "平行投影に切り替える" : "透視投影に切り替える";
    button.setAttribute("aria-label", button.title);
  }
}

function syncBackgroundButtons() {
  const dark = (state.background_mode || "light") === "dark";
  const button = document.getElementById("background-toggle");
  if (!button) return;
  button.textContent = dark ? "Black" : "White";
  button.dataset.backgroundMode = dark ? "light" : "dark";
  button.title = dark ? "Switch to white background" : "Switch to black background";
}

function syncLegendButtons() {
  const visible = Boolean(state.legend_visible);
  renderSelectedOperationOverlay();
  // Hiding the legend also clears the other structure buttons; only the
  // legend button stays so the view can be restored.
  threeViewPanel.classList.toggle("view-buttons-hidden", !visible);
  const button = document.getElementById("legend-toggle");
  if (!button) return;
  button.setAttribute("aria-pressed", String(visible));
  button.title = visible ? "凡例を非表示" : "凡例を表示";
  button.setAttribute("aria-label", button.title);
}

function syncImproperModeControl() {
  improperModeControl.value = resolvedImproperMode();
}

function syncPlayToggleButton() {
  const button = document.getElementById("play-toggle");
  const boundaryPaused = atPausedAnimationBoundary();
  button.textContent = boundaryPaused ? "Next" : state.playing ? "Pause" : "Play";
  button.title = boundaryPaused ? "次の区切りまで再生" : state.playing ? "一時停止" : "操作を再生";
  button.classList.toggle("secondary", Boolean(state.playing) || boundaryPaused);
  button.disabled = false;
}

function setMovementProgress(progress) {
  const value = Math.max(0, Math.min(Number(progress) || 0, 1));
  movementProgressValue = value;
  const slider = document.getElementById("movement-progress");
  const output = document.getElementById("movement-progress-value");
  const previous = document.getElementById("previous-frame");
  const next = document.getElementById("next-frame");
  if (slider) slider.value = String(Math.round(value * 1000));
  if (output) output.textContent = `${Math.round(value * 100)}%`;
  if (previous) previous.disabled = value <= 0;
  if (next) next.disabled = value >= 1;
  syncPlayToggleButton();
}

function setMovementBreakpoints(values) {
  movementBreakpoints = [...new Set((values || [0, 1]).map(Number).filter(Number.isFinite))]
    .filter(value => value >= 0 && value <= 1)
    .sort((a, b) => a - b);
  const list = document.getElementById("movement-stops");
  if (!list) return;
  list.innerHTML = "";
  for (const value of movementBreakpoints) {
    const option = document.createElement("option");
    option.value = String(Math.round(value * 1000));
    list.appendChild(option);
  }
}

function dispatchMovementProgress(progress) {
  setMovementProgress(progress);
  window.dispatchEvent(new CustomEvent("symmetry-animation-progress", {detail: {progress}}));
}

function stepMovementProgress(direction) {
  const current = movementProgressValue;
  const delta = Math.sign(direction) * MOVEMENT_FRAME_STEP;
  const proposed = Math.max(0, Math.min(current + delta, 1));
  const crossedBreakpoints = movementBreakpoints.filter(value => (
    delta > 0
      ? value > current + 1e-9 && value < proposed - 1e-9
      : value < current - 1e-9 && value > proposed + 1e-9
  ));
  const progress = crossedBreakpoints.length
    ? (delta > 0 ? Math.min(...crossedBreakpoints) : Math.max(...crossedBreakpoints))
    : proposed;
  if (state.playing) postState({playing: false});
  dispatchMovementProgress(progress);
}

function renderStatus() {
  if (!structureLoadedForSelectedKind()) {
    const config = sourceKindConfig(selectedStructureKind);
    document.getElementById("status").textContent =
      `No ${selectedStructureKind} loaded. Open an example or ${config.inputLabel}.\\n` +
      `import: ${state.import_status || "-"}`;
    return;
  }
  const operation = operations.find(op => op.index === state.operation_index);
  const selected = state.selected_atoms && state.selected_atoms.length
    ? state.selected_atoms.join(", ")
    : "-";
  const scopeLabel = (state.scope || "representative") === "representative"
    ? "clear"
    : (state.scope || "representative");
  document.getElementById("status").textContent =
    `state: ${state.playing ? "playing" : "stopped"}\\n` +
    `mode: ${activeMode}\\n` +
    `operation: ${activeMode === "custom" ? (copMatrix ? "custom " + copMatrix.op_type : "custom unchecked") : (operation ? stripHtml(optionText(operation)) : state.operation_index)}\\n` +
    `speed: ${state.speed || 1.0}x\\n` +
    `projection: ${state.projection_mode || "perspective"}\\n` +
    `cell: ${state.cell_setting_mode || "native"}\\n` +
    `display: ${state.display_mode || "source"}\\n` +
    `scope: ${scopeLabel}\\n` +
    `selected atoms: ${selected}\\n` +
    `source: ${state.json_path || "-"}\\n` +
    `import: ${state.import_status || "-"}\\n` +
    `status: ${state.status_message || "-"}`;
}

function validateIndexedView(prefix, buttonId, errorId) {
  const inputs = ["h", "k", "l"].map(axis => document.getElementById(`${prefix}-${axis}`));
  const values = inputs.map(input => Number(input.value));
  const numeric = inputs.every((input, i) => input.value.trim() && Number.isFinite(values[i]));
  const message = !numeric ? "数値を入力" : values.every(value => value === 0) ? "すべて0にはできません" : "";
  const error = document.getElementById(errorId);
  error.textContent = message;
  error.hidden = !message;
  document.getElementById(buttonId).disabled = Boolean(message);
  for (const input of inputs) {
    if (message) {
      input.setAttribute("aria-invalid", "true");
      input.setAttribute("aria-errormessage", errorId);
    } else {
      input.removeAttribute("aria-invalid");
      input.removeAttribute("aria-errormessage");
    }
  }
  return message ? null : values;
}

function syncIndexedViewInputs() {
  validateIndexedView("view-dir", "view-direction-index", "view-direction-error");
  validateIndexedView("view-plane", "view-plane-index", "view-plane-error");
}

function applyViewDirectionIndex() {
  const values = validateIndexedView("view-dir", "view-direction-index", "view-direction-error");
  if (!values) return;
  postState({
    view_direction_request_id: Date.now(),
    view_direction_frac: values,
    playing: false,
  }).catch(error => showLoadError("視点を変更できませんでした", error));
}

function applyViewPlaneIndex() {
  const values = validateIndexedView("view-plane", "view-plane-index", "view-plane-error");
  if (!values) return;
  postState({
    view_plane_request_id: Date.now(),
    view_plane_hkl: values,
    playing: false,
  }).catch(error => showLoadError("視点を変更できませんでした", error));
}

function syncSourceKindControls() {
  sourceKind = state.source_kind || "crystal";
  syncStructureKindButtons();
  const loadedForSelected = structureLoadedForSelectedKind();
  document.querySelector(".viewer-workspace").hidden = !loadedForSelected;
  document.getElementById("workspace").hidden = !loadedForSelected;
  document.getElementById("utility-panel").hidden = !loadedForSelected || sourceKind !== "crystal";
  document.getElementById("start-panel").hidden = loadedForSelected;
  document.getElementById("import-cif").hidden = selectedStructureKind !== "crystal";
  document.getElementById("import-molecule").hidden = selectedStructureKind !== "molecule";
  renderExampleOptions();
  document.getElementById("display-block").hidden = !loadedForSelected || sourceKind !== "crystal";
  document.getElementById("include-boundary-images").hidden = !loadedForSelected || sourceKind !== "crystal";
  document.getElementById("view-direction-index-block").hidden = !loadedForSelected || sourceKind !== "crystal";
  document.getElementById("view-plane-index-block").hidden = !loadedForSelected || sourceKind !== "crystal";
  const config = sourceKindConfig(sourceKind);
  document.getElementById("operations-title").textContent = "Operations";
  if ((!loadedForSelected || !supportsCustomModel()) && activeMode === "custom") {
    activeMode = "standard";
    invalidateCustomSequenceWork();
    syncActiveModeControls();
  }
  scheduleWorkspaceScrolling();
}

async function postState(update) {
  return analysisWaiting.run(() => postStateReady(update));
}

async function postStateReady(update) {
  if ((Object.prototype.hasOwnProperty.call(update, "operation_index")
       && !Object.prototype.hasOwnProperty.call(update, "operation_repetitions"))
      || update.active_mode === "custom") update.operation_repetitions = 1;
  if (loopRestartTimer !== null && update.reset && !loopRestartInProgress) cancelLoopRestart();
  try {
    state = await api("/api/state", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(update),
    });
  } catch (error) {
    if (modelViewEnabled && (error.obsolete || /^stale_/.test(error.message))) return;
    throw error;
  }
  window.dispatchEvent(new CustomEvent("symmetry-state-update", {
    detail: {state: {...state}, update: {...update}},
  }));
  await refreshAtomMotion();
  syncSpeedButtons();
  syncDisplayButtons();
  syncCellPlacementControls();
  syncCellSettingButtons();
  syncProjectionButtons();
  syncBackgroundButtons();
  syncLegendButtons();
  syncImproperModeControl();
  syncPlayToggleButton();
  renderDirectionFilter();
  renderOperations();
  renderSelectedAtomSummary();
  renderStructureInfo();
  renderStatus();
  renderOperationDetails();
}

window.symmetryPostState = postState;

async function applyCellSetting(mode) {
  if (cellBasisSwitchIsUnnecessary()) {
    return;
  }
  setCellSettingBusy(true, mode);
  try {
    const result = await api("/api/cell_setting", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({cell_setting_mode: mode}),
    });
    resetInputControls(document.getElementById("cell-placement-coordinates"));
    await applyRebuiltStructure(result);
  } finally {
    setCellSettingBusy(false);
  }
}

async function applyRebuiltStructure(result) {
  hideLoadError();
  document.getElementById("operation-info-panel").open = false;
  resetCustomControls();
  resetInputControls(document.getElementById("camera-settings"));
  operations = result.operations || [];
  atoms = result.atoms || [];
  state = result.state || {};
  directionFilterValue = "";
  summariesReady = Boolean(state.summaries_ready);
  customUnmappedAtoms = new Set();
  customOperationSequence = [];
  copMatrix = null;
  activeMode = "standard";
  document.getElementById("cop-result").hidden = true;
  invalidateCustomSequenceWork();
  syncActiveModeControls();
  syncSourceKindControls();
  renderDirectionFilter();
  syncOperationSelection();
  syncSpeedButtons();
  syncDisplayButtons();
  syncCellPlacementControls();
  syncCellSettingButtons();
  syncProjectionButtons();
  syncBackgroundButtons();
  syncLegendButtons();
  syncImproperModeControl();
  syncPlayToggleButton();
  renderOperations();
  await refreshAtomMotion();
  renderSelectedAtomSummary();
  renderStructureInfo();
  renderStatus();
  renderOperationDetails();
  if (window.symmetryThreeView) {
    if (modelViewEnabled) {
      // The model-exchange event already queued this snapshot's rebuild.
      // Keep controls busy until it finishes without rebuilding a second time.
      await window.symmetryThreeView.syncQueue;
    } else {
      await window.symmetryThreeView.syncState(state, {structure_reload: true, reset: true});
    }
  }
}

async function refreshAtomMotion() {
  if (!structureLoadedForSelectedKind() || activeMode !== "standard") {
    atomMotionBySource = new Map();
    lastAtomMotionRequestKey = "";
    pendingAtomMotionRequestKey = "";
    atomMotionRequestGeneration += 1;
    return;
  }
  const requestKey = JSON.stringify([
    state.json_path,
    state.reload_request_id,
    state.cell_setting_mode,
    state.operation_index,
    state.operation_repetitions,
    state.improper_mode,
    state.display_mode,
    state.cell_origin_mode,
  ]);
  if (requestKey === lastAtomMotionRequestKey || requestKey === pendingAtomMotionRequestKey) return;
  pendingAtomMotionRequestKey = requestKey;
  const generation = ++atomMotionRequestGeneration;
  try {
    const result = await api("/api/atom_motion");
    if (generation !== atomMotionRequestGeneration) return;
    atomMotionBySource = new Map(
      (result.entries || [])
        .filter(entry => entry.source_atom !== null && entry.source_atom !== undefined)
        .map(entry => [entry.source_atom, entry])
    );
    lastAtomMotionRequestKey = requestKey;
  } catch (error) {
    if (generation !== atomMotionRequestGeneration) return;
    atomMotionBySource = new Map();
    lastAtomMotionRequestKey = "";
    console.warn("Atom motion refresh failed", error);
  } finally {
    if (generation === atomMotionRequestGeneration) pendingAtomMotionRequestKey = "";
  }
}

async function importCifFile() {
  if (importInProgress) {
    document.getElementById("status").textContent = "Loading in progress. Wait for it to finish.";
    return;
  }
  const input = document.getElementById("cif-file");
  const file = input.files && input.files[0];
  if (!file) {
    document.getElementById("status").textContent = "Choose a CIF file first.";
    return;
  }
  const requestId = beginImport(`Loading ${file.name}...`, "import-cif");
  try {
    const content = await file.text();
    const result = await api("/api/import_cif", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({filename: file.name, content, request_id: requestId}),
    });
    if (!isCurrentImport(requestId)) return;
    await applyLoadedStructureSafely(result, "CIF import failed", "CIF display failed", "", {name: file.name, kind: "CIF"});
  } finally {
    finishImport(requestId);
  }
}

async function importMoleculeFile() {
  if (importInProgress) {
    document.getElementById("status").textContent = "Loading in progress. Wait for it to finish.";
    return;
  }
  const input = document.getElementById("molecule-file");
  const file = input.files && input.files[0];
  if (!file) {
    document.getElementById("status").textContent = "Choose an XYZ file first.";
    return;
  }
  const requestId = beginImport(`Loading ${file.name}...`, "import-molecule");
  try {
    const content = await file.text();
    const result = await api("/api/import_molecule", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({filename: file.name, content, request_id: requestId}),
    });
    if (!isCurrentImport(requestId)) return;
    await applyLoadedStructureSafely(result, "Molecule import failed", "Molecule display failed", "", {name: file.name, kind: "XYZ"});
  } finally {
    finishImport(requestId);
  }
}

async function openSelectedExample() {
  if (importInProgress) {
    document.getElementById("status").textContent = "Loading in progress. Wait for it to finish.";
    return;
  }
  const select = document.getElementById("example-select");
  const path = select.value;
  if (!path) {
    document.getElementById("status").textContent = "Choose an example first.";
    return;
  }
  const requestId = beginImport(`Loading ${path}...`);
  try {
    const result = await api("/api/open_example", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({kind: selectedStructureKind, path, request_id: requestId}),
    });
    if (!isCurrentImport(requestId)) return;
    await applyLoadedStructureSafely(result, "Example load failed", "Example display failed", path, {name: path, kind: selectedStructureKind});
  } finally {
    finishImport(requestId);
  }
}

async function applyLoadedStructureSafely(result, fallbackError, displayError, examplePath = "", context = {}) {
  try {
    await applyLoadedStructure(result, fallbackError, examplePath, context);
  } catch (error) {
    console.error(displayError, error);
    showLoadError(displayError, error, context);
  }
}

async function applyLoadedStructure(result, fallbackError, examplePath = "", context = {}) {
  if (result.stale) {
    state = result.state || state;
    renderStatus();
    // The server discarded this load because a newer one had already claimed
    // the slot. Say so: returning silently made a load that never arrived look
    // exactly like a button that did nothing.
    document.getElementById("status").textContent =
      "Load cancelled: a newer load replaced this one. Try opening the structure again.";
    return;
  }
  if (!result.ok) {
    state = result.state || state;
    renderStatus();
    showLoadError(fallbackError, result.error || fallbackError, context);
    return;
  }
  hideLoadError();
  resetCustomControls();
  resetInputControls(document.getElementById("camera-settings"));
  document.getElementById("camera-angle").value = "90";
  document.getElementById("display-range-axis").value = "all";
  document.getElementById("range-highlight").checked = false;
  window.symmetryThreeView?.setRangeHighlight(false);
  resetInputControls(document.getElementById("cell-placement-coordinates"));
  operationTypeFilterValue = "";
  document.getElementById("loop-animation").checked = false;
  clearTimeout(loopRestartTimer);
  loopRestartTimer = null;
  movementProgressValue = 0;

  document.getElementById("operation-info-panel").open = false;
  operations = result.operations || [];
  atoms = result.atoms || [];
  state = result.state || {};
  fullImproperMode = "default";
  if (state.source_kind === "crystal" || state.source_kind === "molecule") {
    selectedStructureKind = state.source_kind;
  }
  sourceKind = state.source_kind || "crystal";
  selectedExamplePath = examplePath || "";
  structureOpenedInPage = true;
  setDefaultOperationSortForSourceKind();
  directionFilterValue = "";
  summariesReady = Boolean(state.summaries_ready);
  customUnmappedAtoms = new Set();
  customOperationSequence = [];
  copMatrix = null;
  document.getElementById("cop-result").hidden = true;
  invalidateCustomSequenceWork();
  activeMode = "standard";
  syncActiveModeControls();
  syncSourceKindControls();
  renderDirectionFilter();
  syncOperationSelection();
  syncSpeedButtons();
  syncDisplayButtons();
  syncCellPlacementControls();
  syncCellSettingButtons();
  syncProjectionButtons();
  syncBackgroundButtons();
  syncLegendButtons();
  syncImproperModeControl();
  syncPlayToggleButton();
  renderOperations();
  await refreshAtomMotion();
  renderSelectedAtomSummary();
  renderStructureInfo();
  renderStatus();
  renderOperationDetails();
}

function supportsCustomModel() {
  return sourceKind === "crystal" || Boolean(state.model_id && state.model_id === quizCustomModelId);
}

function syncActiveModeControls() {
  const customAvailable = experienceMode === "advanced"
    && supportsCustomModel()
    && structureLoadedForSelectedKind();
  if (!customAvailable && activeMode === "custom") {
    activeMode = "standard";
    invalidateCustomSequenceWork();
  }
  const standard = activeMode !== "custom";
  document.getElementById("operation-sort-control").hidden = !standard;
  if (standard || !customAvailable) closeCustomOperationMenu();
  improperModeControl.hidden = !standard;
  document.getElementById("standard-panel").hidden = !standard;
  const customPanel = document.getElementById("custom-panel");
  customPanel.hidden = standard || !customAvailable;
  const modeControls = document.getElementById("mode-controls");
  modeControls.hidden = !customAvailable;
  for (const button of modeControls.querySelectorAll(".mode-button")) {
    const selected = button.dataset.mode === activeMode;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-selected", String(selected));
  }
  syncOperationInformation();
}

function syncExperienceModeControls() {
  const beginner = experienceMode === "beginner";
  document.body.classList.toggle("beginner-mode", beginner);
  document.body.classList.toggle("advanced-mode", !beginner);
  const pathContainer = document.getElementById(beginner ? "animation-path-inline" : "animation-options");
  const pathOption = document.getElementById("animation-path-option");
  if (pathOption.parentElement !== pathContainer) pathContainer.append(pathOption);
  const modeButton = document.getElementById("experience-toggle");
  const currentMode = beginner ? "Simple" : "Advanced";
  const nextMode = beginner ? "Advanced" : "Simple";
  modeButton.textContent = currentMode;
  modeButton.dataset.experience = beginner ? "advanced" : "beginner";
  modeButton.title = `${nextMode}に切り替える`;
  modeButton.setAttribute("aria-label", modeButton.title);
  if (beginner) {
    document.getElementById("operation-info-panel").open = false;
    cancelLoopRestart();
    setLoopAnimationEnabled(false);
  }
  document.getElementById("main-title").textContent = "Symmetry Viewer";
  document.getElementById("operations-title").textContent = "Operations";
  document.getElementById("operations-label").textContent = "Operations";
  document.getElementById("animation-title").textContent = "Animation";
  document.getElementById("view-title").textContent = "Camera";
  document.getElementById("cell-title").textContent = "Cell settings";
  document.getElementById("range-label").textContent = "Range";
  syncDisplayButtons();
  syncPlayToggleButton();
  scheduleWorkspaceScrolling();
}

async function setExperienceMode(mode) {
  const previousMode = experienceMode;
  if (previousMode === "advanced") fullImproperMode = resolvedImproperMode();
  closeAnimationOptions();
  experienceMode = mode === "advanced" ? "advanced" : "beginner";
  const update = {improper_mode: experienceMode === "beginner" ? "default" : fullImproperMode, playing: false, reset: true};
  state.improper_mode = update.improper_mode;
  if (experienceMode === "beginner") {
    directionFilterValue = "";
    if (Number(state.operation_repetitions || 1) > 1) {
      Object.assign(update, {operation_repetitions: 1, playing: false, reset: true});
    }
    if (activeMode !== "standard") {
      activeMode = "standard";
      invalidateCustomSequenceWork();
      Object.assign(update, {active_mode: "standard", playing: false, reset: true, clear_custom_check: true});
    }
    if (state.pause_at_breakpoints) {
      state.pause_at_breakpoints = false;
      update.pause_at_breakpoints = false;
    }
  }
  syncImproperModeControl();
  syncActiveModeControls();
  syncExperienceModeControls();
  renderDirectionFilter();
  renderOperations();
  renderStructureInfo();
  renderSelectedAtomSummary();
  renderOperationDetails();
  const toggle = document.getElementById("experience-toggle");
  toggle.disabled = true;
  try {
    await postState(update);
  } finally {
    toggle.disabled = false;
  }
}

async function setActiveMode(mode) {
  activeMode = mode === "custom" ? "custom" : "standard";
  syncActiveModeControls();
  if (activeMode === "standard") {
    customUnmappedAtoms = new Set();
    invalidateCustomSequenceWork();
    await postState({active_mode: "standard", playing: false, reset: true, clear_custom_check: true});
  } else {
    renderCustomSequenceControls();
    await postState({active_mode: "custom", playing: false, reset: true});
    if (activeMode === "custom") customSequenceChanged();
  }
  renderStatus();
  renderOperationDetails();
}

for (const button of document.querySelectorAll(".mode-button")) {
  button.addEventListener("click", () => setActiveMode(button.dataset.mode));
}

async function refreshState() {
  if (refreshInProgress || cellPlacementBusy || cellSettingBusy || cellSettingsResetBusy) return;
  // Nothing of the analysis panel is on screen during a quiz, so the 1 s poll
  // would fetch and re-sync a dozen controls nobody can see. Re-entering
  // analysis calls refreshAnalysisFromServer(), so no state is lost by
  // skipping. The 3D view's own loop already bails on the same class.
  if (document.body.classList.contains("in-puzzle")) return;
  refreshInProgress = true;
  try {
    state = await api("/api/state");
    syncOperationSelection();
    syncSpeedButtons();
    syncDisplayButtons();
    syncCellPlacementControls();
    syncCellSettingButtons();
    syncProjectionButtons();
    syncBackgroundButtons();
    syncLegendButtons();
    syncImproperModeControl();
    syncPlayToggleButton();
    renderSelectedAtomSummary();
    renderStructureInfo();
    renderStatus();
    renderOperationDetails();
    if (!summariesReady && state.summaries_ready) {
      summariesReady = true;
      const info = await api("/api/operations");
      operations = info.operations;
      renderDirectionFilter();
      renderOperations();
      renderOperationDetails();
    }
  } finally {
    refreshInProgress = false;
  }
}

document.getElementById("operation-sort").addEventListener("change", () => {
  directionFilterValue = "";
  renderDirectionFilter();
  renderOperations();
});
for (const button of document.querySelectorAll(".structure-kind-button")) {
  button.addEventListener("click", () => setStructureKind(button.dataset.kind));
}
document.getElementById("import-cif").addEventListener("click", () => {
  const input = document.getElementById("cif-file");
  input.value = "";
  input.click();
});
document.getElementById("cif-file").addEventListener("change", () => {
  importCifFile().catch(error => {
    const file = document.getElementById("cif-file").files && document.getElementById("cif-file").files[0];
    showLoadError("CIF import failed", error, {name: file && file.name, kind: "CIF"});
  });
});
document.getElementById("import-molecule").addEventListener("click", () => {
  const input = document.getElementById("molecule-file");
  input.value = "";
  input.click();
});
document.getElementById("molecule-file").addEventListener("change", () => {
  importMoleculeFile().catch(error => {
    const file = document.getElementById("molecule-file").files && document.getElementById("molecule-file").files[0];
    showLoadError("Molecule import failed", error, {name: file && file.name, kind: "XYZ"});
  });
});
document.getElementById("example-select").addEventListener("change", () => {
  if (importInProgress) return;
  const select = document.getElementById("example-select");
  if (!select.value) return;
  selectedExamplePath = select.value;
  syncExamplePicker();
  setRichSelectOpen("example-picker", false);
  openSelectedExample().catch(error => {
    showLoadError("Example load failed", error, {name: select && select.value, kind: selectedStructureKind});
  });
});
for (const button of document.querySelectorAll(".experience-button")) {
  button.addEventListener("click", () => setExperienceMode(button.dataset.experience));
}
function startAnimation() {
  if (activeMode === "custom") {
    return sendCurrentCustomAnimation(true);
  }
  return postState({playing: true});
}

function loopPlaybackEnabled() {
  return experienceMode === "advanced" && document.getElementById("loop-animation").checked;
}

function cancelLoopRestart() {
  if (loopRestartTimer !== null) window.clearTimeout(loopRestartTimer);
  loopRestartTimer = null;
}

function setLoopAnimationEnabled(enabled) {
  document.getElementById("loop-animation").checked = enabled;
  if (!enabled) cancelLoopRestart();
}

function scheduleLoopRestart() {
  if (!loopPlaybackEnabled()) return;
  cancelLoopRestart();
  loopRestartTimer = window.setTimeout(async () => {
    loopRestartTimer = null;
    if (!loopPlaybackEnabled() || state.playing) return;
    loopRestartInProgress = true;
    try {
      if (activeMode === "custom") startAnimation();
      else await postState({playing: true, reset: true});
    } finally {
      loopRestartInProgress = false;
    }
  }, LOOP_RESTART_DELAY_MS);
}

window.addEventListener("symmetry-animation-complete", scheduleLoopRestart);

let pausePreferenceUpdate = Promise.resolve();
async function toggleAnimationPlayback() {
  await pausePreferenceUpdate;
  cancelLoopRestart();
  // An edited Custom sequence must finish preparation before either starting
  // playback or resuming at an old stepwise boundary.
  if (activeMode === "custom" && !copMatrix) {
    await startAnimation();
    return;
  }
  if (atPausedAnimationBoundary()) {
    await postState({playing: true});
    return;
  }
  if (state.playing) {
    await postState({playing: false});
  } else {
    await startAnimation();
  }
}

function resetAnimationPlayback() {
  customPlaybackIntent += 1;
  cancelLoopRestart();
  return postState({playing: false, reset: true});
}

document.getElementById("play-toggle").addEventListener("click", toggleAnimationPlayback);
document.getElementById("reset").addEventListener("click", resetAnimationPlayback);
document.getElementById("loop-animation").addEventListener("change", event => {
  setLoopAnimationEnabled(event.currentTarget.checked);
});
document.getElementById("previous-frame").addEventListener("click", () => stepMovementProgress(-1));
function atPausedAnimationBoundary() {
  if (!state.pause_at_breakpoints || state.playing || movementProgressValue >= 1 - 1e-9) return false;
  return movementBreakpoints.some(value => (
    value > 1e-9 && value < 1 - 1e-9 && Math.abs(value - movementProgressValue) <= 0.0015
  ));
}

document.getElementById("next-frame").addEventListener("click", () => stepMovementProgress(1));
document.addEventListener("keydown", event => {
  if (document.body.classList.contains("in-puzzle")) return;
  if (document.getElementById("structure-details-dialog").open) return;
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  const target = event.target;
  const editingControl = target instanceof HTMLElement && (
    target.isContentEditable
    || target.matches('input:not([type="range"]), select, textarea')
  );
  if (editingControl) return;
  event.preventDefault();
  stepMovementProgress(event.key === "ArrowLeft" ? -1 : 1);
});
const movementProgress = document.getElementById("movement-progress");

function stopAnimationForScrubbing() {
  if (state.playing) postState({playing: false});
}

function updateMovementProgressFromInput(input) {
  const progress = Number(input.value) / 1000;
  dispatchMovementProgress(progress);
}

function snapMovementProgressFromInput(input) {
  const progress = Number(input.value) / 1000;
  const nearest = movementBreakpoints.reduce(
    (best, value) => Math.abs(value - progress) < Math.abs(best - progress) ? value : best,
    movementBreakpoints[0] ?? progress,
  );
  if (Math.abs(nearest - progress) <= 0.04) dispatchMovementProgress(nearest);
}

for (const slider of [movementProgress]) {
  slider.addEventListener("pointerdown", stopAnimationForScrubbing);
  slider.addEventListener("input", () => updateMovementProgressFromInput(slider));
  slider.addEventListener("change", () => snapMovementProgressFromInput(slider));
}
window.addEventListener("symmetry-animation-progress-update", event => {
  if (event.detail?.viewId && event.detail.viewId !== "three-view") return;
  setMovementProgress(event.detail?.progress || 0);
});
window.addEventListener("symmetry-animation-breakpoints", event => {
  if (event.detail?.viewId && event.detail.viewId !== "three-view") return;
  setMovementBreakpoints(event.detail?.breakpoints);
});
window.addEventListener("symmetry-animation-breakpoint-pause", event => {
  if (event.detail?.viewId && event.detail.viewId !== "three-view") return;
  setMovementProgress(event.detail?.progress || 0);
  postState({playing: false});
});
async function stepAnimationSpeed(direction) {
  if (speedUpdatePending) return;
  const current = Number(state.speed || 1);
  const candidates = direction > 0 ? ANIMATION_SPEED_STEPS : [...ANIMATION_SPEED_STEPS].reverse();
  const speed = candidates.find(value => direction > 0 ? value > current : value < current);
  if (speed === undefined) return;
  speedUpdatePending = true;
  syncSpeedButtons();
  try {
    await postState({speed});
  } catch (error) {
    showLoadError("速度を変更できませんでした", error);
  } finally {
    speedUpdatePending = false;
    syncSpeedButtons();
  }
}
document.getElementById("animation-speed-previous").addEventListener("click", () => stepAnimationSpeed(-1));
document.getElementById("animation-speed-next").addEventListener("click", () => stepAnimationSpeed(1));
document.getElementById("pause-at-breakpoints").addEventListener("change", event => {
  const enabled = event.target.checked;
  state.pause_at_breakpoints = enabled;
  syncPlayToggleButton();
  pausePreferenceUpdate = postState({pause_at_breakpoints: enabled}).catch(error => {
    state.pause_at_breakpoints = !enabled;
    syncSpeedButtons();
    showLoadError("一時停止の設定を変更できませんでした", error);
  });
});
document.getElementById("show-trajectories").addEventListener("change", event => {
  postState({show_trajectories: event.target.checked});
});
document.getElementById("fullscreen-operation-select").addEventListener("change", event => {
  const operationIndex = Number(event.currentTarget.value);
  if (!Number.isInteger(operationIndex)) return;
  activeMode = "standard";
  customUnmappedAtoms = new Set();
  invalidateCustomSequenceWork();
  syncActiveModeControls();
  postState({
    active_mode: "standard",
    operation_index: operationIndex,
    playing: false,
    reset: true,
    clear_custom_check: true,
  });
});
document.getElementById("display-range-axis").addEventListener("change", syncDisplayButtons);
document.getElementById("range-highlight").addEventListener("change", async event => {
  const checkbox = event.currentTarget;
  const enabled = checkbox.checked;
  const structureKey = `${state.json_path}|${state.reload_request_id}`;
  checkbox.disabled = true;
  syncCellSettingButtons();
  try {
    await postState({playing: false, reset: true, range_highlight: enabled});
    const view = window.symmetryThreeView;
    if (view) {
      await view.syncQueue;
      if (structureKey !== `${state.json_path}|${state.reload_request_id}`) return;
      view.setRangeHighlight(enabled);
    }
  } catch (error) {
    checkbox.checked = !enabled;
    showLoadError("強調表示を変更できませんでした", error);
  } finally {
    checkbox.disabled = false;
    syncCellSettingButtons();
  }
});
document.getElementById("reset-cell-settings").addEventListener("click", () => {
  resetCellSettings().catch(error => showLoadError("セル設定を初期状態に戻せませんでした", error));
});
document.getElementById("display-range-decrease").addEventListener("click", () => {
  changeDisplayRange(-1).catch(error => showLoadError("表示範囲を変更できませんでした", error));
});
document.getElementById("display-range-increase").addEventListener("click", () => {
  changeDisplayRange(1).catch(error => showLoadError("表示範囲を変更できませんでした", error));
});
document.getElementById("include-boundary-images").addEventListener("click", () => postState({
  include_boundary_images: !state.include_boundary_images,
  playing: false,
  reset: true,
}));
document.getElementById("cell-placement-atom").addEventListener("change", event => {
  const value = event.target.value;
  if (value === "") {
    postState({selected_atoms: [], scope: "displayed", playing: false, reset: true});
    return;
  }
  if (!atoms.some(atom => Number(atom.index) === Number(value))) return;
  postState({selected_atoms: [Number(value)], scope: "selected_displayed", playing: false, reset: true});
});
document.getElementById("cell-placement-previous").addEventListener("click", () => {
  changeCellPlacement(-1).catch(error => showLoadError("配置を変更できませんでした", error));
});
document.getElementById("cell-placement-next").addEventListener("click", () => {
  changeCellPlacement(1).catch(error => showLoadError("配置を変更できませんでした", error));
});
document.getElementById("cell-placement-apply").addEventListener("click", () => {
  applyCellPlacement("custom").catch(error => showLoadError("配置を変更できませんでした", error));
});
document.getElementById("cell-placement-coordinates").addEventListener("input", () => {
  if (!document.getElementById("cell-placement-error").hidden) cellPlacementTarget();
});
document.getElementById("cell-placement-coordinates").addEventListener("keydown", event => {
  if (event.key !== "Enter" || event.isComposing || !(event.target instanceof HTMLInputElement)) return;
  event.preventDefault();
  if (!document.getElementById("cell-placement-apply").disabled) {
    applyCellPlacement("custom").catch(error => showLoadError("配置を変更できませんでした", error));
  }
});
for (const button of document.querySelectorAll(".cell-setting-button")) {
  button.addEventListener("click", () => {
    const mode = button.dataset.cellSettingMode;
    if (mode === (state.cell_setting_mode || "native")) return;
    applyCellSetting(mode).catch(error => {
      showLoadError("セル基底を変更できませんでした", error && error.message ? error.message : error, {kind: "crystal"});
    });
  });
}
for (const button of document.querySelectorAll(".projection-button")) {
  button.addEventListener("click", () => postState({
    projection_mode: button.dataset.projectionMode,
    playing: false,
  }));
}
for (const button of document.querySelectorAll(".background-button")) {
  button.addEventListener("click", () => postState({
    background_mode: button.dataset.backgroundMode,
    playing: false,
  }));
}
document.getElementById("legend-toggle").addEventListener("click", () => postState({
  legend_visible: !state.legend_visible,
  playing: false,
}));
improperModeControl.addEventListener("change", async () => {
  const members = directionFilterValue && operationFilterType() === "symbol"
    ? operations.filter(operation => operationFilterKey(operation) === directionFilterValue).map(operation => operation.index) : null;
  const chosen = improperModeControl.value;
  fullImproperMode = chosen;
  improperModeControl.disabled = true;
  try {
    // Remap a Symbol selection only when it still denotes the same operations.
    state.improper_mode = chosen;
    if (members) {
      // Pass only the operation: map() would hand its index in as the filter type.
      const keys = [...new Set(operations.filter(operation => members.includes(operation.index)).map(operation => operationFilterKey(operation)))];
      const nextMembers = keys.length === 1 ? operations.filter(operation => operationFilterKey(operation) === keys[0]).map(operation => operation.index) : [];
      directionFilterValue = nextMembers.length === members.length && nextMembers.every(index => members.includes(index)) ? keys[0] : "";
    }
    await postState({improper_mode: chosen, playing: false, reset: true});
  } finally {
    improperModeControl.disabled = false;
  }
});

document.getElementById("view-direction").addEventListener("click", () => {
  postState({view_request_id: Date.now()});
});
for (const button of document.querySelectorAll(".reset-view-button")) {
  button.addEventListener("click", () => {
    postState({reset_view_request_id: Date.now()});
  });
}
document.getElementById("view-direction-index").addEventListener("click", applyViewDirectionIndex);
document.getElementById("view-plane-index").addEventListener("click", applyViewPlaneIndex);
document.getElementById("camera-settings").addEventListener("input", syncIndexedViewInputs);
syncIndexedViewInputs();
for (const [id, apply] of [["view-direction-index-block", applyViewDirectionIndex], ["view-plane-index-block", applyViewPlaneIndex]]) {
  document.getElementById(id).addEventListener("keydown", event => {
    if (event.key !== "Enter" || event.isComposing || !(event.target instanceof HTMLInputElement)) return;
    event.preventDefault();
    if (!event.currentTarget.querySelector("button").disabled) apply();
  });
}
function closeAnimationOptions(restoreFocus = false) {
  document.getElementById("animation-options").hidden = true;
  document.getElementById("animation-options-help").hidden = true;
  const button = document.getElementById("animation-options-toggle");
  button.setAttribute("aria-expanded", "false");
  if (restoreFocus) button.focus();
}
const animationOptionsControl = document.getElementById("animation-options-control");
const animationOptionsHelp = document.getElementById("animation-options-help");
const animationOptionsToggle = document.getElementById("animation-options-toggle");
animationOptionsToggle.addEventListener("click", () => {
  const options = document.getElementById("animation-options");
  const open = options.hidden;
  closeCameraSaveOptions();
  options.hidden = !open;
  animationOptionsToggle.setAttribute("aria-expanded", String(open));
  animationOptionsHelp.hidden = true;
  if (open) {
    options.classList.remove("open-above");
    const box = options.getBoundingClientRect();
    if (box.bottom > window.innerHeight - 8 && animationOptionsToggle.getBoundingClientRect().top > box.height + 8) {
      options.classList.add("open-above");
    }
    [...options.querySelectorAll("input")].find(input => input.getClientRects().length && !input.disabled)?.focus();
  }
});
for (const event of ["mouseenter", "focus"]) {
  animationOptionsToggle.addEventListener(event, () => {
    animationOptionsHelp.hidden = !document.getElementById("animation-options").hidden;
  });
}
for (const event of ["mouseleave", "blur"]) {
  animationOptionsToggle.addEventListener(event, () => { animationOptionsHelp.hidden = true; });
}
document.addEventListener("click", event => {
  if (!animationOptionsControl.contains(event.target)) closeAnimationOptions();
});
animationOptionsControl.addEventListener("keydown", event => {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeAnimationOptions(true);
    animationOptionsHelp.hidden = true;
  }
});
animationOptionsControl.addEventListener("focusout", event => {
  // Clicking a label's padding can briefly clear focus before the browser
  // activates its checkbox. Let that native label activation finish.
  if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) closeAnimationOptions();
});
function closeCameraSaveOptions(restoreFocus = false) {
  const button = document.getElementById("camera-save-toggle");
  document.getElementById("camera-save-options").hidden = true;
  button.setAttribute("aria-expanded", "false");
  if (restoreFocus) button.focus();
}
document.getElementById("camera-save-toggle").addEventListener("click", () => {
  const options = document.getElementById("camera-save-options");
  const open = options.hidden;
  options.hidden = !open;
  document.getElementById("camera-save-toggle").setAttribute("aria-expanded", String(open));
  if (open) document.getElementById("save-png").focus();
});
document.addEventListener("click", event => {
  if (!document.getElementById("camera-save-control").contains(event.target)) closeCameraSaveOptions();
});
document.getElementById("camera-save-control").addEventListener("keydown", event => {
  if (event.key === "Escape" && !document.getElementById("camera-save-options").hidden) {
    event.preventDefault();
    event.stopPropagation();
    closeCameraSaveOptions(true);
  }
});
document.getElementById("camera-save-control").addEventListener("focusout", event => {
  if (!event.currentTarget.contains(event.relatedTarget)) closeCameraSaveOptions();
});
function syncGifSaveControls() {
  const busy = gifPreparationBusy || gifExportBusy;
  const button = document.getElementById("camera-save-toggle");
  button.classList.toggle("is-busy", busy);
  button.setAttribute("aria-busy", String(busy));
  document.getElementById("save-gif").disabled = busy;
}
window.addEventListener("symmetry-gif-export-busy", event => {
  gifExportBusy = Boolean(event.detail?.busy);
  syncGifSaveControls();
});
document.getElementById("save-gif").addEventListener("click", async () => {
  if (gifPreparationBusy || gifExportBusy) return;
  closeCameraSaveOptions(true);
  gifPreparationBusy = true;
  syncGifSaveControls();
  try {
    if (activeMode === "custom") {
      if (!await sendCurrentCustomAnimation(false)) return;
    } else {
      await postState({playing: false});
    }
    window.dispatchEvent(new CustomEvent("symmetry-save-gif"));
  } catch (error) {
    showLoadError("GIFを保存できませんでした", error);
  } finally {
    gifPreparationBusy = false;
    syncGifSaveControls();
  }
});
document.getElementById("save-png").addEventListener("click", () => {
  closeCameraSaveOptions(true);
  window.dispatchEvent(new CustomEvent("symmetry-save-png"));
});
function cameraAngle() {
  const input = document.getElementById("camera-angle");
  const value = Number(input.value);
  const invalid = !input.value.trim() || !Number.isFinite(value) || value < 0 || value > 360;
  const error = document.getElementById("camera-angle-error");
  error.textContent = invalid ? "0〜360で入力" : "";
  error.hidden = !invalid;
  for (const button of document.querySelectorAll("#view-panel .camera-grid button")) button.disabled = invalid;
  if (invalid) {
    input.setAttribute("aria-invalid", "true");
    input.setAttribute("aria-errormessage", "camera-angle-error");
  } else {
    input.removeAttribute("aria-invalid");
    input.removeAttribute("aria-errormessage");
  }
  return invalid ? null : value;
}
document.getElementById("camera-angle").addEventListener("input", cameraAngle);
function rotateCamera(direction) {
  const angle = cameraAngle();
  if (angle === null) return;
  postState({
    camera_request_id: Date.now(),
    camera_direction: direction,
    camera_angle: angle,
  });
}
document.getElementById("camera-left").addEventListener("click", () => rotateCamera("left"));
document.getElementById("camera-right").addEventListener("click", () => rotateCamera("right"));
document.getElementById("camera-up").addEventListener("click", () => rotateCamera("up"));
document.getElementById("camera-down").addEventListener("click", () => rotateCamera("down"));
document.getElementById("camera-roll-left").addEventListener("click", () => rotateCamera("roll-left"));
document.getElementById("camera-roll-right").addEventListener("click", () => rotateCamera("roll-right"));
document.getElementById("structure-reset-appearance").addEventListener("click", resetAtomAppearance);
document.getElementById("structure-batch-toggle").addEventListener("click", () => {
  const panel = document.getElementById("structure-batch-panel");
  setStructureBatchOpen(panel.hidden);
});
document.getElementById("close-structure-details").addEventListener("click", () => {
  document.getElementById("structure-details-dialog").close();
});
{
  const dialog = document.getElementById("structure-details-dialog");
  dialog.addEventListener("close", () => setStructureBatchOpen(false));
  dialog.addEventListener("cancel", event => {
    if (!document.getElementById("structure-batch-panel").hidden) {
      event.preventDefault();
      setStructureBatchOpen(false);
      document.getElementById("structure-batch-toggle").focus();
    }
  });
  dialog.addEventListener("pointerdown", event => {
    if (!event.target.closest("#structure-batch-panel, #structure-batch-toggle")) setStructureBatchOpen(false);
  });
  const outside = event => {
    const box = dialog.getBoundingClientRect();
    return event.target === dialog && (event.clientX < box.left || event.clientX > box.right
      || event.clientY < box.top || event.clientY > box.bottom);
  };
  let pressedOutside = false;
  dialog.addEventListener("pointerdown", event => { pressedOutside = outside(event); });
  dialog.addEventListener("click", event => {
    if (pressedOutside && outside(event)) dialog.close();
    pressedOutside = false;
  });
}

// --- Custom Operation Check ---

document.getElementById("cop-type").addEventListener("change", syncCustomInputType);

function customOperationErrorMessage(error, type = document.getElementById("cop-type").value) {
  const message = String(error?.message || error || "").replace(/^(?:Error:\s*)+/, "");
  if (message === "finite nonzero direction required") {
    return type === "mirror" ? "Planeを (0, 0, 0) 以外で指定" : "回転軸を (0, 0, 0) 以外で指定";
  }
  if (message === "finite angle required") return "Angleに数値を入力";
  return /[ぁ-んァ-ヶ一-龯]/.test(message) ? message : "操作を確認できませんでした";
}

function copNum(id) {
  const input = document.getElementById(id);
  const raw = input.value.trim();
  const value = Number(raw);
  if (!raw || !Number.isFinite(value) || !input.validity.valid) {
    const group = input.closest(".vec3-row, .mat3-grid") || input;
    const label = group.previousElementSibling;
    const field = label?.tagName === "LABEL"
      ? label.textContent.trim().replace(/\s*(?:\[.*\]|\(.*\))$/, "") : "値";
    const matrixIndex = id.match(/w([0-2])([0-2])$/);
    const component = input.placeholder || (matrixIndex ? `${Number(matrixIndex[1])+1}行${Number(matrixIndex[2])+1}列` : "");
    throw new Error(`${field}${component ? "の" + component : ""}に数値を入力`);
  }
  return value;
}

function buildCopPayload() {
  const type = document.getElementById("cop-type").value;
  let params = {};
  if (type === "rotation") {
    params = {
      axis: [copNum("cop-rot-u"), copNum("cop-rot-v"), copNum("cop-rot-w", 1)],
      angle: copNum("cop-rot-angle", 90),
      point: [copNum("cop-rot-px"), copNum("cop-rot-py"), copNum("cop-rot-pz")],
    };
  } else if (type === "mirror") {
    params = {
      normal: [copNum("cop-mir-h"), copNum("cop-mir-k"), copNum("cop-mir-l", 1)],
      point: [copNum("cop-mir-px"), copNum("cop-mir-py"), copNum("cop-mir-pz")],
    };
  } else if (type === "inversion") {
    params = {
      center: [copNum("cop-inv-cx"), copNum("cop-inv-cy"), copNum("cop-inv-cz")],
    };
  } else if (type === "translation") {
    params = {
      vector: [copNum("cop-tra-x", 0.5), copNum("cop-tra-y", 0.5), copNum("cop-tra-z")],
    };
  } else if (type === "matrix") {
    params = {
      W: [
        copNum("cop-mat-w00",1), copNum("cop-mat-w01"), copNum("cop-mat-w02"),
        copNum("cop-mat-w10"), copNum("cop-mat-w11",1), copNum("cop-mat-w12"),
        copNum("cop-mat-w20"), copNum("cop-mat-w21"), copNum("cop-mat-w22",1),
      ],
      t: [copNum("cop-mat-tx"), copNum("cop-mat-ty"), copNum("cop-mat-tz")],
    };
  }
  return {type, params, request_id: Date.now()};
}

let copMatrix = null;        // {W_frac, t_frac, op_type, op_params}
let copSelectedAtoms = new Set();
let copAllUnmapped = [];

function displayCopResult(result, opType, opParams) {
  const div = document.getElementById("cop-result");
  copMatrix = null;
  copSelectedAtoms = new Set();
  copAllUnmapped = [];
  customUnmappedAtoms = new Set();
  if (!result) { div.hidden = true; return; }
  if (result.error) {
    div.className = "cop-result fail";
    div.textContent = customOperationErrorMessage(result.error, opType);
    div.hidden = false;
    document.getElementById("custom-panel").dataset.checkState = "error";
    return false;
  }
  if (result.W_frac && result.t_frac) {
    copMatrix = {W_frac: result.W_frac, t_frac: result.t_frac, op_type: opType || "matrix", op_params: opParams || {}, result};
  }
  copAllUnmapped = (result.unmapped || []).map(item => item.source);
  customUnmappedAtoms = new Set(copAllUnmapped);
  div.replaceChildren();
  div.hidden = true;
  showCustomVerdict(result);
  document.getElementById("custom-panel").dataset.checkState = "ready";
  renderOperationDetails();
  return Boolean(copMatrix);
}

function currentAnimationAtoms() {
  const all = atoms.map(atom => atom.index);
  if (state.scope === "representative") return all.slice(0, 1);
  if (state.scope === "unit_cell") return all;
  if (state.scope === "displayed") return all;
  if (String(state.scope).startsWith("selected")) return state.selected_atoms || [];
  return all;
}

function currentAnimationUnitCellOnly() {
  return state.scope === "unit_cell" || state.scope === "representative" || state.scope === "selected";
}

async function sendCurrentCustomAnimation(startPlaying = true) {
  const intent = ++customPlaybackIntent;
  const revision = customSequenceRevision;
  const structureKey = `${state.json_path || ""}|${state.reload_request_id || ""}`;
  const result = document.getElementById("cop-result");
  if (!customOperationSequence.length) {
    result.className = "cop-result fail";
    result.textContent = "操作を追加してください";
    result.hidden = false;
    return false;
  }
  if (!await prepareCustomSequence() || intent !== customPlaybackIntent
      || !customSequenceContextIsCurrent(revision, structureKey)) return false;
  const indices = currentAnimationAtoms();
  if (!indices.length) {
    result.className = "cop-result fail";
    result.textContent = "原子を選択してください";
    result.hidden = false;
    return false;
  }
  await sendCopAnimate(indices, currentAnimationUnitCellOnly(), startPlaying);
  return intent === customPlaybackIntent && customSequenceContextIsCurrent(revision, structureKey);
}

async function sendCopAnimate(atomIndices, unitCellOnly = false, startPlaying = true) {
  if (!copMatrix || atomIndices.length === 0) {
    return;
  }
  const body = {
    custom_sequence_token: customSequenceToken,
    custom_op_animate: {
      atom_indices: atomIndices,
      W_frac: copMatrix.W_frac,
      t_frac: copMatrix.t_frac,
      op_type: copMatrix.op_type,
      op_params: copMatrix.op_params,
      sequence_items: copMatrix.result && copMatrix.result.sequence_items ? copMatrix.result.sequence_items : null,
      unit_cell_only: Boolean(unitCellOnly),
      animate_id: Date.now(),
    },
    playing: Boolean(startPlaying),
  };
  await postState(body);
}

function customSequencePayloadItems() {
  return customOperationSequence.map(item => {
    if (item.type === "operation") {
      return {type: "operation", index: item.index};
    }
    return {
      type: "custom",
      label: item.label,
      W_frac: item.W_frac,
      t_frac: item.t_frac,
      op_type: item.op_type,
      op_params: item.op_params,
    };
  });
}

async function sendCustomSequenceCompose(sequenceRevision, structureKey, token) {
  const resultDiv = document.getElementById("cop-result");
  if (!customOperationSequence.length) {
    resultDiv.className = "cop-result fail";
    resultDiv.textContent = "操作を追加してください";
    resultDiv.hidden = false;
    return;
  }
  let payload;
  try {
    payload = {
      sequence_items: customSequencePayloadItems(),
      custom_sequence_token: token,
      store_custom_result: true,
      request_id: Date.now(),
    };
  } catch (err) {
    resultDiv.className = "cop-result fail";
    resultDiv.textContent = customOperationErrorMessage(err);
    resultDiv.hidden = false;
    return false;
  }
  resultDiv.className = "cop-result";
  resultDiv.textContent = "確認中…";
  resultDiv.hidden = false;
  try {
    copMatrix = null;
    const result = await api("/api/compose_operations", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(payload),
    });
    if (!customSequenceContextIsCurrent(sequenceRevision, structureKey)) return false;
    if (!result.error) {
      const updatedState = await api("/api/state", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({}),
      });
      if (customSequenceContextIsCurrent(sequenceRevision, structureKey)
          && updatedState.custom_sequence_token === token) {
        state = updatedState;
        displayCopResult(result, "sequence", {sequence_items: payload.sequence_items});
        return Boolean(copMatrix);
      }
    } else {
      displayCopResult(result, "sequence", {sequence_items: payload.sequence_items});
    }
  } catch (err) {
    if (!customSequenceContextIsCurrent(sequenceRevision, structureKey)) return false;
    // Scope/visibility selection can supersede a response without changing the
    // sequence. Retry it using that selection, including a waiting Play/GIF.
    if (err.obsolete) return null;
    resultDiv.className = "cop-result fail";
    resultDiv.textContent = customOperationErrorMessage(err);
  }
  return false;
}

document.getElementById("btn-add-existing-op").addEventListener("click", () => {
  const select = document.getElementById("cop-operation-select");
  const index = Number(select.value);
  if (select.value !== "" && Number.isInteger(index)
      && [...document.getElementById("cop-operation-menu").children].some(item => item.dataset.value === select.value)) {
    customOperationSequence.push({type: "operation", index});
    customSequenceChanged();
  }
});
document.getElementById("btn-add-custom-operation").addEventListener("click", async () => {
  await addCurrentCustomOperationToSequence();
});

async function addCurrentCustomOperationToSequence() {
  const resultDiv = document.getElementById("cop-result");
  const sequenceRevision = customSequenceRevision;
  const structureKey = `${state.json_path || ""}|${state.reload_request_id || ""}`;
  try {
    const payload = buildCopPayload();
    const result = await api("/api/check_operation", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({...payload, build_only: true}),
    });
    if (result.error || !result.W_frac || !result.t_frac) throw new Error(result.error || "Could not build operation");
    if (!customSequenceContextIsCurrent(sequenceRevision, structureKey)) return;
    customOperationSequence.push({
      type: "custom",
      label: payload.type[0].toUpperCase() + payload.type.slice(1),
      W_frac: result.W_frac,
      t_frac: result.t_frac,
      op_type: payload.type,
      op_params: payload.params,
    });
    customSequenceChanged();
  } catch (err) {
    if (!customSequenceContextIsCurrent(sequenceRevision, structureKey)) return;
    resultDiv.className = "cop-result fail";
    resultDiv.textContent = customOperationErrorMessage(err);
    resultDiv.hidden = false;
  }
}
document.getElementById("btn-clear-custom-sequence").addEventListener("click", () => {
  customOperationSequence = [];
  customSequenceChanged();
});
async function boot() {
  const st = document.getElementById("status");
  syncExperienceModeControls();
  st.textContent = "Connecting…";
  const [info, atomInfo, stateInfo, examplesInfo] = await Promise.all([
    api("/api/operations"),
    api("/api/atoms"),
    api("/api/state"),
    api("/api/examples"),
  ]);
  operations = info.operations;
  summariesReady = Boolean(info.summaries_ready);
  st.textContent = `Loaded ${operations.length} operations`;
  atoms = atomInfo.atoms;
  st.textContent = `Loaded ${operations.length} operations, ${atoms.length} atoms`;
  state = stateInfo;
  if (modelViewEnabled && !state.structure_loaded && state.import_status) showLoadError("Model preparation failed", state.import_status);
  fullImproperMode = state.improper_mode || "default";
  if (experienceMode === "beginner" && state.improper_mode !== "default") {
    await postState({improper_mode: "default", playing: false, reset: true});
  }
  exampleCatalog = examplesInfo || {crystal: [], molecule: []};
  if (state.source_kind === "crystal" || state.source_kind === "molecule") {
    selectedStructureKind = state.source_kind;
  }
  sourceKind = state.source_kind || "crystal";
  setDefaultOperationSortForSourceKind();
  await refreshAtomMotion();
  syncSourceKindControls();
  renderDirectionFilter();
  syncSpeedButtons();
  syncDisplayButtons();
  syncCellPlacementControls();
  syncCellSettingButtons();
  syncProjectionButtons();
  syncBackgroundButtons();
  syncLegendButtons();
  syncImproperModeControl();
  syncPlayToggleButton();
  renderOperations();
  renderSelectedAtomSummary();
  renderStructureInfo();
  renderStatus();
  renderOperationDetails();
  analysisBootComplete = true;
  setInterval(() => {
    refreshState().catch(showConnectionError);
  }, 1000);
}
boot().catch(showConnectionError);

async function refreshAnalysisFromServer() {
  if (!analysisBootComplete || analysisRefreshInProgress) return;
  analysisRefreshInProgress = true;
  try {
    const [info, atomInfo, stateInfo, examplesInfo] = await Promise.all([
      api("/api/operations"),
      api("/api/atoms"),
      api("/api/state"),
      api("/api/examples"),
    ]);
    operations = info.operations || [];
    summariesReady = Boolean(info.summaries_ready);
    atoms = atomInfo.atoms || [];
    state = stateInfo || {};
    exampleCatalog = examplesInfo || {crystal: [], molecule: []};
    if (state.source_kind === "crystal" || state.source_kind === "molecule") {
      selectedStructureKind = state.source_kind;
    }
    sourceKind = state.source_kind || "crystal";
    // Back to hub resets the server to its empty session.  This path bypasses
    // applyLoadedStructure(), so discard client-only Custom state here too;
    // otherwise re-entering Analysis leaves an old sequence/result visible
    // even though there is no structure to which it can belong.
    if (state.structure_loaded === false || sourceKind === "empty") {
      customUnmappedAtoms = new Set();
      customOperationSequence = [];
      invalidateCustomSequenceWork();
      activeMode = "standard";
      syncActiveModeControls();
    }
    setDefaultOperationSortForSourceKind();
    await refreshAtomMotion();
    syncSourceKindControls();
    renderExampleOptions();
    renderDirectionFilter();
      syncOperationSelection();
    syncSpeedButtons();
    syncDisplayButtons();
    syncCellPlacementControls();
    syncCellSettingButtons();
    syncProjectionButtons();
    syncBackgroundButtons();
    syncLegendButtons();
    syncImproperModeControl();
    syncPlayToggleButton();
    renderOperations();
    renderSelectedAtomSummary();
    renderStructureInfo();
    renderStatus();
    renderOperationDetails();
    if (window.symmetryThreeView) {
      const view = window.symmetryThreeView;
      const signature = `${state.json_path || ""}|${state.reload_request_id || 0}`;
      // Returning from the quiz reloads the paths; keep the playback position
      // when the structure and the selected operation are unchanged.
      const keptProgress = view.lastStateSignature === signature && !state.playing
        && state.active_mode !== "custom"
        && Number(view.state?.operation_index) === Number(state.operation_index)
        ? view.animationProgress : null;
      await view.refresh();
      await view.syncState(state, {structure_reload: true});
      view.lastStateSignature = signature;
      if (keptProgress > 0 && view.animationPaths.size) view.setAnimationProgress(keptProgress);
    }
  } catch (error) {
    showConnectionError(error);
  } finally {
    analysisRefreshInProgress = false;
  }
}

// --- Top-level Analysis / Puzzle mode ---
// Selection screen is the entry point; you return here with Back before
// switching, so puzzle and analysis never bleed into each other.
function readInitialAppMode() {
  try {
    const mode = JSON.parse(document.getElementById("app-mode-config").textContent);
    return mode === "analysis" || mode === "puzzle" ? mode : "select";
  } catch (error) {
    return "select";
  }
}
let appMode = readInitialAppMode();
// Whether the current analysis-mode visit was entered via puzzle.js's
// quiz analysis shortcut rather than the hub's 解析モード button. #analysis-back used to have a
// sibling #analysis-back-to-puzzle button for this case, but that button had
// its own independent hidden toggle while #analysis-back has none (it is
// shown/hidden only by whether .topbar itself is covered by a mode overlay),
// so a puzzle-shortcut visit showed both buttons side by side at once. One
// button that relabels itself avoids that by construction.
let analysisReturnsToPuzzle = false;
function updateAnalysisBackButton() {
  document.getElementById("analysis-back").textContent = analysisReturnsToPuzzle ? "← クイズ" : "← Back";
}
function applyAppMode({refreshAnalysis = true} = {}) {
  if (appMode !== "analysis") analysisWaiting.clear();
  document.getElementById("mode-select").hidden = appMode !== "select";
  document.getElementById("puzzle-mode").hidden = appMode !== "puzzle";
  document.body.classList.toggle("in-puzzle", appMode === "puzzle");
  document.body.classList.toggle("analysis-theme", appMode === "analysis");
  if (appMode === "analysis") {
    // The 3D canvas may have initialized while covered; nudge a resize.
    window.dispatchEvent(new Event("resize"));
    if (refreshAnalysis) refreshAnalysisFromServer();
  }
  if (appMode === "puzzle") {
    // puzzle.js lazily builds its own 3D view the first time this fires.
    window.dispatchEvent(new Event("symmetry-enter-puzzle"));
  } else {
    // Tell the puzzle's view to stop drawing; without this both renderers keep
    // an animation frame loop running for as long as the page is open.
    window.dispatchEvent(new Event("symmetry-exit-puzzle"));
  }
  window.symmetryThreeView?.setActive(appMode !== "puzzle");
  scheduleWorkspaceScrolling();
}
function setAppMode(mode, { fromPuzzle = false, prepared = false } = {}) {
  appMode = mode;
  // The quiz analysis shortcut passes fromPuzzle: true,
  // right when calling setAppMode("analysis") itself; every other way of
  // changing mode resets it so it does not linger into an unrelated analysis
  // visit.
  analysisReturnsToPuzzle = mode === "analysis" && fromPuzzle;
  updateAnalysisBackButton();
  applyAppMode({refreshAnalysis: !prepared});
}
window.setAppMode = setAppMode;

// Prepare through the normal analysis client and UI owners. Quiz IDs and plans
// never become analysis IDs; only verified operation geometry is compared.
window.openQuizInAnalysis = async ({example, quiz, operations: requested, customInputs = null, customTransforms = null, sourceAtom, isCurrent}) => {
  const analysisSpeed = Number(state.speed || 1);
  const requireCurrent = () => {
    if (!isCurrent()) throw Object.assign(new Error("obsolete_quiz_analysis"), {obsolete: true});
  };
  requireCurrent();
  const result = await api("/api/open_example", {method: "POST",
    body: JSON.stringify({kind: example.kind, path: example.path})});
  requireCurrent();
  if (!result.ok) throw new Error("analysis_model_not_prepared");
  const model = modelBoundary.active;
  const near = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length
    && a.every((value, i) => Array.isArray(value) ? near(value, b[i]) : Math.abs(value - b[i]) < 1e-8);
  for (const operation of requested) {
    const target = model.operations.find(op => op.operation_index === operation.operation_index);
    if (!target || !near(target.matrix, operation.matrix) || !near(target.translation, operation.translation)) {
      throw new Error("quiz_analysis_operation_mismatch");
    }
  }
  quizCustomModelId = quiz === "composition" ? model.model_id : null;
  await applyLoadedStructure(result, "解析を開けませんでした", example.path);
  requireCurrent();
  if (quiz !== "point_group") {
    experienceBeforeQuizAnalysis = experienceMode;
    await setExperienceMode("advanced");
  }
  requireCurrent();
  await postState({active_mode: "standard", improper_mode: "default", playing: false, reset: true, speed: analysisSpeed,
    operation_index: requested[0]?.operation_index ?? state.operation_index,
    selected_atoms: sourceAtom == null ? [] : [sourceAtom],
    scope: sourceAtom == null ? "displayed" : "selected_displayed", operation_repetitions: 1});
  requireCurrent();
  if (quiz === "composition") {
    activeMode = "custom";
    syncActiveModeControls();
    await postState({active_mode: "custom", playing: false, reset: true});
    requireCurrent();
    if (customInputs) {
      if (customInputs.length !== 2 || customTransforms?.length !== 2) throw new Error("quiz_custom_input_mismatch");
      const sequence = [];
      for (const [index, input] of customInputs.entries()) {
        if (!["mirror", "rotation", "inversion", "rotoinversion"].includes(input.kind))
          throw new Error("quiz_custom_input_mismatch");
        const built = await api("/api/check_operation", {method: "POST", body: JSON.stringify({
          type: input.kind, params: input.params, build_only: true})});
        requireCurrent();
        const expected = customTransforms[index];
        if (!near(built.W_frac, expected[model.periodic ? "matrix_frac" : "matrix_cart"])
            || !near(built.t_frac, expected[model.periodic ? "translation_frac" : "translation_cart"]))
          throw new Error("quiz_analysis_operation_mismatch");
        const label = input.kind === "mirror" ? "鏡映" : input.kind === "inversion" ? "反転"
          : `${Math.round(360/Math.abs(input.params.angle))}回${input.kind === "rotoinversion" ? "回反" : "回転"}`;
        sequence.push({type: "custom", label: `操作${index+1}：${label}`,
          op_type: input.kind, op_params: input.params, W_frac: built.W_frac, t_frac: built.t_frac});
      }
      customOperationSequence = sequence;
    } else {
      customOperationSequence = requested.map(op => ({type: "operation", index: op.operation_index}));
    }
    document.getElementById("custom-sequence-toggle").setAttribute("aria-expanded", "true");
    customSequenceChanged();
    if (!await sendCurrentCustomAnimation(false)) throw new Error("quiz_composition_not_prepared");
    requireCurrent();
    await postState({playing: false, reset: true});
  }
  await window.symmetryThreeView?.syncQueue;
  requireCurrent();
  if (modelBoundary.active?.model_id !== model.model_id) {
    throw Object.assign(new Error("obsolete_analysis_model"), {obsolete: true});
  }
  setAppMode("analysis", {fromPuzzle: true, prepared: true});
};
document.getElementById("enter-analysis").addEventListener("click", () => setAppMode("analysis"));
document.getElementById("enter-puzzle").addEventListener("click", () => setAppMode("puzzle"));
document.getElementById("analysis-back").addEventListener("click", async () => {
  if (analysisReturnsToPuzzle) {
    resumePuzzleMode();
    // The quiz shortcut switched Simple to Advanced; give the user's display
    // back unless they changed it during the visit.
    const previous = experienceBeforeQuizAnalysis;
    experienceBeforeQuizAnalysis = "";
    if (previous && previous !== experienceMode && experienceMode === "advanced") {
      setExperienceMode(previous).catch(error => console.warn(error));
    }
    return;
  }
  try {
    await api("/api/reset_analysis", {method: "POST", body: "{}"});
    // The analysis is now empty; the example picker must not keep its name.
    selectedExamplePath = "";
    renderExampleOptions();
  } catch (error) {
    document.getElementById("status").textContent = `Reset error: ${error}`;
  }
  setAppMode("select");
});
// #puzzle-back's own click handler now lives in puzzle.js (goBack()): within
// puzzle mode it means "one step back", which only sometimes means the hub, so
// it needs puzzle.js's own screen state to resolve — see
// docs/archive/sessions/SESSION_REPORT_2026-09-09.md.

// An answered quiz can jump straight into analysis mode on the
// same structure (openCurrentStructureInAnalysis() in puzzle.js) without going
// through 戻る/select first, so unlike every other path here, the puzzle side's
// screen (and its round state) is still intact underneath and just needs
// re-showing — not enterPuzzle()'s usual reset to the quiz list. A dedicated
// event (rather than reusing symmetry-enter-puzzle) keeps that distinction
// explicit for puzzle.js's own listener.
function resumePuzzleMode() {
  appMode = "puzzle";
  document.getElementById("mode-select").hidden = true;
  document.getElementById("puzzle-mode").hidden = false;
  document.body.classList.add("in-puzzle");
  document.body.classList.remove("analysis-theme");
  analysisReturnsToPuzzle = false;
  updateAnalysisBackButton();
  window.dispatchEvent(new Event("symmetry-resume-puzzle"));
  window.symmetryThreeView?.setActive(false);
}
applyAppMode();
