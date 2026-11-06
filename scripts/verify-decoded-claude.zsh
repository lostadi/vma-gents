#!/bin/zsh
set -euo pipefail

project_root=${0:A:h:h}
decoded_root="$project_root/research/decoded-claude"
atlas_root="$decoded_root/native-binding-atlas"
o_root=${O_LANG_ROOT:-$HOME/OSTADIX}
backends_dir=${O_BACKENDS_DIR:-$o_root/backends}
o_bin=${OVM_O_BIN:-${commands[O]:-}}
node_bin=${CLAUDE_VM_NODE:-${commands[node]:-}}
mode=${1:-verify}

[[ "$mode" == verify || "$mode" == --rebuild ]] || {
  print -u2 "usage: ${0:t} [--rebuild]"
  exit 64
}
[[ -d "$decoded_root" ]] || { print -u2 "Optional local research is unavailable at $decoded_root; it is not included in the VMAgents repository or required to run gents."; exit 66; }
[[ -x "$o_bin" ]] || { print -u2 "Ostadix O executable is unavailable"; exit 78; }
[[ -d "$backends_dir" ]] || { print -u2 "Ostadix backends are unavailable: $backends_dir"; exit 78; }
[[ -x "$node_bin" ]] || { print -u2 "Node is unavailable"; exit 78; }

(
  cd "$decoded_root"
  /usr/bin/shasum -a 256 -c SHA256SUMS
)

export CLAUDE_DECODED_ROOT="$decoded_root"
export CLAUDE_VM_NODE="$node_bin"

if [[ "$mode" == --rebuild ]]; then
  "$o_bin" "$atlas_root/analyze.O" "$backends_dir"
fi
"$o_bin" "$atlas_root/verify.O" "$backends_dir"
