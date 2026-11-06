import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { controllerDiskBudget } from '../src/controller-disk.mjs';
import { handleControllerRequest, runControllerJob } from '../src/controller-worker.mjs';
import { DistributedFleet } from '../src/distributed-fleet.mjs';

const GiB = 1024 ** 3;
const recipe = 'a'.repeat(64);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const probe = (disks = [], overrides = {}) => ({ platform: 'linux', architecture: 'x64', backend: 'qemu-arm64', guestArchitecture: 'aarch64',
  vmReady: true, recipeSha256: recipe, freeMemoryBytes: 32 * GiB, freeDiskBytes: 40 * GiB,
  baseRootfsAllocatedBytes: 8 * GiB, baseRootfsBytes: 24 * GiB, minimumFreeDiskBytesPerGuest: 17 * GiB,
  state: { generation: 1, files: disks.map(file => file.name), disks }, ...overrides });
const disk = (id, allocatedGiB, logicalGiB = 24) => ({ name: `${id}.rootfs.img`, size: logicalGiB * GiB, allocatedBytes: allocatedGiB * GiB });
const task = (agentId = 'alpha', additional = {}) => ({ agentId, command: 'observe persistent state', ...additional });
const request = (id, tasks = [task()]) => ({ protocol: 'ovm.controller/v1', op: 'run', id, stateKey: 'disk-family', generation: 1,
  recipeSha256: recipe, memoryMB: 512, cpuCount: 1, networkMode: 'nat', distributionMode: 'required', backend: 'qemu', tasks });

test('Linux disk budget includes every family snapshot while charging only new live roots twice', () => {
  const family = probe([disk('alpha', 8), disk('beta', 10), disk('gamma', 12)]);
  const existing = controllerDiskBudget(family, [task()]);
  assert.equal(existing.existingSnapshotBytes, 30 * GiB);
  assert.equal(existing.newRootBytes, 0);
  assert.equal(existing.requiredBytes, 31 * GiB, 'one active task still snapshots the entire 30 GiB family');
  const fresh = controllerDiskBudget(probe(), [task()]);
  assert.equal(fresh.requiredBytes, 17 * GiB, 'a new 8 GiB root needs a live copy, stopped copy, and safety margin');
  const resumed = controllerDiskBudget(probe([disk('alpha', 11)], { baseRootfsAllocatedBytes: 11 * GiB, minimumFreeDiskBytesPerGuest: 23 * GiB }), [task()]);
  assert.equal(resumed.requiredBytes, 12 * GiB, 'the existing live root already occupies disk and is not allocated again');
});

test('new children reserve two copies of the actual parent allocation', () => {
  const availability = probe([disk('parent', 11)]);
  const child = controllerDiskBudget(availability, [task('child', { parentId: 'parent' })]);
  assert.equal(child.existingSnapshotBytes, 11 * GiB);
  assert.equal(child.newRootBytes, 11 * GiB);
  assert.equal(child.requiredBytes, 34 * GiB, '11 GiB parent snapshot plus live/stopped child copies and safety');
  const grandchildren = controllerDiskBudget(availability, [task('child', { parentId: 'parent' }), task('grandchild', { parentId: 'child' })]);
  assert.equal(grandchildren.newRootBytes, 22 * GiB);
  assert.equal(grandchildren.requiredBytes, 57 * GiB);
});

test('missing allocation metadata uses logical sizes and unknown capacity never becomes zero', () => {
  const logical = controllerDiskBudget(probe([{ name: 'alpha.rootfs.img', size: 24 * GiB }]), [task()]);
  assert.equal(logical.requiredBytes, 25 * GiB);
  const namesOnly = controllerDiskBudget(probe([], { state: { files: ['alpha.rootfs.img'] } }), [task()]);
  assert.equal(namesOnly.requiredBytes, 25 * GiB);
  const logicalBase = controllerDiskBudget(probe([], { baseRootfsAllocatedBytes: undefined }), [task()]);
  assert.equal(logicalBase.requiredBytes, 49 * GiB);
  const unknown = controllerDiskBudget(probe([], { baseRootfsAllocatedBytes: undefined, baseRootfsBytes: undefined, minimumFreeDiskBytesPerGuest: undefined }), [task()]);
  assert.equal(unknown.requiredBytes, Infinity);
  assert.equal(controllerDiskBudget(probe([disk('alpha', 8), disk('alpha', 8)]), [task()]).requiredBytes, Infinity);
  assert.equal(controllerDiskBudget(probe([disk('alpha', 0)], { baseRootfsAllocatedBytes: 0 }), [task()]).requiredBytes, 2 * GiB);
});

