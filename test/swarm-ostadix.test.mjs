import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PocketSwarm } from '../src/pocket-swarm.mjs';

const source = 'python^(\n__oval_result__ = 1 + 1\n)_python\n\n';
const stdout = '[number] 2\n';
const checks = [{ kind: 'stdout_equals', expected: stdout }];
const runAction = changes => ({ type: 'ostadix', source, name: 'sum', mode: 'run', checks, ...changes });
const finish = (evidenceId, kind = 'ostadix_checks_passed') => ({ type: 'finish', summary: 'The declared checks were observed', assertions: [{ evidenceId, kind, expected: true }] });
const phase = output => ({ exitCode: 0, stdout: output, stderr: '', timedOut: false, outputLimitExceeded: false });
const sha = value => createHash('sha256').update(value).digest('hex');

// Only the guest worker is simulated. Its receipt still passes through the
// real native-receipt parser, assertion evaluator and immutable artifact store.
function workerReceipt(task, { output = stdout, executionExitCode = 0 } = {}) {
  assert.ok(task.ostadix, 'The scripted fleet should receive an Ostadix task');
  const program = task.ostadix;
  const receipt = {
    schema: 'ovm.ostadix-execution/v1', sourceSha256: program.sourceSha256, mode: program.mode,
    parse: phase(JSON.stringify({ ok: true, stage: 'parse', source_structure: {
      schema: 'ostadix.source-structure/v1', required_initial_bindings: [], languages: ['python'],
      top_level_literal_text: false, plan_nodes: 3,
      backend_syntax_checks: [{ language: 'python', state: 'valid', result_capture: 'explicit_result' }],
    } })),
    intent: phase(JSON.stringify({ schema: 'oexec.execution-intent/v1', source_sha256: program.sourceSha256, execution_intent_sha256: 'a'.repeat(64) })),
    execution: program.mode === 'run' ? { ...phase(output), exitCode: executionExitCode } : null,
    error: null,
  };
  return { agent: task.agentId, stopped: true, exitCode: 0, output: program.token + JSON.stringify(receipt) + '\n' };
}

function model(decide) {
  return { async decide(agent, context) { return { model: 'scripted-test', content: JSON.stringify({ actions: await decide(agent, context) }) }; } };
}
async function fixture(t, swarmId) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'o-gents-swarm-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const batches = [];
  const fleet = {
    rootfsPath: agentId => path.join(directory, agentId + '.img'),
    async run(tasks) { batches.push(structuredClone(tasks)); return tasks.map(task => workerReceipt(task)); },
  };
  return {
    directory, batches, fleet,
    state: async () => JSON.parse(await readFile(path.join(directory, 'swarm.json'), 'utf8')),
    base: { mission: 'Write an O program and have a different gent check the exact execution',
      agents: [{ id: 'builder', role: 'write programs' }, { id: 'checker', role: 'review executions' }],
      vmFleet: fleet, nativeBroker: { async describe() { return { operations: [] }; } },
      stateDirectory: directory, swarmId, maximumRounds: 4, maximumAgents: 2 },
  };
}
function turn(result, agentId, round) {
  return result.transcript.find(item => item.agentId === agentId && item.round === round);
}

