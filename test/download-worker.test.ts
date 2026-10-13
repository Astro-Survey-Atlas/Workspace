import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { DownloadWorker } from "../src/download-worker.js";
import { DownloadWorkerClient } from "../src/download-worker-client.js";
import { SystemConfigStore } from "../src/system-config.js";
import { CoverageDownloadService, type CoverageDownloadJob } from "../src/coverage-downloads.js";

test("Workspace reconnects an active durable download through a worker outage and registers once", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "astro-worker-reattach-"));
  const saved: CoverageDownloadJob = { id: "coverage-download-fixture", status: "running", phase: "downloading", engine: "aria2", files: [],
    transfer: [{ url: "https://public.example/file", name: "file", relativePath: "file", status: "partial", bytesPresent: 80, expectedSizeBytes: 100, gid: "1111111111111111" }],
    downloadedFiles: 0, totalFiles: 1, downloadedBytes: 80, totalBytes: 100, requestKey: "fixture-request", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
  let gets = 0, puts = 0, registrations = 0;
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, "Bearer fixture-worker-token-for-test-only");
    if (request.method === "PUT") { for await (const _chunk of request) { /* consume JSON */ } puts++; }
    else if (++gets === 1) { response.writeHead(503, { "Content-Type": "application/json" }); response.end(JSON.stringify({ error: "fixture outage" })); return; }
    const done = gets >= 2;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ id: saved.id, status: done ? "completed" : "running", phase: done ? "completed" : "downloading", updatedAt: new Date().toISOString(),
      transfer: [{ ...saved.transfer[0], status: done ? "verified" : "partial", bytesPresent: done ? 100 : 80, actualSizeBytes: done ? 100 : undefined }] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  try {
    await writeFile(path.join(root, "jobs.json"), JSON.stringify({ schemaVersion: 2, jobs: [saved] }));
    const worker = new DownloadWorkerClient(`http://127.0.0.1:${address.port}`, "fixture-worker-token-for-test-only", async () => ({ enabled: false, url: "", revision: "fixture" }));
    const service = new CoverageDownloadService({ root, worker, registerConnector: async input => { registrations++; return { id: "fixture-connector", ...input } as import("../src/connectors.js").ConnectorRecord; } });
    await service.initialize();
    const completed = await until(() => service.get(saved.id), job => job.status === "completed");
    assert.equal(completed.id, saved.id); assert.equal(completed.downloadedBytes, 100); assert.equal(completed.outputConnectorId, "fixture-connector");
    assert.equal(registrations, 1); assert.equal(puts, 2);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});

test("download proxy settings survive reopening and credentials never enter the public view", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "astro-proxy-settings-"));
  try {
    const store = new SystemConfigStore(root);
    const saved = await store.saveDownloadSettings({ proxyEnabled: true, proxyUrl: "http://10.15.49.212:7890", proxyUsername: "fixture", proxyPassword: "fixture-password" });
    assert.equal(saved.passwordConfigured, true); assert.equal(JSON.stringify(saved).includes("fixture-password"), false);
    assert.equal((await new SystemConfigStore(root).downloadProxy()).password, "fixture-password");
    await store.saveDownloadSettings({ proxyEnabled: true, proxyUrl: saved.proxyUrl, proxyUsername: "fixture" });
    assert.equal((await store.downloadProxy()).password, "fixture-password");
    await store.saveDownloadSettings({ proxyEnabled: false, proxyUrl: "", proxyPassword: null });
    assert.equal((await store.getDownloadSettings()).passwordConfigured, false);
    await assert.rejects(store.saveDownloadSettings({ proxyEnabled: true, proxyUrl: "socks5://10.15.49.212:7890" }), /HTTP/);
    await assert.rejects(store.saveDownloadSettings({ proxyEnabled: true, proxyUrl: "http://user:password@10.15.49.212:7890" }), /认证/);
    await assert.rejects(store.saveDownloadSettings(null!), /object/);
    await assert.rejects(store.saveDownloadSettings({ proxyEnabled: false, proxyUrl: "", proxyUsername: 1 as never }), /proxyUsername/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("real aria2 retries a temporary source failure instead of ending the job", { skip: !process.env.ASTRO_ARIA2_BINARY, timeout: 45_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "astro-aria2-transient-"));
  const token = "fixture-worker-token-for-test-only", data = Buffer.alloc(131_072, 0x46);
  let failures = 0;
  const fetchImpl: typeof fetch = async (_input, init) => {
    const requested = new Headers(init?.headers).get("range");
    // Heartbeats do not consume the download's transient failure.
    if (init?.method !== "HEAD" && requested !== "bytes=0-0" && failures++ === 0) return new Response("overloaded", { status: 503 });
    const range = /^bytes=(\d+)-(\d*)$/.exec(requested ?? ""), from = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Math.min(data.length - 1, Number(range[2])) : data.length - 1;
    return new Response(init?.method === "HEAD" ? null : data.subarray(from, end + 1), { status: range ? 206 : 200,
      headers: { "Content-Length": String(end - from + 1), "Content-Type": "application/octet-stream", ETag: '"fixture-v1"',
        ...(range ? { "Content-Range": `bytes ${from}-${end}/${data.length}` } : {}) } });
  };
  const worker = new DownloadWorker(root, token, await port(), await port(), { fetchImpl, resolveHostname: async () => ["93.184.216.34"] });
  const client = new DownloadWorkerClient(`http://127.0.0.1:${worker.port}`, token, async () => ({ enabled: false, url: "", revision: "fixture" }));
  try {
    await worker.initialize();
    await client.submit("transient-job", path.join(root, "files"), [{ url: "https://public.example/fixture.fits", name: "fixture.fits", relativePath: "fixture.fits",
      status: "pending", bytesPresent: 0, expectedSizeBytes: data.length, expectedSha256: createHash("sha256").update(data).digest("hex") }]);
    const failedAttempt = await until(() => client.get("transient-job"), job => Boolean(job.transfer[0]!.lastErrorCode));
    assert.equal(failedAttempt.status, "running", "a source 503 must remain recoverable");
    assert.equal(failedAttempt.transfer[0]!.lastErrorCode, "SOURCE_HTTP_503");
    const completed = await until(() => client.get("transient-job"), job => job.status === "completed");
    assert.equal(completed.transfer[0]!.retryCount, 1);
    assert.equal(completed.transfer[0]!.lastErrorCode, undefined);
    assert.equal(completed.transfer[0]!.actualSha256, createHash("sha256").update(data).digest("hex"));
  } finally { await worker.close(); await rm(root, { recursive: true, force: true }); }
});

