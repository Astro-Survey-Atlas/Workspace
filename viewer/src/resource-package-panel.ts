import type { PublicResourcePackage, ResourcePackageJob, ResourcePackageLoad } from "../../src/resource-packages";
import type { PublicReleaseDetail } from "../../src/public-release-details";
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

export interface ResourcePackageSelectionCallbacks {
  setDraftReleases: (releaseIds: Iterable<string>) => void;
  remove: () => Promise<void>;
}

export type ResourcePackageSelectedHandler = (
  record: PublicResourcePackage,
  draftReleaseIds: ReadonlySet<string>,
  callbacks: ResourcePackageSelectionCallbacks,
) => void;

export type ResourcePackageSurveyHandler = (surveyId: string) => void;
type ResourceRow = PublicResourcePackage & { hasPackage: boolean };

export class ResourcePackagePanel {
  readonly #onApplied: (before: PublicResourcePackage[], after: PublicResourcePackage[]) => Promise<void>;
  readonly #onSelected: ResourcePackageSelectedHandler;
  readonly #onSurveySelected: ResourcePackageSurveyHandler;
  readonly #onError: (error: unknown) => void;
  #records: ResourceRow[] = [];
  #releaseDetails: PublicReleaseDetail[] = [];
  #baselineReleases = new Map<string, Set<string>>();
  #draftReleases = new Map<string, Set<string>>();
  #selectedId: string | null = null;
  #jobs = new Map<string, ResourcePackageJob>();
  #filters = new Map<string, Set<string>>();
  #search = "";
  #busy = false;
  #active = false;

