import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeVolumePoints,
  expectedVolumeByteLength,
  VOLUME_FIELD_COUNT,
  VOLUME_FORMAT_VERSION,
  VOLUME_HEADER_BYTES,
  VOLUME_MAGIC,
} from "../src/volume-format.js";

function fixtureBinary(): ArrayBuffer {
  const count = 2;
  const buffer = new ArrayBuffer(expectedVolumeByteLength(count));
  const bytes = new Uint8Array(buffer);
  bytes.set([...VOLUME_MAGIC].map((character) => character.charCodeAt(0)));
  const view = new DataView(buffer);
  view.setUint32(8, VOLUME_FORMAT_VERSION, true);
  view.setUint32(12, count, true);
  view.setUint32(16, VOLUME_FIELD_COUNT, true);
  view.setUint32(20, VOLUME_HEADER_BYTES, true);
  const values = [150, 151, 2, 3, 0.5, 1.2, 0.001, 0.002, 1900, 3800];
  values.forEach((value, index) => view.setFloat32(VOLUME_HEADER_BYTES + index * 4, value, true));
  const targetOffset = Math.ceil((VOLUME_HEADER_BYTES + count * 5 * 4) / 8) * 8;
  view.setBigUint64(targetOffset, 42n, true);
  view.setBigUint64(targetOffset + 8, 84n, true);
  return buffer;
}

test("decodes the deterministic volume binary layout", () => {
  const points = decodeVolumePoints(fixtureBinary(), 2);
  assert.deepEqual([...points.raDeg], [150, 151]);
  assert.deepEqual([...points.decDeg], [2, 3]);
  assert.deepEqual([...points.targetId], [42n, 84n]);
  assert.ok(Math.abs(points.comovingDistanceMpc[1]! - 3800) < 1e-6);
});

test("rejects corrupt and mismatched volume payloads", () => {
  const binary = fixtureBinary();
  assert.throws(() => decodeVolumePoints(binary, 3), /point count mismatch/);
  new Uint8Array(binary)[0] = 0;
  assert.throws(() => decodeVolumePoints(binary), /volume magic/i);
});
