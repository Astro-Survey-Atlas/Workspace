import type { ConnectorPublicRecord } from "../../src/connectors";
import type { DataAssetAccess, DataAssetKind, DataAssetLineage, DataAssetProjectState, DataAssetRecord, DataAssetRegistrationInput, DataAssetSource } from "../../src/data-catalog";
import type { TagDefinition } from "../../src/tags";
import type { SurveyCard, SurveyRecord } from "../../src/survey-registry";
import { workspaceApi } from "./api";

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing required element: ${id}`);
  return element as T;
}

function inputValue(id: string): string {
  return byId<HTMLInputElement>(id).value.trim();
}

function statusLabel(status: DataAssetRecord["status"]): string {
  return status === "ready" ? "可访问" : status === "unavailable" ? "不可用" : "仅元数据";
}

const PROJECT_LABELS: Record<DataAssetProjectState, string> = {
  public_reference: "公开参考",
  acquired: "已掌握",
  processed: "已加工",
  deliverable: "可交付",
  planned: "计划中",
};

function projectStatesLabel(asset: DataAssetRecord): string {
  const states = asset.projectStates?.length ? asset.projectStates : [asset.projectState];
  return states.map((state) => PROJECT_LABELS[state]).join(" · ");
}

function connectorLocation(record: ConnectorPublicRecord): string {
  const config = record.config;
  if (record.kind === "local") return config.rootPath ?? "本地路径未配置";
  if (record.kind === "s3") return `${config.endpoint ? `${config.endpoint.replace(/\/$/, "")}/` : "s3://"}${config.bucket ?? ""}${config.prefix ? `/${config.prefix.replace(/^\//, "")}` : ""}`;
  return `${config.url ?? "JDBC URL 未配置"}${config.database ? ` · ${config.database}` : ""}${config.schema ? ` · ${config.schema}` : ""}`;
}

type DetailSection = "basic" | "sources" | "access" | "lineage" | null;

export class DataCatalogPanel {
  readonly #onError: (error: unknown) => void;
  readonly #onConnectorSelected?: (connectorId: string) => void;
  #assets: DataAssetRecord[] = [];
  #connectors: ConnectorPublicRecord[] = [];
  #tags: TagDefinition[] = [];
  #surveys: SurveyCard[] = [];
  #surveyRecords = new Map<string, SurveyRecord>();
  #selectedId: string | null = null;
  #detailEditing: DetailSection = null;
  #active = false;

  constructor(onError: (error: unknown) => void, onConnectorSelected?: (connectorId: string) => void) {
    this.#onError = onError;
    this.#onConnectorSelected = onConnectorSelected;
    byId<HTMLInputElement>("catalog-search").addEventListener("input", () => this.#render());
    byId<HTMLSelectElement>("catalog-kind-filter").addEventListener("change", () => this.#render());
    byId<HTMLSelectElement>("catalog-project-filter").addEventListener("change", () => this.#render());
    byId<HTMLSelectElement>("catalog-survey").addEventListener("change", () => this.#syncReleaseOptions());
    byId<HTMLFormElement>("catalog-registration-form").addEventListener("submit", (event) => {
      event.preventDefault();
      void this.#save().catch(this.#onError);
    });
    byId<HTMLButtonElement>("catalog-form-cancel").addEventListener("click", () => this.#closeCreateDialog());
    byId<HTMLButtonElement>("catalog-dialog-close").addEventListener("click", () => this.#closeCreateDialog());
    byId<HTMLButtonElement>("catalog-new").addEventListener("click", () => this.#startNew());
  }

  async activate(surveys: SurveyCard[], records: Map<string, SurveyRecord>): Promise<void> {
    this.#active = true;
    this.#surveys = surveys;
    this.#surveyRecords = records;
    this.#renderSurveyOptions();
    [this.#assets, this.#connectors, this.#tags] = await Promise.all([this.#loadUserAssets(), workspaceApi.connectors(), workspaceApi.tags()]);
    this.#renderTags();
    if (!this.#selectedId || !this.#assets.some((asset) => asset.id === this.#selectedId)) this.#selectedId = this.#assets[0]?.id ?? null;
    this.#render();
  }

  deactivate(): void { this.#active = false; }

  debugState(): Record<string, unknown> {
    return { catalogAssetCount: this.#assets.length, selectedCatalogAssetId: this.#selectedId };
  }

  async #loadUserAssets(): Promise<DataAssetRecord[]> {
    return (await workspaceApi.dataAssets("user")).filter((asset) => asset.origin === "user");
  }

  #connectorRecordsFor(asset: DataAssetRecord): ConnectorPublicRecord[] {
    const keys = new Set(asset.connectorLocationKeys ?? []);
    const ids = new Set(asset.connectorIds ?? []);
    return this.#connectors.filter((connector) => keys.has(connector.locationKey) || ids.has(connector.id));
  }

  #effectiveSurveyId(asset: DataAssetRecord): string | undefined { return asset.surveyBinding?.surveyId ?? asset.surveyId; }
  #effectiveReleaseId(asset: DataAssetRecord): string | undefined { return asset.surveyBinding?.releaseId ?? asset.releaseId; }

  #resolvedAccesses(asset: DataAssetRecord): DataAssetAccess[] {
    const references = asset.connectorLocationKeys?.length || asset.connectorIds?.length ? this.#connectorRecordsFor(asset) : [];
    const resolved = references.map((connector) => ({ connector: connector.kind, uri: connectorLocation(connector), format: connector.config.format ?? "directory", connectorId: connector.id, label: connector.name }));
    const configured = asset.accesses?.length ? asset.accesses : [asset.access];
    const connectorIds = new Set(configured.map((access) => access.connectorId).filter(Boolean));
    return [...configured, ...resolved.filter((access) => !connectorIds.has(access.connectorId))];
  }

  #filteredAssets(): DataAssetRecord[] {
    const query = inputValue("catalog-search").toLocaleLowerCase();
    const kind = byId<HTMLSelectElement>("catalog-kind-filter").value;
    const project = byId<HTMLSelectElement>("catalog-project-filter").value;
    return this.#assets.filter((asset) => {
      if (kind !== "all" && asset.kind !== kind) return false;
      const projectStates = asset.projectStates?.length ? asset.projectStates : [asset.projectState];
      if (project !== "all" && !projectStates.includes(project as DataAssetProjectState)) return false;
      if (!query) return true;
      const connectorText = this.#connectorRecordsFor(asset).flatMap((connector) => [connector.name, connector.kind, connectorLocation(connector), connector.locationKey, ...Object.values(connector.config)]);
      const sources = (asset.sources ?? []).flatMap((source) => [source.label, source.url, source.description ?? ""]);
      const accesses = this.#resolvedAccesses(asset).flatMap((access) => [access.connector, access.uri, access.format, access.label ?? ""]);
      const tags = (asset.tags ?? asset.modalities).flatMap((tag) => [tag, this.#tagLabel(tag)]);
      const haystack = [asset.name, asset.description, asset.product, this.#effectiveSurveyId(asset), this.#effectiveReleaseId(asset), asset.kind, ...tags, ...sources, ...accesses, ...connectorText].filter(Boolean).join(" ").toLocaleLowerCase();
      return haystack.includes(query);
    });
  }

  #render(): void {
    if (!this.#active) return;
    const assets = this.#filteredAssets();
    if (!assets.some((asset) => asset.id === this.#selectedId)) {
      this.#selectedId = assets[0]?.id ?? null;
      this.#detailEditing = null;
    }
    const list = byId("catalog-asset-list");
    list.replaceChildren(...assets.map((asset) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "catalog-row";
      row.classList.toggle("selected", asset.id === this.#selectedId);
      row.addEventListener("click", () => {
        this.#selectedId = asset.id;
        this.#detailEditing = null;
        this.#render();
        if (window.innerWidth <= 1040) byId("inspector-panel").classList.add("mobile-open");
      });
      const identity = document.createElement("span");
      const name = document.createElement("strong");
      name.textContent = asset.name;
      const product = document.createElement("small");
      product.textContent = `${asset.product} · ${this.#tagText((asset.tags ?? asset.modalities).slice(0, 3)) || "未标注 Tag"}`;
      identity.append(name, product);
      const survey = document.createElement("span");
      survey.className = "catalog-row-survey";
      survey.textContent = this.#surveyName(this.#effectiveSurveyId(asset));
      const kind = document.createElement("span");
      kind.className = "catalog-kind";
      kind.textContent = asset.kind.toUpperCase();
      const status = document.createElement("span");
      status.className = "catalog-status";
      status.dataset.status = asset.projectState;
      status.textContent = projectStatesLabel(asset);
      row.append(identity, survey, kind, status);
      return row;
    }));
    byId("catalog-empty").hidden = assets.length > 0;
    byId("catalog-count").textContent = `${assets.length} / ${this.#assets.length}`;
    const query = inputValue("catalog-search");
    byId("catalog-search-hint").textContent = query
      ? `${assets.length} 个资产命中“${query}” · 搜索名称、来源、Tag、路径和 Connector`
      : `${assets.length} 个资产命中 · 可搜索名称、来源、Tag、路径和 Connector`;
    byId("catalog-user-count").textContent = String(this.#assets.length);
    byId("catalog-ready-count").textContent = String(this.#assets.filter((asset) => asset.status === "ready").length);
    this.#renderInspector();
  }

  #renderInspector(): void {
    const asset = this.#assets.find((candidate) => candidate.id === this.#selectedId);
    const empty = byId("inspector-empty");
    const content = byId("inspector-content");
    byId("inspector-kicker").textContent = "DATA ASSET DETAIL";
    if (!asset) { empty.hidden = false; content.hidden = true; content.replaceChildren(); return; }
    empty.hidden = true;
    content.hidden = false;
    const heading = document.createElement("h2");
    heading.textContent = asset.name;
    const note = document.createElement("p");
    note.className = "catalog-detail-copy";
    note.textContent = asset.description || "暂无说明";
    const basic = this.#detailEditing === "basic" ? this.#basicEditor(asset) : this.#rows([["资产 ID", asset.id], ["来源", asset.origin === "builtin" ? "系统内置" : "用户登记"], ["巡天 / 发布", `${this.#surveyName(this.#effectiveSurveyId(asset))} / ${this.#effectiveReleaseId(asset) ?? "未关联"}`], ["产品 / 类型", `${asset.product} / ${asset.kind}`], ["Tag", this.#tagText(asset.tags ?? asset.modalities) || "未标注"], ["项目阶段", projectStatesLabel(asset)], ["工程状态", statusLabel(asset.status)]]);
    const sourceList = this.#detailEditing === "sources" ? this.#sourceEditor(asset) : document.createElement("ul");
    if (this.#detailEditing !== "sources") { (asset.sources ?? []).forEach((source) => { const item = document.createElement("li"); const link = document.createElement("a"); link.href = source.url; link.target = "_blank"; link.rel = "noreferrer"; link.textContent = `${source.label}: ${source.url}`; item.append(link); source.description && item.append(` · ${source.description}`); sourceList.append(item); }); if (!sourceList.childElementCount) sourceList.textContent = "尚未登记公开来源"; }
    const accessList = this.#detailEditing === "access" ? this.#accessEditor(asset) : document.createElement("ul");
    if (this.#detailEditing !== "access") { this.#resolvedAccesses(asset).forEach((access) => { const item = document.createElement("li"); if (access.connectorId && this.#connectors.some((connector) => connector.id === access.connectorId)) { const link = document.createElement("button"); link.type = "button"; link.className = "access-connector-link"; link.textContent = `${access.label ? `${access.label} · ` : ""}${access.connector} · ${access.uri} · ${access.format}`; link.addEventListener("click", () => this.#onConnectorSelected?.(access.connectorId!)); item.append(link); } else item.textContent = `${access.label ? `${access.label} · ` : ""}${access.connector} · ${access.uri} · ${access.format}`; accessList.append(item); }); if (!accessList.childElementCount) accessList.textContent = "尚未登记访问位置"; }
    const lineage = this.#detailEditing === "lineage" ? this.#lineageEditor(asset) : document.createElement("div"); lineage.classList.add("lineage-detail-tree");
    if (this.#detailEditing !== "lineage") { (asset.lineage ?? []).forEach((entry) => { const item = document.createElement("div"); item.textContent = `${entry.relation} · ${entry.label}`; lineage.append(item); }); if (!lineage.childElementCount) lineage.textContent = "暂无血缘关系。"; }
    const sections = [this.#detailSection("基本信息", basic, "编辑基本信息", () => { this.#detailEditing = "basic"; this.#renderInspector(); }), this.#detailSection("公开来源", sourceList, "编辑公开来源", () => { this.#detailEditing = "sources"; this.#renderInspector(); }), this.#detailSection("访问位置与 Connector", accessList, "编辑 Connector 关联", () => { this.#detailEditing = "access"; this.#renderInspector(); }), this.#detailSection("数据血缘", lineage, "编辑血缘关系", () => { this.#detailEditing = "lineage"; this.#renderInspector(); })];
    if (asset.origin !== "builtin") { const remove = document.createElement("button"); remove.type = "button"; remove.className = "command-button danger"; remove.textContent = "删除数据资产"; remove.addEventListener("click", () => void this.#remove(asset).catch(this.#onError)); sections.push(remove); }
    content.replaceChildren(heading, note, ...sections);
  }

  #renderSurveyOptions(): void {
    const select = byId<HTMLSelectElement>("catalog-survey");
    const current = select.value;
    const none = document.createElement("option"); none.value = ""; none.textContent = "不关联巡天";
    select.replaceChildren(none, ...this.#surveys.map((survey) => { const option = document.createElement("option"); option.value = survey.id; option.textContent = survey.name; return option; }));
    select.value = this.#surveys.some((survey) => survey.id === current) ? current : "";
    this.#syncReleaseOptions();
  }

  #syncReleaseOptions(): void {
    const surveyId = byId<HTMLSelectElement>("catalog-survey").value;
    const select = byId<HTMLSelectElement>("catalog-release");
    const current = select.value;
    const releases = surveyId ? this.#surveyRecords.get(surveyId)?.releases ?? [] : [];
    const none = document.createElement("option"); none.value = ""; none.textContent = "不关联数据发布";
    select.replaceChildren(none, ...releases.map((release) => { const option = document.createElement("option"); option.value = release.id; option.textContent = release.label; return option; }));
    select.value = releases.some((release) => release.id === current) ? current : "";
  }

  #surveyName(id?: string): string { return id ? this.#surveys.find((survey) => survey.id === id)?.name ?? id : "独立数据"; }

  #tagLabel(id: string): string { return this.#tags.find((tag) => tag.id === id)?.label ?? id; }

  #tagText(tags: string[]): string { return tags.map((tag) => this.#tagLabel(tag)).join(" · "); }

  #renderTags(selected: string[] = []): void {
    const root = byId("catalog-tags");
    root.replaceChildren(...this.#tags.map((tag) => {
      const label = document.createElement("label");
      label.className = "tag-option";
      const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.value = tag.id; checkbox.checked = selected.includes(tag.id);
      const text = document.createElement("span"); text.textContent = tag.label;
      label.append(checkbox, text); return label;
    }));
  }

  #selectedTags(): string[] { return [...byId("catalog-tags").querySelectorAll<HTMLInputElement>("input:checked")].map((input) => input.value); }

  #input(): DataAssetRegistrationInput {
    return {
      name: inputValue("catalog-name"), description: inputValue("catalog-description") || undefined,
      surveyId: byId<HTMLSelectElement>("catalog-survey").value || undefined,
      releaseId: byId<HTMLSelectElement>("catalog-release").value || undefined,
      product: inputValue("catalog-product") || undefined,
      kind: byId<HTMLSelectElement>("catalog-kind").value as DataAssetKind,
      tags: this.#selectedTags(), connectorIds: [], connectorLocationKeys: [],
      status: byId<HTMLSelectElement>("catalog-status-input").value as DataAssetRegistrationInput["status"],
      projectStates: this.#readProjectStates(),
    };
  }

  async #save(): Promise<void> {
    const input = this.#input();
    const asset = await workspaceApi.registerDataAsset(input);
    this.#assets = await this.#loadUserAssets();
    this.#selectedId = asset.id;
    this.#closeCreateDialog();
    this.#render();
  }

  #startNew(): void {
    byId<HTMLFormElement>("catalog-registration-form").reset();
    this.#renderSurveyOptions();
    byId<HTMLSelectElement>("catalog-kind").value = "catalog";
    byId<HTMLSelectElement>("catalog-status-input").value = "metadata_only";
    this.#setProjectStates(["public_reference"]);
    this.#renderTags();
    byId("catalog-form-title").textContent = "登记用户数据";
    byId("catalog-form-submit").textContent = "登记数据";
    byId<HTMLDialogElement>("catalog-create-dialog").showModal();
  }

  #closeCreateDialog(): void {
    byId<HTMLFormElement>("catalog-registration-form").reset();
    this.#renderSurveyOptions();
    byId<HTMLSelectElement>("catalog-kind").value = "catalog";
    byId<HTMLSelectElement>("catalog-status-input").value = "metadata_only";
    this.#setProjectStates(["public_reference"]);
    this.#renderTags();
    byId("catalog-form-title").textContent = "登记用户数据";
    byId("catalog-form-submit").textContent = "登记数据";
    const dialog = byId<HTMLDialogElement>("catalog-create-dialog");
    if (dialog.open) dialog.close();
  }

  async #remove(asset: DataAssetRecord): Promise<void> {
    if (asset.origin === "builtin") return;
    await workspaceApi.deleteDataAsset(asset.id);
    this.#assets = await this.#loadUserAssets();
    this.#selectedId = null;
    this.#detailEditing = null;
    this.#render();
  }

  #detailSection(title: string, content: HTMLElement, action: string, callback: () => void): HTMLElement {
    const wrapper = document.createElement("section"); wrapper.className = "asset-detail-section";
    const header = document.createElement("div"); header.className = "asset-detail-section-heading";
    const heading = document.createElement("h3"); heading.textContent = title;
    const button = document.createElement("button"); button.type = "button"; button.className = "text-button"; button.textContent = action; button.addEventListener("click", callback);
    header.append(heading, button); wrapper.append(header, content); return wrapper;
  }

  #rows(items: Array<[string, string]>): HTMLElement {
    const list = document.createElement("dl");
    items.forEach(([label, value]) => { const row = document.createElement("div"); const term = document.createElement("dt"); const detail = document.createElement("dd"); term.textContent = label; detail.textContent = value; row.append(term, detail); list.append(row); });
    return list;
  }

  #assetInput(asset: DataAssetRecord, overrides: Partial<DataAssetRegistrationInput> = {}): DataAssetRegistrationInput {
    return {
      name: asset.name, description: asset.description, surveyId: this.#effectiveSurveyId(asset), releaseId: this.#effectiveReleaseId(asset), product: asset.product, kind: asset.kind,
      tags: asset.tags ?? asset.modalities, connector: asset.access.connector, sourceUri: asset.access.uri, format: asset.access.format,
      accesses: asset.accesses, sources: asset.sources, connectorIds: asset.connectorIds ?? [], connectorLocationKeys: asset.connectorLocationKeys ?? [], status: asset.status, projectStates: asset.projectStates ?? [asset.projectState], footprintIds: asset.footprintIds, ...overrides,
    };
  }

  #saveDetail(input: DataAssetRegistrationInput): void {
    if (!this.#selectedId) return;
    void workspaceApi.updateDataAsset(this.#selectedId, input).then(async () => { this.#assets = await this.#loadUserAssets(); this.#detailEditing = null; this.#render(); }).catch(this.#onError);
  }

  #basicEditor(asset: DataAssetRecord): HTMLElement {
    const form = document.createElement("form"); form.className = "detail-editor";
    form.innerHTML = `<label>名称<input name="name" class="field-input" required></label><label>说明<input name="description" class="field-input"></label><label>数据产品<input name="product" class="field-input"></label><label>类型<select name="kind" class="field-input"><option value="catalog">星表</option><option value="image">图像</option><option value="spectra">光谱</option><option value="cube">数据立方</option><option value="timeseries">时序</option><option value="other">其他</option></select></label><div class="detail-editor-actions"><button class="command-button" type="submit">保存</button><button class="text-button" type="button" data-cancel>取消</button></div>`;
    (form.elements.namedItem("name") as HTMLInputElement).value = asset.name; (form.elements.namedItem("description") as HTMLInputElement).value = asset.description; (form.elements.namedItem("product") as HTMLInputElement).value = asset.product; (form.elements.namedItem("kind") as HTMLSelectElement).value = asset.kind;
    form.addEventListener("submit", (event) => { event.preventDefault(); const data = new FormData(form); this.#saveDetail(this.#assetInput(asset, { name: String(data.get("name") ?? "").trim(), description: String(data.get("description") ?? "").trim(), product: String(data.get("product") ?? "").trim(), kind: String(data.get("kind")) as DataAssetKind })); });
    form.querySelector("[data-cancel]")?.addEventListener("click", () => { this.#detailEditing = null; this.#renderInspector(); }); return form;
  }

  #sourceEditor(asset: DataAssetRecord): HTMLElement {
    const form = document.createElement("form"); form.className = "detail-editor source-detail-editor";
    const rows = (asset.sources ?? []).map((source) => `<div class="detail-source-row"><input class="field-input source-label" value="${source.label.replaceAll('"', "&quot;")}" placeholder="名称"><input class="field-input source-url" value="${source.url.replaceAll('"', "&quot;")}" placeholder="https://..."><input class="field-input source-description" value="${(source.description ?? "").replaceAll('"', "&quot;")}" placeholder="说明"></div>`).join("");
    form.innerHTML = `${rows}<button type="button" class="text-button" data-add-source>添加来源</button><div class="detail-editor-actions"><button class="command-button" type="submit">保存</button><button class="text-button" type="button" data-cancel>取消</button></div>`;
    form.querySelector("[data-add-source]")?.addEventListener("click", () => { const row = document.createElement("div"); row.className = "detail-source-row"; row.innerHTML = `<input class="field-input source-label" placeholder="名称"><input class="field-input source-url" placeholder="https://..."><input class="field-input source-description" placeholder="说明">`; form.insertBefore(row, form.querySelector("[data-add-source]")); });
    form.addEventListener("submit", (event) => { event.preventDefault(); const sources: DataAssetSource[] = [...form.querySelectorAll<HTMLElement>(".detail-source-row")].map((row) => ({ label: (row.querySelector(".source-label") as HTMLInputElement).value.trim(), url: (row.querySelector(".source-url") as HTMLInputElement).value.trim(), description: (row.querySelector(".source-description") as HTMLInputElement).value.trim() || undefined })).filter((source) => source.label && source.url); this.#saveDetail(this.#assetInput(asset, { sources })); });
    form.querySelector("[data-cancel]")?.addEventListener("click", () => { this.#detailEditing = null; this.#renderInspector(); }); return form;
  }

  #accessEditor(asset: DataAssetRecord): HTMLElement {
    const form = document.createElement("form"); form.className = "detail-editor connector-picker";
    form.innerHTML = this.#connectors.length ? this.#connectors.map((connector) => `<label class="connector-option"><input type="checkbox" value="${connector.locationKey}"><span><strong>${connector.name}</strong><small>${connector.kind} · ${connector.displayPath}</small></span></label>`).join("") : "<p class=asset-detail-placeholder>尚未登记 Connector，请先在连接器页面创建。</p>";
    const selected = new Set(asset.connectorLocationKeys?.length ? asset.connectorLocationKeys : this.#connectorRecordsFor(asset).map((connector) => connector.locationKey)); form.querySelectorAll<HTMLInputElement>("input[type=checkbox]").forEach((input) => { input.checked = selected.has(input.value); });
    form.querySelectorAll<HTMLElement>(".connector-option").forEach((option) => {
      const locationKey = option.querySelector<HTMLInputElement>("input")?.value;
      const connector = this.#connectors.find((candidate) => candidate.locationKey === locationKey);
      if (connector) {
        const note = option.querySelector("small");
        if (note) note.textContent = `${connector.kind} · ${connector.displayPath} · ${connector.surveyId ?? "未绑定巡天"}${connector.releaseId ? ` / ${connector.releaseId}` : ""}`;
      }
    });
    const actions = document.createElement("div"); actions.className = "detail-editor-actions"; actions.innerHTML = `<button class="command-button" type="submit">保存关联</button><button class="text-button" type="button" data-cancel>取消</button>`; form.append(actions);
    form.addEventListener("submit", (event) => { event.preventDefault(); const connectorLocationKeys = [...form.querySelectorAll<HTMLInputElement>("input:checked")].map((input) => input.value); const connectorIds = this.#connectors.filter((connector) => connectorLocationKeys.includes(connector.locationKey)).map((connector) => connector.id); this.#saveDetail(this.#assetInput(asset, { connectorIds, connectorLocationKeys })); });
    form.querySelector("[data-cancel]")?.addEventListener("click", () => { this.#detailEditing = null; this.#renderInspector(); }); return form;
  }

  #lineageEditor(asset: DataAssetRecord): HTMLElement {
    const form = document.createElement("form");
    form.className = "detail-editor lineage-editor";
    const rows = document.createElement("div");
    rows.className = "lineage-editor-rows";
    const addRow = (entry: DataAssetLineage = { relation: "derived_from", label: "" }): void => {
      const row = document.createElement("div");
      row.className = "lineage-editor-row";
      row.innerHTML = `<input class="field-input lineage-relation" value="${entry.relation.replaceAll('"', "&quot;")}" placeholder="关系，例如 derived_from"><input class="field-input lineage-label" value="${entry.label.replaceAll('"', "&quot;")}" placeholder="资产或任务名称"><input class="field-input lineage-asset-id" value="${(entry.assetId ?? "").replaceAll('"', "&quot;")}" placeholder="资产 ID（可选）"><button type="button" class="text-button" data-remove-lineage aria-label="删除关系">删除</button>`;
      row.querySelector("[data-remove-lineage]")?.addEventListener("click", () => row.remove());
      rows.append(row);
    };
    (asset.lineage ?? []).forEach((entry) => addRow(entry));
    form.append(rows);
    const add = document.createElement("button");
    add.type = "button"; add.className = "text-button"; add.textContent = "添加血缘关系"; add.addEventListener("click", () => addRow()); form.append(add);
    const actions = document.createElement("div");
    actions.className = "detail-editor-actions";
    actions.innerHTML = `<button class="command-button" type="submit">保存血缘关系</button><button class="text-button" type="button" data-cancel>取消</button>`;
    form.append(actions);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const lineage: DataAssetLineage[] = [...rows.querySelectorAll<HTMLElement>(".lineage-editor-row")].map((row) => ({
        relation: (row.querySelector(".lineage-relation") as HTMLInputElement).value.trim(),
        label: (row.querySelector(".lineage-label") as HTMLInputElement).value.trim(),
        assetId: (row.querySelector(".lineage-asset-id") as HTMLInputElement).value.trim() || undefined,
      })).filter((entry) => entry.relation && entry.label);
      this.#saveDetail(this.#assetInput(asset, { lineage }));
    });
    form.querySelector("[data-cancel]")?.addEventListener("click", () => { this.#detailEditing = null; this.#renderInspector(); });
    return form;
  }

  #setProjectStates(states: DataAssetProjectState[]): void { byId("catalog-project-state-list").querySelectorAll<HTMLInputElement>("input[type=checkbox]").forEach((input) => { input.checked = states.includes(input.value as DataAssetProjectState); }); }
  #readProjectStates(): DataAssetProjectState[] { const states = [...byId("catalog-project-state-list").querySelectorAll<HTMLInputElement>("input:checked")].map((input) => input.value as DataAssetProjectState); return states.length ? states : ["planned"]; }
}
