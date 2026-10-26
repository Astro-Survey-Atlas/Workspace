import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scrypt } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

import { connectorDisplayPath, connectorLocationKey, validateConnectorInput, type ConnectorRecord } from "./connectors.js";
import type { ConnectorCredentialStore, StoredConnectorCredentials } from "./connector-credentials.js";
import { normalizeDataAssetRecord, normalizePersistedDataAsset, type DataAssetRecord } from "./data-catalog.js";
import type { LocalConnectorRootsPolicy } from "./local-connector-roots.js";
import type { InstallationService, WarehouseBindingState } from "./installation.js";
import type { ResourcePackageJob, ResourcePackageLoad, ResourcePackageManager } from "./resource-packages.js";
import type { MetadataStore, SurveyIdentityRecord } from "./storage/types.js";
import { normalizePersistedSurvey, type SurveyRecord, type SurveyRelease } from "./survey-registry.js";
import { validateSystemConfigBackupState, type SystemConfigBackupState, type SystemConfigRestorePoint, type SystemConfigStore } from "./system-config.js";

const BACKUP_FORMAT = "asa-workspace-config-backup";
const BACKUP_VERSION = 1;
const JOURNAL_VERSION = 1;
const PUBLIC_RESTORE_MARKER = "workspace-config-backup-public-selection-v1";
const MAX_PLAINTEXT_BYTES = 47 * 1024 * 1024;
const MAX_ENVELOPE_BYTES = 64 * 1024 * 1024;
const SCRYPT_OPTIONS = { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const BROWSER_PREFERENCE_KEYS = new Set([
  "astro-workspace:survey-layer-preferences:v4",
  "astro-workspace:survey-layer-preferences:v3",
  "astro-workspace:survey-layer-preferences:v1",
  "astro-workspace:theme:v1",
  "astro-workspace:scene-background:v1",
  "astro-workspace:aladin-image-survey:v1",
]);

interface BackupConnector extends Omit<ConnectorRecord, "credentialRef" | "lastCheck"> {
  savedCredentials?: StoredConnectorCredentials;
}

interface WorkspaceBackupPayload {
  schemaVersion: 1;
  createdAt: string;
  connectors: BackupConnector[];
  assets: DataAssetRecord[];
  surveys: SurveyIdentityRecord[];
  system: SystemConfigBackupState;
  warehouse: WarehouseBindingState | null;
  publicResourceSelection: ResourcePackageLoad[];
  browserPreferences: Record<string, string>;
}

interface RemappedPayload extends Omit<WorkspaceBackupPayload, "connectors"> {
  connectors: Array<ConnectorRecord & { savedCredentials?: StoredConnectorCredentials }>;
}

interface BackupEnvelope {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  kdf: "scrypt";
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

interface ImportPreview {
  id: string;
  expiresAt: number;
  payload: WorkspaceBackupPayload;
  summary: {
    connectors: number;
    assets: number;
    surveys: number;
    aiProviders: number;
    mcpServers: number;
    publicPackages: number;
    missingLocalRoots: Array<{ connectorId: string; name: string; rootPath: string }>;
    credentialedConnectors: number;
  };
}

export interface WorkspaceBackupPreview {
  previewId: string;
  expiresAt: string;
  summary: ImportPreview["summary"];
}

export interface PublicSelectionRestore {
  requestedAt: string;
  updatedAt: string;
  status: "pending" | "running" | "partial" | "succeeded";
  packages: Array<{ packageId: string; releaseIds: string[]; status: "pending" | "running" | "succeeded" | "failed"; jobId?: string; error?: string }>;
}

interface ImportJournal {
  version: 1;
  restorePoint: SystemConfigRestorePoint;
  connectors: ConnectorRecord[];
  assets: DataAssetRecord[];
  surveys: SurveyIdentityRecord[];
  desiredWarehouse: WarehouseBindingState | null;
  activePublicSelection: ResourcePackageLoad[];
  publicRestoreMarker: string | null;
  newCredentialRefs?: string[];
}

interface Options {
  root: string;
  store: MetadataStore;
  credentials: ConnectorCredentialStore;
  roots: LocalConnectorRootsPolicy;
  systemConfig: SystemConfigStore;
  installation: InstallationService;
  resourcePackages: ResourcePackageManager;
  surveys: { initialize(): Promise<void> };
  isBusy(): Promise<string | undefined>;
}

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RangeError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function passwordText(value: unknown): string {
  if (typeof value !== "string" || value.length < 12 || value.length > 256) throw new RangeError("Backup password must contain 12 to 256 characters");
  return value;
}

function decodeBase64(value: unknown, label: string, length?: number): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new RangeError(`Encrypted backup ${label} is invalid`);
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value || length !== undefined && decoded.length !== length) throw new RangeError(`Encrypted backup ${label} is invalid`);
  return decoded;
}

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, 32, SCRYPT_OPTIONS, (error, key) => error ? reject(error) : resolve(key as Buffer)));
}

