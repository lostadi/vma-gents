import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, readlink, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { taskArguments, runChild, runUserCommand, runSetup, inspectReadiness, formatReadiness } from "../src/user-cli.mjs";

function capture() {
  let text = "";
  return { write(value) { text += value; }, get text() { return text; } };
}

const preparedGuest = async () => ({ prepared: true, verified: true, needsUpdate: false, errors: [] });
const runningNetwork = async () => ({ configured: true, localLighthouse: true, running: true });

test("task forwards an exact mission without host shell interpolation and starts only one agent", () => {
  const mission = 'Print "$HOME"; $(touch do-not-create) and words with spaces';
  assert.deepEqual(taskArguments([mission]), ["--mission", mission, "--agents", "1", "--max-agents", "2"]);
});

test("task permits multiple initial agents without implicit spreading and preserves explicit flags", () => {
  assert.deepEqual(taskArguments(["Do work", "--agents", "3", "--rounds=6", "--json", "--model", "model name", "--dry-run"]), ["--mission", "Do work", "--agents", "3", "--rounds", "6", "--json", "--model", "model name", "--dry-run", "--max-agents", "3"]);
  assert.deepEqual(taskArguments(["Do work", "--agents", "3", "--max-agents", "8"]), ["--mission", "Do work", "--agents", "3", "--max-agents", "8"]);
});

test("task accepts flags before the quoted mission and binds an explicit guest source", () => {
  assert.deepEqual(taskArguments(["--local", "--allow-native-act", "map the loopback interface"]), ["--mission", "map the loopback interface", "--local", "--allow-native-act", "--agents", "1", "--max-agents", "2"]);
  assert.deepEqual(taskArguments(["--source", "guest:/root/.bash_history", "inspect this source", "--rounds", "5"]), ["--mission", "inspect this source", "--source", "guest:/root/.bash_history", "--rounds", "5", "--agents", "1", "--max-agents", "2"]);
});

test("task and VM chat accept backend selection anywhere before literal mission text", async () => {
  assert.deepEqual(taskArguments(["--backend=qemu", "observe Linux"]), ["--mission", "observe Linux", "--backend", "qemu", "--agents", "1", "--max-agents", "2"]);
  assert.deepEqual(taskArguments(["observe Linux", "--backend", "auto"]), ["--mission", "observe Linux", "--backend", "auto", "--agents", "1", "--max-agents", "2"]);
  assert.deepEqual(taskArguments(["--", "--backend=qemu"]), ["--mission", "--backend=qemu", "--agents", "1", "--max-agents", "2"]);
  for (const flags of [["--backend", "bad"], ["--backend"], ["--backend", "apple", "--backend", "qemu"]]) assert.throws(() => taskArguments(["mission", ...flags]), /backend/);
  const calls = [];
  const options = { root: "/tmp/ovm", environment: { OVM_VM_BACKEND: "apple" }, run: async (...args) => { calls.push(args); return 0; } };
  await runUserCommand("task", ["mission", "--backend", "qemu"], options);
  await runUserCommand("chat", ["--backend", "qemu", "mission"], options);
  for (const call of calls) {
    assert.equal(call[1][call[1].indexOf("--backend") + 1], "qemu");
    assert.equal(call[2].env.OVM_VM_BACKEND, "apple", "explicit backend is forwarded for the child to resolve without mutating the environment");
  }
});

test("task specification preserves configured agent and spread choices", () => {
  const argv = ["Mission override", "--spec", "with spaces.json"];
  assert.deepEqual(taskArguments(argv, { readSpec: () => ({ agents: [{ id: "a" }, { id: "b" }] }) }), ["--mission", "Mission override", "--spec", "with spaces.json", "--max-agents", "2"]);
  assert.deepEqual(taskArguments(argv, { readSpec: () => ({ agentCount: 3, maximumAgents: 7 }) }), ["--mission", "Mission override", "--spec", "with spaces.json"]);
});

test("task rejects missing mission, missing option values, typos, and invalid limits", () => {
  for (const argv of [[], [""], ["--agents", "2"], ["mission", "--rounds"], ["mission", "--rounds", "--json"], ["mission", "--rounds", "3cats"], ["mission", "--agents", "9"], ["mission", "--agents", "2", "--max-agents", "1"], ["mission", "--agnts", "2"], ["mission", "accidental extra words"], ["mission", "--agents", "1", "--agents", "2"]]) {
    assert.throws(() => taskArguments(argv));
  }
});

test("chat routes environment and prompt as arguments and propagates child failure", async () => {
  let invocation;
  const result = await runUserCommand("chat", ["--text", "Explain", "a; $(command)"], {
    root: "/tmp/project with spaces", environment: { OVM_SWARM_MODEL: "selected:4b", OVM_OLLAMA_URL: "http://localhost:1234" },
    run: async (...args) => { invocation = args; return 7; },
  });
  assert.equal(result, 7);
  assert.deepEqual(invocation[0], "ollama");
  assert.deepEqual(invocation[1], ["run", "--think=false", "--", "selected:4b", "Explain a; $(command)"]);
  assert.equal(invocation[2].env.OLLAMA_HOST, "http://localhost:1234");
  assert.equal(invocation[2].cwd, "/tmp/project with spaces");
});

test("chat explains its interactive exit and task forwards JSON untouched", async () => {
  const output = capture();
  await runUserCommand("chat", ["--text"], { root: "/tmp/ovm", errorOutput: output, run: async () => 0 });
  assert.match(output.text, /\/bye/);
  let args;
  const code = await runUserCommand("task", ["safe mission", "--json"], { root: "/tmp/ovm", run: async (...invocation) => { args = invocation; return 2; } });
  assert.equal(code, 2);
  assert.equal(args[2].cwd, process.cwd());
  assert.deepEqual(args[1], ["/tmp/ovm/bin/ovm-pocket", "--mission", "safe mission", "--json", "--agents", "1", "--max-agents", "2"]);
});

test("task isolation reaches descendants through the environment without changing agent caps", async () => {
  let invocation;
  const environment = { OVM_NETWORK_MODE: "nat", CUSTOM_SETTING: "retained" };
  await runUserCommand("task", ["safe mission", "--agents", "2", "--isolated"], {
    root: "/tmp/ovm", environment,
    run: async (...args) => { invocation = args; return 0; },
  });
  assert.equal(invocation[2].env.OVM_NETWORK_MODE, "isolated");
  assert.equal(invocation[2].env.CUSTOM_SETTING, "retained");
  assert.equal(environment.OVM_NETWORK_MODE, "nat");
  assert.deepEqual(invocation[1], ["/tmp/ovm/bin/ovm-pocket", "--mission", "safe mission", "--agents", "2", "--max-agents", "2"]);
  assert.throws(() => taskArguments(["mission", "--isolated=false"]), /Unknown task option/);
});

test("task switches and help work before or after the mission without treating literal prompt text as flags", async () => {
  const calls = [], output = capture();
  const options = { root: '/tmp/ovm', environment: { OVM_NETWORK_MODE: 'nat' }, output, run: async (...args) => { calls.push(args); return 0; } };
  await runUserCommand('task', ['--isolated', 'observe networking'], options);
  assert.equal(calls[0][2].env.OVM_NETWORK_MODE, 'isolated');
  await runUserCommand('task', ['--', '--isolated'], options);
  assert.equal(calls[1][2].env.OVM_NETWORK_MODE, 'nat');
  assert.equal(calls[1][1][2], '--isolated');
  await runUserCommand('task', ['a mission', '--help'], options);
  assert.equal(calls.length, 2); assert.match(output.text, /Usage: gent task/);
});

test("text chat selects a model without passing execution options as model prose", async () => {
  let invocation;
  const options = { root: '/tmp/ovm', errorOutput: capture(), run: async (...args) => { invocation = args; return 0; } };
  await runUserCommand('chat', ['Explain', '--model=chosen:4b', '--text', 'this'], options);
  assert.deepEqual(invocation[1], ['run', '--think=false', '--', 'chosen:4b', 'Explain this']);
  await assert.rejects(runUserCommand('chat', ['--text', '--resume', 'saved'], options), /not supported by --text/);
  await runUserCommand('chat', ['--text', '--', '--resume is literal prompt text'], options);
  assert.equal(invocation[1].at(-1), '--resume is literal prompt text');
});

