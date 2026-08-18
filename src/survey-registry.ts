import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type SurveyModality = "imaging" | "spectroscopy" | "photometry" | "time-domain" | "integral-field" | "ultraviolet" | "infrared" | "catalog";
export type ReleaseKind = "public_release" | "quick_release" | "early_release" | "science_results" | "archive_snapshot" | "planned";
export type ReleaseAvailability = "available" | "metadata_only" | "planned";
export type FootprintStatus = "verified" | "summary_only" | "pending";

export interface SurveyProduct {
  name: string;
  modality: SurveyModality;
  description: string;
}

export interface SurveyReleaseCoverage {
  status: FootprintStatus;
  summary: string;
  areaDeg2?: number;
  sourceUrl: string;
}

export interface SurveyRelease {
  id: string;
  label: string;
  phase?: string;
  kind: ReleaseKind;
  availability: ReleaseAvailability;
  releasedYear?: number;
  modalities: SurveyModality[];
  products: SurveyProduct[];
  coverage: SurveyReleaseCoverage;
}

export interface SurveyRecord {
  id: string;
  name: string;
  mission: string;
  color: string;
  description: string;
  modalities: SurveyModality[];
  origin: "curated" | "user";
  releases: SurveyRelease[];
}

export interface SurveyCard {
  id: string;
  name: string;
  mission: string;
  color: string;
  description: string;
  modalities: SurveyModality[];
  origin: "curated" | "user";
  releaseCount: number;
  availableReleaseCount: number;
  verifiedFootprintReleaseCount: number;
  coverageStatus: FootprintStatus;
}

export interface SurveyRegistrationInput {
  id?: string;
  name: string;
  mission?: string;
  color?: string;
  sourceUrl: string;
  description?: string;
  modalities: SurveyModality[];
  releases?: SurveyReleaseRegistrationInput[];
}

export type SurveyReleaseRegistrationInput = SurveyRelease;

const MODALITIES: readonly SurveyModality[] = ["imaging", "spectroscopy", "photometry", "time-domain", "integral-field", "ultraviolet", "infrared", "catalog"];
const RELEASE_KINDS: readonly ReleaseKind[] = ["public_release", "quick_release", "early_release", "science_results", "archive_snapshot", "planned"];
const RELEASE_AVAILABILITIES: readonly ReleaseAvailability[] = ["available", "metadata_only", "planned"];
const FOOTPRINT_STATUSES: readonly FootprintStatus[] = ["verified", "summary_only", "pending"];
const REGISTRATION_FIELDS = new Set(["id", "name", "mission", "color", "sourceUrl", "description", "modalities", "releases"]);
const RECORD_FIELDS = new Set(["id", "name", "mission", "color", "description", "modalities", "origin", "releases"]);
const RELEASE_FIELDS = new Set(["id", "label", "phase", "kind", "availability", "releasedYear", "modalities", "products", "coverage"]);
const PRODUCT_FIELDS = new Set(["name", "modality", "description"]);
const COVERAGE_FIELDS = new Set(["status", "summary", "areaDeg2", "sourceUrl"]);
const STABLE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,118}[a-z0-9])?$/;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RangeError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function rejectUnknownFields(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  const unknown = Object.keys(value).find((field) => !allowed.has(field));
  if (unknown) throw new RangeError(`${label} contains unknown field: ${unknown}`);
}

function requiredText(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim()) throw new RangeError(`${name} is required`);
  const result = value.trim();
  if (result.length > maximum) throw new RangeError(`${name} must contain at most ${maximum} characters`);
  return result;
}

function optionalText(value: unknown, name: string, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new RangeError(`${name} must be a string`);
  const result = value.trim();
  if (result.length > maximum) throw new RangeError(`${name} must contain at most ${maximum} characters`);
  return result || undefined;
}

function stableId(value: unknown, name: string): string {
  const result = requiredText(value, name, 120);
  if (!STABLE_ID.test(result)) throw new RangeError(`${name} must be a lowercase stable identifier`);
  return result;
}

function webUrl(value: unknown, name: string): string {
  const result = requiredText(value, name, 2048);
  let protocol: string;
  try {
    protocol = new URL(result).protocol;
  } catch {
    throw new RangeError(`${name} must be a valid URL`);
  }
  if (protocol !== "https:" && protocol !== "http:") throw new RangeError(`${name} must use http or https`);
  return result;
}

function surveyModalities(value: unknown, name = "modalities"): SurveyModality[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MODALITIES.length || value.some((entry) => !MODALITIES.includes(entry as SurveyModality))) {
    throw new RangeError(`${name} must contain one or more supported values`);
  }
  return [...new Set(value as SurveyModality[])];
}

function surveyColor(value: unknown, required = false): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || !HEX_COLOR.test(value.trim())) throw new RangeError("color must be a six-digit hexadecimal color");
  return value.trim().toLowerCase();
}

