import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NativeCapabilityBroker } from "../src/native-capabilities.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerPath = path.join(projectRoot, "src", "native-worker.cjs");

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ovm-native-test-"));
  const modulePath = path.join(root, "fixture.cjs");
  await writeFile(modulePath, `module.exports = {
    echo(value) { return { echoed: value }; },
    act(value) { return { acted: value }; },
    crash() { process.kill(process.pid, "SIGKILL"); }
  };\n`);
  const digest = createHash("sha256").update(await readFile(modulePath)).digest("hex");
  const catalogPath = path.join(root, "catalog.json");
  await writeFile(catalogPath, JSON.stringify({
    schema: "ovm.native-capabilities/test",
    providers: {
      fixture: {
        description: "test provider",
        moduleRelativePath: "fixture.cjs",
        binaryRelativePath: "fixture.cjs",
        qualifiedSha256: [digest],
      },
    },
    operations: [
      { name: "test.echo", provider: "fixture", memberPath: ["echo"], access: "observe", minimumArguments: 1, maximumArguments: 1, evidence: "test" },
      { name: "test.act", provider: "fixture", memberPath: ["act"], access: "act", minimumArguments: 1, maximumArguments: 1, evidence: "test" },
      { name: "test.crash", provider: "fixture", memberPath: ["crash"], access: "observe", minimumArguments: 0, maximumArguments: 0, evidence: "test" },
    ],
  }));
  return { root, catalogPath };
}

test("native broker verifies a provider and calls an observation in a worker", async () => {
  const f = await fixture();
  try {
    const broker = new NativeCapabilityBroker({ catalogPath: f.catalogPath, workerPath, roots: [f.root] });
    const description = await broker.describe();
    assert.equal(description.providers.fixture.qualified, true);
    assert.equal(description.operations.find(({ name }) => name === "test.echo").enabled, true);
    assert.deepEqual(await broker.call("test.echo", ["hello"]), {
      operation: "test.echo",
      provider: "fixture",
      providerSha256: description.providers.fixture.sha256,
      access: "observe",
      evidence: "test",
      value: { echoed: "hello" },
    });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("native actions require an owner-controlled capability switch", async () => {
  const f = await fixture();
  try {
    const denied = new NativeCapabilityBroker({ catalogPath: f.catalogPath, workerPath, roots: [f.root] });
    await assert.rejects(() => denied.call("test.act", [1]), /OVM_NATIVE_ALLOW_ACT=1/);
    const allowed = new NativeCapabilityBroker({ catalogPath: f.catalogPath, workerPath, roots: [f.root], allowAct: true });
    assert.deepEqual((await allowed.call("test.act", [1])).value, { acted: 1 });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("a crashing native addon worker cannot terminate the broker process", async () => {
  const f = await fixture();
  try {
    const broker = new NativeCapabilityBroker({ catalogPath: f.catalogPath, workerPath, roots: [f.root] });
    await assert.rejects(() => broker.call("test.crash", []), /invalid JSON|failed/);
    assert.deepEqual((await broker.call("test.echo", ["still-alive"])).value, { echoed: "still-alive" });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("native descriptions expose exact operation names, arity, and bounded host semantics", async () => {
  const broker = new NativeCapabilityBroker({ roots: [] });
  const description = await broker.describe();
  const find = name => description.operations.find(operation => operation.name === name);
  const apps = find("host.runningApps");
  assert.equal(apps.minimumArguments, 0);
  assert.equal(apps.maximumArguments, 0);
  assert.deepEqual(apps.argsSchema, { type: "array", minItems: 0, maxItems: 0, items: {} });
  assert.match(apps.description, /Takes no arguments/);
  assert.equal(find("runningApps"), undefined);
  const process = find("host.processRunning");
  assert.equal(process.argsSchema.minItems, 1);
  assert.equal(process.argsSchema.maxItems, 1);
  assert.equal(process.argsSchema.prefixItems[0].type, "string");
  assert.match(process.description, /Boolean/);
  assert.match(process.description, /Does not execute/);
  assert.match(find("host.appForFile").description, /not file contents/);
  assert.equal(find("host.typeTextPaced").argsSchema.prefixItems, undefined, "unqualified argument types must not be invented");
  assert.ok(description.operations.every(operation => operation.description.length <= 200));
  await assert.rejects(broker.call("host.runningApps", ["ignored?"]), /expects 0-0 arguments/);
  await assert.rejects(broker.call("host.processRunning", []), /expects 1-1 arguments/);
});
