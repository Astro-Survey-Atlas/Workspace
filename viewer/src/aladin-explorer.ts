import A from "aladin-lite";
import { ArrowRight, createIcons } from "lucide";
import { Healpix, Pointing } from "healpixjs";

import type { AstroObjectRecord, AstroPointDensityLayerInput, AstroPointDensityResult, ObjectRegionQueryInput, SkyDataPointScope } from "../../src/astro-object-index";
import { workspaceApi } from "./api";
import { clampDec, normalizeRa } from "@astro-survey-atlas/sky-globe";
import type { SurveyObjectPoint } from "@astro-survey-atlas/sky-globe";
import { compactRects, subtractRects, type QueryRect } from "./viewport-query-cache";

export interface AladinExplorerSnapshot {
  nside: number;
  pixels: number[];
  filters: Pick<ObjectRegionQueryInput, "surveyIds" | "releaseIds" | "assetIds">;
  sourceKeys: string[];
  centerRaDeg: number;
  centerDecDeg: number;
  initialFovDeg: number;
  imageSurveyUrl: string;
  assetTargets: AladinAssetTarget[];
  initialAssetId?: string;
  layerScopes?: SkyDataPointScope[];
  /** Outline these NESTED cells (the 3D-globe selection) in Aladin. */
  regionOutline?: { nside: number; pixels: number[]; color: string };
}

/** Above this many cells the outline is skipped; polygon overlays get slow. */
export const REGION_OUTLINE_CELL_LIMIT = 1_000;

export interface AladinAssetTarget {
  assetId: string;
  scopes?: SkyDataPointScope[];
  coverageOnly?: boolean;
  label: string;
  color: string;
  centerRaDeg: number;
  centerDecDeg: number;
  defaultFovDeg: number;
  objectCount?: number;
  returned?: number;
  pointKind?: "image_center" | "object";
}

export interface AladinLayerDescriptor {
  key: string;
  label: string;
  color: string;
}

export interface AladinExplorerStatus {
  phase: "initializing" | "loading" | "ready" | "empty" | "error";
  returned: number;
  total: number;
  truncated: boolean;
  complete?: boolean;
  message?: string;
  assets?: AladinAssetProgress[];
  overlapCount?: number;
  indexing?: boolean;
  displayMode?: "points" | "density";
  densityCells?: number;
  regionPointState?: "loading" | "available" | "empty" | "indexing" | "error";
}

export interface AladinAssetProgress {
  assetId: string;
  label: string;
  color: string;
  returned: number;
  total: number;
  truncated: boolean;
  cacheState: "loading" | "cached" | "seeded" | "idle";
}

export interface AladinExplorerView {
  raDeg: number;
  decDeg: number;
  fovDeg: number;
  fovXDeg?: number;
  fovYDeg?: number;
}

export interface AladinExplorerCallbacks {
  resolveLayer: (record: AstroObjectRecord) => AladinLayerDescriptor;
  resolveSurvey?: (id: string) => { label: string; color: string };
  onObject: (point: SurveyObjectPoint | null) => void;
  onStatus: (status: AladinExplorerStatus) => void;
  onViewChange?: (view: AladinExplorerView) => void;
  onViewInteraction?: () => void;
  onAssetChange?: (assetId: string | null) => void;
  onDensityHover?: (detail: { pixel: number; nside: number; total: number; surveys: Array<{ id: string; label: string; color: string; count: number; assetId?: string }> } | null) => void;
  initialRecords?: ReadonlyMap<string, { records: AstroObjectRecord[]; total: number; truncated?: boolean }>;
}

interface ViewportSession {
  key: string;
  assetIds: string[];
  coveredRects: QueryRect[];
  pendingRects: QueryRect[];
  renderedObjectIds: Set<string>;
  catalogs: any[];
  catalogsByLayer: Map<string, any>;
  overlapCatalog: any | null;
  densityCatalogs: Map<string, any>;
  densityNside: number;
  densityCells: Map<number, AstroPointDensityResult["cells"][number]>;
  overlapSources: Map<string, any>;
  overlapBuckets: Map<string, AstroObjectRecord[]>;
  catalogColors: Set<string>;
  returnedByAsset: Map<string, number>;
  total: number;
  truncated: boolean;
  seeded: boolean;
  indexing: boolean;
  lastUsed: number;
}

interface ActiveRequest {
  controller: AbortController;
  generation: number;
  session: ViewportSession;
  jobs: QueryRect[];
}

const QUERY_LIMIT = 2000;
const POINT_RENDER_BATCH_SIZE = 500;
const QUERY_DEBOUNCE_MS = 200;
const INDEX_REFRESH_MS = 10_000;
const DENSITY_FOV_THRESHOLD = 1.5;
const DENSITY_TARGET_CELL_PX = 80;
const MIN_FOV_DEG = 0.05;
const MAX_FOV_DEG = 180;
const MAX_VIEWPORT_SESSIONS = 3;

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function coordinatePair(value: unknown): [number, number] | null {
  if (!Array.isArray(value) && !ArrayBuffer.isView(value)) return null;
  const pair = value as unknown as ArrayLike<number>;
  return Number.isFinite(pair[0]) && Number.isFinite(pair[1]) ? [pair[0]!, pair[1]!] : null;
}

function fovDimensions(fov: unknown, fallback: number): [number, number] {
  if (Array.isArray(fov)) return [
    Math.max(MIN_FOV_DEG, finiteNumber(fov[0], fallback)),
    Math.max(MIN_FOV_DEG, finiteNumber(fov[1], fallback)),
  ];
  const value = Math.max(MIN_FOV_DEG, finiteNumber(fov, fallback));
  return [value, value];
}

function viewportBoxes(view: AladinExplorerView, host: HTMLElement, aladin?: any): QueryRect[] {
  if (typeof aladin?.pix2world === "function") {
    const width = host.clientWidth;
    const height = host.clientHeight;
    const ratios = [[0, 0], [0.25, 0], [0.5, 0], [0.75, 0], [1, 0], [1, 0.25], [1, 0.5], [1, 0.75],
      [1, 1], [0.75, 1], [0.5, 1], [0.25, 1], [0, 1], [0, 0.75], [0, 0.5], [0, 0.25], [0.5, 0.5]] as const;
    const samples: Array<[number, number]> = [];
    for (const [xRatio, yRatio] of ratios) {
      try {
        const point = coordinatePair(aladin.pix2world(width * xRatio, height * yRatio));
        if (point) {
          samples.push([normalizeRa(point[0]), clampDec(point[1])]);
        }
      } catch { /* Use the camera-derived bounds below. */ }
    }
    if (samples.length >= 5) {
      const ras = samples.map(([ra]) => ra).sort((a, b) => a - b);
      let largestGap = -1;
      let gapIndex = 0;
      for (let index = 0; index < ras.length; index += 1) {
        const next = (index + 1) % ras.length;
        const gap = next === 0 ? ras[0]! + 360 - ras[index]! : ras[next]! - ras[index]!;
        if (gap > largestGap) { largestGap = gap; gapIndex = index; }
      }
      const raMin = ras[(gapIndex + 1) % ras.length]!;
      const raMax = ras[gapIndex]!;
      const decs = samples.map(([, dec]) => dec);
      const padding = Math.max(0.005, (Math.max(...decs) - Math.min(...decs)) * 0.015);
      const decMin = Math.max(-90, Math.min(...decs) - padding);
      const decMax = Math.min(90, Math.max(...decs) + padding);
      if (raMin <= raMax) return [{ raMin, raMax, decMin, decMax }];
      return [{ raMin: 0, raMax, decMin, decMax }, { raMin, raMax: 360, decMin, decMax }];
    }
  }
  const aspect = Math.max(0.25, host.clientWidth / Math.max(1, host.clientHeight));
  const horizontalFov = view.fovXDeg ?? view.fovDeg;
  const verticalFov = view.fovYDeg ?? horizontalFov / aspect;
  const decHalf = Math.min(90, verticalFov / 2);
  const decMin = Math.max(-90, view.decDeg - decHalf);
  const decMax = Math.min(90, view.decDeg + decHalf);
  const cosDec = Math.max(0.05, Math.cos((view.decDeg * Math.PI) / 180));
  const raHalf = Math.min(180, horizontalFov / (2 * cosDec));
  if (raHalf >= 179.9) return [{ raMin: 0, raMax: 360, decMin, decMax }];

  const rawMin = view.raDeg - raHalf;
  const rawMax = view.raDeg + raHalf;
  if (rawMin < 0) {
    return [
      { raMin: 0, raMax: rawMax, decMin, decMax },
      { raMin: rawMin + 360, raMax: 360, decMin, decMax },
    ];
  }
  if (rawMax >= 360) {
    return [
      { raMin: 0, raMax: rawMax - 360, decMin, decMax },
      { raMin: rawMin, raMax: 360, decMin, decMax },
    ];
  }
  return [{ raMin: rawMin, raMax: rawMax, decMin, decMax }];
}

interface DirectionTarget {
  assetId: string;
  raDeg: number;
  decDeg: number;
  record?: AstroObjectRecord;
  indexing?: boolean;
}

interface DirectionGuidePlacement {
  x: number;
  y: number;
  width: number;
  height: number;
}

