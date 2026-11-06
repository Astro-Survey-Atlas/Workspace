import "./telemetry-bootstrap.js";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { once } from "node:events";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import compression from "compression";
import type { NextFunction, Request, Response } from "express";

import { AgentService } from "./agent.js";
import { responseCancellation } from "./http-request-cancellation.js";
import { PointPresence } from "./point-presence.js";
import { AstroIndexService, ASTRO_FILE_INDEX, ASTRO_OVERVIEW_NSIDE, type AstroCoverageLayer, type AstroSkyQueryInput } from "./astro-index.js";
import { imagePointsContainingCoordinate } from "./fits-positions.js";
import { readScanEvidence } from "./scan-evidence.js";
import { angularSeparationArcsec, AstroObjectIndexService, coordinateInHealpixRegion, coordinateSearchBbox, type AstroObjectRecord, type AstroPointDensityQueryInput, type ObjectRegionQueryInput, type SkyDataPointScope } from "./astro-object-index.js";
import { McpCatalogQueryClient } from "./catalog-mcp-client.js";
import { CatalogQueryFallbackClient, OfficialArchiveCatalogQueryClient } from "./official-catalog-client.js";
import { createConnectorCredentialStore, type StoredConnectorCredentials } from "./connector-credentials.js";
import { ConnectorRegistry, connectorLocationKey, iterateConnectorObjectPages, validateConnectorInput, type ConnectorCheckInput, type ConnectorPublicRecord, type ConnectorRecord, type ConnectorRegistrationInput } from "./connectors.js";
import { ConnectorIngestRunCatalog, publicConnectorIngestRun, type ConnectorIngestRunFilter, type ConnectorIngestRunRecord, type ConnectorIngestRunStatus } from "./connector-history.js";
import { LocalState } from "./local-state.js";
import { ScanControl } from "./scan-control.js";
import { DataStatisticsClient } from "./data-statistics-client.js";
import { assetLinkedToConnector } from "./connector-asset-links.js";
import { workspaceLayerIdForAsset } from "./workspace-layer-identity.js";
import { WorkspaceConfigBackupService } from "./workspace-config-backup.js";
import { DataCatalogRegistry, type DataAssetAccess, type DataAssetRecord, type DataAssetRegistrationInput } from "./data-catalog.js";
import { deriveDataAssetOperationalStatus, latestAssetScan, type DataAssetCoverageEvidence, type DataAssetRunEvidence } from "./data-asset-status.js";
import { createAstroMcpServer } from "./mcp.js";
import { ResourceCatalogSyncError, ResourceCatalogUnavailableError, ResourcePackageManager, type ResourcePackageLoad } from "./resource-packages.js";
import { normalizeSurveyFootprintManifest, type SurveyFootprintManifest } from "./survey-footprints.js";
import { surveyCardFor, SurveyRegistry, type SurveyRecord, type SurveyRegistrationInput, type SurveyReleaseRegistrationInput } from "./survey-registry.js";
import { isConcretePublicSourceId, parsePublicSourceId, publicGeometrySourceIdForFootprint, publicSourceIdForFootprint, publicSourceIdentityForFootprint } from "./public-source-identity.js";
import { WorkflowEngine } from "./workflow-engine.js";
import { WorkflowMcpClient } from "./workflow-mcp-client.js";
import { WorkspaceFitsCutoutService } from "./workflow-fits-cutout.js";
import { WorkflowInputCatalogReader } from "./workflow-input-catalog.js";
import { WorkflowStore } from "./workflow-store.js";
import { createWorkflowDownloadsRouter } from "./workflow-downloads-http.js";
import { workflowRunListItems } from "./workflow.js";
import { listTags } from "./tags.js";
import { createMetadataStore } from "./storage/index.js";
import { SurveyDirectory } from "./survey-directory.js";
import { LocalConnectorRootsPolicy, LocalConnectorPolicyError, localConnectorRootsResponse } from "./local-connector-roots.js";
import { inspectLocalCsv, listLocalCsvFiles, LocalSourceInspectionCapabilityError, LocalSourceInspectionError } from "./local-source-inspection.js";
import { WorkspaceScanExecutor, workspaceScanEnabled } from "./workspace-scan-executor.js";
import { UserMocArtifactStore, type UserMocArtifact } from "./user-moc-artifacts.js";
import { commonOverlapNside, commonOverlapOrders, calculateSkyOverlap, privateOverlapOrders, type SkyOverlapSource } from "./sky-overlap.js";
import { expandHealpixRanges, healpixRangeContains, healpixRangesForPixels, MAX_OVERLAP_ORDER, unionHealpixRanges } from "./healpix-ranges.js";
import { CoverageDownloadService, parseCoverageDownloadSubmissionOptions, type CoverageDownloadFile } from "./coverage-downloads.js";
import { RegionDownloadPlanService } from "./region-download-plan.js";
import { createRegionDownloadPreviewHandler } from "./region-download-http.js";
import { ProductionService, ProductionStateError, type ProductionScanHandoff, type ProductionSourceResolver } from "./production.js";
import { listProductionCapabilities } from "./production-capabilities.js";
import { buildProvenance } from "./build-metadata.js";
import { SystemConfigStore } from "./system-config.js";
import type { DownloadSettingsInput } from "./system-config.js";
import { DownloadWorkerClient } from "./download-worker-client.js";
import { WorkspaceAgentService } from "./workspace-agent.js";
import { resolveWorkspaceCli } from "./workspace-cli.js";
import { shutdownTelemetry, withRootSpan, withSpan } from "./telemetry.js";
import { AssetsCoverageOverviewClient, AssetsRegionClient, AssetsRegionRateLimitError, assetsLayerIdForIdentity, type AssetsRegionCoverageEvidence, type AssetsRegionFileEvidence, type AssetsRegionLookupSummary, type AssetsRegionScanScope, type AssetsRegionLookupResponse } from "./assets-region-client.js";
import { regionContainsCell, WorkspaceDirectoryCollector, type WorkspaceDirectory, type WorkspaceFileLocation } from "./workspace-directories.js";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const port = Number(process.env.PORT ?? "3000");
const host = process.env.HOST ?? "0.0.0.0";
const stateRoot = path.resolve(process.env.ASTRO_STATE_ROOT
  ?? (process.env.ASTRO_SQLITE_PATH ? path.dirname(process.env.ASTRO_SQLITE_PATH) : path.join(projectRoot, "data")));