test('malformed logical base sizes cannot discount a known family or inherited root', () => {
  for (const baseRootfsBytes of [-1, NaN, Infinity, '24']) {
    const availability = probe([], { baseRootfsBytes, state: { files: ['alpha.rootfs.img'] } });
    assert.equal(controllerDiskBudget(availability, [task()]).requiredBytes, 9 * GiB, 'known root falls back to the valid 8 GiB allocation');
    assert.equal(controllerDiskBudget(availability, [task('child', { parentId: 'alpha' })]).requiredBytes, 25 * GiB, 'parent-sized live/stopped copies retain the valid allocation');
  }
  const invalidAllocation = probe([{ name: 'alpha.rootfs.img', size: 24 * GiB, allocatedBytes: -1 }]);
  assert.equal(controllerDiskBudget(invalidAllocation, [task()]).requiredBytes, 25 * GiB);
});

async function fixture(t, disks, overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ovm-controller-disk-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'vm/pockets/remote/disk-family');
  const snapshot = path.join(directory, '.checkpoints', 'previous-job');
  const previousJob = path.join(root, 'runtime/distribution/jobs/previous-job');
  await mkdir(snapshot, { recursive: true });
  await mkdir(previousJob, { recursive: true });
  const checkpointFiles = [];
  for (const entry of disks) {
    const file = path.join(directory, entry.name);
    await writeFile(file, `persistent:${entry.name}`);
    await copyFile(file, path.join(snapshot, entry.name));
    checkpointFiles.push({ name: entry.name, size: (await lstat(file)).size });
  }
  const previous = { ...request('previous-job', disks.map(entry => task(entry.name.replace(/\.rootfs\.img$/, '')))), generation: 0 };
  await writeFile(path.join(previousJob, 'request.json'), JSON.stringify(previous));
  await writeFile(path.join(previousJob, 'receipt.json'), JSON.stringify({ phase: 'completed', id: previous.id, requestHash: hash(previous),
    generation: 1, lastDispatch: previous.id, stateDirectory: directory, checkpointDirectory: snapshot, checkpointFiles,
    workers: previous.tasks.map(work => ({ agent: work.agentId, stopped: true, exitCode: 0 })) }));
  const state = { generation: 1, lastDispatch: previous.id };
  await writeFile(path.join(directory, '.generation.json'), JSON.stringify(state));
  await writeFile(path.join(snapshot, '.generation.json'), JSON.stringify(state));
  const availability = probe(disks, { root, ...overrides });
  const stateMetadata = async file => {
    const actual = await lstat(file);
    const entry = disks.find(item => item.name === path.basename(file));
    assert.ok(entry, `unexpected capacity stat: ${file}`);
    return { isFile: () => actual.isFile(), isSymbolicLink: () => actual.isSymbolicLink(), size: entry.size,
      blocks: entry.allocatedBytes === undefined ? undefined : entry.allocatedBytes / 512 };
  };
  const jobDirectory = id => path.join(root, 'runtime/distribution/jobs', id);
  const prepareJob = async work => {
    await mkdir(jobDirectory(work.id), { recursive: true });
    await writeFile(path.join(jobDirectory(work.id), 'request.json'), JSON.stringify(work));
  };
  const localDirectory = path.join(root, 'initiator');
  await mkdir(localDirectory);
  const peer = { name: 'rack', host: 'ustad@rack', root };
  const local = { memoryMB: 512, cpuCount: 1, networkMode: 'nat', rootfsPath: id => path.join(localDirectory, `${id}.rootfs.img`),
    run: async () => assert.fail('required remote placement cannot run locally') };
  const fleet = new DistributedFleet(local, { projectRoot: root, stateDirectory: localDirectory, mode: 'required', target: 'rack', backend: 'qemu', peers: [peer],
    guestStatus: async () => ({ prepared: true, verified: true, needsUpdate: false, profile: { recipeSha256: recipe } }),
    call: async (_peer, work) => { assert.equal(work.op, 'probe'); assert.equal(work.stateKey, 'disk-family'); return availability; } });
  await writeFile(fleet.journal, JSON.stringify({ kind: 'remote', backend: 'qemu', peer, stateKey: 'disk-family', generation: 1, recipeSha256: recipe, checkpointFiles }));
  return { root, directory, availability, stateMetadata, jobDirectory, prepareJob, fleet };
}

