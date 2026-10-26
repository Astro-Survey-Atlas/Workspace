import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MemoryConnectorCredentialStore } from "../src/connector-credentials.js";
import { connectorDisplayPath, connectorLocationKey, type ConnectorRecord } from "../src/connectors.js";
import type { DataAssetRecord } from "../src/data-catalog.js";
import { InstallationService, type WarehouseBindingState } from "../src/installation.js";
import { LocalConnectorRootsPolicy } from "../src/local-connector-roots.js";
import type { ResourcePackageJob, ResourcePackageLoad, ResourcePackageManager } from "../src/resource-packages.js";
import { SqliteMetadataStore } from "../src/storage/sqlite.js";
import { SystemConfigStore } from "../src/system-config.js";
import { WorkspaceConfigBackupService } from "../src/workspace-config-backup.js";

const timestamp = "2026-10-14T12:00:00.000Z";
const password = "configuration-backup-test-password";

interface PackageStubOptions {
  selection?: ResourcePackageLoad[];
  clear?: () => Promise<void>;
  restore?: (loads: ResourcePackageLoad[]) => Promise<void>;
  get?: (id: string) => { status: string; availableReleaseIds: string[] };
  install?: (id: string) => ResourcePackageJob;
  job?: (id: string) => ResourcePackageJob;
  setActive?: (loads: ResourcePackageLoad[]) => Promise<void>;
}

function packageStub(options: PackageStubOptions = {}): ResourcePackageManager {
  let selection = structuredClone(options.selection ?? []);
  return {
    available: true,
    activeSelection: () => structuredClone(selection),
    clearActiveSelection: async () => { selection = []; await options.clear?.(); },
    restoreActiveSelection: async (loads: ResourcePackageLoad[]) => { selection = structuredClone(loads); await options.restore?.(loads); },
    get: options.get ?? (() => ({ status: "installed", availableReleaseIds: [] })),
    install: options.install ?? (() => { throw new Error("unexpected package install"); }),
    job: options.job ?? (() => { throw new Error("unexpected package job"); }),
    setActive: async (loads: ResourcePackageLoad[]) => { selection = structuredClone(loads); await options.setActive?.(loads); },
  } as unknown as ResourcePackageManager;
}

interface Runtime {
  store: SqliteMetadataStore;
  credentials: MemoryConnectorCredentialStore;
  roots: LocalConnectorRootsPolicy;
  systemConfig: SystemConfigStore;
  installation: InstallationService;
  backup: WorkspaceConfigBackupService;
  backupRoot: string;
}

async function runtime(base: string, roots: LocalConnectorRootsPolicy, resourcePackages = packageStub()): Promise<Runtime> {
  const store = new SqliteMetadataStore(path.join(base, "metadata.sqlite"));
  await store.initialize();
  const credentials = new MemoryConnectorCredentialStore();
  const systemConfig = new SystemConfigStore(path.join(base, "system"));
  await systemConfig.initialize();
  const readEffective = (): WarehouseBindingState & { configured: boolean } => ({
    enabled: false, elasticsearchUrl: "", namespace: "asa-workspace", configured: false,
  });
  const installation = new InstallationService({ root: path.join(base, "installation"), readEffective });
  await installation.initialize();
  const backupRoot = path.join(base, "backup");
  const backup = new WorkspaceConfigBackupService({ root: backupRoot, store, credentials, roots, systemConfig, installation,
    resourcePackages, surveys: { initialize: async () => undefined }, isBusy: async () => undefined });
  await backup.initialize();
  return { store, credentials, roots, systemConfig, installation, backup, backupRoot };
}

function localConnector(id: string, rootPath: string): ConnectorRecord {
  const config = { rootPath };
  return { id, locationKey: connectorLocationKey("local", config), displayPath: connectorDisplayPath("local", config),
    name: "Local catalogs", description: "", kind: "local", config, status: "ready", createdAt: timestamp,
    updatedAt: timestamp, origin: "user" };
}

