import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SpanKind } from "@opentelemetry/api";
import { activeMcpMetadata, classifyError, injectActiveTrace, recordMcpCall, withSpan } from "./telemetry.js";

export interface CatalogQueryClient {
  query(request: Record<string, unknown>, context?: CatalogQueryContext): Promise<unknown>;
}

export interface CatalogQueryContext {
  catalog: string;
  raDeg: number;
  decDeg: number;
  radiusArcsec: number;
  limit: number;
  fields?: Record<string, string>;
}

export interface CatalogQueryBackend {
  provider: "workspace-mcp" | "catalog-mcp" | "esa-tap" | "noirlab-datalab";
  release: string;
  table: string;
  tool?: string;
}

function parseToolResult(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const candidate = result as { structuredContent?: unknown; content?: Array<{ type?: string; text?: string }> };
  if (candidate.structuredContent && typeof candidate.structuredContent === "object") {
    const structured = candidate.structuredContent as Record<string, unknown>;
    if (typeof structured.result === "string") {
      try {
        const parsed: unknown = JSON.parse(structured.result);
        assertCatalogMcpSuccess(parsed);
        return parsed;
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("Catalog MCP remote error")) throw error;
        return structured;
      }
    }
    assertCatalogMcpSuccess(structured);
    return structured;
  }
  const text = candidate.content?.find((part) => part.type === "text" && typeof part.text === "string")?.text;
  if (!text) return result;
  try {
    const parsed: unknown = JSON.parse(text);
    assertCatalogMcpSuccess(parsed);
    return parsed;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Catalog MCP remote error")) throw error;
    return text;
  }
}

export function assertCatalogMcpSuccess(value: unknown): void {
  if (!value || typeof value !== "object") return;
  const error = (value as Record<string, unknown>).error;
  if (!error) return;
  if (typeof error === "string") throw new Error(`Catalog MCP remote error: ${error}`);
  if (typeof error === "object") {
    const detail = error as Record<string, unknown>;
    const code = detail.code ? `[${String(detail.code)}] ` : "";
    throw new Error(`Catalog MCP remote error: ${code}${String(detail.message ?? JSON.stringify(error))}`);
  }
  throw new Error(`Catalog MCP remote error: ${String(error)}`);
}

function timeoutError(timeoutMs: number): Error {
  return new Error(`Catalog MCP request timed out after ${timeoutMs} ms`);
}

export class McpCatalogQueryClient implements CatalogQueryClient {
  constructor(
    readonly url: string,
    readonly timeoutMs = 15_000,
    readonly maxRetries = 1,
  ) {}

  async query(request: Record<string, unknown>): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        return await this.callOnce(request);
      } catch (error) {
        lastError = error;
        if (attempt < this.maxRetries) await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
      }
    }
    throw new Error(`Catalog MCP failed after ${this.maxRetries + 1} attempt(s): ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }

  private async callOnce(request: Record<string, unknown>): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(timeoutError(this.timeoutMs)), this.timeoutMs);
    const endpoint = new URL(this.url);
    const client = new Client({ name: "asa-workspace", version: "0.6.0" });
    const started = performance.now();
    let errorType: string | undefined;
    const transports = endpoint.pathname.endsWith("/sse")
      ? [new SSEClientTransport(endpoint, { requestInit: { signal: controller.signal }, fetch: tracedFetch }), new StreamableHTTPClientTransport(endpoint, { requestInit: { signal: controller.signal }, fetch: tracedFetch })]
      : [new StreamableHTTPClientTransport(endpoint, { requestInit: { signal: controller.signal }, fetch: tracedFetch }), new SSEClientTransport(endpoint, { requestInit: { signal: controller.signal }, fetch: tracedFetch })];
    let connected = false;
    let connectionError: unknown;
    try {
      return await withSpan("tools/call es_query", {
        "asa.component": "mcp-client",
        "asa.mcp.server": "astro-catalog",
        "gen_ai.tool.name": "es_query",
        "mcp.method.name": "tools/call",
        "network.protocol.name": "http",
        "server.address": endpoint.hostname,
        ...(endpoint.port ? { "server.port": Number(endpoint.port) } : {}),
      }, async () => {
        for (const transport of transports) {
          try {
            await client.connect(transport);
            connected = true;
            break;
          } catch (error) {
            connectionError = error;
            if (controller.signal.aborted) throw timeoutError(this.timeoutMs);
          }
        }
        if (!connected) throw new Error(`Unable to connect: ${connectionError instanceof Error ? connectionError.message : String(connectionError)}`);
        const result = await client.callTool({
          name: "es_query",
          arguments: request,
          _meta: activeMcpMetadata(),
        }, undefined, { signal: controller.signal });
        return parseToolResult(result);
      }, { kind: SpanKind.CLIENT });
    } catch (error) {
      errorType = classifyError(error);
      if (controller.signal.aborted) throw timeoutError(this.timeoutMs);
      throw error;
    } finally {
      clearTimeout(timer);
      recordMcpCall("astro-catalog", (performance.now() - started) / 1000, "es_query", errorType);
      await client.close().catch(() => undefined);
    }
  }
}

async function tracedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
  const traceCarrier: Record<string, string> = {};
  injectActiveTrace(traceCarrier);
  for (const [key, value] of Object.entries(traceCarrier)) headers.set(key, value);
  return fetch(input, { ...init, headers });
}
