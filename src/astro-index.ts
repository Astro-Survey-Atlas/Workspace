export const ASTRO_FILE_INDEX = "astro_file_index_v1";
export const ASTRO_HEALPIX_ORDER = 8;
export const ASTRO_OVERVIEW_NSIDE = 16;

export type AstroIndexStatus = "ready" | "unavailable" | "error";

export interface AstroBreakdown {
  key: string;
  label: string;
  files: number;
  bytes: number;
}

export interface AstroSpatialSummary {
  status: AstroIndexStatus;
  index: string;
  nside: number;
  matchedFiles: number;
  totalBytes: number;
  knownFiles: number;
  unknownFiles: number;
  spatialStatus: Record<string, number>;
  byAsset: AstroBreakdown[];
  bySurveyReleaseModality: AstroBreakdown[];
  message?: string;
}

export interface AstroOverviewCell extends AstroSpatialSummary {
  pixel: number;
}

export interface AstroOverviewResponse {
  status: AstroIndexStatus;
  index: string;
  nside: number;
  survey: string;
  release: string;
  cells: AstroOverviewCell[];
  total: AstroSpatialSummary;
  message?: string;
}

export interface AstroSkyQueryInput {
  cells: number[];
  nside: number;
  survey?: string;
  release?: string;
  product?: string;
  modality?: string;
  assetIds?: string[];
}

export interface AstroSkyOverviewInput {
  cells: number[];
  nside: number;
  survey: string;
  release: string;
}

export interface AstroCoverageInput {
  assetIds?: string[];
  survey?: string;
  release?: string;
  nside: number;
}

/** Coverage returned for one effective survey ownership group. */
export interface AstroCoverageLayer {
  key: string;
  surveyId?: string;
  releaseId?: string;
  assetIds: string[];
  pixels: number[];
  byAsset: AstroBreakdown[];
  source?: "connector" | "asset" | "unassigned" | "conflict";
  message?: string;
}

export interface AstroCoverageResponse {
  status: AstroIndexStatus;
  index: string;
  nside: number;
  pixels: number[];
  byAsset: AstroBreakdown[];
  layers?: AstroCoverageLayer[];
  message?: string;
}

interface ElasticsearchTotal {
  value: number;
}

interface ElasticsearchBucket {
  key: string | number;
  doc_count: number;
  bytes?: { value?: number };
  spatial_status?: { buckets?: Array<{ key: string; doc_count: number }> };
}

interface ElasticsearchAggregations {
  total_bytes?: { value?: number };
  by_asset?: { buckets?: ElasticsearchBucket[] };
  by_survey_release_modality?: { buckets?: ElasticsearchBucket[] };
  spatial_status?: { buckets?: Array<{ key: string; doc_count: number }> };
  cells?: { buckets?: Record<string, ElasticsearchBucket> };
  coverage_cells?: {
    buckets?: Array<{ key: string | number | Record<string, string | number>; doc_count: number }>;
    after_key?: Record<string, string | number>;
  };
}

interface ElasticsearchSearchResponse {
  hits?: { total?: number | ElasticsearchTotal };
  aggregations?: ElasticsearchAggregations;
}

interface SearchResult {
  summary: AstroSpatialSummary;
  cellSummaries: Map<number, AstroSpatialSummary>;
}

interface AstroIndexOptions {
  baseUrl?: string;
  index?: string;
  timeoutMs?: number;
  cacheTtlMs?: number;
}

class AstroIndexUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AstroIndexUnavailableError";
  }
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function isPowerOfTwo(value: number): boolean {
  return Number.isInteger(value) && value > 0 && (value & (value - 1)) === 0;
}

function validateNside(nside: number): void {
  if (!isPowerOfTwo(nside) || nside > ASTRO_OVERVIEW_NSIDE) {
    throw new RangeError(`nside must be a power of two no greater than ${ASTRO_OVERVIEW_NSIDE}`);
  }
}

function validateCells(cells: number[]): number[] {
  const unique = [...new Set(cells)];
  if (!unique.length) throw new RangeError("at least one HEALPix cell is required");
  if (unique.some((cell) => !Number.isInteger(cell) || cell < 0)) {
    throw new RangeError("HEALPix cells must be non-negative integers");
  }
  return unique.sort((left, right) => left - right);
}

