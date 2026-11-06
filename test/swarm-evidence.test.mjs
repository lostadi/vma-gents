import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PocketSwarm } from "../src/pocket-swarm.mjs";
import { parseAgentDecision } from "../src/swarm-protocol.mjs";

async function fixture(t) {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "ovm-evidence-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  return { stateDirectory, mission: "inspect actual output", swarmId: "evidence", maximumRounds: 3, maximumAgents: 3, agents: [{ id: "builder", role: "build" }], nativeBroker: { async describe() { return { operations: [] }; } }, vmFleet: { rootfsPath(id) { return path.join(stateDirectory, `${id}.rootfs.img`); }, async run(tasks) { return tasks.map((task) => ({ agent: task.agentId, output: "MISSING", exitCode: 0, stopped: true })); } } };
}
const answer = (actions) => ({ content: JSON.stringify({ actions }) });

test("a same-turn success message is withheld until results are observed, then evidence retains its producer", async (t) => {
  const f = await fixture(t);
  const inboxes = [];
  const result = await new PocketSwarm({ ...f, agents: [{ id: "builder", role: "build" }, { id: "auditor", role: "verify" }], modelClient: { async decide(agent, context) {
    if (agent.id === "builder") {
      if (context.round === 1) return answer([{ type: "vm", command: "cat file || echo MISSING" }, { type: "send", to: "auditor", message: "Verified file exists" }]);
      return answer([{ type: "send", to: "auditor", message: "Observed MISSING; do not treat exit zero as file existence", evidence: ["evidence:builder:1:vm"] }, { type: "finish", summary: "reported observation" }]);
    }
    inboxes.push({ round: context.round, inbox: context.inbox, evidence: context.availableEvidence });
    return answer(context.round === 3 ? [{ type: "finish", summary: "received source observation" }] : []);
  } } }).run();
  assert.equal(inboxes[1].inbox.length, 0);
  assert.equal(inboxes[2].inbox.length, 1);
  const received = inboxes[2].inbox[0];
  assert.equal(received.claimStatus, "reported");
  assert.equal(received.evidence[0].producer, "builder");
  assert.equal(received.evidence[0].semanticVerification, false);
  assert.equal(inboxes[2].evidence[0].id, "evidence:builder:1:vm");
  assert.match(result.transcript[0].observation.errors[0], /send deferred/);
  assert.equal(result.agents[0].verification.status, "unverified");
});

test("MISSING with exit zero cannot satisfy an explicit content assertion or finish the agent", async (t) => {
  const f = await fixture(t);
  const result = await new PocketSwarm({ ...f, maximumRounds: 2, modelClient: { async decide(_agent, context) {
    return answer(context.round === 1 ? [{ type: "vm", command: "test -f file && cat file || echo MISSING" }] : [{ type: "finish", summary: "file verified", evidence: ["evidence:builder:1:vm"], assertions: [{ evidenceId: "evidence:builder:1:vm", kind: "stdout_equals", expected: "EXPECTED-FILE-CONTENT" }] }]);
  } } }).run();
  assert.equal(result.completed, false);
  assert.equal(result.agents[0].agentFinished, false);
  assert.match(result.transcript[1].observation.errors[0], /assertion failed/);
});

test("exit-code checks are explicitly command-only and never a blanket mission verification", async (t) => {
  const f = await fixture(t);
  const result = await new PocketSwarm({ ...f, modelClient: { async decide(_agent, context) {
    return answer(context.round === 1 ? [{ type: "vm", command: "echo MISSING" }] : [{ type: "finish", summary: "command completed", assertions: [{ evidenceId: "evidence:builder:1:vm", kind: "exit_code", expected: 0 }] }]);
  } } }).run();
  assert.equal(result.completed, true);
  assert.equal(result.agents[0].verification.status, "checks-passed");
  assert.equal(result.agents[0].verification.contentVerified, false);
  assert.match(result.agents[0].verification.scope, /mission correctness is not inferred/);
  assert.equal(result.verified, undefined);
});

test("repairing a quoted exit-code expectation cannot turn a failed command into success", async (t) => {
  const f = await fixture(t);
  const result = await new PocketSwarm({ ...f, maximumRounds: 2,
    vmFleet: { ...f.vmFleet, async run(tasks) { return tasks.map(task => ({ agent: task.agentId, output: "MISSING", exitCode: 1, stopped: true })); } },
    modelClient: { async decide(_agent, context) {
      return answer(context.round === 1 ? [{ type: "vm", command: "test -f missing" }] : [{ type: "finish", summary: "claimed success",
        assertions: [{ evidenceId: "evidence:builder:1:vm", kind: "exit_code", expected: "0" }] }]);
    } },
  }).run();
  assert.equal(result.completed, false);
  const observation = result.transcript[1].observation;
  assert.ok(observation.repairs.some(repair => repair.reason === "exit-code-type" && repair.to === 0));
  assert.equal(observation.verification.checks[0].passed, false);
});