test('source publication, peer execution read and distinct rerun gate producer completion', async t => {
  const f = await fixture(t, 'peer-success'), contexts = [];
  const result = await new PocketSwarm({ ...f.base, modelClient: model((agent, context) => {
    contexts.push({ agentId: agent.id, ...structuredClone(context) });
    if (context.round === 1) return agent.id === 'builder' ? [runAction()] : [];
    if (context.round === 2) return agent.id === 'builder'
      ? [finish('peer-success:builder:1:ostadix')]
      : [{ type: 'read_execution', evidenceId: 'peer-success:builder:1:ostadix' }];
    if (context.round === 3) return agent.id === 'builder'
      ? [finish('peer-success:builder:1:ostadix')]
      : [{ type: 'review_artifact', artifactId: context.availableArtifacts[0].id,
        source: 'untrusted override', checks: [{ kind: 'stdout_contains', expected: 'anything' }] }];
    return [finish('peer-success:checker:3:peer-review', 'peer_review_passed')];
  }) }).run();

  assert.equal(result.completed, true);
  assert.equal(result.missionVerification, 'not-assessed');
  assert.equal(f.batches.length, 2, 'Reading retained execution evidence must not dispatch another VM task');
  assert.deepEqual(f.batches.map(tasks => tasks.map(task => task.agentId)), [['builder'], ['checker']]);
  assert.equal(result.programArtifacts.length, 1);
  const artifact = result.programArtifacts[0], review = result.artifactReviews[0];
  assert.equal(artifact.sha256, sha(source));
  assert.equal(artifact.peerVerification.status, 'peer-verified');
  assert.equal(artifact.semanticVerification, false);
  assert.equal(f.batches[1][0].ostadix.source, source);
  assert.deepEqual(f.batches[1][0].ostadix.checks, checks);
  assert.equal(f.batches[1][0].ostadix.reviewOf.artifactId, artifact.id);
  assert.equal(review.producer, 'builder'); assert.equal(review.reviewer, 'checker');
  assert.equal(review.status, 'peer-verified');
  assert.equal(review.executionEvidenceId, 'peer-success:builder:1:ostadix');
  for (const round of [2, 3]) assert.ok(turn(result, 'builder', round).observation.repairs.some(item => item.reason === 'awaiting-peer-review'));
  const read = turn(result, 'checker', 2).observation.executionReads[0];
  assert.equal(read.source, source); assert.equal(read.stdout.text, stdout);
  assert.equal(read.independentVerification, false);
  assert.deepEqual(read.checks, [{ ...checks[0], passed: true }]);
  const peerContext = contexts.find(context => context.agentId === 'checker' && context.round === 2);
  assert.ok(peerContext.availableEvidence.some(evidence => evidence.id === 'peer-success:builder:1:ostadix'));
  assert.ok(peerContext.inbox.some(message => message.kind === 'request' && message.message.includes(artifact.id)));
  const persisted = await f.state();
  assert.equal(persisted.artifactReviews[0].status, 'peer-verified');
  assert.equal(persisted.programArtifacts[0].claimStatus, 'awaiting-peer-review', 'Immutable publication does not become a semantic proof');
});

test('static source checking creates neither execution evidence nor a publishable success', async t => {
  const f = await fixture(t, 'static-only');
  const result = await new PocketSwarm({ ...f.base, agents: [{ id: 'builder', role: 'check syntax' }], maximumRounds: 2,
    modelClient: model((_agent, context) => context.round === 1
      ? [runAction({ mode: 'check', checks: [] }), finish('static-only:builder:1:ostadix')]
      : [finish('static-only:builder:1:ostadix')]) }).run();
  assert.equal(result.completed, false);
  assert.equal(result.programArtifacts.length, 0); assert.equal(result.artifactReviews.length, 0);
  assert.equal(f.batches.length, 1);
  const first = turn(result, 'builder', 1).observation;
  assert.equal(first.ostadix.executed, false);
  assert.equal(first.ostadix.checkStatus, 'static-check-passed');
  assert.equal(first.ostadix.execution, null);
  assert.equal(first.evidence.find(item => item.id.endsWith(':ostadix')).kind, 'ostadix-check');
  assert.match(first.errors.join('\n'), /finish deferred/);
  assert.ok(turn(result, 'builder', 2).observation.repairs.some(item => item.reason === 'invalid-evidence-assertion'));
});

