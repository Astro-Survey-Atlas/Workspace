import { workspaceApi, type DataAssetRecord, type CoverageDownloadFile } from "./api";
import type {
  ProductionPipelineDefinition,
  ProductionPipelineParameter,
  ProductionPipelinePreset,
  ProductionRun,
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
  instances: number;
  runs: number;
  activeRuns: number;
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

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing production element: ${id}`);
  return element as T;
}

const STATUS_LABELS: Record<string, string> = {
  queued: "排队中",
  running: "执行中",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

function shortId(value: string): string { return value.length > 22 ? `${value.slice(0, 13)}…${value.slice(-6)}` : value; }

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

export class ProductionPanel {
  private pipelines: ProductionPipelineDefinition[] = [];
  private presets: ProductionPipelinePreset[] = [];
  private runs: ProductionRun[] = [];
  private assets: DataAssetRecord[] = [];
  private connectors: ConnectorPublicRecord[] = [];
  private initialized = false;
  private active = false;
  private context: ProductionContext | null = null;
  private selectedRun: ProductionRun | null = null;
  private selectedPipelineKey: string | null = null;
  private selectedPresetId: string | null = null;
  private requestedPipelineKey: string | null = null;
  private draftTitle = "";
  private draftConfig: Record<string, unknown> = {};
  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly onError: (error: unknown) => void,
    private readonly onSummary: (summary: ProductionSummary) => void,
    private readonly renderInspectorView: (view: ProductionInspectorView | null) => void,
  ) {
    byId<HTMLButtonElement>("production-new").addEventListener("click", () => this.openDialog());
    byId<HTMLButtonElement>("production-dialog-close").addEventListener("click", () => byId<HTMLDialogElement>("production-create-dialog").close());
    byId<HTMLButtonElement>("production-form-cancel").addEventListener("click", () => byId<HTMLDialogElement>("production-create-dialog").close());
    byId<HTMLSelectElement>("production-pipeline-select").addEventListener("change", () => {
      const selectedKey = byId<HTMLSelectElement>("production-pipeline-select").value;
      if (selectedKey && selectedKey !== this.selectedPipelineKey) this.selectPipeline(selectedKey, null);
      else this.renderForm();
    });
    byId<HTMLSelectElement>("production-left-asset").addEventListener("change", () => this.renderForm());
    byId<HTMLSelectElement>("production-right-asset").addEventListener("change", () => this.renderForm());
    byId<HTMLFormElement>("production-form").addEventListener("submit", (event) => {
      event.preventDefault();
      void this.submit().catch((error) => this.showError(error));
    });
  }

  setContext(context: ProductionContext | null, pipelineKey?: string): void {
    this.context = context ? {
      ...context,
      pixels: [...new Set(context.pixels)].sort((left, right) => left - right),
      sourceIds: [...new Set(context.sourceIds ?? [])],
      assetIds: [...new Set(context.assetIds ?? [])],
    } : null;
    if (pipelineKey) {
      this.requestedPipelineKey = pipelineKey;
      this.selectPipeline(pipelineKey);
    }
  }

  async activate(): Promise<void> {
    this.active = true;
    if (!this.initialized) {
      [this.pipelines, this.presets, this.runs, this.assets, this.connectors] = await Promise.all([
        workspaceApi.productionPipelines(), workspaceApi.productionPresets(), workspaceApi.productionRuns(), workspaceApi.dataAssets(), workspaceApi.connectors(),
      ]);
      this.initialized = true;
      const requested = this.requestedPipelineKey ? this.pipelines.find((pipeline) => pipeline.key === this.requestedPipelineKey) : undefined;
      const first = requested ?? this.pipelines.find((pipeline) => pipeline.availability === "available") ?? this.pipelines[0];
      if (first) this.selectPipeline(first.key);
      this.requestedPipelineKey = null;
    } else {
      await Promise.all([this.refreshRuns(), this.refreshPresets()]);
      if (this.selectedPresetId && !this.presets.some((preset) => preset.id === this.selectedPresetId)) this.selectPipeline(this.selectedPipelineKey ?? undefined, null);
    }
    this.renderTemplates();
    this.renderInstances();
    this.renderDag();
    this.renderInspector();
    this.renderForm();
    if (this.context) this.openDialog(this.selectedPipelineKey ?? undefined);
    this.renderRuns();
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
      productionPresetId: this.selectedPresetId,
      productionPipelineKey: this.selectedPipelineKey,
    };
  }

  private selectPipeline(pipelineKey?: string, presetId?: string | null): void {
    const requested = pipelineKey ? this.pipelines.find((pipeline) => pipeline.key === pipelineKey) : undefined;
    const pipeline = requested ?? this.pipelines.find((candidate) => candidate.key === this.selectedPipelineKey) ?? this.pipelines[0];
    if (!pipeline) return;
    const preset = presetId === null ? undefined : this.presets.find((candidate) => candidate.id === (presetId ?? this.selectedPresetId) && candidate.pipelineKey === pipeline.key);
    this.selectedPipelineKey = pipeline.key;
    this.selectedPresetId = preset?.id ?? null;
    this.selectedRun = preset ? this.latestRunForPreset(preset.id) : null;
    this.draftTitle = preset?.title ?? pipeline.title;
    this.draftConfig = { ...Object.fromEntries(pipeline.parameters.map((parameter) => [parameter.key, parameterValue(parameter)])), ...(preset?.config ?? {}) };
    this.renderTemplates();
    this.renderInstances();
    this.renderDag();
    this.renderInspector();
    this.renderForm();
  }

  private openDialog(pipelineKey?: string): void {
    if (pipelineKey) {
      this.requestedPipelineKey = pipelineKey;
      this.selectPipeline(pipelineKey);
    }
    const select = byId<HTMLSelectElement>("production-pipeline-select");
    if (this.selectedPipelineKey && [...select.options].some((option) => option.value === this.selectedPipelineKey)) select.value = this.selectedPipelineKey;
    this.renderForm();
    const dialog = byId<HTMLDialogElement>("production-create-dialog");
    if (!dialog.open) dialog.showModal();
    if (this.context?.componentId && !this.context.files?.length) void this.resolveFiles();
  }

  private async resolveFiles(): Promise<void> {
    const context = this.context;
    if (!context?.componentId) return;
    try {
      const lookup = await workspaceApi.skyReverseLookup({ componentId: context.componentId, sourceIds: context.sourceIds, nside: context.nside, pixels: context.pixels });
      if (this.context === context) {
        this.context = { ...context, files: lookup.files };
        this.renderForm();
      }
    } catch (error) { this.showError(error, "重合区域文件反查失败"); }
  }

  private renderTemplates(): void {
    const list = byId("production-template-list");
    const availableCount = this.pipelines.filter((pipeline) => pipeline.availability === "available").length;
    byId("production-template-count").textContent = `${this.pipelines.length}`;
    byId("production-template-empty").hidden = this.pipelines.length > 0;
    list.replaceChildren(...this.pipelines.map((pipeline, index) => this.templateCard(pipeline, index + 1)));
    this.onSummary(this.summary(availableCount));
  }

  private templateCard(pipeline: ProductionPipelineDefinition, index: number): HTMLElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "production-template-card";
    button.dataset.availability = pipeline.availability;
    button.classList.toggle("active", this.selectedPipelineKey === pipeline.key && !this.selectedPresetId);
    const ordinal = document.createElement("span"); ordinal.className = "pipeline-card-index"; ordinal.textContent = String(index).padStart(2, "0");
    const title = document.createElement("strong"); title.textContent = pipeline.title;
    const detail = document.createElement("small"); detail.textContent = pipeline.availability === "planned" ? "规划中 · 仅可查看" : pipeline.description;
    const params = document.createElement("span"); params.className = "pipeline-hover-params";
    params.textContent = pipeline.parameters.length ? `参数：${pipeline.parameters.map((parameter) => `${parameter.label}=${String(parameterValue(parameter))}`).join(" · ")}` : "无可调整参数";
    button.title = params.textContent;
    button.append(ordinal, title, detail, params);
    button.addEventListener("click", () => this.selectPipeline(pipeline.key, null));
    return button;
  }

  private renderInstances(): void {
    const list = byId("production-instance-list");
    byId("production-instance-count").textContent = String(this.presets.length);
    byId("production-instance-empty").hidden = this.presets.length > 0;
    const ordered = [...this.presets].sort((left, right) => Number(right.pinned) - Number(left.pinned) || right.updatedAt.localeCompare(left.updatedAt));
    list.replaceChildren(...ordered.map((preset, index) => this.instanceCard(preset, index + 1)));
  }

  private instanceCard(preset: ProductionPipelinePreset, index: number): HTMLElement {
    const pipeline = this.pipelines.find((candidate) => candidate.key === preset.pipelineKey);
    const latest = this.latestRunForPreset(preset.id);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "production-instance-card";
    button.classList.toggle("active", this.selectedPresetId === preset.id);
    button.dataset.status = latest?.status ?? "idle";
    const ordinal = document.createElement("span"); ordinal.className = "pipeline-card-index"; ordinal.textContent = String(index).padStart(2, "0");
    const title = document.createElement("strong"); title.textContent = preset.title;
    const source = document.createElement("small"); source.textContent = `来源：${pipeline?.title ?? preset.pipelineKey}${preset.pinned ? " · 已置顶" : ""}`;
    const status = document.createElement("span"); status.className = "instance-card-status"; status.textContent = latest ? `最近执行：${STATUS_LABELS[latest.status] ?? latest.status}` : "尚未执行";
    button.append(ordinal, title, source, status);
    button.addEventListener("click", () => this.selectPipeline(preset.pipelineKey, preset.id));
    return button;
  }

  private latestRunForPreset(presetId: string): ProductionRun | null {
    return this.runs.find((run) => run.pipelinePresetId === presetId) ?? null;
  }

  private summary(_availableCount = this.pipelines.filter((pipeline) => pipeline.availability === "available").length): ProductionSummary {
    const executors = new Set<string>();
    this.runs.forEach((run) => {
      const crawler = run.input?.crawlerId;
      if (typeof crawler === "string" && crawler.trim()) executors.add(crawler === "builtin-http" ? "HTTP" : crawler);
      else if (run.pipelineKey === "object-crossmatch@1") executors.add("INDEX");
    });
    return {
      templates: this.pipelines.length,
      instances: this.presets.length,
      runs: this.runs.length,
      activeRuns: this.runs.filter((run) => run.status === "queued" || run.status === "running").length,
      artifacts: this.runs.reduce((count, run) => count + run.artifacts.length, 0),
      executors: executors.size ? [...executors].sort().join(" + ") : "--",
    };
  }

  private renderDag(): void {
    const list = byId("production-dag-list");
    const empty = byId("production-dag-empty");
    const pipeline = this.pipelines.find((candidate) => candidate.key === this.selectedPipelineKey);
    const preset = this.selectedPresetId ? this.presets.find((candidate) => candidate.id === this.selectedPresetId) : undefined;
    list.replaceChildren();
    empty.hidden = Boolean(pipeline);
    if (!pipeline) return;
    byId("production-dag-heading").textContent = `${preset?.title ?? pipeline.title} · DAG`;
    byId("production-dag-count").textContent = `${pipeline.dag.length} STEPS`;
    const stepStatuses = new Map((this.selectedRun?.steps ?? []).map((step) => [step.id, step.status]));
    pipeline.dag.forEach((node, index) => {
      const item = document.createElement("article"); item.className = "production-dag-node";
      const nodeStatus = stepStatuses.get(node.id);
      if (nodeStatus) item.dataset.status = nodeStatus;
      const number = document.createElement("span"); number.className = "dag-node-index"; number.textContent = String(index + 1).padStart(2, "0");
      const copy = document.createElement("div");
      const title = document.createElement("strong"); title.textContent = node.title;
      const description = document.createElement("small"); description.textContent = node.description;
      copy.append(title, description);
      if (node.dependsOn?.length) { const dependency = document.createElement("em"); dependency.textContent = `依赖 ${node.dependsOn.join("、")}`; copy.append(dependency); }
      if (nodeStatus) { const state = document.createElement("b"); state.className = "dag-node-status"; state.textContent = STATUS_LABELS[nodeStatus] ?? nodeStatus; copy.append(state); }
      item.append(number, copy);
      list.append(item);
      if (index < pipeline.dag.length - 1) { const connector = document.createElement("span"); connector.className = "dag-connector"; connector.setAttribute("aria-hidden", "true"); list.append(connector); }
    });
  }

  private renderInspector(): void {
    const pipeline = this.pipelines.find((candidate) => candidate.key === this.selectedPipelineKey);
    if (!pipeline) { this.renderInspectorView(null); return; }
    const preset = this.selectedPresetId ? this.presets.find((candidate) => candidate.id === this.selectedPresetId) : undefined;
    const body = document.createElement("div"); body.className = "production-inspector-body";
    const description = document.createElement("p"); description.className = "inspector-summary"; description.textContent = pipeline.description; body.append(description);
    const fields = document.createElement("div"); fields.className = "production-inspector-fields";
    if (preset) {
      const label = document.createElement("label"); label.className = "field-label"; label.textContent = "实例名称";
      const input = document.createElement("input"); input.className = "field-input"; input.value = this.draftTitle; input.maxLength = 120;
      input.addEventListener("input", () => { this.draftTitle = input.value; });
      label.append(input); fields.append(label);
    }
    const parameterHeading = document.createElement("div"); parameterHeading.className = "form-section-title"; parameterHeading.textContent = "流水线参数"; fields.append(parameterHeading);
    pipeline.parameters.forEach((parameter) => fields.append(this.parameterControl(parameter, Boolean(preset))));
    body.append(fields);
    const runHistory = this.renderRunHistory(pipeline.key, preset?.id);
    if (runHistory) body.append(runHistory);
    const rows: Array<[string, string]> = [
      ["状态", preset ? "用户实例" : pipeline.availability === "available" ? "可运行模板" : "规划中"],
      ["输入", pipeline.inputRequirements.join(" · ")],
      ["输出", pipeline.outputs.join(" · ")],
      ["DAG", `${pipeline.dag.length} steps`],
      ...(preset ? [["实例 ID", shortId(preset.id)], ["来源模板", pipeline.title]] as Array<[string, string]> : []),
    ];
    const actions: HTMLElement[] = [];
    if (preset) {
      const run = document.createElement("button"); run.type = "button"; run.className = "primary-command"; run.textContent = "执行实例"; run.disabled = pipeline.availability !== "available"; run.addEventListener("click", () => this.openDialog(pipeline.key)); actions.push(run);
      const save = document.createElement("button"); save.type = "button"; save.className = "command-button secondary"; save.textContent = "保存修改"; save.addEventListener("click", () => void this.savePreset().catch((error) => this.showError(error))); actions.push(save);
      const pin = document.createElement("button"); pin.type = "button"; pin.className = "command-button secondary"; pin.textContent = preset.pinned ? "取消置顶" : "固定置顶"; pin.addEventListener("click", () => void this.togglePin().catch((error) => this.showError(error))); actions.push(pin);
      const remove = document.createElement("button"); remove.type = "button"; remove.className = "command-button danger"; remove.textContent = "删除实例"; remove.addEventListener("click", () => void this.deletePreset().catch((error) => this.showError(error))); actions.push(remove);
    } else {
      const create = document.createElement("button"); create.type = "button"; create.className = "primary-command"; create.textContent = "从模板创建实例"; create.disabled = pipeline.availability !== "available"; create.addEventListener("click", () => void this.savePreset().catch((error) => this.showError(error))); actions.push(create);
    }
    this.renderInspectorView({ kicker: preset ? "PIPELINE INSTANCE" : "PIPELINE TEMPLATE", title: preset?.title ?? pipeline.title, rows, body, actions });
  }

  private parameterControl(parameter: ProductionPipelineParameter, editable: boolean): HTMLElement {
    const label = document.createElement("label"); label.className = "field-label"; label.textContent = parameter.label;
    let control: HTMLInputElement | HTMLSelectElement;
    if (parameter.type === "select") {
      const select = document.createElement("select"); select.className = "field-input"; select.replaceChildren(...(parameter.options ?? []).map((option) => new Option(option, option))); control = select;
    } else {
      const input = document.createElement("input"); input.className = "field-input"; input.type = parameter.type === "number" ? "number" : "text"; control = input;
    }
    const current = this.draftConfig[parameter.key] ?? parameterValue(parameter);
    control.value = String(current);
    control.disabled = !editable;
    control.addEventListener("change", () => { this.draftConfig[parameter.key] = parameter.type === "number" ? Number(control.value) : control.value; this.renderForm(); this.renderInspector(); });
    label.append(control); return label;
  }

  private renderRunHistory(pipelineKey: string, presetId?: string): HTMLElement | null {
    const runs = this.runs.filter((run) => run.pipelineKey === pipelineKey && (presetId ? run.pipelinePresetId === presetId : true));
    const section = document.createElement("section"); section.className = "production-inspector-runs";
    const heading = document.createElement("div"); heading.className = "section-heading";
    const label = document.createElement("span"); label.textContent = "执行记录";
    const count = document.createElement("output"); count.textContent = String(runs.length); heading.append(label, count); section.append(heading);
    if (!runs.length) { const empty = document.createElement("p"); empty.className = "production-inspector-empty"; empty.textContent = "暂无执行记录"; section.append(empty); return section; }
    const list = document.createElement("div"); list.className = "production-inspector-run-list";
    runs.slice(0, 8).forEach((run) => {
      const row = document.createElement("button"); row.type = "button"; row.className = "production-inspector-run"; row.classList.toggle("active", run.id === this.selectedRun?.id); row.dataset.status = run.status;
      const title = document.createElement("strong"); title.textContent = STATUS_LABELS[run.status] ?? run.status;
      const time = document.createElement("small"); time.textContent = new Date(run.createdAt).toLocaleString();
      const id = document.createElement("span"); id.textContent = shortId(run.id); id.title = run.id;
      row.append(title, time, id);
      row.addEventListener("click", () => { this.selectedRun = run; this.renderDag(); this.renderInspector(); });
      list.append(row);
    });
    section.append(list);
    if (this.selectedRun && runs.some((run) => run.id === this.selectedRun?.id)) section.append(this.renderSelectedRun(this.selectedRun));
    return section;
  }

  private renderSelectedRun(run: ProductionRun): HTMLElement {
    const detail = document.createElement("div"); detail.className = "production-inspector-run-detail";
    const meta = document.createElement("p"); meta.className = "production-detail-copy"; meta.textContent = `${run.id} · ${run.summary.downloadedFiles !== undefined ? `${run.summary.downloadedFiles}/${run.summary.files ?? "?"} files · ${formatBytes(Number(run.summary.downloadedBytes ?? 0))}` : new Date(run.createdAt).toLocaleString()}`; detail.append(meta);
    const steps = document.createElement("ol"); steps.className = "production-detail-steps";
    run.steps.forEach((step) => { const item = document.createElement("li"); item.dataset.status = step.status; const title = document.createElement("strong"); title.textContent = step.title; const state = document.createElement("span"); state.textContent = step.detail ?? (STATUS_LABELS[step.status] ?? step.status); item.append(title, state); steps.append(item); });
    detail.append(steps);
    const artifacts = document.createElement("div"); artifacts.className = "production-artifact-list";
    run.artifacts.forEach((artifact) => { const link = document.createElement("a"); link.className = "command-button secondary"; link.href = workspaceApi.productionArtifactUrl(run.id, artifact.name); link.textContent = `下载 ${artifact.name}`; link.download = artifact.name; artifacts.append(link); });
    if (artifacts.childElementCount) detail.append(artifacts);
    const actions = document.createElement("div"); actions.className = "production-run-actions";
    if (run.status === "queued" || run.status === "running") { const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "command-button danger"; cancel.textContent = "取消任务"; cancel.addEventListener("click", () => void this.cancel(run)); actions.append(cancel); }
    if (run.status === "failed" || run.status === "cancelled") { const retry = document.createElement("button"); retry.type = "button"; retry.className = "command-button"; retry.textContent = "重试"; retry.addEventListener("click", () => void this.retry(run)); actions.append(retry); }
    if (actions.childElementCount) detail.append(actions);
    return detail;
  }

  private async savePreset(): Promise<void> {
    const pipeline = this.pipelines.find((candidate) => candidate.key === this.selectedPipelineKey);
    if (!pipeline) return;
    const saved = await workspaceApi.saveProductionPreset({ ...(this.selectedPresetId ? { id: this.selectedPresetId } : {}), pipelineKey: pipeline.key, title: this.draftTitle.trim() || pipeline.title, config: this.draftConfig, pinned: this.presets.find((preset) => preset.id === this.selectedPresetId)?.pinned ?? false });
    this.presets = [saved, ...this.presets.filter((preset) => preset.id !== saved.id)];
    this.selectedPresetId = saved.id;
    this.draftTitle = saved.title;
    notifyWorkspace("流水线配置副本已保存", saved.title, { tone: "success" });
    this.renderTemplates(); this.renderInstances(); this.renderDag(); this.renderInspector();
  }

  private async togglePin(): Promise<void> {
    const preset = this.presets.find((candidate) => candidate.id === this.selectedPresetId);
    if (!preset) return;
    const saved = await workspaceApi.saveProductionPreset({ id: preset.id, pipelineKey: preset.pipelineKey, title: this.draftTitle || preset.title, config: this.draftConfig, pinned: !preset.pinned });
    this.presets = [saved, ...this.presets.filter((candidate) => candidate.id !== saved.id)];
    this.renderTemplates(); this.renderInstances(); this.renderDag(); this.renderInspector();
  }

  private async deletePreset(): Promise<void> {
    if (!this.selectedPresetId) return;
    const id = this.selectedPresetId;
    await workspaceApi.deleteProductionPreset(id);
    this.presets = this.presets.filter((preset) => preset.id !== id);
    this.selectPipeline(this.selectedPipelineKey ?? undefined, null);
    notifyWorkspace("流水线配置副本已删除", "已恢复模板", { tone: "success" });
  }

  private renderForm(): void {
    const select = byId<HTMLSelectElement>("production-pipeline-select");
    select.replaceChildren(...this.pipelines.map((pipeline) => new Option(`${pipeline.title}${pipeline.availability === "planned" ? " · 规划中" : ""}`, pipeline.key)));
    if (this.selectedPipelineKey && [...select.options].some((option) => option.value === this.selectedPipelineKey)) select.value = this.selectedPipelineKey;
    const isDownload = select.value === "overlap-download@1";
    byId("production-overlap-fields").hidden = !isDownload;
    byId("production-crossmatch-fields").hidden = isDownload;
    const submit = byId<HTMLButtonElement>("production-form-submit");
    const pipelineAvailable = Boolean(this.pipelines.find((pipeline) => pipeline.key === select.value && pipeline.availability === "available"));
    const context = this.context;
    byId("production-region-summary").textContent = context ? `ICRS · NESTED · NSIDE ${context.nside} · ${context.pixels.length} cells${context.componentId ? ` · ${context.componentId}` : ""}` : "尚未附加区域；请从 G 模式或数据覆盖右栏进入。";
    byId("production-files-summary").textContent = context?.files?.length ? `${context.files.length} 个可下载文件已反查` : context?.componentId ? "正在反查重合区域文件…" : "尚未反查文件";
    const exportFormat = byId<HTMLSelectElement>("production-export-format"); exportFormat.value = String(this.draftConfig.exportFormat ?? exportFormat.value ?? "json");
    const crawler = byId<HTMLSelectElement>("production-crawler"); if (!crawler.options.length) crawler.add(new Option("内置 HTTP 爬虫", "builtin-http")); crawler.value = String(this.draftConfig.crawlerId ?? crawler.value ?? "builtin-http");
    const concurrency = byId<HTMLInputElement>("production-concurrency"); concurrency.value = String(this.draftConfig.concurrency ?? concurrency.value ?? 4);
    const storage = byId<HTMLSelectElement>("production-storage");
    const selectedStorage = storage.value;
    storage.replaceChildren(new Option("Workspace 托管目录（自动创建 Connector）", ""), ...this.connectors.filter((connector) => connector.kind === "local" && connector.status !== "disabled").map((connector) => new Option(`${connector.name} · ${connector.displayPath}`, connector.id)));
    storage.value = [...storage.options].some((option) => option.value === selectedStorage) ? selectedStorage : "";
    const matchRadius = byId<HTMLInputElement>("production-match-radius"); matchRadius.value = String(this.draftConfig.matchRadiusArcsec ?? matchRadius.value ?? 1.5);
    this.populateAssets("production-left-asset", context?.assetIds?.[0]);
    this.populateAssets("production-right-asset", context?.assetIds?.[1]);
    const leftAsset = byId<HTMLSelectElement>("production-left-asset").value;
    const rightAsset = byId<HTMLSelectElement>("production-right-asset").value;
    submit.disabled = !pipelineAvailable || !context || (!isDownload && (!leftAsset || !rightAsset || leftAsset === rightAsset));
  }

  private populateAssets(id: string, preferred?: string): void {
    const select = byId<HTMLSelectElement>(id);
    const current = select.value;
    const queryable = this.assets.filter((asset) => asset.kind === "catalog" && Boolean(asset.scanSpec?.raColumn && asset.scanSpec?.decColumn && asset.scanSpec?.objectIdColumn));
    select.replaceChildren(...queryable.map((asset) => new Option(`${asset.name} · ${asset.id.slice(-8)}`, asset.id)));
    const selected = preferred ?? current;
    if (selected && queryable.some((asset) => asset.id === selected)) select.value = selected;
  }

  private async submit(): Promise<void> {
    const pipelineKey = byId<HTMLSelectElement>("production-pipeline-select").value;
    const context = this.context;
    if (!context) throw new Error("请先从天球或数据覆盖右栏附加一个区域");
    const region: RegionSnapshot = { coordinateFrame: "ICRS", ordering: "NESTED", nside: context.nside, pixels: context.pixels, sourceIds: context.sourceIds ?? [], ...(context.componentId ? { componentId: context.componentId } : {}), createdAt: new Date().toISOString() };
    const input = pipelineKey === "overlap-download@1"
      ? {
          pipelineKey, ...(this.selectedPresetId ? { pipelinePresetId: this.selectedPresetId } : {}), region, files: context.files ?? [], exportFormat: byId<HTMLSelectElement>("production-export-format").value as "json" | "csv",
          crawlerId: byId<HTMLSelectElement>("production-crawler").value, concurrency: Number(byId<HTMLInputElement>("production-concurrency").value),
          ...(byId<HTMLSelectElement>("production-storage").value ? { storageConnectorId: byId<HTMLSelectElement>("production-storage").value } : {}),
        }
      : {
          pipelineKey, ...(this.selectedPresetId ? { pipelinePresetId: this.selectedPresetId } : {}), region, leftAssetId: byId<HTMLSelectElement>("production-left-asset").value, rightAssetId: byId<HTMLSelectElement>("production-right-asset").value,
          matchRadiusArcsec: Number(byId<HTMLInputElement>("production-match-radius").value),
        };
    const submit = byId<HTMLButtonElement>("production-form-submit"); submit.disabled = true;
    try {
      if (pipelineKey === "overlap-download@1" && !(input as { files: CoverageDownloadFile[] }).files.length) throw new Error("该区域没有可下载文件，请等待反查完成或更换区域");
      const run = await workspaceApi.submitProductionRun(input);
      this.runs = [run, ...this.runs.filter((candidate) => candidate.id !== run.id)]; this.selectedRun = run;
      byId<HTMLDialogElement>("production-create-dialog").close(); this.renderRuns();
      notifyWorkspace("数据生产任务已提交", `${run.pipelineKey} · ${run.id}`, { tone: "success" }); this.schedulePoll(100);
    } finally { submit.disabled = false; }
  }

  private async refreshRuns(): Promise<void> { this.runs = await workspaceApi.productionRuns(); }
  private async refreshPresets(): Promise<void> { this.presets = await workspaceApi.productionPresets(); }

  private renderRuns(): void {
    const badge = byId("production-status-badge"); badge.dataset.status = this.selectedRun?.status ?? "idle"; badge.textContent = this.selectedRun ? STATUS_LABELS[this.selectedRun.status] ?? this.selectedRun.status : "IDLE";
    this.onSummary(this.summary());
    this.renderInstances();
    this.renderDag();
    this.renderInspector();
  }

  private async cancel(run: ProductionRun): Promise<void> { try { this.selectedRun = await workspaceApi.cancelProductionRun(run.id); this.runs = this.runs.map((candidate) => candidate.id === run.id ? this.selectedRun! : candidate); this.renderRuns(); } catch (error) { this.showError(error); } }
  private async retry(run: ProductionRun): Promise<void> { try { const retried = await workspaceApi.retryProductionRun(run.id); this.runs = [retried, ...this.runs]; this.selectedRun = retried; this.renderRuns(); this.schedulePoll(100); } catch (error) { this.showError(error); } }

  private schedulePoll(delay: number): void {
    if (!this.active) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(async () => {
      try { await this.refreshRuns(); if (this.selectedRun) this.selectedRun = this.runs.find((run) => run.id === this.selectedRun?.id) ?? this.selectedRun; this.renderRuns(); if (this.runs.some((run) => run.status === "queued" || run.status === "running")) this.schedulePoll(800); } catch (error) { this.showError(error); }
    }, delay);
  }

  private showError(error: unknown, title = "数据生产操作失败"): void { const message = error instanceof Error ? error.message : String(error); notifyWorkspace(title, message, { tone: "error" }); this.onError(error); }
}
