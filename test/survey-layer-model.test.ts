import assert from "node:assert/strict";
import test from "node:test";

import {
  adjacentNeighbours,
  buildSurveyLayerModel,
  isAdjacent,
  isAdjacentConnected,
  isSideConnected,
  overlapCountByPixel,
  sharesSide,
  sideNeighbours,
  SURVEY_LAYER_BASE_RADIUS,
  SURVEY_LAYER_DISPLAY_STEP,
  toggleConnectedRegion,
  visibleCoverageAtPixel,
  visibleSurveySlots,
} from "../src/survey-layer-model.js";
import type { SurveyFootprintManifest } from "../src/survey-footprints.js";

const manifest: SurveyFootprintManifest = {
  schemaVersion: 1,
  generatedAt: "2026-07-23T00:00:00.000Z",
  coordinateFrame: "ICRS",
  nside: 2,
  footprints: [
    {
      surveyId: "alpha",
      releaseId: "alpha-dr1",
      product: "catalog",
      label: "Alpha DR1",
      nside: 2,
      pixels: [0, 1],
      quality: "moc",
      sourceUrl: "https://example.test/alpha",
      retrievedAt: "2026-07-23T00:00:00.000Z",
      notes: "fixture",
    },
    {
      surveyId: "beta",
      releaseId: "beta-dr1",
      product: "imaging",
      label: "Beta DR1",
      nside: 2,
      pixels: [1, 2],
      quality: "official_overview",
      sourceUrl: "https://example.test/beta",
      retrievedAt: "2026-07-23T00:00:00.000Z",
      notes: "fixture",
    },
  ],
};

function lineOfThree(nside: number): [number, number, number] {
  for (let middle = 0; middle < 12 * nside ** 2; middle += 1) {
    const sides = sideNeighbours(nside, middle);
    for (const left of sides) {
      for (const right of sides) {
        if (left !== right && !isAdjacent(nside, left, right)) return [left, middle, right];
      }
    }
  }
  throw new Error("Fixture nside does not contain a three-cell side-connected line");
}

test("survey registry slots retain identity while visible slots are packed dynamically", () => {
  const model = buildSurveyLayerModel([{ id: "alpha" }, { id: "pending" }, { id: "beta" }], manifest);
  assert.deepEqual(model.slots, [
    { surveyId: "alpha", displayRadius: SURVEY_LAYER_BASE_RADIUS, hasFootprint: true },
    { surveyId: "pending", displayRadius: SURVEY_LAYER_BASE_RADIUS, hasFootprint: false },
    { surveyId: "beta", displayRadius: SURVEY_LAYER_BASE_RADIUS, hasFootprint: true },
  ]);
  assert.deepEqual(visibleSurveySlots(model, ["alpha", "pending", "beta"], "layers"), [
    { surveyId: "alpha", displayRadius: SURVEY_LAYER_BASE_RADIUS - SURVEY_LAYER_DISPLAY_STEP / 2, hasFootprint: true },
    { surveyId: "beta", displayRadius: SURVEY_LAYER_BASE_RADIUS + SURVEY_LAYER_DISPLAY_STEP / 2, hasFootprint: true },
  ]);
  assert.deepEqual(visibleSurveySlots(model, ["beta"], "layers"), [
    { surveyId: "beta", displayRadius: SURVEY_LAYER_BASE_RADIUS, hasFootprint: true },
  ]);
  assert.deepEqual(visibleSurveySlots(model, ["alpha", "beta"], "overlap").map((slot) => slot.displayRadius), [1, 1]);
  assert.deepEqual(model.coverageByPixel.get(1)?.surveyIds, ["alpha", "beta"]);
  assert.deepEqual(model.coverageByPixel.get(1)?.releaseIds, ["alpha-dr1", "beta-dr1"]);
  assert.deepEqual(model.coverageByPixel.get(1)?.artifacts.map((artifact) => artifact.quality), ["moc", "official_overview"]);
});

