# Optional o-gents integration with Ostadix

These optional `.O` programs preserve the independent lifecycle receipts used
by `o open vm` and `o open vm-exec`. `pocket_swarm.O` launches the communicating
local-Ollama pocket controller and returns its typed swarm receipt.

They discover Node from `PATH` and accept these environment overrides:

- `CLAUDE_VM_ROOT`: physical path to this checkout.
- `CLAUDE_VM_SOURCE_BUNDLE`: Claude Desktop source bundle.
- `CLAUDE_VM_NODE`: Node 26 or newer.
- `OVM_SWARM_MISSION`, `OVM_SWARM_MODEL`, `OVM_SWARM_AGENTS`, and
  `OVM_SWARM_ROUNDS`: pocket swarm configuration.
- `OVM_SWARM_DRY_RUN=1`: verify the swarm plan without Ollama inference or VM
  boot.
- `OVM_NATIVE_ALLOW_ACT=1`: permit cataloged host-changing native capabilities.

Install or link the programs into the local Ostadix terminal integration, then
dispatch them through `O` with the canonical absolute backends directory. The
o-gents MCP and CLI remain usable without host Ostadix; these programs add independent
Ostadix-owned cleanup and source-identity receipts.

Example:

```zsh
OVM_SWARM_DRY_RUN=1 \
OVM_SWARM_MISSION="map available pocket capabilities" \
O integrations/ostadix/pocket_swarm.O /absolute/path/to/OSTADIX/backends
```
