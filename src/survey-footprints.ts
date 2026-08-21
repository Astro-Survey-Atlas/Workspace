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
  if (manifest.schemaVersion !== SURVEY_FOOTPRINT_SCHEMA_VERSION || manifest.coordinateFrame !== "ICRS" || !Number.isInteger(manifest.nside) || manifest.nside! <= 0 || (manifest.nside! & (manifest.nside! - 1)) !== 0 || !Number.isFinite(Date.parse(manifest.generatedAt ?? "")) || !Array.isArray(manifest.footprints)) {
    throw new Error("Survey footprint manifest has an unsupported schema");
  }
  const identities = new Set<string>();
  for (const footprint of manifest.footprints) {
    if (!footprint || !footprint.surveyId?.trim() || !footprint.releaseId?.trim() || !footprint.product?.trim() || !footprint.label?.trim() || !footprint.notes?.trim() || !Array.isArray(footprint.pixels) || footprint.nside !== manifest.nside || !["moc", "official_overview"].includes(footprint.quality) || !Number.isFinite(Date.parse(footprint.retrievedAt))) {
      throw new Error("Survey footprint manifest contains an invalid footprint");
    }
    try {
      const sourceUrl = new URL(footprint.sourceUrl);
      if (sourceUrl.protocol !== "https:" && sourceUrl.protocol !== "http:") throw new Error();
    } catch {
      throw new Error(`Survey footprint contains an invalid source URL: ${footprint.surveyId}`);
    }
    const identity = `${footprint.surveyId}:${footprint.releaseId}:${footprint.product}`;
    if (identities.has(identity)) throw new Error(`Survey footprint manifest contains a duplicate identity: ${identity}`);
    identities.add(identity);
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
