import {
  context,
  metrics,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  createContextKey,
  type Attributes,
  type Counter,
  type Histogram,
  type ObservableGauge,
  type Span,
  type SpanOptions,
  type SpanContext,
  type UpDownCounter,
} from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { ExpressInstrumentation } from "@opentelemetry/instrumentation-express";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { unsuppressTracing } from "@opentelemetry/core";
import {
  AggregationType,
  createAllowListAttributesProcessor,
  InstrumentType,
  PeriodicExportingMetricReader,
  type ViewOptions,
} from "@opentelemetry/sdk-metrics";
import { NodeSDK, type NodeSDKConfiguration } from "@opentelemetry/sdk-node";

const tracer = trace.getTracer("asa-workspace", "0.0.1");
const componentContextKey = createContextKey("asa.component");
let sdk: NodeSDK | undefined;
let shutdownPromise: Promise<void> | undefined;
let structuredLoggingInstalled = false;

const peakRssByKind = new Map<string, number>();
let metricInstruments: {
  chatTurns: Counter;
  toolCalls: Counter;
  mcpCalls: Counter;
  mcpDuration: Histogram;
  taskDuration: Histogram;
  taskRunning: UpDownCounter;
  hitlWait: Histogram;
  hitlPending: UpDownCounter;
  tokenUsage: Histogram;
  llmDuration: Histogram;
  scanFiles: Counter;
  scanBytes: Counter;
  scanPeakRss: ObservableGauge;
} | undefined;

const histogramViews = [
  dropMetric("http.client.request.duration"),
  dropMetric("http.server.request.duration"),
  view("gen_ai.client.token.usage", [64, 256, 1024, 4096, 16384, 65536, 262144], ["gen_ai.operation.name", "gen_ai.provider.name", "gen_ai.request.model", "gen_ai.token.type"]),
  view("gen_ai.client.operation.duration", [0.5, 1, 2, 5, 10, 30, 60, 120, 300], ["gen_ai.operation.name", "gen_ai.provider.name", "gen_ai.request.model", "error.type"]),
  view("asa.mcp.duration", [0.05, 0.25, 1, 5, 30, 120, 600], ["asa.mcp.server"]),
  view("asa.task.duration", [1, 10, 60, 300, 600, 1800, 3600, 7200], ["asa.workflow.key", "asa.task.outcome"]),
  view("asa.hitl.wait", [10, 60, 300, 900, 3600, 14400, 86400], ["asa.hitl.gate", "asa.hitl.decision"]),
];

function dropMetric(instrumentName: string): ViewOptions {
  return { instrumentName, aggregation: { type: AggregationType.DROP } };
}

function view(instrumentName: string, boundaries: number[], attributes: string[]): ViewOptions {
  return {
    instrumentName,
    instrumentType: InstrumentType.HISTOGRAM,
    aggregation: { type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM, options: { boundaries } },
    attributesProcessors: [createAllowListAttributesProcessor(attributes)],
    aggregationCardinalityLimit: 50,
  };
}

type TelemetrySdkOverrides = Partial<Pick<NodeSDKConfiguration, "traceExporter" | "spanProcessors" | "metricReaders">>;

export function initTelemetry(overrides: TelemetrySdkOverrides = {}): void {
  const hasOverrides = overrides.traceExporter !== undefined
    || overrides.spanProcessors !== undefined
    || overrides.metricReaders !== undefined;
  if (sdk || (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT && !hasOverrides)) return;
  sdk = new NodeSDK({
    traceExporter: overrides.traceExporter ?? new OTLPTraceExporter(),
    ...(overrides.spanProcessors ? { spanProcessors: overrides.spanProcessors } : {}),
    metricReaders: overrides.metricReaders ?? [new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter(),
      exportIntervalMillis: Number(process.env.OTEL_METRIC_EXPORT_INTERVAL ?? 15_000),
    })],
    views: histogramViews,
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (request) => {
          const url = request.url ?? "";
          const accept = request.headers.accept;
          return url === "/health" || url === "/ready" || url === "/healthz" || url.startsWith("/assets/")
            || url.startsWith("/__internal/fits-range")
            || /\.(?:js|css|map|svg|png|jpe?g|ico|woff2?)(?:\?|$)/i.test(url)
            || (typeof accept === "string" && accept.includes("text/event-stream"));
        },
      }),
      new ExpressInstrumentation(),
      new UndiciInstrumentation(),
    ],
  });
  sdk.start();
  registerMetricInstruments();
}

