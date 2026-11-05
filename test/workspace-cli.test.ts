import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { resolveWorkspaceCli } from "../src/workspace-cli.js";

test("resolves the Workspace CLI for source, compiled, Docker, and desktop layouts", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "asa-workspace-cli-layout-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const repository = path.join(root, "repository");
  const compiledRepoEntry = path.join(repository, "packages/cli/dist/index.js");
  await mkdir(path.dirname(compiledRepoEntry), { recursive: true });
  await writeFile(compiledRepoEntry, "");
  assert.deepEqual(resolveWorkspaceCli(path.join(repository, "dist"), "production"), {
    entryPath: compiledRepoEntry,
    nodeArgs: [],
  });

  const dockerRoot = path.join(root, "docker-app");
  const dockerEntry = path.join(dockerRoot, "packages/cli/dist/index.js");
  await mkdir(path.dirname(dockerEntry), { recursive: true });
  await writeFile(dockerEntry, "");
  assert.deepEqual(resolveWorkspaceCli(dockerRoot, "production"), {
    entryPath: dockerEntry,
    nodeArgs: [],
  });

  const desktopRoot = path.join(root, "resources");
  const desktopEntry = path.join(desktopRoot, "packages/cli/dist/index.js");
  await mkdir(path.dirname(desktopEntry), { recursive: true });
  await writeFile(desktopEntry, "");
  assert.deepEqual(resolveWorkspaceCli(desktopRoot, "production"), { entryPath: desktopEntry, nodeArgs: [] });

  const sourceRoot = path.join(root, "source");
  const sourceEntry = path.join(sourceRoot, "packages/cli/src/index.ts");
  await mkdir(path.dirname(sourceEntry), { recursive: true });
  await writeFile(sourceEntry, "");
  assert.deepEqual(resolveWorkspaceCli(sourceRoot, "development"), {
    entryPath: sourceEntry,
    nodeArgs: ["--import", "tsx"],
  });
  assert.deepEqual(resolveWorkspaceCli(sourceRoot, "production"), {
    entryPath: path.join(sourceRoot, "packages/cli/dist/index.js"),
    nodeArgs: [],
  });
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server did not bind to TCP");
  return `http://127.0.0.1:${address.port}`;
}

async function body(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function cli(baseUrl: string, args: string[], input?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const entry = fileURLToPath(new URL("../packages/cli/src/index.ts", import.meta.url));
  const child = spawn(process.execPath, ["--import", "tsx", entry, "--json", "--base-url", baseUrl, ...args], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  child.stdin.end(input);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
    const timeout = setTimeout(() => child.kill("SIGTERM"), 10_000);
    child.once("close", () => clearTimeout(timeout));
  });
  return { code, stdout, stderr };
}

