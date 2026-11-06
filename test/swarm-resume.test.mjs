import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PocketSwarm } from "../src/pocket-swarm.mjs";
import { SwarmMailbox } from "../src/swarm-protocol.mjs";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ovm-swarm-resume-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const nativeBroker = { async describe() { return { operations: [] }; } };
  const fleet = { rootfsPath(id) { return path.join(directory, `${id}.rootfs.img`); }, async run(tasks) { return tasks.map(({ agentId }) => ({ agent: agentId, output: "observed", exitCode: 0, stopped: true })); } };
  const base = { mission: "keep my work", agents: [{ id: "builder", role: "build" }], model: "test-model:latest", stateDirectory: directory, swarmId: "personal-agent", maximumRounds: 1, maximumAgents: 2, nativeBroker, vmFleet: fleet };
  return { directory, base, fleet, async state() { return JSON.parse(await readFile(path.join(directory, "swarm.json"), "utf8")); } };
}
function answer(actions) { return { model: "test-model:latest", content: JSON.stringify({ actions }) }; }

test("resuming preserves history, model, identity, pending inbox, and monotonic additional rounds", async (t) => {
  const f = await fixture(t);
  const agents = [{ id: "builder", role: "build" }, { id: "auditor", role: "verify" }];
  await new PocketSwarm({ ...f.base, agents, context: { preference: "local" }, modelClient: { async decide(agent) { return answer(agent.id === "builder" ? [{ type: "send", kind: "request", to: "auditor", message: "unfinished verification" }, { type: "vm", command: "build something" }] : [{ type: "vm", command: "make something" }]); } } }).run();
  const before = await f.state();
  assert.equal(before.round, 1);
  assert.equal(before.mailbox.queues.auditor.length, 1);
  const observed = [];
  const result = await new PocketSwarm({ ...f.base, mission: undefined, agents: undefined, resumeState: before, maximumRounds: 2, modelClient: { async decide(agent, context) { observed.push({ agent, context }); return answer([{ type: "finish", summary: "finished previous work", assertions: [{ evidenceId: `personal-agent:${agent.id}:1:vm`, kind: "exit_code", expected: 0 }] }]); } } }).run();
  assert.equal(result.rounds, 2);
  assert.equal(result.additionalRounds, 1);
  assert.equal(result.completed, true);
  const saved = await f.state();
  assert.equal(saved.maximumRounds, 3);
  assert.deepEqual(saved.capsuleIdentity, before.capsuleIdentity);
  assert.deepEqual(saved.context, { preference: "local" });
  assert.equal(saved.model, "test-model:latest");
  assert.deepEqual(saved.transcript.slice(0, 2), before.transcript);
  const audit = observed.find(({ agent }) => agent.id === "auditor");
  assert.equal(audit.context.inbox[0].message, "unfinished verification");
  assert.equal(audit.context.round, 2);
  assert.equal(audit.context.currentInvocationStartRound, 1);
  assert.equal(audit.context.recentHistory[0].observation.vm.output, "observed");
  assert.equal(saved.mailbox.queues.auditor.length, 0);
});

test("completed agents stay completed until an explicit new mission reopens them without deleting memory", async (t) => {
  const f = await fixture(t);
  await new PocketSwarm({ ...f.base, maximumRounds: 2, modelClient: { async decide(_agent, context) { return answer(context.round === 1 ? [{ type: "vm", command: "old work" }] : [{ type: "finish", summary: "old result", assertions: [{ evidenceId: "personal-agent:builder:1:vm", kind: "exit_code", expected: 0 }] }]); } } }).run();
  const saved = await f.state();
  const idle = await new PocketSwarm({ ...f.base, resumeState: saved, modelClient: { async decide() { assert.fail("completed work must not repeat"); } } }).run();
  assert.equal(idle.additionalRounds, 0);
  const contexts = [];
  const changed = await new PocketSwarm({ ...f.base, resumeState: saved, mission: "a new related task", maximumRounds: 2, modelClient: { async decide(agent, context) { contexts.push({ agent, context }); return answer(context.round === 3 ? [{ type: "vm", command: "new work" }] : [{ type: "finish", summary: "new result", assertions: [{ evidenceId: "personal-agent:builder:3:vm", kind: "exit_code", expected: 0 }] }]); } } }).run();
  assert.equal(changed.completed, true);
  assert.equal(changed.rounds, 4);
  assert.equal(contexts[0].agent.mission, "a new related task");
  assert.equal(contexts[0].context.recentHistory[1].actions[0].summary, "old result");
  assert.equal((await f.state()).transcript[1].actions[0].summary, "old result");
});

