import assert from "node:assert/strict";
import test from "node:test";

import { AssetsRegionClient } from "../src/assets-region-client.js";

test("AssetsRegionClient sends the scoped key and preserves file evidence", async () => {
  let request: { url: string; init: RequestInit } | undefined;
  const client = new AssetsRegionClient({
    catalogUrl: "http://assets.test/api/v1/resource-packages/catalog.json",
    getApiKey: async () => "asa_live_test",
    fetchImpl: (async (url, init) => {
      request = { url: String(url), init: init ?? {} };
      return new Response(JSON.stringify({
        available: true,
        precision: "estimated",
        truncated: false,
        requested: { layerIds: ["euclid-layer"], order: 8, cells: [549009] },
        expiresAt: "2026-09-21T00:10:00.000Z",
        notes: ["Warehouse evidence"],
        downloadPlan: {
          files: [{
            fileId: "file-1",
            fileName: "tile.fits",
            sourceUri: "oss://bucket/tile.fits",
            parentUri: "oss://bucket",
            fileType: "FITS",
            sizeBytes: 123,
            downloadable: false,
            matchingCoverage: [{ layerId: "euclid-layer", order: 8, ipix: 549009, precision: "estimated", coverageMethod: "fits_wcs" }],
          }],
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  });
  const result = await client.lookup({ layerIds: ["euclid-layer"], order: 8, cells: [549009], limit: 1000 });
  assert.ok(request);
  assert.equal(request.url, "http://assets.test/api/v1/coverage/reverse-lookup");
  assert.equal((request.init.headers as Record<string, string>)["X-Assets-API-Key"], "asa_live_test");
  assert.deepEqual(JSON.parse(String(request.init.body)), { layerIds: ["euclid-layer"], order: 8, cells: [549009], limit: 1000 });
  assert.equal(result?.files[0]?.fileName, "tile.fits");
  assert.equal(result?.files[0]?.downloadable, false);
  assert.equal(result?.files[0]?.matchingCoverage[0]?.ipix, 549009);
});

test("AssetsRegionClient does not call Assets without a configured key", async () => {
  let calls = 0;
  const client = new AssetsRegionClient({
    catalogUrl: "http://assets.test/api/v1/resource-packages/catalog.json",
    getApiKey: async () => undefined,
    fetchImpl: (async () => { calls += 1; return new Response("{}", { status: 500 }); }) as typeof fetch,
  });
  assert.equal(await client.lookup({ layerIds: ["layer"], order: 8, cells: [1] }), undefined);
  assert.equal(calls, 0);
});

test("AssetsRegionClient reports authorization failures without exposing the key", async () => {
  const client = new AssetsRegionClient({
    catalogUrl: "http://assets.test/api/v1/resource-packages/catalog.json",
    getApiKey: async () => "asa_live_secret-value",
    fetchImpl: (async () => new Response(JSON.stringify({ error: "invalid key" }), { status: 401 })) as typeof fetch,
  });
  await assert.rejects(
    () => client.lookup({ layerIds: ["layer"], order: 8, cells: [1] }),
    (error: unknown) => error instanceof Error && /authorization failed/.test(error.message) && !error.message.includes("secret-value"),
  );
});
