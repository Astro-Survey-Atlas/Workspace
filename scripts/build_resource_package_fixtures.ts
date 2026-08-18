import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import yazl from "yazl";

import type { SurveyFootprintManifest } from "../src/survey-footprints.js";
import { CURATED_SURVEYS } from "../src/survey-registry.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const outputRoot = path.join(root, "bootstrap", "resource-packages");
const source = JSON.parse(await readFile(path.join(root, "src", "footprints", "survey-footprints.json"), "utf8")) as SurveyFootprintManifest;
const generatedAt = source.generatedAt;
const catalogOnly = process.argv.includes("--catalog-only");
const packageVersion = "2.0.2";

interface PackageDefinition {
  surveyId: string;
  name: string;
  description: string;
  modalities: string[];
  wavelengths: string[];
  productTypes: string[];
  facilities: string[];
  coverageAuthorities: string[];
  accessModes: string[];
  sources: Array<{ releaseId: string; label: string; url: string; authority: string; license?: string }>;
}

const definitions: readonly PackageDefinition[] = [
  {
    surveyId: "euclid", name: "Euclid", description: "Euclid Q1 三个深场的官方 DS9 ICRS 边界导出 MOC。",
    modalities: ["imaging", "photometry"], wavelengths: ["optical", "near-infrared"], productTypes: ["field-polygon-MOC"], facilities: ["ESA Euclid"], coverageAuthorities: ["official-boundary"], accessModes: ["ESA Science Archive"],
    sources: [{ releaseId: "euclid-q1", label: "Euclid Q1 DS9 field boundaries", url: "https://www.euclid-ec.org/wp-content/uploads/q1_region_files.zip", authority: "Euclid Consortium" }],
  },
  {
    surveyId: "galex", name: "GALEX", description: "GALEX GR6/GR7 FUV、NUV 与彩色 HiPS 图像的公开覆盖。",
    modalities: ["imaging", "ultraviolet"], wavelengths: ["far-ultraviolet", "near-ultraviolet"], productTypes: ["HiPS-image"], facilities: ["NASA GALEX", "MAST"], coverageAuthorities: ["third-party-moc"], accessModes: ["MAST", "CDS HiPS"],
    sources: [{ releaseId: "galex-gr6-gr7", label: "GALEX GR6/GR7 HiPS MOC", url: "https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FP%2FGALEXGR6_7%2Fcolor&get=record&fmt=json", authority: "CDS", license: "ODbL-1.0 derivative" }],
  },
  {
    surveyId: "legacy-surveys", name: "Legacy Surveys", description: "Legacy Surveys DR10 彩色成像覆盖，不代表 DESI 光谱覆盖。",
    modalities: ["imaging", "photometry"], wavelengths: ["optical", "infrared-photometry"], productTypes: ["HiPS-image"], facilities: ["DECam", "BASS", "MzLS"], coverageAuthorities: ["third-party-moc"], accessModes: ["Legacy Survey viewer", "CDS HiPS"],
    sources: [{ releaseId: "legacy-dr10", label: "Legacy Surveys DR10 HiPS MOC", url: "https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FP%2FDESI-Legacy-Surveys%2FDR10%2Fcolor&get=record&fmt=json", authority: "CDS", license: "ODbL-1.0 derivative" }],
  },
  {
    surveyId: "sdss", name: "SDSS", description: "SDSS DR9 彩色成像覆盖；光谱和后续数据发布需独立覆盖制品。",
    modalities: ["imaging", "photometry"], wavelengths: ["optical"], productTypes: ["HiPS-image"], facilities: ["Sloan Foundation Telescope"], coverageAuthorities: ["third-party-moc"], accessModes: ["SkyServer", "CDS HiPS"],
    sources: [{ releaseId: "sdss-dr09", label: "SDSS DR9 HiPS MOC", url: "https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FP%2FSDSS9%2Fcolor&get=record&fmt=json", authority: "CDS", license: "ODbL-1.0 derivative" }],
  },
  {
    surveyId: "hsc-ssp", name: "HSC-SSP", description: "HSC-SSP PDR2 Wide 与 Deep 的彩色及 grizy 图像 MOC 并集。",
    modalities: ["imaging", "photometry"], wavelengths: ["optical"], productTypes: ["HiPS-image"], facilities: ["Subaru Hyper Suprime-Cam"], coverageAuthorities: ["third-party-moc"], accessModes: ["HSC archive", "CDS HiPS"],
    sources: [{ releaseId: "hsc-pdr2", label: "HSC-SSP PDR2 HiPS MOCs", url: "https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FP%2FHSC%2FDR2%2Fwide%2Fcolor-i-r-g%2CCDS%2FP%2FHSC%2FDR2%2Fdeep%2Fcolor-i-r-g&get=record&fmt=json", authority: "CDS", license: "ODbL-1.0 derivative" }],
  },
  {
    surveyId: "hst", name: "HST", description: "CDS 已发布 HST HiPS 产品的档案快照覆盖，不等同于完整 MAST 产品并集。",
    modalities: ["imaging"], wavelengths: ["ultraviolet", "optical", "near-infrared"], productTypes: ["archive-snapshot"], facilities: ["Hubble Space Telescope", "MAST"], coverageAuthorities: ["third-party-moc"], accessModes: ["MAST", "CDS HiPS"],
    sources: [{ releaseId: "hst-mast-snapshot-2026", label: "Published HST HiPS MOC union", url: "https://alasky.cds.unistra.fr/MocServer/query?ID=*P%2FHST%2F*&get=record&fmt=json", authority: "CDS", license: "ODbL-1.0 derivative" }],
  },
  {
    surveyId: "panstarrs", name: "Pan-STARRS1", description: "Pan-STARRS1 DR1 彩色及 grizy HiPS 图像覆盖。",
    modalities: ["imaging", "photometry"], wavelengths: ["optical"], productTypes: ["HiPS-image"], facilities: ["Pan-STARRS1"], coverageAuthorities: ["third-party-moc"], accessModes: ["MAST", "CDS HiPS"],
    sources: [{ releaseId: "panstarrs-dr1", label: "Pan-STARRS1 DR1 HiPS MOC", url: "https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FP%2FPanSTARRS%2FDR1%2Fcolor-i-r-g&get=record&fmt=json", authority: "CDS", license: "ODbL-1.0 derivative" }],
  },
  {
    surveyId: "des", name: "DES", description: "Dark Energy Survey DR2 彩色成像覆盖。",
    modalities: ["imaging", "photometry"], wavelengths: ["optical"], productTypes: ["HiPS-image"], facilities: ["DECam"], coverageAuthorities: ["third-party-moc"], accessModes: ["DES Data Management", "CDS HiPS"],
    sources: [{ releaseId: "des-dr2", label: "DES DR2 HiPS MOC", url: "https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FP%2FDES-DR2%2FColorIRG&get=record&fmt=json", authority: "CDS", license: "ODbL-1.0 derivative" }],
  },
  {
    surveyId: "2mass", name: "2MASS", description: "2MASS All-Sky J、H、K 波段图像覆盖。",
    modalities: ["imaging", "photometry", "infrared"], wavelengths: ["near-infrared"], productTypes: ["HiPS-image"], facilities: ["2MASS"], coverageAuthorities: ["third-party-moc"], accessModes: ["IRSA", "CDS HiPS"],
    sources: [{ releaseId: "2mass-all-sky", label: "2MASS J-band HiPS MOC", url: "https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FP%2F2MASS%2FJ&get=record&fmt=json", authority: "CDS/IRSA", license: "ODbL-1.0 derivative" }],
  },
  {
    surveyId: "allwise", name: "AllWISE", description: "AllWISE W1-W4 静态图像覆盖，不表达 NEOWISE 时间完整性。",
    modalities: ["imaging", "photometry", "infrared"], wavelengths: ["mid-infrared"], productTypes: ["HiPS-image"], facilities: ["WISE", "IRSA"], coverageAuthorities: ["third-party-moc"], accessModes: ["IRSA", "CDS HiPS"],
    sources: [{ releaseId: "allwise", label: "AllWISE W1 HiPS MOC", url: "https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FP%2FallWISE%2FW1&get=record&fmt=json", authority: "CDS/IRSA", license: "ODbL-1.0 derivative" }],
  },
  {
    surveyId: "kids", name: "KiDS", description: "KiDS DR5 gri 彩色成像覆盖。",
    modalities: ["imaging", "photometry"], wavelengths: ["optical"], productTypes: ["HiPS-image"], facilities: ["ESO VST/OmegaCAM"], coverageAuthorities: ["survey-endorsed-moc"], accessModes: ["KiDS archive", "CDS HiPS"],
    sources: [{ releaseId: "kids-dr5", label: "KiDS DR5 gri HiPS MOC", url: "https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FP%2FKiDS%2FDR5%2Fcolor-gri&get=record&fmt=json", authority: "KiDS/CDS", license: "CC BY 4.0 upstream; ODbL-1.0 derivative" }],
  },
  {
    surveyId: "nvss", name: "NVSS", description: "NVSS 1.4 GHz 图像网格覆盖。",
    modalities: ["imaging"], wavelengths: ["radio-1.4GHz"], productTypes: ["HiPS-image"], facilities: ["NRAO VLA"], coverageAuthorities: ["third-party-moc"], accessModes: ["NRAO archive", "CDS HiPS"],
    sources: [{ releaseId: "nvss-final", label: "NVSS HiPS MOC", url: "https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FP%2FNVSS&get=record&fmt=json", authority: "CDS", license: "ODbL-1.0 derivative" }],
  },
];