/** NESTED HEALPix children preserve the parent prefix in their integer index. */
export function nestedChildPixels(parentNside: number, parentPixel: number, targetNside = 256): number[] {
  validateNside(parentNside);
  if (!Number.isInteger(parentPixel) || parentPixel < 0 || parentPixel >= 12 * parentNside ** 2) {
    throw new RangeError(`invalid HEALPix pixel ${parentPixel} for NSIDE ${parentNside}`);
  }
  if (!isPowerOfTwo(targetNside) || targetNside < parentNside) {
    throw new RangeError("target NSIDE must be a power of two at least as large as parent NSIDE");
  }
  const orderDelta = Math.log2(targetNside) - Math.log2(parentNside);
  const childCount = 4 ** orderDelta;
  const first = parentPixel * childCount;
  return Array.from({ length: childCount }, (_, index) => first + index);
}

function totalHits(response: ElasticsearchSearchResponse): number {
  const total = response.hits?.total;
  if (typeof total === "number") return total;
  return total?.value ?? 0;
}

function numberValue(value: number | undefined): number {
  return Number.isFinite(value) ? Number(value) : 0;
}

function emptySummary(index: string, nside: number, status: AstroIndexStatus, message?: string): AstroSpatialSummary {
  return {
    status,
    index,
    nside,
    matchedFiles: 0,
    totalBytes: 0,
    knownFiles: 0,
    unknownFiles: 0,
    spatialStatus: {},
    byAsset: [],
    bySurveyReleaseModality: [],
    ...(message ? { message } : {}),
  };
}

function emptyCoverage(index: string, nside: number, status: AstroIndexStatus, message?: string): AstroCoverageResponse {
  return { status, index, nside, pixels: [], byAsset: [], ...(message ? { message } : {}) };
}

function parseBreakdown(bucket: ElasticsearchBucket): AstroBreakdown {
  const key = String(bucket.key);
  const values = key.split("|");
  const label = values.join(" · ");
  return {
    key,
    label,
    files: bucket.doc_count,
    bytes: numberValue(bucket.bytes?.value),
  };
}

function summarize(
  response: ElasticsearchSearchResponse,
  index: string,
  nside: number,
  cellBuckets?: Map<number, ElasticsearchBucket>,
): SearchResult {
  const aggregations = response.aggregations ?? {};
  const spatialStatus = Object.fromEntries(
    (aggregations.spatial_status?.buckets ?? []).map((bucket) => [String(bucket.key), bucket.doc_count]),
  );
  const knownFiles = spatialStatus.known ?? 0;
  const unknownFiles = Object.entries(spatialStatus)
    .filter(([key]) => key !== "known")
    .reduce((sum, [, count]) => sum + count, 0);
  const summary: AstroSpatialSummary = {
    status: "ready",
    index,
    nside,
    matchedFiles: totalHits(response),
    totalBytes: numberValue(aggregations.total_bytes?.value),
    knownFiles,
    unknownFiles,
    spatialStatus,
    byAsset: (aggregations.by_asset?.buckets ?? []).map(parseBreakdown),
    bySurveyReleaseModality: (aggregations.by_survey_release_modality?.buckets ?? []).map(parseBreakdown),
  };
  const cellSummaries = new Map<number, AstroSpatialSummary>();
  cellBuckets?.forEach((bucket, pixel) => {
    const status = Object.fromEntries(
      (bucket.spatial_status?.buckets ?? []).map((entry) => [String(entry.key), entry.doc_count]),
    );
    const known = status.known ?? 0;
    const unknown = Object.entries(status)
      .filter(([key]) => key !== "known")
      .reduce((sum, [, count]) => sum + count, 0);
    cellSummaries.set(pixel, {
      status: "ready",
      index,
      nside,
      matchedFiles: bucket.doc_count,
      totalBytes: numberValue(bucket.bytes?.value),
      knownFiles: known,
      unknownFiles: unknown,
      spatialStatus: status,
      byAsset: [],
      bySurveyReleaseModality: [],
    });
  });
  return { summary, cellSummaries };
}

function aggregateCellFilters(cells: number[], targetNside: number): Record<string, { terms: { coverage_cells: number[] } }> {
  const childCount = 4 ** (Math.log2(256) - Math.log2(targetNside));
  if (cells.length * childCount > 65_536) throw new RangeError("selected HEALPix region is too large for one query");
  return Object.fromEntries(cells.map((pixel) => {
    const children = nestedChildPixels(targetNside, pixel, 256);
    return [
      `p${pixel}`,
      {
        terms: { coverage_cells: children },
      },
    ];
  }));
}

