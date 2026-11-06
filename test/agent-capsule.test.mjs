import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, open, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CAPSULE_MAGIC, cloneAgentCapsule, estimateCapsuleImportBudget, exportAgentCapsule, importAgentCapsule, inspectAgent, inspectAgentCapsule, listAgents, ollamaManifestRelative, runAgentCommand, validateCapsuleManifest } from "../src/agent-capsule.mjs";
import { VMLease } from "../src/lease.mjs";
import { AgentArtifactStore } from "../src/agent-artifacts.mjs";
import { PocketSwarm } from "../src/pocket-swarm.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ovm-capsule-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateRoot = path.join(root, "vm/pockets");
  const directory = path.join(stateRoot, "original");
  const bundle = path.join(root, "vm/claudevm.bundle");
  const modelsRoot = path.join(root, "models");
  for (const folder of [directory, bundle, path.join(root, "host"), path.join(modelsRoot, "blobs"), path.join(modelsRoot, "manifests/registry.ollama.ai/library/test-model")]) await mkdir(folder, { recursive: true });
  const profile = { schema: "ovm.prepared-guest/v1", verified: true, sourceCommit: "test-source", rootfsSizeBytes: 8 * 1024 * 1024, smoke: { passed: 47 } };
  await writeFile(path.join(bundle, ".ovm-guest-v1.json"), JSON.stringify(profile));
  const disk = await open(path.join(directory, "builder.rootfs.img"), "wx");
  await disk.write(Buffer.from("PERSONAL-VM-DATA"), 0, 16, 3 * 1024 * 1024);
  await disk.truncate(8 * 1024 * 1024); await disk.close();
  await writeFile(path.join(directory, "builder.rootfs.img.ovm-guest-v1.json"), JSON.stringify(profile));
  await writeFile(path.join(bundle, "vmlinuz"), "private-kernel");
  await writeFile(path.join(bundle, "initrd"), "private-initrd");
  await writeFile(path.join(bundle, "rootfs.img"), "unused-base");
  const session = await open(path.join(bundle, "sessiondata.img"), "wx"); await session.truncate(1024 * 1024); await session.close();
  await writeFile(path.join(root, "host/smol-bin.arm64.img"), "private-helper");
  const config = Buffer.from('{"architecture":"test"}');
  const weights = Buffer.from("OFFLINE-MODEL-WEIGHTS-".repeat(400));
  const template = Buffer.from("{{ .Prompt }}");
  const blobs = [config, weights, template].map((bytes) => ({ bytes, digest: `sha256:${digest(bytes)}`, size: bytes.length }));
  for (const blob of blobs) await writeFile(path.join(modelsRoot, "blobs", blob.digest.replace(":", "-")), blob.bytes);
  const modelManifest = { schemaVersion: 2, config: { digest: blobs[0].digest, size: config.length }, layers: [
    { mediaType: "application/vnd.ollama.image.model", digest: blobs[1].digest, size: weights.length },
    { mediaType: "application/vnd.ollama.image.template", digest: blobs[2].digest, size: template.length },
  ] };
  await writeFile(path.join(modelsRoot, "manifests/registry.ollama.ai/library/test-model/latest"), JSON.stringify(modelManifest));
  const state = { protocol: "ovm.agent-pocket/v1", swarmId: "original", mission: "preserve my personal agent", round: 2, maximumRounds: 4, maximumAgents: 2,
    agents: [{ id: "builder", role: "build", parentId: null, inheritRootfs: null, finished: false, rounds: 2 }, { id: "child", role: "verify", parentId: "builder", inheritRootfs: path.join(directory, "builder.rootfs.img"), finished: false }],
    messages: [{ id: "message-1", from: "builder", to: "child", message: "keep this exact memory" }],
    transcript: [{ round: 1, agentId: "builder", model: "test-model:latest", observation: { vm: { exitCode: 0, output: "history survives" } } }],
  };
  const stateBytes = `${JSON.stringify(state, null, 2)}\n`;
  await writeFile(path.join(directory, "swarm.json"), stateBytes);
  const options = { projectRoot: root, stateRoot, modelsRoot, agentId: "original", assertUnused: async () => {}, reserveBytes: 0 };
  return { root, stateRoot, directory, bundle, modelsRoot, state, stateBytes, profile, options, blobs, archivePath: path.join(root, "personal.ovm") };
}

async function rewriteManifest(source, destination, mutate) {
  const bytes = await readFile(source);
  const originalLength = Number(bytes.readBigUInt64BE(CAPSULE_MAGIC.length));
  const headerStart = CAPSULE_MAGIC.length + 8;
  const manifest = JSON.parse(bytes.subarray(headerStart, headerStart + originalLength));
  mutate(manifest);
  const header = Buffer.from(JSON.stringify(manifest));
  const size = Buffer.alloc(8); size.writeBigUInt64BE(BigInt(header.length));
  await writeFile(destination, Buffer.concat([CAPSULE_MAGIC, size, header, bytes.subarray(headerStart + originalLength)]));
}

