import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { connectorConfigurationHash, connectorLocationKey, hasCurrentSuccessfulConnectorCheck, listConnectorObjects, type ConnectorRecord } from "./connectors.js";
import type { ConnectorCredentialStore, StoredConnectorCredentials } from "./connector-credentials.js";
import { ConnectorIngestRunCatalog, type ConnectorIngestRunRecord, type ConnectorScanTargetSnapshot } from "./connector-history.js";
import { coverageJobSnapshot, scannerCoverageProperties, validateCoverageJobSnapshot, validateCoverageJobSubmission, type CoverageJobSnapshot } from "./coverage-jobs.js";
import type { DataAssetRecord, DataCatalogRegistry } from "./data-catalog.js";
import type { ConnectorRegistry } from "./connectors.js";
import { resolveDataOwnership, type EffectiveDataOwnership } from "./data-ownership.js";
import { assetsCoreContext } from "./assets-core.js";

const TASK_API = "/apis/org.zhejianglab.astro.metadata/v1alpha1";
const PILOT_ASSETS = [
  { assetId: "euclid-q1-mer-final", key: "cat", pattern: /EUC_MER_FINAL-CAT_TILE[^/]+\.fits$/i },
  { assetId: "euclid-q1-mer-cutouts-cat", key: "cutouts", pattern: /EUC_MER_FINAL-CUTOUTS-CAT_TILE[^/]+\.fits$/i },
  { assetId: "euclid-q1-mer-morph-cat", key: "morph", pattern: /EUC_MER_FINAL-MORPH-CAT_TILE[^/]+\.fits$/i },
] as const;

interface KubernetesResource {
  metadata?: { name?: string; namespace?: string; labels?: Record<string, string>; resourceVersion?: string };
  status?: {
    phase?: string;
    backend?: "job" | "flink";
    runId?: string;
    discoveredFiles?: number;
    processedHdus?: number;
    coverageDocuments?: number;
    objectDocuments?: number;
    startedAt?: string;
    completedAt?: string;
    message?: string;
  };
}

interface KubernetesList<T> { items?: T[]; }

export interface GenericScanInput {
  assetId: string;
  path?: string;
  fileNamePattern?: string;
  allowedSuffixes?: string[];
  spatial?: {
    mode?: "none" | "auto" | "catalog" | "healpix";
    raColumn?: string;
    decColumn?: string;
    /** Name of a NESTED HEALPix pixel column for catalogs without RA/Dec. */
    healpixColumn?: string;
    frame?: string;
    units?: string;
    coverageRole?: string;
    healpixOrder?: number;
  };
  /** Explicit survey coverage evidence; populated only by the coverage-job API. */
  coverage?: CoverageJobSnapshot;
}

export type LegacyConnectorScanCommand =
  | { mode: "pilot" }
  | { mode: "generic"; input: GenericScanInput };

export function validateConnectorSelfScanBody(body: unknown): void {
  if (body !== undefined && (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).length > 0)) {
    throw new RangeError("Connector scan runs do not accept a request body");
  }
}

export function parseLegacyConnectorScanCommand(body: unknown): LegacyConnectorScanCommand {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new RangeError("scan mode is required; use POST /api/connectors/:id/scan-runs for a connector self-scan");
  }
  const input = body as Partial<GenericScanInput> & { mode?: unknown };
  if (input.mode === "pilot") return { mode: "pilot" };
  if (input.mode !== "scan") {
    if (input.mode === undefined) throw new RangeError("scan mode is required; use POST /api/connectors/:id/scan-runs for a connector self-scan");
    throw new RangeError("scan mode must be pilot or scan");
  }
  if (typeof input.assetId !== "string" || !input.assetId.trim()) throw new RangeError("assetId is required for a legacy generic scan");
  const { mode: _mode, ...scanInput } = input;
  return { mode: "generic", input: scanInput as GenericScanInput };
}

export interface FlinkResourceClient {
  request<T>(method: string, path: string, body?: unknown): Promise<{ status: number; ok: boolean; value?: T; text: string }>;
}

export class DataWarehouseDisabledError extends Error {
  constructor() {
    super("Data warehouse is disabled");
    this.name = "DataWarehouseDisabledError";
  }
}

export class ConnectorScanCapabilityError extends Error {
  constructor(kind: ConnectorRecord["kind"]) {
    super(`Connector scan executor is not implemented for ${kind} connectors`);
    this.name = "ConnectorScanCapabilityError";
  }
}

export class ConnectorScanPreconditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectorScanPreconditionError";
  }
}

export function dataWarehouseEnabled(value = process.env.ASTRO_DATA_WAREHOUSE_ENABLED): boolean {
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new RangeError("ASTRO_DATA_WAREHOUSE_ENABLED must be true or false");
}

function coverageIdempotencyKey(connector: ConnectorRecord, submission: ReturnType<typeof validateCoverageJobSubmission>, surveyId: string): string {
  const normalized = {
    algorithmVersion: "astro-survey-assets-moc-core-v3",
    scannerVersion: process.env.ASTRO_SCANNER_VERSION ?? "astro-survey-assets",
    surveyId,
    releaseId: submission.releaseId,
    product: submission.product,
    connectorId: connector.id,
    connectorLocationKey: connector.locationKey,
    connectorConfigHash: connectorConfigurationHash(connector),
    path: submission.path ?? "",
    fileNamePattern: submission.fileNamePattern ?? "",
    allowedSuffixes: [...(submission.allowedSuffixes ?? [])].sort(),
    coverage: submission.coverage,
  };
  return `coverage:${createHash("sha256").update(JSON.stringify(normalized)).digest("hex")}`;
}

