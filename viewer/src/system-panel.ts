import { workspaceApi } from "./api";
import type { RuntimeDataServices, WarehouseInstallationView } from "./api";
import type { AiProviderRecord, McpServerRecord } from "../../src/system-config";
import { notifyWorkspace } from "./notifications";

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

type SystemSection = "ai" | "mcp" | "warehouse" | "runtime" | "capabilities";

function settingsSection(value: string | undefined): SystemSection {
  return value === "mcp" || value === "warehouse" || value === "runtime" || value === "capabilities" ? value : "ai";
}

export class SystemPanel {
  private providers: AiProviderRecord[] = [];
  private servers: McpServerRecord[] = [];
  private runtime: RuntimeDataServices | null = null;
  private installation: WarehouseInstallationView | null = null;
  private initialized = false;
  private editingProvider: AiProviderRecord | null = null;
  private editingServer: McpServerRecord | null = null;

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
  }

  async activate(): Promise<void> {
    if (!this.initialized) {
      await this.refresh();
      this.initialized = true;
    } else await this.refresh();
    this.renderProviders(); this.renderServers(); this.renderWarehouse(); this.renderInstallation(); this.renderRuntime(); this.renderCapabilities(); this.emitSummary();
  }

  deactivate(): void {}
  debugState(): Record<string, unknown> { return { aiProviders: this.providers.length, mcpServers: this.servers.length, runtime: this.runtime ? "loaded" : "unavailable", installation: this.installation ? this.installation.observed.state : "unavailable" }; }

  private async refresh(): Promise<void> {
    const [providers, servers, runtime, installation] = await Promise.all([
      workspaceApi.aiProviders(),
      workspaceApi.mcpServers(),
      workspaceApi.runtimeDataServices().catch((error: unknown) => { this.fail(error); return null; }),
      workspaceApi.warehouseInstallation().catch(() => null),
    ]);
    this.providers = providers;
    this.servers = servers;
    this.runtime = runtime;
    this.installation = installation;
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
    byId("settings-warehouse-view").hidden = section !== "warehouse";
    byId("settings-runtime-view").hidden = section !== "runtime";
    byId("settings-capabilities-view").hidden = section !== "capabilities";
  }

  private renderRuntime(): void {
    const list = byId("runtime-service-list");
    const runtime = this.runtime;
    if (!runtime) {
      list.replaceChildren();
      return;
    }
    const catalogRow = document.createElement("article"); catalogRow.className = "settings-record"; cardStatus(catalogRow, runtime.catalog.available);    const catalogHeading = document.createElement("header"); const catalogTitle = document.createElement("strong"); catalogTitle.textContent = "公开巡天目录（Assets Catalog）"; const catalogBadge = document.createElement("span"); catalogBadge.textContent = runtime.catalog.available ? "可用" : "不可用"; catalogHeading.append(catalogTitle, catalogBadge);
    const catalogMeta = document.createElement("p"); catalogMeta.textContent = runtime.catalog.endpoint || "未配置（使用内置本地目录）";
    const catalogDetail = document.createElement("small");
    const catalogParts = [`最近同步：${runtime.catalog.syncedAt ? new Date(runtime.catalog.syncedAt).toLocaleString() : "尚未同步"}`];
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

  private renderWarehouse(): void {
    const list = byId("warehouse-info-list");
    const runtime = this.runtime;
    if (!runtime) {
      list.replaceChildren();
      return;
    }
    const warehouse = runtime.warehouseSearch;
    const row = document.createElement("article"); row.className = "settings-record"; cardStatus(row, warehouse.enabled && warehouse.configured);
    const heading = document.createElement("header");
    const title = document.createElement("strong"); title.textContent = "Warehouse 数据面";
    const badge = document.createElement("span"); badge.textContent = warehouse.enabled ? (warehouse.configured ? "已启用" : "未配置") : "未启用";
    heading.append(title, badge);
    const meta = document.createElement("p");
    meta.textContent = warehouse.enabled ? warehouse.endpoint || "已启用但未配置 Elasticsearch 端点" : "当前部署未启用 Warehouse 数据面（ASTRO_DATA_WAREHOUSE_ENABLED）";
    const detail = document.createElement("small");
    const parts = [`索引：${warehouse.indices.layer} / ${warehouse.indices.file} / ${warehouse.indices.coverage}`];
    parts.push(warehouse.enabled ? "下载任务可在审批后提交 Warehouse 扫描" : "下载任务仅注册本地 Connector，不提交 Warehouse 扫描");
    detail.textContent = parts.join(" · ");
    row.append(heading, meta, detail);
    list.replaceChildren(row);
  }

  private renderInstallation(): void {
    const list = byId("warehouse-installation-list");
    const installation = this.installation;
    if (!installation) {
      list.replaceChildren();
      return;
    }
    const cards: HTMLElement[] = [];
    const desired = installation.binding.desired;
    if (desired && !installation.binding.aligned) {
      const banner = document.createElement("article"); banner.className = "settings-record"; banner.dataset.status = "unknown";
      const bannerHeading = document.createElement("header");
      const bannerTitle = document.createElement("strong"); bannerTitle.textContent = "等待应用配置";
      const bannerBadge = document.createElement("span"); bannerBadge.textContent = "待重启";
      bannerHeading.append(bannerTitle, bannerBadge);
      const bannerMeta = document.createElement("p");
      bannerMeta.textContent = desired.enabled
        ? `期望连接：${desired.elasticsearchUrl || "（未填写端点）"} · 命名空间 ${desired.namespace}`
        : "期望断开 Warehouse 数据面";
      banner.append(bannerHeading, bannerMeta);
      const latest = installation.operations[0];
      if (latest?.guidance.length) {
        const steps = document.createElement("div"); steps.className = "installation-guidance";
        latest.guidance.forEach((line) => { const code = document.createElement("code"); code.textContent = line; steps.append(code); });
        banner.append(steps);
      }
      cards.push(banner);
    }

    const connectAction = installation.actions.find((action) => action.kind === "connect");
    if (connectAction?.available) {
      const connectRow = document.createElement("article"); connectRow.className = "settings-record";
      const connectHeading = document.createElement("header");
      const connectTitle = document.createElement("strong"); connectTitle.textContent = "连接已有 Warehouse";
      const connectBadge = document.createElement("span"); connectBadge.textContent = installation.observed.state === "connected" ? "已连接" : "未连接";
      connectHeading.append(connectTitle, connectBadge);
      const form = document.createElement("div"); form.className = "settings-record-actions installation-form";
      const endpointInput = document.createElement("input");
      endpointInput.id = "warehouse-endpoint";
      endpointInput.className = "field-input";
      endpointInput.type = "url";
      endpointInput.placeholder = "http://atlas-warehouse-elasticsearch.atlas-warehouse.svc.cluster.local:9200";
      endpointInput.value = installation.binding.effective.elasticsearchUrl || "";
      const namespaceInput = document.createElement("input");
      namespaceInput.id = "warehouse-namespace";
      namespaceInput.className = "field-input";
      namespaceInput.type = "text";
      namespaceInput.placeholder = "命名空间（默认 asa-workspace）";
      namespaceInput.value = installation.binding.effective.namespace || "";
      const connect = document.createElement("button"); connect.type = "button"; connect.className = "command-button secondary"; connect.textContent = "连接";
      connect.addEventListener("click", () => void this.reconcileInstallation({ kind: "connect", elasticsearchUrl: endpointInput.value.trim(), namespace: namespaceInput.value.trim() || undefined }));
      form.append(endpointInput, namespaceInput, connect);
      const note = document.createElement("small"); note.textContent = "连接会记录期望配置；管理员按提示应用并滚动更新后生效。";
      connectRow.append(connectHeading, form, note);
      cards.push(connectRow);
    } else if (connectAction) {
      const blockedRow = document.createElement("article"); blockedRow.className = "settings-record"; blockedRow.dataset.status = "unknown";
      const blockedHeading = document.createElement("header");
      const blockedTitle = document.createElement("strong"); blockedTitle.textContent = "连接已有 Warehouse";
      const blockedBadge = document.createElement("span"); blockedBadge.textContent = "当前渠道不可用";
      blockedHeading.append(blockedTitle, blockedBadge);
      const blockedMeta = document.createElement("p"); blockedMeta.textContent = connectAction.reason;
      blockedRow.append(blockedHeading, blockedMeta);
      cards.push(blockedRow);
    }

    const disconnectAction = installation.actions.find((action) => action.kind === "disconnect");
    if (disconnectAction?.available) {
      const disconnectRow = document.createElement("article"); disconnectRow.className = "settings-record";
      const disconnectHeading = document.createElement("header");
      const disconnectTitle = document.createElement("strong"); disconnectTitle.textContent = "断开 Warehouse";
      const disconnectBadge = document.createElement("span"); disconnectBadge.textContent = "可操作";
      disconnectHeading.append(disconnectTitle, disconnectBadge);
      const actions = document.createElement("div"); actions.className = "settings-record-actions";
      const disconnect = document.createElement("button"); disconnect.type = "button"; disconnect.className = "command-button danger"; disconnect.textContent = "断开连接";
      disconnect.addEventListener("click", () => void this.reconcileInstallation({ kind: "disconnect" }));
      actions.append(disconnect);
      disconnectRow.append(disconnectHeading, actions);
      cards.push(disconnectRow);
    }

    const installAction = installation.actions.find((action) => action.kind === "install");
    if (installAction && installation.observed.state !== "connected") {
      const installRow = document.createElement("article"); installRow.className = "settings-record"; installRow.dataset.status = "unknown";
      const installHeading = document.createElement("header");
      const installTitle = document.createElement("strong"); installTitle.textContent = "安装 Warehouse";
      const installBadge = document.createElement("span"); installBadge.textContent = installAction.available ? "可安装" : "暂不可安装";
      installHeading.append(installTitle, installBadge);
      const installMeta = document.createElement("p"); installMeta.textContent = installAction.reason;
      const installActions = document.createElement("div"); installActions.className = "settings-record-actions";
      const install = document.createElement("button"); install.type = "button"; install.className = "command-button secondary"; install.textContent = "安装"; install.disabled = !installAction.available;
      install.addEventListener("click", () => void this.reconcileInstallation({ kind: "install" }));
      installActions.append(install);
      installRow.append(installHeading, installMeta, installActions);
      if (installation.platform.notes.length) {
        const notes = document.createElement("small"); notes.textContent = installation.platform.notes.join("；");
        installRow.append(notes);
      }
      const latest = installation.operations.find((operation) => operation.intent?.kind === "install" || operation.intent?.kind === "uninstall");
      if (latest?.guidance.length) {
        const steps = document.createElement("div"); steps.className = "installation-guidance";
        latest.guidance.forEach((line) => { const code = document.createElement("code"); code.textContent = line; steps.append(code); });
        installRow.append(steps);
      }
      cards.push(installRow);
    }

    list.replaceChildren(...cards);
  }

  private async reconcileInstallation(intent: { kind: "connect"; elasticsearchUrl: string; namespace?: string } | { kind: "disconnect" } | { kind: "install" }): Promise<void> {
    try {
      const operation = await workspaceApi.reconcileWarehouseInstallation(intent);
      this.installation = await workspaceApi.warehouseInstallation().catch(() => this.installation);
      this.renderInstallation();
      notifyWorkspace("Warehouse 安装操作已受理", operation.reason, { tone: operation.status === "failed" ? "error" : "success" });
    } catch (error) { this.fail(error); }
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