function registerMetricInstruments(): void {
  if (metricInstruments) return;
  const meter = metrics.getMeter("asa-workspace", "0.0.1");
  const scanPeakRss = meter.createObservableGauge("asa.scan.peak_rss", { unit: "By" });
  scanPeakRss.addCallback((result) => {
    for (const [kind, bytes] of peakRssByKind) result.observe(bytes, metricAttributes({ "asa.scan.kind": kind }));
  });
  metricInstruments = {
    chatTurns: meter.createCounter("asa.chat.turns", { unit: "{turn}" }),
    toolCalls: meter.createCounter("asa.tool.calls", { unit: "{call}" }),
    mcpCalls: meter.createCounter("asa.mcp.calls", { unit: "{call}" }),
    mcpDuration: meter.createHistogram("asa.mcp.duration", { unit: "s" }),
    taskDuration: meter.createHistogram("asa.task.duration", { unit: "s" }),
    taskRunning: meter.createUpDownCounter("asa.task.running", { unit: "{task}" }),
    hitlWait: meter.createHistogram("asa.hitl.wait", { unit: "s" }),
    hitlPending: meter.createUpDownCounter("asa.hitl.pending", { unit: "{gate}" }),
    tokenUsage: meter.createHistogram("gen_ai.client.token.usage", { unit: "{token}" }),
    llmDuration: meter.createHistogram("gen_ai.client.operation.duration", { unit: "s" }),
    scanFiles: meter.createCounter("asa.scan.files", { unit: "{file}" }),
    scanBytes: meter.createCounter("asa.scan.bytes", { unit: "By" }),
    scanPeakRss,
  };
}

export function installStructuredLogging(): void {
  if (structuredLoggingInstalled) return;
  structuredLoggingInstalled = true;
  const methods = ["log", "info", "warn", "error"] as const;
  for (const method of methods) {
    console[method] = (...values: unknown[]): void => {
      const active = trace.getActiveSpan()?.spanContext();
      const serviceName = process.env.OTEL_SERVICE_NAME ?? "";
      const activeComponent = context.active().getValue(componentContextKey);
      const component = typeof activeComponent === "string" ? activeComponent
        : serviceName.endsWith("-scanner") ? "scan" : serviceName.endsWith("-downloader") ? "download" : "workflow";
      const message = values.map(safeLogValue).join(" ").slice(0, 4096);
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        level: method === "log" ? "info" : method,
        msg: message,
        trace_id: active?.traceId ?? null,
        span_id: active?.spanId ?? null,
        "asa.component": component,
      });
      process.stdout.write(`${line}\n`);
    };
  }
}

function safeLogValue(value: unknown): string {
  if (value instanceof Error) {
    const details = value as Error & { code?: unknown; status?: unknown };
    const code = typeof details.code === "string" && /^[A-Za-z0-9_.-]{1,40}$/.test(details.code) ? ` code=${details.code}` : "";
    const status = typeof details.status === "number" && Number.isInteger(details.status) ? ` status=${details.status}` : "";
    return `${value.name} error.type=${classifyError(value)}${code}${status}`;
  }
  if (typeof value === "string") {
    return safeLogMessage(value
      .replace(/https?:\/\/[^\s,;]+/gi, "<url>")
      .replace(/s3:\/\/[^\s,;]+/gi, "<object-uri>"))
      .replace(/\b[0-9a-f]{24,}\b/gi, "<id>")
      .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, "<id>");
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  if (value === null || value === undefined) return String(value);
  return Array.isArray(value) ? `[array:${value.length}]` : "[object]";
}

