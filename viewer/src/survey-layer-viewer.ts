import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

import {
  buildSurveyLayerModel,
  isSideConnected,
  overlapCountByPixel,
  sideNeighbours,
  toggleConnectedRegion,
  visibleCoverageAtPixel,
  visibleSurveySlots,
  type CoverageCellMembership,
  type SurveyLayerLayoutMode,
  type SurveyLayerModel,
} from "../../src/survey-layer-model";
import type { SurveyFootprint } from "../../src/survey-footprints";
import type { SurveyCard, SurveyFootprintManifest } from "./api";
import { cartesianToRaDec } from "./coordinates";
import {
  buildSphericalCellEdges,
  buildSphericalCellSheetGeometry,
  healpixPixelFromSceneDirection,
  sphericalCellBoundary,
  type SphericalCellSheetGeometryInput,
} from "./spherical-cell-geometry";

export type SurveyLayerInteractionMode = "inspect" | "region";
export type { SurveyLayerLayoutMode };

export interface SurveyLayerSelection {
  kind: "coverage-region";
  nside: number;
  pixels: number[];
  surveyIds: string[];
  releaseIds: string[];
  artifacts: SurveyFootprint[];
  coverageCounts: Array<{ surveyId: string; cellCount: number }>;
  notice?: string;
}

export interface SurveyLayerInspection {
  kind: "coverage-cell";
  nside: number;
  pixel: number;
  surveyIds: string[];
  releaseIds: string[];
  artifacts: SurveyFootprint[];
  pointerRaDeg: number;
  pointerDecDeg: number;
  centerRaDeg: number;
  centerDecDeg: number;
}

export interface SurveyLayerHover extends Omit<SurveyLayerInspection, "kind"> {
  clientX: number;
  clientY: number;
}

export interface SurveyLayerContextMenu {
  clientX: number;
  clientY: number;
  pixel: number;
  locked: boolean;
}

export interface SurveyLayerState {
  nside: number;
  cameraDistance: number;
  cameraPosition: [number, number, number];
  outerRadius: number;
  surveyCount: number;
  releaseCount: number;
  occupiedCellCount: number;
  visibleCellCount: number;
  selectedCellCount: number;
  visibleSurveyIds: string[];
  layoutMode: SurveyLayerLayoutMode;
  interactionMode: SurveyLayerInteractionMode;
  focusedSurveyId: string | null;
  pinnedCoveragePixel: number | null;
  lockedCoveragePixel: number | null;
}

interface CellRecord {
  pixel: number;
}

interface LayerMesh extends THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> {
  userData: {
    surveyId: string;
    records: CellRecord[];
  };
}

interface FragmentTransition {
  root: THREE.Group;
  startedAt: number;
  durationMs: number;
  direction: "in" | "out";
  meshMaterials: THREE.MeshBasicMaterial[];
  lineMaterials: THREE.LineBasicMaterial[];
}

interface ExplodedFragment {
  root: THREE.Group;
  material: THREE.MeshBasicMaterial;
  lineMaterial: THREE.LineBasicMaterial;
  fromScale: number;
}

interface ExplosionTransition {
  startedAt: number;
  durationMs: number;
  direction: "in" | "out";
  fragments: ExplodedFragment[];
}

interface CameraTransition {
  startedAt: number;
  durationMs: number;
  fromCamera: THREE.Vector3;
  toCamera: THREE.Vector3;
  fromTarget: THREE.Vector3;
  toTarget: THREE.Vector3;
}

const BASE_COLOR = new THREE.Color("#168f89");
const OVERLAP_COLOR = new THREE.Color("#b88e22");
const SELECTION_COLOR = new THREE.Color("#f2cf62");
const COVERAGE_OPACITY = 0.17;
const COVERAGE_EDGE_OPACITY = 0.22;
const DIMMED_OPACITY = 0.035;
const DIMMED_EDGE_OPACITY = 0.07;
const EXPLODED_OPACITY = 0.58;
const EXPLODED_LAYER_STEP = 0.18;

function disposeObject(object: THREE.Object3D): void {
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh || child instanceof THREE.Points || child instanceof THREE.LineSegments)) return;
    child.geometry.dispose();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    materials.forEach((material) => material.dispose());
  });
}

function clearGroup(group: THREE.Group): void {
  for (const child of [...group.children]) {
    group.remove(child);
    disposeObject(child);
  }
}

function easeInOut(progress: number): number {
  return progress < 0.5
    ? 4 * progress * progress * progress
    : 1 - ((-2 * progress + 2) ** 3) / 2;
}

function artifactKey(artifact: SurveyFootprint): string {
  return `${artifact.surveyId}:${artifact.releaseId}:${artifact.product}:${artifact.label}`;
}

function displayColor(source: string): THREE.Color {
  const color = new THREE.Color(source);
  const hsl = { h: 0, s: 0, l: 0 };
  color.getHSL(hsl);
  color.setHSL(hsl.h, Math.min(0.92, Math.max(0.68, hsl.s)), 0.32);
  return color;
}

function fragmentMaterial(opacity = COVERAGE_OPACITY): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity,
    side: THREE.DoubleSide,
    depthTest: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
    toneMapped: false,
  });
}

