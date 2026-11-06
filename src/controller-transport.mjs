import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';

export async function selectRsync({ execute = runCaptured, candidates = ['/opt/homebrew/bin/rsync', '/usr/local/bin/rsync', '/usr/bin/rsync'], platform = process.platform } = {}) {
  let rejectedAppleLegacy = false;
  for (const candidate of candidates) {
    try {
      const { stdout } = await execute(candidate, ['--version'], { timeout: 3000, maxBytes: 16_384 });
      const protocol = Number(stdout.match(/protocol version\s*(\d+)/i)?.[1]);
      if (!Number.isInteger(protocol) || protocol < 29) continue;
      const version = stdout.match(/rsync\s+version\s+([\d.]+)/i)?.[1] ?? 'openrsync';
      // Apple's 2.6.9 receiver calls F_PREALLOCATE even with --sparse, inflating
      // checkpoint holes. This is not a protocol-29 limitation: openrsync and
      // upstream Linux rsync remain eligible. openrsync also advertises 2.6.9
      // compatibility, so identify it before rejecting the legacy Apple build.
      if (platform === 'darwin' && candidate === '/usr/bin/rsync' && version === '2.6.9' && !/^openrsync:/im.test(stdout)) {
        rejectedAppleLegacy = true;
        continue;
      }
      return { path: candidate, version, protocol, modern: /^3\./.test(version) };
    } catch { /* Fall back to the installed OS implementation. */ }
  }
  if (rejectedAppleLegacy) throw new Error("Apple's macOS rsync 2.6.9 preallocates sparse VM checkpoints. Install modern rsync with 'brew install rsync', or use a sparse-capable alternative such as openrsync.");
  throw new Error('A working rsync (protocol 29 or newer) is required for stopped VM checkpoints');
}

export function validateHost(host) {
  if (typeof host !== 'string' || !/^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@)?[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(host) || host.length > 253) {
    throw new Error('Use an SSH hostname, Tailscale name, or user@hostname.');
  }
  return host;
}
export const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
export function checkpointRsyncOptions({ rsync, peer, source, destination, seeded, environment = process.env }) {
  if (typeof source !== 'string' || !path.posix.isAbsolute(source) || /[\0\r\n]/.test(source)) throw new Error('Remote checkpoint requires an absolute source path');
  const protectedArguments = rsync.modern && peer.rsyncProtocol >= 30;
  const protocol = rsync.modern && peer.rsyncProtocol >= 31 ? [] : ['--protocol=29'];
  const remoteBinary = peer.rsyncPath ? [`--rsync-path=${shellQuote(peer.rsyncPath)}`] : [];
  // Modern rsync quotes its own remote arguments. Shell-quoting a pathname
  // beforehand sends literal quote characters. -s carries it over the protocol;
  // escape only rsync's remote glob characters so it identifies one exact path.
  const remotePath = protectedArguments ? source.replace(/[\\*?\[\]]/g, '\\$&') : shellQuote(source);
  const env = { ...environment, RSYNC_OLD_ARGS: protectedArguments ? '0' : '1', RSYNC_PROTECT_ARGS: '0' };
  return { args: [...(seeded ? ['-a', '--inplace', '--no-whole-file'] : ['-aS']), ...protocol,
    ...(protectedArguments ? ['-s'] : []), '--partial', seeded ? '--ignore-times' : '--checksum', ...remoteBinary,
    '-e', `ssh ${SSH_OPTIONS.map(shellQuote).join(' ')}`, '--', `${validateHost(peer.host)}:${remotePath}`, destination], env };
}
export function validateControllerNodePath(value) {
  if (typeof value !== 'string' || !path.posix.isAbsolute(value) || value.endsWith('/') || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error('The remote Node interpreter must be an absolute executable path without control characters.');
  }
  return value;
}
export const SSH_OPTIONS = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=3', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2'];

export function runCaptured(command, args, { input, timeout = 10_000, maxBytes = 8 * 1024 * 1024, spawnImpl = spawn, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env, shell: false });
    let stdout = '', stderr = '', settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error(`${command} timed out after ${timeout}ms`)); }, timeout);
    child.stdout.setEncoding?.('utf8');
    child.stderr.setEncoding?.('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > maxBytes) { child.kill('SIGKILL'); finish(new Error(`${command} output exceeded its limit`)); }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16_384); });
    child.once('error', finish);
    child.once('close', (code, signal) => code === 0 ? finish(null, { stdout, stderr }) : finish(new Error(`${command} failed (${code ?? signal}): ${stderr.trim() || stdout.trim()}`)));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export function controllerCommand(peer) {
  const prefix = 'export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; ';
  const node = peer.nodePath === undefined ? 'node' : shellQuote(validateControllerNodePath(peer.nodePath));
  if (peer.root) {
    if (!peer.root.startsWith('/') || /[\0\r\n]/.test(peer.root)) throw new Error('Remote checkout must be an absolute path.');
    return `${prefix}exec ${node} ${shellQuote(`${peer.root}/bin/ovm`)} worker`;
  }
  if (peer.nodePath !== undefined) return `${prefix}if [ -f "$HOME/.local/bin/ovm" ]; then exec ${node} "$HOME/.local/bin/ovm" worker; elif [ -f "$HOME/o-gents/bin/ovm" ]; then exec ${node} "$HOME/o-gents/bin/ovm" worker; elif [ -f "$HOME/vma-gents/bin/ovm" ]; then exec ${node} "$HOME/vma-gents/bin/ovm" worker; elif [ -f "$HOME/claude-vm-mcp/bin/ovm" ]; then exec ${node} "$HOME/claude-vm-mcp/bin/ovm" worker; else echo 'o-gents is not installed on this machine. Use --path for its remote checkout.' >&2; exit 127; fi`;
  return `${prefix}if [ -x "$HOME/.local/bin/ovm" ]; then exec "$HOME/.local/bin/ovm" worker; elif [ -f "$HOME/o-gents/bin/ovm" ]; then exec node "$HOME/o-gents/bin/ovm" worker; elif [ -f "$HOME/vma-gents/bin/ovm" ]; then exec node "$HOME/vma-gents/bin/ovm" worker; elif [ -f "$HOME/claude-vm-mcp/bin/ovm" ]; then exec node "$HOME/claude-vm-mcp/bin/ovm" worker; else echo 'o-gents is not installed on this machine. Install its host adapter first.' >&2; exit 127; fi`;
}

export async function controllerCall(peer, request, { timeout = 8_000, execute = runCaptured } = {}) {
  const payload = { protocol: 'ovm.controller/v1', ...request };
  const result = await execute('ssh', [...SSH_OPTIONS, validateHost(peer.host), controllerCommand(peer)], {
    input: JSON.stringify(payload) + '\n', timeout,
  });
  let response;
  try { response = JSON.parse(result.stdout); } catch { throw new Error(`Invalid OVM controller response from ${peer.host}`); }
  if (response.protocol !== 'ovm.controller/v1') throw new Error(`Incompatible OVM controller on ${peer.host}`);
  if (response.ok !== true) {
    const error = new Error(response.error || 'Remote controller rejected request');
    error.rejected = request.op === 'run' && response.admitted === false && response.id === request.id
      && response.requestHash === createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    throw error;
  }
  return response.result;
}