export async function shutdownTelemetry(): Promise<void> {
  if (!sdk) return;
  shutdownPromise ??= sdk.shutdown().finally(() => { sdk = undefined; });
  await shutdownPromise;
}

export function activeTraceparent(): string | undefined {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier.traceparent;
}

export function activeMcpMetadata(): { traceparent: string } | undefined {
  const traceparent = activeTraceparent();
  return traceparent ? { traceparent } : undefined;
}

export function traceContextFromTraceparent(traceparent: string | undefined): SpanContext | undefined {
  if (!traceparent) return undefined;
  const extracted = propagation.extract(ROOT_CONTEXT, { traceparent });
  return trace.getSpanContext(extracted);
}

export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  callback: (span: Span) => Promise<T> | T,
  options: SpanOptions = {},
): Promise<T> {
  return tracer.startActiveSpan(name, { kind: SpanKind.INTERNAL, ...options, attributes }, async (span) => {
    const component = attributes["asa.component"];
    const activeContext = typeof component === "string"
      ? context.active().setValue(componentContextKey, component)
      : context.active();
    return context.with(activeContext, async () => {
      try {
        return await callback(span);
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        span.setAttribute("error.type", classifyError(error));
        if (name === "chat.turn") span.setAttribute("asa.chat.outcome", "error");
        span.recordException(new Error(safeTelemetryError(error)));
        throw error;
      } finally {
        span.end();
      }
    });
  });
}

export async function withRootSpan<T>(
  name: string,
  attributes: Attributes,
  callback: (span: Span) => Promise<T> | T,
  link?: SpanContext,
  startTime?: Date,
): Promise<T> {
  const activeContext = unsuppressTracing(context.active());
  const active = trace.getSpan(activeContext)?.spanContext();
  const links = uniqueSpanContexts([link, active]);
  return context.with(activeContext, () => withSpan(name, attributes, callback, {
    root: true,
    links: links.map((value) => ({ context: value })),
    ...(startTime ? { startTime } : {}),
  }));
}

export async function withContinuedSpan<T>(
  name: string,
  attributes: Attributes,
  callback: (span: Span) => Promise<T> | T,
  traceparent: string | undefined,
  startTime?: Date,
): Promise<T> {
  const active = trace.getActiveSpan()?.spanContext();
  if (!traceparent) return withRootSpan(name, attributes, callback, active, startTime);

  const parentContext = propagation.extract(ROOT_CONTEXT, { traceparent });
  const parent = trace.getSpanContext(parentContext);
  if (!parent) return withRootSpan(name, attributes, callback, active, startTime);

  const links = uniqueSpanContexts([active]).filter((value) => value.traceId !== parent.traceId || value.spanId !== parent.spanId);
  return context.with(parentContext, () => withSpan(name, attributes, callback, {
    links: links.map((value) => ({ context: value })),
    ...(startTime ? { startTime } : {}),
  }));
}

function uniqueSpanContexts(values: Array<SpanContext | undefined>): SpanContext[] {
  const unique = new Map<string, SpanContext>();
  for (const value of values) {
    if (value) unique.set(`${value.traceId}:${value.spanId}`, value);
  }
  return [...unique.values()];
}

export function recordAiUsage(input: {
  provider: string;
  model: string;
  durationSeconds: number;
  promptTokens?: number;
  completionTokens?: number;
  errorType?: string;
}): void {
  const labels = metricAttributes({
    "gen_ai.operation.name": "chat",
    "gen_ai.provider.name": input.provider,
    "gen_ai.request.model": input.model,
  });
  metricInstruments?.llmDuration.record(input.durationSeconds, metricAttributes({ ...labels, ...(input.errorType ? { "error.type": input.errorType } : {}) }));
  if (input.promptTokens !== undefined) metricInstruments?.tokenUsage.record(input.promptTokens, metricAttributes({ ...labels, "gen_ai.token.type": "input" }));
  if (input.completionTokens !== undefined) metricInstruments?.tokenUsage.record(input.completionTokens, metricAttributes({ ...labels, "gen_ai.token.type": "output" }));
}

