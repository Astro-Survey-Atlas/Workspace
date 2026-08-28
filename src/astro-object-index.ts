import {
  LOCAL_COVERAGE_INDEX,
  LOCAL_OBJECT_INDEX,
  type LocalScanDocument,
} from "./local-scan.js";
import { COVERAGE_ROLES, DATA_ORIGINS, SOURCE_TIERS, type CoverageDataOrigin, type CoverageRole, type CoverageSourceTier } from "./assets-core.js";
import { parseElasticsearchEndpoint } from "./es-endpoint.js";

export const ASTRO_OBJECT_INDEX = LOCAL_OBJECT_INDEX;
export const ASTRO_COVERAGE_INDEX = LOCAL_COVERAGE_INDEX;
export const ASTRO_OBJECT_NATIVE_ORDER = 8;
export const ASTRO_OBJECT_NATIVE_NSIDE = 2 ** ASTRO_OBJECT_NATIVE_ORDER;
export const ASTRO_HEALPIX_COORDINATE_FRAME = "ICRS" as const;
export const ASTRO_HEALPIX_ORDERING = "NESTED" as const;

export type AstroObjectQueryStatus = "ready" | "unavailable" | "error";

export interface ObjectRegionSelectionInput {
  nside?: number;
  pixels?: readonly number[];
  parentNside?: number;
  parentPixels?: readonly number[];
  coordinateFrame?: string;
  ordering?: string;
}

export interface ObjectRegionQueryInput {
  bbox?: {
    raMin: number;
    raMax: number;
    decMin: number;
    decMax: number;
  };
  region?: ObjectRegionSelectionInput;
  healpix?: ObjectRegionSelectionInput;
  parentNside?: number;
  parentPixels?: readonly number[];
  pixels?: readonly number[];
  cells?: readonly number[] | ObjectRegionSelectionInput;
  nside?: number;
  coordinateFrame?: string;
  ordering?: string;
  surveys?: string[];
  surveyIds?: string[];
  releases?: string[];
  releaseIds?: string[];
  products?: string[];
  modalities?: string[];
  assetIds?: string[];
  limit?: number;
  /** Skip the potentially large flattened attributes map for point-only views. */
  includeAttributes?: boolean;
  searchAfter?: unknown[];
  cursor?: unknown[];
}

export interface AstroObjectRecord {
  object_id: string;
  ra_deg: number;
  dec_deg: number;
  survey: string;
  release: string;
  product: string;
  modality: string;
  asset_id: string;
  attributes: Record<string, string>;
  sky_position?: {
    lat: number;
    lon: number;
  };
  healpix_order?: number;
  healpix_pixel?: number;
  source_file_id?: string;
  scan_run_id?: string;
  id?: string;
}

export interface AstroObjectQueryResult {
  status: AstroObjectQueryStatus;
  index: string;
  objects: AstroObjectRecord[];
  total: number;
  limit: number;
  searchAfter?: unknown[];
  nextCursor?: unknown[];
  message?: string;
}

export interface AstroCoverageFact {
  healpix_order: number;
  healpix_pixel: number;
  objectCount: number;
  survey: string;
  release: string;
  product: string;
  modality: string;
  asset_id: string;
  source_file_id?: string;
  scan_run_id?: string;
  coverage_role?: CoverageRole;
  data_origin?: CoverageDataOrigin;
  source_tier?: CoverageSourceTier;
  max_order?: number;
  query_order?: number;
  preview_order?: number;
}

export interface AstroCoverageFactQueryInput {
  nside: number;
  surveys?: string[];
  surveyIds?: string[];
  releases?: string[];
  releaseIds?: string[];
  products?: string[];
  modalities?: string[];
  assetIds?: string[];
}

export interface AstroCoverageFactQueryResult {
  status: AstroObjectQueryStatus;
  index: string;
  nside: number;
  facts: AstroCoverageFact[];
  pixels: number[];
  message?: string;
}

export interface AstroCellsQueryInput {
  parentNside?: number;
  parentPixels?: readonly number[];
  pixels?: readonly number[];
  /** Alias for clients that send the selected parent cell list as cells. */
  cells?: readonly number[] | ObjectRegionSelectionInput;
  /** Alias for parentNside when cells is an array. */
  nside?: number;
  targetNside?: number;
  coordinateFrame?: string;
  ordering?: string;
  assetIds?: string[];
  surveyIds?: string[];
  releaseIds?: string[];
  products?: string[];
  modalities?: string[];
}

export interface AstroDensityLayer {
  key: string;
  assetId: string;
  surveyId: string;
  releaseId: string;
  product: string;
  modality: string;
  count: number;
}

export interface AstroDensityCell {
  nside: number;
  pixel: number;
  count: number;
  layers: AstroDensityLayer[];
}

export interface AstroCellsQueryResult {
  status: AstroObjectQueryStatus;
  index: string;
  coordinateFrame: typeof ASTRO_HEALPIX_COORDINATE_FRAME;
  ordering: typeof ASTRO_HEALPIX_ORDERING;
  parentNside: number;
  parentPixels: number[];
  targetNside: number;
  nativeNside: typeof ASTRO_OBJECT_NATIVE_NSIDE;
  evidence: "coverage_facts";
  cells: AstroDensityCell[];
  layers: AstroDensityLayer[];
  total: number;
  message?: string;
}

export interface AstroObjectIndexOptions {
  baseUrl?: string;
  objectIndex?: string;
  coverageIndex?: string;
  timeoutMs?: number;
}

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 10_000;
const MAX_SEARCH_AFTER_VALUES = 100;
const MAX_FILTER_VALUES = 1_000;
const MAX_FILTER_VALUE_LENGTH = 512;
const MAX_HEALPIX_PARENT_PIXELS = 4_096;
const MAX_HEALPIX_TARGET_CELLS = 4_096;
const MAX_HEALPIX_TERMS = 4_096;
const MAX_COVERAGE_AGGREGATION_PAGES = 1_000;
const COVERAGE_AGGREGATION_SIZE = 10_000;
const MAX_BULK_DOCUMENTS = 500;
const MAX_BULK_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 2_500;

const OBJECT_SOURCE_FIELDS = [
  "object_id",
  "ra_deg",
  "dec_deg",
  "sky_position",
  "healpix_order",
  "healpix_pixel",
  "survey",
  "release",
  "product",
  "modality",
  "asset_id",
  "source_file_id",
  "scan_run_id",
  "attributes",
] as const;

const OBJECT_POINT_SOURCE_FIELDS = OBJECT_SOURCE_FIELDS.filter((field) => field !== "attributes");

