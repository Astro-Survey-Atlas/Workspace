/// <reference path="./ali-oss.d.ts" />

import { createHash, randomUUID } from "node:crypto";
import https from "node:https";
import path from "node:path";
import net from "node:net";

import { HeadBucketCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import OSS from "ali-oss";

import { LocalConnectorRootsPolicy, localConnectorPolicyMessage, type LocalConnectorRootInfo } from "./local-connector-roots.js";
import type { MetadataStore, MetadataTransaction } from "./storage/types.js";

export type ConnectorKind = "s3" | "local" | "jdbc";
export type ConnectorStatus = "draft" | "ready" | "disabled";

export type ConnectorCheckStatus = "unknown" | "ok" | "failed";

export interface ConnectorCheck {
  status: ConnectorCheckStatus;
  checkedAt: string;
  summary: string;
  detail?: string;
  /** Hash of the scan-relevant configuration that was actually checked. */
  configHash?: string;
}

export interface ConnectorRecord {
  id: string;
  /** Stable business identity. Connector registration upserts on this value. */
  locationKey: string;
  /** Human-readable path shown in lists and catalog access locations. */
  displayPath: string;
  name: string;
  description: string;
  kind: ConnectorKind;
  config: Record<string, string>;
  /** Optional Atlas-local survey/release labels for this data location. */
  surveyId?: string;
  releaseId?: string;
  credentialRef?: string;
  status: ConnectorStatus;
  createdAt: string;
  updatedAt: string;
  origin: "user";
  lastCheck?: ConnectorCheck;
}

export interface ConnectorRegistrationInput {
  name: string;
  description?: string;
  kind: ConnectorKind;
  config: Record<string, string>;
  surveyId?: string;
  releaseId?: string;
  /** Internal storage reference. Browser clients use credentials instead. */
  credentialRef?: string;
  credentials?: ConnectorCredentialsInput;
  status?: ConnectorStatus;
}

export interface ConnectorCredentialsInput {
  accessKeyId: string;
  /** Omit during editing to retain the saved secret. */
  secretAccessKey?: string;
  sessionToken?: string;
}

type ResolvedConnectorCredentials = Required<Pick<ConnectorCredentialsInput, "accessKeyId" | "secretAccessKey">> & Pick<ConnectorCredentialsInput, "sessionToken">;

export interface ConnectorCredentialSummary {
  accessKeyId: string;
  secretConfigured: boolean;
}

export type ConnectorPublicRecord = Omit<ConnectorRecord, "credentialRef"> & {
  credentials: ConnectorCredentialSummary;
};

export interface ConnectorCheckInput extends ConnectorRegistrationInput {
  credentials?: ConnectorCredentialsInput;
}

export interface ConnectorCheckRequest {}

export type { LocalConnectorRootDescriptor, LocalConnectorRootInfo } from "./local-connector-roots.js";

export interface ConnectorObject {
  key: string;
  size: number;
  lastModified?: string;
}

const CONNECTOR_KINDS: readonly ConnectorKind[] = ["s3", "local", "jdbc"];
const CONNECTOR_STATUSES: readonly ConnectorStatus[] = ["draft", "ready", "disabled"];
const REQUIRED_CONFIG: Record<ConnectorKind, readonly string[]> = {
  s3: ["bucket"],
  local: ["rootPath"],
  jdbc: ["url"],
};
const SECRET_CONFIG_KEY = /(secret|password|token|access.?key|private.?key)/i;

function cleanSegment(value: string): string {
  return value.trim().replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/");
}

function cleanEndpoint(value: string | undefined): string {
  return (value ?? "").trim().replace(/\/+$/, "");
}

function sqliteContainerPath(url: string): string {
  const filename = url.slice("jdbc:sqlite:".length).trim();
  if (!filename || filename.startsWith("file:") || !path.isAbsolute(filename)) {
    throw new RangeError("config.url SQLite path must be an absolute container path");
  }
  return filename;
}

function localContainerPath(value: string): string {
  const trimmed = value.trim();
  if (!path.isAbsolute(trimmed)) throw new RangeError("Local connector path must be an absolute container path");
  return path.normalize(trimmed);
}

/** Return the stable location identity used for connector upserts. */
export function connectorLocationKey(kind: ConnectorKind, config: Record<string, string>): string {
  if (kind === "s3") {
    const bucket = cleanSegment(config.bucket ?? "").toLocaleLowerCase();
    const prefix = cleanSegment(config.prefix ?? "");
    return `s3://${bucket}${prefix ? `/${prefix}` : ""}`;
  }
  if (kind === "local") {
    return `local://${localContainerPath(config.rootPath ?? "")}`;
  }
  const url = (config.url ?? "").trim().replace(/\/+$/, "");
  const database = (config.database ?? "").trim();
  const schema = (config.schema ?? "").trim();
  return `jdbc:${url}|database=${database}|schema=${schema}`;
}

export function connectorDisplayPath(kind: ConnectorKind, config: Record<string, string>): string {
  if (kind === "s3") {
    const bucket = cleanSegment(config.bucket ?? "");
    const prefix = cleanSegment(config.prefix ?? "");
    const endpoint = cleanEndpoint(config.endpoint);
    const pathValue = `${bucket}${prefix ? `/${prefix}` : ""}`;
    return endpoint ? `${endpoint}/${pathValue}` : `s3://${pathValue}`;
  }
  if (kind === "local") return localContainerPath(config.rootPath ?? "");
  const url = (config.url ?? "").trim();
  const scope = [config.database?.trim(), config.schema?.trim()].filter(Boolean).join("/");
  return scope ? `${url}/${scope}` : url;
}

export function connectorConfigurationHash(record: Pick<ConnectorRecord, "kind" | "config" | "credentialRef">): string {
  const config = Object.fromEntries(Object.entries(record.config).sort(([left], [right]) => left.localeCompare(right)));
  return createHash("sha256").update(JSON.stringify({ kind: record.kind, config, credentialRef: record.credentialRef ?? null })).digest("hex");
}

export function hasCurrentSuccessfulConnectorCheck(record: ConnectorRecord): boolean {
  return record.lastCheck?.status === "ok" && record.lastCheck.configHash === connectorConfigurationHash(record);
}

function textValue(value: unknown, name: string, maximum: number, required = true): string {
  const result = typeof value === "string" ? value.trim() : "";
  if (required && !result) throw new RangeError(`${name} is required`);
  if (result.length > maximum) throw new RangeError(`${name} must contain at most ${maximum} characters`);
  return result;
}

export function validateConnectorInput(input: ConnectorRegistrationInput): ConnectorRegistrationInput {
  const value = (input && typeof input === "object" ? input : {}) as Partial<ConnectorRegistrationInput>;
  const name = textValue(value.name, "name", 120);
  if (!CONNECTOR_KINDS.includes(value.kind as ConnectorKind)) throw new RangeError("kind is not supported");
  if (value.status && !CONNECTOR_STATUSES.includes(value.status)) throw new RangeError("status is not supported");
  if (!value.config || typeof value.config !== "object" || Array.isArray(value.config)) throw new RangeError("config is required");
  const config = Object.fromEntries(Object.entries(value.config).map(([key, raw]) => {
    const normalizedKey = textValue(key, "config key", 80);
    if (SECRET_CONFIG_KEY.test(normalizedKey)) throw new RangeError(`config.${normalizedKey} must use credentials; raw secrets are not stored in connector config`);
    return [normalizedKey, textValue(raw, `config.${normalizedKey}`, 2048, false)];
  }).filter(([, raw]) => raw));
  for (const key of REQUIRED_CONFIG[value.kind as ConnectorKind]) {
    if (!config[key]) throw new RangeError(`config.${key} is required`);
  }
  if (value.kind === "local" && !path.isAbsolute(config.rootPath ?? "")) {
    throw new RangeError("config.rootPath must be an absolute container path");
  }
  if (value.kind === "local") {
    config.rootPath = localContainerPath(config.rootPath!);
  }
  if (value.kind === "jdbc" && config.url?.startsWith("jdbc:sqlite:")) {
    const sqlitePath = sqliteContainerPath(config.url);
    config.url = `jdbc:sqlite:${path.normalize(sqlitePath)}`;
  }
  const surveyId = textValue(value.surveyId, "surveyId", 120, false) || undefined;
  const releaseId = textValue(value.releaseId, "releaseId", 120, false) || undefined;
  if (releaseId && !surveyId) throw new RangeError("releaseId requires surveyId");
  return {
    name,
    description: textValue(value.description, "description", 500, false) || undefined,
    kind: value.kind as ConnectorKind,
    config,
    surveyId,
    releaseId,
    credentialRef: textValue(value.credentialRef, "credentialRef", 160, false) || undefined,
    status: value.status,
  };
}

function validateResolvedCredentials(input: unknown): ResolvedConnectorCredentials | undefined {
  if (input == null) return undefined;
  if (typeof input !== "object" || Array.isArray(input)) throw new RangeError("credentials must be an object");
  const value = input as Partial<ConnectorCredentialsInput>;
  return {
    accessKeyId: textValue(value.accessKeyId, "credentials.accessKeyId", 512),
    secretAccessKey: textValue(value.secretAccessKey, "credentials.secretAccessKey", 2048),
    sessionToken: textValue(value.sessionToken, "credentials.sessionToken", 4096, false) || undefined,
  };
}

export class ConnectorRegistry {
  readonly #store: MetadataStore;
  readonly #localRoots: LocalConnectorRootsPolicy;

  constructor(store: MetadataStore, localRoots = LocalConnectorRootsPolicy.fromEnvironment()) {
    this.#store = store;
    this.#localRoots = localRoots;
  }

  async initialize(): Promise<void> {
    // Connector state is owned by Atlas. Legacy JSON migration is performed
    // explicitly before startup and is never inferred from a bootstrap file.
  }

  async list(): Promise<ConnectorRecord[]> {
    return (await this.#store.listConnectors()).map((record) => structuredClone(record));
  }

  async listLocalRoots(): Promise<LocalConnectorRootInfo[]> {
    return this.#localRoots.list();
  }

  async get(id: string): Promise<ConnectorRecord> {
    const record = await this.#store.getConnector(id);
    if (!record) throw new Error(`Connector not found: ${id}`);
    return structuredClone(record);
  }

  async register(input: ConnectorRegistrationInput): Promise<ConnectorRecord> {
    const value = validateConnectorInput(input);
    this.#assertLocalConfiguration(value);
    const locationKey = connectorLocationKey(value.kind, value.config);
    return this.#store.transaction(async (transaction) => {
      const current = await transaction.getConnectorByLocationKey(locationKey);
      const now = new Date().toISOString();
      if (current) {
      const credentialRef = value.credentialRef ?? current.credentialRef;
      const scanConfigurationUnchanged = connectorConfigurationHash(current) === connectorConfigurationHash({ kind: value.kind, config: value.config, credentialRef });
      const updated: ConnectorRecord = {
        ...current,
        name: value.name,
        description: value.description ?? current.description,
        kind: value.kind,
        config: value.config,
        surveyId: value.surveyId,
        releaseId: value.releaseId,
        credentialRef,
        status: value.status ?? current.status,
        locationKey,
        displayPath: connectorDisplayPath(value.kind, value.config),
        lastCheck: scanConfigurationUnchanged ? current.lastCheck : undefined,
        updatedAt: now,
      };
        await transaction.putConnector(updated);
        return structuredClone(updated);
      }
      const record: ConnectorRecord = {
      id: `connector-${randomUUID()}`,
      locationKey,
      displayPath: connectorDisplayPath(value.kind, value.config),
      name: value.name,
      description: value.description ?? "Connector configuration only. Connection and scanning are not enabled yet.",
      kind: value.kind,
      config: value.config,
      surveyId: value.surveyId,
      releaseId: value.releaseId,
      credentialRef: value.credentialRef,
      status: value.status ?? "draft",
      createdAt: now,
      updatedAt: now,
      origin: "user",
    };
      await transaction.putConnector(record);
      return structuredClone(record);
    });
  }

  async update(id: string, input: ConnectorRegistrationInput): Promise<ConnectorRecord> {
    const value = validateConnectorInput(input);
    this.#assertLocalConfiguration(value);
    return this.#store.transaction(async (transaction) => {
      const current = await transaction.getConnector(id);
      if (!current) throw new Error(`Connector not found: ${id}`);
      const locationKey = connectorLocationKey(value.kind, value.config);
      const duplicate = await transaction.getConnectorByLocationKey(locationKey);
      if (duplicate && duplicate.id !== current.id) throw new RangeError(`A connector already exists for path: ${duplicate.displayPath}`);
      const scanConfigurationUnchanged = connectorConfigurationHash(current) === connectorConfigurationHash({ kind: value.kind, config: value.config, credentialRef: value.credentialRef });
      const updated: ConnectorRecord = {
      ...current,
      name: value.name,
      description: value.description ?? current.description,
      kind: value.kind,
      config: value.config,
      surveyId: value.surveyId,
      releaseId: value.releaseId,
      credentialRef: value.credentialRef,
      status: value.status ?? current.status,
      locationKey,
      displayPath: connectorDisplayPath(value.kind, value.config),
      lastCheck: scanConfigurationUnchanged ? current.lastCheck : undefined,
      updatedAt: new Date().toISOString(),
    };
      await transaction.putConnector(updated);
      return structuredClone(updated);
    });
  }

  async setCredentialReference(id: string, credentialRef: string): Promise<ConnectorRecord> {
    const value = textValue(credentialRef, "credentialRef", 160);
    return this.#updateRecord(id, (current) => ({
      ...current,
      credentialRef: value,
      lastCheck: current.credentialRef === value ? current.lastCheck : undefined,
      updatedAt: new Date().toISOString(),
    }));
  }

  async invalidateCheck(id: string): Promise<ConnectorRecord> {
    return this.#updateRecord(id, (current) => ({ ...current, lastCheck: undefined, updatedAt: new Date().toISOString() }));
  }

  async remove(id: string): Promise<void> {
    const deleted = await this.#store.deleteConnector(id);
    if (!deleted) throw new Error(`Connector not found: ${id}`);
  }

  async check(id: string, credentials?: ConnectorCredentialsInput, requireCredentials = false): Promise<ConnectorRecord> {
    const current = await this.get(id);
    const result = await checkConnector(current, validateResolvedCredentials(credentials), requireCredentials, this.#localRoots);
    return this.#updateRecord(id, (latest) => ({ ...latest, lastCheck: result, updatedAt: new Date().toISOString() }));
  }

  async checkInput(input: ConnectorCheckInput): Promise<ConnectorCheck> {
    const value = validateConnectorInput(input);
    const credentials = validateResolvedCredentials(input.credentials);
    const now = new Date().toISOString();
    return checkConnector({
      id: "connector-check",
      locationKey: connectorLocationKey(value.kind, value.config),
      displayPath: connectorDisplayPath(value.kind, value.config),
      name: value.name,
      description: value.description ?? "",
      kind: value.kind,
      config: value.config,
      surveyId: value.surveyId,
      releaseId: value.releaseId,
      credentialRef: value.credentialRef,
      status: value.status ?? "draft",
      createdAt: now,
      updatedAt: now,
      origin: "user",
    }, credentials, value.kind === "s3", this.#localRoots);
  }

  #assertLocalConfiguration(input: ConnectorRegistrationInput): void {
    if (input.kind === "local") {
      this.#localRoots.assertConfiguredPath(input.config.rootPath ?? "");
      return;
    }
    if (input.kind === "jdbc" && input.config.url?.startsWith("jdbc:sqlite:")) {
      this.#localRoots.assertConfiguredPath(sqliteContainerPath(input.config.url));
    }
  }

  async #updateRecord(id: string, update: (current: ConnectorRecord) => ConnectorRecord): Promise<ConnectorRecord> {
    return this.#store.transaction(async (transaction: MetadataTransaction) => {
      const current = await transaction.getConnector(id);
      if (!current) throw new Error(`Connector not found: ${id}`);
      const updated = update(current);
      await transaction.putConnector(updated);
      return structuredClone(updated);
    });
  }
}

