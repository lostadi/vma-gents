import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("MCP exposes truthful lifecycle and native capability tools", async () => {
  const transport = new StdioClientTransport({
    command: path.join(projectRoot, "bin", "claude-vm-mcp"),
    args: [],
  });
  const client = new Client({ name: "claude-vm-test", version: "1.0.0" });
  await client.connect(transport);
  try {
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map(({ name }) => name),
      ["status", "start", "console", "cycle", "exec_cycle", "native_capabilities", "native_call", "stop"],
    );
    const start = listed.tools.find(({ name }) => name === "start");
    assert.equal(start.annotations.readOnlyHint, false);
    assert.equal(start.annotations.destructiveHint, true);
    const consoleTool = listed.tools.find(({ name }) => name === "console");
    assert.equal(consoleTool.inputSchema.properties.maxBytes.default, 8192);
    assert.equal(consoleTool.inputSchema.properties.maxBytes.maximum, 65_536);
    const cycle = listed.tools.find(({ name }) => name === "cycle");
    assert.equal(cycle.annotations.destructiveHint, true);
    assert.equal(cycle.annotations.idempotentHint, false);
    assert.equal(cycle.inputSchema.properties.maxBytes.default, 4096);
    const execCycle = listed.tools.find(({ name }) => name === "exec_cycle");
    assert.equal(execCycle.annotations.readOnlyHint, false);
    assert.equal(execCycle.annotations.destructiveHint, true);
    assert.equal(execCycle.annotations.idempotentHint, false);
    assert.equal(execCycle.annotations.openWorldHint, true);
    assert.match(execCycle.description, /configured network mode/);
    assert.equal(execCycle.inputSchema.properties.timeoutSeconds.default, 10);
    assert.equal(execCycle.inputSchema.properties.timeoutSeconds.maximum, 30);
    assert.equal(execCycle.inputSchema.properties.args.maxItems, 8);
    assert.deepEqual(execCycle.inputSchema.properties.program.enum, ["uname", "id", "python3", "git"]);
    assert.deepEqual(Object.keys(execCycle.inputSchema.properties).sort(), ["args", "program", "timeoutSeconds"]);
    const nativeCapabilities = listed.tools.find(({ name }) => name === "native_capabilities");
    assert.equal(nativeCapabilities.annotations.readOnlyHint, true);
    assert.equal(nativeCapabilities.annotations.destructiveHint, false);
    const nativeCall = listed.tools.find(({ name }) => name === "native_call");
    assert.equal(nativeCall.annotations.readOnlyHint, false);
    assert.equal(nativeCall.annotations.destructiveHint, true);
    assert.equal(nativeCall.inputSchema.properties.args.maxItems, 8);
    const status = await client.callTool({ name: "status", arguments: {} });
    const body = JSON.parse(status.content[0].text);
    if (!existsSync(path.join(projectRoot, "vm", "claudevm.bundle"))) {
      assert.equal(status.isError, true);
      assert.match(body.error, /ENOENT|no such file/i);
      return;
    }
    assert.notEqual(status.isError, true);
    assert.equal(body.sourcePathIsolationVerified, true);
    assert.equal(body.lifecycle.backend, "swift-virtualization");
    assert.equal(body.lifetime.mode, "transaction");
    assert.equal(body.lifetime.runnerPid, null);
    assert.equal(body.policy.networkMode, "nat");
    assert.equal(body.policy.guestExecutionEnabled, true);
    assert.equal(body.policy.defaultGuestTimeoutSeconds, 10);
    assert.equal(body.policy.maximumGuestTimeoutSeconds, 30);
    assert.equal(body.policy.maximumGuestOutputBytes, 32 * 1024);
    assert.equal(typeof body.native.allowAct, "boolean");
    assert.equal(typeof body.native.providers["claude-native"].available, "boolean");
  } finally {
    await client.close();
  }
});
