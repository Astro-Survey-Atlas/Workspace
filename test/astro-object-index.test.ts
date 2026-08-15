import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import test from "node:test";

import {
  ASTRO_COVERAGE_INDEX,
  ASTRO_OBJECT_INDEX,
  ASTRO_OBJECT_NATIVE_NSIDE,
  AstroObjectIndexService,
  nestedDescendantPixels,
  nestedDescendantRange,
  nestedDescendantRanges,
  normalizeNestedRanges,
  type ObjectRegionQueryInput,
} from "../src/astro-object-index.js";
import type { LocalScanDocument } from "../src/local-scan.js";

async function requestBody(request: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) body += chunk;
  return body;
}

async function withServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
  callback: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function objectDocument(id: string, survey = "survey-a"): LocalScanDocument {
  return {
    _index: ASTRO_OBJECT_INDEX,
    _id: `object-${id}`,
    object_id: id,
    ra_deg: 12.5,
    dec_deg: -3.25,
    sky_position: { lat: -3.25, lon: 12.5 },
    healpix_order: 8,
    healpix_pixel: 123,
    survey,
    release: "release-1",
    product: "catalog",
    modality: "optical",
    asset_id: `asset-${survey}`,
    source_file_id: "file-1",
    scan_run_id: "run-1",
    attributes: { flux: "4.2", label: "source" },
  };
}

function coverageDocument(): LocalScanDocument {
  return {
    _index: ASTRO_COVERAGE_INDEX,
    _id: "coverage-1",
    healpix_order: 8,
    healpix_pixel: 123,
    objectCount: 1,
    survey: "survey-a",
    release: "release-1",
    product: "catalog",
    modality: "optical",
    asset_id: "asset-survey-a",
    source_file_id: "file-1",
    scan_run_id: "run-1",
  };
}

function validQuery(overrides: Partial<ObjectRegionQueryInput> = {}): ObjectRegionQueryInput {
  return {
    bbox: { raMin: 10, raMax: 20, decMin: -10, decMax: 10 },
    ...overrides,
  };
}

test("normalizes NESTED descendant ranges without changing selected cells", () => {
  assert.deepEqual(nestedDescendantRange(16, 2), { gte: 512, lte: 767 });
  assert.deepEqual(nestedDescendantRanges(16, [3, 2, 5]), [
    { gte: 512, lte: 1023 },
    { gte: 1280, lte: 1535 },
  ]);
  assert.deepEqual(normalizeNestedRanges([
    { gte: 20, lte: 30 },
    { gte: 10, lte: 12 },
    { gte: 13, lte: 19 },
    { gte: 29, lte: 40 },
  ]), [{ gte: 10, lte: 40 }]);
  assert.deepEqual(nestedDescendantPixels(16, [2], 32), [8, 9, 10, 11]);
  assert.equal(ASTRO_OBJECT_NATIVE_NSIDE, 256);
});

test("bulk sends object and coverage documents as action/source NDJSON", async () => {
  const requests: Array<{ url: string; contentType: string; lines: unknown[] }> = [];
  await withServer(async (request, response) => {
    const body = await requestBody(request);
    requests.push({
      url: request.url ?? "",
      contentType: String(request.headers["content-type"] ?? ""),
      lines: body.trimEnd().split("\n").map((line) => JSON.parse(line)),
    });
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({
      errors: false,
      items: [{ index: { status: 201 } }, { index: { status: 201 } }],
    }));
  }, async (baseUrl) => {
    const service = new AstroObjectIndexService({ baseUrl });
    const result = await service.bulk([objectDocument("one"), coverageDocument()]);
    assert.deepEqual(result, { objectCount: 1, coverageCount: 1 });
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, "/_bulk");
  assert.match(requests[0]?.contentType ?? "", /^application\/x-ndjson/);
  const lines = requests[0]?.lines ?? [];
  assert.deepEqual(lines[0], { index: { _index: ASTRO_OBJECT_INDEX, _id: "object-one" } });
  assert.deepEqual(lines[2], { index: { _index: ASTRO_COVERAGE_INDEX, _id: "coverage-1" } });
  assert.ok(lines[1] && typeof lines[1] === "object");
  assert.ok(lines[3] && typeof lines[3] === "object");
  assert.equal("_index" in (lines[1] as Record<string, unknown>), false);
  assert.equal("_id" in (lines[1] as Record<string, unknown>), false);
  assert.equal("_index" in (lines[3] as Record<string, unknown>), false);
  assert.equal("_id" in (lines[3] as Record<string, unknown>), false);
  assert.equal((lines[1] as Record<string, unknown>).object_id, "one");
  assert.equal((lines[3] as Record<string, unknown>).objectCount, 1);
});