export function recordChatTurn(outcome: "ok" | "error" | "cancelled"): void {
  metricInstruments?.chatTurns.add(1, metricAttributes({ "asa.chat.outcome": outcome }));
}

export function recordToolCall(name: string, errorType?: string): void {
  metricInstruments?.toolCalls.add(1, metricAttributes({ "gen_ai.tool.name": name, ...(errorType ? { "error.type": errorType } : {}) }));
}

export function recordMcpCall(server: string, durationSeconds: number, toolName: string, errorType?: string): void {
  metricInstruments?.mcpCalls.add(1, metricAttributes({ "asa.mcp.server": server, "gen_ai.tool.name": toolName, ...(errorType ? { "error.type": errorType } : {}) }));
  metricInstruments?.mcpDuration.record(durationSeconds, metricAttributes({ "asa.mcp.server": server }));
}

export function recordTaskDuration(workflow: string, durationSeconds: number, outcome: string): void {
  metricInstruments?.taskDuration.record(durationSeconds, metricAttributes({ "asa.workflow.key": workflow, "asa.task.outcome": outcome }));
}

export function changeTaskRunning(workflow: string, delta: 1 | -1): void {
  metricInstruments?.taskRunning.add(delta, metricAttributes({ "asa.workflow.key": workflow }));
}

export function changeHitlPending(gate: "confirm_tool" | "human_filter" | "production_approval", delta: 1 | -1): void {
  metricInstruments?.hitlPending.add(delta, metricAttributes({ "asa.hitl.gate": gate }));
}

export function recordHitlWait(gate: "confirm_tool" | "human_filter" | "production_approval", decision: "approved" | "rejected" | "expired", seconds: number): void {
  metricInstruments?.hitlWait.record(seconds, metricAttributes({ "asa.hitl.gate": gate, "asa.hitl.decision": decision }));
}

export function recordScan(kind: "workspace" | "local" | "warehouse", counts: { accepted?: number; skipped?: number; failed?: number; bytes?: number; peakRssBytes?: number }): void {
  if (counts.accepted) metricInstruments?.scanFiles.add(counts.accepted, metricAttributes({ "asa.scan.kind": kind, "asa.scan.outcome": "accepted" }));
  if (counts.skipped) metricInstruments?.scanFiles.add(counts.skipped, metricAttributes({ "asa.scan.kind": kind, "asa.scan.outcome": "skipped" }));
  if (counts.failed) metricInstruments?.scanFiles.add(counts.failed, metricAttributes({ "asa.scan.kind": kind, "asa.scan.outcome": "failed" }));
  if (counts.bytes) metricInstruments?.scanBytes.add(counts.bytes, metricAttributes({ "asa.scan.kind": kind }));
  if (counts.peakRssBytes !== undefined) peakRssByKind.set(kind, Math.max(peakRssByKind.get(kind) ?? 0, counts.peakRssBytes));
}

