import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

import { CsvError, parse } from "csv-parse";
import { Healpix, Pointing } from "healpixjs";

export const LOCAL_SCAN_HEALPIX_ORDER = 8;
export const LOCAL_SCAN_HEALPIX_NSIDE = 2 ** LOCAL_SCAN_HEALPIX_ORDER;
export const LOCAL_OBJECT_INDEX = "astro_object_index_v1";
export const LOCAL_COVERAGE_INDEX = "astro_coverage_index_v1";

const DEFAULT_MAX_COLUMNS = 10_000;
const DEFAULT_MAX_RECORD_SIZE = 8 * 1024 * 1024;
const DEFAULT_MAX_OBJECT_ID_LENGTH = 512;
const DEFAULT_MAX_ATTRIBUTE_VALUE_LENGTH = 1_000_000;
const DEFAULT_MAX_ATTRIBUTE_COUNT = 10_000;
const TEXT_LIMIT = 2_048;

type Awaitable<T> = T | PromiseLike<T>;

export interface LocalCsvScanLimits {
  /** Maximum bytes in the source file, when supplied. */
  maxFileBytes?: number;
  /** Maximum data rows, including rows skipped as invalid. */
  maxRows?: number;
  /** Maximum valid object documents. */
  maxObjects?: number;
  /** Maximum invalid data rows. */
  maxInvalidRows?: number;
  /** Maximum number of columns in the CSV header. */
  maxColumns?: number;
  /** Maximum characters buffered for one CSV record. */
  maxRecordSize?: number;
  /** Maximum length of one object identifier. */
  maxObjectIdLength?: number;
  /** Maximum length of one attribute value. */
  maxAttributeValueLength?: number;
  /** Maximum number of non-coordinate attributes. */
  maxAttributeCount?: number;
}

export interface LocalCsvScanOptions {
  objectIdColumn: string;
  raColumn: string;
  decColumn: string;
  surveyId: string;
  releaseId: string;
  product: string;
  modality: string;
  assetId: string;
  sourceFileId: string;
  scanRunId: string;
  /** The workspace scan contract uses HEALPix order 8 (NSIDE 256, NESTED ordering). */
  healpixOrder?: number;
  objectIndex?: string;
  coverageIndex?: string;
  limits?: LocalCsvScanLimits;
  /** Collect object documents in the result; disabled by default for large files. */
  collectObjects?: boolean;
  sink?: LocalCsvDocumentSink;
}

export interface LocalObjectIndexDocument {
  _index: string;
  _id: string;
  object_id: string;
  ra_deg: number;
  dec_deg: number;
  sky_position: {
    lat: number;
    lon: number;
  };
  healpix_order: number;
  healpix_pixel: number;
  survey: string;
  release: string;
  product: string;
  modality: string;
  asset_id: string;
  source_file_id: string;
  scan_run_id: string;
  attributes: Record<string, string>;
}

export interface LocalCoverageFactDocument {
  _index: string;
  _id: string;
  healpix_order: number;
  healpix_pixel: number;
  objectCount: number;
  survey: string;
  release: string;
  product: string;
  modality: string;
  asset_id: string;
  source_file_id: string;
  scan_run_id: string;
}

export type LocalScanDocument = LocalObjectIndexDocument | LocalCoverageFactDocument;
export type LocalCsvDocumentSink = (document: LocalScanDocument) => Awaitable<void>;
export type LocalScanSink = LocalCsvDocumentSink;

export interface LocalCsvFileSummary {
  filePath: string;
  byteSize: number;
  columns: string[];
  survey: string;
  release: string;
  product: string;
  modality: string;
  asset_id: string;
  source_file_id: string;
  scan_run_id: string;
  healpix_order: number;
  rowCount: number;
  objectCount: number;
  invalidRowCount: number;
  csvErrorCount: number;
  coveragePixelCount: number;
}

export interface LocalCsvScanResult {
  summary: LocalCsvFileSummary;
  coverageDocuments: LocalCoverageFactDocument[];
  objectDocuments?: LocalObjectIndexDocument[];
}

