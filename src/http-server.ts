import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import type { Request, Response } from "express";

import { AgentService } from "./agent.js";
import { AstroIndexService, ASTRO_FILE_INDEX, ASTRO_OVERVIEW_NSIDE, type AstroCoverageLayer, type AstroSkyQueryInput } from "./astro-index.js";
import { AstroObjectIndexService, type AstroCellsQueryInput, type ObjectRegionQueryInput } from "./astro-object-index.js";
import { McpCatalogQueryClient } from "./catalog-mcp-client.js";
import { createConnectorCredentialStore, type StoredConnectorCredentials } from "./connector-credentials.js";
import { ConnectorRegistry, connectorLocationKey, validateConnectorInput, type ConnectorCheckInput, type ConnectorPublicRecord, type ConnectorRecord, type ConnectorRegistrationInput } from "./connectors.js";
import { ConnectorIngestRunCatalog, publicConnectorIngestRun, type ConnectorIngestRunFilter, type ConnectorIngestRunRecord, type ConnectorIngestRunStatus } from "./connector-history.js";
import { DataCatalogRegistry, type DataAssetAccess, type DataAssetRecord, type DataAssetRegistrationInput } from "./data-catalog.js";
import { deriveDataAssetOperationalStatus, type DataAssetCoverageEvidence, type DataAssetRunEvidence } from "./data-asset-status.js";
import { ConnectorScanCapabilityError, ConnectorScanPreconditionError, DataWarehouseDisabledError, dataWarehouseEnabled, validateConnectorSelfScanBody } from "./warehouse-scan.js";
import { createAstroMcpServer } from "./mcp.js";
import { ResourceCatalogSyncError, ResourceCatalogUnavailableError, ResourcePackageManager, resourcePackageSurveyRecords, type ResourcePackageLoad } from "./resource-packages.js";
import type { SurveyFootprintManifest } from "./survey-footprints.js";
import { surveyCardFor, SurveyRegistry, type SurveyRecord, type SurveyRegistrationInput, type SurveyReleaseRegistrationInput } from "./survey-registry.js";
import { WorkflowEngine } from "./workflow-engine.js";
import { WorkflowStore } from "./workflow-store.js";
import { listTags } from "./tags.js";
import { createMetadataStore, importJsonState } from "./storage/index.js";
import { LocalConnectorRootsPolicy, LocalConnectorPolicyError, localConnectorRootsResponse } from "./local-connector-roots.js";
import { inspectLocalCsv, listLocalCsvFiles, LocalSourceInspectionCapabilityError, LocalSourceInspectionError } from "./local-source-inspection.js";
import { LocalCsvScanExecutor, LocalScanCapabilityError, LocalScanDisabledError, LocalScanPreconditionError, localScanEnabled, LOCAL_CSV_SCAN_EXECUTOR, type LocalCsvScanInput } from "./local-scan-executor.js";
import { UserMocArtifactStore, type UserMocArtifact } from "./user-moc-artifacts.js";
import { WarehouseIndexService, type WarehouseCoverageLayer } from "./warehouse-index.js";
import { WarehouseScanService } from "./warehouse-scan.js";
import { calculateSkyOverlap, type SkyOverlapSource } from "./sky-overlap.js";
import { CoverageDownloadService, type CoverageDownloadFile } from "./coverage-downloads.js";
import { discoverSourceFiles } from "./source-crawler.js";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const port = Number(process.env.PORT ?? "3000");
const host = process.env.HOST ?? "0.0.0.0";
const stateRoot = path.resolve(process.env.ASTRO_STATE_ROOT
  ?? (process.env.ASTRO_SQLITE_PATH ? path.dirname(process.env.ASTRO_SQLITE_PATH) : path.join(projectRoot, "data")));
