import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MemoryConnectorCredentialStore } from "../src/connector-credentials.js";
import type { ConnectorRecord, ConnectorRegistry } from "../src/connectors.js";
import type { DataAssetRecord, DataCatalogRegistry } from "../src/data-catalog.js";
import { LocalConnectorRootsPolicy } from "../src/local-connector-roots.js";
import { WorkflowInputCatalogReader } from "../src/workflow-input-catalog.js";

test("reads only explicitly mapped additional columns from a local CSV catalog", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "asa-workflow-catalog-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, "sources.csv"), [
    "source_key,ra_deg,dec_deg,zphot,private_note",
    ",10,0,0.42,do-not-copy",
    "source-2,10.001,0,0.51,do-not-copy-either",
  ].join("\n"));

  const now = new Date().toISOString();
  const connector: ConnectorRecord = {
    id: "connector-catalog",
    locationKey: "local://catalogs",
    displayPath: "/catalogs",
    name: "catalogs",
    description: "",
    kind: "local",
    config: { rootPath: "/catalogs" },
    status: "ready",
    createdAt: now,
    updatedAt: now,
    origin: "user",
  };
  const asset: DataAssetRecord = {
    id: "asset-catalog",
    name: "custom catalog",
    description: "",
    sourceRelativePath: "sources.csv",
    product: "catalog",
    kind: "catalog",
    modalities: ["catalog"],
    access: { connector: "local", connectorId: connector.id, uri: "/catalogs/sources.csv", format: "csv" },
    connectorIds: [connector.id],
    scanSpec: {
      format: "csv",
      objectIdColumn: "source_key",
      raColumn: "ra_deg",
      decColumn: "dec_deg",
      coordinateFrame: "ICRS",
      coordinateUnits: "deg",
    },
    status: "ready",
    projectState: "processed",
    footprintIds: [],
    origin: "user",
    createdAt: now,
    updatedAt: now,
  };
  const reader = new WorkflowInputCatalogReader({
    assets: { get: async () => asset } as unknown as DataCatalogRegistry,
    connectors: { list: async () => [connector] } as unknown as ConnectorRegistry,
    credentials: new MemoryConnectorCredentialStore(),
    localRoots: new LocalConnectorRootsPolicy([{ containerPath: "/catalogs", hostPath: directory }]),
  });

  const result = await reader.load({ assetId: asset.id, side: "euclid" }, {
    raDeg: 10,
    decDeg: 0,
    radiusArcsec: 250,
    limit: 10,
  }, { redshift: "zphot" });

  assert.equal(result.rowsScanned, 2);
  assert.equal(result.hits.length, 2);
  assert.match(String(result.hits[0]?.OBJECT_ID), /^row_[0-9a-f]{12}_1$/);
  assert.deepEqual(result.hits[0]?.asa_catalog_fields, { redshift: "0.42" });
  assert.equal("private_note" in (result.hits[0] ?? {}), false);
});

