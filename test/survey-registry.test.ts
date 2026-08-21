import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SurveyRegistry } from "../src/survey-registry.js";

const release = {
  id: "my-survey-r1",
  label: "Release 1",
  kind: "public_release" as const,
  availability: "available" as const,
  releasedYear: 2026,
  modalities: ["catalog", "photometry"] as const,
  products: [{ name: "Source catalog", modality: "catalog" as const, description: "Calibrated source rows." }],
  coverage: {
    status: "pending" as const,
    summary: "Coverage will be attached after validation.",
    sourceUrl: "https://example.org/my-survey/r1",
  },
};

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

test("a reviewed curated survey retires its matching legacy user registration", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "astro-survey-registry-curated-migration-"));
  const statePath = path.join(root, "registrations.json");
  try {
    await writeFile(statePath, JSON.stringify([{
      id: "csst",
      name: "CSST",
      mission: "中国空间站望远镜",
      color: "#58b7c9",
      description: "Legacy user registration before review.",
      modalities: ["imaging", "photometry", "catalog"],
      origin: "user",
      releases: [{
        id: "csst-sim-w1-20250731",
        label: "CSST W1 Simulation 2025-07-31",
        kind: "early_release",
        availability: "available",
        releasedYear: 2025,
        modalities: ["imaging", "photometry", "catalog"],
        products: [{ name: "W1 simulated wide-field images", modality: "imaging", description: "Legacy pending record." }],
        coverage: { status: "pending", summary: "Awaiting review.", sourceUrl: "https://nadc.china-vo.org/data/" },
      }],
    }]), "utf8");
    const value = new SurveyRegistry(statePath);
    await value.initialize();
    assert.equal(value.get("csst").origin, "curated");
    assert.equal(value.get("csst").releases[0]?.coverage.status, "verified");
    assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("user source registration preserves metadata without claiming a footprint", async () => {
  const value = await registry();
  const created = await value.register({
    name: "My catalog",
    sourceUrl: "https://example.org/catalog",
    modalities: ["catalog", "photometry"],
  });
  assert.equal(created.origin, "user");
  assert.equal(created.releases[0]?.id, `${created.id}-source`);
  assert.equal(created.releases[0]?.coverage.status, "pending");
  assert.equal(value.get(created.id).name, "My catalog");
});

test("explicit user surveys preserve stable ids, colors, and releases across restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "astro-survey-registry-explicit-"));
  const statePath = path.join(root, "registrations.json");
  try {
    const value = new SurveyRegistry(statePath);
    await value.initialize();
    const created = await value.register({
      id: "my-survey",
      name: "My Survey",
      mission: "Local observing program",
      color: "#12ABef",
      sourceUrl: "https://example.org/my-survey",
      description: "A stable user survey registration.",
      modalities: ["catalog", "photometry"],
      releases: [{ ...release, modalities: [...release.modalities] }],
    });
    assert.equal(created.id, "my-survey");
    assert.equal(created.color, "#12abef");
    assert.deepEqual(created.releases.map((entry) => entry.id), ["my-survey-r1"]);

    const restarted = new SurveyRegistry(statePath);
    await restarted.initialize();
    assert.equal(restarted.get("my-survey").releases[0]?.products[0]?.name, "Source catalog");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("user releases can be appended while all stable id conflicts are rejected", async () => {
  const value = await registry();
  await value.register({
    id: "my-survey",
    name: "My Survey",
    sourceUrl: "https://example.org/my-survey",
    modalities: ["catalog", "photometry"],
    releases: [{ ...release, modalities: [...release.modalities] }],
  });
  const added = await value.addRelease("my-survey", {
    ...release,
    id: "my-survey-r2",
    label: "Release 2",
    modalities: [...release.modalities],
  });
  assert.equal(added.id, "my-survey-r2");
  assert.deepEqual(value.get("my-survey").releases.map((entry) => entry.id), ["my-survey-r1", "my-survey-r2"]);
  await assert.rejects(() => value.register({
    id: "my-survey",
    name: "Duplicate",
    sourceUrl: "https://example.org/duplicate",
    modalities: ["catalog"],
  }), /already exists/);
  await assert.rejects(() => value.addRelease("my-survey", { ...release, modalities: [...release.modalities] }), /already exists/);
  await assert.rejects(() => value.addRelease("euclid", { ...release, id: "euclid-user-r1", modalities: [...release.modalities] }), /only be added to user surveys/);
});

test("registration rejects non-http source URLs and unknown modalities", async () => {
  const value = await registry();
  await assert.rejects(() => value.register({ name: "x", sourceUrl: "file:///tmp/x", modalities: ["catalog"] }), /http or https/);
  await assert.rejects(() => value.register({ name: "x", sourceUrl: "https://example.org", modalities: ["invalid" as "catalog"] }), /supported/);
  await assert.rejects(() => value.register({ name: "x", sourceUrl: "https://example.org", modalities: ["catalog"], color: "red" }), /hexadecimal/);
  await assert.rejects(() => value.register({ id: "Bad Id", name: "x", sourceUrl: "https://example.org", modalities: ["catalog"] }), /stable identifier/);
  await assert.rejects(() => value.register({ name: "x", sourceUrl: "https://example.org", modalities: ["catalog"], extra: true } as never), /unknown field/);
  await assert.rejects(() => value.register({
    name: "x",
    sourceUrl: "https://example.org",
    modalities: ["catalog", "photometry"],
    releases: [{ ...release, modalities: [...release.modalities], coverage: { ...release.coverage, extra: true } } as never],
  }), /unknown field/);
});
