import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VMLease } from "./lease.mjs";
import { assertCycleStartable, runLifecycleCycle } from "./cycle.mjs";
import { loadPolicy, validateInvocation } from "./policy.mjs";
import { ProcessLifetimeSupervisor } from "./process-lifetime.mjs";
import { SerialExecutor } from "./serial.mjs";
import { guestReadinessEvidence, runGuestExecCycle, SwiftVM } from "./swift-vm.mjs";
import {
  CLAUDE_SOURCE_BUNDLE,
  bundleOpenPids,
  ensurePrivateIdentity,
  inspectHost,
  readBundleVersion,
  runStartPreflight,
  verifyBundle,
  verifyShareDirectory,
} from "./preflight.mjs";
import { boundedUtf8Tail } from "./text.mjs";
import { NativeCapabilityBroker } from "./native-capabilities.mjs";
import { prepareLaunchNetwork } from "./guest-network.mjs";
import { applyDistributionEnvironment } from "./distribution-config.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
applyDistributionEnvironment(projectRoot);
const privateRoot = await realpath(path.join(projectRoot, "vm"));
const bundlePath = path.join(privateRoot, "claudevm.bundle");
const sourceBundlePath = CLAUDE_SOURCE_BUNDLE;
const configuredPolicyPath = path.resolve(process.env.CLAUDE_VM_POLICY ?? path.join(projectRoot, "policy.json"));
const policyPath = await realpath(configuredPolicyPath);
const relativePolicyPath = path.relative(projectRoot, policyPath);
if (configuredPolicyPath !== policyPath || relativePolicyPath.startsWith("..") || path.isAbsolute(relativePolicyPath)) {
  throw new Error("CLAUDE_VM_POLICY must resolve without symlinks inside the MCP project root");
}
const configuredRunnerPath = path.resolve(
  process.env.CLAUDE_VM_RUNNER ?? path.join(projectRoot, "host", "ClaudeVZRunner"),
);
const runnerPath = await realpath(configuredRunnerPath);
const relativeRunnerPath = path.relative(projectRoot, runnerPath);
if (relativeRunnerPath.startsWith("..") || path.isAbsolute(relativeRunnerPath)) {
  throw new Error("CLAUDE_VM_RUNNER must resolve inside the MCP project root");
}
const smolPath = path.join(projectRoot, "host", "smol-bin.arm64.img");
const sharePath = await realpath(path.join(projectRoot, "share"));
const leasePath = `${bundlePath}.mcp.lease`;
const policy = await loadPolicy(policyPath);
const networkMode = process.env.OVM_NETWORK_MODE ?? policy.networkMode;
if (!["nat", "isolated"].includes(networkMode)) throw new Error("OVM_NETWORK_MODE must be nat or isolated");
const lifetimeMode = process.env.CLAUDE_VM_LIFETIME ?? "transaction";
if (lifetimeMode !== "transaction" && lifetimeMode !== "process") {
  throw new Error("CLAUDE_VM_LIFETIME must be either transaction or process");
}
const lease = new VMLease(leasePath);
const vm = new SwiftVM({
  bundlePath,
  runnerPath,
  smolPath,
  sharePath,
  memoryGB: policy.memoryGB,
  cpuCount: policy.cpuCount,
  networkMode,
  distributionMode: process.env.OVM_DISTRIBUTION_MODE ?? "auto",
  prepareNetwork: (options) => prepareLaunchNetwork({ ...options, projectRoot, guestId: `bundle:${bundlePath}` }),
  startupTimeoutSeconds: policy.startupTimeoutSeconds,
});
const operations = new SerialExecutor();
const nativeCapabilities = new NativeCapabilityBroker();
let processLifetime = null;

