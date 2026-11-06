import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, rename, statfs, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getGuestStatus } from './guest-manager.mjs';
import { networkStatus, joinNetwork } from './guest-network.mjs';
import { readDistributionSettings, saveDistributionSettings, distributionDirectory, applyDistributionEnvironment } from './distribution-config.mjs';
import { createVMFleet, resolveVMBackend, compatibleVMController } from './vm-backend.mjs';
import { qemuTools } from './qemu-vm.mjs';
import { VMLease } from './lease.mjs';
import { runCaptured, selectRsync } from './controller-transport.mjs';
import { installArtifactInputs } from './agent-artifacts.mjs';
import { hostMemory } from './host-resources.mjs';
import { controllerDiskBudget } from './controller-disk.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_CONTROLLER_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_VM_COMMAND_BYTES = 8192;
const MAX_CAPTURE_COMMAND_BYTES = 128 * 1024;
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,96}$/.test(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
export async function cloneControllerSnapshot(source, target, { platform = process.platform, execute = runCaptured } = {}) {
  if (existsSync(target)) throw new Error('Checkpoint target already exists');
  const original = await lstat(source);
  if (!original.isFile() || original.isSymbolicLink()) throw new Error('Checkpoint source must be a regular file');
  // Only stopped source disks reach this function. Linux filesystems without
  // reflinks need a sparse copy; APFS uses clonefile without a full-copy fallback.
  if (platform === 'darwin') await execute('/bin/cp', ['-c', '-p', '-n', source, target]);
  else if (platform === 'linux') await execute('/bin/cp', ['--reflink=auto', '--sparse=always', '--no-clobber', '--', source, target], { timeout: 30 * 60_000 });
  else throw new Error('Stopped VM snapshots currently require Linux or macOS');
  const copied = await lstat(target);
  if (!copied.isFile() || copied.isSymbolicLink() || copied.size !== original.size) throw new Error('Cloned checkpoint does not match its source');
}
async function atomicJson(file, value) {
  const tmp = `${file}.${randomUUID()}`;
  const handle = await open(tmp, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
  await rename(tmp, file);
  const directory = await open(path.dirname(file), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
function jobPaths(root, id) {
  if (!validId(id)) throw new Error('Invalid dispatch identity');
  const directory = path.join(distributionDirectory(root), 'jobs', id);
  return { directory, request: path.join(directory, 'request.json'), receipt: path.join(directory, 'receipt.json') };
}
function statePath(root, key) {
  if (!validId(key)) throw new Error('Invalid remote state identity');
  return path.join(root, 'vm/pockets/remote', key);
}
async function inspectState(root, key, metadata = lstat) {
  const directory = statePath(root, key);
  const generationFile = path.join(directory, '.generation.json');
  const result = existsSync(generationFile) ? JSON.parse(await readFile(generationFile, 'utf8')) : { generation: 0 };
  result.files = (await readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; }))
    .filter(name => /^[a-zA-Z0-9_-]+\.rootfs\.img$/.test(name));
  result.disks = await Promise.all(result.files.map(async name => {
    const info = await metadata(path.join(directory, name));
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Remote family disk is not a regular file: ${name}`);
    return { name, size: info.size, allocatedBytes: Number.isSafeInteger(info.blocks) && info.blocks >= 0 ? info.blocks * 512 : info.size };
  }));
  return result;
}
function validManifest(files) {
  return Array.isArray(files) && files.length > 0 && new Set(files.map(file => file.name)).size === files.length
    && files.every(file => /^[a-zA-Z0-9_-]+\.rootfs\.img(?:\.ovm-guest-v1\.json)?$/.test(file.name)
      && Number.isSafeInteger(file.size) && file.size >= 0);
}
async function completedCheckpoint(root, id) {
  const files = jobPaths(root, id);
  const request = JSON.parse(await readFile(files.request, 'utf8'));
  const receipt = JSON.parse(await readFile(files.receipt, 'utf8'));
  const directory = statePath(root, request.stateKey);
  const snapshot = path.join(directory, '.checkpoints', id);
  if (receipt.phase !== 'completed' || receipt.id !== id || receipt.requestHash !== hash(request)
    || receipt.generation !== request.generation + 1 || receipt.stateDirectory !== directory
    || receipt.checkpointDirectory !== snapshot || !validManifest(receipt.checkpointFiles)) throw new Error('Completed checkpoint receipt is invalid');
  return { files, request, receipt, directory, snapshot };
}
async function releaseStatus(files, receipt) {
  let release = await readFile(path.join(files.directory, 'release.json'), 'utf8').then(JSON.parse)
    .catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  // Older controllers recorded a notification but retained all payload bytes.
  // It is not the new, manifest-bound permission to delete a checkpoint.
  if (release?.requestHash === receipt.requestHash && release.phase === undefined
    && release.generation === undefined && release.manifestSha256 === undefined) release = null;
  if (release && (release.requestHash !== receipt.requestHash || release.generation !== receipt.generation
    || release.manifestSha256 !== hash(receipt.checkpointFiles))) throw new Error('Checkpoint release identity does not match its receipt');
  return { checkpointAvailable: receipt.phase === 'completed' && !release,
    checkpointReleased: release?.phase === 'released', checkpointReleasePending: Boolean(release && release.phase !== 'released') };
}
async function releaseCheckpoint(root, request) {
  const files = jobPaths(root, request.id);
  // The manifest and payload are immutable. Repeated or concurrent releases
  // only unlink the same names, so no persistent lock can strand crash recovery.
  const checkpoint = await completedCheckpoint(root, request.id);
  const { receipt, directory, snapshot } = checkpoint;
  const acknowledgement = request.checkpointAcknowledgement;
  if (receipt.requestHash !== request.requestHash || acknowledgement?.generation !== receipt.generation
    || acknowledgement?.manifestSha256 !== hash(receipt.checkpointFiles)) throw new Error('Checkpoint acknowledgement does not match the completed generation and manifest');
  const previous = await releaseStatus(files, receipt);
  if (previous.checkpointReleased) return { released: true, checkpointAvailable: false };
  // Refuse traversal through a symlink, and never recursively delete a family
  // or an unexpected file. The immutable snapshot is the only deletion scope.
  for (const item of [directory, path.join(directory, '.checkpoints'), snapshot]) {
    const info = await lstat(item);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Checkpoint release requires regular directories');
  }
  const generation = JSON.parse(await readFile(path.join(snapshot, '.generation.json'), 'utf8'));
  if (generation.generation !== receipt.generation || generation.lastDispatch !== request.id) throw new Error('Checkpoint generation differs before release');
  for (const file of receipt.checkpointFiles) {
    const info = await lstat(path.join(snapshot, file.name)).catch(error => {
      if (error.code === 'ENOENT' && previous.checkpointReleasePending) return null;
      throw error;
    });
    if (info && (!info.isFile() || info.isSymbolicLink() || info.size !== file.size)) throw new Error('Checkpoint payload changed before release');
  }
  const release = { requestHash: receipt.requestHash, generation: receipt.generation,
    manifestSha256: hash(receipt.checkpointFiles), phase: 'releasing' };
  // Status stops advertising recoverable payload before the first unlink.
  await atomicJson(path.join(files.directory, 'release.json'), release);
  for (const file of receipt.checkpointFiles) await unlink(path.join(snapshot, file.name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  const handle = await open(snapshot, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
  await atomicJson(path.join(files.directory, 'release.json'), { ...release, phase: 'released' });
  return { released: true, checkpointAvailable: false };
}
export async function controllerProbe(root = ROOT, { backend, environment = process.env, platform = process.platform,
  architecture = process.arch, nodeVersion = process.versions.node, guestStatus = getGuestStatus, rsyncTools = selectRsync,
  memoryInfo = hostMemory, filesystem = statfs, inspectQemuTools = qemuTools, metadata = lstat, exists = existsSync } = {}) {
  const selected = resolveVMBackend({ backend, environment, platform, architecture });
  const guest = await guestStatus({ projectRoot: root });
  let rsync = null;
  try { rsync = await rsyncTools(); } catch {}
  const memory = await memoryInfo({ platform });
  const disk = await filesystem(root);
  const runner = exists(path.join(root, 'host/OVMSwarm')) ? path.join(root, 'host/OVMSwarm') : path.join(root, 'prebuilt/macos-arm64/OVMSwarm');
  const tools = selected === 'qemu' ? await inspectQemuTools({ environment, platform, architecture }) : null;
  const backendReady = selected === 'apple' ? platform === 'darwin' && architecture === 'arm64' && exists(runner) && exists(path.join(root, 'host/smol-bin.arm64.img'))
    : ['darwin', 'linux'].includes(platform) && Boolean(tools.binary && tools.mke2fs && tools.python && tools.lsof)
      && exists(path.join(root, 'host/qemu-worker.py')) && exists(path.join(root, 'host/qemu-supervisor.py'));
  const bundleReady = ['rootfs.img', 'vmlinuz', 'initrd'].every(name => exists(path.join(root, 'vm/claudevm.bundle', name)));
  // ext4 may not support reflinks. Admission reserves room for a sparse live
  // copy and a stopped snapshot instead of assuming APFS clone behavior.
  const base = selected === 'qemu' && platform === 'linux'
    ? await metadata(path.join(root, 'vm/claudevm.bundle/rootfs.img')).catch(() => null) : null;
  const minimumFreeDiskBytesPerGuest = base ? 2 * (Number.isFinite(base.blocks) ? base.blocks * 512 : base.size) + 1024 ** 3 : 0;
  const vmReady = Boolean(Number(nodeVersion.split('.')[0]) >= 26 && guest.prepared === true && guest.verified === true
    && !guest.needsUpdate && guest.profile?.recipeSha256 && rsync && backendReady && bundleReady);
  return { root, hostname: os.hostname(), platform, architecture, nodeVersion,
    backend: selected === 'apple' ? 'apple-vz-arm64' : 'qemu-arm64', guestArchitecture: 'aarch64', ...(tools ? { accelerator: tools.accelerator, qemuBinary: tools.binary } : {}),
    vmReady, rsync: Boolean(rsync), rsyncPath: rsync?.path, rsyncVersion: rsync?.version, rsyncProtocol: rsync?.protocol,
    ...memory, freeMemoryBytes: memory.availableMemoryBytes, freeDiskBytes: Number(disk.bavail) * Number(disk.bsize),
    minimumFreeDiskBytesPerGuest, ...(base ? { baseRootfsBytes: base.size,
      baseRootfsAllocatedBytes: Number.isSafeInteger(base.blocks) && base.blocks >= 0 ? base.blocks * 512 : base.size } : {}),
    sourceCommit: guest.profile?.sourceCommit, recipeSha256: guest.profile?.recipeSha256,
    reason: vmReady ? null : selected === 'apple' ? 'Needs Apple Silicon macOS, Node 26+, rsync, Apple VM helpers, and a current prepared guest image.'
      : 'Needs Linux or macOS, Node 26+, rsync, qemu-system-aarch64, mke2fs, Python 3, lsof, QEMU worker assets, and a current prepared guest image.',
    network: await networkStatus({ projectRoot: root }).catch(error => ({ configured: false, error: error.message })) };
}
function validateRun(request) {
  // Keep direct admission and stored-job validation within the same aggregate
  // budget as the newline-delimited stdin protocol, including JSON escaping.
  if (Buffer.byteLength(JSON.stringify(request)) + 1 > MAX_CONTROLLER_REQUEST_BYTES) throw new Error('Controller request is too large');
  if (!validId(request.stateKey) || !validId(request.id)) throw new Error('Invalid dispatch or agent state identity');
  if (!Array.isArray(request.tasks) || request.tasks.length < 1 || request.tasks.length > 16) throw new Error('Dispatch requires 1–16 tasks');
  if (!Number.isInteger(request.memoryMB) || request.memoryMB < 512 || request.memoryMB > 4096 || !Number.isInteger(request.cpuCount) || request.cpuCount < 1 || request.cpuCount > 4) throw new Error('Invalid VM resources');
  if (!Number.isSafeInteger(request.generation) || request.generation < 0 || !/^[a-f0-9]{64}$/.test(request.recipeSha256 ?? '')) throw new Error('Invalid generation or prepared-image recipe');
  if (!['nat', 'isolated'].includes(request.networkMode) || !['auto', 'local', 'required'].includes(request.distributionMode)) throw new Error('Invalid network or distribution mode');
  if (request.backend !== undefined && !['auto', 'apple', 'qemu'].includes(request.backend)) throw new Error('Invalid VM backend');
  const seen = new Set();
  for (const task of request.tasks) {
    // Capture commands include controller-generated source, check contracts,
    // and receipt code. Ordinary VM commands retain their smaller limit.
    const maximum = task?.artifactCapture === true ? MAX_CAPTURE_COMMAND_BYTES : MAX_VM_COMMAND_BYTES;
    if (!validId(task?.agentId) || seen.has(task.agentId) || typeof task.command !== 'string' || Buffer.byteLength(task.command) > maximum || !task.command.trim()) throw new Error('Invalid or repeated VM task');
    if (task.parentId != null && !validId(task.parentId)) throw new Error('Invalid parent pocket');
    if (task.artifactCapture !== undefined && typeof task.artifactCapture !== 'boolean') throw new Error('Invalid artifact capture flag');
    seen.add(task.agentId);
  }
}
function canAdmit(availability, request) {
  return availability.vmReady === true && compatibleVMController(availability, request.backend ?? 'auto')
    && availability.memoryPressureCritical !== true && availability.recipeSha256 === request.recipeSha256
    && Number.isFinite(availability.freeMemoryBytes) && availability.freeMemoryBytes >= request.tasks.length * request.memoryMB * 1024 ** 2 + 1024 ** 3
    && Number.isFinite(availability.freeDiskBytes) && availability.freeDiskBytes >= controllerDiskBudget(availability, request.tasks).requiredBytes;
}
export async function handleControllerRequest(request, { root = ROOT, probe = controllerProbe, launch = spawn, stateMetadata = lstat,
  inspectNetwork = networkStatus, join = joinNetwork, settings = readDistributionSettings, saveSettings = saveDistributionSettings } = {}) {
  if (request.protocol !== 'ovm.controller/v1') throw new Error('Unsupported controller protocol');
  if (request.op === 'probe') {
    const result = await probe(root, { backend: request.backend });
    if (request.stateKey) result.state = await inspectState(root, request.stateKey, stateMetadata);
    return result;
  }
  if (request.op === 'join') {
    const invitation = request.invitation;
    const networkId = invitation?.network?.networkId;
    if (invitation?.schema !== 'ovm-trusted-controller-v1' || !/^[a-f0-9]{32}$/.test(networkId ?? '') || typeof invitation.caCertificate !== 'string') throw new Error('Invalid controller invitation');
    const configured = settings(root);
    const stateDir = path.join(distributionDirectory(root), 'networks', networkId);
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const current = await inspectNetwork({ projectRoot: root, stateRoot: stateDir });
    const caFileSha256 = createHash('sha256').update(invitation.caCertificate).digest('hex');
    if (current.configured && (current.networkId !== networkId || current.caFileSha256 !== caFileSha256)) throw new Error('Selected network already has another authority');
    if (!current.configured) {
      const invitationFile = path.join(stateDir, `invitation-${hash(invitation)}.json`);
      try { await writeFile(invitationFile, JSON.stringify(invitation), { mode: 0o600, flag: 'wx' }); }
      catch (error) { if (error.code !== 'EEXIST' || hash(JSON.parse(await readFile(invitationFile, 'utf8'))) !== hash(invitation)) throw error; }
      await join({ projectRoot: root, stateRoot: stateDir, inputFile: invitationFile });
    }
    await saveSettings(root, { ...configured, networkState: stateDir });
    process.env.OVM_NETWORK_STATE = stateDir;
    return inspectNetwork({ projectRoot: root, stateRoot: stateDir });
  }
  if (request.op === 'status') {
    const files = jobPaths(root, request.id);
    const receipt = JSON.parse(await readFile(files.receipt, 'utf8'));
    if (receipt.requestHash !== request.requestHash) throw new Error('Dispatch identity belongs to another request');
    const owner = receipt.pid ?? (await readFile(path.join(files.directory, 'owner.json'), 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return {}; throw error; })).pid;
    return { ...receipt, ...await releaseStatus(files, receipt), ownerAlive: owner ? alive(owner) : null };
  }
  if (request.op === 'release') {
    return releaseCheckpoint(root, request);
  }
  if (request.op !== 'run') throw new Error('Unknown controller operation');
  const files = jobPaths(root, request.id);
  const requestHash = hash(request);
  const priorResult = async () => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        const prior = JSON.parse(await readFile(files.request, 'utf8'));
        if (hash(prior) !== requestHash) throw new Error('Dispatch identity was reused with different work');
        const receipt = JSON.parse(await readFile(files.receipt, 'utf8'));
        return { ...receipt, ...await releaseStatus(files, receipt) };
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    throw new Error('Dispatch admission is incomplete; reconcile this identity without replay');
  };
  if (existsSync(files.directory)) return priorResult();
  try { validateRun(request); } catch (error) { error.rejected = true; throw error; }
  const availability = await probe(root, { backend: request.backend });
  availability.state = await inspectState(root, request.stateKey, stateMetadata);
  if (!canAdmit(availability, request)) {
    const error = new Error('Remote VM capability, prepared image, memory, or disk does not match this task'); error.rejected = true; throw error;
  }
  await mkdir(path.dirname(files.directory), { recursive: true, mode: 0o700 });
  try { await mkdir(files.directory, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') return priorResult(); throw error; }
  await atomicJson(files.request, request);
  await atomicJson(files.receipt, { phase: 'accepted', id: request.id, requestHash, admitted: false });
  const log = await open(path.join(files.directory, 'worker.log'), 'a', 0o600);
  let spawned = false;
  try {
    const child = launch(process.execPath, [path.join(root, 'src/controller-worker.mjs'), '--job', request.id], { detached: true, stdio: ['ignore', log.fd, log.fd], env: { ...process.env, OVM_CONTROLLER_ROOT: root } });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    spawned = true;
    await atomicJson(path.join(files.directory, 'owner.json'), { pid: child.pid });
    child.unref();
    return { phase: 'accepted', id: request.id, requestHash, admitted: true };
  } catch (error) {
    // A spawn failure is known to precede any guest work. Failures after a
    // successful spawn are uncertain and must never overwrite its receipt.
    if (!spawned) {
      await atomicJson(files.receipt, { phase: 'rejected', id: request.id, requestHash, admitted: false, error: error.message });
      error.rejected = true;
    }
    throw error;
  } finally { await log.close(); }
}

export async function runControllerJob(id, { root = ROOT, Fleet, createFleet = createVMFleet, Lease = VMLease,
  probe = controllerProbe, clone = cloneControllerSnapshot, stateMetadata = lstat } = {}) {
  applyDistributionEnvironment(root);
  const files = jobPaths(root, id);
  const request = JSON.parse(await readFile(files.request, 'utf8'));
  validateRun(request);
  const requestHash = hash(request);
  try { await writeFile(path.join(files.directory, 'execution.json'), JSON.stringify({ pid: process.pid, requestHash }), { mode: 0o600, flag: 'wx' }); }
  catch (error) { if (error.code === 'EEXIST') return; throw error; }
  const directory = statePath(root, request.stateKey);
  const lease = new Lease(path.join(directory, '.remote.lease'), { resource: 'remote agent environment' });
  let admitted = false;
  try {
    await lease.acquire();
    const stateFile = path.join(directory, '.generation.json');
    const priorState = existsSync(stateFile) ? JSON.parse(await readFile(stateFile, 'utf8')) : { generation: 0 };
    const generation = priorState.generation;
    if (generation !== request.generation) throw new Error('Remote agent filesystem generation differs; reconcile it before continuing');
    const availability = await probe(root, { backend: request.backend });
    availability.state = await inspectState(root, request.stateKey, stateMetadata);
    if (!canAdmit(availability, request)) throw new Error('Prepared remote controller or available resources changed before admission');
    if (generation > 0) {
      if (!validId(priorState.lastDispatch)) throw new Error('Remote family has no prior checkpoint identity');
      const prior = await completedCheckpoint(root, priorState.lastDispatch);
      if (prior.request.stateKey !== request.stateKey || prior.receipt.generation !== generation) throw new Error('Remote family prior checkpoint identity differs');
      const expected = prior.receipt.checkpointFiles.filter(file => file.name.endsWith('.rootfs.img'));
      if (!expected.length) throw new Error('Remote family has no prior checkpoint disks');
      for (const file of expected) {
        const metadata = await lstat(path.join(directory, file.name)).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.size !== file.size) throw new Error(`Remote family disk is absent or invalid: ${file.name}; refusing a fresh substitute`);
      }
    }
    for (const task of request.tasks) {
      if (task.parentId && !existsSync(path.join(directory, `${task.parentId}.rootfs.img`))) throw new Error('Remote parent pocket is absent; refusing to substitute a fresh image');
    }
    await installArtifactInputs(path.join(directory, 'artifacts'), request.artifactInputs ?? []);
    const fleetOptions = { backend: availability.backend === 'qemu-arm64' ? 'qemu' : 'apple', projectRoot: root,
      binaryPath: existsSync(path.join(root, 'host/OVMSwarm')) ? path.join(root, 'host/OVMSwarm') : path.join(root, 'prebuilt/macos-arm64/OVMSwarm'),
      bundlePath: path.join(root, 'vm/claudevm.bundle'), smolPath: path.join(root, 'host/smol-bin.arm64.img'), stateDirectory: directory,
      memoryMB: request.memoryMB, cpuCount: request.cpuCount, networkMode: request.networkMode, distributionMode: request.distributionMode };
    const fleet = Fleet ? new Fleet(fleetOptions) : createFleet(fleetOptions);
    admitted = true;
    await atomicJson(files.receipt, { phase: 'running', id, requestHash, admitted, pid: process.pid, stateDirectory: directory });
    const workers = await fleet.run(request.tasks.map(task => ({ ...task, ...(task.parentId ? { inheritRootfs: path.join(directory, `${task.parentId}.rootfs.img`) } : {}) })));
    if (workers.length !== request.tasks.length || request.tasks.some(task => workers.filter(worker => worker.agent === task.agentId && worker.stopped === true).length !== 1)) throw new Error('Remote fleet did not confirm every requested VM stopped');
    const snapshot = path.join(directory, '.checkpoints', id);
    await mkdir(snapshot, { recursive: true, mode: 0o700 });
    const checkpointFiles = [];
    for (const name of await readdir(directory)) {
      if (!/^[a-zA-Z0-9_-]+\.rootfs\.img(?:\.ovm-guest-v1\.json)?$/.test(name)) continue;
      const metadata = await lstat(path.join(directory, name));
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('Remote pocket checkpoint contains a non-regular file');
      await clone(path.join(directory, name), path.join(snapshot, name));
      checkpointFiles.push({ name, size: metadata.size });
    }
    for (const task of request.tasks) if (!checkpointFiles.some(file => file.name === `${task.agentId}.rootfs.img`)) throw new Error('Stopped remote guest has no checkpoint disk');
    const next = { generation: generation + 1, lastDispatch: id };
    await atomicJson(path.join(snapshot, '.generation.json'), next);
    await atomicJson(stateFile, next);
    const receipt = { phase: 'completed', id, requestHash, admitted, pid: process.pid, ...next,
      stateDirectory: directory, checkpointDirectory: snapshot, checkpointFiles, workers };
    await atomicJson(files.receipt, receipt);
    // No timeout expires this immutable payload. Only an explicit durable
    // checkpoint acknowledgement permits release; receipt metadata is retained.
  } catch (error) {
    await atomicJson(files.receipt, { phase: admitted ? 'uncertain' : 'rejected', id, requestHash, admitted, pid: process.pid, error: error.message });
  } finally { await lease.release(); }
}

export async function runControllerStdio({ root = ROOT, input = process.stdin, output = process.stdout } = {}) {
  let text = '';
  let request;
  try {
    for await (const chunk of input) { text += chunk; if (Buffer.byteLength(text) > MAX_CONTROLLER_REQUEST_BYTES) throw new Error('Controller request is too large'); }
    request = JSON.parse(text);
    applyDistributionEnvironment(root);
    const result = await handleControllerRequest(request, { root });
    output.write(JSON.stringify({ protocol: 'ovm.controller/v1', ok: true, result }) + '\n');
  } catch (error) {
    output.write(JSON.stringify({ protocol: 'ovm.controller/v1', ok: false, admitted: error.rejected === true ? false : undefined,
      ...(request?.op === 'run' ? { id: request.id, requestHash: hash(request) } : {}), error: error.message }) + '\n');
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--job') {
  await runControllerJob(process.argv[3], { root: process.env.OVM_CONTROLLER_ROOT || ROOT });
}
