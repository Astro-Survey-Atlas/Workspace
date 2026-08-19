import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import type { Request, Response } from "express";

import { AgentService } from "./agent.js";
import { AtlasCatalog, publicAtlasManifest } from "./atlas.js";
import { AstroIndexService, ASTRO_OVERVIEW_NSIDE, type AstroCoverageLayer, type AstroSkyQueryInput } from "./astro-index.js";
import { AstroObjectIndexService, type AstroCellsQueryInput, type ObjectRegionQueryInput } from "./astro-object-index.js";
import { McpCatalogQueryClient } from "./catalog-mcp-client.js";
import { createConnectorCredentialStore, type StoredConnectorCredentials } from "./connector-credentials.js";
import { ConnectorRegistry, connectorLocationKey, validateConnectorInput, type ConnectorCheckInput, type ConnectorPublicRecord, type ConnectorRecord, type ConnectorRegistrationInput } from "./connectors.js";
import { ConnectorIngestRunCatalog, publicConnectorIngestRun, type ConnectorIngestRunFilter, type ConnectorIngestRunInput, type ConnectorIngestRunRecord, type ConnectorIngestRunStatus } from "./connector-history.js";
import { DataCatalogRegistry, type DataAssetAccess, type DataAssetRecord, type DataAssetRegistrationInput } from "./data-catalog.js";
import { ownershipKey, resolveDataOwnership, type EffectiveDataOwnership } from "./data-ownership.js";
import { ConnectorScanCapabilityError, ConnectorScanPreconditionError, DataWarehouseDisabledError, dataWarehouseEnabled, FlinkScanService, parseLegacyConnectorScanCommand, validateConnectorSelfScanBody } from "./flink-ingest.js";
import { ManualFootprintRegistry, ManualFootprintRevisionError } from "./manual-footprints.js";
import { createAstroMcpServer } from "./mcp.js";
import { ScanRunCatalog } from "./provenance.js";
import { JsonDatasetRegistry } from "./registry.js";
import { ResourcePackageManager, type ResourcePackageLoad } from "./resource-packages.js";
import { buildPublicReleaseDetails, type PublicReleaseProductStatus } from "./public-release-details.js";
import { normalizeSurveyFootprintManifest, type SurveyFootprintManifest } from "./survey-footprints.js";
import { CURATED_SURVEYS, SurveyRegistry, type SurveyRegistrationInput, type SurveyReleaseRegistrationInput } from "./survey-registry.js";
import { CatalogSkyIndexService } from "./sky-index.js";
import type { DatasetRecord } from "./types.js";
import { publicVolumeManifest, VolumeCatalog } from "./volume.js";
import { WorkflowEngine } from "./workflow-engine.js";
import { WorkflowStore } from "./workflow-store.js";
import { listTags } from "./tags.js";
import { createMetadataStore, importJsonState } from "./storage/index.js";
import { LocalConnectorRootsPolicy, LocalConnectorPolicyError, localConnectorRootsResponse } from "./local-connector-roots.js";
import { inspectLocalCsv, listLocalCsvFiles, LocalSourceInspectionCapabilityError, LocalSourceInspectionError } from "./local-source-inspection.js";
import { LocalCsvScanExecutor, LocalScanCapabilityError, LocalScanDisabledError, LocalScanPreconditionError, localScanEnabled, LOCAL_CSV_SCAN_EXECUTOR, type LocalCsvScanInput } from "./local-scan-executor.js";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const port = Number(process.env.PORT ?? "3000");
const host = process.env.HOST ?? "0.0.0.0";
const statePath = process.env.ASTRO_WORKSPACE_STATE ?? path.join(projectRoot, "data", "registry.json");
const allowedRoots = (process.env.ASTRO_ALLOWED_ROOTS ?? path.join(projectRoot, "fixtures"))
  .split(path.delimiter)
  .filter(Boolean);
