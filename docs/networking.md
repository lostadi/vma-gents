# VM networking

Ordinary guest internet/LAN access uses the host's NAT. Distribution is an
independent choice: automatic mode attempts the Nebula peer network and keeps
local execution available if optional mesh setup fails; local mode uses NAT
without requiring a mesh. Nebula supplies full IP connectivity between enrolled
guests, and native Ostadix `o-node` provides authenticated program execution.
A peer must be running and reachable to accept a connection.

## Everyday controls

```bash
gent mode auto
gent peers
gent peers --discover
gent connect USER@YOUR_OTHER_MACHINE --name laptop
gent task "Your task" --on laptop
gent task "Your task" --local
gent chat --local                       # Persistent local VM-enabled chat
gent chat --on laptop                   # Start a VM chat on this connected host
gent disconnect laptop
```

Prepare o-gents on the destination and verify its existing SSH login. Apple Silicon
hosts can use `gent setup`; Linux/QEMU hosts need `qemu-system-aarch64`, `mke2fs`
(e2fsprogs), `python3`, `lsof`, and a transferred verified prepared ARM64 guest.
Both need Node 26+ and rsync. Add `--path /absolute/path/to/o-gents` if o-gents
is not in its usual location, and `--node /absolute/path/to/node` for a privately
installed Node 26+ interpreter. For example:

```bash
gent connect USER@HOST --name rack --path /path/to/vma-gents --node /path/to/node
```

Replace those paths with the destination's actual paths. Connect checks controller
capabilities, transfers a private controller invitation over SSH, selects the
shared network while preserving the destination's old network, and remembers
the host for placement. This grants a trusted controller network signing
authority. Discovery only lists Tailscale hosts; it does not enroll or install
them. Disconnect removes future placement, not existing certificates.

`gent mode local` keeps internet access, runtimes, files and local multi-gent
operation. `gent mode required` requires a compatible remote host and mesh for
gent tasks; direct shell and normal MCP launches remain on this Mac and require
the mesh. `--on NAME` is an explicit destination and does not silently fall back.
`--isolated` means no network access and should be used only when that is wanted.

Host-to-host VM control uses SSH and durable dispatch receipts. The initiating
controller runs model inference and mailboxes; a communicating gent family
and all descendants stay on one VM host. After a remote round, stopped disks
are checkpointed locally. A disconnected operation with unknown completion
must be reconciled by `gent resume ID`; it is not replayed on another host.
The guest Nebula network remains available for programs that use peer IPs or
native `ovm-peer` execution.

A remote round has a 30-minute completion deadline, allowing Linux disk copies,
guest startup, and the stopped snapshot to finish. Individual SSH connection
and status requests retain short timeouts; checkpoint transfer has its own
30-minute deadline. If completion is still unknown at the deadline, o-gents keeps
the dispatch for resume and does not replay it locally or cancel the remote
work. Snapshot payloads are released only after the initiating controller has
durably saved their checkpoint and completion receipt; live gent disks remain.

`--backend auto|apple|qemu` controls the task/chat VM engine separately from
placement. Auto uses Apple Virtualization on Apple Silicon macOS and QEMU on
Linux or other supported Macs; a resumed capsule without Apple helper inputs
also selects QEMU on Apple Silicon. An explicit backend overrides `OVM_VM_BACKEND`
and constrains compatible controller selection. The guest stays ARM64;
cross-architecture QEMU uses slower TCG emulation. Fresh guest provisioning
still requires Apple Silicon; network enrollment does not create the image.

Chat has the same placement and recovery rules: `gent chat` is VM-enabled by
default, while `gent chat --text` uses the plain model route. `--local` does not
bypass a pending unknown dispatch. Resume reconciles the original operation
before choosing where subsequent work may run.

Setup can install a modern Homebrew rsync for faster checkpoints when the saved
mode allows distribution and the available protocol is older than 30. Failure
of that optional installation warns and leaves local setup available; an
existing compatible rsync remains usable. In the same-Mac live trial, installed
rsync 3.5.1 transferred the later checkpoint in 70.4 seconds versus 598.8 seconds
for the earlier system-rsync transfer. Those timings do not predict WAN speed.

## Guest startup and fallback