function s3Connector(id: string, credentialRef?: string): ConnectorRecord {
  const config = { bucket: "survey-data", prefix: "release" };
  return { id, locationKey: connectorLocationKey("s3", config), displayPath: connectorDisplayPath("s3", config),
    name: "Survey archive", description: "", kind: "s3", config, ...(credentialRef ? { credentialRef } : {}),
    status: "ready", createdAt: timestamp, updatedAt: timestamp, origin: "user" };
}

function localAsset(id: string, connector: ConnectorRecord): DataAssetRecord {
  const uri = `local://${connector.config.rootPath}/catalog.csv`;
  const access = { connector: "local" as const, uri, format: "csv", connectorId: connector.id };
  return { id, name: "Sources", description: "Source catalog", sourceRelativePath: "catalog.csv", product: "Sources",
    kind: "catalog", modalities: ["photometry"], access, accesses: [access], connectorIds: [connector.id],
    connectorLocationKeys: [connector.locationKey], status: "ready", projectState: "acquired", footprintIds: [],
    origin: "user", createdAt: timestamp, updatedAt: timestamp };
}

async function closeRuntime(value: Runtime): Promise<void> { await value.store.close(); }

async function waitForRestore(backup: WorkspaceConfigBackupService, status: "partial" | "succeeded"): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await backup.publicSelectionStatus())?.status === status) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`public resource restore did not reach ${status}`);
}

test("encrypted backup validates integrity and restores remapped connectors, credentials, paths, and settings", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "asa-config-backup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourcePath = path.join(directory, "source-files"), targetPath = path.join(directory, "target-files");
  await Promise.all([mkdir(sourcePath), mkdir(targetPath)]);
  const source = await runtime(path.join(directory, "source"), new LocalConnectorRootsPolicy([{ containerPath: sourcePath, hostPath: sourcePath }]));
  const target = await runtime(path.join(directory, "target"), new LocalConnectorRootsPolicy([{ containerPath: targetPath, hostPath: targetPath }]));
  t.after(async () => { await closeRuntime(source); await closeRuntime(target); });

  const local = localConnector("connector-source-local", sourcePath);
  const secretRef = source.credentials.managedReference("connector-source-s3");
  const remote = s3Connector("connector-source-s3", secretRef);
  await source.store.putConnector(local);
  await source.store.putConnector(remote);
  await source.credentials.put(secretRef, { accessKeyId: "source-access", secretAccessKey: "source-secret", endpoint: "https://s3.example.test" });
  await source.store.putDataAsset(localAsset("asset-source", local));
  await source.systemConfig.setAssetsApiKey("source-assets-api-key");

  const encrypted = await source.backup.export(password, { "astro-workspace:theme:v1": "dark", ignored: "value" });
  await assert.rejects(target.backup.preview(encrypted, "a-different-valid-password"), /password is incorrect or the file has been changed/);
  const envelope = JSON.parse(encrypted.toString("utf8")) as { tag: string };
  const damagedTag = Buffer.from(envelope.tag, "base64");
  damagedTag[0] = damagedTag[0]! ^ 1;
  envelope.tag = damagedTag.toString("base64");
  await assert.rejects(target.backup.preview(Buffer.from(JSON.stringify(envelope)), password), /password is incorrect or the file has been changed/);

  await target.systemConfig.setAssetsApiKey("target-assets-api-key");
  const old = s3Connector("connector-target-old");
  await target.store.putConnector(old);
  await target.store.putConnectorIngestRun({ id: "history-to-retain", locationKey: old.locationKey, connectorId: old.id,
    connectorKind: old.kind, status: "succeeded", startedAt: timestamp, completedAt: timestamp, createdAt: timestamp });
  const preview = await target.backup.preview(encrypted, password);
  assert.equal(preview.summary.connectors, 2);
  assert.deepEqual(preview.summary.missingLocalRoots.map(item => item.rootPath), [sourcePath]);
  await target.backup.apply(preview.previewId, { [sourcePath]: targetPath });

  const imported = await target.store.listConnectors();
  assert.equal(imported.length, 2);
  const importedLocal = imported.find(record => record.kind === "local")!;
  const importedS3 = imported.find(record => record.kind === "s3")!;
  assert.notEqual(importedLocal.id, local.id);
  assert.equal(importedLocal.config.rootPath, targetPath);
  assert.notEqual(importedS3.id, remote.id);
  assert.deepEqual(await target.credentials.get(importedS3.credentialRef!), {
    accessKeyId: "source-access", secretAccessKey: "source-secret", endpoint: "https://s3.example.test",
  });
  const [asset] = await target.store.listDataAssets();
  assert.notEqual(asset!.id, "asset-source");
  assert.deepEqual(asset!.connectorIds, [importedLocal.id]);
  assert.equal(asset!.access.connectorId, importedLocal.id);
  assert.equal(asset!.access.uri, `local://${targetPath}/catalog.csv`);
  assert.equal(await target.systemConfig.getAssetsApiKey(), "source-assets-api-key");
  assert.equal((await target.store.listConnectorIngestRuns()).some(run => run.id === "history-to-retain"), true);
});

