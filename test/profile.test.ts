import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { minimalRightAscensionInterval, profileCatalogCsv } from "../src/profile.js";

const fixturePath = fileURLToPath(new URL("fixtures/catalog.csv", import.meta.url));

test("profiles a CSV catalog without an LLM", async () => {
  const profile = await profileCatalogCsv(fixturePath);

  assert.equal(profile.rowCount, 3);
  assert.deepEqual(
    profile.columns.map(({ name, type, nullCount }) => ({ name, type, nullCount })),
    [
      { name: "object_id", type: "string", nullCount: 0 },
      { name: "ra", type: "number", nullCount: 0 },
      { name: "dec", type: "number", nullCount: 0 },
      { name: "flux_g", type: "number", nullCount: 1 },
      { name: "quality", type: "boolean", nullCount: 0 },
    ],
  );
  assert.deepEqual(profile.skyCoverage, {
    raColumn: "ra",
    decColumn: "dec",
    rightAscension: { startDeg: 359.5, endDeg: 1.25, wraps: true, spanDeg: 1.75 },
    decMinDeg: -1,
    decMaxDeg: 3.5,
    validRows: 3,
    invalidRows: 0,
  });
});

test("chooses the smallest circular RA interval", () => {
  assert.deepEqual(minimalRightAscensionInterval([10, 20, 15]), {
    startDeg: 10,
    endDeg: 20,
    wraps: false,
    spanDeg: 10,
  });
});