test("decisions and dispatch tasks are durable before any VM submission, then acknowledged after results persist", async (t) => {
  const f = await fixture(t);
  let calls = 0, acknowledges = 0;
  const result = await new PocketSwarm({ ...f.base, vmFleet: {
    ...f.fleet,
    async run(tasks) {
      calls++;
      const saved = await f.state();
      assert.deepEqual(saved.pendingDispatch.tasks, tasks);
      assert.equal(saved.pendingDispatch.phase, "prepared");
      assert.equal(saved.transcript[0].actions[0].command, "one side effect");
      assert.equal(saved.transcript[0].observation.vm, null);
      return f.fleet.run(tasks);
    },
    async acknowledge() {
      acknowledges++;
      const saved = await f.state();
      assert.equal(saved.pendingDispatch, null);
      assert.equal(saved.transcript[0].observation.vm.exitCode, 0);
    },
  }, modelClient: { async decide() { return answer([{ type: "vm", command: "one side effect" }]); } } }).run();
  assert.equal(calls, 1); assert.equal(acknowledges, 1); assert.equal(result.blocked, null);
});

test("uncertain remote execution halts all reasoning and recovers the exact receipt before another decision", async (t) => {
  const f = await fixture(t);
  let decisions = 0, submissions = 0;
  const result = await new PocketSwarm({ ...f.base, maximumRounds: 5, vmFleet: { ...f.fleet, async run() { submissions++; const error = new Error("connection lost after acceptance"); error.uncertain = true; throw error; } }, modelClient: { async decide() { decisions++; return answer([{ type: "vm", command: "append once" }, { type: "spawn", id: "child", role: "verify", mission: "check appended file" }]); } } }).run();
  assert.equal(result.blocked.kind, "vm-outcome-unknown");
  assert.equal(result.rounds, 1); assert.equal(submissions, 1); assert.equal(decisions, 1);
  const saved = await f.state();
  assert.equal(saved.agents.length, 1, "child waits for the actual parent checkpoint");
  const order = [];
  const resumed = await new PocketSwarm({ ...f.base, resumeState: saved, maximumRounds: 3,
    nativeBroker: { async describe() { order.push("describe"); return { operations: [] }; } },
    vmFleet: { ...f.fleet,
      async recover() { order.push("recover"); return { tasks: saved.pendingDispatch.tasks, workers: [{ agent: "builder", output: "appended exactly once", exitCode: 0, stopped: true }] }; },
      async run(tasks) { assert.equal(tasks.length, 1); assert.equal(tasks[0].agentId, "child"); assert.equal(tasks[0].command, "verify inherited checkpoint"); return f.fleet.run(tasks); },
      async acknowledge() { order.push("acknowledge"); assert.equal((await f.state()).pendingDispatch, null); },
    },
    modelClient: { async decide(agent, context) {
      order.push(`decide:${agent.id}`);
      if (agent.id === "builder") { assert.equal(agent.lastObservation.vm.output, "appended exactly once"); assert.deepEqual(agent.lastObservation.errors, []); }
      else { assert.equal(agent.parentId, "builder"); if (context.round === 2) { assert.match(context.inbox[0].message, /check appended file/); return answer([{ type: "vm", command: "verify inherited checkpoint" }]); } }
      return answer([{ type: "finish", summary: "receipt confirmed", assertions: [{ evidenceId: `personal-agent:${agent.id}:${agent.id === "builder" ? 1 : 2}:vm`, kind: "exit_code", expected: 0 }] }]);
    } },
  }).run();
  assert.equal(resumed.completed, true); assert.equal(resumed.rounds, 3);
  assert.deepEqual(order.slice(0, 3), ["recover", "acknowledge", "describe"]);
  assert.equal(resumed.transcript[0].observation.vm.recovered, true);
  assert.equal(resumed.agents.length, 2);
});