for (const directoryPresent of [false, true]) {
  test(`missing saved agent gives creation guidance without writes (${directoryPresent ? "directory has no saved state" : "state root absent"})`, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ovm-missing-agent-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const stateRoot = path.join(root, "vm/pockets");
    const directory = path.join(stateRoot, "hello-work");
    if (directoryPresent) {
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "keep.txt"), "unrelated data must remain");
    }
    const before = (await readdir(root, { recursive: true })).sort();
    for (const args of [
      ["show", "hello-work"],
      ["export", "hello-work", path.join(root, "new-output/nested/hello.ovm")],
      ["clone", "hello-work", "hello-experiment"],
    ]) {
      await assert.rejects(runAgentCommand(args, { projectRoot: root, stateRoot }), error => {
        assert.equal(error.code, "ENOENT");
        assert.equal(error.cause.code, "ENOENT");
        assert.match(error.message, /No saved gent "hello-work"/);
        assert.match(error.message, /gent list/);
        assert.match(error.message, /gent chat --swarm-id hello-work/);
        assert.match(error.message, /then send a message/);
        assert.match(error.message, /opening chat alone does not save/);
        return true;
      });
      assert.deepEqual((await readdir(root, { recursive: true })).sort(), before, `${args[0]} must not create source, clone, output, lease, or temporary paths`);
    }
    if (directoryPresent) assert.equal(await readFile(path.join(directory, "keep.txt"), "utf8"), "unrelated data must remain");
  });
}

test("agent inspection preserves corrupt state and symlink diagnostics", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ovm-invalid-agent-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { projectRoot: root, stateRoot: root };
  const corrupt = path.join(root, "corrupt"); await mkdir(corrupt);
  await writeFile(path.join(corrupt, "swarm.json"), "not JSON");
  await assert.rejects(inspectAgent({ ...options, agentId: "corrupt" }), error => error instanceof SyntaxError && !error.message.includes("No saved gent"));
  await writeFile(path.join(corrupt, "swarm.json"), JSON.stringify({ protocol: "unsupported", agents: [] }));
  await assert.rejects(inspectAgent({ ...options, agentId: "corrupt" }), /Unsupported or empty gent state/);
  await symlink(path.join(root, "absent-target"), path.join(root, "linked-directory"));
  await assert.rejects(inspectAgent({ ...options, agentId: "linked-directory" }), /Gent directory must be a real directory/);
  const linkedState = path.join(root, "linked-state"); await mkdir(linkedState);
  await symlink(path.join(root, "absent-state"), path.join(linkedState, "swarm.json"));
  await assert.rejects(inspectAgent({ ...options, agentId: "linked-state" }), /Expected a bounded regular file/);
});

test("agent inspection preserves permission failures instead of calling the agent missing", {
  skip: process.getuid?.() === 0 ? "root bypasses ordinary file read permissions" : false,
}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ovm-agent-permission-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "private"); await mkdir(directory);
  const statePath = path.join(directory, "swarm.json");
  await writeFile(statePath, JSON.stringify({ protocol: "ovm.agent-pocket/v1", agents: [{ id: "builder" }] }));
  await chmod(statePath, 0);
  try {
    await assert.rejects(inspectAgent({ projectRoot: root, stateRoot: root, agentId: "private" }), error => error.code === "EACCES" && !error.message.includes("No saved gent"));
  } finally { await chmod(statePath, 0o600); }
});

