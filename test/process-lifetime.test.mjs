import test from "node:test";
import assert from "node:assert/strict";
import {
  ProcessLifetimeError,
  ProcessLifetimeSupervisor,
} from "../src/process-lifetime.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function fakeClock() {
  let time = 0;
  return () => {
    time += 10;
    return time;
  };
}

function makeSupervisor(overrides = {}) {
  return new ProcessLifetimeSupervisor({
    start: async () => ({ started: true, lifecycle: { running: true } }),
    waitForGuestReady: async () => ({ running: true, guestReady: true }),
    execute: async (input) => input,
    stop: async () => ({ stopped: true, leaseReleased: true }),
    status: async () => ({
      lifecycle: { running: false },
      controllerLease: { held: false },
    }),
    verifyStopped: (after, stopped) => {
      assert.equal(stopped.stopped, true);
      assert.equal(after.lifecycle.running, false);
      assert.equal(after.controllerLease.held, false);
    },
    now: fakeClock(),
    ...overrides,
  });
}

test("concurrent warm requests share one start and require guestReady", async () => {
  const startGate = deferred();
  let starts = 0;
  let readinessChecks = 0;
  const supervisor = makeSupervisor({
    start: async () => {
      starts += 1;
      await startGate.promise;
      return { started: true, runnerPid: 101 };
    },
    waitForGuestReady: async () => {
      readinessChecks += 1;
      return { running: true, vsockConnected: true, guestReady: true };
    },
  });

  const first = supervisor.warm();
  const second = supervisor.warm();
  assert.strictEqual(first, second);
  startGate.resolve();
  const [left, right] = await Promise.all([first, second]);

  assert.deepEqual(left, right);
  assert.equal(starts, 1);
  assert.equal(readinessChecks, 1);
  assert.equal(left.state, "warm");
  assert.equal(left.warmAttempts, 1);
  assert.equal(left.startCalls, 1);
  assert.equal(left.warm.readiness.guestReady, true);
  assert.deepEqual(await supervisor.warm(), left);
});

test("resident operations reuse one warm VM, serialize, and stop once on shutdown", async () => {
  let starts = 0;
  let active = 0;
  let maximumActive = 0;
  let stops = 0;
  let statuses = 0;
  let verifications = 0;
  const supervisor = makeSupervisor({
    start: async () => { starts += 1; return { started: true, runnerPid: 202 }; },
    execute: async (input) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return input * 2;
    },
    stop: async (reason) => {
      stops += 1;
      return { stopped: true, leaseReleased: true, reason };
    },
    status: async () => {
      statuses += 1;
      return { lifecycle: { running: false }, controllerLease: { held: false } };
    },
    verifyStopped: (after, stopped) => {
      verifications += 1;
      assert.equal(stopped.stopped, true);
      assert.equal(after.lifecycle.running, false);
      assert.equal(after.controllerLease.held, false);
    },
  });

  assert.deepEqual(await Promise.all([
    supervisor.run(1),
    supervisor.run(2),
    supervisor.run(3),
  ]), [2, 4, 6]);
  assert.equal(starts, 1);
  assert.equal(maximumActive, 1);
  assert.equal(stops, 0);

  const firstShutdown = supervisor.shutdown("stdin-end");
  const secondShutdown = supervisor.shutdown("SIGTERM");
  assert.strictEqual(firstShutdown, secondShutdown);
  const stopped = await firstShutdown;
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.operationAttempts, 3);
  assert.equal(stopped.operationSuccesses, 3);
  assert.equal(stopped.cleanupAttempts, 1);
  assert.equal(stopped.shutdownAttempts, 1);
  assert.equal(stopped.cleanup.reason, "stdin-end");
  assert.equal(stops, 1);
  assert.equal(statuses, 1);
  assert.equal(verifications, 1);
  await assert.rejects(() => supervisor.run(4), /state is stopped/);
});

