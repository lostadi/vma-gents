# Ostadix actions and peer review

o-gents gives a gent a structured way to check and run exact `.O` source in its
own VM, publish the successful source, and ask a different gent to rerun its
original output checks. The local model chooses actions; the controller checks
their shape, records results, and enforces completion rules. A prompt or model
summary alone is never a verification receipt.

`gent` remains the daily CLI; `ovm` compatibility commands, `OVM_*` settings,
saved-state schemas, and `.ovm` capsules retain their names. This feature belongs
to the private `lostadi/o-gents` project. Ordinary VM shell actions and VM chat
remain available, and plain `gent chat --text` does not execute these actions.

## Try a two-gent task

From the checkout:

```sh
gent swarm --spec examples/ostadix-peer-review.json --local --dry-run
gent swarm --spec examples/ostadix-peer-review.json --local
```

The example gives a builder and a checker separate VMs and eight reasoning
rounds. It asks for a small Python-backed `.O` program returning `2`, an exact
stdout check, then a peer rerun. `--local` keeps both VMs on this machine; it does
not disable their normal internet access. The controller carries the published
source and receipts, so this review does not require a direct guest-to-guest
network connection.

The dry-run inspects configuration without inference or VM execution. The real
run uses the model and VMs. This is a task specification, not a deterministic
script: a model can choose an invalid action, fail to cooperate, or exhaust its
round budget. Inspect the printed result and saved evidence. Continue the same
saved task with its printed ID:

```sh
gent show GENT_ID
gent show GENT_ID --json
gent resume GENT_ID --rounds 8
```

A new `gent task` starts one gent with a total cap of two. Successful code
publication can therefore create a distinct reviewer without starting a team
in advance. `--agents 3` starts and caps a team at three; `--max-agents N`
explicitly sets the total cap. Saved tasks retain their existing cap unless
overridden, and a specification can set its own cap.

The controller uses an already active peer when available. If all peers have
finished, it reactivates one. If the producer is alone, it creates a reviewer
within `maximumAgents`. With an explicit cap of one, it records
`peer-reviewer-unavailable` and leaves completion pending; a gent cannot approve
its own publication. Give that saved task room with:

```sh
gent resume GENT_ID --max-agents 2 --rounds 8
```

Creating or reactivating a reviewer does not guarantee that its model will
choose a valid review action or finish within the remaining rounds.

## The structured action

These JSON objects are **model action payloads**, not shell commands. They appear
inside a decision's `actions` array. A run action is:

```json
{
  "type": "ostadix",
  "name": "sum",
  "mode": "run",
  "source": "python^(\n__oval_result__ = 1 + 1\n)_python\n",
  "checks": [{ "kind": "stdout_equals", "expected": "[number] 2\n" }]
}
```

Use `"mode": "check"` with `"checks": []` for static inspection first. Omitting
`mode` defaults to `check`. Static inspection still uses the gent's VM, but does
not execute the submitted program.

| Field | Contract |
| --- | --- |
| `source` | Nonempty, exact UTF-8 text, at most **8,192 bytes**. No trimming, correction, or Markdown-fence removal. |
| `name` | Nonempty UTF-8 label, at most 128 bytes; defaults to `program`. Reuse the same name for a corrected revision. |
| `mode` | `check` or `run`. |
| `checks` | At most eight predicates. `run` requires at least one; every predicate must pass. |
| `stdout_equals` | Exact stdout equality, including spaces and final newline. |
| `stdout_contains` | Case-sensitive substring match; the expected substring must be nonempty. |

Each predicate's `expected` value is a UTF-8 string of at most 4,096 bytes.
Choose meaningful expected output before execution. Put stronger behavioral
tests inside the program; passing a weak substring test proves only that the
substring was observed. A gent gets one guest operation per round: additional
`vm`, `ostadix`, or `review_artifact` operations in that decision are not
automatically replayed.

## What gets checked and retained

The controller writes the exact source into a temporary guest file and records
its SHA-256. It invokes native `O --check --json`, reads structured source and
backend diagnostics, and obtains native execution-intent JSON from `olangc`.
Run mode then invokes `O` with both the required source digest and the required
execution-intent digest. Output predicates are evaluated against the observed
execution stdout.

| Result | What it establishes |
| --- | --- |
| `static-check-passed` | Native parsing and source-bound intent inspection passed. It does **not** establish execution; skipped or unavailable backend syntax checks remain unchecked. |
| `checks-passed` | The source passed the static gate, execution completed successfully, and every declared stdout predicate passed. |
| `peer-verified` | A distinct gent reran the exact published source and original predicates in its own VM, and those predicates passed. |

These statuses do not establish general program correctness, mission completion,
or independence of the underlying models. The records retain
`semanticVerification: false` and an explicit scope.

