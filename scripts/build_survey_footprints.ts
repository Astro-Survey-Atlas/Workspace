import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { Healpix } from "healpixjs";

import {
  SURVEY_FOOTPRINT_SCHEMA_VERSION,
  type FootprintGeometryQuality,
  type SurveyFootprint,
  type SurveyFootprintManifest,
} from "../src/survey-footprints.js";

export const FOOTPRINT_NSIDE = 16;
const TARGET_ORDER = Math.log2(FOOTPRINT_NSIDE);
const MOC_SERVER_URL = "https://alasky.cds.unistra.fr/MocServer/query";

export interface MocJson {
  [order: string]: number[];
}

interface MocFootprintDefinition {
  surveyId: string;
  releaseId: string;
  product: string;
  label: string;
  sourceId: string;
  sourceUrl: string;
  notes: string;
  rawSourceIds?: readonly string[];
}

const MOC_FOOTPRINTS: readonly MocFootprintDefinition[] = [
  {
    surveyId: "galex",
    releaseId: "galex-gr6-gr7",
    product: "ultraviolet image coverage",
    label: "GALEX GR6/GR7 ultraviolet coverage",
    sourceId: "CDS/P/GALEXGR6_7/color",
    sourceUrl: "https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FP%2FGALEXGR6_7%2Fcolor&get=smoc&order=4&fmt=json",
    notes: "CDS HiPS MOC rasterized to NSIDE 16 for an overview. Coverage depth and band availability vary by pointing.",
  },
  {
    surveyId: "legacy-surveys",
    releaseId: "legacy-dr10",
    product: "DR10 color imaging",
    label: "Legacy Surveys DR10 imaging coverage",
    sourceId: "CDS/P/DESI-Legacy-Surveys/DR10/color",
    sourceUrl: "https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FP%2FDESI-Legacy-Surveys%2FDR10%2Fcolor&get=smoc&order=4&fmt=json",
    notes: "CDS HiPS MOC for Legacy Surveys DR10 color imaging, rasterized to NSIDE 16. This is imaging coverage, not DESI spectroscopy.",
  },
  {
    surveyId: "sdss",
    releaseId: "sdss-dr09",
    product: "DR9 color imaging",
    label: "SDSS DR9 imaging reference coverage",
    sourceId: "CDS/P/SDSS9/color",
    sourceUrl: "https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FP%2FSDSS9%2Fcolor&get=smoc&order=4&fmt=json",
    notes: "CDS MOC for SDSS DR9 imaging. Later SDSS releases and non-imaging products require their own product footprints.",
  },
  {
    surveyId: "hsc-ssp",
    releaseId: "hsc-pdr2",
    product: "PDR2 Wide + Deep image coverage",
    label: "HSC-SSP PDR2 Wide + Deep coverage",
    sourceId: "CDS/P/HSC/DR2/wide/color-i-r-g,CDS/P/HSC/DR2/deep/color-i-r-g",
    sourceUrl: "https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FP%2FHSC%2FDR2%2Fwide%2Fcolor-i-r-g%2CCDS%2FP%2FHSC%2FDR2%2Fdeep%2Fcolor-i-r-g&get=smoc&order=4&fmt=json",
    notes: "Union of CDS PDR2 Wide and Deep image MOCs, rasterized to NSIDE 16. PDR3 is registered separately and remains pending an artifact.",
    rawSourceIds: ["CDS/P/HSC/DR2/wide/color-i-r-g", "CDS/P/HSC/DR2/deep/color-i-r-g"],
  },
  {
    surveyId: "hst",
    releaseId: "hst-mast-snapshot-2026",
    product: "published HST HiPS pointings",
    label: "HST archive pointing coverage",
    sourceId: "*P/HST/*",
    sourceUrl: "https://alasky.cds.unistra.fr/MocServer/query?ID=*P%2FHST%2F*&get=smoc&order=4&fmt=json",
    notes: "Aggregate CDS MOC for published HST HiPS products. It is a discovery overview, not a claim that every MAST product exists at every highlighted cell.",
  },
  {
    surveyId: "panstarrs",
    releaseId: "panstarrs-dr1",
    product: "DR1 color imaging",
    label: "Pan-STARRS1 DR1 imaging coverage",
    sourceId: "CDS/P/PanSTARRS/DR1/color-i-r-g",
    sourceUrl: "https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FP%2FPanSTARRS%2FDR1%2Fcolor-i-r-g&get=smoc&order=4&fmt=json",
    notes: "CDS HiPS MOC for Pan-STARRS1 DR1 stacked color imaging. It does not represent DR2 catalogs or single-epoch warp coverage.",
  },
  {
    surveyId: "des",
    releaseId: "des-dr2",
    product: "DR2 color imaging",
    label: "Dark Energy Survey DR2 imaging coverage",
    sourceId: "CDS/P/DES-DR2/ColorIRG",
    sourceUrl: "https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FP%2FDES-DR2%2FColorIRG&get=smoc&order=4&fmt=json",
    notes: "CDS HiPS MOC for the DES DR2 color imaging product. Masks, single epochs and supernova products have different validity regions.",
  },
  {
    surveyId: "2mass",
    releaseId: "2mass-all-sky",
    product: "J-band imaging",
    label: "2MASS All-Sky J-band coverage",
    sourceId: "CDS/P/2MASS/J",
    sourceUrl: "https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FP%2F2MASS%2FJ&get=smoc&order=4&fmt=json",
    notes: "CDS/IRSA HiPS MOC for the 2MASS All-Sky J-band image product. Special mosaics and 6x observations are separate products.",
  },
  {
    surveyId: "allwise",
    releaseId: "allwise",
    product: "W1 imaging",
    label: "AllWISE W1 image coverage",
    sourceId: "CDS/P/allWISE/W1",
    sourceUrl: "https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FP%2FallWISE%2FW1&get=smoc&order=4&fmt=json",
    notes: "CDS/IRSA HiPS MOC for AllWISE W1 imaging. It is spatial coverage only and does not encode NEOWISE cadence or temporal completeness.",
  },
  {
    surveyId: "kids",
    releaseId: "kids-dr5",
    product: "DR5 gri imaging",
    label: "KiDS DR5 imaging coverage",
    sourceId: "CDS/P/KiDS/DR5/color-gri",
    sourceUrl: "https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FP%2FKiDS%2FDR5%2Fcolor-gri&get=smoc&order=4&fmt=json",
    notes: "KiDS survey-endorsed CDS-hosted DR5 gri HiPS MOC. Per-band masks and weak-lensing selections have different valid regions.",
  },
  {
    surveyId: "nvss",
    releaseId: "nvss-final",
    product: "1.4 GHz radio imaging",
    label: "NVSS 1.4 GHz imaging coverage",
    sourceId: "CDS/P/NVSS",
    sourceUrl: "https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FP%2FNVSS&get=smoc&order=4&fmt=json",
    notes: "CDS HiPS MOC derived from the NVSS image grid. Stokes products and sensitivity thresholds require product-specific validity masks.",
  },
];

