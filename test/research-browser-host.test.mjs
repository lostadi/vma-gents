import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { browserAdmission, browserRunScript, browserSetupScript, runBrowser, runBrowserCLI, validateBrowserInvocation } from '../src/research-browser.mjs';
import { runGent } from '../src/gent-cli.mjs';
import { VMLease } from '../src/lease.mjs';

const GiB = 1024 ** 3;
const available = { vmReady: true, platform: 'darwin', backend: 'apple-vz-arm64',
  freeDiskBytes: 4 * GiB, freeMemoryBytes: 8 * GiB, memoryPressureCritical: false,
  recipeSha256: 'b'.repeat(64), sourceCommit: 'a'.repeat(40), minimumFreeDiskBytesPerGuest: 0 };

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ovm-browser-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'guest'));
  await writeFile(path.join(root, 'guest/research-browser.mjs'), '// example guest worker');
  await writeFile(path.join(root, 'guest/research-proxy.py'), '# example proxy worker');
  await mkdir(path.join(root, 'vm/claudevm.bundle'), { recursive: true });
  await writeFile(path.join(root, 'vm/claudevm.bundle/rootfs.img'), 'base');
  const calls = [], clones = [];
  const options = { root, monitor: false, probe: async () => ({ ...available }),
    guestStatus: async () => ({ prepared: true, verified: true, needsUpdate: false, profile: { recipeSha256: available.recipeSha256, sourceCommit: available.sourceCommit } }),
    clone: async (source, target) => {
      clones.push({ source, target });
      const owner = await new VMLease(path.join(root, 'vm/claudevm.bundle.mcp.lease')).inspect();
      assert.equal(owner.held, true, 'base lease held across clone');
      await mkdir(target);
      await writeFile(path.join(target, 'rootfs.img'), 'private clone');
    },
    executeGuest: async request => {
      calls.push(request);
      assert.equal(request.memoryMB, 2048);
      assert.equal(request.cpuCount, 2);
      assert.match(request.proxyUnixSocket, /^\/tmp\/ovm-web-.*\/proxy.sock$/);
      assert.notEqual(request.bundlePath, path.join(root, 'vm/claudevm.bundle'));
      const lease = await new VMLease(`${request.bundlePath}.mcp.lease`).inspect();
      assert.equal(lease.held, true);
      if (request.script.includes('npm install')) {
        await writeFile(path.join(request.exportShare, 'setup.json'), JSON.stringify({
          schema: 'ovm.browser-setup/v1', verified: true, javascript: true, playwright: '1.63.0', chromium: 'test', ostadix: { exit_code: 0, stdout: '2' } }));
      } else {
        await writeFile(path.join(request.exportShare, 'result.json'), JSON.stringify({ status: 'ok', page_content: 'Rendered source', metadata: { rendered: true } }));
      }
    }, ...overrides };
  return { root, calls, clones, options };
}

test('native APFS disk budget and browser setup growth are enforced without accepting unknown resources', () => {
  assert.equal(browserAdmission(available).requiredDiskBytes, 2 * GiB);
  assert.equal(browserAdmission(available, { setup: true }).requiredDiskBytes, 3 * GiB);
  for (const override of [{ freeDiskBytes: GiB }, { freeMemoryBytes: GiB }, { memoryPressureCritical: true },
    { vmReady: false }, { freeDiskBytes: NaN }, { freeMemoryBytes: undefined }, { backend: 'qemu-arm64' }]) {
    assert.equal(browserAdmission({ ...available, ...override }).allowed, false);
  }
  assert.equal(browserAdmission({ ...available, freeDiskBytes: 2.5 * GiB }).allowed, true);
  assert.equal(browserAdmission({ ...available, freeDiskBytes: 2.5 * GiB }, { setup: true }).allowed, false);
});

test('dedicated browser admits 2 GiB RAM and two CPUs with exactly 1 GiB memory headroom', () => {
  const admission = browserAdmission({ ...available, freeMemoryBytes: 3 * GiB });
  assert.equal(admission.allowed, true);
  assert.equal(admission.vmMemoryMB, 2048);
  assert.equal(admission.vmCpuCount, 2);
  assert.equal(admission.memoryHeadroomBytes, GiB);
  assert.equal(admission.requiredMemoryBytes, admission.vmMemoryMB * 1024 ** 2 + admission.memoryHeadroomBytes);
  for (const freeMemoryBytes of [4.7 * GiB, 5 * GiB, 5.1 * GiB]) {
    assert.equal(browserAdmission({ ...available, freeMemoryBytes }).allowed, true);
  }
  for (const freeMemoryBytes of [3 * GiB - 1, NaN, Infinity, undefined]) {
    const blocked = browserAdmission({ ...available, freeMemoryBytes });
    assert.equal(blocked.allowed, false);
    assert.match(blocked.blockers.join('; '), /3 GiB.*2 GiB.*1 GiB headroom/);
  }
  assert.equal(browserAdmission({ ...available, freeMemoryBytes: 3 * GiB, memoryPressureCritical: true }).allowed, false);
});

