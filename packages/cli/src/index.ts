#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

type JsonRecord = Record<string, unknown>;
type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
const MAX_TEXT_ARTIFACT_BYTES = 131_072;
const DEFAULT_TEXT_ARTIFACT_BYTES = 32_768;

interface ParsedArgs {
  command: string[];
  flags: Set<string>;
  options: Map<string, string>;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const command: string[] = [];
  const flags = new Set<string>();
  const options = new Map<string, string>();
  const booleanFlags = new Set(["json", "help", "h", "approved", "approve", "rejected", "reject"]);
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value) continue;
    if (!value.startsWith("-")) {
      command.push(value);
      continue;
    }
    const normalized = value.replace(/^-+/, "");
    const equals = normalized.indexOf("=");
    if (equals >= 0) {
      options.set(normalized.slice(0, equals), normalized.slice(equals + 1));
      continue;
    }
    const next = argv[index + 1];
    if (!booleanFlags.has(normalized) && next && (!next.startsWith("-") || next === "-")) {
      options.set(normalized, next);
      index += 1;
    } else {
      flags.add(normalized);
    }
  }
  return { command, flags, options };
}

function option(args: ParsedArgs, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = args.options.get(name);
    if (value !== undefined) return value;
  }
  return undefined;
}

function hasFlag(args: ParsedArgs, ...names: string[]): boolean {
  return names.some((name) => args.flags.has(name));
}

