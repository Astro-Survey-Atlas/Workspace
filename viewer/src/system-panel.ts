import { workspaceApi } from "./api";
import type { AiProviderRecord, McpServerRecord } from "../../src/system-config";
import { notifyWorkspace } from "./notifications";

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing settings element: ${id}`);
  return element as T;
}

function statusLabel(status?: string): string { return status === "ok" ? "已连接" : status === "failed" ? "连接失败" : "未测试"; }

export interface SystemSummary {
  providers: number;
  servers: number;
  connected: number;
}

export class SystemPanel {
  private providers: AiProviderRecord[] = [];
  private servers: McpServerRecord[] = [];
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
    document.querySelectorAll<HTMLButtonElement>("[data-settings-tab]").forEach((button) => button.addEventListener("click", () => this.selectSection(button.dataset.settingsTab === "mcp" ? "mcp" : "ai")));
    document.querySelectorAll<HTMLButtonElement>("[data-settings-section]").forEach((button) => button.addEventListener("click", () => this.selectSection(button.dataset.settingsSection === "mcp" ? "mcp" : "ai")));
  }

  async activate(): Promise<void> {
    if (!this.initialized) {
      [this.providers, this.servers] = await Promise.all([workspaceApi.aiProviders(), workspaceApi.mcpServers()]);
      this.initialized = true;
    } else await this.refresh();
    this.renderProviders(); this.renderServers(); this.emitSummary();
  }

  deactivate(): void {}
  debugState(): Record<string, unknown> { return { aiProviders: this.providers.length, mcpServers: this.servers.length }; }

  private async refresh(): Promise<void> { [this.providers, this.servers] = await Promise.all([workspaceApi.aiProviders(), workspaceApi.mcpServers()]); }

  private emitSummary(): void {
    this.onSummary({
      providers: this.providers.length,
      servers: this.servers.length,
      connected: this.providers.filter((provider) => provider.lastCheck?.status === "ok").length + this.servers.filter((server) => server.lastCheck?.status === "ok").length,
    });
  }

  private selectSection(section: "ai" | "mcp"): void {
    document.querySelectorAll<HTMLButtonElement>("[data-settings-tab]").forEach((button) => { const active = button.dataset.settingsTab === section; button.classList.toggle("active", active); button.setAttribute("aria-selected", String(active)); });
    document.querySelectorAll<HTMLButtonElement>("[data-settings-section]").forEach((button) => button.classList.toggle("active", button.dataset.settingsSection === section));
    byId("settings-ai-view").hidden = section !== "ai";
    byId("settings-mcp-view").hidden = section !== "mcp";
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
