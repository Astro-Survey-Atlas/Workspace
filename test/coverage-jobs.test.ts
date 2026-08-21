import assert from "node:assert/strict";
import test from "node:test";

import { coverageJobSnapshot, scannerCoverageProperties, validateCoverageJobSnapshot, validateCoverageJobSubmission } from "../src/coverage-jobs.js";

const catalogRequest = {
  connectorId: "csst-sim-oss",
  assetId: "csst-sim-w1-phot",
  releaseId: "csst-sim-w1-20250731",
  product: "W1 photometric catalog",
  allowedSuffixes: [".csv", ".fits"],
  fileNamePattern: "^CSST_MSC_MS_WIDE_.*\\.fits$",
  coverage: {
    mode: "catalog-radec",
    coordinateFrame: "ICRS",
    coordinateUnits: "deg",
    raColumn: "RA",
    decColumn: "DEC",
    coverageRole: "object_presence",
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
    coverageRole: "object_presence",
    dataOrigin: "observed",
    sourceTier: "user_file_derived",
    maxOrder: 10,
    queryOrder: 8,
    previewOrder: 4,
    fileNamePattern: "^CSST_MSC_MS_WIDE_.*\\.fits$",
  });
  assert.deepEqual(scannerCoverageProperties(request.coverage), {
    spatialMode: "catalog",
    raColumn: "RA",
    decColumn: "DEC",
    coordinateFrame: "ICRS",
    coordinateUnits: "deg",
    coverageRole: "object_presence",
    maxOrder: "10",
    queryOrder: "8",
    previewOrder: "4",
    dataOrigin: "observed",
    sourceTier: "user_file_derived",
    fileNamePattern: "^CSST_MSC_MS_WIDE_.*\\.fits$",
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
    inputHealpixOrder: "8",
    maxOrder: "10",
    queryOrder: "8",
    previewOrder: "4",
    dataOrigin: "observed",
    sourceTier: "user_file_derived",
    fileNamePattern: "^CSST_MSC_MS_WIDE_.*\\.fits$",
  });

  const fits = validateCoverageJobSubmission({
    ...catalogRequest,
    coverage: { mode: "fits-wcs", coordinateFrame: "ICRS", coverageRole: "image_extent" },
  });
  assert.deepEqual(scannerCoverageProperties(fits.coverage), {
    spatialMode: "auto",
    coordinateFrame: "ICRS",
    coverageRole: "image_extent",
    maxOrder: "10",
    queryOrder: "8",
    previewOrder: "4",
    dataOrigin: "observed",
    sourceTier: "user_file_derived",
    fileNamePattern: "^CSST_MSC_MS_WIDE_.*\\.fits$",
  });
});

test("coverage job rejects ambiguous or unsupported scientific claims", () => {
  assert.throws(() => validateCoverageJobSubmission({
    ...catalogRequest,
    coverage: { mode: "catalog-radec", coordinateFrame: "ICRS", raColumn: "RA", decColumn: "DEC", coverageRole: "image_extent" },
  }), /object_presence/);
  assert.doesNotThrow(() => validateCoverageJobSubmission({
    ...catalogRequest,
    coverage: { mode: "nested-healpix", coordinateFrame: "ICRS", healpixColumn: "HPX", healpixOrder: 6 },
  }));
  assert.throws(() => validateCoverageJobSubmission({
    ...catalogRequest,
    coverage: { mode: "fits-wcs", coordinateFrame: "ICRS", raColumn: "RA" },
  }), /does not accept/);
  assert.throws(() => validateCoverageJobSubmission({ ...catalogRequest, connectorId: "not a connector" }), /stable identifier/);
  assert.throws(() => validateCoverageJobSubmission({ ...catalogRequest, fileNamePattern: "foo/bar" }), /basename/);
  assert.throws(() => validateCoverageJobSubmission({ ...catalogRequest, fileNamePattern: "bad\npattern" }), /basename|newlines/);
  assert.throws(() => validateCoverageJobSnapshot({
    surveyId: "csst",
    releaseId: "csst-sim-w1-20250731",
    product: "W1 photometric catalog",
    ...catalogRequest.coverage,
    unexpected: true,
  }), /unknown field/);
});
