#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

type JsonRecord = Record<string, unknown>;
type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

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
    if (!booleanFlags.has(normalized) && next && !next.startsWith("-")) {
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
  if (!filename) throw new Error("production submit requires --input <json-file> or --data '<json>'");
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
    "astro-workspace [--base-url URL] [--json] <assets|connectors|production|system|agent> ...",
    "",
    "  assets list|get ID",
    "  connectors list|get ID|check ID|scan ID",
    "  production pipelines|list|get ID|submit --input run.json|cancel ID|retry ID",
    "  system ai list|test ID; system mcp list|test ID",
    "  agent sessions|new|send ID MESSAGE|confirm ID --approved|--rejected",
  ].join("\n");
}

async function run(client: WorkspaceClient, args: ParsedArgs): Promise<unknown> {
  const [domain, action, identifier, ...rest] = args.command;
  if (!domain || domain === "help" || hasFlag(args, "help", "h")) {
    process.stdout.write(`${usage()}\n`);
    return undefined;
  }
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
  }
  if (domain === "production") {
    if (action === "pipelines") return unwrap(await client.request("GET", "/api/production-pipelines"), "pipelines");
    if (!action || action === "list") return unwrap(await client.request("GET", "/api/production-runs"), "runs");
    if (action === "submit") return unwrap(await client.request("POST", "/api/production-runs", await readJsonInput(args)), "run");
    const id = encodeURIComponent(requireCommand(identifier, "production run id"));
    if (action === "get") return unwrap(await client.request("GET", `/api/production-runs/${id}`), "run");
    if (action === "cancel") return unwrap(await client.request("POST", `/api/production-runs/${id}/cancel`, {}), "run");
    if (action === "retry") return unwrap(await client.request("POST", `/api/production-runs/${id}/retry`, {}), "run");
  }
  if (domain === "system") {
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
