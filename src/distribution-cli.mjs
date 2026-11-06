import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { controllerCall, runCaptured, validateHost, validateControllerNodePath } from './controller-transport.mjs';
import { distributionDirectory, readDistributionSettings, saveDistributionSettings, validateDistributionMode } from './distribution-config.mjs';
import { exportController, networkStatus, startNetwork } from './guest-network.mjs';

export const distributionHelp = `Control where your gents run:
  gent mode                         Show the saved mode
  gent mode auto                    Use this machine; use connected VM hosts when needed
  gent mode local                   Keep work here, with normal internet access
  gent mode required                Require a connected VM host and shared mesh
  gent peers                        Show connected hosts and their availability
  gent peers --discover             Also list machines visible through Tailscale
  gent connect HOST [--name NAME] [--path PATH] [--node NODE]
                                   Connect a trusted o-gents host over existing SSH;
                                   PATH and private Node 26+ NODE must be absolute
  gent disconnect NAME              Remove a host from automatic placement
  gent task "your task" --local      Override placement for one task
  gent task "your task" --on NAME    Choose a connected host

Connecting uses your SSH login and shares this network's signing authority with
that trusted controller. Apple hosts need their VM helpers and a prepared guest;
Linux/QEMU hosts need QEMU tools and a transferred prepared guest. Both need
Node 26+ and rsync. Use --node when the compatible Node is installed privately.
Check the target with gent check --backend auto before connecting. Discovery
does not connect, install software, or transfer credentials. Disconnect removes
placement configuration; it does not revoke an issued network certificate.`;

function parseArguments(command, argv) {
  const positional = [], values = new Map(), flags = new Set();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg.startsWith('-')) { positional.push(arg); continue; }
    if (arg === '--json' || command === 'peers' && arg === '--discover') { flags.add(arg); continue; }
    const separator = arg.indexOf('=');
    const option = separator < 0 ? arg : arg.slice(0, separator);
    if (command !== 'connect' || !['--name', '--path', '--node'].includes(option)) throw new Error(`Unknown ${command} option: ${arg}. Run gent ${command} --help.`);
    if (values.has(option)) throw new Error(`${option} was supplied more than once.`);
    const value = separator < 0 ? argv[++index] : arg.slice(separator + 1);
    if (!value || value.startsWith('-')) throw new Error(`${option} requires a value`);
    values.set(option, value);
  }
  if (positional.length > (command === 'peers' ? 0 : 1)) throw new Error(`Unexpected ${command} argument. Run gent ${command} --help.`);
  return { argument: positional[0], values, flags };
}

