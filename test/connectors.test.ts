import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ConnectorRegistry, connectorLocationKey } from "../src/connectors.js";
import { SqliteMetadataStore } from "../src/storage/index.js";

async function connectorRegistry(statePath: string, bootstrapPath?: string): Promise<ConnectorRegistry> {
  const store = new SqliteMetadataStore(`${statePath}.sqlite`);
  await store.initialize();
  const registry = new ConnectorRegistry(store, bootstrapPath);
  await registry.initialize();
  return registry;
}

test("connector registry persists S3, local, and JDBC configuration without testing connections", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-connectors-"));
  try {
    const registry = await connectorRegistry(path.join(directory, "connectors.json"));
    const s3 = await registry.register({ name: "Euclid S3", kind: "s3", config: { endpoint: "https://s3.example", bucket: "euclid", prefix: "q1/" }, credentialRef: "secret/euclid" });
    await registry.register({ name: "Local catalogs", kind: "local", config: { rootPath: "/mnt/data/catalogs" } });
    await registry.register({ name: "Catalog JDBC", kind: "jdbc", config: { url: "jdbc:postgresql://db/catalog", schema: "public" } });
    assert.equal(s3.status, "draft");
    assert.equal((await registry.list()).length, 3);

    const reloaded = await connectorRegistry(path.join(directory, "connectors.json"));
    assert.equal((await reloaded.get(s3.id)).config.bucket, "euclid");
    await assert.rejects(() => reloaded.register({ name: "Broken", kind: "local", config: {} }), /config.rootPath is required/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("connector survey ownership round-trips and requires a survey for releases", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-connectors-"));
  try {
    const registry = await connectorRegistry(path.join(directory, "connectors.json"));
    const record = await registry.register({ name: "Euclid owned", kind: "s3", config: { bucket: "euclid" }, surveyId: "euclid", releaseId: "euclid-q1" });
    assert.equal(record.surveyId, "euclid");
    assert.equal(record.releaseId, "euclid-q1");
    await assert.rejects(() => registry.register({ name: "Invalid ownership", kind: "s3", config: { bucket: "invalid" }, releaseId: "euclid-q1" }), /releaseId requires surveyId/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("connector registry seeds a new state file from the bundled bootstrap", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-connectors-"));
  try {
    const bootstrapPath = path.join(directory, "connectors-bootstrap.json");
    await writeFile(bootstrapPath, JSON.stringify([{
      id: "connector-fixture",
      name: "Fixture S3",
      description: "Seeded connector",
      kind: "s3",
      config: { bucket: "fixture" },
      status: "ready",
      createdAt: "2026-07-26T00:00:00.000Z",
      updatedAt: "2026-07-26T00:00:00.000Z",
      origin: "user",
    }]), "utf8");
    const registry = await connectorRegistry(path.join(directory, "state", "connectors.json"), bootstrapPath);
    assert.equal((await registry.get("connector-fixture")).config.bucket, "fixture");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent connector registrations retain both records", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-connectors-"));
  try {
    const statePath = path.join(directory, "connectors.json");
    const registry = await connectorRegistry(statePath);
    await Promise.all([
      registry.register({ name: "Concurrent S3", kind: "s3", config: { bucket: "one" } }),
      registry.register({ name: "Concurrent local", kind: "local", config: { rootPath: "/data/two" } }),
    ]);
    assert.equal((await registry.list()).length, 2);
    const reloaded = await connectorRegistry(statePath);
    assert.equal((await reloaded.list()).length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("connector registrations upsert by normalized scan path", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-connectors-"));
  try {
    const registry = await connectorRegistry(path.join(directory, "connectors.json"));
    const first = await registry.register({ name: "S3 first", kind: "s3", config: { bucket: "EUCLID", prefix: "/q1/" } });
    const second = await registry.register({ name: "S3 renamed", kind: "s3", config: { bucket: "euclid", prefix: "q1" }, credentialRef: "secret/euclid" });
    assert.equal(first.id, second.id);
    assert.equal((await registry.list()).length, 1);
    assert.equal(second.locationKey, "s3://euclid/q1");
    assert.equal(second.displayPath, "s3://euclid/q1");
    assert.equal(second.credentialRef, "secret/euclid");
    assert.equal(connectorLocationKey("local", { rootPath: "/tmp/../data" }), "local:///data");
    await assert.rejects(() => registry.register({ name: "Raw secret", kind: "s3", config: { bucket: "private", secretKey: "do-not-store" } }), /raw secrets are not stored/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("local connector check does not enumerate the directory", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-connectors-"));
  try {
    const registry = await connectorRegistry(path.join(directory, "connectors.json"));
    const record = await registry.register({ name: "Local", kind: "local", config: { rootPath: directory } });
    const checked = await registry.check(record.id);
    assert.equal(checked.lastCheck?.status, "ok");
    assert.match(checked.lastCheck?.summary ?? "", /exists/);
    const preview = await registry.checkInput({ name: "Preview", kind: "local", config: { rootPath: directory } });
    assert.equal(preview.status, "ok");
    assert.equal((await registry.list()).length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bootstrap connector ids remain aliases after a path-based state migration", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-connectors-"));
  try {
    const statePath = path.join(directory, "connectors.json");
    const bootstrapPath = path.join(directory, "bootstrap.json");
    await writeFile(bootstrapPath, JSON.stringify([{ id: "connector-legacy", name: "Legacy", kind: "local", config: { rootPath: "/catalogs" }, status: "ready", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }]), "utf8");
    await writeFile(statePath, JSON.stringify([{ id: "connector-current", name: "Current", kind: "local", config: { rootPath: "/catalogs/../catalogs" }, status: "ready", createdAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" }]), "utf8");
    const store = new SqliteMetadataStore(`${statePath}.sqlite`);
    await store.initialize();
    await store.putConnector({ id: "connector-current", name: "Current", description: "", kind: "local", config: { rootPath: "/catalogs/../catalogs" }, locationKey: "local:///catalogs", displayPath: "/catalogs", status: "ready", createdAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z", origin: "user" });
    const registry = new ConnectorRegistry(store, bootstrapPath);
    await registry.initialize();
    assert.equal((await registry.get("connector-legacy")).id, "connector-current");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("S3 checks distinguish endpoint reachability from transient credential verification", async () => {
  let authorizationHeader = "";
  const server = createServer((request, response) => {
    authorizationHeader = request.headers.authorization ?? "";
    response.statusCode = authorizationHeader ? 200 : 403;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-connectors-"));
  try {
    const statePath = path.join(directory, "connectors.json");
    const registry = await connectorRegistry(statePath);
    const record = await registry.register({
      name: "Private MinIO",
      kind: "s3",
      config: { endpoint: `http://127.0.0.1:${address.port}`, bucket: "euclid", region: "us-east-1" },
    });

    const reachable = await registry.check(record.id);
    assert.equal(reachable.lastCheck?.status, "ok");
    assert.match(reachable.lastCheck?.summary ?? "", /Endpoint 可达/);
    assert.equal(authorizationHeader, "");

    const authenticated = await registry.check(record.id, { accessKeyId: "temporary-access", secretAccessKey: "temporary-secret" });
    assert.equal(authenticated.lastCheck?.status, "ok");
    assert.match(authenticated.lastCheck?.summary ?? "", /凭据与 Bucket 均已验证/);
    assert.match(authorizationHeader, /^AWS4-HMAC-SHA256 /);
    assert.doesNotMatch(JSON.stringify(await registry.list()), /temporary-access|temporary-secret/);
  } finally {
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