Guest bootstrap establishes its local environment and NAT route before trying
optional mesh services. A local-only identity still gives each guest a distinct
runtime state directory without requiring certificates or downloading Nebula.
Automatic fallback preserves network/controller identities for a later attempt;
it does not create a different shared network merely because a peer is offline.

The protected `/run/ovm/ready.json` receipt uses `ovm.guest-ready/v2` and records
`runtimeReady`, `meshReady`, the selected mode, identity key and fallback reason.
The normal launcher admits local runtime readiness in auto/local mode, and also
requires mesh readiness in required mode. A locally ready mesh is not a
reachability assertion about every remote peer. Failed mandatory runtime or NAT
setup still reports a startup error.

The normal Cowork VM keeps its private connected interface and uses a second
interface for NAT. Guest bootstrap obtains a fresh lease on that NAT interface
and adds two more-specific IPv4 routes (`0.0.0.0/1` and `128.0.0.0/1`) through
its DHCP router. These keep ordinary traffic on NAT even if Cowork installs
its private default gateway later; the connected Cowork link and narrower
Nebula route remain intact. `/run/ovm/network.json` records the root guest's
selected routes before and after this configuration.

Cowork's bounded diagnostic commands run in a proxy-only process network view.
Their socket list and route table do not represent the root guest's network.
The root service and native `o-node` use the shared guest network; peer
execution is verified from another VM.

The controller prefers the host's existing Tailscale address for the Nebula lighthouse. Other machines on the same tailnet can reach it without exposing a public Internet port. o-gents does not enroll hosts into Tailscale or change tailnet permissions. The lighthouse host must remain online, and the tailnet must permit UDP 4242 to it.

```bash
gent network create
gent network start
gent network status
```

The default network uses `10.87.0.0/16`. Each controller owns a separate `/24` allocation and can retain 254 unique VM identities. The primary controller allocates the additional controller blocks. Guest identities are stable across reboots; descendants receive their own identities and inherit network membership. Identity files are mounted read-only at `/run/ovm-config`, outside cloned root disks. The CA private key is never included in a guest share or base image.

If automatic discovery cannot find Tailscale, local setup falls back to a host LAN address. Choose the Tailscale endpoint explicitly when preparing a network that spans different LANs:

```bash
gent network create --endpoint 100.110.62.97:4242
```

That command creates a network only if one is absent. It does not silently replace the identity or endpoint of an existing network. `status` reports configuration and the local lighthouse process; it does not claim that another host or VM is reachable.

## Manual controller enrollment (advanced)

`gent connect` handles ordinary enrollment. The lower-level commands below remain
available for private invitation files or separately managed endpoints.
The setup commands in these examples apply to Apple Silicon. On a QEMU host,
prepare the tools and transfer the verified guest first, then join the network;
omit `gent setup` from the enrollment examples.

On the original controller:

```bash
gent network export second-mac --out ~/second-mac-ovm-network.json
scp ~/second-mac-ovm-network.json USER@YOUR_OTHER_MAC:~/
```

Replace `YOUR_OTHER_MAC` with the receiving Mac's Tailscale hostname or IP. Use a fresh o-gents source checkout or copy on that Mac; exclude `runtime/network/` when copying from another machine, because it contains that machine's controller credentials. Join **before running setup**, since setup creates a separate network when none is selected:

```bash
cd ~/o-gents
./bin/gent network join ~/second-mac-ovm-network.json
./bin/gent setup
./bin/gent network status --json
```

Network identity management and controller enrollment run on supported macOS
and Linux hosts. Gent VMs use Apple Virtualization or QEMU with the same
prepared ARM64 guest. On a QEMU destination, provision host tools and transfer
the verified guest before joining; `gent setup` does not provision a fresh QEMU
guest. Linux can also participate as a separately configured Nebula endpoint
and native `o-node` host; creating its host TUN interface requires appropriate
Linux privileges. Guests create their own TUN interfaces inside their VMs.

The export is a private file containing **CA signing authority** so your other controller can create certificates for its own new VMs without an online enrollment service. Transfer it only to your trusted machines. Each export belongs to one controller; run `export` again for each additional machine to allocate a distinct address block. Imported controllers cannot export further controller allocations. o-gents refuses to overwrite an existing network on `join`.

