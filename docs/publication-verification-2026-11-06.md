# Publication verification — November 6, 2026

This record covers the initial `lostadi/vma-gents` publication snapshot.
It includes the controller, CLI, guest and host source, the browser/search
modules, tests, documentation, and the rebuilt project launchers. Private
guest images, model weights, native add-ons, saved sessions, and local history
are excluded. The existing development checkout and repositories were preserved.

## Local checks

Host tools: Node.js `v26.13.0`, npm `11.20.0`, Apple Silicon macOS.

| Check | Observed result |
| --- | --- |
| `npm ci --ignore-scripts` | Passed from the committed npm lockfile. |
| `npm test` | 417 tests: 413 passed, 0 failed, 4 skipped. |
| `npm audit --omit=dev` | 0 reported vulnerabilities after dependency updates. |
| npm/Bun resolution comparison | All 117 resolved package versions matched. |
| `zsh -n scripts/*.zsh` | Passed. |
| `./setup.sh --help` and `./bin/gent --help` | Passed. |
| Task and Ostadix peer-example `--local --dry-run` | Returned plans without model inference or a VM boot. |
| Native launcher build | All three Swift launchers compiled for ARM64/macOS 14. |
| Native signatures and `SHA256SUMS` | All three launchers passed strict signature and checksum verification. |
| `ClaudeVZRunner --support-only` | Reported `supported: true`. |

The four skipped tests require real Nebula certificates, a real Chromium
executable, or private Claude VM inputs (two configuration probes). This run
does not qualify those paths.

The first native build rejected the helper in the currently installed Claude
app because its hash differed from the pinned compatibility profile. The build
then passed using `CLAUDE_VM_SMOL_SOURCE` pointed at an existing local helper
whose hash and size exactly matched that profile. The helper remains excluded
from Git. A fresh installation still requires compatible private inputs.

## Dependency updates

The initial production audit reported six affected packages. The publication
snapshot updates the following versions and retains the existing SDK and
development dependency versions:

| Package | Previous | Published |
| --- | --- | --- |
| `zod` | 4.4.3 | 4.6.7 |
| `@hono/node-server` | 2.1.1 | 2.1.6 |
| `body-parser` | 2.3.0 | 2.4.0 |
| `fast-uri` | 3.1.8 | 3.1.9 |
| `ip-address` | 10.7.2 | 10.7.6 |
| `qs` | 6.16.0 | 6.17.1 |

The Bun lockfile was migrated from the updated npm lockfile. No forced major
dependency upgrade was used. The audit result describes the advisory database
at verification time, not a permanent security guarantee.

## Scope

No actual VM boot, model inference, browser navigation inside a guest, remote
controller deployment, or fresh-host provisioning was performed for this
publication. The local automated suite, native compilation, and support probe
are separate evidence from those operations. GitHub Actions has its own result;
the local results above do not imply that CI passed.

The October verification documents preserve earlier observations and their
original scope. Paths to ignored private receipts in those documents are
historical references, not files supplied by this public repository.
