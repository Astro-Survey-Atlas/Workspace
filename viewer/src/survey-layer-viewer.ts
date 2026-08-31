import * as THREE from "three";
import { Healpix } from "healpixjs";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

import {
  buildSurveyLayerModel,
  overlapCountByPixel,
  visibleCoverageAtPixel,
  visibleSurveySlots,
  type CoverageCellMembership,
  type SurveyLayerLayoutMode,
  type SurveyLayerModel,
} from "../../src/survey-layer-model";
import type { SurveyFootprint } from "../../src/survey-footprints";
import type { SurveyCard, SurveyFootprintManifest } from "./api";
import { cartesianToRaDec, raDecToCartesian } from "./coordinates";
import { normalizeLayerOrder, visibleLayerDepths, type LayerDepth } from "./layer-order";
import {
  buildSphericalCellEdges,
  buildSphericalCellVolumeEdges,
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
  assetIds: string[];
  artifacts: SurveyFootprint[];
  coverageCounts: Array<{ surveyId: string; cellCount: number }>;
  assetCoverageCounts: Array<{ assetId: string; cellCount: number }>;
  workspaceLayers: WorkspaceCoverageMembership[];
  centerRaDeg: number;
  centerDecDeg: number;
  angularRadiusDeg: number;
  emptyCellCount: number;
  notice?: string;
}

export interface SurveyLayerInspection {
  kind: "coverage-cell";
  nside: number;
  pixel: number;
  surveyIds: string[];
  releaseIds: string[];
  assetIds: string[];
  workspaceLayers: WorkspaceCoverageMembership[];
  artifacts: SurveyFootprint[];
  pointerRaDeg: number;
  pointerDecDeg: number;
  centerRaDeg: number;
  centerDecDeg: number;
  workspaceAvailable: boolean;
}

export interface SurveyLayerHover extends Omit<SurveyLayerInspection, "kind"> {
  clientX: number;
  clientY: number;
  selectableInRegion: boolean;
}

export interface SurveyLayerContextMenu {
  clientX: number;
  clientY: number;
  nside: number;
  pixels: number[];
  surveyIds: string[];
  releaseIds?: string[];
  assetIds: string[];
}

export interface SurveyLayerOverlapComponent {
  id: string;
  order: number;
  cells: number[];
  sourceIds?: string[];
  areaDeg2?: number;
}

export interface WorkspaceCoverageLayer {
  key?: string;
  layerId?: string;
  assetId?: string;
  assetIds?: string[];
  assetName?: string;
  status?: string;
  surveyId?: string;
  releaseId?: string;
  productId?: string;
  modality?: string;
  coverageRole?: string;
  source?: "connector" | "asset" | "warehouse" | "combined" | "unassigned" | "conflict";
  nativeOrders?: number[];
  availableOrders?: number[];
  maxOrder?: number;
  precision?: "exact" | "estimated" | "entrypoint-only";
  mocStatus?: "pending" | "ready" | "failed" | "unavailable";
  artifactId?: string;
  latestMocStatus?: "pending" | "ready" | "failed" | "unavailable";
  latestArtifactId?: string;
  state?: string;
  message?: string;
  color?: string;
  nside: number;
  pixels: number[];
}

export interface WorkspaceCoverageMembership {
  key: string;
  assetId?: string;
  assetIds: string[];
  assetName?: string;
  status?: string;
  surveyId?: string;
  releaseId?: string;
  productId?: string;
  modality?: string;
  source?: WorkspaceCoverageLayer["source"];
  message?: string;
}

export interface SurveyDrillCell {
  nside: number;
  pixel: number;
  count: number;
  layers: Array<{
    key: string;
    assetId?: string;
    surveyId?: string;
    releaseId?: string;
    product?: string;
    modality?: string;
    label?: string;
    color?: string;
    count: number;
  }>;
}

export interface SurveyLayerDrillEvent {
  nside: number;
  pixel: number;
  additive: boolean;
  doubleClick: boolean;
}

export interface SurveyObjectPoint {
  objectId?: string;
  raDeg: number;
  decDeg: number;
  assetId?: string;
  surveyId?: string;
  releaseId?: string;
  product?: string;
  modality?: string;
  attributes?: Record<string, unknown>;
  label?: string;
  color?: string;
  count?: number;
  overlapCount?: number;
  overlapAssetIds?: string[];
}

export interface SurveyLayerState {
  nside: number;
  cameraDistance: number;
  effectiveFovDeg: number;
  cameraPosition: [number, number, number];
  outerRadius: number;
  surveyCount: number;
  releaseCount: number;
  occupiedCellCount: number;
  visibleCellCount: number;
  selectedCellCount: number;
  selectedPixels: number[];
  selectionAnchor: {
    xRatio: number;
    yRatio: number;
    visible: boolean;
    bounds: { leftRatio: number; rightRatio: number; topRatio: number; bottomRatio: number };
  } | null;
  visibleSurveyIds: string[];
  visibleAssetIds: string[];
  visibleWorkspaceLayerKeys: string[];
  layerOrder: string[];
  layerDepths: LayerDepth[];
  layoutMode: SurveyLayerLayoutMode;
  interactionMode: SurveyLayerInteractionMode;
  focusedSurveyId: string | null;
}

interface CellRecord {
  pixel: number;
}

interface LayerMesh extends THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> {
  userData: {
    layerKey?: string;
    assetId?: string;
    surveyId?: string;
    records: CellRecord[];
    drill?: boolean;
  };
}

type PointerCoordinates = Pick<PointerEvent, "clientX" | "clientY">;

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

interface ExplosionLayerEntry {
  key: string;
  nside: number;
  pixel: number;
  color: THREE.Color;
  sourceRadius: number;
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
const SELECTION_COLOR = new THREE.Color("#9fe7e0");
const SELECTION_EDGE_COLOR = new THREE.Color("#e7fffb");
const WORKSPACE_COLOR = new THREE.Color("#d69b4e");
const COVERAGE_OPACITY = 0.17;
const COVERAGE_EDGE_OPACITY = 0.22;
// Keep surrounding layers subdued while the selected region remains readable.
const DIMMED_OPACITY = 0.075;
const DIMMED_EDGE_OPACITY = 0.12;
const EXPLODED_OPACITY = 0.58;
const EXPLODED_LAYER_STEP = 0.18;
const REGION_INNER_PADDING = 0.045;
const REGION_OUTER_PADDING = 0.065;
const DRILL_RENDER_ORDER = 10_000;
const EXPLOSION_RENDER_ORDER = 11_000;
const SELECTION_RENDER_ORDER = 12_000;
const LABEL_RENDER_ORDER = 14_000;
const OBJECT_RENDER_ORDER = 15_000;

function disposeObject(object: THREE.Object3D): void {
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh || child instanceof THREE.Points || child instanceof THREE.LineSegments || child instanceof THREE.Sprite)) return;
    child.geometry.dispose();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    materials.forEach((material) => {
      if (material instanceof THREE.SpriteMaterial) material.map?.dispose();
      material.dispose();
    });
  });
}

