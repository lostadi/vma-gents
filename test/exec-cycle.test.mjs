import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { guestReadinessEvidence, runGuestExecCycle, SwiftVM } from "../src/swift-vm.mjs";

function fakeVM() {
  return new SwiftVM({
    bundlePath: "/unused",
    runnerPath: "/unused",
    smolPath: "/unused",
    sharePath: "/unused",
    memoryGB: 4,
    cpuCount: 4,
    networkMode: "isolated",
    startupTimeoutSeconds: 1,
  });
}

function processSpec(id = randomUUID()) {
  return {
    id,
    name: "uname",
    command: "/usr/bin/uname",
    args: ["-m"],
    cwd: "/",
    env: {
      HOME: "/nonexistent",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
    },
  };
}

test("guest execution cycle waits for guestReady, executes once, and verifies cleanup", async () => {
  const calls = [];
  const result = await runGuestExecCycle({
    start: async () => { calls.push("start"); return { started: true }; },
    waitForGuestReady: async () => { calls.push("ready"); return { guestReady: true, coworkReady: true, guestBootstrapReady: true }; },
    execute: async () => {
      calls.push("exec");
      return { processId: "p1", stdout: "arm64\n", stderr: "", exitCode: 0 };
    },
    stop: async (reason) => { calls.push(`stop:${reason}`); return { stopped: true, leaseReleased: true }; },
    status: async () => {
      calls.push("status");
      return { lifecycle: { running: false }, controllerLease: { held: false } };
    },
    verifyStopped: (after, stopped) => {
      assert.equal(stopped.stopped, true);
      assert.equal(after.lifecycle.running, false);
      assert.equal(after.controllerLease.held, false);
    },
  });
  assert.deepEqual(calls, ["start", "ready", "exec", "stop:mcp-exec-cycle-finally", "status"]);
  assert.equal(result.completed, true);
  assert.deepEqual(guestReadinessEvidence(result.readiness), { guestReady: true, coworkReady: true, guestBootstrapReady: true });
  assert.equal(result.execution.stdout, "arm64\n");
});

test("guest readiness receipts preserve independent bootstrap evidence without inferring missing fields", () => {
  assert.deepEqual(guestReadinessEvidence({ guestReady: true }), {
    guestReady: true, coworkReady: false, guestBootstrapReady: false,
  });
  assert.deepEqual(guestReadinessEvidence({ guestReady: false, coworkReady: true, guestBootstrapReady: false }), {
    guestReady: false, coworkReady: true, guestBootstrapReady: false,
  });
  assert.deepEqual(guestReadinessEvidence({ guestReady: "true", coworkReady: 1, guestBootstrapReady: "true" }), {
    guestReady: false, coworkReady: false, guestBootstrapReady: false,
  });
});

test("caller cancellation during guest exec still stops and verifies the lease", async () => {
  const controller = new AbortController();
  const calls = [];
  await assert.rejects(
    () => runGuestExecCycle({
      signal: controller.signal,
      start: async () => { calls.push("start"); return { started: true }; },
      waitForGuestReady: async () => { calls.push("ready"); return { guestReady: true }; },
      execute: async (signal) => {
        calls.push("exec");
        controller.abort(new Error("caller canceled exec"));
        signal.throwIfAborted();
      },
      stop: async () => { calls.push("stop"); return { stopped: true, leaseReleased: true }; },
      status: async () => {
        calls.push("status");
        return { lifecycle: { running: false }, controllerLease: { held: false } };
      },
      verifyStopped: (after) => {
        assert.equal(after.lifecycle.running, false);
        assert.equal(after.controllerLease.held, false);
      },
    }),
    (error) => {
      assert.match(error.message, /caller canceled exec/);
      assert.equal(error.evidence.stop.stopped, true);
      assert.equal(error.evidence.after.controllerLease.held, false);
      return true;
    },
  );
  assert.deepEqual(calls, ["start", "ready", "exec", "stop", "status"]);
});

test("cleanup failure still runs the final stopped-state and lease check", async () => {
  const calls = [];
  await assert.rejects(
    () => runGuestExecCycle({
      start: async () => ({ started: true }),
      waitForGuestReady: async () => ({ guestReady: true }),
      execute: async () => ({ exitCode: 0 }),
      stop: async () => { calls.push("stop"); throw new Error("stop failed"); },
      status: async () => {
        calls.push("status");
        return { lifecycle: { running: true }, controllerLease: { held: true } };
      },
      verifyStopped: (after) => {
        calls.push("verify");
        if (after.lifecycle.running || after.controllerLease.held) throw new Error("lease remains active");
      },
    }),
    (error) => {
      assert.match(error.message, /stop failed/);
      assert.equal(error.evidence.cleanupError, "stop failed");
      assert.equal(error.evidence.verificationError, "lease remains active");
      return true;
    },
  );
  assert.deepEqual(calls, ["stop", "status", "verify"]);
});

test("guestReady polling requires the real readiness bit, not only vsock", async () => {
  const vm = fakeVM();
  vm.child = { pid: 1, exitCode: null, signalCode: null };
  const statuses = [
    { event: "status", running: true, vsockConnected: true, guestReady: false },
    { event: "status", running: true, vsockConnected: true, guestReady: true },
  ];
  vm.request = async (command) => {
    assert.equal(command, "status");
    return statuses.shift();
  };
  const ready = await vm.waitForGuestReady(undefined, 1_000);
  assert.equal(ready.guestReady, true);
  assert.equal(statuses.length, 0);
});

test("Swift exec sends direct process fields and validates its terminal result", async () => {
  const vm = fakeVM();
  const spec = processSpec();
  let captured;
  vm.request = async (command, extra, timeoutMilliseconds, signal, requestId) => {
    captured = { command, extra, timeoutMilliseconds, signal, requestId };
    vm.record({ event: "stdout", requestId, processId: spec.id, data: "arm64\n" });
    return {
      event: "exec_result",
      requestId,
      processId: spec.id,
      stdout: "arm64\n",
      stderr: "",
      exitCode: 0,
      signal: null,
      truncated: false,
    };
  };
  const result = await vm.exec(spec, { timeoutMilliseconds: 5_000, maximumOutputBytes: 32 * 1024 });
  assert.equal(captured.command, "exec");
  assert.deepEqual(captured.extra, { process: spec });
  assert.equal(captured.timeoutMilliseconds, 5_000);
  assert.equal(result.stdout, "arm64\n");
  assert.deepEqual(result.outputBytes, { stdout: 6, stderr: 0, total: 6, limit: 32 * 1024, streamed: 6 });
});

test("Swift exec aborts a forged stream as soon as aggregate output crosses the cap", async () => {
  const vm = fakeVM();
  const spec = processSpec();
  vm.request = async (_command, _extra, _timeoutMilliseconds, signal, requestId) => {
    vm.record({ event: "stdout", requestId, processId: spec.id, data: "x".repeat(17) });
    vm.record({ event: "stderr", requestId, processId: spec.id, data: "y".repeat(16) });
    signal.throwIfAborted();
  };
  await assert.rejects(
    () => vm.exec(spec, { timeoutMilliseconds: 1_000, maximumOutputBytes: 32 }),
    /guest output exceeded the 32-byte limit/,
  );
  assert.equal(vm.listeners.size, 0);
});
