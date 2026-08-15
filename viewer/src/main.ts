import { createIcons, Download, Globe2, Info, Layers3, Moon, Play, Plus, RefreshCw, RotateCcw, SlidersHorizontal, Sun, Undo2 } from "lucide";

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
import type {
  AstroCellsQueryResult,
  ObjectRegionQueryInput,
} from "../../src/astro-object-index";
import {
  SurveyLayerViewer,
  workspaceAssetColor,
  type SurveyLayerHover,
  type SurveyLayerInspection,
  type SurveyLayerInteractionMode,
  type SurveyLayerLayoutMode,
  type SurveyLayerSelection,
  type SurveyLayerState,
  type SurveyDrillCell,
  type SurveyLayerDrillEvent,
  type SurveyObjectPoint,
  type WorkspaceCoverageLayer,
} from "./survey-layer-viewer";
import type { PublicResourcePackage } from "../../src/resource-packages";
import type { PublicCoverageStatus, PublicReleaseDetail } from "../../src/public-release-details";
import type { ManualFootprintInput, ManualFootprintRecord } from "../../src/manual-footprints";
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
let publicReleaseDetails: PublicReleaseDetail[] = [];
let manualFootprintRecords: ManualFootprintRecord[] = [];
let releaseDetailInspectorWasOpen = false;
let editingManualFootprint: ManualFootprintRecord | null = null;
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
  let layerLayoutMode: SurveyLayerLayoutMode = "overlap";
let layerInteractionMode: SurveyLayerInteractionMode = "inspect";
let hoverDismissTimer: ReturnType<typeof setTimeout> | null = null;
let volumeManifest: VolumeManifest | null = null;
let volumePoints: VolumePointData | null = null;
let layerViewer: SurveyLayerViewer | null = null;
let volumeViewer: VolumeViewer | null = null;
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

type DrillCellRef = { nside: number; pixel: number };
const DRILL_NSIDE_LEVELS = [16, 32, 64, 128, 256] as const;
const DRILL_OBJECT_LIMIT = 10000;
let drillLevelNside: number = DRILL_NSIDE_LEVELS[0];
let drillMinimumNside: number = DRILL_NSIDE_LEVELS[0];
let drillSelectedCells: DrillCellRef[] = [];
let drillHistory: Array<{ nside: number; cells: DrillCellRef[] }> = [];
let drillParentOverride: { nside: number; pixels: number[] } | null = null;
let drillCellsResult: AstroCellsQueryResult | null = null;
let drillObjectsResult: { total: number; displayed: number; truncated: boolean } | null = null;
let drillFovDeg = 48;
let drillObjectMode = false;
let drillGeneration = 0;
let drillCellsAbort: AbortController | null = null;
let drillObjectsAbort: AbortController | null = null;
let drillRefreshTimer: ReturnType<typeof setTimeout> | null = null;
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
const resourcePackagePanel = new ResourcePackagePanel(
  (before, after) => refreshActiveFootprints(before, after),
  (record, draftReleaseIds, callbacks) => renderResourcePackageDetails(record, draftReleaseIds, callbacks),
  (surveyId) => showPublicSurveyOverview(surveyId),
  (error) => showFatal(error),
);
const LAYER_PREFERENCES_KEY = "astro-workspace:survey-layer-preferences:v2";
const LEGACY_LAYER_PREFERENCES_KEY = "astro-workspace:survey-layer-preferences:v1";
const THEME_PREFERENCE_KEY = "astro-workspace:theme:v1";
type WorkspaceTheme = "light" | "dark";

createIcons({ icons: { Download, Globe2, Info, Layers3, Moon, Play, Plus, RefreshCw, RotateCcw, SlidersHorizontal, Sun, Undo2 } });

const themeQuery = window.matchMedia("(prefers-color-scheme: dark)");
const themeToggle = byId<HTMLButtonElement>("theme-toggle");

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

function destroyViewer(): void {
  layerViewer?.dispose();
  volumeViewer?.dispose();
  layerViewer = null;
  volumeViewer = null;
  renderSurveyHover(null);
}

function isDrillNside(value: number): boolean {
  return (DRILL_NSIDE_LEVELS as readonly number[]).includes(value);
}

function drillCellKey(cell: DrillCellRef): string {
  return `${cell.nside}:${cell.pixel}`;
}

function drillChildren(cells: readonly DrillCellRef[], targetNside: number): DrillCellRef[] {
  let current = [...cells];
  while (current.length && current[0]!.nside < targetNside) {
    current = current.flatMap((cell) => [0, 1, 2, 3].map((offset) => ({
      nside: cell.nside * 2,
      pixel: cell.pixel * 4 + offset,
    })));
    if (current.length > 4096) return current.slice(0, 4096);
  }
  return current;
}

function drillAncestors(cells: readonly DrillCellRef[], targetNside: number): DrillCellRef[] {
  return [...new Set(cells.map((cell) => {
    const steps = Math.max(0, Math.round(Math.log2(cell.nside / targetNside)));
    return { nside: targetNside, pixel: Math.floor(cell.pixel / 4 ** steps) };
  }).map(drillCellKey))].map((key) => {
    const parts = key.split(":");
    return { nside: Number(parts[0]), pixel: Number(parts[1]) };
  });
}

function cellsAtNside(cells: readonly DrillCellRef[], targetNside: number): DrillCellRef[] {
  const sourceNside = cells[0]?.nside ?? targetNside;
  if (targetNside === sourceNside) return [...cells];
  return targetNside > sourceNside ? drillChildren(cells, targetNside) : drillAncestors(cells, targetNside);
}

function fovNside(fovDeg: number): number {
  if (fovDeg <= 0.5) return 256;
  if (fovDeg <= 1) return 128;
  if (fovDeg <= 2) return 64;
  if (fovDeg <= 4) return 32;
  return 16;
}

function syncDrillLevelWithFov(): boolean {
  if (!drillSelectedCells.length) return false;
  const desired = Math.max(drillMinimumNside, fovNside(drillFovDeg));
  if (desired === drillLevelNside) return false;
  const previousCells = [...drillSelectedCells];
  const previousNside = previousCells[0]!.nside;
  const nextCells = cellsAtNside(previousCells, desired);
  if (!nextCells.length) return false;
  drillSelectedCells = nextCells;
  drillLevelNside = desired;
  drillParentOverride = desired > previousNside
    ? { nside: previousNside, pixels: previousCells.map((cell) => cell.pixel) }
    : null;
  return true;
}

function checkedDrillFilters(): Pick<ObjectRegionQueryInput, "assetIds" | "surveyIds"> {
  return {
    assetIds: [...visibleAssetIds].sort(),
    surveyIds: [...visibleSurveyIds].filter((surveyId) => surveyId !== "__unassigned__").sort(),
  };
}

