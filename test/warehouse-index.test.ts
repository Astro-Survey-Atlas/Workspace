import assert from "node:assert/strict";
import test from "node:test";

import { WarehouseIndexService } from "../src/warehouse-index.js";
import { directoryLocations } from "../src/workspace-directories.js";

function esResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

test("private directories follow committed partition pointers and candidate observations", async () => {
  const snapshot = "a".repeat(64);
  const service = new WarehouseIndexService({ url: "https://warehouse.example", fetchImpl: async (input, init) => {
    const index = String(input).split("/").at(-2)!;
    const body = JSON.parse(String(init?.body));
    if (index === "ast_layer_index_v1") {
      return esResponse({ hits: { hits: body.query.terms.layer_id[0] === "workspace-csst" ? [{ _source: {
        layer_id: "workspace-csst", state: "ACTIVE", layer_mode: "PARTITIONED", active_scope_id: "scope", scope_snapshot_sha256: snapshot,
        survey_id: "csst", release_id: "local", product_id: "image", modality: "imaging", available_orders: [8],
      } }] : [{ _source: { layer_id: "candidate-1", state: "ACTIVE" } }] } });
    }
    if (index === "ast_partition_index_v1") return esResponse({ hits: { hits: [{ _source: {
      layer_id: "workspace-csst", scope_id: "scope", scope_snapshot_sha256: snapshot, state: "ACTIVE", partition_id: "visit42",
      active_layer_id: "candidate-1", active_scan_run_id: "run-1",
    } }] } });
    if (index === "ast_coverage_index_v1") {
      assert.deepEqual(body.query.bool.filter[0].terms.layer_id, ["candidate-1"]);
      return esResponse({ hits: { hits: ["file-1", "file-2"].map(id => ({ _source: {
        layer_id: "candidate-1", source_file_id: id, healpix_order: 8, healpix_cell: 202250, precision: "estimated",
      } })) } });
    }
    assert.equal(index, "ast_file_observation_index_v1");
    assert.deepEqual(body.query.bool.filter[0], { term: { layer_id: "candidate-1" } });
    assert.deepEqual(body.query.bool.filter[2], { term: { scan_run_id: "run-1" } });
    return esResponse({ hits: { hits: ["file-1", "file-2"].map(id => ({ _source: {
      file_id: id, layer_id: "candidate-1", scan_run_id: "run-1", source_uri: `/data/csst/visit42/${id}.fits`,
    } })) } });
  } });
  const result = await service.reverseFiles({ layerIds: ["workspace-csst"], order: 8, cells: [202250] });
  const directories = directoryLocations(result.files, id => id === "workspace-csst" ? "workspace:csst" : undefined);
  assert.equal(result.truncated, false);
  assert.equal(directories.length, 1);
  assert.equal(directories[0]!.directoryUri, "/data/csst/visit42");
  assert.equal(directories[0]!.modality, "imaging");
});

test("private region reverse lookup only joins owned ACTIVE layers and retains native edge order", async () => {
  const requests: string[] = [];
  const service = new WarehouseIndexService({ url: "https://warehouse.example", fetchImpl: async (input, init) => {
    const index = String(input).split("/").at(-2)!; const body = JSON.parse(String(init?.body)); requests.push(index);
    if (index === "ast_layer_index_v1") {
      assert.deepEqual(body.query.terms.layer_id, ["workspace-csst"]);
      return esResponse({ hits: { hits: ["workspace-csst", "assets-public"].map((id) => ({ _source: { layer_id: id, survey_id: "csst", release_id: "local", product_id: "image", state: "ACTIVE", available_orders: [8] } })) } });
    }
    if (index === "ast_coverage_index_v1") {
      assert.deepEqual(body.query.bool.filter[0].terms.layer_id, ["workspace-csst"]);
      return esResponse({ hits: { total: 2, hits: [
        { _source: { layer_id: "workspace-csst", source_file_id: "file", healpix_order: 8, healpix_cell: 512, precision: "estimated" } },
        { _source: { layer_id: "assets-public", source_file_id: "public", healpix_order: 8, healpix_cell: 512 } },
      ] } });
    }
    assert.equal(index, "ast_file_index_v1");
    return esResponse({ hits: { hits: [{ _source: { file_id: "file", source_uri: "/data/csst/visit/image.fits" } }] } });
  } });
  const result = await service.reverseFiles({ layerIds: ["workspace-csst"], order: 4, cells: [2] });
  assert.equal(result.files.length, 1); assert.equal(result.files[0]!.order, 8);
  assert.equal(result.files[0]!.sourceUri, "/data/csst/visit/image.fits"); assert.equal(result.truncated, false);
});

