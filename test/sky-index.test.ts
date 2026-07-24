import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { profileCatalogCsv } from "../src/profile.js";
import { buildCatalogSkyIndex, CatalogSkyIndexService, SKY_NSIDE_LEVELS } from "../src/sky-index.js";
import type { DatasetRecord } from "../src/types.js";

const fixturePath = fileURLToPath(new URL("fixtures/catalog.csv", import.meta.url));

async function fixtureRecord(): Promise<DatasetRecord> {
  return {
    id: "fixture",
    name: "Fixture catalog",
    uri: `file://${fixturePath}`,
    profile: await profileCatalogCsv(fixturePath),
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:00:00.000Z",
  };
}

test("builds deterministic nested HEALPix levels from valid catalog rows", async () => {
  const index = await buildCatalogSkyIndex(await fixtureRecord());

  assert.equal(index.summary.coordinateFrame, "ICRS");
  assert.equal(index.summary.objectCount, 3);
  assert.equal(index.summary.invalidRowCount, 0);
  assert.equal(index.summary.idColumn, "object_id");
  assert.deepEqual(index.summary.levels.map(({ nside }) => nside), [...SKY_NSIDE_LEVELS]);
  assert.deepEqual(index.points.map(({ id }) => id), ["source-a", "source-b", "source-c"]);

  for (const counts of index.countsByNside.values()) {
    assert.equal([...counts.values()].reduce((sum, count) => sum + count, 0), 3);
  }
});

test("returns renderable HEALPix cell geometry and paged points", async () => {
  const record = await fixtureRecord();
  const service = new CatalogSkyIndexService();
  const cells = await service.getCells(record, 128);
  const page = await service.getPoints(record, 1, 1);

  assert.ok(cells.length > 0);
  assert.equal(cells.reduce((sum, cell) => sum + cell.count, 0), 3);
  assert.ok(cells.every((cell) => cell.vertices.length === 4));
  assert.ok(cells.every((cell) => cell.vertices.every(({ raDeg, decDeg }) => raDeg >= 0 && raDeg < 360 && decDeg >= -90 && decDeg <= 90)));
  assert.equal(page.total, 3);
  assert.equal(page.points.length, 1);
  assert.equal(page.points[0]?.id, "source-b");
});

test("rejects unsupported HEALPix levels", async () => {
  const service = new CatalogSkyIndexService();
  const record = await fixtureRecord();
  await assert.rejects(() => service.getCells(record, 16), /Unsupported nside/);
});
