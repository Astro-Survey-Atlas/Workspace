import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { convertPositionHeaders, DerivedRepairService, pointDocument, SKY_DATA_POINT_INDEX } from "../src/derived-repairs.js";
import { stageWarehouseInventory } from "../src/warehouse-inventory.js";
import type { ConnectorIngestRunRecord } from "../src/connector-history.js";
import type { ConnectorIngestRunCatalog } from "../src/connector-history.js";
import type { DataCatalogRegistry } from "../src/data-catalog.js";
import type { AstroObjectIndexService } from "../src/astro-object-index.js";
import type { WarehouseScanService } from "../src/warehouse-scan.js";
import type { MocCoreAdapter } from "../src/moc-core-adapter.js";
import { UserMocArtifactStore } from "../src/user-moc-artifacts.js";

test("derived MOC repair builds real artifacts from the original evidence through Core, preserving scan history", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "derived-moc-"));
  try {
    const evidence = path.join(root, "evidence", "original-batch");
    await mkdir(evidence, { recursive: true });
    const snapshot = "a".repeat(64);
    await writeFile(path.join(evidence, "normalized-scan.json"), JSON.stringify({ phase: "COMPLETED", scanRunId: "original-batch", layerId: "private-layer",
      sourceSnapshot: { sha256: snapshot, availableOrders: [10] }, files: [], coverage: [{ layer_id: "private-layer", healpix_order: 10,
        healpix_cell: 1025, coordinate_frame: "ICRS", nesting: "NESTED", precision: "estimated" }] }));
    const run = { id: "original-run", assetId: "private-asset", backend: "warehouse", status: "succeeded", createdAt: "2026-10-10",
      warehouseLayerId: "private-layer", batchId: "original-batch", evidencePath: evidence, sourceSnapshotSha256: snapshot,
      fileCount: 1, maxOrder: 10, mocStatus: "failed", coverage: { mode: "fits-wcs", coverageRole: "image_extent" } } as ConnectorIngestRunRecord;
    const before = structuredClone(run);
    let coreCalls = 0;
    const mocCore: MocCoreAdapter = {
      buildCatalog: async () => { throw new Error("Must use native coverage, not rescan"); },
      buildNestedHealpixFile: async (input) => {
        coreCalls++;
        assert.equal(await readFile(input.inputPath, "utf8"), "order,ipix\n10,1025\n");
        assert.equal(input.layerId, "private-layer");
        const cards = (values: Record<string, string | number>) => Buffer.from(header(values));
        const rows = Buffer.alloc(2880); rows.writeBigInt64BE(4n * 4n ** 10n + 1025n);
        const moc = Buffer.concat([cards({ SIMPLE: "T", BITPIX: 8, NAXIS: 0, EXTEND: "T" }),
          cards({ XTENSION: "BINTABLE", BITPIX: 8, NAXIS: 2, NAXIS1: 8, NAXIS2: 1, PCOUNT: 0, GCOUNT: 1, TFIELDS: 1,
            TTYPE1: "UNIQ", TFORM1: "1K", ORDERING: "NUNIQ", COORDSYS: "C", MOCVERS: "2.0", MOCDIM: "SPACE" }), rows]);
        return { layerId: input.layerId, maxOrder: 10, queryOrder: 8, previewOrder: 4, queryPixels: [64], previewPixels: [0],
          artifacts: { moc, query: Buffer.from(JSON.stringify({ order: 8, ordering: "NESTED", pixels: [64] })),
            preview: Buffer.from(JSON.stringify({ order: 4, ordering: "NESTED", pixels: [0] })) } };
      },
    };
    const artifacts = new UserMocArtifactStore({ root: path.join(root, "artifacts") });
    await artifacts.fail({ layerId: "private-layer", scanRunId: run.id, sourceSnapshotSha256: snapshot }, "original failure");
    const options = { root: path.join(root, "tasks"), evidenceRoot: path.join(root, "evidence"), mocCore, artifacts,
      runs: { list: async () => [run] } as unknown as ConnectorIngestRunCatalog,
      assets: { get: async () => ({ id: "private-asset", origin: "user" }) } as unknown as DataCatalogRegistry,
      warehouse: {} as WarehouseScanService, points: {} as AstroObjectIndexService, downloads: async () => [] };
    const service = new DerivedRepairService(options);
    const submitted = await service.submit("private-asset", { mode: "moc" });
    let result;
    for (let attempt = 0; attempt < 100; attempt++) {
      result = (await service.list()).find((task) => task.id === submitted.id);
      if (result && !["queued", "running"].includes(result.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(result?.status, "succeeded", result?.error);
    assert.equal(coreCalls, 1);
    const artifact = await artifacts.get("private-layer", submitted.id);
    assert.equal(artifact.maxOrder, 10);
    assert.deepEqual(artifact.availableOrders, [10]);
    assert.deepEqual(await artifacts.projection("private-layer", submitted.id, 8), { order: 8, pixels: [64] });
    assert.equal((await artifacts.get("private-layer", run.id)).error, "original failure");
    assert.deepEqual(run, before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

function header(values: Record<string, unknown>): string {
  return [...Object.entries(values).map(([key, value]) => `${key.padEnd(8)}= ${typeof value === "string" ? `'${value}'` : String(value)}`.padEnd(80)), "END".padEnd(80)].join("").padEnd(2880);
}
test("indexing indication follows selected private assets, excluding MOC repairs, samples and terminal history", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "derived-progress-"));
  try {
    const tasks = [{ assetId: "sample", mode: "positions", status: "running", maxFiles: 64 },
      { assetId: "moc", mode: "moc", status: "running" }, { assetId: "done", mode: "positions", status: "partial" },
      { assetId: "active", mode: "positions", status: "running" }];
    for (const [i, task] of tasks.entries()) await writeFile(path.join(root, `derived-${i}.json`), JSON.stringify({ ...task, createdAt: "2026-10-10" }));
    const service = new DerivedRepairService({ root } as ConstructorParameters<typeof DerivedRepairService>[0]);
    assert.equal(await service.isIndexing([]), false);
    assert.equal(await service.isIndexing([{ assetId: "sample" }, { assetId: "moc" }, { assetId: "done" }]), false);
    assert.equal(await service.isIndexing([{ assetId: "unrelated" }]), false);
    assert.equal(await service.isIndexing([{ assetId: "active", sourceId: "concrete-source" }]), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("index timeouts retry the same committed headers without rereading sources or double-counting partial writes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "derived-index-retry-"));
  try {
    const outputPath = path.join(root, "evidence", "derived", "derived-123");
    const tasksPath = path.join(root, "tasks");
    await mkdir(outputPath, { recursive: true }); await mkdir(tasksPath);
    const run = { id: "scan", assetId: "asset", backend: "warehouse", status: "succeeded", evidencePath: path.join(root, "evidence", "scan"),
      warehouseLayerId: "layer", batchId: "batch", sourceSnapshotSha256: "a".repeat(64), createdAt: "2026-10-10", fileCount: 2,
      coverage: { mode: "fits-wcs" } } as ConnectorIngestRunRecord;
    const lines = [{ file_id: "science", source_uri: "file:///data/science.fits", file_name: "science.fits", hdu_index: 1,
      header: header({ XTENSION: "IMAGE", NAXIS: 2, NAXIS1: 100, NAXIS2: 100, CRPIX1: 50.5, CRPIX2: 50.5, CRVAL1: 12.5, CRVAL2: -3.25,
        CTYPE1: "RA---TAN", CTYPE2: "DEC--TAN", CDELT1: -0.001, CDELT2: 0.001 }) },
      { file_id: "missing", source_uri: "file:///data/missing.fits", file_name: "missing.fits", hdu_index: 0, header: header({ SIMPLE: true, NAXIS: 0 }) }]
      .map((row) => JSON.stringify(row)).join("\n") + "\n";
    await writeFile(path.join(outputPath, "headers.ndjson"), lines);
    await writeFile(path.join(outputPath, "checkpoint.json"), JSON.stringify({ scanRunId: "batch", layerId: "layer", sourceSnapshotSha256: run.sourceSnapshotSha256,
      processedFiles: 2, outputBytes: Buffer.byteLength(lines), phase: "SUCCEEDED" }));
    const failed = { id: "derived-abc", assetId: "asset", scanRunId: "scan", sourceSnapshotSha256: run.sourceSnapshotSha256,
      mode: "positions", status: "failed", phase: "indexing", createdAt: "2026-10-10", jobName: "derived-123", outputPath,
      processedFiles: 0, pointCount: 0, indexedBytes: 0, error: "Elasticsearch request timed out after 30000 ms" };
    await writeFile(path.join(tasksPath, "derived-abc.json"), JSON.stringify(failed));
    const ids = new Set<string>(); let calls = 0;
    const service = new DerivedRepairService({ root: tasksPath, evidenceRoot: path.join(root, "evidence"),
      runs: { list: async () => [run] } as unknown as ConnectorIngestRunCatalog,
      assets: { get: async () => ({ id: "asset", origin: "user" }) } as unknown as DataCatalogRegistry,
      artifacts: {} as UserMocArtifactStore,
      warehouse: { startPositionReplay: async () => { throw new Error("Must reuse the existing header Job"); }, positionReplayState: async () => "missing" } as unknown as WarehouseScanService,
      points: { ensureIndices: async () => {}, bulk: async (docs: Array<{ _id: string }>) => {
        calls++; docs.forEach((doc) => ids.add(doc._id));
        if (calls === 1) throw new Error("Elasticsearch request timed out after 30000 ms");
      } } as unknown as AstroObjectIndexService, downloads: async () => [] });
    const submitted = await service.submit("asset", { mode: "positions" });
    let task;
    for (let i = 0; i < 200; i++) {
      task = (await service.list()).find((task) => task.id === submitted.id);
      if (task?.error) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(task?.status, "running", task?.error);
    assert.equal(task?.indexedBytes, 0); assert.equal(task?.pointCount, 0); assert.equal(task?.coordinateErrors, 0);
    assert.equal(task?.jobName, "derived-123"); assert.equal(calls, 1); assert.ok(task?.nextRetryAt);
    await service.poll(); assert.equal(calls, 1, "Backoff must defer immediate retries");
    await writeFile(path.join(tasksPath, `${submitted.id}.json`), JSON.stringify({ ...task, nextRetryAt: "2000-01-01" }));
    await service.poll();
    task = (await service.list()).find((task) => task.id === submitted.id);
    assert.equal(task?.status, "partial"); assert.equal(task?.pointCount, 1); assert.equal(task?.coordinateErrors, 1);
    assert.equal(task?.indexedBytes, Buffer.byteLength(lines)); assert.equal(ids.size, 1); assert.equal(calls, 2);
    assert.deepEqual(JSON.parse(await readFile(path.join(tasksPath, "derived-abc.json"), "utf8")), failed);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("multiple science HDUs produce ICRS image centers, exclude DQ, preserve inherited frame", async () => {
  const primary = header({ SIMPLE: true, NAXIS: 0, RADESYS: "ICRS" });
  const science = { XTENSION: "IMAGE", NAXIS: 2, NAXIS1: 100, NAXIS2: 100, CRPIX1: 50.5, CRPIX2: 50.5,
    CRVAL1: 12.5, CRVAL2: -3.25, CTYPE1: "RA---TAN", CTYPE2: "DEC--TAN", CDELT1: -0.001, CDELT2: 0.001 };
  const records = [{ file_id: "one", source_uri: "file:///data/science.fits", file_name: "science.fits", hdu_index: 0, header: primary, primary_header: primary },
    ...[1, 2, 4].map((hdu_index) => ({ file_id: "one", source_uri: "file:///data/science.fits", file_name: "science.fits", hdu_index, primary_header: primary,
      header: header({ ...science, EXTNAME: hdu_index === 2 ? "DQ" : "SCI", CRVAL1: hdu_index === 4 ? 13 : 12.5 }) }))];
  const points = await convertPositionHeaders(records);
  assert.deepEqual(points.map((row) => row.hdu_index), [1, 4]);
  assert.equal(points[0]?.position_role, "image_center"); assert.ok(Math.abs(Number(points[0]?.ra_deg) - 12.5) < 1e-8);
  assert.ok(Math.abs(Number(points[1]?.ra_deg) - 13) < 1e-8);
  const document = pointDocument(points[0] as Parameters<typeof pointDocument>[0], { id: "asset", surveyId: "hst" }, { id: "scan", sourceSnapshotSha256: "a".repeat(64) } as ConnectorIngestRunRecord);
  assert.equal(document._index, SKY_DATA_POINT_INDEX); assert.equal(document.attributes.hdu_index, "1");
  assert.deepEqual(pointDocument(points[0] as Parameters<typeof pointDocument>[0], { id: "asset", surveyId: "hst" }, { id: "scan", sourceSnapshotSha256: "a".repeat(64) } as ConnectorIngestRunRecord), document);
});
test("missing coordinates remain evidence errors instead of manufactured HEALPix centers", async () => {
  const result = await convertPositionHeaders([{ file_id: "empty", hdu_index: 0, header: header({ SIMPLE: true, NAXIS: 0 }) }]);
  assert.equal(result.length, 1); assert.match(String(result[0]?.error), /no usable/); assert.equal(result[0]?.ra_deg, undefined);
});
test("finite derived inventory validates completed snapshot and is reusable without reading normalized evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "derived-inventory-"));
  try {
    const identity = { layerId: "layer", scanRunId: "scan", sourceSnapshotSha256: "a".repeat(64) };
    const evidence = { phase: "COMPLETED", layerId: "layer", scanRunId: "scan", sourceSnapshot: { sha256: identity.sourceSnapshotSha256 }, files: [{ layer_id: "layer", file_id: "file", file_name: "a.fits", source_uri: "file:///data/a.fits" }], coverage: [] };
    await writeFile(path.join(root, "normalized-scan.json"), JSON.stringify(evidence));
    const inventory = await stageWarehouseInventory(root, path.join(root, "derived", "inventory.ndjson"), identity);
    assert.equal(inventory.fileCount, 1); assert.match(await readFile(inventory.path, "utf8"), /a.fits/);
    await rm(path.join(root, "normalized-scan.json"));
    assert.deepEqual(await stageWarehouseInventory(root, inventory.path, identity), inventory);
    await writeFile(path.join(root, "normalized-scan.json"), JSON.stringify({ ...evidence, phase: "FAILED" }));
    await assert.rejects(stageWarehouseInventory(root, path.join(root, "other.ndjson"), identity), /identity mismatch/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
