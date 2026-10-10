import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { Healpix, Hploc } from "healpixjs";
import type { AstroObjectIndexService, SkyDataPointScope } from "./astro-object-index.js";
import type { ConnectorIngestRunCatalog, ConnectorIngestRunRecord } from "./connector-history.js";
import type { DataCatalogRegistry } from "./data-catalog.js";
import type { CoverageDownloadJob } from "./coverage-downloads.js";
import type { LocalObjectIndexDocument } from "./local-scan.js";
import type { UserMocArtifactStore } from "./user-moc-artifacts.js";
import type { WarehouseScanService } from "./warehouse-scan.js";
import { stageWarehouseInventory } from "./warehouse-inventory.js";
import { defaultMocCoreAdapter, type MocCoreAdapter } from "./moc-core-adapter.js";

export const SKY_DATA_POINT_INDEX = "astro_data_point_index_v1";
export interface DerivedRepair {
  id: string; assetId: string; scanRunId: string; mode: "moc" | "positions" | "both";
  status: "queued" | "running" | "succeeded" | "partial" | "failed";
  phase: "staging" | "moc" | "headers" | "indexing" | "complete";
  createdAt: string; updatedAt: string; sourceSnapshotSha256: string; companion?: boolean; maxFiles?: number;
  processedFiles: number; fileCount: number; pointCount: number; coordinateErrors: number;
  headerErrors: number; indexedBytes: number; jobName?: string; outputPath?: string;
  mocStatus?: string; error?: string;
  retryAttempts?: number; nextRetryAt?: string;
}
class RetryablePointIndexError extends Error {}
function retryableIndexError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /Elasticsearch request timed out|fetch failed|HTTP (429|502|503|504)\b|ECONNRESET|ECONNREFUSED|ETIMEDOUT/.test(error.message);
}
interface HeaderPoint extends Record<string, unknown> { file_id: string; source_uri: string; file_name: string; hdu_index: number; ra_deg: number; dec_deg: number }
export async function convertPositionHeaders(records: unknown[]): Promise<Record<string, unknown>[]> {
  if (!records.length) return [];
  const script = fileURLToPath(new URL("./sky-point-coordinates.py", import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.ASTRO_PYTHON ?? "python3", [script], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "", errors = "";
    const timer = setTimeout(() => child.kill(), 120000);
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); if (output.length > 64 * 1024 * 1024) child.kill(); });
    child.stderr.on("data", (chunk: Buffer) => { if (errors.length < 4000) errors += chunk.toString(); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); if (code !== 0) reject(new Error(`Header coordinate conversion failed (${code}): ${errors.slice(0, 2000)}`));
      else { try { resolve(output.trim() ? output.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>) : []); } catch (error) { reject(error); } } });
    child.stdin.on("error", () => undefined);
    child.stdin.end(records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  });
}
export function pointDocument(point: HeaderPoint, asset: { id: string; surveyId?: string; releaseId?: string; product?: string }, run: ConnectorIngestRunRecord, sourceId?: string): LocalObjectIndexDocument {
  if (!Number.isFinite(point.ra_deg) || !Number.isFinite(point.dec_deg) || Math.abs(point.dec_deg) > 90 || point.ra_deg < 0 || point.ra_deg >= 360
    || !point.file_id || !Number.isInteger(point.hdu_index)) throw new Error("Invalid ICRS header coordinate");
  const id = createHash("sha256").update(`${asset.id}\n${point.file_id}\n${point.hdu_index}\n${point.position_role}`).digest("hex");
  const loc = new Hploc(); loc.setZ(Math.cos((90 - point.dec_deg) * Math.PI / 180)); loc.phi = point.ra_deg * Math.PI / 180;
  return { _index: SKY_DATA_POINT_INDEX, _id: id, object_id: id, ra_deg: point.ra_deg, dec_deg: point.dec_deg,
    sky_position: { lat: point.dec_deg, lon: point.ra_deg > 180 ? point.ra_deg - 360 : point.ra_deg },
    healpix_order: 8, healpix_pixel: new Healpix(256).loc2pix(loc), survey: asset.surveyId ?? "user", release: asset.releaseId ?? "user",
    product: asset.product ?? "image", modality: point.position_role === "image_center" ? "image" : "pointing", asset_id: asset.id,
    source_file_id: point.file_id, scan_run_id: run.id, attributes: Object.fromEntries(Object.entries({ source_uri: point.source_uri, file_name: point.file_name,
      hdu_index: point.hdu_index, position_role: point.position_role, position_method: point.position_method, coordinate_frame: "ICRS",
      header: point.header, primary_header: point.primary_header, source_snapshot_sha256: run.sourceSnapshotSha256, source_id: sourceId }).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)])) };
}
export function downloadedFileSources(jobs: CoverageDownloadJob[]): Map<string, string> {
  const sources = new Map<string, string>();
  for (const job of jobs) if (job.outputPath) for (const transfer of job.transfer) {
    if (transfer.status !== "verified" || !transfer.sourceId) continue;
    sources.set(path.resolve(job.outputPath, transfer.relativePath), transfer.sourceId);
  }
  return sources;
}
function fileSource(uri: string, sources: Map<string, string>): string | undefined {
  try { if (!uri.startsWith("file:")) return undefined;
    const original = fileURLToPath(uri);
    const scannerMount = process.env.ASTRO_WAREHOUSE_LOCAL_SCANNER_MOUNT ?? "/data";
    const workspaceMount = process.env.ASTRO_PRODUCTION_DATA_MOUNT ?? "/data/production";
    const translated = original.startsWith(scannerMount + path.sep) ? path.join(workspaceMount, path.relative(scannerMount, original)) : original;
    return sources.get(original) ?? sources.get(translated); } catch { return undefined; }
}
interface DerivedRepairOptions { root: string; evidenceRoot: string; runs: ConnectorIngestRunCatalog; assets: DataCatalogRegistry; artifacts: UserMocArtifactStore;
    warehouse: WarehouseScanService; points: AstroObjectIndexService; downloads: () => Promise<CoverageDownloadJob[]>; mocCore?: MocCoreAdapter }
