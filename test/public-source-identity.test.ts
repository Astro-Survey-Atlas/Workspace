import assert from "node:assert/strict";
import test from "node:test";

import {
  formatPublicSourceId,
  isConcretePublicSourceId,
  parsePublicSourceId,
  publicGeometrySourceIdForFootprint,
  publicSourceIdForFootprint,
  publicSourceIdentityForFootprint,
} from "../src/public-source-identity.js";

test("formats and parses a sourceId-backed public identity", () => {
  const identity = {
    surveyId: "desi",
    releaseId: "dr1",
    product: "spectro catalog",
    sourceId: "tile:123/iron",
  } as const;
  const sourceId = formatPublicSourceId(identity);

  assert.equal(sourceId, "public:desi:dr1:spectro%20catalog:sourceId=tile%3A123%2Firon");
  assert.deepEqual(parsePublicSourceId(sourceId), identity);
  assert.equal(isConcretePublicSourceId(sourceId), true);
  assert.equal(publicSourceIdForFootprint(identity), sourceId);
  assert.deepEqual(publicSourceIdentityForFootprint(identity), identity);
});

test("supports layerId-only and combined public identities in a stable order", () => {
  const layerOnly = formatPublicSourceId({ surveyId: "euclid", releaseId: "ero", product: "footprints", layerId: "layer:ero" });
  const combined = formatPublicSourceId({ surveyId: "euclid", releaseId: "ero", product: "footprints", sourceId: "source", layerId: "layer" });

  assert.equal(layerOnly, "public:euclid:ero:footprints:layerId=layer%3Aero");
  assert.equal(combined, "public:euclid:ero:footprints:sourceId=source:layerId=layer");
  assert.deepEqual(parsePublicSourceId(layerOnly), { surveyId: "euclid", releaseId: "ero", product: "footprints", layerId: "layer:ero" });
  assert.deepEqual(parsePublicSourceId(combined), { surveyId: "euclid", releaseId: "ero", product: "footprints", sourceId: "source", layerId: "layer" });
});

test("rejects survey-level, product-level, legacy and noncanonical public IDs", () => {
  const invalid = [
    "public:desi",
    "public:desi:dr1:spectro",
    "public:desi:dr1:spectro:sourceId=tile:123",
    "public:desi:dr1:spectro:sourceId=tile%3A123:sourceId=other",
    "public:desi:dr1:spectro:unknown=value",
    "public:desi:dr1:spectro:sourceId=",
    "public:desi:dr1:spectro:sourceId=tile%2f123",
  ];
  invalid.forEach((sourceId) => {
    assert.equal(parsePublicSourceId(sourceId), undefined, sourceId);
    assert.equal(isConcretePublicSourceId(sourceId), false, sourceId);
  });

  assert.throws(
    () => formatPublicSourceId({ surveyId: "desi", releaseId: "dr1", product: "spectro" }),
    /requires sourceId or layerId/,
  );
});

test("keeps source-less footprints displayable but non-executable", () => {
  const footprint = { surveyId: "euclid", releaseId: "ero", product: "overview" } as const;

  assert.equal(publicSourceIdForFootprint(footprint), undefined);
  assert.equal(publicGeometrySourceIdForFootprint(footprint), "geometry:public:euclid:ero:overview");
  assert.equal(isConcretePublicSourceId(publicGeometrySourceIdForFootprint(footprint)), false);
  assert.equal(publicSourceIdentityForFootprint(footprint), undefined);
});
