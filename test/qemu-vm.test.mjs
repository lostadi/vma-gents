import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseQemuReceipt, qemuArguments, qemuShellReady } from '../src/qemu-vm.mjs';

const command = "cat <<'SOURCE'\nreason:: remains command data\nπ = 'quoted'\nSOURCE\n";
const specification = { token: 'test-invocation-unique-token', agentId: 'builder', command, maximumOutputBytes: 65536 };
const output = 'Observed π and 🐧\n\0binary separator\n';
function receipt(overrides = {}) {
  return {
    schema: 'ovm.qemu-worker/v1', token: specification.token, agent: specification.agentId,
    commandSha256: createHash('sha256').update(command).digest('hex'),
    bootstrapExitCode: 0, exitCode: 0, error: null,
    outputBase64: Buffer.from(output).toString('base64'), outputTruncated: false,
    meshReady: false, execMs: 12.75, ...overrides,
  };
}
const line = record => `OVM_QEMU_RECEIPT:${JSON.stringify(record)}\r\n`;
const parse = (record, options = specification) => parseQemuReceipt(line(record), options);
function values(args, option) {
  return args.flatMap((value, index) => value === option ? [args[index + 1]] : []);
}
function argumentsFor(overrides = {}) {
  return qemuArguments({ tools: { accelerator: 'tcg' }, bundlePath: '/private/guest bundle',
    rootfs: '/private/pocket,with "quotes".img', seed: '/private/seed,readonly.img',
    memoryMB: 1024, cpuCount: 2, networkMode: 'nat', distributionMode: 'auto', ...overrides });
}

test('QEMU direct boot preserves disk paths and keeps the task seed read-only', () => {
  const args = argumentsFor();
  assert.deepEqual(values(args, '-machine'), ['virt,accel=tcg,gic-version=3']);
  assert.deepEqual(values(args, '-cpu'), ['max']);
  assert.deepEqual(values(args, '-m'), ['1024']);
  assert.deepEqual(values(args, '-smp'), ['2']);
  assert.deepEqual(values(args, '-kernel'), [path.join('/private/guest bundle', 'vmlinuz')]);
  assert.deepEqual(values(args, '-initrd'), [path.join('/private/guest bundle', 'initrd')]);
  const blocks = values(args, '-blockdev').map(value => JSON.parse(value));
  assert.equal(blocks.find(block => block['node-name'] === 'rootfile').filename, '/private/pocket,with "quotes".img');
  assert.notEqual(blocks.find(block => block['node-name'] === 'rootfile')['read-only'], true);
  assert.equal(blocks.find(block => block['node-name'] === 'rootdisk').file, 'rootfile');
  assert.equal(blocks.find(block => block['node-name'] === 'seedfile').filename, '/private/seed,readonly.img');
  assert.equal(blocks.find(block => block['node-name'] === 'seedfile')['read-only'], true);
  assert.equal(blocks.find(block => block['node-name'] === 'seeddisk')['read-only'], true);
  const kernel = values(args, '-append')[0].split(' ');
  for (const required of ['root=LABEL=cloudimg-rootfs', 'console=ttyAMA0', 'init=/bin/bash', 'ovm.network=nat', 'ovm.distribution=auto']) assert.ok(kernel.includes(required), required);
  assert.ok(!kernel.includes('--login'), 'login hooks must not run before the seed is mounted');
  assert.deepEqual(values(args, '-serial'), ['stdio']);
  assert.deepEqual(values(args, '-monitor'), ['none']);
  assert.deepEqual(values(args, '-netdev'), ['user,id=nat']);
  assert.ok(values(args, '-device').includes('virtio-net-pci,netdev=nat'));
});

test('isolated accelerated guests have no virtual network interface', () => {
  for (const accelerator of ['hvf', 'kvm']) {
    const args = argumentsFor({ tools: { accelerator }, networkMode: 'isolated', distributionMode: 'local' });
    assert.deepEqual(values(args, '-machine'), [`virt,accel=${accelerator},gic-version=3`]);
    assert.deepEqual(values(args, '-cpu'), ['host']);
    assert.deepEqual(values(args, '-nic'), ['none']);
    assert.equal(values(args, '-netdev').length, 0);
    assert.equal(values(args, '-device').some(value => value.startsWith('virtio-net')), false);
    assert.match(values(args, '-append')[0], /ovm.network=isolated ovm.distribution=local/);
  }
});

test('receipts retain exact observed UTF-8 bytes and bind the exact script', () => {
  const result = parseQemuReceipt('[kernel] boot messages\r\n' + line(receipt()), specification);
  assert.equal(result.output, output);
  assert.equal(result.outputBytes, Buffer.byteLength(output));
  assert.equal(result.commandSha256, createHash('sha256').update(command).digest('hex'));
  assert.equal(result.exitCode, 0);
  assert.equal(result.meshReady, false);
  for (const privateField of ['token', 'schema', 'outputBase64']) assert.equal(Object.hasOwn(result, privateField), false);
  assert.throws(() => parse(receipt(), { ...specification, command: command.trimEnd() }), /Invalid QEMU execution receipt/);
});

