import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentArtifactStore, buildCaptureTask, artifactInputs, installArtifactInputs, MAX_ARTIFACT_BYTES } from '../src/agent-artifacts.mjs';
import { runCaptured } from '../src/controller-transport.mjs';

const sha = data => createHash('sha256').update(data).digest('hex');
async function setup(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ovm-artifacts-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
async function capture(task) {
  const { stdout } = await runCaptured('/bin/sh', ['-c', task.command]);
  return { agent: task.agentId, exitCode: 0, stopped: true, output: stdout };
}

test('publication captures exact ordered bytes, immutable digest, producer and quoted source path', async t => {
  const directory = await setup(t), source = path.join(directory, 'history $HOME; "quotes".txt');
  const contents = 'ls\nzsh\nls\napt install zsh\nxeit\nexitx\nexit\n';
  await writeFile(source, contents);
  const store = new AgentArtifactStore({ stateDirectory: directory, swarmId: 'family' });
  const task = buildCaptureTask({ path: source, name: 'original history' }, { id: 'builder' }, { round: 2 });
  const receipt = await store.acceptCapture(task, await capture(task));
  assert.equal(receipt.sha256, sha(contents)); assert.equal(receipt.producer, 'builder');
  assert.equal(receipt.semanticVerification, false);
  assert.equal(await readFile(path.join(directory, 'artifacts', path.basename(receipt.guestPath)), 'utf8'), contents);
  await writeFile(source, 'A different later file\n');
  assert.equal(await readFile(path.join(directory, 'artifacts', path.basename(receipt.guestPath)), 'utf8'), contents);
  assert.equal((await store.list()).length, 1);
});

test('missing file, symlink, oversized file and failed capture produce no artifact claim', async t => {
  const directory = await setup(t), source = path.join(directory, 'large'), link = path.join(directory, 'link');
  await writeFile(source, Buffer.alloc(MAX_ARTIFACT_BYTES + 1, 65)); await symlink(source, link);
  const store = new AgentArtifactStore({ stateDirectory: directory, swarmId: 'family' });
  for (const file of [source, link, path.join(directory, 'missing')]) {
    const task = buildCaptureTask({ path: file, name: 'result' }, { id: 'builder' }, { round: 1 });
    await assert.rejects(capture(task));
    await assert.rejects(store.acceptCapture(task, { agent: 'builder', exitCode: 1, stopped: true, output: 'No such file' }), /publication failed/);
  }
  assert.deepEqual(await store.list(), []);
});

test('zero exit status with only a success notice is not an artifact receipt', async t => {
  const directory = await setup(t), store = new AgentArtifactStore({ stateDirectory: directory });
  const task = buildCaptureTask({ path: '/root/output.log', name: 'result' }, { id: 'scout' }, { round: 8 });
  await assert.rejects(store.acceptCapture(task, { agent: 'scout', exitCode: 0, stopped: true, output: 'Parsed log written to /root/terminal_history_parsed.log\n' }), /no unique complete receipt/);
  await assert.rejects(store.acceptCapture(task, { agent: 'scout', exitCode: 0, stopped: true, output: task.artifactPublication.token + JSON.stringify({ schema: 'ovm.artifact-capture/v1', sha256: 'a'.repeat(64), bytes: 7, base64: Buffer.from('MISSING').toString('base64') }) }), /digest/);
});

test('remote artifact transfer preserves bytes and validates complete input before installation', async t => {
  const directory = await setup(t), a = path.join(directory, 'a'), b = path.join(directory, 'b');
  const contents = Buffer.from('exact deliverable\n');
  const inputs = [{ digest: sha(contents), base64: contents.toString('base64') }];
  await installArtifactInputs(a, inputs);
  assert.deepEqual(await artifactInputs(a), inputs);
  await installArtifactInputs(b, await artifactInputs(a));
  assert.deepEqual(await readFile(path.join(b, 'sha256-' + sha(contents))), contents);
  await assert.rejects(installArtifactInputs(path.join(directory, 'bad'), [...inputs, { digest: '0'.repeat(64), base64: 'eA==' }]), /digest/);
  assert.deepEqual(await artifactInputs(path.join(directory, 'bad')), []);
  await assert.rejects(installArtifactInputs(b, [...inputs, ...inputs]), /Invalid artifact input/);
});