test("portable capsule retains VM bytes, full history, offline model closure, and unique replica identity", async (t) => {
  const f = await fixture(t);
  const exported = await exportAgentCapsule({ ...f.options, outputPath: f.archivePath });
  assert.equal(exported.weightsIncluded, true);
  assert.ok((await stat(f.archivePath)).size < 300_000, "sparse/compressible guest disks should not materialize their logical size");
  const inspect = await inspectAgentCapsule({ archivePath: f.archivePath });
  assert.equal(inspect.manifest.model.blobs.length, 3);
  assert.equal(inspect.manifest.capabilities.hostNativeProvidersIncluded, false);
  assert.equal(inspect.manifest.network.controllerCredentialsIncluded, false);
  const importedModels = path.join(f.root, "new-model-store");
  const restored = await importAgentCapsule({ ...f.options, archivePath: f.archivePath, agentId: "replica", modelsRoot: importedModels });
  assert.notEqual(restored.instanceId, restored.sourceInstanceId);
  assert.equal(restored.modelInstalled, true);
  assert.equal(restored.weightsPublished, true);
  assert.equal(restored.inferenceReady, false);
  assert.equal(restored.privateModelsPath, path.join(restored.directory, "capsule-models"));
  assert.equal(restored.guestIdentityStateSanitized, false);
  const state = JSON.parse(await readFile(restored.statePath, "utf8"));
  assert.equal(state.swarmId, "replica");
  assert.deepEqual(state.messages, f.state.messages);
  assert.deepEqual(state.transcript, f.state.transcript);
  assert.equal(state.agents[1].inheritRootfs, path.join(restored.directory, "builder.rootfs.img"));
  assert.equal(await readFile(restored.originalHistoryPath, "utf8"), f.stateBytes);
  for (const id of ["builder", "child"]) {
    const bytes = await readFile(path.join(restored.directory, `${id}.rootfs.img`));
    assert.equal(bytes.length, 8 * 1024 * 1024);
    assert.equal(bytes.subarray(3 * 1024 * 1024, 3 * 1024 * 1024 + 16).toString(), "PERSONAL-VM-DATA");
  }
  assert.equal(await readFile(path.join(restored.bundlePath, "vmlinuz"), "utf8"), "private-kernel");
  assert.equal((await stat(path.join(restored.bundlePath, "sessiondata.img"))).size, 1024 * 1024);
  assert.ok((await readFile(path.join(restored.bundlePath, "sessiondata.img"))).every((byte) => byte === 0));
  for (const blob of f.blobs) assert.deepEqual(await readFile(path.join(importedModels, "blobs", blob.digest.replace(":", "-"))), blob.bytes);
  assert.equal(await readFile(path.join(f.directory, "swarm.json"), "utf8"), f.stateBytes, "source must be untouched");
  assert.equal((await listAgents(f.options)).length, 2);
  const second = await importAgentCapsule({ ...f.options, archivePath: f.archivePath, agentId: "replica-two" });
  assert.notEqual(second.instanceId, restored.instanceId);
  assert.equal(second.lineageId, restored.lineageId);
});

test("QEMU-only capsules round-trip without Apple helper or source session disk", async t => {
  const f = await fixture(t);
  await rm(path.join(f.root, "host/smol-bin.arm64.img"));
  await rm(path.join(f.bundle, "sessiondata.img"));
  await exportAgentCapsule({ ...f.options, outputPath: f.archivePath });
  const { manifest } = await inspectAgentCapsule({ archivePath: f.archivePath });
  assert.equal(manifest.runtime.helperPath, null);
  assert.deepEqual(manifest.capabilities.supportedBackends, ["qemu-arm64"]);
  assert.equal(manifest.files.some(file => file.path === "runtime/smol-bin.arm64.img"), false);
  assert.equal(manifest.runtime.sessionDiskBytes, 10 * 1024 ** 3);
  const restored = await importAgentCapsule({ ...f.options, archivePath: f.archivePath, agentId: "qemu-replica", installModel: false });
  assert.equal(restored.helperPath, null);
  const session = await stat(path.join(restored.bundlePath, "sessiondata.img"));
  assert.equal(session.size, 10 * 1024 ** 3); assert.ok(session.blocks * 512 < 1024 * 1024);
  assert.equal((await readdir(restored.bundlePath)).includes("smol-bin.arm64.img"), false);
  const second = path.join(f.root, "qemu-reexport.ovm");
  await exportAgentCapsule({ ...f.options, agentId: restored.agentId, outputPath: second });
  assert.deepEqual((await inspectAgentCapsule({ archivePath: second })).manifest.capabilities.supportedBackends, ["qemu-arm64"]);
  await assert.rejects(exportAgentCapsule({ ...f.options, helperPath: "/missing-explicit-helper", outputPath: path.join(f.root, "bad.ovm") }), /Mapped capsule helper is missing/);
});

test("old v1 Apple capability metadata remains readable while mapped helpers stay mandatory", async t => {
  const f = await fixture(t);
  await exportAgentCapsule({ ...f.options, outputPath: f.archivePath });
  const legacy = path.join(f.root, "legacy.ovm");
  await rewriteManifest(f.archivePath, legacy, manifest => {
    manifest.capabilities = { guestArchitecture: "aarch64", guestOperatingSystem: "linux", vmBackend: "apple-virtualization", requiredHost: "Apple Silicon macOS 14+ with OVM", hostNativeProvidersIncluded: false };
  });
  const result = await importAgentCapsule({ ...f.options, archivePath: legacy, agentId: "old-v1", installModel: false });
  assert.equal(await readFile(result.helperPath, "utf8"), "private-helper");
  const { manifest } = await inspectAgentCapsule({ archivePath: legacy });
  const missing = structuredClone(manifest); missing.files = missing.files.filter(file => file.path !== missing.runtime.helperPath);
  assert.throws(() => validateCapsuleManifest(missing), /missing required/);
  const unmapped = structuredClone(manifest); unmapped.runtime.helperPath = null;
  assert.throws(() => validateCapsuleManifest(unmapped), /unexpected/);
});

