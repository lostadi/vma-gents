import { randomUUID } from "node:crypto";
import { normalizeOstadixAction } from "./ostadix-control.mjs";

export const SWARM_PROTOCOL = "ovm.agent-pocket/v1";
export const MAX_AGENT_ACTIONS = 8;
export const MAX_AGENT_MESSAGE_BYTES = 4 * 1024;
export const MAX_VM_COMMAND_BYTES = 8 * 1024;

export function pocketId(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  if (!normalized) throw new Error("agent id must contain an ASCII letter or number");
  return normalized;
}

function extractJson(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) throw new Error("agent returned an empty decision");
  const unfenced = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
    : trimmed;
  try { return JSON.parse(unfenced); } catch {}
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("agent decision does not contain a JSON object");
  return JSON.parse(unfenced.slice(start, end + 1));
}

function boundedString(value, name, maximumBytes, { optional = false } = {}) {
  if (optional && (value === undefined || value === null)) return null;
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${name} must be a nonempty string`);
  const normalized = value.trim();
  if (Buffer.byteLength(normalized, "utf8") > maximumBytes) throw new Error(`${name} exceeds ${maximumBytes} bytes`);
  return normalized;
}

function validateAction(action, peers, nativeOperations, { interactive = false } = {}) {
  if (!action || typeof action !== "object" || Array.isArray(action)) throw new Error("each action must be an object");
  switch (action.type) {
    case "ostadix":
      return Object.freeze(normalizeOstadixAction(action));
    case "read_execution":
      return Object.freeze({ type: "read_execution", evidenceId: boundedString(action.evidenceId, "execution evidence ID", 256) });
    case "review_artifact":
      return Object.freeze({ type: "review_artifact", artifactId: boundedString(action.artifactId, "code artifact ID", 256) });
    case "vm":
      return Object.freeze({
        type: "vm",
        command: boundedString(action.command, "VM command", MAX_VM_COMMAND_BYTES),
        reason: boundedString(action.reason, "VM action reason", 1024, { optional: true }),
      });
    case "send": {
      const to = action.to === "all" ? "all" : pocketId(action.to);
      if (to !== "all" && !peers.has(to)) throw new Error(`unknown message recipient: ${to}`);
      const kind = action.kind ?? "report";
      if (!["request", "hypothesis", "report"].includes(kind)) throw new Error("send kind must be request, hypothesis, or report");
      return Object.freeze({
        type: "send",
        to,
        message: boundedString(action.message, "agent message", MAX_AGENT_MESSAGE_BYTES),
        evidence: evidenceReferences(action.evidence),
        kind,
        revises: boundedString(action.revises, "pending claim ID", 256, { optional: true }),
      });
    }
    case "publish":
      return Object.freeze({ type: "publish", path: boundedString(action.path, "artifact guest path", 4096), name: boundedString(action.name, "artifact name", 128) });
    case "inspect_source": {
      const sourcePath = boundedString(action.path, "guest source path", 4096);
      if (!sourcePath.startsWith("/") || sourcePath.includes("\0")) throw new Error("inspect_source requires an absolute guest path");
      return Object.freeze({ type: "inspect_source", path: sourcePath, scope: "guest", reason: boundedString(action.reason, "source inspection reason", 1024, { optional: true }) });
    }
    case "native": {
      const operation = boundedString(action.operation, "native operation", 256);
      if (!nativeOperations.has(operation)) throw new Error(`native operation is unavailable: ${operation}`);
      if (!Array.isArray(action.args ?? [])) throw new Error("native action args must be an array");
      const args = action.args ?? [];
      if (Buffer.byteLength(JSON.stringify(args), "utf8") > 8 * 1024) throw new Error("native action args exceed 8192 bytes");
      return Object.freeze({ type: "native", operation, args });
    }
    case "spawn":
      return Object.freeze({
        type: "spawn",
        id: pocketId(action.id),
        role: boundedString(action.role, "spawn role", 512),
        mission: boundedString(action.mission, "spawn mission", 2048),
      });
    case "finish":
      return Object.freeze({
        type: "finish",
        summary: boundedString(action.summary, "finish summary", 4096),
        evidence: evidenceReferences(action.evidence),
        assertions: assertions(action.assertions),
      });
    case "reply":
      if (!interactive) throw new Error("reply is available only in interactive chat; tasks require finish with explicit assertions");
      return Object.freeze({ type: "reply", message: boundedString(action.message, "chat reply", 4096), evidence: evidenceReferences(action.evidence), assertions: assertions(action.assertions), revises: boundedString(action.revises, "pending claim ID", 256, { optional: true }) });
    default:
      throw new Error(`unknown agent action: ${action.type}`);
  }
}

function evidenceReferences(value = []) {
  if (!Array.isArray(value) || value.length > 16 || new Set(value).size !== value.length) throw new Error("evidence must contain up to 16 unique evidence IDs");
  return Object.freeze(value.map((item) => boundedString(item, "evidence ID", 256)));
}

function assertions(value = []) {
  if (!Array.isArray(value) || value.length > 16) throw new Error("assertions must contain up to 16 explicit checks");
  return Object.freeze(value.map((item) => {
    if (!item || !["stdout_contains", "stdout_equals", "exit_code", "native_value_equals", "artifact_sha256", "source_kind", "ostadix_checks_passed", "peer_review_passed"].includes(item.kind)) throw new Error("unsupported assertion kind");
    const evidenceId = boundedString(item.evidenceId, "assertion evidence ID", 256);
    if (["ostadix_checks_passed", "peer_review_passed"].includes(item.kind)) {
      if (item.expected !== true) throw new Error("execution verification assertion expected value must be true");
    } else if (item.kind === "exit_code") {
      if (!Number.isInteger(item.expected) || item.expected < 0 || item.expected > 255) throw new Error("exit_code assertion expected value must be 0–255");
    } else if (item.kind === "native_value_equals") {
      if (item.expected === undefined || Buffer.byteLength(JSON.stringify(item.expected)) > 8192) throw new Error("native value assertion requires a bounded expected JSON value");
    } else if (item.kind === "artifact_sha256") {
      if (!/^[a-f0-9]{64}$/.test(item.expected ?? "")) throw new Error("artifact assertion requires a SHA-256 digest");
    } else if (item.kind === "source_kind") {
      if (!["source_absent", "source_present", "source_unreadable", "source_not_regular"].includes(item.expected)) throw new Error("source assertion requires an observed source kind");
    } else if (typeof item.expected !== "string" || Buffer.byteLength(item.expected) > 4096 || (item.kind === "stdout_contains" && !item.expected)) throw new Error("stdout assertion requires a bounded expected string");
    return Object.freeze({ evidenceId, kind: item.kind, expected: item.expected });
  }));
}

export function parseAgentDecision(text, {
  peerIds = [],
  nativeOperations = [],
  interactive = false,
} = {}) {
  const raw = extractJson(text);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("agent decision must be a JSON object");
  const actions = raw.actions ?? [];
  if (!Array.isArray(actions)) throw new Error("agent decision actions must be an array");
  if (actions.length > 64) throw new Error("agent decision is too large to project safely");
  const peers = new Set(peerIds.map(pocketId));
  const availableNative = new Set(nativeOperations);
  const repairs = [], validated = [];
  for (const [index, action] of actions.entries()) {
    if (index >= MAX_AGENT_ACTIONS) { repairs.push({ dropped: action?.type ?? "invalid", index, reason: "action-limit", detail: `At most ${MAX_AGENT_ACTIONS} actions are processed` }); continue; }
    try {
      const typeRepairs = [];
      let candidate = action;
      // Small models sometimes serialize the numeric exit status as "0".
      // This unambiguous representation repair never changes the predicate,
      // its evidence reference, or any native/string content expectation.
      if (["finish", "reply"].includes(action?.type) && Array.isArray(action.assertions) && action.assertions.length <= 16) {
        candidate = { ...action, assertions: action.assertions.map((assertion, assertionIndex) => {
          if (assertion?.kind !== "exit_code" || typeof assertion.expected !== "string"
            || !/^(?:0|[1-9][0-9]{0,2})$/.test(assertion.expected) || Number(assertion.expected) > 255) return assertion;
          const expected = Number(assertion.expected);
          typeRepairs.push({ normalized: action.type, index, assertionIndex, reason: "exit-code-type", from: assertion.expected, to: expected,
            detail: "Converted a decimal exit-code string to a JSON number; the observation must still satisfy this assertion" });
          return { ...assertion, expected };
        }) };
      }
      validated.push({ action: validateAction(candidate, peers, availableNative, { interactive }), index });
      repairs.push(...typeRepairs);
    }
    catch (error) { repairs.push({ dropped: action?.type ?? "invalid", index, reason: "invalid-action", detail: error.message }); }
  }
  const firstVm = validated.find(({ action }) => ["vm", "ostadix", "review_artifact"].includes(action.type));
  const selectedGuest = firstVm ?? validated.find(({ action }) => ["publish", "inspect_source"].includes(action.type));
  const projected = [], queuedActions = [];
  let nativeCount = 0;
  for (const item of validated) {
    const { action, index } = item;
    if (["vm", "ostadix", "review_artifact", "publish", "inspect_source"].includes(action.type) && item !== selectedGuest) {
      if (firstVm?.action.type === "vm" && action.type === "publish" && !queuedActions.length) {
        queuedActions.push({ action, requires: "vm-success" });
        repairs.push({ dropped: "publish", index, reason: "cardinality", detail: "Publication queued after the selected VM command is observed", queuedAgainst: "this-turn-vm" });
      } else repairs.push({ dropped: action.type, index, reason: "cardinality", detail: "Only the first valid VM operation is executed; additional commands are not replayed automatically" });
      continue;
    }
    if (action.type === "native" && ++nativeCount > 2) { repairs.push({ dropped: "native", index, reason: "cardinality", detail: "At most two native calls run in one round" }); continue; }
    projected.push(action);
  }
  return Object.freeze({
    rationale: typeof raw.rationale === "string" ? raw.rationale.slice(0, 2048) : "",
    actions: Object.freeze(projected),
    repairs: Object.freeze(repairs),
    queuedActions: Object.freeze(queuedActions),
  });
}

export class SwarmMailbox {
  constructor(agentIds = [], { snapshot = null, history = [], transcript = [] } = {}) {
    this.queues = new Map();
    this.history = [];
    for (const id of agentIds) this.register(id);
    if (!Array.isArray(history)) throw new Error("saved mailbox history must be an array");
    const envelopes = new Map();
    for (const original of history) {
      if (typeof original.id !== "string" || !original.id || envelopes.has(original.id)) throw new Error("saved mailbox message IDs must be unique");
      const envelope = structuredClone(original);
      const sender = pocketId(envelope.from);
      if (!this.queues.has(sender)) throw new Error(`unknown saved mailbox sender: ${sender}`);
      const recipients = envelope.recipients ?? (envelope.to === "all" ? [...this.queues.keys()].filter((id) => id !== sender) : [pocketId(envelope.to)]);
      if (!Array.isArray(recipients) || new Set(recipients).size !== recipients.length || recipients.some((id) => !this.queues.has(id))) throw new Error("invalid saved mailbox recipients");
      envelope.recipients = recipients;
      boundedString(envelope.message, "saved mailbox message", MAX_AGENT_MESSAGE_BYTES);
      envelopes.set(envelope.id, envelope);
      this.history.push(envelope);
    }
    if (snapshot) {
      if (snapshot.schema !== "ovm.mailbox/v1" || !snapshot.queues || typeof snapshot.queues !== "object" || Array.isArray(snapshot.queues)) throw new Error("unsupported saved mailbox snapshot");
      for (const [id, messageIds] of Object.entries(snapshot.queues)) {
        if (!this.queues.has(id) || !Array.isArray(messageIds) || new Set(messageIds).size !== messageIds.length) throw new Error("invalid saved mailbox queue");
        for (const messageId of messageIds) {
          const message = envelopes.get(messageId);
          if (!message || !message.recipients.includes(id)) throw new Error("saved mailbox queue references an unknown message or recipient");
          this.queues.get(id).push(message);
        }
      }
    } else if (history.length) {
      // Legacy snapshots saved history but not queues. Reconstruct delivery
      // from the actual inboxes in each agent's saved reasoning turns.
      const consumed = new Map([...this.queues.keys()].map((id) => [id, new Set()]));
      for (const turn of transcript) for (const message of turn.inbox ?? []) consumed.get(turn.agentId)?.add(message.id);
      for (const envelope of this.history) for (const id of envelope.recipients) {
        if (!consumed.get(id).has(envelope.id)) this.queues.get(id).push(envelope);
      }
    }
  }

  register(id) {
    const normalized = pocketId(id);
    if (!this.queues.has(normalized)) this.queues.set(normalized, []);
  }

  send({ from, to, message, round, evidence = [], kind = "report" }) {
    if (!["request", "hypothesis", "report"].includes(kind)) throw new Error("message kind must be request, hypothesis, or report");
    if (!Array.isArray(evidence) || (kind === "report" && evidence.length === 0)) throw new Error("report messages require resolved observed evidence; requests and hypotheses may omit evidence");
    const sender = pocketId(from);
    if (!this.queues.has(sender)) throw new Error(`unknown sender: ${sender}`);
    const recipients = to === "all"
      ? [...this.queues.keys()].filter((id) => id !== sender)
      : [pocketId(to)];
    for (const recipient of recipients) {
      if (!this.queues.has(recipient)) throw new Error(`unknown recipient: ${recipient}`);
    }
    const envelope = Object.freeze({
      id: randomUUID(),
      from: sender,
      to: to === "all" ? "all" : recipients[0],
      recipients,
      round,
      message: boundedString(message, "agent message", MAX_AGENT_MESSAGE_BYTES),
      kind,
      claimStatus: kind === "report" ? "reported" : "unverified-intent",
      evidence: structuredClone(evidence),
    });
    for (const recipient of recipients) this.queues.get(recipient).push(envelope);
    this.history.push(envelope);
    return envelope;
  }

  drain(id) {
    const normalized = pocketId(id);
    const queue = this.queues.get(normalized);
    if (!queue) throw new Error(`unknown mailbox: ${normalized}`);
    return queue.splice(0, queue.length);
  }

  putBack(id, messages) {
    const queue = this.queues.get(pocketId(id));
    if (!queue) throw new Error(`unknown mailbox: ${id}`);
    queue.unshift(...messages);
  }

  snapshot() {
    return { schema: "ovm.mailbox/v1", queues: Object.fromEntries([...this.queues].map(([id, queue]) => [id, queue.map((message) => message.id)])) };
  }
}
