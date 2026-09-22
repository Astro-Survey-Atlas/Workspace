import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CoveragePreviewCache } from "../src/coverage-preview.js";

function coverageLine(cell: number, order = 8): string {
  return JSON.stringify({
    layer_id: "layer-1",
    source_file_id: "file-1",
    source_uri: "s3://bucket/file.fits",
    healpix_order: order,
    healpix_cell: cell,
    coordinate_frame: "ICRS",
    nesting: "NESTED",
    coverage_method: "fits_wcs",
    coverage_role: "footprint",
    modality: "image",
    precision: "estimated",
  });
}

test("coverage preview reads complete NDJSON lines and projects finer cells", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-coverage-preview-"));
  const evidence = path.join(directory, "evidence");
  await mkdir(evidence);
  try {
    await writeFile(path.join(evidence, ".coverage.ndjson"), `${coverageLine(1, 4)}\n${coverageLine(5, 4)}\n`);
    const cache = new CoveragePreviewCache(directory);
    const preview = await cache.preview("run-1", evidence, 16);
    assert.equal(preview?.preview, true);
    assert.equal(preview?.precision, "estimated");
    assert.deepEqual(preview?.pixels, [1, 5]);
    assert.equal(preview?.cellCount, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("coverage preview resumes from a byte offset and ignores incomplete lines", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-coverage-preview-"));
  const evidence = path.join(directory, "evidence");
  await mkdir(evidence);
  const file = path.join(evidence, ".coverage.ndjson");
  try {
    await writeFile(file, `${coverageLine(0, 4)}\n{"healpix_order":4`);
    const cache = new CoveragePreviewCache(directory);
    const first = await cache.preview("run-1", evidence, 16);
    assert.deepEqual(first?.pixels, [0]);
    await appendFile(file, `,"healpix_cell":1,"coordinate_frame":"ICRS","nesting":"NESTED"}\n${coverageLine(2, 4)}\n`);
    const second = await cache.preview("run-1", evidence, 16);
    assert.deepEqual(second?.pixels, [0, 1, 2]);
    assert.equal(second?.cellCount, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
