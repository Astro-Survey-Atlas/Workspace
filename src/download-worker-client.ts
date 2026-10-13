import type { CoverageDownloadFileState, CoverageDownloadPhase, CoverageDownloadStatus } from "./coverage-downloads.js";
import type { DownloadHealth, DownloadProxyConfig } from "./download-transport.js";

export interface WorkerDownloadJob {
  id: string;
  directory: string;
  transfer: CoverageDownloadFileState[];
  status: CoverageDownloadStatus;
  phase: CoverageDownloadPhase;
  error?: string;
  updatedAt: string;
}

export class DownloadWorkerClient {
  constructor(readonly url: string, readonly token: string, readonly proxy: () => Promise<DownloadProxyConfig>) {}

  async request<T>(route: string, method = "GET", body?: unknown): Promise<T> {
    const response = await fetch(`${this.url.replace(/\/$/, "")}${route}`, { method,
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(route === "/speed-test" ? 25_000 : 15_000) });
    const result = await response.json() as T & { error?: string };
    if (!response.ok) throw Object.assign(new Error(result.error ?? `下载服务返回 HTTP ${response.status}`), { code: `WORKER_HTTP_${response.status}` });
    return result;
  }

  async configure(source?: string): Promise<void> { await this.request("/config", "PUT", { config: await this.proxy(), source }); }
  async submit(id: string, directory: string, transfer: CoverageDownloadFileState[]): Promise<WorkerDownloadJob> {
    return this.request(`/jobs/${encodeURIComponent(id)}`, "PUT", { directory, transfer, config: await this.proxy() });
  }
  get(id: string): Promise<WorkerDownloadJob> { return this.request(`/jobs/${encodeURIComponent(id)}`); }
  action(id: string, action: "pause" | "resume" | "retry" | "cancel"): Promise<WorkerDownloadJob> {
    return this.request(`/jobs/${encodeURIComponent(id)}/${action}`, "POST", {});
  }
  async health(speed = false): Promise<DownloadHealth & { engineAvailable: boolean }> {
    return this.request(speed ? "/speed-test" : "/health", speed ? "POST" : "GET", speed ? {} : undefined);
  }
  async healthHistory(): Promise<DownloadHealth[]> { return (await this.request<{ samples: DownloadHealth[] }>("/health/history")).samples; }
  async test(): Promise<DownloadHealth & { engineAvailable: boolean }> { return this.request("/test", "POST", {}); }
}