const metricAttributeValues: Record<string, ReadonlySet<string>> = {
  "gen_ai.operation.name": new Set(["chat", "other"]),
  "gen_ai.provider.name": new Set(["openai", "deepseek", "anthropic", "moonshot", "qwen", "azure.ai.openai", "asa-llm-gateway", "other"]),
  "gen_ai.request.model": new Set([
    "gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano", "gpt-5", "gpt-5-mini", "gpt-5-nano", "gpt-6-luna",
    "o3", "o3-mini", "o4-mini", "deepseek-chat", "deepseek-reasoner", "deepseek-v3", "deepseek-r1",
    "qwen-max", "qwen-plus", "qwen-turbo", "qwen3", "moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k",
    "claude-3.5-sonnet", "claude-3.7-sonnet", "claude-sonnet-4", "other",
  ]),
  "gen_ai.token.type": new Set(["input", "output", "other"]),
  "gen_ai.tool.name": new Set([
    "list_data_assets", "list_connectors", "list_production_runs", "list_workflows", "get_workflow_run",
    "create_workflow_run", "call_mcp_tool", "delegate_agent", "workspace_api", "submit_production_run",
    "approve_production_run", "reject_production_run", "es_query", "execute_cutout_group",
    "euclid_catalog_query", "desi_catalog_query", "other",
  ]),
  "error.type": new Set(["timeout", "validation", "http_429", "http_5xx", "http_4xx", "tool_error", "other"]),
  "asa.workflow.key": new Set(["euclid-desi-crossmatch@1", "other"]),
  "asa.step.id": new Set(["parse_input", "query_euclid", "query_desi", "normalize", "crossmatch", "human_filter", "cutout", "export", "other"]),
  "asa.mcp.server": new Set(["astro-catalog", "euclid-catalog", "desi-catalog", "fits-cutout", "astro-all", "configured", "other"]),
  "asa.chat.outcome": new Set(["ok", "error", "cancelled", "other"]),
  "asa.task.outcome": new Set(["ok", "waiting", "error", "other"]),
  "asa.hitl.gate": new Set(["confirm_tool", "human_filter", "production_approval", "other"]),
  "asa.hitl.decision": new Set(["approved", "rejected", "expired", "other"]),
  "asa.scan.kind": new Set(["workspace", "local", "warehouse", "other"]),
  "asa.scan.outcome": new Set(["accepted", "skipped", "failed", "other"]),
  "asa.component": new Set(["agent", "llm", "workflow", "hitl", "scan", "download", "mcp-client", "other"]),
};

const metricAttributeNames = new Set(Object.keys(metricAttributeValues));

function metricAttributes(attributes: Attributes): Attributes {
  const bounded: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    const allowedValues = metricAttributeValues[key];
    if (!metricAttributeNames.has(key) || typeof value !== "string" || !allowedValues) continue;
    bounded[key] = allowedValues.has(value) ? value : "other";
  }
  return bounded;
}

export function injectActiveTrace(carrier: Record<string, string>): void {
  propagation.inject(context.active(), carrier);
}

export function withTraceparent<T>(traceparent: string | undefined, callback: () => Promise<T> | T): Promise<T> {
  if (!traceparent) return Promise.resolve(callback());
  const extracted = propagation.extract(ROOT_CONTEXT, { traceparent });
  return Promise.resolve(context.with(extracted, callback));
}

export function safeTelemetryError(error: unknown): string {
  const name = error && typeof error === "object" && "name" in error && typeof (error as { name?: unknown }).name === "string"
    ? (error as { name: string }).name.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 48) || "Error"
    : "Error";
  return `${name}: ${classifyError(error)}`;
}

function safeLogMessage(value: string): string {
  return value
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer <REDACTED>")
    .replace(/(?:[A-Za-z]:)?(?:\\|\/)[^\s,;]+/g, "<path>")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "<email>")
    .replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*([^,;\s}]+)/gi, "$1=<REDACTED>")
    .replace(/\s+/g, " ")
    .slice(0, 256);
}

export function classifyError(error: unknown): string {
  if (error && typeof error === "object") {
    const value = error as { name?: unknown; message?: unknown; cause?: unknown };
    if (value.name === "AbortError" || value.name === "TimeoutError" || (typeof value.message === "string" && /timed out|timeout|aborted/i.test(value.message))) return "timeout";
    if (value.name === "RangeError" || value.name === "TypeError") return "validation";
    if (value.cause && value.cause !== error) {
      const cause = classifyError(value.cause);
      if (cause !== "tool_error") return cause;
    }
  }
  if (error && typeof error === "object" && "status" in error && typeof (error as { status?: unknown }).status === "number") {
    const status = (error as { status: number }).status;
    if (status === 429) return "http_429";
    if (status >= 500) return "http_5xx";
    if (status >= 400) return "http_4xx";
  }
  return "tool_error";
}
