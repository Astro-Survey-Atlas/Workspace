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
const client = new Client({ name: "astro-data-workspace-smoke", version: "0.1.0" });
const transport = new StreamableHTTPClientTransport(endpoint);

try {
  await client.connect(transport);
  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map(({ name }) => name).sort(),
    ["get_user_asset", "list_user_assets"],
  );

  const listResult = await client.callTool({ name: "list_user_assets", arguments: {} });
  const listing = textPayload(listResult) as { assets: Array<{ id: string }> };
  const assetId = process.env.MCP_ASSET_ID;
  if (assetId) {
    const getResult = await client.callTool({ name: "get_user_asset", arguments: { id: assetId } });
    assert.equal(getResult.isError, undefined);
    const fetched = textPayload(getResult) as { asset: { id: string } };
    assert.equal(fetched.asset.id, assetId);
  }

  console.log(
    JSON.stringify({
      endpoint: endpoint.href,
      tools: tools.tools.map(({ name }) => name).sort(),
      userAssetCount: listing.assets.length,
      ...(assetId ? { assetId } : {}),
    }),
  );
} finally {
  await client.close();
}
