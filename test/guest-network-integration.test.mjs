import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SwiftVM } from "../src/swift-vm.mjs";
import { SwarmVMFleet } from "../src/swarm-vm.mjs";
import { prepareLaunchNetwork, prepareRuntimeForLaunch } from "../src/guest-network.mjs";
import { preparedImageReceiptPath } from "../src/guest-manager.mjs";

const settings = { bundlePath: "/unused/bundle", runnerPath: "/unused/runner", smolPath: "/unused/smol", sharePath: "/unused/share", memoryGB: 1, cpuCount: 1, startupTimeoutSeconds: 1 };

class ObservedVM extends SwiftVM {
  get hasLiveProcess() { return this.live ?? false; }
  async oneShot(mode) { this.lastInspectionArgs = this.runnerArguments(mode); return { supported: true, configurationValid: true }; }
  spawnPersistent() { this.spawnedArgs = this.runnerArguments("run"); this.live = true; }
  async waitFor() { return { event: "vsock_connected" }; }
  async request() { return { running: true, vsockConnected: true }; }
  async status() { return { running: this.hasLiveProcess }; }
}

test("Swift probes never provision networking; real start prepares before spawning", async () => {
  let prepared = 0;
  const vm = new ObservedVM({ ...settings, prepareNetwork: async () => { prepared += 1; assert.equal(vm.live, undefined); return { shareDir: "/private/guest-identity" }; } });
  await vm.probe();
  assert.equal(prepared, 0);
  assert.equal(vm.lastInspectionArgs.includes("--network-share"), false);
  await vm.start();
  assert.equal(prepared, 1);
  assert.deepEqual(vm.spawnedArgs.slice(-2), ["--network-share", "/private/guest-identity"]);
  await vm.start();
  assert.equal(prepared, 1);
});

test("fleet keeps inherited roots and local concurrency when optional mesh preparation fails", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ovm-fleet-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDirectory = path.join(root, "state");
  const bundlePath = path.join(root, "bundle");
  const binaryPath = path.join(root, "fake-runner");
  const smolPath = path.join(root, "smol");
  await mkdir(stateDirectory); await mkdir(bundlePath); await writeFile(smolPath, "fake");
  const parent = path.join(stateDirectory, "parent.rootfs.img");
  await writeFile(parent, "existing user work");
  await writeFile(binaryPath, `#!/usr/bin/env node
const fs=await import('node:fs/promises');
let input='';for await(const chunk of process.stdin)input+=chunk;
const tasks=JSON.parse(input);
for(const task of tasks){
  if(task.baseRootfs)await fs.copyFile(task.baseRootfs,task.preserveRootfs);
  else await fs.writeFile(task.preserveRootfs,'fresh prepared base');
}
process.stdout.write(JSON.stringify({workers:tasks.map(task=>({agent:task.name,stopped:true,exitCode:0,networkShare:task.networkShare,distributionMode:task.distributionMode}))}));
`, { mode: 0o700 });
  const steps = [];
  const baseProfile = { sourceCommit: "base" }, inheritedProfile = { sourceCommit: "parent" };
  const recorded = [];
  const fleet = new SwarmVMFleet({ binaryPath, bundlePath, smolPath, stateDirectory, projectRoot: root, networkMode: "nat", distributionMode: "auto",
    prepareRuntime: async () => { steps.push("base"); return baseProfile; },
    upgradeRuntime: async (options) => { assert.equal(options.rootfsPath, parent); assert.equal(options.stateDirectory, stateDirectory); steps.push("upgrade"); return { profile: inheritedProfile }; },
    recordRuntime: async ({ rootfsPath, profile }) => { recorded.push([path.basename(rootfsPath), profile]); await writeFile(preparedImageReceiptPath(rootfsPath), JSON.stringify(profile)); },
    prepareNetwork: (options) => prepareLaunchNetwork(options, { startNetwork: async () => { throw new Error("peer network unavailable"); } }),
  });
  await fleet.probe();
  assert.deepEqual(steps, []);
  const workers = await fleet.run([{ agentId: "child1", command: "true", inheritRootfs: parent }, { agentId: "child2", command: "true", inheritRootfs: parent }, { agentId: "fresh", command: "true" }]);
  assert.equal(new Set(workers.map((worker) => worker.networkShare)).size, 3);
  for (const worker of workers) {
    const launch = JSON.parse(await readFile(path.join(worker.networkShare, "launch.json"), "utf8"));
    assert.equal(launch.meshConfigured, false);
    assert.equal(worker.distributionMode, "auto");
    assert.match(launch.fallbackReason, /peer network unavailable/);
  }
  assert.deepEqual(steps, ["base", "upgrade"]);
  assert.deepEqual(recorded, [["child1.rootfs.img", inheritedProfile], ["child2.rootfs.img", inheritedProfile], ["fresh.rootfs.img", baseProfile]]);
  assert.equal(await readFile(path.join(stateDirectory, "child1.rootfs.img"), "utf8"), "existing user work");
  assert.equal(await readFile(parent, "utf8"), "existing user work");
  const rejected = new SwarmVMFleet({ binaryPath, bundlePath, smolPath, stateDirectory, networkMode: "isolated",
    prepareRuntime: async () => { throw new Error("unprepared base"); },
    upgradeRuntime: async () => assert.fail("must stop before opening any image"),
  });
  await assert.rejects(rejected.run([{ agentId: "blocked", command: "false" }]), /unprepared base/);
});

