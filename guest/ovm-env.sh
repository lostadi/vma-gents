# Shared by login shells, noninteractive task entry points, and MCP clients.
export O_LANG_ROOT=/opt/ostadix
export O_BACKENDS_DIR=/opt/ostadix/backends
export PATH=/usr/local/bin:/opt/ostadix-toolchain/bin:$PATH
if [ -r /run/ovm/environment.json ]; then
  eval "$(python3 -c 'import json,shlex; print("\n".join("export "+k+"="+shlex.quote(v) for k,v in json.load(open("/run/ovm/environment.json")).items()))')"
fi
