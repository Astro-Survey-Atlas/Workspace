import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { DataStatisticsModule } from "../src/data-statistics.js";
import { readSuccessfulScanInventory } from "../src/scan-inventory.js";
import { SqliteMetadataStore } from "../src/storage/sqlite.js";
import { openStatisticsDatabase } from "../src/statistics-database.js";
import { ConnectorRegistry } from "../src/connectors.js";
import { DataCatalogRegistry } from "../src/data-catalog.js";
import { MemoryConnectorCredentialStore } from "../src/connector-credentials.js";
import { LocalConnectorRootsPolicy } from "../src/local-connector-roots.js";
import type { ConnectorIngestRunRecord } from "../src/connector-history.js";
import { formatDataBytes, formatDataFiles } from "../viewer/src/data-amount.js";

test("Warehouse compressed historical inventory restores current and cumulative bytes without a source listing", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "statistics-history-"));
  const store = new SqliteMetadataStore(":memory:");
  const statisticsStore = new SqliteMetadataStore(":memory:");
  await store.initialize(); await statisticsStore.initialize();
  t.after(async () => { await store.close(); await statisticsStore.close(); await rm(root, { recursive: true, force: true }); });
  const roots = new LocalConnectorRootsPolicy([root]);
  const connectors = new ConnectorRegistry(store, roots);
  const connector = await connectors.register({ name: "CSST", kind: "s3", config: { bucket: "csst", prefix: "images", endpoint: "https://unreachable.invalid" } });
  const assets = new DataCatalogRegistry(store);
  const asset = await assets.register({ name: "CSST images", kind: "image", product: "image", accesses: [{ connector: "s3", uri: connector.locationKey, format: "fits", connectorId: connector.id }], connectorIds: [connector.id] });
  const directory = path.join(root, "scan-one"); await mkdir(directory);
  const files = [{ fileId: "file-one", sourceUri: "s3://csst/images/one.fits", sizeBytes: 3000000000000001 },
    { fileId: "file-two", sourceUri: "s3://csst/images/two.fits", sizeBytes: 12 }];
  const sha = createHash("sha256").update(files.map(file => `${JSON.stringify(file)}\n`).join("")).digest("hex");
  const run: ConnectorIngestRunRecord = { id: "run-one", connectorId: connector.id, assetId: asset.id, executor: "warehouse-scan", status: "succeeded",
    batchId: "batch-one", warehouseLayerId: "layer-one", evidencePath: directory, sourceSnapshotSha256: sha, fileCount: 2,
    locationKey: connector.locationKey, startedAt: "2026-10-26T00:00:00Z", createdAt: "2026-10-26T00:00:00Z", completedAt: "2026-10-26T00:01:00Z" };
  await writeFile(path.join(directory, "source-inventory.json.gz"), gzipSync(JSON.stringify(files)));
  await writeFile(path.join(directory, "summary.json"), JSON.stringify({ phase: "COMPLETED", scanRunId: run.batchId, layerId: run.warehouseLayerId, sourceSnapshotSha256: sha, fileCount: 2 }));
  await store.putConnectorIngestRun(run);
  const statistics = new DataStatisticsModule({ store, statisticsStore, connectors, assets, credentials: new MemoryConnectorCredentialStore(), roots,
    workspaceScanRoot: root, evidenceRoot: root });
  const wait = async () => { for (let attempt = 0; statistics.busy && attempt < 200; attempt++) await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(statistics.busy, false); };
  await statistics.refresh(undefined, "history"); await wait();
  let view = await statistics.view();
  assert.equal(view.scanned.files, 2); assert.equal(view.scanned.bytes, 3000000000000013);
  assert.equal(view.cumulativeScanned.bytes, "3000000000000013");
  assert.equal(view.refresh?.processedFiles, 2, "historical inventory files must advance public refresh progress");
  assert.equal(view.accessible.state, "unknown");
  for (const snapshot of await statisticsStore.listStatisticsSnapshots()) await statisticsStore.deleteStatisticsSnapshot(snapshot.id);
  await statisticsStore.setImportMarker("data-statistics-refresh-v1", JSON.stringify({ ...view.refresh, status: "running", historyProgress: { [run.id]: 2 } }));
  const recovered = new DataStatisticsModule({ store, statisticsStore, connectors, assets, credentials: new MemoryConnectorCredentialStore(), roots,
    workspaceScanRoot: root, evidenceRoot: root });
  await recovered.initialize();
  for (let attempt = 0; recovered.busy && attempt < 200; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await recovered.view()).refresh?.processedFiles, 2, "replaying an interrupted inventory must not count progress twice");
  await statistics.refresh(undefined, "history"); await wait();
  assert.equal((await statistics.view()).cumulativeScanned.bytes, "3000000000000013");
  for (let index = 2; index <= 4; index++) {
    await store.putConnectorIngestRun({ ...run, id: `run-${index}`, logicalRunId: `logical-${index}` });
  }
  await statistics.refresh(undefined, "history"); await wait();
  view = await statistics.view();
  assert.equal(view.cumulativeScanned.bytes, "12000000000000052");
  assert.equal(view.scanned.files, 2);
  await store.putConnectorIngestRun({ ...run, id: "retry-four", logicalRunId: "logical-4" });
  await statistics.refresh(undefined, "history"); await wait();
  assert.equal((await statistics.view()).cumulativeScanned.bytes, "12000000000000052");
  await writeFile(path.join(directory, "source-inventory.json.gz"), gzipSync(JSON.stringify([...files, files[0]])));
  await assert.rejects(readSuccessfulScanInventory(run, { workspaceScanRoot: root, evidenceRoot: root }, () => {}, async () => {}), /checksum|incomplete/);

  const parent = { ...run, id: "batch-parent", executor: "warehouse-batch", status: "running" as const, completedAt: "2026-10-27T00:00:00Z", batchProgress: { completed: 0, failed: 0, total: 2, active: 2 } };
  await store.putConnectorIngestRun(parent);
  const children = [0, 1].map(index => ({ ...run, id: `child-${index}`, logicalRunId: parent.id, parentRunId: parent.id, partitionId: `s${index}`, fileCount: 1,
    completedAt: "2026-10-27T00:00:00Z" }));
  for (const [index, child] of children.entries()) {
    await store.putConnectorIngestRun(child);
    await statistics.recordScan(child, [{ uri: `s3://csst/images/child-${index}.fits`, size: (index + 1) * 10 }]);
  }
  assert.equal((await statistics.view()).scanned.bytes, 3000000000000013, "a running batch must preserve the previous complete scan");
  await store.putConnectorIngestRun({ ...parent, status: "succeeded", batchProgress: { completed: 2, failed: 0, total: 2, active: 0 } });
  // Publication cache is deliberately bounded; a completion notification invalidates it.
  await statistics.recordScan(children[0]!, [{ uri: "s3://csst/images/child-0.fits", size: 10 }]);
  assert.equal((await statistics.view()).scanned.bytes, 30);
  const cumulative = (await statistics.view()).cumulativeScanned.bytes;
  const retry = { ...children[0]!, id: "child-zero-retry", completedAt: "2026-10-28T00:00:00Z" };
  await store.putConnectorIngestRun(retry);
  await statistics.recordScan(retry, [{ uri: "s3://csst/images/child-0.fits", size: 10 }]);
  assert.equal((await statistics.view()).cumulativeScanned.bytes, cumulative, "one logical partition can be counted only once");
});

