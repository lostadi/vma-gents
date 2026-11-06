import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NativeCapabilityBroker } from "./native-capabilities.mjs";
import { VMLease } from "./lease.mjs";
import { DEFAULT_MODEL, OllamaAgentClient } from "./ollama-agent.mjs";
import { PocketSwarm } from "./pocket-swarm.mjs";
import { HostSearchBroker } from "./host-search.mjs";
import { pocketId } from "./swarm-protocol.mjs";
import { createVMFleet } from "./vm-backend.mjs";
import { DistributedVMFleet } from "./distributed-fleet.mjs";
import { applyDistributionEnvironment, validateDistributionMode } from "./distribution-config.mjs";
import { inspectAgent } from "./agent-capsule.mjs";
import { normalizeSource } from "./source-witness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");

const DEFAULT_ROLES = [
  { id: "scout", role: "Investigate the mission, gather host and guest facts, and report discoveries to peers." },
  { id: "builder", role: "Develop and execute the concrete solution inside the private Linux VM." },
  { id: "auditor", role: "Challenge assumptions, reproduce results, and verify the final result independently." },
  { id: "coordinator", role: "Integrate peer findings, identify missing work, and produce a coherent completion." },
];

function usage() {
  return `usage:
  gent swarm --mission TEXT [--agents N] [--rounds N] [--model NAME]
  gent swarm --spec FILE.json
  gent swarm --mission TEXT --dry-run [--json]
  gent resume ID [--mission TEXT] [--local | --on HOST]

options:
  --agents N             initial gent count, 1-8 (default: 3)
  --rounds N             maximum reasoning rounds, 1-20 (default: 4)
  --max-agents N         cap including dynamically spawned gents (default: 8)
  --model NAME           local Ollama model (default: ${DEFAULT_MODEL})
  --state-dir PATH       private state and persistent rootfs directory
  --swarm-id ID          stable swarm identity
  --resume ID            continue saved VM files and history
  --source guest:/PATH    bind input to an explicit source before reasoning
  --local                keep this task here with normal internet access
  --on HOST              select a connected VM controller
  --distribution MODE    auto, local, or required (saved default: auto)
  --backend MODE         auto, apple, or qemu (default: auto)
  --memory-mb N          memory for each gent, 512-4096 (default: 768)
  --cpu-count N          vCPUs for each gent, 1-4 (default: 1)
  --allow-native-act     enable cataloged keyboard, pointer, and app actions
  --dry-run              inspect model, native providers, and VM inputs without running
  --json                 machine-readable output

Each gent has a private Linux VM. Local Ollama performs reasoning on this host.
Automatic mode uses a compatible connected host when local capacity is low.
Use --isolated to disable guest networking; --local keeps internet access.`;
}

function option(argv, name) {
  const index = argv.findIndex(value => value === name || value.startsWith(`${name}=`));
  if (index < 0) return null;
  if (argv[index].startsWith(`${name}=`)) return argv[index].slice(name.length + 1);
  if (index + 1 >= argv.length) throw new Error(`${name} requires a value`);
  return argv[index + 1];
}