async function encrypt(payload: WorkspaceBackupPayload, passwordValue: unknown): Promise<Buffer> {
  const password = passwordText(passwordValue);
  const cleartext = Buffer.from(JSON.stringify(payload), "utf8");
  if (cleartext.byteLength > MAX_PLAINTEXT_BYTES) throw new RangeError("Configuration backup exceeds the 47 MiB limit");
  const salt = randomBytes(16), iv = randomBytes(12), key = await deriveKey(password, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(cleartext), cipher.final()]);
  const envelope: BackupEnvelope = { format: BACKUP_FORMAT, version: BACKUP_VERSION, kdf: "scrypt",
    salt: salt.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
  return Buffer.from(JSON.stringify(envelope, null, 2), "utf8");
}

async function decrypt(bytes: Buffer, passwordValue: unknown): Promise<unknown> {
  passwordText(passwordValue);
  if (bytes.byteLength > MAX_ENVELOPE_BYTES) throw new RangeError("Encrypted backup exceeds the 64 MiB limit");
  let envelope: BackupEnvelope;
  try { envelope = JSON.parse(bytes.toString("utf8")) as BackupEnvelope; }
  catch { throw new RangeError("Encrypted backup is not valid JSON"); }
  if (!envelope || envelope.format !== BACKUP_FORMAT || envelope.version !== BACKUP_VERSION || envelope.kdf !== "scrypt") throw new RangeError("Encrypted backup format is not supported");
  const salt = decodeBase64(envelope.salt, "salt", 16), iv = decodeBase64(envelope.iv, "iv", 12);
  const tag = decodeBase64(envelope.tag, "tag", 16), ciphertext = decodeBase64(envelope.ciphertext, "ciphertext");
  if (ciphertext.byteLength > MAX_PLAINTEXT_BYTES) throw new RangeError("Encrypted backup exceeds the 47 MiB payload limit");
  try {
    const decipher = createDecipheriv("aes-256-gcm", await deriveKey(passwordText(passwordValue), salt), iv);
    decipher.setAuthTag(tag);
    const cleartext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(cleartext.toString("utf8")) as unknown;
  } catch { throw new RangeError("Backup password is incorrect or the file has been changed"); }
}

function safePreferences(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  const input = plainObject(value, "Browser preferences");
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(input)) {
    if (!BROWSER_PREFERENCE_KEYS.has(key)) continue;
    if (typeof item !== "string" || item.length > 16_384) throw new RangeError("Browser preference is invalid");
    result[key] = item;
  }
  return result;
}

