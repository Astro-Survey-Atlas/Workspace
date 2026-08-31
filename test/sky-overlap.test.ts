import assert from "node:assert/strict";
import test from "node:test";

import { calculateSkyOverlap, type SkyOverlapSource } from "../src/sky-overlap.js";

function source(id: string, pixels: number[], nside = 4): SkyOverlapSource {
  return { id, label: id, kind: "workspace", nside, pixels };
}

test("intersects every source and reports connected components", () => {
  const result = calculateSkyOverlap([
    source("a", [0, 1, 50, 51]),
    source("b", [0, 1, 50, 51, 80]),
    source("c", [0, 1, 50, 51]),
  ], 4);
  assert.equal(result.status, "ready");
  assert.deepEqual(result.pixels, [0, 1, 50, 51]);
  assert.equal(result.components.length, 2);
  assert.deepEqual(result.components.map((component) => component.cells), [[0, 1], [50, 51]]);
  assert.ok(result.components.every((component) => component.areaDeg2 > 0));
  assert.ok(result.components.every((component) => component.sourceIds.join(",") === "a,b,c"));
});

test("returns an empty result when there is no common cell or fewer than two sources", () => {
  assert.equal(calculateSkyOverlap([source("a", [0]), source("b", [1])], 4).status, "empty");
  assert.deepEqual(calculateSkyOverlap([source("a", [0])], 4).components, []);
  assert.deepEqual(calculateSkyOverlap([], 4).sourceIds, []);
});

test("ignores invalid pixels and sources at a different order", () => {
  const result = calculateSkyOverlap([
    source("a", [0, -1, 192, 999]),
    source("b", [0], 2),
    source("c", [1], 4),
  ], 4);
  assert.equal(result.status, "empty");
  assert.deepEqual(result.sourceIds, ["a", "c"]);
  assert.throws(() => calculateSkyOverlap([source("a", [0]), source("b", [0])], 3), /power of two/);
});
