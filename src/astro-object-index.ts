import {
  LOCAL_OBJECT_INDEX,
  type LocalObjectIndexDocument,
} from "./local-scan.js";
import { Healpix, Hploc } from "healpixjs";
import { ASTRO_FILE_INDEX, type AstroFileDocument } from "./astro-index.js";
import { parseElasticsearchEndpoint } from "./es-endpoint.js";
import { regionPixelFilter } from "./workspace-directories.js";

export const ASTRO_OBJECT_INDEX = LOCAL_OBJECT_INDEX;
export const ASTRO_IMAGE_FOOTPRINT_INDEX = "astro_image_footprint_index_v2";
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

export interface SkyDataPointScope { assetId: string; sourceId?: string }

export interface ObjectRegionQueryInput {
  layerScopes?: SkyDataPointScope[];
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
  trackTotalHits?: boolean;
  searchAfter?: unknown[];
  cursor?: unknown[];
}

export interface AstroPointDensityLayerInput {
  id: string;
  scopes: SkyDataPointScope[];
}

export interface AstroPointDensityQueryInput {
  region: ObjectRegionSelectionInput;
  boxes: readonly { raMin: number; raMax: number; decMin: number; decMax: number }[];
  layers: readonly AstroPointDensityLayerInput[];
  targetNside: number;
}

export interface AstroPointDensityCell {
  pixel: number;
  count: number;
  layers: Array<{ id: string; count: number }>;
  surveys: Array<{ id: string; count: number; assetId?: string }>;
}

export interface AstroPointDensityResult {
  status: AstroObjectQueryStatus;
  index: string;
  coordinateFrame: typeof ASTRO_HEALPIX_COORDINATE_FRAME;
  ordering: typeof ASTRO_HEALPIX_ORDERING;
  nside: number;
  total: number;
  layers: Array<{ id: string; count: number }>;
  cells: AstroPointDensityCell[];
  truncated: false;
  message?: string;
}

export interface AstroObjectRecord {
  evidence_ref?: string;
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

export interface AstroImageFootprintDocument {
  _id: string;
  _index: typeof ASTRO_IMAGE_FOOTPRINT_INDEX;
  point_id: string;
  data_batch_id?: string;
  asset_id: string;
  source_id?: string;
  ra_min: number;
  ra_max: number;
  dec_min: number;
  dec_max: number;
}

export interface AstroImageFootprintQuery {
  raDeg: number;
  decDeg: number;
  layerScopes: readonly SkyDataPointScope[];
  limit?: number;
}

export interface AstroImageFootprintQueryResult {
  pointIds: string[];
  total: number;
  truncated: boolean;
}

export interface AstroObjectQueryResult {
  status: AstroObjectQueryStatus;
  index: string;
  objects: AstroObjectRecord[];
  total: number;
  totalRelation?: "eq" | "gte";
  limit: number;
  searchAfter?: unknown[];
  nextCursor?: unknown[];
  message?: string;
  /** More coordinates for the selected assets are still being indexed. */
  indexing?: boolean;
}

export interface SkyPointInspectionInput {
  raDeg: number;
  decDeg: number;
  radiusArcsec: number;
  layerScopes: SkyDataPointScope[];
  region: ObjectRegionSelectionInput;
}

export interface SkyPointInspectionMatch {
  point: AstroObjectRecord;
  separationArcsec: number;
}

export interface SkyPointInspectionResult {
  raDeg: number;
  decDeg: number;
  radiusArcsec: number;
  matches: SkyPointInspectionMatch[];
  images: AstroObjectRecord[];
  truncated: boolean;
  indexing: boolean;
}

export interface SkyCoordinateBbox {
  raMin: number;
  raMax: number;
  decMin: number;
  decMax: number;
}

export interface AstroObjectIndexOptions {
  baseUrl?: string;
  objectIndex?: string;
  timeoutMs?: number;
  dataBatches?: (assetIds?: readonly string[]) => Promise<ReadonlyMap<string, string>>;
}

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 10_000;
const MAX_SEARCH_AFTER_VALUES = 100;
const MAX_FILTER_VALUES = 1_000;
const MAX_FILTER_VALUE_LENGTH = 512;
const MAX_HEALPIX_PARENT_PIXELS = 4_096;
const MAX_HEALPIX_TERMS = 4_096;
const MAX_BULK_DOCUMENTS = 500;
const MAX_BULK_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 2_500;
const MAX_POINT_DENSITY_LAYERS = 64;
const MAX_POINT_DENSITY_BUCKETS = 32_768;
const MAX_POINT_DENSITY_SURVEYS = 64;
const UNASSIGNED_DENSITY_SURVEYS = ["", "user", "__unassigned__"];

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
  "attributes", "evidence_ref",
] as const;

