import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ASTRO_COVERAGE_INDEX, ASTRO_OBJECT_INDEX } from "../src/astro-object-index.js";
import { ConnectorIngestRunCatalog } from "../src/connector-history.js";
import { ConnectorRegistry, type ConnectorRecord } from "../src/connectors.js";
import { DataCatalogRegistry, type DataAssetRecord, type DataAssetRegistrationInput } from "../src/data-catalog.js";
import { LocalConnectorRootsPolicy } from "../src/local-connector-roots.js";
import {
  LocalCsvScanExecutor,
  LocalScanCapabilityError,
  LocalScanDisabledError,
  LocalScanPreconditionError,
  localScanEnabled,
  stableLocalSourceFileId,
  type LocalCsvScanIndexService,
} from "../src/local-scan-executor.js";
import type { LocalScanDocument } from "../src/local-scan.js";
import { SqliteMetadataStore } from "../src/storage/index.js";

class MockIndexService implements LocalCsvScanIndexService {
  configured = true;
  readonly batches: LocalScanDocument[][] = [];
  failure?: Error;

  async ensureIndices(): Promise<void> {}

  async bulk(documents: LocalScanDocument[]): Promise<{ objectCount: number; coverageCount: number }> {
    this.batches.push(structuredClone(documents));
    if (this.failure) throw this.failure;
    return {
      objectCount: documents.filter((document) => "object_id" in document).length,
      coverageCount: documents.filter((document) => "objectCount" in document).length,
    };
  }

  get documents(): LocalScanDocument[] {
    return this.batches.flat();
  }
}

interface Fixture {
  directory: string;
  rootPath: string;
  store: SqliteMetadataStore;
  roots: LocalConnectorRootsPolicy;
  connectors: ConnectorRegistry;
  dataCatalog: DataCatalogRegistry;
  runs: ConnectorIngestRunCatalog;
  connector: ConnectorRecord;
  indexService: MockIndexService;
  executor: LocalCsvScanExecutor;
}

async function fixture(options: { checked?: boolean; enabled?: boolean } = {}): Promise<Fixture> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-local-executor-"));
  const rootPath = path.join(directory, "catalogs");
  const bootstrapPath = path.join(directory, "data-assets.json");
  await mkdir(rootPath);
  await writeFile(bootstrapPath, "[]", "utf8");

  const store = new SqliteMetadataStore(path.join(directory, "workspace.sqlite"));
  await store.initialize();
  const roots = new LocalConnectorRootsPolicy([{ containerPath: rootPath, hostPath: rootPath }]);
  const connectors = new ConnectorRegistry(store, undefined, roots);
  await connectors.initialize();
  const dataCatalog = new DataCatalogRegistry(bootstrapPath, store);
  await dataCatalog.initialize();
  const runs = new ConnectorIngestRunCatalog(store);
  const registered = await connectors.register({
    name: "Local catalog connector",
    kind: "local",
    config: { rootPath },
    status: "ready",
  });
  const connector = options.checked === false ? registered : await connectors.check(registered.id);
  const indexService = new MockIndexService();
  const executor = new LocalCsvScanExecutor({
    enabled: options.enabled ?? true,
    connectors,
    dataCatalog,
    runs,
    roots,
    indexService,
    maxRows: 100,
    maxFileBytes: 1024 * 1024,
  });
  return { directory, rootPath, store, roots, connectors, dataCatalog, runs, connector, indexService, executor };
}

async function cleanup(value: Fixture): Promise<void> {
  await value.store.close();
  await rm(value.directory, { recursive: true, force: true });
}