test("rollback removes its journal before best-effort restore-point cleanup", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "asa-config-rollback-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const roots = new LocalConnectorRootsPolicy();
  const source = await runtime(path.join(directory, "source"), roots);
  const target = await runtime(path.join(directory, "target"), roots, packageStub({ clear: async () => { throw new Error("simulated package selection failure"); } }));
  t.after(async () => { await closeRuntime(source); await closeRuntime(target); });
  const oldConnector = s3Connector("connector-before-import");
  await target.store.putConnector(oldConnector);
  await target.systemConfig.setAssetsApiKey("old-api-key");
  const encrypted = await source.backup.export(password);
  const preview = await target.backup.preview(encrypted, password);

  target.systemConfig.discardRestorePoint = async () => { throw new Error("simulated cleanup failure"); };
  await assert.rejects(target.backup.apply(preview.previewId), /simulated package selection failure/);
  assert.deepEqual((await target.store.listConnectors()).map(record => record.id), [oldConnector.id]);
  assert.equal(await target.systemConfig.getAssetsApiKey(), "old-api-key");
  await assert.rejects(readFile(path.join(target.backupRoot, "workspace-config-import-journal.json")), { code: "ENOENT" });
  assert.ok((await readdir(path.join(directory, "target", "system"))).some(name => name.startsWith(".restore-")));
});

test("failed public package restore is retained and can be retried", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "asa-config-public-restore-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const roots = new LocalConnectorRootsPolicy();
  const load = { packageId: "public-fixture-package", releaseIds: ["fixture-release"] };
  const source = await runtime(path.join(directory, "source"), roots, packageStub({ selection: [load] }));
  let installSucceeds = false;
  const failedJob = { id: "failed-install", packageId: load.packageId, version: "1.0.0", status: "failed", phase: "failed",
    downloadedBytes: 0, totalBytes: 1, createdAt: timestamp, updatedAt: timestamp, error: "temporary catalog failure" } as ResourcePackageJob;
  const target = await runtime(path.join(directory, "target"), roots, packageStub({
    get: () => installSucceeds ? { status: "installed", availableReleaseIds: load.releaseIds } : { status: "not_installed", availableReleaseIds: [] },
    install: () => failedJob,
    job: () => failedJob,
  }));
  t.after(async () => { await closeRuntime(source); await closeRuntime(target); });

  const encrypted = await source.backup.export(password);
  const preview = await target.backup.preview(encrypted, password);
  await target.backup.apply(preview.previewId);
  await waitForRestore(target.backup, "partial");
  const partial = await target.backup.publicSelectionStatus();
  assert.equal(partial?.packages[0]?.status, "failed");
  assert.match(partial?.packages[0]?.error ?? "", /temporary catalog failure/);

  installSucceeds = true;
  await target.backup.retryPublicSelection();
  await waitForRestore(target.backup, "succeeded");
  const succeeded = await target.backup.publicSelectionStatus();
  assert.equal(succeeded?.status, "succeeded");
  assert.deepEqual(succeeded?.packages.map(({ packageId, releaseIds, status }) => ({ packageId, releaseIds, status })), [
    { ...load, status: "succeeded" },
  ]);
});
