import type { AgentSession, ToolDescriptor, WorkflowDefinition, WorkflowRun } from "../../src/workflow";
import type { DataAssetRecord as CoreDataAssetRecord, DataAssetRegistrationInput as CoreDataAssetRegistrationInput } from "../../src/data-catalog";
import type { ConnectorCheck, ConnectorCheckInput, ConnectorPublicRecord, ConnectorRegistrationInput } from "../../src/connectors";
import type { ConnectorIngestRun } from "../../src/connector-history";
import type { TagDefinition } from "../../src/tags";
import type { ReleaseAvailability, ReleaseKind, SurveyCard, SurveyModality, SurveyRecord, SurveyRegistrationInput } from "../../src/survey-registry";
import type { SurveyFootprintManifest } from "../../src/survey-footprints";
import type { PublicResourcePackage, ResourceCatalogStatus, ResourcePackageJob, ResourcePackageLoad } from "../../src/resource-packages";
import type { AstroOverviewResponse, AstroSkyQueryInput, AstroSpatialSummary } from "../../src/astro-index";
import type {
  AstroCellsQueryInput,
  AstroCellsQueryResult,
  ObjectRegionQueryInput,
  AstroObjectQueryResult,
} from "../../src/astro-object-index";

export interface WorkspaceCapabilities {
  dataWarehouse: { enabled: boolean };
  localScan?: { enabled: boolean; configured: boolean; executor: string; objectIndex: string; coverageIndex: string };
  metadataStore: { engine: string };
}

export type ConnectorScanRun = ConnectorIngestRun;

export interface DataAssetRecord extends CoreDataAssetRecord {
  sourceRelativePath?: string;
}

export interface DataAssetRegistrationInput extends CoreDataAssetRegistrationInput {
  sourceRelativePath?: string;
}

export interface LocalConnectorFile {
  relativePath: string;
  name?: string;
  byteSize?: number;
  modifiedAt?: string;
}

export interface LocalCsvColumn {
  name: string;
  type?: string;
  samples?: string[];
}

export interface LocalCsvInspection {
  sourceRelativePath: string;
  columns: LocalCsvColumn[];
  inferred?: {
    objectIdColumn?: string;
    raColumn?: string;
    decColumn?: string;
    confidence?: number;
    warnings?: string[];
  };
}

export interface SurveyReleaseRegistrationInput {
  label: string;
  sourceUrl: string;
  modalities: SurveyModality[];
  kind?: ReleaseKind;
  availability?: ReleaseAvailability;
  description?: string;
}

export interface WorkspaceCoverageBreakdown {
  key: string;
  label: string;
  files?: number;
  bytes?: number;
  objects?: number;
  objectCount?: number;
}

export interface WorkspaceAssetCoverageLayer {
  key: string;
  assetId?: string;
  assetIds: string[];
  assetName?: string;
  surveyId?: string;
  releaseId?: string;
  pixels: number[];
  objectCount?: number;
  byAsset: WorkspaceCoverageBreakdown[];
  source?: "connector" | "asset" | "unassigned" | "conflict";
  status?: "ready" | "unavailable" | "error";
  message?: string;
}

export interface WorkspaceAssetCoverageResponse {
  status: "ready" | "unavailable" | "error";
  index: string;
  nside: number;
  pixels: number[];
  byAsset: WorkspaceCoverageBreakdown[];
  layers?: WorkspaceAssetCoverageLayer[];
  message?: string;
}

export interface ResourceCatalogConfig extends ResourceCatalogStatus {
  adminConfigured: boolean;
  updatedAt?: string;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

async function postJson<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error ?? `Request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

async function putJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "PUT",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error ?? `Request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

async function deleteRequest(url: string): Promise<void> {
  const response = await fetch(url, { method: "DELETE", headers: { Accept: "application/json" } });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error ?? `Request failed: ${response.status}`);
  }
}

