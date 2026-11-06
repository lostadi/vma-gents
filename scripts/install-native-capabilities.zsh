#!/bin/zsh
set -euo pipefail

project_root=${0:A:h:h}
catalog="$project_root/capabilities/claude-native.json"
install_root=${OVM_NATIVE_INSTALL_ROOT:-$project_root/host/native-root}

[[ -f "$catalog" ]] || { print -u2 "missing native capability catalog: $catalog"; exit 66; }

expected_native=$(/usr/bin/env node -e '
  const c = require(process.argv[1]);
  process.stdout.write(c.providers["claude-native"].qualifiedSha256[0]);
' "$catalog")
expected_computer=$(/usr/bin/env node -e '
  const c = require(process.argv[1]);
  process.stdout.write(c.providers["computer-use"].qualifiedSha256[0]);
' "$catalog")

typeset -a candidate_roots
[[ -n "${OVM_CLAUDE_EXTRACTED_ROOT:-}" ]] && candidate_roots+=("$OVM_CLAUDE_EXTRACTED_ROOT")
candidate_roots+=(
  "$HOME/claude_extracted_binary_macos-master"
  "/Applications/Claude.app/Contents/Resources/app.asar.unpacked"
)

source_root=""
for candidate in "${candidate_roots[@]}"; do
  native="$candidate/node_modules/@ant/claude-native/claude-native-binding.node"
  computer="$candidate/node_modules/@ant/claude-swift/build/Release/computer_use.node"
  if [[ -f "$native" && -f "$computer" ]]; then
    source_root="$candidate"
    break
  fi
done

[[ -n "$source_root" ]] || {
  print -u2 "could not find both decoded native capability binaries"
  print -u2 "set OVM_CLAUDE_EXTRACTED_ROOT to an extracted Claude app root"
  exit 66
}

native_source="$source_root/node_modules/@ant/claude-native/claude-native-binding.node"
computer_source="$source_root/node_modules/@ant/claude-swift/build/Release/computer_use.node"
actual_native=$(/usr/bin/shasum -a 256 "$native_source" | /usr/bin/awk '{print $1}')
actual_computer=$(/usr/bin/shasum -a 256 "$computer_source" | /usr/bin/awk '{print $1}')

[[ "$actual_native" == "$expected_native" ]] || {
  print -u2 "claude-native-binding.node is not a qualified version"
  print -u2 "expected: $expected_native"
  print -u2 "actual:   $actual_native"
  exit 65
}
[[ "$actual_computer" == "$expected_computer" ]] || {
  print -u2 "computer_use.node is not a qualified version"
  print -u2 "expected: $expected_computer"
  print -u2 "actual:   $actual_computer"
  exit 65
}

version="qualified-${actual_native[1,12]}-${actual_computer[1,12]}"
target="$install_root/$version"
temporary="$install_root/.install-$$"
/bin/mkdir -p "$install_root"
/bin/rm -rf "$temporary"
/bin/mkdir -p \
  "$temporary/node_modules/@ant/claude-native" \
  "$temporary/node_modules/@ant/claude-swift/build/Release"

cleanup() {
  /bin/rm -rf "$temporary"
}
trap cleanup EXIT INT TERM

/bin/cp -p "$native_source" \
  "$temporary/node_modules/@ant/claude-native/claude-native-binding.node"
/bin/cp -p "$computer_source" \
  "$temporary/node_modules/@ant/claude-swift/build/Release/computer_use.node"
/bin/chmod 0555 \
  "$temporary/node_modules/@ant/claude-native/claude-native-binding.node" \
  "$temporary/node_modules/@ant/claude-swift/build/Release/computer_use.node"

cat > "$temporary/node_modules/@ant/claude-native/index.js" <<'EOF'
"use strict";
module.exports = require("./claude-native-binding.node");
EOF

/usr/bin/env node - "$temporary/install-manifest.json" "$source_root" "$actual_native" "$actual_computer" <<'EOF'
const fs = require("node:fs");
const [manifestPath, sourceRoot, nativeSha256, computerUseSha256] = process.argv.slice(2);
fs.writeFileSync(manifestPath, `${JSON.stringify({
  schema: "ovm.native-install/v1",
  sourceRoot,
  installedAt: new Date().toISOString(),
  providers: {
    "claude-native": { sha256: nativeSha256 },
    "computer-use": { sha256: computerUseSha256 },
  },
}, null, 2)}\n`, { mode: 0o600 });
EOF

copied_native=$(/usr/bin/shasum -a 256 \
  "$temporary/node_modules/@ant/claude-native/claude-native-binding.node" | /usr/bin/awk '{print $1}')
copied_computer=$(/usr/bin/shasum -a 256 \
  "$temporary/node_modules/@ant/claude-swift/build/Release/computer_use.node" | /usr/bin/awk '{print $1}')
[[ "$copied_native" == "$expected_native" && "$copied_computer" == "$expected_computer" ]] || {
  print -u2 "copied native capability verification failed"
  exit 74
}

target_is_qualified=false
if [[ -f "$target/node_modules/@ant/claude-native/claude-native-binding.node" \
   && -f "$target/node_modules/@ant/claude-swift/build/Release/computer_use.node" ]]; then
  target_native=$(/usr/bin/shasum -a 256 \
    "$target/node_modules/@ant/claude-native/claude-native-binding.node" | /usr/bin/awk '{print $1}')
  target_computer=$(/usr/bin/shasum -a 256 \
    "$target/node_modules/@ant/claude-swift/build/Release/computer_use.node" | /usr/bin/awk '{print $1}')
  [[ "$target_native" == "$expected_native" && "$target_computer" == "$expected_computer" ]] \
    && target_is_qualified=true
fi

if [[ "$target_is_qualified" == true ]]; then
  /bin/rm -rf "$temporary"
else
  previous="$install_root/.previous-$$"
  /bin/rm -rf "$previous"
  [[ -e "$target" ]] && /bin/mv "$target" "$previous"
  /bin/mv "$temporary" "$target"
  /bin/rm -rf "$previous"
fi
/bin/ln -sfn "$version" "$install_root/current"
trap - EXIT INT TERM

installed_native=$(/usr/bin/shasum -a 256 \
  "$target/node_modules/@ant/claude-native/claude-native-binding.node" | /usr/bin/awk '{print $1}')
installed_computer=$(/usr/bin/shasum -a 256 \
  "$target/node_modules/@ant/claude-swift/build/Release/computer_use.node" | /usr/bin/awk '{print $1}')
[[ "$installed_native" == "$expected_native" && "$installed_computer" == "$expected_computer" ]] || {
  print -u2 "installed native capability verification failed"
  exit 74
}

print "installed qualified native capabilities"
print "source: $source_root"
print "target: $target"
print "next: $project_root/bin/ovm-native probe"