interface EuclidField {
  name: string;
  raDeg: number;
  decDeg: number;
  areaDeg2: number;
}

const EUCLID_Q1_FIELDS: readonly EuclidField[] = [
  { name: "EDF-N", raDeg: 269.733, decDeg: 66.018, areaDeg2: 22.9 },
  { name: "EDF-S", raDeg: 61.241, decDeg: -48.423, areaDeg2: 28.1 },
  { name: "EDF-F", raDeg: 52.932, decDeg: -28.088, areaDeg2: 12.1 },
  { name: "Dark Cloud", raDeg: 85.75, decDeg: -8.367, areaDeg2: 0.5 },
];

export function expandMocToNside(moc: MocJson, targetOrder = TARGET_ORDER): number[] {
  const pixels = new Set<number>();
  for (const [key, values] of Object.entries(moc)) {
    const order = Number(key);
    if (!Number.isInteger(order) || order < 0 || !Array.isArray(values)) throw new Error(`Invalid MOC order: ${key}`);
    const factor = 4 ** Math.abs(targetOrder - order);
    for (const sourcePixel of values) {
      if (!Number.isInteger(sourcePixel) || sourcePixel < 0) throw new Error(`Invalid MOC pixel: ${sourcePixel}`);
      if (order <= targetOrder) {
        const first = sourcePixel * factor;
        for (let pixel = first; pixel < first + factor; pixel += 1) pixels.add(pixel);
      } else {
        pixels.add(Math.floor(sourcePixel / factor));
      }
    }
  }
  return [...pixels].sort((left, right) => left - right);
}