test('a 30 GiB family with one active task and 20 GiB free is refused before placement or launch', async t => {
  const context = await fixture(t, [disk('alpha', 8), disk('beta', 10), disk('gamma', 12)], { freeDiskBytes: 20 * GiB });
  await assert.rejects(context.fleet.choose([task()]), /No compatible remote/);
  await assert.rejects(handleControllerRequest(request('reject-before-launch'), {
    root: context.root, probe: async () => ({ ...context.availability }), stateMetadata: context.stateMetadata,
    launch: () => assert.fail('insufficient family snapshot space must reject before spawning'),
  }), error => error.rejected === true);
});

test('worker repeats the full-family disk check after acquiring its lease', async t => {
  const context = await fixture(t, [disk('alpha', 8), disk('beta', 10), disk('gamma', 12)]);
  const work = request('capacity-changed');
  let launches = 0;
  await handleControllerRequest(work, {
    root: context.root, probe: async () => ({ ...context.availability }), stateMetadata: context.stateMetadata,
    launch: () => { launches++; const child = new EventEmitter(); child.pid = process.pid; child.unref = () => {}; queueMicrotask(() => child.emit('spawn')); return child; },
  });
  assert.equal(launches, 1, 'initial 40 GiB check admits the request');
  await runControllerJob(work.id, { root: context.root, stateMetadata: context.stateMetadata,
    probe: async () => {
      const lease = JSON.parse(await readFile(path.join(context.directory, '.remote.lease'), 'utf8'));
      assert.equal(lease.pid, process.pid, 'the fresh capacity probe occurs while this worker owns the family lease');
      return { ...context.availability, freeDiskBytes: 20 * GiB };
    },
    createFleet: () => assert.fail('capacity loss must reject before fleet construction'),
  });
  const receipt = JSON.parse(await readFile(path.join(context.jobDirectory(work.id), 'receipt.json')));
  assert.equal(receipt.phase, 'rejected');
  assert.equal(receipt.admitted, false);
  assert.match(receipt.error, /resources changed before admission/);
  assert.equal(JSON.parse(await readFile(path.join(context.directory, '.generation.json'))).generation, 1);
});

test('an existing 11 GiB root can resume with 12 GiB free without allocating its live copy again', async t => {
  const context = await fixture(t, [disk('alpha', 11)], { baseRootfsAllocatedBytes: 11 * GiB, minimumFreeDiskBytesPerGuest: 23 * GiB, freeDiskBytes: 12 * GiB });
  assert.equal((await context.fleet.choose([task()])).kind, 'remote');
  const work = request('resume-with-room');
  await context.prepareJob(work);
  let runs = 0;
  await runControllerJob(work.id, { root: context.root, probe: async () => ({ ...context.availability }), stateMetadata: context.stateMetadata, clone: copyFile,
    createFleet: options => ({ run: async tasks => {
      runs++;
      assert.match(await readFile(path.join(options.stateDirectory, 'alpha.rootfs.img'), 'utf8'), /^persistent:/);
      return tasks.map(item => ({ agent: item.agentId, stopped: true, exitCode: 0 }));
    } }),
  });
  const receipt = JSON.parse(await readFile(path.join(context.jobDirectory(work.id), 'receipt.json')));
  assert.equal(receipt.phase, 'completed', receipt.error);
  assert.equal(receipt.generation, 2);
  assert.equal(runs, 1);
});

test('initiator maps inherited roots to the parent allocation when selecting a host', async t => {
  const context = await fixture(t, [disk('parent', 11)], { freeDiskBytes: 30 * GiB });
  const child = task('child', { inheritRootfs: context.fleet.rootfsPath('parent') });
  await assert.rejects(context.fleet.choose([child]), /No compatible remote/);
  context.availability.freeDiskBytes = 34 * GiB;
  assert.equal((await context.fleet.choose([child])).kind, 'remote');
  const work = request('child-under-budget', [task('child', { parentId: 'parent' })]);
  await assert.rejects(handleControllerRequest(work, { root: context.root, stateMetadata: context.stateMetadata,
    probe: async () => ({ ...context.availability, freeDiskBytes: 30 * GiB }), launch: () => assert.fail('new child requires two parent-sized copies'),
  }), error => error.rejected === true);
});
