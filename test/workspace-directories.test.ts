import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { directoryLocations, immediateParentDirectory, regionPixelFilter, type WorkspaceFileLocation } from "../src/workspace-directories.js";
import { AssetsRegionClient } from "../src/assets-region-client.js";
import { workspaceManifestCsv } from "../viewer/src/overlap-manifest.js";

test("directories are immediate file parents, deduplicated with actual order and modality", () => {
  assert.equal(immediateParentDirectory("/data/csst/visit42/image.fits"), "/data/csst/visit42");
  assert.equal(immediateParentDirectory("oss://u:secret@bucket/csst/visit42/image.fits?token=x#private"), "oss://bucket/csst/visit42/");
  assert.equal(immediateParentDirectory("/image.fits"), undefined);
  assert.equal(immediateParentDirectory("/data/csst/visit42/"), undefined);
  assert.equal(immediateParentDirectory("oss://bucket/csst/visit42/"), undefined);
  const file: WorkspaceFileLocation = { layerId: "workspace-csst", surveyId: "csst", releaseId: "local", modality: "imaging", sourceUri: "/data/csst/visit42/image.fits", order: 8, matchingCells: [100], precision: "estimated" };
  const directories = directoryLocations([file, { ...file, sourceUri: "/data/csst/visit42/image2.fits", matchingCells: [101] }], () => "workspace:asset:csst");
  assert.equal(directories.length, 1); assert.equal(directories[0]!.directoryUri, "/data/csst/visit42");
  assert.deepEqual(directories[0]!.matchingCells, [100, 101]);
  assert.deepEqual(regionPixelFilter("cell", 8, 4, [2]), { range: { cell: { gte: 512, lte: 767 } } });
  assert.deepEqual(directoryLocations([file], () => undefined), [], "unowned source locations are excluded");
});

test("CSV retains private directories and unavailable public lookup status", () => {
  const directory = directoryLocations([{ layerId: "csst", sourceUri: "/local/visit/image.fits", order: 8, matchingCells: [202250], precision: "exact", matchingCellsTruncated: true }], () => "workspace:csst");
  const csv = workspaceManifestCsv(undefined, directory, true, { componentId: "C04", order: 8, cells: [202250],
    unavailable: [{ sourceId: "public:hst", reason: "API Key required" }], warnings: ["Private scan is incomplete"] });
  assert.match(csv, /workspace-directory/);
  assert.match(csv, /\/local\/visit/);
  assert.doesNotMatch(csv, /image\.fits/);
  assert.match(csv, /API Key required/);
  assert.match(csv, /Private scan is incomplete/);
  assert.match(csv, /C04/);
  assert.match(csv, /matchingCellsTruncated/);
});

test("Workspace sends only public region selectors and keeps all native-unit links for temporary display/export", async () => {
  let body: Record<string, unknown> = {};
  const unit = { layerId: "euclid", productId: "product", surveyId: "euclid", releaseId: "ero", product: "ERO", modality: "imaging", unitKind: "target", unitId: "ERO-Abell2390", order: 8, nside: 256, matchingCells: [202250], precision: "estimated", accessUri: "https://example.test/vis.tar", accessUris: [{ uri: "https://example.test/vis.tar" }, { uri: "https://example.test/nisp.tar" }], sRegion: "POLYGON ICRS 1 1 2 1 2 2 1 2" };
  const client = new AssetsRegionClient({ catalogUrl: "https://assets.test/api/v1/resource-packages/catalog.json", getApiKey: async () => "key", fetchImpl: async (_input, init) => {
    body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ available: true, precision: "estimated", truncated: false, requested: { layerIds: ["euclid"], order: 8, cells: [202250] },
      querySnapshot: { id: "a".repeat(64), expiresAt: "2099-01-01", queryExhausted: true, inventoryComplete: false },
      page: { pageSize: 100, shown: 1, omitted: 0, hasMore: false }, notes: [], downloadPlan: { schemaVersion: 1, spatialUnits: [unit], files: [], entrypoints: [], truncated: false, warnings: [] } }));
  } });
  const input = { layerIds: ["euclid"], order: 8, cells: [202250], csstPath: "/private/csst", scanRunId: "private-run" };
  const result = await client.lookup(input);
  assert.equal(JSON.stringify(body).includes("private"), false); assert.equal(body.pageSize, 100);
  assert.deepEqual(result!.spatialUnits?.[0]?.accessUris, unit.accessUris);
  assert.equal(result!.spatialUnits?.[0]?.sRegion, unit.sRegion);
  const csv = workspaceManifestCsv(result, [], false);
  assert.match(csv, /vis\.tar/); assert.match(csv, /nisp\.tar/); assert.match(csv, /POLYGON/);
  assert.equal(result!.querySnapshot?.inventoryComplete, false);
});

test("without an API Key public lookup sends no upstream request; region lookup has no crawler or persistence path", async () => {
  const client = new AssetsRegionClient({ catalogUrl: "https://assets.test/catalog", getApiKey: async () => undefined,
    fetchImpl: async () => { throw new Error("must not fetch public lookup without a key"); } });
  assert.equal(await client.lookup({ layerIds: ["public"], order: 8, cells: [100] }), undefined);
  const source = await readFile(new URL("../src/http-server.ts", import.meta.url), "utf8");
  const block = source.slice(source.indexOf("async function reverseLookupFiles"), source.indexOf('app.post("/api/sky/overlap"'));
  assert.doesNotMatch(block, /discoverSourceFiles|writeFile|putMutable|putImmutable|submitCoverageDownload/);
});
