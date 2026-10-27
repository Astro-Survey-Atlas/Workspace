import { Worker } from "node:worker_threads";
import type { ConnectorIngestRunRecord } from "./connector-history.js";
import type { DataStatisticsView, StatisticsRefresh } from "./data-statistics-types.js";

/** HTTP handlers consume a small published view; SQLite and enumeration run off-thread. */
export class DataStatisticsClient {
  #worker?: Worker;
  #view?: DataStatisticsView;
  #sequence = 0;
  #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  #starting?: Promise<void>;
  constructor(readonly options: { root: string; workspaceScanRoot: string; evidenceRoot: string }) {}
  get busy(): boolean { return this.#view?.refresh?.status === "running"; }

  async initialize(): Promise<void> {
    this.#starting ??= this.#start();
    await this.#starting;
  }
  async #start(): Promise<void> {
    const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
    const entry = new URL(`./data-statistics-worker.${extension}`, import.meta.url);
    const worker = extension === "ts"
      ? new Worker('const { workerData } = require("node:worker_threads"); import("tsx/esm/api").then(({ tsImport }) => tsImport(workerData.entry, workerData.entry));',
        { eval: true, workerData: { ...this.options, entry: entry.href } })
      : new Worker(entry, { workerData: this.options });
    this.#worker = worker;
    worker.on("message", (message: { id?: number; value?: unknown; error?: string; view?: DataStatisticsView }) => {
      if (message.view) this.#view = message.view;
      if (message.id === undefined) return;
      const pending = this.#pending.get(message.id);
      this.#pending.delete(message.id);
      if (message.error) pending?.reject(new Error(message.error)); else pending?.resolve(message.value);
    });
    worker.on("error", error => { for (const pending of this.#pending.values()) pending.reject(error); this.#pending.clear(); });
    worker.on("exit", code => {
      if (this.#worker !== worker) return;
      this.#worker = undefined; this.#starting = undefined;
      for (const pending of this.#pending.values()) pending.reject(new Error(`Statistics worker exited (${code})`));
      this.#pending.clear();
    });
    this.#view = await this.#call<DataStatisticsView>("view");
  }
  #call<T>(method: "view" | "refresh" | "sync", connectorIds?: string[]): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = ++this.#sequence;
      this.#pending.set(id, { resolve: value => resolve(value as T), reject });
      this.#worker!.postMessage({ id, method, connectorIds });
    });
  }
  async view(): Promise<DataStatisticsView> { await this.initialize(); return structuredClone(this.#view!); }
  async refresh(connectorIds?: string[]): Promise<StatisticsRefresh> { await this.initialize(); return this.#call("refresh", connectorIds); }
  async recordScan(_run: ConnectorIngestRunRecord, _files?: unknown[]): Promise<void> {
    await this.initialize(); await this.#call("sync");
  }
  async close(): Promise<void> { const worker = this.#worker; this.#worker = undefined; await worker?.terminate(); }
}
