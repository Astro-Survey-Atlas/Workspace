import { ChevronLeft, ChevronRight, createIcons, Download, Globe2, GripVertical, Info, Layers3, Maximize2, MessageSquare, Minimize2, Moon, Play, Plus, RefreshCw, RotateCcw, Send, Settings2, SlidersHorizontal, Sun, Undo2, X } from "lucide";

import "./styles.css";
import {
  workspaceApi,
  type AstroOverviewResponse,
  type AstroSpatialSummary,
  type ConnectorScanRun,
  type SurveyCard,
  type SurveyRecord,
  type SurveyFootprintManifest,
  type DataAssetRecord,
  type WorkspaceAssetCoverageLayer,
  type WorkspaceAssetCoverageResponse,
  type WorkspaceCapabilities,
  type RemoteCoverageScanInput,
  type DataAssetOperationalStatusResponse,
  type SkyOverlapResponse,
  type CoverageDownloadJob,
} from "./api";
import { Healpix } from "healpixjs";
import { cartesianToRaDec, raDecToCartesian } from "./coordinates";
import type { AstroObjectRecord } from "../../src/astro-object-index";
import {
  SurveyLayerViewer,
  workspaceAssetColor,
  type SurveyLayerHover,
  type SurveyLayerInspection,
  type SurveyLayerInteractionMode,
  type SurveyLayerLayoutMode,
  type SurveyLayerSelection,
  type SurveyLayerState,
  type SurveyObjectPoint,
  type SurveyLayerOverlapComponent,
  type WorkspaceCoverageLayer,
} from "./survey-layer-viewer";
import type { AssetsSurveyRelease, PublicResourcePackage, ResourceCatalogStatus } from "../../src/resource-packages";
import type { SurveyModality, SurveyRegistrationInput } from "../../src/survey-registry";
import type { ConnectorPublicRecord } from "../../src/connectors";
import type { CoverageCoordinateUnits, CoverageJobMode, CoverageJobSpec } from "../../src/coverage-jobs";
import type { UserMocArtifact } from "../../src/user-moc-artifacts";
import { WorkflowPanel } from "./workflow-panel";
import { ProductionPanel, type ProductionContext, type ProductionInspectorView, type ProductionSummary } from "./production-panel";
import { SystemPanel, type SystemSummary } from "./system-panel";
import { AgentDock } from "./agent-dock";
import { DataCatalogPanel } from "./data-catalog-panel";
import { ConnectorPanel, type ConnectorMetrics } from "./connector-panel";
import { ResourcePackagePanel, type ResourcePackageSelectionCallbacks } from "./resource-package-panel";
import { AladinExplorer, type AladinAssetTarget, type AladinExplorerSnapshot, type AladinExplorerStatus } from "./aladin-explorer";
import { nestedSkyRegion } from "./sky-region";
import { normalizeLayerOrder } from "./layer-order";
import { notifyWorkspace, notifyWorkspaceError } from "./notifications";

type ViewMode = "catalog" | "packages" | "connectors" | "layers" | "workflow" | "system";

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing required element: ${id}`);
  return element as T;
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount >= 10 || unit === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`;
}

const PROJECT_STATE_LABELS: Record<DataAssetRecord["projectState"], string> = {
  public_reference: "公开参考",
  acquired: "已掌握",
  processed: "已加工",
  deliverable: "可交付",
  planned: "计划中",
};

const COVERAGE_STATE_LABELS: Record<string, string> = {
  not_started: "未开始",
  pending: "处理中",
  failed: "失败",
  ready: "已建立",
  empty: "已完成但为空",
  unavailable: "不可用",
};

const NEXT_ACTION_LABELS: Record<string, string> = {
  scan_local: "扫描本地文件",
  scan_remote: "提交远程扫描",
  retry: "重试上次扫描",
  configure_connector: "配置可扫描 Connector",
  configure_index: "配置空间索引",
  none: "无需操作",
};

function renderCoverageMetrics(): void {
  const publicSources = new Set(
    (surveyFootprints?.footprints ?? [])
      .filter((footprint) => visibleSurveyIds.has(footprint.surveyId) && footprint.pixels.length > 0)
      .map((footprint) => `${footprint.surveyId}:${footprint.releaseId}:${footprint.product}`),
  );
  const ownedLayers = [
    ...[...workspaceAssetLayers.values()].filter((layer) => visibleAssetIds.has(layer.assetId) && layer.pixels.length > 0 && layer.status === "ready"),
    ...legacyWorkspaceLayers.filter((layer) => layer.pixels.length > 0 && layer.status === "ready"),
    ...[...workspaceExtraLayers.entries()].filter(([key, layer]) => visibleWorkspaceLayerKeys.has(key) && layer.source !== "warehouse" && layer.pixels.length > 0 && layer.status === "ready").map(([, layer]) => layer),
  ];
  const remoteLayers = [...workspaceExtraLayers.entries()].filter(([key, layer]) => visibleWorkspaceLayerKeys.has(key) && layer.source === "warehouse" && layer.pixels.length > 0 && layer.status === "ready");
  const active = publicSources.size + ownedLayers.length + remoteLayers.length;
  const values: Array<[string, string, number]> = [
    ["metric-one", "ACTIVE", active],
    ["metric-two", "PUBLIC", publicSources.size],
    ["metric-three", "OWNED", ownedLayers.length],
    ["metric-four", "REMOTE", remoteLayers.length],
  ];
  byId("metric-five-label").textContent = "";
  byId("metric-five").textContent = "";
  byId("metric-five").parentElement?.setAttribute("hidden", "true");
  values.forEach(([valueId, label, value]) => {
    byId(`${valueId}-label`).textContent = label;
    byId(valueId).textContent = formatInteger(value);
  });
}

function assetsForSelection(selection: SurveyLayerSelection): DataAssetRecord[] {
  const surveyIds = new Set(selection.surveyIds);
  const releaseIds = new Set(selection.releaseIds);
  const assetIds = new Set(selection.assetIds);
  return dataAssets.filter((asset) => {
    if (assetIds.has(asset.id)) return true;
    const surveyId = asset.surveyId;
    const releaseId = asset.releaseId;
    return Boolean(surveyId) && surveyIds.has(surveyId!) && (!releaseId || releaseIds.has(releaseId));
  });
}

function projectStateSummary(assets: DataAssetRecord[]): string {
  const counts: Record<DataAssetRecord["projectState"], number> = {
    public_reference: 0,
    acquired: 0,
    processed: 0,
    deliverable: 0,
    planned: 0,
  };
  assets.forEach((asset) => {
    const states = asset.projectStates?.length ? asset.projectStates : [asset.projectState];
    states.forEach((state) => { counts[state] += 1; });
  });
  return (Object.keys(PROJECT_STATE_LABELS) as DataAssetRecord["projectState"][])
    .filter((state) => counts[state] > 0)
    .map((state) => `${PROJECT_STATE_LABELS[state]} ${counts[state]}`)
    .join(" · ") || "暂无关联项目资产";
}

interface DisplayLayerDescriptor {
  id: string;
  label: string;
  color: string;
  kind: "asset" | "survey" | "layer";
  assetId?: string;
  surveyId?: string;
  releaseId?: string;
  product?: string;
  modality?: string;
  provenance?: string;
}

const DISPLAY_LAYER_PALETTE = ["#f2cf62", "#45d7c6", "#ef8db2", "#9b8cff", "#5caeff", "#f29a62", "#72d88d", "#ed6d70"];

function displayLayerFor(input: {
  assetId?: string;
  surveyId?: string;
  releaseId?: string;
  product?: string;
  modality?: string;
  key?: string;
}): DisplayLayerDescriptor {
  const asset = input.assetId ? dataAssets.find((candidate) => candidate.id === input.assetId) : undefined;
  const surveyId = input.surveyId ?? asset?.surveyId;
  const releaseId = input.releaseId ?? asset?.releaseId;
  const survey = surveyId
    ? input.assetId
      ? localSurveyRecordsById.get(surveyId)
      : publicSurveyRecordsById.get(surveyId) ?? localSurveyRecordsById.get(surveyId)
    : undefined;
  const surveyCard = surveyId
    ? input.assetId
      ? surveyCards.find((candidate) => candidate.id === surveyId)
      : publicSurveyCards.find((candidate) => candidate.id === surveyId) ?? surveyCards.find((candidate) => candidate.id === surveyId)
    : undefined;
  const release = releaseId ? survey?.releases.find((candidate) => candidate.id === releaseId) : undefined;
  const product = input.product ?? asset?.product;
  const modality = input.modality ?? asset?.modalities?.[0];
  const assetName = asset?.name?.trim();
  const usableAssetName = assetName && !/^user[-_]/i.test(assetName) ? assetName : undefined;
  const surveyName = survey?.name ?? surveyCard?.name;
  const label = usableAssetName
    ?? ([surveyName, release?.label, product].filter(Boolean).join(" · ")
      || (input.assetId ? "用户资产" : input.surveyId ? "巡天图层" : "数据图层"));
  const fallbackKey = input.assetId ?? input.surveyId ?? input.key ?? "layer";
  const color = input.assetId
    ? workspaceAssetColor(input.assetId)
    : surveyCard?.color ?? survey?.color ?? DISPLAY_LAYER_PALETTE[Math.abs([...fallbackKey].reduce((hash, character) => ((hash * 31) + character.charCodeAt(0)) | 0, 7)) % DISPLAY_LAYER_PALETTE.length] ?? "#45d7c6";
  return {
    id: fallbackKey,
    label,
    color,
    kind: input.assetId ? "asset" : input.surveyId ? "survey" : "layer",
    assetId: input.assetId,
    surveyId,
    releaseId,
    product,
    modality,
    provenance: [input.assetId, surveyId, releaseId, product].filter(Boolean).join(" / "),
  };
}

function inspectorValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "--";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function inspectorRows(title: string, rows: Array<[string, string]>, actions: HTMLButtonElement[] = []): void {
  const empty = byId("inspector-empty");
  const content = byId("inspector-content");
  empty.hidden = false;
  content.hidden = true;
  content.replaceChildren();
  if (!title) return;
  empty.hidden = true;
  content.hidden = false;
  const heading = document.createElement("h2");
  heading.textContent = title;
  const list = document.createElement("dl");
  rows.forEach(([label, value]) => {
    const row = document.createElement("div");
    const term = document.createElement("dt");
    const detail = document.createElement("dd");
    term.textContent = label;
    detail.textContent = value;
    row.append(term, detail);
    list.append(row);
  });
  const actionBar = document.createElement("div");
  actionBar.className = "inspector-actions";
  actionBar.append(...actions);
  content.replaceChildren(heading, list, ...(actions.length ? [actionBar] : []));
}

function renderProductionInspector(view: ProductionInspectorView | null): void {
  const panel = byId("inspector-panel");
  const empty = byId("inspector-empty");
  const content = byId("inspector-content");
  panel.classList.remove("aladin-object-selected");
  delete panel.dataset.objectId;
  byId("inspector-kicker").textContent = view?.kicker ?? "PIPELINE INSPECTOR";
  content.className = "inspector-content production-inspector-content";
  content.replaceChildren();
  if (!view) {
    empty.hidden = false;
    content.hidden = true;
    return;
  }
  empty.hidden = true;
  content.hidden = false;
  const heading = document.createElement("h2"); heading.textContent = view.title;
  const metadata = document.createElement("dl");
  (view.rows ?? []).forEach(([label, value]) => {
    const row = document.createElement("div");
    const term = document.createElement("dt"); term.textContent = label;
    const detail = document.createElement("dd"); detail.textContent = value;
    row.append(term, detail); metadata.append(row);
  });
  const children: Node[] = [heading];
  if (view.summary) { const summary = document.createElement("p"); summary.className = "inspector-summary"; summary.textContent = view.summary; children.push(summary); }
  if (view.rows?.length) children.push(metadata);
  if (view.body) children.push(view.body);
  if (view.actions?.length) { const actionBar = document.createElement("div"); actionBar.className = "inspector-actions production-inspector-actions"; actionBar.append(...view.actions); children.push(actionBar); }
  content.append(...children);
}

function renderProductionSummary(summary: ProductionSummary): void {
  const values: Array<[string, string, string]> = [
    ["metric-one", "TEMPLATES", String(summary.templates)],
    ["metric-two", "RUNS", String(summary.runs)],
    ["metric-three", "ACTIVE", String(summary.activeRuns)],
    ["metric-four", "SUCCEEDED", String(summary.succeededRuns)],
    ["metric-five", "ARTIFACTS", String(summary.artifacts)],
  ];
  values.forEach(([valueId, label, value]) => { byId(`${valueId}-label`).textContent = label; byId(valueId).textContent = value; });
  byId("dataset-state").textContent = summary.activeRuns ? `${summary.activeRuns} 个生产任务正在执行` : "流水线模板与执行记录已载入";
  byId("object-status").textContent = summary.executors === "--" ? "NO ACTIVE EXECUTOR" : summary.executors;
}

function renderSystemSummary(summary: SystemSummary): void {
  const values: Array<[string, string, string]> = [
    ["metric-one", "AI PROVIDERS", String(summary.providers)],
    ["metric-two", "MCP SERVERS", String(summary.servers)],
    ["metric-three", "CONNECTED", String(summary.connected)],
    ["metric-four", "SECRETS", "MASKED"],
    ["metric-five", "AGENT", "READY"],
  ];
  values.forEach(([valueId, label, value]) => { byId(`${valueId}-label`).textContent = label; byId(valueId).textContent = value; });
  byId("system-provider-count").textContent = String(summary.providers);
  byId("system-mcp-count").textContent = String(summary.servers);
  byId("system-connected-count").textContent = String(summary.connected);
  byId("system-sidebar-provider-count").textContent = String(summary.providers);
  byId("system-sidebar-mcp-count").textContent = String(summary.servers);
  byId("system-sidebar-connected-count").textContent = String(summary.connected);
  byId("system-sidebar-state").textContent = summary.connected ? "ONLINE" : "READY";
  byId("system-status-badge").textContent = summary.connected ? `${summary.connected} 已连接` : "READY";
  byId("system-status-badge").dataset.status = summary.connected ? "ok" : "idle";
}

function actionButton(label: string, action: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "command-button";
  button.textContent = label;
  button.addEventListener("click", action);
  return button;
}

function downloadJson(name: string, value: unknown): void {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
}

let canvas = byId<HTMLCanvasElement>("scene-canvas");
const loadingIndicator = byId("loading-indicator");
const controlsPanel = byId("controls-panel");

let surveyCards: SurveyCard[] = [];
let publicSurveyCards: SurveyCard[] = [];
let surveyFootprints: SurveyFootprintManifest | null = null;
let publicCatalogUnavailable = false;
let selectedSurvey: SurveyRecord | null = null;
let selectedLayerAssetId: string | null = null;
const localSurveyRecordsById = new Map<string, SurveyRecord>();
const publicSurveyRecordsById = new Map<string, SurveyRecord>();
let selectedLayerRegion: SurveyLayerSelection | null = null;
let dataAssets: DataAssetRecord[] = [];
let workspaceCapabilities: WorkspaceCapabilities | null = null;
let workspaceConnectors: ConnectorPublicRecord[] = [];
let visibleSurveyIds = new Set<string>();
let visibleAssetIds = new Set<string>();
let assetVisibilityPreferenceRestored = false;
const workspaceAssetLayers = new Map<string, WorkspaceCoverageLayer & { assetId: string; objectCount?: number; coverageStatus: WorkspaceAssetCoverageResponse["status"] }>();
const coverageStatusesByAsset = new Map<string, DataAssetOperationalStatusResponse>();
let legacyWorkspaceLayers: WorkspaceCoverageLayer[] = [];
const workspaceExtraLayers = new Map<string, WorkspaceCoverageLayer>();
const userMocArtifacts = new Map<string, UserMocArtifact>();
let visibleWorkspaceLayerKeys = new Set<string>();
let workspaceLayerVisibilityPreferenceRestored = false;
let hasUnassignedWorkspaceCoverage = false;
let unassignedWorkspaceVisible = false;
let remoteCoverageAssetId: string | null = null;
let layerOrder: string[] = [];
let layerLayoutMode: SurveyLayerLayoutMode = "layers";
let layerInteractionMode: SurveyLayerInteractionMode = "inspect";
let hoverDismissTimer: ReturnType<typeof setTimeout> | null = null;
let layerViewer: SurveyLayerViewer | null = null;
let overlapResponse: SkyOverlapResponse | null = null;
let overlapModeActive = false;
let overlapRequestGeneration = 0;
let aladinExplorer: AladinExplorer | null = null;
let aladinSnapshot: AladinExplorerSnapshot | null = null;
let latestAladinStatus: AladinExplorerStatus | null = null;
let aladinFullscreen = false;
let aladinAssetDrawerOpen = false;
let aladinEntryGeneration = 0;
let aladinEntryAbort: AbortController | null = null;
let mode: ViewMode = "layers";
let astroOverview: AstroOverviewResponse | null = null;
const workspaceCellSummaries = new Map<string, AstroSpatialSummary>();
const workspaceHoverRequests = new Set<string>();
const WORKSPACE_HOVER_QUERY_DELAY_MS = 120;
let workspaceHoverQueryTimer: ReturnType<typeof setTimeout> | null = null;
let workspaceHoverQueryGeneration = 0;
let activeWorkspaceHover: SurveyLayerHover | null = null;
let astroInspectionGeneration = 0;

const workflowPanel = new WorkflowPanel((error) => console.error("Workflow UI request failed", error));
const productionPanel = new ProductionPanel(
  (error) => console.error("Production UI request failed", error),
  renderProductionSummary,
  renderProductionInspector,
);
const systemPanel = new SystemPanel((error) => console.error("System settings UI request failed", error), renderSystemSummary);
const agentDock = new AgentDock((error) => console.error("Agent UI request failed", error));
let connectorSelectionRequest: string | null = null;
const dataCatalogPanel = new DataCatalogPanel((error) => notifyWorkspaceError(error, "用户资产操作失败"), (connectorId) => {
  connectorSelectionRequest = connectorId;
  void activateMode("connectors").catch(showFatal);
}, () => {
  void activateMode("connectors").then(() => byId<HTMLButtonElement>("connector-new").click()).catch(showFatal);
}, (scannedAssetId) => {
  return refreshWorkspaceAssets(scannedAssetId);
});
function renderConnectorMetrics(metrics: ConnectorMetrics): void {
  const values: Array<[string, string, number]> = [
    ["metric-one", "CONNECTORS", metrics.total],
    ["metric-two", "S3 / OSS", metrics.s3],
    ["metric-three", "LOCAL", metrics.local],
    ["metric-four", "JDBC", metrics.jdbc],
    ["metric-five", "SCANS", metrics.scans],
  ];
  values.forEach(([valueId, label, value]) => {
    byId(`${valueId}-label`).textContent = label;
    byId(valueId).textContent = formatInteger(value);
  });
}
const connectorPanel = new ConnectorPanel((error) => notifyWorkspaceError(error, "Connector 操作失败"), renderConnectorMetrics);

const coverageDownloadWatchers = new Set<string>();

function coverageDownloadTerminal(job: CoverageDownloadJob): boolean {
  return job.status === "completed" || job.status === "failed" || job.status === "cancelled";
}

async function refreshCoverageConsumers(): Promise<void> {
  const results = await Promise.allSettled([
    workspaceApi.connectors().then((connectors) => { workspaceConnectors = connectors; }),
    refreshWorkspaceAssets(),
    dataCatalogPanel.refresh(),
    connectorPanel.refresh(),
  ]);
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason));
  if (failures.length) {
    notifyWorkspace("下载结果已登记，但界面刷新不完整", failures.join("；"), { tone: "warning", dedupeMs: 5_000 });
  }
}

async function handleCoverageDownloadTerminal(job: CoverageDownloadJob): Promise<void> {
  if (job.status === "completed") {
    notifyWorkspace("重合来源下载已完成", `${job.downloadedFiles} 个文件 · 已登记 Connector ${job.outputConnectorId ?? ""}`.trim(), { tone: "success" });
    await refreshCoverageConsumers();
  } else if (job.status === "failed") {
    notifyWorkspace("重合来源下载失败", job.error ?? "下载或校验未完成", { tone: "error" });
  } else {
    notifyWorkspace("重合来源下载已取消", job.error ?? "已取消下载任务", { tone: "warning" });
  }
}

function watchCoverageDownload(id: string): void {
  if (coverageDownloadWatchers.has(id)) return;
  coverageDownloadWatchers.add(id);
  const poll = async (): Promise<void> => {
    try {
      const job = await workspaceApi.coverageDownload(id);
      if (coverageDownloadTerminal(job)) {
        coverageDownloadWatchers.delete(id);
        await handleCoverageDownloadTerminal(job);
        return;
      }
    } catch (error) {
      coverageDownloadWatchers.delete(id);
      notifyWorkspace("重合来源下载状态读取失败", error instanceof Error ? error.message : String(error), { tone: "warning", dedupeMs: 5_000 });
      return;
    }
    window.setTimeout(() => void poll(), 700);
  };
  void poll();
}

async function resumeCoverageDownloads(): Promise<void> {
  try {
    const jobs = await workspaceApi.coverageDownloads();
    jobs.filter((job) => job.status === "queued" || job.status === "running").forEach((job) => watchCoverageDownload(job.id));
  } catch (error) {
    console.warn("Unable to resume coverage download jobs", error);
  }
}

function surveyRegistrationFeedback(summary: string, detail = ""): void {
  if (summary === "尚未保存") return;
  notifyWorkspace(summary, detail, { tone: summary.includes("失败") ? "error" : summary.includes("正在") ? "info" : "warning" });
}

function selectedModalities(form: HTMLFormElement): SurveyModality[] {
  return [...(form.elements.namedItem("modalities") as HTMLSelectElement).selectedOptions]
    .map((option) => option.value as SurveyModality);
}

function surveyRegistrationInput(form: HTMLFormElement): SurveyRegistrationInput {
  const value = (name: string): string => String(new FormData(form).get(name) ?? "").trim();
  const modalities = selectedModalities(form);
  const productModality = value("productModality") as SurveyModality;
  const releaseModalities = [...new Set([...modalities, productModality])];
  return {
    id: value("id"),
    name: value("name"),
    mission: value("mission") || undefined,
    sourceUrl: value("sourceUrl"),
    description: value("description") || undefined,
    modalities: releaseModalities,
    releases: [{
      id: value("releaseId"),
      label: value("releaseLabel"),
      kind: "archive_snapshot",
      availability: "metadata_only",
      modalities: releaseModalities,
      products: [{ name: value("product"), modality: productModality, description: value("productDescription") }],
      coverage: { status: "pending", summary: "等待从已登记的数据源计算覆盖范围。", sourceUrl: value("sourceUrl") },
    }],
  };
}