export async function runDistributionCommand(command, argv, {
  projectRoot, output = process.stdout, progress = process.stderr, environment = process.env,
  call = controllerCall, execute = runCaptured, prepareNetwork = startNetwork, invite = exportController,
  inspectNetwork = networkStatus,
} = {}) {
  if (!['mode', 'peers', 'connect', 'disconnect'].includes(command)) return null;
  if (argv.some(arg => ['--help', '-h'].includes(arg))) { output.write(distributionHelp + '\n'); return 0; }
  const parsed = parseArguments(command, argv);
  const settings = readDistributionSettings(projectRoot, environment);
  const json = parsed.flags.has('--json');
  const print = result => output.write(JSON.stringify(result, null, json ? 0 : 2) + '\n');
  if (command === 'mode') {
    const mode = parsed.argument;
    if (mode) {
      settings.mode = validateDistributionMode(mode);
      await saveDistributionSettings(projectRoot, settings, environment);
    }
    if (json) print({ mode: settings.mode });
    else output.write(`o-gents mode: ${settings.mode}\n${settings.mode === 'auto' ? 'Local execution stays available; connected compatible hosts add capacity.' : settings.mode === 'local' ? 'Gents stay on this machine. Internet access and local VM concurrency remain enabled.' : 'Gent tasks require a compatible remote VM controller and shared mesh.'}\n`);
    return 0;
  }
  if (command === 'disconnect') {
    const name = parsed.argument;
    if (!name || name.startsWith('-')) throw new Error('Usage: gent disconnect NAME');
    const removed = settings.peers.filter(peer => peer.name === name || peer.host === name);
    if (!removed.length) throw new Error(`No connected host named ${name}. Run gent peers.`);
    settings.peers = settings.peers.filter(peer => !removed.includes(peer));
    await saveDistributionSettings(projectRoot, settings, environment);
    if (json) print({ disconnected: removed.map(peer => peer.name) });
    else output.write(`Disconnected ${removed.map(peer => peer.name).join(', ')} from placement. Existing network certificates remain valid.\n`);
    return 0;
  }
  if (command === 'peers') {
    const peers = await Promise.all(settings.peers.map(async peer => {
      try { const probe = await call(peer, { op: 'probe' }, { timeout: 5000 }); return { name: peer.name, host: peer.host, connected: true, ...probe }; }
      catch (error) { return { name: peer.name, host: peer.host, connected: true, vmReady: false, error: error.message }; }
    }));
    let discovered = [], discoveryError;
    if (parsed.flags.has('--discover')) {
      try {
        const result = await execute('tailscale', ['status', '--json'], { timeout: 5000 });
        const status = JSON.parse(result.stdout);
        discovered = Object.values(status.Peer ?? {}).map(peer => ({ name: peer.HostName, dnsName: peer.DNSName, addresses: peer.TailscaleIPs, online: peer.Online === true, os: peer.OS }));
      } catch (error) { discoveryError = error.message; }
    }
    if (json) print({ mode: settings.mode, peers, discovered, discoveryError });
    else {
      output.write(`Mode: ${settings.mode}\n`);
      if (!peers.length) output.write('No connected VM hosts. Local tasks are available. Add one with gent connect HOST.\n');
      for (const peer of peers) output.write(`${peer.name} (${peer.host}): ${peer.vmReady ? `ready, ${(peer.freeMemoryBytes / 1024 ** 3).toFixed(1)} GiB free RAM` : peer.error || (peer.blockers ?? []).join('; ') || 'VM backend unavailable'}\n`);
      if (discovered.length) output.write('\nTailscale machines (discovery only):\n');
      for (const peer of discovered) output.write(`${peer.name}: ${peer.addresses?.[0] ?? peer.dnsName}, ${peer.online ? 'online' : 'offline'}, ${peer.os}\n`);
      if (discoveryError) output.write(`Tailscale discovery unavailable: ${discoveryError}\n`);
    }
    return 0;
  }
  if (!parsed.argument) throw new Error('Usage: gent connect HOST [--name NAME] [--path /absolute/vmagents/path] [--node /absolute/path/to/node]');
  const host = validateHost(parsed.argument);
  const name = parsed.values.get('--name') || host.split('@').at(-1);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name)) throw new Error('Use a short hostname-style --name.');
  const root = parsed.values.get('--path');
  if (root && (!path.isAbsolute(root) || /[\0\r\n]/.test(root))) throw new Error('--path must be an absolute remote checkout path.');
  const previous = settings.peers.find(peer => peer.name === name || peer.host === host);
  if (previous && previous.host !== host) throw new Error(`${name} already refers to ${previous.host}; choose another --name.`);
  const nodePath = parsed.values.has('--node') ? validateControllerNodePath(parsed.values.get('--node')) : previous?.nodePath;
  const peer = { name, host, ...(root ? { root } : previous?.root ? { root: previous.root } : {}), ...(nodePath === undefined ? {} : { nodePath }) };
  if (!json) progress.write(`Checking o-gents on ${host}…\n`);
  let probe;
  try { probe = await call(peer, { op: 'probe' }); }
  catch (error) { throw new Error(`Cannot connect to o-gents on ${host}: ${error.message}\nVerify ssh ${host} works and o-gents is installed there. Use --path for a nonstandard checkout and --node for a private Node 26+ interpreter.`); }
  if (probe.vmReady !== true) throw new Error(`${host} is reachable, but its VM controller is not ready: ${(probe.blockers ?? []).join('; ') || probe.reason || `${probe.platform}/${probe.architecture}`}. Run gent check --backend ${probe.backend === 'qemu-arm64' || probe.platform === 'linux' ? 'qemu' : 'auto'} on that host; provide Node 26+, rsync, the selected backend's tools, and a verified prepared ARM64 guest.`);
  if (typeof probe.root !== 'string' || !path.isAbsolute(probe.root) || /[\0\r\n]/.test(probe.root)) throw new Error('Remote controller returned an invalid checkout path.');
  peer.root = probe.root;
  const networkOptions = { projectRoot, ...(settings.networkState ? { stateRoot: settings.networkState } : {}) };
  await prepareNetwork(networkOptions);
  const localNetwork = await inspectNetwork(networkOptions);
  const directory = distributionDirectory(projectRoot, environment);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const invitationPath = path.join(directory, `.invitation-${randomUUID()}.json`);
  const sameAuthority = localNetwork.configured === true && probe.network?.configured === true
    && localNetwork.networkId === probe.network.networkId
    && /^[a-f0-9]{64}$/.test(localNetwork.caFileSha256 ?? '') && localNetwork.caFileSha256 === probe.network.caFileSha256;
  let joined = sameAuthority ? probe.network : null;
  if (!joined) {
    try {
      await invite({ ...networkOptions, name, outputFile: invitationPath });
      const invitation = JSON.parse(await readFile(invitationPath, 'utf8'));
      joined = await call(peer, { op: 'join', invitation }, { timeout: 120_000 });
    } finally { await rm(invitationPath, { force: true }); }
  }
  settings.peers = [...settings.peers.filter(item => item.name !== name && item.host !== host), { ...peer, enabled: true, connectedAt: previous?.connectedAt ?? new Date().toISOString(), networkId: joined.networkId }];
  await saveDistributionSettings(projectRoot, settings, environment);
  if (json) print({ connected: true, peer, networkId: joined.networkId, reusedNetwork: sameAuthority });
  else output.write(`Connected ${name}. Its gents join the same network.\nRun: gent task "your task" --on ${name}\n`);
  return 0;
}
