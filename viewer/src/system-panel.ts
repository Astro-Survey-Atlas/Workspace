import { workspaceApi } from "./api";
import type { RuntimeDataServices } from "./api";
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

type SystemSection = "ai" | "mcp" | "runtime";

function settingsSection(value: string | undefined): SystemSection {
  return value === "mcp" || value === "runtime" ? value : "ai";
}

export class SystemPanel {
  private providers: AiProviderRecord[] = [];
  private servers: McpServerRecord[] = [];
  private runtime: RuntimeDataServices | null = null;
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
    this.renderProviders(); this.renderServers(); this.renderRuntime(); this.emitSummary();
  }

  deactivate(): void {}
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
    const catalogParts = [`最近同步：${runtime.catalog.syncedAt ? new Date(runtime.catalog.syncedAt).toLocaleString() : "尚未同步"}`, `管理员 token：${runtime.catalog.adminConfigured ? "已配置" : "未配置"}`];
    if (runtime.catalog.unavailableReason) catalogParts.push(`原因：${runtime.catalog.unavailableReason}`);
    catalogDetail.textContent = catalogParts.join(" · ");
    catalogRow.append(catalogHeading, catalogMeta, catalogDetail);

    const searchRow = document.createElement("article"); searchRow.className = "settings-record"; cardStatus(searchRow, runtime.workspaceSearch.configured);
    const searchHeading = document.createElement("header"); const searchTitle = document.createElement("strong"); searchTitle.textContent = "Workspace 搜索（Elasticsearch）"; const searchBadge = document.createElement("span"); searchBadge.textContent = runtime.workspaceSearch.configured ? "已配置" : "未配置"; searchHeading.append(searchTitle, searchBadge);
    const searchMeta = document.createElement("p"); searchMeta.textContent = runtime.workspaceSearch.endpoint || "未配置（对象索引与覆盖概览不可用）";
    const searchDetail = document.createElement("small"); searchDetail.textContent = `索引：${runtime.workspaceSearch.indices.file} / ${runtime.workspaceSearch.indices.object} / ${runtime.workspaceSearch.indices.coverage}`;
    searchRow.append(searchHeading, searchMeta, searchDetail);

    const warehouseRow = document.createElement("article"); warehouseRow.className = "settings-record"; cardStatus(warehouseRow, runtime.warehouseSearch.enabled && runtime.warehouseSearch.configured);
    const warehouseHeading = document.createElement("header"); const warehouseTitle = document.createElement("strong"); warehouseTitle.textContent = "Warehouse 搜索（可选远程数据面）"; const warehouseBadge = document.createElement("span"); warehouseBadge.textContent = runtime.warehouseSearch.enabled ? (runtime.warehouseSearch.configured ? "已启用" : "未配置") : "未启用"; warehouseHeading.append(warehouseTitle, warehouseBadge);
    const warehouseMeta = document.createElement("p"); warehouseMeta.textContent = runtime.warehouseSearch.enabled ? runtime.warehouseSearch.endpoint || "已启用但未配置端点" : "当前部署未启用 Warehouse 数据面";
    const warehouseDetail = document.createElement("small"); warehouseDetail.textContent = `索引：${runtime.warehouseSearch.indices.layer} / ${runtime.warehouseSearch.indices.file} / ${runtime.warehouseSearch.indices.coverage}`;
    warehouseRow.append(warehouseHeading, warehouseMeta, warehouseDetail);

    const cards: HTMLElement[] = [catalogRow, searchRow, warehouseRow];

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

    const capabilities = runtime.capabilities ?? [];
    if (capabilities.length) {
      const capabilityRow = document.createElement("article"); capabilityRow.className = "settings-record capability-registry"; cardStatus(capabilityRow, true);
      const capabilityHeading = document.createElement("header");
      const capabilityTitle = document.createElement("strong"); capabilityTitle.textContent = "生产能力注册表";
      const capabilityBadge = document.createElement("span"); capabilityBadge.textContent = `${capabilities.length} 项 · 只读`;
      capabilityHeading.append(capabilityTitle, capabilityBadge);
      const commitNote = runtime.build?.commit ? `源码锚点 ${runtime.build.commit.slice(0, 12)}` : "源码锚点未注入（本地构建）";
      const capabilityMeta = document.createElement("p"); capabilityMeta.textContent = `全部生产能力的版本与职责说明。${commitNote}`;
      const groups = document.createElement("div"); groups.className = "capability-groups";
      const kindLabels: Record<string, string> = { pipeline: "流水线", resolver: "来源解析器", transfer: "传输", handoff: "交接" };
      (["pipeline", "resolver", "transfer", "handoff"] as const).forEach((kind) => {
        const entries = capabilities.filter((capability) => capability.kind === kind);
        if (!entries.length) return;
        const group = document.createElement("section"); group.className = "capability-group";
        const groupTitle = document.createElement("strong"); groupTitle.textContent = kindLabels[kind] ?? kind;
        group.append(groupTitle);
        entries.forEach((capability) => {
          const item = document.createElement("div"); item.className = "capability-item"; item.dataset.availability = capability.availability;
          const name = capability.sourceUrl
            ? Object.assign(document.createElement("a"), { textContent: `${capability.key}`, href: capability.sourceUrl, target: "_blank", rel: "noreferrer", className: "capability-link" })
            : Object.assign(document.createElement("span"), { textContent: `${capability.key}`, className: "capability-link" });
          const detail = document.createElement("small");
          detail.textContent = `${capability.title} · ${capability.responsibility}${capability.availability !== "available" ? ` · 不可用` : ""}`;
          item.append(name, detail);
          group.append(item);
        });
        groups.append(group);
      });
      capabilityRow.append(capabilityHeading, capabilityMeta, groups);
      cards.push(capabilityRow);
    }

    list.replaceChildren(...cards);
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
