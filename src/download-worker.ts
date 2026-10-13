import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile, rename, stat, lstat, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { assertPublicHttpUrl, type RemoteHostnameResolver } from "./remote-url-policy.js";
import { fetchPublicHttp } from "./public-http.js";
import { validateRelativePath } from "./source-crawler.js";
import { hashFile, isImmutableEuclidQ1EasFile, type CoverageDownloadFileState } from "./coverage-downloads.js";
import { checkDownloadRoute, downloadFetch, type DownloadHealth, type DownloadProxyConfig } from "./download-transport.js";
import type { WorkerDownloadJob } from "./download-worker-client.js";

type EngineStatus = { status: string; completedLength: string; totalLength: string; downloadSpeed: string; errorCode?: string; errorMessage?: string };
interface DurableState { jobs: WorkerDownloadJob[]; config: DownloadProxyConfig; source: string; health?: DownloadHealth; healthHistory?: DownloadHealth[] }

export class DownloadWorker {
  readonly jobs = new Map<string, WorkerDownloadJob>();
  config: DownloadProxyConfig = { enabled: false, url: "", revision: "initial" };
  health: DownloadHealth = { status: "unknown", checkedAt: "", revision: "initial", detail: "尚未检测" };
  healthHistory: DownloadHealth[] = [];
  source = "https://eas.esac.esa.int/";
  engineAvailable = false;
  private engine?: ChildProcess;
  private saving = Promise.resolve();
  private ticking = false;
  private checking = false;
  private stopping = false;
  private rootReal = "";
  private readonly verifying = new Set<string>();
  private readonly timers: Array<ReturnType<typeof setInterval>> = [];
  private readonly workerRoot: string;
  private readonly statePath: string;

  constructor(readonly root: string, readonly token: string, readonly port = 7080, readonly rpcPort = 6800,
    private readonly transport: { fetchImpl?: typeof fetch; resolveHostname?: RemoteHostnameResolver } = {}) {
    if (!path.isAbsolute(root) || token.length < 24) throw new Error("下载服务需要绝对存储路径及至少 24 字符的认证 token");
    this.workerRoot = path.join(root, ".download-worker");
    this.statePath = path.join(this.workerRoot, "state.json");
  }

  private async persist(): Promise<void> {
    const snapshot: DurableState = structuredClone({ jobs: [...this.jobs.values()], config: this.config, source: this.source, health: this.health, healthHistory: this.healthHistory });
    this.saving = this.saving.catch(() => undefined).then(async () => {
      await writeFile(`${this.statePath}.tmp`, JSON.stringify(snapshot), { mode: 0o600 });
      await rename(`${this.statePath}.tmp`, this.statePath);
    });
    return this.saving;
  }