async function confirmVMStopped() {
  if (vm.hasLiveProcess) return false;
  try {
    await lstat(bundlePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    const controllerLease = await lease.inspect();
    return !controllerLease.held;
  }
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if ((await bundleOpenPids(bundlePath)).length === 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

function result(value, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    isError,
  };
}

async function guarded(handler) {
  try {
    return result(await handler());
  } catch (error) {
    return result({
      error: error instanceof Error ? error.message : String(error),
      ...(error?.evidence ? { evidence: error.evidence } : {}),
    }, true);
  }
}

async function getStatus() {
  const verifiedPath = await verifyBundle(bundlePath, sourceBundlePath, privateRoot);
  const [host, lifecycle, bundleVersion, controllerLease, native] = await Promise.all([
    inspectHost(verifiedPath),
    vm.status(),
    readBundleVersion(verifiedPath),
    lease.inspect(),
    nativeCapabilities.describe(),
  ]);
  return {
    bundlePath: verifiedPath,
    sourcePathIsolationVerified: true,
    bundleVersion,
    policy: {
      memoryGB: policy.memoryGB,
      cpuCount: policy.cpuCount,
      networkMode,
      startupTimeoutSeconds: policy.startupTimeoutSeconds,
      guestExecutionEnabled: true,
      guestPrograms: Object.keys(policy.programs),
      defaultGuestTimeoutSeconds: policy.defaultTimeoutSeconds,
      maximumGuestTimeoutSeconds: policy.maximumTimeoutSeconds,
      maximumGuestOutputBytes: policy.maximumOutputBytes,
    },
    host,
    lifecycle,
    controllerLease,
    native: {
      allowAct: native.allowAct,
      providers: native.providers,
      enabledOperations: native.operations.filter((operation) => operation.enabled)
        .map(({ name, access, evidence }) => ({ name, access, evidence })),
    },
    lifetime: lifetimeMode === "process"
      ? {
          ...processLifetime.snapshot(),
          mode: lifetimeMode,
          runnerPid: vm.hasLiveProcess ? vm.child?.pid ?? null : null,
        }
      : { mode: lifetimeMode, runnerPid: null },
  };
}

async function startVM(signal) {
  signal?.throwIfAborted();
  const controllerLease = await lease.acquire();
  try {
    const currentLifecycle = await vm.status();
    if (currentLifecycle.running && currentLifecycle.vsockConnected) {
      return {
        started: false,
        alreadyRunning: true,
        readiness: currentLifecycle.guestReady ? "guest-ready" : "transport-only",
        lifecycle: currentLifecycle,
        controllerLease,
      };
    }
    signal?.throwIfAborted();
    const preflight = await runStartPreflight({
      bundlePath,
      sourceBundlePath,
      privateRoot,
      smolPath,
      sharePath,
      projectRoot,
      policy,
    });
    signal?.throwIfAborted();
    const identityRegenerated = await ensurePrivateIdentity(preflight.bundlePath);
    const configuration = await vm.probe();
    signal?.throwIfAborted();
    if (!configuration.supported || !configuration.configurationValid) {
      throw new Error("Swift Virtualization configuration probe failed");
    }
    await verifyShareDirectory(preflight.hostShare.path, projectRoot);
    const lifecycle = await vm.start(signal);
    if (!lifecycle.running || !lifecycle.vsockConnected) {
      throw new Error("VM did not establish its transport-only guest vsock connection");
    }
    return {
      started: true,
      identityRegenerated,
      readiness: lifecycle.guestReady ? "guest-ready" : "transport-only",
      host: preflight.host,
      directBoot: preflight.directBoot,
      helperImage: preflight.helperImage,
      hostShare: preflight.hostShare,
      lifecycle,
      controllerLease,
    };
  } catch (error) {
    await vm.stop("failed-start").catch((cleanupError) => {
      console.error("[claude-vm-mcp] failed-start Swift runner cleanup failed:", cleanupError);
    });
    const definitelyStopped = await confirmVMStopped();
    if (definitelyStopped) {
      await lease.release().catch((cleanupError) => {
        console.error("[claude-vm-mcp] failed-start lease cleanup failed:", cleanupError);
      });
    } else {
      console.error("[claude-vm-mcp] retaining controller lease because stopped state is uncertain");
    }
    throw error;
  }
}

async function readConsole(stream, maxBytes) {
  const response = await vm.console(stream);
  return { ...response, ...boundedUtf8Tail(response.text ?? "", maxBytes) };
}

async function stopVM(reason) {
  const current = await lease.inspect();
  if (current.held) await lease.requireOwnership();
  const lifecycle = await vm.stop(reason);
  if (!await confirmVMStopped()) {
    throw new Error("VM runner stopped but private disk files remain open; controller lease retained");
  }
  const leaseReleased = await lease.release();
  return { stopped: true, lifecycle, leaseReleased };
}

function verifyCycleStopped(after, stopped) {
  if (!stopped?.stopped || after?.lifecycle?.running || after?.controllerLease?.held) {
    throw new Error("VM execution cleanup invariant failed: runner or controller lease remains active");
  }
}

function verifyProcessResident(after) {
  if (!after?.lifecycle?.running || !after?.lifecycle?.guestReady
    || !after?.controllerLease?.held || !after?.controllerLease?.ownedByThisProcess) {
    throw new Error("process-lifetime VM lost its ready runner or controller lease");
  }
}

function buildGuestProcess(program, args, timeoutSeconds) {
  const invocation = validateInvocation(policy, program, args, timeoutSeconds);
  return {
    invocation,
    processSpec: {
      id: randomUUID(),
      name: program,
      command: invocation.command,
      args: invocation.args,
      cwd: invocation.cwd,
      env: invocation.env,
    },
  };
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

async function runResidentOperation(input, signal) {
  if (input.kind === "console") {
    await abortableDelay(input.settleMilliseconds, signal);
    const console = await readConsole(input.stream, input.maxBytes);
    const after = await getStatus();
    verifyProcessResident(after);
    return { console, after };
  }
  if (input.kind !== "exec") throw new Error("unsupported process-lifetime operation");
  const execution = await vm.exec(input.processSpec, {
    timeoutMilliseconds: input.timeoutSeconds * 1000,
    maximumOutputBytes: policy.maximumOutputBytes,
    signal,
  });
  const after = await getStatus();
  verifyProcessResident(after);
  return { execution, after };
}

processLifetime = new ProcessLifetimeSupervisor({
  start: startVM,
  waitForGuestReady: (signal) => vm.waitForGuestReady(
    signal,
    policy.startupTimeoutSeconds * 1000,
  ),
  execute: runResidentOperation,
  stop: stopVM,
  status: getStatus,
  verifyStopped: verifyCycleStopped,
});

async function executeGuestCycle(program, args, timeoutSeconds, signal) {
  const before = await getStatus();
  assertCycleStartable(before);
  const { invocation, processSpec } = buildGuestProcess(program, args, timeoutSeconds);
  const evidence = await runGuestExecCycle({
    signal,
    start: startVM,
    waitForGuestReady: (operationSignal) => vm.waitForGuestReady(
      operationSignal,
      policy.startupTimeoutSeconds * 1000,
    ),
    execute: (operationSignal) => vm.exec(processSpec, {
      timeoutMilliseconds: invocation.timeoutSeconds * 1000,
      maximumOutputBytes: policy.maximumOutputBytes,
      signal: operationSignal,
    }),
    stop: stopVM,
    status: getStatus,
    verifyStopped: verifyCycleStopped,
  });
  const execution = evidence.execution;
  return {
    completed: true,
    program,
    networkMode,
    processId: execution.processId,
    timeoutSeconds: invocation.timeoutSeconds,
    exitCode: execution.exitCode,
    signal: execution.signal,
    stdout: execution.stdout,
    stderr: execution.stderr,
    truncated: execution.truncated,
    outputBytes: execution.outputBytes,
    untrustedGuestOutput: true,
    readiness: guestReadinessEvidence(evidence.readiness),
    cleanup: {
      stopped: evidence.stop?.stopped === true,
      leaseReleased: evidence.stop?.leaseReleased === true,
      runnerRunning: evidence.after?.lifecycle?.running === true,
      controllerLeaseHeld: evidence.after?.controllerLease?.held === true,
      verified: true,
    },
  };
}

async function executeGuestResident(program, args, timeoutSeconds, signal) {
  const { invocation, processSpec } = buildGuestProcess(program, args, timeoutSeconds);
  const { execution, after } = await processLifetime.run({
    kind: "exec",
    processSpec,
    timeoutSeconds: invocation.timeoutSeconds,
  }, signal);
  return {
    completed: true,
    lifetimeMode,
    resident: true,
    program,
    networkMode,
    processId: execution.processId,
    timeoutSeconds: invocation.timeoutSeconds,
    exitCode: execution.exitCode,
    signal: execution.signal,
    stdout: execution.stdout,
    stderr: execution.stderr,
    truncated: execution.truncated,
    outputBytes: execution.outputBytes,
    untrustedGuestOutput: true,
    readiness: guestReadinessEvidence(after.lifecycle),
    cleanup: {
      stopped: false,
      leaseReleased: false,
      runnerRunning: after.lifecycle.running === true,
      controllerLeaseHeld: after.controllerLease.held === true,
      deferredToControllerExit: true,
      verified: true,
    },
  };
}

const server = new McpServer({ name: "claude_vm", version: "0.5.0" });

server.registerTool("status", {
  description: "Report integrity, host headroom, and lifecycle state for Lee's private Claude VM clone.",
  inputSchema: {},
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
}, () => guarded(() => operations.run(getStatus)));

server.registerTool("start", {
  description: "Start or confirm the configured-lifetime Claude Linux VM clone through the clean Swift Virtualization backend.",
  inputSchema: {},
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: networkMode === "nat",
  },
}, (_arguments, extra) => guarded(() => operations.run(() => (
  lifetimeMode === "process" ? processLifetime.warm(extra.signal) : startVM(extra.signal)
))));

server.registerTool("console", {
  description: "Read the bounded tail of the private VM's kernel or daemon console.",
  inputSchema: {
    stream: z.enum(["hvc0", "hvc1"]).default("hvc1"),
    maxBytes: z.number().int().min(1024).max(65_536).default(8192),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
}, ({ stream, maxBytes }) => guarded(() => operations.run(() => readConsole(stream, maxBytes))));

server.registerTool("cycle", {
  description: "Inspect one configured-lifetime VM transaction with bounded console output and controller-owned cleanup.",
  inputSchema: {
    stream: z.enum(["hvc0", "hvc1"]).default("hvc1"),
    maxBytes: z.number().int().min(1024).max(16_384).default(4096),
    settleMilliseconds: z.number().int().min(0).max(5000).default(500),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: networkMode === "nat",
  },
}, ({ stream, maxBytes, settleMilliseconds }, extra) => guarded(() => operations.run(async () => {
  if (lifetimeMode === "process") {
    const resident = await processLifetime.run({
      kind: "console",
      stream,
      maxBytes,
      settleMilliseconds,
    }, extra.signal);
    return {
      completed: true,
      lifetimeMode,
      resident: true,
      console: resident.console,
      after: resident.after,
      cleanup: {
        stopped: false,
        leaseReleased: false,
        deferredToControllerExit: true,
        verified: true,
      },
    };
  }
  const before = await getStatus();
  assertCycleStartable(before);
  return runLifecycleCycle({
    signal: extra.signal,
    start: startVM,
    status: getStatus,
    readConsole: () => readConsole(stream, maxBytes),
    stop: stopVM,
    verifyStopped: (after, stopped) => {
      if (!stopped?.stopped || after?.lifecycle?.running || after?.controllerLease?.held) {
        throw new Error("VM cycle cleanup invariant failed: runner or controller lease remains active");
      }
    },
    settleMilliseconds,
  });
})));

server.registerTool("exec_cycle", {
  description: "Run one exact allowlisted argv invocation after guestReady inside the guest with its configured network mode, return bounded untrusted output, and apply the configured controller-owned cleanup lifetime.",
  inputSchema: {
    program: z.enum(Object.keys(policy.programs)),
    args: z.array(z.string().max(256)).max(policy.maximumArguments).default([]),
    timeoutSeconds: z.number().int().min(1).max(policy.maximumTimeoutSeconds)
      .default(policy.defaultTimeoutSeconds),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: networkMode === "nat",
  },
}, ({ program, args, timeoutSeconds }, extra) => guarded(() => operations.run(
  () => lifetimeMode === "process"
    ? executeGuestResident(program, args, timeoutSeconds, extra.signal)
    : executeGuestCycle(program, args, timeoutSeconds, extra.signal),
)));

server.registerTool("native_capabilities", {
  description: "Probe qualified decoded Claude native addons in disposable subprocesses and report the bounded host capabilities available to OVM agents.",
  inputSchema: {},
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
}, () => guarded(() => nativeCapabilities.probe()));

server.registerTool("native_call", {
  description: "Invoke one cataloged decoded Claude host capability through an isolated subprocess. Observation calls are enabled by default; host actions require owner-controlled OVM_NATIVE_ALLOW_ACT=1.",
  inputSchema: {
    operation: z.string().min(1).max(256),
    args: z.array(z.union([
      z.string().max(4096),
      z.number(),
      z.boolean(),
      z.null(),
    ])).max(8).default([]),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
}, ({ operation, args }) => guarded(() => nativeCapabilities.call(operation, args)));

server.registerTool("stop", {
  description: "Gracefully stop the private VM clone, with a bounded forced-stop fallback.",
  inputSchema: {},
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
}, () => guarded(() => operations.run(() => {
  if (lifetimeMode === "process") {
    throw new Error("process-lifetime VM stops only when its MCP controller exits");
  }
  return stopVM("mcp-stop");
})));

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  let exitCode = 0;
  await operations.run(async () => {
    try {
      if (lifetimeMode === "process") {
        const finalLifetime = await processLifetime.shutdown(`mcp-${signal}`);
        if (finalLifetime.state === "failed") exitCode = 1;
      } else {
        await vm.stop(`mcp-${signal}`);
      }
    } catch (error) {
      exitCode = 1;
      console.error(`[claude-vm-mcp] shutdown after ${signal} failed:`, error);
    }
    if (await confirmVMStopped()) {
      await lease.release().catch((error) => {
        exitCode = 1;
        console.error(`[claude-vm-mcp] lease release after ${signal} failed:`, error);
      });
    } else {
      exitCode = 1;
      console.error(`[claude-vm-mcp] retaining controller lease after ${signal}; stopped state is uncertain`);
    }
  });
  process.exit(exitCode);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.stdin.on("end", () => void shutdown("stdin-end"));

await server.connect(new StdioServerTransport());
if (lifetimeMode === "process") {
  void operations.run(() => processLifetime.warm()).catch((error) => {
    console.error("[claude-vm-mcp] process-lifetime warm-up failed:", error);
  });
}
