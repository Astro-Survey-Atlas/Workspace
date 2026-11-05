import { createHash } from "node:crypto";
import { stat, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import path from "node:path";

import { parse } from "csv-parse";

import type { ConnectorCredentialStore } from "./connector-credentials.js";
import type { ConnectorRecord, ConnectorRegistry } from "./connectors.js";
import { openConnectorObjectStream } from "./connectors.js";
import type { DataAssetRecord, DataCatalogRegistry, DataAssetCsvScanSpec } from "./data-catalog.js";
import { LocalConnectorRootsPolicy } from "./local-connector-roots.js";
import { angularDistanceArcsec, type WorkflowCatalogColumn, type WorkflowCatalogFormat, type WorkflowCatalogSourceInput, type WorkflowCatalogSide } from "./scientific-tools.js";
import { connectorScanPath } from "./scan-contract.js";

const MAX_SOURCE_BYTES = 256 * 1024 * 1024;
const MAX_CSV_ROWS = 5_000_000;
const MAX_FITS_OUTPUT_BYTES = 2 * 1024 * 1024;
const FITS_TIMEOUT_MS = 120_000;

type ColumnMap = Partial<Record<WorkflowCatalogColumn, string>>;

export interface WorkflowInputCatalog {
  catalog: WorkflowCatalogSide;
  format: WorkflowCatalogFormat;
  assetId: string;
  sourceSha256: string;
  sourceBytes: number;
  rowsScanned: number;
  hits: Array<Record<string, unknown>>;
}

interface WorkflowInputCatalogOptions {
  assets: DataCatalogRegistry;
  connectors: ConnectorRegistry;
  credentials: ConnectorCredentialStore;
  localRoots: LocalConnectorRootsPolicy;
  fitsScriptPath?: string;
}

const COLUMN_ALIASES: Record<"ra" | "dec" | "id" | "magnitude" | "classLabel", readonly string[]> = {
  ra: ["rightascension", "rightascensiondeg", "ra", "radeg", "raj2000", "alphaj2000", "alpha", "raicrs", "raicrsdeg", "ra2000"],
  dec: ["declination", "declinationdeg", "dec", "decdeg", "dej2000", "deltaj2000", "delta", "decicrs", "decicrsdeg", "dec2000"],
  id: ["objectid", "sourceid", "objid", "targetid", "id", "number", "catalogid"],
  magnitude: ["magvis", "magauto", "magnitude", "mag", "magr", "rmag", "photgmeanmag"],
  classLabel: ["extendedflag", "classification", "class", "objtype", "type"],
};

interface WorkflowCatalogSourceHints {
  tileIndex?: string;
  brickname?: string;
}

const OPTIONAL_COLUMN_ALIASES: Partial<Record<Exclude<WorkflowCatalogColumn, "ra" | "dec" | "id" | "magnitude" | "classLabel">, readonly string[]>> = {
  tileIndex: ["tileindex", "tileid", "tile_id"],
  brickname: ["brickname"],
  fitsPath: ["fitspath", "imagepath", "catalogpath"],
  imageG: ["imagegpath", "gimagepath"],
  imageR: ["imagerpath", "rimagepath"],
  imageI: ["imageipath", "iimagepath"],
  imageZ: ["imagezpath", "zimagepath"],
};

function normalizedColumn(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function numeric(value: unknown): number | undefined {
  if (typeof value === "string" && !value.trim()) return undefined;
  const result = typeof value === "number" ? value : Number(value);
  return Number.isFinite(result) ? result : undefined;
}

function sourceFormat(value: string | undefined, uri: string): WorkflowCatalogFormat {
  const extension = path.extname(uri).toLowerCase();
  const byExtension = extension === ".csv" ? "csv" : [".fits", ".fit", ".fts"].includes(extension) ? "fits" : undefined;
  const declared = value?.trim().toLowerCase();
  const byDeclaration = declared === "csv" || declared?.includes("csv")
    ? "csv"
    : declared === "fits" || declared === "fit" || declared === "fts" || declared?.includes("fits")
      ? "fits"
      : undefined;
  if (byExtension && byDeclaration && byExtension !== byDeclaration) throw new RangeError("Catalog file format does not match its registered format");
  const result = byExtension ?? byDeclaration;
  if (!result) throw new RangeError("Catalog source must be a CSV or FITS table");
  return result;
}

function mergeColumnMaps(source: WorkflowCatalogSourceInput, asset: DataAssetRecord): ColumnMap {
  const scan = asset.scanSpec?.format === "csv" ? asset.scanSpec as DataAssetCsvScanSpec : undefined;
  return {
    ...(scan ? { id: scan.objectIdColumn, ra: scan.raColumn, dec: scan.decColumn } : {}),
    ...(source.columns ?? {}),
  };
}

function resolveColumnMap(columns: readonly string[], requested: ColumnMap): ColumnMap {
  const exactColumns = new Set(columns);
  const normalized = new Map<string, string[]>();
  for (const column of columns) {
    const key = normalizedColumn(column);
    const entries = normalized.get(key) ?? [];
    entries.push(column);
    normalized.set(key, entries);
  }
  const resolved: ColumnMap = {};
  for (const field of ["ra", "dec", "id", "magnitude", "classLabel"] as const) {
    const explicit = requested[field];
    if (explicit) {
      if (!exactColumns.has(explicit)) throw new RangeError("A configured catalog column was not found");
      resolved[field] = explicit;
      continue;
    }
    for (const alias of COLUMN_ALIASES[field]) {
      const matches = normalized.get(alias);
      if (matches?.length === 1) {
        resolved[field] = matches[0]!;
        break;
      }
      if (matches && matches.length > 1) throw new RangeError("Catalog columns are ambiguous; provide an explicit column map");
    }
  }
  for (const field of ["tileIndex", "brickname", "fitsPath", "imageG", "imageR", "imageI", "imageZ"] as const) {
    const explicit = requested[field];
    if (explicit) {
      if (!exactColumns.has(explicit)) throw new RangeError("A configured catalog column was not found");
      resolved[field] = explicit;
      continue;
    }
    for (const alias of OPTIONAL_COLUMN_ALIASES[field] ?? []) {
      const matches = normalized.get(alias);
      if (matches?.length === 1) {
        resolved[field] = matches[0];
        break;
      }
      if (matches && matches.length > 1) throw new RangeError("Catalog columns are ambiguous; provide an explicit column map");
    }
  }
  if (!resolved.ra || !resolved.dec) throw new RangeError("Catalog requires recognizable RA and Dec columns or an explicit column map");
  return resolved;
}

function sourceHints(side: WorkflowCatalogSide, uri: string): WorkflowCatalogSourceHints {
  let filename = "";
  if (uri.startsWith("s3://")) filename = fileNameFromS3Uri(uri);
  else if (uri.startsWith("file://")) {
    try { filename = path.basename(fileURLToPath(uri)); } catch { throw new RangeError("Catalog source URI is invalid"); }
  } else if (uri.startsWith("local://")) {
    try { filename = path.basename(decodeURIComponent(uri.slice("local://".length))); } catch { throw new RangeError("Catalog source URI is invalid"); }
  } else filename = path.basename(uri.split(/[?#]/, 1)[0] ?? "");

  const tileIndex = side === "euclid" ? filename.match(/TILE(\d{6,12})/i)?.[1] : undefined;
  const brickname = side === "desi" ? filename.match(/(\d{4}[pm]\d{3})(?=$|[._-])/i)?.[1]?.toLowerCase() : undefined;
  return {
    ...(tileIndex ? { tileIndex } : {}),
    ...(brickname ? { brickname } : {}),
  };
}

function canonicalHit(
  row: Record<string, unknown>,
  columns: ColumnMap,
  side: WorkflowCatalogSide,
  rowNumber: number,
  sourceSha256: string,
  extraColumns: Record<string, string>,
  hints: WorkflowCatalogSourceHints,
): Record<string, unknown> {
  const value = (key: WorkflowCatalogColumn): unknown => columns[key] ? row[columns[key]!] : undefined;
  const magnitude = numeric(value("magnitude"));
  const imagePaths = Object.fromEntries(([["g", "imageG"], ["r", "imageR"], ["i", "imageI"], ["z", "imageZ"]] as const)
    .map(([band, key]) => [band, value(key)]).filter((entry) => typeof entry[1] === "string" && entry[1].trim())) as Record<string, string>;
  const objectId = value("id");
  const sourceId = objectId === undefined || objectId === null || String(objectId).trim() === ""
    ? `row_${sourceSha256.slice(0, 12)}_${rowNumber}`
    : String(objectId).trim();
  const hasSourceId = objectId !== undefined && objectId !== null && String(objectId).trim() !== "";
  const rawTileIndex = value("tileIndex");
  const rawBrickname = value("brickname");
  const tileIndex = rawTileIndex === undefined || rawTileIndex === null || !String(rawTileIndex).trim() ? hints.tileIndex : rawTileIndex;
  const brickname = rawBrickname === undefined || rawBrickname === null || !String(rawBrickname).trim() ? hints.brickname : rawBrickname;
  const id = side === "desi" && brickname
    ? `${String(brickname).trim().toLowerCase()}:${sourceId}${hasSourceId ? `:${rowNumber}` : ""}`
    : sourceId;
  return {
    ...(side === "euclid" ? { OBJECT_ID: id } : { TARGETID: id }),
    ...(side === "euclid" ? { RIGHT_ASCENSION: value("ra"), DECLINATION: value("dec") } : { ra: value("ra"), dec: value("dec") }),
    ...(magnitude === undefined ? {} : { MAG_AUTO: magnitude }),
    ...(value("classLabel") === undefined ? {} : { type: value("classLabel") }),
    ...(tileIndex === undefined ? {} : { TILE_INDEX: tileIndex }),
    ...(brickname === undefined ? {} : { BRICKNAME: brickname }),
    ...(value("fitsPath") === undefined ? {} : { fits_path: value("fitsPath") }),
    ...(Object.keys(imagePaths).length ? Object.fromEntries(Object.entries(imagePaths).map(([band, imagePath]) => [`image_${band}_path`, imagePath])) : {}),
    ...(Object.keys(extraColumns).length ? {
      asa_catalog_fields: Object.fromEntries(Object.entries(extraColumns).flatMap(([alias, column]) => {
        const fieldValue = row[column];
        return fieldValue === undefined || fieldValue === null || fieldValue === "" ? [] : [[alias, fieldValue]];
      })),
    } : {}),
  };
}

function resolveExtraColumns(columns: readonly string[], requested: Record<string, string> | undefined): Record<string, string> {
  if (!requested) return {};
  const exact = new Set(columns);
  const entries = Object.entries(requested);
  if (entries.length > 16) throw new RangeError("At most 16 additional catalog fields can be selected per side");
  const resolved: Record<string, string> = {};
  for (const [alias, column] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(alias)) throw new RangeError("Catalog field aliases must be simple field names");
    if (!exact.has(column)) throw new RangeError("A configured additional catalog column was not found");
    resolved[alias] = column;
  }
  return resolved;
}

function isWithinConnectorRoot(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function localUriPath(uri: string): string | undefined {
  if (uri.startsWith("file://")) {
    try { return fileURLToPath(uri); } catch { throw new RangeError("Catalog source URI is invalid"); }
  }
  if (uri.startsWith("local://")) return decodeURIComponent(uri.slice("local://".length));
  return path.isAbsolute(uri) ? uri : undefined;
}

function fileNameFromS3Uri(uri: string): string {
  let parsed: URL;
  try { parsed = new URL(uri); } catch { throw new RangeError("Catalog source URI is invalid"); }
  if (parsed.protocol !== "s3:" || parsed.search || parsed.hash) throw new RangeError("Catalog source URI must identify one S3 object");
  return decodeURIComponent(parsed.pathname.split("/").filter(Boolean).at(-1) ?? "");
}

export class WorkflowInputCatalogReader {
  readonly #assets: DataCatalogRegistry;
  readonly #connectors: ConnectorRegistry;
  readonly #credentials: ConnectorCredentialStore;
  readonly #localRoots: LocalConnectorRootsPolicy;
  readonly #fitsScriptPath: string;

  constructor(options: WorkflowInputCatalogOptions) {
    this.#assets = options.assets;
    this.#connectors = options.connectors;
    this.#credentials = options.credentials;
    this.#localRoots = options.localRoots;
    this.#fitsScriptPath = options.fitsScriptPath ?? fileURLToPath(new URL("./workflow-catalog-fits.py", import.meta.url));
  }

  async load(
    input: WorkflowCatalogSourceInput,
    center: { raDeg: number; decDeg: number; radiusArcsec: number; limit: number },
    extraColumns?: Record<string, string>,
  ): Promise<WorkflowInputCatalog> {
    const asset = await this.#assets.get(input.assetId);
    if (asset.kind !== "catalog") throw new RangeError("Workflow input asset must be a catalog");
    const accesses = asset.accesses?.length ? asset.accesses : [asset.access];
    if (input.accessIndex !== undefined && input.accessIndex >= accesses.length) throw new RangeError("catalogSource.accessIndex is outside the asset access list");
    const access = input.accessIndex === undefined
      ? accesses.find((candidate) => candidate.connector === "local" || candidate.connector === "s3")
      : accesses[input.accessIndex];
    if (!access || (access.connector !== "local" && access.connector !== "s3")) throw new RangeError("Catalog asset must use a Workspace local or S3 Connector");

    const connector = await this.#resolveConnector(asset, access);
    const source = await this.#readSource(asset, access, connector, input.format);
    const format = sourceFormat(input.format ?? access.format, source.uri);
    const sourceSha256 = createHash("sha256").update(source.bytes).digest("hex");
    const requestedColumns = mergeColumnMaps(input, asset);
    const hints = sourceHints(input.side, source.uri);
    const hits = format === "csv"
      ? await this.#readCsv(source.bytes, requestedColumns, input.side, sourceSha256, center, extraColumns, hints)
      : await this.#readFits(source.bytes, requestedColumns, input.tableHdu, input.side, sourceSha256, center, extraColumns, hints);
    return { catalog: input.side, format, assetId: asset.id, sourceSha256, sourceBytes: source.bytes.byteLength, rowsScanned: hits.rowsScanned, hits: hits.rows };
  }

  async #resolveConnector(asset: DataAssetRecord, access: DataAssetRecord["access"]): Promise<ConnectorRecord> {
    const connectors = await this.#connectors.list();
    let connector: ConnectorRecord | undefined;
    const id = access.connectorId ?? asset.connectorIds?.find((candidate) => connectors.some((item) => item.id === candidate && item.kind === access.connector));
    if (id) connector = connectors.find((candidate) => candidate.id === id);
    else {
      const associated = connectors.filter((candidate) => candidate.kind === access.connector
        && (asset.connectorLocationKeys?.includes(candidate.locationKey) || candidate.displayPath === access.uri));
      if (associated.length === 1) connector = associated[0];
    }
    if (!connector || connector.kind !== access.connector) throw new RangeError("Catalog asset is not linked to a compatible Workspace Connector");
    if (connector.status !== "ready") throw new RangeError("Catalog Connector must be ready before Workflow execution");
    return connector;
  }

  async #readSource(
    asset: DataAssetRecord,
    access: DataAssetRecord["access"],
    connector: ConnectorRecord,
    formatOverride?: WorkflowCatalogFormat,
  ): Promise<{ bytes: Buffer; uri: string }> {
    if (connector.kind === "local") {
      const root = connector.config.rootPath ?? "";
      const uriPath = localUriPath(access.uri);
      const relative = asset.sourceRelativePath;
      let target: string;
      if (relative) target = path.resolve(root, ...relative.split("/"));
      else if (uriPath) target = uriPath;
      else throw new RangeError("Catalog asset must select one CSV or FITS file");
      sourceFormat(formatOverride ?? access.format, target);
      if (!isWithinConnectorRoot(target, root)) throw new RangeError("Catalog file must stay inside its registered Connector root");
      const resolvedRoot = await this.#localRoots.resolveReadableDirectory(root);
      const resolved = await this.#localRoots.resolveReadableFile(target);
      if (!isWithinConnectorRoot(resolved.fileSystemPath, resolvedRoot.fileSystemPath)) {
        throw new RangeError("Catalog file must stay inside its registered Connector root");
      }
      const details = await stat(resolved.fileSystemPath);
      if (details.size > MAX_SOURCE_BYTES) throw new RangeError("Catalog source exceeds the 256 MiB processing limit");
      return { bytes: await readFile(resolved.fileSystemPath), uri: target };
    }

    const requested = asset.sourceRelativePath ?? access.uri;
    const uri = connectorScanPath(connector, requested);
    const name = fileNameFromS3Uri(uri);
    sourceFormat(formatOverride ?? access.format, uri);
    if (!name) {
      throw new RangeError("Catalog asset must select one CSV or FITS object");
    }
    if (!connector.credentialRef) throw new RangeError("S3 Connector has no saved credentials");
    const credentials = await this.#credentials.get(connector.credentialRef);
    if (!credentials?.accessKeyId || !credentials.secretAccessKey) throw new RangeError("S3 Connector credentials are unavailable");
    const effectiveConnector: ConnectorRecord = {
      ...connector,
      config: { ...connector.config, endpoint: connector.config.endpoint || credentials.endpoint },
    };
    const objectKey = decodeURIComponent(new URL(uri).pathname.replace(/^\/+/, ""));
    const { stream } = await openConnectorObjectStream(effectiveConnector, credentials, objectKey);
    const chunks: Buffer[] = [];
    let byteLength = 0;
    try {
      for await (const value of stream) {
        const chunk = Buffer.from(value as Uint8Array);
        byteLength += chunk.length;
        if (byteLength > MAX_SOURCE_BYTES) {
          stream.destroy();
          throw new RangeError("Catalog source exceeds the 256 MiB processing limit");
        }
        chunks.push(chunk);
      }
    } finally {
      stream.destroy();
    }
    return { bytes: Buffer.concat(chunks), uri };
  }

  async #readCsv(
    bytes: Buffer,
    requestedColumns: ColumnMap,
    side: WorkflowCatalogSide,
    sourceSha256: string,
    center: { raDeg: number; decDeg: number; radiusArcsec: number; limit: number },
    requestedExtraColumns?: Record<string, string>,
    hints: WorkflowCatalogSourceHints = {},
  ): Promise<{ rows: Array<Record<string, unknown>>; rowsScanned: number }> {
    const parser = Readable.from([bytes]).pipe(parse({ bom: true, columns: true, skip_empty_lines: true, max_record_size: 1_048_576 }));
    const rows: Array<Record<string, unknown>> = [];
    let mapping: ColumnMap | undefined;
    let extraColumns: Record<string, string> | undefined;
    let rowsScanned = 0;
    try {
      for await (const value of parser) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const row = value as Record<string, unknown>;
        mapping ??= resolveColumnMap(Object.keys(row), requestedColumns);
        extraColumns ??= resolveExtraColumns(Object.keys(row), requestedExtraColumns);
        rowsScanned += 1;
        if (rowsScanned > MAX_CSV_ROWS) throw new RangeError("Catalog source exceeds the 5 million row processing limit");
        const ra = numeric(row[mapping.ra!]);
        const dec = numeric(row[mapping.dec!]);
        if (ra === undefined || dec === undefined || dec < -90 || dec > 90
          || angularDistanceArcsec(center.raDeg, center.decDeg, ra, dec) > center.radiusArcsec) continue;
        rows.push(canonicalHit(row, mapping, side, rowsScanned, sourceSha256, extraColumns, hints));
        if (rows.length >= center.limit) break;
      }
    } catch (error) {
      if (error instanceof RangeError) throw error;
      throw new RangeError("CSV catalog could not be parsed; check its delimiter, header, and row widths");
    } finally {
      parser.destroy();
    }
    if (!mapping) throw new RangeError("CSV catalog has no data rows");
    return { rows, rowsScanned };
  }

  async #readFits(
    bytes: Buffer,
    requestedColumns: ColumnMap,
    tableHdu: number | string | undefined,
    side: WorkflowCatalogSide,
    sourceSha256: string,
    center: { raDeg: number; decDeg: number; radiusArcsec: number; limit: number },
    extraColumns?: Record<string, string>,
    hints: WorkflowCatalogSourceHints = {},
  ): Promise<{ rows: Array<Record<string, unknown>>; rowsScanned: number }> {
    const result = await runFitsReader(this.#fitsScriptPath, bytes, {
      columns: requestedColumns,
      tableHdu,
      side,
      sourceKey: sourceSha256.slice(0, 12),
      extraColumns: extraColumns ?? {},
      sourceHints: hints,
      ...center,
    });
    return result;
  }
}

