import contextlib
import io
import json
import pathlib
import stat
import sys
from types import SimpleNamespace
from unittest.mock import patch

source = pathlib.Path(sys.argv[1]).read_text()
expected = dict(identityKey="0d1d93006a3502a82b935ec3", address="10.87.1.9")

def run_case(mode="nat", *, distribution="auto", marker=None, uid=0, anchor_uid=0, writable=False,
             caller_writable=False, listener="10.87.1.9:7341", prepared=True, executable=True, succeeds=True,
             mesh_ready=True, overlay=True, fallback_reason=None, readiness_changes=None, marker_kind=stat.S_IFREG,
             expected_clock_calls=None):
    readiness = dict(schema="ovm.guest-ready/v2", identityKey=expected["identityKey"] if marker is None else marker,
                     runtimeReady=True, meshReady=mesh_ready, networkMode=mode,
                     distributionMode=distribution, fallbackReason=fallback_reason)
    readiness.update(readiness_changes or {})
    def read_text(path, *args, **kwargs):
        if str(path) == "/var/lib/ovm/guest/install.json":
            return json.dumps(dict(verified=prepared))
        if str(path) == "/run/ovm/ready.json":
            return json.dumps(readiness)
        return "bwrap"

    def lstat(path, *args, **kwargs):
        kind = marker_kind if str(path) == "/run/ovm/ready.json" else stat.S_IFREG if str(path) == "/var/lib/ovm/guest/install.json" else stat.S_IFDIR
        owner = anchor_uid if str(path) in ("/run", "/var/lib/ovm/guest/install.json") else uid
        return SimpleNamespace(st_mode=kind | (0o777 if writable else 0o755), st_uid=owner, st_gid=owner)

    output = io.StringIO()
    failed = False
    with patch.object(sys, "argv", ["waiter", mode, json.dumps(expected), distribution]), \
         patch("pathlib.Path.read_text", read_text), patch("pathlib.Path.lstat", lstat), \
         patch("pathlib.Path.exists", lambda path: overlay if str(path) == "/sys/class/net/ovm0" else True), patch("os.geteuid", return_value=1062), \
         patch("os.access", side_effect=lambda name, mode: executable if mode == 1 else caller_writable), \
         patch("shutil.which", return_value="/sbin/ss"), \
         patch("subprocess.run", return_value=SimpleNamespace(returncode=0, stdout=f"LISTEN 0 128 {listener} 0.0.0.0:*\n", stderr="")), \
         patch("time.monotonic", side_effect=[0, 91]) as clock, \
         contextlib.redirect_stdout(output), contextlib.redirect_stderr(io.StringIO()):
        try:
            exec(compile(source, "compiled-swift-waiter", "exec"), {})
        except (AssertionError, RuntimeError):
            failed = True
    if expected_clock_calls is not None:
        assert clock.call_count == expected_clock_calls, "terminal mesh failure must not wait for the startup deadline"
    assert failed != succeeds, (mode, marker, uid, writable, listener, prepared, executable)
    if succeeds:
        result = json.loads(output.getvalue())
        assert result == dict(schema="ovm.guest-bootstrap/v2", prepared=True,
                              bootstrap="root-ready-marker" if mode == "nat" else "prepared-isolated",
                              networkMode=mode, distributionMode=distribution,
                              meshReady=mesh_ready if mode == "nat" else False,
                              fallbackReason=fallback_reason if mode == "nat" else None)
    else:
        assert output.getvalue() == "", "failed checks cannot emit a success receipt"

run_case()
run_case(uid=65534, anchor_uid=65534)
run_case(marker="other-guest", succeeds=False)
run_case(uid=1061, succeeds=False)
run_case(uid=1062, anchor_uid=1062, succeeds=False)
run_case(writable=True, succeeds=False)
run_case(caller_writable=True, succeeds=False)
run_case(marker_kind=stat.S_IFLNK, succeeds=False)
run_case(listener="")
run_case(listener="127.0.0.1:7341")
run_case(prepared=False, succeeds=False)
run_case(executable=False, succeeds=False)
run_case(mesh_ready=False, overlay=False, fallback_reason="Mesh unavailable; NAT remains usable")
run_case(distribution="local", mesh_ready=False, overlay=False)
run_case(distribution="required")
run_case(distribution="required", mesh_ready=False, overlay=False, succeeds=False, expected_clock_calls=1)
run_case(distribution="local", mesh_ready=True, succeeds=False)
run_case(mesh_ready=True, overlay=False, succeeds=False)
run_case(mesh_ready=1, succeeds=False)
run_case(readiness_changes={"runtimeReady": False}, succeeds=False)
run_case(readiness_changes={"runtimeReady": 1}, succeeds=False)
run_case(readiness_changes={"schema": "wrong"}, succeeds=False)
run_case(readiness_changes={"networkMode": "isolated"}, succeeds=False)
run_case(readiness_changes={"distributionMode": "local"}, succeeds=False)
run_case(fallback_reason=17, succeeds=False)
run_case("isolated", marker="", listener="", uid=1061)
print("compiled waiter: identity, protected ownership, installed tools, and namespace isolation checks passed")
