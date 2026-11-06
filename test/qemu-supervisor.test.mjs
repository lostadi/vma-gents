import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const supervisor = fileURLToPath(new URL('../host/qemu-supervisor.py', import.meta.url));
const python = process.env.OVM_TEST_PYTHON || 'python3';
const options = { timeout: 20_000, skip: process.platform === 'win32' };

async function eventually(check, message, timeout = 7000) {
  const deadline = Date.now() + timeout;
  do {
    const result = await check();
    if (result) return result;
    await delay(25);
  } while (Date.now() < deadline);
  assert.fail(message);
}
async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
}
async function live(pid) {
  try {
    const { stdout } = await execute('ps', ['-o', 'stat=', '-p', String(pid)]);
    // Orphaned grandchildren may remain zombies briefly until the host reaps them.
    return stdout.trim() !== '' && !stdout.trim().startsWith('Z');
  } catch (error) { if (error.code === 1) return false; throw error; }
}
function stop(pid, signal = 'SIGKILL') {
  if (!Number.isInteger(pid) || pid <= 1) return;
  try { process.kill(pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
}
async function beat(file) {
  try { return await readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ovm-qemu-supervisor-'));
  const workerScript = path.join(directory, 'dummy-vm.py');
  const controllerScript = path.join(directory, 'controller.py');
  const workerRecord = path.join(directory, 'worker.json');
  const supervisorRecord = path.join(directory, 'supervisor.json');
  const leaderBeat = path.join(directory, 'leader.beat');
  const leafBeat = path.join(directory, 'leaf.beat');
  const unrelatedBeat = path.join(directory, 'unrelated.beat');
  let controller, unrelated, owned = {};
  t.after(async () => {
    // These PIDs came only from this fixture; never enumerate or kill real QEMU.
    stop(controller?.pid);
    stop(owned.supervisorPid, 'SIGTERM');
    for (const pid of [owned.workerPid, owned.leafPid, unrelated?.pid]) stop(pid);
    if (owned.supervisorPid) await eventually(async () => !await live(owned.supervisorPid), 'owned supervisor did not stop during cleanup');
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(workerScript, `import json, os, subprocess, sys, time
from pathlib import Path
if sys.argv[1] == '--leaf':
    heartbeat = Path(sys.argv[2])
else:
    leaf = subprocess.Popen([sys.executable, __file__, '--leaf', sys.argv[4]])
    Path(sys.argv[1]).write_text(json.dumps({'workerPid': os.getpid(), 'leafPid': leaf.pid, 'group': os.getpgrp()}))
    heartbeat = Path(sys.argv[3])
while True:
    if sys.argv[1] != '--leaf' and Path(sys.argv[1] + '.exit').exists():
        sys.exit(int(Path(sys.argv[1] + '.exit').read_text()))
    heartbeat.write_text(str(time.monotonic_ns()))
    time.sleep(0.02)
`);
  await writeFile(controllerScript, `import json, os, subprocess, sys, time
from pathlib import Path
child = subprocess.Popen([sys.executable, sys.argv[1], str(os.getpid()), sys.executable, *sys.argv[3:]], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
Path(sys.argv[2]).write_text(json.dumps({'supervisorPid': child.pid}))
code = child.wait()
Path(sys.argv[2] + '.exit').write_text(str(code))
while True:
    time.sleep(1)
`);
  unrelated = spawn(python, [workerScript, '--leaf', unrelatedBeat], { stdio: 'ignore' });
  controller = spawn(python, [controllerScript, supervisor, supervisorRecord,
    workerScript, workerRecord, 'unused', leaderBeat, leafBeat], { stdio: 'ignore' });
  // Attach listeners now, including launch errors, before waiting on fixture files.
  let launchError;
  for (const child of [controller, unrelated]) child.on('error', error => { launchError = error; });
  owned = await eventually(async () => {
    if (launchError) throw launchError;
    const wrapper = await readJson(supervisorRecord);
    const workers = await readJson(workerRecord);
    if (wrapper) owned = { ...owned, ...wrapper };
    if (workers) owned = { ...owned, ...workers };
    if (!wrapper || !workers || !await beat(leaderBeat) || !await beat(leafBeat) || !await beat(unrelatedBeat)) return false;
    return { ...wrapper, ...workers };
  }, 'dummy VM and child did not start');
  assert.equal(owned.group, owned.workerPid, 'supervised work owns its own process group');
  return { controller, unrelated, owned, leaderBeat, leafBeat, unrelatedBeat, supervisorRecord, workerRecord };
}

for (const trigger of ['supervisor SIGTERM', 'controller SIGKILL']) {
  test(`${trigger} stops the owned VM group while unrelated work survives`, options, async t => {
    const f = await fixture(t);
    const unrelatedBefore = await beat(f.unrelatedBeat);
    if (trigger === 'supervisor SIGTERM') stop(f.owned.supervisorPid, 'SIGTERM');
    else f.controller.kill('SIGKILL');
    await eventually(async () => {
      const alive = await Promise.all([f.owned.supervisorPid, f.owned.workerPid, f.owned.leafPid].map(live));
      return alive.every(value => !value);
    }, 'supervisor or owned VM descendants survived shutdown');
    assert.equal(await live(f.unrelated.pid), true);
    await eventually(async () => await beat(f.unrelatedBeat) !== unrelatedBefore, 'unrelated process heartbeat stopped');
    const frozen = await Promise.all([beat(f.leaderBeat), beat(f.leafBeat)]);
    await delay(100);
    assert.deepEqual(await Promise.all([beat(f.leaderBeat), beat(f.leafBeat)]), frozen);
    if (trigger === 'supervisor SIGTERM') {
      assert.equal(await live(f.controller.pid), true, 'stopping one VM must not kill its controller');
      assert.equal(await eventually(async () => await beat(f.supervisorRecord + '.exit'), 'controller did not reap supervisor'), '137');
    }
  });
}

for (const exitCode of [0, 7]) {
  test(`normal leader exit ${exitCode} cleans up surviving descendants and preserves status`, options, async t => {
    const f = await fixture(t);
    const unrelatedBefore = await beat(f.unrelatedBeat);
    await writeFile(f.workerRecord + '.exit', String(exitCode));
    await eventually(async () => {
      const alive = await Promise.all([f.owned.supervisorPid, f.owned.workerPid, f.owned.leafPid].map(live));
      return alive.every(value => !value);
    }, 'owned descendant survived its VM group leader');
    assert.equal(await eventually(async () => await beat(f.supervisorRecord + '.exit'), 'controller did not reap supervisor'), String(exitCode));
    assert.equal(await live(f.controller.pid), true);
    assert.equal(await live(f.unrelated.pid), true);
    await eventually(async () => await beat(f.unrelatedBeat) !== unrelatedBefore, 'unrelated process heartbeat stopped');
    const frozen = await beat(f.leafBeat);
    await delay(100);
    assert.equal(await beat(f.leafBeat), frozen);
  });
}

test('supervisor preserves a normal child exit status', options, async () => {
  await assert.rejects(execute(python, [supervisor, String(process.pid), python, '-c', 'import sys; sys.exit(7)']), error => {
    assert.equal(error.code, 7);
    return true;
  });
});

test('supervisor refuses to launch when its expected controller is already absent', options, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ovm-qemu-absent-parent-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const marker = path.join(directory, 'should-not-exist');
  await assert.rejects(execute(python, [supervisor, '-1', python, '-c',
    'from pathlib import Path; import sys; Path(sys.argv[1]).write_text("unexpected launch")', marker]), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /controller disappeared before QEMU launch/);
    return true;
  });
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});