const allowedHosts = (
  process.env.ASTRO_ALLOWED_HOSTS ??
  "localhost,127.0.0.1,astro-data-workspace-mcp,astro-data-workspace-mcp.astro-data-workspace,astro-data-workspace-mcp.astro-data-workspace.svc,astro-data-workspace-mcp.astro-data-workspace.svc.cluster.local"
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const viewerRoot = process.env.ASTRO_VIEWER_ROOT ?? path.join(projectRoot, "viewer");
const workflowRoot = process.env.ASTRO_WORKFLOW_ROOT ?? path.join(stateRoot, "workflow-runs");
const surveyRegistryStatePath = process.env.ASTRO_SURVEY_REGISTRY_STATE ?? path.join(stateRoot, "survey-registrations.json");
const dataCatalogStatePath = process.env.ASTRO_DATA_CATALOG_STATE ?? path.join(stateRoot, "data-catalog.json");
const connectorStatePath = process.env.ASTRO_CONNECTOR_STATE ?? path.join(stateRoot, "connectors.json");
const connectorRunStatePath = process.env.ASTRO_CONNECTOR_RUN_STATE ?? path.join(stateRoot, "connector-ingest-runs.json");
const localConnectorRoots = LocalConnectorRootsPolicy.fromEnvironment();
const coverageDownloadRoot = path.resolve(process.env.ASTRO_COVERAGE_DOWNLOAD_ROOT ?? path.join(stateRoot, "coverage-downloads"));
const coverageDownloadStatePath = path.resolve(process.env.ASTRO_COVERAGE_DOWNLOAD_STATE ?? path.join(stateRoot, "coverage-download-jobs.json"));
const resourcePackageRoot = process.env.ASTRO_RESOURCE_PACKAGE_ROOT ?? path.join(stateRoot, "resource-packages");
const resourcePackageStatePath = process.env.ASTRO_RESOURCE_PACKAGE_STATE ?? path.join(stateRoot, "resource-package-state.json");
const resourceCatalogUrl = process.env.ASTRO_RESOURCE_CATALOG_URL ?? pathToFileURL(path.join(stateRoot, "assets-current", "catalog.json")).href;
const resourceSnapshotRoot = process.env.ASTRO_RESOURCE_SNAPSHOT_ROOT ?? stateRoot;
const resourceCatalogConfigPath = process.env.ASTRO_RESOURCE_CATALOG_CONFIG_STATE ?? path.join(stateRoot, "resource-catalog-config.json");
const resourceCatalogAllowedOrigins = (process.env.ASTRO_RESOURCE_CATALOG_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const resourceAdminToken = process.env.ASTRO_RESOURCE_ADMIN_TOKEN;
const catalogMcpUrl = process.env.ASTRO_CATALOG_MCP_URL ?? "http://eva24002-entrance.lab.zverse.space:30082/mcp";
const catalogMcpTimeoutMs = Number(process.env.ASTRO_CATALOG_MCP_TIMEOUT_MS ?? "15000");
const warehouseNamespace = process.env.ASTRO_WAREHOUSE_NAMESPACE ?? process.env.POD_NAMESPACE ?? "astro-data-workspace";
const warehousePollMs = Number(process.env.ASTRO_WAREHOUSE_POLL_MS ?? "5000");
const astroEsUrl = process.env.ASTRO_ES_URL ?? "";
const warehouseEsUrl = process.env.ASTRO_WAREHOUSE_ES_URL ?? "";
const warehouseEsLayerIndex = process.env.ASTRO_WAREHOUSE_LAYER_INDEX ?? "ast_layer_index_v1";
const warehouseEsFileIndex = process.env.ASTRO_WAREHOUSE_FILE_INDEX ?? "ast_file_index_v1";
const warehouseEsCoverageIndex = process.env.ASTRO_WAREHOUSE_COVERAGE_INDEX ?? "ast_coverage_index_v1";
const userMocRoot = process.env.ASTRO_USER_MOC_ROOT ?? path.join(stateRoot, "user-mocs");
const warehouseEnabled = dataWarehouseEnabled();
const localCsvScanEnabled = localScanEnabled();
const metadataStoreEngine = process.env.ASTRO_METADATA_STORE || "sqlite";

const workflowStore = new WorkflowStore(workflowRoot);
const surveys = new SurveyRegistry(surveyRegistryStatePath);
const metadataStore = createMetadataStore();
const dataCatalog = new DataCatalogRegistry(metadataStore);
const connectors = new ConnectorRegistry(metadataStore, localConnectorRoots);
const connectorCredentials = createConnectorCredentialStore();
const connectorRuns = new ConnectorIngestRunCatalog(metadataStore);
const userMocs = new UserMocArtifactStore({ root: userMocRoot });
const astroObjectIndex = new AstroObjectIndexService({ baseUrl: astroEsUrl });
const localCsvScans = new LocalCsvScanExecutor({
  enabled: localCsvScanEnabled,
  connectors,
  dataCatalog,
  runs: connectorRuns,
  roots: localConnectorRoots,
  indexService: astroObjectIndex,
  artifacts: userMocs,
});
const resourcePackages = new ResourcePackageManager({ catalogUrl: resourceCatalogUrl, root: resourcePackageRoot, statePath: resourcePackageStatePath, snapshotRoot: resourceSnapshotRoot, allowedOrigins: resourceCatalogAllowedOrigins });
// Search indices are independent from the optional warehouse integration.
const astroIndex = new AstroIndexService({ baseUrl: astroEsUrl });
// The Warehouse data plane is optional. Do not let an inherited endpoint make
// the coverage route read a remote ES while the integration is disabled.
const warehouseIndex = new WarehouseIndexService({ url: warehouseEnabled ? warehouseEsUrl : "", layerIndex: warehouseEsLayerIndex, fileIndex: warehouseEsFileIndex, coverageIndex: warehouseEsCoverageIndex });
const warehouseScans = new WarehouseScanService({
  enabled: warehouseEnabled,
  connectors,
  dataCatalog,
  credentials: connectorCredentials,
  runs: connectorRuns,
  namespace: warehouseNamespace,
  warehouseEsUrl,
  pollMs: warehousePollMs,
  artifacts: userMocs,
});
const coverageDownloads = new CoverageDownloadService({
  root: coverageDownloadRoot,
  statePath: coverageDownloadStatePath,
  registerConnector: (input) => connectors.register(input),
});
const workflowEngine = new WorkflowEngine(workflowStore, new McpCatalogQueryClient(catalogMcpUrl, catalogMcpTimeoutMs, 1));
const agentService = new AgentService(workflowStore, workflowEngine);
const app = createMcpExpressApp({ host, allowedHosts });

app.use("/api", express.json({ limit: "64kb" }));

app.get("/healthz", (_request: Request, response: Response) => {
  response.json({ status: "ok", service: "astro-data-workspace", version: "0.10.38" });
});

app.get("/api/capabilities", async (_request: Request, response: Response) => {
  response.json({
    dataWarehouse: { enabled: warehouseEnabled, configured: warehouseIndex.configured, namespace: warehouseNamespace, layerIndex: warehouseIndex.layerIndex, coverageIndex: warehouseIndex.coverageIndex },
    userMocs: { rootConfigured: Boolean(userMocRoot), count: (await userMocs.list()).length },
    localScan: {
      enabled: localCsvScanEnabled,
      configured: astroObjectIndex.configured,
      executor: LOCAL_CSV_SCAN_EXECUTOR,
      objectIndex: astroObjectIndex.objectIndex,
      coverageIndex: astroObjectIndex.coverageIndex,
    },
    metadataStore: { engine: metadataStoreEngine },
  });
});

function publicConnectorRuns(records: ConnectorIngestRunRecord[]) {
  return records.map(publicConnectorIngestRun);
}

async function connectorRunHistory(connector: ConnectorRecord): Promise<ConnectorIngestRunRecord[]> {
  return (await connectorRuns.list()).filter((run) => run.connectorId === connector.id
    || (!run.connectorId && run.locationKey === connector.locationKey));
}

function connectorRunFilter(request: Request): ConnectorIngestRunFilter {
  const value = (name: string): string | undefined => {
    const raw = request.query[name];
    if (raw === undefined) return undefined;
    if (typeof raw !== "string" || !raw.trim()) throw new RangeError(`${name} must be a non-empty string`);
    return raw.trim();
  };
  const connectorKind = value("connectorKind");
  const status = value("status");
  const taskKind = value("taskKind");
  if (connectorKind !== undefined && !["s3", "local", "jdbc"].includes(connectorKind)) throw new RangeError("connectorKind is not supported");
  if (status !== undefined && !["queued", "running", "succeeded", "failed"].includes(status)) throw new RangeError("status is not supported");
  if (taskKind !== undefined && !["user_scan", "user_coverage"].includes(taskKind)) throw new RangeError("taskKind is not supported");
  return {
    locationKey: value("locationKey"),
    connectorId: value("connectorId"),
    connectorKind: connectorKind as ConnectorIngestRunFilter["connectorKind"],
    status: status as ConnectorIngestRunStatus | undefined,
    taskKind: taskKind as ConnectorIngestRunFilter["taskKind"],
  };
}

function idempotencyKey(request: Request): string | undefined {
  const value = request.get("Idempotency-Key");
  if (value !== undefined && !value.trim()) throw new RangeError("Idempotency-Key must not be empty");
  return value;
}

function connectorAccess(record: ConnectorRecord): DataAssetAccess {
  const config = record.config;
  return { connector: record.kind, uri: record.displayPath, format: config.format ?? "directory", connectorId: record.id, label: record.name };
}

async function publicConnector(record: ConnectorRecord): Promise<ConnectorPublicRecord> {
  let stored: StoredConnectorCredentials | undefined;
  if (record.credentialRef) {
    try {
      stored = await connectorCredentials.get(record.credentialRef);
    } catch (error) {
      console.warn(`Unable to resolve credentials for connector ${record.id}`, error instanceof Error ? error.message : error);
    }
  }
  const { credentialRef: _credentialRef, ...visible } = record;
  return {
    ...visible,
    credentials: { accessKeyId: stored?.accessKeyId ?? "", secretConfigured: Boolean(stored?.secretAccessKey) },
  };
}

function credentialText(value: unknown, label: string, maximum: number, required: boolean): string {
  const result = typeof value === "string" ? value.trim() : "";
  if (required && !result) throw new RangeError(`${label} is required`);
  if (result.length > maximum) throw new RangeError(`${label} is too long`);
  return result;
}

function resolvedS3Credentials(input: ConnectorRegistrationInput, existing?: StoredConnectorCredentials): StoredConnectorCredentials {
  const accessKeyId = credentialText(input.credentials?.accessKeyId, "Access Key", 512, !existing?.accessKeyId) || existing?.accessKeyId || "";
  const secretAccessKey = credentialText(input.credentials?.secretAccessKey, "Secret Key", 2048, !existing?.secretAccessKey) || existing?.secretAccessKey || "";
  return { accessKeyId, secretAccessKey, endpoint: credentialText(input.config?.endpoint, "Endpoint", 2048, false) || existing?.endpoint || "" };
}

function internalConnectorInput(input: ConnectorRegistrationInput, credentialRef?: string): ConnectorRegistrationInput {
  const { credentials: _credentials, credentialRef: _clientCredentialRef, ...metadata } = input;
  return { ...metadata, credentialRef };
}

function optionalLocalReference(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new RangeError(`${name} must be a string`);
  const result = value.trim();
  if (result.length > 120) throw new RangeError(`${name} must contain at most 120 characters`);
  if (result && !/^[a-z0-9](?:[a-z0-9._-]{0,118}[a-z0-9])?$/.test(result)) throw new RangeError(`${name} must be a lowercase stable identifier`);
  return result || undefined;
}

async function publicDataAsset(asset: DataAssetRecord): Promise<DataAssetRecord> {
  const connectorRecords = await connectors.list();
  const resolvedRecords = [
    ...(asset.connectorLocationKeys ?? []).flatMap((key) => connectorRecords.filter((record) => record.locationKey === key)),
    ...(asset.connectorIds ?? []).flatMap((id) => {
      return connectorRecords.filter((record) => record.id === id);
    }),
  ];
  const uniqueRecords = [...new Map(resolvedRecords.map((record) => [record.locationKey, record])).values()];
  const resolved = uniqueRecords.map(connectorAccess);
  if (!resolved.length) return structuredClone(asset);
  const configured = asset.accesses?.length ? asset.accesses : [asset.access];
  const connectorIds = new Set(configured.map((access) => access.connectorId).filter(Boolean));
  const accesses = [...configured, ...resolved.filter((access) => !connectorIds.has(access.connectorId))];
  return {
    ...structuredClone(asset),
    connectorIds: uniqueRecords.map((record) => record.id),
    connectorLocationKeys: uniqueRecords.map((record) => record.locationKey),
    access: accesses[0]!,
    accesses,
  };
}

async function validateConnectorIds(input: DataAssetRegistrationInput): Promise<void> {
  const records = await connectors.list();
  for (const id of input.connectorIds ?? []) {
    if (!records.some((record) => record.id === id)) throw new RangeError(`connectorIds contains unknown connector: ${id}`);
  }
  for (const key of input.connectorLocationKeys ?? []) {
    if (!records.some((record) => record.locationKey === key)) throw new RangeError(`connectorLocationKeys contains unknown path: ${key}`);
  }
  for (const id of (input.accesses ?? []).map((access) => access.connectorId).filter((value): value is string => Boolean(value))) {
    if (!records.some((record) => record.id === id)) throw new RangeError(`accesses contains unknown connectorId: ${id}`);
  }
}

function sendApiError(response: Response, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const notFound = message.startsWith("Dataset not found:") || message.startsWith("Data asset not found:") || message.startsWith("Connector not found:") || message.startsWith("Connector ingest run not found:") || message.startsWith("Coverage job not found:") || message.startsWith("Coverage download job not found:") || message.startsWith("Overlap component not found:") || message.startsWith("Survey not found:") || message.startsWith("Public survey not found:") || message.startsWith("Resource package not found:") || message.startsWith("Resource package is not installed:") || message.startsWith("Resource package job not found:") || message.startsWith("Resource package MOC layer not found:") || message.startsWith("Resource package MOC artifact is not available:")
    || message.startsWith("User MOC artifact file not found:")
    || message.startsWith("Workflow not found:")
    || message.startsWith("Workflow run not found:") || message.startsWith("Workflow artifact not found:") || message.startsWith("Agent session not found:");
  const status = error instanceof LocalConnectorPolicyError ? error.statusCode
    : error instanceof LocalScanDisabledError ? error.statusCode
    : error instanceof LocalScanCapabilityError ? error.statusCode
    : error instanceof LocalScanPreconditionError ? error.statusCode
    : error instanceof LocalSourceInspectionCapabilityError ? error.statusCode
    : error instanceof LocalSourceInspectionError ? error.statusCode
  : error instanceof DataWarehouseDisabledError ? 503
    : error instanceof ResourceCatalogUnavailableError ? 503
    : error instanceof ResourceCatalogSyncError ? 502
    : error instanceof ConnectorScanCapabilityError ? 422
    : error instanceof ConnectorScanPreconditionError ? 409
    : error instanceof RangeError ? 400
    : notFound ? 404 : 500;
  if (status === 500) console.error("API request failed", error);
  response.status(status).json({ error: message });
}

interface ResourceCatalogConfigState {
  schemaVersion: 1;
  catalogUrl: string;
  updatedAt: string;
}

async function loadResourceCatalogConfig(): Promise<void> {
  try {
    const parsed = JSON.parse(await readFile(resourceCatalogConfigPath, "utf8")) as Partial<ResourceCatalogConfigState>;
    if (parsed.schemaVersion !== 1 || typeof parsed.catalogUrl !== "string") throw new Error("resource catalog config has an unsupported schema");
    resourcePackages.setCatalogUrl(parsed.catalogUrl);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn("Ignoring invalid resource catalog config", error);
  }
}

async function persistResourceCatalogConfig(catalogUrl: string): Promise<ResourceCatalogConfigState> {
  const state: ResourceCatalogConfigState = { schemaVersion: 1, catalogUrl, updatedAt: new Date().toISOString() };
  await mkdir(path.dirname(resourceCatalogConfigPath), { recursive: true });
  const temporary = `${resourceCatalogConfigPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporary, resourceCatalogConfigPath);
  return state;
}

function requireResourceAdmin(request: Request, response: Response): boolean {
  if (!resourceAdminToken) {
    response.status(503).json({ error: "Resource catalog administration is not configured" });
    return false;
  }
  if (request.get("Authorization") !== `Bearer ${resourceAdminToken}`) {
    response.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

async function effectiveFootprints(): Promise<SurveyFootprintManifest> {
  // Public coverage is sourced only from the trusted Assets snapshot.
  return resourcePackages.activeFootprints();
}

function publicSurveyRecords(): SurveyRecord[] {
  return resourcePackageSurveyRecords(resourcePackages.list());
}

function surveyRecords(): SurveyRecord[] {
  return surveys.list().map((card) => surveys.get(card.id));
}

function surveyRecord(id: string): SurveyRecord {
  if (surveys.list().some((candidate) => candidate.id === id)) return surveys.get(id);
  throw new Error(`Survey not found: ${id}`);
}

function publicSurveyRecord(id: string): SurveyRecord {
  const record = publicSurveyRecords().find((candidate) => candidate.id === id);
  if (!record) throw new Error(`Public survey not found: ${id}`);
  return record;
}

function datasetIdFrom(request: Request): string {
  const value = request.params.id;
  const id = Array.isArray(value) ? value[0] : value;
  if (!id) throw new RangeError("dataset id is required");
  return id;
}

app.get("/api/data-assets", async (request: Request, response: Response) => {
  try {
    // Resource Package records never enter the user asset catalog. This
    // endpoint is deliberately limited to Atlas-owned user records.
    if (request.query.origin !== undefined) throw new RangeError("data asset origin filters are not supported");
    response.json({ assets: await Promise.all((await dataCatalog.list()).map(publicDataAsset)) });
  } catch (error) {
    sendApiError(response, error);
  }
});

/**
 * Return derived execution state for every user asset. The catalog remains a
 * metadata registry; this endpoint is the workflow read model used by the
 * coverage view and by clients that need to decide the next action.
 */
app.get("/api/data-assets/status", async (_request: Request, response: Response) => {
  try {
    const assets = await dataCatalog.list();
    const [connectorRecords, runs] = await Promise.all([connectors.list(), connectorRuns.list()]);
    const artifacts = await userMocs.list();
    const artifactSelections = selectUserMocArtifacts(artifacts);
    const warehouse = await warehouseIndex.coverage({
      nside: ASTRO_OVERVIEW_NSIDE,
      ...(assets.length ? { assetIds: assets.map((asset) => asset.id) } : {}),
      layerIds: workspaceWarehouseLayerIds(assets, artifacts, runs),
    });
    const connectorById = new Map(connectorRecords.map((connector) => [connector.id, connector]));
    const connectorByLocation = new Map(connectorRecords.map((connector) => [connector.locationKey, connector]));
    const statuses = await Promise.all(assets.map(async (asset) => {
      const accesses = [asset.access, ...(asset.accesses ?? [])];
      const linked = [
        ...(asset.connectorIds ?? []).map((id) => connectorById.get(id)),
        ...(asset.connectorLocationKeys ?? []).map((key) => connectorByLocation.get(key)),
        ...accesses.flatMap((access) => [
          ...(access.connectorId ? [connectorById.get(access.connectorId)] : []),
          ...(access.uri ? [connectorByLocation.get(access.uri)] : []),
        ]),
      ].filter((connector): connector is typeof connectorRecords[number] => Boolean(connector));
      const uniqueLinked = [...new Map(linked.map((connector) => [connector.id, connector])).values()];
      const latestRun = [...runs]
        .filter((run) => run.assetId === asset.id || run.assetIds?.includes(asset.id))
        .sort((left, right) => `${right.updatedAt ?? right.createdAt}\u0000${right.id}`.localeCompare(`${left.updatedAt ?? left.createdAt}\u0000${left.id}`))[0];
      let coverage: DataAssetCoverageEvidence | undefined;
      try {
        const [legacy, local] = await Promise.all([
          astroIndex.coverage({ nside: ASTRO_OVERVIEW_NSIDE, assetIds: [asset.id] }),
          astroObjectIndex.queryCoverageFacts({ nside: ASTRO_OVERVIEW_NSIDE, assetIds: [asset.id] }),
        ]);
        const warehouseLayer = warehouse.layers.find((candidate) => warehouseLayerForAsset(candidate, asset));
        const artifactSelection = [...artifactSelections.values()].find(({ latest }) => latest.layerId === workspaceLayerIdForAsset(asset.id)
          || latest.layerId === asset.id
          || latest.layerId === `user-${asset.id}`);
        const mocLayer = artifactSelection
          ? await artifactCoverageLayer(artifactSelection.renderable, ASTRO_OVERVIEW_NSIDE, asset, artifactSelection.latest)
          : undefined;
        coverage = {
          status: aggregateCoverageStatus([
            coverageStatus(legacy.status),
            coverageStatus(local.status),
            ...(warehouseLayer ? [coverageStatus(warehouseLayer.status)] : warehouse.status === "error" ? ["error" as const] : []),
            ...(mocLayer ? [coverageStatus(mocLayer.status)] : []),
          ]),
          objectStatus: local.status,
          latestMocStatus: mocLayer?.latestMocStatus,
          pixels: [...new Set([...legacy.pixels, ...local.pixels, ...(warehouseLayer?.pixels ?? []), ...(mocLayer?.pixels ?? [])])],
          objectCount: local.facts.reduce((sum, fact) => sum + fact.objectCount, 0),
          message: [legacy.message, local.message, warehouseLayer?.message, mocLayer?.message].filter(Boolean).join("; ") || undefined,
        };
      } catch (error) {
        coverage = { status: "unavailable", pixels: [], message: error instanceof Error ? error.message : String(error) };
      }
      const derived = deriveDataAssetOperationalStatus({
        asset,
        connectorKinds: uniqueLinked.map((connector) => connector.kind),
        coverage,
        latestRun: latestRun as DataAssetRunEvidence | undefined,
        objectIndexConfigured: astroObjectIndex.configured,
        localScanConfigured: localCsvScanEnabled && astroObjectIndex.configured,
        warehouseConfigured: warehouseEnabled && warehouseIndex.configured,
      });
      return { ...derived, assetName: asset.name };
    }));
    response.json({ statuses });
  } catch (error) {
    sendApiError(response, error);
  }
});

app.get("/api/tags", (_request: Request, response: Response) => {
  response.json({ tags: listTags() });
});

app.get("/api/data-assets/:id", async (request: Request, response: Response) => {
  try {
    response.json({ asset: await publicDataAsset(await dataCatalog.get(datasetIdFrom(request))) });
  } catch (error) {
    sendApiError(response, error);
  }
});

app.post("/api/data-assets/:id/local-scan", async (request: Request, response: Response) => {
  try {
    const run = await localCsvScans.submitAsset(datasetIdFrom(request), request.body as LocalCsvScanInput, idempotencyKey(request));
    response.status(202).json({ run: publicConnectorIngestRun(run) });
  } catch (error) {
    sendApiError(response, error);
  }
});

app.post("/api/data-assets/:id/remote-scan", async (request: Request, response: Response) => {
  try {
    const assetId = datasetIdFrom(request);
    const surveyId = optionalLocalReference(request.body?.surveyId, "surveyId");
    if (!surveyId) throw new RangeError("surveyId is required for a remote scan");
    const input = { ...request.body, assetId };
    delete input.surveyId;
    response.status(202).json({ run: publicConnectorIngestRun(await warehouseScans.submitRemoteAssetScan(surveyId, input, idempotencyKey(request))) });
  } catch (error) {
    sendApiError(response, error);
  }
});

app.post("/api/data-assets", async (request: Request, response: Response) => {
  try {
    const input = request.body as DataAssetRegistrationInput;
    await validateConnectorIds(input);
    response.status(201).json({ asset: await publicDataAsset(await dataCatalog.register(input)) });
  } catch (error) {
    sendApiError(response, error);
  }
});

app.put("/api/data-assets/:id", async (request: Request, response: Response) => {
  try {
    const id = datasetIdFrom(request);
    const input = request.body as DataAssetRegistrationInput;
    await validateConnectorIds(input);
    response.json({ asset: await publicDataAsset(await dataCatalog.update(id, input)) });
  } catch (error) {
    sendApiError(response, error);
  }
});

app.delete("/api/data-assets/:id", async (request: Request, response: Response) => {
  try {
    await dataCatalog.remove(datasetIdFrom(request));
    response.status(204).end();
  } catch (error) {
    sendApiError(response, error);
  }
});

app.get("/api/connectors", async (_request: Request, response: Response) => {
  response.json({ connectors: await Promise.all((await connectors.list()).map(publicConnector)) });
});

app.get("/api/connectors/local-roots", async (_request: Request, response: Response) => {
  try {
    response.json(localConnectorRootsResponse(await connectors.listLocalRoots()));
  } catch (error) {
    sendApiError(response, error);
  }
});

app.get("/api/connectors/:id/local-files", async (request: Request, response: Response) => {
  try {
    const connector = await connectors.get(datasetIdFrom(request));
    response.json(await listLocalCsvFiles(connector, localConnectorRoots));
  } catch (error) {
    sendApiError(response, error);
  }
});

app.post("/api/connectors/:id/local-files/inspect", async (request: Request, response: Response) => {
  try {
    const connector = await connectors.get(datasetIdFrom(request));
    const body = request.body as Record<string, unknown>;
    const inspection = await inspectLocalCsv(connector, localConnectorRoots, {
      relativePath: body?.sourceRelativePath ?? body?.relativePath,
    });
    response.json({
      inspection: {
        sourceRelativePath: inspection.relativePath,
        sizeBytes: inspection.sizeBytes,
        columns: inspection.columns.map((name) => ({ name })),
        inferred: inspection.suggestions,
      },
    });
  } catch (error) {
    sendApiError(response, error);
  }
});

app.get("/api/connector-ingest-runs", async (request: Request, response: Response) => {
  try {
    if (warehouseEnabled) void warehouseScans.poll();
    response.json({ runs: publicConnectorRuns(await connectorRuns.list(connectorRunFilter(request))) });
  } catch (error) {
    sendApiError(response, error);
  }
});

app.get("/api/connectors/:id", async (request: Request, response: Response) => {
  try {
    response.json({ connector: await publicConnector(await connectors.get(datasetIdFrom(request))) });
  } catch (error) {
    sendApiError(response, error);
  }
});

app.get("/api/connectors/:id/ingest-runs", async (request: Request, response: Response) => {
  try {
    const connector = await connectors.get(datasetIdFrom(request));
    if (warehouseEnabled) void warehouseScans.poll();
    response.json({ runs: publicConnectorRuns(await connectorRunHistory(connector)) });
  } catch (error) {
    sendApiError(response, error);
  }
});

// Alias kept for integrations that call these records scan runs.
app.get("/api/connectors/:id/runs", async (request: Request, response: Response) => {
  try {
    const connector = await connectors.get(datasetIdFrom(request));
    if (warehouseEnabled) void warehouseScans.poll();
    response.json({ runs: publicConnectorRuns(await connectorRunHistory(connector)) });
  } catch (error) {
    sendApiError(response, error);
  }
});

app.post("/api/connectors/:id/check", async (request: Request, response: Response) => {
  try {
    const id = datasetIdFrom(request);
    const current = await connectors.get(id);
    const credentials = current.credentialRef ? await connectorCredentials.get(current.credentialRef) : undefined;
    const connector = await connectors.check(id, credentials, current.kind === "s3");
    response.json({ connector: await publicConnector(connector), check: connector.lastCheck });
  } catch (error) {
    sendApiError(response, error);
  }
});

app.post("/api/connectors/check", async (request: Request, response: Response) => {
  try {
    const input = request.body as ConnectorCheckInput;
    response.json({ check: await connectors.checkInput(input) });
  } catch (error) {
    sendApiError(response, error);
  }
});

app.post("/api/connectors/:id/scan-runs", async (request: Request, response: Response) => {
  try {
    validateConnectorSelfScanBody(request.body);
    const run = await warehouseScans.submitConnectorScan(datasetIdFrom(request), idempotencyKey(request));
    response.status(202).json({ run: publicConnectorIngestRun(run) });
  } catch (error) {
    sendApiError(response, error);
  }
});

app.post("/api/connectors/:id/local-scan", async (request: Request, response: Response) => {
  try {
    const run = await localCsvScans.submit(
      datasetIdFrom(request),
      request.body as LocalCsvScanInput,
      idempotencyKey(request),
    );
    response.status(202).json({ run: publicConnectorIngestRun(run) });
  } catch (error) {
    sendApiError(response, error);
  }
});

app.delete("/api/connectors/:id/ingest-runs/:runId", (_request: Request, response: Response) => {
  response.status(405).json({ error: "Connector ingest run history is read-only" });
});

app.post("/api/connectors", async (request: Request, response: Response) => {
  try {
    const input = request.body as ConnectorRegistrationInput;
    const value = validateConnectorInput(input);
    const existing = (await connectors.list()).find((record) => record.locationKey === connectorLocationKey(value.kind, value.config));
    const existingCredentials = existing?.credentialRef ? await connectorCredentials.get(existing.credentialRef) : undefined;
    const credentials = value.kind === "s3" ? resolvedS3Credentials(input, existingCredentials) : undefined;
    const credentialsChanged = Boolean(existing && credentials && (!existingCredentials
      || credentials.accessKeyId !== existingCredentials.accessKeyId
      || credentials.secretAccessKey !== existingCredentials.secretAccessKey
      || credentials.endpoint !== existingCredentials.endpoint));
    const connector = await connectors.register(internalConnectorInput(value, existing?.credentialRef));
    if (credentials) {
      const reference = connectorCredentials.managedReference(connector.id);
      try {
        await connectorCredentials.put(reference, credentials);
      } catch (error) {
        if (!existing) await connectors.remove(connector.id);
        throw error;
      }
      let saved = await connectors.setCredentialReference(connector.id, reference);
      if (credentialsChanged) saved = await connectors.invalidateCheck(connector.id);
      response.status(201).json({ connector: await publicConnector(saved) });
      return;
    }
    response.status(201).json({ connector: await publicConnector(connector) });
  } catch (error) {
    sendApiError(response, error);
  }
});

app.put("/api/connectors/:id", async (request: Request, response: Response) => {
  try {
    const id = datasetIdFrom(request);
    const input = request.body as ConnectorRegistrationInput;
    const current = await connectors.get(id);
    const value = validateConnectorInput(input);
    let credentialRef = value.kind === "s3" ? current.credentialRef : undefined;
    if (value.kind === "s3") {
      const existing = current.credentialRef ? await connectorCredentials.get(current.credentialRef) : undefined;
      const credentials = resolvedS3Credentials(input, existing);
      const credentialsChanged = !existing || credentials.accessKeyId !== existing.accessKeyId
        || credentials.secretAccessKey !== existing.secretAccessKey || credentials.endpoint !== existing.endpoint;
      credentialRef = current.credentialRef && connectorCredentials.isManaged(current.credentialRef)
        ? current.credentialRef
        : connectorCredentials.managedReference(current.id);
      await connectorCredentials.put(credentialRef, credentials);
      if (credentialsChanged) await connectors.invalidateCheck(id);
    }
    const connector = await connectors.update(id, internalConnectorInput(value, credentialRef));
    if (value.kind !== "s3" && current.credentialRef) await connectorCredentials.remove(current.credentialRef);
    response.json({ connector: await publicConnector(connector) });
  } catch (error) {
    sendApiError(response, error);
  }
});

app.delete("/api/connectors/:id", async (request: Request, response: Response) => {
  try {
    const id = datasetIdFrom(request);
    const current = await connectors.get(id);
    await connectors.remove(id);
    if (current.credentialRef) connectorCredentials.remove(current.credentialRef).catch((error) => console.error("Unable to remove managed connector credentials", error));
    response.status(204).end();
  } catch (error) {
    sendApiError(response, error);
  }
});

app.get("/api/surveys", (_request: Request, response: Response) => {
  response.json({ surveys: surveyRecords().map(surveyCardFor) });
});

app.get("/api/surveys/:id", (request: Request, response: Response) => {
  try {
    response.json({ survey: surveyRecord(datasetIdFrom(request)) });
  } catch (error) {
    sendApiError(response, error);
  }
});

// Public package metadata is read-only display data from the Assets v3
// package catalog. It is deliberately separate from Atlas-local labels.
app.get("/api/public-surveys", (_request: Request, response: Response) => {
  try {
    response.json({ surveys: publicSurveyRecords().map(surveyCardFor) });
  } catch (error) {
    sendApiError(response, error);
  }
});

app.get("/api/public-surveys/:id", (request: Request, response: Response) => {
  try {
    response.json({ survey: publicSurveyRecord(datasetIdFrom(request)) });
  } catch (error) {
    sendApiError(response, error);
  }
});

app.post("/api/surveys/:id/releases", async (request: Request, response: Response) => {
  try {
    response.status(201).json({ release: await surveys.addRelease(datasetIdFrom(request), request.body as SurveyReleaseRegistrationInput) });
  } catch (error) {
    sendApiError(response, error);
  }
});

app.get("/api/survey-footprints", async (_request: Request, response: Response) => {
  try {
    response.set("Cache-Control", "no-store");
    response.json(await effectiveFootprints());
  } catch (error) {
    sendApiError(response, error);
  }
});

app.get("/api/resource-packages", (_request: Request, response: Response) => {
  try {
    response.set("Cache-Control", "no-store");
    response.json({ packages: resourcePackages.list() });
  } catch (error) {
    sendApiError(response, error);
  }
});

app.get("/api/resource-packages/config", (_request: Request, response: Response) => {
  response.set("Cache-Control", "no-store");
  response.json({ config: { ...resourcePackages.catalogStatus(), adminConfigured: Boolean(resourceAdminToken) } });
});

app.put("/api/resource-packages/config", async (request: Request, response: Response) => {
  if (!requireResourceAdmin(request, response)) return;
  try {
    const catalogUrl = resourcePackages.setCatalogUrl(String(request.body?.catalogUrl ?? ""));
    const config = await persistResourceCatalogConfig(catalogUrl);
    response.json({ config: { ...resourcePackages.catalogStatus(), adminConfigured: true, updatedAt: config.updatedAt } });
  } catch (error) {
    sendApiError(response, error);
  }
});

app.post("/api/resource-packages/sync", async (request: Request, response: Response) => {
  if (!requireResourceAdmin(request, response)) return;
  try {
    const catalog = await resourcePackages.sync();
    response.json({ catalog, packages: resourcePackages.list() });
  } catch (error) {
    sendApiError(response, error);
  }
});

app.get("/api/resource-packages/active-footprints", async (_request: Request, response: Response) => {
  try {
    response.set("Cache-Control", "no-store");
    response.json(await effectiveFootprints());
  } catch (error) {
    sendApiError(response, error);
  }
});

app.get("/api/resource-packages/jobs/:id", (request: Request, response: Response) => {
  try {
    response.json({ job: resourcePackages.job(datasetIdFrom(request)) });
  } catch (error) {
    sendApiError(response, error);
  }
});

app.post("/api/resource-packages/:id/install", (request: Request, response: Response) => {
  try {
    response.status(202).json({ job: resourcePackages.install(datasetIdFrom(request)) });
  } catch (error) {
    sendApiError(response, error);
  }
});

app.get("/api/resource-packages/:id/mocs", async (request: Request, response: Response) => {
  try {
    response.set("Cache-Control", "no-store");
    response.json({ layers: await resourcePackages.mocLayers(datasetIdFrom(request)) });
  } catch (error) {
    sendApiError(response, error);
  }
});

app.get("/api/resource-packages/:id/mocs/:layerId", async (request: Request, response: Response) => {
  try {
    const rawLayerId = request.params.layerId;
    const layerId = Array.isArray(rawLayerId) ? rawLayerId[0] : rawLayerId;
    if (!layerId) throw new RangeError("resource package MOC layer id is required");
    const artifact = await resourcePackages.mocArtifact(datasetIdFrom(request), layerId);
    response.set({
      "Content-Type": "application/fits",
      "Content-Length": String(artifact.byteLength),
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "ETag": `\"${artifact.sha256}\"`,
      "Content-Disposition": `attachment; filename=\"${artifact.layerId}.moc.fits\"`,
    });
    response.sendFile(artifact.filePath);
  } catch (error) {
    sendApiError(response, error);
  }
});