function tangentOffset(centerRa: number, centerDec: number, ra: number, dec: number): { east: number; north: number } {
  const center = raDecToVector(centerRa, centerDec);
  const target = raDecToVector(ra, dec);
  const a = (centerRa * Math.PI) / 180;
  const d = (centerDec * Math.PI) / 180;
  const east = { x: -Math.sin(a), y: Math.cos(a), z: 0 };
  const north = { x: -Math.sin(d) * Math.cos(a), y: -Math.sin(d) * Math.sin(a), z: Math.cos(d) };
  const dot = Math.max(0.0001, center.x * target.x + center.y * target.y + center.z * target.z);
  return {
    east: (target.x * east.x + target.y * east.y + target.z * east.z) / dot,
    north: (target.x * north.x + target.y * north.y + target.z * north.z) / dot,
  };
}

function raDecToVector(ra: number, dec: number): { x: number; y: number; z: number } {
  const a = (ra * Math.PI) / 180;
  const d = (dec * Math.PI) / 180;
  return { x: Math.cos(d) * Math.cos(a), y: Math.cos(d) * Math.sin(a), z: Math.sin(d) };
}

function directionToTarget(
  aladin: any,
  width: number,
  height: number,
  view: AladinExplorerView,
  target: DirectionTarget,
): { dx: number; dy: number } | null {
  try {
    const projected = coordinatePair(aladin?.world2pix?.(target.raDeg, target.decDeg));
    if (projected) {
      const [x, y] = projected;
      const margin = 24;
      if (x >= margin && x <= width - margin && y >= margin && y <= height - margin) return null;
      return { dx: x - width / 2, dy: y - height / 2 };
    }
  } catch { /* Use the local tangent projection below. */ }

  try {
    const rightWorld = coordinatePair(aladin?.pix2world?.(width / 2 + 30, height / 2));
    const downWorld = coordinatePair(aladin?.pix2world?.(width / 2, height / 2 + 30));
    if (!rightWorld || !downWorld) return null;
    const right = tangentOffset(view.raDeg, view.decDeg, rightWorld[0]!, rightWorld[1]!);
    const down = tangentOffset(view.raDeg, view.decDeg, downWorld[0]!, downWorld[1]!);
    const targetOffset = tangentOffset(view.raDeg, view.decDeg, target.raDeg, target.decDeg);
    const determinant = right.east * down.north - down.east * right.north;
    if (Math.abs(determinant) < 1e-8) return null;
    const dx = (targetOffset.east * down.north - down.east * targetOffset.north) / determinant;
    const dy = (right.east * targetOffset.north - targetOffset.east * right.north) / determinant;
    return Number.isFinite(dx) && Number.isFinite(dy) ? { dx, dy } : null;
  } catch {
    return null;
  }
}

function placeDirectionGuide(
  containerWidth: number,
  containerHeight: number,
  dx: number,
  dy: number,
  occupied: readonly DirectionGuidePlacement[],
): DirectionGuidePlacement {
  const edgePadding = 8;
  const width = Math.max(1, Math.min(252, containerWidth - edgePadding * 2));
  const height = Math.max(1, Math.min(38, containerHeight - edgePadding * 2));
  const centerX = containerWidth / 2;
  const centerY = containerHeight / 2;
  const maxOffsetX = Math.max(1, centerX - width / 2 - edgePadding);
  const maxOffsetY = Math.max(1, centerY - height / 2 - edgePadding);
  const scale = Math.max(Math.abs(dx) / maxOffsetX, Math.abs(dy) / maxOffsetY, 0.0001);
  const base = {
    x: Math.max(edgePadding, Math.min(containerWidth - width - edgePadding, centerX + dx / scale - width / 2)),
    y: Math.max(edgePadding, Math.min(containerHeight - height - edgePadding, centerY + dy / scale - height / 2)),
    width,
    height,
  };
  const collides = (candidate: DirectionGuidePlacement): boolean => occupied.some((other) =>
    candidate.x < other.x + other.width + 4 && candidate.x + candidate.width + 4 > other.x
      && candidate.y < other.y + other.height + 4 && candidate.y + candidate.height + 4 > other.y);
  if (!collides(base)) return base;
  const candidates: DirectionGuidePlacement[] = [];
  for (let offset = height + 6; offset <= containerHeight; offset += height + 6) {
    for (const direction of [-1, 1]) {
      candidates.push({ ...base, y: Math.max(edgePadding, Math.min(containerHeight - height - edgePadding, base.y + offset * direction)) });
      candidates.push({ ...base, x: Math.max(edgePadding, Math.min(containerWidth - width - edgePadding, base.x + offset * direction)) });
    }
  }
  return candidates.find((candidate) => !collides(candidate)) ?? base;
}

function angularDistanceDeg(raA: number, decA: number, raB: number, decB: number): number {
  const a = (decA * Math.PI) / 180;
  const b = (decB * Math.PI) / 180;
  const deltaRa = ((raB - raA) * Math.PI) / 180;
  const cosine = Math.sin(a) * Math.sin(b) + Math.cos(a) * Math.cos(b) * Math.cos(deltaRa);
  return (Math.acos(Math.max(-1, Math.min(1, cosine))) * 180) / Math.PI;
}

function formatGuideDistance(deg: number): string {
  if (deg >= 10) return `${deg.toFixed(0)}°`;
  if (deg >= 1) return `${deg.toFixed(1)}°`;
  return `${Math.round(deg * 60)}′`;
}

function boxKey(box: QueryRect): string {
  return [box.raMin, box.raMax, box.decMin, box.decMax].map((value) => value.toFixed(4)).join(",");
}