const allowedHosts = (
  process.env.ASTRO_ALLOWED_HOSTS ??
  "localhost,127.0.0.1,asa-workspace,asa-workspace.asa-workspace,asa-workspace.asa-workspace.svc,asa-workspace.asa-workspace.svc.cluster.local"
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const viewerRoot = process.env.ASTRO_VIEWER_ROOT ?? path.join(projectRoot, "viewer");
const workflowRoot = process.env.ASTRO_WORKFLOW_ROOT ?? path.join(stateRoot, "workflow-runs");
const workspaceCli = resolveWorkspaceCli(projectRoot);
const productionRoot = process.env.ASTRO_PRODUCTION_ROOT ?? path.join(stateRoot, "production");
const systemConfigRoot = process.env.ASTRO_SYSTEM_CONFIG_ROOT ?? path.join(stateRoot, "system-config");
const surveyRegistryStatePath = process.env.ASTRO_SURVEY_REGISTRY_STATE ?? path.join(stateRoot, "survey-registrations.json");
const localConnectorRoots = LocalConnectorRootsPolicy.fromEnvironment();
const coverageDownloadRoot = path.resolve(process.env.ASTRO_COVERAGE_DOWNLOAD_ROOT ?? path.join(stateRoot, "coverage-downloads"));
const coverageDownloadStatePath = path.resolve(process.env.ASTRO_COVERAGE_DOWNLOAD_STATE ?? path.join(stateRoot, "coverage-download-jobs.json"));
const resourcePackageRoot = process.env.ASTRO_RESOURCE_PACKAGE_ROOT ?? path.join(stateRoot, "resource-packages");
const resourcePackageStatePath = process.env.ASTRO_RESOURCE_PACKAGE_STATE ?? path.join(stateRoot, "resource-package-state.json");
const resourceCatalogUrl = process.env.ASTRO_RESOURCE_CATALOG_URL ?? pathToFileURL(path.join(stateRoot, "assets-current", "catalog.json")).href;
const resourceSnapshotRoot = process.env.ASTRO_RESOURCE_SNAPSHOT_ROOT ?? stateRoot;
const resourceCatalogAllowedOrigins = (process.env.ASTRO_RESOURCE_CATALOG_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const catalogMcpUrl = process.env.ASTRO_CATALOG_MCP_URL ?? "http://eva24002-entrance.lab.zverse.space:30082/mcp";
const catalogMcpTimeoutMs = Number(process.env.ASTRO_CATALOG_MCP_TIMEOUT_MS ?? "15000");
const catalogArchiveTimeoutMs = Number(process.env.ASTRO_CATALOG_ARCHIVE_TIMEOUT_MS ?? "30000");
const astroEsUrl = process.env.ASTRO_ES_URL ?? "";
const userMocRoot = process.env.ASTRO_USER_MOC_ROOT ?? path.join(stateRoot, "user-mocs");
const workspaceScanningEnabled = workspaceScanEnabled();
const metadataStoreEngine = "sqlite";
const metadataStore = createMetadataStore();
const localState = new LocalState(process.env.ASTRO_SQLITE_PATH ?? path.join(stateRoot, "workspace.sqlite"));
const workflowStore = new WorkflowStore(workflowRoot, localState);
const scanControl = new ScanControl(localState, process.env.ASTRO_SCANS_PAUSED !== "false");
const surveys = new SurveyRegistry(surveyRegistryStatePath, metadataStore);
const surveyDirectory = new SurveyDirectory(metadataStore);
const dataCatalog = new DataCatalogRegistry(metadataStore);
const connectors = new ConnectorRegistry(metadataStore, localConnectorRoots);
const connectorCredentials = createConnectorCredentialStore();
const connectorRuns = new ConnectorIngestRunCatalog(metadataStore);
const pointPresence = new PointPresence(path.join(stateRoot, "workspace-scans"));
const userMocs = new UserMocArtifactStore({ root: userMocRoot });
const dataStatistics = new DataStatisticsClient({ store: metadataStore });
const currentDataBatches = async (assetIds?: readonly string[]): Promise<ReadonlyMap<string, string>> => {
  const assets = assetIds === undefined ? await dataCatalog.list()
    : (await Promise.all([...new Set(assetIds)].map(id => metadataStore.getDataAsset(id)))).filter(asset => asset !== undefined);
  return new Map(assets.map(asset => [asset.id, asset.activeScan?.dataBatchId ?? "unpublished"]));
};
const astroObjectIndex = new AstroObjectIndexService({ baseUrl: astroEsUrl, dataBatches: currentDataBatches });
const workspaceScans = new WorkspaceScanExecutor({
  enabled: workspaceScanningEnabled,
  control: scanControl,
  root: path.join(stateRoot, "workspace-scans"),
  connectors,
  credentials: connectorCredentials,
  dataCatalog,
  runs: connectorRuns,
  roots: localConnectorRoots,
  objectIndex: astroObjectIndex,
  artifacts: userMocs,
});
const resourcePackages = new ResourcePackageManager({ catalogUrl: resourceCatalogUrl, root: resourcePackageRoot, statePath: resourcePackageStatePath, snapshotRoot: resourceSnapshotRoot, allowedOrigins: resourceCatalogAllowedOrigins });
const astroIndex = new AstroIndexService({ baseUrl: astroEsUrl, dataBatches: currentDataBatches });
const downloadWorker = process.env.ASTRO_DOWNLOAD_WORKER_URL ? new DownloadWorkerClient(
  process.env.ASTRO_DOWNLOAD_WORKER_URL, process.env.ASTRO_DOWNLOAD_WORKER_TOKEN ?? "", () => systemConfig.downloadProxy()) : undefined;
const coverageDownloads = new CoverageDownloadService({
  root: coverageDownloadRoot,
  statePath: coverageDownloadStatePath,
  registerConnector: (input) => connectors.register(input),
  worker: downloadWorker,
});
function assertExecutablePublicSourceId(sourceId: string): void {
  if (sourceId.startsWith("public:") && !isConcretePublicSourceId(sourceId)) {
    throw new RangeError("public sourceId must include survey, release/DR, product, and sourceId or layerId");
  }
  if (sourceId.startsWith("geometry:public:")) {
    throw new RangeError("geometry-only public coverage cannot be used as a download source");
  }
}

function assertExecutablePublicSourceIds(sourceIds: readonly string[]): void {
  sourceIds.forEach(assertExecutablePublicSourceId);
}

function assertPublicSourceIdsInFiles(value: unknown): void {
  if (!Array.isArray(value)) return;
  value.forEach((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
    const sourceId = (entry as { sourceId?: unknown }).sourceId;
    if (typeof sourceId === "string") assertExecutablePublicSourceId(sourceId);
  });
}

function assertPublicSourceIdsInProductionInput(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const body = value as { region?: unknown; files?: unknown };
  if (body.region && typeof body.region === "object" && !Array.isArray(body.region)) {
    const sourceIds = (body.region as { sourceIds?: unknown }).sourceIds;
    if (Array.isArray(sourceIds)) {
      sourceIds.forEach((sourceId) => {
        if (typeof sourceId === "string") assertExecutablePublicSourceId(sourceId);
      });
    }
  }
  assertPublicSourceIdsInFiles(body.files);
}

const productionSourceResolver: ProductionSourceResolver = {
  async resolve(region) {
    assertExecutablePublicSourceIds(region.sourceIds);
    const layerIds = [...new Set(region.sourceIds.flatMap(sourceId => {
      const identity = parsePublicSourceId(sourceId);
      const layerId = identity ? assetsLayerIdForIdentity(identity) : undefined;
      return layerId ? [layerId] : [];
    }))];
    if (!layerIds.length) throw new RangeError("下载需要具体公共产品图层；本地目录仅作为空间依据");
    const preview = await regionDownloadPlans.preview({ layerIds, order: Math.log2(region.nside), cells: region.pixels });
    return {
      units: [],
      inventory: preview.inventory,
      blocked: preview.unavailable.map(item => ({
        sourceId: region.sourceIds.find(sourceId => assetsLayerIdForIdentity(parsePublicSourceId(sourceId)) === item.layerId) ?? item.layerId,
        reason: item.reason,
      })),
    };
  },
};
const workspaceProductionHandoff: ProductionScanHandoff = {
  submit: (input) => workspaceScans.submitProductionHandoff(input),
};
const productionService = new ProductionService({
  state: localState,
  root: productionRoot,
  downloads: coverageDownloads,
  connectors,
  dataCatalog,
  objectIndex: astroObjectIndex,
  localRoots: localConnectorRoots,
  sourceResolver: productionSourceResolver,
  confirmPublicDownload: confirmation => regionDownloadPlans.confirm(confirmation),
  ...(workspaceScanningEnabled && astroObjectIndex.configured ? { workspaceHandoff: workspaceProductionHandoff } : {}),
});
const systemConfig = new SystemConfigStore(systemConfigRoot);
const workflowMcp = new WorkflowMcpClient(systemConfig);
const workflowFitsCutout = new WorkspaceFitsCutoutService({
  store: workflowStore,
  connectors,
  credentials: connectorCredentials,
  localRoots: localConnectorRoots,
  mcp: workflowMcp,
});
const assetsRegionClient = new AssetsRegionClient({
  catalogUrl: resourceCatalogUrl,
  getApiKey: () => systemConfig.getAssetsApiKey(),
});
const regionDownloadPlans = new RegionDownloadPlanService({ client: assetsRegionClient });
const assetsCoverageOverviewClient = new AssetsCoverageOverviewClient({
  catalogUrl: resourceCatalogUrl,
  getApiKey: () => systemConfig.getAssetsApiKey(),
});
const workspaceAgent = new WorkspaceAgentService({
  state: localState,
  root: path.join(stateRoot, "agent"),
  config: systemConfig,
  cliPath: workspaceCli.entryPath,
  cliNodeArgs: workspaceCli.nodeArgs,
  cliBaseUrl: `http://127.0.0.1:${port}`,
});
const configBackup = new WorkspaceConfigBackupService({ root: systemConfigRoot, store: metadataStore, credentials: connectorCredentials,
  roots: localConnectorRoots, systemConfig, resourcePackages, surveys, isBusy: async () => {
    if (dataStatistics.busy) return "数据统计刷新";
    if ((await connectorRuns.list({ status: "running" })).length) return "扫描任务";
    if ((await coverageDownloads.list()).some(job => job.status === "queued" || job.status === "running")) return "下载任务";
    if ((await productionService.listRuns()).some(run => ["queued", "resolving", "awaiting-approval", "running"].includes(run.status))) return "生产任务";
    return undefined;
  } });
const workflowEngine = new WorkflowEngine(
  workflowStore,
  new CatalogQueryFallbackClient(
    new McpCatalogQueryClient(catalogMcpUrl, catalogMcpTimeoutMs, 1),
    new OfficialArchiveCatalogQueryClient(catalogArchiveTimeoutMs),
  ),
  workflowMcp,
  new WorkflowInputCatalogReader({ assets: dataCatalog, connectors, credentials: connectorCredentials, localRoots: localConnectorRoots }),
  workflowFitsCutout,
);
const agentService = new AgentService(workflowStore, workflowEngine);
const app = createMcpExpressApp({ host, allowedHosts });
app.use(compression({
  threshold: 1024,
  level: 1,
  filter: (request, response) => !String(response.getHeader("Content-Type") ?? "").startsWith("text/event-stream")
    && request.path !== "/mcp" && compression.filter(request, response),
}));
function configBackupPassword(request: Request): string {
  const value = request.get("X-Backup-Password");
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) throw new RangeError("Backup password header is missing or invalid");
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== value) throw new Error("Invalid encoded password");
    return decoded;
  } catch { throw new RangeError("Backup password header is invalid"); }
}

app.post("/api/config-backup/preview", express.raw({ type: "application/octet-stream", limit: "64mb" }), async (request: Request, response: Response) => {
  try {
    if (!Buffer.isBuffer(request.body)) throw new RangeError("Upload the encrypted backup as application/octet-stream");
    response.set("Cache-Control", "no-store");
    response.json(await configBackup.preview(request.body, configBackupPassword(request)));
  } catch (error) { sendApiError(response, error); }
});

app.use("/api", express.json({ limit: "64kb" }));

app.use("/api", (request: Request, response: Response, next: NextFunction) => {
  const backupControl = request.path === "/config-backup/preview" || request.path === "/config-backup/apply";
  if (configBackup.busy && request.method !== "GET" && !backupControl) {
    response.status(409).json({ error: "Workspace configuration is being replaced; retry this operation shortly" });
    return;
  }
  next();
});

app.get("/api/scanning", (_request, response) => response.json({ scanning: scanControl.view() }));
app.post("/api/scanning/pause", (_request, response) => {
  response.json({ scanning: scanControl.setPaused(true, "用户暂停") });
});
app.post("/api/scanning/resume", (_request, response) => response.json({ scanning: scanControl.setPaused(false) }));
app.use("/api", (request, response, next) => {
  if (request.method === "POST" && (/scan-runs(?:\/|$)/.test(request.path)
    || /ingest-runs\/[^/]+\/retry$/.test(request.path))) {
    try { scanControl.assertRunning(); } catch (error) { sendApiError(response, error); return; }
  }
  next();
});

app.post("/api/config-backup/export", async (request: Request, response: Response) => {
  try {
    const preferences = request.body && typeof request.body === "object" && !Array.isArray(request.body)
      ? (request.body as { browserPreferences?: unknown }).browserPreferences : undefined;
    const encrypted = await configBackup.export(configBackupPassword(request), preferences);
    response.set({ "Cache-Control": "no-store", "Content-Type": "application/vnd.asa.workspace-config-backup+json",
      "Content-Disposition": `attachment; filename="workspace-config-${new Date().toISOString().slice(0, 10)}.asaworkspace"` });
    response.send(encrypted);
  } catch (error) { sendApiError(response, error); }
});

app.post("/api/config-backup/apply", async (request: Request, response: Response) => {
  try {
    const body = request.body && typeof request.body === "object" && !Array.isArray(request.body) ? request.body as Record<string, unknown> : {};
    response.json(await configBackup.apply(body.previewId, body.pathMappings));
  } catch (error) { sendApiError(response, error); }
});

app.get("/api/config-backup/public-selection", async (_request: Request, response: Response) => {
  try { response.set("Cache-Control", "no-store"); response.json({ restore: await configBackup.publicSelectionStatus() ?? null }); }
  catch (error) { sendApiError(response, error); }
});

app.post("/api/config-backup/public-selection/retry", async (_request: Request, response: Response) => {
  try { response.status(202).json({ restore: await configBackup.retryPublicSelection() }); }
  catch (error) { sendApiError(response, error); }
});

