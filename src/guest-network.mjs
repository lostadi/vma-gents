import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { readDistributionSettings } from "./distribution-config.mjs";

const execute = promisify(execFile);
export const NEBULA_VERSION = "1.11.2";
const RELEASES = {
  darwin: { file: "nebula-darwin.zip", sha256: "ae23ebd29e570d72f28d71e608261d454fb87b1a19b4ca21c2aa26bb4698da88" },
  "linux-arm64": { file: "nebula-linux-arm64.tar.gz", sha256: "85d10e7bc2d121193c1392a1a919172ded7c413f46e602138281cfa9fa1b0231" },
  "linux-x64": { file: "nebula-linux-amd64.tar.gz", sha256: "6140d33f2ec21ce7f6b655b5bc820e93a684d97e51d0ddcf907324b5b28aac1e" },
};
const digest = (value) => createHash("sha256").update(value).digest("hex");
const privateJson = async (file, value) => {
  const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporary, file);
};
const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const statePath = ({ projectRoot, stateRoot } = {}) => path.resolve(stateRoot ?? process.env.OVM_NETWORK_STATE ?? path.join(projectRoot ?? process.cwd(), "runtime", "network"));

export function distributionMode(value = process.env.OVM_DISTRIBUTION_MODE ?? "auto") {
  if (!["auto", "local", "required"].includes(value)) throw new Error("Distribution mode must be auto, local, or required.");
  return value;
}

export async function prepareLocalIdentity(options) {
  if (typeof options?.guestId !== "string" || !options.guestId.trim() || options.guestId.length > 1024) throw new Error("A stable unique guestId is required.");
  const directory = path.resolve(options.localStateRoot ?? path.join(options.projectRoot ?? process.cwd(), "runtime", "guest-identities"));
  return locked(directory, async () => {
    const controllerPath = path.join(directory, "controller.json");
    let controller;
    if (existsSync(controllerPath)) controller = await readJson(controllerPath);
    else { controller = { controllerId: randomBytes(16).toString("hex") }; await privateJson(controllerPath, controller); }
    if (!/^[a-f0-9]{32}$/.test(controller.controllerId)) throw new Error("Invalid local VM controller identity.");
    const shareDir = path.join(directory, digest(`${controller.controllerId}:${options.guestId}`));
    await mkdir(shareDir, { recursive: true, mode: 0o700 });
    const identity = { schema: "ovm-local-identity-v1", guestId: options.guestId,
      controllerId: controller.controllerId, networkId: digest(`local:${controller.controllerId}`).slice(0, 32), address: null };
    await privateJson(path.join(shareDir, "identity.json"), identity);
    return { ...identity, shareDir };
  });
}

/** Prepare optional distribution only. Runtime preparation must succeed separately. */
export async function prepareLaunchNetwork(options = {}, implementations = {}) {
  const settings = readDistributionSettings(options.projectRoot ?? process.cwd());
  options = { ...options, stateRoot: options.stateRoot ?? settings.networkState };
  const requested = distributionMode(options.distributionMode ?? settings.mode);
  const networkMode = options.networkMode ?? "nat";
  if (!["nat", "isolated"].includes(networkMode)) throw new Error("Network mode must be nat or isolated.");
  if (networkMode === "isolated") return { distributionMode: requested, effectiveDistributionMode: "isolated", meshConfigured: false, guestReachabilityVerified: false };
  const local = implementations.prepareLocalIdentity ?? prepareLocalIdentity;
  let identity, fallbackReason = options.fallbackReason ?? null;
  let meshConfigured = false;
  if (requested !== "local") {
    try {
      await (implementations.startNetwork ?? startNetwork)(options);
      identity = await (implementations.prepareGuestNetwork ?? prepareGuestNetwork)(options);
      meshConfigured = true;
    } catch (error) {
      if (requested === "required") throw error;
      fallbackReason = `Mesh preparation failed: ${String(error.message ?? error).slice(0, 1000)}`;
    }
  }
  identity ??= await local(options);
  const shareDir = identity.shareDir ?? identity.networkShare;
  if (typeof shareDir !== "string" || !path.isAbsolute(shareDir)) throw new Error("Guest identity preparation did not return an absolute share directory.");
  const launch = { schema: "ovm-guest-launch-v1", distributionMode: requested,
    effectiveDistributionMode: meshConfigured ? "mesh" : "local", meshConfigured, fallbackReason };
  await privateJson(path.join(shareDir, "launch.json"), launch);
  return { ...identity, ...launch, shareDir, networkShare: shareDir, guestReachabilityVerified: false };
}

