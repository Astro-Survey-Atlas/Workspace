import {
  ArrowRight, BrainCircuit, Circle, createIcons, Crop, Database, Download,
  FileOutput, GitCompareArrows, Info, MapPinned, PackageCheck, PlugZap,
  WandSparkles, X,
} from "lucide";

import { workspaceApi, type CoverageDownloadFile, type DataAssetRecord } from "./api";
import type {
  ProductionPipelineDefinition, ProductionPipelineParameter, ProductionRun,
  RegionSnapshot,
} from "../../src/production";
import type { ConnectorPublicRecord } from "../../src/connectors";
import { notifyWorkspace } from "./notifications";

export interface ProductionContext {
  nside: number;
  pixels: number[];
  sourceIds?: string[];
  componentId?: string;
  assetIds?: string[];
  files?: CoverageDownloadFile[];
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
  pending: "等待执行", queued: "排队中", running: "执行中", succeeded: "已完成",
  failed: "失败", cancelled: "已取消", skipped: "已跳过",
};

const PIPELINE_ICONS: Record<string, string> = {
  "overlap-download@1": "download",
  "object-crossmatch@1": "git-compare-arrows",
  "training-data-preparation@1": "brain-circuit",
};

const NODE_ICONS: Record<string, string> = {
  region: "map-pinned", download: "download", connector: "plug-zap",
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
      GitCompareArrows, Info, MapPinned, PackageCheck, PlugZap, WandSparkles, X,
    },
    attrs: { "aria-hidden": "true" },
  });
}

