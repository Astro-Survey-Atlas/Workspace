import type { AssetsRegionLookupResponse } from "../../src/assets-region-client.js";
import type { WorkspaceDirectory } from "../../src/workspace-directories.js";

export function mergePublicPages(current: AssetsRegionLookupResponse, next: AssetsRegionLookupResponse): AssetsRegionLookupResponse {
  if (current.querySnapshot?.id !== next.querySnapshot?.id) throw new Error("Assets query snapshot changed");
  const merge = <T>(left: readonly T[], right: readonly T[], key: (item: T) => string): T[] => [...new Map([...left, ...right].map((item) => [key(item), item])).values()];
  const spatialUnits = merge(current.spatialUnits ?? [], next.spatialUnits ?? [], (unit) => JSON.stringify([unit.layerId, unit.unitKind, unit.unitId]));
  const files = merge(current.files, next.files, (file) => file.fileId);
  const entrypoints = merge(current.entrypoints ?? [], next.entrypoints ?? [], (entry) => JSON.stringify([entry.layerId, entry.kind, entry.url, entry.sourceUri]));
  const coverageEvidence = merge(current.coverageEvidence ?? [], next.coverageEvidence ?? [], (evidence) => `${evidence.layerId}:${evidence.order}`);
  return { ...next, spatialUnits, files, entrypoints, coverageEvidence, notes: [...new Set([...current.notes, ...next.notes])],
    ...(next.downloadPlan ? { downloadPlan: { ...next.downloadPlan, spatialUnits, files, entrypoints, coverageEvidence } } : {}) };
}

export function workspaceManifestCsv(publicResult: AssetsRegionLookupResponse | undefined, directories: readonly WorkspaceDirectory[], directoriesTruncated: boolean,
  context?: { componentId?: string; order?: number; cells?: readonly number[]; unavailable?: unknown[]; warnings?: string[] }): string {
  const header = ["item_kind", "survey_id", "release_id", "product", "modality", "layer_id", "unit_kind", "unit_id", "order", "precision", "access_uri", "access_uris", "directory_uri", "matching_cells", "query_snapshot_id", "details"];
  const rows: unknown[][] = [];
  for (const unit of publicResult?.spatialUnits ?? []) rows.push(["spatial-unit", unit.surveyId, unit.releaseId, unit.product, unit.modality, unit.layerId, unit.unitKind, unit.unitId,
    unit.order, unit.precision, unit.accessUri, JSON.stringify(unit.accessUris ?? []), "", JSON.stringify(unit.matchingCells), publicResult?.querySnapshot?.id, JSON.stringify(unit)]);
  for (const directory of directories) rows.push(["workspace-directory", directory.surveyId, directory.releaseId, directory.product, directory.modality, directory.layerId, "directory", "",
    directory.order, directory.precision, "", "", directory.directoryUri, JSON.stringify(directory.matchingCells), "", JSON.stringify(directory)]);
  for (const [kind, items] of [["file", publicResult?.files], ["entrypoint", publicResult?.entrypoints], ["coverage-evidence", publicResult?.coverageEvidence]] as const) {
    for (const item of items ?? []) rows.push([kind, "", "", "", "", "", "", "", "", "", "", "", "", "", publicResult?.querySnapshot?.id, JSON.stringify(item)]);
  }
  rows.push(["manifest-state", "", "", "", "", "", "", "", "", "", "", "", "", "", publicResult?.querySnapshot?.id,
    JSON.stringify({ publicAvailable: Boolean(publicResult), querySnapshot: publicResult?.querySnapshot, page: publicResult?.page,
      truncated: publicResult?.truncated, warnings: publicResult?.downloadPlan?.warnings, notes: publicResult?.notes,
      scanScopes: publicResult?.scanScopes, directoriesTruncated, ...context })]);
  const cell = (value: unknown): string => {
    const text = value == null ? "" : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return [header, ...rows].map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n";
}
