import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PocketSwarm } from '../src/pocket-swarm.mjs';
import { AgentArtifactStore } from '../src/agent-artifacts.mjs';

const source = 'python^(\n__oval_result__ = 1 + 1\n)_python\n';
const stdout = '[number] 2\n';
const checks = [{ kind: 'stdout_equals', expected: stdout }];
const program = { type: 'ostadix', source, mode: 'run', name: 'sum', checks };
const phase = output => ({ stdout: output, stderr: '', exitCode: 0, timedOut: false, outputLimitExceeded: false });
const finish = (evidenceId, kind = 'ostadix_checks_passed', expected = true) => ({ type: 'finish', summary: 'Observed the explicit check', assertions: [{ evidenceId, kind, expected }] });
const model = choose => ({ async decide(agent, context) { return { content: JSON.stringify({ actions: await choose(agent, context) }) }; } });

function worker(task, output = stdout) {
  if (!task.ostadix) return { agent: task.agentId, stopped: true, exitCode: 0, output: 'ready\n' };
  const receipt = {
    schema: 'ovm.ostadix-execution/v1', sourceSha256: task.ostadix.sourceSha256, mode: task.ostadix.mode,
    parse: phase(JSON.stringify({ ok: true, stage: 'parse', source_structure: {
      schema: 'ostadix.source-structure/v1', required_initial_bindings: [], top_level_literal_text: false,
      backend_syntax_checks: [{ language: 'python', state: 'valid' }],
    } })),
    intent: phase(JSON.stringify({ schema: 'oexec.execution-intent/v1', source_sha256: task.ostadix.sourceSha256, execution_intent_sha256: 'a'.repeat(64) })),
    execution: phase(output), error: null,
  };
  return { agent: task.agentId, stopped: true, exitCode: 0, output: task.ostadix.token + JSON.stringify(receipt) + '\n' };
}

async function fixture(t, swarmId) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'o-gents-obligation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const batches = [];
  const fleet = {
    rootfsPath: id => path.join(directory, id + '.img'),
    async run(tasks) { batches.push(structuredClone(tasks)); return tasks.map(task => worker(task)); },
  };
  return {
    directory, fleet, batches,
    state: async () => JSON.parse(await readFile(path.join(directory, 'swarm.json'), 'utf8')),
    base: { swarmId, stateDirectory: directory, mission: 'Create peer-checked O code',
      agents: [{ id: 'builder', role: 'author' }, { id: 'checker', role: 'reviewer' }], maximumAgents: 2, maximumRounds: 4,
      vmFleet: fleet, nativeBroker: { async describe() { return { operations: [] }; } } },
  };
}

function repairs(result, agentId) {
  return result.transcript.filter(turn => turn.agentId === agentId).flatMap(turn => turn.observation.repairs ?? []);
}

test('failed automatic code publication remains a completion obligation across resume', async t => {
  const f = await fixture(t, 'publication-obligation');
  const store = new AgentArtifactStore({ stateDirectory: f.directory, swarmId: f.base.swarmId });
  store.publishOstadix = async () => { throw new Error('Artifact collection exceeds its byte budget'); };
  const first = await new PocketSwarm({ ...f.base, artifactStore: store, maximumRounds: 2,
    agents: [{ id: 'builder', role: 'author' }], maximumAgents: 1,
    modelClient: model((_agent, context) => context.round === 1 ? [program] : [finish('publication-obligation:builder:1:ostadix')]),
  }).run();
  assert.equal(first.transcript[0].observation.ostadix.checkStatus, 'checks-passed', 'Execution success remains distinct from publication failure');
  assert.equal(first.programArtifacts.length, 0);
  assert.equal(first.completed, false, 'Failed publication must not erase the peer-review obligation');
  assert.ok(repairs(first, 'builder').some(repair => repair.reason === 'awaiting-peer-review'));
  const saved = await f.state();
  const resumed = new PocketSwarm({ ...f.base, artifactStore: store, resumeState: saved, maximumRounds: 1,
    vmFleet: { ...f.fleet, async run() { assert.fail('Resuming a missing publication must not silently rerun producer code'); } },
    modelClient: model(() => [finish('publication-obligation:builder:1:ostadix')]),
  });
  assert.equal(resumed.pendingCodeReviews('builder').length, 1);
  const result = await resumed.run();
  assert.equal(result.completed, false);
  assert.ok(repairs(result, 'builder').filter(repair => repair.reason === 'awaiting-peer-review').length >= 2);
  assert.equal(f.batches.length, 1);
});

