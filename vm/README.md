# o-gents private VM state

This directory is retained in clean checkouts because the MCP server confines
all writable VM state beneath it. Run `../scripts/clone-bundle.zsh` to create
`claudevm.bundle` from a compatible local Claude Desktop installation.

VM bundles, controller leases, console captures, and local memory files in
this directory are excluded from Git and npm packages.
