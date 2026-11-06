import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { cloneControllerSnapshot, controllerProbe, handleControllerRequest, runControllerJob } from '../src/controller-worker.mjs';
import { runCaptured } from '../src/controller-transport.mjs';
import { buildOstadixTask } from '../src/ostadix-control.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const recipe = 'a'.repeat(64);
const ready = async () => ({ vmReady: true, backend: 'apple-vz-arm64', platform: 'darwin', architecture: 'arm64', guestArchitecture: 'aarch64',
  recipeSha256: recipe, freeMemoryBytes: 32 * 1024 ** 3, freeDiskBytes: 40 * 1024 ** 3 });
const request = id => ({ protocol: 'ovm.controller/v1', op: 'run', id, stateKey: 'family', generation: 0,
  recipeSha256: recipe, memoryMB: 512, cpuCount: 1, networkMode: 'nat', distributionMode: 'auto', tasks: [{ agentId: 'alpha', command: 'echo once' }] });
async function temporary(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ovm-controller-test-'));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}

test('near-limit Ostadix source and checks survive remote admission and worker dispatch intact', async t => {
  const root = await temporary(t);
  const prefix = 'python^(\n# ', suffix = '\n__oval_result__ = 2\n)_python\n';
  const source = prefix + 'x'.repeat(8192 - Buffer.byteLength(prefix + suffix)) + suffix;
  const task = buildOstadixTask({ type: 'ostadix', mode: 'run', name: 'large-program', source,
    checks: Array.from({ length: 8 }, () => ({ kind: 'stdout_contains', expected: 'x'.repeat(4096) })) },
  { id: 'alpha' }, { round: 1 });
  assert.equal(Buffer.byteLength(source), 8192);
  assert.ok(Buffer.byteLength(task.command) > 8192);
  assert.ok(Buffer.byteLength(task.command) <= 128 * 1024);
  const work = { ...request('ostadix-capture'), tasks: [{ agentId: task.agentId, command: task.command, artifactCapture: task.artifactCapture }] };
  let launches = 0, executions = 0;
  const launch = () => {
    launches += 1; const child = new EventEmitter(); child.pid = process.pid; child.unref = () => {};
    queueMicrotask(() => child.emit('spawn')); return child;
  };
  assert.equal((await handleControllerRequest(work, { root, probe: ready, launch })).admitted, true);
  class Fleet {
    constructor(options) { this.directory = options.stateDirectory; }
    async run(tasks) {
      executions += 1; assert.deepEqual(tasks, work.tasks);
      await writeFile(path.join(this.directory, 'alpha.rootfs.img'), 'stopped capture fixture');
      return [{ agent: 'alpha', stopped: true, exitCode: 0 }];
    }
  }
  await runControllerJob(work.id, { root, Fleet, probe: ready, clone: copyFile });
  const job = path.join(root, 'runtime/distribution/jobs', work.id);
  assert.deepEqual(JSON.parse(await readFile(path.join(job, 'request.json'))), work);
  assert.equal(JSON.parse(await readFile(path.join(job, 'receipt.json'))).phase, 'completed');
  assert.equal(launches, 1); assert.equal(executions, 1);
});

test('remote command limits preserve raw VM bounds and allow sixteen bounded capture commands', async t => {
  const root = await temporary(t); let launches = 0;
  const launch = () => {
    launches += 1; const child = new EventEmitter(); child.pid = process.pid; child.unref = () => {};
    queueMicrotask(() => child.emit('spawn')); return child;
  };
  for (const artifactCapture of [undefined, false]) {
    const work = { ...request(`raw-boundary-${artifactCapture}`), tasks: [{ agentId: 'alpha', command: 'x'.repeat(8192), artifactCapture }] };
    assert.equal((await handleControllerRequest(work, { root, probe: ready, launch })).admitted, true);
  }
  const batch = { ...request('capture-boundary'), tasks: Array.from({ length: 16 }, (_, index) => ({
    agentId: `agent-${index}`, command: 'x'.repeat(128 * 1024), artifactCapture: true,
  })) };
  assert.equal((await handleControllerRequest(batch, { root, probe: ready, launch })).admitted, true);
  assert.equal(launches, 3);
  const invalid = [
    { command: 'x'.repeat(8193) },
    { command: 'x'.repeat(8193), artifactCapture: false },
    { command: 'é'.repeat(4097) },
    { command: 'x'.repeat(128 * 1024 + 1), artifactCapture: true },
    { command: 'é'.repeat(64 * 1024 + 1), artifactCapture: true },
    { command: 'x'.repeat(8193), artifactCapture: 'true' },
    { command: 'echo bounded', artifactCapture: 'true' },
  ];
  for (const [index, task] of invalid.entries()) {
    const work = { ...request(`command-invalid-${index}`), tasks: [{ agentId: 'alpha', ...task }] };
    await assert.rejects(handleControllerRequest(work, { root,
      probe: () => assert.fail('invalid command must be rejected before capacity inspection'),
      launch: () => assert.fail('invalid command must not launch a worker'),
    }), error => error.rejected === true && /Invalid/.test(error.message));
    await assert.rejects(stat(path.join(root, 'runtime/distribution/jobs', work.id)), { code: 'ENOENT' });
  }
});

test('aggregate remote request budget includes JSON escaping across individually valid captures', async t => {
  const root = await temporary(t);
  const work = { ...request('escaped-captures'), tasks: Array.from({ length: 16 }, (_, index) => ({
    agentId: `agent-${index}`, command: '\\'.repeat(128 * 1024), artifactCapture: true,
  })) };
  assert.ok(Buffer.byteLength(JSON.stringify(work)) > 4 * 1024 * 1024);
  await assert.rejects(handleControllerRequest(work, { root,
    probe: () => assert.fail('oversized request must be rejected before capacity inspection'),
    launch: () => assert.fail('oversized request must not launch a worker'),
  }), error => error.rejected === true && /Controller request is too large/.test(error.message));
  await assert.rejects(stat(path.join(root, 'runtime/distribution/jobs', work.id)), { code: 'ENOENT' });
});

test('concurrent duplicate admission spawns one worker and refuses changed work', async t => {
  const root = await temporary(t); let launches = 0;
  const launch = () => { launches += 1; const child = new EventEmitter(); child.pid = process.pid; child.unref = () => {}; queueMicrotask(() => child.emit('spawn')); return child; };
  const work = request('same-job');
  const replies = await Promise.all([handleControllerRequest(work, { root, probe: ready, launch }), handleControllerRequest(work, { root, probe: ready, launch })]);
  assert.equal(launches, 1);
  assert.ok(replies.every(reply => reply.requestHash === digest(work)));
  await assert.rejects(handleControllerRequest({ ...work, tasks: [{ agentId: 'alpha', command: 'different' }] }, { root, probe: ready, launch }), /reused with different work/);
  assert.equal(launches, 1);
});

test('one worker execution retains an immutable stopped checkpoint with no expiring hold', async t => {
  const root = await temporary(t); const work = request('snapshot-job');
  const job = path.join(root, 'runtime/distribution/jobs', work.id);
  await mkdir(job, { recursive: true }); await writeFile(path.join(job, 'request.json'), JSON.stringify(work));
  let executions = 0;
  class Fleet {
    constructor(options) { this.directory = options.stateDirectory; }
    async run() { executions += 1; await writeFile(path.join(this.directory, 'alpha.rootfs.img'), 'stopped disk'); return [{ agent: 'alpha', stopped: true, exitCode: 0 }]; }
  }
  await runControllerJob(work.id, { root, Fleet, probe: ready, clone: copyFile });
  await runControllerJob(work.id, { root, Fleet, probe: ready, clone: copyFile });
  assert.equal(executions, 1);
  const receipt = JSON.parse(await readFile(path.join(job, 'receipt.json')));
  assert.equal(receipt.phase, 'completed');
  await writeFile(path.join(receipt.stateDirectory, 'alpha.rootfs.img'), 'later work');
  assert.equal(await readFile(path.join(receipt.checkpointDirectory, 'alpha.rootfs.img'), 'utf8'), 'stopped disk');
  assert.deepEqual(receipt.checkpointFiles, [{ name: 'alpha.rootfs.img', size: 12 }]);
});

test('missing remote parent is rejected before fleet execution', async t => {
  const root = await temporary(t); const work = request('missing-parent'); work.tasks[0].parentId = 'absent';
  const job = path.join(root, 'runtime/distribution/jobs', work.id);
  await mkdir(job, { recursive: true }); await writeFile(path.join(job, 'request.json'), JSON.stringify(work));
  class Fleet { constructor() { assert.fail('must reject before fleet construction'); } }
  await runControllerJob(work.id, { root, Fleet, probe: ready });
  const receipt = JSON.parse(await readFile(path.join(job, 'receipt.json')));
  assert.equal(receipt.phase, 'rejected'); assert.equal(receipt.admitted, false);
  assert.match(receipt.error, /parent pocket is absent/);
});

test('same-authority join retries preserve the existing controller identity', async t => {
  const root = await temporary(t); const certificate = 'NEBULA CERTIFICATE example';
  const invitation = { schema: 'ovm-trusted-controller-v1', network: { networkId: 'b'.repeat(32), controllerId: 'new-controller' }, caCertificate: certificate };
  const caFileSha256 = createHash('sha256').update(certificate).digest('hex'); let joined = false; let joins = 0;
  const inspectNetwork = async options => { assert.ok(options.stateRoot.endsWith(invitation.network.networkId)); assert.equal(options.stateDir, undefined); return joined ? { configured: true, networkId: invitation.network.networkId, controllerId: 'original-controller', caFileSha256 } : { configured: false }; };
  const previous = process.env.OVM_NETWORK_STATE;
  t.after(() => { if (previous === undefined) delete process.env.OVM_NETWORK_STATE; else process.env.OVM_NETWORK_STATE = previous; });
  const dependencies = { root, inspectNetwork, join: async () => { joins += 1; joined = true; }, settings: () => ({ mode: 'auto', peers: [] }), saveSettings: async () => {} };
  await handleControllerRequest({ protocol: 'ovm.controller/v1', op: 'join', invitation }, dependencies);
  const result = await handleControllerRequest({ protocol: 'ovm.controller/v1', op: 'join', invitation: { ...invitation, network: { ...invitation.network, controllerId: 'another-export' } } }, dependencies);
  assert.equal(joins, 1); assert.equal(result.controllerId, 'original-controller');
  await assert.rejects(handleControllerRequest({ protocol: 'ovm.controller/v1', op: 'join', invitation: { ...invitation, caCertificate: 'different CA' } }, dependencies), /another authority/);
});

test('admission requires explicit readiness and finite capacity', async t => {
  const root = await temporary(t);
  for (const [index, proof] of [{ vmReady: 'true' }, { freeMemoryBytes: undefined }, { freeDiskBytes: Infinity }].entries()) {
    await assert.rejects(handleControllerRequest(request(`unready-${index}`), {
      root, probe: async () => ({ ...await ready(), ...proof }), launch: () => assert.fail('not admitted'),
    }), error => error.rejected === true);
  }
});

test('Linux QEMU probe needs its own tools and prepared guest, without Apple private helpers', async t => {
  const root = await temporary(t);
  const options = { platform: 'linux', architecture: 'x64', nodeVersion: '26.8.2', environment: {},
    guestStatus: async () => ({ prepared: true, verified: true, needsUpdate: false, profile: { recipeSha256: recipe } }),
    rsyncTools: async () => ({ path: '/usr/bin/rsync', version: '3.4.1', protocol: 32 }),
    memoryInfo: async () => ({ availableMemoryBytes: 32 * 1024 ** 3, memoryPressureCritical: false }),
    filesystem: async () => ({ bavail: 10_000_000, bsize: 4096 }),
    inspectQemuTools: async () => ({ binary: '/usr/bin/qemu-system-aarch64', mke2fs: '/usr/sbin/mke2fs', python: '/usr/bin/python3', lsof: '/usr/bin/lsof', accelerator: 'tcg' }),
    metadata: async () => ({ size: 24 * 1024 ** 3, blocks: 16 * 1024 ** 2 }),
    exists: file => file.includes('/vm/claudevm.bundle/') || /\/host\/qemu-(worker|supervisor)\.py$/.test(file),
  };
  const result = await controllerProbe(root, options);
  assert.equal(result.vmReady, true); assert.equal(result.backend, 'qemu-arm64'); assert.equal(result.guestArchitecture, 'aarch64');
  assert.equal(result.minimumFreeDiskBytesPerGuest, 17 * 1024 ** 3);
  for (const missing of ['binary', 'mke2fs', 'python', 'lsof']) {
    const probe = await controllerProbe(root, { ...options, inspectQemuTools: async () => ({ ...await options.inspectQemuTools(), [missing]: null }) });
    assert.equal(probe.vmReady, false, `${missing} is required`);
  }
  assert.equal((await controllerProbe(root, { ...options, nodeVersion: '22.0.0' })).vmReady, false);
  assert.equal((await controllerProbe(root, { ...options, guestStatus: async () => ({ prepared: true, verified: false }) })).vmReady, false);
  assert.equal((await controllerProbe(root, { ...options, backend: 'apple' })).vmReady, false);
});

test('QEMU admission binds requested backend and guest architecture and reserves sparse-copy space', async t => {
  const root = await temporary(t);
  const qemu = { ...await ready(), backend: 'qemu-arm64', platform: 'linux', architecture: 'x64', minimumFreeDiskBytesPerGuest: 24 * 1024 ** 3 };
  for (const [index, override] of [{ guestArchitecture: 'x86_64' }, { freeDiskBytes: 20 * 1024 ** 3 }, { backend: 'apple-vz-arm64' }].entries()) {
    await assert.rejects(handleControllerRequest({ ...request(`qemu-invalid-${index}`), backend: 'qemu' }, {
      root, probe: async () => ({ ...qemu, ...override }), launch: () => assert.fail('incompatible QEMU work must not be admitted'),
    }), error => error.rejected === true);
  }
  const work = { ...request('qemu-job'), backend: 'qemu' };
  const job = path.join(root, 'runtime/distribution/jobs', work.id);
  await mkdir(job, { recursive: true }); await writeFile(path.join(job, 'request.json'), JSON.stringify(work));
  let fleetBackend;
  await runControllerJob(work.id, { root, probe: async (_root, options) => { assert.equal(options.backend, 'qemu'); return qemu; }, clone: copyFile,
    createFleet: options => { fleetBackend = options.backend; return { run: async () => {
      await writeFile(path.join(options.stateDirectory, 'alpha.rootfs.img'), 'qemu stopped');
      return [{ agent: 'alpha', stopped: true, exitCode: 0, backend: 'qemu-arm64' }];
    } }; },
  });
  assert.equal(fleetBackend, 'qemu');
  assert.equal(JSON.parse(await readFile(path.join(job, 'receipt.json'))).phase, 'completed');
});

test('Linux stopped snapshots request sparse copies and retain overwrite protection', async t => {
  const root = await temporary(t); const source = path.join(root, 'source.img'), target = path.join(root, 'target.img');
  await writeFile(source, 'stopped');
  let calls = 0;
  const execute = async (binary, args) => {
    calls += 1; assert.equal(binary, '/bin/cp');
    assert.deepEqual(args.slice(0, 4), ['--reflink=auto', '--sparse=always', '--no-clobber', '--']);
    await copyFile(args.at(-2), args.at(-1));
  };
  await cloneControllerSnapshot(source, target, { platform: 'linux', execute });
  assert.equal(await readFile(target, 'utf8'), 'stopped');
  await assert.rejects(cloneControllerSnapshot(source, target, { platform: 'linux', execute }), /already exists/);
  assert.equal(calls, 1);
});

test('spawn failure is safe to reject; failures after spawn are uncertain', async t => {
  const root = await temporary(t);
  const launch = failBeforeSpawn => () => {
    const child = new EventEmitter(); child.pid = process.pid;
    child.unref = () => { throw new Error('after spawn'); };
    queueMicrotask(() => child.emit(failBeforeSpawn ? 'error' : 'spawn', new Error('cannot spawn')));
    return child;
  };
  await assert.rejects(handleControllerRequest(request('spawn-failure'), { root, probe: ready, launch: launch(true) }), error => error.rejected === true);
  await assert.rejects(handleControllerRequest(request('already-spawned'), { root, probe: ready, launch: launch(false) }), error => error.rejected !== true);
  const read = id => readFile(path.join(root, 'runtime/distribution/jobs', id, 'receipt.json'), 'utf8').then(JSON.parse);
  assert.equal((await read('spawn-failure')).phase, 'rejected');
  assert.equal((await read('already-spawned')).phase, 'accepted');
});

test('artifact inputs are verified and installed before remote execution', async t => {
  const root = await temporary(t); const bytes = Buffer.from('auditor input from another VM');
  const sha = createHash('sha256').update(bytes).digest('hex');
  for (const valid of [true, false]) {
    const work = request(valid ? 'artifact-valid' : 'artifact-invalid');
    work.stateKey = work.id;
    work.tasks[0].artifactCapture = true;
    work.artifactInputs = [{ digest: sha, base64: (valid ? bytes : Buffer.from('wrong bytes')).toString('base64') }];
    const job = path.join(root, 'runtime/distribution/jobs', work.id);
    await mkdir(job, { recursive: true }); await writeFile(path.join(job, 'request.json'), JSON.stringify(work));
    class Fleet {
      constructor(options) { assert.equal(valid, true, 'invalid transfer must fail before admission'); this.directory = options.stateDirectory; }
      async run(tasks) {
        assert.equal(tasks[0].artifactCapture, true);
        assert.deepEqual(await readFile(path.join(this.directory, 'artifacts', `sha256-${sha}`)), bytes);
        await writeFile(path.join(this.directory, 'alpha.rootfs.img'), 'stopped');
        return [{ agent: 'alpha', stopped: true, exitCode: 0 }];
      }
    }
    await runControllerJob(work.id, { root, Fleet, probe: ready, clone: copyFile });
    const receipt = JSON.parse(await readFile(path.join(job, 'receipt.json')));
    assert.equal(receipt.phase, valid ? 'completed' : 'rejected');
    assert.equal(receipt.admitted, valid);
    if (!valid) assert.match(receipt.error, /digest mismatch/);
  }
});

test('a prior family disk cannot disappear between rounds and become a fresh VM', async t => {
  const root = await temporary(t); const work = request('lost-disk'); work.generation = 1;
  const directory = path.join(root, 'vm/pockets/remote', work.stateKey);
  await mkdir(path.join(directory, '.checkpoints', 'previous-job'), { recursive: true });
  await writeFile(path.join(directory, '.checkpoints', 'previous-job', 'alpha.rootfs.img'), 'prior disk');
  await writeFile(path.join(directory, '.generation.json'), JSON.stringify({ generation: 1, lastDispatch: 'previous-job' }));
  const previous = request('previous-job');
  const previousJob = path.join(root, 'runtime/distribution/jobs', previous.id);
  await mkdir(previousJob, { recursive: true });
  await writeFile(path.join(previousJob, 'request.json'), JSON.stringify(previous));
  await writeFile(path.join(previousJob, 'receipt.json'), JSON.stringify({ id: previous.id, requestHash: digest(previous), phase: 'completed',
    generation: 1, stateDirectory: directory, checkpointDirectory: path.join(directory, '.checkpoints', previous.id),
    checkpointFiles: [{ name: 'alpha.rootfs.img', size: 10 }] }));
  const job = path.join(root, 'runtime/distribution/jobs', work.id);
  await mkdir(job, { recursive: true }); await writeFile(path.join(job, 'request.json'), JSON.stringify(work));
  class Fleet { constructor() { assert.fail('missing environment must not be recreated'); } }
  await runControllerJob(work.id, { root, Fleet, probe: ready });
  const receipt = JSON.parse(await readFile(path.join(job, 'receipt.json')));
  assert.equal(receipt.phase, 'rejected'); assert.equal(receipt.admitted, false);
  assert.match(receipt.error, /refusing a fresh substitute/);
});

test('native APFS snapshot clone preserves sparse data and refuses an existing target', { skip: process.platform !== 'darwin' }, async t => {
  const root = await temporary(t); const source = path.join(root, 'source.img'), target = path.join(root, 'copy.img');
  const file = await open(source, 'wx');
  await file.write(Buffer.from('tail'), 0, 4, 32 * 1024 ** 2); await file.close();
  await cloneControllerSnapshot(source, target);
  const metadata = await stat(target);
  assert.equal(metadata.size, 32 * 1024 ** 2 + 4); assert.ok(metadata.blocks * 512 < metadata.size / 2);
  assert.equal((await readFile(target)).subarray(-4).toString(), 'tail');
  await assert.rejects(cloneControllerSnapshot(source, target), /already exists/);
  await writeFile(source, 'changed source');
  assert.equal((await readFile(target)).subarray(-4).toString(), 'tail');
});

test('stdio worker binds a real subprocess validation refusal to the submitted request', async t => {
  const root = await temporary(t); const work = request('stdio-refusal'); work.tasks = [];
  const moduleUrl = new URL('../src/controller-worker.mjs', import.meta.url).href;
  const program = `import { runControllerStdio } from ${JSON.stringify(moduleUrl)}; await runControllerStdio({root:${JSON.stringify(root)}});`;
  const result = await runCaptured(process.execPath, ['--input-type=module', '-e', program], { input: JSON.stringify(work) });
  const response = JSON.parse(result.stdout);
  assert.equal(response.ok, false); assert.equal(response.admitted, false);
  assert.equal(response.id, work.id); assert.equal(response.requestHash, digest(work));
  assert.match(response.error, /1–16 tasks/);
});
