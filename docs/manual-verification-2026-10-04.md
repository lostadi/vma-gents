# Manual verification — October 4, 2026

This records a live manual review of the documented workflows on an M1 Max Mac.
The application code was at `15913da75fe41a5ac318c0c5eb1003f9d749159c`.
The changes in this review are documentation only.

No automated test suite or scripted integration harness was run for this review.
In particular, this did not run `npm test`, `verify:ostadix-peer`, the guest
runtime smoke suite, or the lifecycle test scripts. The application's own source
checks, output predicates, readiness gates, and capsule integrity checks remain
part of its normal operation.

## Method

The CLI commands below were invoked directly and their output inspected.
For the execution/review protocol, actions were entered one round at a time
through an interactive Node REPL using the production `PocketSwarm`,
`SwarmVMFleet`, and capability broker. Each next action was chosen after reading
the preceding result. The VMs and execution receipts were real; no mock workers
or fixed decision-sequence harness supplied the results.

Those controller turns are marked `manual-operator` in the transcript. The saved
family's model selection is Spark for later continuation, but **no model chose
those manual protocol actions**. Separate task/chat runs below used actual
Spark inference. This distinction matters when evaluating autonomy.

## What passed

| Operation | Observed result |
| --- | --- |
| CLI entrypoints | `gent --help`, task/chat help, list, show, and mode inspection returned their documented interfaces. |
| Terminal startup | `bun run start` opened VM chat in a terminal; `/bye` exited cleanly without creating an unused gent. |
| Chat controls | `/status` displayed the saved ID/path, `/help` listed controls, and `/bye` preserved an existing conversation. |
| Plain local inference | `gent chat --text "Reply with just the word ready."` returned `ready`. |
| Local VM execution | Real guest commands returned `aarch64`, Python 3.10.12, Node v22.23.3, and Rust 1.97.1. |
| Persistent files | A fresh boot read the exact `gent-manual-20261004` marker written in an earlier boot. |
| NAT networking | HTTPS to `https://example.com` returned HTTP 200 from both the Apple and QEMU guest runs. |
| Invalid O source | A malformed Python block was rejected by native backend syntax diagnostics; the receipt reported `executed: false`. |
| Static O check | Valid source reported `static-check-passed` and `executed: false`. |
| O execution | The separate run returned `[number] 2` plus a newline and passed its exact stdout predicate. |
| Failed predicate | Expecting `[number] 3` from the same source produced `checks-failed`, despite process exit 0. No successful publication was added. |
| Early completion | A producer finish request was deferred with `awaiting-peer-review`. |
| Reading execution | The checker received the exact retained source, output, and checks. The read reported `independentVerification: false`; it did not run code. |
| Self-review | The controller rejected the producer's attempt to review its own artifact. |
| Independent rerun | The checker ran the immutable source and original predicate in its own VM. The result was `peer-verified`. |
| Completion after review | Both manual participants completed after observing their results and submitting supported assertions. |
| Backend portability | The checker disk booted Apple → QEMU/HVF → Apple. Both the original marker and a new QEMU-written marker survived. Ostadix hello ran on both. |
| Artifact share | QEMU read the published source. A deliberate `touch` in `/ovm/artifacts` failed with `Read-only file system`. The resulting command exit 1 was expected for this negative check. |
| Isolated guest | The guest exposed only loopback, had no IPv4 route, and could not resolve the HTTPS host. Ostadix hello still returned 2. |
| Native observation | `gent native call host.authAvailable '[]'` returned `true` through the qualified native provider. No keyboard, pointer, or application action was performed. |
| Mode controls | `gent mode local` changed the saved mode; `gent mode auto` restored its original value. |

The manual peer family completed in seven controller rounds with seven actual
guest operations across two persistent VM disks. Its 42-byte source was:

```text
python^(
__oval_result__ = 1 + 1
)_python
```

Source SHA-256:
`19cf5dbf515a083d4360cfd9815261f8967adf3d85b11d1645af419aac791b17`.

The builder's execution ID was
`readme-manual-peer-20261004:builder:3:ostadix`; the checker's separate review ID
was `readme-manual-peer-20261004:checker:5:peer-review`.

## Model behavior and observed failures

The initial default Spark task was:

```sh
gent task "Run uname -m in your VM, then report its exact output and finish using the observed evidence." --local --rounds 4
```

It ran `uname -m` successfully and retained `aarch64`. Three decisions timed out
at the default 90-second deadline. Its early finish was deferred, and the task
stopped at the four-round budget without completing. The source family is
`swarm-muucumu7`.

A subsequent `gent resume swarm-muucumu7 --rounds 1 --local` completed in
30.4 seconds. It passed two assertions against the existing result and did not
rerun the VM command. The earlier timeouts remain in the history.

The interactive chat `readme-chat-20261004` wrote and read
`/root/chat-marker.txt`, then read it again after another boot. Both outputs were
exactly `gent-chat-20261004`. Four later decisions timed out, so it reached the
six-round budget without delivering a final model reply. `/bye` saved the chat.
This establishes the guest effects and persistence, not a successful complete
chat turn under those server conditions.

The same chat was then resumed against the temporary private model server
described below. Round 7 read the saved marker in a fresh VM boot; round 8
returned its correct contents and waited for the next message. The turn took
164.7 seconds. The model added an explanatory sentence despite the request to
reply with exactly the contents. Its reply was labelled reported, with no
semantic verification. Persistence and a complete conversational turn worked;
exact reply formatting did not.

The actual two-gent example also ran against that server:

```sh
OVM_OLLAMA_URL=http://127.0.0.1:11439 OVM_MODEL_TIMEOUT_SECONDS=180 \
  gent swarm --spec examples/ostadix-peer-review.json --local \
  --swarm-id readme-model-peer-20261004
```

The builder's first run returned 2 with the declared predicate passing. In
round 2, the checker read the execution and reran the artifact in its own VM.
That artifact became `peer-verified` through actual model-selected actions.
The models then made unnecessary new publications, referred to invalid evidence
IDs, attempted self-review, and produced two malformed shell commands that
failed with Python syntax errors. The controller retained those failures and
deferred three early finish requests. After eight rounds and 465.5 seconds,
both gents were still unfinished: one artifact was peer-verified and four later
artifacts awaited review. This demonstrates a working model-driven peer rerun,
not reliable autonomous completion of the example.

An initial task invocation used unsupported `--id`; the CLI rejected it before
execution. The stable-ID option is `--swarm-id`.

## Capsule operation

The stopped `swarm-muucumu7` family was exported using `gent export`, then
imported under `readme-import-20261004` with `--private-model`. The archive was
6.48 GiB and contained the full Spark weights, guest disk, boot inputs, and the
four-round history present at export time. Import passed its normal payload
integrity checks and produced a new instance identity with the source lineage.
`gent show` displayed the imported four-round history correctly. The source was
subsequently resumed separately, so its fifth turn is not part of that snapshot.

The archive header is retained in `runtime/readme-manual-capsule-manifest.json`.
The temporary large archive was removed after successful import to reclaim disk
space. The imported weights were then served directly by a temporary local Ollama
0.35.0 process on `127.0.0.1:11439`, with `OLLAMA_MODELS` pointing at the capsule's
private model directory and `OLLAMA_NO_CLOUD=1`. The ordinary server on 11434 was
left running. `/api/ps` identified Spark at an 8,192-token context, and actual
model decisions drove the imported guest through two successful Ostadix hello
executions. Both returned `[number] 2` and stopped cleanly.

The imported model's three-round task did not complete: it asserted that the
hello example should print `hello`, although the saved stdout was `[number] 2`.
The controller rejected that assertion. The model then repeated the command
instead of correcting the assertion. The capsule and runtime worked; that
particular model task remained unfinished.