export class SurveyLayerViewer {
  readonly #canvas: HTMLCanvasElement;
  readonly #manifest: SurveyFootprintManifest;
  readonly #scene = new THREE.Scene();
  readonly #camera = new THREE.PerspectiveCamera(48, 1, 0.015, 24);
  readonly #renderer: THREE.WebGLRenderer;
  readonly #controls: OrbitControls;
  readonly #raycaster = new THREE.Raycaster();
  readonly #pointer = new THREE.Vector2();
  readonly #coverageGroup = new THREE.Group();
  readonly #retiredGroup = new THREE.Group();
  readonly #selectionGroup = new THREE.Group();
  readonly #explosionGroup = new THREE.Group();
  readonly #resizeObserver: ResizeObserver;
  readonly #onSelection: (selection: SurveyLayerSelection | null) => void;
  readonly #onHover: (hover: SurveyLayerHover | null) => void;
  readonly #onInspection: (inspection: SurveyLayerInspection | null) => void;
  readonly #onContextMenu: (menu: SurveyLayerContextMenu | null) => void;
  readonly #onStateChange: (state: SurveyLayerState) => void;
  readonly #model: SurveyLayerModel;
  readonly #colorBySurvey = new Map<string, THREE.Color>();
  readonly #selectedPixels = new Set<number>();
  readonly #visibleSurveyIds = new Set<string>();
  readonly #layerMeshes: LayerMesh[] = [];
  readonly #meshBySurvey = new Map<string, LayerMesh>();
  readonly #fragmentTransitions: FragmentTransition[] = [];
  #layoutMode: SurveyLayerLayoutMode = "layers";
  #interactionMode: SurveyLayerInteractionMode = "inspect";
  #focusedSurveyId: string | null = null;
  #pinnedCoveragePixel: number | null = null;
  #lockedCoveragePixel: number | null = null;
  #renderQueued = false;
  #pointerStart: { x: number; y: number } | null = null;
  #interactionMesh: LayerMesh | null = null;
  #cameraTransition: CameraTransition | null = null;
  #explosionTransition: ExplosionTransition | null = null;
  #explodedFragments: ExplodedFragment[] = [];
  #explodedPixel: number | null = null;