function requireCommand(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function parseJson(value: string, name: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`${name} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function readJsonInput(args: ParsedArgs): Promise<unknown> {
  const inline = option(args, "data", "body", "json-input");
  if (inline !== undefined) return parseJson(inline, "--data");
  const filename = option(args, "input", "file");
  if (!filename) throw new Error("--input <json-file|-> or --data '<json>' is required");
  if (filename === "-") {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return parseJson(Buffer.concat(chunks).toString("utf8"), "stdin");
  }
  const resolved = path.resolve(filename);
  return parseJson(await readFile(resolved, "utf8"), resolved);
}

class WorkspaceClient {
  readonly #baseUrl: string;
  readonly #json: boolean;

  constructor(baseUrl: string, json: boolean) {
    this.#baseUrl = baseUrl.replace(/\/+$/, "");
    this.#json = json;
  }

  get json(): boolean { return this.#json; }

  async request<T = unknown>(method: HttpMethod, endpoint: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.#baseUrl}${endpoint}`, {
      method,
      headers: {
        Accept: "application/json",
        ...agentInvocationHeaders(),
        ...traceHeaders(),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const contentType = response.headers.get("content-type") ?? "";
    const payload: unknown = contentType.includes("json")
      ? await response.json().catch(() => ({}))
      : await response.text();
    if (!response.ok) {
      const message = payload && typeof payload === "object" && typeof (payload as JsonRecord).error === "string"
        ? (payload as JsonRecord).error as string
        : `${response.status} ${response.statusText}`;
      throw new Error(message);
    }
    return payload as T;
  }

  async api(args: ParsedArgs): Promise<unknown> {
    const method = (option(args, "method", "request-method") ?? "GET").toUpperCase();
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) throw new Error("api method must be GET, POST, PUT, PATCH, or DELETE");
    const endpoint = requireCommand(option(args, "path", "endpoint"), "api path");
    if (!endpoint.startsWith("/api/") || endpoint.startsWith("//") || endpoint.includes("\\") || endpoint.includes("\u0000")) {
      throw new Error("api path must be a Workspace /api/... path");
    }
    const target = new URL(endpoint, `${this.#baseUrl}/`);
    if (target.origin !== new URL(this.#baseUrl).origin || !target.pathname.startsWith("/api/")) throw new Error("api path escaped the Workspace API");
    const contentType = option(args, "content-type") ?? "application/json";
    const inline = option(args, "data", "body", "json-input");
    const filename = option(args, "input", "file");
    let body: BodyInit | undefined;
    if (inline !== undefined) {
      const parsed = parseJson(inline, "--data");
      body = JSON.stringify(parsed);
    } else if (filename === "-") {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      body = Buffer.concat(chunks);
    } else if (filename) {
      body = await readFile(path.resolve(filename));
    }
    const response = await fetch(target, {
      method,
      headers: {
        Accept: "application/json, application/octet-stream, text/plain",
        ...agentInvocationHeaders(),
        ...traceHeaders(),
        ...(body === undefined ? {} : { "Content-Type": contentType }),
      },
      ...(body === undefined ? {} : { body }),
    });
    const output = option(args, "output", "out");
    if (output && response.ok) {
      return this.saveOutput(response, output);
    }
    const responseType = response.headers.get("content-type") ?? "";
    const payload: unknown = responseType.includes("json")
      ? await response.json().catch(() => ({}))
      : await response.text();
    if (!response.ok) {
      const message = payload && typeof payload === "object" && typeof (payload as JsonRecord).error === "string"
        ? (payload as JsonRecord).error as string
        : `${response.status} ${response.statusText}`;
      throw new Error(message);
    }
    return payload;
  }

  async download(endpoint: string, output: string): Promise<unknown> {
    const target = new URL(endpoint, `${this.#baseUrl}/`);
    if (target.origin !== new URL(this.#baseUrl).origin || !target.pathname.startsWith("/api/")) {
      throw new Error("download path escaped the Workspace API");
    }
    const response = await fetch(target, {
      headers: {
        Accept: "application/octet-stream, application/fits, text/csv, application/json",
        ...agentInvocationHeaders(),
        ...traceHeaders(),
      },
    });
    if (!response.ok) {
      const contentType = response.headers.get("content-type") ?? "";
      const payload: unknown = contentType.includes("json")
        ? await response.json().catch(() => ({}))
        : await response.text();
      const message = payload && typeof payload === "object" && typeof (payload as JsonRecord).error === "string"
        ? (payload as JsonRecord).error as string
        : `${response.status} ${response.statusText}`;
      throw new Error(message);
    }
    return this.saveOutput(response, output);
  }

  async readText(endpoint: string, maximumBytes: number): Promise<unknown> {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > MAX_TEXT_ARTIFACT_BYTES) {
      throw new RangeError(`maximum text artifact size must be between 1 and ${MAX_TEXT_ARTIFACT_BYTES} bytes`);
    }
    const target = new URL(endpoint, `${this.#baseUrl}/`);
    if (target.origin !== new URL(this.#baseUrl).origin || !target.pathname.startsWith("/api/")) {
      throw new Error("artifact path escaped the Workspace API");
    }
    const response = await fetch(target, {
      headers: {
        Accept: "application/json, text/*",
        ...agentInvocationHeaders(),
        ...traceHeaders(),
      },
    });
    const contentType = response.headers.get("content-type") ?? "";
    if (!response.ok) {
      const payload: unknown = contentType.includes("json")
        ? await response.json().catch(() => ({}))
        : await response.text();
      const message = payload && typeof payload === "object" && typeof (payload as JsonRecord).error === "string"
        ? (payload as JsonRecord).error as string
        : `${response.status} ${response.statusText}`;
      throw new Error(message);
    }
    const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    if (!mediaType.startsWith("text/") && mediaType !== "application/json" && !mediaType.endsWith("+json")) {
      throw new Error(`artifact is not text or JSON: ${mediaType || "unknown content type"}`);
    }
    const reader = response.body?.getReader();
    if (!reader) return { status: response.status, contentType, byteLength: 0, truncated: false, text: "" };
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    let truncated = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      const available = maximumBytes + 1 - byteLength;
      if (value.byteLength > available) {
        chunks.push(value.subarray(0, available));
        byteLength += available;
        truncated = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
      chunks.push(value);
      byteLength += value.byteLength;
      if (byteLength > maximumBytes) {
        truncated = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
    const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).subarray(0, maximumBytes);
    return {
      status: response.status,
      contentType,
      byteLength: bytes.byteLength,
      truncated,
      text: new TextDecoder().decode(bytes),
    };
  }

  private async saveOutput(response: Response, output: string): Promise<unknown> {
    const bytes = Buffer.from(await response.arrayBuffer());
    const resolved = path.resolve(output);
    await writeFile(resolved, bytes, { flag: "wx" });
    return { status: response.status, output: resolved, byteLength: bytes.length, contentType: response.headers.get("content-type") };
  }
}

function traceHeaders(): Record<string, string> {
  const traceparent = process.env.TRACEPARENT;
  if (!traceparent || !/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/i.test(traceparent)) return {};
  const tracestate = process.env.TRACESTATE;
  return {
    traceparent,
    ...(tracestate && tracestate.length <= 512 && !/[\r\n]/.test(tracestate) ? { tracestate } : {}),
  };
}

function agentInvocationHeaders(): Record<string, string> {
  return process.env.ASA_WORKSPACE_AGENT_INVOCATION === "1"
    ? { "X-ASA-Agent-Invocation": "true" }
    : {};
}

function unwrap(payload: unknown, key: string): unknown {
  return payload && typeof payload === "object" && key in payload ? (payload as JsonRecord)[key] : payload;
}

function textValue(value: unknown): string {
  if (value === null || value === undefined) return "--";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function print(client: WorkspaceClient, value: unknown): void {
  if (client.json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  if (Array.isArray(value)) {
    if (!value.length) {
      process.stdout.write("暂无记录\n");
      return;
    }
    for (const entry of value) {
      if (entry && typeof entry === "object") {
        const record = entry as JsonRecord;
        const title = record.name ?? record.title ?? record.id ?? record.key ?? "record";
        const detail = record.status ?? record.description ?? record.url ?? record.baseUrl;
        process.stdout.write(`${textValue(title)}${detail === undefined ? "" : ` · ${textValue(detail)}`}\n`);
      } else {
        process.stdout.write(`${textValue(entry)}\n`);
      }
    }
    return;
  }
  if (value && typeof value === "object") {
    const record = value as JsonRecord;
    for (const [key, entry] of Object.entries(record)) process.stdout.write(`${key}: ${textValue(entry)}\n`);
    return;
  }
  process.stdout.write(`${textValue(value)}\n`);
}

function usage(): string {
  return [
    "astro-workspace [--base-url URL] [--json] <assets|connectors|workflows|production|system|agent|api> ...",
    "",
    "  assets list|get ID",
    "  connectors list|get ID|check ID|scan ID|objects ID [--prefix PREFIX] [--continuation-token TOKEN]",
    "  production pipelines|list|get ID|submit --input run.json|cancel ID|retry ID|approve ID --sha256 HASH|reject ID",
    "  workflows list|get WORKFLOW_KEY|runs [--limit N] [--workflow-key KEY]|run WORKFLOW_KEY (--input FILE|-|--data JSON)|run-get RUN_ID|decide RUN_ID (--input FILE|-|--data JSON)|cutouts RUN_ID [--output ZIP]|artifact RUN_ID NAME --output FILE|artifact-read RUN_ID NAME [--max-bytes N]",
    "  system ai list|test ID; system mcp list|test ID; system runtime",
    "  agent sessions|new|send ID MESSAGE|confirm ID --approved|--rejected",
    "  api --method GET|POST|PUT|PATCH|DELETE --path /api/... [--data JSON|--input FILE|--input -] [--output FILE]",
    "  api accepts any Workspace /api/... route; use --input - to keep large or secret request bodies out of process arguments.",
  ].join("\n");
}

async function run(client: WorkspaceClient, args: ParsedArgs): Promise<unknown> {
  const [domain, action, identifier, ...rest] = args.command;
  if (!domain || domain === "help" || hasFlag(args, "help", "h")) {
    process.stdout.write(`${usage()}\n`);
    return undefined;
  }
  if (domain === "api") return client.api(args);
  if (domain === "assets") {
    if (!action || action === "list") return unwrap(await client.request("GET", "/api/data-assets"), "assets");
    if (action === "get") return unwrap(await client.request("GET", `/api/data-assets/${encodeURIComponent(requireCommand(identifier, "asset id"))}`), "asset");
  }
  if (domain === "connectors") {
    if (!action || action === "list") return unwrap(await client.request("GET", "/api/connectors"), "connectors");
    const id = encodeURIComponent(requireCommand(identifier, "connector id"));
    if (action === "get") return unwrap(await client.request("GET", `/api/connectors/${id}`), "connector");
    if (action === "check") return client.request("POST", `/api/connectors/${id}/check`, {});
    if (action === "scan") return unwrap(await client.request("POST", `/api/connectors/${id}/scan-runs`, {}), "run");
    if (action === "objects") {
      const query = new URLSearchParams();
      const prefix = option(args, "prefix");
      const continuationToken = option(args, "continuation-token", "cursor");
      if (prefix !== undefined) query.set("prefix", prefix);
      if (continuationToken !== undefined) query.set("continuationToken", continuationToken);
      const suffix = query.toString();
      return client.request("GET", `/api/connectors/${id}/objects${suffix ? `?${suffix}` : ""}`);
    }
  }
  if (domain === "workflow" || domain === "workflows") {
    if (!action || action === "list") return unwrap(await client.request("GET", "/api/workflows"), "workflows");
    if (action === "get") return unwrap(await client.request("GET", `/api/workflows/${encodeURIComponent(requireCommand(identifier, "workflow key"))}`), "workflow");
    if (action === "runs") {
      const rawLimit = option(args, "limit");
      const limit = rawLimit === undefined ? 20 : Number(rawLimit);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RangeError("workflow run limit must be an integer between 1 and 100");
      const query = new URLSearchParams({ limit: String(limit) });
      const workflowKey = option(args, "workflow-key", "workflow");
      if (workflowKey) query.set("workflowKey", workflowKey);
      return unwrap(await client.request("GET", `/api/workflow-runs?${query}`), "runs");
    }
    if (action === "run") {
      const workflowKey = requireCommand(identifier, "workflow key");
      return unwrap(await client.request("POST", "/api/workflow-runs", { workflowId: workflowKey, input: await readJsonInput(args) }), "run");
    }
    if (action === "run-get") return unwrap(await client.request("GET", `/api/workflow-runs/${encodeURIComponent(requireCommand(identifier, "workflow run id"))}`), "run");
    if (action === "decide") {
      const runId = encodeURIComponent(requireCommand(identifier, "workflow run id"));
      return unwrap(await client.request("POST", `/api/workflow-runs/${runId}/decisions`, await readJsonInput(args)), "run");
    }
    if (action === "cutouts") {
      const runId = encodeURIComponent(requireCommand(identifier, "workflow run id"));
      const output = option(args, "output", "o");
      return output?.trim() ? client.download(`/api/workflow-runs/${runId}/cutouts.zip`, output.trim())
        : client.request("GET", `/api/workflow-runs/${runId}/cutouts`);
    }
    if (action === "artifact") {
      const runId = encodeURIComponent(requireCommand(identifier, "workflow run id"));
      const name = encodeURIComponent(requireCommand(rest[0], "artifact name"));
      const output = option(args, "output", "out");
      if (!output?.trim()) throw new Error("workflow artifact requires --output <file>");
      return client.download(`/api/workflow-runs/${runId}/artifacts/${name}`, output.trim());
    }
    if (action === "artifact-read") {
      const runId = encodeURIComponent(requireCommand(identifier, "workflow run id"));
      const name = encodeURIComponent(requireCommand(rest[0], "artifact name"));
      const requested = option(args, "max-bytes");
      const maximumBytes = requested === undefined ? DEFAULT_TEXT_ARTIFACT_BYTES : Number(requested);
      return client.readText(`/api/workflow-runs/${runId}/artifacts/${name}`, maximumBytes);
    }
  }
  if (domain === "production") {
    if (action === "pipelines") return unwrap(await client.request("GET", "/api/production-pipelines"), "pipelines");
    if (!action || action === "list") return unwrap(await client.request("GET", "/api/production-runs"), "runs");
    if (action === "submit") return unwrap(await client.request("POST", "/api/production-runs", await readJsonInput(args)), "run");
    const id = encodeURIComponent(requireCommand(identifier, "production run id"));
    if (action === "get") return unwrap(await client.request("GET", `/api/production-runs/${id}`), "run");
    if (action === "cancel") return unwrap(await client.request("POST", `/api/production-runs/${id}/cancel`, {}), "run");
    if (action === "retry") return unwrap(await client.request("POST", `/api/production-runs/${id}/retry`, {}), "run");
    if (action === "approve") {
      const sha256 = option(args, "sha256", "plan-sha256");
      if (!sha256?.trim()) throw new Error("production approve requires --sha256 <plan-sha256>");
      return unwrap(await client.request("POST", `/api/production-runs/${id}/approve`, { planSha256: sha256.trim() }), "run");
    }
    if (action === "reject") return unwrap(await client.request("POST", `/api/production-runs/${id}/reject`, {}), "run");
  }
  if (domain === "system") {
    if (action === "runtime") return client.request("GET", "/api/system-config/runtime");
    if (action === "ai" && (!identifier || identifier === "list")) return unwrap(await client.request("GET", "/api/system-config/ai-providers"), "providers");
    if (action === "mcp" && (!identifier || identifier === "list")) return unwrap(await client.request("GET", "/api/system-config/mcp-servers"), "servers");
    if (action === "ai" && identifier === "test") return unwrap(await client.request("POST", `/api/system-config/ai-providers/${encodeURIComponent(requireCommand(rest[0], "provider id"))}/test`, {}), "provider");
    if (action === "mcp" && identifier === "test") return unwrap(await client.request("POST", `/api/system-config/mcp-servers/${encodeURIComponent(requireCommand(rest[0], "server id"))}/test`, {}), "server");
  }
  if (domain === "agent") {
    if (!action || action === "sessions") return unwrap(await client.request("GET", "/api/agent/workspace-sessions"), "sessions");
    if (action === "new") return unwrap(await client.request("POST", "/api/agent/workspace-sessions", {}), "session");
    if (action === "send") {
      const id = encodeURIComponent(requireCommand(identifier, "agent session id"));
      const message = rest.join(" ").trim();
      if (!message) throw new Error("agent message is required");
      return unwrap(await client.request("POST", `/api/agent/workspace-sessions/${id}/messages`, { message }), "session");
    }
    if (action === "confirm") {
      const id = encodeURIComponent(requireCommand(identifier, "agent session id"));
      const approved = hasFlag(args, "approved", "approve") ? true : hasFlag(args, "rejected", "reject") ? false : undefined;
      if (approved === undefined) throw new Error("agent confirm requires --approved or --rejected");
      return unwrap(await client.request("POST", `/api/agent/workspace-sessions/${id}/confirm`, { approved }), "session");
    }
  }
  throw new Error(`unknown command: ${args.command.join(" ")}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = option(args, "base-url", "url") ?? process.env.ASTRO_WORKSPACE_URL ?? "http://127.0.0.1:3000";
  const client = new WorkspaceClient(baseUrl, hasFlag(args, "json"));
  const result = await run(client, args);
  if (result !== undefined) print(client, result);
}

main().catch((error: unknown) => {
  process.stderr.write(`astro-workspace: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
