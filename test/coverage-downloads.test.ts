import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
