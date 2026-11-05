import { existsSync } from "node:fs";
import path from "node:path";

export interface WorkspaceCliRuntime {
  entryPath: string;
  nodeArgs: string[];
}

export function resolveWorkspaceCli(projectRoot: string, nodeEnvironment = process.env.NODE_ENV): WorkspaceCliRuntime {
  const roots = [path.resolve(projectRoot), path.resolve(projectRoot, "..")];
  const compiledCandidates = roots.map((root) => path.join(root, "packages/cli/dist/index.js"));
  const compiled = compiledCandidates.find(existsSync);
  if (compiled) return { entryPath: compiled, nodeArgs: [] };

  const sourceCandidates = roots.map((root) => path.join(root, "packages/cli/src/index.ts"));
  const source = sourceCandidates.find(existsSync);
  if (nodeEnvironment !== "production" && source) {
    return { entryPath: source, nodeArgs: ["--import", "tsx"] };
  }

  return { entryPath: compiledCandidates[0]!, nodeArgs: [] };
}
