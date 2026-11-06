import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, link, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, statfs, unlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { deflateRaw, inflateRaw } from "node:zlib";
import { DEFAULT_MODEL } from "./ollama-agent.mjs";
import { VMLease } from "./lease.mjs";

export const CAPSULE_SCHEMA = "ovm.agent-capsule/v1";
export const CAPSULE_MAGIC = Buffer.from("OVM-AGENT-CAPSULE\0v1\n");
const execute = promisify(execFile);
const deflate = promisify(deflateRaw);
const inflate = promisify(inflateRaw);
const CHUNK = 1024 * 1024;
const ZERO = Buffer.alloc(CHUNK);
const HEADER_LIMIT = 16 * 1024 * 1024;
const JSON_LIMIT = 32 * 1024 * 1024;
const FILE_LIMIT = 1024;
const LOGICAL_LIMIT = 1024 ** 4;
const FILE_SIZE_LIMIT = 256 * 1024 ** 3;
const RESERVE = 256 * 1024 ** 2;
const DEFAULT_SESSION_DISK_BYTES = 10 * 1024 ** 3;
const ID = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const DIGEST = /^[a-f0-9]{64}$/;

function requireId(value, label = "gent ID") {
  if (typeof value !== "string" || !ID.test(value)) throw new Error(`${label} must contain 1–48 lowercase letters, digits, underscores, or hyphens, starting with a letter or digit`);
  return value;
}
function sum(values) { return values.reduce((a, b) => a + b, 0); }
function safeInteger(value, maximum, name) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new Error(`Invalid capsule ${name}`);
  return value;
}
async function exists(file) { try { await lstat(file); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } }
async function regular(file, maximum = FILE_SIZE_LIMIT) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximum) throw new Error(`Expected a bounded regular file: ${file}`);
  return info;
}
async function privateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Expected a real directory: ${directory}`);
}
async function ownedSubdirectory(root, relative) {
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    if (part === "." || part === "..") throw new Error("Unsafe directory component");
    current = path.join(current, part);
    await privateDirectory(current);
  }
  return current;
}
async function publishDirectory(source, destination) {
  // POSIX rename can replace an existing empty directory. Use the platform's
  // no-replace operation so even concurrent non-OVM creators are preserved.
  const script = `import ctypes, errno, os, sys\nlibc=ctypes.CDLL(None, use_errno=True)\na=os.fsencode(sys.argv[1]); b=os.fsencode(sys.argv[2])\nif sys.platform == "darwin":\n r=libc.renamex_np(a,b,4)\nelif sys.platform.startswith("linux") and hasattr(libc,"renameat2"):\n r=libc.renameat2(-100,a,-100,b,1)\nelse:\n raise RuntimeError("This host lacks atomic no-replace directory publication")\nif r:\n e=ctypes.get_errno(); raise OSError(e,os.strerror(e),sys.argv[2])\n`;
  await execute("python3", ["-c", script, source, destination], { timeout: 15_000 });
}
async function jsonFile(file) { await regular(file, JSON_LIMIT); return JSON.parse(await readFile(file, "utf8")); }
function validateArtifactIndex(index, files) {
  if (index?.schema !== "ovm.artifacts/v1" || !Array.isArray(index.artifacts) || index.artifacts.length > 1024) throw new Error("Invalid capsule artifact index");
  for (const artifact of index.artifacts) {
    if (!DIGEST.test(artifact.sha256 ?? "") || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0 || artifact.guestPath !== `/ovm/artifacts/sha256-${artifact.sha256}`) throw new Error("Invalid capsule artifact reference");
    const file = files.find((entry) => entry.path === `artifacts/sha256-${artifact.sha256}`);
    if (!file || (file.size !== undefined && file.size !== artifact.bytes)) throw new Error("Capsule artifact byte closure is incomplete");
  }
}
function identityOf(info) { return [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(":"); }
function notice(onProgress, phase, data = {}) { onProgress?.({ phase, ...data }); }
async function diskBudget(directory, bytes, reserveBytes = RESERVE) {
  const disk = await statfs(directory);
  const available = Number(disk.bavail) * Number(disk.bsize);
  if (bytes + reserveBytes > available) throw new Error(`Capsule needs ${(bytes / 1024 ** 3).toFixed(2)} GiB plus ${(reserveBytes / 1024 ** 2).toFixed(0)} MiB free reserve; ${(available / 1024 ** 3).toFixed(2)} GiB is available`);
}
async function reflinkSupported(directory) {
  const temporary = await mkdtemp(path.join(directory, ".capsule-reflink-"));
  try {
    const source = path.join(temporary, "source"), target = path.join(temporary, "copy");
    await writeFile(source, Buffer.alloc(4096, 1), { flag: "wx", mode: 0o600 });
    try { await copyFile(source, target, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE_FORCE); return true; }
    catch (error) {
      if (["ENOTSUP", "EOPNOTSUPP", "EINVAL", "ENOSYS", "EXDEV"].includes(error.code)) return false;
      throw error;
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
async function existingAncestor(directory) {
  let current = directory;
  while (!await exists(current)) {
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`Cannot inspect destination filesystem: ${directory}`);
    current = parent;
  }
  return current;
}

/** Account for import staging and conventional Linux copies before extraction. */
export async function estimateCapsuleImportBudget(manifest, sizes, { stateRoot, modelsRoot, installModel = true,
  platform = process.platform, canReflink = reflinkSupported, metadata = lstat } = {}) {
  const budget = { stateDirectoryBytes: sizes.materializedBytes, modelDirectoryBytes: 0, extraBaseBytes: 0, extraModelBytes: 0, modelBudgetDirectory: null };
  if (platform !== "linux") return budget;
  const reflinks = await canReflink(stateRoot);
  if (!reflinks) {
    const base = manifest.files.find(file => file.path === manifest.runtime.baseRootfsPath);
    budget.extraBaseBytes = sum(base.extents.map(extent => extent[1]));
    budget.stateDirectoryBytes += budget.extraBaseBytes;
  }
  if (installModel) {
    const modelParent = await existingAncestor(modelsRoot);
    const sameFilesystem = (await metadata(stateRoot)).dev === (await metadata(modelParent)).dev;
    if (!reflinks || !sameFilesystem) {
      for (const file of manifest.files.filter(entry => entry.path.startsWith("model/"))) {
        // Existing content is verified by publishModel and is never replaced.
        if (!await exists(path.join(modelsRoot, file.path.slice(6)))) budget.extraModelBytes += file.size;
      }
      if (sameFilesystem) budget.stateDirectoryBytes += budget.extraModelBytes;
      else { budget.modelDirectoryBytes = budget.extraModelBytes; budget.modelBudgetDirectory = modelParent; }
    }
  }
  return budget;
}
async function cloneRegularFile(source, target, { extents, size, reserveBytes } = {}) {
  try {
    await copyFile(source, target, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE_FORCE);
    return;
  } catch (error) {
    if (error.code === "EEXIST") throw error;
    if (!["ENOTSUP", "EOPNOTSUPP", "EINVAL", "ENOSYS", "EXDEV"].includes(error.code)) throw error;
    await rm(target, { force: true });
  }
  // Node's forced reflink is not supported by every macOS build. Native cp -c
  // uses APFS clonefile, retaining sparse storage without duplicating the disk.
  if (process.platform === "darwin") {
    if (await exists(target)) throw new Error(`Clone destination already exists: ${target}`);
    try {
      await execute("/bin/cp", ["-c", "-p", "-n", source, target], { timeout: 120_000 });
      if ((await regular(target)).size !== (await regular(source)).size) throw new Error("Native clone size mismatch");
      return;
    } catch (error) {
      await rm(target, { force: true });
      if (!error.stderr?.includes("Operation not supported") && !error.stderr?.includes("Cross-device link")) throw error;
    }
  }
  if (!extents) {
    await diskBudget(path.dirname(target), (await regular(source)).size, reserveBytes);
    await copyFile(source, target, constants.COPYFILE_EXCL);
    return;
  }
  // Reflink is optional. A conventional filesystem still gets sparse files,
  // and the additional physical allocation is checked before a fallback copy.
  await diskBudget(path.dirname(target), sum(extents.map((extent) => extent[1])), reserveBytes);
  const input = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const output = await open(target, "wx", 0o600);
  try {
    for (const [offset, length] of extents) await writeAll(output, await readExact(input, length, offset), offset);
    await output.truncate(size); await output.sync();
  } finally { await input.close(); await output.close(); }
}
async function writeAll(handle, buffer, position = null) {
  let consumed = 0;
  while (consumed < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, consumed, buffer.length - consumed, position === null ? null : position + consumed);
    if (!bytesWritten) throw new Error("Capsule write made no progress");
    consumed += bytesWritten;
  }
}
async function readExact(handle, length, position) {
  const buffer = Buffer.alloc(length);
  let consumed = 0;
  while (consumed < length) {
    const { bytesRead } = await handle.read(buffer, consumed, length - consumed, position + consumed);
    if (!bytesRead) throw new Error("Capsule or source file is truncated");
    consumed += bytesRead;
  }
  return buffer;
}
function updateZeros(hash, length) { for (let left = length; left > 0; left -= CHUNK) hash.update(ZERO.subarray(0, Math.min(left, CHUNK))); }
async function hashFile(file) {
  await regular(file);
  const hash = createHash("sha256");
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk); }
  finally { await handle.close(); }
  return hash.digest("hex");
}

// These are data paths, never extraction instructions. Archives cannot name
// links, devices, executable host files, controller credentials, or ../ paths.
function allowedPath(value) {
  if (typeof value !== "string" || value.length > 512 || value.includes("\\") || value.split("/").some((part) => !part || part === "." || part === "..")) return false;
  return value === "state/swarm.json"
    || /^pockets\/[a-z0-9][a-z0-9_-]{0,47}\.rootfs\.img(?:\.ovm-guest-v1\.json)?$/.test(value)
    || /^runtime\/(?:vmlinuz|initrd|smol-bin\.arm64\.img|profile\.json)$/.test(value)
    || /^artifacts\/(?:index\.json|sha256-[a-f0-9]{64})$/.test(value)
    || /^model\/blobs\/sha256-[a-f0-9]{64}$/.test(value)
    || /^model\/manifests\/[A-Za-z0-9._:-]+\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+$/.test(value);
}

export function ollamaManifestRelative(model) {
  if (typeof model !== "string" || !model || model.includes("\\") || model.includes("@") || model.includes("\0")) throw new Error("A local tagged Ollama model is required for an offline capsule");
  let name = model;
  let tag = "latest";
  if (name.lastIndexOf(":") > name.lastIndexOf("/")) { tag = name.slice(name.lastIndexOf(":") + 1); name = name.slice(0, name.lastIndexOf(":")); }
  const pieces = name.split("/");
  if (!pieces.every((part) => /^[A-Za-z0-9._-]+$/.test(part) && part !== "." && part !== "..") || !/^[A-Za-z0-9._-]+$/.test(tag) || tag === "." || tag === "..") throw new Error("Unsafe or unsupported Ollama model name");
  const registry = pieces.length > 1 && (pieces[0].includes(".") || pieces[0] === "localhost") ? pieces.shift() : "registry.ollama.ai";
  if (pieces.length === 1) pieces.unshift("library");
  return path.posix.join("manifests", registry, ...pieces, tag);
}

function blobDescriptors(manifest) {
  if (manifest?.schemaVersion !== 2 || !Array.isArray(manifest.layers) || !manifest.config) throw new Error("Unsupported Ollama manifest; schemaVersion 2 with config and layers is required");
  const descriptors = [manifest.config, ...manifest.layers];
  if (!manifest.layers.some((layer) => layer.mediaType === "application/vnd.ollama.image.model")) throw new Error("Ollama model has no local model-weight layer; capsule would not be usable offline");
  for (const item of descriptors) {
    if (!/^sha256:[a-f0-9]{64}$/.test(item.digest ?? "")) throw new Error("Ollama manifest contains an unsupported blob digest");
    safeInteger(item.size, FILE_SIZE_LIMIT, "model blob size");
  }
  const unique = new Map();
  for (const item of descriptors) {
    if (unique.has(item.digest) && unique.get(item.digest).size !== item.size) throw new Error("Ollama manifest repeats a digest with conflicting sizes");
    unique.set(item.digest, item);
  }
  return [...unique.values()];
}

async function assertUnused(files) {
  if (!files.length) return;
  const lsof = process.platform === "darwin" ? "/usr/sbin/lsof" : "lsof";
  try {
    const result = await execute(lsof, ["-t", "--", ...files], { timeout: 15_000, maxBuffer: 1024 * 1024 });
    if (String(result.stdout).trim()) throw new Error(`VM files are open in process(es) ${String(result.stdout).trim().split(/\s+/).join(", ")}; stop the gent before making a capsule`);
    if (String(result.stderr).trim()) throw new Error(`Cannot verify that VM files are closed: ${result.stderr}`);
  } catch (error) {
    if (error.code === 1 && !String(error.stdout ?? "").trim() && !String(error.stderr ?? "").trim()) return;
    throw error;
  }
}

function paths(options) {
  const projectRoot = path.resolve(options.projectRoot);
  return { projectRoot, stateRoot: path.resolve(options.stateRoot ?? path.join(projectRoot, "vm/pockets")), modelsRoot: path.resolve(options.modelsRoot ?? process.env.OLLAMA_MODELS ?? path.join(os.homedir(), ".ollama/models")) };
}

export async function inspectAgent({ agentId, ...options }) {
  requireId(agentId);
  const { stateRoot } = paths(options);
  const directory = path.join(stateRoot, agentId);
  let state;
  try {
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Gent directory must be a real directory");
    state = await jsonFile(path.join(directory, "swarm.json"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const missing = new Error(`No saved gent "${agentId}" at ${directory}. Run gent list to see saved IDs. To create it, run gent chat --swarm-id ${agentId}, then send a message; opening chat alone does not save a gent.`, { cause: error });
    missing.code = error.code;
    missing.path = error.path;
    throw missing;
  }
  if (state.protocol !== "ovm.agent-pocket/v1" || !Array.isArray(state.agents) || !state.agents.length) throw new Error("Unsupported or empty gent state");
  const lease = await new VMLease(path.join(directory, ".controller.lease")).inspect();
  return { agentId, directory, statePath: path.join(directory, "swarm.json"), state, lease, completed: state.agents.every((agent) => agent.finished), model: state.model ?? state.transcript?.findLast((turn) => turn.model)?.model ?? DEFAULT_MODEL };
}

export async function listAgents(options) {
  const { stateRoot } = paths(options);
  if (!await exists(stateRoot)) return [];
  const result = [];
  for (const item of await readdir(stateRoot, { withFileTypes: true })) {
    if (!item.isDirectory() || !ID.test(item.name) || !await exists(path.join(stateRoot, item.name, "swarm.json"))) continue;
    try {
      const entry = await inspectAgent({ ...options, agentId: item.name });
      result.push({ id: entry.agentId, mission: entry.state.mission, completed: entry.completed, active: entry.lease.alive, pockets: entry.state.agents.length, model: entry.model, statePath: entry.statePath });
    } catch (error) { result.push({ id: item.name, error: error.message }); }
  }
  return result;
}

async function sourceInventory(options) {
  const { projectRoot, modelsRoot } = paths(options);
  const agent = await inspectAgent(options);
  if (agent.state.pendingDispatch || agent.state.pendingNative) throw new Error(`Gent has an unresolved dispatch; run gent resume ${options.agentId} to reconcile it before export or clone`);
  if (await exists(path.join(agent.directory, "pending-dispatch.json"))) throw new Error(`Gent has an unresolved dispatch; run gent resume ${options.agentId} to reconcile it before export or clone`);
  if (agent.lease.held) throw new Error(`Gent has ${agent.lease.alive ? "an active" : "a stale"} controller lease; stop it or resolve that exact lease before export`);
  const lease = new VMLease(path.join(agent.directory, ".controller.lease"), { resource: `capsule snapshot ${options.agentId}` });
  await lease.acquire();
  try {
    if (await exists(path.join(agent.directory, "pending-dispatch.json"))) throw new Error(`Gent has an unresolved dispatch; run gent resume ${options.agentId} to reconcile it before export or clone`);
    // Read state again under the same lease that task execution uses.
    agent.state = await jsonFile(agent.statePath);
    if (agent.state.pendingDispatch || agent.state.pendingNative) throw new Error(`Gent has an unresolved dispatch; run gent resume ${options.agentId} to reconcile it before export or clone`);
    agent.model = agent.state.model ?? agent.state.transcript?.findLast((turn) => turn.model)?.model ?? DEFAULT_MODEL;
    const capsule = await exists(path.join(agent.directory, "capsule.json")) ? await jsonFile(path.join(agent.directory, "capsule.json")) : null;
    const bundlePath = options.bundlePath ?? (capsule ? path.join(agent.directory, "capsule-runtime") : path.join(projectRoot, "vm/claudevm.bundle"));
    const helperPath = options.helperPath ?? (capsule ? path.join(agent.directory, "capsule-runtime/smol-bin.arm64.img") : path.join(projectRoot, "host/smol-bin.arm64.img"));
    const helperIncluded = await exists(helperPath);
    if (!helperIncluded && (options.helperPath || capsule?.runtime?.helperPath)) throw new Error(`Mapped capsule helper is missing: ${helperPath}`);
    const files = [{ path: "state/swarm.json", source: agent.statePath }];
    const artifacts = [];
    const artifactsDirectory = path.join(agent.directory, "artifacts");
    if (await exists(artifactsDirectory)) {
      const info = await lstat(artifactsDirectory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Artifact store must be a real directory");
      for (const name of await readdir(artifactsDirectory)) {
        if (name !== "index.json" && !/^sha256-[a-f0-9]{64}$/.test(name)) continue;
        const archivePath = `artifacts/${name}`;
        files.push({ path: archivePath, source: path.join(artifactsDirectory, name), ...(name.startsWith("sha256-") ? { expectedSha256: name.slice(7) } : {}) });
        artifacts.push(archivePath);
      }
      if (artifacts.length && !artifacts.includes("artifacts/index.json")) throw new Error("Artifact store has blobs without its index");
      if (artifacts.length) validateArtifactIndex(await jsonFile(path.join(artifactsDirectory, "index.json")), files);
    }
    const pockets = [];
    const seen = new Set();
    for (const pocket of agent.state.agents) {
      requireId(pocket.id, "pocket ID");
      if (seen.has(pocket.id)) throw new Error("Duplicate pocket IDs in saved state");
      seen.add(pocket.id);
      const own = path.join(agent.directory, `${pocket.id}.rootfs.img`);
      // An unbooted child inherits its parent snapshot; an unbooted original
      // starts from the prepared base. The capsule always materializes both.
      let rootfs = await exists(own) ? own : null;
      if (!rootfs && pocket.inheritRootfs) {
        const inherited = path.resolve(pocket.inheritRootfs);
        if (path.dirname(inherited) !== agent.directory) throw new Error("Cannot export an inherited image outside this gent; materialize its pocket first");
        if (await exists(inherited)) rootfs = inherited;
      }
      rootfs ??= path.join(bundlePath, "rootfs.img");
      const profile = rootfs === path.join(bundlePath, "rootfs.img") ? path.join(bundlePath, ".ovm-guest-v1.json") : `${rootfs}.ovm-guest-v1.json`;
      const receipt = await jsonFile(profile);
      if (receipt.schema !== "ovm.prepared-guest/v1" || receipt.verified !== true) throw new Error(`Pocket ${pocket.id} does not have a verified guest profile`);
      const rootfsPath = `pockets/${pocket.id}.rootfs.img`;
      const profilePath = `${rootfsPath}.ovm-guest-v1.json`;
      files.push({ path: rootfsPath, source: rootfs }, { path: profilePath, source: profile });
      pockets.push({ id: pocket.id, rootfsPath, profilePath, sourceCommit: receipt.sourceCommit ?? null });
    }
    const profilePath = path.join(bundlePath, ".ovm-guest-v1.json");
    files.push(...["vmlinuz", "initrd"].map((file) => ({ path: `runtime/${file}`, source: path.join(bundlePath, file) })),
      ...(helperIncluded ? [{ path: "runtime/smol-bin.arm64.img", source: helperPath }] : []), { path: "runtime/profile.json", source: profilePath });
    const sessionPath = path.join(bundlePath, "sessiondata.img");
    const sessionDiskBytes = await exists(sessionPath) ? (await regular(sessionPath)).size : DEFAULT_SESSION_DISK_BYTES;
    const model = options.model ?? agent.model;
    const manifestRelative = ollamaManifestRelative(model);
    const privateModels = capsule && model === capsule.model?.name ? path.join(agent.directory, "capsule-models") : null;
    const selectedModelsRoot = privateModels && await exists(path.join(privateModels, manifestRelative)) ? privateModels : modelsRoot;
    const manifestSource = path.join(selectedModelsRoot, manifestRelative);
    let modelManifest;
    try { modelManifest = await jsonFile(manifestSource); }
    catch (error) { throw new Error(`Offline capsule requires installed model ${model}, including weights. Cannot read ${manifestSource}: ${error.message}`); }
    files.push({ path: `model/${manifestRelative}`, source: manifestSource });
    const blobs = blobDescriptors(modelManifest);
    for (const blob of blobs) files.push({ path: `model/blobs/${blob.digest.replace(":", "-")}`, source: path.join(selectedModelsRoot, "blobs", blob.digest.replace(":", "-")), expectedSha256: blob.digest.slice(7), expectedSize: blob.size });
    let totalBytes = sessionDiskBytes;
    for (const file of files) {
      if (!allowedPath(file.path)) throw new Error(`Unsupported capsule data path ${file.path}`);
      const info = await regular(file.source);
      totalBytes += info.size;
      if (file.expectedSize !== undefined && info.size !== file.expectedSize) throw new Error(`Installed model blob has the wrong size: ${file.source}`);
      // Disallow a model-store directory symlink escaping its declared root.
      if (file.path.startsWith("model/")) {
        const real = await realpath(file.source);
        if (!real.startsWith(`${await realpath(selectedModelsRoot)}${path.sep}`)) throw new Error("Model store contains an external symlink");
      }
    }
    if (files.length > FILE_LIMIT || totalBytes > LOGICAL_LIMIT) throw new Error("Gent exceeds capsule file-count or logical-size limits");
    await (options.assertUnused ?? assertUnused)(files.filter((file) => file.path.endsWith(".img")).map((file) => file.source));
    const previous = agent.state.capsuleIdentity;
    const stableOrigin = createHash("sha256").update(`${os.hostname()}:${await realpath(agent.directory)}:${agent.state.swarmId}`).digest("hex");
    return { agent, lease, files, manifest: {
      schema: CAPSULE_SCHEMA, capsuleId: randomUUID(), createdAt: new Date().toISOString(),
      source: { swarmId: agent.state.swarmId, instanceId: previous?.instanceId ?? stableOrigin, lineageId: previous?.lineageId ?? stableOrigin, parentInstanceId: previous?.parentInstanceId ?? null },
      capabilities: { guestArchitecture: "aarch64", guestOperatingSystem: "linux",
        supportedBackends: [...(helperIncluded ? ["apple-vz-arm64"] : []), "qemu-arm64"],
        requiredHost: "o-gents with Node 26+ and a supported ARM64 guest backend: QEMU on Linux/macOS, or Apple Virtualization on Apple Silicon when its helper is included.",
        modelRuntime: "A separately installed compatible Ollama server is required for inference; included weights do not verify server readiness.", hostNativeProvidersIncluded: false },
      model: { name: model, manifestPath: `model/${manifestRelative}`, weightsIncluded: true, blobs: blobs.map(({ digest, size }) => ({ digest, size })) },
      runtime: { kernelPath: "runtime/vmlinuz", initrdPath: "runtime/initrd", helperPath: helperIncluded ? "runtime/smol-bin.arm64.img" : null, profilePath: "runtime/profile.json", baseRootfsPath: pockets[0].rootfsPath, sessionDiskBytes, sessionDiskPolicy: "fresh-disposable-sparse-disk" },
      network: { controllerCredentialsIncluded: false, newIdentityOnImport: true, archivedGuestIdentityState: "Private disk bytes are retained; the new root path selects a distinct identity at boot." },
      pockets,
      artifacts,
    } };
  } catch (error) { await lease.release(); throw error; }
}

async function scanFile(file, onProgress) {
  const before = await regular(file.source);
  const hash = createHash("sha256");
  const extents = [];
  const handle = await open(file.source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    for (let offset = 0; offset < before.size; offset += CHUNK) {
      const data = await readExact(handle, Math.min(CHUNK, before.size - offset), offset);
      hash.update(data);
      if (!data.equals(ZERO.subarray(0, data.length))) {
        const compressed = file.path.endsWith(".img") ? await deflate(data, { level: 1 }) : data;
        const useDeflate = compressed.length + 64 < data.length;
        extents.push([offset, data.length, useDeflate ? compressed.length : data.length, useDeflate ? "deflate" : "raw"]);
      }
      if (offset % (64 * CHUNK) === 0) notice(onProgress, "hashing", { path: file.path, completedBytes: offset + data.length, totalBytes: before.size });
    }
  } finally { await handle.close(); }
  if (identityOf(before) !== identityOf(await regular(file.source))) throw new Error(`Source changed during capsule snapshot: ${file.source}`);
  const sha256 = hash.digest("hex");
  if (file.expectedSha256 && sha256 !== file.expectedSha256) throw new Error(`Model or artifact content digest mismatch: ${file.source}`);
  return { path: file.path, size: before.size, sha256, extents, sourceIdentity: identityOf(before) };
}

export async function exportAgentCapsule(options) {
  const outputPath = path.resolve(options.outputPath);
  // Report a missing/invalid source before creating any export directories.
  // sourceInventory validates it again under the snapshot lease below.
  await inspectAgent(options);
  await privateDirectory(path.dirname(outputPath));
  if (await exists(outputPath)) throw new Error(`Refusing to overwrite capsule: ${outputPath}`);
  const inventory = await sourceInventory(options);
  const temporary = `${outputPath}.partial-${randomUUID()}`;
  try {
    const entries = [];
    for (const file of inventory.files) entries.push(await scanFile(file, options.onProgress));
    const manifest = { ...inventory.manifest, files: entries.map(({ sourceIdentity, ...entry }) => entry) };
    validateCapsuleManifest(manifest, options);
    const header = Buffer.from(JSON.stringify(manifest));
    if (header.length > HEADER_LIMIT) throw new Error("Capsule content manifest is too large");
    const storedBytes = sum(entries.map((entry) => sum(entry.extents.map((extent) => extent[2]))));
    await diskBudget(path.dirname(outputPath), storedBytes + header.length + CAPSULE_MAGIC.length + 8, options.reserveBytes);
    const archive = await open(temporary, "wx", 0o600);
    try {
      const headerLength = Buffer.alloc(8); headerLength.writeBigUInt64BE(BigInt(header.length));
      await writeAll(archive, CAPSULE_MAGIC); await writeAll(archive, headerLength); await writeAll(archive, header);
      let completedBytes = 0;
      for (let index = 0; index < entries.length; index++) {
        const entry = entries[index];
        const source = inventory.files[index].source;
        if (identityOf(await regular(source)) !== entry.sourceIdentity) throw new Error(`Source changed before packaging: ${source}`);
        const handle = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const hash = createHash("sha256");
        let previousEnd = 0;
        try {
          for (const [offset, length, storedLength, encoding] of entry.extents) {
            updateZeros(hash, offset - previousEnd);
            const data = await readExact(handle, length, offset); hash.update(data);
            const payload = encoding === "deflate" ? await deflate(data, { level: 1 }) : data;
            if (payload.length !== storedLength) throw new Error(`Source changed while packaging: ${source}`);
            await writeAll(archive, payload);
            previousEnd = offset + length; completedBytes += storedLength;
            if (completedBytes % (32 * CHUNK) < storedLength) notice(options.onProgress, "packing", { path: entry.path, completedBytes, totalBytes: storedBytes });
          }
          updateZeros(hash, entry.size - previousEnd);
          if (hash.digest("hex") !== entry.sha256 || identityOf(await regular(source)) !== entry.sourceIdentity) throw new Error(`Source changed while packaging: ${source}`);
        } finally { await handle.close(); }
      }
      await archive.sync();
    } finally { await archive.close(); }
    // link() provides atomic publication with no replacement of a concurrent file.
    await link(temporary, outputPath); await unlink(temporary);
    notice(options.onProgress, "complete", { outputPath, storedBytes });
    return { schema: CAPSULE_SCHEMA, outputPath, capsuleId: manifest.capsuleId, sourceAgentId: options.agentId, model: manifest.model.name, weightsIncluded: true, storedBytes, logicalBytes: sum(entries.map((entry) => entry.size)), pockets: manifest.pockets.length };
  } finally { await rm(temporary, { force: true }); await inventory.lease.release(); }
}

export function validateCapsuleManifest(manifest, { maximumLogicalBytes = LOGICAL_LIMIT } = {}) {
  if (manifest?.schema !== CAPSULE_SCHEMA) throw new Error("Unsupported capsule schema");
  if (!Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > FILE_LIMIT) throw new Error("Invalid capsule file count");
  requireId(manifest.source?.swarmId, "source swarm ID");
  if (manifest.model?.weightsIncluded !== true || !Array.isArray(manifest.model.blobs)) throw new Error("Capsule must include model weights");
  const manifestPath = `model/${ollamaManifestRelative(manifest.model.name)}`;
  if (manifest.model.manifestPath !== manifestPath) throw new Error("Capsule model path does not match its model name");
  if (!Array.isArray(manifest.pockets) || !manifest.pockets.length || manifest.pockets.length > 64) throw new Error("Invalid capsule pocket count");
  const expected = new Set(["state/swarm.json", "runtime/vmlinuz", "runtime/initrd", "runtime/profile.json", manifestPath]);
  if (!Array.isArray(manifest.artifacts ?? []) || (manifest.artifacts?.length ?? 0) > FILE_LIMIT) throw new Error("Invalid capsule artifact file list");
  for (const artifact of manifest.artifacts ?? []) {
    if (!/^artifacts\/(?:index\.json|sha256-[a-f0-9]{64})$/.test(artifact) || expected.has(artifact)) throw new Error("Invalid or duplicate capsule artifact path");
    expected.add(artifact);
  }
  if (manifest.artifacts?.length && !manifest.artifacts.includes("artifacts/index.json")) throw new Error("Capsule artifact index is missing");
  const pocketIds = new Set();
  for (const pocket of manifest.pockets) {
    requireId(pocket.id, "pocket ID");
    if (pocketIds.has(pocket.id) || pocket.rootfsPath !== `pockets/${pocket.id}.rootfs.img` || pocket.profilePath !== `${pocket.rootfsPath}.ovm-guest-v1.json`) throw new Error("Invalid or duplicate capsule pocket mapping");
    pocketIds.add(pocket.id); expected.add(pocket.rootfsPath); expected.add(pocket.profilePath);
  }
  for (const blob of manifest.model.blobs) {
    if (!/^sha256:[a-f0-9]{64}$/.test(blob.digest ?? "")) throw new Error("Invalid capsule model digest");
    safeInteger(blob.size, FILE_SIZE_LIMIT, "model size");
    const name = `model/blobs/${blob.digest.replace(":", "-")}`;
    if (expected.has(name)) throw new Error("Duplicate capsule model blob");
    expected.add(name);
  }
  const runtime = manifest.runtime;
  if (!runtime || runtime.kernelPath !== "runtime/vmlinuz" || runtime.initrdPath !== "runtime/initrd" || runtime.helperPath != null && runtime.helperPath !== "runtime/smol-bin.arm64.img" || runtime.profilePath !== "runtime/profile.json" || !manifest.pockets.some((pocket) => pocket.rootfsPath === runtime.baseRootfsPath) || runtime.sessionDiskPolicy !== "fresh-disposable-sparse-disk") throw new Error("Unsupported capsule runtime mapping");
  if (runtime.helperPath) expected.add(runtime.helperPath);
  safeInteger(runtime.sessionDiskBytes, 64 * 1024 ** 3, "session disk size");
  if (runtime.sessionDiskBytes < 512 || runtime.sessionDiskBytes % 512) throw new Error("Invalid capsule session disk alignment");
  const seen = new Set();
  let logicalBytes = runtime.sessionDiskBytes, storedBytes = 0, materializedBytes = 0;
  for (const file of manifest.files) {
    if (!allowedPath(file.path) || !expected.has(file.path) || seen.has(file.path)) throw new Error(`Unsafe, unexpected, or duplicate capsule path: ${file.path}`);
    seen.add(file.path);
    safeInteger(file.size, FILE_SIZE_LIMIT, "file size");
    if (!DIGEST.test(file.sha256 ?? "") || !Array.isArray(file.extents)) throw new Error("Invalid capsule content manifest");
    if (!file.path.endsWith(".img") && !file.path.startsWith("model/blobs/") && file.size > JSON_LIMIT && !["runtime/vmlinuz", "runtime/initrd"].includes(file.path)) throw new Error("Capsule metadata file is too large");
    let end = 0;
    for (const extent of file.extents) {
      if (!Array.isArray(extent) || extent.length !== 4) throw new Error("Invalid capsule sparse extent");
      const [offset, length, stored, encoding] = extent;
      safeInteger(offset, file.size, "extent offset"); safeInteger(length, CHUNK, "extent length"); safeInteger(stored, CHUNK + 1024, "stored extent length");
      if (!length || !stored || offset < end || offset + length > file.size || !["raw", "deflate"].includes(encoding) || (encoding === "raw" && stored !== length)) throw new Error("Overlapping, out-of-bounds, or invalid capsule sparse extent");
      end = offset + length; storedBytes += stored; materializedBytes += length;
    }
    const blob = file.path.match(/^model\/blobs\/sha256-([a-f0-9]{64})$/);
    if (blob && file.sha256 !== blob[1]) throw new Error("Model blob hash does not match its content-addressed name");
    const artifact = file.path.match(/^artifacts\/sha256-([a-f0-9]{64})$/);
    if (artifact && file.sha256 !== artifact[1]) throw new Error("Artifact hash does not match its content-addressed name");
    logicalBytes += file.size;
  }
  if (seen.size !== expected.size) throw new Error("Capsule is missing required guest, history, or model files");
  if (!Number.isSafeInteger(logicalBytes) || logicalBytes > maximumLogicalBytes) throw new Error("Capsule logical size exceeds the configured limit");
  return { logicalBytes, storedBytes, materializedBytes };
}

async function readManifest(handle, options) {
  const prefix = await readExact(handle, CAPSULE_MAGIC.length + 8, 0);
  if (!prefix.subarray(0, CAPSULE_MAGIC.length).equals(CAPSULE_MAGIC)) throw new Error("Not a supported o-gents capsule (OVM v1 format)");
  const length = Number(prefix.readBigUInt64BE(CAPSULE_MAGIC.length));
  safeInteger(length, HEADER_LIMIT, "header length");
  if (!length) throw new Error("Empty capsule header");
  const manifest = JSON.parse((await readExact(handle, length, prefix.length)).toString("utf8"));
  const sizes = validateCapsuleManifest(manifest, options);
  const payloadOffset = prefix.length + length;
  if ((await handle.stat()).size !== payloadOffset + sizes.storedBytes) throw new Error("Capsule length does not match its content manifest");
  return { manifest, sizes, payloadOffset };
}

export async function inspectAgentCapsule({ archivePath, ...options }) {
  await regular(archivePath, LOGICAL_LIMIT);
  const archive = await open(archivePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { return await readManifest(archive, options); } finally { await archive.close(); }
}

async function publishModel(stage, manifest, modelsRoot, options) {
  await privateDirectory(modelsRoot);
  const files = manifest.files.filter((entry) => entry.path.startsWith("model/"));
  // Publish the tag only when every content-addressed blob is present.
  files.sort((a, b) => Number(a.path.startsWith("model/manifests/")) - Number(b.path.startsWith("model/manifests/")));
  for (const file of files) {
    const target = path.join(modelsRoot, file.path.slice(6));
    await ownedSubdirectory(modelsRoot, path.dirname(file.path.slice(6)));
    if (await exists(target)) {
      if ((await regular(target)).size !== file.size || await hashFile(target) !== file.sha256) throw new Error(`Installed Ollama model content conflicts with capsule: ${target}`);
      continue;
    }
    const source = path.join(stage, file.path);
    const temporary = `${target}.capsule-${randomUUID()}`;
    try {
      await cloneRegularFile(source, temporary, { reserveBytes: options.reserveBytes });
      try { await link(temporary, target); }
      catch (error) { if (error.code !== "EEXIST" || await hashFile(target) !== file.sha256) throw error; }
    } finally { await rm(temporary, { force: true }); }
  }
}

async function prepareImportedState(stage, manifest, destination, newId, options) {
  if (manifest.artifacts?.length) validateArtifactIndex(await jsonFile(path.join(stage, "artifacts/index.json")), manifest.files);
  const sourceState = await jsonFile(path.join(stage, "state/swarm.json"));
  if (sourceState.protocol !== "ovm.agent-pocket/v1" || sourceState.swarmId !== manifest.source.swarmId || !Array.isArray(sourceState.agents) || sourceState.agents.length !== manifest.pockets.length) throw new Error("Saved swarm state does not match the capsule");
  const ids = new Set(manifest.pockets.map((pocket) => pocket.id));
  if (new Set(sourceState.agents.map((agent) => agent.id)).size !== ids.size || sourceState.agents.some((agent) => !ids.has(agent.id) || (agent.parentId && !ids.has(agent.parentId)))) throw new Error("Saved pocket identities do not match capsule mappings");
  const modelFile = await jsonFile(path.join(stage, manifest.model.manifestPath));
  const descriptors = blobDescriptors(modelFile);
  if (JSON.stringify(descriptors.map(({ digest, size }) => ({ digest, size })).sort((a, b) => a.digest.localeCompare(b.digest))) !== JSON.stringify([...manifest.model.blobs].sort((a, b) => a.digest.localeCompare(b.digest)))) throw new Error("Model manifest blob closure differs from the capsule manifest");
  for (const descriptor of descriptors) {
    const file = manifest.files.find((entry) => entry.path === `model/blobs/${descriptor.digest.replace(":", "-")}`);
    if (file?.size !== descriptor.size || file.sha256 !== descriptor.digest.slice(7)) throw new Error("Model descriptor differs from verified blob");
  }
  for (const pocket of manifest.pockets) {
    const profile = await jsonFile(path.join(stage, pocket.profilePath));
    if (profile.schema !== "ovm.prepared-guest/v1" || profile.verified !== true) throw new Error("Imported guest profile is not verified");
  }
  const imported = structuredClone(sourceState);
  const instanceId = randomUUID();
  imported.swarmId = newId;
  imported.model = manifest.model.name;
  imported.capsuleIdentity = { schema: "ovm.agent-identity/v1", instanceId, lineageId: manifest.source.lineageId, parentInstanceId: manifest.source.instanceId, sourceSwarmId: manifest.source.swarmId, sourceCapsuleId: manifest.capsuleId, importedAt: new Date().toISOString() };
  for (const agent of imported.agents) {
    agent.inheritRootfs = agent.parentId ? path.join(destination, `${agent.parentId}.rootfs.img`) : null;
    if (Object.hasOwn(agent, "rootfsPath")) agent.rootfsPath = path.join(destination, `${agent.id}.rootfs.img`);
  }
  // Original history is retained byte-for-byte; only active addressing changes.
  await mkdir(path.join(stage, "history"), { mode: 0o700 });
  await rename(path.join(stage, "state/swarm.json"), path.join(stage, "history/source-swarm.json"));
  await rm(path.join(stage, "state"), { recursive: true });
  await writeFile(path.join(stage, "swarm.json"), `${JSON.stringify(imported, null, 2)}\n`, { mode: 0o600 });
  for (const pocket of manifest.pockets) {
    await rename(path.join(stage, pocket.rootfsPath), path.join(stage, `${pocket.id}.rootfs.img`));
    await rename(path.join(stage, pocket.profilePath), path.join(stage, `${pocket.id}.rootfs.img.ovm-guest-v1.json`));
  }
  await rm(path.join(stage, "pockets"), { recursive: true });
  await rename(path.join(stage, "runtime"), path.join(stage, "capsule-runtime"));
  const runtime = path.join(stage, "capsule-runtime");
  await rename(path.join(runtime, "profile.json"), path.join(runtime, ".ovm-guest-v1.json"));
  const baseEntry = manifest.files.find((file) => file.path === manifest.runtime.baseRootfsPath);
  await cloneRegularFile(path.join(stage, path.basename(manifest.runtime.baseRootfsPath)), path.join(runtime, "rootfs.img"), { ...baseEntry, reserveBytes: options.reserveBytes });
  const session = await open(path.join(runtime, "sessiondata.img"), "wx", 0o600);
  try { await session.truncate(manifest.runtime.sessionDiskBytes); await session.sync(); } finally { await session.close(); }
  await writeFile(path.join(stage, "capsule.json"), `${JSON.stringify({ ...manifest, importedInstance: imported.capsuleIdentity, importedAgentId: newId,
    credentialHandling: manifest.network, offlineModelInstalled: options.installModel !== false,
    weightsPublished: true, modelStorePublished: options.installModel !== false, privateModelsPath: path.join(destination, "capsule-models"), inferenceReady: false }, null, 2)}\n`, { mode: 0o600 });
  return imported;
}

export async function importAgentCapsule(options) {
  const { stateRoot, modelsRoot } = paths(options);
  await privateDirectory(stateRoot);
  const archivePath = path.resolve(options.archivePath);
  await regular(archivePath, LOGICAL_LIMIT);
  const archive = await open(archivePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let stage;
  let reservation;
  try {
    const { manifest, sizes, payloadOffset } = await readManifest(archive, options);
    const newId = requireId(options.agentId ?? `${manifest.source.swarmId.slice(0, 33)}-${randomUUID().slice(0, 8)}`);
    const destination = path.join(stateRoot, newId);
    if (await exists(destination)) throw new Error(`Refusing to overwrite gent: ${newId}`);
    reservation = new VMLease(path.join(stateRoot, `.${newId}.capsule-import.lease`), { resource: `capsule import ${newId}` });
    await reservation.acquire();
    const budget = await estimateCapsuleImportBudget(manifest, sizes, { stateRoot, modelsRoot, installModel: options.installModel !== false });
    await diskBudget(stateRoot, budget.stateDirectoryBytes, options.reserveBytes);
    if (budget.modelDirectoryBytes) await diskBudget(budget.modelBudgetDirectory, budget.modelDirectoryBytes, options.reserveBytes);
    stage = await mkdtemp(path.join(stateRoot, ".capsule-import-"));
    let position = payloadOffset, completedBytes = 0;
    for (const file of manifest.files) {
      const target = path.join(stage, file.path);
      await privateDirectory(path.dirname(target));
      const handle = await open(target, "wx", 0o600);
      const hash = createHash("sha256");
      let end = 0;
      try {
        for (const [offset, length, storedLength, encoding] of file.extents) {
          updateZeros(hash, offset - end);
          const payload = await readExact(archive, storedLength, position); position += storedLength;
          const data = encoding === "deflate" ? await inflate(payload, { maxOutputLength: length }) : payload;
          if (data.length !== length) throw new Error(`Capsule extent expands to the wrong size: ${file.path}`);
          hash.update(data); await writeAll(handle, data, offset); end = offset + length;
          completedBytes += storedLength;
          if (completedBytes % (32 * CHUNK) < storedLength) notice(options.onProgress, "verifying", { path: file.path, completedBytes, totalBytes: sizes.storedBytes });
        }
        updateZeros(hash, file.size - end);
        if (hash.digest("hex") !== file.sha256) throw new Error(`Capsule content digest mismatch: ${file.path}`);
        await handle.truncate(file.size); await handle.sync();
      } finally { await handle.close(); }
    }
    // Check all content before touching the destination model store or agent.
    const imported = await prepareImportedState(stage, manifest, destination, newId, options);
    if (options.installModel !== false) await publishModel(stage, manifest, modelsRoot, options);
    await rename(path.join(stage, "model"), path.join(stage, "capsule-models"));
    if (await exists(destination)) throw new Error(`Gent destination appeared during import: ${newId}`);
    await publishDirectory(stage, destination); stage = null;
    notice(options.onProgress, "complete", { agentId: newId, statePath: path.join(destination, "swarm.json") });
    return { schema: CAPSULE_SCHEMA, agentId: newId, statePath: path.join(destination, "swarm.json"), directory: destination, instanceId: imported.capsuleIdentity.instanceId, lineageId: imported.capsuleIdentity.lineageId, sourceInstanceId: manifest.source.instanceId,
      model: manifest.model.name, weightsIncluded: true, weightsPublished: true, modelInstalled: options.installModel !== false, modelStorePublished: options.installModel !== false,
      privateModelsPath: path.join(destination, "capsule-models"), inferenceReady: false,
      bundlePath: path.join(destination, "capsule-runtime"), helperPath: manifest.runtime.helperPath ? path.join(destination, "capsule-runtime/smol-bin.arm64.img") : null,
      originalHistoryPath: path.join(destination, "history/source-swarm.json"), guestIdentityStateSanitized: false };
  } finally {
    await archive.close();
    if (stage) await rm(stage, { recursive: true, force: true });
    if (reservation) await reservation.release();
  }
}

export async function cloneAgentCapsule(options) {
  const { stateRoot } = paths(options);
  requireId(options.newId, "new gent ID");
  if (await exists(path.join(stateRoot, options.newId))) throw new Error(`Refusing to overwrite gent: ${options.newId}`);
  const archivePath = path.join(stateRoot, `.replica-${randomUUID()}.ovm`);
  try {
    await exportAgentCapsule({ ...options, outputPath: archivePath });
    return await importAgentCapsule({ ...options, archivePath, agentId: options.newId });
  } finally { await rm(archivePath, { force: true }); }
}

export async function runAgentCommand(argv, { output = process.stdout, progress = process.stderr, ...options } = {}) {
  const args = argv.filter((arg) => !["--json", "--private-model"].includes(arg));
  const json = argv.includes("--json");
  const privateModel = argv.includes("--private-model");
  const [command = "list", first, second] = args;
  const usage = "Usage: gent list | show ID | resume ID [NEW_MISSION] | export ID FILE.ovm | import FILE.ovm [NEW_ID] [--private-model] | clone ID NEW_ID\nCapsules include the gent history, guest disks, boot inputs, and full local model weights. Stop the gent first.\n--private-model retains all weights with the imported gent without also publishing them to the host's Ollama store. Import does not start or qualify an inference server.\n";
  if (["help", "--help", "-h"].includes(command)) { output.write(usage); return 0; }
  if (privateModel && command !== "import") throw new Error("--private-model is available for gent import.");
  let lastProgress = 0;
  const onProgress = (event) => {
    options.onProgress?.(event);
    if (json || event.phase === "complete" || Date.now() - lastProgress < 1500) return;
    lastProgress = Date.now();
    progress.write(`Capsule ${event.phase}: ${event.path ?? ""}${event.totalBytes ? ` (${(event.completedBytes / 1024 ** 2).toFixed(0)}/${(event.totalBytes / 1024 ** 2).toFixed(0)} MiB)` : ""}\n`);
  };
  let result;
  if (command === "list" && args.length === 1) result = await listAgents(options);
  else if (command === "show" && args.length === 2) result = await inspectAgent({ ...options, agentId: first });
  else if (command === "export" && args.length === 3) result = await exportAgentCapsule({ ...options, agentId: first, outputPath: second, onProgress });
  else if (command === "import" && [2, 3].includes(args.length)) result = await importAgentCapsule({ ...options, archivePath: first, ...(second ? { agentId: second } : {}), ...(privateModel ? { installModel: false } : {}), onProgress });
  else if (command === "clone" && args.length === 3) result = await cloneAgentCapsule({ ...options, agentId: first, newId: second, onProgress });
  else throw new Error(usage.trim());
  output.write(json ? `${JSON.stringify(result)}\n` : formatAgentCommandResult(command, result));
  return 0;
}

export function formatAgentCommandResult(command, result) {
  const quote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;
  if (command === "list") {
    if (!result.length) return 'No saved gents yet. Start one with: gent task "Your task"\n';
    const rows = ["Saved gents:"];
    for (const agent of result) {
      if (agent.error) { rows.push(`${agent.id}: needs attention — ${agent.error}`); continue; }
      rows.push(`${agent.id}  ${agent.active ? "running" : agent.completed ? "completed" : "paused"}  ${agent.pockets} ${agent.pockets === 1 ? "pocket" : "pockets"}  ${agent.model}`);
      rows.push(`  ${String(agent.mission ?? "").replace(/\s+/g, " ").slice(0, 160)}`);
    }
    rows.push("", "Continue: gent resume ID", "Inspect memory and status: gent show ID");
    return `${rows.join("\n")}\n`;
  }
  if (command === "show") return `Gent: ${result.agentId}\nStatus: ${result.lease.alive ? "running" : result.state.blocked ? "waiting for reconciliation" : result.completed ? "completed" : "paused"}\nMission: ${result.state.mission}\nModel: ${result.model}\nPockets: ${result.state.agents.map((agent) => agent.id).join(", ")}\nSaved reasoning turns: ${result.state.transcript?.length ?? 0}; round: ${result.state.round ?? 0}\nState: ${result.statePath}\n\nContinue: gent resume ${result.agentId}\nNew mission: gent resume ${result.agentId} "Your next task"\n`;
  if (command === "export") return `Saved gent bundle: ${result.outputPath}\nIncludes ${result.pockets} ${result.pockets === 1 ? "pocket" : "pockets"}, full ${result.model} model weights, history, guest disks, and boot inputs.\nArchive size: ${(result.storedBytes / 1024 ** 3).toFixed(2)} GiB; logical content: ${(result.logicalBytes / 1024 ** 3).toFixed(2)} GiB.\nThe source gent is retained.\n\nImport on another machine: gent import ${quote(result.outputPath)}\n`;
  if (command === "import" || command === "clone") return `${command === "clone" ? "Created replica" : "Imported gent"}: ${result.agentId}\nModel: ${result.model} (full weights retained${result.modelInstalled ? ", also published to the host model store" : " privately"})\nPrivate model files: ${result.privateModelsPath}\nInference readiness: not verified; a compatible Ollama server must use these model files.\nState and memory: ${result.statePath}\nThe new instance has its own guest identity; source history is retained.\n\nContinue: gent resume ${result.agentId}\nNew mission: gent resume ${result.agentId} "Your next task"\n`;
  return `${JSON.stringify(result, null, 2)}\n`;
}
