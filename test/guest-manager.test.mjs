import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, cp, lstat, mkdir, mkdtemp, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { assertNoOpenBundleFiles, ensurePreparedImage, getGuestStatus, guestExportScript,
  guestProvisionScript, guestRecipeSha256, preparedImageReceiptPath, publishPreparedGuest,
  recordPreparedClone, REQUIRED_GUEST_CHECKS, runGuestsCli, upgradePreparedImage,
  validateGuestProfile, validateSmokeReport } from "../src/guest-manager.mjs";

const command = promisify(execFile);
const digest = (text) => createHash("sha256").update(text).digest("hex");
const quietLsof = async () => { throw Object.assign(new Error("no matching files"), { code: 1, stdout: "", stderr: "" }); };
const clone = async (source, destination) => copyFile(source, destination);
const smoke = () => ({ schema: "ovm.guest-smoke/v1", ok: true, architecture: "aarch64",
  checks: REQUIRED_GUEST_CHECKS.map((name) => ({ name, ok: true })),
  passed: REQUIRED_GUEST_CHECKS.length, failed: 0 });
const profile = (extra = {}) => ({ schema: "ovm.prepared-guest/v1", verified: true,
  sourceCommit: "a".repeat(40), sourceArchiveSha256: "b".repeat(64), recipeSha256: "c".repeat(64),
  rootfsSizeBytes: 8, sourceRootfsSizeBytes: 4, smoke: smoke(), ...extra });

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ovm-guest-manager-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, "project");
  const bundlePath = path.join(projectRoot, "vm/claudevm.bundle");
  const stagingBundle = path.join(projectRoot, "vm/staging.bundle");
  const sourceBundlePath = path.join(root, "original.bundle");
  const exportPath = path.join(projectRoot, "runtime/export");
  for (const directory of [bundlePath, stagingBundle, sourceBundlePath, exportPath, path.join(projectRoot, "guest")]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  for (const [directory, value] of [[sourceBundlePath, "ORIG"], [bundlePath, "OLDROOT!"], [stagingBundle, "PREPARED-ROOT"]]) {
    await writeFile(path.join(directory, "rootfs.img"), value, { mode: 0o600 });
    await writeFile(path.join(directory, "sessiondata.img"), "USER SESSION DATA", { mode: 0o600 });
    await writeFile(path.join(directory, "efivars.fd"), "FIRMWARE", { mode: 0o600 });
  }
  for (const name of ["provision.sh", "smoke.py", "ovm-guest-start", "ovm-env.sh", "ovm-guest.service", "ovm-peer", "ovm-peer-service", "upgrade.sh"]) {
    await writeFile(path.join(projectRoot, "guest", name), `fixture ${name}\n`);
  }
  const install = { schema: "ovm.guest-install/v1", verified: true, source_sha256: "b".repeat(64) };
  await writeFile(path.join(exportPath, "smoke.json"), JSON.stringify(smoke()), { mode: 0o600 });
  await writeFile(path.join(exportPath, "install.json"), JSON.stringify(install), { mode: 0o600 });
  await writeFile(path.join(exportPath, "runtime.tar.gz"), "RUNTIME", { mode: 0o600 });
  await writeFile(path.join(exportPath, "runtime.sha256"), `${digest("RUNTIME")}  runtime.tar.gz\n`, { mode: 0o600 });
  const options = { projectRoot, bundlePath, stagingBundle, sourceBundlePath, exportPath,
    sourceCommit: "a".repeat(40), sourceArchiveSha256: "b".repeat(64),
    recipeSha256: await guestRecipeSha256(projectRoot), sourceRootfsSizeBytes: 4 };
  return { ...options, options, rootfs: path.join(bundlePath, "rootfs.img"),
    manifest: path.join(bundlePath, ".ovm-guest-v1.json"), install };
}

test("guest receipts require matching sizes, provenance and complete execution evidence", () => {
  assert.equal(validateGuestProfile(profile(), { rootfsSizeBytes: 8 }).verified, true);
  for (const invalid of [profile({ verified: false }), profile({ sourceCommit: "not-a-commit" }),
    profile({ recipeSha256: "x".repeat(64) }), profile({ rootfsSizeBytes: 2 }),
    profile({ sourceRootfsSizeBytes: 0 }), profile({ smoke: { ...smoke(), ok: false } })]) {
    assert.throws(() => validateGuestProfile(invalid));
  }
  assert.throws(() => validateGuestProfile(profile(), { rootfsSizeBytes: 9 }), /does not match/);
  assert.throws(() => validateSmokeReport({ ...smoke(), checks: [], passed: 0 }), /incomplete/);
  assert.throws(() => validateSmokeReport({ ...smoke(), checks: [{ name: "version only", ok: true }], passed: 1 }), /required/);
});

