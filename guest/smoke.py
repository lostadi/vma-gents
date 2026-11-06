#!/usr/bin/env python3
"""Verify installed guest tools using real backend work and MCP stdio calls."""
from __future__ import annotations

import argparse
import datetime
import json
import os
from pathlib import Path
import platform
import queue
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time


TOOLS = ('O', 'o', 'o-cli', 'ostadix-evaluator', 'olangc', 'ocorec', 'o-link',
         'o-unlink', 'ogit', 'o-live-host', 'o-node', 'octl', 'o-registry',
         'o-info', 'ostadix-device', 'ostadix-mcp', 'o-c', 'olangc-c')
VERSIONS = {
    'python': ['python3', '--version'], 'bash': ['bash', '--version'],
    'javascript': ['node', '--version'], 'ruby': ['ruby', '--version'],
    'rust': ['rustc', '--version'], 'cargo': ['cargo', '--version'],
    'c': ['cc', '--version'], 'cpp': ['g++', '--version'],
    'java': ['java', '-version'], 'javac': ['javac', '-version'],
    'sql': ['sqlite3', '--version'], 'haskell': ['ghc', '--version'],
    'ocaml': ['ocaml', '-version'], 'racket': ['racket', '--version'],
    'lisp': ['sbcl', '--version'], 'csharp-compiler': ['mcs', '--version'],
    'csharp-runtime': ['mono', '--version'], 'matlab': ['octave', '--version'],
    'webassembly-converter': ['wat2wasm', '--version'],
    'webassembly-runtime': ['wasmtime', '--version'],
    'peer-transport': ['nebula', '-version'],
    'nix': ['nix', '--version'],
}


def program(backend: str, marker: str) -> str:
    bodies = {
        'python': f'__oval_result__ = "{marker}"',
        'bash': f"printf '%s\\n' '{marker}'",
        'shell': f"printf '%s\\n' '{marker}'",
        'javascript': f'console.log("{marker}");',
        'ruby': f'puts "{marker}"',
        'rust': f'fn main() {{ println!("{marker}"); }}',
        'c': f'#include <stdio.h>\nint main(void) {{ puts("{marker}"); return 0; }}',
        'cpp': f'#include <iostream>\nint main() {{ std::cout << "{marker}" << std::endl; }}',
        'java': f'public class Smoke {{ public static void main(String[] a) {{ System.out.println("{marker}"); }} }}',
        'sql': f"SELECT '{marker}' AS result;",
        'haskell': f'main = putStrLn "{marker}"',
        'ocaml': f'print_endline "{marker}";;',
        'racket': f'#lang racket\n(displayln "{marker}")',
        'lisp': f'(format t "{marker}~%")',
        'common_lisp': f'(format t "{marker}~%")',
        'csharp': f'class Smoke {{ static void Main() {{ System.Console.WriteLine("{marker}"); }} }}',
        'matlab': f"disp('{marker}');",
        'nix': f'"{marker}"',
    }
    return f'{backend}^(\n{bodies[backend]}\n)_{backend}\n'


def text_contains(value: object, marker: str) -> bool:
    if isinstance(value, str):
        return value.strip() == marker
    if isinstance(value, dict):
        return any(text_contains(item, marker) for item in value.values())
    if isinstance(value, list):
        return any(text_contains(item, marker) for item in value)
    return False


def run(argv: list[str], env: dict[str, str], cwd: Path, timeout: float) -> dict:
    process = subprocess.run(argv, cwd=cwd, env=env, capture_output=True,
                             text=True, timeout=timeout)
    result = {'argv': argv, 'exit_code': process.returncode,
              'stdout': process.stdout[-32768:], 'stderr': process.stderr[-32768:]}
    if process.returncode:
        raise RuntimeError(json.dumps(result))
    return result


class MCP:
    def __init__(self, env: dict[str, str], cwd: Path, timeout: float):
        self.timeout = timeout
        self.stderr = tempfile.TemporaryFile(mode='w+b')
        self.process = subprocess.Popen(['ostadix-mcp'], stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=self.stderr,
                                        env=env, cwd=cwd)
        self.responses: queue.Queue = queue.Queue()
        self.reader = threading.Thread(target=self.read, daemon=True)
        self.reader.start()
        self.identifier = 0

    def read(self):
        try:
            for line in self.process.stdout:
                self.responses.put(json.loads(line))
        except Exception as error:
            self.responses.put(error)
        finally:
            self.responses.put(None)

    def send(self, method: str, params: dict, *, notification=False):
        self.identifier += 1
        message = {'jsonrpc': '2.0', 'method': method, 'params': params}
        if not notification:
            message['id'] = self.identifier
        self.process.stdin.write((json.dumps(message) + '\n').encode())
        self.process.stdin.flush()
        if notification:
            return None
        deadline = time.monotonic() + self.timeout
        while time.monotonic() < deadline:
            try:
                response = self.responses.get(timeout=max(0.001, deadline - time.monotonic()))
            except queue.Empty as error:
                raise RuntimeError(f'MCP timeout: {method}') from error
            if response is None or isinstance(response, Exception):
                raise RuntimeError(f'MCP stream ended: {response}')
            if response.get('id') != self.identifier:
                continue
            if 'error' in response:
                raise RuntimeError(f'MCP error: {response["error"]}')
            result = response.get('result')
            if not isinstance(result, dict) or result.get('isError') is True:
                raise RuntimeError(f'MCP unsuccessful result: {result}')
            return result
        raise RuntimeError(f'MCP timeout: {method}')

    def close(self):
        self.process.stdin.close()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=3)
        self.reader.join(timeout=2)
        self.stderr.close()


