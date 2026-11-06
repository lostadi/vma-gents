import test from "node:test";
import assert from "node:assert/strict";
import { boundedUtf8Tail } from "../src/text.mjs";

test("bounded console tails preserve UTF-8 code-point boundaries", () => {
  const value = `prefix-${"🙂".repeat(4)}-tail`;
  const result = boundedUtf8Tail(value, 12);
  assert.equal(result.truncated, true);
  assert.equal(result.totalBytes, Buffer.byteLength(value, "utf8"));
  assert.ok(Buffer.byteLength(result.text, "utf8") <= 12);
  assert.equal(result.text.includes("�"), false);
  assert.ok(value.endsWith(result.text));
});
