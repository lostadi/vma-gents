# Historical validation through October 4, 2026

This material was moved from the previous README. These are historical results from separate runs, including automated tests. They were not rerun as part of the [current manual review](manual-verification-2026-10-04.md); words such as “current” below refer to the stage recorded at the time. Private evidence paths are relative to the original checkout and are not supplied by a fresh clone.

The suite recorded at that stage passed **315/315 tests with no skips**:
`runtime/qemu-portability-20261004/npm-test-final.log`.

The QEMU portability tests on this Mac passed. The same guest disk moved
QEMU → Apple → QEMU and retained both backend-written files. A parent and child
QEMU guest exchanged a live peer request and native `o-node` calculation
returning 42: `runtime/qemu-portability-20261004/backends-live.json`.
A separate scripted action-flow test used five real QEMU executions, delivered
typed messages and verified an exact 221-byte, seven-line read-only artifact:
`runtime/qemu-portability-20261004/projection-live.json`. These used local HVF;
they do not establish remote Linux/TCG execution or model reasoning quality.

The x86_64 Linux rack separately booted the transferred ARM64 guest with QEMU
TCG and passed Ostadix execution, guest Node and native Ostadix MCP smoke checks.
A second boot read its preserved marker; both guests stopped cleanly. The first
boot/command/shutdown took 117.9 s, including 20.0 s of guest execution; the
second took 96.4 s. Initial disk cloning took about 108 s separately. Evidence:
`runtime/qemu-portability-20261004/rack-boot.json`. This used isolated networking.

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

The focused QEMU protocol/lifecycle suite passed **39/39 tests with no skips**
on both this Mac and the Linux rack. The rack result is
`runtime/qemu-portability-20261004/rack-qemu-tests.log`; those tests use dummy
processes rather than booting a VM. A real local QEMU deadline test returned
exit 124 and a subsequent boot read its preserved partial write:
`runtime/qemu-portability-20261004/deadline-live.json`.

Actual Spark inference installed Nmap and scanned guest loopback ports 22, 80,
and 443; all three were closed. The initial four-round invocation stalled on a
quoted exit-code assertion. After the normalization fix, one resumed reasoning
round passed four assertions against the saved observation without rerunning
the VM command. A stray period from the prompt became an unresolved target;
Nmap reported exactly one IP scanned. This establishes a bounded loopback
diagnostic, not a network map: `runtime/qemu-portability-20261004/loopback-live.json`.
A fresh 6.5 GiB capsule export included all selected Spark weights:
`runtime/qemu-portability-20261004/capsule-export.json` records the private
`spark-agent.ovm` archive. It was transferred to the x86_64 Debian Mini and
imported with full weights in a private model store, restored source history and
a new instance identity:
`runtime/qemu-portability-20261004/debianmini-capsule-import.json`.
On that Core 2 Duo Mini, the imported weights, byte-identical source history,
offline Spark inference and imported VM persistence all passed. A new user/network
namespace contained only loopback throughout. Private Ollama 0.35.0 CPU inference
answered the bounded arithmetic prompt with `4` in 129.4 s, including 63.6 s
loading the model, and its owned process group stopped cleanly. The existing
imported guest then booted under QEMU TCG without an extra root-disk clone, read
the exact retained marker, executed Ostadix hello (`[number] 2`) and reported
`aarch64`. Boot/command/shutdown took 129.3 s; the guest stopped, released its
lease and preserved the original source history. This establishes those offline
operations on this physical Linux host, not general model reasoning quality or
performance on every machine. Evidence:
`runtime/qemu-portability-20261004/debianmini-offline-proof/evidence.json`.

The pre-QEMU automated suite passed **227/227 tests, with no skips**:
`runtime/distribution-final-20261004/unit-final.log`. `ovm check --json` reported
all chat/task prerequisites ready and no normal-route blockers. Package dry-run
contained 145 files with no private runtime leaks, and prebuilt checksums and
signatures passed. No test VMs remained active at that check.

Actual default chat created/read `CHAT_VM_PERSISTED`, reported guest Node
`v22.23.3`, and replied in round six. A separate resumed invocation appended
`SECOND_CHAT_TURN`, read both lines and replied in round nine. It remained
waiting for the user rather than completed; one early failed capture was
retained and recovered. Evidence: `runtime/distribution-final-20261004/chat-live.json`.

The deterministic action-flow test used two real VMs and five executions. It
verified queued publication, immediate unverified requests, reviewed reports,
scoped source absence, and an exact read-only seven-line artifact. It took
12.926 seconds and did not test model reasoning. Evidence:
`runtime/distribution-final-20261004/projection-live.json`.

