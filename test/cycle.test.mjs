import test from "node:test";
import assert from "node:assert/strict";
import { assertCycleStartable, runLifecycleCycle } from "../src/cycle.mjs";

test("lifecycle cycle serializes start, inspect, and guaranteed stop", async () => {
  const calls = [];
  const result = await runLifecycleCycle({
    start: async () => { calls.push("start"); return { started: true }; },
    status: async () => {
      calls.push("status");
      return calls.includes("stop") ? { lifecycle: { state: "stopped" } } : { lifecycle: { state: "running" } };
    },
    readConsole: async () => { calls.push("console"); return { text: "ready" }; },
    stop: async () => { calls.push("stop"); return { stopped: true }; },
    settleMilliseconds: 0,
  });
  assert.deepEqual(calls, ["start", "status", "console", "stop", "status"]);
  assert.equal(result.completed, true);
  assert.equal(result.after.lifecycle.state, "stopped");
});

test("lifecycle cycle stops after an inspection failure", async () => {
  const calls = [];
  await assert.rejects(
    () => runLifecycleCycle({
      start: async () => { calls.push("start"); return { started: true }; },
      status: async () => { calls.push("status"); return { lifecycle: { state: "running" } }; },
      readConsole: async () => { calls.push("console"); throw new Error("console failed"); },
      stop: async () => { calls.push("stop"); return { stopped: true }; },
      settleMilliseconds: 0,
    }),
    (error) => {
      assert.match(error.message, /console failed/);
      assert.equal(error.evidence.stop.stopped, true);
      return true;
    },
  );
  assert.deepEqual(calls, ["start", "status", "console", "stop", "status"]);
});

test("lifecycle cycle reports stop failure and retains cleanup evidence", async () => {
  await assert.rejects(
    () => runLifecycleCycle({
      start: async () => ({ started: true }),
      status: async () => ({ lifecycle: { state: "running" } }),
      readConsole: async () => ({ text: "ready" }),
      stop: async () => { throw new Error("stop uncertain"); },
      settleMilliseconds: 0,
    }),
    (error) => {
      assert.match(error.message, /stop uncertain/);
      assert.equal(error.evidence.cleanupError, "stop uncertain");
      return true;
    },
  );
});

test("lifecycle cycle converts cancellation into cleanup before rejecting", async () => {
  const calls = [];
  const controller = new AbortController();
  await assert.rejects(
    () => runLifecycleCycle({
      signal: controller.signal,
      start: async () => {
        calls.push("start");
        controller.abort(new Error("caller canceled"));
        return { started: true };
      },
      status: async () => { calls.push("status"); return { lifecycle: { running: false } }; },
      readConsole: async () => { calls.push("console"); return { text: "unreachable" }; },
      stop: async () => { calls.push("stop"); return { stopped: true }; },
      settleMilliseconds: 0,
    }),
    (error) => {
      assert.match(error.message, /caller canceled/);
      assert.equal(error.evidence.stop.stopped, true);
      return true;
    },
  );
  assert.deepEqual(calls, ["start", "stop", "status"]);
});

test("lifecycle cycle rejects a false stopped-state report", async () => {
  await assert.rejects(
    () => runLifecycleCycle({
      start: async () => ({ started: true }),
      status: async () => ({ lifecycle: { running: true }, controllerLease: { held: true } }),
      readConsole: async () => ({ text: "ready" }),
      stop: async () => ({ stopped: true }),
      verifyStopped: async (after) => {
        if (after.lifecycle.running || after.controllerLease.held) throw new Error("still active");
      },
      settleMilliseconds: 0,
    }),
    /still active/,
  );
});

test("lifecycle cycle refuses to adopt an existing run or lease", () => {
  assert.throws(
    () => assertCycleStartable({ lifecycle: { running: true }, controllerLease: { held: true } }),
    /will not adopt/,
  );
  assert.throws(
    () => assertCycleStartable({ lifecycle: { running: false }, controllerLease: { held: true } }),
    /will not adopt/,
  );
  assert.doesNotThrow(
    () => assertCycleStartable({ lifecycle: { running: false }, controllerLease: { held: false } }),
  );
});
