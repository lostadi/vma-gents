#!/bin/zsh
set -euo pipefail

project_root=${0:A:h:h}
prebuilt="$project_root/prebuilt/macos-arm64"
host_dir="$project_root/host"
install_bin=${OVM_INSTALL_BIN:-$HOME/.local/bin}
compatibility_profile="$project_root/compatibility/claude-desktop.json"
smol_source=${CLAUDE_VM_SMOL_SOURCE:-/Applications/Claude.app/Contents/Resources/smol-bin.arm64.img}
smol_target="$host_dir/smol-bin.arm64.img"
typeset -a names=(ClaudeVZRunner OVMShell OVMSwarm)

profile_value() {
  /usr/bin/plutil -extract "$1" raw -o - "$compatibility_profile"
}

[[ "$(/usr/bin/uname -m)" == arm64 ]] || {
  print -u2 "the prebuilt launchers support Apple Silicon only"
  exit 65
}
[[ -f "$prebuilt/SHA256SUMS" ]] || { print -u2 "missing prebuilt SHA256SUMS"; exit 66; }
[[ -f "$compatibility_profile" ]] || { print -u2 "missing compatibility profile"; exit 66; }
(
  cd "$prebuilt"
  /usr/bin/shasum -a 256 -c SHA256SUMS
)

[[ -f "$smol_source" ]] || { print -u2 "missing Claude helper image: $smol_source"; exit 66; }
expected_smol_sha=$(profile_value helper.sha256)
expected_smol_size=$(profile_value helper.sizeBytes)
actual_smol_sha=$(/usr/bin/shasum -a 256 "$smol_source" | /usr/bin/awk '{print $1}')
actual_smol_size=$(/usr/bin/stat -f '%z' "$smol_source")
[[ "$actual_smol_sha" == "$expected_smol_sha" ]] || {
  print -u2 "Claude helper image is not a reviewed version"
  print -u2 "expected: $expected_smol_sha"
  print -u2 "actual:   $actual_smol_sha"
  exit 65
}
[[ "$actual_smol_size" == "$expected_smol_size" ]] || {
  print -u2 "Claude helper image size is not a reviewed version"
  print -u2 "expected: $expected_smol_size"
  print -u2 "actual:   $actual_smol_size"
  exit 65
}

/bin/mkdir -p "$host_dir" "$install_bin"
for name in "${names[@]}"; do
  /bin/cp -p "$prebuilt/$name" "$host_dir/$name"
  /bin/chmod 0755 "$host_dir/$name"
  /usr/bin/codesign --force --sign - --timestamp=none \
    --entitlements "$host_dir/entitlements.plist" "$host_dir/$name"
  /usr/bin/codesign --verify --strict --verbose=2 "$host_dir/$name"
done

/bin/cp -c -p "$smol_source" "$smol_target"
/bin/chmod 0600 "$smol_target"

/bin/ln -sfn "$project_root/bin/gent" "$install_bin/gent"
/bin/ln -sfn "$project_root/bin/ovm" "$install_bin/ovm"
/bin/ln -sfn "$project_root/bin/claude-vm-mcp" "$install_bin/claude-vm-mcp"
/bin/ln -sfn "$host_dir/ClaudeVZRunner" "$install_bin/ovm-vz"
/bin/ln -sfn "$host_dir/OVMShell" "$install_bin/ovm-shell"
/bin/ln -sfn "$host_dir/OVMSwarm" "$install_bin/ovm-swarm"

print "installed o-gents launchers in $install_bin (gent; ovm remains compatible)"
if [[ ! -d "$project_root/vm/claudevm.bundle" ]]; then
  print "next: $project_root/scripts/clone-bundle.zsh"
fi
