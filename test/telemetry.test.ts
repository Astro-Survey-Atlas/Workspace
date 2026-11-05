import assert from "node:assert/strict";
import test from "node:test";

import { context, metrics, SpanKind, trace } from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
  type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace";

import { requestAiProviderCompletion } from "../src/ai-provider-client.js";
import {
  activeMcpMetadata,
  changeHitlPending,
  changeTaskRunning,
  initTelemetry,
  installStructuredLogging,
  recordAiUsage,
  recordChatTurn,
  recordHitlWait,
  recordMcpCall,
  recordScan,
  recordTaskDuration,
  recordToolCall,
  shutdownTelemetry,
  withRootSpan,
  withSpan,
} from "../src/telemetry.js";

const envKeys = [
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_SDK_DISABLED",
  "OTEL_SERVICE_NAME",
  "OTEL_TRACES_SAMPLER",
  "OTEL_PROPAGATORS",
  "ASA_OTEL_CAPTURE_CONTENT",
] as const;

function metricPoints(resources: ResourceMetrics[]): Array<{ name: string; attributes: Record<string, unknown> }> {
  return resources.flatMap((resource) => resource.scopeMetrics.flatMap((scope) => scope.metrics.flatMap((metric) =>
    metric.dataPoints.map((point) => ({
      name: metric.descriptor.name,
      attributes: point.attributes as Record<string, unknown>,
    })),
  )));
}

