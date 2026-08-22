import { workspaceApi } from "./api";
import type { ToolDescriptor, WorkflowDefinition, WorkflowRun } from "../../src/workflow";
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

const STATUS_LABELS: Record<string, string> = {
  queued: "排队中",
  running: "执行中",
  waiting_for_input: "等待输入",
  succeeded: "完成",
  failed: "失败",
  pending: "未开始",
  skipped: "已跳过",
};

export class WorkflowPanel {
  private workflows: WorkflowDefinition[] = [];
  private tools: ToolDescriptor[] = [];
  private currentRun: WorkflowRun | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private initialized = false;
  private active = false;
  private productionAction: "crossmatch" | "cutout" | "package" = "crossmatch";
  private lastNotifiedRunStatus: WorkflowRun["status"] | null = null;

  constructor(private readonly onError: (error: unknown) => void) {
    const dialog = byId<HTMLDialogElement>("workflow-create-dialog");
    byId<HTMLButtonElement>("workflow-new").addEventListener("click", () => dialog.showModal());
    byId<HTMLButtonElement>("workflow-dialog-close").addEventListener("click", () => dialog.close());
    byId<HTMLFormElement>("workflow-form").addEventListener("submit", (event) => {
      event.preventDefault();
      void this.createRun().catch((error) => this.showError(error));
    });
    document.querySelectorAll<HTMLButtonElement>("[data-production-action]").forEach((button) => {
      button.addEventListener("click", () => this.selectProductionAction(button.dataset.productionAction as "crossmatch" | "cutout" | "package"));
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
  }

  async activate(): Promise<void> {
    this.active = true;
    this.selectProductionAction("crossmatch");
    if (!this.initialized) await this.initialize();
    if (this.currentRun && ["queued", "running"].includes(this.currentRun.status)) this.schedulePoll(50);
  }

  deactivate(): void {
    this.active = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  debugState(): Record<string, unknown> {
    return {
      workflowRunId: this.currentRun?.id,
      workflowStatus: this.currentRun?.status,
      workflowPreviewRows: this.currentRun?.preview.length ?? 0,
    };
  }

  private async initialize(): Promise<void> {
    [this.workflows, this.tools] = await Promise.all([workspaceApi.workflows(), workspaceApi.tools()]);
    if (this.workflows.length === 0) throw new Error("服务端没有注册工作流");
    const select = byId<HTMLSelectElement>("workflow-select");
    select.replaceChildren(...this.workflows.map((workflow) => {
      const option = document.createElement("option");
      option.value = workflow.key;
      option.textContent = workflow.title;
      return option;
    }));
    this.renderTools();
    this.renderDefinition(this.workflows[0]!);
    this.initialized = true;
  }

  private formInput(): Record<string, unknown> {
    return {
      raDeg: numberValue("workflow-ra"),
      decDeg: numberValue("workflow-dec"),
      queryRadiusArcsec: numberValue("workflow-query-radius"),
      matchRadiusArcsec: numberValue("workflow-match-radius"),
      limit: numberValue("workflow-limit"),
    };
  }

  private async createRun(): Promise<void> {
    if (this.productionAction !== "crossmatch") throw new Error("cutout 和打包将在 astro-code 适配器接入后启用");
    this.clearError();
    const workflowId = byId<HTMLSelectElement>("workflow-select").value;
    this.currentRun = await workspaceApi.createWorkflowRun(workflowId, this.formInput());
    this.lastNotifiedRunStatus = null;
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

  private selectProductionAction(action: "crossmatch" | "cutout" | "package"): void {
    this.productionAction = action;
    document.querySelectorAll<HTMLButtonElement>("[data-production-action]").forEach((button) => {
      button.classList.toggle("active", button.dataset.productionAction === action);
      button.setAttribute("aria-pressed", String(button.dataset.productionAction === action));
    });
    const form = byId<HTMLFormElement>("workflow-form");
    const copy = byId("production-action-copy");
    form.hidden = action !== "crossmatch";
    copy.textContent = action === "crossmatch"
      ? "当前动作使用真实目录执行球面交叉匹配，并保留结果血缘。cutout 与打包会复用同一选区和对象清单。"
      : action === "cutout"
        ? "cutout 需要读取已登记图像路径，并把选区转换为带 RA/Dec 的裁剪任务；当前先保留动作边界，不伪造执行结果。"
        : "打包会把交叉匹配表、cutout 和质量信息组织为可交付数据包；当前先保留数据血缘和输出契约。";
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
    byId("workflow-run-state").textContent = badge.textContent;
    byId("workflow-run-id").textContent = shortId(run.id);
    byId("workflow-run-id").title = run.id;
    byId("workflow-euclid-count").textContent = formatInteger(run.summary.euclidRows);
    byId("workflow-desi-count").textContent = formatInteger(run.summary.desiRows);
    byId("workflow-match-count").textContent = formatInteger(run.summary.matchRows);
    byId("dataset-state").textContent = run.status === "succeeded" ? "工作流执行完成" : run.status === "failed" ? "工作流执行失败" : "工作流正在追踪";
    byId("metric-one").textContent = `${run.steps.filter((step) => step.status === "succeeded").length}/${run.steps.length}`;
    byId("metric-three").textContent = formatInteger(run.summary.filteredRows ?? run.summary.matchRows);
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
    const fields = preferred.filter((field) => field in rows[0]!).slice(0, 5);
    const headerRow = document.createElement("tr");
    fields.forEach((field) => {
      const cell = document.createElement("th");
      cell.textContent = field.replace("ObjectId", " ID").replace("Arcsec", " (″)").replace("Deg", "");
      headerRow.append(cell);
    });
    head.append(headerRow);
    rows.forEach((row) => {
      const tableRow = document.createElement("tr");
      fields.forEach((field) => {
        const cell = document.createElement("td");
        const value = row[field];
        cell.textContent = typeof value === "number" ? value.toFixed(field === "separationArcsec" ? 4 : 6) : String(value ?? "--");
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