test("private-model CLI import retains every weight without changing a conflicting host model tag", async t => {
  const f = await fixture(t);
  await exportAgentCapsule({ ...f.options, outputPath: f.archivePath });
  const tag = path.join(f.modelsRoot, ollamaManifestRelative("test-model:latest"));
  await writeFile(tag, "HOST-TAG-MUST-STAY");
  let text = "";
  await runAgentCommand(["import", "--private-model", f.archivePath, "private-replica", "--json"], { ...f.options, output: { write(chunk) { text += chunk; } } });
  const imported = JSON.parse(text);
  assert.equal(imported.modelInstalled, false); assert.equal(imported.modelStorePublished, false);
  assert.equal(imported.weightsIncluded, true); assert.equal(imported.weightsPublished, true); assert.equal(imported.inferenceReady, false);
  assert.equal(await readFile(tag, "utf8"), "HOST-TAG-MUST-STAY");
  for (const blob of f.blobs) assert.deepEqual(await readFile(path.join(imported.privateModelsPath, "blobs", blob.digest.replace(":", "-"))), blob.bytes);
  const receipt = JSON.parse(await readFile(path.join(imported.directory, "capsule.json")));
  assert.equal(receipt.privateModelsPath, imported.privateModelsPath); assert.equal(receipt.inferenceReady, false);
  await assert.rejects(runAgentCommand(["export", "original", "/unused", "--private-model"], f.options), /available for gent import/);
});

test("Linux import budgets include non-reflink base and missing model copies without overcounting macOS or cached weights", async t => {
  const f = await fixture(t);
  await exportAgentCapsule({ ...f.options, outputPath: f.archivePath });
  const { manifest, sizes } = await inspectAgentCapsule({ archivePath: f.archivePath });
  const baseBytes = manifest.files.find(file => file.path === manifest.runtime.baseRootfsPath).extents.reduce((total, extent) => total + extent[1], 0);
  const modelBytes = manifest.files.filter(file => file.path.startsWith("model/")).reduce((total, file) => total + file.size, 0);
  const options = { stateRoot: f.stateRoot, modelsRoot: path.join(f.root, "new-global-store"), platform: "linux", canReflink: async () => false };
  const ordinary = await estimateCapsuleImportBudget(manifest, sizes, options);
  assert.equal(ordinary.extraBaseBytes, baseBytes); assert.equal(ordinary.extraModelBytes, modelBytes);
  assert.equal(ordinary.stateDirectoryBytes, sizes.materializedBytes + baseBytes + modelBytes);
  assert.equal(ordinary.modelDirectoryBytes, 0);
  const privateOnly = await estimateCapsuleImportBudget(manifest, sizes, { ...options, installModel: false });
  assert.equal(privateOnly.stateDirectoryBytes, sizes.materializedBytes + baseBytes); assert.equal(privateOnly.extraModelBytes, 0);
  const cached = await estimateCapsuleImportBudget(manifest, sizes, { ...options, modelsRoot: f.modelsRoot });
  assert.equal(cached.extraModelBytes, 0);
  const reflink = await estimateCapsuleImportBudget(manifest, sizes, { ...options, canReflink: async () => true });
  assert.equal(reflink.stateDirectoryBytes, sizes.materializedBytes);
  const differentFilesystem = await estimateCapsuleImportBudget(manifest, sizes, { ...options, canReflink: async () => true,
    metadata: async directory => ({ dev: directory === f.stateRoot ? 1 : 2 }) });
  assert.equal(differentFilesystem.stateDirectoryBytes, sizes.materializedBytes);
  assert.equal(differentFilesystem.modelDirectoryBytes, modelBytes);
  assert.equal(differentFilesystem.modelBudgetDirectory, f.root);
  const mac = await estimateCapsuleImportBudget(manifest, sizes, { ...options, platform: "darwin", canReflink: () => assert.fail("macOS keeps its COW-friendly admission") });
  assert.equal(mac.stateDirectoryBytes, sizes.materializedBytes);
});