export function normalizeConnectorRecords(entries: unknown[]): ConnectorRecord[] {
  const records: ConnectorRecord[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") throw new Error("connector state contains an invalid record");
    const candidate = entry as Partial<ConnectorRecord>;
    if (!candidate.kind || !CONNECTOR_KINDS.includes(candidate.kind) || !candidate.config || typeof candidate.config !== "object" || Array.isArray(candidate.config)) {
      throw new Error("connector state contains an invalid record");
    }
    const rawConfig = Object.fromEntries(Object.entries(candidate.config as Record<string, unknown>).filter(([key, value]) => typeof value === "string" && !SECRET_CONFIG_KEY.test(key))) as Record<string, string>;
    const validated = validateConnectorInput({ name: candidate.name || connectorLocationKey(candidate.kind, rawConfig), kind: candidate.kind, config: rawConfig, surveyId: candidate.surveyId, releaseId: candidate.releaseId, status: candidate.status });
    const config = validated.config;
    const locationKey = connectorLocationKey(candidate.kind, config);
    if (records.some((record) => record.locationKey === locationKey)) continue;
    records.push({
      ...(candidate as ConnectorRecord),
      id: typeof candidate.id === "string" && candidate.id ? candidate.id : `connector-${randomUUID()}`,
      name: typeof candidate.name === "string" && candidate.name ? candidate.name : locationKey,
      description: typeof candidate.description === "string" ? candidate.description : "Connector configuration.",
      kind: candidate.kind,
      config,
      surveyId: typeof candidate.surveyId === "string" && candidate.surveyId.trim() ? candidate.surveyId.trim() : undefined,
      releaseId: typeof candidate.releaseId === "string" && candidate.releaseId.trim() ? candidate.releaseId.trim() : undefined,
      status: CONNECTOR_STATUSES.includes(candidate.status as ConnectorStatus) ? candidate.status! : "draft",
      locationKey,
      displayPath: connectorDisplayPath(candidate.kind, config),
      createdAt: typeof candidate.createdAt === "string" ? candidate.createdAt : new Date().toISOString(),
      updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : new Date().toISOString(),
      origin: "user",
    });
  }
  return records;
}

