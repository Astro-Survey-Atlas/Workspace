import assert from "node:assert/strict";
import test from "node:test";
import { calculateSkyOverlap as mvpOverlap } from "../src/sky-overlap.js";

test("all public MVP subsets intersect with local CSST while retaining local identity", () => {
  const ids = ["euclid", "desi", "legacy-surveys", "hst"];
  for (let mask = 1; mask < 16; mask++) {
    const selected = ids.filter((_, index) => mask & (1 << index));
    const sources = [...selected.map((id) => ({ id, surveyId: id, label: id, kind: "public" as const, nside: 256, pixels: [202250, 202272] })),
      { id: "workspace:asset:csst", surveyId: "csst", label: "CSST", kind: "workspace" as const, nside: 256, pixels: [202250] }];
    const overlap = mvpOverlap(sources, 256); assert.deepEqual(overlap.pixels, [202250]); assert.ok(overlap.sourceIds.includes("workspace:asset:csst"));
  }
});

import { commonOverlapNside, calculateSkyOverlap, privateOverlapOrders, type SkyOverlapSource } from "../src/sky-overlap.js";

function source(id: string, pixels: number[], nside = 4): SkyOverlapSource {
  return { id, label: id, kind: "workspace", nside, pixels };
}

function surveySource(id: string, surveyId: string, pixels: number[], nside = 4): SkyOverlapSource {
  return { ...source(id, pixels, nside), surveyId };
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

test("unions products within a survey before intersecting surveys", () => {
  const result = calculateSkyOverlap([
    surveySource("a-one", "survey-a", [0, 1]),
    surveySource("a-two", "survey-a", [2, 3]),
    surveySource("b-one", "survey-b", [1, 2, 3]),
  ], 4);
  assert.equal(result.status, "ready");
  assert.deepEqual(result.pixels, [1, 2, 3]);
  assert.deepEqual(result.sourceIds, ["a-one", "a-two", "b-one"]);
});

test("a selected survey with empty coverage cannot disappear from the intersection", () => {
  const selected = [surveySource("a", "survey-a", [0]), surveySource("b", "survey-b", [0]), surveySource("empty", "survey-c", [])];
  const result = calculateSkyOverlap(selected, 4);
  assert.equal(result.status, "empty");
  assert.deepEqual(result.sourceIds, ["a", "b", "empty"]);
  assert.deepEqual(result.components, []);
  assert.deepEqual(calculateSkyOverlap([...selected, surveySource("c", "survey-c", [0])], 4).pixels, [0]);
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


test("automatic overlap uses native order 8 but keeps a selected preview-only source", () => {
  const native = { ...source("native", [1], 16), kind: "public" as const, availableOrders: [4, 8] };
  assert.equal(commonOverlapNside([native, { ...native, id: "second" }]), 256);
  assert.equal(commonOverlapNside([native, source("legacy", [1], 16)]), 16);
  assert.equal(commonOverlapNside([]), 16);
});

test("an O10 private scan supplies an O8 query projection without refining a coarse scan", () => {
  const publicSource = { ...source("public", [1], 16), kind: "public" as const, availableOrders: [4, 8] };
  const privateSource = { ...source("csst", [1], 16), availableOrders: privateOverlapOrders([10]) };
  assert.deepEqual(privateSource.availableOrders, [4, 8]);
  assert.equal(commonOverlapNside([publicSource, privateSource]), 256);
  assert.deepEqual(privateOverlapOrders([4]), [4]);
  assert.equal(commonOverlapNside([publicSource, { ...privateSource, availableOrders: privateOverlapOrders([4]) }]), 16);
  assert.deepEqual(privateOverlapOrders([]), []);
});

test("a selected coarse product limits the common order for its survey", () => {
  const sources = [
    { ...surveySource("desi-spectra", "desi", [1], 16), availableOrders: [4, 8] },
    { ...surveySource("desi-redrock", "desi", [1], 16), availableOrders: [4] },
    { ...surveySource("euclid", "euclid", [1], 16), availableOrders: [4, 8] },
  ];
  assert.equal(commonOverlapNside(sources), 16);
  assert.equal(commonOverlapNside([...sources, { ...surveySource("csst", "csst", [1], 16), availableOrders: [4] }]), 16);
});

test("Legacy DR9 North constrains a selected DR10-plus-DR9 survey to O4", () => {
  const sources = [
    { ...surveySource("legacy-dr10", "legacy-surveys", [1], 16), availableOrders: [4, 8] },
    { ...surveySource("legacy-dr9-north", "legacy-surveys", [1], 16), availableOrders: [4] },
    { ...surveySource("euclid", "euclid", [1], 16), availableOrders: [4, 8] },
    { ...surveySource("desi", "desi", [1], 16), availableOrders: [4, 8] },
    { ...surveySource("hst", "hst", [1], 16), availableOrders: [4, 8] },
    { ...surveySource("csst", "csst", [1], 16), availableOrders: privateOverlapOrders([10]) },
  ];
  assert.equal(commonOverlapNside(sources), 16);
  assert.deepEqual(calculateSkyOverlap(sources, commonOverlapNside(sources)).pixels, [1]);
});