test("a native application association is not accepted as VM file-content evidence", async (t) => {
  const f = await fixture(t);
  const result = await new PocketSwarm({ ...f, maximumRounds: 2,
    nativeBroker: { async describe() { return { operations: [{ name: "host.appForFile", enabled: true }] }; }, async call() { return { operation: "host.appForFile", value: "Console" }; } },
    modelClient: { async decide(_agent, context) {
      return answer(context.round === 1 ? [{ type: "native", operation: "host.appForFile", args: ["some.log"] }] : [{ type: "finish", summary: "read contents", assertions: [{ evidenceId: "evidence:builder:1:native:0", kind: "stdout_contains", expected: "Console" }] }]);
    } },
  }).run();
  assert.equal(result.completed, false);
  assert.equal(result.transcript[0].observation.evidence[0].operation, "host.appForFile");
});

test("unknown or private unseen evidence cannot be cited into a peer claim", async (t) => {
  const f = await fixture(t);
  const result = await new PocketSwarm({ ...f, maximumRounds: 1, agents: [{ id: "builder", role: "build" }, { id: "auditor", role: "audit" }], modelClient: { async decide(agent) {
    return answer(agent.id === "builder" ? [{ type: "send", to: "auditor", message: "trust this", evidence: ["invented:receipt"] }] : []);
  } } }).run();
  assert.equal(result.messages.length, 0);
  assert.match(result.transcript[0].observation.errors[0], /has not been observed/);
});

test("reports without citations are blocked while explicit requests and hypotheses remain deliverable", async (t) => {
  const f = await fixture(t);
  const observedInboxes = [];
  const result = await new PocketSwarm({ ...f, maximumRounds: 2, agents: [{ id: "builder", role: "build" }, { id: "auditor", role: "audit" }], modelClient: { async decide(agent, context) {
    if (agent.id === "auditor") { observedInboxes.push(context.inbox); return answer([]); }
    if (context.round === 1) return answer([
      { type: "send", to: "auditor", message: "The file exists and is verified" },
      { type: "send", kind: "request", to: "auditor", message: "Please inspect the file when available" },
      { type: "send", kind: "hypothesis", to: "auditor", message: "The file might be empty" },
    ]);
    assert.equal(context.repairs[0].reason, "missing-report-evidence");
    assert.match(context.repairs[0].detail, /prior observed evidence ID/);
    return answer([]);
  } } }).run();
  assert.equal(result.messages.length, 2);
  assert.deepEqual(observedInboxes[1].map(({ kind, claimStatus }) => [kind, claimStatus]), [["request", "unverified-intent"], ["hypothesis", "unverified-intent"]]);
  assert.ok(result.messages.every(({ message }) => !message.includes("is verified")));
  assert.match(result.transcript[0].observation.errors[0], /report requires at least one/);
});

test("publication runs through durable fleet tasks and capture bytes are replaced by immutable artifact receipts", async (t) => {
  const f = await fixture(t);
  const receipt = { id: `sha256:${"a".repeat(64)}`, sha256: "a".repeat(64), producer: "builder", guestPath: `/ovm/artifacts/sha256-${"a".repeat(64)}`, bytes: 4, claimStatus: "captured-bytes", semanticVerification: false };
  const published = [];
  const artifactStore = {
    async list() { return published; },
    buildCaptureTask(action, agent, { round }) { return { agentId: agent.id, command: "capture actual bytes", artifactPublication: { ...action, producer: agent.id, round, token: "capture-token" } }; },
    async acceptCapture(task, worker) { assert.equal(task.artifactPublication.path, "/root/file"); assert.equal(worker.output, "RAW_BASE64_CAPTURE_BYTES"); published.push(receipt); return receipt; },
  };
  const result = await new PocketSwarm({ ...f, artifactStore, vmFleet: { ...f.vmFleet, async run(tasks) {
    const saved = JSON.parse(await readFile(path.join(f.stateDirectory, "swarm.json"), "utf8"));
    assert.equal(saved.pendingDispatch.tasks[0].artifactPublication.token, "capture-token");
    return tasks.map(({ agentId }) => ({ agent: agentId, output: "RAW_BASE64_CAPTURE_BYTES", exitCode: 0, stopped: true }));
  } }, modelClient: { async decide(_agent, context) {
    if (context.round === 1) return answer([{ type: "publish", path: "/root/file", name: "test file" }, { type: "send", to: "all", message: "uploaded!" }]);
    assert.deepEqual(context.availableArtifacts, [receipt]);
    return answer([{ type: "finish", summary: "captured exact artifact bytes", assertions: [{ evidenceId: "evidence:builder:1:artifact:0", kind: "artifact_sha256", expected: receipt.sha256 }] }]);
  } } }).run();
  assert.equal(result.completed, true);
  assert.equal(result.transcript[0].observation.artifacts[0].sha256, receipt.sha256);
  assert.doesNotMatch(JSON.stringify(result), /RAW_BASE64_CAPTURE_BYTES/);
  assert.equal(result.messages.length, 0);
  const projected = parseAgentDecision(JSON.stringify({ actions: [{ type: "publish", path: "/x", name: "x" }, { type: "vm", command: "write x" }] }));
  assert.equal(projected.actions[0].type, "vm");
  assert.equal(projected.queuedActions[0].action.type, "publish");
});

