import { SwarmVMFleet } from './swarm-vm.mjs';
import { QemuVMFleet } from './qemu-vm.mjs';

export function resolveVMBackend({ backend, environment = process.env, platform = process.platform, architecture = process.arch } = {}) {
  const selected = backend ?? environment.OVM_VM_BACKEND ?? 'auto';
  if (!['auto', 'apple', 'qemu'].includes(selected)) throw new Error('VM backend must be auto, apple, or qemu');
  return selected === 'auto' ? platform === 'darwin' && architecture === 'arm64' ? 'apple' : 'qemu' : selected;
}

/** Both backends execute the same prepared ARM64 guest filesystem. */
export function compatibleVMController(probe, requested = 'auto') {
  if (!['auto', 'apple', 'qemu'].includes(requested)) return false;
  if (probe.backend === 'apple-vz-arm64') return requested !== 'qemu' && probe.platform === 'darwin' && probe.architecture === 'arm64'
    && (probe.guestArchitecture === undefined || probe.guestArchitecture === 'aarch64');
  return requested !== 'apple' && probe.backend === 'qemu-arm64' && probe.guestArchitecture === 'aarch64'
    && ['darwin', 'linux'].includes(probe.platform);
}

export function createVMFleet({ backend, environment = process.env, platform = process.platform, architecture = process.arch,
  supportedBackends, AppleFleet = SwarmVMFleet, QemuFleet = QemuVMFleet, ...options } = {}) {
  const requested = backend ?? environment.OVM_VM_BACKEND ?? 'auto';
  let selected = resolveVMBackend({ backend, environment, platform, architecture });
  if (supportedBackends && !supportedBackends.includes(selected === 'apple' ? 'apple-vz-arm64' : 'qemu-arm64')) {
    if (requested === 'auto' && supportedBackends.includes('qemu-arm64')) selected = 'qemu';
    else throw new Error(`This agent's bundled runtime does not support the ${selected} backend. Use --backend qemu for a QEMU-only capsule.`);
  }
  if (selected === 'apple' && (platform !== 'darwin' || architecture !== 'arm64')) throw new Error('The Apple VM backend requires Apple Silicon macOS. Use --backend qemu on this machine.');
  if (selected === 'qemu' && !['darwin', 'linux'].includes(platform)) throw new Error('The QEMU VM backend currently supports Linux and macOS controllers.');
  const fleet = new (selected === 'apple' ? AppleFleet : QemuFleet)({ ...options, environment });
  fleet.backendSelection = backend ?? environment.OVM_VM_BACKEND ?? 'auto';
  fleet.backend = selected === 'apple' ? 'apple-vz-arm64' : 'qemu-arm64';
  const probe = fleet.probe.bind(fleet);
  fleet.probe = async () => ({ ...await probe(), backend: fleet.backend, guestArchitecture: 'aarch64' });
  return fleet;
}
