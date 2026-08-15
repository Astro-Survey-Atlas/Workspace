import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { normalizeLocalSourceRelativePath } from "./local-source-inspection.js";
import type { MetadataStore } from "./storage/types.js";

export type DataAssetKind = "catalog" | "image" | "spectra" | "cube" | "timeseries" | "other";
export type DataConnectorKind = "metadata" | "local" | "http" | "mcp" | "tap" | "s3" | "database" | "jdbc";
export type DataAssetStatus = "ready" | "metadata_only" | "unavailable";
/** Project-facing lifecycle state. Engineering availability remains in `status`. */
export type DataAssetProjectState = "public_reference" | "acquired" | "processed" | "deliverable" | "planned";
export type DataAssetOrigin = "builtin" | "user" | "override";

export interface DataAssetSurveyBinding {
  source: "connector" | "asset" | "unassigned" | "conflict";
  surveyId?: string;
  releaseId?: string;
  connectorIds: string[];
  connectorLocationKeys: string[];
  message?: string;
}

export interface DataAssetSource {
  label: string;
  url: string;
  description?: string;
}

export interface DataAssetLineage {
  relation: string;
  label: string;
  assetId?: string;
}

export interface DataAssetAccess {
  connector: DataConnectorKind;
  uri: string;
  format: string;
  connectorId?: string;
  label?: string;
}

export interface DataAssetScanSpec {
  format: "csv";
  objectIdColumn: string;
  raColumn: string;
  decColumn: string;
  coordinateFrame: "ICRS";
  coordinateUnits: "deg";
  modality?: string;
  product?: string;
}

export interface DataAssetRecord {
  id: string;
  name: string;
  description: string;
  surveyId?: string;
  releaseId?: string;
  ownershipSnapshotVersion?: 1;
  sourceRelativePath?: string;
  product: string;
  kind: DataAssetKind;
  modalities: string[];
  tags?: string[];
  access: DataAssetAccess;
  accesses?: DataAssetAccess[];
  sources?: DataAssetSource[];
  connectorIds?: string[];
  /** Stable connector associations; unlike connectorIds these survive connector upserts. */
  connectorLocationKeys?: string[];
  lineage?: DataAssetLineage[];
  scanSpec?: DataAssetScanSpec;
  status: DataAssetStatus;
  projectState: DataAssetProjectState;
  projectStates?: DataAssetProjectState[];
  footprintIds: string[];
  origin: DataAssetOrigin;
  createdAt: string;
  updatedAt: string;
  /** Response-only effective ownership; not persisted by the registry. */
  surveyBinding?: DataAssetSurveyBinding;
}

export interface DataAssetRegistrationInput {
  name: string;
  description?: string;
  surveyId?: string;
  releaseId?: string;
  ownershipSnapshotVersion?: 1;
  sourceRelativePath?: string;
  product?: string;
  kind: DataAssetKind;
  modalities?: string[];
  tags?: string[];
  connector?: DataConnectorKind;
  sourceUri?: string;
  format?: string;
  accesses?: DataAssetAccess[];
  sources?: DataAssetSource[];
  connectorIds?: string[];
  connectorLocationKeys?: string[];
  lineage?: DataAssetLineage[];
  scanSpec?: DataAssetScanSpec;
  status?: DataAssetStatus;
  projectState?: DataAssetProjectState;
  projectStates?: DataAssetProjectState[];
  footprintIds?: string[];
}

