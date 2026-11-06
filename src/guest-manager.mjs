import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { access, chmod, copyFile, lstat, mkdir, readFile, realpath, rename, stat,
  statfs, truncate, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { VMLease } from "./lease.mjs";
import { CLAUDE_SOURCE_BUNDLE, GUEST_PROFILE_MANIFEST } from "./preflight.mjs";
import { cloneProvisionBundle, runGuestScript } from "./guest-setup.mjs";

const execute = promisify(execFile);
const SOURCE_URL = "https://github.com/lostadi/OSTADIX.git";
export const PINNED_OSTADIX_COMMIT = "43da5a51420d95c29f7d2c07162a4e765ba11110";
export const PREPARED_GUEST_SCHEMA = "ovm.prepared-guest/v1";
const IMAGE_BYTES = 24 * 1024 ** 3;
const GUEST_FILES = ["provision.sh", "smoke.py", "ovm-guest-start", "ovm-env.sh", "ovm-guest.service", "ovm-peer", "ovm-peer-service", "upgrade.sh"];
const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
export const REQUIRED_GUEST_CHECKS = [
  "native Linux ARM64 Ostadix commands", "C17 reference interpreter", "Python reference interpreter",
  "o-node command available without generating identity", "octl client available",
  "MCP initialize, list tools, environment, runtimes and execution",
  ...["python", "bash", "shell", "javascript", "ruby", "rust", "c", "cpp", "java", "sql",
    "haskell", "ocaml", "racket", "lisp", "common_lisp", "csharp", "matlab", "nix", "webassembly"]
    .map((name) => `O backend execution: ${name}`),
];

function paths(projectRoot, bundlePath) {
  const root = path.resolve(projectRoot);
  const bundle = path.resolve(bundlePath ?? path.join(root, "vm/claudevm.bundle"));
  return { root, bundle, manifest: path.join(bundle, GUEST_PROFILE_MANIFEST),
    lease: `${bundle}.mcp.lease`, rootfs: path.join(bundle, "rootfs.img") };
}

function quote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }

async function regularFile(file, { privateFile = false } = {}) {
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Expected a regular file: ${file}`);
  if (privateFile && (metadata.uid !== process.getuid() || (metadata.mode & 0o022))) {
    throw new Error(`Expected an owner-controlled file: ${file}`);
  }
  return metadata;
}

export async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export async function guestRecipeSha256(projectRoot, { guestDirectory } = {}) {
  const hash = createHash("sha256");
  for (const name of GUEST_FILES) {
    const bytes = await readFile(path.join(guestDirectory ?? path.join(projectRoot, "guest"), name));
    hash.update(`${name}\0${bytes.length}\0`);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

export function validateSmokeReport(smoke) {
  if (smoke?.schema !== "ovm.guest-smoke/v1" || smoke.ok !== true
    || !Array.isArray(smoke.checks) || smoke.checks.length === 0
    || smoke.checks.some((check) => check.ok !== true)
    || smoke.failed !== 0 || smoke.passed !== smoke.checks.length
    || smoke.architecture !== "aarch64") {
    throw new Error("Guest smoke evidence is missing, incomplete, or failed; the image cannot be published.");
  }
  const names = new Set(smoke.checks.map((check) => check.name));
  if (REQUIRED_GUEST_CHECKS.some((name) => !names.has(name))) throw new Error("Guest smoke evidence does not cover the required Ostadix runtimes and MCP.");
  return smoke;
}

export function validateGuestProfile(profile, { rootfsSizeBytes, sourceRootfsSizeBytes } = {}) {
  if (profile?.schema !== PREPARED_GUEST_SCHEMA || profile.verified !== true
    || !COMMIT.test(profile.sourceCommit ?? "")
    || !SHA256.test(profile.sourceArchiveSha256 ?? "")
    || !SHA256.test(profile.recipeSha256 ?? "")
    || !Number.isSafeInteger(profile.rootfsSizeBytes)
    || !Number.isSafeInteger(profile.sourceRootfsSizeBytes)
    || profile.sourceRootfsSizeBytes < 1
    || profile.rootfsSizeBytes < profile.sourceRootfsSizeBytes
    || profile.rootfsSizeBytes > 64 * 1024 ** 3
    || (rootfsSizeBytes !== undefined && profile.rootfsSizeBytes !== rootfsSizeBytes)
    || (sourceRootfsSizeBytes !== undefined && profile.sourceRootfsSizeBytes !== sourceRootfsSizeBytes)) {
    throw new Error("The guest preparation receipt does not match this root image.");
  }
  validateSmokeReport(profile.smoke);
  return profile;
}

export async function getGuestStatus({ projectRoot, bundlePath } = {}) {
  const target = paths(projectRoot, bundlePath);
  const result = { prepared: false, verified: false, bundlePath: target.bundle,
    manifestPath: target.manifest, profile: null, needsUpdate: false, errors: [] };
  try {
    const [rootMetadata] = await Promise.all([
      regularFile(target.rootfs, { privateFile: true }),
      regularFile(target.manifest, { privateFile: true }),
    ]);
    const profile = validateGuestProfile(JSON.parse(await readFile(target.manifest, "utf8")), {
      rootfsSizeBytes: rootMetadata.size,
    });
    result.profile = profile;
    result.prepared = result.verified = true;
    try { result.needsUpdate = profile.recipeSha256 !== await guestRecipeSha256(target.root); }
    catch (error) { result.errors.push(`Cannot compare the installed guest recipe: ${error.message}`); }
  } catch (error) {
    result.errors.push(error.code === "ENOENT"
      ? "The built-in VM has not been prepared. Run: ovm guests setup"
      : `${error.message} Run: ovm guests setup`);
  }
  return result;
}

export async function ensurePreparedImage(options) {
  const status = await getGuestStatus(options);
  if (!status.prepared) throw new Error(status.errors.join(" "));
  return status.profile;
}

async function assertNoOpenFiles(files, { command = execute } = {}) {
  let result;
  try {
    result = await command("/usr/sbin/lsof", ["-t", "--", ...files], { encoding: "utf8", timeout: 15_000 });
  } catch (error) {
    // lsof returns 1 for both an empty result and a failed probe. A diagnostic
    // is a probe failure, never permission to replace an image.
    if (error.code === 1 && String(error.stderr ?? "").trim() === ""
      && String(error.stdout ?? "").trim() === "") return;
    throw new Error(`Cannot establish that the VM image is unused: ${error.message}`);
  }
  if (String(result.stdout ?? "").trim()) {
    throw new Error(`The VM image is open in process(es) ${String(result.stdout).trim().split(/\s+/).join(", ")}. Stop those VMs before guest setup.`);
  }
  if (String(result.stderr ?? "").trim()) throw new Error(`Cannot establish that the VM image is unused: ${result.stderr}`);
}

export async function assertNoOpenBundleFiles(bundlePath, options = {}) {
  return assertNoOpenFiles(["rootfs.img", "sessiondata.img", "efivars.fd"].map((file) => path.join(bundlePath, file)), options);
}

async function cloneFile(source, destination) {
  await execute("/bin/cp", ["-c", "-p", source, destination], { encoding: "utf8", timeout: 120_000 });
  const [original, cloned] = await Promise.all([stat(source), stat(destination)]);
  if (original.dev === cloned.dev && original.ino === cloned.ino) {
    throw new Error(`APFS clone aliases its source inode: ${destination}`);
  }
}

async function assertPrivateBundle(target, sourceBundlePath) {
  const [actual, source, privateRoot] = await Promise.all([
    realpath(target.bundle), realpath(sourceBundlePath), realpath(path.join(target.root, "vm")),
  ]);
  const relative = path.relative(privateRoot, actual);
  if (actual === source || relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Guest setup only modifies OVM's private VM bundle, never Claude's original bundle.");
  }
  return actual;
}

function sameFileState(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

/** Publish only a verified root disk. Session data and original inputs stay put. */
export async function publishPreparedGuest({ projectRoot, bundlePath, stagingBundle,
  exportPath, sourceCommit, sourceArchiveSha256, recipeSha256,
  sourceRootfsSizeBytes, sourceBundlePath = CLAUDE_SOURCE_BUNDLE, lease: existingLease },
{ clone = cloneFile, command = execute, Lease = VMLease, move = rename } = {}) {
  const target = paths(projectRoot, bundlePath);
  await assertPrivateBundle(target, sourceBundlePath);
  const stagedRootfs = path.join(path.resolve(stagingBundle), "rootfs.img");
  const [stagedMetadata, previousMetadata, originalMetadata] = await Promise.all([
    regularFile(stagedRootfs, { privateFile: true }), regularFile(target.rootfs, { privateFile: true }),
    regularFile(path.join(sourceBundlePath, "rootfs.img")),
  ]);
  if (stagedMetadata.dev === previousMetadata.dev && stagedMetadata.ino === previousMetadata.ino) {
    throw new Error("The staged root disk aliases the active image.");
  }
  if (sourceRootfsSizeBytes !== originalMetadata.size) throw new Error("Source root disk size changed before publication.");
  const [smokeMetadata, installMetadata] = await Promise.all([
    regularFile(path.join(exportPath, "smoke.json"), { privateFile: true }),
    regularFile(path.join(exportPath, "install.json"), { privateFile: true }),
  ]);
  if (smokeMetadata.size > 4 * 1024 ** 2 || installMetadata.size > 1024 ** 2) throw new Error("Guest evidence exceeds the expected size limit.");
  const smoke = validateSmokeReport(JSON.parse(await readFile(path.join(exportPath, "smoke.json"), "utf8")));
  const installation = JSON.parse(await readFile(path.join(exportPath, "install.json"), "utf8"));
  if (installation.schema !== "ovm.guest-install/v1" || installation.verified !== true
    || installation.source_sha256 !== sourceArchiveSha256) throw new Error("Guest installation evidence does not match the archived source.");
  const runtimeArchivePath = path.join(path.resolve(exportPath), "runtime.tar.gz");
  await regularFile(runtimeArchivePath, { privateFile: true });
  const archiveSha256 = await sha256File(runtimeArchivePath);
  const archiveReceipt = (await readFile(path.join(exportPath, "runtime.sha256"), "utf8")).trim().split(/\s+/)[0];
  if (archiveSha256 !== archiveReceipt) throw new Error("The exported guest runtime archive failed its SHA-256 check.");
  const profile = validateGuestProfile({ schema: PREPARED_GUEST_SCHEMA, verified: true,
    preparedAt: new Date().toISOString(), sourceCommit, sourceArchiveSha256, recipeSha256,
    rootfsSizeBytes: stagedMetadata.size, sourceRootfsSizeBytes,
    sourceRepository: SOURCE_URL, smoke, installation,
    runtimeArchive: { path: runtimeArchivePath, sha256: archiveSha256 },
  }, { rootfsSizeBytes: stagedMetadata.size, sourceRootfsSizeBytes });
  const lease = existingLease ?? new Lease(target.lease, { resource: "built-in VM image" });
  if (existingLease) await lease.requireOwnership(); else await lease.acquire();
  const token = randomUUID();
  const candidate = path.join(target.bundle, `.rootfs-prepared-${token}.img`);
  const receiptCandidate = path.join(target.bundle, `.guest-receipt-${token}.json`);
  const backupDirectory = path.join(target.root, "vm", "guest-backups", `${Date.now()}-${token}`);
  let replaced = false;
  let oldReceipt;
  try {
    await assertNoOpenBundleFiles(target.bundle, { command });
    await assertNoOpenBundleFiles(stagingBundle, { command });
    await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
    await clone(target.rootfs, path.join(backupDirectory, "rootfs.img"));
    try {
      oldReceipt = await readFile(target.manifest);
      await writeFile(path.join(backupDirectory, GUEST_PROFILE_MANIFEST), oldReceipt, { mode: 0o600, flag: "wx" });
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    await clone(stagedRootfs, candidate);
    await chmod(candidate, 0o600);
    await writeFile(receiptCandidate, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await lease.requireOwnership();
    await assertNoOpenBundleFiles(target.bundle, { command });
    if (!sameFileState(previousMetadata, await stat(target.rootfs))) throw new Error("The active root disk changed during guest publication.");
    if (!sameFileState(stagedMetadata, await stat(stagedRootfs))) throw new Error("The staged root disk changed after verification.");
    await move(candidate, target.rootfs);
    replaced = true;
    await move(receiptCandidate, target.manifest);
    return { profile, backupDirectory, bundlePath: target.bundle };
  } catch (error) {
    if (replaced) {
      // Retain the backup itself. Restore through a new APFS clone so even an
      // interrupted rollback does not consume the user's previous image.
      try {
        const restore = path.join(target.bundle, `.rootfs-restore-${token}.img`);
        await clone(path.join(backupDirectory, "rootfs.img"), restore);
        await move(restore, target.rootfs);
        if (oldReceipt) await writeFile(target.manifest, oldReceipt, { mode: 0o600 });
        else await unlink(target.manifest).catch((missing) => { if (missing.code !== "ENOENT") throw missing; });
      } catch (rollback) {
        throw new Error(`${error.message}; automatic rollback failed: ${rollback.message}. Previous image retained at ${backupDirectory}`);
      }
    }
    throw error;
  } finally {
    await unlink(candidate).catch(() => {});
    await unlink(receiptCandidate).catch(() => {});
    if (!existingLease) await lease.release();
  }
}

async function sourceRepository(sourceRoot, workingDirectory, command) {
  const preferred = path.resolve(sourceRoot ?? process.env.O_LANG_ROOT ?? path.join(os.homedir(), "OSTADIX"));
  let source = preferred;
  try { await access(path.join(source, "Cargo.toml")); }
  catch (error) {
    if (sourceRoot || (error.code !== "ENOENT" && error.code !== "ENOTDIR")) throw error;
    source = path.join(workingDirectory, "source");
    await mkdir(source, { recursive: true, mode: 0o700 });
    await command("git", ["-C", source, "init", "--quiet"]);
    await command("git", ["-C", source, "remote", "add", "origin", SOURCE_URL]);
    await command("git", ["-C", source, "fetch", "--depth", "1", "origin", PINNED_OSTADIX_COMMIT], { timeout: 300_000 });
    await command("git", ["-C", source, "checkout", "--detach", "FETCH_HEAD"]);
  }
  const [top, revision, branch, remote, dirty] = await Promise.all([
    command("git", ["-C", source, "rev-parse", "--show-toplevel"]),
    command("git", ["-C", source, "rev-parse", "HEAD"]),
    command("git", ["-C", source, "branch", "--show-current"]),
    command("git", ["-C", source, "remote", "get-url", "origin"]),
    command("git", ["-C", source, "status", "--porcelain", "--untracked-files=no"]),
  ]);
  if (await realpath(source) !== await realpath(top.stdout.trim())) throw new Error("The Ostadix source path is not its repository root.");
  if (!/^https:\/\/github\.com\/lostadi\/OSTADIX(?:\.git)?\/?$|^git@github\.com:lostadi\/OSTADIX(?:\.git)?$/.test(remote.stdout.trim())) {
    throw new Error(`Unexpected Ostadix source remote: ${remote.stdout.trim()}`);
  }
  if (!COMMIT.test(revision.stdout.trim())) throw new Error("Cannot establish the Ostadix source commit.");
  if (dirty.stdout.trim()) throw new Error(`Ostadix has uncommitted tracked changes at ${source}; commit them or use --source with a clean checkout so the guest source is reproducible.`);
  return { root: await realpath(source), commit: revision.stdout.trim(), branch: branch.stdout.trim() || "detached", remote: remote.stdout.trim() };
}

function mountExportScript() {
  return `mkdir -p /mnt/ovm-export\nmountpoint -q /mnt/ovm-export || mount -t virtiofs ovmexport /mnt/ovm-export\n`;
}

export function guestExportScript({ includeRuntime = true } = {}) {
  return `${mountExportScript()}
. /etc/profile.d/ovm-ostadix.sh
ovm-guest-check --output /mnt/ovm-export/smoke.json
cp /var/lib/ovm/guest/install.json /mnt/ovm-export/install.json
${includeRuntime ? `# An explicit installed-tool list avoids replacing a legacy guest's /usr or dpkg database.
cat > /mnt/ovm-export/runtime-files.txt <<'OVM_FILES'
opt/ostadix
opt/ostadix-toolchain
usr/local/bin/O
usr/local/bin/o
usr/local/bin/o-cli
usr/local/bin/ostadix-evaluator
usr/local/bin/olangc
usr/local/bin/ocorec
usr/local/bin/o-link
usr/local/bin/o-unlink
usr/local/bin/ogit
usr/local/bin/o-live-host
usr/local/bin/o-node
usr/local/bin/octl
usr/local/bin/o-registry
usr/local/bin/o-info
usr/local/bin/ostadix-device
usr/local/bin/ostadix-install.json
usr/local/bin/ostadix-mcp
usr/local/bin/ostadix-mcp-client
usr/local/bin/o-c
usr/local/bin/olangc-c
usr/local/bin/ovm-guest-check
usr/local/bin/rustc
usr/local/bin/cargo
usr/local/bin/rustdoc
usr/local/bin/wasmtime
usr/local/bin/nebula
usr/local/bin/ovm-peer
usr/local/sbin/ovm-guest-start
usr/local/sbin/ovm-peer-service
etc/profile.d/ovm-env.sh
etc/profile.d/ovm-ostadix.sh
etc/profile.d/zz-ovm-start.sh
etc/ovm
etc/systemd/system/ovm-guest.service
var/lib/ovm/guest
OVM_FILES
tar --numeric-owner -C / -czf /mnt/ovm-export/runtime.tar.gz -T /mnt/ovm-export/runtime-files.txt
sha256sum /mnt/ovm-export/runtime.tar.gz > /mnt/ovm-export/runtime.sha256
` : ""}sync
`;
}

function guestBootstrapScript() {
  return `#!/usr/bin/env bash
set -Eeuo pipefail
ip link set lo up
interface=$(find /sys/class/net -mindepth 1 -maxdepth 1 ! -name lo -printf '%f\\n' | head -n 1)
test -n "$interface"
ip link set "$interface" up
dhclient -1 "$interface"
root_device=$(readlink -f "$(findmnt -n -o SOURCE /)")
test -b "$root_device"
parent=$(lsblk -ndo PKNAME "$root_device")
test -n "$parent"
partition=$(cat "/sys/class/block/$(basename "$root_device")/partition")
set +e
growth=$(growpart "/dev/$parent" "$partition" 2>&1)
growth_status=$?
set -e
printf '%s\\n' "$growth"
if [ "$growth_status" != 0 ] && ! printf '%s' "$growth" | grep -q NOCHANGE; then exit "$growth_status"; fi
resize2fs "$root_device"
`;
}

export function guestProvisionScript() {
  return `${guestBootstrapScript()}
session_device=$(blkid -L sessions)
test -b "$session_device"
test "$session_device" != "$root_device"
mkdir -p /work
mountpoint -q /work || mount -t ext4 "$session_device" /work
test "$(findmnt -n -o FSTYPE /work)" = ext4
resize2fs "$session_device"
mkdir -p /work/ovm-provision-build
OVM_BUILD_SCRATCH=/work/ovm-provision-build bash /mnt/ovm-provision/guest/provision.sh
${guestExportScript()}`;
}

export async function setupGuests({ projectRoot, bundlePath, sourceRoot, force = false,
  sourceBundlePath = CLAUDE_SOURCE_BUNDLE, onOutput = () => {}, timeoutMs = 3 * 60 * 60 * 1000 } = {},
{ command = execute, run = runGuestScript, cloneBundle = cloneProvisionBundle,
  publish = publishPreparedGuest, Lease = VMLease, platform = process.platform, architecture = process.arch } = {}) {
  const target = paths(projectRoot, bundlePath);
  if (platform !== "darwin" || architecture !== "arm64") throw new Error("Built-in guest setup requires Apple Silicon macOS.");
  await assertPrivateBundle(target, sourceBundlePath);
  await Promise.all([access(path.join(target.root, "host/OVMShell"), constants.X_OK),
    access(path.join(target.root, "host/smol-bin.arm64.img"))]);
  const status = await getGuestStatus({ projectRoot: target.root, bundlePath: target.bundle });
  if (!force && !sourceRoot && status.prepared && !status.needsUpdate) {
    onOutput("Built-in guests already have the current verified Ostadix environment.\n");
    return { changed: false, ...status };
  }
  const runId = `${Date.now()}-${randomUUID()}`;
  const runDirectory = path.join(target.root, "runtime", `guest-setup-${runId}`);
  await mkdir(runDirectory, { recursive: true, mode: 0o700 });
  const source = await sourceRepository(sourceRoot, runDirectory, command);
  const recipeSha256 = await guestRecipeSha256(target.root);
  if (!force && status.prepared && !status.needsUpdate && status.profile.sourceCommit === source.commit) {
    onOutput("Built-in guests already have the current verified Ostadix environment.\n");
    return { changed: false, ...status };
  }
  const disk = await statfs(path.join(target.root, "vm"));
  const available = Number(disk.bavail) * Number(disk.bsize);
  if (available < 10 * 1024 ** 3) throw new Error(`Guest setup needs at least 10 GiB free on the host; ${(available / 1024 ** 3).toFixed(1)} GiB is available. Current VM data is unchanged.`);
  const lease = new Lease(target.lease, { resource: "built-in VM image" });
  await lease.acquire();
  const stagingBundle = path.join(target.root, "vm", `.provision-${runId}.bundle`);
  const payload = path.join(runDirectory, "payload");
  const exportPath = path.join(runDirectory, "export");
  try {
    await assertNoOpenBundleFiles(target.bundle, { command });
    await mkdir(path.join(payload, "guest"), { recursive: true, mode: 0o700 });
    await mkdir(exportPath, { mode: 0o700 });
    const archive = path.join(payload, "ostadix.tar");
    await command("git", ["-C", source.root, "archive", "--format=tar", `--output=${archive}`, source.commit], { timeout: 120_000 });
    const sourceArchiveSha256 = await sha256File(archive);
    await Promise.all(GUEST_FILES.map((name) => copyFile(path.join(target.root, "guest", name), path.join(payload, "guest", name), constants.COPYFILE_EXCL)));
    const sourceRootfsSizeBytes = (await regularFile(path.join(sourceBundlePath, "rootfs.img"))).size;
    await writeFile(path.join(runDirectory, "source.json"), `${JSON.stringify({ ...source, sourceArchiveSha256, recipeSha256 }, null, 2)}\n`, { mode: 0o600 });
    onOutput(`Preparing Ostadix ${source.commit.slice(0, 12)} in an APFS copy of the private VM.\nBuild logs: ${runDirectory}\n`);
    if (target.bundle !== path.join(target.root, "vm/claudevm.bundle")) throw new Error("Automatic setup currently targets the built-in claudevm.bundle only.");
    await cloneBundle(target.root, stagingBundle);
    for (const image of ["rootfs.img", "sessiondata.img"]) {
      const file = path.join(stagingBundle, image);
      const metadata = await regularFile(file);
      await truncate(file, Math.max(metadata.size, IMAGE_BYTES));
    }
    await run({ projectRoot: target.root, bundlePath: stagingBundle, sharePath: payload,
      exportShare: exportPath, script: guestProvisionScript(),
      logPath: path.join(runDirectory, "build.log"), timeoutMs, onOutput });
    const published = await publish({ projectRoot: target.root, bundlePath: target.bundle,
      stagingBundle, exportPath, sourceCommit: source.commit, sourceArchiveSha256,
      recipeSha256, sourceRootfsSizeBytes, sourceBundlePath, lease });
    onOutput(`Ostadix guest environment verified and installed. Previous root disk: ${published.backupDirectory}\n`);
    return { changed: true, prepared: true, verified: true, ...published, runDirectory, stagingBundle };
  } catch (error) {
    const failure = new Error(`${error.message}\nGuest setup evidence and staging are retained at ${runDirectory} and ${stagingBundle}.`, { cause: error });
    if (Number.isInteger(error.exitCode)) failure.exitCode = error.exitCode;
    else if (/interrupted/i.test(error.message)) failure.exitCode = 130;
    throw failure;
  } finally { await lease.release(); }
}

export function preparedImageReceiptPath(rootfsPath) { return `${path.resolve(rootfsPath)}.ovm-guest-v1.json`; }

/** Record a clone only when its caller already knows which prepared parent produced it. */
export async function recordPreparedClone({ rootfsPath, profile }) {
  const metadata = await regularFile(rootfsPath, { privateFile: true });
  validateGuestProfile(profile, { rootfsSizeBytes: metadata.size });
  await writeFile(preparedImageReceiptPath(rootfsPath), `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  return profile;
}

