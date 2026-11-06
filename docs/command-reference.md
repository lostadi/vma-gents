# o-gents complete command reference and use guide

Checked against this checkout's CLI help and parsers on 2026-10-04.
Run commands in Terminal or Warp. No JavaScript or TypeScript compilation is
needed. On Lee's Mac, `gent` is installed at `~/.local/bin/gent` and points to
`/path/to/vma-gents/bin/gent`.

This reference covers the public o-gents commands, aliases, daily options, model
settings, saved gents, and advanced launchers. Host-installed Ostadix and
Ollama have their own command catalogs. The setup walkthrough is in
[getting-started.md](getting-started.md); full capsule details are in
[the capsule format](agent-capsule-format.md).

Each persistent VM-backed agent is called a **gent**; multiple instances are
**gents**. `gent` is the primary CLI. `ovm` remains an alias, and nested forms
such as `ovm agent show ID` and `gent agent show ID` remain compatible. New
examples use `gent show ID`. The `OVM_*` environment variables, guest paths,
and `.ovm` archives retain their technical names.

## 1. Start using this installation

The current Mac is already set up. Start with:

```bash
gent check
gent chat
```

If `gent` is not found:

```bash
cd /path/to/vma-gents
./bin/gent check
./bin/gent chat
```

For first-time setup or a missing setup component on a compatible Apple
Silicon Mac, run `./setup.sh` (or `./bin/gent setup`) from the checkout. It installs dependencies
and the Spark model, prepares guest tools, and configures the shared network.
It requires Node 26+, npm, compatible Ollama and local private VM inputs.
Fresh guest provisioning uses Apple Silicon; QEMU hosts use a transferred
prepared guest or an imported capsule. See the setup guide for prerequisites.

## 2. Talk to a gent with its own VM

```bash
gent chat
gent chat --swarm-id my-helper
gent chat --resume my-helper
gent chat --local
gent chat --on rack
```

Without a quoted message, chat is interactive. Every message continues the
same gent and private Linux VM. Example messages to type at `you>`:

```text
Run Node and Python and report their actual versions.
Create /root/hello.py that prints hello, then run it.
Read /root/hello.py and show its contents.
```

| Chat control | Effect |
| --- | --- |
| `/status` | Show the gent ID, saved state path, and resume command. |
| `/help` | Show chat controls. |
| `/bye`, `/exit`, `/quit` | Leave chat. Saved files/history remain. |
| Ctrl+D | End input and leave the interactive session. |
| Ctrl+C | Interrupt the current turn or leave an idle prompt. An uncertain remote result must be reconciled on resume. |

A quoted message performs **one conversational turn and exits**. A turn can
contain several model/execution rounds. Resume the printed ID for another turn:

```bash
gent chat "Run Node and report its actual version"
gent chat --resume my-helper "Read the file we created earlier"
```

Plain model conversation:

```bash
gent chat --text
gent chat --text "Explain what a virtual machine is"
gent chat --text --model huihui-spark-vm:32k "Explain this code"
```

`--text` does not dispatch VM work. `--vm` explicitly selects the default
VM-enabled route. VM chat starts one gent; use `gent task --agents N` for a team.

## 3. Run a task, team, or growing family

```bash
gent task "Run uname -m and report the observed result"
gent task "Create a small Python parser, run tests, and show the results" --swarm-id parser-work --rounds 6
gent task "Build a parser and independently verify its output" --agents 3 --rounds 8
gent task "Investigate this problem; create helpers if needed" --agents 1 --max-agents 4 --rounds 8
gent task --local --rounds 6 "Run Python and inspect its version"
gent task "Inspect the Linux environment" --dry-run
```

Options can precede or follow the quoted mission. Default task: one gent,
maximum two gents, four reasoning rounds. The spare capacity permits a peer
checker without starting a second gent immediately. `--agents 3` both starts and caps the
team at three unless you also supply `--max-agents`. Child gents need room
under that cap. Round limits preserve unfinished state; they do not establish
completion. Continue with `gent resume ID --rounds 8`. Saved tasks keep their
cap unless you override it; use `gent resume ID --max-agents 2 --rounds 8` when
a single-gent task needs room for a distinct code reviewer.

### Task and VM-chat options

| Option | Meaning / default |
| --- | --- |
| `--agents N` | Initial team size, 1–8. Task default 1; VM chat requires 1. |
| `--max-agents N` | Total cap including descendants, 1–16 and at least the initial count. A new task/VM chat defaults to the larger of 2 and its initial count, unless its specification sets a cap. Resume retains the saved cap. An explicit 1 prevents creation of a distinct reviewer. |
| `--rounds N` | Reasoning rounds for this invocation, 1–20. Task default 4; chat default 6. |
| `--model NAME` | Select an installed Ollama model. Default `huihui-spark-vm:32k`; resume otherwise retains its saved model. |
| `--swarm-id ID` | Give a new family a memorable ID. Existing IDs require resume. |
| `--resume ID` | Continue saved state; a supplied task/message becomes the new request. |
| `--source guest:/PATH` | Inspect and bind an absolute guest input path before new-family reasoning. |
| `--local` | Keep execution on this machine, with NAT internet access. |
| `--on NAME` | Require a connected controller. Overrides a saved local default. |
| `--distribution auto\|local\|required` | Override distribution policy for this invocation. |
| `--isolated` | Disable guest networking for this invocation and descendants. Cannot combine with `--on`. |
| `--backend auto\|apple\|qemu` | Choose VM engine. Explicit flag overrides `OVM_VM_BACKEND`. |
| `--memory-mb N` | Memory per VM, 512–4096 MiB; default 768. |
| `--cpu-count N` | Virtual CPUs per VM, 1–4; default 1. |
| `--allow-native-act` | Permit cataloged desktop actions on the initiating host. Guest commands need no such flag. |
| `--state-dir PATH` | Advanced: parent directory under which the family ID is stored. Use the same option when resuming custom locations. |
| `--spec FILE.json` | Task/advanced swarm specification; not accepted by VM chat. |
| `--dry-run` | Inspect configuration without model inference or VM execution. |
| `--json` | Machine-readable output. Chat requires a quoted one-shot message with this option. |
| `--` | End options before a single quoted mission, useful if it begins with `-`. |
| `--help`, `-h` | Show task/chat usage. |

Example with resource and growth limits:

```bash
gent task "Build and test a small program" --agents 3 --max-agents 5 --memory-mb 1024 --cpu-count 2 --rounds 8
```

### Explicit sources and artifact sharing

```bash
gent task "Inspect the actual history in order; report missing data without inventing entries" --source guest:/root/.bash_history
gent task "Create a parser, publish its real file, and have another gent inspect the exact bytes and test it" --agents 3 --rounds 8
```

The guest's history is not your Mac terminal history. A host file needs an
explicit handoff into the intended guest. Each pocket has its own filesystem;
the same pathname in two pockets need not identify the same file. Published
artifacts carry bytes, digests and provenance and appear read-only under
`/ovm/artifacts`. Small-artifact limits: 256 KiB per file, 64 blobs, 2 MiB total
per family. VM disks and capsule exports are separate from this limit.

## 4. Inspect, resume, copy, export, and import

Replace `ID` with an ID from `gent list`; it is not a literal command value.
Example IDs such as `hello-work` must first be created by a task or a chat turn.
To create one, use `gent chat --swarm-id hello-work`, send your task, wait for the
turn to finish, and type `/bye`. Opening and closing an empty chat saves nothing.
IDs use 1–48 lowercase letters, digits, underscores or hyphens and start with a
letter or digit. One listed ID can contain a family of multiple pocket VMs.

| Command | Effect |
| --- | --- |
| `gent list` | List saved families in the default state location. |
| `gent show ID` | Show mission, status, model, pocket names, rounds and state path. |
| `gent show ID --json` | Inspect the full structured saved state. |
| `gent resume ID` | Continue the saved task. |
| `gent resume ID --rounds 8` | Continue with another reasoning budget. |
| `gent resume ID "New task"` | Continue its existing VM/history with a new mission. |
| `gent resume ID --mission "New task"` | Equivalent explicit mission form. |
| `gent chat --resume ID` | Continue conversationally. |
| `gent task "New task" --resume ID` | Continue through the everyday task interface. |
| `gent clone ID NEW_ID` | Create a separate local replica with full weights and new identity. |
| `gent export ID FILE.ovm` | Export stopped disks, boot inputs, history, artifacts and complete weights. |
| `gent import FILE.ovm [NEW_ID]` | Restore a new instance; default also publishes verified model files to the host Ollama store. |
| `gent import FILE.ovm NEW_ID --private-model` | Retain complete model files privately with the imported gent. |
| `gent help` | Show everyday commands, including saved-gent operations. |

List/show/clone/export/import accept `--json`. Resume accepts swarm options.
Export and clone require the source gent and its disk users to be stopped.
Leave chat with `/bye`, let the task end, or interrupt its active terminal and
allow shutdown. There is no `gent agent stop` or `gent agent delete` command.
`gent stop` controls the separate resident VM, not every gent.

Example:

```bash
gent show parser-work
gent resume parser-work "Add more tests and run them" --rounds 8
gent clone parser-work parser-experiment
gent export parser-work ~/parser-work.ovm
```

Copy `~/parser-work.ovm` to the destination with your normal file transfer, then
run there from an installed o-gents controller:

```bash
gent import ~/parser-work.ovm parser-copy
gent chat --resume parser-copy
```

Weights are always included. Import retains original history separately and
creates a new instance identity; it neither replays old commands nor starts
Ollama or a VM. Host VM engines, the o-gents controller and Ollama executable remain
host prerequisites. If a remote outcome is unresolved, resume to reconcile it
before exporting or cloning. See [capsule format and private-model serving](agent-capsule-format.md).

## 5. Choose local, automatic, or remote execution

```bash
gent mode
gent mode auto
gent mode local
gent mode required
gent mode auto
```

| Choice | Behavior |
| --- | --- |
| `auto` | Local first; connected compatible hosts add capacity. Optional mesh failure preserves local work. |
| `local` | Keep execution here with ordinary internet access. |
| `required` | Gent task/chat requires a remote controller and shared mesh; reports failure instead of local fallback. |
| `--local` | One-invocation local choice. |
| `--on rack` | One-invocation explicit host; no silent substitution. |
| `--isolated` | Disable networking, unlike local mode. |

```bash
gent peers
gent peers --json
gent peers --discover
gent connect USER@HOST --name laptop
gent connect USER@HOST --name laptop --path /absolute/path/to/o-gents --node /absolute/path/to/node
gent task "Run uname -m and report the result" --on rack
gent chat --on rack
gent disconnect laptop
```

`mode`, `peers`, `connect`, and `disconnect` accept `--json` and `--help`.
Discovery lists Tailscale hosts; it does not install or enroll them. Connect
requires working trusted SSH and a prepared compatible controller, Node 26+
and rsync. It enrolls that controller into the shared network. Disconnect
removes future placement; it does not stop VMs or revoke existing certificates.

Connected
capacity is checked at dispatch; a successful readiness probe is not proof
that arbitrarily large teams fit. A communicating family and its descendants
stay on one controller. Independent families can occupy different hosts.
Inference, mailboxes and native host actions remain on the initiating machine.
Use export/import to move an existing local family with its files.

## 6. VM engine, setup, and model settings

```bash
gent check
gent check --json
gent check --backend qemu
gent setup
gent task "Run uname -m" --backend auto
gent chat --backend qemu
```

`auto` selects Apple Virtualization on Apple Silicon and QEMU on other supported
Linux/macOS hosts; a QEMU-only imported capsule selects a compatible engine.
The guest is ARM64 Linux. QEMU uses hardware acceleration where available and
software emulation on x86. Fresh `setup` provisioning remains Apple-only.
`check` inspects prerequisites; it does not boot, infer, or test live peer traffic.

Common environment settings apply to a single command when written before it:

```bash
OVM_MODEL_TIMEOUT_SECONDS=300 gent chat
OVM_OLLAMA_URL=http://127.0.0.1:11439 gent chat --resume my-agent
OVM_SWARM_CONTEXT=16384 gent task "Your task"
OVM_VM_BACKEND=qemu gent chat
OVM_CHAT_THINK=true gent chat --text
```

| Variable | Purpose |
| --- | --- |
| `OVM_MODEL_TIMEOUT_SECONDS` | Per-model-decision deadline, integer 1–3600; default 90. Does not change VM command deadlines. |
| `OVM_OLLAMA_URL` | Inference server URL; default `http://127.0.0.1:11434`. |
| `OVM_SWARM_MODEL` | Default model selection; a saved gent otherwise retains its model. `--model` is the direct override. |
| `OVM_SWARM_CONTEXT` | Requested model context; default 8192 tokens. Larger requests consume more memory. |
| `OVM_VM_BACKEND` | Default `auto`, `apple`, or `qemu`; a flag takes precedence. |
| `OVM_CHAT_THINK` | `true` or `false` for plain `--text` chat; default false. |
| `OVM_NETWORK_MODE` | `nat` or `isolated`; prefer the daily flags. |
| `OVM_DISTRIBUTION_MODE` | Distribution default; prefer `gent mode` or `--distribution`. |
| `OVM_NATIVE_ALLOW_ACT=1` | Enables cataloged host actions; prefer the per-command `--allow-native-act`. |

Model maintenance from the checkout (these are npm/Ollama commands, not
additional `gent model` subcommands):

```bash
cd /path/to/vma-gents
npm run model:setup
ollama list
npm run model:chat
```

