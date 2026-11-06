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
const client = new Client({ name: "claude-vm-live-smoke", version: "1.0.0" });
const requestOptions = { timeout: 180_000, maxTotalTimeout: 180_000 };
const evidence = {};
let connected = false;
let startInvoked = false;

function decode(reply, tool) {
  const block = reply.content?.find((item) => item.type === "text");
  const body = block ? JSON.parse(block.text) : {};
  if (reply.isError) throw new Error(`${tool}: ${body.error ?? "unknown MCP error"}`);
  return body;
}

async function call(tool, arguments_ = {}) {
  return decode(await client.callTool(
    { name: tool, arguments: arguments_ },
    undefined,
    requestOptions,
  ), tool);
}

try {
  await client.connect(transport, requestOptions);
  connected = true;
  evidence.tools = (await client.listTools(undefined, requestOptions)).tools.map(({ name }) => name);
  evidence.before = await call("status");
  startInvoked = true;
  evidence.start = await call("start");
  evidence.running = await call("status");
  evidence.console = {
    hvc0: (await call("console", { stream: "hvc0", maxBytes: 8192 })).text ?? "",
    hvc1: (await call("console", { stream: "hvc1", maxBytes: 8192 })).text ?? "",
  };
} finally {
  if (connected && startInvoked) {
    try {
      evidence.stop = await call("stop");
      evidence.after = await call("status");
    } catch (error) {
      evidence.cleanupError = error instanceof Error ? error.message : String(error);
    }
  }
  if (connected) await client.close();
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}