async function registerAsset(value: Fixture, overrides: Partial<DataAssetRegistrationInput> = {}): Promise<DataAssetRecord> {
  return value.dataCatalog.register({
    name: "Local source catalog",
    description: "Small CSV fixture",
    surveyId: "survey-a",
    releaseId: "release-1",
    product: "asset-product",
    kind: "catalog",
    modalities: ["optical"],
    connector: "local",
    sourceUri: path.join(value.rootPath, "catalog.csv"),
    format: "csv",
    connectorLocationKeys: [value.connector.locationKey],
    scanSpec: {
      format: "csv",
      objectIdColumn: "object_id",
      raColumn: "ra",
      decColumn: "dec",
      coordinateFrame: "ICRS",
      coordinateUnits: "deg",
      modality: "photometry",
      product: "scan-product",
    },
    status: "ready",
    ...overrides,
  });
}

test("parses the local scan feature flag strictly", () => {
  assert.equal(localScanEnabled(undefined), false);
  assert.equal(localScanEnabled("false"), false);
  assert.equal(localScanEnabled("true"), true);
  assert.throws(() => localScanEnabled("1"), /must be true or false/);
});

test("executes one top-level CSV into object and coverage bulks and persists succeeded history", async () => {
  const value = await fixture();
  const filePath = path.join(value.rootPath, "catalog.csv");
  try {
    await writeFile(filePath, [
      "object_id,ra,dec,flux\n",
      "source-1,10,20,4.2\n",
      "source-2,10,20,8.4\n",
    ].join(""), "utf8");
    const asset = await registerAsset(value);

    const queued = await value.executor.submit(value.connector.id);
    assert.equal(queued.status, "queued");
    assert.equal(queued.executor, "local-csv");
    assert.equal(queued.connectorId, value.connector.id);
    assert.equal(queued.connectorName, value.connector.name);
    assert.equal(queued.connectorKind, "local");
    assert.deepEqual(queued.assetIds, [asset.id]);
    assert.equal(queued.assetId, asset.id);
    assert.equal(queued.assetName, asset.name);
    assert.equal(queued.target?.uri, filePath);
    assert.equal(queued.sourcePath, filePath);
    assert.equal(queued.esIndex, ASTRO_OBJECT_INDEX);

    const completed = await value.executor.awaitCompletion(queued.id);
    assert.equal(completed.status, "succeeded");
    assert.equal(completed.fileCount, 1);
    assert.equal(completed.documentCount, 2);
    assert.ok(completed.completedAt);
    assert.equal(completed.error, undefined);

    const objects = value.indexService.documents.filter((document) => "object_id" in document);
    const coverage = value.indexService.documents.filter((document) => "objectCount" in document);
    assert.equal(objects.length, 2);
    assert.equal(coverage.length, 1);
    assert.equal(objects.every((document) => document._index === ASTRO_OBJECT_INDEX), true);
    assert.equal(coverage.every((document) => document._index === ASTRO_COVERAGE_INDEX), true);
    assert.equal(objects[0] && "survey" in objects[0] ? objects[0].survey : undefined, "survey-a");
    assert.equal(objects[0] && "release" in objects[0] ? objects[0].release : undefined, "release-1");
    assert.equal(objects[0] && "product" in objects[0] ? objects[0].product : undefined, "scan-product");
    assert.equal(objects[0] && "modality" in objects[0] ? objects[0].modality : undefined, "photometry");
    assert.equal(objects[0] && "scan_run_id" in objects[0] ? objects[0].scan_run_id : undefined, queued.id);
    assert.equal(coverage[0] && "objectCount" in coverage[0] ? coverage[0].objectCount : undefined, 2);

    const details = await stat(filePath);
    const sourceFileId = stableLocalSourceFileId(filePath, details.size, details.mtimeMs);
    assert.equal(objects[0] && "source_file_id" in objects[0] ? objects[0].source_file_id : undefined, sourceFileId);
    assert.equal(coverage[0] && "source_file_id" in coverage[0] ? coverage[0].source_file_id : undefined, sourceFileId);

    const history = await value.runs.list({ connectorId: value.connector.id });
    assert.equal(history.length, 1);
    assert.equal(history[0]?.id, queued.id);
    assert.equal(history[0]?.status, "succeeded");
    assert.equal(history[0]?.documentCount, 2);
  } finally {
    await cleanup(value);
  }
});