test("optional rsync setup failures preserve local setup while cancellation stops it", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ovm-optional-transfer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = capture(); let prepared = 0;
  const options = { environment: { OVM_INSTALL_BIN: path.join(root, 'bin'), OVM_DISTRIBUTION_MODE: 'auto' }, output,
    exists: () => true, installPrebuilt: async () => 0, availableCommand: () => true, inspectRsync: async () => ({ protocol: 29 }),
    prepareGuests: async () => { prepared++; return { prepared: true, verified: true }; }, prepareNetwork: async () => {},
    run: async (file, _args, settings) => { if (file === 'brew') { assert.equal(settings.env.HOMEBREW_NO_INSTALL_CLEANUP, '1'); throw new Error('package manager unavailable'); } return 0; },
  };
  assert.equal(await runSetup(root, options), 0); assert.equal(prepared, 1);
  assert.match(output.text, /Optional faster checkpoint setup failed/);
  assert.equal(await runSetup(root, { ...options, run: async file => file === 'brew' ? 130 : 0 }), 130);
  assert.equal(prepared, 1);
});

test("child launch uses inherited tty and argv with no shell; exits and signals are preserved", async () => {
  for (const [childCode, signal, expected] of [[7, null, 7], [null, "SIGINT", 130], [null, "SIGTERM", 143]]) {
    const signals = new EventEmitter();
    const child = new EventEmitter();
    child.kill = () => {};
    let options;
    const promise = runChild("test-program", ["a b"], { signals, spawnImpl: (_file, _args, opts) => { options = opts; return child; } });
    child.emit("close", childCode, signal);
    assert.equal(await promise, expected);
    assert.equal(options.stdio, "inherit");
    assert.equal(options.shell, false);
    assert.equal(signals.listenerCount("SIGINT"), 0);
  }
});

test("child launch failure is actionable and removes signal handlers", async () => {
  const signals = new EventEmitter();
  const child = new EventEmitter();
  const promise = runChild("missing-ollama", [], { signals, spawnImpl: () => child });
  const error = new Error("not found");
  error.code = "ENOENT";
  child.emit("error", error);
  await assert.rejects(promise, /Install it or add it to PATH.*gent check/);
  assert.equal(signals.listenerCount("SIGTERM"), 0);
});

test("parent termination is forwarded to its child", async () => {
  const signals = new EventEmitter();
  const child = new EventEmitter();
  let forwarded;
  child.kill = (signal) => { forwarded = signal; };
  const promise = runChild("program", [], { signals, spawnImpl: () => child });
  signals.emit("SIGTERM");
  assert.equal(forwarded, "SIGTERM");
  child.emit("close", null, "SIGTERM");
  assert.equal(await promise, 143);
});

