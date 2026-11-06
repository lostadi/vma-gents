import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentArtifactStore, artifactInputs } from '../src/agent-artifacts.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const source = 'python^(\n__oval_result__ = "café ☀"\n)_python\n\n';
const checks = [{ kind: 'stdout_contains', expected: 'café ☀' }];
function inputs(overrides = {}) {
  const task = { agentId: 'builder', ostadix: { source, sourceSha256: sha(source), mode: 'run', name: 'Unicode result', checks: structuredClone(checks), round: 2, ...overrides } };
  const execution = { mode: 'run', success: true, executed: true, checkStatus: 'checks-passed', sourceSha256: task.ostadix.sourceSha256,
    checks: task.ostadix.checks.map(check => ({ ...check, passed: true })) };
  return { task, execution, context: { evidenceId: 'family:builder:2:ostadix:0', instanceId: 'instance-one' } };
}
async function setup(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ovm-ostadix-artifacts-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, store: new AgentArtifactStore({ stateDirectory: directory, swarmId: 'family' }) };
}
async function publish(store, supplied = inputs()) {
  return store.publishOstadix(supplied.task, supplied.execution, supplied.context);
}
async function replaceIndex(directory, artifacts) {
  await writeFile(path.join(directory, 'artifacts/index.json'), JSON.stringify({ schema: 'ovm.artifacts/v1', artifacts }));
}
function recomputeId(artifact) {
  return 'ostadix:' + sha(JSON.stringify({ schema: 'ovm.ostadix-artifact-contract/v1', sourceSha256: artifact.sha256,
    checks: artifact.code.contract.checks, producer: artifact.producer, round: artifact.round,
    instanceId: artifact.code.producerInstanceId, evidenceId: artifact.code.executionEvidenceId,
    name: artifact.name, swarmId: artifact.swarmId }));
}

test('checked O source round trips byte-for-byte with immutable review contract and provenance', async t => {
  const { directory, store } = await setup(t), supplied = inputs();
  const receipt = await publish(store, supplied);
  assert.match(receipt.id, /^ostadix:[a-f0-9]{64}$/);
  assert.equal(receipt.sourcePath, null);
  assert.equal(receipt.kind, 'ostadix-program');
  assert.equal(receipt.claimStatus, 'awaiting-peer-review');
  assert.equal(receipt.semanticVerification, false);
  assert.equal(receipt.code.executionEvidenceId, supplied.context.evidenceId);
  assert.equal(receipt.code.producerInstanceId, supplied.context.instanceId);
  assert.equal(receipt.bytes, Buffer.byteLength(source));
  const loaded = await store.readOstadixArtifact(receipt.id);
  assert.equal(loaded.source, source);
  assert.deepEqual(loaded.action, { type: 'ostadix', source, name: 'Unicode result', mode: 'run', checks });
  assert.deepEqual(await readFile(path.join(directory, 'artifacts', path.basename(receipt.guestPath))), Buffer.from(source));
  supplied.task.ostadix.source = 'mutated after publication';
  supplied.task.ostadix.checks[0].expected = 'mutated';
  assert.equal((await store.readOstadixArtifact(receipt.id)).source, source);
  assert.deepEqual((await store.readOstadixArtifact(receipt.id)).action.checks, checks);
  assert.deepEqual(await publish(store), receipt);
  assert.equal((await store.list()).length, 1);
  assert.equal((await artifactInputs(path.join(directory, 'artifacts'))).length, 1);
});

test('publication rejects unexecuted, unsuccessful, mismatched and unchecked claims before writing', async t => {
  const { store } = await setup(t);
  const mutations = [
    item => { item.execution.executed = false; },
    item => { item.execution.success = false; },
    item => { item.execution.checkStatus = 'static-check-passed'; },
    item => { item.execution.mode = 'check'; },
    item => { item.task.ostadix.mode = 'check'; },
    item => { item.execution.sourceSha256 = 'a'.repeat(64); },
    item => { item.task.ostadix.sourceSha256 = 'b'.repeat(64); },
    item => { item.execution.checks[0].passed = false; },
    item => { item.execution.checks[0].expected = 'a different claim'; },
    item => { item.execution.checks = []; },
    item => { item.task.ostadix.checks = []; item.execution.checks = []; },
    item => { item.context.instanceId = ''; },
    item => { item.context.evidenceId = ''; },
    item => { item.task.ostadix.round = -1; },
  ];
  for (const mutate of mutations) {
    const supplied = inputs(); mutate(supplied);
    await assert.rejects(publish(store, supplied));
    assert.deepEqual(await store.list(), []);
  }
});

