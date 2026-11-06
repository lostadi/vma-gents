# vma-gents setup and everyday commands

For every command, alias, option, and complete usage examples, see the
[complete command reference](command-reference.md).

o-gents runs directly with Node.js. You do not need to compile JavaScript or
TypeScript. Run these commands from your clone. The installed `gent` shortcut works from
any directory. If the shortcut is missing, use `./bin/gent` from the checkout.

Each persistent VM-backed agent is a **gent**; a team contains **gents**. The
previous `ovm` command remains an alias, including `ovm agent list` and the other
nested saved-agent commands. Use the flat `gent list`, `gent show`, and
`gent resume` forms below. Technical `OVM_*` settings and `.ovm` archives keep
their existing names.

## Start here

```zsh
cd /path/to/vma-gents
./setup.sh
./bin/gent check
./bin/gent chat
```

`gent chat` opens one persistent gent with its own Linux VM. Ask it to run
commands, edit its files, and inspect the results. Later messages continue the
same gent and files. Guest output prints in your terminal and is saved in the
transcript. Use `/status` to see the saved ID and resume command, `/help` for
chat controls, and `/bye` to leave. A conversational reply waits for your next
message; it does not mark the gent's whole mission completed.

```zsh
gent chat "Run Node and report the observed version"
gent chat --resume GENT_ID
gent chat --resume GENT_ID "Read the file we created earlier"
gent chat --text "Explain what a JavaScript runtime does"
```

A quoted message performs one conversational turn and exits. A turn may use
several reasoning/VM rounds; the default chat budget is six. `--rounds N`
changes that budget. `--text` selects plain model conversation without execution.
`--vm` is an optional alias for the default VM-enabled route. For `--text`,
`OVM_CHAT_THINK=true` enables thinking; ordinary text chat disables it.

From the checkout, `npm start` or `bun run start` also opens chat when input
comes from your terminal. `/bye` returns you to the shell. With piped input
and no arguments, `start` preserves the MCP endpoint; `npm run chat` explicitly
selects chat and `npm run mcp` explicitly selects the MCP server.

## Run a task or a team

```zsh
gent task "Run uname -m and report the observed result"
gent task "Create a small Python parser and test it" --agents 3 --rounds 6
gent task --agents 3 --rounds 6 "Create a small Python parser and test it"
gent task "Plan a loopback-only connectivity diagnostic; do not run a scan" --local
gent task "Your task" --dry-run
```

Task/chat options may appear before or after the quoted request. `gent task`
starts one gent by default with a total cap of two, leaving room for a peer
checker when needed. `--agents 3` starts and caps the team at three.
`--max-agents N` explicitly sets the total cap, including child gents;
`--max-agents 1` keeps a single gent and cannot satisfy a distinct-peer review.
Saved tasks retain their cap unless you override it. Task rounds default to four.
An unfinished round-limited task preserves its state so it can be resumed.
`--dry-run` inspects the plan without inference or VM execution. `--json` emits
machine-readable results instead of human progress and output.

Structured Ostadix code runs can publish exact source and have a distinct gent
rerun its original checks. The controller can create that reviewer within the
cap or reactivate a finished peer. See [Ostadix actions and peer review](ostadix-agent-control.md)
for the action format, evidence, and completion rules. Ordinary VM commands and
chat do not require peer review.

Use `gent help`, `gent chat --help`, and `gent task --help` for commands. Guest
programs run inside Linux. Native host observations have separate names such
as `host.runningApps` (no arguments) and `host.processRunning` (one string).
The latter queries a host process; it does not execute the string as a command.
Desktop actions require `--allow-native-act`; VM commands do not need that flag.

## Choose the input explicitly

```zsh
gent task "Inspect this guest history source. Preserve the actual records and report any missing input; do not invent commands or timestamps." --source guest:/root/.bash_history
gent chat --source guest:/root/input.txt "Inspect this source before working from it"
```

`--source guest:/absolute/path` binds an input in the gent's guest. o-gents inspects
that path before the first reasoning step of a new family and records a scoped
fact: present, absent, unreadable, or not a regular file. A missing guest file
does not mean the corresponding host file or another pocket's file is absent.
The inspection records file identity and size where available; it does not
establish that the contents satisfy the task. Host history is not read
implicitly: a host file requires an explicit handoff into the intended guest.