app.put("/api/resource-packages/active", async (request: Request, response: Response) => {
  try {
    const loads = request.body?.loads ?? (Array.isArray(request.body?.ids)
      ? request.body.ids.map((packageId: unknown) => {
          const record = typeof packageId === "string" ? resourcePackages.get(packageId) : undefined;
          return { packageId, releaseIds: record?.availableReleaseIds };
        })
      : request.body?.loads);
    response.json({ packages: await resourcePackages.setActive(loads as ResourcePackageLoad[]) });
  } catch (error) {
    sendApiError(response, error);
  }
});

app.post("/api/resource-packages/:id/activate", async (request: Request, response: Response) => {
  try {
    response.json({ package: await resourcePackages.activate(datasetIdFrom(request)) });
  } catch (error) {
    sendApiError(response, error);
  }
});

app.post("/api/resource-packages/:id/deactivate", async (request: Request, response: Response) => {
  try {
    response.json({ package: await resourcePackages.deactivate(datasetIdFrom(request)) });
  } catch (error) {
    sendApiError(response, error);
  }
});

app.delete("/api/resource-packages/:id", async (request: Request, response: Response) => {
  try {
    await resourcePackages.remove(datasetIdFrom(request));
    response.status(204).end();
  } catch (error) {
    sendApiError(response, error);
  }
});

