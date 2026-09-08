"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require("electron");

const { loadConfig, saveConfig } = require("./config.cjs");
const { findFreePort, startServerProcess, startWorkspaceServer } = require("./server-process.cjs");
const es = require("./es.cjs");

let mainWindow = null;
let serverHandle = null;

const appRoot = app.getAppPath();
const resourcesRoot = app.isPackaged ? process.resourcesPath : path.join(appRoot, "build");
const wizardHtml = app.isPackaged
  ? path.join(process.resourcesPath, "wizard.html")
  : path.join(appRoot, "resources", "wizard.html");
const serverEntry = path.join(resourcesRoot, "server.mjs");
const viewerRoot = path.join(resourcesRoot, "viewer");
const pythonHome = path.join(resourcesRoot, "python");
const pythonSitePackages = path.join(pythonHome, "site-packages");
const pythonExecutable = process.platform === "win32"
  ? path.join(pythonHome, "python.exe")
  : path.join(pythonHome, "bin", "python3");

function resourcesLayout() {
  const hasEmbeddedPython = fs.existsSync(pythonExecutable);
  return {
    serverEntry,
    viewerRoot,
    pythonCli: hasEmbeddedPython
      ? `"${pythonExecutable}" -m astro_survey_moc_core.cli`
      : null,
    pythonHome: hasEmbeddedPython ? pythonHome : null,
    pythonPath: hasEmbeddedPython ? pythonSitePackages : null
  };
}

function pythonCliArgument() {
  // execFile-style CLI string consumed by moc-core-adapter; embeddable python
  // runs the pinned wheel module directly.
  const layout = resourcesLayout();
  return layout.pythonCli;
}

function logPath() {
  return path.join(app.getPath("userData"), "logs", "workspace-server.log");
}

async function startServer(config, { port } = {}) {
  const resolvedPort = port || config.server.port || await findFreePort(config.server.host);
  const handle = startServerProcess({
    electronExecPath: process.execPath,
    serverEntry,
    viewerRoot,
    logFile: logPath(),
    stateRoot: config.dataDir,
    port: resolvedPort,
    esUrl: resolveEsUrl(config),
    pythonCli: pythonCliArgument(),
    pythonHome: resourcesLayout().pythonHome,
    pythonPath: resourcesLayout().pythonPath
  });
  serverHandle = handle;
  await startWorkspaceServer(handle);
  return { baseUrl: handle.baseUrl, port: resolvedPort };
}

function resolveEsUrl(config) {
  if (config.search.mode === "external") return config.search.externalUrl;
  if (config.search.mode === "docker") return `http://127.0.0.1:${config.search.docker.port}`;
  return "";
}

function showFatalError(message) {
  dialog.showErrorBox("Astro Survey Atlas Workspace", message);
}

async function launchMainWindow(config) {
  let started;
  try {
    started = await startServer(config);
  } catch (error) {
    showFatalError(`本地服务启动失败：${error && error.message}\n\n日志：${logPath()}`);
    app.quit();
    return;
  }
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: "Astro Survey Atlas Workspace",
    show: false,
    backgroundColor: "#0b0f14",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  Menu.setApplicationMenu(null);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(started.baseUrl)) {
      event.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });
  mainWindow.once("ready-to-show", () => mainWindow.show());
  await mainWindow.loadURL(started.baseUrl);
}

function runWizard(config, configPath) {
  const wizard = new BrowserWindow({
    width: 760,
    height: 640,
    resizable: false,
    title: "Astro Survey Atlas Workspace — 初始设置",
    backgroundColor: "#0b0f14",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  Menu.setApplicationMenu(null);
  wizard.setMenuBarVisibility(false);
  wizard.loadFile(wizardHtml);

  let wizardConfig = config;

  ipcMain.handle("wizard:init", () => ({
    config: wizardConfig,
    defaults: { dataDir: wizardConfig.dataDir }
  }));
  ipcMain.handle("wizard:chooseDataDir", async () => {
    const result = await dialog.showOpenDialog(wizard, {
      title: "选择数据目录",
      properties: ["openDirectory", "createDirectory"]
    });
    if (result.canceled || !result.filePaths[0]) return { path: null };
    return { path: result.filePaths[0] };
  });
  ipcMain.handle("wizard:testExternalEs", async (_event, url) => es.testExternalEs(url));
  ipcMain.handle("wizard:detectDocker", async (_event, manualPath) => {
    if (manualPath && manualPath.trim()) {
      const probe = await es.detectDocker({ candidates: [manualPath.trim()] });
      if (probe.ok) return probe;
      return { ok: false, message: `指定路径不可用：${probe.message || "无法执行 docker info"}` };
    }
    return es.detectDocker();
  });
  ipcMain.handle("wizard:prepareDockerEs", async (_event, { dockerPath, containerName, port }) => {
    return es.ensureSearchContainer(dockerPath, {
      containerName: containerName || "astro-workspace-search",
      port: Number(port) || 9207,
      onProgress: (message) => wizard.webContents.send("wizard:progress", message)
    });
  });
  ipcMain.handle("wizard:complete", async (_event, next) => {
    wizardConfig = {
      ...wizardConfig,
      firstRunComplete: true,
      dataDir: next.dataDir,
      search: {
        mode: next.search.mode,
        externalUrl: next.search.externalUrl || "",
        docker: {
          containerName: next.search.docker.containerName || "astro-workspace-search",
          port: Number(next.search.docker.port) || 9207
        }
      }
    };
    saveConfig(configPath, wizardConfig);
    wizard.close();
    await launchMainWindow(wizardConfig);
    return { ok: true };
  });
  wizard.on("closed", () => {
    if (!mainWindow && !wizardConfig.firstRunComplete) app.quit();
  });
}

function setupAutoUpdate() {
  if (!app.isPackaged) return;
  try {
    const { autoUpdater } = require("electron-updater");
    autoUpdater.logger = console;
    autoUpdater.checkForUpdatesAndNotify().catch((error) => {
      console.warn("auto-update check failed:", error && error.message);
    });
  } catch (error) {
    console.warn("auto-updater unavailable:", error && error.message);
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    const { path: configPath, config } = loadConfig({
      appDataDir: app.getPath("userData"),
      homeDir: app.getPath("home")
    });
    if (!config.firstRunComplete) {
      runWizard(config, configPath);
    } else {
      launchMainWindow(config).catch((error) => {
        showFatalError(`启动失败：${error && error.message}`);
        app.quit();
      });
    }
    setupAutoUpdate();
  });

  app.on("before-quit", () => {
    if (serverHandle) serverHandle.stop();
  });

  app.on("window-all-closed", () => {
    if (serverHandle) serverHandle.stop();
    app.quit();
  });
}
