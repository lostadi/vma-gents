import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PocketSwarm } from "../src/pocket-swarm.mjs";
import { OllamaAgentClient } from "../src/ollama-agent.mjs";

test("pocket swarm routes messages, VM results, native observations, and spawned children", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "ovm-pocket-test-"));
  const contexts = [];
  const vmBatches = [];
  const nativeCalls = [];
  const progress = [];
  const modelClient = {
    async decide(agent, context) {
      contexts.push({ agentId: agent.id, agentMission: agent.mission, round: context.round, inbox: context.inbox });
      let actions;
      if (context.round === 1 && agent.id === "scout") {
        actions = [
          { type: "native", operation: "host.displays", args: [] },
          { type: "send", to: "builder", message: "display facts incoming" },
          { type: "spawn", id: "checker", role: "independent verifier", mission: "check the result" },
        ];
      } else if (context.round === 1 && agent.id === "builder") {
        actions = [{ type: "vm", command: "printf verified" }];
      } else {
        const assertions = agent.id === "scout" ? [{ evidenceId: "test-swarm:scout:1:native:0", kind: "native_value_equals", expected: [{ displayId: 1 }] }] : agent.id === "builder" ? [{ evidenceId: "test-swarm:builder:1:vm", kind: "exit_code", expected: 0 }] : [];
        actions = [{ type: "finish", summary: `${agent.id} completed after peer exchange`, assertions }];
      }
      return { model: "fake-local", content: JSON.stringify({ rationale: "test", actions }), metrics: {} };
    },
  };
  const vmFleet = {
    rootfsPath(agentId) { return path.join(stateDirectory, `${agentId}.rootfs.img`); },
    async run(tasks) {
      vmBatches.push(tasks);
      return tasks.map((task, id) => ({ id, agent: task.agentId, output: "verified", exitCode: 0 }));
    },
  };
  const nativeBroker = {
    async describe() {
      return { operations: [{ name: "host.displays", access: "observe", evidence: "test", enabled: true }] };
    },
    async call(operation, args) {
      nativeCalls.push({ operation, args });
      return { operation, value: [{ displayId: 1 }] };
    },
  };

  try {
    const swarm = new PocketSwarm({
      mission: "coordinate and verify",
      agents: [
        { id: "scout", role: "observe" },
        { id: "builder", role: "build" },
      ],
      modelClient,
      vmFleet,
      nativeBroker,
      stateDirectory,
      swarmId: "test-swarm",
      maximumRounds: 2,
      maximumAgents: 4,
      onProgress: (event) => progress.push(event),
    });
    const result = await swarm.run();
    assert.equal(result.completed, false, "a newly spawned checker cannot finish without its own observed predicate");
    assert.deepEqual(result.agents.map(({ id }) => id), ["scout", "builder", "checker"]);
    assert.equal(result.agents.find(({ id }) => id === "checker").parentId, "scout");
    assert.deepEqual(nativeCalls, [{ operation: "host.displays", args: [] }]);
    assert.equal(vmBatches.length, 1);
    assert.equal(vmBatches[0][0].agentId, "builder");
    const builderRound2 = contexts.find((context) => context.agentId === "builder" && context.round === 2);
    assert.deepEqual(builderRound2.inbox, [], "same-turn native claims wait until the sender has observed their result");
    assert.match(result.transcript.find((turn) => turn.agentId === "scout" && turn.round === 1).observation.errors[0], /send deferred/);
    const childRound2 = contexts.find((context) => context.agentId === "checker" && context.round === 2);
    assert.match(childRound2.inbox[0].message, /Spawned for subtask/);
    assert.equal(childRound2.agentMission, "check the result");
    const persisted = JSON.parse(await readFile(result.statePath, "utf8"));
    assert.equal(persisted.protocol, "ovm.agent-pocket/v1");
    assert.equal(persisted.agents.length, 3);
    assert.deepEqual(progress[0], { type: "round-start", round: 1, maximumRounds: 2, agentIds: ["scout", "builder"] });
    assert.deepEqual(progress.find((event) => event.type === "agent-result" && event.agentId === "builder"), {
      type: "agent-result", round: 1, agentId: "builder", actions: ["vm"], error: null,
    });
    assert.deepEqual(progress.find((event) => event.type === "vm-start"), {
      type: "vm-start", round: 1, tasks: [{ agentId: "builder", command: "printf verified" }],
    });
    assert.deepEqual(progress.find((event) => event.type === "vm-result"), {
      type: "vm-result", round: 1, agentId: "builder", output: "verified", exitCode: 0, error: null,
    });
    assert.deepEqual(progress.at(-1), { type: "round-complete", round: 2, finished: 2, totalAgents: 3, statePath: result.statePath });
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("Ollama receives bounded private action/result history and each agent's assigned mission", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "ovm-pocket-history-test-"));
  const requests = [];
  const longText = "x".repeat(5000);
  const modelClient = new OllamaAgentClient({
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      const context = JSON.parse(request.messages[1].content);
      requests.push(context);
      const { id } = context.identity;
      const actions = context.round === 6
        ? [{ type: "finish", summary: `Observed ${id} work`, assertions: [{ evidenceId: `history:${id}:5:vm`, kind: "exit_code", expected: 0 }] }]
        : [
          { type: "vm", command: `printf 'command-${id}-${context.round}'; # ${longText} command-end-${id}` },
          { type: "native", operation: "host.test", args: [id, context.round] },
        ];
      return new Response(JSON.stringify({ message: { content: JSON.stringify({ actions }) } }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    },
  });
  const vmFleet = {
    rootfsPath(agentId) { return path.join(stateDirectory, `${agentId}.img`); },
    async run(tasks) {
      return tasks.map((task) => ({
        agent: task.agentId, exitCode: 0,
        output: `output-${task.agentId} ${longText} output-end-${task.agentId}`,
      }));
    },
  };
  const nativeBroker = {
    async describe() { return { operations: [{ name: "host.test", enabled: true }] }; },
    async call(operation, [id, round]) {
      return { operation, value: { owner: `native-${id}`, round, details: longText } };
    },
  };
  try {
    const result = await new PocketSwarm({
      mission: "shared mission", agents: [
        { id: "builder", role: "build", mission: "implement the parser" },
        { id: "checker", role: "check", mission: "independently verify the parser" },
      ],
      modelClient, vmFleet, nativeBroker, stateDirectory, swarmId: "history", maximumRounds: 6, maximumAgents: 2,
    }).run();
    assert.equal(result.completed, true);
    for (const id of ["builder", "checker"]) {
      const first = requests.find((request) => request.identity.id === id && request.round === 1);
      assert.deepEqual(first.recentHistory, []);
      const second = requests.find((request) => request.identity.id === id && request.round === 2);
      assert.equal(second.recentHistory.length + (second.contextOmissions.omitted.recentHistory ?? 0), 1);
      assert.equal(second.previousObservation.round, 1);
      assert.equal(second.previousObservation.vm.exitCode, 0);
      assert.match(second.previousObservation.vm.output, new RegExp(`output-${id}`));
      assert.ok(second.previousObservation.evidence.some(record => record.id === `history:${id}:1:vm` && record.producer === id));
      const last = requests.find((request) => request.identity.id === id && request.round === 6);
      assert.equal(last.mission, "shared mission");
      assert.equal(last.maximumAgents, 2);
      assert.equal(last.agentMission, id === "builder" ? "implement the parser" : "independently verify the parser");
      assert.equal(last.recentHistory.length + (last.contextOmissions.omitted.recentHistory ?? 0), 4,
        "Removed private history must be explicitly counted, not presented as the complete history");
      assert.ok(last.recentHistory.every(turn => [2, 3, 4, 5].includes(turn.round)));
      for (const turn of last.recentHistory) {
        if (turn.actions[0].command) {
          assert.ok(turn.actions[0].command.length <= 1024);
          assert.match(turn.actions[0].command, new RegExp(`command-${id}-${turn.round}`));
          assert.match(turn.actions[0].command, /\[truncated\]/);
        } else assert.equal(turn.actions[0].detailsOmitted, true);
        assert.ok(turn.observation.vm.output.length <= 2048);
        assert.match(turn.observation.vm.output, new RegExp(`output-end-${id}$`));
        assert.ok(turn.observation.native[0].valueExcerpt.length <= 2048);
      }
      assert.equal(last.previousObservation.round, 5);
      assert.equal(last.previousObservation.vm.exitCode, 0);
      assert.ok(last.previousObservation.evidence.some(record => record.id === `history:${id}:5:vm`
        && record.producer === id && record.allowedAssertions.includes("exit_code")));
      assert.match(last.previousObservation.vm.output, new RegExp(`^output-${id} .*\\[truncated\\].*output-end-${id}$`, "s"));
      for (const request of [second, last]) {
        assert.ok(JSON.stringify(request).length <= 8000);
        assert.match(request.contextOmissions.detail, /not complete history/);
        assert.ok(request.previousObservation.vm.output.length <= 2048);
        assert.ok(request.previousObservation.native[0].valueExcerpt.length <= 2048);
        const other = id === "builder" ? "checker" : "builder";
        assert.doesNotMatch(JSON.stringify(request), new RegExp(`(?:command|output|native)-${other}`), "The bounded projection must retain the private evidence boundary");
      }
    }
    const persisted = JSON.parse(await readFile(result.statePath, "utf8"));
    assert.equal(persisted.transcript.length, 12);
    assert.ok(persisted.transcript[0].actions[0].command.length > 1024);
    assert.ok(persisted.transcript[0].observation.vm.output.length > 2048);
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("progress identifies model and VM failures without manufacturing completion", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "ovm-pocket-progress-test-"));
  const progress = [];
  const modelClient = {
    async decide(agent) {
      if (agent.id === "bad-model") throw new Error("model unavailable");
      return { content: JSON.stringify({ actions: [{ type: "vm", command: "false" }] }) };
    },
  };
  const vmFleet = {
    rootfsPath(agentId) { return path.join(stateDirectory, `${agentId}.img`); },
    async run() { throw new Error("fleet unavailable"); },
  };
  try {
    const result = await new PocketSwarm({
      mission: "check errors", agents: [{ id: "bad-model", role: "test" }, { id: "bad-vm", role: "test" }],
      modelClient, vmFleet, nativeBroker: { async describe() { return { operations: [] }; } },
      stateDirectory, swarmId: "progress-errors", maximumRounds: 1, onProgress: (event) => progress.push(event),
    }).run();
    assert.equal(result.completed, false);
    assert.deepEqual(progress.find((event) => event.type === "agent-result" && event.agentId === "bad-model"), {
      type: "agent-result", round: 1, agentId: "bad-model", actions: [], error: "model unavailable",
    });
    assert.deepEqual(progress.find((event) => event.type === "vm-result"), {
      type: "vm-result", round: 1, agentId: "bad-vm", output: "", exitCode: null, error: "fleet unavailable",
    });
    assert.match(result.transcript.find(({ agentId }) => agentId === "bad-vm").observation.errors[0], /fleet unavailable/);
    assert.equal(progress.at(-1).type, "round-complete");
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("a pocket cannot finish before seeing evidence requested in the same turn", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "ovm-pocket-causal-test-"));
  const modelClient = {
    async decide(_agent, context) {
      const actions = context.round === 1
        ? [{ type: "vm", command: "true" }, { type: "finish", summary: "unseen success" }]
        : [{ type: "finish", summary: "observed success", assertions: [{ evidenceId: "causal:agent:1:vm", kind: "exit_code", expected: 0 }] }];
      return { model: "fake-local", content: JSON.stringify({ actions }), metrics: {} };
    },
  };
  const vmFleet = {
    rootfsPath(agentId) { return path.join(stateDirectory, `${agentId}.img`); },
    async run(tasks) { return tasks.map((task, id) => ({ id, agent: task.agentId, output: "", exitCode: 0 })); },
  };
  const nativeBroker = { async describe() { return { operations: [] }; } };
  try {
    const result = await new PocketSwarm({
      mission: "prove before finishing",
      agents: [{ id: "agent", role: "verify" }],
      modelClient,
      vmFleet,
      nativeBroker,
      stateDirectory,
      swarmId: "causal",
      maximumRounds: 4,
      maximumAgents: 1,
    }).run();
    assert.equal(result.completed, true);
    assert.equal(result.rounds, 2);
    assert.equal(result.agents[0].rounds, 2);
    assert.equal(result.agents[0].summary, "observed success");
    assert.match(result.transcript[0].observation.errors[0], /finish deferred/);
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});
