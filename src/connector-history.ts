import { createHash, randomUUID } from "node:crypto";

import type { ConnectorKind } from "./connectors.js";
import { validateCoverageJobSnapshot, type CoverageJobSnapshot } from "./coverage-jobs.js";
import type { MetadataStore } from "./storage/types.js";

export type ConnectorIngestRunStatus = "queued" | "running" | "succeeded" | "failed";
export type AtlasTaskKind = "user_scan" | "user_coverage";
export type ScanBackend = "local" | "warehouse" | "legacy-warehouse";
export type ScanPrecision = "exact" | "estimated" | "entrypoint-only";

export interface ConnectorScanTargetSnapshot {
  uri: string;
  bucket?: string;
  prefix?: string;
}

/** Public run history DTO. Executor credentials are deliberately excluded. */
export interface ConnectorIngestRun {
  id: string;
  /** Legacy location identity and current immutable location snapshot. */
  locationKey: string;
  connectorId?: string;
  connectorName?: string;
  connectorKind?: ConnectorKind;
  executor?: string;
  backend?: ScanBackend;
  /** Atlas-local task identity; never sent as a shared CRD field. */
  taskKind?: AtlasTaskKind;
  target?: ConnectorScanTargetSnapshot;
  assetIds?: string[];
  jobId?: string;
  batchId?: string;
  /** Retained for legacy one-asset records. */
  assetId?: string;
  assetName?: string;
  status: ConnectorIngestRunStatus;
  startedAt: string;
  completedAt?: string;
  fileCount?: number;
  documentCount?: number;
  error?: string;
  /** Retained as a legacy alias for target.uri. */
  sourcePath?: string;
  /** SHA-256 of the immutable source snapshot consumed by the run. */
  sourceSnapshotSha256?: string;
  esIndex?: string;
  warehouseLayerId?: string;
  artifactId?: string;
  mocStatus?: "pending" | "ready" | "failed" | "unavailable";
  availableOrders?: number[];
  maxOrder?: number;
  precision?: ScanPrecision;
  coverageRole?: string;
  evidencePath?: string;
  /** Present only for an optional user-asset remote scan with coverage context. */
  coverage?: CoverageJobSnapshot;
  createdAt: string;
  updatedAt?: string;
}

/** Persistence-only fields must never be returned from an HTTP history route. */
export interface ConnectorIngestRunRecord extends ConnectorIngestRun {
  secretName?: string;
  idempotencyKeyHash?: string;
}

export interface ConnectorIngestRunInput {
  connectorId?: string;
  connectorName?: string;
  connectorKind?: ConnectorKind;
  executor?: string;
  backend?: ScanBackend;
  /** Atlas-local task kind; never serialized into the shared scan CRD. */
  taskKind?: AtlasTaskKind;
  target?: ConnectorScanTargetSnapshot;
  assetIds?: string[];
  jobId?: string;
  batchId?: string;
  assetId?: string;
  assetName?: string;
  status: ConnectorIngestRunStatus;
  startedAt?: string;
  completedAt?: string;
  fileCount?: number;
  documentCount?: number;
  error?: string;
  sourcePath?: string;
  sourceSnapshotSha256?: string;
  esIndex?: string;
  warehouseLayerId?: string;
  artifactId?: string;
  mocStatus?: "pending" | "ready" | "failed" | "unavailable";
  availableOrders?: number[];
  maxOrder?: number;
  precision?: ScanPrecision;
  coverageRole?: string;
  evidencePath?: string;
  coverage?: CoverageJobSnapshot;
}

export interface ConnectorIngestRunInternalInput extends ConnectorIngestRunInput {
  secretName?: string;
}

export interface ConnectorIngestRunFilter {
  locationKey?: string;
  connectorId?: string;
  connectorKind?: ConnectorKind;
  status?: ConnectorIngestRunStatus;
  taskKind?: AtlasTaskKind;
}

function optionalText(value: unknown, maximum: number): string | undefined {
  if (value == null) return undefined;
  const result = typeof value === "string" ? value.trim() : "";
  if (result.length > maximum) throw new RangeError(`run text must contain at most ${maximum} characters`);
  return result || undefined;
}

function optionalSha256(value: unknown, name = "sourceSnapshotSha256"): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value.trim())) {
    throw new RangeError(`${name} must be a hexadecimal SHA-256`);
  }
  return value.trim().toLowerCase();
}

function optionalCount(value: unknown, name: string): number | undefined {
  if (value == null || value === "") return undefined;
  const result = Number(value);
  if (!Number.isInteger(result) || result < 0) throw new RangeError(`${name} must be a non-negative integer`);
  return result;
}

function optionalAssetIds(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim() || entry.length > 180)) {
    throw new RangeError("assetIds must be an array of non-empty strings");
  }
  return [...new Set(value.map((entry) => entry.trim()))].sort();
}