The same-Mac controller test recovered a lost acknowledgement, checked immutable
checkpoints, and observed the original persistent write exactly once. In that
trial, Homebrew rsync 3.5.1 transferred the later checkpoint in 70.4 seconds,
compared with 598.8 seconds for the earlier system-rsync transfer; these are
local observations, not a cross-network benchmark. Evidence:
`runtime/distribution-final-20261004/controller-live.json`.

A 6.96 GB capsule included complete weights and restored private model inference,
byte-identical original history, a new instance identity, and isolated guest
execution of the retained proof file, Ostadix hello and `aarch64`. Earlier
agent turns repeated reads and reached their limits. A later review finished
using those saved results; a harness requiring another fresh command in that
review-only invocation failed. The payload restoration is verified across the
sequence, not a new boot in the final review. This was on the same physical Mac:
`runtime/distribution-final-20261004/capsule-proof.json`.

The current distribution-mode validation is
`runtime/distribution-live-20261004-1791116914171/validation.json`. It records
five real local/fallback/required boots, preserved files, Ostadix execution,
DNS/HTTPS, normal MCP local readiness, and normal MCP mesh readiness with an
external VM's peer execution. All those VMs stopped and released their disks
and leases. Guest base/witness checks passed 47/47 after the recipe refresh.
The Mac-to-Linux SSH controller proof above establishes cross-machine placement.
Placement on a second Apple Silicon Mac remains untested because the MacBook
Air was unavailable.

The previously observed model and network results below remain useful evidence
for their specific runs; their automated-suite counts predate this change.

The prepared Linux ARM64 guest image and an upgraded existing pocket each
passed **47/47 runtime checks**, including real backend programs, native tools,
the reference interpreters, and the guest MCP round trip. Two simultaneously
running local VMs executed Ostadix programs on one another over Nebula using
native authenticated peer execution. A child VM preserved an inherited file,
received its own overlay/native identity, and executed a program on its parent.
All workers in those peer tests reported bootstrap exit 0, command exit 0,
no error, and a stopped state. Before the distribution changes, the full automated
suite passed **120/120 tests**;
the complete output is saved in `runtime/guest-provision-20261004/unit-final.log`.

A final one-agent Spark task used the prepared guest, printed its installation
report with `verified: true` and `OVM_SPARK_READY`, and finished after observing
the output in round two. Guest bootstrap and command exits were 0, with no
worker error and a stopped guest. Its receipt is
`runtime/spark-prepared-final-20261004/swarm-mutnyuhr/swarm.json`.

A fresh `ovm guests check --json` run passed all 47 runtime checks again.
Cross-host Nebula traffic also passed in both directions: the Mac's ARM64 guest
reached a TCP endpoint on the Linux Rack, and the Rack read the guest's
peer-enrollment identity endpoint. Those checks use the existing Tailscale
underlay and cover a Mac guest plus a Linux endpoint; a second Mac's guest
launcher was not exercised.

Separately, the guest paired with Rack's native `o-node` over the existing
Tailscale route and executed an Ostadix program there. The successful operation
receipt returned `ostadix-rack x86_64`; the guest exited cleanly and stopped.
Evidence: `runtime/guest-provision-20261004/rack-execution.json`.

The normal VM/MCP route also passed with the default 20 GiB disk minimum and
120-second startup budget: `uname -m` returned `aarch64`, exit 0; Cowork,
prepared-runtime, and overall readiness were all true. Cleanup verified a
stopped runner and released lease. The final preflight recorded about 25.96 GiB
free disk and 70% free-memory headroom. Evidence:
`runtime/guest-provision-20261004/mcp-exec-default-final.json`.

A separate witness VM then executed native Ostadix code on the resident normal
VM at `10.87.1.9`. Its successful operation receipt returned
`NORMAL_MCP_PEER_OK aarch64`, resolved `example.com`, and reported HTTPS status
200. Root route snapshots showed internet and lighthouse traffic initially
selecting Cowork's `172.16.10.1` gateway; after the fix, both selected the NAT
gateway `192.168.64.1` on `enp0s2`, with the private connected route preserved.
The witness stopped cleanly, and closing the resident controller left no runner,
open VM disks, or lease. Evidence:
`runtime/guest-provision-20261004/normal-peer-final.json`.

The earlier routing/DHCP base refresh and witness upgrade each passed all 47
runtime checks with recipe
`4a9967efe5d248228ce2444d9913ba75b69ad2dbd276e7c1d2e55635ba972032`;
`runtime/guest-refresh-20261004/latest.json` records that runtime archive and
retained backups. The newer local pairing-helper image and its 47/47 result are
recorded above in `pairing-image-refresh.json`.