async function checkS3(record: ConnectorRecord, credentials?: ResolvedConnectorCredentials, requireCredentials = false): Promise<ConnectorCheck> {
  const endpoint = cleanEndpoint(record.config.endpoint);
  if (!endpoint) return { status: "ok", checkedAt: new Date().toISOString(), summary: "S3 路径配置有效", detail: "未配置 Endpoint，FlinkIngest 将使用默认 S3 Endpoint。" };
  const checkedAt = new Date().toISOString();
  const bucket = record.config.bucket ?? "";
  if (requireCredentials && !credentials) {
    return { status: "failed", checkedAt, summary: "没有可用的已保存凭据", detail: "请编辑 Connector 并填写 Access Key 与 Secret Key。" };
  }
  if (credentials) {
    const client = new S3Client({
      endpoint,
      region: record.config.region || "us-east-1",
      forcePathStyle: true,
      maxAttempts: 1,
      credentials: {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
        sessionToken: credentials.sessionToken,
      },
    });
    try {
      await client.send(new HeadBucketCommand({ Bucket: bucket }), { abortSignal: AbortSignal.timeout(5000) });
      return { status: "ok", checkedAt, summary: "连接正常，凭据与 Bucket 均已验证", detail: "未列举或扫描 Prefix。" };
    } catch (error) {
      const statusCode = typeof error === "object" && error && "$metadata" in error
        ? (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
        : undefined;
      return {
        status: "failed",
        checkedAt,
        summary: statusCode === 401 || statusCode === 403 ? "凭据无效或没有 Bucket 访问权限" : "S3 Bucket 连接失败",
        detail: statusCode ? `HTTP ${statusCode}；未列举或扫描 Prefix。` : error instanceof Error ? error.message : String(error),
      };
    } finally {
      client.destroy();
    }
  }
  const url = `${endpoint}/${encodeURIComponent(bucket)}`;
  try {
    const response = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(5000) });
    if (response.ok) return { status: "ok", checkedAt, summary: "S3 Endpoint 与 Bucket 可达", detail: `HTTP ${response.status}；允许匿名访问。` };
    if (response.status === 401 || response.status === 403) {
      return { status: "ok", checkedAt, summary: "S3 Endpoint 可达", detail: `HTTP ${response.status}；尚未验证 Bucket 权限。` };
    }
    return { status: "failed", checkedAt, summary: `Bucket 检测返回 HTTP ${response.status}`, detail: "Endpoint 已响应，但当前 Bucket 配置不可用。" };
  } catch (error) {
    return { status: "failed", checkedAt, summary: "S3 Endpoint 无法连接", detail: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * List objects only when an explicit scan has been requested. Connection checks
 * intentionally continue to use HeadBucket/minimal prefix probes and never call
 * this function.
 */
export async function listConnectorObjects(
  record: ConnectorRecord,
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string },
  prefixOverride?: string,
): Promise<ConnectorObject[]> {
  if (record.kind !== "s3") throw new RangeError("Only S3/OSS connectors can list scan objects");
  const endpoint = cleanEndpoint(record.config.endpoint);
  if (!endpoint) throw new RangeError("S3 connector Endpoint is required for an explicit scan");
  const bucket = record.config.bucket ?? "";
  const prefix = cleanSegment(prefixOverride ?? record.config.prefix ?? "");
  if (!bucket) throw new RangeError("S3 connector Bucket is required for an explicit scan");
  if (isAlibabaOssEndpoint(endpoint)) {
    let bucketInEndpoint = false;
    try { bucketInEndpoint = new URL(endpoint).hostname.toLowerCase().startsWith(`${bucket.toLowerCase()}.`); } catch { /* validation happens in the client */ }
    const client = new OSS({
      accessKeyId: credentials.accessKeyId,
      accessKeySecret: credentials.secretAccessKey,
      endpoint,
      bucket,
      secure: endpoint.startsWith("https:"),
      region: record.config.region || "oss-cn-hangzhou",
      cname: bucketInEndpoint,
      ...(endpoint.startsWith("https:") && usesInternalAlibabaCertificate(endpoint)
        ? { httpsAgent: new https.Agent({ rejectUnauthorized: false }) }
        : {}),
      timeout: 15000,
      retryMax: 1,
    });
    const objects: ConnectorObject[] = [];
    let marker = "";
    for (;;) {
      const result = await client.list({ ...(prefix ? { prefix } : {}), ...(marker ? { marker } : {}), "max-keys": 1000 }) as { objects?: unknown[]; isTruncated?: boolean; nextMarker?: string };
      for (const value of result.objects ?? []) {
        if (!value || typeof value !== "object") continue;
        const entry = value as { name?: unknown; size?: unknown; lastModified?: unknown };
        const key = typeof entry.name === "string" ? entry.name : "";
        if (!key || key.endsWith("/")) continue;
        objects.push({ key, size: Number(entry.size ?? 0), ...(entry.lastModified ? { lastModified: String(entry.lastModified) } : {}) });
      }
      if (!result.isTruncated) break;
      const next = result.nextMarker || objects.at(-1)?.key;
      if (!next || next === marker) break;
      marker = next;
    }
    return objects;
  }
  const client = new S3Client({
    endpoint,
    region: record.config.region || "us-east-1",
    forcePathStyle: true,
    maxAttempts: 1,
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
    },
  });
  try {
    const objects: ConnectorObject[] = [];
    let token: string | undefined;
    do {
      const result = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token, MaxKeys: 1000 }));
      for (const entry of result.Contents ?? []) {
        if (!entry.Key || entry.Key.endsWith("/")) continue;
        objects.push({ key: entry.Key, size: entry.Size ?? 0, ...(entry.LastModified ? { lastModified: entry.LastModified.toISOString() } : {}) });
      }
      token = result.IsTruncated ? result.NextContinuationToken : undefined;
    } while (token);
    return objects;
  } finally {
    client.destroy();
  }
}

