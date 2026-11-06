import type { LocalState } from "./local-state.js";

export interface ScanningState { paused: boolean; updatedAt: string; reason?: string }

export class ScansPausedError extends Error {
  readonly statusCode = 409;
  constructor() { super("扫描已暂停，请先恢复扫描后再提交任务"); }
}

/** Every producer and worker checks the same durable switch. Restart never resumes it. */
export class ScanControl {
  constructor(readonly state: LocalState, readonly initialPaused = true) {}
  view(): ScanningState {
    return this.state.get<ScanningState>("scanning", "control")
      ?? { paused: this.initialPaused, updatedAt: new Date().toISOString() };
  }
  setPaused(paused: boolean, reason?: string): ScanningState {
    const record = { paused, updatedAt: new Date().toISOString(), ...(reason ? { reason } : {}) };
    this.state.put("scanning", "control", record);
    return record;
  }
  assertRunning(): void { if (this.view().paused) throw new ScansPausedError(); }
}
