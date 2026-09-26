import assert from "node:assert/strict";
import test from "node:test";

import type { AssetsRegionCoverageEvidence, AssetsRegionFileMatch, AssetsRegionScanScope } from "../src/assets-region-client.js";
import { summarizeCoverageEvidence, summarizeCoverageMatches, summarizeScanScopes } from "../viewer/src/reverse-lookup-summary.js";

test("coverage evidence summary keeps the public layer and displays evidence identities", () => {
  const match: AssetsRegionFileMatch = {
    layerId: "euclid-layer",
    evidenceLayerId: "assets-batch-euclid",
    observationLayerId: "candidate-tile-1",
    scopeId: "euclid-vis-q1",
    partitionId: "tile-1",
    order: 8,
    ipix: 549009,
    precision: "estimated",
  };

  assert.deepEqual(summarizeCoverageMatches([match]), [
    "euclid-layer O8 估算 · 证据层 assets-batch-euclid · 观测层 candidate-tile-1 · 范围 euclid-vis-q1 · 分区 tile-1",
  ]);
});

test("scan scope summary leads with the published layer and retains its evidence layer", () => {
  const scopes: AssetsRegionScanScope[] = [{
    layerId: "assets-batch-euclid",
    publishedLayerId: "euclid-layer",
    scopeId: "euclid-vis-q1",
    scopeSnapshotSha256: "a".repeat(64),
    expectedPartitions: 2,
    committedPartitions: 1,
    completeness: "incomplete",
  }, {
    layerId: "assets-batch-legacy",
    scopeId: "legacy-q1",
    scopeSnapshotSha256: "b".repeat(64),
    expectedPartitions: 1,
    committedPartitions: 1,
    completeness: "complete",
  }];

  assert.deepEqual(summarizeScanScopes(scopes), [
    "euclid-layer（证据层 assets-batch-euclid） · euclid-vis-q1 · 1/2 分区 · 冻结范围部分提交（不代表完整巡天覆盖）",
    "assets-batch-legacy · legacy-q1 · 1/1 分区 · 冻结范围已完整提交（不代表完整巡天覆盖）",
  ]);
});

test("coverage-only observation evidence remains readable without a retrieval URL", () => {
  const evidence: AssetsRegionCoverageEvidence = {
    layerId: "hst-acs",
    productId: "hst-acs-product",
    surveyId: "hst",
    releaseId: "mast-2026",
    product: "HST ACS observations",
    evidenceKind: "observation-footprint",
    order: 8,
    nside: 256,
    nativeMaxOrder: 10,
    availableOrders: [4, 8],
    matchedCells: [101],
    precision: "estimated",
    completeness: "incomplete",
    scienceFileScan: "not-scanned",
    sourceIdentity: "MAST observation 26442812",
    instrument: "ACS/WFC",
    filters: "F606W, F814W",
    sourceSnapshotSha256: "c".repeat(64),
    summary: "Estimated observation footprint; no science files were scanned.",
  };

  const [summary] = summarizeCoverageEvidence([evidence]);
  assert.match(summary!, /观测边界 · O8 估算/);
  assert.match(summary!, /MAST observation 26442812 · ACS\/WFC · F606W, F814W/);
  assert.match(summary!, /范围不完整 · 科学文件未扫描/);
  assert.match(summary!, new RegExp(`source snapshot SHA-256 ${"c".repeat(64)}`));
  assert.match(summary!, /no science files were scanned/);
  assert.doesNotMatch(summary!, /undefined/);
});
