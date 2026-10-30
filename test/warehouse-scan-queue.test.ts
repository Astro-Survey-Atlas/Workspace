import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ConnectorRegistry } from "../src/connectors.js";
import { ConnectorIngestRunCatalog } from "../src/connector-history.js";
import { MemoryConnectorCredentialStore } from "../src/connector-credentials.js";
import { DataCatalogRegistry } from "../src/data-catalog.js";
import { LocalConnectorRootsPolicy } from "../src/local-connector-roots.js";
import { SqliteMetadataStore } from "../src/storage/sqlite.js";
import { WarehouseScanQueue } from "../src/warehouse-scan-queue.js";
import { currentWarehouseLayerIds, warehouseLayerBelongsToAsset } from "../src/workspace-layer-identity.js";
import type { FrozenScanSelection } from "../src/warehouse-scan.js";
import type { CoverageJobSnapshot } from "../src/coverage-jobs.js";
import type { GenericScanInput } from "../src/scan-contract.js";
import type { UserMocArtifact } from "../src/user-moc-artifacts.js";

const waitUntil = async (ready: () => Promise<boolean>) => {
  for (let attempt = 0; attempt < 500; attempt++) { if (await ready()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail("Queue did not reach expected state");
};

test("bounded S3 queue freezes pages, resumes after restart, and retries only failed partitions", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "scan-queue-"));
  const store = new SqliteMetadataStore(":memory:"); await store.initialize();
  const listed: number[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://localhost"); const offset = Number(url.searchParams.get("continuation-token") ?? 0);
    listed.push(offset);
    const stop = Math.min(offset + 1000, 4001);
    const rows = Array.from({ length: stop - offset }, (_, i) => `<Contents><Key>images/CSST_${String(offset + i).padStart(6, "0")}.fits</Key><Size>100</Size></Contents>`).join("");
    response.setHeader("Content-Type", "application/xml");
    response.end(`<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>${stop < 4001}</IsTruncated>${stop < 4001 ? `<NextContinuationToken>${stop}</NextContinuationToken>` : ""}${rows}</ListBucketResult>`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const roots = new LocalConnectorRootsPolicy([root]);
  const connectors = new ConnectorRegistry(store, roots);
  let connector = await connectors.register({ name: "CSST", kind: "s3", config: { bucket: "csst", prefix: "images", endpoint: `http://127.0.0.1:${address.port}` } });
  const credentials = new MemoryConnectorCredentialStore();
  await credentials.put(credentials.managedReference(connector.id), { accessKeyId: "test", secretAccessKey: "test", endpoint: connector.config.endpoint! });
  connector = await connectors.setCredentialReference(connector.id, credentials.managedReference(connector.id));
  const assets = new DataCatalogRegistry(store);
  const asset = await assets.register({ name: "CSST queue", kind: "image", product: "image", connectorIds: [connector.id], accesses: [{ connector: "s3", connectorId: connector.id, uri: connector.locationKey, format: "fits" }] });
  const runs = new ConnectorIngestRunCatalog(store);
  const coverage: CoverageJobSnapshot = { surveyId: "csst", releaseId: "test", product: "image", mode: "fits-wcs" as const, coordinateFrame: "ICRS" as const, coverageRole: "image_extent", dataOrigin: "observed", sourceTier: "user_file_derived", maxOrder: 10, queryOrder: 8 as const, previewOrder: 4 as const };
  const input: GenericScanInput = { assetId: asset.id, coverage, allowedSuffixes: [".fits"] };
  const submitted: Array<{ id: string; frozen: FrozenScanSelection }> = [];
  const positions: string[] = []; let merges = 0;
  const warehouse = {
    prepareConnectorScan: async () => ({ connector, asset, input }),
    submitScan: async (_connectorId: string, _input: GenericScanInput, key?: string, frozen?: FrozenScanSelection) => {
      assert.ok(frozen);
      const text = await readFile(frozen.inventory.path, "utf8");
      assert.equal(createHash("sha256").update(text).digest("hex"), frozen.inventory.sha256);
      assert.equal(text.trim().split("\n").length, frozen.inventory.fileCount);
      assert.ok(frozen.inventory.fileCount <= 2000);
      const evidence = path.join(root, `evidence-${submitted.length}`); await mkdir(evidence, { recursive: true });
      await writeFile(path.join(evidence, "summary.json"), JSON.stringify({ indexedLayerId: `partition-${submitted.length}` }));
      const created = await runs.create(connector.locationKey, { connectorId: connector.id, assetId: asset.id, parentRunId: frozen.parentRunId,
        warehouseLayerId: frozen.layerId,
        logicalRunId: frozen.parentRunId, partitionId: frozen.partitionId, executor: "warehouse-scan", backend: "warehouse", status: "running",
        fileCount: frozen.inventory.fileCount, evidencePath: evidence, batchId: `batch-${submitted.length}`, sourceSnapshotSha256: frozen.inventory.sha256, coverage }, key);
      if (created.created) submitted.push({ id: created.run.id, frozen });
      return created.run;
    },
    taskLogs: async (_connector: string, id: string) => ({ runId: id, status: "available" as const, text: "scanner log", fetchedAt: new Date().toISOString() }),
  };
  const options = { root: path.join(root, "batches"), enabled: true, warehouse, connectors, credentials, runs, roots,
    artifacts: { importEvidence: async () => { merges++; return { id: "moc-batch", status: "ready", availableOrders: [8], precision: "estimated" } as UserMocArtifact; } },
    onCompleted: async (_asset: string, runId: string) => { if (!positions.includes(runId)) positions.push(runId); } };
  let queue = new WarehouseScanQueue(options);
  t.after(async () => { queue.stop(); await new Promise<void>(resolve => server.close(() => resolve())); await store.close(); await rm(root, { recursive: true, force: true }); });
  const parent = await queue.submit(connector.id, {}, "one-logical-batch");
  const parentRun = async () => (await runs.list()).find(run => run.id === parent.id)!;
  await waitUntil(async () => (await parentRun()).batchProgress?.active === 2);
  assert.equal(submitted.length, 2); assert.deepEqual(listed, [0, 1000, 2000, 3000, 4000]);
  const state = JSON.parse(await readFile(path.join(options.root, parent.id, "batch.json"), "utf8"));
  assert.deepEqual(state.shards.map((shard: { fileCount: number }) => shard.fileCount), [2000, 2000, 1]);
  await runs.update(submitted[0]!.id, { status: "succeeded" }); await runs.update(submitted[1]!.id, { status: "failed", error: "source unavailable" });
  await queue.tick(); assert.equal(submitted.length, 3);
  assert.deepEqual(positions, [submitted[0]!.id], "successful shard positions must be available before the whole batch finishes");
  await runs.update(submitted[2]!.id, { status: "succeeded" }); await queue.tick();
  assert.equal((await parentRun()).status, "failed");
  queue.stop();
  const failedStatePath = path.join(options.root, parent.id, "batch.json");
  const failedState = JSON.parse(await readFile(failedStatePath, "utf8"));
  failedState.shards[0].positionsSubmitted = false;
  await writeFile(failedStatePath, JSON.stringify(failedState));
  queue = new WarehouseScanQueue(options); await queue.initialize();
  await waitUntil(async () => JSON.parse(await readFile(failedStatePath, "utf8")).shards[0].positionsSubmitted);
  await waitUntil(async () => (await parentRun()).status === "failed");
  await queue.retry(parent.id);
  await waitUntil(async () => submitted.length === 4);
  assert.equal(submitted[3]!.frozen.partitionId, submitted[1]!.frozen.partitionId);
  assert.equal(submitted[3]!.frozen.inventory.sha256, submitted[1]!.frozen.inventory.sha256);
  assert.equal(submitted[3]!.frozen.layerId, submitted[1]!.frozen.layerId, "retries retain the same Warehouse scope layer");
  assert.equal(listed.length, 5, "retry must not re-enumerate its frozen scope");
  await runs.update(submitted[3]!.id, { status: "succeeded" });
  await queue.tick(); await waitUntil(async () => (await parentRun()).status === "succeeded");
  assert.equal(merges, 1); assert.equal(positions.length, 3);
  assert.equal((await parentRun()).processedFiles, 4001);
  const logs = await queue.taskLogs(connector.id, parent.id); assert.match(logs.text, /s000002/);
  queue.stop(); queue = new WarehouseScanQueue(options); await queue.initialize(); await queue.tick();
  assert.equal(merges, 1); assert.equal(positions.length, 3); assert.equal(submitted.length, 4);
  const firstLayer = (await parentRun()).warehouseLayerId!;
  assert.ok(warehouseLayerBelongsToAsset(firstLayer, asset.id));
  assert.deepEqual(currentWarehouseLayerIds(asset.id, await runs.list()), [firstLayer]);
  const rescan = await queue.submit(connector.id, {}, "second-logical-batch");
  await waitUntil(async () => submitted.length === 6);
  assert.notEqual(rescan.warehouseLayerId, firstLayer, "an independent run must not mutate an immutable Warehouse scope");
  assert.deepEqual(currentWarehouseLayerIds(asset.id, await runs.list()), [firstLayer], "keep the previous complete layer during replacement");
  // Historical versions made a transient parent metadata error terminal.
  // Restart must adopt its frozen selection without replacing successful work.
  queue.stop();
  await runs.update(rescan.id, { status: "failed", error: "database is locked" });
  const rescanStatePath = path.join(options.root, rescan.id, "batch.json");
  const rescanState = JSON.parse(await readFile(rescanStatePath, "utf8"));
  rescanState.phase = "failed";
  await writeFile(rescanStatePath, JSON.stringify(rescanState));
  queue = new WarehouseScanQueue(options); await queue.initialize();
  await waitUntil(async () => (await runs.list()).find(run => run.id === rescan.id)!.status === "running");
  assert.equal(submitted.length, 6, "metadata recovery adopts existing Scanner Jobs");
  await runs.update(submitted[4]!.id, { status: "succeeded" });
  await runs.update(submitted[5]!.id, { status: "succeeded" });
  const update = runs.update.bind(runs);
  let locked = true;
  runs.update = async (id, changes) => {
    if (id === rescan.id && locked) { locked = false; throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }); }
    return update(id, changes);
  };
  await queue.tick();
  assert.notEqual((await runs.list()).find(run => run.id === rescan.id)!.status, "failed", "temporary metadata contention must not terminate the batch");
  await queue.tick();
  await waitUntil(async () => submitted.length === 7);
  assert.deepEqual(currentWarehouseLayerIds(asset.id, await runs.list()), [firstLayer], "a successful child cannot publish a partial batch");
  await runs.update(submitted[6]!.id, { status: "succeeded" });
  await queue.tick();
  assert.deepEqual(currentWarehouseLayerIds(asset.id, await runs.list()), [rescan.warehouseLayerId]);
  assert.equal(merges, 2);
});
