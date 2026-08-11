import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import type { Request, Response } from "express";

import { AgentService } from "./agent.js";
import { AtlasCatalog, publicAtlasManifest } from "./atlas.js";
import { AstroIndexService, ASTRO_OVERVIEW_NSIDE, type AstroCoverageLayer, type AstroSkyQueryInput } from "./astro-index.js";
import { McpCatalogQueryClient } from "./catalog-mcp-client.js";
import { createConnectorCredentialStore, type StoredConnectorCredentials } from "./connector-credentials.js";
import { ConnectorRegistry, connectorLocationKey, validateConnectorInput, type ConnectorCheckInput, type ConnectorPublicRecord, type ConnectorRecord, type ConnectorRegistrationInput } from "./connectors.js";
import { ConnectorIngestRunCatalog, type ConnectorIngestRunInput } from "./connector-history.js";
import { DataCatalogRegistry, type DataAssetAccess, type DataAssetRecord, type DataAssetRegistrationInput } from "./data-catalog.js";
import { ownershipKey, resolveDataOwnership, type EffectiveDataOwnership } from "./data-ownership.js";
import { FlinkScanService, type GenericScanInput } from "./flink-ingest.js";
import { createAstroMcpServer } from "./mcp.js";
import { ScanRunCatalog } from "./provenance.js";
import { JsonDatasetRegistry } from "./registry.js";
import { ResourcePackageManager, type ResourcePackageLoad } from "./resource-packages.js";
import { SurveyRegistry, type SurveyRegistrationInput } from "./survey-registry.js";
import { CatalogSkyIndexService } from "./sky-index.js";
import type { DatasetRecord } from "./types.js";
import { publicVolumeManifest, VolumeCatalog } from "./volume.js";
import { WorkflowEngine } from "./workflow-engine.js";
import { WorkflowStore } from "./workflow-store.js";
import { listTags } from "./tags.js";

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
const resourcePackageRoot = process.env.ASTRO_RESOURCE_PACKAGE_ROOT ?? path.join(projectRoot, "data", "resource-packages");
const resourcePackageStatePath = process.env.ASTRO_RESOURCE_PACKAGE_STATE ?? path.join(path.dirname(statePath), "resource-package-state.json");
const resourceCatalogUrl = process.env.ASTRO_RESOURCE_CATALOG_URL ?? pathToFileURL(path.join(projectRoot, "bootstrap", "resource-packages", "catalog.json")).href;
const catalogMcpUrl = process.env.ASTRO_CATALOG_MCP_URL ?? "http://eva24002-entrance.lab.zverse.space:30082/mcp";
const catalogMcpTimeoutMs = Number(process.env.ASTRO_CATALOG_MCP_TIMEOUT_MS ?? "15000");
const flinkNamespace = process.env.ASTRO_FLINK_NAMESPACE ?? "warehouse";
const flinkSecretNamespace = process.env.ASTRO_FLINK_SECRET_NAMESPACE ?? flinkNamespace;
const flinkPollMs = Number(process.env.ASTRO_FLINK_POLL_MS ?? "5000");
const astroEsUrl = process.env.ASTRO_ES_URL ?? "";
const astroEsIndex = process.env.ASTRO_ES_ASTRO_INDEX ?? "astro_file_index_v1";

const registry = new JsonDatasetRegistry({ statePath, allowedRoots });
const skyIndexes = new CatalogSkyIndexService();
const volumes = new VolumeCatalog(volumeRoot);
const atlases = new AtlasCatalog(atlasRoot);
const scanRuns = new ScanRunCatalog(provenanceRoot);
const workflowStore = new WorkflowStore(workflowRoot);
const surveys = new SurveyRegistry(surveyRegistryStatePath);
const dataCatalog = new DataCatalogRegistry(dataCatalogBootstrapPath, dataCatalogStatePath);
const connectors = new ConnectorRegistry(connectorStatePath, connectorBootstrapPath);
const connectorCredentials = createConnectorCredentialStore();
const connectorRuns = new ConnectorIngestRunCatalog(connectorRunStatePath);
const flinkScans = new FlinkScanService({
  connectors,
  dataCatalog,
  credentials: connectorCredentials,
  runs: connectorRuns,
  namespace: flinkNamespace,
  secretNamespace: flinkSecretNamespace,
  esUrl: astroEsUrl,
  esIndex: astroEsIndex,
  pollMs: flinkPollMs,
});
const resourcePackages = new ResourcePackageManager({ catalogUrl: resourceCatalogUrl, root: resourcePackageRoot, statePath: resourcePackageStatePath });
const astroIndex = new AstroIndexService();
const workflowEngine = new WorkflowEngine(workflowStore, new McpCatalogQueryClient(catalogMcpUrl, catalogMcpTimeoutMs, 1));
const agentService = new AgentService(workflowStore, workflowEngine);
const app = createMcpExpressApp({ host, allowedHosts });