const ASSET_KINDS: readonly DataAssetKind[] = ["catalog", "image", "spectra", "cube", "timeseries", "other"];
const CONNECTOR_KINDS: readonly DataConnectorKind[] = ["metadata", "local", "http", "mcp", "tap", "s3", "database", "jdbc"];
const ASSET_STATUSES: readonly DataAssetStatus[] = ["ready", "metadata_only", "unavailable"];
const PROJECT_STATES: readonly DataAssetProjectState[] = ["public_reference", "acquired", "processed", "deliverable", "planned"];
const PROJECT_STATE_PRIORITY: readonly DataAssetProjectState[] = ["deliverable", "processed", "acquired", "public_reference", "planned"];
const SCAN_SPEC_FIELDS = new Set([
  "format",
  "objectIdColumn",
  "raColumn",
  "decColumn",
  "coordinateFrame",
  "coordinateUnits",
  "modality",
  "product",
]);
const SCAN_SPEC_COLUMN_MAXIMUM = 512;
const SCAN_SPEC_TEXT_MAXIMUM = 160;

export function inferProjectStates(record: Pick<DataAssetRecord, "status" | "access"> & { accesses?: DataAssetAccess[] }): DataAssetProjectState[] {
  const accesses = record.accesses?.length ? record.accesses : [record.access];
  const states: DataAssetProjectState[] = [];
  if (record.status === "metadata_only") states.push("public_reference");
  if (accesses.some((access) => ["local", "s3", "database", "jdbc"].includes(access.connector))) states.push("acquired");
  if (!states.length) states.push("planned");
  return states;
}

export function inferProjectState(record: Pick<DataAssetRecord, "status" | "access"> & { accesses?: DataAssetAccess[] }): DataAssetProjectState {
  return inferProjectStates(record)[0] ?? "planned";
}

function textValue(value: unknown, name: string, maximum: number, required = true): string {
  const result = typeof value === "string" ? value.trim() : "";
  if (required && !result) throw new RangeError(`${name} is required`);
  if (result.length > maximum) throw new RangeError(`${name} must contain at most ${maximum} characters`);
  return result;
}

function optionalText(value: unknown, name: string, maximum: number): string | undefined {
  return textValue(value, name, maximum, false) || undefined;
}

function scanSpecText(value: unknown, name: string, maximum: number, required = true): string | undefined {
  if (value === undefined) {
    if (required) throw new RangeError(`${name} is required`);
    return undefined;
  }
  if (typeof value !== "string") throw new RangeError(`${name} must be a string`);
  const result = value.trim();
  if (required && !result) throw new RangeError(`${name} is required`);
  if (result.length > maximum) throw new RangeError(`${name} must contain at most ${maximum} characters`);
  return result || undefined;
}

function validateScanSpec(value: unknown): DataAssetScanSpec | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RangeError("scanSpec must be an object");
  const scanSpec = value as Record<string, unknown>;
  const unknown = Object.keys(scanSpec).filter((field) => !SCAN_SPEC_FIELDS.has(field));
  if (unknown.length) throw new RangeError(`scanSpec contains unknown field: ${unknown[0]}`);

  const format = scanSpecText(scanSpec.format, "scanSpec.format", 20);
  if (format !== "csv") throw new RangeError("scanSpec.format must be csv");
  const objectIdColumn = scanSpecText(scanSpec.objectIdColumn, "scanSpec.objectIdColumn", SCAN_SPEC_COLUMN_MAXIMUM)!;
  const raColumn = scanSpecText(scanSpec.raColumn, "scanSpec.raColumn", SCAN_SPEC_COLUMN_MAXIMUM)!;
  const decColumn = scanSpecText(scanSpec.decColumn, "scanSpec.decColumn", SCAN_SPEC_COLUMN_MAXIMUM)!;
  if (new Set([objectIdColumn, raColumn, decColumn]).size !== 3) {
    throw new RangeError("scanSpec column names must be distinct");
  }

  const coordinateFrame = scanSpecText(scanSpec.coordinateFrame, "scanSpec.coordinateFrame", 16);
  if (coordinateFrame !== "ICRS") throw new RangeError("scanSpec.coordinateFrame must be ICRS");
  const coordinateUnits = scanSpecText(scanSpec.coordinateUnits, "scanSpec.coordinateUnits", 16);
  if (coordinateUnits !== "deg") throw new RangeError("scanSpec.coordinateUnits must be deg");
  const modality = scanSpecText(scanSpec.modality, "scanSpec.modality", SCAN_SPEC_TEXT_MAXIMUM, false);
  const product = scanSpecText(scanSpec.product, "scanSpec.product", SCAN_SPEC_TEXT_MAXIMUM, false);

  return {
    format: "csv",
    objectIdColumn,
    raColumn,
    decColumn,
    coordinateFrame: "ICRS",
    coordinateUnits: "deg",
    ...(modality === undefined ? {} : { modality }),
    ...(product === undefined ? {} : { product }),
  };
}

