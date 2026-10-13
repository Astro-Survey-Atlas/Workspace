import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { Readable } from "node:stream";
import { performance } from "node:perf_hooks";
import { fetchPublicHttp } from "./public-http.js";
import type { RemoteHostnameResolver } from "./remote-url-policy.js";

export interface DownloadProxyConfig {
  enabled: boolean;
  url: string;
  username?: string;
  password?: string;
  revision: string;
}

export interface DownloadHealth {
  status: "unknown" | "ok" | "failed" | "disabled";
  checkedAt: string;
  revision: string;
  proxyConnectMs?: number;
  sourceResponseMs?: number;
  detail: string;
  speedBytesPerSecond?: number;
  sampledBytes?: number;
}

function proxyAuthorization(config: DownloadProxyConfig): Record<string, string> {
  return config.username ? { "Proxy-Authorization": `Basic ${Buffer.from(`${config.username}:${config.password ?? ""}`).toString("base64")}` } : {};
}

async function tunnel(target: URL, config: DownloadProxyConfig, signal: AbortSignal | undefined): Promise<tls.TLSSocket> {
  const proxy = new URL(config.url);
  return new Promise((resolve, reject) => {
    const destination = `${target.hostname}:${target.port || 443}`;
    const req = http.request({ hostname: proxy.hostname, port: proxy.port || 80, method: "CONNECT", path: destination,
      headers: { Host: destination, ...proxyAuthorization(config) }, signal });
    req.once("error", reject);
    req.once("connect", (response, socket, head) => {
      if (response.statusCode !== 200) {
        socket.destroy(); reject(Object.assign(new Error(`代理 CONNECT 返回 ${response.statusCode}`), { code: `PROXY_HTTP_${response.statusCode}` })); return;
      }
      if (head.length) socket.unshift(head);
      // EAS intermittently closes the default ClientHello through this route.
      // TLS 1.2 remains certificate-verified and is scoped to ESA only.
      const secure = tls.connect({ socket, servername: target.hostname, ALPNProtocols: ["http/1.1"],
        ...(target.hostname === "eas.esac.esa.int" ? { minVersion: "TLSv1.2", maxVersion: "TLSv1.2" } : {}) });
      const abort = () => secure.destroy(signal?.reason instanceof Error ? signal.reason : new Error("Request aborted"));
      signal?.addEventListener("abort", abort, { once: true });
      secure.once("close", () => signal?.removeEventListener("abort", abort));
      secure.once("error", reject);
      secure.once("secureConnect", () => resolve(secure));
    });
    req.end();
  });
}

/** Streaming HTTP client. Redirects stay in fetchPublicHttp so each hop is checked. */
export function downloadFetch(config: DownloadProxyConfig): typeof fetch {
  return async (input, init) => {
    const target = new URL(input instanceof Request ? input.url : String(input));
    if (target.username || target.password) throw new RangeError("源站 URL 不能包含认证信息");
    const signal = init?.signal ?? undefined;
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    let agent: https.Agent | undefined;
    if (config.enabled && target.protocol === "https:") {
      const socket = await tunnel(target, config, signal);
      agent = new https.Agent({ keepAlive: false });
      agent.createConnection = () => socket;
    }
    return new Promise<Response>((resolve, reject) => {
      const viaHttpProxy = config.enabled && target.protocol === "http:";
      const destination = viaHttpProxy ? new URL(config.url) : target;
      const requester = destination.protocol === "https:" ? https : http;
      const req = requester.request(destination, {
        method: init?.method ?? "GET", signal, agent: agent ?? false,
        ...(viaHttpProxy ? { path: target.href } : {}),
        headers: { ...headers, Host: target.host, ...(viaHttpProxy ? proxyAuthorization(config) : {}) },
      }, response => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (value !== undefined) responseHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);
        }
        const status = response.statusCode ?? 502;
        const noBody = init?.method === "HEAD" || [204, 205, 304].includes(status);
        if (noBody) response.resume();
        resolve(new Response(noBody ? null : Readable.toWeb(response) as ReadableStream<Uint8Array>, { status, headers: responseHeaders }));
      });
      req.once("error", reject);
      req.end();
    });
  };
}

export async function checkDownloadRoute(config: DownloadProxyConfig, source: string, speed = false,
  transport: { fetchImpl?: typeof fetch; resolveHostname?: RemoteHostnameResolver } = {}): Promise<DownloadHealth> {
  const checkedAt = new Date().toISOString();
  const signal = AbortSignal.timeout(speed ? 20_000 : 10_000);
  const start = performance.now();
  let proxyConnectMs: number | undefined;
  try {
    if (config.enabled) {
      const proxy = new URL(config.url);
      await new Promise<void>((resolve, reject) => {
        const req = http.request(proxy, { method: "HEAD", signal });
        req.once("socket", socket => socket.once("connect", () => { proxyConnectMs = Math.round(performance.now() - start); req.destroy(); resolve(); }));
        req.once("error", error => { if (proxyConnectMs === undefined) reject(error); });
        req.end();
      });
    }
    const sourceStart = performance.now();
    const size = speed ? 1_048_576 : 1;
    const response = await fetchPublicHttp(source, { signal, headers: { Range: `bytes=0-${size - 1}`, "Accept-Encoding": "identity" } },
      { fetchImpl: transport.fetchImpl ?? downloadFetch(config), resolveHostname: transport.resolveHostname });
    const sourceResponseMs = Math.round(performance.now() - sourceStart);
    if (![200, 206].includes(response.status)) { await response.body?.cancel(); throw new Error(`源站返回 HTTP ${response.status}`); }
    const reader = response.body?.getReader();
    let bytes = 0;
    try {
      while (reader && bytes < size) { const chunk = await reader.read(); if (chunk.done) break; bytes += Math.min(chunk.value.byteLength, size - bytes); }
    } finally { await reader?.cancel().catch(() => undefined); }
    if (!bytes) throw new Error("源站没有返回数据");
    return { status: "ok", checkedAt, revision: config.revision, proxyConnectMs, sourceResponseMs,
      detail: config.enabled ? "代理和下载源站可用" : "直连下载源站可用",
      ...(speed ? { sampledBytes: bytes, speedBytesPerSecond: Math.round(bytes * 1000 / (performance.now() - sourceStart)) } : {}) };
  } catch (error) {
    return { status: "failed", checkedAt, revision: config.revision, proxyConnectMs,
      detail: error instanceof Error ? error.message.slice(0, 300) : "下载链路检测失败" };
  }
}
