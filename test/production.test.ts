import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ProductionService, type ProductionRun } from "../src/production.js";

const region = {
  coordinateFrame: "ICRS" as const,
  ordering: "NESTED" as const,
  nside: 16,
  pixels: [100, 101],
  sourceIds: ["workspace:asset:left", "workspace:asset:right"],
};

function indexedAsset(id: string): Record<string, unknown> {
  return {
    id,
    name: id,
    kind: "catalog",
    scanSpec: {
      format: "csv",
      objectIdColumn: "object_id",
      raColumn: "ra_deg",
      decColumn: "dec_deg",
      coordinateFrame: "ICRS",
      coordinateUnits: "deg",
      modality: "catalog",
      product: "test",
    },
  };
}

function objectRecord(assetId: string, offset = 0): Record<string, unknown> {
  return {
    object_id: `${assetId}-object`,
    ra_deg: 10 + offset,
    dec_deg: 20,
    asset_id: assetId,
    survey: "test",
    release: "v1",
    product: "catalog",
    modality: "catalog",
  };
}

function createService(root: string, options: {
  queryObjects?: (input: { assetIds?: string[] }) => Promise<unknown>;
  downloads?: Record<string, unknown>;
} = {}): ProductionService {
  return new ProductionService({
    root,
    downloads: (options.downloads ?? {}) as never,
    connectors: { get: async () => { throw new Error("unused connector"); } } as never,
    dataCatalog: { get: async (id: string) => indexedAsset(id) } as never,
    objectIndex: {
      queryObjects: options.queryObjects ?? (async (input: { assetIds?: string[] }) => {
        const assetId = input.assetIds?.[0] ?? "unknown";
        return { status: "ready", objects: [objectRecord(assetId, assetId === "right" ? 0.0001 : 0)], total: 1 };
      }),
    } as never,
    localRoots: { assertConfiguredPath: () => undefined } as never,
  });
}

async function waitForTerminal(service: ProductionService, id: string): Promise<ProductionRun> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const run = await service.getRun(id);
    if (["succeeded", "failed", "cancelled"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for production run ${id}`);
}

async function submitCrossmatch(service: ProductionService): Promise<ProductionRun> {
  return service.submit({
    pipelineKey: "object-crossmatch@1",
    region,
    leftAssetId: "left",
    rightAssetId: "right",
    matchRadiusArcsec: 2,
    limit: 100,
  });
}

test("production step logs persist across a service restart", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-production-logs-"));
  try {
    const service = createService(directory);
    const submitted = await submitCrossmatch(service);
    const completed = await waitForTerminal(service, submitted.id);
    assert.equal(completed.status, "succeeded");
    assert.deepEqual(completed.steps.map((step) => step.status), ["succeeded", "succeeded", "succeeded"]);
    assert.ok(completed.steps.every((step) => step.logs.length >= 2));
    assert.match(completed.steps[1]!.logs.at(-1)!.message, /1 个匹配/);

    const reloaded = createService(directory);
    const persisted = await reloaded.getRun(submitted.id);
    assert.deepEqual(persisted.steps, completed.steps);
    assert.equal(persisted.artifacts.length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed production nodes retain errors and retry creates a distinct run", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-production-retry-"));
  try {
    const service = createService(directory, {
      queryObjects: async () => { throw new Error("object index unavailable"); },
    });
    const submitted = await submitCrossmatch(service);
    const failed = await waitForTerminal(service, submitted.id);
    assert.equal(failed.status, "failed");
    assert.equal(failed.steps[0]?.status, "failed");
    assert.equal(failed.steps[0]?.logs.at(-1)?.level, "error");
    assert.match(failed.steps[0]?.logs.at(-1)?.message ?? "", /object index unavailable/);

    const retried = await service.retry(failed.id);
    assert.notEqual(retried.id, failed.id);
    assert.equal(retried.pipelineKey, failed.pipelineKey);
    await waitForTerminal(service, retried.id);
    assert.equal((await service.listRuns()).length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cancelling a download run records a cancelled node log", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-production-cancel-"));
  const timestamp = new Date().toISOString();
  const download = {
    id: "download-test",
    status: "running",
    phase: "downloading",
    files: [{ url: "https://example.test/file.csv", name: "file.csv" }],
    downloadedFiles: 0,
    totalFiles: 1,
    downloadedBytes: 0,
    totalBytes: 10,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  try {
    const service = createService(directory, {
      downloads: {
        submit: async () => ({ ...download }),
        get: async () => ({ ...download }),
        cancel: async () => { download.status = "cancelled"; download.phase = "cancelled"; return { ...download }; },
      },
    });
    const submitted = await service.submit({
      pipelineKey: "overlap-download@1",
      region,
      files: [{ url: "https://example.test/file.csv", name: "file.csv" }],
      crawlerId: "builtin-http",
      concurrency: 1,
    });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const run = await service.getRun(submitted.id);
      if (run.summary.downloadJobId) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const cancelled = await service.cancel(submitted.id);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.steps.find((step) => step.id === "download")?.status, "cancelled");
    assert.equal(cancelled.steps.find((step) => step.id === "download")?.logs.at(-1)?.level, "warning");
    await new Promise((resolve) => setTimeout(resolve, 550));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy production runs drop preset references and synthesize node logs", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-production-legacy-"));
  try {
    await mkdir(directory, { recursive: true });
    const timestamp = new Date().toISOString();
    await writeFile(path.join(directory, "production-runs.json"), `${JSON.stringify([{
      id: "legacy-run",
      pipelineKey: "object-crossmatch@1",
      pipelinePresetId: "legacy-preset",
      status: "failed",
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: timestamp,
      input: { pipelineKey: "object-crossmatch@1", region },
      steps: [{ id: "query", title: "读取两个对象索引", status: "failed", detail: "legacy failure", completedAt: timestamp }],
      artifacts: [],
      summary: {},
    }], null, 2)}\n`, "utf8");

    const service = createService(directory);
    const run = await service.getRun("legacy-run");
    assert.equal("pipelinePresetId" in run, false);
    assert.equal(run.steps[0]?.logs.length, 1);
    assert.equal(run.steps[0]?.logs[0]?.level, "error");
    assert.equal(run.steps[0]?.logs[0]?.message, "legacy failure");
    const persisted = JSON.parse(await readFile(path.join(directory, "production-runs.json"), "utf8")) as Array<Record<string, unknown>>;
    assert.equal("pipelinePresetId" in persisted[0]!, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