### Join from a machine that already has its own network

Select a new private state directory before joining. This preserves the machine's current network and all its credentials:

```bash
export OVM_NETWORK_STATE="$HOME/.local/share/ovm/networks/shared"
gent network join ~/second-mac-ovm-network.json
gent network status --json
gent setup
gent task "your task" --agents 3
```

Run `join` once for this new directory. Future commands in that terminal use the shared network, and every new VM and descendant receives its own identity in that network. Existing running VMs keep their current network until restarted. The previous network under the checkout's `runtime/network/` remains available. For an environment-only selection, `unset OVM_NETWORK_STATE` restores the saved/default selection; an automated `connect` may have saved a different shared-network selection.

To use the shared network in future interactive terminals, add the same `export OVM_NETWORK_STATE=...` line to your `~/.zshrc`. An MCP server or another launcher must receive the same variable in its launch environment; use the full absolute directory path in its configuration and restart that process after changing it. GUI-launched applications may not inherit shell startup settings. Child processes inherit the selected environment.

`gent network join FILE --state-dir DIR` selects a directory for that command only. It does **not** change the network used by later `gent task`, `gent shell`, or MCP commands. Use the exported environment variable when selecting a shared network for future launches.

No external hosted service is required. The lighthouse discovers peers and relays encrypted traffic when direct NAT traversal fails. It runs without a host TUN interface or administrator access, so the host itself does not get a `10.87.*` IP from this process. The guests create their own `ovm0` TUN interfaces as root and accept all IP protocols/ports from authenticated network members. Native `o-node` still performs its own mutual authentication and peer pairing.

## Native Ostadix access between VMs

In a provisioned, running VM whose receipt reports `meshReady: true`:

```bash
ovm-peer list
ovm-peer status 10.87.1.2
ovm-peer pair 10.87.1.2
ovm-peer run 10.87.1.2 /work/task.O
```

`run` pairs automatically when needed, then delegates execution to native `octl node run`. It never retries a remote execution whose completion might be unknown. Each guest retains its own native TLS and receipt-signing keys. The enrollment service listens only on its Nebula address, on TCP 7341; it starts one expiring native pairing offer at a time on TCP 7340 and transmits the one-use passcode inside the authenticated, encrypted Nebula connection. It never enables `o-node --lan-open` or publishes a shared node private key.

Membership in this o-gents network grants peers permission to enroll for native Ostadix execution on one another. This implements the shared-access behavior requested for the VM fleet. The guest enrollment service rejects requests from outside the overlay and requests for a different network ID.

`list` reports issued identities from this controller, including stopped guests; it does not claim they are online. The host refreshes the mounted `peers.json` files as new guests and descendants receive identities. For a VM created by another controller, use its overlay IP directly; registry replication between controllers is not implemented.

## Paths and manual inspection

Saved distribution mode and connected hosts live in `runtime/distribution/config.json`.
Local-only mounted identities live under `runtime/guest-identities/`. A selected
shared-network directory may be saved by automated enrollment; the original
private controller state defaults to `runtime/network/` in the checkout. `OVM_NETWORK_STATE` or `--state-dir DIR` selects another private state directory. The network directory contains `network.json`, the CA, lighthouse configuration/log, and per-VM identity directories. Keep this private directory out of public repositories and shared base images.

```bash
gent network guest example-vm
# In a running provisioned VM:
ip address show ovm0
cat /run/ovm-config/identity.json
o-node status
```

