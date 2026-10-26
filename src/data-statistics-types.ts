export type StatisticsState = "complete" | "partial" | "unknown" | "unsupported";

export interface StatisticsEntry {
  key: string;
  bytes: number | null;
}

/** A snapshot becomes visible only after every entry has been persisted. */
export interface StatisticsSnapshot {
  id: string;
  slot: string;
  category: "accessible" | "asset" | "scanned";
  connectorId: string;
  assetId?: string;
  runId?: string;
  fingerprint: string;
  updatedAt: string;
  state: "complete" | "partial";
  message?: string;
  pointCount?: number;
}

export interface StatisticsTotals {
  files: number;
  knownBytes: number;
  unknownFiles: number;
}

export interface DataAmount extends StatisticsTotals {
  bytes: number | null;
  state: StatisticsState;
  updatedAt?: string;
  message?: string;
}

export interface StatisticsRefresh {
  id: string;
  status: "running" | "succeeded" | "partial" | "failed";
  phase: string;
  processedFiles: number;
  completedConnectors: number;
  totalConnectors: number;
  startedAt: string;
  updatedAt: string;
  errors: Array<{ connectorId: string; message: string }>;
}

export interface DataStatisticsView {
  connectorCount: number;
  assetCount: number;
  accessible: DataAmount;
  scanned: DataAmount;
  connectors: Array<{
    connectorId: string;
    name: string;
    kind: string;
    assetCount: number;
    accessible: DataAmount;
    scanned: DataAmount;
    error?: string;
  }>;
  assets: Array<{
    assetId: string;
    size: DataAmount;
    connectorTotal: DataAmount;
    sources: Array<{ connectorId: string; name: string; size: DataAmount; connectorTotal: DataAmount }>;
  }>;
  refresh?: StatisticsRefresh;
}