function validateAccesses(value: unknown): DataAssetAccess[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.length) throw new RangeError("accesses must contain at least one access location");
  return value.map((entry, index) => {
    const access = (entry && typeof entry === "object" ? entry : {}) as Partial<DataAssetAccess>;
    if (!CONNECTOR_KINDS.includes(access.connector as DataConnectorKind)) throw new RangeError(`accesses[${index}].connector is not supported`);
    return {
      connector: access.connector as DataConnectorKind,
      uri: textValue(access.uri, `accesses[${index}].uri`, 2048),
      format: textValue(access.format, `accesses[${index}].format`, 80),
      connectorId: optionalText(access.connectorId, `accesses[${index}].connectorId`, 120),
      label: optionalText(access.label, `accesses[${index}].label`, 120),
    };
  });
}

function validateConnectorIds(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new RangeError("connectorIds must be an array of non-empty strings");
  }
  return [...new Set(value.map((item) => item.trim()))];
}

function validateConnectorLocationKeys(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim() || entry.length > 2048)) {
    throw new RangeError("connectorLocationKeys must be an array of non-empty strings");
  }
  return [...new Set(value.map((entry) => entry.trim()))];
}

function validateSources(value: unknown): DataAssetSource[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new RangeError("sources must be an array");
  return value.map((entry, index) => {
    const source = (entry && typeof entry === "object" ? entry : {}) as Partial<DataAssetSource>;
    return {
      label: textValue(source.label, `sources[${index}].label`, 120),
      url: textValue(source.url, `sources[${index}].url`, 2048),
      description: optionalText(source.description, `sources[${index}].description`, 500),
    };
  });
}

function validateLineage(value: unknown): DataAssetLineage[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new RangeError("lineage must be an array");
  return value.map((entry, index) => {
    const lineage = (entry && typeof entry === "object" ? entry : {}) as Partial<DataAssetLineage>;
    return {
      relation: textValue(lineage.relation, `lineage[${index}].relation`, 80),
      label: textValue(lineage.label, `lineage[${index}].label`, 240),
      assetId: optionalText(lineage.assetId, `lineage[${index}].assetId`, 120),
    };
  });
}

function validProjectStates(value: unknown, name = "projectStates"): DataAssetProjectState[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.length || value.some((state) => !PROJECT_STATES.includes(state as DataAssetProjectState))) {
    throw new RangeError(`${name} contains an unsupported state`);
  }
  return [...new Set(value as DataAssetProjectState[])];
}

function preferredProjectState(states: DataAssetProjectState[]): DataAssetProjectState {
  return PROJECT_STATE_PRIORITY.find((state) => states.includes(state)) ?? "planned";
}

function primaryAccess(value: DataAssetRegistrationInput): DataAssetAccess {
  return value.accesses?.[0] ?? {
    connector: value.connector ?? "metadata",
    uri: value.sourceUri || `asset://${encodeURIComponent(value.name)}`,
    format: value.format || "metadata",
  };
}

