import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { CURATED_SURVEYS } from "../src/survey-registry.js";
import { normalizeSurveyFootprintManifest, type SurveyFootprintManifest } from "../src/survey-footprints.js";

const root = process.cwd();
const artifactRoot = path.join(root, "artifacts", "public-survey-footprints");
const sourcesPath = path.join(artifactRoot, "sources.json");
const sourceManifestPath = path.join(root, "src", "footprints", "survey-footprints.json");
const catalogPath = path.join(root, "bootstrap", "resource-packages", "catalog.json");
const packageRoot = path.join(root, "bootstrap", "resource-packages");
const manualFootprintsPath = path.join(artifactRoot, "manual", "footprints.json");
const rawMocIndexPath = path.join(artifactRoot, "raw", "moc", "index.json");
const rawGeometryIndexPath = path.join(artifactRoot, "raw", "geometry", "index.json");

const SOURCE_STATUSES = ["acquired", "overview_only", "awaiting_geometry", "not_applicable"] as const;
type SourceStatus = typeof SOURCE_STATUSES[number];
type SourceProduct = {
  product: string;
  status: SourceStatus;
  sourceUrl: string;
  geometrySourceUrl?: string;
  reason?: string;
  manualStep?: string;
};
type SourceRelease = { surveyId: string; releaseId: string; products: SourceProduct[] };
type ManualFootprint = { surveyId: string; releaseId: string; product: string; label: string; sourceUrl: string; method: string; calculatedAt: string; ordering: "NESTED"; pixels: number[] };
export type PublicFootprintStatistics = { releases: number; products: number } & Record<SourceStatus, number>;

function validUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  try { const url = new URL(value); return url.protocol === "http:" || url.protocol === "https:"; } catch { return false; }
}

async function readJson<T>(file: string): Promise<T> { return JSON.parse(await readFile(file, "utf8")) as T; }

