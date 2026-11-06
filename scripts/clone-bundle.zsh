#!/bin/zsh
set -euo pipefail

project_root=${0:A:h:h}
private_root="$project_root/vm"
source_bundle=${CLAUDE_VM_SOURCE_BUNDLE:-"$HOME/Library/Application Support/Claude/vm_bundles/claudevm.bundle"}
target_bundle="$private_root/claudevm.bundle"
compatibility_profile="$project_root/compatibility/claude-desktop.json"

profile_value() {
  /usr/bin/plutil -extract "$1" raw -o - "$compatibility_profile"
}

[[ -f "$compatibility_profile" ]] || { print -u2 "missing compatibility profile"; exit 66; }
expected_origin=$(profile_value bundle.rootfsOrigin)
expected_kernel_sha=$(profile_value bundle.vmlinuzSha256)
expected_initrd_sha=$(profile_value bundle.initrdSha256)

[[ -d "$source_bundle" ]] || { print -u2 "missing source bundle: $source_bundle"; exit 66; }
[[ ! -e "$target_bundle" ]] || { print -u2 "refusing to overwrite existing clone: $target_bundle"; exit 73; }

for image in "$source_bundle/rootfs.img" "$source_bundle/sessiondata.img" "$source_bundle/efivars.fd"; do
  if /usr/sbin/lsof -t -- "$image" 2>/dev/null | /usr/bin/grep -q .; then
    print -u2 "Claude's source VM is open: $image"
    exit 75
  fi
done

for origin_file in .rootfs.img.origin .vmlinuz.origin .initrd.origin; do
  actual_origin=$(/bin/cat "$source_bundle/$origin_file")
  [[ "$actual_origin" == "$expected_origin" ]] || {
    print -u2 "source origin changed: $origin_file"
    exit 65
  }
done

actual_kernel_sha=$(/usr/bin/shasum -a 256 "$source_bundle/vmlinuz" | /usr/bin/awk '{print $1}')
actual_initrd_sha=$(/usr/bin/shasum -a 256 "$source_bundle/initrd" | /usr/bin/awk '{print $1}')
[[ "$actual_kernel_sha" == "$expected_kernel_sha" ]] || { print -u2 "source kernel changed"; exit 65; }
[[ "$actual_initrd_sha" == "$expected_initrd_sha" ]] || { print -u2 "source initrd changed"; exit 65; }

/bin/mkdir -p "$private_root"
staging_root=$(/usr/bin/mktemp -d "$private_root/.clone.XXXXXX")
trap '/bin/rm -R -- "$staging_root"' EXIT
staging_bundle="$staging_root/claudevm.bundle"

/bin/cp -c -R -p "$source_bundle" "$staging_bundle"

for name in rootfs.img sessiondata.img efivars.fd machineIdentifier gvisorMacAddress vmlinuz initrd; do
  source_inode=$(/usr/bin/stat -f '%d:%i' "$source_bundle/$name")
  clone_inode=$(/usr/bin/stat -f '%d:%i' "$staging_bundle/$name")
  [[ "$source_inode" != "$clone_inode" ]] || {
    print -u2 "clone entry aliases source inode: $name"
    exit 74
  }
done

/bin/chmod 0700 "$staging_bundle"
/bin/chmod 0600 "$staging_bundle"/{rootfs.img,sessiondata.img,efivars.fd,machineIdentifier,gvisorMacAddress,vmlinuz,initrd}

manifest="$staging_bundle/.direct-boot-manifest-v1.json"
{
  print -r -- '{'
  print -r -- '  "version": 1,'
  print -r -- "  \"rootfsOrigin\": \"$expected_origin\","
  print -r -- "  \"vmlinuzSha256\": \"$expected_kernel_sha\","
  print -r -- "  \"initrdSha256\": \"$expected_initrd_sha\""
  print -r -- '}'
} >| "$manifest"
/bin/chmod 0600 "$manifest"

/bin/mv "$staging_bundle" "$target_bundle"
/bin/rmdir "$staging_root"
trap - EXIT
print "$target_bundle"
