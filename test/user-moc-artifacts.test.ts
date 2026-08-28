import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { UserMocArtifactStore, type UserMocArtifactContext } from "../src/user-moc-artifacts.js";
import type { MocCoreAdapter, MocCoreNestedHealpixInput, MocCoreCatalogResult } from "../src/moc-core-adapter.js";

const FITS_BLOCK_BYTES = 2_880;
const FITS_CARD_BYTES = 80;

function card(key: string, value: string | number): Buffer {
  const rendered = typeof value === "number" ? String(value).padStart(20, " ") : `'${value}'`.padEnd(20, " ");
  return Buffer.from(`${key.padEnd(8, " ")}= ${rendered}`.padEnd(FITS_CARD_BYTES, " "), "ascii");
}

function header(cards: Buffer[]): Buffer {
  const bytes = Buffer.concat([...cards, Buffer.from("END".padEnd(FITS_CARD_BYTES, " "), "ascii")]);
  return Buffer.concat([bytes, Buffer.alloc(Math.ceil(bytes.length / FITS_BLOCK_BYTES) * FITS_BLOCK_BYTES - bytes.length, 32)]);
}

function mocWithRows(values: bigint[]): Buffer {
  const primary = header([card("SIMPLE", "T"), card("BITPIX", 8), card("NAXIS", 0), card("EXTEND", "T")]);
  const extension = header([
    card("XTENSION", "BINTABLE"), card("BITPIX", 8), card("NAXIS", 2), card("NAXIS1", 8), card("NAXIS2", values.length),
    card("PCOUNT", 0), card("GCOUNT", 1), card("TFIELDS", 1), card("TTYPE1", "UNIQ"), card("TFORM1", "1K"),
    card("ORDERING", "NUNIQ"), card("COORDSYS", "C"), card("MOCVERS", "2.0"), card("MOCDIM", "SPACE"), card("THEAP", 0),
  ]);
  const rows = Buffer.alloc(values.length * 8);
  values.forEach((value, index) => rows.writeBigInt64BE(value, index * 8));
  return Buffer.concat([primary, extension, rows, Buffer.alloc((FITS_BLOCK_BYTES - (rows.length % FITS_BLOCK_BYTES)) % FITS_BLOCK_BYTES)]);
}

function validMoc(): Buffer {
  return mocWithRows([4n * (4n ** 8n) + 1n, 4n * (4n ** 4n) + 2n]);
}

function emptyMoc(): Buffer {
  return mocWithRows([]);
}

function context(overrides: Partial<UserMocArtifactContext> = {}): UserMocArtifactContext {
  return {
    layerId: "workspace-user-catalog",
    scanRunId: "run-001",
    coverageRole: "object_presence",
    sourceSnapshotSha256: "a".repeat(64),
    precision: "exact",
    maxOrder: 10,
    availableOrders: [4, 8, 10],
    ...overrides,
  };
}

function projectCells(cells: readonly { order: number; ipix: number }[], targetOrder: number): number[] {
  const result = new Set<number>();
  for (const cell of cells) {
    if (cell.order === targetOrder) result.add(cell.ipix);
    else if (cell.order > targetOrder) result.add(Math.floor(cell.ipix / 4 ** (cell.order - targetOrder)));
    else {
      const count = 4 ** (targetOrder - cell.order);
      for (let index = 0; index < count; index += 1) result.add(cell.ipix * count + index);
    }
  }
  return [...result].sort((left, right) => left - right);
}

function fakeNestedMocCore(moc = validMoc()): MocCoreAdapter {
  const build = async (input: MocCoreNestedHealpixInput): Promise<MocCoreCatalogResult> => {
    const queryPixels = projectCells(input.cells, 8);
    const previewPixels = projectCells(input.cells, 4);
    const query = Buffer.from(JSON.stringify({ schemaVersion: 1, order: 8, ordering: "NESTED", pixels: queryPixels }));
    const preview = Buffer.from(JSON.stringify({ schemaVersion: 1, order: 4, ordering: "NESTED", pixels: previewPixels }));
    return {
      layerId: input.layerId,
      maxOrder: input.maxOrder ?? 10,
      queryOrder: 8,
      previewOrder: 4,
      queryPixels,
      previewPixels,
      mocSha256: createHash("sha256").update(moc).digest("hex"),
      artifacts: { moc, query, preview },
    };
  };
  return {
    buildCatalog: async () => build({ layerId: "unused", cells: [], coverageRole: "object_presence", dataOrigin: "catalog", sourceTier: "user_file_derived" }),
    buildNestedHealpix: build,
  };
}

async function writeEvidence(root: string, value: Record<string, unknown>): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "normalized-scan.json"), `${JSON.stringify(value)}\n`, "utf8");
}

function normalizedEvidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    phase: "COMPLETED",
    scanRunId: "warehouse-batch-001",
    layerId: "workspace-user-catalog",
    sourceSnapshot: {
      sha256: "a".repeat(64),
      fileCount: 1,
      coverageCount: 1,
      errorCount: 0,
      availableOrders: [8],
    },
    files: [],
    coverage: [{
      layer_id: "workspace-user-catalog",
      source_file_id: "file-001",
      source_uri: "s3://user/catalog.csv",
      healpix_order: 8,
      healpix_cell: 10,
      coordinate_frame: "ICRS",
      nesting: "NESTED",
      coverage_role: "object_presence",
      precision: "exact",
    }],
    ...overrides,
  };
}

test("persists a validated FITS MOC and serves its fixed-order projections", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "astro-user-mocs-"));
  try {
    const store = new UserMocArtifactStore({ root });
    const moc = validMoc();
    const query = Buffer.from(JSON.stringify({ schemaVersion: 1, order: 8, ordering: "NESTED", pixels: [1, 2] }));
    const preview = Buffer.from(JSON.stringify({ schemaVersion: 1, order: 4, ordering: "NESTED", pixels: [0] }));
    const artifact = await store.persist({
      layerId: "workspace-user-catalog",
      maxOrder: 10,
      queryOrder: 8,
      previewOrder: 4,
      queryPixels: [1, 2],
      previewPixels: [0],
      mocSha256: createHash("sha256").update(moc).digest("hex"),
      artifacts: { moc, query, preview },
    }, context());

    assert.equal(artifact.status, "ready");
    // Source orders are declared by the scan context. The FITS MOC contains a
    // compressed order-4 parent, but that parent is not a native measurement.
    assert.deepEqual(artifact.availableOrders, [4, 8, 10]);
    assert.equal(artifact.maxOrder, 10);
    assert.equal(artifact.sourceSnapshotSha256, "a".repeat(64));
    assert.deepEqual(artifact.files.map((file) => file.name), ["moc.fits", "query-order8.json", "preview-order4.json", "provenance.json"]);
    assert.equal(artifact.files[0]?.sha256, createHash("sha256").update(moc).digest("hex"));

    assert.deepEqual(await store.projection(artifact.layerId, artifact.scanRunId, 4), { order: 4, pixels: [0] });
    assert.deepEqual(await store.projection(artifact.layerId, artifact.scanRunId, 8), { order: 8, pixels: [1, 2] });
    assert.deepEqual(await store.projection(artifact.layerId, artifact.scanRunId, 6), { order: 6, pixels: [0] });
    const served = await store.filePath(artifact.layerId, artifact.scanRunId, "moc.fits");
    assert.equal((await stat(served.filePath)).size, moc.length);
    assert.deepEqual(await readFile(served.filePath), moc);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not mark an artifact ready when MOC Core emits invalid FITS", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "astro-user-mocs-invalid-"));
  try {
    const store = new UserMocArtifactStore({ root });
    await assert.rejects(() => store.persist({
      layerId: "workspace-user-catalog",
      maxOrder: 10,
      queryOrder: 8,
      previewOrder: 4,
      queryPixels: [1],
      previewPixels: [0],
      artifacts: { moc: Buffer.from("not-a-fits-file") },
    }, context()), /MOC FITS byte length/);

    const failed = await store.fail(context(), "MOC Core unavailable", "unavailable");
    assert.equal(failed.status, "unavailable");
    assert.deepEqual(await store.projection(failed.layerId, failed.scanRunId, 4), { order: 4, pixels: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("imports completed Warehouse normalized evidence and preserves its native order", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "astro-user-mocs-evidence-"));
  const evidence = await mkdtemp(path.join(os.tmpdir(), "astro-warehouse-evidence-"));
  try {
    const store = new UserMocArtifactStore({ root });
    await writeEvidence(evidence, normalizedEvidence());
    const artifact = await store.importEvidence(evidence, context({
      scanRunId: "workspace-run-001",
      evidenceScanRunId: "warehouse-batch-001",
      availableOrders: [4, 8, 10],
    }), fakeNestedMocCore());

    assert.equal(artifact.status, "ready");
    assert.deepEqual(artifact.availableOrders, [8]);
    assert.equal(artifact.maxOrder, 10);
    assert.equal(artifact.sourceSnapshotSha256, "a".repeat(64));
    assert.deepEqual(artifact.files.map((file) => file.name), ["moc.fits", "query-order8.json", "preview-order4.json", "provenance.json"]);
    assert.deepEqual(await store.projection(artifact.layerId, artifact.scanRunId, 8), { order: 8, pixels: [10] });
    assert.deepEqual(await store.projection(artifact.layerId, artifact.scanRunId, 4), { order: 4, pixels: [0] });
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(evidence, { recursive: true, force: true }),
    ]);
  }
});