def mcp_smoke(env: dict[str, str], root: Path, timeout: float) -> dict:
    server = MCP(env, root, timeout)
    try:
        initialized = server.send('initialize', {
            'protocolVersion': '2025-03-26', 'capabilities': {},
            'clientInfo': {'name': 'ovm-guest-check', 'version': '1.0'},
        })
        if not initialized.get('serverInfo'):
            raise RuntimeError('MCP initialize omitted serverInfo')
        server.send('notifications/initialized', {}, notification=True)
        listed = server.send('tools/list', {})
        names = {item.get('name') for item in listed.get('tools', [])}
        required = {'o_env', 'o_smoke', 'o_run', 'o_cli', 'o_runtimes'}
        if not required.issubset(names):
            raise RuntimeError(f'MCP tools missing: {sorted(required - names)}')
        results = {}
        for name in ('o_env', 'o_runtimes', 'o_smoke'):
            result = server.send('tools/call', {'name': name, 'arguments': {}})
            text = '\n'.join(item.get('text', '') for item in result.get('content', [])
                             if item.get('type') == 'text')
            if name == 'o_env' and f'O_LANG_ROOT={root}\n' not in text:
                raise RuntimeError(f'MCP resolved the wrong installation: {text}')
            if name == 'o_smoke' and not ('SMOKE_OK' in text and '[number] 2' in text):
                raise RuntimeError(f'MCP o_smoke did not execute hello.O successfully: {text}')
            results[name] = text
        return {'server': initialized['serverInfo'], 'tools': sorted(names), 'results': results}
    finally:
        server.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path('/opt/ostadix'))
    parser.add_argument('--output', type=Path)
    parser.add_argument('--timeout', type=float, default=90)
    args = parser.parse_args()
    root = args.root.resolve()
    env = dict(os.environ, O_LANG_ROOT=str(root), O_BACKENDS_DIR=str(root / 'backends'),
               PYTHONPATH=str(root), RUSTUP_HOME='/opt/ostadix-toolchain/rustup',
               CARGO_HOME='/opt/ostadix-toolchain/cargo')
    env['PATH'] = '/usr/local/bin:/opt/ostadix-toolchain/cargo/bin:' + env.get('PATH', '/usr/bin:/bin')
    report = {'schema': 'ovm.guest-smoke/v1',
              'checked_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'architecture': platform.machine(), 'source_root': str(root),
              'checks': [], 'ok': False,
              'boundaries': ['No peer connection is attempted by this smoke check.',
                             'Mathematica, nested Multipass and NixOS VM test fixtures are not qualified here.',
                             'Installed-runtime checks do not prove arbitrary application dependencies.']}

    def check(name, action):
        start = time.monotonic()
        result = {'name': name}
        try:
            result['evidence'] = action()
            result['ok'] = True
        except Exception as error:
            result['ok'] = False
            result['error'] = str(error)
        result['seconds'] = round(time.monotonic() - start, 3)
        report['checks'].append(result)
        print(f"[{'ok' if result['ok'] else 'FAIL'}] {name}", flush=True)

    def native_tools():
        if platform.system() != 'Linux' or platform.machine() != 'aarch64':
            raise RuntimeError('This verification requires the Linux ARM64 guest.')
        evidence = {}
        for name in TOOLS:
            found = shutil.which(name, path=env['PATH'])
            if not found:
                raise RuntimeError(f'Missing native command: {name}')
            path = Path(found).resolve()
            with path.open('rb') as stream:
                header = stream.read(20)
            if len(header) != 20 or header[:4] != b'\x7fELF' or header[4:6] != b'\x02\x01' or struct.unpack('<H', header[18:20])[0] != 183:
                raise RuntimeError(f'Not a native Linux ARM64 ELF: {path}')
            evidence[name] = str(path)
        return evidence

    check('native Linux ARM64 Ostadix commands', native_tools)
    if not report['checks'][0]['ok']:
        # Avoid compiling or running host tools when invoked on the wrong OS.
        return finish(report, args.output)
    for name, argv in VERSIONS.items():
        check(f'runtime version: {name}', lambda argv=argv: run(argv, env, root, args.timeout))
    for backend in ('python', 'bash', 'shell', 'javascript', 'ruby', 'rust', 'c', 'cpp',
                    'java', 'sql', 'haskell', 'ocaml', 'racket', 'lisp', 'common_lisp', 'csharp', 'matlab', 'nix'):
        marker = f'OVM_SMOKE_{backend}'

        def evaluate(backend=backend, marker=marker):
            evidence = run(['o', 'e', program(backend, marker), '--json'], env, root, args.timeout)
            value = json.loads(evidence['stdout'])
            if not text_contains(value.get('value'), marker):
                raise RuntimeError(f'{backend} did not return its executed marker: {evidence}')
            return evidence

        check(f'O backend execution: {backend}', evaluate)

    def wasm():
        evidence = run(['o', 'e', (root / 'examples/webassembly_hello.O').read_text(), '--json'], env, root, args.timeout)
        value = json.loads(evidence['stdout'])
        if not text_contains(value.get('value'), 'OSTADIX WEBASSEMBLY BACKEND PASS'):
            raise RuntimeError(f'WebAssembly execution did not return the expected marker: {evidence}')
        return evidence

    check('O backend execution: webassembly', wasm)
    check('C17 reference interpreter', lambda: expect_output(
        run(['o-c', str(root / 'examples/hello.O'), str(root / 'backends')], env, root, args.timeout), '2'))
    check('Python reference interpreter', lambda: expect_output(
        run(['python3', '-m', 'o_lang', str(root / 'examples/hello.O')], env, root, args.timeout), '2'))
    check('o-node command available without generating identity', lambda: run(['o-node', 'serve', '--help'], env, root, args.timeout))
    check('octl client available', lambda: run(['octl', 'node', 'session', '--help'], env, root, args.timeout))
    check('MCP initialize, list tools, environment, runtimes and execution', lambda: mcp_smoke(env, root, args.timeout))
    return finish(report, args.output)


def expect_output(evidence: dict, marker: str) -> dict:
    if marker not in evidence['stdout']:
        raise RuntimeError(f'Expected {marker!r} in command output: {evidence}')
    return evidence


def finish(report: dict, output: Path | None) -> int:
    report['ok'] = bool(report['checks']) and all(check['ok'] for check in report['checks'])
    report['passed'] = sum(check['ok'] for check in report['checks'])
    report['failed'] = len(report['checks']) - report['passed']
    rendered = json.dumps(report, indent=2) + '\n'
    if output:
        output.parent.mkdir(parents=True, exist_ok=True)
        temporary = output.with_name(output.name + '.tmp')
        temporary.write_text(rendered)
        temporary.replace(output)
        print(f"Guest evidence saved to {output}")
    else:
        print(rendered)
    print(f"OVM_GUEST_SMOKE_{'OK' if report['ok'] else 'FAILED'} passed={report['passed']} failed={report['failed']}")
    return 0 if report['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
