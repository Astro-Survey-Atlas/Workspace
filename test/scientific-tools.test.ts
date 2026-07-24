import assert from "node:assert/strict";
import test from "node:test";

import { parseAgentIntent } from "../src/agent.js";
import {
  angularDistanceArcsec,
  applyResultFilter,
  nearestNeighborCrossmatch,
  parseCrossmatchInput,
  raRangeFilter,
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