  constructor(
    onApplied: (before: PublicResourcePackage[], after: PublicResourcePackage[]) => Promise<void>,
    onSelected: ResourcePackageSelectedHandler,
    onSurveySelected: ResourcePackageSurveyHandler,
    onError: (error: unknown) => void,
  ) {
    this.#onApplied = onApplied;
    this.#onSelected = onSelected;
    this.#onSurveySelected = onSurveySelected;
    this.#onError = onError;
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
      void this.#applySelection().catch(this.#onError);
    });
  }

  async activate(): Promise<void> {
    this.#active = true;
    const packages = await workspaceApi.resourcePackages();
    const packageSurveyIds = new Set(packages.map((record) => record.surveyId));
    const noPackageRows = [...new Set(this.#releaseDetails.map((detail) => detail.surveyId))]
      .filter((surveyId) => !packageSurveyIds.has(surveyId))
      .map((surveyId) => {
        const details = this.#releaseDetails.filter((detail) => detail.surveyId === surveyId);
        const first = details[0]!;
        return {
          id: `survey-${surveyId}`, name: first.mission, description: `公开 ${first.mission} Release 详情`, surveyId,
          modalities: [...new Set(details.flatMap((detail) => detail.modalities))], wavelengths: [],
          productTypes: [...new Set(details.flatMap((detail) => detail.products.map((product) => product.name)))], facilities: [first.mission],
          coverageAuthorities: [], accessModes: [], releases: details.map((detail) => detail.releaseId),
          releaseLabels: Object.fromEntries(details.map((detail) => [detail.releaseId, detail.label])),
          sources: details.map((detail) => ({ releaseId: detail.releaseId, label: detail.label, url: detail.officialSourceUrl, authority: detail.mission })),
          version: "", archiveUrl: "", sizeBytes: 0, sha256: "", updatedAt: "", hidden: false, deprecated: false, replacedBy: [],
          activeReleaseIds: [], availableReleaseIds: [], active: false, status: "not_installed" as const, hasPackage: false,
        } satisfies ResourceRow;
      });
    this.#records = [...packages.map((record) => ({ ...record, hasPackage: true })), ...noPackageRows];
    this.#baselineReleases = this.#releaseMapFromRecords();
    this.#draftReleases = this.#cloneReleaseMap(this.#baselineReleases);
    this.#selectedId ??= this.#records[0]?.id ?? null;
    this.#renderFilters();
    this.#render();
    this.#showSelected();
  }

  deactivate(): void {
    this.#active = false;
  }

  selectedRecord(): PublicResourcePackage | undefined {
    return this.#records.find((record) => record.id === this.#selectedId);
  }

  setReleaseDetails(details: PublicReleaseDetail[]): void {
    this.#releaseDetails = details;
    this.#render();
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
      this.#records = (await workspaceApi.resourcePackages()).map((record) => ({ ...record, hasPackage: true }));
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

  #catalogReleaseIds(record: ResourceRow): string[] {
    if (!record.hasPackage) return [];
    return [...new Set(this.#releaseDetails
      .filter((detail) => detail.surveyId === record.surveyId && detail.products.some((product) => product.coverageStatus === "acquired"))
      .map((detail) => detail.releaseId))];
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
    return this.#records.filter((record) => {
      const searchable = [record.name, record.description, record.surveyId, ...record.modalities, ...record.wavelengths, ...record.productTypes, ...record.facilities, ...record.releases].join(" ").toLocaleLowerCase();
      if (this.#search && !searchable.includes(this.#search)) return false;
      return FILTERS.every(([field]) => {
        const selected = this.#filters.get(field);
        return !selected?.size || record[field].some((value) => selected.has(value));
      });
    });
  }

  #visibleReleaseDetails(): PublicReleaseDetail[] {
    return this.#releaseDetails.filter((detail) => {
      if (!this.#search) return true;
      return [detail.mission, detail.label, detail.releaseId, detail.kind, ...detail.modalities, ...detail.products.flatMap((product) => [product.name, product.modality])]
        .join(" ").toLocaleLowerCase().includes(this.#search);
    });
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
    list.replaceChildren(...visible.map((record) => {
      const resourceRecord = record as ResourceRow;
      const row = document.createElement("article");
      row.className = "resource-package-row";
      row.dataset.status = record.status;
      row.dataset.selected = String(record.id === this.#selectedId);
      row.dataset.dirty = String(this.#packageIsDirty(record.id));
      row.addEventListener("click", (event) => {
        if ((event.target as HTMLElement).closest("input")) return;
        this.#selectedId = record.id;
        this.#showSelected();
        this.#onSurveySelected(record.surveyId);
      });

      const draft = this.#draftReleases.get(record.id) ?? new Set<string>();
      const available = this.#catalogReleaseIds(resourceRecord);
      row.dataset.loadable = String(resourceRecord.hasPackage && available.length > 0);
      const toggle = document.createElement("input");
      toggle.type = "checkbox";
      toggle.checked = available.length > 0 && draft.size === available.length;
      toggle.indeterminate = draft.size > 0 && draft.size < available.length;
      toggle.disabled = this.#busy || !resourceRecord.hasPackage || available.length === 0;
      toggle.setAttribute("aria-label", `选择${record.name}的全部发布版本`);
      if (!resourceRecord.hasPackage || available.length === 0) {
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
      const surveyReleases = this.#releaseDetails.filter((detail) => detail.surveyId === record.surveyId);
      const products = surveyReleases.flatMap((detail) => detail.products);
      const acquired = products.filter((product) => product.coverageStatus === "acquired").length;
      version.textContent = products.length ? `${acquired} / ${products.length} 产品有真实覆盖` : "覆盖状态待加载";
      version.title = "查看该巡天的公开版本列表";

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
    byId("resource-package-empty").hidden = visible.length > 0 || this.#visibleReleaseDetails().length > 0;
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
          await this.#waitForJob(record.id, job);
        } catch (error) {
          errors.push(error instanceof Error ? error : new Error(String(error)));
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(3, queue.length) }, () => worker()));
      this.#records = (await workspaceApi.resourcePackages()).map((record) => ({ ...record, hasPackage: true }));
      this.#renderFilters();
    } finally {
      this.#busy = false;
      this.#render();
      this.#showSelected();
    }
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
    if (this.#downloadQueue().length) throw new Error("仍有公开覆盖资源尚未下载");
    const loads: ResourcePackageLoad[] = [...this.#draftReleases].filter(([, releaseIds]) => releaseIds.size).map(([packageId, releaseIds]) => ({
      packageId,
      releaseIds: [...releaseIds],
    }));
    this.#busy = true;
    this.#render();
    const before = this.#records;
    try {
      this.#records = (await workspaceApi.setActiveResourcePackages(loads)).map((record) => ({ ...record, hasPackage: true }));
      this.#baselineReleases = this.#releaseMapFromRecords();
      this.#draftReleases = this.#cloneReleaseMap(this.#baselineReleases);
      await this.#onApplied(before, this.#records);
      this.#renderFilters();
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
