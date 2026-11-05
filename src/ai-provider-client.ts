import { SpanKind } from "@opentelemetry/api";
import { classifyError, recordAiUsage, withSpan } from "./telemetry.js";

export interface AiProviderChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: AiProviderToolCall[];
}

export interface AiProviderToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

export interface AiProviderResponseMessage {
  content?: unknown;
  tool_calls?: AiProviderToolCall[];
}

export interface AiProviderCompletionPayload {
  id?: string;
  model?: string;
  choices?: Array<{ message?: AiProviderResponseMessage; finish_reason?: string | null }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
  error?: unknown;
}

export interface AiProviderCompletionOptions {
  baseUrl: string;
  model: string;
  messages: readonly AiProviderChatMessage[];
  apiKey?: string;
  tools?: readonly unknown[];
  toolChoice?: unknown;
  attempt?: number;
  fallback?: "no_tools";
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export interface AiProviderCompletionResult {
  endpoint: string;
  message: AiProviderResponseMessage;
  payload: AiProviderCompletionPayload;
}

export interface AiProviderRequestErrorOptions {
  endpoint: string;
  status?: number;
  contentType?: string;
  cause?: unknown;
}

export class AiProviderRequestError extends Error {
  readonly endpoint: string;
  readonly status?: number;
  readonly contentType?: string;

  constructor(message: string, options: AiProviderRequestErrorOptions) {
    super(message, { cause: options.cause });
    this.name = "AiProviderRequestError";
    this.endpoint = options.endpoint;
    this.status = options.status;
    this.contentType = options.contentType;
  }
}

function safeEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "<invalid endpoint>";
  }
}

function safeSnippet(value: string, maximum = 240): string {
  return value
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer <REDACTED>")
    .replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*([^,;\s}]+)/gi, "$1=<REDACTED>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
}

function responseSummary(body: string, contentType: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "empty response";
  if (/html/i.test(contentType) || /^<!doctype\s+html/i.test(trimmed)) return "HTML document returned instead of an API response";
  try {
    const parsed = JSON.parse(trimmed) as { error?: unknown; message?: unknown; code?: unknown };
    if (parsed && typeof parsed === "object") {
      const error = parsed.error;
      if (error && typeof error === "object") {
        const message = (error as { message?: unknown }).message;
        const code = (error as { code?: unknown }).code;
        if (typeof message === "string") return `${typeof code === "string" ? `${code}: ` : ""}${safeSnippet(message)}`;
      }
      if (typeof parsed.message === "string") return `${typeof parsed.code === "string" ? `${parsed.code}: ` : ""}${safeSnippet(parsed.message)}`;
    }
  } catch {
    // Keep a short body prefix for non-JSON diagnostics.
  }
  return safeSnippet(trimmed);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Resolve a configured provider base URL to one OpenAI-compatible endpoint. */
export function aiProviderChatEndpoint(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new RangeError("AI Provider Base URL must be an HTTP(S) URL");
  url.hash = "";
  const pathname = url.pathname.replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(pathname)) {
    url.pathname = pathname;
    return url.href;
  }
  const prefix = pathname || "/v1";
  url.pathname = `${prefix}/chat/completions`.replace(/\/+/g, "/");
  return url.href;
}

async function decodeCompletionResponse(response: Response, endpoint: string): Promise<AiProviderCompletionPayload> {
  const contentType = response.headers.get("content-type") ?? "";
  const body = await response.text();
  const display = safeEndpoint(endpoint);
  if (!response.ok) {
    throw new AiProviderRequestError(
      `Provider returned HTTP ${response.status} from ${display} (${contentType || "unknown content type"}): ${responseSummary(body, contentType)}`,
      { endpoint, status: response.status, contentType },
    );
  }
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const looksJson = mediaType === "" || mediaType === "application/json" || mediaType.endsWith("+json");
  if (!looksJson) {
    throw new AiProviderRequestError(
      `Provider returned non-JSON response from ${display}: HTTP ${response.status} (${contentType || "unknown content type"})`,
      { endpoint, status: response.status, contentType },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    throw new AiProviderRequestError(
      `Provider returned invalid JSON from ${display}: HTTP ${response.status} (${contentType || "unknown content type"})`,
      { endpoint, status: response.status, contentType, cause: error },
    );
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.choices)) {
    throw new AiProviderRequestError(
      `Provider response from ${display} has no choices`,
      { endpoint, status: response.status, contentType },
    );
  }
  const firstChoice = parsed.choices[0];
  if (!isRecord(firstChoice) || !isRecord(firstChoice.message)) {
    throw new AiProviderRequestError(
      `Provider response from ${display} has no message`,
      { endpoint, status: response.status, contentType },
    );
  }
  return parsed as AiProviderCompletionPayload;
}

