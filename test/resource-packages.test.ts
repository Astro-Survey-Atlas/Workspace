import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import yazl from "yazl";

import { ResourceCatalogUnavailableError, ResourcePackageManager, resourcePackageSurveyRecords, type ResourcePackageJob } from "../src/resource-packages.js";
import type { SurveyFootprintManifest } from "../src/survey-footprints.js";

const now = "2026-07-24T00:00:00.000Z";

function fitsMoc(): Buffer {
  const card = (key: string, value: string) => Buffer.from(`${key.padEnd(8, " ")}= ${value.padEnd(70, " ").slice(0, 70)}`.padEnd(80, " "), "ascii");
  const header = Buffer.concat([card("SIMPLE", "                    T"), card("BITPIX", "                    32"), card("NAXIS", "                     1"), card("NAXIS1", "                     1"), card("EXTNAME", "'MOC'"), card("MOCVERS", "'1.1'"), card("TTYPE1", "'NUNIQ'"), Buffer.from("END".padEnd(80, " "), "ascii")]);
  const padded = Buffer.concat([header, Buffer.alloc(Math.ceil(header.length / 2880) * 2880 - header.length)]);
  const data = Buffer.alloc(2880); data.writeInt32BE(1024, 0);
  return Buffer.concat([padded, data]);
}

function manifestFor(surveyId: string, releases: string[], nside = 16, quality: "moc" | "official_overview" = "moc"): SurveyFootprintManifest {
  const footprints = releases.map((releaseId, index) => ({
    surveyId,
    releaseId,
    product: `product-${index}`,
    label: `Fixture ${surveyId}`,
    nside,
    pixels: [index, index + 1],
    quality,
    sourceUrl: "https://example.test/coverage",
    retrievedAt: now,
    notes: "test fixture",
  }));
  return { schemaVersion: 1, generatedAt: now, coordinateFrame: "ICRS", nside, footprints };
}

interface PackageFixture {
  id: string;
  version: string;
  surveyId: string;
  archivePath: string;
  sizeBytes: number;
  sha256: string;
  releases: string[];
}

async function createPackage(directory: string, id: string, surveyId: string, options: { unsafeSymlink?: boolean; missingFile?: string; footprintSurveyId?: string; version?: string; releases?: string[]; reviewedPreview?: boolean; previewOrdering?: string; previewLayerId?: string; layerId?: string; nside?: number; quality?: "moc" | "official_overview"; includeHealpix?: boolean; layerMaxOrder?: number; sidecarPrecision?: "exact" | "estimated" | "unknown"; sidecarCompleteness?: "complete" | "incomplete" | "unknown"; omitEligibleLayerAtOrder8?: boolean; invalidHealpixManifestPath?: boolean; tamperHealpixHash?: boolean; extraHealpixPath?: boolean; healpixOrder4?: Record<string, unknown>; healpixOrder8?: Record<string, unknown> } = {}): Promise<PackageFixture> {
  const version = options.version ?? "3.0.0";
  const releases = options.releases ?? ["release-a", "release-b"];
  const mocBytes = fitsMoc();
  const layerId = options.layerId ?? `${surveyId}-coverage`;
  const footprints = manifestFor(options.footprintSurveyId ?? surveyId, releases, options.nside, options.quality);
  const preview = options.reviewedPreview ? { schemaVersion: 1, coordinateFrame: "ICRS", ordering: options.previewOrdering ?? "NESTED", generatedAt: now, footprints: footprints.footprints.map(f => ({ surveyId: f.surveyId, releaseId: f.releaseId, product: f.product, layerId: options.previewLayerId ?? layerId, nside: f.nside, pixels: f.pixels })) } : footprints;
  const footprintBytes = Buffer.from(`${JSON.stringify(preview, null, 2)}\n`);
  const provenanceBytes = Buffer.from(JSON.stringify({ schemaVersion: 3, version: "3.0.0", files: [] }));
  const readmeBytes = Buffer.from("# README\n");
  const layer = { layerId, maxOrder: options.layerMaxOrder ?? 8, surveyId, releaseId: releases[0]!, productId: `${surveyId}-product`, sourceId: `${surveyId}-source`, product: `Fixture ${surveyId}`, coverageRole: "image_extent", dataOrigin: "observed", sourceTier: "official_geometry", modality: "imaging", path: `mocs/${layerId}.moc.fits`, sizeBytes: mocBytes.length, sha256: createHash("sha256").update(mocBytes).digest("hex") };
  const sidecar = (order: 4 | 8) => {
    const omitted = layer.maxOrder < order || (order === 8 && options.omitEligibleLayerAtOrder8 === true);
    const precision = options.sidecarPrecision ?? "estimated";
    const completeness = options.sidecarCompleteness ?? "complete";
    const cells = omitted ? [] : [1, 2];
    const layerEntry = { layerId: layer.layerId, surveyId, releaseId: layer.releaseId, productId: layer.productId, sourceId: layer.sourceId, product: layer.product, cells, precision, completeness };
    const omittedLayers = omitted ? [{ layerId: layer.layerId, reason: `Native MOC maximum is O${layer.maxOrder}; no O${order} list is produced for this layer.` }] : [];
    const unionPrecision = omitted ? "unknown" : precision;
    const unionCompleteness = omitted || completeness === "incomplete" ? "incomplete" : completeness;
    return {
      schemaVersion: 1,
      surveyId,
      packageId: id,
      packageVersion: version,
      revision: `${id}@${version}:coverage`,
      coordinateFrame: "ICRS",
      ordering: "NESTED",
      order,
      layers: omitted ? [] : [layerEntry],
      surveyUnion: { cells, precision: unionPrecision, completeness: unionCompleteness, omittedLayers },
    };
  };
  const healpixFiles = options.includeHealpix ? [
    { path: "healpix/order4.json", bytes: Buffer.from(`${JSON.stringify(options.healpixOrder4 ?? sidecar(4), null, 2)}\n`) },
    { path: "healpix/order8.json", bytes: Buffer.from(`${JSON.stringify(options.healpixOrder8 ?? sidecar(8), null, 2)}\n`) },
  ] : [];
  const packageManifest = {
    schemaVersion: 3,
    version,
    id,
    surveyId,
    files: [
      { path: "README.md", sizeBytes: readmeBytes.length, sha256: createHash("sha256").update(readmeBytes).digest("hex") },
      { path: "footprints/survey-footprints.json", sizeBytes: footprintBytes.length, sha256: createHash("sha256").update(footprintBytes).digest("hex") },
      { path: "provenance.json", sizeBytes: provenanceBytes.length, sha256: createHash("sha256").update(provenanceBytes).digest("hex") },
      ...healpixFiles.map(({ path: filePath, bytes }) => ({ path: options.invalidHealpixManifestPath ? "healpix/order16.json" : filePath, sizeBytes: bytes.length, sha256: options.tamperHealpixHash && filePath === "healpix/order4.json" ? "0".repeat(64) : createHash("sha256").update(bytes).digest("hex") })),
    ],
    layers: [layer],
  };
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from(`${JSON.stringify(packageManifest, null, 2)}\n`), "resource-package.json");
  zip.addBuffer(footprintBytes, "footprints/survey-footprints.json");
  zip.addBuffer(mocBytes, layer.path);
  zip.addBuffer(provenanceBytes, "provenance.json");
  for (const file of healpixFiles) zip.addBuffer(file.bytes, file.path);
  if (options.extraHealpixPath) zip.addBuffer(Buffer.from("{}\n"), "healpix/order16.json");
  if (options.unsafeSymlink) zip.addBuffer(Buffer.from("evil"), "evil-link", { mode: 0o120777 });
  if (options.missingFile !== "README.md") zip.addBuffer(readmeBytes, "README.md");
  if (options.missingFile === "footprints/survey-footprints.json") zip.addBuffer(Buffer.from("{}"), "footprints/survey-footprints.json");
  if (options.missingFile === "resource-package.json") zip.addBuffer(Buffer.from("{}"), "resource-package.json");
  const archivePath = path.join(directory, `${id}-${version}.zip`);
  zip.end();
  await new Promise<void>((resolve, reject) => zip.outputStream.pipe(createWriteStream(archivePath)).once("close", resolve).once("error", reject));
  const bytes = await readFile(archivePath);
  return { id, version, surveyId, archivePath, sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), releases };
}