test("ensureIndices creates strict object and coverage mappings when absent", async () => {
  const created: Array<{ url: string; body: Record<string, unknown> }> = [];
  await withServer(async (request, response) => {
    if (request.method === "HEAD") {
      response.statusCode = 404;
      response.end();
      return;
    }
    assert.equal(request.method, "PUT");
    created.push({ url: request.url ?? "", body: JSON.parse(await requestBody(request)) as Record<string, unknown> });
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ acknowledged: true }));
  }, async (baseUrl) => {
    await new AstroObjectIndexService({ baseUrl }).ensureIndices();
  });
  assert.deepEqual(created.map((request) => request.url), [`/${ASTRO_OBJECT_INDEX}`, `/${ASTRO_COVERAGE_INDEX}`]);
  const objectMappings = created[0]?.body.mappings as { dynamic?: unknown; properties?: Record<string, { type?: string }> };
  assert.equal(objectMappings.dynamic, "strict");
  assert.equal(objectMappings.properties?.sky_position?.type, "geo_point");
  assert.equal(objectMappings.properties?.attributes?.type, "flattened");
  const coverageMappings = created[1]?.body.mappings as { properties?: Record<string, { type?: string }> };
  assert.equal(coverageMappings.properties?.healpix_pixel?.type, "integer");
});

test("query builds a wrapped bbox with deduplicated multi-survey filters and search_after", async () => {
  let queryBody: Record<string, unknown> | undefined;
  await withServer(async (request, response) => {
    assert.equal(request.url, `/${encodeURIComponent(ASTRO_OBJECT_INDEX)}/_search`);
    queryBody = JSON.parse(await requestBody(request)) as Record<string, unknown>;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({
      hits: {
        total: { value: 2, relation: "eq" },
        hits: [
          {
            _id: "object-one",
            _source: { ...objectDocument("one", "survey-a"), _index: "ignored", _id: "ignored" },
            sort: [359, -3.25, "object-one"],
          },
          {
            _id: "object-two",
            _source: { ...objectDocument("two", "survey-b"), _index: "ignored", _id: "ignored" },
            sort: [3, -2, "object-two"],
          },
        ],
      },
    }));
  }, async (baseUrl) => {
    const service = new AstroObjectIndexService({ baseUrl });
    const result = await service.queryObjects({
      bbox: { raMin: 350, raMax: 10, decMin: -5, decMax: 5 },
      surveys: [" survey-a ", "survey-a", "survey-b"],
      releases: ["release-1"],
      products: ["catalog"],
      assetIds: ["asset-survey-a", "asset-survey-b"],
      limit: 25,
      searchAfter: [350, -5, "previous-id"],
    });

    assert.equal(result.status, "ready");
    assert.equal(result.index, ASTRO_OBJECT_INDEX);
    assert.equal(result.total, 2);
    assert.equal(result.limit, 25);
    assert.deepEqual(result.searchAfter, [3, -2, "object-two"]);
    assert.deepEqual(result.objects.map((object) => object.survey), ["survey-a", "survey-b"]);
    assert.equal(result.objects[0]?.id, "object-one");
    assert.deepEqual(result.objects[0]?.attributes, { flux: "4.2", label: "source" });
    assert.equal("_index" in (result.objects[0] ?? {}), false);
  });

  assert.deepEqual(queryBody?.sort, [{ ra_deg: "asc" }, { dec_deg: "asc" }, { _id: "asc" }]);
  assert.deepEqual(queryBody?.search_after, [350, -5, "previous-id"]);
  assert.equal(queryBody?.size, 25);
  assert.deepEqual(queryBody?._source, [
    "object_id",
    "ra_deg",
    "dec_deg",
    "sky_position",
    "healpix_order",
    "healpix_pixel",
    "survey",
    "release",
    "product",
    "modality",
    "asset_id",
    "source_file_id",
    "scan_run_id",
    "attributes",
  ]);
  const filters = ((queryBody?.query as Record<string, unknown>).bool as Record<string, unknown>).filter as unknown[];
  assert.deepEqual(filters[0], {
    bool: {
      should: [
        { range: { ra_deg: { gte: 350, lte: 360 } } },
        { range: { ra_deg: { gte: 0, lte: 10 } } },
      ],
      minimum_should_match: 1,
    },
  });
  assert.deepEqual(filters[1], { range: { dec_deg: { gte: -5, lte: 5 } } });
  assert.deepEqual(filters[2], { terms: { release: ["release-1"] } });
  assert.deepEqual(filters[3], { terms: { product: ["catalog"] } });
  assert.deepEqual(filters[4], {
    bool: {
      should: [
        { terms: { survey: ["survey-a", "survey-b"] } },
        { terms: { asset_id: ["asset-survey-a", "asset-survey-b"] } },
      ],
      minimum_should_match: 1,
    },
  });
});