  private async rpc<T>(method: string, params: unknown[] = []): Promise<T> {
    const response = await fetch(`http://127.0.0.1:${this.rpcPort}/jsonrpc`, { method: "POST",
      headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(5_000),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: `aria2.${method}`, params: [`token:${this.token}`, ...params] }) });
    const body = await response.json() as { result: T; error?: { message: string } };
    if (body.error) throw new Error(body.error.message);
    return body.result;
  }

  async initialize(): Promise<void> {
    await mkdir(this.workerRoot, { recursive: true, mode: 0o700 });
    this.rootReal = await realpath(this.root);
    try {
      const saved = JSON.parse(await readFile(this.statePath, "utf8")) as DurableState;
      for (const job of saved.jobs ?? []) this.jobs.set(job.id, job);
      this.config = saved.config ?? this.config; this.source = saved.source ?? this.source; this.health = saved.health ?? this.health;
      this.healthHistory = (saved.healthHistory ?? []).slice(-24);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const session = path.join(this.workerRoot, "aria2.session");
    try { await stat(session); } catch { await writeFile(session, "", { mode: 0o600 }); }
    const binary = process.env.ASTRO_ARIA2_BINARY ?? "aria2c";
    if (!execFileSync(binary, ["--version"], { encoding: "utf8" }).includes("aria2 version 1.37.0")) throw new Error("下载服务要求 aria2 1.37.0");
    const options = ["--enable-rpc=true", "--rpc-listen-all=false", `--rpc-listen-port=${this.rpcPort}`, `--rpc-secret=${this.token}`,
      "--quiet=true", "--console-log-level=error", "--log-level=error", "--enable-color=false",
      `--save-session=${session}`, `--input-file=${session}`, "--save-session-interval=10", "--auto-save-interval=10",
      "--continue=true", "--always-resume=true", "--auto-file-renaming=false", "--allow-overwrite=false", "--file-allocation=none",
      "--max-concurrent-downloads=2", "--max-connection-per-server=2", "--split=2", "--min-split-size=4M",
      "--max-tries=1", "--connect-timeout=15", "--timeout=120", "--check-certificate=true", "--ca-certificate=/etc/ssl/certs/ca-certificates.crt"];
    this.engine = spawn(binary, options, { stdio: "ignore" });
    this.engine.once("exit", () => { this.engineAvailable = false; if (!this.stopping) { console.error("aria2 exited; restarting durable worker"); process.exitCode = 1; this.server.close(); } });
    await new Promise<void>(resolve => this.server.listen(this.port, "0.0.0.0", resolve));
    for (let attempt = 0; attempt < 30; attempt++) {
      try { await this.rpc("getVersion"); this.engineAvailable = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    if (!this.engineAvailable) throw new Error("aria2 RPC 未就绪");
    for (const job of this.jobs.values()) if (job.phase === "paused" || job.status === "cancelled") {
      for (const entry of job.transfer) if (entry.gid) await this.rpc("forcePause", [entry.gid]).catch(() => undefined);
    }
    this.timers.push(setInterval(() => void this.tick().catch(error => console.error("下载调度失败", error instanceof Error ? error.name : "error")), 2_000),
      setInterval(() => void this.check(), 30_000), setInterval(() => void this.persist(), 10_000));
    for (const timer of this.timers) timer.unref();
    void this.check(); void this.tick();
  }

  async close(): Promise<void> {
    this.stopping = true;
    for (const timer of this.timers) clearInterval(timer);
    while (this.ticking) await new Promise(resolve => setTimeout(resolve, 50));
    await this.persist();
    await this.rpc("saveSession").catch(() => undefined);
    const exit = this.engine ? new Promise<void>(resolve => this.engine!.once("exit", () => resolve())) : Promise.resolve();
    this.engine?.kill("SIGTERM");
    this.server.closeAllConnections();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
    await Promise.race([exit, new Promise<void>(resolve => { const timer = setTimeout(() => { this.engine?.kill("SIGKILL"); resolve(); }, 5_000); timer.unref(); })]);
  }

  private authenticated(request: IncomingMessage): boolean {
    const expected = Buffer.from(`Bearer ${this.token}`), actual = Buffer.from(request.headers.authorization ?? "");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  private async body(request: IncomingMessage): Promise<Record<string, unknown>> {
    let size = 0; const chunks: Buffer[] = [];
    for await (const chunk of request) { size += chunk.length; if (size > 8_388_608) throw new RangeError("请求体过大"); chunks.push(chunk); }
    return JSON.parse(Buffer.concat(chunks).toString() || "{}") as Record<string, unknown>;
  }

  readonly server = createServer((request, response) => { void this.handle(request, response).catch(error => {
    if (response.headersSent) { response.destroy(); return; }
    this.json(response, error instanceof RangeError ? 400 : 503, { error: error instanceof Error ? error.message.slice(0, 300) : "下载服务错误" });
  }); });

  private json(response: ServerResponse, status: number, value: unknown): void {
    response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); response.end(JSON.stringify(value));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://worker");
    if (url.pathname === "/ready") { this.json(response, this.engineAvailable ? 200 : 503, { ready: this.engineAvailable }); return; }
    if (!this.authenticated(request)) { this.json(response, 401, { error: "Unauthorized" }); return; }
    const file = /^\/files\/([a-zA-Z0-9_-]+)\/(\d+)$/.exec(url.pathname);
    if (file) { await this.gateway(request, response, file[1]!, Number(file[2])); return; }
    if (url.pathname === "/health" && request.method === "GET") { this.json(response, 200, { ...this.health, engineAvailable: this.engineAvailable }); return; }
    if (url.pathname === "/health/history" && request.method === "GET") { this.json(response, 200, { samples: this.healthHistory }); return; }
    if ((url.pathname === "/test" || url.pathname === "/speed-test") && request.method === "POST") {
      const result = await this.check(url.pathname === "/speed-test", true);
      this.json(response, 200, { ...result, engineAvailable: this.engineAvailable }); return;
    }
    if (url.pathname === "/config" && request.method === "PUT") {
      const body = await this.body(request); this.setConfig(body.config);
      if (typeof body.source === "string") {
        await assertPublicHttpUrl(body.source, { resolveHostname: this.transport.resolveHostname, signal: AbortSignal.timeout(5_000) });
        if (body.source !== this.source) {
          this.health = { status: "unknown", revision: this.config.revision, checkedAt: "", detail: "下载源已更新，等待检测" };
          this.healthHistory = [];
        }
        this.source = body.source;
      }
      await this.persist(); void this.check(); this.json(response, 200, { ok: true }); return;
    }
    const match = /^\/jobs\/([a-zA-Z0-9_-]+)(?:\/(pause|resume|retry|cancel))?$/.exec(url.pathname);
    if (!match) { this.json(response, 404, { error: "Not found" }); return; }
    const id = match[1]!, action = match[2];
    let job = this.jobs.get(id);
    if (request.method === "PUT" && !action) {
      const body = await this.body(request); this.setConfig(body.config);
      if (typeof body.directory !== "string" || !Array.isArray(body.transfer) || !body.transfer.length || body.transfer.length > 4096) throw new RangeError("Invalid download job");
      const transfer = body.transfer as CoverageDownloadFileState[];
      const seen = new Set<string>();
      for (const entry of transfer) {
        await assertPublicHttpUrl(entry.url, { resolveHostname: this.transport.resolveHostname }); validateRelativePath(entry.relativePath);
        if (seen.has(entry.relativePath)) throw new RangeError("Duplicate output path"); seen.add(entry.relativePath);
        await this.safeTarget(body.directory, entry.relativePath);
      }
      if (job) {
        const identity = (entries: CoverageDownloadFileState[]) => JSON.stringify(entries.map(e => [e.url, e.relativePath, e.expectedSizeBytes, e.expectedSha256]));
        if (job.directory !== body.directory || identity(job.transfer) !== identity(transfer)) throw new RangeError("任务 ID 已关联不同文件清单");
      } else {
        for (const active of this.jobs.values()) {
          if (active.id === id || !["queued", "running"].includes(active.status)) continue;
          const targets = new Set(active.transfer.filter(entry => entry.status !== "verified").map(entry => path.resolve(active.directory, entry.relativePath)));
          if (transfer.some(entry => targets.has(path.resolve(body.directory as string, entry.relativePath)))) throw new RangeError("已有下载任务正在使用同一输出文件");
        }
        job = { id, directory: body.directory, transfer: structuredClone(transfer), status: "queued", phase: "queued", updatedAt: new Date().toISOString() };
        for (const entry of job.transfer) if (entry.status !== "verified") { entry.status = entry.bytesPresent ? "partial" : "pending"; delete entry.gid; }
        this.jobs.set(id, job); this.source = job.transfer[0]!.url;
        await this.persist(); void this.tick();
      }
    }
    if (!job) { this.json(response, 404, { error: "Download not found" }); return; }
    if (action && request.method === "POST") {
      if (action === "pause" || action === "cancel") {
        job.phase = action === "pause" ? "paused" : "cancelled";
        job.status = action === "cancel" ? "cancelled" : "running";
        await this.persist();
        for (const entry of job.transfer) if (entry.gid && entry.status !== "verified") await this.rpc("forcePause", [entry.gid]).catch(() => undefined);
      } else {
        job.status = "running"; job.phase = "resuming"; delete job.error;
        for (const entry of job.transfer) {
          if (entry.status === "verified") continue;
          if (action === "retry" && entry.status === "failed") { entry.status = entry.bytesPresent ? "partial" : "pending"; delete entry.nextRetryAt; }
          if (entry.gid) await this.rpc("unpause", [entry.gid]).catch(() => undefined);
        }
        await this.persist(); void this.tick();
      }
      job.updatedAt = new Date().toISOString();
    }
    this.json(response, 200, job);
  }

  private setConfig(value: unknown): void {
    if (!value || typeof value !== "object") throw new RangeError("Missing proxy configuration");
    const config = value as DownloadProxyConfig;
    if (typeof config.enabled !== "boolean" || typeof config.revision !== "string") throw new RangeError("Invalid proxy configuration");
    if (config.enabled) { const proxy = new URL(config.url); if (proxy.protocol !== "http:" || proxy.username || proxy.password) throw new RangeError("HTTP proxy required"); }
    if (config.revision !== this.config.revision) {
      this.health = { status: "unknown", revision: config.revision, checkedAt: "", detail: "配置已更新，等待检测" };
      this.healthHistory = [];
    }
    this.config = structuredClone(config);
  }

  private async check(speed = false, manual = false): Promise<DownloadHealth> {
    if (this.checking && !manual) return this.health;
    this.checking = true;
    const config = structuredClone(this.config);
    const source = this.source;
    try {
      const result = await checkDownloadRoute(config, source, speed, this.transport);
      if (result.revision === this.config.revision && source === this.source && !speed) {
        this.health = result;
        this.healthHistory = [...this.healthHistory.filter(sample => sample.revision === result.revision), result].slice(-24);
        await this.persist();
      }
      return result;
    } finally { this.checking = false; }
  }

  private async safeTarget(directory: string, relative: string): Promise<string> {
    validateRelativePath(relative);
    const target = path.resolve(directory, relative);
    if (!target.startsWith(path.resolve(this.root) + path.sep) || target.startsWith(this.workerRoot + path.sep)) throw new RangeError("下载路径超出共享存储范围");
    let ancestor = path.dirname(target);
    while (true) {
      try { const actual = await realpath(ancestor); if (actual !== this.rootReal && !actual.startsWith(this.rootReal + path.sep)) throw new RangeError("下载路径包含越界链接"); break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; ancestor = path.dirname(ancestor); }
    }
    for (const candidate of [target, `${target}.part`, `${target}.part.aria2`]) {
      try { if ((await lstat(candidate)).isSymbolicLink()) throw new RangeError("下载文件不能是符号链接"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    return target;
  }

  private async gateway(request: IncomingMessage, response: ServerResponse, id: string, index: number): Promise<void> {
    const job = this.jobs.get(id), entry = job?.transfer[index];
    if (!entry || !["GET", "HEAD"].includes(request.method ?? "")) { this.json(response, 404, { error: "File not found" }); return; }
    if (job?.phase === "paused" || job?.status === "cancelled") { this.json(response, 503, { error: "下载已暂停" }); return; }
    delete entry.lastErrorCode; delete entry.error;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const mark = () => { clearTimeout(timer); timer = setTimeout(() => abort.abort(new Error("源站 120 秒无数据")), 120_000); timer.unref(); };
    mark(); response.once("close", () => { if (!response.writableFinished) abort.abort(); });
    const headers: Record<string, string> = { "Accept-Encoding": "identity" };
    const range = request.headers.range;
    const validator = entry.etag && !entry.etag.startsWith("W/") ? entry.etag : entry.lastModified;
    if (range) {
      if (!/^bytes=\d+-\d*$/.test(range)) throw new RangeError("Unsupported Range");
      if (Number(/^bytes=(\d+)/.exec(range)?.[1]) > 0 && !validator && !isImmutableEuclidQ1EasFile(entry)) throw new RangeError("源站没有可用于安全断点续传的版本依据");
      headers.Range = range; if (validator) headers["If-Range"] = validator;
    }
    if (entry.etag && !entry.etag.startsWith("W/")) headers["If-Match"] = entry.etag;
    else if (entry.lastModified) headers["If-Unmodified-Since"] = entry.lastModified;
    try {
      const source = await fetchPublicHttp(entry.url, { method: request.method, headers, signal: abort.signal },
        { fetchImpl: this.transport.fetchImpl ?? downloadFetch(this.config), resolveHostname: this.transport.resolveHostname });
      if (source.ok) {
        const contentType = source.headers.get("content-type") ?? "";
        const actualEtag = source.headers.get("etag"), actualModified = source.headers.get("last-modified");
        if (/\.(fits?|fts)(\.gz)?$/i.test(entry.name) && /(?:text\/html|application\/(?:json|xml)|text\/xml)/i.test(contentType)) {
          await source.body?.cancel(); entry.lastErrorCode = "SOURCE_NOT_SCIENCE"; throw new Error("源站返回页面或元数据，未返回科学 FITS 文件");
        }
        if ((entry.etag && actualEtag && entry.etag !== actualEtag) || (entry.lastModified && actualModified && entry.lastModified !== actualModified)) {
          await source.body?.cancel(); entry.lastErrorCode = "SOURCE_CHANGED"; throw new Error("源文件版本已变化，请重新预览后创建新任务");
        }
        entry.etag ??= actualEtag ?? undefined; entry.lastModified ??= actualModified ?? undefined;
      }
      if (!source.ok) { entry.lastErrorCode = `SOURCE_HTTP_${source.status}`; entry.error = `源站返回 HTTP ${source.status}`; }
      if (range && source.ok) {
        const actual = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(source.headers.get("content-range") ?? "");
        const wanted = /^bytes=(\d+)-(\d*)$/.exec(range)!;
        if (source.status !== 206 || !actual || actual[1] !== wanted[1] || (wanted[2] && Number(actual[2]) > Number(wanted[2]))
          || (entry.expectedSizeBytes !== undefined && Number(actual[3]) !== entry.expectedSizeBytes)) {
          await source.body?.cancel(); entry.lastErrorCode = "SOURCE_RANGE_MISMATCH"; throw new Error("源站断点响应与请求或文件大小不一致");
        }
      }
      const outputHeaders: Record<string, string> = {};
      for (const key of ["content-length", "content-range", "content-type", "accept-ranges", "etag", "last-modified"]) {
        const value = source.headers.get(key); if (value) outputHeaders[key] = value;
      }
      response.writeHead(source.status, outputHeaders);
      if (!source.body || request.method === "HEAD") { response.end(); return; }
      const stream = Readable.fromWeb(source.body as import("node:stream/web").ReadableStream<Uint8Array>);
      stream.on("data", mark);
      await pipeline(stream, response);
    } catch (error) {
      if (!abort.signal.aborted) { entry.error = error instanceof Error ? error.message.slice(0, 300) : "源站连接中断"; entry.lastErrorCode ??= "SOURCE_TRANSPORT"; }
      throw error;
    } finally { clearTimeout(timer!); }
  }

  private async prepare(job: WorkerDownloadJob, entry: CoverageDownloadFileState, index: number): Promise<void> {
    const target = await this.safeTarget(job.directory, entry.relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    try {
      const final = await stat(target);
      if (entry.expectedSizeBytes !== undefined && final.size !== entry.expectedSizeBytes) throw new Error("现有最终文件大小不符，已保留文件等待检查");
      await this.verify(entry, target, target); return;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const part = `${target}.part`;
    let control = false; try { await stat(`${part}.aria2`); control = true; } catch { /* New or legacy partial. */ }
    if (!control) {
      try {
        const partial = await stat(part);
        if (partial.size && !entry.etag && !entry.lastModified && !isImmutableEuclidQ1EasFile(entry)) throw new Error("部分文件缺少安全续传依据，已保留断点等待检查");
        entry.bytesPresent = partial.size;
        if (entry.expectedSizeBytes !== undefined && partial.size === entry.expectedSizeBytes) { await this.verify(entry, part, target); return; }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    entry.gid ??= createHash("sha256").update(`${job.id}:${entry.relativePath}`).digest("hex").slice(0, 16);
    delete entry.error; delete entry.lastErrorCode;
    await this.persist();
    await this.rpc("addUri", [[`http://127.0.0.1:${this.port}/files/${job.id}/${index}`], { gid: entry.gid,
      dir: path.dirname(target), out: `${path.basename(target)}.part`, header: [`Authorization: Bearer ${this.token}`],
      "auto-file-renaming": "false", "allow-overwrite": "false", "continue": "true", "always-resume": "true" }]);
    entry.status = entry.bytesPresent ? "partial" : "pending";
    entry.lastProgressAt ??= new Date().toISOString();
  }

  private async verify(entry: CoverageDownloadFileState, part: string, target: string): Promise<void> {
    entry.engineState = "verifying";
    const digest = await hashFile(part);
    if (entry.expectedSizeBytes !== undefined && digest.sizeBytes !== entry.expectedSizeBytes) throw new Error("文件大小校验失败，已保留下载数据");
    if (entry.expectedSha256 && digest.sha256 !== entry.expectedSha256) throw new Error("SHA-256 校验失败，已保留下载数据");
    if (part !== target) await rename(part, target);
    entry.status = "verified"; entry.engineState = "complete"; entry.bytesPresent = digest.sizeBytes;
    entry.actualSizeBytes = digest.sizeBytes; entry.actualSha256 = digest.sha256; entry.speedBytesPerSecond = 0;
    delete entry.error; delete entry.lastErrorCode; delete entry.nextRetryAt; delete entry.etaSeconds;
  }

  private permanent(entry: CoverageDownloadFileState, status: EngineStatus): boolean {
    if (entry.lastErrorCode?.startsWith("SOURCE_")) {
      return ["SOURCE_NOT_SCIENCE", "SOURCE_CHANGED", "SOURCE_RANGE_MISMATCH", "SOURCE_HTTP_400", "SOURCE_HTTP_401", "SOURCE_HTTP_403", "SOURCE_HTTP_404", "SOURCE_HTTP_410", "SOURCE_HTTP_412"].includes(entry.lastErrorCode);
    }
    // DNS failures, temporary overload and ambiguous HTTP errors can recover.
    return ["8", "9", "13", "16", "17", "18", "20", "23", "24", "25", "26", "27", "28", "30", "31", "32"].includes(status.errorCode ?? "");
  }

  private async tick(): Promise<void> {
    if (this.ticking || this.stopping) return;
    this.ticking = true;
    try {
      await this.rpc("getGlobalStat"); this.engineAvailable = true;
      for (const job of this.jobs.values()) {
        if (!["queued", "running"].includes(job.status) || job.phase === "paused") continue;
        job.status = "running"; job.phase = "downloading";
        for (let index = 0; index < job.transfer.length; index++) {
          const entry = job.transfer[index]!, key = `${job.id}:${index}`;
          if (entry.status === "verified" || entry.status === "failed" || this.verifying.has(key)) continue;
          if (entry.nextRetryAt && Date.parse(entry.nextRetryAt) > Date.now()) { job.phase = "retrying"; continue; }
          let engine: EngineStatus | undefined;
          if (entry.gid) try { engine = await this.rpc("tellStatus", [entry.gid, ["status", "completedLength", "totalLength", "downloadSpeed", "errorCode", "errorMessage"]]); } catch { /* Reconcile session or RPC result eviction. */ }
          if (!engine) {
            try { await this.prepare(job, entry, index); }
            catch (error) { entry.status = "failed"; entry.error = error instanceof Error ? error.message.slice(0, 300) : "下载初始化失败"; }
            continue;
          }
          entry.engineState = engine.status;
          const bytes = Number(engine.completedLength);
          if (bytes > entry.bytesPresent) { entry.lastProgressAt = new Date().toISOString(); entry.consecutiveFailures = 0; delete entry.nextRetryAt; }
          entry.bytesPresent = bytes; entry.speedBytesPerSecond = Number(engine.downloadSpeed);
          if (!entry.expectedSizeBytes && Number(engine.totalLength) > 0) entry.expectedSizeBytes = Number(engine.totalLength);
          entry.etaSeconds = entry.speedBytesPerSecond > 0 && entry.expectedSizeBytes ? Math.ceil((entry.expectedSizeBytes - bytes) / entry.speedBytesPerSecond) : undefined;
          if (bytes > 0) entry.status = "partial";
          if (engine.status === "complete") {
            job.phase = "verifying"; this.verifying.add(key);
            const target = await this.safeTarget(job.directory, entry.relativePath);
            // Hash large files concurrently with the scheduler; only one verifier owns each file.
            void this.verify(entry, `${target}.part`, target).catch(error => { entry.status = "failed"; entry.error = error instanceof Error ? error.message : "校验失败"; })
              .finally(() => { this.verifying.delete(key); void this.persist(); });
          } else if (engine.status === "error" || engine.status === "removed") {
            entry.error ??= `aria2 下载失败（${engine.errorCode ?? engine.status}）`;
            entry.lastErrorCode ??= `ARIA2_${engine.errorCode ?? engine.status}`;
            entry.speedBytesPerSecond = 0;
            if (this.permanent(entry, engine)) entry.status = "failed";
            else {
              entry.retryCount = (entry.retryCount ?? 0) + 1;
              entry.consecutiveFailures = (entry.consecutiveFailures ?? 0) + 1;
              entry.nextRetryAt = new Date(Date.now() + Math.min(300_000, 15_000 * 2 ** Math.min(5, entry.consecutiveFailures - 1))).toISOString();
              job.phase = "retrying";
            }
            await this.rpc("removeDownloadResult", [entry.gid]).catch(() => undefined);
            delete entry.gid;
          } else if (engine.status === "paused") {
            await this.rpc("unpause", [entry.gid]).catch(() => undefined);
          } else if (engine.status === "active" && entry.lastProgressAt && Date.now() - Date.parse(entry.lastProgressAt) > 300_000) job.phase = "waiting_network";
        }
        const unfinished = job.transfer.filter(e => e.status !== "verified" && e.status !== "failed");
        const failed = job.transfer.filter(e => e.status === "failed");
        if (!unfinished.length && ![...this.verifying].some(key => key.startsWith(`${job.id}:`))) {
          job.status = failed.length ? (job.transfer.some(e => e.status === "verified") ? "partial" : "failed") : "completed";
          job.phase = job.status;
          job.error = failed.length ? `${job.transfer.length - failed.length}/${job.transfer.length} 个文件已校验；${failed.length} 个文件需要处理` : undefined;
        } else if (this.config.enabled && this.health.status === "failed") job.phase = "waiting_network";
        job.updatedAt = new Date().toISOString();
      }
      await this.persist();
    } finally { this.ticking = false; }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const worker = new DownloadWorker(process.env.ASTRO_DOWNLOAD_STORAGE_ROOT ?? "/data/production", process.env.ASTRO_DOWNLOAD_WORKER_TOKEN ?? "", Number(process.env.PORT ?? 7080));
  void worker.initialize().catch(error => { console.error(error instanceof Error ? error.message : "下载服务启动失败"); process.exit(1); });
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => { void worker.close().finally(() => process.exit(0)); });
}
