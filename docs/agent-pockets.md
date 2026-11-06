# Gents and persistent VM pockets

A gent pairs an Ollama reasoning session with a private, persistent
ARM64 Linux root filesystem. Cloning uses copy-on-write where supported, or a
sparse copy otherwise. A saved gent ID identifies a family of
pockets connected through the initiating controller's mailbox. Pockets run VM
programs, observe enabled host capabilities, exchange messages and captured
artifacts, create descendants, and finish with recorded evidence.

```zsh
gent chat                             # One persistent VM-enabled conversation
gent chat --resume GENT_ID            # Continue its files and conversation
gent chat --text "Explain a concept"   # Plain model conversation
gent task "Your task"                  # One gent, automatic local-first placement
gent task "Your task" --agents 3       # A communicating team
gent task "Your task" --local          # Keep this family here with internet access
gent task "Your task" --on laptop      # Use a connected compatible VM host
gent list
gent resume GENT_ID
```

Use `gent mode auto`, `gent mode local`, and `gent mode required` for the saved
placement choice. `gent peers` shows connected controllers; `gent connect HOST`
enrolls an already prepared, trusted Apple or QEMU o-gents host using existing SSH.
Task/chat flags work before or after the quoted request. Interactive chat uses
one gent, six reasoning rounds by default, and `/bye`, `/status`, `/help`.
Its `reply` action yields to the user without completing the mission; a quoted
chat message performs one conversational turn and exits.

## Architecture

```text
                       local Ollama
                    (one turn per pocket)
                            |
                 typed JSON action protocol
                            |
       +------------- o-gents broker --------------+
       |                    |                       |
  host native          peer mailboxes          lineage manager
  capability broker         |                       |
       |              pocket <-> pocket       spawn child pocket
       |                                            |
  Claude NAPI       +-------------------------------+
  subprocesses      |
                    v
            Apple or QEMU VM backend
                    |
       +------------+------------+
       |            |            |
   scout.img    builder.img   auditor.img
   private VM   private VM    private VM
```

Model inference runs on the initiating host; a saved capsule includes the model
weights for transfer and later local inference. Linux commands run in each
pocket's VM on the selected controller. Each VM receives one vCPU and 768 MiB by
default, NAT access, and optional shared guest networking. Local mode and
unavailable optional distribution preserve the runtimes and local team workflow.
Its root filesystem persists between rounds under `vm/pockets/<swarm-id>/` and
is excluded from Git and npm.
One controller lease per swarm identity prevents concurrent processes from
opening the same persistent rootfs or replacing the same state manifest.

