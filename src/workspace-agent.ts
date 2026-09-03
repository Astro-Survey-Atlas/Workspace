import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ConnectorRegistry } from "./connectors.js";
import type { DataCatalogRegistry } from "./data-catalog.js";
import type { ProductionService } from "./production.js";
import type { SystemConfigStore } from "./system-config.js";
import { isAiProviderToolsUnsupported, requestAiProviderCompletion, type AiProviderChatMessage } from "./ai-provider-client.js";

export type WorkspaceAgentMessageRole = "user" | "assistant" | "tool" | "system";

export interface WorkspaceAgentMessage {
  id: string;
  role: WorkspaceAgentMessageRole;
  content: string;
  createdAt: string;
  context?: Record<string, unknown>;
}

export interface PendingAgentTool {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  reason: string;
  createdAt: string;
}

export interface WorkspaceAgentSession {
  id: string;
  createdAt: string;
  updatedAt: string;
  messages: WorkspaceAgentMessage[];
  pendingTool?: PendingAgentTool;
}

interface AgentStoreState { version: 1; sessions: WorkspaceAgentSession[]; }

function now(): string { return new Date().toISOString(); }
function clone<T>(value: T): T { return structuredClone(value); }
function text(value: unknown, name: string, maximum = 2_000): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) throw new RangeError(`${name} must contain between 1 and ${maximum} characters`);
  return value.trim();
}

export interface AgentToolDescriptor {
  name: string;
  description: string;
  readOnly: boolean;
  parameters: Record<string, unknown>;
}

export const WORKSPACE_AGENT_TOOLS: readonly AgentToolDescriptor[] = [
  { name: "list_data_assets", description: "列出当前 Workspace 用户资产", readOnly: true, parameters: { type: "object", properties: {} } },
  { name: "list_connectors", description: "列出当前 Workspace Connector", readOnly: true, parameters: { type: "object", properties: {} } },
  { name: "list_production_runs", description: "列出数据生产任务", readOnly: true, parameters: { type: "object", properties: {} } },
  { name: "submit_production_run", description: "提交一个数据生产任务，需要用户确认", readOnly: false, parameters: { type: "object", required: ["pipelineKey", "region"], properties: { pipelineKey: { type: "string" }, region: { type: "object" }, files: { type: "array" }, leftAssetId: { type: "string" }, rightAssetId: { type: "string" }, matchRadiusArcsec: { type: "number" }, exportFormat: { type: "string" }, concurrency: { type: "integer" } } } },
];

interface WorkspaceAgentOptions {
  root: string;
  config: SystemConfigStore;
  dataCatalog: DataCatalogRegistry;
  connectors: ConnectorRegistry;
  production: ProductionService;
}

export class WorkspaceAgentService {
  readonly #root: string;
  readonly #statePath: string;
  readonly #config: SystemConfigStore;
  readonly #dataCatalog: DataCatalogRegistry;
  readonly #connectors: ConnectorRegistry;
  readonly #production: ProductionService;
  readonly #sessions = new Map<string, WorkspaceAgentSession>();
  #initialized = false;
  #writeChain: Promise<void> = Promise.resolve();

