import assert from "node:assert/strict";
import test from "node:test";

import { compactRects, subtractRect, subtractRects, type QueryRect } from "../viewer/src/viewport-query-cache.js";

const rect = (raMin: number, raMax: number, decMin: number, decMax: number): QueryRect => ({ raMin, raMax, decMin, decMax });

test("viewport rectangle subtraction preserves untouched and removes contained areas", () => {
  const target = rect(10, 20, -5, 5);
  assert.deepEqual(subtractRect(target, rect(30, 40, -5, 5)), [target]);
  assert.deepEqual(subtractRect(target, rect(0, 30, -10, 10)), []);
});

test("viewport rectangle subtraction splits a central covered area into four residual jobs", () => {
  assert.deepEqual(subtractRect(rect(0, 10, 0, 10), rect(3, 7, 3, 7)), [
    rect(0, 10, 0, 3),
    rect(0, 10, 7, 10),
    rect(0, 3, 3, 7),
    rect(7, 10, 3, 7),
  ]);
});

test("viewport subtraction applies every covered rectangle without re-requesting overlap", () => {
  const remaining = subtractRects([rect(0, 12, 0, 4)], [rect(0, 4, 0, 4), rect(8, 12, 0, 4)]);
  assert.deepEqual(remaining, [rect(4, 8, 0, 4)]);
});

test("viewport rectangle compaction removes contained ranges and joins adjacent coverage", () => {
  assert.deepEqual(compactRects([
    rect(0, 4, 0, 4),
    rect(4, 8, 0, 4),
    rect(1, 2, 1, 2),
  ]), [rect(0, 8, 0, 4)]);
});
