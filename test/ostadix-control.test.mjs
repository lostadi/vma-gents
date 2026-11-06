import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { acceptOstadixResult, buildOstadixTask, MAX_OSTADIX_OUTPUT_BYTES, normalizeOstadixAction } from '../src/ostadix-control.mjs';

const execute = promisify(execFile);
const source = 'python^(\n__oval_result__ = 1 + 1\n)_python\n';
const outputCheck = { kind: 'stdout_equals', expected: '[number] 2\n' };
const action = (changes = {}) => ({ type: 'ostadix', source, mode: 'run', checks: [outputCheck], ...changes });
const taskFor = changes => buildOstadixTask(action(changes), { id: 'builder' }, { round: 1 });

const nativeFixture = `#!/usr/bin/env python3
import hashlib, json, os, pathlib, sys
args=sys.argv[1:]
program=next(pathlib.Path(arg) for arg in args if arg.endswith(".O"))
digest=hashlib.sha256(program.read_bytes()).hexdigest()
scenario=os.environ.get("O_GENT_TEST_SCENARIO", "valid")
with open(os.environ["O_GENT_TEST_CALLS"], "a") as log:
 log.write(json.dumps({"tool":pathlib.Path(sys.argv[0]).name,"args":args,"source":program.read_text(),"mode":oct(program.stat().st_mode & 0o777)})+"\\n")
if "--check" in args:
 if scenario == "parse-error":
  print(json.dumps({"ok":False,"stage":"parse","error":"invalid O source"}))
  sys.exit(1)
 structure={"schema":"ostadix.source-structure/v1","required_initial_bindings":["missing"] if scenario == "missing-binding" else [],"top_level_literal_text":scenario == "literal-text","backend_syntax_checks":[{"language":"python","state":"invalid" if scenario == "invalid-syntax" else "skipped" if scenario == "skipped-syntax" else "valid"}]}
 if scenario == "old-diagnostics": del structure["required_initial_bindings"]
 print(json.dumps({"ok":True,"stage":"parse","source_structure":structure}))
elif "--execution-intent-json" in args:
 print(json.dumps({"schema":"oexec.execution-intent/v1","source_sha256":"0"*64 if scenario == "intent-mismatch" else digest,"execution_intent_sha256":"a"*64}))
else:
 assert "--json" not in args
 assert args[args.index("--require-source-sha256")+1] == digest
 assert args[args.index("--require-execution-intent-sha256")+1] == "a"*64
 if scenario == "too-much-output":
  sys.stdout.write("x"*1000000)
 elif scenario == "runtime-failure":
  print("[number] 2")
  print("backend failed",file=sys.stderr)
  sys.exit(7)
 else:
  print("[number] 2")
`;

async function fixture(t, scenario = 'valid') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'o-gent-adapter-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await Promise.all(['O', 'olangc'].map(name => writeFile(path.join(directory, name), nativeFixture, { mode: 0o700 })));
  const callsFile = path.join(directory, 'calls.jsonl');
  return {
    directory,
    environment: { ...process.env, PATH: `${directory}:/usr/bin:/bin`, O_LANG_ROOT: directory, O_BACKENDS_DIR: path.join(directory, 'backends'), O_GENT_TEST_SCENARIO: scenario, O_GENT_TEST_CALLS: callsFile },
    async calls() { return (await readFile(callsFile, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); },
  };
}

async function runTask(task, environment) {
  const { stdout } = await execute('/bin/sh', ['-c', task.command], { env: environment, timeout: 70_000, maxBuffer: 1024 * 1024 });
  const worker = { agent: task.agentId, stopped: true, exitCode: 0, output: stdout };
  return { worker, result: acceptOstadixResult(task, worker) };
}

function rewriteReceipt(task, worker, mutate) {
  const receipt = JSON.parse(worker.output.trim().slice(task.ostadix.token.length));
  mutate(receipt);
  return { ...worker, output: task.ostadix.token + JSON.stringify(receipt) + '\n' };
}

