/**
 * Build provenance for capability reporting.
 *
 * `ASTRO_BUILD_COMMIT` is baked at image/installer build time (Dockerfile,
 * release CI, desktop bundler, Helm). When present it must be a full 40-hex
 * git commit so that runtime capability descriptors can link to immutable
 * source permalinks.
 */

const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

export const REPOSITORY_SOURCE_URL = "https://github.com/Astro-Survey-Atlas/Workspace";

export function normalizeBuildCommit(value: string | undefined): string | null {
  const trimmed = value?.trim().toLowerCase();
  return trimmed && COMMIT_PATTERN.test(trimmed) ? trimmed : null;
}

export const BUILD_COMMIT: string | null = normalizeBuildCommit(process.env.ASTRO_BUILD_COMMIT);

/**
 * Immutable permalink to the source that produced this build. Returns null for
 * local development builds without a pinned commit instead of guessing.
 */
export function sourcePermalink(relativePath: string, line?: number): string | null {
  if (!BUILD_COMMIT) return null;
  const clean = relativePath.replace(/^[./]+/, "");
  return `${REPOSITORY_SOURCE_URL}/blob/${BUILD_COMMIT}/${clean}${line ? `#L${line}` : ""}`;
}

export interface BuildProvenance {
  commit: string | null;
  sourceUrl: string;
  permalinkBase: string | null;
}

export function buildProvenance(): BuildProvenance {
  return {
    commit: BUILD_COMMIT,
    sourceUrl: REPOSITORY_SOURCE_URL,
    permalinkBase: BUILD_COMMIT ? `${REPOSITORY_SOURCE_URL}/blob/${BUILD_COMMIT}` : null,
  };
}
