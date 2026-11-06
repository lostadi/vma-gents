import test from 'node:test';
import assert from 'node:assert/strict';
import { hostMemory, parseMacMemory } from '../src/host-resources.mjs';
import { selectRsync } from '../src/controller-transport.mjs';
const pages = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 100.\nPages inactive: 2000.\nPages speculative: 300.\nPages purgeable: 900.\nPages occupied by compressor: 99999.\n';

test('macOS capacity counts reclaimable pages once and excludes compressor/purgeable overlap', () => {
  assert.equal(parseMacMemory(pages), 2400 * 16384);
  assert.throws(() => parseMacMemory(pages.replace('Pages inactive: 2000.\n', '')), /inactive/);
});
test('critical memory pressure overrides reclaimable capacity while failed observation falls back conservatively', async () => {
  const execute = async command => ({ stdout: command.endsWith('vm_stat') ? pages : '4\n' });
  assert.equal((await hostMemory({ platform: 'darwin', rawFree: 123, total: 1e9, execute })).availableMemoryBytes, 0);
  const normal = await hostMemory({ platform: 'darwin', rawFree: 123, total: 1e9, execute: async command => ({ stdout: command.endsWith('vm_stat') ? pages : '1\n' }) });
  assert.equal(normal.availableMemoryBytes, 2400 * 16384); assert.equal(normal.memoryPressureCritical, false);
  const missing = await hostMemory({ platform: 'darwin', rawFree: 123, total: 1e9, execute: async () => { throw new Error('unavailable'); } });
  assert.equal(missing.availableMemoryBytes, 123);
});
test('rsync selection validates advertised protocol and falls back to the OS executable', async () => {
  const selected = await selectRsync({ candidates: ['/modern', '/legacy'], execute: async command => ({ stdout: command === '/modern' ? 'rsync  version 3.5.1  protocol version 33' : 'openrsync: protocol version 29' }) });
  assert.equal(selected.path, '/modern'); assert.equal(selected.modern, true);
  const fallback = await selectRsync({ candidates: ['/missing', '/legacy'], execute: async command => { if (command === '/missing') throw new Error('missing'); return { stdout: 'openrsync: protocol version 29' }; } });
  assert.equal(fallback.path, '/legacy'); assert.equal(fallback.protocol, 29);
});
