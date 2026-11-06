import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LocalState } from "../src/local-state.js";
import { ScanControl, ScansPausedError } from "../src/scan-control.js";

test("scan pause survives restart and is visible to a separate worker connection", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workspace-scan-control-"));
  const api = new LocalState(path.join(root, "workspace.sqlite"));
  const worker = new LocalState(api.filename);
  try {
    await api.initialize(); await worker.initialize();
    const control = new ScanControl(api), workerControl = new ScanControl(worker);
    assert.throws(() => workerControl.assertRunning(), ScansPausedError);
    control.setPaused(false);
    workerControl.assertRunning();
    control.setPaused(true, "maintenance");
    assert.throws(() => workerControl.assertRunning(), ScansPausedError);
    api.close();
    const restarted = new LocalState(worker.filename);
    await restarted.initialize();
    try {
      const afterRestart = new ScanControl(restarted, false);
      assert.equal(afterRestart.view().reason, "maintenance");
      assert.throws(() => afterRestart.assertRunning(), ScansPausedError);
    } finally { restarted.close(); }
  } finally { api.close(); worker.close(); await rm(root, { recursive: true, force: true }); }
});
