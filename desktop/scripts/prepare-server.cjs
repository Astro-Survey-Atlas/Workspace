#!/usr/bin/env node
// Bundles the compiled server (../dist/src/http-server.js) into a single
// ESM file and stages the built viewer, so electron-builder can ship both
// as extraResources without node_modules.
"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const desktopRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(desktopRoot, "..");
const serverEntry = path.join(repoRoot, "dist", "src", "http-server.js");
const viewerDist = path.join(repoRoot, "dist", "viewer");
const buildDir = path.join(desktopRoot, "build");

if (!fs.existsSync(serverEntry)) {
  console.error("dist/src/http-server.js not found. Run `npm run build` in the repository root first.");
  process.exit(1);
}

fs.mkdirSync(buildDir, { recursive: true });

const banner = "import{createRequire as __createRequire}from'module';const require=__createRequire(import.meta.url);";

execFileSync(
  process.execPath,
  [
    path.join(desktopRoot, "node_modules", "esbuild", "bin", "esbuild"),
    serverEntry,
    "--bundle",
    "--platform=node",
    "--format=esm",
    `--banner:js=${banner}`,
    "--external:proxy-agent",
    "--external:pg-native",
    `--outfile=${path.join(buildDir, "server.mjs")}`,
    "--log-level=warning"
  ],
  { stdio: "inherit" }
);

fs.rmSync(path.join(buildDir, "viewer"), { recursive: true, force: true });
fs.cpSync(viewerDist, path.join(buildDir, "viewer"), { recursive: true });

console.log("prepared build/server.mjs and build/viewer");
