import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ConnectorCredentialStore } from "../src/connector-credentials.js";
import { ConnectorIngestRunCatalog } from "../src/connector-history.js";
import { connectorConfigurationHash, type ConnectorRecord, type ConnectorRegistry } from "../src/connectors.js";
import type { DataAssetRecord, DataAssetRegistrationInput, DataCatalogRegistry } from "../src/data-catalog.js";
import { ConnectorScanCapabilityError, ConnectorScanPreconditionError, connectorScanPath, connectorScanTarget, DataWarehouseDisabledError, dataWarehouseEnabled, FlinkScanService, parseLegacyConnectorScanCommand, validateConnectorSelfScanBody, type FlinkResourceClient } from "../src/flink-ingest.js";
import { SqliteMetadataStore } from "../src/storage/index.js";

const timestamp = "2026-08-13T12:00:00.000Z";

function connector(overrides: Partial<ConnectorRecord> = {}): ConnectorRecord {
  const hasLastCheckOverride = Object.prototype.hasOwnProperty.call(overrides, "lastCheck");
  const record: ConnectorRecord = {
    id: "connector-s3",
    locationKey: "s3://survey/release",
    displayPath: "s3://survey/release",
    name: "Survey connector",
    description: "Fixture",
    kind: "s3",
    config: { endpoint: "https://s3.example", bucket: "survey", prefix: "release" },
    credentialRef: "astro/connector",
    status: "ready",
    createdAt: timestamp,
    updatedAt: timestamp,
    origin: "user",
    ...overrides,
  };
  return {
    ...record,
    lastCheck: hasLastCheckOverride
      ? overrides.lastCheck
      : { status: "ok", checkedAt: timestamp, summary: "ok", configHash: connectorConfigurationHash(record) },
  };
}