function optionalOrders(value: unknown): number[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => !Number.isSafeInteger(entry) || (entry as number) < 0 || (entry as number) > 29)) {
    throw new RangeError("availableOrders must contain HEALPix orders between 0 and 29");
  }
  return [...new Set(value as number[])].sort((a, b) => a - b);
}

function optionalOrder(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 29) throw new RangeError(`${name} must be an integer between 0 and 29`);
  return value as number;
}

function optionalBackend(value: unknown): ScanBackend | undefined {
  if (value === undefined || value === null) return undefined;
  if (!["local", "warehouse", "legacy-warehouse"].includes(value as string)) throw new RangeError("backend is not supported");
  return value as ScanBackend;
}

function optionalPrecision(value: unknown): ScanPrecision | undefined {
  if (value === undefined || value === null) return undefined;
  if (!["exact", "estimated", "entrypoint-only"].includes(value as string)) throw new RangeError("precision is not supported");
  return value as ScanPrecision;
}

function optionalMocStatus(value: unknown): ConnectorIngestRun["mocStatus"] {
  if (value === undefined || value === null) return undefined;
  if (!["pending", "ready", "failed", "unavailable"].includes(value as string)) throw new RangeError("mocStatus is not supported");
  return value as ConnectorIngestRun["mocStatus"];
}

function optionalTarget(value: unknown): ConnectorScanTargetSnapshot | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RangeError("target must be an object");
  const target = value as Partial<ConnectorScanTargetSnapshot>;
  const uri = optionalText(target.uri, 2048);
  if (!uri) throw new RangeError("target.uri is required");
  return {
    uri,
    bucket: optionalText(target.bucket, 255),
    prefix: optionalText(target.prefix, 2048),
  };
}

function idempotencyKeyHash(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const key = value.trim();
  if (!key) throw new RangeError("Idempotency-Key must not be empty");
  if (key.length > 255) throw new RangeError("Idempotency-Key must contain at most 255 characters");
  return createHash("sha256").update(key).digest("hex");
}

function normalizedFilter(value?: string | ConnectorIngestRunFilter): ConnectorIngestRunFilter | undefined {
  if (typeof value === "string") return { locationKey: value };
  return value;
}

/** Preserve legacy Atlas history while making task ownership explicit. */
function inferAtlasTaskKind(record: Partial<ConnectorIngestRunRecord>): AtlasTaskKind {
  if (record.taskKind !== undefined && record.taskKind !== "user_scan" && record.taskKind !== "user_coverage") {
    throw new RangeError("taskKind is not supported");
  }
  if (record.taskKind === "user_coverage" || record.coverage !== undefined || record.executor === "flink-coverage"
    || record.jobId?.startsWith("astro-coverage-") || record.batchId?.startsWith("workspace-coverage-")) {
    return "user_coverage";
  }
  return "user_scan";
}

function atlasTaskKindRecord(record: ConnectorIngestRunRecord): ConnectorIngestRunRecord {
  return { ...record, taskKind: inferAtlasTaskKind(record) };
}

export class ConnectorIngestRunCatalog {
  readonly #store: MetadataStore;

