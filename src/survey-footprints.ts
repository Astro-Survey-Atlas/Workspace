import { readFile } from "node:fs/promises";
import path from "node:path";

export const SURVEY_FOOTPRINT_SCHEMA_VERSION = 1;

export type FootprintGeometryQuality = "moc" | "official_overview";

export interface SurveyFootprint {
  surveyId: string;
  /** A footprint belongs to exactly one registered data release. Survey coverage is its release union. */
  releaseId: string;
  product: string;
  label: string;
  nside: number;
  pixels: number[];
  quality: FootprintGeometryQuality;
  sourceUrl: string;
  sourceId?: string;
  retrievedAt: string;
  notes: string;
}

export interface SurveyFootprintManifest {
  schemaVersion: number;
  generatedAt: string;
  coordinateFrame: "ICRS";
  nside: number;
  footprints: SurveyFootprint[];
}

function assertManifest(value: unknown): asserts value is SurveyFootprintManifest {
  if (!value || typeof value !== "object") throw new Error("Survey footprint manifest must be an object");
  const manifest = value as Partial<SurveyFootprintManifest>;
  if (manifest.schemaVersion !== SURVEY_FOOTPRINT_SCHEMA_VERSION || manifest.coordinateFrame !== "ICRS" || !Number.isInteger(manifest.nside) || !Array.isArray(manifest.footprints)) {
    throw new Error("Survey footprint manifest has an unsupported schema");
  }
  for (const footprint of manifest.footprints) {
    if (!footprint || typeof footprint.surveyId !== "string" || typeof footprint.releaseId !== "string" || typeof footprint.product !== "string" || !Array.isArray(footprint.pixels) || footprint.nside !== manifest.nside) {
      throw new Error("Survey footprint manifest contains an invalid footprint");
    }
    if (footprint.pixels.some((pixel) => !Number.isInteger(pixel) || pixel < 0 || pixel >= 12 * manifest.nside! ** 2)) {
      throw new Error(`Survey footprint contains an invalid HEALPix cell: ${footprint.surveyId}`);
    }
  }
}

export function normalizeSurveyFootprintManifest(value: unknown): SurveyFootprintManifest {
  assertManifest(value);
  return {
    ...value,
    footprints: value.footprints.map((footprint) => ({
      ...footprint,
      pixels: [...new Set(footprint.pixels)].sort((left, right) => left - right),
    })),
  };
}

/** Read a compact, generated coverage catalog. It contains metadata only, never survey rows or images. */
export class SurveyFootprintCatalog {
  readonly #manifestPath: string;
  #manifest: SurveyFootprintManifest | null = null;

  constructor(root: string) {
    this.#manifestPath = path.join(root, "survey-footprints.json");
  }

  async list(): Promise<SurveyFootprintManifest> {
    if (this.#manifest) return this.#manifest;
    const parsed = JSON.parse(await readFile(this.#manifestPath, "utf8")) as unknown;
    this.#manifest = normalizeSurveyFootprintManifest(parsed);
    return this.#manifest;
  }
}
