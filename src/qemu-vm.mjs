import { spawn, execFile } from 'node:child_process';
import { constants, existsSync } from 'node:fs';
import { access, chmod, copyFile, cp, link, lstat, mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import { VMLease } from './lease.mjs';
import { ensurePreparedImage, upgradePreparedImage, recordPreparedClone, preparedImageReceiptPath } from './guest-manager.mjs';
import { prepareLaunchNetwork, distributionMode as validateDistributionMode } from './guest-network.mjs';
import { readDistributionSettings } from './distribution-config.mjs';

const execute = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RECEIPT = 'OVM_QEMU_RECEIPT:';
const MAX_CONSOLE = 2 * 1024 * 1024;
const idPattern = /^[a-z0-9][a-z0-9_-]{0,47}$/;

export async function findExecutable(name, { environment = process.env, extra = [] } = {}) {
  const candidates = name.includes(path.sep) ? [name] : [...(environment.PATH ?? '').split(path.delimiter).filter(Boolean).map(p => path.join(p, name)), ...extra];
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return path.resolve(candidate); } catch {}
  }
  return null;
}

export async function qemuTools({ environment = process.env, platform = process.platform, architecture = process.arch } = {}) {
  const binary = await findExecutable(environment.OVM_QEMU_BINARY || 'qemu-system-aarch64', { environment });
  const mke2fs = await findExecutable(environment.OVM_MKE2FS || 'mke2fs', { environment, extra: ['/opt/homebrew/opt/e2fsprogs/sbin/mke2fs', '/usr/sbin/mke2fs', '/sbin/mke2fs'] });
  const python = await findExecutable('python3', { environment });
  const lsof = await findExecutable('lsof', { environment, extra: ['/usr/sbin/lsof'] });
  let accelerator = 'tcg';
  if (architecture === 'arm64' && platform === 'darwin') accelerator = 'hvf';
  if (architecture === 'arm64' && platform === 'linux') {
    try { await access('/dev/kvm', constants.R_OK | constants.W_OK); accelerator = 'kvm'; } catch {}
  }
  if (environment.OVM_QEMU_ACCEL) {
    if (!['tcg', 'hvf', 'kvm'].includes(environment.OVM_QEMU_ACCEL)) throw new Error('OVM_QEMU_ACCEL must be tcg, hvf, or kvm');
    accelerator = environment.OVM_QEMU_ACCEL;
  }
  return { binary, mke2fs, python, lsof, accelerator, guestArchitecture: 'aarch64', hostArchitecture: architecture, hostPlatform: platform };
}

export function qemuArguments({ tools, bundlePath, rootfs, seed, memoryMB, cpuCount, networkMode, distributionMode }) {
  const args = ['-machine', `virt,accel=${tools.accelerator},gic-version=3`, '-cpu', tools.accelerator === 'tcg' ? 'max' : 'host',
    '-m', String(memoryMB), '-smp', String(cpuCount), '-display', 'none', '-monitor', 'none', '-serial', 'stdio', '-no-reboot',
    '-kernel', path.join(bundlePath, 'vmlinuz'), '-initrd', path.join(bundlePath, 'initrd'),
    '-append', `root=LABEL=cloudimg-rootfs rw console=ttyAMA0 init=/bin/bash panic=-1 ovm.network=${networkMode} ovm.distribution=${distributionMode} ovm.network_index=0`,
    '-blockdev', JSON.stringify({ driver: 'file', filename: rootfs, 'node-name': 'rootfile' }),
    '-blockdev', JSON.stringify({ driver: 'raw', file: 'rootfile', 'node-name': 'rootdisk' }),
    '-device', 'virtio-blk-pci,drive=rootdisk',
    '-blockdev', JSON.stringify({ driver: 'file', filename: seed, 'node-name': 'seedfile', 'read-only': true }),
    '-blockdev', JSON.stringify({ driver: 'raw', file: 'seedfile', 'node-name': 'seeddisk', 'read-only': true }),
    '-device', 'virtio-blk-pci,drive=seeddisk'];
  if (networkMode === 'nat') args.push('-netdev', 'user,id=nat', '-device', 'virtio-net-pci,netdev=nat');
  else args.push('-nic', 'none');
  return args;
}

