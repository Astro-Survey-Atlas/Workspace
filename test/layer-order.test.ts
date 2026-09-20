import assert from "node:assert/strict";
import test from "node:test";

import { normalizeLayerOrder, visibleLayerDepths } from "../viewer/src/layer-order.js";

const keys = ["asset:cosmos", "public-survey:sdss", "public-survey:galex"];

test("layer order keeps stored order and appends newly available identities", () => {
  assert.deepEqual(
    normalizeLayerOrder(keys, ["public-survey:galex", "removed", "asset:cosmos"], keys),
    ["public-survey:galex", "asset:cosmos", "public-survey:sdss"],
  );
});

test("top list item is outermost and has highest render priority", () => {
  const depths = visibleLayerDepths(keys, keys, "layers");
  assert.equal(depths[0]?.key, "asset:cosmos");
  assert.equal(depths[0]?.radius, 1.12);
  assert.equal(depths[2]?.radius, 0.88);
  assert.ok((depths[0]?.radius ?? 0) > (depths[1]?.radius ?? 0));
  assert.ok((depths[0]?.renderOrder ?? 0) > (depths[1]?.renderOrder ?? 0));
});

test("overlap order keeps public layers on the same unit sphere", () => {
  const depths = visibleLayerDepths(keys, ["asset:cosmos", "public-survey:galex"], "overlap");
  assert.deepEqual(depths.map((depth) => depth.key), ["asset:cosmos", "public-survey:galex"]);
  assert.equal(depths[0]?.radius, 1);
  assert.equal(depths[1]?.radius, 1);
});