test("Workspace CLI calls arbitrary Workspace API routes with JSON stdin and file output", async (t) => {
  const calls: Array<{ method: string; url: string; body: string }> = [];
  const server = createServer(async (request, response) => {
    const received = await body(request);
    calls.push({ method: request.method ?? "", url: request.url ?? "", body: received.toString("utf8") });
    if (request.url === "/api/test/assets") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ assets: [{ id: "asset-1" }] }));
      return;
    }
    if (request.url === "/api/test/export") {
      response.writeHead(200, { "content-type": "text/csv" });
      response.end("id,value\n1,ok\n");
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ method: request.method, payload: received.length ? JSON.parse(received.toString("utf8")) : null }));
  });
  const baseUrl = await listen(server);
  const directory = await mkdtemp(path.join(os.tmpdir(), "asa-workspace-cli-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const listed = await cli(baseUrl, ["api", "--path", "/api/test/assets"]);
  assert.equal(listed.code, 0, listed.stderr);
  assert.deepEqual(JSON.parse(listed.stdout), { assets: [{ id: "asset-1" }] });

  const posted = await cli(baseUrl, ["api", "--method", "POST", "--path", "/api/test/echo", "--input", "-"], JSON.stringify({ runId: "run-1" }));
  assert.equal(posted.code, 0, posted.stderr);
  assert.deepEqual(JSON.parse(posted.stdout), { method: "POST", payload: { runId: "run-1" } });

  const updated = await cli(baseUrl, ["api", "--method", "PUT", "--path", "/api/test/assets/asset-1", "--input", "-"], JSON.stringify({ name: "renamed" }));
  assert.equal(updated.code, 0, updated.stderr);
  assert.deepEqual(JSON.parse(updated.stdout), { method: "PUT", payload: { name: "renamed" } });

  const patched = await cli(baseUrl, ["api", "--method", "PATCH", "--path", "/api/test/assets/asset-1", "--input", "-"], JSON.stringify({ description: "updated" }));
  assert.equal(patched.code, 0, patched.stderr);
  assert.deepEqual(JSON.parse(patched.stdout), { method: "PATCH", payload: { description: "updated" } });

  const approved = await cli(baseUrl, ["api", "--method", "POST", "--path", "/api/production-runs/run-1/approve", "--input", "-"], JSON.stringify({ planSha256: "a".repeat(64) }));
  assert.equal(approved.code, 0, approved.stderr);
  assert.deepEqual(JSON.parse(approved.stdout), { method: "POST", payload: { planSha256: "a".repeat(64) } });

  const canceled = await cli(baseUrl, ["api", "--method", "DELETE", "--path", "/api/test/tasks/task-1"]);
  assert.equal(canceled.code, 0, canceled.stderr);
  assert.deepEqual(JSON.parse(canceled.stdout), { method: "DELETE", payload: null });

  const output = path.join(directory, "export.csv");
  const downloaded = await cli(baseUrl, ["api", "--path", "/api/test/export", "--output", output]);
  assert.equal(downloaded.code, 0, downloaded.stderr);
  assert.deepEqual(JSON.parse(downloaded.stdout), { status: 200, output, byteLength: 14, contentType: "text/csv" });
  assert.equal(await readFile(output, "utf8"), "id,value\n1,ok\n");
  assert.deepEqual(calls.map((call) => call.method), ["GET", "POST", "PUT", "PATCH", "POST", "DELETE", "GET"]);
  assert.equal(calls[1]?.body, JSON.stringify({ runId: "run-1" }));
});

