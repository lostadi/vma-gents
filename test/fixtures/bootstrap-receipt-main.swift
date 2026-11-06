import Foundation

@main
enum BootstrapReceiptTests {
    static func main() throws {
        if CommandLine.arguments.dropFirst().first == "--waiter-source" {
            print(guestBootstrapWaiter)
            return
        }
        precondition(guestBootstrapIdentityKey(networkID: "network", controllerID: "controller", guestID: "guest") == "0d1d93006a3502a82b935ec3", "host identity digest must match the guest bootstrap marker")
        func receipt(_ mode: String, distribution: String = "auto", meshReady: Any = true, prepared: Any = true, fallbackReason: Any = NSNull()) throws -> String {
            let value: [String: Any] = ["schema": "ovm.guest-bootstrap/v2", "prepared": prepared,
                                        "bootstrap": mode == "nat" ? "root-ready-marker" : "prepared-isolated", "networkMode": mode,
                                        "distributionMode": distribution, "meshReady": meshReady, "fallbackReason": fallbackReason]
            return String(data: try JSONSerialization.data(withJSONObject: value), encoding: .utf8)!
        }
        let nat = try receipt("nat")
        let isolated = try receipt("isolated", meshReady: false)
        let fallback = try receipt("nat", meshReady: false, fallbackReason: "Nebula unavailable")
        let local = try receipt("nat", distribution: "local", meshReady: false)
        let required = try receipt("nat", distribution: "required")
        let unprepared = try receipt("nat", prepared: false)
        func accepts(_ output: String, mode: String = "nat", distribution: String = "auto", exit: Int? = 0,
                     signal: String? = nil, error: String? = nil, truncated: Bool = false) -> Bool {
            validatesGuestBootstrapReceipt(output, exitCode: exit, signal: signal,
                error: error, truncated: truncated, networkMode: mode, distributionMode: distribution)
        }
        precondition(accepts(nat), "matching NAT bootstrap receipt must pass")
        precondition(accepts(fallback), "automatic fallback keeps local runtime ready")
        precondition(accepts(local, distribution: "local"), "local mode does not require a mesh")
        precondition(accepts(required, distribution: "required"), "required mode accepts a locally ready mesh")
        precondition(!accepts(fallback, distribution: "required"), "automatic fallback cannot satisfy required mode")
        let invalidReceipts = [
            (try receipt("nat", distribution: "required", meshReady: false), "nat", "required"),
            (try receipt("nat", distribution: "local"), "nat", "local"),
            (try receipt("isolated"), "isolated", "auto"),
            (try receipt("nat", meshReady: 1), "nat", "auto"),
            (try receipt("nat", prepared: 1), "nat", "auto"),
            (try receipt("nat", fallbackReason: 7), "nat", "auto"),
        ]
        for (output, mode, distribution) in invalidReceipts {
            precondition(!accepts(output, mode: mode, distribution: distribution), "invalid readiness types or required/local mesh state must fail")
        }
        precondition(accepts(isolated, mode: "isolated"), "explicit isolation still verifies installed tools")
        precondition(!accepts(isolated), "a receipt for the wrong network mode must fail")
        precondition(!accepts(nat, exit: nil), "missing process exit must fail")
        precondition(!accepts(nat, exit: 1), "nonzero process exit must fail")
        precondition(!accepts(nat, signal: "SIGKILL"), "a signaled process must fail")
        precondition(!accepts(nat, error: "spawn rejected"), "RPC failure must fail")
        precondition(!accepts(nat, truncated: true), "truncated evidence must fail")
        precondition(!accepts(unprepared), "an unverified profile must fail")
        precondition(!accepts("{}"), "an empty receipt must fail")
        precondition(!accepts("cowork ready"), "Cowork readiness alone must fail")
        precondition(!accepts(nat + nat), "ambiguous multiple receipts must fail")
        print("bootstrap receipts: matching mode and complete terminal evidence passed; automatic fallback and required mesh admission passed")
    }
}
