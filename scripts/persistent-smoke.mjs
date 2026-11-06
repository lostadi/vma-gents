#!/usr/bin/env node

import path from "node:path";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { bundleOpenPids } from "../src/preflight.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundlePath = path.join(projectRoot, "vm", "claudevm.bundle");
const leasePath = `${bundlePath}.mcp.lease`;
const operationCount = Number.parseInt(process.env.CLAUDE_VM_WARM_OPERATIONS ?? "5", 10);
if (!Number.isInteger(operationCount) || operationCount < 1 || operationCount > 100) {
  throw new Error("CLAUDE_VM_WARM_OPERATIONS must be an integer from 1 through 100");
}
const holdSeconds = Number.parseInt(process.env.CLAUDE_VM_HOLD_SECONDS ?? "0", 10);
if (!Number.isInteger(holdSeconds) || holdSeconds < 0 || holdSeconds > 300) {
  throw new Error("CLAUDE_VM_HOLD_SECONDS must be an integer from 0 through 300");
}

const transport = new StdioClientTransport({
  command: path.join(projectRoot, "bin", "claude-vm-mcp"),
  args: [],
  env: {
    ...process.env,
    CLAUDE_VM_LIFETIME: "process",
  },
});
const client = new Client({ name: "claude-vm-persistent-smoke", version: "1.0.0" });
const requestOptions = { timeout: 180_000, maxTotalTimeout: 180_000 };
const evidence = { operationCount, holdSeconds, operations: [] };
let connected = false;
let failed = false;

function decode(reply, tool) {
  const block = reply.content?.find((item) => item.type === "text");
  const body = block ? JSON.parse(block.text) : {};
  if (reply.isError) {
    const error = new Error(`${tool}: ${body.error ?? "unknown MCP error"}`);
    error.evidence = body.evidence;
    throw error;
  }
  return body;
}

async function call(tool, arguments_ = {}) {
  return decode(await client.callTool(
    { name: tool, arguments: arguments_ },
    undefined,
    requestOptions,
  ), tool);
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function waitForCleanup(runnerPid, timeoutMilliseconds = 60_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  let snapshot;
  do {
    snapshot = {
      runnerAlive: processAlive(runnerPid),
      diskOpenPids: await bundleOpenPids(bundlePath),
      leasePresent: await pathExists(leasePath),
    };
    if (!snapshot.runnerAlive && snapshot.diskOpenPids.length === 0 && !snapshot.leasePresent) {
      return { ...snapshot, verified: true };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  return { ...snapshot, verified: false };
}

try {
  const connectedAt = performance.now();
  await client.connect(transport, requestOptions);
  connected = true;
  evidence.connectMilliseconds = performance.now() - connectedAt;
  evidence.tools = (await client.listTools(undefined, requestOptions)).tools.map(({ name }) => name);

  evidence.ready = await call("status");
  if (evidence.ready.lifetime?.mode !== "process"
    || evidence.ready.lifetime?.state !== "warm"
    || evidence.ready.lifecycle?.guestReady !== true) {
    throw new Error("process-lifetime controller did not reach warm guestReady state");
  }
  evidence.runnerPid = evidence.ready.lifetime.runnerPid;
  evidence.leaseAcquiredAt = evidence.ready.controllerLease?.acquiredAt;
  process.stderr.write(`PROCESS_LIFETIME_READY runnerPid=${evidence.runnerPid}\n`);

  for (let index = 0; index < operationCount; index += 1) {
    const startedAt = performance.now();
    const execution = await call("exec_cycle", {
      program: "uname",
      args: ["-m"],
      timeoutSeconds: 10,
    });
    const durationMilliseconds = performance.now() - startedAt;
    if (!execution.completed || !execution.resident || execution.stdout !== "aarch64\n"
      || execution.cleanup?.stopped || !execution.cleanup?.runnerRunning
      || !execution.cleanup?.controllerLeaseHeld) {
      throw new Error(`resident execution ${index + 1} returned an invalid receipt`);
    }
    const status = await call("status");
    if (status.lifetime?.runnerPid !== evidence.runnerPid
      || status.controllerLease?.acquiredAt !== evidence.leaseAcquiredAt
      || status.lifetime?.startCalls !== 1) {
      throw new Error(`resident execution ${index + 1} changed runner or lease identity`);
    }
    evidence.operations.push({
      sequence: index + 1,
      durationMilliseconds,
      exitCode: execution.exitCode,
      outputBytes: execution.outputBytes?.total,
    });
  }
  evidence.beforeClose = await call("status");
  if (holdSeconds > 0) {
    process.stderr.write(`PROCESS_LIFETIME_HOLD seconds=${holdSeconds}\n`);
    await new Promise((resolve) => setTimeout(resolve, holdSeconds * 1000));
  }
} catch (error) {
  failed = true;
  evidence.error = error instanceof Error ? error.message : String(error);
  if (error?.evidence) evidence.failureEvidence = error.evidence;
} finally {
  if (connected) {
    try {
      const closeStartedAt = performance.now();
      await client.close();
      evidence.closeMilliseconds = performance.now() - closeStartedAt;
    } catch (error) {
      failed = true;
      evidence.closeError = error instanceof Error ? error.message : String(error);
    }
  }
  if (evidence.runnerPid) {
    try {
      evidence.afterClose = await waitForCleanup(evidence.runnerPid);
      if (!evidence.afterClose.verified) failed = true;
    } catch (error) {
      failed = true;
      evidence.cleanupProbeError = error instanceof Error ? error.message : String(error);
    }
  }
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  if (failed) process.exitCode = 1;
}