function normalizeProduct(value: unknown, index: number): SurveyProduct {
  const product = objectValue(value, `products[${index}]`);
  rejectUnknownFields(product, PRODUCT_FIELDS, `products[${index}]`);
  if (!MODALITIES.includes(product.modality as SurveyModality)) throw new RangeError(`products[${index}].modality is not supported`);
  return {
    name: requiredText(product.name, `products[${index}].name`, 160),
    modality: product.modality as SurveyModality,
    description: requiredText(product.description, `products[${index}].description`, 500),
  };
}

function normalizeCoverage(value: unknown): SurveyReleaseCoverage {
  const coverage = objectValue(value, "coverage");
  rejectUnknownFields(coverage, COVERAGE_FIELDS, "coverage");
  if (!FOOTPRINT_STATUSES.includes(coverage.status as FootprintStatus)) throw new RangeError("coverage.status is not supported");
  let areaDeg2: number | undefined;
  if (coverage.areaDeg2 !== undefined) {
    if (typeof coverage.areaDeg2 !== "number" || !Number.isFinite(coverage.areaDeg2) || coverage.areaDeg2 < 0 || coverage.areaDeg2 > 50_000) {
      throw new RangeError("coverage.areaDeg2 must be a finite number from 0 through 50000");
    }
    areaDeg2 = coverage.areaDeg2;
  }
  return {
    status: coverage.status as FootprintStatus,
    summary: requiredText(coverage.summary, "coverage.summary", 1000),
    ...(areaDeg2 === undefined ? {} : { areaDeg2 }),
    sourceUrl: webUrl(coverage.sourceUrl, "coverage.sourceUrl"),
  };
}

function normalizeRelease(value: unknown): SurveyRelease {
  const input = objectValue(value, "release");
  rejectUnknownFields(input, RELEASE_FIELDS, "release");
  if (!RELEASE_KINDS.includes(input.kind as ReleaseKind)) throw new RangeError("release.kind is not supported");
  if (!RELEASE_AVAILABILITIES.includes(input.availability as ReleaseAvailability)) throw new RangeError("release.availability is not supported");
  if (!Array.isArray(input.products) || input.products.length < 1 || input.products.length > 100) {
    throw new RangeError("release.products must contain between 1 and 100 products");
  }
  let releasedYear: number | undefined;
  if (input.releasedYear !== undefined) {
    if (!Number.isInteger(input.releasedYear) || (input.releasedYear as number) < 1800 || (input.releasedYear as number) > 3000) {
      throw new RangeError("release.releasedYear must be an integer from 1800 through 3000");
    }
    releasedYear = input.releasedYear as number;
  }
  const modalities = surveyModalities(input.modalities, "release.modalities");
  const products = input.products.map(normalizeProduct);
  if (products.some((product) => !modalities.includes(product.modality))) {
    throw new RangeError("release products must use a modality declared by the release");
  }
  return {
    id: stableId(input.id, "release.id"),
    label: requiredText(input.label, "release.label", 160),
    ...(optionalText(input.phase, "release.phase", 120) ? { phase: optionalText(input.phase, "release.phase", 120) } : {}),
    kind: input.kind as ReleaseKind,
    availability: input.availability as ReleaseAvailability,
    ...(releasedYear === undefined ? {} : { releasedYear }),
    modalities,
    products,
    coverage: normalizeCoverage(input.coverage),
  };
}

function release(
  id: string,
  label: string,
  options: Omit<SurveyRelease, "id" | "label">,
): SurveyRelease {
  return { id, label, ...options };
}

const sdssReleases: SurveyRelease[] = Array.from({ length: 19 }, (_, index) => {
  const number = index + 1;
  const phase = number <= 7 ? "SDSS-I/II" : number <= 12 ? "SDSS-III" : number <= 17 ? "SDSS-IV" : "SDSS-V";
  const modalities: SurveyModality[] = number <= 7
    ? ["imaging", "spectroscopy", "photometry", "catalog"]
    : number <= 12
      ? ["imaging", "spectroscopy", "infrared", "catalog"]
      : number <= 17
        ? ["imaging", "spectroscopy", "infrared", "integral-field", "catalog"]
        : ["spectroscopy", "integral-field", "catalog"];
  const coverage = number === 7
    ? { status: "summary_only" as const, summary: "DR7 imaging catalog: 11,663 deg2 total; unique Legacy imaging: 8,423 deg2; spectroscopy: 9,380 deg2. Product footprints differ.", areaDeg2: 11663, sourceUrl: "https://www.sdss.org/dr7/" }
    : number === 17
      ? { status: "summary_only" as const, summary: "Final SDSS-IV release. Imaging, optical spectra, APOGEE, MaNGA and MaStar use distinct footprints.", sourceUrl: "https://www.sdss.org/dr17/" }
      : { status: "pending" as const, summary: "Release is registered; product-level footprint artifact has not yet been ingested.", sourceUrl: `https://www.sdss.org/dr${number}/` };
  return release(`sdss-dr${String(number).padStart(2, "0")}`, `DR${number}`, {
    phase,
    kind: "public_release",
    availability: "available",
    modalities,
    products: [{ name: `${phase} release catalog`, modality: "catalog", description: "Release-specific tables and documented data products." }],
    coverage,
  });
});

