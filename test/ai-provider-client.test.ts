import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

async function waitForAgentSession(
  service: WorkspaceAgentService,
  id: string,
  ready: (session: Awaited<ReturnType<WorkspaceAgentService["getSession"]>>) => boolean,
): Promise<Awaited<ReturnType<WorkspaceAgentService["getSession"]>>> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const session = await service.getSession(id);
    if (ready(session)) return session;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for Workspace Agent session");
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
  const apiServer = createServer(async (request, response) => {
    await requestBody(request);
    json(response, 200, { servers: [] });
  });
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
  const apiUrl = await listen(apiServer);
  const baseUrl = await listen(server);
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-ai-agent-test-"));
  try {
    const config = {
      getDefaultAiProvider: async () => ({ record: { baseUrl, model: "test-model" }, apiKey: "test-secret" }),
    };
    const service = new WorkspaceAgentService({
      root: directory,
      config: config as never,
      cliPath: fileURLToPath(new URL("../packages/cli/src/index.ts", import.meta.url)),
      cliNodeArgs: ["--import", "tsx"],
      cliBaseUrl: apiUrl,
    });
    const session = await service.createSession();
    await service.sendMessage(session.id, "hello");
    const result = await waitForAgentSession(service, session.id, (current) => current.status !== "running");
    assert.equal(result.messages.at(-1)?.content, "plain fallback works");
    assert.equal(requestBodies.length, 2);
    assert.ok(Array.isArray(requestBodies[0]?.tools));
    assert.equal(requestBodies[1]?.tools, undefined);
    assert.equal(requestBodies[1]?.tool_choice, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await Promise.all([apiServer, server].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  }
});

