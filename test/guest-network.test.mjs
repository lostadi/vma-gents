import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDefaultNetwork, exportController, joinNetwork, nebulaConfiguration, networkStatus, prepareGuestNetwork, prepareLaunchNetwork, runNetworkCli, validateEndpoint } from "../src/guest-network.mjs";

const execute = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installedTools = path.join(projectRoot, "runtime", "network", "tools", "1.11.2");
const sample = { schema: "ovm-network-v1", networkId: "a".repeat(32), controllerId: "b".repeat(32), controllerBlock: 1, subnet: "10.87.0.0/16", lighthouseIp: "10.87.0.1", endpoint: "100.110.62.97:4242" };

test("network endpoints reject config injection and invalid ports", () => {
  assert.equal(validateEndpoint("100.110.62.97:4242"), "100.110.62.97:4242");
  assert.equal(validateEndpoint("[fd7a:115c:a1e0::1]:4242"), "[fd7a:115c:a1e0::1]:4242");
  for (const invalid of ["x:0", "x:65536", "x:4242\nother: bad", "x;exec:4242", "../secret:4242"]) assert.throws(() => validateEndpoint(invalid));
});

test("guest configuration grants full authenticated peer IP access with relay fallback", () => {
  const config = JSON.parse(nebulaConfiguration({ network: sample }));
  assert.equal(config.tun.dev, "ovm0");
  assert.equal(config.tun.disabled, false);
  assert.equal(config.pki.key, "/run/ovm-config/guest.key");
  assert.deepEqual(config.lighthouse.hosts, ["10.87.0.1"]);
  assert.deepEqual(config.static_host_map, { "10.87.0.1": [sample.endpoint] });
  assert.deepEqual(config.relay.relays, ["10.87.0.1"]);
  assert.equal(config.punchy.respond, true);
  assert.deepEqual(config.firewall.inbound, [{ port: "any", proto: "any", host: "any" }]);
});

test("host lighthouse needs no TUN and acts as a relay without relaying through itself", () => {
  const config = JSON.parse(nebulaConfiguration({ network: sample, lighthouse: true, directory: "/private/config with spaces" }));
  assert.equal(config.tun.disabled, true);
  assert.equal(config.lighthouse.am_lighthouse, true);
  assert.deepEqual(config.lighthouse.hosts, []);
  assert.equal(config.relay.am_relay, true);
  assert.equal(config.relay.relays, undefined);
  assert.equal(config.listen.port, 4242);
  assert.equal(config.pki.key, "/private/config with spaces/lighthouse.key");
});

test("network help is available without provisioning or downloads", async () => {
  let output = "";
  const code = await runNetworkCli(["--help"], { output: { write: (value) => { output += value; } } });
  assert.equal(code, 0);
  assert.match(output, /signing authority/);
  assert.match(output, /Tailscale/);
});

test("network status accepts --json without creating network state", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "ovm-network-cli-test-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const stateRoot = path.join(temporary, "absent-network");
  for (const argv of [["status", "--json"], ["--json", "status"]]) {
    let output = "";
    const code = await runNetworkCli([...argv, "--state-dir", stateRoot], {
      output: { write: (value) => { output += value; } },
    });
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(output), { configured: false });
    assert.equal(existsSync(stateRoot), false);
  }
  await assert.rejects(runNetworkCli(["status", "--unknown", "--json"]), /Unknown network option: --unknown/);
});

test("optional distribution falls back to stable local identities without replacing mesh credentials", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ovm-distribution-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { projectRoot: root, guestId: "rootfs:/private/parent.img", distributionMode: "auto" };
  let attempts = 0;
  const unavailable = { startNetwork: async () => { attempts += 1; throw new Error("lighthouse unavailable"); },
    prepareGuestNetwork: async () => assert.fail("must not allocate after failure") };
  const first = await prepareLaunchNetwork(options, unavailable);
  const again = await prepareLaunchNetwork(options, unavailable);
  const child = await prepareLaunchNetwork({ ...options, guestId: "rootfs:/private/child.img", distributionMode: "local" }, unavailable);
  assert.equal(attempts, 2);
  assert.equal(first.meshConfigured, false);
  assert.equal(first.guestReachabilityVerified, false);
  assert.equal(first.effectiveDistributionMode, "local");
  assert.match(first.fallbackReason, /lighthouse unavailable/);
  assert.equal(first.networkShare, again.networkShare);
  assert.notEqual(first.networkShare, child.networkShare);
  assert.equal(first.controllerId, child.controllerId);
  assert.equal(existsSync(path.join(root, "runtime/network")), false);
  assert.deepEqual((await readdir(first.networkShare)).sort(), ["identity.json", "launch.json"]);
  const launch = JSON.parse(await readFile(path.join(first.networkShare, "launch.json"), "utf8"));
  assert.equal(launch.distributionMode, "auto");
  assert.equal(launch.meshConfigured, false);
  await assert.rejects(prepareLaunchNetwork({ ...options, distributionMode: "required" }, unavailable), /lighthouse unavailable/);
  const offline = await prepareLaunchNetwork({ ...options, networkMode: "isolated" }, unavailable);
  assert.equal(offline.effectiveDistributionMode, "isolated");
  assert.equal(offline.networkShare, undefined);
});

