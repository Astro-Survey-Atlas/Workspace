import { createIcons, Download, Globe2, Layers3, MessageSquare, Play, Plus, RefreshCw, RotateCcw, Send, SlidersHorizontal } from "lucide";

import "./styles.css";
import {
  workspaceApi,
  type AtlasAngularCellData,
  type AtlasJointCellView,
  type AtlasJointQueryResponse,
  type AtlasRefinementResponse,
  type AstroOverviewResponse,
  type AstroSpatialSummary,
  type SurveyCard,
  type SurveyRecord,
  type SurveyFootprintManifest,
  type DataAssetRecord,
  type SurveyAtlasManifest,
  type VolumeManifest,
  type VolumePointData,
} from "./api";
import {
  SurveyLayerViewer,
  type SurveyLayerContextMenu,
  type SurveyLayerHover,
  type SurveyLayerInspection,
  type SurveyLayerInteractionMode,
  type SurveyLayerLayoutMode,
  type SurveyLayerSelection,
  type SurveyLayerState,
} from "./survey-layer-viewer";
import type { PublicResourcePackage } from "../../src/resource-packages";
import {
  VolumeViewer,
  type JointCellSelection,
  type VolumeSelection,
  type VolumeViewState,
} from "./volume-viewer";
import { WorkflowPanel } from "./workflow-panel";
import { DataCatalogPanel } from "./data-catalog-panel";
import { ConnectorPanel } from "./connector-panel";
import { ResourcePackagePanel } from "./resource-package-panel";
import { RegionRefinementViewer, type RegionRefinementState } from "./region-refinement-viewer";

