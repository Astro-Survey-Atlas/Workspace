export type CoverageLoadPhase = "queued" | "loading" | "ready" | "error";

interface Entry<T> {
  phase: CoverageLoadPhase;
  value?: T;
  error?: string;
  controller?: AbortController;
}

/** Load selected coverage first, yielding to the browser before background work.
 * Aborted jobs return to the queue; their late results can never update the UI.
 */
export class CoverageLoader<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private selected = new Set<string>();
  private disposed = false;
  private backgroundTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly waiters = new Set<() => void>();

  constructor(
    keys: readonly string[],
    private readonly load: (key: string, signal: AbortSignal) => Promise<T>,
    private readonly changed: (key: string, phase: CoverageLoadPhase, value?: T, error?: string) => void,
    cached: ReadonlyMap<string, T> = new Map(),
  ) {
    for (const key of keys) this.entries.set(key, cached.has(key)
      ? { phase: "ready", value: cached.get(key) } : { phase: "queued" });
  }

  phase(key: string): CoverageLoadPhase { return this.entries.get(key)?.phase ?? "queued"; }

  setSelected(keys: Iterable<string>): void {
    if (this.disposed) return;
    const next = new Set([...keys].filter(key => this.entries.has(key)));
    for (const key of next) {
      const entry = this.entries.get(key)!;
      if (!this.selected.has(key) && entry.phase === "error") entry.phase = "queued";
    }
    this.selected = next;
    if (this.pendingSelected().length) {
      for (const [key, entry] of this.entries) if (entry.controller && !next.has(key)) {
        const controller = entry.controller;
        delete entry.controller;
        entry.phase = "queued";
        controller.abort();
        this.changed(key, "queued");
      }
    }
    if (this.backgroundTimer) clearTimeout(this.backgroundTimer);
    this.backgroundTimer = undefined;
    this.pump();
  }

  pendingSelected(): string[] {
    return [...this.selected].filter(key => ["queued", "loading"].includes(this.phase(key)));
  }

  failedSelected(): string[] { return [...this.selected].filter(key => this.phase(key) === "error"); }

  retry(): void {
    for (const key of this.failedSelected()) this.entries.get(key)!.phase = "queued";
    this.setSelected(this.selected);
  }

  settled(): Promise<void> {
    if (this.disposed || !this.pendingSelected().length) return Promise.resolve();
    return new Promise(resolve => this.waiters.add(resolve));
  }

  private pump(): void {
    if (this.disposed) return;
    let foreground = [...this.entries].filter(([key, entry]) => this.selected.has(key) && entry.controller).length;
    for (const key of this.pendingSelected()) {
      if (foreground >= 2) break;
      if (this.phase(key) === "queued") { foreground += 1; this.start(key); }
    }
    if (this.pendingSelected().length) return;
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
    if ([...this.entries.values()].some(entry => entry.controller) || this.backgroundTimer) return;
    const background = [...this.entries].find(([key, entry]) => !this.selected.has(key) && entry.phase === "queued");
    if (!background) return;
    this.backgroundTimer = setTimeout(() => {
      this.backgroundTimer = undefined;
      if (!this.disposed && !this.pendingSelected().length && this.phase(background[0]) === "queued") this.start(background[0]);
    }, 32);
  }

  private start(key: string): void {
    const entry = this.entries.get(key)!;
    const controller = new AbortController();
    entry.controller = controller;
    entry.phase = "loading";
    this.changed(key, "loading");
    Promise.resolve().then(() => this.load(key, controller.signal)).then(value => {
      if (this.disposed || controller.signal.aborted || entry.controller !== controller) return;
      entry.phase = "ready";
      entry.value = value;
      delete entry.error;
      this.changed(key, "ready", value);
    }, (error: unknown) => {
      if (this.disposed || controller.signal.aborted || entry.controller !== controller) return;
      entry.phase = "error";
      entry.error = error instanceof Error ? error.message : String(error);
      this.changed(key, "error", undefined, entry.error);
    }).finally(() => {
      if (entry.controller !== controller) return;
      delete entry.controller;
      this.pump();
    });
  }

  dispose(): void {
    this.disposed = true;
    if (this.backgroundTimer) clearTimeout(this.backgroundTimer);
    for (const entry of this.entries.values()) entry.controller?.abort();
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }
}
