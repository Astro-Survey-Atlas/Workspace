import { createIcons, Download, Globe2, Layers3, MessageSquare, Play, Plus, RefreshCw, RotateCcw, Send, SlidersHorizontal } from "lucide";
import "./styles.css";
import { workspaceApi, } from "./api";
import { SurveyLayerViewer, } from "./survey-layer-viewer";
import { VolumeViewer, } from "./volume-viewer";
import { WorkflowPanel } from "./workflow-panel";
import { DataCatalogPanel } from "./data-catalog-panel";
import { ConnectorPanel } from "./connector-panel";
import { RegionRefinementViewer } from "./region-refinement-viewer";
function byId(id) {
    const element = document.getElementById(id);
    if (!element)
        throw new Error(`Missing required element: ${id}`);
    return element;
}
function formatInteger(value) {
    return new Intl.NumberFormat("en-US").format(value);
}
function formatMpc(value, digits = 0) {
    return `${value.toFixed(digits)} Mpc`;
}
const PROJECT_STATE_LABELS = {
    public_reference: "公开参考",
    acquired: "已掌握",
    processed: "已加工",
    deliverable: "可交付",
    planned: "计划中",
};
function projectAssetCounts() {
    const counts = {
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
function renderProjectMetrics() {
    const counts = projectAssetCounts();
    const metrics = [
        ["metric-one-label", "metric-one", "public_reference"],
        ["metric-two-label", "metric-two", "acquired"],
        ["metric-three-label", "metric-three", "processed"],
        ["metric-four-label", "metric-four", "deliverable"],
        ["metric-five-label", "metric-five", "planned"],
    ];
    metrics.forEach(([labelId, valueId, state]) => {
        byId(labelId).textContent = PROJECT_STATE_LABELS[state].toUpperCase();
        byId(valueId).textContent = formatInteger(counts[state]);
    });
}
function assetsForSelection(selection) {
    const surveyIds = new Set(selection.surveyIds);
    const releaseIds = new Set(selection.releaseIds);
    return dataAssets.filter((asset) => asset.surveyId && surveyIds.has(asset.surveyId) && (!asset.releaseId || releaseIds.has(asset.releaseId)));
}
function projectStateSummary(assets) {
    const counts = {
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
    return Object.keys(PROJECT_STATE_LABELS)
        .filter((state) => counts[state] > 0)
        .map((state) => `${PROJECT_STATE_LABELS[state]} ${counts[state]}`)
        .join(" · ") || "暂无关联项目资产";
}
function inspectorRows(title, rows, actions = []) {
    const empty = byId("inspector-empty");
    const content = byId("inspector-content");
    empty.hidden = false;
    content.hidden = true;
    content.replaceChildren();
    if (!title)
        return;
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
function actionButton(label, action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "command-button";
    button.textContent = label;
    button.addEventListener("click", action);
    return button;
}
function downloadJson(name, value) {
    const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = name;
    link.click();
    URL.revokeObjectURL(link.href);
}
let canvas = byId("volume-canvas");
const loadingIndicator = byId("loading-indicator");
const controlsPanel = byId("controls-panel");
const radialMinInput = byId("radial-min-input");
const radialMaxInput = byId("radial-max-input");
let atlas = null;
let angularCells = null;
let surveyCards = [];
let surveyFootprints = null;
let selectedSurvey = null;
const surveyRecordsById = new Map();
let selectedLayerRegion = null;
let refinementSourceRegion = null;
let refinementState = null;
let dataAssets = [];
let refinementSurveyIds = new Set();
let refinementModalities = new Set();
let visibleSurveyIds = new Set();
let layerLayoutMode = "layers";
let layerInteractionMode = "inspect";
let hoverDismissTimer = null;
let volumeManifest = null;
let volumePoints = null;
let layerViewer = null;
let refinementViewer = null;
let volumeViewer = null;
let mode = "layers";
let representation = "cells";
let jointNside = 32;
let radialBins = 8;
let radialMinMpc = 0;
let radialMaxMpc = 6000;
let parentFilter = null;
let selectedJointCell = null;
let selectedRefinement = null;
let radialTimer = null;
let activationGeneration = 0;
const workflowPanel = new WorkflowPanel((error) => console.error("Workflow UI request failed", error));
let connectorSelectionRequest = null;
const dataCatalogPanel = new DataCatalogPanel((error) => showFatal(error), (connectorId) => {
    connectorSelectionRequest = connectorId;
    void activateMode("connectors").catch(showFatal);
});
const connectorPanel = new ConnectorPanel((error) => showFatal(error));
const LAYER_PREFERENCES_KEY = "astro-workspace:survey-layer-preferences:v1";
createIcons({ icons: { Download, Globe2, Layers3, MessageSquare, Play, Plus, RefreshCw, RotateCcw, Send, SlidersHorizontal } });
function showFatal(error) {
    console.error(error);
    byId("dataset-state").textContent = "载入失败";
    byId("service-status").textContent = "SERVICE ERROR";
    loadingIndicator.textContent = error instanceof Error ? error.message : String(error);
    loadingIndicator.classList.add("visible", "error");
}
function freshCanvas() {
    const replacement = document.createElement("canvas");
    replacement.id = canvas.id;
    replacement.className = canvas.className;
    canvas.replaceWith(replacement);
    canvas = replacement;
    return replacement;
}
function destroyViewer() {
    layerViewer?.dispose();
    refinementViewer?.dispose();
    volumeViewer?.dispose();
    layerViewer = null;
    refinementViewer = null;
    volumeViewer = null;
    renderSurveyHover(null);
}
function setActiveButtons(selector, predicate) {
    document.querySelectorAll(selector).forEach((button) => button.classList.toggle("active", predicate(button)));
}
function renderLayerState(state) {
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
    const pinStatus = document.getElementById("coverage-pin-status");
    if (pinStatus) {
        const locked = state.lockedCoveragePixel === state.pinnedCoveragePixel && state.lockedCoveragePixel != null;
        pinStatus.classList.toggle("active", locked);
        pinStatus.setAttribute("aria-pressed", String(locked));
        pinStatus.textContent = locked ? "已固定" : "未固定";
    }
    setActiveButtons("[data-layer-layout]", (button) => button.dataset.layerLayout === state.layoutMode);
    setActiveButtons("[data-layer-interaction]", (button) => button.dataset.layerInteraction === state.interactionMode);
    document.querySelectorAll("[data-layer-interaction]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.layerInteraction === state.interactionMode)));
    const lockButton = byId("coverage-lock-button");
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
function renderRegionSceneLegend(state) {
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
function renderVolumeState(state) {
    canvas.dataset.cameraDistance = state.cameraDistance.toFixed(6);
    canvas.dataset.outerRadius = state.outerRadius.toFixed(6);
    canvas.dataset.mode = "volume";
    canvas.dataset.representation = state.representation;
    byId("camera-distance").textContent = `${state.cameraDistance.toFixed(2)} R`;
    byId("representation-output").textContent = state.representation === "cells" ? "SPARSE CELLS" : "GALAXY POINTS";
    setActiveButtons("[data-representation]", (button) => button.dataset.representation === state.representation);
}
function renderSurveySelection(selection) {
    selectedLayerRegion = selection;
    if (selection)
        refinementSourceRegion = { ...selection, pixels: [...selection.pixels] };
    byId("inspector-kicker").textContent = "REGION SELECTION";
    if (!selection) {
        byId("region-scene-legend").hidden = true;
        if (selectedSurvey)
            renderSurveyDetails(selectedSurvey);
        else
            inspectorRows("", []);
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
    if (layerViewer)
        renderRegionSceneLegend(layerViewer.state);
}
function renderSurveyInspection(inspection) {
    if (!inspection) {
        if (selectedSurvey)
            renderSurveyDetails(selectedSurvey);
        else
            inspectorRows("", []);
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
    const cellAssets = dataAssets.filter((asset) => asset.surveyId && inspection.surveyIds.includes(asset.surveyId));
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
    content.replaceChildren(titleRow, coordinates, stack, projectState, nextStep);
    if (window.innerWidth <= 1040)
        byId("inspector-panel").classList.add("mobile-open");
}
function footprintsForSurvey(surveyId) {
    return surveyFootprints?.footprints.filter((footprint) => footprint.surveyId === surveyId) ?? [];
}
function renderSurveyHover(hover) {
    const card = byId("coverage-hover");
    if (!hover) {
        delete canvas.dataset.hoveredPixel;
        delete canvas.dataset.hoveredCovered;
        delete canvas.dataset.hoveredSelectable;
        if (hoverDismissTimer)
            clearTimeout(hoverDismissTimer);
        hoverDismissTimer = setTimeout(() => {
            card.hidden = true;
            card.replaceChildren();
        }, 110);
        return;
    }
    if (hoverDismissTimer)
        clearTimeout(hoverDismissTimer);
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
function renderSurveyContextMenu(menu) {
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
    if (hoverDismissTimer)
        clearTimeout(hoverDismissTimer);
    hoverDismissTimer = null;
});
coverageHover.addEventListener("pointerleave", () => {
    coverageHover.hidden = true;
    coverageHover.replaceChildren();
});
document.addEventListener("pointerdown", (event) => {
    const menu = byId("coverage-context-menu");
    if (!menu.contains(event.target))
        renderSurveyContextMenu(null);
});
function footprintLabel(status) {
    if (status === "verified")
        return "FOOTPRINT READY";
    if (status === "summary_only")
        return "SUMMARY ONLY";
    return "FOOTPRINT PENDING";
}
function footprintSurveyIds() {
    const available = new Set(surveyFootprints?.footprints.map((footprint) => footprint.surveyId) ?? []);
    return surveyCards.filter((survey) => available.has(survey.id)).map((survey) => survey.id);
}
function activeRefinementBaseCoverage() {
    const selection = refinementSourceRegion ?? selectedLayerRegion;
    if (!selection)
        return new Set();
    const basePixels = new Set(selection.pixels);
    const covered = new Set();
    surveyFootprints?.footprints.forEach((footprint) => {
        if (!refinementSurveyIds.has(footprint.surveyId))
            return;
        footprint.pixels.forEach((pixel) => {
            if (basePixels.has(pixel))
                covered.add(pixel);
        });
    });
    return covered;
}
function availableRefinementSurveyIds() {
    const source = refinementSourceRegion ?? selectedLayerRegion;
    if (!source)
        return [];
    const selected = new Set(source.pixels);
    const available = new Set((surveyFootprints?.footprints ?? [])
        .filter((footprint) => footprint.pixels.some((pixel) => selected.has(pixel)))
        .map((footprint) => footprint.surveyId));
    return surveyCards.filter((survey) => available.has(survey.id)).map((survey) => survey.id);
}
function refinementReleaseIds() {
    const selection = refinementSourceRegion ?? selectedLayerRegion;
    if (!selection || !refinementState)
        return [];
    const selectedBasePixels = new Set(refinementState.selectedPixels.map((pixel) => {
        const ratio = refinementState.nside / selection.nside;
        return Math.floor(pixel / (ratio * ratio));
    }));
    return [...new Set((surveyFootprints?.footprints ?? [])
            .filter((footprint) => refinementSurveyIds.has(footprint.surveyId) && footprint.pixels.some((pixel) => selectedBasePixels.has(pixel)))
            .map((footprint) => footprint.releaseId))].sort();
}
function matchingRefinementAssets() {
    if (!refinementState?.selectedPixels.length || !refinementSurveyIds.size || !refinementModalities.size)
        return [];
    const releases = new Set(refinementReleaseIds());
    return dataAssets.filter((asset) => {
        if (!asset.surveyId || !refinementSurveyIds.has(asset.surveyId))
            return false;
        if (asset.releaseId && !releases.has(asset.releaseId))
            return false;
        if (refinementModalities.size && !asset.modalities.some((modality) => refinementModalities.has(modality)))
            return false;
        return true;
    });
}
function renderRefinementFilters() {
    const selection = refinementSourceRegion ?? selectedLayerRegion;
    if (!selection)
        return;
    const surveyList = byId("refinement-survey-list");
    const availableSurveys = availableRefinementSurveyIds();
    surveyList.replaceChildren(...availableSurveys.map((surveyId) => {
        const label = document.createElement("label");
        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = refinementSurveyIds.has(surveyId);
        input.addEventListener("change", () => {
            if (input.checked)
                refinementSurveyIds.add(surveyId);
            else
                refinementSurveyIds.delete(surveyId);
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
            if (input.checked)
                refinementModalities.add(modality);
            else
                refinementModalities.delete(modality);
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
function renderRefinementInspector() {
    const selection = refinementSourceRegion ?? selectedLayerRegion;
    const state = refinementState;
    if (!selection || !state)
        return;
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
        assets: assets.map((asset) => ({ id: asset.id, surveyId: asset.surveyId, releaseId: asset.releaseId, product: asset.product, connector: asset.access.connector, uri: asset.access.uri })),
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
    byId("refinement-next").disabled = !state.canRefine;
    byId("refinement-back").disabled = !state.canGoBack;
}
function renderRefinementState(state) {
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
async function openRegionRefinement(selection) {
    selectedLayerRegion = selection;
    refinementSourceRegion = { ...selection, pixels: [...selection.pixels] };
    const availableSurveys = availableRefinementSurveyIds();
    refinementSurveyIds = new Set(availableSurveys);
    refinementModalities = new Set(availableSurveys.flatMap((surveyId) => surveyRecordsById.get(surveyId)?.modalities ?? []));
    await activateMode("refine");
}
function restoreLayerPreferences() {
    const available = new Set(footprintSurveyIds());
    try {
        const stored = JSON.parse(localStorage.getItem(LAYER_PREFERENCES_KEY) ?? "null");
        const restored = stored?.visibleSurveyIds?.filter((surveyId) => available.has(surveyId)) ?? [];
        if (restored.length || stored?.visibleSurveyIds?.length === 0)
            visibleSurveyIds = new Set(restored);
        else if (available.has("legacy-surveys"))
            visibleSurveyIds = new Set(["legacy-surveys"]);
        else
            visibleSurveyIds = new Set([...available].slice(0, 1));
        layerLayoutMode = stored?.layoutMode === "overlap" ? "overlap" : "layers";
        layerInteractionMode = stored?.interactionMode === "region" ? "region" : "inspect";
    }
    catch {
        visibleSurveyIds = available.has("legacy-surveys") ? new Set(["legacy-surveys"]) : new Set([...available].slice(0, 1));
        layerLayoutMode = "layers";
        layerInteractionMode = "inspect";
    }
}
function persistLayerPreferences() {
    localStorage.setItem(LAYER_PREFERENCES_KEY, JSON.stringify({
        visibleSurveyIds: [...visibleSurveyIds],
        layoutMode: layerLayoutMode,
        interactionMode: layerInteractionMode,
    }));
}
function applyLayerPreferences() {
    layerViewer?.setLayoutMode(layerLayoutMode);
    layerViewer?.setVisibleSurveys(visibleSurveyIds);
    layerViewer?.setInteractionMode(layerInteractionMode);
    buildSurveyList();
    persistLayerPreferences();
}
function chooseLayerInteraction(nextMode) {
    if (nextMode === "inspect") {
        refinementSourceRegion = null;
    }
    layerInteractionMode = nextMode;
    applyLayerPreferences();
}
function setSurveyVisibility(surveyId, visible) {
    if (visible)
        visibleSurveyIds.add(surveyId);
    else
        visibleSurveyIds.delete(surveyId);
    if (selectedSurvey?.id === surveyId && !visible)
        selectedSurvey = null;
    applyLayerPreferences();
}
function soloSurvey(surveyId) {
    visibleSurveyIds = new Set([surveyId]);
    applyLayerPreferences();
    layerViewer?.focusSurvey(surveyId);
}
function renderSurveyDetails(survey) {
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
    const detailRows = [
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
function renderObjectSelection(selection) {
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
function renderJointSelection(selection) {
    byId("inspector-kicker").textContent = "JOINT CELL";
    selectedJointCell = selection;
    selectedRefinement = null;
    if (!selection || !atlas) {
        inspectorRows("", []);
        return;
    }
    const key = `${selection.nside}:${selection.radialBins}:${selection.pixel}:${selection.radialBin}`;
    const rows = [
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
        if (!selectedJointCell || `${selectedJointCell.nside}:${selectedJointCell.radialBins}:${selectedJointCell.pixel}:${selectedJointCell.radialBin}` !== key)
            return;
        selectedRefinement = refinement;
        const actions = [];
        if (refinement.angular.available)
            actions.push(actionButton(`方向 → ${refinement.angular.nextLevel}`, () => void drill("angular")));
        if (refinement.radial.available)
            actions.push(actionButton(`径向 → ${refinement.radial.nextLevel}`, () => void drill("radial")));
        if (refinement.recommendedAxis !== "none")
            actions.unshift(actionButton(`自动 · ${refinement.recommendedAxis.toUpperCase()}`, () => void drill(refinement.recommendedAxis)));
        inspectorRows(`CELL ${selection.pixel}:${selection.radialBin}`, [
            ...rows.slice(0, -1),
            ["Angular gain", refinement.angular.normalizedVariation.toFixed(4)],
            ["Radial gain", refinement.radial.normalizedVariation.toFixed(4)],
            ["Conserved", refinement.angular.conserved && refinement.radial.conserved ? "YES" : "NO"],
            ["Recommended", refinement.recommendedAxis.toUpperCase()],
        ], actions);
    }).catch(showFatal);
}
function renderVolumeSelection(selection) {
    if (!selection) {
        selectedJointCell = null;
        inspectorRows("", []);
    }
    else if (selection.kind === "object")
        renderObjectSelection(selection);
    else
        renderJointSelection(selection);
}
function buildSurveyList() {
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
async function selectSurvey(id) {
    selectedSurvey = await workspaceApi.survey(id);
    surveyRecordsById.set(id, selectedSurvey);
    buildSurveyList();
    renderSurveyDetails(selectedSurvey);
    if (window.innerWidth <= 1040)
        byId("inspector-panel").classList.add("mobile-open");
}
async function loadJointCells() {
    if (!atlas || !volumeViewer)
        return;
    const generation = activationGeneration;
    loadingIndicator.textContent = "查询联合体积单元";
    loadingIndicator.classList.add("visible");
    const query = {
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
    const result = await workspaceApi.jointCells(atlas.id, query);
    if (generation !== activationGeneration || !volumeViewer)
        return;
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
async function ensurePoints() {
    if (!volumeManifest || !volumeViewer)
        return;
    if (!volumePoints) {
        loadingIndicator.textContent = `载入 ${formatInteger(volumeManifest.pointCount)} 个星系`;
        loadingIndicator.classList.add("visible");
        volumePoints = await workspaceApi.volumePoints(volumeManifest);
    }
    volumeViewer.setData(volumePoints);
    volumeViewer.setAngularFilter(parentFilter);
    loadingIndicator.classList.remove("visible");
}
async function drill(axis) {
    if (!selectedJointCell || !selectedRefinement)
        return;
    parentFilter = { nside: selectedJointCell.nside, pixel: selectedJointCell.pixel };
    radialMinMpc = selectedJointCell.radialMinMpc;
    radialMaxMpc = selectedJointCell.radialMaxMpc;
    if (axis === "angular" && selectedRefinement.angular.nextLevel)
        jointNside = selectedRefinement.angular.nextLevel;
    if (axis === "radial" && selectedRefinement.radial.nextLevel)
        radialBins = selectedRefinement.radial.nextLevel;
    radialMinInput.value = String(radialMinMpc);
    radialMaxInput.value = String(radialMaxMpc);
    updateJointControls();
    await loadJointCells();
}
function updateJointControls() {
    byId("joint-nside-output").textContent = `NSIDE ${jointNside}`;
    byId("radial-bins-output").textContent = `${radialBins} BINS`;
    byId("radial-min-output").textContent = formatMpc(radialMinMpc);
    byId("radial-max-output").textContent = formatMpc(radialMaxMpc);
    setActiveButtons("[data-joint-nside]", (button) => Number(button.dataset.jointNside) === jointNside);
    setActiveButtons("[data-radial-bins]", (button) => Number(button.dataset.radialBins) === radialBins);
}
async function activateMode(nextMode) {
    if (nextMode === "layers" && !surveyFootprints)
        throw new Error("Survey footprint catalog is not configured");
    if (nextMode === "refine" && !refinementSourceRegion && !selectedLayerRegion)
        throw new Error("请先在项目态势中选择连续天区");
    if (nextMode === "volume" && (!atlas || !angularCells || !volumeManifest))
        throw new Error("Joint volume is not configured");
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
    byId("connector-controls").hidden = mode !== "connectors";
    byId("layer-controls").hidden = mode !== "layers";
    byId("refinement-controls").hidden = mode !== "refine";
    byId("volume-controls").hidden = mode !== "volume";
    byId("workflow-controls").hidden = mode !== "workflow";
    byId("catalog-stage").hidden = mode !== "catalog";
    byId("asset-detail-stage").hidden = true;
    byId("connector-stage").hidden = mode !== "connectors";
    byId("scene-stage").hidden = mode === "workflow" || mode === "catalog" || mode === "connectors";
    byId("workflow-stage").hidden = mode !== "workflow";
    byId("inspector-view").hidden = mode === "workflow";
    byId("agent-panel").hidden = mode !== "workflow";
    byId("agent-toggle").hidden = mode === "volume";
    const inspectorLabel = mode === "workflow" ? "显示 Agent" : mode === "catalog" ? "显示数据详情" : mode === "refine" ? "显示检索详情" : "显示覆盖详情";
    byId("agent-toggle").setAttribute("aria-label", inspectorLabel);
    byId("agent-toggle").setAttribute("title", inspectorLabel);
    document.querySelectorAll(".scene-action").forEach((element) => { element.hidden = mode === "workflow" || mode === "catalog" || mode === "connectors"; });
    byId("layer-tool-strip").hidden = mode !== "layers";
    byId("scene-legend").hidden = mode === "refine";
    byId("region-scene-legend").hidden = mode !== "layers";
    byId("context-summary").hidden = mode === "refine";
    document.querySelector(".workspace-shell")?.classList.toggle("workflow-active", mode === "workflow");
    document.querySelector(".workspace-shell")?.classList.toggle("catalog-active", mode === "catalog");
    document.querySelector(".workspace-shell")?.classList.toggle("connector-active", mode === "connectors");
    byId("inspector-panel").classList.remove("mobile-open");
    inspectorRows("", []);
    loadingIndicator.classList.add("visible");
    if (mode === "catalog") {
        workflowPanel.deactivate();
        byId("panel-kicker").textContent = "DATA CATALOG";
        byId("panel-dataset-name").textContent = "数据资产登记";
        byId("dataset-state").textContent = "内置与用户数据目录已加载";
        renderProjectMetrics();
        byId("render-status").textContent = "CATALOG REGISTRY";
        byId("object-status").textContent = "NO RAW DATA COPIED";
        loadingIndicator.classList.remove("visible");
        await dataCatalogPanel.activate(surveyCards, surveyRecordsById);
        byId("metric-one").textContent = String(dataCatalogPanel.debugState().catalogAssetCount ?? 0);
        return;
    }
    dataCatalogPanel.deactivate();
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
        layerViewer = new SurveyLayerViewer(targetCanvas, surveyFootprints, surveyCards, renderSurveySelection, renderSurveyHover, renderSurveyInspection, renderSurveyContextMenu, renderLayerState);
        layerViewer.setLayoutMode(layerLayoutMode);
        layerViewer.setVisibleSurveys(visibleSurveyIds);
        layerViewer.setInteractionMode(layerInteractionMode);
        applyLayerPreferences();
        if (returningLayerRegion) {
            layerInteractionMode = "region";
            layerViewer.setInteractionMode("region");
            layerViewer.setRegionSelection(returningLayerRegion.pixels);
        }
        byId("render-status").textContent = layerViewer.webglVersion;
        loadingIndicator.classList.remove("visible");
    }
    else if (mode === "refine") {
        byId("inspector-kicker").textContent = "DATA RETRIEVAL SCOPE";
        byId("scene-mode-label").textContent = "REFINE";
        byId("scene-mode-value").textContent = "NESTED HEALPIX";
        byId("scene-badge").textContent = "选区已实体化";
        byId("legend-min").textContent = "排除";
        byId("legend-max").textContent = "保留 / 有覆盖";
        byId("object-status").textContent = "EXACT ANGULAR MASK";
        renderRefinementFilters();
        refinementViewer = new RegionRefinementViewer(targetCanvas, sourceRegion.nside, sourceRegion.pixels, activeRefinementBaseCoverage(), renderRefinementState);
        byId("render-status").textContent = refinementViewer.webglVersion;
        loadingIndicator.classList.remove("visible");
    }
    else {
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
        volumeViewer = new VolumeViewer(targetCanvas, volumeManifest, renderVolumeSelection, renderVolumeState);
        volumeViewer.setRepresentation(representation);
        byId("render-status").textContent = volumeViewer.webglVersion;
        updateJointControls();
        await loadJointCells();
        if (generation !== activationGeneration || !volumeViewer)
            return;
        if (representation === "points")
            await ensurePoints();
    }
}
document.querySelectorAll("[data-mode]").forEach((button) => {
    button.addEventListener("click", () => void activateMode(button.dataset.mode).catch(showFatal));
});
document.querySelectorAll("[data-layer-layout]").forEach((button) => {
    button.addEventListener("click", () => {
        layerLayoutMode = button.dataset.layerLayout;
        applyLayerPreferences();
    });
});
document.querySelectorAll("[data-layer-interaction]").forEach((button) => {
    button.addEventListener("click", () => {
        chooseLayerInteraction(button.dataset.layerInteraction);
    });
});
byId("coverage-lock-button").addEventListener("click", () => layerViewer?.togglePinnedInspectionLock());
byId("refinement-next").addEventListener("click", () => refinementViewer?.refine());
byId("refinement-back").addEventListener("click", () => refinementViewer?.goBack());
byId("layer-select-all").addEventListener("click", () => {
    visibleSurveyIds = new Set(footprintSurveyIds());
    applyLayerPreferences();
});
byId("layer-clear-all").addEventListener("click", () => {
    visibleSurveyIds.clear();
    applyLayerPreferences();
});
document.querySelectorAll("[data-joint-nside]").forEach((button) => {
    button.addEventListener("click", () => {
        jointNside = Number(button.dataset.jointNside);
        parentFilter = null;
        updateJointControls();
        void loadJointCells().catch(showFatal);
    });
});
document.querySelectorAll("[data-radial-bins]").forEach((button) => {
    button.addEventListener("click", () => {
        radialBins = Number(button.dataset.radialBins);
        parentFilter = null;
        updateJointControls();
        void loadJointCells().catch(showFatal);
    });
});
document.querySelectorAll("[data-representation]").forEach((button) => {
    button.addEventListener("click", () => {
        representation = button.dataset.representation;
        volumeViewer?.setRepresentation(representation);
        if (representation === "points")
            void ensurePoints().catch(showFatal);
    });
});
function scheduleRadialQuery(changed) {
    let minimum = Number(radialMinInput.value);
    let maximum = Number(radialMaxInput.value);
    if (maximum - minimum < 50) {
        if (changed === "min")
            minimum = maximum - 50;
        else
            maximum = minimum + 50;
    }
    radialMinMpc = Math.max(0, minimum);
    radialMaxMpc = Math.min(6000, maximum);
    parentFilter = null;
    volumeViewer?.setRadialRange(radialMinMpc, radialMaxMpc);
    updateJointControls();
    if (radialTimer)
        clearTimeout(radialTimer);
    radialTimer = setTimeout(() => void loadJointCells().catch(showFatal), 120);
}
radialMinInput.addEventListener("input", () => scheduleRadialQuery("min"));
radialMaxInput.addEventListener("input", () => scheduleRadialQuery("max"));
byId("reset-button").addEventListener("click", () => {
    if (mode === "layers")
        layerViewer?.reset();
    else if (mode === "refine")
        refinementViewer?.reset();
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
    if (mode !== "layers" || event.metaKey || event.ctrlKey || event.altKey)
        return;
    const target = event.target;
    if (target?.matches("input, textarea, select, [contenteditable='true']"))
        return;
    const key = event.key.toLocaleLowerCase();
    if (key === "f" || key === "g") {
        chooseLayerInteraction(key === "f" ? "inspect" : "region");
    }
    else if (key === "c") {
        layerViewer?.togglePinnedInspectionLock();
    }
    else
        return;
    event.preventDefault();
});
byId("controls-toggle").addEventListener("click", () => controlsPanel.classList.toggle("mobile-open"));
byId("agent-toggle").addEventListener("click", () => byId("inspector-panel").classList.toggle("mobile-open"));
window.addEventListener("astro:navigate", (event) => {
    const nextMode = event.detail?.mode;
    if (nextMode === "layers" || nextMode === "volume")
        void activateMode(nextMode).catch(showFatal);
});
async function start() {
    const [surveys, footprints, atlases, volumes, assets] = await Promise.all([workspaceApi.surveys(), workspaceApi.surveyFootprints(), workspaceApi.atlases(), workspaceApi.volumes(), workspaceApi.dataAssets()]);
    surveyCards = surveys;
    surveyFootprints = footprints;
    dataAssets = assets;
    const surveyRecords = await Promise.all(surveys.map((survey) => workspaceApi.survey(survey.id)));
    surveyRecordsById.clear();
    surveyRecords.forEach((survey) => surveyRecordsById.set(survey.id, survey));
    restoreLayerPreferences();
    atlas = atlases[0] ?? null;
    volumeManifest = volumes.find((candidate) => candidate.id === atlas?.jointIndex.radialCoordinate.sourceVolumeId) ?? volumes[0] ?? null;
    if (!atlas)
        throw new Error("Local sky reference index is not configured");
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
