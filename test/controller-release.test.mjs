import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { handleControllerRequest, runControllerJob } from '../src/controller-worker.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const recipe = 'a'.repeat(64);
const ready = async () => ({ vmReady: true, backend: 'apple-vz-arm64', platform: 'darwin', architecture: 'arm64',
  guestArchitecture: 'aarch64', recipeSha256: recipe, freeMemoryBytes: 32 * 1024 ** 3, freeDiskBytes: 40 * 1024 ** 3 });
const makeRequest = (id, generation, agents = ['alpha']) => ({ protocol: 'ovm.controller/v1', op: 'run', id, stateKey: 'release-family', generation,
  recipeSha256: recipe, memoryMB: 512, cpuCount: 1, networkMode: 'nat', distributionMode: 'auto',
  tasks: agents.map(agentId => ({ agentId, command: `record ${id}` })) });
const releaseRequest = receipt => ({ protocol: 'ovm.controller/v1', op: 'release', id: receipt.id, requestHash: receipt.requestHash,
  checkpointAcknowledgement: { generation: receipt.generation, manifestSha256: hash(receipt.checkpointFiles) } });

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ovm-controller-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let executions = 0;
  class Fleet {
    constructor(options) { this.directory = options.stateDirectory; }
    async run(tasks) {
      executions++;
      for (const task of tasks) {
        await writeFile(path.join(this.directory, `${task.agentId}.rootfs.img`), `${task.agentId}:${task.command}`);
        await writeFile(path.join(this.directory, `${task.agentId}.rootfs.img.ovm-guest-v1.json`), JSON.stringify({ recipeSha256: recipe, agent: task.agentId }));
      }
      return tasks.map(task => ({ agent: task.agentId, stopped: true, exitCode: 0 }));
    }
  }
  const jobDirectory = id => path.join(root, 'runtime/distribution/jobs', id);
  const run = async work => {
    const job = jobDirectory(work.id);
    await mkdir(job, { recursive: true });
    await writeFile(path.join(job, 'request.json'), JSON.stringify(work));
    await runControllerJob(work.id, { root, Fleet, probe: ready, clone: copyFile });
    return JSON.parse(await readFile(path.join(job, 'receipt.json'), 'utf8'));
  };
  const release = receipt => handleControllerRequest(releaseRequest(receipt), { root });
  const status = receipt => handleControllerRequest({ protocol: 'ovm.controller/v1', op: 'status', id: receipt.id, requestHash: receipt.requestHash }, { root });
  return { root, run, release, status, jobDirectory, executions: () => executions };
}

test('released snapshots preserve live family generations, inactive disks, and durable job evidence', async t => {
  const context = await fixture(t);
  const first = await context.run(makeRequest('release-first', 0, ['alpha', 'beta']));
  assert.equal(first.phase, 'completed');
  assert.equal(first.generation, 1);
  const liveBeta = path.join(first.stateDirectory, 'beta.rootfs.img');
  const betaBytes = await readFile(liveBeta);
  const metadataBytes = await readFile(`${liveBeta}.ovm-guest-v1.json`);
  const stateBytes = await readFile(path.join(first.stateDirectory, '.generation.json'));
  const unrelated = path.join(first.stateDirectory, '.checkpoints', 'not-released');
  await mkdir(unrelated);
  await writeFile(path.join(unrelated, 'retained.txt'), 'another retained snapshot');

  assert.equal((await context.release(first)).released, true);
  for (const file of first.checkpointFiles) assert.equal(existsSync(path.join(first.checkpointDirectory, file.name)), false);
  assert.deepEqual(JSON.parse(await readFile(path.join(first.checkpointDirectory, '.generation.json'))), { generation: 1, lastDispatch: first.id });
  assert.deepEqual(await readFile(liveBeta), betaBytes);
  assert.deepEqual(await readFile(`${liveBeta}.ovm-guest-v1.json`), metadataBytes);
  assert.deepEqual(await readFile(path.join(first.stateDirectory, '.generation.json')), stateBytes);
  const retainedReceipt = JSON.parse(await readFile(path.join(context.jobDirectory(first.id), 'receipt.json')));
  for (const key of ['phase', 'id', 'requestHash', 'generation', 'checkpointFiles', 'workers']) assert.deepEqual(retainedReceipt[key], first[key]);
  assert.equal(await readFile(path.join(unrelated, 'retained.txt'), 'utf8'), 'another retained snapshot');
  const releasedStatus = await context.status(first);
  assert.equal(releasedStatus.phase, 'completed');
  assert.equal(releasedStatus.generation, 1);
  assert.equal(releasedStatus.checkpointAvailable, false);
  assert.equal(releasedStatus.checkpointReleased, true);
  assert.deepEqual(releasedStatus.checkpointFiles, first.checkpointFiles);
  assert.equal((await context.release(first)).released, true, 'release acknowledgement can be retried');

  const second = await context.run(makeRequest('release-second', 1));
  assert.equal(second.phase, 'completed', second.error);
  assert.equal(second.generation, 2);
  assert.equal(context.executions(), 2);
  assert.deepEqual(await readFile(liveBeta), betaBytes);
  assert.ok(second.checkpointFiles.some(file => file.name === 'beta.rootfs.img'), 'inactive family member remains in the next checkpoint');
  assert.ok(second.checkpointFiles.some(file => file.name === 'beta.rootfs.img.ovm-guest-v1.json'));
  await context.release(second);
  const secondState = await readFile(path.join(second.stateDirectory, '.generation.json'));
  await context.release(first);
  assert.deepEqual(await readFile(path.join(second.stateDirectory, '.generation.json')), secondState, 'late release of an older generation cannot rewind the family');

  await rm(liveBeta);
  const lost = await context.run(makeRequest('release-lost-beta', 2));
  assert.equal(lost.phase, 'rejected');
  assert.equal(lost.admitted, false);
  assert.match(lost.error, /beta.*(?:absent|invalid)|refusing a fresh substitute/);
  assert.equal(context.executions(), 2, 'lost inactive disk is rejected before fleet execution');
  assert.deepEqual(await readFile(path.join(second.stateDirectory, '.generation.json')), secondState);
});

