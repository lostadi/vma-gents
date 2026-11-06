# Apple VM runner and MCP

This is the separate Apple-only diagnostic/MCP route. Daily gent tasks and chat use the pocket controller; see the [README](../README.md).

## Diagnostic route

```text
OpenCode + a local Ollama model
             |
             | foreground delegation
             v
 @vm_operator + Huihui Spark 32K
             |
             | MCP over stdio
             v
       src/server.mjs
             |
             | private JSONL lifecycle protocol
             v
      host/ClaudeVZRunner
             |
             | Apple Virtualization.framework + framed Cowork RPC
             v
   vm/claudevm.bundle (private copy only)
```

The Swift runner uses direct Linux boot with a provenance-pinned `vmlinuz` and `initrd`, two writable NVMe-backed clone disks, Claude's small helper image as a read-only Virtio block device, entropy, memory ballooning, two bounded console drains, and a vsock listener on port 51234. It retains the private blackhole NIC required by Cowork and adds a separate NAT NIC for ordinary guest traffic. The dedicated project share and per-guest network configuration are mounted read-only. Explicit isolated mode disables the NAT/peer route.

In the normal two-NIC guest, bootstrap obtains a fresh DHCP lease for the NAT
interface and installs `0.0.0.0/1` and `128.0.0.0/1` routes through its router.
These keep ordinary IPv4 traffic on NAT if Cowork later installs its private
default gateway. The connected Cowork link and narrower Nebula overlay route
remain intact. Bootstrap verifies the selected internet route and records the
root guest's route evidence in `/run/ovm/network.json`.

`vsock_connected` proves transport connectivity only. Application readiness
requires the ordered `staticIPAssignment` and `hostProxyConfig` frames to drain,
an inbound `coworkd` `ready` event, and a successful internal prepared-runtime
check. That fixed check runs through the guest RPC as its ordinary unprivileged
user: it checks the verified installation and executable Ostadix tools, waits
for the protected per-boot `ovm.guest-ready/v2` receipt written by the root
service to match this guest's identity and selected mode. Runtime readiness and
mesh readiness are separate. Automatic/local mode can run with `meshReady:
false`; required mode also demands the assigned overlay and native peer listener.
Only a matching bootstrap receipt and successful process exit set `guestReady`.
Runtime failure or timeout prevents the user's command and enters the existing
cleanup path. A terminal required-mesh failure is refused immediately. The public diagnostic allowlist is unchanged.
The internal wait is bounded at 90 seconds, with a 95-second native deadline;
the default startup policy allows 120 seconds and CLI/MCP examples allow
180 seconds for the complete request and cleanup.
Cowork's user namespace can display system file owners as an unmapped UID.
The check requires the marker and its real parent directory to share the
protected owner of `/run` and the verified installation record, with no group
or other write bits and no write access for the command user. It does not
interpret the unmapped UID itself as proof of root ownership.
The ordinary Cowork diagnostic process has its own network view; its socket
list is recorded for diagnosis but is not used to infer the root guest's peer
availability. The prepared VM's root service owns the shared peer network.

Status exposes `coworkReady`, `guestBootstrapReady`, `distributionMode`,
`meshReady`, and `networkFallbackReason` separately. This startup barrier
establishes local guest readiness; a remote peer still must be online and
reachable for a peer operation to succeed.

## Performance-only process lifetime

Set `CLAUDE_VM_LIFETIME=process` for an individual MCP controller to start one
VM asynchronously when the MCP connects, wait once for application-level
`guestReady`, and reuse the same runner, lease, vsock connection, and guest
state for subsequent `cycle` or `exec_cycle` calls. Model calls cannot invoke
the normal stop tool in this mode. MCP stdin EOF, `SIGINT`, or `SIGTERM` owns the
single bounded shutdown and lease release. The default remains `transaction`,
so existing Ostadix and direct smoke commands retain start-operation-stop
semantics.

This mode changes lifetime only. It does not change the selected model, context,
Ollama settings, policy file, program allowlist, output limits, network, host
share, devices, USB surface, code signature, or entitlements. Its normative
performance and non-interference gates are in
[`claude-vm-performance-contract.tex`](claude-vm-performance-contract.tex).

## Safety boundary

