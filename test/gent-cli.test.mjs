import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gentArguments, runGent } from "../src/gent-cli.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execute = promisify(execFile);

test("flat gent commands use established agent routes without rewriting IDs or capsule paths", () => {
  for (const command of ["list", "show", "resume", "clone", "export", "import"]) {
    const args = [command, "saved-id", 'a path/$HOME;$(literal).ovm', "--json"];
    assert.deepEqual(gentArguments(args), ["agent", ...args]);
    assert.equal(args[0], command);
  }
  for (const command of ["chat", "task", "check", "setup", "agent", "network", "worker", "raw", "swarm"]) {
    const args = [command, "--literal", "a b"];
    assert.deepEqual(gentArguments(args), args);
    assert.notEqual(gentArguments(args), args);
  }
});

test("gent preserves child exit codes and existing environment contracts", async () => {
  const environment = { OVM_DISTRIBUTION_MODE: "local", OVM_SWARM_MODEL: "saved:latest" };
  let invocation;
  const code = await runGent(["resume", "original", "Print $HOME; $(literal)", "--on", "rack"], {
    root: "/project with spaces", environment,
    run: async (...args) => { invocation = args; return 130; },
  });
  assert.equal(code, 130);
  assert.deepEqual(invocation, [process.execPath, ["/project with spaces/bin/ovm", "agent", "resume", "original", "Print $HOME; $(literal)", "--on", "rack"], { env: environment }]);
});

test("help for every flat saved-gent command cannot launch or mutate an agent", async () => {
  for (const command of ["list", "show", "resume", "clone", "export", "import"]) {
    let output = "";
    assert.equal(await runGent([command, "--help"], {
      root, output: { write(text) { output += text; } },
      run: async () => assert.fail("help must not dispatch"),
    }), 0);
    assert.match(output, new RegExp(`Usage: gent ${command}`));
    assert.match(output, /\.ovm capsules/);
  }
  let forwarded;
  await runGent(["resume", "saved", "--", "--help"], { root, run: async (_file, args) => { forwarded = args; return 0; } });
  assert.deepEqual(forwarded.slice(1), ["agent", "resume", "saved", "--", "--help"]);
});

test("gent and legacy ovm entry points expose the o-gents help without booting", async () => {
  for (const executable of ["gent", "ovm"]) {
    const { stdout, stderr } = await execute(process.execPath, [path.join(root, "bin", executable), "--help"], { timeout: 10_000 });
    assert.equal(stderr, "");
    assert.match(stdout, /^o-gents/);
    assert.match(stdout, /gent show ID/);
    assert.match(stdout, /gent resume ID/);
    assert.match(stdout, /ovm commands remain available/);
  }
  const { stdout } = await execute(process.execPath, [path.join(root, "bin/gent"), "task", "--help"], { timeout: 10_000 });
  assert.match(stdout, /Usage: gent task/);
  assert.match(stdout, /--agents 3/);
});
