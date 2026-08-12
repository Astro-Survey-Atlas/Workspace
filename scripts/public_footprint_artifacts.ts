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

type SourceProduct = { product: string; status: "acquired" | "unavailable"; sourceUrl: string; reason?: string };
type SourceRelease = { surveyId: string; releaseId: string; products: SourceProduct[] };
type ManualFootprint = { surveyId: string; releaseId: string; product: string; label: string; sourceUrl: string; method: string; calculatedAt: string; pixels: number[] };

function validUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  try { const url = new URL(value); return url.protocol === "http:" || url.protocol === "https:"; } catch { return false; }
}

async function readJson<T>(file: string): Promise<T> { return JSON.parse(await readFile(file, "utf8")) as T; }

export async function validate(): Promise<{ releases: number; products: number; acquired: number; unavailable: number }> {
  const sources = await readJson<{ schemaVersion: number; releases: SourceRelease[] }>(sourcesPath);
  if (sources.schemaVersion !== 1 || !Array.isArray(sources.releases)) throw new Error("sources.json has an unsupported schema");
  const sourceByRelease = new Map(sources.releases.map((entry) => [`${entry.surveyId}:${entry.releaseId}`, entry]));
  const available = CURATED_SURVEYS.flatMap((survey) => survey.releases.filter((release) => release.availability === "available").map((release) => ({ survey, release })));
  const errors: string[] = [];
  for (const { survey, release } of available) {
    const entry = sourceByRelease.get(`${survey.id}:${release.id}`);
    if (!entry) { errors.push(`missing source release ${survey.id}:${release.id}`); continue; }
    const products = new Map(entry.products.map((product) => [product.product, product]));
    for (const registered of release.products) {
      const product = products.get(registered.name);
      if (!product) { errors.push(`missing source product ${survey.id}:${release.id}:${registered.name}`); continue; }
      if (!validUrl(product.sourceUrl)) errors.push(`invalid source URL ${survey.id}:${release.id}:${registered.name}`);
      if (product.status === "unavailable" && (!product.reason || !product.reason.trim())) errors.push(`unavailable source needs reason ${survey.id}:${release.id}:${registered.name}`);
      if (product.status === "acquired" && product.reason !== undefined) errors.push(`acquired source must not have reason ${survey.id}:${release.id}:${registered.name}`);
    }
    for (const product of entry.products) if (!release.products.some((registered) => registered.name === product.product) && product.status !== "acquired") errors.push(`unknown source product ${survey.id}:${release.id}:${product.product}`);
  }
  const manifest = normalizeSurveyFootprintManifest(await readJson<SurveyFootprintManifest>(sourceManifestPath));
  const identities = new Set(manifest.footprints.map((footprint) => `${footprint.surveyId}:${footprint.releaseId}:${footprint.product}`));
  for (const footprint of manifest.footprints) {
    const survey = CURATED_SURVEYS.find((candidate) => candidate.id === footprint.surveyId);
    const release = survey?.releases.find((candidate) => candidate.id === footprint.releaseId);
    if (!survey || !release || release.availability !== "available") errors.push(`manifest identity is not an available release ${footprint.surveyId}:${footprint.releaseId}`);
    if (!release?.products.some((product) => product.name === footprint.product) && !sourceByRelease.get(`${footprint.surveyId}:${footprint.releaseId}`)?.products.some((product) => product.product === footprint.product)) errors.push(`manifest product is not registered ${footprint.surveyId}:${footprint.releaseId}:${footprint.product}`);
    if (!validUrl(footprint.sourceUrl)) errors.push(`invalid manifest URL ${footprint.surveyId}:${footprint.releaseId}:${footprint.product}`);
  }
  for (const entry of sources.releases) for (const product of entry.products) if (product.status === "acquired" && !identities.has(`${entry.surveyId}:${entry.releaseId}:${product.product}`)) errors.push(`acquired identity absent from manifest ${entry.surveyId}:${entry.releaseId}:${product.product}`);
  const manual = await readJson<{ schemaVersion: number; coordinateFrame: string; nside: number; footprints: ManualFootprint[] }>(manualFootprintsPath);
  if (manual.schemaVersion !== 1 || manual.coordinateFrame !== "ICRS" || manual.nside !== 16 || !Array.isArray(manual.footprints)) errors.push("manual footprints have an unsupported schema");
  const manualIdentities = new Set<string>();
  for (const footprint of manual.footprints ?? []) {
    const identity = `${footprint.surveyId}:${footprint.releaseId}:${footprint.product}`;
    const registered = sourceByRelease.get(`${footprint.surveyId}:${footprint.releaseId}`)?.products.some((product) => product.product === footprint.product);
    if (!registered) errors.push(`manual footprint identity is not registered ${identity}`);
    if (manualIdentities.has(identity)) errors.push(`duplicate manual footprint ${identity}`);
    manualIdentities.add(identity);
    if (!validUrl(footprint.sourceUrl)) errors.push(`invalid manual footprint URL ${identity}`);
    if (!footprint.label?.trim() || !footprint.method?.trim()) errors.push(`manual footprint needs label and method ${identity}`);
    if (!Number.isFinite(Date.parse(footprint.calculatedAt))) errors.push(`invalid manual footprint timestamp ${identity}`);
    if (!Array.isArray(footprint.pixels) || !footprint.pixels.length || new Set(footprint.pixels).size !== footprint.pixels.length || footprint.pixels.some((pixel) => !Number.isInteger(pixel) || pixel < 0 || pixel >= 12 * 16 * 16)) errors.push(`invalid manual footprint pixels ${identity}`);
  }
  if (errors.length) throw new Error(`public footprint validation failed:\n${errors.join("\n")}`);
  const counts = sources.releases.flatMap((entry) => entry.products);
  return { releases: available.length, products: counts.length, acquired: counts.filter((product) => product.status === "acquired").length, unavailable: counts.filter((product) => product.status === "unavailable").length };
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
  const files = { manifest: { path: path.relative(artifactRoot, normalizedPath), sha256: await sha256(normalizedPath) }, catalog: { path: path.relative(artifactRoot, catalogOut), sha256: await sha256(catalogOut) }, packages };
  await writeFile(path.join(artifactRoot, "provenance.json"), `${JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), statistics: { ...statistics, manifestFootprints: manifest.footprints.length, packages: packages.length }, files }, null, 2)}\n`, "utf8");
}

if (process.argv[1]?.endsWith("public_footprint_artifacts.ts")) {
  const command = process.argv[2];
  if (command === "validate") await validate();
  else if (command === "sync") await sync();
  else throw new Error("Usage: public_footprint_artifacts.ts <validate|sync>");
}
