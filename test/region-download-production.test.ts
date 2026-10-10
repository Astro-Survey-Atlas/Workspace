import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ProductionService } from "../src/production.js";
import type { RegionDownloadConfirmation } from "../src/region-download-plan.js";
import { computeInventoryDigest, type SourceFileInventory } from "../src/source-crawler.js";

const region = { coordinateFrame: "ICRS", ordering: "NESTED", nside: 16, pixels: [190], sourceIds: [] };
const confirmation: RegionDownloadConfirmation = {
  selection: { layerIds: ["desi-dr1"], order: 4, cells: [190], querySnapshotId: "snapshot-original", nativeUnitIndexRevision: "index-original",
    units: [{ layerId: "desi-dr1", unitKind: "tile", unitId: "82406" }] },
  previewSha256: "a".repeat(64), selectedFileUrls: ["https://example.test/coadd.fits"],
};
function inventory(count = 1): SourceFileInventory {
  const files = Array.from({ length: count }, (_, index) => ({ sourceId: "public:desi:dr1:spectra:layer=desi-dr1", unitId: "82406",
    resolver: "direct-file@1" as const, url: `https://example.test/file-${index}.fits`, relativePath: `desi/82406/file-${index}.fits`, sizeBytes: 2880 }));
  const units = [{ sourceId: files[0]!.sourceId, unitId: "82406", resolver: "direct-file@1" as const, status: "resolved" as const, fileCount: count }];
  return { schemaVersion: 1, files, units, inventorySha256: computeInventoryDigest(files, units), truncated: true };
}
async function terminal(service: ProductionService, id: string) {
  for (let i = 0; i < 200; i++) {
    const run = await service.getRun(id);
    if (["succeeded", "partial", "failed", "cancelled"].includes(run.status)) return run;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("production did not finish");
}
function serviceAt(root: string, confirm: (input: RegionDownloadConfirmation) => Promise<SourceFileInventory>, submissions: unknown[][], failFirst = false,
  downloadResult: { status: "partial" | "failed" | "completed"; downloadedFiles: number; downloadedBytes: number; error?: string; fileErrors?: Array<string | undefined> } = { status: "completed", downloadedFiles: 1, downloadedBytes: 2880 }) {
  return new ProductionService({ root, confirmPublicDownload: confirm,
    connectors: {} as never, dataCatalog: {} as never, objectIndex: {} as never, localRoots: {} as never,
    downloads: {
      async submit(input: { files: unknown[] }) {
        submissions.push(input.files);
        const status = failFirst && submissions.length === 1 ? "failed" : downloadResult.status;
        const downloadedFiles = failFirst && submissions.length === 1 ? 0 : downloadResult.downloadedFiles;
        return { id: `job-${submissions.length}`, status, totalFiles: input.files.length,
          downloadedFiles,
          downloadedBytes: failFirst && submissions.length === 1 ? 0 : downloadResult.downloadedBytes,
          error: failFirst && submissions.length === 1 ? "Synthetic file download failed" : downloadResult.error,
          transfer: input.files.map((_file, index) => ({ relativePath: `file-${index}.fits`, status: index < downloadedFiles ? "verified" : "failed",
            ...(index < downloadedFiles ? {} : { error: downloadResult.fileErrors?.[index] ?? "Synthetic file download failed" }) })),
          outputConnectorId: "downloaded-connector", outputPath: "/runtime/downloads/result" };
      },
    } as never,
  });
}

test("confirmed region tasks store only chosen files and retry the original inventory after Assets changes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workspace-region-production-"));
  try {
    let confirmations = 0;
    const submissions: unknown[][] = [];
    const service = serviceAt(root, async () => inventory(++confirmations === 1 ? 1 : 12), submissions, true);
    const submitted = await service.submit({ pipelineKey: "overlap-download@1", region, publicDownload: confirmation });
    const failed = await terminal(service, submitted.id);
    assert.equal(failed.status, "failed");
    assert.equal(failed.approval?.state, "approved");
    assert.equal(failed.inventory?.files.length, 1);
    assert.deepEqual(failed.input.publicDownload, { querySnapshotId: "snapshot-original", nativeUnitIndexRevision: "index-original", previewSha256: confirmation.previewSha256 });
    assert.deepEqual((failed.input.region as { sourceIds: string[] }).sourceIds, [inventory().files[0]!.sourceId]);
    const retried = await service.retry(failed.id);
    const completed = await terminal(service, retried.id);
    assert.equal(completed.status, "succeeded");
    assert.equal(confirmations, 1, "retry must not query a newer Assets result");
    assert.deepEqual(submissions[0], submissions[1]);
    assert.equal(completed.approval?.reused, true);
    assert.equal(completed.outputConnectorId, "downloaded-connector");
    assert.equal(completed.steps.find((step) => step.id === "download")?.status, "succeeded");
    const saved = JSON.parse(await readFile(path.join(root, "production-runs.json"), "utf8"));
    assert.equal(saved.runs.every((run: { input: { publicDownload: object } }) => !("selection" in run.input.publicDownload)), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a mixed public download completes with a yellow partial result and retains successful counts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workspace-region-production-partial-"));
  try {
    const submissions: unknown[][] = [];
    const service = serviceAt(root, async () => inventory(3), submissions, false, {
      status: "partial", downloadedFiles: 2, downloadedBytes: 5760,
      fileErrors: [undefined, undefined, "文件 file-2.fits 下载失败：HTTP 503"],
    });
    const submitted = await service.submit({ pipelineKey: "overlap-download@1", region, publicDownload: confirmation });
    const completed = await terminal(service, submitted.id);
    assert.equal(completed.status, "partial");
    assert.equal(completed.summary.downloadedFiles, 2);
    assert.equal(completed.summary.files, 3);
    assert.equal(completed.summary.downloadedBytes, 5760);
    assert.equal(completed.outputConnectorId, "downloaded-connector");
    assert.equal(completed.steps.find((step) => step.id === "download")?.status, "partial");
    assert.match(completed.steps.find((step) => step.id === "download")?.detail ?? "", /2.*3/);
    assert.match(completed.steps.find((step) => step.id === "download")?.logs.map((entry) => entry.message).join("\n") ?? "", /file-2\.fits.*HTTP 503/);
    assert.equal(submissions.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an all-failed public download ends red and keeps each file error in the run history", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workspace-region-production-all-failed-"));
  try {
    const submissions: unknown[][] = [];
    const service = serviceAt(root, async () => inventory(2), submissions, false, {
      status: "failed", downloadedFiles: 0, downloadedBytes: 0, error: "全部文件均下载失败：remote stream terminated",
      fileErrors: ["文件 file-0.fits 在 4 次尝试后仍失败：remote stream terminated", "文件 file-1.fits 下载失败：HTTP 503"],
    });
    const submitted = await service.submit({ pipelineKey: "overlap-download@1", region, publicDownload: confirmation });
    const failed = await terminal(service, submitted.id);
    assert.equal(failed.status, "failed");
    assert.equal(failed.summary.downloadedFiles, 0);
    assert.equal(failed.summary.failedFiles, 2);
    assert.match(failed.error ?? "", /remote stream terminated/);
    const downloadStep = failed.steps.find((step) => step.id === "download");
    assert.equal(downloadStep?.status, "failed");
    assert.match(downloadStep?.logs.map((entry) => entry.message).join("\n") ?? "", /file-0\.fits.*remote stream terminated/);
    assert.match(downloadStep?.logs.map((entry) => entry.message).join("\n") ?? "", /file-1\.fits.*HTTP 503/);
    assert.equal(failed.outputConnectorId, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("changed previews or region mismatches create neither tasks nor downloads", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workspace-region-invalid-"));
  try {
    let confirmations = 0;
    const submissions: unknown[][] = [];
    const service = serviceAt(root, async () => { confirmations++; throw new Error("preview changed"); }, submissions);
    await assert.rejects(() => service.submit({ pipelineKey: "overlap-download@1", region: { ...region, pixels: [191] }, publicDownload: confirmation }), /区域快照不一致/);
    assert.equal(confirmations, 0);
    await assert.rejects(() => service.submit({ pipelineKey: "overlap-download@1", region, publicDownload: confirmation }), /preview changed/);
    assert.equal((await service.listRuns()).length, 0);
    assert.equal(submissions.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