test("capsules preserve pending publication, claim review, and scoped source evidence without inventing new provenance", async (t) => {
  const f = await fixture(t);
  f.state.agents[0].pendingActions = [{ id: "queued-publication", action: { type: "publish", path: "/root/result", name: "result" }, requires: "vm-success", queuedAgainst: "original:builder:1:vm", createdRound: 1 }];
  f.state.agents[0].pendingClaims = [{ id: "pending-report", kind: "report", to: "child", message: "Proposed claim awaiting review", queuedAgainst: "original:builder:1:vm", status: "needs-observation-review" }];
  f.state.sourceFacts = [{ evidenceId: "original:builder:1:source:0", producer: "builder", round: 1, path: "/root/input", scope: "guest", kind: "source_absent", environment: { pocket: "builder", machine: "source-machine" }, semanticVerification: false }];
  await writeFile(path.join(f.directory, "swarm.json"), JSON.stringify(f.state));
  const restored = await cloneAgentCapsule({ ...f.options, newId: "queued-replica" });
  const imported = JSON.parse(await readFile(restored.statePath, "utf8"));
  assert.equal(imported.swarmId, "queued-replica");
  assert.deepEqual(imported.agents[0].pendingActions, f.state.agents[0].pendingActions);
  assert.deepEqual(imported.agents[0].pendingClaims, f.state.agents[0].pendingClaims);
  assert.deepEqual(imported.sourceFacts, f.state.sourceFacts, "old machine/round evidence must not become a new independent observation");
});

test("snapshot refuses live or stale leases and refuses open disk files", async (t) => {
  const f = await fixture(t);
  const lease = new VMLease(path.join(f.directory, ".controller.lease"));
  await lease.acquire();
  await assert.rejects(exportAgentCapsule({ ...f.options, outputPath: f.archivePath }), /active.*lease/);
  await lease.release();
  await assert.rejects(exportAgentCapsule({ ...f.options, outputPath: f.archivePath, assertUnused: async () => { throw new Error("VM files are open"); } }), /files are open/);
  assert.equal((await readdir(f.directory)).includes(".controller.lease"), false);
});

test("unresolved remote dispatch cannot be exported or cloned into a replayable snapshot", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.directory, "pending-dispatch.json"), JSON.stringify({ requestId: "unknown-outcome" }));
  await assert.rejects(exportAgentCapsule({ ...f.options, outputPath: f.archivePath }), /unresolved dispatch.*resume original/);
  await assert.rejects(cloneAgentCapsule({ ...f.options, newId: "copy" }), /unresolved dispatch/);
  assert.deepEqual(await readdir(f.stateRoot), ["original"]);
});

test("export fails on missing or corrupt model weights and never labels an incomplete capsule successful", async (t) => {
  const f = await fixture(t);
  const blob = path.join(f.modelsRoot, "blobs", f.blobs[1].digest.replace(":", "-"));
  await writeFile(blob, Buffer.alloc(f.blobs[1].size, 123));
  await assert.rejects(exportAgentCapsule({ ...f.options, outputPath: f.archivePath }), /digest mismatch/);
  await rm(blob);
  await assert.rejects(exportAgentCapsule({ ...f.options, outputPath: f.archivePath }), /ENOENT/);
  assert.equal((await readdir(f.root)).some((name) => name.endsWith(".ovm") || name.includes(".partial-")), false);
});

test("export rejects source symlinks and model paths cannot escape their store", async (t) => {
  const f = await fixture(t);
  const disk = path.join(f.directory, "builder.rootfs.img");
  await rm(disk); await symlink(path.join(f.bundle, "rootfs.img"), disk);
  await assert.rejects(exportAgentCapsule({ ...f.options, outputPath: f.archivePath }), /regular file/);
  for (const model of ["../secret", "a/../secret", "a:..", "/absolute", "a\\b"]) assert.throws(() => ollamaManifestRelative(model), /Unsafe|local tagged/);
  assert.equal(ollamaManifestRelative("huihui-spark-vm:32k"), "manifests/registry.ollama.ai/library/huihui-spark-vm/32k");
  assert.equal(ollamaManifestRelative("hf.co/okenk/spark:Q4_K_M"), "manifests/hf.co/okenk/spark/Q4_K_M");
});

test("existing archives and agent destinations are never overwritten", async (t) => {
  const f = await fixture(t);
  await exportAgentCapsule({ ...f.options, outputPath: f.archivePath });
  const originalDigest = digest(await readFile(f.archivePath));
  await assert.rejects(exportAgentCapsule({ ...f.options, outputPath: f.archivePath }), /overwrite capsule/);
  assert.equal(digest(await readFile(f.archivePath)), originalDigest);
  await assert.rejects(importAgentCapsule({ ...f.options, archivePath: f.archivePath, agentId: "original" }), /overwrite gent/);
  assert.equal(await readFile(path.join(f.directory, "swarm.json"), "utf8"), f.stateBytes);
});

test("corrupt content fails before agent or model publication and removes only temporary extraction", async (t) => {
  const f = await fixture(t);
  await exportAgentCapsule({ ...f.options, outputPath: f.archivePath });
  const bytes = await readFile(f.archivePath); bytes[bytes.length - 1] ^= 1; await writeFile(f.archivePath, bytes);
  const modelsRoot = path.join(f.root, "empty-models");
  await assert.rejects(importAgentCapsule({ ...f.options, archivePath: f.archivePath, agentId: "broken", modelsRoot }), /digest mismatch/);
  assert.deepEqual(await readdir(f.stateRoot), ["original"]);
  assert.equal((await readdir(f.root)).includes("empty-models"), false);
});

