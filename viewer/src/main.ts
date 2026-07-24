import { Box, createIcons, Download, Globe2, Layers3, MessageSquare, Play, Plus, RefreshCw, RotateCcw, Send, SlidersHorizontal } from "lucide";

import "./styles.css";
import {
  workspaceApi,
  type AtlasAngularCellData,
  type AtlasJointCellView,
  type AtlasJointQueryResponse,
  type AtlasRefinementResponse,
  type SurveyCard,
  type SurveyRecord,
  type SurveyFootprintManifest,
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
import {
  VolumeViewer,
  type JointCellSelection,
  type VolumeSelection,
  type VolumeViewState,
} from "./volume-viewer";
import { WorkflowPanel } from "./workflow-panel";
import { DataCatalogPanel } from "./data-catalog-panel";

type ViewMode = "catalog" | "layers" | "volume" | "workflow";
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
let visibleSurveyIds = new Set<string>();
let layerLayoutMode: SurveyLayerLayoutMode = "layers";
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
let radialTimer: ReturnType<typeof setTimeout> | null = null;
let activationGeneration = 0;
const workflowPanel = new WorkflowPanel((error) => console.error("Workflow UI request failed", error));
const dataCatalogPanel = new DataCatalogPanel((error) => showFatal(error));
const LAYER_PREFERENCES_KEY = "astro-workspace:survey-layer-preferences:v1";

createIcons({ icons: { Box, Download, Globe2, Layers3, MessageSquare, Play, Plus, RefreshCw, RotateCcw, Send, SlidersHorizontal } });

function showFatal(error: unknown): void {
  console.error(error);
  byId("dataset-state").textContent = "载入失败";
  byId("service-status").textContent = "SERVICE ERROR";
  loadingIndicator.textContent = error instanceof Error ? error.message : String(error);
  loadingIndicator.classList.add("visible", "error");
}

function freshCanvas(): HTMLCanvasElement {
  const replacement = canvas.cloneNode(false) as HTMLCanvasElement;
  canvas.replaceWith(replacement);
  canvas = replacement;
  return replacement;
}

function destroyViewer(): void {
  layerViewer?.dispose();
  volumeViewer?.dispose();
  layerViewer = null;
  volumeViewer = null;
  selectedLayerRegion = null;
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
  byId("camera-distance").textContent = `${state.cameraDistance.toFixed(2)} R`;
  byId("layer-nside-output").textContent = `NSIDE ${state.nside}`;
  byId("layer-visible-output").textContent = `${state.visibleSurveyIds.length} ACTIVE`;
  byId("layer-selection-count").textContent = state.interactionMode === "inspect"
    ? state.pinnedCoveragePixel == null ? "查看数据" : `CELL ${state.pinnedCoveragePixel}${state.lockedCoveragePixel === state.pinnedCoveragePixel ? " · 已固定" : ""}`
    : state.selectedCellCount ? `已选 ${state.selectedCellCount} 个` : "尚未选择";
  const pinStatus = document.getElementById("coverage-pin-status") as HTMLButtonElement | null;
  if (pinStatus) {
    const locked = state.lockedCoveragePixel === state.pinnedCoveragePixel && state.lockedCoveragePixel != null;
    pinStatus.classList.toggle("active", locked);
    pinStatus.setAttribute("aria-pressed", String(locked));
    pinStatus.textContent = locked ? "已固定" : "未固定";
  }
  setActiveButtons("[data-layer-layout]", (button) => button.dataset.layerLayout === state.layoutMode);
  setActiveButtons("[data-layer-interaction]", (button) => button.dataset.layerInteraction === state.interactionMode);
  byId("scene-mode-value").textContent = state.layoutMode === "layers" ? "FRAGMENT OFFSETS" : "OVERLAP COUNT";
  byId("legend-min").textContent = state.layoutMode === "layers" ? "INNER" : "1 SURVEY";
  byId("legend-max").textContent = state.layoutMode === "layers" ? "OUTER" : "MOST OVERLAP";
  byId("scene-badge").textContent = state.interactionMode === "region"
    ? state.selectedCellCount ? `已选择 ${state.selectedCellCount} 个 HEALPix 区块` : "区域选择已开启"
    : "DISPLAY LAYERS · NOT DISTANCE";
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
    if (layerInteractionMode === "region") byId("layer-interaction-note").textContent = "点击一个 HEALPix 区块开始；之后点击共享边界的相邻区块自动扩展选区。";
    if (selectedSurvey) renderSurveyDetails(selectedSurvey);
    else inspectorRows("", []);
    return;
  }
  byId("layer-interaction-note").textContent = `当前已组合 ${selection.pixels.length} 个相邻区块。每个巡天层只点亮自身实际覆盖的部分。`;
  const names = selection.surveyIds.map((id) => surveyCards.find((survey) => survey.id === id)?.name ?? id).join(" / ");
  const coverageSummary = selection.coverageCounts.map(({ surveyId, cellCount }) => `${surveyCards.find((survey) => survey.id === surveyId)?.name ?? surveyId}: ${cellCount}/${selection.pixels.length}`).join(" · ");
  const artifactSummary = selection.artifacts.map((artifact) => {
    const survey = surveyRecordsById.get(artifact.surveyId);
    const release = survey?.releases.find((entry) => entry.id === artifact.releaseId);
    return `${survey?.name ?? artifact.surveyId} ${release?.label ?? artifact.releaseId}: ${artifact.product} (${release?.modalities.join(", ") ?? "metadata pending"})`;
  }).join(" | ");
  inspectorRows(`已选择 ${selection.pixels.length} 个相邻区块`, [
    ["NSIDE", String(selection.nside)],
    ["Cells", `${selection.pixels.length} / ${selection.pixels.join(", ")}`],
    ["Surveys", names],
    ["Coverage by survey", coverageSummary || "当前可见巡天未覆盖所选区域"],
    ["Matching releases", selection.releaseIds.join(" / ")],
    ["Products / modalities", artifactSummary],
    ["状态", selection.notice ?? "选区已在所有相关巡天展示层中分别点亮"],
    ["调整", "点击相邻区块添加；点击已选区块移除；选区始终保持边连接"],
    ["Use", "Region selection is angular coverage only; display offsets are not observational depth"],
  ], [actionButton("清除所选区域", () => layerViewer?.clearRegionSelection())]);
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
  const nextStep = document.createElement("div");
  nextStep.className = "coverage-next-step";
  const nextCopy = document.createElement("p");
  nextCopy.textContent = "已确认该天区存在数据。下一步将把天区和数据源提交给 data-warehouse，创建下载或扫描任务。";
  const prepare = document.createElement("button");
  prepare.type = "button";
  prepare.className = "command-button";
  prepare.disabled = true;
  prepare.textContent = "数据准备任务 · 待接入";
  prepare.title = "data-warehouse connector 尚未接入当前工作区";
  nextStep.append(nextCopy, prepare);
  content.replaceChildren(titleRow, coordinates, stack, nextStep);
  if (window.innerWidth <= 1040) byId("inspector-panel").classList.add("mobile-open");
}

