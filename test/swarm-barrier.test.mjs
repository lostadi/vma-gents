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

test("native fleet barrier retains early guests until peers finish and bounds missing peers", {
  skip: swiftAvailable ? false : "requires Apple Silicon and Xcode Command Line Tools",
  timeout: 60_000,
}, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "ovm-barrier-test-"));
  try {
    const binary = path.join(temporary, "barrier-test");
    await execute("/usr/bin/xcrun", ["--sdk", "macosx", "swiftc", "-parse-as-library", "-swift-version", "5",
      "-D", "OVM_BARRIER_TEST", "-framework", "Virtualization", path.join(root, "host/OVMSwarm.swift"),
      path.join(root, "test/fixtures/swarm-barrier-main.swift"), "-o", binary], { timeout: 45_000 });
    const result = await execute(binary, [], { timeout: 3_000 });
    assert.match(result.stdout, /peer wait, release and bounded timeout passed/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
