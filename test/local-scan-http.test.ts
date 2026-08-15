import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { ASTRO_FILE_INDEX } from "../src/astro-index.js";

interface StoredDocument {
  id: string;
  index: string;
  source: Record<string, unknown>;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind a TCP port");
  return address.port;
}

async function availablePort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function bodyText(request: import("node:http").IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function termValues(value: unknown, field: string): string[] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const terms = record.terms;
  if (!terms || typeof terms !== "object" || Array.isArray(terms)) return undefined;
  const result = (terms as Record<string, unknown>)[field];
  return Array.isArray(result) && result.every((entry) => typeof entry === "string") ? result : undefined;
}

function rangeBounds(value: unknown, field: string): { gte: number; lte: number } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const range = (value as Record<string, unknown>).range;
  if (!range || typeof range !== "object" || Array.isArray(range)) return undefined;
  const bounds = (range as Record<string, unknown>)[field];
  if (!bounds || typeof bounds !== "object" || Array.isArray(bounds)) return undefined;
  const { gte, lte } = bounds as Record<string, unknown>;
  return typeof gte === "number" && typeof lte === "number" ? { gte, lte } : undefined;
}

async function waitForHealth(baseUrl: string, process: ChildProcess, logs: () => string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error(`workspace exited before health check:\n${logs()}`);
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`workspace did not become healthy:\n${logs()}`);
}

async function apiJson<T>(baseUrl: string, pathname: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${pathname} returned ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}

