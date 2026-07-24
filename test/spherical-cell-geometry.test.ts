import assert from "node:assert/strict";
import test from "node:test";

import * as THREE from "three";

import {
  buildSphericalCellEdges,
  buildSphericalCellSheetGeometry,
  healpixPixelFromSceneDirection,
  sphericalCellBoundary,
  TRIANGLES_PER_SPHERICAL_CELL_SHEET,
} from "../viewer/src/spherical-cell-geometry.js";

const cell = {
  nside: 2,
  pixel: 1,
  radius: 1,
  color: new THREE.Color("#42d4c6"),
};

test("fragment geometry contains one zero-thickness HEALPix sheet", () => {
  const geometry = buildSphericalCellSheetGeometry([cell]);
  assert.equal(geometry.getAttribute("position").count, TRIANGLES_PER_SPHERICAL_CELL_SHEET * 3);
  assert.equal(geometry.getAttribute("normal"), undefined);
  assert.equal(geometry.getAttribute("color").count, TRIANGLES_PER_SPHERICAL_CELL_SHEET * 3);
  geometry.dispose();
});

test("fragment edge geometry traces four outer HEALPix boundaries without a sphere guide", () => {
  const geometry = buildSphericalCellEdges([cell]);
  assert.equal(geometry.getAttribute("position").count, 8);
  assert.equal(geometry.getAttribute("color").count, 8);
  geometry.dispose();
});


test("scene directions round-trip to the same nested HEALPix pixel", () => {
  const nside = 8;
  for (const pixel of [0, 1, 17, 42, 100, 255]) {
    const boundary = sphericalCellBoundary(nside, pixel, 1);
    const center = boundary.reduce((sum, point) => sum.add(point), new THREE.Vector3()).normalize();
    assert.equal(healpixPixelFromSceneDirection(nside, center), pixel);
  }
});