export async function validate(): Promise<PublicFootprintStatistics> {
  const sources = await readJson<{ schemaVersion: number; auditedAt: string; releases: SourceRelease[] }>(sourcesPath);
  if (sources.schemaVersion !== 2 || !Number.isFinite(Date.parse(sources.auditedAt)) || !Array.isArray(sources.releases)) throw new Error("sources.json has an unsupported schema");
  const sourceByRelease = new Map(sources.releases.map((entry) => [`${entry.surveyId}:${entry.releaseId}`, entry]));
  const available = CURATED_SURVEYS.flatMap((survey) => survey.releases.filter((release) => release.availability === "available").map((release) => ({ survey, release })));
  const errors: string[] = [];
  if (sourceByRelease.size !== sources.releases.length) errors.push("sources.json contains duplicate release identities");
  for (const { survey, release } of available) {
    const entry = sourceByRelease.get(`${survey.id}:${release.id}`);
    if (!entry) { errors.push(`missing source release ${survey.id}:${release.id}`); continue; }
    const products = new Map(entry.products.map((product) => [product.product, product]));
    for (const registered of release.products) {
      const product = products.get(registered.name);
      if (!product) { errors.push(`missing source product ${survey.id}:${release.id}:${registered.name}`); continue; }
      const identity = `${survey.id}:${release.id}:${registered.name}`;
      if (!SOURCE_STATUSES.includes(product.status)) errors.push(`invalid source status ${identity}`);
      if (!validUrl(product.sourceUrl)) errors.push(`invalid source URL ${identity}`);
      if (product.geometrySourceUrl !== undefined && !validUrl(product.geometrySourceUrl)) errors.push(`invalid geometry source URL ${identity}`);
      if (product.status === "acquired" && !product.geometrySourceUrl) errors.push(`acquired source needs geometry URL ${identity}`);
      if (product.status === "acquired" && (product.reason !== undefined || product.manualStep !== undefined)) errors.push(`acquired source must not have reason or manual step ${identity}`);
      if (product.status !== "acquired" && (!product.reason?.trim())) errors.push(`non-acquired source needs reason ${identity}`);
      if ((product.status === "overview_only" || product.status === "awaiting_geometry") && !product.manualStep?.trim()) errors.push(`incomplete geometry needs manual step ${identity}`);
    }
    if (new Set(entry.products.map((product) => product.product)).size !== entry.products.length) errors.push(`duplicate source product ${survey.id}:${release.id}`);
    for (const product of entry.products) if (!release.products.some((registered) => registered.name === product.product) && product.status !== "acquired" && product.status !== "overview_only") errors.push(`unknown source product ${survey.id}:${release.id}:${product.product}`);
  }
  for (const entry of sources.releases) if (!available.some(({ survey, release }) => survey.id === entry.surveyId && release.id === entry.releaseId)) errors.push(`source release is not available ${entry.surveyId}:${entry.releaseId}`);
  const manifest = normalizeSurveyFootprintManifest(await readJson<SurveyFootprintManifest>(sourceManifestPath));
  const identities = new Set(manifest.footprints.map((footprint) => `${footprint.surveyId}:${footprint.releaseId}:${footprint.product}`));
  for (const footprint of manifest.footprints) {
    const survey = CURATED_SURVEYS.find((candidate) => candidate.id === footprint.surveyId);
    const release = survey?.releases.find((candidate) => candidate.id === footprint.releaseId);
    if (!survey || !release || release.availability !== "available") errors.push(`manifest identity is not an available release ${footprint.surveyId}:${footprint.releaseId}`);
    if (!release?.products.some((product) => product.name === footprint.product) && !sourceByRelease.get(`${footprint.surveyId}:${footprint.releaseId}`)?.products.some((product) => product.product === footprint.product)) errors.push(`manifest product is not registered ${footprint.surveyId}:${footprint.releaseId}:${footprint.product}`);
    if (!validUrl(footprint.sourceUrl)) errors.push(`invalid manifest URL ${footprint.surveyId}:${footprint.releaseId}:${footprint.product}`);
  }
  for (const entry of sources.releases) for (const product of entry.products) {
    const identity = `${entry.surveyId}:${entry.releaseId}:${product.product}`;
    const footprint = manifest.footprints.find((candidate) => `${candidate.surveyId}:${candidate.releaseId}:${candidate.product}` === identity);
    if (product.status === "acquired" && footprint?.quality !== "moc") errors.push(`acquired identity lacks exact MOC ${identity}`);
    if (product.status === "overview_only" && footprint?.quality === "moc") errors.push(`overview identity conflicts with exact MOC ${identity}`);
  }
  const manual = await readJson<{ schemaVersion: number; coordinateFrame: string; ordering: string; nside: number; footprints: ManualFootprint[] }>(manualFootprintsPath);
  if (manual.schemaVersion !== 1 || manual.coordinateFrame !== "ICRS" || manual.ordering !== "NESTED" || manual.nside !== 16 || !Array.isArray(manual.footprints)) errors.push("manual footprints have an unsupported schema");
  const manualIdentities = new Set<string>();
  for (const footprint of manual.footprints ?? []) {
    const identity = `${footprint.surveyId}:${footprint.releaseId}:${footprint.product}`;
    const registered = sourceByRelease.get(`${footprint.surveyId}:${footprint.releaseId}`)?.products.some((product) => product.product === footprint.product);
    if (!registered) errors.push(`manual footprint identity is not registered ${identity}`);
    if (manualIdentities.has(identity)) errors.push(`duplicate manual footprint ${identity}`);
    manualIdentities.add(identity);
    if (!validUrl(footprint.sourceUrl)) errors.push(`invalid manual footprint URL ${identity}`);
    if (footprint.ordering !== "NESTED") errors.push(`manual footprint ordering must be NESTED ${identity}`);
    if (!footprint.label?.trim() || !footprint.method?.trim()) errors.push(`manual footprint needs label and method ${identity}`);
    if (!Number.isFinite(Date.parse(footprint.calculatedAt))) errors.push(`invalid manual footprint timestamp ${identity}`);
    if (!Array.isArray(footprint.pixels) || !footprint.pixels.length || new Set(footprint.pixels).size !== footprint.pixels.length || footprint.pixels.some((pixel) => !Number.isInteger(pixel) || pixel < 0 || pixel >= 12 * 16 * 16)) errors.push(`invalid manual footprint pixels ${identity}`);
  }
  const rawIndex = await readJson<{ schemaVersion: number; coordinateFrame: string; artifacts: Array<{ sourceId: string; sourceUrl: string; metadataUrl: string; fitsPath: string; metadataPath: string; byteLength: number; sha256: string }> }>(rawMocIndexPath);
  if (rawIndex.schemaVersion !== 1 || rawIndex.coordinateFrame !== "ICRS" || !Array.isArray(rawIndex.artifacts)) errors.push("raw MOC index has an unsupported schema");
  for (const artifact of rawIndex.artifacts ?? []) {
    if (!artifact.sourceId?.trim() || !validUrl(artifact.sourceUrl) || !validUrl(artifact.metadataUrl) || !artifact.fitsPath?.endsWith(".fits") || !artifact.metadataPath?.endsWith(".record.json")) {
      errors.push(`invalid raw MOC record ${artifact.sourceId ?? "unknown"}`);
      continue;
    }
    const fitsPath = path.join(path.dirname(rawMocIndexPath), artifact.fitsPath);
    const fits = await readFile(fitsPath);
    if (fits.byteLength !== artifact.byteLength || createHash("sha256").update(fits).digest("hex") !== artifact.sha256) errors.push(`raw MOC checksum mismatch ${artifact.sourceId}`);
    try { await readJson(path.join(path.dirname(rawMocIndexPath), artifact.metadataPath)); } catch { errors.push(`invalid raw MOC metadata ${artifact.sourceId}`); }
  }
  type RawGeometryArtifact = {
    surveyId: string;
    releaseId: string;
    product: string;
    sourceUrl: string;
    filePath: string;
    byteLength: number;
    sha256: string;
    parser: string;
    polygonCount?: number;
    rowCount?: number;
    selectedRowCount?: number;
    filter?: string;
    coordinateColumns?: string[];
    tileRadiusDeg?: number;
    focalPlaneRadiusMm?: number;
    desimodelVersion?: string;
    radiusSourceUrl?: string;
  };
  const rawGeometry = await readJson<{ schemaVersion: number; coordinateFrame: string; artifacts: RawGeometryArtifact[] }>(rawGeometryIndexPath);
  if (rawGeometry.schemaVersion !== 1 || rawGeometry.coordinateFrame !== "ICRS" || !Array.isArray(rawGeometry.artifacts)) errors.push("raw geometry index has an unsupported schema");
  for (const artifact of rawGeometry.artifacts ?? []) {
    const identity = `${artifact.surveyId}:${artifact.releaseId}:${artifact.product}`;
    if (!artifact.surveyId?.trim() || !artifact.releaseId?.trim() || !artifact.product?.trim() || !validUrl(artifact.sourceUrl) || !artifact.filePath?.trim() || path.basename(artifact.filePath) !== artifact.filePath || !Number.isSafeInteger(artifact.byteLength) || artifact.byteLength <= 0 || !/^[a-f0-9]{64}$/.test(artifact.sha256) || !artifact.parser?.trim()) {
      errors.push(`invalid raw geometry record ${identity}`);
      continue;
    }
    try {
      const bytes = await readFile(path.join(path.dirname(rawGeometryIndexPath), artifact.filePath));
      if (bytes.byteLength !== artifact.byteLength || createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) errors.push(`raw geometry checksum mismatch ${identity}`);
    } catch { errors.push(`missing raw geometry artifact ${identity}`); }
  }
  const euclidQ1Geometry = rawGeometry.artifacts?.find((artifact) => artifact.surveyId === "euclid" && artifact.releaseId === "euclid-q1" && artifact.product === "Euclid Q1 deep fields");
  if (!euclidQ1Geometry) errors.push("missing Euclid Q1 raw geometry record");
  else {
    if (!validUrl(euclidQ1Geometry.sourceUrl) || euclidQ1Geometry.filePath !== "euclid-q1-region-files.zip" || !Number.isSafeInteger(euclidQ1Geometry.byteLength) || euclidQ1Geometry.byteLength <= 0 || !/^[a-f0-9]{64}$/.test(euclidQ1Geometry.sha256) || !Number.isSafeInteger(euclidQ1Geometry.polygonCount) || Number(euclidQ1Geometry.polygonCount) <= 0 || !euclidQ1Geometry.parser.includes("DS9 ICRS polygon")) {
      errors.push("invalid Euclid Q1 raw geometry record");
    }
  }
  for (const [releaseId, filePath] of [["desi-edr", "desi-edr-tiles-fuji.fits"], ["desi-dr1", "desi-dr1-tiles-iron.fits"]] as const) {
    const geometry = rawGeometry.artifacts?.find((artifact) => artifact.surveyId === "desi" && artifact.releaseId === releaseId);
    if (!geometry) { errors.push(`missing DESI raw geometry record ${releaseId}`); continue; }
    if (geometry.filePath !== filePath || !geometry.filePath.endsWith(".fits") || !Number.isSafeInteger(geometry.rowCount) || geometry.rowCount! <= 0 || !Number.isSafeInteger(geometry.selectedRowCount) || geometry.selectedRowCount! <= 0 || geometry.selectedRowCount! > geometry.rowCount! || geometry.filter !== "NEXP > 0" || geometry.coordinateColumns?.join(",") !== "TILERA,TILEDEC" || !Number.isFinite(geometry.tileRadiusDeg) || geometry.tileRadiusDeg! <= 0 || !Number.isFinite(geometry.focalPlaneRadiusMm) || geometry.focalPlaneRadiusMm! <= 0 || geometry.desimodelVersion !== "0.20.0" || !validUrl(geometry.radiusSourceUrl) || !geometry.parser.includes("TILE_COMPLETENESS")) {
      errors.push(`invalid DESI raw geometry record ${releaseId}`);
    }
  }
  if (errors.length) throw new Error(`public footprint validation failed:\n${errors.join("\n")}`);
  const counts = sources.releases.flatMap((entry) => entry.products);
  return {
    releases: available.length,
    products: counts.length,
    acquired: counts.filter((product) => product.status === "acquired").length,
    overview_only: counts.filter((product) => product.status === "overview_only").length,
    awaiting_geometry: counts.filter((product) => product.status === "awaiting_geometry").length,
    not_applicable: counts.filter((product) => product.status === "not_applicable").length,
  };
}

