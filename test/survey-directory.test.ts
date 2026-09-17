import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SqliteMetadataStore } from "../src/storage/sqlite.js";
import { SurveyDirectory } from "../src/survey-directory.js";
import { SurveyRegistry } from "../src/survey-registry.js";

test("survey migration preserves references; public association is explicit, durable and reversible", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "survey-directory-"));
  const filename = path.join(directory, "surveys.json");
  const store = new SqliteMetadataStore(path.join(directory, "metadata.sqlite"));
  try {
    const legacy = new SurveyRegistry(filename);
    await legacy.initialize();
    const local = await legacy.register({ id: "csst", name: "CSST", sourceUrl: "https://example.org/simulation", modalities: ["imaging"] });
    const original = await readFile(filename, "utf8");
    await store.initialize();
    const surveys = new SurveyDirectory(store);
    await surveys.importLegacy(filename);
    await writeFile(filename, "invalid after migration");
    await surveys.importLegacy(filename);
    assert.equal((await surveys.get("csst")).releases[0]?.id, "csst-source");
    await writeFile(filename, original);
    const published = { ...local, origin: "public" as const, releases: local.releases.map((release) => ({ ...release, id: "csst-dr1", kind: "public_release" as const })) };
    await surveys.syncPublic([published]);
    const identities = await store.listSurveyIdentities();
    const publicId = identities.find((entry) => entry.source === "assets")!.id;
    assert.notEqual(publicId, "csst", "same source id must not merge independent identities");
    assert.equal((await surveys.list()).length, 2);
    await surveys.link("csst", publicId);
    assert.equal((await surveys.list()).length, 1);
    assert.deepEqual(new Set(await surveys.aliases(publicId)), new Set([publicId, "csst"]));
    assert.deepEqual(new Set((await surveys.get("csst")).releases.map((release) => release.id)), new Set(["csst-source", "csst-dr1"]));
    await surveys.validateReference(publicId, "csst-source");
    await assert.rejects(surveys.validateReference(publicId, "unknown"), /does not belong/);
    await surveys.syncPublic([]);
    assert.equal((await surveys.list()).length, 1, "catalog removal preserves identity");
    await store.close();
    await store.initialize();
    const restarted = new SurveyDirectory(store);
    await restarted.importLegacy(filename);
    assert.equal((await restarted.get("csst")).id, publicId, "association survives restart");
    await restarted.syncPublic([{ ...published, releases: [] }]);
    await restarted.validateReference(publicId, "csst-dr1");
    await restarted.link("csst", publicId, true);
    assert.equal((await surveys.list()).length, 2);
    await assert.rejects(surveys.validateReference(publicId, "csst-source"), /does not belong/);
    assert.equal((await store.listSurveyIdentities()).find((entry) => entry.id === "csst")?.history.length, 2);
    assert.equal(await readFile(filename, "utf8"), original);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