  constructor(store: MetadataStore) { this.#store = store; }

  async initialize(): Promise<void> {}

  async list(filter?: string | ConnectorIngestRunFilter): Promise<ConnectorIngestRunRecord[]> {
    const normalized = normalizedFilter(filter);
    const records = await this.#store.listConnectorIngestRuns(normalized);
    return records
      .map((record) => atlasTaskKindRecord(record))
      .filter((record) => normalized?.taskKind === undefined || record.taskKind === normalized.taskKind)
      .map((record) => structuredClone(record));
  }

  async findIdempotent(connectorId: string, idempotencyKey: string): Promise<ConnectorIngestRunRecord | undefined> {
    const keyHash = idempotencyKeyHash(idempotencyKey);
    return (await this.list({ connectorId }))
      .find((record) => record.idempotencyKeyHash === keyHash);
  }

  async create(
    locationKey: string,
    input: ConnectorIngestRunInternalInput,
    idempotencyKey?: string,
  ): Promise<{ run: ConnectorIngestRunRecord; created: boolean }> {
    if (!locationKey) throw new RangeError("locationKey is required");
    if (!["queued", "running", "succeeded", "failed"].includes(input.status)) throw new RangeError("status is not supported");
    const keyHash = idempotencyKeyHash(idempotencyKey);
    const connectorId = optionalText(input.connectorId, 180);
    if (keyHash && !connectorId) throw new RangeError("connectorId is required with Idempotency-Key");
    const now = new Date().toISOString();
    const record: ConnectorIngestRunRecord = {
      id: `ingest-${randomUUID()}`,
      locationKey,
      connectorId,
      connectorName: optionalText(input.connectorName, 240),
      connectorKind: input.connectorKind,
      executor: optionalText(input.executor, 120),
      backend: optionalBackend(input.backend),
      taskKind: inferAtlasTaskKind(input),
      target: optionalTarget(input.target),
      assetIds: optionalAssetIds(input.assetIds),
      jobId: optionalText(input.jobId, 180),
      batchId: optionalText(input.batchId, 180),
      assetId: optionalText(input.assetId, 180),
      assetName: optionalText(input.assetName, 240),
      status: input.status,
      startedAt: optionalText(input.startedAt, 80) ?? now,
      completedAt: optionalText(input.completedAt, 80),
      fileCount: optionalCount(input.fileCount, "fileCount"),
      documentCount: optionalCount(input.documentCount, "documentCount"),
      error: optionalText(input.error, 2000),
      sourcePath: optionalText(input.sourcePath, 2048),
      ...(input.sourceSnapshotSha256 === undefined ? {} : { sourceSnapshotSha256: optionalSha256(input.sourceSnapshotSha256) }),
      esIndex: optionalText(input.esIndex, 160),
      ...(input.warehouseLayerId === undefined ? {} : { warehouseLayerId: optionalText(input.warehouseLayerId, 180) }),
      ...(input.artifactId === undefined ? {} : { artifactId: optionalText(input.artifactId, 360) }),
      ...(input.mocStatus === undefined ? {} : { mocStatus: optionalMocStatus(input.mocStatus) }),
      ...(input.availableOrders === undefined ? {} : { availableOrders: optionalOrders(input.availableOrders) }),
      ...(input.maxOrder === undefined ? {} : { maxOrder: optionalOrder(input.maxOrder, "maxOrder") }),
      ...(input.precision === undefined ? {} : { precision: optionalPrecision(input.precision) }),
      ...(input.coverageRole === undefined ? {} : { coverageRole: optionalText(input.coverageRole, 80) }),
      ...(input.evidencePath === undefined ? {} : { evidencePath: optionalText(input.evidencePath, 2048) }),
      ...(input.coverage === undefined ? {} : { coverage: validateCoverageJobSnapshot(input.coverage) }),
      secretName: optionalText(input.secretName, 63),
      idempotencyKeyHash: keyHash,
      createdAt: now,
      updatedAt: now,
    };
    if (record.connectorKind !== undefined && !["s3", "local", "jdbc"].includes(record.connectorKind)) {
      throw new RangeError("connectorKind is not supported");
    }
    const result = await this.#store.transaction((transaction) => transaction.createConnectorIngestRun(record));
    return { run: structuredClone(atlasTaskKindRecord(result.record)), created: result.created };
  }

  async add(locationKey: string, input: ConnectorIngestRunInternalInput, idempotencyKey?: string): Promise<ConnectorIngestRunRecord> {
    return (await this.create(locationKey, input, idempotencyKey)).run;
  }

  async update(id: string, patch: Partial<ConnectorIngestRunInternalInput>): Promise<ConnectorIngestRunRecord> {
    const currentValue = await this.#store.getConnectorIngestRun(id);
    const current = currentValue ? atlasTaskKindRecord(currentValue) : undefined;
    if (!current) throw new Error(`Connector ingest run not found: ${id}`);
    if (patch.status !== undefined && !["queued", "running", "succeeded", "failed"].includes(patch.status)) {
      throw new RangeError("status is not supported");
    }
    const next: ConnectorIngestRunRecord = {
      ...current,
      taskKind: inferAtlasTaskKind({ ...current, ...patch }),
      ...(patch.connectorId === undefined ? {} : { connectorId: optionalText(patch.connectorId, 180) }),
      ...(patch.connectorName === undefined ? {} : { connectorName: optionalText(patch.connectorName, 240) }),
      ...(patch.connectorKind === undefined ? {} : { connectorKind: patch.connectorKind }),
      ...(patch.executor === undefined ? {} : { executor: optionalText(patch.executor, 120) }),
      ...(patch.backend === undefined ? {} : { backend: optionalBackend(patch.backend) }),
      ...(patch.target === undefined ? {} : { target: optionalTarget(patch.target) }),
      ...(patch.assetIds === undefined ? {} : { assetIds: optionalAssetIds(patch.assetIds) }),
      ...(patch.jobId === undefined ? {} : { jobId: optionalText(patch.jobId, 180) }),
      ...(patch.batchId === undefined ? {} : { batchId: optionalText(patch.batchId, 180) }),
      ...(patch.assetId === undefined ? {} : { assetId: optionalText(patch.assetId, 180) }),
      ...(patch.assetName === undefined ? {} : { assetName: optionalText(patch.assetName, 240) }),
      ...(patch.status === undefined ? {} : { status: patch.status }),
      ...(patch.startedAt === undefined ? {} : { startedAt: optionalText(patch.startedAt, 80) ?? current.startedAt }),
      ...(patch.completedAt === undefined ? {} : { completedAt: optionalText(patch.completedAt, 80) }),
      ...(patch.fileCount === undefined ? {} : { fileCount: optionalCount(patch.fileCount, "fileCount") }),
      ...(patch.documentCount === undefined ? {} : { documentCount: optionalCount(patch.documentCount, "documentCount") }),
      ...(patch.error === undefined ? {} : { error: optionalText(patch.error, 2000) }),
      ...(patch.sourcePath === undefined ? {} : { sourcePath: optionalText(patch.sourcePath, 2048) }),
      ...(patch.sourceSnapshotSha256 === undefined ? {} : { sourceSnapshotSha256: optionalSha256(patch.sourceSnapshotSha256) }),
      ...(patch.esIndex === undefined ? {} : { esIndex: optionalText(patch.esIndex, 160) }),
      ...(patch.warehouseLayerId === undefined ? {} : { warehouseLayerId: optionalText(patch.warehouseLayerId, 180) }),
      ...(patch.artifactId === undefined ? {} : { artifactId: optionalText(patch.artifactId, 360) }),
      ...(patch.mocStatus === undefined ? {} : { mocStatus: optionalMocStatus(patch.mocStatus) }),
      ...(patch.availableOrders === undefined ? {} : { availableOrders: optionalOrders(patch.availableOrders) }),
      ...(patch.maxOrder === undefined ? {} : { maxOrder: optionalOrder(patch.maxOrder, "maxOrder") }),
      ...(patch.precision === undefined ? {} : { precision: optionalPrecision(patch.precision) }),
      ...(patch.coverageRole === undefined ? {} : { coverageRole: optionalText(patch.coverageRole, 80) }),
      ...(patch.evidencePath === undefined ? {} : { evidencePath: optionalText(patch.evidencePath, 2048) }),
      ...(patch.coverage === undefined ? {} : { coverage: validateCoverageJobSnapshot(patch.coverage) }),
      ...(patch.secretName === undefined ? {} : { secretName: optionalText(patch.secretName, 63) }),
      updatedAt: new Date().toISOString(),
    };
    await this.#store.putConnectorIngestRun(next);
    return structuredClone(next);
  }

  async remove(locationKey: string, id: string, connectorId?: string): Promise<void> {
    const record = await this.#store.getConnectorIngestRun(id);
    const belongsToConnector = record && (record.connectorId ? record.connectorId === connectorId : record.locationKey === locationKey);
    if (!belongsToConnector || !await this.#store.deleteConnectorIngestRun(id)) {
      throw new Error(`Connector ingest run not found: ${id}`);
    }
  }
}

export function publicConnectorIngestRun(record: ConnectorIngestRunRecord): ConnectorIngestRun {
  const { secretName: _secretName, idempotencyKeyHash: _idempotencyKeyHash, ...visible } = record;
  return structuredClone(visible);
}

export function normalizeConnectorIngestRuns(entries: unknown[]): ConnectorIngestRunRecord[] {
  return entries.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("connector ingest run state contains an invalid record");
    const record = entry as ConnectorIngestRunRecord;
    if (typeof record.id !== "string" || !record.id || typeof record.locationKey !== "string" || !record.locationKey
      || !["queued", "running", "succeeded", "failed"].includes(record.status)
      || typeof record.startedAt !== "string" || typeof record.createdAt !== "string") {
      throw new Error("connector ingest run state contains an invalid record");
    }
    if (record.connectorKind !== undefined && !["s3", "local", "jdbc"].includes(record.connectorKind)) {
      throw new Error("connector ingest run state contains an invalid record");
    }
    if (record.backend !== undefined && !["local", "warehouse", "legacy-warehouse"].includes(record.backend)) throw new Error("connector ingest run state contains an invalid backend");
    optionalOrders(record.availableOrders);
    optionalOrder(record.maxOrder, "maxOrder");
    if (record.precision !== undefined && !["exact", "estimated", "entrypoint-only"].includes(record.precision)) throw new Error("connector ingest run state contains an invalid precision");
    if (record.mocStatus !== undefined && !["pending", "ready", "failed", "unavailable"].includes(record.mocStatus)) throw new Error("connector ingest run state contains an invalid MOC status");
    record.taskKind = inferAtlasTaskKind(record);
    optionalAssetIds(record.assetIds);
    optionalTarget(record.target);
    optionalSha256(record.sourceSnapshotSha256);
    optionalCount(record.fileCount, "fileCount");
    optionalCount(record.documentCount, "documentCount");
    if (record.coverage !== undefined) validateCoverageJobSnapshot(record.coverage);
    return structuredClone(record);
  });
}