test("volume formatting distinguishes unknown and partial counts and preserves PB totals", () => {
  const unknown = { files: 0, knownBytes: 0, bytes: null, unknownFiles: 0, state: "unknown" as const };
  assert.equal(formatDataBytes(unknown), "未统计");
  assert.equal(formatDataFiles(unknown), "文件数尚未统计");
  assert.equal(formatDataBytes({ ...unknown, state: "partial", knownBytes: 63779659200000 }), "至少 63.78 TB");
  assert.equal(formatDataBytes({ ...unknown, state: "complete", bytes: "12000000000000052", knownBytes: "12000000000000052" }), "12.00 PB");
});

test("statistics snapshots recover committed work and discard interrupted inventory entries", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "statistics-checkpoint-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let database = await openStatisticsDatabase(root);
  const snapshot = { id: "finished", slot: "scanned:one", category: "scanned" as const, connectorId: "one",
    fingerprint: "one", updatedAt: "2026-10-26T00:00:00Z", state: "complete" as const };
  await database.store.putStatisticsSnapshot(snapshot);
  await database.store.putStatisticsEntries(snapshot.id, [{ key: "one.fits", bytes: 100 }]);
  await database.store.putStatisticsEntries("interrupted-unpublished-scan", [{ key: "two.fits", bytes: 200 }]);
  await database.store.setImportMarker("resume", "saved-page-cursor");
  await database.close();
  database = await openStatisticsDatabase(root);
  try {
    assert.deepEqual(await database.store.statisticsTotals([snapshot.id]), { files: 1, knownBytes: 100, unknownFiles: 0 });
    assert.equal(await database.store.getImportMarker("resume"), "saved-page-cursor");
    await database.store.putStatisticsSnapshot({ ...snapshot, id: "interrupted-unpublished-scan" });
    assert.equal((await database.store.statisticsTotals(["interrupted-unpublished-scan"])).files, 0);
  } finally { await database.close(); }
});
