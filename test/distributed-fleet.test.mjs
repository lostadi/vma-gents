import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DistributedFleet, DistributionUncertainError } from '../src/distributed-fleet.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const recipe = 'a'.repeat(64);
const peer = { name: 'other-mac', host: 'ustad@other-mac', root: '/remote/ovm' };
const remote = { root: peer.root, vmReady: true, backend: 'apple-vz-arm64', platform: 'darwin', architecture: 'arm64', recipeSha256: recipe, freeMemoryBytes: 32 * 1024 ** 3, freeDiskBytes: 40 * 1024 ** 3 };
const tasks = [{ agentId: 'alpha', command: 'echo once' }];

async function fixture(t, additions = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ovm-distributed-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDirectory = path.join(root, 'state'); await mkdir(stateDirectory);
  const localCalls = [];
  const local = { memoryMB: 512, cpuCount: 1, networkMode: 'nat',
    rootfsPath: id => path.join(stateDirectory, `${id}.rootfs.img`), probe: async () => ({ available: true }),
    run: async work => { localCalls.push(work); return work.map(task => ({ agent: task.agentId, stopped: true, exitCode: 0 })); } };
  const fleet = new DistributedFleet(local, { projectRoot: root, stateDirectory, peers: [peer], mode: 'auto', freeMemory: () => 0,
    rsync: async () => ({ path: 'rsync', modern: false }),
    guestStatus: async () => ({ prepared: true, verified: true, needsUpdate: false, profile: { recipeSha256: recipe } }),
    pollMilliseconds: 1, remoteTimeout: 30, ...additions });
  return { root, stateDirectory, local, localCalls, fleet };
}

function completed(request) {
  const stateDirectory = path.join(peer.root, 'vm/pockets/remote', request.stateKey);
  return { id: request.id, requestHash: hash(request), phase: 'completed', admitted: true, generation: request.generation + 1,
    stateDirectory, checkpointDirectory: path.join(stateDirectory, '.checkpoints', request.id),
    checkpointFiles: [{ name: 'alpha.rootfs.img', size: 8 }], workers: [{ agent: 'alpha', stopped: true, exitCode: 0 }] };
}

test('auto prefers available local memory without contacting remote controllers', async t => {
  const { fleet, localCalls } = await fixture(t, { freeMemory: () => 32 * 1024 ** 3, call: async () => assert.fail('remote probe unnecessary') });
  await fleet.run(tasks); assert.equal(localCalls.length, 1);
});

test('auto local preparation survives absent remote prerequisites and respects its selected bundle', async t => {
  const absent = await fixture(t, { peers: [], guestStatus: async () => assert.fail('no remote candidates require no remote profile gate') });
  await absent.fleet.run(tasks); assert.equal(absent.localCalls.length, 1);
  const stale = await fixture(t, { guestStatus: async () => ({ prepared: false }) });
  await stale.fleet.run(tasks); assert.equal(stale.localCalls.length, 1);
  const selected = await fixture(t, { guestStatus: async options => {
    assert.equal(options.bundlePath, '/selected/imported.bundle');
    throw new Error('profile needs local preparation');
  } });
  selected.local.bundlePath = '/selected/imported.bundle';
  await selected.fleet.run(tasks); assert.equal(selected.localCalls.length, 1);
});

test('required placement never silently runs existing local state', async t => {
  const { fleet, local, localCalls } = await fixture(t, { mode: 'required', call: async () => assert.fail('existing family cannot be replaced') });
  await writeFile(local.rootfsPath('alpha'), 'user work');
  await assert.rejects(fleet.run(tasks), /local VM state/); assert.equal(localCalls.length, 0);
});