test('snapshot deletion requires matching durable checkpoint acknowledgement', async t => {
  const context = await fixture(t);
  const first = await context.run(makeRequest('ack-first', 0));
  const valid = releaseRequest(first);
  for (const invalid of [
    { ...valid, checkpointAcknowledgement: undefined },
    { ...valid, checkpointAcknowledgement: { ...valid.checkpointAcknowledgement, generation: 2 } },
    { ...valid, checkpointAcknowledgement: { ...valid.checkpointAcknowledgement, manifestSha256: 'f'.repeat(64) } },
    { ...valid, requestHash: 'f'.repeat(64) },
  ]) {
    await assert.rejects(handleControllerRequest(invalid, { root: context.root }));
    assert.equal(existsSync(path.join(first.checkpointDirectory, 'alpha.rootfs.img')), true);
    assert.equal(existsSync(path.join(context.jobDirectory(first.id), 'release.json')), false);
  }
  const second = await context.run(makeRequest('ack-second', 1));
  assert.equal(second.phase, 'completed', second.error);
  assert.equal(existsSync(path.join(first.checkpointDirectory, 'alpha.rootfs.img')), true, 'a newer generation does not implicitly release an unacknowledged snapshot');
  await context.release(second);
  assert.equal(existsSync(first.checkpointDirectory), true, 'releasing one generation preserves every unacknowledged predecessor');
});

test('release refuses a symlink in the checkpoint manifest and preserves its target', async t => {
  const context = await fixture(t);
  const completed = await context.run(makeRequest('symlink-snapshot', 0));
  const member = path.join(completed.checkpointDirectory, 'alpha.rootfs.img');
  const outside = path.join(context.root, 'retained-external-file');
  await writeFile(outside, 'preserve outside data');
  await rm(member);
  await symlink(outside, member);
  await assert.rejects(context.release(completed));
  assert.equal((await lstat(member)).isSymbolicLink(), true);
  assert.equal(await readFile(outside, 'utf8'), 'preserve outside data');
  assert.equal(existsSync(path.join(context.jobDirectory(completed.id), 'release.json')), false);
});

test('an interrupted acknowledged release resumes cleanup without advertising partial payload as recoverable', async t => {
  const context = await fixture(t);
  const completed = await context.run(makeRequest('interrupted-release', 0, ['alpha', 'beta']));
  const acknowledgement = releaseRequest(completed).checkpointAcknowledgement;
  await writeFile(path.join(context.jobDirectory(completed.id), 'release.json'), JSON.stringify({
    requestHash: completed.requestHash, ...acknowledgement, phase: 'releasing',
  }));
  await rm(path.join(completed.checkpointDirectory, 'alpha.rootfs.img'));
  const pending = await context.status(completed);
  assert.equal(pending.phase, 'completed');
  assert.equal(pending.checkpointAvailable, false);
  assert.equal(pending.checkpointReleased, false);
  assert.equal(pending.checkpointReleasePending, true);
  assert.equal((await context.release(completed)).released, true);
  for (const file of completed.checkpointFiles) {
    assert.equal(existsSync(path.join(completed.checkpointDirectory, file.name)), false);
    assert.equal(existsSync(path.join(completed.stateDirectory, file.name)), true);
  }
  const released = await context.status(completed);
  assert.equal(released.checkpointReleased, true);
  assert.equal(released.checkpointReleasePending, false);
  assert.equal(context.executions(), 1);
});
