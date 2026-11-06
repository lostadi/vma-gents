import importlib.machinery
import importlib.util
import ipaddress
import json
from pathlib import Path
import unittest


loader = importlib.machinery.SourceFileLoader("ovm_guest_start", str(Path(__file__).parents[1] / "guest/ovm-guest-start"))
spec = importlib.util.spec_from_loader(loader.name, loader)
guest = importlib.util.module_from_spec(spec)
loader.exec_module(guest)


def lease(interface, router=None):
    option = "" if router is None else f"  option routers {router};\n"
    return f'lease {{\n  interface "{interface}";\n  fixed-address 192.168.64.32;\n{option}}}\n'


class RoutingTests(unittest.TestCase):
    def test_guest_distribution_failure_does_not_disable_local_runtime(self):
        attempted = []
        def failed(identity):
            attempted.append(identity)
            raise RuntimeError("Nebula cannot start")
        identity = {"address": "10.87.1.2"}
        ready, reason = guest.optional_mesh("auto", True, identity, initialize=failed)
        self.assertFalse(ready)
        self.assertIn("Nebula cannot start", reason)
        self.assertEqual(guest.optional_mesh("local", True, identity, initialize=failed), (False, None))
        self.assertEqual(len(attempted), 1)
        with self.assertRaisesRegex(RuntimeError, "Nebula cannot start"):
            guest.optional_mesh("required", True, identity, initialize=failed)
        with self.assertRaisesRegex(RuntimeError, "configuration is unavailable"):
            guest.optional_mesh("required", False, identity, initialize=failed)
        self.assertEqual(guest.optional_mesh("auto", False, identity, "host preparation unavailable", initialize=failed), (False, "host preparation unavailable"))

    def test_dhcp_paths_fit_the_actual_guest_apparmor_profile(self):
        policy = json.loads((Path(__file__).parent / "fixtures/dhclient-apparmor-paths.json").read_text())
        for target, permission in ((guest.DHCLIENT_CONFIG, "configRead"), (guest.DHCLIENT_LEASES, "leaseWrite"), (guest.DHCLIENT_PID, "pidWrite")):
            self.assertTrue(any(target.match(pattern) for pattern in policy[permission]), str(target))
        self.assertFalse(any(Path("/run/ovm/dhclient.leases").match(pattern) for pattern in policy["leaseWrite"]))

    def test_newest_matching_lease_wins_over_stale_and_other_nic(self):
        leases = lease("enp0s2", "192.168.64.254") + lease("enp0s2", "192.168.64.1,192.168.64.2") + lease("enp0s1", "172.16.10.1")
        self.assertEqual(guest.dhcp_router(leases, "enp0s2"), "192.168.64.1")

    def test_newest_missing_router_does_not_reuse_stale_gateway(self):
        with self.assertRaisesRegex(RuntimeError, "Newest DHCP lease.*no router"):
            guest.dhcp_router(lease("enp0s2", "192.168.64.1") + lease("enp0s2"), "enp0s2")
        with self.assertRaisesRegex(RuntimeError, "did not record a lease"):
            guest.dhcp_router(lease("eth0", "192.168.64.1"), "enp0s2")

    def test_invalid_gateways_are_rejected(self):
        for router in ("not-a-gateway", "192.168.64.1 dev eth0", "::1", "0.0.0.0", "127.0.0.1", "224.0.0.1", "255.255.255.255"):
            with self.subTest(router=router), self.assertRaises(RuntimeError):
                guest.dhcp_router(lease("enp0s2", router), "enp0s2")

    def test_nat_routes_survive_late_cowork_default_and_keep_private_links(self):
        routes = [
            (ipaddress.ip_network("172.16.10.0/24"), "enp0s1"),
            (ipaddress.ip_network("192.168.64.0/24"), "enp0s2"),
            (ipaddress.ip_network("10.87.0.0/16"), "ovm0"),
        ]

        def install(*args, **kwargs):
            self.assertEqual(args[:4], ("ip", "-4", "route", "replace"))
            self.assertEqual(args[5:], ("via", "192.168.64.1", "dev", "enp0s2"))
            routes.append((ipaddress.ip_network(args[4]), args[8]))

        guest.prefer_nat_routes("enp0s2", "192.168.64.1", execute=install)
        # Cowork adds its default after the bootstrap has configured NAT.
        routes.append((ipaddress.ip_network("0.0.0.0/0"), "enp0s1"))
        for address, expected in {
            "1.1.1.1": "enp0s2", "100.110.62.97": "enp0s2",
            "192.168.1.10": "enp0s2", "203.0.113.1": "enp0s2",
            "172.16.10.1": "enp0s1", "192.168.64.1": "enp0s2",
            "10.87.1.10": "ovm0",
        }.items():
            destination = ipaddress.ip_address(address)
            matches = [(network.prefixlen, device) for network, device in routes if destination in network]
            self.assertEqual(max(matches)[1], expected, address)


if __name__ == "__main__":
    unittest.main()
