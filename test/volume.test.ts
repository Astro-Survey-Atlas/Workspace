import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { Healpix, Pointing } from "healpixjs";

import {
  expectedVolumeByteLength,
  VOLUME_FIELD_COUNT,
  VOLUME_FORMAT_VERSION,
  VOLUME_HEADER_BYTES,
  VOLUME_MAGIC,
  type VolumeManifest,
} from "../src/volume-format.js";
import { publicVolumeManifest, VolumeCatalog } from "../src/volume.js";

async function fixtureCatalog(): Promise<{ catalog: VolumeCatalog; root: string; manifest: VolumeManifest }> {
  const root = await mkdtemp(path.join(tmpdir(), "astro-volume-"));
  const directory = path.join(root, "fixture-volume");
  await mkdir(directory);
  const manifest: VolumeManifest = {
    schemaVersion: 1,
    id: "fixture-volume",
    name: "Fixture Volume",
    source: { fileName: "fixture.fits", hdu: "SPECZ", sourceRowCount: 1, filter: "fixture" },
    coordinateFrame: "ICRS",
    radialCoordinate: {
      kind: "comoving_distance",
      unit: "Mpc",
      cosmology: "Planck18",
      domainMinMpc: 0,
      domainMaxMpc: 6000,
      dataMinMpc: 100,
      dataMaxMpc: 100,
    },
    pointCount: 1,
    coverage: { raMinDeg: 150, raMaxDeg: 150, decMinDeg: 2, decMaxDeg: 2, centerRaDeg: 150, centerDecDeg: 2 },
    redshift: { min: 0.02, max: 0.02, median: 0.02 },
    shellLevels: [{ shellCount: 1, counts: [1] }],
    binary: {
      file: "points.bin",
      format: "astro-volume-v1",
      byteLength: expectedVolumeByteLength(1),
      endianness: "little",
      fields: ["raDeg", "decDeg", "bestZ", "zErr", "comovingDistanceMpc", "targetId"],
    },
    generatedAt: "2026-07-22T00:00:00.000Z",
  };
  await writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest));
  await writeFile(path.join(directory, "points.bin"), Buffer.alloc(manifest.binary.byteLength));
  return { catalog: new VolumeCatalog(root), root, manifest };
}

test("discovers manifests and resolves a verified binary path", async (context) => {
  const fixture = await fixtureCatalog();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const listed = await fixture.catalog.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.id, "fixture-volume");
  const resolved = await fixture.catalog.pointsPath("fixture-volume");
  assert.equal(resolved.filePath, path.join(fixture.root, "fixture-volume", "points.bin"));
  assert.equal(publicVolumeManifest(fixture.manifest).binary.url, "/api/volumes/fixture-volume/points.bin");
});

test("rejects invalid identifiers and missing volumes", async (context) => {
  const fixture = await fixtureCatalog();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  await assert.rejects(() => fixture.catalog.get("../escape"), /Invalid volume id/);
  await assert.rejects(() => fixture.catalog.get("missing"), /Volume not found/);
});

test("builds and reuses a HEALPix-radial object index for cell drill-down", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "astro-volume-query-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "query-volume");
  await mkdir(directory);
  const count = 3;
  const binary = Buffer.alloc(expectedVolumeByteLength(count));
  binary.write(VOLUME_MAGIC, 0, "ascii");
  binary.writeUInt32LE(VOLUME_FORMAT_VERSION, 8);
  binary.writeUInt32LE(count, 12);
  binary.writeUInt32LE(VOLUME_FIELD_COUNT, 16);
  binary.writeUInt32LE(VOLUME_HEADER_BYTES, 20);
  const fields = [
    [150, 150, 150],
    [2, 2, 2],
    [0.02, 0.4, 1.0],
    [0.001, 0.002, 0.003],
    [100, 2000, 4000],
  ];
  fields.forEach((values, field) => values.forEach((value, index) => binary.writeFloatLE(value!, VOLUME_HEADER_BYTES + (field * count + index) * 4)));
  const targetOffset = Math.ceil((VOLUME_HEADER_BYTES + count * 5 * 4) / 8) * 8;
  [11n, 22n, 33n].forEach((value, index) => binary.writeBigUInt64LE(value, targetOffset + index * 8));
  await writeFile(path.join(directory, "points.bin"), binary);
  const manifest: VolumeManifest = {
    schemaVersion: 1,
    id: "query-volume",
    name: "Query Volume",
    source: { fileName: "fixture.fits", hdu: "SPECZ", sourceRowCount: count, filter: "fixture" },
    coordinateFrame: "ICRS",
    radialCoordinate: { kind: "comoving_distance", unit: "Mpc", cosmology: "Planck18", domainMinMpc: 0, domainMaxMpc: 6000, dataMinMpc: 100, dataMaxMpc: 4000 },
    pointCount: count,
    coverage: { raMinDeg: 150, raMaxDeg: 150, decMinDeg: 2, decMaxDeg: 2, centerRaDeg: 150, centerDecDeg: 2 },
    redshift: { min: 0.02, max: 1, median: 0.4 },
    shellLevels: [{ shellCount: 1, counts: [count] }],
    binary: { file: "points.bin", format: "astro-volume-v1", byteLength: binary.length, endianness: "little", fields: ["raDeg", "decDeg", "bestZ", "zErr", "comovingDistanceMpc", "targetId"] },
    generatedAt: "2026-07-23T00:00:00Z",
  };
  await writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest));
  const catalog = new VolumeCatalog(root);
  const pixel = new Healpix(8).ang2pix(new Pointing(null, false, ((90 - 2) * Math.PI) / 180, (150 * Math.PI) / 180));
  const first = await catalog.queryCellPoints("query-volume", { nside: 8, pixel, radialBins: 2, radialBin: 0, offset: 0, limit: 1 });
  assert.equal(first.total, 2);
  assert.equal(first.points[0]?.targetId, "11");
  assert.equal(first.metrics.cacheHit, false);
  const second = await catalog.queryCellPoints("query-volume", { nside: 8, pixel, radialBins: 2, radialBin: 0, offset: 1, limit: 1 });
  assert.equal(second.points[0]?.targetId, "22");
  assert.equal(second.metrics.cacheHit, true);
  assert.equal(second.metrics.indexBuildMs, 0);
});