function releaseWebglContext(renderer: THREE.WebGLRenderer): void {
  renderer.getContext().getExtension("WEBGL_lose_context")?.loseContext();
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

function narrativeCameraPose(direction: THREE.Vector3, distance: number, outerRadius: number, tangentRatio: number): { camera: THREE.Vector3; target: THREE.Vector3 } {
  const reference = Math.abs(direction.y) < 0.82
    ? new THREE.Vector3(0, 1, 0)
    : new THREE.Vector3(1, 0, 0);
  const tangent = new THREE.Vector3().crossVectors(reference, direction).normalize();
  const camera = direction.clone().multiplyScalar(distance).addScaledVector(tangent, outerRadius * tangentRatio);
  camera.setLength(distance);
  const target = direction.clone().multiplyScalar(outerRadius * 0.98);
  return { camera, target };
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

export function workspaceAssetColor(key: string): string {
  const palette = ["#f2cf62", "#45d7c6", "#ef8db2", "#9b8cff", "#5caeff", "#f29a62", "#72d88d", "#ed6d70"];
  let hash = 2166136261;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return palette[(hash >>> 0) % palette.length]!;
}

function deterministicWorkspaceColor(key: string): THREE.Color {
  return new THREE.Color(workspaceAssetColor(key));
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

function compactCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`;
  return String(Math.round(value));
}

function shortLayerLabel(value: string): string {
  const normalized = value.replace(/^asset:/, "");
  return normalized.length > 12 ? `${normalized.slice(0, 10)}..` : normalized;
}

function overlapComponentsForPixels(pixels: readonly number[], nside: number): SurveyLayerOverlapComponent[] {
  const pending = new Set(pixels);
  const healpix = new Healpix(nside);
  const result: SurveyLayerOverlapComponent[] = [];
  while (pending.size) {
    const start = pending.values().next().value as number;
    const queue = [start];
    const cells: number[] = [];
    pending.delete(start);
    while (queue.length) {
      const pixel = queue.pop()!;
      cells.push(pixel);
      const neighbours = healpix.neighbours(pixel);
      for (const index of [0, 2, 4, 6]) {
        const neighbour = neighbours[index] ?? -1;
        if (neighbour >= 0 && pending.delete(neighbour)) queue.push(neighbour);
      }
    }
    result.push({ id: `C${String(result.length + 1).padStart(2, "0")}`, order: Math.log2(nside), cells: cells.sort((left, right) => left - right) });
  }
  return result;
}

function countLabelSprite(text: string, position: THREE.Vector3): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 192;
  canvas.height = 64;
  const context = canvas.getContext("2d")!;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "rgba(4, 9, 12, 0.72)";
  context.strokeStyle = "rgba(255, 255, 255, 0.45)";
  context.lineWidth = 2;
  context.beginPath();
  context.roundRect(10, 10, 172, 44, 18);
  context.fill();
  context.stroke();
  context.fillStyle = "#ffffff";
  context.font = "700 24px Inter, Arial, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(text, canvas.width / 2, canvas.height / 2 + 1);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: true, depthWrite: false }));
  sprite.position.copy(position);
  sprite.scale.set(0.15, 0.05, 1);
  sprite.renderOrder = LABEL_RENDER_ORDER;
  return sprite;
}

export class SurveyLayerViewer {
  readonly #canvas: HTMLCanvasElement;
  readonly #manifest: SurveyFootprintManifest;
  readonly #scene = new THREE.Scene();
  readonly #camera = new THREE.PerspectiveCamera(48, 1, 0.015, 24);
  readonly #renderer: THREE.WebGLRenderer;
  readonly #composer: EffectComposer;
  readonly #bloomPass: UnrealBloomPass;
  readonly #starField: THREE.Points;
  readonly #controls: OrbitControls;
  #bloomStrength = 0.4;
  #backgroundColor: number | null = null;
  readonly #raycaster = new THREE.Raycaster();
  readonly #pointer = new THREE.Vector2();
  readonly #coverageGroup = new THREE.Group();
  readonly #workspaceCoverageGroup = new THREE.Group();
  readonly #retiredGroup = new THREE.Group();
  readonly #selectionGroup = new THREE.Group();
  readonly #explosionGroup = new THREE.Group();
  readonly #overlapLabelGroup = new THREE.Group();
  readonly #overlapSelectionGroup = new THREE.Group();
  readonly #drillGroup = new THREE.Group();
  readonly #objectPointGroup = new THREE.Group();
  readonly #resizeObserver: ResizeObserver;
  readonly #onSelection: (selection: SurveyLayerSelection | null) => void;
  readonly #onHover: (hover: SurveyLayerHover | null) => void;
  readonly #onInspection: (inspection: SurveyLayerInspection | null) => void;
  readonly #onStateChange: (state: SurveyLayerState) => void;
  readonly #onContextMenu: (menu: SurveyLayerContextMenu) => void;
  readonly #onObjectPoint?: (point: SurveyObjectPoint) => void;
  readonly #onOverlapComponent?: (component: SurveyLayerOverlapComponent) => void;
  readonly #model: SurveyLayerModel;
  readonly #colorBySurvey = new Map<string, THREE.Color>();
  readonly #selectedPixels = new Set<number>();
  readonly #visibleSurveyIds = new Set<string>();
  readonly #visibleAssetIds = new Set<string>();
  readonly #visibleWorkspaceLayerKeys = new Set<string>();
  readonly #layerMeshes: LayerMesh[] = [];
  readonly #coverageEdgeMaterials: THREE.LineBasicMaterial[] = [];
  readonly #overlapDashMaterials: THREE.LineDashedMaterial[] = [];
  readonly #meshBySurvey = new Map<string, LayerMesh>();
  #workspaceLayers = new Map<string, WorkspaceCoverageLayer>();
  #layerOrder: string[] = [];
  readonly #fragmentTransitions: FragmentTransition[] = [];
  #layoutMode: SurveyLayerLayoutMode = "layers";
  #interactionMode: SurveyLayerInteractionMode = "inspect";
  #focusedSurveyId: string | null = null;
  #renderQueued = false;
  #pointerStart: { x: number; y: number } | null = null;
  #clickTimer: ReturnType<typeof setTimeout> | null = null;
  #interactionMesh: LayerMesh | null = null;
  #cameraTransition: CameraTransition | null = null;
  #selectionCoreMaterial: THREE.LineBasicMaterial | null = null;
  #selectionEdgeMaterial: THREE.LineDashedMaterial | null = null;
  #selectionGlowMaterial: THREE.LineBasicMaterial | null = null;
  #explosionTransition: ExplosionTransition | null = null;
  #explodedFragments: ExplodedFragment[] = [];
  #explodedPixel: number | null = null;
  #explodedNside: number | null = null;
  #drillNside = 16;
  #drillCells = new Map<number, SurveyDrillCell>();
  #drillFocusActive = false;
  #focusedAssetId: string | null = null;
  #overlapMode = false;
  #overlapNside: number | null = null;
  #overlapPixels: number[] | null = null;
  #overlapComponents: SurveyLayerOverlapComponent[] = [];
  #activeOverlapComponentId: string | null = null;

  constructor(
    canvas: HTMLCanvasElement,
    manifest: SurveyFootprintManifest,
    surveys: readonly SurveyCard[],
    onSelection: (selection: SurveyLayerSelection | null) => void,
    onHover: (hover: SurveyLayerHover | null) => void,
    onInspection: (inspection: SurveyLayerInspection | null) => void,
    onContextMenu: (menu: SurveyLayerContextMenu) => void,
    onStateChange: (state: SurveyLayerState) => void,
    onObjectPoint?: (point: SurveyObjectPoint) => void,
    onOverlapComponent?: (component: SurveyLayerOverlapComponent) => void,
  ) {
    this.#canvas = canvas;
    this.#manifest = manifest;
    this.#onSelection = onSelection;
    this.#onHover = onHover;
    this.#onInspection = onInspection;
    this.#onContextMenu = onContextMenu;
    this.#onStateChange = onStateChange;
    this.#onObjectPoint = onObjectPoint;
    this.#onOverlapComponent = onOverlapComponent;
    this.#model = buildSurveyLayerModel(surveys, manifest);
    surveys.forEach((survey) => this.#colorBySurvey.set(survey.id, displayColor(survey.color)));

    this.#renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    this.#renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.#renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.#renderer.debug.checkShaderErrors = true;

    this.#composer = new EffectComposer(this.#renderer);
    this.#composer.addPass(new RenderPass(this.#scene, this.#camera));
    // The high threshold keeps bloom focused on the white selection core.
    this.#bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), this.#bloomStrength, 0.4, 0.85);
    this.#composer.addPass(this.#bloomPass);
    this.#composer.addPass(new OutputPass());

    this.#controls = new OrbitControls(this.#camera, canvas);
    this.#controls.enablePan = false;
    this.#controls.enableDamping = true;
    this.#controls.dampingFactor = 0.07;
    this.#controls.minDistance = 0.002;
    this.#controls.maxDistance = 7.5;
    this.#controls.addEventListener("change", this.#handleControlsChange);
    this.#starField = this.#backgroundStars();
    this.#scene.add(this.#starField, this.#coverageGroup, this.#workspaceCoverageGroup, this.#drillGroup, this.#objectPointGroup, this.#retiredGroup, this.#selectionGroup, this.#explosionGroup, this.#overlapSelectionGroup, this.#overlapLabelGroup);
    this.setTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark");
    this.#canvas.addEventListener("pointerdown", this.#handlePointerDown);
    this.#canvas.addEventListener("pointerup", this.#handlePointerUp);
    this.#canvas.addEventListener("dblclick", this.#handleDoubleClick);
    this.#canvas.addEventListener("contextmenu", this.#handleContextMenu);
    this.#canvas.addEventListener("pointermove", this.#handlePointerMove);
    this.#canvas.addEventListener("pointerleave", this.#handlePointerLeave);
    this.#canvas.addEventListener("pointercancel", this.#handlePointerCancel);
    this.#resizeObserver = new ResizeObserver(() => this.#resize());
    this.#resizeObserver.observe(canvas.parentElement ?? canvas);
    this.focusData();
    this.#resize();
  }

  get webglVersion(): string {
    return this.#renderer.capabilities.isWebGL2 ? "WEBGL2" : "WEBGL1";
  }

  setTheme(theme: "light" | "dark"): void {
    this.#canvas.dataset.theme = theme;
    this.#renderer.setClearColor(this.#backgroundColor ?? (theme === "light" ? 0xaebbc1 : 0x000000), 1);
    (this.#starField.material as THREE.PointsMaterial).color.setHex(theme === "light" ? 0x879ca8 : 0x71808b);
    (this.#starField.material as THREE.PointsMaterial).opacity = theme === "light" ? 0.34 : 0.28;
    this.#requestRender();
  }

  setBackgroundColor(color: string | null): void {
    if (color === null) {
      this.#backgroundColor = null;
      this.setTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark");
      return;
    }
    const parsed = new THREE.Color(color);
    this.#backgroundColor = parsed.getHex();
    this.#renderer.setClearColor(parsed, 1);
    this.#requestRender();
  }

  get state(): SurveyLayerState {
    const visibleCells = new Set<number>();
    this.#visibleSurveyIds.forEach((surveyId) => {
      this.#model.pixelsBySurvey.get(surveyId)?.forEach((pixel) => visibleCells.add(pixel));
    });
    this.#workspaceLayers.forEach((layer) => {
      if (this.#workspaceLayerVisible(layer)) layer.pixels.forEach((pixel) => visibleCells.add(pixel));
    });
    return {
      nside: this.#manifest.nside,
      cameraDistance: this.#camera.position.length(),
      effectiveFovDeg: this.#effectiveSkyFovDeg(),
      cameraPosition: [this.#camera.position.x, this.#camera.position.y, this.#camera.position.z],
      outerRadius: this.#outerRadius,
      surveyCount: this.#model.slots.length,
      releaseCount: new Set(this.#manifest.footprints.map((footprint) => footprint.releaseId)).size,
      occupiedCellCount: new Set([
        ...this.#model.coverageByPixel.keys(),
        ...Array.from(this.#workspaceLayers.values()).filter((layer) => this.#workspaceLayerVisible(layer)).flatMap((layer) => layer.pixels),
      ]).size,
      visibleCellCount: visibleCells.size,
      selectedCellCount: this.#selectedPixels.size,
      selectedPixels: [...this.#selectedPixels].sort((left, right) => left - right),
      selectionAnchor: this.#selectionAnchor(),
      visibleSurveyIds: [...this.#visibleSurveyIds],
      visibleAssetIds: [...this.#visibleAssetIds],
      visibleWorkspaceLayerKeys: [...this.#visibleWorkspaceLayerKeys],
      layerOrder: this.#normalizedLayerOrder(),
      layerDepths: this.#displayDepths(),
      layoutMode: this.#layoutMode,
      interactionMode: this.#interactionMode,
      focusedSurveyId: this.#focusedSurveyId,
    };
  }

  setDrillCells(cells: readonly SurveyDrillCell[], nside: number): void {
    if (!Number.isInteger(nside) || nside < this.#manifest.nside) return;
    this.#drillNside = nside;
    // Keep zero-count children as wireframe cells. They are part of the
    // selected HEALPix subdivision and must remain pickable for the next
    // double-click, even though they do not get a numeric label.
    const visible = cells.filter((cell) => Number.isInteger(cell.pixel) && cell.pixel >= 0 && cell.pixel < 12 * nside ** 2);
    this.#drillCells = new Map(visible.map((cell) => [cell.pixel, cell]));
    clearGroup(this.#drillGroup);
    if (!visible.length) {
      this.#requestRender();
      return;
    }
    const cellsInput = visible.map((cell) => ({
      nside,
      pixel: cell.pixel,
      radius: Math.max(1.006, this.#outerRadius + 0.006),
      color: this.#drillCellColor(cell),
      inset: nside === this.#manifest.nside ? 0.018 : 0.006,
    }));
    const mesh = new THREE.Mesh(buildSphericalCellSheetGeometry(cellsInput), new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: nside === this.#manifest.nside ? 0.2 : 0.3,
      side: THREE.DoubleSide,
      depthTest: true,
      depthWrite: false,
      toneMapped: false,
    })) as LayerMesh;
    mesh.userData = { layerKey: "__drill__", records: visible.map((cell) => ({ pixel: cell.pixel })), drill: true };
    mesh.renderOrder = DRILL_RENDER_ORDER;
    const edges = new THREE.LineSegments(buildSphericalCellEdges(cellsInput), new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.8,
      depthTest: true,
      depthWrite: false,
      toneMapped: false,
    }));
    edges.renderOrder = DRILL_RENDER_ORDER + 1;
    this.#drillGroup.add(mesh, edges);
    // Labels are deliberately sparse. Counts remain available in the inspector;
    // the canvas only annotates a few high-resolution, high-count cells.
    const labelRadius = Math.max(1.012, this.#outerRadius + 0.012);
    const labels = nside >= 64
      ? visible.filter((cell) => cell.count > 0).sort((left, right) => right.count - left.count).slice(0, 8)
      : [];
    labels.forEach((cell) => {
      const layerText = cell.layers
        .filter((layer) => layer.count > 0)
        .map((layer) => `${shortLayerLabel(layer.label ?? (layer.assetId ? "用户资产" : layer.surveyId ? "巡天" : "图层"))}:${compactCount(layer.count)}`)
        .join("  ");
      const label = countLabelSprite(`${compactCount(cell.count)}${layerText ? `  ${layerText}` : ""}`, this.#pixelDirectionAt(nside, [cell.pixel]).multiplyScalar(labelRadius));
      this.#drillGroup.add(label);
    });
    this.#requestRender();
  }

  clearDrillCells(): void {
    this.#drillCells.clear();
    clearGroup(this.#drillGroup);
    this.#requestRender();
  }

  setDrillFocus(active: boolean): void {
    if (this.#drillFocusActive === active) return;
    this.#drillFocusActive = active;
    this.#applyFocus();
  }

  setObjectPoints(points: readonly SurveyObjectPoint[]): void {
    clearGroup(this.#objectPointGroup);
    const valid = points.filter((point) => Number.isFinite(point.raDeg) && Number.isFinite(point.decDeg));
    if (!valid.length) {
      this.#requestRender();
      return;
    }
    const radius = Math.max(1.018, this.#outerRadius + 0.018);
    const positions = new Float32Array(valid.length * 3);
    const colors = new Float32Array(valid.length * 3);
    valid.forEach((point, index) => {
      const position = raDecToCartesian(point.raDeg, point.decDeg, radius);
      positions.set([position.x, position.y, position.z], index * 3);
      const color = point.color
        ? new THREE.Color(point.color)
        : point.assetId
        ? new THREE.Color(workspaceAssetColor(point.assetId))
        : point.surveyId ? this.#colorBySurvey.get(point.surveyId) ?? BASE_COLOR : SELECTION_COLOR;
      colors.set([color.r, color.g, color.b], index * 3);
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const material = new THREE.PointsMaterial({ size: 0.014, sizeAttenuation: true, vertexColors: true, transparent: true, opacity: 0.95, depthTest: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
    const objectCloud = new THREE.Points(geometry, material);
    objectCloud.renderOrder = OBJECT_RENDER_ORDER;
    objectCloud.userData = { objectCount: valid.length, points: valid };
    this.#objectPointGroup.add(objectCloud);
    this.#requestRender();
  }

  clearObjectPoints(): void {
    clearGroup(this.#objectPointGroup);
    this.#requestRender();
  }

  focusDrillCell(nside: number, pixel: number): void {
    const direction = this.#pixelDirectionAt(nside, [pixel]);
    const distance = this.#outerRadius + 0.36;
    const targetRadius = Math.max(0.001, this.#outerRadius - 0.004);
    this.#startCameraTransition(
      direction.clone().multiplyScalar(distance),
      direction.clone().multiplyScalar(targetRadius),
      620,
    );
  }

  focusCell(nside: number, pixel: number): void {
    const direction = this.#pixelDirectionAt(nside, [pixel]);
    const outer = this.#outerRadius;
    const distance = Math.max(outer * 1.55, outer + 0.08);
    const pose = narrativeCameraPose(direction, distance, outer, 0.32);
    this.#startCameraTransition(
      pose.camera,
      pose.target,
      720,
    );
  }

  focusSelection(): void {
    const pixels = [...this.#selectedPixels];
    if (!pixels.length) return;
    if (pixels.length === 1) {
      this.focusCell(this.#manifest.nside, pixels[0]!);
      return;
    }
    const direction = this.#pixelDirection(pixels);
    let angularRadius = 0;
    for (const pixel of pixels) {
      for (const corner of sphericalCellBoundary(this.#manifest.nside, pixel, 1)) {
        angularRadius = Math.max(angularRadius, direction.angleTo(corner));
      }
    }
    const outer = this.#outerRadius;
    const halfFov = Math.max(THREE.MathUtils.degToRad(4), angularRadius * 1.35);
    const fitDistance = outer / Math.tan(Math.min(Math.PI / 3, halfFov * 1.25));
    const distance = THREE.MathUtils.clamp(Math.max(outer * 1.55, fitDistance), outer * 1.55, outer * 2.8);
    const pose = narrativeCameraPose(direction, distance, outer, 0.24);
    this.#startCameraTransition(
      pose.camera,
      pose.target,
      720,
    );
  }

  focusAsset(assetId: string): void {
    const layer = [...this.#workspaceLayers.values()].find((candidate) => this.#workspaceLayerAssetIds(candidate).includes(assetId));
    if (!layer || !this.#visibleAssetIds.has(assetId) || !layer.pixels.length) return;
    this.#focusedAssetId = assetId;
    this.#applyFocus();
    const direction = this.#pixelDirectionAt(layer.nside, layer.pixels);
    this.#startCameraTransition(
      direction.clone().multiplyScalar(this.#outerRadius + 0.36),
      direction.clone().multiplyScalar(Math.max(0.001, this.#outerRadius - 0.004)),
      680,
    );
  }

  get #outerRadius(): number {
    const radii = this.#displayDepths().map((entry) => entry.radius);
    const explodedOuter = this.#explodedPixel == null
      ? 1
      : 1 + Math.max(0, this.#explodedFragments.length - 1) * EXPLODED_LAYER_STEP / 2;
    return Math.max(1, explodedOuter, ...radii);
  }

  #effectiveSkyFovDeg(): number {
    const distance = this.#camera.position.distanceTo(this.#controls.target);
    const halfSpan = Math.atan((distance * Math.tan(THREE.MathUtils.degToRad(this.#camera.fov) / 2)) / Math.max(0.001, this.#outerRadius));
    return Math.max(0.01, Math.min(180, THREE.MathUtils.radToDeg(halfSpan * 2)));
  }

  setVisibleSurveys(surveyIds: Iterable<string>): void {
    const available = new Set(this.#model.slots.filter((slot) => slot.hasFootprint).map((slot) => slot.surveyId));
    this.#workspaceLayers.forEach((layer) => {
      if (!this.#workspaceLayerAssetIds(layer).length && layer.pixels.length) available.add(layer.surveyId ?? "__unassigned__");
    });
    const next = new Set([...surveyIds].filter((surveyId) => available.has(surveyId)));
    if (next.size === this.#visibleSurveyIds.size && [...next].every((surveyId) => this.#visibleSurveyIds.has(surveyId))) return;
    this.#visibleSurveyIds.clear();
    next.forEach((surveyId) => this.#visibleSurveyIds.add(surveyId));
    if (this.#focusedSurveyId && !this.#visibleSurveyIds.has(this.#focusedSurveyId)) this.#focusedSurveyId = null;
    this.#pruneSelection();
    this.#rebuildVisible(true);
  }

  /** Toggle the co-registered overlap presentation used by the Workspace G mode. */
  setOverlapMode(active: boolean): void {
    if (this.#overlapMode === active) return;
    if (active && this.#clickTimer) {
      clearTimeout(this.#clickTimer);
      this.#clickTimer = null;
    }
    this.#overlapMode = active;
    if (active) {
      this.#layoutMode = "overlap";
    } else {
      this.#overlapNside = null;
      this.#overlapPixels = null;
      this.#overlapComponents = [];
      this.#activeOverlapComponentId = null;
      clearGroup(this.#overlapSelectionGroup);
      clearGroup(this.#overlapLabelGroup);
    }
    this.#canvas.dataset.overlapMode = String(active);
    this.#rebuildVisible(true);
  }

  setOverlapCells(nside: number, pixels: readonly number[]): void {
    if (!Number.isInteger(nside) || nside < 1) return;
    this.#overlapNside = nside;
    this.#overlapPixels = [...new Set(pixels)].filter((pixel) => Number.isSafeInteger(pixel) && pixel >= 0).sort((left, right) => left - right);
    if (this.#overlapMode) this.#rebuildVisible(true);
  }

  setOverlapComponents(components: readonly SurveyLayerOverlapComponent[]): void {
    this.#overlapComponents = components
      .filter((component) => Number.isInteger(component.order) && component.order >= 0 && Array.isArray(component.cells) && component.cells.length > 0)
      .map((component) => ({ ...component, cells: [...new Set(component.cells)].sort((left, right) => left - right) }));
    if (!this.#overlapComponents.some((component) => component.id === this.#activeOverlapComponentId)) this.#activeOverlapComponentId = null;
    if (this.#overlapMode) this.#rebuildVisible(true);
  }

  setActiveOverlapComponent(componentId: string | null): void {
    this.#activeOverlapComponentId = componentId;
    clearGroup(this.#overlapSelectionGroup);
    if (this.#overlapMode && componentId) {
      const component = this.#overlapComponents.find((candidate) => candidate.id === componentId);
      if (component) {
        const nside = 2 ** component.order;
        const radius = Math.max(1.025, this.#outerRadius + 0.028);
        const cells = component.cells.map((pixel) => ({ nside, pixel, radius, color: SELECTION_COLOR, inset: 0.008 }));
        const mesh = new THREE.Mesh(buildSphericalCellSheetGeometry(cells), new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.32, side: THREE.DoubleSide, depthTest: false, depthWrite: false, toneMapped: false }));
        mesh.renderOrder = SELECTION_RENDER_ORDER + 2;
        const edges = new THREE.LineSegments(buildSphericalCellEdges(cells), new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false, toneMapped: false }));
        edges.renderOrder = SELECTION_RENDER_ORDER + 3;
        this.#overlapSelectionGroup.add(mesh, edges);
      }
    }
    this.#rebuildOverlapLabels();
    this.#requestRender();
  }

  setVisibleAssets(assetIds: Iterable<string>): void {
    const next = new Set([...assetIds].filter((assetId) => typeof assetId === "string" && assetId.length > 0));
    if (next.size === this.#visibleAssetIds.size && [...next].every((assetId) => this.#visibleAssetIds.has(assetId))) return;
    this.#visibleAssetIds.clear();
    next.forEach((assetId) => this.#visibleAssetIds.add(assetId));
    this.#pruneSelection();
    this.#rebuildVisible(true);
  }

  setVisibleWorkspaceLayerKeys(keys: Iterable<string>): void {
    const next = new Set([...keys].filter((key) => typeof key === "string" && key.length > 0));
    if (next.size === this.#visibleWorkspaceLayerKeys.size && [...next].every((key) => this.#visibleWorkspaceLayerKeys.has(key))) return;
    this.#visibleWorkspaceLayerKeys.clear();
    next.forEach((key) => this.#visibleWorkspaceLayerKeys.add(key));
    this.#pruneSelection();
    this.#rebuildVisible(true);
  }

  setLayerOrder(keys: Iterable<string>): void {
    const next = normalizeLayerOrder(this.#knownLayerKeys(), keys, []);
    if (next.length === this.#layerOrder.length && next.every((key, index) => key === this.#layerOrder[index])) return;
    this.#layerOrder = next;
    this.#rebuildVisible(true);
  }

  setWorkspaceCoverage(layer: WorkspaceCoverageLayer | null): void {
    this.#workspaceLayers.clear();
    if (layer && layer.nside === this.#manifest.nside) {
      const key = this.#workspaceLayerKey(layer);
      const pixels = layer.pixels.filter((pixel) => Number.isInteger(pixel) && pixel >= 0 && pixel < 12 * this.#manifest.nside ** 2);
      this.#workspaceLayers.set(key, { ...layer, key, pixels: [...new Set(pixels)].sort((left, right) => left - right) });
    }
    this.#layerOrder = this.#normalizedLayerOrder();
    this.#rebuildVisible(true);
  }

  setWorkspaceCoverageLayers(layers: readonly WorkspaceCoverageLayer[], nside: number): void {
    this.#workspaceLayers.clear();
    if (nside === this.#manifest.nside) {
      layers.forEach((layer, index) => {
        const key = this.#workspaceLayerKey({ ...layer, key: layer.key ?? `${layer.layerId ?? layer.surveyId ?? "workspace"}:${layer.releaseId ?? ""}:${index}` });
        const pixels = layer.pixels.filter((pixel) => Number.isInteger(pixel) && pixel >= 0 && pixel < 12 * this.#manifest.nside ** 2);
        this.#workspaceLayers.set(key, { ...layer, key, nside, pixels: [...new Set(pixels)].sort((left, right) => left - right) });
      });
    }
    this.#layerOrder = this.#normalizedLayerOrder();
    this.#rebuildVisible(true);
  }

  clearRegionSelection(): void {
    this.#clearSelection();
  }

  setRegionSelection(pixels: Iterable<number>): void {
    const maximum = 12 * this.#manifest.nside ** 2;
    const next = [...new Set(pixels)].filter((pixel) => Number.isInteger(pixel) && pixel >= 0 && pixel < maximum);
    this.#selectedPixels.clear();
    next.forEach((pixel) => this.#selectedPixels.add(pixel));
    this.#renderSelectionRegion();
    this.#emitSelection();
  }

  soloSurvey(surveyId: string): void {
    this.setVisibleSurveys([surveyId]);
    this.focusSurvey(surveyId);
  }

  setLayoutMode(mode: SurveyLayerLayoutMode): void {
    if (this.#layoutMode === mode) return;
    this.#layoutMode = mode;
    this.#rebuildVisible(true);
  }

  setInteractionMode(mode: SurveyLayerInteractionMode): void {
    if (this.#interactionMode === mode) return;
    this.#interactionMode = mode;
    this.#clearExplosion(false);
    this.#onInspection(null);
    if (mode === "inspect") this.#clearSelection();
    this.#emitState();
  }

  focusSurvey(surveyId: string): void {
    const pixels = this.#model.pixelsBySurvey.get(surveyId)?.length
      ? this.#model.pixelsBySurvey.get(surveyId)
      : [...this.#workspaceLayers.values()].filter((layer) => layer.surveyId === surveyId).flatMap((layer) => layer.pixels);
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
    this.focusData();
  }

  clearTransientState(): void {
    this.#cameraTransition = null;
    this.#pointerStart = null;
    if (this.#clickTimer) clearTimeout(this.#clickTimer);
    this.#clickTimer = null;
    this.#focusedSurveyId = null;
    this.#focusedAssetId = null;
    this.#selectedPixels.clear();
    this.#drillFocusActive = false;
    this.#drillCells.clear();
    this.#clearExplosion(false);
    clearGroup(this.#selectionGroup);
    this.#selectionCoreMaterial = null;
    this.#selectionEdgeMaterial = null;
    this.#selectionGlowMaterial = null;
    clearGroup(this.#drillGroup);
    clearGroup(this.#objectPointGroup);
    this.#onHover(null);
    this.#onInspection(null);
    this.#onSelection(null);
    this.#applyFocus();
    this.#emitState();
    this.#requestRender();
  }

  focusData(): void {
    this.#cameraTransition = null;
    const radius = this.#outerRadius;
    this.#camera.position.set(radius * 1.72, radius * 1.48, radius * 1.56);
    this.#controls.target.set(0, 0, 0);
    this.#controls.enabled = true;
    this.#controls.minDistance = 0.002;
    this.#controls.update();
    this.#emitState();
    this.#requestRender();
  }

  dispose(): void {
    this.#cameraTransition = null;
    if (this.#clickTimer) clearTimeout(this.#clickTimer);
    this.#clickTimer = null;
    this.#resizeObserver.disconnect();
    this.#controls.removeEventListener("change", this.#handleControlsChange);
    this.#controls.dispose();
    this.#canvas.removeEventListener("pointerdown", this.#handlePointerDown);
    this.#canvas.removeEventListener("pointerup", this.#handlePointerUp);
    this.#canvas.removeEventListener("dblclick", this.#handleDoubleClick);
    this.#canvas.removeEventListener("contextmenu", this.#handleContextMenu);
    this.#canvas.removeEventListener("pointermove", this.#handlePointerMove);
    this.#canvas.removeEventListener("pointerleave", this.#handlePointerLeave);
    this.#canvas.removeEventListener("pointercancel", this.#handlePointerCancel);
    disposeObject(this.#scene);
    this.#renderer.dispose();
    releaseWebglContext(this.#renderer);
  }

  #rebuildVisible(animated: boolean): void {
    this.#onHover(null);
    this.#clearExplosion(false);
    if (!animated) {
      this.#fragmentTransitions.length = 0;
      clearGroup(this.#retiredGroup);
    }
    this.#retireCoverage(animated);
    const depths = this.#displayDepths();
    const depthByKey = new Map(depths.map((depth) => [depth.key, depth]));
    depths.forEach((depth) => {
      if (!depth.key.startsWith("public-survey:")) return;
      this.#buildSurveyLayer(depth.key.slice("public-survey:".length), depth.radius, animated, depth.renderOrder);
    });
    if (this.#overlapMode) this.#buildOverlapLayer(animated);
    this.#rebuildWorkspaceCoverage(depthByKey);
    this.#buildInteractionLayer();
    this.#controls.minDistance = 0.002;
    this.#keepCameraOutside();
    this.#renderSelectionRegion();
    this.#applyFocus();
    this.#emitState();
    this.#requestRender();
  }

  #buildSurveyLayer(surveyId: string, radius: number, animated: boolean, renderOrder = 4): void {
    const pixels = this.#model.pixelsBySurvey.get(surveyId) ?? [];
    if (!pixels.length) return;
    const color = this.#colorBySurvey.get(surveyId) ?? BASE_COLOR;
    const cells = pixels.map((pixel) => this.#cellInput(pixel, radius, color));
    this.#addFragmentLayer(surveyId, pixels, cells, animated, renderOrder);
  }

  #buildOverlapLayer(animated: boolean): void {
    const counts = overlapCountByPixel(this.#model, this.#visibleSurveyIds);
    const selectedSurveyCount = [...this.#visibleSurveyIds].filter((surveyId) => (this.#model.pixelsBySurvey.get(surveyId)?.length ?? 0) > 0).length;
    const nside = this.#overlapNside ?? this.#manifest.nside;
    const pixels = this.#overlapPixels ?? (selectedSurveyCount > 1 ? [...counts.entries()].filter(([, count]) => count === selectedSurveyCount).map(([pixel]) => pixel).sort((left, right) => left - right) : []);
    const radius = Math.max(1.02, this.#outerRadius + 0.012);
    const cells = pixels.map((pixel) => ({ nside, pixel, radius, color: OVERLAP_COLOR, inset: nside === this.#manifest.nside ? 0.028 : 0.008 }));
    if (cells.length) this.#addFragmentLayer("__overlap__", pixels, cells, animated, SELECTION_RENDER_ORDER - 1);
    this.#rebuildOverlapLabels(nside, pixels, radius);
  }

  #rebuildOverlapLabels(nside = this.#overlapNside ?? this.#manifest.nside, pixels = this.#overlapPixels ?? [], radius = Math.max(1.02, this.#outerRadius + 0.012)): void {
    clearGroup(this.#overlapLabelGroup);
    if (!this.#overlapMode || !pixels.length) return;
    const components = this.#overlapComponents.length && this.#overlapComponents[0]!.order === Math.round(Math.log2(nside))
      ? this.#overlapComponents
      : overlapComponentsForPixels(pixels, nside);
    components.forEach((component) => {
      if (component.id === this.#activeOverlapComponentId) return;
      const label = countLabelSprite(component.id, this.#pixelDirectionAt(nside, component.cells).multiplyScalar(radius + 0.025));
      label.userData = { overlapComponent: component };
      this.#overlapLabelGroup.add(label);
    });
  }

  #buildInteractionLayer(): void {
    if (this.#interactionMesh) {
      this.#scene.remove(this.#interactionMesh);
      disposeObject(this.#interactionMesh);
      this.#interactionMesh = null;
    }
    const pixels = [...new Set([
      ...overlapCountByPixel(this.#model, this.#visibleSurveyIds).keys(),
      ...Array.from(this.#workspaceLayers.values()).filter((layer) => this.#workspaceLayerVisible(layer)).flatMap((layer) => layer.pixels),
    ])].sort((left, right) => left - right);
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

  #rebuildWorkspaceCoverage(depthByKey = new Map(this.#displayDepths().map((depth) => [depth.key, depth]))): void {
    clearGroup(this.#workspaceCoverageGroup);
    this.#workspaceDisplayLayers(depthByKey).forEach(({ layer, radius, color, renderOrder }) => {
      if (!layer.pixels.length) return;
      const cells = layer.pixels.map((pixel) => ({ nside: this.#manifest.nside, pixel, radius, color, inset: 0.018 }));
      const mesh = new THREE.Mesh(buildSphericalCellSheetGeometry(cells), new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.14, side: THREE.DoubleSide, depthTest: true, depthWrite: false, toneMapped: false })) as LayerMesh;
      mesh.userData = {
        layerKey: layer.key,
        assetId: this.#workspaceLayerAssetIds(layer)[0],
        records: layer.pixels.map((pixel) => ({ pixel })),
      };
      mesh.renderOrder = renderOrder;
      const edges = new THREE.LineSegments(buildSphericalCellEdges(cells), new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.68, depthTest: true, depthWrite: false, toneMapped: false }));
      edges.renderOrder = renderOrder + 1;
      this.#workspaceCoverageGroup.add(mesh, edges);
    });
    this.#requestRender();
  }

  #workspaceLayerVisible(layer: WorkspaceCoverageLayer): boolean {
    const assetIds = this.#workspaceLayerAssetIds(layer);
    if (assetIds.length) return assetIds.some((assetId) => this.#visibleAssetIds.has(assetId));
    const key = this.#workspaceLayerKey(layer);
    if (layer.source === "warehouse" || key.startsWith("warehouse:") || key.startsWith("moc:")) {
      return this.#visibleWorkspaceLayerKeys.has(key);
    }
    return this.#visibleSurveyIds.has(layer.surveyId ?? "__unassigned__");
  }

  #workspaceLayerAssetIds(layer: WorkspaceCoverageLayer): string[] {
    return [...new Set([...(layer.assetIds ?? []), ...(layer.assetId ? [layer.assetId] : [])])].sort();
  }

  #workspaceLayerKey(layer: WorkspaceCoverageLayer): string {
    const assetId = this.#workspaceLayerAssetIds(layer)[0];
    if (assetId) return `asset:${assetId}`;
    if (layer.key?.startsWith("warehouse:") || layer.key?.startsWith("moc:")) return layer.key;
    if (layer.source === "warehouse") return `warehouse:${layer.layerId ?? layer.key ?? "layer"}`;
    if (layer.artifactId) return `moc:${layer.artifactId}`;
    if (layer.key) return layer.key;
    if (layer.layerId) return `workspace:${layer.layerId}`;
    if (layer.surveyId) return `workspace:${layer.surveyId}`;
    return "workspace-unassigned";
  }

  #knownLayerKeys(): string[] {
    return [
      ...this.#model.slots.filter((slot) => slot.hasFootprint).map((slot) => `public-survey:${slot.surveyId}`),
      ...new Set([...this.#workspaceLayers.values()].map((layer) => this.#workspaceLayerKey(layer))),
    ];
  }

  #defaultLayerOrder(): string[] {
    return this.#knownLayerKeys();
  }

  #normalizedLayerOrder(): string[] {
    return normalizeLayerOrder(this.#knownLayerKeys(), this.#layerOrder, []);
  }

  #visibleLayerKeys(): string[] {
    const keys: string[] = [];
    this.#model.slots.forEach((slot) => {
      if (slot.hasFootprint && this.#visibleSurveyIds.has(slot.surveyId)) keys.push(`public-survey:${slot.surveyId}`);
    });
    this.#workspaceLayers.forEach((layer) => {
      if (this.#workspaceLayerVisible(layer) && layer.pixels.length) keys.push(this.#workspaceLayerKey(layer));
    });
    return keys;
  }

  #displayDepths(): LayerDepth[] {
    const order = this.#normalizedLayerOrder();
    const visible = this.#visibleLayerKeys();
    return visibleLayerDepths(order, visible, this.#layoutMode);
  }

  #visibleWorkspaceLayerAssetIds(layer: WorkspaceCoverageLayer): string[] {
    return this.#workspaceLayerAssetIds(layer).filter((assetId) => this.#visibleAssetIds.has(assetId));
  }

  #workspaceDisplayLayers(depthByKey = new Map(this.#displayDepths().map((depth) => [depth.key, depth]))): Array<{ layer: WorkspaceCoverageLayer; radius: number; color: THREE.Color; renderOrder: number }> {
    return [...this.#workspaceLayers.values()]
      .filter((layer) => this.#workspaceLayerVisible(layer) && layer.pixels.length)
      .map((layer) => {
      const key = this.#workspaceLayerKey(layer);
      const depth = depthByKey.get(key);
      if (!depth) return null;
      const assetIds = this.#workspaceLayerAssetIds(layer);
      const color = layer.color
        ? new THREE.Color(layer.color)
        : assetIds.length
          ? deterministicWorkspaceColor(assetIds[0]!)
          : layer.surveyId ? this.#colorBySurvey.get(layer.surveyId) ?? WORKSPACE_COLOR : WORKSPACE_COLOR;
      return { layer, radius: depth.radius, color, renderOrder: depth.renderOrder };
    }).filter((entry): entry is { layer: WorkspaceCoverageLayer; radius: number; color: THREE.Color; renderOrder: number } => entry !== null);
  }

  #drillCellColor(cell: SurveyDrillCell): THREE.Color {
    const dominant = [...cell.layers].sort((left, right) => right.count - left.count)[0];
    if (dominant?.color) return new THREE.Color(dominant.color);
    if (dominant?.assetId) return deterministicWorkspaceColor(dominant.assetId);
    if (dominant?.surveyId) return this.#colorBySurvey.get(dominant.surveyId) ?? BASE_COLOR;
    const ratio = Math.min(1, cell.count / Math.max(1, ...[...this.#drillCells.values()].map((candidate) => candidate.count)));
    return BASE_COLOR.clone().lerp(OVERLAP_COLOR, ratio);
  }

  #objectPointAt(event: PointerCoordinates): SurveyObjectPoint | null {
    const intersections = this.#raycaster.intersectObjects([this.#objectPointGroup], true);
    const hit = intersections.find((candidate) => candidate.object instanceof THREE.Points);
    if (!hit || hit.index == null) return null;
    const points = hit.object.userData.points as SurveyObjectPoint[] | undefined;
    return points?.[hit.index] ?? null;
  }

  #workspaceAvailableAt(pixel: number): boolean {
    return [...this.#workspaceLayers.values()].some((layer) => this.#workspaceLayerVisible(layer) && layer.pixels.includes(pixel));
  }

  #workspaceMembershipAt(pixel: number): { surveyIds: string[]; releaseIds: string[]; assetIds: string[]; layers: WorkspaceCoverageMembership[] } {
    const layers = [...this.#workspaceLayers.values()].filter((layer) => this.#workspaceLayerVisible(layer) && layer.pixels.includes(pixel));
    return {
      surveyIds: [...new Set(layers.map((layer) => layer.surveyId).filter((value): value is string => Boolean(value)))].sort(),
      releaseIds: [...new Set(layers.map((layer) => layer.releaseId).filter((value): value is string => Boolean(value)))].sort(),
      assetIds: [...new Set(layers.flatMap((layer) => this.#visibleWorkspaceLayerAssetIds(layer)))].sort(),
      layers: layers.map((layer) => {
        const assetIds = this.#visibleWorkspaceLayerAssetIds(layer);
        return {
          key: layer.key ?? layer.surveyId ?? "__unassigned__",
          assetId: layer.assetId && assetIds.includes(layer.assetId) ? layer.assetId : assetIds.length === 1 ? assetIds[0] : undefined,
          assetIds,
          assetName: layer.assetName,
          status: layer.status,
          surveyId: layer.surveyId,
          releaseId: layer.releaseId,
          productId: layer.productId,
          modality: layer.modality,
          source: layer.source,
          message: layer.message,
        };
      }).sort((left, right) => left.key.localeCompare(right.key)),
    };
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

  #addFragmentLayer(surveyId: string, pixels: number[], cells: SphericalCellSheetGeometryInput[], animated: boolean, renderOrder = 4): void {
    const root = new THREE.Group();
    root.scale.setScalar(animated ? 0.94 : 1);
    const isOverlap = surveyId === "__overlap__";
    const meshOpacity = isOverlap ? 0.86 : COVERAGE_OPACITY;
    const material = fragmentMaterial();
    material.opacity = animated ? 0 : meshOpacity;
    const mesh = new THREE.Mesh(buildSphericalCellSheetGeometry(cells), material) as LayerMesh;
    mesh.userData = { surveyId, records: pixels.map((pixel) => ({ pixel })) };
    mesh.renderOrder = renderOrder;
    const lineMaterials: THREE.LineBasicMaterial[] = [];
    if (isOverlap) {
      const edgeGeometry = buildSphericalCellEdges(cells);
      const glowMaterial = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: animated ? 0 : 0.72, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
      const glow = new THREE.LineSegments(edgeGeometry, glowMaterial);
      glow.renderOrder = renderOrder + 1;
      const dashMaterial = new THREE.LineDashedMaterial({ vertexColors: true, transparent: true, opacity: animated ? 0 : 1, dashSize: 0.04, gapSize: 0.022, depthTest: false, depthWrite: false, toneMapped: false });
      const dash = new THREE.LineSegments(edgeGeometry.clone(), dashMaterial);
      dash.computeLineDistances();
      dash.renderOrder = renderOrder + 2;
      this.#overlapDashMaterials.push(dashMaterial);
      lineMaterials.push(glowMaterial, dashMaterial);
      root.add(mesh, glow, dash);
    } else {
      const lineMaterial = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: animated ? 0 : COVERAGE_EDGE_OPACITY, depthTest: true, depthWrite: false });
      this.#coverageEdgeMaterials.push(lineMaterial);
      const edges = new THREE.LineSegments(buildSphericalCellEdges(cells), lineMaterial);
      edges.renderOrder = renderOrder + 1;
      lineMaterials.push(lineMaterial);
      root.add(mesh, edges);
    }
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
        lineMaterials,
      });
    }
  }

  #retireCoverage(animated: boolean): void {
    this.#layerMeshes.length = 0;
    this.#coverageEdgeMaterials.length = 0;
    this.#overlapDashMaterials.length = 0;
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
      mesh.material.opacity = this.#drillFocusActive || this.#selectedPixels.size > 0 || this.#explodedPixel != null
        ? DIMMED_OPACITY
        : this.#focusedSurveyId === surveyId ? 0.24 : COVERAGE_OPACITY;
    }
    this.#workspaceCoverageGroup.traverse((child) => {
      if (!(child instanceof THREE.Mesh) || !(child.material instanceof THREE.MeshBasicMaterial)) return;
      const assetId = child.userData.assetId;
      child.material.opacity = this.#drillFocusActive || this.#selectedPixels.size > 0 || this.#explodedPixel != null
        ? DIMMED_OPACITY
        : this.#focusedAssetId && assetId === this.#focusedAssetId ? 0.28 : 0.14;
    });
    const edgeOpacity = this.#drillFocusActive || this.#selectedPixels.size > 0 || this.#explodedPixel != null ? DIMMED_EDGE_OPACITY : COVERAGE_EDGE_OPACITY;
    this.#coverageEdgeMaterials.forEach((material) => { material.opacity = edgeOpacity; });
    this.#requestRender();
  }

  #pickCell(event: PointerCoordinates): { pixel: number; nside: number; membership: CoverageCellMembership | null; workspaceAvailable: boolean; point: THREE.Vector3 } | null {
    const bounds = this.#canvas.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return null;
    this.#pointer.set(((event.clientX - bounds.left) / bounds.width) * 2 - 1, -((event.clientY - bounds.top) / bounds.height) * 2 + 1);
    this.#raycaster.setFromCamera(this.#pointer, this.#camera);
    const renderedHit = this.#raycaster.intersectObjects([this.#drillGroup, this.#workspaceCoverageGroup], true).find((hit) => {
      const object = hit.object as Partial<LayerMesh>;
      return Boolean(object.userData?.records?.length);
    });
    let renderedPixel: number | undefined;
    let renderedNside = this.#drillNside;
    if (renderedHit) {
      const object = renderedHit.object as LayerMesh;
      const records = object.userData.records;
      const record = records[Math.max(0, Math.floor((renderedHit.faceIndex ?? 0) / 2))] ?? records[0];
      renderedPixel = record?.pixel;
      if (object.userData.drill) renderedNside = this.#drillNside;
      else renderedNside = [...this.#workspaceLayers.values()].find((layer) => layer.key === object.userData.layerKey)?.nside ?? this.#manifest.nside;
    }
    // Angular picking keeps inset gaps selectable, while a rendered shell hit preserves
    // the actual asset or drill cell beneath the pointer.
    const unitPoint = this.#intersectUnitSphere(this.#raycaster.ray);
    if (!unitPoint && !renderedHit) return null;
    const point = unitPoint ?? renderedHit!.point.clone().normalize();
    const nside = renderedPixel == null ? this.#manifest.nside : renderedNside;
    const pixel = renderedPixel ?? healpixPixelFromSceneDirection(nside, point);
    const membership = nside === this.#manifest.nside ? visibleCoverageAtPixel(this.#model, pixel, this.#visibleSurveyIds) : null;
    const workspaceAvailable = nside === this.#manifest.nside && this.#workspaceAvailableAt(pixel);
    const drillAvailable = nside === this.#drillNside && this.#drillCells.has(pixel);
    if (!membership && !workspaceAvailable && !drillAvailable && this.#interactionMode !== "region") return null;
    return { pixel, nside, membership, workspaceAvailable: workspaceAvailable || drillAvailable, point };
  }

  #pickObject(event: PointerCoordinates): SurveyObjectPoint | null {
    const bounds = this.#canvas.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return null;
    this.#pointer.set(((event.clientX - bounds.left) / bounds.width) * 2 - 1, -((event.clientY - bounds.top) / bounds.height) * 2 + 1);
    this.#raycaster.setFromCamera(this.#pointer, this.#camera);
    return this.#objectPointAt(event);
  }

  #pickOverlapComponent(event: PointerCoordinates): SurveyLayerOverlapComponent | null {
    const bounds = this.#canvas.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return null;
    this.#pointer.set(((event.clientX - bounds.left) / bounds.width) * 2 - 1, -((event.clientY - bounds.top) / bounds.height) * 2 + 1);
    this.#raycaster.setFromCamera(this.#pointer, this.#camera);
    const labelHit = this.#raycaster.intersectObjects([this.#overlapLabelGroup], true)[0];
    const labeled = labelHit?.object.userData.overlapComponent as SurveyLayerOverlapComponent | undefined;
    if (labeled) return labeled;
    const cellHit = this.#raycaster.intersectObjects([this.#coverageGroup, this.#overlapSelectionGroup], true)
      .find((candidate) => (candidate.object as Partial<LayerMesh>).userData?.surveyId === "__overlap__");
    if (!cellHit) return null;
    const records = (cellHit.object as Partial<LayerMesh>).userData?.records as Array<{ pixel: number }> | undefined;
    const pixel = records?.[Math.max(0, Math.floor((cellHit.faceIndex ?? 0) / 2))]?.pixel ?? records?.[0]?.pixel;
    return pixel === undefined ? null : this.#overlapComponents.find((component) => component.cells.includes(pixel)) ?? null;
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

  #inspect(event: PointerCoordinates): void {
    const hit = this.#pickCell(event);
    if (!hit?.membership && !hit?.workspaceAvailable) {
      this.#clearExplosion(true);
      this.#onInspection(null);
      this.#emitState();
      return;
    }
    if (this.#explodedPixel === hit.pixel && this.#explodedNside === hit.nside) {
      this.#clearExplosion(true);
      this.#onInspection(null);
      this.#emitState();
      return;
    }
    this.#presentInspection(hit.nside, hit.pixel, hit.membership ?? { surveyIds: [], releaseIds: [], artifacts: [] }, hit.workspaceAvailable, hit.point, false);
    this.#emitState();
  }

  #presentInspection(nside: number, pixel: number, membership: CoverageCellMembership, workspaceAvailable: boolean, point: THREE.Vector3, rotateCamera: boolean): void {
    this.#clearExplosion(false);
    const pointer = cartesianToRaDec(point);
    const center = cartesianToRaDec(this.#pixelDirectionAt(nside, [pixel]));
    const workspace = nside === this.#manifest.nside ? this.#workspaceMembershipAt(pixel) : { surveyIds: [], releaseIds: [], assetIds: [], layers: [] };
    this.#onInspection({
      kind: "coverage-cell",
      nside,
      pixel,
      surveyIds: [...new Set([...membership.surveyIds, ...workspace.surveyIds])].sort(),
      releaseIds: [...new Set([...membership.releaseIds, ...workspace.releaseIds])].sort(),
      assetIds: workspace.assetIds,
      workspaceLayers: workspace.layers,
      artifacts: membership.artifacts,
      pointerRaDeg: pointer.raDeg,
      pointerDecDeg: pointer.decDeg,
      centerRaDeg: center.raDeg,
      centerDecDeg: center.decDeg,
      workspaceAvailable,
    });
    void rotateCamera;
  }

  #select(event: PointerCoordinates, additive: boolean): void {
    const hit = this.#pickCell(event);
    if (!hit) return;
    this.#onHover(null);
    if (!additive) {
      this.#selectedPixels.clear();
      this.#selectedPixels.add(hit.pixel);
    } else if (this.#selectedPixels.has(hit.pixel)) this.#selectedPixels.delete(hit.pixel);
    else this.#selectedPixels.add(hit.pixel);
    this.#renderSelectionRegion();
    this.#emitSelection();
  }

  #renderSelectionRegion(): void {
    clearGroup(this.#selectionGroup);
    this.#selectionCoreMaterial = null;
    this.#selectionEdgeMaterial = null;
    this.#selectionGlowMaterial = null;
    delete this.#canvas.dataset.selectionVolume;
    delete this.#canvas.dataset.selectionDepthKeys;
    delete this.#canvas.dataset.selectionDepthRadii;
    delete this.#canvas.dataset.selectionEdgeLayers;
    this.#applyFocus();
    if (!this.#selectedPixels.size) return;
    const selected = [...this.#selectedPixels];
    const displayDepths = this.#displayDepths();
    const coveredKeys = new Set<string>();
    selected.forEach((pixel) => {
      const membership = visibleCoverageAtPixel(this.#model, pixel, this.#visibleSurveyIds);
      membership?.surveyIds.forEach((surveyId) => coveredKeys.add(`public-survey:${surveyId}`));
      this.#workspaceLayers.forEach((layer) => {
        if (this.#workspaceLayerVisible(layer) && layer.pixels.includes(pixel)) coveredKeys.add(this.#workspaceLayerKey(layer));
      });
    });
    const selectionDepths = displayDepths.filter((depth) => coveredKeys.has(depth.key));
    const depths = selectionDepths.length ? selectionDepths : displayDepths;
    if (!depths.length) return;
    const radii = depths.map((depth) => depth.radius);
    const minimumRadius = Math.max(0.05, Math.min(...radii) - REGION_INNER_PADDING);
    const maximumRadius = Math.max(...radii) + REGION_OUTER_PADDING;
    const edgeCells = selected.map((pixel) => ({
      nside: this.#manifest.nside,
      pixel,
      innerRadius: minimumRadius,
      outerRadius: maximumRadius,
      color: SELECTION_EDGE_COLOR,
      inset: 0.012,
    }));
    const edgeGeometry = buildSphericalCellVolumeEdges(edgeCells);
    const volumeEdgeMaterial = new THREE.LineDashedMaterial({
      color: SELECTION_EDGE_COLOR,
      transparent: true,
      opacity: 0.98,
      depthTest: false,
      depthWrite: false,
      dashSize: 0.07,
      gapSize: 0.035,
      toneMapped: false,
    });
    const volumeEdges = new THREE.LineSegments(edgeGeometry, volumeEdgeMaterial);
    volumeEdges.computeLineDistances();
    volumeEdges.renderOrder = SELECTION_RENDER_ORDER + 1;
    const coreMaterial = new THREE.LineBasicMaterial({
      color: 0xf7fffd,
      transparent: true,
      opacity: 0.96,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    const coreEdges = new THREE.LineSegments(edgeGeometry.clone(), coreMaterial);
    coreEdges.renderOrder = SELECTION_RENDER_ORDER + 2;
    const glowMaterial = new THREE.LineBasicMaterial({
      color: SELECTION_COLOR,
      transparent: true,
      opacity: 0.42,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    const glowEdges = new THREE.LineSegments(edgeGeometry.clone(), glowMaterial);
    glowEdges.renderOrder = SELECTION_RENDER_ORDER;
    this.#selectionCoreMaterial = coreMaterial;
    this.#selectionEdgeMaterial = volumeEdgeMaterial;
    this.#selectionGlowMaterial = glowMaterial;
    this.#selectionGroup.add(glowEdges, volumeEdges, coreEdges);
    this.#canvas.dataset.selectionVolume = "outline";
    this.#canvas.dataset.selectionDepthKeys = depths.map((depth) => depth.key).join(",");
    this.#canvas.dataset.selectionDepthRadii = depths.map((depth) => depth.radius.toFixed(4)).join(",");
    this.#canvas.dataset.selectionEdgeLayers = "1";

    this.#requestRender();
  }

  #selectionAnchor(): SurveyLayerState["selectionAnchor"] {
    if (!this.#selectedPixels.size) return null;
    const radius = this.#outerRadius + 0.045;
    const world = this.#pixelDirection(this.#selectedPixels).multiplyScalar(radius);
    const projected = world.clone().project(this.#camera);
    const forward = new THREE.Vector3();
    this.#camera.getWorldDirection(forward);
    const boundaryDirections = [...this.#selectedPixels]
      .flatMap((pixel) => sphericalCellBoundary(this.#manifest.nside, pixel, 1));
    const projectedBounds = [Math.max(0.05, this.#outerRadius - 0.18), radius]
      .flatMap((sampleRadius) => boundaryDirections.map((point) => point.clone().multiplyScalar(sampleRadius).project(this.#camera)));
    const leftRatio = projectedBounds.length ? Math.min(...projectedBounds.map((point) => (point.x + 1) / 2)) : (projected.x + 1) / 2;
    const rightRatio = projectedBounds.length ? Math.max(...projectedBounds.map((point) => (point.x + 1) / 2)) : (projected.x + 1) / 2;
    const topRatio = projectedBounds.length ? Math.min(...projectedBounds.map((point) => (1 - point.y) / 2)) : (1 - projected.y) / 2;
    const bottomRatio = projectedBounds.length ? Math.max(...projectedBounds.map((point) => (1 - point.y) / 2)) : (1 - projected.y) / 2;
    return {
      xRatio: (projected.x + 1) / 2,
      yRatio: (1 - projected.y) / 2,
      visible: world.clone().sub(this.#camera.position).dot(forward) > 0 && projected.z >= -1 && projected.z <= 1,
      bounds: { leftRatio, rightRatio, topRatio, bottomRatio },
    };
  }

  #emitSelection(notice?: string): void {
    if (!this.#selectedPixels.size) {
      this.#onSelection(null);
      return;
    }
    const surveyIds = new Set<string>();
    const releaseIds = new Set<string>();
    const assetIds = new Set<string>();
    const artifacts = new Map<string, SurveyFootprint>();
    const workspaceLayers = new Map<string, WorkspaceCoverageMembership>();
    const coverageCounts = new Map<string, number>();
    const assetCoverageCounts = new Map<string, number>();
    let emptyCellCount = 0;
    for (const pixel of this.#selectedPixels) {
      const membership = visibleCoverageAtPixel(this.#model, pixel, this.#visibleSurveyIds);
      const workspace = this.#workspaceMembershipAt(pixel);
      workspace.surveyIds.forEach((surveyId) => surveyIds.add(surveyId));
      workspace.releaseIds.forEach((releaseId) => releaseIds.add(releaseId));
      workspace.assetIds.forEach((assetId) => {
        assetIds.add(assetId);
        assetCoverageCounts.set(assetId, (assetCoverageCounts.get(assetId) ?? 0) + 1);
      });
      workspace.layers.forEach((layer) => workspaceLayers.set(layer.key, layer));
      workspace.surveyIds.forEach((surveyId) => coverageCounts.set(surveyId, (coverageCounts.get(surveyId) ?? 0) + 1));
      if (!membership && !workspace.layers.length) {
        emptyCellCount += 1;
        continue;
      }
      membership?.surveyIds.forEach((surveyId) => surveyIds.add(surveyId));
      membership?.surveyIds.forEach((surveyId) => coverageCounts.set(surveyId, (coverageCounts.get(surveyId) ?? 0) + 1));
      membership?.releaseIds.forEach((releaseId) => releaseIds.add(releaseId));
      membership?.artifacts.forEach((artifact) => artifacts.set(artifactKey(artifact), artifact));
    }
    const direction = this.#pixelDirection(this.#selectedPixels);
    const center = cartesianToRaDec(direction);
    let angularRadiusDeg = 0;
    for (const pixel of this.#selectedPixels) {
      for (const corner of sphericalCellBoundary(this.#manifest.nside, pixel, 1)) {
        angularRadiusDeg = Math.max(angularRadiusDeg, THREE.MathUtils.radToDeg(direction.angleTo(corner)));
      }
    }
    this.#onSelection({
      kind: "coverage-region",
      nside: this.#manifest.nside,
      pixels: [...this.#selectedPixels].sort((left, right) => left - right),
      surveyIds: [...surveyIds].sort(),
      releaseIds: [...releaseIds].sort(),
      assetIds: [...assetIds].sort(),
      artifacts: [...artifacts.values()].sort((left, right) => artifactKey(left).localeCompare(artifactKey(right))),
      coverageCounts: [...coverageCounts].map(([surveyId, cellCount]) => ({ surveyId, cellCount })).sort((left, right) => left.surveyId.localeCompare(right.surveyId)),
      assetCoverageCounts: [...assetCoverageCounts].map(([assetId, cellCount]) => ({ assetId, cellCount })).sort((left, right) => left.assetId.localeCompare(right.assetId)),
      workspaceLayers: [...workspaceLayers.values()].sort((left, right) => left.key.localeCompare(right.key)),
      centerRaDeg: center.raDeg,
      centerDecDeg: center.decDeg,
      angularRadiusDeg,
      emptyCellCount,
      notice,
    });
    this.#emitState();
  }

  #pruneSelection(): void {
    this.#renderSelectionRegion();
    this.#emitSelection();
  }

  #clearSelection(): void {
    this.#selectedPixels.clear();
    clearGroup(this.#selectionGroup);
    this.#selectionCoreMaterial = null;
    this.#selectionEdgeMaterial = null;
    this.#selectionGlowMaterial = null;
    this.#applyFocus();
    this.#onSelection(null);
    this.#emitState();
    this.#requestRender();
  }

  #explodeInspection(nside: number, pixel: number, membership: CoverageCellMembership, rotateCamera: boolean): void {
    this.#clearExplosion(false);
    this.#explodedPixel = pixel;
    this.#explodedNside = nside;
    const depths = new Map(this.#displayDepths().map((depth) => [depth.key, depth]));
    const entries: ExplosionLayerEntry[] = [];
    for (const surveyId of membership.surveyIds) {
      if (!this.#visibleSurveyIds.has(surveyId)) continue;
      entries.push({
        key: `survey:${surveyId}`,
        nside,
        pixel,
        color: this.#colorBySurvey.get(surveyId) ?? BASE_COLOR,
          sourceRadius: depths.get(`public-survey:${surveyId}`)?.radius ?? 1,
      });
    }
    if (nside === this.#manifest.nside) {
      this.#workspaceDisplayLayers(depths)
        .filter(({ layer }) => layer.pixels.includes(pixel))
        .forEach(({ layer, radius, color }) => entries.push({
          key: layer.key ?? layer.assetId ?? layer.surveyId ?? "workspace",
          nside,
          pixel,
          color,
          sourceRadius: radius,
        }));
    }
    const drillCell = this.#drillCells.get(pixel);
    if (drillCell && drillCell.nside === nside) {
      const existingKeys = new Set(entries.map((entry) => entry.key));
      for (const layer of drillCell.layers.filter((candidate) => candidate.count > 0)) {
        const key = layer.key || layer.assetId || layer.surveyId || `cell:${pixel}`;
        if (existingKeys.has(key)) continue;
        const color = layer.assetId
          ? deterministicWorkspaceColor(layer.assetId)
          : layer.surveyId ? this.#colorBySurvey.get(layer.surveyId) ?? BASE_COLOR : BASE_COLOR;
        entries.push({ key, nside, pixel, color, sourceRadius: Math.max(1.006, this.#outerRadius + 0.006) });
        existingKeys.add(key);
      }
    }
    const midpoint = (entries.length - 1) / 2;
    this.#explodedFragments = entries.map((entry, index) => {
      const targetRadius = 1 + (index - midpoint) * EXPLODED_LAYER_STEP;
      const root = new THREE.Group();
      root.scale.setScalar(entry.sourceRadius / targetRadius);
      const cell: SphericalCellSheetGeometryInput = {
        nside: entry.nside,
        pixel: entry.pixel,
        radius: targetRadius,
        color: entry.color,
        inset: entry.nside === this.#manifest.nside ? 0.018 : 0.006,
      };
      const material = fragmentMaterial(0);
      const mesh = new THREE.Mesh(buildSphericalCellSheetGeometry([cell]), material);
      mesh.renderOrder = EXPLOSION_RENDER_ORDER + index * 2;
      const lineMaterial = new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0,
        depthTest: true,
        depthWrite: false,
        toneMapped: false,
      });
      const edges = new THREE.LineSegments(buildSphericalCellEdges([cell]), lineMaterial);
      edges.renderOrder = EXPLOSION_RENDER_ORDER + index * 2 + 1;
      root.add(mesh, edges);
      this.#explosionGroup.add(root);
      return { root, material, lineMaterial, fromScale: entry.sourceRadius / targetRadius };
    });
    this.#setCoverageOpacity(true);
    this.#explosionTransition = {
      startedAt: performance.now(),
      durationMs: 620,
      direction: "in",
      fragments: this.#explodedFragments,
    };
    const direction = this.#pixelDirectionAt(nside, [pixel]);
    const outer = this.#outerRadius;
    const distance = Math.max(this.#camera.position.length(), outer + 0.18);
    const destination = direction.clone().multiplyScalar(distance);
    this.#controls.minDistance = 0.002;
    if (rotateCamera) this.#startCameraTransition(destination, new THREE.Vector3(0, 0, 0), 620);
    this.#requestRender();
  }

  #clearExplosion(animated: boolean): void {
    if (this.#explodedPixel == null && !this.#explosionGroup.children.length) {
      return;
    }
    this.#explodedPixel = null;
    this.#explodedNside = null;
    this.#setCoverageOpacity(false);
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

  #setCoverageOpacity(dimmed: boolean): void {
    const restore = (group: THREE.Group, meshOpacity: number, edgeOpacity: number): void => {
      group.traverse((child) => {
        const overlap = child instanceof THREE.Mesh && child.userData.surveyId === "__overlap__";
        if (child instanceof THREE.Mesh && child.material instanceof THREE.MeshBasicMaterial) child.material.opacity = dimmed ? DIMMED_OPACITY : overlap ? 0.86 : meshOpacity;
        if (child instanceof THREE.LineSegments && child.material instanceof THREE.LineBasicMaterial) child.material.opacity = dimmed ? DIMMED_EDGE_OPACITY : overlap ? 0.72 : edgeOpacity;
      });
    };
    restore(this.#coverageGroup, COVERAGE_OPACITY, COVERAGE_EDGE_OPACITY);
    restore(this.#workspaceCoverageGroup, 0.14, 0.68);
    restore(this.#drillGroup, 0.3, 0.8);
  }

  #pixelDirection(pixels: Iterable<number>): THREE.Vector3 {
    return this.#pixelDirectionAt(this.#manifest.nside, pixels);
  }

  #pixelDirectionAt(nside: number, pixels: Iterable<number>): THREE.Vector3 {
    const direction = new THREE.Vector3();
    for (const pixel of pixels) {
      const boundary = sphericalCellBoundary(nside, pixel, 1);
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
    this.#emitState();
  }

  #advanceFragmentTransitions(now: number): void {
    for (let index = this.#fragmentTransitions.length - 1; index >= 0; index -= 1) {
      const transition = this.#fragmentTransitions[index]!;
      const progress = Math.min(1, (now - transition.startedAt) / transition.durationMs);
      const eased = easeInOut(progress);
      const opacity = transition.direction === "in" ? eased : 1 - eased;
      transition.root.scale.setScalar(transition.direction === "in" ? THREE.MathUtils.lerp(0.94, 1, eased) : THREE.MathUtils.lerp(1, 0.96, eased));
      const overlap = transition.root.children.some((child) => child instanceof THREE.Mesh && child.userData.surveyId === "__overlap__");
      const coverageOpacity = overlap ? 0.86 : this.#explodedPixel == null ? COVERAGE_OPACITY : DIMMED_OPACITY;
      const edgeOpacity = overlap ? 0.72 : this.#selectedPixels.size === 0 && this.#explodedPixel == null ? COVERAGE_EDGE_OPACITY : DIMMED_EDGE_OPACITY;
      const fragmentOpacity = overlap ? coverageOpacity : this.#selectedPixels.size === 0 && this.#explodedPixel == null ? coverageOpacity : DIMMED_OPACITY;
      transition.meshMaterials.forEach((material) => { material.opacity = opacity * fragmentOpacity; });
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

  #advanceSelectionAnimation(now: number): void {
    const overlapPulse = 0.5 + 0.5 * Math.sin(now * 0.003);
    this.#overlapDashMaterials.forEach((material) => {
      (material as THREE.LineDashedMaterial & { dashOffset: number }).dashOffset = -now * 0.00008;
      material.opacity = 0.72 + overlapPulse * 0.28;
    });
    if (!this.#selectionCoreMaterial || !this.#selectionEdgeMaterial || !this.#selectionGlowMaterial) return;
    const pulse = 0.5 + 0.5 * Math.sin(now * 0.004);
    this.#selectionEdgeMaterial.dashSize = 0.052 + pulse * 0.034;
    this.#selectionEdgeMaterial.gapSize = 0.028 + (1 - pulse) * 0.018;
    this.#selectionEdgeMaterial.opacity = 0.86 + pulse * 0.14;
    this.#selectionCoreMaterial.opacity = 0.88 + pulse * 0.12;
    this.#selectionGlowMaterial.opacity = 0.28 + pulse * 0.38;
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
    const minimumRadius = this.#outerRadius + 0.002;
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
    if (this.#clickTimer) clearTimeout(this.#clickTimer);
    const click = {
      clientX: event.clientX,
      clientY: event.clientY,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
    };
    if (this.#overlapMode) {
      const component = this.#pickOverlapComponent(click);
      if (component) this.#onOverlapComponent?.(component);
      return;
    }
    this.#clickTimer = setTimeout(() => {
      this.#clickTimer = null;
      const object = this.#pickObject(click);
      if (object) {
        this.#onObjectPoint?.(object);
        return;
      }
      const additive = click.ctrlKey || click.metaKey;
      this.#select(click, additive);
      if (!additive) this.#inspect(click);
    }, 220);
  };

  readonly #handleDoubleClick = (event: MouseEvent): void => {
    if (event.button !== 0) return;
    if (this.#overlapMode) return;
    if (this.#clickTimer) clearTimeout(this.#clickTimer);
    this.#clickTimer = null;
    const hit = this.#pickCell(event);
    if (hit) this.focusCell(hit.nside, hit.pixel);
  };

  readonly #handlePointerMove = (event: PointerEvent): void => {
    if (this.#overlapMode) {
      this.#onHover(null);
      return;
    }
    if (this.#pointerStart && Math.hypot(event.clientX - this.#pointerStart.x, event.clientY - this.#pointerStart.y) >= 5) return;
    const hit = this.#pickCell(event);
    if (!hit) {
      this.#onHover(null);
      return;
    }
    const pointer = cartesianToRaDec(hit.point);
    const center = cartesianToRaDec(this.#pixelDirectionAt(hit.nside, [hit.pixel]));
    const workspace = hit.nside === this.#manifest.nside ? this.#workspaceMembershipAt(hit.pixel) : { surveyIds: [], releaseIds: [], assetIds: [], layers: [] };
    this.#onHover({
      nside: hit.nside,
      pixel: hit.pixel,
      surveyIds: [...new Set([...(hit.membership?.surveyIds ?? []), ...workspace.surveyIds])].sort(),
      releaseIds: [...new Set([...(hit.membership?.releaseIds ?? []), ...workspace.releaseIds])].sort(),
      assetIds: workspace.assetIds,
      workspaceLayers: workspace.layers,
      artifacts: hit.membership?.artifacts ?? [],
      pointerRaDeg: pointer.raDeg,
      pointerDecDeg: pointer.decDeg,
      centerRaDeg: center.raDeg,
      centerDecDeg: center.decDeg,
      workspaceAvailable: hit.workspaceAvailable,
      clientX: event.clientX,
      clientY: event.clientY,
        selectableInRegion: true,
    });
  };

  readonly #handlePointerLeave = (): void => this.#onHover(null);
  readonly #handlePointerCancel = (): void => { this.#pointerStart = null; };
  readonly #handleContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
    const hit = this.#pickCell(event);
    if (!hit || hit.nside !== this.#manifest.nside) {
      this.#onHover(null);
      return;
    }
    if (!this.#selectedPixels.has(hit.pixel)) {
      this.#selectedPixels.clear();
      this.#selectedPixels.add(hit.pixel);
      this.#renderSelectionRegion();
      this.#emitSelection();
    }
    const surveyIds = new Set<string>();
    const releaseIds = new Set<string>();
    const assetIds = new Set<string>();
    for (const pixel of this.#selectedPixels) {
      const membership = visibleCoverageAtPixel(this.#model, pixel, this.#visibleSurveyIds);
      const workspace = this.#workspaceMembershipAt(pixel);
      membership?.surveyIds.forEach((surveyId) => surveyIds.add(surveyId));
      membership?.releaseIds.forEach((releaseId) => releaseIds.add(releaseId));
      workspace.surveyIds.forEach((surveyId) => surveyIds.add(surveyId));
      workspace.releaseIds.forEach((releaseId) => releaseIds.add(releaseId));
      workspace.assetIds.forEach((assetId) => assetIds.add(assetId));
    }
    this.#onContextMenu({
      clientX: event.clientX,
      clientY: event.clientY,
      nside: this.#manifest.nside,
      pixels: [...this.#selectedPixels].sort((left, right) => left - right),
      surveyIds: [...surveyIds].sort(),
      releaseIds: [...releaseIds].sort(),
      assetIds: [...assetIds].sort(),
    });
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
    this.#composer.setSize(width, height);
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
      this.#advanceSelectionAnimation(now);
      const moving = this.#controls.enabled && this.#controls.update();
      this.#keepCameraOutside();
      this.#composer.render();
      if (moving || this.#cameraTransition || this.#fragmentTransitions.length || this.#explosionTransition || this.#selectionEdgeMaterial || this.#overlapDashMaterials.length) this.#requestRender();
    });
  }
}