test('Ostadix actions preserve exact source bytes and require bounded explicit run checks', () => {
  const exact = `  ${source}\n`;
  assert.equal(normalizeOstadixAction(action({ source: exact })).source, exact);
  assert.deepEqual(normalizeOstadixAction({ type: 'ostadix', source }), { type: 'ostadix', source, mode: 'check', name: 'program', checks: [] });
  for (const invalid of [
    action({ source: '' }), action({ source: '😀'.repeat(2049) }), action({ source: '\ud800' }),
    action({ name: 'a'.repeat(129) }), action({ mode: 'shell' }), action({ checks: [] }),
    action({ checks: [{ kind: 'exit_code', expected: 0 }] }), action({ checks: Array(9).fill(outputCheck) }),
    action({ checks: [{ kind: 'stdout_contains', expected: '' }] }), action({ checks: [{ kind: 'stdout_equals', expected: 'a'.repeat(4097) }] }),
  ]) assert.throws(() => normalizeOstadixAction(invalid));
});

test('controller-generated source check and native intent inspection never execute the submitted program', async t => {
  const f = await fixture(t);
  const task = taskFor({ mode: 'check', checks: [] });
  const { result } = await runTask(task, f.environment);
  assert.equal(result.executed, false);
  assert.equal(result.checkStatus, 'static-check-passed');
  assert.equal(result.stdout, '');
  assert.equal(result.execution, null);
  const calls = await f.calls();
  assert.equal(calls.length, 2);
  assert.ok(calls[0].args.includes('--check'));
  assert.ok(calls[1].args.includes('--execution-intent-json'));
});

test('bound execution uses exact source, native intent identity and unmodified stdout predicates', async t => {
  const f = await fixture(t);
  const exact = source + "\n# ' \\ \" $(touch SHOULD_NOT_EXIST) `literal` $HOME\n";
  const task = taskFor({ source: exact, name: "a name with quotes ' and / slashes" });
  assert.equal(task.artifactCapture, true);
  const { result } = await runTask(task, f.environment);
  assert.equal(result.executed, true);
  assert.equal(result.checkStatus, 'checks-passed');
  assert.equal(result.success, true);
  assert.equal(result.stdout, '[number] 2\n');
  assert.deepEqual(result.checks, [{ ...outputCheck, passed: true }]);
  const calls = await f.calls();
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.source === exact && call.mode === '0o600'));
  assert.equal(calls[2].args[1], task.ostadix.sourceSha256);
  assert.equal(calls[2].args[3], 'a'.repeat(64));
  await assert.rejects(readFile(calls[0].args.find(arg => arg.endsWith('.O'))), { code: 'ENOENT' });
});

test('embedded backend syntax errors block execution even when O parse returns exit zero and ok true', async t => {
  const f = await fixture(t, 'invalid-syntax');
  const { result } = await runTask(taskFor(), f.environment);
  assert.equal(result.parse.exitCode, 0);
  assert.equal(result.executed, false);
  assert.equal(result.success, false);
  assert.equal(result.checkStatus, 'checks-failed');
  assert.equal(result.diagnostics[0].state, 'invalid');
  assert.equal((await f.calls()).length, 1);
});

test('parse failure and source-mismatched native intent stay observed failures without running source', async t => {
  for (const scenario of ['parse-error', 'intent-mismatch']) {
    const f = await fixture(t, scenario);
    const { result } = await runTask(taskFor(), f.environment);
    assert.equal(result.executed, false);
    assert.equal(result.success, false);
    assert.ok(result.error);
    assert.equal((await f.calls()).length, scenario === 'parse-error' ? 1 : 2);
  }
});

test('undefined bindings, accidental literal text and older incomplete diagnostics block source execution', async t => {
  for (const scenario of ['missing-binding', 'literal-text', 'old-diagnostics']) {
    const f = await fixture(t, scenario);
    const { result } = await runTask(taskFor(), f.environment);
    assert.equal(result.executed, false);
    assert.equal(result.success, false);
    assert.ok(result.error);
    assert.equal((await f.calls()).length, 1);
  }
});

test('skipped static syntax diagnostics stay explicit and do not suppress native execution', async t => {
  const f = await fixture(t, 'skipped-syntax');
  const { result } = await runTask(taskFor(), f.environment);
  assert.equal(result.checkStatus, 'checks-passed');
  assert.equal(result.diagnostics[0].state, 'skipped');
  assert.match(result.meaning, /Skipped syntax diagnostics remain unchecked/);
});

