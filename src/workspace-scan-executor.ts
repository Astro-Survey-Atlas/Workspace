import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createGunzip } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";

import type { ConnectorCredentialStore } from "./connector-credentials.js";
import type { DataStatisticsModule } from "./data-statistics.js";
import { listConnectorObjects, openConnectorObjectStream, readConnectorObjectRange, hasCurrentSuccessfulConnectorCheck, type ConnectorRecord, type ConnectorRegistry } from "./connectors.js";
import { ASTRO_OBJECT_INDEX, type AstroObjectIndexService } from "./astro-object-index.js";
import { ConnectorIngestRunCatalog, type ConnectorIngestRunRecord } from "./connector-history.js";
import { normalizeLocalSourceRelativePath } from "./local-source-inspection.js";
import type { DataAssetRecord, DataCatalogRegistry } from "./data-catalog.js";
import type { LocalConnectorRootsPolicy } from "./local-connector-roots.js";
import { convertPositionHeaders, imageFootprintDocuments, pointDocument, type HeaderPoint, SKY_DATA_POINT_INDEX } from "./derived-repairs.js";
import { scanLocalCsv, type LocalScanDocument } from "./local-scan.js";
import { defaultMocCoreAdapter, type MocCoreAdapter, type MocCoreCatalogResult } from "./moc-core-adapter.js";
import type { UserMocArtifactContext, UserMocArtifactStore } from "./user-moc-artifacts.js";
import { readFitsHeaders, type FitsByteSource, type FitsHeaderRecord, FITS_RECORD_BYTES } from "./fits-headers.js";
import { productionImageSources, registerProductionImageAssets, verifyProductionImageInventory } from "./production-image-assets.js";
import type { SourceFileInventory } from "./source-crawler.js";

const WORKSPACE_SCAN_EXECUTOR = "workspace";
const MAX_INVENTORY_FILES = 1_000_000;
const MAX_MOC_HEADERS_PER_BATCH = 256;
const MAX_MOC_HEADER_BATCH_BYTES = 8 * 1024 * 1024;
const MAX_MOC_MERGE_FAN_IN = 64;
const MAX_BULK_DOCUMENTS = 500;
const MAX_BULK_BYTES = 2 * 1024 * 1024;
const SCAN_INPUT_FIELDS = new Set(["relativePath"]);

interface ScanFile {
  id: string;
  name: string;
  uri: string;
  size: number;
  localPath?: string;
  objectKey?: string;
  mtimeMs?: number;
  lastModified?: string;
  etag?: string;
}

interface FitsWcsHeader extends Record<string, unknown> {
  file_id: string;
  source_uri: string;
  file_name: string;
  hdu_index: number;
  header: string;
  primary_header: string;
  moc_header: Record<string, unknown>;
}

interface WorkspaceScanTask {
  version: 1;
  runId: string;
  connectorId: string;
  assetId: string;
  createdAt: string;
  files: ScanFile[];
  sourceSnapshotSha256: string;
  completedFileIds: string[];
  partialMocPaths: string[];
  pendingFitsHeaders: FitsWcsHeader[];
  pendingFileIds: string[];
  processedFiles: number;
  pointCount: number;
  documentCount: number;
  failedFiles: number;
  failedFileIds: string[];
  errors: Array<{ fileId: string; message: string }>;
}

export interface WorkspaceScanInput {
  relativePath?: string;
}

export function workspaceScanEnabled(value = process.env.ASTRO_WORKSPACE_SCAN_ENABLED): boolean {
  if (value === undefined || value === "true") return true;
  if (value === "false") return false;
  throw new RangeError("ASTRO_WORKSPACE_SCAN_ENABLED must be true or false");
}

