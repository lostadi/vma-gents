import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { prepareLaunchNetwork, distributionMode as validateDistributionMode } from "./guest-network.mjs";
import { readDistributionSettings } from "./distribution-config.mjs";
import { ensurePreparedImage, upgradePreparedImage, recordPreparedClone, preparedImageReceiptPath } from "./guest-manager.mjs";

const MAX_SWARM_OUTPUT_BYTES = 8 * 1024 * 1024;

export class SwarmVMFleet {
  constructor({
    binaryPath,
    bundlePath,
    smolPath,
    stateDirectory,
    memoryMB = 768,
    cpuCount = 1,
    timeoutMilliseconds = 90_000,
    networkMode = process.env.OVM_NETWORK_MODE ?? "nat",
    distributionMode,
    prepareNetwork,
    prepareRuntime = ensurePreparedImage,
    upgradeRuntime = upgradePreparedImage,
    recordRuntime = recordPreparedClone,
    onPreparationOutput = (chunk) => process.stderr.write(chunk),
    projectRoot = path.resolve(path.dirname(binaryPath), ".."),
  }) {
    this.binaryPath = binaryPath;
    this.bundlePath = bundlePath;
    this.smolPath = smolPath;
    this.stateDirectory = stateDirectory;
    this.memoryMB = memoryMB;
    this.cpuCount = cpuCount;
    this.timeoutMilliseconds = timeoutMilliseconds;
    if (!["nat", "isolated"].includes(networkMode)) throw new Error("OVM_NETWORK_MODE must be nat or isolated");
    this.networkMode = networkMode;
    this.distributionMode = validateDistributionMode(distributionMode ?? readDistributionSettings(projectRoot).mode);
    this.prepareNetwork = prepareNetwork;
    this.prepareRuntime = prepareRuntime;
    this.upgradeRuntime = upgradeRuntime;
    this.recordRuntime = recordRuntime;
    this.onPreparationOutput = onPreparationOutput;
    this.projectRoot = projectRoot;
  }

  async probe() {
    return {
      binaryPath: this.binaryPath,
      binaryAvailable: existsSync(this.binaryPath),
      bundlePath: this.bundlePath,
      bundleAvailable: existsSync(this.bundlePath),
      smolPath: this.smolPath,
      smolAvailable: existsSync(this.smolPath),
      memoryMB: this.memoryMB,
      cpuCount: this.cpuCount,
      networkMode: this.networkMode,
      distributionMode: this.distributionMode,
    };
  }

  rootfsPath(agentId) {
    return path.join(this.stateDirectory, `${agentId}.rootfs.img`);
  }