test("uncertain artifact capture recovers from the original saved task and never re-executes capture", async (t) => {
  const f = await fixture(t);
  const receipt = { id: `sha256:${"b".repeat(64)}`, sha256: "b".repeat(64), producer: "builder", bytes: 3 };
  let accepts = 0;
  const artifactStore = {
    async list() { return accepts ? [receipt] : []; },
    buildCaptureTask(action, agent, { round }) { return { agentId: agent.id, command: "original random capture token", artifactPublication: { ...action, producer: agent.id, round, token: "original-token" } }; },
    async acceptCapture(task) { assert.equal(task.artifactPublication.token, "original-token"); accepts++; return receipt; },
  };
  await new PocketSwarm({ ...f, artifactStore, vmFleet: { ...f.vmFleet, async run() { const error = new Error("accepted then disconnected"); error.uncertain = true; throw error; } }, modelClient: { async decide() { return answer([{ type: "publish", path: "/root/file", name: "deliverable" }]); } } }).run();
  const saved = JSON.parse(await readFile(path.join(f.stateDirectory, "swarm.json"), "utf8"));
  const result = await new PocketSwarm({ ...f, artifactStore, resumeState: saved, vmFleet: { ...f.vmFleet,
    async recover() { return { dispatchId: "dispatch-capture", tasks: saved.pendingDispatch.tasks.map(({ agentId, command }) => ({ agentId, command })), workers: [{ agent: "builder", exitCode: 0, stopped: true, output: "raw capture", placement: { dispatchId: "dispatch-capture" } }] }; },
    async run() { assert.fail("capture must not execute twice"); }, async acknowledge() {},
  }, modelClient: { async decide(agent) { assert.equal(agent.lastObservation.artifacts[0].sha256, receipt.sha256); return answer([{ type: "finish", summary: "recovered artifact receipt", assertions: [{ evidenceId: "evidence:builder:1:artifact:0", kind: "artifact_sha256", expected: receipt.sha256 }] }]); } } }).run();
  assert.equal(result.completed, true); assert.equal(accepts, 1);
  const committed = JSON.parse(await readFile(path.join(f.stateDirectory, "swarm.json"), "utf8"));
  let acknowledged = false;
  const repeated = await new PocketSwarm({ ...f, artifactStore: { ...artifactStore, async acceptCapture() { assert.fail("already committed artifact must not be published twice"); } }, resumeState: committed, vmFleet: { ...f.vmFleet,
    async recover() { return { dispatchId: "dispatch-capture", tasks: saved.pendingDispatch.tasks.map(({ agentId, command }) => ({ agentId, command })), workers: [{ agent: "builder", exitCode: 0, stopped: true, output: "raw capture", placement: { dispatchId: "dispatch-capture" } }] }; },
    async acknowledge(id) { assert.equal(id, "dispatch-capture"); acknowledged = true; },
  }, modelClient: { async decide() { assert.fail("completed agent must not restart reasoning"); } } }).run();
  assert.equal(repeated.completed, true); assert.equal(acknowledged, true); assert.equal(repeated.additionalRounds, 0);
});

test("a failed artifact capture is an observed diagnostic, not a published handoff or a replay ambiguity", async (t) => {
  const f = await fixture(t);
  const result = await new PocketSwarm({ ...f, maximumRounds: 1, artifactStore: {
    async list() { return []; }, buildCaptureTask(action, agent) { return { agentId: agent.id, command: "capture missing file", artifactPublication: action }; },
    async acceptCapture() { throw new Error("source file is missing"); },
  }, modelClient: { async decide() { return answer([{ type: "publish", path: "/missing", name: "missing" }]); } } }).run();
  assert.equal(result.blocked, null);
  assert.equal(result.transcript[0].observation.artifacts, undefined);
  assert.match(result.transcript[0].observation.errors[0], /source file is missing/);
  assert.equal(JSON.parse(await readFile(result.statePath, "utf8")).pendingDispatch, null);
});