test("capsule rejects path traversal, duplicate entries, overlapping extents, and unbounded logical sizes", async (t) => {
  const f = await fixture(t);
  await exportAgentCapsule({ ...f.options, outputPath: f.archivePath });
  const mutations = [
    (m) => { m.files[0].path = "../../escaped"; },
    (m) => { m.files.push(m.files[0]); },
    (m) => { m.files[0].extents.push(m.files[0].extents[0]); },
    (m) => { m.files[0].size = Number.MAX_SAFE_INTEGER; },
    (m) => { m.files[0].extents[0][1] = 1024 * 1024 * 1024; },
    (m) => { m.runtime.kernelPath = "/bin/sh"; },
  ];
  for (let index = 0; index < mutations.length; index++) {
    const file = path.join(f.root, `bad-${index}.ovm`);
    await rewriteManifest(f.archivePath, file, mutations[index]);
    await assert.rejects(importAgentCapsule({ ...f.options, archivePath: file, agentId: `bad-${index}` }), /Unsafe|duplicate|Invalid|Overlapping|Unsupported/);
  }
  assert.deepEqual(await readdir(f.stateRoot), ["original"]);
});

test("wrong magic, version, header length, truncated payload, and appended bytes are rejected", async (t) => {
  const f = await fixture(t);
  await exportAgentCapsule({ ...f.options, outputPath: f.archivePath });
  const good = await readFile(f.archivePath);
  const wrongMagic = Buffer.from(good); wrongMagic[0] ^= 1;
  const wrongVersion = Buffer.from(good); wrongVersion[CAPSULE_MAGIC.length - 2] = 50;
  const longHeader = Buffer.from(good); longHeader.writeBigUInt64BE(BigInt(128 * 1024 * 1024), CAPSULE_MAGIC.length);
  for (const [index, bytes] of [wrongMagic, wrongVersion, longHeader, good.subarray(0, good.length - 1), Buffer.concat([good, Buffer.from("extra")])].entries()) {
    const file = path.join(f.root, `bad-header-${index}.ovm`); await writeFile(file, bytes);
    await assert.rejects(inspectAgentCapsule({ archivePath: file }), /supported|header length|length does not match/);
  }
});

test("model conflicts and model-store symlinks cannot overwrite existing data", async (t) => {
  const f = await fixture(t);
  await exportAgentCapsule({ ...f.options, outputPath: f.archivePath });
  const target = path.join(f.root, "conflicting-models");
  const tag = path.join(target, ollamaManifestRelative("test-model:latest"));
  await mkdir(path.dirname(tag), { recursive: true }); await writeFile(tag, "EXISTING-MODEL");
  await assert.rejects(importAgentCapsule({ ...f.options, archivePath: f.archivePath, agentId: "conflict", modelsRoot: target }), /conflicts/);
  assert.equal(await readFile(tag, "utf8"), "EXISTING-MODEL");
  const symlinkRoot = path.join(f.root, "symlink-models");
  await mkdir(symlinkRoot); await symlink(target, path.join(symlinkRoot, "blobs"));
  await assert.rejects(importAgentCapsule({ ...f.options, archivePath: f.archivePath, agentId: "symlink", modelsRoot: symlinkRoot }), /real directory/);
  assert.deepEqual(await readdir(f.stateRoot), ["original"]);
});

test("insufficient disk budget is rejected before writing archive or extracted files", async (t) => {
  const f = await fixture(t);
  await assert.rejects(exportAgentCapsule({ ...f.options, outputPath: f.archivePath, reserveBytes: Number.MAX_SAFE_INTEGER }), /free reserve/);
  await exportAgentCapsule({ ...f.options, outputPath: f.archivePath });
  await assert.rejects(importAgentCapsule({ ...f.options, archivePath: f.archivePath, agentId: "too-big", reserveBytes: Number.MAX_SAFE_INTEGER }), /free reserve/);
  assert.deepEqual(await readdir(f.stateRoot), ["original"]);
});

test("re-exported replicas retain model weights and lineage while clone gets a fresh instance", async (t) => {
  const f = await fixture(t);
  await exportAgentCapsule({ ...f.options, outputPath: f.archivePath });
  const restored = await importAgentCapsule({ ...f.options, archivePath: f.archivePath, agentId: "replica" });
  // A portable personal agent must keep its own model even after the host's
  // global model cache is removed or changed.
  await rm(f.modelsRoot, { recursive: true });
  const clone = await cloneAgentCapsule({ ...f.options, agentId: "replica", newId: "replica-clone" });
  assert.equal(clone.lineageId, restored.lineageId);
  assert.equal(clone.sourceInstanceId, restored.instanceId);
  assert.notEqual(clone.instanceId, restored.instanceId);
  assert.equal(clone.weightsIncluded, true);
  assert.equal((await readdir(f.stateRoot)).some((file) => file.startsWith(".replica-")), false);
});

