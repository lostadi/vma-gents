const GiB = 1024 ** 3;
const bytes = value => Number.isSafeInteger(value) && value >= 0;

/** Additional space needed while live roots and their stopped snapshot coexist. */
export function controllerDiskBudget(availability, tasks) {
  if (availability.platform !== 'linux' || availability.backend !== 'qemu-arm64') {
    return { requiredBytes: Math.max(2 * GiB, (availability.minimumFreeDiskBytesPerGuest ?? 0) * tasks.length) };
  }
  const legacyMinimum = availability.minimumFreeDiskBytesPerGuest;
  const baseBytes = bytes(availability.baseRootfsAllocatedBytes) ? availability.baseRootfsAllocatedBytes
    : bytes(availability.baseRootfsBytes) ? availability.baseRootfsBytes
      : bytes(legacyMinimum) && legacyMinimum > GiB ? Math.ceil((legacyMinimum - GiB) / 2) : Infinity;
  const logicalBaseBytes = bytes(availability.baseRootfsBytes) ? availability.baseRootfsBytes : baseBytes;
  const disks = new Map();
  for (const file of availability.state?.disks ?? []) {
    if (!/^[a-zA-Z0-9_-]+\.rootfs\.img$/.test(file.name) || disks.has(file.name)) return { requiredBytes: Infinity };
    disks.set(file.name, bytes(file.allocatedBytes) ? file.allocatedBytes : bytes(file.size) ? file.size : baseBytes);
  }
  // Older probes may expose only names. Count each such disk conservatively;
  // an absent allocation count must never make a known family disappear.
  for (const name of availability.state?.files ?? []) {
    if (/^[a-zA-Z0-9_-]+\.rootfs\.img$/.test(name) && !disks.has(name)) disks.set(name, logicalBaseBytes);
  }
  const existingSnapshotBytes = [...disks.values()].reduce((sum, value) => sum + value, 0);
  let newRootBytes = 0;
  for (const task of tasks) {
    const name = `${task.agentId}.rootfs.img`;
    if (disks.has(name)) continue;
    const parent = task.parentId ? `${task.parentId}.rootfs.img` : null;
    const size = parent ? disks.get(parent) ?? logicalBaseBytes : baseBytes;
    newRootBytes += size;
    disks.set(name, size);
  }
  const safetyBytes = Math.max(1, tasks.length) * GiB;
  return { requiredBytes: Math.max(2 * GiB, existingSnapshotBytes + 2 * newRootBytes + safetyBytes),
    existingSnapshotBytes, newRootBytes, safetyBytes };
}