A successful `run` automatically publishes an `ostadix-program` artifact. No
separate `publish` action is needed. It binds source bytes, SHA-256, original
checks, producer, instance, round, and execution-evidence ID. Static checks and
failed runs do not create a successful code publication. The immutable source
is stored with the family's artifacts and is available to guests at
`/ovm/artifacts/sha256-DIGEST`.

## Reading and rerunning a peer's work

The controller sends peers a review request containing the artifact ID and
`code.executionEvidenceId`. Use those actual IDs; do not invent them.

```json
{ "type": "read_execution", "evidenceId": "FAMILY:builder:ROUND:ostadix" }
```

This reads a retained observation: its producer, source when available, actions,
stdout/stderr excerpts, exit status, and checks. Truncation is marked explicitly.
It creates no new execution and reports `independentVerification: false`.
An execution-evidence ID is different from the artifact ID used below:

```json
{ "type": "review_artifact", "artifactId": "ostadix:ACTUAL_CONTRACT_DIGEST" }
```

The controller loads the immutable source and original check contract. The
reviewer cannot replace either through this action. Self-review, unknown
publications, altered source bytes, and mismatched contracts are rejected.
Successful review produces a separate `:peer-review` evidence ID.

A producer's `finish` is deferred while the latest publication for the current
mission under each of its program names still needs review. Keep the name when
correcting a program so the new revision becomes the review target. The latest
recorded review determines the derived `peerVerification` status: a passing
rerun establishes `peer-verified`, and a later failed rerun overrides that pass
and blocks completion again. The original publication receipt remains
unchanged. A finish still needs an explicit assertion against already observed
evidence, such as `ostadix_checks_passed` or `peer_review_passed` with
`expected: true`. Request execution in one round, inspect its result in a later
round, and only then report or finish. This peer requirement applies to these
published Ostadix programs; ordinary VM exploration and chat do not acquire a
general peer-review requirement.

## Runtime needs, failures, and resume

The guest needs Python 3, `O`, `olangc`, and the backend runtimes used by the
source. Native O must support structured source diagnostics and the source/
execution-intent binding flags; `olangc` must support
`--target ir --execution-intent-json`. Merely finding old binaries is
insufficient. Roots and backend directories must be absolute guest paths;
the default root is `/opt/ostadix`. These checks run in the VM, so this feature
does not require host Ostadix or depend on the guest MCP server's transport.

Each native phase has a **15-second deadline** and a **16 KiB combined stdout/
stderr budget**. Missing runtime capabilities, undefined initial bindings,
top-level prose, invalid backend syntax, failed execution, invalid receipts,
timeouts, overflow, and failed predicates are retained as failures rather than
promoted to success. Skipped syntax checks are reported as such.

Remote controllers allow up to 128 KiB for a generated capture command while
ordinary VM commands remain capped at 8 KiB. The source limit is still 8,192
bytes, and the entire serialized remote request, including artifact inputs,
must fit within 4 MiB. Exceeding these bounds is rejected before VM execution.

Saved state retains execution observations, program publications, reviews, and
pending work. Resume the same ID when interrupted. If a dispatched operation's
outcome is uncertain, the controller blocks new work until the original result
is recovered; it does not submit a fresh copy and call that recovery. A failed
review leaves completion pending. If execution succeeds but source publication
fails, the missing publication also blocks completion, including after resume.
The publication error is retained; the controller does not automatically replay
the successful execution to resolve it. The state file's `programArtifacts`,
`artifactReviews`, and transcript provide the recorded evidence; neither a
green summary nor a round limit substitutes for those records.

The model receives a bounded view of saved evidence. Older duplicate history
and long output excerpts may be omitted, with explicit omission markers. The
current code artifact, its execution/review references, and the latest real
tool result remain available even after a reasoning error. Full source,
contracts, output and history stay in saved state. A context-overflow retry
reduces the reasoning request once; it does not replay a guest command.

## Repeatable VM integration check

On a host with the prepared VM runtime, run:

```sh
npm run verify:ostadix-peer
```

This opt-in check boots real builder and checker VMs, runs the exact same benign
O program and output predicate in each, reads the producer's evidence, and
asserts that independent review permits completion. It uses scripted decisions,
so it tests the execution and review machinery without depending on model
behavior. It retains its private guest disks and `swarm.json` under a unique
`vm/pockets/ostadix-proof-*` directory and prints that path. These local runtime
files are ignored by Git. Passing this check is not a model-quality benchmark.

Implementation: [action validation and native receipts](../src/ostadix-control.mjs),
[immutable artifacts](../src/agent-artifacts.mjs), and
[review and completion handling](../src/pocket-swarm.mjs).
