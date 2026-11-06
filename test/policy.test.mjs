import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPolicy, validateInvocation } from "../src/policy.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("policy accepts a bounded diagnostic invocation", async () => {
  const policy = await loadPolicy(path.join(projectRoot, "policy.json"));
  assert.equal(policy.networkMode, "nat");
  assert.equal(policy.startupTimeoutSeconds, 120);
  assert.equal(policy.defaultTimeoutSeconds, 10);
  assert.equal(policy.maximumTimeoutSeconds, 30);
  assert.equal(policy.maximumOutputBytes, 32 * 1024);
  assert.deepEqual(validateInvocation(policy, "uname", ["-m"], 5), {
    command: "/usr/bin/uname",
    args: ["-m"],
    cwd: "/",
    env: {
      HOME: "/nonexistent",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
    },
    timeoutSeconds: 5,
  });
});

test("policy rejects a shell and any argv tuple not listed exactly", async () => {
  const policy = await loadPolicy(path.join(projectRoot, "policy.json"));
  assert.throws(() => validateInvocation(policy, "bash", ["-c"], 5), /not allowlisted/);
  assert.throws(() => validateInvocation(policy, "uname", ["--help"], 5), /argv is not allowlisted/);
  assert.throws(() => validateInvocation(policy, "uname", ["-m", "-r"], 5), /argv is not allowlisted/);
  assert.throws(() => validateInvocation(policy, "id", ["-u", "-u"], 5), /argv is not allowlisted/);
});

test("owner policy cannot expand the immutable program, path, or argv ceiling", async () => {
  const original = JSON.parse(await (await import("node:fs/promises")).readFile(path.join(projectRoot, "policy.json"), "utf8"));
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const os = await import("node:os");
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "claude-vm-policy-ceiling-"));
  const temporaryPolicy = path.join(temporaryRoot, "policy.json");
  try {
    await writeFile(temporaryPolicy, JSON.stringify({
      ...original,
      programs: {
        ...original.programs,
        shell: { path: "/bin/sh", allowedArgv: [["-c", "id"]] },
      },
    }), { mode: 0o600 });
    await assert.rejects(() => loadPolicy(temporaryPolicy), /not in the built-in guest allowlist/);

    await writeFile(temporaryPolicy, JSON.stringify({
      ...original,
      programs: {
        ...original.programs,
        uname: { ...original.programs.uname, path: "/bin/sh" },
      },
    }), { mode: 0o600 });
    await assert.rejects(() => loadPolicy(temporaryPolicy), /path does not match the built-in allowlist/);

    await writeFile(temporaryPolicy, JSON.stringify({
      ...original,
      programs: {
        ...original.programs,
        uname: {
          ...original.programs.uname,
          allowedArgv: [...original.programs.uname.allowedArgv.slice(0, -1), ["--help"]],
        },
      },
    }), { mode: 0o600 });
    await assert.rejects(() => loadPolicy(temporaryPolicy), /argv exceeds the built-in allowlist/);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("owner policy may narrow but cannot raise timeout or output hard caps", async () => {
  const original = JSON.parse(await (await import("node:fs/promises")).readFile(path.join(projectRoot, "policy.json"), "utf8"));
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const os = await import("node:os");
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "claude-vm-policy-limits-"));
  const temporaryPolicy = path.join(temporaryRoot, "policy.json");
  try {
    await writeFile(temporaryPolicy, JSON.stringify({
      ...original,
      maximumTimeoutSeconds: 31,
    }), { mode: 0o600 });
    await assert.rejects(() => loadPolicy(temporaryPolicy), /maximumTimeoutSeconds must be an integer between 1 and 30/);

    await writeFile(temporaryPolicy, JSON.stringify({
      ...original,
      maximumOutputBytes: 32 * 1024 + 1,
    }), { mode: 0o600 });
    await assert.rejects(() => loadPolicy(temporaryPolicy), /maximumOutputBytes must be an integer between 1 and 32768/);

    const narrowed = {
      ...original,
      defaultTimeoutSeconds: 5,
      maximumTimeoutSeconds: 5,
      maximumOutputBytes: 4096,
      programs: {
        uname: { path: "/usr/bin/uname", allowedArgv: [["-m"]] },
      },
    };
    await writeFile(temporaryPolicy, JSON.stringify(narrowed), { mode: 0o600 });
    const policy = await loadPolicy(temporaryPolicy);
    assert.deepEqual(Object.keys(policy.programs), ["uname"]);
    assert.deepEqual(policy.programs.uname.allowedArgv, [["-m"]]);
    assert.equal(policy.maximumTimeoutSeconds, 5);
    assert.equal(policy.maximumOutputBytes, 4096);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("policy caps execution time", async () => {
  const policy = await loadPolicy(path.join(projectRoot, "policy.json"));
  assert.throws(
    () => validateInvocation(policy, "id", [], policy.maximumTimeoutSeconds + 1),
    /timeoutSeconds/,
  );
});

test("guest execution policy accepts NAT and explicit isolation and rejects unknown modes", async () => {
  const original = JSON.parse(await (await import("node:fs/promises")).readFile(path.join(projectRoot, "policy.json"), "utf8"));
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const os = await import("node:os");
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "claude-vm-policy-"));
  const temporaryPolicy = path.join(temporaryRoot, "policy.json");
  try {
    for (const networkMode of ["none", "bridged", "invalid"]) {
      await writeFile(temporaryPolicy, JSON.stringify({ ...original, networkMode }));
      await assert.rejects(() => loadPolicy(temporaryPolicy), /requires networkMode to be nat or isolated/);
    }
    for (const networkMode of ["nat", "isolated"]) {
      await writeFile(temporaryPolicy, JSON.stringify({ ...original, networkMode }));
      assert.equal((await loadPolicy(temporaryPolicy)).networkMode, networkMode);
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("policy rejects caller-configurable execution fields", async () => {
  const original = JSON.parse(await (await import("node:fs/promises")).readFile(path.join(projectRoot, "policy.json"), "utf8"));
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const os = await import("node:os");
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "claude-vm-policy-fields-"));
  const temporaryPolicy = path.join(temporaryRoot, "policy.json");
  try {
    await writeFile(temporaryPolicy, JSON.stringify({ ...original, env: { TOKEN: "forbidden" } }), { mode: 0o600 });
    await assert.rejects(() => loadPolicy(temporaryPolicy), /unsupported top-level field/);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("policy rejects a symlink and group-writable policy file", async () => {
  const { chmod, mkdtemp, rm, symlink, writeFile } = await import("node:fs/promises");
  const os = await import("node:os");
  const original = await (await import("node:fs/promises")).readFile(path.join(projectRoot, "policy.json"), "utf8");
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "claude-vm-policy-mode-"));
  const regularPolicy = path.join(temporaryRoot, "policy.json");
  const linkedPolicy = path.join(temporaryRoot, "linked.json");
  try {
    await writeFile(regularPolicy, original, { mode: 0o600 });
    await symlink(regularPolicy, linkedPolicy);
    await assert.rejects(() => loadPolicy(linkedPolicy), /regular, non-symlink/);
    await chmod(regularPolicy, 0o620);
    await assert.rejects(() => loadPolicy(regularPolicy), /writable by group or other/);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