/** Upgrade a clone of an existing pocket; preserve its files and apt database. */
export async function upgradePreparedImage({ projectRoot, bundlePath, rootfsPath, stateDirectory, onOutput = () => {},
  timeoutMs = 90 * 60 * 1000 } = {},
{ run = runGuestScript, cloneBundle = cloneProvisionBundle, clone = cloneFile,
  command = execute, Lease = VMLease, move = rename } = {}) {
  const target = paths(projectRoot, bundlePath);
  const base = await ensurePreparedImage({ projectRoot: target.root, bundlePath: target.bundle });
  const image = await realpath(path.resolve(rootfsPath));
  if (image === await realpath(target.rootfs)) {
    throw new Error("Pocket upgrades require an existing private pocket root image, not the base bundle.");
  }
  const original = await regularFile(image, { privateFile: true });
  const receiptPath = preparedImageReceiptPath(image);
  let oldReceipt;
  try {
    await regularFile(receiptPath, { privateFile: true });
    oldReceipt = await readFile(receiptPath);
    const profile = validateGuestProfile(JSON.parse(oldReceipt), { rootfsSizeBytes: original.size });
    if (profile.recipeSha256 === base.recipeSha256 && profile.sourceArchiveSha256 === base.sourceArchiveSha256) {
      return { changed: false, rootfsPath: image, profile };
    }
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError) && !/preparation receipt|smoke evidence/.test(error.message)) throw error;
  }
  if (target.bundle !== path.join(target.root, "vm/claudevm.bundle")) {
    throw new Error("This portable pocket does not match its bundled runtime profile. Resume with a compatible capsule/runtime; automatic upgrades require the built-in guest image.");
  }
  // Custom --state-dir pockets remain supported. A valid receipt needs only a
  // read; a legacy mutation must be inside the controller's configured scope.
  const privateRoot = await realpath(stateDirectory ?? path.join(target.root, "vm"));
  const relative = path.relative(privateRoot, image);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Pocket upgrade image is outside the configured state directory.");
  }
  const originalClaude = await realpath(path.join(CLAUDE_SOURCE_BUNDLE, "rootfs.img")).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (image === originalClaude) throw new Error("Refusing to upgrade Claude's original VM image.");
  if (!base.runtimeArchive?.path || !SHA256.test(base.runtimeArchive.sha256 ?? "")) {
    throw new Error("The prepared runtime archive is missing. Run: ovm guests setup --force");
  }
  const runtimeArchive = path.resolve(base.runtimeArchive.path);
  await regularFile(runtimeArchive, { privateFile: true });
  if (await sha256File(runtimeArchive) !== base.runtimeArchive.sha256) throw new Error("The prepared runtime archive changed; rebuild it with ovm guests setup --force.");
  const runId = `${Date.now()}-${randomUUID()}`;
  const runDirectory = path.join(target.root, "runtime", `guest-upgrade-${runId}`);
  const payload = path.join(runDirectory, "payload");
  const exportPath = path.join(runDirectory, "export");
  const stagingBundle = path.join(target.root, "vm", `.upgrade-${runId}.bundle`);
  const backupDirectory = path.join(target.root, "vm", "guest-backups", `pocket-${runId}`);
  const lease = new Lease(`${image}.guest-setup.lease`, { resource: "pocket VM image" });
  await lease.acquire();
  const candidate = `${image}.prepared-${runId}`;
  const receiptCandidate = `${receiptPath}.prepared-${runId}`;
  let replaced = false;
  try {
    await assertNoOpenFiles([image], { command });
    await mkdir(payload, { recursive: true, mode: 0o700 });
    await mkdir(exportPath, { mode: 0o700 });
    await clone(runtimeArchive, path.join(payload, "runtime.tar.gz"));
    await writeFile(path.join(payload, "runtime.sha256"), `${base.runtimeArchive.sha256}  runtime.tar.gz\n`, { mode: 0o600 });
    await copyFile(path.join(target.root, "guest/upgrade.sh"), path.join(payload, "upgrade.sh"), constants.COPYFILE_EXCL);
    // Take a short base-image lease only while copying its kernel/helper inputs.
    const baseLease = new Lease(target.lease, { resource: "built-in VM image" });
    await baseLease.acquire();
    try {
      await assertNoOpenBundleFiles(target.bundle, { command });
      await cloneBundle(target.root, stagingBundle);
    } finally { await baseLease.release(); }
    const stageRoot = path.join(stagingBundle, "rootfs.img");
    const temporaryRoot = path.join(stagingBundle, ".existing-pocket.img");
    await clone(image, temporaryRoot);
    await move(temporaryRoot, stageRoot);
    await truncate(stageRoot, Math.max(original.size, IMAGE_BYTES));
    onOutput(`Adding Ostadix to existing pocket ${path.basename(image)}; its data stays in the cloned root disk.\nLog: ${runDirectory}\n`);
    await run({ projectRoot: target.root, bundlePath: stagingBundle, sharePath: payload,
      exportShare: exportPath, logPath: path.join(runDirectory, "upgrade.log"), timeoutMs, onOutput,
      script: `${guestBootstrapScript()}\nbash /mnt/ovm-provision/upgrade.sh\n${guestExportScript({ includeRuntime: false })}` });
    const smoke = validateSmokeReport(JSON.parse(await readFile(path.join(exportPath, "smoke.json"), "utf8")));
    const installation = JSON.parse(await readFile(path.join(exportPath, "install.json"), "utf8"));
    if (installation.verified !== true || installation.source_sha256 !== base.sourceArchiveSha256) throw new Error("Pocket upgrade evidence does not match the prepared runtime.");
    const staged = await regularFile(stageRoot, { privateFile: true });
    const profile = validateGuestProfile({ ...base, preparedAt: new Date().toISOString(),
      rootfsSizeBytes: staged.size, smoke, installation, upgradedFromSizeBytes: original.size });
    await lease.requireOwnership();
    await assertNoOpenFiles([image, stageRoot], { command });
    if (!sameFileState(original, await stat(image))) throw new Error("The pocket changed while its upgrade was running; refusing to replace it.");
    await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
    await clone(image, path.join(backupDirectory, "rootfs.img"));
    if (oldReceipt) await writeFile(path.join(backupDirectory, GUEST_PROFILE_MANIFEST), oldReceipt, { mode: 0o600, flag: "wx" });
    await clone(stageRoot, candidate);
    await writeFile(receiptCandidate, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await move(candidate, image);
    replaced = true;
    await move(receiptCandidate, receiptPath);
    return { changed: true, rootfsPath: image, profile, backupDirectory, runDirectory, stagingBundle };
  } catch (error) {
    if (replaced) {
      try {
        const restore = `${image}.restore-${runId}`;
        await clone(path.join(backupDirectory, "rootfs.img"), restore);
        await move(restore, image);
        if (oldReceipt) await writeFile(receiptPath, oldReceipt, { mode: 0o600 });
        else await unlink(receiptPath).catch((missing) => { if (missing.code !== "ENOENT") throw missing; });
      } catch (rollback) {
        throw new Error(`${error.message}; pocket rollback failed: ${rollback.message}. Prior data is retained at ${backupDirectory}`);
      }
    }
    const failure = new Error(`${error.message}\nPocket upgrade staging retained: ${stagingBundle}; log: ${runDirectory}`, { cause: error });
    if (Number.isInteger(error.exitCode)) failure.exitCode = error.exitCode;
    else if (/interrupted/i.test(error.message)) failure.exitCode = 130;
    throw failure;
  } finally {
    await unlink(candidate).catch(() => {});
    await unlink(receiptCandidate).catch(() => {});
    await lease.release();
  }
}

