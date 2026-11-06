import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { OllamaAgentClient } from "../src/ollama-agent.mjs";

function preserveTimeoutEnvironment(t) {
  const previous = process.env.OVM_MODEL_TIMEOUT_SECONDS;
  t.after(() => {
    if (previous === undefined) delete process.env.OVM_MODEL_TIMEOUT_SECONDS;
    else process.env.OVM_MODEL_TIMEOUT_SECONDS = previous;
  });
}

test("model timeout defaults to 90 seconds and accepts a bounded slow-host override", t => {
  preserveTimeoutEnvironment(t);
  delete process.env.OVM_MODEL_TIMEOUT_SECONDS;
  assert.equal(new OllamaAgentClient().timeoutMilliseconds, 90_000);
  for (const seconds of [1, 300, 3600]) {
    process.env.OVM_MODEL_TIMEOUT_SECONDS = String(seconds);
    assert.equal(new OllamaAgentClient().timeoutMilliseconds, seconds * 1000);
  }
});

test("invalid model timeout settings fail before any inference dispatch", t => {
  preserveTimeoutEnvironment(t);
  let calls = 0;
  for (const raw of ["", "0", "-1", "1.5", "1e2", " 90", "90s", "3601", "Infinity", "99999999999999999999"]) {
    process.env.OVM_MODEL_TIMEOUT_SECONDS = raw;
    assert.throws(() => new OllamaAgentClient({ fetchImpl: async () => { calls++; } }), /OVM_MODEL_TIMEOUT_SECONDS.*1 and 3600/);
  }
  assert.equal(calls, 0);
});

test("explicit constructor timeout retains precedence and aborts its pending request", async t => {
  preserveTimeoutEnvironment(t);
  process.env.OVM_MODEL_TIMEOUT_SECONDS = "invalid-but-overridden";
  let calls = 0;
  const client = new OllamaAgentClient({
    timeoutMilliseconds: 10,
    fetchImpl: async (_url, { signal }) => {
      calls++;
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    },
  });
  assert.equal(client.timeoutMilliseconds, 10);
  await assert.rejects(client.decide({ id: "scout", role: "observe" }, { nativeOperations: [] }), /Ollama decision timed out/);
  assert.equal(calls, 1);
});

