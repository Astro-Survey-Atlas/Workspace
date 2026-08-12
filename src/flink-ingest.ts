import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { listConnectorObjects, type ConnectorRecord } from "./connectors.js";
import type { ConnectorCredentialStore, StoredConnectorCredentials } from "./connector-credentials.js";
import { ConnectorIngestRunCatalog, type ConnectorIngestRun } from "./connector-history.js";
import type { DataAssetRecord, DataCatalogRegistry } from "./data-catalog.js";
import type { ConnectorRegistry } from "./connectors.js";
import { resolveDataOwnership, type EffectiveDataOwnership } from "./data-ownership.js";

const TASK_API = "/apis/org.zhejianglab.astro.metadata/v1";
const PILOT_ASSETS = [
  { assetId: "euclid-q1-mer-final", key: "cat", pattern: /EUC_MER_FINAL-CAT_TILE[^/]+\.fits$/i },
  { assetId: "euclid-q1-mer-cutouts-cat", key: "cutouts", pattern: /EUC_MER_FINAL-CUTOUTS-CAT_TILE[^/]+\.fits$/i },
  { assetId: "euclid-q1-mer-morph-cat", key: "morph", pattern: /EUC_MER_FINAL-MORPH-CAT_TILE[^/]+\.fits$/i },
] as const;

interface KubernetesResource {
  metadata?: { name?: string; namespace?: string; labels?: Record<string, string> };
  status?: { batchId?: string; ingestStatus?: string; jobStatus?: string; exception?: string };
}

interface KubernetesList<T> { items?: T[]; }

