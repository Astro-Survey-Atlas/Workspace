import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export type AiProviderCheckStatus = "unknown" | "ok" | "failed";
export type McpTransport = "streamable-http" | "sse";

export interface AiProviderRecord {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  enabled: boolean;
  isDefault: boolean;
  apiKeyConfigured: boolean;
  lastCheck?: { status: AiProviderCheckStatus; detail: string; checkedAt: string; toolCalling?: boolean };
  createdAt: string;
  updatedAt: string;
}

export interface AiProviderInput {
  id?: string;
  name: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  enabled?: boolean;
  isDefault?: boolean;
}

export interface McpToolSummary {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  readOnly: boolean;
}

export interface McpServerRecord {
  id: string;
  name: string;
  url: string;
  transport: McpTransport;
  enabled: boolean;
  tokenConfigured: boolean;
  tools: McpToolSummary[];
  lastCheck?: { status: AiProviderCheckStatus; detail: string; checkedAt: string };
  createdAt: string;
  updatedAt: string;
}

export interface McpServerInput {
  id?: string;
  name: string;
  url: string;
  transport?: McpTransport;
  token?: string;
  enabled?: boolean;
}

interface PersistedConfig {
  version: 1;
  ai: Array<Omit<AiProviderRecord, "apiKeyConfigured"> & { apiKeyRef?: string }>;
  mcp: Array<Omit<McpServerRecord, "tokenConfigured"> & { tokenRef?: string }>;
}

interface SecretState {
  version: 1;
  values: Record<string, string>;
}

function now(): string { return new Date().toISOString(); }
function clone<T>(value: T): T { return structuredClone(value); }

function requiredText(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) throw new RangeError(`${name} must be a non-empty string`);
  return value.trim();
}