test("directory lookup exhausts repeated coverage edges within the unique-file limit", async () => {
  const edges = Array.from({ length: 6 }, (_, index) => ({
    sort: [index < 3 ? "file-a" : "file-b", "workspace-csst", 8, 512 + index, "image_footprint"],
    _source: { layer_id: "workspace-csst", source_file_id: index < 3 ? "file-a" : "file-b",
      healpix_order: 8, healpix_cell: 512 + index, coordinate_frame: "ICRS", nesting: "NESTED", precision: "estimated" },
  }));
  const service = new WarehouseIndexService({ url: "https://warehouse.example", maxDocuments: 2, fetchImpl: async (input, init) => {
    const index = String(input).split("/").at(-2)!;
    const body = JSON.parse(String(init?.body));
    if (index === "ast_layer_index_v1") return esResponse({ hits: { hits: [{ _source: {
      layer_id: "workspace-csst", survey_id: "csst", release_id: "local", product_id: "image", modality: "imaging", state: "ACTIVE", available_orders: [8],
    } }] } });
    if (index === "ast_coverage_index_v1") {
      const offset = body.search_after ? edges.findIndex(edge => JSON.stringify(edge.sort) === JSON.stringify(body.search_after)) + 1 : 0;
      return esResponse({ hits: { total: 6, hits: edges.slice(offset, offset + Math.min(2, body.size)) } });
    }
    assert.equal(index, "ast_file_index_v1");
    return esResponse({ hits: { hits: ["file-a", "file-b"].map(id => ({ _source: {
      file_id: id, source_uri: `/data/csst/visit/${id}.fits`,
    } })) } });
  } });
  const result = await service.reverseFiles({ layerIds: ["workspace-csst"], order: 4, cells: [2] });
  assert.equal(result.truncated, false);
  assert.equal(result.files.length, 2);
  const directories = directoryLocations(result.files, () => "workspace:csst");
  assert.equal(directories.length, 1);
  assert.equal(directories[0]!.directoryUri, "/data/csst/visit");
  assert.equal(directories[0]!.order, 8);
  assert.deepEqual(directories[0]!.matchingCells, [512, 513, 514, 515, 516, 517]);
});

