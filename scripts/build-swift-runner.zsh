#!/bin/zsh
set -euo pipefail

project_root=${0:A:h:h}
host_dir="$project_root/host"
prebuilt_dir="$project_root/prebuilt/macos-arm64"
entitlements="$host_dir/entitlements.plist"
compatibility_profile="$project_root/compatibility/claude-desktop.json"
smol_source=${CLAUDE_VM_SMOL_SOURCE:-/Applications/Claude.app/Contents/Resources/smol-bin.arm64.img}
smol_target="$host_dir/smol-bin.arm64.img"
smol_temp="$smol_target.tmp.$$"
build_dir=$(/usr/bin/mktemp -d "$host_dir/.build.XXXXXX")

profile_value() {
  /usr/bin/plutil -extract "$1" raw -o - "$compatibility_profile"
}

cleanup() {
  /bin/rm -R -- "$build_dir"
  /bin/rm -f -- "$smol_temp"
}
trap cleanup EXIT

[[ "$(/usr/bin/uname -m)" == arm64 ]] || {
  print -u2 "the bundled Swift launchers currently support Apple Silicon only"
  exit 65
}
[[ -f "$smol_source" ]] || { print -u2 "missing Claude helper image: $smol_source"; exit 66; }
[[ -f "$entitlements" ]] || { print -u2 "missing entitlements: $entitlements"; exit 66; }
[[ -f "$compatibility_profile" ]] || { print -u2 "missing compatibility profile"; exit 66; }

expected_smol_sha=$(profile_value helper.sha256)
expected_smol_size=$(profile_value helper.sizeBytes)

actual_smol_sha=$(/usr/bin/shasum -a 256 "$smol_source" | /usr/bin/awk '{print $1}')
actual_smol_size=$(/usr/bin/stat -f '%z' "$smol_source")
[[ "$actual_smol_sha" == "$expected_smol_sha" ]] || {
  print -u2 "Claude helper image changed; refusing an unreviewed build"
  print -u2 "expected: $expected_smol_sha"
  print -u2 "actual:   $actual_smol_sha"
  exit 65
}
[[ "$actual_smol_size" == "$expected_smol_size" ]] || {
  print -u2 "Claude helper image size changed; refusing an unreviewed build"
  print -u2 "expected: $expected_smol_size"
  print -u2 "actual:   $actual_smol_size"
  exit 65
}

typeset -a names=(ClaudeVZRunner OVMShell OVMSwarm)
for name in "${names[@]}"; do
  source_file="$host_dir/$name.swift"
  staged="$build_dir/$name"
  [[ -f "$source_file" ]] || { print -u2 "missing Swift source: $source_file"; exit 66; }

  /usr/bin/xcrun --sdk macosx swiftc \
    -parse-as-library \
    -swift-version 5 \
    -target arm64-apple-macos14.0 \
    -framework Virtualization \
    -O \
    "$source_file" \
    -o "$staged"

  /usr/bin/codesign --force --sign - --timestamp=none \
    --entitlements "$entitlements" "$staged"
  /usr/bin/codesign --verify --strict --verbose=2 "$staged"
done

/bin/cp -c -p "$smol_source" "$smol_temp"
/bin/chmod 0600 "$smol_temp"
copied_smol_sha=$(/usr/bin/shasum -a 256 "$smol_temp" | /usr/bin/awk '{print $1}')
[[ "$copied_smol_sha" == "$expected_smol_sha" ]] || {
  print -u2 "copied helper image failed integrity verification"
  exit 65
}

/bin/mkdir -p "$prebuilt_dir"
for name in "${names[@]}"; do
  /bin/mv -f "$build_dir/$name" "$host_dir/$name"
  /bin/chmod 0755 "$host_dir/$name"
  /bin/cp -c -p "$host_dir/$name" "$prebuilt_dir/$name"
  /bin/chmod 0755 "$prebuilt_dir/$name"
done
/bin/mv -f "$smol_temp" "$smol_target"

installed_smol_sha=$(/usr/bin/shasum -a 256 "$smol_target" | /usr/bin/awk '{print $1}')
[[ "$installed_smol_sha" == "$expected_smol_sha" ]] || {
  print -u2 "installed helper image failed integrity verification"
  exit 65
}

(
  cd "$prebuilt_dir"
  /usr/bin/shasum -a 256 "${names[@]}" >| SHA256SUMS
)

print -l -- "$host_dir/ClaudeVZRunner" "$host_dir/OVMShell" "$host_dir/OVMSwarm"
