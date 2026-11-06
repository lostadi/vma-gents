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
const client = new Client({ name: "ostadix-claude-vm-cycle", version: "1.0.0" });
const requestOptions = { timeout: 180_000, maxTotalTimeout: 180_000 };
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

try {
  await client.connect(transport, requestOptions);
  connected = true;
  evidence.tools = (await client.listTools(undefined, requestOptions)).tools.map(({ name }) => name);
  evidence.before = await call("status");
  evidence.cycle = await call("cycle", {
    stream: "hvc1",
    maxBytes: 4096,
    settleMilliseconds: 500,
  });
  evidence.after = await call("status");
  if (!evidence.cycle.completed || evidence.after.lifecycle.running || evidence.after.controllerLease.held) {
    throw new Error("transaction returned without a verified stopped and unlocked state");
  }
} catch (error) {
  failed = true;
  evidence.error = error instanceof Error ? error.message : String(error);
  if (error?.evidence) evidence.failureEvidence = error.evidence;
  if (connected) {
    try { evidence.afterFailure = await call("status"); } catch (statusError) {
      evidence.statusError = statusError instanceof Error ? statusError.message : String(statusError);
    }
  }
} finally {
  if (connected) await client.close();
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  if (failed) process.exitCode = 1;
}