export function parseQemuReceipt(consoleText, { token, agentId, command, maximumOutputBytes }) {
  const records = consoleText.split(/\r?\n/).filter(line => line.startsWith(RECEIPT)).map(line => JSON.parse(line.slice(RECEIPT.length)));
  const matching = records.filter(record => record.token === token);
  if (matching.length !== 1) throw new Error('QEMU did not return exactly one matching guest receipt');
  const record = matching[0];
  const status = value => value === null || (Number.isInteger(value) && value >= -127 && value <= 255);
  if (record.schema !== 'ovm.qemu-worker/v1' || record.agent !== agentId || record.commandSha256 !== createHash('sha256').update(command).digest('hex')
      || !status(record.bootstrapExitCode) || !status(record.exitCode)
      || !(record.error === null || typeof record.error === 'string')
      || (record.error === null && (record.bootstrapExitCode !== 0 || record.exitCode === null))
      || typeof record.outputTruncated !== 'boolean' || typeof record.meshReady !== 'boolean'
      || (record.runtimeReady !== undefined && typeof record.runtimeReady !== 'boolean')
      || (record.fallbackReason !== undefined && record.fallbackReason !== null && typeof record.fallbackReason !== 'string')
      || !Number.isFinite(record.execMs) || record.execMs < 0
      || typeof record.outputBase64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(record.outputBase64)) throw new Error('Invalid QEMU execution receipt');
  const bytes = Buffer.from(record.outputBase64, 'base64');
  if (bytes.toString('base64') !== record.outputBase64) throw new Error('Invalid QEMU output encoding');
  if (bytes.length > maximumOutputBytes) throw new Error('QEMU receipt exceeds the requested output bound');
  const { outputBase64, token: ignored, schema, ...result } = record;
  return { ...result, output: bytes.toString('utf8'), outputBytes: bytes.length };
}

export function qemuShellReady(consoleText) {
  const tail = consoleText.slice(-1024).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replaceAll('\r', '');
  return /(?:bash-[\d.]+|root@[^\n]{0,160})#\s*$/.test(tail);
}

