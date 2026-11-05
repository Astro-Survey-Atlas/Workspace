import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { tool } from "@opencode-ai/plugin";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

function workspaceRoot(): string {
  return path.resolve(process.env.ASTRO_WORKSPACE_ROOT || sourceRoot);
}

function cliEntry(): string {
  const entry = path.join(workspaceRoot(), "packages/cli/dist/index.js");
  if (!existsSync(entry)) throw new Error("Build the Workspace CLI first with `npm run build:cli`.");
  return entry;
}

function baseUrl(): string {
  const value = process.env.ASTRO_WORKSPACE_URL || "http://127.0.0.1:3000";
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.pathname !== "/" || url.username || url.password || url.search || url.hash) {
    throw new Error("ASTRO_WORKSPACE_URL must be an HTTP(S) origin without credentials, query, or fragment.");
  }
  return url.toString().replace(/\/$/, "");
}

function apiPath(value: string): string {
  if (!value.startsWith("/api/") || value.startsWith("//") || value.includes("\\") || value.includes("\u0000")) {
    throw new Error("Workspace path must begin with /api/.");
  }
  const url = new URL(value, "http://workspace.invalid");
  if (url.origin !== "http://workspace.invalid" || !url.pathname.startsWith("/api/")) {
    throw new Error("Workspace path escaped the API.");
  }
  const segments = url.pathname.split("/").map((segment) => {
    try { return decodeURIComponent(segment); } catch { throw new Error("Workspace path has invalid URL encoding."); }
  });
  if (segments.some((segment) => segment.includes("/"))) throw new Error("Workspace path cannot contain encoded slashes.");
  if (segments[2] === "agent") throw new Error("OpenCode cannot call Workspace Agent session APIs.");
  const mcpToolIndex = segments.findIndex((segment, index) => index >= 2 && segment === "tools");
  if (mcpToolIndex >= 0 && segments[mcpToolIndex + 2] === "call"
    && ["euclid_catalog_query", "desi_catalog_query", "execute_cutout_group", "read_cutout_artifacts", "es_query"]
      .includes((segments[mcpToolIndex + 1] ?? "").toLowerCase())) {
    throw new Error("Scientific catalog and FITS cutout calls must run through a registered Workspace Workflow.");
  }
  return `${url.pathname}${url.search}`;
}

function approvalSummary(body?: Record<string, unknown>): string {
  if (!body) return "(no request body)";
  const redact = (value: unknown, depth = 0): unknown => {
    if (depth > 4) return "[nested]";
    if (Array.isArray(value)) return value.slice(0, 8).map((item) => redact(item, depth + 1));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).slice(0, 24).map(([key, item]) => [
        key,
        /authorization|api[_-]?key|secret|token|password|credential|cookie|signature/i.test(key)
          ? "[redacted]"
          : redact(item, depth + 1),
      ]));
    }
    if (typeof value === "string" && value.length > 160) return `${value.slice(0, 160)}…`;
    return value;
  };
  const summary = JSON.stringify(redact(body));
  return summary.length > 2_000 ? `${summary.slice(0, 2_000)}…` : summary;
}

function permissionOperation(method: string, endpoint: string): string {
  const pathname = new URL(endpoint, "http://workspace.invalid").pathname;
  return `${method} ${pathname}`;
}

function childEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ASA_WORKSPACE_AGENT_INVOCATION: "1",
    ASTRO_WORKSPACE_URL: baseUrl(),
  };
  for (const key of ["PATH", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"]) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  const traceparent = process.env.TRACEPARENT;
  if (traceparent && /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/i.test(traceparent)) environment.TRACEPARENT = traceparent;
  const tracestate = process.env.TRACESTATE;
  if (tracestate && tracestate.length <= 512 && !/[\r\n]/.test(tracestate)) environment.TRACESTATE = tracestate;
  return environment;
}

async function callWorkspace(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  value: string,
  body?: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  const endpoint = apiPath(value);
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Workspace CLI call aborted");
  const args = [cliEntry(), "--json", "--base-url", baseUrl(), "api", "--method", method, "--path", endpoint];
  if (body !== undefined) args.push("--input", "-");
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.ASTRO_WORKSPACE_NODE || "node", args, {
      env: childEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let outputTooLarge = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let timeout: NodeJS.Timeout;
    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      aborted = true;
      child.kill("SIGTERM");
    };
    timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, 60_000);
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > 1_048_576) {
        outputTooLarge = true;
        child.kill("SIGTERM");
      }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-4_000); });
    child.once("error", (error) => {
      fail(error);
    });
    child.once("close", (code, signal) => {
      if (aborted) return fail(new Error("Workspace CLI call aborted."));
      if (timedOut) return fail(new Error("Workspace CLI call timed out after 60 seconds."));
      if (outputTooLarge) return fail(new Error("Workspace CLI response exceeded 1 MiB."));
      if (code !== 0) return fail(new Error(stderr.trim() || `Workspace CLI exited with ${signal ?? code}.`));
      if (settled) return;
      settled = true;
      cleanup();
      resolve(stdout.trim());
    });
    child.stdin.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

export const read = tool({
  description: "Read JSON state from a Workspace /api route through the compiled Workspace CLI.",
  args: {
    path: tool.schema.string().describe("A Workspace API path beginning with /api/"),
  },
  async execute(args, context) {
    return callWorkspace("GET", args.path, undefined, context.abort);
  },
});

export const action = tool({
  description: "Call a mutating Workspace API route through the compiled Workspace CLI. OpenCode asks the user before this tool runs.",
  args: {
    method: tool.schema.enum(["POST", "PUT", "PATCH", "DELETE"]),
    path: tool.schema.string().describe("A Workspace API path beginning with /api/"),
    body: tool.schema.record(tool.schema.string(), tool.schema.unknown()).optional(),
  },
  async execute(args, context) {
    const endpoint = apiPath(args.path);
    const operation = permissionOperation(args.method, endpoint);
    const summary = approvalSummary(args.body);
    context.metadata({
      title: `Workspace action: ${operation}`,
      metadata: { operation, request: summary },
    });
    await context.ask({
      permission: "workspace_action",
      patterns: [operation],
      always: [],
      metadata: { operation, request: summary },
    });
    return callWorkspace(args.method, endpoint, args.body, context.abort);
  },
});
