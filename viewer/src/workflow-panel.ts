import { workspaceApi } from "./api";
import type { DataAssetRecord } from "./api";
import type { ToolDescriptor, WorkflowDefinition, WorkflowRun, WorkflowRunListItem } from "../../src/workflow";
import { notifyWorkspace } from "./notifications";

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing workflow element: ${id}`);
  return element as T;
}

function numberValue(id: string): number {
  return Number(byId<HTMLInputElement>(id).value);
}

function formatInteger(value: unknown): string {
  const number = Number(value);
  return Number.isFinite(number) ? new Intl.NumberFormat("en-US").format(number) : "--";
}

function shortId(value: string): string {
  return value.length > 23 ? `${value.slice(0, 14)}…${value.slice(-6)}` : value;
}

function catalogFormat(asset: DataAssetRecord): "csv" | "fits" | undefined {
  const accesses = asset.accesses?.length ? asset.accesses : [asset.access];
  const access = accesses.find((candidate) => candidate.connector === "local" || candidate.connector === "s3");
  if (!access) return undefined;
  const selectedPath = asset.sourceRelativePath ?? access.uri;
  const extensionFormat = /\.csv(?:$|[?#])/i.test(selectedPath)
    ? "csv"
    : /\.(?:fits|fit|fts)(?:$|[?#])/i.test(selectedPath)
      ? "fits"
      : undefined;
  const declared = access.format.toLowerCase();
  const declaredFormat = declared.includes("csv")
    ? "csv"
    : declared.includes("fits") || declared === "fit" || declared === "fts"
      ? "fits"
      : undefined;
  if (extensionFormat && declaredFormat && extensionFormat !== declaredFormat) return undefined;
  return extensionFormat ?? declaredFormat;
}

const CATALOG_COLUMN_INPUTS = [
  ["ra", "workflow-catalog-ra-column"],
  ["dec", "workflow-catalog-dec-column"],
  ["id", "workflow-catalog-id-column"],
  ["magnitude", "workflow-catalog-magnitude-column"],
  ["classLabel", "workflow-catalog-class-column"],
  ["tileIndex", "workflow-catalog-tile-column"],
  ["brickname", "workflow-catalog-brickname-column"],
  ["fitsPath", "workflow-catalog-fits-path-column"],
  ["imageG", "workflow-catalog-image-g-column"],
  ["imageR", "workflow-catalog-image-r-column"],
  ["imageI", "workflow-catalog-image-i-column"],
  ["imageZ", "workflow-catalog-image-z-column"],
] as const;

type CatalogSide = "euclid" | "desi";
interface CatalogSourceConfig {
  columns?: Record<string, string>;
  tableHdu?: number | string;
}

const STATUS_LABELS: Record<string, string> = {
  queued: "排队中",
  running: "执行中",
  waiting_for_input: "等待人工处理",
  succeeded: "完成",
  failed: "失败",
  pending: "未开始",
  skipped: "已跳过",
};

export class WorkflowPanel {
  private workflows: WorkflowDefinition[] = [];
  private tools: ToolDescriptor[] = [];
  private catalogAssets: DataAssetRecord[] = [];
  private catalogSourceConfigs: Partial<Record<CatalogSide, CatalogSourceConfig>> = {};
  private catalogAssetIds: Record<CatalogSide, string> = { euclid: "", desi: "" };
  private activeCatalogMappingSide: CatalogSide = "euclid";
  private currentRun: WorkflowRun | null = null;
  private runHistory: WorkflowRunListItem[] = [];
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private historyPollTimer: ReturnType<typeof setTimeout> | null = null;
  private initialized = false;
  private active = false;
  private lastNotifiedRunStatus: WorkflowRun["status"] | null = null;

  constructor(private readonly onError: (error: unknown) => void) {
    const dialog = byId<HTMLDialogElement>("workflow-create-dialog");
    byId<HTMLButtonElement>("workflow-new").addEventListener("click", () => dialog.showModal());
    byId<HTMLButtonElement>("workflow-history-refresh").addEventListener("click", () => {
      void this.refreshRunHistory().catch((error) => this.showError(error));
    });
    byId<HTMLButtonElement>("workflow-dialog-close").addEventListener("click", () => dialog.close());
    byId<HTMLFormElement>("workflow-form").addEventListener("submit", (event) => {
      event.preventDefault();
      void this.createRun().catch((error) => this.showError(error));
    });
    byId<HTMLButtonElement>("workflow-accept-all").addEventListener("click", () => void this.decide({ action: "accept_all" }));
    byId<HTMLButtonElement>("workflow-apply-filter").addEventListener("click", () => {
      const field = byId<HTMLSelectElement>("workflow-filter-field").value;
      const op = byId<HTMLSelectElement>("workflow-filter-op").value;
      const rawValue = byId<HTMLInputElement>("workflow-filter-value").value;
      const numeric = Number(rawValue);
      void this.decide({
        action: "apply_filter",
        filter: { logic: "and", conditions: [{ field, op, value: Number.isFinite(numeric) ? numeric : rawValue }] },
      });
    });
    byId<HTMLButtonElement>("workflow-adjust-region").addEventListener("click", () => void this.decide({ action: "adjust_region", input: this.formInput() }));
    byId<HTMLButtonElement>("workflow-retry").addEventListener("click", () => void this.decide({ action: "retry" }));
    byId<HTMLButtonElement>("workflow-open-layers").addEventListener("click", () => this.navigate("layers"));
    byId<HTMLSelectElement>("workflow-catalog-source-euclid").addEventListener("change", () => this.catalogSourceChanged("euclid"));
    byId<HTMLSelectElement>("workflow-catalog-source-desi").addEventListener("change", () => this.catalogSourceChanged("desi"));
    byId<HTMLSelectElement>("workflow-catalog-map-side").addEventListener("change", () => {
      this.saveActiveCatalogMapping();
      this.activeCatalogMappingSide = byId<HTMLSelectElement>("workflow-catalog-map-side").value as CatalogSide;
      this.loadActiveCatalogMapping();
    });
  }

  async activate(): Promise<void> {
    this.active = true;
    if (!this.initialized) await this.initialize();
    await this.refreshRunHistory();
    const selectedRunId = this.currentRun?.id ?? this.preferredRun()?.id;
    if (selectedRunId) {
      this.currentRun = await workspaceApi.workflowRun(selectedRunId);
      this.lastNotifiedRunStatus = this.currentRun.status;
      this.renderRun();
      this.renderRunHistory();
    }
    if (this.currentRun && ["queued", "running"].includes(this.currentRun.status)) this.schedulePoll(50);
    this.scheduleHistoryRefresh();
  }

  deactivate(): void {
    this.active = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    if (this.historyPollTimer) clearTimeout(this.historyPollTimer);
    this.historyPollTimer = null;
  }

  debugState(): Record<string, unknown> {
    return {
      workflowRunId: this.currentRun?.id,
      workflowStatus: this.currentRun?.status,
      workflowPreviewRows: this.currentRun?.preview.length ?? 0,
      workflowRunHistoryCount: this.runHistory.length,
    };
  }

  private preferredRun(): WorkflowRunListItem | undefined {
    return this.runHistory.find((run) => run.status === "waiting_for_input")
      ?? this.runHistory.find((run) => run.status === "queued" || run.status === "running")
      ?? this.runHistory[0];
  }

  private async refreshRunHistory(): Promise<void> {
    this.runHistory = await workspaceApi.workflowRuns({ limit: 50 });
    this.renderRunHistory();
    if (!this.currentRun) {
      const preferred = this.preferredRun();
      if (preferred) await this.openRun(preferred.id);
      return;
    }
    const selected = this.runHistory.find((run) => run.id === this.currentRun?.id);
    if (selected && selected.updatedAt !== this.currentRun.updatedAt && !["queued", "running"].includes(this.currentRun.status)) {
      this.currentRun = await workspaceApi.workflowRun(this.currentRun.id);
      this.renderRun();
      this.renderRunHistory();
    }
  }

  private scheduleHistoryRefresh(): void {
    if (!this.active) return;
    if (this.historyPollTimer) clearTimeout(this.historyPollTimer);
    this.historyPollTimer = setTimeout(() => {
      void this.refreshRunHistory()
        .catch((error) => this.showError(error))
        .finally(() => this.scheduleHistoryRefresh());
    }, 10_000);
  }

  private async openRun(runId: string): Promise<void> {
    this.currentRun = await workspaceApi.workflowRun(runId);
    this.lastNotifiedRunStatus = this.currentRun.status;
    this.renderRun();
    this.renderRunHistory();
    if (["queued", "running"].includes(this.currentRun.status)) this.schedulePoll(50);
  }

  private renderRunHistory(): void {
    const list = byId("workflow-run-history");
    byId("workflow-run-history-count").textContent = String(this.runHistory.length);
    byId("workflow-run-history-empty").hidden = this.runHistory.length > 0;
    list.replaceChildren(...this.runHistory.map((run) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "workflow-history-row";
      button.dataset.status = run.status;
      button.setAttribute("aria-pressed", String(run.id === this.currentRun?.id));
      button.addEventListener("click", () => void this.openRun(run.id).catch((error) => this.showError(error)));

      const title = document.createElement("strong");
      title.textContent = run.waitingReason === "filter" ? "等待人工筛选"
        : run.waitingReason === "region_adjust" ? "等待区域调整"
          : this.workflows.find((workflow) => workflow.key === run.workflowKey)?.title ?? run.workflowKey;
      const detail = document.createElement("small");
      const updatedAt = new Date(run.updatedAt);
      const timestamp = Number.isNaN(updatedAt.valueOf()) ? "" : new Intl.DateTimeFormat("zh-CN", {
        month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
      }).format(updatedAt);
      detail.textContent = `${shortId(run.id)} · ${formatInteger(run.candidateCount)} 个候选 · ${timestamp}`;
      const status = document.createElement("span");
      status.className = "workflow-history-status";
      status.textContent = STATUS_LABELS[run.status] ?? run.status.toUpperCase();
      button.append(title, detail, status);
      return button;
    }));
  }

  private async initialize(): Promise<void> {
    [this.workflows, this.tools, this.catalogAssets] = await Promise.all([workspaceApi.workflows(), workspaceApi.tools(), workspaceApi.dataAssets()]);
    if (this.workflows.length === 0) throw new Error("服务端没有注册工作流");
    const select = byId<HTMLSelectElement>("workflow-select");
    select.replaceChildren(...this.workflows.map((workflow) => {
      const option = document.createElement("option");
      option.value = workflow.key;
      option.textContent = workflow.title;
      return option;
    }));
    const euclidSourceSelect = byId<HTMLSelectElement>("workflow-catalog-source-euclid");
    const desiSourceSelect = byId<HTMLSelectElement>("workflow-catalog-source-desi");
    const sourceOptions = this.catalogAssets
      .filter((asset) => asset.kind === "catalog")
      .map((asset) => ({ asset, format: catalogFormat(asset) }))
      .filter((entry): entry is { asset: DataAssetRecord; format: "csv" | "fits" } => Boolean(entry.format));
    const options = [
      new Option("远程目录", ""),
      ...sourceOptions.map(({ asset, format }) => new Option(`${asset.name} · ${format.toUpperCase()}`, asset.id)),
    ];
    euclidSourceSelect.replaceChildren(...options.map((option) => option.cloneNode(true) as HTMLOptionElement));
    desiSourceSelect.replaceChildren(...options.map((option) => option.cloneNode(true) as HTMLOptionElement));
    this.refreshCatalogMappingSides();
    this.renderTools();
    this.renderDefinition(this.workflows[0]!);
    this.initialized = true;
  }

  private formInput(): Record<string, unknown> {
    const input: Record<string, unknown> = {
      raDeg: numberValue("workflow-ra"),
      decDeg: numberValue("workflow-dec"),
      queryRadiusArcsec: numberValue("workflow-query-radius"),
      matchRadiusArcsec: numberValue("workflow-match-radius"),
      limit: numberValue("workflow-limit"),
      cutoutEnabled: byId<HTMLInputElement>("workflow-cutout-enabled").checked,
      cutoutSizeDeg: numberValue("workflow-cutout-size"),
      desiBands: ["g", "r", "i", "z"],
    };
    this.saveActiveCatalogMapping();
    const catalogSources: Partial<Record<CatalogSide, Record<string, unknown>>> = {};
    for (const side of ["euclid", "desi"] as const) {
      const assetId = byId<HTMLSelectElement>(`workflow-catalog-source-${side}`).value;
      if (!assetId) continue;
      catalogSources[side] = { assetId, ...(this.catalogSourceConfigs[side] ?? {}) };
    }
    if (Object.keys(catalogSources).length) input.catalogSources = catalogSources;
    const rawCatalogFields = byId<HTMLTextAreaElement>("workflow-catalog-fields").value.trim();
    if (rawCatalogFields) input.catalogFields = JSON.parse(rawCatalogFields) as unknown;
    return input;
  }

  private catalogSourceChanged(side: CatalogSide): void {
    this.saveActiveCatalogMapping();
    const sourceId = byId<HTMLSelectElement>(`workflow-catalog-source-${side}`).value;
    if (sourceId !== this.catalogAssetIds[side]) {
      delete this.catalogSourceConfigs[side];
      this.catalogAssetIds[side] = sourceId;
    }
    this.refreshCatalogMappingSides();
  }

  private refreshCatalogMappingSides(): void {
    const available = (["euclid", "desi"] as const).filter((side) => Boolean(byId<HTMLSelectElement>(`workflow-catalog-source-${side}`).value));
    const selector = byId<HTMLSelectElement>("workflow-catalog-map-side");
    selector.replaceChildren(...available.map((side) => new Option(side === "euclid" ? "Euclid" : "DESI", side)));
    const columns = byId("workflow-catalog-columns");
    columns.hidden = available.length === 0;
    if (!available.length) return;
    if (!available.includes(this.activeCatalogMappingSide)) this.activeCatalogMappingSide = available[0]!;
    selector.value = this.activeCatalogMappingSide;
    this.loadActiveCatalogMapping();
  }

  private saveActiveCatalogMapping(): void {
    if (!byId<HTMLSelectElement>("workflow-catalog-source-euclid").value
      && !byId<HTMLSelectElement>("workflow-catalog-source-desi").value) return;
    const side = this.activeCatalogMappingSide;
    if (!byId<HTMLSelectElement>(`workflow-catalog-source-${side}`).value) return;
    const columns: Record<string, string> = {};
    for (const [key, id] of CATALOG_COLUMN_INPUTS) {
      const value = byId<HTMLInputElement>(id).value.trim();
      if (value) columns[key] = value;
    }
    const rawHdu = byId<HTMLInputElement>("workflow-catalog-hdu").value.trim();
    const tableHdu = /^\d+$/.test(rawHdu) ? Number(rawHdu) : rawHdu || undefined;
    this.catalogSourceConfigs[side] = {
      ...(Object.keys(columns).length ? { columns } : {}),
      ...(tableHdu === undefined ? {} : { tableHdu }),
    };
  }

  private loadActiveCatalogMapping(): void {
    const side = this.activeCatalogMappingSide;
    const assetId = byId<HTMLSelectElement>(`workflow-catalog-source-${side}`).value;
    const asset = this.catalogAssets.find((candidate) => candidate.id === assetId);
    if (!asset) return;
    const config = this.catalogSourceConfigs[side];
    const scan = asset.scanSpec?.format === "csv" ? asset.scanSpec : undefined;
    const mapped: Record<string, string> = {
      ra: scan?.raColumn ?? "",
      dec: scan?.decColumn ?? "",
      id: scan?.objectIdColumn ?? "",
      ...(config?.columns ?? {}),
    };
    for (const [key, id] of CATALOG_COLUMN_INPUTS) byId<HTMLInputElement>(id).value = mapped[key] ?? "";
    byId<HTMLLabelElement>("workflow-catalog-hdu-field").hidden = catalogFormat(asset) !== "fits";
    byId<HTMLInputElement>("workflow-catalog-hdu").value = config?.tableHdu === undefined ? "" : String(config.tableHdu);
  }

  private async createRun(): Promise<void> {
    this.clearError();
    const workflowId = byId<HTMLSelectElement>("workflow-select").value;
    this.currentRun = await workspaceApi.createWorkflowRun(workflowId, this.formInput());
    this.lastNotifiedRunStatus = null;
    await this.refreshRunHistory();
    notifyWorkspace("数据生产任务已提交", `Workflow ${workflowId}`, { tone: "success" });
    byId<HTMLDialogElement>("workflow-create-dialog").close();
    this.renderRun();
    this.schedulePoll(100);
  }

  private async decide(decision: Record<string, unknown>): Promise<void> {
    if (!this.currentRun) return;
    try {
      this.clearError();
      this.currentRun = await workspaceApi.decideWorkflowRun(this.currentRun.id, decision);
      await this.refreshRunHistory();
      this.renderRun();
      if (["queued", "running"].includes(this.currentRun.status)) this.schedulePoll(100);
    } catch (error) {
      this.showError(error);
    }
  }

  private schedulePoll(delay = 500): void {
    if (!this.active || !this.currentRun) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => void this.poll(), delay);
  }

  private async poll(): Promise<void> {
    if (!this.active || !this.currentRun) return;
    try {
      this.currentRun = await workspaceApi.workflowRun(this.currentRun.id);
      this.renderRun();
      if (["queued", "running"].includes(this.currentRun.status)) this.schedulePoll();
      else this.tools = await workspaceApi.tools().catch(() => this.tools), this.renderTools();
    } catch (error) {
      this.showError(error);
    }
  }

  private renderDefinition(definition: WorkflowDefinition): void {
    byId("workflow-stage-title").textContent = definition.title;
    byId("pipeline-progress").textContent = `0 / ${definition.steps.length}`;
    const list = byId<HTMLOListElement>("workflow-steps");
    list.replaceChildren(...definition.steps.map((step, index) => {
      const item = document.createElement("li");
      item.dataset.status = "pending";
      const number = document.createElement("span");
      number.className = "step-index";
      number.textContent = String(index + 1).padStart(2, "0");
      const copy = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = step.title;
      const tool = document.createElement("small");
      tool.textContent = step.toolId ?? "HUMAN DECISION";
      copy.append(title, tool);
      const state = document.createElement("span");
      state.className = "step-state";
      state.textContent = "PENDING";
      const progress = document.createElement("span");
      progress.className = "item-progress";
      progress.dataset.status = "pending";
      progress.dataset.mode = "inactive";
      progress.setAttribute("aria-hidden", "true");
      item.append(number, copy, state, progress);
      return item;
    }));
  }

  private renderTools(): void {
    byId("workflow-tool-count").textContent = `${this.tools.length} TOOLS`;
    const container = byId("workflow-tool-health");
    container.replaceChildren(...this.tools.map((tool) => {
      const row = document.createElement("div");
      const indicator = document.createElement("i");
      indicator.dataset.status = tool.health.status;
      const name = document.createElement("span");
      name.textContent = tool.title;
      const status = document.createElement("b");
      status.textContent = tool.health.status.toUpperCase();
      row.title = tool.health.detail;
      row.append(indicator, name, status);
      return row;
    }));
  }

  private renderRun(): void {
    const run = this.currentRun;
    if (!run) return;
    const badge = byId("workflow-status-badge");
    badge.dataset.status = run.status;
    badge.textContent = STATUS_LABELS[run.status] ?? run.status.toUpperCase();
    if (this.lastNotifiedRunStatus !== run.status) {
      this.lastNotifiedRunStatus = run.status;
      if (run.status === "succeeded") notifyWorkspace("数据生产任务已完成", `${run.summary.matchRows} 个匹配结果`, { tone: "success" });
      else if (run.status === "failed") notifyWorkspace("数据生产任务失败", run.error ?? "Workflow 执行失败", { tone: "error" });
      else if (run.status === "waiting_for_input") notifyWorkspace("数据生产任务等待输入", run.waiting?.message ?? "请在工作流面板完成下一步", { tone: "info" });
    }
    byId("workflow-run-id").textContent = shortId(run.id);
    byId("workflow-run-id").title = run.id;
    byId("dataset-state").textContent = run.status === "succeeded" ? "工作流执行完成" : run.status === "failed" ? "工作流执行失败" : "工作流正在追踪";
    byId("metric-one").textContent = `${run.steps.filter((step) => step.status === "succeeded").length}/${run.steps.length}`;
    byId("metric-two").textContent = formatInteger(run.summary.euclidRows);
    byId("metric-three").textContent = formatInteger(run.summary.filteredRows ?? run.summary.matchRows);
    byId("metric-four").textContent = formatInteger(run.summary.desiRows);
    byId("metric-five").textContent = formatInteger(run.artifacts.length);
    byId("object-status").textContent = `${formatInteger(run.summary.matchRows)} MATCHES`;

    const items = [...byId<HTMLOListElement>("workflow-steps").children] as HTMLElement[];
    run.steps.forEach((step, index) => {
      const item = items[index];
      if (!item) return;
      item.dataset.status = step.status;
      const state = item.querySelector<HTMLElement>(".step-state");
      if (state) state.textContent = STATUS_LABELS[step.status] ?? step.status.toUpperCase();
      const progress = item.querySelector<HTMLElement>(".item-progress");
      if (progress) {
        progress.dataset.status = step.status;
        progress.dataset.mode = step.status === "running" ? "indeterminate" : step.status === "succeeded" ? "complete" : step.status === "waiting_for_input" ? "waiting" : step.status === "failed" ? "failed" : "inactive";
        const active = !["pending", "skipped"].includes(step.status);
        progress.setAttribute("aria-hidden", String(!active));
        if (active) progress.setAttribute("aria-label", `步骤“${step.title}”${step.status === "running" ? "正在运行" : step.status === "succeeded" ? "已成功完成" : step.status === "waiting_for_input" ? "正在等待输入" : "执行失败"}`);
        else progress.removeAttribute("aria-label");
      }
      const detail = item.querySelector<HTMLElement>("small");
      if (detail && step.durationMs !== undefined) detail.textContent = `${step.toolId ?? "HUMAN DECISION"} · ${step.durationMs.toFixed(1)} ms`;
    });
    const completed = run.steps.filter((step) => ["succeeded", "failed", "skipped"].includes(step.status)).length;
    byId("pipeline-progress").textContent = `${completed} / ${run.steps.length}`;

    const gate = byId("workflow-gate");
    gate.hidden = run.status !== "waiting_for_input";
    if (run.waiting) {
      byId("workflow-gate-title").textContent = run.waiting.reason === "filter" ? "等待人工筛选" : "等待区域调整";
      byId("workflow-gate-message").textContent = run.waiting.message;
      byId("workflow-filter-controls").hidden = run.waiting.reason !== "filter";
      byId("workflow-region-controls").hidden = run.waiting.reason !== "region_adjust";
      const fieldSelect = byId<HTMLSelectElement>("workflow-filter-field");
      const previous = fieldSelect.value;
      fieldSelect.replaceChildren(...run.waiting.availableFields.map((field) => {
        const option = document.createElement("option");
        option.value = field;
        option.textContent = field;
        return option;
      }));
      fieldSelect.value = run.waiting.availableFields.includes(previous) ? previous : run.waiting.availableFields.includes("separationArcsec") ? "separationArcsec" : run.waiting.availableFields[0] ?? "";
    }

    byId<HTMLButtonElement>("workflow-retry").hidden = run.status !== "failed";
    const download = byId<HTMLAnchorElement>("workflow-download");
    const artifact = run.artifacts.find((candidate) => candidate.name === "filtered.csv") ?? run.artifacts.find((candidate) => candidate.name === "crossmatch.csv");
    download.hidden = !artifact;
    if (artifact) download.href = `/api/workflow-runs/${encodeURIComponent(run.id)}/artifacts/${encodeURIComponent(artifact.name)}`;
    const cutoutDownload = byId<HTMLAnchorElement>("workflow-cutout-download");
    const cutoutArtifact = run.artifacts.find((candidate) => candidate.name === "cutouts.json");
    cutoutDownload.hidden = !cutoutArtifact;
    if (cutoutArtifact) cutoutDownload.href = `/api/workflow-runs/${encodeURIComponent(run.id)}/artifacts/${encodeURIComponent(cutoutArtifact.name)}`;
    this.renderPreview(run.preview);
    if (run.error) this.showError(new Error(run.error), false);
    else this.clearError();
  }

  private renderPreview(rows: Array<Record<string, unknown>>): void {
    byId("workflow-preview-count").textContent = `${rows.length} ROWS`;
    const table = byId<HTMLTableElement>("workflow-result-table");
    const head = table.tHead ?? table.createTHead();
    const body = table.tBodies[0] ?? table.createTBody();
    head.replaceChildren();
    body.replaceChildren();
    byId("workflow-result-empty").hidden = rows.length > 0;
    table.hidden = rows.length === 0;
    if (rows.length === 0) return;
    const preferred = ["euclidObjectId", "desiObjectId", "separationArcsec", "euclidRaDeg", "euclidDecDeg"];
    const fields = [
      ...preferred.filter((field) => field in rows[0]!).map((field) => ({ field, label: field })),
      ...(["euclid", "desi"] as const).flatMap((side) => {
        const value = rows[0]![`${side}Fields`];
        return value && typeof value === "object" && !Array.isArray(value)
          ? Object.keys(value as Record<string, unknown>).map((alias) => ({ field: `${side}Fields.${alias}`, label: `${side}_${alias}` }))
          : [];
      }),
    ].slice(0, 8);
    const headerRow = document.createElement("tr");
    fields.forEach(({ field, label }) => {
      const cell = document.createElement("th");
      cell.textContent = label.replace("ObjectId", " ID").replace("Arcsec", " (″)").replace("Deg", "");
      headerRow.append(cell);
    });
    head.append(headerRow);
    rows.forEach((row) => {
      const tableRow = document.createElement("tr");
      fields.forEach(({ field }) => {
        const cell = document.createElement("td");
        const path = field.split(".");
        const value = path.reduce<unknown>((current, key) => current && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined, row);
        cell.textContent = typeof value === "number" ? value.toFixed(field === "separationArcsec" ? 4 : 6)
          : value === undefined || value === null ? "--"
            : typeof value === "object" ? JSON.stringify(value) : String(value);
        tableRow.append(cell);
      });
      body.append(tableRow);
    });
  }

  private navigate(mode: "layers"): void {
    window.dispatchEvent(new CustomEvent("astro:navigate", { detail: { mode, input: this.currentRun?.input } }));
  }

  private showError(error: unknown, report = true): void {
    const message = error instanceof Error ? error.message : String(error);
    if (report) {
      notifyWorkspace("Workflow 操作失败", message, { tone: "error" });
      this.onError(error);
    }
  }

  private clearError(): void {
    // Workflow errors are transient notifications; the run badge and history remain persistent.
  }
}
