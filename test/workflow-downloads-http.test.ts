import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import yauzl from "yauzl";

import { createWorkflowDownloadsRouter, type WorkflowCutoutDownloads } from "../src/workflow-downloads-http.js";
import { WorkflowStore } from "../src/workflow-store.js";
import { EUCLID_DESI_WORKFLOW } from "../src/workflow-engine.js";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "workflow-downloads-"));
  const store = new WorkflowStore(root);
  await store.initialize();
  const run = await store.create(EUCLID_DESI_WORKFLOW, {});
  const app = express();
  app.use("/api/workflow-runs", createWorkflowDownloadsRouter(store, (response, error) => {
    response.status(error instanceof RangeError ? 400 : 500).json({ error: String(error) });
  }));
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await store.flush();
    await rm(root, { recursive: true, force: true });
  });
  return { root, store, run, url: `http://127.0.0.1:${address.port}/api/workflow-runs/${run.id}` };
}

function unzip(buffer: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) { reject(error); return; }
      const files = new Map<string, Buffer>();
      zip.on("error", reject);
      zip.on("end", () => resolve(files));
      zip.on("entry", entry => zip.openReadStream(entry, async (error, stream) => {
        if (error || !stream) { reject(error); return; }
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of stream) chunks.push(Buffer.from(chunk));
          files.set(entry.fileName, Buffer.concat(chunks));
          zip.readEntry();
        } catch (error) { reject(error); }
      }));
      zip.readEntry();
    });
  });
}

test("downloads expose registered FITS and stream an intact ZIP with provenance after partial failure", async t => {
  const { store, run, url } = await fixture(t);
  const fits = Buffer.alloc(2880, " "); fits.write("SIMPLE  =                    T");
  await store.writeArtifact(run, "target-vis.fits", "application/fits", 1, fits);
  await store.writeArtifact(run, "filtered.csv", "text/csv", 1, "objectId\ne1\n");
  await store.writeArtifact(run, "cutouts.json", "application/json", 3, JSON.stringify({ records: [
    { status: "ok", objectId: "e1", rowIndex: 0, telescope: "euclid", band: "vis", outputUri: `/api/workflow-runs/${run.id}/artifacts/target-vis.fits` },
    { status: "error", objectId: "e2", telescope: "desi", band: "g", error: "NoOverlap" },
    { status: "ok", objectId: "external", outputUri: "https://external.test/unregistered.fits" },
  ] }));
  const response = await fetch(`${url}/cutouts`);
  assert.equal(response.status, 200);
  const result = await response.json() as WorkflowCutoutDownloads;
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0]?.objectId, "e1");
  assert.equal(result.files[0]?.band, "vis");
  assert.equal(result.totalBytes, fits.length);
  assert.equal(result.failures.length, 2);
  assert.match(result.files[0]!.downloadUrl, /\/artifacts\/target-vis\.fits$/);
  const archive = await fetch(`${url}/cutouts.zip`);
  assert.equal(archive.status, 200);
  assert.match(archive.headers.get("content-disposition") ?? "", /attachment; filename=".*-cutouts.zip"/);
  const files = await unzip(Buffer.from(await archive.arrayBuffer()));
  assert.deepEqual(files.get("target-vis.fits"), fits);
  assert.equal(files.get("filtered.csv")?.toString(), "objectId\ne1\n");
  const manifest = JSON.parse(files.get("manifest.json")!.toString());
  assert.equal(manifest.runId, run.id);
  for (const file of manifest.files) assert.equal(createHash("sha256").update(files.get(file.name)!).digest("hex"), file.sha256);
});

test("empty selections have no archive and missing artifacts fail before a ZIP response starts", async t => {
  const { store, run, root, url } = await fixture(t);
  const empty = await (await fetch(`${url}/cutouts`)).json() as WorkflowCutoutDownloads;
  assert.deepEqual(empty.files, []);
  assert.equal(empty.archiveUrl, undefined);
  assert.equal((await fetch(`${url}/cutouts.zip`)).status, 400);
  await store.writeArtifact(run, "broken.fits", "application/fits", 1, Buffer.alloc(2880));
  await writeFile(path.join(root, run.id, "broken.fits"), "truncated");
  const response = await fetch(`${url}/cutouts.zip`);
  assert.equal(response.status, 500);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  assert.match(await response.text(), /size mismatch/);
});