async function locked(directory, operation) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = path.join(directory, ".lock");
  const deadline = Date.now() + 120_000;
  for (;;) {
    try { await mkdir(lock, { mode: 0o700 }); break; }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new Error(`Network setup is busy: ${lock}. Check the owning setup process before removing a stale lock.`);
      await sleep(100);
    }
  }
  try { return await operation(); }
  finally { await rm(lock, { recursive: true }); }
}

export function validateEndpoint(endpoint) {
  if (typeof endpoint !== "string" || !/^(?:[a-zA-Z0-9][a-zA-Z0-9.-]*|\[[a-fA-F0-9:]+\]):\d+$/.test(endpoint)) {
    throw new Error("Use a lighthouse endpoint such as 100.64.1.2:4242 or host.example:4242.");
  }
  const port = Number(endpoint.slice(endpoint.lastIndexOf(":") + 1));
  if (port < 1 || port > 65535) throw new Error("Lighthouse UDP port must be between 1 and 65535.");
  return endpoint;
}

function validateDescriptor(network) {
  if (network?.schema !== "ovm-network-v1" || !/^[a-f0-9]{32}$/.test(network.networkId)) throw new Error("Invalid o-gents network descriptor.");
  if (network.subnet !== "10.87.0.0/16" || network.lighthouseIp !== "10.87.0.1") throw new Error("Unsupported o-gents network address range.");
  validateEndpoint(network.endpoint);
  if (!Number.isInteger(network.controllerBlock) || network.controllerBlock < 1 || network.controllerBlock > 254) throw new Error("Invalid controller address block.");
  if (typeof network.controllerId !== "string" || !/^[a-f0-9]{32}$/.test(network.controllerId)) throw new Error("Invalid controller identity.");
  return network;
}

export async function discoverEndpoint() {
  for (const binary of ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]) {
    try {
      const { stdout } = await execute(binary, ["ip", "-4"], { timeout: 5000 });
      const ip = stdout.trim().split(/\s+/).find((candidate) => /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+$/.test(candidate));
      if (ip) return { endpoint: `${ip}:4242`, underlay: "tailscale" };
    } catch { /* A LAN-only installation can still create its local network. */ }
  }
  const addresses = Object.values(os.networkInterfaces()).flat().filter((entry) => entry && entry.family === "IPv4" && !entry.internal);
  const address = addresses.find((entry) => !entry.address.startsWith("169.254."))?.address;
  if (!address) throw new Error("No Tailscale or LAN address found. Run gent network create --endpoint HOST:4242.");
  return { endpoint: `${address}:4242`, underlay: "lan" };
}

export async function installNebulaTools(options = {}) {
  const root = statePath(options);
  const platform = process.platform === "darwin" ? "darwin" : `${process.platform}-${process.arch}`;
  const release = RELEASES[platform];
  if (!release) throw new Error(`Nebula automatic installation does not support ${platform}.`);
  const target = path.join(root, "tools", NEBULA_VERSION);
  if (existsSync(path.join(target, "nebula")) && existsSync(path.join(target, "nebula-cert"))) return target;
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  return locked(path.join(root, "tools"), async () => {
    if (existsSync(path.join(target, "nebula")) && existsSync(path.join(target, "nebula-cert"))) return target;
    const temporary = await mkdtemp(path.join(root, "tools", ".install-"));
    try {
      const response = await fetch(`https://github.com/slackhq/nebula/releases/download/v${NEBULA_VERSION}/${release.file}`, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`Nebula download failed: HTTP ${response.status}`);
      const archive = Buffer.from(await response.arrayBuffer());
      if (digest(archive) !== release.sha256) throw new Error("Nebula release checksum did not match its pinned official SHA-256.");
      const archivePath = path.join(temporary, release.file);
      await writeFile(archivePath, archive, { mode: 0o600 });
      if (release.file.endsWith(".zip")) await execute("/usr/bin/unzip", ["-q", archivePath, "-d", temporary]);
      else await execute("tar", ["-xzf", archivePath, "-C", temporary]);
      for (const binary of ["nebula", "nebula-cert"]) {
        if (!existsSync(path.join(temporary, binary))) throw new Error(`Nebula archive omitted ${binary}.`);
        await chmod(path.join(temporary, binary), 0o700);
      }
      await rm(archivePath);
      await rename(temporary, target);
      return target;
    } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
  });
}

