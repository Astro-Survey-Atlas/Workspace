import type { ScanPrecision } from "./connector-history.js";
import { parseElasticsearchEndpoint } from "./es-endpoint.js";
import { regionContainsCell, regionPixelFilter, WorkspaceDirectoryCollector, type WorkspaceDirectory, type WorkspaceFileLocation } from "./workspace-directories.js";

export const WAREHOUSE_LAYER_INDEX = "ast_layer_index_v1";
export const WAREHOUSE_FILE_INDEX = "ast_file_index_v1";
export const WAREHOUSE_COVERAGE_INDEX = "ast_coverage_index_v1";

export type WarehouseLayerState = "ACTIVE" | "UPDATING" | "FAILED" | "UNKNOWN";

export interface WarehouseLayerSnapshot {
  layerId: string;
  surveyId: string;
  releaseId: string;
  productId: string;
  modality?: string;
  coverageRole?: string;
  entrypoint?: string;
  state: WarehouseLayerState;
  scanRunId?: string;
  sourceSnapshotSha256?: string;
  availableOrders: number[];
  maxOrder?: number;
  fileCount: number;
  coverageCount: number;
  errorCount: number;
  errorSummary?: string;
  updatedAt?: string;
  layerMode?: string;
  activeScopeId?: string;
  scopeSnapshotSha256?: string;
}

export interface WarehouseCoverageSnapshot {
  layerId: string;
  sourceFileId?: string;
  sourceUri?: string;
  order: number;
  ipix: number;
  coordinateFrame?: string;
  nesting?: string;
  coverageMethod?: string;
  coverageRole?: string;
  modality?: string;
  precision?: ScanPrecision;
  sourceOrder?: number;
}

export interface WarehouseCoverageLayer {
  key: string;
  layerId: string;
  surveyId: string;
  releaseId: string;
  productId: string;
  modality?: string;
  coverageRole?: string;
  state: WarehouseLayerState;
  status: "ready" | "pending" | "error" | "unavailable";
  nside: number;
  pixels: number[];
  nativeOrders: number[];
  availableOrders: number[];
  /** MOC authority limit declared by the Warehouse layer, if present. */
  maxOrder?: number;
  precision: ScanPrecision;
  message?: string;
  source: "warehouse";
  assetIds: string[];
}

export interface WarehouseCoverageResponse {
  status: "ready" | "unavailable" | "error";
  index: string;
  nside: number;
  pixels: number[];
  layers: WarehouseCoverageLayer[];
  inactiveLayers: WarehouseLayerSnapshot[];
  message?: string;
}

export interface WarehouseCoverageCatalog {
  layers: WarehouseLayerSnapshot[];
  coverages: WarehouseCoverageSnapshot[];
  truncated: boolean;
}

export interface WarehouseIndexOptions {
  url?: string;
  layerIndex?: string;
  coverageIndex?: string;
  fileIndex?: string;
  timeoutMs?: number;
  maxDocuments?: number;
  fetchImpl?: typeof fetch;
}

interface SearchHit { _id?: string; _source?: Record<string, unknown>; sort?: unknown[] }
interface DirectoryBucket {
  key: { fileId?: string | null; layerId?: string; order?: number };
  doc_count?: number;
  matching_cell?: { value?: number };
  precisions?: { buckets?: { key?: string }[] };
  legacy_precisions?: { buckets?: { key?: string }[] };
}
interface SearchResponse {
  hits?: { hits?: SearchHit[]; total?: number | { value?: number } };
  aggregations?: { files?: { buckets?: DirectoryBucket[]; after_key?: Record<string, unknown> };
    geometry?: { buckets?: Array<{ key: { order?: number; pixel?: number }; precisions?: { buckets?: Array<{ key: string }> }; legacy_precisions?: { buckets?: Array<{ key: string }> }; source_orders?: { buckets?: Array<{ key: number }> } }>; after_key?: Record<string, unknown> } };
  timed_out?: boolean;
  _shards?: { failed?: number };
}
interface ScanBinding { scanRunId?: string; observation: boolean }
interface ProjectedGeometry { pixels: Set<number>; nativeOrders: Set<number>; availableOrders: Set<number>; precisions: Set<ScanPrecision> }

const text = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : undefined;
const number = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" && value.trim() && Number.isFinite(Number(value)) ? Number(value) : undefined;

function order(value: unknown): number | undefined {
  const result = number(value);
  return result !== undefined && Number.isInteger(result) && result >= 0 && result <= 29 ? result : undefined;
}

function layerState(value: unknown): WarehouseLayerState {
  const normalized = text(value)?.toUpperCase();
  if (normalized === "ACTIVE" || normalized === "UPDATING" || normalized === "FAILED") return normalized;
  return "UNKNOWN";
}

function precision(value: unknown): ScanPrecision | undefined {
  return value === "exact" || value === "estimated" || value === "entrypoint-only" ? value : undefined;
}

function nsideOrder(nside: number): number {
  if (!Number.isInteger(nside) || nside < 1 || (nside & (nside - 1)) !== 0 || nside > 2 ** 29) throw new RangeError("nside must be a positive power of two no greater than 2^29");
  return Math.log2(nside);
}