The published profile is `vm/claudevm.bundle/.ovm-guest-v1.json`; the migration,
reciprocal-peer, and child receipts are under
`runtime/guest-provision-20261004/`. See
[the current evidence table](getting-started.md#prepared-guest-and-network-verification-2026-10-04)
for exact paths. These private runtime artifacts are excluded from the public
launcher package. `npm test` is restricted to `test/*.test.mjs`, so saved manual
live-test scripts are not executed by the automated suite.

### Earlier validation

The historical tests below predate the prepared guest environment and default
NAT/peer network. Their isolation observations describe those test runs.
`ovm guests status` reports the installed profile's saved runtime evidence;
`ovm guests check` reruns those checks in a fresh guest. Runtime checks and
network configuration status do not establish live peer connectivity or
arbitrary application success.

- Swift arm64 build: passed.
- Code signature and virtualization entitlement: passed.
- Apple Virtualization support probe: `true`.
- Full VM configuration validation: passed at 4 GiB, 4 vCPU, isolated blackhole
  networking, and the dedicated read-only `claudeshared` directory.
- Node tests: 43/43 passed, covering single-call cancellation/cleanup, lease
  races, source-alias and `lsof`
  failure rejection, identity transactions, direct-boot provenance,
  share confinement, serialization, immutable execution policy ceilings,
  output/correlation limits, cancellation cleanup, process-lifetime reuse and
  idempotent shutdown, and signed Swift support.
- Process-lifetime live test on 2026-09-01: one runner reached `guestReady` in
  3.551 seconds, retained one lease across 20 `uname -m` executions, recorded
  0.274-second median and 0.373-second p95 operation latency, and controller
  close removed the runner, clone-disk handles, and lease in 0.744 seconds.
- Unchanged-Qwen coexistence probe on 2026-09-01: q3.8 remained manifest
  `d7fc42486103` at context 262144 and completed its fixed cold probe, but host
  free-memory headroom fell to 12%. This fails the performance contract, so the
  main OpenCode registration remains in transaction mode.
- Clean Swift lifecycle test on 2026-08-27: passed in 4.6 seconds while Jan Nano
  remained loaded. The ARM64 Linux kernel reached systemd, `coworkd` connected
  to host vsock port 51234, and mounted `claudeshared` once as `root only,
  nosymfollow`. Status reported `running`, and the same MCP controller then
  stopped the VM with exit code 0, no process escalation, no remaining disk
  handles, and its lease released.
- Model-driven fail-closed lifecycle: the constrained `vm_operator` called
  exactly status, one `claude_vm_cycle`, then returned final text. The cycle
  started the VM, bounded the console to 4096 bytes, stopped with runner exit
  code 0, released the lease, and returned `completed: true` plus final
  `running: false` in one tool result.
- Ostadix entrypoint: literal `o open vm` passed in 5.8 seconds and independently
  reported no runner, no clone-disk handles, no lease, and unchanged source
  identity hashes after the cycle.
- Live allowlisted execution: `o open vm-exec` passed on 2026-08-27. The
  Ostadix-owned receipt reported `guest_ready: true`, `network_mode: isolated`,
  `/usr/bin/uname -m` output `aarch64`, exit code 0, 8 captured bytes under the
  32 KiB limit, unchanged source identity, and both server and independent host
  cleanup verified with no runner, disk handle, lease, or unexpected controller.
- Model-driven allowlisted execution: OpenCode session
  `ses_fbbc0ced4ffeg190Pws0dz4kF9` used `ollama/jan-nano-vm:32k` and exactly
  `claude_vm_status -> claude_vm_exec_cycle -> final`. The tool input was
  `uname`, `[-m]`, 10 seconds; the result matched the Ostadix receipt and the
  operator exited 0 without calling any raw lifecycle tool.
- Claude's source machine-ID, MAC, and EFI hashes were identical before and
  after the live test. The writable clone retained its distinct identity.

The successful vsock connection alone remains transport evidence; the separate
`guest_ready` and correlated spawn/output/exit receipt provide the narrower
application-execution evidence above. The 262K-context Qwen runner cannot satisfy
the 35% startup-headroom gate on this 64 GiB M1 Max, so Lee's primary agent is
denied direct `claude_vm_start`. Invoke the foreground `@vm_operator` subagent;
its local model is instructed and permissioned to perform the whole
transaction and stop the VM before Qwen loads again. A persistent VM beside
Qwen remains disabled in the active OpenCode configuration because the measured
local candidate failed the post-load memory gate. In that historical test,
`jan-nano-vm:32k` was a metadata-only local
tag over the same Jan Nano weight blob; it capped that bounded agent's runtime
context at 32768 without duplicating model weights or changing the primary
Qwen model. Live Ollama state confirmed the alias at 32768 context and about
5.28 GB of GPU-resident allocation during the model-driven test.

Those Jan Nano measurements are historical evidence, not measurements of the
current Huihui Spark default. Requalify model-driven VM transactions after a
model change.

An earlier private-addon prototype reached `Linux VM started successfully`, then crashed in Claude's Electron-specific shutdown hook because `NSApp` was absent. That backend has been retired from the active MCP rather than patched around another private lifecycle assumption.