test("telemetry follows the Workspace trace, privacy, and metric-label contract", async () => {
  const previousEnvironment = new Map(envKeys.map((key) => [key, process.env[key]]));
  for (const key of envKeys) delete process.env[key];
  process.env.OTEL_TRACES_SAMPLER = "always_on";
  process.env.OTEL_PROPAGATORS = "tracecontext";
  process.env.OTEL_SERVICE_NAME = "asa-workspace";

  const spanExporter = new InMemorySpanExporter();
  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const metricReader = new PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: 60_000 });

  try {
    initTelemetry();
    const noEndpointSpan = trace.getTracer("telemetry-noop-test").startSpan("noop.check");
    assert.equal(noEndpointSpan.isRecording(), false, "telemetry is no-op without an OTLP endpoint");
    noEndpointSpan.end();

    initTelemetry({
      spanProcessors: [new SimpleSpanProcessor({ exporter: spanExporter })],
      metricReaders: [metricReader],
    });

    await context.with(suppressTracing(context.active()), async () => {
      await withRootSpan("mcp.server.tool suppressed-request", { "asa.component": "mcp" }, async (root) => {
        assert.equal(root.isRecording(), true, "root span records inside a suppressed HTTP request context");
        await withSpan("mcp.catalog.query suppressed-request", {}, (child) => {
          assert.equal(child.isRecording(), true, "child span inherits the unsuppressed root context");
          assert.equal(child.spanContext().traceId, root.spanContext().traceId);
        });
      });
    });

    metrics.getMeter("http-instrumentation-budget-test").createHistogram("http.client.request.duration", { unit: "s" })
      .record(0.25, { "http.request.method": "GET", "server.address": "private.example" });
    metrics.getMeter("http-instrumentation-budget-test").createHistogram("http.server.request.duration", { unit: "s" })
      .record(0.5, { "http.request.method": "POST", "http.response.status_code": 200 });

    const prompt = "private user prompt";
    const responseText = "private model response";
    await withRootSpan("chat.turn", {
      "asa.component": "agent",
      "asa.turn.index": 1,
      "asa.session.id": "private-session-id",
    }, async () => {
      await requestAiProviderCompletion({
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-chat",
        messages: [{ role: "user", content: prompt }],
        fetchImpl: async () => new Response(JSON.stringify({
          id: "response-id",
          model: "deepseek-chat",
          choices: [{ finish_reason: "stop", message: { role: "assistant", content: responseText } }],
          usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
        }), { status: 200, headers: { "content-type": "application/json" } }),
      });

      await withSpan("tools/call euclid_catalog_query", {
        "asa.component": "mcp-client",
        "asa.mcp.server": "euclid-catalog",
        "gen_ai.tool.name": "euclid_catalog_query",
      }, async (span) => {
        const metadata = activeMcpMetadata();
        assert.ok(metadata?.traceparent);
        const [version, traceId, spanId, flags] = metadata.traceparent.split("-");
        assert.equal(version, "00");
        assert.equal(traceId, span.spanContext().traceId);
        assert.equal(spanId, span.spanContext().spanId);
        assert.equal(flags, span.spanContext().traceFlags.toString(16).padStart(2, "0"));
        assert.deepEqual(Object.keys(metadata), ["traceparent"]);
      }, { kind: SpanKind.CLIENT });
    });

    recordAiUsage({
      provider: "customer-private-provider",
      model: "private-model-identifier-82",
      durationSeconds: 0.2,
      promptTokens: 4,
      errorType: "private exception message",
    });
    recordChatTurn("ok");
    recordToolCall("private dynamic tool name", "private exception message");
    recordMcpCall("customer-private-server", 0.4, "private dynamic MCP tool", "private exception message");
    recordTaskDuration("private-workflow-run-id", 0.5, "private task outcome");
    recordTaskDuration("euclid-desi-crossmatch@1", 0.25, "waiting");
    changeTaskRunning("private-workflow-run-id", 1);
    changeTaskRunning("private-workflow-run-id", -1);
    changeHitlPending("human_filter", 1);
    changeHitlPending("human_filter", -1);
    recordHitlWait("human_filter", "approved", 12);
    recordScan("workspace", { accepted: 2, skipped: 1, failed: 1, bytes: 4096, peakRssBytes: 1024 });
    await metricReader.forceFlush();

    const spans = spanExporter.getFinishedSpans();
    const root = spans.find((span) => span.name === "chat.turn");
    assert.ok(spans.some((span) => span.name === "mcp.server.tool suppressed-request"), "MCP root span survives request suppression");
    assert.ok(spans.some((span) => span.name === "mcp.catalog.query suppressed-request"), "MCP child span is recorded under the root");
    const llm = spans.find((span) => span.name === "chat deepseek-chat");
    const mcp = spans.find((span) => span.name === "tools/call euclid_catalog_query");
    assert.ok(root, "chat turn has a root span");
    assert.equal(root.attributes["asa.component"], "agent");
    assert.equal(root.attributes["asa.turn.index"], 1);
    assert.equal(root.attributes["asa.session.id"], "private-session-id");
    assert.ok(llm, "LLM request span uses the contracted name");
    assert.equal(llm.kind, SpanKind.CLIENT);
    assert.equal(llm.attributes["gen_ai.operation.name"], "chat");
    assert.equal(llm.attributes["gen_ai.provider.name"], "deepseek");
    assert.equal(llm.attributes["gen_ai.request.model"], "deepseek-chat");
    assert.equal(llm.attributes["gen_ai.usage.input_tokens"], 12);
    assert.equal(llm.attributes["gen_ai.usage.output_tokens"], 7);
    assert.ok(mcp, "MCP call span is recorded");
    assert.equal(mcp.kind, SpanKind.CLIENT);
    assert.equal(mcp.attributes["gen_ai.tool.name"], "euclid_catalog_query");
    for (const span of spans) {
      assert.equal(span.attributes["gen_ai.input.messages"], undefined);
      assert.equal(span.attributes["gen_ai.output.messages"], undefined);
      assert.equal(span.attributes["gen_ai.tool.call.arguments"], undefined);
      assert.equal(span.attributes["gen_ai.tool.call.result"], undefined);
    }
    assert.ok(!JSON.stringify(spans.map((span) => span.attributes)).includes(prompt));
    assert.ok(!JSON.stringify(spans.map((span) => span.attributes)).includes(responseText));

    const points = metricPoints(metricExporter.getMetrics());
    const allowedMetricAttributes = new Set([
      "gen_ai.operation.name", "gen_ai.provider.name", "gen_ai.request.model", "gen_ai.token.type",
      "gen_ai.tool.name", "error.type", "asa.workflow.key", "asa.step.id", "asa.mcp.server",
      "asa.chat.outcome", "asa.task.outcome", "asa.hitl.gate", "asa.hitl.decision", "asa.scan.kind",
      "asa.scan.outcome", "asa.component",
    ]);
    assert.ok(points.length > 0, "metrics were exported through the injected reader");
    assert.ok(!points.some((point) => point.name === "http.client.request.duration" || point.name === "http.server.request.duration"));
    for (const point of points) {
      for (const name of Object.keys(point.attributes)) {
        assert.ok(allowedMetricAttributes.has(name), `${point.name} has non-contract metric attribute ${name}`);
      }
    }
    assert.ok(!JSON.stringify(points).includes("customer-private-provider"));
    assert.ok(!JSON.stringify(points).includes("private-model-identifier-82"));
    assert.ok(!JSON.stringify(points).includes("private dynamic tool name"));
    assert.ok(!JSON.stringify(points).includes("private exception message"));
    assert.ok(!JSON.stringify(points).includes("private-workflow-run-id"));
    assert.ok(!JSON.stringify(points).includes("customer-private-server"));
    const boundedLlm = points.find((point) => point.name === "gen_ai.client.operation.duration"
      && point.attributes["gen_ai.provider.name"] === "other");
    assert.equal(boundedLlm?.attributes["gen_ai.request.model"], "other");
    assert.equal(boundedLlm?.attributes["error.type"], "other");
    const boundedMcp = points.find((point) => point.name === "asa.mcp.calls"
      && point.attributes["asa.mcp.server"] === "other");
    assert.equal(boundedMcp?.attributes["gen_ai.tool.name"], "other");
    assert.equal(boundedMcp?.attributes["error.type"], "other");
    const boundedTask = points.find((point) => point.name === "asa.task.duration"
      && point.attributes["asa.workflow.key"] === "other");
    assert.equal(boundedTask?.attributes["asa.task.outcome"], "other");
    const waitingTask = points.find((point) => point.name === "asa.task.duration"
      && point.attributes["asa.workflow.key"] === "euclid-desi-crossmatch@1");
    assert.equal(waitingTask?.attributes["asa.task.outcome"], "waiting");

    const logLines: string[] = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      logLines.push(Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      installStructuredLogging();
      await withSpan("logger.component test", { "asa.component": "agent" }, () => {
        console.log("logger context marker");
      });
    } finally {
      process.stdout.write = originalWrite;
    }
    const loggedLine = logLines.map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((line) => line.msg === "logger context marker");
    assert.equal(loggedLine?.["asa.component"], "agent");
  } finally {
    await shutdownTelemetry();
    for (const key of envKeys) {
      const value = previousEnvironment.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
