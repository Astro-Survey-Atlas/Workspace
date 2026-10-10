import { createHash } from "node:crypto";
import dnsPromises from "node:dns/promises";
import { syncBuiltinESMExports } from "node:module";
import assert from "node:assert/strict";
import test from "node:test";

import {
  RegionDownloadPlanError,
  RegionDownloadPlanService,
  type RegionDownloadSelection,
  type RegionDownloadPreview,
} from "../src/region-download-plan.js";
import {
  AssetsRegionRateLimitError,
  type AssetsRegionLookupRequest,
  type AssetsRegionLookupResponse,
  type AssetsRegionSpatialUnit,
} from "../src/assets-region-client.js";
import { computeInventoryDigest } from "../src/source-crawler.js";

const SNAPSHOT_EXPIRY = "2099-01-01T00:00:00.000Z";
const baseSelection: RegionDownloadSelection = { layerIds: ["euclid-layer"], order: 8, cells: [1] };

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, member]) => member !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function previewDigest(preview: RegionDownloadPreview, limits = preview.limits): string {
  const value = {
    selection: preview.selection,
    querySnapshotId: preview.querySnapshotId,
    nativeUnitIndexRevision: preview.nativeUnitIndexRevision,
    expiresAt: preview.expiresAt,
    inventory: preview.inventory,
    limits,
  };
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function unit(overrides: Partial<AssetsRegionSpatialUnit> = {}): AssetsRegionSpatialUnit {
  return {
    layerId: "euclid-layer",
    productId: "euclid-q1-vis",
    surveyId: "euclid",
    releaseId: "euclid-q1",
    product: "VIS",
    unitKind: "tile",
    unitId: "tile-42",
    order: 8,
    nside: 256,
    matchingCells: [1],
    precision: "exact",
    ...overrides,
  };
}

function response(
  request: AssetsRegionLookupRequest,
  spatialUnits: AssetsRegionSpatialUnit[],
  options: {
    snapshotId?: string;
    revision?: string;
    hasMore?: boolean;
    nextCursor?: string;
    requestedOrder?: number;
    requestedLayerIds?: string[];
    requestedCells?: number[];
    truncated?: boolean;
  } = {},
): AssetsRegionLookupResponse {
  const hasMore = options.hasMore ?? false;
  return {
    available: true,
    ...(options.revision === undefined ? { nativeUnitIndexRevision: "revision-1" } : { nativeUnitIndexRevision: options.revision }),
    precision: options.truncated ? "truncated" : "exact",
    truncated: options.truncated ?? false,
    requested: {
      layerIds: options.requestedLayerIds ?? request.layerIds,
      order: options.requestedOrder ?? request.order,
      cells: options.requestedCells ?? request.cells,
    },
    expiresAt: SNAPSHOT_EXPIRY,
    notes: ["Assets public note"],
    files: [],
    spatialUnits,
    page: { pageSize: 100, shown: spatialUnits.length, omitted: 0, hasMore, ...(options.nextCursor ? { nextCursor: options.nextCursor } : {}) },
    querySnapshot: { id: options.snapshotId ?? "snapshot-1", expiresAt: SNAPSHOT_EXPIRY, queryExhausted: !hasMore, inventoryComplete: false },
    downloadPlan: { schemaVersion: 1, spatialUnits, files: [], entrypoints: [], coverageEvidence: [], scanScopes: [], truncated: options.truncated ?? false, warnings: [] },
  };
}

function client(lookup: (request: AssetsRegionLookupRequest) => Promise<AssetsRegionLookupResponse | undefined>) {
  return { lookup };
}

function sourceMetadataFetch(contentLength = 100, requested: string[] = []): typeof fetch {
  return (async (input, init) => {
    const url = String(input);
    requested.push(`${init?.method ?? "GET"} ${url}`);
    if (init?.method !== "HEAD") throw new Error(`unexpected source request: ${init?.method ?? "GET"} ${url}`);
    return new Response(null, { status: 200, headers: { "content-type": "application/fits", "content-length": String(contentLength) } });
  }) as typeof fetch;
}

test("region download lookup fails without a Key and makes no source request", async () => {
  let sourceCalls = 0;
  const service = new RegionDownloadPlanService({
    client: client(async () => undefined),
    sourceResolveOptions: { fetchImpl: async () => { sourceCalls += 1; throw new Error("must not reach source"); } },
  });
  await assert.rejects(() => service.preview(baseSelection), (error: unknown) => error instanceof RegionDownloadPlanError && error.statusCode === 401);
  assert.equal(sourceCalls, 0);
});

test("region download plan keeps default DNS validation with its wrapped production fetch", async () => {
  const originalLookup = dnsPromises.lookup;
  const originalFetch = globalThis.fetch;
  let sourceFetchCalls = 0;
  Reflect.set(dnsPromises, "lookup", async () => [{ address: "10.0.0.8", family: 4 }]);
  syncBuiltinESMExports();
  globalThis.fetch = (async () => {
    sourceFetchCalls += 1;
    return new Response(null, { status: 200, headers: { "content-type": "application/fits", "content-length": "100" } });
  }) as typeof fetch;
  try {
    const service = new RegionDownloadPlanService({
      client: client(async (request) => response(request, [unit({ accessUris: [{ uri: "https://public.example.test/data.fits" }] })])),
    });
    const preview = await service.preview(baseSelection);
    assert.equal(sourceFetchCalls, 0);
    assert.equal(preview.inventory.files.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    Reflect.set(dnsPromises, "lookup", originalLookup);
    syncBuiltinESMExports();
  }
});

test("region download lookup rejects wrong snapshot, request order, and returned unit identity", async () => {
  const snapshotService = new RegionDownloadPlanService({
    client: client(async (request) => response(request, [], { snapshotId: "other-snapshot" })),
  });
  await assert.rejects(() => snapshotService.preview({ ...baseSelection, querySnapshotId: "snapshot-1" }),
    (error: unknown) => error instanceof RegionDownloadPlanError && error.statusCode === 409);

  const orderService = new RegionDownloadPlanService({
    client: client(async (request) => response(request, [], { requestedOrder: request.order - 1 })),
  });
  await assert.rejects(() => orderService.preview(baseSelection),
    (error: unknown) => error instanceof RegionDownloadPlanError && error.statusCode === 409);

  const identityService = new RegionDownloadPlanService({
    client: client(async (request) => response(request, [unit({ layerId: "different-layer" })])),
  });
  await assert.rejects(() => identityService.preview(baseSelection),
    (error: unknown) => error instanceof RegionDownloadPlanError && error.statusCode === 409);
});

test("the same frozen selection accepts reordered echo arrays but rejects changed members", async () => {
  const selection: RegionDownloadSelection = {
    layerIds: ["euclid-layer-b", "euclid-layer"], order: 8, cells: [2, 1], querySnapshotId: "snapshot-1",
  };
  const service = new RegionDownloadPlanService({
    client: client(async (request) => response(request, [unit({ accessUri: "https://example.test/a.fits" })], {
      requestedLayerIds: [...request.layerIds].reverse(), requestedCells: [...request.cells].reverse(),
    })),
    sourceResolveOptions: { fetchImpl: sourceMetadataFetch() },
  });
  const preview = await service.preview(selection);
  assert.equal(preview.querySnapshotId, "snapshot-1");
  assert.deepEqual(preview.selection.layerIds, ["euclid-layer", "euclid-layer-b"]);
  assert.deepEqual(preview.selection.cells, [1, 2]);
  assert.equal(preview.inventory.files.length, 1);

  for (const echo of [
    { requestedLayerIds: ["euclid-layer", "foreign-layer"] },
    { requestedLayerIds: ["euclid-layer", "euclid-layer"] },
    { requestedCells: [1, 3] },
  ]) {
    let sourceCalls = 0;
    const rejected = new RegionDownloadPlanService({
      client: client(async (request) => response(request, [], echo)),
      sourceResolveOptions: { fetchImpl: async () => { sourceCalls++; throw new Error("must not reach source"); } },
    });
    await assert.rejects(() => rejected.preview(selection),
      (error: unknown) => error instanceof RegionDownloadPlanError && error.statusCode === 409);
    assert.equal(sourceCalls, 0);
  }
});

test("explicit unit lookup pages the same Assets snapshot and resolves only the selected unit", async () => {
  const allUrls: string[] = [];
  const tileA = unit({ unitId: "tile-a", accessUri: "https://example.test/a/", accessUris: [{ uri: "https://example.test/a.fits" }] });
  const tileB = unit({ unitId: "tile-b", accessUri: "https://example.test/b-root/", accessUris: [{ uri: "https://example.test/b.fits" }] });
  const calls: AssetsRegionLookupRequest[] = [];
  const service = new RegionDownloadPlanService({
    client: client(async (request) => {
      calls.push(request);
      return calls.length === 1
        ? response(request, [tileA], { hasMore: true, nextCursor: "cursor-1" })
        : response(request, [tileB]);
    }),
    sourceResolveOptions: { fetchImpl: sourceMetadataFetch(100, allUrls) },
  });
  const selection: RegionDownloadSelection = {
    ...baseSelection,
    querySnapshotId: "snapshot-1",
    nativeUnitIndexRevision: "revision-1",
    units: [{ layerId: "euclid-layer", unitKind: "tile", unitId: "tile-b" }],
  };
  const preview = await service.preview(selection);

  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.querySnapshotId, "snapshot-1");
  assert.equal(calls[1]?.querySnapshotId, "snapshot-1");
  assert.equal(calls[1]?.cursor, "cursor-1");
  assert.deepEqual(allUrls, ["HEAD https://example.test/b.fits"]);
  assert.deepEqual(preview.inventory.files.map((file) => file.url), ["https://example.test/b.fits"]);
  assert.equal(preview.inventory.files[0]?.layerId, "euclid-layer");
  assert.equal(preview.inventory.files[0]?.nativeUnitKind, "tile");
  assert.equal(preview.inventory.files[0]?.nativeUnitId, "tile-b");
  assert.equal(preview.selection.units?.[0]?.unitId, "tile-b");
  assert.equal(preview.selectionTruncated, false);
});

test("explicit unit lookup sends the learned snapshot id on the next cursor request", async () => {
  const calls: AssetsRegionLookupRequest[] = [];
  const service = new RegionDownloadPlanService({
    client: client(async (request) => {
      calls.push(request);
      return calls.length === 1
        ? response(request, [unit({ unitId: "tile-a" })], { hasMore: true, nextCursor: "cursor-1" })
        : response(request, [unit({ unitId: "tile-b", accessUris: [{ uri: "https://example.test/b.fits" }] })]);
    }),
    sourceResolveOptions: { fetchImpl: sourceMetadataFetch() },
  });

  await service.preview({
    ...baseSelection,
    units: [{ layerId: "euclid-layer", unitKind: "tile", unitId: "tile-b" }],
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.querySnapshotId, undefined);
  assert.equal(calls[1]?.querySnapshotId, "snapshot-1");
  assert.equal(calls[1]?.cursor, "cursor-1");
});

test("a region-only preview returns explicit first-page identities and warns when more units exist", async () => {
  const service = new RegionDownloadPlanService({
    client: client(async (request) => response(request, [unit({ accessUris: [{ uri: "https://example.test/a.fits" }] })], { hasMore: true, nextCursor: "next" })),
    sourceResolveOptions: { fetchImpl: sourceMetadataFetch() },
  });
  const preview = await service.preview(baseSelection);
  assert.equal(preview.selectionTruncated, true);
  assert.deepEqual(preview.selection.units, [{ layerId: "euclid-layer", unitKind: "tile", unitId: "tile-42" }]);
  assert.ok(preview.notes.some((note) => /More native units/.test(note)));
});

test("confirm accepts the explicit selection returned by a truncated region-only preview", async () => {
  const candidate = unit({ accessUris: [{ uri: "https://example.test/first-page.fits" }] });
  const service = new RegionDownloadPlanService({
    client: client(async (request) => response(request, [candidate], { hasMore: true, nextCursor: "next" })),
    sourceResolveOptions: { fetchImpl: sourceMetadataFetch() },
  });
  const preview = await service.preview(baseSelection);
  assert.equal(preview.selectionTruncated, true);
  const selected = await service.confirm({
    selection: preview.selection,
    previewSha256: preview.planSha256,
    selectedFileUrls: [preview.inventory.files[0]!.url],
  });
  assert.equal(selected.files.length, 1);
  assert.equal(selected.truncated, false);
});

test("confirmation fingerprint ignores advisory notes that vary between region and explicit previews", async () => {
  const candidate = unit({ accessUris: [{ uri: "https://example.test/stable.fits" }] });
  const observedNotes: string[] = [];
  const service = new RegionDownloadPlanService({
    client: client(async (request) => {
      const note = request.querySnapshotId ? "Explicit selection advisory" : "First-page advisory";
      observedNotes.push(note);
      return { ...response(request, [candidate]), notes: [note] };
    }),
    sourceResolveOptions: { fetchImpl: sourceMetadataFetch() },
  });
  const preview = await service.preview(baseSelection);
  const selected = await service.confirm({
    selection: preview.selection,
    previewSha256: preview.planSha256,
    selectedFileUrls: [preview.inventory.files[0]!.url],
  });

  assert.deepEqual(observedNotes, ["First-page advisory", "Explicit selection advisory"]);
  assert.equal(selected.files.length, 1);
});

test("preview fingerprint binds the declared confirmation limits", async () => {
  const service = new RegionDownloadPlanService({ client: client(async (request) => response(request, [])) });
  const preview = await service.preview(baseSelection);
  const changedLimits = { ...preview.limits, maxFiles: preview.limits.maxFiles + 1 };

  assert.equal(preview.planSha256, previewDigest(preview));
  assert.notEqual(previewDigest(preview, changedLimits), preview.planSha256);
});

test("Assets truncation is carried into the selected confirmation inventory", async () => {
  const candidate = unit({ accessUris: [{ uri: "https://example.test/incomplete.fits" }] });
  const service = new RegionDownloadPlanService({
    client: client(async (request) => response(request, [candidate], { truncated: true })),
    sourceResolveOptions: { fetchImpl: sourceMetadataFetch() },
  });
  const preview = await service.preview(baseSelection);
  assert.equal(preview.inventory.truncated, true);
  const selected = await service.confirm({
    selection: preview.selection,
    previewSha256: preview.planSha256,
    selectedFileUrls: [preview.inventory.files[0]!.url],
  });
  assert.equal(selected.truncated, true);
});

test("DESI directories must be exact official cumulative tile leaves", async () => {
  const desi = unit({
    layerId: "desi-layer",
    productId: "desi-dr1-spectro",
    surveyId: "desi",
    releaseId: "desi-dr1",
    product: "spectra",
    unitKind: "tile",
    unitId: "406:20210406",
    accessUri: "https://data.desi.lbl.gov/public/dr1/spectro/redux/iron/tiles/cumulative/406/20210406/",
  });
  const requested: string[] = [];
  const service = new RegionDownloadPlanService({
    client: client(async (request) => response(request, [desi])),
    sourceResolveOptions: { fetchImpl: (async (input) => {
      requested.push(String(input));
      return new Response('<a href="coadd-0-1-thru20210406.fits">coadd</a>', { status: 200, headers: { "content-type": "text/html" } });
    }) as typeof fetch },
  });
  const preview = await service.preview({ layerIds: ["desi-layer"], order: 8, cells: [1] });
  assert.equal(preview.inventory.files.length, 1);
  assert.equal(preview.inventory.files[0]?.url, "https://data.desi.lbl.gov/public/dr1/spectro/redux/iron/tiles/cumulative/406/20210406/coadd-0-1-thru20210406.fits");
  assert.deepEqual(requested, ["https://data.desi.lbl.gov/public/dr1/spectro/redux/iron/tiles/cumulative/406/20210406/"]);
});

test("duplicate native-unit URI shapes keep the supplied Legacy filename once", async () => {
  const uri = "https://example.test/file-2545p667-opaque.fits";
  const requested: string[] = [];
  const legacy = unit({
    layerId: "legacy-dr10-south",
    productId: "legacy-dr10-imaging",
    surveyId: "legacy-surveys",
    releaseId: "dr10-south",
    product: "image",
    unitId: "2545p667",
    accessUris: [{ uri, fileName: "legacysurvey-2545p667.fits" }],
    accessUri: uri,
  });
  const service = new RegionDownloadPlanService({
    client: client(async (request) => response(request, [legacy])),
    sourceResolveOptions: { fetchImpl: sourceMetadataFetch(100, requested) },
  });

  const preview = await service.preview({ layerIds: ["legacy-dr10-south"], order: 8, cells: [1] });

  assert.equal(preview.inventory.files.length, 1);
  assert.equal(preview.inventory.files[0]?.url, uri);
  assert.ok(preview.inventory.files[0]?.relativePath.endsWith("/legacysurvey-2545p667.fits"));
  assert.deepEqual(requested, [`HEAD ${uri}`]);
});

test("preview deduplicates physical URLs across native units and keeps one stable owner", async () => {
  const sharedUrl = "https://example.test/shared.fits";
  const layerAUrl = "https://example.test/layer-a.fits";
  const layerBUrl = "https://example.test/layer-b.fits";
  const units = [
    unit({ unitId: "tile-a", accessUris: [{ uri: sharedUrl }, { uri: layerAUrl }] }),
    unit({ layerId: "euclid-layer-b", unitId: "tile-b", accessUris: [{ uri: sharedUrl }, { uri: layerBUrl }] }),
  ];
  const requested: string[] = [];
  const service = new RegionDownloadPlanService({
    client: client(async (request) => response(request, units)),
    sourceResolveOptions: { fetchImpl: sourceMetadataFetch(100, requested) },
  });
  const selection: RegionDownloadSelection = { layerIds: ["euclid-layer", "euclid-layer-b"], order: 8, cells: [1] };
  const preview = await service.preview(selection);
  const sharedFiles = preview.inventory.files.filter((file) => file.url === sharedUrl);
  const sharedFile = sharedFiles[0];

  assert.equal(preview.inventory.files.length, 3);
  assert.equal(sharedFiles.length, 1);
  assert.deepEqual(preview.selection.units?.map((native) => native.unitId).sort(), ["tile-a", "tile-b"]);
  assert.ok(sharedFile?.nativeUnitId === "tile-a" || sharedFile?.nativeUnitId === "tile-b");
  assert.equal(preview.inventory.units.reduce((sum, unitResolution) => sum + unitResolution.fileCount, 0), 3);
  assert.equal(preview.inventory.units.filter((unitResolution) => unitResolution.fileCount === 0).length, 1);
  assert.equal(preview.unavailable.some((item) => item.layerId === "euclid-layer-b"), false);
  assert.deepEqual(requested.sort(), [`HEAD ${layerAUrl}`, `HEAD ${layerBUrl}`, `HEAD ${sharedUrl}`].sort());

  const confirmed = await service.confirm({
    selection: preview.selection,
    previewSha256: preview.planSha256,
    selectedFileUrls: [sharedUrl],
  });
  assert.equal(confirmed.files.length, 1);
  assert.equal(confirmed.files[0]?.nativeUnitId, sharedFile?.nativeUnitId);
  assert.equal(confirmed.units.length, 1);
  assert.equal(confirmed.units[0]?.unitId, sharedFile?.unitId);
  assert.equal(confirmed.units[0]?.fileCount, 1);
});

test("confirmation returns the selected-only inventory and ignores unavailable unselected units", async () => {
  const files = ["one.fits", "two.fits"];
  const selectedUnit = unit({ unitId: "tile-files", accessUris: files.map((name) => ({ uri: `https://example.test/${name}` })) });
  const unavailableUnit = unit({ unitId: "entrypoint-only", accessUri: "https://example.test/catalog/" });
  const service = new RegionDownloadPlanService({
    client: client(async (request) => response(request, [selectedUnit, unavailableUnit])),
    sourceResolveOptions: { fetchImpl: sourceMetadataFetch() },
  });
  const preview = await service.preview(baseSelection);
  assert.ok(preview.unavailable.some((item) => item.unitId === "entrypoint-only"));
  assert.equal(preview.inventory.files.length, 2);
  const selectedUrl = preview.inventory.files[0]!.url;
  const selected = await service.confirm({ selection: preview.selection, previewSha256: preview.planSha256, selectedFileUrls: [selectedUrl] });

  assert.equal(selected.files.length, 1);
  assert.equal(selected.files[0]?.url, selectedUrl);
  assert.equal(selected.units.length, 1);
  assert.equal(selected.units[0]?.fileCount, 1);
  assert.equal(selected.inventorySha256, computeInventoryDigest(selected.files, selected.units));
});

test("confirmation rejects a source inventory that changed after preview", async () => {
  let size = 100;
  const service = new RegionDownloadPlanService({
    client: client(async (request) => response(request, [unit({ accessUris: [{ uri: "https://example.test/data.fits" }] })])),
    sourceResolveOptions: { fetchImpl: (async (_input, init) => new Response(null, { status: 200, headers: { "content-type": "application/fits", "content-length": String(size) } })) as typeof fetch },
  });
  const preview = await service.preview(baseSelection);
  size = 200;
  await assert.rejects(() => service.confirm({
    selection: preview.selection,
    previewSha256: preview.planSha256,
    selectedFileUrls: [preview.inventory.files[0]!.url],
  }), (error: unknown) => error instanceof RegionDownloadPlanError && error.statusCode === 409);
});

test("direct science file query URLs use the returned file_name metadata", async () => {
  const service = new RegionDownloadPlanService({
    client: client(async (request) => response(request, [unit({ accessUris: [{ uri: "https://example.test/download?file_name=brick-123.fits" }] })])),
    sourceResolveOptions: { fetchImpl: sourceMetadataFetch() },
  });
  const preview = await service.preview(baseSelection);
  assert.equal(preview.inventory.files[0]?.relativePath.endsWith("/brick-123.fits"), true);
});

test("source metadata lookup runs concurrently with a bound and deduplicates repeated URLs", async () => {
  let active = 0;
  let maximumActive = 0;
  const requested: string[] = [];
  const units = Array.from({ length: 8 }, (_, index) => unit({
    unitId: `tile-${index}`,
    accessUris: [{ uri: `https://example.test/file-${index === 7 ? 0 : index}.fits` }],
  }));
  const service = new RegionDownloadPlanService({
    client: client(async (request) => response(request, units)),
    sourceResolveOptions: { fetchImpl: (async (input, init) => {
      requested.push(String(input));
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return new Response(null, { status: 200, headers: { "content-type": "application/fits", "content-length": "100" } });
    }) as typeof fetch },
  });
  const preview = await service.preview(baseSelection);
  assert.equal(preview.inventory.files.length, 7);
  assert.equal(new Set(preview.inventory.files.map((file) => file.url)).size, 7);
  assert.equal(requested.length, 7);
  assert.ok(maximumActive > 1 && maximumActive <= 4);
});

test("region preview caps per-source metadata timeout at 30 seconds", async () => {
  const originalTimeout = AbortSignal.timeout;
  const requestedTimeouts: number[] = [];
  AbortSignal.timeout = ((milliseconds: number) => {
    requestedTimeouts.push(milliseconds);
    return new AbortController().signal;
  }) as typeof AbortSignal.timeout;
  try {
    const service = new RegionDownloadPlanService({
      client: client(async (request) => response(request, [unit({ accessUris: [{ uri: "https://example.test/slow.fits" }] })])),
      sourceResolveOptions: { fetchImpl: sourceMetadataFetch(), timeoutMs: 60_000 },
    });
    await service.preview(baseSelection);
  } finally {
    AbortSignal.timeout = originalTimeout;
  }
  assert.deepEqual(requestedTimeouts, [30_000]);
});

test("confirmation allows files and task totals above the former 2 GiB limits", async () => {
  const largeFileBytes = 3 * 1024 * 1024 * 1024;
  const service = new RegionDownloadPlanService({
    client: client(async (request) => response(request, [unit({ accessUris: [{ uri: "https://example.test/large.fits" }] })])),
    sourceResolveOptions: { fetchImpl: sourceMetadataFetch(largeFileBytes) },
  });
  const preview = await service.preview(baseSelection);
  assert.deepEqual(preview.limits, { maxFiles: 128 });
  const confirmed = await service.confirm({
    selection: preview.selection,
    previewSha256: preview.planSha256,
    selectedFileUrls: [preview.inventory.files[0]!.url],
  });
  assert.equal(confirmed.files[0]?.sizeBytes, largeFileBytes);

  const files = Array.from({ length: 5 }, (_, index) => ({ uri: `https://example.test/large-${index}.fits` }));
  const taskService = new RegionDownloadPlanService({
    client: client(async (request) => response(request, [unit({ unitId: "many-files", accessUris: files })])),
    sourceResolveOptions: { fetchImpl: sourceMetadataFetch(1024 * 1024 * 1024) },
  });
  const taskPreview = await taskService.preview(baseSelection);
  const task = await taskService.confirm({
    selection: taskPreview.selection,
    previewSha256: taskPreview.planSha256,
    selectedFileUrls: taskPreview.inventory.files.map((file) => file.url),
  });
  assert.equal(task.files.length, 5);
  assert.equal(task.files.reduce((sum, file) => sum + (file.sizeBytes ?? 0), 0), 5 * 1024 * 1024 * 1024);
});

test("Assets rate limits carry a typed retry delay", async () => {
  const error = new AssetsRegionRateLimitError(17);
  const service = new RegionDownloadPlanService({
    client: client(async () => { throw Object.assign(error, { name: "AssetsRegionRateLimitError" }); }),
  });
  await assert.rejects(() => service.preview(baseSelection), (failure: unknown) => failure instanceof RegionDownloadPlanError
    && failure.statusCode === 429 && failure.retryAfterSeconds === 17);
});

test("metadata redirect bodies cannot stall a deduplicated preview", async () => {
  const tracked = new Set<Response>();
  function track(value: Response): Response {
    tracked.add(value);
    value.clone = () => track(Response.prototype.clone.call(value));
    return value;
  }
  const directory = "https://data.desi.lbl.gov/public/dr1/spectro/redux/iron/tiles/cumulative/406/20210406/";
  const service = new RegionDownloadPlanService({
    client: client(async (request) => response(request, [unit({
      layerId: "desi-layer", surveyId: "desi", releaseId: "desi-dr1", product: "spectra",
      unitId: "406:20210406", accessUri: directory,
    })])),
    sourceResolveOptions: { fetchImpl: async (input) => String(input) === directory
      ? track(new Response("redirect metadata", { status: 302, headers: { location: "https://delivery.test/tile/" } }))
      : new Response('<a href="coadd.fits">coadd</a>', { headers: { "content-type": "text/html" } }) },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const preview = await Promise.race([
      service.preview({ layerIds: ["desi-layer"], order: 8, cells: [1] }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("preview stalled while cancelling a redirect body")), 200); }),
    ]);
    assert.equal(preview.inventory.files.length, 1);
  } finally {
    clearTimeout(timer);
    await Promise.allSettled([...tracked].map((value) => value.body?.cancel()));
  }
});