function footprintsForSurvey(surveyId: string) {
  return surveyFootprints?.footprints.filter((footprint) => footprint.surveyId === surveyId) ?? [];
}

function renderSurveyHover(hover: SurveyLayerHover | null): void {
  const card = byId("coverage-hover");
  if (!hover) {
    if (hoverDismissTimer) clearTimeout(hoverDismissTimer);
    hoverDismissTimer = setTimeout(() => {
      card.hidden = true;
      card.replaceChildren();
    }, 110);
    return;
  }
  if (hoverDismissTimer) clearTimeout(hoverDismissTimer);
  hoverDismissTimer = null;
  const stage = byId("scene-stage");
  const bounds = stage.getBoundingClientRect();
  const title = document.createElement("strong");
  title.textContent = `ICRS coverage cell ${hover.pixel}`;
  const subtitle = document.createElement("span");
  subtitle.textContent = `RA ${hover.pointerRaDeg.toFixed(5)}° · Dec ${hover.pointerDecDeg >= 0 ? "+" : ""}${hover.pointerDecDeg.toFixed(5)}° · NSIDE ${hover.nside}`;
  const center = document.createElement("span");
  center.textContent = `Cell center ${hover.centerRaDeg.toFixed(5)}°, ${hover.centerDecDeg >= 0 ? "+" : ""}${hover.centerDecDeg.toFixed(5)}° · ${hover.artifacts.length} sources`;
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

function restoreLayerPreferences(): void {
  const available = new Set(footprintSurveyIds());
  try {
    const stored = JSON.parse(localStorage.getItem(LAYER_PREFERENCES_KEY) ?? "null") as {
      visibleSurveyIds?: string[];
      layoutMode?: SurveyLayerLayoutMode;
      interactionMode?: SurveyLayerInteractionMode;
    } | null;
    const restored = stored?.visibleSurveyIds?.filter((surveyId) => available.has(surveyId)) ?? [];
    if (restored.length || stored?.visibleSurveyIds?.length === 0) visibleSurveyIds = new Set(restored);
    else if (available.has("legacy-surveys")) visibleSurveyIds = new Set(["legacy-surveys"]);
    else visibleSurveyIds = new Set([...available].slice(0, 1));
    layerLayoutMode = stored?.layoutMode === "overlap" ? "overlap" : "layers";
    layerInteractionMode = stored?.interactionMode === "region" ? "region" : "inspect";
  } catch {
    visibleSurveyIds = available.has("legacy-surveys") ? new Set(["legacy-surveys"]) : new Set([...available].slice(0, 1));
    layerLayoutMode = "layers";
    layerInteractionMode = "inspect";
  }
}

function persistLayerPreferences(): void {
  localStorage.setItem(LAYER_PREFERENCES_KEY, JSON.stringify({
    visibleSurveyIds: [...visibleSurveyIds],
    layoutMode: layerLayoutMode,
    interactionMode: layerInteractionMode,
  }));
}

function applyLayerPreferences(): void {
  layerViewer?.setLayoutMode(layerLayoutMode);
  layerViewer?.setVisibleSurveys(visibleSurveyIds);
  layerViewer?.setInteractionMode(layerInteractionMode);
  const regionMode = layerInteractionMode === "region";
  byId("layer-interaction-note").textContent = regionMode
    ? selectedLayerRegion?.pixels.length
      ? `当前已组合 ${selectedLayerRegion.pixels.length} 个相邻区块。点击边相邻区块继续添加，点击已选区块移除。`
      : "点击一个 HEALPix 区块开始；之后点击边相邻区块自动扩展选区。"
    : "点击区块查看同一天区内所有可见巡天的 DR、产品和模态；右键可固定天区。";
  buildSurveyList();
  persistLayerPreferences();
}

function setSurveyVisibility(surveyId: string, visible: boolean): void {
  if (visible) visibleSurveyIds.add(surveyId);
  else visibleSurveyIds.delete(surveyId);
  if (selectedSurvey?.id === surveyId && !visible) selectedSurvey = null;
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
    const card = document.createElement("article");
    card.className = "survey-card";
    card.classList.toggle("visible", visibleSurveyIds.has(survey.id));
    card.classList.toggle("pending", !hasFootprint);
    const visibility = document.createElement("label");
    visibility.className = "survey-visibility";
    visibility.title = hasFootprint ? `Show ${survey.name}` : `${survey.name} footprint is pending`;
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = visibleSurveyIds.has(survey.id);
    checkbox.disabled = !hasFootprint;
    checkbox.setAttribute("aria-label", `Show ${survey.name}`);
    checkbox.addEventListener("change", () => setSurveyVisibility(survey.id, checkbox.checked));
    const swatch = document.createElement("i");
    swatch.style.background = survey.color;
    visibility.append(checkbox, swatch);
    const body = document.createElement("div");
    body.className = "survey-card-body";
    body.tabIndex = hasFootprint ? 0 : -1;
    body.addEventListener("click", () => hasFootprint && setSurveyVisibility(survey.id, !visibleSurveyIds.has(survey.id)));
    body.addEventListener("keydown", (event) => {
      if (hasFootprint && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        setSurveyVisibility(survey.id, !visibleSurveyIds.has(survey.id));
      }
    });
    const name = document.createElement("span");
    name.textContent = survey.name;
    const count = document.createElement("b");
    count.textContent = hasFootprint ? `${footprints.length}/${survey.releaseCount} MOC` : "PENDING";
    const metadata = document.createElement("small");
    metadata.textContent = `${survey.mission} · ${footprintLabel(survey.coverageStatus)}`;
    body.append(name, count, metadata);
    card.append(visibility, body);
    return card;
  }));
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
  byId("layer-controls").hidden = mode !== "layers";
  byId("volume-controls").hidden = mode !== "volume";
  byId("workflow-controls").hidden = mode !== "workflow";
  byId("catalog-stage").hidden = mode !== "catalog";
  byId("scene-stage").hidden = mode === "workflow" || mode === "catalog";
  byId("workflow-stage").hidden = mode !== "workflow";
  byId("inspector-view").hidden = mode === "workflow";
  byId("agent-panel").hidden = mode !== "workflow";
  byId("agent-toggle").hidden = mode === "volume";
  const inspectorLabel = mode === "workflow" ? "显示 Agent" : mode === "catalog" ? "显示数据详情" : "显示覆盖详情";
  byId("agent-toggle").setAttribute("aria-label", inspectorLabel);
  byId("agent-toggle").setAttribute("title", inspectorLabel);
  document.querySelectorAll<HTMLElement>(".scene-action").forEach((element) => { element.hidden = mode === "workflow" || mode === "catalog"; });
  document.querySelector<HTMLElement>(".workspace-shell")?.classList.toggle("workflow-active", mode === "workflow");
  document.querySelector<HTMLElement>(".workspace-shell")?.classList.toggle("catalog-active", mode === "catalog");
  byId("inspector-panel").classList.remove("mobile-open");
  inspectorRows("", []);
  loadingIndicator.classList.add("visible");

  if (mode === "catalog") {
    workflowPanel.deactivate();
    byId("panel-kicker").textContent = "DATA CATALOG";
    byId("panel-dataset-name").textContent = "数据资产登记";
    byId("dataset-state").textContent = "内置与用户数据目录已加载";
    byId("metric-one-label").textContent = "ASSETS";
    byId("metric-one").textContent = "--";
    byId("metric-three-label").textContent = "SURVEYS";
    byId("metric-three").textContent = String(surveyCards.length);
    byId("metric-four-label").textContent = "STORAGE";
    byId("metric-four").textContent = "METADATA";
    byId("render-status").textContent = "CATALOG REGISTRY";
    byId("object-status").textContent = "NO RAW DATA COPIED";
    loadingIndicator.classList.remove("visible");
    await dataCatalogPanel.activate(surveyCards, surveyRecordsById);
    byId("metric-one").textContent = String((dataCatalogPanel.debugState().catalogAssetCount as number | undefined) ?? 0);
    return;
  }

  dataCatalogPanel.deactivate();
  if (mode === "workflow") {
    workflowPanel.deactivate();
    byId("panel-kicker").textContent = "WORKFLOW CONTROL";
    byId("panel-dataset-name").textContent = "Euclid × DESI Pipeline";
    byId("dataset-state").textContent = "工作流服务连接中";
    byId("metric-one-label").textContent = "STEPS";
    byId("metric-one").textContent = "0/7";
    byId("metric-three-label").textContent = "RESULTS";
    byId("metric-three").textContent = "--";
    byId("metric-four-label").textContent = "ENGINE";
    byId("metric-four").textContent = "RULES";
    byId("render-status").textContent = "WORKFLOW DAG";
    byId("object-status").textContent = "0 MATCHES";
    loadingIndicator.classList.remove("visible");
    await workflowPanel.activate();
    return;
  }

  workflowPanel.deactivate();
  byId("panel-dataset-name").textContent = mode === "layers" ? "Survey registry" : atlas?.name ?? "Joint volume";
  const targetCanvas = freshCanvas();

  if (mode === "layers") {
    byId("inspector-kicker").textContent = "SURVEY REGISTRY";
    byId("panel-kicker").textContent = "SURVEY REGISTRY";
    byId("dataset-state").textContent = "Layered release/product footprints loaded";
    byId("metric-one-label").textContent = "SURVEYS";
    byId("metric-one").textContent = String(surveyCards.length);
    byId("metric-three-label").textContent = "RELEASES";
    byId("metric-three").textContent = formatInteger(surveyCards.reduce((sum, survey) => sum + survey.releaseCount, 0));
    byId("metric-four-label").textContent = "FOOTPRINTS";
    byId("metric-four").textContent = `${surveyFootprints?.footprints.length ?? 0} ARTIFACTS`;
    byId("scene-mode-label").textContent = "COVERAGE";
    byId("scene-mode-value").textContent = "DISPLAY OFFSETS";
    byId("scene-badge").textContent = "DISPLAY LAYERS · NOT DISTANCE";
    byId("legend-min").textContent = "INNER SLOT";
    byId("legend-max").textContent = "OUTER SLOT";
    byId("object-status").textContent = `${surveyFootprints?.footprints.length ?? 0} RELEASE MOCS`;
    layerViewer = new SurveyLayerViewer(targetCanvas, surveyFootprints!, surveyCards, renderSurveySelection, renderSurveyHover, renderSurveyInspection, renderSurveyContextMenu, renderLayerState);
    layerViewer.setLayoutMode(layerLayoutMode);
    layerViewer.setVisibleSurveys(visibleSurveyIds);
    layerViewer.setInteractionMode(layerInteractionMode);
    applyLayerPreferences();
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
    layerInteractionMode = button.dataset.layerInteraction as SurveyLayerInteractionMode;
    applyLayerPreferences();
  });
});
byId<HTMLButtonElement>("layer-select-all").addEventListener("click", () => {
  visibleSurveyIds = new Set(footprintSurveyIds());
  applyLayerPreferences();
});
byId<HTMLButtonElement>("layer-clear-all").addEventListener("click", () => {
  visibleSurveyIds.clear();
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
  const [surveys, footprints, atlases, volumes] = await Promise.all([workspaceApi.surveys(), workspaceApi.surveyFootprints(), workspaceApi.atlases(), workspaceApi.volumes()]);
  surveyCards = surveys;
  surveyFootprints = footprints;
  const surveyRecords = await Promise.all(surveys.map((survey) => workspaceApi.survey(survey.id)));
  surveyRecordsById.clear();
  surveyRecords.forEach((survey) => surveyRecordsById.set(survey.id, survey));
  restoreLayerPreferences();
  atlas = atlases[0] ?? null;
  volumeManifest = volumes.find((candidate) => candidate.id === atlas?.jointIndex.radialCoordinate.sourceVolumeId) ?? volumes[0] ?? null;
  if (!atlas) throw new Error("Local sky reference index is not configured");
  angularCells = await workspaceApi.atlasAngularCells(atlas);
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