test("directory aggregation drains file groups beyond the directory limit and keeps sampled native evidence", async () => {
  let pages = 0;
  const service = new WarehouseIndexService({ url: "https://warehouse.example", maxDocuments: 1, fetchImpl: async (input, init) => {
    const index = String(input).split("/").at(-2)!;
    const body = JSON.parse(String(init?.body));
    if (index === "ast_layer_index_v1") return esResponse({ hits: { hits: [{ _source: {
      layer_id: "workspace-csst", survey_id: "csst", release_id: "local", product_id: "image", modality: "imaging", state: "ACTIVE", available_orders: [8],
    } }] } });
    if (index === "ast_coverage_index_v1") {
      pages++;
      assert.equal(body.size, 0, "directory lookup must not stream raw coverage hits");
      assert.deepEqual(body.query.bool.filter[0].terms.layer_id, ["workspace-csst"]);
      assert.match(JSON.stringify(body.query), /ICRS/);
      assert.match(JSON.stringify(body.query), /NESTED/);
      const after = body.aggs.files.composite.after;
      if (pages === 1) assert.equal(after, undefined);
      else assert.deepEqual(after, { fileId: pages === 2 ? "file-a" : "file-b", layerId: "workspace-csst", order: 8 });
      if (pages === 3) return esResponse({ aggregations: { files: { buckets: [] } } });
      const fileId = pages === 1 ? "file-a" : "file-b";
      return esResponse({ aggregations: { files: {
        after_key: { fileId, layerId: "workspace-csst", order: 8 },
        buckets: [{ key: { fileId, layerId: "workspace-csst", order: 8 }, doc_count: 100_000,
          matching_cell: { value: pages === 1 ? 512 : 513 },
          precisions: { buckets: [{ key: pages === 1 ? "estimated" : "exact", doc_count: 100_000 }] },
        }],
      } } });
    }
    assert.equal(index, "ast_file_index_v1");
    assert.ok(body._source, "file join fetches only locator and identity fields");
    return esResponse({ hits: { hits: [{ _source: { file_id: pages === 1 ? "file-a" : "file-b", source_uri: `/data/csst/visit/image-${pages}.fits` } }] } });
  } });
  const result = await service.reverseDirectories({ layerIds: ["workspace-csst"], order: 4, cells: [2], sourceForLayer: () => "workspace:csst" });
  assert.equal(pages, 3);
  assert.equal(result.truncated, false, "the cap applies to parents, not file groups or raw edges");
  assert.equal(result.directories.length, 1);
  assert.equal(result.directories[0]!.directoryUri, "/data/csst/visit");
  assert.equal(result.directories[0]!.order, 8);
  assert.equal(result.directories[0]!.precision, "estimated", "all matched edges contribute precision");
  assert.equal(result.directories[0]!.matchingCellsTruncated, true);
  assert.deepEqual(result.directories[0]!.matchingCells, [512, 513]);
});

test("aggregated private directories honor committed observations and report missing mappings", async () => {
  const snapshot = "a".repeat(64);
  const service = new WarehouseIndexService({ url: "https://warehouse.example", fetchImpl: async (input, init) => {
    const index = String(input).split("/").at(-2)!;
    const body = JSON.parse(String(init?.body));
    if (index === "ast_layer_index_v1") return esResponse({ hits: { hits: body.query.terms.layer_id[0] === "workspace-csst" ? [{ _source: {
      layer_id: "workspace-csst", state: "ACTIVE", layer_mode: "PARTITIONED", active_scope_id: "scope", scope_snapshot_sha256: snapshot,
      survey_id: "csst", release_id: "local", product_id: "image", available_orders: [8],
    } }] : [{ _source: { layer_id: "candidate-1", state: "ACTIVE" } }] } });
    if (index === "ast_partition_index_v1") return esResponse({ hits: { hits: [{ _source: {
      layer_id: "workspace-csst", scope_id: "scope", scope_snapshot_sha256: snapshot, state: "ACTIVE", partition_id: "visit",
      active_layer_id: "candidate-1", active_scan_run_id: "run-1",
    } }] } });
    if (index === "ast_coverage_index_v1") {
      assert.deepEqual(body.query.bool.filter[0].terms.layer_id, ["candidate-1"]);
      return esResponse({ aggregations: { files: { buckets: ["file", "missing"].map(fileId => ({
        key: { fileId, layerId: "candidate-1", order: 8 }, doc_count: 1,
        matching_cell: { value: 512 },
      })) } } });
    }
    assert.equal(index, "ast_file_observation_index_v1");
    assert.deepEqual(body.query.bool.filter[0], { term: { layer_id: "candidate-1" } });
    assert.deepEqual(body.query.bool.filter[2], { term: { scan_run_id: "run-1" } });
    return esResponse({ hits: { hits: [{ _source: { file_id: "file", layer_id: "candidate-1", scan_run_id: "run-1", source_uri: "/data/csst/visit/image.fits" } }] } });
  } });
  const result = await service.reverseDirectories({ layerIds: ["workspace-csst"], order: 4, cells: [2], sourceForLayer: () => "workspace:csst" });
  assert.equal(result.directories.length, 1);
  assert.equal(result.directories[0]!.matchingCellsTruncated, false);
  assert.equal(result.truncated, true, "missing locator leaves the parent inventory incomplete");
});

