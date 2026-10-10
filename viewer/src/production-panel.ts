import {
  ArrowRight, BrainCircuit, Circle, createIcons, Crop, Database, Download,
  FileOutput, GitCompareArrows, Info, MapPinned, PackageCheck, PlugZap,
  RefreshCw, Search, WandSparkles, X,
} from "lucide";

import { workspaceApi, type CoverageDownloadFile, type DataAssetRecord } from "./api";
import type {
  ProductionPipelineDefinition, ProductionPipelineParameter, ProductionRun,
  ProductionRunInput, RegionSnapshot,
} from "../../src/production";
import type { RegionDownloadConfirmation, RegionDownloadPreview, RegionDownloadPreviewEvent, RegionDownloadSelection } from "../../src/region-download-plan";
import type { ConnectorPublicRecord } from "../../src/connectors";
import { parsePublicSourceId } from "../../src/public-source-identity";
import { assetsLayerIdForIdentity } from "../../src/assets-region-client";
import { notifyWorkspace } from "./notifications";

export interface ProductionContext {
  nside: number;
  pixels: number[];
  sourceIds?: string[];
  componentId?: string;
  assetIds?: string[];
  files?: CoverageDownloadFile[];
  downloadSelection?: RegionDownloadSelection;
  downloadScopeNote?: string;
}

export interface ProductionSummary {
  templates: number;
  runs: number;
  activeRuns: number;
  succeededRuns: number;
  artifacts: number;
  executors: string;
}

export interface ProductionInspectorView {
  kicker: string;
  title: string;
  summary?: string;
  rows?: Array<[string, string]>;
  body?: HTMLElement;
  actions?: HTMLElement[];
}

const STATUS_LABELS: Record<string, string> = {
  idle: "模板",
  pending: "等待执行", queued: "排队中", running: "执行中", succeeded: "已完成",
  partial: "部分成功", failed: "失败", cancelled: "已取消", skipped: "已跳过",
  resolving: "解析来源", "awaiting-approval": "待审批", rejected: "已拒绝",
};

const PIPELINE_ICONS: Record<string, string> = {
  "overlap-download@1": "download",
  "object-crossmatch@1": "git-compare-arrows",
  "training-data-preparation@1": "brain-circuit",
};

const downloadPreviewScrollTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

const NODE_ICONS: Record<string, string> = {
  region: "map-pinned", resolve: "search", approval: "package-check",
  download: "download", connector: "plug-zap", warehouse: "plug-zap",
  query: "database", match: "git-compare-arrows", export: "file-output",
  input: "database", cutout: "crop", denoise: "wand-sparkles", package: "package-check",
};

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing production element: ${id}`);
  return element as T;
}

function renderIcons(): void {
  createIcons({
    icons: {
      ArrowRight, BrainCircuit, Circle, Crop, Database, Download, FileOutput,
      GitCompareArrows, Info, MapPinned, PackageCheck, PlugZap, RefreshCw, Search,
      WandSparkles, X,
    },
    attrs: { "aria-hidden": "true" },
  });
}

function shortId(value: string): string {
  return value.length > 22 ? `${value.slice(0, 13)}…${value.slice(-6)}` : value;
}

function appendTerminalStateBackground(element: HTMLElement, status: string): void {
  if (status !== "succeeded" && status !== "partial" && status !== "failed") return;
  const background = document.createElement("span");
  background.className = "item-progress";
  background.dataset.mode = status === "succeeded" ? "complete" : status === "partial" ? "waiting" : "failed";
  background.setAttribute("aria-hidden", "true");
  element.append(background);
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"];
  let amount = value;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) { amount /= 1024; index += 1; }
  return `${amount >= 10 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}

function knownByteSize(value: number | undefined): number | undefined {
  return Number.isSafeInteger(value) && (value ?? -1) >= 0 ? value : undefined;
}

function parameterValue(parameter: ProductionPipelineParameter): string | number {
  return parameter.defaultValue ?? (parameter.type === "number" ? 0 : parameter.options?.[0] ?? "");
}

export class ProductionPanel {
  private pipelines: ProductionPipelineDefinition[] = [];
  private runs: ProductionRun[] = [];
  private assets: DataAssetRecord[] = [];
  private connectors: ConnectorPublicRecord[] = [];
  private initialized = false;
  private active = false;
  private context: ProductionContext | null = null;
  private selectedRunId: string | null = null;
  private selectedPipelineKey: string | null = null;
  private selectedNodeId: string | null = null;
  private downloadPreview: RegionDownloadPreview | null = null;
  private selectedDownloadUrls = new Set<string>();
  private downloadSelectionNotice: string | null = null;
  private selectedNativeUnitKeys = new Set<string>();
  private nativeSelectionOpen = false;
  private visibleDownloadFileCounts = new Map<string, number>();
  private previewError: string | null = null;
  private previewLoading = false;
  private submitLoading = false;
  private previewExpired = false;
  private previewExpiryTimer: ReturnType<typeof setTimeout> | null = null;
  private previewRequestId = 0;
  private previewController: AbortController | null = null;
  private previewPanelOpen = false;
  private previewStopped = false;
  private previewProgress: Extract<RegionDownloadPreviewEvent, { event: "progress" }>["value"] | null = null;
  private readonly partialPreviewFiles = new Map<string, RegionDownloadPreview["inventory"]["files"][number]>();
  private partialPreviewUnavailable: RegionDownloadPreview["unavailable"] = [];
  private contextFingerprint = "";
  private requestedPipelineKey: string | null = null;
  private readonly drafts = new Map<string, Record<string, unknown>>();
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private showDownloadHandoffAfterActivation = false;

  constructor(
    private readonly onError: (error: unknown) => void,
    private readonly onSummary: (summary: ProductionSummary) => void,
    private readonly renderInspectorView: (view: ProductionInspectorView | null) => void,
  ) {
    const dialog = byId<HTMLDialogElement>("production-run-dialog");
    byId<HTMLButtonElement>("production-run-dialog-close").addEventListener("click", () => dialog.close());
    byId<HTMLButtonElement>("production-run-dialog-dismiss").addEventListener("click", () => dialog.close());
    byId<HTMLButtonElement>("production-return-template").addEventListener("click", () => this.returnToTemplate());
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
    const handoffDialog = byId<HTMLDialogElement>("production-handoff-dialog");
    byId<HTMLButtonElement>("production-handoff-close").addEventListener("click", () => handoffDialog.close());
    byId<HTMLButtonElement>("production-handoff-later").addEventListener("click", () => handoffDialog.close());
    byId<HTMLButtonElement>("production-handoff-preview").addEventListener("click", () => {
      handoffDialog.close();
      void this.refreshDownloadPreview();
    });
    handoffDialog.addEventListener("click", (event) => {
      if (event.target === handoffDialog) handoffDialog.close();
    });
  }

  setContext(context: ProductionContext | null, pipelineKey?: string, options?: { showDownloadGuide?: boolean }): void {
    const nextContext = context ? {
      ...context,
      pixels: [...new Set(context.pixels)].sort((left, right) => left - right),
      sourceIds: [...new Set(context.sourceIds ?? [])],
      assetIds: [...new Set(context.assetIds ?? [])],
      files: context.files ? [...context.files] : undefined,
      downloadSelection: context.downloadSelection ? {
        ...context.downloadSelection,
        layerIds: [...context.downloadSelection.layerIds],
        cells: [...context.downloadSelection.cells],
        units: context.downloadSelection.units?.map((unit) => ({ ...unit })),
      } : undefined,
    } : null;
    const nextFingerprint = JSON.stringify(nextContext);
    const changed = nextFingerprint !== this.contextFingerprint;
    if (changed) this.clearDownloadPreview();
    this.contextFingerprint = nextFingerprint;
    this.context = nextContext;
    this.showDownloadHandoffAfterActivation = Boolean(options?.showDownloadGuide && (pipelineKey ?? this.selectedPipelineKey) === "overlap-download@1");
    if (changed) {
      this.nativeSelectionOpen = false;
      this.resetNativeSelection();
    }
    if (pipelineKey) this.requestedPipelineKey = pipelineKey;
    const targetKey = pipelineKey ?? this.selectedPipelineKey;
    if (this.context?.assetIds?.length && targetKey === "object-crossmatch@1") {
      const draft = this.draftForKey(targetKey);
      draft.leftAssetId = this.context.assetIds[0] ?? draft.leftAssetId;
      draft.rightAssetId = this.context.assetIds[1] ?? draft.rightAssetId;
    }
    if (this.initialized && pipelineKey) this.selectPipeline(pipelineKey);
    else if (this.initialized) this.renderAll();
  }

  async activate(): Promise<void> {
    this.active = true;
    this.showDownloadHandoffIfRequested();
    if (!this.initialized) {
      [this.pipelines, this.runs, this.assets, this.connectors] = await Promise.all([
        workspaceApi.productionPipelines(), workspaceApi.productionRuns(), workspaceApi.dataAssets(), workspaceApi.connectors(),
      ]);
      this.initialized = true;
      const requested = this.requestedPipelineKey ? this.pipelines.find((pipeline) => pipeline.key === this.requestedPipelineKey) : undefined;
      const first = requested ?? this.pipelines.find((pipeline) => pipeline.availability === "available") ?? this.pipelines[0];
      if (first) this.selectPipeline(first.key);
      this.requestedPipelineKey = null;
    } else {
      await this.refreshRuns();
      this.syncSelectedRun();
      this.renderAll();
    }
    if (this.runs.some((run) => run.status === "queued" || run.status === "running" || run.status === "resolving" || run.status === "awaiting-approval")) this.schedulePoll(400);
  }

  private showDownloadHandoffIfRequested(): void {
    if (!this.showDownloadHandoffAfterActivation) return;
    this.showDownloadHandoffAfterActivation = false;
    const dialog = byId<HTMLDialogElement>("production-handoff-dialog");
    if (!dialog.open) dialog.showModal();
  }