test('unavailable guest O runtime is reported as an unexecuted failure', async t => {
  const f = await fixture(t);
  const { result } = await runTask(taskFor(), { ...f.environment, PATH: '/usr/bin:/bin' });
  assert.equal(result.executed, false);
  assert.equal(result.checkStatus, 'checks-failed');
  assert.match(result.error, /must be installed/);
  assert.equal(result.exitCode, 1);
});

test('matching output from a failed native run cannot pass a check', async t => {
  const f = await fixture(t, 'runtime-failure');
  const { result } = await runTask(taskFor(), f.environment);
  assert.equal(result.executed, true);
  assert.equal(result.exitCode, 7);
  assert.equal(result.stdout, outputCheck.expected);
  assert.equal(result.checkStatus, 'checks-failed');
  assert.equal(result.checks[0].passed, false);
  assert.equal(result.stderr, 'backend failed\n');
});

test('output overflow is bounded and cannot be promoted from a partial matching prefix to success', async t => {
  const f = await fixture(t, 'too-much-output');
  const { result } = await runTask(taskFor({ checks: [{ kind: 'stdout_contains', expected: 'xxxx' }] }), f.environment);
  assert.equal(result.executed, true);
  assert.equal(result.execution.outputLimitExceeded, true);
  assert.equal(result.exitCode, 125);
  assert.equal(result.checks[0].passed, false);
  assert.ok(Buffer.byteLength(result.stdout) <= MAX_OSTADIX_OUTPUT_BYTES);
});

test('receipt correlation, source identity and static-versus-run distinctions fail closed', async t => {
  const f = await fixture(t);
  const task = taskFor();
  const { worker } = await runTask(task, f.environment);
  for (const altered of [
    { ...worker, agent: 'someone-else' }, { ...worker, stopped: false }, { ...worker, exitCode: 1 },
    { ...worker, output: worker.output + worker.output }, { ...worker, output: worker.output.slice(0, -8) },
    rewriteReceipt(task, worker, receipt => { receipt.sourceSha256 = '0'.repeat(64); }),
    rewriteReceipt(task, worker, receipt => { receipt.mode = 'check'; }),
    rewriteReceipt(task, worker, receipt => { receipt.intent = null; }),
  ]) assert.throws(() => acceptOstadixResult(task, altered));
  const timedOut = rewriteReceipt(task, worker, receipt => { receipt.execution.timedOut = true; });
  assert.equal(acceptOstadixResult(task, timedOut).checkStatus, 'checks-failed');
  const staticTask = taskFor({ mode: 'check', checks: [] });
  const wrongStatic = rewriteReceipt(task, worker, receipt => { receipt.mode = 'check'; });
  wrongStatic.output = wrongStatic.output.replace(task.ostadix.token, staticTask.ostadix.token);
  assert.throws(() => acceptOstadixResult(staticTask, wrongStatic), /unexpected execution/);
});

test('installed native O checks and executes a benign source using its real execution-intent gate', async t => {
  try {
    await execute('O', ['--check', '--json', '/dev/null'], { timeout: 5000 });
    await execute('olangc', ['--help'], { timeout: 5000 });
  } catch {
    t.skip('Optional installed Ostadix runtime is unavailable');
    return;
  }
  const task = taskFor();
  const checked = await runTask(taskFor({ mode: 'check', checks: [] }), process.env);
  assert.equal(checked.result.executed, false);
  assert.equal(checked.result.checkStatus, 'static-check-passed');
  const invalid = await runTask(taskFor({ source: 'python^(\nif :\n)_python\n' }), process.env);
  assert.equal(invalid.result.parse.exitCode, 0);
  assert.equal(invalid.result.executed, false);
  assert.equal(invalid.result.success, false);
  assert.ok(invalid.result.diagnostics.some(diagnostic => diagnostic.state === 'invalid'));
  const { result } = await runTask(task, process.env);
  assert.equal(result.checkStatus, 'checks-passed', JSON.stringify({ error: result.error, parse: result.parse, intent: result.intent, execution: result.execution }));
  assert.equal(result.executed, true);
  assert.equal(result.sourceSha256, task.ostadix.sourceSha256);
  assert.equal(result.stdout, '[number] 2\n');
  assert.equal(result.executionIntentSha256.length, 64);
});
