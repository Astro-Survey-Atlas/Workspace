import { createHash } from "node:crypto";
import { mkdir, opendir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { iterateConnectorObjectPages, isExpiredListingCursor, type ConnectorRecord, type ConnectorRegistry } from "./connectors.js";
import type { ConnectorCredentialStore } from "./connector-credentials.js";
import type { ConnectorIngestRunCatalog, ConnectorIngestRunRecord } from "./connector-history.js";
import type { GenericScanInput } from "./scan-contract.js";
import { connectorScanPath } from "./scan-contract.js";
import type { LocalConnectorRootsPolicy } from "./local-connector-roots.js";
import type { WarehouseScanService, FrozenScanSelection, WarehouseTaskLogs } from "./warehouse-scan.js";
import type { UserMocArtifactStore } from "./user-moc-artifacts.js";
import { defaultMocCoreAdapter } from "./moc-core-adapter.js";

interface InventoryRow { sourceUri: string; fileName: string; parentUri: string; sizeBytes: number; lastModified?: string }
interface Shard { id: string; path: string; sha256: string; fileCount: number; runId?: string; attempt: number; positionsSubmitted?: boolean }
interface Batch {
  runId: string; connectorId: string; assetId: string; input: GenericScanInput; phase: "discovering" | "scanning" | "finalizing" | "failed" | "complete";
  warehouseLayerId?: string;
  shards: Shard[]; pending: InventoryRow[]; continuationToken?: string; discoveryComplete?: boolean; fileCount: number; sourceFingerprint: string;
  roster?: { path: string; sha256: string; fileCount: number }; ruleSha?: string; scopeSha?: string; merged?: boolean;
  maxFiles?: number; concurrency?: 1 | 2;
}
interface Options {
  root: string; enabled: boolean; warehouse: Pick<WarehouseScanService, "prepareConnectorScan" | "submitScan" | "taskLogs">;
  connectors: ConnectorRegistry; credentials: ConnectorCredentialStore; runs: ConnectorIngestRunCatalog;
  roots: LocalConnectorRootsPolicy; artifacts: Pick<UserMocArtifactStore, "importEvidence">;
  onCompleted: (assetId: string, runId: string) => Promise<unknown>;
}
const sha = (value: string): string => createHash("sha256").update(value).digest("hex");
const fingerprint = (connector: ConnectorRecord, input: GenericScanInput): string => sha(JSON.stringify([connector.config, input]));
const metadataLocked = (error: unknown): boolean => /\bSQLITE_(?:BUSY|LOCKED)\b|database (?:is )?(?:locked|busy)/i.test(error instanceof Error ? `${"code" in error ? error.code : ""} ${error.message}` : String(error));
export const SCANNER_JOB_CONCURRENCY = 2;
export const SCANNER_SHARD_FILES = 2000;

/** Namespace-local durable manifests. A shard is never rewritten after submission. */
export class WarehouseScanQueue {
  #batches = new Map<string, Batch>();
  #ticking = false;
  #timer?: ReturnType<typeof setInterval>;
  constructor(readonly options: Options) {}

  async initialize(): Promise<void> {
    if (!this.options.enabled) return;
    await mkdir(this.options.root, { recursive: true });
    for (const name of await readdir(this.options.root)) {
      if (!/^ingest-[a-z0-9-]+$/.test(name)) continue;
      const batch = await readFile(path.join(this.options.root, name, "batch.json"), "utf8")
        .then(text => JSON.parse(text) as Batch).catch(() => undefined);
      if (batch?.runId === name) this.#batches.set(batch.runId, batch);
    }
    this.#timer = setInterval(() => void this.tick(), 5000); this.#timer.unref();
    void this.tick();
  }
  stop(): void { if (this.#timer) clearInterval(this.#timer); }

  async submit(connectorId: string, input: { assetId?: string; relativePath?: string; maxFiles?: number; concurrency?: 1 | 2 } = {}, key?: string): Promise<ConnectorIngestRunRecord> {
    if (input.maxFiles !== undefined && (!Number.isSafeInteger(input.maxFiles) || input.maxFiles < 1 || input.maxFiles > 10000)) throw new RangeError("maxFiles must be 1–10000, or omitted for the full source");
    if (input.concurrency !== undefined && input.concurrency !== 1 && input.concurrency !== 2) throw new RangeError("concurrency must be 1 or 2");
    const prepared = await this.options.warehouse.prepareConnectorScan(connectorId, input.assetId, input.relativePath);
    const active = [...this.#batches.values()].find(batch => batch.connectorId === connectorId && batch.assetId === prepared.asset.id
      && ["discovering", "scanning", "finalizing"].includes(batch.phase));
    if (active) return (await this.options.runs.list()).find(run => run.id === active.runId)!;
    const { connector, asset } = prepared;
    const created = await this.options.runs.create(connector.locationKey, { connectorId, connectorName: connector.name, connectorKind: connector.kind,
      executor: "warehouse-batch", backend: "warehouse", taskKind: "user_coverage", assetId: asset.id, assetIds: [asset.id], assetName: asset.name,
      warehouseLayerId: `workspace-${asset.id}`, sourcePath: connectorScanPath(connector, prepared.input.path),
      status: "queued", fileCount: 0, processedFiles: 0, mocStatus: "pending", coverage: prepared.input.coverage }, key);
    if (!created.created && (this.#batches.has(created.run.id) || created.run.status === "succeeded")) return created.run;
    const batch: Batch = { runId: created.run.id, connectorId, assetId: asset.id, input: prepared.input, phase: "discovering", shards: [], pending: [],
      warehouseLayerId: `workspace-${asset.id}-batch-${created.run.id.slice("ingest-".length)}`,
      fileCount: 0, sourceFingerprint: fingerprint(connector, prepared.input), maxFiles: input.maxFiles, concurrency: input.concurrency };
    await this.#save(batch); this.#batches.set(batch.runId, batch);
    const run = await this.options.runs.update(batch.runId, { warehouseLayerId: batch.warehouseLayerId });
    void this.tick(); return run;
  }

  async retry(runId: string): Promise<ConnectorIngestRunRecord> {
    const batch = this.#batches.get(runId);
    if (!batch || batch.phase !== "failed") throw new RangeError("Only a failed batch can be retried");
    const runs = await this.options.runs.list();
    // Upgrade a rejected legacy batch without rewriting any successful partition.
    if (!batch.warehouseLayerId && !runs.some(run => run.parentRunId === runId && run.status !== "failed")) {
      batch.warehouseLayerId = `workspace-${batch.assetId}-batch-${runId.slice("ingest-".length)}`;
    }
    for (const shard of batch.shards) {
      if (shard.runId && runs.find(run => run.id === shard.runId)?.status === "failed") { shard.runId = undefined; shard.attempt++; }
    }
    batch.phase = batch.roster ? "scanning" : "discovering"; await this.#save(batch);
    const run = await this.options.runs.update(runId, { status: "queued", error: "", failedFiles: 0,
      ...(batch.warehouseLayerId ? { warehouseLayerId: batch.warehouseLayerId } : {}) }); void this.tick(); return run;
  }

  async taskLogs(connectorId: string, runId: string): Promise<WarehouseTaskLogs> {
    const batch = this.#batches.get(runId);
    if (!batch || batch.connectorId !== connectorId) throw new RangeError("Scan batch not found for this Connector");
    const runs = await this.options.runs.list();
    const children = batch.shards.map(shard => ({ shard, run: runs.find(run => run.id === shard.runId) }));
    const lines = [`批次 ${runId} · ${batch.phase} · ${batch.fileCount} 个文件`,
      ...children.map(({ shard, run }) => `${shard.id} · ${shard.fileCount} 文件 · ${run?.status ?? "等待提交"} · ${run?.id ?? ""}${run?.error ? ` · ${run.error}` : ""}`)];
    const selected = children.filter(value => value.run?.status === "failed" || value.run?.status === "running").slice(-2);
    for (const { run } of selected.length ? selected : children.slice(-2)) {
      if (!run) continue;
      const logs = await this.options.warehouse.taskLogs(connectorId, run.id);
      lines.push(`\n${run.id}\n${logs.text.slice(-12000) || logs.message || "尚无日志"}`);
    }
    return { runId, status: "available", text: lines.join("\n").slice(-30000), fetchedAt: new Date().toISOString() };
  }

  async tick(): Promise<void> {
    if (this.#ticking || !this.options.enabled) return;
    this.#ticking = true;
    try {
      let runs = await this.options.runs.list();
      let slots = Math.max(0, SCANNER_JOB_CONCURRENCY - runs.filter(run => run.backend === "warehouse" && run.executor !== "warehouse-batch"
        && ["queued", "running"].includes(run.status)).length);
      for (const batch of this.#batches.values()) {
        try {
          // Retained successful evidence is useful even when another shard or
          // the parent's metadata write failed. The callback is idempotent.
          await this.#submitPositions(batch, runs);
          const parent = runs.find(run => run.id === batch.runId);
          if (batch.phase === "failed" && parent?.error && metadataLocked(parent.error)) {
            batch.phase = batch.roster ? "scanning" : "discovering";
            await this.#save(batch);
          }
          if (!["discovering", "scanning", "finalizing"].includes(batch.phase)) continue;
          if (batch.phase === "discovering") await this.#discover(batch);
          let failed = 0, completed = 0, active = 0, processedFiles = 0, documents = 0;
          let batchSlots = Math.max(0, (batch.concurrency ?? 2) - runs.filter(run => run.parentRunId === batch.runId && ["queued", "running"].includes(run.status)).length);
          for (const shard of batch.shards) {
            // Reattach if Workspace stopped between submission and saving its binding.
            let run = runs.find(run => run.id === shard.runId) ?? (!shard.runId ? runs.find(run => run.parentRunId === batch.runId
              && run.partitionId === shard.id && run.status !== "failed") : undefined);
            if (run && shard.runId !== run.id) { shard.runId = run.id; await this.#save(batch); }
            if (!run && slots > 0 && batchSlots > 0) {
              const frozen: FrozenScanSelection = { parentRunId: batch.runId, partitionId: shard.id,
                layerId: batch.warehouseLayerId ?? `workspace-${batch.assetId}`,
                inventory: { path: shard.path, sha256: shard.sha256, fileCount: shard.fileCount },
                partition: { version: 1, scopeId: batch.runId, scopeSnapshotSha256: batch.scopeSha!, expectedPartitionCount: batch.shards.length,
                  partitionId: shard.id, ruleSnapshotSha256: batch.ruleSha!, rosterReference: batch.roster! } };
              run = await this.options.warehouse.submitScan(batch.connectorId, batch.input, `${batch.runId}:${shard.id}:${shard.attempt}`, frozen);
              shard.runId = run.id; await this.#save(batch);
              if (run.status === "queued" || run.status === "running") { slots--; batchSlots--; }
            }
            if (run?.status === "succeeded") { completed++; processedFiles += run.fileCount ?? 0; documents += run.documentCount ?? 0; }
            else if (run?.status === "failed") failed++;
            else if (run) active++;
          }
          await this.options.runs.update(batch.runId, { status: "running", error: "", fileCount: batch.fileCount, processedFiles, documentCount: documents,
            batchProgress: { completed, failed, total: batch.shards.length, active } });
          if (completed === batch.shards.length) {
            runs = await this.options.runs.list(); batch.phase = "finalizing"; await this.#save(batch);
            await this.#complete(batch, runs); batch.phase = "complete"; await this.#save(batch);
          } else if (failed && !active && !batch.shards.some(shard => !shard.runId)) {
            throw new Error(`${failed} 个分片失败；已完成分片已保留，可重试未完成分片。`);
          }
        } catch (error) {
          if (metadataLocked(error)) {
            console.warn("Scan batch will retry metadata contention", batch.runId);
            continue;
          }
          batch.phase = "failed"; await this.#save(batch);
          await this.options.runs.update(batch.runId, { status: "failed", error: error instanceof Error ? error.message : "Batch scan failed", completedAt: new Date().toISOString() });
        }
      }
    } catch (error) { console.error("Scan queue unavailable", error instanceof Error ? error.message : "unknown"); }
    finally { this.#ticking = false; }
  }

  async #submitPositions(batch: Batch, runs: ConnectorIngestRunRecord[]): Promise<void> {
    for (const shard of batch.shards) {
      if (shard.positionsSubmitted || !shard.runId) continue;
      const child = runs.find(run => run.id === shard.runId);
      if (child?.status !== "succeeded" || child.coverage?.mode !== "fits-wcs") continue;
      try {
        await this.options.onCompleted(batch.assetId, child.id);
        shard.positionsSubmitted = true;
        await this.#save(batch);
      } catch (error) {
        // A derived index outage must not discard a successful scientific scan
        // or prevent remaining immutable partitions from being submitted.
        shard.positionsSubmitted = false;
        console.warn("Shard positions will retry", child.id, error instanceof Error ? error.message : String(error));
      }
    }
  }

  async #save(batch: Batch): Promise<void> {
    const directory = path.join(this.options.root, batch.runId); await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "batch.json.tmp"), JSON.stringify(batch));
    await rename(path.join(directory, "batch.json.tmp"), path.join(directory, "batch.json"));
  }
  async #shard(batch: Batch): Promise<void> {
    if (!batch.pending.length) return;
    const id = `s${batch.shards.length.toString().padStart(6, "0")}`;
    const filename = path.join(this.options.root, batch.runId, `${id}.ndjson`);
    const text = batch.pending.map(row => `${JSON.stringify(row)}\n`).join("");
    await writeFile(`${filename}.tmp`, text); await rename(`${filename}.tmp`, filename);
    batch.shards.push({ id, path: filename, sha256: sha(text), fileCount: batch.pending.length, attempt: 0 }); batch.pending = [];
  }
  async #discover(batch: Batch): Promise<void> {
    const { connector, scannerRoot, input } = await this.options.warehouse.prepareConnectorScan(batch.connectorId, batch.assetId, batch.input.path);
    if (fingerprint(connector, input) !== batch.sourceFingerprint) throw new Error("Connector 或资产扫描配置已变化，请开始新的扫描。");
    const selected = connectorScanPath(connector, batch.input.path);
    const pattern = batch.input.coverage?.fileNamePattern ? new RegExp(batch.input.coverage.fileNamePattern) : undefined;
    const accept = async (row: InventoryRow) => {
      if (batch.maxFiles !== undefined && batch.fileCount >= batch.maxFiles) return;
      if (batch.input.allowedSuffixes?.length && !batch.input.allowedSuffixes.some(suffix => row.fileName.toLowerCase().endsWith(suffix.toLowerCase()))) return;
      if (pattern && !pattern.test(row.fileName)) return;
      batch.pending.push(row); batch.fileCount++;
      if (batch.pending.length >= SCANNER_SHARD_FILES) await this.#shard(batch);
    };
    if (!batch.discoveryComplete && connector.kind === "s3") {
      const credentials = connector.credentialRef && await this.options.credentials.get(connector.credentialRef);
      if (!credentials) throw new Error("Connector credentials unavailable");
      const prefix = selected.replace(/^s3:\/\/[^/]+\/?/, "").replace(/\/$/, "");
      const list = async () => {
        // Include a literal object selection, and exclude sibling prefixes.
        for await (const page of iterateConnectorObjectPages(connector, credentials, prefix, batch.continuationToken)) {
          for (const object of page.objects) {
            if (prefix && object.key !== prefix && !object.key.startsWith(`${prefix}/`)) continue;
            await accept({ sourceUri: `s3://${connector.config.bucket}/${object.key}`, fileName: path.posix.basename(object.key),
              parentUri: `s3://${connector.config.bucket}/${path.posix.dirname(object.key)}`, sizeBytes: object.size, lastModified: object.lastModified });
          }
          const capped = batch.maxFiles !== undefined && batch.fileCount >= batch.maxFiles;
          batch.continuationToken = capped ? undefined : page.continuationToken; batch.discoveryComplete = capped || !page.continuationToken;
          await this.#save(batch);
          await this.options.runs.update(batch.runId, { status: "running", fileCount: batch.fileCount });
          if (batch.discoveryComplete) break;
        }
      };
      try { await list(); }
      catch (error) {
        if (!batch.continuationToken || !isExpiredListingCursor(error)) throw error;
        batch.shards = []; batch.pending = []; batch.fileCount = 0; batch.continuationToken = undefined;
        await this.#save(batch); await list();
      }
    } else if (!batch.discoveryComplete && connector.kind === "local") {
      // Replace unpublished local shards after a restart; no Job can consume them yet.
      batch.shards = []; batch.pending = []; batch.fileCount = 0;
      const resolved = await this.options.roots.resolveReadableDirectory(selected).catch(() => this.options.roots.resolveReadableFile(selected));
      const details = await stat(resolved.fileSystemPath);
      const localRow = async (filename: string) => {
        const target = path.join(scannerRoot!, path.relative(resolved.fileSystemPath, filename));
        const details = await stat(filename);
        await accept({ sourceUri: pathToFileURL(target).href, fileName: path.basename(filename), parentUri: pathToFileURL(path.dirname(target)).href,
          sizeBytes: details.size, lastModified: details.mtime.toISOString() });
      };
      const walk = async (directory: string): Promise<void> => {
        for await (const entry of await opendir(directory)) {
          if (batch.maxFiles !== undefined && batch.fileCount >= batch.maxFiles) return;
          const filename = path.join(directory, entry.name);
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) await walk(filename);
          else if (entry.isFile()) await localRow(filename);
        }
      };
      if (details.isDirectory()) await walk(resolved.fileSystemPath); else if (details.isFile()) await localRow(resolved.fileSystemPath);
      batch.discoveryComplete = true; await this.#save(batch);
    }
    await this.#shard(batch);
    if (!batch.fileCount) throw new Error("所选来源中未找到匹配文件。");
    const roster = batch.shards.map(shard => ({ partitionId: shard.id, sourcePrefix: `inventory:${shard.sha256}` }));
    const text = JSON.stringify(roster), filename = path.join(this.options.root, batch.runId, "roster.json");
    await writeFile(`${filename}.tmp`, text); await rename(`${filename}.tmp`, filename);
    batch.roster = { path: filename, sha256: sha(text), fileCount: roster.length };
    batch.ruleSha = sha(JSON.stringify([batch.input, batch.maxFiles ?? null]));
    batch.scopeSha = sha(`${batch.ruleSha}\n${roster.map(row => `${row.partitionId}\n${row.sourcePrefix}`).join("\n")}`);
    batch.phase = "scanning"; await this.#save(batch);
  }

  async #complete(batch: Batch, runs: ConnectorIngestRunRecord[]): Promise<void> {
    const children = batch.shards.map(shard => runs.find(run => run.id === shard.runId)!);
    if (!batch.merged) {
      const snapshot = sha(children.map(run => run.sourceSnapshotSha256).join("\n"));
      const layerId = `workspace-${batch.assetId}`;
      const sources = await Promise.all(children.map(async run => {
        const summary = JSON.parse(await readFile(path.join(run.evidencePath!, "summary.json"), "utf8")) as { indexedLayerId: string };
        return { directory: run.evidencePath!, layerId: run.warehouseLayerId ?? layerId, scanRunId: run.batchId!, coverageLayerId: summary.indexedLayerId, sha256: run.sourceSnapshotSha256! };
      }));
      const artifact = await this.options.artifacts.importEvidence(this.options.root, { layerId, scanRunId: batch.runId,
        sourceSnapshotSha256: snapshot, coverageRole: batch.input.coverage?.coverageRole, maxOrder: batch.input.coverage?.maxOrder }, defaultMocCoreAdapter, sources);
      if (artifact.status !== "ready") throw new Error(artifact.error ?? "Coverage import failed");
      await this.options.runs.update(batch.runId, { mocStatus: "ready", artifactId: artifact.id, sourceSnapshotSha256: snapshot,
        availableOrders: artifact.availableOrders, precision: artifact.precision });
      batch.merged = true; await this.#save(batch);
    }
    await this.#submitPositions(batch, runs);
    await this.options.runs.update(batch.runId, { status: "succeeded", error: "", completedAt: new Date().toISOString() });
  }
}