async function adminRequest<T>(url: string, method: "POST" | "PUT", token: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json", Authorization: `Bearer ${token}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(url, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error ?? `Request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export const workspaceApi = {
  async capabilities(): Promise<WorkspaceCapabilities> {
    return getJson<WorkspaceCapabilities>("/api/capabilities");
  },
  async dataAssets(): Promise<DataAssetRecord[]> {
    return (await getJson<{ assets: DataAssetRecord[] }>("/api/data-assets")).assets;
  },
  async dataAsset(id: string): Promise<DataAssetRecord> {
    return (await getJson<{ asset: DataAssetRecord }>(`/api/data-assets/${encodeURIComponent(id)}`)).asset;
  },
  async tags(): Promise<TagDefinition[]> {
    return (await getJson<{ tags: TagDefinition[] }>("/api/tags")).tags;
  },
  async registerDataAsset(input: DataAssetRegistrationInput): Promise<DataAssetRecord> {
    return (await postJson<{ asset: DataAssetRecord }>("/api/data-assets", input)).asset;
  },
  async updateDataAsset(id: string, input: DataAssetRegistrationInput): Promise<DataAssetRecord> {
    return (await putJson<{ asset: DataAssetRecord }>(`/api/data-assets/${encodeURIComponent(id)}`, input)).asset;
  },
  async deleteDataAsset(id: string): Promise<void> {
    await deleteRequest(`/api/data-assets/${encodeURIComponent(id)}`);
  },
  async executeDataAssetLocalScan(id: string): Promise<ConnectorScanRun> {
    return (await postJson<{ run: ConnectorScanRun }>(`/api/data-assets/${encodeURIComponent(id)}/local-scan`, {})).run;
  },
  async dataAssetScanRuns(id: string): Promise<ConnectorScanRun[]> {
    const parameters = new URLSearchParams({ assetId: id });
    const runs = (await getJson<{ runs: ConnectorScanRun[] }>(`/api/connector-ingest-runs?${parameters}`)).runs;
    return runs.filter((run) => run.assetId === id || run.assetIds?.includes(id));
  },
  async connectors(): Promise<ConnectorPublicRecord[]> {
    return (await getJson<{ connectors: ConnectorPublicRecord[] }>("/api/connectors")).connectors;
  },
  async connector(id: string): Promise<ConnectorPublicRecord> {
    return (await getJson<{ connector: ConnectorPublicRecord }>(`/api/connectors/${encodeURIComponent(id)}`)).connector;
  },
  async registerConnector(input: ConnectorRegistrationInput): Promise<ConnectorPublicRecord> {
    return (await postJson<{ connector: ConnectorPublicRecord }>("/api/connectors", input)).connector;
  },
  async updateConnector(id: string, input: ConnectorRegistrationInput): Promise<ConnectorPublicRecord> {
    return (await putJson<{ connector: ConnectorPublicRecord }>(`/api/connectors/${encodeURIComponent(id)}`, input)).connector;
  },
  async deleteConnector(id: string): Promise<void> {
    await deleteRequest(`/api/connectors/${encodeURIComponent(id)}`);
  },
  async localConnectorFiles(id: string): Promise<LocalConnectorFile[]> {
    const payload = await getJson<{ files: Array<LocalConnectorFile | string> }>(`/api/connectors/${encodeURIComponent(id)}/local-files`);
    return payload.files.map((file) => typeof file === "string" ? { relativePath: file } : {
      ...file,
      byteSize: file.byteSize ?? (file as LocalConnectorFile & { sizeBytes?: number }).sizeBytes,
    });
  },
  async inspectLocalConnectorFile(id: string, sourceRelativePath: string): Promise<LocalCsvInspection> {
    const payload = await postJson<{ inspection: Omit<LocalCsvInspection, "columns"> & { columns: Array<LocalCsvColumn | string> } }>(
      `/api/connectors/${encodeURIComponent(id)}/local-files/inspect`,
      { sourceRelativePath },
    );
    return {
      ...payload.inspection,
      columns: payload.inspection.columns.map((column) => typeof column === "string" ? { name: column } : column),
    };
  },
  async checkConnector(id: string): Promise<{ connector: ConnectorPublicRecord; check: ConnectorCheck }> {
    return postJson(`/api/connectors/${encodeURIComponent(id)}/check`, {});
  },
  async checkConnectorInput(input: ConnectorCheckInput): Promise<ConnectorCheck> {
    return (await postJson<{ check: ConnectorCheck }>("/api/connectors/check", input)).check;
  },
  async connectorRuns(id: string): Promise<ConnectorScanRun[]> {
    return (await getJson<{ runs: ConnectorScanRun[] }>(`/api/connectors/${encodeURIComponent(id)}/ingest-runs`)).runs;
  },
  async connectorIngestRuns(): Promise<ConnectorScanRun[]> {
    return (await getJson<{ runs: ConnectorScanRun[] }>("/api/connector-ingest-runs")).runs;
  },
  async executeConnectorScan(id: string): Promise<ConnectorScanRun> {
    return (await postJson<{ run: ConnectorScanRun }>(`/api/connectors/${encodeURIComponent(id)}/scan-runs`, {})).run;
  },
  async surveys(): Promise<SurveyCard[]> {
    return (await getJson<{ surveys: SurveyCard[] }>("/api/surveys")).surveys;
  },
  async survey(id: string): Promise<SurveyRecord> {
    return (await getJson<{ survey: SurveyRecord }>(`/api/surveys/${encodeURIComponent(id)}`)).survey;
  },
  async publicSurveys(): Promise<SurveyCard[]> {
    return (await getJson<{ surveys: SurveyCard[] }>("/api/public-surveys")).surveys;
  },
  async publicSurvey(id: string): Promise<SurveyRecord> {
    return (await getJson<{ survey: SurveyRecord }>(`/api/public-surveys/${encodeURIComponent(id)}`)).survey;
  },
  async surveyFootprints(): Promise<SurveyFootprintManifest> {
    return getJson<SurveyFootprintManifest>("/api/survey-footprints");
  },
  async resourcePackages(): Promise<PublicResourcePackage[]> {
    return (await getJson<{ packages: PublicResourcePackage[] }>("/api/resource-packages")).packages;
  },
  async resourceCatalogConfig(): Promise<ResourceCatalogConfig> {
    return (await getJson<{ config: ResourceCatalogConfig }>("/api/resource-packages/config")).config;
  },
  async setResourceCatalogConfig(catalogUrl: string, token: string): Promise<ResourceCatalogConfig> {
    return (await adminRequest<{ config: ResourceCatalogConfig }>("/api/resource-packages/config", "PUT", token, { catalogUrl })).config;
  },
  async syncResourceCatalog(token: string): Promise<{ catalog: ResourceCatalogStatus; packages: PublicResourcePackage[] }> {
    return adminRequest<{ catalog: ResourceCatalogStatus; packages: PublicResourcePackage[] }>("/api/resource-packages/sync", "POST", token, {});
  },
  async installResourcePackage(id: string): Promise<ResourcePackageJob> {
    return (await postJson<{ job: ResourcePackageJob }>(`/api/resource-packages/${encodeURIComponent(id)}/install`, {})).job;
  },
  async resourcePackageJob(id: string): Promise<ResourcePackageJob> {
    return (await getJson<{ job: ResourcePackageJob }>(`/api/resource-packages/jobs/${encodeURIComponent(id)}`)).job;
  },
  async setActiveResourcePackages(loads: ResourcePackageLoad[] | string[]): Promise<PublicResourcePackage[]> {
    const body = typeof loads[0] === "string" ? { ids: loads } : { loads };
    return (await putJson<{ packages: PublicResourcePackage[] }>("/api/resource-packages/active", body)).packages;
  },
  async activateResourcePackage(id: string): Promise<PublicResourcePackage> {
    return (await postJson<{ package: PublicResourcePackage }>(`/api/resource-packages/${encodeURIComponent(id)}/activate`, {})).package;
  },
  async deactivateResourcePackage(id: string): Promise<PublicResourcePackage> {
    return (await postJson<{ package: PublicResourcePackage }>(`/api/resource-packages/${encodeURIComponent(id)}/deactivate`, {})).package;
  },
  async deleteResourcePackage(id: string): Promise<void> {
    await deleteRequest(`/api/resource-packages/${encodeURIComponent(id)}`);
  },
  async skyOverview(input: { survey: string; release: string; nside: number; cells: number[] }): Promise<AstroOverviewResponse> {
    const parameters = new URLSearchParams({
      survey: input.survey,
      release: input.release,
      nside: String(input.nside),
      cells: input.cells.join(","),
    });
    return getJson<AstroOverviewResponse>(`/api/sky/overview?${parameters}`);
  },
  async skyQuery(input: AstroSkyQueryInput): Promise<AstroSpatialSummary> {
    return postJson<AstroSpatialSummary>("/api/sky/query", input);
  },
  async skyCellsQuery(input: AstroCellsQueryInput, signal?: AbortSignal): Promise<AstroCellsQueryResult> {
    return postJson<AstroCellsQueryResult>("/api/sky/cells/query", input, signal);
  },
  async skyObjectsQuery(input: ObjectRegionQueryInput, signal?: AbortSignal): Promise<AstroObjectQueryResult> {
    return postJson<AstroObjectQueryResult>("/api/sky/objects/query", input, signal);
  },
  async skyCoverage(input: { nside: number; assetIds?: string[]; survey?: string; release?: string }): Promise<WorkspaceAssetCoverageResponse> {
    const parameters = new URLSearchParams({ nside: String(input.nside) });
    if (input.assetIds?.length) parameters.set("assetIds", input.assetIds.join(","));
    if (input.survey) parameters.set("survey", input.survey);
    if (input.release) parameters.set("release", input.release);
    return getJson<WorkspaceAssetCoverageResponse>(`/api/sky/coverage?${parameters}`);
  },
  async registerSurvey(input: SurveyRegistrationInput): Promise<SurveyRecord> {
    return (await postJson<{ survey: SurveyRecord }>("/api/surveys/registrations", input)).survey;
  },
  async addSurveyRelease(surveyId: string, input: SurveyReleaseRegistrationInput): Promise<SurveyRecord> {
    return (await postJson<{ survey: SurveyRecord }>(`/api/surveys/${encodeURIComponent(surveyId)}/releases`, input)).survey;
  },
  async tools(): Promise<ToolDescriptor[]> {
    return (await getJson<{ tools: ToolDescriptor[] }>("/api/tools")).tools;
  },
  async workflows(): Promise<WorkflowDefinition[]> {
    return (await getJson<{ workflows: WorkflowDefinition[] }>("/api/workflows")).workflows;
  },
  async createWorkflowRun(workflowId: string, input: Record<string, unknown>): Promise<WorkflowRun> {
    return (await postJson<{ run: WorkflowRun }>("/api/workflow-runs", { workflowId, input })).run;
  },
  async workflowRun(id: string): Promise<WorkflowRun> {
    return (await getJson<{ run: WorkflowRun }>(`/api/workflow-runs/${encodeURIComponent(id)}`)).run;
  },
  async decideWorkflowRun(id: string, decision: Record<string, unknown>): Promise<WorkflowRun> {
    return (await postJson<{ run: WorkflowRun }>(`/api/workflow-runs/${encodeURIComponent(id)}/decisions`, decision)).run;
  },
  async createAgentSession(workflowId: string): Promise<AgentSession> {
    return (await postJson<{ session: AgentSession }>("/api/agent/sessions", { workflowId })).session;
  },
  async sendAgentMessage(sessionId: string, message: string): Promise<{ session: AgentSession; run?: WorkflowRun }> {
    return postJson(`/api/agent/sessions/${encodeURIComponent(sessionId)}/messages`, { message });
  },
};

export type {
  SurveyCard,
  SurveyRecord,
  SurveyRegistrationInput,
  SurveyFootprintManifest,
  AstroOverviewResponse,
  AstroSkyQueryInput,
  AstroSpatialSummary,
  ConnectorPublicRecord,
  ConnectorRegistrationInput,
};