async function createArchive(definition: PackageDefinition): Promise<{ fileName: string; sizeBytes: number; sha256: string }> {
  const version = packageVersion;
  const id = `public-${definition.surveyId}-footprints`;
  const manifest = {
    schemaVersion: 2,
    id,
    name: definition.name,
    description: definition.description,
    version,
    surveyId: definition.surveyId,
    createdAt: generatedAt,
    footprintManifest: "footprints/survey-footprints.json",
  };
  const footprints: SurveyFootprintManifest = {
    ...source,
    footprints: source.footprints.filter((footprint) => footprint.surveyId === definition.surveyId),
  };
  if (!footprints.footprints.length) throw new Error(`No footprint exists for ${definition.surveyId}`);
  const fileName = `${id}-${version}.zip`;
  const archivePath = path.join(outputRoot, fileName);
  if (catalogOnly) {
    const bytes = await readFile(archivePath);
    return { fileName, sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  }
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), "resource-package.json");
  zip.addBuffer(Buffer.from(`${JSON.stringify(footprints, null, 2)}\n`), "footprints/survey-footprints.json");
  zip.addBuffer(Buffer.from(`# ${definition.name}\n\n${definition.description}\n`), "README.md");
  zip.end();
  await new Promise<void>((resolve, reject) => zip.outputStream.pipe(createWriteStream(archivePath)).once("close", resolve).once("error", reject));
  const bytes = await readFile(archivePath);
  return { fileName, sizeBytes: (await stat(archivePath)).size, sha256: createHash("sha256").update(bytes).digest("hex") };
}