test("imports an order-4 Warehouse source without claiming order 8 measurements", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "astro-user-mocs-order4-"));
  const evidence = await mkdtemp(path.join(os.tmpdir(), "astro-warehouse-evidence-order4-"));
  try {
    const store = new UserMocArtifactStore({ root });
    await writeEvidence(evidence, normalizedEvidence({
      sourceSnapshot: { sha256: "a".repeat(64), fileCount: 1, coverageCount: 1, errorCount: 0, availableOrders: [4] },
      coverage: [{
        layer_id: "workspace-user-catalog", source_file_id: "file-001", healpix_order: 4, healpix_cell: 2,
        coordinate_frame: "ICRS", nesting: "NESTED", coverage_role: "object_presence", precision: "exact",
      }],
    }));
    const artifact = await store.importEvidence(evidence, context({ evidenceScanRunId: "warehouse-batch-001", availableOrders: [4, 8] }), fakeNestedMocCore());
    assert.equal(artifact.status, "ready");
    assert.deepEqual(artifact.availableOrders, [4]);
    // The source only measured order 4. An order-8 query artifact would be a
    // synthetic refinement, so it is deliberately omitted from the store.
    assert.deepEqual(artifact.files.map((file) => file.name), ["moc.fits", "preview-order4.json", "provenance.json"]);
    assert.deepEqual(await store.projection(artifact.layerId, artifact.scanRunId, 8), { order: 8, pixels: [] });
    await assert.rejects(() => store.filePath(artifact.layerId, artifact.scanRunId, "query-order8.json"), /file not found/);
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(evidence, { recursive: true, force: true }),
    ]);
  }
});

test("turns successful empty Warehouse coverage into a ready empty MOC", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "astro-user-mocs-empty-"));
  const evidence = await mkdtemp(path.join(os.tmpdir(), "astro-warehouse-evidence-empty-"));
  try {
    const store = new UserMocArtifactStore({ root });
    await writeEvidence(evidence, normalizedEvidence({
      sourceSnapshot: { sha256: "a".repeat(64), fileCount: 0, coverageCount: 0, errorCount: 0, availableOrders: [] },
      files: [], coverage: [],
    }));
    const artifact = await store.importEvidence(evidence, context({ evidenceScanRunId: "warehouse-batch-001", availableOrders: [], maxOrder: 10 }), fakeNestedMocCore(emptyMoc()));
    assert.equal(artifact.status, "ready");
    assert.deepEqual(artifact.availableOrders, []);
    assert.deepEqual(await store.projection(artifact.layerId, artifact.scanRunId, 4), { order: 4, pixels: [] });
    assert.deepEqual(artifact.files.map((file) => file.name), ["moc.fits", "provenance.json"]);
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(evidence, { recursive: true, force: true }),
    ]);
  }
});

test("keeps the authority order finite when empty evidence has no statistics", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "astro-user-mocs-no-statistics-"));
  const evidence = await mkdtemp(path.join(os.tmpdir(), "astro-warehouse-evidence-no-statistics-"));
  try {
    const store = new UserMocArtifactStore({ root });
    await writeEvidence(evidence, normalizedEvidence({
      sourceSnapshot: { sha256: "a".repeat(64), fileCount: 0, coverageCount: 0, errorCount: 0, availableOrders: [] },
      files: [], coverage: [],
    }));
    const artifact = await store.importEvidence(evidence, context({ maxOrder: undefined, availableOrders: [], evidenceScanRunId: "warehouse-batch-001" }), fakeNestedMocCore(emptyMoc()));
    assert.equal(artifact.status, "ready");
    assert.equal(artifact.maxOrder, 10);
    assert.ok(Number.isSafeInteger(artifact.maxOrder));
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(evidence, { recursive: true, force: true }),
    ]);
  }
});

test("rejects an invalid authority order in Warehouse statistics", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "astro-user-mocs-invalid-statistics-"));
  const evidence = await mkdtemp(path.join(os.tmpdir(), "astro-warehouse-evidence-invalid-statistics-"));
  try {
    const store = new UserMocArtifactStore({ root });
    await writeEvidence(evidence, normalizedEvidence());
    await writeFile(path.join(evidence, "statistics.json"), JSON.stringify({ maxOrder: "not-an-order" }));
    const artifact = await store.importEvidence(evidence, context({ maxOrder: undefined, evidenceScanRunId: "warehouse-batch-001" }), fakeNestedMocCore());
    assert.equal(artifact.status, "failed");
    assert.match(artifact.error ?? "", /statistics\.maxOrder/);
    assert.deepEqual(await store.projection(artifact.layerId, artifact.scanRunId, 4), { order: 4, pixels: [] });
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(evidence, { recursive: true, force: true }),
    ]);
  }
});

