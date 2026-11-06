import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { parseTaskInput, taskArguments } from './user-cli.mjs';
import { pocketId } from './swarm-protocol.mjs';
import { shellQuote } from './controller-transport.mjs';

export async function runAgentChat(argv, { root, run, output = process.stdout, progress = process.stderr,
  input = process.stdin, environment = process.env, signals = process, createLines = createInterface } = {}) {
  const { mission, flags, values } = parseTaskInput(argv, { missionOptional: true });
  if (values.has('--spec')) throw new Error('Use gent task --spec for a team specification. VM chat uses one persistent gent.');
  if (values.has('--agents') && values.get('--agents') !== '1') throw new Error('VM chat uses one gent. Use gent task --agents N for a team.');
  if (values.has('--resume') && values.has('--swarm-id') && values.get('--resume') !== values.get('--swarm-id')) throw new Error('Choose one saved gent with --resume; do not combine it with a different --swarm-id.');
  const id = pocketId(values.get('--resume') || values.get('--swarm-id') || `chat-${randomUUID().slice(0, 8)}`);
  const stateRoot = path.resolve(values.get('--state-dir') || path.join(root, 'vm/pockets'));
  const stateFile = path.join(stateRoot, id, 'swarm.json');
  if (values.has('--resume') && !existsSync(stateFile)) throw new Error(`No saved gent ${id} at ${stateFile}. Use gent list.`);
  let saved = existsSync(stateFile);
  const resumeCommand = `gent chat --resume ${id}${values.has('--state-dir') ? ` --state-dir ${shellQuote(stateRoot)}` : ''}`;
  if (!mission && flags.includes('--json')) throw new Error('Use gent chat "your message" --json for one machine-readable turn.');
  const continuing = flags.filter((value, index) => !['--resume', '--swarm-id'].includes(value) && (index === 0 || !['--resume', '--swarm-id'].includes(flags[index - 1])));
  const optionEnd = argv.indexOf('--');
  const isolated = (optionEnd < 0 ? argv : argv.slice(0, optionEnd)).includes('--isolated');
  let turnRunning = false, interrupted = false;
  const turn = async message => {
    if (saved && !existsSync(stateFile)) throw new Error(`Saved gent ${id} disappeared from ${stateFile}; refusing to replace its VM with a fresh one.`);
    const args = taskArguments([...continuing, ...(existsSync(stateFile) ? ['--resume', id] : ['--swarm-id', id]), '--', message]);
    if (!values.has('--rounds')) args.push('--rounds', '6');
    let code;
    turnRunning = true;
    try {
      code = await run(process.execPath, [path.join(root, 'bin/ovm-pocket'), ...args, '--interactive-turn'], {
        cwd: process.cwd(), env: { ...environment, ...(isolated ? { OVM_NETWORK_MODE: 'isolated' } : {}) },
      });
    } finally { turnRunning = false; }
    saved ||= existsSync(stateFile);
    if (code && code !== 2) progress.write(`This turn stopped with exit ${code}.${existsSync(stateFile) ? ` Its saved state remains at ${stateFile}.` : ' No saved gent state was created.'}\n`);
    return code;
  };
  if (mission) return turn(mission);
  progress.write(`o-gents chat: ${id}\nThis gent can execute commands in its persistent Linux VM.\n/bye exits; /status shows its saved state; /help lists commands.\nUse gent chat --text for conversation without execution.\n`);
  const terminal = Boolean(input.isTTY && output.isTTY);
  const lines = createLines({ input, output: terminal ? output : undefined, terminal });
  // Readline consumes Ctrl+C in raw terminal mode. Forward it through the same
  // process event runChild already uses, preserving its normal child lifecycle.
  lines.on('SIGINT', () => {
    interrupted = true;
    if (turnRunning) signals.emit('SIGINT');
    else lines.close();
  });
  if (terminal) { lines.setPrompt('you> '); lines.prompt(); }
  try {
    for await (const line of lines) {
      const message = line.trim();
      if (['/bye', '/exit', '/quit'].includes(message)) break;
      if (message === '/help') output.write('/bye — leave; /status — show saved state. Every message continues this same gent and VM.\n');
      else if (message === '/status') output.write(`Gent: ${id}\nState: ${stateFile}${existsSync(stateFile) ? '' : ' (not saved yet)'}\nResume: ${resumeCommand}\n`);
      else if (message) {
        const code = await turn(message);
        if (interrupted) return 130;
        if (code === 130 || code === 143) return code;
      }
      if (terminal) lines.prompt();
    }
  } finally { lines.close(); }
  output.write(existsSync(stateFile) ? `Saved gent: ${id}\nContinue with: ${resumeCommand}\n` : 'Chat ended. No gent state was saved.\n');
  return interrupted ? 130 : 0;
}
