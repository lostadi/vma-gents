import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { access, chmod, lstat, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
export const CLAUDE_SOURCE_BUNDLE = path.resolve(
  process.env.CLAUDE_VM_SOURCE_BUNDLE
    ?? path.join(os.homedir(), "Library", "Application Support", "Claude", "vm_bundles", "claudevm.bundle"),
);
const IDENTITY_BUNDLE_FILES = [
  "rootfs.img",
  "sessiondata.img",
  "efivars.fd",
  "machineIdentifier",
  "gvisorMacAddress",
];
const REQUIRED_BUNDLE_FILES = [...IDENTITY_BUNDLE_FILES, "vmlinuz", "initrd"];
const DIRECT_BOOT_MANIFEST = ".direct-boot-manifest-v1.json";
export const GUEST_PROFILE_MANIFEST = ".ovm-guest-v1.json";
const COMPATIBILITY_PROFILE = JSON.parse(readFileSync(
  new URL("../compatibility/claude-desktop.json", import.meta.url),
  "utf8",
));
const EXPECTED_SMOL_SHA256 = COMPATIBILITY_PROFILE.helper.sha256;
const EXPECTED_SMOL_SIZE = COMPATIBILITY_PROFILE.helper.sizeBytes;

async function command(file, args, options = {}) {
  try {
    return await execFile(file, args, {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 10_000,
      ...options,
    });
  } catch (error) {
    // lsof uses exit 1 both for "no matching open files" and for real probe
    // failures. Only the silent form is a trustworthy negative result.
    if (options.acceptExitOne
      && error.code === 1
      && String(error.stderr ?? "").trim() === "") {
      return { stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
    }
    throw error;
  }
}

export async function inspectHost(bundlePath) {
  const memory = await command("/usr/bin/memory_pressure", ["-Q"]);
  const memoryMatch = memory.stdout.match(/free percentage:\s*(\d+)%/i);
  const freeMemoryPercent = memoryMatch ? Number(memoryMatch[1]) : null;

  const pressure = await command("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]);
  const memoryPressureLevel = Number.parseInt(pressure.stdout.trim(), 10);

  const swap = await command("/usr/sbin/sysctl", ["-n", "vm.swapusage"]);
  const swapMatch = swap.stdout.match(/total\s*=\s*([\d.]+)M\s+used\s*=\s*([\d.]+)M/i);
  const swapUsagePercent = swapMatch && Number(swapMatch[1]) > 0
    ? Math.round((Number(swapMatch[2]) / Number(swapMatch[1])) * 1000) / 10
    : null;

  const disk = await command("/bin/df", ["-Pk", bundlePath]);
  const diskLine = disk.stdout.trim().split("\n").at(-1)?.trim().split(/\s+/);
  const freeDiskBytes = diskLine?.[3] ? Number(diskLine[3]) * 1024 : null;

  return {
    freeMemoryPercent,
    memoryPressureLevel: Number.isFinite(memoryPressureLevel) ? memoryPressureLevel : null,
    swapUsagePercent,
    freeDiskBytes,
  };
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

export async function verifyPreparedRootfsSize(bundlePath, size, sourceSize) {
  const file = path.join(bundlePath, GUEST_PROFILE_MANIFEST);
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== process.getuid()
    || (metadata.mode & 0o022)) throw new Error("guest preparation manifest must be a private owner-controlled regular file");
  const profile = JSON.parse(await readFile(file, "utf8"));
  if (profile.schema !== "ovm.prepared-guest/v1" || profile.verified !== true
    || !/^[a-f0-9]{40}$/.test(profile.sourceCommit ?? "")
    || !/^[a-f0-9]{64}$/.test(profile.sourceArchiveSha256 ?? "")
    || !/^[a-f0-9]{64}$/.test(profile.recipeSha256 ?? "")
    || profile.rootfsSizeBytes !== size || profile.sourceRootfsSizeBytes !== sourceSize
    || size < sourceSize || size > 64 * 1024 ** 3) {
    throw new Error("enlarged rootfs does not match a verified OVM guest preparation receipt");
  }
  return profile;
}

export async function verifyBundle(bundlePath, sourceBundlePath, privateRoot) {
  const [bundleReal, sourceReal, expectedSourceReal, privateRootReal] = await Promise.all([
    realpath(bundlePath),
    realpath(sourceBundlePath),
    realpath(CLAUDE_SOURCE_BUNDLE),
    realpath(privateRoot),
  ]);
  if (sourceReal !== expectedSourceReal) {
    throw new Error("refusing a decoy source bundle path");
  }
  if (bundleReal === sourceReal) {
    throw new Error("refusing to use Claude's original VM bundle");
  }
  if (!isWithin(privateRootReal, bundleReal)) {
    throw new Error("private VM clone must remain inside this project's vm directory");
  }
  for (const name of REQUIRED_BUNDLE_FILES) {
    const copyPath = path.join(bundleReal, name);
    const sourcePath = path.join(sourceReal, name);
    const [copyLink, sourceLink, copyMetadata, sourceMetadata] = await Promise.all([
      lstat(copyPath),
      lstat(sourcePath),
      stat(copyPath),
      stat(sourcePath),
    ]);
    if (copyLink.isSymbolicLink() || sourceLink.isSymbolicLink()) {
      throw new Error(`refusing a symbolic link in a VM bundle: ${name}`);
    }
    if (!copyMetadata.isFile() || !sourceMetadata.isFile()) {
      throw new Error(`required bundle entry is not a regular file: ${name}`);
    }
    if (copyMetadata.dev === sourceMetadata.dev && copyMetadata.ino === sourceMetadata.ino) {
      throw new Error(`private VM entry aliases Claude's original inode: ${name}`);
    }
    if (copyMetadata.uid !== process.getuid()) {
      throw new Error(`private VM entry is not owned by the current user: ${name}`);
    }
    if (["rootfs.img", "sessiondata.img", "efivars.fd"].includes(name)
      && copyMetadata.size !== sourceMetadata.size) {
      if (name !== "rootfs.img") throw new Error(`private VM storage size differs from Claude's source: ${name}`);
      await verifyPreparedRootfsSize(bundleReal, copyMetadata.size, sourceMetadata.size);
    }
  }
  return bundleReal;
}

export async function sourceBundleIsOpen(sourceBundlePath) {
  const targets = ["rootfs.img", "sessiondata.img", "efivars.fd"]
    .map((name) => path.join(sourceBundlePath, name));
  const result = await command("/usr/sbin/lsof", targets, { acceptExitOne: true });
  return result.stdout.trim().length > 0;
}

export async function bundleOpenPids(bundlePath) {
  const targets = ["rootfs.img", "sessiondata.img", "efivars.fd"]
    .map((name) => path.join(bundlePath, name));
  // These are three exact files, so lsof should finish quickly. Bound the
  // probe tightly: a pathological lsof must retain the lease fail-closed,
  // not stretch a nominal three-second shutdown confirmation into minutes.
  const result = await command("/usr/sbin/lsof", ["-t", "--", ...targets], {
    acceptExitOne: true,
    timeout: 5_000,
  });
  return [...new Set(result.stdout
    .trim()
    .split(/\s+/)
    .map((value) => Number.parseInt(value, 10))
    .filter(Number.isInteger))];
}

export async function ensurePrivateIdentity(bundlePath) {
  const markerPath = path.join(bundlePath, ".ollama-vm-identity-v1");
  const machineIdentifierPath = path.join(bundlePath, "machineIdentifier");
  const macPath = path.join(bundlePath, "gvisorMacAddress");
  try {
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    const [machineIdentifier, macText] = await Promise.all([
      readFile(machineIdentifierPath),
      readFile(macPath, "utf8"),
    ]);
    const [sourceMachineIdentifier, sourceMacText] = await Promise.all([
      readFile(path.join(CLAUDE_SOURCE_BUNDLE, "machineIdentifier")),
      readFile(path.join(CLAUDE_SOURCE_BUNDLE, "gvisorMacAddress"), "utf8"),
    ]);
    const machineIdentifierSha256 = createHash("sha256").update(machineIdentifier).digest("hex");
    const mac = macText.trim().toLowerCase();
    const firstMacOctet = Number.parseInt(mac.slice(0, 2), 16);
    const validMac = /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac)
      && (firstMacOctet & 0x02) === 0x02
      && (firstMacOctet & 0x01) === 0;
    if (marker.version !== 1
      || marker.machineIdentifierSha256 !== machineIdentifierSha256
      || marker.mac !== mac
      || !validMac) {
      throw new Error("private VM identity marker does not match its identity files");
    }
    if (machineIdentifier.equals(sourceMachineIdentifier)
      || mac === sourceMacText.trim().toLowerCase()) {
      throw new Error("private VM identity still matches Claude's original identity");
    }
    return false;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const machineIdentifierData = randomBytes(16).toString("base64");
  const macBytes = randomBytes(6);
  macBytes[0] = (macBytes[0] | 0x02) & 0xfe;
  const mac = [...macBytes].map((byte) => byte.toString(16).padStart(2, "0")).join(":");

  await chmod(bundlePath, 0o700);
  for (const name of IDENTITY_BUNDLE_FILES) {
    await chmod(path.join(bundlePath, name), 0o600);
  }

  const suffix = `.tmp-${process.pid}-${randomUUID()}`;
  const machineTemp = `${machineIdentifierPath}${suffix}`;
  const macTemp = `${macPath}${suffix}`;
  const markerTemp = `${markerPath}${suffix}`;
  await command("/usr/bin/plutil", ["-create", "binary1", machineTemp]);
  await command("/usr/bin/plutil", ["-insert", "UUID", "-data", machineIdentifierData, machineTemp]);
  await chmod(machineTemp, 0o600);
  await writeFile(macTemp, mac, { mode: 0o600, flag: "wx" });
  await rename(machineTemp, machineIdentifierPath);
  await rename(macTemp, macPath);

  const machineIdentifierSha256 = createHash("sha256")
    .update(await readFile(machineIdentifierPath))
    .digest("hex");
  const marker = {
    version: 1,
    createdAt: new Date().toISOString(),
    machineIdentifierSha256,
    mac,
  };
  await writeFile(markerTemp, `${JSON.stringify(marker)}\n`, { mode: 0o600, flag: "wx" });
  await rename(markerTemp, markerPath);
  return true;
}

export async function verifyDirectBootArtifacts(bundlePath) {
  const manifestPath = path.join(bundlePath, DIRECT_BOOT_MANIFEST);
  const provenancePaths = [manifestPath, ".rootfs.img.origin", ".vmlinuz.origin", ".initrd.origin"]
    .map((name) => path.isAbsolute(name) ? name : path.join(bundlePath, name));
  for (const provenancePath of provenancePaths) {
    const metadata = await lstat(provenancePath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`direct-boot provenance is not a regular file: ${path.basename(provenancePath)}`);
    }
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.version !== 1 || !/^[0-9a-f]{40}$/.test(manifest.rootfsOrigin ?? "")) {
    throw new Error("invalid direct-boot provenance manifest");
  }
  const origins = await Promise.all([".rootfs.img.origin", ".vmlinuz.origin", ".initrd.origin"]
    .map((name) => readFile(path.join(bundlePath, name), "utf8")));
  if (origins.some((origin) => origin.trim() !== manifest.rootfsOrigin)) {
    throw new Error("kernel, initrd, and rootfs origins do not match");
  }
  for (const [name, expected] of [
    ["vmlinuz", manifest.vmlinuzSha256],
    ["initrd", manifest.initrdSha256],
  ]) {
    if (!/^[0-9a-f]{64}$/.test(expected ?? "")) {
      throw new Error(`invalid ${name} digest in direct-boot manifest`);
    }
    const metadata = await lstat(path.join(bundlePath, name));
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`direct-boot artifact is not a regular file: ${name}`);
    }
    const actual = createHash("sha256").update(await readFile(path.join(bundlePath, name))).digest("hex");
    if (actual !== expected) throw new Error(`${name} does not match its pinned SHA-256`);
  }
  return {
    rootfsOrigin: manifest.rootfsOrigin,
    vmlinuzSha256: manifest.vmlinuzSha256,
    initrdSha256: manifest.initrdSha256,
  };
}