test("directory aggregation excludes unrelated groups and reports omitted parents at the directory cap", async () => {
  const service = new WarehouseIndexService({ url: "https://warehouse.example", maxDocuments: 1, fetchImpl: async (input, init) => {
    const index = String(input).split("/").at(-2)!;
    const body = JSON.parse(String(init?.body));
    if (index === "ast_layer_index_v1") return esResponse({ hits: { hits: ["workspace-csst", "assets-public"].map(layerId => ({ _source: {
      layer_id: layerId, survey_id: "csst", release_id: "local", product_id: "image", state: "ACTIVE", available_orders: [8],
    } })) } });
    if (index === "ast_coverage_index_v1") return esResponse({ aggregations: { files: { buckets: [
      { key: { fileId: "unrelated", layerId: "assets-public", order: 8 }, doc_count: 1, matching_cell: { value: 512 } },
      ...["file-a", "file-b"].map(fileId => ({ key: { fileId, layerId: "workspace-csst", order: 8 }, doc_count: 1, matching_cell: { value: 512 } })),
    ] } } });
    assert.equal(index, "ast_file_index_v1");
    assert.deepEqual(body.query.bool.should[1].terms.file_id, ["file-a", "file-b"]);
    return esResponse({ hits: { hits: ["file-a", "file-b"].map(fileId => ({ _source: { file_id: fileId, source_uri: `/data/csst/${fileId}/image.fits` } })) } });
  } });
  const result = await service.reverseDirectories({ layerIds: ["workspace-csst"], order: 4, cells: [2], sourceForLayer: () => "workspace:csst" });
  assert.equal(result.directories.length, 1);
  assert.equal(result.truncated, true);
  assert.equal(result.directories[0]!.matchingCellsTruncated, false, "directory omissions are separate from sampled cells");
});

test("loads paginated active Warehouse layers and projects real NESTED coverage", async () => {
  const requests: Array<{ index: string; body: Record<string, unknown> }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const match = /\/([^/]+)\/_search$/.exec(url);
    assert.ok(match);
    const index = decodeURIComponent(match[1]!);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    requests.push({ index, body });
    if (index === "ast_layer_index_v1") {
      const after = body.search_after as unknown[] | undefined;
      return esResponse({ hits: {
        total: { value: 2 },
        hits: after ? [{ _id: "layer-b", sort: ["layer-b"], _source: {
          layer_id: "layer-b", survey_id: "survey-b", release_id: "release-b", product_id: "product-b", state: "FAILED", available_orders: [8], error_count: 1,
        } }] : [{ _id: "layer-a", sort: ["layer-a"], _source: {
          layer_id: "layer-a", survey_id: "survey-a", release_id: "release-a", product_id: "product-a", modality: "catalog", coverage_role: "object_presence", state: "ACTIVE", available_orders: [4, 8], max_order: 10,
        } }],
      } });
    }
    const after = body.search_after as unknown[] | undefined;
    return esResponse({ hits: {
      total: { value: 2 },
      hits: after ? [{ sort: ["layer-a", "file-a", 8, 10, "object_presence"], _source: {
        layer_id: "layer-a", source_file_id: "file-a", healpix_order: 8, healpix_cell: 10, coordinate_frame: "ICRS", nesting: "NESTED", precision: "estimated", source_order: 8,
      } }] : [{ sort: ["layer-a", "file-a", 4, 2, "object_presence"], _source: {
        layer_id: "layer-a", source_file_id: "file-a", healpix_order: 4, healpix_cell: 2, coordinate_frame: "ICRS", nesting: "NESTED", precision: "exact",
      } }],
    } });
  };

  const service = new WarehouseIndexService({ url: "https://warehouse.example/", fetchImpl, maxDocuments: 10 });
  const catalog = await service.loadCatalog();
  assert.ok(catalog);
  assert.equal(catalog.layers.length, 2);
  assert.equal(catalog.coverages.length, 2);
  assert.equal(catalog.layers[0]?.state, "ACTIVE");
  assert.equal(catalog.layers[1]?.state, "FAILED");
  assert.equal(catalog.truncated, false);

  requests.length = 0;
  const coverage = await service.coverage({ nside: 16 });
  assert.equal(coverage.status, "ready");
  assert.deepEqual(coverage.pixels, [0, 2]);
  assert.deepEqual(coverage.layers.map((layer) => ({ key: layer.key, pixels: layer.pixels, nativeOrders: layer.nativeOrders, availableOrders: layer.availableOrders, precision: layer.precision })), [
    { key: "warehouse:layer-a", pixels: [0, 2], nativeOrders: [4, 8], availableOrders: [4, 8], precision: "estimated" },
    { key: "warehouse:layer-b", pixels: [], nativeOrders: [], availableOrders: [8], precision: "exact" },
  ]);
  assert.equal(coverage.layers[0]?.maxOrder, 10);
  assert.deepEqual(coverage.inactiveLayers.map((layer) => layer.layerId), ["layer-b"]);
  assert.equal(requests.filter((request) => request.index === "ast_layer_index_v1").length, 2);
  assert.equal(requests.filter((request) => request.index === "ast_coverage_index_v1").length, 2);
  assert.deepEqual(requests[1]?.body.search_after, ["layer-a"]);
  assert.deepEqual(requests[3]?.body.search_after, ["layer-a", "file-a", 4, 2, "object_presence"]);
});

