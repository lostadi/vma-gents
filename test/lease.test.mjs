import test from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { VMLease } from "../src/lease.mjs";

const execFile = promisify(execFileCallback);

test("controller lease is exclusive and owner-releasable", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "claude-vm-lease-"));
  const lockPath = path.join(temporaryRoot, "vm.lease");
  const first = new VMLease(lockPath);
  const second = new VMLease(lockPath);

  try {
    assert.equal((await first.acquire()).ownedByThisProcess, true);
    await assert.rejects(() => second.acquire(), /controlled by live process PID/);
    await assert.rejects(() => second.requireOwnership(), /controlled by process PID/);
    assert.equal(await first.release(), true);
    assert.equal((await second.acquire()).ownedByThisProcess, true);
    assert.equal(await second.release(), true);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("stale controller lease fails closed without deleting evidence", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "claude-vm-stale-"));
  const lockPath = path.join(temporaryRoot, "vm.lease");
  const staleOwner = { pid: 2147483647, token: "stale", acquiredAt: "2026-01-01T00:00:00.000Z" };

  try {
    await writeFile(lockPath, `${JSON.stringify(staleOwner)}\n`, { mode: 0o600 });
    const lease = new VMLease(lockPath);
    await assert.rejects(() => lease.acquire(), /lease is stale/);
    assert.deepEqual(JSON.parse(await readFile(lockPath, "utf8")), staleOwner);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("simultaneous contenders publish exactly one lease owner", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "claude-vm-race-"));
  const lockPath = path.join(temporaryRoot, "vm.lease");
  const contenders = [new VMLease(lockPath), new VMLease(lockPath)];

  try {
    const outcomes = await Promise.allSettled(contenders.map((lease) => lease.acquire()));
    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
    const owner = contenders.find((lease) => lease.owned);
    assert.ok(owner);
    assert.equal(await owner.release(), true);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("separate processes cannot both own the writable clone lease", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "claude-vm-process-lease-"));
  const lockPath = path.join(temporaryRoot, "vm.lease");
  const moduleURL = pathToFileURL(path.resolve("src/lease.mjs")).href;
  const worker = `
    import { VMLease } from ${JSON.stringify(moduleURL)};
    const lease = new VMLease(process.env.TEST_VM_LOCK);
    try {
      await lease.acquire();
      console.log("acquired");
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await lease.release();
    } catch (error) {
      console.log("rejected:" + error.message);
    }
  `;
  try {
    const environment = { ...process.env, TEST_VM_LOCK: lockPath };
    const outcomes = await Promise.all([
      execFile(process.execPath, ["--input-type=module", "-e", worker], { env: environment }),
      execFile(process.execPath, ["--input-type=module", "-e", worker], { env: environment }),
    ]);
    const lines = outcomes.map(({ stdout }) => stdout.trim());
    assert.equal(lines.filter((line) => line === "acquired").length, 1);
    assert.equal(lines.filter((line) => line.startsWith("rejected:")).length, 1);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
