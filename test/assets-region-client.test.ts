import assert from "node:assert/strict";
import test from "node:test";

import { AssetsCoverageOverviewClient, AssetsRegionClient, AssetsRegionRateLimitError } from "../src/assets-region-client.js";

test("Assets rate limits retain their retry delay without retrying or falling back", async () => {
  let requests = 0;
  const client = new AssetsRegionClient({ catalogUrl: "http://assets.test/api/v1/resource-packages/catalog.json",
    getApiKey: async () => "asa_live_test", fetchImpl: (async () => {
      requests++;
      return new Response('{"error":"limited"}', { status: 429, headers: { "Retry-After": "17" } });
    }) as typeof fetch });
  await assert.rejects(client.lookup({ layerIds: ["public-layer"], order: 4, cells: [637], cursor: "fixture" }),
    (error: unknown) => error instanceof AssetsRegionRateLimitError && error.retryAfterSeconds === 17);
  assert.equal(requests, 1);
});

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
  assert.deepEqual(JSON.parse(String(request.init.body)), { layerIds: ["euclid-layer"], order: 8, cells: [549009], limit: 1000, pageSize: 100 });
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

test("AssetsCoverageOverviewClient reads only the two estimated DR9 order-4 public layers", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const layerRows = [
    { layerId: "source-units-legacy-surveys-legacy-dr9-coadded-imaging", product: "Coadded imaging", cells: [11, 12] },
    { layerId: "source-units-legacy-surveys-legacy-dr9-tractor-catalog", product: "Tractor catalog", cells: [12] },
  ];
  const client = new AssetsCoverageOverviewClient({
    catalogUrl: "http://assets.test/api/v1/resource-packages/catalog.json",
    getApiKey: async () => "asa_live_test",
    fetchImpl: (async (url, init) => {
      const requestUrl = new URL(String(url));
      requests.push({ url: requestUrl.href, init: init ?? {} });
      const body = JSON.parse(String(init?.body)) as { layerId: string; order: number; tile: number };
      const index = layerRows.findIndex(({ layerId }) => layerId === body.layerId);
      if (requestUrl.pathname !== "/api/v1/access/coverage-block" || index < 0) return new Response("not found", { status: 404 });
      const layerId = layerRows[index]!.layerId;
      const product = layerRows[index]!.product;
      return new Response(JSON.stringify({
        generatedAt: "2026-10-01T00:00:00.000Z",
        layerId,
        surveyId: "legacy-surveys",
        releaseId: "legacy-dr9",
        product,
        modality: product === "Coadded imaging" ? "imaging" : "catalog",
        availableOrders: [4],
        overviewOrder: 4,
        maxOrder: 4,
        cellCount: layerRows[index]!.cells.length,
        revision: `${layerId}-revision`,
        sourceUnitIndex: { status: "estimated", notes: "Native DR9 brick candidates; order-4 overview." },
        order: 4,
        tileId: 0,
        cells: layerRows[index]!.cells,
        sha256: "a".repeat(64),
      }), { status: 200 });
    }) as typeof fetch,
  });

  const footprints = await client.legacyDr9Footprints();
  assert.equal(footprints.length, 2);
  assert.deepEqual(footprints.map(({ product, pixels, layerId, quality, nside }) => ({ product, pixels, layerId, quality, nside })), [
    {
      product: "Coadded imaging",
      pixels: [11, 12],
      layerId: "source-units-legacy-surveys-legacy-dr9-coadded-imaging",
      quality: "official_overview",
      nside: 16,
    },
    {
      product: "Tractor catalog",
      pixels: [12],
      layerId: "source-units-legacy-surveys-legacy-dr9-tractor-catalog",
      quality: "official_overview",
      nside: 16,
    },
  ]);
  assert.equal(requests.length, 2);
  assert.ok(requests.every(({ init }) => new Headers(init.headers).get("X-Assets-API-Key") === "asa_live_test"));
  assert.ok(requests.every(({ init }) => JSON.parse(String(init.body)).order === 4));
  assert.ok(requests.every(({ url }) => new URL(url).pathname === "/api/v1/access/coverage-block"));
  assert.ok(footprints.every(({ notes }) => notes.includes("overview")));
});

test("AssetsCoverageOverviewClient rejects non-O4 precision returned by Assets", async () => {
  const client = new AssetsCoverageOverviewClient({
    catalogUrl: "http://assets.test/api/v1/resource-packages/catalog.json",
    getApiKey: async () => "asa_live_test",
    fetchImpl: (async () => new Response(JSON.stringify({
      generatedAt: "2026-10-01T00:00:00.000Z",
      layerId: "source-units-legacy-surveys-legacy-dr9-coadded-imaging",
      surveyId: "legacy-surveys",
      releaseId: "legacy-dr9",
      product: "Coadded imaging",
      availableOrders: [4, 8],
      overviewOrder: 4,
      maxOrder: 8,
      cellCount: 1,
      revision: "revision",
      sourceUnitIndex: { status: "estimated", notes: "DR9" },
      order: 4,
      tileId: 0,
      cells: [1],
      sha256: "a".repeat(64),
    }), { status: 200 })) as typeof fetch,
  });
  await assert.rejects(() => client.legacyDr9Footprints(), /invalid DR9 overview block/);
});

test("streamed public batches stay request-scoped and cannot carry private selectors upstream", async () => {
  const unit = { layerId: "euclid-layer", productId: "euclid-product", surveyId: "euclid", releaseId: "euclid-q1", product: "VIS", unitKind: "tile", unitId: "42", order: 4, nside: 16, matchingCells: [637], precision: "estimated", accessUri: "https://eas.esac.esa.int/source/42" };
  const complete = { available: true, precision: "estimated", truncated: false, requested: { layerIds: ["euclid-layer"], order: 4, cells: [637] }, downloadPlan: { spatialUnits: [unit] } };
  let events = 0;
  const client = new AssetsRegionClient({ catalogUrl: "http://assets.test/api/v1/resource-packages/catalog.json", getApiKey: async () => "asa_live_test", fetchImpl: (async (_url, init) => {
    assert.equal(new Headers(init?.headers).get("Accept"), "text/event-stream");
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(Object.keys(body).sort(), ["cells", "layerIds", "order", "pageSize"]);
    const frames = [{ event: "progress", value: { stage: "native", layerId: "euclid-layer", state: "completed", total: 1 } },
      { event: "batch", value: { units: [unit, { ...unit, layerId: "unrequested-layer" }] } }, { event: "complete", value: complete }];
    return new Response(frames.map(frame => `event: ${frame.event}\ndata: ${JSON.stringify(frame.value)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
  }) as typeof fetch });
  const input = { layerIds: ["euclid-layer"], order: 4, cells: [637], privatePath: "/synthetic/private", privateScan: "synthetic" };
  const result = await client.lookup(input, event => { events++; if (event.event === "batch") { assert.equal(event.value.result.spatialUnits!.length, 1); assert.equal(event.value.provisional, true); } });
  assert.equal(events, 2); assert.deepEqual(result?.spatialUnits, [unit]);
  assert.equal(result?.truncated, false);
});