test("HTTP local CSV scan writes object and coverage documents and serves a multi-survey region query", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-local-http-"));
  const sourceRoot = path.join(directory, "catalogs");
  const stateRoot = path.join(directory, "state");
  const csvPath = path.join(sourceRoot, "catalog.csv");
  const documents: StoredDocument[] = [];
  const searchBodies: Record<string, unknown>[] = [];
  const coverageSearchBodies: Record<string, unknown>[] = [];
  let apiProcess: ChildProcess | undefined;
  let apiLogs = "";

  await import("node:fs/promises").then(({ mkdir }) => Promise.all([
    mkdir(sourceRoot, { recursive: true }),
    mkdir(stateRoot, { recursive: true }),
  ]));
  await writeFile(csvPath, [
    "object_id,ra,dec,flux\n",
    "euclid-1,10.25,-1.5,4.2\n",
    "euclid-2,10.75,-1.25,8.4\n",
  ].join(""), "utf8");
  const emptyBootstrap = path.join(directory, "empty.json");
  await writeFile(emptyBootstrap, "[]", "utf8");

  const esServer = createServer(async (request, response) => {
    const pathname = request.url ?? "";
    const body = await bodyText(request);
    response.setHeader("Content-Type", "application/json");
    if (request.method === "HEAD" && (pathname === "/astro_object_index_v1" || pathname === "/astro_coverage_index_v1")) {
      response.statusCode = 200;
      response.end();
      return;
    }
    if (request.method === "POST" && pathname === "/_bulk") {
      const lines = body.trim().split("\n");
      const items: unknown[] = [];
      for (let index = 0; index < lines.length; index += 2) {
        const action = JSON.parse(lines[index]!) as { index: { _index: string; _id: string } };
        const source = JSON.parse(lines[index + 1]!) as Record<string, unknown>;
        documents.push({ id: action.index._id, index: action.index._index, source });
        items.push({ index: { _index: action.index._index, _id: action.index._id, status: 201 } });
      }
      response.end(JSON.stringify({ errors: false, items }));
      return;
    }
    if (request.method === "POST" && pathname === "/astro_object_index_v1/_search") {
      const query = JSON.parse(body) as Record<string, unknown>;
      searchBodies.push(query);
      const bool = (query.query as { bool?: { filter?: unknown[] } } | undefined)?.bool;
      const filters = bool?.filter ?? [];
      const surveys = filters.flatMap((filter) => termValues(filter, "survey") ?? []);
      const dec = filters.map((filter) => rangeBounds(filter, "dec_deg")).find(Boolean);
      const hits = documents
        .filter((document) => document.index === "astro_object_index_v1")
        .filter((document) => !surveys.length || surveys.includes(String(document.source.survey)))
        .filter((document) => !dec || (Number(document.source.dec_deg) >= dec.gte && Number(document.source.dec_deg) <= dec.lte))
        .map((document) => ({
          _id: document.id,
          _source: document.source,
          sort: [document.source.ra_deg, document.source.dec_deg, document.id],
        }));
      response.end(JSON.stringify({ hits: { total: { value: hits.length, relation: "eq" }, hits } }));
      return;
    }
    if (request.method === "POST" && pathname === `/${ASTRO_FILE_INDEX}/_search`) {
      response.end(JSON.stringify({
        aggregations: {
          coverage_cells: { buckets: [] },
          by_asset: { buckets: [] },
        },
      }));
      return;
    }
    if (request.method === "POST" && pathname === "/astro_coverage_index_v1/_search") {
      const query = JSON.parse(body) as Record<string, unknown>;
      coverageSearchBodies.push(query);
      const bool = (query.query as { bool?: { filter?: unknown[] } } | undefined)?.bool;
      const filters = bool?.filter ?? [];
      const assets = filters.flatMap((filter) => termValues(filter, "asset_id") ?? []);
      if (assets.includes("es-unavailable")) {
        response.statusCode = 404;
        response.end(JSON.stringify({ error: "coverage index unavailable" }));
        return;
      }
      const hits = documents
        .filter((document) => document.index === "astro_coverage_index_v1")
        .filter((document) => !assets.length || assets.includes(String(document.source.asset_id)))
        .map((document) => ({ _id: document.id, _source: document.source }));
      response.end(JSON.stringify({ hits: { total: { value: hits.length, relation: "eq" }, hits } }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  const esPort = await listen(esServer);

  try {
    const apiPort = await availablePort();
    const baseUrl = `http://127.0.0.1:${apiPort}`;
    const environment = {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(apiPort),
      ASTRO_ALLOWED_HOSTS: "127.0.0.1,localhost",
      ASTRO_DATA_WAREHOUSE_ENABLED: "false",
      ASTRO_LOCAL_SCAN_ENABLED: "true",
      ASTRO_ES_URL: `http://127.0.0.1:${esPort}`,
      ASTRO_METADATA_STORE: "sqlite",
      ASTRO_SQLITE_PATH: path.join(stateRoot, "workspace.sqlite"),
      ASTRO_WORKSPACE_STATE: path.join(stateRoot, "registry.json"),
      ASTRO_DATA_CATALOG_BOOTSTRAP: emptyBootstrap,
      ASTRO_DATA_CATALOG_STATE: path.join(stateRoot, "data-catalog.json"),
      ASTRO_CONNECTOR_BOOTSTRAP: emptyBootstrap,
      ASTRO_CONNECTOR_STATE: path.join(stateRoot, "connectors.json"),
      ASTRO_CONNECTOR_RUN_STATE: path.join(stateRoot, "connector-runs.json"),
      ASTRO_SURVEY_REGISTRY_STATE: path.join(stateRoot, "survey-registrations.json"),
      ASTRO_MANUAL_FOOTPRINT_STATE: path.join(stateRoot, "manual-footprints.json"),
      ASTRO_RESOURCE_PACKAGE_ROOT: path.join(stateRoot, "resource-packages"),
      ASTRO_RESOURCE_PACKAGE_STATE: path.join(stateRoot, "resource-package-state.json"),
      ASTRO_RESOURCE_CATALOG_URL: pathToFileURL(path.resolve("bootstrap/resource-packages/catalog.json")).href,
      ASTRO_PUBLIC_RELEASE_DETAILS: path.resolve("bootstrap/resource-packages/release-products.json"),
      ASTRO_SURVEY_FOOTPRINT_ROOT: path.resolve("src/footprints"),
      ASTRO_LOCAL_CONNECTOR_ROOTS: sourceRoot,
      ASTRO_ALLOWED_ROOTS: sourceRoot,
      ASTRO_WORKFLOW_ROOT: path.join(stateRoot, "workflow-runs"),
      ASTRO_VOLUME_ROOT: path.join(directory, "volumes"),
      ASTRO_ATLAS_ROOT: path.join(directory, "volumes"),
      ASTRO_PROVENANCE_ROOT: path.join(directory, "volumes"),
      ASTRO_CATALOG_MCP_URL: "http://127.0.0.1:9/mcp",
      NODE_NO_WARNINGS: "1",
    };
    apiProcess = spawn(path.resolve("node_modules/.bin/tsx"), ["src/http-server.ts"], {
      cwd: process.cwd(),
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    apiProcess.stdout?.on("data", (chunk) => { apiLogs += String(chunk); });
    apiProcess.stderr?.on("data", (chunk) => { apiLogs += String(chunk); });
    await waitForHealth(baseUrl, apiProcess, () => apiLogs);

    const capabilities = await apiJson<{
      dataWarehouse: { enabled: boolean };
      localScan: { enabled: boolean; configured: boolean; executor: string; objectIndex: string; coverageIndex: string };
    }>(baseUrl, "/api/capabilities");
    assert.equal(capabilities.dataWarehouse.enabled, false);
    assert.deepEqual(capabilities.localScan, {
      enabled: true,
      configured: true,
      executor: "local-csv",
      objectIndex: "astro_object_index_v1",
      coverageIndex: "astro_coverage_index_v1",
    });

    const connectorResponse = await apiJson<{ connector: { id: string; locationKey: string } }>(baseUrl, "/api/connectors", {
      method: "POST",
      body: JSON.stringify({
        name: "Local HTTP fixture",
        kind: "local",
        config: { rootPath: sourceRoot },
        surveyId: "euclid",
        releaseId: "euclid-q1",
      }),
    });
    const connectorId = connectorResponse.connector.id;
    const connectorKey = connectorResponse.connector.locationKey;
    await apiJson(baseUrl, `/api/connectors/${encodeURIComponent(connectorId)}/check`, { method: "POST", body: "{}" });

    const assetResponse = await apiJson<{ asset: { id: string } }>(baseUrl, "/api/data-assets", {
      method: "POST",
      body: JSON.stringify({
        name: "Local HTTP catalog",
        description: "HTTP local scan fixture",
        surveyId: "euclid",
        releaseId: "euclid-q1",
        product: "COSMOS prediction catalog",
        kind: "catalog",
        modalities: ["photometry"],
        connector: "local",
        sourceUri: csvPath,
        format: "csv",
        connectorIds: [connectorId],
        connectorLocationKeys: [connectorKey],
        status: "ready",
        projectStates: ["deliverable"],
        scanSpec: {
          format: "csv",
          objectIdColumn: "object_id",
          raColumn: "ra",
          decColumn: "dec",
          coordinateFrame: "ICRS",
          coordinateUnits: "deg",
          modality: "photometry",
          product: "COSMOS prediction catalog",
        },
      }),
    });

    const submitted = await apiJson<{ run: { id: string; status: string; assetIds?: string[] } }>(
      baseUrl,
      `/api/connectors/${encodeURIComponent(connectorId)}/local-scan`,
      {
        method: "POST",
        headers: { "Idempotency-Key": "http-local-scan" },
        body: JSON.stringify({ relativePath: "catalog.csv", maxRows: 2 }),
      },
    );
    assert.equal(submitted.run.status, "queued");
    assert.deepEqual(submitted.run.assetIds, [assetResponse.asset.id]);

    let completed: { id: string; status: string; documentCount?: number; fileCount?: number; error?: string } | undefined;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const history = await apiJson<{ runs: Array<typeof completed & { id: string; status: string }> }>(
        baseUrl,
        `/api/connector-ingest-runs?connectorId=${encodeURIComponent(connectorId)}`,
      );
      completed = history.runs.find((run) => run?.id === submitted.run.id);
      if (completed?.status === "succeeded" || completed?.status === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(completed?.status, "succeeded", completed?.error);
    assert.equal(completed?.fileCount, 1);
    assert.equal(completed?.documentCount, 2);

    const objectDocuments = documents.filter((document) => document.index === "astro_object_index_v1");
    const coverageDocuments = documents.filter((document) => document.index === "astro_coverage_index_v1");
    assert.equal(objectDocuments.length, 2);
    assert.equal(coverageDocuments.length >= 1, true);
    assert.equal(objectDocuments.every((document) => document.source.survey === "euclid"), true);
    assert.equal(objectDocuments.every((document) => document.source.release === "euclid-q1"), true);
    assert.equal(coverageDocuments.every((document) => document.source.release === "euclid-q1"), true);

    const secondAssetResponse = await apiJson<{ asset: { id: string } }>(baseUrl, "/api/data-assets", {
      method: "POST",
      body: JSON.stringify({
        name: "Second Local HTTP catalog",
        description: "Second asset for ownership isolation",
        surveyId: "euclid",
        releaseId: "euclid-q1",
        product: "COSMOS prediction catalog",
        kind: "catalog",
        modalities: ["photometry"],
        connector: "local",
        sourceUri: csvPath,
        format: "csv",
        connectorIds: [connectorId],
        connectorLocationKeys: [connectorKey],
        status: "ready",
        projectStates: ["deliverable"],
        scanSpec: {
          format: "csv",
          objectIdColumn: "object_id",
          raColumn: "ra",
          decColumn: "dec",
          coordinateFrame: "ICRS",
          coordinateUnits: "deg",
          modality: "photometry",
          product: "COSMOS prediction catalog",
        },
      }),
    });
    documents.push(
      {
        id: "second-coverage-one",
        index: "astro_coverage_index_v1",
        source: {
          healpix_order: 8,
          healpix_pixel: 256,
          objectCount: 7,
          survey: "euclid",
          release: "euclid-q1",
          product: "COSMOS prediction catalog",
          modality: "photometry",
          asset_id: secondAssetResponse.asset.id,
        },
      },
      {
        id: "second-coverage-two",
        index: "astro_coverage_index_v1",
        source: {
          healpix_order: 8,
          healpix_pixel: 512,
          objectCount: 2,
          survey: "euclid",
          release: "euclid-q1",
          product: "COSMOS prediction catalog",
          modality: "photometry",
          asset_id: secondAssetResponse.asset.id,
        },
      },
    );
    const coverage = await apiJson<{
      status: string;
      layers: Array<{ key: string; assetId?: string; assetIds: string[]; pixels: number[]; objectCount?: number }>;
    }>(baseUrl, `/api/sky/coverage?assetIds=${encodeURIComponent(`${assetResponse.asset.id},${secondAssetResponse.asset.id}`)}`);
    assert.equal(coverage.status, "ready");
    assert.equal(coverage.layers.length, 2);
    const firstLayer = coverage.layers.find((layer) => layer.assetId === assetResponse.asset.id);
    const secondLayer = coverage.layers.find((layer) => layer.assetId === secondAssetResponse.asset.id);
    assert.ok(firstLayer);
    assert.ok(secondLayer);
    assert.equal(firstLayer.key, `asset:${assetResponse.asset.id}`);
    assert.equal(secondLayer.key, `asset:${secondAssetResponse.asset.id}`);
    assert.deepEqual(secondLayer.pixels, [1, 2]);
    assert.equal(secondLayer.objectCount, 9);
    assert.deepEqual(firstLayer.pixels, [...new Set(coverageDocuments.map((document) => Math.floor(Number(document.source.healpix_pixel) / 256)))].sort((left, right) => left - right));
    assert.equal(firstLayer.objectCount, coverageDocuments.reduce((sum, document) => sum + Number(document.source.objectCount), 0));
    assert.equal(coverageSearchBodies.length, 2);

    const density = await apiJson<{
      status: string;
      parentNside: number;
      targetNside: number;
      nativeNside: number;
      evidence: string;
      total: number;
      cells: Array<{ pixel: number; count: number; layers: Array<{ assetId: string; count: number }> }>;
      layers: Array<{ assetId: string; count: number }>;
    }>(baseUrl, "/api/sky/cells/query", {
      method: "POST",
      body: JSON.stringify({
        parentNside: 16,
        parentPixels: [1, 2],
        targetNside: 16,
        coordinateFrame: "ICRS",
        ordering: "NESTED",
        assetIds: [secondAssetResponse.asset.id],
        surveyIds: ["euclid"],
        releaseIds: ["euclid-q1"],
        products: ["COSMOS prediction catalog"],
        modalities: ["photometry"],
      }),
    });
    assert.equal(density.status, "ready");
    assert.equal(density.parentNside, 16);
    assert.equal(density.targetNside, 16);
    assert.equal(density.nativeNside, 256);
    assert.equal(density.evidence, "coverage_facts");
    assert.equal(density.total, 9);
    assert.deepEqual(density.cells.map((cell) => [cell.pixel, cell.count]), [[1, 7], [2, 2]]);
    assert.deepEqual(density.layers.map((layer) => [layer.assetId, layer.count]), [[secondAssetResponse.asset.id, 9]]);
    const densityFilters = (((coverageSearchBodies.at(-1)?.query as Record<string, unknown>).bool as Record<string, unknown>).filter ?? []) as unknown[];
    const nativePixels = (densityFilters[0] as { terms?: { healpix_pixel?: number[] } }).terms?.healpix_pixel ?? [];
    assert.deepEqual(nativePixels, Array.from({ length: 512 }, (_, index) => index + 256));

    const validationResponse = await fetch(`${baseUrl}/api/sky/cells/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        parentNside: 16,
        parentPixels: [1],
        targetNside: 16,
        coordinateFrame: "GALACTIC",
        ordering: "NESTED",
      }),
    });
    assert.equal(validationResponse.status, 400);
    assert.match(await validationResponse.text(), /coordinateFrame.*ICRS/);

    const unavailable = await apiJson<{ status: string; nativeNside: number; total: number }>(baseUrl, "/api/sky/cells/query", {
      method: "POST",
      body: JSON.stringify({
        parentNside: 16,
        parentPixels: [1],
        targetNside: 16,
        coordinateFrame: "ICRS",
        ordering: "NESTED",
        assetIds: ["es-unavailable"],
      }),
    });
    assert.equal(unavailable.status, "unavailable");
    assert.equal(unavailable.nativeNside, 256);
    assert.equal(unavailable.total, 0);

    documents.push({
      id: "sdss-seed",
      index: "astro_object_index_v1",
      source: {
        object_id: "sdss-1",
        ra_deg: 10.5,
        dec_deg: -1.4,
        survey: "sdss",
        release: "sdss-dr09",
        product: "DR9 catalog",
        modality: "photometry",
        asset_id: "sdss-asset",
        attributes: {},
      },
    });
    const queried = await apiJson<{
      status: string;
      total: number;
      objects: Array<{ survey: string; object_id: string }>;
    }>(baseUrl, "/api/sky/objects/query", {
      method: "POST",
      body: JSON.stringify({
        bbox: { raMin: 10, raMax: 11, decMin: -2, decMax: -1 },
        surveys: ["euclid", "sdss"],
        limit: 20,
      }),
    });
    assert.equal(queried.status, "ready");
    assert.equal(queried.total, 3);
    assert.deepEqual(new Set(queried.objects.map((object) => object.survey)), new Set(["euclid", "sdss"]));
    assert.equal(searchBodies.length, 1);
    const searchFilters = ((searchBodies[0]?.query as { bool?: { filter?: unknown[] } })?.bool?.filter ?? []);
    assert.deepEqual(searchFilters.flatMap((filter) => termValues(filter, "survey") ?? []), ["euclid", "sdss"]);
  } finally {
    if (apiProcess && apiProcess.exitCode === null) {
      apiProcess.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5_000);
        apiProcess!.once("exit", () => { clearTimeout(timer); resolve(); });
      });
    }
    await new Promise<void>((resolve) => esServer.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
