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

export interface SurveyRelease {
  id: string;
  label: string;
  phase?: string;
  kind: ReleaseKind;
  availability: ReleaseAvailability;
  releasedYear?: number;
  modalities: SurveyModality[];
  products: SurveyProduct[];
  coverage: {
    status: FootprintStatus;
    summary: string;
    areaDeg2?: number;
    sourceUrl: string;
  };
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
  name: string;
  mission?: string;
  sourceUrl: string;
  description?: string;
  modalities: SurveyModality[];
}

const MODALITIES: readonly SurveyModality[] = ["imaging", "spectroscopy", "photometry", "time-domain", "integral-field", "ultraviolet", "infrared", "catalog"];

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
        coverage: { status: "summary_only", summary: "Three deep fields, 63.1 deg2. Exact field polygons/MOC are pending ingestion.", areaDeg2: 63.1, sourceUrl: "https://www.esa.int/Science_Exploration/Space_Science/Euclid/Euclid_opens_data_treasure_trove_offers_glimpse_of_deep_fields" },
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
      release("galex-gr6-gr7", "GR6/GR7", { kind: "public_release", availability: "available", modalities: ["ultraviolet", "imaging", "spectroscopy", "time-domain", "catalog"], products: [{ name: "GALEX GR6/GR7", modality: "catalog", description: "45,195 tiles across AIS, MIS, DIS and related surveys." }], coverage: { status: "summary_only", summary: "Observed 77% of the sky at varying depth in at least one band. Exact union must be built from the 45,195 tile records.", sourceUrl: "https://galex.stsci.edu/GR6/" } }),
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
      release("hsc-pdr2", "PDR2", { kind: "public_release", availability: "available", releasedYear: 2019, modalities: ["imaging", "photometry", "catalog"], products: [{ name: "HSC-SSP PDR2", modality: "catalog", description: "Second public HSC-SSP imaging release." }], coverage: { status: "summary_only", summary: "More than 300 deg2; detailed release footprint/MOC is pending ingestion.", areaDeg2: 300, sourceUrl: "https://hsc-release.mtk.nao.ac.jp/doc/index.php/sample-page/pdr2/" } }),
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
  const raw = (input && typeof input === "object" ? input : {}) as Partial<SurveyRegistrationInput>;
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const sourceUrl = typeof raw.sourceUrl === "string" ? raw.sourceUrl.trim() : "";
  if (!name || name.length > 120) throw new RangeError("name must contain 1 to 120 characters");
  if (!sourceUrl || sourceUrl.length > 2048) throw new RangeError("sourceUrl must contain 1 to 2048 characters");
  let protocol: string;
  try {
    protocol = new URL(sourceUrl).protocol;
  } catch {
    throw new RangeError("sourceUrl must be a valid URL");
  }
  if (protocol !== "https:" && protocol !== "http:") throw new RangeError("sourceUrl must use http or https");
  if (!Array.isArray(raw.modalities) || raw.modalities.length < 1 || raw.modalities.some((value) => !MODALITIES.includes(value))) {
    throw new RangeError("modalities must contain one or more supported values");
  }
  const description = typeof raw.description === "string" ? raw.description.trim() : undefined;
  if (description && description.length > 500) throw new RangeError("description must contain at most 500 characters");
  const mission = typeof raw.mission === "string" ? raw.mission.trim().slice(0, 120) : undefined;
  return { name, mission: mission || undefined, sourceUrl, description: description || undefined, modalities: [...new Set(raw.modalities)] };
}

export class SurveyRegistry {
  readonly #statePath: string;
  #registrations: SurveyRecord[] = [];

  constructor(statePath: string) {
    this.#statePath = statePath;
  }

  async initialize(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.#statePath, "utf8")) as unknown;
      if (!Array.isArray(parsed)) throw new Error("survey registry state must be an array");
      this.#registrations = parsed.filter((entry): entry is SurveyRecord => Boolean(entry) && typeof entry === "object" && (entry as SurveyRecord).origin === "user");
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
    return record;
  }

  async register(input: SurveyRegistrationInput): Promise<SurveyRecord> {
    const value = validateRegistration(input);
    const id = `user-${randomUUID()}`;
    const record: SurveyRecord = {
      id,
      name: value.name,
      mission: value.mission ?? "User registered source",
      color: "#ffcc70",
      description: value.description ?? "User-registered data source. Register a coverage artifact before spatial drill-down.",
      modalities: value.modalities,
      origin: "user",
      releases: [release(`${id}-source`, "Registered source", {
        kind: "archive_snapshot",
        availability: "metadata_only",
        modalities: value.modalities,
        products: [{ name: "Registered source", modality: "catalog", description: "Metadata registration only; source rows are not copied into this workspace." }],
        coverage: { status: "pending", summary: "Metadata source is registered. Scan or attach a MOC/HEALPix footprint to enable spatial drill-down.", sourceUrl: value.sourceUrl },
      })],
    };
    this.#registrations.push(record);
    await this.#persist();
    return record;
  }

  async #persist(): Promise<void> {
    await mkdir(path.dirname(this.#statePath), { recursive: true });
    const temporaryPath = `${this.#statePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(this.#registrations, null, 2), "utf8");
    await rename(temporaryPath, this.#statePath);
  }
}
