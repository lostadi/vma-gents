import test from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback, spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFileCallback);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const swiftAvailable = process.platform === "darwin" && process.arch === "arm64"
  && spawnSync("/usr/bin/xcrun", ["--find", "swiftc"], { stdio: "ignore" }).status === 0;

test("normal guest bootstrap validates runtime ownership and distribution mode independently of optional mesh readiness", {
  skip: swiftAvailable ? false : "requires Apple Silicon and Xcode Command Line Tools",
  timeout: 60_000,
}, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "ovm-bootstrap-test-"));
  try {
    const binary = path.join(temporary, "bootstrap-test");
    await execute("/usr/bin/xcrun", ["--sdk", "macosx", "swiftc", "-parse-as-library", "-swift-version", "5",
      "-D", "OVM_BOOTSTRAP_TEST", "-framework", "Virtualization", path.join(root, "host/ClaudeVZRunner.swift"),
      path.join(root, "test/fixtures/bootstrap-receipt-main.swift"), "-o", binary], { timeout: 45_000 });
    assert.match((await execute(binary, [], { timeout: 3_000 })).stdout, /matching mode and complete terminal evidence passed/);
    const waiter = (await execute(binary, ["--waiter-source"], { timeout: 3_000 })).stdout;
    const script = path.join(temporary, "waiter.py");
    await writeFile(script, waiter);
    await execute("python3", ["-m", "py_compile", script], { timeout: 5_000 });
    assert.match((await execute("python3", [path.join(root, "test/fixtures/bootstrap-waiter-test.py"), script], { timeout: 5_000 })).stdout,
      /identity, protected ownership, installed tools, and namespace isolation checks passed/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
