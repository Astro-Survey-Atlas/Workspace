import type { DataAssetRecord } from "./data-catalog.js";
import type { ConnectorRecord } from "./connectors.js";

export function assetLinkedToConnector(asset: DataAssetRecord, connector: ConnectorRecord): boolean {
  return Boolean(asset.connectorIds?.includes(connector.id) || asset.connectorLocationKeys?.includes(connector.locationKey)
    || [asset.access, ...(asset.accesses ?? [])].some(access => access.connectorId === connector.id || access.uri === connector.locationKey));
}

