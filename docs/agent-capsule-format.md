# Portable gent capsules

o-gents calls each persistent VM-backed agent a **gent**. The primary commands
are `gent export`, `gent import`, and `gent clone`; the older `ovm agent ...`
forms remain compatible. The `.ovm` extension and versioned archive/schema
identifiers below are unchanged for compatibility.

`gent export ID FILE.ovm` packages a stopped gent swarm, its individual
guest disks, complete saved reasoning/action/result history, Linux boot inputs,
and the selected Ollama model's **full local weights and manifest closure**.
`gent import FILE.ovm [NEW_ID]` creates a separate instance.
`gent clone ID NEW_ID` exports and imports a local replica without deleting
the source. The source's controller lease must be absent and guest disk files
must be closed. Paused or completed state is preserved; importing does not
start a VM or replay any previous action.
An unresolved `pending-dispatch.json` prevents export or cloning. First use
`gent resume ID` to retrieve and reconcile the original execution receipt;
an unknown remote outcome must not become a second runnable copy.

```bash
gent list
gent show my-agent
gent export my-agent ~/my-agent.ovm
gent import ~/my-agent.ovm my-replica
gent import ~/my-agent.ovm private-replica --private-model
gent clone my-agent my-other-replica
```

The command requires an installed Node o-gents controller, Python 3 for atomic
directory publication, and `lsof` to verify that source disks are unused.
The guest remains ARM64 Linux. Its supported execution backends are QEMU on
Linux/macOS and, when the Apple helper is included, Apple Virtualization on
Apple Silicon macOS. An x86-64 Linux host runs this ARM64 guest through QEMU
software emulation. Select the engine with `--backend qemu` or leave automatic
host selection enabled. Model bytes and all guest disks travel with the capsule; the
host's hypervisor, o-gents controller installation, Ollama executable, and native
macOS app/keyboard providers are host adapters, not embedded executables.
The archive includes private guest data and privately supplied boot inputs.
Keep it in private storage and transfer it only to machines you trust.

## What is retained

- `swarm.json`, including missions, roles, rounds, model identity, messages,
  transcript, observations, completion state, queued publications, pending
  report/reply review, and scoped source witnesses. A queued publication keeps
  the exact producing VM evidence ID and runs only after a successful recorded
  result. Additional model-proposed VM commands are never queued implicitly.
- Every pocket's personal root disk and verified guest-runtime receipt. An
  unbooted child receives the parent's preserved disk; an unbooted initial
  pocket receives the prepared base. Nothing depends on a source host path
  after import.
- The direct-boot kernel, initrd, guest preparation receipt, and Apple helper
  image when available. A QEMU-only source does not need the Apple helper.
  The task backend's secondary disk is disposable each round. Its required
  logical size is recorded, and import creates a fresh sparse secondary disk;
  unrelated global Cowork session data is not copied. If a QEMU-only source has
  no secondary disk, import creates a fresh sparse 10 GiB compatibility disk.
  QEMU execution does not consume this compatibility disk.
- The selected model's Ollama manifest, config, model weight layer(s), template,
  parameters, and every other referenced SHA-256 blob. Missing or corrupt model
  bytes fail export. There is no metadata-only success mode.
- Published immutable artifact bytes and their provenance index. Artifact
  references must resolve to included SHA-256 blobs, so peer handoffs remain
  available after import; a filename in another pocket is not treated as data.

Import retains the original saved state byte-for-byte at
`history/source-swarm.json`. The active `swarm.json` receives a new instance and
swarm identity, keeps its lineage, and remaps inherited disk paths. Pocket names
remain stable within that new instance so messages and history stay coherent.
Original root disks and model files are not modified.
Evidence IDs, producing-machine information, and observed rounds in the
preserved history remain unchanged. Cloning an observation does not turn it
into a new independent check in the destination VM.

Network-controller keys, certificate-authority material, host pairing state,
and the host's network registry are not added to capsules. Old native-node
identity material may remain inside the private guest disk, as part of its
exact personal state. Import does **not** claim to erase it. The replica's new
root path selects a fresh mounted network identity and native-node state at
boot, so it does not impersonate the source's active identity.

