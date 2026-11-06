import importlib.machinery
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import subprocess
import sys
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
GUEST_ROOT = Path(os.environ.get("OVM_PEER_TEST_GUEST_DIR", ROOT / "guest"))

def load(name, filename):
    loader = importlib.machinery.SourceFileLoader(name, str(GUEST_ROOT / filename))
    spec = importlib.util.spec_from_loader(name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module

service = load("peer_service", "ovm-peer-service")
client = load("peer_client", "ovm-peer")
IDENTITY = {"networkId": "a" * 32, "guestId": "parent", "address": "10.87.1.1"}

class PeerTests(unittest.TestCase):
    def test_only_overlay_addresses_are_accepted(self):
        for address in ["127.0.0.1", "100.110.62.97", "192.168.1.2", "::1", "10.88.1.2"]:
            with self.assertRaises(ValueError):
                service.overlay_address(address)
        self.assertEqual(service.overlay_address("10.87.1.2"), "10.87.1.2")
        registry = {"peers": [{"guestId": "child", "address": "10.87.1.2"}]}
        self.assertEqual(client.resolve_peer("child", registry), "10.87.1.2")
        with self.assertRaises(ValueError):
            client.resolve_peer("unknown", registry)

    def test_http_enrollment_rejects_nonoverlay_and_wrong_network(self):
        class Offers:
            called = 0
            def offer(self):
                self.called += 1
                return {"nodeId": "ostadix-child", "passcode": "private-one-use", "port": 7340}
        offers = Offers()
        handler_class = service.handler_for(IDENTITY, offers, {})
        def invoke(address, payload):
            handler = handler_class.__new__(handler_class)
            handler.client_address = (address, 9999)
            handler.path = "/pair"
            encoded = json.dumps(payload).encode()
            handler.headers = {"Content-Length": str(len(encoded))}
            handler.rfile = io.BytesIO(encoded)
            replies = []
            handler.reply = lambda status, value: replies.append((status, value))
            handler.do_POST()
            return replies[0]
        self.assertEqual(invoke("127.0.0.1", {"networkId": IDENTITY["networkId"]})[0], 403)
        self.assertEqual(invoke("10.87.1.2", {"networkId": "wrong"})[0], 403)
        self.assertEqual(offers.called, 0)
        status, value = invoke("10.87.1.2", {"networkId": IDENTITY["networkId"]})
        self.assertEqual(status, 200)
        self.assertEqual(value["nodeId"], "ostadix-child")
        self.assertEqual(offers.called, 1)

    def test_native_offer_parser_reaps_and_serializes_offers(self):
        with tempfile.TemporaryDirectory() as temporary:
            executable = Path(temporary) / "o-node"
            executable.write_text("#!/usr/bin/env python3\nimport time\nprint('Pairing node: ostadix-fixture', flush=True)\nprint('Passcode: private-fixture-only', flush=True)\ntime.sleep(0.3)\n")
            executable.chmod(0o700)
            environment = dict(os.environ, PATH=temporary + os.pathsep + os.environ["PATH"])
            offers = service.PairingOffers("10.87.1.2", environment)
            offered = offers.offer()
            self.assertEqual(offered["nodeId"], "ostadix-fixture")
            self.assertEqual(offered["port"], 7340)
            with self.assertRaises(BlockingIOError):
                offers.offer()
            deadline = time.monotonic() + 2
            while offers.lock.locked() and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertFalse(offers.lock.locked())

    def test_client_uses_private_stdin_and_reuses_native_pin(self):
        with tempfile.TemporaryDirectory() as temporary:
            environment = dict(os.environ, XDG_CONFIG_HOME=temporary)
            peer = {"networkId": IDENTITY["networkId"], "address": "10.87.1.2", "nodeId": "ostadix-child"}
            calls = []
            def request(address, route, payload=None, **kwargs):
                calls.append(route)
                return peer if route == "/status" else dict(peer, port=7340, passcode="private-fixture-only")
            class Result:
                returncode = 0
            with patch.object(client, "request", request), patch.object(client.subprocess, "run", return_value=Result()) as native:
                self.assertEqual(client.ensure_pair("10.87.1.2", IDENTITY, environment), "ostadix-child")
                arguments = native.call_args.args[0]
                self.assertNotIn("private-fixture-only", arguments)
                self.assertNotIn("--lan-open", arguments)
                self.assertEqual(native.call_args.kwargs["input"], "private-fixture-only\n")
                self.assertEqual(calls, ["/status", "/pair"])
                metadata = Path(temporary) / "ostadix/peers/ostadix-child/peer.json"
                metadata.parent.mkdir(parents=True)
                metadata.write_text(json.dumps({"node_id": "ostadix-child", "address": "10.87.1.2:7337"}))
                native.reset_mock()
                calls.clear()
                self.assertEqual(client.ensure_pair("10.87.1.2", IDENTITY, environment), "ostadix-child")
                native.assert_not_called()
                self.assertEqual(calls, ["/status"])

    def test_remote_run_failure_is_returned_once_without_retry(self):
        context = (IDENTITY, dict(os.environ), {"peers": []})
        with patch.object(client, "load_context", return_value=context), patch.object(client, "ensure_pair", return_value="ostadix-child"), patch.object(client.subprocess, "call", return_value=7) as native, patch.object(client.sys, "argv", ["ovm-peer", "run", "10.87.1.2", "/tmp/task.O"]):
            self.assertEqual(client.main(), 7)
            native.assert_called_once()
            self.assertEqual(native.call_args.args[0], ["octl", "node", "run", "/tmp/task.O", "--node", "ostadix-child"])

class PairingDeadlineTests(unittest.TestCase):
    def environment(self, temporary, **values):
        environment = dict(os.environ, XDG_CONFIG_HOME=temporary)
        environment.pop("OVM_PEER_PAIR_TIMEOUT_SECONDS", None)
        environment.pop("OVM_PEER_PAIR_IO_SECONDS", None)
        environment.update(values)
        return environment

    def responses(self, address, route, payload=None, **kwargs):
        peer = {"networkId": IDENTITY["networkId"], "address": "10.87.1.2", "nodeId": "ostadix-child"}
        return peer if route == "/status" else dict(peer, port=7340, passcode="private-fixture-only")

    def wait_offer(self, offers):
        deadline = time.monotonic() + 3
        while offers.lock.locked() and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertFalse(offers.lock.locked(), "owned native offer was not reaped")

    def test_both_endpoints_share_validated_native_deadlines(self):
        for module in (client, service):
            self.assertEqual(module.pairing_limits({}), {"total": 90, "io": 60, "offer": 120, "ready": 30})
            self.assertEqual(module.pairing_limits({"OVM_PEER_PAIR_TIMEOUT_SECONDS": "5"}), {"total": 5, "io": 5, "offer": 35, "ready": 5})
            self.assertEqual(module.pairing_limits({"OVM_PEER_PAIR_TIMEOUT_SECONDS": "600"})["offer"], 600)
            for bad in ("0", "4", "601", "nan", "1.0", "-5", "５", " 90"):
                with self.assertRaises(ValueError):
                    module.pairing_limits({"OVM_PEER_PAIR_TIMEOUT_SECONDS": bad})
            for bad in ("0", "61", "nan", "-1"):
                with self.assertRaises(ValueError):
                    module.pairing_limits({"OVM_PEER_PAIR_IO_SECONDS": bad})
            with self.assertRaises(ValueError):
                module.pairing_limits({"OVM_PEER_PAIR_TIMEOUT_SECONDS": "5", "OVM_PEER_PAIR_IO_SECONDS": "6"})

    def test_discovery_and_offer_consume_the_same_client_budget(self):
        clock = [100.0]
        requests = []
        def request(address, route, payload=None, **kwargs):
            requests.append((route, kwargs["timeout"]))
            clock[0] += 10
            return self.responses(address, route, payload)
        with tempfile.TemporaryDirectory() as temporary, patch.object(client, "request", request), patch.object(client.time, "monotonic", side_effect=lambda: clock[0]), patch.object(client.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)) as native:
            self.assertEqual(client.ensure_pair("10.87.1.2", IDENTITY, self.environment(temporary)), "ostadix-child")
            self.assertEqual(requests, [("/status", 15), ("/pair", 35)])
            self.assertEqual(native.call_args.kwargs["timeout"], 70)
            self.assertEqual(native.call_args.args[0][-2:], ["--io-timeout-seconds", "60"])

    def test_native_deadline_is_explicit_and_does_not_dispatch_execution(self):
        with tempfile.TemporaryDirectory() as temporary:
            context = (IDENTITY, self.environment(temporary), {"peers": []})
            with patch.object(client, "load_context", return_value=context), patch.object(client, "request", self.responses), patch.object(client.subprocess, "run", side_effect=subprocess.TimeoutExpired(["o-node"], 90, stderr=b"Passcode: private-fixture-only")) as pairing, patch.object(client.subprocess, "call") as execution, patch.object(client.sys, "argv", ["ovm-peer", "run", "10.87.1.2", "/tmp/task.O"]):
                with self.assertRaisesRegex(RuntimeError, "90 s total deadline.*program execution was not dispatched") as error:
                    client.main()
                self.assertNotIn("private-fixture-only", str(error.exception))
                pairing.assert_called_once()
                execution.assert_not_called()

    def test_busy_offer_cannot_restart_total_deadline(self):
        from urllib.error import HTTPError
        clock = [100.0]
        def request(address, route, payload=None, **kwargs):
            if route == "/status":
                return self.responses(address, route)
            raise HTTPError("fixture", 409, "busy", {}, None)
        def sleep(seconds):
            clock[0] += seconds
        with tempfile.TemporaryDirectory() as temporary, patch.object(client, "request", request), patch.object(client.time, "monotonic", side_effect=lambda: clock[0]), patch.object(client.time, "sleep", sleep), patch.object(client.subprocess, "run") as native:
            with self.assertRaisesRegex(RuntimeError, "5 s total deadline"):
                client.ensure_pair("10.87.1.2", IDENTITY, self.environment(temporary, OVM_PEER_PAIR_TIMEOUT_SECONDS="5"))
            self.assertEqual(clock[0], 105.0)
            native.assert_not_called()

    def test_error_observations_do_not_claim_bad_credentials_or_timeout(self):
        raw = b"pairing authentication failed\npeer closed before a complete length prefix\nResource temporarily unavailable (os error 11)\nPasscode: private-fixture-only\n-----BEGIN PRIVATE KEY-----\nsecret\n"
        diagnostic = client.native_diagnostic(raw)
        self.assertEqual(diagnostic["observations"], ["authentication-failed", "incomplete-length-prefix", "io-would-block"])
        self.assertNotIn("private-fixture-only", json.dumps(diagnostic))
        self.assertNotIn("secret", json.dumps(diagnostic))
        self.assertEqual(diagnostic["stderrBytes"], len(raw))
        with tempfile.TemporaryDirectory() as temporary, patch.object(client, "request", self.responses), patch.object(client.subprocess, "run", return_value=subprocess.CompletedProcess([], 1, stderr=raw.decode())) as native:
            with self.assertRaisesRegex(RuntimeError, "exit 1.*io-would-block") as error:
                client.ensure_pair("10.87.1.2", IDENTITY, self.environment(temporary))
            self.assertNotIn("bad password", str(error.exception))
            self.assertNotIn("exceeded", str(error.exception))
            native.assert_called_once()

    def test_actual_offer_drains_verbose_stderr_and_logs_only_safe_observations(self):
        with tempfile.TemporaryDirectory() as temporary:
            executable = Path(temporary) / "o-node"
            arguments = Path(temporary) / "arguments.json"
            executable.write_text("#!" + sys.executable + "\nimport json, sys, time\nfrom pathlib import Path\nPath(" + repr(str(arguments)) + ").write_text(json.dumps(sys.argv[1:]))\nsys.stderr.write('private-fixture-only' * 10000)\nsys.stderr.flush()\nprint('Pairing node: ostadix-fixture', flush=True)\nprint('Passcode: private-fixture-only', flush=True)\ntime.sleep(0.1)\nsys.stderr.write('pairing authentication failed: Resource temporarily unavailable (os error 11)')\nsys.exit(7)\n")
            executable.chmod(0o700)
            environment = self.environment(temporary, PATH=temporary + os.pathsep + os.environ["PATH"])
            offers = service.PairingOffers("10.87.1.2", environment)
            log = io.StringIO()
            with patch.object(service.sys, "stderr", log):
                offered = offers.offer()
                self.assertEqual(offered["expiresInSeconds"], 120)
                self.wait_offer(offers)
            args = json.loads(arguments.read_text())
            self.assertEqual(args[-4:], ["--offer-timeout-seconds", "120", "--io-timeout-seconds", "60"])
            self.assertNotIn("private-fixture-only", log.getvalue())
            records = [json.loads(line.split("] ", 1)[1]) for line in log.getvalue().splitlines()]
            self.assertEqual([record["event"] for record in records], ["offer-ready", "offer-native-failed"])
            self.assertEqual(records[-1]["exitCode"], 7)
            self.assertGreater(records[-1]["stderrBytes"], 100_000)
            self.assertTrue(records[-1]["stderrComplete"])
            self.assertEqual(records[-1]["observations"], ["authentication-failed", "io-would-block"])

    def test_failed_offer_releases_lock_and_keeps_passcodes_private(self):
        with tempfile.TemporaryDirectory() as temporary:
            executable = Path(temporary) / "o-node"
            executable.write_text("#!" + sys.executable + "\nimport sys\nsys.stderr.write('Passcode: do-not-print-this')\nsys.exit(2)\n")
            executable.chmod(0o700)
            offers = service.PairingOffers("10.87.1.2", self.environment(temporary, PATH=temporary + os.pathsep + os.environ["PATH"]))
            log = io.StringIO()
            with patch.object(service.sys, "stderr", log), self.assertRaises(RuntimeError):
                offers.offer()
            self.assertFalse(offers.lock.locked())
            self.assertNotIn("do-not-print-this", log.getvalue())
            self.assertIn("offer-start-failed", log.getvalue())

    def test_offer_outer_deadline_reaps_native_process_and_releases_lock(self):
        with tempfile.TemporaryDirectory() as temporary:
            executable = Path(temporary) / "o-node"
            executable.write_text("#!" + sys.executable + "\nimport time\nprint('Pairing node: ostadix-fixture', flush=True)\nprint('Passcode: private-fixture-only', flush=True)\ntime.sleep(10)\n")
            executable.chmod(0o700)
            offers = service.PairingOffers("10.87.1.2", self.environment(temporary, PATH=temporary + os.pathsep + os.environ["PATH"]))
            offers.limits.update(total=0.15, offer=0.15)
            log = io.StringIO()
            with patch.object(service.sys, "stderr", log):
                offers.offer()
                self.wait_offer(offers)
            self.assertIn("offer-outer-deadline", log.getvalue())

if __name__ == "__main__":
    unittest.main()
