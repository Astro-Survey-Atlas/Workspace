import { createHash, randomUUID } from "node:crypto";

import type { ConnectorKind } from "./connectors.js";
import type { MetadataStore } from "./storage/types.js";

export type ConnectorIngestRunStatus = "queued" | "running" | "succeeded" | "failed";

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
  esIndex?: string;
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
  esIndex?: string;
  secretName?: string;
}

export interface ConnectorIngestRunFilter {
  locationKey?: string;
  connectorId?: string;
  connectorKind?: ConnectorKind;
  status?: ConnectorIngestRunStatus;
}

function optionalText(value: unknown, maximum: number): string | undefined {
  if (value == null) return undefined;
  const result = typeof value === "string" ? value.trim() : "";
  if (result.length > maximum) throw new RangeError(`run text must contain at most ${maximum} characters`);
  return result || undefined;
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

export class ConnectorIngestRunCatalog {
  readonly #store: MetadataStore;

  constructor(store: MetadataStore) { this.#store = store; }

  async initialize(): Promise<void> {}

  async list(filter?: string | ConnectorIngestRunFilter): Promise<ConnectorIngestRunRecord[]> {
    return (await this.#store.listConnectorIngestRuns(normalizedFilter(filter)))
      .map((record) => structuredClone(record));
  }

  async findIdempotent(connectorId: string, idempotencyKey: string): Promise<ConnectorIngestRunRecord | undefined> {
    const keyHash = idempotencyKeyHash(idempotencyKey);
    return (await this.#store.listConnectorIngestRuns({ connectorId }))
      .find((record) => record.idempotencyKeyHash === keyHash);
  }

  async create(
    locationKey: string,
    input: ConnectorIngestRunInput,
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
      esIndex: optionalText(input.esIndex, 160),
      secretName: optionalText(input.secretName, 63),
      idempotencyKeyHash: keyHash,
      createdAt: now,
      updatedAt: now,
    };
    if (record.connectorKind !== undefined && !["s3", "local", "jdbc"].includes(record.connectorKind)) {
      throw new RangeError("connectorKind is not supported");
    }
    const result = await this.#store.transaction((transaction) => transaction.createConnectorIngestRun(record));
    return { run: structuredClone(result.record), created: result.created };
  }

  async add(locationKey: string, input: ConnectorIngestRunInput, idempotencyKey?: string): Promise<ConnectorIngestRunRecord> {
    return (await this.create(locationKey, input, idempotencyKey)).run;
  }

  async update(id: string, patch: Partial<ConnectorIngestRunInput>): Promise<ConnectorIngestRunRecord> {
    const current = await this.#store.getConnectorIngestRun(id);
    if (!current) throw new Error(`Connector ingest run not found: ${id}`);
    if (patch.status !== undefined && !["queued", "running", "succeeded", "failed"].includes(patch.status)) {
      throw new RangeError("status is not supported");
    }
    const next: ConnectorIngestRunRecord = {
      ...current,
      ...(patch.connectorId === undefined ? {} : { connectorId: optionalText(patch.connectorId, 180) }),
      ...(patch.connectorName === undefined ? {} : { connectorName: optionalText(patch.connectorName, 240) }),
      ...(patch.connectorKind === undefined ? {} : { connectorKind: patch.connectorKind }),
      ...(patch.executor === undefined ? {} : { executor: optionalText(patch.executor, 120) }),
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
      ...(patch.esIndex === undefined ? {} : { esIndex: optionalText(patch.esIndex, 160) }),
      ...(patch.secretName === undefined ? {} : { secretName: optionalText(patch.secretName, 63) }),
      updatedAt: new Date().toISOString(),
    };
    await this.#store.putConnectorIngestRun(next);
    return structuredClone(next);
  }

  async remove(locationKey: string, id: string): Promise<void> {
    const record = await this.#store.getConnectorIngestRun(id);
    if (!record || record.locationKey !== locationKey || !await this.#store.deleteConnectorIngestRun(id)) {
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
    optionalAssetIds(record.assetIds);
    optionalTarget(record.target);
    optionalCount(record.fileCount, "fileCount");
    optionalCount(record.documentCount, "documentCount");
    return structuredClone(record);
  });
}