function validateInput(input: DataAssetRegistrationInput): DataAssetRegistrationInput {
  const value = (input && typeof input === "object" ? input : {}) as Partial<DataAssetRegistrationInput>;
  const name = textValue(value.name, "name", 120);
  const sourceUri = textValue(value.sourceUri, "sourceUri", 2048, false);
  const format = textValue(value.format, "format", 80, false);
  if (!ASSET_KINDS.includes(value.kind as DataAssetKind)) throw new RangeError("kind is not supported");
  if (value.connector !== undefined && !CONNECTOR_KINDS.includes(value.connector as DataConnectorKind)) throw new RangeError("connector is not supported");
  if (value.status && !ASSET_STATUSES.includes(value.status)) throw new RangeError("status is not supported");
  if (value.projectState && !PROJECT_STATES.includes(value.projectState)) throw new RangeError("projectState is not supported");
  const tags = value.tags ?? value.modalities ?? [];
  if (!Array.isArray(tags) || tags.some((item) => typeof item !== "string" || !item.trim())) {
    throw new RangeError("tags must be an array of non-empty strings");
  }
  if (!Array.isArray(value.footprintIds ?? []) || (value.footprintIds ?? []).some((item) => typeof item !== "string" || !item.trim())) {
    throw new RangeError("footprintIds must be an array of non-empty strings");
  }
  const accesses = validateAccesses(value.accesses);
  if (value.connector !== undefined && !sourceUri && !accesses?.length) throw new RangeError("sourceUri is required when connector is provided");
  const sources = validateSources(value.sources);
  const lineage = validateLineage(value.lineage);
  const connectorIds = validateConnectorIds(value.connectorIds);
  const connectorLocationKeys = validateConnectorLocationKeys(value.connectorLocationKeys);
  const projectStates = validProjectStates(value.projectStates);
  const scanSpec = validateScanSpec(value.scanSpec);
  const surveyId = textValue(value.surveyId, "surveyId", 120, false) || undefined;
  const releaseId = textValue(value.releaseId, "releaseId", 120, false) || undefined;
  if (releaseId && !surveyId) throw new RangeError("releaseId requires surveyId");
  if (value.ownershipSnapshotVersion !== undefined && value.ownershipSnapshotVersion !== 1) {
    throw new RangeError("ownershipSnapshotVersion must be 1");
  }
  const sourceRelativePath = value.sourceRelativePath === undefined
    ? undefined
    : normalizeLocalSourceRelativePath(value.sourceRelativePath, "sourceRelativePath");
  return {
    name,
    description: textValue(value.description, "description", 500, false) || undefined,
    surveyId,
    releaseId,
    ...(value.ownershipSnapshotVersion === 1 ? { ownershipSnapshotVersion: 1 } : {}),
    ...(sourceRelativePath === undefined ? {} : { sourceRelativePath }),
    product: textValue(value.product, "product", 160, false) || undefined,
    kind: value.kind as DataAssetKind,
    modalities: [...new Set((value.modalities ?? []).map((item) => item.trim()))],
    connector: value.connector,
    sourceUri,
    format,
    tags: [...new Set(tags.map((item) => item.trim()))],
    accesses,
    sources,
    connectorIds,
    connectorLocationKeys,
    lineage,
    scanSpec,
    status: value.status,
    projectState: value.projectState,
    projectStates: projectStates ?? (value.projectState ? [value.projectState] : undefined),
    footprintIds: [...new Set((value.footprintIds ?? []).map((item) => item.trim()))],
  };
}