test("Workspace CLI refuses routes outside the Workspace API", async () => {
  const result = await cli("http://127.0.0.1:1", ["api", "--path", "http://example.com/api/test"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Workspace \/api\/\.\.\./);
});

test("Workspace CLI runs versioned workflows, submits decisions, and saves artifacts without overwriting", async (t) => {
  const calls: Array<{ method: string; url: string; body: string }> = [];
  const server = createServer(async (request, response) => {
    const received = await body(request);
    calls.push({ method: request.method ?? "", url: request.url ?? "", body: received.toString("utf8") });
    if (request.url === "/api/workflows") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ workflows: [{ key: "euclid-desi-crossmatch@1" }] }));
      return;
    }
    if (request.url === "/api/workflows/euclid-desi-crossmatch%401") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ workflow: { key: "euclid-desi-crossmatch@1" } }));
      return;
    }
    if (request.url === "/api/workflow-runs/run-1/artifacts/crossmatch.csv") {
      response.writeHead(200, { "content-type": "text/csv" });
      response.end("euclid_id,desi_id\ne1,d1\n");
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ method: request.method, payload: received.length ? JSON.parse(received.toString("utf8")) : null }));
  });
  const baseUrl = await listen(server);
  const directory = await mkdtemp(path.join(os.tmpdir(), "asa-workspace-workflow-cli-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const listed = await cli(baseUrl, ["workflows", "list"]);
  assert.equal(listed.code, 0, listed.stderr);
  assert.deepEqual(JSON.parse(listed.stdout), [{ key: "euclid-desi-crossmatch@1" }]);

  const definition = await cli(baseUrl, ["workflows", "get", "euclid-desi-crossmatch@1"]);
  assert.equal(definition.code, 0, definition.stderr);
  assert.deepEqual(JSON.parse(definition.stdout), { key: "euclid-desi-crossmatch@1" });

  const runs = await cli(baseUrl, ["workflows", "runs", "--limit", "100", "--workflow-key", "euclid-desi-crossmatch@1"]);
  assert.equal(runs.code, 0, runs.stderr);
  assert.deepEqual(JSON.parse(runs.stdout), { method: "GET", payload: null });

  const input = { raDeg: 12.5, decDeg: -3.25, queryRadiusArcsec: 250 };
  const created = await cli(baseUrl, ["workflows", "run", "euclid-desi-crossmatch@1", "--data", JSON.stringify(input)]);
  assert.equal(created.code, 0, created.stderr);
  assert.deepEqual(JSON.parse(created.stdout), { method: "POST", payload: { workflowId: "euclid-desi-crossmatch@1", input } });

  const run = await cli(baseUrl, ["workflows", "run-get", "run-1"]);
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { method: "GET", payload: null });

  const decision = { action: "accept_all", selectedRowIds: ["match-1"] };
  const decided = await cli(baseUrl, ["workflows", "decide", "run-1", "--input", "-"], JSON.stringify(decision));
  assert.equal(decided.code, 0, decided.stderr);
  assert.deepEqual(JSON.parse(decided.stdout), { method: "POST", payload: decision });

  const output = path.join(directory, "crossmatch.csv");
  const downloaded = await cli(baseUrl, ["workflows", "artifact", "run-1", "crossmatch.csv", "--output", output]);
  assert.equal(downloaded.code, 0, downloaded.stderr);
  assert.deepEqual(JSON.parse(downloaded.stdout), { status: 200, output, byteLength: 24, contentType: "text/csv" });
  assert.equal(await readFile(output, "utf8"), "euclid_id,desi_id\ne1,d1\n");

  const duplicateDownload = await cli(baseUrl, ["workflows", "artifact", "run-1", "crossmatch.csv", "--output", output]);
  assert.equal(duplicateDownload.code, 1);
  assert.match(duplicateDownload.stderr, /EEXIST/);
  assert.deepEqual(calls.map(({ method, url }) => [method, url]), [
    ["GET", "/api/workflows"],
    ["GET", "/api/workflows/euclid-desi-crossmatch%401"],
    ["GET", "/api/workflow-runs?limit=100&workflowKey=euclid-desi-crossmatch%401"],
    ["POST", "/api/workflow-runs"],
    ["GET", "/api/workflow-runs/run-1"],
    ["POST", "/api/workflow-runs/run-1/decisions"],
    ["GET", "/api/workflow-runs/run-1/artifacts/crossmatch.csv"],
    ["GET", "/api/workflow-runs/run-1/artifacts/crossmatch.csv"],
  ]);
  assert.deepEqual(JSON.parse(calls[3]!.body), { workflowId: "euclid-desi-crossmatch@1", input });
  assert.deepEqual(JSON.parse(calls[5]!.body), decision);
});

test("Workspace CLI reads bounded text artifacts and rejects binary content", async (t) => {
  const server = createServer((request, response) => {
    if (request.url === "/api/workflow-runs/run-1/artifacts/crossmatch.csv") {
      response.writeHead(200, { "content-type": "text/csv; charset=utf-8" });
      response.end("euclid_id,desi_id\ne1,d1\n");
      return;
    }
    response.writeHead(200, { "content-type": "application/fits" });
    response.end(Buffer.from([0, 255, 1, 2]));
  });
  const baseUrl = await listen(server);
  t.after(async () => new Promise<void>((resolve) => server.close(() => resolve())));

  const complete = await cli(baseUrl, ["workflows", "artifact-read", "run-1", "crossmatch.csv", "--max-bytes", "64"]);
  assert.equal(complete.code, 0, complete.stderr);
  assert.deepEqual(JSON.parse(complete.stdout), {
    status: 200,
    contentType: "text/csv; charset=utf-8",
    byteLength: 24,
    truncated: false,
    text: "euclid_id,desi_id\ne1,d1\n",
  });

  const truncated = await cli(baseUrl, ["workflows", "artifact-read", "run-1", "crossmatch.csv", "--max-bytes", "12"]);
  assert.equal(truncated.code, 0, truncated.stderr);
  assert.deepEqual(JSON.parse(truncated.stdout), {
    status: 200,
    contentType: "text/csv; charset=utf-8",
    byteLength: 12,
    truncated: true,
    text: "euclid_id,de",
  });

  const binary = await cli(baseUrl, ["workflows", "artifact-read", "run-1", "cutout.fits"]);
  assert.equal(binary.code, 1);
  assert.match(binary.stderr, /artifact is not text or JSON/);
});