test("operation failure cleans up once, becomes terminal, and never rewarms", async () => {
  let starts = 0;
  let executions = 0;
  let stops = 0;
  const supervisor = makeSupervisor({
    start: async () => { starts += 1; return { started: true }; },
    execute: async () => { executions += 1; throw new Error("guest protocol failed"); },
    stop: async () => { stops += 1; return { stopped: true, leaseReleased: true }; },
  });

  await assert.rejects(
    () => supervisor.run({ program: "uname" }),
    (error) => {
      assert.ok(error instanceof ProcessLifetimeError);
      assert.equal(error.phase, "operation");
      assert.match(error.message, /guest protocol failed/);
      assert.equal(error.evidence.state, "failed");
      assert.equal(error.evidence.operationFailures, 1);
      assert.equal(error.evidence.cleanup.verified, true);
      return true;
    },
  );

  assert.equal(starts, 1);
  assert.equal(executions, 1);
  assert.equal(stops, 1);
  await assert.rejects(() => supervisor.warm(), /state is failed/);
  await assert.rejects(() => supervisor.run({ program: "uname" }), /state is failed/);
  const afterShutdown = await supervisor.shutdown("stdin-end");
  assert.equal(afterShutdown.state, "failed");
  assert.equal(stops, 1);
});

test("false guest readiness fails closed before any resident operation", async () => {
  let executions = 0;
  let stops = 0;
  const supervisor = makeSupervisor({
    waitForGuestReady: async () => ({
      running: true,
      vsockConnected: true,
      guestReady: false,
    }),
    execute: async () => { executions += 1; },
    stop: async () => { stops += 1; return { stopped: true, leaseReleased: true }; },
  });

  await assert.rejects(
    () => supervisor.warm(),
    (error) => {
      assert.ok(error instanceof ProcessLifetimeError);
      assert.equal(error.phase, "guest-ready");
      assert.equal(error.evidence.state, "failed");
      assert.equal(error.evidence.cleanup.verified, true);
      return true;
    },
  );
  assert.equal(executions, 0);
  assert.equal(stops, 1);
});

test("cleanup collects stop and verification failures without retrying authority", async () => {
  let stops = 0;
  let statuses = 0;
  const supervisor = makeSupervisor({
    execute: async () => { throw new Error("operation canceled"); },
    stop: async () => { stops += 1; throw new Error("stop uncertain"); },
    status: async () => {
      statuses += 1;
      return { lifecycle: { running: true }, controllerLease: { held: true } };
    },
    verifyStopped: () => { throw new Error("lease remains active"); },
  });

  await assert.rejects(
    () => supervisor.run("diagnostic"),
    (error) => {
      assert.ok(error instanceof ProcessLifetimeError);
      assert.equal(error.phase, "operation and cleanup");
      assert.match(error.message, /operation canceled/);
      assert.equal(error.evidence.state, "failed");
      assert.equal(error.evidence.cleanup.verified, false);
      assert.deepEqual(
        error.evidence.cleanup.errors.map(({ phase }) => phase),
        ["stop", "verify-stopped"],
      );
      return true;
    },
  );
  assert.equal(stops, 1);
  assert.equal(statuses, 1);
  await assert.rejects(() => supervisor.shutdown("SIGTERM"), /shutdown cleanup/);
  assert.equal(stops, 1);
  assert.equal(statuses, 1);
});

test("shutdown waits for an in-flight resident operation before cleanup", async () => {
  const operationGate = deferred();
  const operationStarted = deferred();
  let stops = 0;
  const supervisor = makeSupervisor({
    execute: async () => {
      operationStarted.resolve();
      await operationGate.promise;
      return "complete";
    },
    stop: async () => { stops += 1; return { stopped: true, leaseReleased: true }; },
  });

  const running = supervisor.run("work");
  await operationStarted.promise;
  const shuttingDown = supervisor.shutdown("stdin-end");
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(stops, 0);
  await assert.rejects(() => supervisor.run("late"), /state is warm/);
  operationGate.resolve();
  assert.equal(await running, "complete");
  assert.equal((await shuttingDown).state, "stopped");
  assert.equal(stops, 1);
});

test("shutdown before warm is an idempotent no-op", async () => {
  let starts = 0;
  let stops = 0;
  const supervisor = makeSupervisor({
    start: async () => { starts += 1; return { started: true }; },
    stop: async () => { stops += 1; return { stopped: true }; },
  });

  const first = supervisor.shutdown("stdin-end");
  const second = supervisor.shutdown("SIGTERM");
  assert.strictEqual(first, second);
  const evidence = await first;
  assert.equal(evidence.state, "stopped");
  assert.equal(evidence.shutdown.skipped, true);
  assert.equal(evidence.shutdownAttempts, 1);
  assert.equal(starts, 0);
  assert.equal(stops, 0);
});
