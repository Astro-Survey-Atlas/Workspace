import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import { JsonDatasetRegistry } from "./registry.js";

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

export function createAstroMcpServer(registry: JsonDatasetRegistry): McpServer {
  const server = new McpServer({ name: "astro-data-workspace", version: "0.6.0" });

  server.registerTool(
    "register_local_csv",
    {
      title: "Register local astronomy CSV",
      description: "Register and deterministically profile a CSV catalog under an allowed data root.",
      inputSchema: {
        path: z.string().min(1).describe("Absolute path visible to the MCP service"),
        name: z.string().min(1).optional().describe("Human-readable dataset name"),
      },
    },
    async ({ path, name }) => {
      try {
        return asToolResult(await registry.registerLocalCsv(path, name));
      } catch (error) {
        return asToolError(error);
      }
    },
  );

  server.registerTool(
    "list_datasets",
    {
      title: "List registered datasets",
      description: "List all datasets and their generated profiles.",
    },
    async () => asToolResult({ datasets: await registry.list() }),
  );

  server.registerTool(
    "get_dataset_profile",
    {
      title: "Get dataset profile",
      description: "Get a registered dataset and its deterministic profile by ID.",
      inputSchema: { id: z.string().min(1) },
    },
    async ({ id }) => {
      try {
        return asToolResult(await registry.get(id));
      } catch (error) {
        return asToolError(error);
      }
    },
  );

  return server;
}
