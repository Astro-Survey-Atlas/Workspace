import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import type { DataCatalogRegistry } from "./data-catalog.js";

function asToolResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
  };
}

function asToolError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
    isError: true as const,
  };
}

/** Read-only MCP surface for Atlas-owned user assets. */
export function createAstroMcpServer(dataCatalog: DataCatalogRegistry): McpServer {
  const server = new McpServer({ name: "astro-data-workspace", version: "0.10.38" });

  server.registerTool(
    "list_user_assets",
    {
      title: "List Atlas user assets",
      description: "List user assets registered in Atlas. Public Assets packages are not included.",
    },
    async () => asToolResult({ assets: await dataCatalog.list() }),
  );

  server.registerTool(
    "get_user_asset",
    {
      title: "Get an Atlas user asset",
      description: "Read one Atlas-owned user asset by ID.",
      inputSchema: { id: z.string().min(1) },
    },
    async ({ id }) => {
      try {
        return asToolResult({ asset: await dataCatalog.get(id) });
      } catch (error) {
        return asToolError(error);
      }
    },
  );

  return server;
}