function parsePayload(value: unknown): WorkspaceBackupPayload {
  const payload = plainObject(value, "Configuration backup") as unknown as WorkspaceBackupPayload;
  if (payload.schemaVersion !== 1 || !Array.isArray(payload.connectors) || !Array.isArray(payload.assets)
    || !Array.isArray(payload.surveys) || !Array.isArray(payload.publicResourceSelection)) throw new RangeError("Configuration backup schema is invalid");
  const system = validateSystemConfigBackupState(payload.system);
  const connectors = payload.connectors.map(item => {
    const record = plainObject(item, "Connector backup record") as unknown as BackupConnector;
    const validated = validateConnectorInput({ name: record.name, description: record.description, kind: record.kind, config: record.config,
      surveyId: record.surveyId, releaseId: record.releaseId, status: record.status });
    if (typeof record.id !== "string" || !record.id || typeof record.locationKey !== "string" || typeof record.createdAt !== "string" || typeof record.updatedAt !== "string") {
      throw new RangeError("Connector backup record is invalid");
    }
    const savedCredentials = record.savedCredentials;
    if (savedCredentials !== undefined && (!savedCredentials || typeof savedCredentials.accessKeyId !== "string"
      || typeof savedCredentials.secretAccessKey !== "string" || typeof savedCredentials.endpoint !== "string")) throw new RangeError("Connector credentials backup is invalid");
    return { ...record, name: validated.name, description: validated.description ?? "", kind: validated.kind,
      config: validated.config, locationKey: connectorLocationKey(validated.kind, validated.config),
      displayPath: connectorDisplayPath(validated.kind, validated.config), origin: "user" as const };
  });
  if (new Set(connectors.map(record => record.id)).size !== connectors.length
    || new Set(connectors.map(record => record.locationKey)).size !== connectors.length) throw new RangeError("Connector backup contains duplicate identities");
  const assets = payload.assets.map(item => {
    const record = normalizePersistedDataAsset(item);
    if (!record || record.origin !== "user") throw new RangeError("Only user assets can be imported");
    return record;
  });
  if (new Set(assets.map(record => record.id)).size !== assets.length) throw new RangeError("Data asset backup contains duplicate identities");
  const surveys = payload.surveys.map(item => {
    const record = plainObject(item, "Survey backup record") as unknown as SurveyIdentityRecord;
    if (record.source !== "user" || !Array.isArray(record.localReleases) || !Array.isArray(record.history)) throw new RangeError("Only user survey configuration can be imported");
    const survey = normalizePersistedSurvey(record.survey);
    if (survey.origin !== "user" || record.id !== survey.id || record.sourceId !== survey.id) throw new RangeError("Survey backup identity is invalid");
    return { ...record, survey };
  });
  if (new Set(surveys.map(record => record.id)).size !== surveys.length) throw new RangeError("Survey backup contains duplicate identities");
  const publicResourceSelection = payload.publicResourceSelection.map(load => {
    const record = plainObject(load, "Public resource selection") as unknown as ResourcePackageLoad;
    if (typeof record.packageId !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(record.packageId) || !Array.isArray(record.releaseIds)
      || record.releaseIds.some(id => typeof id !== "string" || !id.trim()) || new Set(record.releaseIds).size !== record.releaseIds.length) {
      throw new RangeError("Public resource selection is invalid");
    }
    return { packageId: record.packageId, releaseIds: [...record.releaseIds] };
  });
  if (new Set(publicResourceSelection.map(load => load.packageId)).size !== publicResourceSelection.length) throw new RangeError("Public resource selection contains duplicate packages");
  const warehouse = payload.warehouse;
  if (warehouse !== null && (!warehouse || typeof warehouse !== "object" || typeof warehouse.enabled !== "boolean"
    || typeof warehouse.elasticsearchUrl !== "string" || typeof warehouse.namespace !== "string")) throw new RangeError("Warehouse binding backup is invalid");
  return { schemaVersion: 1, createdAt: typeof payload.createdAt === "string" ? payload.createdAt : new Date().toISOString(),
    connectors, assets, surveys, system, warehouse: warehouse ? structuredClone(warehouse) : null, publicResourceSelection,
    browserPreferences: safePreferences(payload.browserPreferences) };
}

function newId(prefix: string): string { return `${prefix}-${randomUUID()}`; }

function mappedId(value: string | undefined, mapping: Map<string, string>): string | undefined { return value === undefined ? undefined : mapping.get(value) ?? value; }