function shortId(value: string): string {
  return value.length > 22 ? `${value.slice(0, 13)}…${value.slice(-6)}` : value;
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = value;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) { amount /= 1024; index += 1; }
  return `${amount >= 10 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}

function parameterValue(parameter: ProductionPipelineParameter): string | number {
  return parameter.defaultValue ?? (parameter.type === "number" ? 0 : parameter.options?.[0] ?? "");
}

function defaultNodeId(run: ProductionRun | null, pipeline: ProductionPipelineDefinition): string | null {
  if (!run) return pipeline.dag[0]?.id ?? null;
  return run.steps.find((step) => step.status === "failed")?.id
    ?? run.steps.find((step) => step.status === "running")?.id
    ?? [...run.steps].reverse().find((step) => step.status === "succeeded")?.id
    ?? run.steps[0]?.id
    ?? pipeline.dag[0]?.id
    ?? null;
}

export class ProductionPanel {
  private pipelines: ProductionPipelineDefinition[] = [];
  private runs: ProductionRun[] = [];
  private assets: DataAssetRecord[] = [];
  private connectors: ConnectorPublicRecord[] = [];
  private initialized = false;
  private active = false;
  private context: ProductionContext | null = null;
  private selectedRun: ProductionRun | null = null;
  private selectedPipelineKey: string | null = null;
  private selectedNodeId: string | null = null;
  private nodeLogVisible = false;
  private requestedPipelineKey: string | null = null;
  private readonly drafts = new Map<string, Record<string, unknown>>();
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private resolvingContext: ProductionContext | null = null;

  constructor(
    private readonly onError: (error: unknown) => void,
    private readonly onSummary: (summary: ProductionSummary) => void,
    private readonly renderInspectorView: (view: ProductionInspectorView | null) => void,
  ) {
    const dialog = byId<HTMLDialogElement>("production-run-dialog");
    byId<HTMLButtonElement>("production-run-dialog-close").addEventListener("click", () => dialog.close());
    byId<HTMLButtonElement>("production-run-dialog-dismiss").addEventListener("click", () => dialog.close());
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
  }

  setContext(context: ProductionContext | null, pipelineKey?: string): void {
    this.context = context ? {
      ...context,
      pixels: [...new Set(context.pixels)].sort((left, right) => left - right),
      sourceIds: [...new Set(context.sourceIds ?? [])],
      assetIds: [...new Set(context.assetIds ?? [])],
      files: context.files ? [...context.files] : undefined,
    } : null;
    if (pipelineKey) this.requestedPipelineKey = pipelineKey;
    const targetKey = pipelineKey ?? this.selectedPipelineKey;
    if (this.context?.assetIds?.length && targetKey === "object-crossmatch@1") {
      const draft = this.draftForKey(targetKey);
      draft.leftAssetId = this.context.assetIds[0] ?? draft.leftAssetId;
      draft.rightAssetId = this.context.assetIds[1] ?? draft.rightAssetId;
    }
    if (this.initialized && pipelineKey) this.selectPipeline(pipelineKey);
    else if (this.initialized) this.renderAll();
    if (this.active && this.context && targetKey === "overlap-download@1" && this.context.files === undefined) void this.resolveFiles();
  }

  async activate(): Promise<void> {
    this.active = true;
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
    if (this.context && this.selectedPipelineKey === "overlap-download@1" && this.context.files === undefined) void this.resolveFiles();
    if (this.runs.some((run) => run.status === "queued" || run.status === "running")) this.schedulePoll(400);
  }

  deactivate(): void {
    this.active = false;
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
      productionNodeLogVisible: this.nodeLogVisible,
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

  private runsForPipeline(pipelineKey = this.selectedPipelineKey): ProductionRun[] {
    return pipelineKey ? this.runs.filter((run) => run.pipelineKey === pipelineKey) : [];
  }

  private selectPipeline(pipelineKey: string): void {
    const pipeline = this.pipelines.find((candidate) => candidate.key === pipelineKey);
    if (!pipeline) return;
    this.selectedPipelineKey = pipeline.key;
    this.draftForKey(pipeline.key);
    if (this.context?.assetIds?.length && pipeline.key === "object-crossmatch@1") {
      const draft = this.draftForKey(pipeline.key);
      draft.leftAssetId ??= this.context.assetIds[0];
      draft.rightAssetId ??= this.context.assetIds[1];
    }
    this.selectedRun = this.runsForPipeline(pipeline.key)[0] ?? null;
    this.selectedNodeId = defaultNodeId(this.selectedRun, pipeline);
    this.nodeLogVisible = false;
    this.renderAll();
    if (this.active && pipeline.key === "overlap-download@1" && this.context && this.context.files === undefined) void this.resolveFiles();
  }

  private selectRun(run: ProductionRun): void {
    this.selectedRun = run;
    const pipeline = this.selectedPipeline();
    this.selectedNodeId = pipeline ? defaultNodeId(run, pipeline) : null;
    this.nodeLogVisible = false;
    this.renderDag();
    this.renderLogs();
    this.renderStatus();
  }

  private syncSelectedRun(): void {
    const selected = this.selectedRun ? this.runs.find((run) => run.id === this.selectedRun?.id) : undefined;
    this.selectedRun = selected ?? this.runsForPipeline()[0] ?? null;
    const pipeline = this.selectedPipeline();
    if (pipeline && (!this.selectedNodeId || !pipeline.dag.some((node) => node.id === this.selectedNodeId))) {
      this.selectedNodeId = defaultNodeId(this.selectedRun, pipeline);
    }
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
    const list = byId("production-dag-list");
    const empty = byId("production-dag-empty");
    const pipeline = this.selectedPipeline();
    list.replaceChildren();
    empty.hidden = Boolean(pipeline);
    if (!pipeline) return;
    byId("production-dag-heading").textContent = `${pipeline.title} · DAG`;
    byId("production-dag-count").textContent = `${pipeline.dag.length} NODES`;
    const statuses = new Map((this.selectedRun?.steps ?? []).map((step) => [step.id, step.status]));
    pipeline.dag.forEach((node, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "production-dag-node";
      button.dataset.nodeId = node.id;
      const status = statuses.get(node.id) ?? "pending";
      button.dataset.status = status;
      const logSelected = this.nodeLogVisible && node.id === this.selectedNodeId;
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
      button.addEventListener("click", () => {
        this.selectedNodeId = node.id;
        this.nodeLogVisible = true;
        this.renderDag();
        this.renderLogs();
      });
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
    const pipeline = this.selectedPipeline();
    const runs = this.runsForPipeline();
    const list = byId("production-run-list");
    byId("production-run-count").textContent = String(runs.length);
    byId("production-run-empty").hidden = runs.length > 0;
    list.replaceChildren(...runs.map((run) => {
      const row = document.createElement("div");
      row.className = "production-run-row";
      const select = document.createElement("button");
      select.type = "button";
      select.className = "production-run-chip";
      select.dataset.status = run.status;
      select.classList.toggle("active", run.id === this.selectedRun?.id);
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

    const detail = byId("production-log-detail");
    detail.replaceChildren();
    detail.hidden = !this.nodeLogVisible;
    renderIcons();
    if (!pipeline || !this.nodeLogVisible) return;
    const node = pipeline.dag.find((candidate) => candidate.id === this.selectedNodeId) ?? pipeline.dag[0];
    const step = node ? this.selectedRun?.steps.find((candidate) => candidate.id === node.id) : undefined;
    const heading = document.createElement("div");
    heading.className = "production-log-heading";
    const headingCopy = document.createElement("div");
    const kicker = document.createElement("span");
    kicker.textContent = this.selectedRun ? shortId(this.selectedRun.id) : "NO RUN SELECTED";
    const title = document.createElement("strong");
    title.textContent = node ? `${node.title} · 节点日志` : "节点日志";
    headingCopy.append(kicker, title);
    const badge = document.createElement("span");
    badge.className = "run-status";
    badge.dataset.status = step?.status ?? this.selectedRun?.status ?? "idle";
    badge.textContent = STATUS_LABELS[step?.status ?? this.selectedRun?.status ?? "idle"] ?? "IDLE";
    heading.append(headingCopy, badge);
    detail.append(heading);

    if (!this.selectedRun) {
      const empty = document.createElement("p");
      empty.className = "production-log-empty";
      empty.textContent = "执行流水线后，可在这里按节点查看持久化日志。";
      detail.append(empty);
      return;
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
    renderIcons();
  }

  private runResultLabel(run: ProductionRun): string {
    if (run.summary.downloadedFiles !== undefined) {
      return `${String(run.summary.downloadedFiles)}/${String(run.summary.files ?? "?")} files · ${formatBytes(Number(run.summary.downloadedBytes ?? 0))}`;
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
    if ((run.status === "queued" || run.status === "running") && run.pipelineKey === "overlap-download@1") {
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

  private renderInspector(): void {
    const pipeline = this.selectedPipeline();
    if (!pipeline) { this.renderInspectorView(null); return; }
    const draft = this.draftForKey(pipeline.key);
    const body = document.createElement("div");
    body.className = "production-inspector-body";
    const description = document.createElement("p");
    description.className = "inspector-summary";
    description.textContent = pipeline.description;
    body.append(description, this.contextSection());

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
    const execute = document.createElement("button");
    execute.id = "production-execute";
    execute.type = "button";
    execute.className = "primary-command";
    execute.textContent = pipeline.availability === "planned" ? "尚未开放" : "执行流水线";
    execute.disabled = !this.canSubmit(pipeline, draft);
    execute.title = !this.context ? "必须先从数据覆盖页附加天区上下文" : execute.disabled ? "请补齐流水线输入" : "使用当前参数创建一条执行记录";
    execute.addEventListener("click", () => void this.submit().catch((error) => this.showError(error)));
    this.renderInspectorView({ kicker: "PIPELINE TEMPLATE", title: pipeline.title, rows, body, actions: [execute] });
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
    const files = document.createElement("p");
    files.id = "production-files-summary";
    files.className = "control-note";
    files.textContent = this.context?.files === undefined
      ? this.context ? "正在反查天区内可下载文件…" : "等待天区上下文"
      : this.context.files.length ? `${this.context.files.length} 个可下载文件已反查` : "该天区没有可下载文件";
    root.append(files);
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
    if (pipeline.key === "overlap-download@1") return Boolean(this.context.files?.length);
    if (pipeline.key === "object-crossmatch@1") return Boolean(draft.leftAssetId && draft.rightAssetId && draft.leftAssetId !== draft.rightAssetId);
    return false;
  }

  private async resolveFiles(): Promise<void> {
    const context = this.context;
    if (!context || context.files !== undefined || this.resolvingContext === context) return;
    this.resolvingContext = context;
    this.renderInspector();
    try {
      const lookup = await workspaceApi.skyReverseLookup({
        componentId: context.componentId, sourceIds: context.sourceIds, assetIds: context.assetIds,
        pixels: context.pixels, nside: context.nside,
      });
      if (this.context === context) {
        this.context = { ...context, files: lookup.files };
        this.renderInspector();
      }
    } catch (error) {
      this.showError(error, "天区文件反查失败");
      if (this.context === context) {
        this.context = { ...context, files: [] };
        this.renderInspector();
      }
    } finally {
      if (this.resolvingContext === context) this.resolvingContext = null;
    }
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
          pipelineKey: pipeline.key, region, files: context.files ?? [],
          exportFormat: String(draft.exportFormat ?? "json") as "json" | "csv",
          crawlerId: String(draft.crawlerId ?? "builtin-http"), concurrency: Number(draft.concurrency ?? 4),
          ...(draft.storageConnectorId ? { storageConnectorId: String(draft.storageConnectorId) } : {}),
        }
      : {
          pipelineKey: pipeline.key, region, leftAssetId: String(draft.leftAssetId ?? ""),
          rightAssetId: String(draft.rightAssetId ?? ""), matchRadiusArcsec: Number(draft.matchRadiusArcsec ?? 1.5),
          limit: Number(draft.limit ?? 10_000),
        };
    const run = await workspaceApi.submitProductionRun(input);
    this.runs = [run, ...this.runs.filter((candidate) => candidate.id !== run.id)];
    this.selectedRun = run;
    this.selectedNodeId = defaultNodeId(run, pipeline);
    this.nodeLogVisible = false;
    this.renderAll();
    notifyWorkspace("数据生产任务已提交", `${pipeline.title} · ${run.id}`, { tone: "success" });
    this.schedulePoll(100);
  }

  private async refreshRuns(): Promise<void> { this.runs = await workspaceApi.productionRuns(); }

  private renderStatus(): void {
    const badge = byId("production-status-badge");
    badge.dataset.status = this.selectedRun?.status ?? "idle";
    badge.textContent = this.selectedRun ? STATUS_LABELS[this.selectedRun.status] ?? this.selectedRun.status : "IDLE";
    const executors = new Set<string>();
    this.runs.forEach((run) => {
      const crawler = run.input?.crawlerId;
      if (typeof crawler === "string" && crawler.trim()) executors.add(crawler === "builtin-http" ? "HTTP" : crawler);
      else if (run.pipelineKey === "object-crossmatch@1") executors.add("INDEX");
    });
    this.onSummary({
      templates: this.pipelines.length, runs: this.runs.length,
      activeRuns: this.runs.filter((run) => run.status === "queued" || run.status === "running").length,
      succeededRuns: this.runs.filter((run) => run.status === "succeeded").length,
      artifacts: this.runs.reduce((count, run) => count + run.artifacts.length, 0),
      executors: executors.size ? [...executors].sort().join(" + ") : "--",
    });
  }

  private async cancel(run: ProductionRun): Promise<void> {
    try {
      const cancelled = await workspaceApi.cancelProductionRun(run.id);
      this.runs = this.runs.map((candidate) => candidate.id === run.id ? cancelled : candidate);
      this.selectedRun = cancelled;
      this.renderAll();
    } catch (error) { this.showError(error); }
  }

  private async retry(run: ProductionRun): Promise<void> {
    try {
      const retried = await workspaceApi.retryProductionRun(run.id);
      this.runs = [retried, ...this.runs];
      this.selectedRun = retried;
      const pipeline = this.selectedPipeline();
      this.selectedNodeId = pipeline ? defaultNodeId(retried, pipeline) : null;
      this.nodeLogVisible = false;
      this.renderAll();
      this.schedulePoll(100);
    } catch (error) { this.showError(error); }
  }

  private schedulePoll(delay: number): void {
    if (!this.active) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(async () => {
      try {
        await this.refreshRuns();
        this.syncSelectedRun();
        this.renderAll();
        if (this.runs.some((run) => run.status === "queued" || run.status === "running")) this.schedulePoll(800);
      } catch (error) { this.showError(error); }
    }, delay);
  }

  private showError(error: unknown, title = "数据生产操作失败"): void {
    const message = error instanceof Error ? error.message : String(error);
    notifyWorkspace(title, message, { tone: "error" });
    this.onError(error);
  }
}