test("buffered directory metadata preserves the redirect URL for relative file links", async () => {
  const directory = "https://data.desi.lbl.gov/public/dr1/spectro/redux/iron/tiles/cumulative/406/20210406/";
  const destination = "https://delivery.example.test/redirected-tile/";
  const service = new RegionDownloadPlanService({
    client: client(async (request) => response(request, [unit({
      layerId: "desi-layer", surveyId: "desi", releaseId: "desi-dr1", product: "spectra",
      unitId: "406:20210406", accessUri: directory,
    })])),
    sourceResolveOptions: { fetchImpl: async (input) => {
      const url = String(input);
      const result = url === directory
        ? new Response(null, { status: 302, headers: { location: destination } })
        : new Response('<a href="coadd.fits">coadd</a>', { headers: { "content-type": "text/html" } });
      Object.defineProperty(result, "url", { value: url });
      return result;
    } },
  });
  const preview = await service.preview({ layerIds: ["desi-layer"], order: 8, cells: [1] });
  assert.deepEqual(preview.inventory.files.map((file) => file.url), [`${destination}coadd.fits`]);
});

test("preview emits a completed source while another source is still pending", async () => {
  const events: Array<{ event: string; value: Record<string, unknown> }> = [];
  let releaseSlow: (() => void) | undefined;
  const metadata = () => new Response(null, { headers: { "content-type": "application/fits", "content-length": "100" } });
  const service = new RegionDownloadPlanService({
    client: client(async (request) => response(request, [unit({ accessUris: [
      { uri: "https://example.test/fast.fits" }, { uri: "https://example.test/slow.fits" },
    ] })])),
    sourceResolveOptions: { fetchImpl: async (input) => String(input).endsWith("slow.fits")
      ? new Promise<Response>((resolve) => { releaseSlow = () => resolve(metadata()); }) : metadata() },
  });
  const pending = service.preview(baseSelection, { onUpdate: (event) => events.push(event) });
  try {
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(events.some((event) => event.event === "batch" && Array.isArray(event.value.files)
      && event.value.files.some((file) => file.url === "https://example.test/fast.fits")), "fast metadata must be visible before the slow source finishes");
    assert.ok(events.some((event) => event.event === "progress" && event.value.completed === 1));
  } finally {
    releaseSlow?.();
    const final = await pending;
    assert.equal(final.inventory.files.length, 2);
  }
});

