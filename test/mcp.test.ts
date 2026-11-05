import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { DataCatalogRegistry } from "../src/data-catalog.js";
import { createAstroMcpServer } from "../src/mcp.js";

test("catalog MCP tools route registered asset options through the shared workflow query", async (t) => {
  const calls: Array<{ side: string; input: Record<string, unknown> }> = [];
  const server = createAstroMcpServer({} as DataCatalogRegistry, {
    queryCatalog: async (side, input) => {
      calls.push({ side, input: input as unknown as Record<string, unknown> });
      return { catalog: side, hits: [{ OBJECT_ID: `${side}-1` }] };
    },
    executeCutoutGroup: async () => ({ results: [] }),
  });
  const client = new Client({ name: "mcp-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const result = await client.callTool({
    name: "euclid_catalog_query",
    arguments: {
      raDeg: 58.375,
      decDeg: -51.25,
      queryRadiusArcsec: 250,
      limit: 500,
      assetId: "euclid-asset",
      format: "fits",
      tableHdu: 1,
      columns: { ra: "RA_J2000", dec: "DEC_J2000", id: "OBJECT_KEY" },
      catalogFields: { redshift: "ZPHOT" },
    },
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{
    side: "euclid",
    input: {
      raDeg: 58.375,
      decDeg: -51.25,
      queryRadiusArcsec: 250,
      limit: 500,
      catalogSources: {
        euclid: {
          assetId: "euclid-asset",
          format: "fits",
          tableHdu: 1,
          columns: { ra: "RA_J2000", dec: "DEC_J2000", id: "OBJECT_KEY" },
        },
      },
      catalogFields: { euclid: { redshift: "ZPHOT" } },
    },
  }]);
});

test("catalog MCP source format options require a Workspace asset", async (t) => {
  const server = createAstroMcpServer({} as DataCatalogRegistry, {
    queryCatalog: async () => ({ hits: [] }),
    executeCutoutGroup: async () => ({ results: [] }),
  });
  const client = new Client({ name: "mcp-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const result = await client.callTool({
    name: "desi_catalog_query",
    arguments: { raDeg: 58.375, decDeg: -51.25, format: "fits" },
  });

  assert.equal(result.isError, true);
  const firstContent = Array.isArray(result.content)
    ? result.content[0] as { text?: string } | undefined
    : undefined;
  assert.match(firstContent?.text ?? "", /require assetId/);
});
