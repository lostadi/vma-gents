import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { mkdir, open, rename } from "node:fs/promises";
import path from "node:path";
import { AgentArtifactStore } from "./agent-artifacts.mjs";
import { HostSearchBroker } from "./host-search.mjs";
import { acceptSourceCapture, buildSourceTask } from "./source-witness.mjs";
import { acceptOstadixResult, buildOstadixTask } from "./ostadix-control.mjs";
import {
  parseAgentDecision,
  pocketId,
  SWARM_PROTOCOL,
  SwarmMailbox,
} from "./swarm-protocol.mjs";

function createAgent(specification, parentId = null) {
  return {
    id: pocketId(specification.id),
    role: String(specification.role).trim(),
    mission: String(specification.mission ?? "").trim(),
    parentId,
    inheritRootfs: specification.inheritRootfs ?? null,
    finished: false,
    summary: null,
    lastObservation: null,
    rounds: 0,
    errors: 0,
    pendingActions: structuredClone(specification.pendingActions ?? []),
    pendingClaims: [],
  };
}

function decisionExcerpt(content) {
  if (typeof content !== "string") return { rawDecision: null, rawDecisionTruncated: false };
  const bytes = Buffer.from(content);
  let end = Math.min(bytes.length, 16 * 1024);
  while (end < bytes.length && end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return { rawDecision: bytes.subarray(0, end).toString("utf8"), rawDecisionTruncated: end < bytes.length };
}

function assertionKinds(kind) {
  return ({ vm: ["stdout_contains", "stdout_equals", "exit_code"], ostadix: ["stdout_contains", "stdout_equals", "exit_code", "ostadix_checks_passed"], "peer-review": ["peer_review_passed"], native: ["native_value_equals"], artifact: ["artifact_sha256"], source: ["source_kind"] })[kind] ?? [];
}

function describeEvidence(record) {
  return {
    ...record,
    allowedAssertions: assertionKinds(record.kind),
    ...(["artifact-capture", "source-capture"].includes(record.kind) ? { meaning: "Controller capture metadata, not file contents or original command stdout. Use the corresponding artifact/source evidence or a prior kind:vm observation." } : {}),
  };
}

export class PocketSwarm {
  constructor({
    mission,
    agents,
    modelClient,
    vmFleet,
    nativeBroker,
    searchOptions = {},
    stateDirectory,
    swarmId,
    maximumRounds = 4,
    maximumAgents = 8,
    onProgress = () => {},
    resumeState = null,
    model,
    context,
    missionOverride = false,
    artifactStore = null,
    interactive = false,
  }) {
    if (resumeState && resumeState.protocol !== SWARM_PROTOCOL) throw new Error("unsupported saved swarm protocol");
    const overriddenMission = Boolean(resumeState && mission !== undefined && (missionOverride || mission !== resumeState.mission));
    mission ??= resumeState?.mission;
    agents ??= resumeState?.agents;
    if (typeof mission !== "string" || mission.trim().length === 0) throw new Error("swarm mission is required");
    if (!Array.isArray(agents) || agents.length === 0) throw new Error("at least one agent pocket is required");
    this.mission = mission.trim();
    this.agents = resumeState ? structuredClone(resumeState.agents) : agents.map((agent) => createAgent({ ...agent, mission: agent.mission || mission }));
    for (const agent of this.agents) {
      if (pocketId(agent.id) !== agent.id) throw new Error("saved agent IDs must be canonical");
      agent.pendingActions ??= [];
      agent.pendingClaims ??= [];
      if (!Array.isArray(agent.pendingActions) || !Array.isArray(agent.pendingClaims)) throw new Error("saved pending actions and claims must be arrays");
      if (overriddenMission) {
        agent.finished = false; agent.summary = null; agent.mission = this.mission;
        delete agent.verification; delete agent.completionEvidence;
        agent.pendingActions = []; agent.pendingClaims = [];
      }
    }
    if (new Set(this.agents.map((agent) => agent.id)).size !== this.agents.length) throw new Error("agent pocket ids must be unique");
    this.modelClient = modelClient;
    this.vmFleet = vmFleet;
    this.nativeBroker = new HostSearchBroker(nativeBroker, searchOptions);
    this.stateDirectory = stateDirectory;
    this.swarmId = pocketId(swarmId ?? resumeState?.swarmId ?? `swarm-${randomUUID().slice(0, 8)}`);
    this.round = resumeState?.round ?? 0;
    if (!Number.isSafeInteger(this.round) || this.round < 0 || !Number.isSafeInteger(maximumRounds) || maximumRounds < 1) throw new Error("saved and additional round counts must be valid nonnegative integers");
    this.startingRound = this.round;
    this.reviewStartRound = overriddenMission ? this.round : (resumeState?.reviewStartRound ?? 0);
    this.maximumRounds = this.round + maximumRounds;
    this.maximumAgents = maximumAgents;
    this.onProgress = onProgress;
    this.interactive = interactive === true;
    this.waitingForUser = false;
    this.mailbox = new SwarmMailbox(this.agents.map((agent) => agent.id), { snapshot: resumeState?.mailbox, history: resumeState?.messages ?? [], transcript: resumeState?.transcript ?? [] });
    this.transcript = structuredClone(resumeState?.transcript ?? []);
    this.model = model ?? resumeState?.model ?? resumeState?.transcript?.findLast((turn) => turn.model)?.model ?? modelClient?.model ?? null;
    this.context = structuredClone(context ?? resumeState?.context ?? {});
    this.sourceFacts = structuredClone(resumeState?.sourceFacts ?? []);
    this.programArtifacts = structuredClone(resumeState?.programArtifacts ?? []);
    this.artifactReviews = structuredClone(resumeState?.artifactReviews ?? []);
    if (this.round === 0 && this.context.sourceBinding?.scope === "guest" && this.context.sourceBinding.path && !this.sourceFacts.length) {
      const primary = this.agents.find((agent) => agent.id === "scout") ?? this.agents[0];
      if (!primary.pendingActions.some((queued) => queued.action?.type === "inspect_source" && queued.action.path === this.context.sourceBinding.path)) primary.pendingActions.unshift({ id: randomUUID(), action: { type: "inspect_source", path: this.context.sourceBinding.path, scope: "guest", reason: "Inspect the explicitly user-selected source before deriving work" }, requires: "user-bound-source", createdRound: 0 });
    }
    this.artifactStore = artifactStore ?? new AgentArtifactStore({ stateDirectory, swarmId: this.swarmId });
    const instanceId = randomUUID();
    this.capsuleIdentity = structuredClone(resumeState?.capsuleIdentity ?? { schema: "ovm.agent-identity/v1", instanceId, lineageId: instanceId, parentInstanceId: null });
    this.pendingDispatch = structuredClone(resumeState?.pendingDispatch ?? null);
    this.pendingNative = structuredClone(resumeState?.pendingNative ?? null);
    this.blocked = structuredClone(resumeState?.blocked ?? null);
    this.resumeMetadata = resumeState ? structuredClone(resumeState) : {};
  }

  async persist(round) {
    await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
    const target = path.join(this.stateDirectory, "swarm.json");
    const temporary = `${target}.tmp-${process.pid}`;
    const state = {
      ...this.resumeMetadata,
      protocol: SWARM_PROTOCOL,
      swarmId: this.swarmId,
      mission: this.mission,
      round,
      maximumRounds: this.maximumRounds,
      maximumAgents: this.maximumAgents,
      agents: this.agents,
      model: this.model,
      context: this.context,
      sourceFacts: this.sourceFacts,
      reviewStartRound: this.reviewStartRound,
      programArtifacts: this.programArtifacts,
      artifactReviews: this.artifactReviews,
      capsuleIdentity: this.capsuleIdentity,
      messages: this.mailbox.history,
      mailbox: this.mailbox.snapshot(),
      transcript: this.transcript,
      pendingDispatch: this.pendingDispatch,
      pendingNative: this.pendingNative,
      blocked: this.blocked,
      interactive: this.interactive,
      waitingForUser: this.waitingForUser,
      status: this.blocked ? "blocked" : this.agents.every((agent) => agent.finished) ? "completed" : this.waitingForUser ? "waiting-for-user" : "paused",
    };
    const handle = await open(temporary, "w", 0o600);
    try { await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, target);
    return target;
  }

  applySpawnRequests(spawnRequests, round, observations) {
    for (const { parentId, action } of spawnRequests) {
      const parent = this.agents.find((agent) => agent.id === parentId);
      const observation = observations.get(parentId);
      if (!parent || !observation) throw new Error("Saved child request does not match its parent observation");
      if (this.agents.length >= this.maximumAgents) { observation.errors.push(`spawn ${action.id}: maximum agent count reached`); continue; }
      if (this.agents.some((agent) => agent.id === action.id)) { observation.errors.push(`spawn ${action.id}: duplicate agent id`); continue; }
      const child = createAgent({ id: action.id, role: action.role, mission: action.mission, inheritRootfs: this.vmFleet.rootfsPath(parent.id) }, parent.id);
      this.agents.push(child); this.mailbox.register(child.id);
      this.mailbox.send({ from: parent.id, to: child.id, message: `Spawned for subtask: ${action.mission}`, round, kind: "request" });
      observation.messages.push({ spawned: child.id });
    }
  }

  recordEvidence(agentId, observation) {
    const evidence = [];
    const identity = `${this.swarmId}:${agentId}:${observation.round}`;
    const hash = (value) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value) ?? "null").digest("hex");
    if (observation.vm) evidence.push({ id: `${identity}:vm`, producer: agentId, round: observation.round, kind: observation.vm.ostadixCapture ? "ostadix-capture" : observation.vm.artifactCapture ? "artifact-capture" : observation.vm.sourceInspection ? "source-capture" : "vm", status: observation.vm.error ? "error" : "observed", exitCode: observation.vm.exitCode ?? null, contentSha256: hash(observation.vm.output ?? ""), semanticVerification: false });
    if (observation.ostadix) evidence.push({ id: `${identity}:ostadix`, producer: agentId, round: observation.round, kind: observation.ostadix.executed ? "ostadix" : "ostadix-check", sourceSha256: observation.ostadix.sourceSha256, executed: observation.ostadix.executed, checkStatus: observation.ostadix.checkStatus, exitCode: observation.ostadix.exitCode, status: observation.ostadix.success ? "observed" : "error", contentSha256: hash(observation.ostadix.stdout ?? ""), semanticVerification: false });
    if (observation.peerReview) evidence.push({ id: `${identity}:peer-review`, producer: agentId, round: observation.round, kind: "peer-review", review: structuredClone(observation.peerReview), status: observation.peerReview.status, semanticVerification: false });
    for (const [index, native] of (observation.native ?? []).entries()) evidence.push({ id: `${identity}:native:${index}`, producer: agentId, round: observation.round, kind: "native", operation: native.operation, status: "observed", contentSha256: hash(native.value), semanticVerification: false });
    for (const [index, artifact] of (observation.artifacts ?? []).entries()) evidence.push({ id: `${identity}:artifact:${index}`, producer: agentId, round: observation.round, kind: "artifact", artifact: structuredClone(artifact), status: "observed", semanticVerification: false });
    for (const fact of observation.sourceFacts ?? []) evidence.push({ id: fact.evidenceId, producer: fact.producer, round: fact.round, kind: "source", sourceFact: structuredClone(fact), status: "observed", semanticVerification: false });
    observation.evidence = evidence.map(describeEvidence);
    return observation.evidence;
  }

  visibleEvidence(agentId, inbox = []) {
    const visible = new Set(this.sourceFacts.map((fact) => fact.evidenceId));
    // Publishing code deliberately shares its execution provenance with peers.
    for (const artifact of this.programArtifacts) visible.add(artifact.code.executionEvidenceId);
    for (const review of this.artifactReviews) visible.add(review.reviewEvidenceId);
    for (const turn of this.transcript) {
      if (turn.agentId === agentId) {
        for (const entry of turn.observation.evidence ?? this.recordEvidence(turn.agentId, turn.observation)) visible.add(entry.id);
        for (const message of turn.inbox ?? []) for (const entry of message.evidence ?? []) visible.add(entry.id);
      }
    }
    for (const message of inbox) for (const entry of message.evidence ?? []) visible.add(entry.id);
    const records = new Map();
    for (const turn of this.transcript) for (const entry of turn.observation.evidence ?? this.recordEvidence(turn.agentId, turn.observation)) {
      if (visible.has(entry.id)) records.set(entry.id, { record: describeEvidence(entry), observation: turn.observation, actions: turn.actions });
    }
    return records;
  }

  resolveClaims(action, agentId, inbox) {
    const available = this.visibleEvidence(agentId, inbox);
    const ids = [...new Set([...(action.evidence ?? []), ...(action.assertions ?? []).map((check) => check.evidenceId)])];
    const evidence = ids.map((id) => {
      const entry = available.get(id);
      if (!entry) throw new Error(`Evidence ${id} has not been observed by ${agentId}`);
      return structuredClone(entry.record);
    });
    const checks = (action.assertions ?? []).map((assertion) => {
      const entry = available.get(assertion.evidenceId);
      const allowedAssertions = assertionKinds(entry.record.kind);
      const result = { ...assertion, evidenceKind: entry.record.kind, allowedAssertions };
      if (!allowedAssertions.includes(assertion.kind)) return { ...result, passed: false, reason: `${assertion.kind} cannot check evidence kind ${entry.record.kind}. ${allowedAssertions.length ? `Allowed assertion: ${allowedAssertions.join(", ")}.` : "This is controller capture metadata; use the corresponding artifact/source evidence or a prior kind:vm observation."}` };
      if (assertion.kind === "ostadix_checks_passed") return { ...result, passed: entry.observation.ostadix?.executed === true && entry.observation.ostadix?.checkStatus === "checks-passed" };
      if (assertion.kind === "peer_review_passed") return { ...result, passed: entry.observation.peerReview?.status === "peer-verified" };
      if (assertion.kind === "native_value_equals") {
        const index = Number(entry.record.id.split(":").at(-1));
        const actual = entry.observation.native?.[index]?.value;
        const passed = isDeepStrictEqual(actual, assertion.expected);
        return { ...result, passed, ...(!passed ? { reason: "Observed native value differs from expected", observedExcerpt: (JSON.stringify(actual) ?? "undefined").slice(0, 1024) } : {}) };
      }
      if (assertion.kind === "artifact_sha256") return { ...result, passed: entry.record.artifact.sha256 === assertion.expected, observed: entry.record.artifact.sha256 };
      if (assertion.kind === "source_kind") return { ...result, passed: entry.record.sourceFact.kind === assertion.expected, observed: entry.record.sourceFact.kind };
      const vm = entry.record.kind === "ostadix" ? { ...entry.observation.ostadix, output: entry.observation.ostadix.stdout } : entry.observation.vm;
      const passed = !vm.error && (assertion.kind === "exit_code" ? vm.exitCode === assertion.expected : assertion.kind === "stdout_equals" ? vm.output === assertion.expected : String(vm.output ?? "").includes(assertion.expected));
      return { ...result, passed, ...(!passed ? { reason: vm.error ? `VM result has an execution error: ${String(vm.error).slice(0, 512)}` : "Observed VM result does not satisfy the expected value", ...(assertion.kind === "exit_code" ? { observed: vm.exitCode ?? null } : { observedExcerpt: String(vm.output ?? "").slice(0, 1024) }) } : {}) };
    });
    return { evidence, verification: { status: checks.length && checks.every((check) => check.passed) ? "checks-passed" : "unverified", scope: "explicit assertions only; mission correctness is not inferred", contentVerified: checks.some((check) => check.passed && (check.kind.startsWith("stdout_") || check.kind === "artifact_sha256")), checks } };
  }

  assertionRepair(action, claims, agentId, inbox) {
    const failedChecks = claims.verification.checks.filter((check) => !check.passed);
    const available = [...this.visibleEvidence(agentId, inbox).values()].slice(-8).map(({ record }) => ({ evidenceId: record.id, kind: record.kind, allowedAssertions: record.allowedAssertions }));
    return { dropped: action.type, reason: "invalid-evidence-assertion", detail: failedChecks.map((check) => `${check.evidenceId}: ${check.reason ?? "observed value differs from expected"}`).join("; "), failedChecks, availableEvidence: available, instruction: "Review the specific failed checks and the original observations. Amend the reply/finish to what those observations support; do not repeat successful work or treat capture metadata as file contents." };
  }

  projectedQueuedAction(agent, inbox) {
    const repairs = [];
    while (agent.pendingActions.length) {
      const queued = agent.pendingActions.shift();
      const projected = parseAgentDecision(JSON.stringify({ actions: [queued.action] }));
      if (!projected.actions.length || !["publish", "inspect_source"].includes(projected.actions[0].type)) {
        repairs.push({ dropped: queued.action?.type ?? "queued-action", reason: "invalid-queue", detail: "Only validated publication and read-only source inspection may execute from the controller queue" });
        continue;
      }
      queued.action = projected.actions[0];
      if (queued.requires === "vm-success") {
        const entry = this.visibleEvidence(agent.id, inbox).get(queued.queuedAgainst);
        if (!entry || entry.record.kind !== "vm" || entry.observation.vm?.error || entry.observation.vm?.exitCode !== 0) {
          repairs.push({ dropped: queued.action?.type ?? "queued-action", reason: "failed-prerequisite", queuedAgainst: queued.queuedAgainst, detail: "Queued publication cancelled because its producing VM command did not succeed" });
          continue;
        }
      }
      this.mailbox.putBack(agent.id, inbox);
      return { action: queued.action, repairs, queued };
    }
    return { action: null, repairs };
  }

  reusableSourceFact(agentId, sourcePath) {
    const fact = this.sourceFacts.findLast((entry) => entry.producer === agentId && entry.scope === "guest" && entry.path === sourcePath);
    if (!fact) return null;
    const laterVm = this.transcript.some((turn) => turn.agentId === agentId && turn.round > fact.round && turn.actions.some((action) => ["vm", "ostadix", "review_artifact"].includes(action.type)));
    return laterVm ? null : fact;
  }

  codeArtifactStatus(artifact) {
    const review = this.artifactReviews.findLast((entry) => entry.artifactId === artifact.id && entry.sourceSha256 === artifact.sha256);
    return { ...artifact, peerVerification: review ?? { status: "awaiting-peer-review", scope: "A distinct gent must execute this exact source and pass its explicit checks" } };
  }

  pendingCodeReviews(agentId) {
    const latest = new Map();
    // Successful execution still creates a review obligation if publication
    // fails. Derive it from retained decisions so resume cannot lose the gate.
    for (const turn of this.transcript) {
      if (turn.agentId !== agentId || turn.round <= this.reviewStartRound || !turn.observation.ostadix?.success || !turn.observation.ostadix.executed) continue;
      const action = turn.actions.find((entry) => entry.type === "ostadix" && entry.mode === "run");
      if (action) latest.set(action.name, { id: `unpublished:${this.swarmId}:${agentId}:${turn.round}:ostadix`, name: action.name,
        sha256: turn.observation.ostadix.sourceSha256, code: { createdRound: turn.round },
        publicationError: turn.observation.publicationError ?? "Published source receipt is missing" });
    }
    for (const artifact of this.programArtifacts) {
      if (artifact.producer === agentId && artifact.code.createdRound > this.reviewStartRound
        && artifact.code.createdRound >= (latest.get(artifact.name)?.code.createdRound ?? 0)) latest.set(artifact.name, artifact);
    }
    return [...latest.values()].filter((artifact) => this.codeArtifactStatus(artifact).peerVerification.status !== "peer-verified");
  }

  ensureCodeReviewer(producer, round, observation) {
    if (this.agents.some((agent) => agent.id !== producer && !agent.finished)) return;
    const previous = this.agents.find((agent) => agent.id !== producer);
    if (previous) {
      previous.finished = false; previous.summary = null;
      delete previous.verification; delete previous.completionEvidence;
      observation.repairs.push({ reason: "peer-reviewer-reopened", reviewer: previous.id, detail: "New code needs a distinct peer check; the finished reviewer has been reactivated" });
    } else if (this.agents.length < this.maximumAgents) {
      const id = `${producer.slice(0, 32)}-reviewer`;
      const reviewer = createAgent({ id, role: "Independently read and rerun published Ostadix programs with review_artifact before reporting results", mission: this.mission }, producer);
      this.agents.push(reviewer); this.mailbox.register(id);
      observation.repairs.push({ reason: "peer-reviewer-created", reviewer: id, round, detail: "A distinct reviewer was added within maximumAgents to check the published code" });
    } else {
      observation.repairs.push({ reason: "peer-reviewer-unavailable", detail: "Peer checking requires at least two gents. Increase maximumAgents and resume; this artifact cannot be peer-verified by its producer." });
    }
  }

  readExecution(action, agentId, inbox) {
    const entry = this.visibleEvidence(agentId, inbox).get(action.evidenceId);
    if (!entry || !["vm", "ostadix", "ostadix-check", "peer-review"].includes(entry.record.kind)) throw new Error("Execution evidence is unknown, unseen, or is capture metadata");
    const result = entry.observation.ostadix ?? entry.observation.vm;
    const excerpt = (value, limit) => ({ text: String(value ?? "").slice(0, limit), truncated: String(value ?? "").length > limit });
    return { evidence: structuredClone(entry.record), source: entry.actions.find((item) => item.type === "ostadix")?.source ?? null,
      actions: entry.actions.filter((item) => ["vm", "ostadix", "review_artifact"].includes(item.type)),
      stdout: excerpt(result?.stdout ?? result?.output, 8192), stderr: excerpt(result?.stderr ?? result?.error, 2048),
      exitCode: result?.exitCode ?? null, checks: result?.checks ?? [], peerReview: entry.observation.peerReview ?? null,
      independentVerification: false, meaning: "Read of a retained observation; no new execution occurred" };
  }

  recordPeerReview(task, execution, round, observation, error = null) {
    const target = this.programArtifacts.find((artifact) => artifact.id === task.ostadix.reviewOf.artifactId);
    if (!target || target.producer === task.agentId || target.sha256 !== task.ostadix.sourceSha256
      || (execution && execution.sourceSha256 !== target.sha256)
      || !isDeepStrictEqual(task.ostadix.checks, target.code.contract.checks)) throw new Error("Peer review does not match a distinct producer's published source and check contract");
    const review = { artifactId: target.id, sourceSha256: target.sha256, producer: target.producer, reviewer: task.agentId,
      reviewerInstanceId: this.capsuleIdentity.instanceId, executionEvidenceId: target.code.executionEvidenceId,
      reviewEvidenceId: `${this.swarmId}:${task.agentId}:${round}:peer-review`, round,
      status: error ? "unverified" : execution.success && execution.executed && execution.checkStatus === "checks-passed" ? "peer-verified" : "checks-failed",
      checks: execution?.checks ?? [], ...(error ? { error } : {}),
      scope: error ? "The peer rerun returned no acceptable execution receipt; no successful check is established"
        : "Exact published source and declared output checks rerun in a distinct gent VM; broader correctness is not inferred" };
    observation.peerReview = review;
    if (!this.artifactReviews.some((entry) => entry.reviewEvidenceId === review.reviewEvidenceId)) this.artifactReviews.push(review);
    const producer = this.agents.find((agent) => agent.id === target.producer);
    if (producer?.finished && this.pendingCodeReviews(producer.id).length) {
      producer.finished = false; producer.summary = null;
      delete producer.verification; delete producer.completionEvidence;
      observation.repairs.push({ reason: "producer-review-invalidated", producer: producer.id,
        detail: "A later peer rerun failed or was unverified; the producer's completion was reopened for review" });
    }
  }

  async applyWorkers(tasks, workers, round, observations, { recovered = false } = {}) {
    const byId = new Map(Array.isArray(workers) ? workers.map((worker) => [worker?.agent, worker]) : []);
    if (!Array.isArray(workers) || workers.length !== tasks.length || byId.size !== workers.length || tasks.some((task) => !byId.has(task.agentId)) || workers.some((worker) => worker?.stopped === false)) {
      const error = new Error("VM worker returned no unique correlated result; execution outcome is uncertain"); error.uncertain = true; throw error;
    }
    for (const task of tasks) {
      const observation = observations.get(task.agentId);
      if (!observation) throw new Error("VM receipt has no saved agent observation");
      observation.vm = structuredClone(byId.get(task.agentId));
      observation.vm.commandSha256 = createHash("sha256").update(task.command).digest("hex");
      if (task.ostadix) {
        observation.vm.ostadixCapture = true;
        try {
          const execution = acceptOstadixResult(task, observation.vm);
          observation.ostadix = execution;
          observation.vm.output = JSON.stringify(execution);
          if (task.ostadix.reviewOf) {
            this.recordPeerReview(task, execution, round, observation);
          } else if (execution.executed && execution.checkStatus === "checks-passed") {
            const artifact = await this.artifactStore.publishOstadix(task, execution, { evidenceId: `${this.swarmId}:${task.agentId}:${round}:ostadix`, instanceId: this.capsuleIdentity.instanceId });
            observation.artifacts ??= [];
            if (!observation.artifacts.some((entry) => entry.id === artifact.id)) observation.artifacts.push(artifact);
            if (!this.programArtifacts.some((entry) => entry.id === artifact.id)) {
              this.programArtifacts.push(artifact);
              this.ensureCodeReviewer(task.agentId, round, observation);
              this.mailbox.send({ from: task.agentId, to: "all", kind: "request", round, message: `Review code artifact ${artifact.id}: read execution ${artifact.code.executionEvidenceId}, inspect its source, then use review_artifact to rerun its declared checks in your own VM.`, evidence: [] });
            }
          }
        } catch (error) {
          if (task.ostadix.reviewOf) {
            try { this.recordPeerReview(task, null, round, observation, error.message); }
            catch (bindingError) { observation.errors.push(`Peer review binding rejected: ${bindingError.message}`); }
          }
          if (!task.ostadix.reviewOf && observation.ostadix?.success && observation.ostadix.executed) observation.publicationError = error.message;
          observation.errors.push(`Ostadix receipt rejected: ${error.message}`); observation.vm.error = error.message;
        }
      }
      if (task.sourceInspection) {
        observation.vm.sourceInspection = true;
        try {
          const fact = { ...acceptSourceCapture(task, observation.vm), evidenceId: `${this.swarmId}:${task.agentId}:${round}:source:0` };
          observation.sourceFacts = [fact];
          this.sourceFacts = this.sourceFacts.filter((entry) => !(entry.producer === fact.producer && entry.path === fact.path && entry.scope === fact.scope));
          this.sourceFacts.push(fact); this.sourceFacts = this.sourceFacts.slice(-64);
          observation.vm.output = JSON.stringify(fact, null, 2);
        } catch (error) { observation.errors.push(`source inspection failed: ${error.message}`); observation.vm.output = `Source inspection failed: ${error.message}`; }
      }
      if (task.artifactPublication) {
        observation.vm.artifactCapture = true;
        try {
          const receipt = await this.artifactStore.acceptCapture(task, observation.vm);
          observation.artifacts ??= [];
          if (!observation.artifacts.some((entry) => JSON.stringify(entry) === JSON.stringify(receipt))) observation.artifacts.push(receipt);
          observation.vm.output = JSON.stringify(receipt, null, 2);
        } catch (error) {
          observation.errors.push(`artifact publication failed: ${error.message}`);
          observation.vm.output = `Artifact capture was not published: ${error.message}`;
          observation.vm.artifactError = error.message;
        }
      }
      if (recovered) observation.vm.recovered = true;
      this.recordEvidence(task.agentId, observation);
      const agent = this.agents.find((entry) => entry.id === task.agentId);
      if (agent && (!agent.lastObservation || agent.lastObservation.round <= round)) agent.lastObservation = observation;
      this.onProgress({ type: "vm-result", round, agentId: task.agentId,
        exitCode: observation.ostadix?.exitCode ?? observation.vm.exitCode ?? null,
        error: (observation.vm.error ?? observation.ostadix?.error)?.slice(0, 1024) ?? null,
        ...(observation.ostadix ? { ostadixStatus: observation.ostadix.checkStatus, peerStatus: observation.peerReview?.status,
          output: observation.ostadix.stdout || observation.ostadix.stderr || `${observation.ostadix.checkStatus}\n` } : { output: observation.vm.output ?? "" }) });
    }
  }

  async recoverBeforeReasoning() {
    if (this.pendingNative) {
      this.blocked = { kind: "native-outcome-unknown", round: this.pendingNative.round, error: "A host-native action was interrupted before its result was saved; no action was replayed." };
      await this.persist(this.round); return false;
    }
    let recovered;
    try {
      recovered = await this.vmFleet.recover?.();
      if (!recovered) {
        if (this.pendingDispatch) throw new Error("Saved VM dispatch has no recoverable receipt; no command was replayed");
        if (this.blocked) { await this.persist(this.round); return false; }
        return true;
      }
      const tasks = recovered.tasks ?? this.pendingDispatch?.tasks;
      if (!Array.isArray(tasks) || !tasks.length) throw new Error("Recovered VM receipt has no task identities");
      const pending = this.pendingDispatch;
      if (!pending && recovered.dispatchId) {
        const alreadyCommitted = tasks.every((task) => this.transcript.some((turn) => turn.agentId === task.agentId
          && turn.observation.vm?.placement?.dispatchId === recovered.dispatchId
          && turn.observation.vm?.commandSha256 === createHash("sha256").update(task.command).digest("hex")));
        if (alreadyCommitted) { this.blocked = null; await this.persist(this.round); await this.vmFleet.acknowledge?.(recovered.dispatchId); return true; }
      }
      let round = pending?.round ?? recovered.round;
      if (!round) {
        const matching = this.transcript.filter((turn) => tasks.some((task) => task.agentId === turn.agentId && turn.actions?.some((action) => action.type === "vm" && action.command === task.command)));
        round = Math.max(0, ...matching.map((turn) => turn.round));
      }
      const turns = this.transcript.filter((turn) => turn.round === round);
      if (!round || !turns.length || tasks.some((task) => !turns.some((turn) => turn.agentId === task.agentId && turn.actions?.some((action) => (action.type === "vm" && action.command === task.command) || (["publish", "inspect_source", "ostadix", "review_artifact"].includes(action.type) && pending?.tasks.some((saved) => saved.agentId === task.agentId && saved.command === task.command && (saved.artifactPublication || saved.sourceInspection || saved.ostadix))))))) throw new Error("Recovered VM receipt does not match the saved decisions");
      if (pending && (pending.tasks.length !== tasks.length || pending.tasks.some((task) => !tasks.some((entry) => task.agentId === entry.agentId && task.command === entry.command)))) throw new Error("Recovered VM receipt does not match the pending dispatch");
      const observations = new Map(turns.map((turn) => [turn.agentId, turn.observation]));
      await this.applyWorkers(pending?.tasks ?? tasks, recovered.workers ?? recovered, round, observations, { recovered: true });
      if (pending?.error) for (const task of tasks) observations.get(task.agentId).errors = observations.get(task.agentId).errors.filter((error) => error !== `VM fleet: ${pending.error}`);
      this.applySpawnRequests(pending?.spawnRequests ?? [], round, observations);
      this.pendingDispatch = null; this.blocked = null;
      await this.persist(this.round);
      await this.vmFleet.acknowledge?.(recovered.dispatchId);
      return true;
    } catch (error) {
      // Explicit refusal is the only case where an interrupted dispatch is
      // known not to have executed. It can safely return to normal reasoning.
      if (error.rejected === true && this.pendingDispatch) {
        const pending = this.pendingDispatch;
        const turns = this.transcript.filter((turn) => turn.round === pending.round);
        for (const turn of turns.filter((turn) => pending.tasks.some((task) => task.agentId === turn.agentId))) {
          if (pending.error) turn.observation.errors = turn.observation.errors.filter((message) => message !== `VM fleet: ${pending.error}`);
          turn.observation.errors.push(`VM fleet declined before execution: ${error.message}`);
          const agent = this.agents.find((entry) => entry.id === turn.agentId); if (agent) agent.lastObservation = turn.observation;
        }
        this.applySpawnRequests(pending.spawnRequests ?? [], pending.round, new Map(turns.map((turn) => [turn.agentId, turn.observation])));
        this.pendingDispatch = null; this.blocked = null;
        await this.persist(this.round); await this.vmFleet.acknowledge?.(); return true;
      }
      this.blocked = { kind: "vm-outcome-unknown", round: this.pendingDispatch?.round ?? this.round, error: error.message };
      await this.persist(this.round); return false;
    }
  }

  async run() {
    const recovered = await this.recoverBeforeReasoning();
    if (!recovered) return this.result(await this.persist(this.round));
    const native = await this.nativeBroker.describe();
    const nativeOperations = native.operations.filter((operation) => operation.enabled);
    for (let round = this.round + 1; round <= this.maximumRounds; round += 1) {
      const active = this.agents.filter((agent) => !agent.finished);
      if (active.length === 0) break;
      this.round = round;
      this.onProgress({ type: "round-start", round, maximumRounds: this.maximumRounds, agentIds: active.map(({ id }) => id) });
      const peerIds = this.agents.map((agent) => agent.id);
      const decisions = await Promise.all(active.map(async (agent) => {
        const inbox = this.mailbox.drain(agent.id);
        let response = null;
        try {
          const queued = this.projectedQueuedAction(agent, inbox);
          if (queued.action) {
            const decision = { rationale: `Execute the queued ${queued.action.type} action after its prerequisite`, actions: [queued.action], repairs: queued.repairs, queuedActions: [] };
            this.onProgress({ type: "agent-result", round, agentId: agent.id, actions: [queued.action.type], error: null });
            return { agent, inbox: [], response: { model: "controller-queue", metrics: null }, decision, synthetic: true };
          }
          response = await this.modelClient.decide(agent, {
            protocol: SWARM_PROTOCOL,
            swarmId: this.swarmId,
            mission: this.mission,
            interaction: this.interactive ? "chat" : "task",
            round,
            currentInvocationStartRound: this.startingRound,
            maximumRounds: this.maximumRounds,
            maximumAgents: this.maximumAgents,
            peers: this.agents.filter((peer) => peer.id !== agent.id).map((peer) => ({
              id: peer.id,
              role: peer.role,
              finished: peer.finished,
            })),
            inbox,
            nativeOperations,
            pendingActions: structuredClone(agent.pendingActions),
            pendingClaims: structuredClone(agent.pendingClaims),
            repairs: [...(agent.lastObservation?.repairs ?? []), ...queued.repairs],
            sourceFacts: structuredClone(this.sourceFacts.slice(-64)),
            sourceBinding: this.context.sourceBinding ?? null,
            availableEvidence: [...this.visibleEvidence(agent.id, inbox).values()].map(({ record }) => record),
            availableArtifacts: (await this.artifactStore?.list() ?? []).map((artifact) => artifact.kind === "ostadix-program" ? this.codeArtifactStatus(artifact) : artifact),
            artifactReviews: structuredClone(this.artifactReviews.slice(-32)),
            pendingCodeReviews: this.pendingCodeReviews(agent.id).map((artifact) => ({ id: artifact.id, name: artifact.name, sourceSha256: artifact.sha256, ...(artifact.publicationError ? { publicationError: artifact.publicationError } : {}) })),
            recentHistory: this.transcript.filter((turn) => turn.agentId === agent.id).slice(-4),
            lastExecutionObservation: this.transcript.findLast((turn) => turn.agentId === agent.id &&
              (turn.observation.ostadix || turn.observation.vm || turn.observation.native?.length || turn.observation.peerReview))?.observation ?? null,
          });
          const decision = parseAgentDecision(response.content, { peerIds, nativeOperations: nativeOperations.map(({ name }) => name), interactive: this.interactive });
          this.onProgress({ type: "agent-result", round, agentId: agent.id, actions: decision.actions.map(({ type }) => type), error: null });
          return {
            agent,
            inbox,
            response,
            decision: { ...decision, repairs: [...queued.repairs, ...decision.repairs] },
          };
        } catch (error) {
          agent.errors += 1;
          this.onProgress({ type: "agent-result", round, agentId: agent.id, actions: [], error: error.message.slice(0, 1024) });
          return { agent, inbox, response, error: error.message, decision: { rationale: "", actions: [] } };
        }
      }));

      const vmTasks = [];
      const nativeTasks = [];
      const spawnRequests = [];
      const observations = new Map(active.map((agent) => [agent.id, { round, messages: [], native: [], vm: null, errors: [], repairs: [] }]));

      for (const item of decisions) {
        const { agent, decision } = item;
        if (item.error) observations.get(agent.id).errors.push(item.error);
        const vmEvidenceId = `${this.swarmId}:${agent.id}:${round}:vm`;
        observations.get(agent.id).repairs.push(...(decision.repairs ?? []).map((repair) => repair.queuedAgainst === "this-turn-vm" ? { ...repair, queuedAgainst: vmEvidenceId } : repair));
        for (const queued of decision.queuedActions ?? []) agent.pendingActions.push({ id: randomUUID(), ...structuredClone(queued), queuedAgainst: vmEvidenceId, createdRound: round });
        agent.rounds += 1;
        const requestedNewEvidence = decision.actions.some((action) => ["vm", "native", "publish", "ostadix", "review_artifact"].includes(action.type) || (action.type === "inspect_source" && !this.reusableSourceFact(agent.id, action.path)));
        for (const action of decision.actions) {
          if (action.type === "send") {
            if (requestedNewEvidence && action.kind === "report") {
              const binding = decision.actions.some((entry) => entry.type === "inspect_source") ? `${this.swarmId}:${agent.id}:${round}:source:0` : decision.actions.some((entry) => ["ostadix", "review_artifact"].includes(entry.type)) ? `${this.swarmId}:${agent.id}:${round}:ostadix` : decision.actions.some((entry) => ["vm", "publish"].includes(entry.type)) ? vmEvidenceId : `${this.swarmId}:${agent.id}:${round}:native:0`;
              const claim = { id: randomUUID(), kind: "report", to: action.to, message: action.message, proposedEvidence: action.evidence, queuedAgainst: binding, createdRound: round, status: "needs-observation-review" };
              if (agent.pendingClaims.length >= 16) {
                observations.get(agent.id).repairs.push({ dropped: "send", reason: "pending-claim-capacity", detail: "Review existing pending claims before proposing more reports" });
                continue;
              }
              agent.pendingClaims.push(claim);
              observations.get(agent.id).repairs.push({ dropped: "send", reason: "awaiting-observation", pendingClaimId: claim.id, queuedAgainst: binding, detail: "Report retained for review after observing the result; requests and hypotheses can be sent alongside work" });
              observations.get(agent.id).errors.push("send deferred: inspect this round's VM/native/artifact evidence before reporting it to peers");
            }
            else {
              try {
                const { evidence } = this.resolveClaims(action, agent.id, item.inbox);
                if (action.kind === "report" && !evidence.length) {
                  const detail = "A report requires at least one prior observed evidence ID. Cite the actual observation; use kind request for a work request or kind hypothesis for an explicitly unverified possibility.";
                  observations.get(agent.id).repairs.push({ dropped: "send", reason: "missing-report-evidence", detail });
                  observations.get(agent.id).errors.push(`send rejected: ${detail}`);
                  continue;
                }
                if (action.revises && !agent.pendingClaims.some((claim) => claim.id === action.revises)) throw new Error(`Unknown pending claim ${action.revises}`);
                const envelope = this.mailbox.send({ from: agent.id, to: action.to, message: action.message, round, evidence, kind: action.kind });
                if (action.revises) agent.pendingClaims = agent.pendingClaims.filter((claim) => claim.id !== action.revises);
                observations.get(agent.id).messages.push({ sent: envelope });
              } catch (error) { observations.get(agent.id).errors.push(`send rejected: ${error.message}`); }
            }
          } else if (action.type === "native") {
            nativeTasks.push({ agent, action });
          } else if (action.type === "vm") {
            vmTasks.push({
              agentId: agent.id,
              command: action.command,
              inheritRootfs: agent.inheritRootfs,
            });
          } else if (action.type === "ostadix") {
            try { vmTasks.push({ ...buildOstadixTask(action, agent, { round }), inheritRootfs: agent.inheritRootfs }); }
            catch (error) { observations.get(agent.id).errors.push(`Ostadix action rejected: ${error.message}`); }
          } else if (action.type === "read_execution") {
            try {
              observations.get(agent.id).executionReads ??= [];
              observations.get(agent.id).executionReads.push(this.readExecution(action, agent.id, item.inbox));
            } catch (error) { observations.get(agent.id).errors.push(`Execution read rejected: ${error.message}`); }
          } else if (action.type === "review_artifact") {
            try {
              const { artifact, action: program } = await this.artifactStore.readOstadixArtifact(action.artifactId);
              if (artifact.producer === agent.id) throw new Error("A producer cannot supply its own independent peer review; ask or spawn another gent");
              if (!this.programArtifacts.some((entry) => entry.id === artifact.id)) throw new Error("Code artifact has no published execution in this swarm");
              vmTasks.push({ ...buildOstadixTask(program, agent, { round, reviewOf: { artifactId: artifact.id, producer: artifact.producer } }), inheritRootfs: agent.inheritRootfs });
            } catch (error) { observations.get(agent.id).errors.push(`Peer review rejected: ${error.message}`); }
          } else if (action.type === "publish") {
            try {
              if (!this.artifactStore) throw new Error("Artifact publication is not configured for this controller");
              const task = await this.artifactStore.buildCaptureTask(action, agent, { round });
              vmTasks.push({ ...task, inheritRootfs: agent.inheritRootfs });
            } catch (error) { observations.get(agent.id).errors.push(`publish rejected: ${error.message}`); }
          } else if (action.type === "inspect_source") {
            const reused = this.reusableSourceFact(agent.id, action.path);
            if (reused) {
              observations.get(agent.id).sourceFacts = [structuredClone(reused)];
              observations.get(agent.id).repairs.push({ dropped: "inspect_source", reason: "source-witness-reused", evidenceId: reused.evidenceId, detail: "No intervening VM command changed this pocket; reusing the same scoped observation, not claiming an independent check" });
            } else {
              try { vmTasks.push({ ...buildSourceTask(action, agent, { round, swarmId: this.swarmId, instanceId: this.capsuleIdentity.instanceId }), inheritRootfs: agent.inheritRootfs }); }
              catch (error) { observations.get(agent.id).repairs.push({ dropped: "inspect_source", reason: "invalid-source", detail: error.message }); }
            }
          } else if (action.type === "spawn") {
            spawnRequests.push({ parentId: agent.id, action });
          } else if (action.type === "reply") {
            if (requestedNewEvidence) {
              const binding = decision.actions.some((entry) => entry.type === "inspect_source") ? `${this.swarmId}:${agent.id}:${round}:source:0` : decision.actions.some((entry) => ["ostadix", "review_artifact"].includes(entry.type)) ? `${this.swarmId}:${agent.id}:${round}:ostadix` : decision.actions.some((entry) => ["vm", "publish"].includes(entry.type)) ? vmEvidenceId : `${this.swarmId}:${agent.id}:${round}:native:0`;
              if (agent.pendingClaims.length >= 16) { observations.get(agent.id).repairs.push({ dropped: "reply", reason: "pending-claim-capacity", detail: "Review existing pending claims before proposing another reply" }); continue; }
              const claim = { id: randomUUID(), kind: "reply", message: action.message, proposedEvidence: action.evidence, proposedAssertions: action.assertions, queuedAgainst: binding, createdRound: round, status: "needs-observation-review" };
              agent.pendingClaims.push(claim);
              observations.get(agent.id).repairs.push({ dropped: "reply", reason: "awaiting-observation", pendingClaimId: claim.id, queuedAgainst: binding, detail: "Reply retained for review after observing the requested work" });
            } else {
              try {
                const claims = this.resolveClaims(action, agent.id, item.inbox);
                observations.get(agent.id).verification = claims.verification;
                if (claims.verification.checks.some((check) => !check.passed)) {
                  observations.get(agent.id).repairs.push(this.assertionRepair(action, claims, agent.id, item.inbox));
                  continue;
                }
                if (action.revises && !agent.pendingClaims.some((claim) => claim.id === action.revises && claim.kind === "reply")) throw new Error(`Unknown pending reply ${action.revises}`);
                agent.lastReply = { agentId: agent.id, round, message: action.message, evidence: claims.evidence, verification: claims.verification, claimStatus: claims.verification.status, semanticVerification: false };
                observations.get(agent.id).reply = agent.lastReply;
                if (action.revises) agent.pendingClaims = agent.pendingClaims.filter((claim) => claim.id !== action.revises);
              } catch (error) { observations.get(agent.id).repairs.push({ dropped: "reply", reason: "invalid-reply-evidence", detail: error.message }); }
            }
          } else if (action.type === "finish") {
            if (requestedNewEvidence) {
              observations.get(agent.id).errors.push("finish deferred: inspect this round's VM/native evidence on the next turn");
            } else {
              try {
                const pendingReviews = this.pendingCodeReviews(agent.id);
                if (pendingReviews.length) {
                  const publicationFailure = pendingReviews.some((artifact) => artifact.publicationError);
                  if (!publicationFailure) this.ensureCodeReviewer(agent.id, round, observations.get(agent.id));
                  observations.get(agent.id).repairs.push({ dropped: "finish", reason: "awaiting-peer-review", artifacts: pendingReviews.map((artifact) => artifact.id), detail: publicationFailure ? "Execution succeeded but required source publication failed. Resolve the publication error before peer review; the execution has not been replayed." : "A distinct gent must rerun the explicit checks on the latest published code artifact before the producer finishes. A static check or repeated producer assertion is insufficient." });
                  continue;
                }
                if (!action.assertions?.length) {
                  observations.get(agent.id).repairs.push({ dropped: "finish", reason: "missing-predicate", detail: "Finish requires at least one explicit assertion against observed evidence; a summary is not a completion predicate" });
                  continue;
                }
                const claims = this.resolveClaims(action, agent.id, item.inbox);
                observations.get(agent.id).verification = claims.verification;
                if (claims.verification.checks.some((check) => !check.passed)) {
                  observations.get(agent.id).repairs.push(this.assertionRepair(action, claims, agent.id, item.inbox));
                  observations.get(agent.id).errors.push("finish deferred: an explicit evidence assertion failed");
                }
                else { agent.finished = true; agent.summary = action.summary; agent.verification = claims.verification; agent.completionEvidence = claims.evidence; }
              } catch (error) { observations.get(agent.id).errors.push(`finish rejected: ${error.message}`); }
            }
          }
        }
      }

      // Decisions are durable before any VM submission. A reconnect can match
      // its original receipt without asking the model to issue the work again.
      for (const item of decisions) {
        const observation = observations.get(item.agent.id);
        item.agent.lastObservation = observation;
        this.transcript.push({ round, agentId: item.agent.id, inbox: item.inbox,
          model: item.response?.model ?? this.model, modelMetrics: item.response?.metrics ?? null,
          ...decisionExcerpt(item.response?.content),
          rationale: item.decision.rationale, actions: item.decision.actions, synthetic: item.synthetic === true, observation });
      }

      if (nativeTasks.length) {
        this.pendingNative = { round, actions: nativeTasks.map(({ agent, action }) => ({ agentId: agent.id, action })) };
        await this.persist(round);
      }

      await Promise.all(nativeTasks.map(async ({ agent, action }) => {
        try {
          const result = await this.nativeBroker.call(action.operation, action.args);
          observations.get(agent.id).native.push(result);
        } catch (error) {
          observations.get(agent.id).errors.push(`native ${action.operation}: ${error.message}`);
        }
      }));
      this.pendingNative = null;
      for (const [agentId, observation] of observations) this.recordEvidence(agentId, observation);

      if (vmTasks.length > 0) {
        this.pendingDispatch = { round, tasks: structuredClone(vmTasks), spawnRequests: structuredClone(spawnRequests), phase: "prepared" };
        await this.persist(round);
        this.onProgress({ type: "vm-start", round, tasks: vmTasks.map(({ agentId, command, ostadix }) => ({ agentId,
          command: ostadix ? `Ostadix ${ostadix.reviewOf ? "peer review" : ostadix.mode}: ${ostadix.name}` : command.slice(0, 1024) })) });
        try {
          const workers = await this.vmFleet.run(vmTasks);
          await this.applyWorkers(vmTasks, workers, round, observations);
          this.pendingDispatch = null;
        } catch (error) {
          for (const task of vmTasks) {
            observations.get(task.agentId).errors.push(`VM fleet: ${error.message}`);
            this.onProgress({ type: "vm-result", round, agentId: task.agentId, exitCode: null, error: error.message.slice(0, 1024), output: "" });
          }
          if (error.uncertain === true || error.outcomeUnknown === true || error.code === "OVM_DISPATCH_UNCERTAIN") {
            this.pendingDispatch.error = error.message;
            this.pendingDispatch.phase = "outcome-unknown";
            this.blocked = { kind: "vm-outcome-unknown", round, error: error.message };
          } else this.pendingDispatch = null;
        }
      }
      if (!this.blocked) this.applySpawnRequests(spawnRequests, round, observations);
      if (this.interactive && this.agents.length === 1 && !this.blocked && !this.agents[0].pendingActions.length) {
        const observation = observations.get(this.agents[0].id);
        const idle = decisions.every((item) => !item.error && !item.decision.actions.length && !item.decision.repairs?.length);
        this.waitingForUser = Boolean(observation?.reply || idle);
      }
      const statePath = await this.persist(round);
      if (!this.pendingDispatch) await this.vmFleet.acknowledge?.();
      this.onProgress({ type: "round-complete", round, finished: this.agents.filter((agent) => agent.finished).length, totalAgents: this.agents.length, statePath });
      if (this.blocked || this.waitingForUser) break;
    }

    return this.result(await this.persist(this.round));
  }

  result(statePath) {
    return {
      protocol: SWARM_PROTOCOL,
      swarmId: this.swarmId,
      mission: this.mission,
      rounds: this.round,
      additionalRounds: this.round - this.startingRound,
      statePath,
      completed: !this.blocked && this.agents.every((agent) => agent.finished),
      completionMeaning: "All agents reported finished; mission correctness is not inferred",
      missionVerification: "not-assessed",
      blocked: this.blocked,
      waitingForUser: this.waitingForUser,
      lastReplies: this.agents.map((agent) => agent.lastReply).filter((reply) => reply && reply.round > this.startingRound),
      model: this.model,
      programArtifacts: this.programArtifacts.map((artifact) => this.codeArtifactStatus(artifact)),
      artifactReviews: this.artifactReviews,
      capsuleIdentity: this.capsuleIdentity,
      agents: this.agents.map((agent) => ({
        id: agent.id,
        role: agent.role,
        parentId: agent.parentId,
        finished: agent.finished,
        summary: agent.summary,
        rounds: agent.rounds,
        errors: agent.errors,
        rootfsPath: this.vmFleet.rootfsPath(agent.id),
        agentFinished: agent.finished,
        verification: agent.verification ?? { status: "unverified", scope: "explicit assertions only; mission correctness is not inferred", contentVerified: false, checks: [] },
      })),
      messages: this.mailbox.history,
      transcript: this.transcript,
    };
  }
}