app.get("/healthz", (_request: Request, response: Response) => {
  response.json({ status: "ok", service: "asa-workspace", version: "0.0.1" });
});

app.get("/api/capabilities", async (_request: Request, response: Response) => {
  response.json({
    scanning: scanControl.view(),
    userMocs: { rootConfigured: Boolean(userMocRoot), count: (await userMocs.list()).length },
    localScan: {
      enabled: workspaceScanningEnabled,
      configured: astroObjectIndex.configured,
      executor: "workspace",
      objectIndex: astroObjectIndex.objectIndex,
      footprintIndex: astroObjectIndex.imageFootprintIndex,
    },
    metadataStore: { engine: metadataStoreEngine },
  });
});

app.get("/api/data-statistics", async (_request: Request, response: Response) => {
  try {
    response.set("Cache-Control", "no-store");
    response.json(await dataStatistics.view());
  } catch (error) { sendApiError(response, error); }
});

app.post("/api/data-statistics/refresh", async (request: Request, response: Response) => {
  try {
    const body = request.body && typeof request.body === "object" && !Array.isArray(request.body)
      ? request.body as { connectorIds?: unknown } : {};
    if (body.connectorIds !== undefined && (!Array.isArray(body.connectorIds) || body.connectorIds.some(id => typeof id !== "string"))) {
      throw new RangeError("connectorIds must be an array of strings");
    }
    response.status(202).json({ refresh: await dataStatistics.refresh(body.connectorIds as string[] | undefined) });
  } catch (error) { sendApiError(response, error); }
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
    credentials: { accessKeyConfigured: Boolean(stored?.accessKeyId), secretConfigured: Boolean(stored?.secretAccessKey) },
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
  const sessionToken = credentialText(input.credentials?.sessionToken, "Session Token", 4096, false) || existing?.sessionToken;
  return {
    accessKeyId,
    secretAccessKey,
    endpoint: credentialText(input.config?.endpoint, "Endpoint", 2048, false) || existing?.endpoint || "",
    ...(sessionToken ? { sessionToken } : {}),
  };
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
  if (response.writableEnded || response.destroyed) return;
  if (response.headersSent) {
    if (String(response.getHeader("Content-Type")).includes("text/event-stream")) response.end(`event: error\ndata: ${JSON.stringify({ error: message })}\n\n`);
    else response.destroy();
    return;
  }
  const notFound = message.startsWith("Dataset not found:") || message.startsWith("Data asset not found:") || message.startsWith("Connector not found:") || message.startsWith("Connector ingest run not found:") || message.startsWith("Coverage job not found:") || message.startsWith("Coverage download job not found:") || message.startsWith("Overlap component not found:") || message.startsWith("Survey not found:") || message.startsWith("Public survey not found:") || message.startsWith("Resource package not found:") || message.startsWith("Resource package is not installed:") || message.startsWith("Resource package job not found:") || message.startsWith("Resource package MOC layer not found:") || message.startsWith("Resource package MOC artifact is not available:")
    || message.startsWith("User MOC artifact file not found:")
    || message.startsWith("Workflow not found:")
    || message.startsWith("Workflow run not found:") || message.startsWith("Workflow artifact not found:") || message.startsWith("Agent session not found:")
    || message.startsWith("Production run not found:") || message.startsWith("Production artifact not found:") || message.startsWith("Workspace agent session not found:")
    || message.startsWith("AI Provider not found:") || message.startsWith("MCP Server not found:");
  const status = error instanceof LocalConnectorPolicyError ? error.statusCode
    : error instanceof LocalSourceInspectionCapabilityError ? error.statusCode
    : error instanceof LocalSourceInspectionError ? error.statusCode
  : error instanceof ProductionStateError ? error.statusCode
  : error instanceof Error && "statusCode" in error && typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode <= 599 ? error.statusCode
    : error instanceof ResourceCatalogUnavailableError ? 503
    : error instanceof ResourceCatalogSyncError ? 502
    : error instanceof RangeError ? 400
    : notFound ? 404 : 500;
  if (status === 500) console.error("API request failed", error);
  if (status === 429 && error instanceof Error && "retryAfterSeconds" in error && typeof error.retryAfterSeconds === "number") {
    response.set("Retry-After", String(Math.max(1, Math.ceil(error.retryAfterSeconds))));
  }
  response.status(status).json({ error: message });
}

function sanitizeEndpointForDisplay(value: string): string {
  if (!value) return "";
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return "";
  }
}



async function effectiveFootprints(): Promise<SurveyFootprintManifest> {
  // Public coverage is sourced only from the trusted Assets snapshot.
  const active = await resourcePackages.activeFootprints();
  if (!active.footprints.some((footprint) => footprint.surveyId === "legacy-surveys")) return active;
  try {
    const supplements = await assetsCoverageOverviewClient.legacyDr9Footprints();
    const identities = new Set(active.footprints.map((footprint) => `${footprint.surveyId}:${footprint.releaseId}:${footprint.product}`));
    const added = supplements.filter((footprint) => !identities.has(`${footprint.surveyId}:${footprint.releaseId}:${footprint.product}`));
    if (!added.length) return active;
    return normalizeSurveyFootprintManifest({
      ...active,
      footprints: [...active.footprints, ...added],
    });
  } catch (error) {
    console.warn("Assets Legacy DR9 overview is unavailable", error instanceof Error ? error.message : String(error));
    return active;
  }
}

function publicSurveyRecords(): SurveyRecord[] {
  return resourcePackages.surveyRecords();
}

async function surveyRecords(): Promise<SurveyRecord[]> {
  let publicRecords: SurveyRecord[];
  try { publicRecords = publicSurveyRecords(); }
  catch (error) {
    if (!(error instanceof ResourceCatalogUnavailableError)) throw error;
    return surveyDirectory.records();
  }
  await surveyDirectory.syncPublic(publicRecords);
  return surveyDirectory.records();
}

