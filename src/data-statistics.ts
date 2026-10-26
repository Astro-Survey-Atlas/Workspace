import { createHash, randomUUID } from "node:crypto";
import { opendir, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { iterateConnectorObjects, type ConnectorRecord, type ConnectorRegistry } from "./connectors.js";
import type { ConnectorCredentialStore } from "./connector-credentials.js";
import type { DataAssetRecord, DataCatalogRegistry } from "./data-catalog.js";
import type { ConnectorIngestRunRecord } from "./connector-history.js";
import type { LocalConnectorRootsPolicy } from "./local-connector-roots.js";
import type { MetadataStore } from "./storage/types.js";
import { streamWarehouseEvidence } from "./warehouse-evidence-stream.js";
import type { DataAmount, DataStatisticsView, StatisticsEntry, StatisticsRefresh, StatisticsSnapshot } from "./data-statistics-types.js";

export type { DataStatisticsView, DataAmount, StatisticsRefresh } from "./data-statistics-types.js";

interface SourceFile { uri?: string; name?: string; size?: number; localPath?: string; objectKey?: string }
interface InventoryFile extends SourceFile { relativePath: string }
interface Options {
  store: MetadataStore;
  connectors: ConnectorRegistry;
  credentials: ConnectorCredentialStore;
  assets: DataCatalogRegistry;
  roots: LocalConnectorRootsPolicy;
  workspaceScanRoot: string;
  evidenceRoot?: string;
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
    const value = file.localPath ?? file.uri?.replace(/^(?:local|file):\/\//, "");
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
  #initialized = false;

  constructor(options: Options) { this.#options = options; }
  get busy(): boolean { return this.#job?.status === "running"; }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    this.#initialized = true;
    const saved = await this.#options.store.getImportMarker(REFRESH_MARKER);
    if (saved) {
      this.#job = JSON.parse(saved) as StatisticsRefresh;
      if (this.#job.status === "running") {
        this.#job.status = "failed";
        this.#job.phase = "服务已重启，请重新刷新；已有统计已保留";
        await this.#saveJob();
      }
    }
  }

  async view(): Promise<DataStatisticsView> {
    await this.initialize();
    const { store } = this.#options;
    const [connectors, assets, all, runs] = await Promise.all([
      this.#options.connectors.list(), this.#options.assets.list(), store.listStatisticsSnapshots(), store.listConnectorIngestRuns(),
    ]);
    const snapshots = new Map<string, StatisticsSnapshot>();
    const successful = runs.filter(run => run.status === "succeeded")
      .sort((left, right) => (right.completedAt ?? right.createdAt).localeCompare(left.completedAt ?? left.createdAt));
    for (const snapshot of all) {
      if (snapshots.has(snapshot.slot)) continue;
      const connector = connectors.find(candidate => candidate.id === snapshot.connectorId);
      const asset = snapshot.assetId ? assets.find(candidate => candidate.id === snapshot.assetId) : undefined;
      if (!connector || connector.status === "disabled" && snapshot.category === "accessible"
        || snapshot.assetId && (!asset || !assetLinkedToConnector(asset, connector))) continue;
      if (snapshot.fingerprint !== fingerprint(connector, asset)) continue;
      if (snapshot.category === "scanned") {
        const latest = successful.find(run => (run.connectorId === connector.id || !run.connectorId && run.locationKey === connector.locationKey)
          && (run.assetId === asset?.id || run.assetIds?.includes(asset?.id ?? "")));
        if (latest?.id !== snapshot.runId) continue;
      }
      snapshots.set(snapshot.slot, snapshot);
    }
    const amount = async (selected: Array<StatisticsSnapshot | undefined>, unsupported = false): Promise<DataAmount> => {
      const known = selected.filter((entry): entry is StatisticsSnapshot => Boolean(entry));
      const totals = await store.statisticsTotals(known.map(entry => entry.id));
      const missing = known.length !== selected.length;
      const partial = missing || known.some(entry => entry.state === "partial") || totals.unknownFiles > 0;
      return { ...totals, bytes: !partial && !unsupported ? totals.knownBytes : null,
        state: unsupported ? "unsupported" : !known.length && missing ? "unknown" : partial ? "partial" : "complete",
        ...(known.length ? { updatedAt: known.map(entry => entry.updatedAt).sort().at(-1) } : {}),
        ...(missing ? { message: "部分来源尚未统计" } : known.find(entry => entry.message)?.message ? { message: known.find(entry => entry.message)!.message } : {}),
      };
    };
    const scanSlots = (connector: ConnectorRecord, selectedAssets: DataAssetRecord[]) => selectedAssets.map(asset => snapshots.get(`scanned:${connector.id}:${asset.id}`));
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
    return { connectorCount: connectors.length, assetCount: assets.length,
      accessible: await amount(visibleConnectors.map(connector => snapshots.get(`accessible:${connector.id}`))),
      scanned: await amount(visibleConnectors.flatMap(connector => scanSlots(connector, assets.filter(asset => assetLinkedToConnector(asset, connector))))),
      connectors: connectorViews, assets: assetViews, ...(this.#job ? { refresh: structuredClone(this.#job) } : {}) };
  }

  async refresh(connectorIds?: string[]): Promise<StatisticsRefresh> {
    await this.initialize();
    if (this.busy) return structuredClone(this.#job!);
    const connectors = await this.#options.connectors.list();
    if (connectorIds && connectorIds.some(id => !connectors.some(connector => connector.id === id))) throw new RangeError("Unknown Connector in statistics refresh");
    const selected = connectors.filter(connector => connector.status !== "disabled" && connector.kind !== "jdbc" && (!connectorIds || connectorIds.includes(connector.id)));
    this.#job = { id: randomUUID(), status: "running", phase: "准备统计", processedFiles: 0, completedConnectors: 0,
      totalConnectors: selected.length, errors: [], startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await this.#saveJob();
    void this.#refresh(selected).catch(async () => {
      this.#job!.status = "failed"; this.#job!.phase = "统计中断，已有统计已保留";
      await this.#saveJob().catch(() => undefined);
    });
    return structuredClone(this.#job);
  }

  /** Called only after a successful scientific scan has committed its output. */
  async recordScan(run: ConnectorIngestRunRecord, files: SourceFile[]): Promise<void> {
    if (run.status !== "succeeded" || !run.connectorId || !run.assetId) return;
    const [connector, asset] = await Promise.all([this.#options.connectors.get(run.connectorId), this.#options.assets.get(run.assetId)]);
    const snapshot = this.#snapshot("scanned", connector, asset, run);
    try {
      for (let offset = 0; offset < files.length; offset += 500) {
        await this.#options.store.putStatisticsEntries(snapshot.id, files.slice(offset, offset + 500).map(file => ({ key: statisticsFileKey(connector, file), bytes: size(file.size) })));
      }
      await this.#publish(snapshot);
    } catch (error) { await this.#options.store.deleteStatisticsSnapshot(snapshot.id); throw error; }
  }

  async #refresh(connectors: ConnectorRecord[]): Promise<void> {
    const assets = await this.#options.assets.list();
    for (const connector of connectors) {
      const linked = assets.filter(asset => assetLinkedToConnector(asset, connector));
      this.#job!.phase = `列举元数据：${connector.name}`;
      await this.#saveJob();
      try { await this.#refreshConnector(connector, linked); }
      catch { this.#job!.errors.push({ connectorId: connector.id, message: "来源元数据读取失败；请检查目录权限、连接配置或凭据。上次统计已保留。" }); }
      this.#job!.phase = `汇总已有成功扫描：${connector.name}`;
      await this.#saveJob();
      try { await this.#backfill(connector, linked); }
      catch { this.#job!.errors.push({ connectorId: connector.id, message: "历史扫描清单回填失败；其他来源统计仍可使用。" }); }
      this.#job!.completedConnectors++;
      await this.#saveJob();
    }
    this.#job!.status = this.#job!.errors.length ? "partial" : "succeeded";
    this.#job!.phase = this.#job!.errors.length ? "部分来源统计失败，已有统计已保留" : "统计完成";
    await this.#saveJob();
  }

  async #refreshConnector(connector: ConnectorRecord, assets: DataAssetRecord[]): Promise<void> {
    const root = this.#snapshot("accessible", connector);
    const assetSnapshots = assets.map(asset => ({ asset, snapshot: this.#snapshot("asset", connector, asset) }));
    const batches = new Map<string, StatisticsEntry[]>();
    const flush = async () => {
      for (const [id, entries] of batches) { await this.#options.store.putStatisticsEntries(id, entries); }
      batches.clear();
    };
    let count = 0;
    try {
      for await (const file of this.#inventory(connector)) {
        const entry = { key: statisticsFileKey(connector, file), bytes: size(file.size) };
        for (const snapshot of [root, ...assetSnapshots.filter(candidate => assetMatchesStatisticsPath(candidate.asset, file.relativePath)).map(candidate => candidate.snapshot)]) {
          const list = batches.get(snapshot.id) ?? []; list.push(entry); batches.set(snapshot.id, list);
        }
        count++; this.#job!.processedFiles++;
        if (count % 500 === 0) { await flush(); await this.#saveJob(); }
      }
      await flush();
      await this.#options.store.transaction(async tx => {
        for (const snapshot of [root, ...assetSnapshots.map(entry => entry.snapshot)]) await tx.putStatisticsSnapshot(snapshot);
      });
      await this.#prune([root, ...assetSnapshots.map(entry => entry.snapshot)]);
    } catch (error) {
      for (const snapshot of [root, ...assetSnapshots.map(entry => entry.snapshot)]) await this.#options.store.deleteStatisticsSnapshot(snapshot.id);
      throw error;
    }
  }

  async *#inventory(connector: ConnectorRecord): AsyncGenerator<InventoryFile> {
    if (connector.kind === "local") {
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
    } else if (connector.kind === "s3") {
      const credentials = connector.credentialRef ? await this.#options.credentials.get(connector.credentialRef) : undefined;
      if (!credentials) throw new Error("Connector has no saved credentials");
      const prefix = (connector.config.prefix ?? "").replace(/^\/+|\/+$/g, "");
      for await (const object of iterateConnectorObjects(connector, credentials, prefix ? `${prefix}/` : "")) {
        yield { objectKey: object.key, size: object.size, relativePath: prefix ? object.key.slice(prefix.length + 1) : object.key };
      }
    }
  }

  async #backfill(connector: ConnectorRecord, assets: DataAssetRecord[]): Promise<void> {
    const runs = (await this.#options.store.listConnectorIngestRuns({ status: "succeeded" }))
      .filter(candidate => candidate.connectorId === connector.id || !candidate.connectorId && candidate.locationKey === connector.locationKey)
      .sort((left, right) => (right.completedAt ?? right.createdAt).localeCompare(left.completedAt ?? left.createdAt));
    for (const asset of assets) {
      const run = runs.find(candidate => candidate.assetId === asset.id || candidate.assetIds?.includes(asset.id));
      if (!run) continue;
      const previous = (await this.#options.store.listStatisticsSnapshots()).find(snapshot => snapshot.slot === `scanned:${connector.id}:${asset.id}` && snapshot.runId === run.id);
      if (previous) continue;
      const snapshot = this.#snapshot("scanned", connector, asset, run);
      let files = 0;
      let pending: StatisticsEntry[] = [];
      try {
        let filename: string;
        if (run.executor === "workspace" && /^[a-zA-Z0-9-]+$/.test(run.id)) filename = path.join(this.#options.workspaceScanRoot, `${run.id}.json`);
        else if (run.evidencePath && this.#options.evidenceRoot && path.resolve(run.evidencePath).startsWith(`${path.resolve(this.#options.evidenceRoot)}${path.sep}`)) filename = path.join(run.evidencePath, "normalized-scan.json");
        else if (run.executor === "local-csv" && run.sourcePath) {
          const resolved = await this.#options.roots.resolveReadableFile(run.sourcePath);
          const details = await stat(resolved.fileSystemPath);
          if (!details.isFile() || run.fileCount !== 1) throw new Error("Historical CSV source is unavailable");
          const source: SourceFile = { localPath: resolved.fileSystemPath, size: details.size };
          pending.push({ key: statisticsFileKey(connector, source), bytes: details.size });
          files = 1;
          await this.#options.store.putStatisticsEntries(snapshot.id, pending);
          pending = [];
          await this.#publish(snapshot);
          continue;
        }
        else continue;
        const metadata = await streamWarehouseEvidence(filename, (kind, row) => {
          if (kind !== "files") return;
          if (run.executor !== "workspace" && (row.layer_id !== run.warehouseLayerId || row.scan_run_id !== undefined && row.scan_run_id !== run.batchId)) throw new Error("Historical evidence identity mismatch");
          const source: SourceFile = { uri: String(row.uri ?? row.source_uri ?? ""), ...(typeof row.localPath === "string" ? { localPath: row.localPath } : {}),
            ...(typeof row.objectKey === "string" ? { objectKey: row.objectKey } : {}) };
          pending.push({ key: statisticsFileKey(connector, source), bytes: size(row.size ?? row.size_bytes) }); files++;
        }, async () => {
          if (pending.length) { await this.#options.store.putStatisticsEntries(snapshot.id, pending); pending = []; }
        });
        if (run.sourceSnapshotSha256 && run.executor !== "workspace" && (metadata.sourceSnapshot as { sha256?: string } | undefined)?.sha256 !== run.sourceSnapshotSha256) throw new Error("Historical source snapshot mismatch");
        if (!files || run.fileCount !== undefined && files !== run.fileCount) throw new Error("Historical inventory is incomplete");
        await this.#publish(snapshot);
      } catch {
        await this.#options.store.deleteStatisticsSnapshot(snapshot.id);
        this.#job!.errors.push({ connectorId: connector.id, message: `资产 ${asset.name} 的历史文件清单暂不可用；已扫描大小保持未统计。` });
      }
    }
  }

  #snapshot(category: StatisticsSnapshot["category"], connector: ConnectorRecord, asset?: DataAssetRecord, run?: ConnectorIngestRunRecord): StatisticsSnapshot {
    return { id: randomUUID(), slot: `${category}:${connector.id}${asset ? `:${asset.id}` : ""}`, category, connectorId: connector.id,
      ...(asset ? { assetId: asset.id } : {}), ...(run ? { runId: run.id, pointCount: run.pointCount } : {}),
      fingerprint: fingerprint(connector, asset), updatedAt: run?.completedAt ?? new Date().toISOString(), state: "complete" };
  }

  async #publish(snapshot: StatisticsSnapshot): Promise<void> {
    if (snapshot.category === "scanned" && snapshot.assetId && snapshot.runId) {
      const connector = await this.#options.connectors.get(snapshot.connectorId);
      const latest = (await this.#options.store.listConnectorIngestRuns({ status: "succeeded" }))
        .filter(run => (run.connectorId === connector.id || !run.connectorId && run.locationKey === connector.locationKey)
          && (run.assetId === snapshot.assetId || run.assetIds?.includes(snapshot.assetId!)))
        .sort((left, right) => (right.completedAt ?? right.createdAt).localeCompare(left.completedAt ?? left.createdAt))[0];
      if (latest?.id !== snapshot.runId) { await this.#options.store.deleteStatisticsSnapshot(snapshot.id); return; }
    }
    await this.#options.store.putStatisticsSnapshot(snapshot);
    await this.#prune([snapshot]);
  }

  async #prune(current: StatisticsSnapshot[]): Promise<void> {
    for (const snapshot of await this.#options.store.listStatisticsSnapshots()) {
      if (current.some(entry => entry.slot === snapshot.slot && entry.id !== snapshot.id)) await this.#options.store.deleteStatisticsSnapshot(snapshot.id);
    }
  }

  async #saveJob(): Promise<void> {
    this.#job!.updatedAt = new Date().toISOString();
    await this.#options.store.setImportMarker(REFRESH_MARKER, JSON.stringify(this.#job));
  }
}
