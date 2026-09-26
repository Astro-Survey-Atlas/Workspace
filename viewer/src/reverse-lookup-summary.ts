import type { AssetsRegionCoverageEvidence, AssetsRegionFileMatch, AssetsRegionScanScope } from "../../src/assets-region-client.js";

const precisionLabels = {
  exact: "精确",
  estimated: "估算",
  "entrypoint-only": "仅来源入口",
  truncated: "截断",
} as const;

export function summarizeCoverageMatches(matches: readonly AssetsRegionFileMatch[]): string[] {
  return [...new Set(matches.map((match) => {
    const identities = [
      match.evidenceLayerId ? `证据层 ${match.evidenceLayerId}` : undefined,
      match.observationLayerId ? `观测层 ${match.observationLayerId}` : undefined,
      match.scopeId ? `范围 ${match.scopeId}` : undefined,
      match.partitionId ? `分区 ${match.partitionId}` : undefined,
    ].filter((value): value is string => Boolean(value));
    return `${match.layerId ?? "公开来源"} O${match.order} ${precisionLabels[match.precision]}${identities.length ? ` · ${identities.join(" · ")}` : ""}`;
  }))];
}

export function summarizeScanScopes(scopes: readonly AssetsRegionScanScope[] | undefined): string[] {
  return (scopes ?? []).map((scope) => {
    const displayLayerId = scope.publishedLayerId ?? scope.layerId;
    const layerLabel = displayLayerId !== scope.layerId
      ? `${displayLayerId}（证据层 ${scope.layerId}）`
      : displayLayerId;
    return `${layerLabel} · ${scope.scopeId} · ${scope.committedPartitions}/${scope.expectedPartitions} 分区 · ${scope.completeness === "complete" ? "冻结范围已完整提交" : "冻结范围部分提交"}（不代表完整巡天覆盖）`;
  });
}

export function summarizeCoverageEvidence(evidence: readonly AssetsRegionCoverageEvidence[] | undefined): string[] {
  const evidenceKindLabels = {
    "observation-footprint": "观测边界",
    "published-moc": "已发布 MOC",
    "tile-footprint": "Tile 边界",
    "wcs-coverage": "WCS 覆盖",
  } as const;
  const completenessLabels = { complete: "范围内完整", incomplete: "范围不完整", unknown: "完整性未知" } as const;
  const scanLabels = { "not-scanned": "科学文件未扫描", partial: "科学文件仅部分扫描", complete: "范围内文件扫描完成" } as const;
  return (evidence ?? []).map((item) => {
    const identity = [item.sourceIdentity, item.instrument, item.filters].filter(Boolean).join(" · ");
    const provenance = [
      item.sourceLabel,
      item.sourceUrl ? `来源 ${item.sourceUrl}` : undefined,
      item.geometrySourceUrl ? `几何来源 ${item.geometrySourceUrl}` : undefined,
    ].filter((value): value is string => Boolean(value)).join(" · ");
    return [
      `${item.product} · ${evidenceKindLabels[item.evidenceKind]} · O${item.order} ${precisionLabels[item.precision]}`,
      identity,
      item.completeness ? completenessLabels[item.completeness] : undefined,
      item.scienceFileScan ? scanLabels[item.scienceFileScan] : undefined,
      item.sourceSnapshotSha256 ? `source snapshot SHA-256 ${item.sourceSnapshotSha256}` : undefined,
      provenance,
      item.summary,
    ].filter((value): value is string => Boolean(value)).join(" · ");
  });
}
