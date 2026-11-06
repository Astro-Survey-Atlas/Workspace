import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { UserMocArtifactStore, type UserMocArtifactContext } from "../src/user-moc-artifacts.js";

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

test("native overlap projections retain O10 gaps hidden by the O8 query sidecar", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "astro-user-moc-high-overlap-"));
  try {
    const store = new UserMocArtifactStore({ root });
    const moc = mocWithRows([4n * 4n ** 10n + 300n, 4n * 4n ** 10n + 302n]);
    const artifact = await store.persist({ layerId: "high", maxOrder: 10, queryOrder: 8, previewOrder: 4,
      queryPixels: [18], previewPixels: [0], artifacts: { moc } }, context({ layerId: "high", availableOrders: [10] }));
    assert.deepEqual(await store.projectionRanges(artifact.layerId, artifact.scanRunId, 10), [{ start: 300, end: 301 }, { start: 302, end: 303 }]);
    assert.deepEqual(await store.projectionRanges(artifact.layerId, artifact.scanRunId, 11), []);
    const file = await store.filePath(artifact.layerId, artifact.scanRunId, "moc.fits");
    await writeFile(file.filePath, Buffer.alloc(moc.length));
    await assert.rejects(() => store.projectionRanges(artifact.layerId, artifact.scanRunId, 10), /integrity check failed/);
  } finally { await rm(root, { recursive: true, force: true }); }
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
