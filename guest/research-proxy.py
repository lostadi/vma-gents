#!/usr/bin/env python3
"""Guest loopback TCP to host VSOCK relay; forwards opaque HTTP/CONNECT bytes.

No HTTP parsing or TLS termination occurs here. The host owns the HTTP proxy.
Readiness means the loopback listener is bound, not that an upstream request ran.
"""

import argparse
import errno
import json
import os
from pathlib import Path
import selectors
import signal
import socket
import sys
import time


class Endpoint:
    def __init__(self, sock, pair, connecting=False):
        self.sock = sock
        self.pair = pair
        self.peer = None
        self.connecting = connecting
        self.read_open = True
        self.write_open = True
        self.out = bytearray()
        self.received = 0
        self.sent = 0


class Pair:
    def __init__(self, started):
        self.started = started
        self.last_activity = started
        self.ends = []
        self.closed = False


class RelayServer:
    def __init__(self, port=18080, vsock_port=18080, *, socket_factory=None,
                 max_connections=32, max_buffer=65536, connect_timeout=10,
                 idle_timeout=120, shutdown_grace=5, ready_file=None, logger=None):
        if not 0 <= port <= 65535 or not 1 <= vsock_port <= 0xFFFFFFFF:
            raise ValueError("Invalid relay port")
        if not 1 <= max_connections <= 32 or not 1024 <= max_buffer <= 65536:
            raise ValueError("Relay supports at most 32 connections and 64 KiB buffers")
        self.vsock_port = vsock_port
        self.socket_factory = socket_factory or self._vsock
        self.max_connections, self.max_buffer = max_connections, max_buffer
        self.connect_timeout, self.idle_timeout = connect_timeout, idle_timeout
        self.shutdown_grace = shutdown_grace
        self.ready_file = Path(ready_file) if ready_file else None
        self.logger = logger
        self.log_counts = {}
        self.selector = selectors.DefaultSelector()
        self.pairs = set()
        self.stopping = False
        self.stop_at = None
        self.closed = False
        self.stats = {"accepted": 0, "rejected": 0, "completed": 0, "errors": 0,
                      "timeouts": 0, "peak_connections": 0, "peak_buffer_bytes": 0}
        self.listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            self.listener.bind(("127.0.0.1", port))
            self.listener.listen(max_connections)
            self.listener.setblocking(False)
            self.port = self.listener.getsockname()[1]
            self.selector.register(self.listener, selectors.EVENT_READ, "listener")
            self.wake_read, self.wake_write = socket.socketpair()
            self.wake_read.setblocking(False)
            self.wake_write.setblocking(False)
            self.selector.register(self.wake_read, selectors.EVENT_READ, "wake")
        except BaseException:
            self.listener.close()
            self.selector.close()
            raise

    def _vsock(self):
        return socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM), (2, self.vsock_port)

    def _log(self, event, **details):
        """Bound diagnostics without exposing forwarded bytes or target URLs."""
        count = self.log_counts.get(event, 0) + 1
        self.log_counts[event] = count
        # First ten events of each kind, then powers of two, cap noisy failures.
        if count > 10 and count & (count - 1):
            return
        record = {"event": event, "occurrence": count, "pid": os.getpid(), **details}
        try:
            if self.logger is not None:
                self.logger(record)
            else:
                print(json.dumps(record, ensure_ascii=True), file=sys.stderr, flush=True)
        except (OSError, ValueError):
            pass

    @staticmethod
    def _error_details(error):
        number = error.errno
        return {"errno": number, "errno_name": errno.errorcode.get(number, "UNKNOWN"),
                "message": os.strerror(number) if isinstance(number, int) else "socket operation failed"}

    @staticmethod
    def _counts(pair):
        front, back = pair.ends
        return {"client_received": front.received, "client_sent": front.sent,
                "vsock_received": back.received, "vsock_sent": back.sent,
                "client_queued": len(front.out), "vsock_queued": len(back.out)}

    def request_stop(self):
        self.stopping = True
        try:
            self.wake_write.send(b"x")
        except (OSError, AttributeError):
            pass

    def _unregister(self, sock):
        try:
            self.selector.unregister(sock)
        except (KeyError, ValueError, OSError):
            pass

    def _close_pair(self, pair, error=False):
        if pair.closed:
            return
        pair.closed = True
        for endpoint in pair.ends:
            self._unregister(endpoint.sock)
            endpoint.sock.close()
            endpoint.out.clear()
        self.pairs.discard(pair)
        self.stats["errors" if error else "completed"] += 1

    def _refresh(self, endpoint):
        if endpoint.pair.closed:
            return
        events = 0
        if endpoint.connecting:
            events = selectors.EVENT_WRITE
        else:
            if endpoint.read_open and endpoint.peer.write_open and len(endpoint.peer.out) < self.max_buffer:
                events |= selectors.EVENT_READ
            if endpoint.out:
                events |= selectors.EVENT_WRITE
        try:
            self.selector.get_key(endpoint.sock)
            registered = True
        except KeyError:
            registered = False
        if events and registered:
            self.selector.modify(endpoint.sock, events, endpoint)
        elif events:
            self.selector.register(endpoint.sock, events, endpoint)
        elif registered:
            self.selector.unregister(endpoint.sock)

    def _propagate_eof(self, endpoint):
        # Data queued for this endpoint must precede its write-side EOF.
        if not endpoint.connecting and not endpoint.peer.read_open and not endpoint.out and endpoint.write_open:
            try:
                endpoint.sock.shutdown(socket.SHUT_WR)
            except OSError as exc:
                if exc.errno not in (errno.ENOTCONN, errno.EPIPE, errno.EBADF):
                    raise
            endpoint.write_open = False

    def _accept(self):
        # Bound work per iteration so established streams cannot be starved.
        for _ in range(self.max_connections):
            try:
                client, _ = self.listener.accept()
            except BlockingIOError:
                return
            if len(self.pairs) >= self.max_connections or self.stopping:
                self.stats["rejected"] += 1
                client.close()
                continue
            upstream = None
            pair = None
            stage = "socket_create"
            try:
                upstream, address = self.socket_factory()
                client.setblocking(False)
                upstream.setblocking(False)
                stage = "connect_ex"
                result = upstream.connect_ex(address)
                self._log("connect_started", result=result, errno_name=errno.errorcode.get(result, "OK"),
                          vsock_cid=2, vsock_port=self.vsock_port)
                if result not in (0, errno.EINPROGRESS, errno.EWOULDBLOCK, errno.EALREADY):
                    raise OSError(result, os.strerror(result))
                pair = Pair(time.monotonic())
                front = Endpoint(client, pair)
                back = Endpoint(upstream, pair, connecting=result != 0)
                front.peer, back.peer = back, front
                pair.ends = [front, back]
                self.pairs.add(pair)
                self.stats["accepted"] += 1
                self.stats["peak_connections"] = max(self.stats["peak_connections"], len(self.pairs))
                stage = "selector_register"
                self._refresh(front)
                self._refresh(back)
            except OSError as exc:
                self._log("connect_error", stage=stage, **self._error_details(exc))
                if pair is not None:
                    self._close_pair(pair, error=True)
                else:
                    client.close()
                    if upstream:
                        upstream.close()
                    self.stats["errors"] += 1

    def _transfer(self, endpoint, mask):
        pair = endpoint.pair
        if pair.closed:
            return
        stage = "connect_completion" if endpoint.connecting else "transfer"
        try:
            if endpoint.connecting and mask & selectors.EVENT_WRITE:
                error = endpoint.sock.getsockopt(socket.SOL_SOCKET, socket.SO_ERROR)
                if error:
                    raise OSError(error, os.strerror(error))
                endpoint.connecting = False
                self._log("connect_ready", vsock_cid=2, vsock_port=self.vsock_port)
            if not endpoint.connecting and mask & selectors.EVENT_READ and endpoint.read_open:
                room = self.max_buffer - len(endpoint.peer.out)
                if room > 0:
                    try:
                        stage = "recv"
                        data = endpoint.sock.recv(room)
                    except BlockingIOError:
                        data = None
                    if data:
                        endpoint.peer.out.extend(data)
                        endpoint.received += len(data)
                        pair.last_activity = time.monotonic()
                        self.stats["peak_buffer_bytes"] = max(self.stats["peak_buffer_bytes"], len(endpoint.peer.out))
                    elif data == b"":
                        endpoint.read_open = False
                        if endpoint is pair.ends[1] and endpoint.received == 0:
                            self._log("vsock_eof_without_response", **self._counts(pair))
            if not endpoint.connecting and mask & selectors.EVENT_WRITE and endpoint.out:
                try:
                    stage = "send"
                    sent = endpoint.sock.send(endpoint.out)
                except BlockingIOError:
                    sent = 0
                if sent:
                    del endpoint.out[:sent]
                    endpoint.sent += sent
                    pair.last_activity = time.monotonic()
            for end in pair.ends:
                stage = "half_close"
                self._propagate_eof(end)
            if all(not end.read_open and not end.out for end in pair.ends):
                self._close_pair(pair)
            else:
                for end in pair.ends:
                    self._refresh(end)
        except OSError as exc:
            self._log("transfer_error", stage=stage,
                      endpoint="client" if endpoint is pair.ends[0] else "vsock",
                      **self._error_details(exc), **self._counts(pair))
            self._close_pair(pair, error=True)

    def _write_ready(self):
        if self.ready_file:
            payload = {"pid": os.getpid(), "host": "127.0.0.1", "port": self.port,
                       "vsock_cid": 2, "vsock_port": self.vsock_port,
                       "scope": "loopback listener bound; upstream connectivity not yet verified"}
            temporary = self.ready_file.with_name(self.ready_file.name + f".{os.getpid()}.tmp")
            with open(temporary, "x", encoding="utf-8") as handle:
                os.chmod(temporary, 0o600)
                json.dump(payload, handle)
            os.replace(temporary, self.ready_file)

    def run(self):
        try:
            self._write_ready()
            self._log("listening", host="127.0.0.1", port=self.port, vsock_cid=2,
                      vsock_port=self.vsock_port, upstream_verified=False)
            while True:
                now = time.monotonic()
                if self.stopping and self.stop_at is None:
                    self.stop_at = now + self.shutdown_grace
                    self._unregister(self.listener)
                    self.listener.close()
                if self.stop_at is not None and (not self.pairs or now >= self.stop_at):
                    break
                for pair in list(self.pairs):
                    connecting = any(endpoint.connecting for endpoint in pair.ends)
                    expired = now - pair.started > self.connect_timeout if connecting else now - pair.last_activity > self.idle_timeout
                    if expired:
                        self.stats["timeouts"] += 1
                        self._log("connection_timeout", stage="connect" if connecting else "idle", **self._counts(pair))
                        self._close_pair(pair, error=True)
                for key, mask in self.selector.select(.2):
                    if key.data == "listener":
                        if not self.stopping:
                            self._accept()
                    elif key.data == "wake":
                        try:
                            self.wake_read.recv(4096)
                        except BlockingIOError:
                            pass
                    else:
                        self._transfer(key.data, mask)
        finally:
            self.close()

    def close(self):
        if self.closed:
            return
        self.closed = True
        for pair in list(self.pairs):
            self._close_pair(pair)
        for sock in (self.listener, self.wake_read, self.wake_write):
            self._unregister(sock)
            sock.close()
        self.selector.close()
        self._log("stopped", stats=dict(self.stats))
        if self.ready_file:
            try:
                if json.loads(self.ready_file.read_text()).get("pid") == os.getpid():
                    self.ready_file.unlink()
            except (OSError, ValueError):
                pass


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=18080)
    parser.add_argument("--vsock-port", type=int, default=18080)
    parser.add_argument("--ready-file")
    parser.add_argument("--idle-timeout", type=float, default=120)
    args = parser.parse_args(argv)
    if not hasattr(socket, "AF_VSOCK"):
        parser.error("AF_VSOCK is unavailable; run this relay inside the Linux guest")
    if not 1 <= args.idle_timeout <= 600:
        parser.error("--idle-timeout must be between 1 and 600 seconds")
    server = RelayServer(args.port, args.vsock_port, idle_timeout=args.idle_timeout, ready_file=args.ready_file)
    for signum in (signal.SIGTERM, signal.SIGINT):
        signal.signal(signum, lambda *_: server.request_stop())
    server.run()
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except OSError as exc:
        print(f"research-proxy: {exc}", file=sys.stderr)
        raise SystemExit(1)