## Control where work runs

```zsh
gent mode                          # Show the saved choice
gent mode auto                     # Default: local first, connected hosts add capacity
gent mode local                    # Keep work here with internet access
gent task "Your task" --local       # Local choice for one invocation
gent task "Your task" --on laptop   # Require this connected host
gent mode required                 # Require a remote VM controller and shared mesh
gent mode auto                     # Restore automatic fallback
```

Automatic mode keeps local work available when optional distribution cannot be
arranged. Local mode retains NAT internet access, installed runtimes, persistent
files, and teams. `--isolated` explicitly disables networking. Required task
mode and `--on NAME` report unavailable capacity instead of silently changing
the destination. An explicit `--on` overrides a saved local default; combining it
with `--local` or `--isolated` is rejected. Direct `gent shell` and normal run/MCP launches remain on this
Mac; their required mode requires the mesh rather than moving the VM.

Communicating pockets and descendants stay on one controller; independent
families can use different hosts. Model inference, mailboxes, and enabled native
host actions stay on the initiating machine. Existing local families retain
their files; moving them to another host is an explicit export/import operation.

## Choose the VM engine

Daily task/chat commands choose an engine automatically:

| Choice | Engine |
| --- | --- |
| `--backend auto` (default) | Apple Virtualization on Apple Silicon macOS; QEMU on Linux and other supported Macs |
| `--backend apple` | Require Apple Silicon macOS |
| `--backend qemu` | Use QEMU, including on Apple Silicon |

An explicit flag overrides `OVM_VM_BACKEND`. Both engines boot the same ARM64
Linux guest and preserve its files. QEMU uses HVF on Apple Silicon, accessible
KVM on ARM64 Linux, or slower TCG software emulation otherwise. An x86 host
still runs an ARM64 guest through TCG.
When a resumed capsule lacks Apple helper inputs, auto selects QEMU even on
Apple Silicon; explicitly choosing an incompatible engine reports an error.

```zsh
gent check --backend qemu
gent chat --backend qemu "Run uname -m and report the observed result"
gent task "Your task" --backend auto
```

QEMU requires Node 26+, `qemu-system-aarch64`, `mke2fs` (e2fsprogs), `python3`,
and `lsof`. Fresh guest provisioning still requires Apple Silicon: a QEMU host
needs a transferred verified prepared guest or an imported gent capsule.
`gent check` inspects the checkout's default guest; an imported family uses its
own matching base/profile when resumed. Direct `gent shell`, normal run and MCP
remain on the Apple backend. Allow space for the base, private pocket copies
and checkpoints; a filesystem without reflinks may allocate full copies.

## Connect another host

Prepare the destination first: run `gent setup` on Apple Silicon, or install the
QEMU prerequisites and transfer a verified prepared guest on Linux/other Macs.
Both controllers need Node 26+ and rsync. Confirm that your existing SSH login
works, then run on the initiating machine:

```zsh
gent peers --discover
gent connect USER@YOUR_OTHER_MACHINE --name laptop
gent peers
gent task "Run uname -m and report the observed result" --on laptop
gent disconnect laptop
```

For a nonstandard installation, add `--path /absolute/path/to/o-gents`.
If Node 26+ is installed privately on that host, select its exact interpreter:

```zsh
gent connect USER@HOST --name rack --path /path/to/vma-gents --node /path/to/node
```

Replace the example paths with that machine's actual paths. This keeps its
system Node unchanged. Discovery lists Tailscale hosts without installing or
enrolling them.
Connect checks the destination and transfers a private network invitation over
SSH, preserving any previous selected network. It grants that trusted controller
network signing authority. Disconnect removes future placement; it does not
revoke existing certificates or stop guests. Enrollment itself does not install
the VM engine or guest image.

Completed remote rounds create stopped-disk checkpoints on the initiating Mac.
If acknowledgement is lost, o-gents retains the original dispatch and queries it on
resume; it does not replay uncertain work locally. `--local` does not bypass an
unresolved dispatch. Modern rsync improves checkpoint transfers. Setup attempts
an optional Homebrew rsync install when distribution is enabled and the
available protocol is older than 30; an ordinary install failure warns and
continues local setup. See [networking](networking.md) for manual enrollment,
peer execution and recovery details.