const OBJECT_POINT_SOURCE_FIELDS = [
  "object_id", "ra_deg", "dec_deg", "asset_id", "survey", "release", "product", "modality",
  "attributes.position_role", "attributes.source_id",
] as const;

interface ElasticsearchSearchHit {
  _id?: unknown;
  _source?: unknown;
  sort?: unknown;
}

interface ElasticsearchSearchResponse {
  timed_out?: boolean;
  _shards?: unknown;
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

function nonEmptyText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

function sourceFor(document: LocalObjectIndexDocument): Record<string, unknown> {
  const source: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(document)) {
    if (key !== "_index" && key !== "_id") source[key] = value;
  }
  return source;
}

function bulkLinesFor(document: LocalObjectIndexDocument, targetIndex?: string): string {
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

export function coordinateSearchBbox(raDeg: number, decDeg: number, radiusArcsec: number): SkyCoordinateBbox {
  const ra = validateCoordinate(raDeg, "raDeg", 0, 360) % 360;
  const dec = validateCoordinate(decDeg, "decDeg", -90, 90);
  const radius = validateCoordinate(radiusArcsec, "radiusArcsec", 0.1, 60) / 3600;
  const decMin = Math.max(-90, dec - radius);
  const decMax = Math.min(90, dec + radius);
  if (decMin <= -90 || decMax >= 90) return { raMin: 0, raMax: 360, decMin, decMax };
  const radiusRadians = radius * Math.PI / 180;
  const decRadians = dec * Math.PI / 180;
  const raHalfWidth = Math.asin(Math.min(1, Math.sin(radiusRadians) / Math.cos(decRadians))) * 180 / Math.PI;
  return {
    raMin: ((ra - raHalfWidth) % 360 + 360) % 360,
    raMax: ((ra + raHalfWidth) % 360 + 360) % 360,
    decMin,
    decMax,
  };
}

export function angularSeparationArcsec(ra1Deg: number, dec1Deg: number, ra2Deg: number, dec2Deg: number): number {
  const ra1 = validateCoordinate(ra1Deg, "ra1Deg", 0, 360) * Math.PI / 180;
  const ra2 = validateCoordinate(ra2Deg, "ra2Deg", 0, 360) * Math.PI / 180;
  const dec1 = validateCoordinate(dec1Deg, "dec1Deg", -90, 90) * Math.PI / 180;
  const dec2 = validateCoordinate(dec2Deg, "dec2Deg", -90, 90) * Math.PI / 180;
  const sinDec = Math.sin((dec2 - dec1) / 2);
  const sinRa = Math.sin((ra2 - ra1) / 2);
  const haversine = sinDec ** 2 + Math.cos(dec1) * Math.cos(dec2) * sinRa ** 2;
  return 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(Math.max(0, 1 - haversine))) * 180 / Math.PI * 3600;
}

export function coordinateInHealpixRegion(raDeg: number, decDeg: number, region: ObjectRegionSelectionInput): boolean {
  const ra = validateCoordinate(raDeg, "raDeg", 0, 360) % 360;
  const dec = validateCoordinate(decDeg, "decDeg", -90, 90);
  const normalized = normalizeRegion(region);
  if (!normalized) throw new RangeError("region is required");
  const location = new Hploc();
  location.setZ(Math.sin(dec * Math.PI / 180));
  location.phi = ra * Math.PI / 180;
  const pixel = new Healpix(normalized.parentNside).loc2pix(location);
  return normalized.parentPixels.includes(pixel);
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
  layerScopes?: SkyDataPointScope[];
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
  trackTotalHits: boolean;
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
    ...(input.layerScopes === undefined ? {} : { layerScopes: validateLayerScopes(input.layerScopes) }),
    surveys: mergedFilterValues(input.surveys, input.surveyIds, "surveys"),
    releases: mergedFilterValues(input.releases, input.releaseIds, "releases"),
    products: validateFilterValues(input.products, "products"),
    modalities: validateFilterValues(input.modalities, "modalities"),
    assetIds: validateFilterValues(input.assetIds, "assetIds"),
    limit: rawLimit,
    includeAttributes: input.includeAttributes !== false,
    trackTotalHits: input.trackTotalHits !== false,
    ...(searchAfter === undefined ? {} : { searchAfter }),
  };
}

