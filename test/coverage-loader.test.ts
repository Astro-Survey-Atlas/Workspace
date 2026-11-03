import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";

import { CoverageLoader, type CoverageLoadPhase } from "../viewer/src/coverage-loader.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(keys: string[]) {
  const calls: Array<{ key: string; signal: AbortSignal; result: ReturnType<typeof deferred<string>> }> = [];
  const changes: Array<{ key: string; phase: CoverageLoadPhase; value?: string }> = [];
  const loader = new CoverageLoader(keys, (key, signal) => {
    const result = deferred<string>();
    calls.push({ key, signal, result });
    return result.promise;
  }, (key, phase, value) => changes.push({ key, phase, value }));
  return { loader, calls, changes };
}

test("selected coverage has two slots; background waits for selection and a paint opportunity", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { loader, calls } = fixture(["background-a", "selected-a", "selected-b", "selected-c", "background-b"]);
  t.after(() => loader.dispose());
  loader.setSelected(["selected-a", "selected-b", "selected-c"]);
  await setImmediate();
  assert.deepEqual(calls.map(call => call.key), ["selected-a", "selected-b"]);
  calls[0]!.result.resolve("a");
  await setImmediate();
  assert.deepEqual(calls.map(call => call.key), ["selected-a", "selected-b", "selected-c"]);
  calls[1]!.result.resolve("b");
  calls[2]!.result.resolve("c");
  await loader.settled();
  await setImmediate();
  assert.equal(calls.length, 3, "finished selection must be paintable before background starts");
  t.mock.timers.tick(32);
  await setImmediate();
  assert.equal(calls[3]!.key, "background-a");
  t.mock.timers.tick(500);
  await setImmediate();
  assert.equal(calls.length, 4, "only one background job can run");
  calls[3]!.result.resolve("background");
  await setImmediate();
  t.mock.timers.tick(32);
  await setImmediate();
  assert.equal(calls[4]!.key, "background-b");
});

test("newly selected coverage aborts background work and ignores its late response", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { loader, calls, changes } = fixture(["background", "selected"]);
  t.after(() => loader.dispose());
  loader.setSelected([]);
  t.mock.timers.tick(32);
  await setImmediate();
  const old = calls[0]!;
  assert.equal(old.key, "background");
  loader.setSelected(["selected"]);
  await setImmediate();
  assert.equal(old.signal.aborted, true);
  assert.equal(calls[1]!.key, "selected");
  old.result.resolve("obsolete geometry");
  calls[1]!.result.resolve("selected geometry");
  await loader.settled();
  await setImmediate();
  assert.equal(changes.some(change => change.value === "obsolete geometry"), false);
  assert.equal(loader.phase("background"), "queued");
  t.mock.timers.tick(32);
  await setImmediate();
  assert.equal(calls[2]!.key, "background");
  assert.notEqual(calls[2]!.signal, old.signal);
});

test("failed selected geometry can be retried without reloading completed geometry", async t => {
  const { loader, calls } = fixture(["ready", "failed"]);
  t.after(() => loader.dispose());
  loader.setSelected(["ready", "failed"]);
  await setImmediate();
  calls[0]!.result.resolve("ready");
  calls[1]!.result.reject(new Error("temporary failure"));
  await loader.settled();
  assert.deepEqual(loader.failedSelected(), ["failed"]);
  loader.retry();
  await setImmediate();
  assert.deepEqual(calls.map(call => call.key), ["ready", "failed", "failed"]);
  calls[2]!.result.resolve("recovered");
  await loader.settled();
  assert.deepEqual(loader.failedSelected(), []);
});

test("leaving coverage aborts active requests, releases waiters and suppresses later updates", async () => {
  const { loader, calls, changes } = fixture(["a", "b", "queued"]);
  loader.setSelected(["a", "b", "queued"]);
  const settled = loader.settled();
  await setImmediate();
  loader.dispose();
  await settled;
  assert.equal(calls.every(call => call.signal.aborted), true);
  const before = changes.length;
  calls.forEach(call => call.result.resolve("late"));
  await setImmediate();
  assert.equal(changes.length, before);
  assert.equal(calls.length, 2);
});

test("completed cached geometry does not occupy a foreground request slot", async t => {
  const calls: string[] = [];
  const loader = new CoverageLoader(["cached", "new"], async key => { calls.push(key); return key; }, () => {}, new Map([["cached", "value"]]));
  t.after(() => loader.dispose());
  loader.setSelected(["cached", "new"]);
  await loader.settled();
  assert.deepEqual(calls, ["new"]);
  assert.equal(loader.phase("cached"), "ready");
});
