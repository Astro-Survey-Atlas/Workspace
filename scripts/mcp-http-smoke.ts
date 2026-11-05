import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

function textPayload(result: unknown): unknown {
  const blocks = (result as { content?: unknown }).content as
    | Array<{ type: string; text?: string }>
    | undefined;
  const text = blocks?.find((block) => block.type === "text")?.text;
  if (!text) throw new Error("MCP tool returned no text payload");
  return JSON.parse(text) as unknown;
}

const endpoint = new URL(process.env.MCP_URL ?? "http://127.0.0.1:3000/mcp");
const client = new Client({ name: "asa-workspace-smoke", version: "0.1.0" });
const transport = new StreamableHTTPClientTransport(endpoint);

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const availableTools = new Set(tools.tools.map(({ name }) => name));
  const requiredTools = [
    "get_user_asset",
    "list_user_assets",
    "euclid_catalog_query",
    "desi_catalog_query",
    "execute_cutout_group",
  ];
  const missingTools = requiredTools.filter((name) => !availableTools.has(name));
  assert.deepEqual(missingTools, [], `MCP server is missing required tools: ${missingTools.join(", ")}`);

  const listResult = await client.callTool({ name: "list_user_assets", arguments: {} });
  assert.equal(listResult.isError, undefined);
  const listing = textPayload(listResult) as { assets: Array<{ id: string }> };
  const assetId = process.env.MCP_ASSET_ID;
  if (assetId) {
    const getResult = await client.callTool({ name: "get_user_asset", arguments: { id: assetId } });
    assert.equal(getResult.isError, undefined);
    const fetched = textPayload(getResult) as { asset: { id: string } };
    assert.equal(fetched.asset.id, assetId);
  }

  const catalogQueries: Record<string, number> = {};
  const raDeg = Number(process.env.MCP_QUERY_RA_DEG ?? "58.375");
  const decDeg = Number(process.env.MCP_QUERY_DEC_DEG ?? "-51.25");
  const queryRadiusArcsec = Number(process.env.MCP_QUERY_RADIUS_ARCSEC ?? "250");
  const limit = Number(process.env.MCP_QUERY_LIMIT ?? "500");
  for (const side of ["euclid", "desi"] as const) {
    const catalogAssetId = process.env[`MCP_${side.toUpperCase()}_ASSET_ID`];
    if (!catalogAssetId) continue;
    const queryResult = await client.callTool({
      name: `${side}_catalog_query`,
      arguments: { raDeg, decDeg, queryRadiusArcsec, limit, assetId: catalogAssetId },
    });
    assert.equal(queryResult.isError, undefined, `${side} catalog query failed: ${JSON.stringify(queryResult)}`);
    const payload = textPayload(queryResult) as { hits?: unknown[] };
    assert.ok(Array.isArray(payload.hits), `${side} catalog query did not return hits`);
    assert.ok(payload.hits.length > 0, `${side} catalog query returned no hits`);
    catalogQueries[side] = payload.hits.length;
  }

  console.log(
    JSON.stringify({
      endpoint: endpoint.href,
      tools: tools.tools.map(({ name }) => name).sort(),
      userAssetCount: listing.assets.length,
      ...(assetId ? { assetId } : {}),
      ...(Object.keys(catalogQueries).length ? { catalogQueries } : {}),
    }),
  );
} finally {
  await client.close();
}