export async function checkGuests({ projectRoot, bundlePath, onOutput = () => {} } = {},
{ run = runGuestScript, cloneBundle = cloneProvisionBundle, command = execute, Lease = VMLease } = {}) {
  const target = paths(projectRoot, bundlePath);
  const profile = await ensurePreparedImage({ projectRoot: target.root, bundlePath: target.bundle });
  const runId = `${Date.now()}-${randomUUID()}`;
  const runDirectory = path.join(target.root, "runtime", `guest-check-${runId}`);
  const payload = path.join(runDirectory, "payload");
  const exportPath = path.join(runDirectory, "export");
  const stagingBundle = path.join(target.root, "vm", `.guest-check-${runId}.bundle`);
  await mkdir(payload, { recursive: true, mode: 0o700 });
  await mkdir(exportPath, { mode: 0o700 });
  const lease = new Lease(target.lease, { resource: "built-in VM image" });
  await lease.acquire();
  try {
    await assertNoOpenBundleFiles(target.bundle, { command });
    if (target.bundle !== path.join(target.root, "vm/claudevm.bundle")) throw new Error("Guest checks currently target the built-in claudevm.bundle only.");
    await cloneBundle(target.root, stagingBundle);
  } finally { await lease.release(); }
  onOutput(`Checking a fresh copy of the installed guest. Log: ${runDirectory}\n`);
  await run({ projectRoot: target.root, bundlePath: stagingBundle, sharePath: payload,
    exportShare: exportPath, script: `set -Eeuo pipefail\n${guestExportScript({ includeRuntime: false })}`,
    logPath: path.join(runDirectory, "check.log"), timeoutMs: 10 * 60 * 1000, onOutput });
  const smoke = validateSmokeReport(JSON.parse(await readFile(path.join(exportPath, "smoke.json"), "utf8")));
  return { ok: true, sourceCommit: profile.sourceCommit, smoke, runDirectory, stagingBundle };
}

