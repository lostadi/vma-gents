#!/usr/bin/env python3
"""Execute one OVM task inside the guest; the seed disk is mounted read-only."""
import base64
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

SEED = Path('/mnt/ovm-seed')


def mount(kind, source, destination, *options):
    Path(destination).mkdir(parents=True, exist_ok=True)
    if subprocess.run(['mountpoint', '-q', destination]).returncode:
        subprocess.run(['mount', '-t', kind, *options, source, destination], check=True)


def bind(source, destination):
    Path(destination).mkdir(parents=True, exist_ok=True)
    subprocess.run(['mount', '--bind', str(source), destination], check=True)
    subprocess.run(['mount', '-o', 'remount,bind,ro', destination], check=True)


def main():
    task = json.loads((SEED / 'task.json').read_text())
    result = {'schema': 'ovm.qemu-worker/v1', 'token': task['token'],
              'agent': task['agentId'], 'commandSha256': hashlib.sha256(task['command'].encode()).hexdigest(),
              'bootstrapExitCode': None, 'exitCode': None, 'error': None,
              'outputBase64': '', 'outputTruncated': False, 'meshReady': False}
    started = time.monotonic()
    try:
        mount('proc', 'proc', '/proc')
        mount('sysfs', 'sysfs', '/sys')
        mount('devpts', 'devpts', '/dev/pts')
        mount('tmpfs', 'tmpfs', '/run')
        Path('/run/ovm').mkdir(exist_ok=True)
        subprocess.run(['ip', 'link', 'set', 'lo', 'up'], check=True)
        if (SEED / 'network').is_dir():
            bind(SEED / 'network', '/run/ovm-config')
        if (SEED / 'artifacts').is_dir():
            bind(SEED / 'artifacts', '/ovm/artifacts')
        environment = dict(os.environ, HOME='/root', USER='root', LOGNAME='root',
                           O_LANG_ROOT='/opt/ostadix', O_BACKENDS_DIR='/opt/ostadix/backends',
                           PATH='/usr/local/bin:/opt/ostadix-toolchain/bin:/usr/sbin:/usr/bin:/sbin:/bin')
        with open('/run/ovm/bootstrap.log', 'wb') as log:
            boot = subprocess.run(['/usr/local/sbin/ovm-guest-start'], env=environment,
                                  stdout=log, stderr=subprocess.STDOUT, timeout=90)
        result['bootstrapExitCode'] = boot.returncode
        ready = Path('/run/ovm/ready.json')
        if ready.exists():
            result.update({k: v for k, v in json.loads(ready.read_text()).items()
                           if k in ('meshReady', 'fallbackReason', 'runtimeReady')})
        if boot.returncode:
            raise RuntimeError('Guest bootstrap failed: ' + Path('/run/ovm/bootstrap.log').read_text(errors='replace')[-4000:])
        env_file = Path('/run/ovm/environment.json')
        if env_file.exists():
            environment.update(json.loads(env_file.read_text()))
        Path('/run/ovm/task.sh').write_bytes(task['command'].encode())
        # A fresh process group lets a deadline stop the command and descendants.
        # Capture on disk so the serial console never becomes a command channel.
        with open('/run/ovm/output', 'wb') as output:
            child = subprocess.Popen(['/bin/bash', '/run/ovm/task.sh'], cwd='/root', env=environment,
                                     stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT,
                                     start_new_session=True)
            try:
                result['exitCode'] = child.wait(timeout=task['timeoutSeconds'])
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
                result['exitCode'] = 124
                result['error'] = 'Guest command exceeded its deadline; partial effects may exist'
        limit = task['maximumOutputBytes']
        with open('/run/ovm/output', 'rb') as output:
            data = output.read(limit + 1)
        result['outputTruncated'] = len(data) > limit
        result['outputBase64'] = base64.b64encode(data[:limit]).decode()
    except Exception as error:
        result['error'] = str(error)[-8000:]
    result['execMs'] = (time.monotonic() - started) * 1000
    os.sync()
    print('\nOVM_QEMU_RECEIPT:' + json.dumps(result, separators=(',', ':')), flush=True)
    # Keep peer services alive until every VM in this round has completed.
    # Only the controller's shutdown token ends this worker's participation.
    while True:
        if sys.stdin.readline().strip() == 'OVM_SHUTDOWN:' + task['token']:
            break
        time.sleep(0.05)
    os.sync()
    subprocess.run(['/sbin/poweroff', '-f'])
    # PID 1 must not exit and panic if the shutdown request failed.
    while True:
        time.sleep(1)


if __name__ == '__main__':
    main()