const allowedHosts = (
  process.env.ASTRO_ALLOWED_HOSTS ??
  "localhost,127.0.0.1,astro-data-workspace-mcp,astro-data-workspace-mcp.astro-data-workspace,astro-data-workspace-mcp.astro-data-workspace.svc,astro-data-workspace-mcp.astro-data-workspace.svc.cluster.local"
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const viewerRoot = process.env.ASTRO_VIEWER_ROOT ?? path.join(projectRoot, "viewer");
const volumeRoot = process.env.ASTRO_VOLUME_ROOT ?? path.join(projectRoot, "volumes");
const atlasRoot = process.env.ASTRO_ATLAS_ROOT ?? volumeRoot;
const provenanceRoot = process.env.ASTRO_PROVENANCE_ROOT ?? volumeRoot;
const workflowRoot = process.env.ASTRO_WORKFLOW_ROOT ?? path.join(projectRoot, "data", "workflow-runs");
const surveyRegistryStatePath = process.env.ASTRO_SURVEY_REGISTRY_STATE ?? path.join(path.dirname(statePath), "survey-registrations.json");
const dataCatalogBootstrapPath = process.env.ASTRO_DATA_CATALOG_BOOTSTRAP ?? path.join(projectRoot, "bootstrap", "catalogs.json");
const dataCatalogStatePath = process.env.ASTRO_DATA_CATALOG_STATE ?? path.join(path.dirname(statePath), "data-catalog.json");
const connectorStatePath = process.env.ASTRO_CONNECTOR_STATE ?? path.join(path.dirname(statePath), "connectors.json");
const connectorBootstrapPath = process.env.ASTRO_CONNECTOR_BOOTSTRAP ?? path.join(projectRoot, "bootstrap", "connectors.json");
const connectorRunStatePath = process.env.ASTRO_CONNECTOR_RUN_STATE ?? path.join(path.dirname(statePath), "connector-ingest-runs.json");
const localConnectorRoots = LocalConnectorRootsPolicy.fromEnvironment();
const resourcePackageRoot = process.env.ASTRO_RESOURCE_PACKAGE_ROOT ?? path.join(projectRoot, "data", "resource-packages");
const resourcePackageStatePath = process.env.ASTRO_RESOURCE_PACKAGE_STATE ?? path.join(path.dirname(statePath), "resource-package-state.json");
const resourceCatalogUrl = process.env.ASTRO_RESOURCE_CATALOG_URL ?? pathToFileURL(path.join(projectRoot, "bootstrap", "resource-packages", "catalog.json")).href;
const publicReleaseDetailsPath = process.env.ASTRO_PUBLIC_RELEASE_DETAILS ?? path.join(projectRoot, "bootstrap", "resource-packages", "release-products.json");
const bundledFootprintPath = process.env.ASTRO_SURVEY_FOOTPRINT_FILE ?? path.join(process.env.ASTRO_SURVEY_FOOTPRINT_ROOT ?? path.join(projectRoot, "src", "footprints"), "survey-footprints.json");
const manualFootprintStatePath = process.env.ASTRO_MANUAL_FOOTPRINT_STATE ?? path.join(path.dirname(statePath), "manual-footprints.json");
const manualFootprintAdminToken = process.env.ASTRO_MANUAL_FOOTPRINT_ADMIN_TOKEN;
const catalogMcpUrl = process.env.ASTRO_CATALOG_MCP_URL ?? "http://eva24002-entrance.lab.zverse.space:30082/mcp";
const catalogMcpTimeoutMs = Number(process.env.ASTRO_CATALOG_MCP_TIMEOUT_MS ?? "15000");
const flinkNamespace = process.env.ASTRO_FLINK_NAMESPACE ?? "warehouse";
const flinkSecretNamespace = process.env.ASTRO_FLINK_SECRET_NAMESPACE ?? flinkNamespace;
const flinkPollMs = Number(process.env.ASTRO_FLINK_POLL_MS ?? "5000");
const astroEsUrl = process.env.ASTRO_ES_URL ?? "";
const astroEsIndex = process.env.ASTRO_ES_ASTRO_INDEX ?? "astro_file_index_v1";
const astroEsObjectIndex = process.env.ASTRO_ES_OBJECT_INDEX ?? "astro_object_index_v1";
const astroEsCoverageIndex = process.env.ASTRO_ES_COVERAGE_INDEX ?? "astro_coverage_index_v1";
const warehouseEnabled = dataWarehouseEnabled();
const localCsvScanEnabled = localScanEnabled();
const metadataStoreEngine = process.env.ASTRO_METADATA_STORE || "sqlite";

const registry = new JsonDatasetRegistry({ statePath, allowedRoots });
const skyIndexes = new CatalogSkyIndexService();
const volumes = new VolumeCatalog(volumeRoot);
const atlases = new AtlasCatalog(atlasRoot);
const scanRuns = new ScanRunCatalog(provenanceRoot);
const workflowStore = new WorkflowStore(workflowRoot);
const surveys = new SurveyRegistry(surveyRegistryStatePath);
const metadataStore = createMetadataStore();
const dataCatalog = new DataCatalogRegistry(dataCatalogBootstrapPath, metadataStore);
const connectors = new ConnectorRegistry(metadataStore, connectorBootstrapPath, localConnectorRoots);
const connectorCredentials = createConnectorCredentialStore();
const connectorRuns = new ConnectorIngestRunCatalog(metadataStore);
const astroObjectIndex = new AstroObjectIndexService({ baseUrl: astroEsUrl });
const localCsvScans = new LocalCsvScanExecutor({
  enabled: localCsvScanEnabled,
  connectors,
  dataCatalog,
  runs: connectorRuns,
  roots: localConnectorRoots,
  indexService: astroObjectIndex,
});
const flinkScans = new FlinkScanService({
  enabled: warehouseEnabled,
  connectors,
  dataCatalog,
  credentials: connectorCredentials,
  runs: connectorRuns,
  namespace: flinkNamespace,
  secretNamespace: flinkSecretNamespace,
  esUrl: astroEsUrl,
  esIndex: astroEsIndex,
  esObjectIndex: astroEsObjectIndex,
  esCoverageIndex: astroEsCoverageIndex,
  pollMs: flinkPollMs,
});
const resourcePackages = new ResourcePackageManager({ catalogUrl: resourceCatalogUrl, root: resourcePackageRoot, statePath: resourcePackageStatePath });
let publicReleaseProductStatuses: PublicReleaseProductStatus[] = [];
let bundledFootprintManifest: SurveyFootprintManifest;
let manualFootprints: ManualFootprintRegistry;
// Search indices are independent from the optional warehouse integration.
const astroIndex = new AstroIndexService({ baseUrl: astroEsUrl });
const workflowEngine = new WorkflowEngine(workflowStore, new McpCatalogQueryClient(catalogMcpUrl, catalogMcpTimeoutMs, 1));
const agentService = new AgentService(workflowStore, workflowEngine);
const app = createMcpExpressApp({ host, allowedHosts });

app.use("/api", express.json({ limit: "64kb" }));

app.get("/healthz", (_request: Request, response: Response) => {
  response.json({ status: "ok", service: "astro-data-workspace", version: "0.10.38" });
});

app.get("/api/capabilities", (_request: Request, response: Response) => {
  response.json({
    dataWarehouse: { enabled: warehouseEnabled },
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

function publicDataset(record: DatasetRecord) {
  const { path: _path, ...profile } = record.profile;
  return {
    id: record.id,
    name: record.name,
    profile,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

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
  if (connectorKind !== undefined && !["s3", "local", "jdbc"].includes(connectorKind)) throw new RangeError("connectorKind is not supported");
  if (status !== undefined && !["queued", "running", "succeeded", "failed"].includes(status)) throw new RangeError("status is not supported");
  return {
    locationKey: value("locationKey"),
    connectorId: value("connectorId"),
    connectorKind: connectorKind as ConnectorIngestRunFilter["connectorKind"],
    status: status as ConnectorIngestRunStatus | undefined,
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

function validateConnectorSurveyBinding(input: ConnectorRegistrationInput): void {
  if (!input.surveyId) {
    if (input.releaseId) throw new RangeError("releaseId requires surveyId");
    return;
  }
  const survey = surveys.get(input.surveyId);
  if (input.releaseId && !survey.releases.some((release) => release.id === input.releaseId)) {
    throw new RangeError(`releaseId ${input.releaseId} does not belong to survey ${input.surveyId}`);
  }
}

function optionalOwnershipText(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new RangeError(`${name} must be a string`);
  const result = value.trim();
  if (result.length > 120) throw new RangeError(`${name} must contain at most 120 characters`);
  return result || undefined;
}

function validateRegisteredAssetOwnership(surveyId?: string, releaseId?: string): void {
  if (!surveyId) {
    if (releaseId) throw new RangeError("releaseId requires surveyId");
    return;
  }
  let survey;
  try {
    survey = surveys.get(surveyId);
  } catch {
    throw new RangeError(`surveyId is not registered: ${surveyId}`);
  }
  if (releaseId && !survey.releases.some((release) => release.id === releaseId)) {
    throw new RangeError(`releaseId ${releaseId} does not belong to survey ${surveyId}`);
  }
}

async function linkedAssetConnectors(input: DataAssetRegistrationInput): Promise<ConnectorRecord[]> {
  const records = await connectors.list();
  const ids = new Set([
    ...(input.connectorIds ?? []),
    ...(input.accesses ?? []).map((access) => access.connectorId).filter((value): value is string => Boolean(value)),
  ]);
  const locationKeys = new Set(input.connectorLocationKeys ?? []);
  return records.filter((record) => ids.has(record.id) || locationKeys.has(record.locationKey));
}

async function withOwnershipSnapshot(input: DataAssetRegistrationInput): Promise<DataAssetRegistrationInput> {
  if (input.ownershipSnapshotVersion !== undefined && input.ownershipSnapshotVersion !== 1) {
    throw new RangeError("ownershipSnapshotVersion must be 1");
  }
  const explicitSurveyId = optionalOwnershipText(input.surveyId, "surveyId");
  const explicitReleaseId = optionalOwnershipText(input.releaseId, "releaseId");
  const linked = await linkedAssetConnectors(input);
  const connector = linked.length === 1 ? linked[0] : undefined;
  const surveyId = explicitSurveyId ?? connector?.surveyId;
  const releaseId = explicitReleaseId ?? (explicitSurveyId === undefined || explicitSurveyId === connector?.surveyId
    ? connector?.releaseId
    : undefined);
  validateRegisteredAssetOwnership(surveyId, releaseId);
  return { ...input, surveyId, releaseId, ownershipSnapshotVersion: 1 };
}

async function validateAssetConnectorOwnership(input: DataAssetRegistrationInput): Promise<EffectiveDataOwnership> {
  const access = input.accesses?.[0] ?? {
    connector: input.connector ?? "metadata",
    uri: input.sourceUri ?? "asset://validation",
    format: input.format ?? "metadata",
  };
  const ownership = resolveDataOwnership({
    ...input,
    id: "asset-validation",
    name: input.name,
    description: input.description ?? "",
    product: input.product ?? input.name,
    kind: input.kind,
    modalities: input.modalities ?? input.tags ?? [],
    access,
    status: input.status ?? "metadata_only",
    projectState: input.projectState ?? "planned",
    footprintIds: input.footprintIds ?? [],
    origin: "user",
    createdAt: "",
    updatedAt: "",
  } as DataAssetRecord, await connectors.list());
  if (ownership.source === "conflict") throw new RangeError(ownership.message ?? "关联 Connector 的巡天归属不一致");
  return ownership;
}

async function publicDataAsset(asset: DataAssetRecord): Promise<DataAssetRecord> {
  const connectorRecords = await connectors.list();
  const ownership = resolveDataOwnership(asset, connectorRecords);
  const resolvedRecords = [
    ...(asset.connectorLocationKeys ?? []).flatMap((key) => connectorRecords.filter((record) => record.locationKey === key)),
    ...(asset.connectorIds ?? []).flatMap((id) => {
      return connectorRecords.filter((record) => record.id === id);
    }),
  ];
  const uniqueRecords = [...new Map(resolvedRecords.map((record) => [record.locationKey, record])).values()];
  const resolved = uniqueRecords.map(connectorAccess);
  const effective = {
    ...asset,
    surveyId: ownership.surveyId,
    releaseId: ownership.releaseId,
    surveyBinding: ownership,
  };
  if (!resolved.length) return effective;
  const configured = asset.accesses?.length ? asset.accesses : [asset.access];
  const connectorIds = new Set(configured.map((access) => access.connectorId).filter(Boolean));
  const accesses = [...configured, ...resolved.filter((access) => !connectorIds.has(access.connectorId))];
  return { ...effective, connectorIds: uniqueRecords.map((record) => record.id), connectorLocationKeys: uniqueRecords.map((record) => record.locationKey), access: accesses[0]!, accesses };
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
  const notFound = message.startsWith("Dataset not found:") || message.startsWith("Data asset not found:") || message.startsWith("Connector not found:") || message.startsWith("Connector ingest run not found:") || message.startsWith("Volume not found:") || message.startsWith("Atlas not found:") || message.startsWith("Survey not found:") || message.startsWith("Resource package not found:") || message.startsWith("Resource package is not installed:") || message.startsWith("Resource package job not found:")
    || message.startsWith("Scan run not found:") || message.startsWith("Lineage not found:") || message.startsWith("Workflow not found:")
    || message.startsWith("Workflow run not found:") || message.startsWith("Workflow artifact not found:") || message.startsWith("Agent session not found:");
  const status = error instanceof LocalConnectorPolicyError ? error.statusCode
    : error instanceof LocalScanDisabledError ? error.statusCode
    : error instanceof LocalScanCapabilityError ? error.statusCode
    : error instanceof LocalScanPreconditionError ? error.statusCode
    : error instanceof LocalSourceInspectionCapabilityError ? error.statusCode
    : error instanceof LocalSourceInspectionError ? error.statusCode
    : error instanceof DataWarehouseDisabledError ? 503
    : error instanceof ConnectorScanCapabilityError ? 422
    : error instanceof ConnectorScanPreconditionError ? 409
    : error instanceof ManualFootprintRevisionError ? 412
    : error instanceof RangeError ? 400
    : notFound || message.startsWith("Manual footprint not found:") ? 404 : 500;
  if (status === 500) console.error("API request failed", error);
  response.status(status).json({ error: message });
}

function requireManualFootprintAdmin(request: Request, response: Response): boolean {
  if (!manualFootprintAdminToken) {
    response.status(503).json({ error: "Manual footprint administration is not configured" });
    return false;
  }
  if (request.get("Authorization") !== `Bearer ${manualFootprintAdminToken}`) {
    response.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

function manualFootprintRevision(request: Request, response: Response): number | undefined {
  const value = request.get("If-Match");
  if (!value) {
    response.status(428).json({ error: "If-Match revision is required" });
    return undefined;
  }
  const match = /^(?:W\/)?\"?(\d+)\"?$/.exec(value.trim());
  if (!match || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) < 1) {
    response.status(400).json({ error: "If-Match must contain a valid revision" });
    return undefined;
  }
  return Number(match[1]);
}

function manualFootprintIdentity(request: Request): { surveyId: string; releaseId: string; product: string } {
  const value = (name: "surveyId" | "releaseId" | "product") => {
    const parameter = request.params[name];
    const result = Array.isArray(parameter) ? parameter[0] : parameter;
    if (!result) throw new RangeError(`${name} is required`);
    return result;
  };
  return { surveyId: value("surveyId"), releaseId: value("releaseId"), product: value("product") };
}

function footprintEtag(response: Response, revision: number): void {
  response.set("ETag", `\"${revision}\"`);
  response.set("Cache-Control", "no-store");
}

function mergeFootprintManifests(left: SurveyFootprintManifest, right: SurveyFootprintManifest): SurveyFootprintManifest {
  if (left.nside !== right.nside) throw new Error("Footprint manifests use different NSIDE values");
  const footprints = new Map(left.footprints.map((footprint) => [`${footprint.surveyId}:${footprint.releaseId}:${footprint.product}`, footprint]));
  for (const footprint of right.footprints) {
    const identity = `${footprint.surveyId}:${footprint.releaseId}:${footprint.product}`;
    const existing = footprints.get(identity);
    if (existing?.quality === "moc") throw new RangeError(`Footprint identity conflict: ${identity}`);
    footprints.set(identity, footprint);
  }
  return { schemaVersion: 1, generatedAt: new Date().toISOString(), coordinateFrame: "ICRS", nside: left.nside, footprints: [...footprints.values()] };
}

async function effectiveFootprints(): Promise<SurveyFootprintManifest> {
  return mergeFootprintManifests(await resourcePackages.activeFootprints(), manualFootprints.publishedManifest());
}

function datasetIdFrom(request: Request): string {
  const value = request.params.id;
  const id = Array.isArray(value) ? value[0] : value;
  if (!id) throw new RangeError("dataset id is required");
  return id;
}

app.get("/api/datasets", async (_request: Request, response: Response) => {
  try {
    response.json({ datasets: (await registry.list()).map(publicDataset) });
  } catch (error) {
    sendApiError(response, error);
  }
});

app.get("/api/data-assets", async (request: Request, response: Response) => {
  try {
    const origin = request.query.origin;
    if (origin !== undefined && origin !== "user" && origin !== "builtin") {
      throw new RangeError("origin must be user or builtin");
    }
    const assets = (await dataCatalog.list()).filter((asset) => origin === undefined || asset.origin === origin);
    response.json({ assets: await Promise.all(assets.map(publicDataAsset)) });
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

app.post("/api/data-assets", async (request: Request, response: Response) => {
  try {
    const input = request.body as DataAssetRegistrationInput;
    await validateConnectorIds(input);
    const prepared = await withOwnershipSnapshot(input);
    response.status(201).json({ asset: await publicDataAsset(await dataCatalog.register(prepared)) });
  } catch (error) {
    sendApiError(response, error);
  }
});

app.put("/api/data-assets/:id", async (request: Request, response: Response) => {
  try {
    const id = datasetIdFrom(request);
    const input = request.body as DataAssetRegistrationInput;
    await validateConnectorIds(input);
    validateRegisteredAssetOwnership(optionalOwnershipText(input.surveyId, "surveyId"), optionalOwnershipText(input.releaseId, "releaseId"));
    const current = await dataCatalog.get(id);
    await validateAssetConnectorOwnership({
      ...current,
      ...input,
      connectorIds: input.connectorIds ?? current.connectorIds,
      connectorLocationKeys: input.connectorLocationKeys ?? current.connectorLocationKeys,
      accesses: input.accesses ?? current.accesses,
    });
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
    if (warehouseEnabled) void flinkScans.poll();
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
    if (warehouseEnabled) void flinkScans.poll();
    response.json({ runs: publicConnectorRuns(await connectorRunHistory(connector)) });
  } catch (error) {
    sendApiError(response, error);
  }
});

// Alias kept for integrations that call these records scan runs.
app.get("/api/connectors/:id/runs", async (request: Request, response: Response) => {
  try {
    const connector = await connectors.get(datasetIdFrom(request));
    if (warehouseEnabled) void flinkScans.poll();
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
    validateConnectorSurveyBinding(input);
    response.json({ check: await connectors.checkInput(input) });
  } catch (error) {
    sendApiError(response, error);
  }
});

app.post("/api/connectors/:id/ingest-runs", async (request: Request, response: Response) => {
  try {
    const connector = await connectors.get(datasetIdFrom(request));
    const input = request.body as ConnectorIngestRunInput;
    const run = await connectorRuns.add(connector.locationKey, {
      connectorId: connector.id,
      connectorName: connector.name,
      connectorKind: connector.kind,
      executor: input.executor,
      target: input.target,
      assetIds: input.assetIds,
      jobId: input.jobId,
      batchId: input.batchId,
      assetId: input.assetId,
      assetName: input.assetName,
      status: input.status,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      fileCount: input.fileCount,
      documentCount: input.documentCount,
      error: input.error,
      sourcePath: input.sourcePath,
      esIndex: input.esIndex,
    });
    response.status(201).json({ run: publicConnectorIngestRun(run) });
  } catch (error) {
    sendApiError(response, error);
  }
});

app.post("/api/connectors/:id/scan-runs", async (request: Request, response: Response) => {
  try {
    validateConnectorSelfScanBody(request.body);
    const run = await flinkScans.submitConnectorScan(datasetIdFrom(request), idempotencyKey(request));
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

app.post("/api/connectors/:id/scans", async (request: Request, response: Response) => {
  try {
    const command = parseLegacyConnectorScanCommand(request.body);
    if (!warehouseEnabled) throw new DataWarehouseDisabledError();
    if (command.mode === "pilot") {
      response.status(202).json({ runs: publicConnectorRuns(await flinkScans.submitPilot(datasetIdFrom(request))) });
      return;
    }
    response.status(202).json({ run: publicConnectorIngestRun(await flinkScans.submitScan(datasetIdFrom(request), command.input)) });
  } catch (error) {
    sendApiError(response, error);
  }
});

app.delete("/api/connectors/:id/ingest-runs/:runId", async (request: Request, response: Response) => {
  try {
    const connector = await connectors.get(datasetIdFrom(request));
    const runId = Array.isArray(request.params.runId) ? request.params.runId[0] : request.params.runId;
    if (!runId) throw new RangeError("run id is required");
    await connectorRuns.remove(connector.locationKey, runId, connector.id);
    response.status(204).end();
  } catch (error) {
    sendApiError(response, error);
  }
});

app.post("/api/connectors", async (request: Request, response: Response) => {
  try {
    const input = request.body as ConnectorRegistrationInput;
    const value = validateConnectorInput(input);
    validateConnectorSurveyBinding(value);
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
    validateConnectorSurveyBinding(value);
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
  response.json({ surveys: surveys.list() });
});

app.get("/api/surveys/:id", (request: Request, response: Response) => {
  try {
    response.json({ survey: surveys.get(datasetIdFrom(request)) });
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

app.get("/api/public-release-details", async (_request: Request, response: Response) => {
  try {
    response.set("Cache-Control", "no-store");
    const detailManifest = mergeFootprintManifests(bundledFootprintManifest, manualFootprints.publishedManifest());
    response.json({ releases: buildPublicReleaseDetails(CURATED_SURVEYS, publicReleaseProductStatuses, detailManifest) });
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
  response.set("Cache-Control", "no-store");
  response.json({ packages: resourcePackages.list() });
});

app.get("/api/resource-packages/active-footprints", async (_request: Request, response: Response) => {
  try {
    response.set("Cache-Control", "no-store");
    response.json(await effectiveFootprints());
  } catch (error) {
    sendApiError(response, error);
  }
});

app.get("/api/manual-footprints", (_request: Request, response: Response) => {
  response.set("Cache-Control", "no-store");
  response.json({ footprints: manualFootprints.list() });
});

app.get("/api/manual-footprints/:surveyId/:releaseId/:product", (request: Request, response: Response) => {
  try {
    const { surveyId, releaseId, product } = manualFootprintIdentity(request);
    const record = manualFootprints.get(surveyId, releaseId, product);
    footprintEtag(response, record.revision);
    response.json({ footprint: record });
  } catch (error) {
    sendApiError(response, error);
  }
});

app.post("/api/manual-footprints", async (request: Request, response: Response) => {
  if (!requireManualFootprintAdmin(request, response)) return;
  try {
    const record = await manualFootprints.create(request.body);
    footprintEtag(response, record.revision);
    response.status(201).json({ footprint: record });
  } catch (error) {
    sendApiError(response, error);
  }
});

app.put("/api/manual-footprints/:surveyId/:releaseId/:product", async (request: Request, response: Response) => {
  if (!requireManualFootprintAdmin(request, response)) return;
  const revision = manualFootprintRevision(request, response);
  if (revision === undefined) return;
  try {
    const { surveyId, releaseId, product } = manualFootprintIdentity(request);
    const record = await manualFootprints.update(surveyId, releaseId, product, revision, request.body);
    footprintEtag(response, record.revision);
    response.json({ footprint: record });
  } catch (error) {
    sendApiError(response, error);
  }
});

for (const action of ["validate", "publish", "unpublish"] as const) {
  app.post(`/api/manual-footprints/:surveyId/:releaseId/:product/${action}`, async (request: Request, response: Response) => {
    if (!requireManualFootprintAdmin(request, response)) return;
    const revision = manualFootprintRevision(request, response);
    if (revision === undefined) return;
    try {
      const { surveyId, releaseId, product } = manualFootprintIdentity(request);
      let record;
      if (action === "publish") {
        const active = await resourcePackages.activeFootprints();
        const existing = {
          ...active,
          footprints: [...active.footprints, ...bundledFootprintManifest.footprints.filter((footprint) => footprint.quality === "moc")],
        };
        record = await manualFootprints.publish(surveyId, releaseId, product, revision, existing);
      } else {
        record = await manualFootprints[action](surveyId, releaseId, product, revision);
      }
      footprintEtag(response, record.revision);
      response.json({ footprint: record });
    } catch (error) {
      sendApiError(response, error);
    }
  });
}

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
    response.status(201).json({ survey: await surveys.register(request.body as SurveyRegistrationInput) });
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

app.get("/api/sky/coverage", async (request: Request, response: Response) => {
  try {
    const nside = Number(request.query.nside ?? ASTRO_OVERVIEW_NSIDE);
    if (!Number.isInteger(nside) || nside < 1) throw new RangeError("nside must be a positive integer");
    const rawAssetIds = typeof request.query.assetIds === "string" ? request.query.assetIds : "";
    const assetIds = rawAssetIds.split(",").map((value) => value.trim()).filter(Boolean);
    const survey = queryText(request.query.survey, "survey");
    const release = queryText(request.query.release, "release");
    const baseInput = {
      nside,
      ...(survey ? { survey } : {}),
      ...(release ? { release } : {}),
    };

    // ES documents written by older FlinkIngest jobs may have blank survey /
    // release fields. Resolve ownership from the catalog first, then query ES
    // by asset group so those historical documents still land in the right
    // survey layer without rewriting the index.
    if (assetIds.length) {
      const groups = new Map<string, {
        key: string;
        surveyId?: string;
        releaseId?: string;
        source: EffectiveDataOwnership["source"];
        message?: string;
        assetIds: string[];
      }>();
      for (const assetId of [...new Set(assetIds)]) {
        let asset: DataAssetRecord;
        try { asset = await dataCatalog.get(assetId); } catch { continue; }
        const ownership = resolveDataOwnership(asset, await connectors.list());
        if (survey && ownership.surveyId !== survey) continue;
        if (release && ownership.releaseId !== release) continue;
        const key = ownership.source === "conflict" ? `__conflict__:${asset.id}` : ownershipKey(ownership);
        const group = groups.get(key) ?? {
          key,
          surveyId: ownership.surveyId,
          releaseId: ownership.releaseId,
          source: ownership.source,
          message: ownership.message,
          assetIds: [],
        };
        group.assetIds.push(asset.id);
        groups.set(key, group);
      }
      if (groups.size) {
        const layers: AstroCoverageLayer[] = [];
        const allPixels = new Set<number>();
        const allAssets = new Map<string, AstroCoverageLayer["byAsset"][number]>();
        const statuses: string[] = [];
        const messages: string[] = [];
        for (const group of groups.values()) {
          // Keep coverage ownership at asset granularity. A shared ownership
          // group only describes the display metadata; querying the whole
          // group would attribute every object's count to its first asset.
          const assetLayers = await Promise.all(group.assetIds.map(async (assetId) => {
            const asset = await dataCatalog.get(assetId);
            // Query both indexes by one asset id. The legacy index may contain
            // old file-level facts with blank ownership fields; the object
            // coverage index is authoritative for local CSV scans.
            const [legacy, local] = await Promise.all([
              astroIndex.coverage({ nside, assetIds: [assetId] }),
              astroObjectIndex.queryCoverageFacts({ nside, assetIds: [assetId] }),
            ]);
            const pixels = new Set<number>(legacy.pixels);
            local.pixels.forEach((pixel) => pixels.add(pixel));
            const objectCount = local.facts.reduce((sum, fact) => sum + fact.objectCount, 0);
            const status = legacy.status === "error" || local.status === "error"
              ? "error"
              : legacy.status === "unavailable" && local.status === "unavailable"
                ? "unavailable"
                : "ready";
            const message = [
              group.message,
              legacy.status === "error" ? legacy.message : undefined,
              local.status !== "ready" ? local.message : undefined,
            ].filter(Boolean).join("; ") || undefined;
            const breakdown = {
              key: asset.id,
              label: asset.name,
              files: legacy.byAsset.find((entry) => entry.key === asset.id)?.files ?? 0,
              bytes: legacy.byAsset.find((entry) => entry.key === asset.id)?.bytes ?? 0,
              objects: objectCount,
              objectCount,
            };
            return {
              layer: {
                key: `asset:${asset.id}`,
                assetId: asset.id,
                assetName: asset.name,
                surveyId: group.surveyId,
                releaseId: group.releaseId,
                source: group.source,
                message,
                status,
                assetIds: [asset.id],
                pixels: [...pixels].sort((left, right) => left - right),
                objectCount,
                byAsset: [breakdown],
              } satisfies AstroCoverageLayer,
              breakdown,
              pixels,
              status,
              message,
            };
          }));
          for (const entry of assetLayers) {
            statuses.push(entry.status);
            if (entry.message) messages.push(entry.message);
            allAssets.set(entry.layer.assetId!, entry.breakdown);
            entry.pixels.forEach((pixel) => allPixels.add(pixel));
            layers.push(entry.layer);
          }
        }
        const status = statuses.includes("error") ? "error" : statuses.includes("unavailable") ? "unavailable" : "ready";
        response.json({
          status,
          index: astroObjectIndex.coverageIndex,
          nside,
          pixels: [...allPixels].sort((left, right) => left - right),
          byAsset: [...allAssets.values()],
          layers,
          ...(messages.length ? { message: [...new Set(messages)].join("; ") } : {}),
        });
        return;
      }
    }
    response.json(await astroIndex.coverage({
      ...baseInput,
      ...(assetIds.length ? { assetIds } : {}),
    }));
  } catch (error) {
    sendApiError(response, error);
  }
});

app.get("/api/datasets/:id/sky/summary", async (request: Request, response: Response) => {
  try {
    const record = await registry.get(datasetIdFrom(request));
    response.json({ dataset: publicDataset(record), sky: await skyIndexes.getSummary(record) });
  } catch (error) {
    sendApiError(response, error);
  }
});

app.get("/api/datasets/:id/sky/cells", async (request: Request, response: Response) => {
  try {
    const nside = Number(request.query.nside ?? "128");
    if (!Number.isInteger(nside)) throw new RangeError("nside must be an integer");
    const record = await registry.get(datasetIdFrom(request));
    const cells = await skyIndexes.getCells(record, nside);
    response.json({ nside, totalObjects: cells.reduce((sum, cell) => sum + cell.count, 0), cells });
  } catch (error) {
    sendApiError(response, error);
  }
});

app.get("/api/datasets/:id/sky/objects", async (request: Request, response: Response) => {
  try {
    const offset = Number(request.query.offset ?? "0");
    const limit = Number(request.query.limit ?? "50000");
    if (!Number.isInteger(offset) || offset < 0) throw new RangeError("offset must be a non-negative integer");
    if (!Number.isInteger(limit) || limit < 1 || limit > 50_000) {
      throw new RangeError("limit must be an integer between 1 and 50000");
    }
    const record = await registry.get(datasetIdFrom(request));
    const page = await skyIndexes.getPoints(record, offset, limit);
    response.json({ offset, limit, ...page });
  } catch (error) {
    sendApiError(response, error);
  }
});

app.get("/api/volumes", async (_request: Request, response: Response) => {
  try {
    response.json({ volumes: (await volumes.list()).map(publicVolumeManifest) });
  } catch (error) {
    sendApiError(response, error);
  }
});

app.get("/api/volumes/:id", async (request: Request, response: Response) => {
  try {
    response.json({ volume: publicVolumeManifest(await volumes.get(datasetIdFrom(request))) });
  } catch (error) {
    sendApiError(response, error);
  }
});

app.get("/api/volumes/:id/points.bin", async (request: Request, response: Response) => {
  try {
    const { manifest, filePath } = await volumes.pointsPath(datasetIdFrom(request));
    response.set({
      "Content-Type": "application/octet-stream",
      "Content-Length": String(manifest.binary.byteLength),
      "Cache-Control": "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    });
    response.sendFile(filePath);
  } catch (error) {
    sendApiError(response, error);
  }
});

app.get("/api/atlases", async (_request: Request, response: Response) => {
  try {
    response.json({ atlases: (await atlases.list()).map(publicAtlasManifest) });
  } catch (error) {
    sendApiError(response, error);
  }
});

app.get("/api/atlases/:id", async (request: Request, response: Response) => {
  try {
    response.json({ atlas: publicAtlasManifest(await atlases.get(datasetIdFrom(request))) });
  } catch (error) {
    sendApiError(response, error);
  }
});

app.get("/api/atlases/:id/angular-cells.bin", async (request: Request, response: Response) => {
  try {
    const { manifest, filePath } = await atlases.angularPath(datasetIdFrom(request));
    response.set({
      "Content-Type": "application/octet-stream",
      "Content-Length": String(manifest.angularBinary.byteLength),
      "Cache-Control": "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    });
    response.sendFile(filePath);
  } catch (error) {
    sendApiError(response, error);
  }
});

app.get("/api/atlases/:id/joint-cells.bin", async (request: Request, response: Response) => {
  try {
    const { manifest, filePath } = await atlases.jointPath(datasetIdFrom(request));
    response.set({
      "Content-Type": "application/octet-stream",
      "Content-Length": String(manifest.jointIndex.byteLength),
      "Cache-Control": "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    });
    response.sendFile(filePath);
  } catch (error) {
    sendApiError(response, error);
  }
});

app.get("/api/atlases/:id/joint", async (request: Request, response: Response) => {
  try {
    const optionalNumber = (name: string): number | undefined => {
      const value = request.query[name];
      if (value == null || value === "") return undefined;
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) throw new RangeError(`${name} must be finite`);
      return parsed;
    };
    const surveyId = String(request.query.survey ?? "desi");
    const nside = Number(request.query.nside ?? "32");
    const radialBins = Number(request.query.radialBins ?? "8");
    if (!Number.isInteger(nside) || !Number.isInteger(radialBins)) throw new RangeError("Joint levels must be integers");
    const result = await atlases.queryJoint(datasetIdFrom(request), {
      surveyId,
      nside,
      radialBins,
      radialMinMpc: optionalNumber("radialMinMpc"),
      radialMaxMpc: optionalNumber("radialMaxMpc"),
      parentNside: optionalNumber("parentNside"),
      parentPixel: optionalNumber("parentPixel"),
    });
    const body = JSON.stringify(result);
    response.set({ "Content-Type": "application/json", "X-Response-Bytes": String(Buffer.byteLength(body)) });
    response.send(body);
  } catch (error) {
    sendApiError(response, error);
  }
});

app.get("/api/atlases/:id/refinement", async (request: Request, response: Response) => {
  try {
    const surveyId = String(request.query.survey ?? "desi");
    const values = ["nside", "radialBins", "pixel", "radialBin"].map((name) => Number(request.query[name]));
    if (values.some((value) => !Number.isInteger(value))) throw new RangeError("Refinement coordinates must be integers");
    response.json(await atlases.refinement(datasetIdFrom(request), surveyId, values[0]!, values[1]!, values[2]!, values[3]!));
  } catch (error) {
    sendApiError(response, error);
  }
});

app.get("/api/atlases/:id/objects", async (request: Request, response: Response) => {
  try {
    const surveyId = String(request.query.survey ?? "desi");
    const required = ["nside", "pixel", "radialBins", "radialBin"] as const;
    const values = Object.fromEntries(required.map((name) => [name, Number(request.query[name])]));
    if (Object.values(values).some((value) => !Number.isInteger(value))) throw new RangeError("Cell coordinates must be integers");
    const offset = Number(request.query.offset ?? "0");
    const limit = Number(request.query.limit ?? "500");
    const atlasId = datasetIdFrom(request);
    const manifest = await atlases.get(atlasId);
    const survey = manifest.surveys.find((candidate) => candidate.id === surveyId);
    if (!survey?.radialCoordinate) throw new RangeError(`Survey has no radial coordinate: ${surveyId}`);
    if (!manifest.jointIndex.angularLevels.includes(values.nside!) || !manifest.jointIndex.radialLevels.includes(values.radialBins!)) {
      throw new RangeError("Unsupported joint cell level");
    }
    const page = await volumes.queryCellPoints(survey.radialCoordinate.sourceVolumeId, {
      nside: values.nside!,
      pixel: values.pixel!,
      radialBins: values.radialBins!,
      radialBin: values.radialBin!,
      offset,
      limit,
    });
    const indexed = await atlases.queryJoint(atlasId, {
      surveyId,
      nside: values.nside!,
      radialBins: values.radialBins!,
      parentNside: values.nside!,
      parentPixel: values.pixel!,
    });
    const expectedCellCount = indexed.cells.find((cell) => cell.pixel === values.pixel && cell.radialBin === values.radialBin)?.count ?? 0;
    if (page.total !== expectedCellCount) {
      throw new Error(`Cell object count does not match the joint index: expected ${expectedCellCount}, received ${page.total}`);
    }
    response.json({ atlasId, surveyId, expectedCellCount, ...page });
  } catch (error) {
    sendApiError(response, error);
  }
});

app.get("/api/scan-runs", async (_request: Request, response: Response) => {
  try {
    response.json({ scanRuns: await scanRuns.list() });
  } catch (error) {
    sendApiError(response, error);
  }
});

app.get("/api/scan-runs/:id", async (request: Request, response: Response) => {
  try {
    response.json({ scanRun: await scanRuns.get(datasetIdFrom(request)) });
  } catch (error) {
    sendApiError(response, error);
  }
});

app.get("/api/lineage/:id", async (request: Request, response: Response) => {
  try {
    const id = datasetIdFrom(request);
    const workflowRun = await workflowStore.get(id).catch((error: unknown) => {
      if (error instanceof Error && error.message.startsWith("Workflow run not found:")) return null;
      throw error;
    });
    if (workflowRun) {
      response.json({ id, type: "workflow-run", lineage: workflowRun.lineage });
      return;
    }
    response.json(await scanRuns.lineage(id));
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
  const server = createAstroMcpServer(registry);
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
  await resourcePackages.initialize();
  const productStatus = JSON.parse(await readFile(publicReleaseDetailsPath, "utf8")) as { releases?: Array<{ surveyId: string; releaseId: string; products: Array<Omit<PublicReleaseProductStatus, "surveyId" | "releaseId">> }> };
  publicReleaseProductStatuses = (productStatus.releases ?? []).flatMap((release) => release.products.map((product) => ({
    ...product,
    surveyId: release.surveyId,
    releaseId: release.releaseId,
  })));
  bundledFootprintManifest = normalizeSurveyFootprintManifest(JSON.parse(await readFile(bundledFootprintPath, "utf8")) as SurveyFootprintManifest);
  manualFootprints = new ManualFootprintRegistry({
    statePath: manualFootprintStatePath,
    resolveSurvey: (surveyId) => {
      try { return surveys.get(surveyId); } catch { return undefined; }
    },
    releaseProducts: publicReleaseProductStatuses,
  });
  await manualFootprints.initialize();
  flinkScans.start();
  const bootstrapCatalog = process.env.ASTRO_BOOTSTRAP_CATALOG;
  if (bootstrapCatalog) {
    const record = await registry.registerLocalCsv(
      bootstrapCatalog,
      process.env.ASTRO_BOOTSTRAP_NAME ?? "COSMOS Clean V2",
    );
    await skyIndexes.getSummary(record);
    console.log(`Bootstrapped dataset ${record.id} from configured catalog`);
  }

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
  flinkScans.stop();
  if (httpServer) await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
  await metadataStore.close();
  process.exit(0);
}

process.on("SIGINT", () => { void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });
