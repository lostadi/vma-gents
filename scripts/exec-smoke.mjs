#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const transport = new StdioClientTransport({
  command: path.join(projectRoot, "bin", "claude-vm-mcp"),
  args: [],
  env: { ...process.env, CLAUDE_VM_LIFETIME: "transaction" },
});
const client = new Client({ name: "ostadix-claude-vm-exec", version: "1.0.0" });
const requestOptions = { timeout: 180_000, maxTotalTimeout: 180_000 };
const maximumOutputBytes = 32 * 1024;
const request = Object.freeze({
  program: "uname",
  args: Object.freeze(["-m"]),
  timeoutSeconds: 10,
});
const evidence = {};
let connected = false;
let failed = false;

function body(reply) {
  const block = reply.content?.find((item) => item.type === "text");
  return block ? JSON.parse(block.text) : {};
}

async function call(tool, arguments_ = {}) {
  const reply = await client.callTool({ name: tool, arguments: arguments_ }, undefined, requestOptions);
  const value = body(reply);
  if (reply.isError) {
    const error = new Error(`${tool}: ${value.error ?? "unknown MCP error"}`);
    error.evidence = value.evidence;
    throw error;
  }
  return value;
}

function stoppedAndUnlocked(status) {
  return status?.lifecycle?.running === false && status?.controllerLease?.held === false;
}

function validOutputReceipt(execution) {
  const value = execution?.outputBytes;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const integers = [value.stdout, value.stderr, value.total, value.limit, value.streamed];
  if (!integers.every((item) => Number.isInteger(item) && item >= 0)) return false;
  if (typeof execution.stdout !== "string" || typeof execution.stderr !== "string") return false;
  const stdoutBytes = Buffer.byteLength(execution.stdout, "utf8");
  const stderrBytes = Buffer.byteLength(execution.stderr, "utf8");
  return value.stdout === stdoutBytes
    && value.stderr === stderrBytes
    && value.total === stdoutBytes + stderrBytes
    && value.limit === maximumOutputBytes
    && value.total <= value.limit
    && value.streamed <= value.limit;
}

try {
  await client.connect(transport, requestOptions);
  connected = true;
  evidence.tools = (await client.listTools(undefined, requestOptions)).tools.map(({ name }) => name);
  if (!evidence.tools.includes("exec_cycle")) throw new Error("exec_cycle is not registered");

  evidence.before = await call("status");
  evidence.expectedNetworkMode = evidence.before.policy?.networkMode;
  if (!["nat", "isolated"].includes(evidence.expectedNetworkMode)) {
    throw new Error("status did not report a valid configured network mode");
  }
  evidence.request = request;
  if (!stoppedAndUnlocked(evidence.before)) {
    throw new Error("guest execution precondition was not stopped and unlocked");
  }
  evidence.execution = await call("exec_cycle", request);
  evidence.after = await call("status");

  const architecture = evidence.execution.stdout?.trim();
  const clean = evidence.execution.cleanup ?? {};
  if (
    !evidence.execution.completed
    || evidence.execution.program !== request.program
    || evidence.execution.networkMode !== evidence.expectedNetworkMode
    || evidence.execution.timeoutSeconds !== request.timeoutSeconds
    || evidence.execution.untrustedGuestOutput !== true
    || evidence.execution.truncated !== false
    || !validOutputReceipt(evidence.execution)
    || evidence.execution.readiness?.guestReady !== true
    || evidence.execution.readiness?.coworkReady !== true
    || evidence.execution.readiness?.guestBootstrapReady !== true
    || evidence.execution.exitCode !== 0
    || !["aarch64", "arm64"].includes(architecture)
    || clean.verified !== true
    || clean.stopped !== true
    || clean.leaseReleased !== true
    || clean.runnerRunning !== false
    || clean.controllerLeaseHeld !== false
    || !stoppedAndUnlocked(evidence.after)
  ) {
    throw new Error("guest execution did not return a verified ARM64, stopped, and unlocked receipt");
  }
} catch (error) {
  failed = true;
  evidence.error = error instanceof Error ? error.message : String(error);
  if (error?.evidence) evidence.failureEvidence = error.evidence;
  if (connected) {
    try {
      evidence.afterFailure = await call("status");
    } catch (statusError) {
      evidence.statusError = statusError instanceof Error ? statusError.message : String(statusError);
    }
  }
} finally {
  if (connected) {
    try {
      await client.close();
    } catch (error) {
      failed = true;
      evidence.closeError = error instanceof Error ? error.message : String(error);
    }
  }
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  if (failed) process.exitCode = 1;
}