The following limits describe the Apple normal run/MCP route. Gent tasks use
their selected backend and the separate [pocket protocol](agent-pockets.md).

- Claude's original bundle is selected by `CLAUDE_VM_SOURCE_BUNDLE` or the
  standard per-user Claude Desktop location, verified against the compatibility
  profile, and never passed to the VM runner.
- The working bundle lives under this project's private `vm` directory. Every critical clone file must be a regular, non-symlink file with an inode distinct from the corresponding source file.
- The clone was created with APFS copy-on-write semantics. Once booted, writes are private to the clone and consume additional physical blocks.
- An atomically published lease prevents two MCP hosts from opening the same writable clone disks.
- Startup refuses while either source disks or clone disks are open.
- First start generated a distinct generic machine identifier and a locally administered unicast MAC for the clone.
- Kernel, initrd, and rootfs origin identifiers must match, and kernel/initrd SHA-256 values are pinned in `.direct-boot-manifest-v1.json`.
- The baseline is 4 GiB RAM and 4 vCPU, matching Claude's observed working profile.
- Startup requires at least 35% host free-memory headroom.
- Guest startup must complete within the configured startup budget (120 seconds in the current policy). Failed startup then enters the same bounded stop/escalation path as an explicit stop.
- Networking defaults to NAT for internet/LAN access. Automatic mode attempts an
  encrypted Nebula network shared with other enrolled guests and can retain the
  local runtime if optional mesh setup fails. The normal Cowork runner
  uses a separate blackhole NIC for its private control route. Select
  `--network isolated` or `OVM_NETWORK_MODE=isolated` to disable external and
  peer networking. The everyday task command also accepts `--isolated`.
- The project `share/` directory is read-only under tag `claudeshared`.
  Connected guests also receive a read-only `ovmconfig` share containing their
  own network identity and public peer directory. The host CA private key is
  excluded. Native `o-node` keys are generated separately inside each guest.
  Host `/` and home are not mounted. Automated provisioning may explicitly
  attach a dedicated writable export directory under `ovmexport` to return
  runtime archives and verification receipts.
- The share root is mode `0500`; preflight rejects group/world access,
  owner-writability, symlinks, and special files before launch.
- Graceful guest shutdown has a 15-second deadline, followed by Virtualization.framework's destructive stop. Uncertain cleanup retains the lease and fails closed.
- Console capture is bounded to 64 KiB per stream inside the runner. The MCP
  returns an 8 KiB tail by default and permits at most 64 KiB, preventing a
  console read from becoming a model-sized prompt.
- Guest execution is a direct argv call, never shell text. A code-level immutable
  ceiling permits only exact tuples for `uname`, `id`, `python3 --version`, and
  `git --version`; the owner policy file can only remove tuples or lower limits.
  The caller cannot set cwd, environment, stdin, mounts, paths, credentials,
  domains, network policy, or output limits. Aggregate output is capped at 32 KiB
  and returned as explicitly untrusted guest text.
- The supplied `vm_operator` profile allows only status and the compound lifecycle/execution tools. Primary-agent restrictions must be configured in the MCP client.

Do not redistribute Claude's disk image, guest software, or helper image. This is a private interoperability experiment.


## MCP tools

- `claude_vm_status`: report network mode, host headroom, the controller lease, and lifecycle/readiness state.
- `claude_vm_start`: run fail-closed preflight checks and start the clone.
- `claude_vm_console`: read the bounded `hvc0` daemon or `hvc1` kernel console tail.
- `claude_vm_cycle`: in transaction mode, start, inspect, capture a bounded
  console tail, stop, and verify the final stopped/unlocked state. In process
  mode, reuse the resident VM and defer normal cleanup to controller exit.
  Handled failures and cancellation enter cleanup; power loss and process
  SIGKILL are not atomic.
- `claude_vm_exec_cycle`: boot the private clone, wait for application-level
  guest readiness, run one immutable-allowlist argv tuple, return bounded
  untrusted stdout/stderr, then either perform same-call cleanup in transaction
  mode or retain the verified resident runner in process mode.
- `claude_vm_stop`: request a graceful stop and apply the bounded forced-stop fallback if needed.

There is deliberately no arbitrary `exec`, shell, persistent-process, or
network tool. `exec_cycle` is the bounded diagnostic capability described above.