const legacyReleases: SurveyRelease[] = Array.from({ length: 10 }, (_, index) => {
  const number = index + 1;
  return release(`legacy-dr${number}`, `DR${number}`, {
    kind: "public_release",
    availability: "available",
    modalities: ["imaging", "photometry", "catalog"],
    products: [
      { name: "Coadded imaging", modality: "imaging", description: "DECaLS, BASS and MzLS imaging products." },
      { name: "Tractor catalog", modality: "catalog", description: "Forced photometry catalog derived from the imaging releases." },
    ],
    coverage: {
      status: "pending",
      summary: "Release is registered; exact brick/MOC footprint is pending ingestion from release metadata.",
      sourceUrl: "https://www.legacysurvey.org/",
    },
  });
});

export const CURATED_SURVEYS: readonly SurveyRecord[] = [
  {
    id: "euclid",
    name: "Euclid",
    mission: "ESA Euclid",
    color: "#a7d9ff",
    description: "ESA visible and near-infrared space survey releases, represented by their actual release families rather than a fabricated radial shell.",
    modalities: ["imaging", "spectroscopy", "photometry", "catalog"],
    origin: "curated",
    releases: [
      release("euclid-ero", "ERO", {
        kind: "early_release",
        availability: "available",
        releasedYear: 2024,
        modalities: ["imaging", "photometry", "catalog"],
        products: [{ name: "Early Release Observations", modality: "imaging", description: "Selected Euclid commissioning and early science fields." }],
        coverage: { status: "pending", summary: "Early-release fields are registered; a release MOC is not bundled yet.", sourceUrl: "https://www.cosmos.esa.int/web/euclid/early-release-observations" },
      }),
      release("euclid-q1", "Q1", {
        kind: "quick_release",
        availability: "available",
        releasedYear: 2025,
        modalities: ["imaging", "photometry", "catalog"],
        products: [{ name: "Euclid Q1 deep fields", modality: "imaging", description: "Three deep fields, 63.1 deg2 in the first quick release." }],
        coverage: { status: "verified", summary: "Three deep fields, 63.1 deg2. The official Q1 DS9 field polygons are rasterized into the product MOC.", areaDeg2: 63.1, sourceUrl: "https://www.euclid-ec.org/wp-content/uploads/q1_region_files.zip" },
      }),
      release("euclid-q2", "Q2", {
        kind: "quick_release",
        availability: "available",
        releasedYear: 2026,
        modalities: ["imaging", "photometry", "catalog"],
        products: [{ name: "Galactic Bulge Survey", modality: "imaging", description: "Nine VIS fields in the Euclid Galactic Bulge Survey." }],
        coverage: { status: "summary_only", summary: "Nine Galactic Bulge Survey fields covering 4.8 deg2. Exact field polygons/MOC are pending ingestion.", areaDeg2: 4.8, sourceUrl: "https://www.cosmos.esa.int/web/euclid/q2-contents" },
      }),
      release("euclid-dr1", "DR1", {
        kind: "planned",
        availability: "planned",
        modalities: ["imaging", "spectroscopy", "photometry", "catalog"],
        products: [{ name: "Euclid DR1", modality: "catalog", description: "Planned first wide Euclid data release." }],
        coverage: { status: "pending", summary: "Planned release; it is not a currently queryable coverage record.", sourceUrl: "https://www.cosmos.esa.int/web/euclid/euclid-dr1-overview" },
      }),
    ],
  },
  {
    id: "desi",
    name: "DESI",
    mission: "Dark Energy Spectroscopic Instrument",
    color: "#f3b55d",
    description: "Public DESI spectroscopic release families. Local COSMOS-derived volume data remains a separate registered artifact, not a proxy for this footprint.",
    modalities: ["spectroscopy", "catalog"],
    origin: "curated",
    releases: [
      release("desi-edr", "EDR", {
        kind: "early_release",
        availability: "available",
        releasedYear: 2023,
        modalities: ["spectroscopy", "catalog"],
        products: [{ name: "Early Data Release spectra", modality: "spectroscopy", description: "DESI public early-release spectra and catalogs." }],
        coverage: { status: "pending", summary: "Exact EDR footprint artifact is pending ingestion.", sourceUrl: "https://data.desi.lbl.gov/doc/releases/edr/" },
      }),
      release("desi-dr1", "DR1", {
        kind: "public_release",
        availability: "available",
        releasedYear: 2025,
        modalities: ["spectroscopy", "catalog"],
        products: [{ name: "DR1 spectra and redshifts", modality: "spectroscopy", description: "Main-survey spectra observed from May 2021 through June 2022." }],
        coverage: { status: "summary_only", summary: "DR1 published area summaries: Backup 2,726 deg2, Bright 9,739 deg2, Dark 9,528 deg2. Product-level MOC is pending ingestion.", areaDeg2: 9528, sourceUrl: "https://data.desi.lbl.gov/doc/releases/dr1/" },
      }),
      release("desi-dr2-results", "DR2 cosmology results", {
        kind: "science_results",
        availability: "metadata_only",
        releasedYear: 2025,
        modalities: ["catalog"],
        products: [{ name: "DR2 science-result tables", modality: "catalog", description: "Science release supporting cosmology results; not modeled as a general public spectroscopic catalog release." }],
        coverage: { status: "pending", summary: "Scientific result metadata only; no general release footprint is registered.", sourceUrl: "https://data.desi.lbl.gov/doc/releases/" },
      }),
    ],
  },
  {
    id: "sdss",
    name: "SDSS",
    mission: "Sloan Digital Sky Survey I-V",
    color: "#95dc9b",
    description: "Nineteen public data releases grouped under one survey card. A release may contain several products with different sky footprints.",
    modalities: ["imaging", "spectroscopy", "photometry", "infrared", "integral-field", "catalog"],
    origin: "curated",
    releases: sdssReleases,
  },
  {
    id: "galex",
    name: "GALEX",
    mission: "Galaxy Evolution Explorer",
    color: "#cf96ed",
    description: "Ultraviolet imaging, grism spectroscopy and time-domain survey archive releases.",
    modalities: ["ultraviolet", "imaging", "spectroscopy", "time-domain", "catalog"],
    origin: "curated",
    releases: [
      release("galex-gr1", "GR1", { kind: "public_release", availability: "available", modalities: ["ultraviolet", "imaging", "catalog"], products: [{ name: "GALEX GR1", modality: "catalog", description: "Initial GALEX release." }], coverage: { status: "pending", summary: "Tile-level footprint is pending ingestion.", sourceUrl: "https://galex.stsci.edu/GR6/" } }),
      release("galex-gr2-gr3", "GR2/GR3", { kind: "public_release", availability: "available", modalities: ["ultraviolet", "imaging", "catalog"], products: [{ name: "GALEX GR2/GR3", modality: "catalog", description: "Combined public release family." }], coverage: { status: "pending", summary: "Tile-level footprint is pending ingestion.", sourceUrl: "https://galex.stsci.edu/GR6/" } }),
      release("galex-gr4-gr5", "GR4/GR5", { kind: "public_release", availability: "available", modalities: ["ultraviolet", "imaging", "catalog"], products: [{ name: "GALEX GR4/GR5", modality: "catalog", description: "Combined public release family." }], coverage: { status: "pending", summary: "Tile-level footprint is pending ingestion.", sourceUrl: "https://galex.stsci.edu/GR6/" } }),
      release("galex-gr6-gr7", "GR6/GR7", { kind: "public_release", availability: "available", modalities: ["ultraviolet", "imaging", "spectroscopy", "time-domain", "catalog"], products: [
        { name: "GALEX GR6/GR7", modality: "catalog", description: "45,195 tiles across AIS, MIS, DIS and related surveys." },
        { name: "FUV imaging", modality: "ultraviolet", description: "GR6/GR7 far-ultraviolet HiPS image product." },
        { name: "NUV imaging", modality: "ultraviolet", description: "GR6/GR7 near-ultraviolet HiPS image product." },
      ], coverage: { status: "summary_only", summary: "Observed 77% of the sky at varying depth in at least one band. Exact union must be built from the 45,195 tile records.", sourceUrl: "https://galex.stsci.edu/GR6/" } }),
    ],
  },
  {
    id: "legacy-surveys",
    name: "Legacy Surveys",
    mission: "DECaLS, BASS and MzLS",
    color: "#fd8ea1",
    description: "Optical imaging and Tractor catalogs from the Legacy Surveys release sequence.",
    modalities: ["imaging", "photometry", "catalog"],
    origin: "curated",
    releases: legacyReleases,
  },
  {
    id: "hsc-ssp",
    name: "HSC-SSP",
    mission: "Subaru Hyper Suprime-Cam",
    color: "#63d5c7",
    description: "Subaru Strategic Program public releases, with Wide, Deep and UltraDeep layers recorded as product families rather than radial distances.",
    modalities: ["imaging", "photometry", "catalog"],
    origin: "curated",
    releases: [
      release("hsc-pdr1", "PDR1", { kind: "public_release", availability: "available", releasedYear: 2017, modalities: ["imaging", "photometry", "catalog"], products: [{ name: "HSC-SSP PDR1", modality: "catalog", description: "Initial public HSC-SSP imaging release." }], coverage: { status: "summary_only", summary: "More than 100 deg2; detailed release footprint/MOC is pending ingestion.", areaDeg2: 100, sourceUrl: "https://hsc-release.mtk.nao.ac.jp/doc/index.php/sample-page/top-page-3/" } }),
      release("hsc-pdr2", "PDR2", { kind: "public_release", availability: "available", releasedYear: 2019, modalities: ["imaging", "photometry", "catalog"], products: [
        { name: "HSC-SSP PDR2", modality: "catalog", description: "Second public HSC-SSP imaging release." },
        { name: "PDR2 g-band imaging", modality: "imaging", description: "Wide and Deep g-band image coverage." },
        { name: "PDR2 r-band imaging", modality: "imaging", description: "Wide and Deep r-band image coverage." },
        { name: "PDR2 i-band imaging", modality: "imaging", description: "Wide and Deep i-band image coverage." },
        { name: "PDR2 z-band imaging", modality: "imaging", description: "Wide and Deep z-band image coverage." },
        { name: "PDR2 y-band imaging", modality: "imaging", description: "Wide and Deep y-band image coverage." },
      ], coverage: { status: "summary_only", summary: "More than 300 deg2; detailed release footprint/MOC is pending ingestion.", areaDeg2: 300, sourceUrl: "https://hsc-release.mtk.nao.ac.jp/doc/index.php/sample-page/pdr2/" } }),
      release("hsc-pdr3", "PDR3", { kind: "public_release", availability: "available", releasedYear: 2021, modalities: ["imaging", "photometry", "catalog"], products: [{ name: "HSC-SSP Wide/Deep/UltraDeep", modality: "imaging", description: "grizy imaging, with narrow-band data in the deeper layers." }], coverage: { status: "summary_only", summary: "More than 600 deg2 across Wide, Deep and UltraDeep layers; detailed release footprint/MOC is pending ingestion.", areaDeg2: 600, sourceUrl: "https://hsc-release.mtk.nao.ac.jp/doc/index.php/survey__pdr3/" } }),
    ],
  },
  {
    id: "hst",
    name: "HST",
    mission: "Hubble Space Telescope / MAST",
    color: "#79a9ff",
    description: "A heterogeneous pointed-observation archive. It is recorded as dated archive snapshots and products, not as a fictitious uniform DR sequence.",
    modalities: ["imaging", "spectroscopy", "ultraviolet", "infrared", "catalog"],
    origin: "curated",
    releases: [
      release("hst-mast-snapshot-2026", "MAST archive snapshot 2026", {
        kind: "archive_snapshot",
        availability: "available",
        releasedYear: 2026,
        modalities: ["imaging", "spectroscopy", "ultraviolet", "infrared", "catalog"],
        products: [
          { name: "Instrument archive", modality: "imaging", description: "Pointed imaging from instruments including ACS and WFC3." },
          { name: "Hubble Source Catalog", modality: "catalog", description: "Cross-visit source catalog product." },
          { name: "Hubble Advanced Products", modality: "imaging", description: "Processed science-ready archive products." },
        ],
        coverage: { status: "pending", summary: "Pointings and product footprints vary by instrument and proposal. A selected archive snapshot must be ingested before spatial drill-down.", sourceUrl: "https://archive.stsci.edu/missions-and-data/hst" },
      }),
    ],
  },
  {
    id: "panstarrs",
    name: "Pan-STARRS1",
    mission: "Panoramic Survey Telescope and Rapid Response System",
    color: "#f2c66d",
    description: "Wide-field optical imaging and time-domain products. The bundled footprint is limited to the DR1 stacked color image product.",
    modalities: ["imaging", "photometry", "time-domain", "catalog"],
    origin: "curated",
    releases: [release("panstarrs-dr1", "DR1", {
      kind: "public_release",
      availability: "available",
      releasedYear: 2016,
      modalities: ["imaging", "photometry", "catalog"],
      products: [
        { name: "DR1 stacked color imaging", modality: "imaging", description: "Stacked i/r/g image product represented by the CDS HiPS coverage." },
        { name: "DR1 g-band imaging", modality: "imaging", description: "DR1 g-band HiPS image product." },
        { name: "DR1 r-band imaging", modality: "imaging", description: "DR1 r-band HiPS image product." },
        { name: "DR1 i-band imaging", modality: "imaging", description: "DR1 i-band HiPS image product." },
        { name: "DR1 z-band imaging", modality: "imaging", description: "DR1 z-band HiPS image product." },
        { name: "DR1 y-band imaging", modality: "imaging", description: "DR1 y-band HiPS image product." },
      ],
      coverage: { status: "verified", summary: "DR1 stacked color image coverage from the CDS HiPS MOC. DR2 and single-epoch products are not implied.", sourceUrl: "https://outerspace.stsci.edu/display/PANSTARRS/" },
    })],
  },
  {
    id: "des",
    name: "DES",
    mission: "Dark Energy Survey",
    color: "#ef7f79",
    description: "Southern-sky optical imaging, catalogs and time-domain supernova fields. The bundled footprint represents the DR2 color image product.",
    modalities: ["imaging", "photometry", "time-domain", "catalog"],
    origin: "curated",
    releases: [release("des-dr2", "DR2", {
      kind: "public_release",
      availability: "available",
      releasedYear: 2021,
      modalities: ["imaging", "photometry", "catalog"],
      products: [{ name: "DR2 color imaging", modality: "imaging", description: "DR2 coadded color image coverage; masks and single epochs have separate validity." }],
      coverage: { status: "verified", summary: "DR2 color image coverage from the CDS HiPS MOC.", sourceUrl: "https://des.ncsa.illinois.edu/releases/dr2" },
    })],
  },
  {
    id: "2mass",
    name: "2MASS",
    mission: "Two Micron All Sky Survey",
    color: "#ffb36b",
    description: "Near-infrared all-sky imaging and source catalogs. The bundled artifact is specifically the All-Sky J-band image coverage.",
    modalities: ["imaging", "photometry", "infrared", "catalog"],
    origin: "curated",
    releases: [release("2mass-all-sky", "All-Sky Release", {
      kind: "public_release",
      availability: "available",
      releasedYear: 2003,
      modalities: ["imaging", "photometry", "infrared", "catalog"],
      products: [
        { name: "J-band imaging", modality: "infrared", description: "All-Sky J-band atlas image coverage represented by the CDS/IRSA HiPS MOC." },
        { name: "H-band imaging", modality: "infrared", description: "All-Sky H-band atlas image coverage represented by the CDS/IRSA HiPS MOC." },
        { name: "K-band imaging", modality: "infrared", description: "All-Sky K-band atlas image coverage represented by the CDS/IRSA HiPS MOC." },
      ],
      coverage: { status: "verified", summary: "All-sky J/H/K image coverage; 6x observations and special mosaics are separate products.", sourceUrl: "https://irsa.ipac.caltech.edu/Missions/2mass.html" },
    })],
  },
  {
    id: "allwise",
    name: "AllWISE",
    mission: "WISE / NASA IPAC Infrared Science Archive",
    color: "#d89dff",
    description: "Mid-infrared all-sky images and catalogs. The static footprint does not encode NEOWISE cadence or temporal completeness.",
    modalities: ["imaging", "photometry", "time-domain", "infrared", "catalog"],
    origin: "curated",
    releases: [release("allwise", "AllWISE", {
      kind: "public_release",
      availability: "available",
      releasedYear: 2013,
      modalities: ["imaging", "photometry", "infrared", "catalog"],
      products: [
        { name: "W1 imaging", modality: "infrared", description: "AllWISE W1 image coverage represented by the CDS/IRSA HiPS MOC." },
        { name: "W2 imaging", modality: "infrared", description: "AllWISE W2 image coverage represented by the CDS/IRSA HiPS MOC." },
        { name: "W3 imaging", modality: "infrared", description: "AllWISE W3 image coverage represented by the CDS/IRSA HiPS MOC." },
        { name: "W4 imaging", modality: "infrared", description: "AllWISE W4 image coverage represented by the CDS/IRSA HiPS MOC." },
      ],
      coverage: { status: "verified", summary: "Static W1-W4 sky coverage; temporal completeness requires an exposure-level model.", sourceUrl: "https://irsa.ipac.caltech.edu/Missions/wise.html" },
    })],
  },
  {
    id: "kids",
    name: "KiDS",
    mission: "Kilo-Degree Survey / ESO VST",
    color: "#65d79b",
    description: "ESO optical imaging and weak-lensing survey products. The bundled footprint represents the DR5 gri color image product.",
    modalities: ["imaging", "photometry", "catalog"],
    origin: "curated",
    releases: [release("kids-dr5", "DR5", {
      kind: "public_release",
      availability: "available",
      releasedYear: 2025,
      modalities: ["imaging", "photometry", "catalog"],
      products: [{ name: "DR5 gri imaging", modality: "imaging", description: "Survey-endorsed CDS-hosted gri HiPS coverage; per-band masks remain distinct." }],
      coverage: { status: "verified", summary: "DR5 gri image coverage from the survey-endorsed CDS HiPS MOC.", sourceUrl: "https://kids.strw.leidenuniv.nl/DR5/index.php" },
    })],
  },
  {
    id: "nvss",
    name: "NVSS",
    mission: "NRAO VLA Sky Survey",
    color: "#60bce8",
    description: "1.4 GHz radio continuum image and source catalog survey. Product-specific sensitivity and Stokes validity are not encoded by the overview footprint.",
    modalities: ["imaging", "catalog"],
    origin: "curated",
    releases: [release("nvss-final", "Final survey", {
      kind: "public_release",
      availability: "available",
      releasedYear: 1998,
      modalities: ["imaging", "catalog"],
      products: [{ name: "1.4 GHz radio imaging", modality: "imaging", description: "NVSS image-grid coverage represented by the CDS HiPS MOC." }],
      coverage: { status: "verified", summary: "Image-grid sky coverage; sensitivity thresholds and Stokes products need separate masks.", sourceUrl: "https://www.cv.nrao.edu/nvss/" },
    })],
  },
];

