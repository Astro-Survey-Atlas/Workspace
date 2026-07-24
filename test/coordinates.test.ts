import assert from "node:assert/strict";
import test from "node:test";

import { cartesianToRaDec, circularMidpoint, normalizeRa, raDecToCartesian } from "../viewer/src/coordinates.js";

function almostEqual(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
}

test("maps ICRS coordinates into the shared Three.js celestial frame", () => {
  const origin = raDecToCartesian(0, 0);
  const east = raDecToCartesian(90, 0);
  const north = raDecToCartesian(0, 90);

  almostEqual(origin.x, 0);
  almostEqual(origin.y, 0);
  almostEqual(origin.z, -1);
  almostEqual(east.x, -1);
  almostEqual(east.y, 0);
  almostEqual(east.z, 0);
  almostEqual(north.x, 0);
  almostEqual(north.y, 1);
  almostEqual(north.z, 0);
});

test("normalizes wrapped right ascension and its circular midpoint", () => {
  assert.equal(normalizeRa(-1), 359);
  assert.equal(normalizeRa(361), 1);
  assert.equal(circularMidpoint(359.5, 1.75), 0.375);
});

test("round-trips scene coordinates back to ICRS", () => {
  for (const [raDeg, decDeg] of [[0, 0], [150.123456, 2.345678], [359.9, -42.5]] as const) {
    const roundTrip = cartesianToRaDec(raDecToCartesian(raDeg, decDeg, 1.42));
    almostEqual(roundTrip.raDeg, raDeg);
    almostEqual(roundTrip.decDeg, decDeg);
  }
});
