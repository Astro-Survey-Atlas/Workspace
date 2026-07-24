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
const fixturePath = process.env.MCP_FIXTURE_PATH ?? "/app/fixtures/catalog.csv";
const client = new Client({ name: "astro-data-workspace-smoke", version: "0.1.0" });
const transport = new StreamableHTTPClientTransport(endpoint);

try {
  await client.connect(transport);
  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map(({ name }) => name).sort(),
    ["get_dataset_profile", "list_datasets", "register_local_csv"],
  );

  const registerResult = await client.callTool({
    name: "register_local_csv",
    arguments: { path: fixturePath, name: "MCP smoke catalog" },
  });
  assert.equal(registerResult.isError, undefined);
  const dataset = textPayload(registerResult) as {
    id: string;
    profile: { rowCount: number; skyCoverage: { rightAscension: { wraps: boolean } } };
  };
  assert.equal(dataset.profile.rowCount, 3);
  assert.equal(dataset.profile.skyCoverage.rightAscension.wraps, true);

  const listResult = await client.callTool({ name: "list_datasets", arguments: {} });
  const listing = textPayload(listResult) as { datasets: Array<{ id: string }> };
  assert.ok(listing.datasets.some(({ id }) => id === dataset.id));

  const getResult = await client.callTool({
    name: "get_dataset_profile",
    arguments: { id: dataset.id },
  });
  const fetched = textPayload(getResult) as { id: string };
  assert.equal(fetched.id, dataset.id);

  console.log(
    JSON.stringify({
      endpoint: endpoint.href,
      tools: tools.tools.map(({ name }) => name).sort(),
      datasetId: dataset.id,
      rowCount: dataset.profile.rowCount,
      raWraps: dataset.profile.skyCoverage.rightAscension.wraps,
    }),
  );
} finally {
  await client.close();
}