test("query accepts an ICRS NESTED region and uses exact native descendants with mapped cursor sort", async () => {
  let queryBody: Record<string, unknown> | undefined;
  await withServer(async (request, response) => {
    queryBody = JSON.parse(await requestBody(request)) as Record<string, unknown>;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({
      hits: {
        total: { value: 1, relation: "eq" },
        hits: [{
          _id: "object-region",
          _source: objectDocument("region"),
          sort: [512, 12.5, -3.25, "asset-survey-a", "file-1", "region"],
        }],
      },
    }));
  }, async (baseUrl) => {
    const result = await new AstroObjectIndexService({ baseUrl }).queryObjects({
      region: { nside: 16, pixels: [3, 2], coordinateFrame: "ICRS", ordering: "NESTED" },
      surveyIds: ["survey-a"],
      releaseIds: ["release-1"],
      products: ["catalog"],
      modalities: ["optical"],
      assetIds: ["asset-survey-a"],
      limit: 1,
      cursor: [511, 12, -4, "asset-before", "file-before", "object-before"],
    });
    assert.equal(result.status, "ready");
    assert.equal(result.total, 1);
    assert.deepEqual(result.searchAfter, [512, 12.5, -3.25, "asset-survey-a", "file-1", "region"]);
    assert.deepEqual(result.nextCursor, result.searchAfter);
  });

  const filters = ((queryBody?.query as Record<string, unknown>).bool as Record<string, unknown>).filter as unknown[];
  assert.deepEqual(filters[0], { terms: { healpix_pixel: Array.from({ length: 512 }, (_, index) => index + 512) } });
  assert.deepEqual(filters[1], { term: { healpix_order: 8 } });
  assert.deepEqual(filters[2], { terms: { release: ["release-1"] } });
  assert.deepEqual(filters[3], { terms: { product: ["catalog"] } });
  assert.deepEqual(filters[4], { terms: { modality: ["optical"] } });
  assert.deepEqual(filters[5], {
    bool: {
      should: [
        { terms: { survey: ["survey-a"] } },
        { terms: { asset_id: ["asset-survey-a"] } },
      ],
      minimum_should_match: 1,
    },
  });
  assert.deepEqual(queryBody?.search_after, [511, 12, -4, "asset-before", "file-before", "object-before"]);
  assert.equal((queryBody?.sort as Array<Record<string, unknown>>).some((entry) => "_id" in entry), false);
});

test("large NESTED regions use exact mapped ranges and validate coordinate metadata", async () => {
  let queryBody: Record<string, unknown> | undefined;
  await withServer(async (request, response) => {
    queryBody = JSON.parse(await requestBody(request)) as Record<string, unknown>;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ hits: { total: { value: 0 }, hits: [] } }));
  }, async (baseUrl) => {
    const result = await new AstroObjectIndexService({ baseUrl }).queryObjects({
      parentNside: 1,
      parentPixels: [0],
      coordinateFrame: "ICRS",
      ordering: "NESTED",
      limit: 1,
    });
    assert.equal(result.status, "ready");
  });
  const filters = ((queryBody?.query as Record<string, unknown>).bool as Record<string, unknown>).filter as unknown[];
  assert.deepEqual(filters[0], { range: { healpix_pixel: { gte: 0, lte: 65_535 } } });
  await assert.rejects(() => new AstroObjectIndexService({ baseUrl: "http://127.0.0.1:1" }).queryObjects({
    region: { nside: 16, pixels: [2], coordinateFrame: "GALACTIC", ordering: "NESTED" },
  }), /coordinateFrame.*ICRS/);
});

