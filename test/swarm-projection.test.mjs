import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PocketSwarm } from "../src/pocket-swarm.mjs";
import { parseAgentDecision } from "../src/swarm-protocol.mjs";

const answer = (actions, rationale = "") => ({ model: "scripted", content: JSON.stringify({ rationale, actions }) });
const check = (evidenceId, kind = "exit_code", expected = 0) => ({ evidenceId, kind, expected });

async function fixture(t) {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "ovm-projection-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const batches = [], published = [];
  const artifact = { id: `sha256:${"c".repeat(64)}`, sha256: "c".repeat(64), producer: "builder", bytes: 7, guestPath: `/ovm/artifacts/sha256-${"c".repeat(64)}` };
  const artifactStore = {
    async list() { return published; },
    buildCaptureTask(action, agent, { round }) { return { agentId: agent.id, command: "controller capture", artifactPublication: { ...action, producer: agent.id, round, token: "capture" } }; },
    async acceptCapture() { published.push(artifact); return artifact; },
  };
  const vmFleet = {
    rootfsPath(id) { return path.join(stateDirectory, `${id}.rootfs.img`); },
    async run(tasks) { batches.push(structuredClone(tasks)); return tasks.map((task) => ({ agent: task.agentId, output: "observed", exitCode: 0, stopped: true })); },
  };
  const base = { stateDirectory, swarmId: "projection", mission: "make and hand off exact bytes", maximumRounds: 3, maximumAgents: 2, agents: [{ id: "builder", role: "build" }], nativeBroker: { async describe() { return { operations: [] }; } }, artifactStore, vmFleet };
  return { base, batches, artifact, published, async saved() { return JSON.parse(await readFile(path.join(stateDirectory, "swarm.json"), "utf8")); } };
}

test("valid VM work survives invalid siblings and extra commands; publication queues durably against exact evidence", async (t) => {
  const f = await fixture(t);
  const command = "printf 'file bytes'\nprintf 'reason remains literal command text'";
  const raw = answer([{ type: "native", operation: "host.unavailable", args: [] }, { type: "publish", path: "/root/file", name: "file" }, { type: "vm", command }, { type: "vm", command: "must never execute" }]);
  await new PocketSwarm({ ...f.base, maximumRounds: 1, modelClient: { async decide() { return raw; } } }).run();
  const saved = await f.saved();
  assert.equal(f.batches.length, 1);
  assert.equal(f.batches[0][0].command, command);
  assert.equal(saved.agents[0].pendingActions[0].queuedAgainst, "projection:builder:1:vm");
  assert.equal(saved.transcript[0].rawDecision, raw.content);
  assert.equal(saved.transcript[0].rawDecisionTruncated, false);
  assert.deepEqual(saved.transcript[0].observation.repairs.map(({ dropped, reason }) => [dropped, reason]), [["native", "invalid-action"], ["publish", "cardinality"], ["vm", "cardinality"]]);
  let calls = 0;
  const result = await new PocketSwarm({ ...f.base, resumeState: saved, maximumRounds: 2, modelClient: { async decide(_agent, context) {
    calls++;
    assert.equal(context.round, 3, "round two executes the saved publication without re-asking the model");
    assert.equal(context.availableArtifacts[0].sha256, f.artifact.sha256);
    return answer([{ type: "finish", summary: "published bytes observed", assertions: [check("projection:builder:2:artifact:0", "artifact_sha256", f.artifact.sha256)] }]);
  } } }).run();
  assert.equal(calls, 1);
  assert.equal(result.completed, true);
  assert.equal(f.batches.length, 2);
  assert.equal(f.batches[1][0].artifactPublication.path, "/root/file");
  assert.equal(result.transcript[1].synthetic, true);
  assert.deepEqual((await f.saved()).agents[0].pendingActions, []);
});

test("failed producer VM cancels queued publication and gives the next model a structured repair", async (t) => {
  const f = await fixture(t);
  let runs = 0;
  const result = await new PocketSwarm({ ...f.base, maximumRounds: 2, vmFleet: { ...f.base.vmFleet, async run(tasks) { runs++; return tasks.map(({ agentId }) => ({ agent: agentId, exitCode: 1, stopped: true, output: "creation failed" })); } }, modelClient: { async decide(_agent, context) {
    if (context.round === 1) return answer([{ type: "vm", command: "fail before creating file" }, { type: "publish", path: "/root/file", name: "file" }]);
    assert.ok(context.repairs.some((repair) => repair.reason === "failed-prerequisite" && repair.queuedAgainst === "projection:builder:1:vm"));
    return answer([{ type: "finish", summary: "just claiming done" }]);
  } } }).run();
  assert.equal(runs, 1);
  assert.equal(result.completed, false);
  assert.deepEqual(f.published, []);
  assert.equal(result.transcript[1].observation.repairs.at(-1).reason, "missing-predicate");
});