function angularDistanceDeg(leftRaDeg: number, leftDecDeg: number, rightRaDeg: number, rightDecDeg: number): number {
  const radians = Math.PI / 180;
  const leftRa = leftRaDeg * radians;
  const rightRa = rightRaDeg * radians;
  const leftDec = leftDecDeg * radians;
  const rightDec = rightDecDeg * radians;
  const cosine = Math.sin(leftDec) * Math.sin(rightDec) + Math.cos(leftDec) * Math.cos(rightDec) * Math.cos(leftRa - rightRa);
  return Math.acos(Math.max(-1, Math.min(1, cosine))) / radians;
}

/** A deliberately coarse official overview, used only when no release MOC is available. */
export function fieldOverviewPixels(fields: readonly EuclidField[], nside = FOOTPRINT_NSIDE): number[] {
  const healpix = new Healpix(nside);
  const pixels: number[] = [];
  const cellMarginDeg = 2.1;
  const pixelCount = 12 * nside ** 2;
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const center = healpix.pix2ang(pixel);
    const raDeg = (center.phi * 180) / Math.PI;
    const decDeg = 90 - (center.theta * 180) / Math.PI;
    if (fields.some((field) => angularDistanceDeg(raDeg, decDeg, field.raDeg, field.decDeg) <= Math.sqrt(field.areaDeg2 / Math.PI) + cellMarginDeg)) {
      pixels.push(pixel);
    }
  }
  return pixels;
}

async function requestMoc(sourceId: string): Promise<MocJson> {
  const parameters = new URLSearchParams({ ID: sourceId, get: "smoc", order: String(TARGET_ORDER), fmt: "json" });
  const response = await fetch(`${MOC_SERVER_URL}?${parameters}`, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`MOC request failed for ${sourceId}: ${response.status}`);
  return response.json() as Promise<MocJson>;
}

interface RawMocArtifact {
  surveyId: string;
  releaseId: string;
  product: string;
  sourceId: string;
  sourceUrl: string;
  metadataUrl: string;
  fitsPath: string;
  metadataPath: string;
  retrievedAt: string;
  mediaType: string;
  byteLength: number;
  sha256: string;
}