export async function verifySmolImage(smolPath) {
  const metadata = await lstat(smolPath);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.uid !== process.getuid()) {
    throw new Error("private helper image must be a regular, user-owned, non-symlink file");
  }
  const actual = createHash("sha256").update(await readFile(smolPath)).digest("hex");
  if (actual !== EXPECTED_SMOL_SHA256) {
    throw new Error(`private helper image hash mismatch: ${actual}`);
  }
  if (metadata.size !== EXPECTED_SMOL_SIZE) {
    throw new Error(`private helper image size mismatch: ${metadata.size}`);
  }
  return { sha256: actual, size: metadata.size };
}

export async function verifyShareDirectory(sharePath, projectRoot) {
  const [shareLink, shareMetadata, shareReal, projectReal] = await Promise.all([
    lstat(sharePath),
    stat(sharePath),
    realpath(sharePath),
    realpath(projectRoot),
  ]);
  if (shareLink.isSymbolicLink() || !shareMetadata.isDirectory()) {
    throw new Error("VM host share must be a real, non-symlink directory");
  }
  if (shareMetadata.uid !== process.getuid() || !isWithin(projectReal, shareReal)) {
    throw new Error("VM host share must be user-owned and inside the MCP project");
  }
  if ((shareMetadata.mode & 0o077) !== 0) {
    throw new Error("VM host share must not grant group or world permissions");
  }
  if ((shareMetadata.mode & 0o500) !== 0o500 || (shareMetadata.mode & 0o200) !== 0) {
    throw new Error("VM host share must be owner-readable/searchable and owner-nonwritable");
  }

  async function verifyTree(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      const metadata = await lstat(entryPath);
      if (metadata.isSymbolicLink()) {
        throw new Error(`VM host share must not contain symbolic links: ${entryPath}`);
      }
      if (metadata.isDirectory()) {
        await verifyTree(entryPath);
      } else if (!metadata.isFile()) {
        throw new Error(`VM host share contains an unsupported file type: ${entryPath}`);
      }
    }
  }
  await verifyTree(shareReal);
  return { path: shareReal, readOnly: true, tag: "claudeshared" };
}

