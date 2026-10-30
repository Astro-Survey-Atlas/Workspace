import assert from "node:assert/strict";
import test from "node:test";

import { expandHealpixRanges } from "../src/healpix-ranges.js";
import { nativeMocHealpixRanges } from "../src/native-moc-ranges.js";
import { calculateSkyOverlap } from "../src/sky-overlap.js";
import { nativeMocFits } from "./helpers/native-moc-fits.js";

test("native O11 geometry retains separated O10 cells within the same O4 preview cell", () => {
  const a = nativeMocFits([{ order: 11, pixel: 16384 }, { order: 11, pixel: 16392 }]);
  const b = nativeMocFits([{ order: 10, pixel: 4098 }, { order: 10, pixel: 4100 }]);
  const sources = [a, b].map((bytes, index) => ({ id: String(index), label: String(index), kind: "public" as const,
    nside: 1024, pixels: [], ranges: nativeMocHealpixRanges(bytes, 10) }));
  assert.deepEqual(calculateSkyOverlap(sources, 1024).pixels, [4098]);
  assert.deepEqual(nativeMocHealpixRanges(a, 4), [{ start: 1, end: 2 }]);
});

test("all-sky O13 sources are intersected before expanding the small result", () => {
  const sky = nativeMocFits(Array.from({ length: 12 }, (_, pixel) => ({ order: 0, pixel })));
  const point = nativeMocFits([{ order: 13, pixel: 700_000_001 }]);
  const sources = [sky, point].map((bytes, index) => ({ id: String(index), label: "Native survey", kind: "public" as const,
    nside: 8192, pixels: [], ranges: nativeMocHealpixRanges(bytes, 13) }));
  assert.deepEqual(calculateSkyOverlap(sources, 8192).pixels, [700_000_001]);
  assert.throws(() => calculateSkyOverlap([sources[0]!, { ...sources[0]!, id: "another-sky" }], 8192), /显示上限/);
});

test("O29 NUNIQ values coarsen exactly with integer arithmetic", () => {
  const parent = 700_000_001;
  const scale = 4n ** 16n;
  const bytes = nativeMocFits([{ order: 29, pixel: BigInt(parent) * scale + scale - 1n }]);
  assert.deepEqual(nativeMocHealpixRanges(bytes, 13), [{ start: parent, end: parent + 1 }]);
});

test("native projection accepts 32-bit UNIQ and rejects an unsupported frame or truncated table", () => {
  assert.deepEqual(expandHealpixRanges(nativeMocHealpixRanges(nativeMocFits([{ order: 6, pixel: 20 }], { format: "1J" }), 5), 8), [5]);
  assert.throws(() => nativeMocHealpixRanges(nativeMocFits([{ order: 10, pixel: 1 }], { frame: "G" }), 10), /ICRS/);
  const valid = nativeMocFits([{ order: 10, pixel: 1 }]);
  assert.throws(() => nativeMocHealpixRanges(valid.subarray(0, 5760), 10), /Truncated/);
});
