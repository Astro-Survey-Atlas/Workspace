import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CoverageDownloadService } from "../src/coverage-downloads.js";
import type { ConnectorRecord } from "../src/connectors.js";

async function waitForTerminal(service: CoverageDownloadService, id: string): Promise<Awaited<ReturnType<CoverageDownloadService["get"]>>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const job = await service.get(id);
    if (["completed", "failed", "cancelled"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for coverage download");
}

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

test("resumes a failed transfer from the .part file using Range and If-Range", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-coverage-download-resume-"));
  const registrations: string[] = [];
  let failFirst = true;
  let resumeHeaders: Record<string, string> = {};
  try {
    const service = new CoverageDownloadService({
      root: path.join(directory, "downloads"),
      statePath: path.join(directory, "jobs.json"),
      fetchImpl: async (_input, init) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        if (failFirst) {
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
    const failed = await waitForTerminal(service, first.id);
    assert.equal(failed.status, "failed");
    const outputDirectory = path.join(directory, "downloads", "files", "resume-case");
    assert.equal(await readFile(path.join(outputDirectory, "data.bin.part"), "utf8"), "AAAA");

    failFirst = false;
    const second = await service.submit({ files: [file], requestKey: "resume-key", outputPrefix: "resume-case", concurrency: 1 });
    assert.notEqual(second.id, first.id);
    const completed = await waitForTerminal(service, second.id);
    assert.equal(completed.status, "completed");
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