The implementation pins Nebula 1.11.2 and checks the official archive SHA-256 before installing host binaries. Useful upstream references: [release artifacts](https://github.com/slackhq/nebula/releases/tag/v1.11.2), [unprivileged lighthouse TUN setting](https://nebula.defined.net/docs/config/tun/), [relay behavior](https://nebula.defined.net/docs/config/relay/), and [NAT traversal](https://nebula.defined.net/docs/config/punchy/).

## Observed verification on this checkout

The current automated suite passed **315/315 tests with no skips**:
`runtime/qemu-portability-20261004/npm-test-final.log`.

Local QEMU HVF validation passed: a parent/child pair used distinct network
identities, fetched live peer status and executed a native `o-node` calculation
returning 42. The same guest disk also retained files through QEMU → Apple →
QEMU. Evidence: `runtime/qemu-portability-20261004/backends-live.json`.
The separate QEMU action-flow test delivered typed requests/reports and checked
an exact 221-byte, seven-line immutable artifact across five VM executions:
`runtime/qemu-portability-20261004/projection-live.json`.

The physical x86_64 Linux rack separately booted the ARM64 guest with QEMU TCG,
executed Ostadix, Node and native Ostadix MCP smoke, then read its persistent
marker on a second boot. Both stopped cleanly. Boot/command/shutdown times were
117.9 s and 96.4 s; initial cloning took about 108 s separately. Evidence:
`runtime/qemu-portability-20261004/rack-boot.json`. Networking was isolated.

An actual SSH controller run from this Mac to the x86_64 Linux rack passed two
ARM64 QEMU TCG rounds. The first admission acknowledgement was deliberately
lost; recovery resumed the original dispatch without repeating its persistent
write. The second boot observed that write exactly once. The family advanced
from generation 0 through 1 to 2, both guests stopped, and both immutable
checkpoint payloads were released only after durable local completion and
acknowledgement. The live remote disk was retained and closed. The two checkpoint
transfers took 60.1 s and 57.4 s in this run. An initial rsync path-quoting defect
interrupted checkpointing; after its fix, the saved dispatch recovered without
VM replay. Evidence:
`runtime/qemu-portability-20261004/rack-controller-cc74c698-78cd-44a8-9b11-b77eea59fd98/controller-live.json`.

Native Ostadix execution between guests on the Mac and the rack also passed a
subsequent test with updated pairing helpers installed in the two test guests.
The Mac guest at `10.87.1.23` executed a native operation on the rack guest at
`10.87.2.2`, received value 42, and verified a nested reverse native call using a
unique marker containing 42. The initiating guest stopped cleanly after 50.4 s;
the receiver also returned exit 0 and stopped. Evidence:
`runtime/qemu-portability-20261004/cross-host-local-live-v2.result.json` and
`cross-host-rack-live-v2.result.json` beside it. The earlier reciprocal-pairing
authentication/read failure remains recorded in `cross-host-local-live.result.json`.

The exact tested pairing helpers are now published in the local built-in guest
image, which passed all 47 runtime checks including native Ostadix MCP. The
published recipe is
`4edd16d2ae012b3b73c54a25fb3ff424931a24905e1ad0103f12773bec0ec51d`:
`runtime/qemu-portability-20261004/pairing-image-refresh.json` records publication.
The refreshed Rack base is also published, with the root disk, kernel, initrd
and prepared profile hashes verified in
`runtime/qemu-portability-20261004/rack-pairing-image-publication.json`.
A fresh guest from that base then passed both pairing-helper hash checks,
reported `aarch64`, executed Ostadix hello (`[number] 2`), and passed native
Ostadix MCP smoke with 21 tools. It exited 0 and stopped after 110.4 s:
`runtime/qemu-portability-20261004/rack-pairing-base-boot-v2.json`. The first
harness used the wrong service path; that failure remains in
`rack-pairing-base-boot.json` beside it. This final base check used isolated
networking; the earlier two-guest test supplies the native peer-execution proof.

After verification, the owned Rack cold-boot and controller test disks were
explicitly removed to reclaim space, after confirming they were closed and had
no open handles. Receipts, logs, remote dispatch metadata and the local controller
checkpoint remain. That test cleanup is separate from normal checkpoint release,
which preserves the live family disk. The fresh-base test disk and redundant
old Rack base copy were also removed after closed-disk checks, with the local
APFS rollback retained:
`runtime/qemu-portability-20261004/rack-pairing-fixture-cleanup.json`. That cleanup
left about 28.24 GB free; future admission still depends on available resources.

The Linux rack passed all 39 focused QEMU protocol/lifecycle tests, including
controller-loss cleanup and preservation of unrelated processes:
`runtime/qemu-portability-20261004/rack-qemu-tests.log`. These use dummy
processes and are separate from Linux VM boot or peer-connectivity evidence.
A real local HVF deadline test returned exit 124 and preserved its partial write
for the next boot (`runtime/qemu-portability-20261004/deadline-live.json`).

Actual Spark inference also ran Nmap against guest loopback, observing ports
22, 80 and 443 closed. A stray period from the prompt was an unresolved target;
the recorded scan covered exactly one IP. After normalizing a quoted exit-code
assertion, one resumed reasoning round checked the saved result without VM
replay. This is a bounded diagnostic, not a network map or remote connectivity
test (`runtime/qemu-portability-20261004/loopback-live.json`).

The pre-QEMU automated suite passed **227/227 tests with no skips**; the log is
`runtime/distribution-final-20261004/unit-final.log`. The actual detached
controller worker and VM recovered a lost acknowledgement on this Mac and
verified that the original persistent write occurred exactly once. Completed
snapshots, generation checks and higher-level acknowledgement were exercised:
`runtime/distribution-final-20261004/controller-live.json`.

That earlier result uses a same-Mac controller transport fixture. The newer
Mac-to-Linux SSH controller run above establishes cross-machine placement;
placement on a second Apple Silicon Mac remains untested because the Air was
unavailable.
The two-VM action-flow test separately verified queued publication, typed
messages, scoped source absence and independent read-only artifact inspection
in `runtime/distribution-final-20261004/projection-live.json`.

The current distribution proof is
`runtime/distribution-live-20261004-1791116914171/validation.json`. Five sequential
boots verified explicit local mode, host-preparation failure fallback,
guest-mesh failure fallback, required refusal before user execution, and local
persistence after refusal. Every successful case executed Ostadix, resolved DNS,
and fetched HTTPS 200. The required task did not create its sentinel.
Normal MCP local mode reported runtime ready with mesh false; normal automatic
mode reported mesh true and accepted a separate guest's Ostadix/DNS/HTTPS test.
All those VMs stopped cleanly and released their disks and controller lease.
The updated base and existing witness each passed all 47 runtime/MCP checks.
This did not exercise another Apple Silicon Mac's VM backend.

The earlier networking evidence remains below.

On October 4, 2026, two ARM64 guests booted with distinct Nebula and native Ostadix identities, automatically paired, and successfully executed an O document on one another. The receipts returned the other VM's hostname. Both guests then stopped cleanly.

A guest also paired with the existing native Ostadix node on the physical x86_64 rack through Tailscale and returned a successful execution receipt containing `ostadix-rack x86_64`. A separate temporary Nebula endpoint on that rack demonstrated IP connectivity in both directions: the guest fetched an HTTP response identifying the rack and its own guest overlay source address; the rack fetched the guest's peer-service identity over its overlay address.

The rack's active UFW policy initially blocked the inbound HTTP test. A temporary rule scoped to the test overlay interface enabled the successful forward check. Host firewall permissions remain part of setting up a separate physical endpoint; Tailscale reachability and a successful Nebula handshake alone do not prove that every endpoint port is reachable.

The final normal-VM test also passed: a separate witness VM executed native
Ostadix code on the resident normal VM at `10.87.1.9`. Its successful receipt
identified the normal VM, resolved `example.com`, and returned HTTPS status
200. The captured root routing table confirmed that internet and lighthouse
traffic initially selected `172.16.10.1` on Cowork's private interface; after
configuration, both selected `192.168.64.1` on the NAT interface. The private
connected route remained present. The witness stopped cleanly, and closing the
normal controller left no runner, open VM disk handles, or lease. See
`runtime/guest-provision-20261004/normal-peer-final.json`.

The earlier routing/DHCP base image and upgraded witness each passed 47 runtime
checks. The refresh and backup records are in
`runtime/guest-refresh-20261004/latest.json`. Before the distribution changes, the full automated suite passed
120/120 tests; its output is
`runtime/guest-provision-20261004/unit-final.log`. The separate default-policy
MCP command test and cleanup passed in
`runtime/guest-provision-20261004/mcp-exec-default-final.json`.

Private evidence is retained in `runtime/guest-provision-20261004/`, including `peer-test-1.json`, `rack-execution.json`, `rack-to-guest-overlay.json`, and the forward overlay test result. These are local verification artifacts, not portable VM image contents.
