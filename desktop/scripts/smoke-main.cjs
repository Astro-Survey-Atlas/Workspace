#!/usr/bin/env node
// Plain-node smoke test for the desktop runtime modules (no GUI required):
// config persistence, free-port discovery, server child process + /healthz,
// and ES connectivity testing.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { loadConfig, saveConfig, normalizeConfig } = require("../src/config.cjs");
const { findFreePort, startServerProcess, startWorkspaceServer } = require("../src/server-process.cjs");
const { testExternalEs } = require("../src/es.cjs");

function assert(condition, message) {
  if (!condition) {
    console.error(`SMOKE FAILED: ${message}`);
    process.exit(1);
  }
  console.log(`ok - ${message}`);
}

async function main() {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "asa-desktop-smoke-"));

  // 1. Config round-trip
  const configPath = path.join(stateRoot, "desktop-config.json");
  const first = loadConfig({ explicitPath: configPath, homeDir: stateRoot });
  assert(first.config.firstRunComplete === false, "missing config reads as first run");
  saveConfig(configPath, {
    ...first.config,
    firstRunComplete: true,
    dataDir: stateRoot,
    search: { mode: "docker", externalUrl: "", docker: { containerName: "astro-workspace-search", port: 9207 } }
  });
  const second = loadConfig({ explicitPath: configPath, homeDir: stateRoot });
  assert(second.config.firstRunComplete === true, "config persists firstRunComplete");
  const normalized = normalizeConfig({ search: { mode: "bogus" } }, { homeDir: stateRoot });
  assert(normalized.search.mode === null, "invalid search mode normalizes to null");
  assert(normalizeConfig({ server: { port: -5 } }, { homeDir: stateRoot }).server.port === 0, "invalid port normalizes to 0");

  // 2. Free port
  const port = await findFreePort();
  assert(Number.isInteger(port) && port > 0, `findFreePort returns a port (${port})`);

  // 3. Server child process via ELECTRON_RUN_AS_NODE semantics (plain node here)
  const serverEntry = path.join(__dirname, "..", "build", "server.mjs");
  assert(fs.existsSync(serverEntry), "build/server.mjs exists (run npm run prepare:server)");
  const handle = startServerProcess({
    electronExecPath: process.execPath,
    serverEntry,
    viewerRoot: path.join(__dirname, "..", "build", "viewer"),
    logFile: path.join(stateRoot, "server.log"),
    stateRoot,
    port,
    esUrl: ""
  });
  try {
    const { health } = await startWorkspaceServer(handle, { timeoutMs: 30_000 });
    assert(health && health.status === "ok", `server healthy (version ${health && health.version})`);
  } finally {
    handle.stop();
  }

  // 4. External ES test on a dead port reports a clean failure
  const dead = await testExternalEs("http://127.0.0.1:1");
  assert(dead.ok === false, "dead ES endpoint fails cleanly");
  const malformed = await testExternalEs("not a url");
  assert(malformed.ok === false, "malformed ES URL fails validation");

  fs.rmSync(stateRoot, { recursive: true, force: true });
  console.log("SMOKE OK");
}

main().catch((error) => {
  console.error("SMOKE FAILED:", error);
  process.exit(1);
});
