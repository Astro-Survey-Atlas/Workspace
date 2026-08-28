import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MemoryConnectorCredentialStore } from "../src/connector-credentials.js";
import { ConnectorIngestRunCatalog } from "../src/connector-history.js";
import { connectorConfigurationHash, type ConnectorRecord, type ConnectorRegistry } from "../src/connectors.js";
import type { DataCatalogRegistry } from "../src/data-catalog.js";
import { SqliteMetadataStore } from "../src/storage/index.js";
import type { UserMocArtifact, UserMocArtifactContext, UserMocArtifactStore } from "../src/user-moc-artifacts.js";
import { buildWorkspaceScanRequest, dataWarehouseEnabled, DEFAULT_S3_ENDPOINT, WarehouseScanService, WORKSPACE_TRACK_LABELS } from "../src/warehouse-scan.js";
import type { CoverageJobSnapshot } from "../src/coverage-jobs.js";
import type { DataAssetRecord } from "../src/data-catalog.js";

const connector: ConnectorRecord = {
  id: "connector-user-1",
  locationKey: "s3://user-data/catalogs",
  displayPath: "https://objects.example/user-data/catalogs",
  name: "User object storage",
  description: "Test connector",
  kind: "s3",
  config: { endpoint: "https://objects.example", bucket: "user-data", prefix: "catalogs" },
  status: "ready",
  origin: "user",
  createdAt: "2026-08-26T00:00:00.000Z",
  updatedAt: "2026-08-26T00:00:00.000Z",
};

const asset: DataAssetRecord = {
  id: "user-asset-1",
  name: "My catalogue",
  description: "Test asset",
  surveyId: "my-survey",
  releaseId: "my-release",
  product: "my-product",
  kind: "catalog",
  modalities: ["catalog"],
  access: { connector: "s3", uri: "s3://user-data/catalogs", format: "csv", connectorId: connector.id },
  connectorIds: [connector.id],
  connectorLocationKeys: [connector.locationKey],
  status: "ready",
  projectState: "acquired",
  footprintIds: [],
  origin: "user",
  createdAt: "2026-08-26T00:00:00.000Z",
  updatedAt: "2026-08-26T00:00:00.000Z",
};

function request(coverage?: CoverageJobSnapshot, selectedConnector: ConnectorRecord = connector): Record<string, unknown> {
  return buildWorkspaceScanRequest({
    connector: selectedConnector,
    asset,
    input: { assetId: asset.id, path: "catalogs/objects.csv", allowedSuffixes: [".csv"] },
    ...(coverage ? { coverage } : {}),
    taskName: "workspace-scan-user-asset-1-ab12cd34",
    batchId: "workspace-scan-ab12cd34",
    secretName: "workspace-scan-user-asset-1-ab12cd34",
    namespace: "astro-data-workspace",
    warehouseEsUrl: "http://warehouse-es:9200",
    evidenceClaimName: "workspace-evidence",
    evidenceMountPath: "/var/lib/atlas-evidence",
    scannerImage: "scanner:1.0.0",
  });
}

function requestWithWarehouseEndpoint(warehouseEsUrl: string): Record<string, unknown> {
  return buildWorkspaceScanRequest({
    connector,
    asset,
    input: { assetId: asset.id, path: "catalogs/objects.csv", allowedSuffixes: [".csv"] },
    taskName: "workspace-scan-user-asset-1-ab12cd34",
    batchId: "workspace-scan-ab12cd34",
    secretName: "workspace-scan-user-asset-1-ab12cd34",
    namespace: "astro-data-workspace",
    warehouseEsUrl,
    evidenceClaimName: "workspace-evidence",
    evidenceMountPath: "/var/lib/atlas-evidence",
    scannerImage: "scanner:1.0.0",
  });
}

