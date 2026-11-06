import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export class VMLease {
  constructor(lockPath, {
    resource = "VM clone",
    staleRecovery = "verify no ClaudeVZRunner process is running, then remove that exact file",
  } = {}) {
    this.lockPath = path.resolve(lockPath);
    this.resource = resource;
    this.staleRecovery = staleRecovery;
    this.token = randomUUID();
    this.owned = false;
  }

  async inspect() {
    try {
      const owner = JSON.parse(await readFile(this.lockPath, "utf8"));
      return {
        held: true,
        alive: pidIsAlive(owner.pid),
        pid: Number.isInteger(owner.pid) ? owner.pid : null,
        acquiredAt: typeof owner.acquiredAt === "string" ? owner.acquiredAt : null,
        ownedByThisProcess: owner.token === this.token && owner.pid === process.pid,
      };
    } catch (error) {
      if (error?.code === "ENOENT") {
        return { held: false, alive: false, pid: null, acquiredAt: null, ownedByThisProcess: false };
      }
      throw new Error(`cannot inspect VM controller lease: ${error.message}`);
    }
  }

  async acquire() {
    if (this.owned) return this.requireOwnership();
    await mkdir(path.dirname(this.lockPath), { recursive: true, mode: 0o700 });

    const owner = {
      pid: process.pid,
      token: this.token,
      acquiredAt: new Date().toISOString(),
    };
    const candidatePath = `${this.lockPath}.candidate-${process.pid}-${this.token}`;
    await writeFile(candidatePath, `${JSON.stringify(owner)}\n`, { mode: 0o600, flag: "wx" });

    try {
      await link(candidatePath, this.lockPath);
    } catch (error) {
      await unlink(candidatePath).catch(() => {});
      if (error?.code !== "EEXIST") {
        throw new Error(`cannot acquire VM controller lease: ${error.message}`);
      }
      const existing = await this.inspect();
      if (existing.alive) {
        throw new Error(`${this.resource} is controlled by live process PID ${existing.pid}`);
      }
      throw new Error(
        `${this.resource} lease is stale at ${this.lockPath}; ${this.staleRecovery}`,
      );
    }

    await unlink(candidatePath).catch(() => {});
    this.owned = true;
    return this.inspect();
  }

  async requireOwnership() {
    const lease = await this.inspect();
    if (!this.owned || !lease.ownedByThisProcess) {
      throw new Error(lease.held
        ? `${this.resource} is controlled by process PID ${lease.pid}`
        : `this process does not own the ${this.resource} lease`);
    }
    return lease;
  }

  async release() {
    if (!this.owned) return false;
    const lease = await this.inspect();
    if (!lease.ownedByThisProcess) {
      this.owned = false;
      throw new Error("refusing to remove a VM lease owned by another process");
    }
    await unlink(this.lockPath);
    this.owned = false;
    return true;
  }
}
