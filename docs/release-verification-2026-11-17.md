# Verification — November 17, 2026

Checks ran against the public vma-gents source on x86-64 Linux with Node.js `v26.12.0`.
The code snapshot was `e6100a3dfc9566ad623103b40865f5ad11ee28b0`;
this update changes documentation and the Hono resolution in both lockfiles.
It does not change the controller or guest implementation.

OpenAI Codex prepared these updates and ran the checks listed below. A separate
Codex agent reviewed the source and documentation changes. This record does
not imply a human review or sign-off.

## Checks run

| Check | Observed result |
| --- | --- |
| `npm ci --ignore-scripts` | Passed from the updated npm lockfile. |
| `npm test` with `umask 022` | 417 tests: 405 passed, 2 failed, 10 skipped. The two failures invoke macOS tools absent on this Linux host. |
| `npm audit --omit=dev` | 0 reported vulnerabilities after the Hono update. |
| CLI help | 20 everyday, saved-gent, network, guest, and advanced help invocations exited 0. The separate browser route returned a structured invalid-request receipt for `--help`, as its JSON-only interface specifies. |
| npm/Bun resolution comparison | All 117 resolved package versions matched. |
| Local task dry-run | Returned a plan without model inference or a VM boot. |
| Ostadix peer-example dry-run | Returned a plan without model inference or a VM boot. |
| Committed launcher checksums | `ClaudeVZRunner`, `OVMShell`, and `OVMSwarm` matched `SHA256SUMS`. |

The full suite did **not** pass on this host. The failing preflight tests call
`/usr/sbin/lsof` and `/usr/bin/plutil`; both paths are absent on Linux.
The skipped tests require macOS facilities, certificates, a browser, or private
VM inputs. These results do not qualify those paths. The macOS workflow remains
the check for Apple-specific behavior.

The workspace initially created a group-writable `policy.json`, which the normal
MCP route correctly refused. Group/other write permission was removed from that
local file and reran with `umask 022`. The policy rules were not weakened.

## Dependency change

The previous lockfiles selected Hono `4.13.13` through the MCP SDK's existing
`^4.11.4` range. The current npm audit reported one affected dependency, with
five advisories covering middleware routing, CSRF, HTML escaping, and form
validation. The lockfiles now select `4.13.16`, the first version outside those
reported affected ranges. The SDK and direct dependency ranges are unchanged.

The audit links to the upstream advisories:
[mount prefix middleware](https://github.com/advisories/GHSA-4m76-xfj5-7975),
[wildcard middleware](https://github.com/advisories/GHSA-h7mg-cq63-vhpq),
[CSS interpolation](https://github.com/advisories/GHSA-3gg2-335m-rxc6),
[CSRF checks](https://github.com/advisories/GHSA-46wx-v44x-9hh2), and
[form validation](https://github.com/advisories/GHSA-4h7h-rv7c-7m2v).
The clean audit describes the advisory database at this verification time.

## Scope

No VM was booted, no model inference was run, and no remote controller was
enrolled or used. Native launchers were checksum-checked but were not executed,
rebuilt, or signature-verified on this Linux host.

A static check of the 196 tracked files found no credential-pattern match
except the deliberately fake private-key marker in a redaction test. The source
tree contains no guest images, model weights, saved gents, controller authority,
or private native add-ons. This check covers the current tracked tree; it is not
a claim about arbitrary files in Git history or private capsule contents.

The October and November 6 verification documents retain their original dates
and platform scope. Their private receipt paths describe the earlier development
environment; those receipts are not supplied by a public clone.