function validPixel(value: number, pixelOrder: number): boolean {
  if (!Number.isSafeInteger(value) || value < 0) return false;
  // Order 29 exceeds Number's exact integer range, so compare as BigInt
  // while still accepting only safely representable JSON numbers.
  return BigInt(value) < 12n * (4n ** BigInt(pixelOrder));
}

function layerFromHit(hit: SearchHit): WarehouseLayerSnapshot | undefined {
  const source = hit._source ?? {};
  const layerId = text(source.layer_id) ?? text(source.layerId) ?? hit._id;
  const surveyId = text(source.survey_id) ?? text(source.surveyId);
  const releaseId = text(source.release_id) ?? text(source.releaseId);
  const productId = text(source.product_id) ?? text(source.productId);
  if (!layerId || !surveyId || !releaseId || !productId) return undefined;
  const availableOrders = Array.isArray(source.available_orders)
    ? source.available_orders.map(order).filter((value): value is number => value !== undefined)
    : [];
  return {
    layerId, surveyId, releaseId, productId,
    modality: text(source.modality), coverageRole: text(source.coverage_role) ?? text(source.coverageRole), entrypoint: text(source.entrypoint),
    state: layerState(source.state), scanRunId: text(source.scan_run_id) ?? text(source.scanRunId),
    sourceSnapshotSha256: text(source.source_snapshot_sha256) ?? text(source.sourceSnapshotSha256),
    availableOrders: [...new Set(availableOrders)].sort((a, b) => a - b), maxOrder: order(source.max_order),
    fileCount: number(source.file_count) ?? 0, coverageCount: number(source.coverage_count) ?? 0, errorCount: number(source.error_count) ?? 0,
    errorSummary: text(source.error_summary), updatedAt: text(source.updated_at),
    layerMode: text(source.layer_mode), activeScopeId: text(source.active_scope_id), scopeSnapshotSha256: text(source.scope_snapshot_sha256),
  };
}

function coverageFromHit(hit: SearchHit, fallbackLayerId?: string): WarehouseCoverageSnapshot | undefined {
  const source = hit._source ?? {};
  const layerId = text(source.layer_id) ?? text(source.layerId) ?? fallbackLayerId;
  const coverageOrder = order(source.healpix_order ?? source.order ?? source.coverage_order);
  const ipix = number(source.healpix_cell ?? source.healpix_pixel ?? source.ipix ?? source.pixel);
  if (!layerId || coverageOrder === undefined || ipix === undefined || !validPixel(ipix, coverageOrder)) return undefined;
  return {
    layerId,
    sourceFileId: text(source.source_file_id) ?? text(source.sourceFileId), sourceUri: text(source.source_uri) ?? text(source.sourceUri) ?? text(source.uri),
    order: coverageOrder, ipix,
    coordinateFrame: text(source.coordinate_frame) ?? text(source.coordinateFrame), nesting: text(source.nesting) ?? text(source.ordering),
    coverageMethod: text(source.coverage_method) ?? text(source.coverageMethod), coverageRole: text(source.coverage_role) ?? text(source.coverageRole),
    modality: text(source.modality), precision: precision(source.precision ?? source.coverage_precision), sourceOrder: order(source.source_order),
  };
}

function total(response: SearchResponse): number | undefined {
  return typeof response.hits?.total === "number" ? response.hits.total : response.hits?.total?.value;
}

function projectPixel(ipix: number, sourceOrder: number, targetOrder: number): number[] {
  if (sourceOrder === targetOrder) return [ipix];
  if (sourceOrder > targetOrder) return [Math.floor(ipix / 4 ** (sourceOrder - targetOrder))];
  // A coarser source cell cannot be promoted into finer native cells. Keep
  // the source order in the layer metadata, but expose no finer projection.
  return [];
}

export class WarehouseIndexService {
  readonly url?: string;
  readonly layerIndex: string;
  readonly coverageIndex: string;
  readonly fileIndex: string;
  readonly #timeoutMs: number;
  readonly #maxDocuments: number;
  readonly #fetch: typeof fetch;
  readonly #authorization?: string;
  readonly #geometryCache = new Map<string, { promise: Promise<ProjectedGeometry>; expiresAt: number; cells: number }>();

  constructor(options: WarehouseIndexOptions = {}) {
    const endpoint = parseElasticsearchEndpoint(options.url ?? process.env.ASTRO_WAREHOUSE_ES_URL ?? "");
    this.url = endpoint.url;
    this.#authorization = endpoint.authorization;
    this.layerIndex = options.layerIndex ?? process.env.ASTRO_WAREHOUSE_LAYER_INDEX ?? WAREHOUSE_LAYER_INDEX;
    this.coverageIndex = options.coverageIndex ?? process.env.ASTRO_WAREHOUSE_COVERAGE_INDEX ?? WAREHOUSE_COVERAGE_INDEX;
    this.fileIndex = options.fileIndex ?? process.env.ASTRO_WAREHOUSE_FILE_INDEX ?? WAREHOUSE_FILE_INDEX;
    this.#timeoutMs = Math.max(500, options.timeoutMs ?? Number(process.env.ASTRO_WAREHOUSE_ES_TIMEOUT_MS ?? 5000));
    this.#maxDocuments = Math.max(1, options.maxDocuments ?? Number(process.env.ASTRO_WAREHOUSE_COVERAGE_MAX_DOCS ?? 200_000));
    this.#fetch = options.fetchImpl ?? fetch;
  }