test('a reviewer that finishes before publication is reopened to perform the requested independent execution', async t => {
  const f = await fixture(t, 'wake-reviewer');
  const decisions = [];
  const result = await new PocketSwarm({ ...f.base, modelClient: model((agent, context) => {
    decisions.push([agent.id, context.round]);
    if (context.round === 1) return agent.id === 'checker' ? [{ type: 'vm', command: 'printf ready' }] : [];
    if (context.round === 2) return agent.id === 'builder' ? [program] : [finish('wake-reviewer:checker:1:vm', 'exit_code', 0)];
    if (context.round === 3) return agent.id === 'checker'
      ? [{ type: 'review_artifact', artifactId: context.availableArtifacts[0].id }]
      : [finish('wake-reviewer:builder:2:ostadix')];
    return [finish('wake-reviewer:checker:3:peer-review', 'peer_review_passed')];
  }) }).run();
  assert.ok(decisions.some(([agent, round]) => agent === 'checker' && round === 3), 'Publication must wake the finished peer instead of stranding its mailbox request');
  assert.equal(result.completed, true);
  assert.equal(result.programArtifacts[0].peerVerification.status, 'peer-verified');
  assert.deepEqual(f.batches.map(tasks => tasks.map(task => task.agentId)), [['checker'], ['builder'], ['checker']]);
});

test('a sole producer receives a distinct reviewer when the configured capacity permits one', async t => {
  const f = await fixture(t, 'create-reviewer');
  const result = await new PocketSwarm({ ...f.base, agents: [{ id: 'builder', role: 'author' }], maximumAgents: 2,
    modelClient: model((agent, context) => {
      if (context.round === 1) return [program];
      const review = context.availableEvidence.find(evidence => evidence.kind === 'peer-review' && evidence.status === 'peer-verified');
      if (review) return [finish(review.id, 'peer_review_passed')];
      if (agent.id === 'builder') return [finish('create-reviewer:builder:1:ostadix')];
      return [{ type: 'review_artifact', artifactId: context.availableArtifacts[0].id }];
    }),
  }).run();
  assert.equal(result.agents.length, 2);
  assert.equal(result.completed, true);
  const review = result.artifactReviews[0];
  assert.notEqual(review.reviewer, review.producer);
  assert.equal(review.status, 'peer-verified');
  assert.equal(f.batches.flat().filter(task => task.agentId === 'builder').length, 1, 'The producer should not repeat its successful execution to arrange peer review');
});

test('a one-gent capacity cap produces an actionable review repair and cannot manufacture completion', async t => {
  const f = await fixture(t, 'review-capacity');
  const result = await new PocketSwarm({ ...f.base, agents: [{ id: 'builder', role: 'author' }], maximumAgents: 1, maximumRounds: 2,
    modelClient: model((_agent, context) => context.round === 1 ? [program] : [finish('review-capacity:builder:1:ostadix')]),
  }).run();
  assert.equal(result.completed, false);
  assert.equal(result.agents.length, 1);
  assert.equal(result.artifactReviews.length, 0);
  assert.equal(result.programArtifacts[0].peerVerification.status, 'awaiting-peer-review');
  assert.match(JSON.stringify(repairs(result, 'builder')), /maximumAgents|max-agents|capacity/i, 'Repair should explain why no reviewer can be created under the configured cap');
});

test('a newer failed review supersedes a prior pass and keeps the producer open', async t => {
  const f = await fixture(t, 'review-regression');
  let reviewCount = 0;
  const result = await new PocketSwarm({ ...f.base,
    vmFleet: { ...f.fleet, async run(tasks) {
      f.batches.push(structuredClone(tasks));
      return tasks.map(task => worker(task, task.ostadix?.reviewOf && ++reviewCount > 1 ? '[number] 3\n' : stdout));
    } },
    modelClient: model((agent, context) => {
      if (context.round === 1) return agent.id === 'builder' ? [program] : [];
      if ([2, 3].includes(context.round)) return agent.id === 'checker' ? [{ type: 'review_artifact', artifactId: context.availableArtifacts[0].id }] : [];
      return agent.id === 'builder' ? [finish('review-regression:builder:1:ostadix')] : [];
    }),
  }).run();
  assert.deepEqual(result.artifactReviews.map(review => review.status), ['peer-verified', 'checks-failed']);
  assert.equal(result.programArtifacts[0].peerVerification.status, 'checks-failed');
  assert.equal(result.agents.find(agent => agent.id === 'builder').finished, false);
  assert.equal(result.completed, false);
  assert.ok(repairs(result, 'builder').some(repair => repair.reason === 'awaiting-peer-review'));
});

test('a failed rerun revokes a producer finish accepted earlier in the same round', async t => {
  const f = await fixture(t, 'review-finish-race');
  let reviewCount = 0;
  const result = await new PocketSwarm({ ...f.base,
    vmFleet: { ...f.fleet, async run(tasks) {
      f.batches.push(structuredClone(tasks));
      return tasks.map(task => worker(task, task.ostadix?.reviewOf && ++reviewCount > 1 ? '[number] 3\n' : stdout));
    } },
    modelClient: model((agent, context) => {
      if (context.round === 1) return agent.id === 'builder' ? [program] : [];
      if (context.round === 2) return agent.id === 'checker' ? [{ type: 'review_artifact', artifactId: context.availableArtifacts[0].id }] : [];
      if (context.round === 3) return agent.id === 'checker'
        ? [{ type: 'review_artifact', artifactId: context.availableArtifacts[0].id }]
        : [finish('review-finish-race:builder:1:ostadix')];
      return agent.id === 'checker'
        ? [finish('review-finish-race:checker:2:peer-review', 'peer_review_passed')]
        : [finish('review-finish-race:builder:1:ostadix')];
    }),
  }).run();
  assert.deepEqual(result.artifactReviews.map(review => review.status), ['peer-verified', 'checks-failed']);
  assert.equal(result.programArtifacts[0].peerVerification.status, 'checks-failed');
  assert.equal(result.completed, false, 'Latest failed review must prevent completion even when producer finish used an earlier pass');
  assert.equal(result.agents.find(agent => agent.id === 'builder').finished, false, 'The producer must reopen to repair the contradicted execution');
});

test('a rejected rerun receipt cannot leave an earlier peer pass as the current verification', async t => {
  const f = await fixture(t, 'review-receipt-rejected');
  let reviewCount = 0;
  const result = await new PocketSwarm({ ...f.base,
    vmFleet: { ...f.fleet, async run(tasks) {
      f.batches.push(structuredClone(tasks));
      return tasks.map(task => task.ostadix?.reviewOf && ++reviewCount > 1
        ? { agent: task.agentId, stopped: true, exitCode: 0, output: task.ostadix.token + '{"schema":' }
        : worker(task));
    } },
    modelClient: model((agent, context) => {
      if (context.round === 1) return agent.id === 'builder' ? [program] : [];
      if (context.round === 2) return agent.id === 'checker' ? [{ type: 'review_artifact', artifactId: context.availableArtifacts[0].id }] : [];
      if (context.round === 3) return agent.id === 'checker'
        ? [{ type: 'review_artifact', artifactId: context.availableArtifacts[0].id }]
        : [finish('review-receipt-rejected:builder:1:ostadix')];
      return agent.id === 'checker'
        ? [finish('review-receipt-rejected:checker:2:peer-review', 'peer_review_passed')]
        : [finish('review-receipt-rejected:builder:1:ostadix')];
    }),
  }).run();
  assert.ok(result.transcript.find(turn => turn.agentId === 'checker' && turn.round === 3).observation.errors.length);
  assert.equal(result.programArtifacts[0].peerVerification.status, 'unverified', 'A rejected current receipt is not a current successful peer execution');
  assert.equal(result.completed, false);
  assert.equal(result.agents.find(agent => agent.id === 'builder').finished, false);
});
