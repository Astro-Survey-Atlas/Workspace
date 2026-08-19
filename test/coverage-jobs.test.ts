import assert from "node:assert/strict";
import test from "node:test";

import { coverageJobSnapshot, scannerCoverageProperties, validateCoverageJobSnapshot, validateCoverageJobSubmission } from "../src/coverage-jobs.js";

const catalogRequest = {
  connectorId: "csst-sim-oss",
  assetId: "csst-sim-w1-phot",
  releaseId: "csst-sim-w1-20250731",
  product: "W1 photometric catalog",
  allowedSuffixes: [".csv", ".fits"],
  coverage: {
    mode: "catalog-radec",
    coordinateFrame: "ICRS",
    coordinateUnits: "deg",
    raColumn: "RA",
    decColumn: "DEC",
    evidenceRole: "object_presence",
  },
};

test("coverage job normalizes catalog occupancy as an explicit non-footprint evidence mode", () => {
  const request = validateCoverageJobSubmission(catalogRequest);
  assert.deepEqual(request.coverage, {
    mode: "catalog-radec",
    coordinateFrame: "ICRS",
    coordinateUnits: "deg",
    raColumn: "RA",
    decColumn: "DEC",
    healpixOrder: 8,
    evidenceRole: "object_presence",
  });
  assert.deepEqual(scannerCoverageProperties(request.coverage), {
    spatialMode: "catalog",
    raColumn: "RA",
    decColumn: "DEC",
    coordinateFrame: "ICRS",
    coordinateUnits: "deg",
    coverageRole: "object_presence",
    healpixOrder: "8",
  });
  assert.deepEqual(coverageJobSnapshot("csst", request), {
    surveyId: "csst",
    releaseId: "csst-sim-w1-20250731",
    product: "W1 photometric catalog",
    ...request.coverage,
  });
});

test("coverage job accepts declared NESTED pixels and WCS image extent with separate contracts", () => {
  const healpix = validateCoverageJobSubmission({
    ...catalogRequest,
    coverage: { mode: "nested-healpix", coordinateFrame: "ICRS", healpixColumn: "HPX8", healpixOrder: 8 },
  });
  assert.deepEqual(scannerCoverageProperties(healpix.coverage), {
    spatialMode: "healpix",
    healpixColumn: "HPX8",
    coordinateFrame: "ICRS",
    coverageRole: "object_presence",
    healpixOrder: "8",
  });

  const fits = validateCoverageJobSubmission({
    ...catalogRequest,
    coverage: { mode: "fits-wcs", coordinateFrame: "ICRS", evidenceRole: "image_extent" },
  });
  assert.deepEqual(scannerCoverageProperties(fits.coverage), {
    spatialMode: "auto",
    coordinateFrame: "ICRS",
    coverageRole: "image_extent",
  });
});

test("coverage job rejects ambiguous or unsupported scientific claims", () => {
  assert.throws(() => validateCoverageJobSubmission({
    ...catalogRequest,
    coverage: { mode: "catalog-radec", coordinateFrame: "ICRS", raColumn: "RA", decColumn: "DEC", evidenceRole: "image_extent" },
  }), /object_presence/);
  assert.throws(() => validateCoverageJobSubmission({
    ...catalogRequest,
    coverage: { mode: "nested-healpix", coordinateFrame: "ICRS", healpixColumn: "HPX", healpixOrder: 6 },
  }), /healpixOrder/);
  assert.throws(() => validateCoverageJobSubmission({
    ...catalogRequest,
    coverage: { mode: "fits-wcs", coordinateFrame: "ICRS", raColumn: "RA" },
  }), /does not accept/);
  assert.throws(() => validateCoverageJobSubmission({ ...catalogRequest, connectorId: "not a connector" }), /stable identifier/);
  assert.throws(() => validateCoverageJobSnapshot({
    surveyId: "csst",
    releaseId: "csst-sim-w1-20250731",
    product: "W1 photometric catalog",
    ...catalogRequest.coverage,
    unexpected: true,
  }), /unknown field/);
});