function rawFileStem(definition: MocFootprintDefinition, sourceId: string): string {
  const suffix = definition.rawSourceIds && definition.rawSourceIds.length > 1
    ? `-${sourceId.includes("/wide/") ? "wide" : "deep"}`
    : "";
  return `${definition.surveyId}-${definition.releaseId}-${definition.product}${suffix}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

async function preserveNativeMocs(rawRoot: string, retrievedAt: string): Promise<void> {
  await mkdir(rawRoot, { recursive: true });
  const artifacts = await Promise.all(MOC_FOOTPRINTS.flatMap((definition) => (definition.rawSourceIds ?? [definition.sourceId]).map(async (sourceId): Promise<RawMocArtifact> => {
    const fitsParameters = new URLSearchParams({ ID: sourceId, get: "smoc", fmt: "fits" });
    const metadataParameters = new URLSearchParams({ ID: sourceId, get: "record", fmt: "json" });
    const sourceUrl = `${MOC_SERVER_URL}?${fitsParameters}`;
    const metadataUrl = `${MOC_SERVER_URL}?${metadataParameters}`;
    const [fitsResponse, metadataResponse] = await Promise.all([
      fetch(sourceUrl, { signal: AbortSignal.timeout(120_000) }),
      fetch(metadataUrl, { signal: AbortSignal.timeout(120_000) }),
    ]);
    if (!fitsResponse.ok) throw new Error(`Native MOC request failed for ${sourceId}: ${fitsResponse.status}`);
    if (!metadataResponse.ok) throw new Error(`MOC metadata request failed for ${sourceId}: ${metadataResponse.status}`);
    const fits = Buffer.from(await fitsResponse.arrayBuffer());
    const metadata = await metadataResponse.text();
    JSON.parse(metadata);
    const stem = rawFileStem(definition, sourceId);
    const fitsName = `${stem}.fits`;
    const metadataName = `${stem}.record.json`;
    await Promise.all([
      writeFile(path.join(rawRoot, fitsName), fits),
      writeFile(path.join(rawRoot, metadataName), `${JSON.stringify(JSON.parse(metadata), null, 2)}\n`, "utf8"),
    ]);
    return {
      surveyId: definition.surveyId,
      releaseId: definition.releaseId,
      product: definition.product,
      sourceId,
      sourceUrl,
      metadataUrl,
      fitsPath: fitsName,
      metadataPath: metadataName,
      retrievedAt,
      mediaType: fitsResponse.headers.get("content-type") ?? "application/fits",
      byteLength: fits.byteLength,
      sha256: createHash("sha256").update(fits).digest("hex"),
    };
  })));
  await writeFile(path.join(rawRoot, "index.json"), `${JSON.stringify({
    schemaVersion: 1,
    generatedAt: retrievedAt,
    coordinateFrame: "ICRS",
    format: "FITS MOC 2.0 (native resolution)",
    artifacts,
  }, null, 2)}\n`, "utf8");
}

function mocFootprint(definition: MocFootprintDefinition, pixels: number[], retrievedAt: string): SurveyFootprint {
  return {
    surveyId: definition.surveyId,
    releaseId: definition.releaseId,
    product: definition.product,
    label: definition.label,
    nside: FOOTPRINT_NSIDE,
    pixels,
    quality: "moc" satisfies FootprintGeometryQuality,
    sourceUrl: definition.sourceUrl,
    sourceId: definition.sourceId,
    retrievedAt,
    notes: definition.notes,
  };
}

export async function buildSurveyFootprints(): Promise<SurveyFootprintManifest> {
  const retrievedAt = new Date().toISOString();
  const footprints = await Promise.all(MOC_FOOTPRINTS.map(async (definition) => mocFootprint(definition, expandMocToNside(await requestMoc(definition.sourceId)), retrievedAt)));
  footprints.unshift({
    surveyId: "euclid",
    releaseId: "euclid-q1",
    product: "Q1 deep fields",
    label: "Euclid Q1 deep-field overview",
    nside: FOOTPRINT_NSIDE,
    pixels: fieldOverviewPixels(EUCLID_Q1_FIELDS),
    quality: "official_overview",
    sourceUrl: "https://www.euclid-ec.org/science/q1/",
    retrievedAt,
    notes: "Official Q1 field centers and areas rasterized to NSIDE 16. This overview is not a replacement for the Q1 DS9 field polygons.",
  });
  return {
    schemaVersion: SURVEY_FOOTPRINT_SCHEMA_VERSION,
    generatedAt: retrievedAt,
    coordinateFrame: "ICRS",
    nside: FOOTPRINT_NSIDE,
    footprints,
  };
}

async function main(): Promise<void> {
  const outputDirectory = path.resolve(process.argv[2] ?? "src/footprints");
  const manifest = await buildSurveyFootprints();
  const rawRoot = path.resolve("artifacts/public-survey-footprints/raw/moc");
  await preserveNativeMocs(rawRoot, manifest.generatedAt);
  await mkdir(outputDirectory, { recursive: true });
  const outputPath = path.join(outputDirectory, "survey-footprints.json");
  await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote ${manifest.footprints.length} survey footprints (${manifest.footprints.reduce((total, footprint) => total + footprint.pixels.length, 0)} cells) to ${outputPath}; native MOCs to ${rawRoot}`);
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