test("queryCells returns every target cell and aggregates coverage facts by layer", async () => {
  let queryBody: Record<string, unknown> | undefined;
  await withServer(async (request, response) => {
    queryBody = JSON.parse(await requestBody(request)) as Record<string, unknown>;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({
      aggregations: {
        by_native_pixel_layer: {
          buckets: [
            {
              key: { healpix_pixel: 256, asset_id: "asset-a", survey: "survey-a", release: "release-1", product: "catalog", modality: "optical" },
              doc_count: 1,
              object_count: { value: 7 },
            },
            {
              key: { healpix_pixel: 512, asset_id: "asset-a", survey: "survey-a", release: "release-1", product: "catalog", modality: "optical" },
              doc_count: 2,
              object_count: { value: 2 },
            },
            {
              key: { healpix_pixel: 512, asset_id: "asset-b", survey: "survey-b", release: "release-2", product: "spectra", modality: "spectroscopy" },
              doc_count: 1,
              object_count: { value: 4 },
            },
          ],
        },
      },
    }));
  }, async (baseUrl) => {
    const result = await new AstroObjectIndexService({ baseUrl }).queryCells({
      parentNside: 16,
      parentPixels: [1, 2],
      targetNside: 16,
      coordinateFrame: "ICRS",
      ordering: "NESTED",
      assetIds: ["asset-a", "asset-b"],
      surveyIds: ["survey-a", "survey-b"],
      releaseIds: ["release-1", "release-2"],
      products: ["catalog", "spectra"],
      modalities: ["optical", "spectroscopy"],
    });
    assert.equal(result.status, "ready");
    assert.equal(result.nativeNside, 256);
    assert.equal(result.evidence, "coverage_facts");
    assert.equal(result.total, 13);
    assert.deepEqual(result.cells.map((cell) => ({ pixel: cell.pixel, count: cell.count, layers: cell.layers.map((layer) => [layer.assetId, layer.count]) })), [
      { pixel: 1, count: 7, layers: [["asset-a", 7]] },
      { pixel: 2, count: 6, layers: [["asset-a", 2], ["asset-b", 4]] },
    ]);
    assert.deepEqual(result.layers.map((layer) => [layer.assetId, layer.count]), [["asset-a", 9], ["asset-b", 4]]);
  });

  assert.equal(queryBody?.size, 0);
  const filters = ((queryBody?.query as Record<string, unknown>).bool as Record<string, unknown>).filter as unknown[];
  assert.deepEqual(filters[0], { terms: { healpix_pixel: Array.from({ length: 512 }, (_, index) => index + 256) } });
  assert.deepEqual(filters[1], { term: { healpix_order: 8 } });
  assert.deepEqual(filters[2], { terms: { release: ["release-1", "release-2"] } });
  assert.deepEqual(filters[3], { terms: { product: ["catalog", "spectra"] } });
  assert.deepEqual(filters[4], { terms: { modality: ["optical", "spectroscopy"] } });
  assert.deepEqual(filters[5], {
    bool: {
      should: [
        { terms: { survey: ["survey-a", "survey-b"] } },
        { terms: { asset_id: ["asset-a", "asset-b"] } },
      ],
      minimum_should_match: 1,
    },
  });
});

test("queryCells validates ICRS/NESTED and reports an unavailable ES index", async () => {
  const input = {
    parentNside: 16,
    parentPixels: [2],
    targetNside: 32,
    coordinateFrame: "ICRS",
    ordering: "NESTED",
  } as const;
  const unavailable = await new AstroObjectIndexService({ baseUrl: "" }).queryCells(input);
  assert.equal(unavailable.status, "unavailable");
  assert.equal(unavailable.nativeNside, 256);
  assert.equal(unavailable.total, 0);
  assert.deepEqual(unavailable.cells, Array.from({ length: 4 }, (_, index) => ({ nside: 32, pixel: 8 + index, count: 0, layers: [] })));
  await assert.rejects(() => new AstroObjectIndexService({ baseUrl: "http://127.0.0.1:1" }).queryCells({
    ...input,
    ordering: "RING",
  }), /ordering.*NESTED/);
});

test("query rejects invalid bbox, limits, filters, and search_after before HTTP", async () => {
  const service = new AstroObjectIndexService({ baseUrl: "http://127.0.0.1:1" });
  await assert.rejects(() => service.queryObjects(validQuery({ bbox: { raMin: Number.NaN, raMax: 20, decMin: -1, decMax: 1 } })), /raMin/);
  await assert.rejects(() => service.queryObjects(validQuery({ bbox: { raMin: 1, raMax: 2, decMin: 2, decMax: 1 } })), /decMin/);
  await assert.rejects(() => service.queryObjects(validQuery({ limit: 0 })), /limit/);
  await assert.rejects(() => service.queryObjects(validQuery({ limit: 10_001 })), /limit/);
  await assert.rejects(() => service.queryObjects(validQuery({ surveys: ["ok", 4 as unknown as string] })), /surveys/);
  await assert.rejects(() => service.queryObjects(validQuery({ searchAfter: Array.from({ length: 101 }, (_, index) => index) })), /searchAfter/);
});