async function writeCatalog(directory: string, packages: { id: string; surveyId: string; archivePath: string; sizeBytes: number; sha256: string; releases?: string[]; version?: string; updatedAt?: string }[], tamperSha256 = false): Promise<string> {
  const entries = packages.map((entry) => ({
    id: entry.id,
    name: `Fixture ${entry.id}`,
    description: "Test fixture package",
    surveyId: entry.surveyId,
    modalities: ["imaging"],
    wavelengths: ["optical"],
    productTypes: ["image"],
    facilities: ["fixture-observatory"],
    coverageAuthorities: ["official-moc"],
    accessModes: ["public-archive"],
    releases: entry.releases ?? ["fixture-release"],
    releaseLabels: Object.fromEntries((entry.releases ?? ["fixture-release"]).map((releaseId) => [releaseId, releaseId.toUpperCase()])),
    sources: (entry.releases ?? ["fixture-release"]).map((releaseId) => ({ releaseId, label: "Fixture source", url: "https://example.test/coverage", authority: "official-moc" })),
    version: entry.version ?? "3.0.0",
    archiveUrl: path.basename(entry.archivePath),
    sizeBytes: entry.sizeBytes,
    sha256: tamperSha256 ? "0".repeat(64) : entry.sha256,
    updatedAt: entry.updatedAt ?? now,
  }));
  const catalogPath = path.join(directory, "catalog.json");
  await writeFile(catalogPath, `${JSON.stringify({ schemaVersion: 3, version: "3.0.0", generatedAt: now, packages: entries }, null, 2)}\n`, "utf8");
  return pathToFileURL(catalogPath).href;
}

interface Fixture {
  directory: string;
  root: string;
  statePath: string;
  catalogUrl: string;
  manager: ResourcePackageManager;
  packages: PackageFixture[];
}

async function fixture(options: { tamperSha256?: boolean; unsafeSymlink?: boolean; missingFile?: string; footprintSurveyId?: string; nside?: number; quality?: "moc" | "official_overview" } = {}): Promise<Fixture> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-resource-packages-"));
  const root = path.join(directory, "resource-packages");
  const statePath = path.join(directory, "state", "resource-package-state.json");
  const packages = [
    await createPackage(directory, "public-legacy-surveys-footprints", "legacy-surveys", options),
    await createPackage(directory, "public-galex-footprints", "galex"),
  ];
  const catalogUrl = await writeCatalog(directory, packages, options.tamperSha256);
  const manager = new ResourcePackageManager({ catalogUrl, root, statePath });
  await manager.initialize();
  return { directory, root, statePath, catalogUrl, manager, packages };
}

async function waitForJob(manager: ResourcePackageManager, job: ResourcePackageJob): Promise<ResourcePackageJob> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const current = manager.job(job.id);
    if (current.status === "completed" || current.status === "failed") return current;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for resource package job");
}

