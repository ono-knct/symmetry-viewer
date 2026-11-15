import {playbackDurationMs, playbackStepAt} from "/static/playback_schedule.js";
import * as THREE from "/vendor/three/three.module.js";
import { TrackballControls } from "/vendor/three/addons/controls/TrackballControls.js";
import {
  evaluatePath,
  pathBreakpoints,
  pathAppliesToDisplayInstance,
  sequentialSegmentBoundaries,
} from "/static/animation_path.js";
import { SYMMETRY_ELEMENT_COLORS } from "/static/colors.js";
import {waitingForView, analysisClient, viewFetch, modelViewEnabled, evaluateModelPath} from "/static/view_api.js";

// Legacy paths are confined to an explicit API1 compatibility host.
function evaluateViewerPath(path, progress, start) {
  return path?.type === "model_plan" ? evaluateModelPath(path, progress, start) : evaluatePath(path, progress, start);
}
function viewerBreakpoints(path, start) {
  if (path?.type !== "model_plan") return pathBreakpoints(path, start);
  const playback = path.compiledPlayback;
  // The common schedule already includes the completed endpoint. Keep it
  // once, including schedules whose final sum differs by floating roundoff.
  return [...new Set([0, ...playback.step_boundaries_seconds.map(t =>
    Math.max(0, Math.min(1, t / (playback.duration_seconds || 1)))), 1])];
}


const CAMERA_FOV = 42;
const DEFAULT_VIEW_DIRECTION = new THREE.Vector3(1, -1.35, 0.9).normalize();
// The usual view first, then the cube's face/edge/corner directions that are
// not steeper than about 53° from the horizontal, nearest to the usual first.
const CLEAR_VIEW_DIRECTIONS = [DEFAULT_VIEW_DIRECTION, ...[-1, 0, 1].flatMap(x => [-1, 0, 1].flatMap(y => [-1, 0, 1]
  .map(z => new THREE.Vector3(x, y, z))))
  .filter(vector => vector.lengthSq() > 0 && Math.abs(vector.z) / vector.length() <= 0.8)
  .map(vector => vector.normalize())
  .sort((a, b) => b.dot(DEFAULT_VIEW_DIRECTION) - a.dot(DEFAULT_VIEW_DIRECTION))];
const ORTHOGRAPHIC_HEIGHT = 10;
// Shared world-space radius, independent of element and atom display size.
const TRAJECTORY_RADIUS = 0.025;

function viewerConstants() {
  // Injected by crystal_viewer/web/browser_ui.py so Python owns the value.
  // The literals below are a last resort for contexts without the page (the
  // JS syntax check and the node test harness), not a second definition.
  try {
    return JSON.parse(document.getElementById("viewer-constants").textContent);
  } catch {
    return {};
  }
}
const STATIONARY_ANIMATION_SECONDS = viewerConstants().stationary_animation_seconds ?? 0.4;
const GIF_END_HOLD_MS = 1000;
const CURVED_PATH_TYPES = new Set(["rotation", "screw", "rotoinversion", "rotoreflection"]);
const CRYSTAL_AXIS_COLORS = [0xef4444, 0x22c55e, 0x3b82f6];
const ZERO_SCALE = new THREE.Vector3(0, 0, 0);


function pathHasCurvedMotion(path) {
  if (!path) return false;
  if (path.type === "model_plan") return true;
  if (path.type === "sequential") return (path.segments || []).some(pathHasCurvedMotion);
  return CURVED_PATH_TYPES.has(path.type);
}

export class StaticStructureView {
  constructor(container, {panSpeed = 0.65, showMolecularAxes = false, clearMoleculeView = false} = {}) {
    this.container = container;
    this.clearMoleculeView = clearMoleculeView;
    this.modelClient = modelViewEnabled && container.id === "three-view" ? analysisClient : null;
    this.panSpeed = panSpeed;
    this.showMolecularAxes = showMolecularAxes;
    this.showCoordinateAxes = true;
    this.status = container.querySelector("[data-three-status]");
    this.legend = container.querySelector("[data-atom-legend]");
    this.cellAxisDirections = [];
    this.cellAxisOrientation = "";
    this.createCellAxisGuide();
    this.canvas = container.querySelector("canvas");
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xf4f6f3);
    this.content = new THREE.Group();
    this.scene.add(this.content);

