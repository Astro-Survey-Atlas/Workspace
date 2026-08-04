import type { ConnectorRecord } from "./connectors.js";
import type { DataAssetRecord } from "./data-catalog.js";

export type DataOwnershipSource = "connector" | "asset" | "unassigned" | "conflict";

export interface EffectiveDataOwnership {
  surveyId?: string;
  releaseId?: string;
  source: DataOwnershipSource;
  connectorIds: string[];
  connectorLocationKeys: string[];
  message?: string;
}

function bindingKey(surveyId?: string, releaseId?: string): string {
  return `${surveyId ?? ""}|${releaseId ?? ""}`;
}

/**
 * Resolve the scientific ownership of a logical asset without mutating its
 * persisted catalog record. Connector-linked assets inherit their ownership;
 * connector-free metadata assets retain their own survey fields.
 */
export function resolveDataOwnership(asset: DataAssetRecord, connectors: readonly ConnectorRecord[]): EffectiveDataOwnership {
  const byId = new Map(connectors.map((connector) => [connector.id, connector]));
  const byLocation = new Map(connectors.map((connector) => [connector.locationKey, connector]));
  const linked = new Map<string, ConnectorRecord>();
  for (const id of asset.connectorIds ?? []) {
    const connector = byId.get(id);
    if (connector) linked.set(connector.locationKey, connector);
  }
  for (const id of (asset.accesses ?? []).map((access) => access.connectorId).filter((value): value is string => Boolean(value))) {
    const connector = byId.get(id);
    if (connector) linked.set(connector.locationKey, connector);
  }
  for (const locationKey of asset.connectorLocationKeys ?? []) {
    const connector = byLocation.get(locationKey);
    if (connector) linked.set(connector.locationKey, connector);
  }

  const linkedRecords = [...linked.values()].sort((left, right) => left.locationKey.localeCompare(right.locationKey));
  if (!linkedRecords.length) {
    if (asset.surveyId) {
      return {
        surveyId: asset.surveyId,
        releaseId: asset.releaseId,
        source: "asset",
        connectorIds: [],
        connectorLocationKeys: [],
      };
    }
    return { source: "unassigned", connectorIds: [], connectorLocationKeys: [] };
  }

  const bindings = new Set(linkedRecords.map((connector) => bindingKey(connector.surveyId, connector.releaseId)));
  const connectorIds = linkedRecords.map((connector) => connector.id);
  const connectorLocationKeys = linkedRecords.map((connector) => connector.locationKey);
  if (bindings.size !== 1) {
    return {
      source: "conflict",
      connectorIds,
      connectorLocationKeys,
      message: `关联 Connector 的巡天归属不一致：${linkedRecords.map((connector) => `${connector.name}=${connector.surveyId ?? "未关联"}/${connector.releaseId ?? "未关联"}`).join("；")}`,
    };
  }
  const connector = linkedRecords[0]!;
  if (!connector.surveyId) return { source: "unassigned", connectorIds, connectorLocationKeys };
  return {
    surveyId: connector.surveyId,
    releaseId: connector.releaseId,
    source: "connector",
    connectorIds,
    connectorLocationKeys,
  };
}

export function ownershipKey(ownership: Pick<EffectiveDataOwnership, "surveyId" | "releaseId">): string {
  return ownership.surveyId ? `${ownership.surveyId}:${ownership.releaseId ?? ""}` : "__unassigned__";
}
