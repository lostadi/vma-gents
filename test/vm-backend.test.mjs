import test from 'node:test';
import assert from 'node:assert/strict';
import { createVMFleet, resolveVMBackend, compatibleVMController } from '../src/vm-backend.mjs';

test('automatic fleet selection follows the host; explicit selection overrides environment', () => {
  assert.equal(resolveVMBackend({ environment: {}, platform: 'darwin', architecture: 'arm64' }), 'apple');
  for (const [platform, architecture] of [['linux', 'x64'], ['linux', 'arm64'], ['darwin', 'x64']]) {
    assert.equal(resolveVMBackend({ environment: {}, platform, architecture }), 'qemu');
  }
  assert.equal(resolveVMBackend({ backend: 'qemu', environment: { OVM_VM_BACKEND: 'apple' } }), 'qemu');
  assert.equal(resolveVMBackend({ backend: 'auto', environment: { OVM_VM_BACKEND: 'apple' }, platform: 'linux', architecture: 'x64' }), 'qemu');
  assert.throws(() => resolveVMBackend({ backend: 'docker' }), /auto, apple, or qemu/);
});

test('factory preserves agent state and preparation hooks on either selected backend', async () => {
  class Apple { constructor(options) { Object.assign(this, options); } async probe() { return { family: this.stateDirectory }; } }
  class Qemu extends Apple {}
  const prepareRuntime = async () => {};
  for (const backend of ['apple', 'qemu']) {
    const fleet = createVMFleet({ backend, environment: {}, platform: 'darwin', architecture: 'arm64', AppleFleet: Apple, QemuFleet: Qemu,
      stateDirectory: '/saved/family', bundlePath: '/saved/imported/capsule-runtime', prepareRuntime });
    assert.equal(fleet instanceof Qemu, backend === 'qemu');
    assert.equal(fleet.bundlePath, '/saved/imported/capsule-runtime');
    assert.equal(fleet.prepareRuntime, prepareRuntime);
    assert.deepEqual(await fleet.probe(), { family: '/saved/family', backend: backend === 'apple' ? 'apple-vz-arm64' : 'qemu-arm64', guestArchitecture: 'aarch64' });
  }
  assert.throws(() => createVMFleet({ backend: 'apple', platform: 'linux', architecture: 'x64' }), /Apple Silicon/);
});

test('cross-host admission requires a compatible guest architecture and respects explicit backend', () => {
  const qemu = { backend: 'qemu-arm64', platform: 'linux', architecture: 'x64', guestArchitecture: 'aarch64' };
  assert.equal(compatibleVMController(qemu), true);
  assert.equal(compatibleVMController(qemu, 'qemu'), true);
  assert.equal(compatibleVMController(qemu, 'apple'), false);
  assert.equal(compatibleVMController({ ...qemu, guestArchitecture: 'x86_64' }), false);
  assert.equal(compatibleVMController({ ...qemu, guestArchitecture: undefined }), false);
  assert.equal(compatibleVMController({ backend: 'apple-vz-arm64', platform: 'darwin', architecture: 'x64' }), false);
});

test('automatic resume chooses a compatible capsule backend while explicit overrides remain explicit', () => {
  class Dummy { async probe() { return {}; } }
  const options = { environment: {}, platform: 'darwin', architecture: 'arm64', supportedBackends: ['qemu-arm64'], AppleFleet: Dummy, QemuFleet: Dummy };
  assert.equal(createVMFleet(options).backend, 'qemu-arm64');
  assert.equal(createVMFleet({ ...options, backend: 'auto' }).backendSelection, 'auto');
  assert.throws(() => createVMFleet({ ...options, backend: 'apple' }), /QEMU-only capsule/);
  assert.throws(() => createVMFleet({ ...options, environment: { OVM_VM_BACKEND: 'apple' } }), /QEMU-only capsule/);
  assert.equal(createVMFleet({ ...options, supportedBackends: ['apple-vz-arm64', 'qemu-arm64'] }).backend, 'apple-vz-arm64');
});