## Let gents exchange files and check results

```zsh
gent task "Create a small parser, publish its actual file, and have another gent inspect the bytes and run independent tests. Report observed results." --agents 3 --rounds 8
```

Pockets have separate filesystems. Publication captures actual file bytes with
SHA-256, producer and round, then exposes them read-only under `/ovm/artifacts`.
Sending a filename does not transfer it. The handoff budget is 256 KiB per file,
64 blobs and 2 MiB per family; ordinary files in private VM disks are outside
that small-artifact limit.

If a decision includes a VM command and publication, o-gents runs the command and
queues publication for a later controller-managed round only after that command
succeeds. It does not rerun the command to publish. Requests and hypotheses can
be sent alongside work as unverified intent. Reports about newly requested work
are retained for the gent to review against the result, then amend or discard;
they are not automatically delivered as though their claims were proven. Every
delivered report must cite at least one actual prior observation; requests and
explicit hypotheses can omit citations.

A task `finish` requires at least one explicit assertion against observed
evidence, and every attached assertion must pass. A passing exit-code check
checks only the exit code; a source-absence check checks only that scoped source.
Canonical quoted exit codes such as `"0"` become numeric assertions with a
recorded repair; the evidence check itself is unchanged.
A file digest identifies bytes. None alone establishes whole-mission correctness.
Interactive `reply` returns a response and waits for you without completing the
mission. The [gent-pocket guide](agent-pockets.md) describes exact protocol and
evidence types.

## Save, copy, and continue a gent

```zsh
gent list
gent show GENT_ID
gent resume GENT_ID
gent resume GENT_ID --mission "Continue by adding tests" --local
gent chat --resume GENT_ID
gent clone GENT_ID my-copy
gent export GENT_ID ~/my-agent.ovm
# On an already compatible host:
gent import ~/my-agent.ovm my-imported-agent
gent resume my-imported-agent --local
```

Replace `GENT_ID` with an actual saved ID from `gent list`. Examples such
as `hello-work` do not exist until you create them. To choose that name, run
`gent chat --swarm-id hello-work`, send a task, wait for the turn to finish, then
type `/bye`. Opening chat and exiting without sending a message saves nothing.
Check `gent list` before cloning or resuming.

Stop the gent and reconcile pending work
before export/clone. A capsule includes complete selected model weights, private
guest disks and boot inputs, history, and lineage. It can be several gigabytes.
Import preserves lineage, creates a new instance, and selects fresh active guest
network identities. Existing private disk bytes, including any old credentials
saved inside the guest, remain private contents of the archive. The controller
CA signing key and host native add-ons are outside it.