function mapLocalUri(uri: string, pathMappings: Map<string, string>): string {
  if (!uri.startsWith("local://")) return uri;
  let result = uri;
  for (const [from, to] of pathMappings) {
    const marker = `local://${from}`;
    const index = result.indexOf(marker);
    if (index < 0) continue;
    const end = index + marker.length;
    if (end === result.length || result[end] === "/") result = `${result.slice(0, index)}local://${to}${result.slice(end)}`;
  }
  return result;
}

async function atomicJson(filename: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8"); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, filename);
  const directory = await open(path.dirname(filename), "r").catch(() => undefined);
  await directory?.sync().catch(() => undefined);
  await directory?.close().catch(() => undefined);
}

async function unlinkDurably(filename: string): Promise<void> {
  await unlink(filename).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
  const directory = await open(path.dirname(filename), "r").catch(() => undefined);
  await directory?.sync().catch(() => undefined);
  await directory?.close().catch(() => undefined);
}

export class WorkspaceConfigBackupService {
  readonly #options: Options;
  readonly #journalPath: string;
  readonly #previews = new Map<string, ImportPreview>();
  #applying = false;

  constructor(options: Options) {
    this.#options = options;
    this.#journalPath = path.join(options.root, "workspace-config-import-journal.json");
  }

  get busy(): boolean { return this.#applying; }

  async initialize(): Promise<void> {
    await mkdir(this.#options.root, { recursive: true, mode: 0o700 });
    try {
      const journal = JSON.parse(await readFile(this.#journalPath, "utf8")) as ImportJournal;
      if (journal.version !== JOURNAL_VERSION) throw new Error("Unsupported configuration import journal");
      await this.#rollback(journal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const saved = await this.#options.store.getImportMarker(PUBLIC_RESTORE_MARKER);
    if (saved && saved !== "null") {
      const restore = JSON.parse(saved) as PublicSelectionRestore;
      if (restore.status === "running") restore.status = "pending";
      await this.#savePublicRestore(restore);
      if (restore.status === "pending") void this.#runPublicRestore(restore).catch(() => undefined);
    }
  }

  async export(password: unknown, browserPreferences?: unknown): Promise<Buffer> {
    const [connectors, assets, surveyIdentities, system] = await Promise.all([
      this.#options.store.listConnectors(), this.#options.store.listDataAssets(), this.#options.store.listSurveyIdentities(), this.#options.systemConfig.exportBackupState(),
    ]);
    const portableConnectors: BackupConnector[] = await Promise.all(connectors.map(async record => {
      const savedCredentials = record.credentialRef ? await this.#options.credentials.get(record.credentialRef) : undefined;
      const { credentialRef: _ref, lastCheck: _lastCheck, ...portable } = record;
      return { ...portable, ...(savedCredentials ? { savedCredentials } : {}) };
    }));
    const payload: WorkspaceBackupPayload = {
      schemaVersion: 1, createdAt: new Date().toISOString(), connectors: portableConnectors,
      assets: assets.filter(asset => asset.origin === "user").map(asset => ({ ...asset, footprintIds: [] })),
      surveys: surveyIdentities.filter(entry => entry.source === "user"), system,
      warehouse: this.#options.installation.inspect().binding.desired,
      publicResourceSelection: this.#options.resourcePackages.activeSelection(),
      browserPreferences: safePreferences(browserPreferences),
    };
    return encrypt(payload, password);
  }

  async preview(encrypted: Buffer, password: unknown): Promise<WorkspaceBackupPreview> {
    const payload = parsePayload(await decrypt(encrypted, password));
    const missingLocalRoots: ImportPreview["summary"]["missingLocalRoots"] = [];
    for (const connector of payload.connectors) {
      if (connector.kind !== "local") continue;
      const rootPath = connector.config.rootPath!;
      try { await this.#options.roots.resolveReadableDirectory(rootPath); }
      catch { missingLocalRoots.push({ connectorId: connector.id, name: connector.name, rootPath }); }
    }
    const id = randomUUID(), expiresAt = Date.now() + 15 * 60_000;
    const preview: ImportPreview = { id, expiresAt, payload, summary: {
      connectors: payload.connectors.length, assets: payload.assets.length, surveys: payload.surveys.length,
      aiProviders: payload.system.config.ai.length, mcpServers: payload.system.config.mcp.length,
      publicPackages: payload.publicResourceSelection.length, missingLocalRoots,
      credentialedConnectors: payload.connectors.filter(record => Boolean(record.savedCredentials)).length,
    } };
    this.#previews.set(id, preview);
    for (const [key, value] of this.#previews) if (value.expiresAt < Date.now()) this.#previews.delete(key);
    while (this.#previews.size > 2) this.#previews.delete(this.#previews.keys().next().value!);
    return { previewId: id, expiresAt: new Date(expiresAt).toISOString(), summary: structuredClone(preview.summary) };
  }

  async apply(previewId: unknown, rawPathMappings?: unknown): Promise<{ imported: { connectors: number; assets: number; surveys: number }; publicSelection: PublicSelectionRestore; browserPreferences: Record<string, string> }> {
    if (typeof previewId !== "string") throw new RangeError("previewId is required");
    const preview = this.#previews.get(previewId);
    if (!preview || preview.expiresAt < Date.now()) { this.#previews.delete(previewId); throw new RangeError("Import preview expired; upload and preview the file again"); }
    if (this.#applying) throw new RangeError("Another configuration import is already running");
    this.#applying = true;
    let journal: ImportJournal | undefined;
    try {
      const busy = await this.#options.isBusy();
      if (busy) throw new RangeError(`Configuration cannot be replaced while ${busy}`);
      const pathMappings = await this.#normalizePathMappings(rawPathMappings, preview.payload.connectors);
      const [connectors, allAssets, surveyIdentities, oldMarker] = await Promise.all([
        this.#options.store.listConnectors(), this.#options.store.listDataAssets(), this.#options.store.listSurveyIdentities(),
        this.#options.store.getImportMarker(PUBLIC_RESTORE_MARKER),
      ]);
      const pointId = randomUUID();
      const restorePoint = await this.#options.systemConfig.createRestorePoint(pointId);
      const publicRestoreMarker = oldMarker && oldMarker !== "null" ? oldMarker : null;
      journal = {
        version: JOURNAL_VERSION, restorePoint, connectors,
        assets: allAssets.filter(asset => asset.origin === "user"), surveys: surveyIdentities.filter(entry => entry.source === "user"),
        desiredWarehouse: this.#options.installation.inspect().binding.desired,
        activePublicSelection: this.#options.resourcePackages.activeSelection(), publicRestoreMarker,
      };
      await atomicJson(this.#journalPath, journal);
      const next = await this.#remap(preview.payload, pathMappings);
      journal.newCredentialRefs = next.connectors.map(record => record.credentialRef).filter((ref): ref is string => Boolean(ref));
      await atomicJson(this.#journalPath, journal);
      for (const record of next.connectors) if (record.credentialRef && record.savedCredentials) await this.#options.credentials.put(record.credentialRef, record.savedCredentials);
      await this.#options.systemConfig.replaceBackupState(next.system);
      await this.#options.installation.restoreDesiredBinding(next.warehouse);
      const restore: PublicSelectionRestore = {
        requestedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: next.publicResourceSelection.length ? "pending" : "succeeded",
        packages: next.publicResourceSelection.map(load => ({ ...load, status: "pending" })),
      };
      await this.#options.store.transaction(async tx => {
        for (const record of await tx.listConnectors()) await tx.deleteConnector(record.id);
        for (const record of next.connectors) {
          const { savedCredentials: _credentials, ...stored } = record as ConnectorRecord & { savedCredentials?: StoredConnectorCredentials };
          await tx.putConnector(stored);
        }
        for (const record of await tx.listDataAssets()) if (record.origin === "user") await tx.deleteDataAsset(record.id);
        for (const record of next.assets) await tx.putDataAsset(record);
        for (const record of await tx.listSurveyIdentities()) if (record.source === "user") await tx.deleteSurveyIdentity(record.id);
        for (const record of next.surveys) await tx.putSurveyIdentity(record);
        await tx.setImportMarker(PUBLIC_RESTORE_MARKER, JSON.stringify(restore));
      });
      await this.#options.resourcePackages.clearActiveSelection();
      await this.#options.surveys.initialize();
      await unlink(this.#journalPath);
      await this.#options.systemConfig.discardRestorePoint(restorePoint).catch(() => undefined);
      this.#previews.delete(previewId);
      const oldRefs = new Set(connectors.map(record => record.credentialRef).filter((ref): ref is string => Boolean(ref)));
      const newRefs = new Set(next.connectors.map(record => record.credentialRef).filter((ref): ref is string => Boolean(ref)));
      for (const ref of oldRefs) if (!newRefs.has(ref) && this.#options.credentials.isManaged(ref)) await this.#options.credentials.remove(ref).catch(() => undefined);
      if (restore.status === "pending") void this.#runPublicRestore(restore).catch(() => undefined);
      return { imported: { connectors: next.connectors.length, assets: next.assets.length, surveys: next.surveys.length },
        publicSelection: structuredClone(restore), browserPreferences: structuredClone(next.browserPreferences) };
    } catch (error) {
      if (journal) await this.#rollback(journal).catch(rollbackError => { throw new Error(`Configuration import failed and recovery is pending: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`); });
      throw error;
    } finally { this.#applying = false; }
  }

  async publicSelectionStatus(): Promise<PublicSelectionRestore | undefined> {
    const value = await this.#options.store.getImportMarker(PUBLIC_RESTORE_MARKER);
    return !value || value === "null" ? undefined : JSON.parse(value) as PublicSelectionRestore;
  }

  async retryPublicSelection(): Promise<PublicSelectionRestore> {
    const current = await this.publicSelectionStatus();
    if (!current) throw new RangeError("No restored public resource selection is pending");
    if (current.status === "running") return current;
    current.status = "pending"; current.updatedAt = new Date().toISOString();
    current.packages = current.packages.map(item => ({ ...item, status: "pending", error: undefined }));
    await this.#savePublicRestore(current);
    void this.#runPublicRestore(current).catch(() => undefined);
    return current;
  }

  async #normalizePathMappings(value: unknown, connectors: BackupConnector[]): Promise<Map<string, string>> {
    if (value === undefined) return new Map();
    const input = plainObject(value, "pathMappings");
    const local = new Map(connectors.filter(record => record.kind === "local").map(record => [record.config.rootPath, record]));
    const mapped = new Map<string, string>();
    for (const [source, target] of Object.entries(input)) {
      if (!local.has(source) || typeof target !== "string" || !path.isAbsolute(target)) throw new RangeError("Local path mapping is invalid");
      const resolved = await this.#options.roots.resolveReadableDirectory(target);
      mapped.set(source, resolved.containerPath);
    }
    return mapped;
  }

  async #remap(payload: WorkspaceBackupPayload, pathMappings: Map<string, string>): Promise<RemappedPayload> {
    const connectorIds = new Map(payload.connectors.map(record => [record.id, newId("connector")]));
    const locationKeys = new Map<string, string>();
    const connectorRecords: Array<ConnectorRecord & { savedCredentials?: StoredConnectorCredentials }> = [];
    for (const source of payload.connectors) {
      const config = { ...source.config };
      if (source.kind === "local" && pathMappings.has(config.rootPath!)) config.rootPath = pathMappings.get(config.rootPath!)!;
      const validated = validateConnectorInput({ name: source.name, description: source.description, kind: source.kind, config,
        surveyId: source.surveyId, releaseId: source.releaseId, status: "draft" });
      const id = connectorIds.get(source.id)!;
      const missingLocalRoot = source.kind === "local" && !pathMappings.has(source.config.rootPath!)
        ? await this.#options.roots.resolveReadableDirectory(config.rootPath!).then(() => false, () => true) : false;
      const credentialRef = source.savedCredentials ? this.#options.credentials.managedReference(id) : undefined;
      const record: ConnectorRecord & { savedCredentials?: StoredConnectorCredentials } = {
        id, locationKey: connectorLocationKey(validated.kind, validated.config), displayPath: connectorDisplayPath(validated.kind, validated.config),
        name: validated.name, description: missingLocalRoot ? `${validated.description ?? ""}${validated.description ? " · " : ""}导入路径待适配` : validated.description ?? "",
        kind: validated.kind, config: validated.config, surveyId: source.surveyId, releaseId: source.releaseId, credentialRef,
        status: "draft", createdAt: source.createdAt, updatedAt: new Date().toISOString(), origin: "user",
        ...(source.savedCredentials ? { savedCredentials: source.savedCredentials } : {}),
      };
      if (locationKeys.has(source.locationKey)) throw new RangeError("Path mapping caused duplicate Connector locations");
      locationKeys.set(source.locationKey, record.locationKey);
      connectorRecords.push(record);
    }
    const surveyIds = new Map<string, string>();
    const releaseIds = new Map<string, string>();
    for (const entry of payload.surveys) {
      surveyIds.set(entry.survey.id, newId("user"));
      for (const release of entry.survey.releases) releaseIds.set(release.id, newId("release"));
      for (const release of entry.localReleases) releaseIds.set(release.id, newId("release"));
    }
    const surveys = payload.surveys.map(entry => {
      const id = surveyIds.get(entry.survey.id)!;
      const mapRelease = (release: SurveyRelease): SurveyRelease => ({ ...release, id: releaseIds.get(release.id)! });
      const survey: SurveyRecord = { ...entry.survey, id, releases: entry.survey.releases.map(mapRelease), origin: "user" };
      return { ...entry, id, sourceId: id, survey, localReleases: entry.localReleases.map(mapRelease),
        ...(entry.linkedTo ? { linkedTo: mappedId(entry.linkedTo, surveyIds) } : {}),
        history: entry.history.map(event => ({ ...event, targetId: mappedId(event.targetId, surveyIds) ?? event.targetId })) };
    });
    const assetIds = new Map(payload.assets.map(source => [source.id, newId("user")]));
    const assets = payload.assets.map(source => {
      const id = assetIds.get(source.id)!;
      const accesses = (source.accesses?.length ? source.accesses : [source.access]).map(access => ({ ...access,
        ...(access.connectorId ? { connectorId: mappedId(access.connectorId, connectorIds) } : {}),
        uri: mapLocalUri(access.uri, pathMappings) }));
      const rewritten: DataAssetRecord = normalizeDataAssetRecord({ ...source, id, origin: "user",
        surveyId: mappedId(source.surveyId, surveyIds), releaseId: mappedId(source.releaseId, releaseIds),
        connectorIds: (source.connectorIds ?? []).map(id => mappedId(id, connectorIds)!),
        connectorLocationKeys: (source.connectorLocationKeys ?? []).map(key => locationKeys.get(key) ?? key),
        access: accesses[0] ?? source.access, accesses,
        lineage: (source.lineage ?? []).map(entry => ({ ...entry, ...(entry.assetId ? { assetId: mappedId(entry.assetId, assetIds) } : {}) })),
        footprintIds: [], updatedAt: new Date().toISOString() }, "user");
      return normalizePersistedDataAsset(rewritten)!;
    });
    const connectors = connectorRecords.map(record => ({ ...record,
      surveyId: mappedId(record.surveyId, surveyIds), releaseId: mappedId(record.releaseId, releaseIds) }));
    return { ...payload, connectors, assets, surveys };
  }

  async #rollback(journal: ImportJournal): Promise<void> {
    const current = await this.#options.store.listConnectors();
    const previousRefs = new Set(journal.connectors.map(record => record.credentialRef).filter((ref): ref is string => Boolean(ref)));
    const currentRefs = new Set([...current.map(record => record.credentialRef), ...(journal.newCredentialRefs ?? [])].filter((ref): ref is string => Boolean(ref)));
    await this.#options.systemConfig.restoreRestorePoint(journal.restorePoint);
    await this.#options.installation.restoreDesiredBinding(journal.desiredWarehouse);
    await this.#options.store.transaction(async tx => {
      for (const record of await tx.listConnectors()) await tx.deleteConnector(record.id);
      for (const record of journal.connectors) await tx.putConnector(record);
      for (const record of await tx.listDataAssets()) if (record.origin === "user") await tx.deleteDataAsset(record.id);
      for (const record of journal.assets) await tx.putDataAsset(record);
      for (const record of await tx.listSurveyIdentities()) if (record.source === "user") await tx.deleteSurveyIdentity(record.id);
      for (const record of journal.surveys) await tx.putSurveyIdentity(record);
      await tx.setImportMarker(PUBLIC_RESTORE_MARKER, journal.publicRestoreMarker ?? "null");
    });
    await this.#options.resourcePackages.restoreActiveSelection(journal.activePublicSelection);
    await this.#options.surveys.initialize();
    await unlinkDurably(this.#journalPath);
    for (const ref of currentRefs) if (!previousRefs.has(ref) && this.#options.credentials.isManaged(ref)) await this.#options.credentials.remove(ref).catch(() => undefined);
    await this.#options.systemConfig.discardRestorePoint(journal.restorePoint).catch(() => undefined);
  }

  async #savePublicRestore(restore: PublicSelectionRestore): Promise<void> {
    restore.updatedAt = new Date().toISOString();
    await this.#options.store.setImportMarker(PUBLIC_RESTORE_MARKER, JSON.stringify(restore));
  }

  async #runPublicRestore(restore: PublicSelectionRestore): Promise<void> {
    if (restore.status === "running") return;
    restore.status = "running";
    restore.packages = restore.packages.map(item => ({ ...item, status: "pending", error: undefined }));
    await this.#savePublicRestore(restore);
    try {
      for (const item of restore.packages) {
        item.status = "running"; await this.#savePublicRestore(restore);
        let packageRecord = this.#options.resourcePackages.get(item.packageId);
        if (packageRecord.status === "not_installed" || packageRecord.status === "update_available") {
          const job = this.#options.resourcePackages.install(item.packageId);
          item.jobId = job.id; await this.#savePublicRestore(restore);
          const completed = await this.#waitForPackage(job.id);
          if (completed.status !== "completed") throw new Error(completed.error ?? `Package install ${completed.status}`);
          packageRecord = this.#options.resourcePackages.get(item.packageId);
        }
        if (item.releaseIds.some(id => !packageRecord.availableReleaseIds.includes(id))) throw new Error("Selected public release is unavailable in the installed package");
        item.status = "succeeded"; delete item.error; await this.#savePublicRestore(restore);
      }
      await this.#options.resourcePackages.setActive(restore.packages.map(item => ({ packageId: item.packageId, releaseIds: item.releaseIds })));
      restore.status = "succeeded";
    } catch (error) {
      const active = restore.packages.find(item => item.status === "running") ?? [...restore.packages].reverse().find(item => item.status === "succeeded");
      if (active) { active.status = "failed"; active.error = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500); }
      restore.status = "partial";
    }
    await this.#savePublicRestore(restore);
  }

  async #waitForPackage(jobId: string): Promise<ResourcePackageJob> {
    for (let count = 0; count < 600; count++) {
      const job = this.#options.resourcePackages.job(jobId);
      if (job.status === "completed" || job.status === "failed") return job;
      await new Promise(resolve => setTimeout(resolve, 1_000));
    }
    throw new Error("Public resource package download timed out; selection is retained for retry");
  }
}
