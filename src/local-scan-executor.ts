import { createHash } from "node:crypto";
import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { ASTRO_OBJECT_INDEX, type AstroObjectIndexService } from "./astro-object-index.js";
import type { ConnectorIngestRunCatalog, ConnectorIngestRunRecord } from "./connector-history.js";
import { hasCurrentSuccessfulConnectorCheck, type ConnectorRecord, type ConnectorRegistry } from "./connectors.js";
import type { DataAssetRecord, DataCatalogRegistry } from "./data-catalog.js";
import type { LocalConnectorRootsPolicy } from "./local-connector-roots.js";
import { scanLocalCsv, type LocalCsvScanLimits, type LocalScanDocument } from "./local-scan.js";

export const LOCAL_CSV_SCAN_EXECUTOR = "local-csv";

const MAX_BULK_DOCUMENTS = 500;
const MAX_BULK_BYTES = 2 * 1024 * 1024;
const REQUEST_FIELDS = new Set(["relativePath", "maxRows"]);

export function localScanEnabled(value = process.env.ASTRO_LOCAL_SCAN_ENABLED): boolean {
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new RangeError("ASTRO_LOCAL_SCAN_ENABLED must be true or false");
}

export interface LocalCsvScanInput {
  relativePath?: string;
  maxRows?: number;
}

export type LocalCsvScanIndexService = Pick<AstroObjectIndexService, "configured" | "ensureIndices" | "bulk">;

export interface LocalCsvScanExecutorOptions {
  enabled: boolean;
  connectors: ConnectorRegistry;
  dataCatalog: DataCatalogRegistry;
  runs: ConnectorIngestRunCatalog;
  roots: LocalConnectorRootsPolicy;
  indexService: LocalCsvScanIndexService;
  maxRows?: number;
  maxFileBytes?: number;
}

export class LocalScanDisabledError extends Error {
  readonly statusCode = 503;

  constructor(message = "Local CSV scanning is disabled") {
    super(message);
    this.name = "LocalScanDisabledError";
  }
}

export class LocalScanCapabilityError extends Error {
  readonly statusCode = 422;

  constructor(kind: ConnectorRecord["kind"]) {
    super(`Local CSV scanning is not supported for ${kind} connectors`);
    this.name = "LocalScanCapabilityError";
  }
}

export class LocalScanPreconditionError extends Error {
  readonly statusCode = 409;

  constructor(message: string) {
    super(message);
    this.name = "LocalScanPreconditionError";
  }
}

interface NormalizedInput {
  relativePath?: string;
  maxRows?: number;
}

interface ResolvedCsvFile {
  containerPath: string;
  size: number;
  mtimeMs: number;
}

interface PreparedLocalScan {
  run: ConnectorIngestRunRecord;
  file: ResolvedCsvFile;
  asset: DataAssetRecord;
  surveyId: string;
  releaseId: string;
  product: string;
  modality: string;
  maxRows?: number;
}

function optionalLimit(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function normalizeInput(input: LocalCsvScanInput | undefined): NormalizedInput {
  if (input === undefined) return {};
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new RangeError("Local CSV scan input must be an object");
  }
  const unknown = Object.keys(input).find((field) => !REQUEST_FIELDS.has(field));
  if (unknown) throw new RangeError(`Local CSV scan input contains unknown field: ${unknown}`);

  let relativePath: string | undefined;
  if (input.relativePath !== undefined) {
    if (typeof input.relativePath !== "string" || !input.relativePath.trim()) {
      throw new RangeError("relativePath must be a non-empty string");
    }
    relativePath = input.relativePath.trim();
    if (relativePath.length > 2048) throw new RangeError("relativePath must contain at most 2048 characters");
    if (path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) {
      throw new RangeError("relativePath must be relative to the connector root");
    }
    if (relativePath.includes("\0")) throw new RangeError("relativePath contains an invalid null byte");
    if (relativePath.split(/[\\/]/).some((segment) => segment === "." || segment === "..")) {
      throw new RangeError("relativePath cannot contain dot segments");
    }
    if (!relativePath.toLowerCase().endsWith(".csv")) {
      throw new RangeError("relativePath must identify a CSV file");
    }
  }

  return {
    ...(relativePath === undefined ? {} : { relativePath }),
    ...(input.maxRows === undefined ? {} : { maxRows: optionalLimit(input.maxRows, "maxRows") }),
  };
}

function isWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === ""
    || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function requiredAssetText(value: unknown, name: string): string {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result) throw new LocalScanPreconditionError(`The linked data asset must define ${name}`);
  return result;
}

function linkedToConnector(asset: DataAssetRecord, connector: ConnectorRecord): boolean {
  return (asset.connectorIds ?? []).includes(connector.id)
    || (asset.connectorLocationKeys ?? []).includes(connector.locationKey);
}

function errorMessage(error: unknown): string {
  try {
    return (error instanceof Error ? error.message : String(error)).slice(0, 2000) || "Local CSV scan failed";
  } catch {
    return "Local CSV scan failed";
  }
}

function failedRun(run: ConnectorIngestRunRecord, error: unknown, completedAt = new Date().toISOString()): ConnectorIngestRunRecord {
  return {
    ...run,
    status: "failed",
    error: errorMessage(error),
    completedAt,
    updatedAt: completedAt,
  };
}

function bulkDocumentBytes(document: LocalScanDocument): number {
  const { _index: _ignoredIndex, _id: _ignoredId, ...source } = document;
  const action = JSON.stringify({ index: { _index: document._index, _id: document._id } });
  return Buffer.byteLength(action, "utf8") + Buffer.byteLength(JSON.stringify(source), "utf8") + 2;
}

/** Stable source identity based only on the public container path and file metadata. */
export function stableLocalSourceFileId(containerPath: string, size: number, mtimeMs: number): string {
  return createHash("sha256").update(JSON.stringify([containerPath, size, mtimeMs])).digest("hex");
}

export class LocalCsvScanExecutor {
  readonly #enabled: boolean;
  readonly #connectors: ConnectorRegistry;
  readonly #dataCatalog: DataCatalogRegistry;
  readonly #runs: ConnectorIngestRunCatalog;
  readonly #roots: LocalConnectorRootsPolicy;
  readonly #indexService: LocalCsvScanIndexService;
  readonly #maxRows?: number;
  readonly #maxFileBytes?: number;
  readonly #tasks = new Map<string, Promise<ConnectorIngestRunRecord>>();

  constructor(options: LocalCsvScanExecutorOptions) {
    if (!options || typeof options !== "object") throw new TypeError("LocalCsvScanExecutor options are required");
    if (typeof options.enabled !== "boolean") throw new TypeError("enabled must be a boolean");
    this.#enabled = options.enabled;
    this.#connectors = options.connectors;
    this.#dataCatalog = options.dataCatalog;
    this.#runs = options.runs;
    this.#roots = options.roots;
    this.#indexService = options.indexService;
    this.#maxRows = optionalLimit(options.maxRows, "maxRows");
    this.#maxFileBytes = optionalLimit(options.maxFileBytes, "maxFileBytes");
  }