test("does not create a ready artifact for FAILED Warehouse evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "astro-user-mocs-failed-evidence-"));
  const evidence = await mkdtemp(path.join(os.tmpdir(), "astro-warehouse-evidence-failed-"));
  try {
    const store = new UserMocArtifactStore({ root });
    await writeEvidence(evidence, normalizedEvidence({ phase: "FAILED" }));
    const artifact = await store.importEvidence(evidence, context({ evidenceScanRunId: "warehouse-batch-001" }), fakeNestedMocCore());
    assert.equal(artifact.status, "failed");
    assert.match(artifact.error ?? "", /not complete/);
    assert.deepEqual(await store.projection(artifact.layerId, artifact.scanRunId, 4), { order: 4, pixels: [] });
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(evidence, { recursive: true, force: true }),
    ]);
  }
});

test("rejects Warehouse evidence identity, hash, and coordinate mismatches", async () => {
  const cases: Array<[string, Record<string, unknown>, Partial<UserMocArtifactContext>, RegExp]> = [
    ["source snapshot hash", normalizedEvidence(), { sourceSnapshotSha256: "b".repeat(64) }, /source snapshot SHA-256 does not match/],
    ["layer identity", normalizedEvidence({ layerId: "another-layer" }), {}, /layer identity does not match/],
    ["ICRS", normalizedEvidence({ coverage: [{ ...normalizedEvidence().coverage instanceof Array ? (normalizedEvidence().coverage as Array<Record<string, unknown>>)[0] : {}, coordinate_frame: "GALACTIC" }] }), {}, /must use ICRS/],
    ["NESTED", normalizedEvidence({ coverage: [{ ...normalizedEvidence().coverage instanceof Array ? (normalizedEvidence().coverage as Array<Record<string, unknown>>)[0] : {}, nesting: "RING" }] }), {}, /must use NESTED/],
  ];
  for (const [label, evidenceValue, contextOverrides, expected] of cases) {
    const root = await mkdtemp(path.join(os.tmpdir(), `astro-user-mocs-mismatch-${label.replace(/\s+/g, "-")}-`));
    const evidence = await mkdtemp(path.join(os.tmpdir(), `astro-warehouse-evidence-mismatch-${label.replace(/\s+/g, "-")}-`));
    try {
      const store = new UserMocArtifactStore({ root });
      await writeEvidence(evidence, evidenceValue);
      const artifact = await store.importEvidence(evidence, context({ evidenceScanRunId: "warehouse-batch-001", ...contextOverrides }), fakeNestedMocCore());
      assert.equal(artifact.status, "failed", label);
      assert.match(artifact.error ?? "", expected, label);
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(evidence, { recursive: true, force: true }),
      ]);
    }
  }
});

test("rejects a MOC Core SHA-256 that does not match the FITS bytes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "astro-user-mocs-hash-"));
  try {
    const store = new UserMocArtifactStore({ root });
    const moc = validMoc();
    await assert.rejects(() => store.persist({
      layerId: "workspace-user-catalog",
      maxOrder: 10,
      queryOrder: 8,
      previewOrder: 4,
      queryPixels: [1],
      previewPixels: [0],
      mocSha256: "b".repeat(64),
      artifacts: { moc },
    }, context()), /does not match emitted FITS bytes/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects tampered user MOC files during download and projection", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "astro-user-mocs-integrity-"));
  try {
    const store = new UserMocArtifactStore({ root });
    const moc = validMoc();
    const query = Buffer.from(JSON.stringify({ schemaVersion: 1, order: 8, ordering: "NESTED", pixels: [1] }));
    const preview = Buffer.from(JSON.stringify({ schemaVersion: 1, order: 4, ordering: "NESTED", pixels: [0] }));
    const artifact = await store.persist({
      layerId: "workspace-user-catalog",
      maxOrder: 10,
      queryOrder: 8,
      previewOrder: 4,
      queryPixels: [1],
      previewPixels: [0],
      artifacts: { moc, query, preview },
    }, context());

    const queryPath = path.join(root, artifact.layerId, artifact.scanRunId, "query-order8.json");
    await writeFile(queryPath, Buffer.from(JSON.stringify({ schemaVersion: 1, order: 8, ordering: "NESTED", pixels: [2] })));
    await assert.rejects(() => store.projection(artifact.layerId, artifact.scanRunId, 8), /integrity check failed/);

    const mocPath = path.join(root, artifact.layerId, artifact.scanRunId, "moc.fits");
    const tampered = Buffer.from(moc);
    tampered[0] = tampered[0]! ^ 1;
    await writeFile(mocPath, tampered);
    await assert.rejects(() => store.filePath(artifact.layerId, artifact.scanRunId, "moc.fits"), /integrity check failed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
