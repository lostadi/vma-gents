# o-gents prebuilt Apple Silicon launchers

These ad-hoc signed Mach-O executables are built from the adjacent Swift
sources under `host/` with a deployment target of macOS 14 on ARM64:

- `ClaudeVZRunner` is the bounded MCP VM backend.
- `OVMShell` is the interactive writable Bash launcher with NAT networking.
- `OVMSwarm` is the bounded parallel writable microVM launcher used by agent
  pockets; each task may select 512-8192 MiB and 1-8 vCPUs.

Verify them before use:

```zsh
cd prebuilt/macos-arm64
shasum -a 256 -c SHA256SUMS
```

The executables do not contain Claude's VM disks or helper image. Each user
must obtain matching inputs from their own local Claude Desktop installation;
the accepted identities are recorded in `../../compatibility/claude-desktop.json`.
`scripts/build-swift-runner.zsh` rebuilds and re-signs all three launchers and
refreshes `SHA256SUMS`.

The bounded MCP runner accepts all paths as arguments. The shell and swarm
launchers accept `--bundle`, `--smol`, and, for the shell, `--share`; the same
paths may be supplied as `OVM_BUNDLE`, `OVM_SMOL`, and `OVM_SHARE`.
The ordinary `gent shell` and `gent fleet` commands provide these paths from the
checkout automatically.
