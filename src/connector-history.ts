import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type ConnectorIngestRunStatus = "queued" | "running" | "succeeded" | "failed";

export interface ConnectorIngestRun {
  id: string;
  locationKey: string;
  jobId?: string;
  batchId?: string;
  assetId?: string;
  assetName?: string;
  status: ConnectorIngestRunStatus;
  startedAt: string;
  completedAt?: string;
  fileCount?: number;
  documentCount?: number;
  error?: string;
  sourcePath?: string;
  esIndex?: string;
  secretName?: string;
  createdAt: string;
}

export interface ConnectorIngestRunInput {
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

export class ConnectorIngestRunCatalog {
  readonly #statePath: string;
  #records: ConnectorIngestRun[] = [];

  constructor(statePath: string) { this.#statePath = statePath; }

  async initialize(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.#statePath, "utf8")) as unknown;
      if (!Array.isArray(parsed)) throw new Error("connector ingest run state must be an array");
      this.#records = parsed.filter((entry): entry is ConnectorIngestRun => Boolean(entry) && typeof entry === "object");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.#records = [];
      await this.#persist();
    }
  }

  list(locationKey?: string): ConnectorIngestRun[] {
    return this.#records
      .filter((record) => !locationKey || record.locationKey === locationKey)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((record) => structuredClone(record));
  }

  async add(locationKey: string, input: ConnectorIngestRunInput): Promise<ConnectorIngestRun> {
    if (!locationKey) throw new RangeError("locationKey is required");
    if (!["queued", "running", "succeeded", "failed"].includes(input.status)) throw new RangeError("status is not supported");
    const record: ConnectorIngestRun = {
      id: `ingest-${randomUUID()}`,
      locationKey,
      jobId: optionalText(input.jobId, 180),
      batchId: optionalText(input.batchId, 180),
      assetId: optionalText(input.assetId, 180),
      assetName: optionalText(input.assetName, 240),
      status: input.status,
      startedAt: optionalText(input.startedAt, 80) ?? new Date().toISOString(),
      completedAt: optionalText(input.completedAt, 80),
      fileCount: optionalCount(input.fileCount, "fileCount"),
      documentCount: optionalCount(input.documentCount, "documentCount"),
      error: optionalText(input.error, 2000),
      sourcePath: optionalText(input.sourcePath, 2048),
      esIndex: optionalText(input.esIndex, 160),
      secretName: optionalText(input.secretName, 63),
      createdAt: new Date().toISOString(),
    };
    this.#records.push(record);
    await this.#persist();
    return structuredClone(record);
  }

  async update(id: string, patch: Partial<ConnectorIngestRunInput>): Promise<ConnectorIngestRun> {
    const index = this.#records.findIndex((record) => record.id === id);
    if (index < 0) throw new Error(`Connector ingest run not found: ${id}`);
    const current = this.#records[index]!;
    if (patch.status !== undefined && !["queued", "running", "succeeded", "failed"].includes(patch.status)) {
      throw new RangeError("status is not supported");
    }
    const next: ConnectorIngestRun = {
      ...current,
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
    };
    this.#records[index] = next;
    await this.#persist();
    return structuredClone(next);
  }

  async remove(locationKey: string, id: string): Promise<void> {
    const index = this.#records.findIndex((record) => record.locationKey === locationKey && record.id === id);
    if (index < 0) throw new Error(`Connector ingest run not found: ${id}`);
    this.#records.splice(index, 1);
    await this.#persist();
  }

  async #persist(): Promise<void> {
    await mkdir(path.dirname(this.#statePath), { recursive: true });
    const temporaryPath = `${this.#statePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(this.#records, null, 2), "utf8");
    await rename(temporaryPath, this.#statePath);
  }
}