  constructor(options: WorkspaceAgentOptions) {
    if (!path.isAbsolute(options.root)) throw new RangeError("agent root must be absolute");
    this.#root = path.resolve(options.root);
    this.#statePath = path.join(this.#root, "workspace-agent-sessions.json");
    this.#config = options.config;
    this.#dataCatalog = options.dataCatalog;
    this.#connectors = options.connectors;
    this.#production = options.production;
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    this.#initialized = true;
    await mkdir(this.#root, { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.#statePath, "utf8")) as AgentStoreState;
      if (parsed.version === 1 && Array.isArray(parsed.sessions)) parsed.sessions.forEach((session) => { if (session?.id) this.#sessions.set(session.id, session); });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn("Ignoring invalid workspace agent state", error); }
  }

  async listSessions(): Promise<WorkspaceAgentSession[]> { await this.initialize(); return [...this.#sessions.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).map(clone); }

  async createSession(): Promise<WorkspaceAgentSession> {
    await this.initialize();
    const createdAt = now();
    const session: WorkspaceAgentSession = { id: `wag_${randomUUID()}`, createdAt, updatedAt: createdAt, messages: [{ id: randomUUID(), role: "assistant", content: "Workspace Agent 已就绪。可以查询资产、Connector、生产任务，或在确认后提交任务。", createdAt }] };
    this.#sessions.set(session.id, session); await this.#persist(); return clone(session);
  }

  async getSession(id: string): Promise<WorkspaceAgentSession> {
    await this.initialize();
    const session = this.#sessions.get(text(id, "session id", 120));
    if (!session) throw new Error(`Workspace agent session not found: ${id}`);
    return clone(session);
  }

  async sendMessage(id: string, value: unknown, context?: Record<string, unknown>): Promise<WorkspaceAgentSession> {
    const session = await this.getSession(id);
    const content = text(value, "message");
    session.messages.push({ id: randomUUID(), role: "user", content, createdAt: now(), ...(context ? { context: clone(context) } : {}) });
    const provider = await this.#config.getDefaultAiProvider();
    if (!provider) {
      session.messages.push({ id: randomUUID(), role: "assistant", content: this.ruleReply(content), createdAt: now() });
      await this.#save(session); return clone(session);
    }
    try {
      await this.#completeWithProvider(session, provider.record.baseUrl, provider.record.model, provider.apiKey);
    } catch (error) {
      session.messages.push({ id: randomUUID(), role: "assistant", content: `AI Provider 请求失败：${error instanceof Error ? error.message : String(error)}`, createdAt: now() });
    }
    await this.#save(session); return clone(session);
  }

  async confirmTool(id: string, approved: boolean): Promise<WorkspaceAgentSession> {
    const session = await this.getSession(id);
    const pending = session.pendingTool;
    if (!pending) throw new RangeError("当前会话没有待确认操作");
    delete session.pendingTool;
    if (!approved) {
      session.messages.push({ id: randomUUID(), role: "assistant", content: "已取消这项写操作。", createdAt: now() });
    } else {
      const result = await this.executeTool(pending.name, pending.arguments);
      session.messages.push({ id: randomUUID(), role: "tool", content: JSON.stringify(result), createdAt: now() });
      session.messages.push({ id: randomUUID(), role: "assistant", content: `已执行 ${pending.name}。`, createdAt: now() });
    }
    await this.#save(session); return clone(session);
  }

  private ruleReply(content: string): string {
    if (/(资产|asset)/i.test(content)) return "当前未配置 AI Provider。请先到“系统配置”注册一个 OpenAI-compatible Provider；配置后 Agent 才能调用 Workspace 工具。";
    return "当前未配置 AI Provider。请到“系统配置”注册连接；历史会话仍会保留。";
  }

  async #completeWithProvider(session: WorkspaceAgentSession, baseUrl: string, model: string, apiKey?: string): Promise<void> {
    const messages = session.messages
      .filter((message) => message.role !== "system")
      .slice(-30)
      .map((message): AiProviderChatMessage => ({
        role: message.role === "tool" ? "tool" : message.role === "assistant" ? "assistant" : "user",
        content: message.content,
      }));
    const tools = WORKSPACE_AGENT_TOOLS.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
    let completion;
    try {
      completion = await requestAiProviderCompletion({
        baseUrl,
        model,
        messages,
        ...(apiKey ? { apiKey } : {}),
        tools,
        toolChoice: "auto",
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      if (!isAiProviderToolsUnsupported(error)) throw error;
      completion = await requestAiProviderCompletion({
        baseUrl,
        model,
        messages,
        ...(apiKey ? { apiKey } : {}),
        signal: AbortSignal.timeout(60_000),
      });
    }
    const message = completion.message;
    const call = message.tool_calls?.[0];
    if (call?.function?.name) {
      const descriptor = WORKSPACE_AGENT_TOOLS.find((tool) => tool.name === call.function!.name);
      if (!descriptor) throw new Error(`Agent requested an unknown tool: ${call.function.name}`);
      let args: Record<string, unknown> = {};
      try { const parsed = JSON.parse(call.function.arguments ?? "{}"); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed; } catch { throw new Error("Agent tool arguments are not valid JSON"); }
      if (!descriptor.readOnly) {
        session.pendingTool = { id: call.id ?? randomUUID(), name: descriptor.name, arguments: args, reason: descriptor.description, createdAt: now() };
        session.messages.push({ id: randomUUID(), role: "assistant", content: `Agent 请求执行写操作：${descriptor.description}。请确认后继续。`, createdAt: now() });
        return;
      }
      const result = await this.executeTool(descriptor.name, args);
      session.messages.push({ id: randomUUID(), role: "tool", content: JSON.stringify(result), createdAt: now() });
      session.messages.push({ id: randomUUID(), role: "assistant", content: this.toolSummary(descriptor.name, result), createdAt: now() });
      return;
    }
    const reply = typeof message.content === "string" && message.content.trim() ? message.content.trim() : "Provider 没有返回可显示内容。";
    session.messages.push({ id: randomUUID(), role: "assistant", content: reply, createdAt: now() });
  }

  private async executeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (name === "list_data_assets") return (await this.#dataCatalog.list()).map((asset) => ({ id: asset.id, name: asset.name, kind: asset.kind, projectState: asset.projectState, objects: Boolean(asset.scanSpec) }));
    if (name === "list_connectors") return (await this.#connectors.list()).map((connector) => ({ id: connector.id, name: connector.name, kind: connector.kind, status: connector.status, path: connector.displayPath }));
    if (name === "list_production_runs") return (await this.#production.listRuns()).slice(0, 50).map((run) => ({ id: run.id, pipelineKey: run.pipelineKey, status: run.status, createdAt: run.createdAt, summary: run.summary }));
    if (name === "submit_production_run") return this.#production.submit(args);
    throw new Error(`Unknown agent tool: ${name}`);
  }

  private toolSummary(name: string, result: unknown): string {
    if (name === "list_data_assets") return `当前有 ${Array.isArray(result) ? result.length : 0} 个用户资产。`;
    if (name === "list_connectors") return `当前有 ${Array.isArray(result) ? result.length : 0} 个 Connector。`;
    if (name === "list_production_runs") return `当前有 ${Array.isArray(result) ? result.length : 0} 条生产任务记录。`;
    return `工具 ${name} 已完成。`;
  }

  async #save(session: WorkspaceAgentSession): Promise<void> { session.updatedAt = now(); session.messages = session.messages.slice(-100); this.#sessions.set(session.id, clone(session)); await this.#persist(); }

  async #persist(): Promise<void> {
    const state: AgentStoreState = { version: 1, sessions: [...this.#sessions.values()].slice(-100).map(clone) };
    this.#writeChain = this.#writeChain.catch(() => undefined).then(async () => { const temporary = `${this.#statePath}.${randomUUID()}.tmp`; await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }); await rename(temporary, this.#statePath); });
    return this.#writeChain;
  }
}