app.use("/api", express.json({ limit: "64kb" }));

app.get("/healthz", (_request: Request, response: Response) => {
  response.json({ status: "ok", service: "astro-data-workspace", version: "0.10.38" });
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

function validateAssetConnectorOwnership(input: DataAssetRegistrationInput): EffectiveDataOwnership {
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
  } as DataAssetRecord, connectors.list());
  if (ownership.source === "conflict") throw new RangeError(ownership.message ?? "关联 Connector 的巡天归属不一致");
  return ownership;
}

function publicDataAsset(asset: DataAssetRecord): DataAssetRecord {
  const connectorRecords = connectors.list();
  const ownership = resolveDataOwnership(asset, connectorRecords);
  const resolvedRecords = [
    ...(asset.connectorLocationKeys ?? []).flatMap((key) => connectorRecords.filter((record) => record.locationKey === key)),
    ...(asset.connectorIds ?? []).flatMap((id) => {
      try { return [connectors.get(id)]; } catch { return []; }
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

function validateConnectorIds(input: DataAssetRegistrationInput): void {
  for (const id of input.connectorIds ?? []) {
    try { connectors.get(id); } catch { throw new RangeError(`connectorIds contains unknown connector: ${id}`); }
  }
  for (const key of input.connectorLocationKeys ?? []) {
    if (!connectors.list().some((record) => record.locationKey === key)) throw new RangeError(`connectorLocationKeys contains unknown path: ${key}`);
  }
}

function sendApiError(response: Response, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const notFound = message.startsWith("Dataset not found:") || message.startsWith("Data asset not found:") || message.startsWith("Connector not found:") || message.startsWith("Connector ingest run not found:") || message.startsWith("Volume not found:") || message.startsWith("Atlas not found:") || message.startsWith("Survey not found:") || message.startsWith("Resource package not found:") || message.startsWith("Resource package is not installed:") || message.startsWith("Resource package job not found:")
    || message.startsWith("Scan run not found:") || message.startsWith("Lineage not found:") || message.startsWith("Workflow not found:")
    || message.startsWith("Workflow run not found:") || message.startsWith("Workflow artifact not found:") || message.startsWith("Agent session not found:");
  const status = error instanceof RangeError ? 400 : notFound ? 404 : 500;
  if (status === 500) console.error("API request failed", error);
  response.status(status).json({ error: message });
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

app.get("/api/data-assets", (_request: Request, response: Response) => {
  response.json({ assets: dataCatalog.list().map(publicDataAsset) });
});

app.get("/api/tags", (_request: Request, response: Response) => {
  response.json({ tags: listTags() });
});

app.get("/api/data-assets/:id", (request: Request, response: Response) => {
  try {
    response.json({ asset: publicDataAsset(dataCatalog.get(datasetIdFrom(request))) });
  } catch (error) {
    sendApiError(response, error);
  }
});

app.post("/api/data-assets", async (request: Request, response: Response) => {
  try {
    const input = request.body as DataAssetRegistrationInput;
    validateConnectorIds(input);
    validateAssetConnectorOwnership(input);
    response.status(201).json({ asset: publicDataAsset(await dataCatalog.register(input)) });
  } catch (error) {
    sendApiError(response, error);
  }
});

app.put("/api/data-assets/:id", async (request: Request, response: Response) => {
  try {
    const id = datasetIdFrom(request);
    const input = request.body as DataAssetRegistrationInput;
    validateConnectorIds(input);
    const current = dataCatalog.get(id);
    validateAssetConnectorOwnership({
      ...current,
      ...input,
      connectorIds: input.connectorIds ?? current.connectorIds,
      connectorLocationKeys: input.connectorLocationKeys ?? current.connectorLocationKeys,
      accesses: input.accesses ?? current.accesses,
    });
    response.json({ asset: publicDataAsset(await dataCatalog.update(id, input)) });
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
  response.json({ connectors: await Promise.all(connectors.list().map(publicConnector)) });
});

app.get("/api/connectors/:id", async (request: Request, response: Response) => {
  try {
    response.json({ connector: await publicConnector(connectors.get(datasetIdFrom(request))) });
  } catch (error) {
    sendApiError(response, error);
  }
});

app.get("/api/connectors/:id/ingest-runs", async (request: Request, response: Response) => {
  try {
    const connector = connectors.get(datasetIdFrom(request));
    void flinkScans.poll();
    response.json({ runs: connectorRuns.list(connector.locationKey) });
  } catch (error) {
    sendApiError(response, error);
  }
});

// Alias kept for integrations that call these records scan runs.
app.get("/api/connectors/:id/runs", async (request: Request, response: Response) => {
  try {
    const connector = connectors.get(datasetIdFrom(request));
    void flinkScans.poll();
    response.json({ runs: connectorRuns.list(connector.locationKey) });
  } catch (error) {
    sendApiError(response, error);
  }
});

app.post("/api/connectors/:id/check", async (request: Request, response: Response) => {
  try {
    const id = datasetIdFrom(request);
    const current = connectors.get(id);
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
    const connector = connectors.get(datasetIdFrom(request));
    response.status(201).json({ run: await connectorRuns.add(connector.locationKey, request.body as ConnectorIngestRunInput) });
  } catch (error) {
    sendApiError(response, error);
  }
});

app.post("/api/connectors/:id/scans", async (request: Request, response: Response) => {
  try {
    const mode = typeof request.body?.mode === "string" ? request.body.mode : "pilot";
    if (mode === "pilot") {
      response.status(202).json({ runs: await flinkScans.submitPilot(datasetIdFrom(request)) });
      return;
    }
    if (mode !== "scan") throw new RangeError("scan mode must be pilot or scan");
    const input = request.body as Partial<GenericScanInput>;
    if (typeof input.assetId !== "string" || !input.assetId.trim()) throw new RangeError("assetId is required for a generic scan");
    response.status(202).json({ run: await flinkScans.submitScan(datasetIdFrom(request), input as GenericScanInput) });
  } catch (error) {
    sendApiError(response, error);
  }
});

app.delete("/api/connectors/:id/ingest-runs/:runId", async (request: Request, response: Response) => {
  try {
    const connector = connectors.get(datasetIdFrom(request));
    const runId = Array.isArray(request.params.runId) ? request.params.runId[0] : request.params.runId;
    if (!runId) throw new RangeError("run id is required");
    await connectorRuns.remove(connector.locationKey, runId);
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
    const existing = connectors.list().find((record) => record.locationKey === connectorLocationKey(value.kind, value.config));
    const credentials = value.kind === "s3" ? resolvedS3Credentials(input) : undefined;
    const connector = await connectors.register(internalConnectorInput(value, existing?.credentialRef));
    if (credentials) {
      const reference = connectorCredentials.managedReference(connector.id);
      try {
        await connectorCredentials.put(reference, credentials);
      } catch (error) {
        if (!existing) await connectors.remove(connector.id);
        throw error;
      }
      const saved = await connectors.setCredentialReference(connector.id, reference);
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
    const current = connectors.get(id);
    const value = validateConnectorInput(input);
    validateConnectorSurveyBinding(value);
    let credentialRef = current.credentialRef;
    if (value.kind === "s3") {
      const existing = current.credentialRef ? await connectorCredentials.get(current.credentialRef) : undefined;
      const credentials = resolvedS3Credentials(input, existing);
      credentialRef = current.credentialRef && connectorCredentials.isManaged(current.credentialRef)
        ? current.credentialRef
        : connectorCredentials.managedReference(current.id);
      await connectorCredentials.put(credentialRef, credentials);
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
    const current = connectors.get(id);
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

app.get("/api/survey-footprints", async (_request: Request, response: Response) => {
  try {
    response.set("Cache-Control", "no-store");
    response.json(await resourcePackages.activeFootprints());
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
    response.json(await resourcePackages.activeFootprints());
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
        try { asset = dataCatalog.get(assetId); } catch { continue; }
        const ownership = resolveDataOwnership(asset, connectors.list());
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
          // The catalog ownership filter above is authoritative. Do not add
          // survey/release terms to the ES request: older scanner documents
          // may have blank fields and must still be recovered by asset_id.
          const coverage = await astroIndex.coverage({ nside, assetIds: group.assetIds });
          coverage.pixels.forEach((pixel) => allPixels.add(pixel));
          coverage.byAsset.forEach((entry) => allAssets.set(entry.key, entry));
          statuses.push(coverage.status);
          if (coverage.message) messages.push(coverage.message);
          layers.push({
            key: group.key,
            surveyId: group.surveyId,
            releaseId: group.releaseId,
            source: group.source,
            message: group.message,
            assetIds: [...group.assetIds].sort(),
            pixels: coverage.pixels,
            byAsset: coverage.byAsset,
          });
        }
        const status = statuses.includes("error") ? "error" : statuses.includes("unavailable") ? "unavailable" : "ready";
        response.json({
          status,
          index: astroEsIndex || "astro_file_index_v1",
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
  await workflowStore.initialize();
  await surveys.initialize();
  await dataCatalog.initialize();
  await connectors.initialize();
  await connectorRuns.initialize();
  await resourcePackages.initialize();
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

void start().catch((error) => {
  console.error("Failed to start astro-data-workspace", error);
  process.exit(1);
});

function shutdown(): void {
  flinkScans.stop();
  if (!httpServer) {
    process.exit(0);
    return;
  }
  httpServer.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
