"""Exercise the guest relay with a local TCP stand-in for the host VSOCK peer."""
import contextlib
import importlib.util
import json
from pathlib import Path
import socket
import tempfile
import threading
import time
import unittest

spec = importlib.util.spec_from_file_location('research_proxy', Path(__file__).resolve().parents[1] / 'guest/research-proxy.py')
proxy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proxy)


def receive_all(connection):
    output = bytearray()
    while True:
        data = connection.recv(65536)
        if not data:
            return bytes(output)
        output.extend(data)


@contextlib.contextmanager
def backend(handler):
    listener = socket.socket()
    listener.bind(('127.0.0.1', 0))
    listener.listen(32)
    listener.settimeout(.1)
    address = listener.getsockname()
    stopped, workers, errors = threading.Event(), [], []

    def handle(connection):
        try:
            with connection:
                connection.settimeout(3)
                handler(connection)
        except (OSError, AssertionError) as exc:
            if not stopped.is_set():
                errors.append(exc)

    def accept():
        while not stopped.is_set():
            try:
                connection, _ = listener.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            worker = threading.Thread(target=handle, args=(connection,), daemon=True)
            workers.append(worker)
            worker.start()

    thread = threading.Thread(target=accept, daemon=True)
    thread.start()
    try:
        yield address, errors
    finally:
        stopped.set()
        listener.close()
        thread.join(1)
        for worker in workers:
            worker.join(1)


@contextlib.contextmanager
def relay(address, **options):
    options.setdefault('logger', lambda record: None)
    server = proxy.RelayServer(port=0, socket_factory=lambda: (socket.socket(), address), **options)
    errors = []

    def run():
        try:
            server.run()
        except Exception as exc:
            errors.append(exc)

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.request_stop()
        thread.join(2)
        if thread.is_alive():
            raise AssertionError('Relay failed to stop within test deadline')
        if errors:
            raise errors[0]


