"use strict";

const fs = require("node:fs");
const path = require("node:path");

const CONFIG_VERSION = 1;
const CONFIG_FILE_NAME = "astro-workspace-desktop.json";

function defaultDataDir(homeDir, appDataDir) {
  const base = appDataDir || path.join(homeDir || process.env.HOME || process.cwd(), ".astro-survey-atlas");
  return path.join(base, "workspace-data");
}

function defaultConfig({ homeDir, appDataDir } = {}) {
  return {
    version: CONFIG_VERSION,
    firstRunComplete: false,
    dataDir: defaultDataDir(homeDir, appDataDir),
    server: { host: "127.0.0.1", port: 0 },
    search: { mode: null, externalUrl: "", docker: { containerName: "astro-workspace-search", port: 9207 } }
  };
}

function normalizeConfig(raw, fallbacks) {
  const base = defaultConfig(fallbacks || {});
  if (!raw || typeof raw !== "object") return base;
  return {
    version: CONFIG_VERSION,
    firstRunComplete: raw.firstRunComplete === true,
    dataDir: typeof raw.dataDir === "string" && raw.dataDir.trim() ? raw.dataDir : base.dataDir,
    server: {
      host: "127.0.0.1",
      port: Number.isInteger(raw.server && raw.server.port) && raw.server.port > 0 ? raw.server.port : 0
    },
    search: {
      mode: raw.search && (raw.search.mode === "external" || raw.search.mode === "docker") ? raw.search.mode : null,
      externalUrl: raw.search && typeof raw.search.externalUrl === "string" ? raw.search.externalUrl.trim() : "",
      docker: {
        containerName: (raw.search && raw.search.docker && raw.search.docker.containerName) || base.search.docker.containerName,
        port: raw.search && raw.search.docker && Number.isInteger(raw.search.docker.port) && raw.search.docker.port > 0
          ? raw.search.docker.port
          : base.search.docker.port
      }
    }
  };
}

function configCandidates(explicitPath, { appDataDir, homeDir } = {}) {
  if (explicitPath) return [explicitPath];
  const candidates = [];
  if (appDataDir) candidates.push(path.join(appDataDir, CONFIG_FILE_NAME));
  if (homeDir) candidates.push(path.join(homeDir, ".astro-survey-atlas", CONFIG_FILE_NAME));
  return candidates;
}

function loadConfig({ explicitPath, appDataDir, homeDir } = {}) {
  for (const candidate of configCandidates(explicitPath, { appDataDir, homeDir })) {
    try {
      const raw = JSON.parse(fs.readFileSync(candidate, "utf8"));
      return { path: candidate, config: normalizeConfig(raw, { homeDir, appDataDir }) };
    } catch (error) {
      if (error && error.code !== "ENOENT") {
        // Corrupt config: fall through and treat as first run, keep the bad file aside.
        try { fs.renameSync(candidate, `${candidate}.corrupt-${Date.now()}`); } catch { /* ignore */ }
      }
    }
  }
  const list = configCandidates(explicitPath, { appDataDir, homeDir });
  return { path: list[0], config: defaultConfig({ homeDir, appDataDir }) };
}

function saveConfig(configPath, config) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const tmp = `${configPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, configPath);
  return configPath;
}

module.exports = { CONFIG_VERSION, defaultConfig, normalizeConfig, loadConfig, saveConfig, defaultDataDir };
