import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ProductionService,
  ProductionStateError,
  type ProductionRun,
  type ProductionSourceResolver,
} from "../src/production.js";

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
  sourceResolver?: ProductionSourceResolver;
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
    ...(options.sourceResolver ? {
      sourceResolver: options.sourceResolver,
      // Keep the in-run resolve step hermetic: HEAD enrichment is best-effort,
      // so an offline stub fetch still yields a resolved inventory.
      sourceResolveOptions: { fetchImpl: async () => new Response("", { status: 404 }) },
    } : {}),
  });
}

async function waitForTerminal(service: ProductionService, id: string): Promise<ProductionRun> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const run = await service.getRun(id);
    if (["succeeded", "failed", "cancelled"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for production run ${id}`);
}

async function waitForStatus(service: ProductionService, id: string, statuses: string[]): Promise<ProductionRun> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const run = await service.getRun(id);
    if (statuses.includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for production run ${id} to reach ${statuses.join("|")}`);
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
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 20 });
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
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 20 });
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
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 20 });
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
    const persisted = JSON.parse(await readFile(path.join(directory, "production-runs.json"), "utf8")) as { schemaVersion: number; runs: Array<Record<string, unknown>> };
    assert.equal(persisted.schemaVersion, 2);
    assert.equal("pipelinePresetId" in persisted.runs[0]!, false);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 20 });
  }
});

function completedDownload() {
  const timestamp = new Date().toISOString();
  return {
    id: "download-ok",
    status: "completed",
    phase: "completed",
    files: [{ url: "https://example.test/tile-406.fits", name: "tile-406.fits" }],
    downloadedFiles: 1,
    totalFiles: 1,
    downloadedBytes: 1234,
    totalBytes: 1234,
    outputConnectorId: "connector-downloaded",
    outputPath: "/tmp/download-output",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function failingDownload() {
  const timestamp = new Date().toISOString();
  return {
    id: "download-fail",
    status: "failed",
    phase: "failed",
    files: [{ url: "https://example.test/tile-406.fits", name: "tile-406.fits" }],
    downloadedFiles: 0,
    totalFiles: 1,
    downloadedBytes: 0,
    totalBytes: 1234,
    error: "boom",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

const fixtureUnit = {
  sourceId: "public:desi:dr1:iron",
  unitId: "file:public:desi:dr1:iron",
  resolver: "direct-file@1",
  url: "https://example.test/tile-406.fits",
  sizeBytes: 1234,
  sha256: "a".repeat(64),
} as const;

const fixtureResolver: ProductionSourceResolver = {
  resolve: async () => ({ units: [{ ...fixtureUnit }], blocked: [] }),
};

test("resolves the plan inside the run and waits for approval before any transfer", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-production-approval-"));
  const submissions: Array<{ requestKey?: string; files: Array<Record<string, unknown>>; outputPrefix?: string }> = [];
  try {
    const service = createService(directory, {
      sourceResolver: fixtureResolver,
      downloads: {
        submit: async (input: { requestKey?: string; files: Array<Record<string, unknown>>; outputPrefix?: string }) => {
          submissions.push(input);
          return completedDownload();
        },
        get: async () => completedDownload(),
        cancel: async () => { throw new Error("cancel not expected"); },
      },
    });
    const submitted = await service.submit({
      pipelineKey: "overlap-download@1",
      region,
      concurrency: 1,
    });
    assert.equal(submitted.status, "resolving");

    const awaiting = await waitForStatus(service, submitted.id, ["awaiting-approval"]);
    assert.equal(awaiting.approval?.state, "pending");
    assert.match(awaiting.approval?.planSha256 ?? "", /^[0-9a-f]{64}$/);
    assert.equal(awaiting.approval?.planSha256, awaiting.inventory?.inventorySha256);
    assert.equal(awaiting.summary.inventoryFiles, 1);
    assert.match(String(awaiting.inventory?.files[0]?.relativePath ?? ""), /tile-406\.fits$/);
    assert.ok(awaiting.artifacts.some((artifact) => artifact.name === "download-plan.json"));
    assert.equal(submissions.length, 0);

    await assert.rejects(() => service.approve(submitted.id, "0".repeat(64)), (error: unknown) => {
      assert.ok(error instanceof ProductionStateError);
      assert.match(error.message, /清单校验值不匹配/);
      return true;
    });

    const approved = await service.approve(submitted.id, awaiting.approval!.planSha256);
    assert.equal(approved.approval?.state, "approved");
    assert.equal(approved.approval?.decidedBy, "user");
    const completed = await waitForTerminal(service, submitted.id);
    assert.equal(completed.status, "succeeded");
    assert.equal(completed.summary.downloadJobId, "download-ok");
    assert.equal(completed.outputConnectorId, "connector-downloaded");
    assert.equal(submissions.length, 1);
    assert.equal(submissions[0]?.requestKey, `production:${submitted.id}`);
    assert.equal(submissions[0]?.outputPrefix, submitted.id);
    assert.ok(typeof submissions[0]?.files[0]?.relativePath === "string");
    assert.ok(completed.artifacts.some((artifact) => artifact.name === "download-manifest.json"));
    assert.equal(completed.steps.find((step) => step.id === "warehouse")?.status, "skipped");
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 20 });
  }
});

test("a blocked source unit fails the whole run with structured diagnostics", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-production-blocked-"));
  let submitCalls = 0;
  try {
    const service = createService(directory, {
      sourceResolver: {
        resolve: async () => ({
          units: [],
          blocked: [{ sourceId: "public:csst:sim:w1", reason: "公开覆盖没有可反查的文件 URL" }],
        }),
      },
      downloads: {
        submit: async () => { submitCalls += 1; throw new Error("must not be called"); },
        get: async () => { throw new Error("must not be called"); },
        cancel: async () => { throw new Error("must not be called"); },
      },
    });
    const submitted = await service.submit({ pipelineKey: "overlap-download@1", region });
    const failed = await waitForTerminal(service, submitted.id);
    assert.equal(failed.status, "failed");
    assert.match(failed.error ?? "", /来源解析受阻（1 个单元）/);
    assert.equal(failed.summary.blockedUnits ? (failed.summary.blockedUnits as Array<{ sourceId: string }>)[0]?.sourceId : undefined, "public:csst:sim:w1");
    assert.ok(failed.artifacts.some((artifact) => artifact.name === "download-plan.json"));
    assert.equal(failed.steps.find((step) => step.id === "resolve")?.status, "failed");
    assert.equal(submitCalls, 0);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 20 });
  }
});

