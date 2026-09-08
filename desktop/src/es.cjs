"use strict";

const { execFile } = require("node:child_process");
const path = require("node:path");

const ES_IMAGE = "docker.elastic.co/elasticsearch/elasticsearch:8.18.0";
const DOCKER_TIMEOUT_MS = 30_000;
const ES_START_TIMEOUT_MS = 180_000;

function run(command, args, { timeoutMs = DOCKER_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout || ""), stderr: String(stderr || ""), error });
    });
  });
}

async function testExternalEs(url, { fetchImpl = fetch } = {}) {
  const trimmed = String(url || "").trim();
  if (!trimmed) return { ok: false, message: "请填写 Elasticsearch 地址。" };
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, message: "地址格式无效，需要形如 http://host:9200。" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, message: "仅支持 http/https 地址。" };
  }
  try {
    const response = await fetchImpl(new URL("/_cluster/health", parsed), {
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) return { ok: false, message: `Elasticsearch 返回 HTTP ${response.status}。` };
    const body = await response.json().catch(() => ({}));
    return { ok: true, message: `已连接（cluster_name: ${body.cluster_name || "unknown"}, status: ${body.status || "unknown"}）。` };
  } catch (error) {
    return { ok: false, message: `无法连接：${error && error.message ? error.message : "网络错误"}` };
  }
}

function dockerCandidates(platform = process.platform) {
  if (platform === "win32") {
    return [
      "docker.exe",
      path.join(process.env["ProgramFiles"] || "C:\\Program Files", "Docker", "Docker", "resources", "bin", "docker.exe"),
      path.join(process.env["LOCALAPPDATA"] || "", "Docker", "resources", "bin", "docker.exe")
    ];
  }
  if (platform === "darwin") {
    return [
      "docker",
      "/usr/local/bin/docker",
      "/opt/homebrew/bin/docker",
      "/Applications/Docker.app/Contents/Resources/bin/docker"
    ];
  }
  return ["docker", "/usr/bin/docker", "/usr/local/bin/docker"];
}

async function detectDocker({ candidates } = {}) {
  const list = candidates || dockerCandidates();
  for (const candidate of list) {
    const result = await run(candidate, ["info", "--format", "{{.ServerVersion}}"]);
    if (result.ok && result.stdout.trim()) {
      return { ok: true, dockerPath: candidate, version: result.stdout.trim() };
    }
  }
  return {
    ok: false,
    message: "未检测到可用的 Docker。请安装并启动 Docker Desktop，或在下方手动填写 docker 程序路径。"
  };
}

async function inspectContainer(dockerPath, containerName) {
  const result = await run(dockerPath, ["inspect", "-f", "{{.State.Running}}", containerName]);
  if (!result.ok) return { exists: false, running: false };
  return { exists: true, running: result.stdout.trim() === "true" };
}

async function ensureSearchContainer(dockerPath, { containerName, port, onProgress = () => {} }) {
  const state = await inspectContainer(dockerPath, containerName);
  if (!state.exists) {
    onProgress(`正在拉取并启动 Elasticsearch 容器 ${containerName}（首次可能需要下载数百 MB）…`);
    const created = await run(dockerPath, [
      "run", "-d",
      "--name", containerName,
      "-p", `127.0.0.1:${port}:9200`,
      "-v", `${containerName}-data:/usr/share/elasticsearch/data`,
      "-e", "discovery.type=single-node",
      "-e", "xpack.security.enabled=false",
      "-e", "ES_JAVA_OPTS=-Xms512m -Xmx512m",
      ES_IMAGE
    ], { timeoutMs: 600_000 });
    if (!created.ok) {
      const alreadyExists = /already in use/i.test(created.stderr || "");
      if (!alreadyExists) {
        return { ok: false, message: `容器启动失败：${(created.stderr || created.error && created.error.message || "").trim()}` };
      }
    }
  } else if (!state.running) {
    onProgress("正在启动已存在的 Elasticsearch 容器…");
    const started = await run(dockerPath, ["start", containerName]);
    if (!started.ok) {
      return { ok: false, message: `容器启动失败：${(started.stderr || "").trim()}` };
    }
  }
  onProgress("等待 Elasticsearch 就绪…");
  const deadline = Date.now() + ES_START_TIMEOUT_MS;
  let lastError = null;
  while (Date.now() < deadline) {
    const probe = await testExternalEs(`http://127.0.0.1:${port}`);
    if (probe.ok) {
      return { ok: true, esUrl: `http://127.0.0.1:${port}`, message: `Elasticsearch 已就绪（容器 ${containerName}）。` };
    }
    lastError = probe.message;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return { ok: false, message: `Elasticsearch 在 ${ES_START_TIMEOUT_MS / 1000}s 内未就绪：${lastError || "超时"}` };
}

module.exports = { ES_IMAGE, testExternalEs, detectDocker, ensureSearchContainer, inspectContainer, dockerCandidates };