test("visible coverage and overlap counts exclude hidden and pending surveys", () => {
  const model = buildSurveyLayerModel([{ id: "alpha" }, { id: "pending" }, { id: "beta" }], manifest);
  assert.deepEqual(visibleCoverageAtPixel(model, 1, ["alpha"])?.surveyIds, ["alpha"]);
  assert.equal(visibleCoverageAtPixel(model, 2, ["alpha"]), null);
  assert.deepEqual([...overlapCountByPixel(model, ["alpha", "beta"])], [[0, 1], [1, 2], [2, 1]]);
  assert.deepEqual([...overlapCountByPixel(model, ["beta"])], [[1, 1], [2, 1]]);
});

test("one selected pixel retains every visible survey release and product source", () => {
  const expanded: SurveyFootprintManifest = {
    ...manifest,
    footprints: [
      ...manifest.footprints,
      {
        ...manifest.footprints[0]!,
        releaseId: "alpha-dr2",
        product: "spectroscopy",
        label: "Alpha DR2 spectra",
        sourceUrl: "https://example.test/alpha-dr2",
        pixels: [1],
      },
    ],
  };
  const model = buildSurveyLayerModel([{ id: "alpha" }, { id: "beta" }], expanded);
  const membership = visibleCoverageAtPixel(model, 1, ["alpha", "beta"]);
  assert.deepEqual(membership?.surveyIds, ["alpha", "beta"]);
  assert.deepEqual(membership?.releaseIds, ["alpha-dr1", "alpha-dr2", "beta-dr1"]);
  assert.deepEqual(membership?.artifacts.map((artifact) => `${artifact.surveyId}:${artifact.releaseId}:${artifact.product}`), [
    "alpha:alpha-dr1:catalog",
    "alpha:alpha-dr2:spectroscopy",
    "beta:beta-dr1:imaging",
  ]);
});

test("connected-region toggles prevent eight-neighbour fragmentation", () => {
  const nside = 8;
  const [left, middle, right] = lineOfThree(nside);
  assert.equal(sharesSide(nside, left, middle), true);
  assert.equal(sharesSide(nside, middle, right), true);
  assert.equal(sharesSide(nside, left, right), false);
  assert.equal(isAdjacent(nside, left, right), false);

  const first = toggleConnectedRegion(nside, [], middle, false);
  assert.deepEqual(first, { ok: true, pixels: [middle], changed: "replaced" });
  const second = toggleConnectedRegion(nside, first.pixels, left, true);
  assert.equal(second.ok, true);
  const third = toggleConnectedRegion(nside, second.pixels, right, true);
  assert.equal(third.ok, true);
  assert.equal(isSideConnected(nside, third.pixels), true);

  const split = toggleConnectedRegion(nside, third.pixels, middle, true);
  assert.equal(split.ok, false);
  if (!split.ok) assert.equal(split.reason, "would-disconnect");

  const unrelated = Array.from({ length: 12 * nside ** 2 }, (_, pixel) => pixel)
    .find((pixel) => !isAdjacent(nside, middle, pixel) && pixel !== middle);
  assert.notEqual(unrelated, undefined);
  const rejected = toggleConnectedRegion(nside, [middle], unrelated!, true);
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.reason, "not-adjacent");
});

test("region selection accepts every available HEALPix neighbour, including corners", () => {
  const nside = 8;
  const center = 100;
  const neighbours = adjacentNeighbours(nside, center);
  assert.equal(neighbours.length, 8);
  assert.equal(new Set(neighbours).size, 8);
  assert.equal(sideNeighbours(nside, center).length, 4);

  for (const neighbour of neighbours) {
    assert.equal(isAdjacent(nside, center, neighbour), true);
    const result = toggleConnectedRegion(nside, [center], neighbour, true);
    assert.equal(result.ok, true, `expected neighbour ${neighbour} to be selectable`);
    if (result.ok) assert.equal(isAdjacentConnected(nside, result.pixels), true);
  }

  const corner = neighbours.find((pixel) => !sharesSide(nside, center, pixel));
  assert.notEqual(corner, undefined);
  assert.equal(toggleConnectedRegion(nside, [center], corner!, true).ok, true);
});