function setupSurveyRegistration(): void {
  const dialog = byId<HTMLDialogElement>("survey-registration-dialog");
  const form = byId<HTMLFormElement>("survey-registration-form");
  const reset = () => { form.reset(); surveyRegistrationFeedback("尚未保存"); };
  const close = () => { reset(); if (dialog.open) dialog.close(); };
  byId<HTMLButtonElement>("catalog-new-survey").addEventListener("click", () => {
    const catalogDialog = byId<HTMLDialogElement>("catalog-create-dialog");
    if (catalogDialog.open) catalogDialog.close();
    reset();
    if (!dialog.open) dialog.showModal();
  });
  byId<HTMLButtonElement>("survey-registration-close").addEventListener("click", close);
  byId<HTMLButtonElement>("survey-registration-cancel").addEventListener("click", close);
  dialog.addEventListener("cancel", reset);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    if (!selectedModalities(form).length) { surveyRegistrationFeedback("请选择至少一种模态"); return; }
    surveyRegistrationFeedback("正在登记巡天…");
    void workspaceApi.registerSurvey(surveyRegistrationInput(form)).then((survey) => {
      notifyWorkspace("巡天标签已登记", survey.name, { tone: "success" });
      close();
      return activateMode("catalog").then(() => dataCatalogPanel.startNew(survey.id));
    }).catch((error) => surveyRegistrationFeedback("登记失败", error instanceof Error ? error.message : String(error)));
  });
}
setupSurveyRegistration();
const resourcePackagePanel = new ResourcePackagePanel(
  (before, after) => refreshActiveFootprints(before, after),
  (record, draftReleaseIds, callbacks) => renderResourcePackageDetails(record, draftReleaseIds, callbacks),
  (error) => notifyWorkspaceError(error, "资源包操作失败"),
  () => openResourceCatalogSettings(true),
);
let resourceAdminToken = "";
let resourceCatalogSyncPending = false;

function resourceCatalogSettingsFeedback(summary: string, detail = "", status: "" | "error" | "success" = ""): void {
  if (summary === "正在保存…") {
    notifyWorkspace("正在保存公开目录配置", detail, { tone: "info" });
  } else if (status === "error" || summary.includes("失败") || summary.includes("无法")) {
    notifyWorkspace(summary, detail, { tone: "error" });
  } else if (status === "success") {
    notifyWorkspace(summary, detail, { tone: "success" });
  } else if (summary) {
    notifyWorkspace(summary, detail, { tone: "info" });
  }
}

async function syncResourceCatalog(): Promise<void> {
  if (!resourceAdminToken) {
    openResourceCatalogSettings(true);
    return;
  }
  const syncButton = byId<HTMLButtonElement>("resource-package-sync");
  syncButton.disabled = true;
  syncButton.dataset.busy = "true";
  notifyWorkspace("正在同步公开目录…", "正在读取 Assets 公共 catalog", { tone: "info" });
  try {
    const result = await workspaceApi.syncResourceCatalog(resourceAdminToken);
    resourcePackagePanel.setCatalogStatus(result.catalog);
    await refreshPublicCatalogData();
    resourceCatalogSettingsFeedback("同步完成", `已载入 ${result.packages.length} 个可下载资源包。`, "success");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    resourceCatalogSettingsFeedback("同步失败", message, "error");
  } finally {
    syncButton.disabled = false;
    syncButton.dataset.busy = "false";
  }
}

function openResourceCatalogSettings(syncAfterSave = false): void {
  if (syncAfterSave && resourceAdminToken) {
    void syncResourceCatalog();
    return;
  }
  resourceCatalogSyncPending = syncAfterSave;
  const dialog = byId<HTMLDialogElement>("resource-catalog-settings-dialog");
  const form = byId<HTMLFormElement>("resource-catalog-settings-form");
    void workspaceApi.resourceCatalogConfig().then((config) => {
    byId<HTMLInputElement>("resource-catalog-url").value = config.catalogUrl;
    resourcePackagePanel.setCatalogStatus(config);
    resourceCatalogSettingsFeedback(config.available ? "当前目录可用" : "当前目录不可用", config.unavailableReason ?? "");
    }).catch((error) => {
      resourceCatalogSettingsFeedback("无法读取目录状态", error instanceof Error ? error.message : String(error), "error");
  });
  if (!dialog.open) dialog.showModal();
  (form.elements.namedItem("resource-catalog-admin-token") as HTMLInputElement | null)?.focus();
}

async function saveResourceCatalogConfig(andSync: boolean): Promise<void> {
  const catalogUrl = byId<HTMLInputElement>("resource-catalog-url").value.trim();
  const token = byId<HTMLInputElement>("resource-catalog-admin-token").value.trim() || resourceAdminToken;
  if (!token) throw new Error("请输入资源管理员 token");
  resourceCatalogSettingsFeedback("正在保存…");
  const config = await workspaceApi.setResourceCatalogConfig(catalogUrl, token);
  resourceAdminToken = token;
  resourcePackagePanel.setCatalogStatus(config);
  resourceCatalogSettingsFeedback("配置已保存", "不会自动下载资源包。", "success");
  if (andSync || resourceCatalogSyncPending) {
    resourceCatalogSyncPending = false;
    await syncResourceCatalog();
  } else {
    byId<HTMLDialogElement>("resource-catalog-settings-dialog").close();
  }
}

byId<HTMLButtonElement>("resource-package-settings").addEventListener("click", () => openResourceCatalogSettings(false));
byId<HTMLButtonElement>("resource-catalog-settings-close").addEventListener("click", () => byId<HTMLDialogElement>("resource-catalog-settings-dialog").close());
byId<HTMLButtonElement>("resource-catalog-settings-cancel").addEventListener("click", () => byId<HTMLDialogElement>("resource-catalog-settings-dialog").close());
byId<HTMLFormElement>("resource-catalog-settings-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void saveResourceCatalogConfig(false).catch((error) => resourceCatalogSettingsFeedback("保存失败", error instanceof Error ? error.message : String(error), "error"));
});
byId<HTMLButtonElement>("resource-catalog-settings-sync").addEventListener("click", () => {
  void saveResourceCatalogConfig(true).catch((error) => resourceCatalogSettingsFeedback("同步失败", error instanceof Error ? error.message : String(error), "error"));
});
byId<HTMLDialogElement>("resource-catalog-settings-dialog").addEventListener("cancel", () => { resourceCatalogSyncPending = false; });
const LAYER_PREFERENCES_KEY = "astro-workspace:survey-layer-preferences:v4";
const PREVIOUS_LAYER_PREFERENCES_KEY = "astro-workspace:survey-layer-preferences:v3";
const LEGACY_LAYER_PREFERENCES_KEY = "astro-workspace:survey-layer-preferences:v1";
const THEME_PREFERENCE_KEY = "astro-workspace:theme:v1";
const SCENE_BACKGROUND_PREFERENCE_KEY = "astro-workspace:scene-background:v1";
const ALADIN_SURVEY_PREFERENCE_KEY = "astro-workspace:aladin-image-survey:v1";
const ALADIN_IMAGE_SURVEYS = {
  dss2: { label: "DSS2", url: "https://alasky.cds.unistra.fr/DSS/DSSColor" },
  panstarrs: { label: "Pan-STARRS DR1", url: "https://alasky.cds.unistra.fr/Pan-STARRS/DR1/color-z-zg-g" },
  "2mass": { label: "2MASS", url: "https://alasky.cds.unistra.fr/2MASS/Color" },
  allwise: { label: "AllWISE", url: "https://alasky.cds.unistra.fr/AllWISE/RGB-W4-W2-W1" },
} as const;
type AladinImageSurveyId = keyof typeof ALADIN_IMAGE_SURVEYS;
type WorkspaceTheme = "light" | "dark";

createIcons({ icons: { ChevronLeft, ChevronRight, Download, Globe2, GripVertical, Info, Layers3, Maximize2, MessageSquare, Minimize2, Moon, Play, Plus, RefreshCw, RotateCcw, Send, Settings2, SlidersHorizontal, Sun, Undo2, X } });

const themeQuery = window.matchMedia("(prefers-color-scheme: dark)");
const themeToggle = byId<HTMLButtonElement>("theme-toggle");
const sceneBackgroundSettings = byId<HTMLButtonElement>("scene-background-settings");
const sceneBackgroundPopover = byId<HTMLDivElement>("scene-background-popover");
const sceneBackgroundColor = byId<HTMLInputElement>("scene-background-color");
const sceneBackgroundColorControls = byId<HTMLDivElement>("scene-background-color-controls");
const sceneImageSurveyControls = byId<HTMLDivElement>("scene-image-survey-controls");

function normalizedSceneBackground(value: string | null): string | null {
  return value && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : null;
}

function storedSceneBackground(): string | null {
  try {
    return normalizedSceneBackground(localStorage.getItem(SCENE_BACKGROUND_PREFERENCE_KEY));
  } catch {
    return null;
  }
}

function defaultSceneBackground(): string {
  return document.documentElement.dataset.theme === "light" ? "#aebbc1" : "#000000";
}

function applySceneBackground(color: string | null): void {
  layerViewer?.setBackgroundColor(color);
  sceneBackgroundColor.value = color ?? defaultSceneBackground();
  sceneBackgroundSettings.dataset.customized = color ? "true" : "false";
}

function storedAladinImageSurvey(): AladinImageSurveyId {
  try {
    const value = localStorage.getItem(ALADIN_SURVEY_PREFERENCE_KEY);
    if (value && value in ALADIN_IMAGE_SURVEYS) return value as AladinImageSurveyId;
  } catch {}
  return "2mass";
}