test("builds a ScanRequest v2 with distinct Workspace tracking labels", () => {
  const body = request({
    surveyId: "my-survey",
    releaseId: "my-release",
    product: "my-product",
    mode: "catalog-radec",
    coordinateFrame: "ICRS",
    coordinateUnits: "deg",
    coverageRole: "object_presence",
    dataOrigin: "catalog",
    sourceTier: "user_file_derived",
    maxOrder: 10,
    queryOrder: 8,
    previewOrder: 4,
    raColumn: "ra",
    decColumn: "dec",
  });
  assert.equal(body.apiVersion, "atlas.zhejianglab.org/v1alpha1");
  assert.equal(body.kind, "ScanRequest");
  const metadata = body.metadata as { namespace: string; labels: Record<string, string> };
  assert.equal(metadata.namespace, "astro-data-workspace");
  assert.equal(metadata.labels[WORKSPACE_TRACK_LABELS.caller], "workspace");
  assert.equal(metadata.labels[WORKSPACE_TRACK_LABELS.taskKind], "user-coverage");
  assert.equal(metadata.labels[WORKSPACE_TRACK_LABELS.asset], asset.id);
  assert.equal(metadata.labels[WORKSPACE_TRACK_LABELS.connector], connector.id);
  assert.equal(metadata.labels[WORKSPACE_TRACK_LABELS.batch], "workspace-scan-ab12cd34");
  assert.equal(metadata.labels["astro.zhejianglab.org/atlas-task-kind"], "user_coverage");

  const spec = body.spec as Record<string, any>;
  const plan = spec.plan as Record<string, any>;
  assert.equal(plan.version, 2);
  assert.equal(plan.layer.layerId, "workspace-user-asset-1");
  assert.equal(plan.layer.coverageRole, "occupancy");
  assert.equal(plan.extraction.mode, "catalog-radec");
  assert.equal(plan.extraction.catalog.raColumn, "ra");
  assert.equal(plan.sink.connector.endpoint, "http://warehouse-es:9200");
  assert.equal(plan.evidence.outputPath, "/var/lib/atlas-evidence/workspace-scan-ab12cd34");
  assert.deepEqual(spec.credentials, {
    source: { secretName: "workspace-scan-user-asset-1-ab12cd34", accessKeyKey: "access-key", secretKeyKey: "secret-key" },
    sink: {},
  });
  assert.doesNotMatch(JSON.stringify(body), /secret-value|access-value/);
});

test("keeps Warehouse endpoint credentials in the temporary Secret", () => {
  assert.throws(() => requestWithWarehouseEndpoint("https://super-secret-user:super-secret-pass@warehouse-es:9200"), /credentials require a secret binding/);
  const body = buildWorkspaceScanRequest({
    connector,
    asset,
    input: { assetId: asset.id, path: "catalogs/objects.csv", allowedSuffixes: [".csv"] },
    taskName: "workspace-scan-user-asset-1-ab12cd34",
    batchId: "workspace-scan-ab12cd34",
    secretName: "workspace-scan-user-asset-1-ab12cd34",
    namespace: "astro-data-workspace",
    warehouseEsUrl: "https://super-secret-user:super-secret-pass@warehouse-es:9200",
    warehouseSinkCredentials: {
      secretName: "workspace-scan-user-asset-1-ab12cd34",
      usernameKey: "warehouse-username",
      passwordKey: "warehouse-password",
    },
    evidenceClaimName: "workspace-evidence",
    evidenceMountPath: "/var/lib/atlas-evidence",
    scannerImage: "scanner:1.0.0",
  });
  const serialized = JSON.stringify(body);
  assert.doesNotMatch(serialized, /super-secret-user|super-secret-pass/);
  const plan = (body.spec as Record<string, any>).plan as Record<string, any>;
  assert.equal(plan.sink.connector.endpoint, "https://warehouse-es:9200");
  assert.deepEqual(plan.sink.connector.credentialRef, { usernameEnv: "ATLAS_WAREHOUSE_USERNAME", passwordEnv: "ATLAS_WAREHOUSE_PASSWORD" });
  assert.deepEqual((body.spec as Record<string, any>).credentials.sink, {
    secretName: "workspace-scan-user-asset-1-ab12cd34",
    usernameKey: "warehouse-username",
    passwordKey: "warehouse-password",
  });
});

