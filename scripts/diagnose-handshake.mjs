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
const client = new Client({ name: "ostadix-claude-vm-handshake", version: "1.0.0" });
const requestOptions = { timeout: 180_000, maxTotalTimeout: 180_000 };
const evidence = { samples: [] };
let connected = false;
let started = false;
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

function snapshot(status) {
  return {
    elapsedMilliseconds: Date.now() - evidence.startedAt,
    state: status.lifecycle?.state,
    running: status.lifecycle?.running,
    vsockConnected: status.lifecycle?.vsockConnected,
    hostConfigSent: status.lifecycle?.hostConfigSent,
    guestReady: status.lifecycle?.guestReady,
  };
}

try {
  await client.connect(transport, requestOptions);
  connected = true;
  evidence.before = await call("status");
  evidence.startedAt = Date.now();
  evidence.start = await call("start");
  started = evidence.start.started === true || evidence.start.alreadyRunning === true;

  for (let index = 0; index < 40; index += 1) {
    const status = await call("status");
    evidence.samples.push(snapshot(status));
    if (status.lifecycle?.guestReady === true) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  evidence.hvc0 = await call("console", { stream: "hvc0", maxBytes: 16_384 });
  evidence.hvc1 = await call("console", { stream: "hvc1", maxBytes: 16_384 });
} catch (error) {
  failed = true;
  evidence.error = error instanceof Error ? error.message : String(error);
  if (error?.evidence) evidence.failureEvidence = error.evidence;
} finally {
  if (connected && started) {
    try {
      evidence.stop = await call("stop");
    } catch (error) {
      failed = true;
      evidence.stopError = error instanceof Error ? error.message : String(error);
    }
  }
  if (connected) {
    try {
      evidence.after = await call("status");
    } catch (error) {
      failed = true;
      evidence.statusError = error instanceof Error ? error.message : String(error);
    }
    try {
      await client.close();
    } catch (error) {
      failed = true;
      evidence.closeError = error instanceof Error ? error.message : String(error);
    }
  }
  delete evidence.startedAt;
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  if (failed) process.exitCode = 1;
}
