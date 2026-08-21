import { ChevronLeft, ChevronRight, createIcons, Download, Globe2, GripVertical, Info, Layers3, Maximize2, Minimize2, Moon, Pin, PinOff, Play, Plus, RefreshCw, RotateCcw, Settings2, SlidersHorizontal, Sun, Undo2, X } from "lucide";

import "./styles.css";
import {
  workspaceApi,
  type AtlasAngularCellData,
  type AtlasJointCellView,
  type AtlasJointQueryResponse,
  type AtlasRefinementResponse,
  type AstroOverviewResponse,
  type AstroSpatialSummary,
  type ConnectorScanRun,
  type SurveyCard,
  type SurveyRecord,
  type SurveyFootprintManifest,
  type DataAssetRecord,
  type WorkspaceAssetCoverageLayer,
  type WorkspaceAssetCoverageResponse,
  type SurveyAtlasManifest,
  type VolumeManifest,
  type VolumePointData,
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
  type WorkspaceCoverageLayer,
} from "./survey-layer-viewer";
import type { PublicResourcePackage, ResourceCatalogStatus } from "../../src/resource-packages";
import type { SurveyModality, SurveyRegistrationInput } from "../../src/survey-registry";
import {
  VolumeViewer,
  type JointCellSelection,
  type VolumeSelection,
  type VolumeViewState,
} from "./volume-viewer";
import { WorkflowPanel } from "./workflow-panel";
import { DataCatalogPanel } from "./data-catalog-panel";
import { ConnectorPanel, type ConnectorMetrics } from "./connector-panel";
import { ResourcePackagePanel, type ResourcePackageSelectionCallbacks } from "./resource-package-panel";
import { AladinExplorer, type AladinAssetTarget, type AladinExplorerSnapshot, type AladinExplorerStatus } from "./aladin-explorer";
import { normalizeLayerOrder } from "./layer-order";

