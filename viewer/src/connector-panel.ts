import type { ConnectorKind, ConnectorPublicRecord, ConnectorRegistrationInput, ConnectorStatus } from "../../src/connectors";
import type { SurveyCard, SurveyRecord } from "../../src/survey-registry";
import { createIcons, Pencil, Play, SearchCheck, Trash2 } from "lucide";

import { workspaceApi, type ConnectorScanRun, type WorkspaceCapabilities } from "./api";
import { notifyWorkspace } from "./notifications";

export interface ConnectorMetrics {
  total: number;
  s3: number;
  local: number;
  jdbc: number;
  scans: number;
}

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing required element: ${id}`);
  return element as T;
}

function field(form: HTMLFormElement, name: string): string {
  return String(new FormData(form).get(name) ?? "").trim();
}

const KIND_LABELS: Record<ConnectorKind, string> = { s3: "S3 / OSS", local: "本地路径", jdbc: "JDBC 数据库" };
const STATUS_LABELS: Record<ConnectorStatus, string> = { draft: "未检测", ready: "可用", disabled: "已停用" };
const RUN_STATUS_LABELS: Record<ConnectorScanRun["status"], string> = { queued: "排队中", running: "执行中", succeeded: "成功", failed: "失败" };
const SENSITIVE_CONFIG_KEY = /(auth|credential|secret|password|passphrase|token|access.?key|api.?key|private.?key|session|user(name)?)/i;

type ConnectorView = "list" | "history";

function connectorLocation(record: ConnectorPublicRecord): string { return record.displayPath; }

function statusPill(record: ConnectorPublicRecord): HTMLSpanElement {
  const status = document.createElement("span");
  status.className = "connector-status";
  status.dataset.status = record.lastCheck?.status === "ok" ? "ready" : record.lastCheck?.status === "failed" ? "disabled" : record.status;
  status.textContent = record.lastCheck?.status === "ok" ? "连接正常" : record.lastCheck?.status === "failed" ? "检测失败" : STATUS_LABELS[record.status];
  return status;
}

export class ConnectorPanel {
  readonly #onError: (error: unknown) => void;
  readonly #onMetrics: (metrics: ConnectorMetrics) => void;
  #records: ConnectorPublicRecord[] = [];
  #runs: ConnectorScanRun[] = [];
  #surveys: SurveyCard[] = [];
  #capabilities: WorkspaceCapabilities = { dataWarehouse: { enabled: false }, metadataStore: { engine: "unknown" } };
  #surveyRecords = new Map<string, SurveyRecord>();
  #selectedId: string | null = null;
  #selectedRunId: string | null = null;
  #editingId: string | null = null;
  #view: ConnectorView = "list";
  #active = false;
  #runPollTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(onError: (error: unknown) => void, onMetrics: (metrics: ConnectorMetrics) => void = () => {}) {
    this.#onError = onError;
    this.#onMetrics = onMetrics;
    const registrationForm = byId<HTMLFormElement>("connector-registration-form");
    (registrationForm.elements.namedItem("kind") as HTMLSelectElement).addEventListener("change", () => this.#renderConfigFieldsFrom(registrationForm, true));
    registrationForm.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.#register().catch((error) => notifyWorkspace("Connector 登记失败", error instanceof Error ? error.message : String(error), { tone: "error" }));
    });
    byId<HTMLButtonElement>("connector-form-cancel").addEventListener("click", () => this.#closeCreateDialog());
    byId<HTMLButtonElement>("connector-check-form").addEventListener("click", () => void this.#checkRegistrationInput());
    byId<HTMLButtonElement>("connector-new").addEventListener("click", () => this.#openCreateDialog());
    byId<HTMLButtonElement>("connector-dialog-close").addEventListener("click", () => this.#closeCreateDialog());
    byId<HTMLDialogElement>("connector-create-dialog").addEventListener("cancel", () => this.#resetRegistrationForm());
    byId<HTMLInputElement>("connector-search").addEventListener("input", () => this.#render());
    ["connector-kind-filter", "connector-status-filter", "connector-survey-filter"].forEach((id) => {
      byId<HTMLSelectElement>(id).addEventListener("change", () => this.#render());
    });
    document.querySelectorAll<HTMLButtonElement>("[data-connector-view]").forEach((button) => {
      button.addEventListener("click", () => {
        this.#view = button.dataset.connectorView as ConnectorView;
        this.#render();
      });
    });
    byId<HTMLInputElement>("connector-run-search").addEventListener("input", () => this.#renderHistory());
    ["connector-run-status-filter", "connector-run-kind-filter"].forEach((id) => {
      byId<HTMLSelectElement>(id).addEventListener("change", () => this.#renderHistory());
    });
  }

  async activate(selectedId?: string): Promise<void> {
    this.#active = true;
    const [connectorRecords, surveys, runs, capabilities] = await Promise.all([workspaceApi.connectors(), workspaceApi.surveys(), workspaceApi.connectorIngestRuns(), workspaceApi.capabilities()]);
    this.#records = connectorRecords;
    this.#runs = runs;
    this.#surveys = surveys;
    this.#capabilities = capabilities;
    this.#updateMetrics(runs);
    const records = await Promise.all(this.#surveys.map((survey) => workspaceApi.survey(survey.id)));
    this.#surveyRecords = new Map(records.map((record) => [record.id, record]));
    this.#populateSurveySelects(byId<HTMLFormElement>("connector-registration-form"), "", "");
    this.#populateSurveyFilter();
    if (selectedId && this.#records.some((record) => record.id === selectedId)) {
      this.#selectedId = selectedId;
      this.#view = "list";
    }
    if (!this.#selectedId || !this.#records.some((record) => record.id === this.#selectedId)) this.#selectedId = this.#records[0]?.id ?? null;
    if (!this.#selectedRunId || !this.#runs.some((run) => run.id === this.#selectedRunId)) this.#selectedRunId = this.#runs[0]?.id ?? null;
    this.#resetRegistrationForm();
    this.#render();
  }

  select(id: string): void {
    this.#selectedId = id;
    this.#editingId = null;
    this.#view = "list";
    if (this.#active) this.#render();
  }

  deactivate(): void {
    this.#active = false;
    this.#editingId = null;
    if (this.#runPollTimer) clearTimeout(this.#runPollTimer);
    this.#runPollTimer = undefined;
  }

  #renderConfigFieldsFrom(form: HTMLFormElement, requireNewSecret: boolean): void {
    const kind = (form.elements.namedItem("kind") as HTMLSelectElement).value as ConnectorKind;
    form.querySelectorAll<HTMLElement>("[data-config]").forEach((element) => { element.hidden = element.dataset.config !== kind; });
    (form.elements.namedItem("bucket") as HTMLInputElement | null)?.toggleAttribute("required", kind === "s3");
    (form.elements.namedItem("accessKeyId") as HTMLInputElement | null)?.toggleAttribute("required", kind === "s3");
    (form.elements.namedItem("secretAccessKey") as HTMLInputElement | null)?.toggleAttribute("required", kind === "s3" && requireNewSecret);
    (form.elements.namedItem("rootPath") as HTMLInputElement | null)?.toggleAttribute("required", kind === "local");
    (form.elements.namedItem("url") as HTMLInputElement | null)?.toggleAttribute("required", kind === "jdbc");
  }

  #render(): void {
    if (!this.#active) return;
    document.querySelectorAll<HTMLButtonElement>("[data-connector-view]").forEach((button) => {
      const active = button.dataset.connectorView === this.#view;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
    });
    byId("connector-list-view").hidden = this.#view !== "list";
    byId("connector-history-view").hidden = this.#view !== "history";
    byId("connector-list-search").hidden = this.#view !== "list";
    byId("connector-history-search").hidden = this.#view !== "history";
    byId<HTMLSelectElement>("connector-kind-filter").disabled = this.#view === "history";
    byId<HTMLSelectElement>("connector-status-filter").disabled = this.#view === "history";
    byId<HTMLSelectElement>("connector-survey-filter").disabled = this.#view === "history";
    const facetCount = document.getElementById("connector-filter-count");
    byId("connector-count").textContent = String(this.#records.length);
    byId("connector-draft-count").textContent = String(this.#records.filter((record) => record.status === "draft").length);
    byId("connector-ready-count").textContent = String(this.#records.filter((record) => record.status === "ready" || record.lastCheck?.status === "ok").length);
    if (this.#view === "history") {
      if (facetCount) facetCount.textContent = `${this.#runs.length} 条记录`;
      this.#renderHistory();
      return;
    }
    const records = this.#filteredRecords();
    if (!records.some((record) => record.id === this.#selectedId)) {
      this.#selectedId = records[0]?.id ?? null;
      this.#editingId = null;
    }
    const list = byId("connector-list");
    list.replaceChildren(...records.map((record) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "connector-row";
      row.classList.toggle("selected", record.id === this.#selectedId);
      row.addEventListener("click", () => { this.#selectedId = record.id; this.#editingId = null; this.#render(); if (window.innerWidth <= 1040) byId("inspector-panel").classList.add("mobile-open"); });
      const identity = document.createElement("span");
      const name = document.createElement("strong"); name.textContent = record.name;
      const note = document.createElement("small"); note.textContent = record.description;
      identity.append(name, note);
      const location = document.createElement("span"); location.className = "connector-location"; location.textContent = connectorLocation(record); location.title = connectorLocation(record);
      const kind = document.createElement("span"); kind.textContent = KIND_LABELS[record.kind];
      row.append(identity, location, kind, statusPill(record));
      return row;
    }));
    const empty = byId("connector-empty");
    empty.hidden = records.length > 0;
    empty.textContent = this.#records.length ? "没有符合当前搜索和筛选条件的 Connector。" : "还没有登记 Connector。";
    if (facetCount) facetCount.textContent = `${records.length} / ${this.#records.length}`;
    this.#renderDetail();
  }

  #updateMetrics(runs: ConnectorScanRun[]): void {
    this.#onMetrics({
      total: this.#records.length,
      s3: this.#records.filter((record) => record.kind === "s3").length,
      local: this.#records.filter((record) => record.kind === "local").length,
      jdbc: this.#records.filter((record) => record.kind === "jdbc").length,
      scans: runs.length,
    });
  }

  #connectorForRun(run: ConnectorScanRun): ConnectorPublicRecord | undefined {
    return this.#records.find((record) => record.id === run.connectorId || record.locationKey === run.locationKey);
  }

  #runConnectorKind(run: ConnectorScanRun): ConnectorKind | undefined {
    return run.connectorKind ?? this.#connectorForRun(run)?.kind;
  }

  #runExecutor(run: ConnectorScanRun): string {
    return run.executor ?? (run.jobId ? "Warehouse" : "未注明");
  }

  #filteredRuns(): ConnectorScanRun[] {
    const query = byId<HTMLInputElement>("connector-run-search").value.trim().toLocaleLowerCase();
    const status = byId<HTMLSelectElement>("connector-run-status-filter").value;
    const kind = byId<HTMLSelectElement>("connector-run-kind-filter").value;
    return this.#runs.filter((run) => {
      const connector = this.#connectorForRun(run);
      const runKind = this.#runConnectorKind(run);
      if (status !== "all" && run.status !== status) return false;
      if (kind !== "all" && runKind !== kind) return false;
      if (!query) return true;
      return [run.id, run.jobId, run.batchId, run.assetId, run.assetName, ...(run.assetIds ?? []), run.target?.uri, run.sourcePath, run.esIndex, run.error, run.connectorName, connector?.name, connector?.displayPath, runKind, this.#runExecutor(run)]
        .filter(Boolean).join(" ").toLocaleLowerCase().includes(query);
    });
  }

  #renderHistory(): void {
    if (!this.#active || this.#view !== "history") return;
    const runs = this.#filteredRuns();
    if (!runs.some((run) => run.id === this.#selectedRunId)) this.#selectedRunId = runs[0]?.id ?? null;
    byId("connector-run-filter-count").textContent = `${runs.length} / ${this.#runs.length}`;
    const list = byId("connector-history-list");
    list.replaceChildren(...runs.map((run) => this.#historyRow(run)));
    const empty = byId("connector-history-empty");
    empty.hidden = runs.length > 0;
    empty.textContent = this.#runs.length ? "没有符合当前筛选条件的扫描记录。" : "还没有扫描记录。";
    this.#renderRunDetail();
  }

  #historyRow(run: ConnectorScanRun): HTMLElement {
    const connector = this.#connectorForRun(run);
    const row = document.createElement("button");
    row.type = "button";
    row.className = "connector-history-row";
    row.dataset.status = run.status;
    row.classList.toggle("selected", run.id === this.#selectedRunId);
    row.addEventListener("click", () => {
      this.#selectedRunId = run.id;
      this.#renderHistory();
      if (window.innerWidth <= 1040) byId("inspector-panel").classList.add("mobile-open");
    });
    const identity = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = run.jobId ?? run.batchId ?? run.id;
    const asset = document.createElement("small");
    asset.textContent = run.assetName ?? run.assetIds?.join(" / ") ?? run.assetId ?? "未关联资产";
    identity.append(title, asset);
    const connectorName = document.createElement("span");
    connectorName.textContent = run.connectorName ?? connector?.name ?? "Connector 已删除";
    const executor = document.createElement("span");
    executor.textContent = this.#runExecutor(run);
    const status = document.createElement("span");
    status.className = "connector-run-status";
    status.dataset.status = run.status;
    status.textContent = RUN_STATUS_LABELS[run.status];
    const started = document.createElement("time");
    started.dateTime = run.startedAt ?? "";
    started.textContent = this.#formatDateTime(run.startedAt);
    const progress = document.createElement("span");
    progress.className = "item-progress";
    progress.dataset.status = run.status;
    progress.dataset.mode = run.status === "queued" || run.status === "running" ? "indeterminate" : run.status === "succeeded" ? "complete" : "failed";
    progress.setAttribute("aria-label", run.status === "queued" ? "扫描任务排队中" : run.status === "running" ? "扫描任务运行中" : run.status === "succeeded" ? "扫描任务已成功完成" : "扫描任务失败");
    row.append(identity, connectorName, executor, status, started, progress);
    return row;
  }

  #filteredRecords(): ConnectorPublicRecord[] {
    const query = byId<HTMLInputElement>("connector-search").value.trim().toLocaleLowerCase();
    const kind = byId<HTMLSelectElement>("connector-kind-filter").value;
    const status = byId<HTMLSelectElement>("connector-status-filter").value;
    const survey = byId<HTMLSelectElement>("connector-survey-filter").value;
    return this.#records.filter((record) => {
      if (kind !== "all" && record.kind !== kind) return false;
      if (status !== "all" && record.status !== status) return false;
      if (survey !== "all" && (survey === "unassigned" ? Boolean(record.surveyId) : record.surveyId !== survey)) return false;
      if (!query) return true;
      const config = Object.entries(record.config)
        .filter(([key]) => !SENSITIVE_CONFIG_KEY.test(key))
        .flatMap(([key, value]) => [key, value
          .replace(/\/\/[^/@\s]+@/g, "//")
          .replace(/([?;&](?:auth|credential|secret|password|passphrase|token|access.?key|api.?key|private.?key|session|user(?:name)?)=)[^&;\s]*/gi, "$1")]);
      const searchable = [record.name, record.description, record.kind, record.status, record.displayPath, record.surveyId, record.releaseId, record.locationKey, ...config]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase();
      return searchable.includes(query);
    });
  }

  #populateSurveyFilter(): void {
    const select = byId<HTMLSelectElement>("connector-survey-filter");
    const selected = select.value || "all";
    select.replaceChildren(new Option("全部巡天", "all"), new Option("未标注巡天", "unassigned"));
    this.#surveys.forEach((survey) => select.append(new Option(survey.name, survey.id)));
    const known = new Set(this.#surveys.map((survey) => survey.id));
    for (const surveyId of this.#records.map((record) => record.surveyId).filter((value): value is string => Boolean(value))) {
      if (!known.has(surveyId)) {
        known.add(surveyId);
        select.append(new Option(`${surveyId}（本地标签）`, surveyId));
      }
    }
    select.value = [...select.options].some((option) => option.value === selected) ? selected : "all";
  }

  #openCreateDialog(): void {
    this.#resetRegistrationForm();
    const dialog = byId<HTMLDialogElement>("connector-create-dialog");
    if (!dialog.open) dialog.showModal();
  }

  #closeCreateDialog(): void {
    this.#resetRegistrationForm();
    const dialog = byId<HTMLDialogElement>("connector-create-dialog");
    if (dialog.open) dialog.close();
  }

  #populateSurveySelects(form: HTMLFormElement, selectedSurveyId: string, selectedReleaseId: string): void {
    const surveySelect = form.elements.namedItem("surveyId") as HTMLSelectElement | null;
    const releaseSelect = form.elements.namedItem("releaseId") as HTMLSelectElement | null;
    if (!surveySelect || !releaseSelect) return;
    const previousSurvey = selectedSurveyId || surveySelect.value;
    surveySelect.replaceChildren(new Option("未设置巡天标签", ""));
    this.#surveys.forEach((survey) => surveySelect.append(new Option(survey.name, survey.id)));
    const registeredSurvey = this.#surveys.some((survey) => survey.id === previousSurvey);
    if (previousSurvey && !registeredSurvey) surveySelect.append(new Option(`${previousSurvey}（本地标签）`, previousSurvey));
    surveySelect.value = this.#surveys.some((survey) => survey.id === previousSurvey) ? previousSurvey : "";
    if (previousSurvey && !registeredSurvey) surveySelect.value = previousSurvey;
    const survey = this.#surveyRecords.get(surveySelect.value);
    const previousRelease = selectedReleaseId || releaseSelect.value;
    releaseSelect.replaceChildren(new Option("未设置发布标签", ""));
    survey?.releases.forEach((release) => releaseSelect.append(new Option(release.label, release.id)));
    const registeredRelease = Boolean(survey?.releases.some((release) => release.id === previousRelease));
    if (previousRelease && !registeredRelease) releaseSelect.append(new Option(`${previousRelease}（本地标签）`, previousRelease));
    releaseSelect.value = previousRelease && [...releaseSelect.options].some((option) => option.value === previousRelease) ? previousRelease : "";
    surveySelect.onchange = () => this.#populateSurveySelects(form, surveySelect.value, "");
  }

  #renderDetail(): void {
    const record = this.#records.find((candidate) => candidate.id === this.#selectedId);
    const empty = byId("inspector-empty");
    const content = byId("inspector-content");
    byId("inspector-kicker").textContent = this.#editingId ? "EDIT CONNECTOR" : "CONNECTOR DETAIL";
    if (!record) {
      empty.hidden = false; content.hidden = true; content.replaceChildren();
      byId("connector-detail").hidden = true;
      return;
    }
    empty.hidden = true; content.hidden = false;
    const root = document.createElement("div"); root.className = "connector-inspector-detail";
    if (this.#editingId === record.id) root.append(this.#editForm(record));
    else root.append(...this.#detailView(record));
    content.replaceChildren(root);
    if (this.#editingId !== record.id) createIcons({ icons: { Pencil, Play, SearchCheck, Trash2 }, attrs: { "aria-hidden": "true" } });
  }

  #detailView(record: ConnectorPublicRecord): HTMLElement[] {
    const header = document.createElement("div"); header.className = "connector-detail-header";
    const heading = document.createElement("h2"); heading.textContent = record.name;
    const actions = document.createElement("div"); actions.className = "connector-icon-actions";
    const checkButton = this.#iconButton("检测连接", "search-check", () => void this.#checkSelected(checkButton));
    const editButton = this.#iconButton("编辑配置", "pencil", () => { this.#editingId = record.id; this.#renderDetail(); });
    const deleteButton = this.#iconButton("删除 Connector", "trash-2", () => void this.#remove().catch((error) => notifyWorkspace("Connector 删除失败", error instanceof Error ? error.message : String(error), { tone: "error" })), "danger");
    actions.append(checkButton, editButton, deleteButton);
    header.append(heading, actions);
    const pathValue = document.createElement("code"); pathValue.className = "connector-detail-path"; pathValue.textContent = connectorLocation(record);
    const description = document.createElement("p"); description.className = "catalog-detail-copy"; description.textContent = record.description;
    const summary = document.createElement("dl");
    const rows: Array<[string, string]> = [["类型", KIND_LABELS[record.kind]], ["连接状态", statusPill(record).textContent ?? STATUS_LABELS[record.status]], ["巡天标签", record.surveyId ?? "未设置"], ["发布标签", record.releaseId ?? "未设置"]];
    if (record.kind === "s3") {
      rows.push(["Bucket", record.config.bucket ?? ""], ["Prefix", record.config.prefix || "根目录"], ["Access Key", record.credentials.accessKeyId || "未配置"], ["Secret Key", record.credentials.secretConfigured ? "••••••••••••" : "未配置"]);
    }
    rows.forEach(([label, value]) => {
      const row = document.createElement("div"); const term = document.createElement("dt"); const detail = document.createElement("dd"); term.textContent = label; detail.textContent = value; row.append(term, detail); summary.append(row);
    });
    const scanCommand = this.#scanCommand(record);
    return [header, pathValue, statusPill(record), description, summary, scanCommand];
  }

  #iconButton(label: string, iconName: string, action: () => void, tone = ""): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `icon-button connector-icon-button${tone ? ` ${tone}` : ""}`;
    button.setAttribute("aria-label", label);
    button.title = label;
    const icon = document.createElement("i");
    icon.dataset.lucide = iconName;
    button.append(icon);
    button.addEventListener("click", action);
    return button;
  }

  #scanUnavailableReason(record: ConnectorPublicRecord): string | undefined {
    if (!this.#capabilities.dataWarehouse.enabled) return "数据仓库不可用，当前不能执行扫描。";
    if (record.kind === "local") return "本地路径扫描执行器尚未接入；当前只能查看配置和历史记录。";
    if (record.kind === "jdbc") return "JDBC 扫描执行器尚未接入；当前只能查看配置和历史记录。";
    if (record.status === "disabled") return "Connector 已停用，当前不能执行扫描。";
    if (record.status !== "ready" && record.lastCheck?.status !== "ok") return "请先检测连接并确认 S3 / OSS 可用。";
    if (!record.credentials.accessKeyId || !record.credentials.secretConfigured) return "S3 / OSS 凭据不完整，当前不能执行扫描。";
    return undefined;
  }

  #scanCommand(record: ConnectorPublicRecord): HTMLElement {
    const section = document.createElement("section");
    section.className = "connector-scan-command";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "primary-command connector-execute-scan";
    button.setAttribute("aria-label", "执行扫描");
    const icon = document.createElement("i"); icon.dataset.lucide = "play";
    const label = document.createElement("span"); label.textContent = "执行扫描";
    button.append(icon, label);
    const note = document.createElement("p");
    note.className = "connector-scan-availability";
    const reason = this.#scanUnavailableReason(record);
    button.disabled = Boolean(reason);
    button.title = reason ?? "使用已保存的 Connector 配置执行扫描";
    note.textContent = reason ?? "使用已保存的 S3 / OSS 配置执行扫描；扫描范围由服务端任务定义。";
    button.addEventListener("click", () => void this.#executeScan(record, button));
    section.append(button, note);
    return section;
  }

  async #executeScan(record: ConnectorPublicRecord, button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    notifyWorkspace("正在提交普通扫描任务", `${record.name} · 使用已保存的 S3 / OSS 配置`, { tone: "info" });
    try {
      const submitted = await workspaceApi.executeConnectorScan(record.id);
      this.#runs = await workspaceApi.connectorIngestRuns();
      this.#selectedRunId = submitted.id ?? this.#runs[0]?.id ?? null;
      this.#updateMetrics(this.#runs);
      notifyWorkspace("普通扫描任务已提交", `${record.name} · ${submitted.taskKind === "user_coverage" ? "用户覆盖任务" : "Atlas 用户扫描"}`, { tone: "success" });
    } catch (error) {
      button.disabled = false;
      notifyWorkspace("普通扫描任务提交失败", error instanceof Error ? error.message : String(error), { tone: "error" });
    }
  }

  #editForm(record: ConnectorPublicRecord): HTMLFormElement {
    const form = document.createElement("form"); form.className = "connector-inline-editor";
    form.innerHTML = `<label class="connector-edit-title"><span>名称</span><input name="name" class="field-input" maxlength="120" required></label><label><span>说明</span><textarea name="description" class="field-input" maxlength="500" rows="3"></textarea></label><div class="connector-config-grid"><label><span>类型</span><select name="kind" class="field-input"><option value="s3">S3 / OSS</option><option value="local">本地路径</option><option value="jdbc">JDBC 数据库</option></select></label><label><span>状态</span><select name="status" class="field-input"><option value="draft">草稿</option><option value="ready">可用</option><option value="disabled">停用</option></select></label><label><span>巡天标签</span><select name="surveyId" class="field-input"></select></label><label><span>发布标签</span><select name="releaseId" class="field-input"></select></label></div><div data-config="s3" class="connector-config-grid"><label><span>Endpoint</span><input name="endpoint" class="field-input"></label><label><span>Bucket</span><input name="bucket" class="field-input"></label><label><span>Prefix</span><input name="prefix" class="field-input"></label><label><span>Region</span><input name="region" class="field-input"></label><label><span>Access Key</span><input name="accessKeyId" class="field-input" autocomplete="off"></label><label><span>Secret Key</span><input name="secretAccessKey" class="field-input" type="password" autocomplete="new-password" placeholder="已保存；留空保持不变"></label></div><div data-config="local" class="connector-config-grid" hidden><label><span>根路径</span><input name="rootPath" class="field-input"></label></div><div data-config="jdbc" class="connector-config-grid" hidden><label><span>JDBC URL</span><input name="url" class="field-input"></label><label><span>Database</span><input name="database" class="field-input"></label><label><span>Schema</span><input name="schema" class="field-input"></label></div><div class="detail-editor-actions"><button class="command-button" type="submit">保存修改</button><button class="command-button secondary" type="button" data-cancel>取消</button></div>`;
    const statusControl = form.elements.namedItem("status");
    if (statusControl instanceof HTMLElement) statusControl.closest("label")?.remove();
    const set = (name: string, value: string) => { const element = form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null; if (element) element.value = value; };
    set("name", record.name); set("description", record.description); set("kind", record.kind); set("endpoint", record.config.endpoint ?? ""); set("bucket", record.config.bucket ?? ""); set("prefix", record.config.prefix ?? ""); set("region", record.config.region ?? "us-east-1"); set("accessKeyId", record.credentials.accessKeyId); set("rootPath", record.config.rootPath ?? ""); set("url", record.config.url ?? ""); set("database", record.config.database ?? ""); set("schema", record.config.schema ?? "public");
    this.#populateSurveySelects(form, record.surveyId ?? "", record.releaseId ?? "");
    (form.elements.namedItem("kind") as HTMLSelectElement).addEventListener("change", () => this.#renderConfigFieldsFrom(form, false));
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      notifyWorkspace("正在保存 Connector 修改", record.name, { tone: "info" });
      void this.#saveEdit(record, form).catch((error) => notifyWorkspace("Connector 修改失败", error instanceof Error ? error.message : String(error), { tone: "error" }));
    });
    form.querySelector("[data-cancel]")?.addEventListener("click", () => { this.#editingId = null; this.#renderDetail(); });
    this.#renderConfigFieldsFrom(form, false);
    return form;
  }

  #inputFromForm(form: HTMLFormElement, preservedStatus?: ConnectorStatus): ConnectorRegistrationInput {
    const kind = field(form, "kind") as ConnectorKind;
    const config: Record<string, string> = kind === "s3" ? { endpoint: field(form, "endpoint"), bucket: field(form, "bucket"), prefix: field(form, "prefix"), region: field(form, "region") } : kind === "local" ? { rootPath: field(form, "rootPath") } : { url: field(form, "url"), database: field(form, "database"), schema: field(form, "schema") };
    const secretAccessKey = field(form, "secretAccessKey");
    return { name: field(form, "name"), description: field(form, "description") || undefined, kind, config, surveyId: field(form, "surveyId") || undefined, releaseId: field(form, "releaseId") || undefined, credentials: kind === "s3" ? { accessKeyId: field(form, "accessKeyId"), ...(secretAccessKey ? { secretAccessKey } : {}) } : undefined, ...(preservedStatus ? { status: preservedStatus } : {}) };
  }

  async #register(): Promise<void> {
    const form = byId<HTMLFormElement>("connector-registration-form");
    if (!form.reportValidity()) { notifyWorkspace("Connector 信息不完整", "请补全当前 Connector 所需字段。", { tone: "warning" }); return; }
    notifyWorkspace("正在保存 Connector", field(form, "name"), { tone: "info" });
    const record = await workspaceApi.registerConnector(this.#inputFromForm(form));
    this.#records = await workspaceApi.connectors(); this.#runs = await workspaceApi.connectorIngestRuns(); this.#updateMetrics(this.#runs); this.#selectedId = record.id; this.#closeCreateDialog(); this.#render();
    notifyWorkspace("Connector 已登记", record.name, { tone: "success" });
  }

  async #saveEdit(record: ConnectorPublicRecord, form: HTMLFormElement): Promise<void> {
    if (!form.reportValidity()) return;
    const updated = await workspaceApi.updateConnector(record.id, this.#inputFromForm(form, record.status));
    this.#records = await workspaceApi.connectors(); this.#runs = await workspaceApi.connectorIngestRuns(); this.#updateMetrics(this.#runs); this.#selectedId = updated.id; this.#editingId = null; this.#render();
    notifyWorkspace("Connector 修改已保存", updated.name, { tone: "success" });
  }

  async #checkSelected(button: HTMLButtonElement): Promise<void> {
    const id = this.#selectedId;
    if (!id) return;
    button.disabled = true; button.setAttribute("aria-label", "正在检测连接"); button.title = "正在检测连接";
    notifyWorkspace("正在检测 Connector", this.#records.find((record) => record.id === id)?.name ?? id, { tone: "info" });
    try {
      const result = await workspaceApi.checkConnector(id);
      this.#records = this.#records.map((record) => record.id === id ? result.connector : record);
      this.#runs = await workspaceApi.connectorIngestRuns();
      this.#updateMetrics(this.#runs);
      this.#render();
      notifyWorkspace("Connector 连接检测完成", result.check.summary, { tone: result.check.status === "ok" ? "success" : "warning" });
    } catch (error) {
      button.disabled = false; button.setAttribute("aria-label", "重新检测连接"); button.title = "重新检测连接";
      notifyWorkspace("Connector 连接检测失败", error instanceof Error ? error.message : String(error), { tone: "error" });
    }
  }

  async #checkRegistrationInput(): Promise<void> {
    const form = byId<HTMLFormElement>("connector-registration-form");
    const button = byId<HTMLButtonElement>("connector-check-form");
    if (!form.reportValidity()) { notifyWorkspace("Connector 信息不完整", "请补全路径和凭据后重试。", { tone: "warning" }); return; }
    button.disabled = true; button.textContent = "检测中…";
    notifyWorkspace("正在验证 Connector 配置", field(form, "name") || "新 Connector", { tone: "info" });
    try {
      const check = await workspaceApi.checkConnectorInput(this.#inputFromForm(form));
      notifyWorkspace("Connector 配置检测完成", check.detail ? `${check.summary} · ${check.detail}` : check.summary, { tone: check.status === "ok" ? "success" : "warning" });
    } catch (error) {
      notifyWorkspace("Connector 配置检测失败", error instanceof Error ? error.message : String(error), { tone: "error" });
    } finally {
      button.disabled = false; button.textContent = "检测此配置";
    }
  }

  #formatDateTime(value?: string): string {
    if (!value) return "未记录";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "medium" }).format(date);
  }

  #scheduleRunPoll(): void {
    if (this.#runPollTimer) clearTimeout(this.#runPollTimer);
    this.#runPollTimer = setTimeout(() => {
      this.#runPollTimer = undefined;
      if (!this.#active || this.#view !== "history") return;
      void workspaceApi.connectorIngestRuns().then((runs) => {
        this.#runs = runs;
        this.#updateMetrics(runs);
        this.#renderHistory();
      }).catch((error) => notifyWorkspace("扫描记录刷新失败", error instanceof Error ? error.message : String(error), { tone: "error" }));
    }, 2500);
  }

  #renderRunDetail(): void {
    const run = this.#runs.find((candidate) => candidate.id === this.#selectedRunId);
    const empty = byId("inspector-empty");
    const content = byId("inspector-content");
    byId("inspector-kicker").textContent = "SCAN RUN DETAIL";
    if (!run) {
      empty.hidden = false;
      content.hidden = true;
      content.replaceChildren();
      return;
    }
    const connector = this.#connectorForRun(run);
    const heading = document.createElement("h2");
    heading.textContent = run.jobId ?? run.batchId ?? run.id;
    const status = document.createElement("span");
    status.className = "connector-run-status connector-run-detail-status";
    status.dataset.status = run.status;
    status.textContent = RUN_STATUS_LABELS[run.status];
    const rows: Array<[string, string]> = [
      ["Connector", run.connectorName ?? connector?.name ?? "Connector 已删除"],
      ["类型", this.#runConnectorKind(run) ? KIND_LABELS[this.#runConnectorKind(run)!] : "未注明"],
      ["执行器", this.#runExecutor(run)],
      ["资产", run.assetName ?? run.assetIds?.join(" / ") ?? run.assetId ?? "未关联资产"],
      ["开始时间", this.#formatDateTime(run.startedAt)],
      ["完成时间", this.#formatDateTime(run.completedAt)],
      ["文件数", run.fileCount == null ? "未记录" : String(run.fileCount)],
      ["文档数", run.documentCount == null ? "未记录" : String(run.documentCount)],
      ["源路径", run.target?.uri ?? run.sourcePath ?? "未记录"],
      ["索引", run.esIndex ?? "未记录"],
      ["Batch ID", run.batchId ?? "未记录"],
    ];
    const metadata = document.createElement("dl");
    rows.forEach(([label, value]) => {
      const row = document.createElement("div");
      const term = document.createElement("dt"); term.textContent = label;
      const detail = document.createElement("dd"); detail.textContent = value;
      row.append(term, detail);
      metadata.append(row);
    });
    const error = document.createElement("p");
    error.className = "connector-run-error";
    error.textContent = run.error ?? "";
    error.hidden = !run.error;
    empty.hidden = true;
    content.hidden = false;
    content.replaceChildren(heading, status, metadata, error);
    if (this.#capabilities.dataWarehouse.enabled && this.#runs.some((candidate) => candidate.status === "queued" || candidate.status === "running")) this.#scheduleRunPoll();
  }

  #resetRegistrationForm(): void {
    this.#editingId = null;
    const form = byId<HTMLFormElement>("connector-registration-form"); form.reset();
    (form.elements.namedItem("kind") as HTMLSelectElement).value = "s3";
    (form.elements.namedItem("region") as HTMLInputElement).value = "us-east-1";
    (form.elements.namedItem("schema") as HTMLInputElement).value = "public";
    this.#populateSurveySelects(form, "", "");
    this.#renderConfigFieldsFrom(form, true);
  }

  async #remove(): Promise<void> {
    if (!this.#selectedId) return;
    await workspaceApi.deleteConnector(this.#selectedId);
    this.#records = await workspaceApi.connectors(); this.#runs = await workspaceApi.connectorIngestRuns(); this.#updateMetrics(this.#runs); this.#selectedId = this.#records[0]?.id ?? null; this.#resetRegistrationForm(); this.#render();
    notifyWorkspace("Connector 已删除", "连接配置和其 Atlas 本地引用已移除", { tone: "success" });
  }
}