test("rejecting a pending plan skips the remaining steps and locks the run", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-production-reject-"));
  const submissions: unknown[] = [];
  try {
    const service = createService(directory, {
      sourceResolver: fixtureResolver,
      downloads: {
        submit: async (input: unknown) => { submissions.push(input); return completedDownload(); },
        get: async () => completedDownload(),
        cancel: async () => { throw new Error("cancel not expected"); },
      },
    });
    const submitted = await service.submit({ pipelineKey: "overlap-download@1", region });
    await waitForStatus(service, submitted.id, ["awaiting-approval"]);
    const rejected = await service.reject(submitted.id);
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.approval?.state, "rejected");
    assert.equal(rejected.steps.find((step) => step.id === "approval")?.status, "cancelled");
    for (const stepId of ["download", "connector", "warehouse"]) {
      assert.equal(rejected.steps.find((step) => step.id === stepId)?.status, "skipped");
    }
    assert.equal(submissions.length, 0);
    await assert.rejects(() => service.approve(submitted.id, rejected.approval!.planSha256), /只有等待审批/);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 20 });
  }
});

test("retrying a failed approved run reuses the inventory and the download staging", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-production-retry-reuse-"));
  const submissions: Array<{ requestKey?: string }> = [];
  let resolverCalls = 0;
  let downloadShouldFail = true;
  try {
    const service = createService(directory, {
      sourceResolver: {
        resolve: async () => {
          resolverCalls += 1;
          return { units: [{ ...fixtureUnit }], blocked: [] };
        },
      },
      downloads: {
        submit: async (input: { requestKey?: string }) => {
          submissions.push(input);
          return downloadShouldFail ? failingDownload() : completedDownload();
        },
        get: async (_id: string) => (downloadShouldFail ? failingDownload() : completedDownload()),
        cancel: async () => { throw new Error("cancel not expected"); },
      },
    });
    const submitted = await service.submit({ pipelineKey: "overlap-download@1", region });
    const awaiting = await waitForStatus(service, submitted.id, ["awaiting-approval"]);
    await service.approve(submitted.id, awaiting.approval!.planSha256);
    const failed = await waitForTerminal(service, submitted.id);
    assert.equal(failed.status, "failed");
    assert.equal(resolverCalls, 1);

    downloadShouldFail = false;
    const retried = await service.retry(failed.id);
    assert.equal(retried.retryOfRunId, submitted.id);
    assert.equal(retried.approval?.state, "approved");
    assert.equal(retried.approval?.reused, true);
    assert.equal(retried.inventory?.inventorySha256, awaiting.inventory?.inventorySha256);

    const completed = await waitForTerminal(service, retried.id);
    assert.equal(completed.status, "succeeded");
    assert.equal(resolverCalls, 1);
    assert.equal(submissions.length, 2);
    assert.deepEqual(submissions.map((entry) => entry.requestKey), [`production:${submitted.id}`, `production:${submitted.id}`]);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 20 });
  }
});
