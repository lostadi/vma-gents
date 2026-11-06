import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeSource, buildSourceTask, acceptSourceCapture } from '../src/source-witness.mjs';
import { runCaptured } from '../src/controller-transport.mjs';

test('source inspection records absence as a scoped fact and preserves exact present bytes', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ovm-source-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const missing = path.join(directory, 'missing'), present = path.join(directory, 'history "$HOME"'), linked = path.join(directory, 'link');
  const contents = 'ls\nzsh\nls\napt install zsh\nxeit\nexitx\nexit\n';
  await writeFile(present, contents); await symlink(present, linked);
  for (const [source, kind] of [[missing, 'source_absent'], [present, 'source_present'], [linked, 'source_unreadable'], [directory, 'source_not_regular']]) {
    const task = buildSourceTask({ path: source }, { id: 'scout' }, { round: 1 });
    const result = await runCaptured('/bin/sh', ['-c', task.command]);
    const fact = acceptSourceCapture(task, { agent: 'scout', stopped: true, exitCode: 0, output: result.stdout });
    assert.equal(fact.kind, kind); assert.equal(fact.environment.pocket, 'scout'); assert.equal(fact.path, source);
    assert.equal(fact.semanticVerification, false);
    if (kind === 'source_present') assert.equal(fact.sha256, createHash('sha256').update(contents).digest('hex'));
  }
});

test('source binding is explicit and a printed missing marker is not a structured witness', () => {
  assert.deepEqual(normalizeSource('guest:/root/.bash_history'), { scope: 'guest', path: '/root/.bash_history', origin: 'user-selected', status: 'uninspected' });
  assert.throws(() => normalizeSource('host:/Users/another/.zsh_history'), /absolute guest path/);
  assert.throws(() => normalizeSource('made-up-history.log'), /absolute guest path/);
  const task = buildSourceTask({ path: '/root/.bash_history' }, { id: 'scout' }, { round: 1 });
  assert.throws(() => acceptSourceCapture(task, { agent: 'scout', stopped: true, exitCode: 0, output: 'NO_HISTORY_FOUND' }), /No unique structured source witness/);
});