export interface GenericScanInput {
  assetId: string;
  path?: string;
  allowedSuffixes?: string[];
  spatial?: {
    mode?: "none" | "auto" | "catalog" | "healpix";
    raColumn?: string;
    decColumn?: string;
    /** Name of a NESTED HEALPix pixel column for catalogs without RA/Dec. */
    healpixColumn?: string;
    frame?: string;
    units?: string;
    role?: string;
    healpixOrder?: number;
  };
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

export function dataWarehouseEnabled(value = process.env.ASTRO_DATA_WAREHOUSE_ENABLED): boolean {
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new RangeError("ASTRO_DATA_WAREHOUSE_ENABLED must be true or false");
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

function s3Uri(connector: ConnectorRecord, key: string): string {
  return `s3://${connector.config.bucket}/${key}`;
}

function scanPath(connector: ConnectorRecord, requested?: string): string {
  const base = (connector.config.prefix ?? "").replace(/^\/+|\/+$/g, "");
  const raw = (requested ?? base).trim();
  if (!raw) throw new RangeError("scan path is required");
  if (/^s3a?:\/\//i.test(raw)) {
    const expected = [`s3://${connector.config.bucket}/`, `s3a://${connector.config.bucket}/`].map((value) => value.toLowerCase());
    if (!expected.some((prefix) => raw.toLowerCase().startsWith(prefix))) throw new RangeError("scan path must stay inside the connector bucket");
    return raw;
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
  const ingest = task.status?.ingestStatus?.toUpperCase();
  const job = task.status?.jobStatus?.toUpperCase();
  if (ingest === "FINISHED" || job === "FINISHED") return "succeeded";
  if (job === "FAILED" || job === "CANCELED" || job === "CANCELLED" || job === "ERROR") return "failed";
  return task.status ? "running" : "queued";
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

  async submitPilot(connectorId: string): Promise<ConnectorIngestRun[]> {
    if (!this.#enabled) throw new DataWarehouseDisabledError();
    if (!this.#client) throw new Error("Flink scan submission is only available inside Kubernetes");
    const connector = await this.#connectors.get(connectorId);
    if (connector.kind !== "s3") throw new RangeError("Pilot scanning currently supports S3/OSS connectors only");
    if (connector.status !== "ready" && connector.lastCheck?.status !== "ok") throw new RangeError("Connector must pass connection detection before scanning");
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
    const secretName = `astro-scan-${token}`;
    await this.#createSecret(secretName, stored, connector.config.endpoint ?? stored.endpoint, token);
    const created: ConnectorIngestRun[] = [];
    try {
      for (const entry of selected) {
        const asset = await this.#dataCatalog.get(entry.definition.assetId);
        const ownership = await this.#scanOwnership(asset, connector);
        const taskName = safeName(`euclid-q1-mer-pilot-${entry.definition.key}-${token}`).slice(0, 63).replace(/-+$/g, "");
        const batchId = `workspace-pilot-${token}-${entry.definition.key}`;
        const run = await this.#runs.add(connector.locationKey, {
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

  async submitScan(connectorId: string, input: GenericScanInput): Promise<ConnectorIngestRun> {
    if (!this.#enabled) throw new DataWarehouseDisabledError();
    if (!this.#client) throw new Error("Flink scan submission is only available inside Kubernetes");
    const connector = await this.#connectors.get(connectorId);
    if (connector.kind !== "s3") throw new RangeError("Generic scanning currently supports S3/OSS connectors only");
    if (connector.status !== "ready" && connector.lastCheck?.status !== "ok") throw new RangeError("Connector must pass connection detection before scanning");
    const asset = await this.#dataCatalog.get(input.assetId);
    const ownership = await this.#scanOwnership(asset, connector);
    const spatialMode = input.spatial?.mode ?? "auto";
    if (!["auto", "none", "catalog", "healpix"].includes(spatialMode)) throw new RangeError("spatial.mode must be auto, none, catalog, or healpix");
    if (spatialMode === "catalog" && (!input.spatial?.raColumn?.trim() || !input.spatial?.decColumn?.trim())) {
      throw new RangeError("catalog spatial mode requires raColumn and decColumn");
    }
    if (spatialMode === "healpix" && !input.spatial?.healpixColumn?.trim()) {
      throw new RangeError("healpix spatial mode requires healpixColumn");
    }
    if ((input.spatial?.healpixOrder ?? 8) !== 8) {
      throw new RangeError("workspace sky coverage currently requires healpixOrder=8");
    }
    const stored = connector.credentialRef ? await this.#credentials.get(connector.credentialRef) : undefined;
    if (!stored?.accessKeyId || !stored.secretAccessKey) throw new RangeError("Connector has no saved S3 credentials");
    const path = scanPath(connector, input.path);
    const token = randomUUID().replace(/-/g, "").slice(0, 12);
    const secretName = `astro-scan-${token}`;
    const taskName = safeName(`astro-scan-${asset.id}-${token}`).slice(0, 63).replace(/-+$/g, "");
    const batchId = `workspace-scan-${token}`;
    await this.#createSecret(secretName, stored, connector.config.endpoint ?? stored.endpoint, token);
    const run = await this.#runs.add(connector.locationKey, {
      jobId: taskName,
      batchId,
      assetId: asset.id,
      assetName: asset.name,
      status: "queued",
      fileCount: 0,
      sourcePath: path,
      esIndex: this.#esIndex,
      secretName,
    });
    try {
      await this.#createTask({
        connector,
        asset,
        paths: [path],
        allowedSuffixes: input.allowedSuffixes?.length ? input.allowedSuffixes : ["*"],
        spatial: input.spatial,
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

  async #pollRun(run: ConnectorIngestRun): Promise<void> {
    const result = await this.#client!.request<KubernetesResource>("GET", `${TASK_API}/namespaces/${encodeURIComponent(this.#namespace)}/flinkingesttasks/${encodeURIComponent(run.jobId!)}`);
    if (result.status === 404) return;
    if (!result.ok || !result.value) {
      throw new Error(`Unable to read FlinkIngestTask (HTTP ${result.status})`);
    }
    const actualBatchId = result.value.status?.batchId?.trim();
    if (actualBatchId && actualBatchId !== run.batchId) {
      run = await this.#runs.update(run.id, { batchId: actualBatchId });
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
      await this.#runs.update(run.id, { status: "failed", error: result.value.status?.exception || `Flink job status: ${result.value.status?.jobStatus ?? "FAILED"}`, completedAt: new Date().toISOString() });
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
    const result = await this.#client!.request("POST", `/api/v1/namespaces/${encodeURIComponent(this.#secretNamespace)}/secrets`, {
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
    });
    if (!result.ok) throw new Error(`Unable to create scan Secret (HTTP ${result.status}): ${result.text.slice(0, 240)}`);
  }

  async #cleanupSecret(name?: string): Promise<void> {
    if (!name || !this.#client) return;
    const active = (await this.#runs.list()).some((run) => run.secretName === name && (run.status === "queued" || run.status === "running"));
    if (active) return;
    const result = await this.#client.request("DELETE", `/api/v1/namespaces/${encodeURIComponent(this.#secretNamespace)}/secrets/${encodeURIComponent(name)}`);
    if (!result.ok && result.status !== 404) console.warn(`Unable to remove scan Secret ${name} (HTTP ${result.status})`);
  }

  async #createTask(input: {
    connector: ConnectorRecord;
    asset: DataAssetRecord;
    paths: string[];
    allowedSuffixes: string[];
    spatial?: GenericScanInput["spatial"];
    ownership: EffectiveDataOwnership;
    taskName: string;
    batchId: string;
    secretName: string;
  }): Promise<void> {
    const { connector, asset, paths, allowedSuffixes, spatial, taskName, batchId, secretName, ownership } = input;
    const astro = spatial ?? {};
    const body = {
      apiVersion: "org.zhejianglab.astro.metadata/v1",
      kind: "FlinkIngestTask",
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
        platform: "s3",
        paths,
        batchId,
        jobParallelism: 1,
        allowedSuffixes,
        activatedHandlers: ["default", "fits", "catalog"],
        tags: asset.tags ?? asset.modalities,
        astro: {
          mode: "file",
          wcs: "auto",
          spatialMode: astro.mode ?? "auto",
          ...(astro.raColumn ? { raColumn: astro.raColumn } : {}),
          ...(astro.decColumn ? { decColumn: astro.decColumn } : {}),
          ...(astro.healpixColumn ? { healpixColumn: astro.healpixColumn } : {}),
          coordinateFrame: astro.frame ?? "ICRS",
          coordinateUnits: astro.units ?? "deg",
          coverageRole: astro.role ?? "object_presence",
          healpixOrder: astro.healpixOrder ?? 8,
          survey: ownership.surveyId ?? "",
          release: ownership.releaseId ?? "",
          product: asset.product,
          modality: asset.modalities.join("+"),
          assetId: asset.id,
          connectorLocationKey: connector.locationKey,
        },
        extraEnvs: {
          esHost: "warehouse-elasticsearch.warehouse.svc.cluster.local",
          esPort: 9200,
          datasetIndex: "datasetindex",
          astroFileIndex: this.#esIndex,
        },
        extraSecret: {
          name: secretName,
          namespace: this.#secretNamespace,
          accessKeyName: "access-key",
          secretKeyName: "secret-key",
          endpointKeyName: "s3-endpoint",
        },
      },
    };
    const result = await this.#client!.request("POST", `${TASK_API}/namespaces/${encodeURIComponent(this.#namespace)}/flinkingesttasks`, body);
    if (!result.ok) throw new Error(`Unable to create FlinkIngestTask (HTTP ${result.status}): ${result.text.slice(0, 240)}`);
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