export async function runStartPreflight({
  bundlePath,
  sourceBundlePath,
  privateRoot,
  smolPath,
  sharePath,
  projectRoot,
  policy,
}) {
  const verifiedBundlePath = await verifyBundle(bundlePath, sourceBundlePath, privateRoot);
  const [directBoot, helperImage, hostShare] = await Promise.all([
    verifyDirectBootArtifacts(verifiedBundlePath),
    verifySmolImage(smolPath),
    verifyShareDirectory(sharePath, projectRoot),
  ]);
  if (await sourceBundleIsOpen(sourceBundlePath)) {
    throw new Error("Claude's original VM bundle is open; quit Claude before starting the clone");
  }
  const copyUsers = await bundleOpenPids(verifiedBundlePath);
  if (copyUsers.length > 0) {
    throw new Error(`private VM clone disk is already open by PID(s): ${copyUsers.join(", ")}`);
  }
  const host = await inspectHost(verifiedBundlePath);
  if (host.memoryPressureLevel !== null && host.memoryPressureLevel >= 4) {
    throw new Error(`host memory pressure is critical (level ${host.memoryPressureLevel})`);
  }
  if (host.freeMemoryPercent !== null && host.freeMemoryPercent < policy.minimumFreeMemoryPercent) {
    throw new Error(
      `host free-memory estimate is ${host.freeMemoryPercent}%, below policy minimum ${policy.minimumFreeMemoryPercent}%`,
    );
  }
  const minimumDiskBytes = policy.minimumFreeDiskGiB * 1024 ** 3;
  if (host.freeDiskBytes !== null && host.freeDiskBytes < minimumDiskBytes) {
    throw new Error(
      `free disk is below the policy minimum of ${policy.minimumFreeDiskGiB} GiB`,
    );
  }
  return { bundlePath: verifiedBundlePath, host, directBoot, helperImage, hostShare };
}

export async function readBundleVersion(bundlePath) {
  try {
    return (await readFile(path.join(bundlePath, ".rootfs.img.origin"), "utf8")).trim();
  } catch {
    return null;
  }
}
