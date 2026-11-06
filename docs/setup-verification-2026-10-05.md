# Setup inclusion and manual verification — October 5, 2026

The Claude VM implementation and setup dependencies were inspected in Git,
starting from commit `071e89b062245a26ad5fbc57f41c3e1799b4b823`.
The tracked files include the Swift sources, three prebuilt launchers and their
checksums, entitlements, compatibility profile, bundle cloning and installation
scripts, guest provisioning payloads, MCP server, integration templates, package
lockfile, and model definition. No missing source dependency was found in that
setup chain. Private Claude images/add-ons and downloaded runtimes/model weights
remain external inputs.

This change adds executable `setup.sh` at the repository root. It delegates to
the existing `gent setup` implementation. Setup now also prepares `share/` with
mode `0500`, which the normal Claude MCP runner requires but Git does not retain.
The installer display name was updated from VMAgents to o-gents.

The following operations were performed manually, inspecting each result before
continuing. No automated test suite or scripted test harness was run.

- `./setup.sh --help` returned setup requirements with exit 0.
- Calling the script by absolute path from `/tmp` with `-h` also returned exit 0.
- An unsupported option returned exit 1 before installation started.
- A clean export of the staged Git files, in a path containing spaces and
  without `node_modules` or private VM state, ran `setup.sh --help` successfully.
- In an interactive Node REPL in that export, the production
  `prepareSetupShare` function changed the tracked share directory from `0755`
  to `0500`. Its README contents were unchanged and normal share validation
  returned `readOnly: true`.
- A repeat call succeeded. With the directory absent, preparation created it
  with mode `0500` and validation passed.
- A symlink at `share/` was rejected; its target remained mode `0755`.
- A regular file at `share/` was rejected; its contents and mode `0640` remained
  unchanged.

The disposable export was removed afterward. The full installer, downloads,
guest provisioning, foreign-owner rejection, and other host platforms were not
rerun in this check. The earlier live VM/model results remain separately
documented in [the October 4 record](manual-verification-2026-10-04.md).