function renderSceneBackgroundControls(): void {
  const inAladin = Boolean(aladinExplorer || aladinSnapshot);
  sceneBackgroundColorControls.hidden = inAladin;
  sceneImageSurveyControls.hidden = !inAladin;
  byId("scene-background-title").textContent = inAladin ? "Aladin 天球底图" : "天球背景";
  const selected = storedAladinImageSurvey();
  sceneImageSurveyControls.querySelectorAll<HTMLButtonElement>("[data-aladin-survey]").forEach((button) => {
    const active = button.dataset.aladinSurvey === selected;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function applyAladinImageSurvey(id: AladinImageSurveyId): void {
  try { localStorage.setItem(ALADIN_SURVEY_PREFERENCE_KEY, id); } catch {}
  const survey = ALADIN_IMAGE_SURVEYS[id];
  aladinExplorer?.setImageSurvey(survey.url);
  const host = byId("aladin-explorer");
  host.dataset.imageSurveyId = id;
  host.dataset.imageSurvey = survey.url;
  renderSceneBackgroundControls();
}

function storedTheme(): WorkspaceTheme | null {
  try {
    const value = localStorage.getItem(THEME_PREFERENCE_KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

function applyTheme(theme: WorkspaceTheme, source: "initial" | "user" | "system"): void {
  document.documentElement.dataset.theme = theme;
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#080b0f" : "#f4f7f8");
  const target = theme === "dark" ? "light" : "dark";
  const targetLabel = target === "light" ? "浅色" : "深色";
  themeToggle.setAttribute("aria-label", `切换到${targetLabel}主题`);
  themeToggle.title = `切换到${targetLabel}主题`;
  themeToggle.replaceChildren();
  const icon = document.createElement("i");
  icon.dataset.lucide = target === "light" ? "sun" : "moon";
  themeToggle.append(icon);
  createIcons({ icons: { Moon, Sun }, attrs: { "aria-hidden": "true" } });
  layerViewer?.setTheme(theme);
  applySceneBackground(storedSceneBackground());
  window.dispatchEvent(new CustomEvent("astro:theme-change", { detail: { theme, source } }));
}

applyTheme((document.documentElement.dataset.theme === "light" ? "light" : "dark"), "initial");
themeToggle.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  try {
    localStorage.setItem(THEME_PREFERENCE_KEY, next);
  } catch {}
  applyTheme(next, "user");
});
themeQuery.addEventListener("change", (event) => {
  if (!storedTheme()) applyTheme(event.matches ? "dark" : "light", "system");
});

sceneBackgroundSettings.addEventListener("click", () => {
  sceneBackgroundPopover.hidden = !sceneBackgroundPopover.hidden;
  if (!sceneBackgroundPopover.hidden) {
    renderSceneBackgroundControls();
    if (aladinExplorer || aladinSnapshot) sceneImageSurveyControls.querySelector<HTMLButtonElement>(".active")?.focus();
    else sceneBackgroundColor.focus();
  }
});
byId<HTMLButtonElement>("scene-background-close").addEventListener("click", () => {
  sceneBackgroundPopover.hidden = true;
});
sceneBackgroundColor.addEventListener("input", () => {
  const color = normalizedSceneBackground(sceneBackgroundColor.value);
  if (!color) return;
  try { localStorage.setItem(SCENE_BACKGROUND_PREFERENCE_KEY, color); } catch {}
  applySceneBackground(color);
});
document.querySelectorAll<HTMLButtonElement>("[data-scene-background]").forEach((button) => {
  button.addEventListener("click", () => {
    const color = normalizedSceneBackground(button.dataset.sceneBackground ?? null);
    if (!color) return;
    try { localStorage.setItem(SCENE_BACKGROUND_PREFERENCE_KEY, color); } catch {}
    applySceneBackground(color);
  });
});
byId<HTMLButtonElement>("scene-background-reset").addEventListener("click", () => {
  try { localStorage.removeItem(SCENE_BACKGROUND_PREFERENCE_KEY); } catch {}
  applySceneBackground(null);
});
sceneImageSurveyControls.querySelectorAll<HTMLButtonElement>("[data-aladin-survey]").forEach((button) => {
  button.addEventListener("click", () => {
    const id = button.dataset.aladinSurvey;
    if (id && id in ALADIN_IMAGE_SURVEYS) applyAladinImageSurvey(id as AladinImageSurveyId);
  });
});
document.addEventListener("pointerdown", (event) => {
  if (sceneBackgroundPopover.hidden) return;
  const target = event.target;
  if (target instanceof Node && !sceneBackgroundPopover.contains(target) && !sceneBackgroundSettings.contains(target)) {
    sceneBackgroundPopover.hidden = true;
  }
});

function showFatal(error: unknown): void {
  console.error(error);
  notifyWorkspaceError(error, "Atlas 初始化/API 错误");
  byId("dataset-state").textContent = "载入失败";
  byId("service-status").textContent = "SERVICE ERROR";
  loadingIndicator.classList.remove("visible", "error");
}

function freshCanvas(): HTMLCanvasElement {
  const replacement = document.createElement("canvas");
  replacement.id = canvas.id;
  replacement.className = canvas.className;
  canvas.replaceWith(replacement);
  canvas = replacement;
  return replacement;
}

function cancelAladinEntry(): void {
  aladinEntryGeneration += 1;
  aladinEntryAbort?.abort();
  aladinEntryAbort = null;
}

function renderAladinAssetDrawerState(): void {
  const controls = byId("aladin-controls");
  const rail = byId("aladin-cockpit-rail");
  const toggle = byId<HTMLButtonElement>("aladin-asset-drawer-toggle");
  controls.dataset.assetDrawer = aladinAssetDrawerOpen ? "open" : "closed";
  rail.classList.toggle("is-open", aladinAssetDrawerOpen);
  toggle.setAttribute("aria-expanded", String(aladinAssetDrawerOpen));
  toggle.setAttribute("aria-label", aladinAssetDrawerOpen ? "收起用户资产抽屉" : "展开用户资产抽屉");
  toggle.title = aladinAssetDrawerOpen ? "收起用户资产抽屉" : "展开用户资产抽屉";
  toggle.replaceChildren();
  const toggleIcon = document.createElement("i");
  toggleIcon.dataset.lucide = aladinAssetDrawerOpen ? "chevron-left" : "chevron-right";
  const toggleLabel = document.createElement("span");
  toggleLabel.textContent = "资产";
  toggle.append(toggleIcon, toggleLabel);
  createIcons({ icons: { ChevronLeft, ChevronRight }, attrs: { "aria-hidden": "true" } });
}

function setAladinAssetDrawer(open: boolean): void {
  aladinAssetDrawerOpen = open;
  renderAladinAssetDrawerState();
}

function pushAladinToast(message: string, tone: "info" | "success" | "error" = "info"): void {
  notifyWorkspace(message, "Aladin 对象探索", { tone: tone === "error" ? "error" : tone === "success" ? "success" : "info" });
}

function destroyViewer(): void {
  layerViewer?.dispose();
  aladinExplorer?.dispose();
  cancelAladinEntry();
  layerViewer = null;
  aladinExplorer = null;
  aladinSnapshot = null;
  latestAladinStatus = null;
  aladinAssetDrawerOpen = false;
  byId("aladin-explorer").hidden = true;
  byId("aladin-controls").hidden = true;
  byId("aladin-asset-nav").replaceChildren();
  byId("scene-stage").classList.remove("aladin-active");
  byId("scene-coordinate-readout").hidden = true;
  byId("scene-camera-readout").hidden = false;
  byId("inspector-panel").classList.remove("aladin-object-selected");
  delete byId("inspector-panel").dataset.objectId;
  renderAladinFullscreenState();
  renderAladinAssetDrawerState();
  renderSurveyHover(null);
}

function localOnlySurveyIds(assetIds: Iterable<string> = visibleAssetIds): Set<string> {
  const selectedAssets = new Set(assetIds);
  return new Set(
    userDataAssets()
      .filter((asset) => selectedAssets.has(asset.id))
      .flatMap((asset) => {
        const surveyId = asset.surveyId;
        return surveyId ? [surveyId] : [];
      })
      .filter((surveyId) => footprintsForSurvey(surveyId).length === 0),
  );
}

function explorationSurveyIds(ids: Iterable<string> = visibleSurveyIds, assetIds: Iterable<string> = visibleAssetIds): string[] {
  const localOnlyIds = localOnlySurveyIds(assetIds);
  return [...new Set(ids)]
    .filter((surveyId) => surveyId !== "__unassigned__" && !localOnlyIds.has(surveyId) && footprintsForSurvey(surveyId).length > 0)
    .sort();
}

function selectionSurveyIds(selection: SurveyLayerSelection): string[] {
  const localOnlyIds = localOnlySurveyIds(selection.assetIds);
  return [...new Set(selection.surveyIds)]
    .filter((surveyId) => !localOnlyIds.has(surveyId) && footprintsForSurvey(surveyId).length > 0)
    .sort();
}

type SkyRegionMenu = { clientX: number; clientY: number; nside: number; pixels: number[]; surveyIds: string[]; releaseIds?: string[]; assetIds: string[]; componentId?: string };

function sameSkyPixels(nside: number, pixels: readonly number[], selection: SurveyLayerSelection | null): boolean {
  if (!selection || selection.nside !== nside) return false;
  const left = [...new Set(pixels)].sort((a, b) => a - b);
  const right = [...new Set(selection.pixels)].sort((a, b) => a - b);
  return left.length === right.length && left.every((pixel, index) => pixel === right[index]);
}

function aladinCenterForRegion(nside: number, pixels: readonly number[]): { raDeg: number; decDeg: number } {
  if (sameSkyPixels(nside, pixels, selectedLayerRegion)) {
    return { raDeg: selectedLayerRegion!.centerRaDeg, decDeg: selectedLayerRegion!.centerDecDeg };
  }
  try {
    const healpix = new Healpix(nside);
    const sum = { x: 0, y: 0, z: 0 };
    pixels.forEach((pixel) => {
      const raw = healpix.pix2vec(pixel);
      sum.x += -raw.y;
      sum.y += raw.z;
      sum.z += -raw.x;
    });
    const center = cartesianToRaDec(sum);
    return { raDeg: center.raDeg, decDeg: center.decDeg };
  } catch {
    return { raDeg: 0, decDeg: 0 };
  }
}

interface AladinAssetProfile {
  target: AladinAssetTarget;
  records: AstroObjectRecord[];
  total: number;
  truncated: boolean;
}

const ALADIN_PROFILE_LIMIT = 1000;

function angularDistanceDeg(left: { x: number; y: number; z: number }, right: { x: number; y: number; z: number }): number {
  const leftLength = Math.hypot(left.x, left.y, left.z);
  const rightLength = Math.hypot(right.x, right.y, right.z);
  if (!leftLength || !rightLength) return 0;
  const dot = (left.x * right.x + left.y * right.y + left.z * right.z) / (leftLength * rightLength);
  return (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
}

async function queryAladinAssetProfile(asset: DataAssetRecord, menu: SkyRegionMenu, signal: AbortSignal): Promise<AladinAssetProfile | null> {
  const region = nestedSkyRegion(menu.nside, menu.pixels);
  const result = await workspaceApi.skyObjectsQuery({
    region,
    coordinateFrame: region.coordinateFrame,
    ordering: region.ordering,
    assetIds: [asset.id],
    limit: ALADIN_PROFILE_LIMIT,
    includeAttributes: false,
  }, signal);
  const records = result.status === "ready"
    ? result.objects.filter((record) => Number.isFinite(record.ra_deg) && Number.isFinite(record.dec_deg))
    : [];
  const fallbackCenter = aladinCenterForRegion(menu.nside, menu.pixels);
  const fallbackRadius = sameSkyPixels(menu.nside, menu.pixels, selectedLayerRegion)
    ? selectedLayerRegion!.angularRadiusDeg
    : 1.5;
  const layer = displayLayerFor({ assetId: asset.id, key: asset.id });
  if (!records.length) {
    return {
      target: {
        assetId: asset.id,
        label: layer.label,
        color: layer.color,
        centerRaDeg: fallbackCenter.raDeg,
        centerDecDeg: fallbackCenter.decDeg,
        defaultFovDeg: Math.max(2, Math.min(16, fallbackRadius * 2.6)),
        objectCount: result.status === "ready" ? result.total : 0,
        returned: 0,
      },
      records: [],
      total: result.status === "ready" ? result.total : 0,
      truncated: false,
    };
  }
  const sum = records.reduce((point, record) => {
    const vector = raDecToCartesian(record.ra_deg, record.dec_deg);
    point.x += vector.x;
    point.y += vector.y;
    point.z += vector.z;
    return point;
  }, { x: 0, y: 0, z: 0 });
  const center = cartesianToRaDec(sum);
  const centerVector = raDecToCartesian(center.raDeg, center.decDeg);
  const radiusDeg = Math.max(...records.map((record) => angularDistanceDeg(centerVector, raDecToCartesian(record.ra_deg, record.dec_deg))));
  return {
    target: {
      assetId: asset.id,
      label: layer.label,
      color: layer.color,
      centerRaDeg: center.raDeg,
      centerDecDeg: center.decDeg,
      defaultFovDeg: Math.max(0.8, Math.min(12, radiusDeg * 2.2 + 0.8)),
      objectCount: result.total,
      returned: records.length,
    },
    records,
    total: result.total,
    truncated: Boolean(result.nextCursor?.length || result.searchAfter?.length || result.total > records.length),
  };
}

function renderAladinAssetNavigation(targets: readonly AladinAssetTarget[], activeAssetId: string | null): void {
  const nav = byId("aladin-asset-nav");
  nav.replaceChildren();
  if (!targets.length) {
    const empty = document.createElement("span");
    empty.className = "aladin-asset-nav-empty";
    empty.textContent = "当前视野暂无对象资产";
    nav.append(empty);
    return;
  }
  const addButton = (assetId: string | null, label: string, detail?: string): void => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "aladin-asset-button";
    button.classList.toggle("active", activeAssetId === assetId);
    button.dataset.assetId = assetId ?? "all";
    const target = assetId ? targets.find((candidate) => candidate.assetId === assetId) : undefined;
    if (target) button.style.setProperty("--asset-color", target.color);
    const title = document.createElement("strong");
    title.textContent = label;
    button.append(title);
    const progress = latestAladinStatus?.assets?.find((asset) => asset.assetId === assetId);
    if (detail) {
      const meta = document.createElement("small");
      meta.textContent = progress
        ? `${formatInteger(progress.returned)} / ${formatInteger(progress.total)} OBJECTS · ${progress.cacheState.toUpperCase()}`
        : detail;
      button.append(meta);
    }
    if (assetId) {
      const track = document.createElement("span");
      track.className = "aladin-asset-progress";
      const bar = document.createElement("i");
      const ratio = progress?.total ? Math.min(1, progress.returned / progress.total) : 0;
      bar.style.width = `${ratio * 100}%`;
      track.append(bar);
      button.append(track);
    }
    button.addEventListener("click", () => {
      setAladinAssetDrawer(true);
      aladinExplorer?.focusAsset(assetId);
    });
    nav.append(button);
  };
  if (targets.length > 1) {
    const returned = latestAladinStatus?.returned ?? 0;
    const total = latestAladinStatus?.total ?? targets.reduce((sum, target) => sum + (target.objectCount ?? 0), 0);
    addButton(null, "全部用户资产", `${formatInteger(returned)} / ${formatInteger(total)} OBJECTS`);
  }
  targets.forEach((target) => addButton(target.assetId, target.label, `${formatInteger(target.objectCount ?? target.returned ?? 0)} OBJECTS · FOV ${target.defaultFovDeg.toFixed(1)}°`));
}

function syncAladinView(): void {
  if (!aladinExplorer) return;
  const view = aladinExplorer.getView();
  const host = byId("aladin-explorer");
  host.dataset.raDeg = view.raDeg.toFixed(6);
  host.dataset.decDeg = view.decDeg.toFixed(6);
  host.dataset.fovDeg = view.fovDeg.toFixed(4);
  canvas.dataset.aladinRa = host.dataset.raDeg;
  canvas.dataset.aladinDec = host.dataset.decDeg;
  canvas.dataset.aladinFov = host.dataset.fovDeg;
  byId("scene-coordinate-readout").textContent = `RA ${view.raDeg.toFixed(4)} · DEC ${view.decDeg.toFixed(4)} · FOV ${view.fovDeg.toFixed(3)}°`;
}

function renderAladinFullscreenState(): void {
  const stage = byId("scene-stage");
  const button = byId<HTMLButtonElement>("aladin-fullscreen");
  aladinFullscreen = document.fullscreenElement === stage;
  button.hidden = !aladinExplorer;
  button.setAttribute("aria-label", aladinFullscreen ? "退出全屏" : "进入全屏");
  button.title = aladinFullscreen ? "退出全屏" : "进入全屏";
  button.replaceChildren();
  const icon = document.createElement("i");
  icon.dataset.lucide = aladinFullscreen ? "minimize-2" : "maximize-2";
  button.append(icon);
  createIcons({ icons: { Maximize2, Minimize2 }, attrs: { "aria-hidden": "true" } });
  stage.dataset.fullscreen = String(aladinFullscreen);
}

async function toggleAladinFullscreen(): Promise<void> {
  if (!aladinExplorer) return;
  const stage = byId("scene-stage");
  try {
    if (document.fullscreenElement === stage) await document.exitFullscreen();
    else if (stage.requestFullscreen) await stage.requestFullscreen();
  } catch (error) {
    console.warn("Fullscreen is unavailable", error);
  }
}

function renderAladinStatus(status: AladinExplorerStatus): void {
  latestAladinStatus = status;
  const host = byId("aladin-explorer");
  const phaseLabel: Record<typeof status.phase, string> = {
    initializing: "初始化 Aladin",
    loading: status.total > 0
      ? `已加载 ${formatInteger(status.returned)} / ${formatInteger(status.total)} 个对象`
      : `已加载 ${formatInteger(status.returned)} 个对象`,
    ready: `${formatInteger(status.returned)} 个对象`,
    empty: "当前视野没有对象",
    error: `对象查询失败：${status.message ?? "未知错误"}`,
  };
  const selectionEmpty = status.phase === "empty" && status.message?.includes("当前选区没有可探索的用户资产");
  if (status.phase === "initializing") notifyWorkspace("Aladin 正在初始化", "对象探索视图正在准备", { tone: "info" });
  else if (status.phase === "loading") notifyWorkspace("Aladin 正在加载对象", phaseLabel.loading, { tone: "info" });
  else if (status.phase === "error") pushAladinToast(status.message ?? "对象查询失败", "error");
  else if (status.phase === "ready" && status.complete) pushAladinToast(`${formatInteger(status.returned)} 个对象已载入`, "success");
  else if (status.phase === "empty" && !selectionEmpty) pushAladinToast(status.message ?? "当前视野暂无对象", "info");
  else if (status.message && !selectionEmpty) pushAladinToast(status.message, "info");
  host.dataset.queryPhase = status.phase;
  host.dataset.objectReturned = String(status.returned);
  host.dataset.objectTotal = String(status.total);
  host.dataset.objectTruncated = String(status.truncated);
  host.dataset.objectComplete = String(status.complete ?? (status.phase === "ready" || status.phase === "empty" || status.phase === "error"));
  byId("render-status").textContent = "ALADIN LITE";
  byId("object-status").textContent = status.phase === "loading"
    ? `${formatInteger(status.returned)} / ${formatInteger(status.total)} OBJECTS · LOADING`
    : status.phase === "empty"
      ? selectionEmpty ? "NO OBJECT CATALOG" : "NO OBJECTS IN VIEW"
      : `${formatInteger(status.returned)} / ${formatInteger(status.total)} OBJECTS`;
  byId("layer-selection-count").textContent = `${formatInteger(status.returned)} OBJECTS`;
  const loadedSummary = byId<HTMLOutputElement>("aladin-loaded-summary");
  loadedSummary.textContent = `${formatInteger(status.returned)} / ${formatInteger(status.total)} OBJECTS`;
  byId("aladin-cache-state").textContent = status.assets?.some((asset) => asset.cacheState === "cached") ? "CACHE RETAINED" : status.phase === "loading" ? "FETCHING NEW SKY" : "CACHE READY";
  if (aladinSnapshot) renderAladinAssetNavigation(aladinSnapshot.assetTargets, aladinExplorer?.getActiveAssetId() ?? null);
  syncAladinView();
}

async function enterAladinExplorer(menu: SkyRegionMenu): Promise<void> {
  const pixels = [...new Set(menu.pixels)].filter((pixel) => Number.isInteger(pixel)).sort((a, b) => a - b);
  if (menu.nside !== 16 || !pixels.length) return;

  const generation = ++aladinEntryGeneration;
  aladinEntryAbort?.abort();
  const profileAbort = new AbortController();
  aladinEntryAbort = profileAbort;
  aladinExplorer?.dispose();
  aladinExplorer = null;
  aladinSnapshot = null;
  latestAladinStatus = null;
  aladinAssetDrawerOpen = true;
  layerViewer?.dispose();
  layerViewer = null;

  const selectedCandidates = userDataAssets().filter((asset) => menu.assetIds.includes(asset.id));
  const candidates = selectedCandidates;
  notifyWorkspace(candidates.length ? "正在读取视野对象" : "当前没有可探索的用户资产", candidates.length ? `${candidates.length} 个用户资产` : "请先登记并扫描用户资产", { tone: candidates.length ? "info" : "warning" });
  const settled = await Promise.allSettled(candidates.map((asset) => queryAladinAssetProfile(asset, { ...menu, pixels }, profileAbort.signal)));
  if (generation !== aladinEntryGeneration || profileAbort.signal.aborted) return;
  const fallbackProfile = (asset: DataAssetRecord): AladinAssetProfile => {
    const center = aladinCenterForRegion(menu.nside, pixels);
    const layer = displayLayerFor({ assetId: asset.id, key: asset.id });
    return {
      target: {
        assetId: asset.id,
        label: layer.label,
        color: layer.color,
        centerRaDeg: center.raDeg,
        centerDecDeg: center.decDeg,
        defaultFovDeg: 4,
        objectCount: 0,
        returned: 0,
      },
      records: [],
      total: 0,
      truncated: false,
    };
  };
  const profiles = settled.flatMap((result, index) => result.status === "fulfilled" && result.value
    ? [result.value]
    : candidates[index] ? [fallbackProfile(candidates[index]!)] : []);
  const targets = profiles.map((profile) => profile.target);
  const initialTarget = targets[0];
  const fallbackCenter = aladinCenterForRegion(menu.nside, pixels);
  const selectedRadius = sameSkyPixels(menu.nside, pixels, selectedLayerRegion)
    ? selectedLayerRegion!.angularRadiusDeg
    : 1.5;
  const initialFovDeg = initialTarget?.defaultFovDeg ?? Math.max(4, Math.min(12, Math.max(3, selectedRadius * 2.6)));
  const assetIds = targets.map((target) => target.assetId);
  const imageSurveyId = storedAladinImageSurvey();
  const snapshot: AladinExplorerSnapshot = {
    nside: menu.nside,
    pixels,
    filters: { assetIds },
    sourceKeys: assetIds.map((assetId) => `asset:${assetId}`),
    assetTargets: targets,
    initialAssetId: initialTarget?.assetId,
    centerRaDeg: initialTarget?.centerRaDeg ?? fallbackCenter.raDeg,
    centerDecDeg: initialTarget?.centerDecDeg ?? fallbackCenter.decDeg,
    initialFovDeg,
    imageSurveyUrl: ALADIN_IMAGE_SURVEYS[imageSurveyId].url,
  };
  aladinSnapshot = snapshot;
  mode = "layers";
  canvas.hidden = true;
  canvas.dataset.sceneKind = "aladin";
  canvas.dataset.aladinPixels = pixels.join(",");
  canvas.dataset.aladinSourceKeys = snapshot.sourceKeys.join(",");
  const host = byId("aladin-explorer");
  byId("scene-stage").classList.add("aladin-active");
  host.hidden = false;
  host.dataset.sceneKind = "aladin";
  host.dataset.nside = String(snapshot.nside);
  host.dataset.pixels = pixels.join(",");
  host.dataset.sourceKeys = snapshot.sourceKeys.join(",");
  host.dataset.centerRaDeg = snapshot.centerRaDeg.toFixed(6);
  host.dataset.centerDecDeg = snapshot.centerDecDeg.toFixed(6);
  host.dataset.initialFovDeg = initialFovDeg.toFixed(4);
  host.dataset.assetIds = assetIds.join(",");
  host.dataset.imageSurveyId = imageSurveyId;
  host.dataset.imageSurvey = snapshot.imageSurveyUrl;
  host.dataset.coverageSourceKeys = [...new Set(menu.surveyIds.map((surveyId) => `public-survey:${surveyId}`))].join(",");
  byId("aladin-controls").hidden = false;
  renderAladinFullscreenState();
  renderAladinAssetNavigation(targets, snapshot.initialAssetId ?? null);
  byId("scene-legend").hidden = true;
  byId("region-scene-legend").hidden = true;
  byId("coverage-hover").hidden = true;
  byId("scene-badge").textContent = "ALADIN LITE";
  byId("scene-mode-label").textContent = "OBJECT EXPLORE";
  byId("scene-mode-value").textContent = "ALT/AZ";
  byId("scene-frame-label").textContent = "ALT/AZ";
  byId("scene-coordinate-readout").hidden = false;
  byId("scene-camera-readout").hidden = true;
  byId("object-status").textContent = "INITIALIZING ALADIN";
  byId<HTMLButtonElement>("drill-back-button").disabled = false;
  byId<HTMLButtonElement>("drill-back-button").setAttribute("aria-label", "返回天球范围探查");
  byId<HTMLButtonElement>("drill-back-button").title = "返回天球范围探查";
  renderAladinAssetDrawerState();
  closeSkyContextMenu();
  renderSurveyHover(null);

  aladinEntryAbort = null;
  const initialRecords = new Map(profiles.map((profile) => [profile.target.assetId, {
    records: profile.records,
    total: profile.total,
    truncated: profile.truncated,
  }]));
  aladinExplorer = new AladinExplorer(host, snapshot, {
    resolveLayer: (record) => {
      const layer = displayLayerFor({
        assetId: record.asset_id,
        surveyId: record.survey,
        releaseId: record.release,
        product: record.product,
        modality: record.modality,
        key: record.object_id,
      });
      return { key: layer.id, label: layer.label, color: layer.color };
    },
    onObject: (point) => {
      if (point) renderSurveyObjectPoint(point);
      else {
        byId("inspector-panel").classList.remove("aladin-object-selected");
        delete byId("inspector-panel").dataset.objectId;
        inspectorRows("", []);
      }
    },
    onStatus: renderAladinStatus,
    initialRecords,
    onAssetChange: (assetId) => renderAladinAssetNavigation(targets, assetId),
    onViewChange: () => syncAladinView(),
  });
  renderAladinFullscreenState();
  syncAladinView();
  void aladinExplorer.ready.then(() => {
    if (aladinExplorer) syncAladinView();
  }).catch((error) => {
    renderAladinStatus({ phase: "error", returned: 0, total: 0, truncated: false, message: error instanceof Error ? error.message : String(error) });
  });
}

async function leaveAladinExplorer(): Promise<void> {
  if (!aladinExplorer && !aladinSnapshot && !aladinEntryAbort) return;
  cancelAladinEntry();
  const stage = byId("scene-stage");
  if (document.fullscreenElement === stage) await document.exitFullscreen().catch(() => undefined);
  aladinExplorer?.dispose();
  aladinExplorer = null;
  aladinSnapshot = null;
  latestAladinStatus = null;
  aladinAssetDrawerOpen = false;
  byId("aladin-explorer").hidden = true;
  byId("aladin-controls").hidden = true;
  renderAladinFullscreenState();
  renderAladinAssetDrawerState();
  byId("aladin-asset-nav").replaceChildren();
  byId("aladin-loaded-summary").textContent = "--";
  byId("aladin-cache-state").textContent = "CACHE IDLE";
  canvas.hidden = false;
  delete canvas.dataset.aladinPixels;
  delete canvas.dataset.aladinSourceKeys;
  closeSkyContextMenu();
  selectedLayerRegion = null;
  selectedSurvey = null;
  selectedLayerAssetId = null;
  inspectorRows("", []);
  await activateMode("layers");
}

function renderSurveyContextMenu(menu: SkyRegionMenu): void {
  const contextMenu = byId("coverage-context-menu");
  const enter = byId<HTMLButtonElement>("coverage-enter-flat");
  const buildDownload = byId<HTMLButtonElement>("coverage-build-download");
  const buildCrossmatch = byId<HTMLButtonElement>("coverage-build-crossmatch");
  const stage = byId("scene-stage").getBoundingClientRect();
  cancelWorkspaceHoverQuery();
  activeWorkspaceHover = null;
  if (hoverDismissTimer) clearTimeout(hoverDismissTimer);
  hoverDismissTimer = null;
  const hover = byId("coverage-hover");
  hover.hidden = true;
  hover.replaceChildren();
  contextMenu.style.visibility = "hidden";
  contextMenu.hidden = false;
  contextMenu.classList.add("visible");
  const menuBounds = contextMenu.getBoundingClientRect();
  const maximumLeft = Math.max(8, stage.width - menuBounds.width - 8);
  const maximumTop = Math.max(8, stage.height - menuBounds.height - 8);
  contextMenu.style.left = `${Math.max(8, Math.min(menu.clientX - stage.left, maximumLeft))}px`;
  contextMenu.style.top = `${Math.max(8, Math.min(menu.clientY - stage.top, maximumTop))}px`;
  contextMenu.style.visibility = "";
  enter.onclick = () => {
    contextMenu.hidden = true;
    contextMenu.classList.remove("visible");
    void enterAladinExplorer(menu).catch(showFatal);
  };
  const selectedComponent = menu.componentId ? overlapResponse?.components.find((candidate) => candidate.id === menu.componentId) : undefined;
  const context: ProductionContext = { nside: menu.nside, pixels: selectedComponent?.cells ?? menu.pixels, sourceIds: selectedComponent?.sourceIds ?? [...menu.surveyIds.map((id) => `public:${id}`), ...menu.assetIds.map((id) => `workspace:asset:${id}`)], componentId: menu.componentId, assetIds: menu.assetIds };
  const crossmatchableAssets = menu.assetIds.filter((assetId) => {
    const asset = dataAssets.find((candidate) => candidate.id === assetId);
    return asset?.kind === "catalog" && Boolean(asset.scanSpec?.raColumn && asset.scanSpec?.decColumn && asset.scanSpec?.objectIdColumn);
  });
  buildCrossmatch.disabled = crossmatchableAssets.length < 2;
  buildCrossmatch.title = buildCrossmatch.disabled ? "需要两个已建立 RA / Dec 对象索引的 catalog 资产" : "构建对象交叉匹配任务";
  buildDownload.onclick = () => {
    closeSkyContextMenu();
    productionPanel.setContext(context);
    void activateMode("workflow").catch(showFatal);
  };
  buildCrossmatch.onclick = () => {
    closeSkyContextMenu();
    productionPanel.setContext(context, "object-crossmatch@1");
    void activateMode("workflow").catch(showFatal);
  };
}

function closeSkyContextMenu(): void {
  const contextMenu = byId("coverage-context-menu");
  contextMenu.hidden = true;
  contextMenu.classList.remove("visible");
}

function setActiveButtons(selector: string, predicate: (button: HTMLButtonElement) => boolean): void {
  document.querySelectorAll<HTMLButtonElement>(selector).forEach((button) => button.classList.toggle("active", predicate(button)));
}

function renderLayerState(state: SurveyLayerState): void {
  canvas.dataset.cameraDistance = state.cameraDistance.toFixed(6);
  canvas.dataset.cameraPosition = state.cameraPosition.map((value) => value.toFixed(6)).join(",");
  canvas.dataset.outerRadius = state.outerRadius.toFixed(6);
  canvas.dataset.mode = "layers";
  canvas.dataset.layoutMode = state.layoutMode;
  canvas.dataset.interactionMode = state.interactionMode;
  canvas.dataset.visibleSurveyIds = state.visibleSurveyIds.join(",");
  canvas.dataset.visibleAssetIds = state.visibleAssetIds.join(",");
  canvas.dataset.visibleWorkspaceLayerKeys = state.visibleWorkspaceLayerKeys.join(",");
  canvas.dataset.layerOrder = state.layerOrder.join(",");
  canvas.dataset.layerDepths = JSON.stringify(state.layerDepths);
  canvas.dataset.selectedPixels = state.selectedPixels.join(",");
  if (state.explodedPixel !== null) {
    canvas.dataset.explodedPixel = String(state.explodedPixel);
    canvas.dataset.explodedLayerCount = String(state.explodedLayerCount);
  } else {
    delete canvas.dataset.explodedPixel;
    delete canvas.dataset.explodedLayerCount;
  }
  if (state.selectionAnchor) {
    canvas.dataset.selectionBounds = [
      state.selectionAnchor.bounds.leftRatio,
      state.selectionAnchor.bounds.rightRatio,
      state.selectionAnchor.bounds.topRatio,
      state.selectionAnchor.bounds.bottomRatio,
    ].map((value) => value.toFixed(4)).join(",");
  } else delete canvas.dataset.selectionBounds;
  byId("camera-distance").textContent = `${state.cameraDistance.toFixed(2)} R`;
  const visibleSources = state.visibleSurveyIds.length + state.visibleAssetIds.length + state.visibleWorkspaceLayerKeys.length;
  byId("layer-visible-output").textContent = `${visibleSources} SOURCES · ${formatInteger(state.visibleCellCount)} CELLS`;
  renderRegionSceneLegend(state);
  byId("legend-min").textContent = state.layoutMode === "layers" ? "图层内侧" : "1 SURVEY";
  byId("legend-max").textContent = state.layoutMode === "layers" ? "图层外侧" : "MOST OVERLAP";
  byId("scene-frame-label").textContent = "ICRS";
  byId("scene-mode-value").textContent = overlapModeActive ? "G · OVERLAP" : "PUBLIC + OWNED";
  byId("scene-badge").textContent = overlapModeActive ? "天区重合" : state.selectedCellCount ? `${state.selectedCellCount} 个已选区块` : "天球概览";
  byId("layer-selection-count").textContent = state.selectedCellCount ? `${state.selectedCellCount} CELLS` : "NO CELL";
  byId("object-status").textContent = `${formatInteger(state.occupiedCellCount)} COVERAGE CELLS`;
  const backButton = byId<HTMLButtonElement>("drill-back-button");
  backButton.disabled = true;
  backButton.setAttribute("aria-label", "返回上一级天区");
  backButton.title = "返回上一级天区";
}

function renderOverlapSummary(result: SkyOverlapResponse): void {
  const sourceLabels = (result.sources ?? []).map((source) => source.label).join(" / ") || "当前可见来源";
  inspectorRows("G · 天区重合", [
    ["来源", sourceLabels],
    ["参与来源", formatInteger(result.sourceIds.length)],
    ["重合区块", formatInteger(result.components.length)],
    ["HEALPix 单元", formatInteger(result.pixels.length)],
    ["状态", result.status === "ready" ? "已计算" : "没有共同覆盖"],
  ]);
}

function overlapSourceIdsForState(state: SurveyLayerState): string[] {
  const ids = new Set<string>();
  (surveyFootprints?.footprints ?? [])
    .filter((footprint) => footprint.nside === state.nside && state.visibleSurveyIds.includes(footprint.surveyId))
    .forEach((footprint) => ids.add(`public:${footprint.surveyId}:${footprint.releaseId}:${footprint.product}`));
  state.visibleAssetIds.forEach((assetId) => ids.add(`workspace:asset:${assetId}`));
  state.visibleWorkspaceLayerKeys.forEach((key) => {
    if (key.startsWith("warehouse:")) ids.add(`workspace:warehouse:${key.slice("warehouse:".length)}`);
    else if (key.startsWith("moc:")) ids.add(`workspace:moc:${key.slice("moc:".length)}`);
  });
  return [...ids].sort();
}

function renderOverlapComponent(component: SurveyLayerOverlapComponent): void {
  const selected = overlapResponse?.components.find((candidate) => candidate.id === component.id) ?? component;
  layerViewer?.setActiveOverlapComponent(selected.id);
  const sourceIds = selected.sourceIds ?? overlapResponse?.sourceIds ?? [];
  const sourceLabels = (overlapResponse?.sources ?? [])
    .filter((source) => sourceIds.includes(source.id))
    .map((source) => source.label)
    .join(" / ") || sourceIds.join(" / ") || "--";
  const rows: Array<[string, string]> = [
    ["模式", "G · 天区重合"],
    ["区块", selected.id],
    ["HEALPix 单元", formatInteger(selected.cells.length)],
    ["来源", sourceLabels],
    ...(selected.areaDeg2 === undefined ? [] : [["面积", `${selected.areaDeg2.toFixed(3)} deg²`] as [string, string]]),
    ["反查", "正在读取来源文件…"],
  ];
  inspectorRows(`重合区块 ${selected.id}`, rows);
  void workspaceApi.skyReverseLookup({ componentId: selected.id, sourceIds, nside: overlapResponse?.nside ?? 16 })
    .then((lookup) => {
      if (!overlapModeActive) return;
      const actions: HTMLButtonElement[] = [];
      if (lookup.files.length) {
        const download = actionButton(`构建数据下载任务（${lookup.files.length}）`, () => {
          productionPanel.setContext({ nside: overlapResponse?.nside ?? 16, pixels: selected.cells, sourceIds, componentId: selected.id, files: lookup.files });
          void activateMode("workflow").catch(showFatal);
        });
        actions.push(download);
      }
      inspectorRows(`重合区块 ${selected.id}`, [
        ["模式", "G · 天区重合"],
        ["区块", selected.id],
        ["HEALPix 单元", formatInteger(selected.cells.length)],
        ["来源", sourceLabels],
        ...(selected.areaDeg2 === undefined ? [] : [["面积", `${selected.areaDeg2.toFixed(3)} deg²`] as [string, string]]),
        ["反查文件", lookup.files.length ? `${lookup.files.length} 个可下载文件` : "未找到可下载文件"],
        ...(lookup.unavailable.length ? [["不可下载", lookup.unavailable.map((entry) => entry.reason).join("；")] as [string, string]] : []),
        ...(lookup.warnings?.length ? [["提示", lookup.warnings.join("；")] as [string, string]] : []),
      ], actions);
    })
    .catch((error) => notifyWorkspace("重合区块反查失败", error instanceof Error ? error.message : String(error), { tone: "warning" }));
}

async function enterSkyOverlapMode(): Promise<void> {
  if (!layerViewer || mode !== "layers") return;
  const requestGeneration = ++overlapRequestGeneration;
  overlapModeActive = true;
  overlapResponse = null;
  layerViewer.setOverlapMode(true);
  canvas.dataset.overlapMode = "true";
  byId("scene-mode-value").textContent = "G · OVERLAP";
  byId("scene-badge").textContent = "天区重合";
  try {
    const state = layerViewer.state;
    const sourceIds = overlapSourceIdsForState(state);
    const result = await workspaceApi.skyOverlap({
      nside: state.nside,
      ...(sourceIds.length
        ? { sourceIds }
        : {
            surveyIds: state.visibleSurveyIds.filter((surveyId) => surveyId !== "__unassigned__"),
            assetIds: state.visibleAssetIds,
          }),
      includePublic: true,
      includeWorkspace: true,
    });
    if (!overlapModeActive || requestGeneration !== overlapRequestGeneration) return;
    overlapResponse = result;
    layerViewer.setOverlapCells(result.nside, result.pixels);
    layerViewer.setOverlapComponents(result.components);
    renderOverlapSummary(result);
    if (result.status === "empty") notifyWorkspace("当前可见来源没有共同覆盖", "请选择至少两个已建立覆盖的来源后重试。", { tone: "info" });
  } catch (error) {
    if (requestGeneration !== overlapRequestGeneration) return;
    overlapModeActive = false;
    layerViewer.setOverlapMode(false);
    canvas.dataset.overlapMode = "false";
    notifyWorkspace("天区重合计算失败", error instanceof Error ? error.message : String(error), { tone: "error" });
  }
}

function exitSkyOverlapMode(): void {
  if (!overlapModeActive) return;
  overlapRequestGeneration += 1;
  overlapModeActive = false;
  overlapResponse = null;
  layerLayoutMode = "layers";
  layerViewer?.setOverlapMode(false);
  canvas.dataset.overlapMode = "false";
  byId("scene-mode-value").textContent = "PUBLIC + OWNED";
  byId("scene-badge").textContent = "天球概览";
  inspectorRows("", []);
}

function renderRegionSceneLegend(state: SurveyLayerState): void {
  const legend = byId("region-scene-legend");
  if (!state.selectedCellCount || !state.selectionAnchor?.visible || !selectedLayerRegion) {
    legend.hidden = true;
    legend.replaceChildren();
    return;
  }
  const title = document.createElement("strong");
  title.textContent = `SELECTED · ${state.selectedCellCount} CELLS`;
  const subtitle = document.createElement("span");
  subtitle.textContent = "其余天区弱化";
  const surveys = document.createElement("div");
  surveys.className = "region-scene-surveys";
  const surveyIds = selectionSurveyIds(selectedLayerRegion);
  surveyIds.forEach((surveyId) => {
    const displayLayer = displayLayerFor({ surveyId });
    const item = document.createElement("span");
    const swatch = document.createElement("i");
    swatch.style.background = displayLayer.color;
    item.append(swatch, displayLayer.label);
    surveys.append(item);
  });
  selectedLayerRegion.assetIds.forEach((assetId) => {
    const displayLayer = displayLayerFor({ assetId });
    const item = document.createElement("span");
    const swatch = document.createElement("i");
    swatch.style.background = displayLayer.color;
    item.append(swatch, displayLayer.label);
    surveys.append(item);
  });
  if (!surveyIds.length && !selectedLayerRegion.assetIds.length) {
    const item = document.createElement("span");
    item.textContent = "NO REGISTERED COVERAGE";
    surveys.append(item);
  }
  legend.replaceChildren(title, subtitle, surveys);
  legend.hidden = false;
  const stage = byId("scene-stage").getBoundingClientRect();
  const width = Math.min(220, Math.max(180, stage.width - 28));
  legend.style.width = `${width}px`;
  const height = Math.max(58, legend.getBoundingClientRect().height);
  const anchorX = state.selectionAnchor.xRatio * stage.width;
  const anchorY = state.selectionAnchor.yRatio * stage.height;
  const margin = 14;
  const anchorBox = {
    left: Math.max(0, state.selectionAnchor.bounds.leftRatio * stage.width - 8),
    right: Math.min(stage.width, state.selectionAnchor.bounds.rightRatio * stage.width + 8),
    top: Math.max(0, state.selectionAnchor.bounds.topRatio * stage.height - 8),
    bottom: Math.min(stage.height, state.selectionAnchor.bounds.bottomRatio * stage.height + 8),
  };
  const candidates = [
    { placement: "right", left: anchorBox.right + 18, top: anchorY - height / 2 },
    { placement: "left", left: anchorBox.left - width - 18, top: anchorY - height / 2 },
    { placement: "below", left: anchorBox.right - width, top: anchorBox.bottom + 18 },
    { placement: "above", left: anchorBox.right - width, top: anchorBox.top - height - 18 },
  ] as const;
  const bounded = candidates.map((candidate) => ({
    ...candidate,
    left: Math.max(margin, Math.min(candidate.left, stage.width - width - margin)),
    top: Math.max(48, Math.min(candidate.top, stage.height - height - margin)),
  }));
  const score = (candidate: typeof bounded[number]): number => {
    const overlapWidth = Math.max(0, Math.min(candidate.left + width, anchorBox.right) - Math.max(candidate.left, anchorBox.left));
    const overlapHeight = Math.max(0, Math.min(candidate.top + height, anchorBox.bottom) - Math.max(candidate.top, anchorBox.top));
    const overlap = overlapWidth * overlapHeight;
    const distance = Math.hypot(candidate.left + width / 2 - anchorX, candidate.top + height / 2 - anchorY);
    return overlap * 100_000 - distance;
  };
  const best = bounded.reduce((current, candidate) => score(candidate) < score(current) ? candidate : current);
  legend.dataset.placement = best.placement;
  legend.style.left = `${best.left}px`;
  legend.style.top = `${best.top}px`;
}

function renderSurveySelection(selection: SurveyLayerSelection | null): void {
  selectedLayerRegion = selection;
  byId("inspector-kicker").textContent = "REGION SELECTION";
  if (!selection) {
    byId("region-scene-legend").hidden = true;
    if (selectedSurvey) renderSurveyDetails(selectedSurvey);
    else inspectorRows("", []);
    return;
  }
   const selectedSurveyIds = selectionSurveyIds(selection);
   const names = selectedSurveyIds.map((id) => displayLayerFor({ surveyId: id }).label).join(" / ");
   const coverageSummary = selection.coverageCounts
     .filter(({ surveyId }) => selectedSurveyIds.includes(surveyId))
     .map(({ surveyId, cellCount }) => `${displayLayerFor({ surveyId }).label}: ${cellCount}/${selection.pixels.length}`).join(" · ");
   const assetNames = selection.assetIds.map((id) => displayLayerFor({ assetId: id }).label).join(" / ");
   const assetCoverageSummary = selection.assetCoverageCounts.map(({ assetId, cellCount }) => `${displayLayerFor({ assetId }).label}: ${cellCount}/${selection.pixels.length}`).join(" · ");
  const artifactSummary = selection.artifacts.map((artifact) => {
    const survey = publicSurveyRecordsById.get(artifact.surveyId);
    const release = survey?.releases.find((entry) => entry.id === artifact.releaseId);
    return `${survey?.name ?? artifact.surveyId} ${release?.label ?? artifact.releaseId}: ${artifact.product} (${release?.modalities.join(", ") ?? "metadata pending"})`;
  }).join(" | ");
   const selectedAssets = assetsForSelection(selection);
  const downloadAction = actionButton("下载 HEALPix 选区", () => downloadJson(`sky-region-nside-${selection.nside}.json`, {
    schemaVersion: 1,
    ...nestedSkyRegion(selection.nside, selection.pixels),
    center: { raDeg: selection.centerRaDeg, decDeg: selection.centerDecDeg },
    boundingRadiusDeg: selection.angularRadiusDeg,
     surveys: selectedSurveyIds,
    releases: selection.releaseIds,
    assets: selection.assetIds,
  }));
  downloadAction.classList.add("secondary");
  downloadAction.dataset.action = "download-region";
  const clearAction = actionButton("清除所选区域", () => {
    layerViewer?.clearRegionSelection();
  });
  clearAction.classList.add("secondary");
  const buildAction = actionButton("交给数据生产", () => {
    productionPanel.setContext({ nside: selection.nside, pixels: selection.pixels, sourceIds: [...selectedSurveyIds.map((id) => `public:${id}`), ...selection.assetIds.map((id) => `workspace:asset:${id}`)], assetIds: selection.assetIds });
    void activateMode("workflow").catch(showFatal);
  });
   inspectorRows(`已选择 ${selection.pixels.length} 个天区`, [
    ["天区中心", `RA ${selection.centerRaDeg.toFixed(4)}° · Dec ${selection.centerDecDeg >= 0 ? "+" : ""}${selection.centerDecDeg.toFixed(4)}°`],
    ["HEALPix mask", `NESTED · NSIDE ${selection.nside} · ${selection.pixels.length} cells`],
    ["外接角半径", `${selection.angularRadiusDeg.toFixed(2)}°`],
    ["数据巡天", names || "当前可见巡天暂无覆盖"],
    ["各巡天覆盖", coverageSummary || "0 个已登记覆盖单元"],
    ["用户资产图层", assetNames || "当前可见用户资产暂无覆盖"],
    ["各资产覆盖", assetCoverageSummary || "0 个用户资产覆盖单元"],
    ["未覆盖区块", `${selection.emptyCellCount} / ${selection.pixels.length}`],
    ["匹配数据发布", selection.releaseIds.join(" / ") || "无"],
    ["产品与模态", artifactSummary || "所选区块尚无已登记产品"],
      ["项目资产", projectStateSummary(selectedAssets)],
      ["选区状态", selection.notice ?? "普通点击替换区块；Ctrl / Meta 点击可增减；右键在 Aladin 中探索"],
   ], [downloadAction, buildAction, clearAction]);
  if (layerViewer) renderRegionSceneLegend(layerViewer.state);
}

function renderSurveyObjectPoint(point: SurveyObjectPoint): void {
  const displayLayer = displayLayerFor({
    assetId: point.assetId,
    surveyId: point.surveyId,
    releaseId: point.releaseId,
    product: point.product,
    modality: point.modality,
    key: point.objectId,
  });
  byId("inspector-kicker").textContent = "OBJECT INSPECTOR";
  const rows: Array<[string, string]> = [
    ["对象 ID", point.objectId ?? "未命名对象"],
    ["天空位置", `RA ${point.raDeg.toFixed(6)}° · Dec ${point.decDeg >= 0 ? "+" : ""}${point.decDeg.toFixed(6)}°`],
    ["数据图层", displayLayer.label],
    ["数据发布", point.releaseId ?? displayLayer.releaseId ?? "--"],
    ["产品", point.product ?? displayLayer.product ?? "--"],
    ["模态", point.modality ?? displayLayer.modality ?? "--"],
  ];
  if (point.overlapCount && point.overlapCount > 1) {
    rows.unshift(["重合关系", `${point.overlapCount} 个用户资产对象位于约 1 arcsec 内`]);
    if (point.overlapAssetIds?.length) rows.push(["重合资产", point.overlapAssetIds.map((assetId) => displayLayerFor({ assetId }).label).join(" / ")]);
  }
  Object.entries(point.attributes ?? {}).slice(0, 16).forEach(([key, value]) => {
    rows.push([key, inspectorValue(value)]);
  });
  inspectorRows(`对象 ${point.objectId ?? "未命名"}`, rows);
  const panel = byId("inspector-panel");
  panel.classList.add("aladin-object-selected");
  panel.dataset.objectId = point.objectId ?? "unknown";
  panel.classList.add("mobile-open");
}

function renderSurveyInspection(inspection: SurveyLayerInspection | null): void {
  if (!inspection) {
    if (selectedSurvey) renderSurveyDetails(selectedSurvey);
    else inspectorRows("", []);
    return;
  }
  byId("inspector-kicker").textContent = "AVAILABLE DATA IN THIS SKY CELL";
  const empty = byId("inspector-empty");
  const content = byId("inspector-content");
  empty.hidden = true;
  content.hidden = false;
  const titleRow = document.createElement("div");
  titleRow.className = "coverage-title-row";
  const heading = document.createElement("h2");
  heading.textContent = `HEALPix ${inspection.pixel}`;
  titleRow.append(heading);
  const coordinates = document.createElement("div");
  coordinates.className = "coverage-location";
  const frame = document.createElement("span");
  frame.textContent = `ICRS · NSIDE ${inspection.nside}`;
  const pointer = document.createElement("strong");
  pointer.textContent = `RA ${inspection.pointerRaDeg.toFixed(5)}° · Dec ${inspection.pointerDecDeg >= 0 ? "+" : ""}${inspection.pointerDecDeg.toFixed(5)}°`;
  const center = document.createElement("small");
  center.textContent = `Cell center ${inspection.centerRaDeg.toFixed(5)}°, ${inspection.centerDecDeg >= 0 ? "+" : ""}${inspection.centerDecDeg.toFixed(5)}°`;
  coordinates.append(frame, pointer, center);
  const stack = document.createElement("div");
  stack.className = "coverage-stack";
  const inspectionSurveyIds = explorationSurveyIds(inspection.surveyIds, inspection.assetIds);
  inspectionSurveyIds.filter((surveyId) => inspection.artifacts.some((artifact) => artifact.surveyId === surveyId)).forEach((surveyId) => {
    const survey = publicSurveyRecordsById.get(surveyId);
    const artifacts = inspection.artifacts.filter((artifact) => artifact.surveyId === surveyId);
    const displayLayer = displayLayerFor({ surveyId });
    const group = document.createElement("section");
    const groupHeading = document.createElement("header");
    const swatch = document.createElement("i");
    swatch.style.background = displayLayer.color;
    const name = document.createElement("strong");
    name.textContent = displayLayer.label;
    const count = document.createElement("span");
    count.textContent = `${artifacts.length} SOURCE${artifacts.length === 1 ? "" : "S"}`;
    groupHeading.append(swatch, name, count);
    group.append(groupHeading);
    artifacts.forEach((artifact) => {
      const release = survey?.releases.find((entry) => entry.id === artifact.releaseId);
      const row = document.createElement("article");
      const releaseName = document.createElement("b");
      releaseName.textContent = release?.label ?? artifact.releaseId;
      const product = document.createElement("p");
      product.textContent = `${artifact.product} · ${release?.modalities.join(" / ") ?? "modality pending"}`;
      const provenance = document.createElement("div");
      const quality = document.createElement("small");
      quality.textContent = artifact.quality === "moc" ? "MOC GEOMETRY" : "OFFICIAL OVERVIEW";
      const source = document.createElement("a");
      source.href = artifact.sourceUrl;
      source.target = "_blank";
      source.rel = "noreferrer";
      source.textContent = "来源";
      provenance.append(quality, source);
      row.append(releaseName, product, provenance);
      group.append(row);
    });
    stack.append(group);
  });
  inspection.workspaceLayers.forEach((layer) => {
    const assetId = layer.assetId ?? layer.assetIds[0];
    const displayLayer = displayLayerFor({ assetId, surveyId: layer.surveyId, releaseId: layer.releaseId, product: layer.productId, modality: layer.modality, key: layer.key });
    const group = document.createElement("section");
    group.className = "coverage-workspace-layer";
    const groupHeading = document.createElement("header");
    const swatch = document.createElement("i");
    swatch.style.background = displayLayer.color;
    const name = document.createElement("strong");
    name.textContent = displayLayer.label;
    const count = document.createElement("span");
    count.textContent = "USER ASSET";
    groupHeading.append(swatch, name, count);
    const row = document.createElement("article");
    const release = document.createElement("b");
    release.textContent = [displayLayer.surveyId, displayLayer.releaseId].filter(Boolean).join(" / ") || "未设置巡天标签";
    const detail = document.createElement("p");
    detail.textContent = layer.message ?? "该用户资产在此 HEALPix 单元有已扫描对象。";
    row.append(release, detail);
    group.append(groupHeading, row);
    stack.append(group);
  });
  const inspectionAssetIds = new Set(inspection.assetIds);
  const cellAssets = dataAssets.filter((asset) => {
    if (inspectionAssetIds.has(asset.id)) return true;
    const surveyId = asset.surveyId;
    return Boolean(surveyId && inspectionSurveyIds.includes(surveyId));
  });
  const projectState = document.createElement("section");
  projectState.className = "coverage-project-state";
  const projectHeading = document.createElement("header");
  projectHeading.textContent = "项目资产";
  const projectCopy = document.createElement("p");
  projectCopy.textContent = projectStateSummary(cellAssets);
  projectState.append(projectHeading, projectCopy);
  const nextStep = document.createElement("div");
  nextStep.className = "coverage-next-step";
  const nextCopy = document.createElement("p");
  nextCopy.textContent = "已确认该天区存在公开覆盖。下一步可把精确选区交给数据生产，生成扫描、下载或加工任务。";
  const prepare = document.createElement("button");
  prepare.type = "button";
  prepare.className = "command-button";
  prepare.disabled = false;
  prepare.textContent = "构建数据生产任务";
  prepare.title = "把当前数据覆盖区块交给数据生产工作台";
  prepare.addEventListener("click", () => {
    productionPanel.setContext({ nside: inspection.nside, pixels: [inspection.pixel], sourceIds: inspectionSurveyIds.map((id) => `public:${id}`), assetIds: inspection.assetIds });
    void activateMode("workflow").catch(showFatal);
  });
  nextStep.append(nextCopy, prepare);
  const workspaceSection = renderWorkspaceDataSection(workspaceSummaryForPixel(inspection.pixel, inspection.assetIds));
  workspaceSection.id = "coverage-workspace-data";
  content.replaceChildren(titleRow, coordinates, stack, projectState, workspaceSection, nextStep);
  void loadAstroInspection(inspection);
  if (window.innerWidth <= 1040) byId("inspector-panel").classList.add("mobile-open");
}

function footprintsForSurvey(surveyId: string) {
  return surveyFootprints?.footprints.filter((footprint) => footprint.surveyId === surveyId) ?? [];
}

function workspaceSummaryKey(pixel: number, assetIds: readonly string[]): string {
  return `${pixel}:${[...assetIds].sort().join(",")}`;
}

function workspaceSummaryForPixel(pixel: number, assetIds: readonly string[]): AstroSpatialSummary | undefined {
  return workspaceCellSummaries.get(workspaceSummaryKey(pixel, assetIds));
}

function cancelWorkspaceHoverQuery(): void {
  workspaceHoverQueryGeneration += 1;
  if (workspaceHoverQueryTimer !== null) clearTimeout(workspaceHoverQueryTimer);
  workspaceHoverQueryTimer = null;
}

function requestWorkspaceHoverSummary(hover: SurveyLayerHover): void {
  if (!hover.assetIds.length) {
    cancelWorkspaceHoverQuery();
    return;
  }
  const key = workspaceSummaryKey(hover.pixel, hover.assetIds);
  if (workspaceSummaryForPixel(hover.pixel, hover.assetIds) || workspaceHoverRequests.has(key)) return;
  cancelWorkspaceHoverQuery();
  const generation = workspaceHoverQueryGeneration;
  workspaceHoverQueryTimer = setTimeout(() => {
    workspaceHoverQueryTimer = null;
    if (generation !== workspaceHoverQueryGeneration || !activeWorkspaceHover || workspaceSummaryKey(activeWorkspaceHover.pixel, activeWorkspaceHover.assetIds) !== key) return;
    workspaceHoverRequests.add(key);
    void workspaceApi.skyQuery({ cells: [hover.pixel], nside: hover.nside, assetIds: hover.assetIds })
      .then((summary) => {
        workspaceCellSummaries.set(key, summary);
        if (activeWorkspaceHover && workspaceSummaryKey(activeWorkspaceHover.pixel, activeWorkspaceHover.assetIds) === key) renderSurveyHover(activeWorkspaceHover);
      })
      .catch((error) => notifyWorkspace("工作区空间索引查询失败", error instanceof Error ? error.message : String(error), { tone: "warning", dedupeMs: 5_000 }))
      .finally(() => workspaceHoverRequests.delete(key));
  }, WORKSPACE_HOVER_QUERY_DELAY_MS);
}

function workspaceStatusLabel(summary: AstroSpatialSummary | undefined): string {
  if (!summary) return "未查询";
  if (summary.status === "unavailable") return "尚未建立空间索引";
  if (summary.status === "error") return summary.message ? `空间索引查询失败：${summary.message}` : "空间索引查询失败";
  if (!summary.matchedFiles) return "已建立索引，此区块暂无文件";
  return `${formatInteger(summary.matchedFiles)} 个文件 · ${formatBytes(summary.totalBytes)}`;
}

function renderWorkspaceDataSection(summary: AstroSpatialSummary | undefined, loading = false): HTMLElement {
  const section = document.createElement("section");
  section.className = "coverage-workspace-data";
  section.dataset.status = summary?.status ?? (loading ? "loading" : "unknown");
  const heading = document.createElement("header");
  const title = document.createElement("strong");
  title.textContent = "工作区数据";
  const badge = document.createElement("span");
  badge.textContent = loading ? "查询中" : summary?.status === "ready" ? "已扫描" : "未建立索引";
  heading.append(title, badge);
  const status = document.createElement("p");
  status.textContent = loading ? "正在查询 astro_file_index_v1" : workspaceStatusLabel(summary);
  section.append(heading, status);
  if (!summary || summary.status !== "ready" || !summary.matchedFiles) return section;
  const details = document.createElement("div");
  details.className = "coverage-workspace-details";
  const known = document.createElement("span");
  known.textContent = `已知空间 ${formatInteger(summary.knownFiles)}`;
  const unknown = document.createElement("span");
  unknown.textContent = `未知空间 ${formatInteger(summary.unknownFiles)}`;
  details.append(known, unknown);
  section.append(details);
  if (summary.byAsset.length) {
    const assets = document.createElement("small");
    assets.textContent = `资产：${summary.byAsset.slice(0, 3).map((entry) => `${dataAssets.find((asset) => asset.id === entry.key)?.name ?? entry.key} (${formatInteger(entry.files)})`).join(" · ")}`;
    section.append(assets);
  }
  return section;
}

function euclidOverviewPixels(): number[] {
  return [...new Set(
    (surveyFootprints?.footprints ?? [])
      .filter((footprint) => footprint.surveyId === "euclid" && footprint.releaseId === "euclid-q1" && footprint.nside === 16)
      .flatMap((footprint) => footprint.pixels),
  )].sort((left, right) => left - right);
}

async function loadEuclidAstroOverview(): Promise<void> {
  const cells = euclidOverviewPixels();
  if (!cells.length) return;
  const overview = await workspaceApi.skyOverview({ survey: "euclid", release: "euclid-q1", nside: 16, cells });
  astroOverview = overview;
  if (mode === "layers") {
    byId("dataset-state").textContent = overview.status === "ready"
      ? "公开覆盖与工作区已扫描空间索引已载入"
      : "公开覆盖已载入；工作区空间索引尚未建立";
  }
}

function userDataAssets(): DataAssetRecord[] {
  return dataAssets;
}

function coverageLayerAssetIds(layer: { assetIds?: readonly string[]; assetId?: string }): string[] {
  return [...new Set([...(layer.assetIds ?? []), ...(layer.assetId ? [layer.assetId] : [])])];
}

function coverageObjectCount(assetId: string, response: WorkspaceAssetCoverageResponse, layer?: WorkspaceAssetCoverageLayer): number | undefined {
  if (typeof layer?.objectCount === "number") return layer.objectCount;
  const breakdown = [...(layer?.byAsset ?? []), ...response.byAsset].find((entry) => entry.key === assetId);
  if (typeof breakdown?.objectCount === "number") return breakdown.objectCount;
  return typeof breakdown?.objects === "number" ? breakdown.objects : undefined;
}

function workspaceLayerIdForAsset(assetId: string): string {
  return `workspace-${assetId}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 180) || "workspace-asset";
}

function layerBelongsToAsset(layer: WorkspaceCoverageLayer, assets: readonly DataAssetRecord[]): boolean {
  const ids = coverageLayerAssetIds(layer as WorkspaceAssetCoverageLayer);
  if (ids.length && ids.some((id) => assets.some((asset) => asset.id === id))) return true;
  const layerId = layer.layerId;
  return Boolean(layerId && assets.some((asset) => [asset.id, workspaceLayerIdForAsset(asset.id), `user-${asset.id}`].includes(layerId)));
}

function workspaceExtraLayerKey(layer: WorkspaceCoverageLayer): string | undefined {
  if (layer.key?.startsWith("warehouse:") || layer.key?.startsWith("moc:")) return layer.key;
  if (layer.source === "warehouse") return `warehouse:${layer.layerId ?? layer.key ?? "layer"}`;
  if (layer.artifactId) return `moc:${layer.artifactId}`;
  return undefined;
}

function userMocLayer(artifact: UserMocArtifact, nside: number): WorkspaceCoverageLayer {
  const status: WorkspaceCoverageLayer["status"] = artifact.status === "ready"
    ? "ready"
    : artifact.status === "failed" ? "error" : artifact.status;
  return {
    key: `moc:${artifact.id}`,
    layerId: artifact.layerId,
    artifactId: artifact.id,
    status,
    mocStatus: artifact.status,
    source: "asset",
    message: artifact.error,
    nside,
    pixels: [],
    availableOrders: artifact.availableOrders,
    maxOrder: artifact.maxOrder,
    precision: artifact.precision,
    coverageRole: artifact.coverageRole,
  };
}

function normalizedAssetCoverage(asset: DataAssetRecord, response: WorkspaceAssetCoverageResponse): WorkspaceCoverageLayer & { assetId: string; objectCount?: number; coverageStatus: WorkspaceAssetCoverageResponse["status"] } {
  const layers = response.layers ?? [];
  const layer = layers.find((candidate) => coverageLayerAssetIds(candidate).length === 1 && coverageLayerAssetIds(candidate)[0] === asset.id)
    ?? layers.find((candidate) => coverageLayerAssetIds(candidate).includes(asset.id));
  const pixels = [...new Set((layer?.pixels ?? response.pixels).filter((pixel) => Number.isInteger(pixel) && pixel >= 0))].sort((left, right) => left - right);
  const objectCount = coverageObjectCount(asset.id, response, layer);
  return {
    key: `asset:${asset.id}`,
    assetId: asset.id,
    assetIds: [asset.id],
    assetName: asset.name,
    status: response.status,
    surveyId: layer?.surveyId ?? asset.surveyId,
    releaseId: layer?.releaseId ?? asset.releaseId,
    source: layer?.source ?? "asset",
    message: layer?.message ?? response.message,
    nside: response.nside,
    pixels,
    ...(objectCount === undefined ? {} : { objectCount }),
    coverageStatus: response.status,
  };
}

async function independentAssetCoverage(assets: DataAssetRecord[], nside: number): Promise<{ layers: Array<ReturnType<typeof normalizedAssetCoverage>>; legacy: WorkspaceCoverageLayer[] }> {
  let aggregate: WorkspaceAssetCoverageResponse | null = null;
  try {
    aggregate = await workspaceApi.skyCoverage({ nside, assetIds: assets.map((asset) => asset.id) });
  } catch (error) {
    console.warn("Unable to load aggregate workspace coverage; retrying assets independently", error);
  }

  const exactLayers = new Map<string, WorkspaceAssetCoverageLayer>();
  aggregate?.layers?.forEach((layer) => {
    const assetIds = coverageLayerAssetIds(layer);
    if (assetIds.length === 1) exactLayers.set(assetIds[0]!, layer);
  });
  const responses = new Map<string, WorkspaceAssetCoverageResponse>();
  if (aggregate) {
    assets.forEach((asset) => {
      const layer = exactLayers.get(asset.id);
      if (layer) responses.set(asset.id, { ...aggregate!, pixels: layer.pixels, byAsset: layer.byAsset, layers: [layer], status: layer.status ?? aggregate!.status });
    });
  }

  const missing = assets.filter((asset) => !responses.has(asset.id));
  const settled = await Promise.allSettled(missing.map((asset) => workspaceApi.skyCoverage({ nside, assetIds: [asset.id] })));
  settled.forEach((result, index) => {
    const asset = missing[index]!;
    if (result.status === "fulfilled") responses.set(asset.id, result.value);
    else responses.set(asset.id, { status: "error", index: "workspace-coverage", nside, pixels: [], byAsset: [], message: result.reason instanceof Error ? result.reason.message : String(result.reason) });
  });

  const legacy = (aggregate?.layers ?? [])
    .filter((layer) => !coverageLayerAssetIds(layer).length && layer.pixels.length > 0)
    .map((layer) => ({ ...layer, nside: aggregate!.nside }));
  return {
    layers: assets.map((asset) => normalizedAssetCoverage(asset, responses.get(asset.id)!)),
    legacy,
  };
}

async function loadWorkspaceAssetCoverage(scannedAssetId?: string): Promise<void> {
  const assets = userDataAssets();
  const availableAssetIds = new Set(assets.map((asset) => asset.id));
  visibleAssetIds = new Set([...visibleAssetIds].filter((assetId) => availableAssetIds.has(assetId)));
  if (selectedLayerAssetId && !availableAssetIds.has(selectedLayerAssetId)) selectedLayerAssetId = null;
  const nside = surveyFootprints?.nside ?? 16;
  const extraCoverageResult = await Promise.allSettled([
    workspaceApi.skyCoverage({ nside }),
    workspaceApi.userMocs(),
    workspaceApi.dataAssetStatuses(),
  ]);
  const extraCoverage = extraCoverageResult[0]?.status === "fulfilled" ? extraCoverageResult[0].value : undefined;
  const listedMocs = extraCoverageResult[1]?.status === "fulfilled" ? extraCoverageResult[1].value : [];
  const statusResult = extraCoverageResult[2];
  if (statusResult?.status === "fulfilled") {
    coverageStatusesByAsset.clear();
    statusResult.value.forEach((status) => coverageStatusesByAsset.set(status.assetId, status));
  } else {
    [...coverageStatusesByAsset.keys()].filter((assetId) => !availableAssetIds.has(assetId)).forEach((assetId) => coverageStatusesByAsset.delete(assetId));
  }
  userMocArtifacts.clear();
  listedMocs.forEach((artifact) => userMocArtifacts.set(artifact.id, artifact));
  workspaceExtraLayers.clear();
  for (const layer of extraCoverage?.layers ?? []) {
    const normalized = { ...layer, nside } as WorkspaceCoverageLayer;
    // An explicitly keyed MOC is its own selectable layer even when the
    // coverage response also records the source asset. Asset-backed warehouse
    // layers continue to collapse into the asset card to avoid duplicates.
    if (layerBelongsToAsset(normalized, assets) && !normalized.key?.startsWith("moc:")) continue;
    const key = workspaceExtraLayerKey(normalized);
    if (!key) continue;
    workspaceExtraLayers.set(key, { ...normalized, key, pixels: [...new Set(normalized.pixels)].sort((a, b) => a - b) });
  }
  // The artifact endpoint remains useful when the coverage endpoint is
  // degraded. Preserve its state card even when no projection is available.
  for (const artifact of listedMocs) {
    if (assets.some((asset) => [asset.id, workspaceLayerIdForAsset(asset.id), `user-${asset.id}`].includes(artifact.layerId))) continue;
    const key = `moc:${artifact.id}`;
    if (!workspaceExtraLayers.has(key)) workspaceExtraLayers.set(key, userMocLayer(artifact, nside));
  }
  if (!workspaceLayerVisibilityPreferenceRestored) {
    visibleWorkspaceLayerKeys = new Set([...workspaceExtraLayers.entries()]
      .filter(([, layer]) => layer.status === "ready")
      .map(([key]) => key));
    workspaceLayerVisibilityPreferenceRestored = true;
  } else {
    visibleWorkspaceLayerKeys = new Set([...visibleWorkspaceLayerKeys].filter((key) => workspaceExtraLayers.has(key)));
  }

  const coverage = assets.length
    ? await independentAssetCoverage(assets, nside)
    : { layers: [], legacy: [] as WorkspaceCoverageLayer[] };
  workspaceAssetLayers.clear();
  coverage.layers.forEach((layer) => workspaceAssetLayers.set(layer.assetId, layer));
  legacyWorkspaceLayers = coverage.legacy;
  hasUnassignedWorkspaceCoverage = legacyWorkspaceLayers.some((layer) => layer.pixels.length > 0 && !layer.surveyId);
  const coveredAssetIds = new Set(coverage.layers.filter((layer) => layer.pixels.length > 0).map((layer) => layer.assetId));
  if (!assetVisibilityPreferenceRestored) {
    // Existing user assets are listed but remain opt-in. A newly completed
    // scan is the only asset that may be surfaced automatically.
    visibleAssetIds.clear();
    assetVisibilityPreferenceRestored = true;
  }
  if (scannedAssetId && coveredAssetIds.has(scannedAssetId)) visibleAssetIds.add(scannedAssetId);

  layerViewer?.setWorkspaceCoverageLayers([...coverage.layers, ...legacyWorkspaceLayers, ...workspaceExtraLayers.values()], nside);
  // Add newly covered assets to layer order, but don't add all known layers
  const knownKeys = new Set(knownLayerOrderKeys());
  const filteredOrder = layerOrder.filter((key) => knownKeys.has(key));
  const newPublicKeys = footprintSurveyIds()
    .map((surveyId) => `public-survey:${surveyId}`)
    .filter((key) => !filteredOrder.includes(key));
  const newAssetKeys = assets.map((asset) => `asset:${asset.id}`).filter((key) => knownKeys.has(key) && !filteredOrder.includes(key));
  const newWorkspaceKeys = [...workspaceExtraLayers.keys()].filter((key) => !filteredOrder.includes(key));
  const newUnassignedKey = hasUnassignedWorkspaceCoverage && !filteredOrder.includes("workspace-unassigned") ? ["workspace-unassigned"] : [];
  layerOrder = [...filteredOrder, ...newPublicKeys, ...newAssetKeys, ...newWorkspaceKeys, ...newUnassignedKey];
  applyLayerOrder(false);
  layerViewer?.setVisibleAssets(visibleAssetIds);
  layerViewer?.setVisibleWorkspaceLayerKeys(visibleWorkspaceLayerKeys);
  layerViewer?.setVisibleSurveys(new Set([...visibleSurveyIds, ...(unassignedWorkspaceVisible ? ["__unassigned__"] : [])]));
  buildSurveyList();
  renderCoverageMetrics();
  persistLayerPreferences();
  if (mode === "layers") {
    coverage.layers.filter((layer) => layer.coverageStatus === "error").forEach((layer) => {
      notifyWorkspace("用户资产覆盖读取失败", `${layer.assetName ?? layer.assetId} · ${layer.message ?? "空间索引不可用"}`, { tone: "warning", dedupeMs: 5_000 });
      console.warn(`Unable to load workspace coverage for ${layer.assetId}`, layer.message);
    });
  }
  if (extraCoverageResult[0]?.status === "rejected") {
    console.warn("Unable to load Warehouse and user MOC coverage", extraCoverageResult[0].reason);
  }
}

async function refreshWorkspaceAssets(scannedAssetId?: string): Promise<void> {
  const [assets, surveys] = await Promise.all([workspaceApi.dataAssets(), workspaceApi.surveys()]);
  dataAssets = assets;
  surveyCards = surveys;
  const records = await Promise.all(surveys.map((survey) => workspaceApi.survey(survey.id)));
  localSurveyRecordsById.clear();
  records.forEach((survey) => localSurveyRecordsById.set(survey.id, survey));
  await loadWorkspaceAssetCoverage(scannedAssetId);
  if (mode === "layers") {
    renderCoverageMetrics();
    const selected = selectedLayerAssetId ? dataAssets.find((asset) => asset.id === selectedLayerAssetId) : undefined;
    if (selected) renderLayerAssetDetails(selected);
  }
}

async function loadAstroInspection(inspection: SurveyLayerInspection): Promise<void> {
  const generation = ++astroInspectionGeneration;
  const key = workspaceSummaryKey(inspection.pixel, inspection.assetIds);
  const summary = workspaceSummaryForPixel(inspection.pixel, inspection.assetIds);
  if (!inspection.assetIds.length) {
    const section = byId<HTMLElement>("coverage-workspace-data");
    section.replaceWith(renderWorkspaceDataSection(undefined));
    return;
  }
  try {
    const queried = await workspaceApi.skyQuery({
      cells: [inspection.pixel],
      nside: inspection.nside,
      assetIds: inspection.assetIds,
    });
    if (generation !== astroInspectionGeneration) return;
    workspaceCellSummaries.set(key, queried);
    const section = byId<HTMLElement>("coverage-workspace-data");
    section.replaceWith(renderWorkspaceDataSection(queried));
  } catch (error) {
    if (generation !== astroInspectionGeneration) return;
    notifyWorkspace("工作区空间索引查询失败", error instanceof Error ? error.message : String(error), { tone: "warning", dedupeMs: 5_000 });
    const section = byId<HTMLElement>("coverage-workspace-data");
    section.replaceWith(renderWorkspaceDataSection({
      ...(summary ?? { status: "error", index: "astro_file_index_v1", nside: inspection.nside, matchedFiles: 0, totalBytes: 0, knownFiles: 0, unknownFiles: 0, spatialStatus: {}, byAsset: [], bySurveyReleaseModality: [] }),
      status: "error",
      message: error instanceof Error ? error.message : String(error),
    }));
  }
}

function renderSurveyHover(hover: SurveyLayerHover | null): void {
  const card = byId("coverage-hover");
  if (!hover) {
    cancelWorkspaceHoverQuery();
    activeWorkspaceHover = null;
    delete canvas.dataset.hoveredPixel;
    delete canvas.dataset.hoveredCovered;
    delete canvas.dataset.hoveredSelectable;
    delete canvas.dataset.hoveredAssetIds;
    if (hoverDismissTimer) clearTimeout(hoverDismissTimer);
    hoverDismissTimer = setTimeout(() => {
      card.hidden = true;
      card.replaceChildren();
    }, 110);
    return;
  }
  if (!byId("coverage-context-menu").hidden) return;
  activeWorkspaceHover = hover;
  requestWorkspaceHoverSummary(hover);
  if (hoverDismissTimer) clearTimeout(hoverDismissTimer);
  hoverDismissTimer = null;
  canvas.dataset.hoveredPixel = String(hover.pixel);
  canvas.dataset.hoveredCovered = String(hover.artifacts.length > 0 || hover.assetIds.length > 0);
  canvas.dataset.hoveredSelectable = String(hover.selectableInRegion);
  canvas.dataset.hoveredAssetIds = hover.assetIds.join(",");
  const stage = byId("scene-stage");
  const bounds = stage.getBoundingClientRect();
  const title = document.createElement("strong");
  title.textContent = `ICRS sky cell ${hover.pixel}`;
  const subtitle = document.createElement("span");
  subtitle.textContent = `RA ${hover.pointerRaDeg.toFixed(5)}° · Dec ${hover.pointerDecDeg >= 0 ? "+" : ""}${hover.pointerDecDeg.toFixed(5)}° · NSIDE ${hover.nside}`;
  const center = document.createElement("span");
  const localSummary = workspaceSummaryForPixel(hover.pixel, hover.assetIds);
  center.textContent = `Cell center ${hover.centerRaDeg.toFixed(5)}°, ${hover.centerDecDeg >= 0 ? "+" : ""}${hover.centerDecDeg.toFixed(5)}° · 官方 ${hover.artifacts.length} · 用户资产 ${hover.assetIds.length}`;
  const entries = document.createElement("div");
  entries.className = "coverage-hover-list";
  hover.artifacts.forEach((artifact) => {
    const survey = publicSurveyRecordsById.get(artifact.surveyId);
    const release = survey?.releases.find((entry) => entry.id === artifact.releaseId);
    const entry = document.createElement("article");
    const name = document.createElement("b");
    name.textContent = `${survey?.name ?? artifact.surveyId} · ${release?.label ?? artifact.releaseId}`;
    const detail = document.createElement("span");
    detail.textContent = `${artifact.product} · ${release?.modalities.join(", ") ?? "modalities pending"}`;
    const provenance = document.createElement("div");
    const quality = document.createElement("small");
    quality.textContent = artifact.quality === "moc" ? "MOC" : "OFFICIAL OVERVIEW";
    const source = document.createElement("a");
    source.href = artifact.sourceUrl;
    source.target = "_blank";
    source.rel = "noreferrer";
    source.textContent = "Source";
    provenance.append(quality, source);
    entry.append(name, detail, provenance);
    entries.append(entry);
  });
  hover.workspaceLayers.forEach((layer) => {
    const assetId = layer.assetId ?? layer.assetIds[0];
    const descriptor = displayLayerFor({
      assetId,
      surveyId: layer.surveyId,
      releaseId: layer.releaseId,
      product: layer.productId,
      modality: layer.modality,
      key: layer.key,
    });
    const entry = document.createElement("article");
    const name = document.createElement("b");
    name.textContent = descriptor.label;
    const detail = document.createElement("span");
    const survey = descriptor.surveyId ? localSurveyRecordsById.get(descriptor.surveyId) : undefined;
    const release = survey?.releases.find((entry) => entry.id === descriptor.releaseId);
    detail.textContent = [survey?.name, release?.label, descriptor.product].filter(Boolean).join(" / ") || "用户资产覆盖";
    entry.append(name, detail);
    entries.append(entry);
  });
  entries.append(renderWorkspaceDataSection(localSummary));
  if (!hover.artifacts.length && !hover.workspaceLayers.length) {
    const empty = document.createElement("article");
    const name = document.createElement("b");
    name.textContent = "当前可见巡天无已登记覆盖";
    const detail = document.createElement("span");
    detail.textContent = hover.selectableInRegion ? "该区块仍可加入连续天区选区" : "切换到区域选择后可纳入天区 mask";
    empty.append(name, detail);
    entries.append(empty);
  }
  card.replaceChildren(title, subtitle, center, entries);
  card.hidden = false;
  const width = Math.min(276, Math.max(220, bounds.width - 24));
  const left = Math.max(12, Math.min(hover.clientX - bounds.left + 14, bounds.width - width - 12));
  const top = Math.max(48, Math.min(hover.clientY - bounds.top + 14, bounds.height - 220));
  card.style.width = `${width}px`;
  card.style.left = `${left}px`;
  card.style.top = `${top}px`;
}

const coverageHover = byId("coverage-hover");
coverageHover.addEventListener("pointerenter", () => {
  if (hoverDismissTimer) clearTimeout(hoverDismissTimer);
  hoverDismissTimer = null;
});
coverageHover.addEventListener("pointerleave", () => {
  coverageHover.hidden = true;
  coverageHover.replaceChildren();
});
function footprintLabel(status: SurveyCard["coverageStatus"]): string {
  if (status === "verified") return "覆盖范围可用";
  if (status === "summary_only") return "仅有范围说明";
  return "暂无覆盖范围";
}

function footprintSurveyIds(): string[] {
  const available = new Set(surveyFootprints?.footprints.map((footprint) => footprint.surveyId) ?? []);
  return publicSurveyCards.filter((survey) => available.has(survey.id)).map((survey) => survey.id);
}

function knownLayerOrderKeys(): string[] {
  return [
    ...userDataAssets().map((asset) => `asset:${asset.id}`),
    ...footprintSurveyIds().map((surveyId) => `public-survey:${surveyId}`),
    ...workspaceExtraLayers.keys(),
    ...(hasUnassignedWorkspaceCoverage ? ["workspace-unassigned"] : []),
  ];
}

function normalizeCurrentLayerOrder(stored: Iterable<string> = layerOrder, addMissing: boolean = false): string[] {
  return normalizeLayerOrder(knownLayerOrderKeys(), stored, addMissing ? knownLayerOrderKeys() : []);
}

function applyLayerOrder(addMissing: boolean = false): void {
  layerOrder = normalizeCurrentLayerOrder(layerOrder, addMissing);
  layerViewer?.setLayerOrder(layerOrder);
}

function restoreLayerPreferences(): void {
  const available = new Set(footprintSurveyIds());
  const availableAssets = new Set(userDataAssets().map((asset) => asset.id));
  try {
    const current = localStorage.getItem(LAYER_PREFERENCES_KEY);
    const previous = localStorage.getItem(PREVIOUS_LAYER_PREFERENCES_KEY);
    const legacy = localStorage.getItem(LEGACY_LAYER_PREFERENCES_KEY);
    const preferenceValue = current ?? previous ?? legacy;
    const stored = JSON.parse(preferenceValue ?? "null") as {
      schemaVersion?: number;
      visibleSurveyIds?: string[];
      visibleAssetIds?: string[];
      layerOrder?: string[];
      layoutMode?: SurveyLayerLayoutMode;
      interactionMode?: SurveyLayerInteractionMode;
      unassignedWorkspaceVisible?: boolean;
      visibleWorkspaceLayerKeys?: string[];
    } | null;
    const restored = stored?.visibleSurveyIds?.filter((surveyId) => available.has(surveyId)) ?? [];
    if (restored.length || stored?.visibleSurveyIds?.length === 0) visibleSurveyIds = new Set(restored);
    else if (available.has("legacy-surveys")) visibleSurveyIds = new Set(["legacy-surveys"]);
    else visibleSurveyIds = new Set([...available].slice(0, 1));
    // Radial expansion is the normal view. G temporarily switches to overlap.
    layerLayoutMode = "layers";
    layerInteractionMode = stored?.interactionMode === "region" ? "region" : "inspect";
    unassignedWorkspaceVisible = stored?.unassignedWorkspaceVisible === true;
    const storedSchemaVersion = stored?.schemaVersion ?? 0;
    // v3 could have persisted every covered user asset as visible by default.
    // Do not restore that implicit visibility after the layer-selection cutover.
    assetVisibilityPreferenceRestored = storedSchemaVersion >= 4 && Array.isArray(stored?.visibleAssetIds);
    visibleAssetIds = new Set(assetVisibilityPreferenceRestored
      ? (stored?.visibleAssetIds ?? []).filter((assetId) => availableAssets.has(assetId))
      : []);
    workspaceLayerVisibilityPreferenceRestored = storedSchemaVersion >= 5 && Array.isArray(stored?.visibleWorkspaceLayerKeys);
    visibleWorkspaceLayerKeys = new Set(workspaceLayerVisibilityPreferenceRestored
      ? (stored?.visibleWorkspaceLayerKeys ?? []).filter((key) => key.startsWith("warehouse:") || key.startsWith("moc:"))
      : []);
    const addMissing = Array.isArray(stored?.layerOrder) && stored.layerOrder.length > 0;
    layerOrder = normalizeCurrentLayerOrder(stored?.layerOrder ?? [], addMissing);
  } catch {
    visibleSurveyIds = available.has("legacy-surveys") ? new Set(["legacy-surveys"]) : new Set([...available].slice(0, 1));
    layerLayoutMode = "layers";
    layerInteractionMode = "inspect";
    unassignedWorkspaceVisible = false;
    visibleAssetIds.clear();
    assetVisibilityPreferenceRestored = false;
    visibleWorkspaceLayerKeys.clear();
    workspaceLayerVisibilityPreferenceRestored = false;
    layerOrder = normalizeCurrentLayerOrder([], false);
  }
}

function persistLayerPreferences(): void {
  try {
    const preferences: {
      schemaVersion: number;
      visibleSurveyIds: string[];
      visibleAssetIds: string[];
      visibleWorkspaceLayerKeys?: string[];
      layerOrder: string[];
      layoutMode: SurveyLayerLayoutMode;
      interactionMode: SurveyLayerInteractionMode;
      unassignedWorkspaceVisible: boolean;
    } = {
      // Do not claim that workspace-layer visibility was restored until the
      // first coverage load has populated the extra MOC/Warehouse layers.
      // Otherwise the early empty list would hide ready MOCs after reload.
      schemaVersion: workspaceLayerVisibilityPreferenceRestored ? 5 : 4,
      visibleSurveyIds: [...visibleSurveyIds],
      visibleAssetIds: [...visibleAssetIds],
      layerOrder: normalizeCurrentLayerOrder(),
      layoutMode: layerLayoutMode,
      interactionMode: layerInteractionMode,
      unassignedWorkspaceVisible,
    };
    if (workspaceLayerVisibilityPreferenceRestored) preferences.visibleWorkspaceLayerKeys = [...visibleWorkspaceLayerKeys];
    localStorage.setItem(LAYER_PREFERENCES_KEY, JSON.stringify(preferences));
  } catch {}
}

async function refreshActiveFootprints(before: PublicResourcePackage[], after: PublicResourcePackage[]): Promise<void> {
  const footprints = await workspaceApi.surveyFootprints();
  surveyFootprints = footprints;
  const available = new Set(footprintSurveyIds());
  visibleSurveyIds = new Set([...visibleSurveyIds].filter((surveyId) => available.has(surveyId)));
  const previouslyActive = new Set(before.filter((record) => record.active).map((record) => record.id));
  const newlyActiveSurveys: string[] = [];
  for (const record of after) {
    if (record.active && !previouslyActive.has(record.id) && available.has(record.surveyId)) {
      visibleSurveyIds.add(record.surveyId);
      newlyActiveSurveys.push(`public-survey:${record.surveyId}`);
    }
  }
  selectedLayerRegion = null;
  astroOverview = null;
  workspaceCellSummaries.clear();
  // Add newly activated surveys to layer order, but don't add all known layers
  const knownKeys = new Set(knownLayerOrderKeys());
  const filteredOrder = layerOrder.filter((key) => knownKeys.has(key));
  layerOrder = [...filteredOrder, ...newlyActiveSurveys.filter((key) => !filteredOrder.includes(key))];
  applyLayerOrder(false);
  buildSurveyList();
  persistLayerPreferences();
  if (mode === "layers") await activateMode("layers");
}

function emptySurveyFootprintManifest(): SurveyFootprintManifest {
  return { schemaVersion: 1, generatedAt: new Date(0).toISOString(), coordinateFrame: "ICRS", nside: 16, footprints: [] };
}

async function refreshPublicCatalogData(): Promise<void> {
  const [footprintsResult, surveysResult] = await Promise.allSettled([
    workspaceApi.surveyFootprints(),
    workspaceApi.publicSurveys(),
  ]);
  surveyFootprints = footprintsResult.status === "fulfilled" ? footprintsResult.value : emptySurveyFootprintManifest();
  if (surveysResult.status === "fulfilled") {
    publicSurveyCards = surveysResult.value;
    const records = await Promise.allSettled(publicSurveyCards.map((survey) => workspaceApi.publicSurvey(survey.id)));
    publicSurveyRecordsById.clear();
    records.forEach((result) => { if (result.status === "fulfilled") publicSurveyRecordsById.set(result.value.id, result.value); });
  } else {
    publicSurveyCards = [];
    publicSurveyRecordsById.clear();
  }
  if (mode === "packages") await resourcePackagePanel.reload();
}

function renderResourcePackageDetails(
  record: PublicResourcePackage,
  draftReleaseIds: ReadonlySet<string>,
  callbacks: ResourcePackageSelectionCallbacks,
): void {
  const empty = byId("inspector-empty");
  const content = byId("inspector-content");
  empty.hidden = true;
  content.hidden = false;
  const heading = document.createElement("h2");
  heading.textContent = record.name;
  const summary = document.createElement("p");
  summary.className = "inspector-summary";
  summary.textContent = record.description;
  const metadata = document.createElement("dl");
  const rows: Array<[string, string]> = [
    ["巡天 / 望远镜", record.facilities.join(" / ")],
    ["观测类型", record.modalities.join(" / ")],
    ["波段", record.wavelengths.join(" / ")],
    ["数据产品", record.productTypes.join(" / ")],
    ["服务器状态", record.active ? "已应用到数据覆盖" : record.installedVersion ? "已下载，尚未应用" : "尚未下载"],
  ];
  for (const [label, value] of rows) {
    const row = document.createElement("div");
    const term = document.createElement("dt"); term.textContent = label;
    const detail = document.createElement("dd"); detail.textContent = value;
    row.append(term, detail);
    metadata.append(row);
  }
  const releaseSection = document.createElement("section");
  releaseSection.className = "resource-release-section";
  const releaseHeading = document.createElement("div");
  releaseHeading.className = "section-heading";
  const releaseTitle = document.createElement("span");
  releaseTitle.textContent = "公开版本";
  const releaseCount = document.createElement("output");
  const loadableReleaseIds = [...new Set(record.releases)];
  const fallbackModality = (record.modalities[0] as AssetsSurveyRelease["modalities"][number] | undefined) ?? "catalog";
  const publicReleases: AssetsSurveyRelease[] = record.publicReleases?.length
    ? [...new Map(record.publicReleases.map((release) => [release.id, release])).values()]
    : loadableReleaseIds.map((id) => ({
      id,
      label: record.releaseLabels[id] ?? id,
      kind: "public_release",
      modalities: [fallbackModality],
      products: [{ name: record.productTypes[0] ?? record.name, modality: fallbackModality, description: record.description, status: "acquired" }],
    }));
  releaseCount.textContent = `${publicReleases.length} 个公开版本 · ${loadableReleaseIds.length} 个可应用`;
  releaseHeading.append(releaseTitle, releaseCount);
  const releaseChoices = document.createElement("div");
  releaseChoices.className = "resource-release-choices";
  for (const release of publicReleases) {
    const releaseId = release.id;
    const loadable = loadableReleaseIds.includes(releaseId);
    const productStatuses = new Set(release.products.map((product) => product.status));
    const availabilityLabel = loadable
      ? "天空覆盖已收录"
      : productStatuses.has("awaiting_geometry")
        ? "等待 Assets 几何"
        : productStatuses.has("overview_only")
          ? "仅有官方概览"
          : productStatuses.has("acquired")
            ? "等待资源包"
            : "暂无可应用几何";
    const label = release.label;
    const choice = document.createElement("div");
    choice.className = "resource-release-choice";
    choice.dataset.coverageAvailable = String(loadable);
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = loadable && draftReleaseIds.has(releaseId);
    checkbox.disabled = !loadable;
    checkbox.setAttribute("aria-label", `选择 ${label} 天空覆盖`);
    if (!loadable) checkbox.title = availabilityLabel;
    checkbox.addEventListener("change", () => {
      const next = new Set(draftReleaseIds);
      if (checkbox.checked) next.add(releaseId); else next.delete(releaseId);
      callbacks.setDraftReleases(next);
    });
    const copy = document.createElement("span");
    copy.className = "resource-release-copy";
    const header = document.createElement("span");
    header.className = "resource-release-header";
    const title = document.createElement("strong");
    title.textContent = label;
    const availability = document.createElement("small");
    availability.className = "resource-release-availability";
    availability.dataset.available = String(loadable);
    availability.textContent = availabilityLabel;
    header.append(title, availability);
    const detail = document.createElement("small");
    const source = record.sources.find((entry) => entry.releaseId === releaseId);
    const product = release.products[0];
    detail.textContent = source && loadable
      ? `${source.authority} · ${source.label}`
      : product?.description ?? releaseId;
    copy.append(header, detail);
    choice.append(checkbox, copy);
    releaseChoices.append(choice);
  }
  const releaseBulk = document.createElement("div");
  releaseBulk.className = "inspector-actions compact-actions";
  const selectAll = document.createElement("button");
  selectAll.type = "button";
  selectAll.className = "command-button secondary";
  selectAll.textContent = "选择全部";
  selectAll.disabled = loadableReleaseIds.length === 0;
  selectAll.addEventListener("click", () => callbacks.setDraftReleases(loadableReleaseIds));
  const clearAll = document.createElement("button");
  clearAll.type = "button";
  clearAll.className = "command-button secondary";
  clearAll.textContent = "全部取消";
  clearAll.addEventListener("click", () => callbacks.setDraftReleases([]));
  releaseBulk.append(selectAll, clearAll);
  releaseSection.append(releaseHeading, releaseChoices, releaseBulk);

  const actions = document.createElement("div");
  actions.className = "inspector-actions resource-inspector-actions";
  if (record.installedVersion) {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "command-button danger";
    remove.textContent = "卸载资源";
    remove.title = "从天球移除并删除当前服务器中的公开覆盖文件";
    remove.addEventListener("click", () => void callbacks.remove().catch((error) => notifyWorkspace("资源包卸载失败", error instanceof Error ? error.message : String(error), { tone: "error" })));
    actions.append(remove);
  }
  content.replaceChildren(heading, summary, metadata, releaseSection, actions);
}

function applyLayerPreferences(): void {
  applyLayerOrder();
  layerViewer?.setLayoutMode(layerLayoutMode);
  layerViewer?.setVisibleSurveys(new Set([...visibleSurveyIds, ...(unassignedWorkspaceVisible ? ["__unassigned__"] : [])]));
  layerViewer?.setVisibleAssets(visibleAssetIds);
  layerViewer?.setVisibleWorkspaceLayerKeys(visibleWorkspaceLayerKeys);
  layerViewer?.setInteractionMode(layerInteractionMode);
  buildSurveyList();
  persistLayerPreferences();
}

function chooseLayerInteraction(nextMode: SurveyLayerInteractionMode): void {
  layerInteractionMode = nextMode;
  applyLayerPreferences();
}

function setSurveyVisibility(surveyId: string, visible: boolean): void {
  if (visible) visibleSurveyIds.add(surveyId);
  else visibleSurveyIds.delete(surveyId);
  if (selectedSurvey?.id === surveyId && !visible) selectedSurvey = null;
  applyLayerPreferences();
}

function setAssetVisibility(assetId: string, visible: boolean): void {
  if (visible) visibleAssetIds.add(assetId);
  else visibleAssetIds.delete(assetId);
  if (selectedLayerAssetId === assetId && !visible) selectedLayerAssetId = null;
  applyLayerPreferences();
}

function setUnassignedWorkspaceVisibility(visible: boolean): void {
  unassignedWorkspaceVisible = visible;
  applyLayerPreferences();
}

function setWorkspaceLayerVisibility(key: string, visible: boolean): void {
  if (visible) visibleWorkspaceLayerKeys.add(key);
  else visibleWorkspaceLayerKeys.delete(key);
  workspaceLayerVisibilityPreferenceRestored = true;
  applyLayerPreferences();
}

function soloSurvey(surveyId: string): void {
  visibleSurveyIds = new Set([surveyId]);
  applyLayerPreferences();
  layerViewer?.focusSurvey(surveyId);
}

function renderSurveyDetails(survey: SurveyRecord): void {
  const empty = byId("inspector-empty");
  const content = byId("inspector-content");
  empty.hidden = true;
  content.hidden = false;
  content.replaceChildren();
  const heading = document.createElement("h2");
  heading.textContent = survey.name;
  const summary = document.createElement("p");
  summary.className = "inspector-summary";
  summary.textContent = survey.description;
  const metadata = document.createElement("dl");
  const detailRows: Array<[string, string]> = [
    ["Mission", survey.mission],
    ["Modalities", survey.modalities.join(" / ")],
    ["Releases", String(survey.releases.length)],
    ["Footprint artifacts", `${footprintsForSurvey(survey.id).length} release/product MOC(s)`],
  ];
  for (const [label, value] of detailRows) {
    const row = document.createElement("div");
    const term = document.createElement("dt");
    const detail = document.createElement("dd");
    term.textContent = label;
    detail.textContent = value;
    row.append(term, detail);
    metadata.append(row);
  }
  const releases = document.createElement("div");
  releases.className = "release-list";
  survey.releases.forEach((entry) => {
    const artifacts = footprintsForSurvey(survey.id).filter((footprint) => footprint.releaseId === entry.id);
    const item = document.createElement("article");
    item.className = "release-row";
    const title = document.createElement("strong");
    title.textContent = entry.label;
    const status = document.createElement("span");
    status.textContent = artifacts.length ? `${artifacts.length} ${artifacts.some((artifact) => artifact.quality === "moc") ? "MOC" : "OVERVIEW"}` : entry.availability === "available" ? footprintLabel(entry.coverage.status) : entry.availability.toUpperCase();
    status.dataset.status = artifacts.length ? "verified" : entry.coverage.status;
    const line = document.createElement("div");
    line.append(title, status);
    const detail = document.createElement("p");
    detail.textContent = `${entry.phase ? `${entry.phase} / ` : ""}${entry.modalities.join(", ")} / ${artifacts.length ? artifacts.map((artifact) => artifact.notes).join(" ") : entry.coverage.summary}`;
    const source = document.createElement("a");
    source.href = artifacts[0]?.sourceUrl ?? entry.coverage.sourceUrl;
    source.target = "_blank";
    source.rel = "noreferrer";
    source.textContent = "Source";
    item.append(line, detail, source);
    releases.append(item);
  });
  content.replaceChildren(heading, summary, metadata, releases);
}

function remoteCoverageSurveyRecords(): SurveyRecord[] {
  const records = new Map<string, SurveyRecord>();
  [...localSurveyRecordsById.values(), ...publicSurveyRecordsById.values()].forEach((record) => records.set(record.id, record));
  return [...records.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function remoteCoverageRecordForSurvey(id: string): SurveyRecord | undefined {
  return localSurveyRecordsById.get(id) ?? publicSurveyRecordsById.get(id);
}

function assetHasS3Connector(asset: DataAssetRecord): boolean {
  return [asset.access, ...(asset.accesses ?? [])].some((access) => access.connector === "s3");
}

function assetHasLocalConnector(asset: DataAssetRecord): boolean {
  return [asset.access, ...(asset.accesses ?? [])].some((access) => access.connector === "local");
}

function linkedS3Connectors(asset: DataAssetRecord, connectors: readonly ConnectorPublicRecord[]): ConnectorPublicRecord[] {
  const connectorIds = new Set([...(asset.connectorIds ?? []), ...[asset.access, ...(asset.accesses ?? [])].map((access) => access.connectorId).filter((id): id is string => Boolean(id))]);
  const connectorLocations = new Set([...(asset.connectorLocationKeys ?? []), ...[asset.access, ...(asset.accesses ?? [])].map((access) => access.uri)]);
  return connectors.filter((connector) => connector.kind === "s3" && (connectorIds.has(connector.id) || connectorLocations.has(connector.locationKey)));
}

function populateRemoteCoverageReleaseOptions(preferredReleaseId?: string): void {
  const surveySelect = byId<HTMLSelectElement>("remote-coverage-survey");
  const releaseSelect = byId<HTMLSelectElement>("remote-coverage-release");
  const record = remoteCoverageRecordForSurvey(surveySelect.value);
  const options = [new Option("选择发布", "")];
  record?.releases.forEach((release) => options.push(new Option(`${release.label} · ${release.id}`, release.id)));
  if (preferredReleaseId && !options.some((option) => option.value === preferredReleaseId)) {
    options.push(new Option(`${preferredReleaseId}（资产标签）`, preferredReleaseId));
  }
  releaseSelect.replaceChildren(...options);
  const defaultRelease = preferredReleaseId && options.some((option) => option.value === preferredReleaseId)
    ? preferredReleaseId
    : record?.releases[0]?.id ?? "";
  releaseSelect.value = defaultRelease;
}

function syncRemoteCoverageMode(): void {
  const mode = byId<HTMLSelectElement>("remote-coverage-mode").value as CoverageJobMode;
  const catalogFields = byId<HTMLFieldSetElement>("remote-coverage-catalog-fields");
  const healpixFields = byId<HTMLFieldSetElement>("remote-coverage-healpix-fields");
  const catalogMode = mode === "catalog-radec";
  const healpixMode = mode === "nested-healpix";
  catalogFields.hidden = !catalogMode;
  catalogFields.disabled = !catalogMode;
  healpixFields.hidden = !healpixMode;
  healpixFields.disabled = !healpixMode;
  byId<HTMLInputElement>("remote-coverage-ra-column").required = catalogMode;
  byId<HTMLInputElement>("remote-coverage-dec-column").required = catalogMode;
  byId<HTMLInputElement>("remote-coverage-healpix-column").required = healpixMode;
  byId<HTMLInputElement>("remote-coverage-healpix-order").required = healpixMode;
  byId("remote-coverage-mode-note").textContent = mode === "fits-wcs"
    ? "FITS WCS 必须声明 ICRS；扫描结果会生成图像范围 MOC，查询投影固定为 order 8，预览固定为 order 4。"
    : "Assets Core 会以 ICRS、NESTED order 10 生成用户 MOC；查询投影固定为 order 8，预览固定为 order 4。";
}

function populateRemoteCoverageForm(asset: DataAssetRecord, connectors: readonly ConnectorPublicRecord[]): void {
  remoteCoverageAssetId = asset.id;
  const surveySelect = byId<HTMLSelectElement>("remote-coverage-survey");
  const surveyOptions = [new Option("选择巡天", "")];
  remoteCoverageSurveyRecords().forEach((survey) => surveyOptions.push(new Option(`${survey.name} · ${survey.id}`, survey.id)));
  if (asset.surveyId && !surveyOptions.some((option) => option.value === asset.surveyId)) {
    surveyOptions.push(new Option(`${asset.surveyId}（资产标签）`, asset.surveyId));
  }
  surveySelect.replaceChildren(...surveyOptions);
  surveySelect.value = asset.surveyId && surveyOptions.some((option) => option.value === asset.surveyId)
    ? asset.surveyId
    : remoteCoverageSurveyRecords()[0]?.id ?? "";
  populateRemoteCoverageReleaseOptions(asset.releaseId);

  const connectorSelect = byId<HTMLSelectElement>("remote-coverage-connector");
  const connectorOptions = [new Option("选择 Connector", "")];
  connectors.forEach((connector) => connectorOptions.push(new Option(`${connector.name} · ${connector.displayPath}`, connector.id)));
  connectorSelect.replaceChildren(...connectorOptions);
  const preferredConnector = asset.connectorIds?.find((id) => connectors.some((connector) => connector.id === id))
    ?? connectors[0]?.id
    ?? "";
  connectorSelect.value = preferredConnector;

  byId<HTMLInputElement>("remote-coverage-product").value = asset.product;
  byId<HTMLInputElement>("remote-coverage-path").value = asset.sourceRelativePath ?? "";
  const defaultMode: CoverageJobMode = asset.scanSpec?.format === "csv"
    ? "catalog-radec"
    : asset.kind === "image" || asset.kind === "cube" ? "fits-wcs" : "catalog-radec";
  byId<HTMLSelectElement>("remote-coverage-mode").value = defaultMode;
  byId<HTMLInputElement>("remote-coverage-ra-column").value = asset.scanSpec?.raColumn ?? "ra";
  byId<HTMLInputElement>("remote-coverage-dec-column").value = asset.scanSpec?.decColumn ?? "dec";
  byId<HTMLSelectElement>("remote-coverage-coordinate-units").value = asset.scanSpec?.coordinateUnits ?? "deg";
  byId<HTMLInputElement>("remote-coverage-healpix-column").value = "healpix";
  byId<HTMLInputElement>("remote-coverage-healpix-order").value = "8";
  syncRemoteCoverageMode();
}

async function openRemoteCoverageDialog(asset: DataAssetRecord): Promise<void> {
  try {
    const capabilities = workspaceCapabilities ?? await workspaceApi.capabilities();
    workspaceCapabilities = capabilities;
    if (!capabilities.dataWarehouse.enabled) throw new Error("Warehouse 远程执行已禁用；Workspace 本地 ES 仍可继续使用。");
    if (capabilities.dataWarehouse.configured === false) throw new Error("Warehouse Elasticsearch 尚未配置。");
    workspaceConnectors = await workspaceApi.connectors();
    const connectors = linkedS3Connectors(asset, workspaceConnectors);
    if (!connectors.length) throw new Error("该资产没有可用的已关联 S3 / OSS Connector。");
    populateRemoteCoverageForm(asset, connectors);
    const dialog = byId<HTMLDialogElement>("remote-coverage-dialog");
    if (!dialog.open) dialog.showModal();
  } catch (error) {
    notifyWorkspace("无法打开远程覆盖扫描", error instanceof Error ? error.message : String(error), { tone: "warning" });
  }
}

function remoteCoverageInput(): RemoteCoverageScanInput {
  const mode = byId<HTMLSelectElement>("remote-coverage-mode").value as CoverageJobMode;
  const coverage: CoverageJobSpec = {
    mode,
    coordinateFrame: "ICRS",
    coverageRole: mode === "fits-wcs" ? "image_extent" : "object_presence",
    // Catalog coordinates describe source presence; FITS-WCS coverage is an
    // observed image extent unless a future recipe supplies a more specific
    // origin classification.
    dataOrigin: mode === "fits-wcs" ? "observed" : "catalog",
    sourceTier: "user_file_derived",
    maxOrder: 10,
    queryOrder: 8,
    previewOrder: 4,
    ...(mode === "catalog-radec" ? {
      coordinateUnits: byId<HTMLSelectElement>("remote-coverage-coordinate-units").value as CoverageCoordinateUnits,
      raColumn: byId<HTMLInputElement>("remote-coverage-ra-column").value.trim(),
      decColumn: byId<HTMLInputElement>("remote-coverage-dec-column").value.trim(),
    } : {}),
    ...(mode === "nested-healpix" ? {
      healpixColumn: byId<HTMLInputElement>("remote-coverage-healpix-column").value.trim(),
      healpixOrder: Number(byId<HTMLInputElement>("remote-coverage-healpix-order").value),
    } : {}),
  };
  const pathValue = byId<HTMLInputElement>("remote-coverage-path").value.trim();
  return {
    surveyId: byId<HTMLSelectElement>("remote-coverage-survey").value,
    connectorId: byId<HTMLSelectElement>("remote-coverage-connector").value,
    releaseId: byId<HTMLSelectElement>("remote-coverage-release").value,
    product: byId<HTMLInputElement>("remote-coverage-product").value.trim(),
    ...(pathValue ? { path: pathValue } : {}),
    coverage,
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

const remoteCoverageWatchers = new Set<string>();

async function watchRemoteCoverageScan(assetId: string, runId: string): Promise<void> {
  if (remoteCoverageWatchers.has(runId)) return;
  remoteCoverageWatchers.add(runId);
  try {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await delay(3000);
      const [runs] = await Promise.all([
        workspaceApi.dataAssetScanRuns(assetId),
        refreshWorkspaceAssets(assetId).catch((error) => {
          console.warn("Unable to refresh remote coverage", error);
        }),
      ]);
      const run = runs.find((candidate) => candidate.id === runId);
      if (!run || run.status === "failed" || (run.status === "succeeded" && run.mocStatus !== "pending")) {
        if (run?.status === "succeeded" && run.mocStatus === "ready") {
          notifyWorkspace("用户 MOC 已生成", dataAssets.find((asset) => asset.id === assetId)?.name ?? assetId, { tone: "success" });
        } else if (run?.status === "failed" || run?.mocStatus === "failed") {
          notifyWorkspace("远程覆盖扫描失败", run.error ?? "Warehouse 未返回可用覆盖", { tone: "error" });
        }
        return;
      }
    }
    notifyWorkspace("远程覆盖仍在后台执行", "可稍后重新打开该资产查看 MOC 状态。", { tone: "info" });
  } finally {
    remoteCoverageWatchers.delete(runId);
  }
}

function setupRemoteCoverageDialog(): void {
  const dialog = byId<HTMLDialogElement>("remote-coverage-dialog");
  const form = byId<HTMLFormElement>("remote-coverage-form");
  const close = (): void => {
    remoteCoverageAssetId = null;
    if (dialog.open) dialog.close();
  };
  byId<HTMLButtonElement>("remote-coverage-dialog-close").addEventListener("click", close);
  byId<HTMLButtonElement>("remote-coverage-form-cancel").addEventListener("click", close);
  dialog.addEventListener("cancel", () => { remoteCoverageAssetId = null; });
  byId<HTMLSelectElement>("remote-coverage-survey").addEventListener("change", () => populateRemoteCoverageReleaseOptions());
  byId<HTMLSelectElement>("remote-coverage-mode").addEventListener("change", syncRemoteCoverageMode);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!form.reportValidity() || !remoteCoverageAssetId) return;
    const assetId = remoteCoverageAssetId;
    const submit = byId<HTMLButtonElement>("remote-coverage-form-submit");
    submit.disabled = true;
    let input: RemoteCoverageScanInput;
    try {
      input = remoteCoverageInput();
    } catch (error) {
      notifyWorkspace("远程覆盖扫描参数无效", error instanceof Error ? error.message : String(error), { tone: "error" });
      submit.disabled = false;
      return;
    }
    const asset = dataAssets.find((candidate) => candidate.id === assetId);
    notifyWorkspace("正在提交远程覆盖扫描", asset?.name ?? assetId, { tone: "info" });
    void workspaceApi.executeDataAssetRemoteScan(assetId, input)
      .then((run) => {
        close();
        notifyWorkspace("远程覆盖扫描已提交", `${asset?.name ?? assetId} · ${run.taskKind ?? "user_coverage"}`, { tone: "success" });
        return refreshWorkspaceAssets(assetId).catch((error) => {
          console.warn("Unable to refresh submitted remote coverage", error);
        }).then(() => { void watchRemoteCoverageScan(assetId, run.id).catch((error) => {
          console.warn("Unable to monitor remote coverage", error);
          notifyWorkspace("远程覆盖状态暂时不可用", "可稍后重新打开该资产查看任务状态。", { tone: "warning", dedupeMs: 5_000 });
        }); });
      })
      .catch((error) => notifyWorkspace("远程覆盖扫描提交失败", error instanceof Error ? error.message : String(error), { tone: "error" }))
      .finally(() => { submit.disabled = false; });
  });
}

function renderLayerAssetDetails(asset: DataAssetRecord): void {
  selectedLayerAssetId = asset.id;
  const layer = workspaceAssetLayers.get(asset.id);
  const scan = asset.scanSpec;
  const operational = coverageStatusesByAsset.get(asset.id);
  const actions: HTMLButtonElement[] = [];
  const runLocalScan = (): void => {
    if (!scan) return;
    const scanButton = actions.find((button) => button.dataset.action === "local-scan");
    if (scanButton) scanButton.disabled = true;
    notifyWorkspace("正在提交用户资产扫描", asset.name, { tone: "info" });
    void workspaceApi.executeDataAssetLocalScan(asset.id)
      .then((run) => {
        notifyWorkspace("用户资产扫描已提交", `${asset.name} · ${run.taskKind ?? "user_scan"}`, { tone: "success" });
        return refreshWorkspaceAssets(asset.id).catch((error) => {
          notifyWorkspace("用户资产覆盖刷新失败", error instanceof Error ? error.message : String(error), { tone: "warning" });
        });
      })
      .catch((error) => notifyWorkspace("用户资产扫描失败", error instanceof Error ? error.message : String(error), { tone: "error" }))
      .finally(() => { if (scanButton) scanButton.disabled = false; });
  };
  if (scan && assetHasLocalConnector(asset) && (operational?.nextAction === "scan_local" || operational?.nextAction === "retry" || !operational)) {
    const scanButton = actionButton(operational?.nextAction === "retry" ? "重试本地扫描" : "扫描本地文件", runLocalScan);
    scanButton.dataset.action = "local-scan";
    actions.push(scanButton);
  }
  if (assetHasS3Connector(asset) && (operational?.nextAction === "scan_remote" || operational?.nextAction === "retry" || operational?.nextAction === "configure_index" || !operational)) {
    const warehouseDisabled = workspaceCapabilities?.dataWarehouse.enabled === false || workspaceCapabilities?.dataWarehouse.configured === false;
    const remoteButton = actionButton(operational?.nextAction === "retry" ? "重试远程扫描" : warehouseDisabled ? "Warehouse 未启用" : "提交远程覆盖扫描", () => {
      void openRemoteCoverageDialog(asset);
    });
    remoteButton.disabled = warehouseDisabled;
    remoteButton.title = warehouseDisabled ? "当前 Workspace 未配置可用的 Warehouse；本地 ES 不受影响" : "使用 Warehouse 读取 S3 / OSS 并生成用户 MOC";
    actions.push(remoteButton);
  }
  if (operational?.nextAction === "configure_connector") {
    actions.push(actionButton("配置可扫描 Connector", () => {
      void activateMode("connectors").catch(showFatal);
    }));
  }
  if (operational?.nextAction === "configure_index") {
    const hint = actionButton("查看空间索引配置", () => {
      notifyWorkspace("空间索引尚未配置", "请配置 ASTRO_ES_URL 或启用 Warehouse 后重新扫描。", { tone: "warning" });
    });
    hint.disabled = true;
    actions.push(hint);
  }
  const coverageState = operational?.coverage ?? (layer?.coverageStatus === "pending" || layer?.status === "pending" ? "pending" : layer?.coverageStatus === "ready" && layer.pixels.length ? "ready" : layer?.coverageStatus === "error" ? "failed" : layer?.coverageStatus === "unavailable" ? "unavailable" : "not_started");
  const coverage = coverageState === "pending"
    ? "处理中"
    : coverageState === "ready"
      ? layer?.pixels.length ? `${formatInteger(layer.pixels.length)} 个 HEALPix 单元 · ${formatInteger(layer.objectCount ?? 0)} 个对象` : "已建立，但覆盖为空"
      : coverageState === "empty" ? "已完成但为空"
        : coverageState === "failed" ? operational?.message ?? layer?.message ?? "扫描失败"
          : coverageState === "unavailable" ? operational?.message ?? "空间索引不可用"
            : "未开始";
  const nextAction = operational?.nextAction ? (NEXT_ACTION_LABELS[operational.nextAction] ?? operational.nextAction) : "--";
  const projectState = asset.projectState === "acquired"
    ? "已掌握（已登记访问权，不代表已有空间覆盖）"
    : PROJECT_STATE_LABELS[asset.projectState] ?? asset.projectState;
  inspectorRows(asset.name, [
    ["巡天 / 发布", `${asset.surveyId ?? "未关联"} / ${asset.releaseId ?? "未关联"}`],
    ["数据类型", asset.kind],
    ["使用阶段", projectState],
    ["覆盖状态", `${COVERAGE_STATE_LABELS[coverageState] ?? coverageState}${coverage && coverage !== COVERAGE_STATE_LABELS[coverageState] ? ` · ${coverage}` : ""}`],
    ["对象查询", operational?.objects === "queryable" ? "可查询" : operational?.objects === "unavailable" ? "索引不可用" : "尚未建立对象索引"],
    ["下一步", nextAction],
    ...(operational?.message ? [["说明", operational.message] as [string, string]] : []),
    ["CSV 文件", asset.sourceRelativePath ?? "未指定"],
    ["对象列", scan ? `${scan.objectIdColumn} · RA ${scan.raColumn} · Dec ${scan.decColumn}` : "未配置 CSV scanSpec"],
  ], actions);
}

function workspaceLayerStatusLabel(layer: WorkspaceCoverageLayer): string {
  const coverage = layer.status === "ready"
    ? layer.pixels.length ? `${formatInteger(layer.pixels.length)} 个 HEALPix 单元` : "已完成，覆盖为空"
    : layer.status === "pending" ? "处理中"
      : layer.status === "error" ? layer.message ?? "执行失败"
        : layer.message ?? "尚未可用";
  const latest = layer.latestMocStatus;
  if (latest && latest !== "ready" && layer.status === "ready") {
    return `${coverage}；最新 MOC ${latest === "pending" ? "处理中" : latest === "failed" ? "失败" : "不可用"}`;
  }
  return coverage;
}

function renderWorkspaceLayerDetails(layer: WorkspaceCoverageLayer): void {
  const artifact = layer.artifactId ? userMocArtifacts.get(layer.artifactId) : undefined;
  const source = layer.key?.startsWith("warehouse:") ? "Warehouse 用户层" : "Workspace 用户 MOC";
  const rows: Array<[string, string]> = [
    ["来源", source],
    ["状态", workspaceLayerStatusLabel(layer)],
    ["Layer ID", layer.layerId ?? "--"],
    ["巡天 / 发布", `${layer.surveyId ?? "未关联"} / ${layer.releaseId ?? "未关联"}`],
    ["产品 / 模态", `${layer.productId ?? "--"} / ${layer.modality ?? "--"}`],
    ["覆盖角色", layer.coverageRole ?? "--"],
    ["可用 order", layer.availableOrders?.length ? layer.availableOrders.join(", ") : "--"],
    ["精度", layer.precision ?? "--"],
    ...(layer.latestMocStatus && layer.latestMocStatus !== layer.mocStatus ? [["最新 MOC", layer.latestMocStatus] as [string, string]] : []),
  ];
  const actions: HTMLButtonElement[] = [];
  if (artifact?.files.some((file) => file.name === "moc.fits")) {
    actions.push(actionButton("下载用户 MOC", () => {
      const link = document.createElement("a");
      link.href = `/api/user-mocs/${encodeURIComponent(artifact.layerId)}/${encodeURIComponent(artifact.scanRunId)}/moc.fits`;
      link.download = `${artifact.layerId}-${artifact.scanRunId}.moc.fits`;
      link.click();
    }));
  }
  inspectorRows(layer.key?.startsWith("warehouse:") ? (layer.productId ?? "Warehouse 用户层") : "用户 MOC", rows, actions);
}

function moveLayer(key: string, targetIndex: number): void {
  const next = [...layerOrder];
  const currentIndex = next.indexOf(key);
  if (currentIndex < 0) return;
  next.splice(currentIndex, 1);
  next.splice(Math.max(0, Math.min(targetIndex, next.length)), 0, key);
  layerOrder = next;
  applyLayerOrder(false);
  buildSurveyList();
  persistLayerPreferences();
}

function buildSurveyList(): void {
  const list = byId("sky-layer-list");
  const publicLayers = new Map(footprintSurveyIds().map((surveyId) => [`public-survey:${surveyId}`, publicSurveyCards.find((survey) => survey.id === surveyId)!]));
  const assetLayers = new Map(userDataAssets().map((asset) => [`asset:${asset.id}`, asset]));
  if (!publicLayers.size && !assetLayers.size && !workspaceExtraLayers.size && !hasUnassignedWorkspaceCoverage) {
    const empty = document.createElement("p");
    empty.className = "survey-list-empty";
    empty.textContent = "暂无可显示的数据覆盖。请应用公开资源或扫描用户资产。";
    list.replaceChildren(empty);
    return;
  }

  const cards = layerOrder.map((key, index) => {
    const survey = publicLayers.get(key);
    const asset = assetLayers.get(key);
    const workspaceLayer = workspaceExtraLayers.get(key);
    const isUnassigned = key === "workspace-unassigned" && hasUnassignedWorkspaceCoverage;
    if (!survey && !asset && !workspaceLayer && !isUnassigned) return null;
    const card = document.createElement("article");
    card.className = "survey-card";
    card.dataset.layerKey = key;
    card.draggable = true;
    const visible = survey
      ? visibleSurveyIds.has(survey.id)
      : asset
        ? visibleAssetIds.has(asset.id)
        : workspaceLayer
          ? visibleWorkspaceLayerKeys.has(key)
          : unassignedWorkspaceVisible;
    card.classList.toggle("visible", visible);
    if (asset) card.classList.add("workspace-asset-card");
    if (workspaceLayer) card.classList.add("workspace-extra-card");
    if (isUnassigned) card.classList.add("workspace-unassigned");

    const handle = document.createElement("button");
    handle.type = "button";
    handle.className = "layer-drag-handle";
    handle.title = "拖拽排序图层";
    handle.setAttribute("aria-label", `调整 ${survey?.name ?? asset?.name ?? workspaceLayer?.productId ?? "用户图层"} 图层顺序`);
    const handleIcon = document.createElement("i");
    handleIcon.dataset.lucide = "grip-vertical";
    handle.append(handleIcon);
    handle.addEventListener("keydown", (event) => {
      if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
      event.preventDefault();
      moveLayer(key, index + (event.key === "ArrowUp" ? -1 : 1));
    });
    card.addEventListener("dragstart", (event) => {
      if (!(event.target instanceof Element) || !event.target.closest(".layer-drag-handle")) {
        event.preventDefault();
        return;
      }
      event.dataTransfer?.setData("text/plain", key);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
      card.dataset.dragging = "true";
    });
    card.addEventListener("dragend", () => {
      delete card.dataset.dragging;
      list.querySelectorAll<HTMLElement>("[data-drop-target]").forEach((element) => delete element.dataset.dropTarget);
    });
    card.addEventListener("dragover", (event) => {
      event.preventDefault();
      card.dataset.dropTarget = "true";
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    });
    card.addEventListener("dragleave", () => delete card.dataset.dropTarget);
    card.addEventListener("drop", (event) => {
      event.preventDefault();
      const moved = event.dataTransfer?.getData("text/plain");
      if (!moved || moved === key) return;
      let destination = index + (event.clientY > card.getBoundingClientRect().top + card.clientHeight / 2 ? 1 : 0);
      if (layerOrder.indexOf(moved) < destination) destination -= 1;
      moveLayer(moved, destination);
    });

    const visibility = document.createElement("label");
    visibility.className = "survey-visibility";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = visible;
    checkbox.setAttribute("aria-label", `显示 ${survey?.name ?? asset?.name ?? workspaceLayer?.productId ?? "用户图层"}`);
    checkbox.addEventListener("change", () => {
      if (survey) setSurveyVisibility(survey.id, checkbox.checked);
      else if (asset) setAssetVisibility(asset.id, checkbox.checked);
      else if (workspaceLayer) setWorkspaceLayerVisibility(key, checkbox.checked);
      else setUnassignedWorkspaceVisibility(checkbox.checked);
    });
    const swatch = document.createElement("i");
    swatch.style.background = survey?.color ?? (asset ? workspaceAssetColor(asset.id) : workspaceLayer ? workspaceAssetColor(key) : "#d69b4e");
    visibility.append(checkbox, swatch);

    const body = document.createElement("div");
    body.className = "survey-card-body";
    body.tabIndex = 0;
    const activate = (): void => {
      if (survey) void selectSurvey(survey.id, "public").catch(showFatal);
      else if (asset) { selectedLayerAssetId = asset.id; renderLayerAssetDetails(asset); }
      else if (workspaceLayer) renderWorkspaceLayerDetails(workspaceLayer);
    };
    body.addEventListener("click", activate);
    body.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); activate(); }
    });
    const name = document.createElement("span");
    const workspaceAsset = workspaceLayer
      ? dataAssets.find((candidate) => coverageLayerAssetIds(workspaceLayer).includes(candidate.id))
      : undefined;
    const workspaceLabel = workspaceLayer?.assetName ?? workspaceAsset?.name ?? workspaceLayer?.productId ?? workspaceLayer?.layerId ?? "用户层";
    name.textContent = survey?.name ?? asset?.name ?? (workspaceLayer?.key?.startsWith("warehouse:") ? `Warehouse · ${workspaceLabel}` : workspaceLayer ? `MOC · ${workspaceLabel}` : "未设置巡天标签");
    const count = document.createElement("b");
    const metadata = document.createElement("small");
    if (survey) {
      const footprints = footprintsForSurvey(survey.id);
      count.textContent = `${footprints.length}/${survey.releaseCount} MOC`;
      metadata.textContent = `${survey.mission} · PUBLIC FOOTPRINT`;
    } else if (asset) {
      const layer = workspaceAssetLayers.get(asset.id);
      const operational = coverageStatusesByAsset.get(asset.id);
      const coverageState = operational?.coverage ?? (layer?.status === "pending" || layer?.coverageStatus === "pending" ? "pending" : layer?.pixels.length ? "ready" : layer?.status === "error" || layer?.coverageStatus === "error" ? "failed" : "not_started");
      count.textContent = COVERAGE_STATE_LABELS[coverageState] ?? coverageState;
      metadata.textContent = [asset.surveyId ?? "未设置巡天标签", asset.releaseId ?? "未设置发布标签", layer?.objectCount !== undefined ? `${formatInteger(layer.objectCount)} OBJECTS` : undefined].filter(Boolean).join(" · ");
    } else if (workspaceLayer) {
      count.textContent = workspaceLayer.status === "ready" ? `${formatInteger(workspaceLayer.pixels.length)} CELLS` : workspaceLayer.status === "pending" ? "PENDING" : workspaceLayer.status === "error" ? "FAILED" : "UNAVAILABLE";
      metadata.textContent = [workspaceLayer.source === "warehouse" ? "WAREHOUSE" : "USER MOC", workspaceLayer.surveyId, workspaceLayer.releaseId, workspaceLayer.precision].filter(Boolean).join(" · ");
    } else {
      count.textContent = "WORKSPACE";
      metadata.textContent = "仅显示未设置巡天标签的工作区覆盖";
    }
    body.append(name, count, metadata);

    card.append(handle, visibility, body);
    return card;
  }).filter((card): card is HTMLElement => card !== null);
  list.replaceChildren(...cards);
  createIcons({ icons: { GripVertical }, attrs: { "aria-hidden": "true" } });
}

async function selectSurvey(id: string, scope: "local" | "public" = "local"): Promise<void> {
  const cached = scope === "public" ? publicSurveyRecordsById.get(id) : localSurveyRecordsById.get(id);
  selectedSurvey = cached ? structuredClone(cached) : scope === "public" ? await workspaceApi.publicSurvey(id) : await workspaceApi.survey(id);
  if (scope === "public") publicSurveyRecordsById.set(id, selectedSurvey);
  else localSurveyRecordsById.set(id, selectedSurvey);
  buildSurveyList();
  renderSurveyDetails(selectedSurvey);
  if (window.innerWidth <= 1040) byId("inspector-panel").classList.add("mobile-open");
}

async function activateMode(nextMode: ViewMode): Promise<void> {
  if (nextMode === "layers" && !surveyFootprints) throw new Error("Survey footprint catalog is not configured");
  mode = nextMode;
  destroyViewer();
  // Coverage uses four semantic metrics and hides the fifth slot. Restore the
  // slot before switching to any other view so its metrics remain visible.
  byId("metric-five").parentElement?.removeAttribute("hidden");
  setActiveButtons("[data-mode]", (button) => button.dataset.mode === mode);
  byId("catalog-controls").hidden = mode !== "catalog";
  byId("resource-package-controls").hidden = mode !== "packages";
  byId("connector-controls").hidden = mode !== "connectors";
  byId("layer-controls").hidden = mode !== "layers";
  byId("workflow-controls").hidden = mode !== "workflow";
  byId("system-controls").hidden = mode !== "system";
  byId("catalog-stage").hidden = mode !== "catalog";
  byId("resource-package-stage").hidden = mode !== "packages";
  byId("connector-stage").hidden = mode !== "connectors";
  byId("scene-stage").hidden = mode === "workflow" || mode === "system" || mode === "catalog" || mode === "connectors" || mode === "packages";
  sceneBackgroundPopover.hidden = true;
  byId("aladin-explorer").hidden = true;
  byId("aladin-controls").hidden = true;
  byId("workflow-stage").hidden = true;
  byId("production-stage").hidden = mode !== "workflow";
  byId("system-stage").hidden = mode !== "system";
  document.querySelectorAll<HTMLElement>(".scene-action").forEach((element) => { element.hidden = mode === "workflow" || mode === "system" || mode === "catalog" || mode === "connectors" || mode === "packages"; });
  byId("scene-legend").hidden = false;
  byId("region-scene-legend").hidden = mode !== "layers";
  byId<HTMLButtonElement>("drill-back-button").disabled = true;
  byId("context-summary").hidden = false;
  document.querySelector<HTMLElement>(".workspace-shell")?.classList.toggle("workflow-active", mode === "workflow");
  document.querySelector<HTMLElement>(".workspace-shell")?.classList.toggle("system-active", mode === "system");
  document.querySelector<HTMLElement>(".workspace-shell")?.classList.toggle("catalog-active", mode === "catalog");
  document.querySelector<HTMLElement>(".workspace-shell")?.classList.toggle("connector-active", mode === "connectors");
  byId("inspector-panel").classList.remove("mobile-open");
  inspectorRows("", []);
  loadingIndicator.classList.add("visible");

  if (mode === "catalog") {
    workflowPanel.deactivate();
    productionPanel.deactivate();
    systemPanel.deactivate();
    resourcePackagePanel.deactivate();
    byId("panel-kicker").textContent = "USER ASSETS";
    byId("panel-dataset-name").textContent = "用户资产";
    byId("dataset-state").textContent = "当前工作区的用户资产已加载";
    byId("metric-one-label").textContent = "USER ASSETS";
    byId("metric-two-label").textContent = "READY";
    byId("metric-three-label").textContent = "FILTERED";
    byId("metric-four-label").textContent = "SOURCE";
    byId("metric-four").textContent = "USER";
    byId("metric-five-label").textContent = "STORAGE";
    byId("metric-five").textContent = "METADATA";
    byId("render-status").textContent = "USER ASSET REGISTRY";
    byId("object-status").textContent = "NO RAW DATA COPIED";
    loadingIndicator.classList.remove("visible");
    await dataCatalogPanel.activate(surveyCards, localSurveyRecordsById);
    const userAssetCount = (dataCatalogPanel.debugState().catalogAssetCount as number | undefined) ?? 0;
    byId("metric-one").textContent = String(userAssetCount);
    byId("metric-two").textContent = byId("catalog-ready-count").textContent ?? "0";
    byId("metric-three").textContent = byId("catalog-count").textContent?.split(" /")[0] ?? String(userAssetCount);
    return;
  }

  dataCatalogPanel.deactivate();
  resourcePackagePanel.deactivate();
  if (mode === "packages") {
    workflowPanel.deactivate();
    productionPanel.deactivate();
    systemPanel.deactivate();
    byId("inspector-kicker").textContent = "SURVEY INFORMATION";
    byId("panel-kicker").textContent = "PUBLIC SURVEY COVERAGE";
    byId("panel-dataset-name").textContent = "公开资源集";
    let records: PublicResourcePackage[] = [];
    try {
      records = await workspaceApi.resourcePackages();
      publicCatalogUnavailable = false;
    } catch (error) {
      publicCatalogUnavailable = true;
      console.warn("Public resource catalog is unavailable", error);
    }
    byId("dataset-state").textContent = publicCatalogUnavailable ? "公开目录不可用，可先同步 Assets catalog" : "公开巡天与望远镜覆盖目录已加载";
    byId("metric-one-label").textContent = "PACKAGES";
    byId("metric-one").textContent = String(records.length);
    byId("metric-two-label").textContent = "INSTALLED";
    byId("metric-two").textContent = String(records.filter((record) => record.installedVersion).length);
    byId("metric-three-label").textContent = "ACTIVE";
    byId("metric-three").textContent = String(records.filter((record) => record.active).length);
    byId("metric-four-label").textContent = "ACTIVE SURVEYS";
    byId("metric-four").textContent = String(new Set(surveyFootprints?.footprints.map((footprint) => footprint.surveyId) ?? []).size);
    byId("metric-five-label").textContent = "ACTIVE PRODUCTS";
    byId("metric-five").textContent = String(surveyFootprints?.footprints.length ?? 0);
    byId("render-status").textContent = "PUBLIC SURVEY COVERAGE";
    byId("object-status").textContent = `${surveyFootprints?.footprints.length ?? 0} COVERAGE SOURCES`;
    loadingIndicator.classList.remove("visible");
    await resourcePackagePanel.activate();
    return;
  }
  if (mode === "connectors") {
    workflowPanel.deactivate();
    productionPanel.deactivate();
    systemPanel.deactivate();
    byId("panel-kicker").textContent = "CONNECTOR REGISTRY";
    byId("panel-dataset-name").textContent = "连接器配置";
    byId("dataset-state").textContent = "连接 S3 / OSS / JDBC 提交扫描";
    byId("metric-one-label").textContent = "CONNECTORS";
    byId("metric-one").textContent = "--";
    byId("metric-two-label").textContent = "S3 / OSS";
    byId("metric-two").textContent = "--";
    byId("metric-three-label").textContent = "LOCAL";
    byId("metric-three").textContent = "--";
    byId("metric-four-label").textContent = "JDBC";
    byId("metric-four").textContent = "--";
    byId("metric-five-label").textContent = "SCANS";
    byId("metric-five").textContent = "0";
    byId("render-status").textContent = "CONNECTOR REGISTRY";
    byId("object-status").textContent = "NO CONNECTION TESTS";
    loadingIndicator.classList.remove("visible");
    await connectorPanel.activate(connectorSelectionRequest ?? undefined);
    connectorSelectionRequest = null;
    return;
  }
  if (mode === "workflow") {
    workflowPanel.deactivate();
    systemPanel.deactivate();
    byId("inspector-kicker").textContent = "PIPELINE INSPECTOR";
    byId("panel-kicker").textContent = "DATA PRODUCTION";
    byId("panel-dataset-name").textContent = "数据生产";
    byId("dataset-state").textContent = "多流水线任务与产物已载入";
    byId("metric-one-label").textContent = "PIPELINES";
    byId("metric-one").textContent = "3";
    byId("metric-two-label").textContent = "RUNS";
    byId("metric-two").textContent = "--";
    byId("metric-three-label").textContent = "QUEUED";
    byId("metric-three").textContent = "--";
    byId("metric-four-label").textContent = "ARTIFACTS";
    byId("metric-four").textContent = "--";
    byId("metric-five-label").textContent = "EXECUTORS";
    byId("metric-five").textContent = "HTTP + MCP";
    byId("render-status").textContent = "PRODUCTION RUNS";
    byId("object-status").textContent = "NO ACTIVE RUN";
    loadingIndicator.classList.remove("visible");
    await productionPanel.activate();
    return;
  }
  if (mode === "system") {
    workflowPanel.deactivate();
    productionPanel.deactivate();
    byId("inspector-kicker").textContent = "SYSTEM SETTINGS";
    byId("panel-kicker").textContent = "SYSTEM CONFIGURATION";
    byId("panel-dataset-name").textContent = "系统配置";
    byId("dataset-state").textContent = "AI Provider 与 MCP Server 管理";
    byId("metric-one-label").textContent = "AI PROVIDERS";
    byId("metric-one").textContent = "--";
    byId("metric-two-label").textContent = "MCP SERVERS";
    byId("metric-two").textContent = "--";
    byId("metric-three-label").textContent = "CONNECTED";
    byId("metric-three").textContent = "--";
    byId("metric-four-label").textContent = "SECRETS";
    byId("metric-four").textContent = "MASKED";
    byId("metric-five-label").textContent = "AGENT";
    byId("metric-five").textContent = "READY";
    byId("render-status").textContent = "SETTINGS";
    byId("object-status").textContent = "NO ACTIVE RUN";
    loadingIndicator.classList.remove("visible");
    await systemPanel.activate();
    return;
  }

  workflowPanel.deactivate();
  productionPanel.deactivate();
  systemPanel.deactivate();
  byId("panel-dataset-name").textContent = "巡天图层";
  const targetCanvas = freshCanvas();
  targetCanvas.hidden = false;

  if (mode === "layers") {
    byId("inspector-kicker").textContent = "DATA COVERAGE";
    byId("panel-kicker").textContent = "DATA COVERAGE";
    byId("panel-dataset-name").textContent = "数据覆盖";
    byId("dataset-state").textContent = "公开覆盖与用户资产状态已载入";
    renderCoverageMetrics();
    byId("scene-mode-label").textContent = "DATA COVERAGE";
    byId("scene-mode-value").textContent = "PUBLIC + OWNED";
    byId("scene-badge").textContent = "数据覆盖";
    byId("legend-min").textContent = "公开覆盖";
    byId("legend-max").textContent = "项目资产";
    byId("object-status").textContent = `${surveyFootprints?.footprints.length ?? 0} COVERAGE SOURCES`;
     layerViewer = new SurveyLayerViewer(targetCanvas, surveyFootprints!, publicSurveyCards, renderSurveySelection, renderSurveyHover, renderSurveyInspection, renderSurveyContextMenu, renderLayerState, renderSurveyObjectPoint, renderOverlapComponent);
    applySceneBackground(storedSceneBackground());
    layerViewer.setLayoutMode(layerLayoutMode);
    layerViewer.setVisibleSurveys(visibleSurveyIds);
    layerViewer.setInteractionMode(layerInteractionMode);
    applyLayerPreferences();
    void loadEuclidAstroOverview().catch((error) => {
      notifyWorkspace("公开覆盖索引查询失败", error instanceof Error ? error.message : String(error), { tone: "warning", dedupeMs: 5_000 });
      console.warn("Unable to load Euclid workspace coverage overview", error);
    });
    void loadWorkspaceAssetCoverage().catch((error) => {
      notifyWorkspace("用户资产覆盖读取失败", error instanceof Error ? error.message : String(error), { tone: "warning", dedupeMs: 5_000 });
      console.warn("Unable to load custom workspace coverage", error);
    });
    byId("render-status").textContent = layerViewer.webglVersion;
    loadingIndicator.classList.remove("visible");
  }
}

document.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((button) => {
  button.addEventListener("click", () => {
    void activateMode(button.dataset.mode as ViewMode).catch(showFatal);
  });
});

function setupStatusHelp(): void {
  const openEntries = new Map<HTMLButtonElement, HTMLElement>();
  let sequence = 0;

  const position = (button: HTMLButtonElement, tooltip: HTMLElement): void => {
    const buttonRect = button.getBoundingClientRect();
    const viewportPadding = 12;
    const width = Math.min(360, window.innerWidth - viewportPadding * 2);
    tooltip.style.width = `${width}px`;
    const tooltipRect = tooltip.getBoundingClientRect();
    const left = Math.max(
      viewportPadding,
      Math.min(buttonRect.left, window.innerWidth - tooltipRect.width - viewportPadding),
    );
    const below = buttonRect.bottom + 8;
    const top = below + tooltipRect.height <= window.innerHeight - viewportPadding
      ? below
      : Math.max(viewportPadding, buttonRect.top - tooltipRect.height - 8);
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  };

  const close = (button: HTMLButtonElement, tooltip: HTMLElement): void => {
    tooltip.classList.remove("is-visible");
    tooltip.setAttribute("aria-hidden", "true");
    openEntries.delete(button);
  };

  const register = (button: HTMLButtonElement): void => {
    if (button.dataset.statusHelpReady === "true") return;
    const tooltip = button.querySelector<HTMLElement>(".status-help-tooltip");
    if (!tooltip) return;
    button.dataset.statusHelpReady = "true";
    const id = `status-help-tooltip-${sequence++}`;
    tooltip.id = id;
    tooltip.setAttribute("aria-hidden", "true");
    button.setAttribute("aria-describedby", id);
    document.body.append(tooltip);
    createIcons({ icons: { Info }, attrs: { "aria-hidden": "true" } });

    const open = (): void => {
      openEntries.set(button, tooltip);
      tooltip.classList.add("is-visible");
      tooltip.setAttribute("aria-hidden", "false");
      position(button, tooltip);
    };
    button.addEventListener("pointerenter", open);
    button.addEventListener("focus", open);
    button.addEventListener("pointerleave", () => {
      if (!button.matches(":focus")) close(button, tooltip);
    });
    button.addEventListener("blur", () => close(button, tooltip));
  };

  document.querySelectorAll<HTMLButtonElement>(".status-help").forEach(register);
  new MutationObserver((entries) => {
    for (const entry of entries) {
      for (const node of entry.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.matches(".status-help")) register(node as HTMLButtonElement);
        node.querySelectorAll<HTMLButtonElement>(".status-help").forEach(register);
      }
    }
  }).observe(document.body, { childList: true, subtree: true });

  const reposition = (): void => {
    openEntries.forEach((tooltip, button) => position(button, tooltip));
  };
  window.addEventListener("resize", reposition);
  window.addEventListener("scroll", reposition, true);
}

setupStatusHelp();
setupRemoteCoverageDialog();
byId<HTMLButtonElement>("reset-button").addEventListener("click", () => {
  if (mode === "layers") {
    if (aladinExplorer) aladinExplorer.reset();
    else layerViewer?.reset();
  }
});
byId<HTMLButtonElement>("aladin-fullscreen").addEventListener("click", () => void toggleAladinFullscreen());
byId<HTMLButtonElement>("aladin-asset-drawer-toggle").addEventListener("click", () => {
  setAladinAssetDrawer(!aladinAssetDrawerOpen);
});
renderAladinAssetDrawerState();
document.addEventListener("fullscreenchange", () => {
  renderAladinFullscreenState();
  window.setTimeout(() => {
    aladinExplorer?.resize();
    syncAladinView();
  }, 80);
});
byId<HTMLButtonElement>("drill-back-button").addEventListener("click", () => {
  if (aladinExplorer || aladinSnapshot) {
    void leaveAladinExplorer().catch(showFatal);
    return;
  }
});
window.addEventListener("keydown", (event) => {
  if (event.key === "g" || event.key === "G") {
    if (event.metaKey || event.ctrlKey || event.altKey || aladinExplorer || mode !== "layers") return;
    const target = event.target as HTMLElement | null;
    if (target?.matches("input, textarea, select, [contenteditable='true']")) return;
    event.preventDefault();
    if (overlapModeActive) exitSkyOverlapMode();
    else void enterSkyOverlapMode().catch(showFatal);
    return;
  }
  if (event.key === "f" || event.key === "F") {
    if (event.metaKey || event.ctrlKey || event.altKey || aladinExplorer || mode !== "layers") return;
    const target = event.target as HTMLElement | null;
    if (target?.matches("input, textarea, select, [contenteditable='true']")) return;
    if (!layerViewer?.state.selectedPixels.length) return;
    event.preventDefault();
    layerViewer.focusSelection();
    return;
  }
  if (event.key !== "Escape" || event.metaKey || event.ctrlKey || event.altKey) return;
  if (aladinExplorer || aladinSnapshot) {
    event.preventDefault();
    void leaveAladinExplorer().catch(showFatal);
    return;
  }
  if (overlapModeActive) {
    event.preventDefault();
    exitSkyOverlapMode();
    return;
  }
  const target = event.target as HTMLElement | null;
  if (target?.matches("input, textarea, select, [contenteditable='true']")) return;
  event.preventDefault();
  closeSkyContextMenu();
  layerViewer?.clearTransientState();
  selectedSurvey = null;
  selectedLayerAssetId = null;
  activeWorkspaceHover = null;
  renderSurveyHover(null);
  selectedLayerRegion = null;
  byId("region-scene-legend").hidden = true;
  inspectorRows("", []);
});
document.addEventListener("pointerdown", (event) => {
  const menu = byId("coverage-context-menu");
  if (!menu.hidden && !menu.contains(event.target as Node)) closeSkyContextMenu();
});
byId<HTMLButtonElement>("controls-toggle").addEventListener("click", () => controlsPanel.classList.toggle("mobile-open"));
window.addEventListener("astro:navigate", (event) => {
  const detail = (event as CustomEvent<{ mode?: ViewMode; productionContext?: ProductionContext; productionPipeline?: string }>).detail;
  const nextMode = detail?.mode;
  if (nextMode === "layers") void activateMode(nextMode).catch(showFatal);
  if (nextMode === "workflow") {
    productionPanel.setContext(detail.productionContext ?? null, detail.productionPipeline);
    void activateMode(nextMode).catch(showFatal);
  }
  if (nextMode === "system") void activateMode(nextMode).catch(showFatal);
});

const scrollTimers = new WeakMap<HTMLElement, number>();
document.querySelectorAll<HTMLElement>([
  ".controls-panel",
  ".inspector-panel",
  ".catalog-stage",
  ".workflow-stage",
  ".workspace-dialog",
  ".dialog-form > ul",
  ".coverage-hover",
  ".result-table-wrap",
].join(",")).forEach((region) => {
  region.classList.add("interactive-scroll-region");
  region.addEventListener("scroll", () => {
    region.classList.add("is-scrolling");
    const previous = scrollTimers.get(region);
    if (previous !== undefined) window.clearTimeout(previous);
    scrollTimers.set(region, window.setTimeout(() => region.classList.remove("is-scrolling"), 700));
  }, { passive: true });
});

declare global {
  interface Window {
    __ASTRO_WORKSPACE_DEBUG__?: () => Record<string, unknown>;
  }
}

async function start(): Promise<void> {
  const [surveysResult, publicSurveysResult, footprintsResult, assetsResult, catalogConfigResult, capabilitiesResult, connectorsResult] = await Promise.allSettled([
    workspaceApi.surveys(),
    workspaceApi.publicSurveys(),
    workspaceApi.surveyFootprints(),
    workspaceApi.dataAssets(),
    workspaceApi.resourceCatalogConfig(),
    workspaceApi.capabilities(),
    workspaceApi.connectors(),
  ]);
  const surveys = surveysResult.status === "fulfilled" ? surveysResult.value : [];
  const publicSurveys = publicSurveysResult.status === "fulfilled" ? publicSurveysResult.value : [];
  const footprints = footprintsResult.status === "fulfilled" ? footprintsResult.value : emptySurveyFootprintManifest();
  const assets = assetsResult.status === "fulfilled" ? assetsResult.value : [];
  workspaceCapabilities = capabilitiesResult.status === "fulfilled" ? capabilitiesResult.value : null;
  workspaceConnectors = connectorsResult.status === "fulfilled" ? connectorsResult.value : [];
  publicCatalogUnavailable = footprintsResult.status === "rejected" || publicSurveysResult.status === "rejected" || catalogConfigResult.status === "rejected";
  if (footprintsResult.status === "rejected") {
    notifyWorkspace("公开覆盖目录读取失败", footprintsResult.reason instanceof Error ? footprintsResult.reason.message : String(footprintsResult.reason), { tone: "warning", dedupeMs: 5_000 });
    console.warn("Public coverage is unavailable until Assets catalog sync", footprintsResult.reason);
  }
  surveyCards = surveys;
  publicSurveyCards = publicSurveys;
  surveyFootprints = footprints;
  dataAssets = assets;
  if (catalogConfigResult.status === "fulfilled") resourcePackagePanel.setCatalogStatus(catalogConfigResult.value);
  const surveyResults = await Promise.allSettled(surveys.map((survey) => workspaceApi.survey(survey.id)));
  localSurveyRecordsById.clear();
  surveyResults.forEach((result) => { if (result.status === "fulfilled") localSurveyRecordsById.set(result.value.id, result.value); });
  const publicSurveyResults = await Promise.allSettled(publicSurveys.map((survey) => workspaceApi.publicSurvey(survey.id)));
  publicSurveyRecordsById.clear();
  publicSurveyResults.forEach((result) => { if (result.status === "fulfilled") publicSurveyRecordsById.set(result.value.id, result.value); });
  restoreLayerPreferences();

  byId("dataset-name").textContent = "";
  byId("panel-dataset-name").textContent = "Atlas workspace";
  buildSurveyList();
  byId("service-status").textContent = "SERVICE ONLINE";
  window.__ASTRO_WORKSPACE_DEBUG__ = () => ({
    mode,
    cameraDistance: canvas.dataset.cameraDistance,
    outerRadius: canvas.dataset.outerRadius,
    aladinActive: Boolean(aladinExplorer),
    aladinSnapshot,
    aladinView: aladinExplorer?.getView() ?? null,
    aladinFullscreen,
    aladinObjectId: byId("inspector-panel").dataset.objectId ?? null,
    aladinOverlapCount: latestAladinStatus?.overlapCount ?? 0,
    layerOrder,
    layerDepths: canvas.dataset.layerDepths ? JSON.parse(canvas.dataset.layerDepths) : [],
    ...dataCatalogPanel.debugState(),
    ...workflowPanel.debugState(),
    ...productionPanel.debugState(),
    ...systemPanel.debugState(),
    ...agentDock.debugState(),
  });
  const initialQuery = new URL(window.location.href).searchParams;
  await agentDock.initialize();
  await activateMode(initialQuery.get("mode") === "packages" ? "packages" : initialQuery.get("mode") === "catalog" ? "catalog" : initialQuery.get("mode") === "workflow" ? "workflow" : initialQuery.get("mode") === "system" ? "system" : publicCatalogUnavailable ? "packages" : "layers");
  void resumeCoverageDownloads();
}

void start().catch(showFatal);