Add `--private-model` to `gent import FILE.ovm ID` to retain complete weights
with that gent without publishing them into the host's Ollama store. Import
does not start or qualify a model server. Follow the [private-model server
commands](agent-capsule-format.md#run-an-imported-private-model) to start it on a
separate loopback port and point o-gents at that server.

The destination needs o-gents, Node 26+, a model-compatible Ollama server, and
either Apple Silicon macOS or QEMU tools on Linux/macOS. An imported capsule
uses its own matching ARM64 guest base/profile; incompatible custom profiles
are refused. It supplies guest inputs and weights, not the host VM engine or
a running VM's memory. See the
[capsule format](agent-capsule-format.md) for the archive contract.

## Setup and guest tools

On Apple Silicon, `gent setup` installs JavaScript dependencies, the local model
and missing VM inputs, then prepares Ostadix and its runtimes inside a staged Linux guest.
The first guest build can take tens of minutes; progress and log paths print
in the terminal. It is automated, and the old disk is retained before a verified
replacement is published. Later runs reuse the current prepared profile.

```zsh
node --version                         # Host requires Node 26+
npm --version
curl -fsS http://127.0.0.1:11434/api/version
gent guests status                     # Saved installation evidence, no boot
gent guests check                      # Boot a fresh copy and rerun runtime checks
gent guests setup                      # Prepare/update; stop active VMs first
gent shell                             # Interactive Linux guest shell
```

The default model is `huihui-ai/Huihui-Spark-X2.5-4B-abliterated`, supplied as
[okenk's Q4_K_M GGUF](https://huggingface.co/okenk/Huihui-Spark-X2.5-4B-abliterated-GGUF)
and installed under `huihui-spark-vm:32k`. Its download is about 2.6 GB. The alias
sets a 32768-token context; gent requests use 8192 unless
`OVM_SWARM_CONTEXT=32768` is set. Spark inference was verified with **Ollama
server 0.35.0**; 0.33.2 rejected `spark2_5`. The running server can differ from
the `ollama` CLI on PATH. Installed weights alone do not prove engine support.

The prepared guest includes native ARM64 `O`, `o`, `olangc`, `o-link`, `o-node`,
`octl`, `ostadix-mcp`, and Ostadix's C17/Python reference interpreters. Runtime
checks cover Python, Node, Bash, Rust/Cargo, C/C++, Ruby, Java, SQLite, Haskell,
OCaml, Racket, Common Lisp, C#/Mono, Octave, Nix evaluation, and WebAssembly tools.
This does not promise every application package: for example, the earlier
`nmap` attempt found no installed nmap. Licensed Mathematica, nested Multipass,
NixOS fixtures and isolated Nix derivation builds are not qualified by these
checks; the last image reported a missing `nixbld` build-users group.

Guest Ostadix is at `/opt/ostadix`, with backends at `/opt/ostadix/backends`.
`/etc/ovm/mcp.json` configures its stdio MCP server for a client inside the guest.
The host `npm run mcp` server controls o-gents; it is a separate server and waits
for an MCP client. For client configuration, use `bin/claude-vm-mcp` directly
to avoid package-manager banners on protocol output. See the
[OpenCode integration](../integrations/opencode/README.md).

## Fresh setup on another Apple Silicon Mac

A source-only installation needs macOS 14+, Node 26+, npm, a compatible Ollama
server, and qualified private Claude Desktop VM/helper inputs. A capsule supplies
its archived guest inputs and weights but still needs the host adapter.
Install Node with Homebrew, and install a Spark-compatible Ollama macOS app
release; server 0.35.0 was verified. After installing the app:

```zsh
brew install node
node --version
open -a Ollama
curl -fsS http://127.0.0.1:11434/api/version
```

On this Mac the Ollama app supplies the compatible server. The older Homebrew
CLI/server was 0.33.2 and could not load Spark. Use `ollama serve` only after
verifying that the CLI installation also supplies a compatible server; leave
that terminal open and use another for setup. If a compatible server is already
running, keep it rather than starting a competing one.
With access to the private repository, clone the source without any host's
private `runtime/` and `vm/` state:

```zsh
git clone git@github.com:lostadi/o-gents.git
cd o-gents
./setup.sh
./bin/gent check
./bin/gent chat "Run uname -m and report its output"
```

The root `setup.sh` delegates to `./bin/gent setup`; both use the same installer.
Use `./setup.sh --help` to inspect requirements without installing anything.
Setup installs signed Swift launchers and the `~/.local/bin` shortcut. Private
inputs must match the qualified profile in [compatibility](../compatibility/README.md).
An existing bundle is not recloned. Optional Swift rebuilding uses
`npm run build:native` and Xcode Command Line Tools. Daily use needs no
TypeScript or JavaScript compilation; Node executes `.mjs` directly. `index.ts`
is a separate demonstration and is not o-gents's entrypoint.

Ostadix and its MCP are bundled guest capabilities. The host application needs
Node and its selected VM backend; ordinary `gent` use does not depend on a host
Ostadix installation. Optional host `.O` examples and `gent node` need their
separately installed Ostadix tools.

## Use a prepared gent on a QEMU host

Install Node 26+, npm, a Spark-compatible Ollama server, and the QEMU tools
listed above. Copy the source checkout and your private `.ovm` capsule to the
destination. With Node 26+ on PATH and Ollama running:

```bash
cd /absolute/path/to/o-gents
node --version
npm ci
./bin/gent import ~/my-agent.ovm my-imported-agent
./bin/gent chat --resume my-imported-agent --backend qemu "Read our saved files and run uname -m"
```

Import restores the included model weights for local use. You can keep using
`./bin/gent`; no JavaScript/TypeScript compilation or global npm installation is
needed. For a new family instead of an imported one, first transfer the complete
verified prepared default guest and its profile, then run
`gent check --backend qemu`. `gent setup` cannot build a fresh guest on a QEMU host
yet. The x86_64 Linux rack has booted the ARM64 guest with TCG, executed Ostadix
and its MCP smoke check, and preserved a file across a second boot. The measured
results below distinguish this from cross-host networking and placement tests.

## Troubleshooting and rollback

- Command missing: run `./bin/gent` from the checkout; ensure `~/.local/bin` is on PATH.
- Blank terminal after launching MCP: press Ctrl+C, then run `gent chat`. MCP waits for client protocol messages.
- Missing saved gent: run `gent list` and use an existing ID, or create one with `gent chat --swarm-id NAME` and send a message before leaving.
- Missing model/server: start the compatible app with `open -a Ollama`, run `gent setup`, then try `gent chat --text "Reply with ready"`.
- Unsupported `spark2_5`: update the running Ollama server and check its `/api/version`; 0.35.0 was verified.
- Optional mesh unavailable: use `gent mode auto` or `gent task "Your task" --local`; `gent network status` shows the reason.
- Chosen host unavailable: check `ssh HOST`, `gent peers`, and destination setup. Required/explicit placement stays strict.
- Remote Node too old: pass `--node /absolute/path/to/node` to `gent connect`; an interactive SSH shell's Node selection may differ from a controller's noninteractive login.
- QEMU prerequisites missing: use `gent check --backend qemu`; provide all four host tools and a verified prepared guest. TCG on a different host architecture is expected to be slower.
- Unknown execution outcome: retain the saved state and use resume to query its receipt. Do not issue the write again merely because an acknowledgement was lost.
- Round limit reached: inspect `gent show ID`, then continue with `gent resume ID --rounds 6` or `gent chat --resume ID`. A limit is not a completion result.
- Missing input: inspect the scoped source fact. Provide the intended input; a missing guest file does not justify invented history.
- Base image in use: stop active VMs before `gent guests setup`. Failed staging/logs and previous disks remain available for diagnosis.
- Normal run/MCP blocked by resources: `gent status` reports its current 20 GiB disk minimum and memory policy. Chat/task fleets have their own checks.

To try another installed model, use `gent task "Your task" --model NAME`.
Guest refreshes preserve previous disks; inspect the retained logs and backups
before restoring an earlier environment.

## Prepared guest and network verification, 2026-10-04

These are observed checks, not promises that every autonomous mission succeeds.
Private evidence lives in the checkout's ignored `runtime/` and `vm/` directories.

| Check | Observed result | Evidence |
| --- | --- | --- |
| Current automated suite | 315/315 tests passed with no skips, including QEMU backend, capsule, controller and assertion-normalization regressions. | `runtime/qemu-portability-20261004/npm-test-final.log` |
| Linux rack ARM64 guest | QEMU TCG on x86_64 Linux executed Ostadix, Node and native Ostadix MCP smoke; a second boot read the saved marker. Both stopped cleanly. First boot/command/shutdown: 117.9 s, including 20.0 s guest execution; second: 96.4 s. Initial disk cloning took about 108 s separately. Networking was isolated. | `runtime/qemu-portability-20261004/rack-boot.json` |
| QEMU backend portability | On this Mac, the same guest disk retained files through QEMU → Apple → QEMU. QEMU parent and child used the shared mesh and native `o-node` to return 42. Both used local HVF acceleration. | `runtime/qemu-portability-20261004/backends-live.json` |
| QEMU artifact/action flow | Five real QEMU executions delivered typed messages, queued publication and independent inspection of an exact 221-byte, seven-line read-only artifact. Decisions were scripted; this does not test model reasoning. | `runtime/qemu-portability-20261004/projection-live.json` |
| QEMU protocol and process cleanup | Focused suite passed 39/39 with no skips on both macOS and the Linux rack, including controller loss and surviving-descendant cleanup. Uses dummy processes, not Linux VM boots. | `runtime/qemu-portability-20261004/rack-qemu-tests.log` |
| QEMU command deadline | A real local HVF guest returned exit 124 after its deadline; a subsequent boot read the preserved partial write. A timed-out command can have effects even though it did not complete. | `runtime/qemu-portability-20261004/deadline-live.json` |
| Actual Spark loopback diagnostic | Spark installed Nmap and observed ports 22/80/443 closed on `127.0.0.1`. Four initial rounds stalled on a quoted exit code; after its recorded normalization, one resumed reasoning round passed four assertions without replaying the VM command. A stray period was an unresolved extra target; Nmap reported one IP scanned. No network map was produced. | `runtime/qemu-portability-20261004/loopback-live.json` |
| Cross-host controller recovery | Actual SSH placement from this Mac to the Linux rack passed two ARM64 QEMU TCG rounds and generations 0 → 1 → 2. A lost admission acknowledgement recovered without VM replay; the second boot observed the original write exactly once. Both guests stopped, checkpoints were durably saved and acknowledged, and both remote snapshot payloads were released. The live remote disk remained closed and retained. | `runtime/qemu-portability-20261004/rack-controller-cc74c698-78cd-44a8-9b11-b77eea59fd98/controller-live.json` |
| Cross-host checkpoint transfer | The two real SSH checkpoint transfers took 60.1 s and 57.4 s. An initial rsync quoting defect was fixed and the saved dispatch resumed without VM replay. These are observed timings for this run, not general network throughput promises. | Same cross-host controller receipt above. |
| Cross-host guest native pairing | After installing updated helpers in both test guests, Mac guest → rack guest native execution returned 42 and a nested reverse native call produced the expected unique marker with 42. The initiating guest stopped cleanly after 50.4 s; the receiver returned exit 0 and stopped too. The earlier reciprocal-pairing failure remains recorded. | `runtime/qemu-portability-20261004/cross-host-local-live-v2.result.json` and `cross-host-rack-live-v2.result.json`; earlier failure: `cross-host-local-live.result.json` beside them. |
| Fresh full-weight capsule export | Exported a 6.5 GiB private `spark-agent.ovm` with all selected model weights. | `runtime/qemu-portability-20261004/capsule-export.json` |
| Linux Mini capsule import | Transferred and imported the capsule on x86_64 Debian with full weights in a private model store, restored source history and a new instance identity. Import alone did not establish inference or guest boot. | `runtime/qemu-portability-20261004/debianmini-capsule-import.json` |
| Linux Mini offline inference | On the Core 2 Duo Debian Mini, private Ollama 0.35.0 loaded byte-verified imported Spark weights and answered a bounded arithmetic prompt with `4` inside a user/network namespace containing only loopback. Request: 129.4 s, including 63.6 s model loading; the owned process group stopped cleanly. | `runtime/qemu-portability-20261004/debianmini-offline-proof/evidence.json` |
| Linux Mini offline imported VM | In that same isolated namespace, the existing imported disk booted with QEMU TCG, read the exact retained marker, executed Ostadix hello (`[number] 2`) and returned `aarch64`. Boot/command/shutdown: 129.3 s. The guest stopped, its lease released, no extra root clone was created, and original source history remained byte-identical. | Same Mini offline proof above. |
| Pre-QEMU automated suite | 227/227 tests passed with no skips. `ovm check --json` reported ready chat/task prerequisites and no normal-route blockers. The 145-file package dry-run contained no private runtime files; signed prebuilt checksums passed. | `runtime/distribution-final-20261004/unit-final.log` |
| Real artifact/action flow | A deterministic controller test used two real VMs and five executions in 12.926 seconds: queued publication, immediate request, reviewed report, scoped missing-source fact and independent inspection of an exact read-only seven-line artifact. This tests execution mechanics, not model reasoning. | `runtime/distribution-final-20261004/projection-live.json` |
| Persistent VM chat | Initial corrected chat returned Node `v22.23.3` and `CHAT_VM_PERSISTED`, then replied in round 6. A separate resume appended `SECOND_CHAT_TURN`, read both lines and replied in round 9. It waited for the user without marking the agent finished. An early failed capture was retained and recovered. | `runtime/distribution-final-20261004/chat-live.json` |
| Earlier same-Mac controller recovery | Actual detached worker, VM and immutable checkpoint on the same Mac recovered a lost acknowledgement. The original persistent write executed once; the next round observed it exactly once. | `runtime/distribution-final-20261004/controller-live.json` |
| Earlier same-Mac checkpoint transfer | That same-Mac trial measured 70.4 s using Homebrew rsync 3.5.1 versus 598.8 s in the earlier system-rsync transfer. This is one local test, not a cross-network benchmark. | `runtime/distribution-final-20261004/controller-live.json` |
| Capsule infrastructure | A 6.96 GB capsule restored full weights in a private model store, byte-identical original history and a new instance identity. Isolated imported VM rounds 7–12 read the retained file, executed Ostadix hello and returned `aarch64`. Review round 13 passed predicates using those prior results; a harness requiring another fresh command in that review-only invocation failed. Earlier repeated reads reached round limits. | `runtime/distribution-final-20261004/capsule-proof.json` |
| Local/fallback/required modes | Five real boots preserved files, Ostadix, NAT, DNS and HTTPS where allowed; required mode refused before executing the task. Normal MCP local and mesh paths passed and cleaned up. | `runtime/distribution-live-20261004-1791116914171/validation.json` |
| Published local pairing-helper image | The exact tested pairing helpers are published in the local built-in image after 47/47 runtime checks, including native Ostadix MCP. Recipe: `4edd16d2ae012b3b73c54a25fb3ff424931a24905e1ad0103f12773bec0ec51d`. The Rack base is also published with all four hashes verified (`rack-pairing-image-publication.json` beside the local receipt). | `runtime/qemu-portability-20261004/pairing-image-refresh.json` |
| Refreshed Rack base boot | A fresh isolated QEMU TCG guest verified both pairing-helper hashes, reported `aarch64`, executed Ostadix hello and passed native MCP smoke with 21 tools. It exited 0 and stopped after 110.4 s. The earlier harness failure used an incorrect service path and remains recorded. | `runtime/qemu-portability-20261004/rack-pairing-base-boot-v2.json`; original harness failure: `rack-pairing-base-boot.json` beside it. |
| Earlier routing/DHCP guest refresh | Base and existing witness each passed 47 runtime/MCP checks. Earlier recipe: `4a9967efe5d248228ce2444d9913ba75b69ad2dbd276e7c1d2e55635ba972032`. | `runtime/guest-refresh-20261004/latest.json` |
| Historical suite | 120/120 tests passed before the distribution/chat/protocol changes. This is not the current final suite count. | `runtime/guest-provision-20261004/unit-final.log` |
| Historical terminal output | An earlier task printed `ovm-output-ok` and `aarch64` directly and completed in two rounds under its then-current protocol. | `runtime/spark-terminal-output-20261004-0520/verification.json` |

Mac-to-Linux distributed controller placement, stopped-disk checkpoint transfer
and lost-acknowledgement recovery are now verified. Native guest execution across
those hosts passed in both directions with updated helpers installed in the test
guests. Those helpers are now published in the local built-in image after 47/47
runtime/MCP checks. The Rack base is published with all four hashes verified,
and its fresh isolated boot passed helper hashes, Ostadix and native MCP smoke.
The earlier physical rack's native Ostadix/overlay results cover different endpoints.
The Mini's offline imported-model inference and imported-VM persistence both
passed inside a namespace containing only loopback. These are bounded functional
checks on that Linux host. Placement on another Apple Silicon Mac remains
untested because the MacBook Air was offline.

After verification, the owned Rack cold-boot and controller test disks were
explicitly removed to reclaim space after closed-disk/open-handle checks.
Receipts, logs, remote dispatch metadata and the local controller checkpoint
remain. Normal checkpoint release preserves the live family disk; this was
separate cleanup of completed test fixtures. The later fresh-base test disk and
redundant old Rack base copy were also removed after closed-disk checks; the local
APFS rollback remains. `runtime/qemu-portability-20261004/rack-pairing-fixture-cleanup.json`
records about 28.24 GB free afterward. Admission continues to check current
capacity rather than treating this measurement as a reservation.
See [networking](networking.md) and the [historical validation record](validation-history.md)
for the retained earlier peer, normal-MCP, Spark and Jan-era records.