async function surveyRecord(id: string): Promise<SurveyRecord> {
  await surveyRecords();
  return surveyDirectory.get(id);
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
app.get("/api/data-assets/status", async (request: Request, response: Response) => {
  try {
    const requested = typeof request.query.assetIds === "string" ? new Set(request.query.assetIds.split(",")) : undefined;
    const [assets, allRuns, records] = await Promise.all([dataCatalog.list(), connectorRuns.list(), connectors.list()]);
    const statuses = assets.filter(asset => !requested || requested.has(asset.id)).map(asset => {
      const run = latestAssetScan(allRuns, asset.id);
      const active = asset.activeScan;
      const linked = records.filter(connector => assetLinkedToConnector(asset, connector));
      const derived = deriveDataAssetOperationalStatus({ asset, connectorKinds: linked.map(connector => connector.kind),
        coverage: { activeCoverage: !!active, status: active ? "ready" : undefined, objectStatus: active ? "ready" : undefined,
          objectCount: active?.pointCount,  latestMocStatus: active?.artifactId ? "ready" : undefined },
        latestRun: run, objectIndexConfigured: astroObjectIndex.configured, localScanConfigured: workspaceScanningEnabled });
      return { ...derived, assetName: asset.name, dataPointCount: active?.pointCount ?? 0, dataPointAnchor: active?.anchor,
        dataPointStatus: run?.status ?? (active ? "succeeded" : "not_indexed"),
        ...(run ? { scanProgress: { status: run.status, phase: run.phase, processedFiles: run.processedFiles ?? 0,
          fileCount: run.fileCount, failedFiles: run.failedFiles ?? 0, executor: "workspace" } } : {}) };
    });
    response.json({ statuses, scanning: scanControl.view() });
  } catch (error) { sendApiError(response, error); }
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

app.post("/api/data-assets/:id/scan-runs", async (request: Request, response: Response) => {
  try {
    const { connectorId, ...input } = request.body ?? {};
    if (connectorId !== undefined && typeof connectorId !== "string") throw new RangeError("connectorId must be a string");
    const run = await workspaceScans.submitAsset(datasetIdFrom(request), input, connectorId, idempotencyKey(request));
    response.status(202).json({ run: publicConnectorIngestRun(run) });
  } catch (error) { sendApiError(response, error); }
});

app.post("/api/data-assets", async (request: Request, response: Response) => {
  try {
    const input = request.body as DataAssetRegistrationInput;
    await validateConnectorIds(input);
    await surveyRecords();
    await surveyDirectory.validateReference(input.surveyId, input.releaseId);
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
    await surveyRecords();
    await surveyDirectory.validateReference(input.surveyId, input.releaseId);
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

app.get("/api/connectors/:id/objects", async (request: Request, response: Response) => {
  try {
    const connector = await connectors.get(datasetIdFrom(request));
    if (connector.kind !== "s3") throw new RangeError("Object listing requires an S3/OSS Connector");
    if (connector.status !== "ready") throw new RangeError("Connector must be ready before listing objects");

    const configuredPrefix = (connector.config.prefix ?? "").replace(/^\/+|\/+$/g, "");
    const queryPrefix = request.query.prefix;
    if (queryPrefix !== undefined && typeof queryPrefix !== "string") throw new RangeError("prefix must be a string");
    const selectedPrefix = typeof queryPrefix === "string" ? queryPrefix.trim().replace(/^\/+|\/+$/g, "") : configuredPrefix;
    if (selectedPrefix.split("/").some((segment) => segment === "." || segment === "..") || selectedPrefix.includes("\\") || selectedPrefix.includes("\u0000")) {
      throw new RangeError("prefix contains an invalid path segment");
    }
    if (configuredPrefix && selectedPrefix !== configuredPrefix && !selectedPrefix.startsWith(`${configuredPrefix}/`)) {
      throw new RangeError("prefix must stay inside the Connector's configured Prefix");
    }

    const rawToken = request.query.continuationToken;
    if (rawToken !== undefined && (typeof rawToken !== "string" || rawToken.length > 8192)) throw new RangeError("continuationToken must be a string of at most 8192 characters");
    if (!connector.credentialRef) throw new RangeError("S3 Connector has no saved credentials");
    const credentials = await connectorCredentials.get(connector.credentialRef);
    if (!credentials?.accessKeyId || !credentials.secretAccessKey) throw new RangeError("S3 Connector credentials are unavailable");
    const source: ConnectorRecord = { ...connector, config: { ...connector.config, endpoint: connector.config.endpoint || credentials.endpoint } };
    const pages = iterateConnectorObjectPages(source, credentials, selectedPrefix, typeof rawToken === "string" ? rawToken : undefined);
    try {
      const page = await pages.next();
      response.set("Cache-Control", "no-store");
      response.json({ objects: page.value?.objects ?? [], ...(page.value?.continuationToken ? { continuationToken: page.value.continuationToken } : {}) });
    } finally {
      await pages.return(undefined);
    }
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
    response.json({ runs: publicConnectorRuns(await connectorRuns.list(connectorRunFilter(request))) });
  } catch (error) {
    sendApiError(response, error);
  }
});

app.post("/api/maintenance/failed-history/clear", async (request: Request, response: Response) => {
  const remoteAddress = request.socket.remoteAddress?.replace(/^::ffff:/, "");
  if (remoteAddress !== "127.0.0.1" && remoteAddress !== "::1") {
    response.status(404).end();
    return;
  }
  if (request.body?.confirmation !== "CLEAR_FAILED_HISTORY") {
    response.status(400).json({ error: "Explicit history cleanup confirmation is required" });
    return;
  }
  try {
    const failedRuns = await connectorRuns.list({ status: "failed" });
    const [downloadJobs, productionRuns, removedRuns] = await Promise.all([
      coverageDownloads.clearFailedHistory(),
      productionService.clearFailedHistory(),
      connectorRuns.clearFailedHistory(),
    ]);
    const mocArtifacts = await userMocs.clearErrorHistory(new Set([
      ...failedRuns.map((run) => run.id),
    ]));
    response.json({ cleared: {
      connectorRuns: removedRuns.length,
      downloadJobs,
      productionRuns,
      mocArtifacts,
    } });
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
    response.json({ runs: publicConnectorRuns(await connectorRunHistory(connector)) });
  } catch (error) {
    sendApiError(response, error);
  }
});

app.get("/api/connectors/:id/ingest-runs/:runId/logs", async (request: Request, response: Response) => {
  try {
    const run = (await connectorRuns.list({ connectorId: datasetIdFrom(request) })).find(run => run.id === request.params.runId);
    if (!run) { response.status(404).json({ error: "Scan run not found" }); return; }
    response.json({ runId: run.id, status: "available", text: (run.scanTask?.errors ?? (run.error ? [run.error] : [])).join("\n") });
  } catch (error) { sendApiError(response, error); }
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
    const run = await workspaceScans.submitConnector(datasetIdFrom(request), request.body, idempotencyKey(request));
    response.status(202).json({ run: publicConnectorIngestRun(run) });
  } catch (error) { sendApiError(response, error); }
});
for (const action of ["pause", "resume", "cancel", "retry"] as const) {
  app.post(`/api/connectors/:id/ingest-runs/:runId/${action}`, async (request: Request, response: Response) => {
    try {
      const run = await workspaceScans[action](datasetIdFrom(request), String(request.params.runId));
      response.status(202).json({ run: publicConnectorIngestRun(run) });
    } catch (error) { sendApiError(response, error); }
  });
}

app.delete("/api/connectors/:id/ingest-runs/:runId", (_request: Request, response: Response) => {
  response.status(405).json({ error: "Connector ingest run history is read-only" });
});

app.post("/api/connectors", async (request: Request, response: Response) => {
  try {
    const input = request.body as ConnectorRegistrationInput;
    const value = validateConnectorInput(input);
    await surveyRecords();
    await surveyDirectory.validateReference(value.surveyId, value.releaseId);
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
    await surveyRecords();
    await surveyDirectory.validateReference(value.surveyId, value.releaseId);
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

app.get("/api/surveys", async (request: Request, response: Response) => {
  try {
    const records = await surveyRecords();
    response.json({ surveys: records.map(surveyCardFor), ...(request.query.includeRecords === "true" ? { records } : {}) });
  }
  catch (error) { sendApiError(response, error); }
});

app.get("/api/survey-identities", async (_request: Request, response: Response) => {
  try {
    await surveyRecords();
    response.json({ identities: await metadataStore.listSurveyIdentities() });
  } catch (error) { sendApiError(response, error); }
});

app.post("/api/survey-identities/:id/association", async (request: Request, response: Response) => {
  try {
    await surveyRecords();
    if (typeof request.body?.publicId !== "string" || (request.body.unlink !== undefined && typeof request.body.unlink !== "boolean")) throw new RangeError("publicId and optional boolean unlink are required");
    await surveyDirectory.link(datasetIdFrom(request), request.body.publicId, request.body.unlink === true);
    response.json({ surveys: await surveyDirectory.list() });
  } catch (error) { sendApiError(response, error); }
});

app.get("/api/surveys/:id", async (request: Request, response: Response) => {
  try {
    response.json({ survey: await surveyRecord(datasetIdFrom(request)) });
  } catch (error) {
    sendApiError(response, error);
  }
});

// Public package metadata is read-only display data from the Assets v3
// package catalog. It is deliberately separate from Atlas-local labels.
app.get("/api/public-surveys", (request: Request, response: Response) => {
  try {
    const records = publicSurveyRecords();
    response.json({ surveys: records.map(surveyCardFor), ...(request.query.includeRecords === "true" ? { records } : {}) });
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
    await surveyRecord(datasetIdFrom(request));
    response.status(201).json({ release: await surveyDirectory.addRelease(datasetIdFrom(request), request.body as SurveyReleaseRegistrationInput) });
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
  response.json({ config: resourcePackages.catalogStatus() });
});

// Effective endpoints are provisioned by the deployment environment (env vars /
// bundled defaults) and are intentionally read-only from the browser.
app.get("/api/system-config/runtime", async (_request: Request, response: Response) => {
  response.set("Cache-Control", "no-store");
  const catalog = resourcePackages.catalogStatus();
  response.json({
    readOnly: true,
    catalog: {
      endpoint: sanitizeEndpointForDisplay(catalog.catalogUrl),
      configured: Boolean(catalog.catalogUrl),
      available: catalog.available,
      unavailableReason: catalog.unavailableReason,
      syncedAt: catalog.syncedAt,
      stale: catalog.stale,
      lastSyncError: catalog.lastSyncError,
      source: "environment",
    },
    workspaceSearch: {
      endpoint: sanitizeEndpointForDisplay(astroEsUrl),
      configured: astroIndex.configured,
      indices: {
        file: process.env.ASTRO_ES_ASTRO_INDEX ?? ASTRO_FILE_INDEX,
        object: astroObjectIndex.objectIndex,
        footprint: astroObjectIndex.imageFootprintIndex,
      },
      source: "environment",
    },
    // Read-only production capability registry pinned to this build.
    capabilities: listProductionCapabilities({ scanningEnabled: workspaceScanningEnabled }),
    build: buildProvenance(),
    assetsApi: {
      endpoint: sanitizeEndpointForDisplay(resourceCatalogUrl),
      apiKeyConfigured: await systemConfig.assetsApiKeyConfigured().catch(() => false),
    },
  });
});

// Instance-level Assets API key. The plaintext is stored only in
// system-secrets.json and never appears in runs, artifacts or logs.
app.put("/api/system-config/assets", async (request: Request, response: Response) => {
  try {
    const body = request.body as { apiKey?: unknown } | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new RangeError("request body must be an object");
    if (!("apiKey" in body)) throw new RangeError("apiKey is required");
    if (body.apiKey !== null && typeof body.apiKey !== "string") throw new RangeError("apiKey must be a string or null");
    await systemConfig.setAssetsApiKey(body.apiKey);
    response.json({ assets: { apiKeyConfigured: await systemConfig.assetsApiKeyConfigured() } });
  } catch (error) { sendApiError(response, error); }
});

app.post("/api/resource-packages/sync", async (_request: Request, response: Response) => {
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
  const signal = responseCancellation(response);
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
    }, signal));
  } catch (error) {
    if (!signal.aborted) sendApiError(response, error);
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

async function isIndexing(scopes?: readonly SkyDataPointScope[]): Promise<boolean> {
  const ids = new Set(scopes?.map(scope => scope.assetId));
  return (await connectorRuns.list({ assetIds: [...ids].filter((id): id is string => !!id) })).some(run => ["queued", "running"].includes(run.status) && run.assetId && ids.has(run.assetId));
}
async function hydratePoint(point: AstroObjectRecord): Promise<AstroObjectRecord> {
  if (!point.evidence_ref) return point;
  const evidence = await readScanEvidence(path.join(stateRoot, "workspace-scans"), point.evidence_ref);
  return { ...point, attributes: { ...point.attributes, ...(evidence.attributes as Record<string, string> ?? {}) } };
}
app.post("/api/sky/points/scopes", async (request: Request, response: Response) => {
  try {
    const ids: unknown = request.body?.sourceIds;
    if (!Array.isArray(ids) || ids.length > 512 || ids.some(id => typeof id !== "string")) throw new RangeError("Concrete sourceIds are required");
    const assets = await dataCatalog.list();
    const scopes = assets.filter(asset => asset.activeScan && ids.includes(overlapSourceIdForAsset(asset.id))).map(asset => ({ assetId: asset.id }));
    response.json({ scopes });
  } catch (error) { sendApiError(response, error); }
});
app.post("/api/sky/points/query", async (request: Request, response: Response) => {
  const signal = responseCancellation(response);
  try {
    const input = request.body as ObjectRegionQueryInput;
    if (!input.region || !Array.isArray(input.layerScopes)) throw new RangeError("Data point queries require an entry region and explicit layer scopes");
    const [result, indexing] = await Promise.all([
      astroObjectIndex.queryObjects(
        { ...input, includeAttributes: input.includeAttributes === true, trackTotalHits: input.trackTotalHits === true },
        [astroObjectIndex.objectIndex], signal,
      ),
      isIndexing(input.layerScopes),
    ]);
    signal.throwIfAborted();
    response.json({ ...result, indexing });
  } catch (error) { sendApiError(response, error); }
});
app.post("/api/sky/points/density", async (request: Request, response: Response) => {
  const signal = responseCancellation(response);
  try {
    const input = request.body as AstroPointDensityQueryInput;
    if (!input || !Array.isArray(input.layers)) throw new RangeError("Point density requires explicit layers");
    const layerScopes = input.layers.flatMap(layer => layer.scopes ?? []);
    const [result, indexing] = await Promise.all([
      astroObjectIndex.queryPointDensity(input, [astroObjectIndex.objectIndex], signal),
      isIndexing(layerScopes),
    ]);
    signal.throwIfAborted();
    response.json({ ...result, indexing });
  } catch (error) { sendApiError(response, error); }
});
app.post("/api/sky/points/anchor", async (request: Request, response: Response) => {
  const signal = responseCancellation(response);
  try {
    const input = request.body as ObjectRegionQueryInput;
    if (!input.region || !Array.isArray(input.layerScopes)) throw new RangeError("Point anchor requires an entry region and explicit layer scopes");
    const [result, indexing] = await Promise.all([
      astroObjectIndex.queryObjects({ ...input, limit: 1, includeAttributes: false, trackTotalHits: false }, [astroObjectIndex.objectIndex], signal),
      isIndexing(input.layerScopes),
    ]);
    signal.throwIfAborted();
    response.json({ status: result.status, message: result.message,
      point: result.objects[0] ? { objectId: result.objects[0].object_id, raDeg: result.objects[0].ra_deg, decDeg: result.objects[0].dec_deg } : null,
      ...(result.objects[0] ? { record: result.objects[0] } : {}),
      indexing });
  } catch (error) { sendApiError(response, error); }
});
app.post("/api/sky/points/inspect", async (request: Request, response: Response) => {
  const signal = responseCancellation(response);
  try {
    const body = request.body as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new RangeError("Point inspection input is required");
    if (!body.region || typeof body.region !== "object" || Array.isArray(body.region)) throw new RangeError("Point inspection requires an entry region");
    if (!Array.isArray(body.layerScopes) || body.layerScopes.length > 512) throw new RangeError("Point inspection requires explicit layer scopes");
    const raDeg = typeof body.raDeg === "number" ? ((body.raDeg % 360) + 360) % 360 : Number.NaN;
    const decDeg = body.decDeg;
    const radiusArcsec = body.radiusArcsec === undefined ? 1 : body.radiusArcsec;
    const region = body.region as ObjectRegionQueryInput["region"];
    const layerScopes = body.layerScopes as SkyDataPointScope[];
    const bbox = coordinateSearchBbox(raDeg, decDeg as number, radiusArcsec as number);
    if (!coordinateInHealpixRegion(raDeg, decDeg as number, region!)) throw new RangeError("Coordinate is outside the Aladin entry region");
    if (!layerScopes.length) {
      response.json({ raDeg, decDeg, radiusArcsec, matches: [], images: [], truncated: false, indexing: false });
      return;
    }
    const [nearby, footprintCandidates] = await Promise.all([
      astroObjectIndex.queryObjects({ bbox, region, layerScopes, limit: 2_000 }, [astroObjectIndex.objectIndex], signal),
      astroObjectIndex.queryImageFootprints({ raDeg, decDeg: decDeg as number, layerScopes, limit: 1_000 }, signal),
    ]);
    signal.throwIfAborted();
    if (nearby.status !== "ready") {
      response.status(nearby.status === "unavailable" ? 503 : 502).json({ error: nearby.message ?? "Coordinate search failed" });
      return;
    }
    const unique = new Map<string, { point: AstroObjectRecord; separationArcsec: number }>();
    for (const point of nearby.objects) {
      if (["image_center", "pointing"].includes(point.attributes?.position_role ?? "")) continue;
      const separationArcsec = angularSeparationArcsec(raDeg, decDeg as number, point.ra_deg, point.dec_deg);
      if (separationArcsec > (radiusArcsec as number)) continue;
      const previous = unique.get(point.object_id);
      if (!previous || separationArcsec < previous.separationArcsec) unique.set(point.object_id, { point, separationArcsec });
    }
    const matches = [...unique.values()].sort((left, right) => left.separationArcsec - right.separationArcsec
      || left.point.object_id.localeCompare(right.point.object_id));
    const indexedImages = footprintCandidates.pointIds.length
      ? await astroObjectIndex.getPointsByIds(footprintCandidates.pointIds, [astroObjectIndex.objectIndex], signal)
      : [];
    signal.throwIfAborted();
    const images = await imagePointsContainingCoordinate(await Promise.all(indexedImages.map(hydratePoint)), raDeg, decDeg as number);
    response.json({ raDeg, decDeg, radiusArcsec, matches, images,
      truncated: nearby.total > nearby.objects.length || footprintCandidates.truncated,
      indexing: await isIndexing(layerScopes) });
  } catch (error) { sendApiError(response, error); }
});
app.get("/api/sky/points/:id", async (request: Request, response: Response) => {
  const signal = responseCancellation(response);
  try { const point = await astroObjectIndex.getPoint(datasetIdFrom(request), [astroObjectIndex.objectIndex], signal);
    signal.throwIfAborted();
    if (!point) { response.status(404).json({ error: "Data point not found" }); return; } response.json({ point: await hydratePoint(point) });
  } catch (error) { sendApiError(response, error); }
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

function stringArrayInput(value: unknown, name: string, maximum = 256, maximumLength = 160): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maximum || value.some((entry) => typeof entry !== "string" || !entry.trim() || entry.length > maximumLength)) {
    throw new RangeError(`${name} must be an array of non-empty strings`);
  }
  return [...new Set(value.map((entry) => entry.trim()))];
}

function booleanInput(value: unknown, name: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new RangeError(`${name} must be a boolean`);
  return value;
}

function publicFootprintIdentity(footprint: SurveyFootprintManifest["footprints"][number]) {
  try {
    return publicSourceIdentityForFootprint(footprint);
  } catch {
    return undefined;
  }
}

function overlapSourceIdForPublic(footprint: SurveyFootprintManifest["footprints"][number]): string {
  return publicSourceIdForFootprint(footprint) ?? publicGeometrySourceIdForFootprint(footprint);
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
  await surveyRecords();
  const identities = await metadataStore.listSurveyIdentities();
  if (context.surveyIds) {
    const aliases = await Promise.all([...context.surveyIds].map((id) => surveyDirectory.aliases(id)));
    context = { ...context, surveyIds: new Set([...context.surveyIds, ...aliases.flat()]) };
  }
  const result = new Map<string, SkyOverlapSource>();
  const accept = (source: SkyOverlapSource): void => {
    if (!overlapSourceMatches(source, context)) return;
    result.set(source.id, { ...source, pixels: [...new Set(source.pixels)].sort((left, right) => left - right) });
  };

  if (context.includePublic) {
    let manifest: SurveyFootprintManifest | undefined;
    try { manifest = await effectiveFootprints(); } catch (error) { console.warn("Public overlap sources unavailable", error); }
    for (const footprint of manifest?.footprints ?? []) {
        const sourceIdentity = publicFootprintIdentity(footprint);
        const hasConcreteFields = Boolean(footprint.sourceId?.trim() || footprint.layerId?.trim());
        const source: SkyOverlapSource = {
          id: overlapSourceIdForPublic(footprint),
          label: footprint.label,
          kind: "public",
          nside: footprint.nside,
          pixels: footprint.pixels,
          surveyId: identities.find((entry) => entry.source === "assets" && entry.sourceId === footprint.surveyId)?.id ?? footprint.surveyId,
          releaseId: footprint.releaseId,
          product: footprint.product,
          modality: footprint.modality,
          sourceUrl: footprint.sourceUrl,
          ...(sourceIdentity ? { sourceIdentity, executable: true, availability: "entrypoint-only" as const } : {
            executable: false,
            availability: hasConcreteFields ? "unavailable" as const : "geometry-only" as const,
          }),
        };
        if (!overlapSourceMatches(source, context)) continue;
        source.availableOrders = await resourcePackages.footprintOrders(footprint);
        if (source.availableOrders.includes(Math.log2(context.nside))) {
          source.ranges = await resourcePackages.footprintRanges(footprint, Math.log2(context.nside));
          source.pixels = [];
        } else source.pixels = [];
        source.nside = context.nside;
        accept(source);
    }
  }

  if (!context.includeWorkspace || (context.sourceIds?.size && ![...context.sourceIds].some((id) => id.startsWith("workspace:")))) {
    return [...result.values()].sort((left, right) => left.id.localeCompare(right.id));
  }
  const assets = (await dataCatalog.list()).filter((asset) => {
    if (context.sourceIds?.size && !context.sourceIds.has(overlapSourceIdForAsset(asset.id))) return false;
    if (context.assetIds?.size && !context.assetIds.has(asset.id)) return false;
    if (context.surveyIds?.size && (!asset.surveyId || !context.surveyIds.has(asset.surveyId))) return false;
    if (context.releaseIds?.size && (!asset.releaseId || !context.releaseIds.has(asset.releaseId))) return false;
    return true;
  });
  const artifacts = await userMocs.list();
  for (const asset of assets) {
    const artifact = artifacts.find(artifact => artifact.id === asset.activeScan?.artifactId && artifact.status === "ready");
    if (!artifact) continue;
    const order = Math.log2(context.nside);
    // Published map cells describe real indexed positions at O8. Native image
    // extent MOCs retain their own resolution in the scan's downloadable evidence.
    const presence = order <= 8 ? await pointPresence.pixels(asset.activeScan!.pointCoverageRef, order) : new Set<number>();
    const ranges = [...presence].map(pixel => ({ start: pixel, end: pixel + 1 }));
    accept({ id: overlapSourceIdForAsset(asset.id), label: asset.name, kind: "workspace", nside: context.nside,
      pixels: [], ranges, assetId: asset.id, surveyId: asset.surveyId, releaseId: asset.releaseId, product: asset.product,
      modality: asset.modalities[0], availableOrders: privateOverlapOrders([8]), layerIds: [workspaceLayerIdForAsset(asset.id)] });
  }
  return [...result.values()].sort((left, right) => left.id.localeCompare(right.id));
}

/** A region already selected in the globe needs identities, not a second full-sky projection. */
async function reverseSourcesFromIds(context: OverlapSourceContext): Promise<SkyOverlapSource[] | undefined> {
  if (!context.sourceIds?.size || context.surveyIds?.size || context.releaseIds?.size || context.assetIds?.size) return undefined;
  const assets = context.includeWorkspace ? await dataCatalog.list() : [];
  const sources: SkyOverlapSource[] = [];
  for (const id of context.sourceIds) {
    if (isConcretePublicSourceId(id) && context.includePublic) {
      const identity = parsePublicSourceId(id)!;
      sources.push({ id, kind: "public", label: identity.product, nside: context.nside, pixels: [], surveyId: identity.surveyId, releaseId: identity.releaseId, product: identity.product, sourceIdentity: identity });
    } else if (id.startsWith("workspace:asset:") && context.includeWorkspace) {
      const asset = assets.find(asset => overlapSourceIdForAsset(asset.id) === id && asset.activeScan);
      if (!asset) throw new RangeError("Selected Workspace asset has no published scan");
      sources.push({ id, kind: "workspace", label: asset.name, nside: context.nside, pixels: [], assetId: asset.id,
        surveyId: asset.surveyId, releaseId: asset.releaseId, product: asset.product, modality: asset.modalities[0], layerIds: [workspaceLayerIdForAsset(asset.id)] });
    } else throw new RangeError("Selected source is unavailable");
  }
  return sources;
}

function overlapContext(body: SkyOverlapRequest): OverlapSourceContext {
  const nside = Number(body.nside ?? ASTRO_OVERVIEW_NSIDE);
  overlapNsideOrder(nside);
  const toSet = (value: unknown, name: string, maximumLength = 160): ReadonlySet<string> | undefined => {
    const values = stringArrayInput(value, name, 256, maximumLength);
    return values === undefined ? undefined : new Set(values);
  };
  return {
    nside,
    sourceIds: toSet(body.sourceIds, "sourceIds", 8192),
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
  fileEvidence?: AssetsRegionFileEvidence[];
  coverageEvidence?: AssetsRegionCoverageEvidence[];
  assetsLookup?: AssetsRegionLookupSummary;
  scanScopes?: AssetsRegionScanScope[];
  warnings?: string[];
  assetsResult?: AssetsRegionLookupResponse;
  workspaceDirectories?: WorkspaceDirectory[];
  directoriesTruncated?: boolean;
  publicRetryAfterSeconds?: number;
}

interface ReverseLookupRegion {
  order: number;
  cells: number[];
  cursor?: string;
  querySnapshotId?: string;
  pageSize?: number;
}

function mergeUnavailable(unavailable: Map<string, ReverseLookupUnavailable>, sourceId: string, reason: string): void {
  const current = unavailable.get(sourceId);
  unavailable.set(sourceId, current ? { ...current, reason: `${current.reason}；${reason}` } : { sourceId, reason });
}

async function reverseLookupFiles(sources: readonly SkyOverlapSource[], region: ReverseLookupRegion, update?: (event: "progress" | "batch", value: Record<string, unknown>) => void): Promise<ReverseLookupResult> {
  const unavailable: ReverseLookupUnavailable[] = [];
  const warnings: string[] = [];
  const locations: WorkspaceFileLocation[] = [];
  let assetsResult: AssetsRegionLookupResponse | undefined;
  let directoriesTruncated = false;
  let publicRetryAfterSeconds: number | undefined;
  const publicSources = sources.filter((source) => source.kind === "public");
  const layerIds = [...new Set(publicSources.flatMap((source) => {
    const id = assetsLayerIdForIdentity(source.sourceIdentity); return id ? [id] : [];
  }))];
  const privateSources = sources.filter((source) => source.kind === "workspace");
  const sourceForLayer = (id: string): string | undefined => privateSources.find((source) => source.layerIds?.includes(id)
    || (source.assetId && id === workspaceLayerIdForAsset(source.assetId)))?.id;
  const directoryCollector = new WorkspaceDirectoryCollector(sourceForLayer);
  update?.("progress", { stage: "assets", state: layerIds.length ? "running" : "not-selected" });
  update?.("progress", { stage: "workspace", state: privateSources.length ? "running" : "not-selected" });
  await Promise.all([
    (async () => {
      if (!layerIds.length) return;
      try {
        assetsResult = await assetsRegionClient.lookup({ layerIds, order: region.order, cells: region.cells,
          cursor: region.cursor, querySnapshotId: region.querySnapshotId, pageSize: region.pageSize ?? 100 }, update ? event => {
            update(event.event, event.event === "batch" ? { kind: "public-native", ...event.value } : { ...event.value, stage: `assets-${event.value.stage}` });
          } : undefined);
        if (!assetsResult) publicSources.forEach((source) => unavailable.push({ sourceId: source.id, reason: "公开分块反查需要 Workspace 配置有效的 Assets API Key；几何重合仍可用。" }));
        else { warnings.push(...assetsResult.notes); update?.("batch", { kind: "public-result", result: assetsResult, provisional: true }); }
        update?.("progress", { stage: "assets", state: assetsResult ? "completed" : "unavailable", total: assetsResult?.spatialUnits?.length ?? 0 });
      } catch (error) {
        if (error instanceof AssetsRegionRateLimitError) publicRetryAfterSeconds = error.retryAfterSeconds;
        const reason = error instanceof Error ? error.message : String(error);
        publicSources.forEach((source) => unavailable.push({ sourceId: source.id, reason }));
        update?.("progress", { stage: "assets", state: "unavailable" });
      }
    })(),
    (async () => {
      if (!privateSources.length) return;
      const assetIds = privateSources.flatMap(source => source.assetId ? [source.assetId] : []);
      try {
        const result = await astroIndex.reverseFiles({ assetIds, order: region.order, cells: region.cells });
        locations.push(...result.files); directoriesTruncated ||= result.truncated;
      } catch (error) { directoriesTruncated = true; warnings.push(`本地文件目录反查：${error instanceof Error ? error.message : String(error)}`); }
      locations.forEach(file => directoryCollector.addFile(file));
      if (update) {
        const directories = directoryCollector.result();
        for (let offset = 0; offset < directories.length; offset += 100) update("batch", { kind: "workspace-directories", directories: directories.slice(offset, offset + 100), provisional: true });
        update("progress", { stage: "workspace", state: "completed", total: directories.length, truncated: directoriesTruncated });
      }
    })(),
  ]);
  const workspaceDirectories = directoryCollector.result();
  privateSources.filter((source) => !workspaceDirectories.some((directory) => directory.sourceId === source.id))
    .forEach((source) => unavailable.push({ sourceId: source.id, reason: "该区域没有已确认的本地文件父目录映射；覆盖几何仍保留。" }));
  return { files: [], unavailable, warnings: [...new Set(warnings)], workspaceDirectories, directoriesTruncated,
    ...(publicRetryAfterSeconds ? { publicRetryAfterSeconds } : {}),
    ...(assetsResult ? { assetsResult, fileEvidence: assetsResult.files, coverageEvidence: assetsResult.coverageEvidence,
      scanScopes: assetsResult.scanScopes, assetsLookup: { available: assetsResult.available, precision: assetsResult.precision,
        truncated: assetsResult.truncated, expiresAt: assetsResult.expiresAt } } : {}) };
}

function overlapNsideOrder(nside: number): number {
  if (!Number.isInteger(nside) || nside < 1 || (nside & (nside - 1)) !== 0 || nside > 2 ** MAX_OVERLAP_ORDER) {
    throw new RangeError(`nside must be a power of two between 1 and ${2 ** MAX_OVERLAP_ORDER}`);
  }
  return Math.log2(nside);
}

function sourceContainsPixel(source: SkyOverlapSource, pixel: number): boolean {
  return source.ranges ? healpixRangeContains(source.ranges, pixel) : source.pixels.includes(pixel);
}

/** Native intervals stay on the server; source identities suffice for inspection. */
function overlapSourceViews(sources: readonly SkyOverlapSource[]): SkyOverlapSource[] {
  return sources.map(({ ranges, ...source }) => ({ ...source, pixels: ranges
    ? ranges.reduce((sum, range) => sum + range.end - range.start, 0) <= 4096 ? expandHealpixRanges(ranges, 4096) : []
    : source.pixels }));
}

function reverseRegionInput(nside: number, pixels: number[], body: { cursor?: unknown; querySnapshotId?: unknown; pageSize?: unknown }): ReverseLookupRegion {
  const order = overlapNsideOrder(nside);
  const cells = overlapPixelsInput(pixels);
  if (cells.some((cell) => cell >= 12 * nside ** 2)) throw new RangeError("Invalid HEALPix cell for this order");
  if (cells.length * 41252.96124941927 / (12 * nside ** 2) > 100) throw new RangeError("Region exceeds 100 deg²; select a smaller region");
  if (body.cursor !== undefined && (typeof body.cursor !== "string" || body.cursor.length > 8192)) throw new RangeError("Invalid public lookup cursor");
  if (body.querySnapshotId !== undefined && (typeof body.querySnapshotId !== "string" || !/^[a-f0-9]{64}$/.test(body.querySnapshotId))) throw new RangeError("Invalid public query snapshot");
  if (body.pageSize !== undefined && (!Number.isSafeInteger(body.pageSize) || Number(body.pageSize) < 1 || Number(body.pageSize) > 100)) throw new RangeError("pageSize must be 1-100");
  return { order, cells, ...(typeof body.cursor === "string" ? { cursor: body.cursor } : {}),
    ...(typeof body.querySnapshotId === "string" ? { querySnapshotId: body.querySnapshotId } : {}),
    ...(typeof body.pageSize === "number" ? { pageSize: body.pageSize } : {}) };
}

app.post("/api/sky/overlap", async (request: Request, response: Response) => {
  try {
    const body = (request.body ?? {}) as SkyOverlapRequest;
    let context = overlapContext(body);
    const requestedNside = body.nside === undefined ? undefined : context.nside;
    // Discover source authority cheaply at O4, then intersect native intervals
    // at the requested shared order. Never refine an O4 intersection mask.
    context = { ...context, nside: Math.min(context.nside, ASTRO_OVERVIEW_NSIDE) };
    let sources = await overlapSources(context);
    const commonNside = commonOverlapNside(sources, context.nside);
    const availableOrders = commonOverlapOrders(sources);
    const nside = requestedNside ?? Math.min(ASTRO_OVERVIEW_NSIDE, commonNside);
    if (requestedNside !== undefined && sources.length && !availableOrders.includes(Math.log2(requestedNside))) {
      throw new RangeError(`所选来源共同支持的最高层级为 O${availableOrders.at(-1) ?? "--"}，无法使用 O${Math.log2(requestedNside)}；请降低层级或调整所选来源。`);
    }
    if (nside !== context.nside) {
      context = { ...context, nside };
      sources = await overlapSources(context);
    }
    const result = calculateSkyOverlap(sources, context.nside);
    response.json({ ...result, coverageOrder: result.order, availableOrders, sources: overlapSourceViews(sources) });
  } catch (error) {
    sendApiError(response, error);
  }
});

class WorkspaceLookupStream {
  readonly enabled: boolean;
  constructor(request: Request, readonly response: Response) { this.enabled = String(request.headers.accept ?? "").includes("text/event-stream"); }
  emit(event: "progress" | "batch" | "complete", value: unknown): void {
    if (!this.enabled || this.response.destroyed || this.response.writableEnded) return;
    if (!this.response.headersSent) { this.response.setHeader("Content-Type", "text/event-stream; charset=utf-8"); this.response.setHeader("Cache-Control", "no-store"); this.response.setHeader("X-Accel-Buffering", "no"); this.response.flushHeaders(); }
    this.response.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
    if (event === "complete") this.response.end();
  }
  readonly update = (event: "progress" | "batch", value: Record<string, unknown>): void => { this.emit(event, value); };
  complete(value: unknown): void { if (this.enabled) this.emit("complete", value); else this.response.json(value); }
}

app.post("/api/sky/overlap/details", async (request: Request, response: Response) => {
  const stream = new WorkspaceLookupStream(request, response);
  try {
    const body = (request.body ?? {}) as SkyOverlapRequest & { componentId?: unknown; pixels?: unknown; cursor?: unknown; querySnapshotId?: unknown; pageSize?: unknown };
    const context = overlapContext(body);
    response.setHeader("Cache-Control", "no-store");
    stream.emit("progress", { stage: "geometry", state: "running" });
    const sources = await overlapSources(context);
    const overlap = calculateSkyOverlap(sources, context.nside);
    const componentId = typeof body.componentId === "string" ? body.componentId : undefined;
    const component = componentId ? overlap.components.find((candidate) => candidate.id === componentId) : undefined;
    if (componentId && !component) throw new Error(`Overlap component not found: ${componentId}`);
    const pixels = component?.cells ?? (body.pixels === undefined ? overlap.pixels : overlapPixelsInput(body.pixels));
    const selectedSources = sources.filter((source) => pixels.some((pixel) => sourceContainsPixel(source, pixel)));
    stream.complete({ component: component ?? null, pixels, sources: overlapSourceViews(selectedSources), ...(await reverseLookupFiles(selectedSources, reverseRegionInput(context.nside, pixels, body), stream.enabled ? stream.update : undefined)) });
  } catch (error) {
    sendApiError(response, error);
  }
});

app.post("/api/sky/reverse-lookup", async (request: Request, response: Response) => {
  const stream = new WorkspaceLookupStream(request, response);
  try {
    const body = (request.body ?? {}) as SkyOverlapRequest & { componentId?: unknown; pixels?: unknown; cursor?: unknown; querySnapshotId?: unknown; pageSize?: unknown };
    const context = overlapContext(body);
    response.setHeader("Cache-Control", "no-store");
    stream.emit("progress", { stage: "geometry", state: "running" });
    if (body.pixels !== undefined && body.componentId === undefined) {
      const sources = await reverseSourcesFromIds(context);
      if (sources) {
        const pixels = overlapPixelsInput(body.pixels);
        const region = reverseRegionInput(context.nside, pixels, body);
        stream.complete({ pixels, sources, ...(await reverseLookupFiles(sources, region, stream.enabled ? stream.update : undefined)) });
        return;
      }
    }
    const sources = await overlapSources(context);
    let pixels = body.pixels === undefined ? undefined : overlapPixelsInput(body.pixels);
    if (typeof body.componentId === "string") {
      const overlap = calculateSkyOverlap(sources, context.nside);
      const component = overlap.components.find((candidate) => candidate.id === body.componentId);
      if (!component) throw new Error(`Overlap component not found: ${body.componentId}`);
      pixels = component.cells;
    }
    if (!pixels?.length) throw new RangeError("pixels or componentId is required");
    const selectedSources = sources.filter((source) => pixels!.some((pixel) => sourceContainsPixel(source, pixel)));
    stream.complete({ pixels, sources: overlapSourceViews(selectedSources), ...(await reverseLookupFiles(selectedSources, reverseRegionInput(context.nside, pixels, body), stream.enabled ? stream.update : undefined)) });
  } catch (error) {
    sendApiError(response, error);
  }
});

interface CoverageDownloadRequest {
  files: CoverageDownloadFile[];
  concurrency?: number;
  outputPrefix?: string;
  requestKey?: string;
  inventorySha256?: string;
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
  const sourceIds = stringArrayInput(body.sourceIds, "sourceIds", 256, 8192);
  if (sourceIds) assertExecutablePublicSourceIds(sourceIds);
  assertPublicSourceIdsInFiles(body.files);
  if (body.targetConnectorId !== undefined) {
    throw new RangeError("targetConnectorId is not supported; coverage downloads create a new Connector");
  }
  const submissionOptions = parseCoverageDownloadSubmissionOptions(body);
  const componentId = text(body.componentId, "componentId");
  return {
    files: body.files as CoverageDownloadFile[],
    ...submissionOptions,
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

for (const action of ["pause", "resume", "retry"] as const) app.post(`/api/coverage-downloads/:id/${action}`, async (request: Request, response: Response) => {
  try { response.json({ job: await coverageDownloads.action(datasetIdFrom(request), action) }); }
  catch (error) { sendApiError(response, error); }
});

async function downloadSettingsView() {
  const settings = await systemConfig.getDownloadSettings();
  const [reportedHealth, history] = downloadWorker ? await Promise.all([
    downloadWorker.health().catch(() => ({ status: "failed" as const, checkedAt: new Date().toISOString(),
      revision: settings.revision, detail: "独立下载服务暂不可用", engineAvailable: false })),
    downloadWorker.healthHistory().catch(() => []),
  ]) : [{ status: "unknown" as const, checkedAt: "", revision: settings.revision, detail: "当前部署未启用独立下载服务", engineAvailable: false }, []];
  let health = reportedHealth;
  if (health.revision !== settings.revision) health = { status: "unknown", checkedAt: "", revision: settings.revision,
    detail: "配置已保存，等待下载服务同步检测", engineAvailable: health.engineAvailable };
  return { settings, health, healthHistory: history.filter(sample => sample.revision === settings.revision), downloaderEnabled: Boolean(downloadWorker) };
}

async function configureDownloadWorker(): Promise<void> {
  const jobs = await coverageDownloads.list();
  const job = jobs.find(job => job.transfer.some(entry => entry.status !== "verified")) ?? jobs[0];
  const source = job?.transfer.find(entry => entry.status !== "verified")?.url ?? job?.transfer[0]?.url;
  await downloadWorker?.configure(source);
}

app.get("/api/system-config/downloads", async (_request: Request, response: Response) => {
  try { response.set("Cache-Control", "no-store"); response.json(await downloadSettingsView()); }
  catch (error) { sendApiError(response, error); }
});
app.put("/api/system-config/downloads", async (request: Request, response: Response) => {
  try {
    await systemConfig.saveDownloadSettings(request.body as DownloadSettingsInput);
    if (downloadWorker) await configureDownloadWorker().catch(() => undefined);
    response.json(await downloadSettingsView());
  } catch (error) { sendApiError(response, error); }
});
for (const action of ["test", "speed-test"] as const) app.post(`/api/system-config/downloads/${action}`, async (_request: Request, response: Response) => {
  try {
    if (!downloadWorker) throw new RangeError("当前部署未启用独立下载服务");
    await configureDownloadWorker();
    const health = action === "test" ? await downloadWorker.test() : await downloadWorker.health(true);
    response.json({ ...(await downloadSettingsView()), health });
  } catch (error) { sendApiError(response, error); }
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

function coverageStatus(value: string | undefined): WorkspaceCoverageStatus {
  if (value === "pending" || value === "error" || value === "unavailable") return value;
  return "ready";
}

async function artifactCoverageLayer(
  artifact: UserMocArtifact,
  nside: number,
  asset: DataAssetRecord,
  latestArtifact: UserMocArtifact = artifact,
): Promise<AstroCoverageLayer> {
  const order = nsideOrderForCoverage(nside);
  const pixels = [...await pointPresence.pixels(asset.activeScan!.pointCoverageRef, order)].sort((a, b) => a - b);
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
    pixels,
    availableOrders: [8],
    maxOrder: 8,
    precision: "estimated",
    coverageRole: "object_presence",
    mocStatus: artifact.status,
    artifactId: artifact.id,
    latestMocStatus: latestArtifact.status,
    latestArtifactId: latestArtifact.id,
    byAsset: asset ? [{ key: asset.id, label: asset.name, files: 0, bytes: 0 }] : [],
  };
}

app.get("/api/sky/coverage", async (request: Request, response: Response) => {
  const signal = responseCancellation(response);
  try {
    const nside = Number(request.query.nside ?? ASTRO_OVERVIEW_NSIDE);
    nsideOrderForCoverage(nside);
    const ids = typeof request.query.assetIds === "string" ? new Set(request.query.assetIds.split(",")) : undefined;
    const survey = queryText(request.query.survey, "survey");
    const release = queryText(request.query.release, "release");
    const aliases = new Set(survey ? [survey, ...await surveyDirectory.aliases(survey)] : []);
    const [assets, artifacts] = await Promise.all([dataCatalog.list(), userMocs.list()]);
    const layers: AstroCoverageLayer[] = [];
    for (const asset of assets) {
      signal.throwIfAborted();
      if ((ids && !ids.has(asset.id)) || (survey && (!asset.surveyId || !aliases.has(asset.surveyId))) || (release && asset.releaseId !== release)) continue;
      const artifact = artifacts.find(artifact => artifact.id === asset.activeScan?.artifactId && artifact.status === "ready");
      if (!artifact || !asset.activeScan?.pointCount) continue;
      const layer = await artifactCoverageLayer(artifact, nside, asset);
      layers.push({ ...layer, objectCount: asset.activeScan.pointCount, productId: asset.product, modality: asset.modalities[0],
        byAsset: [{ key: asset.id, label: asset.name, files: asset.activeScan.fileCount, bytes: asset.activeScan.totalBytes ?? 0, objects: asset.activeScan.pointCount }] });
    }
    response.json({ status: "ready", index: "published-moc", nside, pixels: [...new Set(layers.flatMap(layer => layer.pixels))].sort((a,b) => a-b), byAsset: layers.flatMap(layer => layer.byAsset), layers });
  } catch (error) { if (!signal.aborted) sendApiError(response, error); }
});

app.get("/api/production-pipelines", (_request: Request, response: Response) => {
  response.json({ pipelines: productionService.listPipelines() });
});

app.get("/api/production-runs", async (_request: Request, response: Response) => {
  try {
    response.set("Cache-Control", "no-store");
    response.json({ runs: await productionService.listRuns() });
  } catch (error) { sendApiError(response, error); }
});

app.post("/api/sky/download-plan/preview", createRegionDownloadPreviewHandler(regionDownloadPlans, sendApiError));

app.post("/api/production-runs", async (request: Request, response: Response) => {
  try {
    assertPublicSourceIdsInProductionInput(request.body);
    response.status(202).json({ run: await productionService.submit(request.body) });
  } catch (error) { sendApiError(response, error); }
});

app.get("/api/production-runs/:id", async (request: Request, response: Response) => {
  try { response.json({ run: await productionService.getRun(datasetIdFrom(request)) }); }
  catch (error) { sendApiError(response, error); }
});

app.post("/api/production-runs/:id/cancel", async (request: Request, response: Response) => {
  try { response.status(202).json({ run: await productionService.cancel(datasetIdFrom(request)) }); }
  catch (error) { sendApiError(response, error); }
});
app.post("/api/production-runs/:id/retry", async (request: Request, response: Response) => {
  try {
    response.status(202).json({ run: await productionService.retry(datasetIdFrom(request)) });
  } catch (error) { sendApiError(response, error); }
});

app.post("/api/production-runs/:id/approve", async (request: Request, response: Response) => {
  try {
    const body = request.body as { planSha256?: unknown; decidedBy?: unknown } | null;
    const planSha256 = typeof body?.planSha256 === "string" ? body.planSha256.trim() : "";
    const decidedBy = body?.decidedBy === "agent" ? "agent" : "user";
    response.status(202).json({ run: await productionService.approve(datasetIdFrom(request), planSha256, decidedBy) });
  } catch (error) { sendApiError(response, error); }
});

app.post("/api/production-runs/:id/reject", async (request: Request, response: Response) => {
  try {
    response.status(202).json({ run: await productionService.reject(datasetIdFrom(request)) });
  } catch (error) { sendApiError(response, error); }
});

app.get("/api/production-runs/:id/artifacts/:name", async (request: Request, response: Response) => {
  try {
    const rawName = request.params.name;
    const name = Array.isArray(rawName) ? rawName[0] : rawName;
    if (!name) throw new RangeError("artifact name is required");
    const { artifact, filePath } = await productionService.artifactPath(datasetIdFrom(request), name);
    response.set({ "Content-Type": artifact.mediaType, "Content-Length": String(artifact.byteLength), "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Disposition": `${artifact.mediaType.startsWith("text/csv") ? "attachment" : "inline"}; filename="${artifact.name}"` });
    response.sendFile(filePath);
  } catch (error) { sendApiError(response, error); }
});

app.get("/api/system-config/ai-providers", async (_request: Request, response: Response) => {
  try { response.json({ providers: await systemConfig.listAiProviders() }); }
  catch (error) { sendApiError(response, error); }
});

app.post("/api/system-config/ai-providers", async (request: Request, response: Response) => {
  try { response.status(201).json({ provider: await systemConfig.upsertAiProvider(request.body) }); }
  catch (error) { sendApiError(response, error); }
});

app.post("/api/system-config/ai-providers/:id/test", async (request: Request, response: Response) => {
  try { response.json({ provider: await systemConfig.testAiProvider(datasetIdFrom(request)) }); }
  catch (error) { sendApiError(response, error); }
});

app.delete("/api/system-config/ai-providers/:id", async (request: Request, response: Response) => {
  try { await systemConfig.removeAiProvider(datasetIdFrom(request)); response.status(204).end(); }
  catch (error) { sendApiError(response, error); }
});

app.get("/api/system-config/mcp-servers", async (_request: Request, response: Response) => {
  try { response.json({ servers: await systemConfig.listMcpServers() }); }
  catch (error) { sendApiError(response, error); }
});

app.post("/api/system-config/mcp-servers", async (request: Request, response: Response) => {
  try { response.status(201).json({ server: await systemConfig.upsertMcpServer(request.body) }); }
  catch (error) { sendApiError(response, error); }
});

app.post("/api/system-config/mcp-servers/:id/test", async (request: Request, response: Response) => {
  try { response.json({ server: await systemConfig.testMcpServer(datasetIdFrom(request)) }); }
  catch (error) { sendApiError(response, error); }
});

app.post("/api/system-config/mcp-servers/:id/tools/:toolName/call", async (request: Request, response: Response) => {
  try {
    const body = request.body as { arguments?: unknown } | null;
    response.json({ result: await systemConfig.callMcpTool(datasetIdFrom(request), String(request.params.toolName ?? ""), body?.arguments ?? {}) });
  } catch (error) { sendApiError(response, error); }
});

app.delete("/api/system-config/mcp-servers/:id", async (request: Request, response: Response) => {
  try { await systemConfig.removeMcpServer(datasetIdFrom(request)); response.status(204).end(); }
  catch (error) { sendApiError(response, error); }
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
    response.status(202).json({ run: await workflowEngine.createRun(workflowId, body.input, request.get("X-ASA-Agent-Invocation") === "true") });
  } catch (error) {
    sendApiError(response, error);
  }
});

app.get("/api/workflow-runs", async (request: Request, response: Response) => {
  try {
    const rawLimit = request.query.limit;
    const limitText = typeof rawLimit === "string" ? rawLimit : undefined;
    if (rawLimit !== undefined && (!limitText || !/^\d+$/.test(limitText))) {
      throw new RangeError("limit must be an integer between 1 and 100");
    }
    const limit = limitText === undefined ? 20 : Number(limitText);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError("limit must be an integer between 1 and 100");
    }
    const rawWorkflowKey = request.query.workflowKey;
    if (rawWorkflowKey !== undefined && typeof rawWorkflowKey !== "string") {
      throw new RangeError("workflowKey must be a string");
    }
    const runs = workflowRunListItems(await workflowStore.list(), {
      limit,
      ...(typeof rawWorkflowKey === "string" ? { workflowKey: rawWorkflowKey } : {}),
    });
    response.set("Cache-Control", "private, no-store").json({ runs });
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
      "Content-Disposition": `${artifact.mediaType.startsWith("text/csv") || artifact.mediaType === "application/fits" ? "attachment" : "inline"}; filename="${artifact.name}"`,
    });
    response.sendFile(filePath);
  } catch (error) {
    sendApiError(response, error);
  }
});

app.use("/api/workflow-runs", createWorkflowDownloadsRouter(workflowStore, sendApiError));

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

app.get("/api/agent/workspace-sessions", async (_request: Request, response: Response) => {
  try { response.set("Cache-Control", "no-store"); response.json({ sessions: await workspaceAgent.listSessions() }); }
  catch (error) { sendApiError(response, error); }
});

app.post("/api/agent/workspace-sessions", async (_request: Request, response: Response) => {
  try { response.status(201).json({ session: await workspaceAgent.createSession() }); }
  catch (error) { sendApiError(response, error); }
});

app.get("/api/agent/workspace-sessions/:id", async (request: Request, response: Response) => {
  try { response.json({ session: await workspaceAgent.getSession(datasetIdFrom(request)) }); }
  catch (error) { sendApiError(response, error); }
});

app.post("/api/agent/workspace-sessions/:id/messages", async (request: Request, response: Response) => {
  try {
    const body = request.body as { message?: unknown; context?: unknown };
    const context = body.context && typeof body.context === "object" && !Array.isArray(body.context) ? body.context as Record<string, unknown> : undefined;
    response.status(202).json({ session: await workspaceAgent.sendMessage(datasetIdFrom(request), body.message, context) });
  } catch (error) { sendApiError(response, error); }
});

app.post("/api/agent/workspace-sessions/:id/confirm", async (request: Request, response: Response) => {
  try {
    const approved = (request.body as { approved?: unknown })?.approved;
    if (typeof approved !== "boolean") throw new RangeError("approved must be boolean");
    response.status(202).json({ session: await workspaceAgent.confirmTool(datasetIdFrom(request), approved) });
  } catch (error) { sendApiError(response, error); }
});

const workspaceMcpToolNames = new Set([
  "list_user_assets",
  "get_user_asset",
  "euclid_catalog_query",
  "desi_catalog_query",
  "execute_cutout_group",
]);
const serviceRootMcpToolNames = new Set([
  "euclid_catalog_query",
  "desi_catalog_query",
  "execute_cutout_group",
]);

function mcpToolCallName(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const request = body as { method?: unknown; params?: unknown };
  if (request.method !== "tools/call") return undefined;
  const params = request.params && typeof request.params === "object" && !Array.isArray(request.params)
    ? request.params as { name?: unknown }
    : undefined;
  const name = typeof params?.name === "string" ? params.name : "";
  return workspaceMcpToolNames.has(name) ? name : "other";
}

app.post("/mcp", async (request: Request, response: Response) => {
  const server = createAstroMcpServer(dataCatalog, {
    queryCatalog: (side, input) => workflowEngine.queryCatalogForMcp(side, input),
    executeCutoutGroup: (input) => workflowFitsCutout.executeGroup(input),
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  try {
    await server.connect(transport);
    const toolName = mcpToolCallName(request.body);
    if (toolName && !serviceRootMcpToolNames.has(toolName)) {
      await withRootSpan(`mcp.server.tool ${toolName}`, {
        "asa.component": "other",
        "gen_ai.tool.name": toolName,
        "mcp.method.name": "tools/call",
      }, async () => transport.handleRequest(request, response, request.body));
    } else {
      await transport.handleRequest(request, response, request.body);
    }
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
  await localState.initialize();
  if (!localState.get("scanning", "control")) scanControl.setPaused(process.env.ASTRO_SCANS_PAUSED !== "false");
  await workflowStore.initialize();
  await surveys.initialize();
  await dataCatalog.initialize();
  await connectors.initialize();
  await connectorRuns.initialize();
  await systemConfig.initialize();
  await coverageDownloads.initialize();
  await productionService.initialize();
  if (downloadWorker) {
    await configureDownloadWorker().catch(() => undefined);
    setInterval(() => void configureDownloadWorker().catch(() => undefined), 30_000).unref();
  }
  await workspaceAgent.initialize();
  await resourcePackages.initialize();
  void effectiveFootprints().catch(error => console.warn("Unable to warm public coverage", error instanceof Error ? error.message : String(error)));
  await configBackup.initialize();
  await workflowEngine.restorePendingGates();
  httpServer = app.listen(port, host, () => console.log(`asa-workspace listening on http://${host}:${port}`));
}

void start().catch(async (error) => {
  console.error("Failed to start asa-workspace", error);
  await metadataStore.close().catch(() => undefined);
  await shutdownTelemetry().catch(() => undefined);
  process.exit(1);
});

async function shutdown(): Promise<void> {
  if (httpServer) await new Promise<void>(resolve => httpServer!.close(() => resolve()));
  await workflowStore.flush();
  localState.close();
  await metadataStore.close();
  await shutdownTelemetry();
  process.exit(0);
}
process.on("SIGINT", () => { void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });
