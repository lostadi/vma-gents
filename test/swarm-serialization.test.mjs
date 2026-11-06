import test from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseAgentDecision } from "../src/swarm-protocol.mjs";

const execute = promisify(execFileCallback);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const swiftAvailable = process.platform === "darwin" && process.arch === "arm64"
  && spawnSync("/usr/bin/xcrun", ["--find", "swiftc"], { stdio: "ignore" }).status === 0;
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

test("Swift transports command bytes exactly through quoted heredocs without appending reason metadata", {
  skip: swiftAvailable ? false : "requires Apple Silicon and Xcode Command Line Tools", timeout: 60_000,
}, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "ovm-command-serialization-"));
  try {
    const sourcePath = path.join(root, "host/OVMSwarm.swift");
    const source = await readFile(sourcePath, "utf8");
    const encoding = source.match(/let commandBase64 = [^\n]+/);
    const payload = source.match(/let payload = """\n[\s\S]*?\n"""/);
    assert.ok(encoding && payload, "test must extract the actual production serialization statements");
    const fixture = (await readFile(path.join(root, "test/fixtures/swarm-serialization-main.swift"), "utf8"))
      .replace("__SWARM_COMMAND_ENCODING__", () => encoding[0]).replace("__SWARM_PAYLOAD__", () => payload[0]);
    const fixturePath = path.join(temporary, "serialization-main.swift");
    const binary = path.join(temporary, "serialization-test");
    await writeFile(fixturePath, fixture);
    await execute("/usr/bin/xcrun", ["--sdk", "macosx", "swiftc", "-parse-as-library", "-swift-version", "5",
      "-D", "OVM_BARRIER_TEST", "-framework", "Virtualization", sourcePath, fixturePath, "-o", binary], { timeout: 45_000 });
    const roundTrip = async (command, reason) => {
      const decision = parseAgentDecision(JSON.stringify({ actions: [{ type: "vm", command, reason }] }), { peerIds: [], nativeOperations: [] });
      const task = { name: "builder", command: decision.actions[0].command, reason: decision.actions[0].reason };
      const result = spawnSync(binary, [], { input: JSON.stringify(task), encoding: "utf8", timeout: 3_000 });
      assert.equal(result.status, 0, result.stderr);
      const wrapper = result.stdout;
      assert.equal(wrapper.split("\n").filter(line => line === "SCRIPT_EOF").length, 1, "command heredocs cannot terminate the outer wrapper");
      assert.equal(wrapper.includes(reason), false);
      const transfer = wrapper.split("\n").find(line => line.startsWith("printf '%s' ") && line.endsWith("| base64 -d > /tmp/agent_task.sh"));
      assert.ok(transfer);
      const commandPath = path.join(temporary, "agent_task.sh");
      await execute("/bin/bash", ["-c", transfer.replace("/tmp/agent_task.sh", quote(commandPath))]);
      assert.deepEqual(await readFile(commandPath), Buffer.from(task.command), "UTF-8 command bytes survive unchanged");
      return { commandPath, task };
    };
    const literal = "$HOME $(printf should-not-expand) `printf neither` 'single' \"double\" λ 你好";
    const program = `cat <<'SCRIPT_EOF'\n${literal}\nSCRIPT_EOF\nprintf '%s\\n' 'complete'`;
    const { commandPath } = await roundTrip(program, "reason metadata is not a shell statement");
    await execute("/bin/bash", ["-n", commandPath]);
    assert.equal((await execute("/bin/bash", [commandPath])).stdout, `${literal}\ncomplete\n`);

    // The historical failure had reason: inside command itself. Preserve that
    // input transparently; Bash's diagnostic adds the second colon.
    const malformed = await roundTrip("printf '%s\\n' 'before'\nreason:", "separate explanation");
    const failure = spawnSync("/bin/bash", [malformed.commandPath], { encoding: "utf8" });
    assert.equal(failure.status, 127);
    assert.equal(failure.stdout, "before\n");
    assert.match(failure.stderr, /reason:: command not found/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