const COVERAGE_SOURCE_FIELDS = [
  "healpix_order",
  "healpix_pixel",
  "objectCount",
  "survey",
  "release",
  "product",
  "modality",
  "asset_id",
  "source_file_id",
  "scan_run_id",
  "coverage_role",
  "data_origin",
  "source_tier",
  "max_order",
  "query_order",
  "preview_order",
] as const;

interface ElasticsearchSearchHit {
  _id?: unknown;
  _source?: unknown;
  sort?: unknown;
}

interface ElasticsearchSearchResponse {
  hits?: {
    total?: unknown;
    hits?: unknown;
  };
  aggregations?: unknown;
}

class ElasticsearchUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ElasticsearchUnavailableError";
  }
}

function normalizeIndex(value: unknown, name: string, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string") throw new TypeError(`${name} must be a non-empty string`);
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${name} must be a non-empty string`);
  if (normalized.length > 255) throw new RangeError(`${name} must contain at most 255 characters`);
  return normalized;
}

function normalizeTimeout(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new RangeError("timeoutMs must be a positive finite number");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isObjectDocument(document: LocalScanDocument): boolean {
  return isRecord(document) && "object_id" in document && "ra_deg" in document && "dec_deg" in document;
}

function nonEmptyText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

function sourceFor(document: LocalScanDocument): Record<string, unknown> {
  const source: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(document)) {
    if (key !== "_index" && key !== "_id") source[key] = value;
  }
  return source;
}

function bulkLinesFor(document: LocalScanDocument, targetIndex?: string): string {
  const index = targetIndex ?? nonEmptyText(document._index, "document._index");
  const id = nonEmptyText(document._id, "document._id");
  const action = JSON.stringify({ index: { _index: index, _id: id } });
  const source = JSON.stringify(sourceFor(document));
  if (source === undefined) throw new TypeError(`Unable to serialize document ${id}`);
  return `${action}\n${source}\n`;
}

function errorReason(value: unknown): string | undefined {
  if (typeof value === "string" && value) return value;
  if (!isRecord(value)) return undefined;
  if (typeof value.reason === "string" && value.reason) return value.reason;
  if (typeof value.type === "string" && value.type) return value.type;
  const rootCause = value.root_cause;
  if (Array.isArray(rootCause)) {
    for (const cause of rootCause) {
      const reason = errorReason(cause);
      if (reason) return reason;
    }
  }
  return undefined;
}

function httpErrorMessage(status: number, body: string): string {
  let message = `Elasticsearch returned HTTP ${status}`;
  if (!body) return message;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const reason = errorReason(parsed.error);
    if (reason) message += `: ${reason}`;
  } catch {
    // A proxy can return HTML or plain text; keep the adapter error concise.
  }
  return message;
}

function validateCoordinate(value: unknown, name: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be a finite number between ${minimum} and ${maximum}`);
  }
  return value;
}

function isPowerOfTwo(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && (value & (value - 1)) === 0;
}

function validateHealpixNside(value: unknown, name: string, maximum = ASTRO_OBJECT_NATIVE_NSIDE): number {
  if (typeof value !== "number" || !isPowerOfTwo(value) || value > maximum) {
    throw new RangeError(`${name} must be a power of two between 1 and ${maximum}`);
  }
  return value;
}

function pixelCountForNside(nside: number): number {
  return 12 * nside ** 2;
}

function validatePixel(pixel: unknown, name: string, nside: number): number {
  if (typeof pixel !== "number" || !Number.isSafeInteger(pixel) || pixel < 0 || pixel >= pixelCountForNside(nside)) {
    throw new RangeError(`${name} must be a valid HEALPix pixel for NSIDE ${nside}`);
  }
  return pixel;
}

function validatePixelList(value: unknown, name: string, nside: number, maximum = MAX_HEALPIX_PARENT_PIXELS): number[] {
  if (!Array.isArray(value) || !value.length) throw new RangeError(`${name} must contain at least one HEALPix pixel`);
  if (value.length > maximum) throw new RangeError(`${name} must contain at most ${maximum} HEALPix pixels`);
  return [...new Set(value.map((pixel, index) => validatePixel(pixel, `${name}[${index}]`, nside)))].sort((left, right) => left - right);
}

export interface NestedPixelRange {
  gte: number;
  lte: number;
}

/** Return the inclusive native-pixel range covered by one NESTED parent. */
export function nestedDescendantRange(
  parentNside: number,
  parentPixel: number,
  nativeNside = ASTRO_OBJECT_NATIVE_NSIDE,
): NestedPixelRange {
  validateHealpixNside(parentNside, "parentNside", nativeNside);
  validateHealpixNside(nativeNside, "nativeNside", ASTRO_OBJECT_NATIVE_NSIDE);
  if (nativeNside < parentNside) throw new RangeError("native NSIDE must be at least the parent NSIDE");
  const pixel = validatePixel(parentPixel, "parentPixel", parentNside);
  const childCount = 4 ** (Math.log2(nativeNside) - Math.log2(parentNside));
  return { gte: pixel * childCount, lte: (pixel + 1) * childCount - 1 };
}

/** Merge overlapping or adjacent inclusive NESTED ranges into canonical order. */
export function normalizeNestedRanges(ranges: readonly NestedPixelRange[]): NestedPixelRange[] {
  const sorted = ranges
    .map((range, index) => {
      if (!range || !Number.isSafeInteger(range.gte) || !Number.isSafeInteger(range.lte) || range.gte < 0 || range.gte > range.lte) {
        throw new RangeError(`nested range ${index} is invalid`);
      }
      return { gte: range.gte, lte: range.lte };
    })
    .sort((left, right) => left.gte - right.gte || left.lte - right.lte);
  const merged: NestedPixelRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (!previous || range.gte > previous.lte + 1) merged.push(range);
    else if (range.lte > previous.lte) previous.lte = range.lte;
  }
  return merged;
}

/** Expand selected NESTED parents to normalized ranges at the native order. */
export function nestedDescendantRanges(
  parentNside: number,
  parentPixels: readonly number[],
  nativeNside = ASTRO_OBJECT_NATIVE_NSIDE,
): NestedPixelRange[] {
  validateHealpixNside(parentNside, "parentNside", nativeNside);
  if (!Array.isArray(parentPixels) || !parentPixels.length) throw new RangeError("parentPixels must contain at least one HEALPix pixel");
  return normalizeNestedRanges(parentPixels.map((pixel) => nestedDescendantRange(parentNside, pixel, nativeNside)));
}

