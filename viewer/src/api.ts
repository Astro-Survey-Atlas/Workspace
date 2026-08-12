export interface RightAscensionInterval {
  startDeg: number;
  endDeg: number;
  wraps: boolean;
  spanDeg: number;
}

export interface DatasetSummary {
  id: string;
  name: string;
  profile: {
    format: "csv";
    byteSize: number;
    rowCount: number;
    columns: Array<{ name: string; type: string; nullCount: number }>;
    skyCoverage: {
      raColumn: string;
      decColumn: string;
      rightAscension: RightAscensionInterval;
      decMinDeg: number;
      decMaxDeg: number;
      validRows: number;
      invalidRows: number;
    } | null;
  };
}

export interface SkySummary {
  coordinateFrame: "ICRS";
  objectCount: number;
  invalidRowCount: number;
  idColumn: string | null;
  levels: Array<{ nside: number; occupiedCellCount: number; maxCellCount: number }>;
}

export interface DensityCell {
  nside: number;
  pixel: number;
  count: number;
  centerRaDeg: number;
  centerDecDeg: number;
  vertices: Array<{ raDeg: number; decDeg: number }>;
}

export interface SkyPoint {
  id: string;
  rowIndex: number;
  raDeg: number;
  decDeg: number;
  attributes: Record<string, string>;
}

import type { AgentSession, ToolDescriptor, WorkflowDefinition, WorkflowRun } from "../../src/workflow";
import type { DataAssetRecord, DataAssetRegistrationInput } from "../../src/data-catalog";
import type { ConnectorCheck, ConnectorCheckInput, ConnectorPublicRecord, ConnectorRegistrationInput } from "../../src/connectors";
import type { ConnectorIngestRun, ConnectorIngestRunInput } from "../../src/connector-history";
import type { GenericScanInput } from "../../src/flink-ingest";
import type { TagDefinition } from "../../src/tags";
import type { SurveyCard, SurveyRecord, SurveyRegistrationInput } from "../../src/survey-registry";
import type { SurveyFootprintManifest } from "../../src/survey-footprints";
import type { ManualFootprintInput, ManualFootprintRecord } from "../../src/manual-footprints";
import type { PublicResourcePackage, ResourcePackageJob, ResourcePackageLoad } from "../../src/resource-packages";
import type { PublicReleaseDetail } from "../../src/public-release-details";
import type { AstroCoverageResponse, AstroOverviewResponse, AstroSkyQueryInput, AstroSpatialSummary } from "../../src/astro-index";

