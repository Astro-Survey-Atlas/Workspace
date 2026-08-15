import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  LocalConnectorPolicyError,
  LocalConnectorRootsPolicy,
  localConnectorRootsResponse,
  type LocalConnectorFileSystem,
} from "../src/local-connector-roots.js";

test("local roots parse path.delimiter and expose only safe roots API fields", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-local-roots-"));
  try {
    const policy = LocalConnectorRootsPolicy.fromEnvironment({ ASTRO_LOCAL_CONNECTOR_ROOTS: ["/data/local", "/data/archive"].join(path.delimiter) });
    const roots = await policy.list();
    assert.equal(roots.length, 2);
    assert.deepEqual(Object.keys(localConnectorRootsResponse(roots).roots[0]!).sort(), ["available", "containerPath", "id", "label", "readOnly"]);
    assert.deepEqual(roots.map((root) => root.containerPath), ["/data/local", "/data/archive"]);
    assert.equal(roots.every((root) => root.available === false), true);
    assert.equal(roots.every((root) => root.readOnly === true), true);
    assert.equal(JSON.stringify(roots).includes("hostPath"), false);
    assert.deepEqual(localConnectorRootsResponse(roots), { roots });

    const mixed = new LocalConnectorRootsPolicy([
      { id: "available", label: "Available", containerPath: "/data/local", hostPath: directory },
      { id: "missing", label: "Missing", containerPath: "/data/missing", hostPath: path.join(directory, "missing") },
    ]);
    const mixedRoots = await mixed.list();
    assert.deepEqual(mixedRoots.map((root) => root.available), [true, false]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("local roots authorize normalized paths and reject adjacent prefixes and dot escapes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-local-roots-"));
  try {
    const policy = new LocalConnectorRootsPolicy([{ containerPath: "/data/local", hostPath: directory }]);
    await mkdir(path.join(directory, "catalog"));
    assert.equal(policy.assertConfiguredPath("/data/local/catalog/../catalog"), "/data/local/catalog");
    assert.throws(() => policy.assertConfiguredPath("/data/locality/catalog"), /outside the configured local roots/);
    assert.throws(() => policy.assertConfiguredPath("/data/local/../../etc"), /outside the configured local roots/);
    assert.throws(() => policy.assertConfiguredPath("relative/catalog"), /absolute container path/);
    assert.equal((await policy.checkDirectory("/data/local/catalog")).ok, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("local roots use realpath containment and reject symlink escape, files, and missing targets", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-local-roots-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "astro-local-outside-"));
  try {
    const policy = new LocalConnectorRootsPolicy([{ containerPath: "/data/local", hostPath: directory }]);
    await mkdir(path.join(directory, "inside"));
    await writeFile(path.join(directory, "ordinary.txt"), "data", "utf8");
    await symlink(path.join(outside, "missing-target"), path.join(directory, "escape"));
    const inside = await policy.checkDirectory("/data/local/inside");
    assert.deepEqual(inside, { ok: true });
    assert.equal((await policy.checkDirectory("/data/local/ordinary.txt")).failure, "not-directory");
    assert.equal((await policy.checkDirectory("/data/local/does-not-exist")).failure, "unavailable");
    assert.equal((await policy.checkDirectory("/data/local/escape")).failure, "unavailable");

    await rm(path.join(directory, "escape"));
    await mkdir(path.join(outside, "outside-directory"));
    await symlink(path.join(outside, "outside-directory"), path.join(directory, "escape"));
    assert.equal((await policy.checkDirectory("/data/local/escape")).failure, "outside-root");
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("local roots require readable and searchable directories", async () => {
  const fileSystem: LocalConnectorFileSystem = {
    access: async (_target, mode) => {
      if (mode === (4 | 1)) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    },
    realpath: async (target) => target === "/host/root" ? "/host/root" : "/host/root/catalog",
    stat: async () => ({ isDirectory: () => true, isFile: () => false }),
  };
  const policy = new LocalConnectorRootsPolicy([{ containerPath: "/data/local", hostPath: "/host/root" }], fileSystem);
  assert.deepEqual(await policy.checkDirectory("/data/local/catalog"), { ok: false, failure: "not-readable" });
});

test("local roots reject a directory without R_OK or X_OK", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-local-roots-"));
  const protectedDirectory = path.join(directory, "protected");
  try {
    await mkdir(protectedDirectory);
    await chmod(protectedDirectory, 0o000);
    const policy = new LocalConnectorRootsPolicy([{ containerPath: "/data/local", hostPath: directory }]);
    assert.equal((await policy.checkDirectory("/data/local/protected")).failure, "not-readable");
  } finally {
    await chmod(protectedDirectory, 0o700).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test("unconfigured local roots fail explicitly", () => {
  const policy = new LocalConnectorRootsPolicy();
  assert.throws(() => policy.assertConfiguredPath("/data/local"), (error: unknown) => {
    assert.ok(error instanceof LocalConnectorPolicyError);
    assert.match(error.message, /ASTRO_LOCAL_CONNECTOR_ROOTS is not configured/);
    assert.equal(error.statusCode, 503);
    return true;
  });
});
