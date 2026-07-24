import assert from "node:assert/strict";
import test from "node:test";

import { expandMocToNside, fieldOverviewPixels, FOOTPRINT_NSIDE } from "../scripts/build_survey_footprints.js";

test("MOC cells expand and compact to a fixed display order", () => {
  assert.deepEqual(expandMocToNside({ "0": [1] }, 1), [4, 5, 6, 7]);
  assert.deepEqual(expandMocToNside({ "3": [20, 21, 22, 23] }, 2), [5]);
});

test("Euclid field overview has deterministic visible cells", () => {
  const fields = [{ name: "fixture", raDeg: 61.241, decDeg: -48.423, areaDeg2: 28.1 }];
  const pixels = fieldOverviewPixels(fields, FOOTPRINT_NSIDE);
  assert.ok(pixels.length > 0);
  assert.ok(pixels.every((pixel) => pixel >= 0 && pixel < 12 * FOOTPRINT_NSIDE ** 2));
  assert.deepEqual(pixels, fieldOverviewPixels(fields, FOOTPRINT_NSIDE));
});
