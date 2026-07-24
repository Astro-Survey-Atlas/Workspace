import assert from "node:assert/strict";
import test from "node:test";

import { radialShellBoundaries, radialShellIndex, volumePosition } from "../viewer/src/volume-math.js";

test("maps comoving distance linearly into the exterior 3D sphere", () => {
  const position = volumePosition(0, 0, 3000, 6000);
  assert.ok(Math.abs(position.x) < 1e-12);
  assert.ok(Math.abs(position.y) < 1e-12);
  assert.ok(Math.abs(position.z + 0.5) < 1e-12);
});

test("builds deterministic binary radial shell boundaries", () => {
  assert.deepEqual(radialShellBoundaries(6000, 4), [1500, 3000, 4500, 6000]);
  assert.equal(radialShellIndex(0, 6000, 8), 0);
  assert.equal(radialShellIndex(749.9, 6000, 8), 0);
  assert.equal(radialShellIndex(750, 6000, 8), 1);
  assert.equal(radialShellIndex(6000, 6000, 8), 7);
});