test("status is read-only and tells an unprepared installation how to proceed", async (t) => {
  const f = await fixture(t);
  const status = await getGuestStatus(f);
  assert.equal(status.prepared, false);
  assert.match(status.errors.join(" "), /ovm guests setup/);
  await assert.rejects(ensurePreparedImage(f), /ovm guests setup/);
  assert.equal(await readFile(f.rootfs, "utf8"), "OLDROOT!");
});

test("status recognizes valid preparation and reports recipe changes separately", async (t) => {
  const f = await fixture(t);
  await writeFile(f.manifest, JSON.stringify(profile({ recipeSha256: f.recipeSha256 })), { mode: 0o600 });
  assert.equal((await getGuestStatus(f)).needsUpdate, false);
  await writeFile(path.join(f.projectRoot, "guest/smoke.py"), "updated verification recipe\n");
  const status = await getGuestStatus(f);
  assert.equal(status.prepared, true);
  assert.equal(status.needsUpdate, true);
});

test("portable pocket profile uses its bundled runtime without the built-in base image", async t => {
  const f = await fixture(t);
  const portable = path.join(f.projectRoot, "capsule-runtime"), pocket = path.join(f.projectRoot, "saved.rootfs.img");
  await mkdir(portable);
  await writeFile(path.join(portable, "rootfs.img"), "CAPSULE!", { mode: 0o600 });
  const receipt = profile({ recipeSha256: f.recipeSha256 });
  await writeFile(path.join(portable, ".ovm-guest-v1.json"), JSON.stringify(receipt), { mode: 0o600 });
  await writeFile(pocket, "PERSONAL", { mode: 0o600 });
  await writeFile(preparedImageReceiptPath(pocket), JSON.stringify(receipt), { mode: 0o600 });
  await rm(f.bundlePath, { recursive: true });
  const result = await upgradePreparedImage({ projectRoot: f.projectRoot, bundlePath: portable, rootfsPath: pocket, stateDirectory: f.projectRoot }, {
    run: async () => assert.fail("a matching offline capsule must not provision or download"),
  });
  assert.equal(result.changed, false);
  assert.equal(await readFile(pocket, "utf8"), "PERSONAL");
});

test("lsof accepts only an empty, diagnostic-free result as an unused image", async () => {
  await assertNoOpenBundleFiles("/test/bundle", { command: quietLsof });
  await assert.rejects(assertNoOpenBundleFiles("/test/bundle", {
    command: async () => { throw Object.assign(new Error("permission denied"), { code: 1, stdout: "", stderr: "permission denied" }); },
  }), /Cannot establish/);
  await assert.rejects(assertNoOpenBundleFiles("/test/bundle", {
    command: async () => ({ stdout: "123\n456\n", stderr: "" }),
  }), /123, 456/);
});

test("publication preserves original source, session data and a rollback image", async (t) => {
  const f = await fixture(t);
  const result = await publishPreparedGuest(f.options, { clone, command: quietLsof });
  assert.equal(await readFile(f.rootfs, "utf8"), "PREPARED-ROOT");
  assert.equal(await readFile(path.join(f.bundlePath, "sessiondata.img"), "utf8"), "USER SESSION DATA");
  assert.equal(await readFile(path.join(f.sourceBundlePath, "rootfs.img"), "utf8"), "ORIG");
  assert.equal(await readFile(path.join(result.backupDirectory, "rootfs.img"), "utf8"), "OLDROOT!");
  assert.equal((await getGuestStatus(f)).prepared, true);
  await assert.rejects(lstat(`${f.bundlePath}.mcp.lease`), { code: "ENOENT" });
});

test("failed smoke evidence cannot replace a working disk", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.exportPath, "smoke.json"), JSON.stringify({ ...smoke(), ok: false }));
  await assert.rejects(publishPreparedGuest(f.options, { clone, command: quietLsof }), /smoke evidence/);
  assert.equal(await readFile(f.rootfs, "utf8"), "OLDROOT!");
});

