import os from 'node:os';
import { runCaptured } from './controller-transport.mjs';

export function parseMacMemory(text) {
  const pageSize = Number(text.match(/page size of (\d+) bytes/)?.[1]);
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0) throw new Error('Unknown macOS VM page size');
  let pages = 0;
  for (const name of ['free', 'inactive', 'speculative']) {
    const count = Number(text.match(new RegExp(`^Pages ${name}:\\s+(\\d+)\\.?$`, 'm'))?.[1]);
    if (!Number.isSafeInteger(count) || count < 0) throw new Error(`Unknown macOS ${name} page count`);
    pages += count;
  }
  return pages * pageSize;
}

export async function hostMemory({ platform = process.platform, execute = runCaptured, rawFree = os.freemem(), total = os.totalmem() } = {}) {
  const result = { availableMemoryBytes: rawFree, rawFreeMemoryBytes: rawFree, memoryEstimate: 'OS free pages', memoryPressureCritical: false };
  if (platform !== 'darwin') return result;
  const [pages, pressure] = await Promise.allSettled([
    execute('/usr/bin/vm_stat', [], { timeout: 2000 }),
    execute('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], { timeout: 2000 }),
  ]);
  if (pages.status === 'fulfilled') {
    try { result.availableMemoryBytes = Math.min(total, parseMacMemory(pages.value.stdout)); result.memoryEstimate = 'macOS free + inactive + speculative pages; excludes compressor and wired memory'; }
    catch { /* Keep the conservative OS-free fallback if vm_stat changes. */ }
  }
  if (pressure.status === 'fulfilled') {
    const level = Number(pressure.value.stdout.trim());
    // This sysctl returns dispatch flags, not the internal pressure enum:
    // apple-oss-distributions/xnu bsd/sys/event_private.h defines critical as 4.
    if (Number.isInteger(level)) { result.memoryPressureLevel = level; result.memoryPressureCritical = (level & 4) !== 0; }
  }
  if (result.memoryPressureCritical) result.availableMemoryBytes = 0;
  return result;
}
export async function availableHostMemory() { return (await hostMemory()).availableMemoryBytes; }