export class DerivedRepairService {
  readonly #options: DerivedRepairOptions;
  #timer?: ReturnType<typeof setInterval>; #polling = false;
  constructor(options: DerivedRepairOptions) { this.#options = options; }
  async list(): Promise<DerivedRepair[]> {
    await mkdir(this.#options.root, { recursive: true });
    const result: DerivedRepair[] = [];
    for (const name of await readdir(this.#options.root)) if (/^derived-[a-f0-9]+\.json$/.test(name)) result.push(JSON.parse(await readFile(path.join(this.#options.root, name), "utf8")) as DerivedRepair);
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async submit(assetId: string, input: unknown): Promise<DerivedRepair> {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new RangeError("Repair input is required");
    const body = input as Record<string, unknown>;
    if (Object.keys(body).some((key) => !["mode", "scanRunId", "maxFiles"].includes(key))) throw new RangeError("Unknown derived repair field");
    const mode = body.mode ?? "both";
    if (!["moc", "positions", "both"].includes(String(mode))) throw new RangeError("Invalid repair mode");
    if (body.maxFiles !== undefined && (mode === "moc" || !Number.isSafeInteger(body.maxFiles) || Number(body.maxFiles) < 1 || Number(body.maxFiles) > 1000)) throw new RangeError("Sample size must be 1–1000 files");
    const asset = await this.#options.assets.get(assetId);
    if (asset.origin !== "user") throw new RangeError("Only private assets support derived repair");
    const runs = (await this.#options.runs.list()).filter((run) => run.assetId === assetId && run.backend === "warehouse" && run.status === "succeeded" && run.evidencePath && run.sourceSnapshotSha256);
    const run = body.scanRunId ? runs.find((run) => run.id === body.scanRunId) : runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (!run || !run.warehouseLayerId || !run.batchId || !run.coverage) throw new RangeError("No successful coverage scan with complete evidence identity");
    if (mode !== "moc" && run.coverage.mode !== "fits-wcs") throw new RangeError("Header replay requires an image coverage inventory");
    const history = await this.list();
    const existing = history.find((task) => task.assetId === assetId && task.scanRunId === run.id && task.mode === mode && task.maxFiles === body.maxFiles && ["queued", "running"].includes(task.status));
    if (existing) return existing;
    const headers = mode === "moc" ? undefined : history.find((task) => task.assetId === assetId && task.scanRunId === run.id
      && task.sourceSnapshotSha256 === run.sourceSnapshotSha256 && task.mode !== "moc" && task.maxFiles === body.maxFiles && task.jobName && task.outputPath);
    const task: DerivedRepair = { id: `derived-${randomUUID().replaceAll("-", "").slice(0, 24)}`, assetId, scanRunId: run.id, mode: mode as DerivedRepair["mode"],
      status: "queued", phase: "staging", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), sourceSnapshotSha256: run.sourceSnapshotSha256!,
      ...(body.maxFiles ? { maxFiles: Number(body.maxFiles) } : {}),
      ...(headers ? { jobName: headers.jobName, outputPath: headers.outputPath, companion: headers.companion, ...(mode === "positions" ? { phase: "indexing" as const } : {}) } : {}),
      processedFiles: 0, fileCount: run.fileCount ?? 0, pointCount: 0, coordinateErrors: 0, headerErrors: 0, indexedBytes: 0 };
    await this.#save(task); void this.poll(); return task;
  }
  start(): void { void this.poll(); this.#timer = setInterval(() => void this.poll(), 5000); }
  stop(): void { if (this.#timer) clearInterval(this.#timer); }
  async poll(): Promise<void> {
    if (this.#polling) return; this.#polling = true;
    try { for (const task of await this.list()) if (["queued", "running"].includes(task.status) && (!task.nextRetryAt || Date.parse(task.nextRetryAt) <= Date.now())) {
      try { await this.#advance(task); } catch (error) {
        task.error = error instanceof Error ? error.message : String(error);
        if (error instanceof RetryablePointIndexError) {
          task.status = "running"; task.retryAttempts = (task.retryAttempts ?? 0) + 1;
          task.nextRetryAt = new Date(Date.now() + Math.min(120_000, 5_000 * 2 ** Math.min(task.retryAttempts, 5))).toISOString();
        } else task.status = "failed";
        await this.#save(task);
      }
    } } finally { this.#polling = false; }
  }
  async #advance(task: DerivedRepair): Promise<void> {
    const run = (await this.#options.runs.list()).find((run) => run.id === task.scanRunId);
    if (!run || run.status !== "succeeded" || run.sourceSnapshotSha256 !== task.sourceSnapshotSha256) throw new Error("Original successful scan identity changed");
    const evidencePath = path.resolve(run.evidencePath!);
    const root = path.resolve(this.#options.evidenceRoot);
    if (!evidencePath.startsWith(root + path.sep)) throw new Error("Evidence is outside the private volume");
    task.status = "running";
    if (task.phase === "staging") { task.phase = task.mode === "positions" ? "headers" : "moc"; await this.#save(task); }
    if (task.phase === "moc") {
      const artifact = await this.#options.artifacts.importEvidence(evidencePath, { layerId: run.warehouseLayerId!, scanRunId: task.id,
        evidenceLayerId: run.warehouseLayerId!, evidenceScanRunId: run.batchId!, sourceSnapshotSha256: task.sourceSnapshotSha256,
        coverageRole: run.coverage?.coverageRole, dataOrigin: run.coverage?.dataOrigin, sourceTier: run.coverage?.sourceTier,
        precision: run.precision, maxOrder: run.maxOrder }, this.#options.mocCore ?? defaultMocCoreAdapter);
      task.mocStatus = artifact.status;
      if (artifact.status !== "ready") task.error = artifact.error;
      if (task.mode === "moc") { task.phase = "complete"; task.status = artifact.status === "ready" ? "succeeded" : "failed"; await this.#save(task); return; }
      task.phase = "headers"; await this.#save(task);
    }
    if (!task.jobName && !task.maxFiles && await stat(path.join(evidencePath, "position-headers.ndjson")).then((value) => value.size > 0).catch(() => false)) {
      task.companion = true; task.jobName = "companion"; task.outputPath = evidencePath; task.phase = "indexing"; await this.#save(task);
    }
    if (!task.jobName) {
      const inventory = await stageWarehouseInventory(evidencePath, path.join(root, "derived", "inventories", `${run.batchId}.ndjson`), {
        layerId: run.warehouseLayerId!, scanRunId: run.batchId!, sourceSnapshotSha256: task.sourceSnapshotSha256 });
      task.fileCount = inventory.fileCount;
      const job = await this.#options.warehouse.startPositionReplay(run, task.id, inventory, task.maxFiles);
      task.jobName = job.jobName; task.outputPath = job.outputPath; task.phase = "indexing"; await this.#save(task);
    }
    const checkpoint = task.companion ? { scanRunId: run.batchId, sourceSnapshotSha256: run.sourceSnapshotSha256, layerId: run.warehouseLayerId, processedFiles: run.fileCount, failedFiles: 0, outputBytes: (await stat(path.join(evidencePath, "position-headers.ndjson"))).size, phase: "SUCCEEDED" } : await readFile(path.join(task.outputPath!, "checkpoint.json"), "utf8").then((text) => JSON.parse(text) as Record<string, unknown>).catch(() => undefined);
    const jobState = task.companion ? "succeeded" : await this.#options.warehouse.positionReplayState(task.jobName);
    if (checkpoint) {
      if (checkpoint.scanRunId !== run.batchId || checkpoint.sourceSnapshotSha256 !== task.sourceSnapshotSha256 || checkpoint.layerId !== run.warehouseLayerId) throw new Error("Header checkpoint identity mismatch");
      task.processedFiles = Number(checkpoint.processedFiles); task.headerErrors = Number(checkpoint.failedFiles ?? 0);
      const committed = Number(checkpoint.outputBytes);
      if (committed > task.indexedBytes) await this.#indexBatch(task, run, committed);
      if (checkpoint.phase !== "RUNNING" && task.indexedBytes === committed) {
        task.phase = "complete"; task.status = checkpoint.phase === "FAILED" || task.pointCount === 0 ? "failed"
          : checkpoint.phase === "PARTIAL" || task.coordinateErrors > 0 || task.mocStatus && task.mocStatus !== "ready" ? "partial" : "succeeded";
      }
    }
    if (["failed", "missing"].includes(jobState) && task.phase !== "complete" && (!checkpoint || checkpoint.phase === "RUNNING")) { task.status = "failed"; task.error = `Metadata Job ${jobState}; committed points retained`; }
    await this.#save(task);
  }
  async #indexBatch(task: DerivedRepair, run: ConnectorIngestRunRecord, committed: number): Promise<void> {
    const input = createReadStream(path.join(task.outputPath!, task.companion ? "position-headers.ndjson" : "headers.ndjson"), { start: task.indexedBytes, end: committed - 1 });
    const reader = createInterface({ input, crlfDelay: Infinity });
    let bytes = 0, fileId: string | undefined; const records: unknown[] = [];
    try { for await (const line of reader) {
      const record = JSON.parse(line) as HeaderPoint;
      if (fileId !== record.file_id && bytes >= 8 * 1024 * 1024) break;
      fileId = record.file_id; records.push(record); bytes += Buffer.byteLength(line) + 1;
    } } finally { reader.close(); input.destroy(); }
    const converted = await convertPositionHeaders(records);
    const asset = await this.#options.assets.get(task.assetId);
    const sources = downloadedFileSources(await this.#options.downloads());
    const documents: LocalObjectIndexDocument[] = [];
    let coordinateErrors = 0;
    for (const value of converted) {
      if (value.error) { coordinateErrors++; continue; }
      documents.push(pointDocument(value as HeaderPoint, asset, run, fileSource(String(value.source_uri), sources)));
    }
    if (!task.maxFiles && documents.length) {
      try { await this.#options.points.ensureIndices(); await this.#options.points.bulk(documents); }
      catch (error) { if (retryableIndexError(error)) throw new RetryablePointIndexError(error instanceof Error ? error.message : String(error)); throw error; }
    }
    else if (task.maxFiles) await writeFile(path.join(task.outputPath!, "sample-points.ndjson"), converted.map((row) => JSON.stringify(row)).join("\n") + "\n");
    task.coordinateErrors += coordinateErrors; task.pointCount += documents.length; task.indexedBytes += bytes;
    delete task.nextRetryAt; delete task.retryAttempts;
    if (!task.mocStatus || task.mocStatus === "ready") delete task.error;
  }
  async #save(task: DerivedRepair): Promise<void> {
    await mkdir(this.#options.root, { recursive: true }); task.updatedAt = new Date().toISOString();
    const target = path.join(this.#options.root, `${task.id}.json`);
    await writeFile(`${target}.tmp`, `${JSON.stringify(task)}\n`); await rename(`${target}.tmp`, target);
  }
  async scopesForSources(sourceIds: string[]): Promise<SkyDataPointScope[]> {
    const jobs = await this.#options.downloads(); const assets = await this.#options.assets.list(); const runs = await this.#options.runs.list();
    const scopes: SkyDataPointScope[] = [];
    for (const job of jobs) if (job.outputConnectorId) for (const sourceId of sourceIds) if (job.transfer.some((file) => file.status === "verified" && file.sourceId === sourceId)) {
      for (const asset of assets) if (asset.origin === "user" && (asset.connectorIds?.includes(job.outputConnectorId) || asset.access.connectorId === job.outputConnectorId || asset.accesses?.some((access) => access.connectorId === job.outputConnectorId) || runs.some((run) => run.status === "succeeded" && run.connectorId === job.outputConnectorId && run.assetId === asset.id))) scopes.push({ assetId: asset.id, sourceId });
    }
    return [...new Map(scopes.map((scope) => [`${scope.assetId}:${scope.sourceId}`, scope])).values()];
  }
  async isIndexing(scopes: readonly SkyDataPointScope[]): Promise<boolean> {
    if (!scopes.length) return false;
    const assetIds = new Set(scopes.map((scope) => scope.assetId));
    return (await this.list()).some((task) => assetIds.has(task.assetId) && task.mode !== "moc" && !task.maxFiles && ["queued", "running"].includes(task.status));
  }
}
