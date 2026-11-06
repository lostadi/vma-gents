"use strict";

const fs = require("node:fs");

const MAX_REQUEST_BYTES = 16 * 1024;

function serialize(value, seen = new WeakSet(), depth = 0) {
  if (value === null || value === undefined) return value ?? null;
  if (["string", "number", "boolean"].includes(typeof value)) return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return { type: "function", name: value.name || null };
  if (Buffer.isBuffer(value)) return { type: "buffer", bytes: value.length, base64: value.toString("base64") };
  if (depth >= 6) return { type: "truncated", reason: "maximum-depth" };
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return { type: "circular" };
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 512).map((item) => serialize(item, seen, depth + 1));
  const output = {};
  for (const key of Object.keys(value).sort().slice(0, 512)) {
    try {
      output[key] = serialize(value[key], seen, depth + 1);
    } catch (error) {
      output[key] = { type: "property-error", message: error.message };
    }
  }
  return output;
}

function enumerate(value, depth = 0, seen = new WeakSet()) {
  if (value === null || !["object", "function"].includes(typeof value)) return typeof value;
  if (seen.has(value)) return "circular";
  if (depth >= 4) return typeof value;
  seen.add(value);
  const output = {};
  for (const key of Object.getOwnPropertyNames(value).sort().slice(0, 512)) {
    if (["arguments", "caller", "prototype"].includes(key)) continue;
    try {
      output[key] = enumerate(value[key], depth + 1, seen);
    } catch (error) {
      output[key] = `error:${error.message}`;
    }
  }
  return output;
}

function resolveMember(root, memberPath) {
  let owner = null;
  let value = root;
  for (const part of memberPath) {
    owner = value;
    value = value?.[part];
    if (value === undefined || value === null) {
      throw new Error(`native member is unavailable: ${memberPath.join(".")}`);
    }
  }
  return { owner, value };
}

async function main() {
  const input = fs.readFileSync(0);
  if (input.length > MAX_REQUEST_BYTES) throw new Error("native request exceeds input limit");
  const request = JSON.parse(input.toString("utf8"));
  if (typeof request.modulePath !== "string" || request.modulePath.length === 0) {
    throw new Error("modulePath is required");
  }
  const loaded = require(request.modulePath);
  if (request.action === "enumerate") {
    return { ok: true, exports: enumerate(loaded) };
  }
  if (request.action !== "call" || !Array.isArray(request.memberPath) || !Array.isArray(request.args)) {
    throw new Error("invalid native worker request");
  }
  const { owner, value } = resolveMember(loaded, request.memberPath);
  if (typeof value !== "function") throw new Error("native member is not callable");
  const result = await Promise.resolve(Reflect.apply(value, owner, request.args));
  return { ok: true, value: serialize(result) };
}

main().then(
  (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
  (error) => {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error?.message ?? String(error) })}\n`);
    process.exitCode = 1;
  },
);