export class AstroIndexService {
  readonly #baseUrl: string;
  readonly #index: string;
  readonly #timeoutMs: number;
  readonly #cacheTtlMs: number;
  readonly #overviewCache = new Map<string, { expiresAt: number; value: AstroOverviewResponse }>();

  constructor(options: AstroIndexOptions = {}) {
    this.#baseUrl = normalizeBaseUrl(options.baseUrl ?? process.env.ASTRO_ES_URL ?? "");
    this.#index = options.index ?? process.env.ASTRO_ES_ASTRO_INDEX ?? ASTRO_FILE_INDEX;
    this.#timeoutMs = options.timeoutMs ?? Number(process.env.ASTRO_ES_TIMEOUT_MS ?? "2500");
    this.#cacheTtlMs = options.cacheTtlMs ?? Number(process.env.ASTRO_ES_OVERVIEW_CACHE_MS ?? "60000");
  }

  get configured(): boolean {
    return Boolean(this.#baseUrl);
  }

  async query(input: AstroSkyQueryInput): Promise<AstroSpatialSummary> {
    const cells = validateCells(input.cells);
    validateNside(input.nside);
    const children = cells.flatMap((pixel) => nestedChildPixels(input.nside, pixel, 256));
    const result = await this.#search({
      cells: children,
      nside: input.nside,
      filters: {
        survey: input.survey,
        release: input.release,
        product: input.product,
        modality: input.modality,
        assetIds: input.assetIds,
      },
    });
    return result.summary;
  }

  async overview(input: AstroSkyOverviewInput): Promise<AstroOverviewResponse> {
    const cells = validateCells(input.cells);
    validateNside(input.nside);
    const cacheKey = `${input.survey}|${input.release}|${input.nside}|${cells.join(",")}`;
    const cached = this.#overviewCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const result = await this.#search({
      cells: cells.flatMap((pixel) => nestedChildPixels(input.nside, pixel, 256)),
      nside: input.nside,
      filters: { survey: input.survey, release: input.release },
      cellFilters: aggregateCellFilters(cells, input.nside),
    });
    const cellValues = cells.map((pixel) => ({
      pixel,
      ...(result.cellSummaries.get(pixel) ?? emptySummary(this.#index, input.nside, result.summary.status, result.summary.message)),
    }));
    const value: AstroOverviewResponse = {
      status: result.summary.status,
      index: this.#index,
      nside: input.nside,
      survey: input.survey,
      release: input.release,
      cells: cellValues,
      total: result.summary,
    };
    this.#overviewCache.set(cacheKey, { expiresAt: Date.now() + this.#cacheTtlMs, value });
    return value;
  }

  async coverage(input: AstroCoverageInput): Promise<AstroCoverageResponse> {
    validateNside(input.nside);
    const assetIds = input.assetIds?.filter(Boolean);
    const must: unknown[] = [{ term: { spatial_status: "known" } }];
    if (assetIds?.length) must.push({ terms: { asset_id: assetIds } });
    if (input.survey) must.push({ term: { survey: input.survey } });
    if (input.release) must.push({ term: { release: input.release } });
    if (!this.configured) return emptyCoverage(this.#index, input.nside, "unavailable", "ASTRO_ES_URL is not configured");
    try {
      const sourceNside = 1 << ASTRO_HEALPIX_ORDER;
      if (input.nside > sourceNside) throw new RangeError(`coverage nside cannot exceed scanner nside ${sourceNside}`);
      const ratio = sourceNside / input.nside;
      const childCount = ratio * ratio;
      const pixels = new Set<number>();
      let after: Record<string, string | number> | undefined;
      let byAsset: AstroBreakdown[] = [];
      for (let page = 0; page < 1000; page += 1) {
        const aggs: Record<string, unknown> = {
          coverage_cells: {
            composite: {
              size: 10_000,
              sources: [{ cell: { terms: { field: "coverage_cells" } } }],
              ...(after ? { after } : {}),
            },
          },
        };
        if (!after) {
          aggs.by_asset = {
            terms: { field: "asset_id", size: 100 },
            aggs: { bytes: { sum: { field: "size_bytes" } } },
          };
        }
        const response = await this.#request({ size: 0, query: { bool: { filter: must } }, aggs });
        const aggregation = response.aggregations?.coverage_cells;
        const buckets = aggregation?.buckets ?? [];
        buckets.forEach((bucket) => {
          const rawKey = typeof bucket.key === "object" ? bucket.key.cell : bucket.key;
          const raw = Number(rawKey);
          if (Number.isInteger(raw) && raw >= 0) pixels.add(Math.floor(raw / childCount));
        });
        if (!after) byAsset = (response.aggregations?.by_asset?.buckets ?? []).map(parseBreakdown);
        const next = aggregation?.after_key;
        if (!next || !buckets.length) break;
        after = next;
      }
      return {
        status: "ready",
        index: this.#index,
        nside: input.nside,
        pixels: [...pixels].sort((left, right) => left - right),
        byAsset,
      };
    } catch (error) {
      return emptyCoverage(this.#index, input.nside, "error", error instanceof Error ? error.message : String(error));
    }
  }

  async #search(input: {
    cells: number[];
    nside: number;
    filters: Pick<AstroSkyQueryInput, "survey" | "release" | "product" | "modality" | "assetIds">;
    cellFilters?: Record<string, { terms: { coverage_cells: number[] } }>;
  }): Promise<SearchResult> {
    if (!this.configured) {
      const summary = emptySummary(this.#index, input.nside, "unavailable", "ASTRO_ES_URL is not configured");
      return { summary, cellSummaries: new Map() };
    }
    const must: unknown[] = [{ terms: { coverage_cells: input.cells } }];
    const filters = input.filters;
    for (const [field, value] of [["survey", filters.survey], ["release", filters.release], ["product", filters.product], ["modality", filters.modality]] as const) {
      if (value) must.push({ term: { [field]: value } });
    }
    if (filters.assetIds?.length) must.push({ terms: { asset_id: filters.assetIds } });
    const aggs: Record<string, unknown> = {
      total_bytes: { sum: { field: "size_bytes" } },
      spatial_status: { terms: { field: "spatial_status", size: 8 } },
      by_asset: {
        terms: { field: "asset_id", size: 100 },
        aggs: { bytes: { sum: { field: "size_bytes" } } },
      },
      by_survey_release_modality: {
        multi_terms: {
          terms: [{ field: "survey" }, { field: "release" }, { field: "modality" }],
          size: 100,
        },
        aggs: { bytes: { sum: { field: "size_bytes" } } },
      },
    };
    if (input.cellFilters) {
      aggs.cells = {
        filters: { filters: input.cellFilters },
        aggs: {
          bytes: { sum: { field: "size_bytes" } },
          spatial_status: { terms: { field: "spatial_status", size: 8 } },
        },
      };
    }
    let response: ElasticsearchSearchResponse;
    try {
      response = await this.#request({
      size: 0,
      track_total_hits: true,
      query: { bool: { filter: must } },
      aggs,
      });
    } catch (error) {
      const unavailable = error instanceof AstroIndexUnavailableError;
      const status = unavailable ? "unavailable" : "error";
      const summary = emptySummary(this.#index, input.nside, status, error instanceof Error ? error.message : String(error));
      return { summary, cellSummaries: new Map() };
    }
    const buckets = new Map<number, ElasticsearchBucket>();
    const cellBuckets = response.aggregations?.cells?.buckets ?? {};
    Object.entries(cellBuckets).forEach(([key, bucket]) => {
      const pixel = Number(key.slice(1));
      if (Number.isInteger(pixel)) buckets.set(pixel, bucket);
    });
    return summarize(response, this.#index, input.nside, buckets);
  }

  async #request(body: Record<string, unknown>): Promise<ElasticsearchSearchResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await fetch(`${this.#baseUrl}/${encodeURIComponent(this.#index)}/_search`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (response.status === 404) {
        throw new AstroIndexUnavailableError(`Elasticsearch index ${this.#index} is not available`);
      }
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        let message = `Elasticsearch returned HTTP ${response.status}`;
        if (detail) {
          try {
            const parsed = JSON.parse(detail) as { error?: { reason?: string; type?: string } | string };
            const error = parsed.error;
            const reason = typeof error === "string" ? error : error?.reason ?? error?.type;
            if (reason) message += `: ${reason}`;
          } catch {
            // Keep the public error concise when Elasticsearch returns a non-JSON proxy response.
          }
        }
        throw new Error(message);
      }
      return await response.json() as ElasticsearchSearchResponse;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw new Error("Elasticsearch request timed out");
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