async function sha256(file: string): Promise<string> { return createHash("sha256").update(await readFile(file)).digest("hex"); }

export async function sync(): Promise<void> {
  const statistics = await validate();
  const manifest = normalizeSurveyFootprintManifest(await readJson<SurveyFootprintManifest>(sourceManifestPath));
  const catalog = await readJson<{ packages: Array<{ id: string; version: string; archiveUrl: string; sizeBytes: number; sha256: string }> }>(catalogPath);
  const normalizedPath = path.join(artifactRoot, "normalized", "survey-footprints.json");
  const catalogOut = path.join(artifactRoot, "packages", "catalog.json");
  const releaseProductsOut = path.join(root, "bootstrap", "resource-packages", "release-products.json");
  await mkdir(path.dirname(normalizedPath), { recursive: true });
  await mkdir(path.dirname(catalogOut), { recursive: true });
  await writeFile(normalizedPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await cp(catalogPath, catalogOut);
  await cp(sourcesPath, releaseProductsOut);
  const packages = [];
  for (const entry of catalog.packages) {
    const source = path.join(packageRoot, path.basename(entry.archiveUrl));
    const destination = path.join(artifactRoot, "packages", path.basename(entry.archiveUrl));
    await cp(source, destination);
    packages.push({ id: entry.id, version: entry.version, archive: path.relative(artifactRoot, destination), sizeBytes: entry.sizeBytes, sha256: await sha256(destination) });
  }
  const inputs = {
    canonicalManifest: { path: path.relative(artifactRoot, sourceManifestPath), sha256: await sha256(sourceManifestPath) },
    sources: { path: path.relative(artifactRoot, sourcesPath), sha256: await sha256(sourcesPath) },
    manual: { path: path.relative(artifactRoot, manualFootprintsPath), sha256: await sha256(manualFootprintsPath) },
    rawMocIndex: { path: path.relative(artifactRoot, rawMocIndexPath), sha256: await sha256(rawMocIndexPath) },
    rawGeometryIndex: { path: path.relative(artifactRoot, rawGeometryIndexPath), sha256: await sha256(rawGeometryIndexPath) },
  };
  const files = { manifest: { path: path.relative(artifactRoot, normalizedPath), sha256: await sha256(normalizedPath) }, catalog: { path: path.relative(artifactRoot, catalogOut), sha256: await sha256(catalogOut) }, packages };
  await writeFile(path.join(artifactRoot, "provenance.json"), `${JSON.stringify({ schemaVersion: 2, generatedAt: new Date().toISOString(), generator: { name: "scripts/public_footprint_artifacts.ts" }, statistics: { ...statistics, manifestFootprints: manifest.footprints.length, packages: packages.length }, inputs, files }, null, 2)}\n`, "utf8");
}

if (process.argv[1]?.endsWith("public_footprint_artifacts.ts")) {
  const command = process.argv[2];
  if (command === "validate") await validate();
  else if (command === "sync") await sync();
  else throw new Error("Usage: public_footprint_artifacts.ts <validate|sync>");
}
