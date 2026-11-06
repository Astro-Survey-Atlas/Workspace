import { workspaceApi } from "./api";
import type { RuntimeDataServices } from "./api";
import type { AiProviderRecord, McpServerRecord } from "../../src/system-config";
import { notifyWorkspace } from "./notifications";
import type { DownloadSettingsView } from "./api";
import type { WorkspaceBackupPreview, PublicSelectionRestore } from "../../src/workspace-config-backup";

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing settings element: ${id}`);
  return element as T;
}

function statusLabel(status?: string): string { return status === "ok" ? "已连接" : status === "failed" ? "连接失败" : "未测试"; }

function cardStatus(row: HTMLElement, healthy: boolean): void { row.dataset.status = healthy ? "ok" : "unknown"; }

export interface SystemSummary {
  providers: number;
  servers: number;
  connected: number;
}

type SystemSection = "ai" | "mcp" | "runtime" | "capabilities" | "downloads" | "backup";

const BACKUP_PREFERENCE_KEYS = [
  "astro-workspace:survey-layer-preferences:v4", "astro-workspace:survey-layer-preferences:v3", "astro-workspace:survey-layer-preferences:v1",
  "astro-workspace:theme:v1", "astro-workspace:scene-background:v1", "astro-workspace:aladin-image-survey:v1",
];

function settingsSection(value: string | undefined): SystemSection {
  return value === "mcp" || value === "runtime" || value === "capabilities" || value === "downloads" || value === "backup" ? value : "ai";
}

export class SystemPanel {
  private providers: AiProviderRecord[] = [];
  private servers: McpServerRecord[] = [];
  private runtime: RuntimeDataServices | null = null;
  private initialized = false;
  private editingProvider: AiProviderRecord | null = null;
  private editingServer: McpServerRecord | null = null;
  private downloads: DownloadSettingsView | null = null;
  private downloadTimer?: ReturnType<typeof setInterval>;
  private downloadsRefreshing = false;
  private backupFile?: File;
  private backupPreview?: WorkspaceBackupPreview;
  private publicRestore?: PublicSelectionRestore;
  private publicRestoreTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly onError: (error: unknown) => void, private readonly onSummary: (summary: SystemSummary) => void) {
    byId<HTMLButtonElement>("ai-provider-new").addEventListener("click", () => this.openProvider());
    byId<HTMLButtonElement>("mcp-server-new").addEventListener("click", () => this.openServer());
    byId<HTMLButtonElement>("ai-provider-dialog-close").addEventListener("click", () => byId<HTMLDialogElement>("ai-provider-dialog").close());
    byId<HTMLButtonElement>("ai-provider-cancel").addEventListener("click", () => byId<HTMLDialogElement>("ai-provider-dialog").close());
    byId<HTMLButtonElement>("mcp-server-dialog-close").addEventListener("click", () => byId<HTMLDialogElement>("mcp-server-dialog").close());
    byId<HTMLButtonElement>("mcp-server-cancel").addEventListener("click", () => byId<HTMLDialogElement>("mcp-server-dialog").close());
    byId<HTMLFormElement>("ai-provider-form").addEventListener("submit", (event) => { event.preventDefault(); void this.saveProvider().catch((error) => this.fail(error)); });
    byId<HTMLFormElement>("mcp-server-form").addEventListener("submit", (event) => { event.preventDefault(); void this.saveServer().catch((error) => this.fail(error)); });
    byId<HTMLButtonElement>("ai-provider-test").addEventListener("click", () => void this.testProvider().catch((error) => this.fail(error)));
    byId<HTMLButtonElement>("mcp-server-test").addEventListener("click", () => void this.testServer().catch((error) => this.fail(error)));
    document.querySelectorAll<HTMLButtonElement>("[data-settings-tab]").forEach((button) => button.addEventListener("click", () => this.selectSection(settingsSection(button.dataset.settingsTab))));
    document.querySelectorAll<HTMLButtonElement>("[data-settings-section]").forEach((button) => button.addEventListener("click", () => this.selectSection(settingsSection(button.dataset.settingsSection))));
    byId<HTMLFormElement>("download-settings-form").addEventListener("submit", event => { event.preventDefault(); void this.saveDownloads().catch(error => this.fail(error)); });
    byId("download-proxy-test").addEventListener("click", () => void this.saveDownloads("test").catch(error => this.fail(error)));
    byId("download-proxy-clear").addEventListener("click", () => void this.saveDownloads("clear").catch(error => this.fail(error)));
    byId<HTMLInputElement>("config-backup-file").addEventListener("change", event => {
      this.backupFile = (event.currentTarget as HTMLInputElement).files?.[0];
      this.backupPreview = undefined;
      byId("config-backup-preview-result").hidden = true;
      byId("config-backup-path-mappings").replaceChildren();
      byId("config-backup-apply").hidden = true;
      byId<HTMLButtonElement>("config-backup-preview").disabled = !this.backupFile;
    });
    byId<HTMLButtonElement>("config-backup-export").addEventListener("click", () => void this.exportBackup().catch(error => this.fail(error)));
    byId<HTMLButtonElement>("config-backup-preview").addEventListener("click", () => void this.previewBackup().catch(error => this.fail(error)));
    byId<HTMLButtonElement>("config-backup-apply").addEventListener("click", () => void this.applyBackup().catch(error => this.fail(error)));
  }

  async activate(): Promise<void> {
    if (!this.initialized) {
      await this.refresh();
      this.initialized = true;
    } else await this.refresh();
    this.renderProviders(); this.renderServers(); this.renderRuntime(); this.renderCapabilities(); this.emitSummary();
    await this.refreshDownloads(true);
    if (this.downloadTimer) clearInterval(this.downloadTimer);
    this.downloadTimer = setInterval(() => void this.refreshDownloads(false).catch(() => undefined), 30_000);
    await this.refreshPublicSelection();
  }

  deactivate(): void {
    if (this.downloadTimer) clearInterval(this.downloadTimer);
    this.downloadTimer = undefined;
    if (this.publicRestoreTimer) clearTimeout(this.publicRestoreTimer);
    this.publicRestoreTimer = undefined;
  }
  debugState(): Record<string, unknown> { return { aiProviders: this.providers.length, mcpServers: this.servers.length, runtime: this.runtime ? "loaded" : "unavailable" }; }

  private async refresh(): Promise<void> {
    const [providers, servers, runtime] = await Promise.all([
      workspaceApi.aiProviders(),
      workspaceApi.mcpServers(),
      workspaceApi.runtimeDataServices().catch((error: unknown) => { this.fail(error); return null; }),
    ]);
    this.providers = providers;
    this.servers = servers;
    this.runtime = runtime;
  }

  private emitSummary(): void {
    this.onSummary({
      providers: this.providers.length,
      servers: this.servers.length,
      connected: this.providers.filter((provider) => provider.lastCheck?.status === "ok").length + this.servers.filter((server) => server.lastCheck?.status === "ok").length,
    });
  }

  private selectSection(section: SystemSection): void {
    document.querySelectorAll<HTMLButtonElement>("[data-settings-tab]").forEach((button) => { const active = button.dataset.settingsTab === section; button.classList.toggle("active", active); button.setAttribute("aria-selected", String(active)); });
    document.querySelectorAll<HTMLButtonElement>("[data-settings-section]").forEach((button) => button.classList.toggle("active", button.dataset.settingsSection === section));
    byId("settings-ai-view").hidden = section !== "ai";
    byId("settings-mcp-view").hidden = section !== "mcp";
    byId("settings-runtime-view").hidden = section !== "runtime";
    byId("settings-capabilities-view").hidden = section !== "capabilities";
    byId("settings-downloads-view").hidden = section !== "downloads";
    byId("settings-backup-view").hidden = section !== "backup";
    if (section === "backup") void this.refreshPublicSelection();
  }

  private backupPassword(): string { return byId<HTMLInputElement>("config-backup-password").value; }

  private browserPreferences(): Record<string, string> {
    const preferences: Record<string, string> = {};
    for (const key of BACKUP_PREFERENCE_KEYS) {
      try { const value = localStorage.getItem(key); if (value !== null) preferences[key] = value; } catch { /* storage may be unavailable */ }
    }
    return preferences;
  }

  private async exportBackup(): Promise<void> {
    const button = byId<HTMLButtonElement>("config-backup-export");
    button.disabled = true;
    try {
      const blob = await workspaceApi.exportConfigBackup(this.backupPassword(), this.browserPreferences());
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a"); link.href = url; link.download = `workspace-config-${new Date().toISOString().slice(0, 10)}.asaworkspace`;
      link.click(); URL.revokeObjectURL(url);
      byId("config-backup-feedback").textContent = "加密备份已导出。";
    } finally { button.disabled = false; }
  }

  private async previewBackup(): Promise<void> {
    if (!this.backupFile) throw new Error("请选择一个备份文件");
    const button = byId<HTMLButtonElement>("config-backup-preview");
    button.disabled = true;
    byId("config-backup-feedback").textContent = "正在校验密码和备份文件…";
    try {
      this.backupPreview = await workspaceApi.previewConfigBackup(this.backupFile, this.backupPassword());
      const result = byId("config-backup-preview-result");
      const summary = this.backupPreview.summary;
      result.replaceChildren();
      const heading = document.createElement("strong"); heading.textContent = "备份内容";
      const totals = document.createElement("p"); totals.textContent = `${summary.connectors} 个 Connector（${summary.credentialedConnectors} 个含凭据） · ${summary.assets} 个资产 · ${summary.surveys} 个用户巡天 · ${summary.aiProviders} 个 AI Provider · ${summary.mcpServers} 个 MCP Server · ${summary.publicPackages} 个公开资源包`;
      const replace = document.createElement("p"); replace.className = "config-backup-replace-note"; replace.textContent = "应用后会替换这些配置，现有文件与扫描、下载、生产历史保留。导入的 Connector 需要重新检测。";
      result.append(heading, totals, replace);
      const mappings = byId("config-backup-path-mappings");
      mappings.replaceChildren();
      for (const missing of summary.missingLocalRoots) {
        const row = document.createElement("label"); row.className = "config-backup-path-row";
        const detail = document.createElement("span"); detail.textContent = `${missing.name} · 原路径 ${missing.rootPath}`;
        const input = document.createElement("input"); input.className = "field-input"; input.type = "text"; input.dataset.sourcePath = missing.rootPath;
        input.placeholder = "可选：填写新环境内已授权的目录路径";
        row.append(detail, input); mappings.append(row);
      }
      result.hidden = false;
      byId("config-backup-apply").hidden = false;
      byId("config-backup-feedback").textContent = `校验通过 · 预览有效至 ${new Date(this.backupPreview.expiresAt).toLocaleTimeString()}`;
    } finally { button.disabled = !this.backupFile; }
  }

  private async applyBackup(): Promise<void> {
    if (!this.backupPreview) throw new Error("请先校验并预览备份文件");
    const pathMappings: Record<string, string> = {};
    byId("config-backup-path-mappings").querySelectorAll<HTMLInputElement>("input[data-source-path]").forEach(input => {
      if (input.value.trim()) pathMappings[input.dataset.sourcePath!] = input.value.trim();
    });
    const button = byId<HTMLButtonElement>("config-backup-apply"); button.disabled = true;
    byId("config-backup-feedback").textContent = "正在应用配置…";
    try {
      const result = await workspaceApi.applyConfigBackup(this.backupPreview.previewId, pathMappings);
      for (const key of BACKUP_PREFERENCE_KEYS) {
        try { localStorage.removeItem(key); } catch { /* storage may be unavailable */ }
      }
      for (const [key, value] of Object.entries(result.browserPreferences)) {
        if (BACKUP_PREFERENCE_KEYS.includes(key)) { try { localStorage.setItem(key, value); } catch { /* storage may be unavailable */ } }
      }
      byId("config-backup-feedback").textContent = `已导入 ${result.imported.connectors} 个 Connector、${result.imported.assets} 个资产和 ${result.imported.surveys} 个巡天。正在恢复公开资源选择。`;
      notifyWorkspace("配置导入完成", "页面即将重新载入；新环境中的 Connector 需要重新检测。", { tone: "success" });
      setTimeout(() => window.location.reload(), 900);
    } finally { button.disabled = false; }
  }

  private async refreshPublicSelection(): Promise<void> {
    try {
      this.publicRestore = (await workspaceApi.configBackupPublicSelection()) ?? undefined;
      this.renderPublicSelection();
      if (this.publicRestore?.status === "running" && this.#backupVisible()) {
        if (this.publicRestoreTimer) clearTimeout(this.publicRestoreTimer);
        this.publicRestoreTimer = setTimeout(() => { this.publicRestoreTimer = undefined; void this.refreshPublicSelection(); }, 1500);
      }
    } catch { /* status is optional before the first restore */ }
  }

  #backupVisible(): boolean { return !byId("settings-backup-view").hidden; }

  private renderPublicSelection(): void {
    const root = byId("config-backup-public-restore");
    const restore = this.publicRestore;
    root.hidden = !restore;
    if (!restore) return;
    const heading = document.createElement("header");
    const title = document.createElement("strong"); title.textContent = "公开资源恢复";
    const status = document.createElement("span"); status.textContent = restore.status === "succeeded" ? "已完成" : restore.status === "running" ? "正在下载" : restore.status === "partial" ? "部分失败" : "等待恢复";
    heading.append(title, status);
    const rows = restore.packages.map(item => {
      const row = document.createElement("p");
      row.textContent = `${item.packageId} · ${item.status === "succeeded" ? "已准备" : item.status === "running" ? "下载中" : item.status === "failed" ? `失败：${item.error ?? "可重试"}` : "等待中"}`;
      return row;
    });
    root.replaceChildren(heading, ...rows);
    if (restore.status === "partial" || restore.status === "pending") {
      const actions = document.createElement("div"); actions.className = "settings-record-actions";
      const retry = document.createElement("button"); retry.type = "button"; retry.className = "command-button secondary"; retry.textContent = "重试公开资源恢复";
      retry.addEventListener("click", () => void workspaceApi.retryConfigBackupPublicSelection().then(value => { this.publicRestore = value; this.renderPublicSelection(); void this.refreshPublicSelection(); }).catch(error => this.fail(error)));
      actions.append(retry); root.append(actions);
    }
  }

  private async refreshDownloads(form: boolean): Promise<void> {
    if (this.downloadsRefreshing) return;
    this.downloadsRefreshing = true;
    try {
      const view = await workspaceApi.downloadSettings().catch(() => null);
      if (view?.settings) this.downloads = view;
      else this.downloads = null;
      if (form && this.downloads) this.fillDownloads();
      this.renderDownloads();
    } finally { this.downloadsRefreshing = false; }
  }

  private fillDownloads(): void {
    const settings = this.downloads?.settings;
    if (!settings) return;
    byId<HTMLInputElement>("download-proxy-enabled").checked = settings.proxyEnabled;
    byId<HTMLInputElement>("download-proxy-url").value = settings.proxyUrl;
    byId<HTMLInputElement>("download-proxy-username").value = settings.proxyUsername;
    byId<HTMLInputElement>("download-proxy-password").value = "";
    byId<HTMLInputElement>("download-proxy-password").placeholder = settings.passwordConfigured ? "已保存，输入新值可替换" : "无需认证可留空";
  }

  private async saveDownloads(action?: "test" | "clear"): Promise<void> {
    const form = byId<HTMLFormElement>("download-settings-form"), feedback = byId("download-proxy-feedback");
    const buttons = [...form.querySelectorAll<HTMLButtonElement>("button")]; buttons.forEach(button => { button.disabled = true; });
    feedback.textContent = action === "test" ? "正在保存并检测…" : "正在保存…";
    try {
      const password = byId<HTMLInputElement>("download-proxy-password").value;
      this.downloads = await workspaceApi.saveDownloadSettings({ proxyEnabled: byId<HTMLInputElement>("download-proxy-enabled").checked,
        proxyUrl: byId<HTMLInputElement>("download-proxy-url").value,
        proxyUsername: action === "clear" ? "" : byId<HTMLInputElement>("download-proxy-username").value,
        ...(action === "clear" ? { proxyPassword: null } : password ? { proxyPassword: password } : {}) });
      this.fillDownloads();
      if (action === "test") this.downloads = await workspaceApi.testDownloadRoute();
      feedback.textContent = action === "test" ? this.downloads.health.detail : "下载设置已保存";
      this.renderDownloads();
    } catch (error) { feedback.textContent = error instanceof Error ? error.message : "下载设置操作失败"; throw error; }
    finally { buttons.forEach(button => { button.disabled = false; }); }
  }

  private renderDownloads(): void {
    const view = this.downloads, host = byId("download-route-health");
    const heading = document.createElement("header"), title = document.createElement("strong"); title.textContent = "代理链路";
    const badge = document.createElement("span"); badge.textContent = !view?.health.engineAvailable ? "服务不可用"
      : view.health.status === "ok" ? "可用" : view.health.status === "failed" ? "不可用" : "检测中";
    heading.append(title, badge); host.replaceChildren(heading);
    if (view) {
      const health = view.health, details = document.createElement("p"); details.textContent = health.detail; host.append(details);
      const timing = document.createElement("p"); timing.textContent = `${view.settings.proxyEnabled ? `代理连接：${health.proxyConnectMs === undefined ? "--" : `${health.proxyConnectMs} ms`} · ` : "直连 · "}链路响应：${health.sourceResponseMs === undefined ? "--" : `${health.sourceResponseMs} ms`}`;
      host.append(timing);
      const checked = document.createElement("small"); checked.textContent = `最近检测：${health.checkedAt ? new Date(health.checkedAt).toLocaleString() : "尚未检测"}`; host.append(checked);
    }
    host.append(this.renderProxyLatency(view?.healthHistory ?? []));
  }

  private renderProxyLatency(history: NonNullable<DownloadSettingsView["healthHistory"]>): HTMLElement {
    const section = document.createElement("section"); section.className = "proxy-latency";
    const title = document.createElement("strong"); title.textContent = `${this.downloads?.settings.proxyEnabled ? "代理" : "直连"}链路延时 · 最近 24 次检测`;
    section.append(title);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 360 104"); svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "最近 24 次代理链路延时波形图");
    const samples = history.filter(sample => sample.checkedAt && (sample.status === "ok" || sample.status === "failed")).slice(-24);
    const max = Math.max(100, ...samples.map(sample => sample.sourceResponseMs ?? 0));
    const scale = Math.ceil(max / 100) * 100;
    const left = 40, right = 352, top = 10, bottom = 70;
    for (let index = 0; index < 3; index++) {
      const y = top + index * ((bottom - top) / 2), grid = document.createElementNS(svg.namespaceURI, "line");
      grid.setAttribute("x1", String(left)); grid.setAttribute("x2", String(right)); grid.setAttribute("y1", String(y)); grid.setAttribute("y2", String(y));
      grid.setAttribute("class", "proxy-latency-grid"); svg.append(grid);
      const label = document.createElementNS(svg.namespaceURI, "text"); label.setAttribute("x", "2"); label.setAttribute("y", String(y + 3));
      label.textContent = `${Math.round(scale * (2 - index) / 2)} ms`; svg.append(label);
    }
    const paths: string[] = [];
    let current: string[] = [];
    samples.forEach((sample, index) => {
      const x = left + (samples.length <= 1 ? right - left : index / (samples.length - 1) * (right - left));
      if (sample.status !== "ok") { if (current.length) paths.push(current.join(" ")); current = []; return; }
      const y = bottom - Math.min(1, (sample.sourceResponseMs ?? 0) / scale) * (bottom - top);
      current.push(`${current.length ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`);
    });
    if (current.length) paths.push(current.join(" "));
    for (const data of paths) { const line = document.createElementNS(svg.namespaceURI, "path"); line.setAttribute("d", data); line.setAttribute("class", "proxy-latency-line"); svg.append(line); }
    samples.forEach((sample, index) => {
      const x = left + (samples.length <= 1 ? right - left : index / (samples.length - 1) * (right - left));
      const point = document.createElementNS(svg.namespaceURI, "circle"); point.setAttribute("cx", x.toFixed(1));
      point.setAttribute("cy", sample.status === "ok" ? String(bottom - Math.min(1, (sample.sourceResponseMs ?? 0) / scale) * (bottom - top)) : "82");
      point.setAttribute("r", "3.5"); point.setAttribute("class", sample.status === "ok" ? "proxy-latency-point" : "proxy-latency-failure");
      point.setAttribute("tabindex", "0"); point.setAttribute("aria-label", `${new Date(sample.checkedAt).toLocaleString()} ${sample.status === "ok" ? `${sample.sourceResponseMs} ms` : "连接失败"}`);
      const tooltip = document.createElementNS(svg.namespaceURI, "title"); tooltip.textContent = `${new Date(sample.checkedAt).toLocaleString()} · ${sample.status === "ok" ? `${sample.sourceResponseMs} ms` : "连接失败"}`;
      point.append(tooltip); svg.append(point);
    });
    if (!samples.length) { const empty = document.createElementNS(svg.namespaceURI, "text"); empty.setAttribute("x", "196"); empty.setAttribute("y", "48"); empty.setAttribute("text-anchor", "middle"); empty.textContent = "等待首次检测"; svg.append(empty); }
    section.append(svg);
    return section;
  }

  private renderRuntime(): void {
    const list = byId("runtime-service-list");
    const runtime = this.runtime;
    if (!runtime) {
      list.replaceChildren();
      return;
    }
    const catalogRow = document.createElement("article"); catalogRow.className = "settings-record"; cardStatus(catalogRow, runtime.catalog.available && !runtime.catalog.stale);    const catalogHeading = document.createElement("header"); const catalogTitle = document.createElement("strong"); catalogTitle.textContent = "公开巡天目录（Assets Catalog）"; const catalogBadge = document.createElement("span"); catalogBadge.textContent = runtime.catalog.stale ? "最新同步失败" : runtime.catalog.available ? "可用" : "不可用"; catalogHeading.append(catalogTitle, catalogBadge);
    const catalogMeta = document.createElement("p"); catalogMeta.textContent = runtime.catalog.endpoint || "未配置（使用内置本地目录）";
    const catalogDetail = document.createElement("small");
    const catalogParts = [`最近同步：${runtime.catalog.syncedAt ? new Date(runtime.catalog.syncedAt).toLocaleString() : "尚未同步"}`];
    if (runtime.catalog.lastSyncError) catalogParts.push(`旧缓存，未同步到最新发布：${runtime.catalog.lastSyncError}`);
    if (runtime.catalog.unavailableReason) catalogParts.push(`原因：${runtime.catalog.unavailableReason}`);
    catalogDetail.textContent = catalogParts.join(" · ");
    catalogRow.append(catalogHeading, catalogMeta, catalogDetail);

    const searchRow = document.createElement("article"); searchRow.className = "settings-record"; cardStatus(searchRow, runtime.workspaceSearch.configured);
    const searchHeading = document.createElement("header"); const searchTitle = document.createElement("strong"); searchTitle.textContent = "Workspace 搜索（Elasticsearch）"; const searchBadge = document.createElement("span"); searchBadge.textContent = runtime.workspaceSearch.configured ? "已配置" : "未配置"; searchHeading.append(searchTitle, searchBadge);
    const searchMeta = document.createElement("p"); searchMeta.textContent = runtime.workspaceSearch.endpoint || "未配置（对象索引与覆盖概览不可用）";
    const searchDetail = document.createElement("small"); searchDetail.textContent = `索引：${runtime.workspaceSearch.indices.file} / ${runtime.workspaceSearch.indices.object} / ${runtime.workspaceSearch.indices.coverage}`;
    searchRow.append(searchHeading, searchMeta, searchDetail);

    const cards: HTMLElement[] = [catalogRow, searchRow];

    if (runtime.assetsApi) {
      const assetsRow = document.createElement("article"); assetsRow.className = "settings-record"; cardStatus(assetsRow, true);
      const assetsHeading = document.createElement("header");
      const assetsTitle = document.createElement("strong"); assetsTitle.textContent = "Assets 数据服务 API Key";
      const assetsBadge = document.createElement("span"); assetsBadge.textContent = runtime.assetsApi.apiKeyConfigured ? "已配置" : "未配置";
      assetsHeading.append(assetsTitle, assetsBadge);
      const assetsMeta = document.createElement("p"); assetsMeta.textContent = runtime.assetsApi.endpoint || "未配置（使用内置本地目录）";
      const assetsForm = document.createElement("div"); assetsForm.className = "settings-record-actions assets-key-form";
      const keyInput = document.createElement("input");
      keyInput.id = "assets-api-key";
      keyInput.className = "field-input";
      keyInput.type = "password";
      keyInput.autocomplete = "off";
      keyInput.placeholder = runtime.assetsApi.apiKeyConfigured ? "已保存（输入新值可替换）" : "粘贴实例级 API Key";
      const save = document.createElement("button"); save.type = "button"; save.className = "command-button secondary"; save.textContent = "保存";
      save.addEventListener("click", () => void this.saveAssetsKey(keyInput.value || null));
      const clear = document.createElement("button"); clear.type = "button"; clear.className = "command-button danger"; clear.textContent = "清除";
      clear.addEventListener("click", () => void this.saveAssetsKey(null));
      assetsForm.append(keyInput, save, clear);
      const assetsNote = document.createElement("small"); assetsNote.textContent = "密钥仅保存在服务端密钥存储，不会写入任务、产物或日志。";
      assetsRow.append(assetsHeading, assetsMeta, assetsForm, assetsNote);
      cards.push(assetsRow);
    }

    list.replaceChildren(...cards);
  }

  private renderCapabilities(): void {
    const list = byId("capability-list");
    const runtime = this.runtime;
    const capabilities = runtime?.capabilities ?? [];
    if (!runtime || !capabilities.length) {
      list.replaceChildren();
      return;
    }
    const kindLabels: Record<string, string> = { pipeline: "流水线", resolver: "来源解析器", transfer: "传输", handoff: "交接" };
    const availabilityLabels: Record<string, string> = { available: "可用", planned: "规划中", unavailable: "不可用" };
    list.replaceChildren(...capabilities.map((capability) => {
      const row = document.createElement("article"); row.className = "settings-record";
      row.dataset.status = capability.availability === "available" ? "ok" : capability.availability === "unavailable" ? "failed" : "unknown";
      const heading = document.createElement("header");
      const title = document.createElement("strong"); title.textContent = capability.key;
      const badge = document.createElement("span"); badge.textContent = availabilityLabels[capability.availability] ?? capability.availability;
      heading.append(title, badge);
      const meta = document.createElement("p"); meta.textContent = `${kindLabels[capability.kind] ?? capability.kind} · ${capability.title} · v${capability.version}`;
      const detail = document.createElement("small");
      detail.append(`${capability.responsibility} · `);
      if (capability.sourceUrl) {
        const link = document.createElement("a"); link.className = "capability-link"; link.textContent = "源码锚点"; link.href = capability.sourceUrl; link.target = "_blank"; link.rel = "noreferrer";
        detail.append(link);
      } else detail.append("源码锚点未注入（本地构建）");
      row.append(heading, meta, detail);
      return row;
    }));
  }

  private async saveAssetsKey(apiKey: string | null): Promise<void> {
    try {
      const result = await workspaceApi.setAssetsApiKey(apiKey);
      if (this.runtime?.assetsApi) this.runtime = { ...this.runtime, assetsApi: { ...this.runtime.assetsApi, apiKeyConfigured: result.assets.apiKeyConfigured } };
      const input = document.getElementById("assets-api-key") as HTMLInputElement | null;
      if (input) input.value = "";
      this.renderRuntime();
      notifyWorkspace("Assets API Key 已更新", result.assets.apiKeyConfigured ? "密钥已保存" : "密钥已清除", { tone: "success" });
    } catch (error) { this.fail(error); }
  }

  private openProvider(record?: AiProviderRecord): void {
    this.editingProvider = record ?? null;
    byId<HTMLInputElement>("ai-provider-name").value = record?.name ?? "";
    byId<HTMLInputElement>("ai-provider-url").value = record?.baseUrl ?? "";
    byId<HTMLInputElement>("ai-provider-model").value = record?.model ?? "";
    byId<HTMLInputElement>("ai-provider-key").value = "";
    byId<HTMLInputElement>("ai-provider-default").checked = record?.isDefault ?? this.providers.length === 0;
    byId<HTMLDialogElement>("ai-provider-dialog").showModal();
  }

  private openServer(record?: McpServerRecord): void {
    this.editingServer = record ?? null;
    byId<HTMLInputElement>("mcp-server-name").value = record?.name ?? "";
    byId<HTMLInputElement>("mcp-server-url").value = record?.url ?? "";
    byId<HTMLSelectElement>("mcp-server-transport").value = record?.transport ?? "streamable-http";
    byId<HTMLInputElement>("mcp-server-token").value = "";
    byId<HTMLDialogElement>("mcp-server-dialog").showModal();
  }

  private async saveProvider(): Promise<AiProviderRecord> {
    const saved = await workspaceApi.saveAiProvider({ id: this.editingProvider?.id, name: byId<HTMLInputElement>("ai-provider-name").value, baseUrl: byId<HTMLInputElement>("ai-provider-url").value, model: byId<HTMLInputElement>("ai-provider-model").value, apiKey: byId<HTMLInputElement>("ai-provider-key").value || undefined, isDefault: byId<HTMLInputElement>("ai-provider-default").checked });
    this.providers = [saved, ...this.providers.filter((provider) => provider.id !== saved.id).map((provider) => saved.isDefault ? { ...provider, isDefault: false } : provider)];
    byId<HTMLDialogElement>("ai-provider-dialog").close(); this.renderProviders(); this.emitSummary(); notifyWorkspace("AI Provider 已保存", saved.name, { tone: "success" });
    return saved;
  }

  private async testProvider(): Promise<void> {
    const saved = await this.saveProvider();
    const tested = await workspaceApi.testAiProvider(saved.id);
    this.providers = this.providers.map((provider) => provider.id === tested.id ? tested : provider);
    this.renderProviders(); this.emitSummary();
  }

  private async saveServer(): Promise<McpServerRecord> {
    const saved = await workspaceApi.saveMcpServer({ id: this.editingServer?.id, name: byId<HTMLInputElement>("mcp-server-name").value, url: byId<HTMLInputElement>("mcp-server-url").value, transport: byId<HTMLSelectElement>("mcp-server-transport").value as "streamable-http" | "sse", token: byId<HTMLInputElement>("mcp-server-token").value || undefined });
    this.servers = [saved, ...this.servers.filter((server) => server.id !== saved.id)];
    byId<HTMLDialogElement>("mcp-server-dialog").close(); this.renderServers(); this.emitSummary(); notifyWorkspace("MCP Server 已保存", saved.name, { tone: "success" });
    return saved;
  }

  private async testServer(): Promise<void> {
    const saved = await this.saveServer();
    const tested = await workspaceApi.testMcpServer(saved.id);
    this.servers = this.servers.map((server) => server.id === tested.id ? tested : server);
    this.renderServers(); this.emitSummary();
  }

  private renderProviders(): void {
    const list = byId("ai-provider-list");
    list.replaceChildren(...this.providers.map((provider) => {
      const row = document.createElement("article"); row.className = "settings-record"; row.dataset.status = provider.lastCheck?.status ?? "unknown";
      const heading = document.createElement("header"); const title = document.createElement("strong"); title.textContent = provider.name; const badge = document.createElement("span"); badge.textContent = provider.isDefault ? "默认" : statusLabel(provider.lastCheck?.status); heading.append(title, badge);
      const meta = document.createElement("p"); meta.textContent = `${provider.model} · ${provider.baseUrl} · API Key ${provider.apiKeyConfigured ? "已配置" : "未配置"}`;
      const actions = document.createElement("div"); actions.className = "settings-record-actions";
      const edit = document.createElement("button"); edit.type = "button"; edit.className = "command-button secondary"; edit.textContent = "编辑"; edit.addEventListener("click", () => this.openProvider(provider));
      const test = document.createElement("button"); test.type = "button"; test.className = "command-button secondary"; test.textContent = "测试"; test.addEventListener("click", () => void workspaceApi.testAiProvider(provider.id).then((saved) => { this.providers = this.providers.map((candidate) => candidate.id === saved.id ? saved : candidate); this.renderProviders(); this.emitSummary(); }).catch((error) => this.fail(error)));
      const remove = document.createElement("button"); remove.type = "button"; remove.className = "command-button danger"; remove.textContent = "删除"; remove.addEventListener("click", () => void workspaceApi.deleteAiProvider(provider.id).then(() => { this.providers = this.providers.filter((candidate) => candidate.id !== provider.id); this.renderProviders(); this.emitSummary(); }).catch((error) => this.fail(error)));
      actions.append(edit, test, remove); row.append(heading, meta, actions); return row;
    }));
  }

  private renderServers(): void {
    const list = byId("mcp-server-list");
    list.replaceChildren(...this.servers.map((server) => {
      const row = document.createElement("article"); row.className = "settings-record"; row.dataset.status = server.lastCheck?.status ?? "unknown";
      const heading = document.createElement("header"); const title = document.createElement("strong"); title.textContent = server.name; const badge = document.createElement("span"); badge.textContent = statusLabel(server.lastCheck?.status); heading.append(title, badge);
      const meta = document.createElement("p"); meta.textContent = `${server.transport} · ${server.url} · Token ${server.tokenConfigured ? "已配置" : "未配置"}`;
      const tools = document.createElement("small"); tools.textContent = server.tools.length ? `${server.tools.length} 个工具已启用` : "尚未发现工具";
      const actions = document.createElement("div"); actions.className = "settings-record-actions";
      const edit = document.createElement("button"); edit.type = "button"; edit.className = "command-button secondary"; edit.textContent = "编辑"; edit.addEventListener("click", () => this.openServer(server));
      const test = document.createElement("button"); test.type = "button"; test.className = "command-button secondary"; test.textContent = "连接并发现"; test.addEventListener("click", () => void workspaceApi.testMcpServer(server.id).then((saved) => { this.servers = this.servers.map((candidate) => candidate.id === saved.id ? saved : candidate); this.renderServers(); this.emitSummary(); }).catch((error) => this.fail(error)));
      const remove = document.createElement("button"); remove.type = "button"; remove.className = "command-button danger"; remove.textContent = "删除"; remove.addEventListener("click", () => void workspaceApi.deleteMcpServer(server.id).then(() => { this.servers = this.servers.filter((candidate) => candidate.id !== server.id); this.renderServers(); this.emitSummary(); }).catch((error) => this.fail(error)));
      actions.append(edit, test, remove); row.append(heading, meta, tools, actions); return row;
    }));
  }

  private fail(error: unknown): void { const message = error instanceof Error ? error.message : String(error); notifyWorkspace("系统配置操作失败", message, { tone: "error" }); this.onError(error); }
}
