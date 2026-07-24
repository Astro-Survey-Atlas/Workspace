import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { JsonDatasetRegistry } from "../src/registry.js";

const fixturePath = fileURLToPath(new URL("fixtures/catalog.csv", import.meta.url));
const fixtureRoot = path.dirname(fixturePath);

test("registration is persistent and idempotent", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "astro-registry-"));
  const statePath = path.join(temporaryDirectory, "registry.json");
  const registry = new JsonDatasetRegistry({
    statePath,
    allowedRoots: [fixtureRoot],
    now: () => new Date("2026-07-22T00:00:00.000Z"),
  });

  const first = await registry.registerLocalCsv(fixturePath, "Demo catalog");
  const second = await registry.registerLocalCsv(fixturePath, "Renamed catalog");

  assert.equal(first.id, second.id);
  assert.equal(second.name, "Renamed catalog");
  assert.equal((await registry.list()).length, 1);
  assert.equal((await registry.get(first.id)).profile.rowCount, 3);
  assert.match(await readFile(statePath, "utf8"), /Renamed catalog/);
});

test("rejects files outside configured data roots", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "astro-registry-"));
  const registry = new JsonDatasetRegistry({
    statePath: path.join(temporaryDirectory, "registry.json"),
    allowedRoots: [temporaryDirectory],
  });

  await assert.rejects(() => registry.registerLocalCsv(fixturePath), /outside configured data roots/);
});
