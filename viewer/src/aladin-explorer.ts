import A from "aladin-lite";

import type { AstroObjectRecord, ObjectRegionQueryInput } from "../../src/astro-object-index";
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
  assetTargets: AladinAssetTarget[];
  initialAssetId?: string;
}

export interface AladinAssetTarget {
  assetId: string;
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
  overlapSources: Map<string, any>;
  overlapBuckets: Map<string, AstroObjectRecord[]>;
  catalogColors: Set<string>;
  returnedByAsset: Map<string, number>;
  total: number;
  truncated: boolean;
  seeded: boolean;
  lastUsed: number;
}

interface ActiveRequest {
  controller: AbortController;
  generation: number;
  session: ViewportSession;
  jobs: QueryRect[];
}

type PointShape = "circle" | "square" | "diamond" | "triangle" | "plus";

const QUERY_LIMIT = 1000;
const QUERY_DEBOUNCE_MS = 200;
const MIN_FOV_DEG = 0.05;
const MAX_FOV_DEG = 180;
const MAX_VIEWPORT_SESSIONS = 3;
const MAX_SESSION_RECORDS = 50_000;

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function fovWidth(fov: unknown, fallback: number): number {
  if (Array.isArray(fov)) return Math.max(MIN_FOV_DEG, finiteNumber(fov[0], fallback));
  return Math.max(MIN_FOV_DEG, finiteNumber(fov, fallback));
}