  deactivate(): void {
    this.active = false;
    const handoffDialog = byId<HTMLDialogElement>("production-handoff-dialog");
    if (handoffDialog.open) handoffDialog.close();
    if (this.previewLoading) this.stopDownloadPreview();
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  debugState(): Record<string, unknown> {
    return {
      productionRunId: this.selectedRun?.id,
      productionStatus: this.selectedRun?.status,
      productionRuns: this.runs.length,
      productionPipelineKey: this.selectedPipelineKey,
      productionNodeId: this.selectedNodeId,
      productionNodeLogVisible: Boolean(this.selectedRun && this.selectedNodeId),
      downloadPreviewFiles: this.downloadPreview?.inventory.files.length ?? 0,
      downloadPreviewSelectedFiles: this.selectedDownloadUrls.size,
      downloadPreviewExpired: this.previewExpired,
      downloadPreviewLoading: this.previewLoading,
      downloadPreviewStopped: this.previewStopped,
    };
  }

  private draftForKey(pipelineKey: string): Record<string, unknown> {
    let draft = this.drafts.get(pipelineKey);
    if (!draft) {
      draft = {};
      this.drafts.set(pipelineKey, draft);
    }
    const pipeline = this.pipelines.find((candidate) => candidate.key === pipelineKey);
    pipeline?.parameters.forEach((parameter) => {
      if (!(parameter.key in draft!)) draft![parameter.key] = parameterValue(parameter);
    });
    return draft;
  }

  private selectedPipeline(): ProductionPipelineDefinition | undefined {
    return this.pipelines.find((pipeline) => pipeline.key === this.selectedPipelineKey);
  }

  private get selectedRun(): ProductionRun | null {
    return this.runs.find((run) => run.id === this.selectedRunId && run.pipelineKey === this.selectedPipelineKey) ?? null;
  }

  private runsForPipeline(pipelineKey = this.selectedPipelineKey): ProductionRun[] {
    return pipelineKey ? this.runs.filter((run) => run.pipelineKey === pipelineKey) : [];
  }

  private selectPipeline(pipelineKey: string): void {
    const pipeline = this.pipelines.find((candidate) => candidate.key === pipelineKey);
    if (!pipeline) return;
    if (this.selectedPipelineKey !== pipelineKey) this.clearDownloadPreview();
    this.selectedPipelineKey = pipeline.key;
    this.draftForKey(pipeline.key);
    if (this.context?.assetIds?.length && pipeline.key === "object-crossmatch@1") {
      const draft = this.draftForKey(pipeline.key);
      draft.leftAssetId ??= this.context.assetIds[0];
      draft.rightAssetId ??= this.context.assetIds[1];
    }
    this.selectedRunId = null;
    this.selectedNodeId = null;
    this.renderAll();
  }

  private selectRun(run: ProductionRun): void {
    this.selectedRunId = run.id;
    this.selectedNodeId = null;
    this.renderDag();
    this.renderLogs();
    this.renderInspector(false);
    this.renderStatus();
    this.revealInspector();
  }

  private selectNode(nodeId: string): void {
    this.selectedNodeId = nodeId;
    this.renderDag();
    this.renderInspector(false);
    this.revealInspector();
  }

  private returnToTemplate(): void {
    this.selectedRunId = null;
    this.selectedNodeId = null;
    this.renderAll();
    this.revealInspector();
    byId("inspector-content").querySelector<HTMLElement>("input, select, button")?.focus({ preventScroll: true });
  }

  private revealInspector(): void {
    if (window.innerWidth <= 1040) byId("inspector-panel").classList.add("mobile-open");
  }

  private syncSelectedRun(): boolean {
    if (this.selectedRunId && !this.selectedRun) {
      this.selectedRunId = null;
      this.selectedNodeId = null;
      return true;
    }
    if (this.selectedNodeId && !this.selectedPipeline()?.dag.some((node) => node.id === this.selectedNodeId)
      && !this.selectedRun?.steps.some((step) => step.id === this.selectedNodeId)) {
      this.selectedNodeId = null;
    }
    return false;
  }

  private renderAll(): void {
    this.renderTemplates();
    this.renderDag();
    this.renderLogs();
    this.renderInspector();
    this.renderStatus();
  }

  private renderTemplates(): void {
    const list = byId("production-template-list");
    byId("production-template-count").textContent = String(this.pipelines.length);
    byId("production-template-empty").hidden = this.pipelines.length > 0;
    list.replaceChildren(...this.pipelines.map((pipeline) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "production-template-card";
      button.dataset.availability = pipeline.availability;
      button.classList.toggle("active", this.selectedPipelineKey === pipeline.key);
      const icon = document.createElement("span");
      icon.className = "pipeline-card-icon";
      const glyph = document.createElement("i");
      glyph.dataset.lucide = PIPELINE_ICONS[pipeline.key] ?? "circle";
      icon.append(glyph);
      const copy = document.createElement("span");
      copy.className = "pipeline-card-copy";
      const title = document.createElement("strong");
      title.textContent = pipeline.title;
      const detail = document.createElement("small");
      detail.textContent = pipeline.description;
      const state = document.createElement("em");
      state.textContent = pipeline.availability === "planned" ? "规划中 · 仅可查看" : `${pipeline.dag.length} 个节点 · 可执行`;
      copy.append(title, detail, state);
      button.append(icon, copy);
      button.addEventListener("click", () => this.selectPipeline(pipeline.key));
      return button;
    }));
    renderIcons();
  }

  private renderDag(): void {
    this.preserveView(byId("production-dag-list"), () => this.renderDagContent());
  }

  private renderDagContent(): void {
    const list = byId("production-dag-list");
    const empty = byId("production-dag-empty");
    const pipeline = this.selectedPipeline();
    list.replaceChildren();
    empty.hidden = Boolean(pipeline);
    if (!pipeline) return;
    byId("production-dag-heading").textContent = `${pipeline.title} · DAG`;
    const run = this.selectedRun;
    byId("production-dag-count").textContent = run
      ? `${shortId(run.id)} · ${new Date(run.createdAt).toLocaleString()}` : `${pipeline.dag.length} NODES · 未选择执行记录`;
    byId("production-dag-count").title = byId("production-dag-count").textContent ?? "";
    const statuses = new Map((this.selectedRun?.steps ?? []).map((step) => [step.id, step.status]));
    pipeline.dag.forEach((node, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "production-dag-node";
      button.dataset.nodeId = node.id;
      const status = run ? statuses.get(node.id) ?? "skipped" : "idle";
      button.dataset.status = status;
      const logSelected = node.id === this.selectedNodeId;
      button.classList.toggle("active", logSelected);
      button.setAttribute("aria-pressed", String(logSelected));
      button.title = node.description;
      const glyph = document.createElement("span");
      glyph.className = "dag-node-icon";
      const icon = document.createElement("i");
      icon.dataset.lucide = NODE_ICONS[node.id] ?? "circle";
      glyph.append(icon);
      const title = document.createElement("strong");
      title.textContent = node.title;
      const state = document.createElement("small");
      state.textContent = STATUS_LABELS[status] ?? status;
      button.append(glyph, title, state);
      appendTerminalStateBackground(button, status);
      button.addEventListener("click", () => this.selectNode(node.id));
      list.append(button);
      if (index < pipeline.dag.length - 1) {
        const connector = document.createElement("span");
        connector.className = "dag-connector";
        connector.setAttribute("aria-hidden", "true");
        const icon = document.createElement("i");
        icon.dataset.lucide = "arrow-right";
        connector.append(icon);
        list.append(connector);
      }
    });
    renderIcons();
  }

  private renderLogs(): void {
    this.preserveView(document.querySelector<HTMLElement>(".production-log-section")!, () => this.renderLogsContent());
  }

  private renderLogsContent(): void {
    const runs = this.runsForPipeline();
    const list = byId("production-run-list");
    list.hidden = runs.length === 0;
    byId("production-run-count").textContent = String(runs.length);
    byId("production-run-empty").hidden = runs.length > 0;
    list.replaceChildren(...runs.map((run) => {
      const row = document.createElement("div");
      row.className = "production-run-row";
      const select = document.createElement("button");
      select.type = "button";
      select.className = "production-run-chip";
      select.dataset.runId = run.id;
      select.dataset.status = run.status;
      select.classList.toggle("active", run.id === this.selectedRunId);
      select.setAttribute("aria-pressed", String(run.id === this.selectedRunId));
      select.title = `选择执行记录 ${shortId(run.id)}`;
      const status = document.createElement("strong");
      status.textContent = STATUS_LABELS[run.status] ?? run.status;
      const time = document.createElement("time");
      time.dateTime = run.createdAt;
      time.textContent = new Date(run.createdAt).toLocaleString(undefined, { dateStyle: "short", timeStyle: "medium" });
      const id = document.createElement("span");
      id.className = "production-run-id";
      id.textContent = shortId(run.id);
      id.title = run.id;
      const summary = document.createElement("span");
      summary.className = "production-run-summary";
      summary.textContent = this.runResultLabel(run);
      summary.title = summary.textContent;
      select.append(status, time, id, summary);
      appendTerminalStateBackground(select, run.status);
      select.addEventListener("click", () => this.selectRun(run));

      const detail = document.createElement("button");
      detail.type = "button";
      detail.className = "production-run-detail-button";
      detail.setAttribute("aria-label", `查看 ${shortId(run.id)} 的执行详情`);
      detail.title = "查看执行详情";
      const detailIcon = document.createElement("i");
      detailIcon.dataset.lucide = "info";
      detail.append(detailIcon);
      detail.addEventListener("click", () => this.openRunDialog(run));
      row.append(select, detail);
      return row;
    }));

    renderIcons();
  }