export async function requestAiProviderCompletion(options: AiProviderCompletionOptions): Promise<AiProviderCompletionResult> {
  const endpoint = aiProviderChatEndpoint(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const payload: Record<string, unknown> = {
    model: options.model,
    messages: options.messages,
  };
  if (options.tools?.length) {
    payload.tools = options.tools;
    payload.tool_choice = options.toolChoice ?? "auto";
  }
  const url = new URL(endpoint);
  const provider = providerName(url.hostname);
  const started = performance.now();
  try {
    const result = await withSpan(`chat ${options.model}`, {
      "asa.component": "llm",
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": provider,
      "gen_ai.request.model": options.model,
      "asa.llm.attempt": options.attempt ?? 1,
      "asa.llm.stream": false,
      ...(options.fallback ? { "asa.llm.fallback": options.fallback } : {}),
      "peer.service": provider,
      "server.address": url.hostname,
      ...(url.port ? { "server.port": Number(url.port) } : {}),
    }, async (span) => {
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
          },
          body: JSON.stringify(payload),
          ...(options.signal ? { signal: options.signal } : {}),
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new AiProviderRequestError(`Provider request failed for ${safeEndpoint(endpoint)}: ${safeSnippet(detail)}`, { endpoint, cause: error });
      }
      const parsed = await decodeCompletionResponse(response, endpoint);
      const choice = parsed.choices![0]!;
      if (parsed.id) span.setAttribute("gen_ai.response.id", parsed.id);
      if (parsed.model) span.setAttribute("gen_ai.response.model", parsed.model);
      if (choice.finish_reason) span.setAttribute("gen_ai.response.finish_reasons", [choice.finish_reason]);
      const usage = parsed.usage;
      if (usage?.prompt_tokens !== undefined) span.setAttribute("gen_ai.usage.input_tokens", usage.prompt_tokens);
      if (usage?.completion_tokens !== undefined) span.setAttribute("gen_ai.usage.output_tokens", usage.completion_tokens);
      if (usage?.total_tokens !== undefined) span.setAttribute("asa.llm.total_tokens", usage.total_tokens);
      if (usage?.prompt_tokens_details?.cached_tokens !== undefined) span.setAttribute("asa.llm.cached_input_tokens", usage.prompt_tokens_details.cached_tokens);
      if (usage?.completion_tokens_details?.reasoning_tokens !== undefined) span.setAttribute("asa.llm.reasoning_tokens", usage.completion_tokens_details.reasoning_tokens);
      if (usage?.prompt_tokens === undefined && usage?.completion_tokens === undefined) span.setAttribute("asa.llm.usage_missing", true);
      recordAiUsage({
        provider,
        model: options.model,
        durationSeconds: (performance.now() - started) / 1000,
        ...(usage?.prompt_tokens === undefined ? {} : { promptTokens: usage.prompt_tokens }),
        ...(usage?.completion_tokens === undefined ? {} : { completionTokens: usage.completion_tokens }),
      });
      return { endpoint, message: choice.message!, payload: parsed };
    }, { kind: SpanKind.CLIENT });
    return result;
  } catch (error) {
    recordAiUsage({ provider, model: options.model, durationSeconds: (performance.now() - started) / 1000, errorType: classifyError(error) });
    throw error;
  }
}

function providerName(hostname: string): string {
  const host = hostname.toLowerCase();
  if (host === "api.openai.com" || host.endsWith(".openai.azure.com")) return host.endsWith(".openai.azure.com") ? "azure.ai.openai" : "openai";
  if (host.includes("deepseek")) return "deepseek";
  if (host.includes("anthropic")) return "anthropic";
  if (host.includes("moonshot") || host.includes("kimi")) return "moonshot";
  if (host.includes("qwen") || host.includes("dashscope")) return "qwen";
  return "asa-llm-gateway";
}

export function isAiProviderToolsUnsupported(error: unknown): boolean {
  if (!(error instanceof AiProviderRequestError)) return false;
  if (error.status === undefined || ![400, 404, 405, 415, 422].includes(error.status)) return false;
  return /tool|function|unsupported parameter|not supported/i.test(error.message);
}