test('known pre-admission refusal falls back locally, uncertain dispatch never does', async t => {
  const rejected = await fixture(t, { call: async (_peer, request) => {
    if (request.op === 'probe') return remote;
    const error = new Error('capacity changed'); error.rejected = true; throw error;
  } });
  await rejected.fleet.run(tasks); assert.equal(rejected.localCalls.length, 1);
  let submitted; let executions = 0;
  const uncertain = await fixture(t, { call: async (_peer, request) => {
    if (request.op === 'probe') return remote;
    if (request.op === 'run') { submitted = request; executions += 1; throw new Error('SSH dropped after send'); }
    return { id: submitted.id, requestHash: hash(submitted), phase: 'running', admitted: true, ownerAlive: false };
  } });
  await assert.rejects(uncertain.fleet.run(tasks), DistributionUncertainError);
  await assert.rejects(uncertain.fleet.run(tasks), /awaiting reconciliation/);
  assert.equal(executions, 1); assert.equal(uncertain.localCalls.length, 0);
  assert.equal(existsSync(uncertain.fleet.pendingFile), true);
});

test('the production deadline accommodates Linux clone and boot time beyond three minutes without replay', async t => {
  let clock = Date.now(); let submitted; let submissions = 0; let statuses = 0;
  t.mock.method(Date, 'now', () => clock);
  const { fleet, localCalls } = await fixture(t, {
    remoteTimeout: undefined, pollMilliseconds: 0,
    call: async (_peer, request) => {
      if (request.op === 'probe') return remote;
      if (request.op === 'run') { submissions += 1; submitted = request; return { id: request.id, requestHash: hash(request) }; }
      if (request.op === 'release') return { released: true };
      statuses += 1;
      if (statuses === 1) {
        clock += 4 * 60_000;
        return { id: submitted.id, requestHash: hash(submitted), phase: 'running', admitted: true, ownerAlive: true };
      }
      return completed(submitted);
    },
    execute: async (_command, args) => {
      await writeFile(path.join(args.at(-1), 'alpha.rootfs.img'), 'new disk');
      await writeFile(path.join(args.at(-1), '.generation.json'), JSON.stringify({ generation: 1, lastDispatch: submitted.id }));
      return { stdout: '', stderr: '' };
    },
  });
  const workers = await fleet.run(tasks);
  assert.equal(workers[0].stopped, true); assert.equal(statuses, 2);
  assert.equal(submissions, 1); assert.equal(localCalls.length, 0);
  let pendingRequest; let pendingSubmissions = 0;
  const overdue = await fixture(t, {
    remoteTimeout: undefined, pollMilliseconds: 0,
    call: async (_peer, request) => {
      if (request.op === 'probe') return remote;
      if (request.op === 'run') { pendingSubmissions += 1; pendingRequest = request; return { id: request.id, requestHash: hash(request) }; }
      clock += 31 * 60_000;
      return { id: pendingRequest.id, requestHash: hash(pendingRequest), phase: 'running', admitted: true, ownerAlive: true };
    },
  });
  await assert.rejects(overdue.fleet.run(tasks), error => error.uncertain === true && /nothing was replayed/.test(error.message));
  assert.equal(pendingSubmissions, 1); assert.equal(overdue.localCalls.length, 0);
  assert.ok(existsSync(overdue.fleet.pendingFile), 'deadline preserves recovery of the original remote job');
});

test('stopped snapshots checkpoint durably until higher-level acknowledgement', async t => {
  let submitted; let executions = 0; let transfers = 0;
  const { fleet, localCalls, local } = await fixture(t, {
    call: async (_peer, request) => {
      if (request.op === 'probe') return remote;
      if (request.op === 'run') { submitted = request; executions += 1; return { id: request.id, requestHash: hash(request), phase: 'accepted' }; }
      if (request.op === 'release') {
        const saved = JSON.parse(await readFile(fleet.completedFile, 'utf8'));
        assert.equal(saved.dispatchId, submitted.id, 'completion precedes permission to delete the remote payload');
        assert.deepEqual(request.checkpointAcknowledgement, { generation: 1, manifestSha256: hash(completed(submitted).checkpointFiles) });
        assert.equal(await readFile(local.rootfsPath('alpha'), 'utf8'), 'new disk');
        return { released: true };
      }
      return completed(submitted);
    },
    execute: async (command, args) => {
      transfers += 1; assert.equal(command, 'rsync'); assert.ok(args.includes('--protocol=29')); assert.ok(args.includes('-aS'));
      const stage = args.at(-1); await writeFile(path.join(stage, 'alpha.rootfs.img'), 'new disk');
      await writeFile(path.join(stage, '.generation.json'), JSON.stringify({ generation: 1, lastDispatch: submitted.id }));
      return { stdout: '', stderr: '' };
    },
  });
  const workers = await fleet.run(tasks);
  assert.equal(await readFile(local.rootfsPath('alpha'), 'utf8'), 'new disk');
  assert.equal(existsSync(fleet.pendingFile), false); assert.equal(existsSync(fleet.completedFile), true);
  const recovered = await fleet.recover();
  assert.deepEqual(recovered.workers, workers); assert.deepEqual(recovered.tasks, tasks);
  assert.equal(executions, 1); assert.equal(transfers, 1); assert.equal(localCalls.length, 0);
  await assert.rejects(fleet.run(tasks), /awaiting reconciliation/);
  await fleet.acknowledge(recovered.dispatchId); assert.equal(await fleet.recover(), null);
});