function layerVisibilityFilter(surveys?: readonly string[], assetIds?: readonly string[]): Record<string, unknown> | undefined {
  const should: Record<string, unknown>[] = [];
  if (surveys?.length) should.push({ terms: { survey: surveys } });
  if (assetIds?.length) should.push({ terms: { asset_id: assetIds } });
  if (!should.length) return undefined;
  return should.length === 1 ? should[0]! : { bool: { should, minimum_should_match: 1 } };
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

function validateLayerScopes(value: unknown): SkyDataPointScope[] {
  if (!Array.isArray(value) || value.length > 512) throw new RangeError("layerScopes must be an array of at most 512 scopes");
  return value.map((entry) => {
    if (!isRecord(entry) || typeof entry.assetId !== "string" || !entry.assetId.trim()) throw new RangeError("each layer scope requires an assetId");
    if (entry.sourceId !== undefined && (typeof entry.sourceId !== "string" || !entry.sourceId.trim())) throw new RangeError("sourceId must be non-empty");
    return { assetId: entry.assetId, ...(entry.sourceId ? { sourceId: entry.sourceId as string } : {}) };
  });
}

function scopedLayerFilter(scopes: readonly SkyDataPointScope[]): Record<string, unknown> {
  if (!scopes.length) return { match_none: {} };
  return { bool: { should: scopes.map((scope) => ({ bool: { filter: [
    { term: { asset_id: scope.assetId } }, ...(scope.sourceId ? [{ term: { "attributes.source_id": scope.sourceId } }] : []),
  ] } })), minimum_should_match: 1 } };
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
  const visibility = input.layerScopes === undefined ? layerVisibilityFilter(input.surveys, input.assetIds) : scopedLayerFilter(input.layerScopes);
  if (visibility) filters.push(visibility);

  return {
    track_total_hits: input.trackTotalHits,
    size: input.limit,
    _source: [...(input.includeAttributes ? OBJECT_SOURCE_FIELDS : OBJECT_POINT_SOURCE_FIELDS)],
    query: { bool: { filter: filters } },
    sort: [...OBJECT_SORT],
    ...(input.searchAfter === undefined ? {} : { search_after: input.searchAfter }),
  };
}

function validatePointDensityInput(input: AstroPointDensityQueryInput): {
  region: NonNullable<NormalizedObjectRegionQuery["region"]>;
  boxes: NonNullable<NormalizedObjectRegionQuery["bbox"]>[];
  layers: AstroPointDensityLayerInput[];
  targetNside: number;
} {
  if (!isRecord(input)) throw new TypeError("point density query input is required");
  const region = normalizeRegion(input.region, ASTRO_HEALPIX_COORDINATE_FRAME, ASTRO_HEALPIX_ORDERING);
  if (!Array.isArray(input.boxes) || !input.boxes.length || input.boxes.length > 2) throw new RangeError("point density requires one or two viewport boxes");
  const boxes = input.boxes.map((box, index) => {
    if (!isRecord(box)) throw new TypeError(`boxes[${index}] must be an object`);
    const raMin = validateCoordinate(box.raMin, `boxes[${index}].raMin`, 0, 360);
    const raMax = validateCoordinate(box.raMax, `boxes[${index}].raMax`, 0, 360);
    const decMin = validateCoordinate(box.decMin, `boxes[${index}].decMin`, -90, 90);
    const decMax = validateCoordinate(box.decMax, `boxes[${index}].decMax`, -90, 90);
    if (decMin > decMax) throw new RangeError(`boxes[${index}].decMin must be no greater than decMax`);
    return { raMin, raMax, decMin, decMax };
  });
  if (!Array.isArray(input.layers) || input.layers.length > MAX_POINT_DENSITY_LAYERS) {
    throw new RangeError(`point density supports at most ${MAX_POINT_DENSITY_LAYERS} layers`);
  }
  const ids = new Set<string>();
  const layers = input.layers.map((layer, index) => {
    if (!isRecord(layer) || typeof layer.id !== "string" || !layer.id.trim() || ids.has(layer.id)) {
      throw new RangeError(`layers[${index}] requires a unique non-empty id`);
    }
    ids.add(layer.id);
    return { id: layer.id, scopes: validateLayerScopes(layer.scopes) };
  });
  if (!Number.isSafeInteger(input.targetNside) || input.targetNside < 1 || input.targetNside > ASTRO_OBJECT_NATIVE_NSIDE
      || (input.targetNside & (input.targetNside - 1)) !== 0) {
    throw new RangeError(`targetNside must be a power of two between 1 and ${ASTRO_OBJECT_NATIVE_NSIDE}`);
  }
  return { region: region!, boxes, layers, targetNside: input.targetNside };
}

function pointDensityQueryBody(input: ReturnType<typeof validatePointDensityInput>, targetNside: number): Record<string, unknown> {
  const viewportFilters = input.boxes.map(box => ({ bool: { filter: [rangeFilter(box),
    { range: { dec_deg: { gte: box.decMin, lte: box.decMax } } }] } }));
  const filters: unknown[] = [
    healpixFilterFromRanges(input.region.nativeRanges),
    { term: { healpix_order: ASTRO_OBJECT_NATIVE_ORDER } },
    { bool: { should: viewportFilters, minimum_should_match: 1 } },
  ];
  const childCount = (ASTRO_OBJECT_NATIVE_NSIDE / targetNside) ** 2;
  const bucketSize = Math.max(12, Math.min(4_096, Math.floor(
    (MAX_POINT_DENSITY_BUCKETS - input.layers.length) / (input.layers.length + 2 + 2 * MAX_POINT_DENSITY_SURVEYS),
  )));
  return {
    size: 0,
    track_total_hits: false,
    query: { bool: { filter: [...filters, scopedLayerFilter(input.layers.flatMap(layer => layer.scopes))] } },
    aggs: {
      by_cell: { terms: {
        script: { source: "Math.floor(doc['healpix_pixel'].value / params.childCount)", params: { childCount } },
        size: bucketSize,
      }, aggs: {
        by_survey: { terms: { field: "survey", missing: "", size: MAX_POINT_DENSITY_SURVEYS } },
        unassigned_assets: {
          filter: { bool: { should: [
            { terms: { survey: UNASSIGNED_DENSITY_SURVEYS } },
            { bool: { must_not: { exists: { field: "survey" } } } },
          ], minimum_should_match: 1 } },
          aggs: { by_asset: { terms: { field: "asset_id", missing: "", size: MAX_POINT_DENSITY_SURVEYS } } },
        },
      } },
      by_layer: {
        filters: { filters: Object.fromEntries(input.layers.map(layer => [layer.id, scopedLayerFilter(layer.scopes)])) },
        aggs: { by_cell: { terms: {
          script: { source: "Math.floor(doc['healpix_pixel'].value / params.childCount)", params: { childCount } },
          size: bucketSize,
        } } },
      },
    },
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

function pointFromHit(hit: ElasticsearchSearchHit): AstroObjectRecord {
  const source = isRecord(hit._source) ? hit._source : {};
  const attributes = stringAttributes(source.attributes);
  return {
    ...Object.fromEntries(OBJECT_POINT_SOURCE_FIELDS.filter(field => !field.startsWith("attributes.") && source[field] !== undefined)
      .map(field => [field, source[field]])),
    ...(typeof hit._id === "string" ? { id: hit._id } : {}),
    attributes: Object.fromEntries(["position_role", "source_id"].filter(field => attributes[field] !== undefined)
      .map(field => [field, attributes[field]])),
  } as unknown as AstroObjectRecord;
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
  extras: { objects?: AstroObjectRecord[]; total?: number; totalRelation?: "eq" | "gte"; searchAfter?: unknown[]; message?: string } = {},
): AstroObjectQueryResult {
  return {
    status,
    index,
    objects: extras.objects ?? [],
    total: extras.total ?? 0,
    ...(extras.totalRelation ? { totalRelation: extras.totalRelation } : {}),
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

export class AstroObjectIndexService {
  readonly #baseUrl: string;
  readonly #objectIndex: string;
  readonly #timeoutMs: number;
  readonly #authorization?: string;
  readonly #dataBatches?: AstroObjectIndexOptions["dataBatches"];
  #batchMappingsReady = false;

  constructor(options: AstroObjectIndexOptions = {}) {
    this.#dataBatches = options.dataBatches;
    const endpoint = parseElasticsearchEndpoint(options.baseUrl ?? process.env.ASTRO_ES_URL ?? "");
    this.#baseUrl = endpoint.url ?? "";
    this.#authorization = endpoint.authorization;
    this.#objectIndex = normalizeIndex(
      options.objectIndex ?? process.env.ASTRO_ES_OBJECT_INDEX,
      "objectIndex",
      ASTRO_OBJECT_INDEX,
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

  get imageFootprintIndex(): string {
    return ASTRO_IMAGE_FOOTPRINT_INDEX;
  }

  async getPoint(id: string, readIndices: readonly string[], signal?: AbortSignal): Promise<AstroObjectRecord | undefined> {
    if (!id || id.length > 512) throw new RangeError("Invalid point identity");
    const indices = readIndices.map((index) => normalizeIndex(index, "readIndex", this.#objectIndex));
    const result = await this.#requestJson(`/${indices.map(encodeURIComponent).join(",")}/_search?ignore_unavailable=true`, JSON.stringify({ size: 1, query: { ids: { values: [id] } } }), "application/json", signal) as ElasticsearchSearchResponse;
    return hitsFromResponse(result).map((hit) => objectFromHit(hit)).find((value) => value !== undefined);
  }

  async getPointsByIds(ids: readonly string[], readIndices: readonly string[], signal?: AbortSignal): Promise<AstroObjectRecord[]> {
    if (!ids.length) return [];
    if (ids.length > 2_000 || ids.some((id) => typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id))) {
      throw new RangeError("point ids must contain at most 2000 SHA-256 identities");
    }
    const indices = readIndices.map((index) => normalizeIndex(index, "readIndex", this.#objectIndex));
    const response = await this.#requestJson(`/${indices.map(encodeURIComponent).join(",")}/_search?ignore_unavailable=true`, JSON.stringify({
      size: ids.length,
      query: { terms: { object_id: [...new Set(ids)] } },
      sort: [{ object_id: "asc" }],
    }), "application/json", signal) as ElasticsearchSearchResponse;
    return hitsFromResponse(response).map((hit) => objectFromHit(hit)).filter((point): point is AstroObjectRecord => Boolean(point));
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
        data_batch_id: { type: "keyword" },
        source_file_id: { type: "keyword" },
        scan_run_id: { type: "keyword" },
        evidence_ref: { type: "keyword", index: false },
        attributes: { type: "flattened", ignore_above: 8192 },
      },
    });
    await this.#ensureIndex(this.imageFootprintIndex, {
      dynamic: "strict",
      properties: {
        point_id: { type: "keyword" },
        asset_id: { type: "keyword" },
        data_batch_id: { type: "keyword" },
        source_id: { type: "keyword" },
        ra_min: { type: "double" },
        ra_max: { type: "double" },
        dec_min: { type: "double" },
        dec_max: { type: "double" },
      },
    });
    await this.#ensureIndex(ASTRO_FILE_INDEX, { dynamic: "strict", properties: {
      ...Object.fromEntries(["file_id", "asset_id", "scan_run_id", "data_batch_id", "source_uri", "survey", "release", "product", "modality", "spatial_status", "precision"].map(key => [key, { type: "keyword" }])),
      size_bytes: { type: "long" }, coverage_cells: { type: "integer" },
    } });
    if (this.#dataBatches && !this.#batchMappingsReady) {
      for (const index of new Set([this.#objectIndex, this.imageFootprintIndex])) {
        await this.#requestJson(`/${encodeURIComponent(index)}/_mapping`, JSON.stringify({ properties: { data_batch_id: { type: "keyword" } } }), "application/json");
      }
      this.#batchMappingsReady = true;
    }
  }

  async refresh(): Promise<void> {
    await this.#requestJson(`/${this.#objectIndex},${this.imageFootprintIndex},${ASTRO_FILE_INDEX}/_refresh`, "", "application/json");
  }

  async bulkImageFootprints(documents: AstroImageFootprintDocument[]): Promise<number> {
    if (!this.configured) throw new Error("ASTRO_ES_URL is not configured; cannot index image footprints");
    if (!Array.isArray(documents)) throw new TypeError("image footprint documents must be an array");
    if (!documents.length) return 0;
    let lines: string[] = [];
    let count = 0;
    let bytes = 0;
    const flush = async (): Promise<void> => {
      if (!lines.length) return;
      await this.#writeBulk(lines.join(""));
      lines = [];
      count = 0;
      bytes = 0;
    };
    for (const document of documents) {
      const { _id, _index, ...source } = document;
      if (!/^[a-f0-9]{64}$/.test(_id) || _index !== this.imageFootprintIndex
        || !/^[a-f0-9]{64}$/.test(document.point_id) || !document.asset_id
        || ![document.ra_min, document.ra_max, document.dec_min, document.dec_max].every(Number.isFinite)
        || document.ra_min < 0 || document.ra_max > 360 || document.ra_min > document.ra_max
        || document.dec_min < -90 || document.dec_max > 90 || document.dec_min > document.dec_max) {
        throw new RangeError("invalid image footprint document");
      }
      const payload = `${JSON.stringify({ index: { _index: this.imageFootprintIndex, _id } })}\n${JSON.stringify(source)}\n`;
      const payloadBytes = Buffer.byteLength(payload);
      if (payloadBytes > MAX_BULK_BYTES) throw new RangeError(`image footprint ${_id} exceeds the bulk request limit`);
      if (count >= MAX_BULK_DOCUMENTS || (count > 0 && bytes + payloadBytes > MAX_BULK_BYTES)) await flush();
      lines.push(payload);
      count += 1;
      bytes += payloadBytes;
    }
    await flush();
    return documents.length;
  }

  async queryImageFootprints(input: AstroImageFootprintQuery, signal?: AbortSignal): Promise<AstroImageFootprintQueryResult> {
    const raDeg = validateCoordinate(input.raDeg, "raDeg", 0, 360);
    const decDeg = validateCoordinate(input.decDeg, "decDeg", -90, 90);
    const scopes = validateLayerScopes(input.layerScopes);
    const limit = input.limit ?? 500;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2_000) throw new RangeError("image footprint limit must be between 1 and 2000");
    if (!scopes.length || !this.configured) return { pointIds: [], total: 0, truncated: false };
    let response: ElasticsearchSearchResponse;
    try {
      response = await this.#requestJson(`/${encodeURIComponent(this.imageFootprintIndex)}/_search`, JSON.stringify({
        track_total_hits: true,
        size: limit,
        _source: ["point_id"],
        query: { bool: { filter: [
          { range: { ra_min: { lte: raDeg } } },
          { range: { ra_max: { gte: raDeg } } },
          { range: { dec_min: { lte: decDeg } } },
          { range: { dec_max: { gte: decDeg } } },
          scopedLayerFilter(scopes),
        ] } },
        sort: [{ point_id: "asc" }],
      }), "application/json", signal) as ElasticsearchSearchResponse;
    } catch (error) {
      if (error instanceof ElasticsearchUnavailableError) return { pointIds: [], total: 0, truncated: false };
      throw error;
    }
    const hits = hitsFromResponse(response);
    const total = totalFromHits(response.hits?.total);
    const pointIds = [...new Set(hits.flatMap((hit) => isRecord(hit._source) && typeof hit._source.point_id === "string" ? [hit._source.point_id] : []))];
    return { pointIds, total, truncated: total > pointIds.length };
  }

  async bulkFiles(documents: AstroFileDocument[]): Promise<void> {
    for (const document of documents) {
      const { _id, ...source } = document;
      if (!/^[a-f0-9]{64}$/.test(_id) || !document.data_batch_id || !document.asset_id) throw new RangeError("Invalid file identity");
      const payload = JSON.stringify({ index: { _index: ASTRO_FILE_INDEX, _id } }) + "\n" + JSON.stringify(source) + "\n";
      if (Buffer.byteLength(payload) > 8 * 1024 * 1024) throw new RangeError("File coverage exceeds 8 MiB");
      await this.#writeBulk(payload);
    }
  }

  async bulk(documents: LocalObjectIndexDocument[]): Promise<{ objectCount: number }> {
    if (!this.configured) throw new Error("ASTRO_ES_URL is not configured; cannot bulk index local scan documents");
    if (!Array.isArray(documents)) throw new TypeError("documents must be an array");
    if (!documents.length) return { objectCount: 0 };

    let objectCount = 0;
    let lines: string[] = [];
    let documentCount = 0;
    let bytes = 0;

    const flush = async (): Promise<void> => {
      if (!lines.length) return;
      await this.#writeBulk(lines.join(""));
      lines = [];
      documentCount = 0;
      bytes = 0;
    };

    for (const document of documents) {
      if (!isRecord(document)) throw new TypeError("bulk documents must be objects");
      if (!("object_id" in document)) throw new TypeError("bulk requires position documents");
      const payload = bulkLinesFor(document, this.#objectIndex);
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
      objectCount += 1;
    }
    await flush();
    return { objectCount };
  }

  async queryPointDensity(input: AstroPointDensityQueryInput, readIndices: readonly string[] = [this.#objectIndex], signal?: AbortSignal): Promise<AstroPointDensityResult> {
    const normalized = validatePointDensityInput(input);
    const index = readIndices.map(value => normalizeIndex(value, "readIndex", this.#objectIndex)).join(",");
    let nside = normalized.targetNside;
    const empty = (status: AstroObjectQueryStatus, message?: string): AstroPointDensityResult => ({
      status, index, coordinateFrame: ASTRO_HEALPIX_COORDINATE_FRAME, ordering: ASTRO_HEALPIX_ORDERING,
      nside, total: 0, layers: normalized.layers.map(layer => ({ id: layer.id, count: 0 })), cells: [], truncated: false,
      ...(message ? { message } : {}),
    });
    if (!this.configured) return empty("unavailable", "ASTRO_ES_URL is not configured");
    if (!normalized.layers.some(layer => layer.scopes.length)) return empty("ready");

    try {
      const encodedIndex = encodeURIComponent(index);
      for (let attempt = 0; attempt <= ASTRO_OBJECT_NATIVE_ORDER; attempt += 1) {
        const response = await this.#requestJson(
          `/${encodedIndex}/_search?ignore_unavailable=true`,
          JSON.stringify(pointDensityQueryBody(normalized, nside)),
          "application/json",
          signal,
          normalized.layers.flatMap(layer => layer.scopes.map(scope => scope.assetId)),
        ) as ElasticsearchSearchResponse;
        if (response.timed_out || (isRecord(response._shards) && Number(response._shards.failed) > 0)) {
          throw new Error("Point density aggregation did not complete");
        }
        if (!isRecord(response.aggregations)) throw new Error("Point density aggregation is missing");
        const allCells = response.aggregations.by_cell;
        const byLayer = response.aggregations.by_layer;
        if (!isRecord(allCells) || !Array.isArray(allCells.buckets) || !isRecord(byLayer) || !isRecord(byLayer.buckets)) {
          throw new Error("Point density buckets are missing");
        }
        let incomplete = Number(allCells.sum_other_doc_count) > 0;
        for (const layer of normalized.layers) {
          const result = byLayer.buckets[layer.id];
          if (!isRecord(result) || !isRecord(result.by_cell) || !Array.isArray(result.by_cell.buckets)) {
            throw new Error(`Point density buckets are missing for layer ${layer.id}`);
          }
          incomplete ||= Number(result.by_cell.sum_other_doc_count) > 0;
        }
        if (incomplete) {
          if (nside <= 1) throw new Error("Point density exceeds the aggregation bucket budget at NSIDE 1");
          nside /= 2;
          continue;
        }

        const cells = new Map<number, AstroPointDensityCell>();
        for (const bucket of allCells.buckets) {
          if (!isRecord(bucket)) continue;
          const pixel = Number(bucket.key);
          if (!Number.isSafeInteger(pixel) || pixel < 0 || pixel >= 12 * nside ** 2) continue;
          const bySurvey = bucket.by_survey;
          if (!isRecord(bySurvey) || !Array.isArray(bySurvey.buckets)) throw new Error("Point density survey counts are missing");
          if (Number(bySurvey.sum_other_doc_count) > 0 || Number(bySurvey.doc_count_error_upper_bound) > 0) {
            throw new Error("Point density survey counts exceed the aggregation budget");
          }
          const surveyCounts = bySurvey.buckets.flatMap(survey => isRecord(survey) && typeof survey.key === "string"
            && Number.isSafeInteger(survey.doc_count) && Number(survey.doc_count) > 0
            ? [{ id: survey.key, count: Number(survey.doc_count) }] : []);
          const surveys: AstroPointDensityCell["surveys"] = surveyCounts.filter(survey => !UNASSIGNED_DENSITY_SURVEYS.includes(survey.id));
          const unassignedCount = surveyCounts.filter(survey => UNASSIGNED_DENSITY_SURVEYS.includes(survey.id)).reduce((sum, survey) => sum + survey.count, 0);
          if (unassignedCount) {
            const unassignedAssets = bucket.unassigned_assets;
            const byAsset = isRecord(unassignedAssets) ? unassignedAssets.by_asset : undefined;
            if (!isRecord(byAsset) || !Array.isArray(byAsset.buckets) || Number(byAsset.sum_other_doc_count) > 0
              || Number(byAsset.doc_count_error_upper_bound) > 0) throw new Error("Point density unassigned survey sources are incomplete");
            const sources = byAsset.buckets.flatMap(asset => isRecord(asset) && typeof asset.key === "string"
              && Number.isSafeInteger(asset.doc_count) && Number(asset.doc_count) > 0
              ? [{ id: "", count: Number(asset.doc_count), ...(asset.key ? { assetId: asset.key } : {}) }] : []);
            if (sources.reduce((sum, source) => sum + source.count, 0) !== unassignedCount) throw new Error("Point density unassigned survey sources are incomplete");
            surveys.push(...sources);
          }
          const count = Number(bucket.doc_count) || 0;
          if (surveys.reduce((sum, survey) => sum + survey.count, 0) !== count) {
            throw new Error("Point density survey counts are incomplete");
          }
          cells.set(pixel, { pixel, count, layers: [], surveys });
        }
        const layerBuckets = byLayer.buckets as Record<string, unknown>;
        const layerCounts = normalized.layers.map(layer => {
          const result = layerBuckets[layer.id] as Record<string, unknown>;
          const byCell = result.by_cell as Record<string, unknown>;
          const buckets = byCell.buckets as unknown[];
          let count = 0;
          for (const bucket of buckets) {
            if (!isRecord(bucket)) continue;
            const pixel = Number(bucket.key);
            const layerCount = Number(bucket.doc_count) || 0;
            count += layerCount;
            const cell = cells.get(pixel);
            if (cell && layerCount > 0) cell.layers.push({ id: layer.id, count: layerCount });
          }
          return { id: layer.id, count };
        });
        return {
          status: "ready", index, coordinateFrame: ASTRO_HEALPIX_COORDINATE_FRAME, ordering: ASTRO_HEALPIX_ORDERING,
          nside, total: [...cells.values()].reduce((sum, cell) => sum + cell.count, 0), layers: layerCounts,
          cells: [...cells.values()].sort((left, right) => left.pixel - right.pixel), truncated: false,
        };
      }
      throw new Error("Point density could not fit within the aggregation bucket budget");
    } catch (error) {
      signal?.throwIfAborted();
      const message = error instanceof Error ? error.message : String(error);
      return empty(error instanceof ElasticsearchUnavailableError ? "unavailable" : "error", message);
    }
  }

  async queryObjects(input: ObjectRegionQueryInput, readIndices?: readonly string[], signal?: AbortSignal): Promise<AstroObjectQueryResult> {
    const normalized = validateQueryInput(input);
    if (!this.configured) {
      return queryResult(this.#objectIndex, normalized, "unavailable", {
        message: "ASTRO_ES_URL is not configured",
      });
    }

    try {
      const response = await this.#requestJson(
        `/${encodeURIComponent(readIndices?.map((index) => normalizeIndex(index, "readIndex", this.#objectIndex)).join(",") ?? this.#objectIndex)}/_search${readIndices ? "?ignore_unavailable=true" : ""}`,
        JSON.stringify(queryBody(normalized)),
        "application/json",
        signal,
        normalized.layerScopes?.map(scope => scope.assetId) ?? normalized.assetIds,
      ) as ElasticsearchSearchResponse;
      const hits = hitsFromResponse(response);
      const reportedTotal = totalFromHits(response.hits?.total);
      return queryResult(this.#objectIndex, normalized, "ready", {
        objects: hits.map(normalized.includeAttributes ? objectFromHit : pointFromHit),
        total: normalized.trackTotalHits ? reportedTotal : Math.max(reportedTotal, hits.length),
        totalRelation: normalized.trackTotalHits ? "eq" : "gte",
        searchAfter: nextSearchAfter(hits),
      });
    } catch (error) {
      signal?.throwIfAborted();
      const message = error instanceof Error ? error.message : String(error);
      return queryResult(
        this.#objectIndex,
        normalized,
        error instanceof ElasticsearchUnavailableError ? "unavailable" : "error",
        { message },
      );
    }
  }

  async #writeBulk(body: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await this.#requestJson("/_bulk", body, "application/x-ndjson");
        const error = bulkResponseError(response);
        if (error) throw error;
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (attempt >= 3 || !/HTTP (?:408|429|502|503|504)\b|timed out|fetch failed|ECONNRESET|ETIMEDOUT/i.test(message)) throw error;
        // Every write uses stable index IDs. Repeating an ambiguously committed
        // batch preserves its rows and only advances the caller after success.
        await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt));
      }
    }
  }

  async #requestJson(path: string, body: string, contentType: string, signal?: AbortSignal, assetIds?: readonly string[]): Promise<unknown> {
    signal?.throwIfAborted();
    if (this.#dataBatches && /\/_search(?:\?|$)/.test(path)) {
      const batches = await this.#dataBatches(assetIds);
      const request = JSON.parse(body) as Record<string, unknown>;
      const visible = batches.size ? { bool: { should: [...batches].map(([assetId, batchId]) => ({ bool: { filter: [
        { term: { asset_id: assetId } }, { term: { data_batch_id: batchId } },
      ] } })), minimum_should_match: 1 } } : { match_none: {} };
      request.query = { bool: { filter: [request.query ?? { match_all: {} }, visible] } };
      body = JSON.stringify(request);
    }

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
        signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
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
      signal?.throwIfAborted();
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

export type { LocalObjectIndexDocument } from "./local-scan.js";
