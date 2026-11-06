import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { checkpointRsyncOptions, controllerCall, controllerCommand, runCaptured, selectRsync, shellQuote, SSH_OPTIONS } from '../src/controller-transport.mjs';

test('private remote Node paths remain literal through the SSH shell command', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ovm-private-node-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, "checkout ' $(not-a-command)");
  const nodePath = path.join(directory, "Node runtime ' $(not-a-command)", 'node');
  await mkdir(path.join(root, 'bin'), { recursive: true }); await mkdir(path.dirname(nodePath), { recursive: true });
  await symlink(process.execPath, nodePath);
  await writeFile(path.join(root, 'bin/ovm'), 'console.log(JSON.stringify(process.argv.slice(1)))');
  const command = controllerCommand({ root, nodePath });
  const result = await runCaptured('/bin/sh', ['-c', command]);
  assert.deepEqual(JSON.parse(result.stdout), [path.join(root, 'bin/ovm'), 'worker']);
  await controllerCall({ host: 'user@host', root, nodePath }, { op: 'probe' }, { execute: async (binary, args) => {
    assert.equal(binary, 'ssh'); assert.deepEqual(args.slice(0, SSH_OPTIONS.length), SSH_OPTIONS);
    assert.equal(args.at(-1), command);
    return { stdout: JSON.stringify({ protocol: 'ovm.controller/v1', ok: true, result: { nodeVersion: '26.8.2' } }) };
  } });
  for (const invalid of ['node', '../node', '/path/to/node\nnext', '/path/to/node\0', '/', 42, null]) {
    assert.throws(() => controllerCommand({ root, nodePath: invalid }), /absolute executable path/);
  }
  assert.match(controllerCommand({ nodePath }), /-f "\$HOME\/\.local\/bin\/ovm"/);
});

test('default controller discovery prefers o-gents and retains both previous checkout fallbacks', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gent-controller-home-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const checkouts = ['o-gents', 'vma-gents', 'claude-vm-mcp'];
  for (const checkout of checkouts) {
    const entrypoint = path.join(directory, checkout, 'bin/ovm');
    await mkdir(path.dirname(entrypoint), { recursive: true });
    await writeFile(entrypoint, 'console.log(JSON.stringify(process.argv.slice(1)))');
  }
  for (const checkout of checkouts) {
    const entrypoint = path.join(directory, checkout, 'bin/ovm');
    for (const peer of [{}, { nodePath: process.execPath }]) {
      const command = controllerCommand(peer).replaceAll('$HOME', '$OVM_TEST_HOME');
      const result = await runCaptured('/bin/sh', ['-c', command], { env: { ...process.env, OVM_TEST_HOME: directory } });
      assert.deepEqual(JSON.parse(result.stdout), [entrypoint, 'worker']);
    }
    await rm(path.join(directory, checkout), { recursive: true });
  }
});

test('transport only marks a refusal safe when it is bound to the submitted dispatch', async () => {
  const request = { op: 'run', id: 'dispatch' };
  const digest = createHash('sha256').update(JSON.stringify({ protocol: 'ovm.controller/v1', ...request })).digest('hex');
  for (const matching of [false, true]) {
    await assert.rejects(controllerCall({ host: 'peer' }, request, { execute: async () => ({ stdout: JSON.stringify({ protocol: 'ovm.controller/v1', ok: false, admitted: false, id: 'dispatch', requestHash: matching ? digest : 'wrong', error: 'declined' }) }) }), error => { assert.equal(error.rejected, matching); return true; });
  }
});

test('captured subprocess preserves UTF-8 split across stdout writes', async () => {
  const result = await runCaptured(process.execPath, ['-e', "const b=Buffer.from('λ🙂');process.stdout.write(b.subarray(0,1));setTimeout(()=>process.stdout.write(b.subarray(1)),5)"]);
  assert.equal(result.stdout, 'λ🙂');
});

test('receipt transport retains the aggregate output of sixteen artifact captures', async () => {
  const bytes = 16 * 400 * 1024;
  const result = await runCaptured(process.execPath, ['-e', `process.stdout.write('x'.repeat(${bytes}))`]);
  assert.equal(Buffer.byteLength(result.stdout), bytes);
});

