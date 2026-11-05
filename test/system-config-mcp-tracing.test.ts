import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { context, SpanKind } from "@opentelemetry/api";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace";

import { SystemConfigStore } from "../src/system-config.js";
import { initTelemetry, shutdownTelemetry, withRootSpan } from "../src/telemetry.js";

const envKeys = [
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_SDK_DISABLED",
  "OTEL_SERVICE_NAME",
  "OTEL_TRACES_SAMPLER",
  "OTEL_PROPAGATORS",
] as const;

test("MCP transport propagates tools/call directly to the remote server", async () => {
  const previousEnvironment = new Map(envKeys.map((key) => [key, process.env[key]]));
  for (const key of envKeys) delete process.env[key];
  process.env.OTEL_SERVICE_NAME = "asa-workspace";
  process.env.OTEL_TRACES_SAMPLER = "always_on";
  process.env.OTEL_PROPAGATORS = "tracecontext";

  const exporter = new InMemorySpanExporter();
  const metricsExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const metricReader = new PeriodicExportingMetricReader({ exporter: metricsExporter, exportIntervalMillis: 60_000 });
  const root = await mkdtemp(path.join(os.tmpdir(), "asa-mcp-trace-"));
  const mcpServer = new Server({ name: "trace-fixture", version: "0.0.1" }, { capabilities: { tools: {} } });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => "trace-fixture-session" });
  let remoteHttpTraceparent: string | undefined;
  let remoteMetaTraceparent: string | undefined;
  const fixtureErrors: string[] = [];
  const fixtureResponses: Array<{ method: string; rpcMethod?: string; status: number }> = [];
  let listening = false;
  let httpServer: import("node:http").Server | undefined;
  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: "trace_probe", description: "Read the active trace", inputSchema: { type: "object", properties: {} } }],
  }));
  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const metadata = request.params._meta as Record<string, unknown> | undefined;
    remoteMetaTraceparent = typeof metadata?.traceparent === "string" ? metadata.traceparent : undefined;
    return { content: [{ type: "text", text: "ok" }] };
  });

  try {
    initTelemetry({
      spanProcessors: [new SimpleSpanProcessor({ exporter })],
      metricReaders: [metricReader],
    });
    const { createServer } = await import("node:http");
    httpServer = createServer((request, response) => {
      if (request.method === "GET") {
        response.writeHead(405).end();
        return;
      }
      let parsedMethod: string | undefined;
      response.once("finish", () => fixtureResponses.push({
        method: request.method ?? "unknown",
        ...(parsedMethod ? { rpcMethod: parsedMethod } : {}),
        status: response.statusCode,
      }));
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        const rawBody = Buffer.concat(chunks).toString("utf8");
        const parsedBody = rawBody ? JSON.parse(rawBody) as unknown : undefined;
        if (parsedBody && typeof parsedBody === "object" && "method" in parsedBody && typeof parsedBody.method === "string") {
          parsedMethod = parsedBody.method;
        }
        if (parsedMethod === "tools/call" && typeof request.headers.traceparent === "string") {
          remoteHttpTraceparent = request.headers.traceparent;
        }
        response.setHeader("X-Request-ID", `fixture-${parsedMethod ?? "unknown"}`);
        if (parsedMethod === "notifications/initialized") {
          response.writeHead(202).end();
          return;
        }
        await transport.handleRequest(request, response, parsedBody);
      })().catch((error: unknown) => {
        fixtureErrors.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
        if (!response.headersSent) response.writeHead(500).end();
      });
    });
    await mcpServer.connect(transport);
    await new Promise<void>((resolve, reject) => {
      httpServer?.once("error", reject);
      httpServer?.listen(0, "127.0.0.1", () => resolve());
    });
    listening = true;
    const address = httpServer.address();
    assert.ok(address && typeof address !== "string");

    const store = new SystemConfigStore(path.join(root, "system-config"));
    await store.upsertMcpServer({
      id: "trace-fixture",
      name: "Trace fixture",
      url: `http://127.0.0.1:${address.port}/mcp`,
      transport: "streamable-http",
    });
    let chatRootRecording = false;
    await withRootSpan("chat.turn", { "asa.component": "agent" }, async (span) => {
      chatRootRecording = span.isRecording();
      try {
        const result = await store.callMcpTool("trace-fixture", "trace_probe", {});
        assert.ok(result && typeof result === "object");
      } catch (error) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}; fixtureErrors=${fixtureErrors.join(" | ")}; fixtureResponses=${JSON.stringify(fixtureResponses)}`);
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 25));

    const spans = exporter.getFinishedSpans();
    const chat = spans.find((span) => span.name === "chat.turn");
    const toolCall = spans.find((span) => span.name === "tools/call trace_probe");
    assert.ok(chat, `Agent chat turn is recorded as the trace root; rootRecording=${chatRootRecording}; spans=${spans.map((span) => span.name).join(",")}`);
    assert.ok(toolCall, "MCP tool invocation has a caller span");
    assert.equal(toolCall.kind, SpanKind.CLIENT);
    assert.equal(toolCall.parentSpanContext?.spanId, chat.spanContext().spanId);
    const expectedTraceparent =
      `00-${toolCall.spanContext().traceId}-${toolCall.spanContext().spanId}-${toolCall.spanContext().traceFlags.toString(16).padStart(2, "0")}`;
    assert.equal(remoteHttpTraceparent, expectedTraceparent);
    assert.equal(remoteMetaTraceparent, expectedTraceparent);
    assert.equal(toolCall.attributes["astro.request_id"], "fixture-tools/call");
    assert.equal(spans.some((span) => span.kind === SpanKind.CLIENT && ["POST", "GET"].includes(span.name)), false,
      "MCP fetch instrumentation does not insert a second caller span");
  } finally {
    if (listening) await new Promise<void>((resolve) => httpServer?.close(() => resolve()));
    await transport.close().catch(() => undefined);
    await mcpServer.close().catch(() => undefined);
    await shutdownTelemetry();
    await rm(root, { recursive: true, force: true });
    for (const key of envKeys) {
      const value = previousEnvironment.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
