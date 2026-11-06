import { spawn, execFile } from "node:child_process";
import { constants, existsSync, accessSync, readFileSync } from "node:fs";
import { copyFile, cp, lstat, mkdir, mkdtemp, open, readlink, rm, statfs, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { DEFAULT_MODEL } from "./ollama-agent.mjs";
import { getGuestStatus, setupGuests } from "./guest-manager.mjs";
import { networkStatus, startNetwork } from "./guest-network.mjs";
import { readDistributionSettings } from "./distribution-config.mjs";
import { selectRsync } from "./controller-transport.mjs";
import { resolveVMBackend } from "./vm-backend.mjs";
import { qemuTools } from "./qemu-vm.mjs";
import { verifyShareDirectory } from "./preflight.mjs";

const executeFile = promisify(execFile);
const EVERYDAY_COMMANDS = new Set(["chat", "task", "check", "setup"]);
const VALUE_OPTIONS = new Map([
  ["--agents", [1, 8]], ["--rounds", [1, 20]], ["--max-agents", [1, 16]],
  ["--memory-mb", [512, 4096]], ["--cpu-count", [1, 4]],
  ["--source", null], ["--on", null], ["--distribution", null], ["--resume", null], ["--model", null], ["--state-dir", null], ["--swarm-id", null], ["--spec", null], ["--backend", null],
]);
const SWITCH_OPTIONS = new Set(["--dry-run", "--json", "--allow-native-act", "--isolated", "--local"]);

export function everydayHelp() {
  return `o-gents — autonomous gents with persistent Linux VMs

Everyday commands:
  gent chat                       Talk to one persistent gent; /bye exits
  gent chat --text                 Plain Spark conversation without execution
  gent task "what you want done"   Give one gent a task in its private Linux VM
  gent check                      Check setup and show what needs attention
  gent setup                      Install Spark and prepare the Linux guest tools
  gent mode auto                  Use available hosts; keep local execution available
  gent mode local                 Keep gents here with internet access
  gent peers                      See connected machines and their availability
  gent connect HOST               Connect another trusted o-gents controller over SSH
  gent list                       List saved gents
  gent show ID                    Inspect a gent's memory and status
  gent resume ID                  Continue a saved gent
  gent clone ID NEW_ID             Replicate a gent with a new identity
  gent export ID FILE.ovm          Bundle VM, history, and model weights
  gent import FILE.ovm            Restore a portable gent

Examples:
  gent chat "Explain what this project does"
  gent task "Run uname -m and report the observed result"
  gent task "Build and verify a parser" --agents 3
  gent task "Inspect the Linux environment" --dry-run
  gent task "Run Python and report its version" --backend qemu

Each gent is an autonomous agent with its own VM. The ovm commands remain available
for compatibility, and existing saved state and .ovm capsules work unchanged.
No JavaScript or TypeScript compilation is needed. Run these commands in Terminal.
Use gent chat --help or gent task --help for details, or gent help --all for advanced commands.`;
}

export function commandHelp(command) {
  const help = {
    chat: `Usage: gent chat ["your message"] [options]\n\nChat opens one persistent gent with its own Linux VM. Requests to run commands\nuse that VM, and later messages keep its files and history. Type /bye to leave.\n  --resume ID      Continue a saved gent and its VM\n  --local          Keep execution here with normal internet access\n  --on NAME        Use a connected compatible host\n  --allow-native-act  Permit cataloged native host actions (VM commands need no such flag)\n  --text           Plain model conversation without VM execution\n\nExamples: gent chat "Run Node and report its version"\n          gent chat --resume chat-12345678\n\nText-only chat uses /bye or Ctrl+D to exit. Thinking is disabled by default for\n--text; set OVM_CHAT_THINK=true to enable it. OVM_SWARM_MODEL selects the model;\nOVM_OLLAMA_URL selects its local server. No JS or TS compilation is needed.`,
    task: `Usage: gent task "what you want done" [options]\n\nOne gent starts by default, with room for a peer checker. --agents 3 starts three; --max-agents N sets the cap.\n  --rounds N       Maximum reasoning rounds (default 4)\n  --model NAME     Use another installed Ollama model\n  --local          Run here with normal internet access\n  --on NAME        Run on a connected VM host\n  --resume ID      Continue saved files and history with this new mission\n  --isolated       Disable networking for this task and its descendants\n  --dry-run        Inspect the plan without inference or VM execution\n  --json           Print machine-readable results\n\nExample: gent task "Run uname -m and report the observed result"\nAdvanced swarm flags are accepted. For specification files, use gent swarm --spec FILE.\nGuest commands run inside private Linux VMs with NAT. Automatic mode adds the shared peer network when available; optional network failures keep local execution available.\nNative host actions require --allow-native-act.`,
    check: `Usage: gent check [--json]\n\nChecks Node, dependencies, Ollama, the model, VM inputs, the prepared guest profile,\nnetwork configuration, and the normal run/MCP policy. It does not start a VM,\nstart the network, run inference, or test live guest-to-guest reachability.\nExit 0 means checked prerequisites pass; exit 2 means a check needs attention.`,
    setup: `Usage: gent setup\n\nInstalls JavaScript dependencies, Spark, missing private VM inputs, and guest tools,\nthen starts the shared guest network. Requires Node 26+, npm, Ollama, compatible\nlocal Claude Desktop VM artifacts, and internet for package downloads.\nThe first guest installation builds Ostadix automatically inside a private VM\nand can take tens of minutes; logs and progress are printed. Verified profiles\nare reused. Existing VM bundles are not recloned; guest updates use a staged\nimage and retain the previous root disk. No manual JS or TS compilation is needed.`,
  };
  if (["chat", "task", "check"].includes(command)) return `${help[command]}\n\n  --backend auto|apple|qemu  Select the VM engine (default auto)\nAn explicit --backend overrides OVM_VM_BACKEND. Auto uses Apple's engine on\nApple Silicon macOS and QEMU on other supported macOS/Linux hosts. QEMU needs\nqemu-system-aarch64, mke2fs (e2fsprogs), python3, lsof, and a verified prepared guest\nbundle. Use gent check --backend qemu to check its prerequisites.`;
  if (command === "setup") return `${help[command]}\n\nFresh guest provisioning currently requires Apple Silicon macOS. QEMU hosts\ncan use a verified prepared guest transferred from that setup or an imported\ngent capsule; gent setup does not provision a fresh QEMU guest.`;
  return help[command];
}

export function parseTaskInput(argv, { missionOptional = false } = {}) {
  let mission;
  const flags = [];
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      const remaining = argv.slice(index + 1);
      if (mission !== undefined || remaining.length !== 1 || !remaining[0].trim()) throw new Error("Supply one quoted description after --.");
      mission = remaining[0];
      break;
    }
    if (!token.startsWith("-")) {
      if (!token.trim() || mission !== undefined) throw new Error("Supply one task description; quote it when it contains spaces. Options may go before or after it.");
      mission = token;
      continue;
    }
    const [name, ...inline] = token.split("=");
    if (SWITCH_OPTIONS.has(name) && inline.length === 0) {
      // Isolation is a launcher environment setting shared by every descendant.
      if (name !== "--isolated") flags.push(name);
      continue;
    }
    if (!VALUE_OPTIONS.has(name)) throw new Error(`Unknown task option: ${token}. Use gent task --help.`);
    if (values.has(name)) throw new Error(`${name} was supplied more than once.`);
    const value = inline.length ? inline.join("=") : argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value. Use gent task --help.`);
    const bounds = VALUE_OPTIONS.get(name);
    if (bounds && (!/^\d+$/.test(value) || Number(value) < bounds[0] || Number(value) > bounds[1])) {
      throw new Error(`${name} must be an integer between ${bounds[0]} and ${bounds[1]}.`);
    }
    if (name === "--backend" && !["auto", "apple", "qemu"].includes(value)) throw new Error("--backend must be auto, apple, or qemu.");
    values.set(name, value);
    flags.push(name, value);
  }
  if (!mission && !missionOptional) throw new Error(`A task description is required. Options may go before or after the quoted description.\n${commandHelp("task")}`);
  return { mission, flags, values };
}

export function taskArguments(argv, { readSpec = (file) => JSON.parse(readFileSync(path.resolve(file), "utf8")) } = {}) {
  const { mission, flags, values } = parseTaskInput(argv);
  const spec = values.has("--spec") ? readSpec(values.get("--spec")) : {};
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new Error("swarm spec must be a JSON object");
  const initialCount = Array.isArray(spec.agents) ? spec.agents.length : Number(values.get("--agents") ?? spec.agentCount ?? 1);
  const output = ["--mission", mission, ...flags];
  if (values.has("--resume")) return output;
  if (!values.has("--agents") && !Array.isArray(spec.agents) && spec.agentCount === undefined) output.push("--agents", "1");
  const maximum = Number(values.get("--max-agents") ?? spec.maximumAgents ?? Math.max(initialCount, 2));
  if (maximum < initialCount) throw new Error(`--max-agents must be at least the initial agent count (${initialCount}).`);
  if (!values.has("--max-agents") && spec.maximumAgents === undefined) output.push("--max-agents", String(maximum));
  return output;
}

// Spawn argv directly: a mission or prompt is data, never a host shell program.
export function runChild(file, argv, { cwd, env = process.env, spawnImpl = spawn, signals = process } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(file, argv, { cwd, env, stdio: "inherit", shell: false });
    let settled = false;
    const forward = (signal) => child.kill(signal);
    const onInterrupt = () => forward("SIGINT");
    const onTerminate = () => forward("SIGTERM");
    signals.on("SIGINT", onInterrupt);
    signals.on("SIGTERM", onTerminate);
    function cleanup() {
      signals.removeListener("SIGINT", onInterrupt);
      signals.removeListener("SIGTERM", onTerminate);
    }
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`Could not start ${path.basename(file)}: ${error.message}${error.code === "ENOENT" ? ". Install it or add it to PATH, then run gent check." : ""}`));
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(code ?? (128 + (os.constants.signals[signal] ?? 1)));
    });
  });
}

function commandAvailable(name, environment) {
  return (environment.PATH ?? "").split(path.delimiter).some((directory) => {
    try { accessSync(path.join(directory, name), constants.X_OK); return true; } catch { return false; }
  });
}

export async function inspectReadiness(root, {
  environment = process.env, fetchImpl = globalThis.fetch, execute = executeFile,
  exists = existsSync, nodeVersion = process.versions.node, platform = process.platform, architecture = process.arch,
  guestStatus = getGuestStatus, inspectNetwork = networkStatus, backend, inspectQemuTools = qemuTools,
} = {}) {
  const selectedBackend = resolveVMBackend({ backend, environment, platform, architecture });
  const model = environment.OVM_SWARM_MODEL || DEFAULT_MODEL;
  const endpoint = (environment.OVM_OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
  const report = {
    node: { version: nodeVersion, ready: Number(nodeVersion.split(".")[0]) >= 26 },
    dependencies: { ready: exists(path.join(root, "node_modules/@modelcontextprotocol/sdk/package.json")) && exists(path.join(root, "node_modules/zod/package.json")) },
    ollama: { endpoint, reachable: false, model, installed: false, cliAvailable: commandAvailable("ollama", environment) },
    vm: { backend: selectedBackend, supportedHost: selectedBackend === "apple" ? platform === "darwin" && architecture === "arm64" : ["darwin", "linux"].includes(platform), inputs: {}, configurationValid: false, bootVerified: false },
    normalVmRoute: { commands: "gent run / start / MCP", applicable: selectedBackend === "apple", blockers: [], preflightComplete: false },
  };
  try { report.guest = await guestStatus({ projectRoot: root }); }
  catch (error) { report.guest = { prepared: false, verified: false, errors: [error.message] }; }
  report.guest.ready = report.guest.prepared === true && report.guest.verified === true && !report.guest.needsUpdate && !(report.guest.errors?.length);
  report.network = { mode: environment.OVM_NETWORK_MODE || "nat", distributionMode: readDistributionSettings(root, environment).mode, guestReachabilityVerified: false };
  if (report.network.mode === "isolated") report.network.ready = true;
  else if (report.network.mode !== "nat") {
    report.network.ready = false;
    report.network.error = "OVM_NETWORK_MODE must be nat or isolated.";
  } else {
    try { Object.assign(report.network, await inspectNetwork({ projectRoot: root })); }
    catch (error) { report.network.error = error.message; }
    report.network.meshConfigured = report.network.configured === true && (report.network.localLighthouse === false || report.network.running === true);
    report.network.ready = report.network.distributionMode !== "required" || report.network.meshConfigured;
  }
  try {
    const response = await fetchImpl(`${endpoint}/api/tags`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}`);
    const body = await response.json();
    if (!Array.isArray(body.models)) throw new Error("Ollama returned an invalid model list");
    report.ollama.reachable = true;
    const canonical = (name) => name.includes(":") ? name : `${name}:latest`;
    report.ollama.installed = body.models.some((entry) => canonical(entry.name ?? entry.model ?? "") === canonical(model));
  } catch (error) { report.ollama.error = error.message; }
  const choose = (name) => {
    const built = path.join(root, "host", name);
    return exists(built) ? built : path.join(root, "prebuilt/macos-arm64", name);
  };
  const required = {
    ...(selectedBackend === "apple" ? {
      swarmRunner: choose("OVMSwarm"), configurationRunner: choose("ClaudeVZRunner"), helper: path.join(root, "host/smol-bin.arm64.img"),
    } : { qemuWorker: path.join(root, "host/qemu-worker.py"), qemuSupervisor: path.join(root, "host/qemu-supervisor.py") }),
    rootfs: path.join(root, "vm/claudevm.bundle/rootfs.img"),
    kernel: path.join(root, "vm/claudevm.bundle/vmlinuz"),
    initrd: path.join(root, "vm/claudevm.bundle/initrd"),
  };
  for (const [name, file] of Object.entries(required)) report.vm.inputs[name] = { path: file, present: exists(file) };
  report.vm.inputsPresent = Object.values(report.vm.inputs).every((input) => input.present);
  if (selectedBackend === "qemu") {
    try {
      report.vm.tools = await inspectQemuTools({ environment, platform, architecture });
      report.vm.toolsReady = ["binary", "mke2fs", "python", "lsof"].every(name => Boolean(report.vm.tools[name]));
      report.vm.configurationValid = report.vm.supportedHost && report.vm.inputsPresent && report.vm.toolsReady;
      if (!report.vm.toolsReady) report.vm.error = "QEMU requires qemu-system-aarch64, mke2fs (e2fsprogs), python3, and lsof. Install the missing tools and rerun gent check --backend qemu.";
      if (!report.guest.ready) report.vm.preparationNote = "QEMU requires an existing verified guest bundle or imported gent capsule. Fresh guest provisioning currently uses Apple Silicon macOS; prepare the guest there and transfer it.";
    } catch (error) { report.vm.error = error.message; }
  } else if (report.vm.supportedHost && report.vm.inputsPresent) {
    try {
      const result = await execute(required.configurationRunner, ["--probe", "--bundle", path.join(root, "vm/claudevm.bundle"), "--smol", required.helper, "--share", path.join(root, "share")], { timeout: 15_000, maxBuffer: 1024 * 1024 });
      report.vm.probe = JSON.parse(String(result.stdout).trim());
      report.vm.configurationValid = report.vm.probe.supported === true && report.vm.probe.configurationValid === true;
    } catch (error) { report.vm.error = error.message; }
  }
  let policy;
  if (report.normalVmRoute.applicable) {
    try { policy = JSON.parse(readFileSync(environment.CLAUDE_VM_POLICY ?? path.join(root, "policy.json"), "utf8")); }
    catch (error) { report.normalVmRoute.blockers.push(`Cannot read VM policy: ${error.message}`); }
  }
  if (report.normalVmRoute.applicable && report.dependencies.ready && report.vm.inputsPresent && report.vm.supportedHost) {
    try {
      const result = await execute(process.execPath, [path.join(root, "bin/ovm"), "status", "--json"], { env: { ...environment, CLAUDE_VM_LIFETIME: "transaction" }, timeout: 45_000, maxBuffer: 2 * 1024 * 1024 });
      report.normalVmRoute.status = JSON.parse(String(result.stdout).trim());
    } catch (error) { report.normalVmRoute.blockers.push(`VM status failed: ${String(error.stderr || error.message).trim()}`); }
  }
  const status = report.normalVmRoute.status;
  let freeDiskBytes = status?.host?.freeDiskBytes;
  if (!Number.isFinite(freeDiskBytes)) {
    try { const disk = await statfs(root); freeDiskBytes = Number(disk.bavail) * Number(disk.bsize); } catch {}
  }
  report.normalVmRoute.freeDiskGiB = Number.isFinite(freeDiskBytes) ? freeDiskBytes / (1024 ** 3) : null;
  report.normalVmRoute.minimumFreeDiskGiB = policy?.minimumFreeDiskGiB ?? null;
  if (policy && (report.normalVmRoute.freeDiskGiB === null || report.normalVmRoute.freeDiskGiB < policy.minimumFreeDiskGiB)) {
    report.normalVmRoute.blockers.push(`Normal run/MCP route requires ${policy.minimumFreeDiskGiB} GiB free disk; ${report.normalVmRoute.freeDiskGiB?.toFixed(1) ?? "unknown"} GiB available.`);
  }
  if (policy && status?.host && (status.host.freeMemoryPercent === null || status.host.freeMemoryPercent < policy.minimumFreeMemoryPercent)) {
    report.normalVmRoute.blockers.push(`Normal run/MCP route requires ${policy.minimumFreeMemoryPercent}% free memory; ${status.host.freeMemoryPercent ?? "unknown"}% available.`);
  }
  if (status?.host?.memoryPressureLevel >= 4) report.normalVmRoute.blockers.push(`Host memory pressure is critical (level ${status.host.memoryPressureLevel}).`);
  if (status?.controllerLease?.held) report.normalVmRoute.blockers.push("Normal VM controller lease is held; wait for the current operation to finish.");
  report.textChatPrerequisitesReady = report.node.ready && report.ollama.cliAvailable && report.ollama.reachable && report.ollama.installed;
  report.taskPrerequisitesReady = report.node.ready && report.dependencies.ready && report.ollama.reachable && report.ollama.installed && report.vm.configurationValid && report.guest.ready && report.network.ready;
  report.chatPrerequisitesReady = report.taskPrerequisitesReady;
  report.ok = report.chatPrerequisitesReady && report.taskPrerequisitesReady && (!report.normalVmRoute.applicable || Boolean(status) && report.normalVmRoute.blockers.length === 0);
  return report;
}

