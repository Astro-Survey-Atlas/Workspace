import { propagation, ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, opendir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { ScanControl } from "./scan-control.js";
import type { ScanTask } from "./scan-task.js";
import { ScanEvidenceWriter } from "./scan-evidence.js";
import type { ConnectorCredentialStore } from "./connector-credentials.js";
import { iterateConnectorObjectPages, openConnectorObjectStream, readConnectorObjectRange, hasCurrentSuccessfulConnectorCheck, type ConnectorRecord, type ConnectorRegistry } from "./connectors.js";
import { ASTRO_OBJECT_INDEX, type AstroObjectIndexService } from "./astro-object-index.js";
import { ConnectorIngestRunCatalog, type ConnectorIngestRunRecord } from "./connector-history.js";
import { normalizeLocalSourceRelativePath } from "./local-source-inspection.js";
import type { DataAssetRecord, DataCatalogRegistry } from "./data-catalog.js";
import type { LocalConnectorRootsPolicy } from "./local-connector-roots.js";
import { convertPositionHeaders, imageFootprintDocuments, pointDocument, type HeaderPoint } from "./fits-positions.js";
import { scanLocalCsv, type LocalObjectIndexDocument } from "./local-scan.js";
import { defaultMocCoreAdapter, type MocCoreAdapter, type MocCoreCatalogResult } from "./moc-core-adapter.js";
import type { UserMocArtifactStore } from "./user-moc-artifacts.js";
import { readFitsHeaders, type FitsByteSource, type FitsHeaderRecord } from "./fits-headers.js";
import { productionImageSources, registerProductionImageAssets, verifyProductionImageInventory } from "./production-image-assets.js";
import type { SourceFileInventory } from "./source-crawler.js";
import { activeTraceparent, recordScan, withRootSpan } from "./telemetry.js";

const WORKSPACE_SCAN_EXECUTOR = "workspace";
const MAX_INVENTORY_FILES = 1_000_000;
const BATCH_FILES = 64;
interface ScanFile { id: string; name: string; uri: string; size: number; localPath?: string; objectKey?: string; mtimeMs?: number; lastModified?: string; etag?: string }
export interface WorkspaceScanInput { relativePath?: string }
export function workspaceScanEnabled(value = process.env.ASTRO_WORKSPACE_SCAN_ENABLED): boolean {
  if (value === undefined || value === "true") return true;
  if (value === "false") return false;
  throw new RangeError("ASTRO_WORKSPACE_SCAN_ENABLED must be true or false");
}
interface WorkspaceScanExecutorOptions {
  enabled: boolean; control: ScanControl; root: string;
  connectors: ConnectorRegistry; credentials: ConnectorCredentialStore;
  dataCatalog: DataCatalogRegistry; runs: ConnectorIngestRunCatalog;
  roots: LocalConnectorRootsPolicy; objectIndex: AstroObjectIndexService;
  artifacts: UserMocArtifactStore; mocCore?: MocCoreAdapter;
}
const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const workspaceLayerId = (id: string): string => `workspace-${id}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 180);
const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 2000);
function linkedToConnector(asset: DataAssetRecord, connector: ConnectorRecord): boolean {
  return (asset.connectorIds ?? []).includes(connector.id) || (asset.connectorLocationKeys ?? []).includes(connector.locationKey)
    || [asset.access, ...(asset.accesses ?? [])].some(access => access.connectorId === connector.id || access.uri === connector.locationKey);
}
function taskFits(asset: DataAssetRecord): boolean { return asset.kind === "image" || asset.kind === "cube"; }
function fileMatches(asset: DataAssetRecord, name: string): boolean {
  const fits = asset.scanSpec?.format === "fits" || taskFits(asset);
  const supported = fits ? /\.(fits?|fits\.gz)$/i.test(name) : /\.csv$/i.test(name);
  const pattern = asset.scanSpec?.format === "fits" ? asset.scanSpec.fileNamePattern : undefined;
  return supported && (!pattern || new RegExp(pattern).test(path.posix.basename(name)));
}
function normalizeInput(input: WorkspaceScanInput = {}): WorkspaceScanInput {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => key !== "relativePath")) throw new RangeError("Scan supports only relativePath");
  return input.relativePath === undefined ? {} : { relativePath: normalizeLocalSourceRelativePath(input.relativePath) };
}
function configDigest(connector: ConnectorRecord, asset: DataAssetRecord, relativePath?: string): string {
  return sha256(JSON.stringify([connector.locationKey, connector.config, asset.scanSpec, asset.kind, asset.surveyId, asset.releaseId, asset.product, relativePath ?? asset.sourceRelativePath]));
}
function sourceId(connector: ConnectorRecord, file: Omit<ScanFile, "id">): string {
  return sha256(JSON.stringify([connector.locationKey, file.objectKey ?? file.localPath, file.size, file.mtimeMs, file.etag]));
}
class ScanInterrupted extends Error {}

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
  #busy = false;
  #stopping = false;
  constructor(options: WorkspaceScanExecutorOptions) { this.#options = options; this.#root = path.resolve(options.root); }
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


  async #run(id: string, connectorId?: string): Promise<ConnectorIngestRunRecord> {
    const run = (await this.#options.runs.list(connectorId ? { connectorId } : undefined)).find(run => run.id === id);
    if (!run || run.executor !== WORKSPACE_SCAN_EXECUTOR || run.scanTask?.version !== 2) throw Object.assign(new RangeError("This record has no local resumable checkpoint; submit a new scan"), { statusCode: 409 });
    return run;
  }
  async pause(connectorId: string, id: string): Promise<ConnectorIngestRunRecord> {
    await this.#run(id, connectorId);
    return this.#options.runs.update(id, { status: "paused" }, ["queued", "running"]);
  }
  async cancel(connectorId: string, id: string): Promise<ConnectorIngestRunRecord> {
    await this.#run(id, connectorId);
    return this.#options.runs.update(id, { status: "cancelled", completedAt: new Date().toISOString() }, ["queued", "running", "paused", "failed"]);
  }
  async resume(connectorId: string, id: string): Promise<ConnectorIngestRunRecord> {
    this.#options.control.assertRunning();
    const run = await this.#run(id, connectorId);
    return this.#options.runs.update(run.id, { status: "queued", error: undefined, completedAt: undefined }, ["paused"]);
  }
  async retry(connectorId: string, id: string): Promise<ConnectorIngestRunRecord> {
    this.#options.control.assertRunning();
    const run = await this.#run(id, connectorId);
    const task = { ...run.scanTask!, cursor: 0, processedFiles: 0, failedFiles: 0, pointCount: 0, mocBatches: 0, errors: [] };
    return this.#options.runs.update(id, { scanTask: task, status: "queued", error: undefined, completedAt: undefined, processedFiles: 0, failedFiles: 0, pointCount: 0, mocStatus: "pending" }, ["failed"]);
  }
  /** A restarted worker requires an explicit resume for in-flight runs. */
  async recoverInterruptedRuns(): Promise<number> {
    const running = (await this.#options.runs.list({ status: "running" })).filter(run => run.executor === WORKSPACE_SCAN_EXECUTOR);
    for (const run of running) await this.#options.runs.update(run.id, { status: "paused", error: "Worker restarted; resume from the last committed file batch" }, ["running"]);
    return running.length;
  }
  stop(): void { this.#stopping = true; }
  get busy(): boolean { return this.#busy; }
  async runNext(): Promise<boolean> {
    if (this.#busy || this.#stopping || !this.#options.enabled || this.#options.control.view().paused) return false;
    this.#busy = true;
    try {
      const queued = (await this.#options.runs.list({ status: "queued" })).filter(run => run.executor === WORKSPACE_SCAN_EXECUTOR && run.scanTask?.version === 2).at(-1);
      if (!queued) return false;
      const run = await this.#options.runs.update(queued.id, { status: "running", startedAt: new Date().toISOString() }, ["queued"]);
      await withRootSpan("scan.run", { "asa.component": "scan", "asa.scan.run_id": run.id, "asa.scan.kind": "workspace" }, async () => {
        try { await this.#execute(run); }
        catch (error) {
          const current = await this.#run(run.id);
          if (error instanceof ScanInterrupted || ["paused", "cancelled"].includes(current.status)) {
            if (current.status === "running") await this.#options.runs.update(run.id, { status: "paused" }, ["running"]);
            return;
          }
          await this.#options.runs.update(run.id, { status: "failed", completedAt: new Date().toISOString(), error: errorMessage(error), mocStatus: "failed" }, ["running"]);
          throw error;
        }
      }, run.scanTask!.traceparent ? trace.getSpanContext(propagation.extract(ROOT_CONTEXT, { traceparent: run.scanTask!.traceparent })) : undefined).catch(error => console.warn("Workspace scan failed", { runId: run.id, error: errorMessage(error) }));
      return true;
    } finally { this.#busy = false; }
  }
  async #check(runId: string): Promise<void> {
    if (this.#stopping || this.#options.control.view().paused || (await this.#run(runId)).status !== "running") throw new ScanInterrupted();
  }
  async #submit(connector: ConnectorRecord, asset: DataAssetRecord, rawInput?: WorkspaceScanInput, idempotencyKey?: string): Promise<ConnectorIngestRunRecord> {
    if (!this.#options.enabled) throw Object.assign(new Error("Workspace scanning is disabled"), { statusCode: 409 });
    this.#options.control.assertRunning();
    const input = normalizeInput(rawInput);
    if (connector.status === "disabled" || !["local", "s3"].includes(connector.kind)) throw new RangeError("Scan requires an enabled local or S3/OSS Connector");
    if (!hasCurrentSuccessfulConnectorCheck(connector)) throw new RangeError("Check the Connector before scanning");
    if (!this.#options.objectIndex.configured) throw new RangeError("Workspace Elasticsearch is not configured");
    if (!asset.scanSpec && !taskFits(asset)) throw new RangeError("Configure catalog coordinate columns before scanning");
    const task: ScanTask = { version: 2, ...input, sourceConfigSha256: configDigest(connector, asset, input.relativePath), traceparent: activeTraceparent(), inventoryReady: false, cursor: 0, processedFiles: 0, failedFiles: 0, pointCount: 0, totalBytes: 0, mocBatches: 0, errors: [] };
    // No directory enumeration, object-store requests, or scientific work here.
    return (await this.#options.runs.create(connector.locationKey, {
      connectorId: connector.id, connectorName: connector.name, connectorKind: connector.kind,
      executor: WORKSPACE_SCAN_EXECUTOR, backend: "local", taskKind: "user_coverage",
      assetId: asset.id, assetIds: [asset.id], assetName: asset.name,
      target: { uri: connector.kind === "local" ? `local://${connector.config.rootPath}` : `s3://${connector.config.bucket}/${connector.config.prefix ?? ""}` },
      status: "queued", phase: "staging", mocStatus: "pending", processedFiles: 0, failedFiles: 0, pointCount: 0,
      esIndex: this.#options.objectIndex.objectIndex, scanTask: task,
    }, idempotencyKey)).run;
  }
  async *#inventory(connector: ConnectorRecord, asset: DataAssetRecord, requestedPath?: string): AsyncGenerator<ScanFile> {
    const selected = requestedPath ?? asset.sourceRelativePath;
    const relative = selected ? normalizeLocalSourceRelativePath(selected) : undefined;
    if (connector.kind === "local") {
      const root = connector.config.rootPath!;
      const target = relative ? path.resolve(root, ...relative.split("/")) : root;
      if (target !== root && !target.startsWith(root + path.sep)) throw new RangeError("Scan path must stay inside Connector root");
      const resolved = await this.#options.roots.resolveReadableFile(target).catch(() => this.#options.roots.resolveReadableDirectory(target));
      const walk = async function* (filename: string, containerPath: string): AsyncGenerator<ScanFile> {
        const details = await stat(filename);
        if (details.isDirectory()) {
          const directory = await opendir(filename);
          for await (const entry of directory) if (!entry.isSymbolicLink()) yield* walk(path.join(filename, entry.name), path.join(containerPath, entry.name));
        } else if (details.isFile() && fileMatches(asset, filename)) {
          const record = { name: path.basename(filename), uri: `local://${containerPath}`, size: details.size, localPath: filename, mtimeMs: details.mtimeMs };
          yield { ...record, id: sourceId(connector, record) };
        }
      };
      yield* walk(resolved.fileSystemPath, target);
    } else {
      const credentials = connector.credentialRef ? await this.#options.credentials.get(connector.credentialRef) : undefined;
      if (!credentials) throw new Error("Connector has no saved credentials");
      const base = (connector.config.prefix ?? "").replace(/^\/+|\/+$/g, "");
      const prefix = relative ? `${base ? base + "/" : ""}${relative}` : base;
      const exact = !!relative && /\.(csv|fits?|fits\.gz)$/i.test(relative);
      for await (const page of iterateConnectorObjectPages(connector, credentials, prefix)) for (const object of page.objects) {
        const key = object.key.replace(/^\/+/, "");
        if (exact ? key !== prefix : prefix && key !== prefix && !key.startsWith(prefix + "/")) continue;
        if (!fileMatches(asset, key)) continue;
        if (!object.etag) throw new Error("Object inventory has no ETag; immutable scanning requires an object version");
        const record = { name: path.posix.basename(key), uri: `s3://${connector.config.bucket}/${key}`, size: object.size, objectKey: key, etag: object.etag, lastModified: object.lastModified };
        yield { ...record, id: sourceId(connector, record) };
      }
    }
  }
  async #freeze(run: ConnectorIngestRunRecord, task: ScanTask, asset: DataAssetRecord, connector: ConnectorRecord): Promise<void> {
    const work = path.join(this.#root, run.id);
    await mkdir(work, { recursive: true });
    const temporary = path.join(work, "inventory.tmp");
    const handle = await open(temporary, "w");
    const digest = createHash("sha256");
    let count = 0, bytes = 0;
    try {
      for await (const file of this.#inventory(connector, asset, task.relativePath)) {
        await this.#check(run.id);
        if (++count > MAX_INVENTORY_FILES) throw new RangeError("Inventory exceeds one million files");
        const line = JSON.stringify(file) + "\n";
        await handle.writeFile(line); digest.update(line); bytes += file.size;
        if (count % 256 === 0) await this.#options.runs.update(run.id, { processedFiles: 0, phase: "staging" });
      }
      if (!count) throw new Error("No supported files matched this asset and Connector");
      await handle.sync();
    } finally { await handle.close(); }
    await rename(temporary, path.join(work, "inventory.ndjson"));
    Object.assign(task, { inventoryReady: true, inventorySha256: digest.digest("hex"), totalBytes: bytes });
    await this.#options.runs.update(run.id, { scanTask: task, fileCount: count, totalBytes: bytes, sourceSnapshotSha256: task.inventorySha256, phase: "reading" });
  }
  async #execute(run: ConnectorIngestRunRecord): Promise<void> {
    const task = structuredClone(run.scanTask!);
    const asset = await this.#options.dataCatalog.get(run.assetId!);
    const connector = await this.#options.connectors.get(run.connectorId!);
    if (configDigest(connector, asset, task.relativePath) !== task.sourceConfigSha256) throw new Error("Source configuration changed; submit a new scan");
    if (!task.inventoryReady) await this.#freeze(run, task, asset, connector);
    // Validate the frozen manifest before using a saved byte cursor.
    const inventory = path.join(this.#root, run.id, "inventory.ndjson");
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(inventory)) { await this.#check(run.id); digest.update(chunk); }
    if (digest.digest("hex") !== task.inventorySha256) throw new Error("Frozen scan inventory checksum mismatch");
    await this.#options.objectIndex.ensureIndices();
    const input = createReadStream(inventory, { start: task.cursor });
    const lines = createInterface({ input, crlfDelay: Infinity });
    let batch: ScanFile[] = [], nextCursor = task.cursor;
    try {
      for await (const line of lines) {
        nextCursor += Buffer.byteLength(line) + 1;
        batch.push(JSON.parse(line) as ScanFile);
        if (batch.length === BATCH_FILES) { await this.#batch(run, task, asset, connector, batch, nextCursor); batch = []; }
      }
      if (batch.length) await this.#batch(run, task, asset, connector, batch, nextCursor);
    } finally { lines.close(); input.destroy(); }
    await this.#check(run.id);
    if (task.failedFiles) throw new Error(`${task.failedFiles} files failed; previous active version retained. ${task.errors.join("; ")}`.slice(0, 2000));
    if (!task.mocBatches || !task.pointCount) throw new Error("No usable positions or coverage found; previous active version retained");
    await this.#options.runs.update(run.id, { phase: "coverage" });
    const moc = await this.#merge(task.mocBatches, asset, run.id);
    const context = { layerId: workspaceLayerId(asset.id), scanRunId: run.id, coverageRole: taskFits(asset) ? "image_extent" as const : "object_presence" as const, dataOrigin: taskFits(asset) ? "observed" as const : "catalog" as const, sourceTier: "user_file_derived" as const, precision: "exact" as const, availableOrders: [10], maxOrder: 10, sourceSnapshotSha256: task.inventorySha256! };
    const artifact = await this.#options.artifacts.persist(moc, context, { statistics: { fileCount: task.processedFiles, pointCount: task.pointCount }, provenance: { sourceSnapshotSha256: task.inventorySha256, scanRunId: run.id, coordinateFrame: "ICRS", ordering: "NESTED" } });
    if (artifact.status !== "ready") throw new Error(artifact.error ?? "MOC validation failed");
    await this.#check(run.id);
    await this.#options.runs.update(run.id, { phase: "indexing" });
    await this.#options.objectIndex.refresh();
    await this.#check(run.id);
    await this.#options.runs.activate(run.id, { phase: "complete", artifactId: artifact.id, mocStatus: "ready", availableOrders: artifact.availableOrders, maxOrder: artifact.maxOrder, precision: artifact.precision, coverageRole: artifact.coverageRole }, { runId: run.id, artifactId: artifact.id, pointCount: task.pointCount, fileCount: task.processedFiles, totalBytes: task.totalBytes, activatedAt: new Date().toISOString() });
    recordScan("workspace", { accepted: task.processedFiles, failed: task.failedFiles, bytes: task.totalBytes, peakRssBytes: process.memoryUsage().rss });
  }
  async #batch(run: ConnectorIngestRunRecord, task: ScanTask, asset: DataAssetRecord, connector: ConnectorRecord, files: ScanFile[], nextCursor: number): Promise<void> {
    const next = structuredClone(task);
    const writer = new ScanEvidenceWriter(this.#root, `${run.id}/evidence/batch-${task.cursor}`);
    const wcs: Record<string, unknown>[] = [];
    const credentials = connector.credentialRef ? await this.#options.credentials.get(connector.credentialRef) : undefined;
    try {
      for (const file of files) {
        await this.#check(run.id);
        try {
          await this.#assertSourceVersion(file);
          if (taskFits(asset)) await this.#scanFits(file, run, asset, connector, credentials, next, writer, wcs);
          else await this.#scanCatalog(file, run, asset, connector, credentials, next, writer);
          await this.#assertSourceVersion(file);
          next.processedFiles++;
        } catch (error) {
          if (error instanceof ScanInterrupted) throw error;
          next.failedFiles++;
          if (next.errors.length < 20) next.errors.push(`${file.name}: ${errorMessage(error)}`);
        }
      }
      await writer.close();
      if (wcs.length) {
        const core = this.#options.mocCore ?? defaultMocCoreAdapter;
        if (!core.buildFitsWcs) throw new Error("MOC adapter cannot build image coverage");
        const inputPath = path.join(this.#root, run.id, "wcs-input.json");
        await writeFile(inputPath, JSON.stringify({ headers: wcs }));
        const built = await core.buildFitsWcs({ inputPath, layerId: workspaceLayerId(asset.id), coverageRole: "image_extent", dataOrigin: "observed", sourceTier: "user_file_derived", maxOrder: 10 });
        await this.#saveMoc(run.id, next, built);
      }
      await this.#check(run.id);
      next.cursor = nextCursor;
      await this.#options.runs.update(run.id, { scanTask: next, processedFiles: next.processedFiles, failedFiles: next.failedFiles, pointCount: next.pointCount, documentCount: next.pointCount, phase: "reading" });
      Object.assign(task, next);
    } finally { await writer.close(); }
  }
  async #saveMoc(runId: string, task: ScanTask, result: MocCoreCatalogResult): Promise<void> {
    if (!result.artifacts?.moc) throw new Error("MOC adapter returned no FITS artifact");
    await writeFile(path.join(this.#root, runId, `batch-${task.mocBatches++}.moc.fits`), result.artifacts.moc);
  }
  async #compact(document: LocalObjectIndexDocument, writer: ScanEvidenceWriter): Promise<LocalObjectIndexDocument> {
    const evidence_ref = await writer.write({ attributes: document.attributes });
    const attributes = Object.fromEntries(Object.entries(document.attributes).filter(([key]) => ["source_uri", "file_name", "source_id", "position_role", "hdu_index"].includes(key)));
    return { ...document, evidence_ref, attributes };
  }
  async #scanCatalog(file: ScanFile, run: ConnectorIngestRunRecord, asset: DataAssetRecord, connector: ConnectorRecord, credentials: Awaited<ReturnType<ConnectorCredentialStore["get"]>>, task: ScanTask, writer: ScanEvidenceWriter): Promise<void> {
    const spec = asset.scanSpec;
    if (!spec) throw new Error("Catalog coordinate columns are required");
    const staged = file.localPath ?? path.join(this.#root, run.id, "catalog-source");
    if (!file.localPath) await this.#downloadObject(file, connector, credentials, staged);
    let csv = staged;
    const fitsTable = spec.format === "fits";
    if (fitsTable) { csv = path.join(this.#root, run.id, "catalog.csv"); await this.#fitsTableToCsv(staged, csv, spec); }
    let docs: LocalObjectIndexDocument[] = [], bytes = 0, points = 0;
    const flush = async (): Promise<void> => {
      if (!docs.length) return;
      await this.#check(run.id);
      await this.#options.objectIndex.bulk(docs);
      docs = []; bytes = 0;
    };
    try {
      const indexed = await scanLocalCsv(csv, {
        objectIdColumn: fitsTable ? "id" : spec.objectIdColumn!, raColumn: fitsTable ? "ra" : spec.raColumn!, decColumn: fitsTable ? "dec" : spec.decColumn!,
        surveyId: asset.surveyId ?? "user", releaseId: asset.releaseId ?? "user", product: asset.product, modality: asset.modalities[0] ?? "catalog",
        assetId: asset.id, sourceFileId: file.id, scanRunId: run.id, objectIndex: ASTRO_OBJECT_INDEX, collectObjects: false, mocCore: this.#options.mocCore ?? defaultMocCoreAdapter,
        sink: async document => {
          if (!("object_id" in document)) return;
          const compact = await this.#compact({ ...document, _id: sha256(`${run.id}\n${document._id}`), data_batch_id: run.id, attributes: { ...document.attributes, source_uri: file.uri, file_name: file.name, position_role: "catalog_row" } }, writer);
          const size = Buffer.byteLength(JSON.stringify(compact));
          if (docs.length && (docs.length >= 500 || bytes + size > 2 * 1024 * 1024)) await flush();
          docs.push(compact); bytes += size; points++;
        },
      });
      await flush();
      if (indexed.summary.invalidRowCount || indexed.summary.csvErrorCount) throw new Error(`Catalog has ${indexed.summary.invalidRowCount} invalid rows and ${indexed.summary.csvErrorCount} parse errors`);
      if (!points) throw new Error("Catalog contains no usable positions");
      await this.#saveMoc(run.id, task, indexed.moc!);
      task.pointCount += points;
    } finally { if (!file.localPath) await rm(staged, { force: true }); if (fitsTable) await rm(csv, { force: true }); }
  }
  async #fitsTableToCsv(source: string, output: string, spec: import("./data-catalog.js").DataAssetFitsScanSpec): Promise<void> {
    const { spawn } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.env.ASTRO_PYTHON ?? "python3", [fileURLToPath(new URL("./scan-fits-catalog.py", import.meta.url)), source, output], { stdio: ["pipe", "ignore", "pipe"] });
      let error = "";
      const timer = setTimeout(() => child.kill(), 300_000);
      child.stderr.on("data", chunk => { if (error.length < 2000) error += String(chunk); });
      child.on("error", reject);
      child.on("close", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`FITS catalog conversion failed: ${error}`)); });
      child.stdin.end(JSON.stringify({ id: spec.objectIdColumn, ra: spec.raColumn, dec: spec.decColumn }));
    });
  }
  async #scanFits(file: ScanFile, run: ConnectorIngestRunRecord, asset: DataAssetRecord, connector: ConnectorRecord, credentials: Awaited<ReturnType<ConnectorCredentialStore["get"]>>, task: ScanTask, writer: ScanEvidenceWriter, wcs: Record<string, unknown>[]): Promise<void> {
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

    const positions = (await convertPositionHeaders(headers)) as HeaderPoint[];
    const valid = positions.filter(point => point.position_role === "image_center" && point.moc_header);
    if (!valid.length) throw new Error("No two-dimensional celestial WCS found");
    const documents: LocalObjectIndexDocument[] = [];
    for (const point of valid) documents.push(await this.#compact(pointDocument(point, asset, run), writer));
    await this.#options.objectIndex.bulk(documents);
    await this.#options.objectIndex.bulkImageFootprints(valid.flatMap(point => imageFootprintDocuments(point, asset.id, undefined, run.id)));
    task.pointCount += documents.length;
    for (const point of valid) wcs.push({ ...point.moc_header!, NAXIS: 2 });
    if (Buffer.byteLength(JSON.stringify(wcs)) > 8 * 1024 * 1024) throw new Error("FITS WCS batch exceeds 8 MiB");
  }
  async #merge(count: number, asset: DataAssetRecord, runId: string): Promise<MocCoreCatalogResult> {
    const core = this.#options.mocCore ?? defaultMocCoreAdapter;
    if (!core.mergeCatalogs) throw new Error("MOC adapter cannot merge coverage batches");
    const context = { layerId: workspaceLayerId(asset.id), coverageRole: taskFits(asset) ? "image_extent" as const : "object_presence" as const, dataOrigin: taskFits(asset) ? "observed" as const : "catalog" as const, sourceTier: "user_file_derived" as const, maxOrder: 10 };
    let level = -1;
    const filename = (index: number): string => path.join(this.#root, runId, level < 0 ? `batch-${index}.moc.fits` : `merged-${level}-${index}.moc.fits`);
    while (count > 64) {
      let written = 0;
      for (let offset = 0; offset < count; offset += 64) {
        await this.#check(runId);
        const paths = Array.from({ length: Math.min(64, count - offset) }, (_, index) => filename(offset + index));
        const result = await core.mergeCatalogs({ ...context, partialMocPaths: paths });
        if (!result.artifacts?.moc) throw new Error("MOC merge returned no FITS artifact");
        await writeFile(path.join(this.#root, runId, `merged-${level + 1}-${written++}.moc.fits`), result.artifacts.moc);
      }
      count = written; level++;
    }
    return core.mergeCatalogs({ ...context, partialMocPaths: Array.from({ length: count }, (_, index) => filename(index)) });
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

 }
export { WORKSPACE_SCAN_EXECUTOR };
