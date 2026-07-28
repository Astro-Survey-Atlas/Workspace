import type { ConnectorCheck, ConnectorCheckStatus, ConnectorKind, ConnectorPublicRecord, ConnectorRegistrationInput, ConnectorStatus } from "../../src/connectors";
import type { ConnectorIngestRun } from "../../src/connector-history";
import type { DataAssetRecord } from "../../src/data-catalog";
import type { GenericScanInput } from "../../src/flink-ingest";
import { workspaceApi } from "./api";

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing required element: ${id}`);
  return element as T;
}

function field(form: HTMLFormElement, name: string): string {
  return String(new FormData(form).get(name) ?? "").trim();
}

const KIND_LABELS: Record<ConnectorKind, string> = { s3: "S3 / OSS", local: "本地路径", jdbc: "JDBC 数据库" };
const STATUS_LABELS: Record<ConnectorStatus, string> = { draft: "草稿", ready: "可用", disabled: "停用" };

function connectorLocation(record: ConnectorPublicRecord): string { return record.displayPath; }

function statusPill(record: ConnectorPublicRecord): HTMLSpanElement {
  const status = document.createElement("span");
  status.className = "connector-status";
  status.dataset.status = record.lastCheck?.status === "ok" ? "ready" : record.lastCheck?.status === "failed" ? "disabled" : record.status;
  status.textContent = record.lastCheck?.status === "ok" ? "连接正常" : record.lastCheck?.status === "failed" ? "检测失败" : STATUS_LABELS[record.status];
  return status;
}

function setFeedback(target: HTMLElement, status: ConnectorCheckStatus | "checking", summary: string, detail = ""): void {
  target.dataset.status = status;
  const title = document.createElement("strong"); title.textContent = summary;
  const note = document.createElement("small"); note.textContent = detail;
  target.replaceChildren(title, ...(detail ? [note] : []));
}

function checkFeedback(check?: ConnectorCheck): HTMLDivElement {
  const feedback = document.createElement("div");
  feedback.className = "connector-check-feedback";
  feedback.setAttribute("aria-live", "polite");
  if (check) setFeedback(feedback, check.status, check.summary, check.detail ?? "");
  else setFeedback(feedback, "unknown", "尚未检测连接", "测试只验证当前路径和权限，不扫描目录。 ");
  return feedback;
}

export class ConnectorPanel {
  readonly #onError: (error: unknown) => void;
  #records: ConnectorPublicRecord[] = [];
  #assets: DataAssetRecord[] = [];
  #selectedId: string | null = null;
  #editingId: string | null = null;
  #active = false;
  #detailGeneration = 0;
  #runPollTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(onError: (error: unknown) => void) {
    this.#onError = onError;
    byId<HTMLSelectElement>("connector-kind").addEventListener("change", () => this.#renderConfigFieldsFrom(byId<HTMLFormElement>("connector-registration-form"), true));
    byId<HTMLFormElement>("connector-registration-form").addEventListener("submit", (event) => {
      event.preventDefault();
      void this.#register().catch((error) => this.#registrationFeedback("failed", "登记失败", error));
    });
    byId<HTMLButtonElement>("connector-form-cancel").addEventListener("click", () => this.#resetRegistrationForm());
    byId<HTMLButtonElement>("connector-delete").addEventListener("click", () => void this.#remove().catch(this.#onError));
    byId<HTMLButtonElement>("connector-check-form").addEventListener("click", () => void this.#checkRegistrationInput());
  }

  async activate(selectedId?: string): Promise<void> {
    this.#active = true;
    [this.#records, this.#assets] = await Promise.all([workspaceApi.connectors(), workspaceApi.dataAssets()]);
    if (selectedId && this.#records.some((record) => record.id === selectedId)) this.#selectedId = selectedId;
    if (!this.#selectedId || !this.#records.some((record) => record.id === this.#selectedId)) this.#selectedId = this.#records[0]?.id ?? null;
    this.#resetRegistrationForm();
    this.#render();
  }

  select(id: string): void {
    this.#selectedId = id;
    this.#editingId = null;
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
    const list = byId("connector-list");
    list.replaceChildren(...this.#records.map((record) => {
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
    byId("connector-empty").hidden = this.#records.length > 0;
    byId("connector-count").textContent = String(this.#records.length);
    byId("connector-draft-count").textContent = String(this.#records.filter((record) => record.status === "draft").length);
    byId("connector-ready-count").textContent = String(this.#records.filter((record) => record.status === "ready" || record.lastCheck?.status === "ok").length);
    this.#renderDetail();
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
    if (this.#editingId !== record.id) root.append(this.#scanForm(record));
    const runsHeading = document.createElement("div"); runsHeading.className = "section-heading connector-runs-heading"; runsHeading.innerHTML = "<span>FlinkIngest / 扫描记录</span>";
    const runs = document.createElement("div"); runs.className = "connector-runs"; runs.textContent = "载入记录…";
    root.append(runsHeading, runs);
    content.replaceChildren(root);
    void this.#loadRuns(record, runs);
  }

  #assetsFor(record: ConnectorPublicRecord): DataAssetRecord[] {
    const locationKey = record.locationKey;
    return this.#assets.filter((asset) => asset.connectorLocationKeys?.includes(locationKey) || asset.connectorIds?.includes(record.id));
  }

  #scanForm(record: ConnectorPublicRecord): HTMLElement {
    const section = document.createElement("section");
    section.className = "connector-scan-section";
    const heading = document.createElement("div");
    heading.className = "section-heading";
    heading.innerHTML = "<span>扫描数据</span><span>FLINKINGEST</span>";
    section.append(heading);
    const note = document.createElement("p");
    note.className = "connector-scan-note";
    note.textContent = record.kind === "s3"
      ? "选择已关联的数据资产，声明文件路径和空间信息。扫描只写入文件元数据；有 RA/Dec、FITS WCS 或 NESTED HEALPix 才会进入天球覆盖。"
      : "当前扫描任务先支持 S3 / OSS；本地路径和 JDBC Connector 可以先登记，后续接入对应扫描器。";
    section.append(note);
    if (record.kind !== "s3") return section;
    const assets = this.#assetsFor(record);
    if (!assets.length) {
      const empty = document.createElement("p");
      empty.className = "connector-scan-empty";
      empty.textContent = "没有与此 Connector 关联的数据资产。请先在数据目录 → 数据资产详情 → 访问位置中关联它。";
      section.append(empty);
      return section;
    }
    const form = document.createElement("form");
    form.className = "connector-scan-form";
    form.innerHTML = `<label><span>数据资产</span><select name="assetId" class="field-input" required></select></label>
      <label><span>扫描路径</span><input name="path" class="field-input" required></label>
      <label><span>文件后缀</span><input name="suffixes" class="field-input" value=".fits,.csv,.tsv" placeholder=".fits,.csv 或留空接收全部"></label>
      <label><span>空间模式</span><select name="spatialMode" class="field-input"><option value="auto">自动（FITS WCS / 已知策略）</option><option value="catalog">目录 RA / Dec</option><option value="healpix">目录 NESTED HEALPix 列</option><option value="none">无空间信息</option></select></label>
      <div class="connector-scan-catalog-fields" data-spatial-fields hidden>
        <label data-coordinate-field><span>RA 列</span><input name="raColumn" class="field-input" placeholder="ra" /></label>
        <label data-coordinate-field><span>Dec 列</span><input name="decColumn" class="field-input" placeholder="dec" /></label>
        <label data-healpix-field hidden><span>HEALPix 列</span><input name="healpixColumn" class="field-input" placeholder="healpix_pixel" /></label>
        <label><span>坐标系</span><input name="frame" class="field-input" value="ICRS" /></label>
        <label><span>单位</span><select name="units" class="field-input"><option value="deg">度（deg）</option><option value="rad">弧度（rad）</option><option value="hourangle">时角（hourangle）</option></select></label>
        <label><span>覆盖含义</span><select name="role" class="field-input"><option value="object_presence">对象存在</option><option value="catalog_core">目录核心</option><option value="observed_area">观测区域</option><option value="image_extent">图像范围</option></select></label>
      </div>
      <output class="connector-scan-feedback" aria-live="polite"></output>
      <button class="command-button" type="submit">提交扫描任务</button>`;
    const assetSelect = form.elements.namedItem("assetId") as HTMLSelectElement;
    assets.forEach((asset) => { const option = document.createElement("option"); option.value = asset.id; option.textContent = `${asset.name} · ${asset.kind}`; assetSelect.append(option); });
    const pathInput = form.elements.namedItem("path") as HTMLInputElement;
    pathInput.value = record.config.prefix ?? "";
    const modeSelect = form.elements.namedItem("spatialMode") as HTMLSelectElement;
    const spatialFields = form.querySelector<HTMLElement>("[data-spatial-fields]")!;
    const coordinateFields = [...form.querySelectorAll<HTMLElement>("[data-coordinate-field]")];
    const healpixFields = [...form.querySelectorAll<HTMLElement>("[data-healpix-field]")];
    const toggleCatalogFields = () => {
      const catalog = modeSelect.value === "catalog";
      const healpix = modeSelect.value === "healpix";
      spatialFields.hidden = !catalog && !healpix;
      coordinateFields.forEach((element) => { element.hidden = !catalog; });
      healpixFields.forEach((element) => { element.hidden = !healpix; });
    };
    modeSelect.addEventListener("change", toggleCatalogFields);
    toggleCatalogFields();
    form.addEventListener("submit", (event) => { event.preventDefault(); void this.#submitScan(record, form); });
    section.append(form);
    return section;
  }

  async #submitScan(record: ConnectorPublicRecord, form: HTMLFormElement): Promise<void> {
    const output = form.querySelector<HTMLOutputElement>(".connector-scan-feedback")!;
    const submit = form.querySelector<HTMLButtonElement>("button[type=submit]")!;
    if (!form.reportValidity()) return;
    const mode = field(form, "spatialMode") as NonNullable<GenericScanInput["spatial"]>["mode"];
    const raColumn = field(form, "raColumn");
    const decColumn = field(form, "decColumn");
    const healpixColumn = field(form, "healpixColumn");
    if (mode === "catalog" && (!raColumn || !decColumn)) {
      setFeedback(output, "failed", "空间字段不完整", "目录模式必须填写 RA 列和 Dec 列。 ");
      return;
    }
    if (mode === "healpix" && !healpixColumn) {
      setFeedback(output, "failed", "空间字段不完整", "HEALPix 模式必须填写 NESTED pixel 列。 ");
      return;
    }
    const suffixes = field(form, "suffixes").split(",").map((suffix) => suffix.trim().toLowerCase()).filter(Boolean);
    const spatial: GenericScanInput["spatial"] = { mode };
    if (mode === "catalog") {
      spatial.raColumn = raColumn;
      spatial.decColumn = decColumn;
      spatial.frame = field(form, "frame") || "ICRS";
      spatial.units = field(form, "units") || "deg";
      spatial.role = field(form, "role") || "object_presence";
      spatial.healpixOrder = 8;
    }
    if (mode === "healpix") {
      spatial.healpixColumn = healpixColumn;
      spatial.frame = field(form, "frame") || "ICRS";
      spatial.role = field(form, "role") || "object_presence";
      spatial.healpixOrder = 8;
    }
    const input: GenericScanInput = { assetId: field(form, "assetId"), path: field(form, "path") || undefined, allowedSuffixes: suffixes.length ? suffixes : undefined, spatial };
    submit.disabled = true;
    setFeedback(output, "checking", "正在提交扫描任务…", "FlinkIngest 会在后台遍历路径并批量写入 Elasticsearch。 ");
    try {
      const run = await workspaceApi.submitConnectorScan(record.id, input);
      setFeedback(output, "ok", "扫描任务已提交", `${run.jobId ?? run.batchId ?? "任务已创建"}；请在下方查看状态。 `);
      this.#renderDetail();
    } catch (error) {
      submit.disabled = false;
      setFeedback(output, "failed", "扫描任务提交失败", error instanceof Error ? error.message : String(error));
    }
  }

  #detailView(record: ConnectorPublicRecord): HTMLElement[] {
    const heading = document.createElement("h2"); heading.textContent = record.name;
    const pathValue = document.createElement("code"); pathValue.className = "connector-detail-path"; pathValue.textContent = connectorLocation(record);
    const description = document.createElement("p"); description.className = "catalog-detail-copy"; description.textContent = record.description;
    const summary = document.createElement("dl");
    const rows: Array<[string, string]> = [["类型", KIND_LABELS[record.kind]], ["状态", STATUS_LABELS[record.status]]];
    if (record.kind === "s3") {
      rows.push(["Bucket", record.config.bucket ?? ""], ["Prefix", record.config.prefix || "根目录"], ["Access Key", record.credentials.accessKeyId || "未配置"], ["Secret Key", record.credentials.secretConfigured ? "••••••••••••" : "未配置"]);
    }
    rows.forEach(([label, value]) => {
      const row = document.createElement("div"); const term = document.createElement("dt"); const detail = document.createElement("dd"); term.textContent = label; detail.textContent = value; row.append(term, detail); summary.append(row);
    });
    const feedback = checkFeedback(record.lastCheck);
    const actions = document.createElement("div"); actions.className = "inspector-actions";
    const scanButton = document.createElement("button"); scanButton.type = "button"; scanButton.className = "command-button"; scanButton.textContent = "启动小批扫描";
    scanButton.title = "扫描 102018211 tile 下的三份 MER FITS 文件";
    scanButton.addEventListener("click", () => void this.#submitPilot(scanButton, feedback));
    const checkButton = document.createElement("button"); checkButton.type = "button"; checkButton.className = "command-button"; checkButton.textContent = "检测连接";
    checkButton.addEventListener("click", () => void this.#checkSelected(checkButton, feedback));
    const editButton = document.createElement("button"); editButton.type = "button"; editButton.className = "command-button secondary"; editButton.textContent = "编辑配置"; editButton.addEventListener("click", () => { this.#editingId = record.id; this.#renderDetail(); });
    const deleteButton = document.createElement("button"); deleteButton.type = "button"; deleteButton.className = "command-button danger"; deleteButton.textContent = "删除"; deleteButton.addEventListener("click", () => void this.#remove().catch(this.#onError));
    const hasEuclidPilot = this.#assetsFor(record).some((asset) => asset.id === "euclid-q1-mer-final" || asset.id === "euclid-q1-mer-cutouts-cat" || asset.id === "euclid-q1-mer-morph-cat");
    actions.append(...(hasEuclidPilot ? [scanButton] : []), checkButton, editButton, deleteButton);
    return [heading, pathValue, statusPill(record), description, summary, feedback, actions];
  }

  async #submitPilot(button: HTMLButtonElement, feedback: HTMLElement): Promise<void> {
    const id = this.#selectedId;
    if (!id) return;
    button.disabled = true;
    button.textContent = "提交中…";
    setFeedback(feedback, "checking", "正在提交三条 FlinkIngest 小批任务…");
    try {
      await workspaceApi.submitConnectorPilotScan(id);
      this.#records = await workspaceApi.connectors();
      setFeedback(feedback, "ok", "小批任务已提交", "将在下方扫描记录中显示 Flink 状态和 ES 文档数。 ");
      this.#render();
    } catch (error) {
      button.disabled = false;
      button.textContent = "启动小批扫描";
      setFeedback(feedback, "failed", "小批扫描提交失败", error instanceof Error ? error.message : String(error));
    }
  }

  #editForm(record: ConnectorPublicRecord): HTMLFormElement {
    const form = document.createElement("form"); form.className = "connector-inline-editor";
    form.innerHTML = `<label class="connector-edit-title"><span>名称</span><input name="name" class="field-input" maxlength="120" required></label><label><span>说明</span><textarea name="description" class="field-input" maxlength="500" rows="3"></textarea></label><div class="connector-config-grid"><label><span>类型</span><select name="kind" class="field-input"><option value="s3">S3 / OSS</option><option value="local">本地路径</option><option value="jdbc">JDBC 数据库</option></select></label><label><span>状态</span><select name="status" class="field-input"><option value="draft">草稿</option><option value="ready">可用</option><option value="disabled">停用</option></select></label></div><div data-config="s3" class="connector-config-grid"><label><span>Endpoint</span><input name="endpoint" class="field-input"></label><label><span>Bucket</span><input name="bucket" class="field-input"></label><label><span>Prefix</span><input name="prefix" class="field-input"></label><label><span>Region</span><input name="region" class="field-input"></label><label><span>Access Key</span><input name="accessKeyId" class="field-input" autocomplete="off"></label><label><span>Secret Key</span><input name="secretAccessKey" class="field-input" type="password" autocomplete="new-password" placeholder="已保存；留空保持不变"></label></div><div data-config="local" class="connector-config-grid" hidden><label><span>根路径</span><input name="rootPath" class="field-input"></label></div><div data-config="jdbc" class="connector-config-grid" hidden><label><span>JDBC URL</span><input name="url" class="field-input"></label><label><span>Database</span><input name="database" class="field-input"></label><label><span>Schema</span><input name="schema" class="field-input"></label></div><output class="connector-edit-feedback" aria-live="polite"></output><div class="detail-editor-actions"><button class="command-button" type="submit">保存修改</button><button class="command-button secondary" type="button" data-cancel>取消</button></div>`;
    const set = (name: string, value: string) => { const element = form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null; if (element) element.value = value; };
    set("name", record.name); set("description", record.description); set("kind", record.kind); set("status", record.status); set("endpoint", record.config.endpoint ?? ""); set("bucket", record.config.bucket ?? ""); set("prefix", record.config.prefix ?? ""); set("region", record.config.region ?? "us-east-1"); set("accessKeyId", record.credentials.accessKeyId); set("rootPath", record.config.rootPath ?? ""); set("url", record.config.url ?? ""); set("database", record.config.database ?? ""); set("schema", record.config.schema ?? "public");
    (form.elements.namedItem("kind") as HTMLSelectElement).addEventListener("change", () => this.#renderConfigFieldsFrom(form, false));
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const output = form.querySelector<HTMLOutputElement>(".connector-edit-feedback")!;
      setFeedback(output, "checking", "正在保存…");
      void this.#saveEdit(record, form).catch((error) => setFeedback(output, "failed", "保存失败", error instanceof Error ? error.message : String(error)));
    });
    form.querySelector("[data-cancel]")?.addEventListener("click", () => { this.#editingId = null; this.#renderDetail(); });
    this.#renderConfigFieldsFrom(form, false);
    return form;
  }

  #inputFromForm(form: HTMLFormElement): ConnectorRegistrationInput {
    const kind = field(form, "kind") as ConnectorKind;
    const config: Record<string, string> = kind === "s3" ? { endpoint: field(form, "endpoint"), bucket: field(form, "bucket"), prefix: field(form, "prefix"), region: field(form, "region") } : kind === "local" ? { rootPath: field(form, "rootPath") } : { url: field(form, "url"), database: field(form, "database"), schema: field(form, "schema") };
    const secretAccessKey = field(form, "secretAccessKey");
    return { name: field(form, "name"), description: field(form, "description") || undefined, kind, config, credentials: kind === "s3" ? { accessKeyId: field(form, "accessKeyId"), ...(secretAccessKey ? { secretAccessKey } : {}) } : undefined, status: field(form, "status") as ConnectorStatus };
  }

  async #register(): Promise<void> {
    const form = byId<HTMLFormElement>("connector-registration-form");
    if (!form.reportValidity()) { this.#registrationFeedback("failed", "信息不完整", "请补全当前 Connector 所需字段。 "); return; }
    this.#registrationFeedback("checking", "正在保存 Connector…");
    const record = await workspaceApi.registerConnector(this.#inputFromForm(form));
    this.#records = await workspaceApi.connectors(); this.#selectedId = record.id; this.#resetRegistrationForm(); this.#render();
  }

  async #saveEdit(record: ConnectorPublicRecord, form: HTMLFormElement): Promise<void> {
    if (!form.reportValidity()) return;
    const updated = await workspaceApi.updateConnector(record.id, this.#inputFromForm(form));
    this.#records = await workspaceApi.connectors(); this.#selectedId = updated.id; this.#editingId = null; this.#render();
  }

  async #checkSelected(button: HTMLButtonElement, feedback: HTMLElement): Promise<void> {
    const id = this.#selectedId;
    if (!id) return;
    button.disabled = true; button.textContent = "检测中…"; setFeedback(feedback, "checking", "正在验证已保存凭据和访问权限…");
    try {
      const result = await workspaceApi.checkConnector(id);
      this.#records = this.#records.map((record) => record.id === id ? result.connector : record);
      this.#render();
    } catch (error) {
      button.disabled = false; button.textContent = "重新检测";
      setFeedback(feedback, "failed", "连接检测失败", error instanceof Error ? error.message : String(error));
    }
  }

  async #checkRegistrationInput(): Promise<void> {
    const form = byId<HTMLFormElement>("connector-registration-form");
    const button = byId<HTMLButtonElement>("connector-check-form");
    if (!form.reportValidity()) { this.#registrationFeedback("failed", "信息不完整", "请补全路径和凭据后重试。 "); return; }
    button.disabled = true; button.textContent = "检测中…"; this.#registrationFeedback("checking", "正在验证连接与权限…");
    try {
      const check = await workspaceApi.checkConnectorInput(this.#inputFromForm(form));
      this.#registrationFeedback(check.status, check.summary, check.detail ?? "");
    } catch (error) {
      this.#registrationFeedback("failed", "连接检测失败", error);
    } finally {
      button.disabled = false; button.textContent = "检测此配置";
    }
  }

  #registrationFeedback(status: ConnectorCheckStatus | "checking", summary: string, detail?: unknown): void {
    setFeedback(byId("connector-form-message"), status, summary, detail instanceof Error ? detail.message : typeof detail === "string" ? detail : "");
  }

  async #loadRuns(record: ConnectorPublicRecord, target: HTMLElement): Promise<void> {
    const generation = ++this.#detailGeneration;
    try {
      const runs = await workspaceApi.connectorRuns(record.id);
      if (!this.#active || generation !== this.#detailGeneration || this.#selectedId !== record.id) return;
      target.replaceChildren(...(runs.length ? runs.map((run) => this.#runRow(run)) : [this.#emptyRunRow()]));
      if (runs.some((run) => run.status === "queued" || run.status === "running")) this.#scheduleRunPoll(record);
    } catch (error) { target.textContent = error instanceof Error ? error.message : String(error); }
  }

  #scheduleRunPoll(record: ConnectorPublicRecord): void {
    if (this.#runPollTimer) clearTimeout(this.#runPollTimer);
    this.#runPollTimer = setTimeout(() => {
      this.#runPollTimer = undefined;
      if (this.#active && this.#selectedId === record.id && !this.#editingId) this.#renderDetail();
    }, 2500);
  }

  #runRow(run: ConnectorIngestRun): HTMLElement {
    const row = document.createElement("div"); row.className = "connector-run-row";
    const title = document.createElement("strong"); title.textContent = run.jobId ?? run.batchId ?? run.id;
    const meta = document.createElement("small"); meta.textContent = `${run.status} · ${run.assetName ?? "未绑定资产"} · ${run.fileCount ?? 0} files`;
    row.append(title, meta); return row;
  }

  #emptyRunRow(): HTMLElement { const row = document.createElement("div"); row.className = "connector-run-empty"; row.textContent = "还没有 FlinkIngest / 扫描记录。"; return row; }

  #resetRegistrationForm(): void {
    this.#editingId = null;
    const form = byId<HTMLFormElement>("connector-registration-form"); form.reset();
    (form.elements.namedItem("kind") as HTMLSelectElement).value = "s3";
    (form.elements.namedItem("status") as HTMLSelectElement).value = "draft";
    (form.elements.namedItem("region") as HTMLInputElement).value = "us-east-1";
    (form.elements.namedItem("schema") as HTMLInputElement).value = "public";
    this.#renderConfigFieldsFrom(form, true);
    this.#registrationFeedback("unknown", "尚未检测", "填写后可先检测连接，也可以直接登记。 ");
  }

  async #remove(): Promise<void> {
    if (!this.#selectedId) return;
    await workspaceApi.deleteConnector(this.#selectedId);
    this.#records = await workspaceApi.connectors(); this.#selectedId = this.#records[0]?.id ?? null; this.#resetRegistrationForm(); this.#render();
  }
}