test('host validates actions before any VM work and cannot accept environment/profile/shell overrides', () => {
  for (const input of [null, [], { profile: '/tmp' }, { operation: 'exec' }, { pocket: '../base' },
    { session: '../elsewhere' }, { url: 'file:///etc/passwd' }, { url: 'https://u:p@example.com' },
    { actions: [{ type: 'evaluate', value: 'arbitrary()' }] }, { timeout_ms: '60000' },
    { actions: [{ type: 'fill', selector: '#field' }] }, { max_chars: 30001 }]) {
    assert.throws(() => validateBrowserInvocation(input));
  }
  const request = validateBrowserInvocation({ url: 'https://example.com', actions: [{ type: 'fill', selector: '#q', value: "x; $(shell) ' literal" }] });
  assert.equal(request.request.actions[0].value, "x; $(shell) ' literal");
  assert.equal(request.request.session, 'research');
});

test('status and unprepared browse never create a clone or boot a VM', async t => {
  const context = await fixture(t);
  assert.equal((await runBrowser({ operation: 'status' }, context.options)).status, 'setup_required');
  assert.equal((await runBrowser({ url: 'https://example.com' }, context.options)).status, 'setup_required');
  assert.deepEqual(context.calls, []);
  assert.deepEqual(context.clones, []);
  assert.deepEqual((await readdir(path.join(context.root, 'vm'))), ['claudevm.bundle']);
});

test('resource refusal occurs before clone, directory allocation or VM boot', async t => {
  const context = await fixture(t, { probe: async () => ({ ...available, freeDiskBytes: GiB }) });
  const result = await runBrowser({ operation: 'setup' }, context.options);
  assert.equal(result.status, 'resource_blocked');
  assert.match(result.error, /Need 3.00 GiB/);
  assert.equal(result.requires_capacity_change, true);
  assert.match(result.retry, /only after the capacity changes/);
  assert.deepEqual(context.calls, []);
  assert.deepEqual(context.clones, []);
});

test('setup creates a private clone under source lease and browser calls reuse it with literal JSON', async t => {
  const context = await fixture(t);
  const setup = await runBrowser({ operation: 'setup' }, context.options);
  assert.equal(setup.status, 'ready');
  assert.equal(setup.installation.playwright, '1.63.0');
  assert.equal(setup.resources.vmMemoryMB, context.calls[0].memoryMB);
  assert.equal(setup.resources.vmCpuCount, context.calls[0].cpuCount);
  assert.equal(context.calls[0].timeoutMs, 540000);
  assert.equal(context.clones.length, 1);
  assert.equal(await readFile(path.join(context.root, 'vm/claudevm.bundle/rootfs.img'), 'utf8'), 'base');
  assert.equal((await runBrowser({ operation: 'setup' }, context.options)).changed, false);
  const input = { url: 'https://example.com', session: 'research', actions: [{ type: 'fill', selector: '#q', value: '$(touch /bad); $HOME' }] };
  const result = await runBrowser(input, context.options);
  assert.equal(result.status, 'ok');
  assert.equal(result.metadata.rendered, true);
  assert.equal(result.resources.vmMemoryMB, context.calls[1].memoryMB);
  assert.equal(result.resources.vmCpuCount, context.calls[1].cpuCount);
  assert.equal(context.clones.length, 1);
  assert.equal(context.calls.length, 2);
  assert.equal(context.calls[1].bundlePath, context.calls[0].bundlePath);
  assert.equal(context.calls[1].timeoutMs, 180000);
  assert.ok(!context.calls[1].script.includes(input.actions[0].value));
  assert.equal(JSON.parse(await readFile(path.join(context.calls[1].sharePath, 'request.json'))).actions[0].value, input.actions[0].value);
  const status = await runBrowser({ operation: 'status' }, context.options);
  assert.equal(status.ready, true);
  assert.equal(status.controllerLease.held, false);
  assert.equal(status.lastRun.status, 'ok');
});

test('failed setup cannot publish readiness and failed browse remains explicitly uncertain without replay', async t => {
  const context = await fixture(t);
  const original = context.options.executeGuest;
  context.options.executeGuest = async req => { await original(req); await writeFile(path.join(req.exportShare, 'setup.json'), '{}'); };
  assert.equal((await runBrowser({ operation: 'setup' }, context.options)).status, 'execution_uncertain');
  assert.equal((await runBrowser({ operation: 'status' }, context.options)).ready, false);
  context.options.executeGuest = original;
  await runBrowser({ operation: 'setup' }, context.options);
  let count = 0;
  context.options.executeGuest = async () => { count++; throw new Error('guest disconnected'); };
  const failure = await runBrowser({ url: 'https://example.com' }, context.options);
  assert.equal(failure.uncertain, true);
  assert.equal(count, 1);
  assert.match(failure.retry, /before repeating/);
  assert.equal((await runBrowser({ operation: 'status' }, context.options)).controllerLease.held, false);
});

