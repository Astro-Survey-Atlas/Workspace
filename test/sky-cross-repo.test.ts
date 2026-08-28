import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { cartesianToRaDec, circularMidpoint, raDecToCartesian } from "../viewer/src/coordinates.js";
import {
  healpixPixelFromSceneDirection,
  sphericalCellBoundary,
  sphericalCellCenter,
} from "../viewer/src/spherical-cell-geometry.js";

const execFileAsync = promisify(execFile);
const assetsRoot = path.resolve(process.env.ASTRO_ASSETS_ROOT ?? path.join(process.cwd(), "..", "Astro-Survey-Atlas-Assets"));
const assetsCoordinates = path.join(assetsRoot, "site", "src", "atlas", "coordinates.ts");
const assetsGeometry = path.join(assetsRoot, "site", "src", "atlas", "spherical-cell-geometry.ts");

function almostEqual(actual: number, expected: number, tolerance = 1e-12): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
}

function compareVectors(actual: readonly number[], expected: readonly number[]): void {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => almostEqual(value, expected[index]!));
}

test("Workspace and the sibling Assets checkout share the sky coordinate contract", {
  skip: !existsSync(assetsCoordinates) || !existsSync(assetsGeometry)
    ? `Assets checkout not found at ${assetsRoot}; set ASTRO_ASSETS_ROOT to enable this integration check`
    : false,
}, async () => {
  const coordinateUrl = pathToFileURL(assetsCoordinates).href;
  const geometryUrl = pathToFileURL(assetsGeometry).href;
  const script = `
    const coordinates = await import(${JSON.stringify(coordinateUrl)});
    const geometry = await import(${JSON.stringify(geometryUrl)});
    const cases = [[0, 0], [10.25, 20.5], [359.75, -42.25], [-1.5, 89.5]];
    const pixels = [0, 1, 17, 548, 1702, 1709];
    const centers = pixels.map((pixel) => geometry.sphericalCellCenter(16, pixel, 1).toArray());
    const boundaries = pixels.map((pixel) => geometry.sphericalCellBoundary(16, pixel, 1).map((point) => point.toArray()));
    process.stdout.write(JSON.stringify({
      vectors: cases.map(([ra, dec]) => coordinates.raDecToCartesian(ra, dec, 1.42)),
      inverses: cases.map(([ra, dec]) => coordinates.cartesianToRaDec(coordinates.raDecToCartesian(ra, dec, 1.42))),
      midpoints: [coordinates.circularMidpoint(359.5, 1.75), coordinates.circularMidpoint(-4, 8)],
      centers,
      boundaries,
      pixelsFromCenters: pixels.map((pixel) => geometry.healpixPixelFromSceneDirection(16, geometry.sphericalCellCenter(16, pixel, 1))),
    }));
  `;
  const { stdout } = await execFileAsync(process.execPath, ["--import", "tsx", "--eval", script], {
    cwd: assetsRoot,
    maxBuffer: 4 * 1024 * 1024,
  });
  const assets = JSON.parse(stdout) as {
    vectors: Array<{ x: number; y: number; z: number }>;
    inverses: Array<{ raDeg: number; decDeg: number }>;
    midpoints: number[];
    centers: number[][];
    boundaries: number[][][];
    pixelsFromCenters: number[];
  };

  const cases = [[0, 0], [10.25, 20.5], [359.75, -42.25], [-1.5, 89.5]] as const;
  cases.forEach(([ra, dec], index) => {
    const vector = raDecToCartesian(ra, dec, 1.42);
    const remoteVector = assets.vectors[index]!;
    almostEqual(remoteVector.x, vector.x);
    almostEqual(remoteVector.y, vector.y);
    almostEqual(remoteVector.z, vector.z);
    const inverse = cartesianToRaDec(vector);
    const remoteInverse = assets.inverses[index]!;
    almostEqual(remoteInverse.raDeg, inverse.raDeg);
    almostEqual(remoteInverse.decDeg, inverse.decDeg);
  });
  assert.deepEqual(assets.midpoints, [circularMidpoint(359.5, 1.75), circularMidpoint(-4, 8)]);

  const pixels = [0, 1, 17, 548, 1702, 1709];
  pixels.forEach((pixel, index) => {
    compareVectors(assets.centers[index]!, sphericalCellCenter(16, pixel, 1).toArray());
    const localBoundary = sphericalCellBoundary(16, pixel, 1).map((point) => point.toArray());
    assert.equal(assets.boundaries[index]!.length, localBoundary.length);
    assets.boundaries[index]!.forEach((point, pointIndex) => compareVectors(point, localBoundary[pointIndex]!));
  });
  assert.deepEqual(assets.pixelsFromCenters, pixels.map((pixel) => healpixPixelFromSceneDirection(16, sphericalCellCenter(16, pixel, 1))));
});