test('only one receipt from the current invocation can establish an observation', () => {
  const other = receipt({ token: 'older-invocation' });
  assert.equal(parseQemuReceipt(line(other) + line(receipt()), specification).output, output);
  for (const consoleText of ['', line(other), line(receipt()) + line(receipt())]) {
    assert.throws(() => parseQemuReceipt(consoleText, specification), /exactly one matching guest receipt/);
  }
  assert.throws(() => parseQemuReceipt('OVM_QEMU_RECEIPT:{"token":\n', specification), SyntaxError);
});

test('known failures remain observations without becoming successful task receipts', () => {
  for (const status of [1, 124, 255, -9]) {
    const result = parse(receipt({ exitCode: status }));
    assert.equal(result.exitCode, status);
    assert.equal(result.error, null);
  }
  for (const bootstrapExitCode of [null, 1, -9]) {
    const result = parse(receipt({ bootstrapExitCode, exitCode: null, error: 'bootstrap unavailable', outputBase64: '' }));
    assert.equal(result.bootstrapExitCode, bootstrapExitCode);
    assert.equal(result.exitCode, null);
    assert.equal(result.output, '');
  }
  assert.equal(parse(receipt({ exitCode: 124, error: 'deadline; partial effects may exist', outputTruncated: true })).outputTruncated, true);
});

test('malformed identity, statuses, readiness and timing never pass as a receipt', async t => {
  const cases = [
    ['wrong schema', { schema: 'unknown/v1' }], ['wrong agent', { agent: 'auditor' }],
    ['wrong command digest', { commandSha256: '0'.repeat(64) }],
    ['missing bootstrap status', { bootstrapExitCode: undefined }], ['string bootstrap status', { bootstrapExitCode: '0' }],
    ['bootstrap status out of range', { bootstrapExitCode: 256 }], ['signal status out of range', { exitCode: -128 }],
    ['missing task status', { exitCode: undefined }], ['fractional task status', { exitCode: 0.5 }],
    ['task status out of range', { exitCode: 256 }], ['null task without error', { exitCode: null }],
    ['failed bootstrap without error', { bootstrapExitCode: 1 }], ['missing error field', { error: undefined }],
    ['object error field', { error: {} }], ['missing truncation field', { outputTruncated: undefined }],
    ['string truncation field', { outputTruncated: 'false' }], ['missing mesh readiness', { meshReady: undefined }],
    ['string mesh readiness', { meshReady: 'false' }], ['nonboolean runtime readiness', { runtimeReady: 'true' }],
    ['object fallback reason', { fallbackReason: {} }], ['negative duration', { execMs: -1 }],
    ['missing duration', { execMs: undefined }], ['infinite duration', { execMs: Infinity }],
    ['string duration', { execMs: '12' }], ['nonstring output', { outputBase64: 123 }],
  ];
  for (const [name, overrides] of cases) {
    await t.test(name, () => assert.throws(() => parse(receipt(overrides)), /Invalid QEMU execution receipt/));
  }
});

test('base64 must be canonical and output limits count bytes, including multibyte text', () => {
  for (const encoding of ['YQ', 'YQ===', 'Y Q==', 'YQ-_', 'YR==']) {
    assert.throws(() => parse(receipt({ outputBase64: encoding })), /Invalid QEMU (execution receipt|output encoding)/);
  }
  const bytes = Buffer.byteLength(output);
  assert.equal(parse(receipt(), { ...specification, maximumOutputBytes: bytes }).outputBytes, bytes);
  assert.throws(() => parse(receipt(), { ...specification, maximumOutputBytes: bytes - 1 }), /exceeds the requested output bound/);
  const result = parse(receipt({ meshReady: true, runtimeReady: true, fallbackReason: null }));
  assert.equal(result.runtimeReady, true);
  assert.equal(result.fallbackReason, null);
});

test('QEMU startup recognizes real Ubuntu root prompts without mistaking boot output for readiness', () => {
  for (const terminal of [
    '[2.2] mounted root\r\nroot@(none):/# ',
    'bash-5.2# ',
    '\u001b[32mroot@guest:/root#\u001b[0m ',
    '[boot]'.repeat(1000) + '\r\nroot@(none):/# ',
  ]) assert.equal(qemuShellReady(terminal), true);
  for (const terminal of [
    '[2.2] mounted root\r\n', 'root@(none):/# not a prompt', 'bash-5.2# running\n',
    'user@guest:~$ ', 'kernel #1 SMP\n',
  ]) assert.equal(qemuShellReady(terminal), false);
});