test("requests and hypotheses accompany work while reports remain pending until explicitly reviewed", async (t) => {
  const f = await fixture(t);
  const inboxes = [];
  const result = await new PocketSwarm({ ...f.base, agents: [{ id: "builder", role: "build" }, { id: "auditor", role: "audit" }], modelClient: { async decide(agent, context) {
    if (agent.id === "builder") {
      if (context.round === 1) return answer([{ type: "vm", command: "build" }, { type: "send", kind: "request", to: "auditor", message: "Please check once the bytes are available" }, { type: "send", kind: "hypothesis", to: "auditor", message: "The ordering may be ascending" }, { type: "send", to: "auditor", message: "The build succeeded" }]);
      assert.equal(context.pendingClaims.length, 1);
      assert.equal(context.pendingClaims[0].message, "The build succeeded");
      assert.equal(context.pendingClaims[0].queuedAgainst, "projection:builder:1:vm");
      return answer([{ type: "send", to: "auditor", revises: context.pendingClaims[0].id, message: "The command returned observed; semantic correctness is still open", evidence: ["projection:builder:1:vm"] }, { type: "finish", summary: "command returned", assertions: [check("projection:builder:1:vm")] }]);
    }
    inboxes.push({ round: context.round, inbox: context.inbox });
    return answer(context.round === 3 ? [{ type: "finish", summary: "received producer evidence", assertions: [check("projection:builder:1:vm", "stdout_equals", "observed")] }] : []);
  } } }).run();
  assert.equal(result.completed, true);
  assert.equal(result.messages.length, 3);
  assert.deepEqual(inboxes[1].inbox.map(({ kind, claimStatus }) => [kind, claimStatus]), [["request", "unverified-intent"], ["hypothesis", "unverified-intent"]]);
  assert.equal(inboxes[2].inbox[0].evidence[0].producer, "builder");
  assert.equal(inboxes[2].inbox[0].claimStatus, "reported");
  assert.deepEqual((await f.saved()).agents[0].pendingClaims, []);
});

function sourceWorker(task, kind = "source_absent") {
  const source = task.sourceInspection;
  return { agent: task.agentId, stopped: true, exitCode: 0, output: source.token + JSON.stringify({ schema: "ovm.source-capture/v1", path: source.path, kind, ...(kind === "source_present" ? { bytes: 7, sha256: "d".repeat(64) } : {}) }) };
}

test("an explicitly bound source is inspected before the agent reasons and absence remains scoped to its VM", async (t) => {
  const f = await fixture(t);
  let modelCalls = 0, runs = 0;
  const result = await new PocketSwarm({ ...f.base, context: { sourceBinding: { scope: "guest", path: "/root/original-history" } }, vmFleet: { ...f.base.vmFleet, async run(tasks) { runs++; assert.equal(tasks[0].sourceInspection.path, "/root/original-history"); return tasks.map((task) => sourceWorker(task)); } }, modelClient: { async decide(_agent, context) {
    modelCalls++; assert.equal(context.round, 2);
    const fact = context.sourceFacts[0];
    assert.equal(fact.kind, "source_absent"); assert.equal(fact.producer, "builder"); assert.equal(fact.environment.pocket, "builder");
    assert.equal(fact.environment.swarmId, "projection"); assert.match(fact.environment.instanceId, /^[a-f0-9-]{36}$/);
    assert.equal(fact.path, "/root/original-history"); assert.equal(fact.semanticVerification, false);
    assert.match(fact.meaning, /does not establish.*another machine/);
    return answer([{ type: "finish", summary: "selected source is absent in this pocket at round one", assertions: [check(fact.evidenceId, "source_kind", "source_absent")] }]);
  } } }).run();
  assert.equal(modelCalls, 1); assert.equal(runs, 1); assert.equal(result.completed, true);
  assert.equal(result.transcript[0].synthetic, true);
  assert.equal((await f.saved()).sourceFacts[0].kind, "source_absent");
});

