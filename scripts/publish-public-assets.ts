import { cp, mkdir, mkdtemp, readFile, rm, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { CURATED_SURVEYS, type SurveyModality } from "../src/survey-registry.js";

const run = promisify(execFile);
const workspaceRoot = process.cwd();
const targetRoot = path.resolve(process.env.ASTRO_ASSETS_REPO ?? path.join(workspaceRoot, "..", "Astro-Survey-Atlas-Assets"));
const tempRoot = await mkdtemp(path.join(path.dirname(targetRoot), ".astro-survey-assets-release-"));

async function copyInto(source: string, relative: string): Promise<void> {
  const destination = path.join(tempRoot, relative);
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, force: true });
}

type LedgerProduct = {
  product: string;
  status: "acquired" | "overview_only" | "awaiting_geometry" | "not_applicable";
  sourceUrl: string;
  geometrySourceUrl?: string;
  reason?: string;
  manualStep?: string;
};

type LedgerRelease = { surveyId: string; releaseId: string; products: LedgerProduct[] };

function fallbackModality(product: string, modalities: readonly SurveyModality[]): SurveyModality {
  const normalized = product.toLowerCase();
  if (normalized.includes("spectr") || normalized.includes("redshift")) return "spectroscopy";
  if (normalized.includes("photometr")) return "photometry";
  if (normalized.includes("infrared") || /\b[wjhk]-?band\b/.test(normalized)) return "infrared";
  if (normalized.includes("ultraviolet") || normalized.includes("fuv") || normalized.includes("nuv")) return "ultraviolet";
  if (normalized.includes("image")) return "imaging";
  return modalities.includes("catalog") ? "catalog" : modalities[0] ?? "catalog";
}

async function writeSurveyCatalog(): Promise<void> {
  const ledger = JSON.parse(await readFile(path.join(tempRoot, "artifacts", "public-survey-footprints", "sources.json"), "utf8")) as {
    auditedAt: string;
    releases: LedgerRelease[];
  };
  const ledgerByRelease = new Map(ledger.releases.map((release) => [`${release.surveyId}:${release.releaseId}`, release]));
  const surveys = CURATED_SURVEYS.flatMap((survey) => {
    const releases = survey.releases.flatMap((release) => {
      const ledgerRelease = ledgerByRelease.get(`${survey.id}:${release.id}`);
      if (!ledgerRelease) return [];
      return [{
        id: release.id,
        label: release.label,
        kind: release.kind,
        ...(release.releasedYear === undefined ? {} : { releasedYear: release.releasedYear }),
        modalities: release.modalities,
        products: ledgerRelease.products.map((product) => {
          const registered = release.products.find((candidate) => candidate.name === product.product);
          return {
            name: product.product,
            modality: registered?.modality ?? fallbackModality(product.product, release.modalities),
            description: registered?.description ?? product.reason ?? "Public survey product tracked by the coverage ledger.",
            status: product.status,
            sourceUrl: product.sourceUrl,
            ...(product.geometrySourceUrl ? { geometrySourceUrl: product.geometrySourceUrl } : {}),
            ...(product.reason ? { reason: product.reason } : {}),
            ...(product.manualStep ? { manualStep: product.manualStep } : {}),
          };
        }),
      }];
    });
    if (!releases.length) return [];
    return [{
      id: survey.id,
      name: survey.name,
      mission: survey.mission,
      color: survey.color,
      description: survey.description,
      modalities: survey.modalities,
      releases,
    }];
  });
  const destination = path.join(tempRoot, "src", "surveys", "survey-catalog.json");
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify({ schemaVersion: 1, generatedAt: ledger.auditedAt, surveys }, null, 2)}\n`, "utf8");
}

try {
  await copyInto(path.join(targetRoot, "artifacts"), "artifacts");
  await copyInto(path.join(workspaceRoot, "src", "footprints"), path.join("src", "footprints"));
  await copyInto(path.join(workspaceRoot, "docs", "public-footprint-moc-method.md"), path.join("docs", "public-footprint-moc-method.md"));
  await copyInto(path.join(targetRoot, "site", "public"), path.join("site", "public"));
  await writeSurveyCatalog();

  const env = {
    ...process.env,
    ASSET_WORKTREE_ROOT: tempRoot,
    ASSET_RELEASE_ROOT: tempRoot,
    ASTRO_PUBLIC_ASSETS_ROOT: tempRoot,
    ASTRO_PUBLIC_ASSETS_CANONICAL_ROOT: tempRoot,
    ASTRO_RESOURCE_CATALOG_PATH: path.join(workspaceRoot, "bootstrap", "resource-packages", "catalog.json"),
    ASTRO_RESOURCE_PACKAGE_SOURCE_ROOT: path.join(workspaceRoot, "bootstrap", "resource-packages"),
  };
  await run("npm", ["run", "artifacts:footprints"], { cwd: workspaceRoot, env });
  await run("npm", ["run", "assets:build"], { cwd: targetRoot, env });
  await run("npm", ["run", "build"], { cwd: targetRoot, env });
  await run("npm", ["test"], { cwd: targetRoot, env });

  const manifest = JSON.parse(await readFile(path.join(tempRoot, "artifacts", "public-survey-footprints", "release-manifest.json"), "utf8")) as { bundle?: { sha256?: string }; files?: unknown[] };
  if (!manifest.bundle?.sha256 || !Array.isArray(manifest.files) || manifest.files.length < 50) throw new Error("Generated release manifest is incomplete");

  const releaseDir = path.join(targetRoot, ".release-next");
  await rm(releaseDir, { recursive: true, force: true });
  await cp(tempRoot, releaseDir, { recursive: true, force: true });
  await rm(path.join(targetRoot, "artifacts"), { recursive: true, force: true });
  await rm(path.join(targetRoot, "src", "footprints"), { recursive: true, force: true });
  await rm(path.join(targetRoot, "src", "surveys"), { recursive: true, force: true });
  await rm(path.join(targetRoot, "docs", "public-footprint-moc-method.md"), { force: true });
  await rename(path.join(releaseDir, "artifacts"), path.join(targetRoot, "artifacts"));
  await rename(path.join(releaseDir, "src", "footprints"), path.join(targetRoot, "src", "footprints"));
  await rename(path.join(releaseDir, "src", "surveys"), path.join(targetRoot, "src", "surveys"));
  await rename(path.join(releaseDir, "docs", "public-footprint-moc-method.md"), path.join(targetRoot, "docs", "public-footprint-moc-method.md"));
  await cp(path.join(tempRoot, "site", "public"), path.join(targetRoot, "site", "public"), { recursive: true, force: true });
  await rm(releaseDir, { recursive: true, force: true });
  console.log(`Published Astro Survey Atlas assets: ${manifest.bundle.sha256}`);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
