import assert from "node:assert/strict";
import test from "node:test";

import { parseAgentIntent } from "../src/agent.js";
import {
  angularDistanceArcsec,
  applyResultFilter,
  availableFilterFields,
  catalogQueryBody,
  DESI_CATALOG,
  EUCLID_CATALOG,
  nearestNeighborCrossmatch,
  normalizeCatalogRows,
  parseCrossmatchInput,
  parseFilterSpec,
  raRangeFilter,
  rowsToCsv,
  type CatalogRecord,
  type CrossmatchRecord,
} from "../src/scientific-tools.js";

test("parses Chinese workflow parameters with a scientific match radius", () => {
  assert.deepEqual(parseAgentIntent("请查 RA 150.12 Dec 2.21，匹配半径 1.5，查询半径 600，上限 300"), {
    type: "create_run",
    input: { raDeg: 150.12, decDeg: 2.21, queryRadiusArcsec: 600, matchRadiusArcsec: 1.5, limit: 300 },
  });
  assert.deepEqual(parseAgentIntent("分离角小于 1.0", true), {
    type: "filter",
    filter: { logic: "and", conditions: [{ field: "separationArcsec", op: "<=", value: 1 }] },
  });
});

test("handles right ascension wrap in queries and angular distance", () => {
  const filter = raRangeFilter("ra", 359.99, 0.02);
  assert.ok("bool" in filter);
  assert.ok(Math.abs(angularDistanceArcsec(359.9999, 0, 0.0001, 0) - 0.72) < 0.001);
});

test("chooses the nearest spherical neighbor and applies an explicit filter", () => {
  const euclid: CatalogRecord[] = [{ catalog: "euclid", objectId: "e1", raDeg: 10, decDeg: 0, magnitude: 21, classLabel: "galaxy" }];
  const desi: CatalogRecord[] = [
    { catalog: "desi", objectId: "d2", raDeg: 10.0002, decDeg: 0, magnitude: 20, classLabel: "PSF" },
    { catalog: "desi", objectId: "d1", raDeg: 10.0001, decDeg: 0, magnitude: 19, classLabel: "REX" },
  ];
  const matches = nearestNeighborCrossmatch(euclid, desi, 1.5);
  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.desiObjectId, "d1");
  assert.equal(applyResultFilter(matches, {
    logic: "and",
    conditions: [{ field: "separationArcsec", op: "<=", value: 0.4 }],
  }).length, 1);
});

test("enforces workflow result and radius limits", () => {
  assert.throws(() => parseCrossmatchInput({ raDeg: 10, decDeg: 0, matchRadiusArcsec: 250 }), /between 0.1 and 10/);
  assert.throws(() => parseCrossmatchInput({ raDeg: 10, decDeg: 0, limit: 1001 }), /between 1 and 1000/);
  const rows = Array.from({ length: 1_005 }, (_, index) => ({
    euclidObjectId: `e${index}`,
    desiObjectId: `d${index}`,
    euclidRaDeg: 10,
    euclidDecDeg: 0,
    desiRaDeg: 10,
    desiDecDeg: 0,
    euclidMagnitude: null,
    desiMagnitude: null,
    separationArcsec: 0,
    classLabel: "unknown",
  })) satisfies CrossmatchRecord[];
  assert.equal(applyResultFilter(rows).length, 1_000);
});

test("maps selected nonstandard catalog fields through matching, HITL filtering, and CSV export", () => {
  const input = parseCrossmatchInput({
    raDeg: 10,
    decDeg: 0,
    catalogFields: {
      euclid: { redshift: "Z_PHOT", flux_r: "FLUX_R" },
      desi: { signal_to_noise: "SN_MEDIAN" },
    },
  });
  const request = catalogQueryBody(EUCLID_CATALOG, input);
  const body = request.body as { _source: string[] };
  assert.ok(body._source.includes("Z_PHOT"));
  assert.ok(body._source.includes("FLUX_R"));
  assert.ok(body._source.includes("RIGHT_ASCENSION"));

  const euclidRows = normalizeCatalogRows("euclid", [{ _source: {
    OBJECT_ID: "e1", RIGHT_ASCENSION: 10, DECLINATION: 0, Z_PHOT: 0.42, FLUX_R: 128.5,
  } }], input);
  const desiRows = normalizeCatalogRows("desi", [{ _source: {
    TARGETID: "d1", ra: 10.0001, dec: 0, SN_MEDIAN: 11.4,
  } }], input);
  const matches = nearestNeighborCrossmatch(euclidRows, desiRows, 1.5);
  assert.deepEqual(matches[0]?.euclidFields, { redshift: 0.42, flux_r: 128.5 });
  assert.deepEqual(matches[0]?.desiFields, { signal_to_noise: 11.4 });
  assert.ok(availableFilterFields(matches[0]!).includes("euclidFields.redshift"));

  const filtered = applyResultFilter(matches, parseFilterSpec({
    conditions: [{ field: "desiFields.signal_to_noise", op: ">=", value: 10 }],
  }));
  assert.equal(filtered.length, 1);
  const csv = rowsToCsv(filtered);
  assert.match(csv, /euclid_flux_r,euclid_redshift,desi_signal_to_noise/);
  assert.match(csv, /128\.5,0\.42,11\.4/);
});

test("rejects invalid or excessive catalog field mappings", () => {
  assert.throws(() => parseCrossmatchInput({
    raDeg: 10,
    decDeg: 0,
    catalogFields: { euclid: { "redshift z": "Z_PHOT" } },
  }), /simple field names/);
  assert.throws(() => parseCrossmatchInput({
    raDeg: 10,
    decDeg: 0,
    catalogFields: { euclid: Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`field${index}`, `COL_${index}`])) },
  }), /at most 16 fields/);
});
