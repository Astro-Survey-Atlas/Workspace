"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("wizard", {
  init: () => ipcRenderer.invoke("wizard:init"),
  chooseDataDir: () => ipcRenderer.invoke("wizard:chooseDataDir"),
  testExternalEs: (url) => ipcRenderer.invoke("wizard:testExternalEs", url),
  detectDocker: (manualPath) => ipcRenderer.invoke("wizard:detectDocker", manualPath),
  prepareDockerEs: (options) => ipcRenderer.invoke("wizard:prepareDockerEs", options),
  complete: (config) => ipcRenderer.invoke("wizard:complete", config),
  onProgress: (listener) => {
    ipcRenderer.on("wizard:progress", (_event, message) => listener(message));
  }
});