test('a crash after release recovers the durable completion before a leftover pending record', async t => {
  let submitted, pending; let transfers = 0; let releases = 0; let statuses = 0;
  const { fleet } = await fixture(t, {
    call: async (_peer, request) => {
      if (request.op === 'probe') return remote;
      if (request.op === 'run') { submitted = request; return { id: request.id, requestHash: hash(request) }; }
      if (request.op === 'release') {
        releases += 1;
        if (releases === 1) { pending = await readFile(fleet.pendingFile); throw new Error('release succeeded but its acknowledgement was lost'); }
        return { released: true };
      }
      statuses += 1;
      return { ...completed(submitted), checkpointAvailable: releases === 0, checkpointReleased: releases > 0 };
    },
    execute: async (_command, args) => {
      transfers += 1;
      await writeFile(path.join(args.at(-1), 'alpha.rootfs.img'), 'new disk');
      await writeFile(path.join(args.at(-1), '.generation.json'), JSON.stringify({ generation: 1, lastDispatch: submitted.id }));
      return { stdout: '', stderr: '' };
    },
  });
  const workers = await fleet.run(tasks);
  await writeFile(fleet.pendingFile, pending); // Crash between remote release and pending-file removal.
  const recovered = await fleet.recover();
  assert.deepEqual(recovered.workers, workers);
  assert.equal(transfers, 1); assert.equal(statuses, 1); assert.equal(releases, 2);
  assert.equal(existsSync(fleet.pendingFile), false);
  await fleet.acknowledge(recovered.dispatchId);
  assert.equal(await fleet.recover(), null);
});

test('a failed payload release stays retryable after the agent acknowledges its saved turn', async t => {
  let submitted; let reachable = false; let releaseCalls = 0;
  const { fleet } = await fixture(t, {
    call: async (_peer, request) => {
      if (request.op === 'probe') return remote;
      if (request.op === 'run') { submitted = request; return { id: request.id, requestHash: hash(request) }; }
      if (request.op === 'release') { releaseCalls += 1; if (!reachable) throw new Error('offline'); return { released: true }; }
      return completed(submitted);
    },
    execute: async (_command, args) => {
      await writeFile(path.join(args.at(-1), 'alpha.rootfs.img'), 'new disk');
      await writeFile(path.join(args.at(-1), '.generation.json'), JSON.stringify({ generation: 1, lastDispatch: submitted.id }));
      return { stdout: '', stderr: '' };
    },
  });
  await fleet.run(tasks);
  await fleet.acknowledge(submitted.id);
  const queued = path.join(fleet.releaseDirectory, `${submitted.id}.json`);
  assert.ok(existsSync(queued)); assert.equal(existsSync(fleet.completedFile), false);
  reachable = true;
  assert.equal(await fleet.recover(), null);
  assert.equal(existsSync(queued), false); assert.equal(releaseCalls, 3);
});

test('released remote payload without a local completion is uncertain and never substituted', async t => {
  let submitted;
  const { fleet, localCalls } = await fixture(t, {
    call: async (_peer, request) => {
      if (request.op === 'probe') return remote;
      if (request.op === 'run') { submitted = request; return { id: request.id, requestHash: hash(request) }; }
      return { ...completed(submitted), checkpointAvailable: false, checkpointReleased: true };
    }, execute: async () => assert.fail('released payload is unavailable'),
  });
  await assert.rejects(fleet.run(tasks), error => error.uncertain === true && /released/.test(error.message));
  assert.equal(localCalls.length, 0); assert.ok(existsSync(fleet.pendingFile));
});