export class LocalCsvScanConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalCsvScanConfigurationError";
  }
}

export class LocalCsvScanHeaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalCsvScanHeaderError";
  }
}

interface NormalizedLimits {
  maxFileBytes: number;
  maxRows: number;
  maxObjects: number;
  maxInvalidRows: number;
  maxColumns: number;
  maxRecordSize: number;
  maxObjectIdLength: number;
  maxAttributeValueLength: number;
  maxAttributeCount: number;
}

interface NormalizedOptions {
  objectIdColumn: string;
  raColumn: string;
  decColumn: string;
  surveyId: string;
  releaseId: string;
  product: string;
  modality: string;
  assetId: string;
  sourceFileId: string;
  scanRunId: string;
  healpixOrder: number;
  objectIndex: string;
  coverageIndex: string;
  limits: NormalizedLimits;
  collectObjects: boolean;
  sink?: LocalCsvDocumentSink;
}

function requiredText(value: unknown, name: string, maximum = TEXT_LIMIT): string {
  if (typeof value !== "string") throw new LocalCsvScanConfigurationError(`${name} is required`);
  const result = value.trim();
  if (!result) throw new LocalCsvScanConfigurationError(`${name} is required`);
  if (result.length > maximum) throw new LocalCsvScanConfigurationError(`${name} must contain at most ${maximum} characters`);
  return result;
}

function optionalIndexName(value: unknown, name: string, fallback: string): string {
  if (value === undefined) return fallback;
  return requiredText(value, name, 255);
}

function nonNegativeLimit(value: unknown, name: string, fallback: number, allowZero = true): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || (!allowZero && value === 0)) {
    throw new LocalCsvScanConfigurationError(`${name} must be a ${allowZero ? "non-negative" : "positive"} safe integer`);
  }
  return value;
}

function normalizeOptions(input: LocalCsvScanOptions): NormalizedOptions {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new LocalCsvScanConfigurationError("scan options are required");
  }
  const options = input as Partial<LocalCsvScanOptions>;
  const objectIdColumn = requiredText(options.objectIdColumn, "objectIdColumn", 512);
  const raColumn = requiredText(options.raColumn, "raColumn", 512);
  const decColumn = requiredText(options.decColumn, "decColumn", 512);
  if (new Set([objectIdColumn, raColumn, decColumn]).size !== 3) {
    throw new LocalCsvScanConfigurationError("objectIdColumn, raColumn, and decColumn must be distinct");
  }

  const rawLimits = options.limits;
  if (rawLimits !== undefined && (!rawLimits || typeof rawLimits !== "object" || Array.isArray(rawLimits))) {
    throw new LocalCsvScanConfigurationError("limits must be an object");
  }
  const limits = (rawLimits ?? {}) as LocalCsvScanLimits;
  const normalizedLimits: NormalizedLimits = {
    maxFileBytes: nonNegativeLimit(limits.maxFileBytes, "limits.maxFileBytes", Number.POSITIVE_INFINITY),
    maxRows: nonNegativeLimit(limits.maxRows, "limits.maxRows", Number.POSITIVE_INFINITY),
    maxObjects: nonNegativeLimit(limits.maxObjects, "limits.maxObjects", Number.POSITIVE_INFINITY),
    maxInvalidRows: nonNegativeLimit(limits.maxInvalidRows, "limits.maxInvalidRows", Number.POSITIVE_INFINITY),
    maxColumns: nonNegativeLimit(limits.maxColumns, "limits.maxColumns", DEFAULT_MAX_COLUMNS, false),
    maxRecordSize: nonNegativeLimit(limits.maxRecordSize, "limits.maxRecordSize", DEFAULT_MAX_RECORD_SIZE, false),
    maxObjectIdLength: nonNegativeLimit(limits.maxObjectIdLength, "limits.maxObjectIdLength", DEFAULT_MAX_OBJECT_ID_LENGTH, false),
    maxAttributeValueLength: nonNegativeLimit(limits.maxAttributeValueLength, "limits.maxAttributeValueLength", DEFAULT_MAX_ATTRIBUTE_VALUE_LENGTH),
    maxAttributeCount: nonNegativeLimit(limits.maxAttributeCount, "limits.maxAttributeCount", DEFAULT_MAX_ATTRIBUTE_COUNT),
  };

  const healpixOrder = options.healpixOrder === undefined ? LOCAL_SCAN_HEALPIX_ORDER : options.healpixOrder;
  if (typeof healpixOrder !== "number" || !Number.isInteger(healpixOrder) || healpixOrder !== LOCAL_SCAN_HEALPIX_ORDER) {
    throw new LocalCsvScanConfigurationError(`healpixOrder must be ${LOCAL_SCAN_HEALPIX_ORDER}`);
  }
  if (typeof options.collectObjects !== "undefined" && typeof options.collectObjects !== "boolean") {
    throw new LocalCsvScanConfigurationError("collectObjects must be a boolean");
  }
  if (options.sink !== undefined && typeof options.sink !== "function") {
    throw new LocalCsvScanConfigurationError("sink must be a function");
  }

  return {
    objectIdColumn,
    raColumn,
    decColumn,
    surveyId: requiredText(options.surveyId, "surveyId"),
    releaseId: requiredText(options.releaseId, "releaseId"),
    product: requiredText(options.product, "product"),
    modality: requiredText(options.modality, "modality"),
    assetId: requiredText(options.assetId, "assetId"),
    sourceFileId: requiredText(options.sourceFileId, "sourceFileId"),
    scanRunId: requiredText(options.scanRunId, "scanRunId"),
    healpixOrder,
    objectIndex: optionalIndexName(options.objectIndex, "objectIndex", LOCAL_OBJECT_INDEX),
    coverageIndex: optionalIndexName(options.coverageIndex, "coverageIndex", LOCAL_COVERAGE_INDEX),
    limits: normalizedLimits,
    collectObjects: options.collectObjects ?? false,
    sink: options.sink,
  };
}