By default import publishes verified model blobs and the model tag into
`OLLAMA_MODELS`, or `~/.ollama/models`. Existing identical content is reused;
conflicting content or a tag with different bytes is refused. Tags publish
only after all blobs exist. Keep a running Ollama server configured to use the
same model directory. Capsule-local model bytes remain in `capsule-models/`,
so later exports do not depend on that global model tag remaining installed.

`--private-model` skips publication into the host model store. It retains every
model manifest and weight blob in the imported gent's `capsule-models/`, avoids
an additional global copy, and leaves an existing conflicting host tag alone.
The JSON result includes `privateModelsPath` and `weightsPublished: true` after
the complete gent is published. `modelStorePublished` and the compatibility
field `modelInstalled` indicate whether the host model store was also populated.
`inferenceReady` remains `false`: import neither installs nor starts Ollama,
selects a running server's model directory, nor verifies model inference. The
target needs a separately installed compatible Ollama server configured to use
the chosen model files before reasoning can resume.

### Run an imported private model

After `gent import ~/my-agent.ovm private-replica --private-model`, open
two terminals in the destination's o-gents checkout. Replace `private-replica` with
your imported ID; for a custom state location, use the import receipt's exact
`privateModelsPath` instead of the path below.

In the first terminal, choose a Spark-compatible Ollama server executable.
These are the verified installations used for this checkout. On Lee's Mac:

```bash
ovm_ollama_bin=/Applications/Ollama.app/Contents/Resources/ollama
```

On the Rack or Debian Mini with the private Linux CPU installation:

```bash
ovm_ollama_bin="$HOME/.local/share/ovm-portable-tools/ollama-v0.35.0/bin/ollama"
export LD_LIBRARY_PATH="$HOME/.local/share/ovm-portable-tools/ollama-v0.35.0/lib/ollama${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
```

On another host, set `ovm_ollama_bin` to its installed Spark-compatible binary.
The older Homebrew Ollama 0.33.2 server on this Mac cannot load Spark; selecting
the app's 0.35.0 binary avoids accidentally starting that older server.

Then start the private server in the foreground. Choose an unused local port;
`11439` is an example, separate from the usual server on `11434`:

```bash
ovm_private_port=11439
ovm_private_models="$PWD/vm/pockets/private-replica/capsule-models"
OLLAMA_HOST="127.0.0.1:$ovm_private_port" \
OLLAMA_MODELS="$ovm_private_models" \
OLLAMA_NO_CLOUD=1 \
"$ovm_ollama_bin" serve
```

Keep that terminal open. In the second terminal, use the same port to check the
available model tags and resume the imported gent:

```bash
ovm_private_port=11439
curl --fail --noproxy '*' "http://127.0.0.1:$ovm_private_port/api/tags"
OVM_OLLAMA_URL="http://127.0.0.1:$ovm_private_port" \
OVM_MODEL_TIMEOUT_SECONDS=300 \
./bin/gent chat --resume private-replica --local
```

The saved gent selects its saved model name; the Spark capsule here uses
`huihui-spark-vm:32k`. For task-style continuation, replace the last command with
`./bin/gent resume private-replica --local`, keeping the same
`OVM_OLLAMA_URL` and timeout assignments. `OVM_MODEL_TIMEOUT_SECONDS` sets each
model-decision deadline to an integer from 1 to 3600 seconds; the ordinary
default is 90 seconds. The example allows five minutes for cold or slow CPU
inference. It does not change VM command deadlines. The Mini's isolated small
inference request took 129.4 seconds; that proves loaded-model inference, not
a complete interactive gent turn on that CPU.

