import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { connectorConfigurationHash, connectorLocationKey, hasCurrentSuccessfulConnectorCheck, type ConnectorRecord, type ConnectorRegistry } from "./connectors.js";
import type { ConnectorCredentialStore, StoredConnectorCredentials } from "./connector-credentials.js";
import { ConnectorIngestRunCatalog, type ConnectorIngestRunRecord, type ConnectorScanTargetSnapshot } from "./connector-history.js";
import { coverageJobSnapshot, scannerCoverageProperties, validateCoverageJobSnapshot, validateCoverageJobSubmission, type CoverageJobSnapshot } from "./coverage-jobs.js";
import type { DataAssetRecord, DataCatalogRegistry } from "./data-catalog.js";
import { DataWarehouseDisabledError, ConnectorScanCapabilityError, ConnectorScanPreconditionError, connectorScanPath, connectorScanTarget, type GenericScanInput } from "./scan-contract.js";
import type { UserMocArtifact, UserMocArtifactContext, UserMocArtifactStore, UserMocPrecision } from "./user-moc-artifacts.js";
import { defaultMocCoreAdapter, type MocCoreAdapter } from "./moc-core-adapter.js";
import { WAREHOUSE_FILE_INDEX } from "./warehouse-index.js";
import { assetsCoreContext } from "./assets-core.js";

export const WAREHOUSE_SCAN_API = "/apis/atlas.zhejianglab.org/v1alpha1";
export const WORKSPACE_TRACK_LABELS = {
  caller: "atlas.zhejianglab.org/track-caller",
  taskKind: "atlas.zhejianglab.org/track-task-kind",
  asset: "atlas.zhejianglab.org/track-asset",
  connector: "atlas.zhejianglab.org/track-connector",
  batch: "atlas.zhejianglab.org/track-batch",
} as const;

/** ScanPlan v2 requires an explicit object-store endpoint. Empty S3 connector
 * endpoints retain their existing AWS semantics through this auditable
 * default; S3-compatible/OSS connectors must configure their endpoint. */
export const DEFAULT_S3_ENDPOINT = "https://s3.amazonaws.com";

const WAREHOUSE_USERNAME_KEY = "warehouse-username";
const WAREHOUSE_PASSWORD_KEY = "warehouse-password";
const WAREHOUSE_USERNAME_ENV = "ATLAS_WAREHOUSE_USERNAME";
const WAREHOUSE_PASSWORD_ENV = "ATLAS_WAREHOUSE_PASSWORD";

/** Warehouse is an optional execution provider; the local Workspace remains usable when disabled. */
export function dataWarehouseEnabled(value = process.env.ASTRO_DATA_WAREHOUSE_ENABLED): boolean {
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new RangeError("ASTRO_DATA_WAREHOUSE_ENABLED must be true or false");
}

export function validateConnectorSelfScanBody(body: unknown): void {
  if (body !== undefined && (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).length > 0)) {
    throw new RangeError("Connector scan runs do not accept a request body");
  }
}

export interface WarehouseResourceClient {
  request<T>(method: string, path: string, body?: unknown): Promise<{ status: number; ok: boolean; value?: T; text: string }>;
}

interface KubernetesResource {
  metadata?: { name?: string; namespace?: string; labels?: Record<string, string>; resourceVersion?: string };
  status?: {
    phase?: string;
    reason?: string;
    message?: string;
    jobName?: string;
    summary?: Record<string, unknown>;
  };
}

interface KubernetesList<T> { items?: T[] }

export interface WarehouseScanServiceOptions {
  enabled: boolean;
  connectors: ConnectorRegistry;
  dataCatalog: DataCatalogRegistry;
  credentials: ConnectorCredentialStore;
  runs: ConnectorIngestRunCatalog;
  namespace: string;
  warehouseEsUrl: string;
  pollMs: number;
  evidenceClaimName?: string;
  evidenceMountPath?: string;
  scannerImage?: string;
  artifacts?: UserMocArtifactStore;
  mocCore?: MocCoreAdapter;
  resourceClient?: WarehouseResourceClient;
}

export interface WarehouseSinkCredentialBinding {
  secretName: string;
  usernameKey: string;
  passwordKey: string;
}

interface WarehouseEndpoint {
  endpoint: string;
  username?: string;
  password?: string;
}

function safeName(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "scan";
}

function taskName(prefix: string, identity: string, token: string): string {
  const suffix = `-${safeName(token)}`;
  return `${safeName(`${prefix}-${identity}`).slice(0, Math.max(1, 63 - suffix.length)).replace(/-+$/g, "")}${suffix}`;
}