  private renderNodeLogs(run: ProductionRun): HTMLElement {
    const detail = document.createElement("div");
    detail.id = "production-log-detail";
    detail.className = "production-log-detail";
    detail.tabIndex = 0;
    detail.setAttribute("aria-label", "所选执行的节点日志");
    const step = run.steps.find((candidate) => candidate.id === this.selectedNodeId);
    const heading = document.createElement("div");
    heading.className = "production-log-heading";
    const headingCopy = document.createElement("div");
    const kicker = document.createElement("span");
    kicker.textContent = shortId(run.id);
    const title = document.createElement("strong");
    title.textContent = "节点日志";
    headingCopy.append(kicker, title);
    const badge = document.createElement("span");
    badge.className = "run-status";
    badge.dataset.status = step?.status ?? "skipped";
    badge.textContent = STATUS_LABELS[step?.status ?? "skipped"] ?? "已跳过";
    heading.append(headingCopy, badge);
    detail.append(heading);
    if (step?.startedAt || step?.completedAt) {
      const times = document.createElement("p");
      times.className = "production-log-empty";
      times.textContent = [step.startedAt ? `开始：${new Date(step.startedAt).toLocaleString()}` : "",
        step.completedAt ? `结束：${new Date(step.completedAt).toLocaleString()}` : ""].filter(Boolean).join(" · ");
      detail.append(times);
    }
    if (step?.detail || !step) {
      const description = document.createElement("p");
      description.className = "production-log-empty";
      description.textContent = step?.detail ?? "该节点不属于此次历史执行。";
      detail.append(description);
    }

    const logs = step?.logs ?? [];
    if (logs.length) {
      const stream = document.createElement("ol");
      stream.className = "production-log-stream";
      logs.forEach((entry) => {
        const row = document.createElement("li");
        row.dataset.level = entry.level;
        const time = document.createElement("time");
        time.dateTime = entry.timestamp;
        time.textContent = new Date(entry.timestamp).toLocaleTimeString();
        const level = document.createElement("b");
        level.textContent = entry.level.toUpperCase();
        const message = document.createElement("span");
        message.textContent = entry.message;
        row.append(time, level, message);
        stream.append(row);
      });
      detail.append(stream);
    } else {
      const empty = document.createElement("p");
      empty.className = "production-log-empty";
      empty.textContent = "该节点尚未产生日志。";
      detail.append(empty);
    }
    return detail;
  }

  private runResultLabel(run: ProductionRun): string {
    if (run.status === "awaiting-approval") return `${String(run.summary.inventoryFiles ?? run.inventory?.files.length ?? "?")} 个文件待审批`;
    if (run.status === "resolving") return "正在解析来源单元";
    if (run.summary.downloadedFiles !== undefined) {
      const failedFiles = Number(run.summary.failedFiles ?? 0);
      return `${String(run.summary.downloadedFiles)}/${String(run.summary.files ?? "?")} 个文件 · ${formatBytes(Number(run.summary.downloadedBytes ?? 0))}${failedFiles ? ` · 跳过 ${failedFiles}` : ""}`;
    }
    if (run.summary.matchRows !== undefined) return `${String(run.summary.matchRows)} 个匹配`;
    if (run.artifacts.length) return `${run.artifacts.length} 个产物`;
    return run.error ? "有错误详情" : "等待节点输出";
  }

  private openRunDialog(run: ProductionRun): void {
    this.selectRun(run);
    this.renderRunDialog(run);
    const dialog = byId<HTMLDialogElement>("production-run-dialog");
    if (!dialog.open) dialog.showModal();
  }

  private renderRunDialog(run: ProductionRun): void {
    const pipeline = this.pipelines.find((candidate) => candidate.key === run.pipelineKey);
    byId("production-run-dialog-kicker").textContent = shortId(run.id);
    byId("production-run-dialog-title").textContent = `${pipeline?.title ?? run.pipelineKey} · 执行详情`;
    const content = byId("production-run-dialog-content");
    content.replaceChildren();

    const metadata = document.createElement("dl");
    metadata.className = "production-run-detail-meta";
    const region = run.input.region as Partial<RegionSnapshot> | undefined;
    const rows: Array<[string, string]> = [
      ["状态", STATUS_LABELS[run.status] ?? run.status],
      ["创建时间", new Date(run.createdAt).toLocaleString()],
      ["区域快照", region?.nside ? `ICRS · NESTED · NSIDE ${region.nside} · ${region.pixels?.length ?? 0} cells` : "--"],
      ["执行编号", run.id],
    ];
    rows.forEach(([label, value]) => {
      const row = document.createElement("div");
      const term = document.createElement("dt");
      term.textContent = label;
      const detail = document.createElement("dd");
      detail.textContent = value;
      detail.title = value;
      row.append(term, detail);
      metadata.append(row);
    });
    content.append(metadata);

    const stepHeading = document.createElement("div");
    stepHeading.className = "form-section-title";
    stepHeading.textContent = "执行节点";
    content.append(stepHeading);
    const steps = document.createElement("ol");
    steps.className = "production-detail-steps";
    const titles = new Map((pipeline?.dag ?? []).map((node) => [node.id, node.title]));
    run.steps.forEach((step) => {
      const item = document.createElement("li");
      item.dataset.status = step.status;
      const title = document.createElement("strong");
      title.textContent = titles.get(step.id) ?? step.title;
      const state = document.createElement("span");
      state.textContent = STATUS_LABELS[step.status] ?? step.status;
      item.append(title, state);
      steps.append(item);
    });
    content.append(steps);

    if (run.status === "awaiting-approval" && run.approval?.state === "pending") {
      const approvalSection = document.createElement("div");
      approvalSection.className = "production-approval-section";
      const approvalHeading = document.createElement("div");
      approvalHeading.className = "form-section-title";
      approvalHeading.textContent = "下载清单待审批";
      approvalSection.append(approvalHeading);
      const inventory = run.inventory;
      const knownBytes = inventory?.files.reduce((sum, file) => sum + (file.sizeBytes ?? 0), 0) ?? 0;
      const unknownSizes = inventory?.files.filter((file) => file.sizeBytes === undefined).length ?? 0;
      const facts = document.createElement("dl");
      facts.className = "production-run-detail-meta";
      const approvalRows: Array<[string, string]> = [
        ["文件数", String(inventory?.files.length ?? 0)],
        ["已知体积", knownBytes ? formatBytes(knownBytes) : "未知"],
        ["来源单元", String(inventory?.units.length ?? 0)],
        ...(unknownSizes ? [["未知大小文件", String(unknownSizes)] as [string, string]] : []),
        ...(run.summary.inventoryTruncated ? [["截断提示", "清单被上限截断"] as [string, string]] : []),
        ["清单指纹", `${run.approval.planSha256.slice(0, 16)}…`],
      ];
      approvalRows.forEach(([label, value]) => {
        const row = document.createElement("div");
        const term = document.createElement("dt");
        term.textContent = label;
        const detail = document.createElement("dd");
        detail.textContent = value;
        detail.title = value;
        row.append(term, detail);
        facts.append(row);
      });
      approvalSection.append(facts);
      if (inventory?.truncated) {
        const truncatedNote = document.createElement("p");
        truncatedNote.className = "production-run-error";
        truncatedNote.textContent = "部分来源单元的文件列表被截断，审批前请确认总量。";
        approvalSection.append(truncatedNote);
      }
      content.append(approvalSection);
    }

    if (run.error) {
      const error = document.createElement("p");
      error.className = "production-run-error";
      error.textContent = run.error;
      content.append(error);
    }

    if (run.artifacts.length) {
      const artifactHeading = document.createElement("div");
      artifactHeading.className = "form-section-title";
      artifactHeading.textContent = "产物";
      const artifacts = document.createElement("div");
      artifacts.className = "production-run-artifacts";
      run.artifacts.forEach((artifact) => {
        const link = document.createElement("a");
        link.className = "command-button secondary";
        link.href = workspaceApi.productionArtifactUrl(run.id, artifact.name);
        link.download = artifact.name;
        const icon = document.createElement("i");
        icon.dataset.lucide = "download";
        const label = document.createElement("span");
        label.textContent = `${artifact.name} · ${formatBytes(artifact.byteLength)}`;
        link.append(icon, label);
        artifacts.append(link);
      });
      content.append(artifactHeading, artifacts);
    }

    const actions = document.createElement("div");
    actions.className = "production-run-actions production-run-dialog-actions";
    if (run.status === "awaiting-approval" && run.approval?.state === "pending") {
      const approve = document.createElement("button");
      approve.type = "button";
      approve.className = "primary-command";
      approve.textContent = "批准并开始下载";
      approve.addEventListener("click", () => void this.approve(run));
      const reject = document.createElement("button");
      reject.type = "button";
      reject.className = "command-button danger";
      reject.textContent = "拒绝清单";
      reject.addEventListener("click", () => void this.reject(run));
      actions.append(approve, reject);
    }
    if ((run.status === "queued" || run.status === "running" || run.status === "resolving" || run.status === "awaiting-approval") && run.pipelineKey === "overlap-download@1") {
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "command-button danger";
      cancel.textContent = "取消任务";
      cancel.addEventListener("click", () => void this.cancel(run));
      actions.append(cancel);
    }
    if (run.status === "failed" || run.status === "cancelled") {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "command-button secondary";
      retry.textContent = "重试并新建记录";
      retry.addEventListener("click", () => void this.retry(run));
      actions.append(retry);
    }
    if (actions.childElementCount) content.append(actions);
    renderIcons();
  }

  private renderInspector(preserve = true): void {
    const panel = byId("inspector-panel");
    if (preserve) this.preserveView(panel, () => this.renderInspectorContent());
    else {
      this.renderInspectorContent();
      panel.scrollTop = 0;
    }
    this.renderPreviewWorkspace();
  }

