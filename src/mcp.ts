import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import type { DataCatalogRegistry } from "./data-catalog.js";
import type { WorkflowCatalogColumn, WorkflowCatalogFormat } from "./scientific-tools.js";
import type { WorkspaceCutoutGroupInput } from "./workflow-fits-cutout.js";

export interface AstroMcpCatalogQueryInput {
  raDeg: number;
  decDeg: number;
  queryRadiusArcsec?: number;
  limit?: number;
  catalogSources?: Partial<Record<"euclid" | "desi", {
    assetId: string;
    format?: WorkflowCatalogFormat;
    accessIndex?: number;
    tableHdu?: number | string;
    columns?: Partial<Record<WorkflowCatalogColumn, string>>;
  }>>;
  catalogFields?: Partial<Record<"euclid" | "desi", Record<string, string>>>;
}

interface AstroMcpCatalogToolInput extends Omit<AstroMcpCatalogQueryInput, "catalogSources" | "catalogFields"> {
  assetId?: string;
  format?: WorkflowCatalogFormat;
  accessIndex?: number;
  tableHdu?: number | string;
  columns?: Partial<Record<WorkflowCatalogColumn, string>>;
  catalogFields?: Record<string, string>;
}

export interface AstroMcpScientificTools {
  queryCatalog(side: "euclid" | "desi", input: AstroMcpCatalogQueryInput): Promise<unknown>;
  executeCutoutGroup(input: WorkspaceCutoutGroupInput): Promise<unknown>;
}

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

/** MCP surface for Workspace assets and its configured scientific capabilities. */
export function createAstroMcpServer(dataCatalog: DataCatalogRegistry, scientific?: AstroMcpScientificTools): McpServer {
  const server = new McpServer({ name: "asa-workspace", version: "0.0.1" });

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

  if (scientific) {
    const catalogColumnSchema = {
      ra: z.string().min(1).max(128).optional(),
      dec: z.string().min(1).max(128).optional(),
      id: z.string().min(1).max(128).optional(),
      magnitude: z.string().min(1).max(128).optional(),
      classLabel: z.string().min(1).max(128).optional(),
      tileIndex: z.string().min(1).max(128).optional(),
      brickname: z.string().min(1).max(128).optional(),
      fitsPath: z.string().min(1).max(128).optional(),
      imageG: z.string().min(1).max(128).optional(),
      imageR: z.string().min(1).max(128).optional(),
      imageI: z.string().min(1).max(128).optional(),
      imageZ: z.string().min(1).max(128).optional(),
    };
    const querySchema = {
      raDeg: z.number().min(0).refine((value) => value < 360, "raDeg must be less than 360"),
      decDeg: z.number().min(-90).max(90),
      queryRadiusArcsec: z.number().min(1).max(3600).optional(),
      limit: z.number().int().min(1).max(1000).optional(),
      assetId: z.string().min(1).max(120).optional(),
      format: z.enum(["csv", "fits"]).optional(),
      accessIndex: z.number().int().min(0).max(31).optional(),
      tableHdu: z.union([z.number().int().min(0).max(2048), z.string().min(1).max(80)]).optional(),
      columns: z.object(catalogColumnSchema).strict().optional(),
      catalogFields: z.record(z.string(), z.string().min(1).max(128)).optional(),
    };
    const queryCatalog = (side: "euclid" | "desi", input: AstroMcpCatalogToolInput): Promise<unknown> => {
      const { assetId, format, accessIndex, tableHdu, columns, catalogFields, ...query } = input;
      if (!assetId && (format !== undefined || accessIndex !== undefined || tableHdu !== undefined || columns !== undefined)) {
        throw new RangeError("Catalog format, HDU, access index, and column mapping require assetId");
      }
      return scientific.queryCatalog(side, {
        ...query,
        ...(assetId ? {
          catalogSources: {
            [side]: {
              assetId,
              ...(format ? { format } : {}),
              ...(accessIndex === undefined ? {} : { accessIndex }),
              ...(tableHdu === undefined ? {} : { tableHdu }),
              ...(columns ? { columns } : {}),
            },
          },
        } : {}),
        ...(catalogFields ? { catalogFields: { [side]: catalogFields } } : {}),
      });
    };
    server.registerTool(
      "euclid_catalog_query",
      {
        title: "Query Euclid catalog",
        description: "Query Euclid through the configured catalog MCP, or query a Workspace-registered CSV/FITS asset by supplying assetId. Asset queries support explicit columns and up to 16 additional catalogFields.",
        inputSchema: querySchema,
        annotations: { readOnlyHint: true },
      },
      async (input) => {
        try { return asToolResult(await queryCatalog("euclid", input)); }
        catch (error) { return asToolError(error); }
      },
    );
    server.registerTool(
      "desi_catalog_query",
      {
        title: "Query DESI catalog",
        description: "Query DESI through the configured catalog MCP, or query a Workspace-registered CSV/FITS asset by supplying assetId. Asset queries support explicit columns and up to 16 additional catalogFields.",
        inputSchema: querySchema,
        annotations: { readOnlyHint: true },
      },
      async (input) => {
        try { return asToolResult(await queryCatalog("desi", input)); }
        catch (error) { return asToolError(error); }
      },
    );
    server.registerTool(
      "execute_cutout_group",
      {
        title: "Create FITS cutouts",
        description: "Create cutouts from a registered local FITS source or delegate to the configured FITS cutout MCP. Successful cutouts are stored as Workspace workflow artifacts.",
        inputSchema: {
          run_id: z.string().min(1).max(120),
          telescope: z.enum(["euclid", "desi"]),
          band: z.enum(["vis", "g", "r", "i", "z"]),
          source_uri: z.string().min(1).max(2048),
          targets: z.array(z.object({
            obj_id: z.string().min(1).max(256),
            row_index: z.number().int().min(0),
            ra_deg: z.number().min(0).refine((value) => value < 360, "ra_deg must be less than 360"),
            dec_deg: z.number().min(-90).max(90),
            tile_index: z.string().max(256).optional(),
            brickname: z.string().max(256).optional(),
          })).min(1).max(100),
          size_deg: z.number().min(0.001).max(1),
          resolve_wildcard: z.boolean().optional(),
        },
        annotations: { readOnlyHint: false, destructiveHint: false },
      },
      async (input) => {
        try { return asToolResult(await scientific.executeCutoutGroup(input)); }
        catch (error) { return asToolError(error); }
      },
    );
  }

  return server;
}