export function nebulaConfiguration({ network, directory = "/run/ovm-config", lighthouse = false }) {
  validateDescriptor(network);
  const config = {
    pki: { ca: `${directory}/ca.crt`, cert: `${directory}/${lighthouse ? "lighthouse" : "guest"}.crt`, key: `${directory}/${lighthouse ? "lighthouse" : "guest"}.key` },
    static_host_map: lighthouse ? {} : { [network.lighthouseIp]: [network.endpoint] },
    lighthouse: { am_lighthouse: lighthouse, interval: 10, hosts: lighthouse ? [] : [network.lighthouseIp] },
    listen: { host: "0.0.0.0", port: lighthouse ? Number(network.endpoint.split(":").at(-1)) : 0 },
    punchy: { punch: true, respond: true },
    relay: lighthouse ? { am_relay: true, use_relays: false } : { am_relay: false, use_relays: true, relays: [network.lighthouseIp] },
    tun: { disabled: lighthouse, ...(lighthouse ? {} : { dev: "ovm0", mtu: 1300 }) },
    logging: { level: "info", format: "json" },
    firewall: { outbound: [{ port: "any", proto: "any", host: "any" }], inbound: [{ port: "any", proto: "any", host: "any" }] },
  };
  // JSON is a YAML subset; encoding avoids quoting/path injection in config values.
  return `${JSON.stringify(config, null, 2)}\n`;
}

async function selectedNetwork(options = {}) {
  const root = statePath(options);
  const networkId = options.networkId ?? (await readFile(path.join(root, "current"), "utf8")).trim();
  if (!/^[a-f0-9]{32}$/.test(networkId)) throw new Error("Invalid o-gents network ID.");
  const networkDir = path.join(root, networkId);
  const network = validateDescriptor(await readJson(path.join(networkDir, "network.json")));
  return { ...network, networkDir, stateRoot: root };
}

export async function ensureDefaultNetwork(options = {}) {
  const root = statePath(options);
  if (existsSync(path.join(root, "current"))) return selectedNetwork(options);
  const tools = await installNebulaTools(options);
  return locked(root, async () => {
    if (existsSync(path.join(root, "current"))) return selectedNetwork(options);
    const discovered = options.endpoint ? { endpoint: validateEndpoint(options.endpoint), underlay: "explicit" } : await discoverEndpoint();
    const network = {
      schema: "ovm-network-v1", networkId: randomBytes(16).toString("hex"), name: options.name ?? "OVM",
      subnet: "10.87.0.0/16", lighthouseIp: "10.87.0.1", ...discovered,
      controllerId: randomBytes(16).toString("hex"), controllerBlock: 1, owner: true,
      createdAt: new Date().toISOString(), allocatedBlocks: [1],
    };
    const networkDir = path.join(root, network.networkId);
    await mkdir(networkDir, { mode: 0o700 });
    const cert = path.join(tools, "nebula-cert");
    await execute(cert, ["ca", "-name", `OVM ${network.networkId}`, "-out-crt", path.join(networkDir, "ca.crt"), "-out-key", path.join(networkDir, "ca.key")]);
    await execute(cert, ["sign", "-name", "ovm-lighthouse", "-ip", `${network.lighthouseIp}/16`, "-ca-crt", path.join(networkDir, "ca.crt"), "-ca-key", path.join(networkDir, "ca.key"), "-out-crt", path.join(networkDir, "lighthouse.crt"), "-out-key", path.join(networkDir, "lighthouse.key")]);
    await chmod(path.join(networkDir, "ca.key"), 0o600);
    await chmod(path.join(networkDir, "lighthouse.key"), 0o600);
    await writeFile(path.join(networkDir, "lighthouse.yaml"), nebulaConfiguration({ network, directory: networkDir, lighthouse: true }), { mode: 0o600 });
    await privateJson(path.join(networkDir, "network.json"), network);
    await writeFile(path.join(root, "current"), `${network.networkId}\n`, { mode: 0o600, flag: "wx" });
    return { ...network, networkDir, stateRoot: root };
  });
}