  private renderRunInspector(run: ProductionRun, pipeline: ProductionPipelineDefinition): void {
    const template = document.createElement("button");
    template.id = "production-inspector-template";
    template.type = "button";
    template.className = "command-button secondary";
    template.textContent = "返回模板参数";
    template.addEventListener("click", () => this.returnToTemplate());
    const selectedNode = pipeline.dag.find((node) => node.id === this.selectedNodeId);
    const selectedStep = run.steps.find((step) => step.id === this.selectedNodeId);
    if (this.selectedNodeId) {
      const back = document.createElement("button");
      back.id = "production-run-overview-back";
      back.type = "button";
      back.className = "command-button secondary";
      back.textContent = "返回执行概览";
      back.addEventListener("click", () => {
        this.selectedNodeId = null;
        this.renderDag();
        this.renderInspector(false);
      });
      this.renderInspectorView({
        kicker: "NODE LOGS", title: selectedStep?.title ?? selectedNode?.title ?? this.selectedNodeId,
        summary: `${pipeline.title} · ${new Date(run.createdAt).toLocaleString()}`,
        body: this.renderNodeLogs(run), actions: [back, template],
      });
    } else {
      const body = document.createElement("div");
      body.id = "production-run-overview";
      body.className = "production-inspector-body";
      if (run.error) {
        const error = document.createElement("p");
        error.className = "production-run-error";
        error.textContent = run.error;
        body.append(error);
      }
      const heading = document.createElement("div");
      heading.className = "form-section-title";
      heading.textContent = "执行节点 · 点击查看日志";
      const nodes = document.createElement("div");
      nodes.className = "production-run-nodes";
      const dagIds = new Set(pipeline.dag.map((node) => node.id));
      const historyNodes = [...pipeline.dag, ...run.steps.filter((step) => !dagIds.has(step.id))];
      historyNodes.forEach((node) => {
        const step = run.steps.find((candidate) => candidate.id === node.id);
        const button = document.createElement("button");
        button.id = `production-history-node-${node.id}`;
        button.type = "button";
        button.className = "production-run-node";
        button.dataset.status = step?.status ?? "skipped";
        const title = document.createElement("strong");
        title.textContent = step?.title ?? node.title;
        const status = document.createElement("span");
        status.textContent = STATUS_LABELS[step?.status ?? "skipped"] ?? "已跳过";
        button.append(title, status);
        button.title = step?.detail ?? (step ? "查看该节点的日志" : "该节点不属于此次历史执行");
        button.addEventListener("click", () => this.selectNode(node.id));
        nodes.append(button);
      });
      body.append(heading, nodes);
      const detail = document.createElement("button");
      detail.id = "production-inspector-run-detail";
      detail.type = "button";
      detail.className = "command-button secondary";
      detail.textContent = "查看执行详情与操作";
      detail.addEventListener("click", () => this.openRunDialog(run));
      const rows: Array<[string, string]> = [
        ["记录 ID", run.id], ["状态", STATUS_LABELS[run.status] ?? run.status],
        ["提交时间", new Date(run.createdAt).toLocaleString()],
        ["开始时间", run.startedAt ? new Date(run.startedAt).toLocaleString() : "未记录"],
        ["结束时间", run.completedAt ? new Date(run.completedAt).toLocaleString() : "未记录"],
      ];
      const region = run.input.region as Partial<RegionSnapshot> | undefined;
      if (region?.nside) rows.push(["执行天区", `NSIDE ${region.nside} · ${region.pixels?.length ?? 0} cells`]);
      this.renderInspectorView({
        kicker: "EXECUTION OVERVIEW", title: pipeline.title,
        summary: this.runResultLabel(run), rows, body, actions: [detail, template],
      });
    }
    renderIcons();
  }

  private renderInspectorContent(): void {
    const pipeline = this.selectedPipeline();
    if (!pipeline) { this.renderInspectorView(null); return; }
    const run = this.selectedRun;
    if (run) { this.renderRunInspector(run, pipeline); return; }
    const draft = this.draftForKey(pipeline.key);
    const body = document.createElement("div");
    body.className = "production-inspector-body";
    const description = document.createElement("p");
    description.className = "inspector-summary";
    description.textContent = pipeline.description;
    body.append(description, this.contextSection());
    const node = pipeline.dag.find((candidate) => candidate.id === this.selectedNodeId);
    if (node) {
      const note = document.createElement("p");
      note.className = "production-template-node-note";
      note.textContent = `${node.title}：${node.description}。选择一条历史执行记录后，可查看该节点的状态与日志。`;
      body.append(note);
    }

    const fields = document.createElement("div");
    fields.className = "production-inspector-fields";
    const parameterHeading = document.createElement("div");
    parameterHeading.className = "form-section-title";
    parameterHeading.textContent = "流水线参数";
    fields.append(parameterHeading);
    if (pipeline.key === "overlap-download@1") this.renderDownloadFields(fields, pipeline, draft);
    else if (pipeline.key === "object-crossmatch@1") this.renderCrossmatchFields(fields, pipeline, draft);
    else pipeline.parameters.forEach((parameter) => fields.append(this.parameterControl(parameter, draft, false)));
    body.append(fields);

    const rows: Array<[string, string]> = [
      ["状态", pipeline.availability === "available" ? "可执行模板" : "规划中"],
      ["输入", pipeline.inputRequirements.join(" · ")],
      ["输出", pipeline.outputs.join(" · ")],
      ["DAG", `${pipeline.dag.length} nodes`],
    ];
    if (pipeline.key === "overlap-download@1") {
      const preview = document.createElement("button");
      preview.id = "production-preview-download";
      preview.type = "button";
      preview.className = "command-button secondary";
      preview.textContent = this.previewLoading ? "正在读取文件" : this.downloadPreview ? "刷新文件预览" : "预览下载文件";
      const previewIcon = document.createElement("i");
      previewIcon.dataset.lucide = this.downloadPreview ? "refresh-cw" : "download";
      preview.prepend(previewIcon);
      preview.disabled = this.previewLoading || this.submitLoading || !this.downloadSelectionForContext();
      preview.title = !this.context
        ? "必须先从数据覆盖页附加天区上下文"
        : !this.downloadSelectionForContext() ? "请先选择可用的公开原生分块" : "读取所选原生分块的文件清单；不会创建任务或开始传输";
      preview.addEventListener("click", () => void this.refreshDownloadPreview());

      this.renderInspectorView({ kicker: "PIPELINE TEMPLATE", title: pipeline.title, rows, body, actions: [preview] });
      renderIcons();
      return;
    }

    const execute = document.createElement("button");
    execute.id = "production-execute";
    execute.type = "button";
    execute.className = "primary-command";
    execute.textContent = pipeline.availability === "planned" ? "尚未开放" : "执行流水线";
    execute.disabled = !this.canSubmit(pipeline, draft);
    execute.title = !this.context ? "必须先从数据覆盖页附加天区上下文" : execute.disabled ? "请补齐流水线输入" : "使用当前参数创建一条执行记录";
    execute.addEventListener("click", () => void this.submit().catch((error) => this.showError(error)));
    this.renderInspectorView({ kicker: "PIPELINE TEMPLATE", title: pipeline.title, rows, body, actions: [execute] });
    renderIcons();
  }

  private contextSection(): HTMLElement {
    const section = document.createElement("section");
    section.className = `production-context${this.context ? " is-ready" : " is-missing"}`;
    const heading = document.createElement("strong");
    heading.textContent = "天区上下文";
    const copy = document.createElement("p");
    copy.id = "production-region-summary";
    copy.textContent = this.context
      ? `ICRS · NESTED · NSIDE ${this.context.nside} · ${this.context.pixels.length} cells${this.context.componentId ? ` · ${this.context.componentId}` : ""}`
      : "未附加天区。请先在“数据覆盖”中选择区域，再交给数据生产。";
    section.append(heading, copy);
    return section;
  }

  private renderDownloadFields(root: HTMLElement, pipeline: ProductionPipelineDefinition, draft: Record<string, unknown>): void {
    const nativeSelection = this.renderNativeSelection();
    if (nativeSelection) root.append(nativeSelection);
    pipeline.parameters.forEach((parameter) => root.append(this.parameterControl(parameter, draft, true)));
    const storageLabel = document.createElement("label");
    storageLabel.className = "field-label";
    storageLabel.textContent = "存储位置";
    const storage = document.createElement("select");
    storage.id = "production-storage";
    storage.className = "field-input";
    storage.append(new Option("Workspace 托管目录（自动创建 Connector）", ""), ...this.connectors
      .filter((connector) => connector.kind === "local" && connector.status !== "disabled")
      .map((connector) => new Option(`${connector.name} · ${connector.displayPath}`, connector.id)));
    storage.value = String(draft.storageConnectorId ?? "");
    storage.addEventListener("change", () => { draft.storageConnectorId = storage.value; });
    storageLabel.append(storage);
    root.append(storageLabel);
    const scanNote = document.createElement("p");
    scanNote.className = "control-note";
    scanNote.textContent = "下载完成后会注册本地 Connector；在“用户资产”登记并关联该 Connector 后，可单独扫描文件，生成本地覆盖图层。";
    root.append(scanNote);
    const files = document.createElement("p");
    files.id = "production-files-summary";
    files.className = "control-note";
    files.textContent = "公开 HTTP(S) 文件会先列入预览；只有确认所选文件后才会创建下载任务。";
    root.append(files);
    const behavior = document.createElement("p");
    behavior.className = "control-note";
    behavior.textContent = "支持 Euclid、DESI、Legacy Surveys、HST 当前可匿名获取的 HTTP(S) 文件。下载的是完整原始文件，不按天区裁切；默认写入 Workspace 运行端目录。";
    root.append(behavior);
    if (!this.hasExecutablePublicSource()) {
      const unavailable = document.createElement("p");
      unavailable.className = "control-note";
      unavailable.textContent = "当前区域只有几何覆盖证据，尚未提供具体 public sourceId/layerId，因此不能创建公开下载任务。";
      root.append(unavailable);
    }
  }

  private preserveView(root: HTMLElement, update: () => void): void {
    const active = document.activeElement instanceof HTMLElement && root.contains(document.activeElement) ? document.activeElement : null;
    const focusSelector = active?.id ? `#${CSS.escape(active.id)}` : active?.dataset.selectionKey ? `[data-selection-key="${CSS.escape(active.dataset.selectionKey)}"]`
      : active?.dataset.fileUrl ? `[data-file-url="${CSS.escape(active.dataset.fileUrl)}"]`
      : active?.dataset.runId ? `[data-run-id="${CSS.escape(active.dataset.runId)}"]` : active?.dataset.nodeId ? `[data-node-id="${CSS.escape(active.dataset.nodeId)}"]` : null;
    const scrolls = [root, ...root.querySelectorAll<HTMLElement>("#production-run-list, #production-log-detail, .production-download-preview")].map((element) => ({
      selector: element === root ? null : element.id ? `#${element.id}` : ".production-download-preview",
      top: element.scrollTop, left: element.scrollLeft,
      follow: element.id === "production-log-detail" && element.clientHeight > 0 && element.scrollHeight - element.scrollTop - element.clientHeight < 8,
    }));
    const groups = new Map([...root.querySelectorAll<HTMLDetailsElement>("details[data-source-key]")].map((element) => [element.dataset.sourceKey, element.open]));
    update();
    root.querySelectorAll<HTMLDetailsElement>("details[data-source-key]").forEach((element) => {
      const open = groups.get(element.dataset.sourceKey);
      if (open !== undefined) element.open = open;
    });
    if (focusSelector) root.querySelector<HTMLElement>(focusSelector)?.focus({ preventScroll: true });
    for (const position of scrolls) {
      const element = position.selector ? root.querySelector<HTMLElement>(position.selector) : root;
      if (element) { element.scrollTop = position.follow ? element.scrollHeight : position.top; element.scrollLeft = position.left; }
    }
  }