export function formatReadiness(report) {
  const mark = (value) => value ? "OK" : "NEEDS ATTENTION";
  const lines = [
    `Node ${report.node.version}: ${mark(report.node.ready)}${report.node.ready ? "" : " — install Node 26 or newer"}`,
    `Dependencies: ${mark(report.dependencies.ready)}${report.dependencies.ready ? "" : " — run gent setup"}`,
    `Ollama CLI: ${mark(report.ollama.cliAvailable)}`,
    `Ollama server ${report.ollama.endpoint}: ${mark(report.ollama.reachable)}${report.ollama.reachable ? "" : " — start Ollama (ollama serve)"}`,
    `Model ${report.ollama.model}: ${mark(report.ollama.installed)}${report.ollama.installed ? "" : " — run gent setup for the default model, or ollama pull with your selected model"}`,
    `${report.vm.backend === "qemu" ? "QEMU host (macOS or Linux)" : "Apple Silicon macOS host"}: ${mark(report.vm.supportedHost)}`,
    `VM inputs: ${mark(report.vm.inputsPresent)}`,
  ];
  for (const [name, input] of Object.entries(report.vm.inputs)) if (!input.present) lines.push(`  Missing ${name}: ${input.path}`);
  lines.push(`${report.vm.backend === "qemu" ? "QEMU inputs and tools" : "VM configuration probe"}: ${mark(report.vm.configurationValid)}`);
  if (report.vm.tools) {
    for (const [name, label] of [["binary", "QEMU"], ["mke2fs", "Seed image builder"], ["python", "Python"]]) lines.push(`  ${label}: ${report.vm.tools[name] ?? "missing"}`);
    if (report.vm.tools.accelerator) lines.push(`  Selected accelerator: ${report.vm.tools.accelerator}; availability is not boot-tested here.`);
  }
  if (report.vm.error) lines.push(`  ${report.vm.error}`);
  lines.push(`Prepared guest tools: ${mark(report.guest.ready)}${report.guest.ready ? "" : report.vm.backend === "qemu" ? " — supply a verified prepared guest bundle" : " — run gent guests setup"}`);
  if (report.vm.preparationNote) lines.push(`  ${report.vm.preparationNote}`);
  if (report.guest.needsUpdate) lines.push("  The installed guest recipe differs from this checkout.");
  for (const error of report.guest.errors ?? []) lines.push(`  ${error}`);
  if (report.guest.profile?.smoke) lines.push(`  Recorded runtime checks: ${report.guest.profile.smoke.passed} passed; this check does not rerun them.`);
  lines.push(`Guest network (${report.network.mode}, distribution ${report.network.distributionMode ?? "auto"}): ${mark(report.network.ready)}${report.network.ready ? "" : " — run gent network start"}`);
  if (report.network.mode === "isolated") lines.push("  Guest network access is disabled for this invocation.");
  else if (report.network.distributionMode === "local") lines.push("  Peer mesh is skipped in local mode; normal NAT internet access remains enabled.");
  else if (report.network.configured) lines.push(`  ${report.network.localLighthouse ? "Local lighthouse" : "Remote lighthouse configured"}; live guest-to-guest reachability is not tested here.`);
  if (report.network.mode === "nat" && !report.network.meshConfigured && report.network.distributionMode !== "required") lines.push("  Local VM tasks remain available; the optional peer mesh is not ready.");
  if (report.network.error) lines.push(`  ${report.network.error}`);
  lines.push("", `VM chat prerequisites: ${mark(report.chatPrerequisitesReady)}`, `Text chat prerequisites: ${mark(report.textChatPrerequisitesReady)}`, `Task prerequisites: ${mark(report.taskPrerequisitesReady)}`);
  for (const blocker of report.normalVmRoute.blockers) lines.push(`Normal run/MCP route: ${blocker}`);
  if (report.normalVmRoute.applicable === false) lines.push("Normal run/start/MCP commands use the Apple backend; this check covers QEMU task and VM chat prerequisites.");
  lines.push("", "This check does not boot a VM or run model inference. A task still needs to succeed at runtime.", "Task VMs use a separate backend; the normal run/MCP disk minimum does not apply to that route.");
  return `${lines.join("\n")}\n`;
}