export async function prepareGuestNetwork(options) {
  if (typeof options?.guestId !== "string" || !options.guestId.trim() || options.guestId.length > 1024) throw new Error("A stable unique guestId is required.");
  const network = options.networkId ? await selectedNetwork(options) : await ensureDefaultNetwork(options);
  const tools = await installNebulaTools(options);
  return locked(network.networkDir, async () => {
    const guestsDirectory = path.join(network.networkDir, "guests");
    await mkdir(guestsDirectory, { recursive: true, mode: 0o700 });
    const identityDirectory = path.join(guestsDirectory, digest(`${network.controllerId}:${options.guestId}`));
    let identity;
    if (existsSync(path.join(identityDirectory, "identity.json"))) identity = await readJson(path.join(identityDirectory, "identity.json"));
    else {
      const used = new Set();
      for (const entry of await readdir(guestsDirectory)) {
        try { used.add((await readJson(path.join(guestsDirectory, entry, "identity.json"))).address); } catch { /* interrupted staging directory */ }
      }
      let address;
      for (let host = 1; host < 255; host += 1) {
        const candidate = `10.87.${network.controllerBlock}.${host}`;
        if (!used.has(candidate)) { address = candidate; break; }
      }
      if (!address) throw new Error("This controller's 254 persistent VM addresses are allocated. Create another trusted controller block before allocating more VM identities.");
      await mkdir(identityDirectory, { recursive: true, mode: 0o700 });
      // The key never enters a base image; each guest gets its own mounted identity.
      for (const partial of ["guest.crt", "guest.key"]) await rm(path.join(identityDirectory, partial), { force: true });
      await execute(path.join(tools, "nebula-cert"), ["sign", "-name", `ovm-${digest(options.guestId).slice(0, 20)}`, "-ip", `${address}/16`, "-groups", "ovm", "-ca-crt", path.join(network.networkDir, "ca.crt"), "-ca-key", path.join(network.networkDir, "ca.key"), "-out-crt", path.join(identityDirectory, "guest.crt"), "-out-key", path.join(identityDirectory, "guest.key")]);
      identity = { schema: "ovm-guest-network-v1", guestId: options.guestId, networkId: network.networkId, controllerId: network.controllerId, address, createdAt: new Date().toISOString() };
      await privateJson(path.join(identityDirectory, "identity.json"), identity);
    }
    const shareDir = path.resolve(options.outputDir ?? identityDirectory);
    if (shareDir !== identityDirectory) {
      await mkdir(shareDir, { recursive: true, mode: 0o700 });
      for (const name of ["guest.crt", "guest.key", "identity.json"]) await copyFile(path.join(identityDirectory, name), path.join(shareDir, name));
    }
    await copyFile(path.join(network.networkDir, "ca.crt"), path.join(shareDir, "ca.crt"));
    const configPath = path.join(shareDir, "config.yaml");
    await writeFile(configPath, nebulaConfiguration({ network }), { mode: 0o600 });
    for (const name of ["ca.crt", "guest.crt", "guest.key", "identity.json", "config.yaml"]) await chmod(path.join(shareDir, name), 0o600);
    const shareRegistryFile = path.join(network.networkDir, "shares.json");
    const shares = existsSync(shareRegistryFile) ? await readJson(shareRegistryFile) : {};
    shares[identityDirectory] = [...new Set([...(shares[identityDirectory] ?? []), identityDirectory, shareDir])];
    await privateJson(shareRegistryFile, shares);
    const peers = [];
    for (const entry of await readdir(guestsDirectory)) {
      try {
        const peer = await readJson(path.join(guestsDirectory, entry, "identity.json"));
        peers.push({ guestId: peer.guestId, address: peer.address, controllerId: peer.controllerId });
      } catch { /* interrupted identity staging is not an issued peer */ }
    }
    const registry = { schema: "ovm-peer-registry-v1", networkId: network.networkId, scope: "this-controller", updatedAt: new Date().toISOString(), peers };
    for (const directory of new Set(Object.values(shares).flat())) {
      if (existsSync(directory)) await privateJson(path.join(directory, "peers.json"), registry);
    }
    return { ...identity, shareDir, configPath, endpoint: network.endpoint, lighthouseIp: network.lighthouseIp };
  });
}

