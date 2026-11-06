import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { controllerProbe } from './controller-worker.mjs';
import { controllerDiskBudget } from './controller-disk.mjs';
import { VMLease } from './lease.mjs';
import { cloneProvisionBundle, runGuestScript } from './guest-setup.mjs';
import { getGuestStatus } from './guest-manager.mjs';
import { validateBrowserRequest } from '../guest/research-browser.mjs';
import { startBrowserProxy } from './browser-proxy.mjs';

const GiB = 1024 ** 3;
const BROWSER_MEMORY_MB = 2048;
const BROWSER_CPU_COUNT = 2;
const MEMORY_HEADROOM_BYTES = GiB;
const CAPACITY_RETRY = 'Wait for the reported capacity to increase or critical memory pressure to clear, then check status. Repeated setup or browse calls cannot resolve this block; retry execution only after the capacity changes.';
const POCKET = 'aichat-research';
const PLAYWRIGHT_VERSION = '1.63.0';
const MAX_RESULT_BYTES = 512 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function jsonFile(file, maximum = MAX_RESULT_BYTES) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximum) throw new Error(`Invalid browser receipt: ${file}`);
  return JSON.parse(await readFile(file, 'utf8'));
}
async function optionalJson(file) {
  try { return await jsonFile(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function atomicJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await rename(temporary, file);
}

export function validateBrowserInvocation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Browser request must be a JSON object');
  const allowed = new Set(['operation', 'pocket', 'url', 'session', 'actions', 'timeout_ms', 'max_chars']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`Unsupported browser field: ${key}`);
  const operation = value.operation ?? 'browse';
  if (!['browse', 'status', 'setup', 'stop'].includes(operation)) throw new Error('operation must be browse, status, setup, or stop');
  if (value.pocket !== undefined && value.pocket !== POCKET) throw new Error(`This controller owns only pocket ${POCKET}`);
  const session = value.session ?? 'research';
  if (typeof session !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/.test(session)) throw new Error('session must be a 1-48 character slug starting with a letter or digit');
  if (value.url !== undefined) {
    if (typeof value.url !== 'string' || value.url.length > 8192) throw new Error('url must be an HTTP(S) string of at most 8192 characters');
    const url = new URL(value.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('url must use HTTP(S) without credentials');
  }
  if (value.actions !== undefined && (!Array.isArray(value.actions) || value.actions.length > 10)) throw new Error('actions must be an array with at most 10 entries');
  for (const [key, maximum] of [['timeout_ms', 60000], ['max_chars', 30000]]) {
    if (value[key] !== undefined && (!Number.isInteger(value[key]) || value[key] < 1 || value[key] > maximum)) throw new Error(`${key} must be between 1 and ${maximum}`);
  }
  if (Buffer.byteLength(JSON.stringify(value)) > 64 * 1024) throw new Error('Browser request exceeds 64 KiB');
  const { operation: _operation, pocket: _pocket, ...request } = value;
  const normalized = { ...request, session };
  return { operation, request: operation === 'browse' ? validateBrowserRequest(normalized) : normalized };
}

export function browserAdmission(probe, { setup = false } = {}) {
  const diskBudget = controllerDiskBudget(probe, [{ agentId: POCKET }]);
  // The dedicated browser uses a smaller allocation than ordinary shell VMs.
  // Keep 1 GiB RAM headroom and 1 GiB disk growth for initial installation.
  const requiredDiskBytes = diskBudget.requiredBytes + (setup ? GiB : 0);
  const requiredMemoryBytes = BROWSER_MEMORY_MB * 1024 ** 2 + MEMORY_HEADROOM_BYTES;
  const blockers = [];
  if (probe.vmReady !== true || probe.platform !== 'darwin' || probe.backend !== 'apple-vz-arm64') blockers.push(probe.reason ?? 'A prepared Apple Silicon VM controller is required');
  if (!Number.isFinite(probe.freeDiskBytes) || probe.freeDiskBytes < requiredDiskBytes) blockers.push(`Need ${(requiredDiskBytes / GiB).toFixed(2)} GiB free disk for ${setup ? 'setup' : 'browse'}; have ${Number.isFinite(probe.freeDiskBytes) ? (probe.freeDiskBytes / GiB).toFixed(2) : 'unknown'} GiB`);
  if (probe.memoryPressureCritical === true || !Number.isFinite(probe.freeMemoryBytes) || probe.freeMemoryBytes < requiredMemoryBytes) blockers.push(`Need ${requiredMemoryBytes / GiB} GiB available host memory without critical pressure for the ${BROWSER_MEMORY_MB / 1024} GiB browser VM plus ${MEMORY_HEADROOM_BYTES / GiB} GiB headroom`);
  return { allowed: blockers.length === 0, blockers, freeDiskBytes: probe.freeDiskBytes,
    requiredDiskBytes, freeMemoryBytes: probe.freeMemoryBytes, requiredMemoryBytes,
    gate: 'controllerDiskBudget/apple-vz-arm64 plus setup growth; native VM memory plus 1 GiB',
    vmMemoryMB: BROWSER_MEMORY_MB, vmCpuCount: BROWSER_CPU_COUNT,
    memoryHeadroomBytes: MEMORY_HEADROOM_BYTES };
}

const bootstrap = `#!/usr/bin/env bash
set -Eeuo pipefail
export HOME=/root
export PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
if [ -r /etc/profile.d/ovm-env.sh ]; then . /etc/profile.d/ovm-env.sh; fi
ip link set lo up
mkdir -p /mnt/ovm-export /opt/ovm /run
mountpoint -q /mnt/ovm-export || mount -t virtiofs ovmexport /mnt/ovm-export
printf '[ovm-browser] checking guest VSOCK transport driver\\n'
ls -d /sys/bus/virtio/drivers/vmw_vsock_virtio_transport /lib/modules/*/kernel/net/vmw_vsock* 2>&1 || true
vsock_probe() {
  timeout --signal=TERM --kill-after=1s 5s python3 - "$1" <<'OVM_VSOCK_DIAGNOSTIC'
import json, socket, sys
try:
    s = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
    s.settimeout(3)
    s.connect((2, 18080))
    print(json.dumps({'phase':sys.argv[1], 'vsock_connect':True}), flush=True)
    s.close()
except OSError as e:
    print(json.dumps({'phase':sys.argv[1], 'vsock_connect':False, 'errno':e.errno, 'error':str(e)}), flush=True)
OVM_VSOCK_DIAGNOSTIC
}
vsock_probe before_module || true
if modprobe -v vmw_vsock_virtio_transport; then
  printf '[ovm-browser] VSOCK transport module ready\\n'
else
  printf '[ovm-browser] module loader reported failure; checking whether the transport is built in\\n'
fi
vsock_probe after_module || true
install -m 0644 /mnt/ovm-provision/research-proxy.py /opt/ovm/research-proxy.py
rm -f /run/ovm-browser-proxy.json
python3 /opt/ovm/research-proxy.py --ready-file /run/ovm-browser-proxy.json > /tmp/ovm-browser-proxy.log 2>&1 &
proxy_pid=$!
trap 'kill "$proxy_pid" 2>/dev/null || true; wait "$proxy_pid" 2>/dev/null || true; cp /tmp/ovm-browser-proxy.log /mnt/ovm-export/proxy.log 2>/dev/null || true' EXIT
export HTTP_PROXY=http://127.0.0.1:18080
export HTTPS_PROXY=$HTTP_PROXY
export http_proxy=$HTTP_PROXY
export https_proxy=$HTTP_PROXY
export NO_PROXY=localhost,127.0.0.1
export no_proxy=$NO_PROXY
export npm_config_proxy=$HTTP_PROXY
export npm_config_https_proxy=$HTTP_PROXY
export npm_config_progress=false
export OVM_BROWSER_PROXY=$HTTP_PROXY
printf '[ovm-browser] verifying private VSOCK proxy transport\\n'
timeout --signal=TERM --kill-after=2s 20s python3 - <<'OVM_BROWSER_PROXY_PROOF'
import json, os, pathlib, time, urllib.request
ready = pathlib.Path('/run/ovm-browser-proxy.json')
for _ in range(100):
    if ready.exists(): break
    time.sleep(.1)
else: raise SystemExit('OVM_BROWSER_NETWORK_UNAVAILABLE: guest proxy failed to start')
proxy = os.environ['HTTP_PROXY']
client = urllib.request.build_opener(urllib.request.ProxyHandler({'http': proxy, 'https': proxy}))
with client.open('http://ovm-browser-proxy.internal/health', timeout=10) as response:
    result = json.load(response)
    if result.get('ok') is not True or result.get('transport') != 'vsock_proxy':
        raise SystemExit('OVM_BROWSER_NETWORK_UNAVAILABLE: host proxy proof failed')
print('[ovm-browser] private VSOCK proxy transport verified')
OVM_BROWSER_PROXY_PROOF
export PLAYWRIGHT_MODULE=/opt/ovm-browser/node_modules/playwright/index.mjs
export PLAYWRIGHT_BROWSERS_PATH=/opt/ovm-browser/browsers
export OVM_BROWSER_PROFILE=/root/.local/share/ovm/research-browser
export OVM_BROWSER_NO_SANDBOX=1
`;

export function browserSetupScript() {
  return `${bootstrap}
test "$(df -Pk / | awk 'NR==2 {print $4}')" -ge 1048576
mkdir -p /opt/ovm-browser /opt/ovm
cd /opt/ovm-browser
export DEBIAN_FRONTEND=noninteractive
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
printf '[ovm-browser] installing Playwright ${PLAYWRIGHT_VERSION}\\n'
npm install --omit=dev --no-audit --no-fund --ignore-scripts --save-exact playwright@${PLAYWRIGHT_VERSION}
printf '[ovm-browser] installing Chromium headless shell and dependencies\\n'
node node_modules/playwright/cli.js install --with-deps --only-shell chromium
install -m 0644 /mnt/ovm-provision/research-browser.mjs /opt/ovm/research-browser.mjs
node --input-type=module <<'OVM_BROWSER_SMOKE'
import { chromium } from '/opt/ovm-browser/node_modules/playwright/index.mjs';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const browser = await chromium.launch({headless:true,args:['--no-sandbox']});
try {
  const page = await browser.newPage();
  await page.setContent('<title>OVM browser ready</title><button id="b">Run</button><div id="result"></div><script>document.querySelector("#b").onclick=()=>document.querySelector("#result").textContent="rendered"</script>');
  await page.locator('#b').click();
  if (await page.locator('#result').textContent() !== 'rendered') throw new Error('Browser JavaScript smoke failed');
  const o = spawnSync('/usr/local/bin/O', ['--eval', 'python^(__oval_result__ = 1 + 1)_python', '/opt/ostadix/backends'], {encoding:'utf8',timeout:20000,maxBuffer:65536});
  if (o.error || o.status !== 0) throw new Error('Guest Ostadix execution failed: ' + (o.error?.message || o.stderr || String(o.status)));
  const ostadix = {exit_code:o.status,source:'python^(__oval_result__ = 1 + 1)_python',stdout:o.stdout.slice(0,4096),stderr:o.stderr.slice(0,4096)};
  await writeFile('/mnt/ovm-export/setup.json', JSON.stringify({schema:'ovm.browser-setup/v1',verified:true,playwright:require('/opt/ovm-browser/node_modules/playwright/package.json').version,chromium:browser.version(),javascript:true,ostadix}));
} finally { await browser.close(); }
OVM_BROWSER_SMOKE
printf '[ovm-browser] JavaScript smoke passed\\n'
command -v O
test -d /opt/ostadix/backends
apt-get clean
sync
`;
}

export function browserRunScript() {
  return `${bootstrap}
timeout --signal=TERM --kill-after=5s 120s node /opt/ovm/research-browser.mjs < /mnt/ovm-provision/request.json > /mnt/ovm-export/result.json
sync
`;
}

export async function runBrowser(value, { root, probe = controllerProbe, clone = cloneProvisionBundle,
  executeGuest = runGuestScript, guestStatus = getGuestStatus, startProxy = startBrowserProxy,
  Lease = VMLease, monitor = true } = {}) {
  const { operation, request } = validateBrowserInvocation(value);
  root = path.resolve(root);
  const directory = path.join(root, 'vm/pockets', POCKET);
  const bundlePath = path.join(directory, 'browser.bundle');
  const lease = new Lease(`${bundlePath}.mcp.lease`, { resource: 'AIChat browser VM' });
  const marker = path.join(directory, 'browser-ready.json');
  const stopFile = path.join(directory, 'stop-request.json');
  const worker = path.join(root, 'guest/research-browser.mjs');
  const proxyWorker = path.join(root, 'guest/research-proxy.py');
  const ready = await optionalJson(marker);
  const owner = await lease.inspect();
  const availability = await probe(root, { backend: 'apple' });
  const resources = browserAdmission(availability, { setup: operation === 'setup' });
  const workerHash = hash(await readFile(worker));
  const proxyWorkerHash = hash(await readFile(proxyWorker));
  const image = await lstat(path.join(bundlePath, 'rootfs.img')).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  const privateRuntime = image ? await guestStatus({ projectRoot: root, bundlePath }) : null;
  const runtimeMatches = privateRuntime?.prepared === true && privateRuntime.verified === true
    && privateRuntime.needsUpdate === false && privateRuntime.profile?.recipeSha256 === availability.recipeSha256;
  const prepared = image?.isFile() === true && !image.isSymbolicLink()
    && ready?.verified === true && ready.workerSha256 === workerHash
    && ready.proxyWorkerSha256 === proxyWorkerHash
    && ready.baseRecipeSha256 === availability.recipeSha256 && runtimeMatches;
  const common = { pocket: POCKET, bundlePath, session: request.session, resources, transport: 'vsock_proxy',
    persistence: 'Private root disk, browser profile, cookies, local storage, and last URL persist. Each call boots and stops its VM; page DOM and processes restart.' };
  if (operation === 'status') return { ...common, status: owner.held ? (owner.alive ? 'busy' : 'stale_lease') : prepared ? 'ready' : 'setup_required',
    ready: prepared, controllerLease: owner, installation: ready,
    privateRuntime: privateRuntime ? { verified: privateRuntime.verified, needsUpdate: privateRuntime.needsUpdate, sourceCommit: privateRuntime.profile?.sourceCommit, recipeSha256: privateRuntime.profile?.recipeSha256, matchesBase: runtimeMatches } : null,
    lastRun: await optionalJson(path.join(directory, 'last-run.json')) };
  if (operation === 'stop') {
    if (!owner.held) return { ...common, status: 'stopped', stopped: true };
    if (!owner.alive) return { ...common, status: 'stale_lease', stopped: false, error: 'Inspect the stale lease and native VM process before recovery; no process was signaled.' };
    // Cooperative cancellation is addressed to the current lease token; it
    // cannot accidentally signal a reused OS PID or an unrelated O job.
    const held = await jsonFile(lease.lockPath);
    await atomicJson(stopFile, { token: held.token, requestedAt: new Date().toISOString() });
    return { ...common, status: 'stop_requested', stopped: false, uncertain: true, message: 'Cancellation requested. Poll status for VM shutdown; the last action may already have executed.' };
  }
  if (owner.held) return { ...common, status: owner.alive ? 'busy' : 'stale_lease', isError: true, controllerLease: owner, error: 'This browser pocket already has a controller lease; do not replay a pending action.' };
  if (operation === 'setup' && prepared) return { ...common, resources: browserAdmission(availability), status: 'ready', ready: true, changed: false, installation: ready };
  if (!resources.allowed) return { ...common, status: 'resource_blocked', isError: true, error: resources.blockers.join('; '), requires_capacity_change: true, retry: CAPACITY_RETRY };
  if (image && !runtimeMatches) return { ...common, status: 'runtime_update_required', isError: true,
    error: 'The private browser VM Ostadix runtime does not match the current prepared base; browser setup cannot certify it by changing a receipt.',
    retry: 'Upgrade the stopped private rootfs with the native upgradePreparedImage API, then rerun browser setup. Preserve the profile disk.' };
  if (operation === 'browse' && !prepared) return { ...common, status: 'setup_required', isError: true, next: { operation: 'setup' }, error: 'Run gent browser with operation=setup to prepare or refresh this dedicated browser pocket.' };
  await lease.acquire();
  let logPath = null, transactionStarted = false, cancellation = null, timer = null, proxy = null;
  try {
    const rechecked = browserAdmission(await probe(root, { backend: 'apple' }), { setup: operation === 'setup' });
    if (!rechecked.allowed) return { ...common, resources: rechecked, status: 'resource_blocked', isError: true, error: rechecked.blockers.join('; '), requires_capacity_change: true, retry: CAPACITY_RETRY };
    const runDirectory = path.join(directory, 'runs', `${Date.now()}-${randomUUID()}`);
    const sharePath = path.join(runDirectory, 'input');
    const exportShare = path.join(runDirectory, 'output');
    await mkdir(sharePath, { recursive: true, mode: 0o700 });
    await mkdir(exportShare, { recursive: true, mode: 0o700 });
    logPath = path.join(runDirectory, 'guest.log');
    if (operation === 'setup') {
      await unlink(marker).catch(error => { if (error.code !== 'ENOENT') throw error; });
      if (!(await lstat(bundlePath).catch(error => { if (error.code === 'ENOENT') return null; throw error; }))) {
        const baseLease = new Lease(`${path.join(root, 'vm/claudevm.bundle')}.mcp.lease`, { resource: 'built-in VM image' });
        await baseLease.acquire();
        const staging = path.join(directory, `.clone-${randomUUID()}.bundle`);
        try { await clone(root, staging); await rename(staging, bundlePath); } finally { await baseLease.release(); }
      }
      await copyFile(worker, path.join(sharePath, 'research-browser.mjs'));
    } else {
      await writeFile(path.join(sharePath, 'request.json'), JSON.stringify(request), { flag: 'wx', mode: 0o600 });
    }
    await copyFile(proxyWorker, path.join(sharePath, 'research-proxy.py'));
    proxy = await startProxy();
    // The native runner installs a SIGTERM handler that kills only its child.
    // Keep the controller alive to retain an honest uncertain result afterward.
    if (monitor) timer = setInterval(async () => {
      try {
        const requested = await optionalJson(stopFile);
        const current = await probe(root, { backend: 'apple' });
        if (requested?.token === lease.token) cancellation ??= 'Browser execution cancelled by stop request';
        if (current.freeDiskBytes < 2 * GiB) cancellation ??= 'Browser execution stopped because free disk fell below the native 2 GiB reserve';
        if (cancellation && process.listenerCount('SIGTERM')) process.emit('SIGTERM');
      } catch { /* Final receipt and explicit deadline still bound execution. */ }
    }, 2000);
    transactionStarted = true;
    await executeGuest({ projectRoot: root, bundlePath, sharePath, exportShare, logPath,
      proxyUnixSocket: proxy.socketPath, memoryMB: BROWSER_MEMORY_MB, cpuCount: BROWSER_CPU_COUNT,
      script: operation === 'setup' ? browserSetupScript() : browserRunScript(),
      timeoutMs: operation === 'setup' ? 540000 : 180000 });
    if (cancellation) throw new Error(cancellation);
    const receipt = await jsonFile(path.join(exportShare, operation === 'setup' ? 'setup.json' : 'result.json'));
    if (operation === 'setup') {
      if (receipt.schema !== 'ovm.browser-setup/v1' || receipt.verified !== true || receipt.javascript !== true || receipt.playwright !== PLAYWRIGHT_VERSION || receipt.ostadix?.exit_code !== 0) throw new Error('Browser setup did not produce the required Chromium JavaScript and Ostadix execution evidence');
      const installation = { ...receipt, preparedAt: new Date().toISOString(), workerSha256: workerHash, proxyWorkerSha256: proxyWorkerHash, transport: 'vsock_proxy',
        baseRecipeSha256: availability.recipeSha256, baseSourceCommit: availability.sourceCommit };
      await atomicJson(marker, installation);
      return { ...common, status: 'ready', ready: true, changed: true, installation, logPath, proxyMetrics: { ...proxy.metrics } };
    }
    if (!receipt || typeof receipt !== 'object' || typeof receipt.status !== 'string') throw new Error('Guest browser returned an invalid result');
    await atomicJson(path.join(directory, 'last-run.json'), { status: receipt.status, finishedAt: new Date().toISOString(), logPath, resultPath: path.join(exportShare, 'result.json') });
    return { ...receipt, ...common, logPath, resultPath: path.join(exportShare, 'result.json'), proxyMetrics: { ...proxy.metrics } };
  } catch (error) {
    const result = { ...common, status: transactionStarted ? 'execution_uncertain' : 'setup_failed', isError: true,
      uncertain: transactionStarted, error: cancellation ?? error.message, logPath,
      ...(proxy ? { proxyMetrics: { ...proxy.metrics } } : {}),
      retry: transactionStarted ? 'Inspect the retained log and current browser state before repeating an action; the guest may already have acted.' : 'Resolve the reported setup problem before retrying.' };
    await atomicJson(path.join(directory, 'last-run.json'), result).catch(() => {});
    return result;
  } finally {
    if (timer) clearInterval(timer);
    try { if (proxy) await proxy.close(); }
    finally { await lease.release(); }
  }
}

export async function runBrowserCLI(argv, { root, output = process.stdout, run = runBrowser } = {}) {
  let result;
  try {
    if (argv.length !== 1) throw new Error('Usage: gent browser \'{"operation":"status|setup|browse|stop",...}\'');
    result = await run(JSON.parse(argv[0]), { root });
  } catch (error) { result = { status: 'invalid_request', isError: true, error: error.message }; }
  output.write(`${JSON.stringify(result)}\n`);
  // AIChat must receive a valid failure receipt instead of discarding stdout.
  return 0;
}