test("readiness keeps successful probes separate from boot evidence and route-specific disk policy", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ovm-readiness-test-"));
  try {
    await writeFile(path.join(root, "policy.json"), JSON.stringify({ minimumFreeDiskGiB: 20, minimumFreeMemoryPercent: 35 }));
    const calls = [];
    const report = await inspectReadiness(root, {
      environment: { PATH: process.env.PATH, OVM_SWARM_MODEL: "test", CLAUDE_VM_LIFETIME: "process" }, nodeVersion: "26.0.0", platform: "darwin", architecture: "arm64", exists: () => true,
      guestStatus: preparedGuest, inspectNetwork: runningNetwork,
      fetchImpl: async () => ({ ok: true, json: async () => ({ models: [{ name: "test:latest" }] }) }),
      execute: async (file, args, options) => {
        calls.push([file, args]);
        if (args.includes("status")) assert.equal(options.env.CLAUDE_VM_LIFETIME, "transaction");
        return { stdout: JSON.stringify(args.includes("--probe") ? { supported: true, configurationValid: true } : { host: { freeDiskBytes: 10 * 1024 ** 3, freeMemoryPercent: 80 }, controllerLease: { held: false } }) };
      },
    });
    assert.equal(report.ollama.installed, true);
    assert.equal(report.taskPrerequisitesReady, true);
    assert.equal(report.vm.bootVerified, false);
    assert.equal(report.normalVmRoute.preflightComplete, false);
    assert.equal(report.ok, false);
    assert.match(report.normalVmRoute.blockers[0], /20 GiB.*10.0 GiB/);
    assert.equal(calls.length, 2);
    assert.match(formatReadiness(report), /does not boot a VM/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("readiness detects missing dependencies and model with no VM execution", async () => {
  let executions = 0;
  const report = await inspectReadiness("/missing-project", {
    environment: {}, exists: () => false, nodeVersion: "24.0.0", platform: "linux", architecture: "x64",
    fetchImpl: async () => ({ ok: true, json: async () => ({ models: [] }) }),
    execute: async () => { executions += 1; throw new Error("must not execute"); },
  });
  assert.equal(report.node.ready, false);
  assert.equal(report.dependencies.ready, false);
  assert.equal(report.ollama.reachable, true);
  assert.equal(report.ollama.installed, false);
  assert.equal(report.taskPrerequisitesReady, false);
  assert.equal(executions, 0);
});

test("check emits clean JSON with readiness exit status", async () => {
  const output = capture();
  const report = { ok: false, reason: "known test blocker" };
  const code = await runUserCommand("check", ["--json"], { root: "/tmp", output, inspect: async () => report });
  assert.equal(code, 2);
  assert.deepEqual(JSON.parse(output.text), report);
});

test("check accepts an explicit backend without altering its environment", async () => {
  const output = capture(), calls = [];
  const environment = { OVM_VM_BACKEND: "apple" };
  const options = { root: "/tmp", output, environment, inspect: async (_root, settings) => { calls.push(settings); return { ok: true }; } };
  assert.equal(await runUserCommand("check", ["--backend", "qemu", "--json"], options), 0);
  assert.equal(await runUserCommand("check", ["--json", "--backend=auto"], options), 0);
  assert.deepEqual(calls, [{ environment, backend: "qemu" }, { environment, backend: "auto" }]);
  for (const args of [["--backend"], ["--backend=wrong"], ["--backend", "qemu", "--backend", "apple"]]) await assert.rejects(runUserCommand("check", args, options), /backend/);
});

test("QEMU readiness uses prepared guest and QEMU tools without private Apple executables or policy", async () => {
  const calls = [];
  const options = {
    environment: { OVM_SWARM_MODEL: "test", OVM_VM_BACKEND: "apple" }, backend: "qemu",
    nodeVersion: "26.0.0", platform: "linux", architecture: "x64",
    exists: file => !/OVMSwarm|ClaudeVZRunner|smol-bin/.test(file), guestStatus: preparedGuest, inspectNetwork: runningNetwork,
    fetchImpl: async () => ({ ok: true, json: async () => ({ models: [{ name: "test" }] }) }),
    execute: async () => assert.fail("QEMU readiness must not invoke Apple status or probe"),
    inspectQemuTools: async settings => { calls.push(settings); return { binary: "/usr/bin/qemu-system-aarch64", mke2fs: "/usr/sbin/mke2fs", python: "/usr/bin/python3", lsof: "/usr/bin/lsof", accelerator: "tcg" }; },
  };
  const report = await inspectReadiness("/missing-qemu-project", options);
  assert.equal(report.vm.backend, "qemu");
  assert.equal(report.vm.configurationValid, true);
  assert.deepEqual(Object.keys(report.vm.inputs).sort(), ["initrd", "kernel", "qemuSupervisor", "qemuWorker", "rootfs"]);
  assert.equal(report.taskPrerequisitesReady, true);
  assert.equal(report.ok, true);
  assert.equal(report.normalVmRoute.applicable, false);
  assert.deepEqual(report.normalVmRoute.blockers, []);
  assert.equal(report.vm.bootVerified, false);
  assert.equal(calls[0].platform, "linux");
  assert.match(formatReadiness(report), /QEMU inputs and tools: OK/);
  assert.match(formatReadiness(report), /does not boot a VM/);
  const automatic = await inspectReadiness("/missing-qemu-project", { ...options, backend: "auto" });
  assert.equal(automatic.vm.backend, "qemu", "explicit auto overrides the Apple environment setting on Linux");
  const environmentSelected = await inspectReadiness("/missing-qemu-project", { ...options, backend: undefined, environment: { ...options.environment, OVM_VM_BACKEND: "qemu" }, platform: "darwin", architecture: "arm64" });
  assert.equal(environmentSelected.vm.backend, "qemu");
  for (const missing of ["binary", "mke2fs", "python", "lsof"]) {
    const absent = await inspectReadiness("/missing-qemu-project", { ...options, inspectQemuTools: async () => ({ ...report.vm.tools, [missing]: null }) });
    assert.equal(absent.taskPrerequisitesReady, false);
    assert.equal(absent.vm.configurationValid, false);
  }
  const missingBundle = await inspectReadiness("/missing-qemu-project", { ...options, exists: file => !file.endsWith("rootfs.img") });
  assert.equal(missingBundle.taskPrerequisitesReady, false);
  const unprepared = await inspectReadiness("/missing-qemu-project", { ...options, guestStatus: async () => ({ prepared: false, verified: false }) });
  assert.equal(unprepared.taskPrerequisitesReady, false);
  assert.match(formatReadiness(unprepared), /Fresh guest provisioning currently uses Apple Silicon macOS/);
  const outdated = await inspectReadiness("/missing-qemu-project", { ...options, guestStatus: async () => ({ ...await preparedGuest(), needsUpdate: true }) });
  assert.equal(outdated.taskPrerequisitesReady, false);
});

test("readiness reports guest profile and network independently without booting or starting services", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ovm-profile-readiness-"));
  try {
    await writeFile(path.join(root, "policy.json"), JSON.stringify({ minimumFreeDiskGiB: 20, minimumFreeMemoryPercent: 35 }));
    const options = {
      environment: { OVM_SWARM_MODEL: "test" }, nodeVersion: "26.0.0", platform: "darwin", architecture: "arm64", exists: () => true,
      fetchImpl: async () => ({ ok: true, json: async () => ({ models: [{ name: "test" }] }) }),
      execute: async (_file, args) => {
        assert.ok(args.includes("--probe") || args.includes("status"), "only nonexecuting probes are permitted");
        return { stdout: JSON.stringify(args.includes("--probe") ? { supported: true, configurationValid: true } : { host: { freeDiskBytes: 30 * 1024 ** 3, freeMemoryPercent: 80 } }) };
      },
      guestStatus: async () => ({ prepared: false, verified: false, errors: ["Run: ovm guests setup"] }),
      inspectNetwork: async () => ({ configured: false }),
    };
    const absent = await inspectReadiness(root, options);
    assert.equal(absent.guest.ready, false);
    assert.equal(absent.network.ready, true);
    assert.equal(absent.network.meshConfigured, false);
    assert.equal(absent.taskPrerequisitesReady, false);
    assert.match(formatReadiness(absent), /Prepared guest tools: NEEDS ATTENTION/);
    const outdated = await inspectReadiness(root, { ...options, guestStatus: async () => ({ ...await preparedGuest(), needsUpdate: true }), inspectNetwork: runningNetwork });
    assert.equal(outdated.guest.ready, false);
    assert.equal(outdated.network.ready, true);
    const remote = await inspectReadiness(root, { ...options, guestStatus: preparedGuest, inspectNetwork: async () => ({ configured: true, localLighthouse: false, running: false }) });
    assert.equal(remote.taskPrerequisitesReady, true);
    assert.equal(remote.network.guestReachabilityVerified, false);
    assert.match(formatReadiness(remote), /Remote lighthouse configured.*reachability is not tested/);
    const isolated = await inspectReadiness(root, { ...options, environment: { ...options.environment, OVM_NETWORK_MODE: "isolated" }, guestStatus: preparedGuest, inspectNetwork: async () => assert.fail("isolation needs no network service") });
    assert.equal(isolated.taskPrerequisitesReady, true);
    assert.equal(isolated.network.mode, "isolated");
    const fallback = await inspectReadiness(root, { ...options, guestStatus: preparedGuest });
    assert.equal(fallback.taskPrerequisitesReady, true);
    const required = await inspectReadiness(root, { ...options, guestStatus: preparedGuest, environment: { ...options.environment, OVM_DISTRIBUTION_MODE: "required" } });
    assert.equal(required.network.ready, false);
    assert.equal(required.taskPrerequisitesReady, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("setup preserves existing VM/native inputs and stops on dependency failure", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ovm-setup-test-"));
  try {
    const calls = [];
    const output = capture();
    const environment = { OVM_INSTALL_BIN: path.join(root, "links"), PATH: "" };
    const code = await runSetup(root, { environment, output, exists: () => true, installPrebuilt: async () => 0, prepareGuests: preparedGuest, prepareNetwork: runningNetwork, run: async (file, args) => { calls.push([file, args]); return 0; } });
    assert.equal(code, 0);
    assert.deepEqual(calls, [["npm", ["ci"]], ["npm", ["run", "model:setup"]]]);
    assert.equal(await readlink(path.join(root, "links/gent")), path.join(root, "bin/gent"));
    assert.equal(await readlink(path.join(root, "links/ovm")), path.join(root, "bin/ovm"));
    assert.match(output.text, /o-gents command:/);
    assert.match(output.text, /Existing private VM bundle preserved/);
    calls.length = 0;
    assert.equal(await runSetup(root, { environment, output, run: async (file, args) => { calls.push([file, args]); return 9; } }), 9);
    assert.deepEqual(calls, [["npm", ["ci"]]]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("setup preserves an unrelated gent command and still installs the ovm compatibility link", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gent-setup-existing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const installBin = path.join(root, "links");
  await mkdir(installBin);
  await writeFile(path.join(installBin, "gent"), "keep this existing command\n");
  const output = capture();
  const code = await runSetup(root, {
    environment: { OVM_INSTALL_BIN: installBin, OVM_DISTRIBUTION_MODE: "local" }, output,
    exists: () => true, installPrebuilt: async () => 0, prepareGuests: preparedGuest,
    run: async () => 0,
  });
  assert.equal(code, 2);
  assert.equal(await readFile(path.join(installBin, "gent"), "utf8"), "keep this existing command\n");
  assert.equal(await readlink(path.join(installBin, "ovm")), path.join(root, "bin/ovm"));
  assert.match(output.text, /points elsewhere and was preserved/);
  assert.ok(output.text.includes(path.join(root, "bin/gent")));
});

test("setup explains remaining incompatible private inputs after failed installers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ovm-setup-test-"));
  try {
    const output = capture();
    const code = await runSetup(root, {
      environment: { OVM_INSTALL_BIN: path.join(root, "links") }, output, exists: () => false,
      installPrebuilt: async () => 65,
      prepareGuests: async () => assert.fail("incompatible VM inputs must prevent guest preparation"),
      prepareNetwork: async () => assert.fail("missing guest tools must prevent network startup"),
      run: async (file, args) => args[0] === "ci" || args[1] === "model:setup" ? 0 : 65,
    });
    assert.equal(code, 2);
    assert.match(output.text, /CLAUDE_VM_SMOL_SOURCE/);
    assert.match(output.text, /CLAUDE_VM_SOURCE_BUNDLE/);
    assert.match(output.text, /OVM_CLAUDE_EXTRACTED_ROOT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("setup copies only missing prebuilt outputs and preserves the existing helper", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ovm-partial-setup-test-"));
  try {
    for (const name of ["scripts", "host", "prebuilt", "compatibility"]) await mkdir(path.join(root, name));
    await writeFile(path.join(root, "scripts/install-prebuilt.zsh"), "test fixture; never executed");
    await writeFile(path.join(root, "host/entitlements.plist"), "fixture");
    await writeFile(path.join(root, "host/ClaudeVZRunner"), "preserve-runner");
    await writeFile(path.join(root, "host/smol-bin.arm64.img"), "preserve-helper");
    const code = await runSetup(root, {
      environment: { OVM_INSTALL_BIN: path.join(root, "links") }, output: capture(), exists: () => true,
      prepareGuests: preparedGuest, prepareNetwork: runningNetwork,
      run: async (file, args, options) => {
        if (file === "/bin/zsh") {
          assert.equal(options.env.CLAUDE_VM_SMOL_SOURCE, path.join(root, "host/smol-bin.arm64.img"));
          const stage = path.resolve(args[0], "../..");
          for (const name of ["ClaudeVZRunner", "OVMShell", "OVMSwarm", "smol-bin.arm64.img"]) await writeFile(path.join(stage, "host", name), `new-${name}`);
        }
        return 0;
      },
    });
    assert.equal(code, 0);
    assert.equal(await readFile(path.join(root, "host/ClaudeVZRunner"), "utf8"), "preserve-runner");
    assert.equal(await readFile(path.join(root, "host/smol-bin.arm64.img"), "utf8"), "preserve-helper");
    assert.equal(await readFile(path.join(root, "host/OVMSwarm"), "utf8"), "new-OVMSwarm");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("setup interruption stops remaining installation steps", async () => {
  const calls = [];
  const code = await runSetup("/unused-project", {
    output: capture(), exists: () => false, installPrebuilt: async () => 130,
    // Keep optional transfer setup independent of the runner's Homebrew/rsync.
    availableCommand: () => true, inspectRsync: async () => ({ protocol: 31 }),
    run: async (file, args) => { calls.push([file, args]); return 0; },
  });
  assert.equal(code, 130);
  assert.deepEqual(calls, [["npm", ["ci"]], ["npm", ["run", "model:setup"]]]);
});

test("setup prepares guests before networking and reuses the guest manager's verified result", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ovm-setup-guest-test-"));
  try {
    const steps = [];
    const output = capture();
    const code = await runSetup(root, {
      environment: { OVM_INSTALL_BIN: path.join(root, "links") }, output, exists: () => true,
      run: async (_file, args) => { steps.push(args.join(" ")); return 0; },
      installPrebuilt: async () => { steps.push("inputs"); return 0; },
      prepareGuests: async ({ projectRoot, onOutput }) => {
        assert.equal(projectRoot, root);
        steps.push("guests"); onOutput("Current verified profile reused.\n");
        return { ...await preparedGuest(), changed: false };
      },
      prepareNetwork: async ({ projectRoot }) => { assert.equal(projectRoot, root); steps.push("network"); },
    });
    assert.equal(code, 0);
    assert.deepEqual(steps, ["ci", "run model:setup", "inputs", "guests", "network"]);
    assert.match(output.text, /tens of minutes/);
    assert.match(output.text, /Current verified profile reused/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("failed or interrupted guest preparation stops setup before network or optional installation", async () => {
  for (const exitCode of [2, 130, 143]) {
    const failure = Object.assign(new Error("guest preparation failed"), { exitCode });
    let calls = 0;
    const output = capture();
    const code = await runSetup("/unused-setup-project", {
      output, exists: () => true, installPrebuilt: async () => 0,
      availableCommand: () => true, inspectRsync: async () => ({ protocol: 31 }),
      run: async () => { calls += 1; return 0; },
      prepareGuests: async () => { throw failure; },
      prepareNetwork: async () => assert.fail("a failed profile must not start networking"),
    });
    assert.equal(code, exitCode);
    assert.equal(calls, 2);
    assert.match(output.text, /guest preparation failed/);
  }
});

test("setup refuses an unverified guest result and skips mesh startup in explicit isolation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ovm-setup-isolated-test-"));
  try {
    const options = {
      environment: { OVM_INSTALL_BIN: path.join(root, "links"), OVM_NETWORK_MODE: "isolated" },
      output: capture(), exists: () => true, installPrebuilt: async () => 0, run: async () => 0,
      prepareNetwork: async () => assert.fail("explicit isolation must skip networking"),
    };
    assert.equal(await runSetup(root, { ...options, prepareGuests: async () => ({ prepared: true, verified: false }) }), 2);
    assert.equal(await runSetup(root, { ...options, prepareGuests: preparedGuest }), 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("chat thinking defaults off, permits an explicit boolean override, and rejects invalid values", async () => {
  for (const [environment, flag] of [[{}, "--think=false"], [{ OVM_CHAT_THINK: "false" }, "--think=false"], [{ OVM_CHAT_THINK: "true" }, "--think=true"]]) {
    let invocation;
    await runUserCommand("chat", ["--text", "test prompt"], { root: "/tmp/ovm", environment, run: async (_file, args) => { invocation = args; return 0; } });
    assert.equal(invocation[1], flag);
    assert.equal(invocation[2], "--");
  }
  await assert.rejects(runUserCommand("chat", ["--text", "test prompt"], {
    root: "/tmp/ovm", environment: { OVM_CHAT_THINK: "sometimes" },
    run: async () => assert.fail("invalid setting must not launch a child"),
  }), /OVM_CHAT_THINK must be true or false/);
  const help = capture();
  await runUserCommand("chat", ["--help"], { output: help });
  assert.match(help.text, /Thinking is disabled by default/);
  assert.match(help.text, /OVM_CHAT_THINK=true/);
});