function viewportBoxes(view: AladinExplorerView, host: HTMLElement): QueryRect[] {
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

function pointShapeFor(key: string): PointShape {
  const shapes: PointShape[] = ["circle", "diamond", "square", "triangle", "plus"];
  let hash = 2166136261;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return shapes[(hash >>> 0) % shapes.length]!;
}

function createPointMarker(color: string, shape: PointShape, configuredSize = 6): HTMLCanvasElement {
  const size = Math.max(8, Math.round(configuredSize + 3));
  const marker = document.createElement("canvas");
  marker.width = size;
  marker.height = size;
  const context = marker.getContext("2d")!;
  const center = size / 2;
  const radius = Math.max(2, center - 1);
  context.fillStyle = color;
  context.strokeStyle = color;
  context.lineWidth = Math.max(1.25, size / 6);
  context.beginPath();
  if (shape === "square") {
    context.rect(1, 1, size - 2, size - 2);
  } else if (shape === "diamond") {
    context.moveTo(center, 0.5);
    context.lineTo(size - 0.5, center);
    context.lineTo(center, size - 0.5);
    context.lineTo(0.5, center);
    context.closePath();
  } else if (shape === "triangle") {
    context.moveTo(center, 0.5);
    context.lineTo(size - 0.5, size - 0.5);
    context.lineTo(0.5, size - 0.5);
    context.closePath();
  } else if (shape === "plus") {
    context.moveTo(center, 1);
    context.lineTo(center, size - 1);
    context.moveTo(1, center);
    context.lineTo(size - 1, center);
  } else {
    context.arc(center, center, radius, 0, Math.PI * 2);
  }
  if (shape === "plus") context.stroke();
  else context.fill();
  return marker;
}

function drawPointMarker(source: any, context: CanvasRenderingContext2D, marker: HTMLCanvasElement): void {
  const point = sourceScreenPoint(source);
  if (!point) return;
  context.globalAlpha = 1;
  context.drawImage(marker, point.x - marker.width / 2, point.y - marker.height / 2);
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
  private readonly assetTargets = new Map<string, AladinAssetTarget>();
  private readonly sessions = new Map<string, ViewportSession>();
  private aladin: any = null;
  private activeSession: ViewportSession | null = null;
  private activeRequest: ActiveRequest | null = null;
  private queryTimer: ReturnType<typeof setTimeout> | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private generation = 0;
  private disposed = false;
  private pendingView: AladinExplorerView | null = null;
  private pendingViewExpiresAt = 0;
  private activeAssetId: string | null;
  private lastObjectClickAt = 0;

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
      : this.snapshot.assetTargets[0]?.assetId ?? null;
    this.ready = this.initialize();
  }

  private async initialize(): Promise<void> {
    this.emitStatus({ phase: "initializing", returned: 0, total: 0, truncated: false });
    await Promise.resolve(A.init);
    if (this.disposed) return;

    const selector = this.host.id ? `#${this.host.id}` : this.host;
    this.aladin = A.aladin(selector, {
       survey: "https://alasky.cds.unistra.fr/2MASS/Color",
      fov: this.snapshot.initialFovDeg,
      cooFrame: "ICRS",
      projection: "AIT",
      showCooGrid: true,
      gridOptions: {
         color: "rgb(131, 210, 212)",
        opacity: 0.45,
        thickness: 1,
        showLabels: true,
        labelSize: 10,
      },
      inertia: false,
      reticleColor: "rgb(159, 231, 224)",
      reticleSize: 24,
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
       showReticle: true,
    });
     if (this.disposed) {
       this.disposeAladin();
       return;
     }
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
      this.scheduleQuery(QUERY_DEBOUNCE_MS);
      window.setTimeout(() => {
        if (!this.disposed) this.callbacks.onViewChange?.(this.getCurrentView());
      }, 0);
    };
    this.aladin.on?.("positionChanged", onViewChange);
    this.aladin.on?.("zoomChanged", onViewChange);
    this.aladin.on?.("viewChanged", onViewChange);
    this.aladin.on?.("objectClicked", (source: any) => {
      const record = source?.data?.record as AstroObjectRecord | undefined;
      if (record) {
        this.lastObjectClickAt = Date.now();
        this.host.dataset.objectSelected = record.object_id;
        this.callbacks.onObject(this.toObjectPoint(record, source?.data?.overlap ? {
          overlapCount: Number(source.data.overlapCount) || undefined,
          overlapAssetIds: Array.isArray(source.data.records)
            ? source.data.records.map((candidate: AstroObjectRecord) => candidate.asset_id).filter((assetId: unknown): assetId is string => typeof assetId === "string")
            : undefined,
        } : undefined));
      }
    });
    this.aladin.on?.("click", (event: any) => {
      if (!event?.isDragging && Date.now() - this.lastObjectClickAt > 350) {
        delete this.host.dataset.objectSelected;
        this.callbacks.onObject(null);
      }
    });
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

  getActiveAssetId(): string | null {
    return this.activeAssetId;
  }

  focusAsset(assetId: string | null): void {
    if (assetId !== null && !this.assetTargets.has(assetId)) return;
    this.activateSession(assetId ? [assetId] : [...(this.snapshot.filters.assetIds ?? [])]);
    this.activeAssetId = assetId;
    this.callbacks.onAssetChange?.(assetId);
    const target = assetId ? this.assetTargets.get(assetId) : undefined;
    this.gotoRaDec(target?.centerRaDeg ?? this.snapshot.centerRaDeg, target?.centerDecDeg ?? this.snapshot.centerDecDeg);
    this.setFov(target?.defaultFovDeg ?? this.snapshot.initialFovDeg);
    this.renderSeedRecords();
  }

  gotoRaDec(raDeg: number, decDeg: number): void {
    if (!this.aladin || this.disposed) return;
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
    this.focusAsset(this.snapshot.initialAssetId ?? this.snapshot.assetTargets[0]?.assetId ?? null);
  }

  private scheduleQuery(delayMs: number): void {
    if (this.disposed || !this.aladin) return;
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
    const boxes = viewportBoxes(view, this.host);
    const assetIds = this.activeAssetId ? [this.activeAssetId] : [...(this.snapshot.filters.assetIds ?? [])];
    if (!assetIds.length) {
      this.emitStatus({ phase: "empty", returned: 0, total: 0, truncated: false, message: "当前选区没有可探索的用户资产对象" });
      return;
    }
    const session = this.activateSession(assetIds);
    session.lastUsed = Date.now();
    const jobs = subtractRects(boxes, [...session.coveredRects, ...session.pendingRects]);
    if (!jobs.length) {
      this.emitSessionStatus(session, true);
      return;
    }
    const controller = new AbortController();
    const request: ActiveRequest = { controller, generation, session, jobs };
    this.activeRequest = request;
    jobs.forEach((job) => session.pendingRects.push(job));
      this.emitStatus({ phase: "loading", returned: session.renderedObjectIds.size, total: session.total, truncated: session.truncated, complete: false, assets: this.assetProgress(session, "loading"), overlapCount: session.overlapSources.size });
    try {
      for (const bbox of jobs) {
        let cursor: unknown[] | undefined;
        let firstPage = true;
        const seenCursors = new Set<string>();
        let jobComplete = false;
        while (true) {
          const input: ObjectRegionQueryInput = {
            bbox,
            region: {
              nside: this.snapshot.nside,
              pixels: this.snapshot.pixels,
              coordinateFrame: "ICRS",
              ordering: "NESTED",
            },
            coordinateFrame: "ICRS",
            ordering: "NESTED",
            assetIds,
            limit: QUERY_LIMIT,
            includeAttributes: false,
            cursor,
          };
          const result = await workspaceApi.skyObjectsQuery(input, controller.signal);
          if (this.disposed || generation !== this.generation || controller.signal.aborted) return;
          if (result.status === "error") throw new Error(result.message ?? "对象查询失败");
          if (firstPage) firstPage = false;
          this.appendRecords(session, result.objects);
          session.total = Math.max(session.total, result.total);
          const nextCursor = nextPageCursor(result);
          const cursorKey = nextCursor ? JSON.stringify(nextCursor) : "";
          const hasMore = Boolean(nextCursor?.length && result.objects.length && !seenCursors.has(cursorKey));
          if (hasMore) seenCursors.add(cursorKey);
          const budgetReached = session.renderedObjectIds.size >= MAX_SESSION_RECORDS;
          this.emitStatus({
            phase: "loading",
            returned: session.renderedObjectIds.size,
            total: session.total,
            truncated: hasMore || budgetReached,
            complete: false,
            assets: this.assetProgress(session, "loading"),
            overlapCount: session.overlapSources.size,
          });
          if (!hasMore || budgetReached) {
            session.truncated ||= hasMore || budgetReached;
            jobComplete = true;
            break;
          }
          cursor = nextCursor;
          await yieldToBrowser();
          if (this.disposed || generation !== this.generation || controller.signal.aborted) return;
        }
        if (jobComplete) {
          session.coveredRects.push(bbox);
          session.coveredRects = compactRects(session.coveredRects);
        }
      }
      this.emitSessionStatus(session, true);
    } catch (error) {
      if (controller.signal.aborted || this.disposed || generation !== this.generation) return;
      this.emitStatus({ phase: "error", returned: session.renderedObjectIds.size, total: session.total, truncated: session.truncated, complete: true, message: error instanceof Error ? error.message : String(error) });
    } finally {
      jobs.forEach((job) => {
        const index = session.pendingRects.indexOf(job);
        if (index >= 0) session.pendingRects.splice(index, 1);
      });
      if (this.activeRequest === request) this.activeRequest = null;
    }
  }

  private sessionKey(assetIds: readonly string[]): string {
    return `${this.snapshot.nside}:${this.snapshot.pixels.join(",")}:${assetIds.join(",")}`;
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
          overlapSources: new Map(),
          overlapBuckets: new Map(),
          catalogColors: new Set(),
          returnedByAsset: new Map(),
        total: 0,
        truncated: false,
        seeded: false,
        lastUsed: Date.now(),
      };
      this.sessions.set(key, session);
    }
    if (this.activeSession !== session) {
      this.activeSession?.catalogs.forEach((catalog) => catalog.hide?.());
      session.catalogs.forEach((catalog) => catalog.show?.());
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
      complete,
      message: returned ? undefined : "当前资产在此视野没有对象；可点击资产导航聚焦",
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
        total: target.objectCount ?? (session.assetIds.length === 1 ? session.total : 0),
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
    const entries = this.activeAssetId
      ? [[this.activeAssetId, this.callbacks.initialRecords.get(this.activeAssetId)] as const]
      : [...this.callbacks.initialRecords.entries()];
    const records = entries.flatMap(([, entry]) => entry?.records ?? []);
    const total = entries.reduce((sum, [, entry]) => sum + (entry?.total ?? 0), 0);
    const truncated = entries.some(([, entry]) => Boolean(entry?.truncated));
    const session = this.activateSession(this.activeAssetId ? [this.activeAssetId] : [...(this.snapshot.filters.assetIds ?? [])]);
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
      if (session.renderedObjectIds.has(record.object_id) || session.renderedObjectIds.size >= MAX_SESSION_RECORDS) return;
      session.renderedObjectIds.add(record.object_id);
      addedRecords.push(record);
      if (record.asset_id) session.returnedByAsset.set(record.asset_id, (session.returnedByAsset.get(record.asset_id) ?? 0) + 1);
      const layer = this.callbacks.resolveLayer(record);
      const group = groups.get(layer.key) ?? { layer, records: [] };
      group.records.push(record);
      groups.set(layer.key, group);
    });
    groups.forEach(({ layer, records: groupRecords }) => {
      let catalog = session.catalogsByLayer.get(layer.key);
      if (!catalog) {
        const marker = createPointMarker(layer.color, pointShapeFor(layer.key), 6);
        catalog = A.catalog({
          name: layer.label,
          color: layer.color,
          sourceSize: marker.width,
          shape: (_source: any, context: CanvasRenderingContext2D) => drawPointMarker(_source, context, marker),
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
    this.generation += 1;
    this.activeRequest?.controller.abort();
    this.activeRequest = null;
    if (this.queryTimer) clearTimeout(this.queryTimer);
    this.queryTimer = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.pendingView = null;
    this.pendingViewExpiresAt = 0;
    [...this.sessions.values()].forEach((session) => this.removeSession(session));
    this.sessions.clear();
    this.activeSession = null;
    this.disposeAladin();
    this.host.replaceChildren();
  }
}