async function port(): Promise<number> {
  const server = createServer(); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const result = address.port; await new Promise<void>(resolve => server.close(() => resolve())); return result;
}

async function until<T>(get: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 35_000;
  while (Date.now() < deadline) { const value = await get(); if (ready(value)) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error("download fixture timed out");
}

test("real aria2 resumes legacy partial bytes, persists pause through restart and verifies the final hash", { skip: !process.env.ASTRO_ARIA2_BINARY, timeout: 50_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "astro-aria2-resume-"));
  const token = "fixture-worker-token-for-test-only";
  const data = Buffer.alloc(8_388_608, 0x46), ranges: number[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    const requested = new Headers(init?.headers).get("range"), match = /^bytes=(\d+)-(\d*)$/.exec(requested ?? "");
    const from = match ? Number(match[1]) : 0, end = match?.[2] ? Math.min(data.length - 1, Number(match[2])) : data.length - 1;
    if (from > 0) ranges.push(from);
    let at = from, cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise(resolve => setTimeout(resolve, 20)); if (cancelled) return;
        if (init?.signal?.aborted) { controller.error(new Error("fixture interrupted")); return; }
        if (at > end) { controller.close(); return; }
        const next = Math.min(end + 1, at + 16_384); controller.enqueue(data.subarray(at, next)); at = next;
      }, cancel() { cancelled = true; },
    });
    return new Response(init?.method === "HEAD" ? null : stream, { status: match ? 206 : 200,
      headers: { "Content-Length": String(end - from + 1), "Content-Type": "application/octet-stream", "Accept-Ranges": "bytes", ETag: '"fixture-v1"',
        ...(match ? { "Content-Range": `bytes ${from}-${end}/${data.length}` } : {}) } });
  };
  const transport = { fetchImpl, resolveHostname: async () => ["93.184.216.34"] };
  const workerPort = await port(), rpcPort = await port();
  let worker = new DownloadWorker(root, token, workerPort, rpcPort, transport);
  const proxy = { enabled: false, url: "", revision: "fixture" };
  const client = new DownloadWorkerClient(`http://127.0.0.1:${workerPort}`, token, async () => proxy);
  try {
    await mkdir(path.join(root, "files")); await writeFile(path.join(root, "files", "fixture.fits.part"), data.subarray(0, 524_288));
    await worker.initialize();
    await client.submit("fixture-job", path.join(root, "files"), [{ url: "https://public.example/fixture.fits", name: "fixture.fits", relativePath: "fixture.fits",
      status: "partial", bytesPresent: 524_288, expectedSizeBytes: data.length, expectedSha256: createHash("sha256").update(data).digest("hex"), etag: '"fixture-v1"' }]);
    await until(() => client.get("fixture-job"), job => job.transfer[0]!.bytesPresent > 1_048_576);
    await client.action("fixture-job", "pause");
    await worker.close();
    worker = new DownloadWorker(root, token, workerPort, rpcPort, transport); await worker.initialize();
    const paused = await client.get("fixture-job"); assert.equal(paused.phase, "paused");
    await new Promise(resolve => setTimeout(resolve, 500)); assert.equal((await client.get("fixture-job")).transfer[0]!.bytesPresent, paused.transfer[0]!.bytesPresent);
    await client.action("fixture-job", "resume");
    const completed = await until(() => client.get("fixture-job"), job => job.status === "completed");
    assert.equal(completed.transfer[0]!.actualSha256, createHash("sha256").update(data).digest("hex"));
    assert.deepEqual(await readFile(path.join(root, "files", "fixture.fits")), data);
    assert.ok(ranges.includes(524_288), "first request must retain the existing prefix");
    const forbidden = await fetch(`http://127.0.0.1:${workerPort}/jobs/private-job`, { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ config: proxy, directory: path.join(root, "files"), transfer: [{ url: "http://127.0.0.1/private", name: "bad", relativePath: "bad" }] }) });
    assert.equal(forbidden.status, 400);
  } finally { await worker.close(); await rm(root, { recursive: true, force: true }); }
});
