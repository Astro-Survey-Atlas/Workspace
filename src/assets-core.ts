/** Stable Assets Core identifiers shared with the scanner image. */
export const ASSETS_CORE_DISTRIBUTION = "astro-survey-atlas-assets";
export const ASSETS_CORE_IMPORT = "astro_survey_moc_core";
export const ASSETS_CORE_CLI = "astro-survey-assets";
export const ASSETS_CORE_CONTRACT_VERSION = "3.0.0";

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
