import assert from "node:assert/strict";
import test from "node:test";

import {
  ATLAS_ANGULAR_MAGIC,
  ATLAS_ANGULAR_RECORD_BYTES,
  ATLAS_FORMAT_VERSION,
  ATLAS_HEADER_BYTES,
  ATLAS_JOINT_MAGIC,
  ATLAS_JOINT_RECORD_BYTES,
  atlasAngularByteLength,
  atlasJointByteLength,
  decodeAtlasAngularCells,
  decodeAtlasJointCells,
} from "../src/atlas-format.js";

function fixture(magic: string, recordBytes: number, length: number): ArrayBuffer {
  const buffer = new ArrayBuffer(length);
  const bytes = new Uint8Array(buffer);
  bytes.set([...magic].map((value) => value.charCodeAt(0)));
  const view = new DataView(buffer);
  view.setUint32(8, ATLAS_FORMAT_VERSION, true);
  view.setUint32(12, 1, true);
  view.setUint32(16, recordBytes, true);
  view.setUint32(20, ATLAS_HEADER_BYTES, true);
  return buffer;
}

test("decodes angular atlas cells", () => {
  const buffer = fixture(ATLAS_ANGULAR_MAGIC, ATLAS_ANGULAR_RECORD_BYTES, atlasAngularByteLength(1));
  const view = new DataView(buffer);
  view.setUint16(32, 2, true);
  view.setUint16(34, 128, true);
  view.setUint32(36, 9912, true);
  view.setUint32(40, 73, true);
  const cells = decodeAtlasAngularCells(buffer);
  assert.deepEqual([cells.surveyIndex[0], cells.nside[0], cells.pixel[0], cells.objectCount[0]], [2, 128, 9912, 73]);
});

test("decodes joint atlas cells", () => {
  const buffer = fixture(ATLAS_JOINT_MAGIC, ATLAS_JOINT_RECORD_BYTES, atlasJointByteLength(1));
  const view = new DataView(buffer);
  view.setUint16(32, 0, true);
  view.setUint16(34, 64, true);
  view.setUint16(36, 16, true);
  view.setUint16(38, 7, true);
  view.setUint32(40, 1201, true);
  view.setUint32(44, 19, true);
  const cells = decodeAtlasJointCells(buffer);
  assert.deepEqual(
    [cells.surveyIndex[0], cells.nside[0], cells.radialBins[0], cells.radialBin[0], cells.pixel[0], cells.objectCount[0]],
    [0, 64, 16, 7, 1201, 19],
  );
});

test("rejects truncated atlas binaries", () => {
  assert.throws(() => decodeAtlasAngularCells(new ArrayBuffer(8)), /shorter than its header/);
});
