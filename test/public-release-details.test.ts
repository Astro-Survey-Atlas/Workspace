import assert from "node:assert/strict";
import test from "node:test";

import { buildPublicReleaseDetails } from "../src/public-release-details.js";
import { CURATED_SURVEYS, type SurveyRecord } from "../src/survey-registry.js";
import type { SurveyFootprintManifest } from "../src/survey-footprints.js";

const survey: SurveyRecord = {
  id: "demo", name: "Demo", mission: "Demo Scope", color: "#fff", description: "Demo", modalities: ["imaging"], origin: "curated",
  releases: [{
    id: "demo-r1", label: "R1", kind: "public_release", availability: "available", modalities: ["imaging", "spectroscopy"],
    products: [
      { name: "Imaging", modality: "imaging", description: "Images" },
      { name: "Spectra", modality: "spectroscopy", description: "Spectra" },
    ],
    coverage: { status: "summary_only", summary: "Public release", sourceUrl: "https://example.test/r1" },
  }],
};

const manifest: SurveyFootprintManifest = {
  schemaVersion: 1, generatedAt: "2026-08-12T00:00:00.000Z", coordinateFrame: "ICRS", nside: 16,
  footprints: [{ surveyId: "demo", releaseId: "demo-r1", product: "Imaging", label: "Imaging", nside: 16, pixels: [1], quality: "moc", sourceUrl: "https://example.test/moc", retrievedAt: "2026-08-12T00:00:00.000Z", notes: "test" }],
};

test("release details only mark products with real geometry as acquired", () => {
  const details = buildPublicReleaseDetails([survey], [
    { surveyId: "demo", releaseId: "demo-r1", product: "Imaging", status: "acquired", sourceUrl: "https://example.test/moc" },
    { surveyId: "demo", releaseId: "demo-r1", product: "Spectra", status: "awaiting_geometry", sourceUrl: "https://example.test/r1", reason: "Official geometry has not been acquired." },
  ], manifest);
  assert.equal(details[0]?.products[0]?.coverageStatus, "acquired");
  assert.equal(details[0]?.products[1]?.coverageStatus, "awaiting_geometry");
  assert.equal(details[0]?.products[1]?.reason, "Official geometry has not been acquired.");
});

test("official overview artifacts remain overview-only", () => {
  const overviewManifest: SurveyFootprintManifest = {
    ...manifest,
    footprints: manifest.footprints.map((footprint) => ({ ...footprint, quality: "official_overview" as const })),
  };
  const details = buildPublicReleaseDetails([survey], [
    { surveyId: "demo", releaseId: "demo-r1", product: "Imaging", status: "overview_only", sourceUrl: "https://example.test/overview" },
  ], overviewManifest);
  assert.equal(details[0]?.products[0]?.coverageStatus, "overview_only");
});

test("not-applicable ledger entries remain not applicable without geometry", () => {
  const details = buildPublicReleaseDetails([survey], [
    { surveyId: "demo", releaseId: "demo-r1", product: "Spectra", status: "not_applicable", sourceUrl: "https://example.test/r1", reason: "No spatial product exists." },
  ], { ...manifest, footprints: [] });
  assert.equal(details[0]?.products[1]?.coverageStatus, "not_applicable");
});

test("every available curated release has one stable detail entry", () => {
  const emptyManifest: SurveyFootprintManifest = {
    schemaVersion: 1,
    generatedAt: "2026-08-12T00:00:00.000Z",
    coordinateFrame: "ICRS",
    nside: 16,
    footprints: [],
  };
  const details = buildPublicReleaseDetails(CURATED_SURVEYS, [], emptyManifest);
  const available = CURATED_SURVEYS.flatMap((entry) => entry.releases
    .filter((release) => release.availability === "available")
    .map((release) => `${entry.id}:${release.id}`));
  assert.equal(details.length, 48);
  assert.deepEqual(new Set(details.map((detail) => `${detail.surveyId}:${detail.releaseId}`)), new Set(available));
});