test('self review and unknown artifact or execution references never dispatch review work', async t => {
  const f = await fixture(t, 'review-refusal');
  const result = await new PocketSwarm({ ...f.base, maximumRounds: 3, modelClient: model((agent, context) => {
    if (context.round === 1) return agent.id === 'builder' ? [runAction()] : [];
    if (context.round === 2) return agent.id === 'builder'
      ? [{ type: 'review_artifact', artifactId: context.availableArtifacts[0].id }]
      : [{ type: 'review_artifact', artifactId: 'ostadix:' + 'f'.repeat(64) }, { type: 'read_execution', evidenceId: 'invented:run' }];
    return agent.id === 'builder' ? [finish('review-refusal:builder:1:ostadix')] : [];
  }) }).run();
  assert.equal(result.completed, false); assert.equal(f.batches.length, 1);
  assert.equal(result.artifactReviews.length, 0);
  assert.match(turn(result, 'builder', 2).observation.errors.join('\n'), /producer cannot supply its own/);
  assert.match(turn(result, 'checker', 2).observation.errors.join('\n'), /unique publication/);
  assert.match(turn(result, 'checker', 2).observation.errors.join('\n'), /Execution read rejected/);
  assert.ok(turn(result, 'builder', 3).observation.repairs.some(item => item.reason === 'awaiting-peer-review'));
});

test('failed peer output checks do not certify an artifact or satisfy finish assertions', async t => {
  const f = await fixture(t, 'review-failed');
  const result = await new PocketSwarm({ ...f.base, maximumRounds: 3,
    vmFleet: { ...f.fleet, async run(tasks) { f.batches.push(tasks); return tasks.map(task => workerReceipt(task, { output: task.agentId === 'checker' ? '[number] 3\n' : stdout })); } },
    modelClient: model((agent, context) => {
      if (context.round === 1) return agent.id === 'builder' ? [runAction()] : [];
      if (context.round === 2) return agent.id === 'checker' ? [{ type: 'review_artifact', artifactId: context.availableArtifacts[0].id }] : [];
      return [agent.id === 'builder' ? finish('review-failed:builder:1:ostadix') : finish('review-failed:checker:2:peer-review', 'peer_review_passed')];
    }) }).run();
  assert.equal(result.completed, false); assert.equal(f.batches.length, 2);
  assert.equal(result.artifactReviews[0].status, 'checks-failed');
  assert.equal(result.artifactReviews[0].checks[0].passed, false);
  assert.equal(result.programArtifacts[0].peerVerification.status, 'checks-failed');
  assert.ok(turn(result, 'builder', 3).observation.repairs.some(item => item.reason === 'awaiting-peer-review'));
  assert.ok(turn(result, 'checker', 3).observation.repairs.some(item => item.reason === 'invalid-evidence-assertion'));
});

test('pending peer review survives resume and completes without re-running the producer', async t => {
  const f = await fixture(t, 'resume-review');
  await new PocketSwarm({ ...f.base, maximumRounds: 1,
    modelClient: model(agent => agent.id === 'builder' ? [runAction()] : []) }).run();
  const saved = await f.state(), originalId = saved.programArtifacts[0].id;
  assert.equal(saved.artifactReviews.length, 0);
  const result = await new PocketSwarm({ ...f.base, resumeState: saved, maximumRounds: 2,
    modelClient: model((agent, context) => {
      if (context.round === 2) {
        if (agent.id === 'builder') {
          assert.deepEqual(context.pendingCodeReviews.map(item => item.id), [originalId]);
          return [finish('resume-review:builder:1:ostadix')];
        }
        return [{ type: 'review_artifact', artifactId: originalId }];
      }
      return [finish('resume-review:checker:2:peer-review', 'peer_review_passed')];
    }) }).run();
  assert.equal(result.completed, true); assert.equal(result.rounds, 3);
  assert.deepEqual(f.batches.map(tasks => tasks.map(task => task.agentId)), [['builder'], ['checker']]);
  assert.equal(result.programArtifacts[0].id, originalId);
  assert.equal(result.capsuleIdentity.instanceId, saved.capsuleIdentity.instanceId);
  assert.ok(turn(result, 'builder', 2).observation.repairs.some(item => item.reason === 'awaiting-peer-review'));
});

test('uncertain peer dispatch blocks resume until the original receipt is recovered, without replay', async t => {
  const f = await fixture(t, 'unknown-review');
  let submissions = 0;
  const initial = await new PocketSwarm({ ...f.base,
    vmFleet: { ...f.fleet, async run(tasks) {
      submissions++; f.batches.push(structuredClone(tasks));
      if (tasks[0].ostadix.reviewOf) { const error = new Error('disconnected after review admission'); error.uncertain = true; throw error; }
      return tasks.map(task => workerReceipt(task));
    } },
    modelClient: model((agent, context) => context.round === 1
      ? agent.id === 'builder' ? [runAction()] : []
      : agent.id === 'checker' ? [{ type: 'review_artifact', artifactId: context.availableArtifacts[0].id }] : []) }).run();
  assert.equal(initial.blocked.kind, 'vm-outcome-unknown');
  assert.equal(initial.rounds, 2); assert.equal(submissions, 2);
  const saved = await f.state();
  assert.equal(saved.pendingDispatch.tasks[0].ostadix.reviewOf.artifactId, saved.programArtifacts[0].id);
  assert.equal(saved.pendingDispatch.tasks[0].ostadix.source, source);
  assert.equal(saved.artifactReviews.length, 0);
  const blocked = await new PocketSwarm({ ...f.base, resumeState: saved,
    vmFleet: { ...f.fleet, async recover() { return null; }, async run() { assert.fail('Unknown effects must not be replayed'); } },
    nativeBroker: { async describe() { assert.fail('Recovery must precede reasoning and other observations'); } },
    modelClient: model(() => assert.fail('Unknown outcome must block new decisions')) }).run();
  assert.equal(blocked.blocked.kind, 'vm-outcome-unknown');
  assert.equal(blocked.additionalRounds, 0);
  const resumed = await new PocketSwarm({ ...f.base, resumeState: saved, maximumRounds: 1,
    vmFleet: { ...f.fleet,
      async recover() { return { tasks: saved.pendingDispatch.tasks, workers: saved.pendingDispatch.tasks.map(task => workerReceipt(task)) }; },
      async run() { assert.fail('Recovered review must not be submitted again'); },
    }, modelClient: model((_agent, context) => {
      assert.equal(context.artifactReviews[0].status, 'peer-verified');
      return [finish('unknown-review:checker:2:peer-review', 'peer_review_passed')];
    }) }).run();
  assert.equal(resumed.completed, true);
  assert.equal(resumed.artifactReviews.length, 1);
  assert.equal(turn(resumed, 'checker', 2).observation.vm.recovered, true);
  assert.equal((await f.state()).pendingDispatch, null);
  assert.equal(submissions, 2);
});

test('only one guest action runs per phase and same-turn source success cannot finish a gent', async t => {
  const f = await fixture(t, 'one-operation');
  const result = await new PocketSwarm({ ...f.base, maximumRounds: 1, agents: [{ id: 'builder', role: 'write' }],
    modelClient: model(() => [runAction(), { type: 'vm', command: 'should never run' }, runAction({ name: 'second program' }),
      { type: 'review_artifact', artifactId: 'ostadix:' + '0'.repeat(64) },
      { type: 'publish', path: '/root/not-created', name: 'not-created' },
      finish('one-operation:builder:1:ostadix')]) }).run();
  assert.equal(result.completed, false); assert.equal(f.batches.length, 1); assert.equal(f.batches[0].length, 1);
  assert.equal(result.programArtifacts.length, 1); assert.equal(result.programArtifacts[0].name, 'sum');
  const observation = turn(result, 'builder', 1).observation;
  assert.deepEqual(observation.repairs.filter(item => item.reason === 'cardinality').map(item => item.dropped), ['vm', 'ostadix', 'review_artifact', 'publish']);
  assert.match(observation.errors.join('\n'), /finish deferred/);
  assert.equal((await f.state()).agents[0].pendingActions.length, 0, 'Dropped execution work must not become an automatic retry');
});