test('already prepared setup is a no-op below the installation-growth disk threshold', async t => {
  const context = await fixture(t);
  await runBrowser({ operation: 'setup' }, context.options);
  context.options.probe = async () => ({ ...available, freeDiskBytes: 2.5 * GiB });
  const again = await runBrowser({ operation: 'setup' }, context.options);
  assert.equal(again.status, 'ready');
  assert.equal(again.changed, false);
  assert.equal(again.resources.requiredDiskBytes, 2 * GiB);
  assert.equal(context.calls.length, 1);
  assert.equal(context.clones.length, 1);
});

test('admission is rechecked under exclusive lease before clone or boot', async t => {
  let calls = 0;
  const context = await fixture(t, { probe: async () => ({ ...available, freeDiskBytes: ++calls === 1 ? 4 * GiB : GiB }) });
  const result = await runBrowser({ operation: 'setup' }, context.options);
  assert.equal(result.status, 'resource_blocked');
  assert.equal(result.requires_capacity_change, true);
  assert.match(result.retry, /only after the capacity changes/);
  assert.deepEqual(context.clones, []);
  assert.deepEqual(context.calls, []);
});

test('a live source VM lease prevents cloning and live browser lease serializes sessions', async t => {
  const context = await fixture(t);
  const baseLease = new VMLease(path.join(context.root, 'vm/claudevm.bundle.mcp.lease'));
  await baseLease.acquire();
  const setup = await runBrowser({ operation: 'setup' }, context.options);
  assert.equal(setup.status, 'setup_failed');
  assert.deepEqual(context.clones, []);
  await baseLease.release();
  await runBrowser({ operation: 'setup' }, context.options);
  const ownLease = new VMLease(path.join(context.root, 'vm/pockets/aichat-research/browser.bundle.mcp.lease'));
  await ownLease.acquire();
  try {
    const result = await runBrowser({ url: 'https://example.com' }, context.options);
    assert.equal(result.status, 'busy');
    const stop = await runBrowser({ operation: 'stop' }, context.options);
    assert.equal(stop.status, 'stop_requested');
    assert.equal(stop.stopped, false);
    assert.equal(JSON.parse(await readFile(path.join(context.root, 'vm/pockets/aichat-research/stop-request.json'))).token, ownLease.token);
  } finally { await ownLease.release(); }
  assert.equal((await runBrowser({ operation: 'stop' }, context.options)).stopped, true);
});

test('worker updates invalidate readiness instead of running an old copied worker', async t => {
  const context = await fixture(t);
  await runBrowser({ operation: 'setup' }, context.options);
  await writeFile(path.join(context.root, 'guest/research-browser.mjs'), '// updated worker');
  assert.equal((await runBrowser({ url: 'https://example.com' }, context.options)).status, 'setup_required');
});

test('a stale private Ostadix runtime cannot be certified by rerunning browser setup', async t => {
  const context = await fixture(t);
  await runBrowser({ operation: 'setup' }, context.options);
  context.options.guestStatus = async () => ({ prepared: true, verified: true, needsUpdate: true, profile: { recipeSha256: 'c'.repeat(64) } });
  const status = await runBrowser({ operation: 'status' }, context.options);
  assert.equal(status.ready, false);
  assert.equal(status.privateRuntime.matchesBase, false);
  const setup = await runBrowser({ operation: 'setup' }, context.options);
  assert.equal(setup.status, 'runtime_update_required');
  assert.equal(context.calls.length, 1);
});

test('gent dispatch retains one literal JSON argument and CLI failures retain valid stdout JSON at exit zero', async () => {
  const raw = JSON.stringify({ url: 'https://example.com/?q=$(literal)' });
  let invocation;
  await runGent(['browser', raw], { root: '/project path', run: async (...args) => { invocation = args; return 0; } });
  assert.deepEqual(invocation[1], ['/project path/bin/ovm-browser', raw]);
  let output = '';
  const code = await runBrowserCLI(['{invalid'], { root: '/unused', output: { write: text => output += text } });
  assert.equal(code, 0);
  assert.equal(JSON.parse(output).isError, true);
  assert.equal(JSON.parse(output).status, 'invalid_request');
  output = '';
  await runBrowserCLI([raw], { root: '/unused', output: { write: text => output += text }, run: async () => ({ status: 'resource_blocked', isError: true }) });
  assert.equal(JSON.parse(output).status, 'resource_blocked');
});

test('provisioning uses pinned headless Chromium and action data never enters the shell script', () => {
  assert.match(browserSetupScript(), /playwright@1\.63\.0/);
  assert.match(browserSetupScript(), /--with-deps --only-shell chromium/);
  assert.match(browserSetupScript(), /apt-get clean/);
  assert.match(browserSetupScript(), /python\^\(__oval_result__ = 1 \+ 1\)_python/);
  assert.match(browserSetupScript(), /o.status !== 0/);
  assert.match(browserRunScript(), /< \/mnt\/ovm-provision\/request.json/);
  assert.match(browserRunScript(), /120s node/);
  assert.match(browserRunScript(), /ovm-browser-proxy.internal\/health/);
  assert.match(browserRunScript(), /OVM_BROWSER_PROXY=\$HTTP_PROXY/);
  assert.ok(!browserRunScript().includes('dhclient'));
});
