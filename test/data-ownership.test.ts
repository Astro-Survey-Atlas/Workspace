import assert from "node:assert/strict";
import test from "node:test";

import { resolveDataOwnership } from "../src/data-ownership.js";
import type { ConnectorRecord } from "../src/connectors.js";
import type { DataAssetRecord } from "../src/data-catalog.js";

function connector(id: string, locationKey: string, surveyId?: string, releaseId?: string): ConnectorRecord {
  return {
    id,
    locationKey,
    displayPath: locationKey,
    name: id,
    description: "",
    kind: "s3",
    config: { bucket: "test" },
    surveyId,
    releaseId,
    status: "ready",
    createdAt: "",
    updatedAt: "",
    origin: "user",
  };
}

function asset(overrides: Partial<DataAssetRecord> = {}): DataAssetRecord {
  return {
    id: "asset",
    name: "Asset",
    description: "",
    product: "catalog",
    kind: "catalog",
    modalities: ["catalog"],
    access: { connector: "metadata", uri: "asset://asset", format: "metadata" },
    status: "metadata_only",
    projectState: "planned",
    footprintIds: [],
    origin: "user",
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

test("connector ownership overrides an asset's stale survey metadata", () => {
  const result = resolveDataOwnership(
    asset({ surveyId: "legacy-surveys", releaseId: "legacy-dr10", connectorIds: ["c1"] }),
    [connector("c1", "s3://euclid/q1", "euclid", "euclid-q1")],
  );
  assert.equal(result.source, "connector");
  assert.equal(result.surveyId, "euclid");
  assert.equal(result.releaseId, "euclid-q1");
});

test("multiple connectors with the same ownership are accepted", () => {
  const result = resolveDataOwnership(
    asset({ connectorIds: ["c1", "c2"] }),
    [connector("c1", "s3://a", "euclid", "euclid-q1"), connector("c2", "s3://b", "euclid", "euclid-q1")],
  );
  assert.equal(result.source, "connector");
  assert.deepEqual(result.connectorIds, ["c1", "c2"]);
});

test("conflicting connector ownership is explicit", () => {
  const result = resolveDataOwnership(
    asset({ connectorIds: ["c1", "c2"] }),
    [connector("c1", "s3://a", "euclid", "euclid-q1"), connector("c2", "s3://b", "desi", "desi-dr1")],
  );
  assert.equal(result.source, "conflict");
  assert.match(result.message ?? "", /归属不一致/);
});

test("connector-free assets retain their own ownership or remain unassigned", () => {
  assert.equal(resolveDataOwnership(asset({ surveyId: "euclid" }), []).source, "asset");
  assert.equal(resolveDataOwnership(asset(), []).source, "unassigned");
});
