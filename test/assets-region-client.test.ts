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
        scanScopes: [{
          layerId: "assets-batch-euclid",
          publishedLayerId: "euclid-layer",
          scopeId: "euclid-vis-q1",
          scopeSnapshotSha256: "a".repeat(64),
          expectedPartitions: 2,
          committedPartitions: 1,
          completeness: "incomplete",
        }],
        edges: [{
          layerId: "euclid-layer",
          observationLayerId: "euclid-layer::candidate::tile-1",
          sourceFileId: "file-1",
          scanRunId: "scan-run-1",
          sourceSnapshotSha256: "b".repeat(64),
          order: 8,
          ipix: 549009,
        }],
        downloadPlan: {
          scanScopes: [{
            layerId: "assets-batch-euclid",
            publishedLayerId: "euclid-layer",
            scopeId: "euclid-vis-q1",
            scopeSnapshotSha256: "a".repeat(64),
            expectedPartitions: 2,
            committedPartitions: 1,
            completeness: "incomplete",
          }],
          files: [{
            fileId: "file-1",
            metadataState: "complete",
            fileName: "tile.fits",
            sourceUri: "oss://bucket/tile.fits",
            downloadUrl: "https://data.example/tile.fits",
            parentUri: "oss://bucket",
            fileType: "FITS",
            sizeBytes: 123,
            downloadable: false,
            matchingCoverageTruncated: true,
            warnings: ["Coverage matches incomplete", 123],
            matchingCoverage: [{
              layerId: "euclid-layer",
              evidenceLayerId: "assets-batch-euclid",
              observationLayerId: "explicit-candidate-tile-1",
              scopeId: "euclid-vis-q1",
              partitionId: "tile-1",
              order: 8,
              ipix: 549009,
              precision: "estimated",
              coverageMethod: "fits_wcs",
              scanRunId: "scan-run-1",
              sourceSnapshotSha256: "b".repeat(64),
            }],
            observations: [{
              layerId: "euclid-layer",
              scanRunId: "scan-run-1",
              sourceSnapshotSha256: "b".repeat(64),
              fileName: "tile.fits",
              sizeBytes: 123,
              sourceUri: "oss://bucket/tile.fits",
              metadataState: "complete",
            }],
          }, {
            fileId: "file-2",
            metadataState: "missing",
            sourceUri: "s3://private-bucket/unlinked.fits",
            downloadable: false,
            matchingCoverage: [],
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
  assert.equal(result?.available, true);
  assert.equal(result?.precision, "estimated");
  assert.equal(result?.truncated, false);
  assert.equal(result?.files[0]?.fileName, "tile.fits");
  assert.equal(result?.files[0]?.downloadable, false);
  assert.equal(result?.files[0]?.matchingCoverageTruncated, true);
  assert.deepEqual(result?.files[0]?.warnings, ["Coverage matches incomplete"]);
  assert.equal(result?.files[0]?.sourceUri, "oss://bucket/tile.fits");
  assert.equal(result?.files[0]?.downloadUrl, "https://data.example/tile.fits");
  assert.equal(result?.files[0]?.matchingCoverage[0]?.ipix, 549009);
  assert.equal(result?.files[0]?.matchingCoverage[0]?.scanRunId, "scan-run-1");
  assert.equal(result?.files[0]?.matchingCoverage[0]?.sourceSnapshotSha256, "b".repeat(64));
  assert.deepEqual(result?.files[0]?.matchingCoverage[0], {
    layerId: "euclid-layer",
    evidenceLayerId: "assets-batch-euclid",
    observationLayerId: "explicit-candidate-tile-1",
    scopeId: "euclid-vis-q1",
    partitionId: "tile-1",
    order: 8,
    ipix: 549009,
    precision: "estimated",
    coverageMethod: "fits_wcs",
    scanRunId: "scan-run-1",
    sourceSnapshotSha256: "b".repeat(64),
  });
  assert.deepEqual(result?.files[0]?.observations, [{
    layerId: "euclid-layer",
    observationLayerId: "euclid-layer::candidate::tile-1",
    scanRunId: "scan-run-1",
    sourceSnapshotSha256: "b".repeat(64),
    fileName: "tile.fits",
    sizeBytes: 123,
    sourceUri: "oss://bucket/tile.fits",
    metadataState: "complete",
  }]);
  assert.deepEqual(result?.scanScopes, [{
    layerId: "assets-batch-euclid",
    publishedLayerId: "euclid-layer",
    scopeId: "euclid-vis-q1",
    scopeSnapshotSha256: "a".repeat(64),
    expectedPartitions: 2,
    committedPartitions: 1,
    completeness: "incomplete",
  }]);
  assert.deepEqual(result?.files[1], {
    fileId: "file-2",
    metadataState: "missing",
    sourceUri: "s3://private-bucket/unlinked.fits",
    downloadable: false,
    matchingCoverage: [],
  });
});

test("AssetsRegionClient infers a missing observation layer from matching coverage edges", async () => {
  const client = new AssetsRegionClient({
    catalogUrl: "http://assets.test/api/v1/resource-packages/catalog.json",
    getApiKey: async () => "asa_live_test",
    fetchImpl: (async () => new Response(JSON.stringify({
      available: true,
      precision: "estimated",
      truncated: false,
      requested: { layerIds: ["euclid-layer"], order: 8, cells: [549009] },
      notes: [],
      edges: [{
        sourceFileId: "file-1",
        layerId: "euclid-layer",
        observationLayerId: "legacy-candidate-tile-1",
        scanRunId: "scan-run-1",
        order: 8,
        ipix: 549009,
      }],
      downloadPlan: {
        files: [{
          fileId: "file-1",
          downloadable: false,
          matchingCoverage: [{
            layerId: "euclid-layer",
            order: 8,
            ipix: 549009,
            precision: "estimated",
            scanRunId: "scan-run-1",
          }],
        }],
      },
    }), { status: 200 })) as typeof fetch,
  });

  const result = await client.lookup({ layerIds: ["euclid-layer"], order: 8, cells: [549009] });
  assert.equal(result?.files[0]?.matchingCoverage[0]?.observationLayerId, "legacy-candidate-tile-1");
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

test("AssetsRegionClient preserves observation-footprint evidence without files or retrieval URLs", async () => {
  const client = new AssetsRegionClient({
    catalogUrl: "http://assets.test/api/v1/resource-packages/catalog.json",
    getApiKey: async () => "asa_live_test",
    fetchImpl: (async () => new Response(JSON.stringify({
      available: true,
      precision: "estimated",
      truncated: false,
      requested: { layerIds: ["hst-acs"], order: 8, cells: [101] },
      notes: [],
      downloadPlan: {
        files: [],
        entrypoints: [],
        coverageEvidence: [{
          layerId: "hst-acs",
          productId: "hst-acs-product",
          surveyId: "hst",
          releaseId: "mast-2026",
          product: "HST ACS observations",
          evidenceKind: "observation-footprint",
          order: 8,
          nside: 256,
          nativeMaxOrder: 10,
          availableOrders: [4, 8],
          matchedCells: [101],
          precision: "estimated",
          completeness: "incomplete",
          scienceFileScan: "not-scanned",
          sourceIdentity: "MAST observation 26442812",
          instrument: "ACS/WFC",
          filters: "F606W, F814W",
          sourceSnapshotSha256: "c".repeat(64),
          sourceLabel: "MAST observation 26442812",
          summary: "Estimated observation footprint; no science files were scanned.",
        }],
      },
    }), { status: 200 })) as typeof fetch,
  });

  const result = await client.lookup({ layerIds: ["hst-acs"], order: 8, cells: [101] });
  assert.deepEqual(result?.files, []);
  assert.deepEqual(result?.coverageEvidence, [{
    layerId: "hst-acs",
    productId: "hst-acs-product",
    surveyId: "hst",
    releaseId: "mast-2026",
    product: "HST ACS observations",
    evidenceKind: "observation-footprint",
    order: 8,
    nside: 256,
    nativeMaxOrder: 10,
    availableOrders: [4, 8],
    matchedCells: [101],
    precision: "estimated",
    completeness: "incomplete",
    scienceFileScan: "not-scanned",
    sourceIdentity: "MAST observation 26442812",
    instrument: "ACS/WFC",
    filters: "F606W, F814W",
    sourceSnapshotSha256: "c".repeat(64),
    sourceLabel: "MAST observation 26442812",
    summary: "Estimated observation footprint; no science files were scanned.",
  }]);
});
