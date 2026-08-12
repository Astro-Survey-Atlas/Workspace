import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { CURATED_SURVEYS } from "../src/survey-registry.js";
import { validate } from "../scripts/public_footprint_artifacts.js";

const root = process.cwd();
const sourcesPath = path.join(root, "artifacts", "public-survey-footprints", "sources.json");

test("public sources cover every available release and product", async () => {
  const result = await validate();
  assert.equal(result.releases, CURATED_SURVEYS.flatMap((survey) => survey.releases.filter((release) => release.availability === "available")).length);
  assert.equal(result.acquired, 12);
  assert.ok(result.unavailable > 0);
});

test("unavailable source records contain no pixels", async () => {
  const sources = JSON.parse(await readFile(sourcesPath, "utf8")) as { releases: Array<{ products: Array<Record<string, unknown>> }> };
  for (const release of sources.releases) for (const product of release.products) {
    assert.ok(product.status === "acquired" || product.status === "unavailable");
    assert.equal("pixels" in product, false);
    if (product.status === "unavailable") assert.equal(typeof product.reason, "string");
  }
});

test("all acquired identities are represented by the existing manifest", async () => {
  const sources = JSON.parse(await readFile(sourcesPath, "utf8")) as { releases: Array<{ surveyId: string; releaseId: string; products: Array<{ product: string; status: string }> }> };
  const manifest = JSON.parse(await readFile(path.join(root, "src", "footprints", "survey-footprints.json"), "utf8")) as { footprints: Array<{ surveyId: string; releaseId: string; product: string }> };
  const identities = new Set(manifest.footprints.map((entry) => `${entry.surveyId}:${entry.releaseId}:${entry.product}`));
  const acquired = sources.releases.flatMap((release) => release.products.filter((product) => product.status === "acquired").map((product) => `${release.surveyId}:${release.releaseId}:${product.product}`));
  assert.equal(acquired.length, 12);
  assert.deepEqual(acquired.filter((identity) => !identities.has(identity)), []);
});

test("sync provenance records SHA256 values", async () => {
  const provenance = JSON.parse(await readFile(path.join(root, "artifacts", "public-survey-footprints", "provenance.json"), "utf8")) as { files: { manifest: { path: string; sha256: string }; catalog: { path: string; sha256: string } } };
  for (const file of [provenance.files.manifest, provenance.files.catalog]) assert.equal(createHash("sha256").update(await readFile(path.join(root, "artifacts", "public-survey-footprints", file.path))).digest("hex"), file.sha256);
});

test("manual footprint submission file starts empty and validates", async () => {
  const manual = JSON.parse(await readFile(path.join(root, "artifacts", "public-survey-footprints", "manual", "footprints.json"), "utf8")) as { schemaVersion: number; footprints: unknown[] };
  assert.equal(manual.schemaVersion, 1);
  assert.deepEqual(manual.footprints, []);
  await validate();
});
