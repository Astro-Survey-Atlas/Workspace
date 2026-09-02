import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  aiProviderChatEndpoint,
  requestAiProviderCompletion,
} from "../src/ai-provider-client.js";
import { SystemConfigStore } from "../src/system-config.js";
import { WorkspaceAgentService } from "../src/workspace-agent.js";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind to a TCP port");
  return `http://127.0.0.1:${address.port}`;
}

async function requestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) });
  response.end(body);
}

test("resolves provider roots and full completion endpoints without duplicate paths", () => {
  assert.equal(aiProviderChatEndpoint("https://token.72602.space"), "https://token.72602.space/v1/chat/completions");
  assert.equal(aiProviderChatEndpoint("https://token.72602.space/v1/"), "https://token.72602.space/v1/chat/completions");
  assert.equal(aiProviderChatEndpoint("https://token.72602.space/custom/chat/completions"), "https://token.72602.space/custom/chat/completions");
});

test("provider test requires a JSON chat response instead of accepting HTML 200", async () => {
  const paths: string[] = [];
  const server = createServer((request, response) => {
    paths.push(request.url ?? "");
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><html><body>web app</body></html>");
  });
  const baseUrl = await listen(server);
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-ai-provider-test-"));
  try {
    const store = new SystemConfigStore(path.join(directory, "system-config"));
    const provider = await store.upsertAiProvider({ name: "HTML provider", baseUrl, model: "test-model", apiKey: "test-secret" });
    const checked = await store.testAiProvider(provider.id);
    assert.equal(checked.lastCheck?.status, "failed");
    assert.match(checked.lastCheck?.detail ?? "", /non-JSON|HTML/i);
    assert.deepEqual(paths, ["/v1/chat/completions"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("workspace Agent retries as plain chat when tools are rejected", async () => {
  const requestBodies: Array<Record<string, unknown>> = [];
  const server = createServer(async (request, response) => {
    const body = JSON.parse(await requestBody(request)) as Record<string, unknown>;
    requestBodies.push(body);
    if (requestBodies.length === 1) {
      json(response, 400, { error: { message: "tools are not supported by this model" } });
      return;
    }
    json(response, 200, { choices: [{ message: { role: "assistant", content: "plain fallback works" } }] });
  });
  const baseUrl = await listen(server);
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-ai-agent-test-"));
  try {
    const config = {
      getDefaultAiProvider: async () => ({ record: { baseUrl, model: "test-model" }, apiKey: "test-secret" }),
    };
    const emptyCatalog = { list: async () => [] };
    const emptyConnectors = { list: async () => [] };
    const emptyProduction = { listRuns: async () => [], submit: async () => ({}) };
    const service = new WorkspaceAgentService({
      root: directory,
      config: config as never,
      dataCatalog: emptyCatalog as never,
      connectors: emptyConnectors as never,
      production: emptyProduction as never,
    });
    const session = await service.createSession();
    const result = await service.sendMessage(session.id, "hello");
    assert.equal(result.messages.at(-1)?.content, "plain fallback works");
    assert.equal(requestBodies.length, 2);
    assert.ok(Array.isArray(requestBodies[0]?.tools));
    assert.equal(requestBodies[1]?.tools, undefined);
    assert.equal(requestBodies[1]?.tool_choice, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("completion helper reports non-JSON responses with endpoint context", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>login</title>");
  });
  const baseUrl = await listen(server);
  try {
    await assert.rejects(
      () => requestAiProviderCompletion({ baseUrl, model: "test-model", messages: [{ role: "user", content: "hello" }] }),
      /non-JSON.*HTTP 200.*text\/html/i,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