function deriveCoverageStatus(releases: readonly SurveyRelease[]): FootprintStatus {
  if (releases.some((entry) => entry.coverage.status === "verified")) return "verified";
  if (releases.some((entry) => entry.coverage.status === "summary_only")) return "summary_only";
  return "pending";
}

function cardFor(record: SurveyRecord): SurveyCard {
  return {
    id: record.id,
    name: record.name,
    mission: record.mission,
    color: record.color,
    description: record.description,
    modalities: record.modalities,
    origin: record.origin,
    releaseCount: record.releases.length,
    availableReleaseCount: record.releases.filter((entry) => entry.availability === "available").length,
    verifiedFootprintReleaseCount: record.releases.filter((entry) => entry.coverage.status === "verified").length,
    coverageStatus: deriveCoverageStatus(record.releases),
  };
}

function validateRegistration(input: SurveyRegistrationInput): SurveyRegistrationInput {
  const raw = objectValue(input, "survey registration");
  rejectUnknownFields(raw, REGISTRATION_FIELDS, "survey registration");
  let releases: SurveyRelease[] | undefined;
  if (raw.releases !== undefined) {
    if (!Array.isArray(raw.releases) || raw.releases.length < 1 || raw.releases.length > 100) {
      throw new RangeError("releases must contain between 1 and 100 releases");
    }
    releases = raw.releases.map(normalizeRelease);
    if (new Set(releases.map((entry) => entry.id)).size !== releases.length) throw new RangeError("releases contains duplicate release ids");
  }
  const modalities = surveyModalities(raw.modalities);
  if (releases?.some((releaseEntry) => releaseEntry.modalities.some((modality) => !modalities.includes(modality)))) {
    throw new RangeError("release modalities must be declared by the survey");
  }
  return {
    ...(raw.id === undefined ? {} : { id: stableId(raw.id, "id") }),
    name: requiredText(raw.name, "name", 120),
    ...(optionalText(raw.mission, "mission", 120) ? { mission: optionalText(raw.mission, "mission", 120) } : {}),
    ...(surveyColor(raw.color) ? { color: surveyColor(raw.color) } : {}),
    sourceUrl: webUrl(raw.sourceUrl, "sourceUrl"),
    ...(optionalText(raw.description, "description", 500) ? { description: optionalText(raw.description, "description", 500) } : {}),
    modalities,
    ...(releases === undefined ? {} : { releases }),
  };
}