test("publication rejects mismatched installed source and corrupted runtime exports", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.exportPath, "install.json"), JSON.stringify({ ...f.install, source_sha256: "d".repeat(64) }));
  await assert.rejects(publishPreparedGuest(f.options, { clone, command: quietLsof }), /archived source/);
  await writeFile(path.join(f.exportPath, "install.json"), JSON.stringify(f.install));
  await writeFile(path.join(f.exportPath, "runtime.tar.gz"), "CORRUPTED");
  await assert.rejects(publishPreparedGuest(f.options, { clone, command: quietLsof }), /SHA-256/);
  assert.equal(await readFile(f.rootfs, "utf8"), "OLDROOT!");
});

test("publication refuses the original bundle and an aliased staging image", async (t) => {
  const f = await fixture(t);
  await assert.rejects(publishPreparedGuest({ ...f.options, bundlePath: f.sourceBundlePath }, { clone, command: quietLsof }), /never Claude's original/);
  await assert.rejects(publishPreparedGuest({ ...f.options, stagingBundle: f.bundlePath }, { clone, command: quietLsof }), /aliases/);
});

test("an open image prevents replacement and releases the attempted lease", async (t) => {
  const f = await fixture(t);
  await assert.rejects(publishPreparedGuest(f.options, {
    clone, command: async () => ({ stdout: "9876\n", stderr: "" }),
  }), /9876/);
  assert.equal(await readFile(f.rootfs, "utf8"), "OLDROOT!");
  await assert.rejects(lstat(`${f.bundlePath}.mcp.lease`), { code: "ENOENT" });
});

test("a root disk modified during staging is preserved instead of overwritten", async (t) => {
  const f = await fixture(t);
  await assert.rejects(publishPreparedGuest(f.options, {
    command: quietLsof,
    clone: async (source, destination) => {
      await copyFile(source, destination);
      if (destination.includes(".rootfs-prepared-")) await writeFile(f.rootfs, "USER CHANGED THE ROOT");
    },
  }), /changed during guest publication/);
  assert.equal(await readFile(f.rootfs, "utf8"), "USER CHANGED THE ROOT");
});

test("receipt publication failure restores the previous disk and receipt", async (t) => {
  const f = await fixture(t);
  const previousReceipt = JSON.stringify(profile());
  await writeFile(f.manifest, previousReceipt, { mode: 0o600 });
  await assert.rejects(publishPreparedGuest(f.options, {
    clone, command: quietLsof,
    move: async (source, destination) => {
      if (source.includes(".guest-receipt-")) throw new Error("injected receipt rename failure");
      await rename(source, destination);
    },
  }), /injected receipt rename failure/);
  assert.equal(await readFile(f.rootfs, "utf8"), "OLDROOT!");
  assert.equal(await readFile(f.manifest, "utf8"), previousReceipt);
});

test("generated provisioning and export scripts parse without executing a VM", async () => {
  for (const script of [guestProvisionScript(), guestExportScript(), guestExportScript({ includeRuntime: false })]) {
    const child = execFile("bash", ["-n"]);
    child.stdin.end(script);
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`bash -n exited ${code}`)));
    });
  }
  assert.match(guestProvisionScript(), /findmnt -n -o SOURCE/);
  assert.match(guestProvisionScript(), /blkid -L sessions/);
  assert.doesNotMatch(guestExportScript(), /^usr\s*$/m);
  assert.match(guestExportScript(), /usr\/local\/bin\/ovm-peer/);
  assert.match(guestExportScript(), /usr\/local\/sbin\/ovm-peer-service/);
});

test("known prepared clones retain their receipt across normal rootfs inode replacement", async (t) => {
  const f = await fixture(t);
  const pocket = path.join(f.projectRoot, "vm/pocket.img");
  await copyFile(f.rootfs, pocket);
  const inherited = profile({ recipeSha256: f.recipeSha256,
    runtimeArchive: { path: path.join(f.exportPath, "runtime.tar.gz"), sha256: digest("RUNTIME") } });
  await writeFile(f.manifest, JSON.stringify(inherited), { mode: 0o600 });
  await recordPreparedClone({ rootfsPath: pocket, profile: inherited });
  const replacement = `${pocket}.new`;
  await writeFile(replacement, "USERDATA", { mode: 0o600 });
  await rename(replacement, pocket);
  const result = await upgradePreparedImage({ projectRoot: f.projectRoot, rootfsPath: pocket }, {
    run: async () => assert.fail("a known prepared image must not be booted for migration"),
  });
  assert.equal(result.changed, false);
  assert.equal(await readFile(pocket, "utf8"), "USERDATA");
});