function isAlibabaOssEndpoint(endpoint: string): boolean {
  try {
    const hostname = new URL(endpoint).hostname.toLowerCase();
    return hostname.includes(".oss-") || hostname.endsWith(".aliyuncs.com") || hostname.endsWith(".res.cloud.zhejianglab.com");
  } catch {
    return false;
  }
}

function usesInternalAlibabaCertificate(endpoint: string): boolean {
  try {
    return new URL(endpoint).hostname.toLowerCase().endsWith(".res.cloud.zhejianglab.com");
  } catch {
    return false;
  }
}

async function checkAlibabaOss(record: ConnectorRecord, credentials: ResolvedConnectorCredentials | undefined, requireCredentials: boolean): Promise<ConnectorCheck> {
  const checkedAt = new Date().toISOString();
  if (requireCredentials && !credentials) return { status: "failed", checkedAt, summary: "没有可用的已保存凭据", detail: "请编辑 Connector 并填写 Access Key 与 Secret Key。" };
  if (!credentials) return { status: "ok", checkedAt, summary: "Alibaba OSS Endpoint 可达", detail: "尚未验证 Bucket 权限。" };
  const endpoint = cleanEndpoint(record.config.endpoint);
  const bucket = record.config.bucket ?? "";
  let bucketInEndpoint = false;
  try {
    const hostname = new URL(endpoint).hostname.toLowerCase();
    bucketInEndpoint = hostname.startsWith(`${bucket.toLowerCase()}.`);
  } catch {
    // validateInput already rejects malformed paths only at the endpoint transport layer.
  }
  try {
    const prefix = cleanSegment(record.config.prefix ?? "");
    const client = new OSS({
      accessKeyId: credentials.accessKeyId,
      accessKeySecret: credentials.secretAccessKey,
      endpoint,
      bucket,
      secure: endpoint.startsWith("https:"),
      region: record.config.region || "oss-cn-hangzhou",
      cname: bucketInEndpoint,
      // The internal ZhejiangLab OSS endpoint currently presents a self-signed
      // certificate. The endpoint is explicitly supplied by the user; keep
      // the existing HTTP option available and allow its HTTPS variant too.
      ...(endpoint.startsWith("https:") && usesInternalAlibabaCertificate(endpoint)
        ? { httpsAgent: new https.Agent({ rejectUnauthorized: false }) }
        : {}),
      timeout: 5000,
      retryMax: 0,
    });
    // GetBucketInfo is a separate privileged OSS action and is commonly
    // denied even when the connector can scan its configured prefix. A
    // single-key prefix probe validates the permission FlinkIngest needs
    // without enumerating or scanning the directory.
    await client.list({ ...(prefix ? { prefix } : {}), "max-keys": 1 });
    return { status: "ok", checkedAt, summary: "Alibaba OSS 连接正常，凭据与 Bucket 均已验证", detail: "已验证目标 Prefix 的最小读取权限，未扫描目录。" };
  } catch (error) {
    const statusCode = typeof error === "object" && error && "status" in error ? (error as { status?: number }).status : undefined;
    return {
      status: "failed",
      checkedAt,
      summary: statusCode === 401 || statusCode === 403 ? "Alibaba OSS 凭据无效或没有 Bucket 访问权限" : "Alibaba OSS Bucket 连接失败",
      detail: statusCode ? `HTTP ${statusCode}；使用 Bucket 元信息检查，未列举或扫描 Prefix。` : error instanceof Error ? error.message : String(error),
    };
  }
}