type ViewMode = "catalog" | "packages" | "connectors" | "layers" | "volume" | "workflow";
type VolumeRepresentation = "cells" | "points";

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing required element: ${id}`);
  return element as T;
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatMpc(value: number, digits = 0): string {
  return `${value.toFixed(digits)} Mpc`;
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

function projectAssetCounts(): Record<DataAssetRecord["projectState"], number> {
  const counts: Record<DataAssetRecord["projectState"], number> = {
    public_reference: 0,
    acquired: 0,
    processed: 0,
    deliverable: 0,
    planned: 0,
  };
  dataAssets.forEach((asset) => {
    const states = asset.projectStates?.length ? asset.projectStates : [asset.projectState];
    states.forEach((state) => { counts[state] += 1; });
  });
  return counts;
}

function renderProjectMetrics(): void {
  const counts = projectAssetCounts();
  const metrics: Array<[string, string, string]> = [
    ["metric-one-label", "metric-one", "public_reference"],
    ["metric-two-label", "metric-two", "acquired"],
    ["metric-three-label", "metric-three", "processed"],
    ["metric-four-label", "metric-four", "deliverable"],
    ["metric-five-label", "metric-five", "planned"],
  ];
  metrics.forEach(([labelId, valueId, state]) => {
    byId(labelId).textContent = PROJECT_STATE_LABELS[state as DataAssetRecord["projectState"]].toUpperCase();
    byId(valueId).textContent = formatInteger(counts[state as DataAssetRecord["projectState"]]);
  });
}

function assetsForSelection(selection: SurveyLayerSelection): DataAssetRecord[] {
  const surveyIds = new Set(selection.surveyIds);
  const releaseIds = new Set(selection.releaseIds);
  const assetIds = new Set(selection.assetIds);
  return dataAssets.filter((asset) => {
    if (asset.origin === "user") return assetIds.has(asset.id);
    const surveyId = asset.surveyBinding?.surveyId ?? asset.surveyId;
    const releaseId = asset.surveyBinding?.releaseId ?? asset.releaseId;
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
  const surveyId = input.surveyId ?? asset?.surveyBinding?.surveyId ?? asset?.surveyId;
  const releaseId = input.releaseId ?? asset?.surveyBinding?.releaseId ?? asset?.releaseId;
  const survey = surveyId ? surveyRecordsById.get(surveyId) : undefined;
  const surveyCard = surveyId ? surveyCards.find((candidate) => candidate.id === surveyId) : undefined;
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

let canvas = byId<HTMLCanvasElement>("volume-canvas");
const loadingIndicator = byId("loading-indicator");
const controlsPanel = byId("controls-panel");
const radialMinInput = byId<HTMLInputElement>("radial-min-input");
const radialMaxInput = byId<HTMLInputElement>("radial-max-input");

let atlas: SurveyAtlasManifest | null = null;
let angularCells: AtlasAngularCellData | null = null;
let surveyCards: SurveyCard[] = [];
let surveyFootprints: SurveyFootprintManifest | null = null;
let publicCatalogUnavailable = false;
let selectedSurvey: SurveyRecord | null = null;
let selectedLayerAssetId: string | null = null;
const surveyRecordsById = new Map<string, SurveyRecord>();
let selectedLayerRegion: SurveyLayerSelection | null = null;
let dataAssets: DataAssetRecord[] = [];
let visibleSurveyIds = new Set<string>();
let visibleAssetIds = new Set<string>();
let assetVisibilityPreferenceRestored = false;
const workspaceAssetLayers = new Map<string, WorkspaceCoverageLayer & { assetId: string; objectCount?: number; coverageStatus: WorkspaceAssetCoverageResponse["status"] }>();
let legacyWorkspaceLayers: WorkspaceCoverageLayer[] = [];
let hasUnassignedWorkspaceCoverage = false;
let unassignedWorkspaceVisible = false;
let layerOrder: string[] = [];
let layerLayoutMode: SurveyLayerLayoutMode = "overlap";
let layerInteractionMode: SurveyLayerInteractionMode = "inspect";
let hoverDismissTimer: ReturnType<typeof setTimeout> | null = null;
let volumeManifest: VolumeManifest | null = null;
let volumePoints: VolumePointData | null = null;
let layerViewer: SurveyLayerViewer | null = null;
let volumeViewer: VolumeViewer | null = null;
let aladinExplorer: AladinExplorer | null = null;
let aladinSnapshot: AladinExplorerSnapshot | null = null;
let latestAladinStatus: AladinExplorerStatus | null = null;
let aladinFullscreen = false;
let aladinAssetDrawerOpen = false;
let aladinAssetDrawerPinned = false;
let aladinAssetDrawerTimer: ReturnType<typeof setTimeout> | null = null;
let aladinStatusFadeTimer: ReturnType<typeof setTimeout> | null = null;
let aladinToastSequence = 0;
let aladinLastToastKey = "";
let aladinLastToastAt = 0;
let aladinEntryGeneration = 0;
let aladinEntryAbort: AbortController | null = null;
let mode: ViewMode = "layers";
let representation: VolumeRepresentation = "cells";
let jointNside = 32;
let radialBins = 8;
let radialMinMpc = 0;
let radialMaxMpc = 6000;
let parentFilter: { nside: number; pixel: number } | null = null;
let selectedJointCell: JointCellSelection | null = null;
let selectedRefinement: AtlasRefinementResponse | null = null;
let astroOverview: AstroOverviewResponse | null = null;
const workspaceCellSummaries = new Map<string, AstroSpatialSummary>();
const workspaceHoverRequests = new Set<string>();
let activeWorkspaceHover: SurveyLayerHover | null = null;
let astroInspectionGeneration = 0;
let radialTimer: ReturnType<typeof setTimeout> | null = null;
let activationGeneration = 0;

const workflowPanel = new WorkflowPanel((error) => console.error("Workflow UI request failed", error));
let connectorSelectionRequest: string | null = null;
const dataCatalogPanel = new DataCatalogPanel((error) => showFatal(error), (connectorId) => {
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
const connectorPanel = new ConnectorPanel((error) => showFatal(error), renderConnectorMetrics);

function surveyRegistrationFeedback(summary: string, detail = ""): void {
  const output = byId("survey-registration-feedback");
  const title = document.createElement("strong");
  title.textContent = summary;
  const note = document.createElement("small");
  note.textContent = detail;
  output.replaceChildren(title, ...(detail ? [note] : []));
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
      coverage: { status: "pending", summary: "等待从已绑定的数据源计算覆盖范围。", sourceUrl: value("sourceUrl") },
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
      close();
      return activateMode("catalog").then(() => dataCatalogPanel.startNew(survey.id));
    }).catch((error) => surveyRegistrationFeedback("登记失败", error instanceof Error ? error.message : String(error)));
  });
}
setupSurveyRegistration();
const resourcePackagePanel = new ResourcePackagePanel(
  (before, after) => refreshActiveFootprints(before, after),
  (record, draftReleaseIds, callbacks) => renderResourcePackageDetails(record, draftReleaseIds, callbacks),
  (error) => showFatal(error),
  () => openResourceCatalogSettings(true),
);
let resourceAdminToken = "";
let resourceCatalogSyncPending = false;

function resourceCatalogSettingsFeedback(summary: string, detail = "", status: "" | "error" | "success" = ""): void {
  const output = byId<HTMLOutputElement>("resource-catalog-settings-status");
  output.replaceChildren();
  const title = document.createElement("strong");
  title.textContent = summary;
  output.append(title);
  if (detail) {
    const note = document.createElement("small");
    note.textContent = detail;
    output.append(note);
  }
  output.dataset.status = status;
}

async function syncResourceCatalog(): Promise<void> {
  if (!resourceAdminToken) {
    openResourceCatalogSettings(true);
    return;
  }
  const syncButton = byId<HTMLButtonElement>("resource-package-sync");
  syncButton.disabled = true;
  syncButton.dataset.busy = "true";
  byId("resource-package-feedback").textContent = "正在同步公开目录…";
  try {
    const result = await workspaceApi.syncResourceCatalog(resourceAdminToken);
    resourcePackagePanel.setCatalogStatus(result.catalog);
    await refreshPublicCatalogData();
    resourceCatalogSettingsFeedback("同步完成", `已载入 ${result.packages.length} 个可下载资源包。`, "success");
    byId("resource-package-feedback").textContent = `目录已同步 · ${result.catalog.catalogSha256?.slice(0, 12) ?? ""} · 资源包按需下载`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    resourceCatalogSettingsFeedback("同步失败", message, "error");
    byId("resource-package-feedback").textContent = `同步失败：${message}`;
    byId("resource-package-feedback").setAttribute("data-status", "error");
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
const LAYER_PREFERENCES_KEY = "astro-workspace:survey-layer-preferences:v3";
const PREVIOUS_LAYER_PREFERENCES_KEY = "astro-workspace:survey-layer-preferences:v2";
const LEGACY_LAYER_PREFERENCES_KEY = "astro-workspace:survey-layer-preferences:v1";
const THEME_PREFERENCE_KEY = "astro-workspace:theme:v1";
const SCENE_BACKGROUND_PREFERENCE_KEY = "astro-workspace:scene-background:v1";
type WorkspaceTheme = "light" | "dark";

createIcons({ icons: { ChevronLeft, ChevronRight, Download, Globe2, GripVertical, Info, Layers3, Maximize2, Minimize2, Moon, Pin, PinOff, Play, Plus, RefreshCw, RotateCcw, Settings2, SlidersHorizontal, Sun, Undo2, X } });

const themeQuery = window.matchMedia("(prefers-color-scheme: dark)");
const themeToggle = byId<HTMLButtonElement>("theme-toggle");
const sceneBackgroundSettings = byId<HTMLButtonElement>("scene-background-settings");
const sceneBackgroundPopover = byId<HTMLDivElement>("scene-background-popover");
const sceneBackgroundColor = byId<HTMLInputElement>("scene-background-color");

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
  volumeViewer?.setBackgroundColor(color);
  sceneBackgroundColor.value = color ?? defaultSceneBackground();
  sceneBackgroundSettings.dataset.customized = color ? "true" : "false";
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
  volumeViewer?.setTheme(theme);
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
  if (!sceneBackgroundPopover.hidden) sceneBackgroundColor.focus();
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
document.addEventListener("pointerdown", (event) => {
  if (sceneBackgroundPopover.hidden) return;
  const target = event.target;
  if (target instanceof Node && !sceneBackgroundPopover.contains(target) && !sceneBackgroundSettings.contains(target)) {
    sceneBackgroundPopover.hidden = true;
  }
});

function showFatal(error: unknown): void {
  console.error(error);
  byId("dataset-state").textContent = "载入失败";
  byId("service-status").textContent = "SERVICE ERROR";
  loadingIndicator.textContent = error instanceof Error ? error.message : String(error);
  loadingIndicator.classList.add("visible", "error");
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

const ALADIN_ASSET_DRAWER_TIMEOUT_MS = 30_000;

function clearAladinAssetDrawerTimer(): void {
  if (aladinAssetDrawerTimer === null) return;
  clearTimeout(aladinAssetDrawerTimer);
  aladinAssetDrawerTimer = null;
}

function clearAladinStatusFadeTimer(): void {
  if (aladinStatusFadeTimer === null) return;
  clearTimeout(aladinStatusFadeTimer);
  aladinStatusFadeTimer = null;
}

function scheduleAladinStatusFade(status: AladinExplorerStatus): void {
  const output = byId<HTMLOutputElement>("aladin-status");
  clearAladinStatusFadeTimer();
  output.classList.remove("is-faded");
  if (status.phase === "initializing" || status.phase === "loading") return;
  aladinStatusFadeTimer = setTimeout(() => {
    aladinStatusFadeTimer = null;
    output.classList.add("is-faded");
  }, 3_800);
}

function renderAladinAssetDrawerState(): void {
  const controls = byId("aladin-controls");
  const rail = byId("aladin-cockpit-rail");
  const toggle = byId<HTMLButtonElement>("aladin-asset-drawer-toggle");
  const pin = byId<HTMLButtonElement>("aladin-asset-drawer-pin");
  controls.dataset.assetDrawer = aladinAssetDrawerOpen ? "open" : "closed";
  rail.classList.toggle("is-open", aladinAssetDrawerOpen);
  rail.classList.toggle("is-pinned", aladinAssetDrawerPinned);
  toggle.setAttribute("aria-expanded", String(aladinAssetDrawerOpen));
  toggle.setAttribute("aria-label", aladinAssetDrawerOpen ? "收起用户资产抽屉" : "展开用户资产抽屉");
  toggle.title = aladinAssetDrawerOpen ? "收起用户资产抽屉" : "展开用户资产抽屉";
  toggle.replaceChildren();
  const toggleIcon = document.createElement("i");
  toggleIcon.dataset.lucide = aladinAssetDrawerOpen ? "chevron-left" : "chevron-right";
  const toggleLabel = document.createElement("span");
  toggleLabel.textContent = "资产";
  toggle.append(toggleIcon, toggleLabel);
  pin.setAttribute("aria-pressed", String(aladinAssetDrawerPinned));
  pin.setAttribute("aria-label", aladinAssetDrawerPinned ? "取消固定用户资产抽屉" : "固定用户资产抽屉");
  pin.title = aladinAssetDrawerPinned ? "取消固定" : "固定抽屉";
  pin.replaceChildren();
  const pinIcon = document.createElement("i");
  pinIcon.dataset.lucide = aladinAssetDrawerPinned ? "pin-off" : "pin";
  pin.append(pinIcon);
  createIcons({ icons: { ChevronLeft, ChevronRight, Pin, PinOff }, attrs: { "aria-hidden": "true" } });
}

function scheduleAladinAssetDrawerCollapse(): void {
  clearAladinAssetDrawerTimer();
  if (!aladinAssetDrawerOpen || aladinAssetDrawerPinned || !aladinExplorer) return;
  aladinAssetDrawerTimer = setTimeout(() => {
    aladinAssetDrawerTimer = null;
    aladinAssetDrawerOpen = false;
    renderAladinAssetDrawerState();
  }, ALADIN_ASSET_DRAWER_TIMEOUT_MS);
}

function setAladinAssetDrawer(open: boolean, touch = true): void {
  aladinAssetDrawerOpen = open;
  if (!open) clearAladinAssetDrawerTimer();
  renderAladinAssetDrawerState();
  if (touch) scheduleAladinAssetDrawerCollapse();
}

function pushAladinToast(message: string, tone: "info" | "success" | "error" = "info"): void {
  const normalized = message.trim();
  if (!normalized) return;
  const now = Date.now();
  const key = `${tone}:${normalized}`;
  if (key === aladinLastToastKey && now - aladinLastToastAt < 900) return;
  aladinLastToastKey = key;
  aladinLastToastAt = now;
  const stack = byId("aladin-status-deck");
  const toast = document.createElement("div");
  toast.className = `aladin-toast aladin-toast-${tone}`;
  toast.dataset.toastId = String(++aladinToastSequence);
  const pulse = document.createElement("i");
  pulse.className = "aladin-toast-pulse";
  const text = document.createElement("span");
  text.textContent = normalized;
  toast.append(pulse, text);
  stack.append(toast);
  while (stack.children.length > 4) stack.firstElementChild?.remove();
  requestAnimationFrame(() => toast.classList.add("is-visible"));
  window.setTimeout(() => {
    toast.classList.add("is-leaving");
    window.setTimeout(() => toast.remove(), 420);
  }, 3_800);
}

function destroyViewer(): void {
  layerViewer?.dispose();
  volumeViewer?.dispose();
  aladinExplorer?.dispose();
  cancelAladinEntry();
  layerViewer = null;
  volumeViewer = null;
  aladinExplorer = null;
  aladinSnapshot = null;
  latestAladinStatus = null;
  clearAladinAssetDrawerTimer();
  clearAladinStatusFadeTimer();
  aladinAssetDrawerOpen = false;
  aladinAssetDrawerPinned = false;
  byId("aladin-explorer").hidden = true;
  byId("aladin-controls").hidden = true;
  byId("aladin-asset-nav").replaceChildren();
  byId("aladin-status-deck").replaceChildren();
  byId("aladin-status").classList.remove("is-faded");
  byId("scene-stage").classList.remove("aladin-active");
  byId("scene-coordinate-readout").hidden = true;
  byId("scene-camera-readout").hidden = false;
  byId("inspector-panel").classList.remove("aladin-object-selected");
  delete byId("inspector-panel").dataset.objectId;
  renderAladinFullscreenState();
  renderAladinAssetDrawerState();
  renderSurveyHover(null);
}

function ownedBindingSurveyIds(assetIds: Iterable<string> = visibleAssetIds): Set<string> {
  const selectedAssets = new Set(assetIds);
  return new Set(
    userDataAssets()
      .filter((asset) => selectedAssets.has(asset.id))
      .flatMap((asset) => {
        const surveyId = asset.surveyBinding?.surveyId ?? asset.surveyId;
        return surveyId ? [surveyId] : [];
      })
      .filter((surveyId) => footprintsForSurvey(surveyId).length === 0),
  );
}

function explorationSurveyIds(ids: Iterable<string> = visibleSurveyIds, assetIds: Iterable<string> = visibleAssetIds): string[] {
  const bindingIds = ownedBindingSurveyIds(assetIds);
  return [...new Set(ids)]
    .filter((surveyId) => surveyId !== "__unassigned__" && !bindingIds.has(surveyId) && footprintsForSurvey(surveyId).length > 0)
    .sort();
}

function selectionSurveyIds(selection: SurveyLayerSelection): string[] {
  const bindingIds = ownedBindingSurveyIds(selection.assetIds);
  return [...new Set(selection.surveyIds)]
    .filter((surveyId) => !bindingIds.has(surveyId) && footprintsForSurvey(surveyId).length > 0)
    .sort();
}

type SkyRegionMenu = { clientX: number; clientY: number; nside: number; pixels: number[]; surveyIds: string[]; releaseIds?: string[]; assetIds: string[] };

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
  const result = await workspaceApi.skyObjectsQuery({
    region: {
      nside: menu.nside,
      pixels: menu.pixels,
      coordinateFrame: "ICRS",
      ordering: "NESTED",
    },
    coordinateFrame: "ICRS",
    ordering: "NESTED",
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
    scheduleAladinAssetDrawerCollapse();
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
  scheduleAladinAssetDrawerCollapse();
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
  const output = byId<HTMLOutputElement>("aladin-status");
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
  output.textContent = phaseLabel[status.phase];
  scheduleAladinStatusFade(status);
  host.dataset.queryPhase = status.phase;
  host.dataset.objectReturned = String(status.returned);
  host.dataset.objectTotal = String(status.total);
  host.dataset.objectTruncated = String(status.truncated);
  host.dataset.objectComplete = String(status.complete ?? (status.phase === "ready" || status.phase === "empty" || status.phase === "error"));
  byId("render-status").textContent = "ALADIN LITE";
  const selectionEmpty = status.phase === "empty" && status.message?.includes("当前选区没有可探索的用户资产");
  if (status.phase === "empty" && !selectionEmpty) output.textContent = status.message ?? "当前视野没有对象";
  byId("object-status").textContent = status.phase === "loading"
    ? `${formatInteger(status.returned)} / ${formatInteger(status.total)} OBJECTS · LOADING`
    : status.phase === "empty"
      ? selectionEmpty ? "NO OBJECT CATALOG" : "NO OBJECTS IN VIEW"
      : `${formatInteger(status.returned)} / ${formatInteger(status.total)} OBJECTS`;
  byId("layer-selection-count").textContent = `${formatInteger(status.returned)} OBJECTS`;
  const loadedSummary = byId<HTMLOutputElement>("aladin-loaded-summary");
  loadedSummary.textContent = `${formatInteger(status.returned)} / ${formatInteger(status.total)} OBJECTS`;
  byId("aladin-cache-state").textContent = status.assets?.some((asset) => asset.cacheState === "cached") ? "CACHE RETAINED" : status.phase === "loading" ? "FETCHING NEW SKY" : "CACHE READY";
  byId("aladin-object-telemetry").textContent = status.overlapCount
    ? `${formatInteger(status.overlapCount)} OVERLAP MARKERS`
    : `${formatInteger(status.returned)} POINTS IN VIEW`;
  if (status.phase === "error") pushAladinToast(status.message ?? "对象查询失败", "error");
  else if (status.phase === "ready" && status.complete) pushAladinToast(`${formatInteger(status.returned)} 个对象已载入`, "success");
  else if (status.phase === "empty" && !selectionEmpty) pushAladinToast(status.message ?? "当前视野暂无对象", "info");
  else if (status.message && !selectionEmpty) pushAladinToast(status.message, "info");
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
  clearAladinAssetDrawerTimer();
  clearAladinStatusFadeTimer();
  aladinAssetDrawerOpen = aladinAssetDrawerPinned;
  layerViewer?.dispose();
  layerViewer = null;

  const selectedCandidates = userDataAssets().filter((asset) => menu.assetIds.includes(asset.id));
  const candidates = selectedCandidates.length ? selectedCandidates : userDataAssets();
  byId<HTMLOutputElement>("aladin-status").textContent = candidates.length ? "读取视野对象" : "暂无用户资产";
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
  byId<HTMLOutputElement>("aladin-status").textContent = "初始化 Aladin";
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
  clearAladinAssetDrawerTimer();
  clearAladinStatusFadeTimer();
  aladinAssetDrawerOpen = false;
  aladinAssetDrawerPinned = false;
  byId("aladin-explorer").hidden = true;
  byId("aladin-controls").hidden = true;
  renderAladinFullscreenState();
  renderAladinAssetDrawerState();
  byId("aladin-asset-nav").replaceChildren();
  byId("aladin-status-deck").replaceChildren();
  byId("aladin-status").classList.remove("is-faded");
  byId("aladin-loaded-summary").textContent = "--";
  byId("aladin-cache-state").textContent = "CACHE IDLE";
  byId("aladin-object-telemetry").textContent = "--";
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
  const stage = byId("scene-stage").getBoundingClientRect();
  contextMenu.style.left = `${Math.max(8, Math.min(menu.clientX - stage.left, stage.width - 190))}px`;
  contextMenu.style.top = `${Math.max(8, Math.min(menu.clientY - stage.top, stage.height - 52))}px`;
  contextMenu.hidden = false;
  contextMenu.classList.add("visible");
  enter.onclick = () => {
    contextMenu.hidden = true;
    contextMenu.classList.remove("visible");
    void enterAladinExplorer(menu).catch(showFatal);
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
  canvas.dataset.layerOrder = state.layerOrder.join(",");
  canvas.dataset.layerDepths = JSON.stringify(state.layerDepths);
  canvas.dataset.selectedPixels = state.selectedPixels.join(",");
  if (state.selectionAnchor) {
    canvas.dataset.selectionBounds = [
      state.selectionAnchor.bounds.leftRatio,
      state.selectionAnchor.bounds.rightRatio,
      state.selectionAnchor.bounds.topRatio,
      state.selectionAnchor.bounds.bottomRatio,
    ].map((value) => value.toFixed(4)).join(",");
  } else delete canvas.dataset.selectionBounds;
  byId("camera-distance").textContent = `${state.cameraDistance.toFixed(2)} R`;
  byId("layer-visible-output").textContent = `${state.layerDepths.length} ACTIVE · ${state.visibleSurveyIds.length} PUBLIC · ${state.visibleAssetIds.length} OWNED`;
  renderRegionSceneLegend(state);
  setActiveButtons("[data-layer-layout]", (button) => button.dataset.layerLayout === state.layoutMode);
  byId("legend-min").textContent = state.layoutMode === "layers" ? "图层内侧" : "1 SURVEY";
  byId("legend-max").textContent = state.layoutMode === "layers" ? "图层外侧" : "MOST OVERLAP";
  byId("scene-frame-label").textContent = "ICRS";
  byId("scene-mode-value").textContent = "PUBLIC + OWNED";
  byId("scene-badge").textContent = state.selectedCellCount ? `${state.selectedCellCount} 个已选区块` : "天球概览";
  byId("layer-selection-count").textContent = state.selectedCellCount ? `${state.selectedCellCount} CELLS` : "NO CELL";
  byId("object-status").textContent = `${formatInteger(state.occupiedCellCount)} COVERAGE CELLS`;
  const backButton = byId<HTMLButtonElement>("drill-back-button");
  backButton.disabled = true;
  backButton.setAttribute("aria-label", "返回上一级天区");
  backButton.title = "返回上一级天区";
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

function renderVolumeState(state: VolumeViewState): void {
  canvas.dataset.cameraDistance = state.cameraDistance.toFixed(6);
  canvas.dataset.outerRadius = state.outerRadius.toFixed(6);
  canvas.dataset.mode = "volume";
  canvas.dataset.representation = state.representation;
  byId("camera-distance").textContent = `${state.cameraDistance.toFixed(2)} R`;
  byId("representation-output").textContent = state.representation === "cells" ? "SPARSE CELLS" : "GALAXY POINTS";
  setActiveButtons("[data-representation]", (button) => button.dataset.representation === state.representation);
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
    const survey = surveyRecordsById.get(artifact.surveyId);
    const release = survey?.releases.find((entry) => entry.id === artifact.releaseId);
    return `${survey?.name ?? artifact.surveyId} ${release?.label ?? artifact.releaseId}: ${artifact.product} (${release?.modalities.join(", ") ?? "metadata pending"})`;
  }).join(" | ");
   const selectedAssets = assetsForSelection(selection);
  const downloadAction = actionButton("下载 HEALPix 选区", () => downloadJson(`sky-region-nside-${selection.nside}.json`, {
    schemaVersion: 1,
    coordinateFrame: "ICRS",
    nside: selection.nside,
    ordering: "NESTED",
    pixels: selection.pixels,
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
   ], [downloadAction, clearAction]);
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
    const survey = surveyRecordsById.get(surveyId);
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
    const displayLayer = displayLayerFor({ assetId, surveyId: layer.surveyId, releaseId: layer.releaseId, key: layer.key });
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
    release.textContent = [displayLayer.surveyId, displayLayer.releaseId].filter(Boolean).join(" / ") || "未关联巡天";
    const detail = document.createElement("p");
    detail.textContent = layer.message ?? "该用户资产在此 HEALPix 单元有已扫描对象。";
    row.append(release, detail);
    group.append(groupHeading, row);
    stack.append(group);
  });
  const inspectionAssetIds = new Set(inspection.assetIds);
  const cellAssets = dataAssets.filter((asset) => {
    if (asset.origin === "user") return inspectionAssetIds.has(asset.id);
    const surveyId = asset.surveyBinding?.surveyId ?? asset.surveyId;
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
  prepare.disabled = true;
  prepare.textContent = "准备数据任务 · 待接入";
  prepare.title = "data-warehouse connector 尚未接入当前工作区";
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

function requestWorkspaceHoverSummary(hover: SurveyLayerHover): void {
  if (!hover.assetIds.length) return;
  const key = workspaceSummaryKey(hover.pixel, hover.assetIds);
  if (workspaceSummaryForPixel(hover.pixel, hover.assetIds) || workspaceHoverRequests.has(key)) return;
  workspaceHoverRequests.add(key);
  void workspaceApi.skyQuery({ cells: [hover.pixel], nside: hover.nside, assetIds: hover.assetIds })
    .then((summary) => {
      workspaceCellSummaries.set(key, summary);
      if (activeWorkspaceHover && workspaceSummaryKey(activeWorkspaceHover.pixel, activeWorkspaceHover.assetIds) === key) renderSurveyHover(activeWorkspaceHover);
    })
    .catch((error) => console.warn("Unable to load workspace hover summary", error))
    .finally(() => workspaceHoverRequests.delete(key));
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
  return dataAssets.filter((asset) => asset.origin === "user");
}

function coverageLayerAssetIds(layer: WorkspaceAssetCoverageLayer): string[] {
  return [...new Set([...(layer.assetIds ?? []), ...(layer.assetId ? [layer.assetId] : [])])];
}

function coverageObjectCount(assetId: string, response: WorkspaceAssetCoverageResponse, layer?: WorkspaceAssetCoverageLayer): number | undefined {
  if (typeof layer?.objectCount === "number") return layer.objectCount;
  const breakdown = [...(layer?.byAsset ?? []), ...response.byAsset].find((entry) => entry.key === assetId);
  if (typeof breakdown?.objectCount === "number") return breakdown.objectCount;
  return typeof breakdown?.objects === "number" ? breakdown.objects : undefined;
}

function normalizedAssetCoverage(asset: DataAssetRecord, response: WorkspaceAssetCoverageResponse): WorkspaceCoverageLayer & { assetId: string; objectCount?: number; coverageStatus: WorkspaceAssetCoverageResponse["status"] } {
  const layers = response.layers ?? [];
  const layer = layers.find((candidate) => coverageLayerAssetIds(candidate).length === 1 && coverageLayerAssetIds(candidate)[0] === asset.id)
    ?? layers.find((candidate) => coverageLayerAssetIds(candidate).includes(asset.id));
  const ownership = asset.surveyBinding;
  const pixels = [...new Set((layer?.pixels ?? response.pixels).filter((pixel) => Number.isInteger(pixel) && pixel >= 0))].sort((left, right) => left - right);
  const objectCount = coverageObjectCount(asset.id, response, layer);
  return {
    key: `asset:${asset.id}`,
    assetId: asset.id,
    assetIds: [asset.id],
    assetName: asset.name,
    status: response.status,
    surveyId: layer?.surveyId ?? ownership?.surveyId ?? asset.surveyId,
    releaseId: layer?.releaseId ?? ownership?.releaseId ?? asset.releaseId,
    source: layer?.source ?? ownership?.source ?? "asset",
    message: layer?.message ?? response.message ?? ownership?.message,
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
  const nside = surveyFootprints?.nside ?? 16;
  if (!assets.length) {
    workspaceAssetLayers.clear();
    legacyWorkspaceLayers = [];
    hasUnassignedWorkspaceCoverage = false;
    visibleAssetIds.clear();
    assetVisibilityPreferenceRestored = true;
    layerViewer?.setWorkspaceCoverageLayers([], nside);
    applyLayerPreferences();
    return;
  }

  const coverage = await independentAssetCoverage(assets, nside);
  workspaceAssetLayers.clear();
  coverage.layers.forEach((layer) => workspaceAssetLayers.set(layer.assetId, layer));
  legacyWorkspaceLayers = coverage.legacy;
  hasUnassignedWorkspaceCoverage = legacyWorkspaceLayers.some((layer) => layer.pixels.length > 0 && !layer.surveyId);
  const coveredAssetIds = new Set(coverage.layers.filter((layer) => layer.pixels.length > 0).map((layer) => layer.assetId));
  if (!assetVisibilityPreferenceRestored) {
    visibleAssetIds = coveredAssetIds;
    assetVisibilityPreferenceRestored = true;
  }
  if (scannedAssetId && coveredAssetIds.has(scannedAssetId)) visibleAssetIds.add(scannedAssetId);

  layerViewer?.setWorkspaceCoverageLayers([...coverage.layers, ...legacyWorkspaceLayers], nside);
  // Add newly covered assets to layer order, but don't add all known layers
  const knownKeys = new Set(knownLayerOrderKeys());
  const filteredOrder = layerOrder.filter((key) => knownKeys.has(key));
  const newAssetKeys = assets.map((asset) => `asset:${asset.id}`).filter((key) => knownKeys.has(key) && !filteredOrder.includes(key));
  const newUnassignedKey = hasUnassignedWorkspaceCoverage && !filteredOrder.includes("workspace-unassigned") ? ["workspace-unassigned"] : [];
  layerOrder = [...filteredOrder, ...newAssetKeys, ...newUnassignedKey];
  applyLayerOrder(false);
  layerViewer?.setVisibleAssets(visibleAssetIds);
  layerViewer?.setVisibleSurveys(new Set([...visibleSurveyIds, ...(unassignedWorkspaceVisible ? ["__unassigned__"] : [])]));
  buildSurveyList();
  persistLayerPreferences();
  coverage.layers.filter((layer) => layer.coverageStatus === "error").forEach((layer) => {
    console.warn(`Unable to load workspace coverage for ${layer.assetId}`, layer.message);
  });
}

async function refreshWorkspaceAssets(scannedAssetId?: string): Promise<void> {
  const [assets, surveys] = await Promise.all([workspaceApi.dataAssets(), workspaceApi.surveys()]);
  dataAssets = assets;
  surveyCards = surveys;
  const records = await Promise.all(surveys.map((survey) => workspaceApi.survey(survey.id)));
  surveyRecordsById.clear();
  records.forEach((survey) => surveyRecordsById.set(survey.id, survey));
  await loadWorkspaceAssetCoverage(scannedAssetId);
  if (mode === "layers") {
    renderProjectMetrics();
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
    const survey = surveyRecordsById.get(artifact.surveyId);
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
      key: layer.key,
    });
    const entry = document.createElement("article");
    const name = document.createElement("b");
    name.textContent = descriptor.label;
    const detail = document.createElement("span");
    const survey = descriptor.surveyId ? surveyRecordsById.get(descriptor.surveyId) : undefined;
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
  return surveyCards.filter((survey) => available.has(survey.id)).map((survey) => survey.id);
}

function knownLayerOrderKeys(): string[] {
  return [
    ...userDataAssets().map((asset) => `asset:${asset.id}`),
    ...footprintSurveyIds().map((surveyId) => `public-survey:${surveyId}`),
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
    } | null;
    const restored = stored?.visibleSurveyIds?.filter((surveyId) => available.has(surveyId)) ?? [];
    if (restored.length || stored?.visibleSurveyIds?.length === 0) visibleSurveyIds = new Set(restored);
    else if (available.has("legacy-surveys")) visibleSurveyIds = new Set(["legacy-surveys"]);
    else visibleSurveyIds = new Set([...available].slice(0, 1));
    layerLayoutMode = stored?.layoutMode === "layers" ? "layers" : "overlap";
    layerInteractionMode = stored?.interactionMode === "region" ? "region" : "inspect";
    unassignedWorkspaceVisible = stored?.unassignedWorkspaceVisible === true;
    assetVisibilityPreferenceRestored = preferenceValue !== null && Array.isArray(stored?.visibleAssetIds);
    visibleAssetIds = new Set((stored?.visibleAssetIds ?? []).filter((assetId) => availableAssets.has(assetId)));
    const addMissing = Array.isArray(stored?.layerOrder) && stored.layerOrder.length > 0;
    layerOrder = normalizeCurrentLayerOrder(stored?.layerOrder ?? [], addMissing);
  } catch {
    visibleSurveyIds = available.has("legacy-surveys") ? new Set(["legacy-surveys"]) : new Set([...available].slice(0, 1));
    layerLayoutMode = "overlap";
    layerInteractionMode = "inspect";
    unassignedWorkspaceVisible = false;
    visibleAssetIds.clear();
    assetVisibilityPreferenceRestored = false;
    layerOrder = normalizeCurrentLayerOrder([], false);
  }
}

function persistLayerPreferences(): void {
  try {
    localStorage.setItem(LAYER_PREFERENCES_KEY, JSON.stringify({
      schemaVersion: 3,
      visibleSurveyIds: [...visibleSurveyIds],
      visibleAssetIds: [...visibleAssetIds],
      layerOrder: normalizeCurrentLayerOrder(),
      layoutMode: layerLayoutMode,
      interactionMode: layerInteractionMode,
      unassignedWorkspaceVisible,
    }));
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
    workspaceApi.surveys(),
  ]);
  surveyFootprints = footprintsResult.status === "fulfilled" ? footprintsResult.value : emptySurveyFootprintManifest();
  if (surveysResult.status === "fulfilled") {
    surveyCards = surveysResult.value;
    const records = await Promise.allSettled(surveyCards.map((survey) => workspaceApi.survey(survey.id)));
    surveyRecordsById.clear();
    records.forEach((result) => { if (result.status === "fulfilled") surveyRecordsById.set(result.value.id, result.value); });
  }
  if (mode === "packages") await resourcePackagePanel.reload();
}

function renderResourcePackageDetails(
  record: PublicResourcePackage,
  draftReleaseIds: ReadonlySet<string>,
  callbacks: ResourcePackageSelectionCallbacks,
): void {
  const survey = surveyRecordsById.get(record.surveyId);
  const empty = byId("inspector-empty");
  const content = byId("inspector-content");
  empty.hidden = true;
  content.hidden = false;
  const heading = document.createElement("h2");
  heading.textContent = survey?.name ?? record.name;
  const summary = document.createElement("p");
  summary.className = "inspector-summary";
  summary.textContent = survey?.description ?? record.description;
  const metadata = document.createElement("dl");
  const rows: Array<[string, string]> = [
    ["巡天 / 望远镜", survey?.mission ?? record.facilities.join(" / ")],
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
  const releaseIds = [...new Set(record.releases)];
  releaseCount.textContent = `${releaseIds.length} 个已收录`;
  releaseHeading.append(releaseTitle, releaseCount);
  const releaseChoices = document.createElement("div");
  releaseChoices.className = "resource-release-choices";
  for (const releaseId of releaseIds) {
    const label = record.releaseLabels[releaseId] ?? releaseId;
    const choice = document.createElement("div");
    choice.className = "resource-release-choice";
    choice.dataset.coverageAvailable = "true";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = draftReleaseIds.has(releaseId);
    checkbox.setAttribute("aria-label", `选择 ${label} 天空覆盖`);
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
    availability.dataset.available = "true";
    availability.textContent = "天空覆盖已收录";
    header.append(title, availability);
    const detail = document.createElement("small");
    const source = record.sources.find((entry) => entry.releaseId === releaseId);
    detail.textContent = source ? `${source.authority} · ${source.label}` : releaseId;
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
  selectAll.addEventListener("click", () => callbacks.setDraftReleases(releaseIds));
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
    remove.addEventListener("click", () => void callbacks.remove().catch(showFatal));
    actions.append(remove);
  }
  content.replaceChildren(heading, summary, metadata, releaseSection, actions);
}

function applyLayerPreferences(): void {
  applyLayerOrder();
  layerViewer?.setLayoutMode(layerLayoutMode);
  layerViewer?.setVisibleSurveys(new Set([...visibleSurveyIds, ...(unassignedWorkspaceVisible ? ["__unassigned__"] : [])]));
  layerViewer?.setVisibleAssets(visibleAssetIds);
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

function renderObjectSelection(selection: VolumeSelection): void {
  byId("inspector-kicker").textContent = "OBJECT INSPECTOR";
  inspectorRows(selection.targetId.toString(), [
    ["TARGETID", selection.targetId.toString()],
    ["RA", `${selection.raDeg.toFixed(6)}°`],
    ["Dec", `${selection.decDeg >= 0 ? "+" : ""}${selection.decDeg.toFixed(6)}°`],
    ["BEST_Z", selection.bestZ.toFixed(6)],
    ["ZERR", Number.isFinite(selection.zErr) ? selection.zErr.toExponential(3) : "--"],
    ["Comoving", formatMpc(selection.comovingDistanceMpc, 2)],
  ]);
}

function renderJointSelection(selection: JointCellSelection | null): void {
  byId("inspector-kicker").textContent = "JOINT CELL";
  selectedJointCell = selection;
  selectedRefinement = null;
  if (!selection || !atlas) {
    inspectorRows("", []);
    return;
  }
  const key = `${selection.nside}:${selection.radialBins}:${selection.pixel}:${selection.radialBin}`;
  const rows: Array<[string, string]> = [
    ["HEALPix", `${selection.nside} / ${selection.pixel}`],
    ["Radial bin", `${selection.radialBin + 1} / ${selection.radialBins}`],
    ["Range", `${selection.radialMinMpc.toFixed(0)}–${selection.radialMaxMpc.toFixed(0)} Mpc`],
    ["Objects", formatInteger(selection.count)],
    ["Volume", `${selection.volumeMpc3.toExponential(3)} Mpc³`],
    ["Density", selection.densityPerMpc3.toExponential(3)],
    ["Refinement", "CALCULATING"],
  ];
  inspectorRows(`CELL ${selection.pixel}:${selection.radialBin}`, rows);
  void workspaceApi.refinement(atlas.id, {
    survey: "desi",
    nside: selection.nside,
    radialBins: selection.radialBins,
    pixel: selection.pixel,
    radialBin: selection.radialBin,
  }).then((refinement) => {
    if (!selectedJointCell || `${selectedJointCell.nside}:${selectedJointCell.radialBins}:${selectedJointCell.pixel}:${selectedJointCell.radialBin}` !== key) return;
    selectedRefinement = refinement;
    const actions: HTMLButtonElement[] = [];
    if (refinement.angular.available) actions.push(actionButton(`方向 → ${refinement.angular.nextLevel}`, () => void drill("angular")));
    if (refinement.radial.available) actions.push(actionButton(`径向 → ${refinement.radial.nextLevel}`, () => void drill("radial")));
    if (refinement.recommendedAxis !== "none") actions.unshift(actionButton(`自动 · ${refinement.recommendedAxis.toUpperCase()}`, () => void drill(refinement.recommendedAxis as "angular" | "radial")));
    inspectorRows(`CELL ${selection.pixel}:${selection.radialBin}`, [
      ...rows.slice(0, -1),
      ["Angular gain", refinement.angular.normalizedVariation.toFixed(4)],
      ["Radial gain", refinement.radial.normalizedVariation.toFixed(4)],
      ["Conserved", refinement.angular.conserved && refinement.radial.conserved ? "YES" : "NO"],
      ["Recommended", refinement.recommendedAxis.toUpperCase()],
    ], actions);
  }).catch(showFatal);
}

function renderVolumeSelection(selection: VolumeSelection | JointCellSelection | null): void {
  if (!selection) {
    selectedJointCell = null;
    inspectorRows("", []);
  } else if (selection.kind === "object") renderObjectSelection(selection);
  else renderJointSelection(selection);
}

function renderLayerAssetDetails(asset: DataAssetRecord): void {
  selectedLayerAssetId = asset.id;
  const layer = workspaceAssetLayers.get(asset.id);
  const scan = asset.scanSpec;
  const actions: HTMLButtonElement[] = [];
  if (scan && asset.connectorIds?.length === 1) {
    const scanButton = actionButton("扫描此资产", () => {
      scanButton.disabled = true;
      void workspaceApi.executeDataAssetLocalScan(asset.id)
        .then(() => refreshWorkspaceAssets(asset.id))
        .catch(showFatal)
        .finally(() => { scanButton.disabled = false; });
    });
    actions.push(scanButton);
  }
  const coverage = layer?.coverageStatus === "ready" && layer.pixels.length
    ? `${layer.pixels.length} 个 HEALPix 单元 · ${formatInteger(layer.objectCount ?? 0)} 个对象`
    : layer?.coverageStatus === "unavailable" ? "尚未连接 Elasticsearch"
      : layer?.coverageStatus === "error" ? layer.message ?? "覆盖查询失败"
        : "未建立覆盖";
  inspectorRows(asset.name, [
    ["巡天 / 发布", `${asset.surveyId ?? "未关联"} / ${asset.releaseId ?? "未关联"}`],
    ["数据类型", asset.kind],
    ["使用阶段", asset.projectState],
    ["覆盖状态", coverage],
    ["CSV 文件", asset.sourceRelativePath ?? "未指定"],
    ["对象列", scan ? `${scan.objectIdColumn} · RA ${scan.raColumn} · Dec ${scan.decColumn}` : "未配置 CSV scanSpec"],
  ], actions);
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
  const publicLayers = new Map(footprintSurveyIds().map((surveyId) => [`public-survey:${surveyId}`, surveyCards.find((survey) => survey.id === surveyId)!]));
  const assetLayers = new Map(userDataAssets().map((asset) => [`asset:${asset.id}`, asset]));
  if (!publicLayers.size && !assetLayers.size && !hasUnassignedWorkspaceCoverage) {
    const empty = document.createElement("p");
    empty.className = "survey-list-empty";
    empty.textContent = "暂无可显示的数据覆盖。请应用公开资源或扫描用户资产。";
    list.replaceChildren(empty);
    return;
  }

  const cards = layerOrder.map((key, index) => {
    const survey = publicLayers.get(key);
    const asset = assetLayers.get(key);
    const isUnassigned = key === "workspace-unassigned" && hasUnassignedWorkspaceCoverage;
    if (!survey && !asset && !isUnassigned) return null;
    const card = document.createElement("article");
    card.className = "survey-card";
    card.dataset.layerKey = key;
    card.draggable = true;
    const visible = survey ? visibleSurveyIds.has(survey.id) : asset ? visibleAssetIds.has(asset.id) : unassignedWorkspaceVisible;
    card.classList.toggle("visible", visible);
    if (asset) card.classList.add("workspace-asset-card");
    if (isUnassigned) card.classList.add("workspace-unassigned");

    const handle = document.createElement("button");
    handle.type = "button";
    handle.className = "layer-drag-handle";
    handle.title = "拖拽排序图层";
    handle.setAttribute("aria-label", `调整 ${survey?.name ?? asset?.name ?? "未关联巡天"} 图层顺序`);
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
    checkbox.setAttribute("aria-label", `显示 ${survey?.name ?? asset?.name ?? "未关联巡天"}`);
    checkbox.addEventListener("change", () => {
      if (survey) setSurveyVisibility(survey.id, checkbox.checked);
      else if (asset) setAssetVisibility(asset.id, checkbox.checked);
      else setUnassignedWorkspaceVisibility(checkbox.checked);
    });
    const swatch = document.createElement("i");
    swatch.style.background = survey?.color ?? (asset ? workspaceAssetColor(asset.id) : "#d69b4e");
    visibility.append(checkbox, swatch);

    const body = document.createElement("div");
    body.className = "survey-card-body";
    body.tabIndex = 0;
    const activate = (): void => {
      if (survey) void selectSurvey(survey.id).catch(showFatal);
      else if (asset) { selectedLayerAssetId = asset.id; renderLayerAssetDetails(asset); }
    };
    body.addEventListener("click", activate);
    body.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); activate(); }
    });
    const name = document.createElement("span");
    name.textContent = survey?.name ?? asset?.name ?? "未关联巡天";
    const count = document.createElement("b");
    const metadata = document.createElement("small");
    if (survey) {
      const footprints = footprintsForSurvey(survey.id);
      count.textContent = `${footprints.length}/${survey.releaseCount} MOC`;
      metadata.textContent = `${survey.mission} · PUBLIC FOOTPRINT`;
    } else if (asset) {
      const layer = workspaceAssetLayers.get(asset.id);
      count.textContent = layer?.pixels.length ? `${formatInteger(layer.objectCount ?? 0)} OBJECTS` : "未建立覆盖";
      metadata.textContent = `${asset.surveyId ?? "未关联巡天"} · ${asset.releaseId ?? "未关联发布"}`;
    } else {
      count.textContent = "WORKSPACE";
      metadata.textContent = "仅显示未绑定巡天的工作区覆盖";
    }
    body.append(name, count, metadata);

    card.append(handle, visibility, body);
    return card;
  }).filter((card): card is HTMLElement => card !== null);
  list.replaceChildren(...cards);
  createIcons({ icons: { GripVertical }, attrs: { "aria-hidden": "true" } });
}

async function selectSurvey(id: string): Promise<void> {
  selectedSurvey = await workspaceApi.survey(id);
  surveyRecordsById.set(id, selectedSurvey);
  buildSurveyList();
  renderSurveyDetails(selectedSurvey);
  if (window.innerWidth <= 1040) byId("inspector-panel").classList.add("mobile-open");
}

async function loadJointCells(): Promise<void> {
  if (!atlas || !volumeViewer) return;
  const generation = activationGeneration;
  loadingIndicator.textContent = "查询联合体积单元";
  loadingIndicator.classList.add("visible");
  const query: Parameters<typeof workspaceApi.jointCells>[1] = {
    survey: "desi",
    nside: jointNside,
    radialBins,
    radialMinMpc,
    radialMaxMpc,
  };
  if (parentFilter && jointNside >= parentFilter.nside) {
    query.parentNside = parentFilter.nside;
    query.parentPixel = parentFilter.pixel;
  }
  const result: AtlasJointQueryResponse = await workspaceApi.jointCells(atlas.id, query);
  if (generation !== activationGeneration || !volumeViewer) return;
  volumeViewer.setJointCells(result.cells, result.nside, result.radialBins);
  volumeViewer.setAngularFilter(parentFilter);
  byId("query-cell-count").textContent = formatInteger(result.metrics.returnedCellCount);
  byId("query-object-count").textContent = formatInteger(result.representedObjects);
  byId("query-examined-count").textContent = formatInteger(result.metrics.examinedCellCount);
  byId("query-time").textContent = `${result.metrics.queryMs.toFixed(2)} MS`;
  byId("metric-one").textContent = formatInteger(result.metrics.returnedCellCount);
  byId("metric-three").textContent = formatInteger(result.representedObjects);
  byId("object-status").textContent = `${formatInteger(result.representedObjects)} GALAXIES`;
  loadingIndicator.classList.remove("visible");
}

async function ensurePoints(): Promise<void> {
  if (!volumeManifest || !volumeViewer) return;
  if (!volumePoints) {
    loadingIndicator.textContent = `载入 ${formatInteger(volumeManifest.pointCount)} 个星系`;
    loadingIndicator.classList.add("visible");
    volumePoints = await workspaceApi.volumePoints(volumeManifest);
  }
  volumeViewer.setData(volumePoints);
  volumeViewer.setAngularFilter(parentFilter);
  loadingIndicator.classList.remove("visible");
}

async function drill(axis: "angular" | "radial"): Promise<void> {
  if (!selectedJointCell || !selectedRefinement) return;
  parentFilter = { nside: selectedJointCell.nside, pixel: selectedJointCell.pixel };
  radialMinMpc = selectedJointCell.radialMinMpc;
  radialMaxMpc = selectedJointCell.radialMaxMpc;
  if (axis === "angular" && selectedRefinement.angular.nextLevel) jointNside = selectedRefinement.angular.nextLevel;
  if (axis === "radial" && selectedRefinement.radial.nextLevel) radialBins = selectedRefinement.radial.nextLevel;
  radialMinInput.value = String(radialMinMpc);
  radialMaxInput.value = String(radialMaxMpc);
  updateJointControls();
  await loadJointCells();
}

function updateJointControls(): void {
  byId("joint-nside-output").textContent = `NSIDE ${jointNside}`;
  byId("radial-bins-output").textContent = `${radialBins} BINS`;
  byId("radial-min-output").textContent = formatMpc(radialMinMpc);
  byId("radial-max-output").textContent = formatMpc(radialMaxMpc);
  setActiveButtons("[data-joint-nside]", (button) => Number(button.dataset.jointNside) === jointNside);
  setActiveButtons("[data-radial-bins]", (button) => Number(button.dataset.radialBins) === radialBins);
}

async function activateMode(nextMode: ViewMode): Promise<void> {
  if (nextMode === "layers" && !surveyFootprints) throw new Error("Survey footprint catalog is not configured");
  if (nextMode === "volume" && (!atlas || !angularCells || !volumeManifest)) throw new Error("Joint volume is not configured");
  activationGeneration += 1;
  const generation = activationGeneration;
  mode = nextMode;
  destroyViewer();
  setActiveButtons("[data-mode]", (button) => button.dataset.mode === mode);
  byId("catalog-controls").hidden = mode !== "catalog";
  byId("resource-package-controls").hidden = mode !== "packages";
  byId("connector-controls").hidden = mode !== "connectors";
  byId("layer-controls").hidden = mode !== "layers";
  byId("volume-controls").hidden = mode !== "volume";
  byId("workflow-controls").hidden = mode !== "workflow";
  byId("catalog-stage").hidden = mode !== "catalog";
  byId("resource-package-stage").hidden = mode !== "packages";
  byId("connector-stage").hidden = mode !== "connectors";
  byId("scene-stage").hidden = mode === "workflow" || mode === "catalog" || mode === "connectors" || mode === "packages";
  sceneBackgroundPopover.hidden = true;
  byId("aladin-explorer").hidden = true;
  byId("aladin-controls").hidden = true;
  byId("workflow-stage").hidden = mode !== "workflow";
  document.querySelectorAll<HTMLElement>(".scene-action").forEach((element) => { element.hidden = mode === "workflow" || mode === "catalog" || mode === "connectors" || mode === "packages"; });
  byId("scene-legend").hidden = false;
  byId("region-scene-legend").hidden = mode !== "layers";
  byId<HTMLButtonElement>("drill-back-button").disabled = true;
  byId("context-summary").hidden = false;
  document.querySelector<HTMLElement>(".workspace-shell")?.classList.toggle("workflow-active", mode === "workflow");
  document.querySelector<HTMLElement>(".workspace-shell")?.classList.toggle("catalog-active", mode === "catalog");
  document.querySelector<HTMLElement>(".workspace-shell")?.classList.toggle("connector-active", mode === "connectors");
  byId("inspector-panel").classList.remove("mobile-open");
  inspectorRows("", []);
  loadingIndicator.classList.add("visible");

  if (mode === "catalog") {
    workflowPanel.deactivate();
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
    await dataCatalogPanel.activate(surveyCards, surveyRecordsById);
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
    byId("panel-kicker").textContent = "CONNECTOR REGISTRY";
    byId("panel-dataset-name").textContent = "连接器配置";
    byId("dataset-state").textContent = "当前仅 S3 / OSS 可提交扫描；历史记录由执行器统一上报";
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
    byId("panel-kicker").textContent = "WORKFLOW CONTROL";
    byId("panel-dataset-name").textContent = "Euclid × DESI Pipeline";
    byId("dataset-state").textContent = "工作流服务连接中";
    byId("metric-one-label").textContent = "STEPS";
    byId("metric-one").textContent = "0/7";
    byId("metric-two-label").textContent = "PUBLIC REF";
    byId("metric-two").textContent = formatInteger(projectAssetCounts().public_reference);
    byId("metric-three-label").textContent = "RESULTS";
    byId("metric-three").textContent = "--";
    byId("metric-four-label").textContent = "ENGINE";
    byId("metric-four").textContent = "RULES";
    byId("metric-five-label").textContent = "PLANNED";
    byId("metric-five").textContent = formatInteger(projectAssetCounts().planned);
    byId("render-status").textContent = "WORKFLOW DAG";
    byId("object-status").textContent = "0 MATCHES";
    loadingIndicator.classList.remove("visible");
    await workflowPanel.activate();
    return;
  }

  workflowPanel.deactivate();
  byId("panel-dataset-name").textContent = mode === "layers" ? "巡天图层" : atlas?.name ?? "Joint volume";
  const targetCanvas = freshCanvas();
  targetCanvas.hidden = false;

  if (mode === "layers") {
    byId("inspector-kicker").textContent = "DATA COVERAGE";
    byId("panel-kicker").textContent = "DATA COVERAGE";
    byId("panel-dataset-name").textContent = "数据覆盖";
    byId("dataset-state").textContent = "公开覆盖与用户资产状态已载入";
    renderProjectMetrics();
    byId("scene-mode-label").textContent = "DATA COVERAGE";
    byId("scene-mode-value").textContent = "PUBLIC + OWNED";
    byId("scene-badge").textContent = "数据覆盖";
    byId("legend-min").textContent = "公开覆盖";
    byId("legend-max").textContent = "项目资产";
    byId("object-status").textContent = `${surveyFootprints?.footprints.length ?? 0} COVERAGE SOURCES`;
     layerViewer = new SurveyLayerViewer(targetCanvas, surveyFootprints!, surveyCards, renderSurveySelection, renderSurveyHover, renderSurveyInspection, renderSurveyContextMenu, renderLayerState, renderSurveyObjectPoint);
    applySceneBackground(storedSceneBackground());
    layerViewer.setLayoutMode(layerLayoutMode);
    layerViewer.setVisibleSurveys(visibleSurveyIds);
    layerViewer.setInteractionMode(layerInteractionMode);
    applyLayerPreferences();
    void loadEuclidAstroOverview().catch((error) => {
      console.warn("Unable to load Euclid workspace coverage overview", error);
    });
    void loadWorkspaceAssetCoverage().catch((error) => {
      console.warn("Unable to load custom workspace coverage", error);
    });
    byId("render-status").textContent = layerViewer.webglVersion;
    loadingIndicator.classList.remove("visible");
  } else {
    byId("inspector-kicker").textContent = "JOINT CELL";
    byId("panel-kicker").textContent = "JOINT VOLUME";
    byId("dataset-state").textContent = "稀疏联合索引已就绪";
    byId("metric-one-label").textContent = "CELLS";
    byId("metric-three-label").textContent = "OBJECTS";
    byId("metric-four-label").textContent = "DISTANCE";
    byId("metric-four").textContent = "INFERRED";
    byId("scene-mode-label").textContent = "RADIAL";
    byId("scene-mode-value").textContent = "COMOVING DISTANCE";
    byId("scene-badge").textContent = "HEALPIX × RADIAL";
    byId("legend-min").textContent = "0";
    byId("legend-max").textContent = "6000 MPC";
    volumeViewer = new VolumeViewer(targetCanvas, volumeManifest!, renderVolumeSelection, renderVolumeState);
    applySceneBackground(storedSceneBackground());
    volumeViewer.setRepresentation(representation);
    byId("render-status").textContent = volumeViewer.webglVersion;
    updateJointControls();
    await loadJointCells();
    if (generation !== activationGeneration || !volumeViewer) return;
    if (representation === "points") await ensurePoints();
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
document.querySelectorAll<HTMLButtonElement>("[data-layer-layout]").forEach((button) => {
  button.addEventListener("click", () => {
    layerLayoutMode = button.dataset.layerLayout as SurveyLayerLayoutMode;
    applyLayerPreferences();
  });
});
document.querySelectorAll<HTMLButtonElement>("[data-joint-nside]").forEach((button) => {
  button.addEventListener("click", () => {
    jointNside = Number(button.dataset.jointNside);
    parentFilter = null;
    updateJointControls();
    void loadJointCells().catch(showFatal);
  });
});
document.querySelectorAll<HTMLButtonElement>("[data-radial-bins]").forEach((button) => {
  button.addEventListener("click", () => {
    radialBins = Number(button.dataset.radialBins);
    parentFilter = null;
    updateJointControls();
    void loadJointCells().catch(showFatal);
  });
});
document.querySelectorAll<HTMLButtonElement>("[data-representation]").forEach((button) => {
  button.addEventListener("click", () => {
    representation = button.dataset.representation as VolumeRepresentation;
    volumeViewer?.setRepresentation(representation);
    if (representation === "points") void ensurePoints().catch(showFatal);
  });
});

function scheduleRadialQuery(changed: "min" | "max"): void {
  let minimum = Number(radialMinInput.value);
  let maximum = Number(radialMaxInput.value);
  if (maximum - minimum < 50) {
    if (changed === "min") minimum = maximum - 50;
    else maximum = minimum + 50;
  }
  radialMinMpc = Math.max(0, minimum);
  radialMaxMpc = Math.min(6000, maximum);
  parentFilter = null;
  volumeViewer?.setRadialRange(radialMinMpc, radialMaxMpc);
  updateJointControls();
  if (radialTimer) clearTimeout(radialTimer);
  radialTimer = setTimeout(() => void loadJointCells().catch(showFatal), 120);
}

radialMinInput.addEventListener("input", () => scheduleRadialQuery("min"));
radialMaxInput.addEventListener("input", () => scheduleRadialQuery("max"));
byId<HTMLButtonElement>("reset-button").addEventListener("click", () => {
  if (mode === "layers") {
    if (aladinExplorer) aladinExplorer.reset();
    else layerViewer?.reset();
  }
  else if (mode === "volume") {
    jointNside = 32;
    radialBins = 8;
    radialMinMpc = 0;
    radialMaxMpc = 6000;
    parentFilter = null;
    radialMinInput.value = "0";
    radialMaxInput.value = "6000";
    volumeViewer?.reset();
    volumeViewer?.setAngularFilter(null);
    volumeViewer?.setRepresentation(representation);
    updateJointControls();
    void loadJointCells().catch(showFatal);
  }
});
byId<HTMLButtonElement>("aladin-fullscreen").addEventListener("click", () => void toggleAladinFullscreen());
byId<HTMLButtonElement>("aladin-asset-drawer-toggle").addEventListener("click", () => {
  setAladinAssetDrawer(!aladinAssetDrawerOpen);
});
byId<HTMLButtonElement>("aladin-asset-drawer-pin").addEventListener("click", () => {
  aladinAssetDrawerPinned = !aladinAssetDrawerPinned;
  aladinAssetDrawerOpen = true;
  renderAladinAssetDrawerState();
  scheduleAladinAssetDrawerCollapse();
});
byId("aladin-cockpit-rail").addEventListener("pointerenter", () => scheduleAladinAssetDrawerCollapse());
byId("aladin-cockpit-rail").addEventListener("focusin", () => scheduleAladinAssetDrawerCollapse());
byId<HTMLButtonElement>("aladin-inspector-toggle").addEventListener("click", () => {
  const panel = byId("inspector-panel");
  panel.classList.add("mobile-open");
  panel.scrollIntoView({ block: "nearest", inline: "nearest" });
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
  const nextMode = (event as CustomEvent<{ mode?: ViewMode }>).detail?.mode;
  if (nextMode === "layers" || nextMode === "volume") void activateMode(nextMode).catch(showFatal);
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
  const [surveysResult, footprintsResult, assetsResult, catalogConfigResult] = await Promise.allSettled([
    workspaceApi.surveys(),
    workspaceApi.surveyFootprints(),
    workspaceApi.dataAssets(),
    workspaceApi.resourceCatalogConfig(),
  ]);
  const surveys = surveysResult.status === "fulfilled" ? surveysResult.value : [];
  const footprints = footprintsResult.status === "fulfilled" ? footprintsResult.value : emptySurveyFootprintManifest();
  const assets = assetsResult.status === "fulfilled" ? assetsResult.value : [];
  publicCatalogUnavailable = footprintsResult.status === "rejected" || catalogConfigResult.status === "rejected";
  if (footprintsResult.status === "rejected") console.warn("Public coverage is unavailable until Assets catalog sync", footprintsResult.reason);
  surveyCards = surveys;
  surveyFootprints = footprints;
  dataAssets = assets;
  if (catalogConfigResult.status === "fulfilled") resourcePackagePanel.setCatalogStatus(catalogConfigResult.value);
  const surveyResults = await Promise.allSettled(surveys.map((survey) => workspaceApi.survey(survey.id)));
  surveyRecordsById.clear();
  surveyResults.forEach((result) => { if (result.status === "fulfilled") surveyRecordsById.set(result.value.id, result.value); });
  restoreLayerPreferences();

  const [atlasResult, volumeResult] = await Promise.allSettled([workspaceApi.atlases(), workspaceApi.volumes()]);
  const atlases = atlasResult.status === "fulfilled" ? atlasResult.value : [];
  const volumes = volumeResult.status === "fulfilled" ? volumeResult.value : [];
  if (atlasResult.status === "rejected") console.warn("Joint atlas is unavailable; project sky remains enabled", atlasResult.reason);
  if (volumeResult.status === "rejected") console.warn("Radial volumes are unavailable; project sky remains enabled", volumeResult.reason);
  atlas = atlases[0] ?? null;
  volumeManifest = volumes.find((candidate) => candidate.id === atlas?.jointIndex.radialCoordinate.sourceVolumeId) ?? volumes[0] ?? null;
  if (atlas) {
    try {
      angularCells = await workspaceApi.atlasAngularCells(atlas);
    } catch (error) {
      console.warn("Joint atlas cells are unavailable; project sky remains enabled", error);
      angularCells = null;
    }
  }
  byId("dataset-name").textContent = "Assets public coverage and user data";
  byId("panel-dataset-name").textContent = "Atlas workspace";
  buildSurveyList();
  byId("service-status").textContent = "SERVICE ONLINE";
  window.__ASTRO_WORKSPACE_DEBUG__ = () => ({
    mode,
    representation,
    jointNside,
    radialBins,
    radialMinMpc,
    radialMaxMpc,
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
  });
  const initialQuery = new URL(window.location.href).searchParams;
  await activateMode(initialQuery.get("mode") === "packages" ? "packages" : initialQuery.get("mode") === "catalog" ? "catalog" : publicCatalogUnavailable ? "packages" : "layers");
}

void start().catch(showFatal);