test("cancelled previews abort active metadata and do not start queued sources", async () => {
  const controller = new AbortController();
  let started = 0, aborted = 0;
  const releases: Array<() => void> = [];
  const service = new RegionDownloadPlanService({
    client: client(async (request) => response(request, [unit({ accessUris: Array.from({ length: 8 }, (_, index) => ({ uri: `https://example.test/${index}.fits` })) })])),
    sourceResolveOptions: { fetchImpl: async (_input, init) => {
      started++;
      if (controller.signal.aborted) return new Response(null, { headers: { "content-type": "application/fits" } });
      return new Promise<Response>((resolve, reject) => {
        releases.push(() => resolve(new Response(null, { headers: { "content-type": "application/fits" } })));
        init?.signal?.addEventListener("abort", () => { aborted++; reject(init.signal?.reason); }, { once: true });
      });
    } },
  });
  const pending = service.preview(baseSelection, { signal: controller.signal });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(started, 4);
    controller.abort();
    await assert.rejects(Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("preview did not stop after cancellation")), 100);
    })]), (error: unknown) => error instanceof Error && error.name === "AbortError");
    assert.equal(aborted, 4);
    assert.equal(started, 4);
  } finally {
    clearTimeout(timer);
    releases.forEach((release) => release());
    await pending.catch(() => undefined);
  }
});