function asset(id: string, connectorRecord: ConnectorRecord): DataAssetRecord {
  return {
    id,
    name: id,
    description: "Fixture",
    product: id,
    kind: "catalog",
    modalities: ["catalog"],
    access: { connector: "s3", uri: connectorRecord.locationKey, format: "fits", connectorId: connectorRecord.id },
    connectorIds: [connectorRecord.id],
    connectorLocationKeys: [connectorRecord.locationKey],
    status: "ready",
    projectState: "acquired",
    footprintIds: [],
    origin: "user",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

async function scanFixture(connectorRecord: ConnectorRecord, assets: DataAssetRecord[] = []) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-flink-submit-"));
  const store = new SqliteMetadataStore(path.join(directory, "workspace.sqlite"));
  await store.initialize();
  const runs = new ConnectorIngestRunCatalog(store);
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  const resourceClient: FlinkResourceClient = {
    async request(method, requestPath, body) {
      requests.push({ method, path: requestPath, body });
      if (method === "GET" && requestPath.includes("/flinkingesttasks/")) return { status: 404, ok: false, text: "not found" };
      return { status: method === "POST" ? 201 : 200, ok: true, text: "{}" };
    },
  };
  const catalogAssets = structuredClone(assets);
  const dataCatalog: DataCatalogRegistry = {
    list: async () => structuredClone(catalogAssets),
    register: async (input: DataAssetRegistrationInput) => {
      const now = timestamp;
      const record: DataAssetRecord = {
        id: `user-auto-${catalogAssets.length + 1}`,
        name: input.name,
        description: input.description ?? "",
        surveyId: input.surveyId,
        releaseId: input.releaseId,
        product: input.product ?? input.name,
        kind: input.kind,
        modalities: input.modalities ?? input.tags ?? [],
        tags: input.tags ?? input.modalities ?? [],
        access: { connector: input.connector ?? "metadata", uri: input.sourceUri ?? "asset://fixture", format: input.format ?? "metadata" },
        accesses: input.accesses ?? [{ connector: input.connector ?? "metadata", uri: input.sourceUri ?? "asset://fixture", format: input.format ?? "metadata" }],
        connectorIds: input.connectorIds ?? [],
        connectorLocationKeys: input.connectorLocationKeys ?? [],
        status: input.status ?? "metadata_only",
        projectState: input.projectState ?? "planned",
        projectStates: input.projectStates,
        footprintIds: input.footprintIds ?? [],
        origin: "user",
        createdAt: now,
        updatedAt: now,
      };
      catalogAssets.push(record);
      return structuredClone(record);
    },
  } as unknown as DataCatalogRegistry;
  const service = new FlinkScanService({
    enabled: true,
    connectors: { get: async () => structuredClone(connectorRecord) } as unknown as ConnectorRegistry,
    dataCatalog,
    credentials: { get: async () => ({ accessKeyId: "access", secretAccessKey: "secret", endpoint: "https://s3.example" }) } as unknown as ConnectorCredentialStore,
    runs,
    namespace: "warehouse",
    secretNamespace: "warehouse",
    esUrl: "http://elasticsearch",
    esIndex: "astro_file_index_v1",
    pollMs: 1000,
    resourceClient,
  });
  return { directory, store, runs, requests, service, catalogAssets };
}

test("external Flink polling failures preserve the stored scan state", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-flink-poll-"));
  try {
    const store = new SqliteMetadataStore(path.join(directory, "workspace.sqlite"));
    await store.initialize();
    const runs = new ConnectorIngestRunCatalog(store);
    await runs.initialize();
    const run = await runs.add("s3://example/catalogs", { status: "running", jobId: "external-flink-task" });
    const resourceClient: FlinkResourceClient = {
      async request() {
        return { status: 503, ok: false, text: "warehouse unavailable" };
      },
    };
    const service = new FlinkScanService({
      enabled: true,
      connectors: {} as ConnectorRegistry,
      dataCatalog: {} as DataCatalogRegistry,
      credentials: {} as ConnectorCredentialStore,
      runs,
      namespace: "warehouse",
      secretNamespace: "warehouse",
      esUrl: "",
      esIndex: "astro_file_index_v1",
      pollMs: 1000,
      resourceClient,
    });

    await service.poll();

    const stored = (await runs.list()).find((candidate) => candidate.id === run.id);
    assert.equal(stored?.status, "running");
    assert.equal(stored?.completedAt, undefined);
    assert.equal(stored?.error, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("data warehouse configuration accepts only strict booleans and defaults off", () => {
  assert.equal(dataWarehouseEnabled(undefined), false);
  assert.equal(dataWarehouseEnabled("false"), false);
  assert.equal(dataWarehouseEnabled("true"), true);
  assert.throws(() => dataWarehouseEnabled("TRUE"), /must be true or false/);
  assert.throws(() => dataWarehouseEnabled("1"), /must be true or false/);
});

test("disabled warehouse neither polls nor submits scans", async () => {
  let requests = 0;
  const service = new FlinkScanService({
    enabled: false,
    connectors: {} as ConnectorRegistry,
    dataCatalog: {} as DataCatalogRegistry,
    credentials: {} as ConnectorCredentialStore,
    runs: { list: async () => { throw new Error("run catalog should not be read"); } } as unknown as ConnectorIngestRunCatalog,
    namespace: "warehouse",
    secretNamespace: "warehouse",
    esUrl: "http://warehouse-elasticsearch:9200",
    esIndex: "astro_file_index_v1",
    pollMs: 1000,
    resourceClient: { async request() { requests += 1; return { status: 200, ok: true, text: "" }; } },
  });

  service.start();
  await service.poll();
  await assert.rejects(service.submitScan("connector", { assetId: "asset" }), DataWarehouseDisabledError);
  await assert.rejects(service.submitPilot("connector"), DataWarehouseDisabledError);
  service.stop();
  assert.equal(requests, 0);
});

test("S3 scan paths remain inside the exact configured bucket and prefix", () => {
  const record = connector();
  assert.deepEqual(connectorScanTarget(record), { uri: "s3://survey/release", bucket: "survey", prefix: "release" });
  assert.equal(connectorScanPath(record, "release/catalog.fits"), "s3://survey/release/catalog.fits");
  assert.equal(connectorScanPath(record, "child/catalog.fits"), "s3://survey/release/child/catalog.fits");
  assert.throws(() => connectorScanPath(record, "s3://survey/release-other/catalog.fits"), /connector prefix/);
  assert.throws(() => connectorScanPath(record, "s3://survey.evil/release/catalog.fits"), /connector bucket/);
  assert.throws(() => connectorScanPath(record, "s3://survey/release/%2e%2e/private"), /dot segments/);
});

test("legacy scan route requires an explicit mode and never defaults to pilot", () => {
  assert.throws(() => parseLegacyConnectorScanCommand(undefined), /scan mode is required/);
  assert.throws(() => parseLegacyConnectorScanCommand({}), /scan mode is required/);
  assert.deepEqual(parseLegacyConnectorScanCommand({ mode: "pilot" }), { mode: "pilot" });
  assert.throws(() => parseLegacyConnectorScanCommand({ mode: "scan" }), /assetId is required/);
  assert.deepEqual(parseLegacyConnectorScanCommand({ mode: "scan", assetId: "asset-one" }), {
    mode: "generic",
    input: { assetId: "asset-one" },
  });
});

test("connector self-scan accepts no business body", () => {
  assert.doesNotThrow(() => validateConnectorSelfScanBody(undefined));
  assert.doesNotThrow(() => validateConnectorSelfScanBody({}));
  assert.throws(() => validateConnectorSelfScanBody({ assetId: "client-selected" }), /do not accept a request body/);
  assert.throws(() => validateConnectorSelfScanBody([]), /do not accept a request body/);
});

test("connector self-scan derives its target and snapshots zero, one, or multiple linked user assets", async () => {
  for (const assetIds of [[], ["asset-one"], ["asset-two", "asset-one"]]) {
    const record = connector();
    const builtin = { ...asset("builtin-linked", record), origin: "builtin" as const };
    const fixture = await scanFixture(record, [...assetIds.map((id) => asset(id, record)), builtin]);
    try {
      const run = await fixture.service.submitConnectorScan(record.id, `key-${assetIds.length}`);
      assert.equal(run.connectorId, record.id);
      assert.equal(run.connectorKind, "s3");
      assert.equal(run.executor, "flink-ingest");
      assert.deepEqual(run.target, { uri: "s3://survey/release", bucket: "survey", prefix: "release" });
      assert.deepEqual(run.assetIds, assetIds.length ? [...assetIds].sort() : ["user-auto-2"]);
      const token = run.batchId?.replace("workspace-connector-scan-", "");
      assert.ok(token);
      assert.match(run.jobId ?? "", new RegExp(`^astro-connector-scan-.*-${token}$`));
      assert.ok((run.jobId?.length ?? 64) <= 63);
      const task = fixture.requests.find((request) => request.path.includes("/flinkingesttasks"));
      assert.ok(task);
      const body = task.body as { spec?: { paths?: string[]; extraEnvs?: Record<string, unknown> } };
      assert.deepEqual(body.spec?.paths, ["s3://survey/release"]);
      assert.equal(body.spec?.extraEnvs?.esHost, "elasticsearch");
      assert.equal(body.spec?.extraEnvs?.datasetIndex, "astro_file_index_v1");
      assert.deepEqual(body.spec?.extraEnvs?.others, {
        ES_SCHEMA: "http",
        ES_DATASET_GROUP_INDEX: "astro_object_index_v1",
        ES_INGEST_JOB_INFO_INDEX: "astro_coverage_index_v1",
      });
    } finally {
      await fixture.store.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  }
});

test("connector self-scan registers one user asset when no asset is linked", async () => {
  const record = connector({ surveyId: "euclid", releaseId: "euclid-q1", name: "Euclid Q1 MER Catalog" });
  const fixture = await scanFixture(record);
  try {
    const run = await fixture.service.submitConnectorScan(record.id, "auto-register");
    assert.deepEqual(run.assetIds, ["user-auto-1"]);
    assert.equal(fixture.catalogAssets.length, 1);
    assert.deepEqual(fixture.catalogAssets[0], {
      id: "user-auto-1",
      name: "Euclid Q1 MER Catalog",
      description: "Scanned catalog from s3://survey/release. Created automatically when the connector was scanned.",
      surveyId: "euclid",
      releaseId: "euclid-q1",
      product: "Euclid Q1 MER Catalog",
      kind: "catalog",
      modalities: ["catalog"],
      tags: ["catalog"],
      access: { connector: "s3", uri: "s3://survey/release", format: "directory" },
      accesses: [{ connector: "s3", uri: "s3://survey/release", format: "directory" }],
      connectorIds: ["connector-s3"],
      connectorLocationKeys: ["s3://survey/release"],
      status: "ready",
      projectState: "acquired",
      projectStates: undefined,
      footprintIds: [],
      origin: "user",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const retry = await fixture.service.submitConnectorScan(record.id, "auto-register-retry");
    assert.deepEqual(retry.assetIds, ["user-auto-1"]);
    assert.equal(fixture.catalogAssets.length, 1);
  } finally {
    await fixture.store.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("connector self-scan idempotency returns one run and submits one task", async () => {
  const record = connector();
  const fixture = await scanFixture(record, [asset("asset-one", record)]);
  try {
    const first = await fixture.service.submitConnectorScan(record.id, "same-request");
    const retry = await fixture.service.submitConnectorScan(record.id, "same-request");
    assert.equal(retry.id, first.id);
    assert.equal((await fixture.runs.list()).length, 1);
    assert.equal(fixture.requests.filter((request) => request.path.includes("/flinkingesttasks") && request.method === "POST").length, 1);
  } finally {
    await fixture.store.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("disabled and stale connectors are rejected before run creation", async () => {
  for (const record of [
    connector({ status: "disabled" }),
    connector({ config: { endpoint: "https://s3.example", bucket: "survey", prefix: "edited" }, locationKey: "s3://survey/edited", lastCheck: { status: "ok", checkedAt: timestamp, summary: "old", configHash: connectorConfigurationHash(connector()) } }),
  ]) {
    const fixture = await scanFixture(record);
    try {
      await assert.rejects(fixture.service.submitConnectorScan(record.id), ConnectorScanPreconditionError);
      assert.deepEqual(await fixture.runs.list(), []);
      assert.equal(fixture.requests.length, 0);
    } finally {
      await fixture.store.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  }
});

test("local and JDBC connector scans report unsupported capability without a run", async () => {
  for (const record of [
    connector({ kind: "local", config: { rootPath: "/data" }, locationKey: "local:///data", displayPath: "/data", credentialRef: undefined }),
    connector({ kind: "jdbc", config: { url: "jdbc:postgresql://db/catalog" }, locationKey: "jdbc:postgresql://db/catalog|database=|schema=", displayPath: "jdbc:postgresql://db/catalog", credentialRef: undefined }),
  ]) {
    const fixture = await scanFixture(record);
    try {
      await assert.rejects(fixture.service.submitConnectorScan(record.id), ConnectorScanCapabilityError);
      assert.deepEqual(await fixture.runs.list(), []);
      assert.equal(fixture.requests.length, 0);
    } finally {
      await fixture.store.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  }
});