function filePathText(filePath: string | URL): string {
  if (typeof filePath === "string") {
    if (!filePath.trim()) throw new LocalCsvScanConfigurationError("filePath is required");
    return filePath;
  }
  if (filePath instanceof URL) return filePath.toString();
  throw new LocalCsvScanConfigurationError("filePath must be a path or file URL");
}

function validateHeaders(rawHeaders: string[], options: NormalizedOptions): string[] {
  if (!Array.isArray(rawHeaders) || rawHeaders.length === 0) {
    throw new LocalCsvScanHeaderError("CSV header is empty");
  }
  if (rawHeaders.length > options.limits.maxColumns) {
    throw new LocalCsvScanHeaderError(`CSV header contains more than ${options.limits.maxColumns} columns`);
  }
  const headers = rawHeaders.map((header) => typeof header === "string" ? header.trim() : "");
  if (headers.some((header) => !header)) throw new LocalCsvScanHeaderError("CSV header contains an empty column name");
  const seen = new Set<string>();
  for (const header of headers) {
    if (seen.has(header)) throw new LocalCsvScanHeaderError(`CSV header contains duplicate column: ${header}`);
    seen.add(header);
  }
  for (const [name, column] of [["objectIdColumn", options.objectIdColumn], ["raColumn", options.raColumn], ["decColumn", options.decColumn]] as const) {
    if (!seen.has(column)) throw new LocalCsvScanHeaderError(`${name} column not found in CSV header: ${column}`);
  }
  if (headers.length - 3 > options.limits.maxAttributeCount) {
    throw new LocalCsvScanHeaderError(`CSV contains more than ${options.limits.maxAttributeCount} attribute columns`);
  }
  return headers;
}

function pointingFor(raDeg: number, decDeg: number): Pointing {
  return new Pointing(null, false, ((90 - decDeg) * Math.PI) / 180, (raDeg * Math.PI) / 180);
}

function coordinateValue(value: unknown, name: string): number | null {
  const text = typeof value === "string" ? value.trim() : String(value ?? "").trim();
  if (!text) return null;
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return null;
  if (name === "ra" && (parsed < 0 || parsed > 360)) return null;
  if (name === "dec" && (parsed < -90 || parsed > 90)) return null;
  return name === "ra" && (parsed === 360 || Object.is(parsed, -0)) ? 0 : parsed;
}

