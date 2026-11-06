import { randomUUID } from "node:crypto";
import type { MetadataStore } from "./storage/types.js";
import type { ConnectorIngestRunRecord } from "./connector-history.js";
import type { DataAmount, DataStatisticsView, StatisticsRefresh } from "./data-statistics-types.js";

const unknown = (): DataAmount => ({ files: 0, knownBytes: 0, unknownFiles: 0, bytes: null, state: "unknown",
  message: "未枚举数据源；这里只展示已完成扫描的摘要" });
function amount(runs: ConnectorIngestRunRecord[]): DataAmount {
  if (!runs.length) return unknown();
  const files = runs.reduce((sum, run) => sum + (run.processedFiles ?? run.fileCount ?? 0), 0);
  const measured = runs.filter(run => run.totalBytes !== undefined);
  const knownBytes = measured.reduce((sum, run) => sum + run.totalBytes!, 0);
  const unknownFiles = runs.filter(run => run.totalBytes === undefined).reduce((sum, run) => sum + (run.processedFiles ?? run.fileCount ?? 0), 0);
  return { files, knownBytes, unknownFiles, bytes: unknownFiles ? null : knownBytes,
    state: unknownFiles ? "partial" : "complete", updatedAt: runs.map(run => run.updatedAt ?? run.createdAt).sort().at(-1) };
}

/** Published scan receipts only. Viewing statistics never lists sources or replays evidence. */
export class DataStatisticsClient {
  constructor(readonly options: { store: MetadataStore }) {}
  get busy(): boolean { return false; }
  async initialize(): Promise<void> {}
  async view(): Promise<DataStatisticsView> {
    const [connectors, assets, history] = await Promise.all([this.options.store.listConnectors(), this.options.store.listDataAssets(),
      this.options.store.listConnectorIngestRuns({ status: "succeeded" })]);
    const completed = history.filter(run => !run.parentRunId);
    const latest = new Map<string, ConnectorIngestRunRecord>();
    for (const run of completed) for (const id of run.assetIds ?? (run.assetId ? [run.assetId] : [])) if (!latest.has(id)) latest.set(id, run);
    const scanned = amount([...new Map([...latest.values()].map(run => [run.id, run])).values()]);
    const cumulative = amount(completed);
    return { connectorCount: connectors.length, assetCount: assets.length, accessible: unknown(), scanned,
      cumulativeScanned: { ...cumulative, knownBytes: String(cumulative.knownBytes), bytes: cumulative.bytes === null ? null : String(cumulative.bytes) },
      connectors: connectors.map(connector => ({ connectorId: connector.id, name: connector.name, kind: connector.kind,
        assetCount: assets.filter(asset => asset.connectorIds?.includes(connector.id) || asset.connectorLocationKeys?.includes(connector.locationKey)
          || [asset.access, ...(asset.accesses ?? [])].some(access => access.connectorId === connector.id || access.uri === connector.locationKey)).length,
        accessible: unknown(), scanned: amount([...new Map([...latest.values()].filter(run => run.connectorId === connector.id).map(run => [run.id, run])).values()]) })),
      assets: assets.map(asset => ({ assetId: asset.id, size: amount(latest.has(asset.id) ? [latest.get(asset.id)!] : []), connectorTotal: unknown(), sources: [] })) };
  }
  async refresh(_connectorIds?: string[]): Promise<StatisticsRefresh> {
    const view = await this.view(), at = new Date().toISOString();
    return { id: randomUUID(), status: "succeeded", phase: "summary", processedFiles: view.scanned.files,
      completedConnectors: view.connectorCount, totalConnectors: view.connectorCount, startedAt: at, updatedAt: at, errors: [] };
  }
  async recordScan(_run: ConnectorIngestRunRecord, _files?: unknown[]): Promise<void> {}
  async close(): Promise<void> {}
}
