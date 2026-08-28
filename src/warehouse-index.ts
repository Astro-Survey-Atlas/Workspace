import type { ScanPrecision } from "./connector-history.js";
import { parseElasticsearchEndpoint } from "./es-endpoint.js";

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
interface SearchResponse { hits?: { hits?: SearchHit[]; total?: number | { value?: number } } }

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
        query: { match_all: {} }, sort: [{ layer_id: "asc" }],
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
    const layers = layerHits.map(layerFromHit).filter((value): value is WarehouseLayerSnapshot => Boolean(value));
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
      const catalog = await this.loadCatalog(input.layerIds);
      if (!catalog) throw new WarehouseIndexError("Warehouse Elasticsearch is not configured");
      const selected = catalog.layers.filter((layer) => {
        const assetMatch = !input.assetIds?.length || input.assetIds.some((assetId) => layer.layerId === assetId || layer.layerId === `workspace-${assetId}` || layer.layerId === `user-${assetId}`);
        // An explicit empty layerIds list means "no owned layers". This is
        // used by Workspace when Warehouse is reachable but has no local task
        // lineage; treating [] as "all" would leak Assets-owned layers.
        const layerIdMatch = input.layerIds === undefined || input.layerIds.includes(layer.layerId);
        return assetMatch && (!input.survey || layer.surveyId === input.survey) && (!input.release || layer.releaseId === input.release) && layerIdMatch;
      });
      const activeIds = new Set(selected.filter((layer) => layer.state === "ACTIVE").map((layer) => layer.layerId));
      const byLayer = new Map<string, Set<number>>();
      const orders = new Map<string, Set<number>>();
      const available = new Map<string, Set<number>>();
      const precisions = new Map<string, Set<ScanPrecision>>();
      for (const edge of catalog.coverages) {
        if (!activeIds.has(edge.layerId)) continue;
        // These describe the real source documents and must survive even when
        // the requested overview order is finer than the source order.
        const layerOrders = orders.get(edge.layerId) ?? new Set<number>();
        layerOrders.add(edge.order);
        orders.set(edge.layerId, layerOrders);
        const layerAvailable = available.get(edge.layerId) ?? new Set<number>();
        layerAvailable.add(edge.order);
        if (edge.sourceOrder !== undefined) layerAvailable.add(edge.sourceOrder);
        available.set(edge.layerId, layerAvailable);
        const layerPrecision = precisions.get(edge.layerId) ?? new Set<ScanPrecision>();
        layerPrecision.add(edge.precision ?? "exact");
        precisions.set(edge.layerId, layerPrecision);

        const projected = projectPixel(edge.ipix, edge.order, targetOrder);
        if (!projected.length) continue;
        const pixels = byLayer.get(edge.layerId) ?? new Set<number>();
        projected.forEach((pixel) => pixels.add(pixel)); byLayer.set(edge.layerId, pixels);
      }
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

  async #search(index: string, body: unknown): Promise<SearchResponse> {
    if (!this.url) throw new WarehouseIndexError("Warehouse Elasticsearch is not configured");
    let response: Response;
    try {
      response = await this.#fetch(`${this.url}/${encodeURIComponent(index)}/_search`, { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json", ...(this.#authorization ? { Authorization: this.#authorization } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(this.#timeoutMs) });
    } catch (error) { throw new WarehouseIndexError(`Warehouse Elasticsearch request failed: ${error instanceof Error ? error.message : String(error)}`); }
    if (!response.ok) throw new WarehouseIndexError(`Warehouse Elasticsearch returned HTTP ${response.status}`);
    return await response.json() as SearchResponse;
  }
}

export class WarehouseIndexError extends Error {
  constructor(message: string) { super(message); this.name = "WarehouseIndexError"; }
}
