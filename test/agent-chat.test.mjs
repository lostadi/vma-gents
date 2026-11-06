import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { runAgentChat } from '../src/agent-chat.mjs';
import { runUserCommand } from '../src/user-cli.mjs';

const sink = () => ({ text: '', write(value) { this.text += value; } });
test('chat defaults to one executable VM agent and preserves exact prompt data', async () => {
  let call;
  await runUserCommand('chat', ['--local', 'Run Node; print "$HOME"'], { root: '/tmp/ovm-chat-test', run: async (...args) => { call = args; return 0; } });
  assert.equal(call[0], process.execPath); assert.equal(call[1][0], '/tmp/ovm-chat-test/bin/ovm-pocket');
  assert.ok(call[1].includes('--interactive-turn')); assert.ok(call[1].includes('--local'));
  assert.equal(call[1][call[1].indexOf('--mission') + 1], 'Run Node; print "$HOME"');
  assert.equal(call[1][call[1].indexOf('--agents') + 1], '1');
});

test('interactive chat resumes the same saved agent after its first message', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ovm-chat-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = sink(), progress = sink(), calls = [];
  const code = await runAgentChat(['--local', '--swarm-id', 'conversation'], { root, output, progress, input: Readable.from(['write a file\n', 'read that file\n', '/bye\n']),
    run: async (_file, args) => {
      calls.push(args);
      const directory = path.join(root, 'vm/pockets/conversation');
      await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, 'swarm.json'), '{}');
      return 0;
    },
  });
  assert.equal(code, 0); assert.equal(calls.length, 2);
  assert.ok(calls[0].includes('--swarm-id')); assert.ok(calls[1].includes('--resume'));
  assert.equal(calls[1][calls[1].indexOf('--resume') + 1], 'conversation');
  assert.match(progress.text, /can execute commands/); assert.match(output.text, /Saved gent: conversation/);
});

test('text mode stays separate and missing resume never silently creates a replacement', async () => {
  let file;
  await runUserCommand('chat', ['--text', 'Explain Node'], { root: '/tmp/ovm-chat-test', errorOutput: sink(), run: async command => { file = command; return 0; } });
  assert.equal(file, 'ollama');
  await assert.rejects(runAgentChat(['--resume', 'missing'], { root: '/tmp/ovm-no-such-agent', run: async () => assert.fail('missing resume cannot launch') }), /No saved gent/);
  await assert.rejects(runUserCommand('chat', ['--vm', '--text'], {}), /Choose either/);
});

test('chat retains custom state locations and accepts literal flag-like messages', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ovm-chat-custom-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateRoot = path.join(root, 'my saved agents');
  await mkdir(path.join(stateRoot, 'existing'), { recursive: true });
  await writeFile(path.join(stateRoot, 'existing', 'swarm.json'), '{}');
  const output = sink(); let invocation;
  await runAgentChat(['--state-dir', stateRoot, '--resume', 'existing'], {
    root, output, progress: sink(), environment: { OVM_NETWORK_MODE: 'nat' }, input: Readable.from(['--isolated\n', '/status\n', '/bye\n']),
    run: async (...args) => { invocation = args; return 0; },
  });
  assert.equal(invocation[1][invocation[1].indexOf('--mission') + 1], '--isolated');
  assert.equal(invocation[1][invocation[1].indexOf('--resume') + 1], 'existing');
  assert.equal(invocation[2].env.OVM_NETWORK_MODE, 'nat');
  assert.ok(output.text.includes(`--state-dir '${stateRoot}'`));
});

test('leaving an empty chat does not claim that an agent was saved', async () => {
  const output = sink();
  await runAgentChat([], { root: '/tmp/ovm-empty-chat', output, progress: sink(), input: Readable.from(['/bye\n']), run: async () => assert.fail('empty chat cannot launch') });
  assert.match(output.text, /No gent state was saved/); assert.doesNotMatch(output.text, /Saved gent:/);
  let invocation;
  await runUserCommand('chat', ['--', '--text'], { root: '/tmp/ovm', run: async (...args) => { invocation = args; return 0; } });
  assert.equal(invocation[0], process.execPath); assert.equal(invocation[1][invocation[1].indexOf('--mission') + 1], '--text');
});

test('raw-terminal Ctrl+C reaches the existing child signal path and ends the chat', async () => {
  const signals = new EventEmitter(), lines = new EventEmitter(); let closed = false, forwarded = 0;
  lines.close = () => { closed = true; };
  lines[Symbol.asyncIterator] = async function* () { yield 'a running turn'; assert.fail('interrupted chat cannot launch another turn'); };
  const code = await runAgentChat([], { root: '/tmp/ovm-chat-signal-test', output: sink(), progress: sink(), signals,
    input: Readable.from([]), createLines: () => lines,
    run: async () => new Promise(resolve => {
      signals.once('SIGINT', () => { forwarded++; resolve(130); });
      queueMicrotask(() => lines.emit('SIGINT'));
    }),
  });
  assert.equal(code, 130); assert.equal(forwarded, 1); assert.equal(closed, true);
});
