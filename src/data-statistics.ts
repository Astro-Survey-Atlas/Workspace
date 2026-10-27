import { createHash, randomUUID } from "node:crypto";
import { opendir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { iterateConnectorObjectPages, isExpiredListingCursor, type ConnectorRecord, type ConnectorRegistry } from "./connectors.js";
import type { ConnectorCredentialStore } from "./connector-credentials.js";
import type { DataAssetRecord, DataCatalogRegistry } from "./data-catalog.js";
import type { ConnectorIngestRunRecord } from "./connector-history.js";
import type { LocalConnectorRootsPolicy } from "./local-connector-roots.js";
import type { MetadataStore } from "./storage/types.js";
import { readSuccessfulScanInventory } from "./scan-inventory.js";
import type { DataAmount, DataStatisticsView, StatisticsEntry, StatisticsRefresh, StatisticsSnapshot, StatisticsTotals } from "./data-statistics-types.js";

export type { DataStatisticsView, DataAmount, StatisticsRefresh } from "./data-statistics-types.js";

interface SourceFile { uri?: string; name?: string; size?: number; localPath?: string; objectKey?: string }
interface InventoryFile extends SourceFile { relativePath: string }
interface Options {
  store: MetadataStore;
  statisticsStore?: MetadataStore;
  connectors: ConnectorRegistry;
  credentials: ConnectorCredentialStore;
  assets: DataCatalogRegistry;
  roots: LocalConnectorRootsPolicy;
  workspaceScanRoot: string;
  evidenceRoot?: string;
  checkpoint?: (force?: boolean) => Promise<void>;
}

const REFRESH_MARKER = "data-statistics-refresh-v1";
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const size = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

export function assetLinkedToConnector(asset: DataAssetRecord, connector: ConnectorRecord): boolean {
  return Boolean(asset.connectorIds?.includes(connector.id) || asset.connectorLocationKeys?.includes(connector.locationKey)
    || [asset.access, ...(asset.accesses ?? [])].some(access => access.connectorId === connector.id || access.uri === connector.locationKey));
}

export function assetMatchesStatisticsPath(asset: DataAssetRecord, relativePath: string): boolean {
  const selected = asset.sourceRelativePath?.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (selected && relativePath !== selected && !relativePath.startsWith(`${selected}/`)) return false;
  const format = asset.scanSpec?.format ?? ((asset.kind === "image" || asset.kind === "cube") ? "fits" : asset.access.format.toLowerCase());
  if (format === "csv" && !/\.csv$/i.test(relativePath)) return false;
  if (format === "fits" && !/\.(fits?|fits\.gz)$/i.test(relativePath)) return false;
  const pattern = asset.scanSpec?.format === "fits" ? asset.scanSpec.fileNamePattern : asset.warehouseScanSpec?.fileNamePattern;
  return !pattern || new RegExp(pattern).test(path.posix.basename(relativePath));
}

function fingerprint(connector: ConnectorRecord, asset?: DataAssetRecord): string {
  return digest([connector.kind, Object.entries(connector.config).sort(([a], [b]) => a.localeCompare(b)),
    asset ? [asset.sourceRelativePath, asset.scanSpec, asset.warehouseScanSpec, asset.kind, asset.access.format] : null]);
}

/** Location identity deliberately excludes the connector/prefix and the scan ID. */
export function statisticsFileKey(connector: ConnectorRecord, file: SourceFile): string {
  if (connector.kind === "local") {
    const value = file.localPath ?? (file.uri?.startsWith("file:") ? fileURLToPath(file.uri) : file.uri?.replace(/^local:\/\//, ""));
    if (!value || !path.isAbsolute(value)) throw new Error("Scan file has no absolute local location");
    return digest(["local", path.normalize(value)]);
  }
  const uri = file.uri?.match(/^(?:s3|oss):\/\/[^/]+\/(.*)$/);
  const key = file.objectKey ?? uri?.[1];
  if (!key) throw new Error("Scan file has no object-store key");
  const endpoint = (connector.config.endpoint ?? "").replace(/\/+$/, "").toLowerCase();
  return digest(["s3", endpoint, connector.config.bucket, key]);
}

export class DataStatisticsModule {
  readonly #options: Options;
  #job?: StatisticsRefresh;
  readonly #statistics: MetadataStore;
  #cached?: { at: number; value: DataStatisticsView };
  #completeTotals = new Map<string, Promise<StatisticsTotals>>();
  #initializing?: Promise<void>;

  constructor(options: Options) { this.#options = options; this.#statistics = options.statisticsStore ?? options.store; }
  get busy(): boolean { return this.#job?.status === "running"; }

  async initialize(): Promise<void> {
    this.#initializing ??= (async () => {
      const saved = await this.#statistics.getImportMarker(REFRESH_MARKER);
      if (saved) this.#job = JSON.parse(saved) as StatisticsRefresh;
      if (this.#job?.kind === "history" && !this.#job.historyProgress) this.#job.processedFiles = 0;
      if (this.#job?.status === "running") {
        const connectors = (await this.#options.connectors.list()).filter(connector => this.#job!.connectorIds?.includes(connector.id));
        void this.#runRefresh(connectors).catch(error => this.#failed(error));
      }
    })();
    await this.#initializing;
  }

  async view(): Promise<DataStatisticsView> {
    await this.initialize();
    if (this.#cached && Date.now() - this.#cached.at < 5000) {
      return { ...structuredClone(this.#cached.value), ...(this.#job ? { refresh: structuredClone(this.#job) } : {}) };
    }
    const { store } = this.#options;
    const [connectors, assets, all, runs] = await Promise.all([
      this.#options.connectors.list(), this.#options.assets.list(), this.#statistics.listStatisticsSnapshots(), store.listConnectorIngestRuns(),
    ]);
    const snapshots = new Map<string, StatisticsSnapshot>();
    const successful = runs.filter(run => run.status === "succeeded" && run.executor !== "warehouse-batch")
      .sort((left, right) => (right.completedAt ?? right.createdAt).localeCompare(left.completedAt ?? left.createdAt));
    for (const snapshot of all) {
      if (snapshot.category === "workload") continue;
      const chosen = snapshots.get(snapshot.slot);
      if (chosen && (chosen.state === "complete" || snapshot.state !== "complete")) continue;
      const connector = connectors.find(candidate => candidate.id === snapshot.connectorId);
      const asset = snapshot.assetId ? assets.find(candidate => candidate.id === snapshot.assetId) : undefined;
      if (!connector || connector.status === "disabled" && snapshot.category === "accessible"
        || snapshot.assetId && (!asset || !assetLinkedToConnector(asset, connector))) continue;
      if (snapshot.fingerprint !== fingerprint(connector, asset)) continue;
      snapshots.set(snapshot.slot, snapshot);
    }
    const viewTotals = new Map<string, Promise<StatisticsTotals>>();
    const amount = async (selected: Array<StatisticsSnapshot | undefined>, unsupported = false): Promise<DataAmount> => {
      const known = selected.filter((entry): entry is StatisticsSnapshot => Boolean(entry));
      const ids = [...new Set(known.map(entry => entry.id))].sort(), key = JSON.stringify(ids);
      // Complete snapshots are immutable; partial snapshots are reused only
      // within this view so an advancing inventory always publishes fresh totals.
      const cache = known.every(entry => entry.state === "complete") ? this.#completeTotals : viewTotals;
      let pending = cache.get(key);
      if (!pending) {
        pending = this.#statistics.statisticsTotals(ids).catch(error => { cache.delete(key); throw error; });
        cache.set(key, pending);
        if (cache === this.#completeTotals && cache.size > 64) cache.delete(cache.keys().next().value!);
      }
      const totals = await pending;
      const missing = known.length !== selected.length;
      const partial = missing || known.some(entry => entry.state === "partial") || totals.unknownFiles > 0;
      return { ...totals, bytes: !partial && !unsupported ? totals.knownBytes : null,
        state: unsupported ? "unsupported" : !known.length && missing ? "unknown" : partial ? "partial" : "complete",
        ...(known.length ? { updatedAt: known.map(entry => entry.updatedAt).sort().at(-1) } : {}),
        ...(missing ? { message: "部分来源尚未统计" } : known.find(entry => entry.message)?.message ? { message: known.find(entry => entry.message)!.message } : {}),
      };
    };
    const scanSlots = (connector: ConnectorRecord, selectedAssets: DataAssetRecord[]) => selectedAssets.flatMap(asset => {
      // A new family becomes current only after its complete parent succeeds.
      const latest = runs.filter(run => run.status === "succeeded" && !run.parentRunId
        && (run.connectorId === connector.id || !run.connectorId && run.locationKey === connector.locationKey)
        && (run.assetId === asset.id || run.assetIds?.includes(asset.id)))
        .sort((left, right) => (right.completedAt ?? right.createdAt).localeCompare(left.completedAt ?? left.createdAt))[0];
      if (!latest) return [undefined];
      const expected = latest.executor === "warehouse-batch"
        ? successful.filter(run => run.parentRunId === latest.id).filter((run, index, selected) => selected.findIndex(other => other.partitionId === run.partitionId) === index)
        : [latest];
      const selected = expected.map(run => [...snapshots.values()].find(snapshot => snapshot.category === "scanned" && snapshot.runId === run.id));
      if (!selected.length || latest.batchProgress && selected.length < latest.batchProgress.total) selected.push(undefined);
      return selected;
    });
    const visibleConnectors = connectors.filter(connector => connector.status !== "disabled");
    const connectorViews: DataStatisticsView["connectors"] = [];
    for (const connector of visibleConnectors) {
      const linked = assets.filter(asset => assetLinkedToConnector(asset, connector));
      const unsupported = connector.kind === "jdbc";
      connectorViews.push({ connectorId: connector.id, name: connector.name, kind: connector.kind, assetCount: linked.length,
        accessible: await amount([snapshots.get(`accessible:${connector.id}`)], unsupported),
        scanned: await amount(scanSlots(connector, linked), unsupported),
        ...(this.#job?.errors.find(error => error.connectorId === connector.id) ? { error: this.#job.errors.find(error => error.connectorId === connector.id)!.message } : {}),
      });
    }
    const assetViews: DataStatisticsView["assets"] = [];
    for (const asset of assets) {
      const linked = visibleConnectors.filter(connector => assetLinkedToConnector(asset, connector));
      const sources = [];
      for (const connector of linked) sources.push({ connectorId: connector.id, name: connector.name,
        size: await amount([snapshots.get(`asset:${connector.id}:${asset.id}`)], connector.kind === "jdbc"),
        connectorTotal: connectorViews.find(entry => entry.connectorId === connector.id)!.accessible });
      assetViews.push({ assetId: asset.id, sources,
        size: await amount(linked.length ? linked.map(connector => snapshots.get(`asset:${connector.id}:${asset.id}`)) : [undefined]),
        connectorTotal: await amount(linked.length ? linked.map(connector => snapshots.get(`accessible:${connector.id}`)) : [undefined]),
      });
    }
    const receipts = all.filter(snapshot => snapshot.category === "workload" && snapshot.workload);
    const workload = receipts.reduce((total, receipt) => ({ files: total.files + receipt.workload!.files,
      knownBytes: total.knownBytes + BigInt(receipt.workload!.knownBytes), unknownFiles: total.unknownFiles + receipt.workload!.unknownFiles }),
      { files: 0, knownBytes: 0n, unknownFiles: 0 });
    const missing = successful.some(run => !receipts.some(receipt => receipt.id === this.#receiptId(run)));
    const value: DataStatisticsView = { connectorCount: connectors.length, assetCount: assets.length,
      accessible: await amount(visibleConnectors.map(connector => snapshots.get(`accessible:${connector.id}`))),
      scanned: await amount(visibleConnectors.flatMap(connector => scanSlots(connector, assets.filter(asset => assetLinkedToConnector(asset, connector))))),
      cumulativeScanned: { files: workload.files, knownBytes: workload.knownBytes.toString(),
        bytes: missing || workload.unknownFiles ? null : workload.knownBytes.toString(), unknownFiles: workload.unknownFiles,
        state: missing ? receipts.length ? "partial" : "unknown" : workload.unknownFiles ? "partial" : "complete",
        ...(receipts.length ? { updatedAt: receipts.map(receipt => receipt.updatedAt).sort().at(-1) } : {}) },
      connectors: connectorViews, assets: assetViews, ...(this.#job ? { refresh: structuredClone(this.#job) } : {}) };
    this.#cached = { at: Date.now(), value };
    return structuredClone(value);
  }

  async refresh(connectorIds?: string[], kind: "inventory" | "history" = "inventory"): Promise<StatisticsRefresh> {
    await this.initialize();
    if (this.busy) return structuredClone(this.#job!);
    const connectors = await this.#options.connectors.list();
    if (connectorIds && connectorIds.some(id => !connectors.some(connector => connector.id === id))) throw new RangeError("Unknown Connector in statistics refresh");
    const selected = connectors.filter(connector => connector.status !== "disabled" && connector.kind !== "jdbc" && (!connectorIds || connectorIds.includes(connector.id)));
    this.#job = { id: randomUUID(), kind, connectorIds: selected.map(connector => connector.id), completedConnectorIds: [],
      status: "running", phase: "汇总已有成功扫描", processedFiles: 0, completedConnectors: 0,
      totalConnectors: selected.length, errors: [], startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await this.#saveJob(true);
    void this.#runRefresh(selected).catch(error => this.#failed(error));
    return structuredClone(this.#job);
  }

  async #failed(error: unknown): Promise<void> {
    this.#job!.status = "failed"; this.#job!.phase = "统计中断；已保存结果和进度";
    console.error("Statistics refresh failed", error instanceof Error ? error.message : "unknown");
    await this.#saveJob().catch(() => undefined);
  }

  /** A receipt is committed only after the complete successful inventory validates. */
  async recordScan(run: ConnectorIngestRunRecord, files: SourceFile[]): Promise<void> {
    if (run.status !== "succeeded" || !run.connectorId || !run.assetId) return;
    const [connector, asset] = await Promise.all([this.#options.connectors.get(run.connectorId), this.#options.assets.get(run.assetId)]);
    const snapshot = this.#snapshot("scanned", connector, asset, run);
    let knownBytes = 0n, unknownFiles = 0;
    try {
      for (let offset = 0; offset < files.length; offset += 1000) {
        const entries = files.slice(offset, offset + 1000).map(file => {
          const bytes = size(file.size); if (bytes === null) unknownFiles++; else knownBytes += BigInt(bytes);
          return { key: statisticsFileKey(connector, file), bytes };
        });
        await this.#statistics.putStatisticsEntries(snapshot.id, entries);
      }
      await this.#receipt(run, connector, files.length, knownBytes, unknownFiles);
      await this.#publish(snapshot);
    } catch (error) { await this.#statistics.deleteStatisticsSnapshot(snapshot.id); throw error; }
  }

  async #runRefresh(connectors: ConnectorRecord[]): Promise<void> {
    const assets = await this.#options.assets.list();
    // Historical results never wait behind an expensive source enumeration.
    for (const connector of connectors) {
      this.#job!.phase = `汇总已有成功扫描：${connector.name}`;
      await this.#saveJob();
      await this.#backfill(connector, assets.filter(asset => assetLinkedToConnector(asset, connector)));
    }
    for (const connector of connectors) {
      if (this.#job!.completedConnectorIds?.includes(connector.id)) continue;
      if (this.#job!.kind !== "history") {
        this.#job!.phase = `列举元数据：${connector.name}`;
        await this.#saveJob();
        try { await this.#refreshConnector(connector, assets.filter(asset => assetLinkedToConnector(asset, connector))); }
        catch {
          this.#job!.errors.push({ connectorId: connector.id, message: "来源元数据读取失败；上次完整统计和本轮进度已保留。" });
        }
      }
      this.#job!.completedConnectorIds ??= [];
      this.#job!.completedConnectorIds.push(connector.id);
      this.#job!.completedConnectors = this.#job!.completedConnectorIds.length;
      await this.#saveJob();
    }
    this.#job!.status = this.#job!.errors.length ? "partial" : "succeeded";
    this.#job!.phase = this.#job!.errors.length ? "部分来源统计失败，已有统计已保留" : "统计完成";
    await this.#saveJob();
  }

  async #refreshConnector(connector: ConnectorRecord, assets: DataAssetRecord[]): Promise<void> {
    const previous = this.#job!.checkpoint;
    const reuse = connector.kind === "s3" && previous?.connectorId === connector.id && previous.fingerprint === fingerprint(connector)
      && previous.snapshots.length === assets.length + 1 && assets.every(asset => previous.snapshots.some(snapshot => snapshot.assetId === asset.id && snapshot.fingerprint === fingerprint(connector, asset)));
    const snapshots = reuse ? previous.snapshots : [this.#snapshot("accessible", connector), ...assets.map(asset => this.#snapshot("asset", connector, asset))];
    const root = snapshots[0]!;
    const assetSnapshots = assets.map(asset => ({ asset, snapshot: snapshots.find(snapshot => snapshot.assetId === asset.id)! })).filter(entry => entry.snapshot);
    let processed = reuse ? previous.processedFiles : 0;
    const persist = async (files: InventoryFile[], continuationToken?: string, complete = false) => {
      await this.#statistics.transaction(async tx => {
        const batches = new Map<string, StatisticsEntry[]>();
        for (const file of files) {
          const entry = { key: statisticsFileKey(connector, file), bytes: size(file.size) };
          for (const snapshot of [root, ...assetSnapshots.filter(candidate => assetMatchesStatisticsPath(candidate.asset, file.relativePath)).map(candidate => candidate.snapshot)]) {
            const entries = batches.get(snapshot.id) ?? []; entries.push(entry); batches.set(snapshot.id, entries);
          }
        }
        for (const [id, entries] of batches) await tx.putStatisticsEntries(id, entries);
        processed += files.length;
        this.#job!.processedFiles += files.length;
        for (const snapshot of snapshots) {
          snapshot.state = complete ? "complete" : "partial";
          snapshot.updatedAt = new Date().toISOString();
          await tx.putStatisticsSnapshot(snapshot);
        }
        this.#job!.checkpoint = complete ? undefined : { connectorId: connector.id, fingerprint: fingerprint(connector), snapshots,
          continuationToken, processedFiles: processed };
        this.#job!.updatedAt = new Date().toISOString();
        await tx.setImportMarker(REFRESH_MARKER, JSON.stringify(this.#job));
      });
      this.#cached = undefined;
      await this.#options.checkpoint?.(complete);
    };
    if (connector.kind === "s3") {
      const credentials = connector.credentialRef ? await this.#options.credentials.get(connector.credentialRef) : undefined;
      if (!credentials) throw new Error("Connector has no saved credentials");
      const prefix = (connector.config.prefix ?? "").replace(/^\/+|\/+$/g, "");
      try {
        for await (const page of iterateConnectorObjectPages(connector, credentials, prefix ? `${prefix}/` : "", reuse ? previous.continuationToken : undefined)) {
          await persist(page.objects.map(object => ({ objectKey: object.key, size: object.size,
            relativePath: prefix ? object.key.slice(prefix.length + 1) : object.key })), page.continuationToken, !page.continuationToken);
        }
      } catch (error) {
        if (!reuse || !previous.continuationToken || !isExpiredListingCursor(error)) throw error;
        for (const snapshot of snapshots) await this.#statistics.deleteStatisticsSnapshot(snapshot.id);
        this.#job!.processedFiles -= processed;
        this.#job!.checkpoint = undefined;
        await this.#saveJob();
        return this.#refreshConnector(connector, assets);
      }
    } else {
      let pending: InventoryFile[] = [];
      for await (const file of this.#localInventory(connector)) {
        pending.push(file);
        if (pending.length >= 1000) { await persist(pending); pending = []; }
      }
      await persist(pending, undefined, true);
    }
    await this.#prune(snapshots);
  }

  async *#localInventory(connector: ConnectorRecord): AsyncGenerator<InventoryFile> {
    const root = await this.#options.roots.resolveReadableDirectory(connector.config.rootPath!);
    const walk = async function* (directory: string, relative: string): AsyncGenerator<InventoryFile> {
      const entries = await opendir(directory);
      for await (const entry of entries) {
        const absolute = path.join(directory, entry.name);
        const selected = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) yield* walk(absolute, selected);
        else if (entry.isFile()) yield { relativePath: selected, localPath: await realpath(absolute), size: (await stat(absolute)).size };
      }
    };
    yield* walk(root.fileSystemPath, "");
  }

  async #backfill(connector: ConnectorRecord, assets: DataAssetRecord[]): Promise<void> {
    const runs = (await this.#options.store.listConnectorIngestRuns({ status: "succeeded" }))
      .filter(candidate => candidate.executor !== "warehouse-batch" && (candidate.connectorId === connector.id || !candidate.connectorId && candidate.locationKey === connector.locationKey))
      .sort((left, right) => (right.completedAt ?? right.createdAt).localeCompare(left.completedAt ?? left.createdAt));
    for (const run of runs) {
      const asset = assets.find(asset => run.assetId === asset.id || run.assetIds?.includes(asset.id));
      if (!asset) continue;
      const existing = await this.#statistics.listStatisticsSnapshots();
      const isLatest = runs.find(candidate => (!run.partitionId || candidate.logicalRunId === run.logicalRunId) && candidate.partitionId === run.partitionId && (candidate.assetId === asset.id || candidate.assetIds?.includes(asset.id)))?.id === run.id;
      if (existing.some(snapshot => snapshot.id === this.#receiptId(run))
        && (!isLatest || existing.some(snapshot => snapshot.category === "scanned" && snapshot.runId === run.id))) continue;
      const snapshot = this.#snapshot("scanned", connector, asset, run);
      let files = 0, knownBytes = 0n, unknownFiles = 0;
      let pending: StatisticsEntry[] = [];
      const accept = (file: SourceFile) => {
        const bytes = size(file.size); if (bytes === null) unknownFiles++; else knownBytes += BigInt(bytes);
        pending.push({ key: statisticsFileKey(connector, file), bytes }); files++;
      };
      const flush = async () => {
        if (pending.length) { await this.#statistics.putStatisticsEntries(snapshot.id, pending); pending = []; }
        const progress = this.#job!.historyProgress ??= {};
        this.#job!.processedFiles += Math.max(0, files - (progress[run.id] ?? 0));
        progress[run.id] = Math.max(files, progress[run.id] ?? 0);
      };
      try {
        if (run.executor === "local-csv" && run.sourcePath) {
          const resolved = await this.#options.roots.resolveReadableFile(run.sourcePath);
          const details = await stat(resolved.fileSystemPath);
          if (!details.isFile() || run.fileCount !== 1) throw new Error("Historical CSV source is unavailable");
          accept({ localPath: resolved.fileSystemPath, size: details.size }); await flush();
        } else {
          await readSuccessfulScanInventory(run, this.#options, accept, async () => {
            if (pending.length < 10000) return;
            await flush();
            this.#job!.phase = `汇总已有成功扫描：${connector.name} · 已读取 ${files.toLocaleString()} 个历史文件`;
            await this.#saveJob();
          });
          await flush();
        }
        await this.#receipt(run, connector, files, knownBytes, unknownFiles);
        if (isLatest) await this.#publish(snapshot);
        else await this.#statistics.deleteStatisticsSnapshot(snapshot.id);
        this.#cached = undefined;
      } catch (error) {
        await this.#statistics.deleteStatisticsSnapshot(snapshot.id);
        console.error(`Statistics history ${run.id}:`, error instanceof Error ? error.message : "unknown");
        this.#job!.errors.push({ connectorId: connector.id, message: `资产 ${asset.name} 的历史清单未通过校验；扫描大小尚未统计。` });
      }
    }
  }

  #receiptId(run: ConnectorIngestRunRecord): string {
    return `workload-${digest([run.logicalRunId ?? run.id, run.partitionId ?? "whole"])}`;
  }

  async #receipt(run: ConnectorIngestRunRecord, connector: ConnectorRecord, files: number, knownBytes: bigint, unknownFiles: number): Promise<void> {
    const id = this.#receiptId(run);
    const existing = (await this.#statistics.listStatisticsSnapshots()).find(snapshot => snapshot.id === id);
    if (existing?.workload && (existing.workload.files !== files || existing.workload.knownBytes !== knownBytes.toString() || existing.workload.unknownFiles !== unknownFiles)) {
      throw new Error("A committed logical scan receipt cannot change its source size");
    }
    await this.#statistics.putStatisticsSnapshot({ ...this.#snapshot("workload", connector, undefined, run), id, slot: id,
      workload: { files, knownBytes: knownBytes.toString(), unknownFiles } });
    this.#cached = undefined;
  }

  #snapshot(category: StatisticsSnapshot["category"], connector: ConnectorRecord, asset?: DataAssetRecord, run?: ConnectorIngestRunRecord): StatisticsSnapshot {
    return { id: randomUUID(), slot: `${category}:${connector.id}${asset ? `:${asset.id}` : ""}${category === "scanned" && run?.partitionId ? `:${run.logicalRunId ?? run.parentRunId ?? run.id}:${run.partitionId}` : ""}`, category, connectorId: connector.id,
      ...(asset ? { assetId: asset.id } : {}), ...(run ? { runId: run.id, pointCount: run.pointCount } : {}),
      fingerprint: fingerprint(connector, asset), updatedAt: run?.completedAt ?? new Date().toISOString(), state: "complete" };
  }

  async #publish(snapshot: StatisticsSnapshot): Promise<void> {
    if (snapshot.category === "scanned" && snapshot.assetId && snapshot.runId) {
      const connector = await this.#options.connectors.get(snapshot.connectorId);
      const owner = (await this.#options.store.listConnectorIngestRuns({ status: "succeeded" })).find(run => run.id === snapshot.runId);
      const latest = (await this.#options.store.listConnectorIngestRuns({ status: "succeeded" }))
        .filter(run => (run.connectorId === connector.id || !run.connectorId && run.locationKey === connector.locationKey)
          && (run.assetId === snapshot.assetId || run.assetIds?.includes(snapshot.assetId!)) && run.executor !== "warehouse-batch"
          && run.partitionId === owner?.partitionId && (!owner?.partitionId || run.logicalRunId === owner.logicalRunId))
        .sort((left, right) => (right.completedAt ?? right.createdAt).localeCompare(left.completedAt ?? left.createdAt))[0];
      if (latest?.id !== snapshot.runId) { await this.#statistics.deleteStatisticsSnapshot(snapshot.id); return; }
    }
    await this.#statistics.putStatisticsSnapshot(snapshot);
    await this.#prune([snapshot]);
  }

  async #prune(current: StatisticsSnapshot[]): Promise<void> {
    for (const snapshot of await this.#statistics.listStatisticsSnapshots()) {
      if (snapshot.category !== "workload" && current.some(entry => entry.state === "complete" && entry.slot === snapshot.slot && entry.id !== snapshot.id)) await this.#statistics.deleteStatisticsSnapshot(snapshot.id);
    }
  }

  async #saveJob(force = false): Promise<void> {
    this.#cached = undefined;
    this.#job!.updatedAt = new Date().toISOString();
    await this.#statistics.setImportMarker(REFRESH_MARKER, JSON.stringify(this.#job));
    await this.#options.checkpoint?.(force || this.#job!.status !== "running");
  }
}