  async run(tasks) {
    if (!Array.isArray(tasks) || tasks.length === 0) return [];
    await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
    const probe = await this.probe();
    for (const [key, available] of [
      ["swarm binary", probe.binaryAvailable],
      ["private VM bundle", probe.bundleAvailable],
      ["private helper image", probe.smolAvailable],
    ]) if (!available) throw new Error(`${key} is unavailable`);

    const baseProfile = await this.prepareRuntime({ projectRoot: this.projectRoot, bundlePath: this.bundlePath });
    const sourceProfiles = new Map();
    // Complete migrations before any VM opens a disk. A parent may be the
    // source for several descendants, so upgrade it once per dispatch.
    for (const task of tasks) {
      const existing = this.rootfsPath(task.agentId);
      const source = existsSync(existing) ? existing : task.inheritRootfs;
      if (source && existsSync(source) && !sourceProfiles.has(path.resolve(source))) {
        const result = await this.upgradeRuntime({ projectRoot: this.projectRoot, bundlePath: this.bundlePath, rootfsPath: source, stateDirectory: this.stateDirectory, onOutput: this.onPreparationOutput });
        sourceProfiles.set(path.resolve(source), result.profile);
      }
    }

    // Allocate identities before booting any worker. Children inherit membership,
    // but their own preserved-root path selects a distinct mounted private key.
    const specifications = await Promise.all(tasks.map(async (task) => {
      const preserveRootfs = this.rootfsPath(task.agentId);
      const inherited = task.inheritRootfs && existsSync(task.inheritRootfs) ? task.inheritRootfs : null;
      const existing = existsSync(preserveRootfs) ? preserveRootfs : null;
      const identity = this.networkMode === "nat"
        ? await (this.prepareNetwork ?? prepareLaunchNetwork)({ projectRoot: this.projectRoot, guestId: `rootfs:${path.resolve(preserveRootfs)}`, agentId: task.agentId,
          distributionMode: this.distributionMode, networkMode: this.networkMode })
        : null;
      return {
        name: task.agentId,
        command: task.command,
        artifactCapture: Boolean(task.artifactPublication || task.artifactCapture),
        timeoutSeconds: 60,
        distributionMode: this.distributionMode,
        ...(existing || inherited ? { baseRootfs: existing ?? inherited } : {}),
        preserveRootfs,
        ...(existsSync(path.join(this.stateDirectory, "artifacts")) ? { artifactShare: path.join(this.stateDirectory, "artifacts") } : {}),
        ...(identity ? { networkShare: identity.shareDir ?? identity.networkShare } : {}),
      };
    }));

    const workers = await new Promise((resolve, reject) => {
      const child = spawn(this.binaryPath, [
        "--bundle", this.bundlePath,
        "--smol", this.smolPath,
        "--memory-mb", String(this.memoryMB),
        "--cpu-count", String(this.cpuCount),
        "--network", this.networkMode,
        "--distribution", this.distributionMode,
        "--tasks-stdin",
        "--json",
      ], { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let settled = false;
      let started = false;
      child.once("spawn", () => { started = true; });
      const rejectExecution = error => {
        // Once the native process starts, a missing result cannot prove that
        // the guest command had no effects. Resume must not replay it blindly.
        if (started || child.pid) error.uncertain = true;
        reject(error);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        child.kill("SIGKILL");
        settled = true;
        rejectExecution(new Error(`microVM fleet exceeded ${this.timeoutMilliseconds}ms; execution outcome is unknown`));
      }, this.timeoutMilliseconds);
      const append = (current, chunk) => {
        const next = current + chunk.toString("utf8");
        if (Buffer.byteLength(next, "utf8") > MAX_SWARM_OUTPUT_BYTES) {
          child.kill("SIGKILL");
          throw new Error("microVM fleet exceeded output limit");
        }
        return next;
      };
      child.stdout.on("data", (chunk) => {
        try { stdout = append(stdout, chunk); } catch (error) {
          if (!settled) { settled = true; clearTimeout(timer); rejectExecution(error); }
        }
      });
      child.stderr.on("data", (chunk) => {
        try { stderr = append(stderr, chunk); } catch (error) {
          if (!settled) { settled = true; clearTimeout(timer); rejectExecution(error); }
        }
      });
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rejectExecution(error);
      });
      child.once("exit", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0) {
          rejectExecution(new Error(`microVM fleet failed (exit=${code}, signal=${signal}): ${stderr.trim()}`));
          return;
        }
        try {
          const result = JSON.parse(stdout);
          resolve(result.workers ?? []);
        } catch (error) {
          rejectExecution(new Error(`microVM fleet returned invalid JSON: ${error.message}`));
        }
      });
      child.stdin.end(JSON.stringify(specifications));
    });
    try {
      for (const task of tasks) {
        const image = this.rootfsPath(task.agentId);
        const worker = workers.find((entry) => entry.agent === task.agentId);
        if (worker?.stopped === true && existsSync(image) && !existsSync(preparedImageReceiptPath(image))) {
          const source = specifications.find((entry) => entry.name === task.agentId)?.baseRootfs;
          const profile = source ? sourceProfiles.get(path.resolve(source)) : baseProfile;
          await this.recordRuntime({ rootfsPath: image, profile });
        }
      }
    } catch (error) {
      // Guest work already ran. Failure to save its prepared-image receipt
      // cannot turn that completed execution into safe-to-repeat work.
      error.uncertain = true;
      throw error;
    }
    return workers;
  }
}
