import { createHash, randomUUID } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import { copyFile, mkdir, lstat, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { controllerCall, runCaptured, selectRsync, checkpointRsyncOptions } from './controller-transport.mjs';
import { getGuestStatus } from './guest-manager.mjs';
import { readDistributionSettings } from './distribution-config.mjs';
import { artifactInputs } from './agent-artifacts.mjs';
import { availableHostMemory } from './host-resources.mjs';
import { compatibleVMController } from './vm-backend.mjs';
import { controllerDiskBudget } from './controller-disk.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function save(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, file);
  const directory = await open(path.dirname(file), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
export class DistributionUncertainError extends Error {
  constructor(message) { super(message); this.uncertain = true; }
}

/** Keep a communicating family together; checkpoint stopped remote disks locally. */
export class DistributedVMFleet {
  constructor(localOrOptions, options) {
    const { local, projectRoot, stateDirectory, swarmId, mode, target = 'auto', peers, backend = local?.backendSelection ?? 'auto',
      call = controllerCall, execute = runCaptured, guestStatus = getGuestStatus,
      // Sparse Linux cloning, a TCG boot, and the stopped snapshot can take
      // several minutes. This bounds job completion, not individual SSH calls.
      onPlacement, onProgress = () => {}, pollMilliseconds = 500, remoteTimeout = 30 * 60_000,
      checkpointTimeout = 30 * 60_000, freeMemory = availableHostMemory, rsync = selectRsync } = options ? { ...options, local: localOrOptions } : localOrOptions;
    this.local = local; this.root = path.resolve(projectRoot); this.directory = path.resolve(stateDirectory); this.swarmId = swarmId;
    const settings = readDistributionSettings(projectRoot);
    this.mode = mode ?? settings.mode; this.target = target; this.peers = peers ?? settings.peers;
    if (!['auto', 'apple', 'qemu'].includes(backend)) throw new Error('VM backend must be auto, apple, or qemu');
    this.backend = backend;
    if (!['auto', 'local', 'required'].includes(this.mode)) throw new Error('Distribution mode must be auto, local, or required');
    this.call = call; this.execute = execute; this.guestStatus = guestStatus; this.onPlacement = onPlacement ?? onProgress;
    this.pollMilliseconds = pollMilliseconds; this.remoteTimeout = remoteTimeout; this.checkpointTimeout = checkpointTimeout; this.freeMemory = freeMemory;
    this.rsync = rsync;
    this.journal = path.join(this.directory, 'placement.json'); this.pendingFile = path.join(this.directory, 'pending-dispatch.json'); this.completedFile = path.join(this.directory, 'completed-dispatch.json');
    this.releaseDirectory = path.join(this.directory, 'checkpoint-releases');
    // The same checkout/pocket path on another initiating machine is a new
    // family unless its saved placement explicitly identifies the old one.
    this.stateKey = randomUUID();
  }
  rootfsPath(id) { return this.local.rootfsPath(id); }
  async probe() { return { ...await this.local.probe(), distribution: { mode: this.mode, target: this.target, connectedMachines: this.peers.map(p => p.name), placementUnit: 'communicating agent family', remoteReachabilityVerified: false } }; }
  async hasCheckpoint(placement) {
    if (!placement?.checkpointed || !Array.isArray(placement.checkpointFiles) || !placement.checkpointFiles.length) return false;
    for (const file of placement.checkpointFiles) {
      if (!/^[a-zA-Z0-9_-]+\.rootfs\.img(?:\.ovm-guest-v1\.json)?$/.test(file.name)) return false;
      try { const metadata = await lstat(path.join(this.directory, file.name)); if (!metadata.isFile() || metadata.size !== file.size) return false; }
      catch { return false; }
    }
    return true;
  }
  async choose(tasks) {
    const current = existsSync(this.journal) ? JSON.parse(await readFile(this.journal, 'utf8')) : null;
    const requestedBackend = this.backend === 'auto' ? current?.backend ?? 'auto' : this.backend;
    const forceLocal = this.mode === 'local' || this.target === 'local' || this.local.networkMode === 'isolated';
    if (forceLocal) {
      if (this.mode === 'required') throw new Error('Required distribution cannot execute on an explicitly local or isolated backend');
      if (current?.kind === 'remote' && !await this.hasCheckpoint(current)) throw new Error('Remote state has no complete local checkpoint; recover it before selecting local execution');
      return { kind: 'local', reason: 'Local execution selected' };
    }
    const hasLocalState = (await readdir(this.directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; })).some(name => name.endsWith('.rootfs.img'));
    const explicit = this.target !== 'auto';
    const requiredMemory = tasks.length * this.local.memoryMB * 1024 ** 2 + 1024 ** 3;
    if (current?.kind !== 'remote') {
      if (hasLocalState) {
        if (explicit || this.mode === 'required') throw new Error('This family has local VM state. Export and import its bundle on the destination before requiring remote placement.');
        return { kind: 'local', reason: 'Preserving this agent’s existing local environment' };
      }
      if (!explicit && this.mode === 'auto' && await this.freeMemory() >= requiredMemory) return { kind: 'local', reason: 'Local capacity available; keeping this family on its initiating machine' };
    }
    let candidates;
    if (current?.kind === 'remote') {
      if (explicit && ![current.peer.name, current.peer.host].includes(this.target)) throw new Error('This family already belongs to another controller; checkpoint it before moving it');
      candidates = this.peers.filter(peer => peer.enabled !== false && peer.host === current.peer.host && (!peer.root || peer.root === current.peer.root));
    } else candidates = explicit ? this.peers.filter(peer => peer.enabled !== false && (peer.name === this.target || peer.host === this.target)) : this.peers.filter(peer => peer.enabled !== false);
    if (explicit && !candidates.length) throw new Error(`Unknown or disabled machine ${this.target}. Run: ovm connect ${this.target}`);
    const mayFallBack = () => !explicit && this.mode === 'auto' && (current?.kind !== 'remote' || this.hasCheckpoint(current));
    if (!candidates.length && await mayFallBack()) return { kind: 'local', reason: 'No connected controller available; preparing and running the local environment' };
    let profile;
    try {
      profile = await this.guestStatus({ projectRoot: this.root, ...(this.local.bundlePath ? { bundlePath: this.local.bundlePath } : {}) });
      if (!profile.prepared || !profile.verified || profile.needsUpdate || !profile.profile?.recipeSha256) throw new Error('The initiating controller needs a current prepared guest image before remote admission');
    } catch (error) {
      if (await mayFallBack()) return { kind: 'local', reason: `Remote admission unavailable; preparing the local environment: ${error.message}` };
      throw error;
    }
    const observations = await Promise.all(candidates.map(async peer => {
      try {
        const probe = await this.call(peer, { op: 'probe', backend: requestedBackend, stateKey: current?.kind === 'remote' ? current.stateKey : this.stateKey }, { timeout: 3500 });
        const diskBudget = controllerDiskBudget(probe, tasks.map(task => ({ agentId: task.agentId,
          ...(task.inheritRootfs ? { parentId: path.basename(task.inheritRootfs).replace(/\.rootfs\.img$/, '') } : {}) })));
        const stateMatches = current?.kind !== 'remote' || (probe.state?.generation === current.generation
          && (current.checkpointFiles ?? []).filter(file => file.name.endsWith('.rootfs.img')).every(file => probe.state.files?.includes(file.name))
          && tasks.every(task => !task.inheritRootfs || probe.state.files?.includes(path.basename(task.inheritRootfs))));
        const ready = probe.vmReady === true && probe.memoryPressureCritical !== true && compatibleVMController(probe, requestedBackend)
          && probe.recipeSha256 === profile.profile.recipeSha256 && stateMatches
          && Number.isFinite(probe.freeMemoryBytes) && probe.freeMemoryBytes >= requiredMemory
          && Number.isFinite(probe.freeDiskBytes) && probe.freeDiskBytes >= diskBudget.requiredBytes;
        return { peer, probe, ready, ...(!ready ? { error: `${peer.name}: ready=${probe.vmReady === true}, backend=${probe.backend}, recipeMatches=${probe.recipeSha256 === profile.profile.recipeSha256}, stateMatches=${stateMatches}, freeMemoryBytes=${probe.freeMemoryBytes}, requiredMemoryBytes=${requiredMemory}, freeDiskBytes=${probe.freeDiskBytes}, requiredDiskBytes=${diskBudget.requiredBytes}` } : {}) };
      } catch (error) { return { peer, ready: false, error: error.message }; }
    }));
    const eligible = observations.filter(item => item.ready).sort((a, b) => b.probe.freeMemoryBytes - a.probe.freeMemoryBytes);
    if (!eligible.length) {
      if (explicit || this.mode === 'required' || (current?.kind === 'remote' && !await this.hasCheckpoint(current))) throw new Error(`No compatible remote VM controller is ready${observations[0]?.error ? `: ${observations[0].error}` : ''}. Recover a complete checkpoint or use an existing local family.`);
      return { kind: 'local', reason: 'Remote capacity unavailable; continuing from the complete local environment', observations };
    }
    const selected = eligible[0];
    if (typeof selected.probe.root !== 'string' || !path.isAbsolute(selected.probe.root)) throw new Error('Remote controller returned an invalid checkout path');
    if (selected.probe.rsyncPath != null && (typeof selected.probe.rsyncPath !== 'string' || !path.isAbsolute(selected.probe.rsyncPath) || /[\0\r\n]/.test(selected.probe.rsyncPath))) throw new Error('Remote controller returned an invalid rsync path');
    return { ...(current?.kind === 'remote' ? current : { stateKey: this.stateKey, generation: 0 }), kind: 'remote',
      backend: selected.probe.backend === 'qemu-arm64' ? 'qemu' : 'apple',
      peer: { ...selected.peer, root: selected.probe.root, rsyncPath: selected.probe.rsyncPath, rsyncProtocol: selected.probe.rsyncProtocol }, recipeSha256: profile.profile.recipeSha256 };
  }
  async checkpoint(pending, receipt) {
    if (receipt.checkpointAvailable === false || receipt.checkpointReleased === true || receipt.checkpointReleasePending === true) {
      throw new DistributionUncertainError('Remote checkpoint payload was released; recover the saved local completion instead of replaying this dispatch');
    }
    const stateDirectory = path.join(pending.placement.peer.root, 'vm/pockets/remote', pending.placement.stateKey);
    const snapshot = path.join(stateDirectory, '.checkpoints', pending.request.id);
    if (receipt.id !== pending.request.id || receipt.requestHash !== pending.requestHash || receipt.generation !== pending.request.generation + 1
      || receipt.stateDirectory !== stateDirectory || receipt.checkpointDirectory !== snapshot
      || !Array.isArray(receipt.workers) || receipt.workers.length !== pending.request.tasks.length
      || pending.request.tasks.some(task => receipt.workers.filter(worker => worker.agent === task.agentId && worker.stopped === true).length !== 1)) throw new DistributionUncertainError('Remote completion identity, generation, or stopped-worker evidence does not match');
    const files = receipt.checkpointFiles;
    if (!Array.isArray(files) || !files.length || new Set(files.map(file => file.name)).size !== files.length
      || files.some(file => !/^[a-zA-Z0-9_-]+\.rootfs\.img(?:\.ovm-guest-v1\.json)?$/.test(file.name) || !Number.isSafeInteger(file.size) || file.size < 0)) throw new DistributionUncertainError('Remote checkpoint manifest is invalid');
    for (const task of pending.request.tasks) if (!files.some(file => file.name === `${task.agentId}.rootfs.img`)) throw new DistributionUncertainError(`Remote checkpoint is missing ${task.agentId}'s disk`);
    const stage = path.join(this.directory, `.checkpoint-${pending.request.id}`);
    await mkdir(stage, { recursive: true, mode: 0o700 });
    for (const file of files) {
      const previous = path.join(this.directory, file.name);
      const base = path.join(this.local.bundlePath ?? path.join(this.root, 'vm/claudevm.bundle'), 'rootfs.img');
      const source = existsSync(previous) ? previous : file.name.endsWith('.rootfs.img') && existsSync(base) ? base : null;
      if (!existsSync(path.join(stage, file.name)) && source) {
        const target = path.join(stage, file.name);
        if (process.platform === 'darwin') await this.execute('/bin/cp', ['-c', '-p', '-n', source, target]).catch(() => {});
        else await copyFile(source, target, constants.COPYFILE_FICLONE_FORCE).catch(() => {});
      }
    }
    // The staging copies can be safely updated in place. Keeping the matching
    // extents avoids a second full sparse allocation on each checkpoint, and
    // interrupted stages are never exposed as the saved agent environment.
    const seeded = files.filter(file => file.name.endsWith('.rootfs.img')).every(file => existsSync(path.join(stage, file.name)));
    const rsync = await this.rsync();
    const transfer = checkpointRsyncOptions({ rsync, peer: pending.placement.peer, source: snapshot + '/', destination: stage + '/', seeded });
    await this.execute(rsync.path, transfer.args, { timeout: this.checkpointTimeout, maxBytes: 1024 * 1024, env: transfer.env });
    const generation = JSON.parse(await readFile(path.join(stage, '.generation.json'), 'utf8'));
    if (generation.generation !== receipt.generation || generation.lastDispatch !== pending.request.id) throw new DistributionUncertainError('Remote checkpoint changed during transfer; original dispatch will not be replayed');
    for (const file of files) {
      const metadata = await lstat(path.join(stage, file.name));
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== file.size) throw new DistributionUncertainError(`Remote checkpoint file is invalid: ${file.name}`);
      const handle = await open(path.join(stage, file.name), 'r');
      try { await handle.sync(); } finally { await handle.close(); }
    }
    for (const file of files) await rename(path.join(stage, file.name), path.join(this.directory, file.name));
    await save(this.journal, { ...pending.placement, generation: receipt.generation, checkpointed: true, checkpointFiles: files, lastDispatch: pending.request.id });
    const workers = receipt.workers.map(worker => ({ ...worker, placement: { machine: pending.placement.peer.name, host: pending.placement.peer.host, dispatchId: pending.request.id, checkpointed: true } }));
    // Keep the completed outbox until the higher-level agent has saved its turn.
    const release = { peer: pending.placement.peer, request: { op: 'release', id: pending.request.id, requestHash: pending.requestHash,
      checkpointAcknowledgement: { generation: receipt.generation, manifestSha256: digest(files) } } };
    const completed = { dispatchId: pending.request.id, requestHash: pending.requestHash, tasks: pending.tasks ?? pending.request.tasks, workers,
      checkpoint: { generation: receipt.generation, files }, release };
    await save(this.completedFile, completed);
    await this.queueRelease(completed);
    await rm(stage, { recursive: true, force: true });
    await this.flushReleases();
    await rm(this.pendingFile, { force: true });
    return workers;
  }
  async awaitReceipt(pending) {
    const deadline = Date.now() + this.remoteTimeout;
    let lastError;
    do {
      try {
        const receipt = await this.call(pending.placement.peer, { op: 'status', id: pending.request.id, requestHash: pending.requestHash });
        if (receipt.id !== pending.request.id || receipt.requestHash !== pending.requestHash) throw new DistributionUncertainError('Remote receipt identity mismatch');
        if (receipt.phase === 'completed') {
          try { return await this.checkpoint(pending, receipt); }
          catch (error) {
            if (error.uncertain) throw error;
            throw new DistributionUncertainError(`Remote VM finished, but its checkpoint could not be saved. Resume this agent to recover the same stopped dispatch ${pending.request.id}; no work was replayed. ${error.message}`);
          }
        }
        if (receipt.phase === 'rejected' && receipt.admitted === false) {
          const error = new Error(receipt.error || 'Remote request declined before execution'); error.rejected = true; throw error;
        }
        if (receipt.phase === 'uncertain' || (['running', 'accepted'].includes(receipt.phase) && receipt.ownerAlive === false)) throw new DistributionUncertainError(receipt.error || 'Remote worker ended without a completion receipt');
      } catch (error) {
        if (error.uncertain || error.rejected) throw error;
        lastError = error;
      }
      await new Promise(resolve => setTimeout(resolve, this.pollMilliseconds));
    } while (Date.now() < deadline);
    throw new DistributionUncertainError(`Remote result is pending; nothing was replayed locally. Resume this agent to recover dispatch ${pending.request.id}. ${lastError?.message || ''}`);
  }
  async recordRejected(pending, error) {
    const completed = { dispatchId: pending.request.id, requestHash: pending.requestHash, tasks: pending.tasks ?? pending.request.tasks,
      workers: pending.request.tasks.map(task => ({ agent: task.agentId, exitCode: null, output: '',
        error: `Rejected before execution: ${error.message}`, stopped: true, executionStarted: false, rejectedBeforeExecution: true,
        placement: { machine: pending.placement.peer.name, host: pending.placement.peer.host, dispatchId: pending.request.id, checkpointed: false } })) };
    await save(this.completedFile, completed);
    await rm(this.pendingFile, { force: true });
    return completed;
  }
  async recover() {
    // Completion is fsynced before a remote payload can be released. A crash
    // before pending-file removal must reuse it, never request the deleted disk.
    if (existsSync(this.completedFile)) {
      const completed = JSON.parse(await readFile(this.completedFile, 'utf8'));
      if (existsSync(this.pendingFile)) {
        const pending = JSON.parse(await readFile(this.pendingFile, 'utf8'));
        if (completed.dispatchId !== pending.request.id || completed.requestHash !== pending.requestHash) throw new DistributionUncertainError('Saved completion does not match the pending dispatch');
      }
      await this.validateCompletedCheckpoint(completed);
      await this.queueRelease(completed);
      await this.flushReleases();
      await rm(this.pendingFile, { force: true });
      return completed;
    }
    if (existsSync(this.pendingFile)) {
      const pending = JSON.parse(await readFile(this.pendingFile, 'utf8'));
      try { return { dispatchId: pending.request.id, tasks: pending.tasks ?? pending.request.tasks, workers: await this.awaitReceipt(pending) }; }
      catch (error) { if (error.rejected) return this.recordRejected(pending, error); throw error; }
    }
    await this.flushReleases();
    return null;
  }
  async validateCompletedCheckpoint(completed) {
    if (!completed.checkpoint) return;
    const placement = JSON.parse(await readFile(this.journal, 'utf8'));
    if (placement.lastDispatch !== completed.dispatchId || placement.generation !== completed.checkpoint.generation
      || digest(placement.checkpointFiles) !== digest(completed.checkpoint.files) || !await this.hasCheckpoint(placement)) {
      throw new DistributionUncertainError('Saved completion has no matching durable local checkpoint');
    }
  }
  async queueRelease(completed) {
    if (!completed.release) return;
    if (!/^[a-zA-Z0-9_-]{1,96}$/.test(completed.dispatchId)) throw new DistributionUncertainError('Invalid saved completion identity');
    await save(path.join(this.releaseDirectory, `${completed.dispatchId}.json`), completed.release);
  }
  async flushReleases() {
    const entries = await readdir(this.releaseDirectory).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    for (const name of entries.filter(name => /^[a-zA-Z0-9_-]{1,96}\.json$/.test(name))) {
      const file = path.join(this.releaseDirectory, name);
      const release = JSON.parse(await readFile(file, 'utf8'));
      try {
        const result = await this.call(release.peer, release.request);
        if (result.released === true) await rm(file);
      } catch { /* Retry this acknowledged snapshot later, even after turn acknowledgement. */ }
    }
  }
  async acknowledge(dispatchId) {
    if (!existsSync(this.completedFile)) return false;
    const completed = JSON.parse(await readFile(this.completedFile, 'utf8'));
    if (dispatchId && completed.dispatchId !== dispatchId) throw new Error('Cannot acknowledge another dispatch');
    if (existsSync(this.pendingFile)) throw new DistributionUncertainError('Reconcile the pending dispatch before acknowledging its result');
    await this.validateCompletedCheckpoint(completed);
    await this.queueRelease(completed);
    await this.flushReleases();
    await rm(this.completedFile);
    return true;
  }
  async run(tasks) {
    if (!tasks.length) return [];
    if (existsSync(this.pendingFile) || existsSync(this.completedFile)) throw new DistributionUncertainError('A remote dispatch is awaiting reconciliation. Resume the saved agent before sending more work.');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.flushReleases();
    const placement = await this.choose(tasks);
    this.onPlacement(placement);
    if (placement.kind === 'local') { await save(this.journal, placement); return this.local.run(tasks); }
    for (const task of tasks) {
      if (task.inheritRootfs && (path.dirname(path.resolve(task.inheritRootfs)) !== this.directory || !/^[a-zA-Z0-9_-]+\.rootfs\.img$/.test(path.basename(task.inheritRootfs)))) {
        throw new Error('Remote inheritance must refer to a pocket in this checkpointed family');
      }
    }
    const request = { protocol: 'ovm.controller/v1', op: 'run', id: randomUUID(), stateKey: placement.stateKey,
      generation: placement.generation, recipeSha256: placement.recipeSha256, memoryMB: this.local.memoryMB, cpuCount: this.local.cpuCount,
      networkMode: this.local.networkMode, distributionMode: this.mode, backend: placement.backend,
      artifactInputs: await artifactInputs(path.join(this.directory, 'artifacts')),
      tasks: tasks.map(task => ({ agentId: task.agentId, command: task.command, artifactCapture: Boolean(task.artifactCapture || task.artifactPublication), ...(task.inheritRootfs ? { parentId: path.basename(task.inheritRootfs).replace(/\.rootfs\.img$/, '') } : {}) })) };
    const pending = { request, requestHash: digest(request), placement, tasks };
    await save(this.pendingFile, pending);
    try {
      let accepted;
      try { accepted = await this.call(placement.peer, request); }
      catch (error) { if (error.rejected) throw error; /* Submission may have reached the worker. Query this same ID. */ }
      if (accepted && (accepted.id !== pending.request.id || accepted.requestHash !== pending.requestHash)) throw new DistributionUncertainError('Remote dispatch identity mismatch');
      return await this.awaitReceipt(pending);
    } catch (error) {
      if (error.rejected) {
        if (this.target === 'auto' && this.mode === 'auto' && (!placement.generation || await this.hasCheckpoint(placement))) {
          const fallback = { kind: 'local', reason: `Remote declined before execution: ${error.message}` };
          await save(this.journal, fallback);
          await rm(this.pendingFile, { force: true });
          this.onPlacement(fallback);
          return this.local.run(tasks);
        }
        await this.recordRejected(pending, error);
      }
      throw error;
    }
  }
}

export { DistributedVMFleet as DistributedFleet };