`gent clone swarm-muucumu7 swarm-muucumu7` correctly refused to overwrite the
source. A missing capsule path was also rejected.

A separate successful `gent clone swarm-muucumu7 readme-clone-20261004`
retained the source's five-round history and full weights, created a different
instance ID, and kept the original lineage. Before cloning, a manual source
boot wrote `source-before-clone-20261004` to `/root/clone-marker.txt`.
The clone booted using its bundled runtime and read that marker. It then
overwrote its own file with `clone-only-20261004` and ran Ostadix hello, which
returned 2. A subsequent boot of the source still read
`source-before-clone-20261004`. Both guests exited 0 and stopped. The changed
copy did not alter its source disk. Another clone boot retained
`clone-only-20261004`, also exiting 0 and stopping cleanly.

## Limits of this review

- `gent check` reported local task/chat and QEMU prerequisites available. It read
  the previously saved 47-check guest profile; those 47 checks were not rerun.
- `gent run uname -m`, the separate Apple diagnostic/MCP route, refused startup:
  free-memory headroom was 17%, below its 35% policy. A later `gent check`
  reported 24%, still below that requirement. No gate was weakened.
- `gent peers` reported that the configured `rack` host timed out over SSH.
  A one-round task explicitly targeting it timed out during model reasoning,
  before any remote VM dispatch. Neither result establishes a working remote
  controller in this review.
- Team, isolated, and peer-example dry-runs parsed the configuration. A dry-run
  is not an execution result.
- Fresh installation/provisioning, a second physical host, Linux/TCG, cross-host
  mesh execution/recovery, process-lifetime MCP, and native host input actions
  were not exercised in this review. Historical results are in
  [the earlier validation record](validation-history.md), not counted here.
- This is a set of manually inspected operations, not exhaustive coverage of
  every failure path or a measurement of general model capability.

## Retained local evidence

These paths are relative to the checkout and excluded from Git:

- `vm/pockets/readme-manual-peer-20261004/swarm.json`: every manual decision,
  observation, refusal, publication, peer review, and completion assertion.
- `vm/pockets/swarm-muucumu7/swarm.json`: default model task and resumed finish.
- `vm/pockets/readme-chat-20261004/swarm.json`: actual model chat and timeouts.
- `vm/pockets/readme-model-peer-20261004/swarm.json`: the real model-driven
  peer review, later failures, and unfinished eight-round result.
- `runtime/readme-manual-qemu.json`: QEMU persistence, O execution, HTTPS, and
  artifact write refusal.
- `runtime/readme-manual-apple-return.json`: return to Apple on the same disk.
- `runtime/readme-manual-isolated.json`: isolated boot and local execution.
- `runtime/readme-manual-capsule-manifest.json`: the exported capsule manifest.
- `runtime/readme-import-evidence-20261004/`: imported state, capsule manifest,
  and original source history retained before removing temporary large files.
- `runtime/readme-private-ollama.log`: the temporary model server's log.
- `runtime/readme-clone-source.json`, `readme-clone-boot.json`, and
  `readme-clone-source-after.json`: source marker, successful cloned boot,
  O execution, and unchanged source contents after writing in the copy.
- `runtime/readme-clone-reboot.json`: the changed clone file surviving a reboot.
- `runtime/readme-clone-evidence-20261004/`: clone state, capsule manifest, and
  source history.

All completed guest operations above reported stopped VMs. The temporary model
server and its runner were stopped; the ordinary Ollama server on 11434 remained
running. Import/clone histories and execution receipts were retained before
removing their temporary large disks and private weight copies, after confirming
no open handles. The original manually exercised gents remain available. The
distribution mode was restored to `auto`. No application source, model defaults,
or resource policy was changed by this documentation review.

The documentation commit uses `[skip ci]` to avoid starting the repository's
automated checks on push, as requested for this manual review.