export async function prepareSetupShare(root) {
  if (typeof process.getuid !== "function" || !Number.isInteger(constants.O_NOFOLLOW) || !Number.isInteger(constants.O_DIRECTORY)) {
    throw new Error("This platform cannot safely prepare the VM host share with no-follow directory access.");
  }
  const sharePath = path.join(root, "share");
  try { await mkdir(sharePath, { mode: 0o500 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  const before = await lstat(sharePath);
  if (!before.isDirectory() || before.isSymbolicLink() || before.uid !== process.getuid()) {
    throw new Error("VM host share must be a user-owned, non-symlink directory.");
  }
  const handle = await open(sharePath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isDirectory() || opened.uid !== process.getuid() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error("VM host share changed while opening it; permissions were not changed.");
    }
    // Git preserves the share's files, but not its directory permissions.
    // Change only this checked directory handle, never a substituted link target.
    await handle.chmod(0o500);
  } finally { await handle.close(); }
  return verifyShareDirectory(sharePath, root);
}

async function installMissingPrebuilt(root, run, environment, output) {
  const names = ["ClaudeVZRunner", "OVMShell", "OVMSwarm", "smol-bin.arm64.img"];
  const missing = names.filter((name) => !existsSync(path.join(root, "host", name)));
  if (!missing.length) { output.write("VM launchers and helper already installed.\n"); return 0; }
  // The existing installer replaces its outputs. Stage it so a partial setup never replaces existing files.
  const staging = await mkdtemp(path.join(os.tmpdir(), "ovm-setup-"));
  try {
    await mkdir(path.join(staging, "scripts"));
    await mkdir(path.join(staging, "host"));
    await copyFile(path.join(root, "scripts/install-prebuilt.zsh"), path.join(staging, "scripts/install-prebuilt.zsh"));
    await copyFile(path.join(root, "host/entitlements.plist"), path.join(staging, "host/entitlements.plist"));
    await cp(path.join(root, "prebuilt"), path.join(staging, "prebuilt"), { recursive: true });
    await cp(path.join(root, "compatibility"), path.join(staging, "compatibility"), { recursive: true });
    const code = await run("/bin/zsh", [path.join(staging, "scripts/install-prebuilt.zsh")], { cwd: root, env: { ...environment, ...(!environment.CLAUDE_VM_SMOL_SOURCE && existsSync(path.join(root, "host/smol-bin.arm64.img")) ? { CLAUDE_VM_SMOL_SOURCE: path.join(root, "host/smol-bin.arm64.img") } : {}), OVM_INSTALL_BIN: path.join(staging, "bin") } });
    if (code) return code;
    await mkdir(path.join(root, "host"), { recursive: true });
    for (const name of missing) {
      try { await copyFile(path.join(staging, "host", name), path.join(root, "host", name), constants.COPYFILE_EXCL); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
    }
    return 0;
  } finally { await rm(staging, { recursive: true, force: true }); }
}

export async function runSetup(root, { run = runChild, environment = process.env, output = process.stdout, exists = existsSync, installPrebuilt = installMissingPrebuilt, prepareGuests = setupGuests, prepareNetwork = startNetwork, inspectRsync = selectRsync, availableCommand = commandAvailable } = {}) {
  output.write("Installing JavaScript dependencies (no compilation needed)…\n");
  let code = await run("npm", ["ci"], { cwd: root, env: environment });
  if (code) return code;
  output.write(`Setting up ${DEFAULT_MODEL} in Ollama…\n`);
  code = await run("npm", ["run", "model:setup"], { cwd: root, env: { ...environment, ...(environment.OVM_OLLAMA_URL ? { OLLAMA_HOST: environment.OVM_OLLAMA_URL } : {}) } });
  if (code) { output.write("Model setup failed. Start a Spark-compatible Ollama server (on this Mac, open the Ollama app), then run gent setup again.\n"); return code; }
  if (readDistributionSettings(root, environment).mode !== "local" && availableCommand("brew", environment)) {
    const transfer = await inspectRsync().catch(() => null);
    if (!transfer || transfer.protocol < 30) {
      output.write("Setting up faster VM checkpoint transfers…\n");
      try {
        const transferCode = await run("brew", ["install", "rsync"], { cwd: root, env: { ...environment, HOMEBREW_NO_AUTO_UPDATE: "1", HOMEBREW_NO_INSTALL_CLEANUP: "1" } });
        if (transferCode >= 128) return transferCode;
        if (transferCode) output.write("Faster checkpoint transfer is unavailable. Local tasks remain available; connected hosts can use their existing rsync.\n");
      } catch (error) {
        output.write(`Optional faster checkpoint setup failed: ${error.message}\nLocal tasks remain available; continuing guest setup.\n`);
      }
    }
  }
  const unresolved = [];
  code = await installPrebuilt(root, run, environment, output);
  if (code >= 128) return code;
  if (code) unresolved.push("VM launchers/helper: supply the reviewed Claude helper via CLAUDE_VM_SMOL_SOURCE and rerun gent setup. See compatibility/README.md for the required profile.");
  if (!exists(path.join(root, "vm/claudevm.bundle"))) {
    code = await run("/bin/zsh", [path.join(root, "scripts/clone-bundle.zsh")], { cwd: root, env: environment });
    if (code >= 128) return code;
    if (code) unresolved.push("Private VM: provide a compatible, stopped Claude source bundle using CLAUDE_VM_SOURCE_BUNDLE and rerun gent setup. Existing bundles are never overwritten.");
  } else output.write("Existing private VM bundle preserved.\n");
  const guestInputs = ["host/OVMShell", "host/smol-bin.arm64.img", "vm/claudevm.bundle/rootfs.img", "vm/claudevm.bundle/vmlinuz", "vm/claudevm.bundle/initrd", "vm/claudevm.bundle/sessiondata.img"];
  if (!unresolved.length && guestInputs.every((file) => exists(path.join(root, file)))) {
    output.write("Preparing the guest's Ostadix, MCP, and language runtimes…\nThe first installation downloads packages and builds inside a private VM; it can take tens of minutes. Progress and log paths follow. Current verified profiles are reused. No manual compilation commands are needed.\n");
    try {
      const guest = await prepareGuests({ projectRoot: root, onOutput: (chunk) => output.write(chunk) });
      if (guest?.prepared !== true || guest?.verified !== true) throw new Error("Guest preparation did not return verified installation evidence.");
      await prepareSetupShare(root);
      output.write("Read-only VM host share prepared.\n");
      if (environment.OVM_NETWORK_MODE !== "isolated" && readDistributionSettings(root, environment).mode !== "local") {
        output.write("Starting the shared guest network…\n");
        try { await prepareNetwork({ projectRoot: root }); }
        catch (error) {
          if (readDistributionSettings(root, environment).mode === "required") throw error;
          output.write(`Optional peer network unavailable: ${error.message}\nLocal VM tasks and internet access remain available.\n`);
        }
      } else output.write(environment.OVM_NETWORK_MODE === "isolated" ? "Guest networking is explicitly isolated for this invocation.\n" : "Local mode selected; guest internet access remains available.\n");
    } catch (error) {
      output.write(`Needs attention: ${error.message}\nAfter resolving this error, rerun gent setup.\n`);
      return Number.isInteger(error.exitCode) ? error.exitCode : 2;
    }
  } else unresolved.push("Prepared guest tools: missing VM inputs prevent preparation. Resolve the VM input errors, then rerun gent setup.");
  const nativeRoot = environment.OVM_NATIVE_INSTALL_ROOT ?? path.join(root, "host/native-root");
  const nativeFiles = ["node_modules/@ant/claude-native/claude-native-binding.node", "node_modules/@ant/claude-swift/build/Release/computer_use.node"];
  if (!nativeFiles.every((file) => exists(path.join(nativeRoot, "current", file)))) {
    code = await run("npm", ["run", "install:native"], { cwd: root, env: environment });
    if (code >= 128) return code;
    if (code) unresolved.push("Optional host capabilities: set OVM_CLAUDE_EXTRACTED_ROOT to compatible decoded Claude addons, then run npm run install:native. Basic chat and guest-only tasks can still work.");
  } else output.write("Native host capabilities already installed.\n");
  const installBin = environment.OVM_INSTALL_BIN ?? path.join(os.homedir(), ".local/bin");
  await mkdir(installBin, { recursive: true });
  for (const name of ["gent", "ovm"]) {
    const link = path.join(installBin, name);
    const target = path.join(root, "bin", name);
    let commandLinkReady = true;
    try {
      const metadata = await lstat(link);
      commandLinkReady = metadata.isSymbolicLink() && path.resolve(path.dirname(link), await readlink(link)) === target;
    } catch (error) { if (error.code !== "ENOENT") throw error; await symlink(target, link); }
    if (commandLinkReady) output.write(`${name === "gent" ? "o-gents command" : "Compatibility command"}: ${link}\n`);
    else unresolved.push(`Existing ${link} points elsewhere and was preserved. Use ${target} for this checkout.`);
  }
  if (!(environment.PATH ?? "").split(path.delimiter).includes(installBin)) output.write(`Add ${installBin} to your shell PATH, or use ${path.join(root, "bin/gent")} directly.\n`);
  for (const item of unresolved) output.write(`Needs attention: ${item}\n`);
  output.write("Next: gent check, then gent chat or gent task \"Run uname -m and report the result\".\n");
  return unresolved.length ? 2 : 0;
}

export async function runUserCommand(command, argv, { root, output = process.stdout, errorOutput = process.stderr, environment = process.env, run = runChild, inspect = inspectReadiness, setup = runSetup } = {}) {
  if (!EVERYDAY_COMMANDS.has(command)) return null;
  const optionEnd = argv.indexOf("--");
  const optionArgs = optionEnd < 0 ? argv : argv.slice(0, optionEnd);
  if (optionArgs.some(arg => arg === "--help" || arg === "-h")) { output.write(`${commandHelp(command)}\n`); return 0; }
  if (command === "task") return run(process.execPath, [path.join(root, "bin/ovm-pocket"), ...taskArguments(argv)], { cwd: process.cwd(), env: { ...environment, ...(optionArgs.includes("--isolated") ? { OVM_NETWORK_MODE: "isolated" } : {}) } });
  if (command === "chat") {
    if (optionArgs.includes("--vm") && optionArgs.includes("--text")) throw new Error("Choose either VM-enabled chat or --text.");
    if (!optionArgs.includes("--text")) {
      const { runAgentChat } = await import("./agent-chat.mjs");
      return runAgentChat(argv.filter((arg, index) => arg !== "--vm" || (optionEnd >= 0 && index > optionEnd)), { root, run, output, progress: errorOutput, environment });
    }
    const prompt = [];
    let model = environment.OVM_SWARM_MODEL || DEFAULT_MODEL;
    for (let index = 0; index < argv.length; index++) {
      const arg = argv[index];
      if (arg === "--") { prompt.push(...argv.slice(index + 1)); break; }
      if (arg === "--text") continue;
      if (arg === "--model" || arg.startsWith("--model=")) {
        model = arg.startsWith("--model=") ? arg.slice(8) : argv[++index];
        if (!model || model.startsWith("--")) throw new Error("--model requires a model name.");
      } else if (arg.startsWith("-")) throw new Error(`Option ${arg} is not supported by --text chat. Use VM chat for execution options, or put literal prompt text after --.`);
      else prompt.push(arg);
    }
    const think = environment.OVM_CHAT_THINK ?? "false";
    if (!["true", "false"].includes(think)) throw new Error("OVM_CHAT_THINK must be true or false. Use gent chat --help.");
    errorOutput.write(`Text-only chat with ${model}: this route cannot execute commands. Use gent chat or gent task for actual VM execution.${prompt.length ? "" : " Type /bye or press Ctrl+D to leave."}\n`);
    return run("ollama", ["run", `--think=${think}`, "--", model, ...(prompt.length ? [prompt.join(" ")] : [])], { cwd: root, env: { ...environment, ...(environment.OVM_OLLAMA_URL ? { OLLAMA_HOST: environment.OVM_OLLAMA_URL } : {}) } });
  }
  if (command === "setup") {
    if (argv.length) throw new Error(commandHelp("setup"));
    return setup(root, { run, environment, output });
  }
  let backend;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--json") continue;
    if (arg !== "--backend" && !arg.startsWith("--backend=")) throw new Error(commandHelp("check"));
    if (backend !== undefined) throw new Error("--backend was supplied more than once.");
    backend = arg === "--backend" ? argv[++index] : arg.slice("--backend=".length);
    if (!["auto", "apple", "qemu"].includes(backend)) throw new Error("--backend must be auto, apple, or qemu.");
  }
  const report = await inspect(root, { environment, ...(backend === undefined ? {} : { backend }) });
  output.write(argv.includes("--json") ? `${JSON.stringify(report, null, 2)}\n` : formatReadiness(report));
  return report.ok ? 0 : 2;
}