export async function startNetwork(options = {}) {
  const network = await ensureDefaultNetwork(options);
  if (!network.owner) return { ...network, running: false, remoteLighthouse: true };
  const tools = await installNebulaTools(options);
  return locked(network.networkDir, async () => {
    const pidPath = path.join(network.networkDir, "lighthouse.pid.json");
    if (existsSync(pidPath)) {
      const state = await readJson(pidPath);
      try {
        const { stdout } = await execute("ps", ["-p", String(state.pid), "-o", "command="]);
        if (stdout.includes(path.join(network.networkDir, "lighthouse.yaml"))) return { ...network, running: true, pid: state.pid };
      } catch { /* dead process */ }
    }
    const logfile = await open(path.join(network.networkDir, "lighthouse.log"), "a", 0o600);
    const child = spawn(path.join(tools, "nebula"), ["-config", path.join(network.networkDir, "lighthouse.yaml")], { detached: true, stdio: ["ignore", logfile.fd, logfile.fd] });
    await logfile.close();
    let failure;
    child.once("error", (error) => { failure = error; });
    await sleep(500);
    if (failure || child.exitCode !== null) throw new Error(`Nebula lighthouse did not start: ${failure?.message ?? `exit ${child.exitCode}`}. See ${network.networkDir}/lighthouse.log`);
    child.unref();
    await privateJson(pidPath, { pid: child.pid, startedAt: new Date().toISOString() });
    return { ...network, running: true, pid: child.pid };
  });
}

export async function networkStatus(options = {}) {
  if (!existsSync(path.join(statePath(options), "current"))) return { configured: false };
  const network = await selectedNetwork(options);
  let running = false, pid;
  try {
    ({ pid } = await readJson(path.join(network.networkDir, "lighthouse.pid.json")));
    const { stdout } = await execute("ps", ["-p", String(pid), "-o", "command="]);
    running = stdout.includes(path.join(network.networkDir, "lighthouse.yaml"));
  } catch { /* absent or stopped */ }
  const caPath = path.join(network.networkDir, "ca.crt");
  const caFileSha256 = digest(await readFile(caPath));
  let caFingerprint = null;
  try {
    const { stdout } = await execute(path.join(network.stateRoot, "tools", NEBULA_VERSION, "nebula-cert"), ["print", "-path", caPath, "-json"], { timeout: 5000 });
    caFingerprint = JSON.parse(stdout)[0]?.fingerprint ?? null;
  } catch { /* Status never installs tools or starts a service. */ }
  return { configured: true, ...network, caFingerprint, caFileSha256, localLighthouse: network.owner, running, ...(running ? { pid } : {}), guestReachabilityVerified: false };
}

