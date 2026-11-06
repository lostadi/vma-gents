#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PocketSwarm } from '../src/pocket-swarm.mjs';
import { createVMFleet } from '../src/vm-backend.mjs';
import { VMLease } from '../src/lease.mjs';

// Explicit opt-in: this integration check boots two real guest VMs, retains
// their private disks and evidence, and uses scripted decisions, not inference.
if (!process.argv.includes('--run')) {
  console.log('Usage: node scripts/verify-ostadix-peer.mjs --run\nBoots real local VMs to verify exact-source Ostadix execution and independent peer checking. Requires a prepared VM runtime. No model is called.');
  process.exit(0);
}
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const swarmId = `ostadix-proof-${Date.now().toString(36)}`;
const stateDirectory = path.join(projectRoot, 'vm', 'pockets', swarmId);
const fleet = createVMFleet({ projectRoot,
  binaryPath: existsSync(path.join(projectRoot, 'host', 'OVMSwarm')) ? path.join(projectRoot, 'host', 'OVMSwarm') : path.join(projectRoot, 'prebuilt', 'macos-arm64', 'OVMSwarm'),
  bundlePath: path.join(projectRoot, 'vm', 'claudevm.bundle'), smolPath: path.join(projectRoot, 'host', 'smol-bin.arm64.img'),
  stateDirectory, memoryMB: 768, cpuCount: 1, networkMode: 'nat', distributionMode: 'local',
});
const source = 'python^(\n__oval_result__ = 1 + 1\n)_python\n';
const producerEvidence = `${swarmId}:builder:1:ostadix`;
const reviewEvidence = `${swarmId}:checker:3:peer-review`;
const swarm = new PocketSwarm({ mission: 'Independently rerun exact Ostadix source and its declared output check in two real VMs', swarmId, stateDirectory,
  maximumRounds: 4, maximumAgents: 2,
  agents: [{ id: 'builder', role: 'author' }, { id: 'checker', role: 'independent checker' }],
  vmFleet: fleet, nativeBroker: { async describe() { return { operations: [] }; } },
  modelClient: { async decide(agent, context) {
    let actions = [];
    if (context.round === 1 && agent.id === 'builder') actions = [{ type: 'ostadix', name: 'sum', mode: 'run', source, checks: [{ kind: 'stdout_equals', expected: '[number] 2\n' }] }];
    if (context.round === 2 && agent.id === 'checker') actions = [{ type: 'read_execution', evidenceId: producerEvidence }];
    if (context.round === 3 && agent.id === 'checker') {
      const artifact = context.availableArtifacts.find(item => item.kind === 'ostadix-program');
      assert.ok(artifact, 'The actual guest run did not publish a passing Ostadix artifact; inspect the saved evidence');
      actions = [{ type: 'review_artifact', artifactId: artifact.id }];
    }
    if (context.round === 4) actions = [{ type: 'finish', summary: 'The exact source passed its explicit output check in both VMs', assertions: [{ evidenceId: reviewEvidence, kind: 'peer_review_passed', expected: true }] }];
    return { model: 'scripted-real-vm-check', content: JSON.stringify({ actions }) };
  } },
  onProgress(event) {
    if (event.type === 'round-start') console.error(`Round ${event.round}: ${event.agentIds.join(', ')}`);
    if (event.type === 'vm-result') console.error(`${event.agentId}: VM exit ${event.exitCode}${event.error ? `; ${event.error}` : ''}`);
  },
});
const lease = new VMLease(path.join(stateDirectory, '.controller.lease'), { resource: swarmId });
await lease.acquire();
try {
  const result = await swarm.run();
  assert.equal(result.completed, true, `Peer workflow did not complete; inspect ${result.statePath}`);
  assert.equal(result.programArtifacts.length, 1);
  assert.equal(result.programArtifacts[0].peerVerification.status, 'peer-verified');
  assert.equal(result.artifactReviews[0].reviewer, 'checker');
  assert.equal(result.artifactReviews[0].producer, 'builder');
  const executions = result.transcript.filter(turn => turn.observation.ostadix?.executed);
  assert.equal(executions.length, 2);
  for (const turn of executions) {
    assert.equal(turn.observation.ostadix.stdout, '[number] 2\n');
    assert.equal(turn.observation.ostadix.checkStatus, 'checks-passed');
    assert.equal(turn.observation.vm.stopped, true);
    assert.ok(existsSync(fleet.rootfsPath(turn.agentId)));
  }
  assert.notEqual(fleet.rootfsPath('builder'), fleet.rootfsPath('checker'));
  console.log(JSON.stringify({ passed: true, swarmId, statePath: result.statePath, executions: executions.length,
    sourceSha256: result.programArtifacts[0].sha256, review: result.artifactReviews[0], modelInference: false }, null, 2));
} finally { await lease.release(); }
