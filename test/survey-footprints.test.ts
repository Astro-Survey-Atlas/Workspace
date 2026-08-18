import assert from "node:assert/strict";
import test from "node:test";

import { expandMocToNside, FOOTPRINT_NSIDE, parseDs9IcrsPolygons, rasterizeIcrsPolygons } from "../scripts/build_survey_footprints.js";

test("MOC cells expand and compact to a fixed display order", () => {
  assert.deepEqual(expandMocToNside({ "0": [1] }, 1), [4, 5, 6, 7]);
  assert.deepEqual(expandMocToNside({ "3": [20, 21, 22, 23] }, 2), [5]);
});

test("ICRS DS9 polygons rasterize deterministically into inclusive NESTED cells", () => {
  const polygons = parseDs9IcrsPolygons(`
# DS9 fixture
global color=black
icrs
polygon(50.0,-28.0, 50.8,-28.0, 50.8,-28.8, 50.0,-28.8)
`);
  assert.equal(polygons.length, 1);
  assert.equal(polygons[0]?.length, 4);
  const pixels = rasterizeIcrsPolygons(polygons, FOOTPRINT_NSIDE, 8);
  assert.ok(pixels.length > 0);
  assert.ok(pixels.every((pixel) => pixel >= 0 && pixel < 12 * FOOTPRINT_NSIDE ** 2));
  assert.deepEqual(pixels, rasterizeIcrsPolygons(polygons, FOOTPRINT_NSIDE, 8));
});

test("DS9 geometry rejects unsupported coordinate frames and malformed polygons", () => {
  assert.throws(() => parseDs9IcrsPolygons("fk5\npolygon(1,2,3,4,5,6)"), /Unsupported/);
  assert.throws(() => parseDs9IcrsPolygons("icrs\npolygon(1,2,3,4,5)"), /Invalid/);
});