async function regular(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Expected a regular VM input: ${file}`);
  return info;
}

async function assertClosed(files) {
  const binary = await findExecutable('lsof', { extra: ['/usr/sbin/lsof'] });
  if (!binary) throw new Error('lsof is needed to check that VM input disks are closed');
  try {
    const result = await execute(binary, ['-t', '--', ...files], { timeout: 15_000 });
    if (result.stdout.trim()) throw new Error(`VM disk is open in process ${result.stdout.trim()}`);
    if (result.stderr.trim()) throw new Error(result.stderr);
  } catch (error) {
    if (error.code === 1 && !String(error.stdout ?? '').trim() && !String(error.stderr ?? '').trim()) return;
    throw error;
  }
}

async function cloneDisk(source, target) {
  const before = await regular(source);
  if (existsSync(target)) throw new Error(`VM disk already exists: ${target}`);
  const temporary = `${target}.clone-${randomUUID()}`;
  try {
    if (process.platform === 'darwin') await execute('/bin/cp', ['-c', '-p', '-n', source, temporary], { timeout: 120_000 });
    else await execute('cp', ['--reflink=auto', '--sparse=always', '--no-clobber', source, temporary], { timeout: 600_000 });
    await chmod(temporary, 0o600);
    const after = await regular(source);
    if ((await regular(temporary)).size !== before.size || ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(key => before[key] !== after[key])) throw new Error('VM source changed during cloning');
    await link(temporary, target);
  } finally { await rm(temporary, { force: true }); }
}

export class QemuVMFleet {
  constructor({ projectRoot = ROOT, bundlePath = path.join(projectRoot, 'vm/claudevm.bundle'), stateDirectory,
    memoryMB = 768, cpuCount = 1, timeoutMilliseconds, networkMode = process.env.OVM_NETWORK_MODE ?? 'nat',
    distributionMode, prepareNetwork, prepareRuntime = ensurePreparedImage, upgradeRuntime = upgradePreparedImage,
    environment = process.env, spawnImpl = spawn } = {}) {
    if (!stateDirectory) throw new Error('QEMU requires a state directory');
    if (!['nat', 'isolated'].includes(networkMode)) throw new Error('OVM_NETWORK_MODE must be nat or isolated');
    if (timeoutMilliseconds !== undefined && (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 1 || timeoutMilliseconds > 2 ** 31 - 1)) throw new Error('Invalid QEMU host deadline');
    if (!Number.isInteger(memoryMB) || memoryMB < 512 || memoryMB > 32768 || !Number.isInteger(cpuCount) || cpuCount < 1 || cpuCount > 64) throw new Error('Invalid QEMU VM capacity');
    Object.assign(this, { projectRoot, bundlePath, stateDirectory, memoryMB, cpuCount, timeoutMilliseconds, networkMode, prepareNetwork, prepareRuntime, upgradeRuntime, environment, spawnImpl });
    this.distributionMode = validateDistributionMode(distributionMode ?? readDistributionSettings(projectRoot).mode);
  }
  rootfsPath(id) { if (!idPattern.test(id)) throw new Error('Invalid pocket ID'); return path.join(this.stateDirectory, `${id}.rootfs.img`); }
  async probe() {
    const tools = await qemuTools({ environment: this.environment });
    return { backend: 'qemu-arm64', ...tools, binaryPath: tools.binary, binaryAvailable: Boolean(tools.binary), seedBuilderAvailable: Boolean(tools.mke2fs),
      bundlePath: this.bundlePath, bundleAvailable: ['rootfs.img', 'vmlinuz', 'initrd'].every(name => existsSync(path.join(this.bundlePath, name))),
      memoryMB: this.memoryMB, cpuCount: this.cpuCount, networkMode: this.networkMode, distributionMode: this.distributionMode };
  }
  async run(tasks) {
    if (!Array.isArray(tasks) || !tasks.length) return [];
    if (new Set(tasks.map(t => t.agentId)).size !== tasks.length) throw new Error('A pocket may execute only once per QEMU batch');
    const tools = await qemuTools({ environment: this.environment });
    if (!tools.binary || !tools.mke2fs || !tools.python || !tools.lsof) throw new Error('QEMU requires qemu-system-aarch64, mke2fs (e2fsprogs), python3, and lsof on PATH');
    await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
    const base = await this.prepareRuntime({ projectRoot: this.projectRoot, bundlePath: this.bundlePath });
    const leases = [];
    try {
      // Prepare every clone before starting any VM, including child snapshots.
      for (const task of tasks) {
        if (typeof task.command !== 'string' || Buffer.byteLength(task.command) > 64 * 1024) throw new Error('Invalid QEMU task command');
        if (task.timeoutSeconds !== undefined && (!Number.isInteger(task.timeoutSeconds) || task.timeoutSeconds < 1 || task.timeoutSeconds > 120)) throw new Error('QEMU task timeout must be between 1 and 120 seconds');
        const rootfs = this.rootfsPath(task.agentId);
        const lease = new VMLease(`${rootfs}.qemu.lease`, { resource: 'QEMU pocket disk', staleRecovery: 'verify the specific QEMU process has exited before removing this lease' });
        await lease.acquire(); leases.push(lease);
        const source = existsSync(rootfs) ? rootfs : task.inheritRootfs ?? path.join(this.bundlePath, 'rootfs.img');
        await assertClosed([source]);
        let profile = base;
        if (source !== path.join(this.bundlePath, 'rootfs.img')) profile = (await this.upgradeRuntime({ projectRoot: this.projectRoot, bundlePath: this.bundlePath, rootfsPath: source, stateDirectory: this.stateDirectory })).profile;
        if (!existsSync(rootfs)) await cloneDisk(source, rootfs);
        if (!existsSync(preparedImageReceiptPath(rootfs))) await recordPreparedClone({ rootfsPath: rootfs, profile });
      }
      // Issue every identity before taking per-VM registry snapshots. Otherwise
      // the first guest's seed can omit peers created later in this batch.
      const identities = new Map();
      if (this.networkMode === 'nat') for (const task of tasks) {
        identities.set(task.agentId, await (this.prepareNetwork ?? prepareLaunchNetwork)({ projectRoot: this.projectRoot,
          guestId: `rootfs:${path.resolve(this.rootfsPath(task.agentId))}`, agentId: task.agentId,
          networkMode: this.networkMode, distributionMode: this.distributionMode }));
      }
      let release;
      const allReady = new Promise(resolve => { release = resolve; });
      const arrived = new Set();
      const barrier = id => { arrived.add(id); if (arrived.size === tasks.length) release(); return allReady; };
      const results = await Promise.allSettled(tasks.map(async task => {
        try { return await this.runOne(task, tools, barrier, identities.get(task.agentId)); }
        finally { barrier(task.agentId); }
      }));
      const failures = results.filter(result => result.status === 'rejected');
      if (failures.length) {
        const error = new Error(failures.map(result => result.reason.message).join('; '));
        // Other members may already have executed even if one failed to launch.
        error.uncertain = results.some(result => result.status === 'fulfilled') || failures.some(result => result.reason.uncertain);
        throw error;
      }
      return results.map(result => result.value);
    } finally { for (const lease of leases.reverse()) await lease.release(); }
  }
  async runOne(task, tools, barrier, identity) {
    const started = performance.now();
    // TCG includes emulated boot and runtime startup before the task's own
    // deadline begins. Measured x86-to-ARM boots take about 100 seconds.
    const timeoutMilliseconds = this.timeoutMilliseconds ?? (tools.accelerator === 'tcg' ? 600_000 : 180_000);
    const directory = await mkdtemp(path.join(this.stateDirectory, '.qemu-task-'));
    const payload = path.join(directory, 'payload');
    await mkdir(payload, { mode: 0o700 });
    const specification = { agentId: task.agentId, command: task.command, token: randomUUID(), timeoutSeconds: task.timeoutSeconds ?? 60,
      maximumOutputBytes: task.artifactPublication || task.artifactCapture ? 400 * 1024 : 64 * 1024 };
    let startedProcess = false;
    try {
      await writeFile(path.join(payload, 'task.json'), JSON.stringify(specification), { mode: 0o600 });
      await copyFile(path.join(this.projectRoot, 'host/qemu-worker.py'), path.join(payload, 'worker.py'));
      if (this.networkMode === 'nat') {
        await cp(identity.shareDir ?? identity.networkShare, path.join(payload, 'network'), { recursive: true, dereference: false });
      }
      const artifacts = path.join(this.stateDirectory, 'artifacts');
      if (existsSync(artifacts)) await cp(artifacts, path.join(payload, 'artifacts'), { recursive: true, dereference: false });
      const seed = path.join(directory, 'seed.img');
      const file = await open(seed, 'wx', 0o600); await file.truncate(16 * 1024 * 1024); await file.close();
      await execute(tools.mke2fs, ['-q', '-F', '-t', 'ext4', '-L', 'OVMSEED', '-d', payload, seed], { timeout: 30_000 });
      const args = qemuArguments({ tools, bundlePath: this.bundlePath, rootfs: this.rootfsPath(task.agentId), seed,
        memoryMB: this.memoryMB, cpuCount: this.cpuCount, networkMode: this.networkMode, distributionMode: this.distributionMode });
      const consoleText = await new Promise((resolve, reject) => {
        const child = this.spawnImpl(tools.python, [path.join(this.projectRoot, 'host/qemu-supervisor.py'), String(process.pid), tools.binary, ...args], { stdio: ['pipe', 'pipe', 'pipe'], env: this.environment });
        let stdout = '', stderr = '', injected = false, receiptSeen = false, failure = null;
        child.once('spawn', () => { startedProcess = true; });
        const stop = error => { failure ??= error; child.kill('SIGTERM'); };
        const interrupt = () => stop(new Error('QEMU execution interrupted; outcome requires reconciliation'));
        process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
        const timer = setTimeout(() => stop(new Error(`QEMU exceeded ${timeoutMilliseconds}ms; execution outcome is unknown`)), timeoutMilliseconds);
        child.stdout.on('data', chunk => {
          stdout += chunk.toString('utf8');
          if (Buffer.byteLength(stdout) > MAX_CONSOLE) return stop(new Error('QEMU console exceeded its output limit'));
          if (!injected && qemuShellReady(stdout)) {
            injected = true;
            child.stdin.write('mkdir -p /mnt/ovm-seed; mount -t ext4 -o ro /dev/vdb /mnt/ovm-seed && exec /usr/bin/python3 /mnt/ovm-seed/worker.py\n');
          }
          if (!receiptSeen && stdout.split(/\r?\n/).some(line => line.startsWith(RECEIPT) && line.endsWith('}'))) {
            try {
              parseQemuReceipt(stdout, specification);
              receiptSeen = true;
              barrier(task.agentId).then(() => child.stdin.write(`OVM_SHUTDOWN:${specification.token}\n`));
            } catch (error) { stop(error); }
          }
        });
        child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); if (Buffer.byteLength(stderr) > MAX_CONSOLE) stop(new Error('QEMU stderr exceeded its output limit')); });
        child.stdin.on('error', () => {});
        child.once('error', error => { failure ??= error; });
        child.once('close', (code, signal) => {
          clearTimeout(timer); process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
          writeFile(path.join(directory, 'console.log'), stdout + '\n' + stderr, { mode: 0o600 }).then(() => {
            if (failure || code !== 0) reject(failure ?? new Error(`QEMU exited ${code ?? signal}: ${stderr.slice(-4000)}`));
            else resolve(stdout);
          }, reject);
        });
      });
      const result = parseQemuReceipt(consoleText, specification);
      return { ...result, stopped: true, backend: 'qemu-arm64', accelerator: tools.accelerator, networkMode: this.networkMode,
        distributionMode: this.distributionMode, networkFallbackReason: result.fallbackReason ?? null, totalMs: performance.now() - started };
    } catch (error) { if (startedProcess) error.uncertain = true; throw error; }
    finally {
      // Logs remain available; task bytes and mounted guest credentials do not.
      await rm(payload, { recursive: true, force: true }); await rm(path.join(directory, 'seed.img'), { force: true });
    }
  }
}