function idempotencyKey(connector: ConnectorRecord, submission: ReturnType<typeof validateCoverageJobSubmission>, surveyId: string): string {
  const normalized = {
    contract: `workspace-scan-${assetsCoreContext().contractVersion}`,
    surveyId, releaseId: submission.releaseId, product: submission.product, connectorId: connector.id,
    connectorLocationKey: connector.locationKey, connectorConfigHash: connectorConfigurationHash(connector), path: submission.path ?? "",
    fileNamePattern: submission.fileNamePattern ?? "", allowedSuffixes: [...(submission.allowedSuffixes ?? [])].sort(), coverage: submission.coverage,
  };
  return `warehouse:${createHash("sha256").update(JSON.stringify(normalized)).digest("hex")}`;
}

function objectStoreLocation(uri: string): { bucket: string; prefix: string } {
  let parsed: URL;
  try { parsed = new URL(uri); } catch { throw new RangeError("scan source must be an S3 URI"); }
  if (parsed.protocol !== "s3:") throw new RangeError("scan source must be an S3 URI");
  const bucket = parsed.hostname.trim();
  const prefix = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  if (!bucket || bucket.includes("/") || prefix.split("/").some((part) => part === "." || part === "..")) throw new RangeError("scan source location is invalid");
  return { bucket, prefix };
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function snapshotHash(value: unknown): string | undefined {
  const result = textValue(value);
  return result && /^[a-f0-9]{64}$/i.test(result) ? result.toLowerCase() : undefined;
}

function evidenceDirectory(value: string | undefined, mountPath: string): string | undefined {
  const candidate = textValue(value);
  if (!candidate || !path.isAbsolute(candidate)) return undefined;
  const root = path.resolve(mountPath);
  const resolved = path.resolve(candidate);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`) ? resolved : undefined;
}

function artifactContextForRun(run: ConnectorIngestRunRecord): UserMocArtifactContext {
  const assetId = run.assetId ?? run.assetIds?.[0];
  return {
    layerId: run.warehouseLayerId ?? (assetId ? `workspace-${assetId}` : "workspace-scan"),
    scanRunId: run.id,
    ...(run.batchId ? { evidenceScanRunId: run.batchId } : {}),
    ...(run.coverageRole ?? run.coverage?.coverageRole ? { coverageRole: run.coverageRole ?? run.coverage?.coverageRole } : {}),
    ...(run.coverage?.dataOrigin ? { dataOrigin: run.coverage.dataOrigin } : {}),
    ...(run.coverage?.sourceTier ? { sourceTier: run.coverage.sourceTier } : {}),
    ...(run.sourceSnapshotSha256 ? { sourceSnapshotSha256: run.sourceSnapshotSha256 } : {}),
    ...(run.precision ? { precision: run.precision } : {}),
    ...(run.availableOrders ? { availableOrders: run.availableOrders } : {}),
    ...(run.maxOrder === undefined ? {} : { maxOrder: run.maxOrder }),
  };
}

function productId(value: string): string {
  const result = safeName(value).replace(/^-+|-+$/g, "");
  return result.slice(0, 180) || "user-product";
}

function layerId(asset: DataAssetRecord): string {
  return safeName(`workspace-${asset.id}`).slice(0, 180);
}

function warehouseCoverageRole(value: string | undefined, mode: string | undefined): "occupancy" | "footprint" {
  if (value === "image_extent" || value === "footprint_extent") return "footprint";
  if (value === "object_presence") return "occupancy";
  return mode === "fits-wcs" ? "footprint" : "occupancy";
}

function sourceConnectorEndpoint(connector: ConnectorRecord): string {
  const configured = typeof connector.config.endpoint === "string" ? connector.config.endpoint.trim().replace(/\/+$/, "") : "";
  const endpoint = configured || DEFAULT_S3_ENDPOINT;
  let parsed: URL;
  try { parsed = new URL(endpoint); } catch { throw new RangeError("S3 connector Endpoint must be a valid HTTP(S) URL"); }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) {
    throw new RangeError("S3 connector Endpoint must be a valid HTTP(S) URL");
  }
  if (parsed.username || parsed.password) {
    throw new RangeError("S3 connector Endpoint must not contain embedded credentials");
  }
  return parsed.toString().replace(/\/+$/, "");
}

function warehouseEndpoint(value: string): WarehouseEndpoint {
  const raw = value.trim().replace(/\/+$/, "");
  if (!raw) return { endpoint: "" };
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new RangeError("Warehouse Elasticsearch endpoint must be a valid HTTP(S) URL"); }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) {
    throw new RangeError("Warehouse Elasticsearch endpoint must be a valid HTTP(S) URL");
  }
  let username: string | undefined;
  let password: string | undefined;
  if (parsed.username || parsed.password) {
    try {
      username = decodeURIComponent(parsed.username);
      password = decodeURIComponent(parsed.password);
    } catch {
      throw new RangeError("Warehouse Elasticsearch endpoint credentials are invalid");
    }
    if (!username || !password) throw new RangeError("Warehouse Elasticsearch endpoint credentials require username and password");
    parsed.username = "";
    parsed.password = "";
  }
  return {
    endpoint: parsed.toString().replace(/\/+$/, ""),
    ...(username === undefined ? {} : { username, password }),
  };
}

function sourceConnectorPlan(connector: ConnectorRecord): Record<string, unknown> {
  const region = typeof connector.config.region === "string" ? connector.config.region.trim() : "";
  return {
    type: "s3",
    endpoint: sourceConnectorEndpoint(connector),
    ...(region ? { region } : {}),
    credentialRef: { accessKeyEnv: "ATLAS_SOURCE_ACCESS_KEY", secretKeyEnv: "ATLAS_SOURCE_SECRET_KEY" },
  };
}

/**
 * ScanPlan v2 represents automatic file-type discovery with an empty suffix
 * list. The scanner adapters compare suffixes literally, so emitting `*`
 * would select no objects rather than all supported files. Keep accepting the
 * historical wildcard input at the Workspace boundary, but normalize it
 * before the request reaches Warehouse.
 */
function warehouseIncludeSuffixes(value: string[] | undefined): string[] {
  if (value === undefined || value.length === 0) return [];
  if (!Array.isArray(value)) throw new RangeError("allowedSuffixes must be an array");
  const suffixes = value.map((entry, index) => {
    if (typeof entry !== "string" || !entry.trim()) throw new RangeError(`allowedSuffixes[${index}] must be a non-empty string`);
    return entry.trim();
  });
  if (suffixes.length === 1 && suffixes[0] === "*") return [];
  if (suffixes.some((suffix) => /[*?]/.test(suffix))) {
    throw new RangeError("allowedSuffixes must contain literal suffixes; use an empty list for automatic file detection");
  }
  return suffixes;
}

function extractionPlan(asset: DataAssetRecord, input: GenericScanInput, coverage?: CoverageJobSnapshot): Record<string, unknown> {
  if (coverage?.mode === "catalog-radec") {
    if (coverage.coverageRole !== "object_presence") {
      throw new RangeError("Warehouse ScanPlan v2 catalog-radec extraction requires coverageRole=object_presence");
    }
    return { mode: "catalog-radec", outputOrder: coverage.maxOrder, catalog: { raColumn: coverage.raColumn, decColumn: coverage.decColumn } };
  }
  if (coverage?.mode === "nested-healpix") {
    return { mode: "catalog-healpix", catalog: { healpixColumn: coverage.healpixColumn, healpixOrder: coverage.healpixOrder } };
  }
  if (coverage?.mode === "fits-wcs") return { mode: "fits-wcs", outputOrder: coverage.maxOrder };
  const spatial = input.spatial;
  if (spatial?.mode === "catalog") {
    if (!spatial.raColumn?.trim() || !spatial.decColumn?.trim()) {
      throw new RangeError("catalog spatial mode requires raColumn and decColumn");
    }
    return { mode: "catalog-radec", outputOrder: 8, catalog: { raColumn: spatial.raColumn, decColumn: spatial.decColumn } };
  }
  if (spatial?.mode === "healpix") {
    if (!spatial.healpixColumn?.trim()) throw new RangeError("healpix spatial mode requires healpixColumn");
    if (spatial.healpixOrder === undefined) {
      throw new RangeError("healpix spatial mode requires an explicit healpixOrder; it must not default to 8");
    }
    if (!Number.isInteger(spatial.healpixOrder) || spatial.healpixOrder < 0 || spatial.healpixOrder > 29) {
      throw new RangeError("spatial.healpixOrder must be an integer between 0 and 29");
    }
    return { mode: "catalog-healpix", catalog: { healpixColumn: spatial.healpixColumn, healpixOrder: spatial.healpixOrder } };
  }
  // Ordinary scans still produce FileAsset records, but only a header position
  // is allowed when no coverage recipe was supplied.
  return { mode: "fits-header-position", outputOrder: 8 };
}

export interface ScanRequestBuildInput {
  connector: ConnectorRecord;
  asset: DataAssetRecord;
  input: GenericScanInput;
  coverage?: CoverageJobSnapshot;
  taskName: string;
  batchId: string;
  secretName: string;
  namespace: string;
  warehouseEsUrl: string;
  evidenceClaimName: string;
  evidenceMountPath: string;
  scannerImage: string;
  warehouseSinkCredentials?: WarehouseSinkCredentialBinding;
}

/** Build a namespace-local ScanRequest using the Warehouse ScanPlan v2 contract. */
export function buildWorkspaceScanRequest(value: ScanRequestBuildInput): Record<string, unknown> {
  const { connector, asset, input, coverage, taskName: name, batchId, secretName, namespace, warehouseEsUrl, evidenceClaimName, evidenceMountPath, scannerImage, warehouseSinkCredentials } = value;
  if (input.fileNamePattern !== undefined || coverage?.fileNamePattern !== undefined) {
    throw new RangeError("fileNamePattern is not supported by Warehouse ScanPlan v2; use path and allowedSuffixes");
  }
  const sourceUri = connectorScanPath(connector, input.path);
  const location = objectStoreLocation(sourceUri);
  const surveyId = coverage?.surveyId ?? asset.surveyId ?? connector.surveyId ?? `workspace-${asset.id}`;
  const releaseId = coverage?.releaseId ?? asset.releaseId ?? connector.releaseId ?? "user";
  const product = coverage?.product ?? asset.product;
  const mode = coverage?.mode ?? input.spatial?.mode;
  const role = warehouseCoverageRole(coverage?.coverageRole, mode);
  const sourceProperties = coverage ? scannerCoverageProperties(coverage) : {};
  const warehouse = warehouseEndpoint(warehouseEsUrl);
  if (!warehouse.endpoint) throw new RangeError("Warehouse Elasticsearch endpoint is required");
  if ((warehouse.username || warehouse.password) && !warehouseSinkCredentials) {
    throw new RangeError("Warehouse Elasticsearch credentials require a secret binding");
  }
  const sinkCredentialRef = warehouseSinkCredentials
    ? { usernameEnv: WAREHOUSE_USERNAME_ENV, passwordEnv: WAREHOUSE_PASSWORD_ENV }
    : {};
  const plan = {
    version: 2,
    scanRunId: batchId,
    layer: {
      layerId: layerId(asset), surveyId: safeName(surveyId), releaseId: safeName(releaseId), productId: productId(coverage?.product ?? asset.product),
      modality: mode === "fits-wcs" ? "image" : "catalog", coverageRole: role, entrypoint: asset.access?.uri,
    },
    source: { connector: sourceConnectorPlan(connector), location },
    filters: { includeSuffixes: warehouseIncludeSuffixes(input.allowedSuffixes) },
    extraction: extractionPlan(asset, input, coverage),
    sink: { connector: { type: "elasticsearch", endpoint: warehouse.endpoint, credentialRef: sinkCredentialRef } },
    evidence: { outputPath: `${evidenceMountPath.replace(/\/+$/, "")}/${batchId}` },
  };
  const labels: Record<string, string> = {
    "app.kubernetes.io/managed-by": "astro-data-workspace",
    "astro.zhejianglab.org/atlas-task": "true",
    "astro.zhejianglab.org/atlas-task-kind": coverage ? "user_coverage" : "user_scan",
    "astro.zhejianglab.org/asset": asset.id,
    "astro.zhejianglab.org/connector": connector.id,
    "astro.zhejianglab.org/batch": batchId,
    [WORKSPACE_TRACK_LABELS.caller]: "workspace",
    [WORKSPACE_TRACK_LABELS.taskKind]: coverage ? "user-coverage" : "user-scan",
    [WORKSPACE_TRACK_LABELS.asset]: asset.id,
    [WORKSPACE_TRACK_LABELS.connector]: connector.id,
    [WORKSPACE_TRACK_LABELS.batch]: batchId,
  };
  const metadata = {
    name, namespace, labels,
    ...(Object.keys(sourceProperties).length ? { annotations: { "atlas.zhejianglab.org/scan-properties": JSON.stringify(sourceProperties) } } : {}),
  };
  return {
    apiVersion: "atlas.zhejianglab.org/v1alpha1", kind: "ScanRequest",
    metadata,
    spec: {
      scanner: { image: scannerImage, backoffLimit: 1, activeDeadlineSeconds: 86_400, ttlSecondsAfterFinished: 86_400, evidence: { claimName: evidenceClaimName, mountPath: evidenceMountPath } },
      credentials: {
        source: { secretName, accessKeyKey: "access-key", secretKeyKey: "secret-key" },
        sink: warehouseSinkCredentials ?? {},
      },
      plan,
    },
    // scannerCoverageProperties is kept in the local run for troubleshooting;
    // it is deliberately not added to the shared CRD's plan schema.
  };
}

class KubernetesResourceClient implements WarehouseResourceClient {
  readonly #apiUrl: string;
  readonly #tokenPath: string;
  constructor() {
    const host = process.env.KUBERNETES_SERVICE_HOST;
    const port = process.env.KUBERNETES_SERVICE_PORT_HTTPS ?? process.env.KUBERNETES_SERVICE_PORT ?? "443";
    if (!host) throw new Error("Kubernetes service environment is not configured");
    this.#apiUrl = `https://${host}:${port}`; this.#tokenPath = "/var/run/secrets/kubernetes.io/serviceaccount/token";
  }
  async request<T>(method: string, requestPath: string, body?: unknown): Promise<{ status: number; ok: boolean; value?: T; text: string }> {
    const token = (await readFile(this.#tokenPath, "utf8")).trim();
    const response = await fetch(`${this.#apiUrl}${requestPath}`, { method, headers: { Accept: "application/json", Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    const text = await response.text();
    let value: T | undefined; if (text) { try { value = JSON.parse(text) as T; } catch { /* preserve text for diagnostics */ } }
    return { status: response.status, ok: response.ok, value, text };
  }
}

export class WarehouseScanService {
  readonly #enabled: boolean;
  readonly #connectors: ConnectorRegistry;
  readonly #dataCatalog: DataCatalogRegistry;
  readonly #credentials: ConnectorCredentialStore;
  readonly #runs: ConnectorIngestRunCatalog;
  readonly #namespace: string;
  readonly #warehouseEsUrl: string;
  readonly #warehouseCredentials?: { username: string; password: string };
  readonly #pollMs: number;
  readonly #evidenceClaimName: string;
  readonly #evidenceMountPath: string;
  readonly #scannerImage: string;
  readonly #artifacts?: UserMocArtifactStore;
  readonly #mocCore: MocCoreAdapter;
  readonly #client?: WarehouseResourceClient;
  #timer: ReturnType<typeof setInterval> | undefined;
  #polling = false;

  constructor(options: WarehouseScanServiceOptions) {
    this.#enabled = options.enabled; this.#connectors = options.connectors; this.#dataCatalog = options.dataCatalog; this.#credentials = options.credentials; this.#runs = options.runs;
    this.#namespace = options.namespace;
    const warehouse = this.#enabled ? warehouseEndpoint(options.warehouseEsUrl) : { endpoint: "" };
    this.#warehouseEsUrl = warehouse.endpoint;
    this.#warehouseCredentials = warehouse.username && warehouse.password ? { username: warehouse.username, password: warehouse.password } : undefined;
    this.#pollMs = Math.max(1000, options.pollMs);
    this.#evidenceClaimName = options.evidenceClaimName ?? process.env.ASTRO_WAREHOUSE_EVIDENCE_CLAIM ?? "workspace-evidence";
    this.#evidenceMountPath = options.evidenceMountPath ?? process.env.ASTRO_WAREHOUSE_EVIDENCE_MOUNT_PATH ?? "/var/lib/atlas-evidence";
    this.#scannerImage = options.scannerImage ?? process.env.ASTRO_WAREHOUSE_SCANNER_IMAGE ?? "astro-atlas-scanner:latest";
    this.#artifacts = options.artifacts;
    this.#mocCore = options.mocCore ?? defaultMocCoreAdapter;
    this.#client = this.#enabled ? options.resourceClient ?? (process.env.KUBERNETES_SERVICE_HOST ? new KubernetesResourceClient() : undefined) : undefined;
  }

  get enabled(): boolean { return this.#enabled; }
  get configured(): boolean { return Boolean(this.#warehouseEsUrl); }

  start(): void { if (!this.#enabled || !this.#client) return; void this.poll(); this.#timer = setInterval(() => { void this.poll(); }, this.#pollMs); }
  stop(): void { if (this.#timer) clearInterval(this.#timer); this.#timer = undefined; }

  async submitScan(connectorId: string, input: GenericScanInput, idempotency?: string): Promise<ConnectorIngestRunRecord> {
    if (!this.#enabled) throw new DataWarehouseDisabledError();
    if (!this.#client) throw new Error("Warehouse scan submission is only available inside Kubernetes");
    if (!this.#warehouseEsUrl) throw new ConnectorScanPreconditionError("Warehouse Elasticsearch is not configured");
    const connector = await this.#connectors.get(connectorId); this.#assertScannable(connector);
    if (connector.kind !== "s3") throw new ConnectorScanCapabilityError(connector.kind);
    const asset = await this.#dataCatalog.get(input.assetId);
    if (asset.origin !== "user") throw new ConnectorScanPreconditionError("Only user assets can start an optional remote scan");
    const coverage = input.coverage ? validateCoverageJobSnapshot(input.coverage) : undefined;
    const stored = connector.credentialRef ? await this.#credentials.get(connector.credentialRef) : undefined;
    if (!stored?.accessKeyId || !stored.secretAccessKey) throw new ConnectorScanPreconditionError("Connector has no saved S3 credentials");
    const sourcePath = connectorScanPath(connector, input.path);
    const token = randomUUID().replace(/-/g, "").slice(0, 12);
    const batchId = `workspace-${coverage ? "coverage" : "scan"}-${token}`;
    const name = taskName(coverage ? "workspace-coverage" : "workspace-scan", asset.id, token);
    const secretName = `workspace-scan-${safeName(asset.id).slice(0, 35)}-${token}`.slice(0, 63).replace(/-+$/g, "");
    const created = await this.#runs.create(connector.locationKey, {
      connectorId: connector.id, connectorName: connector.name, connectorKind: connector.kind, executor: "warehouse-scan", backend: "warehouse", taskKind: coverage ? "user_coverage" : "user_scan",
      target: { ...connectorScanTarget(connector), uri: sourcePath }, assetIds: [asset.id], assetId: asset.id, assetName: asset.name, jobId: name, batchId, status: "queued", fileCount: 0,
      sourcePath, esIndex: WAREHOUSE_FILE_INDEX, warehouseLayerId: layerId(asset), secretName,
      evidencePath: `${this.#evidenceMountPath.replace(/\/+$/, "")}/${batchId}`,
      ...(coverage ? { coverage } : {}), ...(coverage ? { coverageRole: coverage.coverageRole, maxOrder: coverage.maxOrder, availableOrders: [], precision: "exact" as UserMocPrecision } : {}),
      mocStatus: "pending",
    }, idempotency);
    const run = created.run;
    if (!created.created) return run;
    const artifactContext = {
      layerId: layerId(asset),
      scanRunId: run.id,
      coverageRole: coverage?.coverageRole,
      maxOrder: coverage?.maxOrder,
      availableOrders: [],
      dataOrigin: coverage?.dataOrigin,
      sourceTier: coverage?.sourceTier,
      precision: "exact" as UserMocPrecision,
    };
    try {
      await this.#artifacts?.createPending(artifactContext);
      await this.#createSecret(secretName, stored, sourceConnectorEndpoint(connector), batchId, this.#warehouseCredentials);
      await this.#createRequest({ connector, asset, input, coverage, taskName: name, batchId, secretName });
    } catch (error) {
      await this.#artifacts?.fail(artifactContext, error).catch(() => undefined);
      await this.#cleanupSecret(secretName);
      return this.#runs.update(run.id, { status: "failed", error: error instanceof Error ? error.message : String(error), completedAt: new Date().toISOString(), mocStatus: "failed" });
    }
    await this.poll(); return (await this.#runs.list({ connectorId: connector.id })).find((candidate) => candidate.id === run.id) ?? run;
  }

  async submitRemoteAssetScan(surveyId: string, input: unknown, key?: string): Promise<ConnectorIngestRunRecord> {
    if (!this.#enabled) throw new DataWarehouseDisabledError();
    const submission = validateCoverageJobSubmission(input); const connector = await this.#connectors.get(submission.connectorId); const asset = await this.#dataCatalog.get(submission.assetId);
    if (asset.origin !== "user") throw new ConnectorScanPreconditionError("Only user assets can start an optional remote scan");
    const linked = (asset.connectorIds ?? []).includes(connector.id) || (asset.connectorLocationKeys ?? []).includes(connector.locationKey) || [asset.access, ...(asset.accesses ?? [])].some((access) => access.connectorId === connector.id || access.uri === connector.locationKey);
    if (!linked) throw new ConnectorScanPreconditionError("Coverage asset must be linked to the selected Connector");
    if (asset.product !== submission.product) throw new ConnectorScanPreconditionError("Coverage product does not match the selected data asset");
    const coverage = coverageJobSnapshot(surveyId, submission); const allowedSuffixes = submission.allowedSuffixes ?? (coverage.mode === "fits-wcs" ? [".fits", ".fit", ".fits.gz"] : [".csv", ".tsv", ".fits", ".fit", ".fits.gz"]);
    return this.submitScan(submission.connectorId, { assetId: submission.assetId, ...(submission.path === undefined ? {} : { path: submission.path }), ...(submission.fileNamePattern === undefined ? {} : { fileNamePattern: submission.fileNamePattern }), allowedSuffixes, coverage }, key ?? idempotencyKey(connector, submission, surveyId));
  }

  async submitConnectorScan(connectorId: string, key?: string): Promise<ConnectorIngestRunRecord> {
    if (!this.#enabled) throw new DataWarehouseDisabledError();
    const connector = await this.#connectors.get(connectorId); this.#assertScannable(connector); if (connector.kind !== "s3") throw new ConnectorScanCapabilityError(connector.kind);
    const assets = (await this.#dataCatalog.list()).filter((asset) => asset.origin === "user" && ((asset.connectorIds ?? []).includes(connector.id) || (asset.connectorLocationKeys ?? []).includes(connector.locationKey)));
    if (assets.length > 1) {
      throw new ConnectorScanPreconditionError("Connector self-scan is ambiguous because it is linked to multiple user assets; submit a remote scan for one asset or unlink the extra assets");
    }
    const asset = assets[0] ?? await this.#dataCatalog.register({ name: connector.name, description: `Scanned catalog from ${connector.locationKey}.`, surveyId: connector.surveyId, releaseId: connector.releaseId, product: connector.name, kind: "catalog", modalities: ["catalog"], connector: "s3", sourceUri: connector.locationKey, format: "directory", connectorIds: [connector.id], connectorLocationKeys: [connector.locationKey], status: "ready", projectState: "acquired" });
    return this.submitScan(connectorId, { assetId: asset.id }, key);
  }

  async poll(): Promise<void> {
    if (!this.#enabled || !this.#client || this.#polling) return; this.#polling = true;
    try {
      for (const run of await this.#runs.list()) {
        const workspaceOwned = run.backend === "warehouse"
          && run.executor === "warehouse-scan"
          && Boolean(run.batchId?.startsWith("workspace-"))
          && Boolean(run.warehouseLayerId?.startsWith("workspace-"));
        if (workspaceOwned && run.jobId && (run.status === "queued" || run.status === "running")) await this.#pollRun(run);
      }
    }
    catch (error) { console.warn("Unable to refresh Warehouse ScanRequest", error instanceof Error ? error.message : error); }
    finally { this.#polling = false; }
  }

  async #pollRun(original: ConnectorIngestRunRecord): Promise<void> {
    const result = await this.#client!.request<KubernetesResource>("GET", `${WAREHOUSE_SCAN_API}/namespaces/${encodeURIComponent(this.#namespace)}/scanrequests/${encodeURIComponent(original.jobId!)}`);
    if (result.status === 404) return; if (!result.ok || !result.value) throw new Error(`Unable to read ScanRequest (HTTP ${result.status})`);
    const status = result.value.status ?? {}; const phase = (status.phase ?? "SUBMITTED").toUpperCase(); const summary = status.summary ?? {};
    const discoveredFiles = typeof summary.discoveredFiles === "number" ? summary.discoveredFiles : typeof summary.discoveredFileCount === "number" ? summary.discoveredFileCount : undefined;
    const coverageDocuments = typeof summary.coverageDocuments === "number" ? summary.coverageDocuments : typeof summary.coverageRecordCount === "number" ? summary.coverageRecordCount : undefined;
    const rawSnapshotHash = textValue(summary.sourceSnapshotSha256);
    const sourceSnapshotSha256 = snapshotHash(rawSnapshotHash);
    const invalidSnapshotHash = rawSnapshotHash !== undefined && sourceSnapshotSha256 === undefined;
    const summaryEvidencePath = textValue(summary.evidencePath);
    const availableOrders = Array.isArray(summary.availableOrders)
      ? summary.availableOrders.filter((value): value is number => Number.isSafeInteger(value) && value >= 0 && value <= 29)
      : undefined;
    const expectedLayerId = original.warehouseLayerId;
    const summaryRunId = textValue(summary.scanRunId);
    const summaryLayerId = textValue(summary.layerId);
    const summaryIdentityError = phase === "SUCCEEDED"
      ? !original.batchId || !expectedLayerId || summaryRunId !== original.batchId || summaryLayerId !== expectedLayerId
        ? "Warehouse ScanRequest succeeded with a mismatched scanner summary identity"
        : undefined
      : undefined;
    const terminalFailure = phase === "FAILED" || phase === "INVALID" || summaryIdentityError !== undefined;
    const terminalMessage = summaryIdentityError ?? textValue(status.message) ?? textValue(status.reason) ?? `Warehouse ScanRequest ${phase.toLowerCase()}`;
    const current = await this.#runs.update(original.id, {
      ...(discoveredFiles === undefined ? {} : { fileCount: discoveredFiles }),
      ...(coverageDocuments === undefined ? {} : { documentCount: coverageDocuments }),
      ...(summaryEvidencePath ? { evidencePath: summaryEvidencePath } : {}),
      ...(availableOrders ? { availableOrders } : {}),
      ...(sourceSnapshotSha256 ? { sourceSnapshotSha256 } : {}),
      ...(phase === "SUCCEEDED" && !summaryIdentityError ? { status: "succeeded", completedAt: new Date().toISOString(), error: undefined } : phase === "FAILED" || phase === "INVALID" || summaryIdentityError ? { status: "failed", error: terminalMessage, completedAt: new Date().toISOString(), mocStatus: "failed" as const } : { status: "running", error: undefined }),
    });
    const artifactContext = artifactContextForRun(current);
    if (terminalFailure) {
      const artifact = this.#artifacts ? await this.#artifacts.fail(artifactContext, terminalMessage) : undefined;
      await this.#runs.update(current.id, {
        ...(artifact ? { artifactId: artifact.id, mocStatus: artifact.status, availableOrders: artifact.availableOrders, maxOrder: artifact.maxOrder, precision: artifact.precision } : {}),
      });
      await this.#cleanupSecret(current.secretName);
      return;
    }
    if (phase === "SUCCEEDED") {
      const evidencePath = evidenceDirectory(summaryEvidencePath ?? current.evidencePath, this.#evidenceMountPath);
      const assetId = current.assetId ?? current.assetIds?.[0];
      let artifact: UserMocArtifact | undefined;
      let artifactError: string | undefined;
      let artifactUnavailable = false;
      if (!this.#artifacts) {
        artifactError = "Workspace user-MOC artifact storage is not configured";
        artifactUnavailable = true;
      } else if (!assetId) {
        artifactError = "Warehouse ScanRequest succeeded without a Workspace asset id";
      } else if (invalidSnapshotHash) {
        artifactError = "Warehouse ScanRequest returned an invalid source snapshot SHA-256";
      } else if (!evidencePath) {
        artifactError = "Warehouse ScanRequest succeeded without a valid evidencePath";
        artifactUnavailable = true;
      } else {
        try {
          artifact = await this.#artifacts.importEvidence(evidencePath, {
            ...artifactContext,
            layerId: current.warehouseLayerId ?? `workspace-${assetId}`,
            ...(current.batchId ? { evidenceScanRunId: current.batchId } : {}),
            sourceSnapshotSha256,
          }, this.#mocCore);
        } catch (error) {
          artifactError = error instanceof Error ? error.message : String(error);
          artifact = await this.#artifacts.fail(artifactContext, artifactError);
        }
        if (artifact.status !== "ready") artifactError = artifact.error ?? `Warehouse evidence import is ${artifact.status}`;
      }
      if (!artifact && this.#artifacts) artifact = await this.#artifacts.fail(artifactContext, artifactError ?? "Warehouse evidence import was unavailable", artifactUnavailable ? "unavailable" : "failed");
      await this.#runs.update(current.id, {
        ...(artifact ? { artifactId: artifact.id, mocStatus: artifact.status, availableOrders: artifact.availableOrders, maxOrder: artifact.maxOrder, precision: artifact.precision } : { mocStatus: "unavailable" as const }),
        ...(artifact?.sourceSnapshotSha256 ? { sourceSnapshotSha256: artifact.sourceSnapshotSha256 } : {}),
        ...(artifactError ? { error: artifactError } : {}),
      });
    }
    if (phase === "SUCCEEDED") await this.#cleanupSecret(current.secretName);
  }

  async #createSecret(name: string, credentials: StoredConnectorCredentials, endpoint: string, batchId: string, warehouseCredentials?: { username: string; password: string }): Promise<void> {
    const body = {
      metadata: { name, namespace: this.#namespace, labels: { "app.kubernetes.io/managed-by": "astro-data-workspace", "atlas.zhejianglab.org/track-caller": "workspace", "atlas.zhejianglab.org/track-batch": batchId } },
      type: "Opaque",
      stringData: {
        "access-key": credentials.accessKeyId,
        "secret-key": credentials.secretAccessKey,
        "s3-endpoint": endpoint,
        ...(warehouseCredentials ? { [WAREHOUSE_USERNAME_KEY]: warehouseCredentials.username, [WAREHOUSE_PASSWORD_KEY]: warehouseCredentials.password } : {}),
      },
    };
    const item = `/api/v1/namespaces/${encodeURIComponent(this.#namespace)}/secrets/${encodeURIComponent(name)}`; const current = await this.#client!.request<KubernetesResource>("GET", item);
    const result = current.status === 404 ? await this.#client!.request("POST", `/api/v1/namespaces/${encodeURIComponent(this.#namespace)}/secrets`, body) : await this.#client!.request("PUT", item, current.value?.metadata?.resourceVersion ? { ...body, metadata: { ...body.metadata, resourceVersion: current.value.metadata.resourceVersion } } : body);
    if (!result.ok && result.status !== 409) throw new Error(`Unable to create Workspace scan Secret (HTTP ${result.status}): ${result.text.slice(0, 240)}`);
  }

  async #cleanupSecret(name?: string): Promise<void> { if (!name || !this.#client) return; const response = await this.#client.request("DELETE", `/api/v1/namespaces/${encodeURIComponent(this.#namespace)}/secrets/${encodeURIComponent(name)}`); if (!response.ok && response.status !== 404) console.warn(`Unable to remove Workspace scan Secret ${name} (HTTP ${response.status})`); }

  async #createRequest(requestInput: { connector: ConnectorRecord; asset: DataAssetRecord; input: GenericScanInput; coverage?: CoverageJobSnapshot; taskName: string; batchId: string; secretName: string }): Promise<void> {
    const { secretName } = requestInput;
    const body = buildWorkspaceScanRequest({
      ...requestInput,
      namespace: this.#namespace,
      warehouseEsUrl: this.#warehouseEsUrl,
      evidenceClaimName: this.#evidenceClaimName,
      evidenceMountPath: this.#evidenceMountPath,
      scannerImage: this.#scannerImage,
      ...(this.#warehouseCredentials ? { warehouseSinkCredentials: { secretName, usernameKey: WAREHOUSE_USERNAME_KEY, passwordKey: WAREHOUSE_PASSWORD_KEY } } : {}),
    });
    const result = await this.#client!.request("POST", `${WAREHOUSE_SCAN_API}/namespaces/${encodeURIComponent(this.#namespace)}/scanrequests`, body); if (!result.ok) throw new Error(`Unable to create ScanRequest (HTTP ${result.status}): ${result.text.slice(0, 300)}`);
  }

  #assertScannable(connector: ConnectorRecord): void { if (connector.status === "disabled") throw new ConnectorScanPreconditionError("Disabled connectors cannot be scanned"); if (connector.kind !== "s3") throw new ConnectorScanCapabilityError(connector.kind); if (!this.#warehouseEsUrl) throw new ConnectorScanPreconditionError("Warehouse Elasticsearch is not configured"); sourceConnectorEndpoint(connector); if (!hasCurrentSuccessfulConnectorCheck(connector)) throw new ConnectorScanPreconditionError("Connector must have a current successful connection check for its current configuration before scanning"); }
}

export { DataWarehouseDisabledError, ConnectorScanCapabilityError, ConnectorScanPreconditionError };