export function guestHelp() {
  return `OVM guest environment\n\n  ovm guests setup             Install Ostadix, MCP and language runtimes in the built-in VM\n  ovm guests status            Show the installed environment without booting a VM\n  ovm guests check             Boot a fresh copy and execute the guest checks\n\nSetup builds in a private copy and keeps the previous root disk as a backup.\nUse setup --source /path/to/OSTADIX for a clean local source checkout,\nor setup --force to rebuild the same version. Add --json for machine-readable results.\n`;
}

export async function runGuestsCli(args, { projectRoot, output = process.stdout, progress = process.stderr,
  setup = setupGuests, status = getGuestStatus, check = checkGuests } = {}) {
  const [action = "status", ...rest] = args;
  if (["help", "--help", "-h"].includes(action) || rest.includes("--help")) { output.write(guestHelp()); return 0; }
  if (!["setup", "status", "check"].includes(action)) throw new Error(`Unknown guest command: ${action}. Run: ovm guests help`);
  let json = false, force = false, sourceRoot;
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === "--json") json = true;
    else if (argument === "--force" && action === "setup") force = true;
    else if (argument === "--source" && action === "setup" && rest[index + 1] && !rest[index + 1].startsWith("--")) sourceRoot = path.resolve(rest[++index]);
    else throw new Error(`Unknown or incomplete option: ${argument}. Run: ovm guests help`);
  }
  const options = { projectRoot, sourceRoot, force, onOutput: (chunk) => progress.write(chunk) };
  const result = await ({ setup, status, check })[action](options);
  if (json) output.write(`${JSON.stringify(result, null, 2)}\n`);
  else if (action === "status") {
    output.write(result.prepared
      ? `Built-in guests: ready\nOstadix: ${result.profile.sourceCommit}\nVerified checks: ${result.profile.smoke.passed}\n${result.needsUpdate ? "A newer guest setup recipe is available. Run: ovm guests setup\n" : ""}`
      : `Built-in guests: setup needed\n${result.errors.join("\n")}\n`);
  } else if (action === "check") output.write(`Guest checks passed: ${result.smoke.passed}\nEvidence: ${result.runDirectory}\n`);
  else output.write(result.changed ? "Built-in VM setup complete. You can now use ovm task or ovm shell.\n" : "Built-in VM environment is already up to date.\n");
  return action === "status" && !result.prepared ? 2 : 0;
}
