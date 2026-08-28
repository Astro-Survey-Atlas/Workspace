/** Stable Assets Core identifiers shared with the scanner image. */
export const ASSETS_CORE_DISTRIBUTION = "astro-survey-atlas-assets";
export const ASSETS_CORE_IMPORT = "astro_survey_moc_core";
export const ASSETS_CORE_CLI = "astro-survey-moc-core";
export const ASSETS_CORE_CONTRACT_VERSION = "1.0.0";

/** Scientific enums shared by Atlas indexes and the scanner adapter. */
export const COVERAGE_ROLES = ["image_extent", "object_presence", "footprint_extent"] as const;
export type CoverageRole = typeof COVERAGE_ROLES[number];
export const DATA_ORIGINS = ["observed", "simulated", "catalog"] as const;
export type CoverageDataOrigin = typeof DATA_ORIGINS[number];
export const SOURCE_TIERS = ["official_geometry", "official_inventory_derived", "third_party_moc", "best_effort_derived", "user_file_derived"] as const;
export type CoverageSourceTier = typeof SOURCE_TIERS[number];

export interface AssetsCoreContext {
  distribution: typeof ASSETS_CORE_DISTRIBUTION;
  importName: typeof ASSETS_CORE_IMPORT;
  cli: typeof ASSETS_CORE_CLI;
  contractVersion: typeof ASSETS_CORE_CONTRACT_VERSION;
}

export function assetsCoreContext(): AssetsCoreContext {
  return {
    distribution: ASSETS_CORE_DISTRIBUTION,
    importName: ASSETS_CORE_IMPORT,
    cli: ASSETS_CORE_CLI,
    contractVersion: ASSETS_CORE_CONTRACT_VERSION,
  };
}