test("real certificates remain distinct and stable across concurrency, export and join", { skip: !existsSync(path.join(installedTools, "nebula-cert")) }, async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "ovm-network-test-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const stateRoot = path.join(temporary, "owner");
  const joinRoot = path.join(temporary, "joined");
  for (const root of [stateRoot, joinRoot]) {
    await mkdir(path.join(root, "tools"), { recursive: true });
    await symlink(installedTools, path.join(root, "tools", "1.11.2"));
  }
  const options = { stateRoot, endpoint: sample.endpoint };
  const created = await ensureDefaultNetwork(options);
  const again = await ensureDefaultNetwork(options);
  assert.equal(again.networkId, created.networkId);
  const [first, second, repeated] = await Promise.all([
    prepareGuestNetwork({ ...options, guestId: "swarm/scout" }),
    prepareGuestNetwork({ ...options, guestId: "swarm/scout/child" }),
    prepareGuestNetwork({ ...options, guestId: "swarm/scout" }),
  ]);
  assert.equal(first.address, repeated.address);
  assert.notEqual(first.address, second.address);
  assert.notEqual(await readFile(path.join(first.shareDir, "guest.key"), "utf8"), await readFile(path.join(second.shareDir, "guest.key"), "utf8"));
  assert.deepEqual((await readdir(first.shareDir)).sort(), ["ca.crt", "config.yaml", "guest.crt", "guest.key", "identity.json", "peers.json"]);
  const registry = JSON.parse(await readFile(path.join(first.shareDir, "peers.json"), "utf8"));
  assert.equal(registry.scope, "this-controller");
  assert.equal(registry.peers.length, 2);
  assert.ok(registry.peers.some((peer) => peer.guestId === "swarm/scout/child"));
  assert.equal((await stat(path.join(first.shareDir, "guest.key"))).mode & 0o777, 0o600);
  const connected = await prepareLaunchNetwork({ ...options, projectRoot: temporary, guestId: "swarm/scout", distributionMode: "auto" }, { startNetwork: async () => {} });
  assert.equal(connected.meshConfigured, true);
  assert.equal(connected.effectiveDistributionMode, "mesh");
  assert.equal(connected.guestReachabilityVerified, false);
  assert.equal(connected.networkShare, first.shareDir);
  const cert = path.join(installedTools, "nebula-cert");
  await execute(cert, ["verify", "-ca", path.join(first.shareDir, "ca.crt"), "-crt", path.join(first.shareDir, "guest.crt")]);
  // Test the actual Nebula parser with host paths without starting a service.
  const check = path.join(temporary, "guest-check.yaml");
  await writeFile(check, nebulaConfiguration({ network: created, directory: first.shareDir }));
  await execute(path.join(installedTools, "nebula"), ["-test", "-config", check]);
  await execute(path.join(installedTools, "nebula"), ["-test", "-config", path.join(created.networkDir, "lighthouse.yaml")]);
  const exported = path.join(temporary, "trusted-controller.json");
  const invitation = await exportController({ ...options, name: "rack", outputFile: exported });
  assert.equal(invitation.controllerBlock, 2);
  assert.equal((await stat(exported)).mode & 0o777, 0o600);
  const joined = await joinNetwork({ stateRoot: joinRoot, inputFile: exported });
  assert.equal(joined.networkId, created.networkId);
  assert.equal(joined.owner, false);
  const remote = await prepareGuestNetwork({ stateRoot: joinRoot, guestId: "remote/scout" });
  assert.equal(remote.address, "10.87.2.1");
  assert.notEqual(remote.address, first.address);
  await execute(cert, ["verify", "-ca", path.join(first.shareDir, "ca.crt"), "-crt", path.join(remote.shareDir, "guest.crt")]);
  await assert.rejects(joinNetwork({ stateRoot: joinRoot, inputFile: exported }), /already has a network/);
  await assert.rejects(exportController({ stateRoot: joinRoot, outputFile: path.join(temporary, "no.json") }), /original network owner/);
  const status = await networkStatus(options);
  assert.equal(status.running, false);
  assert.equal(status.guestReachabilityVerified, false);
  assert.match(status.caFingerprint, /^[a-f0-9]{64}$/);
});