test("manifest size limits include sparse logical bytes, not only stored bytes", async (t) => {
  const f = await fixture(t);
  await exportAgentCapsule({ ...f.options, outputPath: f.archivePath });
  const { manifest } = await inspectAgentCapsule({ archivePath: f.archivePath });
  assert.throws(() => validateCapsuleManifest(manifest, { maximumLogicalBytes: 1024 }), /logical size/);
});

test("everyday agent listing is readable while JSON remains machine-readable", async (t) => {
  const f = await fixture(t);
  let text = "";
  const output = { write(chunk) { text += chunk; } };
  await runAgentCommand(["list"], { ...f.options, output });
  assert.match(text, /original  paused  2 pockets  test-model:latest/);
  assert.match(text, /gent resume ID/);
  text = "";
  await runAgentCommand(["list", "--json"], { ...f.options, output });
  assert.equal(JSON.parse(text)[0].id, "original");
  text = "";
  await runAgentCommand(["show", "original"], { ...f.options, output });
  assert.match(text, /Saved reasoning turns: 1/);
  assert.match(text, /New mission: gent resume original/);
});

test("capsules retain immutable published artifact bytes and reject incomplete artifact handoffs", async (t) => {
  const f = await fixture(t);
  const bytes = Buffer.from("actual shared deliverable");
  const sha256 = digest(bytes);
  const directory = path.join(f.directory, "artifacts");
  await mkdir(directory);
  await writeFile(path.join(directory, `sha256-${sha256}`), bytes);
  const index = { schema: "ovm.artifacts/v1", artifacts: [{ sha256, bytes: bytes.length, producer: "builder", guestPath: `/ovm/artifacts/sha256-${sha256}` }] };
  await writeFile(path.join(directory, "index.json"), JSON.stringify(index));
  await exportAgentCapsule({ ...f.options, outputPath: f.archivePath });
  const restored = await importAgentCapsule({ ...f.options, archivePath: f.archivePath, agentId: "with-artifacts" });
  assert.deepEqual(await readFile(path.join(restored.directory, "artifacts", `sha256-${sha256}`)), bytes);
  assert.deepEqual(JSON.parse(await readFile(path.join(restored.directory, "artifacts/index.json"))), index);
  await rm(path.join(directory, `sha256-${sha256}`));
  await assert.rejects(exportAgentCapsule({ ...f.options, outputPath: path.join(f.root, "missing-artifact.ovm") }), /artifact byte closure is incomplete/);
});