export function normalizeDataAssetRecord(entry: DataAssetRecord, origin: DataAssetOrigin): DataAssetRecord {
  if (entry.ownershipSnapshotVersion !== undefined && entry.ownershipSnapshotVersion !== 1) {
    throw new RangeError("ownershipSnapshotVersion must be 1");
  }
  const sourceRelativePath = entry.sourceRelativePath === undefined
    ? undefined
    : normalizeLocalSourceRelativePath(entry.sourceRelativePath, "sourceRelativePath");
  const scanSpec = validateScanSpec(entry.scanSpec);
  const accesses = entry.accesses?.length ? entry.accesses : [entry.access];
  const access = accesses[0] ?? entry.access;
  const inferredStates = inferProjectStates({ status: entry.status, access, accesses });
  const declaredStates = validProjectStates(entry.projectStates) ?? (PROJECT_STATES.includes(entry.projectState) ? [entry.projectState] : []);
  const projectStates = declaredStates.length ? declaredStates : inferredStates;
  return {
    ...entry,
    origin,
    tags: [...new Set(entry.tags?.length ? entry.tags : entry.modalities ?? [])],
    modalities: [...new Set(entry.tags?.length ? entry.tags : entry.modalities ?? [])],
    access,
    accesses,
    sources: Array.isArray(entry.sources) ? entry.sources : [],
    connectorIds: Array.isArray(entry.connectorIds) ? [...new Set(entry.connectorIds)] : [],
    connectorLocationKeys: Array.isArray(entry.connectorLocationKeys) ? [...new Set(entry.connectorLocationKeys)] : [],
    ...(entry.ownershipSnapshotVersion === 1 ? { ownershipSnapshotVersion: 1 } : {}),
    ...(sourceRelativePath === undefined ? {} : { sourceRelativePath }),
    ...(scanSpec === undefined ? {} : { scanSpec }),
    projectStates: projectStates.length ? projectStates : ["planned"],
    projectState: PROJECT_STATES.includes(entry.projectState) && projectStates.includes(entry.projectState)
      ? entry.projectState
      : preferredProjectState(projectStates),
  };
}

export function normalizePersistedDataAsset(entry: unknown): DataAssetRecord | undefined {
  if (!entry || typeof entry !== "object") throw new Error("data catalog state contains an invalid record");
  const record = entry as DataAssetRecord;
  if (record.origin === "builtin") return undefined;
  if (record.origin !== "user" && record.origin !== "override") throw new Error("data catalog state contains an invalid origin");
  if (typeof record.id !== "string" || !record.id || typeof record.createdAt !== "string" || typeof record.updatedAt !== "string") {
    throw new Error("data catalog state contains an invalid record");
  }
  validateInput({
    ...record,
    connector: record.access?.connector,
    sourceUri: record.access?.uri,
    format: record.access?.format,
  });
  return normalizeDataAssetRecord(record, record.origin);
}

export class DataCatalogRegistry {
  readonly #bootstrapPath: string;
  readonly #store: MetadataStore;
  #builtin: DataAssetRecord[] = [];

  constructor(bootstrapPath: string, store: MetadataStore) {
    this.#bootstrapPath = bootstrapPath;
    this.#store = store;
  }

  async initialize(): Promise<void> {
    const builtin = JSON.parse(await readFile(this.#bootstrapPath, "utf8")) as unknown;
    if (!Array.isArray(builtin)) throw new Error("data catalog bootstrap must be an array");
    this.#builtin = builtin.map((entry) => normalizeDataAssetRecord(entry as DataAssetRecord, "builtin"));
  }

  async list(): Promise<DataAssetRecord[]> {
    const persisted = (await this.#store.listDataAssets())
      .map(normalizePersistedDataAsset)
      .filter((entry): entry is DataAssetRecord => entry !== undefined);
    const overrides = new Map(persisted.filter((entry) => entry.origin === "override").map((entry) => [entry.id, entry]));
    const builtin = this.#builtin.map((entry) => {
      const override = overrides.get(entry.id);
      return override ? { ...entry, ...override, origin: "builtin" as const } : entry;
    });
    return [...builtin, ...persisted.filter((entry) => entry.origin === "user")].map((entry) => structuredClone(entry));
  }

  async get(id: string): Promise<DataAssetRecord> {
    const record = (await this.list()).find((entry) => entry.id === id);
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
      ...(value.ownershipSnapshotVersion === 1 ? { ownershipSnapshotVersion: 1 } : {}),
      ...(value.sourceRelativePath === undefined ? {} : { sourceRelativePath: value.sourceRelativePath }),
      product: value.product ?? value.name,
      kind: value.kind,
      modalities: value.tags ?? value.modalities ?? [],
      tags: value.tags ?? value.modalities ?? [],
      access: primaryAccess(value),
      accesses: value.accesses ?? [primaryAccess(value)],
      sources: value.sources ?? [],
      connectorIds: value.connectorIds ?? [],
      connectorLocationKeys: value.connectorLocationKeys ?? [],
      lineage: value.lineage ?? [],
      ...(value.scanSpec === undefined ? {} : { scanSpec: value.scanSpec }),
      status: value.status ?? "metadata_only",
      projectState: value.projectState ?? preferredProjectState(value.projectStates ?? inferProjectStates({
        status: value.status ?? "metadata_only",
        access: primaryAccess(value),
        accesses: value.accesses,
      })),
      projectStates: value.projectStates ?? inferProjectStates({
        status: value.status ?? "metadata_only",
        access: primaryAccess(value),
        accesses: value.accesses,
      }),
      footprintIds: value.footprintIds ?? [],
      origin: "user",
      createdAt: now,
      updatedAt: now,
    };
    await this.#store.putDataAsset(record);
    return structuredClone(record);
  }

