import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runDistributionCommand } from '../src/distribution-cli.mjs';
import { readDistributionSettings, saveDistributionSettings } from '../src/distribution-config.mjs';
import { taskArguments, runSetup } from '../src/user-cli.mjs';

function capture() { let text = ''; return { write(chunk) { text += chunk; }, get text() { return text; } }; }
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ovm-control-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('mode survives a new invocation and task overrides preserve normal NAT', async t => {
  const projectRoot = await fixture(t), output = capture();
  await runDistributionCommand('mode', ['local'], { projectRoot, output, environment: {} });
  assert.equal(readDistributionSettings(projectRoot, {}).mode, 'local');
  assert.equal(readDistributionSettings(projectRoot, { OVM_DISTRIBUTION_MODE: 'auto' }).mode, 'auto');
  assert.match(output.text, /Internet access/);
  assert.deepEqual(taskArguments(['continue', '--resume', 'saved', '--local']), ['--mission', 'continue', '--resume', 'saved', '--local']);
  assert.deepEqual(taskArguments(['work', '--on', 'air']).slice(0, 4), ['--mission', 'work', '--on', 'air']);
  await assert.rejects(runDistributionCommand('mode', ['unknown'], { projectRoot, output, environment: {} }), /auto, local, or required/);
});

test('peer discovery is read-only and unavailable hosts do not block local control', async t => {
  const projectRoot = await fixture(t), output = capture(), calls = [];
  await saveDistributionSettings(projectRoot, { mode: 'auto', peers: [{ name: 'air', host: 'air' }] }, {});
  const before = await readFile(path.join(projectRoot, 'runtime/distribution/config.json'));
  const code = await runDistributionCommand('peers', ['--discover', '--json'], { projectRoot, output, environment: {},
    call: async (_peer, request) => { calls.push(request.op); throw new Error('offline'); },
    execute: async (file, args) => { assert.equal(file, 'tailscale'); assert.deepEqual(args, ['status', '--json']); return { stdout: JSON.stringify({ Peer: { rack: { HostName: 'rack', Online: true, OS: 'linux', TailscaleIPs: ['100.1.2.3'] } } }) }; },
  });
  assert.equal(code, 0);
  const result = JSON.parse(output.text);
  assert.equal(result.peers[0].vmReady, false);
  assert.equal(result.discovered[0].name, 'rack');
  assert.deepEqual(calls, ['probe']);
  assert.deepEqual(await readFile(path.join(projectRoot, 'runtime/distribution/config.json')), before);
});

test('connect transfers one private invitation over controller transport and saves only metadata', async t => {
  const projectRoot = await fixture(t), output = capture();
  const invitation = { schema: 'test-private-invitation', caPrivateKey: 'test-only-secret', network: { networkId: 'a'.repeat(32) } };
  const calls = [];
  const code = await runDistributionCommand('connect', ['test-host', '--name', 'air', '--json'], { projectRoot, output, environment: {},
    call: async (peer, request) => {
      calls.push(request.op);
      if (request.op === 'probe') return { vmReady: true, root: '/Users/test/ovm' };
      assert.equal(peer.root, '/Users/test/ovm'); assert.deepEqual(request.invitation, invitation);
      return { networkId: invitation.network.networkId };
    },
    prepareNetwork: async () => {},
    invite: async ({ outputFile }) => writeFile(outputFile, JSON.stringify(invitation), { mode: 0o600, flag: 'wx' }),
  });
  assert.equal(code, 0); assert.deepEqual(calls, ['probe', 'join']);
  const stored = readDistributionSettings(projectRoot, {});
  assert.equal(stored.peers[0].host, 'test-host');
  assert.equal(JSON.stringify(stored).includes(invitation.caPrivateKey), false);
  assert.deepEqual(await readdir(path.join(projectRoot, 'runtime/distribution')), ['config.json']);
  await runDistributionCommand('disconnect', ['air'], { projectRoot, output, environment: {} });
  assert.deepEqual(readDistributionSettings(projectRoot, {}).peers, []);
});

test('incompatible controller and failed invitation never become connected peers', async t => {
  const projectRoot = await fixture(t), output = capture();
  await assert.rejects(runDistributionCommand('connect', ['rack'], { projectRoot, output, progress: output, environment: {},
    call: async () => ({ vmReady: false, platform: 'linux', architecture: 'x64' }),
    invite: async () => assert.fail('incompatible hosts receive no authority'),
  }), /not ready/);
  await assert.rejects(runDistributionCommand('connect', ['air'], { projectRoot, output, progress: output, environment: {},
    call: async (_peer, request) => { if (request.op === 'probe') return { vmReady: true, root: '/ovm' }; throw new Error('connection lost'); },
    prepareNetwork: async () => {}, invite: async ({ outputFile }) => writeFile(outputFile, '{}'),
  }), /connection lost/);
  assert.deepEqual(readDistributionSettings(projectRoot, {}).peers, []);
  assert.deepEqual(await readdir(path.join(projectRoot, 'runtime/distribution')), []);
});

test('setup retains functional local use when optional mesh fails but required mode reports failure', async t => {
  const root = await fixture(t), output = capture();
  const base = { output, exists: () => true, installPrebuilt: async () => 0, run: async () => 0,
    prepareGuests: async () => ({ prepared: true, verified: true }), prepareNetwork: async () => { throw new Error('underlay unavailable'); },
  };
  assert.equal(await runSetup(root, { ...base, environment: { OVM_INSTALL_BIN: path.join(root, 'links') } }), 0);
  assert.match(output.text, /Local VM tasks and internet access remain available/);
  assert.equal(await runSetup(root, { ...base, environment: { OVM_DISTRIBUTION_MODE: 'required' } }), 2);
  assert.equal(await runSetup(root, { ...base, environment: { OVM_DISTRIBUTION_MODE: 'local', OVM_INSTALL_BIN: path.join(root, 'links') }, prepareNetwork: async () => assert.fail('local skips mesh setup') }), 0);
});