These commands use the imported weights directly;
no model pull is needed. After exiting chat with `/bye` or letting the task
finish, press Ctrl+C in the first terminal to stop that private server. This
foreground process does not replace the host's existing Ollama service.
Ollama documents the model-directory, bind-address and local-only settings in
its [FAQ](https://docs.ollama.com/faq).

## Binary format, version 1

Capsules use a bounded data format rather than extracting arbitrary tar paths.
This avoids platform-specific sparse-tar extensions and makes path and file
type validation explicit.

| Field | Encoding |
| --- | --- |
| Magic | Exact UTF-8 bytes `OVM-AGENT-CAPSULE`, NUL, `v1`, LF |
| Header length | Unsigned 64-bit big-endian byte count |
| Header | UTF-8 JSON; maximum 16 MiB; `schema: "ovm.agent-capsule/v1"` |
| Content | Payload extents, in header file order and each file's extent order |

The header identifies the capsule, source instance and lineage, model closure,
runtime requirements, pocket mappings, and content files. Each file entry is:

```json
{
  "path": "pockets/builder.rootfs.img",
  "size": 25769803776,
  "sha256": "SHA256_OF_THE_ENTIRE_LOGICAL_FILE_INCLUDING_ZERO_REGIONS",
  "extents": [[3145728, 1048576, 4650, "deflate"]]
}
```

Each extent is `[logicalOffset, logicalLength, storedLength, encoding]`, where
encoding is `raw` or raw DEFLATE. Logical chunks are at most 1 MiB. All-zero
chunks have no payload and are restored as holes. Disk chunks are compressed
at level 1 when useful; model blobs retain their exact bytes. Hash verification
covers the full logical file, including omitted zero regions. Extents must be
ordered, nonoverlapping, within the file bounds, and have valid lengths. Raw
extents must have equal logical and stored lengths. Inflation is bounded to
the declared logical chunk size. The archive's exact byte length must match
the header plus declared payloads; both truncation and appended bytes fail.

Paths are allowlisted to the state, declared pocket disks/receipts, fixed boot
inputs, and the exact selected model manifest/blob set. There are no archive
directory, symlink, hardlink, executable-mode, device, or other special-file
records. Absolute paths, traversal, duplicate paths, unexpected entries,
missing closure entries, and malformed model digest references are rejected.
Current bounds are 1,024 files, 64 pockets, 256 GiB per file, 64 GiB for the
disposable session disk, and 1 TiB total logical data. Extraction checks the
expected materialized disk requirement against available space before writing.

The manifest is an integrity record, not a cryptographic assertion about who
sent the archive. Import only capsules from a source you trust.

New v1 manifests describe `capabilities.supportedBackends` using
`qemu-arm64` and, when the helper is included, `apple-vz-arm64`.
`runtime.helperPath` may be `null` or absent for a QEMU-only capsule. When it is
mapped to `runtime/smol-bin.arm64.img`, that file is required and hash-verified;
an unmapped helper entry is rejected. Existing v1 capsules with their earlier
Apple-only descriptive metadata and required helper mapping remain readable.
The guest architecture and host architecture are separate: the archive carries
an ARM64 guest rather than a host-specific executable controller.

## Publication and failure behavior

Export owns the same controller lease used for execution, checks open disk
files, rejects symlink sources, records source inode/size/timestamps, and checks
source identity before and after packaging. It hashes again while writing the
payload. Output first goes to a private `.partial-` file, is flushed, then
published with a no-overwrite atomic hard link. Existing output is retained.

Import creates a private staging directory on the destination filesystem. It
verifies every content hash, the model closure, and saved-state mappings before
publishing anything. Existing gent directories are never replaced. macOS
`renamex_np(RENAME_EXCL)` or Linux `renameat2(RENAME_NOREPLACE)` atomically
publishes the completed directory. Invalid archives leave no published gent;
temporary extraction is removed. Failed model installation can leave valid
content-addressed blobs already installed, but never overwrite a conflicting
blob or tag. Source archives and source gents remain intact.

Before Linux extraction, import probes reflink support using tiny owned
temporary files. On filesystems without reflinks, the initial space estimate
includes the extra sparse base-root copy created under `capsule-runtime`.
It also includes missing model-store copies when those copies cannot share
extents, budgeting separately if the model store is on another filesystem.
Existing model-store files need no new allocation and are verified before reuse.
`--private-model` removes the global-copy allowance without removing any weights
from the imported gent. macOS keeps its APFS-friendly initial allocation check;
individual copy fallbacks still check space before allocating. Actual allocation
can change as other processes use storage, so later copy checks remain active.

Export uses the same controller lease as task execution and checks every
included disk/helper file with `lsof -t -- FILE...` (`lsof` on Linux PATH,
`/usr/sbin/lsof` on macOS). Open-file results, missing `lsof`, and diagnostics that
prevent a reliable closure check fail the export. A missing source session disk
does not weaken root-disk closure checks; only a new disposable sparse session
disk is created at import.

Export/import do not perform a live migration. A remote process's uncertain
execution result is not resolved by copying its earlier snapshot. Resume and
distributed dispatch must preserve their execution journal and avoid replaying
an accepted command whose outcome is unknown.