  constructor(
    canvas: HTMLCanvasElement,
    manifest: SurveyFootprintManifest,
    surveys: readonly SurveyCard[],
    onSelection: (selection: SurveyLayerSelection | null) => void,
    onHover: (hover: SurveyLayerHover | null) => void,
    onInspection: (inspection: SurveyLayerInspection | null) => void,
    onContextMenu: (menu: SurveyLayerContextMenu | null) => void,
    onStateChange: (state: SurveyLayerState) => void,
  ) {
    this.#canvas = canvas;
    this.#manifest = manifest;
    this.#onSelection = onSelection;
    this.#onHover = onHover;
    this.#onInspection = onInspection;
    this.#onContextMenu = onContextMenu;
    this.#onStateChange = onStateChange;
    this.#model = buildSurveyLayerModel(surveys, manifest);
    surveys.forEach((survey) => this.#colorBySurvey.set(survey.id, displayColor(survey.color)));

    this.#renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    this.#renderer.setClearColor(0x03070a, 1);
    this.#renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.#renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.#renderer.debug.checkShaderErrors = true;
    this.#controls = new OrbitControls(this.#camera, canvas);
    this.#controls.enablePan = false;
    this.#controls.enableDamping = true;
    this.#controls.dampingFactor = 0.07;
    this.#controls.minDistance = this.#outerRadius + 0.18;
    this.#controls.maxDistance = 7.5;
    this.#controls.addEventListener("change", this.#handleControlsChange);
    this.#scene.add(this.#backgroundStars(), this.#coverageGroup, this.#retiredGroup, this.#selectionGroup, this.#explosionGroup);
    this.#canvas.addEventListener("pointerdown", this.#handlePointerDown);
    this.#canvas.addEventListener("pointerup", this.#handlePointerUp);
    this.#canvas.addEventListener("pointermove", this.#handlePointerMove);
    this.#canvas.addEventListener("pointerleave", this.#handlePointerLeave);
    this.#canvas.addEventListener("pointercancel", this.#handlePointerCancel);
    this.#canvas.addEventListener("contextmenu", this.#handleContextMenu);
    window.addEventListener("keydown", this.#handleKeyDown);
    this.#resizeObserver = new ResizeObserver(() => this.#resize());
    this.#resizeObserver.observe(canvas.parentElement ?? canvas);
    this.focusData();
    this.#resize();
  }

  get webglVersion(): string {
    return this.#renderer.capabilities.isWebGL2 ? "WEBGL2" : "WEBGL1";
  }

  get state(): SurveyLayerState {
    const visibleCells = new Set<number>();
    this.#visibleSurveyIds.forEach((surveyId) => {
      this.#model.pixelsBySurvey.get(surveyId)?.forEach((pixel) => visibleCells.add(pixel));
    });
    return {
      nside: this.#manifest.nside,
      cameraDistance: this.#camera.position.length(),
      cameraPosition: [this.#camera.position.x, this.#camera.position.y, this.#camera.position.z],
      outerRadius: this.#outerRadius,
      surveyCount: this.#model.slots.length,
      releaseCount: new Set(this.#manifest.footprints.map((footprint) => footprint.releaseId)).size,
      occupiedCellCount: this.#model.coverageByPixel.size,
      visibleCellCount: visibleCells.size,
      selectedCellCount: this.#selectedPixels.size,
      visibleSurveyIds: [...this.#visibleSurveyIds],
      layoutMode: this.#layoutMode,
      interactionMode: this.#interactionMode,
      focusedSurveyId: this.#focusedSurveyId,
      pinnedCoveragePixel: this.#pinnedCoveragePixel,
      lockedCoveragePixel: this.#lockedCoveragePixel,
    };
  }

  get #outerRadius(): number {
    const slots = visibleSurveySlots(this.#model, this.#visibleSurveyIds, this.#layoutMode);
    const explodedOuter = this.#explodedPixel == null
      ? 1
      : 1 + Math.max(0, this.#visibleSurveyIds.size - 1) * EXPLODED_LAYER_STEP / 2;
    return Math.max(1, explodedOuter, ...slots.map((slot) => slot.displayRadius));
  }

  setVisibleSurveys(surveyIds: Iterable<string>): void {
    const available = new Set(this.#model.slots.filter((slot) => slot.hasFootprint).map((slot) => slot.surveyId));
    const next = new Set([...surveyIds].filter((surveyId) => available.has(surveyId)));
    if (next.size === this.#visibleSurveyIds.size && [...next].every((surveyId) => this.#visibleSurveyIds.has(surveyId))) return;
    this.#visibleSurveyIds.clear();
    this.#model.slots.forEach((slot) => {
      if (next.has(slot.surveyId)) this.#visibleSurveyIds.add(slot.surveyId);
    });
    if (this.#focusedSurveyId && !this.#visibleSurveyIds.has(this.#focusedSurveyId)) this.#focusedSurveyId = null;
    this.#pruneSelection();
    this.#rebuildVisible(this.#lockedCoveragePixel == null);
  }

  setInspectionLocked(pixel: number, locked: boolean): void {
    if (!locked) {
      if (this.#lockedCoveragePixel === pixel) this.#lockedCoveragePixel = null;
      this.#emitState();
      return;
    }
    const membership = visibleCoverageAtPixel(this.#model, pixel, this.#visibleSurveyIds);
    if (!membership) return;
    this.#lockedCoveragePixel = pixel;
    this.#pinnedCoveragePixel = pixel;
    this.#presentInspection(pixel, membership, this.#pixelDirection([pixel]), false);
    this.#emitState();
  }

  clearRegionSelection(): void {
    this.#clearSelection();
  }

  soloSurvey(surveyId: string): void {
    this.setVisibleSurveys([surveyId]);
    this.focusSurvey(surveyId);
  }

  setLayoutMode(mode: SurveyLayerLayoutMode): void {
    if (this.#layoutMode === mode) return;
    this.#layoutMode = mode;
    this.#rebuildVisible(this.#lockedCoveragePixel == null);
  }

  setInteractionMode(mode: SurveyLayerInteractionMode): void {
    if (this.#interactionMode === mode) return;
    this.#interactionMode = mode;
    this.#pinnedCoveragePixel = null;
    this.#lockedCoveragePixel = null;
    this.#clearExplosion(false);
    this.#onInspection(null);
    if (mode === "inspect") this.#clearSelection();
    this.#emitState();
  }

  focusSurvey(surveyId: string): void {
    const pixels = this.#model.pixelsBySurvey.get(surveyId);
    if (!pixels?.length || !this.#visibleSurveyIds.has(surveyId)) return;
    this.#focusedSurveyId = surveyId;
    this.#applyFocus();
    const direction = this.#pixelDirection(pixels);
    const outer = this.#outerRadius;
    const tangent = Math.abs(direction.y) > 0.9
      ? new THREE.Vector3(1, 0, 0)
      : new THREE.Vector3(0, 1, 0).cross(direction).normalize();
    const target = direction.clone().multiplyScalar(outer * 0.16);
    const destination = direction.clone().multiplyScalar(outer * 2.75).addScaledVector(tangent, outer * 0.32);
    this.#startCameraTransition(destination, target, 680);
  }

  reset(): void {
    this.#cameraTransition = null;
    this.#focusedSurveyId = null;
    this.#pinnedCoveragePixel = null;
    this.#selectedPixels.clear();
    this.#clearExplosion(false);
    clearGroup(this.#selectionGroup);
    this.#onHover(null);
    this.#onInspection(null);
    this.#onSelection(null);
    this.#applyFocus();
    this.focusData();
  }

  focusData(): void {
    this.#cameraTransition = null;
    const radius = this.#outerRadius;
    this.#camera.position.set(radius * 1.72, radius * 1.48, radius * 1.56);
    this.#controls.target.set(0, 0, 0);
    this.#controls.enabled = true;
    this.#controls.minDistance = radius + 0.18;
    this.#controls.update();
    this.#emitState();
    this.#requestRender();
  }

  dispose(): void {
    this.#cameraTransition = null;
    this.#resizeObserver.disconnect();
    this.#controls.removeEventListener("change", this.#handleControlsChange);
    this.#controls.dispose();
    this.#canvas.removeEventListener("pointerdown", this.#handlePointerDown);
    this.#canvas.removeEventListener("pointerup", this.#handlePointerUp);
    this.#canvas.removeEventListener("pointermove", this.#handlePointerMove);
    this.#canvas.removeEventListener("pointerleave", this.#handlePointerLeave);
    this.#canvas.removeEventListener("pointercancel", this.#handlePointerCancel);
    this.#canvas.removeEventListener("contextmenu", this.#handleContextMenu);
    window.removeEventListener("keydown", this.#handleKeyDown);
    disposeObject(this.#scene);
    this.#renderer.dispose();
  }

  #rebuildVisible(animated: boolean): void {
    this.#clearExplosion(false);
    if (!animated) {
      this.#fragmentTransitions.length = 0;
      clearGroup(this.#retiredGroup);
    }
    this.#retireCoverage(animated);
    const slots = visibleSurveySlots(this.#model, this.#visibleSurveyIds, this.#layoutMode);
    if (this.#layoutMode === "overlap") this.#buildOverlapLayer(animated);
    else slots.forEach((slot) => this.#buildSurveyLayer(slot.surveyId, slot.displayRadius, animated));
    this.#buildInteractionLayer();
    this.#controls.minDistance = this.#outerRadius + 0.18;
    this.#keepCameraOutside();
    this.#renderSelectionRegion();
    this.#applyFocus();
    if (this.#lockedCoveragePixel != null) {
      const membership = visibleCoverageAtPixel(this.#model, this.#lockedCoveragePixel, this.#visibleSurveyIds);
      if (membership) this.#presentInspection(this.#lockedCoveragePixel, membership, this.#pixelDirection([this.#lockedCoveragePixel]), false);
    }
    this.#emitState();
    this.#requestRender();
  }

  #buildSurveyLayer(surveyId: string, radius: number, animated: boolean): void {
    const pixels = this.#model.pixelsBySurvey.get(surveyId) ?? [];
    if (!pixels.length) return;
    const color = this.#colorBySurvey.get(surveyId) ?? BASE_COLOR;
    const cells = pixels.map((pixel) => this.#cellInput(pixel, radius, color));
    this.#addFragmentLayer(surveyId, pixels, cells, animated);
  }

  #buildOverlapLayer(animated: boolean): void {
    const counts = overlapCountByPixel(this.#model, this.#visibleSurveyIds);
    const pixels = [...counts.keys()].sort((left, right) => left - right);
    const maximum = Math.max(1, ...counts.values());
    const cells = pixels.map((pixel) => {
      const ratio = maximum <= 1 ? 0 : ((counts.get(pixel) ?? 1) - 1) / (maximum - 1);
      const color = BASE_COLOR.clone().lerp(OVERLAP_COLOR, ratio);
      return this.#cellInput(pixel, 1, color);
    });
    if (cells.length) this.#addFragmentLayer("__overlap__", pixels, cells, animated);
  }

  #buildInteractionLayer(): void {
    if (this.#interactionMesh) {
      this.#scene.remove(this.#interactionMesh);
      disposeObject(this.#interactionMesh);
      this.#interactionMesh = null;
    }
    const pixels = [...overlapCountByPixel(this.#model, this.#visibleSurveyIds).keys()].sort((left, right) => left - right);
    if (!pixels.length) return;
    const cells = pixels.map((pixel) => ({
      nside: this.#manifest.nside,
      pixel,
      radius: 1,
      color: BASE_COLOR,
      inset: 0,
    }));
    const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, colorWrite: false, depthWrite: false, toneMapped: false });
    const mesh = new THREE.Mesh(buildSphericalCellSheetGeometry(cells), material) as LayerMesh;
    mesh.userData = { surveyId: "__interaction__", records: pixels.map((pixel) => ({ pixel })) };
    mesh.renderOrder = -1;
    this.#interactionMesh = mesh;
    this.#scene.add(mesh);
  }

  #cellInput(pixel: number, radius: number, color: THREE.Color): SphericalCellSheetGeometryInput {
    return {
      nside: this.#manifest.nside,
      pixel,
      radius,
      color,
      inset: 0.045,
    };
  }

  #addFragmentLayer(surveyId: string, pixels: number[], cells: SphericalCellSheetGeometryInput[], animated: boolean): void {
    const root = new THREE.Group();
    root.scale.setScalar(animated ? 0.94 : 1);
    const material = fragmentMaterial();
    material.opacity = animated ? 0 : COVERAGE_OPACITY;
    const mesh = new THREE.Mesh(buildSphericalCellSheetGeometry(cells), material) as LayerMesh;
    mesh.userData = { surveyId, records: pixels.map((pixel) => ({ pixel })) };
    mesh.renderOrder = 4;
    const lineMaterial = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: animated ? 0 : COVERAGE_EDGE_OPACITY, depthTest: true, depthWrite: false });
    const edges = new THREE.LineSegments(buildSphericalCellEdges(cells), lineMaterial);
    edges.renderOrder = 6;
    root.add(mesh, edges);
    this.#coverageGroup.add(root);
    this.#layerMeshes.push(mesh);
    if (surveyId !== "__overlap__") this.#meshBySurvey.set(surveyId, mesh);
    if (animated) {
      this.#fragmentTransitions.push({
        root,
        startedAt: performance.now(),
        durationMs: 430,
        direction: "in",
        meshMaterials: [material],
        lineMaterials: [lineMaterial],
      });
    }
  }

  #retireCoverage(animated: boolean): void {
    this.#layerMeshes.length = 0;
    this.#meshBySurvey.clear();
    for (const root of [...this.#coverageGroup.children] as THREE.Group[]) {
      this.#coverageGroup.remove(root);
      if (!animated) {
        disposeObject(root);
        continue;
      }
      this.#retiredGroup.add(root);
      const meshMaterials: THREE.MeshBasicMaterial[] = [];
      const lineMaterials: THREE.LineBasicMaterial[] = [];
      root.traverse((child) => {
        if (child instanceof THREE.Mesh && child.material instanceof THREE.MeshBasicMaterial) meshMaterials.push(child.material);
        if (child instanceof THREE.LineSegments && child.material instanceof THREE.LineBasicMaterial) lineMaterials.push(child.material);
      });
      this.#fragmentTransitions.push({
        root,
        startedAt: performance.now(),
        durationMs: 260,
        direction: "out",
        meshMaterials,
        lineMaterials,
      });
    }
  }

  #applyFocus(): void {
    for (const [surveyId, mesh] of this.#meshBySurvey) {
      mesh.material.opacity = this.#explodedPixel != null
        ? DIMMED_OPACITY
        : this.#focusedSurveyId === surveyId ? 0.24 : COVERAGE_OPACITY;
    }
    this.#requestRender();
  }

  #pickCell(event: PointerEvent): { pixel: number; membership: CoverageCellMembership; point: THREE.Vector3 } | null {
    const bounds = this.#canvas.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return null;
    this.#pointer.set(((event.clientX - bounds.left) / bounds.width) * 2 - 1, -((event.clientY - bounds.top) / bounds.height) * 2 + 1);
    this.#raycaster.setFromCamera(this.#pointer, this.#camera);
    // Angular pick on the unit sphere: independent of display-layer insets/radii, so visually covered
    // gaps between inset cells remain selectable and multi-layer shells share one sky grid.
    const point = this.#intersectUnitSphere(this.#raycaster.ray);
    if (!point) return null;
    const pixel = healpixPixelFromSceneDirection(this.#manifest.nside, point);
    const membership = visibleCoverageAtPixel(this.#model, pixel, this.#visibleSurveyIds);
    if (!membership) return null;
    return { pixel, membership, point };
  }

  #intersectUnitSphere(ray: THREE.Ray): THREE.Vector3 | null {
    const origin = ray.origin;
    const direction = ray.direction;
    const a = direction.lengthSq();
    if (a === 0) return null;
    const b = 2 * origin.dot(direction);
    const c = origin.lengthSq() - 1;
    const discriminant = b * b - 4 * a * c;
    if (discriminant < 0) return null;
    const sqrt = Math.sqrt(discriminant);
    const tNear = (-b - sqrt) / (2 * a);
    const tFar = (-b + sqrt) / (2 * a);
    const t = tNear > 1e-5 ? tNear : tFar > 1e-5 ? tFar : null;
    if (t == null) return null;
    return origin.clone().addScaledVector(direction, t);
  }

  #inspect(event: PointerEvent): void {
    const hit = this.#pickCell(event);
    if (!hit) {
      if (this.#lockedCoveragePixel != null) return;
      this.#pinnedCoveragePixel = null;
      this.#clearExplosion(true);
      this.#onInspection(null);
      this.#emitState();
      return;
    }
    if (this.#explodedPixel === hit.pixel) {
      if (this.#lockedCoveragePixel === hit.pixel) return;
      this.#pinnedCoveragePixel = null;
      this.#clearExplosion(true);
      this.#onInspection(null);
      this.#emitState();
      return;
    }
    this.#pinnedCoveragePixel = hit.pixel;
    this.#presentInspection(hit.pixel, hit.membership, hit.point, false);
    this.#emitState();
  }

  #presentInspection(pixel: number, membership: CoverageCellMembership, point: THREE.Vector3, rotateCamera: boolean): void {
    const pointer = cartesianToRaDec(point);
    const center = cartesianToRaDec(this.#pixelDirection([pixel]));
    this.#onInspection({
      kind: "coverage-cell",
      nside: this.#manifest.nside,
      pixel,
      surveyIds: membership.surveyIds,
      releaseIds: membership.releaseIds,
      artifacts: membership.artifacts,
      pointerRaDeg: pointer.raDeg,
      pointerDecDeg: pointer.decDeg,
      centerRaDeg: center.raDeg,
      centerDecDeg: center.decDeg,
    });
    this.#explodeInspection(pixel, membership, rotateCamera);
  }

  #select(event: PointerEvent): void {
    const hit = this.#pickCell(event);
    if (!hit) return;
    const result = toggleConnectedRegion(this.#manifest.nside, this.#selectedPixels, hit.pixel, this.#selectedPixels.size > 0);
    if (!result.ok) {
      this.#emitSelection(result.reason === "not-adjacent"
        ? "只能添加与当前选区共享边界的 HEALPix 区块。"
        : "移除该区块会使选区断开，已保留当前选区。");
      return;
    }
    this.#selectedPixels.clear();
    result.pixels.forEach((pixel) => this.#selectedPixels.add(pixel));
    this.#renderSelectionRegion();
    this.#emitSelection();
  }

  #renderSelectionRegion(): void {
    clearGroup(this.#selectionGroup);
    if (!this.#selectedPixels.size) return;
    const selected = this.#selectedPixels;
    // Sit the highlight just above each visible survey shell so multi-select behaves like
    // single-cell lighting across every covering layer, not a detached exploded stack.
    const slots = visibleSurveySlots(this.#model, this.#visibleSurveyIds, this.#layoutMode)
      .filter((slot) => (this.#model.pixelsBySurvey.get(slot.surveyId) ?? []).some((pixel) => selected.has(pixel)));
    slots.forEach((slot, index) => {
      const surveyPixels = new Set(this.#model.pixelsBySurvey.get(slot.surveyId) ?? []);
      const pixels = [...selected].filter((pixel) => surveyPixels.has(pixel));
      if (!pixels.length) return;
      const baseColor = this.#colorBySurvey.get(slot.surveyId) ?? SELECTION_COLOR;
      const color = baseColor.clone().lerp(SELECTION_COLOR, 0.42);
      const cells = pixels.map((pixel) => ({
        nside: this.#manifest.nside,
        pixel,
        radius: slot.displayRadius + 0.012,
        color,
        inset: 0.01,
      }));
      const material = new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.72,
        side: THREE.DoubleSide,
        depthTest: true,
        depthWrite: false,
        toneMapped: false,
      });
      const mesh = new THREE.Mesh(buildSphericalCellSheetGeometry(cells), material);
      mesh.renderOrder = 30 + index * 2;
      const edgeMaterial = new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 1,
        depthTest: true,
        depthWrite: false,
        toneMapped: false,
      });
      const edges = new THREE.LineSegments(buildSphericalCellEdges(cells), edgeMaterial);
      edges.renderOrder = 31 + index * 2;
      this.#selectionGroup.add(mesh, edges);
    });
    this.#requestRender();
  }

  #emitSelection(notice?: string): void {
    if (!this.#selectedPixels.size) {
      this.#onSelection(null);
      return;
    }
    const surveyIds = new Set<string>();
    const releaseIds = new Set<string>();
    const artifacts = new Map<string, SurveyFootprint>();
    const coverageCounts = new Map<string, number>();
    for (const pixel of this.#selectedPixels) {
      const membership = visibleCoverageAtPixel(this.#model, pixel, this.#visibleSurveyIds);
      if (!membership) continue;
      membership.surveyIds.forEach((surveyId) => surveyIds.add(surveyId));
      membership.surveyIds.forEach((surveyId) => coverageCounts.set(surveyId, (coverageCounts.get(surveyId) ?? 0) + 1));
      membership.releaseIds.forEach((releaseId) => releaseIds.add(releaseId));
      membership.artifacts.forEach((artifact) => artifacts.set(artifactKey(artifact), artifact));
    }
    this.#onSelection({
      kind: "coverage-region",
      nside: this.#manifest.nside,
      pixels: [...this.#selectedPixels].sort((left, right) => left - right),
      surveyIds: [...surveyIds].sort(),
      releaseIds: [...releaseIds].sort(),
      artifacts: [...artifacts.values()].sort((left, right) => artifactKey(left).localeCompare(artifactKey(right))),
      coverageCounts: [...coverageCounts].map(([surveyId, cellCount]) => ({ surveyId, cellCount })).sort((left, right) => left.surveyId.localeCompare(right.surveyId)),
      notice,
    });
    this.#emitState();
  }

  #pruneSelection(): void {
    if (this.#pinnedCoveragePixel != null && this.#lockedCoveragePixel !== this.#pinnedCoveragePixel && !visibleCoverageAtPixel(this.#model, this.#pinnedCoveragePixel, this.#visibleSurveyIds)) {
      this.#pinnedCoveragePixel = null;
      this.#clearExplosion(false);
      this.#onInspection(null);
    }
    if (this.#selectedPixels.size) {
      for (const pixel of [...this.#selectedPixels]) {
        if (!visibleCoverageAtPixel(this.#model, pixel, this.#visibleSurveyIds)) this.#selectedPixels.delete(pixel);
      }
      if (this.#selectedPixels.size > 1 && !isSideConnected(this.#manifest.nside, this.#selectedPixels)) {
        // Keep the largest remaining edge-connected component so hiding a survey cannot leave a split region.
        const components: number[][] = [];
        const remaining = new Set(this.#selectedPixels);
        while (remaining.size) {
          const start = remaining.values().next().value as number;
          const queue = [start];
          const component: number[] = [];
          remaining.delete(start);
          while (queue.length) {
            const pixel = queue.pop()!;
            component.push(pixel);
            for (const neighbour of sideNeighbours(this.#manifest.nside, pixel)) {
              if (!remaining.has(neighbour)) continue;
              remaining.delete(neighbour);
              queue.push(neighbour);
            }
          }
          components.push(component);
        }
        components.sort((left, right) => right.length - left.length || left[0]! - right[0]!);
        this.#selectedPixels.clear();
        (components[0] ?? []).forEach((pixel) => this.#selectedPixels.add(pixel));
      }
    }
    this.#renderSelectionRegion();
    this.#emitSelection();
  }

  #clearSelection(): void {
    this.#selectedPixels.clear();
    clearGroup(this.#selectionGroup);
    this.#onSelection(null);
    this.#emitState();
    this.#requestRender();
  }

  #explodeInspection(pixel: number, membership: CoverageCellMembership, rotateCamera: boolean): void {
    this.#clearExplosion(false);
    this.#explodedPixel = pixel;
    const slots = visibleSurveySlots(this.#model, this.#visibleSurveyIds, this.#layoutMode);
    const surveyIds = this.#model.slots
      .map((slot) => slot.surveyId)
      .filter((surveyId) => membership.surveyIds.includes(surveyId));
    const midpoint = (surveyIds.length - 1) / 2;
    this.#explodedFragments = surveyIds.map((surveyId, index) => {
      const color = this.#colorBySurvey.get(surveyId) ?? BASE_COLOR;
      const targetRadius = 1 + (index - midpoint) * EXPLODED_LAYER_STEP;
      const sourceRadius = slots.find((slot) => slot.surveyId === surveyId)?.displayRadius ?? 1;
      const root = new THREE.Group();
      root.scale.setScalar(sourceRadius / targetRadius);
      const cell = this.#cellInput(pixel, targetRadius, color);
      const material = fragmentMaterial(0);
      const mesh = new THREE.Mesh(buildSphericalCellSheetGeometry([cell]), material);
      mesh.renderOrder = 20 + index * 2;
      const lineMaterial = new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0,
        depthTest: true,
        depthWrite: false,
        toneMapped: false,
      });
      const edges = new THREE.LineSegments(buildSphericalCellEdges([cell]), lineMaterial);
      edges.renderOrder = 21 + index * 2;
      root.add(mesh, edges);
      this.#explosionGroup.add(root);
      return { root, material, lineMaterial, fromScale: sourceRadius / targetRadius };
    });
    this.#coverageGroup.traverse((child) => {
      if (child instanceof THREE.Mesh && child.material instanceof THREE.MeshBasicMaterial) child.material.opacity = DIMMED_OPACITY;
      if (child instanceof THREE.LineSegments && child.material instanceof THREE.LineBasicMaterial) child.material.opacity = DIMMED_EDGE_OPACITY;
    });
    this.#explosionTransition = {
      startedAt: performance.now(),
      durationMs: 620,
      direction: "in",
      fragments: this.#explodedFragments,
    };
    const direction = this.#pixelDirection([pixel]);
    const outer = this.#outerRadius;
    const distance = Math.max(this.#camera.position.length(), outer + 0.18);
    const destination = direction.clone().multiplyScalar(distance);
    this.#controls.minDistance = outer + 0.18;
    if (rotateCamera) this.#startCameraTransition(destination, new THREE.Vector3(0, 0, 0), 620);
    this.#requestRender();
  }

  #clearExplosion(animated: boolean): void {
    if (this.#explodedPixel == null && !this.#explosionGroup.children.length) {
      return;
    }
    this.#explodedPixel = null;
    this.#coverageGroup.traverse((child) => {
      if (child instanceof THREE.Mesh && child.material instanceof THREE.MeshBasicMaterial) child.material.opacity = COVERAGE_OPACITY;
      if (child instanceof THREE.LineSegments && child.material instanceof THREE.LineBasicMaterial) child.material.opacity = COVERAGE_EDGE_OPACITY;
    });
    if (animated && this.#explodedFragments.length) {
      this.#explosionTransition = {
        startedAt: performance.now(),
        durationMs: 360,
        direction: "out",
        fragments: this.#explodedFragments,
      };
    } else {
      this.#explosionTransition = null;
      this.#explodedFragments = [];
      clearGroup(this.#explosionGroup);
    }
    this.#applyFocus();
    this.#requestRender();
  }

  #pixelDirection(pixels: Iterable<number>): THREE.Vector3 {
    const direction = new THREE.Vector3();
    for (const pixel of pixels) {
      const boundary = sphericalCellBoundary(this.#manifest.nside, pixel, 1);
      const center = boundary.reduce((sum, point) => sum.add(point), new THREE.Vector3()).normalize();
      direction.add(center);
    }
    return direction.lengthSq() > 0 ? direction.normalize() : new THREE.Vector3(1, 0, 0);
  }

  #startCameraTransition(destination: THREE.Vector3, target: THREE.Vector3, durationMs: number): void {
    this.#controls.enabled = false;
    this.#cameraTransition = {
      startedAt: performance.now(),
      durationMs,
      fromCamera: this.#camera.position.clone(),
      toCamera: destination,
      fromTarget: this.#controls.target.clone(),
      toTarget: target,
    };
    this.#requestRender();
  }

  #advanceCameraTransition(now: number): void {
    const transition = this.#cameraTransition;
    if (!transition) return;
    const progress = Math.min(1, (now - transition.startedAt) / transition.durationMs);
    const eased = easeInOut(progress);
    this.#camera.position.lerpVectors(transition.fromCamera, transition.toCamera, eased);
    this.#controls.target.lerpVectors(transition.fromTarget, transition.toTarget, eased);
    this.#keepCameraOutside();
    if (progress < 1) return;
    this.#cameraTransition = null;
    this.#controls.enabled = true;
    this.#controls.update();
  }

