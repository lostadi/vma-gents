function message(error) {
  return error instanceof Error ? error.message : String(error);
}

function requireFunction(name, value) {
  if (typeof value !== "function") throw new TypeError(`${name} must be a function`);
  return value;
}

function copyEvidence(value) {
  if (value === undefined) return undefined;
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

function defaultVerifyStopped(after, stopped) {
  if (stopped?.stopped !== true || after?.lifecycle?.running === true
    || after?.controllerLease?.held === true) {
    throw new Error("process-lifetime cleanup could not verify stopped state and lease release");
  }
}

export class ProcessLifetimeError extends Error {
  constructor(phase, error, evidence) {
    super(`process-lifetime VM failed during ${phase}: ${message(error)}`);
    this.name = "ProcessLifetimeError";
    this.phase = phase;
    this.cause = error;
    this.evidence = evidence;
  }
}

/**
 * Owns a VM for exactly one controller process lifetime.
 *
 * All authority remains in the injected functions. This class only coordinates
 * one warm-up, serialized resident operations, fail-closed cleanup, and one
 * controller shutdown.
 */
export class ProcessLifetimeSupervisor {
  constructor({
    start,
    waitForGuestReady,
    execute,
    stop,
    status,
    verifyStopped = defaultVerifyStopped,
    now = Date.now,
  }) {
    this.start = requireFunction("start", start);
    this.waitForGuestReady = requireFunction("waitForGuestReady", waitForGuestReady);
    this.execute = requireFunction("execute", execute);
    this.stop = requireFunction("stop", stop);
    this.status = requireFunction("status", status);
    this.verifyStopped = requireFunction("verifyStopped", verifyStopped);
    this.now = requireFunction("now", now);

    this.state = "cold";
    this.closing = false;
    this.warmPromise = null;
    this.cleanupPromise = null;
    this.shutdownPromise = null;
    this.operationTail = Promise.resolve();

    this.record = {
      mode: "process",
      warmAttempts: 0,
      startCalls: 0,
      operationAttempts: 0,
      operationSuccesses: 0,
      operationFailures: 0,
      cleanupAttempts: 0,
      shutdownAttempts: 0,
      warm: null,
      lastOperation: null,
      failure: null,
      cleanup: null,
      shutdown: null,
    };
  }

  snapshot() {
    return copyEvidence({
      ...this.record,
      state: this.state,
      closing: this.closing,
    });
  }

  terminalError(action) {
    return new ProcessLifetimeError(
      "state",
      new Error(`cannot ${action} process-lifetime VM while state is ${this.state}`),
      this.snapshot(),
    );
  }

  warm(signal) {
    if (this.closing || this.state === "stopped" || this.state === "failed") {
      return Promise.reject(this.terminalError("warm"));
    }
    if (this.warmPromise) return this.warmPromise;
    if (this.state !== "cold") return Promise.reject(this.terminalError("warm"));

    this.record.warmAttempts += 1;
    this.warmPromise = this.performWarm(signal);
    return this.warmPromise;
  }

  async performWarm(signal) {
    const startedAt = this.now();
    let phase = "start";
    this.state = "warming";

    try {
      signal?.throwIfAborted();
      this.record.startCalls += 1;
      const start = await this.start(signal);
      signal?.throwIfAborted();

      phase = "guest-ready";
      const readiness = await this.waitForGuestReady(signal);
      signal?.throwIfAborted();
      if (readiness?.guestReady !== true) {
        throw new Error("VM did not report guestReady=true");
      }

      const completedAt = this.now();
      this.record.warm = {
        startedAt,
        completedAt,
        durationMilliseconds: Math.max(0, completedAt - startedAt),
        start: copyEvidence(start),
        readiness: copyEvidence(readiness),
      };
      this.state = "warm";
      return this.snapshot();
    } catch (error) {
      this.record.failure = { phase, message: message(error), at: this.now() };
      this.state = "failing";
      let cleanupError = null;
      try {
        await this.ensureCleanup(`warm-${phase}-failed`);
      } catch (candidate) {
        cleanupError = candidate;
      }
      this.state = "failed";
      throw new ProcessLifetimeError(
        cleanupError ? `${phase} and cleanup` : phase,
        error,
        this.snapshot(),
      );
    }
  }

  run(input, signal) {
    if (this.closing || this.state === "stopped" || this.state === "failed") {
      return Promise.reject(this.terminalError("run an operation on"));
    }

    const pending = this.operationTail.then(async () => {
      if (this.closing || this.state === "stopped" || this.state === "failed") {
        throw this.terminalError("run an operation on");
      }
      await this.warm(signal);
      if (this.closing || this.state !== "warm") {
        throw this.terminalError("run an operation on");
      }

      const sequence = this.record.operationAttempts + 1;
      const startedAt = this.now();
      this.record.operationAttempts = sequence;
      try {
        signal?.throwIfAborted();
        const output = await this.execute(input, signal);
        signal?.throwIfAborted();
        const completedAt = this.now();
        this.record.operationSuccesses += 1;
        this.record.lastOperation = {
          sequence,
          succeeded: true,
          startedAt,
          completedAt,
          durationMilliseconds: Math.max(0, completedAt - startedAt),
        };
        return output;
      } catch (error) {
        const completedAt = this.now();
        this.record.operationFailures += 1;
        this.record.lastOperation = {
          sequence,
          succeeded: false,
          startedAt,
          completedAt,
          durationMilliseconds: Math.max(0, completedAt - startedAt),
          error: message(error),
        };
        this.record.failure = { phase: "operation", message: message(error), at: completedAt };
        this.state = "failing";
        let cleanupError = null;
        try {
          await this.ensureCleanup("operation-failed");
        } catch (candidate) {
          cleanupError = candidate;
        }
        this.state = "failed";
        throw new ProcessLifetimeError(
          cleanupError ? "operation and cleanup" : "operation",
          error,
          this.snapshot(),
        );
      }
    });

    this.operationTail = pending.then(() => undefined, () => undefined);
    return pending;
  }

  ensureCleanup(reason) {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.record.cleanupAttempts += 1;
    this.cleanupPromise = this.performCleanup(reason);
    return this.cleanupPromise;
  }

  async performCleanup(reason) {
    const startedAt = this.now();
    const cleanup = {
      reason,
      startedAt,
      completedAt: null,
      stop: null,
      after: null,
      verified: false,
      errors: [],
    };
    this.record.cleanup = cleanup;

    try {
      cleanup.stop = copyEvidence(await this.stop(reason));
    } catch (error) {
      cleanup.errors.push({ phase: "stop", message: message(error) });
    }

    try {
      cleanup.after = copyEvidence(await this.status());
    } catch (error) {
      cleanup.errors.push({ phase: "status", message: message(error) });
    }

    if (cleanup.after !== null) {
      try {
        await this.verifyStopped(cleanup.after, cleanup.stop);
        cleanup.verified = true;
      } catch (error) {
        cleanup.errors.push({ phase: "verify-stopped", message: message(error) });
      }
    }

    cleanup.completedAt = this.now();
    cleanup.durationMilliseconds = Math.max(0, cleanup.completedAt - startedAt);
    if (cleanup.errors.length > 0) {
      throw new AggregateError(
        cleanup.errors.map(({ message: errorMessage }) => new Error(errorMessage)),
        `process-lifetime cleanup failed: ${cleanup.errors.map(({ phase, message: errorMessage }) => `${phase}: ${errorMessage}`).join("; ")}`,
      );
    }
    return copyEvidence(cleanup);
  }

  shutdown(reason = "controller-exit") {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closing = true;
    this.record.shutdownAttempts += 1;
    this.shutdownPromise = this.performShutdown(reason);
    return this.shutdownPromise;
  }

  async performShutdown(reason) {
    const startedAt = this.now();
    this.record.shutdown = { reason, startedAt, completedAt: null, skipped: false };

    await this.operationTail;
    if (this.warmPromise) await this.warmPromise.catch(() => undefined);

    if (this.state === "cold") {
      this.state = "stopped";
      this.record.shutdown.skipped = true;
    } else if (this.cleanupPromise) {
      try {
        await this.cleanupPromise;
      } catch (error) {
        this.record.shutdown.completedAt = this.now();
        throw new ProcessLifetimeError("shutdown cleanup", error, this.snapshot());
      }
    } else {
      this.state = "shutting-down";
      try {
        await this.ensureCleanup(reason);
        this.state = "stopped";
      } catch (error) {
        this.state = "failed";
        this.record.failure = { phase: "shutdown", message: message(error), at: this.now() };
        this.record.shutdown.completedAt = this.now();
        throw new ProcessLifetimeError("shutdown", error, this.snapshot());
      }
    }

    this.record.shutdown.completedAt = this.now();
    this.record.shutdown.durationMilliseconds = Math.max(
      0,
      this.record.shutdown.completedAt - startedAt,
    );
    return this.snapshot();
  }
}