function geoLongitudeForRa(raDeg: number): number {
  return raDeg > 180 ? raDeg - 360 : raDeg;
}

function digestTuple(values: readonly (string | number)[]): string {
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}

/** Stable identity for one object across repeated scans of the same source. */
export function stableObjectDocumentId(assetId: string, sourceFileId: string, objectId: string): string {
  return digestTuple([assetId, sourceFileId, objectId]);
}

/** Stable identity for one provenance-specific coverage fact. */
export function stableCoverageDocumentId(
  assetId: string,
  sourceFileId: string,
  healpixOrder: number,
  healpixPixel: number,
): string {
  return digestTuple(["coverage", assetId, sourceFileId, healpixOrder, healpixPixel]);
}

function invalidCoordinateOrField(row: Record<string, unknown>, options: NormalizedOptions, headers: string[]): boolean {
  const objectId = String(row[options.objectIdColumn] ?? "").trim();
  if (!objectId || objectId.length > options.limits.maxObjectIdLength) return true;
  if (coordinateValue(row[options.raColumn], "ra") === null || coordinateValue(row[options.decColumn], "dec") === null) return true;
  for (const header of headers) {
    if (header === options.objectIdColumn || header === options.raColumn || header === options.decColumn) continue;
    const value = String(row[header] ?? "");
    if (value.length > options.limits.maxAttributeValueLength) return true;
  }
  return false;
}

function objectDocument(
  row: Record<string, unknown>,
  headers: string[],
  options: NormalizedOptions,
  healpix: Healpix,
): LocalObjectIndexDocument | null {
  if (invalidCoordinateOrField(row, options, headers)) return null;
  const objectId = String(row[options.objectIdColumn] ?? "").trim();
  const raDeg = coordinateValue(row[options.raColumn], "ra");
  const decDeg = coordinateValue(row[options.decColumn], "dec");
  if (raDeg === null || decDeg === null) return null;
  const pixel = healpix.ang2pix(pointingFor(raDeg, decDeg));
  if (!Number.isSafeInteger(pixel) || pixel < 0 || pixel >= healpix.npix) return null;
  const attributes = Object.fromEntries(
    headers
      .filter((header) => header !== options.objectIdColumn && header !== options.raColumn && header !== options.decColumn)
      .map((header) => [header, String(row[header] ?? "")]),
  );
  return {
    _index: options.objectIndex,
    _id: stableObjectDocumentId(options.assetId, options.sourceFileId, objectId),
    object_id: objectId,
    ra_deg: raDeg,
    dec_deg: decDeg,
    sky_position: { lat: decDeg, lon: geoLongitudeForRa(raDeg) },
    healpix_order: options.healpixOrder,
    healpix_pixel: pixel,
    survey: options.surveyId,
    release: options.releaseId,
    product: options.product,
    modality: options.modality,
    asset_id: options.assetId,
    source_file_id: options.sourceFileId,
    scan_run_id: options.scanRunId,
    attributes,
  };
}

function limitError(name: string, value: number, limit: number): RangeError {
  return new RangeError(`${name} limit exceeded: ${value} > ${limit}`);
}

/**
 * Stream a local CSV into object and coverage documents. The source file is
 * never read into one in-memory string; backpressure also includes async sink
 * work because each document is awaited before the next row is consumed.
 */
