import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

test("guest peer enrollment protocol and native invocation fixtures", async () => {
  await promisify(execFile)("python3", ["-B", fileURLToPath(new URL("./guest-peer.test.py", import.meta.url))], { timeout: 10_000 });
});
