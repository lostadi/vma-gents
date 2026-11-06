import test from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFileCallback);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const swiftAvailable = process.platform === "darwin" && process.arch === "arm64"
  && spawnSync("/usr/bin/xcrun", ["--find", "swiftc"], { stdio: "ignore" }).status === 0;

test("artifact handoff configures an optional readonly guest share and prevents execution when mount fails", {
  skip: swiftAvailable ? false : "requires Apple Silicon and Xcode Command Line Tools", timeout: 60_000,
}, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "ovm-artifact-share-test-"));
  try {
    const binary = path.join(temporary, "artifact-test");
    await execute("/usr/bin/xcrun", ["--sdk", "macosx", "swiftc", "-parse-as-library", "-swift-version", "5",
      "-D", "OVM_BARRIER_TEST", "-framework", "Virtualization", path.join(root, "host/OVMSwarm.swift"),
      path.join(root, "test/fixtures/swarm-artifacts-main.swift"), "-o", binary], { timeout: 45_000 });
    assert.match((await execute(binary, [], { timeout: 3_000 })).stdout, /readonly host directory, validation, optional mount and task decoding passed/);
    const script = (await execute(binary, ["--mount-script"], { timeout: 3_000 })).stdout;
    for (const [initial, mountExit, expected] of [[0, 0, "0:1:1"], [0, 23, "23:1:0"], [7, 0, "7:0:0"]]) {
      const wrapper = `bootstrap_rc=${initial}; mounted=0; executed=0\nmkdir(){ return 0; }\nmount(){ mounted=1; [ "$*" = '-t virtiofs -o ro ovm-artifacts /ovm/artifacts' ] || return 99; return ${mountExit}; }\n${script}\nif [ "$bootstrap_rc" -eq 0 ]; then executed=1; fi\nprintf '%s:%s:%s' "$bootstrap_rc" "$mounted" "$executed"`;
      assert.equal((await execute("/bin/bash", ["-c", wrapper], { timeout: 3_000 })).stdout, expected);
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