export async function scanLocalCsv(
  filePath: string | URL,
  input: LocalCsvScanOptions,
  sink?: LocalCsvDocumentSink,
): Promise<LocalCsvScanResult> {
  const sourcePath = filePathText(filePath);
  const options = normalizeOptions(input);
  const documentSink = sink ?? options.sink;
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) throw new LocalCsvScanConfigurationError(`CSV source is not a regular file: ${sourcePath}`);
  if (fileStat.size > options.limits.maxFileBytes) throw limitError("file byte", fileStat.size, options.limits.maxFileBytes);

  const healpix = new Healpix(2 ** options.healpixOrder);
  const coverageCounts = new Map<number, number>();
  const objectDocuments: LocalObjectIndexDocument[] = [];
  let headers: string[] | undefined;
  let rowCount = 0;
  let objectCount = 0;
  let invalidRowCount = 0;
  let csvErrorCount = 0;

  const countInvalidRow = (csvError = false): void => {
    rowCount += 1;
    invalidRowCount += 1;
    if (csvError) csvErrorCount += 1;
    if (rowCount > options.limits.maxRows) throw limitError("row", rowCount, options.limits.maxRows);
    if (invalidRowCount > options.limits.maxInvalidRows) throw limitError("invalid row", invalidRowCount, options.limits.maxInvalidRows);
  };

  const inputStream = createReadStream(filePath);
  const parser = inputStream.pipe(parse({
    bom: true,
    columns: (rawHeaders: string[]) => {
      const validated = validateHeaders(rawHeaders, options);
      headers = validated;
      return validated;
    },
    max_record_size: options.limits.maxRecordSize,
    on_skip: (error) => {
      countInvalidRow(true);
    },
    skip_empty_lines: true,
    skip_records_with_error: true,
    trim: true,
  }));

  try {
    for await (const rawRow of parser) {
      if (!headers) throw new LocalCsvScanHeaderError("CSV header is missing or invalid");
      rowCount += 1;
      if (rowCount > options.limits.maxRows) throw limitError("row", rowCount, options.limits.maxRows);
      const document = objectDocument(rawRow as Record<string, unknown>, headers, options, healpix);
      if (!document) {
        invalidRowCount += 1;
        if (invalidRowCount > options.limits.maxInvalidRows) throw limitError("invalid row", invalidRowCount, options.limits.maxInvalidRows);
        continue;
      }
      objectCount += 1;
      if (objectCount > options.limits.maxObjects) throw limitError("object", objectCount, options.limits.maxObjects);
      coverageCounts.set(document.healpix_pixel, (coverageCounts.get(document.healpix_pixel) ?? 0) + 1);
      if (options.collectObjects) objectDocuments.push(document);
      if (documentSink) await documentSink(document);
    }
  } catch (error) {
    if (!headers && error instanceof LocalCsvScanHeaderError) throw error;
    if (!headers) {
      if (error instanceof CsvError) throw new LocalCsvScanHeaderError(`CSV header is invalid: ${error.message}`);
      throw error;
    }
    throw error;
  }

  if (!headers) throw new LocalCsvScanHeaderError("CSV header is missing or invalid");
  const coverageDocuments = [...coverageCounts.entries()]
    .sort(([left], [right]) => left - right)
    .map(([pixel, count]): LocalCoverageFactDocument => ({
      _index: options.coverageIndex,
      _id: stableCoverageDocumentId(options.assetId, options.sourceFileId, options.healpixOrder, pixel),
      healpix_order: options.healpixOrder,
      healpix_pixel: pixel,
      objectCount: count,
      survey: options.surveyId,
      release: options.releaseId,
      product: options.product,
      modality: options.modality,
      asset_id: options.assetId,
      source_file_id: options.sourceFileId,
      scan_run_id: options.scanRunId,
    }));

  for (const document of coverageDocuments) {
    if (documentSink) await documentSink(document);
  }

  const summary: LocalCsvFileSummary = {
    filePath: sourcePath,
    byteSize: fileStat.size,
    columns: [...headers],
    survey: options.surveyId,
    release: options.releaseId,
    product: options.product,
    modality: options.modality,
    asset_id: options.assetId,
    source_file_id: options.sourceFileId,
    scan_run_id: options.scanRunId,
    healpix_order: options.healpixOrder,
    rowCount,
    objectCount,
    invalidRowCount,
    csvErrorCount,
    coveragePixelCount: coverageDocuments.length,
  };
  return {
    summary,
    coverageDocuments,
    ...(options.collectObjects ? { objectDocuments } : {}),
  };
}

export const scanCsvFile = scanLocalCsv;
export const scanLocalCsvFile = scanLocalCsv;