app.post("/api/surveys/registrations", async (request: Request, response: Response) => {
  try {
    // User registrations are Atlas-local and never require a public package.
    const survey = await surveys.register(request.body as SurveyRegistrationInput);
    response.status(201).json({ survey });
  } catch (error) {
    sendApiError(response, error);
  }
});

app.get("/api/user-mocs", async (_request: Request, response: Response) => {
  try {
    response.set("Cache-Control", "no-store");
    response.json({ artifacts: await userMocs.list() });
  } catch (error) {
    sendApiError(response, error);
  }
});

app.get("/api/user-mocs/:layerId/:scanRunId/:name", async (request: Request, response: Response) => {
  try {
    const layerId = Array.isArray(request.params.layerId) ? request.params.layerId[0] : request.params.layerId;
    const scanRunId = Array.isArray(request.params.scanRunId) ? request.params.scanRunId[0] : request.params.scanRunId;
    const name = Array.isArray(request.params.name) ? request.params.name[0] : request.params.name;
    if (!layerId || !scanRunId || !name) throw new RangeError("user MOC artifact path is incomplete");
    const { artifact, filePath } = await userMocs.filePath(layerId, scanRunId, name);
    const file = artifact.files.find((candidate) => candidate.name === path.basename(name));
    response.set({
      "Content-Type": file?.mediaType ?? "application/octet-stream",
      ...(file ? { "Content-Length": String(file.byteLength) } : {}),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": name.endsWith(".fits") ? `attachment; filename="${path.basename(name)}"` : `inline; filename="${path.basename(name)}"`,
    });
    response.sendFile(filePath);
  } catch (error) {
    sendApiError(response, error);
  }
});

