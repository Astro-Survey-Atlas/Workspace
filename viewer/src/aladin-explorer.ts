import A from "aladin-lite";
import { Healpix, Pointing } from "healpixjs";

import type { AstroObjectRecord, AstroPointDensityLayerInput, AstroPointDensityResult, ObjectRegionQueryInput, SkyDataPointScope } from "../../src/astro-object-index";
import { workspaceApi } from "./api";
import { clampDec, normalizeRa } from "./coordinates";
import type { SurveyObjectPoint } from "./survey-layer-viewer";
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
}

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
}

export interface AladinExplorerCallbacks {
  resolveLayer: (record: AstroObjectRecord) => AladinLayerDescriptor;
  onObject: (point: SurveyObjectPoint | null) => void;
  onStatus: (status: AladinExplorerStatus) => void;
  onViewChange?: (view: AladinExplorerView) => void;
  onAssetChange?: (assetId: string | null) => void;
  onDensityHover?: (detail: { pixel: number; nside: number; total: number; layers: Array<{ id: string; label: string; color: string; count: number }> } | null) => void;
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
const DENSITY_FOV_THRESHOLD = 0.75;
const DENSITY_TARGET_CELL_PX = 80;
const MIN_FOV_DEG = 0.05;
const MAX_FOV_DEG = 180;
const MAX_VIEWPORT_SESSIONS = 3;

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function fovWidth(fov: unknown, fallback: number): number {
  if (Array.isArray(fov)) return Math.max(MIN_FOV_DEG, finiteNumber(fov[0], fallback));
  return Math.max(MIN_FOV_DEG, finiteNumber(fov, fallback));
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
        const point = aladin.pix2world(width * xRatio, height * yRatio);
        if (Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1])) {
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
  const horizontalFov = view.fovDeg;
  const verticalFov = horizontalFov / aspect;
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
  private aladin: any = null;
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
  private autoAnchorAttempted = false;
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
    this.aladin.setFov(initialTarget?.defaultFovDeg ?? this.snapshot.initialFovDeg);
    this.bindEvents();
    this.resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => this.scheduleQuery(0));
    this.resizeObserver?.observe(this.host);
    this.renderSeedRecords();
    this.callbacks.onAssetChange?.(this.activeAssetId);
    this.scheduleQuery(0);
  }

  private bindEvents(): void {
    const onViewChange = (): void => {
      if (Date.now() >= this.pendingViewExpiresAt) this.pendingView = null;
      if (!this.pendingView) {
        const current = this.getCurrentView();
        const sameCenter = Math.abs(((current.raDeg - this.snapshot.centerRaDeg + 540) % 360) - 180) < 0.001
          && Math.abs(current.decDeg - this.snapshot.centerDecDeg) < 0.001;
        if (!sameCenter || Math.abs(current.fovDeg - this.snapshot.initialFovDeg) >= 0.001) {
          this.initialViewport = false;
          this.cancelAutoAnchor();
        }
      }
      this.scheduleQuery(QUERY_DEBOUNCE_MS);
      window.setTimeout(() => {
        if (!this.disposed) this.callbacks.onViewChange?.(this.getCurrentView());
      }, 0);
    };
    this.aladin.on?.("positionChanged", onViewChange);
    this.aladin.on?.("zoomChanged", onViewChange);
    this.aladin.on?.("viewChanged", onViewChange);
    this.aladin.on?.("objectClicked", (source: any) => {
      if (source?.data?.kind === "density") {
        this.emitDensityHover(source);
        return;
      }
      const record = source?.data?.record as AstroObjectRecord | undefined;
      if (record) {
        this.lastObjectClickAt = Date.now();
        void workspaceApi.skyPointDetail(record.object_id).then(({ point }) => { if (!this.disposed && this.host.dataset.objectSelected === point.object_id) this.callbacks.onObject(this.toObjectPoint(point)); }).catch(() => undefined);
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
    const layers = Array.isArray(data.layers) ? data.layers.map((entry: { id: string; count: number }) => {
      const target = this.assetTargets.get(entry.id);
      return { id: entry.id, label: target?.label ?? entry.id, color: target?.color ?? "#ffffff", count: Number(entry.count) || 0 };
    }) : [];
    this.callbacks.onDensityHover?.({ pixel: Number(data.pixel), nside: Number(data.nside), total: Number(data.total) || 0, layers });
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
    this.emitDensityHover(cell ? { data: { kind: "density", pixel, nside: session.densityNside, total: cell.count, layers: cell.layers } } : null);
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
    this.callbacks.onStatus(status);
  }

  private getCurrentView(): AladinExplorerView {
    if (this.pendingView && Date.now() < this.pendingViewExpiresAt) return this.pendingView;
    this.pendingView = null;
    const raDec = this.aladin?.getRaDec?.();
    const fov = this.aladin?.getFov?.();
    const raDeg = normalizeRa(Array.isArray(raDec) ? finiteNumber(raDec[0], this.snapshot.centerRaDeg) : this.snapshot.centerRaDeg);
    const decDeg = clampDec(Array.isArray(raDec) ? finiteNumber(raDec[1], this.snapshot.centerDecDeg) : this.snapshot.centerDecDeg);
    const width = fovWidth(fov, this.snapshot.initialFovDeg);
    return { raDeg, decDeg, fovDeg: Math.min(MAX_FOV_DEG, width) };
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
    if (selected) this.selectedLayerIds.add(layerId); else this.selectedLayerIds.delete(layerId);
    this.activeAssetId = this.selectedLayerIds.size === 1 ? [...this.selectedLayerIds][0]! : null;
    this.activateSession([...this.selectedLayerIds]);
    this.callbacks.onAssetChange?.(this.activeAssetId);
    this.renderSeedRecords(); this.scheduleQuery(0);
  }

  focusAsset(assetId: string | null): void {
    this.cancelAutoAnchor();
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
    const nextRa = normalizeRa(raDeg);
    const nextDec = clampDec(decDeg);
    const current = this.getCurrentView();
    this.aladin.gotoRaDec(nextRa, nextDec);
    this.pendingView = { raDeg: nextRa, decDeg: nextDec, fovDeg: current.fovDeg };
    this.pendingViewExpiresAt = Date.now() + 700;
    this.scheduleQuery(0);
  }

  setFov(fovDeg: number): void {
    if (!this.aladin || this.disposed) return;
    this.cancelAutoAnchor();
    const nextFov = Math.max(MIN_FOV_DEG, Math.min(MAX_FOV_DEG, fovDeg));
    const current = this.getCurrentView();
    this.aladin.setFov(nextFov);
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
    this.activeRequest?.controller.abort();
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
    this.densityModeActive = false;
    this.lastDensityHoverKey = null;
    this.callbacks.onDensityHover?.(null);
    if (!assetIds.length || !this.scopesForLayers(assetIds).length) {
      this.activateSession(assetIds);
      this.emitStatus({ phase: "empty", returned: 0, total: 0, truncated: false, message: assetIds.length ? "所选图层仅有覆盖；下载并扫描后可显示数据点" : "当前未选中数据图层" });
      return;
    }
    const session = this.activateSession(assetIds);
    session.lastUsed = Date.now();
    if (view.fovDeg > DENSITY_FOV_THRESHOLD) {
      await this.queryDensityViewport(generation, view, boxes, session, assetIds);
      return;
    }
    session.densityCatalogs.forEach(catalog => catalog.hide?.());
    session.catalogs.forEach(catalog => catalog.show?.());
    const jobs = subtractRects(boxes, [...(session.indexing ? [] : session.coveredRects), ...session.pendingRects]);
    if (!jobs.length) {
      this.emitSessionStatus(session, true);
      if (!session.renderedObjectIds.size) await this.maybeAutoAnchor(session, generation);
      return;
    }
    const controller = new AbortController();
    const request: ActiveRequest = { controller, generation, session, jobs };
    this.activeRequest = request;
    session.indexing = false;
    jobs.forEach((job) => session.pendingRects.push(job));
    this.emitStatus({ phase: "loading", displayMode: "points", returned: session.renderedObjectIds.size,
      total: session.total, truncated: false, complete: false, assets: this.assetProgress(session, "loading"),
      overlapCount: session.overlapSources.size, indexing: session.indexing });
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
              limit: QUERY_LIMIT, includeAttributes: false, cursor: cursors.get(layerId),
            };
            const result = await workspaceApi.skyPointsQuery(input, controller.signal);
            if (this.disposed || generation !== this.generation || controller.signal.aborted) return;
            if (result.status !== "ready") throw new Error(result.message ?? "数据点查询未完成");
            session.indexing ||= Boolean(result.indexing);
            if (session.indexing) session.coveredRects = [];
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
              total: session.total, truncated: false, complete: false, assets: this.assetProgress(session, "loading"),
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
      this.emitSessionStatus(session, true);
      if (!session.renderedObjectIds.size) await this.maybeAutoAnchor(session, generation, controller.signal);
    } catch (error) {
      if (controller.signal.aborted || this.disposed || generation !== this.generation) return;
      this.emitStatus({ phase: "error", returned: session.renderedObjectIds.size, total: session.total, truncated: session.truncated, complete: true, message: error instanceof Error ? error.message : String(error) });
    } finally {
      jobs.forEach((job) => {
        const index = session.pendingRects.indexOf(job);
        if (index >= 0) session.pendingRects.splice(index, 1);
      });
      if (this.activeRequest === request) this.activeRequest = null;
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
    this.densityModeActive = true;
    this.lastDensityHoverKey = null;
    this.callbacks.onDensityHover?.(null);
    session.densityCells.clear();
    session.densityCatalogs.forEach(catalog => { catalog.clear?.(); catalog.hide?.(); });
    session.catalogs.forEach(catalog => catalog.hide?.());
    const layers: AstroPointDensityLayerInput[] = assetIds.map(id => ({ id, scopes: this.assetTargets.get(id)?.scopes ?? [] }));
    const controller = new AbortController();
    const request: ActiveRequest = { controller, generation, session, jobs: boxes };
    this.activeRequest?.controller.abort();
    this.activeRequest = request;
    this.emitStatus({ phase: "loading", displayMode: "density", returned: 0, total: 0, truncated: false,
      complete: false, indexing: session.indexing, assets: this.assetProgress(session, "loading"), overlapCount: session.overlapSources.size });
    try {
      const result = await workspaceApi.skyPointDensity({
        region: { nside: this.snapshot.nside, pixels: this.snapshot.pixels, coordinateFrame: "ICRS", ordering: "NESTED" },
        boxes, layers, targetNside: this.densityNside(view),
      }, controller.signal);
      if (this.disposed || generation !== this.generation || controller.signal.aborted) return;
      if (result.status !== "ready") throw new Error(result.message ?? "密度聚合未能完成");
      session.indexing = result.indexing;
      this.renderDensityCells(session, result, layers);
      this.emitStatus({ phase: result.total ? "ready" : "empty", displayMode: "density", returned: result.cells.length,
        densityCells: result.cells.length, total: result.total, truncated: false, complete: !result.indexing,
        indexing: result.indexing, assets: this.assetProgress(session, result.total ? "ready" : "idle"), overlapCount: session.overlapSources.size,
        message: result.total ? undefined : "所选视野内没有已索引数据点" });
    } catch (error) {
      if (controller.signal.aborted || this.disposed || generation !== this.generation) return;
      this.emitStatus({ phase: "error", displayMode: "density", returned: 0, total: 0, truncated: false, complete: true,
        message: error instanceof Error ? error.message : String(error) });
    } finally {
      if (this.activeRequest === request) this.activeRequest = null;
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
          layers: entry.cell.layers,
        }, { color: target.color });
      });
      if (sources.length) catalog.addSources(sources);
      catalog.show?.();
    }
    this.host.dataset.densityNside = String(result.nside);
    this.host.dataset.densityCells = String(result.cells.length);
  }

  private async maybeAutoAnchor(session: ViewportSession, generation: number, signal?: AbortSignal): Promise<void> {
    if (!this.initialViewport || this.autoAnchorAttempted || session.indexing || session.renderedObjectIds.size) return;
    this.autoAnchorAttempted = true;
    if (signal?.aborted) return;
    const controller = new AbortController();
    const abortFromRequest = (): void => controller.abort();
    signal?.addEventListener("abort", abortFromRequest, { once: true });
    this.autoAnchorController = controller;
    try {
      const result = await workspaceApi.skyPointAnchor({
        region: { nside: this.snapshot.nside, pixels: this.snapshot.pixels, coordinateFrame: "ICRS", ordering: "NESTED" },
        layerScopes: this.scopesForLayers([...this.selectedLayerIds]), coordinateFrame: "ICRS", ordering: "NESTED",
        limit: 1, includeAttributes: false, trackTotalHits: false,
      }, controller.signal);
      if (this.disposed || generation !== this.generation || controller.signal.aborted || !this.initialViewport) return;
      if (result.status !== "ready") throw new Error(result.message ?? "首屏没有数据点，定位查询失败");
      this.initialViewport = false;
      this.autoAnchorController = null;
      if (result.point) this.gotoRaDec(result.point.raDeg, result.point.decDeg);
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

  private emitSessionStatus(session: ViewportSession, complete: boolean): void {
    const returned = session.renderedObjectIds.size;
    this.emitStatus({
      phase: returned ? "ready" : "empty",
      returned,
      total: session.total,
      truncated: session.truncated,
      complete: complete && !session.indexing,
      indexing: session.indexing,
      displayMode: "points",
      message: session.indexing ? "坐标索引生成中，已完成的数据点会自动更新" : returned ? undefined : "所选图层在当前天区和视野内没有数据点",
      assets: this.assetProgress(session, returned ? "ready" : "idle"),
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
      for (const key of session.assetIds) if (this.scopesForLayers([key]).some((scope) => scope.assetId === record.asset_id && (!scope.sourceId || scope.sourceId === record.attributes?.source_id))) session.returnedByAsset.set(key, (session.returnedByAsset.get(key) ?? 0) + 1);
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

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelAutoAnchor();
    this.generation += 1;
    this.activeRequest?.controller.abort();
    this.activeRequest = null;
    if (this.queryTimer) clearTimeout(this.queryTimer);
    this.queryTimer = null;
    if (this.indexRefreshTimer) clearTimeout(this.indexRefreshTimer);
    this.indexRefreshTimer = null;
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
    this.host.replaceChildren();
  }
}
