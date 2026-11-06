#!/bin/sh
set -eu

# Keep one setup implementation behind both entrypoints.
setup_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
exec "$setup_root/bin/gent" setup "$@"