test("binds the generated scan Secret when submitting an authenticated Warehouse request", async () => {
  const fixture = await warehouseFixture(["SUBMITTED"], {}, "https://warehouse-user:warehouse-pass@warehouse-es:9200");
  try {
    const run = await fixture.service.submitConnectorScan(fixture.connector.id, "authenticated-scan");
    const scanRequest = fixture.requests.find((candidate) => candidate.method === "POST" && candidate.path.endsWith("/scanrequests"));
    assert.ok(scanRequest);
    const spec = (scanRequest.body as Record<string, any>).spec as Record<string, any>;
    assert.equal(spec.credentials.sink.secretName, run.secretName);
    assert.equal(spec.credentials.sink.usernameKey, "warehouse-username");
    assert.equal(spec.credentials.sink.passwordKey, "warehouse-password");
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("ordinary Workspace scans use a separate task kind and preserve explicit source mode", () => {
  const body = request();
  const labels = (body.metadata as { labels: Record<string, string> }).labels;
  assert.equal(labels[WORKSPACE_TRACK_LABELS.caller], "workspace");
  assert.equal(labels[WORKSPACE_TRACK_LABELS.taskKind], "user-scan");
  const plan = (body.spec as Record<string, any>).plan as Record<string, any>;
  assert.equal(plan.layer.coverageRole, "occupancy");
  assert.equal(plan.extraction.mode, "fits-header-position");
});

test("rejects catalog footprint claims that Warehouse v2 cannot represent", () => {
  assert.throws(() => request({
    surveyId: "my-survey",
    releaseId: "my-release",
    product: "my-product",
    mode: "catalog-radec",
    coordinateFrame: "ICRS",
    coordinateUnits: "deg",
    coverageRole: "footprint_extent",
    dataOrigin: "catalog",
    sourceTier: "user_file_derived",
    maxOrder: 10,
    queryOrder: 8,
    previewOrder: 4,
    raColumn: "ra",
    decColumn: "dec",
  }), /catalog-radec extraction requires coverageRole=object_presence/);
});

test("ordinary HEALPix scans require an explicit source order", () => {
  assert.throws(() => buildWorkspaceScanRequest({
    connector,
    asset,
    input: {
      assetId: asset.id,
      path: "catalogs/objects.csv",
      allowedSuffixes: [".csv"],
      spatial: { mode: "healpix", healpixColumn: "hpix" },
    },
    taskName: "workspace-scan-user-asset-1-ab12cd34",
    batchId: "workspace-scan-ab12cd34",
    secretName: "workspace-scan-user-asset-1-ab12cd34",
    namespace: "astro-data-workspace",
    warehouseEsUrl: "http://warehouse-es:9200",
    evidenceClaimName: "workspace-evidence",
    evidenceMountPath: "/var/lib/atlas-evidence",
    scannerImage: "scanner:1.0.0",
  }), /requires an explicit healpixOrder/);

  const body = buildWorkspaceScanRequest({
    connector,
    asset,
    input: {
      assetId: asset.id,
      path: "catalogs/objects.csv",
      allowedSuffixes: [".csv"],
      spatial: { mode: "healpix", healpixColumn: "hpix", healpixOrder: 4 },
    },
    taskName: "workspace-scan-user-asset-1-ab12cd34",
    batchId: "workspace-scan-ab12cd34",
    secretName: "workspace-scan-user-asset-1-ab12cd34",
    namespace: "astro-data-workspace",
    warehouseEsUrl: "http://warehouse-es:9200",
    evidenceClaimName: "workspace-evidence",
    evidenceMountPath: "/var/lib/atlas-evidence",
    scannerImage: "scanner:1.0.0",
  });
  const plan = (body.spec as Record<string, any>).plan as Record<string, any>;
  assert.deepEqual(plan.extraction, { mode: "catalog-healpix", catalog: { healpixColumn: "hpix", healpixOrder: 4 } });
});

test("emits an explicit AWS endpoint when an S3 connector uses the default service", () => {
  const body = request(undefined, {
    ...connector,
    config: { bucket: "user-data", prefix: "catalogs" },
    displayPath: "s3://user-data/catalogs",
  });
  const plan = (body.spec as Record<string, any>).plan as Record<string, any>;
  assert.equal(plan.source.connector.endpoint, DEFAULT_S3_ENDPOINT);
});

test("passes an S3 connector region through ScanPlan v2", () => {
  const body = request(undefined, {
    ...connector,
    config: { ...connector.config, region: "cn-hangzhou" },
  });
  const plan = (body.spec as Record<string, any>).plan as Record<string, any>;
  assert.equal(plan.source.connector.region, "cn-hangzhou");
});

test("does not silently drop a basename filter unsupported by ScanPlan v2", () => {
  assert.throws(() => request({
    surveyId: "my-survey",
    releaseId: "my-release",
    product: "my-product",
    mode: "catalog-radec",
    coordinateFrame: "ICRS",
    coordinateUnits: "deg",
    coverageRole: "object_presence",
    dataOrigin: "catalog",
    sourceTier: "user_file_derived",
    maxOrder: 10,
    queryOrder: 8,
    previewOrder: 4,
    raColumn: "ra",
    decColumn: "dec",
    fileNamePattern: "^objects-.*\\.csv$",
  }), /fileNamePattern.*not supported.*ScanPlan v2/);
});

test("the Warehouse integration flag accepts only strict booleans and defaults off", () => {
  assert.equal(dataWarehouseEnabled(undefined), false);
  assert.equal(dataWarehouseEnabled("false"), false);
  assert.equal(dataWarehouseEnabled("true"), true);
  assert.throws(() => dataWarehouseEnabled("1"), /must be true or false/);
});

test("disabled Warehouse submissions fail before reading or registering local metadata", async () => {
  let connectorReads = 0;
  let assetReads = 0;
  let assetRegistrations = 0;
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-disabled-warehouse-"));
  const store = new SqliteMetadataStore(path.join(directory, "workspace.sqlite"));
  await store.initialize();
  const runs = new ConnectorIngestRunCatalog(store);
  const service = new WarehouseScanService({
    enabled: false,
    connectors: {
      get: async () => { connectorReads += 1; throw new Error("connector must not be read"); },
      list: async () => [],
    } as unknown as ConnectorRegistry,
    dataCatalog: {
      get: async () => { assetReads += 1; throw new Error("asset must not be read"); },
      list: async () => [],
      register: async () => { assetRegistrations += 1; throw new Error("asset must not be registered"); },
    } as unknown as DataCatalogRegistry,
    credentials: new MemoryConnectorCredentialStore(),
    runs,
    namespace: "astro-data-workspace",
    warehouseEsUrl: "http://warehouse-es:9200",
    pollMs: 1000,
  });
  try {
    await assert.rejects(service.submitConnectorScan("connector-disabled"), (error: unknown) => error instanceof Error && error.name === "DataWarehouseDisabledError");
    await assert.rejects(service.submitRemoteAssetScan("survey", {
      connectorId: "connector-disabled",
      assetId: "asset-disabled",
      product: "catalog",
      mode: "catalog-radec",
      coordinateFrame: "ICRS",
      coordinateUnits: "deg",
      coverageRole: "object_presence",
      dataOrigin: "catalog",
      sourceTier: "user_file_derived",
      maxOrder: 10,
      queryOrder: 8,
      previewOrder: 4,
      raColumn: "ra",
      decColumn: "dec",
    }), (error: unknown) => error instanceof Error && error.name === "DataWarehouseDisabledError");
    assert.equal(connectorReads, 0);
    assert.equal(assetReads, 0);
    assert.equal(assetRegistrations, 0);
    assert.deepEqual(await runs.list(), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

interface WarehouseFixture {
  directory: string;
  runs: ConnectorIngestRunCatalog;
  service: WarehouseScanService;
  requests: Array<{ method: string; path: string; body?: unknown }>;
  pendingContexts: UserMocArtifactContext[];
  imported: Array<{ directory: string; context: UserMocArtifactContext }>;
  connector: ConnectorRecord;
  asset: DataAssetRecord;
}

async function warehouseFixture(
  statuses: Array<"SUBMITTED" | "RUNNING" | "SUCCEEDED"> = ["SUBMITTED", "RUNNING", "SUCCEEDED"],
  summaryOverrides: Record<string, unknown> = {},
  warehouseEsUrl = "http://warehouse-es:9200",
  assetOrigin: DataAssetRecord["origin"] = "user",
  additionalAssets: DataAssetRecord[] = [],
): Promise<WarehouseFixture> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-warehouse-scan-service-"));
  const store = new SqliteMetadataStore(path.join(directory, "workspace.sqlite"));
  await store.initialize();
  const runs = new ConnectorIngestRunCatalog(store);
  const credentialStore = new MemoryConnectorCredentialStore();
  const credentialRef = credentialStore.managedReference("connector-user-1");
  const connectorRecord: ConnectorRecord = {
    ...connector,
    credentialRef,
    lastCheck: { status: "ok", checkedAt: connector.updatedAt, summary: "ok", configHash: connectorConfigurationHash({ ...connector, credentialRef }) },
  };
  await credentialStore.put(credentialRef, { accessKeyId: "access", secretAccessKey: "secret", endpoint: "https://objects.example" });
  const assetRecord = { ...structuredClone(asset), origin: assetOrigin };
  const assetRecords = [assetRecord, ...additionalAssets.map((entry) => structuredClone(entry))];
  const dataCatalog = {
    get: async (id: string) => {
      const record = assetRecords.find((candidate) => candidate.id === id);
      if (!record) throw new Error(`Data asset not found: ${id}`);
      return structuredClone(record);
    },
    list: async () => assetRecords.map((entry) => structuredClone(entry)),
  } as unknown as DataCatalogRegistry;
  const connectors = {
    get: async (id: string) => {
      if (id !== connectorRecord.id) throw new Error(`Connector not found: ${id}`);
      return structuredClone(connectorRecord);
    },
    list: async () => [structuredClone(connectorRecord)],
  } as unknown as ConnectorRegistry;
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  const pendingContexts: UserMocArtifactContext[] = [];
  const imported: Array<{ directory: string; context: UserMocArtifactContext }> = [];
  const artifactStore = {
    createPending: async (context: UserMocArtifactContext): Promise<UserMocArtifact> => {
      pendingContexts.push(structuredClone(context));
      return { id: `${context.layerId}-${context.scanRunId}`, layerId: context.layerId, scanRunId: context.scanRunId, status: "pending", availableOrders: context.availableOrders ?? [], precision: context.precision ?? "exact", files: [], createdAt: connector.updatedAt, updatedAt: connector.updatedAt };
    },
    importEvidence: async (evidenceDirectory: string, context: UserMocArtifactContext): Promise<UserMocArtifact> => {
      imported.push({ directory: evidenceDirectory, context: structuredClone(context) });
      return { id: `${context.layerId}-${context.scanRunId}`, layerId: context.layerId, scanRunId: context.scanRunId, status: "ready", availableOrders: [8], maxOrder: 10, precision: "exact", coverageRole: context.coverageRole, sourceSnapshotSha256: context.sourceSnapshotSha256, files: [], createdAt: connector.updatedAt, updatedAt: connector.updatedAt };
    },
    fail: async (context: UserMocArtifactContext, error: unknown): Promise<UserMocArtifact> => ({ id: `${context.layerId}-${context.scanRunId}`, layerId: context.layerId, scanRunId: context.scanRunId, status: "failed", availableOrders: [], precision: context.precision ?? "exact", error: error instanceof Error ? error.message : String(error), files: [], createdAt: connector.updatedAt, updatedAt: connector.updatedAt }),
  } as unknown as UserMocArtifactStore;
  let submittedPlan: Record<string, any> | undefined;
  let stateIndex = 0;
  const resourceClient = {
    async request<T>(method: string, requestPath: string, body?: unknown): Promise<{ status: number; ok: boolean; value?: T; text: string }> {
      requests.push({ method, path: requestPath, body });
      if (method === "GET" && requestPath.includes("/secrets/")) return { status: 404, ok: false, text: "not found" };
      if (method === "POST" && requestPath.endsWith("/scanrequests")) {
        submittedPlan = ((body as Record<string, any>).spec as Record<string, any>).plan;
        return { status: 201, ok: true, text: "{}" };
      }
      if (method === "GET" && requestPath.includes("/scanrequests/")) {
        const phase = statuses[Math.min(stateIndex++, statuses.length - 1)]!;
        const summary = phase === "SUCCEEDED"
          ? { discoveredFileCount: 2, coverageRecordCount: 3, sourceSnapshotSha256: "a".repeat(64), evidencePath: `${directory}/evidence`, availableOrders: [8], scanRunId: submittedPlan?.scanRunId, layerId: submittedPlan?.layer?.layerId, ...summaryOverrides }
          : {};
        return { status: 200, ok: true, value: { status: { phase, summary } } as T, text: JSON.stringify({ status: { phase, summary } }) };
      }
      if (method === "DELETE") return { status: 200, ok: true, text: "{}" };
      if (method === "POST" || method === "PUT") return { status: 201, ok: true, text: "{}" };
      return { status: 200, ok: true, text: "{}" };
    },
  };
  const service = new WarehouseScanService({
    enabled: true,
    connectors,
    dataCatalog,
    credentials: credentialStore,
    runs,
    namespace: "astro-data-workspace",
    warehouseEsUrl,
    pollMs: 1000,
    evidenceMountPath: directory,
    artifacts: artifactStore,
    resourceClient,
  });
  return { directory, runs, service, requests, pendingContexts, imported, connector: connectorRecord, asset: assetRecord };
}

function warehouseCoverage(): CoverageJobSnapshot {
  return {
    surveyId: "my-survey",
    releaseId: "my-release",
    product: "my-product",
    mode: "catalog-radec",
    coordinateFrame: "ICRS",
    coordinateUnits: "deg",
    coverageRole: "object_presence",
    dataOrigin: "catalog",
    sourceTier: "user_file_derived",
    maxOrder: 10,
    queryOrder: 8,
    previewOrder: 4,
    raColumn: "ra",
    decColumn: "dec",
  };
}

test("submits a namespaced Workspace ScanRequest, polls status, and imports completed evidence", async () => {
  const fixture = await warehouseFixture();
  try {
    const run = await fixture.service.submitScan(fixture.connector.id, { assetId: fixture.asset.id, path: "catalogs/objects.csv", allowedSuffixes: [".csv"], coverage: warehouseCoverage() }, "service-idempotency");
    assert.equal(run.status, "running");
    assert.deepEqual(run.availableOrders, []);
    assert.equal(run.mocStatus, "pending");
    assert.equal(fixture.pendingContexts[0]?.availableOrders?.length, 0);
    const secretRequest = fixture.requests.find((request) => request.method === "POST" && request.path.endsWith("/secrets"));
    const secretLabels = ((secretRequest?.body as Record<string, any>)?.metadata?.labels ?? {}) as Record<string, string>;
    assert.equal(secretLabels[WORKSPACE_TRACK_LABELS.caller], "workspace");
    assert.equal(secretLabels[WORKSPACE_TRACK_LABELS.batch], run.batchId);
    const scanRequest = fixture.requests.find((request) => request.method === "POST" && request.path.endsWith("/scanrequests"));
    const scanLabels = ((scanRequest?.body as Record<string, any>)?.metadata?.labels ?? {}) as Record<string, string>;
    assert.equal(scanLabels[WORKSPACE_TRACK_LABELS.caller], "workspace");
    assert.equal(scanLabels[WORKSPACE_TRACK_LABELS.taskKind], "user-coverage");
    await fixture.service.poll();
    assert.equal((await fixture.runs.list()).find((candidate) => candidate.id === run.id)?.status, "running");
    await fixture.service.poll();
    const completed = (await fixture.runs.list()).find((candidate) => candidate.id === run.id);
    assert.ok(completed);
    assert.equal(completed.status, "succeeded");
    assert.equal(completed.fileCount, 2);
    assert.equal(completed.documentCount, 3);
    assert.equal(completed.sourceSnapshotSha256, "a".repeat(64));
    assert.deepEqual(completed.availableOrders, [8]);
    assert.equal(completed.mocStatus, "ready");
    assert.equal(fixture.imported.length, 1);
    assert.equal(fixture.imported[0]?.context.evidenceScanRunId, run.batchId);
    assert.equal(fixture.imported[0]?.context.layerId, `workspace-${fixture.asset.id}`);
    assert.equal(fixture.imported[0]?.directory, completed.evidencePath);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("submits a direct Connector self-scan through the Workspace Warehouse contract", async () => {
  const fixture = await warehouseFixture(["SUBMITTED"]);
  try {
    const run = await fixture.service.submitConnectorScan(fixture.connector.id, "connector-self-scan");

    assert.equal(run.status, "running");
    assert.equal(run.backend, "warehouse");
    assert.equal(run.executor, "warehouse-scan");
    assert.equal(run.taskKind, "user_scan");
    assert.equal(run.assetId, fixture.asset.id);
    assert.equal(run.warehouseLayerId, `workspace-${fixture.asset.id}`);
    assert.match(run.batchId ?? "", /^workspace-scan-/);
    assert.match(run.jobId ?? "", /^workspace-scan-user-asset-1-/);
    assert.match(run.secretName ?? "", /^workspace-scan-user-asset-1-/);

    const secretRequest = fixture.requests.find((request) => request.method === "POST" && request.path.endsWith("/secrets"));
    assert.ok(secretRequest);
    assert.equal(secretRequest.path, "/api/v1/namespaces/astro-data-workspace/secrets");
    const secretBody = secretRequest.body as Record<string, any>;
    assert.equal(secretBody.metadata.namespace, "astro-data-workspace");
    assert.equal(secretBody.metadata.labels[WORKSPACE_TRACK_LABELS.caller], "workspace");
    assert.equal(secretBody.metadata.labels[WORKSPACE_TRACK_LABELS.batch], run.batchId);
    assert.deepEqual(secretBody.stringData, {
      "access-key": "access",
      "secret-key": "secret",
      "s3-endpoint": "https://objects.example",
    });

    const scanRequest = fixture.requests.find((request) => request.method === "POST" && request.path.endsWith("/scanrequests"));
    assert.ok(scanRequest);
    assert.equal(scanRequest.path, "/apis/atlas.zhejianglab.org/v1alpha1/namespaces/astro-data-workspace/scanrequests");
    const scanBody = scanRequest.body as Record<string, any>;
    assert.equal(scanBody.apiVersion, "atlas.zhejianglab.org/v1alpha1");
    assert.equal(scanBody.kind, "ScanRequest");
    assert.equal(scanBody.metadata.namespace, "astro-data-workspace");
    assert.equal(scanBody.metadata.name, run.jobId);
    assert.equal(scanBody.metadata.labels[WORKSPACE_TRACK_LABELS.caller], "workspace");
    assert.equal(scanBody.metadata.labels[WORKSPACE_TRACK_LABELS.taskKind], "user-scan");
    assert.equal(scanBody.metadata.labels[WORKSPACE_TRACK_LABELS.asset], fixture.asset.id);
    assert.equal(scanBody.metadata.labels[WORKSPACE_TRACK_LABELS.connector], fixture.connector.id);
    assert.equal(scanBody.metadata.labels[WORKSPACE_TRACK_LABELS.batch], run.batchId);

    const spec = scanBody.spec as Record<string, any>;
    assert.equal(spec.scanner.image, "astro-atlas-scanner:latest");
    assert.deepEqual(spec.scanner.evidence, { claimName: "workspace-evidence", mountPath: fixture.directory });
    assert.deepEqual(spec.credentials, {
      source: { secretName: run.secretName, accessKeyKey: "access-key", secretKeyKey: "secret-key" },
      sink: {},
    });
    const plan = spec.plan as Record<string, any>;
    assert.equal(plan.version, 2);
    assert.equal(plan.scanRunId, run.batchId);
    assert.deepEqual(plan.layer, {
      layerId: `workspace-${fixture.asset.id}`,
      surveyId: "my-survey",
      releaseId: "my-release",
      productId: "my-product",
      modality: "catalog",
      coverageRole: "occupancy",
      entrypoint: fixture.asset.access.uri,
    });
    assert.deepEqual(plan.source.location, { bucket: "user-data", prefix: "catalogs" });
    assert.equal(plan.source.connector.endpoint, "https://objects.example");
    assert.deepEqual(plan.filters, { includeSuffixes: [] });
    assert.deepEqual(plan.extraction, { mode: "fits-header-position", outputOrder: 8 });
    assert.equal(plan.sink.connector.endpoint, "http://warehouse-es:9200");
    assert.deepEqual(plan.sink.connector.credentialRef, {});
    assert.equal(plan.evidence.outputPath, `${fixture.directory}/${run.batchId}`);
    assert.doesNotMatch(JSON.stringify(scanBody), /"access-key":"access"|"secret-key":"secret"/);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("normalizes the historical wildcard to Warehouse's automatic file-type filter", () => {
  const body = buildWorkspaceScanRequest({
    connector,
    asset,
    input: { assetId: asset.id, path: "catalogs", allowedSuffixes: ["*"] },
    taskName: "workspace-scan-user-asset-1-ab12cd34",
    batchId: "workspace-scan-ab12cd34",
    secretName: "workspace-scan-user-asset-1-ab12cd34",
    namespace: "astro-data-workspace",
    warehouseEsUrl: "http://warehouse-es:9200",
    evidenceClaimName: "workspace-evidence",
    evidenceMountPath: "/var/lib/atlas-evidence",
    scannerImage: "scanner:1.0.0",
  });
  const plan = (body.spec as Record<string, any>).plan as Record<string, any>;
  assert.deepEqual(plan.filters, { includeSuffixes: [] });
  assert.throws(() => buildWorkspaceScanRequest({
    connector,
    asset,
    input: { assetId: asset.id, path: "catalogs", allowedSuffixes: ["*.csv"] },
    taskName: "workspace-scan-user-asset-1-ab12cd34",
    batchId: "workspace-scan-ab12cd34",
    secretName: "workspace-scan-user-asset-1-ab12cd34",
    namespace: "astro-data-workspace",
    warehouseEsUrl: "http://warehouse-es:9200",
    evidenceClaimName: "workspace-evidence",
    evidenceMountPath: "/var/lib/atlas-evidence",
    scannerImage: "scanner:1.0.0",
  }), /literal suffixes/);
});

test("rejects an ambiguous Connector self-scan instead of choosing the first asset", async () => {
  const secondAsset: DataAssetRecord = {
    ...structuredClone(asset),
    id: "user-asset-2",
    name: "My second catalogue",
    product: "my-second-product",
  };
  const fixture = await warehouseFixture(["SUBMITTED"], {}, "http://warehouse-es:9200", "user", [secondAsset]);
  try {
    await assert.rejects(
      fixture.service.submitConnectorScan(fixture.connector.id, "ambiguous-self-scan"),
      (error: unknown) => error instanceof Error
        && error.name === "ConnectorScanPreconditionError"
        && /ambiguous.*multiple user assets/.test(error.message),
    );
    assert.deepEqual(await fixture.runs.list(), []);
    assert.equal(fixture.requests.some((request) => request.path.endsWith("/scanrequests")), false);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("rejects non-user assets before creating a Warehouse run", async () => {
  const fixture = await warehouseFixture(["SUBMITTED"], {}, "http://warehouse-es:9200", "builtin");
  try {
    await assert.rejects(
      fixture.service.submitScan(fixture.connector.id, { assetId: fixture.asset.id, allowedSuffixes: [".csv"] }),
      /Only user assets can start an optional remote scan/,
    );
    assert.deepEqual(await fixture.runs.list(), []);
    assert.equal(fixture.requests.length, 0);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("keeps authenticated Warehouse endpoints out of the submitted ScanRequest", async () => {
  const fixture = await warehouseFixture(["SUBMITTED"], {}, "https://super-secret-user:super-secret-pass@warehouse-es:9200");
  try {
    await fixture.service.submitScan(fixture.connector.id, { assetId: fixture.asset.id, allowedSuffixes: [".csv"] });
    const secretRequest = fixture.requests.find((request) => request.method === "POST" && request.path.endsWith("/secrets"));
    const secretData = (secretRequest?.body as Record<string, any>)?.stringData as Record<string, string>;
    assert.equal(secretData["warehouse-username"], "super-secret-user");
    assert.equal(secretData["warehouse-password"], "super-secret-pass");
    const scanRequest = fixture.requests.find((request) => request.method === "POST" && request.path.endsWith("/scanrequests"));
    const serialized = JSON.stringify(scanRequest?.body);
    assert.doesNotMatch(serialized, /super-secret-user|super-secret-pass/);
    const plan = ((scanRequest?.body as Record<string, any>)?.spec as Record<string, any>).plan as Record<string, any>;
    assert.equal(plan.sink.connector.endpoint, "https://warehouse-es:9200");
    assert.deepEqual(plan.sink.connector.credentialRef, { usernameEnv: "ATLAS_WAREHOUSE_USERNAME", passwordEnv: "ATLAS_WAREHOUSE_PASSWORD" });
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("rejects a successful Warehouse status whose summary belongs to another layer", async () => {
  const fixture = await warehouseFixture(["SUCCEEDED"], { layerId: "assets-public" });
  try {
    const run = await fixture.service.submitScan(fixture.connector.id, { assetId: fixture.asset.id, allowedSuffixes: [".csv"], coverage: warehouseCoverage() });
    const stored = (await fixture.runs.list()).find((candidate) => candidate.id === run.id);
    assert.ok(stored);
    assert.equal(stored.status, "failed");
    assert.equal(stored.mocStatus, "failed");
    assert.match(stored.error ?? "", /mismatched scanner summary identity/);
    assert.equal(fixture.imported.length, 0);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("polling ignores non-Workspace Warehouse history", async () => {
  const fixture = await warehouseFixture(["RUNNING"]);
  try {
    await fixture.runs.add(fixture.connector.locationKey, { connectorId: fixture.connector.id, connectorKind: "s3", executor: "assets-scan", backend: "warehouse", taskKind: "user_scan", jobId: "assets-job", batchId: "assets-batch", warehouseLayerId: "assets-public", status: "running" });
    const before = fixture.requests.length;
    await fixture.service.poll();
    assert.equal(fixture.requests.length, before);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
