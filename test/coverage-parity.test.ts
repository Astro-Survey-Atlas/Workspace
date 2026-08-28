import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parse } from "csv-parse/sync";
import { Healpix, Hploc } from "healpixjs";

import { scanLocalCsv } from "../src/local-scan.js";
import type { MocCoreAdapter, MocCoreCatalogInput, MocCoreCatalogResult, MocCoreNestedHealpixInput } from "../src/moc-core-adapter.js";
import { UserMocArtifactStore, type UserMocArtifact, type UserMocArtifactContext } from "../src/user-moc-artifacts.js";

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

function mocForCells(cells: readonly { order: number; ipix: number }[]): Buffer {
  const values = [...cells]
    .sort((left, right) => left.order - right.order || left.ipix - right.ipix)
    .map((cell) => 4n * (4n ** BigInt(cell.order)) + BigInt(cell.ipix));
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

function cellsFromRows(rows: readonly Record<string, string>[]): Array<{ order: number; ipix: number }> {
  const healpix = new Healpix(256);
  const cells = rows.map((row) => {
    const ra = Number(row.ra) === 360 ? 0 : Number(row.ra);
    const dec = Number(row.dec);
    const location = new Hploc();
    location.setZ(Math.cos((90 - dec) * (Math.PI / 180)));
    location.phi = ((ra % 360) + 360) % 360 * (Math.PI / 180);
    return { order: 8, ipix: healpix.loc2pix(location) };
  });
  return [...new Map(cells.map((cell) => [`${cell.order}:${cell.ipix}`, cell])).values()].sort((left, right) => left.ipix - right.ipix);
}

function project(cells: readonly { order: number; ipix: number }[], targetOrder: number): number[] {
  const factor = 4 ** (8 - targetOrder);
  return [...new Set(cells.map((cell) => Math.floor(cell.ipix / factor)))].sort((left, right) => left - right);
}

function resultForCells(layerId: string, cells: readonly { order: number; ipix: number }[]): MocCoreCatalogResult {
  const queryPixels = [...new Set(cells.filter((cell) => cell.order === 8).map((cell) => cell.ipix))].sort((left, right) => left - right);
  const previewPixels = project(cells, 4);
  const query = Buffer.from(JSON.stringify({ schemaVersion: 1, order: 8, ordering: "NESTED", pixels: queryPixels }));
  const preview = Buffer.from(JSON.stringify({ schemaVersion: 1, order: 4, ordering: "NESTED", pixels: previewPixels }));
  const moc = mocForCells(cells);
  return {
    layerId,
    maxOrder: 10,
    queryOrder: 8,
    previewOrder: 4,
    queryPixels,
    previewPixels,
    artifacts: { moc, query, preview },
  };
}

/** A deterministic stand-in for the pinned Assets Core CLI in this contract test. */
const parityMocCore: MocCoreAdapter = {
  async buildCatalog(input: MocCoreCatalogInput): Promise<MocCoreCatalogResult> {
    const rows = parse(await readFile(input.inputPath, "utf8"), { columns: true, skip_empty_lines: true, trim: true }) as Array<Record<string, string>>;
    return resultForCells(input.layerId, cellsFromRows(rows));
  },
  async buildNestedHealpix(input: MocCoreNestedHealpixInput): Promise<MocCoreCatalogResult> {
    return resultForCells(input.layerId, input.cells);
  },
};

function context(overrides: Partial<UserMocArtifactContext> = {}): UserMocArtifactContext {
  return {
    layerId: "workspace-user-parity",
    scanRunId: "local-run",
    coverageRole: "object_presence",
    dataOrigin: "catalog",
    sourceTier: "user_file_derived",
    precision: "exact",
    availableOrders: [8],
    maxOrder: 10,
    ...overrides,
  };
}

function artifactMocSha256(artifact: UserMocArtifact): string | undefined {
  return artifact.files.find((file) => file.name === "moc.fits")?.sha256;
}

test("local CSV and Warehouse normalized evidence produce the same user MOC contract", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "astro-coverage-parity-"));
  const localRoot = path.join(root, "local");
  const remoteRoot = path.join(root, "remote");
  const evidenceRoot = path.join(root, "evidence");
  const csv = [
    "object_id,ra,dec,flux\n",
    "object-a,0,0,1.2\n",
    "object-boundary,0,1e-12,1.8\n",
    "object-b,10,20,2.4\n",
    "object-c,360,-12.5,3.6\n",
  ].join("");
  const sourcePath = path.join(root, "catalog.csv");
  await writeFile(sourcePath, csv, "utf8");
  try {
    const local = await scanLocalCsv(sourcePath, {
      objectIdColumn: "object_id",
      raColumn: "ra",
      decColumn: "dec",
      surveyId: "parity-survey",
      releaseId: "parity-release",
      product: "parity-catalog",
      modality: "catalog",
      assetId: "user-parity",
      sourceFileId: "file-parity",
      scanRunId: "local-run",
      mocCore: parityMocCore,
    });
    assert.ok(local.moc);
    const sourceSnapshotSha256 = createHash("sha256").update(csv).digest("hex");
    assert.equal(local.summary.sourceSnapshotSha256, sourceSnapshotSha256);
    const cells = local.coverageDocuments.map((document) => ({ order: document.healpix_order, ipix: document.healpix_pixel }));
    assert.ok(cells.length > 0);
    // The positive equatorial boundary must be counted in the same cell that
    // Assets Core returns; a routing-only trig approximation would emit zero
    // for the MOC cell and leave the local coverage fact internally broken.
    assert.equal(local.coverageDocuments.find((document) => document.healpix_pixel === 311296)?.objectCount, 2);

    const localStore = new UserMocArtifactStore({ root: localRoot });
    const localArtifact = await localStore.persist(local.moc, context({ sourceSnapshotSha256 }), {
      provenance: { schemaVersion: 1, coordinateFrame: "ICRS", ordering: "NESTED" },
    });

    await mkdir(evidenceRoot, { recursive: true });
    await writeFile(path.join(evidenceRoot, "normalized-scan.json"), `${JSON.stringify({
      schemaVersion: 1,
      phase: "COMPLETED",
      scanRunId: "warehouse-batch-parity",
      layerId: "workspace-user-parity",
      sourceSnapshot: { sha256: sourceSnapshotSha256, fileCount: 1, coverageCount: cells.length, errorCount: 0, availableOrders: [8] },
      files: [],
      coverage: cells.map(({ order, ipix }) => ({
        layer_id: "workspace-user-parity",
        source_file_id: "file-parity",
        source_uri: "s3://user/catalog.csv",
        healpix_order: order,
        healpix_cell: ipix,
        coordinate_frame: "ICRS",
        nesting: "NESTED",
        coverage_role: "object_presence",
        precision: "exact",
      })),
    })}\n`, "utf8");

    const remoteStore = new UserMocArtifactStore({ root: remoteRoot });
    const remoteArtifact = await remoteStore.importEvidence(evidenceRoot, context({
      scanRunId: "remote-run",
      evidenceScanRunId: "warehouse-batch-parity",
      sourceSnapshotSha256,
    }), parityMocCore);

    assert.equal(localArtifact.status, "ready");
    assert.equal(remoteArtifact.status, "ready");
    assert.equal(localArtifact.sourceSnapshotSha256, remoteArtifact.sourceSnapshotSha256);
    assert.deepEqual(localArtifact.availableOrders, remoteArtifact.availableOrders);
    assert.deepEqual(localArtifact.availableOrders, [8]);
    assert.equal(localArtifact.maxOrder, remoteArtifact.maxOrder);
    assert.equal(localArtifact.maxOrder, 10);
    assert.equal(localArtifact.coverageRole, remoteArtifact.coverageRole);
    assert.equal(localArtifact.coverageRole, "object_presence");
    assert.equal(localArtifact.precision, remoteArtifact.precision);
    assert.equal(localArtifact.precision, "exact");
    assert.equal(artifactMocSha256(localArtifact), artifactMocSha256(remoteArtifact));
    assert.deepEqual(await localStore.projection(localArtifact.layerId, localArtifact.scanRunId, 8), await remoteStore.projection(remoteArtifact.layerId, remoteArtifact.scanRunId, 8));
    assert.deepEqual(await localStore.projection(localArtifact.layerId, localArtifact.scanRunId, 4), await remoteStore.projection(remoteArtifact.layerId, remoteArtifact.scanRunId, 4));

    const localProvenance = JSON.parse(Buffer.from(await readFile((await localStore.filePath(localArtifact.layerId, localArtifact.scanRunId, "provenance.json")).filePath)).toString("utf8")) as Record<string, unknown>;
    assert.equal(localProvenance.coordinateFrame, "ICRS");
    assert.equal(localProvenance.ordering, "NESTED");
    assert.equal(localProvenance.sourceSnapshotSha256, sourceSnapshotSha256);
    assert.equal((localProvenance.snapshot as Record<string, unknown>).sha256, sourceSnapshotSha256);

    const remoteProvenance = JSON.parse(Buffer.from(await readFile((await remoteStore.filePath(remoteArtifact.layerId, remoteArtifact.scanRunId, "provenance.json")).filePath)).toString("utf8")) as Record<string, unknown>;
    assert.equal(remoteProvenance.sourceSnapshotSha256, sourceSnapshotSha256);
    assert.equal(remoteProvenance.evidenceScanRunId, "warehouse-batch-parity");
    assert.equal((remoteProvenance.snapshot as Record<string, unknown>).sha256, sourceSnapshotSha256);
    assert.equal((remoteProvenance.evidence as Record<string, unknown>).scanRunId, "warehouse-batch-parity");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