/** Expand selected NESTED parents to target pixels, preserving exact ordering. */
export function nestedDescendantPixels(
  parentNside: number,
  parentPixels: readonly number[],
  targetNside: number,
): number[] {
  validateHealpixNside(parentNside, "parentNside", targetNside);
  validateHealpixNside(targetNside, "targetNside", ASTRO_OBJECT_NATIVE_NSIDE);
  if (targetNside < parentNside) throw new RangeError("target NSIDE must be at least the parent NSIDE");
  if (!Array.isArray(parentPixels) || !parentPixels.length) throw new RangeError("parentPixels must contain at least one HEALPix pixel");
  const pixels = parentPixels.flatMap((parentPixel) => {
    const range = nestedDescendantRange(parentNside, parentPixel, targetNside);
    return Array.from({ length: range.lte - range.gte + 1 }, (_, offset) => range.gte + offset);
  });
  // The argument is normally already canonical, but deduplication keeps the
  // helper exact when callers pass overlapping selections.
  return [...new Set(pixels)].sort((left, right) => left - right);
}

function healpixFilterFromRanges(ranges: readonly NestedPixelRange[]): Record<string, unknown> {
  const normalized = normalizeNestedRanges(ranges);
  const termCount = normalized.reduce((sum, range) => sum + range.lte - range.gte + 1, 0);
  if (termCount <= MAX_HEALPIX_TERMS) {
    const pixels = normalized.flatMap((range) => Array.from({ length: range.lte - range.gte + 1 }, (_, offset) => range.gte + offset));
    return { terms: { healpix_pixel: pixels } };
  }
  if (normalized.length === 1) {
    return { range: { healpix_pixel: { gte: normalized[0]!.gte, lte: normalized[0]!.lte } } };
  }
  return {
    bool: {
      should: normalized.map((range) => ({ range: { healpix_pixel: { gte: range.gte, lte: range.lte } } })),
      minimum_should_match: 1,
    },
  };
}