function queryCells(value: unknown, maximum = 64): number[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const cells = raw.map((entry) => Number(entry)).filter((entry) => Number.isInteger(entry));
  if (!cells.length || cells.length > maximum) throw new RangeError(`cells must contain between 1 and ${maximum} HEALPix pixels`);
  if (cells.some((cell) => cell < 0)) throw new RangeError("cells must contain non-negative HEALPix pixels");
  return [...new Set(cells)];
}

function queryText(value: unknown, name: string, maximum = 160): string | undefined {
  if (value == null || value === "") return undefined;
  if (typeof value !== "string" || value.trim().length > maximum) throw new RangeError(`${name} is invalid`);
  return value.trim() || undefined;
}

app.get("/api/sky/overview", async (request: Request, response: Response) => {
  try {
    const survey = queryText(request.query.survey, "survey");
    const release = queryText(request.query.release, "release");
    const nside = Number(request.query.nside ?? ASTRO_OVERVIEW_NSIDE);
    if (!survey || !release) throw new RangeError("survey and release are required");
    if (!Number.isInteger(nside) || nside < 1) throw new RangeError("nside must be a positive integer");
    response.json(await astroIndex.overview({
      survey,
      release,
      nside,
      cells: queryCells(request.query.cells),
    }));
  } catch (error) {
    sendApiError(response, error);
  }
});

app.post("/api/sky/query", async (request: Request, response: Response) => {
  try {
    const body = (request.body ?? {}) as Partial<AstroSkyQueryInput>;
    const nside = Number(body.nside ?? ASTRO_OVERVIEW_NSIDE);
    if (!Number.isInteger(nside) || nside < 1) throw new RangeError("nside must be a positive integer");
    const assetIds = body.assetIds == null
      ? undefined
      : Array.isArray(body.assetIds) && body.assetIds.every((value) => typeof value === "string")
        ? body.assetIds
        : (() => { throw new RangeError("assetIds must be an array of strings"); })();
    response.json(await astroIndex.query({
      nside,
      cells: queryCells(body.cells),
      survey: queryText(body.survey, "survey"),
      release: queryText(body.release, "release"),
      product: queryText(body.product, "product"),
      modality: queryText(body.modality, "modality"),
      assetIds,
    }));
  } catch (error) {
    sendApiError(response, error);
  }
});

app.post("/api/sky/cells/query", async (request: Request, response: Response) => {
  try {
    response.json(await astroObjectIndex.queryCells(request.body as AstroCellsQueryInput));
  } catch (error) {
    sendApiError(response, error);
  }
});

app.post("/api/sky/objects/query", async (request: Request, response: Response) => {
  try {
    response.json(await astroObjectIndex.queryObjects(request.body as ObjectRegionQueryInput));
  } catch (error) {
    sendApiError(response, error);
  }
});

interface SkyOverlapRequest {
  nside?: unknown;
  sourceIds?: unknown;
  surveyIds?: unknown;
  releaseIds?: unknown;
  assetIds?: unknown;
  includePublic?: unknown;
  includeWorkspace?: unknown;
}

function stringArrayInput(value: unknown, name: string, maximum = 256): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maximum || value.some((entry) => typeof entry !== "string" || !entry.trim() || entry.length > 160)) {
    throw new RangeError(`${name} must be an array of non-empty strings`);
  }
  return [...new Set(value.map((entry) => entry.trim()))];
}

function booleanInput(value: unknown, name: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new RangeError(`${name} must be a boolean`);
  return value;
}

function overlapSourceIdForPublic(footprint: SurveyFootprintManifest["footprints"][number]): string {
  return `public:${footprint.surveyId}:${footprint.releaseId}:${footprint.product}`;
}

function overlapSourceIdForAsset(assetId: string): string {
  return `workspace:asset:${assetId}`;
}

function overlapSourceMatches(source: SkyOverlapSource, filters: {
  sourceIds?: ReadonlySet<string>;
  surveyIds?: ReadonlySet<string>;
  releaseIds?: ReadonlySet<string>;
  assetIds?: ReadonlySet<string>;
}): boolean {
  if (filters.sourceIds?.size && !filters.sourceIds.has(source.id)) return false;
  if (filters.surveyIds?.size && (!source.surveyId || !filters.surveyIds.has(source.surveyId))) return false;
  if (filters.releaseIds?.size && (!source.releaseId || !filters.releaseIds.has(source.releaseId))) return false;
  // Asset filters scope workspace sources. Public footprints intentionally
  // remain eligible so a mixed public/workspace overlap can be requested.
  if (filters.assetIds?.size && source.kind === "workspace" && (!source.assetId || !filters.assetIds.has(source.assetId))) return false;
  return true;
}

interface OverlapSourceContext {
  nside: number;
  sourceIds?: ReadonlySet<string>;
  surveyIds?: ReadonlySet<string>;
  releaseIds?: ReadonlySet<string>;
  assetIds?: ReadonlySet<string>;
  includePublic: boolean;
  includeWorkspace: boolean;
}

