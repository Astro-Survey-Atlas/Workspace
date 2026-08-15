import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  LOCAL_SCAN_HEALPIX_ORDER,
  LocalCsvScanConfigurationError,
  LocalCsvScanHeaderError,
  scanLocalCsv,
  stableCoverageDocumentId,
  stableObjectDocumentId,
  type LocalScanDocument,
} from "../src/local-scan.js";

async function withCsv(content: string, callback: (filePath: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-local-scan-"));
  const filePath = path.join(directory, "catalog.csv");
  try {
    await writeFile(filePath, content, "utf8");
    await callback(filePath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function options(overrides: Partial<Parameters<typeof scanLocalCsv>[1]> = {}): Parameters<typeof scanLocalCsv>[1] {
  return {
    objectIdColumn: "object_id",
    raColumn: "ra",
    decColumn: "dec",
    surveyId: "survey-a",
    releaseId: "release-1",
    product: "catalog",
    modality: "optical",
    assetId: "asset-a",
    sourceFileId: "file-a",
    scanRunId: "run-a",
    collectObjects: true,
    ...overrides,
  };
}

test("streams object documents to a sink with stable IDs and filtered attributes", async () => {
  await withCsv([
    "object_id,ra,dec,flux,label\n",
    "source-1,360,12.5,4.2,alpha\n",
    "source-2,10,-12.5,8.4,beta\n",
  ].join(""), async (filePath) => {
    const streamed: LocalScanDocument[] = [];
    const first = await scanLocalCsv(filePath, options(), (document) => {
      streamed.push(document);
    });
    const second = await scanLocalCsv(filePath, options());
    const objects = first.objectDocuments ?? [];

    assert.equal(first.summary.rowCount, 2);
    assert.equal(first.summary.objectCount, 2);
    assert.equal(first.summary.invalidRowCount, 0);
    assert.equal(first.summary.healpix_order, LOCAL_SCAN_HEALPIX_ORDER);
    assert.equal(objects.length, 2);
    assert.equal(streamed.length, 4);
    assert.deepEqual(streamed.slice(0, 2), objects);
    assert.equal(objects[0]?.object_id, "source-1");
    assert.equal(objects[0]?.ra_deg, 0);
    assert.equal(objects[0]?.dec_deg, 12.5);
    assert.deepEqual(objects[0]?.sky_position, { lat: 12.5, lon: 0 });
    assert.deepEqual(objects[0]?.attributes, { flux: "4.2", label: "alpha" });
    assert.equal("object_id" in (objects[0]?.attributes ?? {}), false);
    assert.equal("ra" in (objects[0]?.attributes ?? {}), false);
    assert.equal("dec" in (objects[0]?.attributes ?? {}), false);
    assert.equal(objects[0]?._id, stableObjectDocumentId("asset-a", "file-a", "source-1"));
    assert.equal(objects[0]?._id, second.objectDocuments?.[0]?._id);
    assert.match(objects[0]?._id ?? "", /^[a-f0-9]{64}$/);
    assert.equal(objects[0]?.asset_id, "asset-a");
    assert.equal(objects[0]?.source_file_id, "file-a");
    assert.equal(objects[0]?.scan_run_id, "run-a");
  });
});

test("writes geo_point longitude in the Elasticsearch range while preserving numeric RA", async () => {
  await withCsv("object_id,ra,dec\nsource-270,270,12.5\n", async (filePath) => {
    const result = await scanLocalCsv(filePath, options());
    const object = result.objectDocuments?.[0];
    assert.equal(object?.ra_deg, 270);
    assert.deepEqual(object?.sky_position, { lat: 12.5, lon: -90 });
  });
});

test("skips invalid and malformed rows and aggregates valid coverage facts", async () => {
  await withCsv([
    "object_id,ra,dec,quality\n",
    "valid-a,0,0,good\n",
    "invalid-ra,361,0,bad\n",
    "invalid-dec,10,90.1,bad\n",
    ",20,20,missing-id\n",
    "malformed,30,30,too,many,fields\n",
    "valid-b,0,0,good\n",
  ].join(""), async (filePath) => {
    const result = await scanLocalCsv(filePath, options());
    const objects = result.objectDocuments ?? [];

    assert.equal(result.summary.rowCount, 6);
    assert.equal(result.summary.objectCount, 2);
    assert.equal(result.summary.invalidRowCount, 4);
    assert.equal(result.summary.csvErrorCount, 1);
    assert.equal(result.coverageDocuments.length, 1);
    assert.equal(result.coverageDocuments[0]?.objectCount, 2);
    assert.equal(result.coverageDocuments[0]?.healpix_order, 8);
    assert.equal(result.coverageDocuments[0]?.healpix_pixel, objects[0]?.healpix_pixel);
    assert.equal(result.coverageDocuments[0]?.healpix_pixel, objects[1]?.healpix_pixel);
    assert.equal(result.coverageDocuments[0]?.asset_id, "asset-a");
    assert.equal(result.coverageDocuments[0]?.source_file_id, "file-a");
    assert.equal(result.coverageDocuments[0]?.scan_run_id, "run-a");
  });
});

test("rejects invalid configuration and missing or duplicate required columns", async () => {
  await withCsv("object_id,ra,dec\nsource,1,2\n", async (filePath) => {
    await assert.rejects(
      () => scanLocalCsv(filePath, options({ raColumn: "missing" })),
      LocalCsvScanHeaderError,
    );
    await assert.rejects(
      () => scanLocalCsv(filePath, options({ healpixOrder: 21 })),
      LocalCsvScanConfigurationError,
    );
  });

  await withCsv("object_id,ra,dec,dec\nsource,1,2,2\n", async (filePath) => {
    await assert.rejects(() => scanLocalCsv(filePath, options()), LocalCsvScanHeaderError);
  });
});

test("enforces configured row limits", async () => {
  await withCsv("object_id,ra,dec\na,1,2\nb,3,4\n", async (filePath) => {
    await assert.rejects(
      () => scanLocalCsv(filePath, options({ limits: { maxRows: 1 } })),
      /row limit exceeded/,
    );
  });
});

test("coverage identities are stable across scan runs for the same source cell", () => {
  const first = stableCoverageDocumentId("asset-a", "file-a", 8, 42);
  const repeated = stableCoverageDocumentId("asset-a", "file-a", 8, 42);
  const anotherSource = stableCoverageDocumentId("asset-a", "file-b", 8, 42);
  assert.equal(first, repeated);
  assert.notEqual(first, anotherSource);
});
