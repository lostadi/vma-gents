import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

const HARD_MAXIMUM_EXEC_OUTPUT_BYTES = 32 * 1024;
const HARD_MAXIMUM_RUNNER_FRAME_BYTES = 128 * 1024;
const GUEST_EXECUTABLE = /^\/(?:bin|usr\/(?:local\/)?bin)\/[A-Za-z0-9._+-]+$/;
const PROCESS_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROCESS_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const FIXED_GUEST_ENV = Object.freeze({
  HOME: "/nonexistent",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
});

function messageFromEvent(event) {
  return event?.message ?? event?.reason ?? event?.error ?? JSON.stringify(event);
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}

function abortableDelay(milliseconds, signal) {
  if (milliseconds <= 0) return Promise.resolve();
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    const onAbort = () => fail(signal.reason ?? new Error("operation aborted"));
    function cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    function done() { cleanup(); resolve(); }
    function fail(error) { cleanup(); reject(error); }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function validateGuestProcess(processSpec) {
  if (!processSpec || typeof processSpec !== "object" || Array.isArray(processSpec)) {
    throw new Error("guest process must be an object");
  }
  const allowedKeys = new Set(["id", "name", "command", "args", "cwd", "env"]);
  if (Object.keys(processSpec).some((key) => !allowedKeys.has(key))) {
    throw new Error("guest process contains an unsupported field");
  }
  if (!PROCESS_ID.test(processSpec.id)) throw new Error("guest process id must be a UUID");
  if (!PROCESS_NAME.test(processSpec.name)) throw new Error("guest process name is invalid");
  if (!GUEST_EXECUTABLE.test(processSpec.command)) {
    throw new Error("guest process command must be a fixed absolute executable path");
  }
  if (!Array.isArray(processSpec.args) || processSpec.args.length > 8) {
    throw new Error("guest process args must contain at most 8 entries");
  }
  let argumentBytes = 0;
  for (const arg of processSpec.args) {
    if (typeof arg !== "string" || arg.length > 256 || arg.includes("\0")) {
      throw new Error("guest process args must be NUL-free strings of at most 256 characters");
    }
    argumentBytes += Buffer.byteLength(arg, "utf8") + 1;
  }
  if (argumentBytes > 1024) throw new Error("guest process args exceed 1024 UTF-8 bytes");
  if (processSpec.cwd !== "/") throw new Error("guest process cwd must be the fixed root directory");
  if (!processSpec.env || typeof processSpec.env !== "object" || Array.isArray(processSpec.env)) {
    throw new Error("guest process env must be the fixed minimal environment");
  }
  const envKeys = Object.keys(processSpec.env).sort();
  const fixedKeys = Object.keys(FIXED_GUEST_ENV).sort();
  if (envKeys.length !== fixedKeys.length || envKeys.some((key, index) =>
    key !== fixedKeys[index] || processSpec.env[key] !== FIXED_GUEST_ENV[key])) {
    throw new Error("guest process env must be the fixed minimal environment");
  }
  return Object.freeze({
    id: processSpec.id,
    name: processSpec.name,
    command: processSpec.command,
    args: Object.freeze([...processSpec.args]),
    cwd: "/",
    env: FIXED_GUEST_ENV,
  });
}

export class GuestExecCycleError extends Error {
  constructor(phase, error, evidence) {
    super(`VM guest execution cycle failed during ${phase}: ${message(error)}`);
    this.name = "GuestExecCycleError";
    this.cause = error;
    this.evidence = evidence;
  }
}

export function guestReadinessEvidence(status) {
  return {
    guestReady: status?.guestReady === true,
    coworkReady: status?.coworkReady === true,
    guestBootstrapReady: status?.guestBootstrapReady === true,
    ...(status?.distributionMode ? { distributionMode: status.distributionMode, meshReady: status.meshReady === true,
      networkFallbackReason: status.networkFallbackReason ?? null } : {}),
  };
}

export async function runGuestExecCycle({
  signal,
  start,
  waitForGuestReady,
  execute,
  stop,
  status,
  verifyStopped = () => undefined,
}) {
  const evidence = { completed: false, untrustedGuestOutput: true };
  let phase = "start";
  let primaryError = null;

  try {
    signal?.throwIfAborted();
    evidence.start = await start(signal);
    signal?.throwIfAborted();

    phase = "guest-ready";
    evidence.readiness = await waitForGuestReady(signal);
    signal?.throwIfAborted();

    phase = "exec";
    evidence.execution = await execute(signal);
    signal?.throwIfAborted();
  } catch (error) {
    primaryError = { phase, error };
  }

  let cleanupError = null;
  try {
    evidence.stop = await stop("mcp-exec-cycle-finally");
  } catch (error) {
    cleanupError = error;
    evidence.cleanupError = message(error);
  }

  let verificationError = null;
  try {
    evidence.after = await status();
    await verifyStopped(evidence.after, evidence.stop);
  } catch (error) {
    verificationError = error;
    evidence.verificationError = message(error);
  }

  if (primaryError || cleanupError || verificationError) {
    const cleanupFailed = cleanupError || verificationError;
    const failurePhase = primaryError
      ? `${primaryError.phase}${cleanupFailed ? " and cleanup" : ""}`
      : "cleanup";
    throw new GuestExecCycleError(
      failurePhase,
      primaryError?.error ?? cleanupError ?? verificationError,
      evidence,
    );
  }

  evidence.completed = true;
  return evidence;
}

function waitForChildExit(child, timeoutMilliseconds) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    const onExit = (code, signal) => { cleanup(); resolve({ code, signal }); };
    const onError = (error) => { cleanup(); reject(error); };
    timer = setTimeout(() => { cleanup(); resolve(null); }, timeoutMilliseconds);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

export class SwiftVM {
  constructor({
    bundlePath,
    runnerPath,
    smolPath,
    sharePath,
    memoryGB,
    cpuCount,
    networkMode = "nat",
    distributionMode = process.env.OVM_DISTRIBUTION_MODE ?? "auto",
    prepareNetwork,
    startupTimeoutSeconds,
    stopTimeoutMilliseconds = 55_000,
    terminationGraceMilliseconds = 5_000,
    maximumRunnerFrameBytes = HARD_MAXIMUM_RUNNER_FRAME_BYTES,
  }) {
    this.bundlePath = bundlePath;
    this.runnerPath = runnerPath;
    this.smolPath = smolPath;
    this.sharePath = sharePath;
    this.memoryGB = memoryGB;
    this.cpuCount = cpuCount;
    if (!["nat", "isolated"].includes(networkMode)) throw new Error("networkMode must be nat or isolated");
    this.networkMode = networkMode;
    if (!["auto", "local", "required"].includes(distributionMode)) throw new Error("distributionMode must be auto, local, or required");
    this.distributionMode = distributionMode;
    this.distribution = null;
    this.prepareNetwork = prepareNetwork;
    this.networkShare = null;
    this.startupTimeoutSeconds = startupTimeoutSeconds;
    this.stopTimeoutMilliseconds = stopTimeoutMilliseconds;
    this.terminationGraceMilliseconds = terminationGraceMilliseconds;
    if (!Number.isInteger(maximumRunnerFrameBytes) || maximumRunnerFrameBytes < 1024
      || maximumRunnerFrameBytes > HARD_MAXIMUM_RUNNER_FRAME_BYTES) {
      throw new Error(`maximumRunnerFrameBytes must be between 1024 and ${HARD_MAXIMUM_RUNNER_FRAME_BYTES}`);
    }
    this.maximumRunnerFrameBytes = maximumRunnerFrameBytes;
    this.child = null;
    this.history = [];
    this.waiters = new Set();
    this.listeners = new Set();
    this.stderr = "";
    this.lastExit = null;
  }

  get hasLiveProcess() {
    return Boolean(this.child?.pid && this.child.exitCode === null && this.child.signalCode === null);
  }

  runnerArguments(mode) {
    if (mode === "support") return ["--support-only"];
    const args = [
      "--bundle", this.bundlePath,
      "--smol", this.smolPath,
      "--share", this.sharePath,
      "--memory-gb", String(this.memoryGB),
      "--cpu-count", String(this.cpuCount),
      "--network", this.networkMode,
      "--distribution", this.distributionMode,
    ];
    if (mode === "run" && this.networkMode === "nat" && this.networkShare) args.push("--network-share", this.networkShare);
    if (mode === "probe") args.unshift("--probe");
    return args;
  }

  record(event) {
    this.history.push(event);
    if (this.history.length > 100) this.history.shift();
    for (const listener of [...this.listeners]) listener(event);
    for (const waiter of [...this.waiters]) {
      if (!waiter.predicate(event)) continue;
      waiter.resolve(event);
    }
  }

  waitFor(predicate, timeoutMilliseconds, signal) {
    const existing = this.history.findLast(predicate);
    if (existing) return Promise.resolve(existing);
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("operation aborted"));
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve: null, reject: null, timeout: null, abort: null };
      const cleanup = () => {
        clearTimeout(waiter.timeout);
        signal?.removeEventListener("abort", waiter.abort);
        this.waiters.delete(waiter);
      };
      waiter.resolve = (event) => { cleanup(); resolve(event); };
      waiter.reject = (error) => { cleanup(); reject(error); };
      waiter.abort = () => waiter.reject(signal.reason ?? new Error("operation aborted"));
      waiter.timeout = setTimeout(() => {
        waiter.reject(new Error(`timed out after ${Math.round(timeoutMilliseconds / 1000)} seconds`));
      }, timeoutMilliseconds);
      signal?.addEventListener("abort", waiter.abort, { once: true });
      this.waiters.add(waiter);
    });
  }

  attachOutput(child) {
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    let discardingOversizedLine = false;
    child.stdout.on("data", (chunk) => {
      buffer += decoder.write(chunk);
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) {
          if (Buffer.byteLength(buffer, "utf8") > this.maximumRunnerFrameBytes) {
            if (!discardingOversizedLine) {
              this.record({
                event: "error",
                stage: "runner-json",
                message: `runner frame exceeded ${this.maximumRunnerFrameBytes} bytes`,
              });
            }
            discardingOversizedLine = true;
            buffer = "";
          }
          break;
        }
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (discardingOversizedLine) {
          discardingOversizedLine = false;
          continue;
        }
        if (!line.trim()) continue;
        if (Buffer.byteLength(line, "utf8") > this.maximumRunnerFrameBytes) {
          this.record({
            event: "error",
            stage: "runner-json",
            message: `runner frame exceeded ${this.maximumRunnerFrameBytes} bytes`,
          });
          continue;
        }
        try {
          this.record(JSON.parse(line));
        } catch {
          this.record({ event: "error", stage: "runner-json", message: `invalid runner output: ${line}` });
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      this.stderr += chunk.toString("utf8");
      if (Buffer.byteLength(this.stderr, "utf8") > 64 * 1024) {
        this.stderr = Buffer.from(this.stderr, "utf8").subarray(-64 * 1024).toString("utf8");
      }
    });
  }

  spawnPersistent() {
    if (this.hasLiveProcess) return this.child;
    this.history = [];
    this.stderr = "";
    this.lastExit = null;
    const child = spawn(this.runnerPath, this.runnerArguments("run"), {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    this.attachOutput(child);
    child.stdin.on("error", (error) => {
      this.record({ event: "error", stage: "runner-stdin", message: error.message });
    });
    child.once("error", (error) => {
      this.record({ event: "error", stage: "runner-spawn", message: error.message });
      if (!child.pid && this.child === child) this.child = null;
    });
    child.once("exit", (code, signal) => {
      this.lastExit = { code, signal };
      this.record({ event: "process_exit", code, signal, stderr: this.stderr });
      if (this.child === child) this.child = null;
    });
    return child;
  }

  async oneShot(mode, timeoutMilliseconds = 10_000) {
    const child = spawn(this.runnerPath, this.runnerArguments(mode), {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    let exit = await waitForChildExit(child, timeoutMilliseconds);
    if (!exit) {
      child.kill("SIGTERM");
      exit = await waitForChildExit(child, 2_000);
      if (!exit) {
        child.kill("SIGKILL");
        exit = await waitForChildExit(child, 2_000);
      }
      if (!exit) throw new Error(`${mode} runner could not be terminated after timeout`);
      throw new Error(`${mode} runner timed out and was terminated`);
    }
    const events = stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const error = events.find((event) => event.event === "error");
    if (exit.code !== 0 || error) {
      throw new Error(`${mode} runner failed: ${messageFromEvent(error) || stderr || `exit ${exit.code}`}`);
    }
    if (events.length !== 1) throw new Error(`${mode} runner returned an unexpected event count`);
    return events[0];
  }

  async support() {
    const event = await this.oneShot("support");
    return { backend: "swift-virtualization", supported: event.supported === true };
  }

  async probe() {
    const event = await this.oneShot("probe");
    return {
      backend: "swift-virtualization",
      supported: event.supported === true,
      configurationValid: event.configurationValid === true,
      cpuCount: event.cpuCount,
      memorySize: event.memorySize,
      networkMode: event.networkMode,
      distributionMode: event.distributionMode ?? this.distributionMode,
    };
  }

  async status() {
    if (!this.hasLiveProcess) {
      const support = await this.support();
      return {
        ...support,
        running: false,
        state: "stopped",
        vsockConnected: false,
        guestReady: false,
        lastExit: this.lastExit,
        distribution: this.distribution,
      };
    }
    return this.request("status");
  }

  async request(
    command,
    extra = {},
    timeoutMilliseconds = 5_000,
    signal,
    requestId = randomUUID(),
  ) {
    signal?.throwIfAborted();
    const child = this.child;
    if (!child || !this.hasLiveProcess) throw new Error("Swift VM runner is not running");
    const expectedEvent = command === "console"
      ? "console"
      : command === "exec" ? "exec_result" : command;
    const frame = `${JSON.stringify({ command, requestId, ...extra })}\n`;
    if (Buffer.byteLength(frame, "utf8") > this.maximumRunnerFrameBytes) {
      throw new Error(`runner request frame exceeded ${this.maximumRunnerFrameBytes} bytes`);
    }
    const response = this.waitFor(
      (event) => (event.requestId === requestId && (event.event === expectedEvent || event.event === "error"))
        || event.event === "process_exit"
        || (event.event === "error" && event.requestId === undefined && event.stage !== "command"),
      timeoutMilliseconds,
      signal,
    );
    try {
      child.stdin.write(frame);
    } catch (error) {
      response.catch(() => {});
      throw error;
    }
    const event = await response;
    if (event.event === "error" || event.event === "process_exit") throw new Error(messageFromEvent(event));
    return event;
  }

  async waitForGuestReady(signal, timeoutMilliseconds = this.startupTimeoutSeconds * 1000) {
    signal?.throwIfAborted();
    if (!this.hasLiveProcess) throw new Error("Swift VM runner is not running");
    const deadline = Date.now() + timeoutMilliseconds;
    let lastStatus = null;
    for (;;) {
      signal?.throwIfAborted();
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`VM did not report guestReady within ${Math.round(timeoutMilliseconds / 1000)} seconds`);
      }
      lastStatus = await this.request("status", {}, Math.min(1_000, remaining), signal);
      if (lastStatus.running === true && lastStatus.vsockConnected === true && lastStatus.guestReady === true) {
        return lastStatus;
      }
      if (lastStatus.running === false || lastStatus.vsockConnected === false) {
        throw new Error("VM lost its running guest transport before guestReady");
      }
      await abortableDelay(Math.min(100, Math.max(0, deadline - Date.now())), signal);
    }
  }

  async exec(processSpec, {
    timeoutMilliseconds,
    maximumOutputBytes,
    signal,
  }) {
    const guestProcess = validateGuestProcess(processSpec);
    if (!Number.isInteger(timeoutMilliseconds) || timeoutMilliseconds < 1
      || timeoutMilliseconds > 30_000) {
      throw new Error("guest execution timeout must be between 1 and 30000 milliseconds");
    }
    if (!Number.isInteger(maximumOutputBytes) || maximumOutputBytes < 1
      || maximumOutputBytes > HARD_MAXIMUM_EXEC_OUTPUT_BYTES) {
      throw new Error(`guest output limit must be between 1 and ${HARD_MAXIMUM_EXEC_OUTPUT_BYTES} bytes`);
    }

    const requestId = randomUUID();
    const outputController = new AbortController();
    const requestSignal = signal
      ? AbortSignal.any([signal, outputController.signal])
      : outputController.signal;
    let streamedOutputBytes = 0;
    const listener = (event) => {
      if (event?.requestId !== requestId || (event.event !== "stdout" && event.event !== "stderr")) return;
      if (event.processId !== guestProcess.id || typeof event.data !== "string") {
        outputController.abort(new Error("guest execution emitted an invalid correlated output event"));
        return;
      }
      streamedOutputBytes += Buffer.byteLength(event.data, "utf8");
      if (streamedOutputBytes > maximumOutputBytes) {
        outputController.abort(new Error(`guest output exceeded the ${maximumOutputBytes}-byte limit`));
      }
    };
    this.listeners.add(listener);

    try {
      const event = await this.request(
        "exec",
        { process: guestProcess },
        timeoutMilliseconds,
        requestSignal,
        requestId,
      );
      if (event.processId !== guestProcess.id) {
        throw new Error("guest execution result processId did not match the request");
      }
      if (event.error !== undefined && event.error !== null) {
        throw new Error(`guest execution failed: ${messageFromEvent(event)}`);
      }
      if (typeof event.stdout !== "string" || typeof event.stderr !== "string") {
        throw new Error("guest execution result must contain string stdout and stderr");
      }
      if (!(event.exitCode === null || Number.isInteger(event.exitCode))) {
        throw new Error("guest execution result has an invalid exitCode");
      }
      if (!(event.signal === null || typeof event.signal === "string")) {
        throw new Error("guest execution result has an invalid signal");
      }
      if (typeof event.truncated !== "boolean") {
        throw new Error("guest execution result has an invalid truncated flag");
      }
      const stdoutBytes = Buffer.byteLength(event.stdout, "utf8");
      const stderrBytes = Buffer.byteLength(event.stderr, "utf8");
      const totalBytes = stdoutBytes + stderrBytes;
      if (totalBytes > maximumOutputBytes) {
        throw new Error(`guest output exceeded the ${maximumOutputBytes}-byte limit`);
      }
      return Object.freeze({
        processId: guestProcess.id,
        exitCode: event.exitCode,
        signal: event.signal,
        stdout: event.stdout,
        stderr: event.stderr,
        truncated: event.truncated,
        outputBytes: Object.freeze({
          stdout: stdoutBytes,
          stderr: stderrBytes,
          total: totalBytes,
          limit: maximumOutputBytes,
          streamed: streamedOutputBytes,
        }),
      });
    } finally {
      this.listeners.delete(listener);
    }
  }

  async start(signal) {
    signal?.throwIfAborted();
    if (this.hasLiveProcess) return this.status();
    if (this.networkMode === "nat" && this.prepareNetwork) {
      const identity = await this.prepareNetwork({ distributionMode: this.distributionMode, networkMode: this.networkMode });
      this.distribution = { distributionMode: this.distributionMode, effectiveDistributionMode: identity.effectiveDistributionMode ?? "mesh",
        meshConfigured: identity.meshConfigured ?? true, fallbackReason: identity.fallbackReason ?? null, guestReachabilityVerified: false };
      this.networkShare = identity.shareDir ?? identity.networkShare;
      if (typeof this.networkShare !== "string" || !this.networkShare.startsWith("/")) throw new Error("VM network provider did not return an absolute share directory");
      signal?.throwIfAborted();
    }
    this.spawnPersistent();
    try {
      const event = await this.waitFor(
        (candidate) => ["vsock_connected", "error", "process_exit"].includes(candidate.event),
        this.startupTimeoutSeconds * 1000,
        signal,
      );
      if (event.event !== "vsock_connected") {
        throw new Error(`VM did not reach vsock connection: ${messageFromEvent(event)}`);
      }
      const lifecycle = await this.request("status", {}, 5_000, signal);
      signal?.throwIfAborted();
      return lifecycle;
    } catch (error) {
      await this.stop("failed-start").catch(() => {});
      throw error;
    }
  }

  async console(stream = "hvc1") {
    if (stream !== "hvc0" && stream !== "hvc1") throw new Error("console stream must be hvc0 or hvc1");
    if (!this.hasLiveProcess) return { stream, text: "", running: false };
    return this.request("console", { stream });
  }

  async stop(reason = "mcp-stop") {
    const child = this.child;
    if (!child || !this.hasLiveProcess) {
      return { backend: "swift-virtualization", running: false, state: "stopped", lastExit: this.lastExit };
    }
    const exited = this.waitFor((event) => event.event === "process_exit", this.stopTimeoutMilliseconds);
    child.stdin.write(`${JSON.stringify({ command: "stop", reason })}\n`);
    let event;
    let processEscalation = null;
    try {
      event = await exited;
    } catch {
      processEscalation = "SIGTERM";
      child.kill("SIGTERM");
      event = await waitForChildExit(child, this.terminationGraceMilliseconds);
      if (!event) {
        processEscalation = "SIGKILL";
        child.kill("SIGKILL");
        event = await waitForChildExit(child, this.terminationGraceMilliseconds);
      }
      if (!event) throw new Error("Swift VM runner did not exit after SIGKILL");
    }
    return {
      backend: "swift-virtualization",
      running: false,
      state: "stopped",
      cleanExit: event.code === 0,
      processEscalation,
      runnerExit: event,
      stderr: this.stderr,
    };
  }
}
