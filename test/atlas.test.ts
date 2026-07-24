import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AtlasCatalog } from "../src/atlas.js";
import {
  ATLAS_ANGULAR_MAGIC,
  ATLAS_ANGULAR_RECORD_BYTES,
  ATLAS_FORMAT_VERSION,
  ATLAS_HEADER_BYTES,
  ATLAS_JOINT_MAGIC,
  ATLAS_JOINT_RECORD_BYTES,
  atlasAngularByteLength,
  atlasJointByteLength,
  type SurveyAtlasManifest,
} from "../src/atlas-format.js";

function header(buffer: Buffer, magic: string, count: number, recordBytes: number): void {
  buffer.write(magic, 0, "ascii");
  buffer.writeUInt32LE(ATLAS_FORMAT_VERSION, 8);
  buffer.writeUInt32LE(count, 12);
  buffer.writeUInt32LE(recordBytes, 16);
  buffer.writeUInt32LE(ATLAS_HEADER_BYTES, 20);
}

async function fixture(): Promise<{ catalog: AtlasCatalog; id: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "astro-atlas-"));
  const id = "fixture-atlas";
  const directory = path.join(root, id);
  await mkdir(directory);
  const angular = Buffer.alloc(atlasAngularByteLength(1));
  header(angular, ATLAS_ANGULAR_MAGIC, 1, ATLAS_ANGULAR_RECORD_BYTES);
  angular.writeUInt16LE(0, 32);
  angular.writeUInt16LE(8, 34);
  angular.writeUInt32LE(10, 36);
  angular.writeUInt32LE(10, 40);
  await writeFile(path.join(directory, "angular.bin"), angular);

  const records = [
    [8, 1, 0, 10, 10],
    [16, 1, 0, 40, 7],
    [16, 1, 0, 41, 3],
    [8, 2, 0, 10, 4],
    [8, 2, 1, 10, 6],
  ];
  const joint = Buffer.alloc(atlasJointByteLength(records.length));
  header(joint, ATLAS_JOINT_MAGIC, records.length, ATLAS_JOINT_RECORD_BYTES);
  records.forEach(([nside, radialBins, radialBin, pixel, count], index) => {
    const offset = ATLAS_HEADER_BYTES + index * ATLAS_JOINT_RECORD_BYTES;
    joint.writeUInt16LE(0, offset);
    joint.writeUInt16LE(nside!, offset + 2);
    joint.writeUInt16LE(radialBins!, offset + 4);
    joint.writeUInt16LE(radialBin!, offset + 6);
    joint.writeUInt32LE(pixel!, offset + 8);
    joint.writeUInt32LE(count!, offset + 12);
  });
  await writeFile(path.join(directory, "joint.bin"), joint);

  const coverage = { raMinDeg: 149, raMaxDeg: 151, decMinDeg: 1, decMaxDeg: 3, centerRaDeg: 150, centerDecDeg: 2 };
  const radialCoordinate = {
    kind: "comoving_distance" as const,
    unit: "Mpc" as const,
    sourceVolumeId: "fixture-volume",
    cosmology: "Planck18" as const,
    domainMinMpc: 0 as const,
    domainMaxMpc: 6000,
    semantics: "redshift_inferred" as const,
  };
  const manifest: SurveyAtlasManifest = {
    schemaVersion: 1,
    id,
    name: "Fixture Atlas",
    coordinateFrame: "ICRS",
    layerRadiusSemantics: "visual_offset_only",
    surveys: [
      { id: "desi", name: "DESI", modality: "spectroscopy", color: "#fff000", objectCount: 10, coverage, radialCoordinate },
      { id: "hsc", name: "HSC", modality: "optical", color: "#00ffff", objectCount: 10, coverage, radialCoordinate: null },
    ],
    angularLevels: [8, 16],
    angularLevelSummaries: [],
    angularBinary: { file: "angular.bin", format: "astro-atlas-angular-v1", byteLength: angular.length, recordCount: 1, recordBytes: 16 },
    jointIndex: {
      file: "joint.bin",
      format: "astro-atlas-joint-v1",
      byteLength: joint.length,
      recordCount: records.length,
      recordBytes: 20,
      surveyId: "desi",
      angularLevels: [8, 16],
      radialLevels: [1, 2],
      radialCoordinate,
      levelSummaries: [],
    },
    sources: [],
    generatedAt: "2026-07-22T00:00:00Z",
  };
  await writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest));
  return { catalog: new AtlasCatalog(root), id };
}

test("queries sparse HEALPix radial cells without scanning point rows", async () => {
  const { catalog, id } = await fixture();
  const result = await catalog.queryJoint(id, { surveyId: "desi", nside: 8, radialBins: 2, radialMinMpc: 0, radialMaxMpc: 3000 });
  assert.equal(result.representedObjects, 4);
  assert.equal(result.cells.length, 1);
  assert.equal(result.metrics.examinedCellCount, 2);
  assert.ok(result.cells[0]!.volumeMpc3 > 0);
});

test("recommends a conserving independent refinement axis", async () => {
  const { catalog, id } = await fixture();
  const result = await catalog.refinement(id, "desi", 8, 1, 10, 0);
  assert.equal(result.parentCount, 10);
  assert.deepEqual(result.angular.childCounts, [7, 3, 0, 0]);
  assert.deepEqual(result.radial.childCounts, [4, 6]);
  assert.equal(result.angular.conserved, true);
  assert.equal(result.radial.conserved, true);
  assert.equal(result.recommendedAxis, "angular");
});