function baseDrillPixels(): number[] {
  const pixels = new Set<number>();
  visibleAssetIds.forEach((assetId) => workspaceAssetLayers.get(assetId)?.pixels.forEach((pixel) => pixels.add(pixel)));
  visibleSurveyIds.forEach((surveyId) => footprintsForSurvey(surveyId).forEach((footprint) => footprint.pixels.forEach((pixel) => pixels.add(pixel))));
  return [...pixels].sort((left, right) => left - right).slice(0, 4096);
}

function effectiveSkyFov(state: SurveyLayerState): number {
  return state.effectiveFovDeg;
}

function renderDrillStatus(): void {
  const selected = drillSelectedCells.length ? `${drillSelectedCells.length} CELLS` : "NO CELL";
  byId("scene-mode-value").textContent = `NESTED NSIDE ${drillLevelNside} · FOV ${drillFovDeg.toFixed(2)}°`;
  byId("layer-selection-count").textContent = selected;
  byId<HTMLButtonElement>("drill-back-button").disabled = drillHistory.length === 0;
  if (drillObjectsResult) {
    byId("object-status").textContent = `${formatInteger(drillObjectsResult.displayed)} / ${formatInteger(drillObjectsResult.total)} OBJECTS${drillObjectsResult.truncated ? " · LIMITED" : ""}`;
  } else {
    byId("object-status").textContent = drillObjectMode ? "OBJECT QUERY" : `DENSITY · ${formatInteger(drillCellsResult?.total ?? 0)} OBJECTS`;
  }
}

function scheduleDrillRefresh(delayMs = 80): void {
  if (drillRefreshTimer) clearTimeout(drillRefreshTimer);
  drillRefreshTimer = setTimeout(() => {
    drillRefreshTimer = null;
    void refreshDrillData().catch((error) => console.warn("Unable to refresh HEALPix drilldown", error));
  }, delayMs);
}

function shouldQueryDrillObjects(selected: readonly DrillCellRef[]): boolean {
  if (!selected.length) return false;
  return drillObjectMode ? drillFovDeg <= 0.55 : drillFovDeg <= 0.48;
}

async function refreshDrillData(): Promise<void> {
  if (mode !== "layers" || !layerViewer) return;
  const filters = checkedDrillFilters();
  const generation = ++drillGeneration;
  drillCellsAbort?.abort();
  drillObjectsAbort?.abort();
  drillCellsAbort = new AbortController();
  drillObjectsAbort = new AbortController();
  drillObjectsResult = null;
  if (!filters.assetIds?.length && !filters.surveyIds?.length) {
    drillCellsResult = null;
    drillObjectMode = false;
    layerViewer.clearDrillCells();
    layerViewer.clearObjectPoints();
    layerViewer.setDrillFocus(false);
    renderDrillStatus();
    return;
  }

  const selected = drillSelectedCells.filter((cell) => isDrillNside(cell.nside));
  const parent = drillParentOverride ?? (selected.length
    ? { nside: selected[0]!.nside, pixels: selected.map((cell) => cell.pixel) }
    : { nside: 16, pixels: baseDrillPixels() });
  drillParentOverride = null;
  if (!parent.pixels.length) {
    drillCellsResult = null;
    layerViewer.clearDrillCells();
    layerViewer.clearObjectPoints();
    layerViewer.setDrillFocus(false);
    renderDrillStatus();
    return;
  }
  const targetNside = selected.length ? selected[0]!.nside : 16;
  layerViewer.setDrillFocus(selected.length > 0);
  try {
    const result = await workspaceApi.skyCellsQuery({
      parentNside: parent.nside,
      parentPixels: parent.pixels,
      targetNside,
      coordinateFrame: "ICRS",
      ordering: "NESTED",
      ...filters,
    }, drillCellsAbort.signal);
    if (generation !== drillGeneration || !layerViewer) return;
    drillCellsResult = result;
    drillLevelNside = targetNside;
    const cells: SurveyDrillCell[] = result.cells.map((cell) => ({
      nside: cell.nside,
      pixel: cell.pixel,
      count: cell.count,
      layers: cell.layers.map((layer) => {
        const displayLayer = displayLayerFor(layer);
        return { ...layer, label: displayLayer.label, color: displayLayer.color };
      }),
    }));
    layerViewer.setDrillCells(cells, targetNside);
    const objectMode = shouldQueryDrillObjects(selected);
    drillObjectMode = objectMode;
    if (!objectMode) {
      layerViewer.clearObjectPoints();
      renderDrillStatus();
      return;
    }
    const objectInput: ObjectRegionQueryInput = {
      region: {
        nside: selected[0]!.nside,
        pixels: selected.map((cell) => cell.pixel),
        coordinateFrame: "ICRS",
        ordering: "NESTED",
      },
      coordinateFrame: "ICRS",
      ordering: "NESTED",
      ...filters,
      limit: DRILL_OBJECT_LIMIT,
    };
    const objects = await workspaceApi.skyObjectsQuery(objectInput, drillObjectsAbort.signal);
    if (generation !== drillGeneration || !layerViewer) return;
    const points: SurveyObjectPoint[] = objects.objects.map((object) => {
      const displayLayer = displayLayerFor({
        assetId: object.asset_id,
        surveyId: object.survey,
        releaseId: object.release,
        product: object.product,
        modality: object.modality,
      });
      return {
        objectId: object.object_id,
        raDeg: object.ra_deg,
        decDeg: object.dec_deg,
        assetId: object.asset_id,
        surveyId: object.survey,
        releaseId: object.release,
        product: object.product,
        modality: object.modality,
        attributes: object.attributes,
        label: displayLayer.label,
        color: displayLayer.color,
        count: 1,
      };
    });
    layerViewer.setObjectPoints(points);
    drillObjectsResult = { total: objects.total, displayed: points.length, truncated: objects.total > points.length || Boolean(objects.nextCursor) };
    renderDrillStatus();
  } catch (error) {
    if (generation !== drillGeneration || (error instanceof DOMException && error.name === "AbortError")) return;
    drillCellsResult = { status: "error", index: "astro_coverage_index_v1", coordinateFrame: "ICRS", ordering: "NESTED", parentNside: parent.nside, parentPixels: parent.pixels, targetNside, nativeNside: 256, evidence: "coverage_facts", cells: [], layers: [], total: 0, message: error instanceof Error ? error.message : String(error) };
    drillObjectMode = false;
    layerViewer.clearDrillCells();
    layerViewer.clearObjectPoints();
    renderDrillStatus();
  }
}

