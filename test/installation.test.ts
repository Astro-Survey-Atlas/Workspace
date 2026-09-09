import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { InstallationService, detectInstallationChannel, type InstallationChannel } from "../src/installation.js";
import type { WarehouseBindingState } from "../src/installation.js";

function effective(overrides: Partial<WarehouseBindingState & { configured: boolean }> = {}): WarehouseBindingState & { configured: boolean } {
  return { enabled: false, elasticsearchUrl: "", namespace: "asa-workspace", configured: false, ...overrides };
}

async function createService(directory: string, options: { channel?: InstallationChannel; inCluster?: boolean; readEffective?: () => WarehouseBindingState & { configured: boolean } } = {}) {
  const service = new InstallationService({
    root: directory,
    channel: options.channel,
    inCluster: options.inCluster,
    readEffective: options.readEffective ?? effective,
  });
  await service.initialize();
  return service;
}

test("detects installation channel from environment", () => {
  assert.equal(detectInstallationChannel({ ASTRO_INSTALL_CHANNEL: "docker" }), "docker");
  assert.equal(detectInstallationChannel({ ASTRO_INSTALL_CHANNEL: "helm" }), "helm");
  assert.equal(detectInstallationChannel({ ASTRO_INSTALL_CHANNEL: "bogus" }), "server");
  assert.equal(detectInstallationChannel({ ASTRO_INSTALL_CHANNEL: "docker", KUBERNETES_SERVICE_HOST: "10.0.0.1" }), "docker");
  assert.equal(detectInstallationChannel({ KUBERNETES_SERVICE_HOST: "10.0.0.1" }), "helm");
  assert.equal(detectInstallationChannel({ ASTRO_DESKTOP: "1" }), "desktop");
  assert.equal(detectInstallationChannel({ ELECTRON_RUN_AS_NODE: "1" }), "desktop");
  assert.equal(detectInstallationChannel({}), "server");
});

test("connect on helm channel records desired state and blocks until applied", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "installation-connect-"));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 20 }));
  const service = await createService(directory, { channel: "helm" });

  const operation = await service.reconcile({ kind: "connect", elasticsearchUrl: "http://atlas-warehouse-elasticsearch.atlas-warehouse.svc.cluster.local:9200" });
  assert.equal(operation.status, "blocked");
  assert.match(operation.reason, /已记录期望配置/);
  assert.ok(operation.guidance.some((line) => line.includes("helm upgrade asa")));

  const view = service.inspect();
  assert.equal(view.binding.desired?.enabled, true);
  assert.equal(view.binding.desired?.elasticsearchUrl, "http://atlas-warehouse-elasticsearch.atlas-warehouse.svc.cluster.local:9200");
  assert.equal(view.observed.state, "pending-restart");
  assert.ok(view.actions.find((action) => action.kind === "connect")?.available);
  assert.ok(view.actions.find((action) => action.kind === "disconnect")?.available);
});

test("reconnect after effective binding matches reports succeeded", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "installation-aligned-"));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 20 }));
  const url = "http://warehouse-es:9200";
  let current = effective();
  const service = await createService(directory, { channel: "helm", readEffective: () => current });

  await service.reconcile({ kind: "connect", elasticsearchUrl: url, namespace: "atlas-warehouse" });
  current = { enabled: true, elasticsearchUrl: url, namespace: "atlas-warehouse", configured: true };
  const second = await service.reconcile({ kind: "connect", elasticsearchUrl: url, namespace: "atlas-warehouse" });
  assert.equal(second.status, "succeeded");
  assert.match(second.reason, /已连接/);

  const view = service.inspect();
  assert.equal(view.observed.state, "connected");
  assert.equal(view.observed.health, "available");
  assert.equal(view.binding.aligned, true);
});

test("connect on docker channel without executor fails and records nothing", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "installation-docker-"));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 20 }));
  const service = await createService(directory, { channel: "docker" });

  const operation = await service.reconcile({ kind: "connect", elasticsearchUrl: "http://warehouse-es:9200" });
  assert.equal(operation.status, "failed");
  assert.match(operation.reason, /执行适配器/);

  const view = service.inspect();
  assert.equal(view.binding.desired, null);
  assert.ok(!view.actions.find((action) => action.kind === "connect")?.available);
});

test("disconnect on already disabled deployment succeeds immediately", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "installation-disconnect-"));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 20 }));
  const service = await createService(directory, { channel: "helm" });

  const operation = await service.reconcile({ kind: "disconnect" });
  assert.equal(operation.status, "succeeded");
  const view = service.inspect();
  assert.equal(view.binding.desired?.enabled, false);
  assert.equal(view.binding.aligned, true);
});

test("install is blocked with per-channel guidance", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "installation-install-"));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 20 }));
  const service = await createService(directory, { channel: "helm" });

  const operation = await service.reconcile({ kind: "install" });
  assert.equal(operation.status, "blocked");
  assert.ok(operation.guidance.some((line) => line.includes("atlas-warehouse-infra")));
  assert.ok(operation.guidance.some((line) => line.includes("watchNamespaces")));
});

test("uninstall keeps data and explains retention", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "installation-uninstall-"));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 20 }));
  const service = await createService(directory, { channel: "helm" });

  const operation = await service.reconcile({ kind: "uninstall" });
  assert.equal(operation.status, "blocked");
  assert.ok(operation.guidance.some((line) => line.includes("helm uninstall")));
  assert.ok(operation.reason.includes("PVC") || operation.guidance.some((line) => line.includes("PVC")));
});

test("operation journal persists across service restarts", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "installation-persist-"));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 20 }));
  const first = await createService(directory, { channel: "helm" });
  await first.reconcile({ kind: "connect", elasticsearchUrl: "http://warehouse-es:9200" });

  const second = await createService(directory, { channel: "helm" });
  const view = second.inspect();
  assert.equal(view.binding.desired?.elasticsearchUrl, "http://warehouse-es:9200");
  assert.equal(view.operations.length, 1);
  assert.equal(view.operations[0]?.status, "blocked");

  const raw = JSON.parse(await readFile(path.join(directory, "installation-state.json"), "utf8")) as { desired?: { elasticsearchUrl: string }; schemaVersion: number };
  assert.equal(raw.schemaVersion, 1);
  assert.equal(raw.desired?.elasticsearchUrl, "http://warehouse-es:9200");
});

test("credentials embedded in connect URLs are sanitized in operations", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "installation-sanitize-"));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 20 }));
  const service = await createService(directory, { channel: "helm" });

  const operation = await service.reconcile({ kind: "connect", elasticsearchUrl: "http://elastic:secret@warehouse-es:9200" });
  const serialized = JSON.stringify(operation);
  assert.ok(!serialized.includes("elastic:secret"));
  assert.ok(serialized.includes("http://warehouse-es:9200"));
});

test("invalid intents are rejected before recording anything", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "installation-invalid-"));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 20 }));
  const service = await createService(directory, { channel: "helm" });

  await assert.rejects(service.reconcile({ kind: "connect", elasticsearchUrl: "ftp://warehouse-es:9200" } as never), RangeError);
  await assert.rejects(service.reconcile({ kind: "connect", elasticsearchUrl: "http://warehouse-es:9200", namespace: "Bad_NS" }), RangeError);
  await assert.rejects(service.reconcile({ kind: "reinstall" } as never), RangeError);
  const view = service.inspect();
  assert.equal(view.binding.desired, null);
  assert.equal(view.operations.length, 0);
});
