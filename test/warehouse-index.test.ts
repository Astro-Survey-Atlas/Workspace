import assert from "node:assert/strict";
import test from "node:test";

import { WarehouseIndexService } from "../src/warehouse-index.js";

function esResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

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
      assert.equal(body.size, 10_000);
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
