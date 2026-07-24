import type { DataAssetKind, DataAssetRecord, DataAssetRegistrationInput } from "../../src/data-catalog";
import type { SurveyCard, SurveyRecord } from "../../src/survey-registry";
import { workspaceApi } from "./api";

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing required element: ${id}`);
  return element as T;
}

function text(id: string): string {
  return byId<HTMLInputElement>(id).value.trim();
}

function statusLabel(status: DataAssetRecord["status"]): string {
  if (status === "ready") return "可访问";
  if (status === "unavailable") return "不可用";
  return "仅元数据";
}

export class DataCatalogPanel {
  readonly #onError: (error: unknown) => void;
  #assets: DataAssetRecord[] = [];
  #surveys: SurveyCard[] = [];
  #surveyRecords = new Map<string, SurveyRecord>();
  #selectedId: string | null = null;
  #editingId: string | null = null;
  #active = false;

  constructor(onError: (error: unknown) => void) {
    this.#onError = onError;
    byId<HTMLInputElement>("catalog-search").addEventListener("input", () => this.#render());
    byId<HTMLSelectElement>("catalog-origin-filter").addEventListener("change", () => this.#render());
    byId<HTMLSelectElement>("catalog-kind-filter").addEventListener("change", () => this.#render());
    byId<HTMLSelectElement>("catalog-survey").addEventListener("change", () => this.#syncReleaseOptions());
    byId<HTMLFormElement>("catalog-registration-form").addEventListener("submit", (event) => {
      event.preventDefault();
      void this.#save().catch(this.#onError);
    });
    byId<HTMLButtonElement>("catalog-form-cancel").addEventListener("click", () => this.#resetForm());
    byId<HTMLButtonElement>("catalog-delete").addEventListener("click", () => void this.#remove().catch(this.#onError));
  }

  async activate(surveys: SurveyCard[], records: Map<string, SurveyRecord>): Promise<void> {
    this.#active = true;
    this.#surveys = surveys;
    this.#surveyRecords = records;
    this.#renderSurveyOptions();
    this.#assets = await workspaceApi.dataAssets();
    if (!this.#selectedId || !this.#assets.some((asset) => asset.id === this.#selectedId)) this.#selectedId = this.#assets[0]?.id ?? null;
    this.#render();
  }

  deactivate(): void {
    this.#active = false;
  }

  debugState(): Record<string, unknown> {
    return { catalogAssetCount: this.#assets.length, selectedCatalogAssetId: this.#selectedId };
  }

  #filteredAssets(): DataAssetRecord[] {
    const query = text("catalog-search").toLocaleLowerCase();
    const origin = byId<HTMLSelectElement>("catalog-origin-filter").value;
    const kind = byId<HTMLSelectElement>("catalog-kind-filter").value;
    return this.#assets.filter((asset) => {
      if (origin !== "all" && asset.origin !== origin) return false;
      if (kind !== "all" && asset.kind !== kind) return false;
      if (!query) return true;
      const haystack = [asset.name, asset.description, asset.product, asset.surveyId, asset.releaseId, asset.access.format, ...asset.modalities].filter(Boolean).join(" ").toLocaleLowerCase();
      return haystack.includes(query);
    });
  }

  #render(): void {
    if (!this.#active) return;
    const assets = this.#filteredAssets();
    const list = byId("catalog-asset-list");
    list.replaceChildren(...assets.map((asset) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "catalog-row";
      row.classList.toggle("selected", asset.id === this.#selectedId);
      row.addEventListener("click", () => {
        this.#selectedId = asset.id;
        this.#render();
        if (window.innerWidth <= 1040) byId("inspector-panel").classList.add("mobile-open");
      });
      const identity = document.createElement("span");
      const name = document.createElement("strong");
      name.textContent = asset.name;
      const product = document.createElement("small");
      product.textContent = `${asset.product} · ${asset.access.format.toUpperCase()}`;
      identity.append(name, product);
      const survey = document.createElement("span");
      survey.className = "catalog-row-survey";
      survey.textContent = this.#surveyName(asset.surveyId);
      const kind = document.createElement("span");
      kind.className = "catalog-kind";
      kind.textContent = asset.kind.toUpperCase();
      const status = document.createElement("span");
      status.className = "catalog-status";
      status.dataset.status = asset.status;
      status.textContent = statusLabel(asset.status);
      row.append(identity, survey, kind, status);
      return row;
    }));
    byId("catalog-empty").hidden = assets.length > 0;
    byId("catalog-count").textContent = `${assets.length} / ${this.#assets.length}`;
    byId("catalog-builtin-count").textContent = String(this.#assets.filter((asset) => asset.origin === "builtin").length);
    byId("catalog-user-count").textContent = String(this.#assets.filter((asset) => asset.origin === "user").length);
    byId("catalog-ready-count").textContent = String(this.#assets.filter((asset) => asset.status === "ready").length);
    this.#renderDetail();
  }

  #renderDetail(): void {
    const asset = this.#assets.find((candidate) => candidate.id === this.#selectedId);
    const empty = byId("inspector-empty");
    const content = byId("inspector-content");
    byId("inspector-kicker").textContent = "DATA ASSET";
    if (!asset) {
      empty.hidden = false;
      content.hidden = true;
      content.replaceChildren();
      return;
    }
    empty.hidden = true;
    content.hidden = false;
    const heading = document.createElement("h2");
    heading.textContent = asset.name;
    const origin = document.createElement("div");
    origin.className = "catalog-detail-origin";
    origin.textContent = asset.origin === "builtin" ? "系统内置 · 只读" : "用户登记 · 可维护";
    const description = document.createElement("p");
    description.className = "catalog-detail-copy";
    description.textContent = asset.description;
    const rows: Array<[string, string]> = [
      ["巡天", this.#surveyName(asset.surveyId)],
      ["数据发布", asset.releaseId ?? "未关联"],
      ["数据产品", asset.product],
      ["类型 / 模态", `${asset.kind} / ${asset.modalities.join(", ") || "未标注"}`],
      ["访问方式", `${asset.access.connector} · ${asset.access.format}`],
      ["状态", statusLabel(asset.status)],
      ["覆盖几何", asset.footprintIds.length ? asset.footprintIds.join(", ") : "尚未关联 MOC"],
      ["数据地址", asset.access.uri],
    ];
    const list = document.createElement("dl");
    rows.forEach(([label, value]) => {
      const row = document.createElement("div");
      const term = document.createElement("dt");
      const detail = document.createElement("dd");
      term.textContent = label;
      detail.textContent = value;
      row.append(term, detail);
      list.append(row);
    });
    const actions = document.createElement("div");
    actions.className = "inspector-actions";
    if (asset.origin === "user") {
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "command-button";
      edit.textContent = "编辑登记";
      edit.addEventListener("click", () => this.#beginEdit(asset));
      actions.append(edit);
    }
    content.replaceChildren(heading, origin, description, list, actions);
  }

  #renderSurveyOptions(): void {
    const select = byId<HTMLSelectElement>("catalog-survey");
    const current = select.value;
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "不关联巡天";
    select.replaceChildren(none, ...this.#surveys.map((survey) => {
      const option = document.createElement("option");
      option.value = survey.id;
      option.textContent = survey.name;
      return option;
    }));
    select.value = this.#surveys.some((survey) => survey.id === current) ? current : "";
    this.#syncReleaseOptions();
  }

  #syncReleaseOptions(): void {
    const surveyId = byId<HTMLSelectElement>("catalog-survey").value;
    const select = byId<HTMLSelectElement>("catalog-release");
    const current = select.value;
    const releases = surveyId ? this.#surveyRecords.get(surveyId)?.releases ?? [] : [];
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "不关联数据发布";
    select.replaceChildren(none, ...releases.map((release) => {
      const option = document.createElement("option");
      option.value = release.id;
      option.textContent = release.label;
      return option;
    }));
    select.value = releases.some((release) => release.id === current) ? current : "";
  }

  #surveyName(id?: string): string {
    return id ? this.#surveys.find((survey) => survey.id === id)?.name ?? id : "独立数据";
  }

  #input(): DataAssetRegistrationInput {
    return {
      name: text("catalog-name"),
      description: text("catalog-description") || undefined,
      surveyId: byId<HTMLSelectElement>("catalog-survey").value || undefined,
      releaseId: byId<HTMLSelectElement>("catalog-release").value || undefined,
      product: text("catalog-product") || undefined,
      kind: byId<HTMLSelectElement>("catalog-kind").value as DataAssetKind,
      modalities: text("catalog-modalities").split(",").map((value) => value.trim()).filter(Boolean),
      connector: byId<HTMLSelectElement>("catalog-connector").value as DataAssetRegistrationInput["connector"],
      sourceUri: text("catalog-uri"),
      format: text("catalog-format"),
      status: byId<HTMLSelectElement>("catalog-status-input").value as DataAssetRegistrationInput["status"],
    };
  }

  async #save(): Promise<void> {
    const input = this.#input();
    const asset = this.#editingId
      ? await workspaceApi.updateDataAsset(this.#editingId, input)
      : await workspaceApi.registerDataAsset(input);
    this.#assets = await workspaceApi.dataAssets();
    this.#selectedId = asset.id;
    this.#resetForm();
    this.#render();
  }

  #beginEdit(asset: DataAssetRecord): void {
    this.#editingId = asset.id;
    byId<HTMLInputElement>("catalog-name").value = asset.name;
    byId<HTMLInputElement>("catalog-description").value = asset.description;
    byId<HTMLSelectElement>("catalog-survey").value = asset.surveyId ?? "";
    this.#syncReleaseOptions();
    byId<HTMLSelectElement>("catalog-release").value = asset.releaseId ?? "";
    byId<HTMLInputElement>("catalog-product").value = asset.product;
    byId<HTMLSelectElement>("catalog-kind").value = asset.kind;
    byId<HTMLInputElement>("catalog-modalities").value = asset.modalities.join(", ");
    byId<HTMLSelectElement>("catalog-connector").value = asset.access.connector;
    byId<HTMLInputElement>("catalog-uri").value = asset.access.uri;
    byId<HTMLInputElement>("catalog-format").value = asset.access.format;
    byId<HTMLSelectElement>("catalog-status-input").value = asset.status;
    byId("catalog-form-title").textContent = "编辑用户数据";
    byId("catalog-form-submit").textContent = "保存修改";
    byId("catalog-form-cancel").hidden = false;
    byId("catalog-delete").hidden = false;
    byId("controls-panel").scrollTo({ top: byId("catalog-registration-form").offsetTop, behavior: "smooth" });
  }

  #resetForm(): void {
    this.#editingId = null;
    byId<HTMLFormElement>("catalog-registration-form").reset();
    this.#renderSurveyOptions();
    byId<HTMLSelectElement>("catalog-kind").value = "catalog";
    byId<HTMLSelectElement>("catalog-connector").value = "http";
    byId<HTMLSelectElement>("catalog-status-input").value = "metadata_only";
    byId("catalog-form-title").textContent = "登记用户数据";
    byId("catalog-form-submit").textContent = "登记数据";
    byId("catalog-form-cancel").hidden = true;
    byId("catalog-delete").hidden = true;
  }

  async #remove(): Promise<void> {
    if (!this.#editingId) return;
    await workspaceApi.deleteDataAsset(this.#editingId);
    this.#assets = await workspaceApi.dataAssets();
    this.#selectedId = this.#assets[0]?.id ?? null;
    this.#resetForm();
    this.#render();
  }
}