  get configured(): boolean { return Boolean(this.url); }

  async loadCatalog(layerIds?: readonly string[]): Promise<WarehouseCoverageCatalog | null> {
    if (!this.url) return null;
    const allowedLayerIds = layerIds === undefined ? undefined : new Set(layerIds);
    const layerHits: SearchHit[] = [];
    let layerSearchAfter: unknown[] | undefined;
    let truncated = false;
    while (layerHits.length < this.#maxDocuments) {
      const pageSize = Math.min(1_000, this.#maxDocuments - layerHits.length);
      const layerResponse = await this.#search(this.layerIndex, {
        size: pageSize, track_total_hits: true,
        query: allowedLayerIds === undefined ? { match_all: {} } : { terms: { layer_id: [...allowedLayerIds] } }, sort: [{ layer_id: "asc" }],
        ...(layerSearchAfter ? { search_after: layerSearchAfter } : {}),
      });
      const hits = layerResponse.hits?.hits ?? [];
      if (hits.length > this.#maxDocuments - layerHits.length) {
        truncated = true;
        break;
      }
      layerHits.push(...hits);
      if (!hits.length) break;
      const layerTotal = total(layerResponse);
      const layerMore = layerTotal !== undefined ? layerTotal > layerHits.length : hits.length === pageSize;
      if (layerMore && layerHits.length >= this.#maxDocuments) {
        truncated = true;
        break;
      }
      if (!layerMore) break;
      const cursor = hits.at(-1)?.sort;
      if (!cursor?.length) throw new WarehouseIndexError("Warehouse layer page is missing a stable sort cursor");
      layerSearchAfter = cursor;
    }
    const layers = layerHits.map(layerFromHit).filter((value): value is WarehouseLayerSnapshot => Boolean(value)
      && (allowedLayerIds === undefined || allowedLayerIds.has(value!.layerId)) && value!.layerMode !== "CANDIDATE");
    const coverages: WarehouseCoverageSnapshot[] = [];
    for (const layer of layers.filter((candidate) => candidate.state === "ACTIVE" && (allowedLayerIds === undefined || allowedLayerIds.has(candidate.layerId)))) {
      let searchAfter: unknown[] | undefined;
      let loaded = 0;
      while (loaded < this.#maxDocuments) {
        const pageSize = Math.min(10_000, this.#maxDocuments - loaded);
        const response = await this.#search(this.coverageIndex, {
          size: pageSize, track_total_hits: true,
          query: { bool: { filter: [{ term: { layer_id: layer.layerId } }] } },
          sort: [{ layer_id: "asc" }, { source_file_id: "asc" }, { healpix_order: "asc" }, { healpix_cell: "asc" }, { coverage_role: "asc" }],
          ...(searchAfter ? { search_after: searchAfter } : {}),
        });
        const hits = response.hits?.hits ?? [];
        if (hits.length > this.#maxDocuments - loaded) { truncated = true; break; }
        hits.forEach((hit) => { const value = coverageFromHit(hit, layer.layerId); if (value) coverages.push(value); });
        loaded += hits.length;
        const responseTotal = total(response);
        const more = responseTotal !== undefined ? responseTotal > loaded : hits.length === pageSize;
        if (more && loaded >= this.#maxDocuments) { truncated = true; break; }
        if (!more || !hits.length) break;
        const cursor = hits.at(-1)?.sort;
        if (!cursor?.length) throw new WarehouseIndexError("Warehouse coverage page is missing a stable sort cursor");
        searchAfter = cursor;
      }
      if (truncated) break;
    }
    return { layers, coverages, truncated };
  }

