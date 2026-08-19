import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { parseDesiObservedTiles, rasterizeObservedTiles } from "../scripts/build_desi_footprints.js";

const geometryRoot = path.join(process.env.ASTRO_PUBLIC_ASSETS_ROOT ?? path.resolve(process.cwd(), "..", "Astro-Survey-Atlas-Assets"), "artifacts", "public-survey-footprints", "raw", "geometry");

const cases = [
  {
    file: "desi-edr-tiles-fuji.fits",
    sha256: "7ddf26cdda548d1cc133d078db73862856c8e1c4912de85d52fd650a1b8f5a0d",
    rows: 732,
    pixels: 434,
  },
  {
    file: "desi-dr1-tiles-iron.fits",
    sha256: "99320a3a8940cb1c98d36526233e14bafcd1e137d6e2a0c0563e7b9c4f83d71a",
    rows: 6101,
    pixels: 1407,
  },
] as const;

for (const entry of cases) test(`DESI ${entry.file} produces deterministic observed-tile coverage`, async () => {
  const bytes = await readFile(path.join(geometryRoot, entry.file));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.sha256);
  const parsed = parseDesiObservedTiles(bytes);
  assert.equal(parsed.rowCount, entry.rows);
  assert.equal(parsed.tiles.length, entry.rows);
  assert.ok(parsed.tiles.every((tile) => tile.nexp > 0));
  assert.equal(rasterizeObservedTiles(parsed.tiles).length, entry.pixels);
});