test("an unmatched or missing recovery receipt blocks instead of running the model or replaying work", async (t) => {
  const f = await fixture(t);
  await new PocketSwarm({ ...f.base, vmFleet: { ...f.fleet, async run() { const error = new Error("unknown"); error.uncertain = true; throw error; } }, modelClient: { async decide() { return answer([{ type: "vm", command: "write important data" }]); } } }).run();
  const saved = await f.state();
  for (const receipt of [null, { tasks: [{ agentId: "builder", command: "different command" }], workers: [{ agent: "builder", exitCode: 0 }] }]) {
    const result = await new PocketSwarm({ ...f.base, resumeState: saved, vmFleet: { ...f.fleet, async recover() { return receipt; } }, nativeBroker: { async describe() { assert.fail("blocked recovery must precede native inspection"); } }, modelClient: { async decide() { assert.fail("unknown outcome must not be reasoned into a replay"); } } }).run();
    assert.equal(result.completed, false); assert.equal(result.rounds, 1); assert.equal(result.additionalRounds, 0); assert.equal(result.blocked.kind, "vm-outcome-unknown");
  }
});

test("known pre-admission refusal is reconciled and allows normal reasoning again", async (t) => {
  const f = await fixture(t);
  await new PocketSwarm({ ...f.base, vmFleet: { ...f.fleet, async run() { const error = new Error("unknown submission"); error.uncertain = true; throw error; } }, modelClient: { async decide() { return answer([{ type: "vm", command: "safe to try after refusal" }]); } } }).run();
  const saved = await f.state();
  const result = await new PocketSwarm({ ...f.base, resumeState: saved, vmFleet: { ...f.fleet, async recover() { const error = new Error("not admitted"); error.rejected = true; throw error; } }, modelClient: { async decide(agent) {
    assert.equal(agent.lastObservation.errors.length, 1);
    assert.match(agent.lastObservation.errors[0], /declined before execution/);
    return answer([{ type: "finish", summary: "confirmed refusal" }]);
  } } }).run();
  assert.equal(result.completed, false); assert.equal(result.blocked, null); assert.equal((await f.state()).pendingDispatch, null);
  assert.equal(result.transcript.at(-1).observation.repairs[0].reason, "missing-predicate");
});

test("legacy mailbox delivery reconstructs undelivered messages without duplicating consumed inboxes", () => {
  const old = new SwarmMailbox(["builder", "auditor"]);
  const consumed = old.send({ from: "builder", to: "auditor", message: "old request", kind: "request", round: 1 });
  old.drain("auditor");
  const pending = old.send({ from: "builder", to: "auditor", message: "new request", kind: "request", round: 2 });
  const restored = new SwarmMailbox(["builder", "auditor"], { history: old.history, transcript: [{ agentId: "auditor", inbox: [consumed] }] });
  assert.deepEqual(restored.drain("auditor").map(({ id }) => id), [pending.id]);
  const snapshot = old.snapshot();
  const current = new SwarmMailbox(["builder", "auditor"], { history: old.history, snapshot });
  assert.deepEqual(current.drain("auditor").map(({ id }) => id), [pending.id]);
  assert.throws(() => new SwarmMailbox(["builder", "auditor"], { history: old.history, snapshot: { schema: "ovm.mailbox/v1", queues: { auditor: [pending.id, pending.id] } } }), /queue/);
});

test("interrupted native actions are retained as unknown and never replayed on resume", async (t) => {
  const f = await fixture(t);
  const state = { protocol: "ovm.agent-pocket/v1", swarmId: "native-paused", mission: "native action", round: 1, agents: [{ id: "builder", role: "build", finished: false }], transcript: [], messages: [], pendingNative: { round: 1, actions: [{ agentId: "builder", action: { type: "native", operation: "host.click", args: [] } }] } };
  const result = await new PocketSwarm({ ...f.base, resumeState: state, vmFleet: { ...f.fleet, async recover() { assert.fail("native uncertainty must be handled first"); } }, modelClient: { async decide() { assert.fail("native action must not replay"); } } }).run();
  assert.equal(result.blocked.kind, "native-outcome-unknown");
  assert.equal(result.additionalRounds, 0);
});