  async update(id: string, input: DataAssetRegistrationInput): Promise<DataAssetRecord> {
    const value = validateInput(input);
    const builtin = this.#builtin.find((entry) => entry.id === id);
    const persistedEntry = await this.#store.getDataAsset(id);
    const persisted = persistedEntry ? normalizePersistedDataAsset(persistedEntry) : undefined;
    if (!persisted && !builtin) throw new Error(`Data asset not found: ${id}`);
    const current = persisted?.origin === "user" ? persisted : await this.get(id);
    const updated: DataAssetRecord = {
      ...current,
      name: value.name,
      description: value.description ?? current.description,
      surveyId: value.surveyId,
      releaseId: value.releaseId,
      ...(value.ownershipSnapshotVersion === 1 || current.ownershipSnapshotVersion === 1 ? { ownershipSnapshotVersion: 1 } : {}),
      ...(value.sourceRelativePath === undefined
        ? (current.sourceRelativePath === undefined ? {} : { sourceRelativePath: current.sourceRelativePath })
        : { sourceRelativePath: value.sourceRelativePath }),
      product: value.product ?? value.name,
      kind: value.kind,
      modalities: value.tags ?? value.modalities ?? [],
      tags: value.tags ?? value.modalities ?? [],
      access: primaryAccess(value),
      accesses: value.accesses ?? [primaryAccess(value)],
      sources: value.sources ?? current.sources ?? [],
      connectorIds: value.connectorIds ?? current.connectorIds ?? [],
      connectorLocationKeys: value.connectorLocationKeys ?? current.connectorLocationKeys ?? [],
      lineage: value.lineage ?? current.lineage ?? [],
      ...(value.scanSpec === undefined
        ? (current.scanSpec === undefined ? {} : { scanSpec: current.scanSpec })
        : { scanSpec: value.scanSpec }),
      status: value.status ?? current.status,
      projectState: value.projectState ?? preferredProjectState(value.projectStates ?? current.projectStates ?? [current.projectState]),
      projectStates: value.projectStates ?? current.projectStates ?? [current.projectState],
      footprintIds: value.footprintIds ?? [],
      updatedAt: new Date().toISOString(),
    };
    await this.#store.putDataAsset({ ...updated, origin: persisted?.origin === "user" ? "user" : "override" });
    return structuredClone(persisted?.origin === "user" ? updated : { ...updated, origin: "builtin" as const });
  }

  async remove(id: string): Promise<void> {
    const record = await this.#store.getDataAsset(id);
    if (!record || record.origin !== "user") {
      if (this.#builtin.some((entry) => entry.id === id)) throw new RangeError("built-in data assets are read-only");
      throw new Error(`Data asset not found: ${id}`);
    }
    await this.#store.deleteDataAsset(id);
  }
}
