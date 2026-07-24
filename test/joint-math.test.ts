import assert from "node:assert/strict";
import test from "node:test";

import { healpixSolidAngleSteradian, parentNestedPixel, radialBinBounds, sphericalCellVolumeMpc3 } from "../src/joint-math.js";

test("maps NESTED HEALPix children to their parent", () => {
  assert.equal(parentNestedPixel(4 * 81 + 3, 64, 32), 81);
  assert.equal(parentNestedPixel(16 * 9 + 15, 128, 32), 9);
});

test("computes radial bounds and spherical cell volume", () => {
  assert.deepEqual(radialBinBounds(1, 4, 6000), [1500, 3000]);
  assert.ok(Math.abs(healpixSolidAngleSteradian(1) - Math.PI / 3) < 1e-12);
  assert.ok(Math.abs(sphericalCellVolumeMpc3(1, 0, 3) - 3 * Math.PI) < 1e-12);
});