test("queryCoverageFacts filters, downsamples, merges, and sorts coverage facts", async () => {
  let queryBody: Record<string, unknown> | undefined;
  await withServer(async (request, response) => {
    assert.equal(request.url, `/${encodeURIComponent(ASTRO_COVERAGE_INDEX)}/_search`);
    queryBody = JSON.parse(await requestBody(request)) as Record<string, unknown>;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({
      hits: {
        total: { value: 4, relation: "eq" },
        hits: [
          {
            _source: {
              healpix_order: 8, healpix_pixel: 256, objectCount: 2,
              survey: "survey-a", release: "release-1", product: "catalog", modality: "optical", asset_id: "asset-a",
            },
          },
          {
            _source: {
              healpix_order: 8, healpix_pixel: 256, objectCount: 3,
              survey: "survey-a", release: "release-1", product: "catalog", modality: "optical", asset_id: "asset-a",
            },
          },
          {
            _source: {
              healpix_order: 8, healpix_pixel: 512, objectCount: 1,
              survey: "survey-a", release: "release-1", product: "catalog", modality: "optical", asset_id: "asset-a",
            },
          },
          {
            _source: {
              healpix_order: 8, healpix_pixel: 768, objectCount: 4,
              survey: "survey-a", release: "release-1", product: "catalog", modality: "optical", asset_id: "asset-b",
            },
          },
        ],
      },
    }));
  }, async (baseUrl) => {
    const result = await new AstroObjectIndexService({ baseUrl }).queryCoverageFacts({
      nside: 16,
      surveys: [" survey-a ", "survey-a"],
      releases: ["release-1"],
      products: ["catalog"],
      assetIds: ["asset-a", "asset-b"],
    });

    assert.equal(result.status, "ready");
    assert.equal(result.nside, 16);
    assert.deepEqual(result.pixels, [1, 2, 3]);
    assert.deepEqual(result.facts.map((fact) => ({ asset: fact.asset_id, pixel: fact.healpix_pixel, count: fact.objectCount })), [
      { asset: "asset-a", pixel: 1, count: 5 },
      { asset: "asset-a", pixel: 2, count: 1 },
      { asset: "asset-b", pixel: 3, count: 4 },
    ]);
    assert.equal(result.facts.every((fact) => fact.healpix_order === 4), true);
  });

  assert.equal(queryBody?.track_total_hits, true);
  assert.equal(queryBody?.size, 10_000);
  assert.deepEqual(queryBody?._source, [
    "healpix_order", "healpix_pixel", "objectCount", "survey", "release", "product", "modality", "asset_id", "source_file_id", "scan_run_id",
  ]);
  assert.deepEqual(queryBody?.sort, [
    { healpix_pixel: "asc" }, { asset_id: "asc" }, { release: "asc" }, { product: "asc" },
  ]);
  const filters = ((queryBody?.query as Record<string, unknown>).bool as Record<string, unknown>).filter as unknown[];
  assert.deepEqual(filters, [
    { terms: { release: ["release-1"] } },
    { terms: { product: ["catalog"] } },
    {
      bool: {
        should: [
          { terms: { survey: ["survey-a"] } },
          { terms: { asset_id: ["asset-a", "asset-b"] } },
        ],
        minimum_should_match: 1,
      },
    },
  ]);
});

test("unconfigured coverage facts report unavailable", async () => {
  const result = await new AstroObjectIndexService({ baseUrl: "" }).queryCoverageFacts({ nside: 16 });
  assert.equal(result.status, "unavailable");
  assert.equal(result.index, ASTRO_COVERAGE_INDEX);
  assert.deepEqual(result.facts, []);
  assert.deepEqual(result.pixels, []);
  assert.match(result.message ?? "", /ASTRO_ES_URL/);
  await assert.rejects(() => new AstroObjectIndexService({ baseUrl: "http://127.0.0.1:1" }).queryCoverageFacts({ nside: 3 }), /power of two/);
});

test("bulk rejects Elasticsearch item errors", async () => {
  await withServer(async (request, response) => {
    await requestBody(request);
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({
      errors: true,
      items: [{ index: { status: 400, error: { type: "mapper_parsing_exception", reason: "bad field" } } }],
    }));
  }, async (baseUrl) => {
    const service = new AstroObjectIndexService({ baseUrl });
    await assert.rejects(() => service.bulk([objectDocument("bad")]), /bad field/);
  });
});

test("unconfigured service reports query unavailable and bulk configuration error", async () => {
  const service = new AstroObjectIndexService({ baseUrl: "" });
  const result = await service.queryObjects(validQuery());
  assert.equal(result.status, "unavailable");
  assert.equal(result.index, ASTRO_OBJECT_INDEX);
  assert.equal(result.objects.length, 0);
  assert.match(result.message ?? "", /ASTRO_ES_URL/);
  await assert.rejects(() => service.bulk([]), /ASTRO_ES_URL/);
});
