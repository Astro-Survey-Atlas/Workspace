import type { McpServerRecord, McpToolSummary, SystemConfigStore } from "./system-config.js";

export type WorkflowMcpRole = "catalog" | "euclid" | "desi" | "cutout";

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function parseJsonText(value: string): unknown {
  try { return JSON.parse(value) as unknown; } catch { return value; }
}

export function unwrapWorkflowMcpResult(value: unknown): unknown {
  const result = record(value);
  if (!result) return value;
  const content = Array.isArray(result.content) ? result.content as Array<Record<string, unknown>> : [];
  const text = content.find((part) => part.type === "text" && typeof part.text === "string")?.text;
  if (result.isError === true) throw new Error(typeof text === "string" ? text : "MCP tool returned an error");

  const structured = record(result.structuredContent);
  if (structured) {
    if (typeof structured.result === "string") return parseJsonText(structured.result);
    return structured;
  }
  if (typeof text === "string") return parseJsonText(text);
  return value;
}

function roleScore(role: WorkflowMcpRole, server: McpServerRecord): number {
  const name = server.name.toLowerCase().replace(/[_-]+/g, " ");
  if (name.includes("workspace")) return 0;
  if (role === "euclid" && name.includes("euclid")) return 3;
  if (role === "desi" && name.includes("desi")) return 3;
  if (role === "cutout") return name.includes("cutout") || name.includes("fits") ? 2 : 0;
  if (name.includes("astro")) return 2;
  if (name.includes("catalog") || name.includes("desi") || name.includes("euclid")) return 1;
  return 0;
}

export class WorkflowMcpClient {
  constructor(private readonly config: Pick<SystemConfigStore, "listMcpServers" | "callMcpTool">) {}

  async hasTool(role: WorkflowMcpRole, toolName: string): Promise<boolean> {
    return Boolean(await this.resolve(role, toolName));
  }

  async getTool(role: WorkflowMcpRole, toolName: string): Promise<McpToolSummary | undefined> {
    const server = await this.resolve(role, toolName);
    return server?.tools.find((tool) => tool.name === toolName);
  }

  async callTool(role: WorkflowMcpRole, toolName: string, argumentsValue: Record<string, unknown>): Promise<unknown> {
    const server = await this.resolve(role, toolName);
    if (!server) throw new Error(`No enabled Workspace MCP server provides ${toolName}`);
    const result = unwrapWorkflowMcpResult(await this.config.callMcpTool(server.id, toolName, argumentsValue));
    const remoteError = role === "cutout" ? undefined : record(result)?.error;
    if (remoteError) {
      const detail = record(remoteError);
      throw new Error(typeof remoteError === "string" ? remoteError : String(detail?.message ?? JSON.stringify(remoteError)));
    }
    if (role !== "cutout" && !record(result) && !Array.isArray(result)) {
      throw new Error(typeof result === "string" ? result : `MCP tool ${toolName} returned an invalid response`);
    }
    return result;
  }

  private async resolve(role: WorkflowMcpRole, toolName: string): Promise<McpServerRecord | undefined> {
    const servers = (await this.config.listMcpServers()).filter((server) => server.enabled
      && roleScore(role, server) > 0
      && server.tools.some((tool) => tool.name === toolName));
    if (servers.length === 0) return undefined;
    const highestScore = Math.max(...servers.map((server) => roleScore(role, server)));
    const preferred = servers.filter((server) => roleScore(role, server) === highestScore);
    if (preferred.length !== 1) {
      const ids = preferred.map((server) => server.id).join(", ");
      throw new Error(`MCP tool ${toolName} is ambiguous for ${role}; matching servers: ${ids}`);
    }
    return preferred[0];
  }
}
