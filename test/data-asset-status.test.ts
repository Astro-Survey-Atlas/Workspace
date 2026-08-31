import assert from "node:assert/strict";
import test from "node:test";

import { deriveDataAssetOperationalStatus, type DataAssetStatusInput } from "../src/data-asset-status.js";

const baseAsset = {
  id: "asset-cosmos",
  access: { connector: "metadata" as const, uri: "metadata://cosmos", format: "csv" },
  accesses: [],
  connectorIds: [],
  connectorLocationKeys: [],
};

function status(overrides: Partial<DataAssetStatusInput> = {}) {
  return deriveDataAssetOperationalStatus({
    asset: baseAsset,
    objectIndexConfigured: true,
    localScanConfigured: true,
    warehouseConfigured: true,
    ...overrides,
  });
}

test("unlinked assets ask the user to configure a Connector", () => {
  assert.deepEqual(status({ coverage: { status: "ready", pixels: [] } }), {
    assetId: "asset-cosmos",
    coverage: "not_started",
    objects: "not_indexed",
    nextAction: "configure_connector",
  });
});

test("a local Connector with a scan spec can start a local scan", () => {
  assert.equal(status({
    asset: { ...baseAsset, access: { connector: "local", uri: "/data/cosmos.csv", format: "csv" } },
    connectorKinds: ["local"],
  }).nextAction, "scan_local");
});

test("a remote Connector uses the Warehouse scan action", () => {
  assert.equal(status({
    asset: { ...baseAsset, access: { connector: "s3", uri: "s3://bucket/cosmos", format: "csv" } },
    connectorKinds: ["s3"],
  }).nextAction, "scan_remote");
});

test("failed runs expose retry and preserve the failure message", () => {
  assert.deepEqual(status({
    coverage: { status: "ready", pixels: [] },
    latestRun: { status: "failed", error: "scanner stopped" },
  }), {
    assetId: "asset-cosmos",
    coverage: "failed",
    objects: "not_indexed",
    nextAction: "retry",
    message: "scanner stopped",
  });
});

test("a successful empty scan is terminal but still queryable", () => {
  assert.deepEqual(status({
    coverage: { status: "ready", objectStatus: "ready", pixels: [] },
    latestRun: { status: "succeeded" },
  }), {
    assetId: "asset-cosmos",
    coverage: "empty",
    objects: "queryable",
    nextAction: "none",
  });
});

test("an empty reachable index is not evidence that an asset was indexed", () => {
  assert.deepEqual(status({
    coverage: { status: "ready", objectStatus: "ready", objectCount: 0, pixels: [] },
  }), {
    assetId: "asset-cosmos",
    coverage: "not_started",
    objects: "not_indexed",
    nextAction: "configure_connector",
  });
});

test("stale connector references do not block the next-step action", () => {
  assert.equal(status({
    asset: { ...baseAsset, connectorIds: ["connector-removed"], connectorLocationKeys: ["s3://old/catalog"] },
  }).nextAction, "configure_connector");
});

test("an unavailable object index remains unavailable even when a Connector exists", () => {
  assert.deepEqual(status({
    asset: { ...baseAsset, access: { connector: "local", uri: "/data/cosmos.csv", format: "csv" } },
    connectorKinds: ["local"],
    coverage: { status: "unavailable", pixels: [], message: "ASTRO_ES_URL is not configured" },
    objectIndexConfigured: false,
  }), {
    assetId: "asset-cosmos",
    coverage: "unavailable",
    objects: "unavailable",
    nextAction: "configure_index",
    message: "ASTRO_ES_URL is not configured",
  });
});