export async function exportController(options) {
  if (!options?.outputFile) throw new Error("Choose an output file with --out FILE.");
  const network = await selectedNetwork(options);
  if (!network.owner) throw new Error("Create controller invitations on the original network owner to keep address blocks unique.");
  return locked(network.networkDir, async () => {
    const current = await readJson(path.join(network.networkDir, "network.json"));
    const block = Array.from({ length: 253 }, (_, index) => index + 2).find((candidate) => !current.allocatedBlocks.includes(candidate));
    if (!block) throw new Error("All controller address blocks have been allocated.");
    const controller = { ...current, owner: false, controllerId: randomBytes(16).toString("hex"), controllerBlock: block, controllerName: options.name ?? `controller-${block}` };
    delete controller.allocatedBlocks;
    const bundle = { schema: "ovm-trusted-controller-v1", authority: "CA signing authority: keep private; import only on your trusted machines", network: controller, caCertificate: await readFile(path.join(network.networkDir, "ca.crt"), "utf8"), caPrivateKey: await readFile(path.join(network.networkDir, "ca.key"), "utf8") };
    // Reserve the block before exporting: an interrupted export wastes a block, never duplicates one.
    current.allocatedBlocks.push(block);
    await privateJson(path.join(network.networkDir, "network.json"), current);
    await writeFile(path.resolve(options.outputFile), `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    return { file: path.resolve(options.outputFile), networkId: current.networkId, controllerId: controller.controllerId, controllerBlock: block, containsSigningAuthority: true };
  });
}

export async function joinNetwork(options) {
  const bundle = await readJson(path.resolve(options.inputFile));
  if (bundle.schema !== "ovm-trusted-controller-v1" || !bundle.caCertificate?.includes("NEBULA CERTIFICATE") || !bundle.caPrivateKey?.includes("PRIVATE KEY")) throw new Error("Invalid trusted-controller package.");
  const network = validateDescriptor(bundle.network);
  if (network.owner !== false) throw new Error("A controller invitation must not replace the network owner.");
  const root = statePath(options);
  const tools = await installNebulaTools(options);
  return locked(root, async () => {
    if (existsSync(path.join(root, "current"))) throw new Error("This o-gents installation already has a network. Use a separate OVM_NETWORK_STATE directory to join another network.");
    const directory = path.join(root, network.networkId);
    if (existsSync(directory)) throw new Error("Network identity directory already exists; refusing to overwrite it.");
    await mkdir(directory, { mode: 0o700 });
    await writeFile(path.join(directory, "ca.crt"), bundle.caCertificate, { mode: 0o600 });
    await writeFile(path.join(directory, "ca.key"), bundle.caPrivateKey, { mode: 0o600 });
    // Verify the signing key matches the certificate before accepting the controller.
    try {
      await execute(path.join(tools, "nebula-cert"), ["sign", "-name", "ovm-import-check", "-ip", `10.87.${network.controllerBlock}.254/16`, "-ca-crt", path.join(directory, "ca.crt"), "-ca-key", path.join(directory, "ca.key"), "-out-crt", path.join(directory, ".check.crt"), "-out-key", path.join(directory, ".check.key")]);
      await execute(path.join(tools, "nebula-cert"), ["verify", "-ca", path.join(directory, "ca.crt"), "-crt", path.join(directory, ".check.crt")]);
    } catch (error) { await rm(directory, { recursive: true }); throw new Error(`Controller certificate validation failed: ${error.message}`); }
    finally { await rm(path.join(directory, ".check.crt"), { force: true }); await rm(path.join(directory, ".check.key"), { force: true }); }
    await privateJson(path.join(directory, "network.json"), network);
    await writeFile(path.join(root, "current"), `${network.networkId}\n`, { mode: 0o600, flag: "wx" });
    return { ...network, networkDir: directory, stateRoot: root };
  });
}

export const networkHelp = `Usage: gent network [create|start|status|export|join|guest]

  gent network create                         Create a private network (prefers your Tailscale IP)
  gent network create --endpoint HOST:4242     Choose a reachable lighthouse endpoint
  gent network start                          Start this machine's lighthouse and relay
  gent network status                         Show the network identity and local process status
  gent network export laptop --out FILE       Give a trusted controller its own VM address block
  gent network join FILE                      Join from another trusted machine
  gent network guest NAME                     Prepare one VM's unique mounted identity

The export contains CA signing authority; transfer it privately to your own machine.
Each exported package belongs to one controller only. Export again for another machine.
VMs have full IP access to authenticated network peers. Normal internet access uses NAT.
Tailscale must already connect the hosts; this command does not change your tailnet.
The lighthouse must remain running and reachable on UDP 4242. Status is not a reachability test.`;

export async function runNetworkCli(argv, { projectRoot = process.cwd(), output = process.stdout } = {}) {
  // Network commands already return JSON; accept the shared CLI output flag.
  argv = argv.filter((argument) => argument !== "--json");
  if (!argv.length || argv.includes("--help") || argv[0] === "help") { output.write(`${networkHelp}\n`); return 0; }
  const [command, ...rest] = argv;
  const flags = new Map();
  const positional = [];
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === "--runtime-only" && command === "prepare") flags.set("--runtime-only", true);
    else if (["--endpoint", "--out", "--state-dir", ...(command === "prepare" ? ["--bundle", "--image", "--distribution"] : [])].includes(rest[i])) {
      const key = rest[i]; const value = rest[++i];
      if (!value || value.startsWith("--") || flags.has(key)) throw new Error(`${key} needs one value.`);
      flags.set(key, value);
    } else if (rest[i].startsWith("--")) throw new Error(`Unknown network option: ${rest[i]}`);
    else positional.push(rest[i]);
  }
  if (positional.length > 1) throw new Error("Too many network arguments.");
  const options = { projectRoot, stateRoot: flags.get("--state-dir") };
  let result;
  if (command === "create") result = await ensureDefaultNetwork({ ...options, endpoint: flags.get("--endpoint"), name: positional[0] });
  else if (command === "start") result = await startNetwork(options);
  else if (command === "status") result = await networkStatus(options);
  else if (command === "export") result = await exportController({ ...options, name: positional[0], outputFile: flags.get("--out") });
  else if (command === "join" && positional[0]) result = await joinNetwork({ ...options, inputFile: positional[0] });
  else if (command === "guest" && positional[0]) result = await prepareGuestNetwork({ ...options, guestId: positional[0] });
  else if (command === "prepare" && positional[0]) {
    const runtime = await prepareRuntimeForLaunch({ projectRoot, bundlePath: flags.get("--bundle"), rootfsPath: flags.get("--image"), guestId: positional[0] });
    if (flags.get("--runtime-only")) result = runtime;
    else {
      result = await prepareLaunchNetwork({ ...options, guestId: positional[0], distributionMode: flags.get("--distribution") });
      Object.assign(result, runtime);
    }
  }
  else throw new Error(`Unknown or incomplete network command.\n${networkHelp}`);
  output.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

// Direct native entrypoints use the same prepared-image gate as the JS fleet.
// This runs before any launch, including explicit isolation and supplied shares.
export async function prepareRuntimeForLaunch({ projectRoot, bundlePath = path.join(projectRoot, "vm/claudevm.bundle"), rootfsPath, guestId }, implementations) {
  const { ensurePreparedImage, upgradePreparedImage, preparedImageReceiptPath } = implementations ?? await import("./guest-manager.mjs");
  const { GUEST_PROFILE_MANIFEST } = await import("./preflight.mjs");
  const profile = await ensurePreparedImage({ projectRoot, bundlePath });
  const candidate = rootfsPath ?? (guestId?.startsWith("rootfs:") ? guestId.slice("rootfs:".length) : null);
  if (candidate && path.resolve(candidate) !== path.resolve(bundlePath, "rootfs.img")) {
    if (!existsSync(candidate)) {
      if (rootfsPath) throw new Error(`Guest source image does not exist: ${candidate}`);
    } else {
      await upgradePreparedImage({ projectRoot, rootfsPath: candidate, onOutput: (chunk) => process.stderr.write(chunk) });
      return { runtimePrepared: true, runtimeProfilePath: preparedImageReceiptPath(candidate) };
    }
  }
  return { runtimePrepared: true, runtimeProfilePath: path.join(bundlePath, GUEST_PROFILE_MANIFEST), sourceCommit: profile.sourceCommit };
}