test("workspace Agent runs CLI reads, confirms writes, and resumes the same tool-call turn", async () => {
  const apiCalls: Array<{ method: string; path: string; body: string }> = [];
  const apiServer = createServer(async (request, response) => {
    const received = await requestBody(request);
    apiCalls.push({ method: request.method ?? "", path: request.url ?? "", body: received });
    json(response, 200, request.method === "GET" ? { assets: [{ id: "asset-1" }] } : { asset: { id: "asset-created" } });
  });
  const llmRequests: Array<Record<string, unknown>> = [];
  const llmServer = createServer(async (request, response) => {
    const payload = JSON.parse(await requestBody(request)) as Record<string, unknown>;
    llmRequests.push(payload);
    if (llmRequests.length === 1) {
      json(response, 200, { choices: [{ message: { role: "assistant", content: null, tool_calls: [
        { id: "call_assets", type: "function", function: { name: "list_data_assets", arguments: "{}" } },
        { id: "call_create", type: "function", function: { name: "workspace_api", arguments: JSON.stringify({ method: "POST", path: "/api/data-assets", body: { name: "Agent asset" } }) } },
      ] } }] });
      return;
    }
    json(response, 200, { choices: [{ message: { role: "assistant", content: "已创建资产。" } }] });
  });
  const apiUrl = await listen(apiServer);
  const llmUrl = await listen(llmServer);
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-ai-agent-cli-test-"));
  try {
    const config = { getDefaultAiProvider: async () => ({ record: { baseUrl: llmUrl, model: "test-model" }, apiKey: "test-secret" }) };
    const cliPath = fileURLToPath(new URL("../packages/cli/src/index.ts", import.meta.url));
    const service = new WorkspaceAgentService({
      root: directory,
      config: config as never,
      cliPath,
      cliNodeArgs: ["--import", "tsx"],
      cliBaseUrl: apiUrl,
    });
    const session = await service.createSession();
    await service.sendMessage(session.id, "查看资产并新建一个");
    const waiting = await waitForAgentSession(service, session.id, (current) => current.status === "waiting_for_confirmation");
    assert.equal(waiting.pendingTool?.name, "workspace_api");
    assert.match(waiting.pendingTool?.reason ?? "", /POST \/api\/data-assets/);
    assert.deepEqual(apiCalls.map(({ method, path }) => [method, path]), [
      ["GET", "/api/system-config/mcp-servers"],
      ["GET", "/api/data-assets"],
    ]);

    await service.confirmTool(session.id, true);
    const completed = await waitForAgentSession(service, session.id, (current) => current.status !== "running" && !current.pendingTool);
    assert.equal(completed.pendingTool, undefined);
    assert.equal(completed.messages.at(-1)?.content, "已创建资产。");
    assert.deepEqual(apiCalls.map(({ method, path }) => [method, path]), [
      ["GET", "/api/system-config/mcp-servers"],
      ["GET", "/api/data-assets"],
      ["POST", "/api/data-assets"],
      ["GET", "/api/system-config/mcp-servers"],
    ]);
    const createCall = apiCalls.find((call) => call.method === "POST" && call.path === "/api/data-assets");
    assert.deepEqual(JSON.parse(createCall?.body ?? "{}"), { name: "Agent asset" });

    const resumedMessages = llmRequests[1]?.messages as Array<Record<string, unknown>>;
    assert.ok(resumedMessages.some((message) => message.tool_call_id === "call_assets"));
    assert.ok(resumedMessages.some((message) => message.tool_call_id === "call_create"));
  } finally {
    await rm(directory, { recursive: true, force: true });
    await Promise.all([apiServer, llmServer].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  }
});

test("workspace Agent reads a registered CSV artifact through the Workspace CLI", async () => {
  const apiCalls: string[] = [];
  const apiServer = createServer(async (request, response) => {
    await requestBody(request);
    apiCalls.push(request.url ?? "");
    if (request.url === "/api/system-config/mcp-servers") {
      json(response, 200, { servers: [] });
      return;
    }
    if (request.url === "/api/workflow-runs/run-1") {
      json(response, 200, { run: { artifacts: [{ name: "crossmatch.csv", mediaType: "text/csv", byteLength: 24 }] } });
      return;
    }
    if (request.url === "/api/workflow-runs/run-1/artifacts/crossmatch.csv") {
      response.writeHead(200, { "content-type": "text/csv; charset=utf-8" });
      response.end("euclid_id,desi_id\ne1,d1\n");
      return;
    }
    json(response, 404, { error: "not found" });
  });
  const llmRequests: Array<Record<string, unknown>> = [];
  const llmServer = createServer(async (request, response) => {
    const payload = JSON.parse(await requestBody(request)) as Record<string, unknown>;
    llmRequests.push(payload);
    if (llmRequests.length === 1) {
      json(response, 200, { choices: [{ message: { role: "assistant", content: null, tool_calls: [
        { id: "call_artifact", type: "function", function: { name: "read_workflow_artifact", arguments: JSON.stringify({ runId: "run-1", name: "crossmatch.csv" }) } },
      ] } }] });
      return;
    }
    json(response, 200, { choices: [{ message: { role: "assistant", content: "CSV 中有 1 行候选。" } }] });
  });
  const apiUrl = await listen(apiServer);
  const llmUrl = await listen(llmServer);
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-ai-agent-artifact-test-"));
  try {
    const config = { getDefaultAiProvider: async () => ({ record: { baseUrl: llmUrl, model: "test-model" }, apiKey: "test-secret" }) };
    const service = new WorkspaceAgentService({
      root: directory,
      config: config as never,
      cliPath: fileURLToPath(new URL("../packages/cli/src/index.ts", import.meta.url)),
      cliNodeArgs: ["--import", "tsx"],
      cliBaseUrl: apiUrl,
    });
    const session = await service.createSession();
    await service.sendMessage(session.id, "查看 run-1 的候选 CSV");
    const completed = await waitForAgentSession(service, session.id, (current) => current.status !== "running");

    assert.equal(completed.messages.at(-1)?.content, "CSV 中有 1 行候选。");
    assert.deepEqual(apiCalls, [
      "/api/system-config/mcp-servers",
      "/api/workflow-runs/run-1",
      "/api/workflow-runs/run-1/artifacts/crossmatch.csv",
    ]);
    const tools = llmRequests[0]?.tools as Array<{ function?: { name?: string } }>;
    assert.ok(tools.some((tool) => tool.function?.name === "read_workflow_artifact"));
    const resumedMessages = llmRequests[1]?.messages as Array<Record<string, unknown>>;
    const artifactMessage = resumedMessages.find((message) => message.tool_call_id === "call_artifact");
    assert.match(String(artifactMessage?.content), /euclid_id,desi_id/);
    assert.match(String(artifactMessage?.content), /truncated/);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await Promise.all([apiServer, llmServer].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  }
});

test("workspace Agent reuses an identical pending Workflow run instead of creating a duplicate", async () => {
  const workflowKey = "euclid-desi-crossmatch@1";
  const input = {
    raDeg: 12,
    decDeg: -2,
    queryRadiusArcsec: 250,
    matchRadiusArcsec: 1.5,
    limit: 500,
    cutoutEnabled: true,
    cutoutSizeDeg: 0.008,
    desiBands: ["g", "r", "i", "z"],
  };
  const apiCalls: Array<{ method: string; url: string }> = [];
  const apiServer = createServer(async (request, response) => {
    await requestBody(request);
    const method = request.method ?? "GET";
    const url = request.url ?? "";
    apiCalls.push({ method, url });
    if (url === "/api/system-config/mcp-servers") {
      json(response, 200, { servers: [] });
      return;
    }
    if (url === `/api/workflow-runs?limit=100&workflowKey=${encodeURIComponent(workflowKey)}`) {
      json(response, 200, { runs: [{ id: "run-pending", workflowKey, status: "waiting_for_input" }] });
      return;
    }
    if (url === "/api/workflow-runs/run-pending") {
      json(response, 200, { run: {
        id: "run-pending", workflowKey, status: "waiting_for_input", input,
        waiting: { reason: "filter", stepId: "human_filter", message: "Researcher review", availableFields: ["separationArcsec"] },
      } });
      return;
    }
    json(response, 404, { error: "not found" });
  });
  const llmRequests: Array<Record<string, unknown>> = [];
  const llmServer = createServer(async (request, response) => {
    const payload = JSON.parse(await requestBody(request)) as Record<string, unknown>;
    llmRequests.push(payload);
    if (llmRequests.length === 1) {
      json(response, 200, { choices: [{ message: { role: "assistant", content: null, tool_calls: [
        { id: "call_create", type: "function", function: { name: "create_workflow_run", arguments: JSON.stringify({ workflowKey, input: { raDeg: 12, decDeg: -2 } }) } },
      ] } }] });
      return;
    }
    json(response, 200, { choices: [{ message: { role: "assistant", content: "已有匹配任务正在等待研究者筛选，没有重复创建。" } }] });
  });
  const apiUrl = await listen(apiServer);
  const llmUrl = await listen(llmServer);
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-ai-agent-workflow-dedupe-test-"));
  try {
    const config = { getDefaultAiProvider: async () => ({ record: { baseUrl: llmUrl, model: "test-model" }, apiKey: "test-secret" }) };
    const service = new WorkspaceAgentService({
      root: directory,
      config: config as never,
      cliPath: fileURLToPath(new URL("../packages/cli/src/index.ts", import.meta.url)),
      cliNodeArgs: ["--import", "tsx"],
      cliBaseUrl: apiUrl,
    });
    const session = await service.createSession();
    await service.sendMessage(session.id, "对 RA 12、Dec -2 进行 Euclid 和 DESI 交叉匹配");
    const confirmation = await waitForAgentSession(service, session.id, (current) => current.status === "waiting_for_confirmation");
    assert.equal(confirmation.pendingTool?.name, "create_workflow_run");

    await service.confirmTool(session.id, true);
    const completed = await waitForAgentSession(service, session.id, (current) => current.status !== "running" && !current.pendingTool);
    assert.equal(completed.messages.at(-1)?.content, "已有匹配任务正在等待研究者筛选，没有重复创建。");
    assert.ok(apiCalls.some(({ url }) => url === `/api/workflow-runs?limit=100&workflowKey=${encodeURIComponent(workflowKey)}`));
    assert.ok(apiCalls.some(({ url }) => url === "/api/workflow-runs/run-pending"));
    assert.equal(apiCalls.filter(({ method, url }) => method === "POST" && url === "/api/workflow-runs").length, 0);
    const resumedMessages = llmRequests[1]?.messages as Array<Record<string, unknown>>;
    const createdMessage = resumedMessages.find((message) => message.tool_call_id === "call_create");
    assert.match(String(createdMessage?.content), /"reused":true/);
    assert.match(String(createdMessage?.content), /"waiting_for_input"/);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await Promise.all([apiServer, llmServer].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  }
});

test("workspace_api cannot bypass Workflow deduplication or submit researcher decisions", async () => {
  const attempts = [
    {
      id: "call_create_bypass",
      args: {
        method: "POST",
        path: "/api/workflow-runs",
        body: { workflowId: "euclid-desi-crossmatch@1", input: { raDeg: 12, decDeg: -2 } },
      },
      error: /create_workflow_run after its duplicate check/,
    },
    {
      id: "call_decision_bypass",
      args: {
        method: "POST",
        path: "/api/workflow-runs/run-pending/%64ecisions",
        body: { action: "accept_all" },
      },
      error: /submitted by the researcher/,
    },
  ];
  const apiCalls: Array<{ method: string; url: string }> = [];
  const apiServer = createServer(async (request, response) => {
    await requestBody(request);
    const method = request.method ?? "";
    const url = request.url ?? "";
    apiCalls.push({ method, url });
    if (url === "/api/system-config/mcp-servers") {
      json(response, 200, { servers: [] });
      return;
    }
    json(response, 200, { accepted: true });
  });
  const llmRequests: Array<Record<string, unknown>> = [];
  const llmServer = createServer(async (request, response) => {
    const payload = JSON.parse(await requestBody(request)) as Record<string, unknown>;
    llmRequests.push(payload);
    const requestIndex = llmRequests.length - 1;
    if (requestIndex % 2 === 0) {
      const attempt = attempts[requestIndex / 2];
      assert.ok(attempt);
      json(response, 200, { choices: [{ message: { role: "assistant", content: null, tool_calls: [
        { id: attempt.id, type: "function", function: { name: "workspace_api", arguments: JSON.stringify(attempt.args) } },
      ] } }] });
      return;
    }
    json(response, 200, { choices: [{ message: { role: "assistant", content: "Workflow 操作未执行。" } }] });
  });
  const apiUrl = await listen(apiServer);
  const llmUrl = await listen(llmServer);
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-ai-agent-workflow-boundary-test-"));
  try {
    const config = { getDefaultAiProvider: async () => ({ record: { baseUrl: llmUrl, model: "test-model" }, apiKey: "test-secret" }) };
    const service = new WorkspaceAgentService({
      root: directory,
      config: config as never,
      cliPath: fileURLToPath(new URL("../packages/cli/src/index.ts", import.meta.url)),
      cliNodeArgs: ["--import", "tsx"],
      cliBaseUrl: apiUrl,
    });
    const session = await service.createSession();

    for (const [index, attempt] of attempts.entries()) {
      await service.sendMessage(session.id, `尝试执行被限制的 Workflow API 操作 ${index + 1}`);
      const waiting = await waitForAgentSession(service, session.id, (current) => current.status === "waiting_for_confirmation");
      assert.equal(waiting.pendingTool?.name, "workspace_api");
      await service.confirmTool(session.id, true);
      const completed = await waitForAgentSession(service, session.id, (current) => current.status === "idle");
      assert.equal(completed.messages.at(-1)?.content, "Workflow 操作未执行。");

      const continuation = llmRequests[index * 2 + 1]?.messages as Array<Record<string, unknown>>;
      const toolMessage = continuation.find((message) => message.tool_call_id === attempt.id);
      const result = JSON.parse(String(toolMessage?.content)) as { error?: string };
      assert.match(result.error ?? "", attempt.error);
    }

    assert.deepEqual(apiCalls, Array.from({ length: 4 }, () => ({ method: "GET", url: "/api/system-config/mcp-servers" })));
  } finally {
    await rm(directory, { recursive: true, force: true });
    await Promise.all([apiServer, llmServer].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  }
});

test("workspace Agent creates a Workflow run only through its deduplicating tool", async () => {
  const workflowKey = "euclid-desi-crossmatch@1";
  const apiCalls: Array<{ method: string; url: string; body: string }> = [];
  const apiServer = createServer(async (request, response) => {
    const body = await requestBody(request);
    const method = request.method ?? "";
    const url = request.url ?? "";
    apiCalls.push({ method, url, body });
    if (url === "/api/system-config/mcp-servers") {
      json(response, 200, { servers: [] });
      return;
    }
    if (url === `/api/workflow-runs?limit=100&workflowKey=${encodeURIComponent(workflowKey)}`) {
      json(response, 200, { runs: [] });
      return;
    }
    if (method === "POST" && url === "/api/workflow-runs") {
      json(response, 202, { run: { id: "run-created", workflowKey, status: "queued" } });
      return;
    }
    json(response, 404, { error: "not found" });
  });
  const llmRequests: Array<Record<string, unknown>> = [];
  const llmServer = createServer(async (request, response) => {
    const payload = JSON.parse(await requestBody(request)) as Record<string, unknown>;
    llmRequests.push(payload);
    if (llmRequests.length === 1) {
      json(response, 200, { choices: [{ message: { role: "assistant", content: null, tool_calls: [
        { id: "call_create_deduped", type: "function", function: { name: "create_workflow_run", arguments: JSON.stringify({ workflowKey, input: { raDeg: 12, decDeg: -2 } }) } },
      ] } }] });
      return;
    }
    json(response, 200, { choices: [{ message: { role: "assistant", content: "已创建 run-created。" } }] });
  });
  const apiUrl = await listen(apiServer);
  const llmUrl = await listen(llmServer);
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-ai-agent-workflow-create-test-"));
  try {
    const config = { getDefaultAiProvider: async () => ({ record: { baseUrl: llmUrl, model: "test-model" }, apiKey: "test-secret" }) };
    const service = new WorkspaceAgentService({
      root: directory,
      config: config as never,
      cliPath: fileURLToPath(new URL("../packages/cli/src/index.ts", import.meta.url)),
      cliNodeArgs: ["--import", "tsx"],
      cliBaseUrl: apiUrl,
    });
    const session = await service.createSession();
    await service.sendMessage(session.id, "对 RA 12、Dec -2 进行 Euclid 和 DESI 交叉匹配");
    const waiting = await waitForAgentSession(service, session.id, (current) => current.status === "waiting_for_confirmation");
    assert.equal(waiting.pendingTool?.name, "create_workflow_run");
    await service.confirmTool(session.id, true);
    const completed = await waitForAgentSession(service, session.id, (current) => current.status === "idle");
    assert.equal(completed.messages.at(-1)?.content, "已创建 run-created。");
    assert.deepEqual(apiCalls.map(({ method, url }) => [method, url]), [
      ["GET", "/api/system-config/mcp-servers"],
      ["GET", `/api/workflow-runs?limit=100&workflowKey=${encodeURIComponent(workflowKey)}`],
      ["POST", "/api/workflow-runs"],
      ["GET", "/api/system-config/mcp-servers"],
    ]);
    assert.deepEqual(JSON.parse(apiCalls[2]?.body ?? "{}"), {
      workflowId: workflowKey,
      input: {
        raDeg: 12,
        decDeg: -2,
        queryRadiusArcsec: 250,
        matchRadiusArcsec: 1.5,
        cutoutEnabled: true,
        cutoutSizeDeg: 0.008,
        desiBands: ["g", "r", "i", "z"],
      },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
    await Promise.all([apiServer, llmServer].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
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
