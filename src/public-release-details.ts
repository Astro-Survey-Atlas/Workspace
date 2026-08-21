import type { SurveyRecord } from "./survey-registry.js";
import type { SurveyFootprintManifest } from "./survey-footprints.js";

export type PublicCoverageStatus = "acquired" | "overview_only" | "awaiting_geometry";

export interface PublicReleaseProductDetail {
  name: string;
  modality: string;
  description: string;
  coverageStatus: PublicCoverageStatus;
  sourceUrl: string;
  artifactKey?: string;
}

export interface PublicReleaseDetail {
  surveyId: string;
  releaseId: string;
  label: string;
  mission: string;
  description: string;
  releasedYear?: number;
  kind: string;
  modalities: string[];
  officialSourceUrl: string;
  products: PublicReleaseProductDetail[];
}

export function buildPublicReleaseDetails(
  surveys: readonly SurveyRecord[],
  manifest: SurveyFootprintManifest,
): PublicReleaseDetail[] {
  const footprints = new Map(manifest.footprints.map((item) => [`${item.surveyId}:${item.releaseId}:${item.product}`, item]));
  return surveys.flatMap((survey) => survey.releases.filter((release) => release.availability === "available").map((release) => {
    const products = release.products.map((product) => ({
      name: product.name,
      modality: product.modality,
      description: product.description,
    }));
    return {
      surveyId: survey.id,
      releaseId: release.id,
      label: release.label,
      mission: survey.mission,
      description: release.coverage.summary,
      releasedYear: release.releasedYear,
      kind: release.kind,
      modalities: release.modalities,
      officialSourceUrl: release.coverage.sourceUrl,
      products: products.map((product) => {
        const key = `${survey.id}:${release.id}:${product.name}`;
        const footprint = footprints.get(key);
        return {
          ...product,
          coverageStatus: footprint?.quality === "moc"
            ? "acquired"
            : footprint?.quality === "official_overview"
              ? "overview_only"
              : "awaiting_geometry",
          sourceUrl: release.coverage.sourceUrl,
          ...(footprint ? { artifactKey: key } : {}),
        };
      }),
    };
  }));
}
