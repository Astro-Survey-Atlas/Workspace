import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type DataAssetKind = "catalog" | "image" | "spectra" | "cube" | "timeseries" | "other";
export type DataConnectorKind = "metadata" | "local" | "http" | "mcp" | "tap" | "s3" | "database";
export type DataAssetStatus = "ready" | "metadata_only" | "unavailable";

export interface DataAssetAccess {
  connector: DataConnectorKind;
  uri: string;
  format: string;
}

export interface DataAssetRecord {
  id: string;
  name: string;
  description: string;
  surveyId?: string;
  releaseId?: string;
  product: string;
  kind: DataAssetKind;
  modalities: string[];
  access: DataAssetAccess;
  status: DataAssetStatus;
  footprintIds: string[];
  origin: "builtin" | "user";
  createdAt: string;
  updatedAt: string;
}

export interface DataAssetRegistrationInput {
  name: string;
  description?: string;
  surveyId?: string;
  releaseId?: string;
  product?: string;
  kind: DataAssetKind;
  modalities?: string[];
  connector: DataConnectorKind;
  sourceUri: string;
  format: string;
  status?: DataAssetStatus;
  footprintIds?: string[];
}

const ASSET_KINDS: readonly DataAssetKind[] = ["catalog", "image", "spectra", "cube", "timeseries", "other"];
const CONNECTOR_KINDS: readonly DataConnectorKind[] = ["metadata", "local", "http", "mcp", "tap", "s3", "database"];
const ASSET_STATUSES: readonly DataAssetStatus[] = ["ready", "metadata_only", "unavailable"];

function textValue(value: unknown, name: string, maximum: number, required = true): string {
  const result = typeof value === "string" ? value.trim() : "";
  if (required && !result) throw new RangeError(`${name} is required`);
  if (result.length > maximum) throw new RangeError(`${name} must contain at most ${maximum} characters`);
  return result;
}

function validateInput(input: DataAssetRegistrationInput): DataAssetRegistrationInput {
  const value = (input && typeof input === "object" ? input : {}) as Partial<DataAssetRegistrationInput>;
  const name = textValue(value.name, "name", 120);
  const sourceUri = textValue(value.sourceUri, "sourceUri", 2048);
  const format = textValue(value.format, "format", 80);
  if (!ASSET_KINDS.includes(value.kind as DataAssetKind)) throw new RangeError("kind is not supported");
  if (!CONNECTOR_KINDS.includes(value.connector as DataConnectorKind)) throw new RangeError("connector is not supported");
  if (value.status && !ASSET_STATUSES.includes(value.status)) throw new RangeError("status is not supported");
  if (!Array.isArray(value.modalities ?? []) || (value.modalities ?? []).some((item) => typeof item !== "string" || !item.trim())) {
    throw new RangeError("modalities must be an array of non-empty strings");
  }
  if (!Array.isArray(value.footprintIds ?? []) || (value.footprintIds ?? []).some((item) => typeof item !== "string" || !item.trim())) {
    throw new RangeError("footprintIds must be an array of non-empty strings");
  }
  return {
    name,
    description: textValue(value.description, "description", 500, false) || undefined,
    surveyId: textValue(value.surveyId, "surveyId", 120, false) || undefined,
    releaseId: textValue(value.releaseId, "releaseId", 120, false) || undefined,
    product: textValue(value.product, "product", 160, false) || undefined,
    kind: value.kind as DataAssetKind,
    modalities: [...new Set((value.modalities ?? []).map((item) => item.trim()))],
    connector: value.connector as DataConnectorKind,
    sourceUri,
    format,
    status: value.status,
    footprintIds: [...new Set((value.footprintIds ?? []).map((item) => item.trim()))],
  };
}

export class DataCatalogRegistry {
  readonly #bootstrapPath: string;
  readonly #statePath: string;
  #builtin: DataAssetRecord[] = [];
  #user: DataAssetRecord[] = [];

  constructor(bootstrapPath: string, statePath: string) {
    this.#bootstrapPath = bootstrapPath;
    this.#statePath = statePath;
  }

  async initialize(): Promise<void> {
    const builtin = JSON.parse(await readFile(this.#bootstrapPath, "utf8")) as unknown;
    if (!Array.isArray(builtin)) throw new Error("data catalog bootstrap must be an array");
    this.#builtin = builtin.map((entry) => ({ ...(entry as DataAssetRecord), origin: "builtin" as const }));
    try {
      const persisted = JSON.parse(await readFile(this.#statePath, "utf8")) as unknown;
      if (!Array.isArray(persisted)) throw new Error("data catalog state must be an array");
      this.#user = persisted.filter((entry): entry is DataAssetRecord => Boolean(entry) && typeof entry === "object" && (entry as DataAssetRecord).origin === "user");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.#persist();
    }
  }

  list(): DataAssetRecord[] {
    return [...this.#builtin, ...this.#user].map((entry) => structuredClone(entry));
  }

  get(id: string): DataAssetRecord {
    const record = [...this.#builtin, ...this.#user].find((entry) => entry.id === id);
    if (!record) throw new Error(`Data asset not found: ${id}`);
    return structuredClone(record);
  }

  async register(input: DataAssetRegistrationInput): Promise<DataAssetRecord> {
    const value = validateInput(input);
    const now = new Date().toISOString();
    const record: DataAssetRecord = {
      id: `user-${randomUUID()}`,
      name: value.name,
      description: value.description ?? "User-registered data asset. Metadata is stored here; source rows remain at the registered connector URI.",
      surveyId: value.surveyId,
      releaseId: value.releaseId,
      product: value.product ?? value.name,
      kind: value.kind,
      modalities: value.modalities ?? [],
      access: { connector: value.connector, uri: value.sourceUri, format: value.format },
      status: value.status ?? "metadata_only",
      footprintIds: value.footprintIds ?? [],
      origin: "user",
      createdAt: now,
      updatedAt: now,
    };
    this.#user.push(record);
    await this.#persist();
    return structuredClone(record);
  }

  async update(id: string, input: DataAssetRegistrationInput): Promise<DataAssetRecord> {
    const index = this.#user.findIndex((entry) => entry.id === id);
    if (index < 0) {
      if (this.#builtin.some((entry) => entry.id === id)) throw new RangeError("built-in data assets are read-only");
      throw new Error(`Data asset not found: ${id}`);
    }
    const value = validateInput(input);
    const current = this.#user[index]!;
    const updated: DataAssetRecord = {
      ...current,
      name: value.name,
      description: value.description ?? current.description,
      surveyId: value.surveyId,
      releaseId: value.releaseId,
      product: value.product ?? value.name,
      kind: value.kind,
      modalities: value.modalities ?? [],
      access: { connector: value.connector, uri: value.sourceUri, format: value.format },
      status: value.status ?? current.status,
      footprintIds: value.footprintIds ?? [],
      updatedAt: new Date().toISOString(),
    };
    this.#user[index] = updated;
    await this.#persist();
    return structuredClone(updated);
  }

  async remove(id: string): Promise<void> {
    const index = this.#user.findIndex((entry) => entry.id === id);
    if (index < 0) {
      if (this.#builtin.some((entry) => entry.id === id)) throw new RangeError("built-in data assets are read-only");
      throw new Error(`Data asset not found: ${id}`);
    }
    this.#user.splice(index, 1);
    await this.#persist();
  }

  async #persist(): Promise<void> {
    await mkdir(path.dirname(this.#statePath), { recursive: true });
    const temporaryPath = `${this.#statePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(this.#user, null, 2), "utf8");
    await rename(temporaryPath, this.#statePath);
  }
}