  async coverage(input: { nside: number; assetIds?: string[]; survey?: string; release?: string; layerIds?: string[] }): Promise<WarehouseCoverageResponse> {
    const targetOrder = nsideOrder(input.nside);
    if (!this.url) return { status: "unavailable", index: this.coverageIndex, nside: input.nside, pixels: [], layers: [], inactiveLayers: [], message: "ASTRO_WAREHOUSE_ES_URL is not configured" };
    try {
      const metadata = await this.#pages(this.layerIndex, input.layerIds === undefined ? { match_all: {} } : { terms: { layer_id: input.layerIds } }, [{ layer_id: "asc" }]);
      if (metadata.truncated) throw new WarehouseIndexError("Warehouse layer selection is incomplete");
      const catalog = { layers: metadata.hits.map(layerFromHit).filter((layer): layer is WarehouseLayerSnapshot => Boolean(layer) && layer!.layerMode !== "CANDIDATE") };
      const selected = catalog.layers.filter((layer) => {
        const assetMatch = !input.assetIds?.length || input.assetIds.some((assetId) => layer.layerId === assetId || layer.layerId === `workspace-${assetId}` || layer.layerId === `user-${assetId}`);
        // An explicit empty layerIds list means "no owned layers". This is
        // used by Workspace when Warehouse is reachable but has no local task
        // lineage; treating [] as "all" would leak Assets-owned layers.
        const layerIdMatch = input.layerIds === undefined || input.layerIds.includes(layer.layerId);
        return assetMatch && (!input.survey || layer.surveyId === input.survey) && (!input.release || layer.releaseId === input.release) && layerIdMatch;
      });
      const byLayer = new Map<string, Set<number>>();
      const orders = new Map<string, Set<number>>();
      const available = new Map<string, Set<number>>();
      const precisions = new Map<string, Set<ScanPrecision>>();
      await Promise.all(selected.filter(layer => layer.state === "ACTIVE").map(async layer => {
        const geometry = await this.#projectedGeometry(layer, targetOrder);
        byLayer.set(layer.layerId, geometry.pixels); orders.set(layer.layerId, geometry.nativeOrders);
        available.set(layer.layerId, geometry.availableOrders); precisions.set(layer.layerId, geometry.precisions);
      }));
      const layers = selected.map((layer): WarehouseCoverageLayer => {
        const state = layer.state;
        const status = state === "ACTIVE" ? "ready" : state === "FAILED" ? "error" : state === "UNKNOWN" ? "unavailable" : "pending";
        const layerPixels = [...(byLayer.get(layer.layerId) ?? new Set<number>())].sort((a, b) => a - b);
        const precisionValues = [...(precisions.get(layer.layerId) ?? new Set<ScanPrecision>())];
        const precisionValue: ScanPrecision = precisionValues.includes("entrypoint-only") ? "entrypoint-only" : precisionValues.includes("estimated") ? "estimated" : "exact";
        const edgeOrders = orders.get(layer.layerId) ?? new Set<number>();
        const availableOrders = [...new Set([...layer.availableOrders, ...(available.get(layer.layerId) ?? new Set<number>())])].sort((a, b) => a - b);
        return {
          key: `warehouse:${layer.layerId}`, layerId: layer.layerId, surveyId: layer.surveyId, releaseId: layer.releaseId, productId: layer.productId,
          modality: layer.modality, coverageRole: layer.coverageRole, state, status, nside: input.nside, pixels: layerPixels,
          nativeOrders: [...edgeOrders].sort((a, b) => a - b), availableOrders,
          ...(layer.maxOrder === undefined ? {} : { maxOrder: layer.maxOrder }),
          precision: precisionValue, ...(layer.errorSummary ? { message: layer.errorSummary } : {}), source: "warehouse", assetIds: [],
        };
      });
      return { status: "ready", index: this.coverageIndex, nside: input.nside, pixels: [...new Set(layers.flatMap((layer) => layer.pixels))].sort((a, b) => a - b), layers, inactiveLayers: selected.filter((layer) => layer.state !== "ACTIVE") };
    } catch (error) {
      return { status: "error", index: this.coverageIndex, nside: input.nside, pixels: [], layers: [], inactiveLayers: [], message: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Aggregate unique projected cells in ES; repeated file edges never cap an overview. */
  #projectedGeometry(layer: WarehouseLayerSnapshot, targetOrder: number): Promise<ProjectedGeometry> {
    const key = JSON.stringify([layer, targetOrder]);
    const existing = this.#geometryCache.get(key);
    if (existing && existing.expiresAt > Date.now()) return existing.promise;
    this.#geometryCache.delete(key);
    for (const [cachedKey, value] of this.#geometryCache) if (value.expiresAt <= Date.now()) this.#geometryCache.delete(cachedKey);
    while (this.#geometryCache.size >= 16) this.#geometryCache.delete(this.#geometryCache.keys().next().value!);
    const entry = { promise: this.#loadProjectedGeometry(layer, targetOrder), expiresAt: Number.POSITIVE_INFINITY, cells: 0 };
    entry.promise = entry.promise.then(geometry => {
      entry.cells = geometry.pixels.size; entry.expiresAt = Date.now() + 60_000;
      while ([...this.#geometryCache.values()].reduce((sum, value) => sum + value.cells, 0) > 200_000) this.#geometryCache.delete(this.#geometryCache.keys().next().value!);
      return geometry;
    }).catch(error => { if (this.#geometryCache.get(key) === entry) this.#geometryCache.delete(key); throw error; });
    this.#geometryCache.set(key, entry);
    return entry.promise;
  }

  async #loadProjectedGeometry(layer: WarehouseLayerSnapshot, targetOrder: number): Promise<ProjectedGeometry> {
    const pixels = new Set<number>(), nativeOrders = new Set<number>(), availableOrders = new Set<number>(), precisions = new Set<ScanPrecision>();
    const committed = await this.#committedBindings(layer);
    if (committed.truncated) throw new WarehouseIndexError("Warehouse committed coverage scope is incomplete");
    if (!committed.bindings.size) return { pixels, nativeOrders, availableOrders, precisions };
    const validFrame = (field: string, values: string[]) => ({ bool: { should: [{ terms: { [field]: values } }, { bool: { must_not: { exists: { field } } } }], minimum_should_match: 1 } });
    const query = { bool: { filter: [{ terms: { layer_id: [...committed.bindings.keys()] } },
      validFrame("coordinate_frame", ["ICRS", "icrs"]), validFrame("coordinateFrame", ["ICRS", "icrs"]),
      validFrame("nesting", ["NESTED", "nested"]), validFrame("ordering", ["NESTED", "nested"]) ] } };
    let after: Record<string, unknown> | undefined;
    let legacyAfter: unknown[] | undefined, legacy = false, loaded = 0;
    const add = (nativeOrder: number, pixel: number, values: Array<{ key: string }> = [], sourceOrders: Array<{ key: number }> = []) => {
      nativeOrders.add(nativeOrder); availableOrders.add(nativeOrder);
      sourceOrders.forEach(value => { const native = order(value.key); if (native !== undefined) availableOrders.add(native); });
      for (const value of values) { const p = precision(value.key); if (p) precisions.add(p); }
      if (nativeOrder >= targetOrder && validPixel(pixel, targetOrder)) pixels.add(pixel);
      if (pixels.size > this.#maxDocuments) throw new WarehouseIndexError("Warehouse overview exceeded its unique-cell budget");
    };
    while (true) {
      const response = await this.#search(this.coverageIndex, legacy ? { size: Math.min(10_000, this.#maxDocuments - loaded), track_total_hits: true, query,
        sort: [{ layer_id: "asc" }, { source_file_id: "asc" }, { healpix_order: "asc" }, { healpix_cell: "asc" }, { coverage_role: "asc" }], ...(legacyAfter ? { search_after: legacyAfter } : {}) }
        : { size: 0, query, aggs: { geometry: { composite: { size: 5000, sources: [
          { order: { terms: { field: "healpix_order" } } },
          { pixel: { terms: { script: { lang: "painless", source: "long o=doc['healpix_order'].value; long p=doc['healpix_cell'].value; return o>params.order ? (long)(p/Math.pow(4,o-params.order)) : p;", params: { order: targetOrder } } } } },
        ], ...(after ? { after } : {}) }, aggs: { precisions: { terms: { field: "precision", size: 4 } }, legacy_precisions: { terms: { field: "coverage_precision", size: 4 } }, source_orders: { terms: { field: "source_order", size: 30 } } } } } }, Math.max(this.#timeoutMs, 15_000));
      if (response.timed_out || response._shards?.failed) throw new WarehouseIndexError("Warehouse overview aggregation is incomplete");
      const buckets = response.aggregations?.geometry?.buckets;
      if (buckets) {
        for (const bucket of buckets) {
          const nativeOrder = order(bucket.key.order), pixel = number(bucket.key.pixel);
          if (nativeOrder === undefined || pixel === undefined) throw new WarehouseIndexError("Warehouse overview has an invalid native-cell identity");
          add(nativeOrder, pixel, [...(bucket.precisions?.buckets ?? []), ...(bucket.legacy_precisions?.buckets ?? [])], bucket.source_orders?.buckets);
        }
        const next = response.aggregations?.geometry?.after_key;
        if (!buckets.length || !next) break;
        if (JSON.stringify(next) === JSON.stringify(after)) throw new WarehouseIndexError("Warehouse overview cursor did not advance");
        after = next;
      } else {
        // Compatibility with small ES-compatible fixtures; real ES supplies the aggregation.
        const hits = response.hits?.hits;
        if (!hits) throw new WarehouseIndexError("Warehouse overview has no geometry aggregation");
        legacy = true; loaded += hits.length;
        for (const hit of hits) {
          const edge = coverageFromHit(hit);
          if (!edge || !committed.bindings.has(edge.layerId)) continue;
          const projected = edge.order >= targetOrder ? projectPixel(edge.ipix, edge.order, targetOrder)[0]! : edge.ipix;
          add(edge.order, projected, [{ key: edge.precision ?? "exact" }], edge.sourceOrder === undefined ? [] : [{ key: edge.sourceOrder }]);
        }
        if (!hits.length || loaded >= (total(response) ?? loaded + 1)) break;
        if (loaded >= this.#maxDocuments) throw new WarehouseIndexError("Legacy Warehouse overview is incomplete at its evidence-row budget");
        const next = hits.at(-1)?.sort;
        if (!next || JSON.stringify(next) === JSON.stringify(legacyAfter)) throw new WarehouseIndexError("Legacy Warehouse overview cursor did not advance");
        legacyAfter = next;
      }
    }
    return { pixels, nativeOrders, availableOrders, precisions };
  }

  async reverseFiles(input: { layerIds: readonly string[]; order: number; cells: readonly number[] }): Promise<{ files: WorkspaceFileLocation[]; truncated: boolean; notes: string[] }> {
    const files: WorkspaceFileLocation[] = [];
    const notes: string[] = [];
    let truncated = false;
    if (!this.configured || !input.layerIds.length) return { files, truncated, notes };
    const allowed = new Set(input.layerIds);
    const layerHits = await this.#search(this.layerIndex, { size: 1000, query: { terms: { layer_id: [...allowed] } } });
    const layers = (layerHits.hits?.hits ?? []).map(layerFromHit).filter((layer): layer is WarehouseLayerSnapshot => Boolean(layer)
      && allowed.has(layer!.layerId) && layer!.state === "ACTIVE" && layer!.layerMode !== "CANDIDATE");
    const selected = new Set(input.cells);
    const maximumFiles = Math.min(this.#maxDocuments, 50_000);
    const maximumCellMatches = 2_000_000;
    let retainedFiles = 0;
    let retainedCellMatches = 0;
    for (const layer of layers) {
      const committed = await this.#committedBindings(layer);
      const bindings = committed.bindings;
      truncated ||= committed.truncated;
      notes.push(...committed.notes);
      if (!bindings.size) continue;
      const actualOrders = layer.availableOrders.length ? layer.availableOrders : [input.order];
      const coverageQuery = { bool: { filter: [
        { terms: { layer_id: [...bindings.keys()] } },
        { bool: { should: actualOrders.map((actualOrder) => ({ bool: { filter: [
          { term: { healpix_order: actualOrder } }, regionPixelFilter("healpix_cell", actualOrder, input.order, input.cells),
        ] } })), minimum_should_match: 1 } },
      ] } };
      const coverageSort = [{ source_file_id: "asc" }, { layer_id: "asc" }, { healpix_order: "asc" }, { healpix_cell: "asc" }, { coverage_role: "asc" }];
      const matches = new Map<string, Map<string, Map<number, { cells: Set<number>; precision: WorkspaceFileLocation["precision"]; sourceUri?: string }>>>();
      let after: unknown[] | undefined;
      let scanned = 0;
      // A fine-order footprint can have many edges for one file. Bound the
      // retained mapping rather than stopping after a fixed number of edges.
      coveragePages: while (true) {
        const response = await this.#search(this.coverageIndex, { size: 1000, track_total_hits: true, query: coverageQuery,
          sort: coverageSort, ...(after ? { search_after: after } : {}) });
        const page = response.hits?.hits ?? [];
        scanned += page.length;
        for (const hit of page) {
          const edge = coverageFromHit(hit);
          if (!edge || !bindings.has(edge.layerId) || !edge.sourceFileId || !regionContainsCell(edge.order, edge.ipix, input.order, selected)
            || (edge.coordinateFrame && edge.coordinateFrame.toUpperCase() !== "ICRS") || (edge.nesting && edge.nesting.toUpperCase() !== "NESTED")) continue;
          const candidate = matches.get(edge.layerId) ?? new Map();
          let file = candidate.get(edge.sourceFileId);
          if (!file) {
            if (retainedFiles >= maximumFiles) { truncated = true; break coveragePages; }
            file = new Map(); candidate.set(edge.sourceFileId, file); matches.set(edge.layerId, candidate); retainedFiles += 1;
          }
          const match = file.get(edge.order) ?? { cells: new Set<number>(), precision: "exact" as const };
          if (!match.cells.has(edge.ipix)) {
            if (retainedCellMatches >= maximumCellMatches) { truncated = true; break coveragePages; }
            match.cells.add(edge.ipix); retainedCellMatches += 1;
          }
          match.precision = match.precision === "estimated" || edge.precision === "estimated" ? "estimated"
            : match.precision === "entrypoint-only" || edge.precision === "entrypoint-only" ? "entrypoint-only" : "exact";
          match.sourceUri ??= edge.sourceUri;
          file.set(edge.order, match);
        }
        const count = total(response);
        if (!page.length) { truncated ||= count !== undefined && scanned < count; break; }
        if (count === undefined ? page.length < 1000 : scanned >= count) break;
        const next = page.at(-1)?.sort;
        if (!next?.length || JSON.stringify(next) === JSON.stringify(after)) { truncated = true; break; }
        after = next;
      }
      for (const [candidateId, binding] of bindings) {
        const candidateMatches = matches.get(candidateId);
        const ids = [...candidateMatches?.keys() ?? []];
        const metadata = new Map<string, Record<string, unknown>>();
        for (let start = 0; start < ids.length; start += 500) {
          const batch = ids.slice(start, start + 500);
          const result = await this.#search(binding.observation ? process.env.ASTRO_WAREHOUSE_FILE_OBSERVATION_INDEX ?? "ast_file_observation_index_v1" : this.fileIndex, {
            size: 500,
            query: binding.observation ? { bool: { filter: [{ term: { layer_id: candidateId } }, { terms: { file_id: batch } },
              ...(binding.scanRunId ? [{ term: { scan_run_id: binding.scanRunId } }] : [])] } }
              : { bool: { should: [{ ids: { values: batch } }, { terms: { file_id: batch } }], minimum_should_match: 1 } },
          });
          for (const hit of result.hits?.hits ?? []) {
            const value = hit._source ?? {};
            const id = text(value.file_id) ?? hit._id;
            if (id && batch.includes(id)) metadata.set(id, value);
          }
        }
        for (const id of ids) {
          const matching = candidateMatches!.get(id)!;
          const file = metadata.get(id);
          const uri = text(file?.canonical_source_uri) ?? text(file?.source_uri) ?? text(file?.sourceUri) ?? [...matching.values()].find((match) => match.sourceUri)?.sourceUri;
          if (!uri) { notes.push(`${layer.layerId}: indexed file has no source locator`); continue; }
          for (const [actualOrder, match] of matching) {
            files.push({ layerId: layer.layerId, surveyId: layer.surveyId, releaseId: layer.releaseId, product: layer.productId,
              modality: layer.modality, sourceUri: uri, order: actualOrder, matchingCells: [...match.cells].sort((a, b) => a - b),
              precision: match.precision,
              scanRunId: binding.scanRunId });
          }
        }
      }
    }
    if (truncated) notes.push("Private directory lookup is incomplete at the configured metadata query limit or scan scope.");
    return { files, truncated, notes };
  }

  /** Query file identities once per native order; keep only their immediate parents. */
  async reverseDirectories(input: { layerIds: readonly string[]; order: number; cells: readonly number[];
    sourceForLayer: (layerId: string) => string | undefined }): Promise<{ directories: WorkspaceDirectory[]; truncated: boolean; notes: string[] }> {
    const collector = new WorkspaceDirectoryCollector(input.sourceForLayer, this.#maxDocuments);
    const notes = new Set<string>();
    let truncated = false;
    if (!this.configured || !input.layerIds.length) return { directories: [], truncated, notes: [] };
    const allowed = new Set(input.layerIds);
    const layerHits = await this.#search(this.layerIndex, { size: 1000, query: { terms: { layer_id: [...allowed] } } });
    const layers = (layerHits.hits?.hits ?? []).map(layerFromHit).filter((layer): layer is WarehouseLayerSnapshot => Boolean(layer)
      && allowed.has(layer!.layerId) && layer!.state === "ACTIVE" && layer!.layerMode !== "CANDIDATE");
    const selected = new Set(input.cells);
    for (const layer of layers) {
      const committed = await this.#committedBindings(layer);
      truncated ||= committed.truncated;
      committed.notes.forEach(note => notes.add(note));
      const bindings = committed.bindings;
      if (!bindings.size) continue;
      const actualOrders = layer.availableOrders.length ? layer.availableOrders : [input.order];
      const validFrame = (field: string, values: string[]) => ({ bool: { should: [
        { terms: { [field]: values } }, { bool: { must_not: { exists: { field } } } },
      ], minimum_should_match: 1 } });
      const query = { bool: { filter: [
        { terms: { layer_id: [...bindings.keys()] } },
        { bool: { should: actualOrders.map(actualOrder => ({ bool: { filter: [
          { term: { healpix_order: actualOrder } }, regionPixelFilter("healpix_cell", actualOrder, input.order, input.cells),
        ] } })), minimum_should_match: 1 } },
        validFrame("coordinate_frame", ["ICRS", "icrs"]), validFrame("coordinateFrame", ["ICRS", "icrs"]),
        validFrame("nesting", ["NESTED", "nested"]), validFrame("ordering", ["NESTED", "nested"]),
      ] } };
      let after: Record<string, unknown> | undefined;
      while (true) {
        const response = await this.#search(this.coverageIndex, { size: 0, query, aggs: { files: {
          composite: { size: 5000, sources: [
            { fileId: { terms: { field: "source_file_id", missing_bucket: true } } }, { layerId: { terms: { field: "layer_id" } } },
            { order: { terms: { field: "healpix_order" } } },
          ], ...(after ? { after } : {}) },
          aggs: {
            matching_cell: { min: { field: "healpix_cell" } },
            precisions: { terms: { field: "precision", size: 4 } }, legacy_precisions: { terms: { field: "coverage_precision", size: 4 } },
          },
        } } });
        if (response.timed_out || response._shards?.failed) truncated = true;
        const buckets = response.aggregations?.files?.buckets;
        if (!buckets) throw new WarehouseIndexError("Warehouse directory aggregation is missing file groups");
        if (!buckets.length) break;
        const byCandidate = new Map<string, DirectoryBucket[]>();
        for (const bucket of buckets) {
          const candidateId = bucket.key.layerId;
          if (!candidateId || !bindings.has(candidateId)) continue;
          const group = byCandidate.get(candidateId) ?? [];
          group.push(bucket); byCandidate.set(candidateId, group);
        }
        for (const [candidateId, groups] of byCandidate) {
          const binding = bindings.get(candidateId)!;
          const ids = [...new Set(groups.flatMap(group => group.key.fileId ? [group.key.fileId] : []))];
          const locators = new Map<string, string>();
          for (let start = 0; start < ids.length; start += 500) {
            const batch = ids.slice(start, start + 500);
            const joined = await this.#search(binding.observation ? process.env.ASTRO_WAREHOUSE_FILE_OBSERVATION_INDEX ?? "ast_file_observation_index_v1" : this.fileIndex, {
              size: 500, _source: ["file_id", "layer_id", "scan_run_id", "canonical_source_uri", "source_uri", "sourceUri"],
              query: binding.observation ? { bool: { filter: [{ term: { layer_id: candidateId } }, { terms: { file_id: batch } },
                ...(binding.scanRunId ? [{ term: { scan_run_id: binding.scanRunId } }] : [])] } }
                : { bool: { should: [{ ids: { values: batch } }, { terms: { file_id: batch } }], minimum_should_match: 1 } },
            });
            if (joined.timed_out || joined._shards?.failed) truncated = true;
            for (const hit of joined.hits?.hits ?? []) {
              const file = hit._source ?? {};
              const id = text(file.file_id) ?? hit._id;
              if (!id || !batch.includes(id) || (binding.observation && (file.layer_id !== candidateId
                || (binding.scanRunId && file.scan_run_id !== binding.scanRunId)))) continue;
              const uri = text(file.canonical_source_uri) ?? text(file.source_uri) ?? text(file.sourceUri);
              if (uri) locators.set(id, uri);
            }
          }
          for (const group of groups) {
            const fileId = group.key.fileId;
            const actualOrder = order(group.key.order);
            const pixel = number(group.matching_cell?.value);
            if (!fileId || actualOrder === undefined || pixel === undefined || !validPixel(pixel, actualOrder)
              || !regionContainsCell(actualOrder, pixel, input.order, selected)) {
              truncated = true; continue;
            }
            const uri = locators.get(fileId);
            if (!uri) { truncated = true; notes.add("A matched private file has no committed source locator; its parent is unavailable."); continue; }
            const values = [...(group.precisions?.buckets ?? []).map(value => value.key), ...(group.legacy_precisions?.buckets ?? []).map(value => value.key)];
            const matchPrecision = values.includes("entrypoint-only") ? "entrypoint-only" : values.includes("estimated") ? "estimated" : "exact";
            if (!collector.addFile({ layerId: layer.layerId, surveyId: layer.surveyId, releaseId: layer.releaseId, product: layer.productId,
              modality: layer.modality, sourceUri: uri, order: actualOrder, matchingCells: [pixel], precision: matchPrecision,
              matchingCellsTruncated: (group.doc_count ?? 1) > 1 })) truncated = true;
          }
        }
        if (collector.truncated) break;
        const next = response.aggregations?.files?.after_key;
        if (!next) break;
        if (JSON.stringify(next) === JSON.stringify(after)) { truncated = true; break; }
        after = next;
      }
      if (collector.truncated) break;
    }
    const directories = collector.result();
    if (directories.some(directory => directory.matchingCellsTruncated)) notes.add("Private parent directories retain representative native cells, not each file's full footprint.");
    if (truncated) notes.add("Private directory lookup is incomplete at the configured directory limit or committed scan scope.");
    return { directories, truncated, notes: [...notes] };
  }

  async #committedBindings(layer: WarehouseLayerSnapshot): Promise<{ bindings: Map<string, ScanBinding>; truncated: boolean; notes: string[] }> {
    const bindings = new Map<string, ScanBinding>();
    if (layer.layerMode !== "PARTITIONED") {
      bindings.set(layer.layerId, { scanRunId: layer.scanRunId, observation: false });
      return { bindings, truncated: false, notes: [] };
    }
    if (!layer.activeScopeId || !layer.scopeSnapshotSha256) return { bindings, truncated: true, notes: [`${layer.layerId}: missing committed scan scope`] };
    const members = await this.#pages(process.env.ASTRO_WAREHOUSE_PARTITION_INDEX ?? "ast_partition_index_v1", {
      bool: { filter: [{ term: { layer_id: layer.layerId } }, { term: { scope_id: layer.activeScopeId } }, { term: { state: "ACTIVE" } }] },
    }, [{ partition_id: "asc" }]);
    let truncated = members.truncated;
    for (const hit of members.hits) {
      const member = hit._source ?? {};
      const candidate = text(member.active_layer_id);
      if (member.layer_id !== layer.layerId || member.scope_id !== layer.activeScopeId || member.state !== "ACTIVE"
        || member.scope_snapshot_sha256 !== layer.scopeSnapshotSha256 || !candidate) { truncated = true; continue; }
      bindings.set(candidate, { scanRunId: text(member.active_scan_run_id), observation: true });
    }
    if (bindings.size) {
      const pointed = await this.#search(this.layerIndex, { size: bindings.size, query: { terms: { layer_id: [...bindings.keys()] } } });
      const active = new Set((pointed.hits?.hits ?? []).flatMap(hit => hit._source?.state === "ACTIVE" ? [text(hit._source.layer_id) ?? hit._id!] : []));
      for (const id of bindings.keys()) if (!active.has(id)) { bindings.delete(id); truncated = true; }
    }
    return { bindings, truncated, notes: [] };
  }