test("native launch preparation checks the selected base and upgrades the actual inherited source", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ovm-native-preparation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundlePath = path.join(root, "selected.bundle");
  const inherited = path.join(root, "parent.img");
  await writeFile(inherited, "old guest work");
  const calls = [];
  const implementations = {
    ensurePreparedImage: async (options) => { calls.push(["base", options.bundlePath]); return { sourceCommit: "verified" }; },
    upgradePreparedImage: async (options) => { calls.push(["upgrade", options.rootfsPath]); },
    preparedImageReceiptPath,
  };
  const fresh = await prepareRuntimeForLaunch({ projectRoot: root, bundlePath, guestId: `rootfs:${root}/new.img` }, implementations);
  assert.equal(fresh.runtimePrepared, true);
  assert.equal(fresh.runtimeProfilePath, path.join(bundlePath, ".ovm-guest-v1.json"));
  const child = await prepareRuntimeForLaunch({ projectRoot: root, bundlePath, guestId: `rootfs:${root}/child.img`, rootfsPath: inherited }, implementations);
  assert.equal(child.runtimeProfilePath, preparedImageReceiptPath(inherited));
  assert.deepEqual(calls, [["base", bundlePath], ["base", bundlePath], ["upgrade", inherited]]);
  await assert.rejects(prepareRuntimeForLaunch({ projectRoot: root, bundlePath, rootfsPath: path.join(root, "missing.img") }, implementations), /source image does not exist/);
});

test("explicit isolated Swift start never provisions a network identity", async () => {
  const vm = new ObservedVM({ ...settings, networkMode: "isolated", prepareNetwork: () => { throw new Error("must not run"); } });
  await vm.start();
  assert.equal(vm.spawnedArgs.includes("--network-share"), false);
  assert.equal(vm.spawnedArgs[vm.spawnedArgs.indexOf("--network") + 1], "isolated");
});

test("Swift auto fallback passes a local identity share without dropping NAT or retrying mesh", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ovm-swift-local-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let attempted = 0;
  const vm = new ObservedVM({ ...settings, distributionMode: "auto", prepareNetwork: (options) =>
    prepareLaunchNetwork({ ...options, projectRoot: root, guestId: "bundle:/example" }, {
      startNetwork: async () => { attempted += 1; throw new Error("mesh offline"); },
    }),
  });
  await vm.start();
  assert.equal(attempted, 1);
  assert.equal(vm.spawnedArgs[vm.spawnedArgs.indexOf("--network") + 1], "nat");
  assert.equal(vm.spawnedArgs[vm.spawnedArgs.indexOf("--distribution") + 1], "auto");
  assert.ok(vm.spawnedArgs.includes("--network-share"));
  assert.equal(vm.distribution.meshConfigured, false);
  assert.equal(vm.distribution.effectiveDistributionMode, "local");
  const required = new ObservedVM({ ...settings, distributionMode: "required", prepareNetwork: (options) =>
    prepareLaunchNetwork({ ...options, projectRoot: root, guestId: "bundle:/required" }, { startNetwork: async () => { throw new Error("mesh offline"); } }),
  });
  await assert.rejects(required.start(), /mesh offline/);
  assert.equal(required.spawnedArgs, undefined);
});

test("fleet allocates unique mounted identities before dispatch, with stable descendant IDs", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ovm-fleet-network-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binaryPath = path.join(root, "fake-runner");
  await writeFile(binaryPath, `#!/usr/bin/env node\nlet data='';for await(const chunk of process.stdin)data+=chunk;process.stdout.write(JSON.stringify({workers:JSON.parse(data).map(task=>({...task,argv:process.argv.slice(2)}))}));\n`, { mode: 0o700 });
  const bundlePath = path.join(root, "bundle");
  const smolPath = path.join(root, "smol");
  await mkdir(bundlePath);
  await writeFile(smolPath, "fake");
  const stateDirectory = path.join(root, "state");
  const observed = [];
  const fleet = new SwarmVMFleet({ binaryPath, bundlePath, smolPath, stateDirectory, prepareRuntime: async () => ({}), networkMode: "nat", prepareNetwork: async ({ guestId, agentId }) => {
    observed.push(guestId);
    return { shareDir: path.join(root, `identity-${agentId}`) };
  } });
  await fleet.probe();
  assert.equal(observed.length, 0);
  const workers = await fleet.run([{ agentId: "parent", command: "true" }, { agentId: "child", command: "true", inheritRootfs: path.join(stateDirectory, "parent.rootfs.img") }]);
  assert.deepEqual(observed, [`rootfs:${stateDirectory}/parent.rootfs.img`, `rootfs:${stateDirectory}/child.rootfs.img`]);
  assert.notEqual(workers[0].networkShare, workers[1].networkShare);
  assert.equal(workers[0].timeoutSeconds, 60);
  assert.equal(fleet.timeoutMilliseconds, 90_000);
  assert.ok(workers[0].argv.includes("nat"));
  const isolated = new SwarmVMFleet({ binaryPath, bundlePath, smolPath, stateDirectory, prepareRuntime: async () => ({}), networkMode: "isolated", prepareNetwork: () => { throw new Error("must not run"); } });
  const offline = await isolated.run([{ agentId: "offline", command: "true" }]);
  assert.equal(offline[0].networkShare, undefined);
  assert.ok(offline[0].argv.includes("isolated"));
});