test("invalid or unavailable Assets catalogs keep the service alive and expose 503 state", async () => {
  const paths = await fixture();
  try {
    const snapshotRoot = path.join(paths.directory, "state");
    const seeded = new ResourcePackageManager({ catalogUrl: paths.catalogUrl, root: paths.root, statePath: paths.statePath, snapshotRoot });
    await seeded.initialize();
    const offline = new ResourcePackageManager({
      catalogUrl: pathToFileURL(path.join(paths.directory, "missing-catalog.json")).href,
      root: paths.root,
      statePath: paths.statePath,
      snapshotRoot,
    });
    await offline.initialize();
    assert.equal(offline.available, true);
    assert.equal(offline.list().length, 2);

    const noSnapshot = new ResourcePackageManager({
      catalogUrl: pathToFileURL(path.join(paths.directory, "missing-catalog-2.json")).href,
      root: path.join(paths.directory, "empty-root"),
      statePath: path.join(paths.directory, "empty-state.json"),
    });
    await noSnapshot.initialize();
    assert.equal(noSnapshot.available, false);
    assert.throws(() => noSnapshot.list(), ResourceCatalogUnavailableError);
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

test("catalog sync tolerates sources referencing undeclared releases instead of failing the whole catalog", async () => {
  const paths = await fixture();
  try {
    const catalogPath = paths.catalogUrl.replace("file://", "");
    const catalog = JSON.parse(await readFile(catalogPath, "utf8")) as { packages: Array<{ sources: Array<Record<string, string>> }> };
    catalog.packages[0]!.sources.push({ releaseId: "undeclared-release", label: "2MASS-like HiPS MOC", url: "https://example.test/moc", authority: "official-moc" });
    await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");

    const status = await paths.manager.sync();
    assert.equal(status.available, true);
    assert.equal(paths.manager.list().length, 2);
    assert.ok(paths.manager.get("public-legacy-surveys-footprints").sources.every((source) => source.releaseId !== "undeclared-release"));
    assert.ok(paths.manager.get("public-galex-footprints").sources.every((source) => source.releaseId !== "undeclared-release"));
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

test("explicit catalog sync trusts v3 metadata without downloading package archives", async () => {
  const paths = await fixture();
  try {
    const snapshotRoot = path.join(paths.directory, "snapshot-state");
    const manager = new ResourcePackageManager({ catalogUrl: paths.catalogUrl, root: paths.root, statePath: paths.statePath, snapshotRoot });
    await manager.initialize();
    const before = await readdir(path.join(paths.root, "downloads"));
    const status = await manager.sync();
    assert.equal(status.available, true);
    assert.equal(status.catalogSha256?.length, 64);
    assert.equal(manager.list().length, 2);
    assert.deepEqual(await readdir(path.join(paths.root, "downloads")), before);
    assert.ok((await readFile(path.join(snapshotRoot, "assets-current", "catalog.json"), "utf8")).includes('"schemaVersion": 3'));

    await writeFile(paths.catalogUrl.replace("file://", ""), "{\"schemaVersion\":1}\n", "utf8");
    await assert.rejects(() => manager.sync(), /Assets catalog sync failed/);
    assert.equal(manager.available, true);
    assert.equal(manager.list().length, 2);
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

test("catalog sync accepts sparse release labels and falls back to the release id", async () => {
  const paths = await fixture();
  try {
    const catalogPath = paths.catalogUrl.replace("file://", "");
    const catalog = JSON.parse(await readFile(catalogPath, "utf8")) as { packages: Array<{ releaseLabels: Record<string, string> }> };
    delete catalog.packages[0]!.releaseLabels["release-b"];
    await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");

    const status = await paths.manager.sync();
    assert.equal(status.available, true);
    const record = resourcePackageSurveyRecords([paths.manager.get("public-legacy-surveys-footprints")])[0]!;
    assert.equal(record.releases.find((release) => release.id === "release-a")?.label, "RELEASE-A");
    assert.equal(record.releases.find((release) => release.id === "release-b")?.label, "release-b");
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

test("catalog accepts an explicit empty replacement list from dynamic Assets packages", async () => {
  const paths = await fixture();
  try {
    const catalogPath = paths.catalogUrl.replace("file://", "");
    const catalog = JSON.parse(await readFile(catalogPath, "utf8")) as { packages: Array<{ replacedBy?: string[] }> };
    catalog.packages[0]!.replacedBy = [];
    await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
    const manager = new ResourcePackageManager({ catalogUrl: paths.catalogUrl, root: paths.root, statePath: paths.statePath });
    await manager.initialize();
    assert.equal(manager.available, true);
    assert.equal(manager.list()[0]?.replacedBy.length, 0);
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

test("resource packages list lifecycle status and survive a registry restart", async () => {
  const paths = await fixture();
  try {
    const initial = paths.manager.list();
    assert.equal(initial.length, 2);
    assert.ok(initial.every((entry) => entry.status === "not_installed" && entry.active === false));
    assert.ok(initial.every((entry) => entry.availableReleaseIds.length === 0 && entry.activeReleaseIds.length === 0));

    const job = await waitForJob(paths.manager, paths.manager.install("public-legacy-surveys-footprints"));
    assert.equal(job.status, "completed");
    const installed = paths.manager.get("public-legacy-surveys-footprints");
    assert.equal(installed.status, "installed");
    assert.equal(installed.installedVersion, "3.0.0");
    assert.deepEqual(installed.availableReleaseIds, ["release-a", "release-b"]);

    await paths.manager.activate("public-legacy-surveys-footprints");
    assert.equal(paths.manager.get("public-legacy-surveys-footprints").status, "active");
    await waitForJob(paths.manager, paths.manager.install("public-galex-footprints"));
    await paths.manager.activate("public-galex-footprints");

    const reloaded = new ResourcePackageManager({ catalogUrl: paths.catalogUrl, root: paths.root, statePath: paths.statePath });
    await reloaded.initialize();
    assert.equal(reloaded.get("public-legacy-surveys-footprints").status, "active");
    assert.equal(reloaded.get("public-galex-footprints").status, "active");

    await reloaded.remove("public-legacy-surveys-footprints");
    assert.equal(reloaded.get("public-legacy-surveys-footprints").status, "not_installed");
    assert.ok((await reloaded.activeFootprints()).footprints.every((footprint) => footprint.surveyId === "galex"));

    const restarted = new ResourcePackageManager({ catalogUrl: paths.catalogUrl, root: paths.root, statePath: paths.statePath });
    await restarted.initialize();
    assert.equal(restarted.get("public-legacy-surveys-footprints").status, "not_installed");
    assert.equal(restarted.get("public-galex-footprints").status, "active");
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

test("exposes only manifest-declared native MOCs from an installed package", async () => {
  const paths = await fixture();
  try {
    await waitForJob(paths.manager, paths.manager.install("public-legacy-surveys-footprints"));
    const layers = await paths.manager.mocLayers("public-legacy-surveys-footprints");
    assert.deepEqual(layers.map((layer) => ({ layerId: layer.layerId, releaseId: layer.releaseId, path: layer.path })), [
      { layerId: "legacy-surveys-coverage", releaseId: "release-a", path: "mocs/legacy-surveys-coverage.moc.fits" },
    ]);
    assert.equal(layers[0]?.byteLength, fitsMoc().length);
    const artifact = await paths.manager.mocArtifact("public-legacy-surveys-footprints", "legacy-surveys-coverage");
    assert.equal((await readFile(artifact.filePath)).length, fitsMoc().length);
    assert.equal(artifact.sha256, createHash("sha256").update(fitsMoc()).digest("hex"));
    const original = await readFile(artifact.filePath);
    const tampered = Buffer.from(original);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;
    await writeFile(artifact.filePath, tampered);
    await assert.rejects(() => paths.manager.mocArtifact("public-legacy-surveys-footprints", "legacy-surveys-coverage"), /SHA-256 does not match/);
    await assert.rejects(() => paths.manager.mocArtifact("public-legacy-surveys-footprints", "../outside"), /MOC layer not found/);
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

test("public survey metadata stays a read-only package projection", async () => {
  const paths = await fixture();
  try {
    const packages = paths.manager.list();
    const records = resourcePackageSurveyRecords(packages);
    assert.deepEqual(records.map((record) => record.id).sort(), ["galex", "legacy-surveys"]);
    assert.ok(records.every((record) => record.origin === "public"));
    assert.equal(records.find((record) => record.id === "legacy-surveys")?.releases[0]?.label, "RELEASE-A");
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

test("Assets survey metadata exposes pending releases without making them loadable", async () => {
  const paths = await fixture();
  try {
    const surveyPath = path.join(paths.directory, "surveys.json");
    await writeFile(surveyPath, `${JSON.stringify({
      schemaVersion: 1,
      generatedAt: now,
      surveys: [{
        id: "legacy-surveys",
        name: "Legacy Surveys",
        mission: "Fixture mission",
        color: "#123456",
        description: "",
        // The public Assets projection may omit aggregate modalities; release
        // metadata remains authoritative for the package projection.
        modalities: [],
        releases: [
          {
            id: "release-a",
            label: "Release A",
            kind: "early_release",
            releasedYear: null,
            modalities: ["imaging"],
            products: [{ name: "Fixture image", modality: "imaging", description: "Acquired geometry", status: "acquired", sourceUrl: "/api/v1/coverage/example", geometrySourceUrl: null, reason: null, manualStep: null }],
          },
          {
            id: "release-b",
            label: "Release B",
            kind: "early_release",
            modalities: ["imaging"],
            products: [{ name: "Fixture pending image", modality: "imaging", description: "Geometry is pending", status: "awaiting_geometry", sourceUrl: "" }],
          },
        ],
      }],
    }, null, 2)}\n`, "utf8");
    const snapshotRoot = path.join(paths.directory, "snapshot-state");
    const manager = new ResourcePackageManager({
      catalogUrl: paths.catalogUrl,
      surveyCatalogUrl: pathToFileURL(surveyPath).href,
      root: paths.root,
      statePath: paths.statePath,
      snapshotRoot,
    });
    await manager.initialize();
    const packageRecord = manager.get("public-legacy-surveys-footprints");
    assert.deepEqual(packageRecord.releases, ["release-a", "release-b"]);
    assert.deepEqual(packageRecord.publicReleases?.map((release) => release.id), ["release-a", "release-b"]);
    assert.equal(packageRecord.surveyColor, "#123456");
    const record = resourcePackageSurveyRecords([packageRecord])[0]!;
    assert.equal(record.color, "#123456");
    assert.deepEqual(record.releases.map((release) => [release.id, release.availability, release.coverage.status]), [
      ["release-a", "available", "verified"],
      ["release-b", "metadata_only", "pending"],
    ]);
    assert.ok((await readFile(path.join(snapshotRoot, "assets-current", "surveys.json"), "utf8")).includes("Release B"));

    const offline = new ResourcePackageManager({
      catalogUrl: pathToFileURL(path.join(paths.directory, "missing-catalog.json")).href,
      root: paths.root,
      statePath: paths.statePath,
      snapshotRoot,
    });
    await offline.initialize();
    assert.deepEqual(offline.get("public-legacy-surveys-footprints").publicReleases?.map((release) => release.id), ["release-a", "release-b"]);
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

test("official overview releases are selectable and retain their coverage label", async () => {
  const paths = await fixture({ quality: "official_overview" });
  try {
    await waitForJob(paths.manager, paths.manager.install("public-legacy-surveys-footprints"));
    const state = JSON.parse(await readFile(paths.statePath, "utf8")) as { packages: Array<{ id: string; activeReleaseIds: string[] }> };
    state.packages.find((record) => record.id === "public-legacy-surveys-footprints")!.activeReleaseIds = ["release-a"];
    await writeFile(paths.statePath, `${JSON.stringify({ schemaVersion: 3, packages: state.packages }, null, 2)}\n`, "utf8");

    const restarted = new ResourcePackageManager({ catalogUrl: paths.catalogUrl, root: paths.root, statePath: paths.statePath });
    await restarted.initialize();
    const record = restarted.get("public-legacy-surveys-footprints");
    assert.equal(record.status, "active");
    assert.deepEqual(record.availableReleaseIds, ["release-a", "release-b"]);
    assert.deepEqual(record.activeReleaseIds, ["release-a"]);
    const active = await restarted.activeFootprints();
    assert.equal(active.footprints.length, 1);
    assert.equal(active.footprints[0]!.quality, "official_overview");
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

test("setActive loads individual releases, supports an empty selection, and survives restart", async () => {
  const paths = await fixture();
  try {
    assert.deepEqual((await paths.manager.activeFootprints()).footprints, []);
    await waitForJob(paths.manager, paths.manager.install("public-legacy-surveys-footprints"));
    await waitForJob(paths.manager, paths.manager.install("public-galex-footprints"));
    await paths.manager.setActive([{ packageId: "public-galex-footprints", releaseIds: ["release-b"] }]);
    let active = await paths.manager.activeFootprints();
    assert.equal(active.footprints.length, 1);
    assert.equal(active.footprints[0]!.surveyId, "galex");
    assert.equal(active.footprints[0]!.releaseId, "release-b");
    assert.deepEqual(paths.manager.get("public-galex-footprints").activeReleaseIds, ["release-b"]);

    await paths.manager.setActive([
      { packageId: "public-legacy-surveys-footprints", releaseIds: ["release-a"] },
      { packageId: "public-galex-footprints", releaseIds: ["release-b"] },
    ]);
    active = await paths.manager.activeFootprints();
    assert.equal(active.footprints.length, 2);
    assert.deepEqual(active.footprints.map((footprint) => footprint.surveyId).sort(), ["galex", "legacy-surveys"]);

    const restarted = new ResourcePackageManager({ catalogUrl: paths.catalogUrl, root: paths.root, statePath: paths.statePath });
    await restarted.initialize();
    assert.deepEqual(restarted.get("public-legacy-surveys-footprints").activeReleaseIds, ["release-a"]);
    assert.deepEqual(restarted.get("public-galex-footprints").activeReleaseIds, ["release-b"]);

    await restarted.setActive([]);
    assert.deepEqual((await restarted.activeFootprints()).footprints, []);
    assert.ok(restarted.list().every((record) => !record.active && record.activeReleaseIds.length === 0));
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

test("setActive validates the complete draft atomically", async () => {
  const paths = await fixture();
  try {
    await waitForJob(paths.manager, paths.manager.install("public-legacy-surveys-footprints"));
    await paths.manager.setActive([{ packageId: "public-legacy-surveys-footprints", releaseIds: ["release-a"] }]);
    const stateBeforeFailure = await readFile(paths.statePath, "utf8");

    await assert.rejects(
      () => paths.manager.setActive([
        { packageId: "public-legacy-surveys-footprints", releaseIds: ["release-b"] },
        { packageId: "public-galex-footprints", releaseIds: ["release-a"] },
      ]),
      /must be installed before loading/,
    );
    assert.deepEqual(paths.manager.get("public-legacy-surveys-footprints").activeReleaseIds, ["release-a"]);
    await assert.rejects(() => paths.manager.setActive([{ packageId: "missing-package", releaseIds: ["release-a"] }]), /Resource package not found/);
    await assert.rejects(() => paths.manager.setActive([{ packageId: "public-legacy-surveys-footprints", releaseIds: ["unknown"] }]), /Unknown release/);
    await assert.rejects(() => paths.manager.setActive([
      { packageId: "public-legacy-surveys-footprints", releaseIds: ["release-a"] },
      { packageId: "public-legacy-surveys-footprints", releaseIds: ["release-b"] },
    ]), /unique resource package ids/);
    assert.deepEqual(paths.manager.get("public-legacy-surveys-footprints").activeReleaseIds, ["release-a"]);
    assert.equal(await readFile(paths.statePath, "utf8"), stateBeforeFailure);
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

test("setActive rejects incompatible nside without changing the prior selection", async () => {
  const paths = await fixture({ nside: 32 });
  try {
    await waitForJob(paths.manager, paths.manager.install("public-legacy-surveys-footprints"));
    await waitForJob(paths.manager, paths.manager.install("public-galex-footprints"));
    await paths.manager.setActive([{ packageId: "public-legacy-surveys-footprints", releaseIds: ["release-a"] }]);

    await assert.rejects(() => paths.manager.setActive([
      { packageId: "public-legacy-surveys-footprints", releaseIds: ["release-a"] },
      { packageId: "public-galex-footprints", releaseIds: ["release-a"] },
    ]), /incompatible HEALPix resolutions/);
    assert.deepEqual(paths.manager.get("public-legacy-surveys-footprints").activeReleaseIds, ["release-a"]);
    assert.deepEqual(paths.manager.get("public-galex-footprints").activeReleaseIds, []);
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

test("initialize rejects legacy active state after the v3 cutover", async () => {
  const paths = await fixture();
  try {
    await waitForJob(paths.manager, paths.manager.install("public-legacy-surveys-footprints"));
    const current = JSON.parse(await readFile(paths.statePath, "utf8")) as { packages: Array<Record<string, unknown>> };
    await writeFile(paths.statePath, `${JSON.stringify({
      schemaVersion: 1,
      packages: current.packages.map(({ activeReleaseIds: _activeReleaseIds, ...record }) => ({ ...record, active: true })),
    }, null, 2)}\n`, "utf8");

    const migrated = new ResourcePackageManager({ catalogUrl: paths.catalogUrl, root: paths.root, statePath: paths.statePath });
    await assert.rejects(() => migrated.initialize(), /unsupported schema/);
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

test("updating a package preserves only selected releases still installed", async () => {
  const paths = await fixture();
  try {
    await waitForJob(paths.manager, paths.manager.install("public-legacy-surveys-footprints"));
    await paths.manager.setActive([{ packageId: "public-legacy-surveys-footprints", releaseIds: ["release-a", "release-b"] }]);

    const updated = await createPackage(paths.directory, "public-legacy-surveys-footprints", "legacy-surveys", { version: "3.1.0", releases: ["release-b", "release-c"] });
    await writeCatalog(paths.directory, [updated, paths.packages[1]!]);
    const updater = new ResourcePackageManager({ catalogUrl: paths.catalogUrl, root: paths.root, statePath: paths.statePath });
    await updater.initialize();
    assert.equal(updater.get(updated.id).status, "update_available");
    assert.equal(updater.get(updated.id).active, true);
    await assert.rejects(() => updater.setActive([{ packageId: updated.id, releaseIds: ["release-b"] }]), /version must be current/);

    const result = await waitForJob(updater, updater.install(updated.id));
    assert.equal(result.status, "completed");
    const record = updater.get(updated.id);
    assert.equal(record.installedVersion, "3.1.0");
    assert.deepEqual(record.availableReleaseIds, ["release-b", "release-c"]);
    assert.deepEqual(record.activeReleaseIds, ["release-b"]);
    assert.equal(record.activeReleaseIds.includes("release-c"), false);
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

test("loading a current package preserves unchanged trusted selections in unrelated older packages", async () => {
  const paths = await fixture();
  try {
    await waitForJob(paths.manager, paths.manager.install("public-legacy-surveys-footprints"));
    await paths.manager.activate("public-legacy-surveys-footprints");
    const older = paths.manager.get("public-legacy-surveys-footprints");
    const updated = await createPackage(paths.directory, older.id, "legacy-surveys", { version: "3.1.0", releases: ["release-b", "release-c"] });
    await writeCatalog(paths.directory, [updated, paths.packages[1]!]);
    await paths.manager.sync();
    await waitForJob(paths.manager, paths.manager.install(paths.packages[1]!.id));
    await paths.manager.activate(paths.packages[1]!.id);
    assert.deepEqual(paths.manager.get(older.id).activeReleaseIds, older.activeReleaseIds);
    assert.equal(paths.manager.get(older.id).installedVersion, older.installedVersion);
    assert.equal(paths.manager.get(older.id).status, "update_available");
    await assert.rejects(() => paths.manager.setActive([{ packageId: older.id, releaseIds: ["release-b"] }]), /version must be current/);
  } finally { await rm(paths.directory, { recursive: true, force: true }); }
});

test("same-version catalog checksum changes preserve the old install as update available", async () => {
  const paths = await fixture();
  try {
    await waitForJob(paths.manager, paths.manager.install("public-legacy-surveys-footprints"));
    const catalogPath = paths.catalogUrl.replace("file://", "");
    const catalog = JSON.parse(await readFile(catalogPath, "utf8")) as { packages: Array<{ id: string; sha256: string }> };
    catalog.packages[0]!.sha256 = "0".repeat(64);
    await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");

    const status = await paths.manager.sync();
    assert.equal(status.available, true);
    assert.equal(paths.manager.get("public-legacy-surveys-footprints").status, "update_available");

    const restarted = new ResourcePackageManager({ catalogUrl: paths.catalogUrl, root: paths.root, statePath: paths.statePath });
    await restarted.initialize();
    assert.equal(restarted.get("public-legacy-surveys-footprints").status, "update_available");
    await assert.rejects(
      () => restarted.setActive([{ packageId: "public-legacy-surveys-footprints", releaseIds: ["release-a"] }]),
      /checksum must be current/,
    );
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

test("install validates the catalog checksum and rejects tampered archives", async () => {
  const paths = await fixture({ tamperSha256: true });
  try {
    const job = await waitForJob(paths.manager, paths.manager.install("public-legacy-surveys-footprints"));
    assert.equal(job.status, "failed");
    assert.match(job.error ?? "", /SHA-256 does not match/);
    assert.equal(paths.manager.get("public-legacy-surveys-footprints").status, "not_installed");
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

test("install rejects symlink entries and missing required files", async () => {
  const symlink = await fixture({ unsafeSymlink: true });
  try {
    const job = await waitForJob(symlink.manager, symlink.manager.install("public-legacy-surveys-footprints"));
    assert.equal(job.status, "failed");
    assert.match(job.error ?? "", /unsafe ZIP entry/);
  } finally {
    await rm(symlink.directory, { recursive: true, force: true });
  }

  const missing = await fixture({ missingFile: "README.md" });
  try {
    const job = await waitForJob(missing.manager, missing.manager.install("public-legacy-surveys-footprints"));
    assert.equal(job.status, "failed");
    assert.match(job.error ?? "", /missing required files/);
  } finally {
    await rm(missing.directory, { recursive: true, force: true });
  }
});

test("install rejects packages whose footprints do not match the declared survey", async () => {
  const paths = await fixture({ footprintSurveyId: "sdss" });
  try {
    const job = await waitForJob(paths.manager, paths.manager.install("public-legacy-surveys-footprints"));
    assert.equal(job.status, "failed");
    assert.match(job.error ?? "", /do not match its survey/);
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

test("unknown package and unknown job are not found errors", async () => {
  const paths = await fixture();
  try {
    assert.throws(() => paths.manager.install("does-not-exist"), /Resource package not found/);
    assert.throws(() => paths.manager.job("missing-job"), /Resource package job not found/);
    await assert.rejects(() => paths.manager.activate("does-not-exist"), /Resource package is not installed/);
    await assert.rejects(() => paths.manager.deactivate("does-not-exist"), /Resource package is not installed/);
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

test("concurrent installs of distinct packages both complete and persist", async () => {
  const paths = await fixture();
  try {
    const jobs = [paths.manager.install("public-legacy-surveys-footprints"), paths.manager.install("public-galex-footprints")];
    const results = await Promise.all(jobs.map((job) => waitForJob(paths.manager, job)));
    assert.ok(results.every((job) => job.status === "completed"));

    const reloaded = new ResourcePackageManager({ catalogUrl: paths.catalogUrl, root: paths.root, statePath: paths.statePath });
    await reloaded.initialize();
    assert.equal(reloaded.get("public-legacy-surveys-footprints").installedVersion, "3.0.0");
    assert.equal(reloaded.get("public-galex-footprints").installedVersion, "3.0.0");
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

test("installed state that is absent from the trusted catalog fails initialization", async () => {
  const paths = await fixture();
  try {
    await waitForJob(paths.manager, paths.manager.install("public-legacy-surveys-footprints"));
    await writeCatalog(paths.directory, []);
    const manager = new ResourcePackageManager({ catalogUrl: paths.catalogUrl, root: paths.root, statePath: paths.statePath });
    await assert.rejects(() => manager.initialize(), /absent from the trusted catalog/);
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

test("resource package manager options are honored and install is serialized per package", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-resource-packages-options-"));
  try {
    const root = path.join(directory, "resource-packages");
    const statePath = path.join(directory, "state", "resource-package-state.json");
    const pack = await createPackage(directory, "public-legacy-surveys-footprints", "legacy-surveys");
    const catalogUrl = await writeCatalog(directory, [pack]);
    const manager = new ResourcePackageManager({ catalogUrl, root, statePath, maxArchiveBytes: 20_000, maxExtractedBytes: 20_000, downloadTimeoutMs: 1000 });
    await manager.initialize();
    const first = manager.install("public-legacy-surveys-footprints");
    assert.throws(() => manager.install("public-legacy-surveys-footprints"), /install already in progress/);
    const result = await waitForJob(manager, first);
    assert.equal(result.status, "completed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a published JWST package is searchable through its installed MOC layer", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-resource-packages-jwst-"));
  try {
    const packageRecord = await createPackage(directory, "public-jwst-footprints-a1b2c3d4e5f6", "jwst", { releases: ["jwst-dr1"] });
    const catalogUrl = await writeCatalog(directory, [packageRecord]);
    const manager = new ResourcePackageManager({ catalogUrl, root: path.join(directory, "resource-packages"), statePath: path.join(directory, "state.json") });
    await manager.initialize();
    const job = await waitForJob(manager, manager.install(packageRecord.id));
    assert.equal(job.status, "completed");
    const layers = await manager.mocLayers(packageRecord.id);
    assert.equal(layers[0]?.surveyId, "jwst");
    assert.equal(layers[0]?.releaseId, "jwst-dr1");
    assert.equal(resourcePackageSurveyRecords([manager.get(packageRecord.id)])[0]?.id, "jwst");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an unavailable catalog keeps the last snapshot and active package selection", async () => {
  const paths = await fixture();
  try {
    const snapshotRoot = path.join(paths.directory, "snapshot-state");
    const manager = new ResourcePackageManager({ catalogUrl: paths.catalogUrl, root: paths.root, statePath: paths.statePath, snapshotRoot });
    await manager.initialize();
    await waitForJob(manager, manager.install("public-legacy-surveys-footprints"));
    await manager.activate("public-legacy-surveys-footprints");
    await writeFile(paths.catalogUrl.replace("file://", ""), "temporarily unavailable\n", "utf8");

    const restarted = new ResourcePackageManager({ catalogUrl: paths.catalogUrl, root: paths.root, statePath: paths.statePath, snapshotRoot });
    await restarted.initialize();
    assert.equal(restarted.available, true);
    assert.equal(restarted.get("public-legacy-surveys-footprints").active, true);
    assert.equal((await restarted.activeFootprints()).footprints[0]?.surveyId, "legacy-surveys");
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

test("current reviewed catalog accepts empty sources and absent descriptive lists, retaining strict trust fields", async () => {
  const paths = await fixture();
  try {
    const catalogPath = paths.catalogUrl.replace("file://", "");
    const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
    for (const entry of catalog.packages) {
      entry.sources = [];
      delete entry.wavelengths;
      delete entry.productTypes;
      delete entry.coverageAuthorities;
    }
    await writeFile(catalogPath, JSON.stringify(catalog));
    await paths.manager.sync();
    const record = paths.manager.list()[0]!;
    assert.deepEqual(record.sources, []);
    assert.deepEqual(record.wavelengths, []);
    assert.deepEqual(record.productTypes, []);
    assert.deepEqual(record.coverageAuthorities, []);
    assert.equal((await waitForJob(paths.manager, paths.manager.install(record.id))).status, "completed");
    for (const [field, invalid] of [["sources", null], ["wavelengths", "optical"], ["productTypes", [""]], ["coverageAuthorities", [42]], ["sha256", "bad"]] as const) {
      const broken = structuredClone(catalog);
      broken.packages[0][field] = invalid;
      await writeFile(catalogPath, JSON.stringify(broken));
      await assert.rejects(() => paths.manager.sync(), /Assets catalog sync failed/);
    }
  } finally { await rm(paths.directory, { recursive: true, force: true }); }
});

test("failed sync and offline restart expose stale state without rolling back the current snapshot", async () => {
  const paths = await fixture();
  try {
    const options = { catalogUrl: paths.catalogUrl, root: paths.root, statePath: paths.statePath, snapshotRoot: path.join(paths.directory, "snapshots") };
    const manager = new ResourcePackageManager(options);
    await manager.initialize();
    const before = manager.catalogStatus();
    const catalogPath = paths.catalogUrl.replace("file://", "");
    const good = await readFile(catalogPath, "utf8");
    await writeFile(catalogPath, "invalid JSON");
    await assert.rejects(() => manager.sync(), /Assets catalog sync failed/);
    assert.equal(manager.catalogStatus().stale, true);
    assert.ok(manager.catalogStatus().lastSyncError);
    assert.equal(manager.catalogStatus().catalogSha256, before.catalogSha256);
    const restarted = new ResourcePackageManager(options);
    await restarted.initialize();
    assert.equal(restarted.available, true);
    assert.equal(restarted.catalogStatus().stale, true);
    assert.ok(restarted.catalogStatus().lastSyncError);
    await writeFile(catalogPath, good);
    await restarted.sync();
    assert.equal(restarted.catalogStatus().stale, false);
    assert.equal(restarted.catalogStatus().lastSyncError, undefined);
  } finally { await rm(paths.directory, { recursive: true, force: true }); }
});


test("reviewed per-layer NESTED previews install and remain readable after restart", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "reviewed-preview-"));
  try {
    const pkg = await createPackage(directory, "public-reviewed-footprints", "reviewed", { releases: ["release-a"], reviewedPreview: true });
    const catalogUrl = await writeCatalog(directory, [pkg]);
    const options = { catalogUrl, root: path.join(directory, "packages"), statePath: path.join(directory, "state.json") };
    const manager = new ResourcePackageManager(options);
    await manager.initialize();
    const job = await waitForJob(manager, manager.install(pkg.id));
    assert.equal(job.status, "completed", job.error);
    await manager.activate(pkg.id);
    const before = await manager.activeFootprints();
    assert.equal(before.nside, 16);
    assert.equal(before.footprints[0]?.layerId, "reviewed-coverage");
    assert.equal(before.footprints[0]?.modality, "imaging");
    assert.deepEqual(before.footprints[0]?.pixels, manifestFor("reviewed", ["release-a"]).footprints[0]?.pixels);
    const restarted = new ResourcePackageManager(options);
    await restarted.initialize();
    assert.equal((await restarted.mocLayers(pkg.id))[0]?.layerId, "reviewed-coverage");
    assert.deepEqual((await restarted.activeFootprints()).footprints, before.footprints);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("published HST archive layer IDs with consecutive hyphens retain their immutable identity", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hst-published-identity-"));
  try {
    const layerId = "moc-hst-hst-archive--a3f34784c95b";
    const pkg = await createPackage(directory, "public-hst-footprints", "hst", { releases: ["hst-archive-coverage"], reviewedPreview: true, includeHealpix: true, layerId });
    const manager = new ResourcePackageManager({ catalogUrl: await writeCatalog(directory, [pkg]), root: path.join(directory, "packages"), statePath: path.join(directory, "state.json") });
    await manager.initialize();
    const job = await waitForJob(manager, manager.install(pkg.id));
    assert.equal(job.status, "completed", job.error);
    await manager.activate(pkg.id);
    assert.equal((await manager.mocLayers(pkg.id))[0]?.layerId, layerId);
    assert.equal((await manager.activeFootprints()).footprints[0]?.layerId, layerId);
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test("reviewed previews reject RING ordering and mismatched native layer identity", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "reviewed-preview-invalid-"));
  try {
    for (const invalid of [{ previewOrdering: "RING" }, { previewLayerId: "unknown-layer" }]) {
      const pkg = await createPackage(directory, "public-reviewed-footprints", "reviewed", { releases: ["release-a"], reviewedPreview: true, ...invalid });
      const manager = new ResourcePackageManager({ catalogUrl: await writeCatalog(directory, [pkg]), root: path.join(directory, "packages"), statePath: path.join(directory, "state.json") });
      await manager.initialize();
      const job = await waitForJob(manager, manager.install(pkg.id));
      assert.equal(job.status, "failed");
      assert.match(job.error ?? "", /NESTED|identity/);
      assert.equal(manager.list()[0]?.installedVersion, undefined);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("optional order-4 and order-8 HEALPix lists install without changing MOC activation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "resource-package-healpix-"));
  try {
    const pkg = await createPackage(directory, "public-healpix-fixture", "healpix-fixture", { releases: ["release-a"], reviewedPreview: true, includeHealpix: true });
    const manager = new ResourcePackageManager({ catalogUrl: await writeCatalog(directory, [pkg]), root: path.join(directory, "packages"), statePath: path.join(directory, "state.json") });
    await manager.initialize();
    const job = await waitForJob(manager, manager.install(pkg.id));
    assert.equal(job.status, "completed", job.error);
    await manager.activate(pkg.id);
    assert.equal((await manager.mocLayers(pkg.id))[0]?.layerId, "healpix-fixture-coverage");
    assert.equal((await manager.activeFootprints()).footprints[0]?.layerId, "healpix-fixture-coverage");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("invalid optional HEALPix sidecar keeps the installed package and active releases", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "resource-package-healpix-update-"));
  try {
    const initial = await createPackage(directory, "public-healpix-update", "healpix-update", { version: "3.0.0", releases: ["release-a"] });
    const catalogUrl = await writeCatalog(directory, [initial]);
    const options = { catalogUrl, root: path.join(directory, "packages"), statePath: path.join(directory, "state.json") };
    const manager = new ResourcePackageManager(options);
    await manager.initialize();
    assert.equal((await waitForJob(manager, manager.install(initial.id))).status, "completed");
    await manager.activate(initial.id);

    const invalid = await createPackage(directory, initial.id, initial.surveyId, {
      version: "3.1.0",
      releases: ["release-a"],
      includeHealpix: true,
      healpixOrder8: { schemaVersion: 1 },
    });
    await writeCatalog(directory, [invalid]);
    const updater = new ResourcePackageManager(options);
    await updater.initialize();
    const failed = await waitForJob(updater, updater.install(invalid.id));
    assert.equal(failed.status, "failed");
    assert.match(failed.error ?? "", /identity or coordinate metadata/);
    assert.equal(updater.get(invalid.id).installedVersion, "3.0.0");
    assert.deepEqual(updater.get(invalid.id).activeReleaseIds, ["release-a"]);
    assert.deepEqual((await readdir(path.join(options.root, "installed", invalid.id))).sort(), ["3.0.0"]);
    assert.equal((await updater.mocLayers(invalid.id))[0]?.layerId, "healpix-update-coverage");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("HEALPix sidecars preserve unknown metadata and explicitly omit layers below the requested order", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "resource-package-healpix-orders-"));
  try {
    const coarse = await createPackage(directory, "public-healpix-coarse", "healpix-coarse", { releases: ["release-a"], includeHealpix: true, layerMaxOrder: 3 });
    const unknown = await createPackage(directory, "public-healpix-unknown", "healpix-unknown", { releases: ["release-a"], includeHealpix: true, sidecarPrecision: "unknown", sidecarCompleteness: "unknown" });
    const manager = new ResourcePackageManager({ catalogUrl: await writeCatalog(directory, [coarse, unknown]), root: path.join(directory, "packages"), statePath: path.join(directory, "state.json") });
    await manager.initialize();
    for (const pkg of [coarse, unknown]) {
      const job = await waitForJob(manager, manager.install(pkg.id));
      assert.equal(job.status, "completed", job.error);
    }

    const coarseOrder4 = JSON.parse(await readFile(path.join(directory, "packages", "installed", coarse.id, coarse.version, "healpix", "order4.json"), "utf8")) as { layers: unknown[]; surveyUnion: { cells: number[]; precision: string; completeness: string; omittedLayers: Array<{ layerId: string }> } };
    assert.deepEqual(coarseOrder4.layers, []);
    assert.deepEqual(coarseOrder4.surveyUnion.cells, []);
    assert.equal(coarseOrder4.surveyUnion.precision, "unknown");
    assert.equal(coarseOrder4.surveyUnion.completeness, "incomplete");
    assert.deepEqual(coarseOrder4.surveyUnion.omittedLayers.map((entry) => entry.layerId), ["healpix-coarse-coverage"]);

    const unknownOrder4 = JSON.parse(await readFile(path.join(directory, "packages", "installed", unknown.id, unknown.version, "healpix", "order4.json"), "utf8")) as { layers: Array<{ precision: string; completeness: string }>; surveyUnion: { precision: string; completeness: string } };
    assert.deepEqual(unknownOrder4.layers.map(({ precision, completeness }) => [precision, completeness]), [["unknown", "unknown"]]);
    assert.equal(unknownOrder4.surveyUnion.precision, "unknown");
    assert.equal(unknownOrder4.surveyUnion.completeness, "unknown");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("HEALPix sidecars reject sufficient-order omissions and overstated union metadata", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "resource-package-healpix-invalid-semantics-"));
  try {
    const eligibleOmission = await createPackage(directory, "public-healpix-eligible-omission", "healpix-eligible-omission", {
      releases: ["release-a"], includeHealpix: true, omitEligibleLayerAtOrder8: true,
    });
    const unknownUnion = {
      schemaVersion: 1,
      surveyId: "healpix-union-lie",
      packageId: "public-healpix-union-lie",
      packageVersion: "3.0.0",
      revision: "public-healpix-union-lie@3.0.0",
      coordinateFrame: "ICRS",
      ordering: "NESTED",
      order: 8,
      layers: [{ layerId: "healpix-union-lie-coverage", surveyId: "healpix-union-lie", releaseId: "release-a", productId: "healpix-union-lie-product", sourceId: "healpix-union-lie-source", product: "Fixture healpix-union-lie", cells: [1, 2], precision: "unknown", completeness: "unknown" }],
      surveyUnion: { cells: [1, 2], precision: "estimated", completeness: "complete", omittedLayers: [] },
    };
    const overstatedUnion = await createPackage(directory, "public-healpix-union-lie", "healpix-union-lie", {
      releases: ["release-a"], includeHealpix: true, sidecarPrecision: "unknown", sidecarCompleteness: "unknown", healpixOrder8: unknownUnion,
    });

    for (const [pkg, expectedError] of [[eligibleOmission, /sufficient manifest maxOrder/], [overstatedUnion, /union precision or completeness/]] as const) {
      const manager = new ResourcePackageManager({ catalogUrl: await writeCatalog(directory, [pkg]), root: path.join(directory, `${pkg.id}-packages`), statePath: path.join(directory, `${pkg.id}-state.json`) });
      await manager.initialize();
      const job = await waitForJob(manager, manager.install(pkg.id));
      assert.equal(job.status, "failed");
      assert.match(job.error ?? "", expectedError);
      assert.equal(manager.get(pkg.id).installedVersion, undefined);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("HEALPix sidecar paths, declared hashes, and ZIP members are checked", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "resource-package-healpix-files-"));
  try {
    const invalidPackages = [
      [await createPackage(directory, "public-healpix-path", "healpix-path", { includeHealpix: true, invalidHealpixManifestPath: true }), /supporting file .* is invalid/],
      [await createPackage(directory, "public-healpix-hash", "healpix-hash", { includeHealpix: true, tamperHealpixHash: true }), /Supporting file SHA-256/],
      [await createPackage(directory, "public-healpix-extra", "healpix-extra", { includeHealpix: true, extraHealpixPath: true }), /unsafe ZIP entry/],
    ] as const;
    for (const [pkg, expectedError] of invalidPackages) {
      const manager = new ResourcePackageManager({ catalogUrl: await writeCatalog(directory, [pkg]), root: path.join(directory, `${pkg.id}-packages`), statePath: path.join(directory, `${pkg.id}-state.json`) });
      await manager.initialize();
      const job = await waitForJob(manager, manager.install(pkg.id));
      assert.equal(job.status, "failed");
      assert.match(job.error ?? "", expectedError);
      assert.equal(manager.get(pkg.id).installedVersion, undefined);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
