import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);

test("guest NAT routing uses the current DHCP lease and preserves private links", async () => {
  await execute("python3", [fileURLToPath(new URL("./guest-routing.test.py", import.meta.url))], {
    timeout: 10_000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
});