test("O program contracts and historical peer reviews survive capsule import without replay or new certification", async t => {
  const f = await fixture(t);
  const sourceFor = number => `python^(\n__oval_result__ = ${number}\n)_python\n\n`;
  const actionFor = number => ({ type: "ostadix", source: sourceFor(number), name: "result", mode: "run",
    checks: [{ kind: "stdout_equals", expected: `[number] ${number}\n` }] });
  const phase = stdout => ({ exitCode: 0, stdout, stderr: "", timedOut: false, outputLimitExceeded: false });
  let submissions = 0;
  const fleet = {
    rootfsPath: id => path.join(f.directory, `${id}.rootfs.img`),
    async run(tasks) {
      submissions++;
      return tasks.map(task => {
        const program = task.ostadix;
        const number = program.source === sourceFor(2) ? 2 : program.source === sourceFor(3) ? 3 : assert.fail("unexpected source");
        const receipt = { schema: "ovm.ostadix-execution/v1", sourceSha256: program.sourceSha256, mode: "run", error: null,
          parse: phase(JSON.stringify({ ok: true, stage: "parse", source_structure: { schema: "ostadix.source-structure/v1",
            required_initial_bindings: [], languages: ["python"], top_level_literal_text: false, plan_nodes: 3,
            backend_syntax_checks: [{ language: "python", state: "valid", result_capture: "explicit_result" }] } })),
          intent: phase(JSON.stringify({ schema: "oexec.execution-intent/v1", source_sha256: program.sourceSha256, execution_intent_sha256: "a".repeat(64) })),
          execution: phase(`[number] ${number}\n`),
        };
        return { agent: task.agentId, stopped: true, exitCode: 0, output: program.token + JSON.stringify(receipt) + "\n" };
      });
    },
  };
  const base = { mission: "first mission", agents: [{ id: "builder", role: "write" }, { id: "child", role: "review" }],
    vmFleet: fleet, nativeBroker: { async describe() { return { operations: [] }; } },
    stateDirectory: f.directory, swarmId: "original", model: "test-model:latest", maximumRounds: 1 };
  await new PocketSwarm({ ...base, modelClient: { async decide() { return { content: '{"actions":[]}' }; } } }).run();
  const baseline = JSON.parse(await readFile(path.join(f.directory, "swarm.json"), "utf8"));
  await new PocketSwarm({ ...base, resumeState: baseline, mission: "review the revised program", missionOverride: true, maximumRounds: 2,
    modelClient: { async decide(agent, context) {
      const actions = context.round === 2
        ? agent.id === "builder" ? [actionFor(2)] : []
        : agent.id === "builder" ? [actionFor(3)] : [{ type: "review_artifact", artifactId: context.availableArtifacts[0].id }];
      return { content: JSON.stringify({ actions }) };
    } },
  }).run();
  const sourceStateBytes = await readFile(path.join(f.directory, "swarm.json"), "utf8");
  const original = JSON.parse(sourceStateBytes);
  assert.equal(original.reviewStartRound, 1);
  assert.equal(original.programArtifacts.length, 2);
  assert.equal(original.artifactReviews.length, 1);
  assert.equal(original.artifactReviews[0].status, "peer-verified");
  assert.equal(submissions, 2);

  await exportAgentCapsule({ ...f.options, outputPath: f.archivePath });
  const { manifest } = await inspectAgentCapsule({ archivePath: f.archivePath });
  assert.equal(manifest.artifacts.length, 3, "The capsule must contain both source blobs and the contract index");
  const restored = await importAgentCapsule({ ...f.options, archivePath: f.archivePath, agentId: "program-replica", installModel: false });
  const imported = JSON.parse(await readFile(restored.statePath, "utf8"));
  assert.notEqual(imported.capsuleIdentity.instanceId, original.capsuleIdentity.instanceId);
  assert.equal(imported.reviewStartRound, 1);
  assert.equal(imported.mission, original.mission);
  assert.deepEqual(imported.programArtifacts, original.programArtifacts);
  assert.deepEqual(imported.artifactReviews, original.artifactReviews);
  assert.deepEqual(imported.transcript, original.transcript);
  assert.equal(await readFile(restored.originalHistoryPath, "utf8"), sourceStateBytes);
  assert.equal(await readFile(path.join(f.directory, "swarm.json"), "utf8"), sourceStateBytes, "Export and import must not rewrite the original review evidence");

  const importedStore = new AgentArtifactStore({ stateDirectory: restored.directory, swarmId: restored.agentId });
  for (const [index, artifact] of imported.programArtifacts.entries()) {
    const loaded = await importedStore.readOstadixArtifact(artifact.id);
    assert.equal(loaded.source, sourceFor(index + 2));
    assert.deepEqual(loaded.action.checks, actionFor(index + 2).checks);
    assert.deepEqual(loaded.artifact, original.programArtifacts[index]);
    assert.equal(loaded.artifact.code.producerInstanceId, original.capsuleIdentity.instanceId, "A clone cannot relabel old execution as a new independent observation");
    assert.equal(loaded.artifact.claimStatus, "awaiting-peer-review");
    assert.equal(loaded.artifact.semanticVerification, false);
  }
  const latest = imported.programArtifacts.at(-1);
  const resumed = await new PocketSwarm({ ...base, mission: undefined, agents: undefined, swarmId: undefined,
    resumeState: imported, stateDirectory: restored.directory,
    vmFleet: { rootfsPath: id => path.join(restored.directory, `${id}.rootfs.img`), async run() { assert.fail("Import must not replay a successful source run or historical review"); } },
    modelClient: { async decide(agent, context) {
      if (agent.id !== "builder") return { content: '{"actions":[]}' };
      assert.deepEqual(context.pendingCodeReviews.map(artifact => artifact.id), [latest.id]);
      return { content: JSON.stringify({ actions: [{ type: "finish", summary: "Attempt completion from old producer evidence",
        assertions: [{ evidenceId: latest.code.executionEvidenceId, kind: "ostadix_checks_passed", expected: true }] }] }) };
    } },
  }).run();
  assert.equal(resumed.completed, false);
  assert.ok(resumed.transcript.at(-2).observation.repairs.some(repair => repair.reason === "awaiting-peer-review"));
  assert.deepEqual(resumed.artifactReviews, original.artifactReviews, "Restoring the capsule cannot mint an independent review");
  assert.equal(resumed.programArtifacts[0].peerVerification.status, "peer-verified", "Historical review remains attached to its original source");
  assert.equal(resumed.programArtifacts[1].peerVerification.status, "awaiting-peer-review", "The newer source still requires a distinct peer execution");
  assert.equal(submissions, 2);
});