await mkdir(outputRoot, { recursive: true });
const packages = [];
for (const definition of definitions) {
  const archive = await createArchive(definition);
  const footprints = source.footprints.filter((footprint) => footprint.surveyId === definition.surveyId);
  const survey = CURATED_SURVEYS.find((candidate) => candidate.id === definition.surveyId);
  const releases = [...new Set(footprints.map((footprint) => footprint.releaseId))];
  packages.push({
    ...definition,
    id: `public-${definition.surveyId}-footprints`,
    releases,
    releaseLabels: Object.fromEntries(releases.map((releaseId) => [releaseId, survey?.releases.find((release) => release.id === releaseId)?.label ?? releaseId])),
    version: packageVersion,
    archiveUrl: archive.fileName,
    sizeBytes: archive.sizeBytes,
    sha256: archive.sha256,
    updatedAt: generatedAt,
  });
}
const previous = JSON.parse(await readFile(path.join(outputRoot, "catalog.json"), "utf8")) as { packages?: Array<Record<string, unknown>> };
const legacy = (previous.packages ?? []).filter((entry) => entry.id === "public-imaging-footprints" || entry.id === "public-ultraviolet-footprints").map((entry) => ({
  ...entry,
  hidden: true,
  deprecated: true,
  replacedBy: entry.id === "public-imaging-footprints"
    ? ["public-euclid-footprints", "public-legacy-surveys-footprints", "public-sdss-footprints", "public-hsc-ssp-footprints", "public-hst-footprints"]
    : ["public-galex-footprints"],
}));
await writeFile(path.join(outputRoot, "catalog.json"), `${JSON.stringify({ schemaVersion: 2, generatedAt, packages: [...packages, ...legacy] }, null, 2)}\n`);
