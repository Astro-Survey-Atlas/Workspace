import type { ConnectorIngestRunRecord } from "./connector-history.js";

export function workspaceLayerIdForAsset(assetId: string): string {
  return `workspace-${assetId}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 180) || "workspace-asset";
}

export function warehouseLayerBelongsToAsset(layerId: string, assetId: string): boolean {
  return layerId === assetId || layerId === workspaceLayerIdForAsset(assetId) || layerId === `user-${assetId}`
    || layerId.startsWith(`${workspaceLayerIdForAsset(assetId)}-batch-`)
      && /^[a-f0-9-]{36}$/.test(layerId.slice(`${workspaceLayerIdForAsset(assetId)}-batch-`.length));
}

/** Publish a replacement only when its entire logical batch has succeeded. */
export function currentWarehouseLayerIds(assetId: string, runs: readonly ConnectorIngestRunRecord[]): string[] {
  const eligible = runs.filter(run => run.backend === "warehouse" && !run.parentRunId
    && (run.executor === "warehouse-scan" || run.executor === "warehouse-batch")
    && (run.assetId === assetId || run.assetIds?.includes(assetId))
    && run.warehouseLayerId && warehouseLayerBelongsToAsset(run.warehouseLayerId, assetId))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
  const current = eligible.find(run => run.status === "succeeded")
    ?? eligible.find(run => run.status === "running" || run.status === "queued");
  return current?.warehouseLayerId ? [current.warehouseLayerId]
    : [assetId, workspaceLayerIdForAsset(assetId), `user-${assetId}`];
}