test('reused remote placements require fresh capability and generation proof', async t => {
  let probed = 0;
  const { fleet, localCalls } = await fixture(t, { mode: 'required', call: async (_peer, request) => { probed += 1; assert.equal(request.stateKey, 'saved-family'); return { ...remote, state: { generation: 2, files: ['alpha.rootfs.img'] } }; } });
  await writeFile(fleet.journal, JSON.stringify({ kind: 'remote', peer, stateKey: 'saved-family', generation: 1, recipeSha256: recipe }));
  await assert.rejects(fleet.run(tasks), /No compatible remote/); assert.equal(probed, 1); assert.equal(localCalls.length, 0);
});

test('ARM64 guest families may select Linux QEMU with explicit backend and exact recipe', async t => {
  const qemu = { ...remote, backend: 'qemu-arm64', platform: 'linux', architecture: 'x64', guestArchitecture: 'aarch64', minimumFreeDiskBytesPerGuest: 17 * 1024 ** 3 };
  const { fleet } = await fixture(t, { backend: 'qemu', target: peer.name, call: async (_peer, request) => {
    assert.equal(request.backend, 'qemu'); return qemu;
  } });
  const placement = await fleet.choose(tasks);
  assert.equal(placement.kind, 'remote'); assert.equal(placement.backend, 'qemu');
  for (const proof of [{ guestArchitecture: 'x86_64' }, { recipeSha256: 'b'.repeat(64) }, { minimumFreeDiskBytesPerGuest: 50 * 1024 ** 3 }]) {
    fleet.call = async () => ({ ...qemu, ...proof });
    await assert.rejects(fleet.choose(tasks), /No compatible remote/);
  }
  fleet.call = async () => remote;
  await assert.rejects(fleet.choose(tasks), /No compatible remote/);
});

test('QEMU selection is retained between controller probe and execution', async t => {
  let submitted;
  const { fleet } = await fixture(t, { backend: 'qemu', target: peer.name, call: async (_peer, request) => {
    if (request.op === 'probe') return { ...remote, backend: 'qemu-arm64', platform: 'linux', architecture: 'x64', guestArchitecture: 'aarch64', minimumFreeDiskBytesPerGuest: 17 * 1024 ** 3 };
    if (request.op === 'run') { submitted = request; throw new Error('lost acknowledgement'); }
    return { id: submitted.id, requestHash: hash(submitted), phase: 'running', ownerAlive: false };
  } });
  await assert.rejects(fleet.run(tasks), DistributionUncertainError);
  assert.equal(submitted.backend, 'qemu');
  const pending = JSON.parse(await readFile(fleet.pendingFile, 'utf8'));
  assert.equal(pending.placement.backend, 'qemu');
});

test('a tampered completion never checkpoints or replays', async t => {
  let submitted;
  const { fleet, localCalls } = await fixture(t, { call: async (_peer, request) => {
    if (request.op === 'probe') return remote;
    if (request.op === 'run') { submitted = request; return { id: request.id, requestHash: hash(request) }; }
    return { ...completed(submitted), checkpointDirectory: '/remote/another-family' };
  }, execute: async () => assert.fail('invalid snapshot must not be transferred') });
  await assert.rejects(fleet.run(tasks), DistributionUncertainError); assert.equal(localCalls.length, 0); assert.ok(existsSync(fleet.pendingFile));
});