test('artifact identity separates contracts and producer generations while deduplicating source blobs', async t => {
  const { directory, store } = await setup(t), original = await publish(store);
  const ids = new Set([original.id]);
  for (const mutate of [
    item => { item.task.ostadix.round++; },
    item => { item.context.instanceId = 'instance-two'; },
    item => { item.context.evidenceId += ':second'; },
    item => { item.task.agentId = 'other-builder'; },
    item => { item.task.ostadix.checks = [{ kind: 'stdout_equals', expected: '[string] café ☀\n' }]; item.execution.checks = item.task.ostadix.checks.map(check => ({ ...check, passed: true })); },
  ]) {
    const supplied = inputs(); mutate(supplied);
    const receipt = await publish(store, supplied);
    assert.equal(receipt.sha256, original.sha256);
    assert.equal(ids.has(receipt.id), false);
    ids.add(receipt.id);
    await store.readOstadixArtifact(receipt.id);
  }
  assert.equal((await artifactInputs(path.join(directory, 'artifacts'))).length, 1);
});

test('read rejects altered contract and provenance even when source bytes remain intact', async t => {
  const { directory, store } = await setup(t), original = await publish(store);
  for (const mutate of [
    artifact => { artifact.code.contract.checks[0].expected = 'forged'; },
    artifact => { artifact.producer = 'another-gent'; },
    artifact => { artifact.code.producerInstanceId = 'another-instance'; },
    artifact => { artifact.code.executionEvidenceId = 'another-run'; },
    artifact => { artifact.round++; artifact.code.createdRound++; },
    artifact => { artifact.code.sourceSha256 = 'f'.repeat(64); },
    artifact => { artifact.semanticVerification = true; },
    artifact => { artifact.guestPath = '/tmp/not-the-blob'; },
  ]) {
    const artifact = structuredClone(original); mutate(artifact);
    await replaceIndex(directory, [artifact]);
    await assert.rejects(store.readOstadixArtifact(original.id), /artifact|contract/);
  }
});

test('self-consistent digest does not make unknown or empty checks a valid review contract', async t => {
  const { directory, store } = await setup(t), original = await publish(store);
  for (const forgedChecks of [[], [{ kind: 'exit_code', expected: 0 }], [{ kind: 'stdout_contains', expected: '' }], [{ kind: 'stdout_equals', expected: 123 }]]) {
    const artifact = structuredClone(original);
    artifact.code.contract.checks = forgedChecks;
    artifact.id = recomputeId(artifact);
    await replaceIndex(directory, [artifact]);
    await assert.rejects(store.readOstadixArtifact(artifact.id));
  }
});

test('read rejects corruption and requires exactly one artifact identified by its contract ID', async t => {
  const { directory, store } = await setup(t), receipt = await publish(store);
  await assert.rejects(store.readOstadixArtifact('../index.json'), /artifact ID/);
  await assert.rejects(store.readOstadixArtifact(`sha256:${receipt.sha256}`), /artifact ID/);
  await assert.rejects(store.readOstadixArtifact('ostadix:' + '0'.repeat(64)), /unique publication/);
  await replaceIndex(directory, [receipt, receipt]);
  await assert.rejects(store.readOstadixArtifact(receipt.id), /unique publication/);
  await replaceIndex(directory, [receipt]);
  const file = path.join(directory, 'artifacts', path.basename(receipt.guestPath));
  await chmod(file, 0o600);
  await writeFile(file, source.replace('café', 'fake'));
  await assert.rejects(store.readOstadixArtifact(receipt.id), /digest/);
});

test('serialized contract budget is checked before writes and leaves the previous artifact store readable', async t => {
  const { directory, store } = await setup(t), artifactsDirectory = path.join(directory, 'artifacts');
  // These are legal 4096-byte predicates. JSON escaping makes their persisted
  // representation larger, so the budget must measure serialized UTF-8 bytes.
  const largeChecks = Array.from({ length: 8 }, (_, index) => ({ kind: 'stdout_contains', expected: `${index}:` + '\n'.repeat(4094) }));
  const retained = [];
  let refused = false;
  for (let round = 1; round <= 12; round++) {
    const candidateSource = source + `\n# revision ${round}\n`;
    const supplied = inputs({ source: candidateSource, sourceSha256: sha(candidateSource), round, checks: largeChecks });
    const beforeIndex = retained.length ? await readFile(path.join(artifactsDirectory, 'index.json')) : null;
    const beforeFiles = retained.length ? (await readdir(artifactsDirectory)).sort() : [];
    try { retained.push(await publish(store, supplied)); }
    catch (error) {
      assert.match(error.message, /index exceeds 256 KiB/);
      refused = true;
      assert.ok(retained.length > 0);
      assert.deepEqual(await readFile(path.join(artifactsDirectory, 'index.json')), beforeIndex, 'Failed publication must not replace the readable index');
      assert.deepEqual((await readdir(artifactsDirectory)).sort(), beforeFiles, 'Budget failure must not leave a source blob or temporary index');
      await assert.rejects(readFile(path.join(artifactsDirectory, `sha256-${sha(candidateSource)}`)), { code: 'ENOENT' });
      assert.deepEqual(await store.list(), retained);
      for (const artifact of retained) assert.equal((await store.readOstadixArtifact(artifact.id)).artifact.id, artifact.id);
      break;
    }
  }
  assert.equal(refused, true, 'The test must actually reach the persisted index limit');
});
