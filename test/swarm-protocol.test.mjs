import test from "node:test";
import assert from "node:assert/strict";
import { parseAgentDecision, SwarmMailbox } from "../src/swarm-protocol.mjs";

test("agent decisions accept typed VM, message, native, spawn, and finish actions", () => {
  const decision = parseAgentDecision(`\`\`\`json
  {
    "rationale": "split and verify",
    "actions": [
      {"type":"vm","command":"uname -a"},
      {"type":"send","to":"builder","message":"check the kernel"},
      {"type":"native","operation":"host.frontmostApp","args":[]},
      {"type":"spawn","id":"checker","role":"verify","mission":"reproduce"},
      {"type":"finish","summary":"queued all work"}
    ]
  }
  \`\`\``, {
    peerIds: ["scout", "builder"],
    nativeOperations: ["host.frontmostApp"],
  });
  assert.equal(decision.actions.length, 5);
  assert.deepEqual(decision.actions.map(({ type }) => type), ["vm", "send", "native", "spawn", "finish"]);
});

test("agent decisions repair individual invalid actions and preserve the first valid VM command", () => {
  const invalidPeer = parseAgentDecision(JSON.stringify({
    actions: [{ type: "send", to: "ghost", message: "hello" }, { type: "vm", command: "valid work" }],
  }), { peerIds: ["scout"] });
  assert.equal(invalidPeer.actions[0].command, "valid work");
  assert.match(invalidPeer.repairs[0].detail, /unknown message recipient/);
  const repeatedVm = parseAgentDecision(JSON.stringify({
    actions: [{ type: "vm", command: "true" }, { type: "vm", command: "false" }],
  }));
  assert.deepEqual(repeatedVm.actions.map((action) => action.command), ["true"]);
  assert.equal(repeatedVm.repairs[0].reason, "cardinality");
  assert.deepEqual(repeatedVm.queuedActions, []);
});

test("mailbox broadcast reaches every peer exactly once and not the sender", () => {
  const mailbox = new SwarmMailbox(["scout", "builder", "auditor"]);
  const sent = mailbox.send({ from: "scout", to: "all", message: "Please coordinate", kind: "request", round: 1 });
  assert.deepEqual(sent.recipients, ["builder", "auditor"]);
  assert.deepEqual(mailbox.drain("scout"), []);
  assert.equal(mailbox.drain("builder")[0].message, "Please coordinate");
  assert.equal(mailbox.drain("auditor")[0].message, "Please coordinate");
  assert.deepEqual(mailbox.drain("builder"), []);
});

test("mailbox refuses a report without resolved evidence before enqueuing it", () => {
  const mailbox = new SwarmMailbox(["builder", "auditor"]);
  assert.throws(() => mailbox.send({ from: "builder", to: "auditor", message: "Verified success", round: 1 }), /require resolved observed evidence/);
  assert.deepEqual(mailbox.drain("auditor"), []);
  assert.deepEqual(mailbox.history, []);
});

test("decimal exit-code strings are repaired explicitly without changing content expectations", () => {
  const decide = expected => parseAgentDecision(JSON.stringify({ actions: [{ type: "finish", summary: "Review observed status",
    assertions: [{ evidenceId: "round:1:vm", kind: "exit_code", expected }, { evidenceId: "round:1:vm", kind: "stdout_equals", expected: "0" }] }] }));
  for (const value of ["0", "1", "124", "255"]) {
    const decision = decide(value);
    assert.equal(decision.actions[0].assertions[0].expected, Number(value));
    assert.equal(decision.actions[0].assertions[1].expected, "0");
    assert.equal(decision.repairs[0].reason, "exit-code-type");
    assert.equal(decision.repairs[0].from, value);
  }
  for (const value of ["", " ", "0.0", "-1", "256", "00", "1e0", true, null]) {
    const decision = decide(value);
    assert.equal(decision.actions.length, 0);
    assert.equal(decision.repairs[0].reason, "invalid-action");
  }
});