test("source reinspection reuses the same scoped witness until a later VM command can change that pocket", async (t) => {
  const f = await fixture(t);
  let inspections = 0;
  const result = await new PocketSwarm({ ...f.base, maximumRounds: 5, context: { sourceBinding: { scope: "guest", path: "/root/original" } }, vmFleet: { ...f.base.vmFleet, async run(tasks) { return tasks.map((task) => { if (task.sourceInspection) return sourceWorker(task, ++inspections === 1 ? "source_absent" : "source_present"); return { agent: task.agentId, output: "created", stopped: true, exitCode: 0 }; }); } }, modelClient: { async decide(_agent, context) {
    if (context.round === 2 || context.round === 4) return answer([{ type: "inspect_source", path: "/root/original" }]);
    if (context.round === 3) { assert.equal(context.repairs[0].reason, "source-witness-reused"); return answer([{ type: "vm", command: "create original" }]); }
    assert.equal(context.sourceFacts.length, 1); assert.equal(context.sourceFacts[0].round, 4);
    return answer([{ type: "finish", summary: "new source witness exists", assertions: [check("projection:builder:4:source:0", "source_kind", "source_present")] }]);
  } } }).run();
  assert.equal(inspections, 2); assert.equal(result.completed, true);
  assert.equal(result.transcript[1].observation.vm, null);
  assert.equal(result.transcript[1].observation.evidence[0].id, "projection:builder:1:source:0");
});

test("arbitrary MISSING stdout cannot manufacture a structured source-absence fact; raw accepted decisions are bounded", async (t) => {
  const f = await fixture(t);
  const response = answer([{ type: "vm", command: "printf MISSING\nreason: deliberately retained command bytes" }], "x".repeat(18000));
  const result = await new PocketSwarm({ ...f.base, maximumRounds: 1, modelClient: { async decide() { return response; } } }).run();
  assert.deepEqual((await f.saved()).sourceFacts, []);
  assert.equal(f.batches[0][0].command, "printf MISSING\nreason: deliberately retained command bytes");
  assert.equal(result.transcript[0].rawDecision.length, 16384);
  assert.equal(result.transcript[0].rawDecisionTruncated, true);
});

test("interactive replies yield to the user without finishing the agent or weakening task predicates", async (t) => {
  const f = await fixture(t);
  const task = parseAgentDecision(answer([{ type: "reply", message: "Hello" }, { type: "finish", summary: "Hello" }]).content);
  assert.equal(task.actions.length, 1); assert.equal(task.actions[0].type, "finish");
  assert.match(task.repairs[0].detail, /interactive chat/);
  let calls = 0;
  const first = await new PocketSwarm({ ...f.base, interactive: true, modelClient: { async decide(_agent, context) { calls++; assert.equal(context.interaction, "chat"); return answer([{ type: "reply", message: "What would you like to explore?" }]); } } }).run();
  assert.equal(calls, 1); assert.equal(first.completed, false); assert.equal(first.waitingForUser, true);
  assert.equal(first.agents[0].finished, false); assert.equal(first.lastReplies[0].claimStatus, "unverified");
  const saved = await f.saved();
  const result = await new PocketSwarm({ ...f.base, resumeState: saved, interactive: true, mission: "Inspect the output", missionOverride: true, modelClient: { async decide(_agent, context) {
    if (context.round === 2) return answer([{ type: "vm", command: "printf observed" }, { type: "reply", message: "It succeeded" }]);
    assert.equal(context.pendingClaims[0].kind, "reply");
    assert.equal(context.pendingClaims[0].queuedAgainst, "projection:builder:2:vm");
    return answer([{ type: "reply", message: "The command printed observed", revises: context.pendingClaims[0].id, assertions: [check("projection:builder:2:vm", "stdout_equals", "observed")] }]);
  } } }).run();
  assert.equal(result.waitingForUser, true); assert.equal(result.completed, false); assert.equal(result.rounds, 3);
  assert.equal(result.lastReplies[0].message, "The command printed observed");
  assert.equal(result.lastReplies[0].verification.status, "checks-passed");
  assert.equal(result.transcript[1].observation.repairs[0].reason, "awaiting-observation");
  assert.deepEqual((await f.saved()).agents[0].pendingClaims, []);
});