  #advanceFragmentTransitions(now: number): void {
    for (let index = this.#fragmentTransitions.length - 1; index >= 0; index -= 1) {
      const transition = this.#fragmentTransitions[index]!;
      const progress = Math.min(1, (now - transition.startedAt) / transition.durationMs);
      const eased = easeInOut(progress);
      const opacity = transition.direction === "in" ? eased : 1 - eased;
      transition.root.scale.setScalar(transition.direction === "in" ? THREE.MathUtils.lerp(0.94, 1, eased) : THREE.MathUtils.lerp(1, 0.96, eased));
      const coverageOpacity = this.#explodedPixel == null ? COVERAGE_OPACITY : DIMMED_OPACITY;
      const edgeOpacity = this.#explodedPixel == null ? COVERAGE_EDGE_OPACITY : DIMMED_EDGE_OPACITY;
      transition.meshMaterials.forEach((material) => { material.opacity = opacity * coverageOpacity; });
      transition.lineMaterials.forEach((material) => { material.opacity = opacity * edgeOpacity; });
      if (progress < 1) continue;
      this.#fragmentTransitions.splice(index, 1);
      if (transition.direction === "out") {
        this.#retiredGroup.remove(transition.root);
        disposeObject(transition.root);
      }
    }
  }

  #advanceExplosionTransition(now: number): void {
    const transition = this.#explosionTransition;
    if (!transition) return;
    const progress = Math.min(1, (now - transition.startedAt) / transition.durationMs);
    const eased = easeInOut(progress);
    transition.fragments.forEach((fragment) => {
      const scale = transition.direction === "in"
        ? THREE.MathUtils.lerp(fragment.fromScale, 1, eased)
        : THREE.MathUtils.lerp(1, fragment.fromScale, eased);
      fragment.root.scale.setScalar(scale);
      fragment.material.opacity = (transition.direction === "in" ? eased : 1 - eased) * EXPLODED_OPACITY;
      fragment.lineMaterial.opacity = (transition.direction === "in" ? eased : 1 - eased) * 0.96;
    });
    if (progress < 1) return;
    this.#explosionTransition = null;
    if (transition.direction === "out") {
      this.#explodedFragments = [];
      clearGroup(this.#explosionGroup);
    }
  }

  #backgroundStars(): THREE.Points {
    const positions = new Float32Array(750 * 3);
    for (let index = 0; index < 750; index += 1) {
      const z = 1 - (2 * (index + 0.5)) / 750;
      const radius = Math.sqrt(1 - z * z);
      const phi = index * Math.PI * (3 - Math.sqrt(5));
      positions.set([Math.cos(phi) * radius * 7, z * 7, Math.sin(phi) * radius * 7], index * 3);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    return new THREE.Points(geometry, new THREE.PointsMaterial({ color: 0x71808b, size: 0.006, transparent: true, opacity: 0.28 }));
  }

  readonly #handleControlsChange = (): void => {
    this.#keepCameraOutside();
    this.#emitState();
    this.#requestRender();
  };

  #keepCameraOutside(): void {
    const minimumRadius = this.#outerRadius + 0.18;
    if (this.#camera.position.length() >= minimumRadius) return;
    if (this.#camera.position.lengthSq() === 0) this.#camera.position.set(minimumRadius, 0, 0);
    else this.#camera.position.setLength(minimumRadius);
  }

  readonly #handlePointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    this.#pointerStart = { x: event.clientX, y: event.clientY };
  };

  readonly #handlePointerUp = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    if (!this.#pointerStart) return;
    const distance = Math.hypot(event.clientX - this.#pointerStart.x, event.clientY - this.#pointerStart.y);
    this.#pointerStart = null;
    if (distance >= 5) return;
    if (this.#interactionMode === "region") this.#select(event);
    else this.#inspect(event);
  };

  readonly #handlePointerMove = (event: PointerEvent): void => {
    if (this.#pointerStart && Math.hypot(event.clientX - this.#pointerStart.x, event.clientY - this.#pointerStart.y) >= 5) return;
    const hit = this.#pickCell(event);
    if (!hit) {
      this.#onHover(null);
      return;
    }
    const pointer = cartesianToRaDec(hit.point);
    const center = cartesianToRaDec(this.#pixelDirection([hit.pixel]));
    this.#onHover({
      nside: this.#manifest.nside,
      pixel: hit.pixel,
      surveyIds: hit.membership.surveyIds,
      releaseIds: hit.membership.releaseIds,
      artifacts: hit.membership.artifacts,
      pointerRaDeg: pointer.raDeg,
      pointerDecDeg: pointer.decDeg,
      centerRaDeg: center.raDeg,
      centerDecDeg: center.decDeg,
      clientX: event.clientX,
      clientY: event.clientY,
    });
  };

  readonly #handlePointerLeave = (): void => this.#onHover(null);
  readonly #handlePointerCancel = (): void => { this.#pointerStart = null; };
  readonly #handleContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
    const hit = this.#pickCell(event as PointerEvent);
    this.#onContextMenu(hit ? {
      clientX: event.clientX,
      clientY: event.clientY,
      pixel: hit.pixel,
      locked: this.#lockedCoveragePixel === hit.pixel,
    } : null);
  };
  readonly #handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || this.#explodedPixel == null) return;
    this.#pinnedCoveragePixel = null;
    this.#lockedCoveragePixel = null;
    this.#clearExplosion(true);
    this.#onInspection(null);
    this.#emitState();
  };

  #emitState(): void {
    this.#onStateChange(this.state);
  }

  #resize(): void {
    const bounds = this.#canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(bounds.width));
    const height = Math.max(1, Math.round(bounds.height));
    this.#renderer.setSize(width, height, false);
    this.#renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.#camera.aspect = width / height;
    this.#camera.updateProjectionMatrix();
    this.#requestRender();
  }

  #requestRender(): void {
    if (this.#renderQueued) return;
    this.#renderQueued = true;
    requestAnimationFrame((now) => {
      this.#renderQueued = false;
      this.#advanceCameraTransition(now);
      this.#advanceFragmentTransitions(now);
      this.#advanceExplosionTransition(now);
      const moving = this.#controls.enabled && this.#controls.update();
      this.#keepCameraOutside();
      this.#renderer.render(this.#scene, this.#camera);
      if (moving || this.#cameraTransition || this.#fragmentTransitions.length || this.#explosionTransition) this.#requestRender();
    });
  }
}