interface FitsReaderConfig {
  columns: ColumnMap;
  tableHdu?: number | string;
  side: WorkflowCatalogSide;
  sourceKey: string;
  extraColumns: Record<string, string>;
  sourceHints: WorkflowCatalogSourceHints;
  raDeg: number;
  decDeg: number;
  radiusArcsec: number;
  limit: number;
}

async function runFitsReader(
  scriptPath: string,
  bytes: Buffer,
  config: FitsReaderConfig,
): Promise<{ rows: Array<Record<string, unknown>>; rowsScanned: number }> {
  const child = spawn(process.env.PYTHON_EXECUTABLE ?? "python3", [scriptPath], { stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  let outputTooLarge = false;
  let timedOut = false;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    output += chunk;
    if (Buffer.byteLength(output) > MAX_FITS_OUTPUT_BYTES) {
      outputTooLarge = true;
      child.kill("SIGTERM");
    }
  });
  child.stderr.resume();
  child.stdin.on("error", () => undefined);
  const completion = new Promise<{ code: number | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve({ code }));
  });
  const timeout = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, FITS_TIMEOUT_MS);
  child.stdin.write(`${JSON.stringify(config)}\n`);
  child.stdin.end(bytes);
  try {
    const { code } = await completion;
    if (timedOut) {
      const error = new Error("FITS table processing timed out");
      error.name = "TimeoutError";
      throw error;
    }
    if (outputTooLarge) throw new Error("FITS table selection exceeded the output limit");
    if (code !== 0) throw new Error("FITS catalog could not be decoded; select a table HDU and verify its column mapping");
    const result = JSON.parse(output) as { rows?: unknown; rowsScanned?: unknown };
    if (!Array.isArray(result.rows) || typeof result.rowsScanned !== "number") throw new Error("FITS catalog reader returned an invalid result");
    return { rows: result.rows as Array<Record<string, unknown>>, rowsScanned: result.rowsScanned };
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
}
