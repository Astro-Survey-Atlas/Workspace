import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SurveyRegistry } from "../src/survey-registry.js";

async function registry(): Promise<SurveyRegistry> {
  const root = await mkdtemp(path.join(os.tmpdir(), "astro-survey-registry-"));
  const value = new SurveyRegistry(path.join(root, "registrations.json"));
  await value.initialize();
  return value;
}

test("curated cards group all nineteen SDSS releases under one survey", async () => {
  const value = await registry();
  const sdss = value.get("sdss");
  assert.equal(sdss.releases.length, 19);
  assert.equal(value.list().find((card) => card.id === "sdss")?.releaseCount, 19);
  assert.equal(sdss.releases[0]?.phase, "SDSS-I/II");
  assert.equal(sdss.releases[18]?.phase, "SDSS-V");
});

test("HST is represented as an archive snapshot, not a fabricated DR series", async () => {
  const value = await registry();
  const hst = value.get("hst");
  assert.equal(hst.releases.length, 1);
  assert.equal(hst.releases[0]?.kind, "archive_snapshot");
  assert.equal(hst.releases[0]?.coverage.status, "pending");
});

test("user source registration preserves metadata without claiming a footprint", async () => {
  const value = await registry();
  const created = await value.register({
    name: "My catalog",
    sourceUrl: "https://example.org/catalog",
    modalities: ["catalog", "photometry"],
  });
  assert.equal(created.origin, "user");
  assert.equal(created.releases[0]?.coverage.status, "pending");
  assert.equal(value.get(created.id).name, "My catalog");
});

test("registration rejects non-http source URLs and unknown modalities", async () => {
  const value = await registry();
  await assert.rejects(() => value.register({ name: "x", sourceUrl: "file:///tmp/x", modalities: ["catalog"] }), /http or https/);
  await assert.rejects(() => value.register({ name: "x", sourceUrl: "https://example.org", modalities: ["invalid" as "catalog"] }), /supported/);
});