test("rejects disabled execution, disabled/non-local connectors, stale checks, and missing Elasticsearch", async () => {
  const disabled = await fixture({ enabled: false });
  try {
    await assert.rejects(() => disabled.executor.submit(disabled.connector.id), (error: unknown) => {
      assert.ok(error instanceof LocalScanDisabledError);
      assert.equal(error.statusCode, 503);
      return true;
    });
  } finally {
    await cleanup(disabled);
  }

  const value = await fixture({ checked: false });
  try {
    await assert.rejects(() => value.executor.submit(value.connector.id), (error: unknown) => {
      assert.ok(error instanceof LocalScanPreconditionError);
      assert.match(error.message, /current successful connection check/);
      return true;
    });

    const remote = await value.connectors.register({ name: "Remote", kind: "s3", config: { bucket: "catalog" } });
    await assert.rejects(() => value.executor.submit(remote.id), (error: unknown) => {
      assert.ok(error instanceof LocalScanCapabilityError);
      assert.equal(error.statusCode, 422);
      return true;
    });

    const checked = await value.connectors.check(value.connector.id);
    const disabledConnector = await value.connectors.update(checked.id, {
      name: checked.name,
      kind: "local",
      config: checked.config,
      status: "disabled",
    });
    await assert.rejects(() => value.executor.submit(disabledConnector.id), /Disabled connectors cannot be scanned/);

    const anotherRoot = path.join(value.rootPath, "other-catalogs");
    await mkdir(anotherRoot);
    const available = await value.connectors.register({ name: "Available", kind: "local", config: { rootPath: anotherRoot }, status: "ready" });
    const availableChecked = await value.connectors.check(available.id);
    value.indexService.configured = false;
    await assert.rejects(() => value.executor.submit(availableChecked.id), /Elasticsearch is not configured/);
  } finally {
    await cleanup(value);
  }
});

test("requires exactly one linked user asset with complete CSV scan metadata", async () => {
  const value = await fixture();
  try {
    await writeFile(path.join(value.rootPath, "catalog.csv"), "object_id,ra,dec\none,1,2\n", "utf8");
    await assert.rejects(() => value.executor.submit(value.connector.id), /found 0/);

    await registerAsset(value, { name: "First asset" });
    await registerAsset(value, { name: "Second asset", connectorIds: [value.connector.id], connectorLocationKeys: [] });
    await assert.rejects(() => value.executor.submit(value.connector.id), /found 2/);
  } finally {
    await cleanup(value);
  }

  const incomplete = await fixture();
  try {
    await writeFile(path.join(incomplete.rootPath, "catalog.csv"), "object_id,ra,dec\none,1,2\n", "utf8");
    await registerAsset(incomplete, { surveyId: undefined, releaseId: undefined });
    await assert.rejects(() => incomplete.executor.submit(incomplete.connector.id), /surveyId/);
  } finally {
    await cleanup(incomplete);
  }

  const noSpec = await fixture();
  try {
    await writeFile(path.join(noSpec.rootPath, "catalog.csv"), "object_id,ra,dec\none,1,2\n", "utf8");
    await registerAsset(noSpec, { scanSpec: undefined });
    await assert.rejects(() => noSpec.executor.submit(noSpec.connector.id), /CSV scanSpec/);
  } finally {
    await cleanup(noSpec);
  }
});