test("streams an S3 catalog asset through its registered Connector and credentials", async (t) => {
  const csv = "object_id,ra,dec,quality\ne1,10,0,good\n";
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/csv", "content-length": Buffer.byteLength(csv) });
    response.end(csv);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const now = new Date().toISOString();
  const connectorId = "connector-catalog-s3";
  const credentialRef = "asa-workspace/astro-connector-catalog-s3";
  const connector: ConnectorRecord = {
    id: connectorId,
    locationKey: "s3://catalog-bucket",
    displayPath: "s3://catalog-bucket",
    name: "catalog bucket",
    description: "",
    kind: "s3",
    config: { bucket: "catalog-bucket", endpoint: `http://127.0.0.1:${address.port}`, region: "us-east-1" },
    credentialRef,
    status: "ready",
    createdAt: now,
    updatedAt: now,
    origin: "user",
  };
  const asset: DataAssetRecord = {
    id: "asset-s3-catalog",
    name: "remote custom catalog",
    description: "",
    product: "catalog",
    kind: "catalog",
    modalities: ["catalog"],
    access: { connector: "s3", connectorId, uri: "s3://catalog-bucket/tables/sources.csv", format: "csv" },
    connectorIds: [connectorId],
    status: "ready",
    projectState: "processed",
    footprintIds: [],
    origin: "user",
    createdAt: now,
    updatedAt: now,
  };
  const credentials = new MemoryConnectorCredentialStore();
  await credentials.put(credentialRef, { accessKeyId: "fixture-access", secretAccessKey: "fixture-secret", endpoint: `http://127.0.0.1:${address.port}` });
  const reader = new WorkflowInputCatalogReader({
    assets: { get: async () => asset } as unknown as DataCatalogRegistry,
    connectors: { list: async () => [connector] } as unknown as ConnectorRegistry,
    credentials,
    localRoots: new LocalConnectorRootsPolicy(),
  });

  const result = await reader.load({ assetId: asset.id, side: "desi" }, {
    raDeg: 10,
    decDeg: 0,
    radiusArcsec: 250,
    limit: 10,
  }, { quality: "quality" });
  assert.equal(result.format, "csv");
  assert.equal(result.sourceBytes, Buffer.byteLength(csv));
  assert.deepEqual(result.hits[0]?.asa_catalog_fields, { quality: "good" });
});

test("reads explicitly mapped additional columns from a FITS table HDU", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "asa-workflow-fits-catalog-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const fitsPath = path.join(directory, "sources.fits");
  execFileSync(process.env.PYTHON_EXECUTABLE ?? "python3", ["-c", [
    "import sys",
    "from astropy.table import Table",
    "Table({'RA_J2000': [10.0], 'DEC_J2000': [0.0], 'SOURCE_KEY': ['fits-1'], 'ZPHOT': [0.61]}).write(sys.argv[1], format='fits', overwrite=True)",
  ].join("\n"), fitsPath]);

  const now = new Date().toISOString();
  const connector: ConnectorRecord = {
    id: "connector-fits-catalog",
    locationKey: "local://fits-catalogs",
    displayPath: "/fits-catalogs",
    name: "fits catalogs",
    description: "",
    kind: "local",
    config: { rootPath: "/fits-catalogs" },
    status: "ready",
    createdAt: now,
    updatedAt: now,
    origin: "user",
  };
  const asset: DataAssetRecord = {
    id: "asset-fits-catalog",
    name: "custom FITS table",
    description: "",
    sourceRelativePath: "sources.fits",
    product: "catalog",
    kind: "catalog",
    modalities: ["catalog"],
    access: { connector: "local", connectorId: connector.id, uri: "/fits-catalogs/sources.fits", format: "fits" },
    connectorIds: [connector.id],
    status: "ready",
    projectState: "processed",
    footprintIds: [],
    origin: "user",
    createdAt: now,
    updatedAt: now,
  };
  const reader = new WorkflowInputCatalogReader({
    assets: { get: async () => asset } as unknown as DataCatalogRegistry,
    connectors: { list: async () => [connector] } as unknown as ConnectorRegistry,
    credentials: new MemoryConnectorCredentialStore(),
    localRoots: new LocalConnectorRootsPolicy([{ containerPath: "/fits-catalogs", hostPath: directory }]),
  });

  const result = await reader.load({
    assetId: asset.id,
    side: "euclid",
    format: "fits",
    tableHdu: 1,
    columns: { ra: "RA_J2000", dec: "DEC_J2000", id: "SOURCE_KEY" },
  }, { raDeg: 10, decDeg: 0, radiusArcsec: 250, limit: 10 }, { redshift: "ZPHOT" });

  assert.equal(result.rowsScanned, 1);
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0]?.OBJECT_ID, "fits-1");
  assert.deepEqual(result.hits[0]?.asa_catalog_fields, { redshift: 0.61 });
});
