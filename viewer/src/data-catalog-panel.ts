import type { ConnectorPublicRecord } from "../../src/connectors";
import type { DataAssetAccess, DataAssetKind, DataAssetLineage, DataAssetProjectState, DataAssetRecord, DataAssetRegistrationInput, DataAssetSource } from "../../src/data-catalog";
import type { TagDefinition } from "../../src/tags";
import type { SurveyCard, SurveyRecord } from "../../src/survey-registry";
import { workspaceApi, type LocalCsvInspection } from "./api";
import { notifyWorkspace } from "./notifications";

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing required element: ${id}`);
  return element as T;
}

function inputValue(id: string): string {
  return byId<HTMLInputElement>(id).value.trim();
}

const PROJECT_LABELS: Record<DataAssetProjectState, string> = {
  public_reference: "公开参考",
  acquired: "已获取",
  processed: "已加工",
  deliverable: "可用",
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
  readonly #onNewConnector?: () => void;
  readonly #onAssetChanged?: (assetId: string) => void | Promise<void>;
  #assets: DataAssetRecord[] = [];
  #connectors: ConnectorPublicRecord[] = [];
  #tags: TagDefinition[] = [];
  #surveys: SurveyCard[] = [];
  #surveyRecords = new Map<string, SurveyRecord>();
  #selectedId: string | null = null;
  #detailEditing: DetailSection = null;
  #active = false;
  #scanInspection: LocalCsvInspection | null = null;
  #scanConnectorId: string | null = null;

  constructor(onError: (error: unknown) => void, onConnectorSelected?: (connectorId: string) => void, onNewConnector?: () => void, onAssetChanged?: (assetId: string) => void | Promise<void>) {
    this.#onError = onError;
    this.#onConnectorSelected = onConnectorSelected;
    this.#onNewConnector = onNewConnector;
    this.#onAssetChanged = onAssetChanged;
    byId<HTMLInputElement>("catalog-search").addEventListener("input", () => this.#render());
    byId<HTMLSelectElement>("catalog-kind-filter").addEventListener("change", () => this.#render());
    byId<HTMLSelectElement>("catalog-project-filter").addEventListener("change", () => this.#render());
    byId<HTMLSelectElement>("catalog-survey").addEventListener("change", () => this.#syncReleaseOptions());
    byId<HTMLFormElement>("catalog-registration-form").addEventListener("submit", (event) => {
      event.preventDefault();
      void this.#save().catch((error) => notifyWorkspace("用户资产登记失败", error instanceof Error ? error.message : String(error), { tone: "error" }));
    });
    byId<HTMLButtonElement>("catalog-form-cancel").addEventListener("click", () => this.#closeCreateDialog());
    byId<HTMLButtonElement>("catalog-dialog-close").addEventListener("click", () => this.#closeCreateDialog());
    byId<HTMLButtonElement>("catalog-new").addEventListener("click", () => this.#startNew());
    byId<HTMLButtonElement>("catalog-new-connector").addEventListener("click", () => {
      this.#closeCreateDialog();
      this.#onNewConnector?.();
    });
    byId<HTMLButtonElement>("catalog-inspect-file").addEventListener("click", () => void this.#inspectSelectedFile().catch((error) => notifyWorkspace("本地文件检查失败", error instanceof Error ? error.message : String(error), { tone: "error" })));
  }

  async activate(surveys: SurveyCard[], records: Map<string, SurveyRecord>): Promise<void> {
    this.#active = true;
    this.#surveys = surveys;
    this.#surveyRecords = records;
    this.#renderSurveyOptions();
    [this.#assets, this.#connectors, this.#tags] = await Promise.all([this.#loadUserAssets(), workspaceApi.connectors(), workspaceApi.tags()]);
    this.#renderCreateConnectors();
    if (!this.#selectedId || !this.#assets.some((asset) => asset.id === this.#selectedId)) this.#selectedId = this.#assets[0]?.id ?? null;
    this.#render();
  }

  deactivate(): void { this.#active = false; }

  debugState(): Record<string, unknown> {
    return { catalogAssetCount: this.#assets.length, selectedCatalogAssetId: this.#selectedId };
  }

  startNew(surveyId?: string): void {
    this.#startNew(surveyId);
  }

  async #loadUserAssets(): Promise<DataAssetRecord[]> {
    return workspaceApi.dataAssets();
  }

  #connectorRecordsFor(asset: DataAssetRecord): ConnectorPublicRecord[] {
    const keys = new Set(asset.connectorLocationKeys ?? []);
    const ids = new Set(asset.connectorIds ?? []);
    return this.#connectors.filter((connector) => keys.has(connector.locationKey) || ids.has(connector.id));
  }

  #effectiveSurveyId(asset: DataAssetRecord): string | undefined { return asset.surveyId; }
  #effectiveReleaseId(asset: DataAssetRecord): string | undefined { return asset.releaseId; }

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
     content.classList.add("catalog-inspector-content");
    const heading = document.createElement("h2");
    heading.textContent = asset.name;
    const note = document.createElement("p");
    note.className = "catalog-detail-copy";
    note.textContent = asset.description || "暂无说明";
    const basic = this.#detailEditing === "basic" ? this.#basicEditor(asset) : this.#rows([["资产 ID", asset.id], ["来源", "用户登记"], ["巡天 / 发布", `${this.#surveyName(this.#effectiveSurveyId(asset))} / ${this.#effectiveReleaseId(asset) ?? "未设置"}`], ["产品 / 类型", `${asset.product} / ${asset.kind}`], ["Tag", this.#tagText(asset.tags ?? asset.modalities) || "未标注"], ["使用阶段", projectStatesLabel(asset)]]);
    const sourceList = this.#detailEditing === "sources" ? this.#sourceEditor(asset) : document.createElement("ul");
    if (this.#detailEditing !== "sources") { (asset.sources ?? []).forEach((source) => { const item = document.createElement("li"); const link = document.createElement("a"); link.href = source.url; link.target = "_blank"; link.rel = "noreferrer"; link.textContent = `${source.label}: ${source.url}`; item.append(link); source.description && item.append(` · ${source.description}`); sourceList.append(item); }); if (!sourceList.childElementCount) sourceList.textContent = "尚未登记公开来源"; }
    const accessList = this.#detailEditing === "access" ? this.#accessEditor(asset) : document.createElement("ul");
    if (this.#detailEditing !== "access") { this.#resolvedAccesses(asset).forEach((access) => { const item = document.createElement("li"); if (access.connectorId && this.#connectors.some((connector) => connector.id === access.connectorId)) { const link = document.createElement("button"); link.type = "button"; link.className = "access-connector-link"; link.textContent = `${access.label ? `${access.label} · ` : ""}${access.connector} · ${access.uri} · ${access.format}`; link.addEventListener("click", () => this.#onConnectorSelected?.(access.connectorId!)); item.append(link); } else item.textContent = `${access.label ? `${access.label} · ` : ""}${access.connector} · ${access.uri} · ${access.format}`; accessList.append(item); }); if (!accessList.childElementCount) accessList.textContent = "尚未登记访问位置"; }
    const lineage = this.#detailEditing === "lineage" ? this.#lineageEditor(asset) : document.createElement("div"); lineage.classList.add("lineage-detail-tree");
    if (this.#detailEditing !== "lineage") { (asset.lineage ?? []).forEach((entry) => { const item = document.createElement("div"); item.textContent = `${entry.relation} · ${entry.label}`; lineage.append(item); }); if (!lineage.childElementCount) lineage.textContent = "暂无血缘关系。"; }
    const sections = [this.#detailSection("基本信息", basic, "编辑基本信息", () => { this.#detailEditing = "basic"; this.#renderInspector(); }), this.#detailSection("公开来源", sourceList, "编辑公开来源", () => { this.#detailEditing = "sources"; this.#renderInspector(); }), this.#detailSection("访问位置与 Connector", accessList, "编辑 Connector 关联", () => { this.#detailEditing = "access"; this.#renderInspector(); }), this.#detailSection("数据血缘", lineage, "编辑血缘关系", () => { this.#detailEditing = "lineage"; this.#renderInspector(); })];
    const actions = document.createElement("div");
    actions.className = "catalog-inspector-actions";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "command-button danger";
    remove.textContent = "删除数据资产";
    remove.addEventListener("click", () => void this.#remove(asset).catch((error) => notifyWorkspace("用户资产删除失败", error instanceof Error ? error.message : String(error), { tone: "error" })));
    actions.append(remove);
    sections.push(actions);
    content.replaceChildren(heading, note, ...sections);
  }

  #renderSurveyOptions(): void {
    const select = byId<HTMLSelectElement>("catalog-survey");
    const current = select.value;
    const none = document.createElement("option"); none.value = ""; none.textContent = "不设置巡天标签";
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

  #renderCreateConnectors(): void {
    const root = byId("catalog-connector-list");
    if (!this.#connectors.length) {
      const empty = document.createElement("p");
      empty.className = "asset-detail-placeholder";
      empty.textContent = "请先新建一个 Connector，再登记用户数据。";
      root.replaceChildren(empty);
      return;
    }
    root.replaceChildren(...this.#connectors.map((connector, index) => {
      const label = document.createElement("label");
      label.className = "connector-option";
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "catalog-connector";
      radio.value = connector.locationKey;
      radio.required = index === 0;
      radio.addEventListener("change", () => void this.#selectCreateConnector(connector));
      const copy = document.createElement("span");
      const name = document.createElement("strong");
      name.textContent = connector.name;
      const detail = document.createElement("small");
      detail.textContent = `${connector.kind} · ${connector.displayPath}`;
      copy.append(name, detail);
      label.append(radio, copy);
      return label;
    }));
  }

  async #selectCreateConnector(connector: ConnectorPublicRecord): Promise<void> {
    this.#scanInspection = null;
    this.#scanConnectorId = connector.id;
    const fieldset = byId("catalog-scan-fieldset");
    fieldset.hidden = connector.kind !== "local";
    if (connector.kind !== "local") return;
    notifyWorkspace("正在检查本地文件", connector.displayPath, { tone: "info" });
    try {
      const files = await workspaceApi.localConnectorFiles(connector.id);
      const select = byId<HTMLSelectElement>("catalog-source-file");
      select.replaceChildren(...files.map((file) => {
        const option = document.createElement("option");
        option.value = file.relativePath;
        option.textContent = `${file.relativePath}${file.byteSize ? ` · ${file.byteSize} B` : ""}`;
        return option;
      }));
      notifyWorkspace(files.length ? "本地文件检查完成" : "本地文件检查为空", files.length ? `${files.length} 个 CSV 文件可供选择` : "该 Connector 下没有 CSV 文件", { tone: files.length ? "success" : "warning" });
    } catch (error) {
      notifyWorkspace("本地文件检查失败", error instanceof Error ? error.message : String(error), { tone: "error" });
    }
  }

  async #inspectSelectedFile(): Promise<void> {
    if (!this.#scanConnectorId) throw new RangeError("请选择本地 Connector");
    const relativePath = byId<HTMLSelectElement>("catalog-source-file").value;
    if (!relativePath) throw new RangeError("请选择 CSV 文件");
    const inspectDedupeMs = 3_000;
    notifyWorkspace("正在读取本地文件表头", relativePath, { tone: "info", dedupeMs: inspectDedupeMs });
    let inspection: LocalCsvInspection;
    try {
      inspection = await workspaceApi.inspectLocalConnectorFile(this.#scanConnectorId, relativePath);
    } catch (error) {
      notifyWorkspace("本地文件表头读取失败", error instanceof Error ? error.message : String(error), { tone: "error" });
      return;
    }
    this.#scanInspection = inspection;
    const fill = (id: string, value?: string): void => {
      const select = byId<HTMLSelectElement>(id);
      select.replaceChildren(...inspection.columns.map((column) => {
        const option = document.createElement("option"); option.value = column.name; option.textContent = column.name; return option;
      }));
      if (value && inspection.columns.some((column) => column.name === value)) select.value = value;
    };
    fill("catalog-object-id-column", inspection.inferred?.objectIdColumn);
    fill("catalog-ra-column", inspection.inferred?.raColumn);
    fill("catalog-dec-column", inspection.inferred?.decColumn);
    notifyWorkspace("本地文件表头已读取", `${inspection.columns.length} 个字段${inspection.inferred ? ` · 识别置信度 ${Math.round((inspection.inferred.confidence ?? 0) * 100)}%` : ""}`, { tone: "success", dedupeMs: inspectDedupeMs });
  }

  #createScanFields(): Pick<DataAssetRegistrationInput, "sourceRelativePath" | "scanSpec"> {
    if (!this.#scanInspection || !this.#scanConnectorId) return {};
    const connector = this.#connectors.find((candidate) => candidate.id === this.#scanConnectorId);
    if (connector?.kind !== "local") return {};
    return {
      sourceRelativePath: this.#scanInspection.sourceRelativePath,
      scanSpec: {
        format: "csv",
        objectIdColumn: byId<HTMLSelectElement>("catalog-object-id-column").value,
        raColumn: byId<HTMLSelectElement>("catalog-ra-column").value,
        decColumn: byId<HTMLSelectElement>("catalog-dec-column").value,
        coordinateFrame: "ICRS",
        coordinateUnits: "deg",
      },
    };
  }

  #selectedCreateConnectors(): ConnectorPublicRecord[] {
    const selected = byId("catalog-connector-list").querySelector<HTMLInputElement>("input:checked");
    const connector = selected ? this.#connectors.find((candidate) => candidate.locationKey === selected.value) : undefined;
    return connector ? [connector] : [];
  }

  #input(): DataAssetRegistrationInput {
    const name = inputValue("catalog-name");
    const connector = this.#selectedCreateConnectors()[0];
    if (!connector) throw new RangeError("请选择一个 Connector");
    return {
      name, description: inputValue("catalog-description") || undefined,
      surveyId: byId<HTMLSelectElement>("catalog-survey").value || undefined,
      releaseId: byId<HTMLSelectElement>("catalog-release").value || undefined,
      product: name,
      kind: byId<HTMLSelectElement>("catalog-kind").value as DataAssetKind,
      connectorIds: [connector.id],
      connectorLocationKeys: [connector.locationKey],
      status: "ready",
      projectStates: ["deliverable"],
      ...this.#createScanFields(),
    };
  }

  async #save(): Promise<void> {
    const input = this.#input();
    const asset = await workspaceApi.registerDataAsset(input);
    this.#assets = await this.#loadUserAssets();
    this.#selectedId = asset.id;
    this.#closeCreateDialog();
    this.#render();
    try {
      await this.#onAssetChanged?.(asset.id);
    } catch (error) {
      notifyWorkspace("用户资产覆盖刷新失败", error instanceof Error ? error.message : String(error), { tone: "warning" });
    }
    notifyWorkspace("用户资产已登记", asset.name, { tone: "success" });
  }

  #startNew(surveyId?: string): void {
    this.#scanInspection = null;
    this.#scanConnectorId = null;
    byId<HTMLFormElement>("catalog-registration-form").reset();
    this.#renderSurveyOptions();
    byId<HTMLSelectElement>("catalog-kind").value = "catalog";
    if (surveyId && this.#surveys.some((survey) => survey.id === surveyId)) {
      byId<HTMLSelectElement>("catalog-survey").value = surveyId;
      this.#syncReleaseOptions();
    }
    byId("catalog-scan-fieldset").hidden = true;
    this.#renderCreateConnectors();
    byId("catalog-form-title").textContent = "登记用户数据";
    byId("catalog-form-submit").textContent = "登记数据";
    byId<HTMLDialogElement>("catalog-create-dialog").showModal();
  }

  #closeCreateDialog(): void {
    this.#scanInspection = null;
    this.#scanConnectorId = null;
    byId<HTMLFormElement>("catalog-registration-form").reset();
    this.#renderSurveyOptions();
    byId<HTMLSelectElement>("catalog-kind").value = "catalog";
    byId("catalog-scan-fieldset").hidden = true;
    this.#renderCreateConnectors();
    byId("catalog-form-title").textContent = "登记用户数据";
    byId("catalog-form-submit").textContent = "登记数据";
    const dialog = byId<HTMLDialogElement>("catalog-create-dialog");
    if (dialog.open) dialog.close();
  }

  async #remove(asset: DataAssetRecord): Promise<void> {
    await workspaceApi.deleteDataAsset(asset.id);
    this.#assets = await this.#loadUserAssets();
    this.#selectedId = null;
    this.#detailEditing = null;
    this.#render();
    notifyWorkspace("用户资产已删除", asset.name, { tone: "success" });
  }

  #detailSection(title: string, content: HTMLElement, action: string, callback: () => void): HTMLElement {
    const wrapper = document.createElement("section"); wrapper.className = "asset-detail-section";
     const header = document.createElement("div"); header.className = "asset-detail-section-heading catalog-inspector-section-heading";
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
    void workspaceApi.updateDataAsset(this.#selectedId, input).then(async (updated) => { this.#assets = await this.#loadUserAssets(); this.#detailEditing = null; this.#render(); notifyWorkspace("用户资产已更新", updated.name, { tone: "success" }); }).catch((error) => { notifyWorkspace("用户资产更新失败", error instanceof Error ? error.message : String(error), { tone: "error" }); });
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
        if (note) note.textContent = `${connector.kind} · ${connector.displayPath} · ${connector.surveyId ?? "未设置巡天标签"}${connector.releaseId ? ` / ${connector.releaseId}` : ""}`;
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

}