The default `--backend auto` uses Apple Virtualization on Apple Silicon macOS
and QEMU on Linux or other supported Macs. `--backend apple` and `--backend qemu`
override the environment's `OVM_VM_BACKEND`. Both boot the same ARM64 guest;
auto also selects QEMU on Apple Silicon when an imported capsule lacks Apple
helper inputs. An explicit incompatible selection reports an error.
QEMU uses hardware acceleration when available and slower TCG otherwise,
including on x86 hosts. QEMU requires `qemu-system-aarch64`, `mke2fs`, `python3`,
`lsof`, Node 26+, and a verified prepared guest transferred from Apple setup or
an imported capsule. Fresh guest provisioning remains Apple-only. See
[setup](getting-started.md#choose-the-vm-engine).

## Run

```zsh
gent swarm \
  --mission "build a parser and have another gent reproduce its tests" \
  --agents 3 \
  --rounds 4
```

Use a reusable specification:

```zsh
gent swarm --spec examples/pocket-swarm.json
```

Inspect the complete plan without calling Ollama or booting a VM:

```zsh
gent swarm --spec examples/pocket-swarm.json --dry-run --json
```

The default roles are scout, builder, and auditor. More roles cycle through a
coordinator role. A gent may request a child with a narrower role and mission;
the child starts on the next round and inherits its parent's persistent rootfs
when one exists. `--max-agents` bounds this spread.

## Pocket protocol

Each model turn returns one JSON object containing at most eight actions:

```json
{
  "rationale": "The builder needs the display dimensions and a Linux probe.",
  "actions": [
    { "type": "native", "operation": "host.displays", "args": [] },
    { "type": "vm", "command": "uname -a && python3 --version" }
  ]
}
```

Supported actions are:

- `vm`: run one bounded shell program in this pocket's private VM.
- `native`: call one cataloged native host capability in a child process.
- `send`: address one peer or `all`, declaring `kind: request`, `hypothesis`, or `report`; peers receive it on their next model round.
- `publish`: capture a completed guest file into the family's artifact store.
- `inspect_source`: observe one absolute guest path and record a scoped source fact.
- `spawn`: create a bounded child pocket with a role and sub-mission.
- `finish`: record this pocket's final summary only after explicit evidence assertions pass.
- `reply`: in interactive chat, respond to the user and wait without completing the mission.

The controller validates individual actions and records repairs instead of
throwing away all valid work because one action is malformed. It executes at
most one guest operation and two native calls per gent round. If a decision
requests both a VM command and publication, the first command executes and one
publication is queued against that command's evidence. A later synthetic round
runs the publication only if the command succeeded; failure cancels it. Extra
commands are not replayed automatically.

Requests and hypotheses can be delivered alongside work as `unverified-intent`.
A delivered report must cite at least one actual observed evidence ID. The
controller rejects uncited reports and never relabels success prose as a request.
A report about new work becomes a pending claim for the model to review after
the observation; it must be revised or discarded, never sent automatically as
if successful. Replies proposed alongside work are also retained for review.
A finish waits for observed evidence and requires at least one explicit
assertion; every attached assertion must pass. Unknown evidence references and
assertions for the wrong evidence type are rejected. `checks-passed` describes
only those checks, never whole-mission semantic correctness.

Use `--source guest:/absolute/path` to bind an input. A new family's first step
inspects that guest path before model reasoning and records presence, absence,
unreadability or non-regular-file status, with environment and round. A negative
fact applies only to that path in that VM; host history is not implicitly read.
Evidence kinds distinguish VM stdout, native return values, source facts,
artifact bytes and capture metadata. Assertions are correspondingly typed:
stdout/exit checks, `native_value_equals`, `source_kind`, or `artifact_sha256`.
Capture metadata is not evidence that its JSON text appeared in the source file.

## Hand an actual file to another pocket

Each VM has a separate filesystem: sending `/root/result.txt` as a message does
not send its bytes. A file can be published after observing its producing
command, or publication can be queued alongside that command:

```json
{"actions":[{"type":"publish","path":"/root/result.txt","name":"result"}]}
```

The controller captures regular-file bytes and their SHA-256 digest and records
producer, source path, round and execution environment. The next observations
contain `availableArtifacts` with the real `guestPath` under `/ovm/artifacts`.
Other pockets can read and independently test those bytes through the read-only
VirtioFS mount. They may copy them into their own writable filesystem to work on
them; they cannot modify the canonical shared artifact through the mount.

A publication replaces one VM-command slot for that round. The store accepts
focused artifacts up to 256 KiB each, with 64 blobs and 2 MiB total per family.
Successful capture establishes which bytes were transferred. Recipients still
need to inspect their contents or execute relevant tests before claiming the
artifact satisfies the task. Files in VM disks remain unrestricted by this
handoff budget; the limit applies to this explicit small-artifact channel.

o-gents transfers a VM command as base64 data, reconstructs it inside the guest,
caps ordinary command output at 64 KiB (400 KiB for its fixed artifact capture
receipt), records the actual exit code, then
powers the VM down and preserves its copy-on-write rootfs.
The command field is not joined with its separate reason field or silently
repaired. Raw decisions are retained up to 16 KiB with an explicit truncation
flag, including accepted turns, so later reviews can distinguish model input
from controller normalization.

## Host web search

Every VM-enabled gent (chat, task, resumed family, swarm and spawned child) can
use the controller's SearXNG through the shared host-tool dispatcher:

```json
{"actions":[{"type":"native","operation":"web_search","args":[{"query":"SearXNG documentation","limit":5}]}]}
```

The initiating controller reads `SEARXNG_URL`, defaulting to
`http://127.0.0.1:8081`. For example:

```sh
SEARXNG_URL=http://127.0.0.1:8081 gent task "Find the official SearXNG documentation"
```

The HTTP request runs on the controller host even when the agent's VM runs on
another machine. It requires neither guest access to host loopback nor a VM
boot. Plain `gent chat --text` has no tools and remains plain model chat.
Query size is limited to 1024 UTF-8 bytes, result count to 1–10 (default 5),
response bytes to 2 MiB, and the request including its body to 15 seconds.
The existing limit of two native calls per agent per round also applies.

Results retain source URLs, bounded titles and snippets, engine names, omitted
result counts and SearXNG's `unresponsive_engines`. HTTP, timeout and JSON errors
are recorded as failed native observations, not successful empty searches.
Search snippets are untrusted external data; they do not prove the contents of
the linked pages. The model observes the native result on a later round and can
cite its evidence ID under the existing claim rules. Prompt excerpts can be
truncated; the full bounded result remains in the saved transcript.

## Native capability provider

`capabilities/claude-native.json` maps semantic o-gents names to recovered native
member paths and records whether each mapping is runtime verified or based only
on decoded registration evidence. Install the qualified private binaries into
o-gents's ignored local store, then inspect them:

```zsh
./scripts/install-native-capabilities.zsh
gent native probe
gent native call host.frontmostApp '[]'
gent native call host.displays '[]'
```

`describe()` includes exact operation names, min/max arity, bounded descriptions
and known argument schemas. `host.runningApps` takes `[]`;
`host.processRunning` takes one string and returns a host process query result;
`host.appForFile` takes a host file path and returns its associated application,
not its contents. Unknown native argument types remain unspecified. The full
`host.` prefix is part of each operation name.

The installer discovers `OVM_CLAUDE_EXTRACTED_ROOT`, the local recovered
directory, or Claude's standard unpacked application resources. The broker
prefers the installed `host/native-root/current` copy during ordinary use.

Every addon load and call runs in a disposable Node subprocess. A native crash
therefore fails one capability request instead of terminating the MCP or swarm
controller. Known binary hashes are required by default. Set
`OVM_NATIVE_ALLOW_UNQUALIFIED=1` only after independently qualifying a changed
addon.

Observation capabilities are available by default. Keyboard, pointer, window,
and application actions require an owner-controlled process environment:

```zsh
OVM_NATIVE_ALLOW_ACT=1 gent swarm \
  --mission "exercise the approved desktop workflow" \
  --allow-native-act
```

The Swift desktop addon is not loaded by this provider. In a plain CLI process
it initializes application notification services and aborts because there is no
macOS application bundle. o-gents uses the separately loadable `computer_use.node`
for displays, running applications, and permission status.

## Placement and recovery

Automatic mode prefers available local capacity and keeps an existing family
with its files. Connected compatible controllers provide extra capacity for
new families. All communicating pockets and their descendants stay together;
independent families can occupy different hosts. The initiating controller
keeps model inference, typed mailboxes, evidence and enabled native host actions.
VM commands use the selected host's Apple or QEMU backend. Guest-to-guest
program access uses Nebula plus native Ostadix `o-node`.

`gent connect HOST --name laptop` checks the destination and enrolls its guests in
the shared network. An optional `--path /absolute/path/to/o-gents` locates
its installation; `--node /absolute/path/to/node` selects a private Node 26+
interpreter there. Controllers also need rsync and enough storage for private
copies and checkpoints. `gent peers --discover` lists Tailscale machines without
enrolling them. `gent disconnect laptop` removes placement configuration and
does not revoke network credentials. See [networking](networking.md).

The remote controller records dispatch identity, execution state and generation.
After each completed round, the initiating controller receives stopped-disk
checkpoints. A lost response after submission can mean the command already ran;
o-gents retains that pending dispatch and `gent resume ID` queries its status
before doing more work. It does not replay uncertain commands locally. Known
pre-dispatch rejection or an acknowledged complete checkpoint can permit
automatic local recovery. Required mode and explicit `--on NAME` preserve the
requested destination and report unavailable capacity.

The source-oriented integration `integrations/ostadix/pocket_swarm.O` remains
available. A caller can submit it through an Ostadix hosted node when that host
has a compatible o-gents installation. This is separate from the automatic SSH
controller transport and from guest-native `ovm-peer run`.

## Portable gent capsules

```zsh
gent list
gent show GENT_ID
gent export GENT_ID ~/my-agent.ovm
gent clone GENT_ID my-copy
# On a compatible host:
gent import ~/my-agent.ovm my-imported-agent
gent resume my-imported-agent --mission "Continue the work" --local
```

Stop the gent before export/clone, and reconcile any unresolved dispatch first.
A capsule always contains complete selected model weights, guest root disks,
boot inputs, pocket history and lineage. It preserves private disk bytes and
must be treated as private work. Import creates a fresh instance identity and
selects new active network identities; old guest credential bytes in the archived
disk are retained rather than claiming the disk has been sanitized. Controller
CA signing authority and host native add-ons are outside the capsule.

Imported pockets use their capsule's matching prepared profile and base image;
an incompatible custom profile is refused instead of silently rebuilt from the
checkout's unrelated global base.

The destination needs Node 26+, a model-compatible Ollama server, o-gents and either
the Apple Silicon macOS adapter or QEMU tools on Linux/macOS. The capsule
restores the gent's prepared ARM64 guest and model without downloading those
weights again. An x86 host emulates the ARM64 guest through QEMU TCG. The
capsule does not install the host VM engine or transfer a running VM's memory.
The [capsule-format document](agent-capsule-format.md) describes the archive and
validation contracts. Source-only checkout portability, private capsule
portability and compatible VM-host availability are separate requirements.
Import's optional `--private-model` retains every weight in the gent's private
store without publishing another copy into the host's model store; it does not
start or qualify an inference server. Use the [private-model server commands](agent-capsule-format.md#run-an-imported-private-model)
to serve those weights and select that server when resuming.

## Evidence boundaries

The following observations were recorded on October 4, 2026. They are historical;
the [publication verification](publication-verification-2026-11-06.md) records
the checks rerun for the current repository snapshot.

- The automated suite at that time passed 315/315 tests with no skips:
  `runtime/qemu-portability-20261004/npm-test-final.log`.
- Local QEMU HVF tests retained files through QEMU → Apple → QEMU on the same
  disk, then exercised parent/child mesh and native `o-node` execution returning
  42. A separate five-execution QEMU test validated typed message delivery and
  a 221-byte, seven-line read-only artifact. The receipts are
  `runtime/qemu-portability-20261004/backends-live.json` and `projection-live.json`.
  These are local mechanics tests, separate from the remote proof below.
- The physical x86_64 Linux rack booted the ARM64 guest with QEMU TCG, executed
  Ostadix, guest Node and native Ostadix MCP smoke, and read its persistent marker
  on a second boot. Both stopped cleanly. Boot/command/shutdown times were
  117.9 s and 96.4 s; initial cloning took about 108 s separately. This was
  isolated execution, not cross-host guest networking or distributed placement:
  `runtime/qemu-portability-20261004/rack-boot.json`.
- An actual Mac-to-Linux SSH controller run passed two ARM64 QEMU TCG rounds,
  recovered a lost first admission acknowledgement without replay, and read
  the original persistent write exactly once on the next boot. Generations
  advanced 0 → 1 → 2. Both guests stopped; both checkpoint payloads were released
  after durable local completion and acknowledgement, while the live remote
  disk remained closed and retained. Checkpoint transfers took 60.1 s and 57.4 s.
  An initial rsync quoting failure was fixed before recovering the saved dispatch:
  `runtime/qemu-portability-20261004/rack-controller-cc74c698-78cd-44a8-9b11-b77eea59fd98/controller-live.json`.
- With updated pairing helpers installed in both test guests, native execution
  across the Mac and rack passed: the Mac guest received 42 from the rack guest,
  and a nested reverse native call created the expected unique marker with 42.
  The initiating guest stopped cleanly after 50.4 s, and the receiver returned
  exit 0 and stopped. The successful
  `runtime/qemu-portability-20261004/cross-host-local-live-v2.result.json` and
  `cross-host-rack-live-v2.result.json` are separate from the earlier failure
  retained beside them in `cross-host-local-live.result.json`.
- The exact tested pairing helpers are published in the local built-in image
  after all 47 runtime checks, including native Ostadix MCP, passed. Recipe:
  `4edd16d2ae012b3b73c54a25fb3ff424931a24905e1ad0103f12773bec0ec51d`;
  `runtime/qemu-portability-20261004/pairing-image-refresh.json` records publication.
  The Rack base is published with all four file hashes verified in
  `runtime/qemu-portability-20261004/rack-pairing-image-publication.json`.
  Its fresh isolated guest then passed both helper hash checks, Ostadix hello
  and native MCP smoke with 21 tools, reported `aarch64`, and exited 0/stopped
  after 110.4 s (`rack-pairing-base-boot-v2.json` beside it). The initial harness
  failure from an incorrect service path remains in `rack-pairing-base-boot.json`.
- The owned Rack cold-boot and controller test disks were explicitly removed
  after verification and closed-disk/open-handle checks to reclaim space. The
  receipts, logs, remote dispatch metadata and local controller checkpoint
  remain. Normal checkpoint release itself preserves the live family disk.
  Later cleanup of the fresh-base test disk and redundant old Rack base copy
  retained the local APFS rollback and left about 28.24 GB free:
  `runtime/qemu-portability-20261004/rack-pairing-fixture-cleanup.json`.
  Later admission still depends on available resources.
- The focused protocol/lifecycle suite passed 39/39 on macOS and the Linux rack;
  `runtime/qemu-portability-20261004/rack-qemu-tests.log` records the latter.
  Those tests use dummy processes. A separate real local VM test returned exit
  124 and retained a partial write for inspection on the next boot
  (`runtime/qemu-portability-20261004/deadline-live.json`). A deadline is not a
  rollback of guest effects.
- Actual Spark inference completed a bounded guest-loopback diagnostic after
  a recorded repair normalized quoted exit code `"0"` to numeric 0. One resumed
  reasoning round passed four predicates against the original VM observation,
  without replay. Nmap reported ports 22/80/443 closed on `127.0.0.1`; a stray
  period was unresolved and exactly one IP was scanned. This is not a network
  map (`runtime/qemu-portability-20261004/loopback-live.json`). A fresh capsule
  export with all Spark weights is recorded in `capsule-export.json` beside it;
  that receipt establishes export. The capsule subsequently transferred to the
  Debian Mini and imported full weights into a private model store with restored
  source history and a new instance identity (`debianmini-capsule-import.json`).
- On the x86_64 Core 2 Duo Debian Mini, imported weights and byte-identical
  original history verified. Private Ollama 0.35.0 generated the correct answer
  `4` to a bounded arithmetic prompt in 129.4 s, including 63.6 s model loading,
  then its owned process group stopped cleanly. The existing imported VM booted
  under QEMU TCG without another root-disk clone, read the exact retained marker,
  executed Ostadix hello (`[number] 2`) and reported `aarch64`. It stopped and
  released its lease after 129.3 s; source history remained unchanged. Both
  operations ran in a user/network namespace containing only loopback. This
  proves those offline operations on this host, not broader model correctness:
  `runtime/qemu-portability-20261004/debianmini-offline-proof/evidence.json`.
- A model decision is a proposal. VM output, native call receipts, and peer
  messages are recorded separately in `swarm.json`.
- The controller accepts one VM command or artifact publication per gent round;
  enabled native observations retain their separate per-round bound.
- Native action signatures marked `signature-incomplete` come from decoded
  registration evidence and are disabled by default.
- `completed: true` means every pocket's finish met its explicit predicate gate.
  Passing those selected predicates does not prove the mission's semantic correctness.
- `waitingForUser: true` in chat means the gent yielded a reply or idle turn;
  it is separate from completion. Round-limited work remains saved for resume.
