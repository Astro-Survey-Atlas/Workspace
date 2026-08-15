import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import { parse } from "csv-parse";

import type { ConnectorRecord } from "./connectors.js";
import { LocalConnectorPolicyError, type LocalConnectorRootsPolicy } from "./local-connector-roots.js";

export const DEFAULT_LOCAL_FILE_LIMIT = 200;
export const MAX_LOCAL_FILE_LIMIT = 1_000;

const MAX_RELATIVE_PATH_LENGTH = 2_048;
const MAX_HEADER_BYTES = 1024 * 1024;
const MAX_HEADER_COLUMNS = 10_000;
const INSPECTION_FIELDS = new Set(["relativePath"]);

export interface LocalCsvFileEntry {
  relativePath: string;
  sizeBytes: number;
}

export interface LocalCsvFileList {
  files: LocalCsvFileEntry[];
  limit: number;
  truncated: boolean;
}

export interface LocalCsvColumnSuggestions {
  objectIdColumn?: string;
  raColumn?: string;
  decColumn?: string;
  confidence: number;
  warnings: string[];
}

export interface LocalCsvInspection {
  relativePath: string;
  sizeBytes: number;
  columns: string[];
  suggestions: LocalCsvColumnSuggestions;
}

export class LocalSourceInspectionCapabilityError extends Error {
  readonly statusCode = 422;

  constructor() {
    super("Local source inspection is only supported for local connectors");
    this.name = "LocalSourceInspectionCapabilityError";
  }
}

export class LocalSourceInspectionError extends Error {
  readonly statusCode = 409;

  constructor(message: string) {
    super(message);
    this.name = "LocalSourceInspectionError";
  }
}

function isWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

export function normalizeLocalSourceRelativePath(
  value: unknown,
  name = "relativePath",
  options: { csvOnly?: boolean } = {},
): string {
  if (typeof value !== "string" || !value.trim()) throw new RangeError(`${name} must be a non-empty string`);
  const result = value.trim();
  if (result.length > MAX_RELATIVE_PATH_LENGTH) throw new RangeError(`${name} must contain at most ${MAX_RELATIVE_PATH_LENGTH} characters`);
  if (result.includes("\0")) throw new RangeError(`${name} contains an invalid null byte`);
  if (path.isAbsolute(result) || path.win32.isAbsolute(result) || /^[a-zA-Z]:/.test(result)) {
    throw new RangeError(`${name} must be relative to the connector root`);
  }
  const segments = result.split(/[\\/]/);
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new RangeError(`${name} cannot contain empty or dot segments`);
  }
  const normalized = segments.join("/");
  if (options.csvOnly && !normalized.toLowerCase().endsWith(".csv")) throw new RangeError(`${name} must identify a CSV file`);
  return normalized;
}

export function normalizeLocalFileLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_LOCAL_FILE_LIMIT;
  const limit = typeof value === "string" && value.trim() ? Number(value) : value;
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LOCAL_FILE_LIMIT) {
    throw new RangeError(`limit must be a safe integer between 1 and ${MAX_LOCAL_FILE_LIMIT}`);
  }
  return limit;
}

function assertLocalConnector(connector: ConnectorRecord): void {
  if (connector.kind !== "local") throw new LocalSourceInspectionCapabilityError();
}

function containerFilePath(rootPath: string, relativePath: string): string {
  const normalizedRoot = path.normalize(rootPath);
  const candidate = path.resolve(normalizedRoot, ...relativePath.split("/"));
  if (!isWithinRoot(candidate, normalizedRoot)) throw new RangeError("relativePath must stay inside the connector root");
  return candidate;
}

function lexicalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function resolvedInspectionFile(
  connector: ConnectorRecord,
  roots: LocalConnectorRootsPolicy,
  relativePath: string,
): Promise<{ fileSystemPath: string; sizeBytes: number }> {
  const rootPath = connector.config.rootPath ?? "";
  const root = await roots.resolveReadableDirectory(rootPath);
  const file = await roots.resolveReadableFile(containerFilePath(root.containerPath, relativePath));
  if (!isWithinRoot(file.fileSystemPath, root.fileSystemPath)) {
    throw new RangeError("relativePath resolves outside the connector root");
  }
  try {
    const details = await stat(file.fileSystemPath);
    if (!details.isFile()) throw new LocalSourceInspectionError("CSV source is not a regular file");
    return { fileSystemPath: file.fileSystemPath, sizeBytes: details.size };
  } catch (error) {
    if (error instanceof LocalSourceInspectionError) throw error;
    throw new LocalSourceInspectionError("CSV source could not be inspected");
  }
}