class RelayTests(unittest.TestCase):
    def test_connect_and_binary_stream_survive_half_close(self):
        payload = bytes(range(256)) * 8192
        request = b'CONNECT example.org:443 HTTP/1.1\r\nHost: example.org:443\r\n\r\n'
        received = []

        def host(connection):
            header = bytearray()
            while not header.endswith(b'\r\n\r\n'):
                byte = connection.recv(1)
                if not byte:
                    raise AssertionError('CONNECT header truncated')
                header.extend(byte)
            received.append(bytes(header))
            connection.sendall(b'HTTP/1.1 200 Connection Established\r\n\r\n')
            data = receive_all(connection)
            received.append(data)
            for offset in range(0, len(data), 7001):
                connection.sendall(data[offset:offset + 7001])
            connection.shutdown(socket.SHUT_WR)

        with backend(host) as (address, errors), relay(address, max_buffer=8192) as server:
            with socket.create_connection(('127.0.0.1', server.port), timeout=5) as client:
                client.sendall(request)
                response = bytearray()
                while not response.endswith(b'\r\n\r\n'):
                    response.extend(client.recv(1))
                self.assertEqual(bytes(response), b'HTTP/1.1 200 Connection Established\r\n\r\n')
                client.sendall(payload)
                client.shutdown(socket.SHUT_WR)
                self.assertEqual(receive_all(client), payload)
            self.assertLessEqual(server.stats['peak_buffer_bytes'], 8192)
        self.assertEqual(received, [request, payload])
        self.assertFalse(errors)

    def test_upstream_half_close_still_allows_client_upload(self):
        received = []

        def host(connection):
            connection.sendall(b'ready')
            connection.shutdown(socket.SHUT_WR)
            received.append(receive_all(connection))

        with backend(host) as (address, errors), relay(address) as server:
            with socket.create_connection(('127.0.0.1', server.port), timeout=3) as client:
                self.assertEqual(receive_all(client), b'ready')
                client.sendall(b'upload after upstream write EOF')
                client.shutdown(socket.SHUT_WR)
            deadline = time.monotonic() + 1
            while not received and time.monotonic() < deadline:
                time.sleep(.01)
        self.assertEqual(received, [b'upload after upstream write EOF'])
        self.assertFalse(errors)

    def test_limit_rejects_extra_connection_without_unbounded_workers(self):
        def host(connection):
            receive_all(connection)

        with backend(host) as (address, _), relay(address, max_connections=1, shutdown_grace=.2) as server:
            first = socket.create_connection(('127.0.0.1', server.port), timeout=2)
            try:
                deadline = time.monotonic() + 1
                while server.stats['accepted'] < 1 and time.monotonic() < deadline:
                    time.sleep(.01)
                with socket.create_connection(('127.0.0.1', server.port), timeout=2) as second:
                    self.assertEqual(second.recv(1), b'')
                self.assertEqual(server.stats['peak_connections'], 1)
                self.assertEqual(server.stats['rejected'], 1)
            finally:
                first.close()

    def test_idle_connection_expires(self):
        with backend(lambda connection: receive_all(connection)) as (address, _), relay(address, idle_timeout=.1) as server:
            with socket.create_connection(('127.0.0.1', server.port), timeout=2) as client:
                self.assertEqual(client.recv(1), b'')
            self.assertEqual(server.stats['timeouts'], 1)

    def test_readiness_only_claims_loopback_binding_and_is_removed(self):
        with tempfile.TemporaryDirectory() as directory:
            ready = Path(directory) / 'ready.json'
            with backend(lambda connection: receive_all(connection)) as (address, _), relay(address, ready_file=ready) as server:
                deadline = time.monotonic() + 1
                while not ready.exists() and time.monotonic() < deadline:
                    time.sleep(.01)
                info = json.loads(ready.read_text())
                self.assertEqual(info['host'], '127.0.0.1')
                self.assertEqual(info['port'], server.port)
                self.assertEqual(info['vsock_cid'], 2)
                self.assertIn('upstream connectivity not yet verified', info['scope'])
                self.assertEqual(ready.stat().st_mode & 0o777, 0o600)
            self.assertFalse(ready.exists())

    def test_refused_upstream_closes_client_without_crashing_relay(self):
        dead = socket.socket()
        dead.bind(('127.0.0.1', 0))
        address = dead.getsockname()
        dead.close()
        events = []
        with relay(address, logger=events.append) as server:
            with socket.create_connection(('127.0.0.1', server.port), timeout=2) as client:
                self.assertEqual(client.recv(1), b'')
            self.assertEqual(server.stats['errors'], 1)
        failures = [event for event in events if event['event'] in ('connect_error', 'transfer_error')]
        self.assertEqual(len(failures), 1)
        self.assertEqual(failures[0]['errno_name'], 'ECONNREFUSED')
        self.assertEqual(events[-1]['event'], 'stopped')
        self.assertNotIn('url', json.dumps(events))

    def test_upstream_empty_close_and_log_rate_limit_are_visible(self):
        events = []
        with backend(lambda connection: None) as (address, _), relay(address, logger=events.append) as server:
            with socket.create_connection(('127.0.0.1', server.port), timeout=2) as client:
                self.assertEqual(client.recv(1), b'')
            for _ in range(1000):
                server._log('synthetic_error', errno=5)
        self.assertTrue(any(event['event'] == 'vsock_eof_without_response' for event in events))
        self.assertLess(sum(event['event'] == 'synthetic_error' for event in events), 20)

    def test_stop_drains_active_exchange_and_closes_listener(self):
        def host(connection):
            data = receive_all(connection)
            connection.sendall(data)

        with backend(host) as (address, _), relay(address, shutdown_grace=1) as server:
            with socket.create_connection(('127.0.0.1', server.port), timeout=2) as client:
                client.sendall(b'keep pending bytes')
                deadline = time.monotonic() + 1
                while server.stats['accepted'] < 1 and time.monotonic() < deadline:
                    time.sleep(.01)
                server.request_stop()
                client.shutdown(socket.SHUT_WR)
                self.assertEqual(receive_all(client), b'keep pending bytes')


if __name__ == '__main__':
    unittest.main()
