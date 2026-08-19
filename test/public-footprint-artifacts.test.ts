import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { CURATED_SURVEYS } from "../src/survey-registry.js";
import { validate } from "../scripts/public_footprint_artifacts.js";

const root = process.cwd();
const assetRoot = process.env.ASTRO_PUBLIC_ASSETS_ROOT ?? path.resolve(root, "..", "Astro-Survey-Atlas-Assets");
const sourcesPath = path.join(assetRoot, "artifacts", "public-survey-footprints", "sources.json");

test("public sources cover every available release and product", async () => {
  const result = await validate();
  assert.equal(result.releases, CURATED_SURVEYS.flatMap((survey) => survey.releases.filter((release) => release.availability === "available")).length);
  assert.equal(result.acquired, 31);
  assert.equal(result.overview_only, 11);
  assert.equal(result.awaiting_geometry, 41);
  assert.equal(result.not_applicable, 0);
});

test("source records use four-state product status and contain no pixels", async () => {
  const sources = JSON.parse(await readFile(sourcesPath, "utf8")) as { releases: Array<{ products: Array<Record<string, unknown>> }> };
  for (const release of sources.releases) for (const product of release.products) {
    assert.ok(["acquired", "overview_only", "awaiting_geometry", "not_applicable"].includes(String(product.status)));
    assert.equal("pixels" in product, false);
    if (product.status !== "acquired") assert.equal(typeof product.reason, "string");
    if (product.status === "overview_only" || product.status === "awaiting_geometry") assert.equal(typeof product.manualStep, "string");
  }
});

test("all acquired identities are represented by the existing manifest", async () => {
  const sources = JSON.parse(await readFile(sourcesPath, "utf8")) as { releases: Array<{ surveyId: string; releaseId: string; products: Array<{ product: string; status: string }> }> };
  const manifest = JSON.parse(await readFile(path.join(root, "src", "footprints", "survey-footprints.json"), "utf8")) as { footprints: Array<{ surveyId: string; releaseId: string; product: string }> };
  const identities = new Set(manifest.footprints.map((entry) => `${entry.surveyId}:${entry.releaseId}:${entry.product}`));
  const acquired = sources.releases.flatMap((release) => release.products.filter((product) => product.status === "acquired").map((product) => `${release.surveyId}:${release.releaseId}:${product.product}`));
  assert.equal(acquired.length, 31);
  assert.deepEqual(acquired.filter((identity) => !identities.has(identity)), []);
});

test("sync provenance records input and output SHA256 values", async () => {
  const provenance = JSON.parse(await readFile(path.join(assetRoot, "artifacts", "public-survey-footprints", "provenance.json"), "utf8")) as { inputs: Record<string, { path: string; sha256: string }>; files: { manifest: { path: string; sha256: string }; catalog: { path: string; sha256: string } } };
  for (const file of [...Object.values(provenance.inputs), provenance.files.manifest, provenance.files.catalog]) assert.equal(createHash("sha256").update(await readFile(path.resolve(assetRoot, "artifacts", "public-survey-footprints", file.path))).digest("hex"), file.sha256);
});

test("manual footprint submission file starts empty and validates", async () => {
  const manual = JSON.parse(await readFile(path.join(assetRoot, "artifacts", "public-survey-footprints", "manual", "footprints.json"), "utf8")) as { schemaVersion: number; ordering: string; footprints: unknown[] };
  assert.equal(manual.schemaVersion, 1);
  assert.equal(manual.ordering, "NESTED");
  assert.deepEqual(manual.footprints, []);
  await validate();
});
