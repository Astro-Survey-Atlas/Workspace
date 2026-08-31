import { workspaceApi, type DataAssetRecord, type CoverageDownloadFile } from "./api";
import type { ProductionPipelineDefinition, ProductionRun, RegionSnapshot } from "../../src/production";
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

export class ProductionPanel {
  private pipelines: ProductionPipelineDefinition[] = [];
  private runs: ProductionRun[] = [];
  private assets: DataAssetRecord[] = [];
  private connectors: ConnectorPublicRecord[] = [];
  private initialized = false;
  private active = false;
  private context: ProductionContext | null = null;
  private selectedRun: ProductionRun | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly onError: (error: unknown) => void) {
    byId<HTMLButtonElement>("production-new").addEventListener("click", () => this.openDialog());
    byId<HTMLButtonElement>("production-dialog-close").addEventListener("click", () => byId<HTMLDialogElement>("production-create-dialog").close());
    byId<HTMLButtonElement>("production-form-cancel").addEventListener("click", () => byId<HTMLDialogElement>("production-create-dialog").close());
    byId<HTMLSelectElement>("production-pipeline-select").addEventListener("change", () => this.renderForm());
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
    if (pipelineKey) byId<HTMLSelectElement>("production-pipeline-select").dataset.requestedPipeline = pipelineKey;
  }

  async activate(): Promise<void> {
    this.active = true;
    if (!this.initialized) {
      [this.pipelines, this.runs, this.assets, this.connectors] = await Promise.all([
        workspaceApi.productionPipelines(), workspaceApi.productionRuns(), workspaceApi.dataAssets(), workspaceApi.connectors(),
      ]);
      this.initialized = true;
    } else {
      await this.refreshRuns();
    }
    this.renderPipelines();
    this.renderForm();
    this.renderRuns();
    const requested = byId<HTMLSelectElement>("production-pipeline-select").dataset.requestedPipeline;
    delete byId<HTMLSelectElement>("production-pipeline-select").dataset.requestedPipeline;
    if (this.context || requested) this.openDialog(requested);
    if (this.runs.some((run) => run.status === "queued" || run.status === "running")) this.schedulePoll(400);
  }

  deactivate(): void {
    this.active = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  debugState(): Record<string, unknown> {
    return { productionRunId: this.selectedRun?.id, productionStatus: this.selectedRun?.status, productionRuns: this.runs.length };
  }

  private openDialog(pipelineKey?: string): void {
    const select = byId<HTMLSelectElement>("production-pipeline-select");
    if (pipelineKey && [...select.options].some((option) => option.value === pipelineKey)) select.value = pipelineKey;
    this.renderForm();
    const dialog = byId<HTMLDialogElement>("production-create-dialog");
    if (!dialog.open) dialog.showModal();
    if (this.context && !this.context.files?.length && this.context.componentId) void this.resolveFiles();
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

  private renderPipelines(): void {
    const list = byId("production-pipeline-list");
    byId("production-pipeline-count").textContent = `${this.pipelines.filter((pipeline) => pipeline.availability === "available").length}/${this.pipelines.length}`;
    list.replaceChildren(...this.pipelines.map((pipeline, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "production-pipeline-card";
      button.dataset.availability = pipeline.availability;
      button.disabled = pipeline.availability !== "available";
      button.innerHTML = `<span class="pipeline-card-index">${String(index + 1).padStart(2, "0")}</span>`;
      const title = document.createElement("strong"); title.textContent = pipeline.title;
      const detail = document.createElement("small"); detail.textContent = pipeline.availability === "planned" ? "规划中" : pipeline.description;
      button.append(title, detail);
      button.addEventListener("click", () => { byId<HTMLSelectElement>("production-pipeline-select").value = pipeline.key; this.renderForm(); this.openDialog(pipeline.key); });
      return button;
    }));
  }

  private renderForm(): void {
    const select = byId<HTMLSelectElement>("production-pipeline-select");
    if (!select.options.length) select.replaceChildren(...this.pipelines.map((pipeline) => new Option(`${pipeline.title}${pipeline.availability === "planned" ? " · 规划中" : ""}`, pipeline.key)));
    const available = this.pipelines.find((pipeline) => pipeline.availability === "available");
    if (!select.value && available) select.value = available.key;
    const isDownload = select.value === "overlap-download@1";
    byId("production-overlap-fields").hidden = !isDownload;
    byId("production-crossmatch-fields").hidden = isDownload;
    const submit = byId<HTMLButtonElement>("production-form-submit");
    const pipelineAvailable = Boolean(this.pipelines.find((pipeline) => pipeline.key === select.value && pipeline.availability === "available"));
    if (this.context) {
      byId("production-region-summary").textContent = `ICRS · NESTED · NSIDE ${this.context.nside} · ${this.context.pixels.length} cells${this.context.componentId ? ` · ${this.context.componentId}` : ""}`;
      byId("production-files-summary").textContent = this.context.files?.length ? `${this.context.files.length} 个可下载文件已反查` : this.context.componentId ? "正在反查重合区域文件…" : "请先在 G 模式选择重合区域";
    } else {
      byId("production-region-summary").textContent = "尚未附加区域；请从 G 模式或数据覆盖右栏进入。";
      byId("production-files-summary").textContent = "尚未反查文件";
    }
    const crawlers = byId<HTMLSelectElement>("production-crawler");
    if (!crawlers.options.length) crawlers.add(new Option("内置 HTTP 爬虫", "builtin-http"));
    const storage = byId<HTMLSelectElement>("production-storage");
    const currentStorage = storage.value;
    storage.replaceChildren(new Option("Workspace 托管目录（自动创建 Connector）", ""), ...this.connectors.filter((connector) => connector.kind === "local" && connector.status !== "disabled").map((connector) => new Option(`${connector.name} · ${connector.displayPath}`, connector.id)));
    storage.value = [...storage.options].some((option) => option.value === currentStorage) ? currentStorage : "";
    this.populateAssets("production-left-asset", this.context?.assetIds?.[0]);
    this.populateAssets("production-right-asset", this.context?.assetIds?.[1]);
    const leftAsset = byId<HTMLSelectElement>("production-left-asset").value;
    const rightAsset = byId<HTMLSelectElement>("production-right-asset").value;
    submit.disabled = !pipelineAvailable || (!isDownload && (!leftAsset || !rightAsset || leftAsset === rightAsset));
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
          pipelineKey, region, files: context.files ?? [], exportFormat: byId<HTMLSelectElement>("production-export-format").value as "json" | "csv",
          crawlerId: byId<HTMLSelectElement>("production-crawler").value, concurrency: Number(byId<HTMLInputElement>("production-concurrency").value),
          ...(byId<HTMLSelectElement>("production-storage").value ? { storageConnectorId: byId<HTMLSelectElement>("production-storage").value } : {}),
        }
      : {
          pipelineKey, region, leftAssetId: byId<HTMLSelectElement>("production-left-asset").value, rightAssetId: byId<HTMLSelectElement>("production-right-asset").value,
          matchRadiusArcsec: Number(byId<HTMLInputElement>("production-match-radius").value),
        };
    const submit = byId<HTMLButtonElement>("production-form-submit");
    submit.disabled = true;
    try {
      if (pipelineKey === "overlap-download@1" && !(input as { files: CoverageDownloadFile[] }).files.length) throw new Error("该区域没有可下载文件，请等待反查完成或更换区域");
      const run = await workspaceApi.submitProductionRun(input);
      this.runs = [run, ...this.runs.filter((candidate) => candidate.id !== run.id)];
      this.selectedRun = run;
      byId<HTMLDialogElement>("production-create-dialog").close();
      this.renderRuns();
      notifyWorkspace("数据生产任务已提交", `${run.pipelineKey} · ${run.id}`, { tone: "success" });
      this.schedulePoll(100);
    } finally { submit.disabled = false; }
  }

  private async refreshRuns(): Promise<void> { this.runs = await workspaceApi.productionRuns(); }

  private renderRuns(): void {
    const list = byId("production-run-list");
    byId("production-run-count").textContent = String(this.runs.length);
    byId("production-run-empty").hidden = this.runs.length > 0;
    list.replaceChildren(...this.runs.map((run) => {
      const row = document.createElement("button"); row.type = "button"; row.className = "production-run-row"; row.dataset.status = run.status; row.classList.toggle("active", run.id === this.selectedRun?.id);
      const title = document.createElement("strong"); title.textContent = this.pipelines.find((pipeline) => pipeline.key === run.pipelineKey)?.title ?? run.pipelineKey;
      const id = document.createElement("small"); id.textContent = shortId(run.id); id.title = run.id;
      const status = document.createElement("b"); status.textContent = STATUS_LABELS[run.status] ?? run.status;
      const detail = document.createElement("span"); detail.textContent = run.error ?? (run.outputConnectorId ? `Connector ${shortId(run.outputConnectorId)}` : new Date(run.createdAt).toLocaleString());
      row.append(title, id, status, detail); row.addEventListener("click", () => { this.selectedRun = run; this.renderRuns(); this.renderDetail(); });
      return row;
    }));
    this.renderDetail();
    const badge = byId("production-status-badge");
    badge.dataset.status = this.selectedRun?.status ?? "idle";
    badge.textContent = this.selectedRun ? STATUS_LABELS[this.selectedRun.status] ?? this.selectedRun.status : "IDLE";
  }

  private renderDetail(): void {
    const detail = byId("production-detail");
    const run = this.selectedRun;
    detail.hidden = !run;
    if (!run) return;
    detail.replaceChildren();
    const header = document.createElement("header");
    const title = document.createElement("h3"); title.textContent = this.pipelines.find((pipeline) => pipeline.key === run.pipelineKey)?.title ?? run.pipelineKey;
    const status = document.createElement("span"); status.className = "run-status"; status.dataset.status = run.status; status.textContent = STATUS_LABELS[run.status] ?? run.status;
    header.append(title, status);
    const meta = document.createElement("p"); meta.className = "control-note"; meta.textContent = `${run.id} · ${run.summary.downloadedFiles !== undefined ? `${run.summary.downloadedFiles}/${run.summary.files ?? "?"} files · ${formatBytes(Number(run.summary.downloadedBytes ?? 0))}` : new Date(run.createdAt).toLocaleString()}`;
    const steps = document.createElement("ol"); steps.className = "production-detail-steps";
    run.steps.forEach((step) => { const item = document.createElement("li"); item.dataset.status = step.status; item.innerHTML = `<strong>${step.title}</strong><span>${step.detail ?? step.status}</span>`; steps.append(item); });
    const actions = document.createElement("div"); actions.className = "inspector-actions";
    if (run.status === "queued" || run.status === "running") { const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "command-button danger"; cancel.textContent = "取消任务"; cancel.addEventListener("click", () => void this.cancel(run)); actions.append(cancel); }
    if (run.status === "failed" || run.status === "cancelled") { const retry = document.createElement("button"); retry.type = "button"; retry.className = "command-button"; retry.textContent = "重试"; retry.addEventListener("click", () => void this.retry(run)); actions.append(retry); }
    run.artifacts.forEach((artifact) => { const link = document.createElement("a"); link.className = "command-button secondary"; link.href = workspaceApi.productionArtifactUrl(run.id, artifact.name); link.textContent = `下载 ${artifact.name}`; link.download = artifact.name; actions.append(link); });
    detail.append(header, meta, steps, actions);
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
