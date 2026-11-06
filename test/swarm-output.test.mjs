import test from "node:test";
import assert from "node:assert/strict";
import { createSwarmReporter, formatSwarmReview } from "../src/swarm-cli.mjs";

function captureReporter(options = {}) {
  const captured = { output: "", progress: "" };
  const report = createSwarmReporter({
    output: { write(chunk) { captured.output += chunk; } },
    progress: { write(chunk) { captured.progress += chunk; } },
    now: () => 1000,
    ...options,
  });
  return { report, captured };
}

for (const [name, output, printed] of [
  ["multiline Unicode with a final newline", "line one\nλ = 你好 🌱\n", "line one\nλ = 你好 🌱\n"],
  ["no final newline", "verified", "verified\n"],
  ["empty output", "", "(no guest output)\n"],
  ["whitespace output", " \t", " \t\n"],
  ["output larger than a model-history excerpt", "x".repeat(12_000), `${"x".repeat(12_000)}\n`],
]) {
  test(`swarm reporter prints ${name} without changing captured guest text`, () => {
    const { report, captured } = captureReporter();
    report({ type: "vm-result", round: 2, agentId: "builder", output, exitCode: 0, error: null });
    assert.equal(captured.output, `\n--- builder: guest output (round 2) ---\n${printed}`);
    assert.equal(captured.progress, "[0.0s] builder: guest command exited 0\n");
  });
}

test("swarm reporter retains guest output from unsuccessful commands and VM errors", () => {
  const { report, captured } = captureReporter();
  report({ type: "vm-result", round: 1, agentId: "scout", output: "assertion failed\n", exitCode: 1, error: null });
  report({ type: "vm-result", round: 2, agentId: "builder", output: "partial diagnostic", exitCode: null, error: "guest timed out" });
  assert.equal(captured.output,
    "\n--- scout: guest output (round 1) ---\nassertion failed\n" +
    "\n--- builder: guest output (round 2) ---\npartial diagnostic\n");
  assert.equal(captured.progress,
    "[0.0s] scout: guest command exited 1\n" +
    "[0.0s] builder: VM failed: guest timed out\n");
});

test("swarm reporter keeps ordinary lifecycle progress off stdout", () => {
  const { report, captured } = captureReporter();
  report({ type: "round-start", round: 1, maximumRounds: 3, agentIds: ["scout", "builder"] });
  report({ type: "agent-result", round: 1, agentId: "scout", actions: ["vm"], error: null });
  report({ type: "vm-start", round: 1, tasks: [{ agentId: "scout", command: "printf verified" }] });
  report({ type: "round-complete", round: 1, finished: 0, totalAgents: 2 });
  assert.equal(captured.output, "");
  assert.equal(captured.progress,
    "[0.0s] Round 1/3: asking scout, builder...\n" +
    "[0.0s] scout: vm\n" +
    "[0.0s] scout: running in Linux: printf verified\n" +
    "[0.0s] Round 1 saved; 0/2 gents finished.\n");
});

test("JSON mode emits no human output or progress before the final JSON document", () => {
  const { report, captured } = captureReporter({ json: true });
  for (const event of [
    { type: "round-start", round: 1, maximumRounds: 1, agentIds: ["builder"] },
    { type: "agent-result", round: 1, agentId: "builder", actions: ["vm"], error: null },
    { type: "vm-start", round: 1, tasks: [{ agentId: "builder", command: "false" }] },
    { type: "vm-result", round: 1, agentId: "builder", output: "failed\n", exitCode: 1, error: null },
    { type: "round-complete", round: 1, finished: 0, totalAgents: 1 },
  ]) report(event);
  assert.deepEqual(captured, { output: "", progress: "" });
});

test("an expected finish deferral is a note, while genuine failures still require review", () => {
  const deferred = "finish deferred: inspect this round's VM/native evidence on the next turn";
  const observedSuccess = [
    { observation: { errors: [deferred], vm: { exitCode: 0, error: null } } },
    { observation: { errors: [], vm: null } },
  ];
  assert.equal(formatSwarmReview(observedSuccess),
    "Note: 1 early finish request was deferred to allow results to be checked.\n");
  assert.equal(formatSwarmReview([
    ...observedSuccess,
    { observation: { errors: ["model unavailable"], vm: null } },
    { observation: { errors: [], vm: { exitCode: 1, error: null } } },
    { observation: { errors: [], vm: { error: "guest timed out" } } },
  ]),
  "Review: 3 gent turns contain errors; details are saved in the state file.\n" +
  "Note: 1 early finish request was deferred to allow results to be checked.\n");
  assert.deepEqual(observedSuccess[0].observation.errors, [deferred]);
  assert.equal(formatSwarmReview([{ observation: { errors: [], vm: { exitCode: 0 } } }]), "");
});
