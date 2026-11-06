import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { guestRunnerArguments, runGuestScript } from '../src/guest-setup.mjs';

const input = { projectRoot: '/project path', bundlePath: '/private/browser.bundle', sharePath: '/input path' };

test('ordinary guest runner leaves memory and CPU arguments unspecified for native defaults', () => {
  assert.deepEqual(guestRunnerArguments(input), [
    '--bundle', '/private/browser.bundle', '--smol', '/project path/host/smol-bin.arm64.img',
    '--share', '/input path', '--network', 'nat', '--provision',
  ]);
});

test('explicit browser allocation is forwarded as literal native arguments beside private proxy options', () => {
  assert.deepEqual(guestRunnerArguments({ ...input, memoryMB: 2048, cpuCount: 2,
    exportShare: '/output path', proxyUnixSocket: '/private proxy/socket' }), [
    '--bundle', '/private/browser.bundle', '--smol', '/project path/host/smol-bin.arm64.img',
    '--share', '/input path', '--network', 'isolated', '--provision',
    '--export-share', '/output path', '--proxy-socket', '/private proxy/socket',
    '--memory-mb', '2048', '--cpu-count', '2',
  ]);
  assert.deepEqual(guestRunnerArguments({ ...input, cpuCount: 1 }).slice(-2), ['--cpu-count', '1']);
  assert.deepEqual(guestRunnerArguments({ ...input, memoryMB: 512 }).slice(-2), ['--memory-mb', '512']);
  assert.deepEqual(guestRunnerArguments({ ...input, memoryMB: 8192, cpuCount: 8 }).slice(-4),
    ['--memory-mb', '8192', '--cpu-count', '8']);
});

test('invalid resource values are rejected before the guest runner creates files or launches a VM', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ovm-resource-validation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const override of [
    { memoryMB: '2048' }, { memoryMB: null }, { memoryMB: 511 }, { memoryMB: 8193 },
    { memoryMB: 2048.5 }, { memoryMB: NaN }, { memoryMB: Infinity },
    { cpuCount: '2' }, { cpuCount: null }, { cpuCount: 0 }, { cpuCount: 9 },
    { cpuCount: 1.5 }, { cpuCount: NaN }, { cpuCount: Infinity },
  ]) {
    assert.throws(() => guestRunnerArguments({ ...input, ...override }), /must be an integer/);
    await assert.rejects(runGuestScript({ projectRoot: root, bundlePath: '/unused',
      sharePath: root, logPath: path.join(root, 'logs/guest.log'), script: 'true', ...override }), /must be an integer/);
  }
  assert.deepEqual(await readdir(root), []);
});