test("keeps Warehouse optional and reports endpoint failures explicitly", async () => {
  const disabled = new WarehouseIndexService({ url: "" });
  assert.equal(disabled.configured, false);
  assert.equal((await disabled.coverage({ nside: 16 })).status, "unavailable");
  assert.equal(await disabled.loadCatalog(), null);

  const failed = new WarehouseIndexService({
    url: "https://warehouse.example",
    fetchImpl: async () => esResponse({ error: "down" }, 503),
  });
  const response = await failed.coverage({ nside: 16 });
  assert.equal(response.status, "error");
  assert.match(response.message ?? "", /HTTP 503/);
});

test("an explicit empty Warehouse ownership set does not expose unrelated layers", async () => {
  const requests: string[] = [];
  const service = new WarehouseIndexService({
    url: "https://warehouse.example",
    fetchImpl: async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/ast_layer_index_v1/_search")) {
        return esResponse({ hits: { total: { value: 1 }, hits: [{ _id: "assets-public", sort: ["assets-public"], _source: {
          layer_id: "assets-public", survey_id: "public-survey", release_id: "release-1", product_id: "public-product", state: "ACTIVE", available_orders: [8],
        } }] } });
      }
      throw new Error("coverage should not be queried for an empty ownership set");
    },
  });

  const response = await service.coverage({ nside: 16, layerIds: [] });
  assert.equal(response.status, "ready");
  assert.deepEqual(response.layers, []);
  assert.equal(requests.some((url) => url.endsWith("/ast_coverage_index_v1/_search")), false);
});

test("extracts URL credentials into an Authorization header without leaking them into the endpoint", async () => {
  let requestUrl = "";
  let authorization = "";
  const service = new WarehouseIndexService({
    url: "https://user:p%40ss@warehouse.example/base",
    fetchImpl: async (input, init) => {
      requestUrl = String(input);
      authorization = String(new Headers(init?.headers).get("authorization"));
      return esResponse({ hits: { total: 0, hits: [] } });
    },
  });
  await service.loadCatalog();
  assert.equal(service.url, "https://warehouse.example/base");
  assert.doesNotMatch(requestUrl, /p%40ss|user:/);
  assert.equal(authorization, `Basic ${Buffer.from("user:p@ss", "utf8").toString("base64")}`);
});