test("one VM action followed by a grounded reply yields naturally without publication or task completion", async (t) => {
  const f = await fixture(t);
  const result = await new PocketSwarm({ ...f.base, interactive: true, modelClient: { async decide(_agent, context) {
    assert.equal(context.currentInvocationStartRound, 0);
    if (context.round === 1) return answer([{ type: "vm", command: "node -p process.version > /root/proof && cat /root/proof" }]);
    assert.equal(context.round, 2);
    assert.equal(context.availableEvidence[0].kind, "vm");
    assert.deepEqual(context.availableEvidence[0].allowedAssertions, ["stdout_contains", "stdout_equals", "exit_code"]);
    return answer([{ type: "reply", message: "The command printed observed", assertions: [check("projection:builder:1:vm", "stdout_equals", "observed")] }]);
  } } }).run();
  assert.equal(f.batches.length, 1); assert.equal(f.published.length, 0);
  assert.equal(result.waitingForUser, true); assert.equal(result.completed, false); assert.equal(result.rounds, 2);
  assert.equal(result.lastReplies[0].verification.status, "checks-passed");
});

test("chat capture-as-stdout failure identifies the exact incompatible check and permits a corrected observed reply", async (t) => {
  const f = await fixture(t);
  const result = await new PocketSwarm({ ...f.base, interactive: true, maximumRounds: 4, modelClient: { async decide(_agent, context) {
    if (context.round === 1) return answer([{ type: "vm", command: "write a proof file" }]);
    if (context.round === 2) return answer([{ type: "publish", path: "/root/proof", name: "proof" }, { type: "reply", message: "Proposed result", assertions: [check("projection:builder:1:vm", "stdout_equals", "observed")] }]);
    if (context.round === 3) {
      assert.deepEqual(context.pendingClaims[0].proposedAssertions, [check("projection:builder:1:vm", "stdout_equals", "observed")]);
      const capture = context.availableEvidence.find(({ id }) => id === "projection:builder:2:vm");
      assert.equal(capture.kind, "artifact-capture"); assert.deepEqual(capture.allowedAssertions, []);
      assert.match(capture.meaning, /not file contents/);
      return answer([{ type: "reply", message: "This claim is not delivered", assertions: [check("projection:builder:1:vm", "stdout_equals", "observed"), check("projection:builder:2:vm", "stdout_contains", "observed"), check("projection:builder:2:artifact:0", "artifact_sha256", f.artifact.sha256)] }]);
    }
    const repair = context.repairs.find(({ reason }) => reason === "invalid-evidence-assertion");
    assert.equal(repair.failedChecks.length, 1);
    assert.equal(repair.failedChecks[0].evidenceId, "projection:builder:2:vm");
    assert.equal(repair.failedChecks[0].evidenceKind, "artifact-capture");
    assert.deepEqual(repair.failedChecks[0].allowedAssertions, []);
    assert.match(repair.detail, /stdout_contains cannot check evidence kind artifact-capture/);
    assert.ok(repair.availableEvidence.some(({ evidenceId, kind }) => evidenceId === "projection:builder:1:vm" && kind === "vm"));
    return answer([{ type: "reply", revises: context.pendingClaims[0].id, message: "The original command printed observed; the artifact digest was captured", assertions: [check("projection:builder:1:vm", "stdout_equals", "observed"), check("projection:builder:2:artifact:0", "artifact_sha256", f.artifact.sha256)] }]);
  } } }).run();
  assert.equal(f.batches.length, 2, "review must not rerun the already successful command or capture");
  assert.equal(result.waitingForUser, true); assert.equal(result.rounds, 4); assert.equal(result.completed, false);
  assert.equal(result.transcript[2].observation.reply, undefined);
  assert.equal(result.transcript[2].observation.verification.status, "unverified");
  assert.equal(result.lastReplies.length, 1);
  assert.match(result.lastReplies[0].message, /original command printed/);
  assert.deepEqual((await f.saved()).agents[0].pendingClaims, []);
});

test("incorrect VM output assertions stay blocked and show the actual observed excerpt", async (t) => {
  const f = await fixture(t);
  const result = await new PocketSwarm({ ...f.base, interactive: true, maximumRounds: 2, modelClient: { async decide(_agent, context) {
    return answer(context.round === 1 ? [{ type: "vm", command: "observe actual bytes" }] : [{ type: "reply", message: "Invented success", assertions: [check("projection:builder:1:vm", "stdout_equals", "invented")] }]);
  } } }).run();
  assert.equal(result.waitingForUser, false); assert.deepEqual(result.lastReplies, []);
  const failed = result.transcript[1].observation.repairs[0].failedChecks[0];
  assert.equal(failed.observedExcerpt, "observed"); assert.equal(failed.expected, "invented"); assert.equal(failed.passed, false);
});
