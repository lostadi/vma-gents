#!/usr/bin/env python3
"""Keep a QEMU process group within its initiating controller's lifetime."""
import os
import signal
import subprocess
import sys
import time

parent = int(sys.argv[1])
if os.getppid() != parent:
    sys.exit('OVM controller disappeared before QEMU launch')
child = subprocess.Popen(sys.argv[2:], start_new_session=True)


def stop(*_):
    # A finished leader may still have running descendants in its group.
    # Keep the leader unreaped until cleanup so this group ID cannot be reused.
    try:
        os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    except PermissionError:
        # Darwin reports EPERM when only unreaped zombies remain. Do not hide
        # a permission failure if a live process is still in our owned group.
        if sys.platform != 'darwin':
            raise
        processes = subprocess.check_output(['/bin/ps', '-axo', 'pgid=,stat='], text=True)
        states = [fields[1] for row in processes.splitlines()
                  if len(fields := row.split()) == 2 and fields[0] == str(child.pid)]
        if any(not state.startswith('Z') for state in states):
            raise


signal.signal(signal.SIGINT, stop)
signal.signal(signal.SIGTERM, stop)
try:
    while True:
        if os.getppid() != parent:
            stop()
        if os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None:
            break
        time.sleep(0.2)
finally:
    try:
        stop()
    finally:
        # After cleanup, no handler may signal this PID once wait() releases it.
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        child.wait()
sys.exit(child.returncode if child.returncode >= 0 else 128 - child.returncode)