interface WorkspaceScanExecutorOptions {
  enabled: boolean;
  root: string;
  connectors: ConnectorRegistry;
  credentials: ConnectorCredentialStore;
  dataCatalog: DataCatalogRegistry;
  runs: ConnectorIngestRunCatalog;
  roots: LocalConnectorRootsPolicy;
  objectIndex: AstroObjectIndexService;
  skyPoints: AstroObjectIndexService;
  artifacts: UserMocArtifactStore;
  statistics?: Pick<DataStatisticsModule, "recordScan">;
  mocCore?: MocCoreAdapter;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function workspaceLayerId(assetId: string): string {
  return `workspace-${assetId}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 180) || "workspace-asset";
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2000) || "Workspace scan failed";
}

function documentBytes(document: LocalScanDocument): number {
  const { _index: _indexValue, _id: _idValue, ...source } = document;
  return Buffer.byteLength(JSON.stringify({ index: { _index: document._index, _id: document._id } }))
    + Buffer.byteLength(JSON.stringify(source)) + 2;
}

function linkedToConnector(asset: DataAssetRecord, connector: ConnectorRecord): boolean {
  return (asset.connectorIds ?? []).includes(connector.id)
    || (asset.connectorLocationKeys ?? []).includes(connector.locationKey)
    || [asset.access, ...(asset.accesses ?? [])].some((access) => access.connectorId === connector.id || access.uri === connector.locationKey);
}

function fileMatches(asset: DataAssetRecord, fileName: string): boolean {
  const scanSpec = asset.scanSpec;
  const format = scanSpec?.format === "csv" ? "csv" : scanSpec?.format === "fits" || asset.kind === "image" || asset.kind === "cube" ? "fits" : undefined;
  if (!format) throw new RangeError("Workspace scanning supports CSV catalogs and FITS image/cube assets");
  const name = fileName.toLowerCase();
  const supported = format === "csv" ? name.endsWith(".csv") : /\.(fits?|fits\.gz)$/.test(name);
  if (!supported) return false;
  const pattern = scanSpec?.format === "fits" ? scanSpec.fileNamePattern : asset.warehouseScanSpec?.fileNamePattern;
  return !pattern || new RegExp(pattern).test(path.posix.basename(fileName));
}

function needsFits(asset: DataAssetRecord): boolean {
  return asset.scanSpec?.format === "fits" || asset.kind === "image" || asset.kind === "cube";
}

function normalizeInput(input: WorkspaceScanInput | undefined): WorkspaceScanInput {
  if (input === undefined) return {};
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new RangeError("Workspace scan input must be an object");
  const unknown = Object.keys(input).find((key) => !SCAN_INPUT_FIELDS.has(key));
  if (unknown) throw new RangeError(`Workspace scan input contains an unsupported field: ${unknown}`);
  return input.relativePath === undefined ? {} : { relativePath: normalizeLocalSourceRelativePath(input.relativePath) };
}

function sourceId(connector: ConnectorRecord, file: Omit<ScanFile, "id">): string {
  return sha256(JSON.stringify([connector.locationKey, file.objectKey ?? file.localPath, file.size, file.mtimeMs ?? null, file.lastModified ?? null, file.etag ?? null]));
}

class GzipRangeSource implements FitsByteSource {
  readonly size: number;
  readonly #iterator: AsyncIterator<Buffer>;
  #chunk = Buffer.alloc(0);
  #chunkOffset = 0;
  #position = 0;

  constructor(size: number, input: NodeJS.ReadableStream) {
    void size;
    this.size = Number.MAX_SAFE_INTEGER;
    this.#iterator = input.pipe(createGunzip())[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    if (offset < this.#position || length < 0) throw new RangeError("Compressed FITS headers must be read in source order");
    await this.#discard(offset - this.#position);
    const chunks: Buffer[] = [];
    let remaining = length;
    while (remaining > 0) {
      if (this.#chunkOffset >= this.#chunk.length) {
        const next = await this.#iterator.next();
        if (next.done) break;
        this.#chunk = Buffer.from(next.value);
        this.#chunkOffset = 0;
      }
      const count = Math.min(remaining, this.#chunk.length - this.#chunkOffset);
      chunks.push(this.#chunk.subarray(this.#chunkOffset, this.#chunkOffset + count));
      this.#chunkOffset += count;
      this.#position += count;
      remaining -= count;
    }
    return Buffer.concat(chunks);
  }

  async #discard(length: number): Promise<void> {
    let remaining = length;
    while (remaining > 0) {
      if (this.#chunkOffset >= this.#chunk.length) {
        const next = await this.#iterator.next();
        if (next.done) throw new Error("Compressed FITS source ended before the next HDU");
        this.#chunk = Buffer.from(next.value);
        this.#chunkOffset = 0;
      }
      const count = Math.min(remaining, this.#chunk.length - this.#chunkOffset);
      this.#chunkOffset += count;
      this.#position += count;
      remaining -= count;
    }
  }

  destroy(): void {
    const iterator = this.#iterator as AsyncIterator<Buffer> & { return?: () => Promise<unknown> };
    void iterator.return?.();
  }
}

export class WorkspaceScanExecutor {
  readonly #options: WorkspaceScanExecutorOptions;
  readonly #root: string;
  readonly #tasks = new Map<string, Promise<ConnectorIngestRunRecord>>();

  constructor(options: WorkspaceScanExecutorOptions) {
    this.#options = options;
    this.#root = path.resolve(options.root);
  }

  async submitAsset(assetId: string, input?: WorkspaceScanInput, connectorId?: string, idempotencyKey?: string): Promise<ConnectorIngestRunRecord> {
    if (!this.#options.enabled) throw new Error("Workspace scan execution is not enabled");
    const asset = await this.#options.dataCatalog.get(assetId);
    if (asset.origin !== "user") throw new RangeError("Only user assets can be scanned");
    const linked = (await this.#options.connectors.list()).filter((connector) => linkedToConnector(asset, connector));
    const connector = connectorId ? linked.find((entry) => entry.id === connectorId) : linked.length === 1 ? linked[0] : undefined;
    if (!connector) throw new RangeError(linked.length > 1 ? "Choose a Connector for this asset before scanning" : "Asset has no linked Connector");
    return this.#submit(connector, asset, input, idempotencyKey);
  }

  async submitConnector(connectorId: string, input?: WorkspaceScanInput & { assetId?: string }, idempotencyKey?: string): Promise<ConnectorIngestRunRecord> {
    const connector = await this.#options.connectors.get(connectorId);
    const assets = (await this.#options.dataCatalog.list()).filter((asset) => asset.origin === "user" && linkedToConnector(asset, connector));
    const asset = input?.assetId ? assets.find((candidate) => candidate.id === input.assetId) : assets.length === 1 ? assets[0] : undefined;
    if (!asset) throw new RangeError(assets.length > 1 ? "Choose a linked data asset before scanning this Connector" : "Connector has no linked user asset");
    const { assetId: _assetId, ...scanInput } = input ?? {};
    return this.#submit(connector, asset, scanInput, idempotencyKey);
  }

  async submitProductionHandoff(input: {
    runId: string;
    connectorId: string;
    inventorySha256: string;
    inventory?: SourceFileInventory;
    verifiedRelativePaths?: string[];
  }): Promise<{ accepted: boolean; scanRunIds: string[]; message?: string }> {
    if (!input.inventory || !input.verifiedRelativePaths) return { accepted: false, scanRunIds: [], message: "Production download has no immutable verified inventory" };
    verifyProductionImageInventory(input.inventory, input.inventorySha256);
    if (!productionImageSources(input.inventory, input.verifiedRelativePaths).length) {
      return { accepted: false, scanRunIds: [], message: "已校验文件中没有带有 image/imaging 身份的 FITS 图像；未创建扫描资产" };
    }
    const current = await this.#options.connectors.get(input.connectorId);
    if (current.kind !== "local" && current.kind !== "s3") throw new RangeError("Production output Connector must be local or S3/OSS");
    const connector = await this.#options.connectors.check(current.id);
    if (!hasCurrentSuccessfulConnectorCheck(connector)) throw new RangeError(connector.lastCheck?.summary ?? "下载输出 Connector 检查失败");
    const registeredAssets = await registerProductionImageAssets(connector, input.inventory, input.verifiedRelativePaths, this.#options.dataCatalog);
    const scanRunIds: string[] = [];
    for (const { asset } of registeredAssets) {
      const key = `production:${input.runId}:${asset.id}`;
      const existing = await this.#options.runs.findIdempotent(connector.id, key);
      const run = existing?.status === "failed"
        ? await this.retry(connector.id, existing.id)
        : await this.submitAsset(asset.id, { ...(asset.sourceRelativePath ? { relativePath: asset.sourceRelativePath } : {}) }, connector.id, key);
      scanRunIds.push(run.id);
    }
    return { accepted: scanRunIds.length > 0, scanRunIds };
  }

  async retry(connectorId: string, runId: string): Promise<ConnectorIngestRunRecord> {
    const task = await this.#readTask(runId);
    if (task.connectorId !== connectorId) throw new Error("Workspace scan run does not belong to this Connector");
    const run = (await this.#options.runs.list({ connectorId })).find((candidate) => candidate.id === runId);
    if (!run || run.executor !== WORKSPACE_SCAN_EXECUTOR || run.status !== "failed") throw new RangeError("Only a failed Workspace scan can be retried");
    const queued = await this.#options.runs.update(run.id, { status: "queued", completedAt: undefined, error: undefined, phase: "reading" });
    this.#schedule(task, queued);
    return queued;
  }

  async recoverInterruptedRuns(): Promise<number> {
    await mkdir(this.#root, { recursive: true });
    const entries = await readdir(this.#root, { withFileTypes: true });
    let count = 0;
    for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith(".json"))) {
      const runId = entry.name.slice(0, -5);
      const task = await this.#readTask(runId).catch(() => undefined);
      if (!task) continue;
      const run = (await this.#options.runs.list()).find((candidate) => candidate.id === runId);
      if (!run || run.executor !== WORKSPACE_SCAN_EXECUTOR || !["queued", "running"].includes(run.status)) continue;
      this.#schedule(task, run);
      count += 1;
    }
    return count;
  }

  async #submit(connector: ConnectorRecord, asset: DataAssetRecord, rawInput?: WorkspaceScanInput, idempotencyKey?: string): Promise<ConnectorIngestRunRecord> {
    const input = normalizeInput(rawInput);
    if (connector.status === "disabled") throw new RangeError("Disabled Connectors cannot be scanned");
    if (connector.kind !== "local" && connector.kind !== "s3") throw new RangeError("Workspace scans support local and S3/OSS Connectors");
    if (!hasCurrentSuccessfulConnectorCheck(connector)) throw new RangeError("Connector must pass a current connection check before scanning");
    if (!this.#options.objectIndex.configured) throw new RangeError("Workspace Elasticsearch is not configured");
    if (idempotencyKey) {
      const existing = await this.#options.runs.findIdempotent(connector.id, idempotencyKey);
      if (existing) return existing;
    }
    const credentials = connector.kind === "s3" && connector.credentialRef ? await this.#options.credentials.get(connector.credentialRef) : undefined;
    if (connector.kind === "s3" && (!credentials?.accessKeyId || !credentials.secretAccessKey)) throw new RangeError("Connector has no saved S3/OSS credentials");
    const files = await this.#inventory(connector, asset, input.relativePath, credentials);
    if (!files.length) throw new RangeError("No supported source files matched this asset and Connector");
    if (files.length > MAX_INVENTORY_FILES) throw new RangeError(`Scan inventory exceeds the ${MAX_INVENTORY_FILES} file limit`);
    const sourceSnapshotSha256 = sha256(JSON.stringify(files.map(({ id, name, size, mtimeMs, lastModified, etag }) => [id, name, size, mtimeMs ?? null, lastModified ?? null, etag ?? null])));
    const created = await this.#options.runs.create(connector.locationKey, {
      connectorId: connector.id,
      connectorName: connector.name,
      connectorKind: connector.kind,
      executor: WORKSPACE_SCAN_EXECUTOR,
      backend: "local",
      taskKind: "user_coverage",
      target: connector.kind === "local" ? { uri: `local://${connector.config.rootPath}` } : { uri: `s3://${connector.config.bucket}/${connector.config.prefix ?? ""}`, bucket: connector.config.bucket, prefix: connector.config.prefix },
      assetIds: [asset.id], assetId: asset.id, assetName: asset.name,
      status: "queued", fileCount: files.length, processedFiles: 0, failedFiles: 0, pointCount: 0,
      sourceSnapshotSha256, esIndex: this.#options.objectIndex.objectIndex,
      phase: "staging", mocStatus: "pending",
    }, idempotencyKey);
    if (!created.created) return created.run;
    const task: WorkspaceScanTask = {
      version: 1,
      runId: created.run.id,
      connectorId: connector.id,
      assetId: asset.id,
      createdAt: created.run.createdAt,
      files,
      sourceSnapshotSha256,
      completedFileIds: [],
      partialMocPaths: [],
      pendingFitsHeaders: [],
      pendingFileIds: [],
      processedFiles: 0,
      pointCount: 0,
      documentCount: 0,
      failedFiles: 0,
      failedFileIds: [],
      errors: [],
    };
    await this.#saveTask(task);
    this.#schedule(task, created.run);
    return created.run;
  }

  async #inventory(connector: ConnectorRecord, asset: DataAssetRecord, requestedPath: string | undefined, credentials: Awaited<ReturnType<ConnectorCredentialStore["get"]>>): Promise<ScanFile[]> {
    const selectedPath = requestedPath ?? asset.sourceRelativePath;
    const scanPath = selectedPath ? normalizeLocalSourceRelativePath(selectedPath) : undefined;
    const files: ScanFile[] = [];
    if (connector.kind === "local") {
      const root = path.normalize(connector.config.rootPath ?? "");
      const resolvedRoot = await this.#options.roots.resolveReadableDirectory(root);
      const target = scanPath ? path.resolve(root, ...scanPath.split("/")) : root;
      if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new RangeError("Scan path must stay inside the Connector root");
      const resolved = scanPath
        ? await stat((await this.#options.roots.resolveReadableFile(target).catch(() => this.#options.roots.resolveReadableDirectory(target))).fileSystemPath)
        : undefined;
      if (resolved?.isFile()) {
        const safe = await this.#options.roots.resolveReadableFile(target);
        const details = await stat(safe.fileSystemPath);
        const entry = { name: path.basename(target), uri: `local://${target}`, size: details.size, localPath: safe.fileSystemPath, mtimeMs: details.mtimeMs };
        if (fileMatches(asset, entry.name)) files.push({ ...entry, id: sourceId(connector, entry) });
        return files;
      }
      const directoryPath = scanPath ? (await this.#options.roots.resolveReadableDirectory(target)).fileSystemPath : resolvedRoot.fileSystemPath;
      const walk = async (containerDirectory: string, filesystemDirectory: string): Promise<void> => {
        const entries = await readdir(filesystemDirectory, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isSymbolicLink()) continue;
          const filesystemPath = path.join(filesystemDirectory, entry.name);
          const containerPath = path.join(containerDirectory, entry.name);
          if (entry.isDirectory()) await walk(containerPath, filesystemPath);
          else if (entry.isFile() && fileMatches(asset, entry.name)) {
            const details = await stat(filesystemPath);
            const record = { name: entry.name, uri: `local://${containerPath}`, size: details.size, localPath: filesystemPath, mtimeMs: details.mtimeMs };
            files.push({ ...record, id: sourceId(connector, record) });
          }
          if (files.length > MAX_INVENTORY_FILES) throw new RangeError(`Scan inventory exceeds the ${MAX_INVENTORY_FILES} file limit`);
        }
      };
      await walk(scanPath ?? "", directoryPath);
    } else {
      if (!credentials) throw new RangeError("Connector has no saved S3/OSS credentials");
      const basePrefix = (connector.config.prefix ?? "").replace(/^\/+|\/+$/g, "");
      const pathPrefix = scanPath ? `${basePrefix ? `${basePrefix}/` : ""}${scanPath}` : basePrefix;
      const objectEntries = await listConnectorObjects(connector, credentials, pathPrefix);
      const exact = Boolean(scanPath && /\.(csv|fits?|fits\.gz)$/i.test(scanPath));
      for (const object of objectEntries) {
        const normalizedKey = object.key.replace(/^\/+/, "");
        if (exact ? normalizedKey !== pathPrefix : pathPrefix && normalizedKey !== pathPrefix && !normalizedKey.startsWith(`${pathPrefix}/`)) continue;
        if (!fileMatches(asset, normalizedKey)) continue;
        if (!object.etag) throw new RangeError(`Object store inventory did not provide an ETag for ${normalizedKey}; a stable scan snapshot cannot be guaranteed`);
        const record = {
          name: path.posix.basename(normalizedKey), uri: `s3://${connector.config.bucket}/${normalizedKey}`,
          size: object.size, objectKey: normalizedKey, ...(object.lastModified ? { lastModified: object.lastModified } : {}),
          ...(object.etag ? { etag: object.etag } : {}),
        };
        files.push({ ...record, id: sourceId(connector, record) });
        if (files.length > MAX_INVENTORY_FILES) throw new RangeError(`Scan inventory exceeds the ${MAX_INVENTORY_FILES} file limit`);
      }
    }
    files.sort((left, right) => left.uri.localeCompare(right.uri));
    return files;
  }

  #schedule(task: WorkspaceScanTask, run: ConnectorIngestRunRecord): void {
    const existing = this.#tasks.get(run.id);
    if (existing) return;
    const work = this.#execute(task, run).catch(async (error) => {
      const completedAt = new Date().toISOString();
      const message = errorMessage(error);
      const asset = await this.#options.dataCatalog.get(task.assetId).catch(() => undefined);
      if (asset) {
        await this.#options.artifacts.fail({
          layerId: workspaceLayerId(asset.id), scanRunId: run.id,
          coverageRole: taskFits(asset) ? "image_extent" : "object_presence",
          dataOrigin: taskFits(asset) ? "observed" : "catalog", sourceTier: "user_file_derived",
          precision: "exact", availableOrders: [10], maxOrder: 10,
          sourceSnapshotSha256: task.sourceSnapshotSha256,
        }, message).catch(() => undefined);
      }
      return this.#options.runs.update(run.id, { status: "failed", error: message, completedAt, failedFiles: task.failedFiles, processedFiles: task.processedFiles, pointCount: task.pointCount, mocStatus: "failed" })
        .catch(async () => (await this.#options.runs.list()).find((candidate) => candidate.id === run.id) ?? run);
    });
    this.#tasks.set(run.id, work);
    const cleanup = (): void => { if (this.#tasks.get(run.id) === work) this.#tasks.delete(run.id); };
    void work.then(cleanup, cleanup);
  }

  async #execute(task: WorkspaceScanTask, originalRun: ConnectorIngestRunRecord): Promise<ConnectorIngestRunRecord> {
    const connector = await this.#options.connectors.get(task.connectorId);
    const asset = await this.#options.dataCatalog.get(task.assetId);
    const credentials = connector.kind === "s3" && connector.credentialRef ? await this.#options.credentials.get(connector.credentialRef) : undefined;
    if (connector.kind === "s3" && !credentials) throw new Error("Connector credentials are unavailable after restart");
    const run = (await this.#options.runs.list()).find((candidate) => candidate.id === originalRun.id) ?? originalRun;
    const context: UserMocArtifactContext = {
      layerId: workspaceLayerId(asset.id), scanRunId: run.id,
      coverageRole: taskFits(asset) ? "image_extent" : "object_presence",
      dataOrigin: taskFits(asset) ? "observed" : "catalog", sourceTier: "user_file_derived",
      precision: "exact", availableOrders: [10], maxOrder: 10,
      sourceSnapshotSha256: task.sourceSnapshotSha256,
    };
    await this.#options.runs.update(run.id, { status: "running", phase: "reading", fileCount: task.files.length });
    await this.#options.artifacts.createPending(context);
    await this.#options.objectIndex.ensureIndices();
    await this.#options.skyPoints.ensureIndices();
    const partialMocs = [...task.partialMocPaths];
    for (const file of task.files) {
      if (task.completedFileIds.includes(file.id)) continue;
      try {
        await this.#assertSourceVersion(file);
        if (taskFits(asset)) await this.#scanFitsFile(file, task, run, asset, connector, credentials, partialMocs);
        else await this.#scanCsvFile(file, task, run, asset, partialMocs);
        await this.#assertSourceVersion(file);
        task.completedFileIds.push(file.id);
        task.failedFileIds = task.failedFileIds.filter((id) => id !== file.id);
        task.errors = task.errors.filter((entry) => entry.fileId !== file.id);
      } catch (error) {
        if (!task.failedFileIds.includes(file.id)) task.failedFileIds.push(file.id);
        task.errors = task.errors.filter((entry) => entry.fileId !== file.id);
        task.errors.push({ fileId: file.id, message: `${file.name}: ${errorMessage(error)}` });
      }
      task.failedFiles = task.failedFileIds.length;
      task.processedFiles = task.completedFileIds.length;
      await this.#saveTask(task);
      await this.#options.runs.update(run.id, {
        phase: "reading", processedFiles: task.processedFiles, failedFiles: task.failedFiles,
        pointCount: task.pointCount, documentCount: task.documentCount,
      });
    }
    await this.#flushFitsHeaders(task, run, asset, partialMocs);
    if (!partialMocs.length) throw new Error(task.errors.length
      ? task.errors.slice(0, 20).map(entry => entry.message).join("; ").slice(0, 2000)
      : "No usable coverage geometry was found in the selected source files");
    await this.#options.runs.update(run.id, { phase: "coverage" });
    await this.#options.runs.update(run.id, { phase: "indexing" });
    const moc = await this.#optionsMocMerge(partialMocs, asset, run.id);
    if (!moc.artifacts?.moc) throw new Error("MOC Core did not produce a FITS MOC artifact");
    const artifact = await this.#options.artifacts.persist(moc, context, {
      statistics: { schemaVersion: 1, fileCount: task.files.length, pointCount: task.pointCount, failedFiles: task.failedFiles },
      provenance: { schemaVersion: 1, layerId: workspaceLayerId(asset.id), scanRunId: run.id, sourceSnapshotSha256: task.sourceSnapshotSha256, coordinateFrame: "ICRS", ordering: "NESTED", coverageRole: context.coverageRole, sourceTier: "user_file_derived" },
    });
    if (artifact.status !== "ready") throw new Error(artifact.error ?? "Workspace MOC artifact validation failed");
    const completedAt = new Date().toISOString();
    const status = task.failedFiles ? "failed" : "succeeded";
    const error = task.failedFiles ? task.errors.slice(0, 20).map((entry) => entry.message).join("; ").slice(0, 2000) : undefined;
    const completed = await this.#options.runs.update(run.id, {
      status, ...(error ? { error } : { error: undefined }), completedAt,
      phase: "complete", processedFiles: task.processedFiles, failedFiles: task.failedFiles,
      pointCount: task.pointCount, documentCount: task.documentCount,
      mocStatus: artifact.status, artifactId: artifact.id, availableOrders: artifact.availableOrders,
      maxOrder: artifact.maxOrder, precision: artifact.precision, coverageRole: artifact.coverageRole,
    });
    if (completed.status === "succeeded") {
      await this.#options.statistics?.recordScan(completed, task.files).catch((statisticsError) => {
        console.warn("Unable to record Workspace scan statistics", statisticsError instanceof Error ? statisticsError.message : statisticsError);
      });
    }
    return completed;
  }

  async #scanCsvFile(file: ScanFile, task: WorkspaceScanTask, run: ConnectorIngestRunRecord, asset: DataAssetRecord, partialMocs: string[]): Promise<void> {
    const scanSpec = asset.scanSpec;
    if (!scanSpec || scanSpec.format !== "csv") throw new Error("CSV asset must define object ID, RA, and Dec columns");
    const connector = await this.#options.connectors.get(task.connectorId);
    const credentials = connector.kind === "s3" && connector.credentialRef ? await this.#options.credentials.get(connector.credentialRef) : undefined;
    const stagedPath = file.localPath ?? path.join(this.#root, run.id, `${file.id}.csv`);
    await mkdir(path.dirname(stagedPath), { recursive: true });
    if (!file.localPath) await this.#downloadObject(file, connector, credentials, stagedPath);
    const sourceFileId = file.id;
    const options = {
      objectIdColumn: scanSpec.objectIdColumn, raColumn: scanSpec.raColumn, decColumn: scanSpec.decColumn,
      surveyId: asset.surveyId ?? "user", releaseId: asset.releaseId ?? "user", product: scanSpec.product ?? asset.product,
      modality: scanSpec.modality ?? asset.modalities[0] ?? "catalog", assetId: asset.id, sourceFileId, scanRunId: run.id,
      objectIndex: ASTRO_OBJECT_INDEX, collectObjects: false, mocCore: this.#options.mocCore ?? defaultMocCoreAdapter,
    } as const;
    const validated = await scanLocalCsv(stagedPath, options);
    let docs: LocalScanDocument[] = [];
    let bytes = 0;
    const flush = async (): Promise<void> => {
      if (!docs.length) return;
      const batch = docs;
      docs = [];
      bytes = 0;
      const stored = await this.#options.objectIndex.bulk(batch);
      task.documentCount += stored.objectCount;
      await this.#saveTask(task);
    };
    const sink = async (document: LocalScanDocument): Promise<void> => {
      const size = documentBytes(document);
      if (docs.length && (docs.length >= MAX_BULK_DOCUMENTS || bytes + size > MAX_BULK_BYTES)) await flush();
      docs.push(document);
      bytes += size;
      if (docs.length >= MAX_BULK_DOCUMENTS || bytes >= MAX_BULK_BYTES) await flush();
    };
    const indexed = await scanLocalCsv(stagedPath, { ...options, sink });
    await flush();
    if (indexed.summary.sourceSnapshotSha256 !== validated.summary.sourceSnapshotSha256) throw new Error(`CSV source changed during scan: ${file.name}`);
    const filename = path.join(this.#root, run.id, `${file.id}.moc.fits`);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, indexed.moc?.artifacts?.moc ?? validated.moc?.artifacts?.moc ?? Buffer.alloc(0));
    if (!indexed.moc?.artifacts?.moc && !validated.moc?.artifacts?.moc) throw new Error(`MOC Core did not build coverage for ${file.name}`);
    partialMocs.push(filename);
    task.partialMocPaths = partialMocs;
    task.pointCount += indexed.summary.objectCount;
    if (!file.localPath) await rm(stagedPath, { force: true });
    await this.#saveTask(task);
  }

  async #scanFitsFile(file: ScanFile, task: WorkspaceScanTask, run: ConnectorIngestRunRecord, asset: DataAssetRecord, connector: ConnectorRecord, credentials: Awaited<ReturnType<ConnectorCredentialStore["get"]>>, partialMocs: string[]): Promise<void> {
    let headers: FitsHeaderRecord[];
    if (file.name.toLowerCase().endsWith(".fits.gz")) {
      let local: NodeJS.ReadableStream;
      if (file.localPath) local = createReadStream(file.localPath);
      else {
        const response = await openConnectorObjectStream(connector, credentials!, file.objectKey!, file.etag);
        if (file.etag && response.etag && response.etag !== file.etag) { response.stream.destroy(); throw new Error(`S3 object changed during scan: ${file.name}`); }
        local = response.stream;
      }
      const source = new GzipRangeSource(file.size, local);
      try { headers = await readFitsHeaders(source, { file_id: file.id, source_uri: file.uri, file_name: file.name }); }
      finally {
        source.destroy();
        if ("destroy" in local && typeof local.destroy === "function") local.destroy();
      }
    } else {
      if (file.localPath) {
        const local = await this.#localByteSource(file.localPath);
        try { headers = await readFitsHeaders(local.source, { file_id: file.id, source_uri: file.uri, file_name: file.name }); }
        finally { await local.close(); }
      } else {
        const source: FitsByteSource = {
            size: file.size,
            read: async (offset, length) => {
              const response = await readConnectorObjectRange(connector, credentials!, file.objectKey!, offset, Math.min(file.size - 1, offset + length - 1), file.etag);
              const expectedStart = `bytes ${offset}-`;
              if (response.contentRange && !response.contentRange.startsWith(expectedStart)) throw new Error("Object store returned the wrong byte range");
              if (response.etag && file.etag && response.etag !== file.etag) throw new Error(`S3 object changed during scan: ${file.name}`);
              if (response.bytes.byteLength > length) throw new Error("S3 range response exceeded the requested size");
              return response.bytes;
            },
          };
        headers = await readFitsHeaders(source, { file_id: file.id, source_uri: file.uri, file_name: file.name });
      }
    }
    const positionRows = await convertPositionHeaders(headers);
    const validRows = positionRows.filter((record) => record.position_role === "image_center") as HeaderPoint[];
    const pointDocs = validRows.map((point) => pointDocument(point, asset, run));
    const footprintDocs = validRows.flatMap((point) => imageFootprintDocuments(point, asset.id));
    for (let offset = 0; offset < pointDocs.length; offset += MAX_BULK_DOCUMENTS) {
      await this.#options.skyPoints.bulk(pointDocs.slice(offset, offset + MAX_BULK_DOCUMENTS));
      await this.#options.skyPoints.bulkImageFootprints(footprintDocs.slice(offset, offset + MAX_BULK_DOCUMENTS));
      task.pointCount += Math.min(MAX_BULK_DOCUMENTS, pointDocs.length - offset);
      await this.#saveTask(task);
    }
    const mocHeaders = validRows.flatMap((record) => {
      const header = record.moc_header;
      return header && Number.isSafeInteger(header.NAXIS1) && Number.isSafeInteger(header.NAXIS2)
        ? [{ ...header, NAXIS: 2 }]
        : [];
    });
    if (mocHeaders.length) {
      task.pendingFitsHeaders.push(...validRows.filter((record) => record.moc_header
        && Number.isSafeInteger(record.moc_header.NAXIS1) && Number.isSafeInteger(record.moc_header.NAXIS2))
        .map((record) => record as unknown as FitsWcsHeader));
      task.pendingFileIds.push(file.id);
      await this.#saveTask(task);
      const pendingBytes = Buffer.byteLength(JSON.stringify(task.pendingFitsHeaders.map((record) => record.moc_header)));
      if (task.pendingFitsHeaders.length >= MAX_MOC_HEADERS_PER_BATCH || pendingBytes >= MAX_MOC_HEADER_BATCH_BYTES) await this.#flushFitsHeaders(task, run, asset, partialMocs);
    } else {
      throw new Error(`No two-dimensional celestial WCS found in ${file.name}`);
    }
    task.documentCount += pointDocs.length;
    await this.#saveTask(task);
  }

  async #flushFitsHeaders(task: WorkspaceScanTask, run: ConnectorIngestRunRecord, asset: DataAssetRecord, partialMocs: string[]): Promise<void> {
    if (!task.pendingFitsHeaders.length) return;
    const core = this.#options.mocCore ?? defaultMocCoreAdapter;
    if (!core.buildFitsWcs) throw new Error("Configured MOC SDK adapter does not support FITS/WCS coverage");
    const work = path.join(this.#root, run.id);
    await mkdir(work, { recursive: true });
    const batchIndex = partialMocs.length;
    const inputPath = path.join(work, `fits-headers-${batchIndex}.json`);
    await writeFile(inputPath, JSON.stringify({ headers: task.pendingFitsHeaders.map((record) => record.moc_header) }));
    const built = await core.buildFitsWcs({ inputPath, layerId: `${workspaceLayerId(asset.id)}-${batchIndex}`, coverageRole: "image_extent", dataOrigin: "observed", sourceTier: "user_file_derived", maxOrder: 10 });
    if (!built.artifacts?.moc) throw new Error("MOC SDK returned no FITS coverage artifact");
    const mocPath = path.join(work, `fits-${batchIndex}.moc.fits`);
    await writeFile(mocPath, built.artifacts.moc);
    partialMocs.push(mocPath);
    task.partialMocPaths = partialMocs;
    task.completedFileIds = [...new Set([...task.completedFileIds, ...task.pendingFileIds])];
    task.processedFiles = task.completedFileIds.length;
    task.pendingFitsHeaders = [];
    task.pendingFileIds = [];
    await this.#saveTask(task);
  }

  async #optionsMocMerge(mocs: string[], asset: DataAssetRecord, runId: string): Promise<MocCoreCatalogResult> {
    const core = this.#options.mocCore ?? defaultMocCoreAdapter;
    if (!core.mergeCatalogs) throw new Error("Configured MOC SDK adapter does not support merging coverage batches");
    const context = {
      layerId: workspaceLayerId(asset.id),
      coverageRole: taskFits(asset) ? "image_extent" as const : "object_presence" as const,
      dataOrigin: taskFits(asset) ? "observed" as const : "catalog" as const,
      sourceTier: "user_file_derived" as const,
      maxOrder: 10,
    };
    let paths = [...mocs];
    let level = 0;
    while (paths.length > MAX_MOC_MERGE_FAN_IN) {
      const next: string[] = [];
      for (let offset = 0; offset < paths.length; offset += MAX_MOC_MERGE_FAN_IN) {
        const partialMocPaths = paths.slice(offset, offset + MAX_MOC_MERGE_FAN_IN);
        const merged = await core.mergeCatalogs({ partialMocPaths, ...context });
        if (!merged.artifacts?.moc) throw new Error("MOC Core did not produce a merged FITS MOC artifact");
        const output = path.join(this.#root, runId, `merged-${level}-${next.length}.moc.fits`);
        await writeFile(output, merged.artifacts.moc);
        next.push(output);
      }
      paths = next;
      level += 1;
    }
    return core.mergeCatalogs({ partialMocPaths: paths, ...context });
  }

  async #downloadObject(file: ScanFile, connector: ConnectorRecord, credentials: Awaited<ReturnType<ConnectorCredentialStore["get"]>>, outputPath: string): Promise<void> {
    if (!credentials || !file.objectKey) throw new Error("Remote source is missing Connector credentials or object identity");
    const source = await openConnectorObjectStream(connector, credentials, file.objectKey, file.etag);
    if (file.etag && source.etag && source.etag !== file.etag) { source.stream.destroy(); throw new Error(`S3 object changed during scan: ${file.name}`); }
    await pipeline(source.stream, createWriteStream(outputPath, { flags: "w" }));
    const details = await stat(outputPath);
    if (details.size !== file.size) throw new Error(`Downloaded CSV size changed during scan: ${file.name}`);
  }

  async #localByteSource(filename: string): Promise<{ source: FitsByteSource; close(): Promise<void> }> {
    const handle = await open(filename, "r");
    const details = await handle.stat();
    return {
      source: {
        size: details.size,
        read: async (offset, length) => {
          const buffer = Buffer.allocUnsafe(length);
          const result = await handle.read(buffer, 0, length, offset);
          return buffer.subarray(0, result.bytesRead);
        },
      },
      close: () => handle.close(),
    };
  }

  async #assertSourceVersion(file: ScanFile): Promise<void> {
    if (!file.localPath) return;
    const current = await stat(file.localPath);
    if (current.size !== file.size || current.mtimeMs !== file.mtimeMs) throw new Error(`Local source changed during scan: ${file.name}`);
  }

  async #saveTask(task: WorkspaceScanTask): Promise<void> {
    await mkdir(this.#root, { recursive: true });
    const finalPath = path.join(this.#root, `${task.runId}.json`);
    const tempPath = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(task)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(tempPath, finalPath);
  }

  async #readTask(runId: string): Promise<WorkspaceScanTask> {
    const value = JSON.parse(await readFile(path.join(this.#root, `${runId}.json`), "utf8")) as WorkspaceScanTask;
    if (value.version !== 1 || value.runId !== runId || !Array.isArray(value.files) || !Array.isArray(value.completedFileIds)) throw new Error("Workspace scan checkpoint is invalid");
    return value;
  }
}

function taskFits(asset: Pick<DataAssetRecord, "kind" | "scanSpec">): boolean {
  return asset.scanSpec?.format === "fits" || asset.kind === "image" || asset.kind === "cube";
}

export { WORKSPACE_SCAN_EXECUTOR };
