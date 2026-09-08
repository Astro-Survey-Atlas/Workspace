"use strict";

const { spawn } = require("node:child_process");
const net = require("node:net");
const path = require("node:path");
const fs = require("node:fs");

const HEALTH_TIMEOUT_MS = 60_000;
const HEALTH_POLL_MS = 400;

function findFreePort(host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen({ host, port: 0, exclusive: true }, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitForHealth(baseUrl, { timeoutMs = HEALTH_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(new URL("/healthz", baseUrl), { signal: AbortSignal.timeout(1500) });
      if (response.ok) return await response.json();
      lastError = new Error(`healthz responded ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS));
  }
  throw new Error(`workspace server did not become healthy at ${baseUrl}: ${lastError && lastError.message}`);
}

function serverEnvironment({ stateRoot, port, esUrl, pythonCli, pythonHome, pythonPath, extraEnv = {} }) {
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    NODE_NO_WARNINGS: "1",
    HOST: "127.0.0.1",
    PORT: String(port),
    ASTRO_STATE_ROOT: stateRoot,
    ASTRO_SQLITE_PATH: path.join(stateRoot, "workspace.sqlite"),
    ASTRO_ES_URL: esUrl || "",
    ASTRO_WAREHOUSE_ES_URL: "",
    ASTRO_DATA_WAREHOUSE_ENABLED: "false"
  };
  if (pythonCli) env.ASTRO_MOC_CORE_CLI = pythonCli;
  if (pythonHome) env.PYTHONHOME = pythonHome;
  if (pythonPath) env.PYTHONPATH = pythonPath;
  return Object.assign(env, extraEnv);
}

function startServerProcess({ electronExecPath, serverEntry, viewerRoot, logFile, ...options }) {
  const port = options.port;
  const env = serverEnvironment(options);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const logStream = fs.openSync(logFile, "a");
  const child = spawn(electronExecPath, [serverEntry], {
    env,
    stdio: ["ignore", logStream, logStream],
    windowsHide: true
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    child,
    baseUrl,
    stop: () => {
      try { child.kill(); } catch { /* already gone */ }
    }
  };
}

async function startWorkspaceServer(handle, { timeoutMs } = {}) {
  const health = await waitForHealth(handle.baseUrl, { timeoutMs });
  return { handle, health };
}

module.exports = { findFreePort, waitForHealth, startServerProcess, startWorkspaceServer, serverEnvironment };