test("Ollama pocket requests disable hidden thinking and retain completion metadata", async () => {
  let request;
  const client = new OllamaAgentClient({
    fetchImpl: async (_url, options) => {
      request = JSON.parse(options.body);
      return new Response(JSON.stringify({
        model: "tiny-local",
        done_reason: "stop",
        message: { content: '{"rationale":"ok","actions":[]}' },
        eval_count: 12,
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const result = await client.decide({ id: "scout", role: "observe", parentId: null, lastObservation: {
    round: 1, errors: ["failure: " + "x".repeat(5000) + ":end"],
  } }, {
    protocol: "ovm.agent-pocket/v1",
    swarmId: "test",
    round: 1,
    maximumRounds: 2,
    mission: "test",
    peers: [],
    inbox: [],
    nativeOperations: [],
  });
  assert.equal(request.think, false);
  assert.equal(request.format, "json");
  assert.equal(result.metrics.doneReason, "stop");
  assert.equal(result.metrics.outputTokens, 12);
  const context = JSON.parse(request.messages[1].content);
  assert.equal(context.previousObservation.errors[0].length, 1024);
  assert.match(context.previousObservation.errors[0], /^failure: .*\n\.\.\.\[truncated\]\.\.\.\n.*:end$/);
});

async function captureOstadixPrompt(agent, context) {
  let request;
  const client = new OllamaAgentClient({ timeoutMilliseconds: 1000, fetchImpl: async (_url, options) => {
    request = JSON.parse(options.body);
    return new Response(JSON.stringify({ message: { content: '{"actions":[]}' } }), { status: 200 });
  } });
  await client.decide(agent, { nativeOperations: [], peers: [], inbox: [], ...context });
  return { request, system: request.messages[0].content, user: JSON.parse(request.messages[1].content) };
}

test("Ostadix prompt observations expose compact outcomes without leaking native phase payloads or changing retained evidence", async () => {
  const phaseMarker = "RAW_NATIVE_PHASE_MUST_STAY_IN_HISTORY";
  const source = "python^(\n# source-start\n" + "x".repeat(6000) + "\n# source-end\n)_python\n";
  const checks = [{ kind: "stdout_contains", expected: "result" }];
  const ostadix = {
    sourceSha256: "a".repeat(64), executionIntentSha256: "b".repeat(64), mode: "run", executed: true,
    checkStatus: "checks-passed", success: true, checks: [{ ...checks[0], passed: true }], exitCode: 0,
    stdout: "output-start:" + "x".repeat(6000) + ":result:output-end", stderr: "stderr-start:" + "y".repeat(6000) + ":stderr-end",
    diagnostics: [{ language: "python", state: "skipped", reason: "diagnostic-start:" + "z".repeat(6000) + ":diagnostic-end" }],
    error: null,
    parse: { stdout: phaseMarker + ":parse:" + "p".repeat(10000) },
    intent: { stdout: phaseMarker + ":intent:" + "i".repeat(10000) },
    execution: { stdout: phaseMarker + ":execution:" + "e".repeat(10000) },
    sourceStructure: { rawExtra: phaseMarker }, unexpectedNativeDetails: phaseMarker,
  };
  const observation = { round: 6, ostadix, vm: { exitCode: 0, ostadixCapture: true, output: JSON.stringify(ostadix) },
    evidence: [{ id: "family:builder:6:ostadix", kind: "ostadix", checkStatus: "checks-passed", allowedAssertions: ["ostadix_checks_passed"] }], errors: [] };
  const recentHistory = Array.from({ length: 6 }, (_, index) => ({ round: index + 1,
    actions: [{ type: "ostadix", mode: "run", name: "result", source, checks }], observation }));
  const agent = { id: "builder", role: "write", lastObservation: observation };
  const context = { round: 7, recentHistory, availableEvidence: observation.evidence };
  const before = JSON.stringify({ agent, context });
  const captured = await captureOstadixPrompt(agent, context);
  assert.equal(JSON.stringify({ agent, context }), before, "Prompt compaction must not alter retained full-fidelity history");
  assert.doesNotMatch(captured.request.messages[1].content, new RegExp(phaseMarker));
  assert.ok(captured.request.messages[1].content.length <= 8000);
  assert.equal(captured.user.recentHistory.length + captured.user.contextOmissions.omitted.recentHistory, 6);
  for (const summary of [captured.user.previousObservation, ...captured.user.recentHistory.map(turn => turn.observation)]) {
    assert.equal(summary.ostadix.sourceSha256, ostadix.sourceSha256);
    assert.equal(summary.ostadix.executionIntentSha256, ostadix.executionIntentSha256);
    assert.equal(summary.ostadix.checkStatus, "checks-passed");
    assert.equal(summary.ostadix.executed, true);
    assert.equal(summary.ostadix.checks[0].passed, true);
    assert.equal(summary.evidence[0].id, "family:builder:6:ostadix");
    for (const key of ["parse", "intent", "execution", "sourceStructure", "unexpectedNativeDetails"]) assert.equal(Object.hasOwn(summary.ostadix, key), false);
    for (const key of ["stdout", "stderr", "diagnostics"]) {
      assert.ok(summary.ostadix[key].length <= 2048);
      assert.match(summary.ostadix[key], /\[truncated\]/);
    }
    assert.match(summary.ostadix.stdout, /^output-start:.*\[truncated\].*:result:output-end$/s);
    if (summary.vm) assert.match(summary.vm.output, /capture metadata/);
  }
  for (const turn of captured.user.recentHistory) {
    assert.ok(turn.actions[0].source.length <= 2048);
    assert.match(turn.actions[0].source, /source-start.*\[truncated\].*source-end/s);
  }
});

test("execution read excerpts keep exact evidence identities and explicit truncation without becoming new verification", async () => {
  const artifactId = "ostadix:" + "a".repeat(64), evidenceId = "family:producer:2:ostadix";
  const source = "source-start:" + "s".repeat(6000) + ":source-end";
  const makeRead = (id, overrides = {}) => ({ evidence: { id, producer: "producer", kind: "ostadix" }, source,
    actions: [{ type: "ostadix", name: "program", mode: "run", source, checks: [{ kind: "stdout_contains", expected: "2" }] },
      { type: "read_execution", evidenceId }, { type: "review_artifact", artifactId }],
    stdout: { text: "stdout-start:" + "o".repeat(7000) + ":stdout-end", truncated: false },
    stderr: { text: "stderr-start:" + "e".repeat(3000) + ":stderr-end", truncated: false },
    independentVerification: false, meaning: "Read of a retained observation; no new execution occurred", checks: [], ...overrides });
  const reads = [makeRead("oldest"), makeRead(evidenceId), makeRead("family:producer:3:ostadix", {
    source: null, stdout: { text: "short retained tail", truncated: true }, stderr: { text: "", truncated: false },
  })];
  const agent = { id: "reviewer", role: "check", lastObservation: { round: 4, executionReads: reads } };
  const before = JSON.stringify(agent);
  const { user } = await captureOstadixPrompt(agent, { round: 5 });
  assert.equal(JSON.stringify(agent), before);
  const shown = user.previousObservation.executionReads;
  assert.deepEqual(shown.map(read => read.evidence.id), [evidenceId, "family:producer:3:ostadix"]);
  assert.equal(shown[0].independentVerification, false);
  assert.equal(shown[0].stdout.truncated, true); assert.equal(shown[0].stderr.truncated, true);
  assert.ok(shown[0].stdout.text.length <= 2048); assert.ok(shown[0].stderr.text.length <= 1024);
  assert.match(shown[0].source, /source-start:.*\[truncated\].*:source-end/s);
  assert.equal(shown[0].sourceTruncated, true);
  assert.equal(shown[0].actions[1].evidenceId, evidenceId);
  assert.equal(shown[0].actions[2].artifactId, artifactId);
  assert.equal(shown[1].source, null);
  assert.equal(shown[1].sourceTruncated, false);
  assert.equal(shown[1].stdout.truncated, true, "A short excerpt must preserve the controller's earlier truncation signal");
  assert.equal(shown[1].stderr.truncated, false);
});

test("Ostadix teaching and context preserve all structured action and verification references", async () => {
  const executionId = "family:writer:1:ostadix", reviewId = "family:reviewer:2:peer-review", artifactId = "ostadix:" + "c".repeat(64);
  const source = "python^(\n__oval_result__ = 1 + 1\n)_python";
  const actions = [
    { type: "ostadix", name: "sum", mode: "check", source, checks: [] },
    { type: "read_execution", evidenceId: executionId },
    { type: "review_artifact", artifactId },
    { type: "finish", summary: "The recorded predicates passed", evidence: [executionId, reviewId], assertions: [
      { evidenceId: executionId, kind: "ostadix_checks_passed", expected: true },
      { evidenceId: reviewId, kind: "peer_review_passed", expected: true },
    ] },
  ];
  const artifact = { id: artifactId, kind: "ostadix-program", code: { executionEvidenceId: executionId,
    contract: { checks: [{ kind: "stdout_equals", expected: "[number] 2\n" }] } }, peerVerification: { status: "awaiting-peer-review" } };
  const evidence = [{ id: executionId, kind: "ostadix" }, { id: reviewId, kind: "peer-review" }];
  const review = { artifactId, reviewEvidenceId: reviewId, status: "peer-verified", reviewer: "reviewer", producer: "writer" };
  const { system, user } = await captureOstadixPrompt({ id: "writer", role: "implement" }, {
    availableArtifacts: [artifact], availableEvidence: evidence, artifactReviews: [review], pendingCodeReviews: [{ id: artifactId, name: "sum" }],
    recentHistory: [{ round: 2, actions, observation: { round: 2, evidence } }],
  });
  for (const type of ["ostadix", "read_execution", "review_artifact"]) assert.ok(system.includes(`"type":"${type}"`));
  assert.match(system, /source\/intent binding/);
  assert.match(system, /unchanged source and checks/);
  assert.match(system, /Self-review is refused/);
  assert.match(system, /ostadix_checks_passed/); assert.match(system, /peer_review_passed/);
  assert.match(system, /Static-check and capture metadata cannot satisfy execution assertions/);
  assert.match(system, /at most one guest action \(vm, ostadix, review_artifact, publish, or inspect_source\)/);
  assert.deepEqual(user.recentHistory[0].actions, actions);
  assert.equal(user.availableArtifacts[0].id, artifactId);
  assert.equal(user.availableArtifacts[0].code.executionEvidenceId, executionId);
  assert.deepEqual(user.availableEvidence.map(item => item.id), evidence.map(item => item.id));
  assert.equal(user.artifactReviews[0].reviewEvidenceId, reviewId);
  assert.equal(user.pendingCodeReviews[0].id, artifactId);
});

test("large O contracts are explicitly excerpted in every prompt surface while exact contracts remain retained", async () => {
  const source = "python^(\n__oval_result__ = 1 + 1\n)_python";
  const checks = Array.from({ length: 8 }, (_, index) => ({ kind: "stdout_contains",
    expected: `predicate-${index}:` + "x".repeat(4096 - `predicate-${index}:`.length - ":end".length) + ":end" }));
  const results = checks.map(check => ({ ...check, passed: true }));
  const executionId = "family:writer:1:ostadix";
  const review = { artifactId: "ostadix:" + "a".repeat(64), reviewEvidenceId: "family:reviewer:2:peer-review",
    producer: "writer", reviewer: "reviewer", status: "peer-verified", checks: results };
  const artifacts = Array.from({ length: 10 }, (_, index) => ({ id: `ostadix:${String(index).padStart(64, "0")}`,
    kind: "ostadix-program", name: `program-${index}`, sha256: "b".repeat(64),
    code: { language: "ostadix", sourceSha256: "b".repeat(64), executionEvidenceId: executionId,
      contract: { checks } }, peerVerification: review }));
  const observation = { round: 2, evidence: [{ id: executionId, kind: "ostadix" }], artifacts: [artifacts[0]],
    ostadix: { sourceSha256: "b".repeat(64), mode: "run", executed: true, success: true,
      checkStatus: "checks-passed", checks: results, stdout: "2", stderr: "", diagnostics: [] },
    peerReview: review, executionReads: [{ evidence: { id: executionId, producer: "writer" }, source, checks: results,
      peerReview: review, actions: [{ type: "ostadix", name: "sum", mode: "run", source, checks }],
      stdout: { text: "2", truncated: false }, stderr: { text: "", truncated: false }, independentVerification: false }] };
  const agent = { id: "reader", role: "inspect", lastObservation: observation };
  const context = { availableArtifacts: artifacts, artifactReviews: Array.from({ length: 6 }, (_, index) => ({
    ...review, reviewEvidenceId: `family:reviewer:${index + 1}:peer-review` })),
    recentHistory: [{ round: 2, actions: [{ type: "ostadix", name: "sum", mode: "run", source, checks }], observation }] };
  const before = JSON.stringify({ agent, context });
  const { system, user } = await captureOstadixPrompt(agent, context);
  assert.equal(JSON.stringify({ agent, context }), before, "Exact predicates must remain available for stored-contract replay");
  assert.equal(user.availableArtifacts.at(-1).id, artifacts.at(-1).id);
  assert.equal(user.availableArtifacts.length + user.contextOmissions.omitted.availableArtifacts, artifacts.length);
  assert.ok(JSON.stringify(user).length <= 8000);
  assert.equal(user.previousObservation.ostadix.checkStatus, "checks-passed");
  assert.equal(user.previousObservation.peerReview.reviewEvidenceId, review.reviewEvidenceId);
  const inspectChecks = value => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value.checks) && value.checks.length) for (const [index, check] of value.checks.entries()) {
      assert.equal(check.kind, checks[index].kind);
      assert.ok(check.expected.length <= 256);
      assert.equal(check.expectedTruncated, true);
      assert.match(check.expected, /\[truncated\]/);
    }
    if (value.checksSummary) {
      assert.equal(value.checksSummary.count, 8);
      assert.equal(value.checksSummary.predicateTextOmitted, true);
    }
    for (const entry of Object.values(value)) if (entry && typeof entry === "object") inspectChecks(entry);
  };
  inspectChecks(user);
  assert.match(system, /expectedTruncated.*incomplete; review_artifact always uses the full unchanged contract/);
});

function contextBudgetFixture() {
  const executionId = "family:writer:2:ostadix", reviewId = "family:checker:3:peer-review";
  const artifactId = "ostadix:" + "d".repeat(64);
  const checks = [{ kind: "stdout_equals", expected: "[number] 2\n", passed: true }];
  const review = { artifactId, producer: "writer", reviewer: "checker", round: 3, status: "peer-verified",
    executionEvidenceId: executionId, reviewEvidenceId: reviewId, checks };
  const observed = { round: 2, evidence: [{ id: executionId, producer: "writer", kind: "ostadix",
    executed: true, checkStatus: "checks-passed", allowedAssertions: ["ostadix_checks_passed"] }],
    ostadix: { sourceSha256: "e".repeat(64), executionIntentSha256: "f".repeat(64), mode: "run", executed: true,
      success: true, checkStatus: "checks-passed", exitCode: 0, stdout: "[number] 2\n", stderr: "", diagnostics: [], checks } };
  const artifact = { id: artifactId, kind: "ostadix-program", name: "sum", producer: "writer", round: 2,
    sha256: "e".repeat(64), code: { executionEvidenceId: executionId, contract: { checks } }, peerVerification: review };
  const agent = { id: "writer", role: "implement the specified sum", mission: "Run the exact source, then await a distinct peer review.",
    lastObservation: { round: 9, errors: ["Ollama 400: request exceeds the available context size"], evidence: [] } };
  const context = { mission: "Produce and independently verify a sum program; do not repeat an already completed execution.",
    round: 10, currentInvocationStartRound: 0, maximumRounds: 12, maximumAgents: 2, nativeOperations: [], peers: [{ id: "checker", finished: false }],
    inbox: Array.from({ length: 30 }, (_, index) => ({ id: `message-${index}`, from: "checker", message: "older context ".repeat(500) })),
    availableArtifacts: [artifact, ...Array.from({ length: 20 }, (_, index) => ({ ...artifact, id: `unrelated-${index}`, producer: "other" }))],
    availableEvidence: [...observed.evidence, { id: reviewId, producer: "checker", kind: "peer-review",
      status: "peer-verified", allowedAssertions: ["peer_review_passed"] },
    ...Array.from({ length: 40 }, (_, index) => ({ id: `irrelevant-${index}`, kind: "vm", details: "old ".repeat(1000) }))],
    artifactReviews: [review, ...Array.from({ length: 10 }, (_, index) => ({ ...review, artifactId: `unrelated-${index}`, reviewEvidenceId: `other-review-${index}` }))],
    pendingCodeReviews: [], lastExecutionObservation: observed,
    recentHistory: Array.from({ length: 4 }, (_, index) => ({ round: index + 6, actions: [],
      observation: { round: index + 6, errors: ["Ollama 400: request exceeds the available context size"], evidence: [] } })),
  };
  return { agent, context, executionId, reviewId, artifactId, observed };
}

test("aggregate context budgeting retains completed work and exact peer references after repeated API errors", async () => {
  const { agent, context, executionId, reviewId, artifactId, observed } = contextBudgetFixture();
  const original = JSON.stringify({ agent, context });
  const { request, user } = await captureOstadixPrompt(agent, context);
  assert.ok(request.messages[1].content.length <= 8000);
  assert.equal(user.mission, context.mission); assert.equal(user.agentMission, agent.mission);
  assert.equal(user.identity.id, agent.id); assert.equal(user.identity.role, agent.role);
  assert.equal(user.previousObservation.round, 9);
  assert.equal(user.lastExecutionObservation.round, observed.round);
  assert.equal(user.lastExecutionObservation.ostadix.executed, true);
  assert.equal(user.lastExecutionObservation.ostadix.checkStatus, "checks-passed");
  assert.equal(user.lastExecutionObservation.ostadix.stdout, "[number] 2\n");
  assert.equal(user.lastExecutionObservation.evidence[0].id, executionId);
  const shownArtifact = user.availableArtifacts.find(artifact => artifact.id === artifactId);
  assert.equal(shownArtifact.code.executionEvidenceId, executionId);
  assert.equal(shownArtifact.peerVerification.reviewEvidenceId, reviewId);
  assert.equal(user.artifactReviews.find(review => review.reviewEvidenceId === reviewId).status, "peer-verified");
  assert.ok(user.contextOmissions.omitted.inbox > 0); assert.ok(user.contextOmissions.omitted.availableArtifacts > 0);
  assert.match(user.contextOmissions.detail, /not complete history/);
  assert.equal(JSON.stringify({ agent, context }), original);
});

test("one rejected context-overflow request is retried with smaller valid JSON and no larger model window", async t => {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.writeHead(requests.length === 1 ? 400 : 200, { "content-type": "application/json" });
    response.end(requests.length === 1
      ? JSON.stringify({ error: JSON.stringify({ error: { type: "exceed_context_size_error", message: "request (9900 tokens) exceeds the available context size (8192 tokens)" } }) })
      : JSON.stringify({ message: { content: '{"actions":[]}' } }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { agent, context, executionId, reviewId } = contextBudgetFixture();
  const before = JSON.stringify({ agent, context });
  const client = new OllamaAgentClient({ endpoint: `http://127.0.0.1:${server.address().port}`, timeoutMilliseconds: 1000 });
  const result = await client.decide(agent, context);
  assert.equal(requests.length, 2); assert.equal(result.metrics.contextRetries, 1);
  assert.equal(requests[0].options.num_ctx, 8192); assert.equal(requests[1].options.num_ctx, 8192);
  assert.equal(requests[0].messages[0].content, requests[1].messages[0].content);
  assert.ok(requests[1].messages[1].content.length < requests[0].messages[1].content.length);
  const retried = JSON.parse(requests[1].messages[1].content);
  assert.equal(retried.mission, context.mission);
  assert.equal(retried.lastExecutionObservation.evidence[0].id, executionId);
  assert.equal(retried.availableArtifacts[0].peerVerification.reviewEvidenceId, reviewId);
  assert.equal(retried.contextOmissions.reason, "server-context-overflow-retry");
  assert.equal(JSON.stringify({ agent, context }), before);
});

test("context retry is limited to one specific HTTP 400 overflow and never retries other failures", async () => {
  for (const [status, body, expectedCalls] of [
    [400, '{"error":"exceed_context_size_error"}', 2],
    [400, '{"error":"invalid model parameter"}', 1],
    [500, '{"error":"exceed_context_size_error"}', 1],
    [503, '{"error":"busy"}', 1],
  ]) {
    let calls = 0;
    const client = new OllamaAgentClient({ timeoutMilliseconds: 1000, fetchImpl: async () => { calls++; return new Response(body, { status }); } });
    const { agent, context } = contextBudgetFixture();
    await assert.rejects(client.decide(agent, context), /Ollama (400|500|503):/);
    assert.equal(calls, expectedCalls);
  }
});

test("an essential mission that exceeds the budget or a tiny context fails before inference without truncating instructions", async () => {
  for (const [contextTokens, mission, pattern] of [[8192, "required instruction ".repeat(1000), /cannot fit essential mission/], [1024, "Do the task", /too small for the system instructions/]]) {
    let calls = 0;
    const client = new OllamaAgentClient({ contextTokens, fetchImpl: async () => { calls++; throw new Error("must not dispatch"); } });
    await assert.rejects(client.decide({ id: "writer", role: "implement" }, { nativeOperations: [], mission }), pattern);
    assert.equal(calls, 0);
  }
});