test("validates v1 input, rejects zero or multiple implicit CSVs and path escapes, and allows nested CSV files", async () => {
  const value = await fixture();
  const outsideDirectory = await mkdtemp(path.join(os.tmpdir(), "astro-local-executor-outside-"));
  try {
    await registerAsset(value);
    await assert.rejects(() => value.executor.submit(value.connector.id), /found 0/);

    await writeFile(path.join(value.rootPath, "one.csv"), "object_id,ra,dec\none,1,2\n", "utf8");
    await writeFile(path.join(value.rootPath, "two.CSV"), "object_id,ra,dec\ntwo,3,4\n", "utf8");
    await assert.rejects(() => value.executor.submit(value.connector.id), /found 2/);
    await assert.rejects(() => value.executor.submit(value.connector.id, { relativePath: "../outside.csv" }), /dot segments/);
    await assert.rejects(() => value.executor.submit(value.connector.id, { relativePath: path.join(value.rootPath, "one.csv") }), /must be relative/);
    await assert.rejects(() => value.executor.submit(value.connector.id, { relativePath: "" }), /non-empty/);
    await assert.rejects(
      () => value.executor.submit(value.connector.id, { relativePath: "one.csv", extra: true } as never),
      /unknown field: extra/,
    );

    const outsideFile = path.join(outsideDirectory, "outside.csv");
    await writeFile(outsideFile, "object_id,ra,dec\noutside,1,2\n", "utf8");
    await symlink(outsideFile, path.join(value.rootPath, "escape.csv"));
    await assert.rejects(() => value.executor.submit(value.connector.id, { relativePath: "escape.csv" }), /outside-root/);

    const nested = path.join(value.rootPath, "nested");
    await mkdir(nested);
    await writeFile(path.join(nested, "catalog.csv"), "object_id,ra,dec\nnested,12,34\n", "utf8");
    const queued = await value.executor.submit(value.connector.id, { relativePath: "nested/catalog.csv", maxRows: 1 });
    const completed = await value.executor.wait(queued.id);
    assert.equal(completed.status, "succeeded");
    assert.equal(completed.target?.uri, path.join(nested, "catalog.csv"));
  } finally {
    await cleanup(value);
    await rm(outsideDirectory, { recursive: true, force: true });
  }
});

test("idempotent retries return the same run and do not start another scan", async () => {
  const value = await fixture();
  try {
    await writeFile(path.join(value.rootPath, "catalog.csv"), "object_id,ra,dec\none,1,2\n", "utf8");
    await registerAsset(value);

    const first = await value.executor.submit(value.connector.id, undefined, "same-request");
    const retry = await value.executor.submit(value.connector.id, { relativePath: "missing.csv" }, "same-request");
    assert.equal(retry.id, first.id);
    const completed = await value.executor.runNow(first.id);
    assert.equal(completed.status, "succeeded");
    assert.equal(value.indexService.documents.filter((document) => "object_id" in document).length, 1);
    assert.equal((await value.runs.list({ connectorId: value.connector.id })).length, 1);
  } finally {
    await cleanup(value);
  }
});

test("background scan and bulk errors are recorded as failed runs", async () => {
  const value = await fixture();
  try {
    await writeFile(path.join(value.rootPath, "catalog.csv"), "object_id,ra,dec\none,1,2\n", "utf8");
    await registerAsset(value);
    value.indexService.failure = new Error("bulk fixture failed");

    const queued = await value.executor.submit(value.connector.id);
    assert.equal(queued.status, "queued");
    const completed = await value.executor.awaitCompletion(queued.id);
    assert.equal(completed.status, "failed");
    assert.match(completed.error ?? "", /bulk fixture failed/);
    assert.ok(completed.completedAt);
    const history = await value.runs.list({ connectorId: value.connector.id });
    assert.equal(history[0]?.status, "failed");
    assert.match(history[0]?.error ?? "", /bulk fixture failed/);
  } finally {
    await cleanup(value);
  }
});

test("validates row limits before sending any Elasticsearch bulk request", async () => {
  const value = await fixture();
  try {
    await writeFile(path.join(value.rootPath, "catalog.csv"), [
      "object_id,ra,dec\n",
      "one,1,2\n",
      "two,3,4\n",
    ].join(""), "utf8");
    await registerAsset(value);

    const queued = await value.executor.submit(value.connector.id, { maxRows: 1 });
    const completed = await value.executor.awaitCompletion(queued.id);
    assert.equal(completed.status, "failed");
    assert.match(completed.error ?? "", /row limit exceeded/);
    assert.equal(value.indexService.batches.length, 0);
  } finally {
    await cleanup(value);
  }
});