function validateFilterValues(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array of strings`);
  if (value.length > MAX_FILTER_VALUES) {
    throw new RangeError(`${name} must contain at most ${MAX_FILTER_VALUES} values`);
  }
  const values: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") throw new TypeError(`${name} must contain only strings`);
    const normalized = item.trim();
    if (!normalized) throw new RangeError(`${name} must not contain empty strings`);
    if (normalized.length > MAX_FILTER_VALUE_LENGTH) {
      throw new RangeError(`${name} values must contain at most ${MAX_FILTER_VALUE_LENGTH} characters`);
    }
    if (!seen.has(normalized)) {
      seen.add(normalized);
      values.push(normalized);
    }
  }
  return values;
}

function mergedFilterValues(primary: unknown, alias: unknown, name: string): string[] | undefined {
  const first = validateFilterValues(primary, name);
  const second = validateFilterValues(alias, `${name} alias`);
  if (!first && !second) return undefined;
  return [...new Set([...(first ?? []), ...(second ?? [])])];
}

interface NormalizedObjectRegionQuery {
  bbox?: {
    raMin: number;
    raMax: number;
    decMin: number;
    decMax: number;
  };
  region?: {
    parentNside: number;
    parentPixels: number[];
    nativeRanges: NestedPixelRange[];
  };
  surveys?: string[];
  releases?: string[];
  products?: string[];
  modalities?: string[];
  assetIds?: string[];
  limit: number;
  includeAttributes: boolean;
  searchAfter?: unknown[];
}

function regionCandidate(input: ObjectRegionQueryInput): unknown {
  if (input.region !== undefined) return input.region;
  if (input.healpix !== undefined) return input.healpix;
  const cells = input.cells;
  if (input.parentNside === undefined && input.parentPixels === undefined && input.pixels === undefined && cells === undefined && input.nside === undefined) return undefined;
  const cellRecord = isRecord(cells) ? cells : undefined;
  return {
    nside: input.parentNside ?? input.nside ?? cellRecord?.nside,
    pixels: input.parentPixels ?? input.pixels ?? (Array.isArray(cells) ? cells : cellRecord?.pixels ?? cellRecord?.parentPixels),
    coordinateFrame: input.coordinateFrame ?? cellRecord?.coordinateFrame,
    ordering: input.ordering ?? cellRecord?.ordering,
  };
}

function normalizeRegion(value: unknown, coordinateFrame?: string, ordering?: string): NormalizedObjectRegionQuery["region"] {
  if (!isRecord(value)) throw new TypeError("HEALPix region must be an object");
  const parentNside = validateHealpixNside(value.nside ?? value.parentNside, "region.nside");
  const parentPixels = validatePixelList(value.pixels ?? value.parentPixels, "region.pixels", parentNside);
  const frame = value.coordinateFrame ?? coordinateFrame;
  const nestedOrdering = value.ordering ?? ordering;
  if (frame !== ASTRO_HEALPIX_COORDINATE_FRAME) throw new RangeError(`coordinateFrame must be ${ASTRO_HEALPIX_COORDINATE_FRAME}`);
  if (nestedOrdering !== ASTRO_HEALPIX_ORDERING) throw new RangeError(`ordering must be ${ASTRO_HEALPIX_ORDERING}`);
  return { parentNside, parentPixels, nativeRanges: nestedDescendantRanges(parentNside, parentPixels) };
}

function validateQueryInput(input: ObjectRegionQueryInput): NormalizedObjectRegionQuery {
  if (!isRecord(input)) throw new TypeError("object region query input is required");
  const rawRegion = regionCandidate(input);
  const region = rawRegion === undefined ? undefined : normalizeRegion(
    rawRegion,
    typeof input.coordinateFrame === "string" ? input.coordinateFrame : undefined,
    typeof input.ordering === "string" ? input.ordering : undefined,
  );
  let bbox: NormalizedObjectRegionQuery["bbox"];
  if (input.bbox !== undefined) {
    if (!isRecord(input.bbox)) throw new TypeError("bbox must be an object");
    const raMin = validateCoordinate(input.bbox.raMin, "bbox.raMin", 0, 360);
    const raMax = validateCoordinate(input.bbox.raMax, "bbox.raMax", 0, 360);
    const decMin = validateCoordinate(input.bbox.decMin, "bbox.decMin", -90, 90);
    const decMax = validateCoordinate(input.bbox.decMax, "bbox.decMax", -90, 90);
    if (decMin > decMax) throw new RangeError("bbox.decMin must be no greater than bbox.decMax");
    bbox = { raMin, raMax, decMin, decMax };
  } else if (!region) {
    throw new TypeError("bbox or HEALPix region is required");
  }

  const rawLimit = input.limit === undefined ? DEFAULT_LIMIT : input.limit;
  if (typeof rawLimit !== "number" || !Number.isSafeInteger(rawLimit) || rawLimit < 1 || rawLimit > MAX_LIMIT) {
    throw new RangeError(`limit must be a safe integer between 1 and ${MAX_LIMIT}`);
  }

  let searchAfter: unknown[] | undefined;
  const rawCursor = input.searchAfter ?? input.cursor;
  if (rawCursor !== undefined) {
    if (!Array.isArray(rawCursor)) throw new TypeError("searchAfter must be an array");
    if (rawCursor.length > MAX_SEARCH_AFTER_VALUES) {
      throw new RangeError(`searchAfter must contain at most ${MAX_SEARCH_AFTER_VALUES} values`);
    }
    searchAfter = [...rawCursor];
  }

  return {
    ...(bbox ? { bbox } : {}),
    ...(region ? { region } : {}),
    surveys: mergedFilterValues(input.surveys, input.surveyIds, "surveys"),
    releases: mergedFilterValues(input.releases, input.releaseIds, "releases"),
    products: validateFilterValues(input.products, "products"),
    modalities: validateFilterValues(input.modalities, "modalities"),
    assetIds: validateFilterValues(input.assetIds, "assetIds"),
    limit: rawLimit,
    includeAttributes: input.includeAttributes !== false,
    ...(searchAfter === undefined ? {} : { searchAfter }),
  };
}

function validateCoverageInput(input: AstroCoverageFactQueryInput): AstroCoverageFactQueryInput {
  if (!isRecord(input)) throw new TypeError("coverage fact query input is required");
  const nside = input.nside;
  if (typeof nside !== "number" || !Number.isSafeInteger(nside) || nside < 1 || nside > 256 || (nside & (nside - 1)) !== 0) {
    throw new RangeError("coverage nside must be a power of two between 1 and 256");
  }
  return {
    nside,
    surveys: mergedFilterValues(input.surveys, input.surveyIds, "surveys"),
    releases: mergedFilterValues(input.releases, input.releaseIds, "releases"),
    products: validateFilterValues(input.products, "products"),
    modalities: validateFilterValues(input.modalities, "modalities"),
    assetIds: validateFilterValues(input.assetIds, "assetIds"),
  };
}

function coverageQueryBody(input: AstroCoverageFactQueryInput): Record<string, unknown> {
  const filters: unknown[] = [];
  for (const [field, values] of [
    ["release", input.releases],
    ["product", input.products],
    ["modality", input.modalities],
  ] as const) {
    if (values?.length) filters.push({ terms: { [field]: values } });
  }
  const visibility = layerVisibilityFilter(input.surveys, input.assetIds);
  if (visibility) filters.push(visibility);
  return {
    track_total_hits: true,
    size: 10_000,
    _source: [...COVERAGE_SOURCE_FIELDS],
    query: filters.length ? { bool: { filter: filters } } : { match_all: {} },
    sort: [{ healpix_pixel: "asc" }, { asset_id: "asc" }, { release: "asc" }, { product: "asc" }],
  };
}

function layerVisibilityFilter(surveys?: readonly string[], assetIds?: readonly string[]): Record<string, unknown> | undefined {
  const should: Record<string, unknown>[] = [];
  if (surveys?.length) should.push({ terms: { survey: surveys } });
  if (assetIds?.length) should.push({ terms: { asset_id: assetIds } });
  if (!should.length) return undefined;
  return should.length === 1 ? should[0]! : { bool: { should, minimum_should_match: 1 } };
}

function coverageFactFromHit(hit: ElasticsearchSearchHit, targetNside: number): AstroCoverageFact | undefined {
  if (!isRecord(hit._source)) return undefined;
  const source = hit._source;
  const order = typeof source.healpix_order === "number" ? source.healpix_order : 8;
  const pixel = typeof source.healpix_pixel === "number" ? source.healpix_pixel : NaN;
  const objectCount = typeof source.objectCount === "number" ? source.objectCount : 0;
  if (!Number.isSafeInteger(order) || !Number.isSafeInteger(pixel) || pixel < 0 || objectCount < 0) return undefined;
  const sourceNside = 2 ** order;
  if (sourceNside < targetNside || sourceNside > 256 || targetNside > sourceNside) return undefined;
  const ratio = sourceNside / targetNside;
  const targetPixel = Math.floor(pixel / (ratio * ratio));
  const text = (name: string): string => typeof source[name] === "string" ? source[name] as string : "";
  const assetId = text("asset_id");
  const survey = text("survey");
  const release = text("release");
  const product = text("product");
  const modality = text("modality");
  if (!assetId || !survey || !release || !product || !modality) return undefined;
  const coverageRole = (COVERAGE_ROLES as readonly unknown[]).includes(source.coverage_role)
    ? source.coverage_role as CoverageRole
    : undefined;
  const dataOrigin = (DATA_ORIGINS as readonly unknown[]).includes(source.data_origin)
    ? source.data_origin as CoverageDataOrigin
    : undefined;
  const sourceTier = (SOURCE_TIERS as readonly unknown[]).includes(source.source_tier)
    ? source.source_tier as CoverageSourceTier
    : undefined;
  const maxOrder = typeof source.max_order === "number" && Number.isSafeInteger(source.max_order) ? source.max_order : undefined;
  const queryOrder = typeof source.query_order === "number" && Number.isSafeInteger(source.query_order) ? source.query_order : undefined;
  const previewOrder = typeof source.preview_order === "number" && Number.isSafeInteger(source.preview_order) ? source.preview_order : undefined;
  return {
    healpix_order: Math.log2(targetNside),
    healpix_pixel: targetPixel,
    objectCount,
    survey,
    release,
    product,
    modality,
    asset_id: assetId,
    ...(typeof source.source_file_id === "string" ? { source_file_id: source.source_file_id } : {}),
    ...(typeof source.scan_run_id === "string" ? { scan_run_id: source.scan_run_id } : {}),
    ...(coverageRole === undefined ? {} : { coverage_role: coverageRole }),
    ...(dataOrigin === undefined ? {} : { data_origin: dataOrigin }),
    ...(sourceTier === undefined ? {} : { source_tier: sourceTier }),
    ...(maxOrder === undefined ? {} : { max_order: maxOrder }),
    ...(queryOrder === undefined ? {} : { query_order: queryOrder }),
    ...(previewOrder === undefined ? {} : { preview_order: previewOrder }),
  };
}

function rangeFilter(input: NonNullable<NormalizedObjectRegionQuery["bbox"]>): Record<string, unknown> {
  if (input.raMin <= input.raMax) {
    return { range: { ra_deg: { gte: input.raMin, lte: input.raMax } } };
  }
  return {
    bool: {
      should: [
        { range: { ra_deg: { gte: input.raMin, lte: 360 } } },
        { range: { ra_deg: { gte: 0, lte: input.raMax } } },
      ],
      minimum_should_match: 1,
    },
  };
}

const OBJECT_SORT = [
  { healpix_pixel: "asc" },
  { ra_deg: "asc" },
  { dec_deg: "asc" },
  { asset_id: "asc" },
  { source_file_id: "asc" },
  { object_id: "asc" },
] as const;

const LEGACY_OBJECT_SORT = [{ ra_deg: "asc" }, { dec_deg: "asc" }, { _id: "asc" }] as const;

function objectSort(input: NormalizedObjectRegionQuery): readonly Record<string, string>[] {
  // Preserve cursors issued before the mapped tuple was introduced. New
  // requests, including every HEALPix-region query, never sort on _id.
  return !input.region && input.searchAfter?.length === LEGACY_OBJECT_SORT.length ? LEGACY_OBJECT_SORT : OBJECT_SORT;
}

function queryBody(input: NormalizedObjectRegionQuery): Record<string, unknown> {
  const filters: unknown[] = [];
  if (input.region) {
    filters.push(healpixFilterFromRanges(input.region.nativeRanges));
    filters.push({ term: { healpix_order: ASTRO_OBJECT_NATIVE_ORDER } });
  }
  if (input.bbox) {
    filters.push(rangeFilter(input.bbox));
    filters.push({ range: { dec_deg: { gte: input.bbox.decMin, lte: input.bbox.decMax } } });
  }
  for (const [field, values] of [
    ["release", input.releases],
    ["product", input.products],
    ["modality", input.modalities],
  ] as const) {
    if (values?.length) filters.push({ terms: { [field]: values } });
  }
  const visibility = layerVisibilityFilter(input.surveys, input.assetIds);
  if (visibility) filters.push(visibility);

  return {
    track_total_hits: true,
    size: input.limit,
    _source: [...(input.includeAttributes ? OBJECT_SOURCE_FIELDS : OBJECT_POINT_SOURCE_FIELDS)],
    query: { bool: { filter: filters } },
    sort: [...objectSort(input)],
    ...(input.searchAfter === undefined ? {} : { search_after: input.searchAfter }),
  };
}

function totalFromHits(value: unknown): number {
  const raw = typeof value === "number" ? value : isRecord(value) ? value.value : undefined;
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : 0;
}

function stringAttributes(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const attributes: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") attributes[key] = item;
    else if (item !== null && item !== undefined) attributes[key] = String(item);
  }
  return attributes;
}

function objectFromHit(hit: ElasticsearchSearchHit): AstroObjectRecord {
  const source = isRecord(hit._source) ? { ...hit._source } : {};
  delete source._index;
  delete source._id;
  source.attributes = stringAttributes(source.attributes);
  if (typeof hit._id === "string" && hit._id) source.id = hit._id;
  return source as unknown as AstroObjectRecord;
}

function hitsFromResponse(response: ElasticsearchSearchResponse): ElasticsearchSearchHit[] {
  const hits = response.hits?.hits;
  if (!Array.isArray(hits)) return [];
  return hits.filter(isRecord) as ElasticsearchSearchHit[];
}

function nextSearchAfter(hits: ElasticsearchSearchHit[]): unknown[] | undefined {
  const sort = hits.at(-1)?.sort;
  return Array.isArray(sort) ? [...sort] : undefined;
}

function queryResult(
  index: string,
  input: NormalizedObjectRegionQuery,
  status: AstroObjectQueryStatus,
  extras: { objects?: AstroObjectRecord[]; total?: number; searchAfter?: unknown[]; message?: string } = {},
): AstroObjectQueryResult {
  return {
    status,
    index,
    objects: extras.objects ?? [],
    total: extras.total ?? 0,
    limit: input.limit,
    ...(extras.searchAfter === undefined ? {} : { searchAfter: extras.searchAfter }),
    ...(extras.searchAfter === undefined ? {} : { nextCursor: extras.searchAfter }),
    ...(extras.message ? { message: extras.message } : {}),
  };
}

function bulkResponseError(response: unknown): Error | undefined {
  if (!isRecord(response)) return new Error("Elasticsearch bulk response is not an object");
  const items = response.items;
  if (!Array.isArray(items)) return new Error("Elasticsearch bulk response has no items array");
  for (const [itemIndex, item] of items.entries()) {
    if (!isRecord(item)) return new Error(`Elasticsearch bulk response item ${itemIndex} is invalid`);
    for (const operation of Object.values(item)) {
      if (!isRecord(operation) || operation.error === undefined) continue;
      const reason = errorReason(operation.error) ?? "unknown bulk item error";
      const status = typeof operation.status === "number" ? ` (HTTP ${operation.status})` : "";
      return new Error(`Elasticsearch bulk item ${itemIndex} failed${status}: ${reason}`);
    }
  }
  if (response.errors === true) return new Error("Elasticsearch bulk request reported errors");
  return undefined;
}

function bulkTargetIndex(document: LocalScanDocument, objectIndex: string, coverageIndex: string): string {
  const documentIndex = nonEmptyText(document._index, "document._index");
  const defaultIndex = isObjectDocument(document) ? ASTRO_OBJECT_INDEX : ASTRO_COVERAGE_INDEX;
  return documentIndex === defaultIndex
    ? (isObjectDocument(document) ? objectIndex : coverageIndex)
    : documentIndex;
}

interface NormalizedCellsQuery {
  parentNside: number;
  parentPixels: number[];
  targetNside: number;
  targetPixels: number[];
  nativeRanges: NestedPixelRange[];
  surveys?: string[];
  releases?: string[];
  products?: string[];
  modalities?: string[];
  assetIds?: string[];
}

function normalizeCellsQuery(input: AstroCellsQueryInput): NormalizedCellsQuery {
  if (!isRecord(input)) throw new TypeError("sky cell query input is required");
  const cells = input.cells;
  const cellRecord = isRecord(cells) ? cells : undefined;
  const parentNside = validateHealpixNside(input.parentNside ?? input.nside ?? cellRecord?.nside ?? cellRecord?.parentNside, "parentNside");
  const parentPixels = validatePixelList(
    input.parentPixels ?? input.pixels ?? (Array.isArray(cells) ? cells : cellRecord?.pixels ?? cellRecord?.parentPixels),
    "parentPixels",
    parentNside,
  );
  const targetNside = validateHealpixNside(input.targetNside, "targetNside");
  if (targetNside < parentNside) throw new RangeError("targetNside must be at least parentNside");
  const coordinateFrame = input.coordinateFrame ?? cellRecord?.coordinateFrame;
  const ordering = input.ordering ?? cellRecord?.ordering;
  if (coordinateFrame !== ASTRO_HEALPIX_COORDINATE_FRAME) {
    throw new RangeError(`coordinateFrame must be ${ASTRO_HEALPIX_COORDINATE_FRAME}`);
  }
  if (ordering !== ASTRO_HEALPIX_ORDERING) throw new RangeError(`ordering must be ${ASTRO_HEALPIX_ORDERING}`);

  const targetCellCount = parentPixels.length * 4 ** (Math.log2(targetNside) - Math.log2(parentNside));
  if (targetCellCount > MAX_HEALPIX_TARGET_CELLS) {
    throw new RangeError(`selected HEALPix region contains more than ${MAX_HEALPIX_TARGET_CELLS} target cells`);
  }
  return {
    parentNside,
    parentPixels,
    targetNside,
    targetPixels: nestedDescendantPixels(parentNside, parentPixels, targetNside),
    nativeRanges: nestedDescendantRanges(parentNside, parentPixels),
    surveys: validateFilterValues(input.surveyIds, "surveyIds"),
    releases: validateFilterValues(input.releaseIds, "releaseIds"),
    products: validateFilterValues(input.products, "products"),
    modalities: validateFilterValues(input.modalities, "modalities"),
    assetIds: validateFilterValues(input.assetIds, "assetIds"),
  };
}

function densityQueryBody(input: NormalizedCellsQuery, after?: Record<string, string | number>): Record<string, unknown> {
  const filters: unknown[] = [
    healpixFilterFromRanges(input.nativeRanges),
    { term: { healpix_order: ASTRO_OBJECT_NATIVE_ORDER } },
  ];
  for (const [field, values] of [
    ["release", input.releases],
    ["product", input.products],
    ["modality", input.modalities],
  ] as const) {
    if (values?.length) filters.push({ terms: { [field]: values } });
  }
  const visibility = layerVisibilityFilter(input.surveys, input.assetIds);
  if (visibility) filters.push(visibility);
  const composite: Record<string, unknown> = {
    size: COVERAGE_AGGREGATION_SIZE,
    sources: [
      { healpix_pixel: { terms: { field: "healpix_pixel" } } },
      { asset_id: { terms: { field: "asset_id" } } },
      { survey: { terms: { field: "survey" } } },
      { release: { terms: { field: "release" } } },
      { product: { terms: { field: "product" } } },
      { modality: { terms: { field: "modality" } } },
    ],
    ...(after ? { after } : {}),
  };
  return {
    size: 0,
    track_total_hits: true,
    query: { bool: { filter: filters } },
    aggs: {
      by_native_pixel_layer: {
        composite,
        aggs: { object_count: { sum: { field: "objectCount" } } },
      },
    },
  };
}

function aggregateNumber(value: unknown): number {
  const raw = isRecord(value) ? value.value : value;
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : 0;
}

interface DensityAccumulatorCell {
  count: number;
  layers: Map<string, AstroDensityLayer>;
}

interface DensityAccumulator {
  cells: Map<number, DensityAccumulatorCell>;
}

function densityLayer(
  assetId: string,
  surveyId: string,
  releaseId: string,
  product: string,
  modality: string,
  count: number,
): AstroDensityLayer | undefined {
  if (!assetId || !surveyId || !releaseId || !product || !modality || count <= 0) return undefined;
  return {
    key: [assetId, surveyId, releaseId, product, modality].join("\n"),
    assetId,
    surveyId,
    releaseId,
    product,
    modality,
    count,
  };
}

function addDensityCount(
  accumulator: DensityAccumulator,
  targetPixels: ReadonlySet<number>,
  nativePixel: number,
  targetNside: number,
  values: { assetId: string; surveyId: string; releaseId: string; product: string; modality: string },
  count: number,
): void {
  if (!Number.isSafeInteger(nativePixel) || nativePixel < 0 || count <= 0) return;
  const childCount = (ASTRO_OBJECT_NATIVE_NSIDE / targetNside) ** 2;
  const targetPixel = Math.floor(nativePixel / childCount);
  if (!targetPixels.has(targetPixel)) return;
  const cell = accumulator.cells.get(targetPixel) ?? { count: 0, layers: new Map<string, AstroDensityLayer>() };
  cell.count += count;
  const layer = densityLayer(values.assetId, values.surveyId, values.releaseId, values.product, values.modality, count);
  if (layer) {
    const existing = cell.layers.get(layer.key);
    if (existing) existing.count += layer.count;
    else cell.layers.set(layer.key, layer);
  }
  accumulator.cells.set(targetPixel, cell);
}

function compositeBuckets(response: ElasticsearchSearchResponse): {
  buckets: Record<string, unknown>[];
  after?: Record<string, string | number>;
} | undefined {
  if (!isRecord(response.aggregations)) return undefined;
  const aggregation = response.aggregations.by_native_pixel_layer;
  if (!isRecord(aggregation) || !Array.isArray(aggregation.buckets)) return undefined;
  const buckets = aggregation.buckets.filter(isRecord);
  const rawAfter = aggregation.after_key;
  let after: Record<string, string | number> | undefined;
  if (isRecord(rawAfter)) {
    const entries = Object.entries(rawAfter).filter(([, value]) => typeof value === "string" || typeof value === "number");
    if (entries.length) after = Object.fromEntries(entries) as Record<string, string | number>;
  }
  return { buckets, ...(after ? { after } : {}) };
}

function addCompositeDensityBuckets(
  response: ElasticsearchSearchResponse,
  input: NormalizedCellsQuery,
  accumulator: DensityAccumulator,
): void {
  const page = compositeBuckets(response);
  if (!page) return;
  const targetPixels = new Set(input.targetPixels);
  for (const bucket of page.buckets) {
    if (!isRecord(bucket.key)) continue;
    const nativePixel = typeof bucket.key.healpix_pixel === "number" ? bucket.key.healpix_pixel : Number(bucket.key.healpix_pixel);
    if (!Number.isSafeInteger(nativePixel)) continue;
    addDensityCount(accumulator, targetPixels, nativePixel, input.targetNside, {
      assetId: typeof bucket.key.asset_id === "string" ? bucket.key.asset_id : "",
      surveyId: typeof bucket.key.survey === "string" ? bucket.key.survey : "",
      releaseId: typeof bucket.key.release === "string" ? bucket.key.release : "",
      product: typeof bucket.key.product === "string" ? bucket.key.product : "",
      modality: typeof bucket.key.modality === "string" ? bucket.key.modality : "",
    }, aggregateNumber(bucket.object_count));
  }
}

function addHitDensityFacts(
  response: ElasticsearchSearchResponse,
  input: NormalizedCellsQuery,
  accumulator: DensityAccumulator,
): void {
  const targetPixels = new Set(input.targetPixels);
  for (const hit of hitsFromResponse(response)) {
    if (!isRecord(hit._source)) continue;
    const source = hit._source;
    const nativePixel = typeof source.healpix_pixel === "number" ? source.healpix_pixel : NaN;
    const count = typeof source.objectCount === "number" ? source.objectCount : 0;
    if (!Number.isSafeInteger(nativePixel) || count <= 0) continue;
    addDensityCount(accumulator, targetPixels, nativePixel, input.targetNside, {
      assetId: typeof source.asset_id === "string" ? source.asset_id : "",
      surveyId: typeof source.survey === "string" ? source.survey : "",
      releaseId: typeof source.release === "string" ? source.release : "",
      product: typeof source.product === "string" ? source.product : "",
      modality: typeof source.modality === "string" ? source.modality : "",
    }, count);
  }
}

function cellsResult(
  index: string,
  input: NormalizedCellsQuery,
  status: AstroObjectQueryStatus,
  accumulator?: DensityAccumulator,
  message?: string,
): AstroCellsQueryResult {
  const cells = input.targetPixels.map((pixel) => {
    const accumulated = accumulator?.cells.get(pixel);
    return {
      nside: input.targetNside,
      pixel,
      count: accumulated?.count ?? 0,
      layers: [...(accumulated?.layers.values() ?? [])].sort((left, right) => left.key.localeCompare(right.key)),
    } satisfies AstroDensityCell;
  });
  const layersByKey = new Map<string, AstroDensityLayer>();
  for (const cell of cells) {
    for (const layer of cell.layers) {
      const existing = layersByKey.get(layer.key);
      if (existing) existing.count += layer.count;
      else layersByKey.set(layer.key, { ...layer });
    }
  }
  return {
    status,
    index,
    coordinateFrame: ASTRO_HEALPIX_COORDINATE_FRAME,
    ordering: ASTRO_HEALPIX_ORDERING,
    parentNside: input.parentNside,
    parentPixels: [...input.parentPixels],
    targetNside: input.targetNside,
    nativeNside: ASTRO_OBJECT_NATIVE_NSIDE,
    evidence: "coverage_facts",
    cells,
    layers: [...layersByKey.values()].sort((left, right) => left.key.localeCompare(right.key)),
    total: cells.reduce((sum, cell) => sum + cell.count, 0),
    ...(message ? { message } : {}),
  };
}

export class AstroObjectIndexService {
  readonly #baseUrl: string;
  readonly #objectIndex: string;
  readonly #coverageIndex: string;
  readonly #timeoutMs: number;
  readonly #authorization?: string;

  constructor(options: AstroObjectIndexOptions = {}) {
    const endpoint = parseElasticsearchEndpoint(options.baseUrl ?? process.env.ASTRO_ES_URL ?? "");
    this.#baseUrl = endpoint.url ?? "";
    this.#authorization = endpoint.authorization;
    this.#objectIndex = normalizeIndex(
      options.objectIndex ?? process.env.ASTRO_ES_OBJECT_INDEX,
      "objectIndex",
      ASTRO_OBJECT_INDEX,
    );
    this.#coverageIndex = normalizeIndex(
      options.coverageIndex ?? process.env.ASTRO_ES_COVERAGE_INDEX,
      "coverageIndex",
      ASTRO_COVERAGE_INDEX,
    );
    this.#timeoutMs = normalizeTimeout(
      options.timeoutMs ?? Number(process.env.ASTRO_ES_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS),
      DEFAULT_TIMEOUT_MS,
    );
  }

  get configured(): boolean {
    return Boolean(this.#baseUrl);
  }

  get objectIndex(): string {
    return this.#objectIndex;
  }

  get coverageIndex(): string {
    return this.#coverageIndex;
  }

  async ensureIndices(): Promise<void> {
    if (!this.configured) throw new Error("ASTRO_ES_URL is not configured; cannot initialize local scan indices");
    await this.#ensureIndex(this.#objectIndex, {
      dynamic: "strict",
      properties: {
        object_id: { type: "keyword" },
        ra_deg: { type: "double" },
        dec_deg: { type: "double" },
        sky_position: { type: "geo_point" },
        healpix_order: { type: "byte" },
        healpix_pixel: { type: "integer" },
        survey: { type: "keyword" },
        release: { type: "keyword" },
        product: { type: "keyword" },
        modality: { type: "keyword" },
        asset_id: { type: "keyword" },
        source_file_id: { type: "keyword" },
        scan_run_id: { type: "keyword" },
        attributes: { type: "flattened" },
      },
    });
    await this.#ensureIndex(this.#coverageIndex, {
      dynamic: "strict",
      properties: {
        healpix_order: { type: "byte" },
        healpix_pixel: { type: "integer" },
        objectCount: { type: "long" },
        survey: { type: "keyword" },
        release: { type: "keyword" },
        product: { type: "keyword" },
        modality: { type: "keyword" },
        asset_id: { type: "keyword" },
        source_file_id: { type: "keyword" },
        scan_run_id: { type: "keyword" },
        coverage_role: { type: "keyword" },
        data_origin: { type: "keyword" },
        source_tier: { type: "keyword" },
        max_order: { type: "byte" },
        query_order: { type: "byte" },
        preview_order: { type: "byte" },
      },
    });
  }

  async bulk(documents: LocalScanDocument[]): Promise<{ objectCount: number; coverageCount: number }> {
    if (!this.configured) throw new Error("ASTRO_ES_URL is not configured; cannot bulk index local scan documents");
    if (!Array.isArray(documents)) throw new TypeError("documents must be an array");
    if (!documents.length) return { objectCount: 0, coverageCount: 0 };

    let objectCount = 0;
    let coverageCount = 0;
    let lines: string[] = [];
    let documentCount = 0;
    let bytes = 0;

    const flush = async (): Promise<void> => {
      if (!lines.length) return;
      const response = await this.#requestJson("/_bulk", lines.join(""), "application/x-ndjson");
      const error = bulkResponseError(response);
      if (error) throw error;
      lines = [];
      documentCount = 0;
      bytes = 0;
    };

    for (const document of documents) {
      if (!isRecord(document)) throw new TypeError("bulk documents must be objects");
      if (!isObjectDocument(document)) {
        if (!("healpix_pixel" in document) || !("objectCount" in document)) {
          throw new TypeError("bulk document is neither an object nor a coverage document");
        }
      }
      const payload = bulkLinesFor(document, bulkTargetIndex(document, this.#objectIndex, this.#coverageIndex));
      const payloadBytes = Buffer.byteLength(payload, "utf8");
      if (payloadBytes > MAX_BULK_BYTES) {
        throw new RangeError(`bulk document ${document._id} exceeds the ${MAX_BULK_BYTES} byte request limit`);
      }
      if (documentCount >= MAX_BULK_DOCUMENTS || (documentCount > 0 && bytes + payloadBytes > MAX_BULK_BYTES)) {
        await flush();
      }
      lines.push(payload);
      documentCount += 1;
      bytes += payloadBytes;
      if (isObjectDocument(document)) objectCount += 1;
      else coverageCount += 1;
    }
    await flush();
    return { objectCount, coverageCount };
  }

  async queryCoverageFacts(input: AstroCoverageFactQueryInput): Promise<AstroCoverageFactQueryResult> {
    const normalized = validateCoverageInput(input);
    if (!this.configured) {
      return {
        status: "unavailable",
        index: this.#coverageIndex,
        nside: normalized.nside,
        facts: [],
        pixels: [],
        message: "ASTRO_ES_URL is not configured",
      };
    }

    try {
      const response = await this.#requestJson(
        `/${encodeURIComponent(this.#coverageIndex)}/_search`,
        JSON.stringify(coverageQueryBody(normalized)),
        "application/json",
      ) as ElasticsearchSearchResponse;
      const merged = new Map<string, AstroCoverageFact>();
      for (const hit of hitsFromResponse(response)) {
        const fact = coverageFactFromHit(hit, normalized.nside);
        if (!fact) continue;
        const key = [fact.asset_id, fact.survey, fact.release, fact.product, fact.modality, fact.healpix_pixel].join("\n");
        const existing = merged.get(key);
        if (existing) existing.objectCount += fact.objectCount;
        else merged.set(key, fact);
      }
      const facts = [...merged.values()].sort((left, right) =>
        left.asset_id.localeCompare(right.asset_id)
        || left.healpix_pixel - right.healpix_pixel
        || left.release.localeCompare(right.release)
        || left.product.localeCompare(right.product));
      return {
        status: "ready",
        index: this.#coverageIndex,
        nside: normalized.nside,
        facts,
        pixels: [...new Set(facts.map((fact) => fact.healpix_pixel))].sort((left, right) => left - right),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: error instanceof ElasticsearchUnavailableError ? "unavailable" : "error",
        index: this.#coverageIndex,
        nside: normalized.nside,
        facts: [],
        pixels: [],
        message,
      };
    }
  }

  async queryCells(input: AstroCellsQueryInput): Promise<AstroCellsQueryResult> {
    const normalized = normalizeCellsQuery(input);
    if (!this.configured) {
      return cellsResult(
        this.#coverageIndex,
        normalized,
        "unavailable",
        undefined,
        "ASTRO_ES_URL is not configured",
      );
    }

    try {
      const accumulator: DensityAccumulator = { cells: new Map() };
      let after: Record<string, string | number> | undefined;
      let exhausted = false;
      for (let pageNumber = 0; pageNumber < MAX_COVERAGE_AGGREGATION_PAGES; pageNumber += 1) {
        const response = await this.#requestJson(
          `/${encodeURIComponent(this.#coverageIndex)}/_search`,
          JSON.stringify(densityQueryBody(normalized, after)),
          "application/json",
        ) as ElasticsearchSearchResponse;
        const page = compositeBuckets(response);
        if (!page) {
          // A small compatibility fallback handles ES-compatible test doubles
          // and older coverage indices that do not support composite aggs.
          addHitDensityFacts(response, normalized, accumulator);
          exhausted = true;
          break;
        }
        addCompositeDensityBuckets(response, normalized, accumulator);
        if (!page.after || !page.buckets.length) {
          exhausted = true;
          break;
        }
        after = page.after;
      }
      if (!exhausted) throw new Error(`coverage aggregation exceeded ${MAX_COVERAGE_AGGREGATION_PAGES} pages`);
      return cellsResult(this.#coverageIndex, normalized, "ready", accumulator);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return cellsResult(
        this.#coverageIndex,
        normalized,
        error instanceof ElasticsearchUnavailableError ? "unavailable" : "error",
        undefined,
        message,
      );
    }
  }

  async queryObjects(input: ObjectRegionQueryInput): Promise<AstroObjectQueryResult> {
    const normalized = validateQueryInput(input);
    if (!this.configured) {
      return queryResult(this.#objectIndex, normalized, "unavailable", {
        message: "ASTRO_ES_URL is not configured",
      });
    }

    try {
      const response = await this.#requestJson(
        `/${encodeURIComponent(this.#objectIndex)}/_search`,
        JSON.stringify(queryBody(normalized)),
        "application/json",
      ) as ElasticsearchSearchResponse;
      const hits = hitsFromResponse(response);
      return queryResult(this.#objectIndex, normalized, "ready", {
        objects: hits.map(objectFromHit),
        total: totalFromHits(response.hits?.total),
        searchAfter: nextSearchAfter(hits),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return queryResult(
        this.#objectIndex,
        normalized,
        error instanceof ElasticsearchUnavailableError ? "unavailable" : "error",
        { message },
      );
    }
  }

  async #requestJson(path: string, body: string, contentType: string): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await fetch(`${this.#baseUrl}${path}`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": contentType,
          ...(this.#authorization ? { Authorization: this.#authorization } : {}),
        },
        body,
        signal: controller.signal,
      });
      const responseBody = await response.text();
      if (response.status === 404) {
        throw new ElasticsearchUnavailableError(`Elasticsearch endpoint is not available: ${path}`);
      }
      if (!response.ok) throw new Error(httpErrorMessage(response.status, responseBody));
      if (!responseBody.trim()) return {};
      try {
        return JSON.parse(responseBody) as unknown;
      } catch {
        throw new Error("Elasticsearch returned invalid JSON");
      }
    } catch (error) {
      if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        throw new Error(`Elasticsearch request timed out after ${this.#timeoutMs} ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async #ensureIndex(index: string, mappings: Record<string, unknown>): Promise<void> {
    const encodedIndex = encodeURIComponent(index);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const headers = this.#authorization ? { Authorization: this.#authorization } : undefined;
      const exists = await fetch(`${this.#baseUrl}/${encodedIndex}`, { method: "HEAD", ...(headers ? { headers } : {}), signal: controller.signal });
      if (exists.ok) return;
      if (exists.status !== 404) throw new Error(`Elasticsearch index check returned HTTP ${exists.status}: ${index}`);
      const created = await fetch(`${this.#baseUrl}/${encodedIndex}`, {
        method: "PUT",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...(this.#authorization ? { Authorization: this.#authorization } : {}),
        },
        body: JSON.stringify({ mappings }),
        signal: controller.signal,
      });
      const body = await created.text();
      if (!created.ok) {
        if (created.status === 400 && body.includes("resource_already_exists_exception")) return;
        throw new Error(httpErrorMessage(created.status, body));
      }
    } catch (error) {
      if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        throw new Error(`Elasticsearch request timed out after ${this.#timeoutMs} ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export type { LocalScanDocument } from "./local-scan.js";
