import path from "node:path";
import { fileURLToPath } from "node:url";

import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import type { Request, Response } from "express";

import { AgentService } from "./agent.js";
import { AtlasCatalog, publicAtlasManifest } from "./atlas.js";
import { McpCatalogQueryClient } from "./catalog-mcp-client.js";
import { DataCatalogRegistry, type DataAssetRegistrationInput } from "./data-catalog.js";
import { createAstroMcpServer } from "./mcp.js";
import { ScanRunCatalog } from "./provenance.js";
import { JsonDatasetRegistry } from "./registry.js";
import { SurveyRegistry, type SurveyRegistrationInput } from "./survey-registry.js";
import { SurveyFootprintCatalog } from "./survey-footprints.js";
import { CatalogSkyIndexService } from "./sky-index.js";
import type { DatasetRecord } from "./types.js";
import { publicVolumeManifest, VolumeCatalog } from "./volume.js";
import { WorkflowEngine } from "./workflow-engine.js";
import { WorkflowStore } from "./workflow-store.js";

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
const surveyFootprintRoot = process.env.ASTRO_SURVEY_FOOTPRINT_ROOT ?? path.join(projectRoot, "footprints");
const catalogMcpUrl = process.env.ASTRO_CATALOG_MCP_URL ?? "http://eva24002-entrance.lab.zverse.space:30082/mcp";
const catalogMcpTimeoutMs = Number(process.env.ASTRO_CATALOG_MCP_TIMEOUT_MS ?? "15000");

const registry = new JsonDatasetRegistry({ statePath, allowedRoots });
const skyIndexes = new CatalogSkyIndexService();
const volumes = new VolumeCatalog(volumeRoot);
const atlases = new AtlasCatalog(atlasRoot);
const scanRuns = new ScanRunCatalog(provenanceRoot);
const workflowStore = new WorkflowStore(workflowRoot);
const surveys = new SurveyRegistry(surveyRegistryStatePath);
const dataCatalog = new DataCatalogRegistry(dataCatalogBootstrapPath, dataCatalogStatePath);
const surveyFootprints = new SurveyFootprintCatalog(surveyFootprintRoot);
const workflowEngine = new WorkflowEngine(workflowStore, new McpCatalogQueryClient(catalogMcpUrl, catalogMcpTimeoutMs, 1));
const agentService = new AgentService(workflowStore, workflowEngine);
const app = createMcpExpressApp({ host, allowedHosts });

app.use("/api", express.json({ limit: "64kb" }));

app.get("/healthz", (_request: Request, response: Response) => {
  response.json({ status: "ok", service: "astro-data-workspace", version: "0.9.1" });
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

function sendApiError(response: Response, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const notFound = message.startsWith("Dataset not found:") || message.startsWith("Data asset not found:") || message.startsWith("Volume not found:") || message.startsWith("Atlas not found:") || message.startsWith("Survey not found:")
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
  response.json({ assets: dataCatalog.list() });
});

app.get("/api/data-assets/:id", (request: Request, response: Response) => {
  try {
    response.json({ asset: dataCatalog.get(datasetIdFrom(request)) });
  } catch (error) {
    sendApiError(response, error);
  }
});

app.post("/api/data-assets", async (request: Request, response: Response) => {
  try {
    response.status(201).json({ asset: await dataCatalog.register(request.body as DataAssetRegistrationInput) });
  } catch (error) {
    sendApiError(response, error);
  }
});

app.put("/api/data-assets/:id", async (request: Request, response: Response) => {
  try {
    response.json({ asset: await dataCatalog.update(datasetIdFrom(request), request.body as DataAssetRegistrationInput) });
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
    response.set("Cache-Control", "public, max-age=3600");
    response.json(await surveyFootprints.list());
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
  if (!httpServer) {
    process.exit(0);
    return;
  }
  httpServer.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