function normalizePersistedSurvey(value: unknown): SurveyRecord {
  const raw = objectValue(value, "survey registry record");
  rejectUnknownFields(raw, RECORD_FIELDS, "survey registry record");
  if (raw.origin !== "user") throw new Error("survey registry record origin must be user");
  if (!Array.isArray(raw.releases) || raw.releases.length < 1 || raw.releases.length > 100) {
    throw new Error("survey registry record must contain between 1 and 100 releases");
  }
  const releases = raw.releases.map(normalizeRelease);
  if (new Set(releases.map((entry) => entry.id)).size !== releases.length) throw new Error("survey registry record contains duplicate release ids");
  const modalities = surveyModalities(raw.modalities);
  if (releases.some((releaseEntry) => releaseEntry.modalities.some((modality) => !modalities.includes(modality)))) {
    throw new Error("survey registry record contains a release modality not declared by the survey");
  }
  return {
    id: stableId(raw.id, "id"),
    name: requiredText(raw.name, "name", 120),
    mission: requiredText(raw.mission, "mission", 120),
    color: surveyColor(raw.color, true)!,
    description: requiredText(raw.description, "description", 500),
    modalities,
    origin: "user",
    releases,
  };
}

export class SurveyRegistry {
  readonly #statePath: string;
  #registrations: SurveyRecord[] = [];
  #mutations: Promise<void> = Promise.resolve();

