import type { SurveyRecord } from "./survey-registry.js";
import type { SurveyFootprintManifest } from "./survey-footprints.js";

export type PublicCoverageStatus = "acquired" | "overview_only" | "awaiting_geometry" | "not_applicable";

export interface PublicReleaseProductDetail {
  name: string;
  modality: string;
  description: string;
  coverageStatus: PublicCoverageStatus;
  sourceUrl?: string;
  reason?: string;
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

export interface PublicReleaseProductStatus {
  surveyId: string;
  releaseId: string;
  product: string;
  status: "acquired" | "unavailable";
  sourceUrl: string;
  reason?: string;
}

export function buildPublicReleaseDetails(
  surveys: readonly SurveyRecord[],
  productStatuses: readonly PublicReleaseProductStatus[],
  manifest: SurveyFootprintManifest,
): PublicReleaseDetail[] {
  const statusByProduct = new Map(productStatuses.map((item) => [`${item.surveyId}:${item.releaseId}:${item.product}`, item]));
  const footprints = new Map(manifest.footprints.map((item) => [`${item.surveyId}:${item.releaseId}:${item.product}`, item]));
  return surveys.flatMap((survey) => survey.releases.filter((release) => release.availability === "available").map((release) => {
    const sourceProducts = productStatuses.filter((item) => item.surveyId === survey.id && item.releaseId === release.id);
    const products = [...release.products.map((product) => ({
      name: product.name,
      modality: product.modality,
      description: product.description,
    })), ...sourceProducts
      .filter((source) => !release.products.some((product) => product.name === source.product))
      .map((source) => ({ name: source.product, modality: "catalog", description: "公开资料中登记的产品。" }))];
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
        const source = statusByProduct.get(key);
        const footprint = footprints.get(key);
        return {
          ...product,
          coverageStatus: footprint?.quality === "moc" ? "acquired" : footprint ? "overview_only" : source?.status === "acquired" ? "overview_only" : "awaiting_geometry",
          sourceUrl: source?.sourceUrl ?? release.coverage.sourceUrl,
          reason: source?.reason,
          ...(footprint ? { artifactKey: key } : {}),
        };
      }),
    };
  }));
}