test('rsync selection bypasses the sparse-inflating Apple receiver without rejecting protocol 29', async () => {
  const legacy = 'rsync  version 2.6.9  protocol version 29';
  const modern = 'rsync  version 3.5.1  protocol version 33';
  const openrsync = 'openrsync: protocol version 29\nrsync version 2.6.9 compatible';
  const execute = async binary => ({ stdout: { '/usr/bin/rsync': legacy, '/custom-legacy': legacy, '/modern': modern, '/openrsync': openrsync }[binary] });
  const selected = await selectRsync({ platform: 'darwin', candidates: ['/usr/bin/rsync', '/modern'], execute });
  assert.equal(selected.path, '/modern'); assert.equal(selected.modern, true);
  const replacement = await selectRsync({ platform: 'darwin', candidates: ['/usr/bin/rsync', '/openrsync'], execute });
  assert.equal(replacement.path, '/openrsync'); assert.equal(replacement.protocol, 29);
  const linux = await selectRsync({ platform: 'linux', candidates: ['/usr/bin/rsync'], execute });
  assert.equal(linux.version, '2.6.9'); assert.equal(linux.modern, false);
  const customLegacy = await selectRsync({ platform: 'darwin', candidates: ['/custom-legacy'], execute });
  assert.equal(customLegacy.path, '/custom-legacy', 'Apple-specific preallocation must not disqualify unrelated legacy builds');
  const systemReplacement = await selectRsync({ platform: 'darwin', candidates: ['/usr/bin/rsync'], execute: async () => ({ stdout: openrsync }) });
  assert.equal(systemReplacement.path, '/usr/bin/rsync', 'the newer system openrsync remains eligible');
  await assert.rejects(selectRsync({ platform: 'darwin', candidates: ['/usr/bin/rsync'], execute }),
    /Apple's macOS rsync 2\.6\.9 preallocates sparse VM checkpoints.*brew install rsync/);
});

test('production protocol29 checkpoint transport preserves sparse bytes through remote-shell initial and delta transfers', async t => {
  const rsync = await selectRsync();
  const root = await mkdtemp(path.join(os.tmpdir(), 'ovm-rsync-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshot = path.join(root, 'remote snapshot'); const destination = path.join(root, 'local checkpoint');
  await mkdir(snapshot); await mkdir(destination);
  const source = path.join(snapshot, 'guest.rootfs.img'); const target = path.join(destination, 'guest.rootfs.img');
  const file = await open(source, 'w');
  await file.write(Buffer.from('begin'), 0, 5, 0); await file.write(Buffer.from('end'), 0, 3, 32 * 1024 ** 2); await file.close();
  const sourceMetadata = await stat(source);
  assert.ok(sourceMetadata.blocks * 512 < sourceMetadata.size / 2, 'fixture filesystem must support sparse files');
  const shell = path.join(root, 'remote-shell');
  // Exercise the actual remote sender/receiver protocol and production flags
  // without depending on an SSH service or credentials in the test environment.
  await writeFile(shell, '#!/bin/sh\nshift\nexec /bin/sh -c "$*"\n', { mode: 0o700 });
  const transfer = async seeded => {
    const options = checkpointRsyncOptions({ rsync, peer: { host: 'fixture', rsyncPath: rsync.path, rsyncProtocol: 29 },
      source: snapshot + '/', destination: destination + '/', seeded });
    options.args[options.args.indexOf('-e') + 1] = shell;
    await runCaptured(rsync.path, options.args, { env: options.env });
  };
  await transfer(false);
  const metadata = await stat(target); assert.equal(metadata.size, 32 * 1024 ** 2 + 3);
  assert.ok(metadata.blocks * 512 < metadata.size / 2, `${rsync.path} initial checkpoint must retain sparse allocation`);
  assert.deepEqual(await readFile(target), await readFile(source), 'all bytes, including the zero-filled hole, survive initial transfer');
  const changed = await open(source, 'r+'); await changed.write(Buffer.from('new'), 0, 3, 32 * 1024 ** 2); await changed.close();
  await utimes(source, metadata.atime, metadata.mtime);
  await transfer(true);
  assert.deepEqual(await readFile(target), await readFile(source), 'same-size delta with restored mtime must update every changed byte');
  assert.ok((await stat(target)).blocks * 512 < metadata.size / 2, `${rsync.path} in-place delta must preserve existing sparse regions`);
});

test('actual rsync remote-shell protocol preserves paths containing spaces, quotes, shell substitutions, and globs', async t => {
  const rsync = await selectRsync();
  if (!rsync.modern) { t.skip('This regression exercises installed modern rsync'); return; }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ovm-rsync-remote-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, "snapshot ' $(touch INJECTED) [literal]*?\\backslash");
  await mkdir(source); await writeFile(path.join(source, 'proof.txt'), 'exact source bytes');
  const shell = path.join(directory, 'remote-shell');
  // Like SSH, join its remote command words for a remote /bin/sh. This launches
  // a real rsync sender and receiver, while keeping every fixture local.
  await writeFile(shell, `#!/bin/sh\nshift\ncd ${shellQuote(directory)} || exit\nexec /bin/sh -c "$*"\n`, { mode: 0o700 });
  for (const protocol of [32, 30, 29]) {
    const destination = path.join(directory, `copied-${protocol}`); await mkdir(destination);
    const transfer = checkpointRsyncOptions({ rsync, peer: { host: 'test', rsyncPath: rsync.path, rsyncProtocol: protocol },
      source: source + '/', destination: destination + '/', seeded: false,
      environment: { ...process.env, RSYNC_OLD_ARGS: '2', RSYNC_PROTECT_ARGS: '1' } });
    const shellIndex = transfer.args.indexOf('-e'); transfer.args[shellIndex + 1] = shell;
    assert.equal(transfer.args.includes('-s'), protocol >= 30);
    await runCaptured(rsync.path, transfer.args, { env: transfer.env });
    assert.equal(await readFile(path.join(destination, 'proof.txt'), 'utf8'), 'exact source bytes');
  }
  const wrong = ['--list-only', '--rsync-path=' + shellQuote(rsync.path), '-e', shell, '--', `test:${shellQuote(source + '/')}`];
  await assert.rejects(runCaptured(rsync.path, wrong, { env: { ...process.env, RSYNC_OLD_ARGS: '0', RSYNC_PROTECT_ARGS: '0' } }), /failed \(23\)/,
    'the old double-quoted modern source must reproduce the live path error');
  await assert.rejects(stat(path.join(directory, 'INJECTED')), { code: 'ENOENT' });
});
