import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { verifySmolImage } from "../src/preflight.mjs";
import { SwiftVM } from "../src/swift-vm.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hostRunnerPath = path.join(projectRoot, "host", "ClaudeVZRunner");
const prebuiltRunnerPath = path.join(projectRoot, "prebuilt", "macos-arm64", "ClaudeVZRunner");
const runnerPath = process.env.OVM_SWIFT_TEST_RUNNER ?? (existsSync(hostRunnerPath) ? hostRunnerPath : prebuiltRunnerPath);
const execFile = promisify(execFileCallback);
const bundlePath = path.join(projectRoot, "vm", "claudevm.bundle");
const smolPath = path.join(projectRoot, "host", "smol-bin.arm64.img");
const nativeSupportAvailable = process.platform === "darwin"
  && process.arch === "arm64"
  && existsSync(runnerPath);
const privateInputsAvailable = nativeSupportAvailable
  && existsSync(bundlePath)
  && existsSync(smolPath);

test("signed clean Swift backend preserves the host's Apple Virtualization support result", {
  skip: nativeSupportAvailable ? false : "requires an Apple Silicon macOS host",
}, async () => {
  const vm = new SwiftVM({
    bundlePath,
    runnerPath,
    smolPath,
    sharePath: path.join(projectRoot, "share"),
    memoryGB: 4,
    cpuCount: 4,
    networkMode: "isolated",
    startupTimeoutSeconds: 30,
  });
  const raw = JSON.parse((await execFile(runnerPath, ["--support-only"])).stdout);
  assert.equal(raw.event, "support");
  assert.equal(typeof raw.supported, "boolean");
  assert.deepEqual(await vm.support(), {
    backend: "swift-virtualization",
    supported: raw.supported,
  });
});

test("reviewed private bundle and helper pass the native configuration probe", {
  skip: privateInputsAvailable ? false : "requires locally installed private Claude VM inputs",
}, async () => {
  const vm = new SwiftVM({
    bundlePath,
    runnerPath,
    smolPath,
    sharePath: path.join(projectRoot, "share"),
    memoryGB: 4,
    cpuCount: 4,
    networkMode: "isolated",
    distributionMode: "auto",
    startupTimeoutSeconds: 30,
  });
  assert.deepEqual(await vm.probe(), {
    backend: "swift-virtualization",
    supported: true,
    configurationValid: true,
    cpuCount: 4,
    memorySize: 4_294_967_296,
    networkMode: "isolated",
    distributionMode: "auto",
  });
  assert.deepEqual(await verifySmolImage(smolPath), {
    sha256: "e34ed7904e1be2ab9f99ac749fe40073bdc4c0d41efca28f2b11ac0441bdada8",
    size: 24_117_248,
  });
});

test("native probe exposes NAT by default and keeps explicit isolation without preparing guest credentials", {
  skip: privateInputsAvailable ? false : "requires locally installed private Claude VM inputs",
}, async () => {
  const args = ["--probe", "--bundle", bundlePath, "--smol", smolPath, "--share", path.join(projectRoot, "share")];
  const { OVM_NETWORK_MODE, ...environment } = process.env;
  const nat = JSON.parse((await execFile(runnerPath, args, { env: environment })).stdout);
  assert.equal(nat.networkMode, "nat");
  assert.equal(nat.networkForwarding, true);
  assert.equal(nat.networkIsolated, false);
  assert.equal(nat.networkConfigurationShare, false);
  const isolated = JSON.parse((await execFile(runnerPath, [...args, "--network", "isolated"], { env: environment })).stdout);
  assert.equal(isolated.networkMode, "isolated");
  assert.equal(isolated.networkForwarding, false);
  assert.equal(isolated.networkIsolated, true);
  await assert.rejects(execFile(runnerPath, [...args, "--network", "unknown"], { env: environment }), (error) => {
    assert.equal(error.code, 64);
    assert.match(error.stdout, /nat or isolated/);
    return true;
  });
});

test("canceled runner wait removes its pending waiter", async () => {
  const vm = new SwiftVM({
    bundlePath: "/unused",
    runnerPath: "/unused",
    smolPath: "/unused",
    sharePath: "/unused",
    memoryGB: 4,
    cpuCount: 4,
    networkMode: "isolated",
    startupTimeoutSeconds: 30,
  });
  const controller = new AbortController();
  const waiting = vm.waitFor(() => false, 10_000, controller.signal);
  controller.abort(new Error("test cancellation"));
  await assert.rejects(() => waiting, /test cancellation/);
  assert.equal(vm.waiters.size, 0);
});

test("wedged runner stop escalates to a bounded SIGKILL", async () => {
  class HangingVM extends SwiftVM {
    runnerArguments() {
      return ["-c", "trap '' TERM; while IFS= read -r line; do :; done"];
    }
  }
  const vm = new HangingVM({
    bundlePath: "/unused",
    runnerPath: "/bin/zsh",
    smolPath: "/unused",
    sharePath: "/unused",
    memoryGB: 4,
    cpuCount: 4,
    networkMode: "isolated",
    startupTimeoutSeconds: 1,
    stopTimeoutMilliseconds: 50,
    terminationGraceMilliseconds: 50,
  });
  vm.spawnPersistent();
  const stopped = await vm.stop("test");
  assert.equal(stopped.processEscalation, "SIGKILL");
  assert.equal(stopped.runnerExit.signal, "SIGKILL");
  assert.equal(vm.hasLiveProcess, false);
});