function validHttpUrl(value: unknown, name: string): string {
  const textValue = requiredText(value, name, 2_048);
  let url: URL;
  try { url = new URL(textValue); } catch { throw new RangeError(`${name} must be an HTTP(S) URL`); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new RangeError(`${name} must be an HTTP(S) URL`);
  return url.href.replace(/\/$/, "");
}

function publicAi(record: PersistedConfig["ai"][number], secrets: SecretState): AiProviderRecord {
  const { apiKeyRef: _apiKeyRef, ...safe } = record;
  return { ...safe, apiKeyConfigured: Boolean(record.apiKeyRef && secrets.values[record.apiKeyRef]) };
}

function publicMcp(record: PersistedConfig["mcp"][number], secrets: SecretState): McpServerRecord {
  const { tokenRef: _tokenRef, ...safe } = record;
  return { ...safe, tokenConfigured: Boolean(record.tokenRef && secrets.values[record.tokenRef]) };
}

function configDefaults(): PersistedConfig { return { version: 1, ai: [], mcp: [] }; }
function secretDefaults(): SecretState { return { version: 1, values: {} }; }

export class SystemConfigStore {
  readonly #root: string;
  readonly #configPath: string;
  readonly #secretPath: string;
  #config: PersistedConfig = configDefaults();
  #secrets: SecretState = secretDefaults();
  #initialized = false;
  #writeChain: Promise<void> = Promise.resolve();

  constructor(root: string) {
    if (!path.isAbsolute(root)) throw new RangeError("system config root must be absolute");
    this.#root = path.resolve(root);
    this.#configPath = path.join(this.#root, "system-config.json");
    this.#secretPath = path.join(this.#root, "system-secrets.json");
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    this.#initialized = true;
    await mkdir(this.#root, { recursive: true });
    try {
      const value = JSON.parse(await readFile(this.#configPath, "utf8")) as PersistedConfig;
      if (value.version === 1 && Array.isArray(value.ai) && Array.isArray(value.mcp)) this.#config = value;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn("Ignoring invalid system configuration", error); }
    try {
      const value = JSON.parse(await readFile(this.#secretPath, "utf8")) as SecretState;
      if (value.version === 1 && value.values && typeof value.values === "object") this.#secrets = value;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn("Ignoring invalid system secrets", error); }
  }

  async listAiProviders(): Promise<AiProviderRecord[]> { await this.initialize(); return this.#config.ai.map((record) => publicAi(record, this.#secrets)); }
  async listMcpServers(): Promise<McpServerRecord[]> { await this.initialize(); return this.#config.mcp.map((record) => publicMcp(record, this.#secrets)); }

  async getDefaultAiProvider(): Promise<{ record: AiProviderRecord; apiKey?: string } | undefined> {
    await this.initialize();
    const record = this.#config.ai.find((candidate) => candidate.enabled && candidate.isDefault);
    if (!record) return undefined;
    return { record: publicAi(record, this.#secrets), ...(record.apiKeyRef && this.#secrets.values[record.apiKeyRef] ? { apiKey: this.#secrets.values[record.apiKeyRef] } : {}) };
  }

  async upsertAiProvider(value: AiProviderInput): Promise<AiProviderRecord> {
    await this.initialize();
    const name = requiredText(value.name, "name", 120);
    const baseUrl = validHttpUrl(value.baseUrl, "baseUrl");
    const model = requiredText(value.model, "model", 180);
    const id = value.id ? requiredText(value.id, "id", 120) : `aip_${randomUUID()}`;
    const current = this.#config.ai.find((candidate) => candidate.id === id);
    const apiKey = value.apiKey?.trim();
    const apiKeyRef = current?.apiKeyRef ?? `ai_${id}`;
    if (apiKey) this.#secrets.values[apiKeyRef] = apiKey;
    const record = {
      id, name, baseUrl, model,
      enabled: value.enabled ?? current?.enabled ?? true,
      isDefault: value.isDefault ?? current?.isDefault ?? this.#config.ai.length === 0,
      ...(current?.lastCheck ? { lastCheck: current.lastCheck } : {}),
      ...(this.#secrets.values[apiKeyRef] ? { apiKeyRef } : {}),
      createdAt: current?.createdAt ?? now(), updatedAt: now(),
    } satisfies PersistedConfig["ai"][number];
    if (record.isDefault) this.#config.ai = this.#config.ai.map((candidate) => ({ ...candidate, isDefault: false }));
    this.#config.ai = [...this.#config.ai.filter((candidate) => candidate.id !== id), record];
    await this.#persist();
    return publicAi(record, this.#secrets);
  }

  async removeAiProvider(idValue: string): Promise<void> {
    await this.initialize();
    const id = requiredText(idValue, "id", 120);
    const current = this.#config.ai.find((candidate) => candidate.id === id);
    if (!current) return;
    this.#config.ai = this.#config.ai.filter((candidate) => candidate.id !== id);
    if (current.apiKeyRef) delete this.#secrets.values[current.apiKeyRef];
    if (current.isDefault && this.#config.ai[0]) this.#config.ai[0] = { ...this.#config.ai[0], isDefault: true };
    await this.#persist();
  }

  async testAiProvider(value: AiProviderInput | string): Promise<AiProviderRecord> {
    await this.initialize();
    const candidate = typeof value === "string" ? this.#config.ai.find((record) => record.id === value) : undefined;
    if (typeof value === "string" && !candidate) throw new Error(`AI Provider not found: ${value}`);
    const record = candidate ?? await this.upsertAiProvider(value as AiProviderInput);
    const persisted = this.#config.ai.find((entry) => entry.id === record.id)!;
    const apiKey = persisted.apiKeyRef ? this.#secrets.values[persisted.apiKeyRef] : undefined;
    const checkedAt = now();
    try {
      const response = await fetch(`${persisted.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({ model: persisted.model, messages: [{ role: "user", content: "Reply with OK" }], max_tokens: 4 }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}`);
      persisted.lastCheck = { status: "ok", detail: "Chat completion endpoint is reachable", checkedAt, toolCalling: true };
    } catch (error) {
      persisted.lastCheck = { status: "failed", detail: error instanceof Error ? error.message.slice(0, 500) : String(error), checkedAt };
    }
    persisted.updatedAt = now();
    await this.#persist();
    return publicAi(persisted, this.#secrets);
  }

  async upsertMcpServer(value: McpServerInput): Promise<McpServerRecord> {
    await this.initialize();
    const name = requiredText(value.name, "name", 120);
    const url = validHttpUrl(value.url, "url");
    const transport = value.transport ?? (url.endsWith("/sse") ? "sse" : "streamable-http");
    if (transport !== "streamable-http" && transport !== "sse") throw new RangeError("transport is not supported");
    const id = value.id ? requiredText(value.id, "id", 120) : `mcp_${randomUUID()}`;
    const current = this.#config.mcp.find((candidate) => candidate.id === id);
    const tokenRef = current?.tokenRef ?? `mcp_${id}`;
    if (value.token?.trim()) this.#secrets.values[tokenRef] = value.token.trim();
    const record = {
      id, name, url, transport,
      enabled: value.enabled ?? current?.enabled ?? true,
      tools: current?.tools ?? [],
      ...(current?.lastCheck ? { lastCheck: current.lastCheck } : {}),
      ...(this.#secrets.values[tokenRef] ? { tokenRef } : {}),
      createdAt: current?.createdAt ?? now(), updatedAt: now(),
    } satisfies PersistedConfig["mcp"][number];
    this.#config.mcp = [...this.#config.mcp.filter((candidate) => candidate.id !== id), record];
    await this.#persist();
    return publicMcp(record, this.#secrets);
  }

  async removeMcpServer(idValue: string): Promise<void> {
    await this.initialize();
    const id = requiredText(idValue, "id", 120);
    const current = this.#config.mcp.find((candidate) => candidate.id === id);
    this.#config.mcp = this.#config.mcp.filter((candidate) => candidate.id !== id);
    if (current?.tokenRef) delete this.#secrets.values[current.tokenRef];
    await this.#persist();
  }

  async testMcpServer(idValue: string): Promise<McpServerRecord> {
    await this.initialize();
    const id = requiredText(idValue, "id", 120);
    const record = this.#config.mcp.find((candidate) => candidate.id === id);
    if (!record) throw new Error(`MCP Server not found: ${id}`);
    const checkedAt = now();
    const token = record.tokenRef ? this.#secrets.values[record.tokenRef] : undefined;
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
    try {
      const client = new Client({ name: "astro-data-workspace", version: "0.10.38" });
      const endpoint = new URL(record.url);
      const requestInit = { headers, signal: AbortSignal.timeout(15_000) };
      const transports = record.transport === "sse"
        ? [new SSEClientTransport(endpoint, { requestInit }), new StreamableHTTPClientTransport(endpoint, { requestInit })]
        : [new StreamableHTTPClientTransport(endpoint, { requestInit }), new SSEClientTransport(endpoint, { requestInit })];
      let connected = false;
      let lastError: unknown;
      for (const transport of transports) {
        try { await client.connect(transport); connected = true; break; } catch (error) { lastError = error; }
      }
      if (!connected) throw lastError instanceof Error ? lastError : new Error("Unable to connect to MCP server");
      const listed = await client.listTools();
      record.tools = (listed.tools ?? []).map((tool) => ({
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        ...(tool.inputSchema && typeof tool.inputSchema === "object" ? { inputSchema: tool.inputSchema as Record<string, unknown> } : {}),
        readOnly: Boolean((tool as unknown as { annotations?: { readOnlyHint?: boolean } }).annotations?.readOnlyHint),
      }));
      record.lastCheck = { status: "ok", detail: `发现 ${record.tools.length} 个工具`, checkedAt };
      await client.close().catch(() => undefined);
    } catch (error) {
      record.lastCheck = { status: "failed", detail: error instanceof Error ? error.message.slice(0, 500) : String(error), checkedAt };
    }
    record.updatedAt = now();
    await this.#persist();
    return publicMcp(record, this.#secrets);
  }

  async #persist(): Promise<void> {
    const config = clone(this.#config);
    const secrets = clone(this.#secrets);
    this.#writeChain = this.#writeChain.catch(() => undefined).then(async () => {
      await mkdir(this.#root, { recursive: true });
      const configTemp = `${this.#configPath}.${randomUUID()}.tmp`;
      const secretTemp = `${this.#secretPath}.${randomUUID()}.tmp`;
      await writeFile(configTemp, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await writeFile(secretTemp, `${JSON.stringify(secrets, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(configTemp, this.#configPath);
      await rename(secretTemp, this.#secretPath);
    });
    return this.#writeChain;
  }
}
