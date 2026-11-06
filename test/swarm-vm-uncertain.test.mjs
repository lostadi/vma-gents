import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PocketSwarm } from "../src/pocket-swarm.mjs";
import { SwarmVMFleet } from "../src/swarm-vm.mjs";

async function fixture(t, body, overrides = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ovm-local-uncertain-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binaryPath = path.join(directory, "native-stub");
  const bundlePath = path.join(directory, "guest.bundle");
  const smolPath = path.join(directory, "helper.img");
  const marker = path.join(directory, "effects.txt");
  await mkdir(bundlePath);
  await writeFile(smolPath, "test helper");
  await writeFile(binaryPath, `#!${process.execPath}\n` +
    `const fs = require("node:fs");\nlet input = "";\n` +
    `process.stdin.on("data", chunk => input += chunk);\n` +
    `process.stdin.on("end", () => {\nconst tasks = JSON.parse(input);\n` +
    `fs.appendFileSync(${JSON.stringify(marker)}, "effect\\n");\n${body}\n});\n`);
  await chmod(binaryPath, 0o700);
  const fleet = new SwarmVMFleet({ binaryPath, bundlePath, smolPath,
    projectRoot: directory, stateDirectory: directory,
    networkMode: "isolated", distributionMode: "local",
    prepareRuntime: async () => ({ schema: "test-profile" }),
    upgradeRuntime: async () => ({ profile: { schema: "test-profile" } }),
    recordRuntime: async () => {}, ...overrides });
  return { directory, marker, binaryPath, fleet };
}

const tasks = [{ agentId: "builder", command: "append once" }];
for (const [label, body, overrides, pattern] of [
  ["invalid JSON", 'process.stdout.write("broken-json");', {}, /invalid JSON/],
  ["unsuccessful native exit", "process.exitCode = 9;", {}, /exit=9/],
  ["native timeout", "setInterval(() => {}, 1000);", { timeoutMilliseconds: 1000 }, /exceeded 1000ms/],
  ["output overflow", 'process.stdout.write("x".repeat(9 * 1024 * 1024));', {}, /output limit/],
]) {
  test(`local ${label} preserves uncertainty after a side effect`, async t => {
    const { fleet, marker } = await fixture(t, body, overrides);
    await assert.rejects(fleet.run(tasks), error => {
      assert.equal(error.uncertain, true);
      assert.match(error.message, pattern);
      return true;
    });
    assert.equal(await readFile(marker, "utf8"), "effect\n");
  });
}

test("a failed receipt write remains uncertain after a stopped worker ran", async t => {
  const { fleet, marker } = await fixture(t,
    'fs.writeFileSync(tasks[0].preserveRootfs, "private guest data");\n' +
    'process.stdout.write(JSON.stringify({ workers: [{ agent: "builder", stopped: true, exitCode: 0 }] }));',
    { recordRuntime: async () => { throw new Error("receipt write failed"); } });
  await assert.rejects(fleet.run(tasks), error => error.uncertain === true && error.message === "receipt write failed");
  assert.equal(await readFile(marker, "utf8"), "effect\n");
  assert.equal(await readFile(fleet.rootfsPath("builder"), "utf8"), "private guest data");
});

test("a failure before native spawn is safe to report without claiming execution", async t => {
  const { fleet, binaryPath, marker } = await fixture(t, "");
  await writeFile(binaryPath, "#!/nonexistent/ovm-test-interpreter\n");
  await assert.rejects(fleet.run(tasks), error => error.code === "ENOENT" && error.uncertain !== true);
  assert.equal(existsSync(marker), false);
});

test("an uncertain local result stops reasoning and survives resume without replay", async t => {
  const { fleet, directory, marker } = await fixture(t, 'process.stdout.write("lost-result");');
  let decisions = 0;
  const options = { mission: "append once", agents: [{ id: "builder", role: "build" }],
    vmFleet: fleet, nativeBroker: { describe: async () => ({ operations: [] }) },
    stateDirectory: directory, swarmId: "local-recovery", maximumRounds: 3,
    modelClient: { async decide() {
      decisions += 1;
      return { content: JSON.stringify({ actions: [{ type: "vm", command: "append once" }] }) };
    } } };
  const first = await new PocketSwarm(options).run();
  assert.equal(first.blocked.kind, "vm-outcome-unknown");
  const saved = JSON.parse(await readFile(path.join(directory, "swarm.json"), "utf8"));
  assert.equal(saved.pendingDispatch.phase, "outcome-unknown");
  assert.equal(saved.pendingDispatch.tasks[0].command, "append once");
  const resumed = await new PocketSwarm({ ...options, resumeState: saved }).run();
  assert.equal(resumed.blocked.kind, "vm-outcome-unknown");
  assert.equal(resumed.additionalRounds, 0);
  assert.equal(decisions, 1);
  assert.equal(await readFile(marker, "utf8"), "effect\n");
});