  constructor(statePath: string) {
    this.#statePath = statePath;
  }

  async initialize(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.#statePath, "utf8")) as unknown;
      if (!Array.isArray(parsed)) throw new Error("survey registry state must be an array");
      const registrations = parsed.map(normalizePersistedSurvey);
      const allIds = new Set(CURATED_SURVEYS.flatMap((entry) => [entry.id, ...entry.releases.map((releaseEntry) => releaseEntry.id)]));
      for (const record of registrations) {
        if (allIds.has(record.id)) throw new Error(`Survey id conflicts with an existing id: ${record.id}`);
        allIds.add(record.id);
        for (const releaseEntry of record.releases) {
          if (allIds.has(releaseEntry.id)) throw new Error(`Release id conflicts with an existing id: ${releaseEntry.id}`);
          allIds.add(releaseEntry.id);
        }
      }
      this.#registrations = registrations;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await mkdir(path.dirname(this.#statePath), { recursive: true });
        await this.#persist();
        return;
      }
      throw error;
    }
  }

  list(): SurveyCard[] {
    return [...CURATED_SURVEYS, ...this.#registrations].map(cardFor);
  }

  get(id: string): SurveyRecord {
    const record = [...CURATED_SURVEYS, ...this.#registrations].find((entry) => entry.id === id);
    if (!record) throw new Error(`Survey not found: ${id}`);
    return structuredClone(record);
  }

  async register(input: SurveyRegistrationInput): Promise<SurveyRecord> {
    return this.#mutate(async () => {
      const value = validateRegistration(input);
      const id = value.id ?? `user-${randomUUID()}`;
      this.#assertSurveyIdAvailable(id);
      const releases = value.releases ?? [release(`${id}-source`, "Registered source", {
        kind: "archive_snapshot",
        availability: "metadata_only",
        modalities: value.modalities,
        products: [{
          name: "Registered source",
          modality: value.modalities.includes("catalog") ? "catalog" : value.modalities[0]!,
          description: "Metadata registration only; source rows are not copied into this workspace.",
        }],
        coverage: { status: "pending", summary: "Metadata source is registered. Scan or attach a MOC/HEALPix footprint to enable spatial drill-down.", sourceUrl: value.sourceUrl },
      })];
      if (releases.some((releaseEntry) => releaseEntry.id === id)) throw new RangeError(`Release id conflicts with survey id: ${id}`);
      for (const releaseEntry of releases) this.#assertReleaseIdAvailable(releaseEntry.id);
      const record: SurveyRecord = {
        id,
        name: value.name,
        mission: value.mission ?? "User registered source",
        color: value.color ?? "#ffcc70",
        description: value.description ?? "User-registered data source. Register a coverage artifact before spatial drill-down.",
        modalities: value.modalities,
        origin: "user",
        releases,
      };
      const registrations = [...this.#registrations, record];
      await this.#persist(registrations);
      this.#registrations = registrations;
      return structuredClone(record);
    });
  }

  async addRelease(surveyId: string, input: SurveyReleaseRegistrationInput): Promise<SurveyRelease> {
    return this.#mutate(async () => {
      const id = stableId(surveyId, "surveyId");
      const currentIndex = this.#registrations.findIndex((entry) => entry.id === id);
      if (currentIndex < 0) {
        const existing = CURATED_SURVEYS.some((entry) => entry.id === id);
        if (existing) throw new RangeError("Releases can only be added to user surveys");
        throw new Error(`Survey not found: ${id}`);
      }
      const releaseEntry = normalizeRelease(input);
      if (releaseEntry.modalities.some((modality) => !this.#registrations[currentIndex]!.modalities.includes(modality))) {
        throw new RangeError("release modalities must be declared by the survey");
      }
      this.#assertReleaseIdAvailable(releaseEntry.id);
      const current = this.#registrations[currentIndex]!;
      const updated: SurveyRecord = { ...current, releases: [...current.releases, releaseEntry] };
      const registrations = this.#registrations.map((entry, index) => index === currentIndex ? updated : entry);
      await this.#persist(registrations);
      this.#registrations = registrations;
      return structuredClone(releaseEntry);
    });
  }

  #assertSurveyIdAvailable(id: string): void {
    if ([...CURATED_SURVEYS, ...this.#registrations].some((entry) => entry.id === id || entry.releases.some((releaseEntry) => releaseEntry.id === id))) {
      throw new RangeError(`Survey id already exists: ${id}`);
    }
  }

  #assertReleaseIdAvailable(id: string): void {
    if ([...CURATED_SURVEYS, ...this.#registrations].some((entry) => entry.id === id || entry.releases.some((releaseEntry) => releaseEntry.id === id))) {
      throw new RangeError(`Release id already exists: ${id}`);
    }
  }

  async #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutations.then(operation, operation);
    this.#mutations = result.then(() => undefined, () => undefined);
    return result;
  }

  async #persist(registrations = this.#registrations): Promise<void> {
    await mkdir(path.dirname(this.#statePath), { recursive: true });
    const temporaryPath = `${this.#statePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(registrations, null, 2), "utf8");
    await rename(temporaryPath, this.#statePath);
  }
}
