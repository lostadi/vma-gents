#!/usr/bin/env bash
# Run inside the Ubuntu ARM64 provisioning VM, never on the macOS host.
set -Eeuo pipefail

usage() {
  cat <<'USAGE'
Usage: provision.sh [--source /mnt/ovm-provision/ostadix.tar] [--scratch DIRECTORY]

Installs the canonical Ostadix tools, MCP and public hosted language runtimes.
The scratch directory must already be mounted on a separate writable disk.
No disk is formatted, no node identity is generated, and no peer is enrolled.

Environment:
  OVM_BUILD_SCRATCH       Existing directory on the provisioning scratch disk
  OVM_BUILD_JOBS          Cargo compiler processes (default 2)
  OVM_ROOT_RESERVE_MB     Free root disk margin after installation (default 512)
  OVM_KEEP_BUILD          Keep this script's Cargo build artifacts when 1
  OVM_RUST_TOOLCHAIN      Rust toolchain (default: source rust-toolchain.toml)
USAGE
}

fail() { printf '\nOVM provisioning failed: %s\n' "$*" >&2; exit 1; }
phase() { printf '\n=== OVM guest setup: %s ===\n' "$*"; }

source_tar=/mnt/ovm-provision/ostadix.tar
scratch=${OVM_BUILD_SCRATCH:-/work/ovm-provision-build}
while (($#)); do
  case "$1" in
    --source) [[ $# -ge 2 ]] || fail '--source needs a path'; source_tar=$2; shift 2 ;;
    --scratch) [[ $# -ge 2 ]] || fail '--scratch needs a path'; scratch=$2; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) fail "unknown argument: $1" ;;
  esac
done

[[ $(uname -s) == Linux && $(uname -m) == aarch64 ]] || fail 'run this inside the Linux ARM64 VM'
[[ $(id -u) == 0 ]] || fail 'root is required inside the provisioning VM'
# shellcheck disable=SC1091
source /etc/os-release
[[ ${ID:-} == ubuntu && ${VERSION_ID:-} == 22.04 ]] || fail 'this image recipe requires Ubuntu 22.04'
[[ -f "$source_tar" ]] || fail "missing source payload: $source_tar"
[[ -d "$scratch" && -w "$scratch" ]] || fail "mount a writable scratch disk and create $scratch first"
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
[[ -f "$script_dir/smoke.py" ]] || fail 'smoke.py must accompany provision.sh'
scratch=$(realpath -- "$scratch")
[[ "$scratch" != / && "$scratch" != /opt && "$scratch" != /work ]] || fail 'scratch must be a dedicated subdirectory'
[[ $(stat -c %d "$scratch") != $(stat -c %d /) ]] || fail 'build scratch must be on a separate mounted filesystem, not the root disk'

state=/var/lib/ovm/guest
mkdir -p "$state"
chmod 755 "$state"
exec > >(tee -a "$state/provision.log") 2>&1
exec 9>"$scratch/.provision.lock"
flock -n 9 || fail "another provisioning run owns $scratch"
if [[ -e "$scratch/.ovm-build-owner" ]]; then
  [[ $(cat "$scratch/.ovm-build-owner") == ovm-guest-build-v1 ]] || fail 'scratch ownership marker differs'
else
  [[ -z $(find "$scratch" -mindepth 1 -maxdepth 1 ! -name .provision.lock -print -quit) ]] || fail 'scratch directory is not empty and is not managed by OVM'
  printf 'ovm-guest-build-v1\n' > "$scratch/.ovm-build-owner"
fi
export OVM_BUILD_SCRATCH="$scratch"
trap 'status=$?; if ((status)); then printf "OVM guest setup stopped (exit %s); log: %s/provision.log\n" "$status" "$state" >&2; fi' EXIT

phase 'check disk space and source identity'
python3 - "$scratch" <<'PY'
import shutil, sys
free = shutil.disk_usage(sys.argv[1]).free
if free < 3 * 1024**3:
    raise SystemExit(f"Scratch has {free / 1024**3:.2f} GiB free; at least 3 GiB is required for a new build.")
PY
source_sha=$(sha256sum "$source_tar" | cut -d' ' -f1)
if [[ -d /opt/ostadix ]]; then
  [[ -f /opt/ostadix/.ovm-source-sha256 && $(cat /opt/ostadix/.ovm-source-sha256) == "$source_sha" ]] || fail 'existing /opt/ostadix is a different or unmanaged source tree; prepare a fresh base image'
else
  mkdir -p /opt/ostadix
  # The source archive is a repository snapshot, not a disk image. Reject
  # traversal and special files before extracting it as root.
  python3 - "$source_tar" <<'PY'
import pathlib, tarfile, sys
root = pathlib.Path('/opt/ostadix')
with tarfile.open(sys.argv[1], 'r:*') as archive:
    members = archive.getmembers()
    for member in members:
        path = pathlib.PurePosixPath(member.name)
        if path.is_absolute() or '..' in path.parts or not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
            raise SystemExit(f'Unsafe source archive member: {member.name}')
        if member.issym() or member.islnk():
            target = pathlib.PurePosixPath(member.linkname)
            if target.is_absolute() or '..' in target.parts:
                raise SystemExit(f'Unsafe source archive link: {member.name}')
    archive.extractall(root, members=members)
PY
  [[ -f /opt/ostadix/setup.sh && -f /opt/ostadix/Cargo.toml && -f /opt/ostadix/backends/python_shim.py ]] || fail 'ostadix.tar must contain setup.sh, Cargo.toml and backends at its top level'
  printf '%s\n' "$source_sha" > /opt/ostadix/.ovm-source-sha256
fi

export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a
export LC_ALL=C.UTF-8
# These are the canonical setup.sh Debian core + hosted profiles. Java is a
# guest-only addition requested for the major runtime set. No GUI recommends.
packages=(build-essential gcc g++ make python3 python3-pip python3-venv curl git
  pkg-config libssl-dev sqlite3 ca-certificates perl file openssl xz-utils iproute2
  nodejs ruby racket ghc ocaml sbcl mono-devel octave wabt openjdk-17-jdk-headless nix-bin)
phase 'plan public runtime packages'
apt-get update -qq
set +e
LC_ALL=C apt-get --assume-no --no-remove --no-install-recommends install "${packages[@]}" > "$state/apt-plan.txt" 2>&1
apt_plan_status=$?
set -e
cat "$state/apt-plan.txt"
[[ $apt_plan_status == 0 || $apt_plan_status == 1 ]] || fail 'apt could not plan the runtime installation'
python3 - "$state/apt-plan.txt" "${OVM_ROOT_RESERVE_MB:-512}" <<'PY'
from pathlib import Path
import re, shutil, sys
text = Path(sys.argv[1]).read_text()
match = re.search(r'After this operation, ([\d.,]+) ([kMGT]?B) of additional disk space will be used', text)
if match:
    amount = float(match[1].replace(',', ''))
    installed = int(amount * {'B': 1, 'kB': 1000, 'MB': 1000**2, 'GB': 1000**3, 'TB': 1000**4}[match[2]])
elif re.search(r'0 newly installed', text):
    installed = 0
else:
    raise SystemExit('Cannot establish apt installed-space estimate; inspect apt-plan.txt before retrying.')
reserve = int(sys.argv[2]) * 1024**2
# Rust's minimal toolchain + retained Cargo registry and installed Ostadix bins.
remaining_tools = 0 if Path('/opt/ostadix-toolchain/rustup/toolchains').is_dir() else 1100 * 1024**2
free = shutil.disk_usage('/').free
required = installed + remaining_tools + reserve
print(f'Root space: free={free / 1024**3:.2f} GiB, planned packages={installed / 1024**3:.2f} GiB, tools+margin={(remaining_tools + reserve) / 1024**3:.2f} GiB')
if free < required:
    raise SystemExit(f'Root disk needs at least {required / 1024**3:.2f} GiB free before installation; enlarge the private provisioning image. No runtimes were silently omitted.')
PY
phase 'install public runtime packages'
apt-get install -y --no-remove --no-install-recommends "${packages[@]}"
mkdir -p /nix
nix-store --init
nix --extra-experimental-features nix-command eval --json --expr '40 + 2'

phase 'install Rust toolchain'
export RUSTUP_HOME=/opt/ostadix-toolchain/rustup
export CARGO_HOME=/opt/ostadix-toolchain/cargo
export PATH="$CARGO_HOME/bin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin"
source_toolchain=$(python3 -c 'import re; from pathlib import Path; print(re.search(r"channel\s*=\s*\"([^\"]+)\"", Path("/opt/ostadix/rust-toolchain.toml").read_text())[1])')
rust_toolchain=${OVM_RUST_TOOLCHAIN:-$source_toolchain}
export RUSTUP_TOOLCHAIN="$rust_toolchain"
mkdir -p "$RUSTUP_HOME" "$CARGO_HOME" "$scratch/downloads"
if [[ ! -x "$CARGO_HOME/bin/rustup" ]]; then
  curl --proto '=https' --tlsv1.2 -fsSL --retry 3 https://sh.rustup.rs -o "$scratch/downloads/rustup-init.sh"
  sh "$scratch/downloads/rustup-init.sh" -y --profile minimal --default-toolchain "$rust_toolchain" --no-modify-path
else
  rustup toolchain install "$rust_toolchain" --profile minimal
  rustup default "$rust_toolchain"
fi
rustup target add wasm32-wasip1 --toolchain "$rust_toolchain"
python3 - <<'PY'
from pathlib import Path
import re, subprocess
required = re.search(r'rust-version\s*=\s*"([^"]+)"', Path('/opt/ostadix/Cargo.toml').read_text())[1]
actual = subprocess.check_output(['rustc', '--version'], text=True).split()[1]
version = lambda value: tuple(int(n) for n in value.split('-')[0].split('.'))
if version(actual) < version(required):
    raise SystemExit(f'Rust {required}+ is required by the source; got {actual}')
print(f'Rust {actual}, source requires {required}+')
PY

phase 'install verified Wasmtime binary'
# Release asset digest from github.com/bytecodealliance/wasmtime/releases/v49.0.2.
wasmtime_version=49.0.2
wasmtime_sha=ca14988c6da3d92512bd9c3bad6cbd06b1f5743b6911a9e709f1a6fa30637d7f
wasmtime_archive="wasmtime-v${wasmtime_version}-aarch64-linux.tar.xz"
if [[ ! -f "$scratch/downloads/$wasmtime_archive" ]]; then
  curl --proto '=https' --tlsv1.2 -fL --retry 3 \
    "https://github.com/bytecodealliance/wasmtime/releases/download/v${wasmtime_version}/$wasmtime_archive" \
    -o "$scratch/downloads/$wasmtime_archive"
fi
printf '%s  %s\n' "$wasmtime_sha" "$scratch/downloads/$wasmtime_archive" | sha256sum -c -
tar -xJf "$scratch/downloads/$wasmtime_archive" -C "$scratch/downloads" \
  "wasmtime-v${wasmtime_version}-aarch64-linux/wasmtime"
install -m 755 "$scratch/downloads/wasmtime-v${wasmtime_version}-aarch64-linux/wasmtime" /usr/local/bin/wasmtime
wasmtime --version

phase 'install verified guest peer transport'
nebula_version=1.11.2
nebula_sha=85d10e7bc2d121193c1392a1a919172ded7c413f46e602138281cfa9fa1b0231
nebula_archive=nebula-linux-arm64.tar.gz
if [[ ! -f "$scratch/downloads/$nebula_archive" ]]; then
  curl --proto '=https' --tlsv1.2 -fL --retry 3 \
    "https://github.com/slackhq/nebula/releases/download/v${nebula_version}/$nebula_archive" \
    -o "$scratch/downloads/$nebula_archive"
fi
printf '%s  %s\n' "$nebula_sha" "$scratch/downloads/$nebula_archive" | sha256sum -c -
mkdir -p "$scratch/downloads/nebula"
tar -xzf "$scratch/downloads/$nebula_archive" -C "$scratch/downloads/nebula" nebula
install -m 755 "$scratch/downloads/nebula/nebula" /usr/local/bin/nebula
nebula -version

phase 'build canonical Ostadix, MCP, C17 and Python forms'
# setup.sh uses these exact target paths when installing. Keep both builds on
# the scratch filesystem without changing source or disabling capabilities.
for pair in 'target:core-target' 'mcp/ostadix_lang_mcp_server/target:mcp-target'; do
  destination=/opt/ostadix/${pair%%:*}
  build_target=$scratch/${pair#*:}
  mkdir -p "$build_target"
  if [[ -L "$destination" ]]; then
    [[ $(readlink -f "$destination") == "$build_target" ]] || fail "unexpected target link: $destination"
  elif [[ -e "$destination" ]]; then
    fail "expected a clean source snapshot; target already exists: $destination"
  else
    ln -s "$build_target" "$destination"
  fi
done
unset CARGO_TARGET_DIR
export CARGO_BUILD_JOBS=${OVM_BUILD_JOBS:-2}
export CARGO_INCREMENTAL=0
export CARGO_PROFILE_RELEASE_LTO=false
export CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16
export CARGO_PROFILE_RELEASE_DEBUG=0
export O_LANG_ROOT=/opt/ostadix
export O_BACKENDS_DIR=/opt/ostadix/backends
export PYTHONPATH=/opt/ostadix
(
  cd /opt/ostadix
  bash ./setup.sh -y --minimal --with-hosted-runtimes --verify
)

phase 'install guest-wide commands and environment'
python3 /opt/ostadix/scripts/install_native_binaries.py \
  --repo-root /opt/ostadix --bin-dir /usr/local/bin --include-c
install -m 755 /opt/ostadix/mcp/ostadix_lang_mcp_server/target/release/ostadix-mcp /usr/local/bin/ostadix-mcp
install -m 755 /opt/ostadix/scripts/ostadix_mcp_client.py /usr/local/bin/ostadix-mcp-client
install -m 755 "$script_dir/smoke.py" /usr/local/bin/ovm-guest-check
for asset in ovm-guest-start ovm-env.sh ovm-guest.service; do
  [[ -f "$script_dir/$asset" ]] || fail "missing first-boot asset: $asset"
done
install -m 755 "$script_dir/ovm-guest-start" /usr/local/sbin/ovm-guest-start
install -m 755 "$script_dir/ovm-peer" /usr/local/bin/ovm-peer
install -m 755 "$script_dir/ovm-peer-service" /usr/local/sbin/ovm-peer-service
install -m 644 "$script_dir/ovm-env.sh" /etc/profile.d/ovm-env.sh
install -m 644 "$script_dir/ovm-guest.service" /etc/systemd/system/ovm-guest.service
mkdir -p /etc/systemd/system/multi-user.target.wants
ln -sfn /etc/systemd/system/ovm-guest.service /etc/systemd/system/multi-user.target.wants/ovm-guest.service
cat > /etc/profile.d/zz-ovm-start.sh <<'START'
# Interactive init=/bin/bash guests have no systemd to run the first-boot unit.
if [ -r /run/ovm-config/identity.json ] || grep -q 'ovm.network=nat' /proc/cmdline 2>/dev/null; then
  /usr/local/sbin/ovm-guest-start
fi
[ ! -r /etc/profile.d/ovm-env.sh ] || . /etc/profile.d/ovm-env.sh
START
# Native rustc/cargo entry points work in a non-login shell too. Their sysroot
# stays in the durable root image; the disposable target cache is separate.
for command in rustc cargo rustdoc; do
  installed_tool=$(rustup which "$command")
  ln -sfn "$installed_tool" "/usr/local/bin/$command"
done
cat > /etc/profile.d/ovm-ostadix.sh <<'PROFILE'
# Managed by OVM guest/provision.sh.
export O_LANG_ROOT=/opt/ostadix
export O_BACKENDS_DIR=/opt/ostadix/backends
export RUSTUP_HOME=/opt/ostadix-toolchain/rustup
export CARGO_HOME=/opt/ostadix-toolchain/cargo
export PATH="/usr/local/bin:/opt/ostadix-toolchain/cargo/bin:$PATH"
export PYTHONPATH="/opt/ostadix${PYTHONPATH:+:$PYTHONPATH}"
PROFILE
mkdir -p /etc/ovm
cat > /etc/ovm/mcp.json <<'JSON'
{
  "mcpServers": {
    "ostadix": {
      "command": "/usr/local/bin/ostadix-mcp",
      "args": [],
      "env": {
        "O_LANG_ROOT": "/opt/ostadix",
        "O_BACKENDS_DIR": "/opt/ostadix/backends",
        "RUSTUP_HOME": "/opt/ostadix-toolchain/rustup",
        "CARGO_HOME": "/opt/ostadix-toolchain/cargo"
      }
    }
  }
}
JSON
ln -sfn mcp.json /etc/ovm/ostadix-mcp.json
# Do not run node start/doctor here: automatic PKI belongs to each final VM,
# and must never be copied from a provisioned template into sibling agents.
python3 - "$source_sha" "$wasmtime_version" "$wasmtime_sha" "$nebula_version" "$nebula_sha" <<'PY'
from pathlib import Path
import datetime, json, os, platform, subprocess, sys
result = {
    'schema': 'ovm.guest-install/v1',
    'installed_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'architecture': platform.machine(),
    'source_sha256': sys.argv[1],
    'source_root': '/opt/ostadix',
    'canonical_setup': ['--yes', '--minimal', '--with-hosted-runtimes', '--verify'],
    'build_profile': {'lto': False, 'codegen_units': 16, 'jobs': int(os.environ['CARGO_BUILD_JOBS']), 'features_disabled': []},
    'wasmtime': {'version': sys.argv[2], 'archive_sha256': sys.argv[3]},
    'nebula': {'version': sys.argv[4], 'archive_sha256': sys.argv[5]},
    'rust': subprocess.check_output(['rustc', '--version'], text=True).strip(),
    'excluded': {
        'nixos_test': 'Nix is installed; nested NixOS VM test fixtures and virtualization are not qualified by this recipe.',
        'mathematica': 'Requires separately licensed wolframscript.',
        'ubuntu_vm': 'Nested Multipass virtualization is not part of a built-in guest.',
    },
    'node_identity': 'Generated per VM after cloning; none generated by this installer.',
    'verified': False,
}
Path('/var/lib/ovm/guest/install.json').write_text(json.dumps(result, indent=2) + '\n')
PY
phase 'execute guest smoke checks'
/usr/local/bin/ovm-guest-check --output "$state/smoke.json"
python3 - <<'PY'
from pathlib import Path
import json
path = Path('/var/lib/ovm/guest/install.json')
value = json.loads(path.read_text())
smoke = json.loads(Path('/var/lib/ovm/guest/smoke.json').read_text())
if smoke.get('ok') is not True:
    raise SystemExit('Guest verification did not pass')
value['verified'] = True
value['smoke_report'] = '/var/lib/ovm/guest/smoke.json'
path.write_text(json.dumps(value, indent=2) + '\n')
PY
if [[ ${OVM_KEEP_BUILD:-0} != 1 ]]; then
  phase 'remove only owned compilation artifacts'
  [[ $(cat "$scratch/.ovm-build-owner") == ovm-guest-build-v1 ]] || fail 'lost scratch ownership marker'
  # Keep installed sources, native binaries, Rust toolchain and Cargo registry.
  # Remove links as well, so a fresh guest has no dependency on the builder disk.
  rm /opt/ostadix/target /opt/ostadix/mcp/ostadix_lang_mcp_server/target
  rm -rf -- "$scratch/core-target" "$scratch/mcp-target" "$scratch/downloads"
fi
sync
printf '\nOVM_GUEST_PROVISION_OK source=%s report=%s/smoke.json\n' "$source_sha" "$state"