async function overlapSources(context: OverlapSourceContext): Promise<SkyOverlapSource[]> {
  const result = new Map<string, SkyOverlapSource>();
  const accept = (source: SkyOverlapSource): void => {
    if (!source.pixels.length || !overlapSourceMatches(source, context)) return;
    result.set(source.id, { ...source, pixels: [...new Set(source.pixels)].sort((left, right) => left - right) });
  };

  if (context.includePublic) {
    let manifest: SurveyFootprintManifest | undefined;
    try { manifest = await effectiveFootprints(); } catch (error) { console.warn("Public overlap sources unavailable", error); }
    manifest?.footprints
      .filter((footprint) => footprint.nside === context.nside)
      .forEach((footprint) => accept({
        id: overlapSourceIdForPublic(footprint),
        label: footprint.label,
        kind: "public",
        nside: footprint.nside,
        pixels: footprint.pixels,
        surveyId: footprint.surveyId,
        releaseId: footprint.releaseId,
        product: footprint.product,
        sourceUrl: footprint.sourceUrl,
      }));
  }

  if (!context.includeWorkspace) return [...result.values()].sort((left, right) => left.id.localeCompare(right.id));
  const assets = (await dataCatalog.list()).filter((asset) => {
    if (context.assetIds?.size && !context.assetIds.has(asset.id)) return false;
    if (context.surveyIds?.size && (!asset.surveyId || !context.surveyIds.has(asset.surveyId))) return false;
    if (context.releaseIds?.size && (!asset.releaseId || !context.releaseIds.has(asset.releaseId))) return false;
    return true;
  });
  const artifacts = await userMocs.list();
  const runs = await connectorRuns.list();
  const warehouseLayerIds = workspaceWarehouseLayerIds(assets, artifacts, runs);
  const warehouse = await warehouseIndex.coverage({
    nside: context.nside,
    ...(assets.length ? { assetIds: assets.map((asset) => asset.id) } : {}),
    layerIds: warehouseLayerIds,
  });
  const artifactSelections = selectUserMocArtifacts(artifacts);
  await Promise.all(assets.map(async (asset) => {
    const [legacy, local] = await Promise.all([
      context.nside <= ASTRO_OVERVIEW_NSIDE
        ? astroIndex.coverage({ nside: context.nside, assetIds: [asset.id] })
        : Promise.resolve({ status: "unavailable" as const, index: ASTRO_FILE_INDEX, nside: context.nside, pixels: [], byAsset: [], message: "legacy coverage supports NSIDE up to 16" }),
      astroObjectIndex.queryCoverageFacts({ nside: context.nside, assetIds: [asset.id] }),
    ]);
    const pixels = new Set<number>([...legacy.pixels, ...local.pixels]);
    warehouse.layers.filter((layer) => warehouseLayerForAsset(layer, asset)).forEach((layer) => layer.pixels.forEach((pixel) => pixels.add(pixel)));
    const mocSelection = [...artifactSelections.values()].find(({ latest }) => latest.layerId === workspaceLayerIdForAsset(asset.id) || latest.layerId === asset.id || latest.layerId === `user-${asset.id}`);
    if (mocSelection) {
      const projection = await userMocs.projection(mocSelection.renderable.layerId, mocSelection.renderable.scanRunId, Math.log2(context.nside)).catch(() => ({ order: Math.log2(context.nside), pixels: [] }));
      projection.pixels.forEach((pixel) => pixels.add(pixel));
    }
    const access = [asset.access, ...(asset.accesses ?? [])].find((entry) => entry.connector !== "metadata");
    accept({
      id: overlapSourceIdForAsset(asset.id),
      label: asset.name,
      kind: "workspace",
      nside: context.nside,
      pixels: [...pixels],
      surveyId: asset.surveyId,
      releaseId: asset.releaseId,
      assetId: asset.id,
      product: asset.product,
      modality: asset.modalities[0],
      sourceUrl: access?.uri,
    });
  }));
  // Keep unassigned Warehouse/MOC layers discoverable for workspaces that have
  // no Atlas asset row yet. They are still explicit workspace sources, never
  // folded into a public footprint.
  warehouse.layers.filter((layer) => !layer.assetIds.length && layer.pixels.length).forEach((layer) => accept({
    id: `workspace:warehouse:${layer.layerId}`,
    label: layer.productId || layer.layerId,
    kind: "workspace",
    nside: context.nside,
    pixels: layer.pixels,
    surveyId: layer.surveyId,
    releaseId: layer.releaseId,
    product: layer.productId,
    modality: layer.modality,
  }));
  return [...result.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function overlapContext(body: SkyOverlapRequest): OverlapSourceContext {
  const nside = Number(body.nside ?? ASTRO_OVERVIEW_NSIDE);
  nsideOrderForCoverage(nside);
  const toSet = (value: unknown, name: string): ReadonlySet<string> | undefined => {
    const values = stringArrayInput(value, name);
    return values === undefined ? undefined : new Set(values);
  };
  return {
    nside,
    sourceIds: toSet(body.sourceIds, "sourceIds"),
    surveyIds: toSet(body.surveyIds, "surveyIds"),
    releaseIds: toSet(body.releaseIds, "releaseIds"),
    assetIds: toSet(body.assetIds, "assetIds"),
    includePublic: booleanInput(body.includePublic, "includePublic", true),
    includeWorkspace: booleanInput(body.includeWorkspace, "includeWorkspace", true),
  };
}

function overlapPixelsInput(value: unknown, maximum = 4096): number[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum || value.some((entry) => !Number.isSafeInteger(entry) || Number(entry) < 0)) {
    throw new RangeError(`pixels must contain between 1 and ${maximum} HEALPix cells`);
  }
  return [...new Set(value as number[])].sort((left, right) => left - right);
}

interface ReverseLookupUnavailable {
  sourceId: string;
  url?: string;
  reason: string;
}

interface ReverseLookupResult {
  files: CoverageDownloadFile[];
  unavailable: ReverseLookupUnavailable[];
  warnings?: string[];
}

async function reverseLookupFiles(sources: readonly SkyOverlapSource[]): Promise<ReverseLookupResult> {
  const files = new Map<string, CoverageDownloadFile>();
  const unavailable = new Map<string, ReverseLookupUnavailable>();
  const usedNames = new Set<string>();
  const warnings: string[] = [];
  const discoveredSources = await Promise.all([...sources]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(async (source) => ({ source, discovered: /^https?:\/\//i.test(source.sourceUrl ?? "") ? await discoverSourceFiles(source.sourceUrl!) : undefined })));
  discoveredSources.forEach(({ source, discovered }) => {
    if (!source.sourceUrl) {
      unavailable.set(source.id, { sourceId: source.id, reason: "来源没有可反查的文件 URL" });
      return;
    }
    if (!/^https?:\/\//i.test(source.sourceUrl)) {
      unavailable.set(source.id, {
        sourceId: source.id,
        url: source.sourceUrl,
        reason: /^s3:\/\//i.test(source.sourceUrl)
          ? "S3 URL 需要配置凭据后才能下载"
          : "仅支持 HTTP/HTTPS 文件 URL",
      });
      return;
    }
    if (!discovered) return;
    if (!discovered.files.length) {
      unavailable.set(source.id, {
        sourceId: source.id,
        url: source.sourceUrl,
        reason: discovered.reason ?? "爬虫未发现可下载文件",
      });
      return;
    }
    discovered.files.forEach((candidate, index) => {
      let name = candidate.name;
      if (usedNames.has(name)) {
        const suffix = source.id.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "").slice(-24) || "source";
        const extension = name.match(/\.[a-z0-9]{1,8}(?:\.gz)?$/i)?.[0] ?? "";
        const stem = extension ? name.slice(0, -extension.length) : name;
        name = `${stem}-${suffix}${extension}`;
        let serial = 2;
        while (usedNames.has(name)) name = `${stem}-${suffix}-${serial++}${extension}`;
      }
      usedNames.add(name);
      const key = `${candidate.url}\u0000${source.id}\u0000${index}`;
      files.set(key, { ...candidate, name, sourceId: source.id });
    });
    if (discovered.truncated) warnings.push(`${source.label}：来源文件过多，仅返回前 128 个文件`);
  });
  return {
    files: [...files.values()].sort((left, right) => left.url.localeCompare(right.url)),
    unavailable: [...unavailable.values()].sort((left, right) => left.sourceId.localeCompare(right.sourceId)),
    ...(warnings.length ? { warnings } : {}),
  };
}

app.post("/api/sky/overlap", async (request: Request, response: Response) => {
  try {
    const context = overlapContext((request.body ?? {}) as SkyOverlapRequest);
    const sources = await overlapSources(context);
    const result = calculateSkyOverlap(sources, context.nside);
    response.json({ ...result, sources });
  } catch (error) {
    sendApiError(response, error);
  }
});

app.post("/api/sky/overlap/details", async (request: Request, response: Response) => {
  try {
    const body = (request.body ?? {}) as SkyOverlapRequest & { componentId?: unknown; pixels?: unknown };
    const context = overlapContext(body);
    const sources = await overlapSources(context);
    const overlap = calculateSkyOverlap(sources, context.nside);
    const componentId = typeof body.componentId === "string" ? body.componentId : undefined;
    const component = componentId ? overlap.components.find((candidate) => candidate.id === componentId) : undefined;
    if (componentId && !component) throw new Error(`Overlap component not found: ${componentId}`);
    const pixels = component?.cells ?? (body.pixels === undefined ? overlap.pixels : overlapPixelsInput(body.pixels));
    const selectedSources = sources.filter((source) => pixels.some((pixel) => source.pixels.includes(pixel)));
    response.json({ component: component ?? null, pixels, sources: selectedSources, ...(await reverseLookupFiles(selectedSources)) });
  } catch (error) {
    sendApiError(response, error);
  }
});

app.post("/api/sky/reverse-lookup", async (request: Request, response: Response) => {
  try {
    const body = (request.body ?? {}) as SkyOverlapRequest & { componentId?: unknown; pixels?: unknown };
    const context = overlapContext(body);
    const sources = await overlapSources(context);
    let pixels = body.pixels === undefined ? undefined : overlapPixelsInput(body.pixels);
    if (typeof body.componentId === "string") {
      const overlap = calculateSkyOverlap(sources, context.nside);
      const component = overlap.components.find((candidate) => candidate.id === body.componentId);
      if (!component) throw new Error(`Overlap component not found: ${body.componentId}`);
      pixels = component.cells;
    }
    if (!pixels?.length) throw new RangeError("pixels or componentId is required");
    const selectedSources = sources.filter((source) => pixels!.some((pixel) => source.pixels.includes(pixel)));
    response.json({ pixels, sources: selectedSources, ...(await reverseLookupFiles(selectedSources)) });
  } catch (error) {
    sendApiError(response, error);
  }
});

interface CoverageDownloadRequest {
  files: CoverageDownloadFile[];
  componentId?: string;
  sourceIds?: string[];
}

function coverageDownloadInput(value: unknown): CoverageDownloadRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RangeError("coverage download body must be an object");
  const body = value as Record<string, unknown>;
  if (!Array.isArray(body.files)) throw new RangeError("files is required");
  const text = (entry: unknown, name: string): string | undefined => {
    if (entry === undefined) return undefined;
    if (typeof entry !== "string" || !entry.trim() || entry.trim().length > 180) throw new RangeError(`${name} is invalid`);
    return entry.trim();
  };
  const sourceIds = stringArrayInput(body.sourceIds, "sourceIds");
  if (body.targetConnectorId !== undefined) {
    throw new RangeError("targetConnectorId is not supported; coverage downloads create a new Connector");
  }
  const componentId = text(body.componentId, "componentId");
  return {
    files: body.files as CoverageDownloadFile[],
    ...(componentId ? { componentId } : {}),
    ...(sourceIds?.length ? { sourceIds } : {}),
  };
}

function assertCoverageDownloadOutputConfigured(): void {
  // ConnectorRegistry intentionally rejects local paths outside the configured
  // roots. Check the lexical boundary before creating an asynchronous job so a
  // missing writable root is reported by the request rather than hidden in a
  // background failure.
  localConnectorRoots.assertConfiguredPath(path.join(coverageDownloadRoot, "files"));
}

app.post("/api/coverage-downloads", async (request: Request, response: Response) => {
  try {
    const input = coverageDownloadInput(request.body);
    assertCoverageDownloadOutputConfigured();
    response.status(202).json({ job: await coverageDownloads.submit(input) });
  } catch (error) {
    sendApiError(response, error);
  }
});

app.get("/api/coverage-downloads", async (_request: Request, response: Response) => {
  try {
    response.set("Cache-Control", "no-store");
    response.json({ jobs: await coverageDownloads.list() });
  } catch (error) {
    sendApiError(response, error);
  }
});

app.get("/api/coverage-downloads/:id", async (request: Request, response: Response) => {
  try {
    response.json({ job: await coverageDownloads.get(datasetIdFrom(request)) });
  } catch (error) {
    sendApiError(response, error);
  }
});

app.post("/api/coverage-downloads/:id/cancel", async (request: Request, response: Response) => {
  try {
    response.json({ job: await coverageDownloads.cancel(datasetIdFrom(request)) });
  } catch (error) {
    sendApiError(response, error);
  }
});

type WorkspaceCoverageStatus = "ready" | "pending" | "unavailable" | "error";

function nsideOrderForCoverage(nside: number): number {
  if (!Number.isInteger(nside) || nside < 1 || (nside & (nside - 1)) !== 0 || nside > 256) {
    throw new RangeError("nside must be a power of two between 1 and 256");
  }
  return Math.log2(nside);
}

function workspaceLayerIdForAsset(assetId: string): string {
  return `workspace-${assetId}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 180) || "workspace-asset";
}

function coverageStatus(value: string | undefined): WorkspaceCoverageStatus {
  if (value === "pending" || value === "error" || value === "unavailable") return value;
  return "ready";
}

function hasActiveWarehouseCoverage(layers: readonly WarehouseCoverageLayer[]): boolean {
  return layers.some((layer) => layer.state === "ACTIVE" && layer.status === "ready");
}

function aggregateCoverageStatus(values: readonly WorkspaceCoverageStatus[]): WorkspaceCoverageStatus {
  // A healthy local index or artifact remains useful when the optional
  // Warehouse endpoint is down. Surface that degradation through `message`
  // without hiding the ready coverage from the viewer.
  if (values.includes("ready")) return "ready";
  if (values.includes("error")) return "error";
  if (values.includes("pending")) return "pending";
  if (values.length > 0 && values.every((value) => value === "unavailable")) return "unavailable";
  // Empty evidence is not a healthy index. Callers can distinguish a real
  // ready-but-empty scan by inspecting its run/artifact state.
  return "unavailable";
}

function warehouseLayerForAsset(layer: WarehouseCoverageLayer, asset: DataAssetRecord): boolean {
  return layer.layerId === asset.id || layer.layerId === workspaceLayerIdForAsset(asset.id) || layer.layerId === `user-${asset.id}`;
}

function artifactMatchesCoverageFilter(artifact: UserMocArtifact, asset: DataAssetRecord | undefined, survey?: string, release?: string): boolean {
  // User-MOC metadata intentionally does not duplicate mutable asset labels.
  // Once a caller asks for a survey/release, an artifact without a local asset
  // association cannot be safely attributed and must stay out of the result.
  if (!survey && !release) return true;
  if (!asset) return false;
  return (!survey || asset.surveyId === survey) && (!release || asset.releaseId === release);
}

interface UserMocArtifactSelection {
  latest: UserMocArtifact;
  renderable: UserMocArtifact;
}

function artifactTimestamp(artifact: UserMocArtifact): string {
  return `${artifact.updatedAt}\u0000${artifact.createdAt}\u0000${artifact.id}`;
}

/**
 * Keep the newest artifact as the task state, but retain the newest validated
 * artifact as the display/download source while a replacement is pending or
 * failed. Artifact history remains available through /api/user-mocs.
 */
function selectUserMocArtifacts(artifacts: readonly UserMocArtifact[]): Map<string, UserMocArtifactSelection> {
  const grouped = new Map<string, UserMocArtifact[]>();
  artifacts.forEach((artifact) => {
    const entries = grouped.get(artifact.layerId) ?? [];
    entries.push(artifact);
    grouped.set(artifact.layerId, entries);
  });
  const selected = new Map<string, UserMocArtifactSelection>();
  grouped.forEach((entries, layerId) => {
    const ordered = [...entries].sort((left, right) => artifactTimestamp(right).localeCompare(artifactTimestamp(left)));
    const latest = ordered[0];
    if (!latest) return;
    const renderable = ordered.find((artifact) => artifact.status === "ready") ?? latest;
    selected.set(layerId, { latest, renderable });
  });
  return selected;
}

function workspaceWarehouseLayerIds(
  assets: readonly DataAssetRecord[],
  artifacts: readonly UserMocArtifact[],
  runs: readonly ConnectorIngestRunRecord[],
): string[] {
  const ids = new Set<string>();
  for (const asset of assets) {
    ids.add(asset.id);
    ids.add(workspaceLayerIdForAsset(asset.id));
    ids.add(`user-${asset.id}`);
  }
  artifacts.forEach((artifact) => ids.add(artifact.layerId));
  runs
    // Only the current Workspace executor has an explicit ownership marker.
    // Older records can be present in the shared metadata store after Assets
    // and Workspace were upgraded independently; taskKind alone is not enough
    // to distinguish those records.
    .filter((run) => run.backend === "warehouse"
      && run.executor === "warehouse-scan"
      && (run.taskKind === "user_scan" || run.taskKind === "user_coverage")
      && run.batchId?.startsWith("workspace-")
      && run.warehouseLayerId?.startsWith("workspace-"))
    .map((run) => run.warehouseLayerId)
    .filter((layerId): layerId is string => Boolean(layerId))
    .forEach((layerId) => ids.add(layerId));
  return [...ids].sort();
}

function mergeCoveragePrecision(left: AstroCoverageLayer["precision"], right: AstroCoverageLayer["precision"]): AstroCoverageLayer["precision"] {
  if (left === "entrypoint-only" || right === "entrypoint-only") return "entrypoint-only";
  if (left === "estimated" || right === "estimated") return "estimated";
  return left ?? right;
}

function mergeCoverageLayers(base: AstroCoverageLayer, extra: AstroCoverageLayer, key: string): AstroCoverageLayer {
  const status = aggregateCoverageStatus([
    coverageStatus(base.status),
    coverageStatus(extra.status),
  ]);
  const byAsset = new Map<string, AstroCoverageLayer["byAsset"][number]>();
  [...base.byAsset, ...extra.byAsset].forEach((entry) => {
    if (!byAsset.has(entry.key)) byAsset.set(entry.key, entry);
  });
  const messages = [base.message, extra.message].filter((value): value is string => Boolean(value));
  return {
    ...base,
    ...extra,
    key,
    status,
    source: base.source === extra.source ? base.source : "combined",
    pixels: [...new Set([...base.pixels, ...extra.pixels])].sort((left, right) => left - right),
    byAsset: [...byAsset.values()],
    assetIds: [...new Set([...base.assetIds, ...extra.assetIds])].sort(),
    availableOrders: [...new Set([...(base.availableOrders ?? []), ...(extra.availableOrders ?? [])])].sort((left, right) => left - right),
    nativeOrders: [...new Set([...(base.nativeOrders ?? []), ...(extra.nativeOrders ?? [])])].sort((left, right) => left - right),
    ...(base.maxOrder === undefined && extra.maxOrder === undefined
      ? {}
      : { maxOrder: Math.max(base.maxOrder ?? 0, extra.maxOrder ?? 0) }),
    precision: mergeCoveragePrecision(base.precision, extra.precision),
    ...(messages.length ? { message: [...new Set(messages)].join("; ") } : {}),
  };
}

async function artifactCoverageLayer(
  artifact: UserMocArtifact,
  nside: number,
  asset?: DataAssetRecord,
  latestArtifact: UserMocArtifact = artifact,
): Promise<AstroCoverageLayer> {
  const order = nsideOrderForCoverage(nside);
  const projection = await userMocs.projection(artifact.layerId, artifact.scanRunId, order).catch(() => ({ order, pixels: [] }));
  const status: WorkspaceCoverageStatus = artifact.status === "ready" ? "ready" : artifact.status === "failed" ? "error" : artifact.status === "pending" ? "pending" : "unavailable";
  const messages = [artifact.error, latestArtifact.id === artifact.id ? undefined : latestArtifact.error].filter((value): value is string => Boolean(value));
  return {
    key: asset ? `asset:${asset.id}` : `moc:${artifact.id}`,
    layerId: artifact.layerId,
    ...(asset ? { assetId: asset.id, assetIds: [asset.id], assetName: asset.name, surveyId: asset.surveyId, releaseId: asset.releaseId } : { assetIds: [] }),
    status,
    source: "asset",
    ...(messages.length ? { message: [...new Set(messages)].join("; ") } : {}),
    nside,
    pixels: projection.pixels,
    availableOrders: artifact.availableOrders,
    ...(artifact.maxOrder === undefined ? {} : { maxOrder: artifact.maxOrder }),
    precision: artifact.precision,
    ...(artifact.coverageRole ? { coverageRole: artifact.coverageRole } : {}),
    mocStatus: artifact.status,
    artifactId: artifact.id,
    latestMocStatus: latestArtifact.status,
    latestArtifactId: latestArtifact.id,
    byAsset: asset ? [{ key: asset.id, label: asset.name, files: 0, bytes: 0 }] : [],
  };
}

app.get("/api/sky/coverage", async (request: Request, response: Response) => {
  try {
    const nside = Number(request.query.nside ?? ASTRO_OVERVIEW_NSIDE);
    nsideOrderForCoverage(nside);
    const rawAssetIds = typeof request.query.assetIds === "string" ? request.query.assetIds : "";
    const assetIds = rawAssetIds.split(",").map((value) => value.trim()).filter(Boolean);
    const survey = queryText(request.query.survey, "survey");
    const release = queryText(request.query.release, "release");
    const baseInput = {
      nside,
      ...(survey ? { survey } : {}),
      ...(release ? { release } : {}),
    };

    const artifacts = await userMocs.list();
    const artifactSelections = selectUserMocArtifacts(artifacts);
    const knownAssets = await dataCatalog.list();
    const runs = await connectorRuns.list();
    const ownedWarehouseLayerIds = workspaceWarehouseLayerIds(knownAssets, artifacts, runs);
    const warehouse = await warehouseIndex.coverage({
      nside,
      ...(assetIds.length ? { assetIds } : {}),
      ...(survey ? { survey } : {}),
      ...(release ? { release } : {}),
      layerIds: ownedWarehouseLayerIds,
    });

    // ES documents written by older scanner jobs may have blank survey / release
    // fields. Use the Atlas asset's own local labels when assembling per-asset
    // layers; never infer them from a Connector or the Assets package.
    if (assetIds.length) {
      const layers: AstroCoverageLayer[] = [];
      const allPixels = new Set<number>();
      const allAssets = new Map<string, AstroCoverageLayer["byAsset"][number]>();
      const statuses: WorkspaceCoverageStatus[] = [];
      const messages: string[] = [];
      for (const assetId of [...new Set(assetIds)]) {
        let asset: DataAssetRecord;
        try { asset = await dataCatalog.get(assetId); } catch { continue; }
        if (survey && asset.surveyId !== survey) continue;
        if (release && asset.releaseId !== release) continue;
        // Query both indexes by one asset id. The object coverage index is the
        // authoritative projection for local CSV scans; the file index keeps
        // historical scanner documents visible without rewriting them.
        const [legacy, local] = await Promise.all([
          nside <= ASTRO_OVERVIEW_NSIDE
            ? astroIndex.coverage({ nside, assetIds: [assetId] })
            : Promise.resolve({ status: "unavailable" as const, index: ASTRO_FILE_INDEX, nside, pixels: [], byAsset: [], message: "legacy file coverage is available only through NSIDE 16" }),
          astroObjectIndex.queryCoverageFacts({ nside, assetIds: [assetId] }),
        ]);
        const warehouseLayer = warehouse.layers.find((candidate) => warehouseLayerForAsset(candidate, asset));
        const artifactSelection = [...artifactSelections.values()].find(({ latest }) => latest.layerId === workspaceLayerIdForAsset(asset.id)
          || latest.layerId === asset.id
          || latest.layerId === `user-${asset.id}`);
        const mocLayer = artifactSelection
          ? await artifactCoverageLayer(artifactSelection.renderable, nside, asset, artifactSelection.latest)
          : undefined;
        const pixels = new Set<number>(legacy.pixels);
        local.pixels.forEach((pixel) => pixels.add(pixel));
        warehouseLayer?.pixels.forEach((pixel) => pixels.add(pixel));
        mocLayer?.pixels.forEach((pixel) => pixels.add(pixel));
        const objectCount = local.facts.reduce((sum, fact) => sum + fact.objectCount, 0);
        const status = aggregateCoverageStatus([
          coverageStatus(legacy.status),
          coverageStatus(local.status),
          ...(warehouseLayer ? [coverageStatus(warehouseLayer.status)] : warehouse.status === "error" ? ["error" as const] : []),
          ...(mocLayer ? [coverageStatus(mocLayer.status)] : []),
        ]);
        const message = [
          legacy.status === "error" ? legacy.message : undefined,
          local.status !== "ready" ? local.message : undefined,
          warehouseLayer?.message,
          mocLayer?.message,
        ].filter(Boolean).join("; ") || undefined;
        const breakdown = {
          key: asset.id,
          label: asset.name,
          files: legacy.byAsset.find((entry) => entry.key === asset.id)?.files ?? 0,
          bytes: legacy.byAsset.find((entry) => entry.key === asset.id)?.bytes ?? 0,
          objects: objectCount,
          objectCount,
        };
        const layer = {
          key: `asset:${asset.id}`,
          assetId: asset.id,
          assetName: asset.name,
          surveyId: asset.surveyId,
          releaseId: asset.releaseId,
          source: asset.surveyId ? "asset" as const : "unassigned" as const,
          message,
          status,
          assetIds: [asset.id],
          pixels: [...pixels].sort((left, right) => left - right),
          objectCount,
          byAsset: [breakdown],
          layerId: warehouseLayer?.layerId ?? mocLayer?.layerId ?? workspaceLayerIdForAsset(asset.id),
          productId: warehouseLayer?.productId ?? asset.product,
          modality: warehouseLayer?.modality ?? asset.modalities[0],
          coverageRole: warehouseLayer?.coverageRole ?? mocLayer?.coverageRole,
          nativeOrders: warehouseLayer?.nativeOrders ?? mocLayer?.availableOrders,
          availableOrders: warehouseLayer?.availableOrders ?? mocLayer?.availableOrders,
          maxOrder: warehouseLayer?.maxOrder ?? mocLayer?.maxOrder,
          precision: warehouseLayer?.precision ?? mocLayer?.precision,
          state: warehouseLayer?.state,
          mocStatus: mocLayer?.mocStatus,
          artifactId: mocLayer?.artifactId,
        } satisfies AstroCoverageLayer;
        statuses.push(status);
        if (message) messages.push(message);
        allAssets.set(asset.id, breakdown);
        pixels.forEach((pixel) => allPixels.add(pixel));
        layers.push(layer);
      }
      if (layers.length) {
        const status = aggregateCoverageStatus(statuses);
        response.json({
          status,
          index: hasActiveWarehouseCoverage(warehouse.layers) ? warehouse.index : astroObjectIndex.coverageIndex,
          nside,
          pixels: [...allPixels].sort((left, right) => left - right),
          byAsset: [...allAssets.values()],
          layers,
          ...(messages.length ? { message: [...new Set(messages)].join("; ") } : {}),
        });
        return;
      }
    }
    const local = nside <= ASTRO_OVERVIEW_NSIDE
      ? await astroIndex.coverage({ ...baseInput, ...(assetIds.length ? { assetIds } : {}) })
      : { status: "unavailable" as const, index: ASTRO_FILE_INDEX, nside, pixels: [], byAsset: [], message: "legacy file coverage is available only through NSIDE 16" };
    const assetForLayer = (layerId: string | undefined): DataAssetRecord | undefined => {
      if (!layerId) return undefined;
      return knownAssets.find((asset) => warehouseLayerForAsset({ ...({ layerId } as WarehouseCoverageLayer) }, asset));
    };
    const artifactLayers = await Promise.all([...artifactSelections.values()]
      .map((selection) => ({ selection, asset: assetForLayer(selection.latest.layerId) }))
      .filter(({ selection, asset }) => artifactMatchesCoverageFilter(selection.latest, asset, survey, release))
      .map(async ({ selection, asset }): Promise<AstroCoverageLayer> => {
        const layer = await artifactCoverageLayer(selection.renderable, nside, asset, selection.latest);
        return layer;
      }));
    const warehouseLayers = warehouse.layers.map((layer): AstroCoverageLayer => {
      const asset = assetForLayer(layer.layerId);
      return {
        key: layer.key,
        layerId: layer.layerId,
        surveyId: asset?.surveyId ?? layer.surveyId,
        releaseId: asset?.releaseId ?? layer.releaseId,
        productId: layer.productId ?? asset?.product,
        modality: layer.modality ?? asset?.modalities[0],
        coverageRole: layer.coverageRole,
        assetIds: asset ? [asset.id] : layer.assetIds,
        ...(asset ? { assetId: asset.id, assetName: asset.name } : {}),
        pixels: layer.pixels,
        byAsset: [],
        status: coverageStatus(layer.status),
        source: "warehouse",
        message: layer.message,
        nside,
        nativeOrders: layer.nativeOrders,
        availableOrders: layer.availableOrders,
        ...(layer.maxOrder === undefined ? {} : { maxOrder: layer.maxOrder }),
        precision: layer.precision,
        state: layer.state,
      };
    });
    const layersByKey = new Map<string, AstroCoverageLayer>();
    warehouseLayers.forEach((layer) => {
      const asset = assetForLayer(layer.layerId);
      const key = asset ? `asset:${asset.id}` : `warehouse:${layer.layerId}`;
      layersByKey.set(key, { ...layer, key });
    });
    artifactLayers.forEach((layer) => {
      const asset = layer.assetId ? knownAssets.find((candidate) => candidate.id === layer.assetId) : assetForLayer(layer.layerId);
      const assetKey = asset ? `asset:${asset.id}` : undefined;
      const existingKey = assetKey ?? [...layersByKey.keys()].find((candidate) => layersByKey.get(candidate)?.layerId === layer.layerId);
      const key = existingKey ?? layer.key;
      const existing = layersByKey.get(key);
      layersByKey.set(key, existing ? mergeCoverageLayers(existing, layer, key) : { ...layer, key });
    });
    const layers = [...layersByKey.values()];
    response.json({
      ...local,
      status: aggregateCoverageStatus([
        coverageStatus(local.status),
        ...(warehouse.status === "error" ? ["error" as const] : warehouse.status === "unavailable" ? ["unavailable" as const] : []),
        ...layers.map((layer) => coverageStatus(layer.status)),
      ]),
      index: hasActiveWarehouseCoverage(warehouse.layers) ? warehouse.index : local.index,
      pixels: [...new Set([...local.pixels, ...layers.flatMap((layer) => layer.pixels)])].sort((left, right) => left - right),
      layers,
      ...(warehouse.message ? { message: [local.message, warehouse.message].filter(Boolean).join("; ") } : {}),
    });
  } catch (error) {
    sendApiError(response, error);
  }
});

app.get("/api/tools", (_request: Request, response: Response) => {
  response.json({ tools: workflowEngine.tools.list() });
});

app.get("/api/workflows", (_request: Request, response: Response) => {
  response.json({ workflows: workflowEngine.workflows.list() });
});

app.get("/api/workflows/:id", (request: Request, response: Response) => {
  try {
    response.json({ workflow: workflowEngine.workflows.get(datasetIdFrom(request)) });
  } catch (error) {
    sendApiError(response, error);
  }
});

app.post("/api/workflow-runs", async (request: Request, response: Response) => {
  try {
    const body = request.body as { workflowId?: unknown; input?: unknown };
    const workflowId = String(body?.workflowId ?? "");
    if (!workflowId) throw new RangeError("workflowId is required");
    response.status(202).json({ run: await workflowEngine.createRun(workflowId, body.input) });
  } catch (error) {
    sendApiError(response, error);
  }
});

app.get("/api/workflow-runs/:id", async (request: Request, response: Response) => {
  try {
    response.json({ run: await workflowStore.get(datasetIdFrom(request)) });
  } catch (error) {
    sendApiError(response, error);
  }
});

app.post("/api/workflow-runs/:id/decisions", async (request: Request, response: Response) => {
  try {
    response.status(202).json({ run: await workflowEngine.decide(datasetIdFrom(request), request.body) });
  } catch (error) {
    sendApiError(response, error);
  }
});

app.get("/api/workflow-runs/:id/artifacts/:name", async (request: Request, response: Response) => {
  try {
    const rawName = request.params.name;
    const name = Array.isArray(rawName) ? rawName[0] : rawName;
    if (!name) throw new RangeError("artifact name is required");
    const { artifact, filePath } = await workflowStore.artifactPath(datasetIdFrom(request), name);
    response.set({
      "Content-Type": artifact.mediaType,
      "Content-Length": String(artifact.byteLength),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": `${artifact.mediaType.startsWith("text/csv") ? "attachment" : "inline"}; filename="${artifact.name}"`,
    });
    response.sendFile(filePath);
  } catch (error) {
    sendApiError(response, error);
  }
});

app.post("/api/agent/sessions", async (request: Request, response: Response) => {
  try {
    const workflowId = String((request.body as { workflowId?: unknown })?.workflowId ?? "euclid-desi-crossmatch@1");
    response.status(201).json({ session: await agentService.createSession(workflowId) });
  } catch (error) {
    sendApiError(response, error);
  }
});

app.post("/api/agent/sessions/:id/messages", async (request: Request, response: Response) => {
  try {
    response.status(202).json(await agentService.sendMessage(datasetIdFrom(request), (request.body as { message?: unknown })?.message));
  } catch (error) {
    sendApiError(response, error);
  }
});

app.post("/mcp", async (request: Request, response: Response) => {
  const server = createAstroMcpServer(dataCatalog);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  try {
    await server.connect(transport);
    await transport.handleRequest(request, response, request.body);
  } catch (error) {
    console.error("MCP request failed", error);
    if (!response.headersSent) {
      response.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  } finally {
    await transport.close();
    await server.close();
  }
});

app.get("/mcp", (_request: Request, response: Response) => {
  response.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed for stateless transport" },
    id: null,
  });
});

app.delete("/mcp", (_request: Request, response: Response) => {
  response.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed for stateless transport" },
    id: null,
  });
});

app.use(express.static(viewerRoot, { extensions: ["html"], index: "index.html" }));

let httpServer: ReturnType<typeof app.listen> | undefined;

async function start(): Promise<void> {
  await metadataStore.initialize();
  await importJsonState(metadataStore, { connectorStatePath, dataCatalogStatePath, connectorRunStatePath });
  await workflowStore.initialize();
  await surveys.initialize();
  await dataCatalog.initialize();
  await connectors.initialize();
  await connectorRuns.initialize();
  await coverageDownloads.initialize();
  const recoveredLocalScans = await localCsvScans.recoverInterruptedRuns();
  if (recoveredLocalScans) console.warn(`Marked ${recoveredLocalScans} interrupted local CSV scan(s) as failed`);
  await loadResourceCatalogConfig();
  await resourcePackages.initialize();
  warehouseScans.start();

  httpServer = app.listen(port, host, () => {
    console.log(`astro-data-workspace listening on http://${host}:${port}`);
  });
}

void start().catch(async (error) => {
  console.error("Failed to start astro-data-workspace", error);
  await metadataStore.close().catch(() => undefined);
  process.exit(1);
});

async function shutdown(): Promise<void> {
  warehouseScans.stop();
  if (httpServer) await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
  await metadataStore.close();
  process.exit(0);
}

process.on("SIGINT", () => { void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });
