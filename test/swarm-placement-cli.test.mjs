import test from 'node:test';
import assert from 'node:assert/strict';
import { runUserCommand, taskArguments } from '../src/user-cli.mjs';
import { resolveSwarmPlacement } from '../src/swarm-cli.mjs';
import { DistributedVMFleet } from '../src/distributed-fleet.mjs';

const root = new URL('..', import.meta.url).pathname;
const quiet = { write() {} };

test('an explicit task destination overrides the saved local default in either option order', () => {
  for (const argv of [
    ['observe Linux', '--agents', '3', '--on', 'rack'],
    ['--on=rack', '--agents', '3', 'observe Linux'],
  ]) {
    const placement = resolveSwarmPlacement(taskArguments(argv), { mode: 'local' }, {});
    assert.deepEqual(placement, { distributionMode: 'auto', target: 'rack', networkMode: 'nat' });
  }
});

test('named placement reaches remote admission instead of silently running locally', async () => {
  const placement = resolveSwarmPlacement(['--on', 'missing-rack'], { mode: 'local' }, {});
  const fleet = new DistributedVMFleet({
    local: { networkMode: placement.networkMode, memoryMB: 768 },
    projectRoot: root, stateDirectory: '/nonexistent-ovm-placement-review',
    swarmId: 'placement-review', mode: placement.distributionMode, target: placement.target,
    peers: [], call: async () => assert.fail('No peer should be contacted'),
  });
  await assert.rejects(fleet.choose([{ agentId: 'scout' }]), /Unknown or disabled machine missing-rack/);
});

test('VM chat and saved-agent resume share explicit destination precedence', async () => {
  let chatPlacement;
  await runUserCommand('chat', ['observe Linux', '--on', 'rack'], {
    root, output: quiet, errorOutput: quiet, environment: {},
    run: async (_file, argv, options) => {
      chatPlacement = resolveSwarmPlacement(argv.slice(1), { mode: 'local' }, options.env);
      return 0;
    },
  });
  const resumePlacement = resolveSwarmPlacement(['--resume', 'saved-agent', '--on', 'rack'], { mode: 'local' }, {});
  assert.deepEqual(chatPlacement, resumePlacement);
  assert.equal(chatPlacement.target, 'rack');
  assert.equal(chatPlacement.distributionMode, 'auto');
});

test('an explicit destination rejects contradictory local or isolated choices', () => {
  for (const argv of [
    ['--on', 'rack', '--local'],
    ['--local', '--on=rack'],
    ['--on', 'rack', '--distribution', 'local'],
    ['--on', 'rack', '--isolated'],
  ]) assert.throws(() => resolveSwarmPlacement(argv, { mode: 'auto' }, {}), /Choose either|isolated networking/);
  assert.throws(() => resolveSwarmPlacement(['--on', 'rack'], { mode: 'auto' }, { OVM_NETWORK_MODE: 'isolated' }), /isolated networking/);
});

test('everyday task isolation remains contradictory after environment forwarding', async () => {
  await assert.rejects(runUserCommand('task', ['observe Linux', '--on', 'rack', '--isolated'], {
    root, output: quiet, errorOutput: quiet, environment: {},
    run: async (_file, argv, options) => resolveSwarmPlacement(argv.slice(1), { mode: 'local' }, options.env),
  }), /isolated networking/);
});

test('saved defaults remain effective without a destination and required mode remains required', () => {
  assert.deepEqual(resolveSwarmPlacement([], { mode: 'local' }, {}), { distributionMode: 'local', target: 'auto', networkMode: 'nat' });
  assert.deepEqual(resolveSwarmPlacement(['--local'], { mode: 'required' }, {}), { distributionMode: 'local', target: 'local', networkMode: 'nat' });
  for (const [argv, settings] of [[['--on', 'rack'], { mode: 'required' }], [['--on', 'rack', '--distribution', 'required'], { mode: 'local' }]]) {
    assert.equal(resolveSwarmPlacement(argv, settings, {}).distributionMode, 'required');
  }
});

test('a named destination must include a usable value before state inspection', () => {
  for (const argv of [['--on'], ['--on='], ['--on', '--local']]) {
    assert.throws(() => resolveSwarmPlacement(argv, { mode: 'auto' }, {}), /--on requires/);
  }
});