test('a later safe refusal becomes a durable recovery receipt without replay', async t => {
  let submitted; let reachable = false; let sends = 0;
  const { fleet, localCalls } = await fixture(t, { call: async (_peer, request) => {
    if (request.op === 'probe') return remote;
    if (request.op === 'run') { submitted = request; sends += 1; throw new Error('lost acknowledgement'); }
    if (!reachable) throw new Error('offline');
    return { id: submitted.id, requestHash: hash(submitted), phase: 'rejected', admitted: false, error: 'capacity changed' };
  } });
  await assert.rejects(fleet.run(tasks), DistributionUncertainError);
  reachable = true;
  const result = await fleet.recover();
  assert.equal(result.workers[0].executionStarted, false);
  assert.equal(result.workers[0].rejectedBeforeExecution, true);
  assert.equal(result.workers[0].placement.dispatchId, result.dispatchId);
  assert.deepEqual(await fleet.recover(), result);
  assert.equal(sends, 1); assert.equal(localCalls.length, 0);
  await fleet.acknowledge(result.dispatchId); assert.equal(await fleet.recover(), null);
});

test('interrupted checkpoint resumes the same stopped snapshot and preserves publication metadata', async t => {
  let submitted; let sends = 0; let transfers = 0; let transferAvailable = false;
  const { fleet, localCalls, stateDirectory } = await fixture(t, {
    call: async (_peer, request) => {
      if (request.op === 'probe') return remote;
      if (request.op === 'run') { submitted = request; sends += 1; return { id: request.id, requestHash: hash(request) }; }
      if (request.op === 'release') return { released: true };
      return completed(submitted);
    },
    execute: async (_command, args) => {
      transfers += 1;
      if (!transferAvailable) throw new Error('checkpoint transfer interrupted');
      const stage = args.at(-1); await writeFile(path.join(stage, 'alpha.rootfs.img'), 'new disk');
      await writeFile(path.join(stage, '.generation.json'), JSON.stringify({ generation: 1, lastDispatch: submitted.id }));
      return { stdout: '', stderr: '' };
    },
  });
  const bytes = Buffer.from('handoff bytes'); const sha = createHash('sha256').update(bytes).digest('hex');
  await mkdir(path.join(stateDirectory, 'artifacts'));
  await writeFile(path.join(stateDirectory, 'artifacts', `sha256-${sha}`), bytes);
  const publications = [{ ...tasks[0], artifactPublication: { name: 'result', token: 'private-capture-token' } }];
  await assert.rejects(fleet.run(publications), error => error instanceof DistributionUncertainError && /checkpoint could not be saved/.test(error.message));
  assert.equal(transfers, 1, 'a failed completed checkpoint is reported immediately instead of silently looping');
  assert.deepEqual(submitted.artifactInputs, [{ digest: sha, base64: bytes.toString('base64') }]);
  assert.equal(submitted.tasks[0].artifactCapture, true);
  assert.equal(submitted.tasks[0].artifactPublication, undefined);
  transferAvailable = true;
  const recovered = await fleet.recover();
  assert.deepEqual(recovered.tasks, publications);
  assert.equal(sends, 1); assert.ok(transfers >= 2); assert.equal(localCalls.length, 0);
});

test('modern peers negotiate their protocol and quote an independently validated remote rsync path', async t => {
  let submitted;
  const { fleet } = await fixture(t, {
    rsync: async () => ({ path: '/opt/homebrew/bin/rsync', modern: true, protocol: 33 }),
    call: async (_peer, request) => {
      if (request.op === 'probe') return { ...remote, rsyncPath: '/opt/quoted tools/rsync', rsyncProtocol: 33 };
      if (request.op === 'run') { submitted = request; return { id: request.id, requestHash: hash(request) }; }
      if (request.op === 'release') return { released: true };
      return completed(submitted);
    },
    execute: async (command, args) => {
      assert.equal(command, '/opt/homebrew/bin/rsync'); assert.equal(args.includes('--protocol=29'), false);
      assert.ok(args.includes("--rsync-path='/opt/quoted tools/rsync'"));
      await writeFile(path.join(args.at(-1), 'alpha.rootfs.img'), 'new disk');
      await writeFile(path.join(args.at(-1), '.generation.json'), JSON.stringify({ generation: 1, lastDispatch: submitted.id }));
      return { stdout: '', stderr: '' };
    },
  });
  await fleet.run(tasks);
  const invalid = await fixture(t, { call: async () => ({ ...remote, rsyncPath: '/bin/rsync\nmalformed' }) });
  await assert.rejects(invalid.fleet.run(tasks), /invalid rsync path/);
});