test('connect retries reuse established authority without allocating another controller invitation', async t => {
  const projectRoot = await fixture(t), output = capture();
  const network = { configured: true, networkId: 'a'.repeat(32), caFileSha256: 'b'.repeat(64) };
  let joined = false, invitations = 0, joins = 0;
  const dependencies = { projectRoot, output, progress: output, environment: {}, prepareNetwork: async () => {}, inspectNetwork: async () => network,
    invite: async ({ outputFile }) => { invitations++; await writeFile(outputFile, JSON.stringify({ network })); },
    call: async (_peer, request) => {
      if (request.op === 'probe') return { vmReady: true, root: '/remote/ovm', network: joined ? network : { configured: false } };
      joins++; joined = true; throw new Error('lost join acknowledgement');
    },
  };
  await assert.rejects(runDistributionCommand('connect', ['--name=air', '--json', 'test-host'], dependencies), /lost join acknowledgement/);
  await runDistributionCommand('connect', ['--json', '--name', 'air', 'test-host'], dependencies);
  await runDistributionCommand('connect', ['test-host', '--json', '--name=air'], dependencies);
  assert.equal(invitations, 1); assert.equal(joins, 1);
  assert.equal(readDistributionSettings(projectRoot, {}).peers.length, 1);
  await runDistributionCommand('disconnect', ['--json', 'air'], dependencies);
  assert.equal(readDistributionSettings(projectRoot, {}).peers.length, 0);
});

test('distribution rejects unknown flags, extra positionals and relative remote paths before actions', async t => {
  const projectRoot = await fixture(t);
  for (const [command, argv] of [['peers', ['--discver']], ['mode', ['local', 'required']], ['connect', ['--path', 'relative', 'host']], ['connect', ['--name', 'one', '--name=two', 'host']], ['connect', ['host', '--node=node']], ['connect', ['--node', '/node', '--node=/other-node', 'host']]]) {
    await assert.rejects(runDistributionCommand(command, argv, { projectRoot, environment: {}, call: async () => assert.fail('invalid arguments cannot contact a host') }));
  }
});

test('connect saves a private Node interpreter and reuses it for retries and availability checks', async t => {
  const projectRoot = await fixture(t), output = capture();
  const nodePath = "/home/user/private Node's/bin/node";
  const network = { configured: true, networkId: 'a'.repeat(32), caFileSha256: 'b'.repeat(64) };
  const peers = [];
  const options = { projectRoot, output, progress: output, environment: {},
    call: async (peer, request) => { peers.push(peer); assert.equal(request.op, 'probe'); return { vmReady: true, root: '/remote/ovm', backend: 'qemu-arm64', platform: 'linux', network }; },
    prepareNetwork: async () => {}, inspectNetwork: async () => network, invite: async () => assert.fail('same network must not receive another invitation'),
  };
  assert.equal(await runDistributionCommand('connect', ['--node', nodePath, 'rack', '--json', '--name=worker'], options), 0);
  assert.equal(readDistributionSettings(projectRoot, {}).peers[0].nodePath, nodePath);
  assert.equal(await runDistributionCommand('connect', ['rack', '--name', 'worker', '--json'], options), 0);
  await runDistributionCommand('peers', ['--json'], options);
  assert.equal(peers.length, 3); assert.ok(peers.every(peer => peer.nodePath === nodePath));
  await runDistributionCommand('connect', ['rack', '--node=/private/new-node', '--name=worker'], { ...options, call: async peer => {
    assert.equal(peer.nodePath, '/private/new-node'); return { vmReady: true, root: '/remote/ovm', network };
  } });
  assert.equal(readDistributionSettings(projectRoot, {}).peers[0].nodePath, '/private/new-node');
});

test('saved interpreter paths are validated before persistence and after loading', async t => {
  const root = await fixture(t);
  const settings = { mode: 'auto', peers: [{ name: 'rack', host: 'rack', nodePath: '/private/node' }] };
  await saveDistributionSettings(root, settings, {});
  const file = path.join(root, 'runtime/distribution/config.json'); const original = await readFile(file);
  await assert.rejects(saveDistributionSettings(root, { ...settings, peers: [{ ...settings.peers[0], nodePath: 'node --flag' }] }, {}), /absolute executable path/);
  assert.deepEqual(await readFile(file), original);
  await writeFile(file, JSON.stringify({ version: 1, ...settings, peers: [{ ...settings.peers[0], nodePath: '/private/node\nextra' }] }));
  assert.throws(() => readDistributionSettings(root, {}), /absolute executable path/);
});

test('unready Linux controllers receive QEMU requirements rather than Apple-only setup guidance', async t => {
  const projectRoot = await fixture(t), output = capture();
  await assert.rejects(runDistributionCommand('connect', ['rack'], { projectRoot, output, progress: output, environment: {},
    call: async () => ({ vmReady: false, backend: 'qemu-arm64', platform: 'linux', architecture: 'x64', reason: 'Node 26+ required' }),
  }), error => {
    assert.match(error.message, /gent check --backend qemu/);
    assert.match(error.message, /Node 26\+/);
    assert.doesNotMatch(error.message, /compatible Apple Silicon Mac/);
    return true;
  });
});
