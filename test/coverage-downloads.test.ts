import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CoverageDownloadService } from "../src/coverage-downloads.js";
import type { ConnectorRecord } from "../src/connectors.js";

async function waitForTerminal(service: CoverageDownloadService, id: string): Promise<Awaited<ReturnType<CoverageDownloadService["get"]>>> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const job = await service.get(id);
    if (["completed", "partial", "failed", "cancelled"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for coverage download");
}

test("a FITS source returning an HTML page or a changed object does not complete a science download", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-science-response-"));
  try {
    for (const [suffix, headers, error] of [
      ["html", { "content-type": "text/html" }, /未返回科学 FITS 文件/],
      ["changed", { "content-type": "application/octet-stream", etag: '"new"' }, /源文件版本已变化/],
    ] as const) {
      let registered = false;
      const service = new CoverageDownloadService({ root: path.join(directory, suffix),
        fetchImpl: async () => new Response("not a science file", { headers }),
        registerConnector: async () => { registered = true; return { id: "bad" } as never; } });
      const job = await service.submit({ files: [{ url: "https://example.test/data.fits", name: "data.fits", etag: '"old"' }] });
      const result = await waitForTerminal(service, job.id);
      assert.equal(result.status, "failed");
      assert.match(result.error ?? "", error);
      assert.equal(registered, false);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("chunked downloads retain confirmed source identity and do not infer a zero byte file", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-chunked-download-"));
  try {
    const service = new CoverageDownloadService({ root: directory,
      fetchImpl: async () => new Response("science bytes", { headers: { "content-type": "application/octet-stream" } }) });
    const job = await service.submit({ files: [{ url: "https://example.test/data.fits", name: "data.fits", sourceId: "public-source", unitId: "native-unit" }] });
    const result = await waitForTerminal(service, job.id);
    assert.equal(result.status, "completed");
    assert.equal(result.downloadedBytes, 13);
    assert.equal(result.files[0]?.sourceId, "public-source");
    const reopened = new CoverageDownloadService({ root: directory });
    assert.equal((await reopened.get(job.id)).files[0]?.unitId, "native-unit");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

function registeredConnector(input: { config: Record<string, string> }): ConnectorRecord {
  const now = new Date().toISOString();
  return {
    id: "connector-downloaded",
    locationKey: `local://${input.config.rootPath}`,
    displayPath: input.config.rootPath!,
    name: "Downloaded coverage",
    description: "test",
    kind: "local",
    config: input.config,
    status: "ready",
    createdAt: now,
    updatedAt: now,
    origin: "user",
  };
}

test("downloads files, verifies checksums, and registers a local Connector", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-coverage-download-"));
  try {
    const bytes = Buffer.from("coverage-fixture\n");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const registrations: string[] = [];
    const service = new CoverageDownloadService({
      root: path.join(directory, "downloads"),
      statePath: path.join(directory, "jobs.json"),
      fetchImpl: async () => new Response(bytes, { status: 200, headers: { "content-length": String(bytes.length) } }),
      registerConnector: async (input) => {
        registrations.push(input.config.rootPath!);
        return registeredConnector(input);
      },
    });
    const submitted = await service.submit({ files: [{ url: "https://example.test/file.csv", name: "file.csv", sizeBytes: bytes.length, sha256 }] });
    const completed = await waitForTerminal(service, submitted.id);
    assert.equal(completed.status, "completed");
    assert.equal(completed.outputConnectorId, "connector-downloaded");
    assert.equal(completed.downloadedFiles, 1);
    assert.equal(registrations.length, 1);
    assert.equal(await readFile(path.join(completed.outputPath!, "file.csv"), "utf8"), bytes.toString("utf8"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("skips failed files, keeps verified files, and marks a mixed download partial", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-coverage-download-partial-"));
  try {
    const verified = Buffer.from("verified science file");
    let registered = false;
    const service = new CoverageDownloadService({
      root: path.join(directory, "downloads"),
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.endsWith("/missing.fits")) return new Response("", { status: 404 });
        if (url.endsWith("/bad-checksum.fits")) return new Response("incorrect", { headers: { "content-length": "9" } });
        return new Response(verified, { headers: { "content-length": String(verified.length) } });
      },
      registerConnector: async (input) => {
        registered = true;
        return registeredConnector(input);
      },
    });
    const job = await service.submit({ files: [
      { url: "https://example.test/missing.fits", name: "missing.fits" },
      { url: "https://example.test/bad-checksum.fits", name: "bad-checksum.fits", sha256: "0".repeat(64) },
      { url: "https://example.test/verified.fits", name: "verified.fits", sizeBytes: verified.length },
    ], concurrency: 1 });
    const result = await waitForTerminal(service, job.id);
    assert.equal(result.status, "partial");
    assert.equal(result.phase, "partial");
    assert.equal(result.downloadedFiles, 1);
    assert.equal(result.totalFiles, 3);
    assert.equal(result.transfer.filter((entry) => entry.status === "failed").length, 2);
    assert.match(result.transfer.find((entry) => entry.name === "bad-checksum.fits")?.error ?? "", /文件校验失败: bad-checksum\.fits/);
    assert.equal(registered, true);
    assert.equal(await readFile(path.join(result.outputPath!, "verified.fits"), "utf8"), verified.toString("utf8"));
    await assert.rejects(() => readFile(path.join(result.outputPath!, "missing.fits"), "utf8"));
    await assert.rejects(() => readFile(path.join(result.outputPath!, "bad-checksum.fits"), "utf8"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("marks an all-failed download red and does not register an empty Connector", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-coverage-download-all-failed-"));
  try {
    let registered = false;
    const service = new CoverageDownloadService({
      root: path.join(directory, "downloads"),
      fetchImpl: async () => new Response("", { status: 404 }),
      registerConnector: async (input) => {
        registered = true;
        return registeredConnector(input);
      },
    });
    const job = await service.submit({ files: [
      { url: "https://example.test/missing-a.fits", name: "missing-a.fits" },
      { url: "https://example.test/missing-b.fits", name: "missing-b.fits" },
    ], concurrency: 1 });
    const result = await waitForTerminal(service, job.id);
    assert.equal(result.status, "failed");
    assert.equal(result.downloadedFiles, 0);
    assert.equal(result.transfer.every((entry) => entry.status === "failed"), true);
    assert.equal(registered, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects unsupported protocols and duplicate file names before starting a job", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-coverage-download-validation-"));
  try {
    const service = new CoverageDownloadService({ root: path.join(directory, "downloads") });
    await assert.rejects(() => service.submit({ files: [{ url: "s3://bucket/file.csv", name: "file.csv" }] }), /HTTP or HTTPS/);
    await assert.rejects(() => service.submit({ files: [
      { url: "https://example.test/a", name: "same" },
      { url: "https://example.test/b", name: "same" },
    ] }), /duplicate names/);
    await assert.rejects(() => service.submit({ files: [{ url: "http://127.0.0.1/private.csv", name: "private.csv" }] }), /local or private/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("download jobs accept a file and declared task total above 2 GiB and retain partial bytes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-coverage-download-large-file-"));
  try {
    const sizeBytes = 3 * 1024 * 1024 * 1024;
    const service = new CoverageDownloadService({
      root: path.join(directory, "downloads"),
      fetchImpl: async () => new Response("x", { status: 200, headers: { "content-length": "1" } }),
    });
    const submitted = await service.submit({ files: [
      { url: "https://example.test/large.fits", name: "large.fits", sizeBytes },
    ], concurrency: 1, outputPrefix: "large-task" });
    assert.equal(submitted.totalBytes, sizeBytes);
    const result = await waitForTerminal(service, submitted.id);
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /文件大小不符/);
    const partialFile = path.join(directory, "downloads", "files", "large-task", "large.fits.part");
    assert.equal(await readFile(partialFile, "utf8"), "x");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects the legacy target Connector field instead of silently ignoring it", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-coverage-download-target-"));
  try {
    const service = new CoverageDownloadService({ root: path.join(directory, "downloads") });
    await assert.rejects(() => service.submit({
      files: [{ url: "https://example.test/file", name: "file" }],
      targetConnectorId: "connector-existing",
    } as never), /targetConnectorId is not supported/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("persists interrupted jobs as failed on restart", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-coverage-download-recovery-"));
  try {
    const statePath = path.join(directory, "jobs.json");
    const now = new Date().toISOString();
    await writeFile(statePath, JSON.stringify({ schemaVersion: 1, jobs: [{
      id: "coverage-download-interrupted",
      status: "running",
      phase: "downloading",
      files: [{ url: "https://example.test/file", name: "file" }],
      downloadedFiles: 0,
      totalFiles: 1,
      downloadedBytes: 0,
      totalBytes: 0,
      createdAt: now,
      updatedAt: now,
    }] }), "utf8");
    const service = new CoverageDownloadService({ root: path.join(directory, "downloads"), statePath });
    const job = await service.get("coverage-download-interrupted");
    assert.equal(job.status, "failed");
    assert.match(job.error ?? "", /interrupted/);
    const persisted = JSON.parse(await readFile(statePath, "utf8")) as { jobs: Array<{ status: string }> };
    assert.equal(persisted.jobs[0]?.status, "failed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("automatically resumes an interrupted transfer using Range and If-Range", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-coverage-download-resume-"));
  const registrations: string[] = [];
  let attempts = 0;
  let resumeHeaders: Record<string, string> = {};
  try {
    const service = new CoverageDownloadService({
      root: path.join(directory, "downloads"),
      statePath: path.join(directory, "jobs.json"),
      fetchImpl: async (_input, init) => {
        attempts += 1;
        const headers = (init?.headers ?? {}) as Record<string, string>;
        if (attempts === 1) {
          let delivered = false;
          return new Response(new ReadableStream<Uint8Array>({
            pull(controller) {
              if (delivered) {
                controller.error(new Error("short read"));
                return;
              }
              delivered = true;
              controller.enqueue(new TextEncoder().encode("AAAA"));
            },
          }), { status: 200, headers: { "content-length": "12", etag: '"v1"' } });
        }
        resumeHeaders = headers;
        assert.equal(headers["Accept-Encoding"], "identity");
        assert.equal(headers.Range, "bytes=4-");
        assert.equal(headers["If-Range"], '"v1"');
        return new Response("BBBBBBBB", { status: 206, headers: { "content-range": "bytes 4-11/12", "content-length": "8", etag: '"v1"' } });
      },
      registerConnector: async (input) => {
        registrations.push(input.config.rootPath!);
        return registeredConnector(input);
      },
    });
    const file = { url: "https://example.test/data.bin", name: "data.bin", sizeBytes: 12, etag: '"v1"' };
    const first = await service.submit({ files: [file], requestKey: "resume-key", outputPrefix: "resume-case", concurrency: 1 });
    const completed = await waitForTerminal(service, first.id);
    assert.equal(completed.status, "completed");
    const outputDirectory = path.join(directory, "downloads", "files", "resume-case");
    assert.equal(resumeHeaders.Range, "bytes=4-");
    assert.equal(await readFile(path.join(outputDirectory, "data.bin"), "utf8"), "AAAABBBBBBBB");
    const entries = await readdir(outputDirectory);
    assert.ok(entries.includes("data.bin"));
    assert.equal(entries.filter((entry) => entry.endsWith(".part")).length, 0);
    assert.equal(registrations.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("restarts a partial file when no safe resume validator exists", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-coverage-download-restart-"));
  let attempts = 0;
  try {
    const service = new CoverageDownloadService({
      root: path.join(directory, "downloads"),
      fetchImpl: async (_input, init) => {
        attempts += 1;
        const headers = (init?.headers ?? {}) as Record<string, string>;
        assert.equal(headers.Range, undefined);
        if (attempts === 1) {
          let delivered = false;
          return new Response(new ReadableStream<Uint8Array>({
            pull(controller) {
              if (delivered) {
                controller.error(new Error("terminated"));
                return;
              }
              delivered = true;
              controller.enqueue(new TextEncoder().encode("PART"));
            },
          }), { status: 200, headers: { "content-length": "8" } });
        }
        return new Response("COMPLETE", { status: 200, headers: { "content-length": "8" } });
      },
    });
    const submitted = await service.submit({ files: [{ url: "https://example.test/restart.bin", name: "restart.bin", sizeBytes: 8 }], concurrency: 1 });
    const completed = await waitForTerminal(service, submitted.id);
    assert.equal(completed.status, "completed");
    assert.equal(attempts, 2);
    assert.equal(await readFile(path.join(completed.outputPath!, "restart.bin"), "utf8"), "COMPLETE");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps successful siblings while a failed file is skipped, then resumes that file on retry", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-coverage-download-primary-error-"));
  let brokenAttempts = 0;
  let retriedHeaders: Record<string, string> = {};
  try {
    const service = new CoverageDownloadService({
      root: path.join(directory, "downloads"),
      statePath: path.join(directory, "jobs.json"),
      fetchImpl: async (input, init) => {
        const url = String(input);
        const headers = (init?.headers ?? {}) as Record<string, string>;
        if (url.endsWith("slow.bin")) {
          return new Response("SLOW", { status: 200, headers: { "content-length": "4" } });
        }
        brokenAttempts += 1;
        if (brokenAttempts === 1) {
          let delivered = false;
          return new Response(new ReadableStream<Uint8Array>({
            pull(controller) {
              if (delivered) {
                controller.error(new Error("terminated"));
                return;
              }
              delivered = true;
              controller.enqueue(new TextEncoder().encode("AAAA"));
            },
          }), { status: 200, headers: { "content-length": "12", etag: '\"v1\"' } });
        }
        if (brokenAttempts <= 4) {
          assert.equal(headers.Range, "bytes=4-");
          assert.equal(headers["If-Range"], '\"v1\"');
          return new Response(new ReadableStream<Uint8Array>({
            start(controller) { controller.error(new Error("terminated")); },
          }), { status: 206, headers: { "content-range": "bytes 4-11/12", "content-length": "8", etag: '\"v1\"' } });
        }
        retriedHeaders = headers;
        return new Response("BBBBBBBB", { status: 206, headers: { "content-range": "bytes 4-11/12", "content-length": "8", etag: '\"v1\"' } });
      },
    });
    const files = [
      { url: "https://example.test/slow.bin", name: "slow.bin", sizeBytes: 4 },
      { url: "https://example.test/broken.bin", name: "broken.bin", sizeBytes: 12 },
    ];
    const first = await service.submit({ files, requestKey: "primary-error-key", outputPrefix: "primary-error", concurrency: 2 });
    const partial = await waitForTerminal(service, first.id);
    assert.equal(partial.status, "partial");
    assert.equal(partial.downloadedFiles, 1);
    assert.match(partial.transfer.find((entry) => entry.name === "broken.bin")?.error ?? "", /broken\.bin.*terminated/);
    assert.equal(partial.transfer.find((entry) => entry.name === "broken.bin")?.etag, '\"v1\"');
    assert.equal(partial.transfer.find((entry) => entry.name === "slow.bin")?.status, "verified");

    const second = await service.submit({ files, requestKey: "primary-error-key", outputPrefix: "primary-error", concurrency: 2 });
    assert.notEqual(second.id, first.id);
    const completed = await waitForTerminal(service, second.id);
    assert.equal(completed.status, "completed");
    assert.equal(retriedHeaders.Range, "bytes=4-");
    assert.equal(retriedHeaders["If-Range"], '\"v1\"');
    const outputDirectory = path.join(directory, "downloads", "files", "primary-error");
    assert.equal(await readFile(path.join(outputDirectory, "broken.bin"), "utf8"), "AAAABBBBBBBB");
    assert.equal(await readFile(path.join(outputDirectory, "slow.bin"), "utf8"), "SLOW");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("resubmitting a completed requestKey returns the original job without re-registering", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-coverage-download-once-"));
  const registrations: string[] = [];
  try {
    const service = new CoverageDownloadService({
      root: path.join(directory, "downloads"),
      statePath: path.join(directory, "jobs.json"),
      fetchImpl: async () => new Response("xyz", { status: 200, headers: { "content-length": "3" } }),
      registerConnector: async (input) => {
        registrations.push(input.config.rootPath!);
        return registeredConnector(input);
      },
    });
    const file = { url: "https://example.test/once.bin", name: "once.bin", sizeBytes: 3 };
    const first = await service.submit({ files: [file], requestKey: "once-key", outputPrefix: "once-case", concurrency: 1 });
    const completed = await waitForTerminal(service, first.id);
    assert.equal(completed.status, "completed");
    const again = await service.submit({ files: [file], requestKey: "once-key", outputPrefix: "once-case", concurrency: 1 });
    assert.equal(again.id, first.id);
    assert.equal(registrations.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("download status reports transferred bytes while a single file is still streaming", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-live-download-progress-"));
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  try {
    const service = new CoverageDownloadService({
      root: path.join(directory, "downloads"),
      fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
          controller.enqueue(new TextEncoder().encode("AAAA"));
        },
      }), { headers: { "content-length": "8" } }),
    });
    const submitted = await service.submit({ files: [{ url: "https://example.test/slow.bin", name: "slow.bin" }] });
    let current = await service.get(submitted.id);
    for (let attempt = 0; attempt < 100 && current.transfer[0]?.bytesPresent !== 4; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 5));
      current = await service.get(submitted.id);
    }
    assert.equal(current.status, "running");
    assert.equal(current.transfer[0]?.bytesPresent, 4);
    assert.equal(current.downloadedFiles, 0);
    assert.equal(current.downloadedBytes, 4);
    assert.equal(current.totalBytes, 8);
    assert.equal((await service.list()).find(job => job.id === submitted.id)?.downloadedBytes, 4);
    streamController!.enqueue(new TextEncoder().encode("BBBB"));
    streamController!.close();
    streamController = undefined;
    assert.equal((await waitForTerminal(service, submitted.id)).downloadedBytes, 8);
  } finally {
    streamController?.error(new Error("test cleanup"));
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 20 });
  }
});
