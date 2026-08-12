import type { ConnectorIngestRun } from "../connector-history.js";
import type { ConnectorRecord } from "../connectors.js";
import type { DataAssetRecord } from "../data-catalog.js";

export interface MetadataTransaction {
  listConnectors(): Promise<ConnectorRecord[]>;
  getConnector(id: string): Promise<ConnectorRecord | undefined>;
  getConnectorByLocationKey(locationKey: string): Promise<ConnectorRecord | undefined>;
  putConnector(record: ConnectorRecord): Promise<void>;
  deleteConnector(id: string): Promise<boolean>;

  listDataAssets(): Promise<DataAssetRecord[]>;
  getDataAsset(id: string): Promise<DataAssetRecord | undefined>;
  putDataAsset(record: DataAssetRecord): Promise<void>;
  deleteDataAsset(id: string): Promise<boolean>;

  listConnectorIngestRuns(locationKey?: string): Promise<ConnectorIngestRun[]>;
  getConnectorIngestRun(id: string): Promise<ConnectorIngestRun | undefined>;
  putConnectorIngestRun(record: ConnectorIngestRun): Promise<void>;
  deleteConnectorIngestRun(id: string): Promise<boolean>;

  getImportMarker(name: string): Promise<string | undefined>;
  setImportMarker(name: string, value: string): Promise<void>;
}

export interface MetadataStore extends MetadataTransaction {
  initialize(): Promise<void>;
  transaction<T>(operation: (transaction: MetadataTransaction) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function assertPersistableDataAsset(record: DataAssetRecord): void {
  if (record.origin !== "user" && record.origin !== "override") {
    throw new RangeError("Only user and override data assets can be persisted");
  }
}