type ViewMode = "catalog" | "packages" | "connectors" | "layers" | "refine" | "volume" | "workflow";
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
  return dataAssets.filter((asset) => {
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
let selectedSurvey: SurveyRecord | null = null;
const surveyRecordsById = new Map<string, SurveyRecord>();
let selectedLayerRegion: SurveyLayerSelection | null = null;
let refinementSourceRegion: SurveyLayerSelection | null = null;
let refinementState: RegionRefinementState | null = null;
let dataAssets: DataAssetRecord[] = [];
let refinementSurveyIds = new Set<string>();
let refinementModalities = new Set<string>();
let visibleSurveyIds = new Set<string>();
let workspaceSurveyIds = new Set<string>();
let unassignedWorkspaceVisible = false;
let layerLayoutMode: SurveyLayerLayoutMode = "layers";
let layerInteractionMode: SurveyLayerInteractionMode = "inspect";
let hoverDismissTimer: ReturnType<typeof setTimeout> | null = null;
let volumeManifest: VolumeManifest | null = null;
let volumePoints: VolumePointData | null = null;
let layerViewer: SurveyLayerViewer | null = null;
let refinementViewer: RegionRefinementViewer | null = null;
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
const workspaceCellSummaries = new Map<number, AstroSpatialSummary>();
const workspaceHoverRequests = new Set<number>();
let activeWorkspaceHover: SurveyLayerHover | null = null;
let astroInspectionGeneration = 0;
let radialTimer: ReturnType<typeof setTimeout> | null = null;
let activationGeneration = 0;
const workflowPanel = new WorkflowPanel((error) => console.error("Workflow UI request failed", error));
let connectorSelectionRequest: string | null = null;
const dataCatalogPanel = new DataCatalogPanel((error) => showFatal(error), (connectorId) => {
  connectorSelectionRequest = connectorId;
  void activateMode("connectors").catch(showFatal);
});
const connectorPanel = new ConnectorPanel((error) => showFatal(error));
const resourcePackagePanel = new ResourcePackagePanel(
  (before, after) => refreshActiveFootprints(before, after),
  (record) => renderResourcePackageDetails(record),
  (error) => showFatal(error),
);
const LAYER_PREFERENCES_KEY = "astro-workspace:survey-layer-preferences:v1";

createIcons({ icons: { Download, Globe2, Layers3, MessageSquare, Play, Plus, RefreshCw, RotateCcw, Send, SlidersHorizontal } });

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
  refinementViewer?.dispose();
  volumeViewer?.dispose();
  layerViewer = null;
  refinementViewer = null;
  volumeViewer = null;
  renderSurveyHover(null);
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
  canvas.dataset.selectedPixels = state.selectedPixels.join(",");
  byId("camera-distance").textContent = `${state.cameraDistance.toFixed(2)} R`;
  byId("layer-visible-output").textContent = `${state.visibleSurveyIds.length} ACTIVE`;
  byId("layer-selection-count").textContent = state.interactionMode === "inspect"
    ? state.pinnedCoveragePixel == null ? "F" : `CELL ${state.pinnedCoveragePixel}${state.lockedCoveragePixel === state.pinnedCoveragePixel ? " · LOCKED" : ""}`
    : state.selectedCellCount ? `${state.selectedCellCount} CELLS` : "G";
  renderRegionSceneLegend(state);
  const pinStatus = document.getElementById("coverage-pin-status") as HTMLButtonElement | null;
  if (pinStatus) {
    const locked = state.lockedCoveragePixel === state.pinnedCoveragePixel && state.lockedCoveragePixel != null;
    pinStatus.classList.toggle("active", locked);
    pinStatus.setAttribute("aria-pressed", String(locked));
    pinStatus.textContent = locked ? "已固定" : "未固定";
  }
  setActiveButtons("[data-layer-layout]", (button) => button.dataset.layerLayout === state.layoutMode);
  setActiveButtons("[data-layer-interaction]", (button) => button.dataset.layerInteraction === state.interactionMode);
  document.querySelectorAll<HTMLButtonElement>("[data-layer-interaction]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.layerInteraction === state.interactionMode)));
  const lockButton = byId<HTMLButtonElement>("coverage-lock-button");
  const locked = state.pinnedCoveragePixel != null && state.lockedCoveragePixel === state.pinnedCoveragePixel;
  lockButton.disabled = state.interactionMode !== "inspect" || state.pinnedCoveragePixel == null;
  lockButton.classList.toggle("active", locked);
  lockButton.setAttribute("aria-pressed", String(locked));
  byId("scene-mode-value").textContent = state.layoutMode === "layers" ? "VISUAL OFFSETS" : "OVERLAP COUNT";
  byId("legend-min").textContent = state.layoutMode === "layers" ? "图层内侧" : "1 SURVEY";
  byId("legend-max").textContent = state.layoutMode === "layers" ? "图层外侧" : "MOST OVERLAP";
  byId("scene-badge").textContent = state.interactionMode === "region"
    ? state.selectedCellCount ? "区域选择 · 已高亮" : "区域选择"
    : locked ? "查看模式 · 已固定" : "查看模式";
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
    const survey = surveyCards.find((entry) => entry.id === surveyId);
    const item = document.createElement("span");
    const swatch = document.createElement("i");
    swatch.style.background = survey?.color ?? "#f2cf62";
    item.append(swatch, survey?.name ?? surveyId);
    surveys.append(item);
  });
  if (!selectedLayerRegion.surveyIds.length) {
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
  if (selection) refinementSourceRegion = { ...selection, pixels: [...selection.pixels] };
  byId("inspector-kicker").textContent = "REGION SELECTION";
  if (!selection) {
    byId("region-scene-legend").hidden = true;
    if (selectedSurvey) renderSurveyDetails(selectedSurvey);
    else inspectorRows("", []);
    return;
  }
  const names = selection.surveyIds.map((id) => surveyCards.find((survey) => survey.id === id)?.name ?? id).join(" / ");
  const coverageSummary = selection.coverageCounts.map(({ surveyId, cellCount }) => `${surveyCards.find((survey) => survey.id === surveyId)?.name ?? surveyId}: ${cellCount}/${selection.pixels.length}`).join(" · ");
  const artifactSummary = selection.artifacts.map((artifact) => {
    const survey = surveyRecordsById.get(artifact.surveyId);
    const release = survey?.releases.find((entry) => entry.id === artifact.releaseId);
    return `${survey?.name ?? artifact.surveyId} ${release?.label ?? artifact.releaseId}: ${artifact.product} (${release?.modalities.join(", ") ?? "metadata pending"})`;
  }).join(" | ");
  const selectedAssets = assetsForSelection(selection);
  const searchAction = actionButton("细化选区并检索", () => void openRegionRefinement(selection).catch(showFatal));
  searchAction.dataset.action = "search-region";
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
  }));
  downloadAction.classList.add("secondary");
  downloadAction.dataset.action = "download-region";
  const clearAction = actionButton("清除所选区域", () => {
    refinementSourceRegion = null;
    layerViewer?.clearRegionSelection();
  });
  clearAction.classList.add("secondary");
  inspectorRows(`已锁定 ${selection.pixels.length} 个连续天区`, [
    ["天区中心", `RA ${selection.centerRaDeg.toFixed(4)}° · Dec ${selection.centerDecDeg >= 0 ? "+" : ""}${selection.centerDecDeg.toFixed(4)}°`],
    ["HEALPix mask", `NESTED · NSIDE ${selection.nside} · ${selection.pixels.length} cells`],
    ["外接角半径", `${selection.angularRadiusDeg.toFixed(2)}°`],
    ["数据巡天", names || "当前可见巡天暂无覆盖"],
    ["各巡天覆盖", coverageSummary || "0 个已登记覆盖单元"],
    ["未覆盖区块", `${selection.emptyCellCount} / ${selection.pixels.length}`],
    ["匹配数据发布", selection.releaseIds.join(" / ") || "无"],
    ["产品与模态", artifactSummary || "所选区块尚无已登记产品"],
    ["项目资产", projectStateSummary(selectedAssets)],
    ["选区状态", selection.notice ?? "完整角向选区已高亮；有数据的巡天切片叠加显示"],
  ], [searchAction, downloadAction, clearAction]);
  if (layerViewer) renderRegionSceneLegend(layerViewer.state);
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
  const pinStatus = document.createElement("button");
  pinStatus.id = "coverage-pin-status";
  pinStatus.className = "coverage-pin-status";
  pinStatus.type = "button";
  pinStatus.dataset.pixel = String(inspection.pixel);
  pinStatus.setAttribute("aria-pressed", "false");
  pinStatus.textContent = "未固定";
  pinStatus.title = "固定后，加载其他巡天时保持这个天区和覆盖栈";
  pinStatus.addEventListener("click", () => layerViewer?.setInspectionLocked(inspection.pixel, !pinStatus.classList.contains("active")));
  titleRow.append(heading, pinStatus);
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
  inspection.surveyIds.forEach((surveyId) => {
    const survey = surveyRecordsById.get(surveyId);
    const artifacts = inspection.artifacts.filter((artifact) => artifact.surveyId === surveyId);
    const group = document.createElement("section");
    const groupHeading = document.createElement("header");
    const swatch = document.createElement("i");
    swatch.style.background = surveyCards.find((card) => card.id === surveyId)?.color ?? "#42d4c6";
    const name = document.createElement("strong");
    name.textContent = survey?.name ?? surveyId;
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
  const cellAssets = dataAssets.filter((asset) => {
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
  const workspaceSection = renderWorkspaceDataSection(workspaceSummaryForPixel(inspection.pixel));
  workspaceSection.id = "coverage-workspace-data";
  content.replaceChildren(titleRow, coordinates, stack, projectState, workspaceSection, nextStep);
  void loadAstroInspection(inspection);
  if (window.innerWidth <= 1040) byId("inspector-panel").classList.add("mobile-open");
}

function footprintsForSurvey(surveyId: string) {
  return surveyFootprints?.footprints.filter((footprint) => footprint.surveyId === surveyId) ?? [];
}

function workspaceSummaryForPixel(pixel: number): AstroSpatialSummary | undefined {
  return workspaceCellSummaries.get(pixel) ?? astroOverview?.cells.find((cell) => cell.pixel === pixel);
}

function requestWorkspaceHoverSummary(hover: SurveyLayerHover): void {
  if (workspaceSummaryForPixel(hover.pixel) || workspaceHoverRequests.has(hover.pixel)) return;
  workspaceHoverRequests.add(hover.pixel);
  void workspaceApi.skyQuery({ cells: [hover.pixel], nside: hover.nside })
    .then((summary) => {
      workspaceCellSummaries.set(hover.pixel, summary);
      if (activeWorkspaceHover?.pixel === hover.pixel) renderSurveyHover(activeWorkspaceHover);
    })
    .catch((error) => console.warn("Unable to load workspace hover summary", error))
    .finally(() => workspaceHoverRequests.delete(hover.pixel));
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

async function loadWorkspaceAssetCoverage(): Promise<void> {
  const assetIds = dataAssets.map((asset) => asset.id).filter(Boolean);
  if (!assetIds.length) {
    workspaceSurveyIds.clear();
    layerViewer?.setWorkspaceCoverageLayers([], 16);
    return;
  }
  const coverage = await workspaceApi.skyCoverage({ nside: 16, assetIds });
  const layers = coverage.layers?.map((layer) => ({ ...layer, nside: coverage.nside })) ?? [{ key: "__workspace__", surveyId: undefined, releaseId: undefined, nside: coverage.nside, pixels: coverage.pixels }];
  workspaceSurveyIds = new Set(layers.filter((layer) => layer.pixels.length > 0).map((layer) => layer.surveyId).filter((surveyId): surveyId is string => Boolean(surveyId)));
  layerViewer?.setWorkspaceCoverageLayers(layers, coverage.nside);
  layerViewer?.setVisibleSurveys(new Set([...visibleSurveyIds, ...(unassignedWorkspaceVisible ? ["__unassigned__"] : [])]));
  buildSurveyList();
  if (coverage.status === "error") console.warn("Unable to load generic workspace coverage", coverage.message);
}

async function loadAstroInspection(inspection: SurveyLayerInspection): Promise<void> {
  const generation = ++astroInspectionGeneration;
  const summary = workspaceSummaryForPixel(inspection.pixel);
  try {
    const queried = await workspaceApi.skyQuery({
      cells: [inspection.pixel],
      nside: inspection.nside,
    });
    if (generation !== astroInspectionGeneration) return;
    workspaceCellSummaries.set(inspection.pixel, queried);
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
  canvas.dataset.hoveredCovered = String(hover.artifacts.length > 0);
  canvas.dataset.hoveredSelectable = String(hover.selectableInRegion);
  const stage = byId("scene-stage");
  const bounds = stage.getBoundingClientRect();
  const title = document.createElement("strong");
  title.textContent = `ICRS sky cell ${hover.pixel}`;
  const subtitle = document.createElement("span");
  subtitle.textContent = `RA ${hover.pointerRaDeg.toFixed(5)}° · Dec ${hover.pointerDecDeg >= 0 ? "+" : ""}${hover.pointerDecDeg.toFixed(5)}° · NSIDE ${hover.nside}`;
  const center = document.createElement("span");
  const localSummary = workspaceSummaryForPixel(hover.pixel);
  center.textContent = `Cell center ${hover.centerRaDeg.toFixed(5)}°, ${hover.centerDecDeg >= 0 ? "+" : ""}${hover.centerDecDeg.toFixed(5)}° · 官方 ${hover.artifacts.length} · 工作区 ${localSummary?.matchedFiles ?? 0}`;
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
  entries.append(renderWorkspaceDataSection(localSummary));
  if (!hover.artifacts.length) {
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

function renderSurveyContextMenu(menu: SurveyLayerContextMenu | null): void {
  const element = byId("coverage-context-menu");
  element.replaceChildren();
  if (!menu) {
    element.hidden = true;
    return;
  }
  const label = document.createElement("span");
  label.textContent = `HEALPix ${menu.pixel}`;
  const action = document.createElement("button");
  action.type = "button";
  action.textContent = menu.locked ? "取消固定此天区" : "固定此天区";
  action.addEventListener("click", () => {
    layerViewer?.setInspectionLocked(menu.pixel, !menu.locked);
    element.hidden = true;
  });
  element.append(label, action);
  element.hidden = false;
  const stageBounds = byId("scene-stage").getBoundingClientRect();
  element.style.left = `${Math.max(8, Math.min(menu.clientX - stageBounds.left, stageBounds.width - 166))}px`;
  element.style.top = `${Math.max(42, Math.min(menu.clientY - stageBounds.top, stageBounds.height - 76))}px`;
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
document.addEventListener("pointerdown", (event) => {
  const menu = byId("coverage-context-menu");
  if (!menu.contains(event.target as Node)) renderSurveyContextMenu(null);
});

function footprintLabel(status: SurveyCard["coverageStatus"]): string {
  if (status === "verified") return "FOOTPRINT READY";
  if (status === "summary_only") return "SUMMARY ONLY";
  return "FOOTPRINT PENDING";
}

function footprintSurveyIds(): string[] {
  const available = new Set(surveyFootprints?.footprints.map((footprint) => footprint.surveyId) ?? []);
  return surveyCards.filter((survey) => available.has(survey.id)).map((survey) => survey.id);
}

function activeRefinementBaseCoverage(): Set<number> {
  const selection = refinementSourceRegion ?? selectedLayerRegion;
  if (!selection) return new Set();
  const basePixels = new Set(selection.pixels);
  const covered = new Set<number>();
  surveyFootprints?.footprints.forEach((footprint) => {
    if (!refinementSurveyIds.has(footprint.surveyId)) return;
    footprint.pixels.forEach((pixel) => {
      if (basePixels.has(pixel)) covered.add(pixel);
    });
  });
  return covered;
}

function availableRefinementSurveyIds(): string[] {
  const source = refinementSourceRegion ?? selectedLayerRegion;
  if (!source) return [];
  const selected = new Set(source.pixels);
  const available = new Set((surveyFootprints?.footprints ?? [])
    .filter((footprint) => footprint.pixels.some((pixel) => selected.has(pixel)))
    .map((footprint) => footprint.surveyId));
  return surveyCards.filter((survey) => available.has(survey.id)).map((survey) => survey.id);
}

function refinementReleaseIds(): string[] {
  const selection = refinementSourceRegion ?? selectedLayerRegion;
  if (!selection || !refinementState) return [];
  const selectedBasePixels = new Set(refinementState.selectedPixels.map((pixel) => {
    const ratio = refinementState!.nside / selection.nside;
    return Math.floor(pixel / (ratio * ratio));
  }));
  return [...new Set((surveyFootprints?.footprints ?? [])
    .filter((footprint) => refinementSurveyIds.has(footprint.surveyId) && footprint.pixels.some((pixel) => selectedBasePixels.has(pixel)))
    .map((footprint) => footprint.releaseId))].sort();
}

function matchingRefinementAssets(): DataAssetRecord[] {
  if (!refinementState?.selectedPixels.length || !refinementSurveyIds.size || !refinementModalities.size) return [];
  const releases = new Set(refinementReleaseIds());
  return dataAssets.filter((asset) => {
    const surveyId = asset.surveyBinding?.surveyId ?? asset.surveyId;
    const releaseId = asset.surveyBinding?.releaseId ?? asset.releaseId;
    if (!surveyId || !refinementSurveyIds.has(surveyId)) return false;
    if (releaseId && !releases.has(releaseId)) return false;
    if (refinementModalities.size && !asset.modalities.some((modality) => refinementModalities.has(modality))) return false;
    return true;
  });
}

function renderRefinementFilters(): void {
  const selection = refinementSourceRegion ?? selectedLayerRegion;
  if (!selection) return;
  const surveyList = byId("refinement-survey-list");
  const availableSurveys = availableRefinementSurveyIds();
  surveyList.replaceChildren(...availableSurveys.map((surveyId) => {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = refinementSurveyIds.has(surveyId);
    input.addEventListener("change", () => {
      if (input.checked) refinementSurveyIds.add(surveyId);
      else refinementSurveyIds.delete(surveyId);
      refinementViewer?.setCoveredBasePixels(activeRefinementBaseCoverage());
      renderRefinementFilters();
      renderRefinementInspector();
    });
    const swatch = document.createElement("i");
    swatch.style.background = surveyCards.find((survey) => survey.id === surveyId)?.color ?? "#42d4c6";
    const name = document.createElement("span");
    name.textContent = surveyCards.find((survey) => survey.id === surveyId)?.name ?? surveyId;
    label.append(input, swatch, name);
    return label;
  }));
  byId("refinement-survey-count").textContent = `${refinementSurveyIds.size}/${availableSurveys.length}`;

  const availableModalities = [...new Set(availableSurveys.flatMap((surveyId) => surveyRecordsById.get(surveyId)?.modalities ?? []))].sort();
  const modalityList = byId("refinement-modality-list");
  modalityList.replaceChildren(...availableModalities.map((modality) => {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = refinementModalities.has(modality);
    input.addEventListener("change", () => {
      if (input.checked) refinementModalities.add(modality);
      else refinementModalities.delete(modality);
      renderRefinementFilters();
      renderRefinementInspector();
    });
    const name = document.createElement("span");
    name.textContent = modality;
    label.append(input, name);
    return label;
  }));
  byId("refinement-modality-count").textContent = `${refinementModalities.size}/${availableModalities.length}`;
}

function renderRefinementInspector(): void {
  const selection = refinementSourceRegion ?? selectedLayerRegion;
  const state = refinementState;
  if (!selection || !state) return;
  const assets = matchingRefinementAssets();
  const releaseIds = refinementReleaseIds();
  const download = actionButton("导出检索清单", () => downloadJson(`sky-data-query-nside-${state.nside}.json`, {
    schemaVersion: 1,
    coordinateFrame: "ICRS",
    spatialConstraint: { type: "healpix-mask", ordering: "NESTED", nside: state.nside, pixels: state.selectedPixels },
    coverageResolution: { nside: selection.nside, method: "inherited-parent-footprint" },
    surveys: [...refinementSurveyIds].sort(),
    releases: releaseIds,
    modalities: [...refinementModalities].sort(),
    assets: assets.map((asset) => ({ id: asset.id, surveyId: asset.surveyBinding?.surveyId ?? asset.surveyId, releaseId: asset.surveyBinding?.releaseId ?? asset.releaseId, product: asset.product, connector: asset.access.connector, uri: asset.access.uri })),
  }));
  download.dataset.action = "export-refined-query";
  const back = actionButton("返回项目态势", () => void activateMode("layers").catch(showFatal));
  back.classList.add("secondary");
  inspectorRows(`已筛得 ${assets.length} 个数据资产`, [
    ["精细选区", `NESTED · NSIDE ${state.nside} · ${state.selectedPixels.length} cells`],
    ["估算面积", `${state.selectedAreaDeg2.toFixed(3)} deg²`],
    ["巡天", [...refinementSurveyIds].map((id) => surveyCards.find((survey) => survey.id === id)?.name ?? id).join(" / ") || "未选择"],
    ["发布", releaseIds.join(" / ") || "无匹配覆盖"],
    ["模态", [...refinementModalities].join(" / ") || "未选择"],
    ["覆盖精度", `登记 footprint NSIDE ${selection.nside}；细块继承父块覆盖`],
    ["候选资产", assets.map((asset) => `${asset.name} [${asset.status}]`).join(" · ") || "数据目录中暂无匹配资产"],
  ], [download, back]);
  byId<HTMLButtonElement>("refinement-next").disabled = !state.canRefine;
  byId<HTMLButtonElement>("refinement-back").disabled = !state.canGoBack;
}

function renderRefinementState(state: RegionRefinementState): void {
  refinementState = state;
  canvas.dataset.mode = "refine";
  canvas.dataset.refinementNside = String(state.nside);
  canvas.dataset.candidatePixels = state.candidatePixels.join(",");
  canvas.dataset.selectedPixels = state.selectedPixels.join(",");
  canvas.dataset.cameraDistance = state.cameraDistance.toFixed(6);
  byId("camera-distance").textContent = `${state.cameraDistance.toFixed(2)} R`;
  byId("refinement-level-output").textContent = `NSIDE ${state.nside}`;
  byId("refinement-candidate-count").textContent = formatInteger(state.candidatePixels.length);
  byId("refinement-selected-count").textContent = formatInteger(state.selectedPixels.length);
  byId("refinement-area").textContent = `${state.selectedAreaDeg2.toFixed(3)} deg²`;
  byId("scene-mode-value").textContent = `NESTED NSIDE ${state.nside}`;
  byId("scene-badge").textContent = `${state.selectedPixels.length} / ${state.candidatePixels.length} 子块已保留`;
  byId("layer-selection-count").textContent = `NSIDE ${state.nside}`;
  renderRefinementInspector();
}

async function openRegionRefinement(selection: SurveyLayerSelection): Promise<void> {
  selectedLayerRegion = selection;
  refinementSourceRegion = { ...selection, pixels: [...selection.pixels] };
  const availableSurveys = availableRefinementSurveyIds();
  refinementSurveyIds = new Set(availableSurveys);
  refinementModalities = new Set(availableSurveys.flatMap((surveyId) => surveyRecordsById.get(surveyId)?.modalities ?? []));
  await activateMode("refine");
}

function restoreLayerPreferences(): void {
  const available = new Set(footprintSurveyIds());
  try {
    const stored = JSON.parse(localStorage.getItem(LAYER_PREFERENCES_KEY) ?? "null") as {
      visibleSurveyIds?: string[];
      layoutMode?: SurveyLayerLayoutMode;
      interactionMode?: SurveyLayerInteractionMode;
      unassignedWorkspaceVisible?: boolean;
    } | null;
    const restored = stored?.visibleSurveyIds?.filter((surveyId) => available.has(surveyId)) ?? [];
    if (restored.length || stored?.visibleSurveyIds?.length === 0) visibleSurveyIds = new Set(restored);
    else if (available.has("legacy-surveys")) visibleSurveyIds = new Set(["legacy-surveys"]);
    else visibleSurveyIds = new Set([...available].slice(0, 1));
    layerLayoutMode = stored?.layoutMode === "overlap" ? "overlap" : "layers";
    layerInteractionMode = stored?.interactionMode === "region" ? "region" : "inspect";
    unassignedWorkspaceVisible = stored?.unassignedWorkspaceVisible === true;
  } catch {
    visibleSurveyIds = available.has("legacy-surveys") ? new Set(["legacy-surveys"]) : new Set([...available].slice(0, 1));
    layerLayoutMode = "layers";
    layerInteractionMode = "inspect";
    unassignedWorkspaceVisible = false;
  }
}

function persistLayerPreferences(): void {
  localStorage.setItem(LAYER_PREFERENCES_KEY, JSON.stringify({
    visibleSurveyIds: [...visibleSurveyIds],
    layoutMode: layerLayoutMode,
    interactionMode: layerInteractionMode,
    unassignedWorkspaceVisible,
  }));
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
  refinementSourceRegion = null;
  refinementState = null;
  refinementSurveyIds = new Set();
  refinementModalities = new Set();
  astroOverview = null;
  workspaceCellSummaries.clear();
  buildSurveyList();
  persistLayerPreferences();
  if (mode === "layers" || mode === "refine") await activateMode("layers");
}

function renderResourcePackageDetails(record: PublicResourcePackage): void {
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
    ["Mission", survey?.mission ?? record.facilities.join(" / ")],
    ["Modalities", record.modalities.join(" / ")],
    ["Wavelengths", record.wavelengths.join(" / ")],
    ["Products", record.productTypes.join(" / ")],
    ["Coverage authority", record.coverageAuthorities.join(" / ")],
    ["Releases", record.releases.join(" / ")],
    ["Package", `${record.version} / ${(record.sizeBytes / 1024).toFixed(1)} KB`],
    ["SHA256", record.sha256],
    ["Server state", record.active ? "已加载" : record.installedVersion ? "已下载，未加载" : "未下载"],
  ];
  for (const [label, value] of rows) {
    const row = document.createElement("div");
    const term = document.createElement("dt"); term.textContent = label;
    const detail = document.createElement("dd"); detail.textContent = value;
    row.append(term, detail);
    metadata.append(row);
  }
  const releases = document.createElement("div");
  releases.className = "release-list";
  for (const entry of survey?.releases ?? []) {
    const item = document.createElement("article");
    item.className = "release-row";
    const line = document.createElement("div");
    const title = document.createElement("strong"); title.textContent = entry.label;
    const status = document.createElement("span"); status.textContent = entry.coverage.status.toUpperCase(); status.dataset.status = entry.coverage.status;
    line.append(title, status);
    const detail = document.createElement("p");
    detail.textContent = `${entry.modalities.join(", ")} / ${entry.products.map((product) => product.name).join(", ")} / ${entry.coverage.summary}`;
    const source = document.createElement("a"); source.href = entry.coverage.sourceUrl; source.target = "_blank"; source.rel = "noreferrer"; source.textContent = "Release source";
    item.append(line, detail, source);
    releases.append(item);
  }
  for (const entry of record.sources) {
    const item = document.createElement("article");
    item.className = "release-row";
    const line = document.createElement("div");
    const title = document.createElement("strong"); title.textContent = entry.label;
    const status = document.createElement("span"); status.textContent = entry.authority; status.dataset.status = "verified";
    line.append(title, status);
    const detail = document.createElement("p"); detail.textContent = entry.license ? `Artifact license: ${entry.license}` : "Upstream terms apply";
    const source = document.createElement("a"); source.href = entry.url; source.target = "_blank"; source.rel = "noreferrer"; source.textContent = "Coverage source";
    item.append(line, detail, source);
    releases.append(item);
  }
  content.replaceChildren(heading, summary, metadata, releases);
}

function applyLayerPreferences(): void {
  layerViewer?.setLayoutMode(layerLayoutMode);
  layerViewer?.setVisibleSurveys(new Set([...visibleSurveyIds, ...(unassignedWorkspaceVisible ? ["__unassigned__"] : [])]));
  layerViewer?.setInteractionMode(layerInteractionMode);
  buildSurveyList();
  persistLayerPreferences();
}

function chooseLayerInteraction(nextMode: SurveyLayerInteractionMode): void {
  if (nextMode === "inspect") {
    refinementSourceRegion = null;
  }
  layerInteractionMode = nextMode;
  applyLayerPreferences();
}

function setSurveyVisibility(surveyId: string, visible: boolean): void {
  if (visible) visibleSurveyIds.add(surveyId);
  else visibleSurveyIds.delete(surveyId);
  if (selectedSurvey?.id === surveyId && !visible) selectedSurvey = null;
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

function buildSurveyList(): void {
  const list = byId("survey-list");
  list.replaceChildren(...surveyCards.map((survey) => {
    const footprints = footprintsForSurvey(survey.id);
    const hasFootprint = footprints.length > 0;
    const hasWorkspaceCoverage = workspaceSurveyIds.has(survey.id);
    const available = hasFootprint || hasWorkspaceCoverage;
    const card = document.createElement("article");
    card.className = "survey-card";
    card.classList.toggle("visible", visibleSurveyIds.has(survey.id));
    card.classList.toggle("pending", !available);
    const visibility = document.createElement("label");
    visibility.className = "survey-visibility";
    visibility.title = available ? `Show ${survey.name}` : `${survey.name} footprint is pending`;
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = visibleSurveyIds.has(survey.id);
    checkbox.disabled = !available;
    checkbox.setAttribute("aria-label", `Show ${survey.name}`);
    checkbox.addEventListener("change", () => setSurveyVisibility(survey.id, checkbox.checked));
    const swatch = document.createElement("i");
    swatch.style.background = survey.color;
    visibility.append(checkbox, swatch);
    const body = document.createElement("div");
    body.className = "survey-card-body";
    body.tabIndex = available ? 0 : -1;
    body.addEventListener("click", () => available && setSurveyVisibility(survey.id, !visibleSurveyIds.has(survey.id)));
    body.addEventListener("keydown", (event) => {
      if (available && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        setSurveyVisibility(survey.id, !visibleSurveyIds.has(survey.id));
      }
    });
    const name = document.createElement("span");
    name.textContent = survey.name;
    const count = document.createElement("b");
    count.textContent = hasFootprint ? `${footprints.length}/${survey.releaseCount} MOC` : hasWorkspaceCoverage ? "WORKSPACE" : "PENDING";
    const metadata = document.createElement("small");
    metadata.textContent = `${survey.mission} · ${footprintLabel(survey.coverageStatus)}`;
    body.append(name, count, metadata);
    card.append(visibility, body);
    return card;
  }));
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
  body.tabIndex = 0;
  body.addEventListener("click", () => setUnassignedWorkspaceVisibility(!unassignedWorkspaceVisible));
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
  if (nextMode === "refine" && !refinementSourceRegion && !selectedLayerRegion) throw new Error("请先在项目态势中选择连续天区");
  if (nextMode === "volume" && (!atlas || !angularCells || !volumeManifest)) throw new Error("Joint volume is not configured");
  const sourceRegion = refinementSourceRegion ?? selectedLayerRegion;
  const returningLayerRegion = nextMode === "layers" && sourceRegion
    ? { ...sourceRegion, pixels: [...sourceRegion.pixels] }
    : null;
  activationGeneration += 1;
  const generation = activationGeneration;
  mode = nextMode;
  destroyViewer();
  setActiveButtons("[data-mode]", (button) => button.dataset.mode === mode);
  byId("catalog-controls").hidden = mode !== "catalog";
  byId("resource-package-controls").hidden = mode !== "packages";
  byId("connector-controls").hidden = mode !== "connectors";
  byId("layer-controls").hidden = mode !== "layers";
  byId("refinement-controls").hidden = mode !== "refine";
  byId("volume-controls").hidden = mode !== "volume";
  byId("workflow-controls").hidden = mode !== "workflow";
  byId("catalog-stage").hidden = mode !== "catalog";
  byId("asset-detail-stage").hidden = true;
  byId("resource-package-stage").hidden = mode !== "packages";
  byId("connector-stage").hidden = mode !== "connectors";
  byId("scene-stage").hidden = mode === "workflow" || mode === "catalog" || mode === "connectors" || mode === "packages";
  byId("workflow-stage").hidden = mode !== "workflow";
  byId("inspector-view").hidden = mode === "workflow";
  byId("agent-panel").hidden = mode !== "workflow";
  byId("agent-toggle").hidden = mode === "volume";
  const inspectorLabel = mode === "workflow" ? "显示 Agent" : mode === "catalog" ? "显示数据详情" : mode === "packages" ? "显示巡天信息" : mode === "refine" ? "显示检索详情" : "显示覆盖详情";
  byId("agent-toggle").setAttribute("aria-label", inspectorLabel);
  byId("agent-toggle").setAttribute("title", inspectorLabel);
  document.querySelectorAll<HTMLElement>(".scene-action").forEach((element) => { element.hidden = mode === "workflow" || mode === "catalog" || mode === "connectors" || mode === "packages"; });
  byId("layer-tool-strip").hidden = mode !== "layers";
  byId("scene-legend").hidden = mode === "refine";
  byId("region-scene-legend").hidden = mode !== "layers";
  byId("context-summary").hidden = mode === "refine";
  document.querySelector<HTMLElement>(".workspace-shell")?.classList.toggle("workflow-active", mode === "workflow");
  document.querySelector<HTMLElement>(".workspace-shell")?.classList.toggle("catalog-active", mode === "catalog");
  document.querySelector<HTMLElement>(".workspace-shell")?.classList.toggle("connector-active", mode === "connectors");
  byId("inspector-panel").classList.remove("mobile-open");
  inspectorRows("", []);
  loadingIndicator.classList.add("visible");

  if (mode === "catalog") {
    workflowPanel.deactivate();
    resourcePackagePanel.deactivate();
    byId("panel-kicker").textContent = "DATA CATALOG";
    byId("panel-dataset-name").textContent = "数据资产登记";
    byId("dataset-state").textContent = "内置与用户数据目录已加载";
    renderProjectMetrics();
    byId("render-status").textContent = "CATALOG REGISTRY";
    byId("object-status").textContent = "NO RAW DATA COPIED";
    loadingIndicator.classList.remove("visible");
    await dataCatalogPanel.activate(surveyCards, surveyRecordsById);
    byId("metric-one").textContent = String((dataCatalogPanel.debugState().catalogAssetCount as number | undefined) ?? 0);
    return;
  }

  dataCatalogPanel.deactivate();
  resourcePackagePanel.deactivate();
  if (mode === "packages") {
    workflowPanel.deactivate();
    byId("inspector-kicker").textContent = "SURVEY INFORMATION";
    byId("panel-kicker").textContent = "PUBLIC COVERAGE PACKAGES";
    byId("panel-dataset-name").textContent = "资源集";
    byId("dataset-state").textContent = "公开覆盖包目录已加载";
    const records = await workspaceApi.resourcePackages();
    byId("metric-one-label").textContent = "PACKAGES";
    byId("metric-one").textContent = String(records.length);
    byId("metric-two-label").textContent = "INSTALLED";
    byId("metric-two").textContent = String(records.filter((record) => record.installedVersion).length);
    byId("metric-three-label").textContent = "ACTIVE";
    byId("metric-three").textContent = String(records.filter((record) => record.active).length);
    byId("metric-four-label").textContent = "SURVEYS";
    byId("metric-four").textContent = String(new Set(records.filter((record) => record.active).map((record) => record.surveyId)).size);
    byId("metric-five-label").textContent = "FOOTPRINTS";
    byId("metric-five").textContent = String(surveyFootprints?.footprints.length ?? 0);
    byId("render-status").textContent = "PUBLIC COVERAGE PACKAGES";
    byId("object-status").textContent = `${surveyFootprints?.footprints.length ?? 0} COVERAGE SOURCES`;
    loadingIndicator.classList.remove("visible");
    await resourcePackagePanel.activate();
    return;
  }
  if (mode === "connectors") {
    workflowPanel.deactivate();
    byId("panel-kicker").textContent = "CONNECTOR REGISTRY";
    byId("panel-dataset-name").textContent = "连接器配置";
    byId("dataset-state").textContent = "连接测试按需执行，目录扫描由 FlinkIngest 负责";
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
  byId("panel-dataset-name").textContent = mode === "layers" ? "巡天图层" : mode === "refine" ? "选区细化" : atlas?.name ?? "Joint volume";
  const targetCanvas = freshCanvas();

  if (mode === "layers") {
    byId("inspector-kicker").textContent = "PROJECT SKY STATUS";
    byId("panel-kicker").textContent = "PROJECT SKY STATUS";
    byId("panel-dataset-name").textContent = "项目态势";
    byId("dataset-state").textContent = "公开覆盖与项目资产状态已载入";
    renderProjectMetrics();
    byId("scene-mode-label").textContent = "PROJECT COVERAGE";
    byId("scene-mode-value").textContent = "PUBLIC + OWNED";
    byId("scene-badge").textContent = "项目覆盖态势";
    byId("legend-min").textContent = "公开覆盖";
    byId("legend-max").textContent = "项目资产";
    byId("object-status").textContent = `${surveyFootprints?.footprints.length ?? 0} COVERAGE SOURCES`;
    layerViewer = new SurveyLayerViewer(targetCanvas, surveyFootprints!, surveyCards, renderSurveySelection, renderSurveyHover, renderSurveyInspection, renderSurveyContextMenu, renderLayerState);
    layerViewer.setLayoutMode(layerLayoutMode);
    layerViewer.setVisibleSurveys(visibleSurveyIds);
    layerViewer.setInteractionMode(layerInteractionMode);
    applyLayerPreferences();
    if (returningLayerRegion) {
      layerInteractionMode = "region";
      layerViewer.setInteractionMode("region");
      layerViewer.setRegionSelection(returningLayerRegion.pixels);
    }
    void loadEuclidAstroOverview().catch((error) => {
      console.warn("Unable to load Euclid workspace coverage overview", error);
    });
    void loadWorkspaceAssetCoverage().catch((error) => {
      console.warn("Unable to load custom workspace coverage", error);
    });
    byId("render-status").textContent = layerViewer.webglVersion;
    loadingIndicator.classList.remove("visible");
  } else if (mode === "refine") {
    byId("inspector-kicker").textContent = "DATA RETRIEVAL SCOPE";
    byId("scene-mode-label").textContent = "REFINE";
    byId("scene-mode-value").textContent = "NESTED HEALPIX";
    byId("scene-badge").textContent = "选区已实体化";
    byId("legend-min").textContent = "排除";
    byId("legend-max").textContent = "保留 / 有覆盖";
    byId("object-status").textContent = "EXACT ANGULAR MASK";
    renderRefinementFilters();
    refinementViewer = new RegionRefinementViewer(
      targetCanvas,
      sourceRegion!.nside,
      sourceRegion!.pixels,
      activeRefinementBaseCoverage(),
      renderRefinementState,
    );
    byId("render-status").textContent = refinementViewer.webglVersion;
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
  button.addEventListener("click", () => void activateMode(button.dataset.mode as ViewMode).catch(showFatal));
});
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
byId<HTMLButtonElement>("coverage-lock-button").addEventListener("click", () => layerViewer?.togglePinnedInspectionLock());
byId<HTMLButtonElement>("refinement-next").addEventListener("click", () => refinementViewer?.refine());
byId<HTMLButtonElement>("refinement-back").addEventListener("click", () => refinementViewer?.goBack());
byId<HTMLButtonElement>("layer-select-all").addEventListener("click", () => {
  visibleSurveyIds = new Set([...footprintSurveyIds(), ...workspaceSurveyIds]);
  applyLayerPreferences();
});
byId<HTMLButtonElement>("layer-clear-all").addEventListener("click", () => {
  visibleSurveyIds.clear();
  unassignedWorkspaceVisible = false;
  applyLayerPreferences();
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
  if (mode === "layers") layerViewer?.reset();
  else if (mode === "refine") refinementViewer?.reset();
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
window.addEventListener("keydown", (event) => {
  if (mode !== "layers" || event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target as HTMLElement | null;
  if (target?.matches("input, textarea, select, [contenteditable='true']")) return;
  const key = event.key.toLocaleLowerCase();
  if (key === "f" || key === "g") {
    chooseLayerInteraction(key === "f" ? "inspect" : "region");
  } else if (key === "c") {
    layerViewer?.togglePinnedInspectionLock();
  } else return;
  event.preventDefault();
});
byId<HTMLButtonElement>("controls-toggle").addEventListener("click", () => controlsPanel.classList.toggle("mobile-open"));
byId<HTMLButtonElement>("agent-toggle").addEventListener("click", () => byId("inspector-panel").classList.toggle("mobile-open"));
window.addEventListener("astro:navigate", (event) => {
  const nextMode = (event as CustomEvent<{ mode?: ViewMode }>).detail?.mode;
  if (nextMode === "layers" || nextMode === "volume") void activateMode(nextMode).catch(showFatal);
});

declare global {
  interface Window {
    __ASTRO_WORKSPACE_DEBUG__?: () => Record<string, unknown>;
  }
}

async function start(): Promise<void> {
  const [surveys, footprints, assets] = await Promise.all([workspaceApi.surveys(), workspaceApi.surveyFootprints(), workspaceApi.dataAssets()]);
  surveyCards = surveys;
  surveyFootprints = footprints;
  dataAssets = assets;
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
  await activateMode("catalog");
}

void start().catch(showFatal);