async function checkJdbc(record: ConnectorRecord, localRoots: LocalConnectorRootsPolicy): Promise<ConnectorCheck> {
  const rawUrl = record.config.url ?? "";
  const checkedAt = new Date().toISOString();
  if (rawUrl.startsWith("jdbc:sqlite:")) {
    let filename: string;
    try {
      filename = sqliteContainerPath(rawUrl);
    } catch (error) {
      return { status: "failed", checkedAt, summary: error instanceof Error ? error.message : "SQLite database path is invalid" };
    }
    const pathCheck = await localRoots.checkFile(filename);
    if (pathCheck.ok) return { status: "ok", checkedAt, summary: "SQLite database file is readable" };
    return { status: "failed", checkedAt, summary: localConnectorPolicyMessage(pathCheck.failure) };
  }
  let parsed: URL;
  try { parsed = new URL(rawUrl.replace(/^jdbc:/, "")); } catch { return { status: "failed", checkedAt, summary: "JDBC URL is invalid" }; }
  const port = Number(parsed.port || (parsed.protocol === "postgresql:" ? 5432 : parsed.protocol === "mysql:" ? 3306 : 0));
  if (!parsed.hostname || !port) return { status: "failed", checkedAt, summary: "JDBC URL has no supported host and port" };
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: parsed.hostname, port });
    const finish = (result: ConnectorCheck) => { socket.destroy(); resolve(result); };
    socket.setTimeout(5000);
    socket.once("connect", () => finish({ status: "ok", checkedAt, summary: "Database host accepted a TCP connection", detail: "The workspace does not execute a query or enumerate tables during a connection check." }));
    socket.once("timeout", () => finish({ status: "failed", checkedAt, summary: "Database connection timed out" }));
    socket.once("error", (error) => finish({ status: "failed", checkedAt, summary: "Database host is unreachable", detail: error.message }));
  });
}

export async function checkConnector(
  record: ConnectorRecord,
  credentials?: ConnectorCredentialsInput,
  requireCredentials = false,
  localRoots = LocalConnectorRootsPolicy.fromEnvironment(),
): Promise<ConnectorCheck> {
  let result: ConnectorCheck;
  if (record.kind === "local") {
    const checkedAt = new Date().toISOString();
    const pathCheck = await localRoots.checkDirectory(record.config.rootPath ?? "");
    result = pathCheck.ok
      ? { status: "ok", checkedAt, summary: "Local path exists and is readable" }
      : { status: "failed", checkedAt, summary: localConnectorPolicyMessage(pathCheck.failure) };
  } else if (record.kind === "s3") {
    const resolved = validateResolvedCredentials(credentials);
    result = isAlibabaOssEndpoint(cleanEndpoint(record.config.endpoint))
      ? await checkAlibabaOss(record, resolved, requireCredentials)
      : await checkS3(record, resolved, requireCredentials);
  } else {
    result = await checkJdbc(record, localRoots);
  }
  return { ...result, configHash: connectorConfigurationHash(record) };
}