class KubernetesResourceClient implements FlinkResourceClient {
  readonly #apiUrl: string;
  readonly #tokenPath: string;

  constructor() {
    const host = process.env.KUBERNETES_SERVICE_HOST;
    const port = process.env.KUBERNETES_SERVICE_PORT_HTTPS ?? process.env.KUBERNETES_SERVICE_PORT ?? "443";
    if (!host) throw new Error("Kubernetes service environment is not configured");
    this.#apiUrl = `https://${host}:${port}`;
    this.#tokenPath = "/var/run/secrets/kubernetes.io/serviceaccount/token";
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<{ status: number; ok: boolean; value?: T; text: string }> {
    const token = (await readFile(this.#tokenPath, "utf8")).trim();
    const response = await fetch(`${this.#apiUrl}${path}`, {
      method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    const text = await response.text();
    let value: T | undefined;
    if (text) {
      try { value = JSON.parse(text) as T; } catch { /* include the raw response in the error */ }
    }
    return { status: response.status, ok: response.ok, value, text };
  }
}

function safeName(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "scan";
}

function taskNameWithToken(prefix: string, identity: string, token: string): string {
  const suffix = `-${safeName(token)}`;
  const base = safeName(`${prefix}-${identity}`).slice(0, 63 - suffix.length).replace(/-+$/g, "");
  return `${base}${suffix}`;
}

function s3Uri(connector: ConnectorRecord, key: string): string {
  return `s3://${connector.config.bucket}/${key}`;
}

function cleanS3Value(value: string | undefined): string {
  return (value ?? "").trim().replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/");
}

export function connectorScanTarget(connector: ConnectorRecord): ConnectorScanTargetSnapshot {
  if (connector.kind !== "s3") throw new ConnectorScanCapabilityError(connector.kind);
  const bucket = cleanS3Value(connector.config.bucket).toLowerCase();
  const prefix = cleanS3Value(connector.config.prefix);
  if (!bucket || bucket.includes("/")) throw new RangeError("S3 connector bucket is invalid");
  if (prefix.split("/").some((segment) => segment === "." || segment === "..")) throw new RangeError("S3 connector prefix cannot contain dot segments");
  return { uri: connectorLocationKey("s3", { bucket, prefix }), bucket, prefix };
}

export function connectorScanPath(connector: ConnectorRecord, requested?: string): string {
  const base = cleanS3Value(connector.config.prefix);
  const raw = (requested ?? base).trim();
  if (!raw) throw new RangeError("scan path is required");
  if (/^s3a?:\/\//i.test(raw)) {
    const rawPath = raw.replace(/^s3a?:\/\/[^/]+/i, "").split(/[?#]/, 1)[0] ?? "";
    let decodedRawPath: string;
    try { decodedRawPath = decodeURIComponent(rawPath); } catch { throw new RangeError("scan path contains invalid escaping"); }
    if (decodedRawPath.split("/").some((segment) => segment === ".." || segment === ".")) {
      throw new RangeError("scan path cannot contain dot segments");
    }
    let parsed: URL;
    try { parsed = new URL(raw); } catch { throw new RangeError("scan path must be a valid S3 URI"); }
    if (parsed.search || parsed.hash || parsed.hostname.toLowerCase() !== cleanS3Value(connector.config.bucket).toLowerCase()) {
      throw new RangeError("scan path must stay inside the connector bucket");
    }
    const key = decodedRawPath.replace(/^\/+/, "");
    if (base && key !== base && !key.startsWith(`${base}/`)) throw new RangeError("scan path must stay inside the connector prefix");
    return s3Uri(connector, key);
  }
  const requestedKey = raw.replace(/^\/+/, "");
  if (requestedKey.split("/").some((segment) => segment === ".." || segment === ".")) {
    throw new RangeError("scan path cannot contain dot segments");
  }
  // Accept both a bucket-relative key and a path relative to the registered
  // connector prefix while keeping the scan inside that prefix.
  const key = base && requestedKey !== base && !requestedKey.startsWith(`${base}/`)
    ? `${base}/${requestedKey}`
    : requestedKey;
  if (base && key !== base && !key.startsWith(`${base}/`)) throw new RangeError("scan path must stay inside the connector prefix");
  return s3Uri(connector, key);
}

function statusFromTask(task: KubernetesResource): "queued" | "running" | "succeeded" | "failed" {
  const phase = task.status?.phase?.toLowerCase();
  if (phase === "succeeded") return "succeeded";
  if (phase === "failed") return "failed";
  if (phase === "pending") return "queued";
  return phase === "running" ? "running" : "queued";
}

export interface FlinkScanServiceOptions {
  enabled: boolean;
  connectors: ConnectorRegistry;
  dataCatalog: DataCatalogRegistry;
  credentials: ConnectorCredentialStore;
  runs: ConnectorIngestRunCatalog;
  namespace: string;
  secretNamespace: string;
  esUrl: string;
  esIndex: string;
  esObjectIndex?: string;
  esCoverageIndex?: string;
  pollMs: number;
  resourceClient?: FlinkResourceClient;
}

export class FlinkScanService {
  readonly #enabled: boolean;
  readonly #connectors: ConnectorRegistry;
  readonly #dataCatalog: DataCatalogRegistry;
  readonly #credentials: ConnectorCredentialStore;
  readonly #runs: ConnectorIngestRunCatalog;
  readonly #namespace: string;
  readonly #secretNamespace: string;
  readonly #esUrl: string;
  readonly #esIndex: string;
  readonly #esHost: string;
  readonly #esPort: number;
  readonly #esSchema: string;
  readonly #esObjectIndex: string;
  readonly #esCoverageIndex: string;
  readonly #client: FlinkResourceClient | undefined;
  readonly #pollMs: number;
  #timer: ReturnType<typeof setInterval> | undefined;
  #polling = false;

  constructor(options: FlinkScanServiceOptions) {
    this.#enabled = options.enabled;
    this.#connectors = options.connectors;
    this.#dataCatalog = options.dataCatalog;
    this.#credentials = options.credentials;
    this.#runs = options.runs;
    this.#namespace = options.namespace;
    this.#secretNamespace = options.secretNamespace;
    this.#esUrl = options.esUrl.replace(/\/+$/, "");
    this.#esIndex = options.esIndex;
    let parsedEsUrl: URL | undefined;
    try { parsedEsUrl = this.#esUrl ? new URL(this.#esUrl) : undefined; } catch { parsedEsUrl = undefined; }
    this.#esHost = process.env.ASTRO_FLINK_ES_HOST ?? parsedEsUrl?.hostname ?? "astro-search-elasticsearch.astro-data-workspace.svc.cluster.local";
    this.#esPort = Number(process.env.ASTRO_FLINK_ES_PORT ?? parsedEsUrl?.port ?? (parsedEsUrl?.protocol === "https:" ? 443 : 9200));
    this.#esSchema = process.env.ASTRO_FLINK_ES_SCHEMA ?? parsedEsUrl?.protocol.replace(":", "") ?? "http";
    this.#esObjectIndex = options.esObjectIndex ?? process.env.ASTRO_ES_OBJECT_INDEX ?? "astro_object_index_v1";
    this.#esCoverageIndex = options.esCoverageIndex ?? process.env.ASTRO_ES_COVERAGE_INDEX ?? "astro_coverage_index_v1";
    this.#pollMs = Math.max(1000, options.pollMs);
    this.#client = this.#enabled
      ? options.resourceClient ?? (process.env.KUBERNETES_SERVICE_HOST ? new KubernetesResourceClient() : undefined)
      : undefined;
  }

  start(): void {
    if (!this.#enabled || !this.#client) return;
    void this.poll();
    this.#timer = setInterval(() => { void this.poll(); }, this.#pollMs);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async submitPilot(connectorId: string): Promise<ConnectorIngestRunRecord[]> {
    if (!this.#enabled) throw new DataWarehouseDisabledError();
    if (!this.#client) throw new Error("Flink scan submission is only available inside Kubernetes");
    const connector = await this.#connectors.get(connectorId);
    if (connector.kind !== "s3") throw new ConnectorScanCapabilityError(connector.kind);
    this.#assertScannable(connector);
    const stored = connector.credentialRef ? await this.#credentials.get(connector.credentialRef) : undefined;
    if (!stored?.accessKeyId || !stored.secretAccessKey) throw new RangeError("Connector has no saved S3 credentials");

    const prefix = `${(connector.config.prefix ?? "").replace(/\/+$/, "")}/102018211`;
    const objects = await listConnectorObjects(connector, stored, prefix);
    const selected = PILOT_ASSETS.map((definition) => {
      const object = objects.find((candidate) => definition.pattern.test(candidate.key));
      if (!object) throw new Error(`Pilot object for ${definition.assetId} was not found under ${prefix}`);
      return { definition, object };
    });

    const token = randomUUID().replace(/-/g, "").slice(0, 12);
    const secretName = this.#scanSecretName(connector.id);
    await this.#createSecret(secretName, stored, connector.config.endpoint ?? stored.endpoint, token);
    const created: ConnectorIngestRunRecord[] = [];
    try {
      for (const entry of selected) {
        const asset = await this.#dataCatalog.get(entry.definition.assetId);
        const ownership = await this.#scanOwnership(asset, connector);
        const taskName = taskNameWithToken("euclid-q1-mer-pilot", entry.definition.key, token);
        const batchId = `workspace-pilot-${token}-${entry.definition.key}`;
        const run = await this.#runs.add(connector.locationKey, {
          connectorId: connector.id,
          connectorName: connector.name,
          connectorKind: connector.kind,
          executor: "flink-ingest",
          target: { ...connectorScanTarget(connector), uri: s3Uri(connector, entry.object.key) },
          assetIds: [asset.id],
          jobId: taskName,
          batchId,
          assetId: asset.id,
          assetName: asset.name,
          status: "queued",
          fileCount: 1,
          sourcePath: s3Uri(connector, entry.object.key),
          esIndex: this.#esIndex,
          secretName,
        });
        try {
          await this.#createTask({
            connector,
            asset,
            paths: [s3Uri(connector, entry.object.key)],
            allowedSuffixes: [".fits"],
            taskName,
            batchId,
            secretName,
            ownership,
          });
          created.push(run);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          created.push(await this.#runs.update(run.id, { status: "failed", error: message, completedAt: new Date().toISOString() }));
        }
      }
    } finally {
      await this.#cleanupSecret(secretName);
    }
    await this.poll();
    return created;
  }

  async submitScan(connectorId: string, input: GenericScanInput, idempotencyKey?: string): Promise<ConnectorIngestRunRecord> {
    if (!this.#enabled) throw new DataWarehouseDisabledError();
    if (!this.#client) throw new Error("Flink scan submission is only available inside Kubernetes");
    const connector = await this.#connectors.get(connectorId);
    if (connector.kind !== "s3") throw new ConnectorScanCapabilityError(connector.kind);
    this.#assertScannable(connector);
    const asset = await this.#dataCatalog.get(input.assetId);
    const ownership = await this.#scanOwnership(asset, connector);
    const coverage = input.coverage ? validateCoverageJobSnapshot(input.coverage) : undefined;
    const coverageSpatial = coverage
      ? coverage.mode === "catalog-radec"
          ? { mode: "catalog" as const, raColumn: coverage.raColumn, decColumn: coverage.decColumn, frame: coverage.coordinateFrame, units: coverage.coordinateUnits, coverageRole: coverage.coverageRole, healpixOrder: coverage.healpixOrder, maxOrder: coverage.maxOrder, queryOrder: coverage.queryOrder, previewOrder: coverage.previewOrder }
        : coverage.mode === "nested-healpix"
          ? { mode: "healpix" as const, healpixColumn: coverage.healpixColumn, frame: coverage.coordinateFrame, coverageRole: coverage.coverageRole, healpixOrder: coverage.healpixOrder, maxOrder: coverage.maxOrder, queryOrder: coverage.queryOrder, previewOrder: coverage.previewOrder }
          : { mode: "auto" as const, frame: coverage.coordinateFrame, coverageRole: coverage.coverageRole, maxOrder: coverage.maxOrder, queryOrder: coverage.queryOrder, previewOrder: coverage.previewOrder }
      : undefined;
    const spatial = coverageSpatial ?? input.spatial;
    const spatialMode = spatial?.mode ?? "auto";
    if (!["auto", "none", "catalog", "healpix"].includes(spatialMode)) throw new RangeError("spatial.mode must be auto, none, catalog, or healpix");
    if (spatialMode === "catalog" && (!spatial?.raColumn?.trim() || !spatial?.decColumn?.trim())) {
      throw new RangeError("catalog spatial mode requires raColumn and decColumn");
    }
    if (spatialMode === "healpix" && !spatial?.healpixColumn?.trim()) {
      throw new RangeError("healpix spatial mode requires healpixColumn");
    }
    if (spatial?.healpixOrder !== undefined && (!Number.isInteger(spatial.healpixOrder) || spatial.healpixOrder < 0 || spatial.healpixOrder > 29)) throw new RangeError("spatial.healpixOrder must be an integer between 0 and 29");
    const stored = connector.credentialRef ? await this.#credentials.get(connector.credentialRef) : undefined;
    if (!stored?.accessKeyId || !stored.secretAccessKey) throw new RangeError("Connector has no saved S3 credentials");
    const path = connectorScanPath(connector, input.path);
    const token = randomUUID().replace(/-/g, "").slice(0, 12);
    const secretName = this.#scanSecretName(connector.id);
    const taskName = taskNameWithToken(coverage ? "astro-coverage" : "astro-scan", asset.id, token);
    const batchId = `${coverage ? "workspace-coverage" : "workspace-scan"}-${token}`;
    const created = await this.#runs.create(connector.locationKey, {
      connectorId: connector.id,
      connectorName: connector.name,
      connectorKind: connector.kind,
      executor: coverage ? "flink-coverage" : "flink-ingest",
      target: { ...connectorScanTarget(connector), uri: path },
      assetIds: [asset.id],
      jobId: taskName,
      batchId,
      assetId: asset.id,
      assetName: asset.name,
      status: "queued",
      fileCount: 0,
      sourcePath: path,
      esIndex: this.#esIndex,
      secretName,
      ...(coverage ? { coverage } : {}),
    }, idempotencyKey);
    if (!created.created) return created.run;
    const run = created.run;
    try {
      await this.#createSecret(secretName, stored, connector.config.endpoint ?? stored.endpoint, token);
      await this.#createTask({
        connector,
        asset,
        paths: [path],
        allowedSuffixes: input.allowedSuffixes?.length ? input.allowedSuffixes : ["*"],
        fileNamePattern: input.fileNamePattern,
        spatial,
        coverage,
        taskName,
        batchId,
        secretName,
        ownership,
      });
    } catch (error) {
      await this.#runs.update(run.id, { status: "failed", error: error instanceof Error ? error.message : String(error), completedAt: new Date().toISOString() });
    }
    await this.#cleanupSecret(secretName);
    await this.poll();
    return (await this.#runs.list(connector.locationKey)).find((candidate) => candidate.id === run.id) ?? run;
  }

  /** Submit a coverage derivation after the HTTP layer has selected a survey. */
  async submitCoverageJob(surveyId: string, input: unknown, idempotencyKey?: string): Promise<ConnectorIngestRunRecord> {
    const submission = validateCoverageJobSubmission(input);
    const connector = await this.#connectors.get(submission.connectorId);
    const asset = await this.#dataCatalog.get(submission.assetId);
    const linked = (asset.connectorIds ?? []).includes(connector.id)
      || (asset.connectorLocationKeys ?? []).includes(connector.locationKey)
      || [asset.access, ...(asset.accesses ?? [])].some((access) => access.connectorId === connector.id || access.uri === connector.locationKey);
    if (!linked) throw new ConnectorScanPreconditionError("Coverage asset must be linked to the selected Connector");
    if (connector.surveyId !== surveyId || connector.releaseId !== submission.releaseId) {
      throw new ConnectorScanPreconditionError("Connector survey/release binding does not match the coverage request");
    }
    if (asset.product !== submission.product) throw new ConnectorScanPreconditionError("Coverage product does not match the selected data asset");
    const ownership = await this.#scanOwnership(asset, connector);
    if (ownership.surveyId !== surveyId || ownership.releaseId !== submission.releaseId) {
      throw new ConnectorScanPreconditionError("Coverage asset ownership does not match the requested survey release");
    }
    const coverage = coverageJobSnapshot(surveyId, submission);
    const allowedSuffixes = submission.allowedSuffixes ?? (coverage.mode === "fits-wcs"
      ? [".fits", ".fit", ".fits.gz"]
      : [".csv", ".tsv", ".fits", ".fit", ".fits.gz"]);
    return this.submitScan(submission.connectorId, {
      assetId: submission.assetId,
      ...(submission.path === undefined ? {} : { path: submission.path }),
      ...(submission.fileNamePattern === undefined ? {} : { fileNamePattern: submission.fileNamePattern }),
      allowedSuffixes,
      coverage,
    }, idempotencyKey ?? coverageIdempotencyKey(connector, submission, surveyId));
  }

  async submitConnectorScan(connectorId: string, idempotencyKey?: string): Promise<ConnectorIngestRunRecord> {
    const connector = await this.#connectors.get(connectorId);
    if (connector.status === "disabled") throw new ConnectorScanPreconditionError("Disabled connectors cannot be scanned");
    if (connector.kind !== "s3") throw new ConnectorScanCapabilityError(connector.kind);
    this.#assertScannable(connector);
    if (!this.#enabled) throw new DataWarehouseDisabledError();
    if (!this.#client) throw new Error("Flink scan submission is only available inside Kubernetes");
    const stored = connector.credentialRef ? await this.#credentials.get(connector.credentialRef) : undefined;
    if (!stored?.accessKeyId || !stored.secretAccessKey) throw new ConnectorScanPreconditionError("Connector has no saved S3 credentials");
    if (idempotencyKey !== undefined) {
      const existing = await this.#runs.findIdempotent(connector.id, idempotencyKey);
      if (existing) return existing;
    }

    const target = connectorScanTarget(connector);
    const assets = await this.#ensureScanAssets(connector, target);
    const assetIds = [...new Set(assets.map((asset) => asset.id))].sort();
    const token = randomUUID().replace(/-/g, "").slice(0, 12);
    const secretName = this.#scanSecretName(connector.id);
    const taskName = taskNameWithToken("astro-connector-scan", connector.id, token);
    const batchId = `workspace-connector-scan-${token}`;
    const created = await this.#runs.create(connector.locationKey, {
      connectorId: connector.id,
      connectorName: connector.name,
      connectorKind: connector.kind,
      executor: "flink-ingest",
      target,
      assetIds,
      jobId: taskName,
      batchId,
      status: "queued",
      fileCount: 0,
      sourcePath: target.uri,
      esIndex: this.#esIndex,
      secretName,
    }, idempotencyKey);
    if (!created.created) return created.run;

    let run = created.run;
    try {
      await this.#createSecret(secretName, stored, connector.config.endpoint ?? stored.endpoint, token);
      await this.#createConnectorTask({ connector, assets, path: target.uri, taskName, batchId, secretName });
    } catch (error) {
      run = await this.#runs.update(run.id, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        completedAt: new Date().toISOString(),
      });
    }
    await this.#cleanupSecret(secretName);
    await this.poll();
    return (await this.#runs.list({ connectorId: connector.id })).find((candidate) => candidate.id === run.id) ?? run;
  }

  async poll(): Promise<void> {
    if (!this.#enabled || !this.#client || this.#polling) return;
    this.#polling = true;
    try {
      for (const run of await this.#runs.list()) {
        if (!run.jobId || (run.status !== "queued" && run.status !== "running")) continue;
        try {
          await this.#pollRun(run);
        } catch (error) {
          console.warn(`Unable to refresh external Flink task ${run.jobId}; keeping stored status`, error instanceof Error ? error.message : error);
        }
      }
    } finally {
      this.#polling = false;
    }
  }

  async #pollRun(run: ConnectorIngestRunRecord): Promise<void> {
    const result = await this.#client!.request<KubernetesResource>("GET", `${TASK_API}/namespaces/${encodeURIComponent(this.#namespace)}/astrometadatascantasks/${encodeURIComponent(run.jobId!)}`);
    if (result.status === 404) return;
    if (!result.ok || !result.value) {
      throw new Error(`Unable to read AstroMetadataScanTask (HTTP ${result.status})`);
    }
    const actualRunId = result.value.status?.runId?.trim();
    if (actualRunId && actualRunId !== run.batchId) {
      run = await this.#runs.update(run.id, { batchId: actualRunId });
    }
    const discoveredFiles = result.value.status?.discoveredFiles;
    if (Number.isInteger(discoveredFiles) && discoveredFiles! >= 0 && discoveredFiles !== run.fileCount) {
      run = await this.#runs.update(run.id, { fileCount: discoveredFiles });
    }
    const nextStatus = statusFromTask(result.value);
    if (nextStatus === "succeeded") {
      try {
        const documentCount = await this.#countDocuments(run.batchId ?? "");
        if (documentCount === 0 && (run.fileCount ?? 0) > 0) {
          await this.#runs.update(run.id, { status: "failed", documentCount, error: `Flink finished but ${this.#esIndex} contains no documents for batch ${run.batchId}`, completedAt: new Date().toISOString() });
        } else {
          await this.#runs.update(run.id, { status: "succeeded", documentCount, completedAt: new Date().toISOString(), error: undefined });
        }
      } catch (error) {
        await this.#runs.update(run.id, { status: "failed", error: error instanceof Error ? error.message : String(error), completedAt: new Date().toISOString() });
      }
      await this.#cleanupSecret(run.secretName);
      return;
    }
    if (nextStatus === "failed") {
      await this.#runs.update(run.id, { status: "failed", error: result.value.status?.message || "AstroMetadataScanTask failed", completedAt: new Date().toISOString() });
      await this.#cleanupSecret(run.secretName);
      return;
    }
    await this.#runs.update(run.id, { status: "running", error: undefined });
  }

  async #countDocuments(batchId: string): Promise<number> {
    if (!batchId) return 0;
    let lastError: unknown;
    // A finished Flink job can be observed a little before ES has completed the
    // final bulk request.  Treat that interval as eventual consistency rather
    // than turning a healthy scan into a permanent failure.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const response = await fetch(`${this.#esUrl}/${encodeURIComponent(this.#esIndex)}/_count`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: { bool: { filter: [{ term: { scan_run_id: batchId } }] } } }),
          signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) throw new Error(`Elasticsearch count failed (HTTP ${response.status})`);
        const value = await response.json() as { count?: unknown };
        const count = Number(value.count ?? 0);
        if (!Number.isInteger(count) || count < 0) throw new Error("Elasticsearch returned an invalid document count");
        if (count > 0 || attempt === 3) return count;
      } catch (error) {
        lastError = error;
        if (attempt === 3) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
    }
    throw lastError instanceof Error ? lastError : new Error("Unable to count Elasticsearch documents");
  }

  async #createSecret(name: string, credentials: StoredConnectorCredentials, endpoint: string, token: string): Promise<void> {
    const body = {
      metadata: {
        name,
        namespace: this.#secretNamespace,
        labels: {
          "app.kubernetes.io/managed-by": "astro-data-workspace",
          "astro.zhejianglab.org/scan-secret": "true",
          "astro.zhejianglab.org/scan-token": token,
        },
      },
      type: "Opaque",
      stringData: { "access-key": credentials.accessKeyId, "secret-key": credentials.secretAccessKey, "s3-endpoint": endpoint },
    };
    const itemPath = `/api/v1/namespaces/${encodeURIComponent(this.#secretNamespace)}/secrets/${encodeURIComponent(name)}`;
    const current = await this.#client!.request<KubernetesResource>("GET", itemPath);
    const result = current.status === 404
      ? await this.#client!.request("POST", `/api/v1/namespaces/${encodeURIComponent(this.#secretNamespace)}/secrets`, body)
      : await this.#client!.request("PUT", itemPath, current.value?.metadata?.resourceVersion
        ? { ...body, metadata: { ...body.metadata, resourceVersion: current.value.metadata.resourceVersion } }
        : body);
    if (!result.ok && result.status !== 409) throw new Error(`Unable to register scan Secret (HTTP ${result.status}): ${result.text.slice(0, 240)}`);
  }

  async #cleanupSecret(name?: string): Promise<void> {
    if (!name || !this.#client) return;
    if (name.startsWith("astro-connector-scan-")) return;
    const active = (await this.#runs.list()).some((run) => run.secretName === name && (run.status === "queued" || run.status === "running"));
    if (active) return;
    const result = await this.#client.request("DELETE", `/api/v1/namespaces/${encodeURIComponent(this.#secretNamespace)}/secrets/${encodeURIComponent(name)}`);
    if (!result.ok && result.status !== 404) console.warn(`Unable to remove scan Secret ${name} (HTTP ${result.status})`);
  }

  #scanSecretName(connectorId: string): string {
    const suffix = safeName(connectorId).slice(0, 45).replace(/-+$/g, "");
    return `astro-connector-scan-${suffix}`.slice(0, 63).replace(/-+$/g, "");
  }

  async #createTask(input: {
    connector: ConnectorRecord;
    asset: DataAssetRecord;
    paths: string[];
    fileNamePattern?: string;
    allowedSuffixes: string[];
    spatial?: GenericScanInput["spatial"];
    coverage?: CoverageJobSnapshot;
    ownership: EffectiveDataOwnership;
    taskName: string;
    batchId: string;
    secretName: string;
  }): Promise<void> {
    const { connector, asset, paths, allowedSuffixes, fileNamePattern, spatial, coverage, taskName, batchId, secretName, ownership } = input;
    const astro = spatial ?? {};
    const scannerSpatial = coverage ? scannerCoverageProperties(coverage) : {
      ...(astro.mode ? { spatialMode: astro.mode } : {}),
      ...(astro.raColumn ? { raColumn: astro.raColumn } : {}),
      ...(astro.decColumn ? { decColumn: astro.decColumn } : {}),
      ...(astro.healpixColumn ? { healpixColumn: astro.healpixColumn } : {}),
      ...(astro.frame ? { coordinateFrame: astro.frame } : {}),
      ...(astro.units ? { coordinateUnits: astro.units } : {}),
      ...(astro.coverageRole ? { coverageRole: astro.coverageRole } : {}),
      ...(astro.healpixOrder === undefined ? {} : { inputHealpixOrder: String(astro.healpixOrder) }),
      ...(fileNamePattern ? { fileNamePattern } : {}),
    };
    const body = {
      apiVersion: "org.zhejianglab.astro.metadata/v1alpha1",
      kind: "AstroMetadataScanTask",
      metadata: {
        name: taskName,
        namespace: this.#namespace,
        labels: {
          "app.kubernetes.io/managed-by": "astro-data-workspace",
          "astro.zhejianglab.org/connector": connector.id,
          "astro.zhejianglab.org/asset": asset.id,
          "astro.zhejianglab.org/batch": batchId,
        },
      },
      spec: {
        backend: "job",
        source: { dataSourceRef: { name: connector.id }, paths },
        ...(fileNamePattern ? { fileNamePattern } : {}),
        handlers: ["default", "fits", "coverage", ...(spatial?.mode === "catalog" ? ["object"] : [])],
        tags: asset.tags ?? asset.modalities,
        userProperties: {
          ...Object.fromEntries(Object.entries({
            survey: ownership.surveyId ?? "", release: ownership.releaseId ?? "", product: asset.product,
            modality: asset.modalities.join("+"), assetId: asset.id, connector: connector.locationKey,
            connectorConfigHash: connectorConfigurationHash(connector),
            mocCoreDistribution: assetsCoreContext().distribution,
            mocCoreImport: assetsCoreContext().importName,
            mocCoreCli: assetsCoreContext().cli,
            mocCoreContract: assetsCoreContext().contractVersion,
            fileIndex: this.#esIndex, coverageIndex: this.#esCoverageIndex, objectIndex: this.#esObjectIndex,
            ...scannerSpatial,
          }).filter(([, value]) => value !== "")),
        },
        pathPatterns: {},
        sink: { dataSourceRef: { name: `${connector.id}-sink` } },
        extraEnv: {
          allowedSuffixes: allowedSuffixes.join(","),
          batchId,
        },
        
      },
    };
    await this.#ensureAstroDataSources(connector, secretName);
    const result = await this.#client!.request("POST", `${TASK_API}/namespaces/${encodeURIComponent(this.#namespace)}/astrometadatascantasks`, body);
    if (!result.ok) throw new Error(`Unable to create AstroMetadataScanTask (HTTP ${result.status}): ${result.text.slice(0, 240)}`);
  }

  async #createConnectorTask(input: {
    connector: ConnectorRecord;
    assets: DataAssetRecord[];
    path: string;
    taskName: string;
    batchId: string;
    secretName: string;
  }): Promise<void> {
    const { connector, assets, path, taskName, batchId, secretName } = input;
    const assetIds = [...new Set(assets.map((asset) => asset.id))].sort();
    const tags = [...new Set(assets.flatMap((asset) => asset.tags ?? asset.modalities))].sort();
    const modalities = [...new Set(assets.flatMap((asset) => asset.modalities))].sort();
    const body = {
      apiVersion: "org.zhejianglab.astro.metadata/v1alpha1",
      kind: "AstroMetadataScanTask",
      metadata: {
        name: taskName,
        namespace: this.#namespace,
        labels: {
          "app.kubernetes.io/managed-by": "astro-data-workspace",
          "astro.zhejianglab.org/connector": connector.id,
          "astro.zhejianglab.org/batch": batchId,
          ...(assetIds.length === 1 ? { "astro.zhejianglab.org/asset": assetIds[0] } : {}),
        },
      },
      spec: {
        backend: "job",
        source: { dataSourceRef: { name: connector.id }, paths: [path] },
        handlers: ["default", "fits", "coverage"],
        tags,
        userProperties: {
          survey: connector.surveyId ?? "",
          release: connector.releaseId ?? "",
          product: assets.length === 1 ? assets[0]!.product : connector.name,
          modality: modalities.join("+"),
          assetId: assetIds.length === 1 ? assetIds[0] : "",
          connectorLocationKey: connector.locationKey,
          fileIndex: this.#esIndex,
          coverageIndex: this.#esCoverageIndex,
          objectIndex: this.#esObjectIndex,
          mocCoreDistribution: assetsCoreContext().distribution,
          mocCoreImport: assetsCoreContext().importName,
          mocCoreCli: assetsCoreContext().cli,
          mocCoreContract: assetsCoreContext().contractVersion,
        },
        sink: { dataSourceRef: { name: `${connector.id}-sink` } },
        extraEnv: {
          batchId,
        },
      },
    };
    await this.#ensureAstroDataSources(connector, secretName);
    const result = await this.#client!.request("POST", `${TASK_API}/namespaces/${encodeURIComponent(this.#namespace)}/astrometadatascantasks`, body);
    if (!result.ok) throw new Error(`Unable to create AstroMetadataScanTask (HTTP ${result.status}): ${result.text.slice(0, 240)}`);
  }

  async #ensureAstroDataSources(connector: ConnectorRecord, secretName: string): Promise<void> {
    if (!this.#client || connector.kind !== "s3") return;
    const source = {
      apiVersion: "org.zhejianglab.astro.metadata/v1alpha1", kind: "AstroDataSource",
      metadata: { name: connector.id, namespace: this.#namespace, labels: { "app.kubernetes.io/managed-by": "astro-data-workspace" } },
      spec: { type: "s3", endpoint: connector.config.endpoint, bucket: connector.config.bucket, prefix: connector.config.prefix ?? "", credentialSecretRef: { name: secretName } },
    };
    await this.#upsertAstroDataSource(connector.id, source);
    const sinkName = `${connector.id}-sink`.slice(0, 63).replace(/-+$/g, "");
    const sink = { apiVersion: "org.zhejianglab.astro.metadata/v1alpha1", kind: "AstroDataSource", metadata: { name: sinkName, namespace: this.#namespace, labels: { "app.kubernetes.io/managed-by": "astro-data-workspace" } }, spec: { type: "elasticsearch", endpoint: this.#esUrl } };
    await this.#upsertAstroDataSource(sinkName, sink);
  }

  async #upsertAstroDataSource(name: string, body: Record<string, unknown>): Promise<void> {
    const itemPath = `${TASK_API}/namespaces/${encodeURIComponent(this.#namespace)}/astrodatasources/${encodeURIComponent(name)}`;
    const current = await this.#client!.request<KubernetesResource>("GET", itemPath);
    if (current.status === 404) {
      const created = await this.#client!.request("POST", `${TASK_API}/namespaces/${encodeURIComponent(this.#namespace)}/astrodatasources`, body);
      if (!created.ok && created.status !== 409) throw new Error(`Unable to register AstroDataSource (HTTP ${created.status}): ${created.text.slice(0, 240)}`);
      return;
    }
    if (!current.ok) throw new Error(`Unable to read AstroDataSource (HTTP ${current.status}): ${current.text.slice(0, 240)}`);
    const resourceVersion = current.value?.metadata?.resourceVersion;
    const update = resourceVersion
      ? { ...body, metadata: { ...(body.metadata as Record<string, unknown>), resourceVersion } }
      : body;
    const updated = await this.#client!.request("PUT", itemPath, update);
    if (!updated.ok) throw new Error(`Unable to update AstroDataSource (HTTP ${updated.status}): ${updated.text.slice(0, 240)}`);
  }

  #assertScannable(connector: ConnectorRecord): void {
    if (connector.status === "disabled") throw new ConnectorScanPreconditionError("Disabled connectors cannot be scanned");
    if (!this.#esUrl) throw new ConnectorScanPreconditionError("Elasticsearch is not configured for AstroMetadataScanTask output");
    if (!hasCurrentSuccessfulConnectorCheck(connector)) {
      throw new ConnectorScanPreconditionError("Connector must have a current successful connection check for its current configuration before scanning");
    }
  }

  #isLinkedAsset(asset: DataAssetRecord, connector: ConnectorRecord): boolean {
    return (asset.connectorIds ?? []).includes(connector.id)
      || (asset.connectorLocationKeys ?? []).includes(connector.locationKey)
      || [asset.access, ...(asset.accesses ?? [])].some((access) => access.connectorId === connector.id || access.uri === connector.locationKey);
  }

  async #ensureScanAssets(connector: ConnectorRecord, target: ConnectorScanTargetSnapshot): Promise<DataAssetRecord[]> {
    const userAssets = (await this.#dataCatalog.list()).filter((asset) => asset.origin === "user");
    const linked = userAssets.filter((asset) => this.#isLinkedAsset(asset, connector));
    if (linked.length) return linked;

    // A connector self-scan is also a catalog registration workflow. Without a
    // user asset, the scanner can write files to ES but the UI has no stable
    // asset_id by which to discover those documents or their sky coverage.
    const registered = await this.#dataCatalog.register({
      name: connector.name,
      description: `Scanned catalog from ${target.uri}. Created automatically when the connector was scanned.`,
      ...(connector.surveyId ? { surveyId: connector.surveyId } : {}),
      ...(connector.releaseId ? { releaseId: connector.releaseId } : {}),
      product: connector.name,
      kind: "catalog",
      modalities: ["catalog"],
      connector: "s3",
      sourceUri: target.uri,
      format: "directory",
      connectorIds: [connector.id],
      connectorLocationKeys: [connector.locationKey],
      status: "ready",
      projectState: "acquired",
    });
    return [registered];
  }

  async #scanOwnership(asset: DataAssetRecord, connector: ConnectorRecord): Promise<EffectiveDataOwnership> {
    // A scan path is itself an association with an assigned Connector. This
    // also makes legacy assets (which predate connectorIds) inherit the
    // Connector's survey/release in newly written ES documents. An unassigned
    // Connector does not erase an asset's explicit survey metadata when the
    // asset has no association yet.
    const alreadyLinked = (asset.connectorIds ?? []).includes(connector.id)
      || (asset.connectorLocationKeys ?? []).includes(connector.locationKey)
      || (asset.accesses ?? []).some((access) => access.connectorId === connector.id);
    const linkedAsset = {
      ...asset,
      connectorIds: connector.surveyId || alreadyLinked ? [...new Set([...(asset.connectorIds ?? []), connector.id])] : asset.connectorIds,
      connectorLocationKeys: connector.surveyId || alreadyLinked ? [...new Set([...(asset.connectorLocationKeys ?? []), connector.locationKey])] : asset.connectorLocationKeys,
    } as DataAssetRecord;
    const ownership = resolveDataOwnership(linkedAsset, await this.#connectors.list());
    if (ownership.source === "conflict") throw new RangeError(ownership.message ?? "关联 Connector 的巡天归属不一致");
    return ownership;
  }
}
