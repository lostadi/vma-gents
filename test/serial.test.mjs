import test from "node:test";
import assert from "node:assert/strict";
import { SerialExecutor } from "../src/serial.mjs";

test("lifecycle operations never overlap", async () => {
  const executor = new SerialExecutor();
  let active = 0;
  let maximumActive = 0;
  const run = () => executor.run(async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
  });

  await Promise.all([run(), run(), run()]);
  assert.equal(maximumActive, 1);
});