  async #pages(index: string, query: unknown, sort: unknown[]): Promise<{ hits: SearchHit[]; truncated: boolean }> {
    const hits: SearchHit[] = [];
    let after: unknown[] | undefined;
    const maximum = Math.min(this.#maxDocuments, 50_000);
    while (hits.length < maximum) {
      const size = Math.min(1000, maximum - hits.length);
      const response = await this.#search(index, { size, track_total_hits: true, query, sort, ...(after ? { search_after: after } : {}) });
      const page = response.hits?.hits ?? [];
      hits.push(...page);
      if (!page.length || (total(response) === undefined ? page.length < size : hits.length >= total(response)!)) return { hits, truncated: false };
      const next = page.at(-1)?.sort;
      if (!next?.length || JSON.stringify(next) === JSON.stringify(after)) return { hits, truncated: true };
      after = next;
    }
    return { hits, truncated: true };
  }

  async #search(index: string, body: unknown, timeoutMs = this.#timeoutMs): Promise<SearchResponse> {
    if (!this.url) throw new WarehouseIndexError("Warehouse Elasticsearch is not configured");
    let response: Response;
    try {
      response = await this.#fetch(`${this.url}/${encodeURIComponent(index)}/_search`, { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json", ...(this.#authorization ? { Authorization: this.#authorization } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) { throw new WarehouseIndexError(`Warehouse Elasticsearch request failed: ${error instanceof Error ? error.message : String(error)}`); }
    if (!response.ok) throw new WarehouseIndexError(`Warehouse Elasticsearch returned HTTP ${response.status}`);
    return await response.json() as SearchResponse;
  }
}

export class WarehouseIndexError extends Error {
  constructor(message: string) { super(message); this.name = "WarehouseIndexError"; }
}