`model:setup` downloads the Spark Q4_K_M GGUF and creates
`huihui-spark-vm:32k`. Use the already qualified Spark-compatible Ollama server;
on this Mac `open -a Ollama` starts the app installation. `model:chat` is plain
Ollama conversation. Private imported weights need a server pointed at their
`capsule-models` directory; [exact commands are here](agent-capsule-format.md#run-an-imported-private-model).

## 7. Output, saved files, and recovery

Guest output prints between labeled blocks. Human progress is printed as rounds
proceed. `--json` replaces human output with a structured result. Save the
human transcript too with a normal terminal pipeline:

```bash
gent task "Your task" 2>&1 | tee ~/gent-session.log
gent task "Your task" --json > ~/gent-result.json
gent show ID --json > ~/gent-state.json
```

Default state location:

```text
/path/to/vma-gents/vm/pockets/ID/swarm.json
```

The state includes observations, messages, summaries and artifact references;
guest root disks remain with the family. A guest file such as `/root/result.txt`
is inside that gent's Linux disk, not automatically a Mac file. Ask the gent
to display it or publish it for peers. The terminal transcript is not a claim
that every named deliverable was saved correctly.

| Situation | Command / action |
| --- | --- |
| Need setup diagnosis | `gent check` |
| Missing or stopped model server on this Mac | `open -a Ollama`, then `gent check` |
| Want to see saved gents | `gent list` |
| Round limit reached | `gent resume ID --rounds 8` |
| Continue conversationally | `gent chat --resume ID` |
| Slow inference | `OVM_MODEL_TIMEOUT_SECONDS=300 gent chat --resume ID` |
| Optional distribution unavailable | `gent mode auto` or a new `gent task "..." --local` |
| Need disconnected guest | `gent task "..." --isolated` |
| Remote result uncertain | Resume the same ID and let o-gents reconcile the original dispatch; do not make an independent replay. |
| Want to copy a gent | End its active turn, then `gent clone ID NEW_ID`. |

Task exit 0 means its runtime completion checks passed; exit 2 means unfinished
or reconciliation is needed. Chat also returns 0 when it has replied and is
waiting for input. These statuses are not general proof of mission correctness.

## 8. Advanced command catalog

The advanced catalog and exact network/native/guest forms follow below. Daily
Gent users normally need sections 1–7. The advanced `swarm` interface defaults
to three initial gents and maximum eight, unlike everyday `task`.

```bash
gent help
gent help --all
gent task --help
gent chat --help
gent agent --help                    # Compatibility help for saved-gent operations
gent swarm --help
gent swarm --mission "Build and independently verify a parser" --agents 3 --rounds 8
gent swarm --spec examples/pocket-swarm.json --dry-run
gent swarm --spec examples/pocket-swarm.json
```

`swarm` aliases: `pocket`, `agents`. Specifications accept `mission`, `model`,
`swarmId`, `stateDirectory`, `agentCount` or an `agents` list, `rounds`,
`maximumAgents`, `memoryMB`, `cpuCount`, and `backend`. Each gent entry has an
`id`, `role`, and optional `mission`. Keep ordinary commands on `gent task` unless
you need a specification file.

### Built-in guest environment

```bash
gent guests
gent guests status
gent guests status --json
gent guests setup
gent guests setup --source /path/to/OSTADIX
gent guests setup --force
gent guests check
gent guests --help
```

`status` reads the preparation profile. `setup` builds a staged guest and
publishes it with a root-disk backup; `--force` rebuilds. `check` boots a fresh
clone and executes runtime checks, and may prepare/update the image first.
All three accept `--json`. Setup/check use the Apple provisioning launcher;
QEMU hosts consume transferred or imported prepared images. These commands
manage built-in Ostadix, its MCP, and the major guest language runtimes.

### Shared network administration

Normal users can use `gent connect` rather than manual invitation handling.
All `network` results are JSON; `--json` is accepted but does not change that.

| Command | Effect |
| --- | --- |
| `gent network` / `gent network --help` | Network usage; `network help` also works. |
| `gent network status` | Inspect configuration/process state, not live guest reachability. |
| `gent network create [NAME] [--endpoint HOST:4242]` | Create authority/configuration; omitted endpoint uses discovery, preferring Tailscale. An existing network is reused, not reconfigured. |
| `gent network start` | Create a missing network and start the owner's detached lighthouse. |
| `gent network export [CONTROLLER_NAME] --out FILE` | Allocate a controller block and write a new private authority-bearing invitation. |
| `gent network join FILE` | Join an invitation; refuses to replace a selected network. |
| `gent network guest GUEST_ID` | Allocate/update a guest identity and registry entry; does not boot it. |

These commands accept `--state-dir DIR`. For a separate persistent selection,
set `OVM_NETWORK_STATE` consistently for both administrative and later launch
commands. Invitation files contain signing authority; transfer them only to
the intended trusted controller. No `network stop`, `reset`, or `delete`
subcommand is implemented.

The internal preparation route is also present:

```text
gent network prepare GUEST_ID [--bundle PATH] [--image ROOTFS]
  [--distribution auto|local|required] [--runtime-only] [--state-dir DIR]
```

It can provision/upgrade images and start networking; it is not a read-only
probe. Daily launchers call this machinery as needed.

### Commands inside each guest

These are Linux guest commands. Ask a VM gent to execute them, or use a guest
terminal; they are not additional host `gent` subcommands:

```bash
ovm-peer list
ovm-peer status PEER
ovm-peer pair PEER
ovm-peer run PEER /root/program.O
ovm-peer run PEER - < /root/program.O
ovm-peer --help
O /opt/ostadix/examples/hello.O /opt/ostadix/backends
```

`PEER` is an exact guest ID from the registry or an overlay address such as
`10.87.x.x`. A listed identity is not proof that it is online. `status` probes;
`pair` establishes reciprocal native pins; `run` pairs and submits the O source
once. Native `octl node run` options can follow the file. No-argument
`ovm-peer status` is invalid: supply the peer.

Guest pairing settings: `OVM_PEER_PAIR_TIMEOUT_SECONDS` defaults to 90, allowed
5–600; `OVM_PEER_PAIR_IO_SECONDS` defaults to the smaller of 60 and total,
allowed 1–60 and no greater than total. Pairing failure does not dispatch the
native program and does not cause an automatic execution replay.

### Native host capabilities

```bash
gent native
gent native probe
gent native list --json
gent native call host.runningApps '[]'
gent native call host.processRunning '["Terminal"]'
gent native --help
```

`native` defaults to `probe`. `probe`, `list`, and `call` accept `--json`.
Exact call form: `gent native call OPERATION [JSON_ARRAY] [--json]`.
Use `list` for the installed operation names and argument schemas. The empty
array example passes zero arguments; the second passes one string.
Host-changing calls require `OVM_NATIVE_ALLOW_ACT=1`. Task/chat instead offers
the scoped `--allow-native-act` option. Capability availability depends on the
host's qualified providers and permissions.

Use help as the **first** native argument: `gent native --help`. Adding help
after an actual call does not suppress that call.

### Direct built-in VM and diagnostic commands

These use the Apple backend and are separate from saved gent pockets:

| Command and aliases | Behavior |
| --- | --- |
| `gent shell` / `term` / `terminal` | Open a writable terminal in the built-in root/session image, not a saved gent's private disk. |
| `gent status` / `info` | Inspect resources, VM policy, lifecycle and lease state. |
| `gent probe` | Check Apple configuration without booting. |
| `gent run PROGRAM ARGS` / `exec` | Execute an exact policy-allowlisted guest diagnostic. |
| `gent console [hvc0\|hvc1]` / `logs` | Read up to 64 KiB of daemon/kernel console, default `hvc1`. |
| `gent start` | Boot through a temporary controller. It closes and stops its owned VM when the command exits. |
| `gent stop` | Ask its controller to stop; cannot take over another process's owned VM. |
| `gent mcp` | Start the stdio MCP server for an MCP client. |
| `gent raw ARGS...` | Invoke the underlying Apple runner directly; expert interface. |

Status/probe/run/start/stop/console accept `--json`. Shell accepts
`--network nat|isolated`, `--isolated`, `--distribution auto|local|required`,
and `--local`. It uses 4 virtual CPUs and 4 GiB memory. `exit` or Ctrl+D leaves
the guest terminal. It changes the built-in VM, so use gent chat when you want
to work in an existing gent's personal VM.

The exact allowed normal `run` commands in the current policy are:

```bash
gent run uname
gent run uname -a
gent run uname -m
gent run uname -r
gent run uname -s
gent run id
gent run id -u
gent run id -g
gent run python3 --version
gent run git --version
```

The normal run command deadline is 30 seconds. Arbitrary commands belong in
task/chat or the direct shell. For normal run/MCP network policy, use
`OVM_NETWORK_MODE=isolated` or `OVM_DISTRIBUTION_MODE=local`; everyday task flags
are not parsed there.

The MCP default is a start/operation/stop transaction. Setting
`CLAUDE_VM_LIFETIME=process` keeps a VM for that MCP process's lifetime; closing
the controller ends it. In that mode even controller startup for a status or
console request may warm a VM. It is not an independently managed background
service. See the [Apple VM runner and MCP documentation](apple-mcp-runner.md) for its lifecycle and operating limits.

### Raw parallel fleet

This is an Apple-only direct shell-task runner, without model reasoning:

```bash
gent fleet --tasks-json '[{"name":"check","command":"uname -m","timeoutSeconds":30}]' --distribution local --json
```

| Fleet option | Meaning |
| --- | --- |
| `--workers N` | Default demo worker count, clamped 1–16; default 2. Nonempty custom tasks determine their own count. |
| `--memory-mb MB` | Per-VM memory, clamped 512–8192; default 1024. |
| `--cpu-count N` | Per-VM CPUs, clamped 1–8; default 2. |
| `--network nat\|isolated` / `--isolated` | Guest networking. |
| `--distribution auto\|local\|required` | Shared-network policy for these local VMs. |
| `--tasks-json 'ARRAY'` | Inline worker task array. |
| `--tasks-file FILE` | Read the array from a file. |
| `--tasks-stdin` | Read the array from stdin. |
| `--benchmark` | Print additional fleet timing and benchmark telemetry. |
| `--json` | Structured aggregate output. |

A task has required `name` and `command`, plus optional `timeoutSeconds`
(default 30, clamped 1–120). Expert image/share overrides also exist:
`baseRootfs`, `preserveRootfs`, `distributionMode`, `networkShare`,
`artifactShare`, `artifactCapture`, and `runtimeProfilePath`.

Fleet does not implement task's `--local`, `--on`, or `--backend` flags.
Malformed, missing, or empty custom task arrays currently fall back to its
default demo tasks. Inspect each worker's `bootstrapExitCode`, `exitCode`,
`error`, and `stopped`; the fleet process's exit status alone is insufficient.
Use `gent task` for the everyday model-driven interface.

### Help and internal-command boundaries

Use `gent help --all` for the direct VM, raw fleet and legacy launchers.
Do not assume appending `--help` prevents execution: `shell`, `fleet`, `start`,
`stop`, `mcp` and raw-wrapper dispatch do not implement a universal help guard.
The forms documented earlier for task/chat/agent/swarm/network/guests/native
have specific help handling.

`gent worker` is the internal controller's stdio JSON protocol endpoint. It is
used by trusted SSH dispatch; it is not an interactive gent command.

### Raw runner forms

```bash
gent raw --support-only
```

This checks support without a VM boot. Explicit configuration inspection:

```text
gent raw --probe --bundle DIR --smol FILE --share DIR
  [--memory-gb 1..8] [--cpu-count 1..8]
  [--network nat|isolated] [--distribution auto|local|required]
```

Unlike `shell`, raw requires you to supply its bundle/helper/share paths.
Removing `--probe` starts the writable guest and consumes JSONL protocol input;
run mode also accepts `--network-share DIR`, with wrapper `--isolated`/`--local`
aliases. Defaults are 4 GiB and 4 CPUs. Protocol commands are `status`,
`console`, `stop`, and expert `exec` requests with an absolute guest executable,
arguments, working directory, and environment. Raw bypasses the normal MCP
program allowlist. See [ClaudeVZRunner.swift](../host/ClaudeVZRunner.swift) for
the exact protocol rather than constructing model task requests for this route.

### Ostadix native-node passthrough

`gent node`, `gent onode`, and `gent o-node` forward to `octl node`.
They are not the JavaScript `node` command and do not start an o-node daemon.

```bash
gent node --help
gent node list
gent node list --timeout-millis 5000
gent node use NODE_ID
gent node profile --node NODE_ID
gent node doctor --node NODE_ID
gent node run --node NODE_ID /absolute/program.O
gent node run --node NODE_ID - < /absolute/program.O
gent node session --help
gent node authority --help
```

`use` saves the preferred node. `profile` and `doctor` contact the selected
endpoint; `run` executes remotely. Connection options for profile/doctor/run:
`--node`/`-n`, `--address`/`-a`, `--server-name`, `--ca`, `--cert`, `--key`,
`--manual`, `--connect-timeout-seconds` (default 10), and
`--io-timeout-seconds` (default 60). Run also accepts `--task-id`,
`--attempt-id`, `--expected-catalog-sha256`, `--deadline-seconds` (default 300),
and `--output-limit-bytes`. Node-list timeout is 1–60000 milliseconds.

The native session subcommands include `start`, `run`, `send`, `info`, `stop`,
`principal`, `open`, `exec`, `status`, `actors`, `reset`, `recover`, and `close`.
The authority group includes `init`, `issue`, and `dev-mint` with `open`,
`execute`, or `recover` subcommands. Use their native `--help` for their typed
arguments; these belong to the host's Ostadix installation and include changes
to sessions, keys, and leases. There is no `gent node pair` or general `--json`
flag on this passthrough. Guest pairing is `ovm-peer pair PEER`.

### Legacy experimental example launchers

These names remain available, but they run fixed O example programs rather
than the portable daily task interface. They have no everyday option parser.
Their current scripts pin host/model paths and include local or remote work.
Read the linked program before launching one. Their banners are not validation
receipts, and this command-reference review did not execute them.

| Bare command / aliases | Program |
| --- | --- |
| `gent oracle`, `gent compile`, `gent fuzz` | [autonomous_compiler_oracle.O](../examples/autonomous_compiler_oracle.O) |
| `gent stress`, `gent ai-stress`, `gent hardware`, `gent limit` | [ai_hardware_limit.O](../examples/ai_hardware_limit.O) |
| `gent cluster`, `gent cross`, `gent dist` | [distributed_cross_machine.O](../examples/distributed_cross_machine.O) |
| `gent mega`, `gent hyper` | [hyper_mesh_orchestrator.O](../examples/hyper_mesh_orchestrator.O) |
| `gent ai`, `gent adaptive` | [ai_adaptive_swarm.O](../examples/ai_adaptive_swarm.O) |
| `gent spread`, `gent mesh` | [dynamic_spread.O](../examples/dynamic_spread.O) |

They do not implement `--on`, `--backend`, `--model`, or daily `--dry-run`.
Passing `--help` currently produces an O argument error, not a useful guide.
Some invoke Apple raw fleets or fixed Rack targets; AI examples hardcode their
local inference endpoint. Oracle can overwrite `include/ostadix_vector_simd.h`;
spread writes and removes its fixed temporary lineage image and driver.
For normal gent work use `gent task "your task"` with explicit placement options.

## 9. Developer/package commands

These run from the o-gents checkout. They do not require you to write JavaScript:

| Command | Purpose |
| --- | --- |
| `npm test` | Run the project's automated test suite. |
| `npm run model:setup` | Download/register Spark. |
| `npm run model:chat` | Plain Ollama chat with Spark. |
| `npm run swarm -- --mission "..."` | Advanced gent-swarm entrypoint. |
| `npm run swarm:dry-run` | Inspect the bundled swarm example without execution. |
| `npm run native:probe` | Inspect native providers. |
| `npm run install:prebuilt` | Install qualified prebuilt Apple launchers. |
| `npm run install:native` | Install qualified optional native capability providers. |
| `npm run build:native` | Developer rebuild of Swift runners; not needed for daily use. |
| `npm run research:verify` | Optional check of separately available private local research; the corpus is excluded from the product repository and package. |
| `npm start` or `bun run start` | Open VM chat with terminal input; preserve MCP with piped input and no arguments. |
| `npm run chat` or `bun run chat` | Explicitly open VM chat, including when input is piped. |
| `npm run mcp` or `bun run mcp` | Explicitly start the stdio MCP server; waits for an MCP client. |
| `npm pack --dry-run` | Inspect the package file list without creating a package archive. |

Do not append `--help` to npm scripts expecting it to suppress their work:
shell scripts may execute earlier steps first. `npm run` alone lists scripts.
Direct executable equivalents also exist: `ovm-pocket` for the advanced swarm,
`ovm-native` for native capabilities, and `claude-vm-mcp` for the MCP server.
Use the direct `bin/claude-vm-mcp` executable in MCP client configuration so
package-manager banners cannot enter its protocol output. Chat options can be
passed as `npm start -- --resume ID` or `bun run start --resume ID`.

## 10. A complete everyday session

Run the following commands one at a time, replacing the mission as needed.
The task command creates `hello-work`; it is not a preinstalled gent. Wait
for that command to finish and confirm the ID exists before continuing:

```bash
gent check
gent task "Create /root/hello.py that prints hello. Run it, read the saved file, and report the observed output." --swarm-id hello-work --rounds 6
gent list
gent show hello-work
gent chat --resume hello-work
```

In that chat, type `Add a second printed line, run the program, and show the
saved file.` Then type `/bye`. After confirming `hello-work` is saved and its
VM has stopped, run these commands at the host terminal:

```bash
gent clone hello-work hello-experiment
gent export hello-work ~/hello-work.ovm
```

You now have the original saved gent, a separate local replica, and a portable
archive containing full model weights. Actual task completion still depends on
the recorded execution and checks; if the gent runs out of rounds, resume the
same ID instead of treating its summary as proof.