function boundedInteger(raw, name, fallback, minimum, maximum) {
  if (raw === null || raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function loadSpecification(argv) {
  const specPath = option(argv, "--spec");
  if (!specPath) return {};
  const absolute = path.resolve(specPath);
  const parsed = JSON.parse(readFileSync(absolute, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("swarm spec must be a JSON object");
  return parsed;
}

function initialAgents(count, mission, configured = null) {
  if (configured) {
    if (!Array.isArray(configured) || configured.length === 0) throw new Error("spec agents must be a nonempty array");
    return configured.map((agent) => ({
      id: pocketId(agent.id),
      role: String(agent.role ?? "General problem-solving agent"),
      mission: String(agent.mission ?? mission),
    }));
  }
  return Array.from({ length: count }, (_, index) => {
    const base = DEFAULT_ROLES[index % DEFAULT_ROLES.length];
    const suffix = index < DEFAULT_ROLES.length ? "" : `-${Math.floor(index / DEFAULT_ROLES.length) + 1}`;
    return { id: `${base.id}${suffix}`, role: base.role, mission };
  });
}

export function createSwarmReporter({ output = process.stdout, progress = process.stderr, json = false, now = Date.now } = {}) {
  const startedAt = now();
  return json ? () => {} : (event) => {
    const elapsed = ((now() - startedAt) / 1000).toFixed(1);
    const prefix = `[${elapsed}s]`;
    if (event.type === "round-start") {
      progress.write(`${prefix} Round ${event.round}/${event.maximumRounds}: asking ${event.agentIds.join(", ")}...\n`);
    } else if (event.type === "agent-result") {
      progress.write(`${prefix} ${event.agentId}: ${event.error ? `model decision failed: ${event.error}` : event.actions.join(", ") || "no actions"}\n`);
    } else if (event.type === "vm-start") {
      for (const task of event.tasks) {
        progress.write(`${prefix} ${task.agentId}: running in Linux: ${task.command.replace(/\s+/g, " ").slice(0, 160)}\n`);
      }
    } else if (event.type === "vm-result") {
      progress.write(`${prefix} ${event.agentId}: ${event.error ? `VM failed: ${event.error}` : event.ostadixStatus ? `Ostadix ${event.ostadixStatus}${event.peerStatus ? `; ${event.peerStatus}` : ""}` : `guest command exited ${event.exitCode ?? "unknown"}`}\n`);
      const captured = typeof event.output === "string" && event.output.length > 0
        ? event.output : "(no guest output)\n";
      output.write(`\n--- ${event.agentId}: guest output (round ${event.round}) ---\n${captured}${captured.endsWith("\n") ? "" : "\n"}`);
    } else if (event.type === "round-complete") {
      progress.write(`${prefix} Round ${event.round} saved; ${event.finished}/${event.totalAgents} gents finished.\n`);
    }
  };
}

export function formatSwarmReview(transcript) {
  const deferredFinish = "finish deferred: inspect this round's VM/native evidence on the next turn";
  const failedObservations = transcript.filter(({ observation }) =>
    observation.errors.some((error) => error !== deferredFinish) || observation.vm?.error ||
    (observation.vm?.exitCode !== undefined && observation.vm.exitCode !== 0));
  const deferredFinishes = transcript.reduce((count, { observation }) =>
    count + observation.errors.filter((error) => error === deferredFinish).length, 0);
  const lines = [];
  if (failedObservations.length > 0) {
    lines.push(`Review: ${failedObservations.length} ${failedObservations.length === 1 ? "gent turn contains" : "gent turns contain"} errors; details are saved in the state file.`);
  }
  if (deferredFinishes > 0) {
    lines.push(`Note: ${deferredFinishes} early finish ${deferredFinishes === 1 ? "request was" : "requests were"} deferred to allow results to be checked.`);
  }
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

export function resolveSwarmPlacement(argv, settings, environment = process.env) {
  const destination = option(argv, "--on");
  const explicitMode = option(argv, "--distribution");
  const local = argv.includes("--local");
  const networkMode = argv.includes("--isolated") ? "isolated" : environment.OVM_NETWORK_MODE ?? "nat";
  if (destination !== null) {
    if (!destination.trim() || destination.startsWith("-")) throw new Error("--on requires a connected machine name.");
    if (local || explicitMode === "local") throw new Error("Choose either local execution or --on HOST.");
    // Everyday task/chat launchers propagate --isolated through the environment.
    if (networkMode === "isolated") throw new Error("--on HOST cannot be combined with isolated networking. Remove --isolated or use local execution.");
  }
  // An invocation's named destination takes precedence over a saved local
  // default. The explicit target still requires successful remote admission.
  const defaultMode = destination !== null && settings.mode === "local" ? "auto" : settings.mode;
  return {
    distributionMode: validateDistributionMode(local ? "local" : explicitMode ?? defaultMode),
    target: local ? "local" : destination ?? "auto",
    networkMode,
  };
}

export async function runSwarmCli(argv, { output = process.stdout, progress = process.stderr } = {}) {
  if (argv.some((arg) => ["help", "--help", "-h"].includes(arg))) {
    output.write(`${usage()}\n`);
    return 0;
  }
  const json = argv.includes("--json");
  const settings = applyDistributionEnvironment(projectRoot);
  const { distributionMode, target, networkMode } = resolveSwarmPlacement(argv, settings);
  const dryRun = argv.includes("--dry-run");
  const allowNativeAct = argv.includes("--allow-native-act") || process.env.OVM_NATIVE_ALLOW_ACT === "1";
  const specification = loadSpecification(argv);
  const stateRoot = path.resolve(option(argv, "--state-dir") ?? specification.stateDirectory ?? path.join(projectRoot, "vm", "pockets"));
  const resumeId = option(argv, "--resume");
  const saved = resumeId ? await inspectAgent({ projectRoot, stateRoot, agentId: pocketId(resumeId) }) : null;
  const missionOverride = option(argv, "--mission") ?? specification.mission;
  const mission = missionOverride ?? saved?.state.mission;
  if (typeof mission !== "string" || mission.trim().length === 0) throw new Error(`a mission is required\n${usage()}`);
  const agentCount = boundedInteger(option(argv, "--agents") ?? specification.agentCount, "--agents", 3, 1, 8);
  const rounds = boundedInteger(option(argv, "--rounds") ?? specification.rounds, "--rounds", 4, 1, 20);
  const memoryMB = boundedInteger(option(argv, "--memory-mb") ?? specification.memoryMB, "--memory-mb", 768, 512, 4096);
  const cpuCount = boundedInteger(option(argv, "--cpu-count") ?? specification.cpuCount, "--cpu-count", 1, 1, 4);
  const model = option(argv, "--model") ?? specification.model ?? saved?.model ?? process.env.OVM_SWARM_MODEL ?? DEFAULT_MODEL;
  const swarmId = saved?.agentId ?? pocketId(option(argv, "--swarm-id") ?? specification.swarmId ?? `swarm-${Date.now().toString(36)}`);
  const stateDirectory = path.join(stateRoot, swarmId);
  if (!saved && existsSync(path.join(stateDirectory, "swarm.json"))) throw new Error(`Gent ${swarmId} already exists. Use gent resume ${swarmId}, or choose a new --swarm-id.`);
  const agents = saved?.state.agents ?? initialAgents(agentCount, mission, specification.agents);
  const maximumAgents = boundedInteger(option(argv, "--max-agents") ?? specification.maximumAgents ?? saved?.state.maximumAgents, "--max-agents", 8, agents.length, 16);
  const nativeBroker = new NativeCapabilityBroker({ allowAct: allowNativeAct });
  const swarmBinary = existsSync(path.join(projectRoot, "host", "OVMSwarm"))
    ? path.join(projectRoot, "host", "OVMSwarm")
    : path.join(projectRoot, "prebuilt", "macos-arm64", "OVMSwarm");
  const capsuleRuntime = saved && existsSync(path.join(stateDirectory, "capsule.json")) ? path.join(stateDirectory, "capsule-runtime") : null;
  const localFleet = createVMFleet({
    projectRoot,
    backend: option(argv, "--backend") ?? specification.backend,
    // A capsule exported by a QEMU-only host need not carry the Apple helper.
    // Automatic resume follows the bundled inputs instead of requiring a flag.
    ...(capsuleRuntime ? { supportedBackends: existsSync(path.join(capsuleRuntime, "smol-bin.arm64.img")) ? ["apple-vz-arm64", "qemu-arm64"] : ["qemu-arm64"] } : {}),
    binaryPath: swarmBinary,
    bundlePath: capsuleRuntime ?? path.join(projectRoot, "vm", "claudevm.bundle"),
    smolPath: capsuleRuntime ? path.join(capsuleRuntime, "smol-bin.arm64.img") : path.join(projectRoot, "host", "smol-bin.arm64.img"),
    stateDirectory,
    memoryMB,
    cpuCount,
    networkMode,
    distributionMode,
  });
  const vmFleet = new DistributedVMFleet({ local: localFleet, projectRoot, stateDirectory, swarmId, mode: distributionMode, target,
    onPlacement: placement => { if (!json) progress.write(`Execution: ${placement.kind === "remote" ? placement.peer.name : "this machine"}${placement.reason ? ` — ${placement.reason}` : ""}\n`); },
  });
  const native = await new HostSearchBroker(nativeBroker).describe();
  const plan = {
    protocol: "ovm.agent-pocket/v1",
    swarmId,
    mission,
    model,
    resumed: Boolean(saved),
    interaction: argv.includes("--interactive-turn") ? "chat" : "task",
    sourceBinding: option(argv, "--source") ? normalizeSource(option(argv, "--source")) : saved?.state.context?.sourceBinding ?? null,
    rounds,
    maximumAgents,
    stateDirectory,
    agents,
    native: {
      allowAct: native.allowAct,
      providers: native.providers,
      enabledOperations: native.operations.filter((operation) => operation.enabled).map(({ name, access, evidence }) => ({ name, access, evidence })),
    },
    vm: await vmFleet.probe(),
  };
  if (dryRun) {
    output.write(`${JSON.stringify(plan, null, json ? 0 : 2)}\n`);
    return 0;
  }

  const reportProgress = createSwarmReporter({ output, progress, json });
  if (!json) {
    progress.write(`Task: ${mission}\nModel: ${model}\nGents: ${agents.length} (maximum ${maximumAgents}); rounds: ${rounds}\n`);
  }

  const swarm = new PocketSwarm({
    mission,
    agents,
    modelClient: new OllamaAgentClient({ model }),
    vmFleet,
    nativeBroker,
    stateDirectory,
    swarmId,
    maximumRounds: rounds,
    maximumAgents,
    model,
    interactive: argv.includes("--interactive-turn"),
    resumeState: saved?.state,
    missionOverride: missionOverride !== undefined && Boolean(saved),
    context: { ...(saved?.state.context ?? {}), ...(option(argv, "--source") ? { sourceBinding: normalizeSource(option(argv, "--source")) } : {}) },
    onProgress: reportProgress,
  });
  const lease = new VMLease(path.join(stateDirectory, ".controller.lease"), {
    resource: `agent pocket swarm ${swarmId}`,
    staleRecovery: "verify no ovm-pocket process is running, then remove that exact file",
  });
  await lease.acquire();
  let result;
  try {
    if (saved && JSON.stringify(JSON.parse(readFileSync(saved.statePath, "utf8"))) !== JSON.stringify(saved.state)) throw new Error("Saved gent changed while opening it. Run resume again to use its latest state.");
    if (!saved && existsSync(path.join(stateDirectory, "swarm.json"))) throw new Error(`Gent ${swarmId} was created by another process. Use gent resume ${swarmId}.`);
    result = await swarm.run();
  } finally {
    await lease.release();
  }
  if (json) output.write(`${JSON.stringify(result)}\n`);
  else {
    output.write(`o-gents swarm ${result.swarmId}\n`);
    output.write(`Mission: ${result.mission}\n`);
    output.write(`Rounds: ${result.rounds}; ${result.waitingForUser ? "waiting for your next message" : result.completed ? "all gents finished" : result.blocked ? "paused awaiting result reconciliation" : "round limit reached with unfinished work"}\n`);
    for (const reply of result.lastReplies ?? []) {
      output.write(`\n${reply.message}\n`);
      const checks = reply.verification?.checks ?? [];
      output.write(`Reply evidence: ${reply.verification?.status === "checks-passed" ? `${checks.length} explicit assertions passed` : "reported; no semantic verification"}.\n`);
    }
    for (const agent of result.agents) {
      output.write(`- ${agent.id} [${agent.role}] ${agent.finished ? "finished" : "open"}\n`);
      if (agent.summary) output.write(`  Gent assessment: ${agent.summary}\n`);
      const checks = agent.verification?.checks ?? [];
      output.write(`  Evidence checks: ${agent.verification?.status === "checks-passed" ? `${checks.length} explicit assertions passed` : "unverified"}.\n`);
    }
    output.write("Gent completion and passed assertions do not establish overall mission correctness.\n");
    for (const artifact of result.programArtifacts ?? []) output.write(`Code ${artifact.name}: ${artifact.peerVerification.status} (${artifact.id})\n`);
    output.write(`State: ${result.statePath}\n`);
    output.write(formatSwarmReview(result.transcript));
  }
  return result.completed || result.waitingForUser ? 0 : 2;
}