export interface WorkspaceCapabilities {
  dataWarehouse: { enabled: boolean };
  metadataStore: { engine: string };
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
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

async function manualFootprintRequest<T>(url: string, method: "POST" | "PUT", token: string, revision?: number, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json", Authorization: `Bearer ${token}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (revision !== undefined) headers["If-Match"] = String(revision);
  const response = await fetch(url, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error ?? `Request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

function manualFootprintUrl(identity: Pick<ManualFootprintInput, "surveyId" | "releaseId" | "product">): string {
  return `/api/manual-footprints/${encodeURIComponent(identity.surveyId)}/${encodeURIComponent(identity.releaseId)}/${encodeURIComponent(identity.product)}`;
}

export const workspaceApi = {
  async capabilities(): Promise<WorkspaceCapabilities> {
    return getJson<WorkspaceCapabilities>("/api/capabilities");
  },
  async dataAssets(origin?: "user" | "builtin"): Promise<DataAssetRecord[]> {
    const parameters = origin ? `?${new URLSearchParams({ origin })}` : "";
    return (await getJson<{ assets: DataAssetRecord[] }>(`/api/data-assets${parameters}`)).assets;
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
  async checkConnector(id: string): Promise<{ connector: ConnectorPublicRecord; check: ConnectorCheck }> {
    return postJson(`/api/connectors/${encodeURIComponent(id)}/check`, {});
  },
  async checkConnectorInput(input: ConnectorCheckInput): Promise<ConnectorCheck> {
    return (await postJson<{ check: ConnectorCheck }>("/api/connectors/check", input)).check;
  },
  async connectorRuns(id: string): Promise<ConnectorIngestRun[]> {
    return (await getJson<{ runs: ConnectorIngestRun[] }>(`/api/connectors/${encodeURIComponent(id)}/ingest-runs`)).runs;
  },
  async connectorIngestRuns(): Promise<ConnectorIngestRun[]> {
    return (await getJson<{ runs: ConnectorIngestRun[] }>('/api/connector-ingest-runs')).runs;
  },
  async submitConnectorPilotScan(id: string): Promise<ConnectorIngestRun[]> {
    return (await postJson<{ runs: ConnectorIngestRun[] }>(`/api/connectors/${encodeURIComponent(id)}/scans`, { mode: "pilot" })).runs;
  },
  async submitConnectorScan(id: string, input: GenericScanInput): Promise<ConnectorIngestRun> {
    return (await postJson<{ run: ConnectorIngestRun }>(`/api/connectors/${encodeURIComponent(id)}/scans`, { mode: "scan", ...input })).run;
  },
  async addConnectorRun(id: string, input: ConnectorIngestRunInput): Promise<ConnectorIngestRun> {
    return (await postJson<{ run: ConnectorIngestRun }>(`/api/connectors/${encodeURIComponent(id)}/ingest-runs`, input)).run;
  },
  async datasets(): Promise<DatasetSummary[]> {
    return (await getJson<{ datasets: DatasetSummary[] }>("/api/datasets")).datasets;
  },
  async surveys(): Promise<SurveyCard[]> {
    return (await getJson<{ surveys: SurveyCard[] }>("/api/surveys")).surveys;
  },
  async survey(id: string): Promise<SurveyRecord> {
    return (await getJson<{ survey: SurveyRecord }>(`/api/surveys/${encodeURIComponent(id)}`)).survey;
  },
  async surveyFootprints(): Promise<SurveyFootprintManifest> {
    return getJson<SurveyFootprintManifest>("/api/survey-footprints");
  },
  async manualFootprints(): Promise<ManualFootprintRecord[]> {
    return (await getJson<{ footprints: ManualFootprintRecord[] }>("/api/manual-footprints")).footprints;
  },
  async manualFootprint(identity: Pick<ManualFootprintInput, "surveyId" | "releaseId" | "product">): Promise<ManualFootprintRecord> {
    return (await getJson<{ footprint: ManualFootprintRecord }>(manualFootprintUrl(identity))).footprint;
  },
  async createManualFootprint(input: ManualFootprintInput, token: string): Promise<ManualFootprintRecord> {
    return (await manualFootprintRequest<{ footprint: ManualFootprintRecord }>("/api/manual-footprints", "POST", token, undefined, input)).footprint;
  },
  async updateManualFootprint(input: ManualFootprintInput, revision: number, token: string): Promise<ManualFootprintRecord> {
    return (await manualFootprintRequest<{ footprint: ManualFootprintRecord }>(manualFootprintUrl(input), "PUT", token, revision, input)).footprint;
  },
  async validateManualFootprint(identity: Pick<ManualFootprintInput, "surveyId" | "releaseId" | "product">, revision: number, token: string): Promise<ManualFootprintRecord> {
    return (await manualFootprintRequest<{ footprint: ManualFootprintRecord }>(`${manualFootprintUrl(identity)}/validate`, "POST", token, revision)).footprint;
  },
  async publishManualFootprint(identity: Pick<ManualFootprintInput, "surveyId" | "releaseId" | "product">, revision: number, token: string): Promise<ManualFootprintRecord> {
    return (await manualFootprintRequest<{ footprint: ManualFootprintRecord }>(`${manualFootprintUrl(identity)}/publish`, "POST", token, revision)).footprint;
  },
  async unpublishManualFootprint(identity: Pick<ManualFootprintInput, "surveyId" | "releaseId" | "product">, revision: number, token: string): Promise<ManualFootprintRecord> {
    return (await manualFootprintRequest<{ footprint: ManualFootprintRecord }>(`${manualFootprintUrl(identity)}/unpublish`, "POST", token, revision)).footprint;
  },
  async publicReleaseDetails(): Promise<PublicReleaseDetail[]> {
    return (await getJson<{ releases: PublicReleaseDetail[] }>("/api/public-release-details")).releases;
  },
  async resourcePackages(): Promise<PublicResourcePackage[]> {
    return (await getJson<{ packages: PublicResourcePackage[] }>("/api/resource-packages")).packages;
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
  async skyCoverage(input: { nside: number; assetIds?: string[]; survey?: string; release?: string }): Promise<AstroCoverageResponse> {
    const parameters = new URLSearchParams({ nside: String(input.nside) });
    if (input.assetIds?.length) parameters.set("assetIds", input.assetIds.join(","));
    if (input.survey) parameters.set("survey", input.survey);
    if (input.release) parameters.set("release", input.release);
    return getJson<AstroCoverageResponse>(`/api/sky/coverage?${parameters}`);
  },
  async registerSurvey(input: SurveyRegistrationInput): Promise<SurveyRecord> {
    return (await postJson<{ survey: SurveyRecord }>("/api/surveys/registrations", input)).survey;
  },
  async skySummary(id: string): Promise<{ dataset: DatasetSummary; sky: SkySummary }> {
    return getJson(`/api/datasets/${encodeURIComponent(id)}/sky/summary`);
  },
  async cells(id: string, nside: number): Promise<DensityCell[]> {
    return (await getJson<{ cells: DensityCell[] }>(`/api/datasets/${encodeURIComponent(id)}/sky/cells?nside=${nside}`)).cells;
  },
  async points(id: string): Promise<SkyPoint[]> {
    return (await getJson<{ points: SkyPoint[] }>(`/api/datasets/${encodeURIComponent(id)}/sky/objects?limit=50000`)).points;
  },
  async volumes(): Promise<VolumeManifest[]> {
    return (await getJson<{ volumes: VolumeManifest[] }>("/api/volumes")).volumes;
  },
  async volumePoints(manifest: VolumeManifest): Promise<VolumePointData> {
    const response = await fetch(manifest.binary.url ?? `/api/volumes/${encodeURIComponent(manifest.id)}/points.bin`, {
      headers: { Accept: "application/octet-stream" },
    });
    if (!response.ok) throw new Error(`Volume point request failed: ${response.status}`);
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength !== manifest.binary.byteLength) {
      throw new Error(`Volume payload is ${buffer.byteLength} bytes; expected ${manifest.binary.byteLength}`);
    }
    return decodeVolumePoints(buffer, manifest.pointCount);
  },
  async atlases(): Promise<SurveyAtlasManifest[]> {
    return (await getJson<{ atlases: SurveyAtlasManifest[] }>("/api/atlases")).atlases;
  },
  async atlasAngularCells(manifest: SurveyAtlasManifest): Promise<AtlasAngularCellData> {
    const response = await fetch(manifest.angularBinary.url ?? `/api/atlases/${encodeURIComponent(manifest.id)}/angular-cells.bin`);
    if (!response.ok) throw new Error(`Atlas angular request failed: ${response.status}`);
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength !== manifest.angularBinary.byteLength) throw new Error("Atlas angular payload length mismatch");
    return decodeAtlasAngularCells(buffer);
  },
  async jointCells(
    atlasId: string,
    query: {
      survey: string;
      nside: number;
      radialBins: number;
      radialMinMpc?: number;
      radialMaxMpc?: number;
      parentNside?: number;
      parentPixel?: number;
    },
  ): Promise<AtlasJointQueryResponse> {
    const parameters = new URLSearchParams();
    Object.entries(query).forEach(([key, value]) => {
      if (value != null) parameters.set(key, String(value));
    });
    return getJson(`/api/atlases/${encodeURIComponent(atlasId)}/joint?${parameters}`);
  },
  async refinement(
    atlasId: string,
    query: { survey: string; nside: number; radialBins: number; pixel: number; radialBin: number },
  ): Promise<AtlasRefinementResponse> {
    return getJson(`/api/atlases/${encodeURIComponent(atlasId)}/refinement?${new URLSearchParams(
      Object.fromEntries(Object.entries(query).map(([key, value]) => [key, String(value)])),
    )}`);
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
  AtlasAngularCellData,
  AtlasJointCellView,
  AtlasJointQueryResponse,
  AtlasRefinementResponse,
  SurveyAtlasManifest,
  VolumeManifest,
  VolumePointData,
  SurveyCard,
  SurveyRecord,
  SurveyRegistrationInput,
  SurveyFootprintManifest,
  ManualFootprintInput,
  ManualFootprintRecord,
  AstroOverviewResponse,
  AstroSkyQueryInput,
  AstroSpatialSummary,
  DataAssetRecord,
  ConnectorPublicRecord,
  ConnectorRegistrationInput,
};
import {
  decodeAtlasAngularCells,
  type AtlasAngularCellData,
  type AtlasJointCellView,
  type AtlasJointQueryResponse,
  type AtlasRefinementResponse,
  type SurveyAtlasManifest,
} from "../../src/atlas-format";
import { decodeVolumePoints, type VolumeManifest, type VolumePointData } from "../../src/volume-format";