  private renderPreviewWorkspace(): void {
    const root = byId("production-download-workspace");
    const open = this.previewPanelOpen && this.selectedPipelineKey === "overlap-download@1";
    root.hidden = !open;
    document.querySelector<HTMLElement>(".production-log-section")!.hidden = open;
    this.preserveView(root, () => {
      const toolbar = document.createElement("div");
      toolbar.className = "production-preview-toolbar";
      const back = document.createElement("button");
      back.id = "production-preview-close";
      back.type = "button";
      back.className = "command-button secondary compact-command";
      back.textContent = "返回执行记录";
      back.disabled = this.submitLoading;
      back.addEventListener("click", () => {
        if (this.previewLoading) this.stopDownloadPreview();
        this.previewPanelOpen = false;
        this.renderPreviewWorkspace();
      });
      const settings = document.createElement("button");
      settings.type = "button";
      settings.className = "command-button secondary compact-command production-preview-settings";
      settings.textContent = "任务参数";
      settings.addEventListener("click", () => byId("inspector-panel").classList.add("mobile-open"));
      toolbar.append(back, settings);
      const actions = document.createElement("div");
      actions.className = "production-preview-actions";
      if (this.previewLoading) {
        const stop = document.createElement("button");
        stop.id = "production-stop-preview";
        stop.type = "button";
        stop.className = "command-button danger";
        stop.textContent = "停止预览";
        stop.addEventListener("click", () => this.stopDownloadPreview());
        actions.append(stop);
      } else if (!this.downloadPreview) {
        const retry = document.createElement("button");
        retry.id = "production-retry-preview";
        retry.type = "button";
        retry.className = "command-button secondary";
        retry.textContent = "重新预览";
        retry.disabled = !this.downloadSelectionForContext();
        retry.addEventListener("click", () => void this.refreshDownloadPreview());
        actions.append(retry);
      }
      const confirm = document.createElement("button");
      confirm.id = "production-confirm-download";
      confirm.type = "button";
      confirm.className = "primary-command";
      confirm.textContent = this.submitLoading ? "正在创建任务" : `确认下载 ${this.selectedFiles().length} 个文件`;
      const problem = this.downloadConfirmationProblem();
      confirm.disabled = Boolean(problem) || this.previewLoading || this.submitLoading;
      confirm.title = problem ?? "根据当前预览和所选文件创建已确认的下载任务";
      confirm.addEventListener("click", () => void this.confirmDownload().catch((error) => this.showError(error, "创建下载任务失败")));
      actions.append(confirm);
      root.replaceChildren(toolbar, this.renderDownloadPreview(), actions);
    });
  }