export async function listLocalCsvFiles(
  connector: ConnectorRecord,
  roots: LocalConnectorRootsPolicy,
  limit = DEFAULT_LOCAL_FILE_LIMIT,
): Promise<LocalCsvFileList> {
  assertLocalConnector(connector);
  const normalizedLimit = normalizeLocalFileLimit(limit);
  const root = await roots.resolveReadableDirectory(connector.config.rootPath ?? "");
  let entries;
  try {
    entries = await readdir(root.fileSystemPath, { withFileTypes: true });
  } catch {
    throw new LocalSourceInspectionError("Connector root could not be enumerated");
  }
  const candidates = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".csv"))
    .map((entry) => entry.name)
    .sort(lexicalCompare);
  const files: LocalCsvFileEntry[] = [];
  for (const relativePath of candidates.slice(0, normalizedLimit)) {
    try {
      const file = await resolvedInspectionFile(connector, roots, relativePath);
      files.push({ relativePath, sizeBytes: file.sizeBytes });
    } catch (error) {
      if (error instanceof LocalConnectorPolicyError || error instanceof LocalSourceInspectionError) {
        throw new LocalSourceInspectionError("A local CSV file could not be inspected");
      }
      throw error;
    }
  }
  return { files, limit: normalizedLimit, truncated: candidates.length > normalizedLimit };
}

async function readCsvHeader(fileSystemPath: string): Promise<string[]> {
  const source = createReadStream(fileSystemPath, { highWaterMark: 64 * 1024 });
  const parser = source.pipe(parse({ bom: true, max_record_size: MAX_HEADER_BYTES, skip_empty_lines: true }));
  try {
    for await (const rawRecord of parser) {
      if (!Array.isArray(rawRecord)) break;
      if (rawRecord.length < 1 || rawRecord.length > MAX_HEADER_COLUMNS) {
        throw new RangeError(`CSV header must contain between 1 and ${MAX_HEADER_COLUMNS} columns`);
      }
      return rawRecord.map((value) => String(value).trim());
    }
    throw new RangeError("CSV header is empty");
  } catch (error) {
    if (error instanceof RangeError) throw error;
    throw new RangeError("CSV header is invalid");
  } finally {
    parser.destroy();
    source.destroy();
  }
}

function normalizedColumn(value: string): string {
  return value.toLowerCase().replace(/[\s_.-]+/g, "");
}

function suggestedColumn(columns: string[], aliases: readonly string[], warnings: string[], label: string): string | undefined {
  const byNormalized = new Map<string, string[]>();
  for (const column of columns) {
    const key = normalizedColumn(column);
    const values = byNormalized.get(key) ?? [];
    values.push(column);
    byNormalized.set(key, values);
  }
  for (const alias of aliases) {
    const matches = byNormalized.get(alias);
    if (!matches?.length) continue;
    if (matches.length > 1) warnings.push(`Multiple columns match the suggested ${label} alias: ${matches.join(", ")}`);
    return matches[0];
  }
  warnings.push(`No common ${label} column alias was found`);
  return undefined;
}

function columnSuggestions(columns: string[]): LocalCsvColumnSuggestions {
  const warnings: string[] = [];
  if (columns.some((column) => !column)) warnings.push("CSV header contains an empty column name");
  const duplicateColumns = columns.filter((column, index) => column && columns.indexOf(column) !== index);
  if (duplicateColumns.length) warnings.push(`CSV header contains duplicate columns: ${[...new Set(duplicateColumns)].join(", ")}`);
  const objectIdColumn = suggestedColumn(columns, ["id", "objectid", "sourceid", "hdf5index", "objid"], warnings, "object id");
  const raColumn = suggestedColumn(columns, ["ra", "radeg", "raj2000", "rightascension", "alpha", "alphaj2000"], warnings, "right ascension");
  const decColumn = suggestedColumn(columns, ["dec", "decdeg", "dej2000", "declination", "delta", "deltaj2000"], warnings, "declination");
  const found = [objectIdColumn, raColumn, decColumn].filter(Boolean).length;
  return {
    ...(objectIdColumn ? { objectIdColumn } : {}),
    ...(raColumn ? { raColumn } : {}),
    ...(decColumn ? { decColumn } : {}),
    confidence: Number((found / 3).toFixed(2)),
    warnings,
  };
}

export async function inspectLocalCsv(
  connector: ConnectorRecord,
  roots: LocalConnectorRootsPolicy,
  input: unknown,
): Promise<LocalCsvInspection> {
  assertLocalConnector(connector);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new RangeError("CSV inspection input must be an object");
  const request = input as Record<string, unknown>;
  const unknown = Object.keys(request).find((field) => !INSPECTION_FIELDS.has(field));
  if (unknown) throw new RangeError(`CSV inspection input contains unknown field: ${unknown}`);
  const relativePath = normalizeLocalSourceRelativePath(request.relativePath, "relativePath", { csvOnly: true });
  const file = await resolvedInspectionFile(connector, roots, relativePath);
  const columns = await readCsvHeader(file.fileSystemPath);
  return { relativePath, sizeBytes: file.sizeBytes, columns, suggestions: columnSuggestions(columns) };
}