    this.perspectiveCamera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 0.01, 10000);
    this.orthographicCamera = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.01, 10000);
    this.activeCamera = this.perspectiveCamera;
    this.renderer = new THREE.WebGLRenderer({canvas: this.canvas, antialias: true, preserveDrawingBuffer: true});
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    // Both views live for the whole session; only the visible one draws.
    this.active = true;
    this.frameHandle = null;
    this.controls = null;
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.pointerDown = null;

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x263342, 2.2));
    const keyLight = new THREE.DirectionalLight(0xffffff, 2.8);
    keyLight.position.set(5, -4, 7);
    this.scene.add(keyLight);
    const fillLight = new THREE.DirectionalLight(0x8ec5ff, 1.2);
    fillLight.position.set(-4, 3, -2);
    this.scene.add(fillLight);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);
    this.lastStateSignature = "";
    this.state = {};
    this.atomInstances = new Map();
    this.instanceMeshes = new Set();
    this.animationPaths = new Map();
    this.animationOperationIndex = null;
    this.customAnimationId = null;
    this.customRepresentativePath = null;
    this.customSegmentElements = [];
    this.customSegmentBoundaries = [];
    this.customSegmentIndex = null;
    this.animationBreakpoints = [0, 1];
    this.symmetryOperationIndex = null;
    this.operationViewDirection = null;
    this.operationFocusPoint = null;
    this.symmetryObjects = [];
    this.targetMarkerObjects = [];
    this.startMarkerObjects = [];
    this.trajectoryObjects = [];
    this.selectionMarkers = new Map();
    this.selectionSignature = null;
    // Puzzle-owned atom rings (source / guess / target), independent of the
    // analysis selection. Set via setPickMarkers; an onAtomPick hook, when
    // present, routes clicks to the puzzle instead of the analysis selection.
    this.pickMarkers = new Map();
    this.onAtomPick = null;
    this.disableAtomSelection = false;
    // Optional source-atom filter used by the mapping puzzle preview. Paths remain
    // loaded for the full operation, but atoms outside the set stay at rest.
    this.animationSourceAtoms = null;
    this.animationProgress = 0;
    this.animationStartedAt = null;
    this.playing = false;
    this.localPlayback = null;
    this.advancingPlayback = false;
    this.maximumTravelDistance = 0;
    this.baseAnimationDurationSeconds = STATIONARY_ANIMATION_SECONDS;
    this.baseStatus = "3D view";
    this.lastProgressBucket = -1;
    this.lastPublishedProgressBucket = -1;
    this.pathGeneration = 0;
    this.syncQueue = Promise.resolve();
    this.serverPlaying = false;
    this.playbackStopPending = false;
    this.recording = false;
    this.backgroundMode = null;
    this.renderDataQuery = ""; // owner may set e.g. "?boundary_images=1" (puzzle)
    this.animationPathQuery = ""; // owner may set e.g. "&display_mode=source" (puzzle)
    this.symmetryElementQuery = ""; // owner may set e.g. "&display_mode=source" (puzzle)
    this.showAnimationTargets = false; // owner may enable static target markers (puzzle)
    this.showAnimationTargetCopies = true;
    this.showTrajectories = false;
    this.rangeHighlightEnabled = false;
    this.referenceCellLower = 0;
    this.destinationCellOffset = null;
    this.destinationCellObject = null;
    this.destinationCellAtoms = null;
    this.hiddenElements = new Set();
    this.legendItems = [];
    this.tempMatrix = new THREE.Matrix4();
    this.tempPosition = new THREE.Vector3();
    this.tempScale = new THREE.Vector3();
    this.tempQuaternion = new THREE.Quaternion();
    this.animate = this.animate.bind(this);
    this.handlePointerDown = this.handlePointerDown.bind(this);
    this.handlePointerUp = this.handlePointerUp.bind(this);
    this.canvas.addEventListener("pointerdown", this.handlePointerDown);
    this.canvas.addEventListener("pointerup", this.handlePointerUp);
    if (container.id === "three-view") {
      window.addEventListener("symmetry-animation-progress", event => {
        if (this.active) this.setAnimationProgress(event.detail?.progress);
      });
      window.addEventListener("symmetry-save-png", () => this.savePng());
      let gifRequestPending = false;
      window.addEventListener("symmetry-save-gif", async () => {
        if (gifRequestPending) return;
        gifRequestPending = true;
        window.dispatchEvent(new CustomEvent("symmetry-gif-export-busy", {detail: {busy: true}}));
        try {
          await this.syncQueue;
          await this.recordGif();
        } catch (error) {
          this.setStatus(`GIF export error: ${error.message}`);
        } finally {
          gifRequestPending = false;
          window.dispatchEvent(new CustomEvent("symmetry-gif-export-busy", {detail: {busy: false}}));
        }
      });
    }
    this.requestFrame();
  }

  setModelClient(client) {
    if (client === this.modelClient) return;
    this.pathGeneration += 1;
    this.playing = false;
    this.animationPaths.clear();
    this.animationOperationIndex = null;
    this.customAnimationId = null;
    this.state = {};
    this.modelClient = client;
  }

  async renderPayload() {
    this.setStatus("Loading 3D view…");
    // Optional query (e.g. the puzzle's "?boundary_images=1") set by the owner.
    const response = await this.viewFetch(`/api/render_data${this.renderDataQuery || ""}`);
    if (!response.ok) {
      throw new Error(await response.text() || `${response.status} ${response.statusText}`);
    }
    const payload = await response.json();
    if (payload.coordinate_space !== "cartesian") {
      throw new Error(`Unsupported coordinate space: ${payload.coordinate_space}`);
    }
    return payload;
  }

  viewFetch(path, options) {
    if (this.modelClient && /^\/api\/(custom_)?animation_path/.test(path)) {
      path += `${path.includes("?") ? "&" : "?"}freeze_range_extensions=${this.rangeHighlightEnabled ? "1" : "0"}`;
    }
    return this.modelClient ? this.modelClient.viewFetch(path, options) : fetch(modelViewEnabled && this.container.id !== "three-view" ? path.replace(/^\/api\//, "/api/quiz/") : path, options);
  }

  async refresh(preserveCamera = false, exchangePayload = null, preservePlayback = false) {
    return waitingForView(this.container).run(() => this.refreshReady(preserveCamera, exchangePayload, preservePlayback));
  }

  async refreshReady(preserveCamera = false, exchangePayload = null, preservePlayback = false) {
    const cameraState = preserveCamera && this.controls ? {
      position: this.activeCamera.position.clone(),
      up: this.activeCamera.up.clone(),
      quaternion: this.activeCamera.quaternion.clone(),
      target: this.controls.target.clone(),
      zoom: this.activeCamera.zoom,
      orthographicSpan: this.orthographicSpan,
    } : null;
    const payload = exchangePayload || await this.renderPayload();
    // A quiz boundary toggle changes display instances within the same model.
    // Keep its existing element geometry out of clearContent's disposal pass.
    const playback = preservePlayback ? {
      elements: [...this.symmetryObjects],
      operationIndex: this.animationOperationIndex,
      symmetryIndex: this.symmetryOperationIndex,
      hiddenElements: new Set(this.hiddenElements),
    } : null;
    if (playback) for (const object of playback.elements) this.content.remove(object);
    this.setData(payload);
    if (playback) {
      this.symmetryObjects = playback.elements;
      for (const object of playback.elements) this.content.add(object);
      this.animationOperationIndex = playback.operationIndex;
      this.symmetryOperationIndex = playback.symmetryIndex;
      this.hiddenElements = playback.hiddenElements;
      for (const atom of this.destinationCellAtoms?.children || []) {
        atom.visible = !this.hiddenElements.has(atom.userData.element);
      }
      this.applyAnimationProgress();
      if (this.animationProgress > 0) this.showStartMarkers();
      this.updateAnimationTargetMarkers();
      this.updateTrajectoryLines();
    }
    if (cameraState) {
      this.activeCamera.position.copy(cameraState.position);
      this.activeCamera.up.copy(cameraState.up);
      this.activeCamera.quaternion.copy(cameraState.quaternion);
      this.controls.target.copy(cameraState.target);
      this.activeCamera.zoom = cameraState.zoom;
      this.orthographicSpan = cameraState.orthographicSpan;
      this.controls.update();
      this.resize();
    }
    if (playback) this.render();
  }

  async refreshAtomColors() {
    const payload = await this.renderPayload();
    const styles = new Map((payload.atom_styles || []).map(style => [Number(style.index), style]));
    for (const mesh of this.instanceMeshes) {
      for (const instance of mesh.userData.atomInstances || []) {
        const style = styles.get(instance.sourceAtom);
        if (!style?.color) continue;
        instance.baseColor.set(style.color);
        mesh.setColorAt(instance.instanceIndex, instance.baseColor);
      }
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    this.setLegendItems(payload.display_atoms || [], payload.atom_styles || []);
    if (this.destinationCellOffset) this.setDestinationCell(this.destinationCellOffset);
    this.render();
  }

  setData(payload) {
    this.clearContent();
    this.hiddenElements.clear();
    this.isMolecule = payload.source_kind === "molecule";
    this.referenceCellLower = payload.cell_origin_mode === "center" ? -0.5 : 0;
    const renderData = payload.render_data || {};
    this.renderData = renderData;
    this.cellRepresentativeDisplay = renderData.metadata?.cell_representative_policy === "cell-intersection-v1";
    this.cellAxisDirections = this.isMolecule
      ? (this.showMolecularAxes ? [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map(vector => new THREE.Vector3(...vector)) : [])
      : (payload.display_unit_cell
        ? (renderData.unit_cell?.lattice || []).map(vector => new THREE.Vector3(...vector).normalize())
        : []);
    const axisLabels = this.isMolecule ? ["x", "y", "z"] : ["a", "b", "c"];
    this.cellAxisParts.forEach(({group, text}, index) => {
      group.setAttribute("data-cell-axis", axisLabels[index]);
      text.textContent = axisLabels[index];
    });
    this.cellAxisGuide.setAttribute("aria-label", this.isMolecule ? "分子の座標軸 x・y・z" : "Cell axis directions");
    this.cellAxisOrientation = "";
    this.syncCellAxisGuideVisibility();
    const atoms = payload.display_atoms || renderData.atoms || [];
    const styles = new Map((payload.atom_styles || []).map(style => [Number(style.index), style]));
    this.setLegendItems(atoms, payload.atom_styles || []);
    this.addAtoms(atoms, styles);
    if (payload.source_kind === "crystal" && payload.display_unit_cell) {
      this.addUnitCell(payload.display_unit_cell, renderData.unit_cell);
    }
    if (this.destinationCellOffset) this.setDestinationCell(this.destinationCellOffset);
    this.fitCamera(renderData, payload.cell_origin_mode);
    this.animationOperationIndex = null;
    this.symmetryOperationIndex = null;
    const kind = payload.source_kind === "molecule" ? "molecule" : "crystal";
    this.baseStatus = `3D view: ${atoms.length} atoms (${kind})`;
    this.setStatus(`${this.baseStatus}, animation ready`);
    this.render();
  }

  addAtoms(atoms, styles) {
    this.atomInstances.clear();
    const groups = new Map();
    for (const atom of atoms) {
      if (!Array.isArray(atom.cart) || atom.cart.length !== 3) continue;
      const sourceAtom = Number(atom.source_atom ?? atom.index);
      const style = styles.get(sourceAtom) || {color: "#9aa5b1", radius: 0.35};
      const radius = Math.max(Number(style.radius) || 0.35, 0.02);
      // Opposite boundary faces are part of the reference cell too. Primary
      // image flags alone would incorrectly freeze those boundary atoms.
      const rangeExtension = !this.isMolecule && Array.isArray(atom.frac)
        && atom.frac.some(value => value < this.referenceCellLower - 1e-9
          || value > this.referenceCellLower + 1 + 1e-9);
      const key = `${style.color}|${radius.toFixed(8)}|${rangeExtension}`;
      if (!groups.has(key)) groups.set(key, {style, radius, rangeExtension, atoms: []});
      groups.get(key).atoms.push(atom);
    }
    this.maxAtomRadius = groups.size
      ? Math.max(...[...groups.values()].map(group => group.radius))
      : 0.35;

    const geometry = new THREE.SphereGeometry(1, 28, 18);
    const matrix = new THREE.Matrix4();
    for (const group of groups.values()) {
      const material = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.34,
        metalness: 0.04,
      });
      const mesh = new THREE.InstancedMesh(geometry, material, group.atoms.length);
      mesh.userData.rangeExtension = group.rangeExtension;
      mesh.frustumCulled = false;
      mesh.userData.atomInstances = [];
      this.instanceMeshes.add(mesh);
      group.atoms.forEach((atom, instanceIndex) => {
        matrix.compose(
          new THREE.Vector3(...atom.cart),
          new THREE.Quaternion(),
          new THREE.Vector3(group.radius, group.radius, group.radius),
        );
        mesh.setMatrixAt(instanceIndex, matrix);
        const instanceId = Number(atom.instance_id ?? atom.index);
        const instance = {
          mesh,
          instanceIndex,
          sourceAtom: Number(atom.source_atom ?? atom.index),
          element: atom.element || "",
          isPrimaryImage: atom.is_primary_image !== false,
          isRangeExtension: group.rangeExtension,
          radius: group.radius,
          frac: Array.isArray(atom.frac) ? [...atom.frac] : null,
          start: [...atom.cart],
          current: [...atom.cart],
          baseColor: new THREE.Color(group.style.color),
        };
        mesh.setColorAt(instanceIndex, instance.baseColor);
        mesh.userData.atomInstances[instanceIndex] = instance;
        this.atomInstances.set(instanceId, instance);
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      this.content.add(mesh);
    }
    this.updateRangeHighlightAppearance();
    this.updateAtomSelectionHighlight();
  }

  updateRangeHighlightAppearance() {
    for (const mesh of this.instanceMeshes) {
      const highlighted = this.rangeHighlightEnabled && mesh.userData.rangeExtension;
      mesh.material.transparent = highlighted;
      mesh.material.opacity = highlighted ? 0.22 : 1;
      mesh.material.depthWrite = !highlighted;
      mesh.material.needsUpdate = true;
    }
  }

  setRangeHighlight(enabled) {
    this.rangeHighlightEnabled = Boolean(enabled);
    this.updateRangeHighlightAppearance();
    this.resetAnimation();
    this.updateTrajectoryLines();
    if (this.modelClient && this.state.structure_loaded) {
      this.syncState(this.state, {include_boundary_images: this.state.include_boundary_images}).catch(error => this.setStatus(String(error)));
    }
  }

  addUnitCell(unitCell, sourceUnitCell = null) {
    const vertices = unitCell.vertices_cart || [];
    const lattice = sourceUnitCell?.lattice || [];
    const directions = Array.isArray(lattice)
      ? lattice.map(vector => new THREE.Vector3(...vector).normalize())
      : [];
    const positionsByAxis = [[], [], [], []];
    for (const edge of unitCell.edges || []) {
      const start = vertices[edge[0]];
      const end = vertices[edge[1]];
      if (!start || !end) continue;
      const edgeDirection = new THREE.Vector3(
        end[0] - start[0],
        end[1] - start[1],
        end[2] - start[2],
      ).normalize();
      let axis = 3;
      let best = -1;
      for (let index = 0; index < directions.length; index += 1) {
        const score = Math.abs(edgeDirection.dot(directions[index]));
        if (score > best) {
          best = score;
          axis = index;
        }
      }
      positionsByAxis[Math.min(axis, 3)].push(...start, ...end);
    }
    for (let axis = 0; axis < positionsByAxis.length; axis += 1) {
      const positions = positionsByAxis[axis];
      if (!positions.length) continue;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      const color = axis < 3 ? CRYSTAL_AXIS_COLORS[axis] : 0xa8b5c5;
      const material = new THREE.LineBasicMaterial({color, transparent: true, opacity: 0.86});
      this.content.add(new THREE.LineSegments(geometry, material));
    }
  }

  setDestinationCell(offset) {
    if (this.destinationCellAtoms) {
      this.content.remove(this.destinationCellAtoms);
      this.destinationCellAtoms.traverse(object => {
        object.geometry?.dispose();
        object.material?.dispose();
      });
      this.destinationCellAtoms = null;
    }
    if (this.destinationCellObject) {
      this.content.remove(this.destinationCellObject);
      this.destinationCellObject.geometry.dispose();
      this.destinationCellObject.material.dispose();
      this.destinationCellObject = null;
    }
    this.destinationCellOffset = offset ? [...offset] : null;
    const lattice = this.renderData?.unit_cell?.lattice;
    if (offset && !this.isMolecule && lattice?.length === 3) {
      const basis = this.symmetryCellBasis();
      const corner = bits => new THREE.Vector3(...bits.map((value, i) => value + offset[i])).applyMatrix4(basis);
      const positions = [];
      for (let index = 0; index < 8; index += 1) {
        const bits = [index & 1, (index >> 1) & 1, (index >> 2) & 1];
        for (let axis = 0; axis < 3; axis += 1) {
          if (bits[axis]) continue;
          const end = [...bits]; end[axis] = 1;
          positions.push(...corner(bits).toArray(), ...corner(end).toArray());
        }
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      const material = new THREE.LineBasicMaterial({color: 0x64748b, transparent: true, opacity: 0.45});
      this.destinationCellObject = new THREE.LineSegments(geometry, material);
      this.destinationCellObject.name = "mapping-destination-cell";
      this.content.add(this.destinationCellObject);
      // Static periodic context, separate from selectable/animated atoms.
      // Include both faces for sites on the boundary, without duplicating sites.
      const atoms = new THREE.Group();
      atoms.name = "mapping-destination-atoms";
      const sites = new Set();
      const sphere = new THREE.SphereGeometry(1, 20, 16);
      const styles = new Map([...this.atomInstances.values()].map(atom => [atom.sourceAtom, atom]));
      for (const atom of this.renderData.atoms || []) {
        if (!Array.isArray(atom.frac)) continue;
        const style = styles.get(Number(atom.index));
        if (!style) continue;
        const choices = atom.frac.map(value => {
          const wrapped = value - Math.floor(value);
          return wrapped < 1e-8 || wrapped > 1 - 1e-8 ? [0, 1] : [wrapped];
        });
        for (const x of choices[0]) for (const y of choices[1]) for (const z of choices[2]) {
          const frac = [x, y, z].map((value, i) => value + offset[i]);
          const key = `${atom.element}:${frac.map(value => value.toFixed(8)).join(",")}`;
          if (sites.has(key)) continue;
          sites.add(key);
          const material = new THREE.MeshStandardMaterial({
            color: style.baseColor, roughness: 0.34, metalness: 0.04,
            transparent: true, opacity: 0.22, depthWrite: false,
          });
          const mesh = new THREE.Mesh(sphere, material);
          mesh.position.copy(new THREE.Vector3(...frac).applyMatrix4(basis));
          mesh.scale.setScalar(style.radius);
          mesh.userData.element = atom.element;
          mesh.visible = !this.hiddenElements.has(atom.element);
          atoms.add(mesh);
        }
      }
      if (!atoms.children.length) sphere.dispose();
      this.destinationCellAtoms = atoms;
      this.content.add(atoms);
    }
    this.render();
  }

  clearContent() {
    this.destinationCellObject = null;
    this.destinationCellAtoms = null;
    this.symmetryObjects = [];
    this.clearTargetMarkers();
    this.startMarkerObjects = [];
    this.clearTrajectoryLines();
    this.selectionMarkers.clear();
    this.selectionSignature = null;
    this.pickMarkers.clear();
    this.atomInstances.clear();
    this.instanceMeshes.clear();
    for (const child of [...this.content.children]) {
      this.content.remove(child);
      child.traverse(object => {
        object.geometry?.dispose();
        if (Array.isArray(object.material)) object.material.forEach(material => material.dispose());
        else object.material?.dispose();
      });
    }
  }

  fitCamera(renderData, cellOriginMode = "center") {
    const box = new THREE.Box3().setFromObject(this.content);
    if (box.isEmpty()) {
      const minimum = renderData.bounds_min || [-1, -1, -1];
      const maximum = renderData.bounds_max || [1, 1, 1];
      box.set(new THREE.Vector3(...minimum), new THREE.Vector3(...maximum));
    }
    const center = box.getCenter(new THREE.Vector3());
    if (renderData.unit_cell) {
      center.set(0, 0, 0);
      if (cellOriginMode === "corner") {
        for (const basis of renderData.unit_cell.lattice) center.addScaledVector(new THREE.Vector3(...basis), 0.5);
      }
    }
    const size = box.getSize(new THREE.Vector3());
    const span = Math.max(size.x, size.y, size.z, 1);
    const width = this.container.clientWidth;
    const height = this.canvas.clientHeight;
    // Include the atom surfaces in both fields of view at initial load.
    // Ordinary resize/mode changes still preserve the user's view.
    const aspect = width > 0 && height > 0 ? width / height : 1;
    const tanHalfFov = Math.tan(THREE.MathUtils.degToRad(CAMERA_FOV / 2));
    const direction = this.isMolecule && this.clearMoleculeView
      ? this.clearMoleculeViewDirection()
      : DEFAULT_VIEW_DIRECTION.clone();
    const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 0, 1), direction).normalize();
    const up = new THREE.Vector3().crossVectors(direction, right);
    let distance = span / (2 * tanHalfFov) * 1.45;
    let orthographicSpan = span * 1.45;
    for (const x of [box.min.x, box.max.x]) {
      for (const y of [box.min.y, box.max.y]) {
        for (const z of [box.min.z, box.max.z]) {
          const offset = new THREE.Vector3(x, y, z).sub(center);
          const halfSpan = Math.max(Math.abs(offset.dot(up)), Math.abs(offset.dot(right)) / aspect) * 1.1;
          distance = Math.max(distance, offset.dot(direction) + halfSpan / tanHalfFov);
          orthographicSpan = Math.max(orthographicSpan, halfSpan * 2);
        }
      }
    }
    const position = center.clone().addScaledVector(direction, distance);
    for (const camera of [this.perspectiveCamera, this.orthographicCamera]) {
      camera.position.copy(position);
      camera.up.set(0, 0, 1);
      camera.lookAt(center);
      camera.near = Math.max(distance / 1000, 0.001);
      camera.far = Math.max(distance * 20, 100);
      camera.updateProjectionMatrix();
    }
    this.orthographicSpan = orthographicSpan;
    this.createControls(center);
    // This is captured before symmetry elements are added, so a reset returns
    // to the same framing used when the structure was first displayed.
    this.defaultCameraState = {
      position: this.activeCamera.position.clone(),
      up: this.activeCamera.up.clone(),
      target: this.controls.target.clone(),
    };
    this.resize();
  }

  // Quiz molecules: the first of a fixed list of directions (the usual one,
  // then those nearest to it) that leaves no atom centre behind a nearer atom.
  // The choice depends only on the structure, so every question and Reset of
  // the same molecule starts from the same view.
  clearMoleculeViewDirection() {
    const atoms = [...this.atomInstances.values()];
    const hiddenAtoms = direction => {
      const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 0, 1), direction).normalize();
      const up = new THREE.Vector3().crossVectors(direction, right);
      const projected = atoms.map(atom => {
        const position = new THREE.Vector3(...atom.start);
        return {x: position.dot(right), y: position.dot(up), depth: position.dot(direction), radius: atom.radius};
      });
      return projected.filter(back => projected.some(front => front !== back && front.depth > back.depth
        && Math.hypot(front.x - back.x, front.y - back.y) < front.radius)).length;
    };
    let best = DEFAULT_VIEW_DIRECTION.clone();
    let fewest = Infinity;
    for (const direction of CLEAR_VIEW_DIRECTIONS) {
      const hidden = hiddenAtoms(direction);
      if (hidden < fewest) {
        best = direction.clone();
        fewest = hidden;
      }
      if (hidden === 0) break;
    }
    return best;
  }

  createControls(target) {
    this.controls?.dispose();
    this.controls = new TrackballControls(this.activeCamera, this.canvas);
    this.controls.rotateSpeed = 1.15;
    this.controls.zoomSpeed = 1.05;
    this.controls.panSpeed = this.panSpeed;
    this.controls.staticMoving = false;
    this.controls.dynamicDampingFactor = 0.14;
    this.controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
    this.controls.mouseButtons.MIDDLE = THREE.MOUSE.DOLLY;
    this.controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
    this.controls.target.copy(target);
    this.controls.addEventListener("change", () => this.render());
    this.controls.handleResize();
    this.controls.update();
  }

  setProjection(mode) {
    const nextCamera = mode === "orthographic" ? this.orthographicCamera : this.perspectiveCamera;
    if (nextCamera === this.activeCamera) return;
    nextCamera.position.copy(this.activeCamera.position);
    nextCamera.quaternion.copy(this.activeCamera.quaternion);
    const target = this.controls?.target.clone() || new THREE.Vector3();
    this.activeCamera = nextCamera;
    this.createControls(target);
    this.resize();
  }

  handlePointerDown(event) {
    if (event.button !== 0) return;
    this.pointerDown = {
      x: event.clientX,
      y: event.clientY,
      time: performance.now(),
    };
  }

  handlePointerUp(event) {
    if (event.button !== 0 || !this.pointerDown) return;
    const movement = Math.hypot(event.clientX - this.pointerDown.x, event.clientY - this.pointerDown.y);
    const elapsed = performance.now() - this.pointerDown.time;
    this.pointerDown = null;
    if (movement > 5 || elapsed > 500) return;
    const hit = this.pickAtomInstance(event);
    if (this.onAtomPick) {
      // Puzzle mode owns clicks (e.g. the "where does this atom go?" quiz); do not
      // touch the shared analysis selection / server state.
      this.onAtomPick(hit ? hit.sourceAtom : null, hit, event);
      return;
    }
    if (this.disableAtomSelection) return;
    if (!hit && !String(this.state.scope).startsWith("selected")) return;
    this.selectAtom(hit ? hit.sourceAtom : null, event);
  }

  pickAtomInstance(event) {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.activeCamera);
    const intersections = this.raycaster.intersectObjects([...this.instanceMeshes], false);
    for (const intersection of intersections) {
      const instanceIndex = intersection.instanceId;
      if (!Number.isInteger(instanceIndex)) continue;
      const instance = intersection.object.userData.atomInstances?.[instanceIndex];
      if (instance && !this.isAtomVisible(instance)) continue;
      if (instance) return instance;
    }
    return null;
  }

  async selectAtom(sourceAtom, event) {
    const current = new Set((this.state.selected_atoms || []).map(Number));
    let selected;
    if (sourceAtom === null) {
      selected = [];
    } else if (event.shiftKey || event.ctrlKey || event.metaKey) {
      if (current.has(sourceAtom)) current.delete(sourceAtom);
      else current.add(sourceAtom);
      selected = [...current].sort((a, b) => a - b);
    } else {
      selected = current.size === 1 && current.has(sourceAtom) ? [] : [sourceAtom];
    }
    const update = {
      selected_atoms: selected,
      scope: selected.length ? "selected_displayed" : "displayed",
      playing: false,
      reset: true,
    };
    try {
      if (typeof window.symmetryPostState === "function") {
        await window.symmetryPostState(update);
        return;
      }
      const response = await this.viewFetch("/api/state", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(update),
      });
      if (!response.ok) throw new Error(await response.text() || `${response.status} ${response.statusText}`);
      const state = await response.json();
      window.dispatchEvent(new CustomEvent("symmetry-state-update", {
        detail: {state: {...state}, update: {...update}},
      }));
    } catch (error) {
      this.setStatus(`Selection error: ${error.message}`);
    }
  }

  updateAtomSelectionHighlight() {
    const selected = String(this.state.scope).startsWith("selected")
      ? new Set((this.state.selected_atoms || []).map(Number))
      : new Set();
    const signature = JSON.stringify([...selected].sort((a, b) => a - b));
    if (signature === this.selectionSignature) return;
    this.selectionSignature = signature;
    this.updateSelectionMarkers(selected);
    this.render();
  }

  updateSelectionMarkers(selected) {
    for (const marker of this.selectionMarkers.values()) {
      this.content.remove(marker);
      marker.geometry.dispose();
      marker.material.dispose();
    }
    this.selectionMarkers.clear();
    for (const [instanceId, instance] of this.atomInstances) {
      if (!selected.has(instance.sourceAtom)) continue;
      const marker = this._makeSelectionRing(instance.radius);
      marker.position.fromArray(instance.current);
      this.selectionMarkers.set(instanceId, marker);
      this.content.add(marker);
    }
  }

  // Shared appearance for analysis selection and quiz coordinate inspection.
  // Their selection state and animation scope remain independent.
  _makeSelectionRing(radius, color = 0xc05a00) {
    const outerRadius = radius * 1.55;
    const geometry = new THREE.RingGeometry(outerRadius * 0.94, outerRadius, 48);
    const material = new THREE.MeshBasicMaterial({
      color,
      side: THREE.DoubleSide,
      transparent: false,
      depthTest: true,
      depthWrite: false,
    });
    const marker = new THREE.Mesh(geometry, material);
    marker.quaternion.copy(this.activeCamera.quaternion);
    marker.renderOrder = 10;
    return marker;
  }

  clearPickMarkers() {
    for (const marker of this.pickMarkers.values()) {
      this.content.remove(marker);
      marker.geometry.dispose();
      marker.material.dispose();
    }
    this.pickMarkers.clear();
    this.container.dataset.pickMarkerCount = "0";
    this.render();
  }

  setAnimationSourceAtoms(sourceAtoms = null, primaryOnly = false) {
    this.animationPrimaryOnly = primaryOnly;
    this.animationSourceAtoms = sourceAtoms == null
      ? null
      : new Set([...sourceAtoms].map((index) => Number(index)));
  }

  animationPathForInstance(instance) {
    if (this.animationPrimaryOnly && !instance.isPrimaryImage) return null;
    if (this.rangeHighlightEnabled && instance.isRangeExtension) return null;
    if (this.animationSourceAtoms && !this.animationSourceAtoms.has(instance.sourceAtom)) {
      return null;
    }
    return this.animationPaths.get(instance.sourceAtom);
  }

  _makePickRing(color, radius) {
    const outerRadius = radius * 1.5;
    const geometry = new THREE.RingGeometry(outerRadius * 0.9, outerRadius, 48);
    const material = new THREE.MeshBasicMaterial({
      color,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.9,
      depthTest: true,
      depthWrite: false,
    });
    const marker = new THREE.Mesh(geometry, material);
    marker.quaternion.copy(this.activeCamera.quaternion);
    marker.renderOrder = 11;
    return marker;
  }

  // entries: each is either
  //   {atom: <sourceAtom index>, color} — a ring on that atom (and every displayed
  //     instance sharing the source atom); follows the atom's animated position, so
  //     a highlighted atom stays ringed as the operation plays, or
  //   {position: [x,y,z], color, radius?} — a fixed ring at a world position (e.g.
  //     the destination an atom will land on), which does NOT move with the animation.
  // {instanceId, color} follows only the chosen displayed instance.
  // style: "selection" uses analysis geometry, with an optional role colour.
  // A shared mergeGroup shows only the highest priority at coincident positions.
  setPickMarkers(entries) {
    this.clearPickMarkers();
    let staticKey = -1;
    for (const entry of entries || []) {
      if (entry.position) {
        const marker = entry.style === "selection"
          ? this._makeSelectionRing(entry.radius || 0.5, entry.color)
          : this._makePickRing(entry.color, entry.radius || 0.5);
        marker.userData.pickEntry = entry;
        marker.position.fromArray(entry.position);
        // Negative keys are absent from atomInstances, so setAtomPosition never
        // repositions them — the ring stays put while the animation plays.
        this.pickMarkers.set(staticKey--, marker);
        this.content.add(marker);
        continue;
      }
      for (const [instanceId, instance] of this.atomInstances) {
        if (entry.instanceId !== undefined
          ? instanceId !== Number(entry.instanceId)
          : instance.sourceAtom !== Number(entry.atom)) continue;
        const marker = entry.style === "selection"
          ? this._makeSelectionRing(instance.radius, entry.color)
          : this._makePickRing(entry.color, instance.radius);
        marker.userData.pickEntry = entry;
        marker.userData.pickInstanceId = instanceId;
        marker.position.fromArray(instance.current);
        marker.visible = this.isAtomVisible(instance);
        this.pickMarkers.set(this.pickMarkers.has(instanceId) ? staticKey-- : instanceId, marker);
        this.content.add(marker);
      }
    }
    this.container.dataset.pickMarkerCount = String(this.pickMarkers.size);
    this.render();
  }

  syncState(state, update = {}) {
    this.syncQueue = this.syncQueue
      .catch(() => {})
      .then(() => this.applyState(state, update));
    return this.syncQueue;
  }

  async applyState(state, update = {}) {
    if (this.modelClient && state.view_revision < this.modelClient.currentModelViewState().view_revision) return;
    if (this.modelClient && state.structure_loaded &&
        (state.model_id !== this.modelClient.modelBoundary.active?.model_id || state.structure_revision !== this.modelClient.modelBoundary.active?.structure_revision)) return;
    if (this.modelClient && !state.structure_loaded) {
      this.state = {...state};
      this.playing = false;
      this.playbackStopPending = false;
      this.animationPaths.clear();
      this.clearContent();
      return;
    }
    const previousOperation = this.state.operation_index;
    const structureLayoutChanged = this.state.operation_index !== undefined && (
      state.reload_request_id !== this.state.reload_request_id
      || state.json_path !== this.state.json_path
      || state.display_mode !== this.state.display_mode
      || state.cell_origin_mode !== this.state.cell_origin_mode
    );
    const boundaryImagesChanged = this.state.operation_index !== undefined
      && state.include_boundary_images !== this.state.include_boundary_images;
    const displayLayoutChanged = structureLayoutChanged || boundaryImagesChanged;
    const atomVisibilityChanged = ["element_hidden", "atom_hidden"]
      .some(key => Object.prototype.hasOwnProperty.call(update, key));
    const atomColorsChanged = ["element_colors", "atom_colors"]
      .some(key => Object.prototype.hasOwnProperty.call(update, key));
    const trajectorySettingChanged = Object.prototype.hasOwnProperty.call(update, "show_trajectories");
    if (state.operation_index !== previousOperation || displayLayoutChanged
        || state.active_mode !== this.state.active_mode) {
      this.setOperationViewDirection(null);
    }
    this.state = {...state};
    this.setBackgroundMode(state.background_mode);
    this.setLegendVisible(state.legend_visible);
    if (displayLayoutChanged || atomVisibilityChanged || update.structure_reload) {
      await this.refresh(!structureLayoutChanged && (atomVisibilityChanged || boundaryImagesChanged), update.modelExchangePayload);
      if (state.active_mode === "custom") {
        this.loadCustomSymmetryElements(state.custom_op_result);
        this.customSegmentIndex = null;
        this.updateCustomSequenceElements();
      }
    } else if (atomColorsChanged) {
      await this.refreshAtomColors();
    }
    this.updateAtomSelectionHighlight();
    this.setProjection(state.projection_mode);
    const operationChanged = Number(state.operation_index) !== Number(previousOperation);
    const customRequest = state.custom_op_animate || null;
    if (state.active_mode === "custom" && !customRequest) {
      this.setOperationViewDirection(null);
    }
    const customAnimationChanged = state.active_mode === "custom"
      && customRequest?.animate_id !== this.customAnimationId;
    // Editing clears the prepared animation, including an earlier Custom path.
    if (state.active_mode === "custom" && !customRequest
        && (update.clear_custom_check || this.animationOperationIndex !== null || this.customAnimationId !== null)) {
      this.pathGeneration += 1;
      this.animationPaths = new Map();
      this.animationOperationIndex = null;
      this.customAnimationId = null;
      this.customRepresentativePath = null;
      this.customSegmentElements = [];
      this.customSegmentBoundaries = [];
      this.customSegmentIndex = null;
      this.applicationBoundaries = null;
      this.clearSymmetryElements();
      this.clearTargetMarkers();
      this.clearTrajectoryLines();
      this.clearStartMarkers();
      this.animationBreakpoints = [0, 1];
      window.dispatchEvent(new CustomEvent("symmetry-animation-breakpoints", {
        detail: {viewId: this.container.id, breakpoints: this.animationBreakpoints},
      }));
    }
    const pathOptionsChanged = operationChanged || atomVisibilityChanged || [
      "scope",
      "selected_atoms",
      "improper_mode",
      "display_mode",
      "cell_origin_mode",
      "include_boundary_images",
      "structure_reload",
      "operation_repetitions",
    ].some(key => Object.prototype.hasOwnProperty.call(update, key));
    const customPathOptionsChanged = state.active_mode === "custom"
      && customRequest
      && (customAnimationChanged || pathOptionsChanged);
    let pathsUpdated = false;
    if (customPathOptionsChanged) {
      const generation = ++this.pathGeneration;
      await this.loadCustomAnimationPaths(generation);
      if (generation !== this.pathGeneration) return;
      this.loadCustomSymmetryElements(state.custom_op_result);
      this.resetAnimation();
      this.updateCustomSequenceElements();
      pathsUpdated = true;
    } else if (state.active_mode !== "custom" && (pathOptionsChanged || this.animationOperationIndex === null)) {
      const generation = ++this.pathGeneration;
      await Promise.all([
        this.loadAnimationPaths(Number(state.operation_index), generation),
        this.loadSymmetryElements(Number(state.operation_index), generation),
      ]);
      if (generation !== this.pathGeneration) return;
      this.resetAnimation();
      this.updateCustomSequenceElements();
      pathsUpdated = true;
    }
    if (pathsUpdated || atomVisibilityChanged || trajectorySettingChanged) this.updateTrajectoryLines();
    if (update.reset) {
      this.resetAnimation();
    }
    if (Object.prototype.hasOwnProperty.call(update, "camera_request_id")) {
      this.rotateCamera(update.camera_direction, update.camera_angle);
    }
    if (Object.prototype.hasOwnProperty.call(update, "view_request_id")) {
      this.viewAlongCurrentOperation();
    }
    if (Object.prototype.hasOwnProperty.call(update, "reset_view_request_id")) {
      this.resetCamera();
    }
    if (Object.prototype.hasOwnProperty.call(update, "view_direction_request_id")) {
      this.viewAlongCartesianDirection(state.view_direction_cart, state.indexed_view_center_cart);
    }
    if (Object.prototype.hasOwnProperty.call(update, "view_plane_request_id")) {
      this.viewAlongCartesianDirection(state.view_plane_normal_cart, state.indexed_view_center_cart);
    }
    if (this.recording) return;
    const nextServerPlaying = Boolean(state.playing);
    // A poll issued before a local stop may still say "playing" until the
    // stop request is acknowledged. Only an explicit Play may resume early.
    if (!nextServerPlaying || update.playing === true) this.playbackStopPending = false;
    const resumeAllowed = !this.playbackStopPending;
    const starting = nextServerPlaying && resumeAllowed && !this.serverPlaying;
    if (starting && this.animationProgress >= 1) {
      this.resetAnimation();
    }
    if (starting) this.showStartMarkers();
    if (resumeAllowed) this.serverPlaying = nextServerPlaying;
    this.playing = nextServerPlaying && resumeAllowed && this.animationProgress < 1;
    if (this.playing) {
      this.animationStartedAt = null;
    } else {
      this.animationStartedAt = null;
    }
  }

  async loadAnimationPaths(operationIndex, generation, scope = null) {
    return waitingForView(this.container).run(() => this.loadAnimationPathsReady(operationIndex, generation, scope));
  }

  async loadAnimationPathsReady(operationIndex, generation, scope = null) {
    const boundQuiz = operationIndex === null && this.modelClient && this.container.id === "puzzle-view";
    if (!Number.isInteger(operationIndex) && !boundQuiz) return;
    // An optional scope override lets a caller (the puzzle) force "displayed" so
    // every atom animates regardless of the shared analysis-mode selection.
    const scopeParam = scope ? `&scope=${encodeURIComponent(scope)}` : "";
    const repetitions = scope ? 1 : Number(this.state.operation_repetitions || 1);
    const response = await this.viewFetch(`/api/animation_path?repetitions=${repetitions}${boundQuiz ? "" : `&operation_index=${operationIndex}`}${scopeParam}${this.animationPathQuery || ""}`);
    if (!response.ok) {
      throw new Error(await response.text() || `${response.status} ${response.statusText}`);
    }
    const payload = await response.json();
    if (generation !== this.pathGeneration) return;
    if (this.modelClient && (!payload.compiledPlayback || payload.paths.some(item => item.path.type !== "model_plan"))) throw new Error("missing_model_playback");
    this.animationPaths = new Map(
      (payload.paths || []).map(item => [Number(item.source_atom), payload.compiledPlayback ? {...item.path, compiledPlayback: payload.compiledPlayback} : item.path]),
    );
    const representativePath = this.animationPaths.values().next().value;
    this.applicationBoundaries = payload.application_boundaries || null;
    const breakpoints = representativePath ? viewerBreakpoints(representativePath) : [0, 1];
    this.animationBreakpoints = breakpoints;
    window.dispatchEvent(new CustomEvent("symmetry-animation-breakpoints", {
      detail: {viewId: this.container.id, breakpoints},
    }));
    this.animationOperationIndex = operationIndex;
    this.maximumTravelDistance = Math.max(Number(payload.maximum_travel_distance) || 0, 0);
    // The schedule already derives every stage time from the common speed.
    // Do not impose a minimum on short, non-stationary playback here.
    this.baseAnimationDurationSeconds = Math.max(
      Number(payload.animation_duration_seconds) || STATIONARY_ANIMATION_SECONDS,
      0,
    );
    this.customAnimationId = null;
    this.customRepresentativePath = repetitions > 1 ? representativePath : null;
    this.customSegmentElements = repetitions > 1 ? representativePath?.segment_elements || [] : [];
    this.customSegmentBoundaries = repetitions > 1 && representativePath ? (representativePath.type === "model_plan" ? representativePath.model_segment_boundaries : sequentialSegmentBoundaries(representativePath)) : [];
    this.customSegmentIndex = null;
    this.updateAnimationTargetMarkers();
    this.updateTrajectoryLines();
  }

  async loadCustomAnimationPaths(generation) {
    return waitingForView(this.container).run(() => this.loadCustomAnimationPathsReady(generation));
  }

  async loadCustomAnimationPathsReady(generation) {
    const response = await this.viewFetch("/api/custom_animation_path");
    if (!response.ok) throw new Error(await response.text() || `${response.status} ${response.statusText}`);
    const payload = await response.json();
    if (generation !== this.pathGeneration) return;
    if (this.modelClient && (!payload.compiledPlayback || payload.paths.some(item => item.path.type !== "model_plan"))) throw new Error("missing_model_playback");
    this.animationPaths = new Map(
      (payload.paths || []).map(item => [Number(item.source_atom), payload.compiledPlayback ? {...item.path, compiledPlayback: payload.compiledPlayback} : item.path]),
    );
    const representativePath = this.animationPaths.values().next().value;
    this.animationBreakpoints = representativePath ? viewerBreakpoints(representativePath) : [0, 1];
    window.dispatchEvent(new CustomEvent("symmetry-animation-breakpoints", {
      detail: {viewId: this.container.id, breakpoints: this.animationBreakpoints},
    }));
    this.maximumTravelDistance = Math.max(Number(payload.maximum_travel_distance) || 0, 0);
    this.baseAnimationDurationSeconds = Math.max(
      Number(payload.animation_duration_seconds) || STATIONARY_ANIMATION_SECONDS, 0,
    );
    this.customAnimationId = payload.animate_id;
    this.customRepresentativePath = representativePath || null;
    this.customSegmentElements = representativePath?.segment_elements || [];
    this.customSegmentBoundaries = representativePath ? (representativePath.type === "model_plan" ? representativePath.model_segment_boundaries : sequentialSegmentBoundaries(representativePath)) : [];
    this.customSegmentIndex = null;
    this.animationOperationIndex = null;
  }

  loadCustomSymmetryElements(result) {
    this.clearSymmetryElements();
    const elements = result?.elements || {};
    const span = this.symmetryElementSpan();
    for (const axis of elements.axes || []) this.addAxis(axis, span);
    for (const plane of elements.planes || []) this.addPlane(plane, span);
    for (const center of elements.centers || []) this.addCenter(center, span);
    if ((elements.planes || []).length && Array.isArray(elements.glide_translation_cart)) {
      this.addGlideArrow(elements.planes[0], elements.glide_translation_cart, span);
    }
    this.setOperationViewDirection(result?.view_direction_cart);
    this.operationFocusPoint = null;
    this.render();
  }

  updateCustomSequenceElements() {
    if (!this.customSegmentElements.length || !this.customRepresentativePath) return;
    const index = this.customSegmentBoundaries.findIndex(
      boundary => this.animationProgress <= boundary + 1e-12,
    );
    if (index < 0 || index === this.customSegmentIndex) return;
    this.customSegmentIndex = index;
    const elements = this.customSegmentElements[index] || {};
    this.clearSymmetryElements();
    const span = this.symmetryElementSpan();
    for (const axis of elements.axes || []) this.addAxis(axis, span);
    for (const plane of elements.planes || []) this.addPlane(plane, span);
    for (const center of elements.centers || []) this.addCenter(center, span);
    if ((elements.planes || []).length && Array.isArray(elements.glide_translation_cart)) {
      this.addGlideArrow(elements.planes[0], elements.glide_translation_cart, span);
    }
    this.render();
  }

  async loadSymmetryElements(operationIndex, generation) {
    return waitingForView(this.container).run(() => this.loadSymmetryElementsReady(operationIndex, generation));
  }

  async loadSymmetryElementsReady(operationIndex, generation) {
    if (!Number.isInteger(operationIndex)) return;
    const response = await this.viewFetch(`/api/symmetry_elements?operation_index=${operationIndex}${this.symmetryElementQuery || ""}`);
    if (!response.ok) {
      throw new Error(await response.text() || `${response.status} ${response.statusText}`);
    }
    const payload = await response.json();
    if (generation !== this.pathGeneration) return;
    this.clearSymmetryElements();
    const span = this.symmetryElementSpan();
    for (const axis of payload.axes || []) {
      this.addAxis(axis, span);
      this.addRotationArc(axis, span);
    }
    for (const plane of payload.planes || []) this.addPlane(plane, span);
    for (const center of payload.centers || []) this.addCenter(center, span);
    if ((payload.planes || []).length && Array.isArray(payload.glide_translation_cart)) {
      this.addGlideArrow(payload.planes[0], payload.glide_translation_cart, span);
    }
    this.symmetryOperationIndex = operationIndex;
    this.setOperationViewDirection(payload.view_direction_cart);
    this.operationFocusPoint = Array.isArray(payload.focus_point_cart)
      ? [...payload.focus_point_cart]
      : null;
    this.render();
  }

  rotateCamera(direction, angleDegrees) {
    const angle = THREE.MathUtils.degToRad(Math.max(0, Math.min(Number(angleDegrees) || 0, 360)));
    if (angle <= 1e-10 || !this.controls) return;
    const target = this.controls.target.clone();
    const radius = this.activeCamera.position.clone().sub(target);
    if (radius.lengthSq() <= 1e-12) return;
    const up = this.activeCamera.up.clone().normalize();
    const viewDirection = target.clone().sub(this.activeCamera.position).normalize();
    const screenRight = new THREE.Vector3().crossVectors(viewDirection, up).normalize();
    let axis;
    let signedAngle;
    if (direction === "right") [axis, signedAngle] = [up, angle];
    else if (direction === "left") [axis, signedAngle] = [up, -angle];
    else if (direction === "up") [axis, signedAngle] = [screenRight, -angle];
    else if (direction === "down") [axis, signedAngle] = [screenRight, angle];
    else if (direction === "roll-left") [axis, signedAngle] = [viewDirection, -angle];
    else if (direction === "roll-right") [axis, signedAngle] = [viewDirection, angle];
    else return;
    const rotation = new THREE.Quaternion().setFromAxisAngle(axis, signedAngle);
    this.activeCamera.up.applyQuaternion(rotation).normalize();
    if (!String(direction).startsWith("roll-")) {
      radius.applyQuaternion(rotation);
      this.activeCamera.position.copy(target).add(radius);
    }
    this.activeCamera.lookAt(target);
    this.controls.update();
    this.render();
  }

  setOperationViewDirection(direction) {
    const available = Array.isArray(direction) && direction.length === 3
      && direction.every(Number.isFinite)
      && direction.some(value => Math.abs(value) > 1e-12);
    this.operationViewDirection = available ? [...direction] : null;
    this.container.dispatchEvent(new CustomEvent("symmetry-operation-view-change", {
      detail: {available}, bubbles: true,
    }));
  }

  viewAlongCurrentOperation() {
    this.viewAlongCartesianDirection(this.operationViewDirection, this.operationFocusPoint);
  }

  viewAlongCartesianDirection(directionValues, focusValues = null) {
    if (!Array.isArray(directionValues) || !this.controls) return;
    const direction = new THREE.Vector3(...directionValues);
    if (direction.lengthSq() <= 1e-12) return;
    direction.normalize();
    const focus = Array.isArray(focusValues)
      ? new THREE.Vector3(...focusValues)
      : this.controls.target.clone();
    const currentDistance = this.activeCamera.position.distanceTo(this.controls.target);
    const distance = Math.max(currentDistance, this.sceneSpan() * 1.2, 1);
    const referenceUp = Math.abs(direction.z) < 0.92
      ? new THREE.Vector3(0, 0, 1)
      : new THREE.Vector3(0, 1, 0);
    const screenRight = new THREE.Vector3().crossVectors(direction, referenceUp).normalize();
    const up = new THREE.Vector3().crossVectors(screenRight, direction).normalize();
    this.controls.target.copy(focus);
    this.activeCamera.position.copy(focus).addScaledVector(direction, distance);
    this.activeCamera.up.copy(up);
    this.activeCamera.lookAt(focus);
    this.controls.update();
    this.render();
  }

  resetCamera() {
    const saved = this.defaultCameraState;
    if (!saved || !this.controls) return;
    this.activeCamera.position.copy(saved.position);
    this.activeCamera.up.copy(saved.up);
    this.controls.target.copy(saved.target);
    this.activeCamera.lookAt(saved.target);
    this.activeCamera.updateProjectionMatrix();
    this.controls.update();
    this.resize();
  }

  setBackgroundMode(mode) {
    const resolved = mode === "light" ? "light" : "dark";
    if (resolved === this.backgroundMode) return;
    this.backgroundMode = resolved;
    this.scene.background.set(resolved === "light" ? 0xf4f6f3 : 0x0b0f14);
    this.render();
  }

  setLegendItems(atoms, styles) {
    const styleByAtom = new Map(styles.map(style => [Number(style.index), style]));
    const items = new Map();
    for (const atom of atoms) {
      if (items.has(atom.element)) continue;
      items.set(atom.element, styleByAtom.get(Number(atom.source_atom ?? atom.index))?.color || "#9aa5b1");
    }
    this.legendItems = [...items.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    this.renderLegend();
  }

  setLegendVisible(visible) {
    if (!this.legend) return;
    this.legend.hidden = !visible;
    this.syncCellAxisGuideVisibility();
    this.renderCellAxisGuide();
    this.renderLegend();
  }

  createCellAxisGuide() {
    const svg = (name, attributes = {}) => {
      const element = document.createElementNS("http://www.w3.org/2000/svg", name);
      for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
      return element;
    };
    this.cellAxisGuide = svg("svg", {
      class: "cell-axis-guide", viewBox: "0 0 104 104", role: "img",
      "aria-label": "Cell axis directions", hidden: "",
    });
    this.cellAxisParts = ["a", "b", "c"].map((label, index) => {
      const color = `#${CRYSTAL_AXIS_COLORS[index].toString(16).padStart(6, "0")}`;
      const group = svg("g", {"data-cell-axis": label, transform: "translate(52 52)"});
      const arrow = svg("path", {fill: "none", stroke: color, "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round"});
      const tip = svg("circle", {fill: color});
      const text = svg("text", {fill: color, "text-anchor": "middle", "dominant-baseline": "central"});
      text.textContent = label;
      group.append(arrow, tip, text);
      this.cellAxisGuide.appendChild(group);
      return {group, arrow, tip, text};
    });
    this.container.appendChild(this.cellAxisGuide);
  }

  syncCellAxisGuideVisibility() {
    this.cellAxisGuide.toggleAttribute("hidden", !this.showCoordinateAxes
      || Boolean(this.legend?.hidden) || this.cellAxisDirections.length !== 3);
  }

  renderCellAxisGuide() {
    if (!this.cellAxisGuide || this.cellAxisGuide.hasAttribute("hidden")) return;
    const orientation = this.activeCamera.quaternion.toArray().join(",");
    if (orientation === this.cellAxisOrientation) return;
    this.cellAxisOrientation = orientation;
    const inverse = this.activeCamera.quaternion.clone().invert();
    // Orthographic projection of unit basis vectors: rotation follows the main
    // view, while pan, zoom and lattice lengths cannot change the guide's size.
    const directions = this.cellAxisDirections.map(vector => vector.clone().applyQuaternion(inverse));
    directions.map((vector, index) => ({vector, index}))
      .sort((a, b) => a.vector.z - b.vector.z)
      .forEach(({vector, index}) => {
        const {group, arrow, tip, text} = this.cellAxisParts[index];
        const x = 31 * vector.x;
        const y = -31 * vector.y;
        const length = Math.hypot(x, y);
        const ux = length > 0.001 ? x / length : 0;
        const uy = length > 0.001 ? y / length : -1;
        const head = length > 5
          ? ` M${x - 6 * ux - 3 * uy},${y - 6 * uy + 3 * ux} L${x},${y} L${x - 6 * ux + 3 * uy},${y - 6 * uy - 3 * ux}`
          : "";
        arrow.setAttribute("d", `M0,0 L${x},${y}${head}`);
        tip.setAttribute("cx", x);
        tip.setAttribute("cy", y);
        tip.setAttribute("r", length > 5 ? 0 : 2);
        text.setAttribute("x", length > 5 ? x + 11 * ux : x + 9);
        text.setAttribute("y", length > 5 ? y + 11 * uy : y - 9);
        this.cellAxisGuide.appendChild(group);
      });
  }

  renderLegend() {
    if (!this.legend) return;
    this.legend.replaceChildren();
    for (const [element, color] of this.legendItems) {
      const item = document.createElement("div");
      item.className = "atom-legend-item";
      const swatch = document.createElement("span");
      swatch.className = "atom-legend-swatch";
      swatch.style.backgroundColor = color;
      const label = document.createElement("span");
      label.textContent = element;
      item.append(swatch, label);
      this.legend.appendChild(item);
    }
    this.cellAxisGuide?.style.setProperty("--cell-axis-guide-bottom", `${this.legend.offsetHeight + 20}px`);
  }

  addAxis(axis, span) {
    const point = new THREE.Vector3(...axis.point_cart);
    const direction = new THREE.Vector3(...axis.direction_cart).normalize();
    // Molecules are small and their atoms sit on/near the axis, so extend the
    // axis well past the atom cloud to keep it visible. Keep the original
    // slender radius for both molecules and crystals.
    const radius = span * 0.009;
    const section = this.cellRepresentativeDisplay ? this.clipSymmetryLine(point, direction) : null;
    const length = section ? section[0].distanceTo(section[1])
      : this.isMolecule ? Math.max(span * 1.8, span + 4 * this.maxAtomRadius) : span * 1.45;
    if (length <= 1e-12) return;
    const geometry = new THREE.CylinderGeometry(radius, radius, length, 16);
    const material = new THREE.MeshBasicMaterial({color: SYMMETRY_ELEMENT_COLORS.axis, transparent: true, opacity: 0.92});
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.copy(section ? section[0].clone().add(section[1]).multiplyScalar(0.5) : point);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
    mesh.renderOrder = 3;
    this.addSymmetryObject(mesh);
  }

  // A static curved arrow around an order>2 rotation axis, showing which way it
  // turns. A bare axis line has no handedness, so a Cn (n>2) or Sn operation's
  // two directions look identical without this — e.g. NH3's C3 and C3² both
  // send one H atom to *an*other H, and only the rotation sense tells you which.
  // `axis.rotation_sign` (set server-side, see animation_api.axis_rotation_sign)
  // is null for order<=2 rotations and mirrors/inversions, where there is only
  // one direction to begin with. Swept with THREE's own axis-angle convention,
  // which is the same right-hand rule the server used to compute the sign, so
  // no extra correction for camera or viewing side is needed.
  //
  // Kept deliberately small (a short, thin hint rather than a bold one) — an
  // early version used a wide sweep and a solid 3D cone arrowhead and read as
  // far too prominent next to the axis itself (2026-09-09 follow-up). The
  // arrowhead here is a plain two-line "V", same thin material as the arc,
  // instead of a shaded mesh. Opaque with depthTest disabled (same as
  // addCenter()'s inversion-centre marker below) rather than translucent with
  // normal depth testing: a follow-up report said the translucent version was
  // *harder* to read, and a large structure's atoms can otherwise occlude the
  // indicator entirely since it is drawn at the atoms' own depth.
  addRotationArc(axis, span) {
    if (!axis.rotation_sign) return;
    const point = new THREE.Vector3(...axis.point_cart);
    const direction = new THREE.Vector3(...axis.direction_cart).normalize();
    const helper = Math.abs(direction.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const start = new THREE.Vector3().crossVectors(direction, helper).normalize();
    const radius = this.isMolecule
      ? Math.max(this.maxAtomRadius * 1.3, span * 0.1)
      : span * 0.14;
    const sweep = THREE.MathUtils.degToRad(55);
    const segments = 14;
    const points = [];
    for (let i = 0; i <= segments; i++) {
      const angle = axis.rotation_sign * sweep * (i / segments);
      points.push(start.clone().applyAxisAngle(direction, angle).multiplyScalar(radius).add(point));
    }
    const material = new THREE.LineBasicMaterial({
      color: SYMMETRY_ELEMENT_COLORS.axis, depthTest: false,
    });
    const arc = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), material);
    arc.renderOrder = 4;
    this.addSymmetryObject(arc);

    const tip = points[points.length - 1];
    const back = new THREE.Vector3().subVectors(points[points.length - 2], tip).normalize();
    const headLength = Math.max(radius * 0.3, span * 0.016);
    const headAngle = THREE.MathUtils.degToRad(25);
    const legs = [1, -1].flatMap((sign) => [
      tip,
      back.clone().applyAxisAngle(direction, sign * headAngle).multiplyScalar(headLength).add(tip),
    ]);
    const head = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(legs), material);
    head.renderOrder = 4;
    this.addSymmetryObject(head);
  }

  addPlane(plane, span) {
    const point = new THREE.Vector3(...plane.point_cart);
    const halfWidth = this.isMolecule ? span * 0.65 : span * 0.52;
    const basis1 = new THREE.Vector3(...plane.basis1_cart).normalize().multiplyScalar(halfWidth);
    const basis2 = new THREE.Vector3(...plane.basis2_cart).normalize().multiplyScalar(halfWidth);
    const corners = (this.cellRepresentativeDisplay ? this.clipSymmetryPlane(plane) : null) || [
      point.clone().sub(basis1).sub(basis2),
      point.clone().add(basis1).sub(basis2),
      point.clone().add(basis1).add(basis2),
      point.clone().sub(basis1).add(basis2),
    ];
    const geometry = new THREE.BufferGeometry();
    const triangles = [];
    for (let i = 1; i < corners.length - 1; i += 1) {
      triangles.push(...corners[0].toArray(), ...corners[i].toArray(), ...corners[i + 1].toArray());
    }
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(triangles, 3));
    const material = new THREE.MeshBasicMaterial({
      color: SYMMETRY_ELEMENT_COLORS.planeFill,
      transparent: true,
      opacity: 0.24,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = 1;
    this.addSymmetryObject(mesh);

    const outlineGeometry = new THREE.BufferGeometry().setFromPoints([...corners, corners[0]]);
    const outline = new THREE.Line(
      outlineGeometry,
      new THREE.LineBasicMaterial({color: SYMMETRY_ELEMENT_COLORS.planeOutline, transparent: true, opacity: 0.9}),
    );
    outline.renderOrder = 2;
    this.addSymmetryObject(outline);
  }

  addCenter(center, span) {
    const size = this.isMolecule
      ? Math.max(this.maxAtomRadius * 1.1, span * 0.09)
      : Math.min(...this.renderData.unit_cell.lattice.map(basis => Math.hypot(...basis))) * 0.05;
    const boxGeometry = new THREE.BoxGeometry(size, size, size);
    const geometry = new THREE.EdgesGeometry(boxGeometry);
    boxGeometry.dispose();
    const material = new THREE.LineBasicMaterial({
      color: SYMMETRY_ELEMENT_COLORS.center,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
    });
    const cube = new THREE.LineSegments(geometry, material);
    cube.position.set(...center.point_cart);
    cube.renderOrder = 4;
    this.addSymmetryObject(cube);
  }

  addGlideArrow(plane, translation, span) {
    const vector = new THREE.Vector3(...translation);
    if (vector.lengthSq() < 1e-16) return;
    const direction = vector.normalize();
    const length = span * 0.42;
    const origin = new THREE.Vector3(...plane.point_cart).addScaledVector(direction, -length * 0.5);
    const arrow = new THREE.ArrowHelper(
      direction,
      origin,
      length,
      SYMMETRY_ELEMENT_COLORS.glideArrow,
      Math.max(span * 0.07, 0.12),
      Math.max(span * 0.028, 0.055),
    );
    arrow.line.material.transparent = true;
    arrow.line.material.opacity = 0.58;
    arrow.cone.material.transparent = true;
    arrow.cone.material.opacity = 0.62;
    arrow.renderOrder = 4;
    this.addSymmetryObject(arrow);
  }

  addSymmetryObject(object) {
    this.symmetryObjects.push(object);
    this.content.add(object);
  }

  clearSymmetryElements() {
    for (const object of this.symmetryObjects) {
      this.content.remove(object);
      object.traverse(child => {
        child.geometry?.dispose();
        if (Array.isArray(child.material)) child.material.forEach(material => material.dispose());
        else child.material?.dispose();
      });
    }
    this.symmetryObjects = [];
    this.render();
  }

  clearTargetMarkers() {
    for (const object of this.targetMarkerObjects) {
      this.content.remove(object);
      object.geometry?.dispose();
      object.material?.dispose();
    }
    this.targetMarkerObjects = [];
  }

  updateAnimationTargetMarkers() {
    this.clearTargetMarkers();
    if (!this.showAnimationTargets || !this.showAnimationTargetCopies) {
      this.render();
      return;
    }
    const lattice = this.renderData?.unit_cell?.lattice;
    const shiftIndices = [
      [-1, 0, 0],
      [1, 0, 0],
      [0, -1, 0],
      [0, 1, 0],
      [0, 0, -1],
      [0, 0, 1],
    ];
    const targetShifts = Array.isArray(lattice)
      ? shiftIndices.map(shift => new THREE.Vector3(...[
          shift[0] * lattice[0][0] + shift[1] * lattice[1][0] + shift[2] * lattice[2][0],
          shift[0] * lattice[0][1] + shift[1] * lattice[1][1] + shift[2] * lattice[2][1],
          shift[0] * lattice[0][2] + shift[1] * lattice[1][2] + shift[2] * lattice[2][2],
        ]))
      : [new THREE.Vector3(0, 0, 0)];
    const geometry = new THREE.SphereGeometry(1, 20, 14);
    for (const instance of this.atomInstances.values()) {
      if (!this.isAtomVisible(instance)) continue;
      const materialOptions = {
        color: instance.baseColor,
        transparent: true,
        depthWrite: false,
      };
      const startVector = new THREE.Vector3(...instance.start);
      for (const shift of targetShifts) {
        const marker = new THREE.Mesh(geometry.clone(), new THREE.MeshBasicMaterial({
          ...materialOptions,
          opacity: 0.14,
        }));
        marker.position.copy(startVector).add(shift);
        marker.scale.setScalar(instance.radius * 0.92);
        marker.renderOrder = 1;
        this.targetMarkerObjects.push(marker);
        this.content.add(marker);
      }
    }
    geometry.dispose();
    this.render();
  }

  symmetryCellBasis() {
    return new THREE.Matrix4().makeBasis(...this.renderData.unit_cell.lattice.map(v => new THREE.Vector3(...v)));
  }

  clipSymmetryLine(point, direction) {
    const inverse = this.symmetryCellBasis().invert();
    const p = point.clone().applyMatrix4(inverse);
    const d = point.clone().add(direction).applyMatrix4(inverse).sub(p);
    const minimum = this.referenceCellLower - 0.2, maximum = this.referenceCellLower + 1.2;
    let lo = -Infinity, hi = Infinity;
    for (const key of ["x", "y", "z"]) {
      if (Math.abs(d[key]) < 1e-12) {
        if (p[key] < minimum - 1e-10 || p[key] > maximum + 1e-10) return null;
      } else {
        const a = (minimum - p[key]) / d[key], b = (maximum - p[key]) / d[key];
        lo = Math.max(lo, Math.min(a, b)); hi = Math.min(hi, Math.max(a, b));
      }
    }
    if (hi < lo || !Number.isFinite(lo) || !Number.isFinite(hi)) return null;
    return [point.clone().addScaledVector(direction, lo), point.clone().addScaledVector(direction, hi)];
  }

  clipSymmetryPlane(plane) {
    const basis = this.symmetryCellBasis();
    const lo = this.referenceCellLower - 0.2, hi = this.referenceCellLower + 1.2;
    const vertices = [];
    for (const x of [lo, hi]) for (const y of [lo, hi]) for (const z of [lo, hi]) {
      vertices.push(new THREE.Vector3(x, y, z).applyMatrix4(basis));
    }
    const point = new THREE.Vector3(...plane.point_cart), normal = new THREE.Vector3(...plane.normal_cart).normalize();
    const tolerance = this.symmetryElementSpan() * 1e-10, points = [];
    const add = p => { if (!points.some(q => p.distanceTo(q) <= tolerance)) points.push(p); };
    for (let i = 0; i < 8; i += 1) for (const bit of [1, 2, 4]) {
      const j = i ^ bit;
      if (i >= j) continue;
      const a = vertices[i], b = vertices[j];
      const da = normal.dot(a.clone().sub(point)), db = normal.dot(b.clone().sub(point));
      if (Math.abs(da) <= tolerance) add(a.clone());
      if (Math.abs(db) <= tolerance) add(b.clone());
      if (da * db < 0 && Math.abs(da) > tolerance && Math.abs(db) > tolerance) {
        add(a.clone().lerp(b, da / (da - db)));
      }
    }
    if (points.length < 3) return null;
    const center = points.reduce((sum, p) => sum.add(p), new THREE.Vector3()).multiplyScalar(1 / points.length);
    const u = new THREE.Vector3(...plane.basis1_cart).normalize(), v = new THREE.Vector3(...plane.basis2_cart).normalize();
    const angle = p => Math.atan2(p.clone().sub(center).dot(v), p.clone().sub(center).dot(u));
    return points.sort((a, b) => angle(a) - angle(b));
  }

  symmetryElementSpan() {
    if (this.isMolecule) return this.sceneSpan();
    const vertices = this.renderData.unit_cell.vertices_cart.map(vertex => new THREE.Vector3(...vertex));
    const size = new THREE.Box3().setFromPoints(vertices).getSize(new THREE.Vector3());
    return Math.max(size.x, size.y, size.z);
  }

  sceneSpan() {
    const minimum = this.renderData?.bounds_min || [-1, -1, -1];
    const maximum = this.renderData?.bounds_max || [1, 1, 1];
    const size = new THREE.Vector3(...maximum).sub(new THREE.Vector3(...minimum));
    return Math.max(size.x, size.y, size.z, 1);
  }

  resetAnimation() {
    this.cancelPlayback();
    this.playbackStopPending = false;
    this.animationHoldUntil = null;
    this.animationProgress = 0;
    this.animationStartedAt = null;
    this.lastProgressBucket = -1;
    this.lastPublishedProgressBucket = -1;
    this.clearStartMarkers();
    for (const [instanceId, instance] of this.atomInstances) {
      this.setAtomPosition(instanceId, instance.start);
    }
    this.markInstanceMatricesDirty();
    if (this.baseStatus) this.setStatus(`${this.baseStatus}, animation ready`);
    this.render();
    this.publishAnimationProgress(true);
  }

  setAnimationProgress(progress) {
    if (!this.advancingPlayback) {
      this.cancelPlayback();
      this.animationHoldUntil = null;
      this.playing = false;
      this.serverPlaying = false;
      this.animationStartedAt = null;
    }
    this.animationProgress = Math.max(0, Math.min(Number(progress) || 0, 1));
    if (this.animationProgress > 0) {
      if (!this.startMarkerObjects.length) this.showStartMarkers();
    } else {
      this.clearStartMarkers();
    }
    this.applyAnimationProgress();
    this.setStatus(`${this.baseStatus}, movement ${Math.round(this.animationProgress * 100)}%`);
    this.publishAnimationProgress(!this.advancingPlayback);
    if (!this.advancingPlayback) this.render();
  }

  // Quiz and analysis share updateAnimation and the view's single RAF loop.
  // A local session never writes analysis/server state; it only supplies speed,
  // whole-operation holds and UI callbacks for the same immutable paths.
  playToEnd({speed = 1, durationSeconds = this.baseAnimationDurationSeconds,
      boundaries = [], onProgress = () => {}} = {}) {
    this.cancelPlayback();
    this.setAnimationProgress(0);
    this.showStartMarkers();
    return new Promise((resolve, reject) => {
      this.localPlayback = {resolve, reject, speed, durationSeconds, boundaries,
        onProgress, generation: this.pathGeneration};
      this.animationStartedAt = null;
      this.animationHoldUntil = null;
      this.playing = true;
      this.serverPlaying = false;
      this.requestFrame();
    });
  }

  cancelPlayback(error = null) {
    const session = this.localPlayback;
    if (!session) return;
    this.localPlayback = null;
    this.playing = false;
    this.animationStartedAt = null;
    this.animationHoldUntil = null;
    if (error) session.reject(error);
    else session.resolve();
  }

  applyAnimationProgress() {
    for (const [instanceId, instance] of this.atomInstances) {
      const path = this.animationPathForInstance(instance);
      const applies = pathAppliesToDisplayInstance(path, instance);
      const evaluated = applies
        ? evaluateViewerPath(path, this.animationProgress, instance.start)
        : instance.start;
      const position = evaluated;
      this.setAtomPosition(instanceId, position);
    }
    this.markInstanceMatricesDirty();
    this.updateCustomSequenceElements();
  }

  clearTrajectoryLines() {
    for (const object of this.trajectoryObjects) {
      this.content.remove(object);
      object.dispose?.();
      object.geometry?.dispose();
      object.material?.dispose();
    }
    this.trajectoryObjects = [];
  }

  updateTrajectoryLines() {
    this.clearTrajectoryLines();
    if (!(this.state.show_trajectories || this.showTrajectories) || !this.animationPaths.size) {
      this.render();
      return;
    }
    const positions = [];
    for (const instance of this.atomInstances.values()) {
      if (!this.isAtomVisible(instance)) continue;
      const path = this.animationPathForInstance(instance);
      if (!pathAppliesToDisplayInstance(path, instance)) continue;
      const samples = new Set([0, 1, ...viewerBreakpoints(path, instance.start)]);
      if (pathHasCurvedMotion(path)) {
        for (let index = 1; index < 49; index += 1) samples.add(index / 48);
      }
      const progressValues = [...samples].sort((a, b) => a - b);
      let previous = evaluateViewerPath(path, progressValues[0], instance.start);
      for (const progress of progressValues.slice(1)) {
        const current = evaluateViewerPath(path, progress, instance.start);
        // A stationary interval has no trajectory to draw.
        if (current.every((value, axis) => Math.abs(value - previous[axis]) < 1e-10)) {
          previous = current;
          continue;
        }
        positions.push(...previous, ...current);
        previous = current;
      }
    }
    if (!positions.length) {
      this.render();
      return;
    }
    // Opaque, depth-writing surfaces avoid darker bands at overlaps.
    // Round joints cover the wedges between adjacent cylinders.
    const materialOptions = {color: 0xf6c85f, depthTest: true, depthWrite: true};
    const count = positions.length / 6;
    const lines = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(1, 1, 1, 12),
      new THREE.MeshBasicMaterial(materialOptions), count);
    const joints = new THREE.InstancedMesh(
      new THREE.SphereGeometry(TRAJECTORY_RADIUS, 12, 8),
      new THREE.MeshBasicMaterial(materialOptions), count * 2);
    const up = new THREE.Vector3(0, 1, 0);
    const start = new THREE.Vector3(), end = new THREE.Vector3();
    const direction = new THREE.Vector3(), center = new THREE.Vector3();
    const rotation = new THREE.Quaternion(), scale = new THREE.Vector3();
    const matrix = new THREE.Matrix4();
    for (let index = 0; index < count; index += 1) {
      start.fromArray(positions, index * 6);
      end.fromArray(positions, index * 6 + 3);
      direction.subVectors(end, start);
      const length = direction.length();
      rotation.setFromUnitVectors(up, direction.divideScalar(length));
      center.addVectors(start, end).multiplyScalar(0.5);
      scale.set(TRAJECTORY_RADIUS, length, TRAJECTORY_RADIUS);
      matrix.compose(center, rotation, scale);
      lines.setMatrixAt(index, matrix);
      matrix.makeTranslation(start.x, start.y, start.z);
      joints.setMatrixAt(index * 2, matrix);
      matrix.makeTranslation(end.x, end.y, end.z);
      joints.setMatrixAt(index * 2 + 1, matrix);
    }
    for (const object of [lines, joints]) {
      object.instanceMatrix.needsUpdate = true;
      object.frustumCulled = false;
      object.renderOrder = 4;
      this.trajectoryObjects.push(object);
      this.content.add(object);
    }
    this.render();
  }

  publishAnimationProgress(force = false) {
    const progress = this.animationProgress;
    const bucket = Math.round(progress * 100);
    // 0.996 and 1 share bucket 100, so reaching either end is always sent once;
    // otherwise readouts (e.g. the quiz coordinates) stay just short of the end.
    const reachedEnd = (progress <= 0 || progress >= 1) && progress !== this.lastPublishedProgress;
    if (!force && bucket === this.lastPublishedProgressBucket && !reachedEnd) return;
    this.lastPublishedProgressBucket = bucket;
    this.lastPublishedProgress = progress;
    window.dispatchEvent(new CustomEvent("symmetry-animation-progress-update", {
      detail: {viewId: this.container.id, progress: this.animationProgress},
    }));
  }

  showStartMarkers() {
    this.clearStartMarkers();
    for (const instance of this.atomInstances.values()) {
      if (!this.isAtomVisible(instance)) continue;
      const path = this.animationPathForInstance(instance);
      if (!pathAppliesToDisplayInstance(path, instance)) continue;
      const geometry = new THREE.SphereGeometry(instance.radius * 0.98, 20, 12);
      const material = new THREE.MeshBasicMaterial({
        color: 0xf7dc6f,
        transparent: true,
        opacity: 0.3,
        depthWrite: false,
      });
      const marker = new THREE.Mesh(geometry, material);
      marker.position.fromArray(instance.start);
      marker.renderOrder = 2;
      this.startMarkerObjects.push(marker);
      this.content.add(marker);
    }
    this.container.dataset.startMarkerCount = String(this.startMarkerObjects.length);
    this.render();
  }

  clearStartMarkers() {
    for (const marker of this.startMarkerObjects) {
      this.content.remove(marker);
      marker.geometry.dispose();
      marker.material.dispose();
    }
    this.startMarkerObjects = [];
    this.container.dataset.startMarkerCount = "0";
  }

  operationHoldBoundaries() {
    // Segment boundaries describe whole sequence operations, not the internal
    // stages of a rotation/reflection decomposition. Keep the schedule intact.
    if (this.state.active_mode === "custom" && this.customAnimationId != null) {
      return this.customSegmentBoundaries || [];
    }
    const count = Number(this.state.operation_repetitions || 1);
    return count > 1 ? (this.applicationBoundaries
      || Array.from({length: count - 1}, (_, i) => (i + 1) / count)) : [];
  }

  updateAnimation(timestamp) {
    if (!this.playing || !this.animationPaths.size) return false;
    const session = this.localPlayback;
    if (session && session.generation !== this.pathGeneration) {
      this.cancelPlayback();
      return false;
    }
    const previousProgress = this.animationProgress;
    const step = playbackStepAt(timestamp, this.animationStartedAt, this.animationDurationMs(), previousProgress, {
      holdUntil: this.animationHoldUntil,
      boundaries: session ? session.boundaries
        : !this.state.pause_at_breakpoints && !this.recording ? this.operationHoldBoundaries() : [],
    });
    this.animationStartedAt = step.startedAt;
    this.animationHoldUntil = step.holdUntil;
    if (step.waiting && !session) return false;
    this.animationProgress = step.progress;
    // Recording must run through every boundary without waiting for UI input.
    if (!session && this.state.pause_at_breakpoints && !this.recording) {
      const boundary = this.animationBreakpoints.find(value => (
        value > previousProgress + 1e-9 && value < 1 - 1e-9 && value <= this.animationProgress + 1e-9
      ));
      if (boundary !== undefined) {
        this.animationProgress = boundary;
        this.playing = false;
        this.playbackStopPending = Boolean(this.modelClient);
        this.animationStartedAt = null;
        window.dispatchEvent(new CustomEvent("symmetry-animation-breakpoint-pause", {
          detail: {viewId: this.container.id, progress: boundary},
        }));
      }
    }
    try {
      this.advancingPlayback = true;
      this.setAnimationProgress(this.animationProgress);
      session?.onProgress(this.animationProgress);
    } catch (error) {
      if (!session) throw error;
      this.cancelPlayback(error);
      return false;
    } finally {
      this.advancingPlayback = false;
    }
    const progressBucket = Math.floor(this.animationProgress * 20);
    if (progressBucket !== this.lastProgressBucket) {
      this.lastProgressBucket = progressBucket;
      this.setStatus(`${this.baseStatus}, animation ${Math.round(this.animationProgress * 100)}%`);
    }
    if (this.animationProgress >= 1) {
      if (session) {
        this.cancelPlayback();
        return true;
      }
      this.playing = false;
      this.playbackStopPending = Boolean(this.modelClient);
      this.animationStartedAt = null;
      this.setStatus(`${this.baseStatus}, animation complete`);
      window.dispatchEvent(new CustomEvent("symmetry-animation-complete"));
      // Without the legacy PyVista window there is nothing server-side to
      // clear the playing flag on completion, so the Start/Stop button would
      // stay on "Stop". Tell the server ourselves (PyVista handles its own).
      if (this.serverPlaying && !this.state.pyvista_enabled) {
        this.serverPlaying = false;
        if (typeof window.symmetryPostState === "function") {
          window.symmetryPostState({playing: false}).catch(() => {});
        }
      }
    }
    return true;
  }

  animationDurationMs() {
    if (this.localPlayback) return playbackDurationMs(this.localPlayback.durationSeconds, this.localPlayback.speed);
    return playbackDurationMs(this.baseAnimationDurationSeconds, this.state.speed);
  }

  downloadBlob(blob, extension, filename = null) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename ? `${filename}.${extension}` : `${this.defaultDownloadName()}.${extension}`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  defaultDownloadName() {
    // animationOperationIndex is null unless an animation path is loaded, so
    // using it alone saved every recording as "symmetry-op0". The selected
    // operation is what the file actually shows; name it, and the structure
    // too, so exports from a session do not overwrite each other.
    const index = this.state.operation_index ?? this.animationOperationIndex;
    const source = String(this.state.json_path || "").split(/[\\/]/).pop() || "";
    const stem = source.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_-]+/g, "-") || "symmetry";
    return index === null || index === undefined ? stem : `${stem}-op${index}`;
  }

  savePng() {
    this.render();
    this.canvas.toBlob(blob => {
      if (blob) this.downloadBlob(blob, "png");
    }, "image/png");
  }

  async recordGif(filename = null) {
    return waitingForView(this.container).run(() => this.recordGifReady(filename));
  }

  async recordGifReady(filename = null) {
    if (this.recording || !this.animationPaths.size) return;
    this.recording = true;
    const previousProgress = this.animationProgress;
    const durationMs = this.animationDurationMs();
    const frameCount = Math.max(2, Math.min(90, Math.ceil(durationMs / 100) + 1));
    const frameDurationMs = Math.max(20, Math.round(durationMs / (frameCount - 1)));
    const frames = [];
    const recordingIdentity = this.modelClient ? this.modelClient.modelBoundary.request() : {};
    const recordingGeneration = this.pathGeneration;
    const recordingPlayback = this.animationPaths.values().next().value?.compiledPlayback;
    try {
      this.playing = false;
      this.serverPlaying = false;
      this.animationStartedAt = null;
      this.animationProgress = 0;
      this.showStartMarkers();
      for (let index = 0; index < frameCount; index += 1) {
        if (recordingPlayback && recordingGeneration !== this.pathGeneration) throw new Error("GIF recording interrupted: selection or model changed");
        this.animationProgress = index / (frameCount - 1);
        this.applyAnimationProgress();
        this.render();
        await new Promise(resolve => requestAnimationFrame(resolve));
        frames.push(this.canvas.toDataURL("image/png"));
      }
      // Keep the completed structure visible for one second before the GIF loops.
      // The final animation frame already occupies one frame duration.
      const extraEndFrames = Math.min(
        180 - frameCount,
        Math.max(0, Math.ceil(GIF_END_HOLD_MS / frameDurationMs) - 1),
      );
      const finalFrame = frames.at(-1);
      for (let index = 0; index < extraEndFrames; index += 1) frames.push(finalFrame);
      const response = await this.viewFetch("/api/export_gif", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
          ...recordingIdentity,
          ...(recordingPlayback ? {plan_id: recordingPlayback.plan_id, schedule_id: recordingPlayback.schedule_id} : {}),
          ...(recordingPlayback ? {freeze_range_extensions: this.rangeHighlightEnabled ? "1" : "0"} : {}),
          frames,
          frame_duration_ms: frameDurationMs,
        }),
      });
      if (!response.ok) throw new Error(await response.text() || `${response.status} ${response.statusText}`);
      this.downloadBlob(await response.blob(), "gif", filename);
    } catch (error) {
      this.setStatus(`GIF export error: ${error.message}`);
    } finally {
      this.recording = false;
      this.playing = false;
      this.animationProgress = previousProgress;
      this.applyAnimationProgress();
      this.render();
    }
  }

  setAtomPosition(instanceId, position) {
    const instance = this.atomInstances.get(Number(instanceId));
    if (!instance) return;
    this.tempPosition.fromArray(position);
    if (this.isAtomVisible(instance)) this.tempScale.setScalar(instance.radius);
    else this.tempScale.copy(ZERO_SCALE);
    this.tempMatrix.compose(this.tempPosition, this.tempQuaternion, this.tempScale);
    instance.mesh.setMatrixAt(instance.instanceIndex, this.tempMatrix);
    instance.current = [...position];
    const marker = this.selectionMarkers.get(Number(instanceId));
    if (marker) {
      marker.visible = this.isAtomVisible(instance);
      marker.position.fromArray(position);
    }
    const pickMarker = this.pickMarkers.get(Number(instanceId));
    if (pickMarker) {
      pickMarker.visible = this.isAtomVisible(instance);
      pickMarker.position.fromArray(position);
    }
  }

  isAtomVisible(instance) {
    return !this.hiddenElements.has(instance.element);
  }

  setElementVisibility(element, visible) {
    if (!element) return;
    if (visible) this.hiddenElements.delete(element);
    else this.hiddenElements.add(element);
    for (const atom of this.destinationCellAtoms?.children || []) {
      if (atom.userData.element === element) atom.visible = visible;
    }
    for (const [instanceId, instance] of this.atomInstances) {
      if (instance.element === element) this.setAtomPosition(instanceId, instance.current);
    }
    this.markInstanceMatricesDirty();
    this.updateAtomSelectionHighlight();
    this.clearStartMarkers();
    if (this.animationProgress > 0) this.showStartMarkers();
    this.updateAnimationTargetMarkers();
    this.updateTrajectoryLines();
    this.render();
  }

  markInstanceMatricesDirty() {
    for (const mesh of this.instanceMeshes) {
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  resize() {
    const width = Math.max(this.container.clientWidth, 1);
    const height = Math.max(this.canvas.clientHeight, 1);
    this.renderer.setSize(width, height, false);
    this.perspectiveCamera.aspect = width / height;
    this.perspectiveCamera.updateProjectionMatrix();
    const span = this.orthographicSpan || ORTHOGRAPHIC_HEIGHT;
    this.orthographicCamera.left = -span * width / height / 2;
    this.orthographicCamera.right = span * width / height / 2;
    this.orthographicCamera.top = span / 2;
    this.orthographicCamera.bottom = -span / 2;
    this.orthographicCamera.updateProjectionMatrix();
    this.controls?.handleResize();
    this.render();
  }

  render() {
    for (const marker of this.selectionMarkers.values()) {
      marker.quaternion.copy(this.activeCamera.quaternion);
    }
    for (const marker of this.pickMarkers.values()) {
      marker.quaternion.copy(this.activeCamera.quaternion);
      const instance = this.atomInstances.get(marker.userData.pickInstanceId);
      if (instance) {
        marker.position.fromArray(instance.current);
        marker.visible = this.isAtomVisible(instance);
      } else if (marker.userData.pickEntry?.mergeGroup) {
        const anchor = this.atomInstances.get(marker.userData.pickEntry.visibilityInstanceId);
        marker.visible = !anchor || this.isAtomVisible(anchor);
      }
    }
    // Mapping roles can coincide during playback. Keep the highest-priority
    // ring at that world position, and restore the others when they separate.
    const merged = [...this.pickMarkers.values()].filter(m => m.visible && m.userData.pickEntry?.mergeGroup)
      .sort((a, b) => (b.userData.pickEntry.priority || 0) - (a.userData.pickEntry.priority || 0));
    const visible = [];
    for (const marker of merged) {
      const entry = marker.userData.pickEntry;
      marker.visible = !visible.some(other => other.userData.pickEntry.mergeGroup === entry.mergeGroup
        && other.position.distanceToSquared(marker.position) < 1e-10);
      if (marker.visible) visible.push(marker);
    }
    this.renderer.render(this.scene, this.activeCamera);
    this.renderCellAxisGuide();
  }

  animate(timestamp) {
    this.frameHandle = null;
    // A hidden view has nothing to show, and both views exist for the whole
    // session: without this the covered one keeps calling controls.update()
    // sixty times a second behind the overlay.
    if (!this.active) return;
    const animationChanged = this.updateAnimation(timestamp);
    this.controls?.update();
    if (animationChanged) this.render();
    this.requestFrame();
  }

  requestFrame() {
    // Guard the handle: setActive(true) twice, or a resume racing the loop,
    // would otherwise leave two chains running and double the frame rate.
    if (this.frameHandle !== null || !this.active) return;
    this.frameHandle = requestAnimationFrame(this.animate);
  }

  setActive(active) {
    const next = Boolean(active);
    if (this.active === next) return;
    this.active = next;
    if (!next) return;
    // The container was display:none while hidden, so the canvas has to be
    // measured again before the first frame back.
    this.resize();
    this.requestFrame();
  }

  setStatus(message) {
    if (!this.status) return;
    const visible = /(error|failed|unavailable|unsupported)/i.test(String(message));
    this.status.textContent = visible ? message : "";
    this.status.hidden = !visible;
  }
}


async function initialize() {
  const container = document.getElementById("three-view");
  if (!container) return;
  const view = new StaticStructureView(container, {panSpeed: 0.25 * 2 / 3, showMolecularAxes: true});
  window.symmetryThreeView = view;
  function applyModelExchange(bundle) {
    view.pathGeneration += 1;
    view.playing = false;
    view.serverPlaying = false;
    view.animationPaths.clear();
    view.animationOperationIndex = null;
    view.customAnimationId = null;
    view.clearContent();
    view.state = {};
    view.lastStateSignature = `${bundle.state.json_path || ""}|${bundle.state.reload_request_id || 0}`;
    view.syncState(bundle.state, {structure_reload: true, reset: true,
      modelExchangePayload: bundle.render_payload}).catch(error => view.setStatus(String(error)));
  }
  window.addEventListener("symmetry-model-exchange", event => applyModelExchange(event.detail));
  // With --mode puzzle the mode is applied before this module finishes loading,
  // so the entry event has already been and gone; read the mode off the body
  // instead of waiting for one.
  view.setActive(!document.body.classList.contains("in-puzzle"));
  try {
    if (modelViewEnabled) {
      const bundle = await analysisClient.initializeModelView();
      // Bootstrap may have finished before this renderer's module loaded.
      if (!view.lastStateSignature) applyModelExchange(bundle);
      await view.syncQueue;
    } else {
      await view.refresh();
    }
    const stateResponse = await viewFetch("/api/state");
    if (stateResponse.ok) {
      const initialState = await stateResponse.json();
      await view.syncState(initialState);
      view.lastStateSignature = `${initialState.json_path || ""}|${initialState.reload_request_id || 0}`;
    }
  } catch (error) {
    view.setStatus(`3D view error: ${error.message}`);
  }

  let pollInProgress = false;
  setInterval(async () => {
    if (pollInProgress) return;
    // Puzzle mode drives its own view; pause the analysis poll while it is open
    // (the next tick after returning re-syncs via the signature check). One
    // flag now gates both this poll and the render loop.
    if (!view.active) return;
    pollInProgress = true;
    try {
      const response = await viewFetch("/api/state");
      if (!response.ok) return;
      const state = await response.json();
      const signature = `${state.json_path || ""}|${state.reload_request_id || 0}`;
      if (signature !== view.lastStateSignature) {
        await view.refresh();
        await view.syncState(state, {structure_reload: true});
      } else {
        await view.syncState(state);
      }
      view.lastStateSignature = signature;
    } catch (error) {
      view.setStatus(`3D view refresh error: ${error.message}`);
    } finally {
      pollInProgress = false;
    }
  }, 1000);

  window.addEventListener("symmetry-state-update", event => {
    const detail = event.detail || {};
    view.syncState(detail.state || {}, detail.update || {}).catch(error => {
      view.setStatus(`3D animation error: ${error.message}`);
    });
  });
}


initialize().catch(error => {
  const status = document.querySelector("[data-three-status]");
  if (status) {
    status.textContent = `3D view initialization error: ${error.message}`;
    status.hidden = false;
  }
  console.error("Three.js initialization failed", error);
});
