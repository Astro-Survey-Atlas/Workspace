import type { PublicResourcePackage, ResourcePackageJob } from "../../src/resource-packages";
import { workspaceApi } from "./api";

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing required element: ${id}`);
  return element as T;
}

function bytes(value: number): string {
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

const STATUS_LABELS: Record<PublicResourcePackage["status"], string> = {
  not_installed: "未下载",
  installed: "已下载",
  active: "已加载",
  update_available: "可更新",
};

const FILTERS: Array<[keyof Pick<PublicResourcePackage, "modalities" | "wavelengths" | "productTypes" | "coverageAuthorities">, string]> = [
  ["modalities", "观测类型"],
  ["wavelengths", "波段"],
  ["productTypes", "产品"],
  ["coverageAuthorities", "覆盖来源"],
];

export class ResourcePackagePanel {
  readonly #onApplied: (before: PublicResourcePackage[], after: PublicResourcePackage[]) => Promise<void>;
  readonly #onSelected: (record: PublicResourcePackage) => void;
  readonly #onError: (error: unknown) => void;
  #records: PublicResourcePackage[] = [];
  #baselineActiveIds = new Set<string>();
  #draftActiveIds = new Set<string>();
  #selectedId: string | null = null;
  #jobs = new Map<string, ResourcePackageJob>();
  #filters = new Map<string, Set<string>>();
  #search = "";
  #busy = false;
  #active = false;

  constructor(
    onApplied: (before: PublicResourcePackage[], after: PublicResourcePackage[]) => Promise<void>,
    onSelected: (record: PublicResourcePackage) => void,
    onError: (error: unknown) => void,
  ) {
    this.#onApplied = onApplied;
    this.#onSelected = onSelected;
    this.#onError = onError;
    byId<HTMLInputElement>("resource-package-search").addEventListener("input", (event) => {
      this.#search = (event.currentTarget as HTMLInputElement).value.trim().toLocaleLowerCase();
      this.#render();
    });
    byId<HTMLButtonElement>("resource-package-download").addEventListener("click", () => void this.#downloadSelected().catch(this.#onError));
    byId<HTMLButtonElement>("resource-package-apply").addEventListener("click", () => void this.#apply().catch(this.#onError));
    byId<HTMLButtonElement>("resource-package-reset").addEventListener("click", () => {
      this.#draftActiveIds = new Set(this.#baselineActiveIds);
      this.#render();
    });
  }

  async activate(): Promise<void> {
    this.#active = true;
    this.#records = await workspaceApi.resourcePackages();
    this.#baselineActiveIds = new Set(this.#records.filter((record) => record.active).map((record) => record.id));
    this.#draftActiveIds = new Set(this.#baselineActiveIds);
    this.#selectedId ??= this.#records[0]?.id ?? null;
    this.#renderFilters();
    this.#render();
    this.#showSelected();
  }

  deactivate(): void {
    this.#active = false;
  }

  #renderFilters(): void {
    const container = byId("resource-package-filters");
    container.replaceChildren(...FILTERS.map(([field, label]) => {
      const group = document.createElement("fieldset");
      group.className = "resource-filter-group";
      const legend = document.createElement("legend");
      legend.textContent = label;
      group.append(legend);
      const values = [...new Set(this.#records.flatMap((record) => record[field]))].sort();
      for (const value of values) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "resource-filter-chip";
        button.textContent = value;
        button.dataset.active = String(this.#filters.get(field)?.has(value) === true);
        button.addEventListener("click", () => {
          const selected = this.#filters.get(field) ?? new Set<string>();
          if (selected.has(value)) selected.delete(value); else selected.add(value);
          if (selected.size) this.#filters.set(field, selected); else this.#filters.delete(field);
          this.#renderFilters();
          this.#render();
        });
        group.append(button);
      }
      return group;
    }));
  }

  #visibleRecords(): PublicResourcePackage[] {
    return this.#records.filter((record) => {
      const searchable = [record.name, record.description, record.surveyId, ...record.modalities, ...record.wavelengths, ...record.productTypes, ...record.facilities].join(" ").toLocaleLowerCase();
      if (this.#search && !searchable.includes(this.#search)) return false;
      return FILTERS.every(([field]) => {
        const selected = this.#filters.get(field);
        return !selected?.size || record[field].some((value) => selected.has(value));
      });
    });
  }

  #render(): void {
    if (!this.#active) return;
    const visible = this.#visibleRecords();
    const list = byId("resource-package-list");
    list.replaceChildren(...visible.map((record) => {
      const row = document.createElement("article");
      row.className = "resource-package-row";
      row.dataset.status = record.status;
      row.dataset.selected = String(record.id === this.#selectedId);
      row.dataset.dirty = String(this.#draftActiveIds.has(record.id) !== this.#baselineActiveIds.has(record.id));
      row.addEventListener("click", () => {
        this.#selectedId = record.id;
        this.#render();
        this.#showSelected();
        if (window.innerWidth <= 1040) byId("inspector-panel").classList.add("mobile-open");
      });

      const toggle = document.createElement("input");
      toggle.type = "checkbox";
      toggle.checked = this.#draftActiveIds.has(record.id);
      toggle.disabled = this.#busy;
      toggle.setAttribute("aria-label", `选择${record.name}`);
      toggle.addEventListener("click", (event) => event.stopPropagation());
      toggle.addEventListener("change", () => {
        if (toggle.checked) this.#draftActiveIds.add(record.id); else this.#draftActiveIds.delete(record.id);
        this.#render();
      });

      const identity = document.createElement("div");
      const heading = document.createElement("strong"); heading.textContent = record.name;
      const description = document.createElement("p"); description.textContent = record.description;
      const tags = document.createElement("small"); tags.textContent = [...record.modalities, ...record.wavelengths, ...record.productTypes].join(" · ");
      identity.append(heading, description, tags);

      const version = document.createElement("span");
      version.className = "resource-package-version";
      version.textContent = `${record.version} · ${bytes(record.sizeBytes)}`;

      const status = document.createElement("span");
      status.className = "resource-package-status";
      const job = this.#jobs.get(record.id);
      status.textContent = job && job.status !== "completed" ? this.#jobLabel(job) : STATUS_LABELS[record.status];

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "text-button resource-package-remove";
      remove.textContent = "卸载";
      remove.hidden = !record.installedVersion;
      remove.disabled = record.active || this.#busy;
      remove.title = record.active ? "先从草稿中取消并执行批量加载" : "删除服务器上的已下载文件";
      remove.addEventListener("click", (event) => {
        event.stopPropagation();
        void this.#remove(record).catch(this.#onError);
      });

      const progress = document.createElement("div");
      progress.className = "resource-package-progress";
      progress.hidden = !job || job.status === "completed";
      if (job) {
        const percent = job.totalBytes ? Math.min(100, (job.downloadedBytes / job.totalBytes) * 100) : 0;
        progress.style.setProperty("--resource-progress", `${percent}%`);
        progress.dataset.indeterminate = String(job.phase === "queued" || (job.phase === "downloading" && job.downloadedBytes === 0));
      }
      row.append(toggle, identity, version, status, remove, progress);
      return row;
    }));

    const selected = this.#draftActiveIds.size;
    const pendingDownloads = this.#records.filter((record) => this.#draftActiveIds.has(record.id) && (!record.installedVersion || record.status === "update_available")).length;
    const dirty = this.#records.filter((record) => this.#draftActiveIds.has(record.id) !== this.#baselineActiveIds.has(record.id)).length;
    byId("resource-package-count").textContent = String(this.#records.length);
    byId("resource-package-installed-count").textContent = String(this.#records.filter((record) => record.installedVersion).length);
    byId("resource-package-active-count").textContent = String(this.#records.filter((record) => record.active).length);
    byId("resource-package-selected-count").textContent = String(selected);
    byId("resource-package-pending").textContent = dirty ? `${dirty} 项待加载` : "草稿与天球一致";
    byId<HTMLButtonElement>("resource-package-download").disabled = this.#busy || pendingDownloads === 0;
    byId<HTMLButtonElement>("resource-package-apply").disabled = this.#busy || dirty === 0 || pendingDownloads > 0;
    byId<HTMLButtonElement>("resource-package-reset").disabled = this.#busy || dirty === 0;
    byId("resource-package-empty").hidden = visible.length > 0;
  }

  #showSelected(): void {
    const record = this.#records.find((candidate) => candidate.id === this.#selectedId);
    if (record) this.#onSelected(record);
  }

  #jobLabel(job: ResourcePackageJob): string {
    if (job.status === "failed") return "下载失败";
    if (job.phase === "queued") return "等待下载";
    if (job.phase === "downloading") return job.totalBytes ? `下载 ${Math.round(job.downloadedBytes / job.totalBytes * 100)}%` : "下载中";
    if (job.phase === "verifying") return "校验中";
    if (job.phase === "installing") return "安装中";
    return "已下载";
  }

  async #downloadSelected(): Promise<void> {
    const queue = this.#records.filter((record) => this.#draftActiveIds.has(record.id) && (!record.installedVersion || record.status === "update_available"));
    if (!queue.length) return;
    this.#busy = true;
    this.#render();
    const errors: Error[] = [];
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < queue.length) {
        const record = queue[cursor++];
        if (!record) return;
        try {
          const job = await workspaceApi.installResourcePackage(record.id);
          this.#jobs.set(record.id, job);
          await this.#waitForJob(record.id, job);
        } catch (error) {
          errors.push(error instanceof Error ? error : new Error(String(error)));
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, queue.length) }, () => worker()));
    this.#records = await workspaceApi.resourcePackages();
    this.#busy = false;
    this.#render();
    this.#showSelected();
    if (errors.length) throw new Error(`${errors.length} 个巡天资源下载失败：${errors[0]?.message ?? "未知错误"}`);
  }

  async #waitForJob(packageId: string, initial: ResourcePackageJob): Promise<void> {
    let job = initial;
    while (job.status === "queued" || job.status === "running") {
      this.#jobs.set(packageId, job);
      this.#render();
      await new Promise((resolve) => setTimeout(resolve, 250));
      job = await workspaceApi.resourcePackageJob(job.id);
    }
    this.#jobs.set(packageId, job);
    this.#render();
    if (job.status === "failed") throw new Error(job.error ?? "资源包安装失败");
  }

  async #apply(): Promise<void> {
    const unavailable = this.#records.filter((record) => this.#draftActiveIds.has(record.id) && (!record.installedVersion || record.status === "update_available"));
    if (unavailable.length) throw new Error("请先下载所有已选巡天资源，再批量加载");
    this.#busy = true;
    this.#render();
    const before = this.#records;
    try {
      this.#records = await workspaceApi.setActiveResourcePackages([...this.#draftActiveIds]);
      this.#baselineActiveIds = new Set(this.#records.filter((record) => record.active).map((record) => record.id));
      this.#draftActiveIds = new Set(this.#baselineActiveIds);
      await this.#onApplied(before, this.#records);
    } finally {
      this.#busy = false;
      this.#render();
      this.#showSelected();
    }
  }

  async #remove(record: PublicResourcePackage): Promise<void> {
    if (record.active) throw new Error("请先从草稿中取消并执行批量加载，再卸载资源");
    this.#busy = true;
    this.#render();
    try {
      await workspaceApi.deleteResourcePackage(record.id);
      this.#records = await workspaceApi.resourcePackages();
      this.#draftActiveIds.delete(record.id);
      this.#baselineActiveIds.delete(record.id);
    } finally {
      this.#busy = false;
      this.#render();
      this.#showSelected();
    }
  }
}