  private renderDownloadPreview(): HTMLElement {
    const section = document.createElement("section");
    section.className = "production-download-preview interactive-scroll-region";
    section.addEventListener("scroll", () => {
      section.classList.add("is-scrolling");
      const previous = downloadPreviewScrollTimers.get(section);
      if (previous) clearTimeout(previous);
      downloadPreviewScrollTimers.set(section, setTimeout(() => section.classList.remove("is-scrolling"), 700));
    }, { passive: true });
    const heading = document.createElement("h3");
    heading.textContent = "公开文件预览";
    section.append(heading);

    if (this.context?.downloadScopeNote) {
      const scope = document.createElement("p");
      scope.className = "control-note production-download-scope-note";
      scope.textContent = this.context.downloadScopeNote;
      section.append(scope);
    }
    if (this.previewError) {
      const error = document.createElement("p");
      error.className = "production-run-error";
      error.textContent = this.previewError;
      section.append(error);
    }
    const preview = this.downloadPreview;
    const allFiles = preview?.inventory.files ?? [...this.partialPreviewFiles.values()].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    if (this.previewProgress) {
      const progress = document.createElement("p");
      progress.id = "production-preview-progress";
      progress.className = "production-preview-progress";
      progress.setAttribute("role", "status");
      const state = this.previewProgress;
      progress.textContent = this.previewStopped ? "预览已停止，已找到的文件仅供查看。请重新预览后再确认下载。"
        : !this.previewLoading ? preview ? `文件预览已完成，前 ${Math.min(preview.inventory.files.length, preview.limits.maxFiles)} 个文件已默认勾选；文件大小不限。` : "预览未完成，已找到的文件仅供查看。"
        : state.stage === "lookup" ? "正在核对所选区域与公开来源…"
        : `正在读取文件清单 · 已处理 ${state.completed} / ${state.total ?? "?"} 项 · 找到 ${state.files} 个文件${state.unavailable ? ` · ${state.unavailable} 项不可用` : ""}`;
      section.append(progress);
    }
    if (!preview && !allFiles.length) {
      const empty = document.createElement("p");
      empty.className = "production-download-empty";
      empty.textContent = this.previewLoading ? "正在读取当前公开来源的文件清单…" : this.previewStopped ? "本次预览未完成，未开始下载。" : this.previewError ? "文件清单未完成，请重新预览。" : "尚未生成文件清单预览。";
      section.append(empty);
    }

    const selected = this.selectedFiles();
    const selectedBytes = selected.reduce((total, file) => total + (knownByteSize(file.sizeBytes) ?? 0), 0);
    const unknownSelectedSizes = selected.filter((file) => knownByteSize(file.sizeBytes) === undefined).length;
    const expired = preview ? this.isPreviewExpired(preview) : false;
    const summary = document.createElement("p");
    summary.className = "production-download-summary";
    summary.textContent = preview ? `${selected.length} / ${allFiles.length} 个文件 · 已知大小 ${formatBytes(selectedBytes)}${unknownSelectedSizes ? ` · ${unknownSelectedSizes} 个大小未知` : ""}` : `已找到 ${allFiles.length} 个文件 · 预览完成后可选择下载`;
    section.append(summary);

    const scope = document.createElement("p");
    scope.className = "production-download-scope-note";
    scope.textContent = "将下载勾选的完整原始文件；所选天区用于查找文件，不会裁切。";
    section.append(scope);

    if (preview) {
      const limits = document.createElement("p");
      limits.className = "production-download-limits";
      limits.textContent = `最多 ${preview.limits.maxFiles} 个文件 · 单文件大小不限 · 任务总量不限 · 有效至 ${new Date(preview.expiresAt).toLocaleString()}`;
      section.append(limits);
    }

    const selectionProblem = this.downloadConfirmationProblem();
    if (selected.length && selectionProblem && !expired && !this.previewExpired) {
      const limitError = document.createElement("p");
      limitError.className = "production-download-warning";
      limitError.textContent = selectionProblem;
      section.append(limitError);
    }
    if (this.downloadSelectionNotice) {
      const selectionNotice = document.createElement("p");
      selectionNotice.className = "production-download-warning";
      selectionNotice.textContent = this.downloadSelectionNotice;
      section.append(selectionNotice);
    }

    if (expired || this.previewExpired) {
      const expiredNote = document.createElement("p");
      expiredNote.className = "production-download-warning";
      expiredNote.textContent = "预览已过期。请重新查询文件清单后再确认下载。";
      section.append(expiredNote);
    }
    const hasTruncationNotice = preview?.notices?.some((notice) => notice.code === "results-truncated") ?? false;
    if ((preview?.selectionTruncated || preview?.inventory.truncated) && !hasTruncationNotice) {
      const bounded = document.createElement("p");
      bounded.className = "production-download-warning";
      bounded.textContent = preview?.selectionTruncated
        ? "原生分块范围或文件清单达到预览上限，当前结果可能不完整。可缩小天区后重新预览。"
        : "文件清单达到服务上限，当前结果可能不完整。可缩小天区后重新预览。";
      section.append(bounded);
    }

    if (preview && !allFiles.length) {
      const empty = document.createElement("p");
      empty.className = "production-download-empty";
      empty.textContent = "当前预览没有可选文件。";
      section.append(empty);
    }
    type ProductFiles = { key: string; label: string; files: typeof allFiles };
    type SurveyFiles = { key: string; label: string; files: typeof allFiles; products: Map<string, ProductFiles> };
    const surveys = new Map<string, SurveyFiles>();
    for (const file of allFiles) {
      const identity = parsePublicSourceId(file.sourceId);
      const surveyKey = identity?.surveyId ?? `source:${file.sourceId ?? file.layerId ?? file.resolver}`;
      const surveyLabel = identity?.surveyId ?? file.sourceId ?? "未识别来源";
      const productKey = JSON.stringify([identity?.releaseId ?? "", identity?.product ?? file.layerId ?? file.resolver]);
      const productLabel = identity ? `${identity.releaseId} · ${identity.product}` : file.layerId ?? file.resolver;
      let survey = surveys.get(surveyKey);
      if (!survey) {
        survey = { key: surveyKey, label: surveyLabel, files: [], products: new Map() };
        surveys.set(surveyKey, survey);
      }
      survey.files.push(file);
      let product = survey.products.get(productKey);
      if (!product) {
        product = { key: JSON.stringify([surveyKey, productKey]), label: productLabel, files: [] };
        survey.products.set(productKey, product);
      }
      product.files.push(file);
    }
    const selectionDisabled = !preview || expired || this.previewExpired || this.previewLoading || this.submitLoading;
    for (const survey of surveys.values()) {
      const surveyHeader = document.createElement("div");
      surveyHeader.className = "production-download-survey-header";
      const surveyCheckbox = document.createElement("input");
      surveyCheckbox.type = "checkbox";
      const surveySelected = survey.files.filter((file) => this.selectedDownloadUrls.has(file.url)).length;
      surveyCheckbox.checked = surveySelected === survey.files.length && survey.files.length > 0;
      surveyCheckbox.indeterminate = surveySelected > 0 && surveySelected < survey.files.length;
      surveyCheckbox.disabled = selectionDisabled;
      surveyCheckbox.dataset.selectionKey = JSON.stringify(["survey", survey.key]);
      surveyCheckbox.setAttribute("aria-label", `选择 ${survey.label} 巡天全部文件`);
      surveyCheckbox.title = `${surveySelected} / ${survey.files.length} 个文件已选`;
      surveyCheckbox.addEventListener("click", (event) => event.stopPropagation());
      surveyCheckbox.addEventListener("change", () => this.setDownloadGroupSelection(survey.files, surveyCheckbox.checked, survey.label));
      const surveyName = document.createElement("strong");
      surveyName.textContent = survey.label;
      const surveyCount = document.createElement("small");
      surveyCount.textContent = `${surveySelected} / ${survey.files.length}`;
      surveyHeader.append(surveyCheckbox, surveyName, surveyCount);
      section.append(surveyHeader);

      for (const product of survey.products.values()) {
        const group = document.createElement("details");
        group.className = "production-download-source";
        group.dataset.sourceKey = product.key;
        group.open = survey.products.size <= 4;
        const label = document.createElement("summary");
        const groupCheckbox = document.createElement("input");
        groupCheckbox.type = "checkbox";
        const groupSelected = product.files.filter((file) => this.selectedDownloadUrls.has(file.url)).length;
        groupCheckbox.checked = groupSelected === product.files.length && product.files.length > 0;
        groupCheckbox.indeterminate = groupSelected > 0 && groupSelected < product.files.length;
        groupCheckbox.disabled = selectionDisabled;
        groupCheckbox.dataset.selectionKey = JSON.stringify(["product", product.key]);
        groupCheckbox.setAttribute("aria-label", `选择 ${survey.label} · ${product.label} 全部文件`);
        groupCheckbox.title = `${groupSelected} / ${product.files.length} 个文件已选`;
        groupCheckbox.addEventListener("click", (event) => event.stopPropagation());
        groupCheckbox.addEventListener("change", () => this.setDownloadGroupSelection(product.files, groupCheckbox.checked, `${survey.label} · ${product.label}`));
        const labelText = document.createElement("span");
        labelText.className = "production-download-group-label";
        labelText.textContent = `${product.label} · ${groupSelected} / ${product.files.length} 个文件已选`;
        label.append(groupCheckbox, labelText);
        group.append(label);
        const list = document.createElement("ul");
        const visibleCount = this.visibleDownloadFileCounts.get(product.key) ?? 128;
        for (const file of product.files.slice(0, visibleCount)) {
        const row = document.createElement("li");
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.dataset.fileUrl = file.url;
        checkbox.dataset.selectionKey = JSON.stringify(["file", file.url]);
        checkbox.checked = this.selectedDownloadUrls.has(file.url);
        const byteSize = knownByteSize(file.sizeBytes);
        const sizeKnown = byteSize !== undefined;
        const countWouldExceed = Boolean(preview && !checkbox.checked && selected.length >= preview.limits.maxFiles);
        checkbox.disabled = selectionDisabled
          || (!checkbox.checked && countWouldExceed);
        checkbox.setAttribute("aria-label", `选择 ${this.displayFileName(file.relativePath)}`);
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) this.selectedDownloadUrls.add(file.url);
          else this.selectedDownloadUrls.delete(file.url);
          this.downloadSelectionNotice = null;
          this.renderInspector();
        });
        const text = document.createElement("span");
        text.className = "production-download-file-copy";
        const name = document.createElement("strong");
        name.textContent = this.displayFileName(file.relativePath);
        text.append(name);
        if (file.nativeUnitId) {
          const unit = document.createElement("small");
          unit.textContent = `${file.nativeUnitKind ?? "原生单元"} ${file.nativeUnitId}`;
          text.append(unit);
        }
        const sizeLabel = document.createElement("small");
        sizeLabel.textContent = sizeKnown ? formatBytes(byteSize!) : "大小未知；传输时统计";
        text.append(sizeLabel);
        row.append(checkbox, text);
        list.append(row);
      }
        group.append(list);
        if (product.files.length > visibleCount) {
          const more = document.createElement("button");
          more.type = "button";
          more.className = "command-button secondary production-download-more";
          const nextCount = Math.min(product.files.length, visibleCount + 128);
          more.textContent = `显示更多文件（${visibleCount} / ${product.files.length}）`;
          more.title = `再显示 ${nextCount - visibleCount} 个文件`;
          more.addEventListener("click", () => {
            this.visibleDownloadFileCounts.set(product.key, nextCount);
            this.renderInspector();
          });
          group.append(more);
        }
        section.append(group);
      }
    }

    const unavailableItems = preview?.unavailable ?? this.partialPreviewUnavailable;
    if (unavailableItems.length) {
      const unavailable = document.createElement("div");
      unavailable.className = "production-download-unavailable";
      const title = document.createElement("strong");
      title.textContent = "不可用来源";
      unavailable.append(title);
      const list = document.createElement("ul");
      for (const item of unavailableItems) {
        const row = document.createElement("li");
        row.textContent = `${this.publicLayerLabel(item.layerId)}${item.unitId ? ` · ${item.unitId}` : ""}：${item.reason}`;
        list.append(row);
      }
      unavailable.append(list);
      section.append(unavailable);
    }

    const notices = preview?.notices ?? [];
    if (notices.length) {
      const list = document.createElement("ul");
      list.className = "production-download-notice-list";
      const grouped = new Map<string, { notice: NonNullable<RegionDownloadPreview["notices"]>[number]; count: number }>();
      const messages: Record<string, string> = {
        "inventory-incomplete": "该来源的公开文件清单不完整，当前预览可能缺少文件。",
        "coverage-estimated": "该原生单元的覆盖边界为估算，匹配结果可能存在偏差。",
        "file-metadata-unverified": "文件大小等元数据未能核实；下载时仍会传输完整原始文件。",
        "results-truncated": "结果达到服务上限，当前文件清单可能不完整。",
      };
      for (const notice of notices) {
        if (!messages[notice.code]) continue;
        const key = JSON.stringify([notice.code, notice.layerId ?? ""]);
        const current = grouped.get(key);
        grouped.set(key, current ? { ...current, count: current.count + 1 } : { notice, count: 1 });
      }
      for (const { notice, count } of grouped.values()) {
        const message = messages[notice.code]!;
        const source = notice.layerId ? this.publicLayerLabel(notice.layerId) : "";
        const quantity = count > 1
          ? notice.code === "coverage-estimated" ? `${count} 个原生单元：`
            : notice.code === "file-metadata-unverified" ? `${count} 个文件：` : ""
          : "";
        const fileName = count === 1 && notice.code === "file-metadata-unverified" && notice.fileName ? `${notice.fileName} · ` : "";
        const item = document.createElement("li");
        item.textContent = `${source ? `${source} · ` : ""}${quantity}${fileName}${message}`;
        list.append(item);
      }
      if (list.childElementCount) section.append(list);
    }

    const notes = [...new Set(preview?.notes ?? [])];
    if (notes.length) {
      const details = document.createElement("details");
      details.className = "production-download-notes";
      const summary = document.createElement("summary");
      summary.textContent = "清单范围与匹配依据";
      details.append(summary);
      details.append(Object.assign(document.createElement("p"), {
        textContent: "这些来源说明补充本次清单的范围、匹配精度和核验依据；请优先查看上方提示。",
      }));
      const list = document.createElement("ul");
      for (const note of notes) list.append(Object.assign(document.createElement("li"), { textContent: note }));
      details.append(list);
      section.append(details);
    }
    return section;
  }

  private setDownloadGroupSelection(
    files: RegionDownloadPreview["inventory"]["files"],
    checked: boolean,
    label: string,
  ): void {
    const urls = new Set(files.map((file) => file.url));
    if (!checked) {
      urls.forEach((url) => this.selectedDownloadUrls.delete(url));
      this.downloadSelectionNotice = null;
      this.renderInspector();
      return;
    }
    const missing = [...urls].filter((url) => !this.selectedDownloadUrls.has(url));
    const limit = this.downloadPreview?.limits.maxFiles ?? 0;
    if (this.selectedDownloadUrls.size + missing.length > limit) {
      this.downloadSelectionNotice = `${label}还需选择 ${missing.length} 个文件，超过单任务 ${limit} 个文件的上限。请先取消其他文件或选择较小的巡天/产品组。`;
      this.renderInspector();
      return;
    }
    missing.forEach((url) => this.selectedDownloadUrls.add(url));
    this.downloadSelectionNotice = null;
    this.renderInspector();
  }

  private publicLayerLabel(layerId: string): string {
    const identity = (this.context?.sourceIds ?? []).map(parsePublicSourceId).find((candidate) =>
      candidate && assetsLayerIdForIdentity(candidate) === layerId);
    return identity ? `${identity.surveyId} · ${identity.releaseId} · ${identity.product}` : "公开来源";
  }

  private nativeUnitKey(unit: NonNullable<RegionDownloadSelection["units"]>[number]): string {
    return JSON.stringify([unit.layerId, unit.unitKind, unit.unitId]);
  }

  private resetNativeSelection(): void {
    this.selectedNativeUnitKeys.clear();
    const seen = new Set<string>();
    for (const unit of this.context?.downloadSelection?.units?.slice(0, 128) ?? []) {
      const identity = (this.context?.sourceIds ?? []).map(parsePublicSourceId).find((source) =>
        source && assetsLayerIdForIdentity(source) === unit.layerId);
      const survey = identity?.surveyId ?? unit.layerId;
      if (seen.has(survey)) continue;
      seen.add(survey);
      this.selectedNativeUnitKeys.add(this.nativeUnitKey(unit));
    }
  }

  private renderNativeSelection(): HTMLElement | undefined {
    const units = this.context?.downloadSelection?.units?.slice(0, 128);
    if (!units?.length) return undefined;
    const section = document.createElement("section");
    section.className = "production-native-selection";
    const note = document.createElement("p");
    note.className = "control-note";
    note.textContent = "默认每巡天选择一个命中分块。文件预览只读取所选分块；可展开增加，最多 128 个。源站元数据较慢时，增加分块会延长等待。";
    const details = document.createElement("details");
    details.open = this.nativeSelectionOpen;
    details.addEventListener("toggle", () => { this.nativeSelectionOpen = details.open; });
    const summary = document.createElement("summary");
    summary.textContent = `原生分块：已选 ${units.filter((unit) => this.selectedNativeUnitKeys.has(this.nativeUnitKey(unit))).length} / ${units.length}`;
    const list = document.createElement("div");
    list.className = "production-native-unit-list";
    for (const unit of units) {
      const label = document.createElement("label");
      label.className = "production-native-unit";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = this.selectedNativeUnitKeys.has(this.nativeUnitKey(unit));
      checkbox.disabled = this.previewLoading || this.submitLoading;
      checkbox.setAttribute("aria-label", `选择原生 ${unit.unitKind} ${unit.unitId} · ${this.publicLayerLabel(unit.layerId)}`);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) this.selectedNativeUnitKeys.add(this.nativeUnitKey(unit));
        else this.selectedNativeUnitKeys.delete(this.nativeUnitKey(unit));
        this.clearDownloadPreview();
        this.nativeSelectionOpen = true;
        this.renderInspector();
      });
      const copy = document.createElement("span");
      copy.textContent = `${unit.unitKind} ${unit.unitId} · ${this.publicLayerLabel(unit.layerId)}`;
      label.append(checkbox, copy);
      list.append(label);
    }
    details.append(summary, list);
    section.append(note, details);
    return section;
  }

  private displayFileName(relativePath: string): string {
    return relativePath.split(/[\\/]/).filter(Boolean).at(-1) || "未命名文件";
  }

  private downloadSelectionForContext(): RegionDownloadSelection | undefined {
    const context = this.context;
    if (!context) return undefined;
    const publicLayerIds = [...new Set((context.sourceIds ?? []).flatMap((sourceId) => {
      const layerId = assetsLayerIdForIdentity(parsePublicSourceId(sourceId));
      return layerId ? [layerId] : [];
    }))].sort();
    if (!publicLayerIds.length) return undefined;
    const allowed = new Set(publicLayerIds);
    const supplied = context.downloadSelection;
    if (supplied) {
      const layerIds = [...new Set(supplied.layerIds.filter((layerId) => allowed.has(layerId)))].sort();
      if (!layerIds.length) return undefined;
      const units = supplied.units?.filter((unit) => allowed.has(unit.layerId) && this.selectedNativeUnitKeys.has(this.nativeUnitKey(unit))).slice(0, 128);
      if (supplied.units?.length && !units?.length) return undefined;
      return {
        ...supplied,
        layerIds,
        units,
      };
    }
    return { layerIds: publicLayerIds, order: Math.log2(context.nside), cells: [...context.pixels] };
  }

  private selectedFiles(): RegionDownloadPreview["inventory"]["files"] {
    if (!this.downloadPreview) return [];
    const seen = new Set<string>();
    return this.downloadPreview.inventory.files.filter((file) => {
      if (!this.selectedDownloadUrls.has(file.url) || seen.has(file.url)) return false;
      seen.add(file.url);
      return true;
    });
  }

  private selectDefaultDownloadFiles(preview: RegionDownloadPreview): void {
    this.selectedDownloadUrls.clear();
    for (const file of preview.inventory.files) {
      if (this.selectedDownloadUrls.size >= preview.limits.maxFiles) break;
      if (this.selectedDownloadUrls.has(file.url)) continue;
      this.selectedDownloadUrls.add(file.url);
    }
  }

  private isPreviewExpired(preview: RegionDownloadPreview): boolean {
    const expiry = Date.parse(preview.expiresAt);
    return Number.isFinite(expiry) && expiry <= Date.now();
  }

  private downloadConfirmationProblem(): string | undefined {
    const preview = this.downloadPreview;
    if (!preview) return "请先预览公开文件清单";
    if (this.previewExpired || this.isPreviewExpired(preview)) return "预览已过期，请重新预览";
    if (this.previewLoading) return "正在刷新文件预览";
    const files = this.selectedFiles();
    if (!files.length) return "请至少选择一个文件";
    if (files.length > preview.limits.maxFiles) return `选择数量超过 ${preview.limits.maxFiles} 个文件的上限`;
    return undefined;
  }

  private clearDownloadPreview(): void {
    this.previewRequestId += 1;
    this.previewController?.abort();
    this.previewController = null;
    this.previewPanelOpen = false;
    this.previewStopped = false;
    this.previewProgress = null;
    this.partialPreviewFiles.clear();
    this.partialPreviewUnavailable = [];
    if (this.previewExpiryTimer) clearTimeout(this.previewExpiryTimer);
    this.previewExpiryTimer = null;
    this.downloadPreview = null;
    this.selectedDownloadUrls.clear();
    this.visibleDownloadFileCounts.clear();
    this.downloadSelectionNotice = null;
    this.previewError = null;
    this.previewLoading = false;
    this.previewExpired = false;
  }

  private stopDownloadPreview(): void {
    if (!this.previewLoading) return;
    this.previewRequestId++;
    this.previewController?.abort();
    this.previewController = null;
    this.previewLoading = false;
    this.previewStopped = true;
    this.selectedDownloadUrls.clear();
    if (this.active && this.selectedPipelineKey === "overlap-download@1") this.renderInspector();
  }

  private schedulePreviewExpiry(): void {
    if (this.previewExpiryTimer) clearTimeout(this.previewExpiryTimer);
    this.previewExpiryTimer = null;
    const preview = this.downloadPreview;
    if (!preview) return;
    const expiry = Date.parse(preview.expiresAt);
    if (!Number.isFinite(expiry)) return;
    const delay = expiry - Date.now();
    if (delay <= 0) {
      this.previewExpired = true;
      return;
    }
    this.previewExpiryTimer = setTimeout(() => {
      if (!this.downloadPreview || this.downloadPreview !== preview) return;
      if (Date.now() < expiry) this.schedulePreviewExpiry();
      else {
        this.previewExpired = true;
        if (this.active && this.selectedPipelineKey === "overlap-download@1") this.renderInspector();
      }
    }, Math.min(delay, 2_147_000_000));
  }

  private async refreshDownloadPreview(): Promise<void> {
    const selection = this.downloadSelectionForContext();
    if (!selection) throw new Error("当前区域没有可用的公开 sourceId/layerId");
    this.previewController?.abort();
    const controller = new AbortController();
    this.previewController = controller;
    this.previewPanelOpen = true;
    this.previewStopped = false;
    this.previewProgress = { stage: "lookup", completed: 0, files: 0, unavailable: 0 };
    this.partialPreviewFiles.clear();
    this.partialPreviewUnavailable = [];
    if (window.innerWidth <= 1040) byId("inspector-panel").classList.remove("mobile-open");
    const requestId = ++this.previewRequestId;
    const fingerprint = this.contextFingerprint;
    if (this.previewExpiryTimer) clearTimeout(this.previewExpiryTimer);
    this.previewExpiryTimer = null;
    this.downloadPreview = null;
    this.selectedDownloadUrls.clear();
    this.visibleDownloadFileCounts.clear();
    this.downloadSelectionNotice = null;
    this.previewExpired = false;
    this.previewLoading = true;
    this.previewError = null;
    if (this.active && this.selectedPipelineKey === "overlap-download@1") this.renderInspector();
    try {
      const preview = await workspaceApi.previewRegionDownload(selection, {
        signal: controller.signal,
        onUpdate: (event) => {
          if (requestId !== this.previewRequestId || fingerprint !== this.contextFingerprint || controller.signal.aborted) return;
          if (event.event === "progress") this.previewProgress = event.value;
          else {
            for (const file of event.value.files) this.partialPreviewFiles.set(file.url, file);
            const unavailable = new Map([...this.partialPreviewUnavailable, ...event.value.unavailable].map((item) => [JSON.stringify([item.layerId, item.unitId, item.reason]), item]));
            this.partialPreviewUnavailable = [...unavailable.values()];
          }
          if (this.active && this.selectedPipelineKey === "overlap-download@1") this.renderPreviewWorkspace();
        },
      });
      if (requestId !== this.previewRequestId || fingerprint !== this.contextFingerprint) return;
      this.downloadPreview = preview;
      this.selectDefaultDownloadFiles(preview);
      this.visibleDownloadFileCounts.clear();
      this.previewExpired = this.isPreviewExpired(preview);
      this.schedulePreviewExpiry();
    } catch (error) {
      if (requestId !== this.previewRequestId || fingerprint !== this.contextFingerprint) return;
      this.previewError = error instanceof Error ? error.message : String(error);
    } finally {
      if (requestId === this.previewRequestId) {
        this.previewLoading = false;
        this.previewController = null;
        if (this.active && this.selectedPipelineKey === "overlap-download@1") this.renderInspector();
      }
    }
  }

  private async confirmDownload(): Promise<void> {
    if (this.submitLoading) return;
    const problem = this.downloadConfirmationProblem();
    if (problem) throw new Error(problem);
    const context = this.context;
    const preview = this.downloadPreview;
    if (!context || !preview) throw new Error("请先预览公开文件清单");
    const pipeline = this.selectedPipeline();
    if (!pipeline || pipeline.key !== "overlap-download@1") throw new Error("下载流水线当前不可用");
    const selectedFiles = this.selectedFiles();
    const draft = this.draftForKey(pipeline.key);
    const publicDownload: RegionDownloadConfirmation = {
      selection: preview.selection,
      previewSha256: preview.planSha256,
      selectedFileUrls: selectedFiles.map((file) => file.url),
    };
    const region: RegionSnapshot = {
      coordinateFrame: "ICRS", ordering: "NESTED", nside: context.nside,
      pixels: context.pixels, sourceIds: context.sourceIds ?? [],
      ...(context.componentId ? { componentId: context.componentId } : {}), createdAt: new Date().toISOString(),
    };
    const input: ProductionRunInput = {
      pipelineKey: pipeline.key,
      region,
      publicDownload,
      exportFormat: String(draft.exportFormat ?? "json") as "json" | "csv",
      crawlerId: String(draft.crawlerId ?? "builtin-http"),
      concurrency: Number(draft.concurrency ?? 4),
      warehouseHandoff: "none",
      ...(draft.storageConnectorId ? { storageConnectorId: String(draft.storageConnectorId) } : {}),
    };
    this.submitLoading = true;
    if (this.active && this.selectedPipelineKey === "overlap-download@1") this.renderInspector();
    try {
      const run = await workspaceApi.submitProductionRun(input);
      this.submitLoading = false;
      this.clearDownloadPreview();
      this.runs = [run, ...this.runs.filter((candidate) => candidate.id !== run.id)];
      this.selectedRunId = run.id;
      this.selectedNodeId = null;
      this.renderAll();
      this.revealInspector();
      notifyWorkspace("已确认下载文件", `${selectedFiles.length} 个文件 · ${pipeline.title} · ${run.id}`, { tone: "success" });
      this.schedulePoll(100);
    } catch (error) {
      this.submitLoading = false;
      if (this.active && this.selectedPipelineKey === "overlap-download@1") this.renderInspector();
      throw error;
    }
  }

  private renderCrossmatchFields(root: HTMLElement, pipeline: ProductionPipelineDefinition, draft: Record<string, unknown>): void {
    const queryable = this.assets.filter((asset) => asset.kind === "catalog" && Boolean(asset.scanSpec?.raColumn && asset.scanSpec?.decColumn && asset.scanSpec?.objectIdColumn));
    const assetControl = (id: string, labelText: string, key: "leftAssetId" | "rightAssetId"): HTMLLabelElement => {
      const label = document.createElement("label");
      label.className = "field-label";
      label.textContent = labelText;
      const select = document.createElement("select");
      select.id = id;
      select.className = "field-input";
      select.append(new Option("请选择资产", ""), ...queryable.map((asset) => new Option(`${asset.name} · ${asset.id.slice(-8)}`, asset.id)));
      select.value = String(draft[key] ?? "");
      select.addEventListener("change", () => { draft[key] = select.value; this.renderInspector(); });
      label.append(select);
      return label;
    };
    root.append(assetControl("production-left-asset", "左表资产", "leftAssetId"), assetControl("production-right-asset", "右表资产", "rightAssetId"));
    pipeline.parameters.forEach((parameter) => root.append(this.parameterControl(parameter, draft, true)));
    const note = document.createElement("p");
    note.className = "control-note";
    note.textContent = "只显示具备 RA / Dec 对象索引的 catalog 资产；MOC-only 资产不能交叉匹配。";
    root.append(note);
  }

  private parameterControl(parameter: ProductionPipelineParameter, draft: Record<string, unknown>, editable: boolean): HTMLElement {
    const label = document.createElement("label");
    label.className = "field-label";
    label.textContent = parameter.label;
    let control: HTMLInputElement | HTMLSelectElement;
    if (parameter.type === "select") {
      const select = document.createElement("select");
      select.className = "field-input";
      select.replaceChildren(...(parameter.options ?? []).map((option) => new Option(option === "builtin-http" ? "内置 HTTP 爬虫" : option.toUpperCase(), option)));
      control = select;
    } else {
      const input = document.createElement("input");
      input.className = "field-input";
      input.type = parameter.type === "number" ? "number" : "text";
      if (parameter.key === "concurrency") { input.min = "1"; input.max = "16"; input.step = "1"; }
      if (parameter.key === "matchRadiusArcsec") { input.min = "0.01"; input.max = "60"; input.step = "0.01"; }
      if (parameter.key === "limit") { input.min = "1"; input.max = "10000"; input.step = "1"; }
      control = input;
    }
    control.id = `production-${parameter.key.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`)}`;
    control.value = String(draft[parameter.key] ?? parameterValue(parameter));
    control.disabled = !editable;
    control.addEventListener("input", () => { draft[parameter.key] = parameter.type === "number" ? Number(control.value) : control.value; });
    label.htmlFor = control.id;
    label.append(control);
    return label;
  }

  private canSubmit(pipeline: ProductionPipelineDefinition, draft: Record<string, unknown>): boolean {
    if (pipeline.availability !== "available" || !this.context) return false;
    if (pipeline.key === "overlap-download@1") return this.hasExecutablePublicSource();
    if (pipeline.key === "object-crossmatch@1") return Boolean(draft.leftAssetId && draft.rightAssetId && draft.leftAssetId !== draft.rightAssetId);
    return false;
  }

  private hasExecutablePublicSource(): boolean {
    return Boolean(this.downloadSelectionForContext());
  }

  private async submit(): Promise<void> {
    const pipeline = this.selectedPipeline();
    const context = this.context;
    if (!pipeline || !context) throw new Error("请先从数据覆盖页附加一个天区");
    const draft = this.draftForKey(pipeline.key);
    if (!this.canSubmit(pipeline, draft)) throw new Error("请补齐流水线输入后再执行");
    const region: RegionSnapshot = {
      coordinateFrame: "ICRS", ordering: "NESTED", nside: context.nside,
      pixels: context.pixels, sourceIds: context.sourceIds ?? [],
      ...(context.componentId ? { componentId: context.componentId } : {}), createdAt: new Date().toISOString(),
    };
    const input = pipeline.key === "overlap-download@1"
      ? {
          pipelineKey: pipeline.key, region, ...(context.files?.length ? { files: context.files } : {}),
          exportFormat: String(draft.exportFormat ?? "json") as "json" | "csv",
          crawlerId: String(draft.crawlerId ?? "builtin-http"), concurrency: Number(draft.concurrency ?? 4),
          warehouseHandoff: draft.warehouseHandoff === "submit" ? "submit" as const : "none" as const,
          ...(draft.storageConnectorId ? { storageConnectorId: String(draft.storageConnectorId) } : {}),
        }
      : {
          pipelineKey: pipeline.key, region, leftAssetId: String(draft.leftAssetId ?? ""),
          rightAssetId: String(draft.rightAssetId ?? ""), matchRadiusArcsec: Number(draft.matchRadiusArcsec ?? 1.5),
          limit: Number(draft.limit ?? 10_000),
        };
    const run = await workspaceApi.submitProductionRun(input);
    this.runs = [run, ...this.runs.filter((candidate) => candidate.id !== run.id)];
    this.selectedRunId = run.id;
    this.selectedNodeId = null;
    this.renderAll();
    this.revealInspector();
    notifyWorkspace("数据生产任务已提交", `${pipeline.title} · ${run.id}`, { tone: "success" });
    this.schedulePoll(100);
  }

  private async refreshRuns(): Promise<void> { this.runs = await workspaceApi.productionRuns(); }

  private renderStatus(): void {
    const badge = byId("production-status-badge");
    badge.dataset.status = this.selectedRun?.status ?? "idle";
    badge.textContent = this.selectedRun ? STATUS_LABELS[this.selectedRun.status] ?? this.selectedRun.status : "模板";
    byId("production-return-template").hidden = !this.selectedRun;
    const executors = new Set<string>();
    this.runs.forEach((run) => {
      const crawler = run.input?.crawlerId;
      if (typeof crawler === "string" && crawler.trim()) executors.add(crawler === "builtin-http" ? "HTTP" : crawler);
      else if (run.pipelineKey === "object-crossmatch@1") executors.add("INDEX");
    });
    this.onSummary({
      templates: this.pipelines.length, runs: this.runs.length,
      activeRuns: this.runs.filter((run) => run.status === "queued" || run.status === "running" || run.status === "resolving" || run.status === "awaiting-approval").length,
      succeededRuns: this.runs.filter((run) => run.status === "succeeded").length,
      artifacts: this.runs.reduce((count, run) => count + run.artifacts.length, 0),
      executors: executors.size ? [...executors].sort().join(" + ") : "--",
    });
  }

  private async cancel(run: ProductionRun): Promise<void> {
    try {
      const cancelled = await workspaceApi.cancelProductionRun(run.id);
      this.runs = this.runs.map((candidate) => candidate.id === run.id ? cancelled : candidate);
      this.selectedRunId = cancelled.id;
      this.renderAll();
    } catch (error) { this.showError(error); }
  }

  private async approve(run: ProductionRun): Promise<void> {
    const planSha256 = run.approval?.planSha256;
    if (!planSha256) throw new Error("该任务没有待审批的清单指纹");
    try {
      const approved = await workspaceApi.approveProductionRun(run.id, planSha256);
      this.runs = this.runs.map((candidate) => candidate.id === run.id ? approved : candidate);
      this.selectedRunId = approved.id;
      this.renderAll();
      const dialog = byId<HTMLDialogElement>("production-run-dialog");
      if (dialog.open) this.renderRunDialog(approved);
      notifyWorkspace("下载清单已批准", `${shortId(run.id)} 开始传输`, { tone: "success" });
      this.schedulePoll(100);
    } catch (error) { this.showError(error, "批准失败"); }
  }

  private async reject(run: ProductionRun): Promise<void> {
    try {
      const rejected = await workspaceApi.rejectProductionRun(run.id);
      this.runs = this.runs.map((candidate) => candidate.id === run.id ? rejected : candidate);
      this.selectedRunId = rejected.id;
      this.renderAll();
      const dialog = byId<HTMLDialogElement>("production-run-dialog");
      if (dialog.open) this.renderRunDialog(rejected);
    } catch (error) { this.showError(error, "拒绝清单失败"); }
  }

  private async retry(run: ProductionRun): Promise<void> {
    try {
      const retried = await workspaceApi.retryProductionRun(run.id);
      this.runs = [retried, ...this.runs];
      this.selectedRunId = retried.id;
      this.selectedNodeId = null;
      this.renderAll();
      byId<HTMLDialogElement>("production-run-dialog").close();
      this.revealInspector();
      this.schedulePoll(100);
    } catch (error) { this.showError(error); }
  }

  private schedulePoll(delay: number): void {
    if (!this.active) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(async () => {
      try {
        await this.refreshRuns();
        if (!this.active) return;
        const selectionCleared = this.syncSelectedRun();
        this.renderDag();
        this.renderLogs();
        if (this.selectedRun || selectionCleared) this.renderInspector();
        this.renderStatus();
        const dialog = byId<HTMLDialogElement>("production-run-dialog");
        if (selectionCleared) dialog.close();
        else if (dialog.open && this.selectedRun) this.renderRunDialog(this.selectedRun);
        if (this.runs.some((run) => run.status === "queued" || run.status === "running" || run.status === "resolving" || run.status === "awaiting-approval")) this.schedulePoll(800);
      } catch (error) { this.showError(error); }
    }, delay);
  }

  private showError(error: unknown, title = "数据生产操作失败"): void {
    const message = error instanceof Error ? error.message : String(error);
    notifyWorkspace(title, message, { tone: "error" });
    this.onError(error);
  }
}
