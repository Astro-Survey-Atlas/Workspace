import type { PublicResourcePackage, ResourceCatalogStatus, ResourcePackageJob, ResourcePackageLoad } from "../../src/resource-packages";
import { workspaceApi } from "./api";
import { notifyWorkspace } from "./notifications";

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing required element: ${id}`);
  return element as T;
}

function bytes(value: number): string {
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function equalSets(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

const STATUS_LABELS: Record<PublicResourcePackage["status"], string> = {
  not_installed: "未下载",
  installed: "已下载",
  active: "已应用",
  update_available: "可更新",
};

const FILTERS: Array<[keyof Pick<PublicResourcePackage, "modalities" | "wavelengths" | "productTypes" | "coverageAuthorities">, string]> = [
  ["modalities", "观测类型"],
  ["wavelengths", "波段"],
  ["productTypes", "产品"],
  ["coverageAuthorities", "覆盖来源"],
];

class ResourcePackageNotificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResourcePackageNotificationError";
  }
}

export interface ResourcePackageSelectionCallbacks {
  setDraftReleases: (releaseIds: Iterable<string>) => void;
  remove: () => Promise<void>;
}

export type ResourcePackageSelectedHandler = (
  record: PublicResourcePackage,
  draftReleaseIds: ReadonlySet<string>,
  callbacks: ResourcePackageSelectionCallbacks,
) => void;

export class ResourcePackagePanel {
  readonly #onApplied: (before: PublicResourcePackage[], after: PublicResourcePackage[]) => Promise<void>;
  readonly #onSelected: ResourcePackageSelectedHandler;
  readonly #onSyncRequested: () => void;
  readonly #onError: (error: unknown) => void;
  #records: PublicResourcePackage[] = [];
  #baselineReleases = new Map<string, Set<string>>();
  #draftReleases = new Map<string, Set<string>>();
  #selectedId: string | null = null;
  #jobs = new Map<string, ResourcePackageJob>();
  #filters = new Map<string, Set<string>>();
  #search = "";
  #busy = false;
  #active = false;
  #catalogStatus: ResourceCatalogStatus | null = null;
  #catalogUnavailableReason = "";

  constructor(
    onApplied: (before: PublicResourcePackage[], after: PublicResourcePackage[]) => Promise<void>,
    onSelected: ResourcePackageSelectedHandler,
    onError: (error: unknown) => void,
    onSyncRequested: () => void,
  ) {
    this.#onApplied = onApplied;
    this.#onSelected = onSelected;
    this.#onError = onError;
    this.#onSyncRequested = onSyncRequested;
    byId<HTMLInputElement>("resource-package-search").addEventListener("input", (event) => {
      this.#search = (event.currentTarget as HTMLInputElement).value.trim().toLocaleLowerCase();
      this.#render();
    });
    byId<HTMLButtonElement>("resource-package-filter-clear").addEventListener("click", () => {
      this.#filters.clear();
      this.#renderFilters();
      this.#render();
    });
    byId<HTMLButtonElement>("resource-package-apply").addEventListener("click", () => {
      void this.#applySelection().catch((error) => {
        if (error instanceof ResourcePackageNotificationError) return;
        this.#onError(error);
      });
    });
    byId<HTMLButtonElement>("resource-package-sync").addEventListener("click", () => this.#onSyncRequested());
  }

  async activate(): Promise<void> {
    this.#active = true;
    try {
      this.#catalogStatus = await workspaceApi.resourceCatalogConfig();
    } catch (error) {
      this.#catalogStatus = null;
      this.#catalogUnavailableReason = error instanceof Error ? error.message : String(error);
      notifyWorkspace("公开目录状态读取失败", this.#catalogUnavailableReason, { tone: "warning" });
    }
    let packages: PublicResourcePackage[] = [];
    try {
      packages = await workspaceApi.resourcePackages();
      this.#catalogUnavailableReason = "";
    } catch (error) {
      this.#catalogUnavailableReason = error instanceof Error ? error.message : String(error);
      notifyWorkspace("公开资源目录读取失败", this.#catalogUnavailableReason, { tone: "warning" });
    }
    this.#records = packages;
    this.#baselineReleases = this.#releaseMapFromRecords();
    this.#draftReleases = this.#cloneReleaseMap(this.#baselineReleases);
    this.#selectedId ??= this.#records[0]?.id ?? null;
    this.#renderFilters();
    this.#render();
    this.#showSelected();
  }

  async reload(): Promise<void> {
    if (this.#active) await this.activate();
  }

  setCatalogStatus(status: ResourceCatalogStatus | null): void {
    this.#catalogStatus = status;
    this.#catalogUnavailableReason = status?.available ? "" : status?.unavailableReason ?? this.#catalogUnavailableReason;
    this.#render();
  }

  deactivate(): void {
    this.#active = false;
  }

  selectedRecord(): PublicResourcePackage | undefined {
    return this.#records.find((record) => record.id === this.#selectedId);
  }

  setDraftReleases(packageId: string, releaseIds: Iterable<string>): void {
    const record = this.#records.find((candidate) => candidate.id === packageId);
    if (!record) throw new Error(`Unknown resource package: ${packageId}`);
    const allowed = new Set(this.#catalogReleaseIds(record));
    const next = new Set([...releaseIds].filter((releaseId) => allowed.has(releaseId)));
    if (next.size) this.#draftReleases.set(packageId, next);
    else this.#draftReleases.delete(packageId);
    this.#render();
    if (packageId === this.#selectedId) this.#showSelected();
  }

  async removeSelected(): Promise<void> {
    if (!this.#selectedId) return;
    await this.remove(this.#selectedId);
  }

  async remove(packageId: string): Promise<void> {
    const record = this.#records.find((candidate) => candidate.id === packageId);
    if (!record) throw new Error(`Unknown resource package: ${packageId}`);
    if (!record.installedVersion) return;
    const before = [...this.#records];
    this.#busy = true;
    this.#render();
    try {
      await workspaceApi.deleteResourcePackage(record.id);
      this.#records = await workspaceApi.resourcePackages();
      this.#draftReleases.delete(record.id);
      this.#baselineReleases.delete(record.id);
      this.#renderFilters();
      await this.#onApplied(before, this.#records);
    } finally {
      this.#busy = false;
      this.#render();
      this.#showSelected();
    }
  }

  #cloneReleaseMap(source: ReadonlyMap<string, ReadonlySet<string>>): Map<string, Set<string>> {
    return new Map([...source].map(([packageId, releaseIds]) => [packageId, new Set(releaseIds)]));
  }

  #releaseMapFromRecords(): Map<string, Set<string>> {
    return new Map(this.#records.filter((record) => record.activeReleaseIds.length).map((record) => [record.id, new Set(record.activeReleaseIds)]));
  }

  #catalogReleaseIds(record: PublicResourcePackage): string[] {
    // Once installed, only releases backed by a verified local footprint may
    // be selected. Before installation the catalog's declared releases are
    // the remote choices; their geometry is checked during installation.
    return [...new Set(record.installedVersion ? record.availableReleaseIds : record.releases)];
  }

  #renderFilters(): void {
    const container = byId("resource-package-filters");
    container.replaceChildren(...FILTERS.map(([field, label]) => {
      const group = document.createElement("fieldset");
      group.className = "resource-filter-group";
      group.dataset.filterKind = field;
      const legend = document.createElement("legend");
      legend.textContent = label;
      group.append(legend);
      const values = [...new Set(this.#records.flatMap((record) => record[field]))].sort();
      for (const value of values) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "resource-filter-chip";
        button.dataset.filterKind = field;
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
    const filtered = this.#records.filter((record) => {
      const publicReleaseSearch = (record.publicReleases ?? []).flatMap((release) => [release.id, release.label, ...release.products.map((product) => product.name)]);
      const searchable = [record.name, record.description, record.surveyId, ...record.modalities, ...record.wavelengths, ...record.productTypes, ...record.facilities, ...record.releases, ...publicReleaseSearch].join(" ").toLocaleLowerCase();
      if (this.#search && !searchable.includes(this.#search)) return false;
      return FILTERS.every(([field]) => {
        const selected = this.#filters.get(field);
        return !selected?.size || record[field].some((value) => selected.has(value));
      });
    });
    const group = (record: PublicResourcePackage): number => {
      const loadable = this.#catalogReleaseIds(record).length > 0;
      if (record.active) return 0;
      if (record.installedVersion) return 1;
      if (loadable) return 2;
      return 3;
    };
    return filtered
      .map((record, index) => ({ record, index, group: group(record) }))
      .sort((left, right) => left.group - right.group || left.index - right.index)
      .map(({ record }) => record);
  }

  #render(): void {
    if (!this.#active) return;
    const visible = this.#visibleRecords();
    const selectedIsVisible = visible.some((record) => record.id === this.#selectedId);
    if (!selectedIsVisible) {
      this.#selectedId = visible[0]?.id ?? null;
      this.#showSelected();
    }
    const list = byId("resource-package-list");
    const groups: Array<{ key: string; label: string; records: PublicResourcePackage[] }> = [
      { key: "active", label: "已应用到天球", records: [] },
      { key: "installed", label: "已下载，尚未应用", records: [] },
      { key: "remote", label: "未下载，目录中可用", records: [] },
      { key: "unavailable", label: "暂无可加载几何", records: [] },
    ];
    visible.forEach((record) => {
      const index = record.active ? 0 : record.installedVersion ? 1 : this.#catalogReleaseIds(record).length ? 2 : 3;
      groups[index]!.records.push(record);
    });
    const rows = groups.flatMap((group) => {
      if (!group.records.length) return [];
      const section = document.createElement("section");
      section.className = "resource-package-group";
      section.dataset.resourceGroup = group.key;
      const heading = document.createElement("header");
      heading.className = "resource-package-group-heading";
      const title = document.createElement("strong");
      title.textContent = group.label;
      const count = document.createElement("output");
      count.textContent = String(group.records.length);
      heading.append(title, count);
      section.append(heading);
      section.append(...group.records.map((record) => {
      const row = document.createElement("article");
      row.className = "resource-package-row";
      row.dataset.status = record.status;
      row.dataset.selected = String(record.id === this.#selectedId);
      row.dataset.dirty = String(this.#packageIsDirty(record.id));
      row.addEventListener("click", (event) => {
        if ((event.target as HTMLElement).closest("input")) return;
        this.#selectedId = record.id;
        this.#showSelected();
      });

      const draft = this.#draftReleases.get(record.id) ?? new Set<string>();
      const available = this.#catalogReleaseIds(record);
      row.dataset.loadable = String(available.length > 0);
      const toggle = document.createElement("input");
      toggle.type = "checkbox";
      toggle.checked = available.length > 0 && draft.size === available.length;
      toggle.indeterminate = draft.size > 0 && draft.size < available.length;
      toggle.disabled = this.#busy || available.length === 0;
      toggle.setAttribute("aria-label", `选择${record.name}的全部发布版本`);
      if (available.length === 0) {
        toggle.title = "尚无经过校验的真实覆盖，不能应用到天球";
      }
      toggle.addEventListener("click", (event) => event.stopPropagation());
      toggle.addEventListener("change", () => {
        this.#selectedId = record.id;
        if (toggle.checked) this.#draftReleases.set(record.id, new Set(available));
        else this.#draftReleases.delete(record.id);
        this.#render();
        this.#showSelected();
      });

      const identity = document.createElement("div");
      const heading = document.createElement("strong"); heading.textContent = record.name;
      const description = document.createElement("p"); description.textContent = record.description;
      const tags = document.createElement("div");
      tags.className = "resource-package-tags";
      const tagGroups: Array<[string, string[]]> = [
        ["modality", record.modalities],
        ["wavelength", record.wavelengths],
        ["product", record.productTypes],
        ["authority", record.coverageAuthorities],
      ];
      for (const [kind, values] of tagGroups) {
        for (const value of values) {
          const tag = document.createElement("span");
          tag.className = "resource-package-tag";
          tag.dataset.tagKind = kind;
          tag.textContent = value;
          tags.append(tag);
        }
      }
      identity.append(heading, description, tags);

      const version = document.createElement("span");
      version.className = "resource-package-version";
      const publicReleaseCount = record.publicReleases?.length ?? record.releases.length;
      const releaseSummary = publicReleaseCount === available.length
        ? `${publicReleaseCount} 个公开版本`
        : `${publicReleaseCount} 个公开版本 · ${available.length} 个可应用`;
      version.textContent = `${releaseSummary} · ${bytes(record.sizeBytes)}`;

      const status = document.createElement("span");
      status.className = "resource-package-status";
      const job = this.#jobs.get(record.id);
      status.textContent = job && job.status !== "completed" ? this.#jobLabel(job) : STATUS_LABELS[record.status];

      const progress = document.createElement("div");
      progress.className = "item-progress resource-package-progress";
      progress.hidden = !job || job.status === "completed";
      if (job) {
        const percent = job.totalBytes ? Math.min(100, (job.downloadedBytes / job.totalBytes) * 100) : 0;
        const determinate = job.phase === "downloading" && job.totalBytes > 0;
        progress.style.setProperty("--item-progress", `${percent}%`);
        progress.dataset.mode = job.status === "failed" ? "failed" : determinate ? "determinate" : "indeterminate";
        progress.dataset.status = job.status;
        progress.setAttribute("role", "progressbar");
        progress.setAttribute("aria-label", `${record.name}${this.#jobLabel(job)}`);
        progress.setAttribute("aria-valuemin", "0");
        progress.setAttribute("aria-valuemax", "100");
        if (determinate) progress.setAttribute("aria-valuenow", String(Math.round(percent)));
      }
      row.append(toggle, identity, version, status, progress);
      return row;
      }));
      return [section];
    });
    list.replaceChildren(...rows);

    const selectedPackages = this.#draftReleases.size;
    const dirtyPackages = this.#records.filter((record) => this.#packageIsDirty(record.id)).length;
    const activeFilterCount = [...this.#filters.values()].reduce((total, values) => total + values.size, 0);
    byId("resource-package-count").textContent = String(this.#records.length);
    byId("resource-package-installed-count").textContent = String(this.#records.filter((record) => record.installedVersion).length);
    byId("resource-package-active-count").textContent = String(this.#records.filter((record) => record.active).length);
    byId("resource-package-selected-count").textContent = String(selectedPackages);
     byId("resource-package-filter-summary").textContent = activeFilterCount ? `已选 ${activeFilterCount} 个筛选条件` : "全部公开资源";
    byId<HTMLButtonElement>("resource-package-filter-clear").disabled = activeFilterCount === 0;
    const apply = byId<HTMLButtonElement>("resource-package-apply");
    apply.disabled = this.#busy || dirtyPackages === 0;
    apply.querySelector("span")!.textContent = this.#busy ? "处理中…" : "应用到天球";
    byId("resource-package-empty").hidden = visible.length > 0;
  }

  #packageIsDirty(packageId: string): boolean {
    return !equalSets(this.#draftReleases.get(packageId) ?? new Set(), this.#baselineReleases.get(packageId) ?? new Set());
  }

  #showSelected(): void {
    const record = this.selectedRecord();
    if (!record) return;
    this.#onSelected(record, new Set(this.#draftReleases.get(record.id) ?? []), {
      setDraftReleases: (releaseIds) => this.setDraftReleases(record.id, releaseIds),
      remove: () => this.remove(record.id),
    });
  }

  #jobLabel(job: ResourcePackageJob): string {
    if (job.status === "failed") return "下载失败";
    if (job.phase === "queued") return "等待下载";
    if (job.phase === "downloading") return job.totalBytes ? `下载 ${Math.round(job.downloadedBytes / job.totalBytes * 100)}%` : "下载中";
    if (job.phase === "verifying") return "校验中";
    if (job.phase === "installing") return "安装中";
    return "已下载";
  }

  #downloadQueue(): PublicResourcePackage[] {
    return this.#records.filter((record) => this.#draftReleases.has(record.id) && (!record.installedVersion || record.status === "update_available"));
  }

  async #downloadSelected(): Promise<void> {
    const queue = this.#downloadQueue();
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
          notifyWorkspace("资源包下载已开始", record.name, { tone: "info" });
          await this.#waitForJob(record.id, job);
        } catch (error) {
          errors.push(error instanceof Error ? error : new Error(String(error)));
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(3, queue.length) }, () => worker()));
      this.#records = await workspaceApi.resourcePackages();
      this.#renderFilters();
    } finally {
      this.#busy = false;
      this.#render();
      this.#showSelected();
    }
    if (errors.length) {
      const message = `${errors.length} 个巡天资源下载或安装失败：${errors[0]?.message ?? "未知错误"}`;
      notifyWorkspace("资源包下载或安装失败", message, { tone: "error" });
      throw new ResourcePackageNotificationError(message);
    }
    notifyWorkspace("资源包下载、校验和安装完成", `已处理 ${queue.length} 个资源包`, { tone: "success" });
  }

  async #waitForJob(packageId: string, initial: ResourcePackageJob): Promise<void> {
    let job = initial;
    while (job.status === "queued" || job.status === "running") {
      const previous = this.#jobs.get(packageId);
      if (previous?.phase !== job.phase) {
        const record = this.#records.find((candidate) => candidate.id === packageId);
        const phaseSummary: Record<NonNullable<ResourcePackageJob["phase"]>, string> = {
          queued: "资源包等待下载",
          downloading: "资源包正在下载",
          verifying: "资源包正在校验",
          installing: "资源包正在安装",
          completed: "资源包已安装",
          failed: "资源包安装失败",
        };
        if (record && job.phase) notifyWorkspace(phaseSummary[job.phase], record.name, { tone: "info" });
      }
      this.#jobs.set(packageId, job);
      this.#render();
      await new Promise((resolve) => setTimeout(resolve, 250));
      job = await workspaceApi.resourcePackageJob(job.id);
    }
    this.#jobs.set(packageId, job);
    this.#render();
    const record = this.#records.find((candidate) => candidate.id === packageId);
    if (job.status === "failed") {
      throw new Error(job.error ?? "资源包安装失败");
    }
  }

  async #apply(): Promise<void> {
    if (this.#downloadQueue().length) throw new Error("仍有公开覆盖资源尚未下载");
    const loads: ResourcePackageLoad[] = [...this.#draftReleases].filter(([, releaseIds]) => releaseIds.size).map(([packageId, releaseIds]) => ({
      packageId,
      releaseIds: [...releaseIds],
    }));
    this.#busy = true;
    this.#render();
    const before = this.#records;
    try {
      this.#records = await workspaceApi.setActiveResourcePackages(loads);
      this.#baselineReleases = this.#releaseMapFromRecords();
      this.#draftReleases = this.#cloneReleaseMap(this.#baselineReleases);
      await this.#onApplied(before, this.#records);
      this.#renderFilters();
      notifyWorkspace("资源包已应用", "公共覆盖图层已更新", { tone: "success" });
    } finally {
      this.#busy = false;
      this.#render();
      this.#showSelected();
    }
  }

  async #applySelection(): Promise<void> {
    if (this.#busy) return;
    await this.#downloadSelected();
    await this.#apply();
  }
}