test("does not promote a coarse Warehouse cell into a finer requested order", async () => {
  const service = new WarehouseIndexService({
    url: "https://warehouse.example",
    fetchImpl: async (input, init) => {
      const index = decodeURIComponent(/\/([^/]+)\/_search$/.exec(String(input))?.[1] ?? "");
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      if (index === "ast_layer_index_v1") {
        return esResponse({ hits: { total: 1, hits: [{ _id: "coarse", sort: ["coarse"], _source: {
          layer_id: "coarse", survey_id: "survey", release_id: "release", product_id: "product", state: "ACTIVE", available_orders: [4], max_order: 4,
        } }] } });
      }
      assert.equal(index, "ast_coverage_index_v1");
      assert.equal(body.size, 0, "an overview requests unique geometry rather than raw file edges");
      return esResponse({ hits: { total: 1, hits: [{ sort: ["coarse", "file", 4, 3, "footprint"], _source: {
        layer_id: "coarse", source_file_id: "file", healpix_order: 4, healpix_cell: 3, nesting: "NESTED", precision: "exact", coverage_role: "footprint",
      } }] } });
    },
  });

  const response = await service.coverage({ nside: 256 });
  assert.equal(response.status, "ready");
  assert.deepEqual(response.pixels, []);
  assert.deepEqual(response.layers.map((layer) => ({ pixels: layer.pixels, nativeOrders: layer.nativeOrders, availableOrders: layer.availableOrders })), [
    { pixels: [], nativeOrders: [4], availableOrders: [4] },
  ]);
});

test("coarsens a finer Warehouse cell to a requested overview order", async () => {
  const service = new WarehouseIndexService({
    url: "https://warehouse.example",
    fetchImpl: async (input) => {
      const index = decodeURIComponent(/\/([^/]+)\/_search$/.exec(String(input))?.[1] ?? "");
      if (index === "ast_layer_index_v1") return esResponse({ hits: { total: 1, hits: [{ _id: "fine", sort: ["fine"], _source: {
        layer_id: "fine", survey_id: "survey", release_id: "release", product_id: "product", state: "ACTIVE", available_orders: [8], max_order: 8,
      } }] } });
      return esResponse({ hits: { total: 1, hits: [{ sort: ["fine", "file", 8, 768, "footprint"], _source: {
        layer_id: "fine", source_file_id: "file", healpix_order: 8, healpix_cell: 768, nesting: "NESTED", precision: "exact", coverage_role: "footprint",
      } }] } });
    },
  });

  const response = await service.coverage({ nside: 16 });
  assert.equal(response.status, "ready");
  assert.deepEqual(response.pixels, [3]);
  assert.deepEqual(response.layers[0]?.nativeOrders, [8]);
});

test("overview exhausts unique projected geometry despite millions of repeated file edges", async () => {
  let pages = 0;
  const service = new WarehouseIndexService({ url: "https://warehouse.example", maxDocuments: 3, fetchImpl: async (input, init) => {
    const index = String(input).split("/").at(-2)!;
    const body = JSON.parse(String(init?.body));
    if (index === "ast_layer_index_v1") return esResponse({ hits: { total: 1, hits: [{ _source: {
      layer_id: "workspace-fixture", survey_id: "fixture", release_id: "local", product_id: "image", state: "ACTIVE", available_orders: [10],
    } }] } });
    assert.equal(body.size, 0);
    assert.deepEqual(body.query.bool.filter[0].terms.layer_id, ["workspace-fixture"]);
    assert.equal(body.aggs.geometry.composite.sources[1].pixel.terms.script.params.order, 4);
    pages++;
    if (pages === 3) return esResponse({ aggregations: { geometry: { buckets: [] } } });
    if (pages === 2) assert.deepEqual(body.aggs.geometry.composite.after, { order: 10, pixel: 637 });
    return esResponse({ aggregations: { geometry: { after_key: { order: 10, pixel: pages === 1 ? 637 : 639 }, buckets: [{
      key: { order: 10, pixel: pages === 1 ? 637 : 639 }, doc_count: 2_000_000,
      precisions: { buckets: [{ key: pages === 1 ? "estimated" : "exact" }] }, source_orders: { buckets: [{ key: 10 }] },
    }] } } });
  } });
  const result = await service.coverage({ nside: 16, layerIds: ["workspace-fixture"] });
  assert.equal(result.status, "ready"); assert.equal(pages, 3);
  assert.deepEqual(result.pixels, [637, 639]);
  assert.deepEqual(result.layers[0]!.nativeOrders, [10]);
  assert.equal(result.layers[0]!.precision, "estimated");
});
