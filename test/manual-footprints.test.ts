import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ManualFootprintRegistry, ManualFootprintRevisionError } from "../src/manual-footprints.js";
import { CURATED_SURVEYS } from "../src/survey-registry.js";

const input = {
  surveyId: "euclid",
  releaseId: "euclid-q1",
  product: "Euclid Q1 deep fields",
  label: "Q1 manually calculated footprint",
  sourceUrl: "https://example.test/euclid-q1",
  method: "Calculated from the published field list.",
  calculatedAt: "2026-08-12T01:00:00.000Z",
  ordering: "NESTED" as const,
  nside: 16 as const,
  pixels: [9, 3, 9, 4],
};

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "manual-footprints-"));
  const statePath = path.join(directory, "state", "manual-footprints.json");
  let tick = 0;
  const options = { statePath, surveys: CURATED_SURVEYS, now: () => new Date(Date.UTC(2026, 7, 12, 2, tick++)) };
  const registry = new ManualFootprintRegistry(options);
  await registry.initialize();
  return { directory, registry, options };
}

test("manual footprint state machine persists and publishes a MOC manifest", async () => {
  const { directory, registry, options } = await fixture();
  try {
    const draft = await registry.create(input);
    assert.equal(draft.status, "draft");
    assert.equal(draft.revision, 1);
    assert.deepEqual(draft.pixels, [3, 4, 9]);
    const validated = await registry.validate(input.surveyId, input.releaseId, input.product, draft.revision);
    const published = await registry.publish(input.surveyId, input.releaseId, input.product, validated.revision);
    assert.equal(published.status, "published");
    assert.equal(published.revision, 3);
    assert.deepEqual(registry.publishedManifest().footprints, [{
      surveyId: input.surveyId,
      releaseId: input.releaseId,
      product: input.product,
      label: input.label,
      nside: 16,
      pixels: [3, 4, 9],
      quality: "moc",
      sourceUrl: input.sourceUrl,
      retrievedAt: input.calculatedAt,
      notes: input.method,
    }]);

    const restarted = new ManualFootprintRegistry(options);
    await restarted.initialize();
    assert.equal(restarted.get(input.surveyId, input.releaseId, input.product).status, "published");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("revisions are optimistic and geometry changes return a record to draft", async () => {
  const { directory, registry } = await fixture();
  try {
    const draft = await registry.create(input);
    await assert.rejects(() => registry.validate(input.surveyId, input.releaseId, input.product, 99), ManualFootprintRevisionError);
    const validated = await registry.validate(input.surveyId, input.releaseId, input.product, draft.revision);
    const published = await registry.publish(input.surveyId, input.releaseId, input.product, validated.revision);
    const updated = await registry.update(input.surveyId, input.releaseId, input.product, published.revision, { ...input, pixels: [1, 2] });
    assert.equal(updated.status, "draft");
    assert.equal(updated.validatedAt, undefined);
    assert.equal(updated.publishedAt, undefined);
    assert.equal(registry.publishedManifest().footprints.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("strict input, curated references, registered products, and publish conflicts are enforced", async () => {
  const { directory, registry } = await fixture();
  try {
    await assert.rejects(() => registry.create({ ...input, extra: true }), /unknown field/);
    await assert.rejects(() => registry.create({ ...input, releaseId: "euclid-dr1" }), /available curated release/);
    await assert.rejects(() => registry.create({ ...input, product: "unknown" }), /not registered/);
    await assert.rejects(() => registry.create({ ...input, sourceUrl: "http:\/\/example.test" }), /HTTPS/);
    const draft = await registry.create(input);
    const validated = await registry.validate(input.surveyId, input.releaseId, input.product, draft.revision);
    await assert.rejects(() => registry.publish(input.surveyId, input.releaseId, input.product, validated.revision, {
      schemaVersion: 1,
      generatedAt: input.calculatedAt,
      coordinateFrame: "ICRS",
      nside: 16,
      footprints: [{ ...input, quality: "moc", retrievedAt: input.calculatedAt, notes: input.method }],
    }), /conflicts/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("products listed only in release-products are valid references", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "manual-footprints-product-"));
  try {
    const registry = new ManualFootprintRegistry({
      statePath: path.join(directory, "state.json"),
      surveys: CURATED_SURVEYS,
      releaseProducts: [{ surveyId: "euclid", releaseId: "euclid-q1", product: "Q1 deep fields", status: "acquired", sourceUrl: "https://example.test" }],
    });
    await registry.initialize();
    const record = await registry.create({ ...input, product: "Q1 deep fields" });
    assert.equal(record.product, "Q1 deep fields");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent mutations are serialized without losing records", async () => {
  const { directory, registry } = await fixture();
  try {
    const [first, second] = await Promise.all([
      registry.create(input),
      registry.create({ ...input, releaseId: "euclid-ero", product: "Early Release Observations", label: "ERO footprint" }),
    ]);
    assert.equal(first.revision, 1);
    assert.equal(second.revision, 1);
    assert.equal(registry.list().length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
