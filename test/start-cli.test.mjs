import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { runStart } from "../src/start-cli.mjs";

test("terminal startup opens chat, keeps arguments literal, and returns the child exit code", async () => {
  const prompt = 'Print "$HOME"; $(touch do-not-create)';
  const args = ["--local", prompt];
  let call, message = "";
  const environment = { OVM_SWARM_MODEL: "selected:latest" };
  const code = await runStart(args, {
    root: "/project with spaces", input: { isTTY: true }, environment,
    progress: { write(value) { message += value; } },
    run: async (...invocation) => { call = invocation; return 7; },
  });
  assert.deepEqual(call, [process.execPath, ["/project with spaces/bin/gent", "chat", ...args], { env: environment }]);
  assert.equal(code, 7);
  assert.match(message, /\/bye.*npm run mcp/);
});

test("explicit chat arguments work without a terminal, including help", async () => {
  for (const args of [["--help"], ["--resume", "saved-agent", "hello"]]) {
    await runStart(args, {
      root: "/project", input: {}, progress: { write() { assert.fail("no startup banner on a pipe"); } },
      run: async (file, actual) => {
        assert.equal(file, process.execPath);
        assert.deepEqual(actual, ["/project/bin/gent", "chat", ...args]);
        return 0;
      },
    });
  }
});

test("piped startup retains a clean MCP handshake and tool listing without booting a VM", { timeout: 15_000 }, async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const client = new Client({ name: "ovm-start-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [path.join(root, "scripts/start.mjs")],
    env: { ...process.env, CLAUDE_VM_LIFETIME: "transaction" },
  });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.ok(tools.some(tool => tool.name === "exec_cycle"));
    assert.ok(tools.some(tool => tool.name === "native_capabilities"));
  } finally {
    await client.close();
  }
});