test("known prepared pockets in a custom state directory do not need migration", async (t) => {
  const f = await fixture(t);
  const directory = path.join(path.dirname(f.projectRoot), "custom-pockets");
  await mkdir(directory, { mode: 0o700 });
  const pocket = path.join(directory, "agent.rootfs.img");
  await copyFile(f.rootfs, pocket);
  const inherited = profile({ recipeSha256: f.recipeSha256 });
  await writeFile(f.manifest, JSON.stringify(inherited), { mode: 0o600 });
  await recordPreparedClone({ rootfsPath: pocket, profile: inherited });
  const result = await upgradePreparedImage({ projectRoot: f.projectRoot, rootfsPath: pocket }, {
    run: async () => assert.fail("verified custom-state pocket must not be migrated"),
  });
  assert.equal(result.changed, false);
});

test("legacy upgrade starts from the existing pocket and retains its previous disk", async (t) => {
  const f = await fixture(t);
  const pocket = path.join(f.projectRoot, "vm/pocket.img");
  await writeFile(pocket, "USER-PERSIST", { mode: 0o600 });
  const inherited = profile({ recipeSha256: f.recipeSha256,
    runtimeArchive: { path: path.join(f.exportPath, "runtime.tar.gz"), sha256: digest("RUNTIME") } });
  await writeFile(f.manifest, JSON.stringify(inherited), { mode: 0o600 });
  const result = await upgradePreparedImage({ projectRoot: f.projectRoot, rootfsPath: pocket }, {
    clone, command: quietLsof,
    cloneBundle: async (_root, destination) => cp(f.bundlePath, destination, { recursive: true }),
    run: async ({ bundlePath, exportShare, script }) => {
      assert.match(script, /upgrade\.sh/);
      const image = path.join(bundlePath, "rootfs.img");
      const handle = await open(image, "r");
      try {
        const buffer = Buffer.alloc(12);
        await handle.read(buffer, 0, buffer.length, 0);
        assert.equal(buffer.toString(), "USER-PERSIST");
      } finally { await handle.close(); }
      await writeFile(image, "USER-PERSIST WITH OSTADIX", { mode: 0o600 });
      await writeFile(path.join(exportShare, "smoke.json"), JSON.stringify(smoke()), { mode: 0o600 });
      await writeFile(path.join(exportShare, "install.json"), JSON.stringify(f.install), { mode: 0o600 });
    },
  });
  assert.equal(result.changed, true);
  assert.equal(await readFile(pocket, "utf8"), "USER-PERSIST WITH OSTADIX");
  assert.equal(await readFile(path.join(result.backupDirectory, "rootfs.img"), "utf8"), "USER-PERSIST");
  assert.equal(JSON.parse(await readFile(preparedImageReceiptPath(pocket), "utf8")).verified, true);
  assert.equal(await readFile(path.join(f.bundlePath, "sessiondata.img"), "utf8"), "USER SESSION DATA");
});

test("guest CLI status JSON stays machine-readable and setup receives explicit arguments", async () => {
  let stdout = "", stderr = "", received;
  const io = { projectRoot: "/project", output: { write: (text) => { stdout += text; } },
    progress: { write: (text) => { stderr += text; } } };
  assert.equal(await runGuestsCli(["status", "--json"], { ...io, status: async () => ({ prepared: false, errors: ["setup needed"] }) }), 2);
  assert.equal(JSON.parse(stdout).prepared, false);
  stdout = "";
  await runGuestsCli(["setup", "--source", "/clean/source", "--force", "--json"], {
    ...io, setup: async (options) => { received = options; options.onOutput("building\n"); return { changed: true, prepared: true }; },
  });
  assert.equal(received.sourceRoot, "/clean/source");
  assert.equal(received.force, true);
  assert.equal(JSON.parse(stdout).prepared, true);
  assert.equal(stderr, "building\n");
  await assert.rejects(runGuestsCli(["status", "--force"], io), /Unknown or incomplete option/);
});