  async submit(connectorId: string, input?: LocalCsvScanInput, idempotencyKey?: string): Promise<ConnectorIngestRunRecord> {
    if (!this.#enabled) throw new LocalScanDisabledError();
    const request = normalizeInput(input);
    const connector = await this.#connectors.get(connectorId);
    this.#assertConnectorReady(connector);
    const asset = await this.#linkedAsset(connector);
    return this.#submitPrepared(connector, asset, request, idempotencyKey);
  }

  async submitAsset(assetId: string, input?: LocalCsvScanInput, idempotencyKey?: string): Promise<ConnectorIngestRunRecord> {
    if (!this.#enabled) throw new LocalScanDisabledError();
    if (typeof assetId !== "string" || !assetId.trim()) throw new RangeError("asset id is required");
    const request = normalizeInput(input);
    const asset = await this.#dataCatalog.get(assetId.trim());
    if (asset.origin !== "user") throw new LocalScanPreconditionError("Only user data assets can be locally scanned");
    const linked = (await this.#connectors.list()).filter((connector) => linkedToConnector(asset, connector));
    if (linked.length !== 1) {
      throw new LocalScanPreconditionError(`Asset-level local scanning requires exactly one linked Connector; found ${linked.length}`);
    }
    return this.#submitPrepared(linked[0]!, asset, request, idempotencyKey);
  }

  async #submitPrepared(
    connector: ConnectorRecord,
    asset: DataAssetRecord,
    request: NormalizedInput,
    idempotencyKey?: string,
  ): Promise<ConnectorIngestRunRecord> {
    this.#assertConnectorReady(connector);

    if (idempotencyKey !== undefined) {
      const existing = await this.#runs.findIdempotent(connector.id, idempotencyKey);
      if (existing) return existing;
    }

    const scanSpec = asset.scanSpec;
    if (!scanSpec || scanSpec.format !== "csv") {
      throw new LocalScanPreconditionError("The linked data asset must define a CSV scanSpec");
    }
    const surveyId = requiredAssetText(asset.surveyId, "surveyId");
    const releaseId = requiredAssetText(asset.releaseId, "releaseId");
    const product = requiredAssetText(scanSpec.product ?? asset.product, "product");
    const modality = scanSpec.modality?.trim() || asset.modalities[0]?.trim() || "catalog";
    const file = await this.#resolveCsvFile(connector, request.relativePath);
    const effectiveMaxRows = request.maxRows === undefined
      ? this.#maxRows
      : this.#maxRows === undefined ? request.maxRows : Math.min(request.maxRows, this.#maxRows);

    const created = await this.#runs.create(connector.locationKey, {
      connectorId: connector.id,
      connectorName: connector.name,
      connectorKind: connector.kind,
      executor: LOCAL_CSV_SCAN_EXECUTOR,
      target: { uri: file.containerPath },
      assetIds: [asset.id],
      assetId: asset.id,
      assetName: asset.name,
      status: "queued",
      fileCount: 1,
      sourcePath: file.containerPath,
      esIndex: ASTRO_OBJECT_INDEX,
    }, idempotencyKey);
    if (!created.created) return created.run;

    this.#schedule({
      run: created.run,
      file,
      asset,
      surveyId,
      releaseId,
      product,
      modality,
      maxRows: effectiveMaxRows,
    });
    return created.run;
  }

  #assertConnectorReady(connector: ConnectorRecord): void {
    if (connector.status === "disabled") {
      throw new LocalScanPreconditionError("Disabled connectors cannot be scanned");
    }
    if (connector.kind !== "local") throw new LocalScanCapabilityError(connector.kind);
    if (!hasCurrentSuccessfulConnectorCheck(connector)) {
      throw new LocalScanPreconditionError("Connector must have a current successful connection check for its current configuration before scanning");
    }
    if (!this.#indexService.configured) {
      throw new LocalScanPreconditionError("Elasticsearch is not configured for local CSV scanning");
    }
  }

  async awaitCompletion(runId: string): Promise<ConnectorIngestRunRecord> {
    const task = this.#tasks.get(runId);
    if (task) return task;
    const run = (await this.#runs.list()).find((candidate) => candidate.id === runId);
    if (!run) throw new Error(`Connector ingest run not found: ${runId}`);
    return run;
  }

  async wait(runId: string): Promise<ConnectorIngestRunRecord> {
    return this.awaitCompletion(runId);
  }

  async runNow(runId: string): Promise<ConnectorIngestRunRecord> {
    return this.awaitCompletion(runId);
  }

  async #linkedAsset(connector: ConnectorRecord): Promise<DataAssetRecord> {
    const assets = (await this.#dataCatalog.list())
      .filter((asset) => asset.origin === "user" && linkedToConnector(asset, connector));
    if (assets.length !== 1) {
      throw new LocalScanPreconditionError(`Local CSV scanning requires exactly one linked user data asset; found ${assets.length}`);
    }
    return assets[0]!;
  }

  async #resolveCsvFile(connector: ConnectorRecord, requestedPath?: string): Promise<ResolvedCsvFile> {
    const rootPath = path.normalize(connector.config.rootPath ?? "");
    const rootCheck = await this.#roots.checkDirectory(rootPath);
    if (!rootCheck.ok) {
      throw new LocalScanPreconditionError(`Connector root is not currently readable (${rootCheck.failure ?? "unavailable"})`);
    }

    let relativePath = requestedPath;
    if (relativePath === undefined) {
      let entries;
      try {
        entries = await readdir(rootPath, { withFileTypes: true });
      } catch {
        throw new LocalScanPreconditionError("Connector root could not be enumerated");
      }
      const candidates = entries
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".csv"))
        .map((entry) => entry.name)
        .sort();
      if (candidates.length !== 1) {
        throw new LocalScanPreconditionError(`Local CSV scanning requires exactly one top-level CSV file when relativePath is omitted; found ${candidates.length}`);
      }
      relativePath = candidates[0]!;
    }

    const containerPath = path.resolve(rootPath, relativePath);
    if (!isWithinRoot(containerPath, rootPath)) {
      throw new RangeError("relativePath must stay inside the connector root");
    }
    const fileCheck = await this.#roots.checkFile(containerPath);
    if (!fileCheck.ok) {
      throw new LocalScanPreconditionError(`CSV source is not a readable regular file (${fileCheck.failure ?? "unavailable"})`);
    }

    try {
      const [canonicalRoot, canonicalFile] = await Promise.all([realpath(rootPath), realpath(containerPath)]);
      if (!isWithinRoot(canonicalFile, canonicalRoot)) {
        throw new LocalScanPreconditionError("CSV source resolves outside the connector root");
      }
      const details = await stat(containerPath);
      if (!details.isFile()) throw new LocalScanPreconditionError("CSV source is not a regular file");
      return { containerPath, size: details.size, mtimeMs: details.mtimeMs };
    } catch (error) {
      if (error instanceof LocalScanPreconditionError) throw error;
      throw new LocalScanPreconditionError("CSV source could not be resolved or inspected");
    }
  }

  #schedule(scan: PreparedLocalScan): void {
    const task = Promise.resolve()
      .then(() => this.#execute(scan))
      .catch((error) => failedRun(scan.run, error));
    this.#tasks.set(scan.run.id, task);
    void task.then(() => {
      if (this.#tasks.get(scan.run.id) === task) this.#tasks.delete(scan.run.id);
    });
  }

  async #execute(scan: PreparedLocalScan): Promise<ConnectorIngestRunRecord> {
    try {
      await this.#runs.update(scan.run.id, { status: "running" });
      const limits: LocalCsvScanLimits = {
        ...(scan.maxRows === undefined ? {} : { maxRows: scan.maxRows }),
        ...(this.#maxFileBytes === undefined ? {} : { maxFileBytes: this.#maxFileBytes }),
      };
      const scanOptions = {
        objectIdColumn: scan.asset.scanSpec!.objectIdColumn,
        raColumn: scan.asset.scanSpec!.raColumn,
        decColumn: scan.asset.scanSpec!.decColumn,
        surveyId: scan.surveyId,
        releaseId: scan.releaseId,
        product: scan.product,
        modality: scan.modality,
        assetId: scan.asset.id,
        sourceFileId: stableLocalSourceFileId(scan.file.containerPath, scan.file.size, scan.file.mtimeMs),
        scanRunId: scan.run.id,
        objectIndex: ASTRO_OBJECT_INDEX,
        limits,
        collectObjects: false,
      } as const;

      // Validate the complete stream before the first irreversible bulk write.
      // This keeps configured row/file limits from leaving partial index data.
      const validated = await scanLocalCsv(scan.file.containerPath, scanOptions);
      const currentFile = await stat(scan.file.containerPath);
      if (currentFile.size !== scan.file.size || currentFile.mtimeMs !== scan.file.mtimeMs) {
        throw new LocalScanPreconditionError("CSV source changed after validation; run the scan again");
      }
      await this.#indexService.ensureIndices();
      let documents: LocalScanDocument[] = [];
      let bufferedBytes = 0;

      const flush = async (): Promise<void> => {
        if (!documents.length) return;
        const batch = documents;
        documents = [];
        bufferedBytes = 0;
        await this.#indexService.bulk(batch);
      };

      const sink = async (document: LocalScanDocument): Promise<void> => {
        const documentBytes = bulkDocumentBytes(document);
        if (documents.length && (documents.length >= MAX_BULK_DOCUMENTS || bufferedBytes + documentBytes > MAX_BULK_BYTES)) {
          await flush();
        }
        if (documentBytes > MAX_BULK_BYTES) {
          await this.#indexService.bulk([document]);
          return;
        }
        documents.push(document);
        bufferedBytes += documentBytes;
        if (documents.length >= MAX_BULK_DOCUMENTS || bufferedBytes >= MAX_BULK_BYTES) await flush();
      };

      await scanLocalCsv(scan.file.containerPath, scanOptions, sink);
      await flush();

      return await this.#runs.update(scan.run.id, {
        status: "succeeded",
        fileCount: 1,
        documentCount: validated.summary.objectCount,
        completedAt: new Date().toISOString(),
      });
    } catch (error) {
      const completedAt = new Date().toISOString();
      try {
        return await this.#runs.update(scan.run.id, {
          status: "failed",
          error: errorMessage(error),
          completedAt,
        });
      } catch {
        return failedRun(scan.run, error, completedAt);
      }
    }
  }
}
