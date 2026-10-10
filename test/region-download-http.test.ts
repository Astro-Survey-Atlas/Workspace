import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server } from "node:http";
import test from "node:test";
import express from "express";
import { createRegionDownloadPreviewHandler } from "../src/region-download-http.js";
import { RegionDownloadPlanService } from "../src/region-download-plan.js";
import { readJsonResponse } from "../src/json-response-stream.js";

const selection = { layerIds: ["euclid-layer"], order: 8, cells: [1] };

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not listen");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function previewService(delay: number, fileCount = 2) {
  let started = 0, aborted = 0, slowFinished = false;
  const service = new RegionDownloadPlanService({
    client: { lookup: async (input) => ({
      available: true, precision: "exact", truncated: false, requested: input,
      nativeUnitIndexRevision: "synthetic-index", notes: [], files: [],
      querySnapshot: { id: "synthetic-snapshot", expiresAt: "2099-01-01T00:00:00.000Z", queryExhausted: true, inventoryComplete: false },
      spatialUnits: [{ layerId: "euclid-layer", productId: "euclid-q1-vis", surveyId: "euclid", releaseId: "euclid-q1", product: "VIS",
        unitKind: "tile", unitId: "synthetic-tile", order: 8, nside: 256, matchingCells: [1], precision: "exact",
        accessUris: Array.from({ length: fileCount }, (_, index) => ({ uri: `https://example.test/${index}.fits` })) }],
    }) },
    sourceResolveOptions: { fetchImpl: async (input, init) => {
      started++;
      if (String(input).endsWith("0.fits")) return new Response(null, { headers: { "content-type": "application/fits", "content-length": "100" } });
      return new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => { slowFinished = true; resolve(new Response(null, { headers: { "content-type": "application/fits", "content-length": "100" } })); }, delay);
        init?.signal?.addEventListener("abort", () => { clearTimeout(timer); aborted++; reject(init.signal?.reason); }, { once: true });
      });
    } },
  });
  const app = express();
  app.use(express.json());
  app.post("/preview", createRegionDownloadPreviewHandler(service, (response, error) => {
    response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }, { heartbeatMs: 15 }));
  return { server: createServer(app), counts: () => ({ started, aborted, slowFinished }) };
}

test("streamed preview survives an idle proxy timeout and exposes files before slow metadata finishes", async () => {
  const fixture = previewService(180);
  const backend = await listen(fixture.server);
  const proxy = createServer((request, response) => {
    const upstream = httpRequest(`${backend}/preview`, { method: request.method, headers: request.headers }, (result) => {
      response.writeHead(result.statusCode ?? 502, result.headers);
      result.pipe(response);
    });
    upstream.setTimeout(60, () => { if (!response.headersSent) response.writeHead(504); response.end(); upstream.destroy(); });
    upstream.on("error", () => { if (!response.writableEnded) { if (!response.headersSent) response.writeHead(502); response.end(); } });
    request.pipe(upstream);
  });
  const address = await listen(proxy);
  try {
    const response = await fetch(`${address}/preview`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "text/event-stream" }, body: JSON.stringify(selection) });
    assert.equal(response.status, 200, "metadata preview must not become HTTP 504 while a source is slow");
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    let earlyFile = false;
    const result = await readJsonResponse<{ preview: { inventory: { files: unknown[] }; planSha256: string } }>(response, (event) => {
      if (event.event === "batch" && Array.isArray(event.value.files) && event.value.files.length) earlyFile ||= !fixture.counts().slowFinished;
    });
    assert.equal(earlyFile, true);
    assert.equal(result.preview.inventory.files.length, 2);
    assert.match(result.preview.planSha256, /^[a-f0-9]{64}$/);
  } finally { await close(proxy); await close(fixture.server); }
});

test("JSON and SSE previews produce the same final confirmation fingerprint", async () => {
  const fixture = previewService(5), address = await listen(fixture.server);
  try {
    const run = async (accept: string) => readJsonResponse(await fetch(`${address}/preview`, {
      method: "POST", headers: { "Content-Type": "application/json", Accept: accept }, body: JSON.stringify(selection),
    }));
    assert.deepEqual(await run("application/json"), await run("text/event-stream"));
  } finally { await close(fixture.server); }
});

test("closing a preview response aborts active sources without starting the queued batch", async () => {
  const fixture = previewService(1000, 8), address = await listen(fixture.server);
  const controller = new AbortController();
  try {
    const response = await fetch(`${address}/preview`, { method: "POST", signal: controller.signal,
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" }, body: JSON.stringify(selection) });
    const pending = readJsonResponse(response, (event) => {
      if (event.event === "batch" && Array.isArray(event.value.files) && event.value.files.length) controller.abort();
    }, undefined, controller.signal);
    await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === "AbortError");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(fixture.counts(), { started: 4, aborted: 3, slowFinished: false });
  } finally { controller.abort(); await close(fixture.server); }
});
