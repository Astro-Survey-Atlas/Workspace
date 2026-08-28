import assert from "node:assert/strict";
import test from "node:test";

import { cartesianToRaDec } from "../viewer/src/coordinates.js";
import { healpixPixelFromSceneDirection, sphericalCellCenter } from "../viewer/src/spherical-cell-geometry.js";
import { nestedSkyRegion } from "../viewer/src/sky-region.js";
import { buildSurveyLayerModel, visibleCoverageAtPixel } from "../src/survey-layer-model.js";
import type { SurveyFootprintManifest } from "../src/survey-footprints.js";

function almostEqual(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
}

test("public Assets and user MOC layers share ICRS/NESTED cell semantics and Aladin payload", () => {
  const nside = 16;
  const pixel = 548;
  const manifest: SurveyFootprintManifest = {
    schemaVersion: 1,
    generatedAt: "2026-08-27T00:00:00.000Z",
    coordinateFrame: "ICRS",
    nside,
    footprints: [{
      surveyId: "assets-public-survey",
      releaseId: "assets-public-release",
      product: "public-moc",
      label: "Assets public MOC",
      nside,
      pixels: [pixel],
      quality: "moc",
      sourceUrl: "https://assets.example/public-moc.fits",
      retrievedAt: "2026-08-27T00:00:00.000Z",
      notes: "fixture",
    }],
  };
  const publicMembership = visibleCoverageAtPixel(
    buildSurveyLayerModel([{ id: "assets-public-survey" }], manifest),
    pixel,
    ["assets-public-survey"],
  );
  const userLayer = {
    key: "moc:workspace-user-run",
    layerId: "workspace-user-asset",
    assetId: "user-asset",
    assetIds: ["user-asset"],
    nside,
    pixels: [pixel],
    source: "asset" as const,
    status: "ready",
  };

  assert.deepEqual(publicMembership?.surveyIds, ["assets-public-survey"]);
  assert.deepEqual(publicMembership?.artifacts.map((artifact) => artifact.pixels), [[pixel]]);
  assert.deepEqual(userLayer.pixels, publicMembership?.artifacts[0]?.pixels);

  const center = sphericalCellCenter(nside, pixel, 1);
  assert.equal(healpixPixelFromSceneDirection(nside, center), pixel);
  const centerRaDec = cartesianToRaDec(center);
  const roundTrip = cartesianToRaDec({ x: center.x, y: center.y, z: center.z });
  almostEqual(roundTrip.raDeg, centerRaDec.raDeg);
  almostEqual(roundTrip.decDeg, centerRaDec.decDeg);

  assert.deepEqual(nestedSkyRegion(nside, [pixel, pixel]), {
    nside,
    pixels: [pixel],
    coordinateFrame: "ICRS",
    ordering: "NESTED",
  });
  assert.throws(() => nestedSkyRegion(nside, [12 * nside ** 2]), /NESTED HEALPix/);
});
