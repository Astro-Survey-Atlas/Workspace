import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { AstroIndexService, nestedChildPixels } from "../src/astro-index.js";

test("nested HEALPix parent expands to fixed order-8 children", () => {
  const children = nestedChildPixels(16, 2);
  assert.equal(children.length, 256);
  assert.equal(children[0], 512);
  assert.equal(children.at(-1), 767);
});

test("astro index reports an unavailable spatial index without fabricating coverage", async () => {
  const service = new AstroIndexService({ baseUrl: "", cacheTtlMs: 1 });
  const result = await service.overview({ survey: "Euclid", release: "Q1", nside: 16, cells: [639, 725] });
  assert.equal(result.status, "unavailable");
  assert.equal(result.total.matchedFiles, 0);
  assert.equal(result.cells.length, 2);
  assert.ok(result.cells.every((cell) => cell.status === "unavailable"));
});

test("astro query rejects empty regions", async () => {
  const service = new AstroIndexService({ baseUrl: "" });
  await assert.rejects(
    service.query({ cells: [], nside: 16 }),
    /at least one HEALPix cell/,
  );
});

test("astro overview parses ES aggregates and preserves parent-cell counts", async () => {
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const query = JSON.parse(body) as { query: { bool: { filter: Array<{ terms?: { coverage_cells?: number[] } }> } } };
    const terms = query.query.bool.filter[0]?.terms?.coverage_cells ?? [];
    assert.equal(terms.length, 256);
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({
      hits: { total: { value: 2 } },
      aggregations: {
        total_bytes: { value: 1024 },
        spatial_status: { buckets: [{ key: "known", doc_count: 2 }] },
        by_asset: { buckets: [{ key: "euclid-q1-mer-final", doc_count: 2, bytes: { value: 1024 } }] },
        by_survey_release_modality: { buckets: [{ key: "Euclid|Q1|imaging", doc_count: 2, bytes: { value: 1024 } }] },
        cells: { buckets: { p2: { doc_count: 2, bytes: { value: 1024 }, spatial_status: { buckets: [{ key: "known", doc_count: 2 }] } } } },
      },
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const service = new AstroIndexService({ baseUrl: `http://127.0.0.1:${address.port}`, cacheTtlMs: 1_000 });
  const result = await service.overview({ survey: "Euclid", release: "Q1", nside: 16, cells: [2] });
  assert.equal(result.status, "ready");
  assert.equal(result.total.matchedFiles, 2);
  assert.equal(result.total.totalBytes, 1024);
  assert.equal(result.cells[0]?.matchedFiles, 2);
  assert.equal(result.cells[0]?.byAsset.length, 0);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("generic asset coverage compacts scanner cells into the project sky order", async () => {
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const query = JSON.parse(body) as {
      aggs?: { coverage_cells?: unknown };
      query?: { bool?: { filter?: Array<{ term?: { spatial_status?: string }; terms?: { asset_id?: string[] } }> } };
    };
    assert.ok(query.aggs?.coverage_cells);
    assert.deepEqual(query.query?.bool?.filter?.[0], { term: { spatial_status: "known" } });
    assert.deepEqual(query.query?.bool?.filter?.[1], { terms: { asset_id: ["custom-catalog"] } });
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({
      aggregations: {
        coverage_cells: { buckets: [{ key: 512, doc_count: 1 }, { key: 767, doc_count: 1 }, { key: 768, doc_count: 1 }] },
        by_asset: { buckets: [{ key: "custom-catalog", doc_count: 3, bytes: { value: 12 } }] },
      },
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const service = new AstroIndexService({ baseUrl: `http://127.0.0.1:${address.port}` });
  const result = await service.coverage({ nside: 16, assetIds: ["custom-catalog"] });
  assert.equal(result.status, "ready");
  assert.deepEqual(result.pixels, [2, 3]);
  assert.equal(result.byAsset[0]?.key, "custom-catalog");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("astro index extracts URL credentials before querying external Elasticsearch", async () => {
  let authorization = "";
  let requestUrl = "";
  const server = createServer(async (request, response) => {
    requestUrl = request.url ?? "";
    authorization = request.headers.authorization ?? "";
    let body = "";
    for await (const chunk of request) body += chunk;
    assert.ok(body);
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ aggregations: { coverage_cells: { buckets: [] }, by_asset: { buckets: [] } } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const service = new AstroIndexService({ baseUrl: `http://atlas-user:p%40ss@127.0.0.1:${address.port}` });
  await service.coverage({ nside: 16 });
  assert.equal(requestUrl, "/astro_file_index_v1/_search");
  assert.equal(authorization, `Basic ${Buffer.from("atlas-user:p@ss", "utf8").toString("base64")}`);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});