function sourceScreenPoint(source: any): { x: number; y: number } | null {
  const x = source?.x ?? source?.screenX ?? source?.viewX;
  const y = source?.y ?? source?.screenY ?? source?.viewY;
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

function overlapBucketKey(record: AstroObjectRecord): string {
  const raArcsec = Math.round((normalizeRa(record.ra_deg) * 3600) % (360 * 3600));
  const decArcsec = Math.round(record.dec_deg * 3600);
  return `${raArcsec}:${decArcsec}`;
}

function drawOverlapMarker(source: any, context: CanvasRenderingContext2D): void {
  const point = sourceScreenPoint(source);
  if (!point) return;
  const data = source?.data ?? {};
  const colors = Array.isArray(data.overlapColors) ? data.overlapColors.slice(0, 4) : [];
  if (!colors.length) return;
  const radius = 8;
  const startAngle = Math.PI * 0.25;
  const step = (Math.PI * 2) / colors.length;
  context.save();
  context.translate(point.x, point.y);
  colors.forEach((color: string, index: number) => {
    context.beginPath();
    context.moveTo(0, 0);
    context.arc(0, 0, radius, startAngle + index * step, startAngle + (index + 1) * step);
    context.closePath();
    context.fillStyle = color;
    context.fill();
  });
  context.beginPath();
  context.arc(0, 0, radius, 0, Math.PI * 2);
  context.strokeStyle = "#f4fffd";
  context.lineWidth = 1.5;
  context.stroke();
  if (Number(data.overlapCount) > 2) {
    context.beginPath();
    context.arc(0, 0, 3.1, 0, Math.PI * 2);
    context.fillStyle = "rgba(5, 12, 16, 0.88)";
    context.fill();
    context.fillStyle = "#f4fffd";
    context.font = "600 7px SFMono-Regular, Consolas, monospace";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(String(data.overlapCount), 0, 0.5);
  }
  context.restore();
}

function nextPageCursor(result: { nextCursor?: unknown[]; searchAfter?: unknown[] }): unknown[] | undefined {
  if (result.nextCursor?.length) return result.nextCursor;
  if (result.searchAfter?.length) return result.searchAfter;
  return undefined;
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

export class AladinExplorer {
  readonly snapshot: AladinExplorerSnapshot;
  readonly ready: Promise<void>;

  private readonly host: HTMLElement;
  private readonly callbacks: AladinExplorerCallbacks;
  private readonly selectedLayerIds = new Set<string>();
  private readonly assetTargets = new Map<string, AladinAssetTarget>();
  private readonly sessions = new Map<string, ViewportSession>();
  private readonly directionTargets = new Map<string, DirectionTarget>();
  private readonly regionPointStates = new Map<string, NonNullable<AladinExplorerStatus["regionPointState"]>>();
  private aladin: any = null;
  private directionGuideLayer: HTMLDivElement | null = null;
  private densityLabelLayer: HTMLDivElement | null = null;
  private readonly densityLabels = new Map<number, { element: HTMLDivElement; raDeg: number; decDeg: number; vertices: Array<[number, number]> }>();
  private directionAnchorController: AbortController | null = null;
  private pointDetailController: AbortController | null = null;
  private directionAnchorGeneration = 0;
  private directionTargetsPromise: Promise<void> = Promise.resolve();
  private directionGuideTimer: ReturnType<typeof setTimeout> | null = null;
  private removeInteractionListeners: (() => void) | null = null;
  private activeSession: ViewportSession | null = null;
  private activeRequest: ActiveRequest | null = null;
  private queryTimer: ReturnType<typeof setTimeout> | null = null;
  private indexRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private themeObserver: MutationObserver | null = null;
  private generation = 0;
  private disposed = false;
  private pendingView: AladinExplorerView | null = null;
  private pendingViewExpiresAt = 0;
  private activeAssetId: string | null;
  private lastObjectClickAt = 0;
  private initialViewport = true;
  private autoAnchorController: AbortController | null = null;
  private densityModeActive = false;
  private lastDensityHoverKey: string | null = null;

  constructor(host: HTMLElement, snapshot: AladinExplorerSnapshot, callbacks: AladinExplorerCallbacks) {
    this.host = host;
    this.snapshot = {
      ...snapshot,
      pixels: [...snapshot.pixels],
      sourceKeys: [...snapshot.sourceKeys],
      filters: {
        surveyIds: snapshot.filters.surveyIds ? [...snapshot.filters.surveyIds] : undefined,
        releaseIds: snapshot.filters.releaseIds ? [...snapshot.filters.releaseIds] : undefined,
        assetIds: snapshot.filters.assetIds ? [...snapshot.filters.assetIds] : undefined,
      },
      assetTargets: snapshot.assetTargets.map((target) => ({ ...target })),
    };
    this.callbacks = callbacks;
    this.snapshot.assetTargets.forEach((target) => this.assetTargets.set(target.assetId, target));
    this.activeAssetId = snapshot.initialAssetId && this.assetTargets.has(snapshot.initialAssetId)
      ? snapshot.initialAssetId
      : null;
    this.snapshot.assetTargets.forEach((target) => this.selectedLayerIds.add(target.assetId));
    this.ready = this.initialize();
  }

  private async initialize(): Promise<void> {
    this.emitStatus({ phase: "initializing", returned: 0, total: 0, truncated: false });
    await Promise.resolve(A.init);
    if (this.disposed) return;

    const selector = this.host.id ? `#${this.host.id}` : this.host;
    this.aladin = A.aladin(selector, {
      survey: this.snapshot.imageSurveyUrl,
      fov: this.snapshot.initialFovDeg,
      cooFrame: "ICRS",
      projection: "AIT",
      showCooGrid: true,
      gridOptions: {
        color: this.themeGridColor(),
        opacity: 0.45,
        thickness: 1,
        showLabels: true,
        labelSize: 10,
      },
      inertia: false,
      showFullscreenControl: false,
      showLayersControl: false,
      showGotoControl: false,
      showShareControl: false,
      showFrame: false,
      showZoomControl: false,
      showProjectionControl: false,
      showCatalog: true,
      showContextMenu: false,
      showCooLocation: false,
      showFov: false,
      showStatusBar: false,
      showCooGridControl: false,
      showColorPickerControl: false,
      showSelectionModeControl: false,
      showSettingsControl: false,
      showSimbadPointerControl: false,
      showReticle: false,
    });
    if (this.disposed) {
      this.disposeAladin();
      return;
    }
    this.applyThemeGridColor();
    this.themeObserver = new MutationObserver(() => this.applyThemeGridColor());
    this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    this.aladin.showCatalog?.(true);

    const initialTarget = this.activeAssetId ? this.assetTargets.get(this.activeAssetId) : undefined;
    this.aladin.gotoRaDec(initialTarget?.centerRaDeg ?? this.snapshot.centerRaDeg, initialTarget?.centerDecDeg ?? this.snapshot.centerDecDeg);
    this.applyFov(initialTarget?.defaultFovDeg ?? this.snapshot.initialFovDeg);
    this.densityLabelLayer = document.createElement("div");
    this.densityLabelLayer.className = "aladin-density-labels";
    this.densityLabelLayer.hidden = true;
    this.densityLabelLayer.setAttribute("aria-label", "密度块巡天数据点数量");
    this.host.append(this.densityLabelLayer);
    this.directionGuideLayer = document.createElement("div");
    this.directionGuideLayer.className = "aladin-direction-guides";
    this.directionGuideLayer.setAttribute("aria-label", "视野外数据点导航");
    this.host.append(this.directionGuideLayer);
    this.bindEvents();
    this.resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => { this.renderDirectionGuides(); this.positionDensityLabels(); this.scheduleQuery(0); });
    this.resizeObserver?.observe(this.host);
    this.renderRegionOutline();
    this.renderSeedRecords();
    this.callbacks.onAssetChange?.(this.activeAssetId);
    this.refreshDirectionTargets();
    this.scheduleQuery(0);
  }

  private bindEvents(): void {
    const onInteraction = (): void => {
      this.initialViewport = false;
      this.cancelAutoAnchor();
      this.pointDetailController?.abort();
      this.directionAnchorController?.abort();
      this.directionAnchorController = null;
      this.directionAnchorGeneration += 1;
      for (const [id, state] of this.regionPointStates) if (state === "loading") this.regionPointStates.delete(id);
      this.callbacks.onViewInteraction?.();
      this.scheduleQuery(QUERY_DEBOUNCE_MS);
    };
    const onPointerMove = (event: PointerEvent): void => { if (event.buttons) onInteraction(); };
    const onDoubleClick = (event: MouseEvent): void => {
      const session = this.activeSession;
      if (!this.densityModeActive || !session || this.getCurrentView().fovDeg <= DENSITY_FOV_THRESHOLD) return;
      const bounds = this.host.getBoundingClientRect();
      let position: [number, number] | null;
      try { position = coordinatePair(this.aladin?.pix2world?.(event.clientX - bounds.left, event.clientY - bounds.top)); } catch { return; }
      if (!position) return;
      const healpix = new Healpix(session.densityNside);
      const pixel = healpix.ang2pix(new Pointing(null, false, (90 - position[1]) * Math.PI / 180, normalizeRa(position[0]) * Math.PI / 180));
      if (!session.densityCells.has(pixel)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onInteraction();
      const center = healpix.pix2ang(pixel);
      this.gotoRaDec(normalizeRa(center.phi * 180 / Math.PI), 90 - center.theta * 180 / Math.PI);
      this.setFov(0.5);
    };
    this.host.addEventListener("wheel", onInteraction, { capture: true, passive: true });
    this.host.addEventListener("pointermove", onPointerMove, { capture: true, passive: true });
    this.host.addEventListener("dblclick", onDoubleClick, true);
    this.removeInteractionListeners = () => {
      this.host.removeEventListener("wheel", onInteraction, true);
      this.host.removeEventListener("pointermove", onPointerMove, true);
      this.host.removeEventListener("dblclick", onDoubleClick, true);
    };
    const onViewChange = (): void => {
      this.scheduleDirectionGuides();
      this.positionDensityLabels();
      this.scheduleQuery(QUERY_DEBOUNCE_MS);
      window.setTimeout(() => {
        if (!this.disposed) this.callbacks.onViewChange?.(this.getCurrentView());
      }, 0);
    };
    this.aladin.on?.("positionChanged", onViewChange);
    this.aladin.on?.("zoomChanged", onViewChange);
    this.aladin.on?.("resizeChanged", onViewChange);
    this.aladin.on?.("objectClicked", (source: any) => {
      if (source?.data?.kind === "density") {
        this.emitDensityHover(source);
        return;
      }
      const record = source?.data?.record as AstroObjectRecord | undefined;
      if (record) {
        this.lastObjectClickAt = Date.now();
        this.pointDetailController?.abort();
        const controller = new AbortController();
        this.pointDetailController = controller;
        void workspaceApi.skyPointDetail(record.id ?? record.object_id, controller.signal).then(({ point }) => { if (!controller.signal.aborted && !this.disposed && this.host.dataset.objectSelected === point.object_id) this.callbacks.onObject(this.toObjectPoint(point)); }).catch(() => undefined);
        this.host.dataset.objectSelected = record.object_id;
        this.callbacks.onObject(this.toObjectPoint(record, source?.data?.overlap ? {
          overlapCount: Number(source.data.overlapCount) || undefined,
          overlapAssetIds: Array.isArray(source.data.records)
            ? source.data.records.map((candidate: AstroObjectRecord) => candidate.asset_id).filter((assetId: unknown): assetId is string => typeof assetId === "string")
            : undefined,
        } : undefined));
      }
    });
    this.aladin.on?.("objectHovered", (source: any) => this.emitDensityHover(source?.data?.kind === "density" ? source : null));
    this.aladin.on?.("footprintHovered", (source: any) => this.emitDensityHover(source?.data?.kind === "density" ? source : null));
    this.aladin.on?.("mouseMove", (position: { ra?: number | null; dec?: number | null }) => this.emitDensityAt(position));
    this.aladin.on?.("click", (event: any) => {
      if (!event?.isDragging && Date.now() - this.lastObjectClickAt > 350) {
        delete this.host.dataset.objectSelected;
        this.callbacks.onObject(null);
      }
    });
  }

  private emitDensityHover(source: any): void {
    if (!source?.data || source.data.kind !== "density") {
      if (this.lastDensityHoverKey !== null) {
        this.lastDensityHoverKey = null;
        this.callbacks.onDensityHover?.(null);
      }
      return;
    }
    const data = source.data;
    const key = `${Number(data.nside)}:${Number(data.pixel)}`;
    if (this.lastDensityHoverKey === key) return;
    this.lastDensityHoverKey = key;
    const surveys = this.describeDensitySurveys(data.surveys ?? []);
    this.callbacks.onDensityHover?.({ pixel: Number(data.pixel), nside: Number(data.nside), total: Number(data.total) || 0, surveys });
  }

  private emitDensityAt(position: { ra?: number | null; dec?: number | null }): void {
    const session = this.activeSession;
    if (!this.densityModeActive || !session || !Number.isFinite(position.ra) || !Number.isFinite(position.dec)) {
      this.callbacks.onDensityHover?.(null);
      return;
    }
    const pixel = new Healpix(session.densityNside).ang2pix(new Pointing(
      null,
      false,
      ((90 - Number(position.dec)) * Math.PI) / 180,
      (normalizeRa(Number(position.ra)) * Math.PI) / 180,
    ));
    const cell = session.densityCells.get(pixel);
    this.emitDensityHover(cell ? { data: { kind: "density", pixel, nside: session.densityNside, total: cell.count, surveys: cell.surveys } } : null);
  }

  private themeGridColor(): string {
    return getComputedStyle(document.documentElement).getPropertyValue("--asa-magenta").trim() || "#f01951";
  }

  private applyThemeGridColor(): void {
    const color = this.themeGridColor();
    this.host.dataset.gridColor = color;
    this.aladin?.setGridOptions?.({ color });
  }

  private emitStatus(status: AladinExplorerStatus): void {
    this.lastStatus = status;
    this.callbacks.onStatus(status);
  }

  private lastStatus: AladinExplorerStatus | null = null;

  private getCurrentView(): AladinExplorerView {
    if (Date.now() >= this.pendingViewExpiresAt) this.pendingView = null;
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;
    const project = (x: number, y: number): [number, number] | null => {
      try { return coordinatePair(this.aladin?.pix2world?.(x, y)); } catch { return null; }
    };
    // Read the rendered sky: Aladin's cached vertical FOV can remain 180°
    // after a fullscreen resize, and getRaDec may return a Float64Array.
    const center = project(width / 2, height / 2);
    const raDec = center ?? coordinatePair(this.aladin?.getRaDec?.());
    const fov = this.aladin?.getFov?.();
    const raDeg = normalizeRa(raDec?.[0] ?? this.pendingView?.raDeg ?? this.snapshot.centerRaDeg);
    const decDeg = clampDec(raDec?.[1] ?? this.pendingView?.decDeg ?? this.snapshot.centerDecDeg);
    const fallback = fovDimensions(fov, this.pendingView?.fovDeg ?? this.snapshot.initialFovDeg);
    const span = (a: [number, number] | null, b: [number, number] | null, defaultSpan: number): number =>
      center && a && b ? Math.max(MIN_FOV_DEG,
        angularDistanceDeg(...a, ...center) + angularDistanceDeg(...center, ...b)) : defaultSpan;
    const fovXDeg = span(project(0, height / 2), project(width, height / 2), fallback[0]);
    const fovYDeg = span(project(width / 2, 0), project(width / 2, height), fallback[1]);
    return {
      raDeg,
      decDeg,
      fovDeg: Math.min(MAX_FOV_DEG, Math.max(fovXDeg, fovYDeg)),
      fovXDeg,
      fovYDeg,
    };
  }

  getView(): AladinExplorerView {
    return this.getCurrentView();
  }

  setImageSurvey(url: string): void {
    if (!this.aladin || this.disposed) return;
    this.aladin.setImageSurvey?.(url);
    this.host.dataset.imageSurvey = url;
  }

  getActiveAssetId(): string | null {
    return this.activeAssetId;
  }

  getSelectedLayerIds(): string[] { return [...this.selectedLayerIds]; }

  getSelectedLayerScopes(): SkyDataPointScope[] {
    return this.scopesForLayers([...this.selectedLayerIds]);
  }

  setLayerSelected(layerId: string, selected: boolean): void {
    if (!this.assetTargets.has(layerId)) return;
    this.cancelAutoAnchor();
    this.initialViewport = false;
    if (selected) this.selectedLayerIds.add(layerId); else this.selectedLayerIds.delete(layerId);
    this.activeAssetId = this.selectedLayerIds.size === 1 ? [...this.selectedLayerIds][0]! : null;
    this.activateSession([...this.selectedLayerIds]);
    this.callbacks.onAssetChange?.(this.activeAssetId);
    this.renderSeedRecords(); this.scheduleQuery(0);
  }

  focusAsset(assetId: string | null): void {
    this.cancelAutoAnchor();
    this.initialViewport = false;
    this.selectedLayerIds.clear();
    (assetId ? [assetId] : [...this.assetTargets.keys()]).forEach((id) => this.selectedLayerIds.add(id));
    this.activeAssetId = assetId; this.activateSession([...this.selectedLayerIds]);
    this.callbacks.onAssetChange?.(assetId); this.renderSeedRecords(); this.scheduleQuery(0);
  }

  private scopesForLayers(layerIds: readonly string[]): SkyDataPointScope[] {
    return layerIds.flatMap((id) => this.assetTargets.get(id)?.scopes ?? [{ assetId: id }]);
  }

  gotoRaDec(raDeg: number, decDeg: number): void {
    if (!this.aladin || this.disposed) return;
    this.cancelAutoAnchor();
    this.initialViewport = false;
    const nextRa = normalizeRa(raDeg);
    const nextDec = clampDec(decDeg);
    const current = this.getCurrentView();
    this.aladin.gotoRaDec(nextRa, nextDec);
    this.pendingView = { raDeg: nextRa, decDeg: nextDec, fovDeg: current.fovDeg };
    this.pendingViewExpiresAt = Date.now() + 700;
    this.scheduleQuery(0);
  }

  private applyFov(fovDeg: number): void {
    if (!this.aladin) return;
    this.aladin.setFov(fovDeg);
    // Aladin sets the horizontal span; our FOV limits the larger viewport
    // axis. Measure the projection so portrait and fullscreen layouts agree.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const measured = this.getCurrentView().fovDeg;
      if (Math.abs(measured - fovDeg) <= fovDeg * 0.001) break;
      const horizontal = coordinatePair(this.aladin.getFov?.())?.[0];
      if (!horizontal || !Number.isFinite(measured) || measured <= 0) break;
      this.aladin.setFov(Math.min(MAX_FOV_DEG, horizontal * fovDeg / measured));
    }
  }

  setFov(fovDeg: number): void {
    if (!this.aladin || this.disposed) return;
    this.cancelAutoAnchor();
    this.initialViewport = false;
    const nextFov = Math.max(MIN_FOV_DEG, Math.min(MAX_FOV_DEG, fovDeg));
    const current = this.getCurrentView();
    this.applyFov(nextFov);
    this.pendingView = { raDeg: current.raDeg, decDeg: current.decDeg, fovDeg: nextFov };
    this.pendingViewExpiresAt = Date.now() + 700;
    this.scheduleQuery(0);
  }

  resize(): void {
    if (!this.aladin || this.disposed) return;
    this.aladin.resize?.();
    this.aladin.setSize?.(this.host.clientWidth, this.host.clientHeight);
    this.scheduleQuery(0);
  }

  reset(): void {
    this.focusAsset(null);
    this.gotoRaDec(this.snapshot.centerRaDeg, this.snapshot.centerDecDeg);
    this.setFov(this.snapshot.initialFovDeg);
  }

  private scheduleQuery(delayMs: number): void {
    if (this.disposed || !this.aladin) return;
    if (this.indexRefreshTimer) clearTimeout(this.indexRefreshTimer);
    this.indexRefreshTimer = null;
    this.generation += 1;
    const previous = this.activeRequest;
    if (previous) {
      previous.session.pendingRects = previous.session.pendingRects.filter(rect => !previous.jobs.includes(rect));
      previous.controller.abort();
    }
    this.activeRequest = null;
    if (this.queryTimer) clearTimeout(this.queryTimer);
    const generation = this.generation;
    this.queryTimer = setTimeout(() => {
      this.queryTimer = null;
      void this.queryViewport(generation);
    }, delayMs);
  }

  private async queryViewport(generation: number): Promise<void> {
    if (this.disposed || generation !== this.generation || !this.aladin) return;
    const view = this.getCurrentView();
    const boxes = viewportBoxes(view, this.host, this.aladin);
    const assetIds = [...this.selectedLayerIds];
    if (!assetIds.length || !this.scopesForLayers(assetIds).length) {
      this.activateSession(assetIds);
      this.densityModeActive = false;
      this.activeSession?.densityCatalogs.forEach((catalog) => catalog.hide?.());
      this.lastDensityHoverKey = null;
      this.callbacks.onDensityHover?.(null);
      this.emitStatus({ phase: "empty", returned: 0, total: 0, truncated: false, message: assetIds.length ? "所选图层仅有覆盖；下载并扫描后可显示数据点" : "当前未选中数据图层" });
      return;
    }
    const session = this.activateSession(assetIds);
    session.lastUsed = Date.now();
    if (view.fovDeg > DENSITY_FOV_THRESHOLD) {
      await this.queryDensityViewport(generation, view, boxes, session, assetIds);
      return;
    }
    session.catalogs.forEach(catalog => catalog.show?.());
    const jobs = subtractRects(boxes, [...(session.indexing ? [] : session.coveredRects), ...session.pendingRects]);
    if (!jobs.length) {
      session.densityCatalogs.forEach(catalog => catalog.hide?.());
      this.densityModeActive = false;
      this.lastDensityHoverKey = null;
      this.callbacks.onDensityHover?.(null);
      this.emitSessionStatus(session, true);
      this.refreshDirectionTargets();
      if (!session.renderedObjectIds.size) await this.maybeAutoAnchor(session, generation);
      return;
    }
    const controller = new AbortController();
    const request: ActiveRequest = { controller, generation, session, jobs };
    this.activeRequest = request;
    session.indexing = false;
    jobs.forEach((job) => session.pendingRects.push(job));
    this.emitStatus({ phase: "loading", displayMode: "points", returned: session.renderedObjectIds.size,
      total: Math.max(session.total, session.renderedObjectIds.size), truncated: false, complete: false, assets: this.assetProgress(session, "loading"),
      overlapCount: session.overlapSources.size, indexing: session.indexing });
    let viewportCompleted = false;
    try {
      for (const bbox of jobs) {
        const activeLayers = new Set(assetIds.filter(id => (this.assetTargets.get(id)?.scopes?.length ?? 0) > 0));
        const cursors = new Map<string, unknown[] | undefined>();
        const seenCursors = new Map<string, Set<string>>();
        const countedLayers = new Set<string>();
        while (activeLayers.size) {
          for (const layerId of [...activeLayers]) {
            const input: ObjectRegionQueryInput = {
              bbox,
              region: { nside: this.snapshot.nside, pixels: this.snapshot.pixels, coordinateFrame: "ICRS", ordering: "NESTED" },
              coordinateFrame: "ICRS", ordering: "NESTED", layerScopes: this.scopesForLayers([layerId]),
              limit: QUERY_LIMIT, includeAttributes: false, trackTotalHits: false, cursor: cursors.get(layerId),
            };
            const result = await workspaceApi.skyPointsQuery(input, controller.signal);
            if (this.disposed || generation !== this.generation || controller.signal.aborted) return;
            session.indexing ||= Boolean(result.indexing);
            if (session.indexing) session.coveredRects = [];
            if (result.status !== "ready") throw new Error(result.message ?? "数据点查询未完成");
            if (!countedLayers.has(layerId)) {
              session.total += result.total;
              countedLayers.add(layerId);
            }
            await this.appendRecordsInBatches(session, result.objects, controller.signal);
            if (this.disposed || generation !== this.generation || controller.signal.aborted) return;
            const nextCursor = nextPageCursor(result);
            if (nextCursor?.length) {
              const cursorKey = JSON.stringify(nextCursor);
              const seen = seenCursors.get(layerId) ?? new Set<string>();
              if (!result.objects.length || seen.has(cursorKey)) throw new Error("数据点分页游标重复，未能确认视野已完整加载");
              seen.add(cursorKey);
              seenCursors.set(layerId, seen);
              cursors.set(layerId, nextCursor);
            } else activeLayers.delete(layerId);
            this.emitStatus({ phase: "loading", displayMode: "points", returned: session.renderedObjectIds.size,
              total: Math.max(session.total, session.renderedObjectIds.size), truncated: false, complete: false, assets: this.assetProgress(session, "loading"),
              overlapCount: session.overlapSources.size, indexing: session.indexing });
            await yieldToBrowser();
            if (this.disposed || generation !== this.generation || controller.signal.aborted) return;
          }
        }
        if (!session.indexing) {
          session.coveredRects.push(bbox);
          session.coveredRects = compactRects(session.coveredRects);
        }
      }
      session.densityCatalogs.forEach(catalog => catalog.hide?.());
      this.densityModeActive = false;
      this.lastDensityHoverKey = null;
      this.callbacks.onDensityHover?.(null);
      viewportCompleted = true;
      this.emitSessionStatus(session, true);
      this.refreshDirectionTargets();
      if (!session.renderedObjectIds.size) await this.maybeAutoAnchor(session, generation, controller.signal);
    } catch (error) {
      if (controller.signal.aborted || this.disposed || generation !== this.generation) return;
      const message = error instanceof Error ? error.message : String(error);
      if (session.indexing) {
        this.emitSessionStatus(session, false);
      } else if (this.initialViewport && !session.renderedObjectIds.size) {
        this.emitStatus({ phase: "loading", returned: 0, total: session.total, truncated: session.truncated, complete: false,
          indexing: session.indexing, regionPointState: "loading", message: `当前视野查询失败，正在查找选区内的数据点：${message}` });
      } else {
        this.emitStatus({ phase: "error", returned: session.renderedObjectIds.size, total: Math.max(session.total, session.renderedObjectIds.size),
          truncated: session.truncated, complete: true, message });
      }
    } finally {
      jobs.forEach((job) => {
        const index = session.pendingRects.indexOf(job);
        if (index >= 0) session.pendingRects.splice(index, 1);
      });
      if (this.activeRequest === request) this.activeRequest = null;
      if (viewportCompleted && !controller.signal.aborted && generation === this.generation) this.refreshEmptyStatus();
      if (!viewportCompleted && !controller.signal.aborted && generation === this.generation
        && this.initialViewport && !session.renderedObjectIds.size) {
        this.refreshDirectionTargets();
        await this.maybeAutoAnchor(session, generation);
        if (!session.renderedObjectIds.size) this.refreshEmptyStatus();
      }
      if (!this.disposed && generation === this.generation && session.indexing && this.activeSession === session) {
        this.indexRefreshTimer = setTimeout(() => { this.indexRefreshTimer = null; this.scheduleQuery(0); }, INDEX_REFRESH_MS);
      }
    }
  }

  private densityNside(view: AladinExplorerView): number {
    const ideal = (58.63 * Math.max(320, this.host.clientWidth)) / Math.max(0.01, view.fovDeg * DENSITY_TARGET_CELL_PX);
    return 2 ** Math.max(0, Math.min(8, Math.round(Math.log2(ideal))));
  }

  private async queryDensityViewport(generation: number, view: AladinExplorerView, boxes: QueryRect[], session: ViewportSession, assetIds: string[]): Promise<void> {
    const layers: AstroPointDensityLayerInput[] = assetIds.map(id => ({ id, scopes: this.assetTargets.get(id)?.scopes ?? [] }));
    const controller = new AbortController();
    const request: ActiveRequest = { controller, generation, session, jobs: boxes };
    this.activeRequest?.controller.abort();
    this.activeRequest = request;
    this.emitStatus({ phase: "loading", displayMode: "density", returned: 0, total: 0, truncated: false,
      complete: false, indexing: session.indexing, assets: this.assetProgress(session, "loading"), overlapCount: session.overlapSources.size });
    let viewportCompleted = false;
    try {
      const result = await workspaceApi.skyPointDensity({
        region: { nside: this.snapshot.nside, pixels: this.snapshot.pixels, coordinateFrame: "ICRS", ordering: "NESTED" },
        boxes, layers, targetNside: this.densityNside(view),
      }, controller.signal);
      if (this.disposed || generation !== this.generation || controller.signal.aborted) return;
      if (result.status !== "ready") throw new Error(result.message ?? "密度聚合未能完成");
      session.indexing = result.indexing;
      session.catalogs.forEach(catalog => catalog.hide?.());
      this.densityModeActive = true;
      this.lastDensityHoverKey = null;
      this.callbacks.onDensityHover?.(null);
      this.renderDensityCells(session, result, layers);
      this.renderDirectionGuides();
      this.refreshDirectionTargets();
      const status: AladinExplorerStatus = { phase: result.total ? "ready" : "empty", displayMode: "density", returned: result.cells.length,
        densityCells: result.cells.length, total: result.total, truncated: false, complete: !result.indexing,
        indexing: result.indexing, assets: this.assetProgress(session, result.total ? "ready" : "idle").map(asset => ({
          ...asset, total: result.layers.find(layer => layer.id === asset.assetId)?.count ?? 0,
        })), overlapCount: session.overlapSources.size,
        message: result.total ? undefined : "所选视野内没有已索引数据点" };
      this.emitSessionStatus(session, true, status);
      viewportCompleted = true;
    } catch (error) {
      if (controller.signal.aborted || this.disposed || generation !== this.generation) return;
      this.emitStatus({ phase: "error", displayMode: "density", returned: 0, total: 0, truncated: false, complete: true,
        message: error instanceof Error ? error.message : String(error) });
    } finally {
      if (this.activeRequest === request) this.activeRequest = null;
      if (viewportCompleted && !controller.signal.aborted && generation === this.generation) this.refreshEmptyStatus();
      if (!this.disposed && generation === this.generation && session.indexing && this.activeSession === session) {
        this.indexRefreshTimer = setTimeout(() => { this.indexRefreshTimer = null; this.scheduleQuery(0); }, INDEX_REFRESH_MS);
      }
    }
  }

  private renderDensityCells(session: ViewportSession, result: AstroPointDensityResult, layers: AstroPointDensityLayerInput[]): void {
    const healpix = new Healpix(result.nside);
    session.densityNside = result.nside;
    session.densityCells = new Map(result.cells.map(cell => [cell.pixel, cell]));
    const cellArea = 41_252.961_249_419_27 / (12 * result.nside ** 2);
    let maximumDensity = 1;
    result.cells.forEach(cell => cell.layers.forEach(layer => { maximumDensity = Math.max(maximumDensity, layer.count / cellArea); }));
    const byLayer = new Map<string, Array<{ raDeg: number; decDeg: number; pixel: number; count: number; cell: typeof result.cells[number] }>>();
    for (const cell of result.cells) {
      const center = healpix.pix2ang(cell.pixel);
      const raDeg = normalizeRa(center.phi * 180 / Math.PI);
      const decDeg = 90 - center.theta * 180 / Math.PI;
      for (const layer of cell.layers) {
        const values = byLayer.get(layer.id) ?? [];
        values.push({ raDeg, decDeg, pixel: cell.pixel, count: layer.count, cell });
        byLayer.set(layer.id, values);
      }
    }
    for (const layer of layers) {
      let catalog = session.densityCatalogs.get(layer.id);
      const target = this.assetTargets.get(layer.id);
      if (!target) continue;
      if (!catalog) {
        const color = target.color;
        catalog = A.catalog({
          name: `${target.label} density`, color, sourceSize: 24, onlyFootprints: false, readOnly: true,
          shape: (source: any) => {
            const vertices = source.data?.vertices;
            if (!Array.isArray(vertices) || !A?.polygon || !A?.footprint) return "square";
            const points = vertices.map((vertex: { raDeg: number; decDeg: number }) => [vertex.raDeg, vertex.decDeg]);
            return A.footprint([A.polygon(points, { color, fill: true, fillColor: color, opacity: source.data.opacity, lineWidth: 0.2 })]);
          },
        });
        this.aladin.addCatalog(catalog);
        session.densityCatalogs.set(layer.id, catalog);
      }
      catalog.clear?.();
      catalog.hide?.();
      const sources = (byLayer.get(layer.id) ?? []).map(entry => {
        const boundary = healpix.getBoundaries(entry.pixel).map(vertex => ({
          raDeg: normalizeRa(Math.atan2(vertex.y, vertex.x) * 180 / Math.PI),
          decDeg: Math.asin(Math.max(-1, Math.min(1, vertex.z))) * 180 / Math.PI,
        }));
        const density = entry.count / cellArea;
        const opacity = 0.12 + 0.58 * Math.log1p(density) / Math.log1p(maximumDensity);
        return A.source(entry.raDeg, entry.decDeg, {
          kind: "density", layerId: layer.id, nside: result.nside, pixel: entry.pixel,
          count: entry.count, total: entry.cell.count, opacity, vertices: boundary,
          layers: entry.cell.layers, surveys: entry.cell.surveys,
        }, { color: target.color });
      });
      if (sources.length) catalog.addSources(sources);
      catalog.show?.();
    }
    this.host.dataset.densityNside = String(result.nside);
    this.host.dataset.densityCells = String(result.cells.length);
    this.renderDensityLabels(session);
  }

  private describeDensitySurveys(surveys: AstroPointDensityResult["cells"][number]["surveys"]) {
    return surveys.filter(survey => survey.count > 0).map(survey => {
      const asset = survey.assetId ? this.assetTargets.get(survey.assetId)
        ?? [...this.assetTargets.values()].find(target => target.scopes?.some(scope => scope.assetId === survey.assetId)) : undefined;
      const descriptor = survey.id
        ? this.callbacks.resolveSurvey?.(survey.id) ?? { label: survey.id, color: "#a8b3ff" }
        : { label: asset ? `${asset.label}（未标注巡天）` : "未标注巡天", color: asset?.color ?? "#a8b3ff" };
      return { ...survey, ...descriptor };
    }).sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
  }

  private renderDensityLabels(session: ViewportSession): void {
    const host = this.densityLabelLayer;
    if (!host) return;
    host.replaceChildren();
    this.densityLabels.clear();
    const healpix = new Healpix(session.densityNside);
    for (const cell of session.densityCells.values()) {
      if (!cell.count) continue;
      const center = healpix.pix2ang(cell.pixel);
      const raDeg = normalizeRa(center.phi * 180 / Math.PI);
      const decDeg = 90 - center.theta * 180 / Math.PI;
      const label = document.createElement("div");
      label.className = "aladin-density-label";
      label.dataset.pixel = String(cell.pixel);
      label.dataset.nside = String(session.densityNside);
      label.dataset.raDeg = String(raDeg);
      label.dataset.decDeg = String(decDeg);
      label.setAttribute("role", "group");
      const total = document.createElement("strong");
      total.className = "aladin-density-label-total";
      total.textContent = `${cell.count.toLocaleString()} 个数据点`;
      label.append(total);
      const surveys = this.describeDensitySurveys(cell.surveys);
      label.setAttribute("aria-label", surveys.map(survey => `${survey.label} ${survey.count} 个数据点`).join("，") + "。双击密度块放大到 0.5°");
      for (const survey of surveys) {
        const row = document.createElement("div");
        row.className = "aladin-density-label-row";
        row.dataset.surveyId = survey.id;
        if (survey.assetId) row.dataset.assetId = survey.assetId;
        row.style.setProperty("--survey-color", survey.color);
        const swatch = document.createElement("i");
        swatch.setAttribute("aria-hidden", "true");
        const name = document.createElement("span");
        name.textContent = survey.label;
        name.title = survey.label;
        const count = document.createElement("output");
        count.textContent = survey.count.toLocaleString();
        row.append(swatch, name, count);
        label.append(row);
      }
      host.append(label);
      this.densityLabels.set(cell.pixel, { element: label, raDeg, decDeg,
        vertices: healpix.getBoundaries(cell.pixel).map(vertex => [
          normalizeRa(Math.atan2(vertex.y, vertex.x) * 180 / Math.PI),
          Math.asin(Math.max(-1, Math.min(1, vertex.z))) * 180 / Math.PI,
        ]),
      });
    }
    this.positionDensityLabels();
  }

  private positionDensityLabels(): void {
    const host = this.densityLabelLayer;
    if (!host || !this.aladin || this.disposed) return;
    host.hidden = !this.densityModeActive || !this.densityLabels.size || this.getCurrentView().fovDeg <= DENSITY_FOV_THRESHOLD;
    if (host.hidden) return;
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;
    const project = (ra: number, dec: number): [number, number] | null => {
      try { return coordinatePair(this.aladin.world2pix(ra, dec)); } catch { return null; }
    };
    for (const { element, raDeg, decDeg, vertices } of this.densityLabels.values()) {
      const center = project(raDeg, decDeg);
      const boundary = vertices.map(vertex => project(...vertex)).filter((point): point is [number, number] => point !== null);
      const left = Math.max(0, Math.min(...boundary.map(point => point[0])));
      const right = Math.min(width, Math.max(...boundary.map(point => point[0])));
      const top = Math.max(0, Math.min(...boundary.map(point => point[1])));
      const bottom = Math.min(height, Math.max(...boundary.map(point => point[1])));
      element.hidden = !center || right <= left || bottom <= top;
      if (element.hidden || !center) continue;
      const halfWidth = element.offsetWidth / 2;
      const halfHeight = element.offsetHeight / 2;
      const x = Math.max(left, Math.min(right, center[0]));
      const y = Math.max(top, Math.min(bottom, center[1]));
      element.style.left = `${Math.max(halfWidth + 4, Math.min(width - halfWidth - 4, x))}px`;
      element.style.top = `${Math.max(halfHeight + 4, Math.min(height - halfHeight - 4, y))}px`;
    }
  }

  private refreshDirectionTargets(): void {
    const layerIds = [...this.selectedLayerIds].filter(id => !this.directionTargets.has(id)
      && !["empty", "error", "indexing"].includes(this.regionPointStates.get(id) ?? "") && this.scopesForLayers([id]).length);
    if (this.disposed || this.directionAnchorController || !layerIds.length) return;
    const controller = new AbortController();
    const generation = ++this.directionAnchorGeneration;
    this.directionAnchorController = controller;
    for (const id of this.directionTargets.keys()) if (!this.selectedLayerIds.has(id)) this.directionTargets.delete(id);
    layerIds.forEach(id => this.regionPointStates.set(id, "loading"));
    this.renderDirectionGuides();
    this.refreshEmptyStatus();
    this.directionTargetsPromise = Promise.all(layerIds.map(async (assetId) => {
      const layerScopes = this.scopesForLayers([assetId]);
      if (!layerScopes.length) return;
      try {
        const result = await workspaceApi.skyPointAnchor({
          region: { nside: this.snapshot.nside, pixels: this.snapshot.pixels, coordinateFrame: "ICRS", ordering: "NESTED" },
          layerScopes, coordinateFrame: "ICRS", ordering: "NESTED", limit: 1,
          includeAttributes: false, trackTotalHits: false,
        }, controller.signal);
        if (this.disposed || generation !== this.directionAnchorGeneration || controller.signal.aborted) return;
        if (result.status !== "ready") throw new Error(result.message ?? "选区点位查询失败");
        this.regionPointStates.set(assetId, result.point ? "available" : result.indexing ? "indexing" : "empty");
        if (result.point) this.directionTargets.set(assetId, {
          assetId,
          raDeg: result.point.raDeg,
          decDeg: result.point.decDeg,
          ...(result.record ? { record: result.record } : {}),
          indexing: result.indexing,
        });
        this.renderDirectionGuides();
      } catch {
        if (!controller.signal.aborted && generation === this.directionAnchorGeneration) this.regionPointStates.set(assetId, "error");
      }
    })).then(() => {
      if (!this.disposed && generation === this.directionAnchorGeneration) {
        if (this.directionAnchorController === controller) this.directionAnchorController = null;
        this.renderDirectionGuides();
        this.refreshEmptyStatus();
      }
    });
    void this.directionTargetsPromise.then(() => {
      const session = this.activeSession;
      if (session && this.initialViewport && !session.renderedObjectIds.size) {
        void this.maybeAutoAnchor(session, this.generation).catch(() => undefined);
      }
    });
  }

  private regionPointState(): NonNullable<AladinExplorerStatus["regionPointState"]> {
    const states = [...this.selectedLayerIds].filter(id => this.scopesForLayers([id]).length)
      .map(id => this.regionPointStates.get(id) ?? "loading");
    if (states.includes("available")) return "available";
    if (states.includes("indexing")) return "indexing";
    if (states.includes("loading")) return "loading";
    if (states.includes("error")) return "error";
    return "empty";
  }

  private refreshEmptyStatus(): void {
    const session = this.activeSession;
    if (!session || this.disposed) return;
    const density = this.densityModeActive && this.lastStatus?.displayMode === "density" ? this.lastStatus : undefined;
    if (density ? density.total > 0 : session.renderedObjectIds.size > 0) return;
    // A region hint must not replace a viewport request's progress or error.
    if (this.activeRequest || (this.lastStatus?.phase === "error" && !this.lastStatus.regionPointState)) return;
    this.emitSessionStatus(session, true, density);
    if ((session.indexing || this.regionPointState() === "indexing") && !this.indexRefreshTimer) {
      this.indexRefreshTimer = setTimeout(() => {
        this.indexRefreshTimer = null;
        if (this.disposed || this.activeSession !== session) return;
        for (const [id, state] of this.regionPointStates) {
          if (state === "indexing" || (session.indexing && state === "error")) this.regionPointStates.delete(id);
        }
        this.scheduleQuery(0);
      }, INDEX_REFRESH_MS);
    }
  }

  retryNavigation(): void {
    this.directionAnchorController?.abort();
    this.directionAnchorController = null;
    this.directionAnchorGeneration += 1;
    for (const [id, state] of this.regionPointStates) if (state !== "available") this.regionPointStates.delete(id);
    if (this.activeSession) this.activeSession.coveredRects = [];
    this.scheduleQuery(0);
  }

  private scheduleDirectionGuides(): void {
    if (this.disposed || this.directionGuideTimer) return;
    this.directionGuideTimer = setTimeout(() => {
      this.directionGuideTimer = null;
      this.renderDirectionGuides();
    }, 80);
  }

  private renderDirectionGuides(): void {
    const host = this.directionGuideLayer;
    if (!host || !this.aladin || this.disposed) return;
    host.replaceChildren();
    const view = this.getCurrentView();
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;
    if (width < 100 || height < 100) {
      this.host.dataset.directionGuideCount = "0";
      return;
    }
    const selected = new Set(this.selectedLayerIds);
    const candidates = [...this.directionTargets.values()]
      .filter((target) => selected.has(target.assetId))
      .map((target) => ({
        target,
        distanceDeg: angularDistanceDeg(view.raDeg, view.decDeg, target.raDeg, target.decDeg),
        direction: directionToTarget(this.aladin, width, height, view, target),
      }))
      .filter((entry): entry is typeof entry & { direction: { dx: number; dy: number } } => entry.direction !== null)
      .sort((left, right) => left.distanceDeg - right.distanceDeg)
      .slice(0, 5);
    const occupied: DirectionGuidePlacement[] = [];
    for (const { target, distanceDeg, direction } of candidates) {
      const placement = placeDirectionGuide(width, height, direction.dx, direction.dy, occupied);
      occupied.push(placement);
      const layer = this.assetTargets.get(target.assetId);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "aladin-direction-guide";
      button.dataset.assetId = target.assetId;
      button.style.left = `${placement.x}px`;
      button.style.top = `${placement.y}px`;
      button.style.width = `${placement.width}px`;
      button.style.height = `${placement.height}px`;
      button.style.setProperty("--asset-color", layer?.color ?? "#38c8b5");
      button.title = `前往 ${layer?.label ?? target.assetId} 的数据点`;
      button.setAttribute("aria-label", `${button.title}，距离 ${formatGuideDistance(distanceDeg)}`);

      const arrow = document.createElement("span");
      arrow.className = "aladin-direction-guide-arrow";
      arrow.setAttribute("aria-hidden", "true");
      arrow.style.setProperty("--direction-angle", `${Math.atan2(direction.dy, direction.dx)}rad`);
      const icon = document.createElement("i");
      icon.dataset.lucide = "arrow-right";
      arrow.append(icon);
      const label = document.createElement("span");
      label.className = "aladin-direction-guide-name";
      label.textContent = layer?.label ?? target.assetId;
      const distance = document.createElement("span");
      distance.className = "aladin-direction-guide-distance";
      distance.textContent = formatGuideDistance(distanceDeg);
      button.append(arrow, label, distance);
      button.addEventListener("click", () => {
        const targetFov = Math.min(this.getCurrentView().fovDeg, layer?.defaultFovDeg ?? this.snapshot.initialFovDeg);
        // The confirmed anchor can be newer than a cached empty viewport.
        if (this.activeSession) this.activeSession.coveredRects = [];
        this.gotoRaDec(target.raDeg, target.decDeg);
        this.setFov(targetFov);
      });
      host.append(button);
    }
    createIcons({ icons: { ArrowRight }, attrs: { "aria-hidden": "true" } });
    this.host.dataset.directionGuideCount = String(candidates.length);
  }

  private async maybeAutoAnchor(session: ViewportSession, generation: number, signal?: AbortSignal): Promise<void> {
    if (!this.initialViewport || session.renderedObjectIds.size) return;
    if (signal?.aborted) return;
    this.cancelAutoAnchor();
    const controller = new AbortController();
    const abortFromRequest = (): void => controller.abort();
    signal?.addEventListener("abort", abortFromRequest, { once: true });
    this.autoAnchorController = controller;
    try {
      const abortPending = new Promise<void>((resolve) => controller.signal.addEventListener("abort", () => resolve(), { once: true }));
      await Promise.race([this.directionTargetsPromise, abortPending]);
      if (this.disposed || generation !== this.generation || controller.signal.aborted || !this.initialViewport) return;
      const view = this.getCurrentView();
      const target = [...this.directionTargets.values()]
        .sort((left, right) => angularDistanceDeg(view.raDeg, view.decDeg, left.raDeg, left.decDeg)
          - angularDistanceDeg(view.raDeg, view.decDeg, right.raDeg, right.decDeg))[0];
      if (!target) return;
      if (target.record) {
        session.indexing ||= Boolean(target.indexing);
        this.appendRecords(session, [target.record]);
        this.emitSessionStatus(session, false);
      }
      this.initialViewport = false;
      this.autoAnchorController = null;
      // A confirmed point supersedes the empty entry result, including when
      // its coordinate overlaps the rectangle previously cached as empty.
      session.coveredRects = [];
      this.gotoRaDec(target.raDeg, target.decDeg);
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      signal?.removeEventListener("abort", abortFromRequest);
      if (this.autoAnchorController === controller) this.autoAnchorController = null;
    }
  }

  private cancelAutoAnchor(): void {
    this.autoAnchorController?.abort();
    this.autoAnchorController = null;
  }

  private sessionKey(assetIds: readonly string[]): string {
    return `${this.snapshot.nside}:${this.snapshot.pixels.join(",")}:${this.snapshot.sourceKeys.join(",")}:${JSON.stringify(this.scopesForLayers(assetIds))}`;
  }

  private activateSession(assetIds: readonly string[]): ViewportSession {
    const normalized = [...new Set(assetIds)].sort();
    const key = this.sessionKey(normalized);
    let session = this.sessions.get(key);
    if (!session) {
      session = {
        key,
        assetIds: normalized,
        coveredRects: [],
        pendingRects: [],
        renderedObjectIds: new Set(),
          catalogs: [],
          catalogsByLayer: new Map(),
          overlapCatalog: null,
          densityCatalogs: new Map(),
          densityNside: 1,
          densityCells: new Map(),
          overlapSources: new Map(),
          overlapBuckets: new Map(),
          catalogColors: new Set(),
          returnedByAsset: new Map(),
        total: 0,
        truncated: false,
        seeded: false,
        indexing: false,
        lastUsed: Date.now(),
      };
      this.sessions.set(key, session);
    }
    if (this.activeSession !== session) {
      this.activeSession?.catalogs.forEach((catalog) => catalog.hide?.());
      this.activeSession?.densityCatalogs.forEach((catalog) => catalog.hide?.());
      session.catalogs.forEach((catalog) => catalog.show?.());
      session.densityCatalogs.forEach((catalog) => catalog.show?.());
      this.activeSession = session;
      this.densityLabelLayer?.replaceChildren();
      this.densityLabels.clear();
      this.positionDensityLabels();
      this.evictSessions(session);
    }
    session.lastUsed = Date.now();
    return session;
  }

  private evictSessions(active: ViewportSession): void {
    while (this.sessions.size > MAX_VIEWPORT_SESSIONS) {
      const candidate = [...this.sessions.values()]
        .filter((session) => session !== active)
        .sort((left, right) => left.lastUsed - right.lastUsed)[0];
      if (!candidate) return;
      this.removeSession(candidate);
    }
  }

  private removeSession(session: ViewportSession): void {
    session.catalogs.forEach((catalog) => {
      if (this.aladin?.removeCatalog) this.aladin.removeCatalog(catalog);
      else catalog.removeAll?.();
    });
    session.densityCatalogs.forEach((catalog) => {
      if (this.aladin?.removeCatalog) this.aladin.removeCatalog(catalog);
      else catalog.removeAll?.();
    });
    this.sessions.delete(session.key);
    if (this.activeSession === session) this.activeSession = null;
  }

  private emitSessionStatus(session: ViewportSession, complete: boolean, density?: AladinExplorerStatus): void {
    const returned = density?.returned ?? session.renderedObjectIds.size;
    const regionPointState = this.regionPointState();
    const indexing = session.indexing || regionPointState === "indexing";
    const locating = !returned && regionPointState === "loading";
    const imagesOnly = session.assetIds.length > 0 && session.assetIds.every(id => this.assetTargets.get(id)?.pointKind === "image_center");
    this.emitStatus({
      phase: returned ? "ready" : locating || indexing ? "loading" : regionPointState === "error" ? "error" : "empty",
      returned,
      total: density?.total ?? Math.max(session.total, returned),
      truncated: session.truncated,
      complete: complete && !indexing && !locating,
      indexing,
      regionPointState,
      displayMode: density ? "density" : "points",
      densityCells: density?.densityCells,
      message: returned ? undefined : indexing ? "坐标索引生成中，已完成的数据点会自动更新"
        : locating ? "当前视野暂无数据点，正在查找选区内的数据点…"
          : regionPointState === "available" ? "当前视野暂无数据点，可点击方向箭头前往选区内的数据位置。"
            : regionPointState === "error" ? "选区点位查询失败，暂时无法判断选区是否为空，请重试。"
              : imagesOnly ? "所选区块有影像覆盖，但没有已索引的影像中心点。影像范围可能延伸至此，中心位于区块外。"
                : "所选区块有覆盖记录，但没有已索引数据点。",
      assets: density?.assets ?? this.assetProgress(session, returned ? "ready" : "idle"),
      overlapCount: session.overlapSources.size,
    });
  }

  private assetProgress(session: ViewportSession, phase: AladinExplorerStatus["phase"] | "idle"): AladinAssetProgress[] {
    return this.snapshot.assetTargets
      .filter((target) => session.assetIds.includes(target.assetId))
      .map((target) => ({
        assetId: target.assetId,
        label: target.label,
        color: target.color,
        returned: session.returnedByAsset.get(target.assetId) ?? 0,
        total: Math.max(target.objectCount ?? 0, session.returnedByAsset.get(target.assetId) ?? 0, session.assetIds.length === 1 ? session.total : 0),
        truncated: session.truncated,
        cacheState: phase === "loading"
          ? "loading"
          : session.coveredRects.length
            ? "cached"
            : session.seeded
              ? "seeded"
              : "idle",
      }));
  }

  private renderSeedRecords(): void {
    if (!this.callbacks.initialRecords) return;
    const entries = [...this.selectedLayerIds].map((id) => [id, this.callbacks.initialRecords!.get(id)] as const);
    const records = entries.flatMap(([, entry]) => entry?.records ?? []);
    const total = entries.reduce((sum, [, entry]) => sum + (entry?.total ?? 0), 0);
    const truncated = entries.some(([, entry]) => Boolean(entry?.truncated));
    const session = this.activateSession([...this.selectedLayerIds]);
    if (records.length && !session.seeded) {
      session.seeded = true;
      session.total = Math.max(session.total, total);
      session.truncated ||= truncated;
      this.appendRecords(session, records);
      this.emitSessionStatus(session, false);
    }
  }

  private appendRecords(session: ViewportSession, records: readonly AstroObjectRecord[]): AstroObjectRecord[] {
    if (!this.aladin || this.disposed) return [];
    const addedRecords: AstroObjectRecord[] = [];
    const groups = new Map<string, { layer: AladinLayerDescriptor; records: AstroObjectRecord[] }>();
    records.forEach((record) => {
      if (session.renderedObjectIds.has(record.object_id)) return;
      session.renderedObjectIds.add(record.object_id);
      addedRecords.push(record);
      for (const key of session.assetIds) if (this.scopesForLayers([key]).some((scope) => scope.assetId === record.asset_id && (!scope.sourceId || scope.sourceId === record.attributes?.source_id))) {
        session.returnedByAsset.set(key, (session.returnedByAsset.get(key) ?? 0) + 1);
        this.regionPointStates.set(key, "available");
        if (!this.directionTargets.has(key)) this.directionTargets.set(key, { assetId: key, raDeg: record.ra_deg, decDeg: record.dec_deg });
      }
      const layer = this.callbacks.resolveLayer(record);
      const group = groups.get(layer.key) ?? { layer, records: [] };
      group.records.push(record);
      groups.set(layer.key, group);
    });
    groups.forEach(({ layer, records: groupRecords }) => {
      let catalog = session.catalogsByLayer.get(layer.key);
      if (!catalog) {
        catalog = A.catalog({
          name: layer.label,
          color: layer.color,
          sourceSize: 9,
          shape: "circle",
        });
        catalog.selectSize = 24;
        this.aladin.addCatalog(catalog);
        session.catalogs.push(catalog);
        session.catalogsByLayer.set(layer.key, catalog);
        session.catalogColors.add(layer.color);
        this.host.dataset.catalogColors = [...session.catalogColors].join(",");
      }
      const sources = groupRecords.map((record) => A.source(
        record.ra_deg,
        record.dec_deg,
        {
          record,
          objectId: record.object_id,
          label: layer.label,
          layerColor: layer.color,
        },
        { color: layer.color },
      ));
      catalog.addSources(sources);
    });
    addedRecords.forEach((record) => {
      if (record.attributes?.position_role === "image_center" || record.attributes?.position_role === "pointing") return;
      const key = overlapBucketKey(record);
      const bucket = session.overlapBuckets.get(key) ?? [];
      bucket.push(record);
      session.overlapBuckets.set(key, bucket);
      if (new Set(bucket.map((candidate) => candidate.asset_id).filter(Boolean)).size > 1) {
        this.updateOverlapMarker(session, key, bucket);
      }
    });
    return addedRecords;
  }

  private async appendRecordsInBatches(session: ViewportSession, records: readonly AstroObjectRecord[], signal: AbortSignal): Promise<void> {
    for (let offset = 0; offset < records.length; offset += POINT_RENDER_BATCH_SIZE) {
      if (signal.aborted || this.disposed) return;
      this.appendRecords(session, records.slice(offset, offset + POINT_RENDER_BATCH_SIZE));
      if (offset + POINT_RENDER_BATCH_SIZE < records.length) {
        await yieldToBrowser();
        if (signal.aborted || this.disposed) return;
      }
    }
  }

  private updateOverlapMarker(session: ViewportSession, key: string, records: AstroObjectRecord[]): void {
    if (!this.aladin || records.length < 2) return;
    const assetRecords = new Map<string, AstroObjectRecord>();
    records.forEach((record) => {
      if (record.asset_id && !assetRecords.has(record.asset_id)) assetRecords.set(record.asset_id, record);
    });
    if (assetRecords.size < 2) return;
    if (!session.overlapCatalog) {
      session.overlapCatalog = A.catalog({
        name: "多资产重合点",
        color: "#f4fffd",
        sourceSize: 18,
        shape: (source: any, context: CanvasRenderingContext2D) => drawOverlapMarker(source, context),
      });
      session.overlapCatalog.selectSize = 28;
      this.aladin.addCatalog(session.overlapCatalog);
      session.catalogs.push(session.overlapCatalog);
    }
    const previous = session.overlapSources.get(key);
    if (previous) session.overlapCatalog.removeSources?.([previous]);
    const colors = [...assetRecords.values()].slice(0, 4).map((record) => this.callbacks.resolveLayer(record).color);
    colors.forEach((color) => session.catalogColors.add(color));
    const representative = records[0]!;
    const source = A.source(representative.ra_deg, representative.dec_deg, {
      record: representative,
      records: [...records],
      objectId: representative.object_id,
      label: "多资产重合点",
      overlap: true,
      overlapCount: assetRecords.size,
      overlapColors: colors,
    });
    session.overlapCatalog.addSources([source]);
    session.overlapSources.set(key, source);
    this.host.dataset.catalogColors = [...session.catalogColors].join(",");
    this.host.dataset.overlapCount = String(session.overlapSources.size);
  }

  private toObjectPoint(record: AstroObjectRecord, overlap?: Pick<SurveyObjectPoint, "overlapCount" | "overlapAssetIds">): SurveyObjectPoint {
    const layer = this.callbacks.resolveLayer(record);
    return {
      objectId: record.object_id,
      raDeg: record.ra_deg,
      decDeg: record.dec_deg,
      assetId: record.asset_id,
      surveyId: record.survey,
      releaseId: record.release,
      product: record.product,
      modality: record.modality,
      attributes: record.attributes,
      label: layer.label,
      color: layer.color,
      ...overlap,
    };
  }

  private disposeAladin(): void {
    this.aladin?.destroy?.();
    this.aladin?.dispose?.();
    this.aladin = null;
  }

  private renderRegionOutline(): void {
    const outline = this.snapshot.regionOutline;
    if (!outline?.pixels.length || !this.aladin || !A?.graphicOverlay || !A?.polygon) return;
    if (outline.pixels.length > REGION_OUTLINE_CELL_LIMIT) {
      this.host.dataset.regionOutline = "skipped";
      return;
    }
    const healpix = new Healpix(outline.nside);
    const overlay = A.graphicOverlay({ name: "Selected region", color: outline.color, lineWidth: 2 });
    this.aladin.addOverlay(overlay);
    for (const pixel of outline.pixels) {
      const vertices = healpix.getBoundaries(pixel).map((vertex) => [
        normalizeRa(Math.atan2(vertex.y, vertex.x) * 180 / Math.PI),
        Math.asin(Math.max(-1, Math.min(1, vertex.z))) * 180 / Math.PI,
      ]);
      overlay.add(A.polygon(vertices, { color: outline.color, lineWidth: 2, fill: false }));
    }
    this.host.dataset.regionOutline = String(outline.pixels.length);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.removeInteractionListeners?.();
    this.removeInteractionListeners = null;
    this.cancelAutoAnchor();
    this.pointDetailController?.abort();
    this.directionAnchorController?.abort();
    this.directionAnchorController = null;
    this.directionAnchorGeneration += 1;
    this.generation += 1;
    this.activeRequest?.controller.abort();
    this.activeRequest = null;
    if (this.queryTimer) clearTimeout(this.queryTimer);
    this.queryTimer = null;
    if (this.indexRefreshTimer) clearTimeout(this.indexRefreshTimer);
    this.indexRefreshTimer = null;
    if (this.directionGuideTimer) clearTimeout(this.directionGuideTimer);
    this.directionGuideTimer = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.themeObserver?.disconnect();
    this.themeObserver = null;
    this.pendingView = null;
    this.pendingViewExpiresAt = 0;
    [...this.sessions.values()].forEach((session) => this.removeSession(session));
    this.sessions.clear();
    this.activeSession = null;
    this.disposeAladin();
    this.directionGuideLayer = null;
    this.densityLabelLayer = null;
    this.densityLabels.clear();
    this.host.replaceChildren();
  }
}