function handleDrillEvent(event: SurveyLayerDrillEvent): void {
  if (!isDrillNside(event.nside)) return;
  if (event.doubleClick) {
    if (event.nside >= 256) {
      drillSelectedCells = [{ nside: event.nside, pixel: event.pixel }];
      drillLevelNside = event.nside;
      drillMinimumNside = event.nside;
      scheduleDrillRefresh();
      return;
    }
    drillHistory.push({ nside: drillLevelNside, cells: drillSelectedCells.map((cell) => ({ ...cell })) });
    drillLevelNside = event.nside * 2;
    drillMinimumNside = drillLevelNside;
    drillSelectedCells = [0, 1, 2, 3].map((offset) => ({ nside: drillLevelNside, pixel: event.pixel * 4 + offset }));
    drillParentOverride = { nside: event.nside, pixels: [event.pixel] };
    layerViewer?.focusDrillCell(event.nside, event.pixel);
    scheduleDrillRefresh(0);
    return;
  }
  const cell = { nside: event.nside, pixel: event.pixel };
  if (event.additive) {
    const key = drillCellKey(cell);
    drillSelectedCells = drillSelectedCells.some((candidate) => drillCellKey(candidate) === key)
      ? drillSelectedCells.filter((candidate) => drillCellKey(candidate) !== key)
      : [...drillSelectedCells, cell];
  } else {
    drillSelectedCells = [cell];
  }
  drillLevelNside = event.nside;
  drillMinimumNside = event.nside;
  scheduleDrillRefresh();
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
  canvas.dataset.selectedPixels = state.selectedPixels.join(",");
  byId("camera-distance").textContent = `${state.cameraDistance.toFixed(2)} R`;
  const previousObjectMode = drillObjectMode;
  drillFovDeg = effectiveSkyFov(state);
  const levelChanged = syncDrillLevelWithFov();
  byId("layer-visible-output").textContent = state.visibleAssetIds.length
    ? `${state.visibleSurveyIds.length} PUBLIC · ${state.visibleAssetIds.length} ASSET`
    : `${state.visibleSurveyIds.length} ACTIVE`;
  renderRegionSceneLegend(state);
  setActiveButtons("[data-layer-layout]", (button) => button.dataset.layerLayout === state.layoutMode);
  setActiveButtons("[data-layer-interaction]", (button) => button.dataset.layerInteraction === state.interactionMode);
  document.querySelectorAll<HTMLButtonElement>("[data-layer-interaction]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.layerInteraction === state.interactionMode)));
  byId("legend-min").textContent = state.layoutMode === "layers" ? "图层内侧" : "1 SURVEY";
  byId("legend-max").textContent = state.layoutMode === "layers" ? "图层外侧" : "MOST OVERLAP";
  byId("scene-badge").textContent = drillSelectedCells.length
    ? `NSIDE ${drillLevelNside} · ${drillSelectedCells.length} 已选`
    : state.interactionMode === "region" ? "区域选择" : "HEALPix 密度场";
  renderDrillStatus();
  const nextObjectMode = shouldQueryDrillObjects(drillSelectedCells);
  if (previousObjectMode && !nextObjectMode) {
    drillObjectMode = false;
    drillObjectsResult = null;
    layerViewer?.clearObjectPoints();
    renderDrillStatus();
  }
  if (previousObjectMode !== nextObjectMode) scheduleDrillRefresh(120);
  if (levelChanged) scheduleDrillRefresh(120);
}

function renderRegionSceneLegend(state: SurveyLayerState): void {
  const legend = byId("region-scene-legend");
  if (!state.selectedCellCount || !state.selectionAnchor?.visible || !selectedLayerRegion) {
    legend.hidden = true;
    legend.replaceChildren();
    return;
  }
  const title = document.createElement("strong");
  title.textContent = `SELECTED SKY REGION · ${state.selectedCellCount} CELLS`;
  const subtitle = document.createElement("span");
  subtitle.textContent = "其余天区已弱化";
  const surveys = document.createElement("div");
  surveys.className = "region-scene-surveys";
  selectedLayerRegion.surveyIds.forEach((surveyId) => {
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
  if (!selectedLayerRegion.surveyIds.length && !selectedLayerRegion.assetIds.length) {
    const item = document.createElement("span");
    item.textContent = "NO REGISTERED COVERAGE";
    surveys.append(item);
  }
  legend.replaceChildren(title, subtitle, surveys);
  legend.hidden = false;
  const stage = byId("scene-stage").getBoundingClientRect();
  const width = Math.min(270, Math.max(200, stage.width - 24));
  const left = Math.max(12, Math.min(state.selectionAnchor.xRatio * stage.width + 18, stage.width - width - 12));
  const top = Math.max(52, Math.min(state.selectionAnchor.yRatio * stage.height - 42, stage.height - 110));
  legend.style.width = `${width}px`;
  legend.style.left = `${left}px`;
  legend.style.top = `${top}px`;
}

function renderDensityCellSummary(nside: number, pixel: number): HTMLElement | null {
  const cell = drillCellsResult?.cells.find((candidate) => candidate.nside === nside && candidate.pixel === pixel);
  if (!cell) return null;
  const section = document.createElement("section");
  section.className = "coverage-density-summary";
  const heading = document.createElement("header");
  const title = document.createElement("strong");
  title.textContent = "对象密度";
  const total = document.createElement("span");
  total.textContent = `${formatInteger(cell.count)} OBJECTS`;
  heading.append(title, total);
  const evidence = document.createElement("small");
  evidence.textContent = drillCellsResult?.evidence === "coverage_facts" ? "来自ES coverage facts · 共同角向区块" : "覆盖范围证据";
  const layers = document.createElement("div");
  layers.className = "coverage-density-layers";
  [...cell.layers]
    .filter((layer) => layer.count > 0)
    .sort((left, right) => right.count - left.count)
    .forEach((layer) => {
      const displayLayer = displayLayerFor(layer);
      const row = document.createElement("div");
      const swatch = document.createElement("i");
      swatch.style.background = displayLayer.color;
      const name = document.createElement("span");
      name.textContent = displayLayer.label;
      const count = document.createElement("b");
      count.textContent = formatInteger(layer.count);
      row.append(swatch, name, count);
      layers.append(row);
    });
  section.append(heading, evidence, layers);
  return section;
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
   const names = selection.surveyIds.map((id) => displayLayerFor({ surveyId: id }).label).join(" / ");
   const coverageSummary = selection.coverageCounts.map(({ surveyId, cellCount }) => `${displayLayerFor({ surveyId }).label}: ${cellCount}/${selection.pixels.length}`).join(" · ");
   const assetNames = selection.assetIds.map((id) => displayLayerFor({ assetId: id }).label).join(" / ");
   const assetCoverageSummary = selection.assetCoverageCounts.map(({ assetId, cellCount }) => `${displayLayerFor({ assetId }).label}: ${cellCount}/${selection.pixels.length}`).join(" · ");
  const artifactSummary = selection.artifacts.map((artifact) => {
    const survey = surveyRecordsById.get(artifact.surveyId);
    const release = survey?.releases.find((entry) => entry.id === artifact.releaseId);
    return `${survey?.name ?? artifact.surveyId} ${release?.label ?? artifact.releaseId}: ${artifact.product} (${release?.modalities.join(", ") ?? "metadata pending"})`;
  }).join(" | ");
  const selectedAssets = assetsForSelection(selection);
  const searchAction = actionButton("在天球中钻取", () => {
    const firstPixel = selection.pixels[0];
    if (firstPixel === undefined) return;
    drillLevelNside = selection.nside;
    drillSelectedCells = [{ nside: selection.nside, pixel: firstPixel }];
    drillParentOverride = null;
    layerViewer?.focusDrillCell(selection.nside, firstPixel);
    scheduleDrillRefresh(0);
  });
  searchAction.dataset.action = "drill-region";
  const downloadAction = actionButton("下载 HEALPix 选区", () => downloadJson(`sky-region-nside-${selection.nside}.json`, {
    schemaVersion: 1,
    coordinateFrame: "ICRS",
    nside: selection.nside,
    ordering: "NESTED",
    pixels: selection.pixels,
    center: { raDeg: selection.centerRaDeg, decDeg: selection.centerDecDeg },
    boundingRadiusDeg: selection.angularRadiusDeg,
    surveys: selection.surveyIds,
    releases: selection.releaseIds,
    assets: selection.assetIds,
  }));
  downloadAction.classList.add("secondary");
  downloadAction.dataset.action = "download-region";
  const clearAction = actionButton("清除所选区域", () => {
    layerViewer?.clearRegionSelection();
  });
  clearAction.classList.add("secondary");
  inspectorRows(`已锁定 ${selection.pixels.length} 个连续天区`, [
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
    ["选区状态", selection.notice ?? "完整角向选区已高亮；有数据的巡天切片叠加显示"],
  ], [searchAction, downloadAction, clearAction]);
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
  Object.entries(point.attributes ?? {}).slice(0, 16).forEach(([key, value]) => {
    rows.push([key, inspectorValue(value)]);
  });
  inspectorRows(`对象 ${point.objectId ?? "未命名"}`, rows);
  if (window.innerWidth <= 1040) byId("inspector-panel").classList.add("mobile-open");
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
  inspection.surveyIds.filter((surveyId) => inspection.artifacts.some((artifact) => artifact.surveyId === surveyId)).forEach((surveyId) => {
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
    return Boolean(surveyId && inspection.surveyIds.includes(surveyId));
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
  const density = renderDensityCellSummary(inspection.nside, inspection.pixel);
  content.replaceChildren(titleRow, coordinates, ...(density ? [density] : []), stack, projectState, workspaceSection, nextStep);
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
    scheduleDrillRefresh(0);
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
  layerViewer?.setVisibleAssets(visibleAssetIds);
  layerViewer?.setVisibleSurveys(new Set([...visibleSurveyIds, ...(unassignedWorkspaceVisible ? ["__unassigned__"] : [])]));
  buildSurveyList();
  persistLayerPreferences();
  scheduleDrillRefresh(0);
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

function restoreLayerPreferences(): void {
  const available = new Set(footprintSurveyIds());
  const availableAssets = new Set(userDataAssets().map((asset) => asset.id));
  try {
    const v2 = localStorage.getItem(LAYER_PREFERENCES_KEY);
    const stored = JSON.parse(v2 ?? localStorage.getItem(LEGACY_LAYER_PREFERENCES_KEY) ?? "null") as {
      schemaVersion?: number;
      visibleSurveyIds?: string[];
      visibleAssetIds?: string[];
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
    assetVisibilityPreferenceRestored = v2 !== null && Array.isArray(stored?.visibleAssetIds);
    visibleAssetIds = new Set((stored?.visibleAssetIds ?? []).filter((assetId) => availableAssets.has(assetId)));
  } catch {
    visibleSurveyIds = available.has("legacy-surveys") ? new Set(["legacy-surveys"]) : new Set([...available].slice(0, 1));
    layerLayoutMode = "overlap";
    layerInteractionMode = "inspect";
    unassignedWorkspaceVisible = false;
    visibleAssetIds.clear();
    assetVisibilityPreferenceRestored = false;
  }
}

function persistLayerPreferences(): void {
  try {
    localStorage.setItem(LAYER_PREFERENCES_KEY, JSON.stringify({
      schemaVersion: 2,
      visibleSurveyIds: [...visibleSurveyIds],
      visibleAssetIds: [...visibleAssetIds],
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
  for (const record of after) {
    if (record.active && !previouslyActive.has(record.id) && available.has(record.surveyId)) visibleSurveyIds.add(record.surveyId);
  }
  selectedLayerRegion = null;
  astroOverview = null;
  workspaceCellSummaries.clear();
  buildSurveyList();
  persistLayerPreferences();
  if (mode === "layers") await activateMode("layers");
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
  const releaseIds = [...new Set(publicReleaseDetails
    .filter((detail) => detail.surveyId === record.surveyId && detail.products.some((product) => product.coverageStatus === "acquired"))
    .map((detail) => detail.releaseId))];
  const publicReleases = survey?.releases.filter((entry) => entry.availability === "available") ?? [];
  releaseCount.textContent = `${releaseIds.length} 个已收录 / ${publicReleases.length || releaseIds.length} 个公开`;
  releaseHeading.append(releaseTitle, releaseCount);
  const releaseChoices = document.createElement("div");
  releaseChoices.className = "resource-release-choices";
  const displayedReleases = publicReleases.length
    ? publicReleases
    : releaseIds.map((releaseId) => survey?.releases.find((candidate) => candidate.id === releaseId)).filter((entry) => entry !== undefined);
  for (const entry of displayedReleases) {
    const releaseId = entry.id;
    const hasCoverage = releaseIds.includes(releaseId);
    const releaseDetail = publicReleaseDetails.find((detail) => detail.surveyId === record.surveyId && detail.releaseId === releaseId);
    const choice = document.createElement("div");
    choice.className = "resource-release-choice";
    choice.dataset.coverageAvailable = String(hasCoverage);
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = hasCoverage && draftReleaseIds.has(releaseId);
    checkbox.disabled = !hasCoverage;
    checkbox.setAttribute("aria-label", hasCoverage ? `选择 ${entry.label} 天空覆盖` : `${entry.label} 天空覆盖尚未收录`);
    checkbox.addEventListener("change", () => {
      const next = new Set(draftReleaseIds);
      if (checkbox.checked) next.add(releaseId); else next.delete(releaseId);
      callbacks.setDraftReleases(next);
    });
    const details = document.createElement("button");
    details.type = "button";
    details.className = "resource-release-detail-button";
    details.setAttribute("aria-label", `查看 ${entry.label} 版本详情`);
    details.addEventListener("click", () => showPublicReleaseDetail(record.surveyId, releaseId));
    const copy = document.createElement("span");
    copy.className = "resource-release-copy";
    const header = document.createElement("span");
    header.className = "resource-release-header";
    const title = document.createElement("strong");
    title.textContent = entry.label;
    const availability = document.createElement("small");
    availability.className = "resource-release-availability";
    availability.dataset.available = String(hasCoverage);
    availability.textContent = hasCoverage ? "天空覆盖已收录" : "覆盖范围尚未收录";
    header.append(title, availability);
    const detail = document.createElement("small");
    detail.textContent = `${releaseDetail?.releasedYear ?? entry.releasedYear ?? "年份未注明"} · ${(releaseDetail?.kind ?? entry.kind).replaceAll("_", " ")}`;
    copy.append(header, detail);
    details.append(copy);
    choice.append(checkbox, details);
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

const PUBLIC_COVERAGE_LABELS: Record<PublicCoverageStatus, string> = {
  acquired: "真实几何已收录",
  overview_only: "仅有官方概览",
  awaiting_geometry: "待人工处理几何",
  not_applicable: "不适用天空覆盖",
};

function showPublicReleaseDetail(surveyId: string, releaseId: string, updateUrl = true): void {
  const detail = publicReleaseDetails.find((entry) => entry.surveyId === surveyId && entry.releaseId === releaseId);
  if (!detail) return;
  byId("resource-package-stage").hidden = true;
  byId("public-survey-overview-stage").hidden = true;
  byId("public-release-detail-stage").hidden = false;
  const inspector = byId("inspector-panel");
  releaseDetailInspectorWasOpen = inspector.classList.contains("mobile-open");
  inspector.classList.remove("mobile-open");
  byId("public-release-detail-kicker").textContent = `${detail.mission} / PUBLIC RELEASE`;
  byId("public-release-detail-title").textContent = detail.label;
  byId("public-release-detail-summary").textContent = detail.description;
  const source = byId<HTMLAnchorElement>("public-release-detail-source");
  source.href = detail.officialSourceUrl;

  const acquired = detail.products.filter((product) => product.coverageStatus === "acquired").length;
  const metadata = byId("public-release-detail-metadata");
  metadata.replaceChildren(...([
    ["巡天 / 望远镜", detail.mission],
    ["发布类型", detail.kind.replaceAll("_", " ")],
    ["发布时间", detail.releasedYear ? String(detail.releasedYear) : "官方页面未注明"],
    ["观测类型", detail.modalities.join(" / ")],
    ["覆盖状态", acquired ? `${acquired} 个产品有真实几何` : "尚无产品可用于天球"],
  ] as Array<[string, string]>).map(([label, value]) => {
    const row = document.createElement("div");
    const term = document.createElement("dt"); term.textContent = label;
    const description = document.createElement("dd"); description.textContent = value;
    row.append(term, description);
    return row;
  }));
  byId("public-release-product-count").textContent = `${acquired} / ${detail.products.length} 已收录`;
  const list = byId("public-release-product-list");
  list.replaceChildren(...detail.products.map((product) => {
    const article = document.createElement("article");
    article.className = "public-release-product";
    article.dataset.coverageStatus = product.coverageStatus;
    const header = document.createElement("header");
    const identity = document.createElement("div");
    const name = document.createElement("h3"); name.textContent = product.name;
    const modality = document.createElement("span"); modality.textContent = product.modality;
    identity.append(name, modality);
    const status = document.createElement("strong"); status.textContent = PUBLIC_COVERAGE_LABELS[product.coverageStatus];
    header.append(identity, status);
    const description = document.createElement("p"); description.textContent = product.description;
    const explanation = document.createElement("p");
    explanation.className = "public-release-product-reason";
    explanation.textContent = product.coverageStatus === "acquired"
      ? "已保存可验证的天空几何制品，可在安装并应用对应公开资源后显示于 3D 天球。"
      : product.reason ?? "官方资料已登记，但尚未获得可验证的产品级天空几何。";
    const links = document.createElement("div"); links.className = "public-release-product-links";
    if (product.sourceUrl) {
      const link = document.createElement("a");
      link.href = product.sourceUrl; link.target = "_blank"; link.rel = "noreferrer";
      link.textContent = "覆盖来源 ↗";
      links.append(link);
    }
    if (product.artifactKey) {
      const artifact = document.createElement("code"); artifact.textContent = product.artifactKey;
      artifact.title = "覆盖制品的稳定身份";
      links.append(artifact);
    }
    const manualRecord = manualFootprintRecords.find((record) => record.surveyId === detail.surveyId
      && record.releaseId === detail.releaseId && record.product === product.name);
    if (product.coverageStatus === "awaiting_geometry" || manualRecord) {
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "release-detail-link";
      edit.textContent = manualRecord ? "维护覆盖范围" : "填写覆盖范围";
      edit.addEventListener("click", () => void openManualFootprintDialog(detail, product.name, product.sourceUrl));
      links.append(edit);
    }
    article.append(header, description, explanation, links);
    return article;
  }));
  if (updateUrl) {
    const url = new URL(window.location.href);
    url.searchParams.set("mode", "packages");
    url.searchParams.set("survey", surveyId);
    url.searchParams.set("release", releaseId);
    history.pushState(null, "", url);
  }
}

function showPublicSurveyOverview(surveyId: string, updateUrl = true): void {
  const survey = surveyRecordsById.get(surveyId);
  const releases = publicReleaseDetails.filter((detail) => detail.surveyId === surveyId);
  if (!survey || !releases.length) return;
  byId("resource-package-stage").hidden = true;
  byId("public-release-detail-stage").hidden = true;
  const stage = byId("public-survey-overview-stage");
  stage.hidden = false;
  byId("public-survey-overview-title").textContent = survey.name;
  byId("public-survey-overview-summary").textContent = survey.description;
  const list = byId("public-survey-overview-releases");
  list.replaceChildren(...releases.map((release) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "public-survey-overview-release";
    row.addEventListener("click", () => showPublicReleaseDetail(surveyId, release.releaseId));
    const title = document.createElement("strong"); title.textContent = release.label;
    const meta = document.createElement("small");
    const acquired = release.products.filter((product) => product.coverageStatus === "acquired").length;
    meta.textContent = `${release.releasedYear ?? "年份未注明"} · ${acquired} / ${release.products.length} 个产品有真实覆盖`;
    const status = document.createElement("span");
    status.textContent = acquired ? "可加载覆盖" : "覆盖范围尚未收录";
    status.dataset.available = String(acquired > 0);
    row.append(title, meta, status);
    return row;
  }));
  if (updateUrl) {
    const url = new URL(window.location.href);
    url.searchParams.set("mode", "packages");
    url.searchParams.set("survey", surveyId);
    url.searchParams.delete("release");
    history.pushState(null, "", url);
  }
}

function closePublicReleaseDetail(updateUrl = true): void {
  byId("public-release-detail-stage").hidden = true;
  byId("public-survey-overview-stage").hidden = true;
  byId("resource-package-stage").hidden = mode !== "packages";
  if (releaseDetailInspectorWasOpen && window.innerWidth <= 1040) byId("inspector-panel").classList.add("mobile-open");
  releaseDetailInspectorWasOpen = false;
  if (updateUrl) {
    const url = new URL(window.location.href);
    url.searchParams.set("mode", "packages");
    url.searchParams.delete("survey");
    url.searchParams.delete("release");
    history.pushState(null, "", url);
  }
}

function manualFootprintInput(): ManualFootprintInput {
  const pixels = byId<HTMLTextAreaElement>("manual-footprint-pixels").value.split(/[\s,]+/).filter(Boolean).map(Number);
  if (!pixels.length || pixels.some((pixel) => !Number.isSafeInteger(pixel) || pixel < 0)) throw new Error("pixels 必须是非负整数列表");
  return {
    surveyId: byId<HTMLInputElement>("manual-footprint-survey-id").value,
    releaseId: byId<HTMLInputElement>("manual-footprint-release-id").value,
    product: byId<HTMLInputElement>("manual-footprint-product").value,
    label: byId<HTMLInputElement>("manual-footprint-label").value.trim(),
    sourceUrl: byId<HTMLInputElement>("manual-footprint-source-url").value.trim(),
    method: byId<HTMLInputElement>("manual-footprint-method").value.trim(),
    calculatedAt: new Date(byId<HTMLInputElement>("manual-footprint-calculated-at").value).toISOString(),
    ordering: "NESTED",
    nside: 16,
    pixels,
  };
}

function setManualFootprintFeedback(message: string, status = "idle"): void {
  const feedback = byId("manual-footprint-feedback");
  feedback.textContent = message;
  feedback.dataset.status = status;
}

async function openManualFootprintDialog(detail: PublicReleaseDetail, product: string, sourceUrl?: string): Promise<void> {
  manualFootprintRecords = await workspaceApi.manualFootprints();
  editingManualFootprint = manualFootprintRecords.find((record) => record.surveyId === detail.surveyId && record.releaseId === detail.releaseId && record.product === product) ?? null;
  byId<HTMLInputElement>("manual-footprint-survey-id").value = detail.surveyId;
  byId<HTMLInputElement>("manual-footprint-release-id").value = detail.releaseId;
  byId<HTMLInputElement>("manual-footprint-product").value = product;
  byId<HTMLInputElement>("manual-footprint-label").value = editingManualFootprint?.label ?? `${detail.label} ${product}`;
  byId<HTMLInputElement>("manual-footprint-source-url").value = editingManualFootprint?.sourceUrl ?? sourceUrl ?? detail.officialSourceUrl;
  byId<HTMLInputElement>("manual-footprint-method").value = editingManualFootprint?.method ?? "manual-healpix";
  byId<HTMLInputElement>("manual-footprint-calculated-at").value = (editingManualFootprint?.calculatedAt ?? new Date().toISOString()).slice(0, 16);
  byId<HTMLTextAreaElement>("manual-footprint-pixels").value = editingManualFootprint?.pixels.join(", ") ?? "";
  byId<HTMLButtonElement>("manual-footprint-validate").disabled = editingManualFootprint?.status !== "draft";
  byId<HTMLButtonElement>("manual-footprint-publish").disabled = editingManualFootprint?.status !== "validated";
  byId<HTMLButtonElement>("manual-footprint-unpublish").disabled = editingManualFootprint?.status !== "published";
  const manualStatusLabels: Record<ManualFootprintRecord["status"], string> = {
    draft: "草稿，尚未校验",
    validated: "已校验，尚未发布",
    published: "已发布，正在用于数据覆盖",
  };
  setManualFootprintFeedback(editingManualFootprint ? `当前状态：${manualStatusLabels[editingManualFootprint.status]}` : "尚未保存");
  byId<HTMLDialogElement>("manual-footprint-dialog").showModal();
}

async function saveManualFootprint(): Promise<ManualFootprintRecord> {
  const input = manualFootprintInput();
  const token = byId<HTMLInputElement>("manual-footprint-token").value;
  editingManualFootprint = editingManualFootprint
    ? await workspaceApi.updateManualFootprint(input, editingManualFootprint.revision, token)
    : await workspaceApi.createManualFootprint(input, token);
  manualFootprintRecords = manualFootprintRecords.filter((record) => !(record.surveyId === input.surveyId
    && record.releaseId === input.releaseId && record.product === input.product));
  manualFootprintRecords.push(editingManualFootprint);
  byId<HTMLButtonElement>("manual-footprint-validate").disabled = false;
  byId<HTMLButtonElement>("manual-footprint-publish").disabled = true;
  byId<HTMLButtonElement>("manual-footprint-unpublish").disabled = true;
  setManualFootprintFeedback("草稿已保存", "ok");
  showPublicReleaseDetail(input.surveyId, input.releaseId, false);
  return editingManualFootprint;
}

async function refreshManualCoverage(surveyId: string, releaseId: string): Promise<void> {
  const previousSurveyIds = new Set(footprintSurveyIds());
  const [footprints, releases, records] = await Promise.all([
    workspaceApi.surveyFootprints(),
    workspaceApi.publicReleaseDetails(),
    workspaceApi.manualFootprints(),
  ]);
  surveyFootprints = footprints;
  publicReleaseDetails = releases;
  manualFootprintRecords = records;
  resourcePackagePanel.setReleaseDetails(releases);
  const available = new Set(footprintSurveyIds());
  visibleSurveyIds = new Set([...visibleSurveyIds].filter((id) => available.has(id)));
  for (const id of available) if (!previousSurveyIds.has(id)) visibleSurveyIds.add(id);
  selectedLayerRegion = null;
  buildSurveyList();
  persistLayerPreferences();
  if (mode === "packages") showPublicReleaseDetail(surveyId, releaseId, false);
  else if (mode === "layers") await activateMode("layers");
}

async function runManualFootprintAction(action: "validate" | "publish" | "unpublish"): Promise<void> {
  const record = editingManualFootprint ?? await saveManualFootprint();
  const identity = { surveyId: record.surveyId, releaseId: record.releaseId, product: record.product };
  const token = byId<HTMLInputElement>("manual-footprint-token").value;
  editingManualFootprint = action === "validate"
    ? await workspaceApi.validateManualFootprint(identity, record.revision, token)
    : action === "publish"
      ? await workspaceApi.publishManualFootprint(identity, record.revision, token)
      : await workspaceApi.unpublishManualFootprint(identity, record.revision, token);
  byId<HTMLButtonElement>("manual-footprint-validate").disabled = editingManualFootprint.status !== "draft";
  byId<HTMLButtonElement>("manual-footprint-publish").disabled = editingManualFootprint.status !== "validated";
  byId<HTMLButtonElement>("manual-footprint-unpublish").disabled = editingManualFootprint.status !== "published";
  setManualFootprintFeedback(action === "validate" ? "校验通过" : action === "publish" ? "已发布" : "已撤回", "ok");
  await refreshManualCoverage(record.surveyId, record.releaseId);
}

function applyLayerPreferences(): void {
  layerViewer?.setLayoutMode(layerLayoutMode);
  layerViewer?.setVisibleSurveys(new Set([...visibleSurveyIds, ...(unassignedWorkspaceVisible ? ["__unassigned__"] : [])]));
  layerViewer?.setVisibleAssets(visibleAssetIds);
  layerViewer?.setInteractionMode(layerInteractionMode);
  buildSurveyList();
  persistLayerPreferences();
  scheduleDrillRefresh();
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

function buildSurveyList(): void {
  const list = byId("survey-list");
  const workspaceSurveyIds = new Set([...workspaceAssetLayers.values()].map((layer) => layer.surveyId).filter((id): id is string => Boolean(id)));
  const cards = surveyCards.filter((survey) => footprintsForSurvey(survey.id).length > 0 || workspaceSurveyIds.has(survey.id)).map((survey) => {
    const footprints = footprintsForSurvey(survey.id);
    const hasFootprint = footprints.length > 0;
    const hasWorkspaceCoverage = workspaceSurveyIds.has(survey.id);
    const card = document.createElement("article");
    card.className = "survey-card";
    card.classList.toggle("visible", visibleSurveyIds.has(survey.id));
    const visibility = document.createElement("label");
    visibility.className = "survey-visibility";
    visibility.title = `Show ${survey.name}`;
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = visibleSurveyIds.has(survey.id);
    checkbox.setAttribute("aria-label", `Show ${survey.name}`);
    checkbox.addEventListener("change", () => setSurveyVisibility(survey.id, checkbox.checked));
    const swatch = document.createElement("i");
    swatch.style.background = survey.color;
    visibility.append(checkbox, swatch);
    const body = document.createElement("div");
    body.className = "survey-card-body";
    body.tabIndex = 0;
    body.addEventListener("click", () => void selectSurvey(survey.id).catch(showFatal));
    body.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        void selectSurvey(survey.id).catch(showFatal);
      }
    });
    const name = document.createElement("span");
    name.textContent = survey.name;
    const count = document.createElement("b");
    count.textContent = hasFootprint ? `${footprints.length}/${survey.releaseCount} MOC` : "WORKSPACE";
    const metadata = document.createElement("small");
    metadata.textContent = `${survey.mission} · ${hasFootprint ? "FOOTPRINT READY" : "WORKSPACE COVERAGE"}`;
    body.append(name, count, metadata);
    card.append(visibility, body);
    return card;
  });
  const assetList = byId("workspace-asset-list");
  const assets = userDataAssets();
  const assetCards = assets.map((asset) => {
    const card = document.createElement("article");
    card.className = "survey-card workspace-asset-card";
    card.classList.toggle("visible", visibleAssetIds.has(asset.id));
    const visibility = document.createElement("label");
    visibility.className = "survey-visibility";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = visibleAssetIds.has(asset.id);
    checkbox.setAttribute("aria-label", `显示用户资产 ${asset.name}`);
    checkbox.addEventListener("change", () => setAssetVisibility(asset.id, checkbox.checked));
    const swatch = document.createElement("i");
    swatch.style.background = workspaceAssetColor(asset.id);
    visibility.append(checkbox, swatch);
    const body = document.createElement("div");
    body.className = "survey-card-body";
    body.tabIndex = 0;
    body.addEventListener("click", () => { selectedLayerAssetId = asset.id; renderLayerAssetDetails(asset); });
    body.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectedLayerAssetId = asset.id; renderLayerAssetDetails(asset); }
    });
    const name = document.createElement("span"); name.textContent = asset.name;
    const layer = workspaceAssetLayers.get(asset.id);
    const status = document.createElement("b"); status.textContent = layer?.pixels.length ? `${formatInteger(layer.objectCount ?? 0)} OBJECTS` : "未建立覆盖";
    const metadata = document.createElement("small"); metadata.textContent = `${asset.surveyId ?? "未关联巡天"} · ${asset.releaseId ?? "未关联发布"}`;
    body.append(name, status, metadata);
    card.append(visibility, body);
    return card;
  });
  list.replaceChildren(...cards);
  assetList.replaceChildren(...assetCards);
  byId("layer-asset-count").textContent = String(assetCards.length);
  if (!cards.length && !assetCards.length && !hasUnassignedWorkspaceCoverage) {
    const empty = document.createElement("p");
    empty.className = "survey-list-empty";
    empty.textContent = "暂无可显示的巡天覆盖。请前往公开资源集应用公开覆盖，或通过连接器扫描工作区数据。";
    list.append(empty);
    return;
  }
  if (!hasUnassignedWorkspaceCoverage) return;
  const unassigned = document.createElement("article");
  unassigned.className = "survey-card workspace-unassigned";
  unassigned.classList.toggle("visible", unassignedWorkspaceVisible);
  const visibility = document.createElement("label");
  visibility.className = "survey-visibility";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = unassignedWorkspaceVisible;
  checkbox.setAttribute("aria-label", "显示未关联巡天数据");
  checkbox.addEventListener("change", () => setUnassignedWorkspaceVisibility(checkbox.checked));
  const swatch = document.createElement("i");
  swatch.style.background = "#d69b4e";
  visibility.append(checkbox, swatch);
  const body = document.createElement("div");
  body.className = "survey-card-body";
  const name = document.createElement("span");
  name.textContent = "未关联巡天";
  const count = document.createElement("b");
  count.textContent = "WORKSPACE";
  const metadata = document.createElement("small");
  metadata.textContent = "仅显示未绑定巡天的工作区覆盖";
  body.append(name, count, metadata);
  unassigned.append(visibility, body);
  list.append(unassigned);
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
  byId("public-release-detail-stage").hidden = true;
  byId("public-survey-overview-stage").hidden = true;
  byId("connector-stage").hidden = mode !== "connectors";
  byId("scene-stage").hidden = mode === "workflow" || mode === "catalog" || mode === "connectors" || mode === "packages";
  byId("workflow-stage").hidden = mode !== "workflow";
  document.querySelectorAll<HTMLElement>(".scene-action").forEach((element) => { element.hidden = mode === "workflow" || mode === "catalog" || mode === "connectors" || mode === "packages"; });
  byId("layer-tool-strip").hidden = mode !== "layers";
  byId("scene-legend").hidden = false;
  byId("region-scene-legend").hidden = mode !== "layers";
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
    byId("dataset-state").textContent = "公开巡天与望远镜覆盖目录已加载";
    const records = await workspaceApi.resourcePackages();
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
    const query = new URL(window.location.href).searchParams;
    const surveyId = query.get("survey");
    const releaseId = query.get("release");
     if (surveyId && releaseId) showPublicReleaseDetail(surveyId, releaseId, false);
     else if (surveyId) showPublicSurveyOverview(surveyId, false);
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
    layerViewer = new SurveyLayerViewer(targetCanvas, surveyFootprints!, surveyCards, renderSurveySelection, renderSurveyHover, renderSurveyInspection, renderLayerState, handleDrillEvent, renderSurveyObjectPoint);
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
    if (button.dataset.mode === "packages") closePublicReleaseDetail();
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
document.querySelectorAll<HTMLButtonElement>("[data-layer-interaction]").forEach((button) => {
  button.addEventListener("click", () => {
    chooseLayerInteraction(button.dataset.layerInteraction as SurveyLayerInteractionMode);
  });
});
byId<HTMLButtonElement>("layer-select-all").addEventListener("click", () => {
  visibleSurveyIds = new Set(footprintSurveyIds());
  visibleAssetIds = new Set(userDataAssets().map((asset) => asset.id));
  applyLayerPreferences();
  scheduleDrillRefresh();
});
byId<HTMLButtonElement>("layer-clear-all").addEventListener("click", () => {
  visibleSurveyIds.clear();
  visibleAssetIds.clear();
  unassignedWorkspaceVisible = false;
  applyLayerPreferences();
  scheduleDrillRefresh();
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
    layerViewer?.reset();
    drillHistory = [];
    drillSelectedCells = [];
    drillLevelNside = 16;
    drillMinimumNside = 16;
    drillParentOverride = null;
    layerViewer?.clearDrillCells();
    layerViewer?.clearObjectPoints();
    layerViewer?.setDrillFocus(false);
    scheduleDrillRefresh(0);
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
byId<HTMLButtonElement>("drill-back-button").addEventListener("click", () => {
  const previous = drillHistory.pop();
  if (!previous) return;
  drillLevelNside = previous.nside;
  drillMinimumNside = previous.nside;
  drillSelectedCells = previous.cells.map((cell) => ({ ...cell }));
  drillParentOverride = null;
  if (drillSelectedCells[0]) layerViewer?.focusDrillCell(drillSelectedCells[0].nside, drillSelectedCells[0].pixel);
  scheduleDrillRefresh(0);
  renderDrillStatus();
});
window.addEventListener("keydown", (event) => {
  if (mode !== "layers" || event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target as HTMLElement | null;
  if (target?.matches("input, textarea, select, [contenteditable='true']")) return;
  const key = event.key.toLocaleLowerCase();
  if (key === "f" || key === "g") {
    chooseLayerInteraction(key === "f" ? "inspect" : "region");
  } else return;
  event.preventDefault();
});
byId<HTMLButtonElement>("controls-toggle").addEventListener("click", () => controlsPanel.classList.toggle("mobile-open"));
byId<HTMLButtonElement>("public-release-detail-back").addEventListener("click", () => {
  const surveyId = new URL(window.location.href).searchParams.get("survey");
  if (surveyId) showPublicSurveyOverview(surveyId);
  else closePublicReleaseDetail();
});
byId<HTMLButtonElement>("public-survey-overview-back").addEventListener("click", () => closePublicReleaseDetail());
byId<HTMLButtonElement>("manual-footprint-dialog-close").addEventListener("click", () => byId<HTMLDialogElement>("manual-footprint-dialog").close());
byId<HTMLFormElement>("manual-footprint-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void saveManualFootprint().catch((error) => setManualFootprintFeedback(error instanceof Error ? error.message : String(error), "error"));
});
for (const action of ["validate", "publish", "unpublish"] as const) {
  byId<HTMLButtonElement>(`manual-footprint-${action}`).addEventListener("click", () => {
    setManualFootprintFeedback("处理中…", "busy");
    void runManualFootprintAction(action).catch((error) => setManualFootprintFeedback(error instanceof Error ? error.message : String(error), "error"));
  });
}
window.addEventListener("popstate", () => {
  if (mode !== "packages") return;
  const query = new URL(window.location.href).searchParams;
  const surveyId = query.get("survey");
  const releaseId = query.get("release");
   if (surveyId && releaseId) showPublicReleaseDetail(surveyId, releaseId, false);
   else if (surveyId) showPublicSurveyOverview(surveyId, false);
   else closePublicReleaseDetail(false);
});
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
  const [surveys, footprints, assets, releases, manualRecords] = await Promise.all([
    workspaceApi.surveys(),
    workspaceApi.surveyFootprints(),
    workspaceApi.dataAssets(),
    workspaceApi.publicReleaseDetails(),
    workspaceApi.manualFootprints(),
  ]);
  surveyCards = surveys;
  surveyFootprints = footprints;
  dataAssets = assets;
  publicReleaseDetails = releases;
  manualFootprintRecords = manualRecords;
  resourcePackagePanel.setReleaseDetails(releases);
  const surveyRecords = await Promise.all(surveys.map((survey) => workspaceApi.survey(survey.id)));
  surveyRecordsById.clear();
  surveyRecords.forEach((survey) => surveyRecordsById.set(survey.id, survey));
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
  byId("dataset-name").textContent = "Curated survey releases";
  byId("panel-dataset-name").textContent = "Survey registry";
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
    ...dataCatalogPanel.debugState(),
    ...workflowPanel.debugState(),
  });
  const initialQuery = new URL(window.location.href).searchParams;
  await activateMode(initialQuery.get("mode") === "packages" ? "packages" : initialQuery.get("mode") === "catalog" ? "catalog" : "layers");
}

void start().catch(showFatal);
