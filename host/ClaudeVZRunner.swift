import Darwin
import CoreFoundation
import CryptoKit
import Foundation
import Virtualization

private func prepareGuestNetworkShare(bundleURL: URL, identity: String, sourceRootfs: String? = nil, distributionMode: String = "auto", runtimeOnly: Bool = false) throws -> (networkShare: URL?, profilePath: String) {
    var roots = [bundleURL.deletingLastPathComponent().deletingLastPathComponent()]
    if let configured = ProcessInfo.processInfo.environment["CLAUDE_VM_ROOT"] {
        roots.insert(URL(fileURLWithPath: configured, isDirectory: true), at: 0)
    }
    var ancestor = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath().deletingLastPathComponent()
    for _ in 0..<4 {
        roots.append(ancestor)
        ancestor.deleteLastPathComponent()
    }
    guard let helper = roots.map({ $0.appendingPathComponent("bin/ovm-network") })
        .first(where: { FileManager.default.fileExists(atPath: $0.path) }) else {
        throw NSError(domain: "OVMNetwork", code: 66, userInfo: [NSLocalizedDescriptionKey:
            "Cannot find bin/ovm-network for guest runtime preparation. Use the OVM launcher from its installed checkout."])
    }
    let process = Process()
    let output = Pipe()
    let finished = DispatchSemaphore(value: 0)
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    process.arguments = ["node", helper.path, "prepare", identity, "--bundle", bundleURL.path, "--distribution", distributionMode]
        + (sourceRootfs.map { ["--image", $0] } ?? [])
        + (runtimeOnly ? ["--runtime-only"] : [])
    process.standardOutput = output
    // Upgrades can print many build lines. Inherit stderr so progress drains
    // while this synchronous prelaunch helper is running.
    process.standardError = FileHandle.standardError
    process.terminationHandler = { _ in finished.signal() }
    try process.run()
    if finished.wait(timeout: .now() + 5_430) == .timedOut {
        process.terminate()
        if finished.wait(timeout: .now() + 2) == .timedOut {
            Darwin.kill(process.processIdentifier, SIGKILL)
            _ = finished.wait(timeout: .now() + 2)
        }
        throw NSError(domain: "OVMNetwork", code: 75, userInfo: [NSLocalizedDescriptionKey: "Guest preparation exceeded its 90-minute upgrade deadline"])
    }
    let data = output.fileHandleForReading.readDataToEndOfFile()
    guard process.terminationStatus == 0 else {
        throw NSError(domain: "OVMNetwork", code: Int(process.terminationStatus), userInfo: [NSLocalizedDescriptionKey: "Guest preparation failed; see the helper error above."])
    }
    guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          object["runtimePrepared"] as? Bool == true,
          let profile = object["runtimeProfilePath"] as? String, profile.hasPrefix("/") else {
        throw NSError(domain: "OVMNetwork", code: 65, userInfo: [NSLocalizedDescriptionKey: "Guest preparation returned no verified runtime profile"])
    }
    if runtimeOnly { return (nil, profile) }
    guard let share = object["networkShare"] as? String, share.hasPrefix("/") else {
        throw NSError(domain: "OVMNetwork", code: 65, userInfo: [NSLocalizedDescriptionKey: "Guest network preparation returned no absolute networkShare"])
    }
    return (URL(fileURLWithPath: share, isDirectory: true), profile)
}


private let guestVsockPort: UInt32 = 51_234
private let consoleCapacity = 64 * 1024
private let guestFrameCapacity = 128 * 1024
private let guestReadChunkCapacity = 64 * 1024
private let guestWriteQueueCapacity = 256 * 1024
private let guestResponseCapacity = 32 * 1024
private let execOutputCapacity = 32 * 1024
private let isolatedNetworkFrameCapacity = 65_535
private let isolatedNetworkDrainBatchCapacity = 256
private let isolatedNetworkSocketSendCapacity: Int32 = 256 * 1024
private let isolatedNetworkSocketReceiveCapacity: Int32 = 1024 * 1024
private let hostCommandCapacity = 128 * 1024
private let runnerJSONLineCapacity = 128 * 1024
private let guestMessageCapacity = 4096
private let pendingExecCapacity = 16

private struct RunnerFailure: Error, CustomStringConvertible {
    let description: String

    init(_ description: String) {
        self.description = description
    }
}

private struct Options {
    let bundleURL: URL?
    let smolURL: URL?
    let shareURL: URL?
    let networkShareURL: URL?
    let memoryGB: Int
    let cpuCount: Int
    let networkMode: String
    let distributionMode: String
    let mode: String

    static func parse(_ arguments: [String]) throws -> Options {
        var values: [String: String] = [:]
        var flags = Set<String>()
        var index = 1
        while index < arguments.count {
            let argument = arguments[index]
            if argument == "--support-only" || argument == "--probe" {
                flags.insert(argument)
                index += 1
                continue
            }
            guard argument.hasPrefix("--"), index + 1 < arguments.count else {
                throw RunnerFailure("invalid argument: \(argument)")
            }
            values[argument] = arguments[index + 1]
            index += 2
        }

        let mode = flags.contains("--support-only") ? "support" : (flags.contains("--probe") ? "probe" : "run")
        if mode == "support" {
            return Options(
                bundleURL: nil,
                smolURL: nil,
                shareURL: nil,
                networkShareURL: nil,
                memoryGB: 4,
                cpuCount: 4,
                networkMode: "nat",
                distributionMode: "auto",
                mode: mode
            )
        }

        guard let bundle = values["--bundle"],
              let smol = values["--smol"],
              let share = values["--share"] else {
            throw RunnerFailure("--bundle, --smol, and --share are required")
        }
        guard let memoryGB = Int(values["--memory-gb"] ?? "4"), (1...8).contains(memoryGB) else {
            throw RunnerFailure("--memory-gb must be between 1 and 8")
        }
        guard let cpuCount = Int(values["--cpu-count"] ?? "4"), (1...8).contains(cpuCount) else {
            throw RunnerFailure("--cpu-count must be between 1 and 8")
        }
        let networkMode = values["--network"] ?? ProcessInfo.processInfo.environment["OVM_NETWORK_MODE"] ?? "nat"
        guard ["nat", "isolated"].contains(networkMode) else {
            throw RunnerFailure("--network must be nat or isolated")
        }
        let distributionMode = values["--distribution"] ?? ProcessInfo.processInfo.environment["OVM_DISTRIBUTION_MODE"] ?? "auto"
        guard ["auto", "local", "required"].contains(distributionMode) else {
            throw RunnerFailure("--distribution must be auto, local, or required")
        }
        let bundleURL = URL(fileURLWithPath: bundle, isDirectory: true)
        var networkShareURL = values["--network-share"].map { URL(fileURLWithPath: $0, isDirectory: true) }
        if mode == "run" {
            let prepared = try prepareGuestNetworkShare(bundleURL: bundleURL, identity: "bundle:\(bundleURL.resolvingSymlinksInPath().path)", distributionMode: distributionMode, runtimeOnly: networkMode == "isolated" || networkShareURL != nil)
            networkShareURL = networkShareURL ?? prepared.networkShare
        }
        return Options(
            bundleURL: bundleURL,
            smolURL: URL(fileURLWithPath: smol),
            shareURL: URL(fileURLWithPath: share, isDirectory: true),
            networkShareURL: networkShareURL,
            memoryGB: memoryGB,
            cpuCount: cpuCount,
            networkMode: networkMode,
            distributionMode: distributionMode,
            mode: mode
        )
    }
}

private let outputLock = NSLock()

private func emit(_ object: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(object),
          var data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else {
        return
    }
    if data.count > runnerJSONLineCapacity {
        var fallback: [String: Any] = [
            "event": "error",
            "stage": "runner-output",
            "message": "runner event exceeded the JSONL output limit",
        ]
        if let requestID = object["requestId"] as? String {
            fallback["requestId"] = requestID
        }
        guard let fallbackData = try? JSONSerialization.data(
            withJSONObject: fallback,
            options: [.sortedKeys]
        ) else { return }
        data = fallbackData
    }
    outputLock.lock()
    defer { outputLock.unlock() }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0a]))
}

private func errorMessage(_ error: Error) -> String {
    if let failure = error as? RunnerFailure { return failure.description }
    return (error as NSError).localizedDescription
}

private func sanitizedGuestOutput(_ text: String) -> String {
    var sanitized = ""
    sanitized.reserveCapacity(text.utf8.count)
    for scalar in text.unicodeScalars {
        switch scalar.value {
        case 0x09, 0x0a, 0x0d:
            sanitized.unicodeScalars.append(scalar)
        case 0x00...0x1f, 0x7f, 0x061c, 0x200e...0x200f, 0x202a...0x202e,
             0x2066...0x2069, 0xfeff:
            sanitized.unicodeScalars.append("\u{fffd}")
        default:
            sanitized.unicodeScalars.append(scalar)
        }
    }
    return sanitized
}

private func boundedUTF8Prefix(_ text: String, maximumBytes: Int) -> (text: String, byteCount: Int) {
    guard maximumBytes > 0 else { return ("", 0) }
    let data = Data(text.utf8)
    guard data.count > maximumBytes else { return (text, data.count) }

    // A valid UTF-8 scalar is at most four bytes, so at most three bytes need
    // to be backed off to preserve a scalar boundary.
    var count = maximumBytes
    while count > 0 {
        let prefix = Data(data.prefix(count))
        if let decoded = String(data: prefix, encoding: .utf8) {
            return (decoded, count)
        }
        count -= 1
    }
    return ("", 0)
}

private func jsonInteger(_ value: Any?) -> Int? {
    guard let value, let number = value as? NSNumber,
          CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
    let double = number.doubleValue
    guard double.isFinite,
          double.rounded(.towardZero) == double,
          double >= Double(Int.min),
          double <= Double(Int.max) else {
        return nil
    }
    return number.intValue
}

func guestBootstrapIdentityKey(networkID: String, controllerID: String, guestID: String) -> String {
    let input = Data("\(networkID):\(controllerID):\(guestID)".utf8)
    return String(SHA256.hash(data: input).map { String(format: "%02x", $0) }.joined().prefix(24))
}

func validatesGuestBootstrapReceipt(_ output: String, exitCode: Int?, signal: String?, error: String?, truncated: Bool, networkMode: String, distributionMode: String = "auto") -> Bool {
    guard exitCode == 0, signal == nil, error == nil, !truncated,
          let data = output.data(using: .utf8),
          let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          Set(value.keys) == ["schema", "prepared", "bootstrap", "networkMode", "distributionMode", "meshReady", "fallbackReason"],
          value["schema"] as? String == "ovm.guest-bootstrap/v2",
          let prepared = value["prepared"] as? NSNumber, CFGetTypeID(prepared) == CFBooleanGetTypeID(), prepared.boolValue,
          let meshReady = value["meshReady"] as? NSNumber, CFGetTypeID(meshReady) == CFBooleanGetTypeID(),
          value["bootstrap"] as? String == (networkMode == "nat" ? "root-ready-marker" : "prepared-isolated"),
          value["networkMode"] as? String == networkMode,
          value["distributionMode"] as? String == distributionMode,
          value["fallbackReason"] is NSNull || value["fallbackReason"] is String else { return false }
    if networkMode == "isolated" && meshReady.boolValue { return false }
    if networkMode == "nat" && distributionMode == "local" && meshReady.boolValue { return false }
    if networkMode == "nat" && distributionMode == "required" && !meshReady.boolValue { return false }
    return true
}

let guestBootstrapWaiter = """
import json, os, pathlib, re, shutil, stat, subprocess, sys, time
mode = sys.argv[1]
expected = json.loads(sys.argv[2])
distribution = sys.argv[3]
class FinalReadinessFailure(RuntimeError):
    pass
def read_diagnostic(name):
    try:
        return pathlib.Path(name).read_text()[:300]
    except Exception as error:
        return type(error).__name__ + ': ' + str(error)[:200]
def file_diagnostic(name):
    try:
        info = pathlib.Path(name).lstat()
        return dict(uid=info.st_uid, gid=info.st_gid, mode=oct(info.st_mode), writable=os.access(name, os.W_OK))
    except Exception as error:
        return type(error).__name__ + ': ' + str(error)[:200]
def link_diagnostic(name):
    try:
        return os.readlink(name)
    except Exception as error:
        return type(error).__name__ + ': ' + str(error)[:200]
def namespace_diagnostic():
    details = dict(selfNetworkNamespace=link_diagnostic('/proc/self/ns/net'),
        initNetworkNamespace=link_diagnostic('/proc/1/ns/net'), routes=read_diagnostic('/proc/net/route'))
    try:
        ss = shutil.which('ss', path='/usr/sbin:/usr/bin:/sbin:/bin')
        result = subprocess.run([ss, '-H', '-ltn'], capture_output=True, text=True, timeout=3)
        details.update(listenerExit=result.returncode, listeners=result.stdout[:1500], listenerError=result.stderr[:300])
    except Exception as error:
        details['listenerError'] = str(error)[:300]
    print('OVM_BOOTSTRAP_NAMESPACE=' + json.dumps(details), file=sys.stderr, flush=True)
def diagnose(error):
    details = dict(euid=os.geteuid(), pid1=read_diagnostic('/proc/1/comm'),
        readyMarker=read_diagnostic('/run/ovm/ready.json'),
        overlayInterface=pathlib.Path('/sys/class/net/ovm0').exists(),
        uidMap=read_diagnostic('/proc/self/uid_map'), gidMap=read_diagnostic('/proc/self/gid_map'),
        readinessFiles={name: file_diagnostic(name) for name in ('/run', '/run/ovm', '/run/ovm/ready.json')},
        lastError=str(error)[-1000:])
    print('OVM_BOOTSTRAP_DIAGNOSTIC=' + json.dumps(details), file=sys.stderr, flush=True)
profile_path = pathlib.Path('/var/lib/ovm/guest/install.json')
profile = json.loads(profile_path.read_text())
assert profile.get('verified') is True, 'Prepared guest installation is not verified'
for tool in ('O', 'o', 'olangc', 'o-node', 'octl', 'ostadix-mcp'):
    assert os.access('/usr/local/bin/' + tool, os.X_OK), 'Missing prepared guest tool: ' + tool
mesh_ready = False
fallback_reason = None
if mode == 'nat':
    deadline = time.monotonic() + 90
    marker = pathlib.Path('/run/ovm/ready.json')
    while True:
        try:
            anchor = pathlib.Path('/run').lstat()
            assert stat.S_ISDIR(anchor.st_mode) and anchor.st_uid != os.geteuid() and not anchor.st_mode & 0o022 and not os.access('/run', os.W_OK), 'Guest system directory is not protected'
            for target, kind in ((profile_path, stat.S_ISREG), (marker.parent, stat.S_ISDIR), (marker, stat.S_ISREG)):
                info = target.lstat()
                assert kind(info.st_mode) and info.st_uid == anchor.st_uid and not info.st_mode & 0o022 and not os.access(target, os.W_OK), 'Guest readiness path is not protected: ' + str(target)
            readiness = json.loads(marker.read_text())
            assert readiness.get('schema') == 'ovm.guest-ready/v2', 'Unexpected guest readiness schema'
            assert readiness.get('identityKey') == expected['identityKey'], 'Guest readiness marker belongs to another identity'
            assert readiness.get('networkMode') == mode, 'Guest readiness network mode does not match'
            assert readiness.get('distributionMode') == distribution, 'Guest readiness distribution mode does not match'
            assert readiness.get('runtimeReady') is True, 'Prepared guest runtime is not ready'
            assert type(readiness.get('meshReady')) is bool, 'Guest mesh readiness is missing or invalid'
            mesh_ready = readiness['meshReady']
            fallback_reason = readiness.get('fallbackReason')
            assert fallback_reason is None or isinstance(fallback_reason, str), 'Guest fallback reason is invalid'
            if distribution == 'required' and not mesh_ready:
                raise FinalReadinessFailure('Required guest mesh is not ready: ' + str(fallback_reason))
            assert distribution != 'local' or not mesh_ready, 'Local guest unexpectedly reports a mesh'
            assert not mesh_ready or pathlib.Path('/sys/class/net/ovm0').exists(), 'Prepared guest overlay interface is missing'
            break
        except Exception as error:
            if isinstance(error, FinalReadinessFailure):
                diagnose(error)
                raise
            if 'not protected' in str(error):
                diagnose(error)
                raise RuntimeError('Guest readiness ownership validation failed: ' + str(error))
            if time.monotonic() >= deadline:
                diagnose(error)
                raise RuntimeError('Root OVM guest bootstrap did not become ready within 90 seconds: ' + str(error))
            time.sleep(0.1)
    namespace_diagnostic()
bootstrap = 'root-ready-marker' if mode == 'nat' else 'prepared-isolated'
print(json.dumps(dict(schema='ovm.guest-bootstrap/v2', prepared=True, bootstrap=bootstrap, networkMode=mode,
    distributionMode=distribution, meshReady=mesh_ready, fallbackReason=fallback_reason)))
"""

private final class PendingGuestExec {
    let requestID: String
    let guestRequestID: String
    let processID: String
    let isBootstrap: Bool
    private var stdoutBytes = Data()
    private var stderrBytes = Data()
    private(set) var outputByteCount = 0
    private(set) var truncated = false
    var spawnAcknowledged = false
    var exitReceived = false
    var deferredExitCode: Int?
    var deferredSignal: String?
    var deferredOomKillCount: Int?

    init(requestID: String, guestRequestID: String, processID: String, isBootstrap: Bool = false) {
        self.requestID = requestID
        self.guestRequestID = guestRequestID
        self.processID = processID
        self.isBootstrap = isBootstrap
    }

    func appendOutput(_ text: String, isStderr: Bool) -> (forwarded: String, becameTruncated: Bool) {
        let sanitized = sanitizedGuestOutput(text)
        let sourceByteCount = sanitized.utf8.count
        let remaining = max(0, execOutputCapacity - outputByteCount)
        let prefix = boundedUTF8Prefix(sanitized, maximumBytes: remaining)
        let wasTruncated = truncated
        if prefix.byteCount < sourceByteCount { truncated = true }
        outputByteCount += prefix.byteCount
        if prefix.byteCount > 0 {
            if isStderr {
                stderrBytes.append(contentsOf: prefix.text.utf8)
            } else {
                stdoutBytes.append(contentsOf: prefix.text.utf8)
            }
        }
        return (prefix.text, !wasTruncated && truncated)
    }

    var stdout: String { String(decoding: stdoutBytes, as: UTF8.self) }
    var stderr: String { String(decoding: stderrBytes, as: UTF8.self) }
}

private func requireRegularFile(_ url: URL) throws {
    let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
    guard values.isRegularFile == true, values.isSymbolicLink != true else {
        throw RunnerFailure("required regular non-symlink file is missing: \(url.path)")
    }
}

private func requireDirectory(_ url: URL) throws {
    let values = try url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
    guard values.isDirectory == true, values.isSymbolicLink != true else {
        throw RunnerFailure("required non-symlink directory is missing: \(url.path)")
    }
}

private final class ConsoleDrain {
    let attachment: VZFileHandleSerialPortAttachment
    private let pipe = Pipe()
    private let queue: DispatchQueue
    private var source: DispatchSourceRead?
    private var bytes = Data()

    init(queue: DispatchQueue) {
        self.queue = queue
        self.attachment = VZFileHandleSerialPortAttachment(
            fileHandleForReading: nil,
            fileHandleForWriting: pipe.fileHandleForWriting
        )
        let descriptor = pipe.fileHandleForReading.fileDescriptor
        let currentFlags = fcntl(descriptor, F_GETFL)
        if currentFlags >= 0 { _ = fcntl(descriptor, F_SETFL, currentFlags | O_NONBLOCK) }
        let source = DispatchSource.makeReadSource(fileDescriptor: descriptor, queue: queue)
        source.setEventHandler { [weak self] in self?.drain() }
        source.setCancelHandler { [pipe] in
            try? pipe.fileHandleForWriting.close()
            try? pipe.fileHandleForReading.close()
        }
        source.resume()
        self.source = source
    }

    private func drain() {
        let descriptor = pipe.fileHandleForReading.fileDescriptor
        var chunk = [UInt8](repeating: 0, count: 8192)
        while true {
            let count = Darwin.read(descriptor, &chunk, chunk.count)
            if count <= 0 { break }
            bytes.append(chunk, count: count)
            if bytes.count > consoleCapacity {
                bytes.removeFirst(bytes.count - consoleCapacity)
            }
        }
    }

    func tail() -> String {
        drain()
        return String(decoding: bytes, as: UTF8.self)
    }

    func close() {
        if let source {
            source.cancel()
            self.source = nil
        } else {
            try? pipe.fileHandleForWriting.close()
            try? pipe.fileHandleForReading.close()
        }
    }
}

// `coworkd` does not announce RPC readiness until it has an IPv4 route. Give
// it a link without giving it a path to the host or the outside world: VZ owns
// one end of a connected datagram socketpair and this object only drains and
// discards frames from the other end. Nothing is ever bridged or written back.
private final class IsolatedNetworkSink {
    let attachment: VZFileHandleNetworkDeviceAttachment

    private let attachmentFileHandle: FileHandle
    private let sinkFileHandle: FileHandle
    private var source: DispatchSourceRead?

    init(queue: DispatchQueue) throws {
        var descriptors = [Int32](repeating: -1, count: 2)
        guard socketpair(AF_UNIX, SOCK_DGRAM, 0, &descriptors) == 0 else {
            let message = NSError(domain: NSPOSIXErrorDomain, code: Int(errno)).localizedDescription
            throw RunnerFailure("failed to create isolated network socketpair: \(message)")
        }
        var ownsDescriptors = true
        defer {
            if ownsDescriptors {
                Darwin.close(descriptors[0])
                Darwin.close(descriptors[1])
            }
        }

        for descriptor in descriptors {
            let descriptorFlags = fcntl(descriptor, F_GETFD)
            guard descriptorFlags >= 0,
                  fcntl(descriptor, F_SETFD, descriptorFlags | FD_CLOEXEC) == 0 else {
                let message = NSError(domain: NSPOSIXErrorDomain, code: Int(errno)).localizedDescription
                throw RunnerFailure("failed to secure isolated network descriptor: \(message)")
            }

            var sendCapacity = isolatedNetworkSocketSendCapacity
            var receiveCapacity = isolatedNetworkSocketReceiveCapacity
            guard setsockopt(
                descriptor,
                SOL_SOCKET,
                SO_SNDBUF,
                &sendCapacity,
                socklen_t(MemoryLayout<Int32>.size)
            ) == 0,
            setsockopt(
                descriptor,
                SOL_SOCKET,
                SO_RCVBUF,
                &receiveCapacity,
                socklen_t(MemoryLayout<Int32>.size)
            ) == 0 else {
                let message = NSError(domain: NSPOSIXErrorDomain, code: Int(errno)).localizedDescription
                throw RunnerFailure("failed to bound isolated network buffers: \(message)")
            }
        }

        let sinkFlags = fcntl(descriptors[1], F_GETFL)
        guard sinkFlags >= 0,
              fcntl(descriptors[1], F_SETFL, sinkFlags | O_NONBLOCK) == 0 else {
            let message = NSError(domain: NSPOSIXErrorDomain, code: Int(errno)).localizedDescription
            throw RunnerFailure("failed to configure isolated network sink: \(message)")
        }

        let attachmentFileHandle = FileHandle(
            fileDescriptor: descriptors[0],
            closeOnDealloc: true
        )
        let sinkFileHandle = FileHandle(
            fileDescriptor: descriptors[1],
            closeOnDealloc: true
        )
        ownsDescriptors = false

        self.attachmentFileHandle = attachmentFileHandle
        self.sinkFileHandle = sinkFileHandle
        self.attachment = VZFileHandleNetworkDeviceAttachment(
            fileHandle: attachmentFileHandle
        )

        let source = DispatchSource.makeReadSource(
            fileDescriptor: sinkFileHandle.fileDescriptor,
            queue: queue
        )
        source.setEventHandler { [weak self] in self?.drain() }
        source.setCancelHandler { [sinkFileHandle] in
            try? sinkFileHandle.close()
        }
        source.resume()
        self.source = source
    }

    private func drain() {
        let descriptor = sinkFileHandle.fileDescriptor
        var frame = [UInt8](repeating: 0, count: isolatedNetworkFrameCapacity)
        for _ in 0..<isolatedNetworkDrainBatchCapacity {
            let count = frame.withUnsafeMutableBytes { bytes in
                Darwin.recv(descriptor, bytes.baseAddress, bytes.count, 0)
            }
            if count >= 0 { continue }
            if errno == EINTR { continue }
            if errno == EAGAIN || errno == EWOULDBLOCK { return }
            close()
            return
        }
    }

    func close() {
        guard let source else { return }
        self.source = nil
        source.cancel()
        // The VZ endpoint is retained for the lifetime of the attachment and
        // is released with this object after the VM has stopped.
    }

    deinit {
        close()
    }
}

private func stateName(_ state: VZVirtualMachine.State) -> String {
    switch state {
    case .stopped: return "stopped"
    case .running: return "running"
    case .paused: return "paused"
    case .error: return "error"
    case .starting: return "starting"
    case .pausing: return "pausing"
    case .resuming: return "resuming"
    case .stopping: return "stopping"
    case .saving: return "saving"
    case .restoring: return "restoring"
    @unknown default: return "unknown"
    }
}

private func makeConfiguration(
    options: Options,
    hvc0: ConsoleDrain,
    hvc1: ConsoleDrain,
    isolatedNetworkSink: IsolatedNetworkSink
) throws -> VZVirtualMachineConfiguration {
    guard let bundle = options.bundleURL,
          let smol = options.smolURL,
          let share = options.shareURL else {
        throw RunnerFailure("bundle paths are unavailable")
    }
    try requireDirectory(share)

    for url in [
        bundle.appendingPathComponent("machineIdentifier"),
        bundle.appendingPathComponent("gvisorMacAddress"),
        bundle.appendingPathComponent("vmlinuz"),
        bundle.appendingPathComponent("initrd"),
        bundle.appendingPathComponent("rootfs.img"),
        bundle.appendingPathComponent("sessiondata.img"),
        smol,
    ] {
        try requireRegularFile(url)
    }

    let configuration = VZVirtualMachineConfiguration()
    configuration.cpuCount = options.cpuCount
    configuration.memorySize = UInt64(options.memoryGB) * 1024 * 1024 * 1024

    let identifierData = try Data(contentsOf: bundle.appendingPathComponent("machineIdentifier"))
    guard let identifier = VZGenericMachineIdentifier(dataRepresentation: identifierData) else {
        throw RunnerFailure("invalid private machineIdentifier")
    }
    let platform = VZGenericPlatformConfiguration()
    platform.machineIdentifier = identifier
    configuration.platform = platform

    let bootLoader = VZLinuxBootLoader(kernelURL: bundle.appendingPathComponent("vmlinuz"))
    bootLoader.initialRamdiskURL = bundle.appendingPathComponent("initrd")
    bootLoader.commandLine = "root=LABEL=cloudimg-rootfs ro console=hvc0 console=hvc1 fsck.repair=yes console=tty1 console=ttyAMA0 ovm.network=\(options.networkMode) ovm.distribution=\(options.distributionMode) ovm.network_index=1"
    configuration.bootLoader = bootLoader

    func writableNVMe(_ name: String) throws -> VZNVMExpressControllerDeviceConfiguration {
        let attachment = try VZDiskImageStorageDeviceAttachment(
            url: bundle.appendingPathComponent(name),
            readOnly: false,
            cachingMode: .cached,
            synchronizationMode: .fsync
        )
        return VZNVMExpressControllerDeviceConfiguration(attachment: attachment)
    }
    let smolAttachment = try VZDiskImageStorageDeviceAttachment(url: smol, readOnly: true)
    configuration.storageDevices = [
        try writableNVMe("rootfs.img"),
        try writableNVMe("sessiondata.img"),
        VZVirtioBlockDeviceConfiguration(attachment: smolAttachment),
    ]

    configuration.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]
    configuration.memoryBalloonDevices = [VZVirtioTraditionalMemoryBalloonDeviceConfiguration()]
    configuration.socketDevices = [VZVirtioSocketDeviceConfiguration()]

    let network = VZVirtioNetworkDeviceConfiguration()
    network.attachment = isolatedNetworkSink.attachment
    let macText = try String(
        contentsOf: bundle.appendingPathComponent("gvisorMacAddress"),
        encoding: .utf8
    ).trimmingCharacters(in: .whitespacesAndNewlines)
    let macComponents = macText.split(separator: ":", omittingEmptySubsequences: false)
    guard macComponents.count == 6,
          let firstMACOctet = UInt8(macComponents[0], radix: 16),
          firstMACOctet & 0x03 == 0x02,
          let isolatedMACAddress = VZMACAddress(string: macText) else {
        throw RunnerFailure("Cowork network requires a locally administered unicast MAC address")
    }
    network.macAddress = isolatedMACAddress
    configuration.networkDevices = [network]
    if options.networkMode == "nat" {
        // coworkd assigns its fixed 172.16.10.3 address to its original NIC.
        // A separate NAT NIC lets the guest bootstrap obtain a real DHCP route
        // without the Cowork handshake replacing that address.
        let userNetwork = VZVirtioNetworkDeviceConfiguration()
        userNetwork.attachment = VZNATNetworkDeviceAttachment()
        userNetwork.macAddress = VZMACAddress.randomLocallyAdministered()
        configuration.networkDevices.append(userNetwork)
    }

    let console = VZVirtioConsoleDeviceConfiguration()
    let port0 = VZVirtioConsolePortConfiguration()
    port0.name = "claude-daemon-console"
    port0.attachment = hvc0.attachment
    console.ports[0] = port0
    let port1 = VZVirtioConsolePortConfiguration()
    port1.name = "kernel-boot-console"
    port1.isConsole = true
    port1.attachment = hvc1.attachment
    console.ports[1] = port1
    configuration.consoleDevices = [console]

    // coworkd requires this tag, but Claude's private host exposed `/` RW. Give
    // the guest only a fixed project-owned directory and make it read-only.
    let fileSystem = VZVirtioFileSystemDeviceConfiguration(tag: "claudeshared")
    let sharedDirectory = VZSharedDirectory(url: share, readOnly: true)
    fileSystem.share = VZSingleDirectoryShare(directory: sharedDirectory)
    configuration.directorySharingDevices = [fileSystem]
    if let networkShare = options.networkShareURL {
        try requireDirectory(networkShare)
        let configShare = VZVirtioFileSystemDeviceConfiguration(tag: "ovmconfig")
        configShare.share = VZSingleDirectoryShare(directory: VZSharedDirectory(url: networkShare, readOnly: true))
        configuration.directorySharingDevices.append(configShare)
    }
    try configuration.validate()
    return configuration
}

private final class VMController: NSObject, VZVirtualMachineDelegate, VZVirtioSocketListenerDelegate {
    private let options: Options
    private let queue = DispatchQueue(label: "local.lee.claude-vm-mcp.vz")
    private var vm: VZVirtualMachine?
    private var listener: VZVirtioSocketListener?
    private var connection: VZVirtioSocketConnection?
    private var guestReadSource: DispatchSourceRead?
    private var guestWriteSource: DispatchSourceWrite?
    private var guestReadBuffer = Data()
    private var guestWriteBuffer = Data()
    private var acceptedGuestConnection = false
    private var handshakeConfigQueued = false
    private var staticIPAssignmentSent = false
    private var hostProxyConfigSent = false
    private var guestSentReady = false
    private var guestReady = false
    private var guestBootstrapStarted = false
    private var guestBootstrapReady = false
    private var meshReady = false
    private var networkFallbackReason: String?
    private var guestBootstrapError: String?
    private var guestBootstrapTimer: DispatchSourceTimer?
    private var guestMessageCount = 0
    private var nextGuestRequestID: UInt64 = 0
    private var pendingExecByGuestRequestID: [String: PendingGuestExec] = [:]
    private var pendingExecByHostRequestID: [String: PendingGuestExec] = [:]
    private var pendingExecByProcessID: [String: PendingGuestExec] = [:]
    private var hvc0: ConsoleDrain?
    private var hvc1: ConsoleDrain?
    private var isolatedNetworkSink: IsolatedNetworkSink?
    private var stopTimer: DispatchSourceTimer?
    private var stopGeneration: UInt64 = 0
    private var stopping = false
    private var finished = false

    init(options: Options) {
        self.options = options
    }

    func begin() {
        queue.async { [self] in
            do {
                emit([
                    "event": "starting",
                    "backend": "swift-virtualization",
                    "memoryGB": options.memoryGB,
                    "cpuCount": options.cpuCount,
                    "networkMode": options.networkMode,
                    "distributionMode": options.distributionMode,
                    "networkForwarding": options.networkMode == "nat",
                    "networkIsolated": options.networkMode == "isolated",
                    "networkConfigurationShare": options.networkShareURL != nil,
                ])
                let hvc0 = ConsoleDrain(queue: queue)
                let hvc1 = ConsoleDrain(queue: queue)
                self.hvc0 = hvc0
                self.hvc1 = hvc1
                let isolatedNetworkSink = try IsolatedNetworkSink(queue: queue)
                self.isolatedNetworkSink = isolatedNetworkSink
                let configuration = try makeConfiguration(
                    options: options,
                    hvc0: hvc0,
                    hvc1: hvc1,
                    isolatedNetworkSink: isolatedNetworkSink
                )
                let vm = VZVirtualMachine(configuration: configuration, queue: queue)
                vm.delegate = self
                guard let socket = vm.socketDevices.first as? VZVirtioSocketDevice else {
                    throw RunnerFailure("configured Virtio socket device is unavailable")
                }
                let listener = VZVirtioSocketListener()
                listener.delegate = self
                socket.setSocketListener(listener, forPort: guestVsockPort)
                self.listener = listener
                self.vm = vm
                vm.start { [weak self] result in
                    guard let self else { return }
                    switch result {
                    case .success:
                        emit(["event": "vz_started", "state": stateName(vm.state)])
                        if self.stopping { self.requestStopLocked(reason: "stop-during-start") }
                    case .failure(let error):
                        self.failLocked(stage: "start", error: error)
                    }
                }
            } catch {
                self.failLocked(stage: "configuration", error: error)
            }
        }
    }

    func handle(_ command: [String: Any]) {
        queue.async { [self] in
            let requestID = command["requestId"] as? String
            switch command["command"] as? String {
            case "status":
                var response = statusLocked()
                response["event"] = "status"
                if let requestID { response["requestId"] = requestID }
                emit(response)
            case "console":
                let stream = command["stream"] as? String ?? "hvc1"
                let text = stream == "hvc0" ? (hvc0?.tail() ?? "") : (hvc1?.tail() ?? "")
                var response: [String: Any] = ["event": "console", "stream": stream, "text": text]
                if let requestID { response["requestId"] = requestID }
                emit(response)
            case "exec":
                handleExecLocked(command)
            case "stop":
                requestStopLocked(reason: command["reason"] as? String ?? "command")
            default:
                var response: [String: Any] = ["event": "error", "stage": "command", "message": "unknown command"]
                if let requestID { response["requestId"] = requestID }
                emit(response)
            }
        }
    }

    func requestStop(reason: String) {
        queue.async { [self] in requestStopLocked(reason: reason) }
    }

    private func requestStopLocked(reason: String) {
        guard !finished else { return }
        stopping = true
        guard let vm else {
            finishLocked(reason: "not-started", exitCode: 0)
            return
        }
        if vm.state == .starting {
            emit(["event": "stopping", "mode": "deferred", "reason": reason])
            // A wedged Virtualization.framework start must not wait forever for
            // its completion callback. Reuse the bounded forced-stop path so
            // the runner stays fail-closed while it waits for a stoppable state.
            armForcedStopLocked()
            return
        }
        if vm.state == .stopped || vm.state == .error {
            finishLocked(reason: stateName(vm.state), exitCode: vm.state == .error ? 1 : 0)
            return
        }
        do {
            if vm.canRequestStop {
                try vm.requestStop()
                emit(["event": "stopping", "mode": "graceful", "reason": reason])
                armForcedStopLocked()
                return
            }
        } catch {
            emit(["event": "error", "stage": "request-stop", "message": errorMessage(error)])
        }
        forceStopLocked(
            reason: reason,
            attemptsRemaining: 120,
            generation: nextStopGenerationLocked()
        )
    }

    private func nextStopGenerationLocked() -> UInt64 {
        stopGeneration &+= 1
        return stopGeneration
    }

    private func armForcedStopLocked() {
        stopTimer?.cancel()
        let generation = nextStopGenerationLocked()
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + .seconds(15))
        timer.setEventHandler {
            [weak self] in self?.forceStopLocked(
                reason: "graceful-timeout",
                attemptsRemaining: 120,
                generation: generation
            )
        }
        timer.resume()
        stopTimer = timer
    }

    private func forceStopLocked(reason: String, attemptsRemaining: Int, generation: UInt64) {
        guard !finished, let vm else { return }
        // Ignore retries from an older stop attempt. A later request may have
        // granted the guest a fresh graceful-stop window.
        guard generation == stopGeneration else { return }
        stopTimer?.cancel()
        stopTimer = nil
        if vm.state == .stopped || vm.state == .error {
            finishLocked(reason: reason, exitCode: vm.state == .error ? 1 : 0)
            return
        }
        guard vm.canStop else {
            guard attemptsRemaining > 0 else {
                emit([
                    "event": "error",
                    "stage": "stop-unresolved",
                    "message": "VM never entered a force-stoppable state; runner remains alive",
                ])
                return
            }
            queue.asyncAfter(deadline: .now() + .milliseconds(250)) { [weak self] in
                self?.forceStopLocked(
                    reason: reason,
                    attemptsRemaining: attemptsRemaining - 1,
                    generation: generation
                )
            }
            return
        }
        emit(["event": "stopping", "mode": "forced", "reason": reason])
        vm.stop { [weak self] error in
            guard let self else { return }
            if let error {
                emit(["event": "error", "stage": "force-stop", "message": errorMessage(error)])
                guard attemptsRemaining > 0 else {
                    emit([
                        "event": "error",
                        "stage": "stop-unresolved",
                        "message": "forced stop retries exhausted; runner remains alive",
                    ])
                    return
                }
                self.queue.asyncAfter(deadline: .now() + .milliseconds(250)) { [weak self] in
                    self?.forceStopLocked(
                        reason: reason,
                        attemptsRemaining: attemptsRemaining - 1,
                        generation: generation
                    )
                }
            } else {
                self.finishLocked(reason: "forced", exitCode: 0)
            }
        }
    }

    private func emitExecFailureLocked(
        requestID: String?,
        processID: String? = nil,
        message: String
    ) {
        let sanitizedMessage = boundedUTF8Prefix(
            sanitizedGuestOutput(message),
            maximumBytes: 4096
        ).text
        guard let requestID, !requestID.isEmpty else {
            emit(["event": "error", "stage": "command", "message": sanitizedMessage])
            return
        }
        guard let processID else {
            emit([
                "event": "error",
                "stage": "command",
                "requestId": requestID,
                "message": sanitizedMessage,
            ])
            return
        }
        let result: [String: Any] = [
            "event": "exec_result",
            "requestId": requestID,
            "processId": processID,
            "stdout": "",
            "stderr": "",
            "exitCode": NSNull(),
            "signal": NSNull(),
            "truncated": false,
            "error": sanitizedMessage,
        ]
        emit(result)
    }

    private func handleExecLocked(_ command: [String: Any]) {
        guard let requestID = command["requestId"] as? String,
              !requestID.isEmpty,
              requestID.utf8.count <= 256,
              !requestID.contains("\0") else {
            emitExecFailureLocked(requestID: nil, message: "exec requires a bounded string requestId")
            return
        }
        let topLevelKeys = Set(command.keys)
        guard topLevelKeys.isSubset(of: ["command", "requestId", "process"]) else {
            emitExecFailureLocked(requestID: requestID, message: "exec contains an unknown top-level field")
            return
        }
        guard pendingExecByHostRequestID[requestID] == nil else {
            emitExecFailureLocked(requestID: requestID, message: "duplicate exec requestId")
            return
        }
        guard pendingExecByHostRequestID.count < pendingExecCapacity else {
            emitExecFailureLocked(requestID: requestID, message: "too many pending guest executions")
            return
        }
        guard let process = command["process"] as? [String: Any] else {
            emitExecFailureLocked(requestID: requestID, message: "exec requires a process object")
            return
        }
        let processKeys = Set(process.keys)
        guard processKeys.isSubset(of: ["id", "name", "command", "args", "cwd", "env"]) else {
            emitExecFailureLocked(requestID: requestID, message: "process contains an unknown field")
            return
        }
        guard let processID = process["id"] as? String,
              processID.range(
                  of: "^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[1-8][0-9A-Fa-f]{3}-[89AaBb][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}$",
                  options: .regularExpression
              ) != nil else {
            emitExecFailureLocked(requestID: requestID, message: "process.id must be a UUID")
            return
        }
        guard pendingExecByProcessID[processID] == nil else {
            emitExecFailureLocked(
                requestID: requestID,
                processID: processID,
                message: "duplicate process.id"
            )
            return
        }
        guard let name = process["name"] as? String,
              name.range(
                  of: "^[a-z][a-z0-9_-]{0,31}$",
                  options: .regularExpression
              ) != nil else {
            emitExecFailureLocked(
                requestID: requestID,
                processID: processID,
                message: "process.name must be a bounded string"
            )
            return
        }
        guard let executable = process["command"] as? String,
              executable.range(
                  of: "^/(?:bin|usr/(?:local/)?bin)/[A-Za-z0-9._+-]+$",
                  options: .regularExpression
              ) != nil else {
            emitExecFailureLocked(
                requestID: requestID,
                processID: processID,
                message: "process.command must be a bounded absolute path"
            )
            return
        }
        guard let arguments = process["args"] as? [String], arguments.count <= 8 else {
            emitExecFailureLocked(
                requestID: requestID,
                processID: processID,
                message: "process.args must be a bounded string array"
            )
            return
        }
        var argumentBytes = 0
        for argument in arguments {
            argumentBytes += argument.utf8.count + 1
            guard argument.count <= 256,
                  argumentBytes <= 1024,
                  !argument.contains("\0") else {
                emitExecFailureLocked(
                    requestID: requestID,
                    processID: processID,
                    message: "process.args exceeds the runner limit"
                )
                return
            }
        }

        guard process["cwd"] as? String == "/" else {
            emitExecFailureLocked(
                requestID: requestID,
                processID: processID,
                message: "process.cwd must be /"
            )
            return
        }
        let requiredEnvironment = [
            "HOME": "/nonexistent",
            "LANG": "C.UTF-8",
            "LC_ALL": "C.UTF-8",
        ]
        guard let rawEnvironment = process["env"] as? [String: Any],
              rawEnvironment.count == requiredEnvironment.count,
              requiredEnvironment.allSatisfy({ rawEnvironment[$0.key] as? String == $0.value }) else {
            emitExecFailureLocked(
                requestID: requestID,
                processID: processID,
                message: "process.env must contain only the fixed runner environment"
            )
            return
        }

        guard connection != nil, guestReady else {
            emitExecFailureLocked(
                requestID: requestID,
                processID: processID,
                message: "guest RPC is not ready"
            )
            return
        }

        nextGuestRequestID &+= 1
        let guestRequestID = "req-\(nextGuestRequestID)"
        var params: [String: Any] = [
            "id": processID,
            "name": name,
            "command": executable,
            "args": arguments,
            "isResume": false,
            "oneShot": true,
            "mountSkeletonHome": false,
        ]
        params["cwd"] = "/"
        params["env"] = requiredEnvironment
        let request: [String: Any] = [
            "type": "request",
            "id": guestRequestID,
            "method": "spawn",
            "params": params,
        ]

        let frame: Data
        do {
            frame = try makeGuestFrameLocked(request)
        } catch {
            emitExecFailureLocked(
                requestID: requestID,
                processID: processID,
                message: errorMessage(error)
            )
            return
        }

        // Register both correlations before any write. The guest can respond
        // as soon as the final frame byte reaches it.
        let pending = PendingGuestExec(
            requestID: requestID,
            guestRequestID: guestRequestID,
            processID: processID
        )
        pendingExecByGuestRequestID[guestRequestID] = pending
        pendingExecByHostRequestID[requestID] = pending
        pendingExecByProcessID[processID] = pending
        _ = enqueueGuestFrameLocked(frame)
    }

    private func makeGuestFrameLocked(_ object: [String: Any]) throws -> Data {
        guard JSONSerialization.isValidJSONObject(object) else {
            throw RunnerFailure("guest RPC object is not valid JSON")
        }
        let payload = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        guard !payload.isEmpty, payload.count <= guestFrameCapacity else {
            throw RunnerFailure("guest RPC frame exceeds the \(guestFrameCapacity)-byte limit")
        }
        var length = UInt32(payload.count).bigEndian
        var frame = Data()
        frame.reserveCapacity(MemoryLayout<UInt32>.size + payload.count)
        Swift.withUnsafeBytes(of: &length) { bytes in
            frame.append(contentsOf: bytes)
        }
        frame.append(payload)
        return frame
    }

    private func enqueueGuestMessageLocked(_ object: [String: Any]) -> Bool {
        do {
            return enqueueGuestFrameLocked(try makeGuestFrameLocked(object))
        } catch {
            guestTransportFailureLocked(stage: "guest-write", message: errorMessage(error))
            return false
        }
    }

    private func enqueueGuestHandshakeLocked() -> Bool {
        guard connection != nil,
              !handshakeConfigQueued,
              !staticIPAssignmentSent,
              !hostProxyConfigSent else {
            guestTransportFailureLocked(
                stage: "guest-handshake",
                message: "guest RPC handshake was queued more than once"
            )
            return false
        }

        do {
            // `coworkd` waits for an IPv4 route before it sends `ready`. The
            // native host establishes that route before delivering proxy
            // configuration, so preserve the same frame order exactly.
            let staticIPFrame = try makeGuestFrameLocked([
                "type": "notification",
                "method": "staticIPAssignment",
                "params": [
                    "ip": "172.16.10.3",
                    "prefixLength": 24,
                    "gateway": "172.16.10.1",
                    "dns": "172.16.10.1",
                ],
            ])
            let hostProxyFrame = try makeGuestFrameLocked([
                "type": "notification",
                "method": "hostProxyConfig",
                "params": [
                    "httpProxy": "",
                    "httpsProxy": "",
                    "noProxy": "",
                    "apiProbeURL": NSNull(),
                ],
            ])
            let byteCount = staticIPFrame.count + hostProxyFrame.count
            guard byteCount <= guestWriteQueueCapacity - guestWriteBuffer.count else {
                throw RunnerFailure(
                    "guest RPC handshake exceeds the \(guestWriteQueueCapacity)-byte write queue limit"
                )
            }

            // Append both frames before flushing. This keeps readiness false
            // until the complete ordered pair has left the nonblocking queue.
            handshakeConfigQueued = true
            guestWriteBuffer.append(staticIPFrame)
            guestWriteBuffer.append(hostProxyFrame)
            return flushGuestWritesLocked()
        } catch {
            guestTransportFailureLocked(
                stage: "guest-handshake",
                message: errorMessage(error)
            )
            return false
        }
    }

    private func enqueueGuestFrameLocked(_ frame: Data) -> Bool {
        guard connection != nil else { return false }
        guard frame.count <= guestWriteQueueCapacity - guestWriteBuffer.count else {
            guestTransportFailureLocked(
                stage: "guest-write",
                message: "guest RPC write queue exceeded \(guestWriteQueueCapacity) bytes"
            )
            return false
        }
        guestWriteBuffer.append(frame)
        return flushGuestWritesLocked()
    }

    @discardableResult
    private func flushGuestWritesLocked() -> Bool {
        guard let connection else { return false }
        let descriptor = connection.fileDescriptor
        while !guestWriteBuffer.isEmpty {
            let written = guestWriteBuffer.withUnsafeBytes { bytes -> Int in
                guard let baseAddress = bytes.baseAddress else { return 0 }
                return Darwin.write(descriptor, baseAddress, bytes.count)
            }
            if written > 0 {
                guestWriteBuffer.removeFirst(written)
                continue
            }
            if written == 0 {
                guestTransportFailureLocked(
                    stage: "guest-write",
                    message: "guest RPC socket returned a zero-length write"
                )
                return false
            }
            if errno == EINTR { continue }
            if errno == EAGAIN || errno == EWOULDBLOCK {
                armGuestWriteSourceLocked(descriptor: descriptor)
                return true
            }
            let message = NSError(domain: NSPOSIXErrorDomain, code: Int(errno)).localizedDescription
            guestTransportFailureLocked(stage: "guest-write", message: message)
            return false
        }
        guestWriteSource?.cancel()
        guestWriteSource = nil
        if handshakeConfigQueued {
            handshakeConfigQueued = false
            staticIPAssignmentSent = true
            hostProxyConfigSent = true
            updateGuestReadyLocked()
        }
        return true
    }

    private func armGuestWriteSourceLocked(descriptor: Int32) {
        guard guestWriteSource == nil else { return }
        let source = DispatchSource.makeWriteSource(fileDescriptor: descriptor, queue: queue)
        source.setEventHandler { [weak self] in
            guard let self,
                  self.connection?.fileDescriptor == descriptor else { return }
            self.flushGuestWritesLocked()
        }
        source.resume()
        guestWriteSource = source
    }

    private func drainGuestReadsLocked(descriptor: Int32) {
        guard connection?.fileDescriptor == descriptor else { return }
        var chunk = [UInt8](repeating: 0, count: guestReadChunkCapacity)
        while connection?.fileDescriptor == descriptor {
            let count = chunk.withUnsafeMutableBytes { bytes in
                Darwin.read(descriptor, bytes.baseAddress, bytes.count)
            }
            if count > 0 {
                guestReadBuffer.append(contentsOf: chunk.prefix(count))
                guard decodeGuestFramesLocked() else { return }
                continue
            }
            if count == 0 {
                closeGuestConnectionLocked(reason: "guest-eof", emitDisconnect: true)
                return
            }
            if errno == EINTR { continue }
            if errno == EAGAIN || errno == EWOULDBLOCK { return }
            let message = NSError(domain: NSPOSIXErrorDomain, code: Int(errno)).localizedDescription
            guestTransportFailureLocked(stage: "guest-read", message: message)
            return
        }
    }

    @discardableResult
    private func decodeGuestFramesLocked() -> Bool {
        while guestReadBuffer.count >= MemoryLayout<UInt32>.size {
            let start = guestReadBuffer.startIndex
            let length = Int(UInt32(guestReadBuffer[start]) << 24)
                | Int(UInt32(guestReadBuffer[start + 1]) << 16)
                | Int(UInt32(guestReadBuffer[start + 2]) << 8)
                | Int(UInt32(guestReadBuffer[start + 3]))
            guard length > 0, length <= guestFrameCapacity else {
                guestProtocolViolationLocked("guest declared an invalid RPC frame length: \(length)")
                return false
            }
            let frameLength = MemoryLayout<UInt32>.size + length
            guard guestReadBuffer.count >= frameLength else {
                // A single partial body is the only state retained between
                // reads; never skip or allocate a declared oversized body.
                guard guestReadBuffer.count <= guestFrameCapacity + MemoryLayout<UInt32>.size else {
                    guestProtocolViolationLocked("guest RPC read buffer exceeded its limit")
                    return false
                }
                return true
            }

            let payloadStart = start + MemoryLayout<UInt32>.size
            let payload = guestReadBuffer.subdata(in: payloadStart..<(payloadStart + length))
            guestReadBuffer.removeFirst(frameLength)
            guard String(data: payload, encoding: .utf8) != nil else {
                guestProtocolViolationLocked("guest RPC frame is not UTF-8")
                return false
            }
            do {
                guard let message = try JSONSerialization.jsonObject(with: payload) as? [String: Any] else {
                    guestProtocolViolationLocked("guest RPC frame is not a JSON object")
                    return false
                }
                guard handleGuestMessageLocked(message) else { return false }
            } catch {
                guestProtocolViolationLocked("guest RPC frame is invalid JSON")
                return false
            }
        }
        guard guestReadBuffer.count <= guestFrameCapacity + MemoryLayout<UInt32>.size else {
            guestProtocolViolationLocked("guest RPC read buffer exceeded its limit")
            return false
        }
        return true
    }

    @discardableResult
    private func handleGuestMessageLocked(_ message: [String: Any]) -> Bool {
        guestMessageCount += 1
        guard guestMessageCount <= guestMessageCapacity else {
            guestProtocolViolationLocked("guest RPC message count exceeded its limit")
            return false
        }
        guard let type = message["type"] as? String else {
            guestProtocolViolationLocked("guest RPC message is missing type")
            return false
        }
        switch type {
        case "event":
            return handleGuestEventLocked(message)
        case "response":
            return handleGuestResponseLocked(message)
        case "request":
            return rejectGuestRequestLocked(message)
        default:
            guestProtocolViolationLocked("unsupported guest RPC message type: \(type)")
            return false
        }
    }

    private func guestValueFitsOutputLimit(_ value: Any) -> Bool {
        let wrapper = ["value": value]
        guard JSONSerialization.isValidJSONObject(wrapper),
              let data = try? JSONSerialization.data(withJSONObject: wrapper) else {
            return false
        }
        return data.count <= guestResponseCapacity
    }

    @discardableResult
    private func handleGuestResponseLocked(_ message: [String: Any]) -> Bool {
        guard Set(message.keys).isSubset(of: ["type", "id", "result", "error"]),
              let guestRequestID = message["id"] as? String,
              let pending = pendingExecByGuestRequestID[guestRequestID] else {
            guestProtocolViolationLocked("guest response has no matching spawn request")
            return false
        }
        guard !pending.spawnAcknowledged else {
            guestProtocolViolationLocked("guest sent a duplicate spawn response")
            return false
        }
        let resultValue = message["result"]
        let errorValue = message["error"]
        let hasResult = resultValue != nil && !(resultValue is NSNull)
        let hasError = errorValue != nil && !(errorValue is NSNull)
        guard hasResult != hasError else {
            if pending.isBootstrap,
               let data = try? JSONSerialization.data(withJSONObject: message, options: [.sortedKeys]),
               let text = String(data: data, encoding: .utf8) {
                let diagnostic = boundedUTF8Prefix(sanitizedGuestOutput(text), maximumBytes: 2048).text
                emit(["event": "guest_bootstrap_spawn_response_invalid", "response": diagnostic])
                guestProtocolViolationLocked("guest bootstrap spawn response must contain exactly one result or error; response=\(diagnostic)")
            } else {
                guestProtocolViolationLocked("guest spawn response must contain exactly one result or error")
            }
            return false
        }
        if let value = hasResult ? resultValue : errorValue,
           !guestValueFitsOutputLimit(value) {
            guestProtocolViolationLocked("guest spawn response exceeds its output limit")
            return false
        }

        var response: [String: Any] = [
            "event": "spawn_response",
            "requestId": pending.requestID,
            "processId": pending.processID,
            "guestRequestId": guestRequestID,
        ]
        if let resultValue, hasResult { response["result"] = resultValue }
        let responseErrorMessage = hasError
            ? (guestErrorMessage(errorValue) ?? "guest rejected the spawn request")
            : nil
        if let responseErrorMessage {
            var sanitizedError: [String: Any] = ["message": responseErrorMessage]
            if let errorDictionary = errorValue as? [String: Any],
               let code = jsonInteger(errorDictionary["code"]) {
                sanitizedError["code"] = code
            }
            response["error"] = sanitizedError
        }
        pending.spawnAcknowledged = true
        emit(response)

        if hasError {
            finishPendingExecLocked(
                pending,
                exitCode: nil,
                signal: nil,
                error: responseErrorMessage,
                oomKillCount: nil
            )
        } else if pending.exitReceived {
            finishPendingExecLocked(
                pending,
                exitCode: pending.deferredExitCode,
                signal: pending.deferredSignal,
                error: nil,
                oomKillCount: pending.deferredOomKillCount
            )
        }
        return true
    }

    @discardableResult
    private func handleGuestEventLocked(_ message: [String: Any]) -> Bool {
        guard Set(message.keys).isSubset(of: ["type", "event", "params"]),
              let event = message["event"] as? String else {
            guestProtocolViolationLocked("guest event is missing event name")
            return false
        }
        if event == "ready" {
            if let params = message["params"],
               (!(params is NSNull) && (params as? [String: Any])?.isEmpty != true) {
                guestProtocolViolationLocked("guest ready event contains unexpected params")
                return false
            }
            guard !guestSentReady else {
                guestProtocolViolationLocked("guest sent duplicate ready event")
                return false
            }
            guestSentReady = true
            updateGuestReadyLocked()
            return true
        }

        guard let fields = message["params"] as? [String: Any] else {
            guestProtocolViolationLocked("guest \(event) event is missing params")
            return false
        }
        switch event {
        case "stdout", "stderr":
            guard Set(fields.keys).isSubset(of: ["id", "data"]),
                  let processID = fields["id"] as? String,
                  let data = fields["data"] as? String,
                  let pending = pendingExecByProcessID[processID],
                  !pending.exitReceived else {
                guestProtocolViolationLocked("guest \(event) event is not correlated to an active process")
                return false
            }
            let output = pending.appendOutput(data, isStderr: event == "stderr")
            if !output.forwarded.isEmpty || output.becameTruncated {
                emit([
                    "event": event,
                    "requestId": pending.requestID,
                    "processId": processID,
                    "data": output.forwarded,
                    "truncated": pending.truncated,
                ])
            }
            if output.becameTruncated {
                guestTransportFailureLocked(
                    stage: "guest-output",
                    message: "guest process output exceeded \(execOutputCapacity) bytes"
                )
                return false
            }
            return true
        case "exit":
            guard Set(fields.keys).isSubset(of: ["id", "code", "signal", "oomKillCount"]),
                  let processID = fields["id"] as? String,
                  let pending = pendingExecByProcessID[processID] else {
                guestProtocolViolationLocked("guest exit event is not correlated to an active process")
                return false
            }
            guard !pending.exitReceived else {
                guestProtocolViolationLocked("guest sent a duplicate exit event")
                return false
            }
            let exitValue = fields["code"]
            let exitCode: Int?
            if exitValue == nil || exitValue is NSNull {
                exitCode = nil
            } else if let parsed = jsonInteger(exitValue) {
                exitCode = parsed
            } else {
                guestProtocolViolationLocked("guest exit event contains an invalid exit code")
                return false
            }
            let signal: String?
            if fields["signal"] == nil || fields["signal"] is NSNull {
                signal = nil
            } else if let parsed = fields["signal"] as? String,
                      parsed.range(
                          of: "^SIG[A-Z0-9]+$",
                          options: .regularExpression
                      ) != nil {
                signal = parsed
            } else {
                guestProtocolViolationLocked("guest exit event contains an invalid signal")
                return false
            }
            let oomKillCount: Int?
            if fields["oomKillCount"] == nil || fields["oomKillCount"] is NSNull {
                oomKillCount = nil
            } else if let parsed = jsonInteger(fields["oomKillCount"]), parsed >= 0 {
                oomKillCount = parsed
            } else {
                guestProtocolViolationLocked("guest exit event contains an invalid oomKillCount")
                return false
            }
            pending.exitReceived = true
            pending.deferredExitCode = exitCode
            pending.deferredSignal = signal
            pending.deferredOomKillCount = oomKillCount
            var forwardedExit: [String: Any] = [
                "event": "exit",
                "requestId": pending.requestID,
                "processId": pending.processID,
                "exitCode": exitCode.map { $0 as Any } ?? NSNull(),
                "signal": signal.map { $0 as Any } ?? NSNull(),
            ]
            if let oomKillCount { forwardedExit["oomKillCount"] = oomKillCount }
            emit(forwardedExit)
            if pending.spawnAcknowledged {
                finishPendingExecLocked(
                    pending,
                    exitCode: exitCode,
                    signal: signal,
                    error: nil,
                    oomKillCount: oomKillCount
                )
            }
            return true
        case "error":
            guard Set(fields.keys).isSubset(of: ["id", "message", "fatal"]),
                  let message = guestErrorMessage(fields),
                  fields["fatal"] == nil || fields["fatal"] is Bool else {
                guestProtocolViolationLocked("guest error event is malformed")
                return false
            }
            if let processID = fields["id"] {
                guard let processID = processID as? String,
                      processID.range(
                          of: "^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[1-8][0-9A-Fa-f]{3}-[89AaBb][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}$",
                          options: .regularExpression
                      ) != nil,
                      let pending = pendingExecByProcessID[processID],
                      !pending.exitReceived else {
                    guestProtocolViolationLocked("guest error event has no matching process")
                    return false
                }
                finishPendingExecLocked(
                    pending,
                    exitCode: nil,
                    signal: nil,
                    error: message,
                    oomKillCount: nil
                )
                return true
            }
            var forwarded: [String: Any] = [
                "event": "guest_error",
                "message": message,
            ]
            if let fatal = fields["fatal"] as? Bool { forwarded["fatal"] = fatal }
            emit(forwarded)
            // The current guest error event carries no process identifier. Do
            // not guess: fail the transport and correlate the failure to every
            // active request during teardown.
            guestTransportFailureLocked(stage: "guest-error", message: message)
            return false
        case "networkStatus", "apiReachability":
            guard Set(fields.keys).isSubset(of: ["status"]),
                  let status = fields["status"] as? String,
                  guestValueFitsOutputLimit(status) else {
                guestProtocolViolationLocked("guest \(event) event contains an invalid status")
                return false
            }
            emit([
                "event": "guest_\(event)",
                "status": boundedUTF8Prefix(sanitizedGuestOutput(status), maximumBytes: 4096).text,
            ])
            return true
        default:
            guestProtocolViolationLocked("unsupported guest event: \(event)")
            return false
        }
    }

    private func guestErrorMessage(_ value: Any?) -> String? {
        let raw: String?
        if let dictionary = value as? [String: Any] {
            if let message = dictionary["message"] as? String {
                raw = message
            } else if let nested = dictionary["error"] as? [String: Any],
                      let message = nested["message"] as? String {
                raw = message
            } else {
                raw = nil
            }
        } else {
            raw = value as? String
        }
        guard let raw else { return nil }
        return boundedUTF8Prefix(sanitizedGuestOutput(raw), maximumBytes: 4096).text
    }

    @discardableResult
    private func rejectGuestRequestLocked(_ message: [String: Any]) -> Bool {
        guard Set(message.keys).isSubset(of: ["type", "id", "method", "params"]),
              let id = message["id"], JSONSerialization.isValidJSONObject(["id": id]),
              let method = message["method"] as? String,
              method.utf8.count <= 256 else {
            guestProtocolViolationLocked("guest request is missing a valid id or method")
            return false
        }
        let response: [String: Any] = [
            "type": "response",
            "id": id,
            "error": [
                "code": -32601,
                "message": "Method not found",
            ],
        ]
        guard enqueueGuestMessageLocked(response) else { return false }
        emit([
            "event": "guest_request_rejected",
            "method": boundedUTF8Prefix(sanitizedGuestOutput(method), maximumBytes: 256).text,
            "code": -32601,
        ])
        return true
    }

    private func finishPendingExecLocked(
        _ pending: PendingGuestExec,
        exitCode: Int?,
        signal: String?,
        error: String?,
        oomKillCount: Int?
    ) {
        guard pendingExecByGuestRequestID[pending.guestRequestID] === pending,
              pendingExecByHostRequestID[pending.requestID] === pending,
              pendingExecByProcessID[pending.processID] === pending else {
            return
        }
        pendingExecByGuestRequestID.removeValue(forKey: pending.guestRequestID)
        pendingExecByHostRequestID.removeValue(forKey: pending.requestID)
        pendingExecByProcessID.removeValue(forKey: pending.processID)

        let sanitizedError = error.map {
            boundedUTF8Prefix(sanitizedGuestOutput($0), maximumBytes: 4096).text
        }
        if pending.isBootstrap {
            guestBootstrapTimer?.cancel()
            guestBootstrapTimer = nil
            guard connection != nil, !stopping else { return }
            let successful = validatesGuestBootstrapReceipt(pending.stdout, exitCode: exitCode,
                signal: signal, error: sanitizedError, truncated: pending.truncated,
                networkMode: options.networkMode, distributionMode: options.distributionMode)
            guestBootstrapReady = successful
            if successful, let data = pending.stdout.data(using: .utf8),
               let receipt = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                meshReady = receipt["meshReady"] as? Bool == true
                networkFallbackReason = receipt["fallbackReason"] as? String
            }
            emit([
                "event": "guest_bootstrap",
                "preparedRuntimeReady": successful,
                "networkMode": options.networkMode,
                "distributionMode": options.distributionMode,
                "meshReady": meshReady,
                "networkFallbackReason": networkFallbackReason.map { $0 as Any } ?? NSNull(),
                "exitCode": exitCode.map { $0 as Any } ?? NSNull(),
                "signal": signal.map { $0 as Any } ?? NSNull(),
                "stdout": pending.stdout,
                "stderr": pending.stderr,
            ])
            if successful {
                updateGuestReadyLocked()
            } else {
                guestBootstrapError = sanitizedError ?? "Prepared guest bootstrap failed or returned an invalid receipt (exit=\(exitCode.map(String.init) ?? "none")): \(pending.stderr)"
                guestTransportFailureLocked(stage: "guest-bootstrap", message: guestBootstrapError!)
            }
            return
        }
        if let sanitizedError {
            emit([
                "event": "error",
                "stage": "guest-exec",
                "requestId": pending.requestID,
                "processId": pending.processID,
                "message": sanitizedError,
            ])
        }
        var result: [String: Any] = [
            "event": "exec_result",
            "requestId": pending.requestID,
            "processId": pending.processID,
            "stdout": pending.stdout,
            "stderr": pending.stderr,
            "exitCode": exitCode.map { $0 as Any } ?? NSNull(),
            "signal": signal.map { $0 as Any } ?? NSNull(),
            "truncated": pending.truncated,
        ]
        if let sanitizedError { result["error"] = sanitizedError }
        if let oomKillCount { result["oomKillCount"] = oomKillCount }
        emit(result)
    }

    private var coworkReady: Bool {
        connection != nil
            && staticIPAssignmentSent
            && hostProxyConfigSent
            && guestSentReady
    }

    private func beginGuestBootstrapLocked() {
        guard coworkReady, !guestBootstrapStarted, !stopping else { return }
        guestBootstrapStarted = true
        let processID = UUID().uuidString.lowercased()
        let bootstrapName = "ovm-bootstrap-" + processID.replacingOccurrences(of: "-", with: "").prefix(12)
        let hostRequestID = "ovm-bootstrap-\(UUID().uuidString.lowercased())"
        nextGuestRequestID &+= 1
        let guestRequestID = "req-\(nextGuestRequestID)"
        do {
            var expected: [String: String] = [:]
            if options.networkMode == "nat" {
                guard let share = options.networkShareURL,
                      let identity = try JSONSerialization.jsonObject(with: Data(contentsOf: share.appendingPathComponent("identity.json"))) as? [String: Any],
                      let networkID = identity["networkId"] as? String,
                      let controllerID = identity["controllerId"] as? String,
                      let guestID = identity["guestId"] as? String else {
                    throw RunnerFailure("Guest bootstrap has no complete mounted network identity")
                }
                expected = ["identityKey": guestBootstrapIdentityKey(networkID: networkID, controllerID: controllerID, guestID: guestID)]
            }
            let expectedJSON = String(data: try JSONSerialization.data(withJSONObject: expected), encoding: .utf8)!
            let request: [String: Any] = [
                "type": "request", "id": guestRequestID, "method": "spawn",
                "params": [
                    "id": processID, "name": bootstrapName,
                    "command": "/usr/bin/python3", "args": ["-c", guestBootstrapWaiter, options.networkMode, expectedJSON, options.distributionMode],
                    "cwd": "/", "env": ["HOME": "/nonexistent", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"],
                    "isResume": false, "oneShot": true, "mountSkeletonHome": false,
                ],
            ]
            let frame = try makeGuestFrameLocked(request)
            let pending = PendingGuestExec(requestID: hostRequestID, guestRequestID: guestRequestID,
                processID: processID, isBootstrap: true)
            pendingExecByGuestRequestID[guestRequestID] = pending
            pendingExecByHostRequestID[hostRequestID] = pending
            pendingExecByProcessID[processID] = pending
            let timer = DispatchSource.makeTimerSource(queue: queue)
            timer.schedule(deadline: .now() + 95)
            timer.setEventHandler { [weak self, weak pending] in
                guard let self, let pending else { return }
                self.finishPendingExecLocked(pending, exitCode: nil, signal: nil,
                    error: "Prepared guest bootstrap exceeded 95 seconds", oomKillCount: nil)
            }
            guestBootstrapTimer = timer
            timer.resume()
            _ = enqueueGuestFrameLocked(frame)
        } catch {
            guestBootstrapError = "Cannot start prepared guest bootstrap: \(errorMessage(error))"
            guestTransportFailureLocked(stage: "guest-bootstrap", message: guestBootstrapError!)
        }
    }

    private func updateGuestReadyLocked() {
        if coworkReady && !guestBootstrapStarted { beginGuestBootstrapLocked() }
        let ready = coworkReady && guestBootstrapReady
        guard ready != guestReady else { return }
        guestReady = ready
        guard ready, let connection else { return }
        emit([
            "event": "guest_ready",
            "distributionMode": options.distributionMode,
            "meshReady": meshReady,
            "networkFallbackReason": networkFallbackReason.map { $0 as Any } ?? NSNull(),
            "sourcePort": Int(connection.sourcePort),
            "destinationPort": Int(connection.destinationPort),
        ])
    }

    private func guestProtocolViolationLocked(_ message: String) {
        let sanitized = boundedUTF8Prefix(
            sanitizedGuestOutput(message),
            maximumBytes: 4096
        ).text
        emit(["event": "error", "stage": "guest-protocol", "message": sanitized])
        closeGuestConnectionLocked(
            reason: "protocol-violation",
            emitDisconnect: true,
            pendingError: sanitized
        )
    }

    private func guestTransportFailureLocked(stage: String, message: String) {
        let sanitized = boundedUTF8Prefix(
            sanitizedGuestOutput(message),
            maximumBytes: 4096
        ).text
        emit(["event": "error", "stage": stage, "message": sanitized])
        closeGuestConnectionLocked(
            reason: stage,
            emitDisconnect: true,
            pendingError: sanitized
        )
    }

    private func closeGuestConnectionLocked(
        reason: String,
        emitDisconnect: Bool,
        pendingError: String? = nil
    ) {
        let activeConnection = connection
        let sourcePort = activeConnection.map { Int($0.sourcePort) }
        connection = nil
        guestReady = false
        guestBootstrapReady = false
        meshReady = false
        networkFallbackReason = nil
        guestBootstrapTimer?.cancel()
        guestBootstrapTimer = nil
        guestSentReady = false
        handshakeConfigQueued = false
        staticIPAssignmentSent = false
        hostProxyConfigSent = false
        guestMessageCount = 0
        guestReadBuffer.removeAll(keepingCapacity: false)
        guestWriteBuffer.removeAll(keepingCapacity: false)
        guestReadSource?.cancel()
        guestReadSource = nil
        guestWriteSource?.cancel()
        guestWriteSource = nil
        activeConnection?.close()

        let pending = Array(pendingExecByHostRequestID.values)
        let failure = pendingError ?? "guest RPC disconnected: \(reason)"
        for execution in pending {
            finishPendingExecLocked(
                execution,
                exitCode: nil,
                signal: nil,
                error: failure,
                oomKillCount: nil
            )
        }
        if emitDisconnect, activeConnection != nil {
            var event: [String: Any] = [
                "event": "vsock_disconnected",
                "reason": boundedUTF8Prefix(
                    sanitizedGuestOutput(reason),
                    maximumBytes: 256
                ).text,
            ]
            if let sourcePort { event["sourcePort"] = sourcePort }
            emit(event)
        }
    }

    private func statusLocked() -> [String: Any] {
        let state = vm?.state ?? .stopped
        if let active = connection, !connectionIsAlive(active) {
            closeGuestConnectionLocked(reason: "connection-closed", emitDisconnect: true)
        }
        var status: [String: Any] = [
            "backend": "swift-virtualization",
            // Treat every nonterminal VZ state as active. This also covers
            // paused and framework transition states that this MCP does not
            // currently expose directly.
            "running": state != .stopped && state != .error,
            "state": stateName(state),
            "stateRaw": state.rawValue,
            "vsockConnected": connection != nil,
            "guestReady": guestReady,
            "coworkReady": coworkReady,
            "guestBootstrapStarted": guestBootstrapStarted,
            "guestBootstrapReady": guestBootstrapReady,
            "meshReady": meshReady,
            "distributionMode": options.distributionMode,
            "networkFallbackReason": networkFallbackReason.map { $0 as Any } ?? NSNull(),
            "guestBootstrapError": guestBootstrapError.map { $0 as Any } ?? NSNull(),
            "hostConfigSent": staticIPAssignmentSent && hostProxyConfigSent,
            "staticIPAssignmentSent": staticIPAssignmentSent,
            "hostProxyConfigSent": hostProxyConfigSent,
            "networkMode": options.networkMode,
            "networkIsolated": options.networkMode == "isolated",
            "networkForwarding": options.networkMode == "nat",
            "networkConfigurationShare": options.networkShareURL != nil,
            "coworkNetworkIsolated": true,
        ]
        if let connection { status["sourcePort"] = Int(connection.sourcePort) }
        return status
    }

    private func connectionIsAlive(_ connection: VZVirtioSocketConnection) -> Bool {
        let descriptor = connection.fileDescriptor
        guard descriptor >= 0 else { return false }
        var byte: UInt8 = 0
        let result = Darwin.recv(descriptor, &byte, 1, MSG_PEEK | MSG_DONTWAIT)
        if result > 0 { return true }
        if result == 0 { return false }
        return errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR
    }

    private func failLocked(stage: String, error: Error) {
        emit(["event": "error", "stage": stage, "message": errorMessage(error)])
        if vm?.canStop == true {
            forceStopLocked(
                reason: "error",
                attemptsRemaining: 120,
                generation: nextStopGenerationLocked()
            )
        } else {
            finishLocked(reason: "error", exitCode: 1)
        }
    }

    private func finishLocked(reason: String, exitCode: Int32) {
        guard !finished else { return }
        finished = true
        stopTimer?.cancel()
        stopTimer = nil
        if let socket = vm?.socketDevices.first as? VZVirtioSocketDevice {
            socket.removeSocketListener(forPort: guestVsockPort)
        }
        closeGuestConnectionLocked(reason: "vm-stopping", emitDisconnect: false)
        hvc0?.close()
        hvc1?.close()
        isolatedNetworkSink?.close()
        isolatedNetworkSink = nil
        emit(["event": "stopped", "reason": reason, "exitCode": Int(exitCode)])
        Foundation.exit(exitCode)
    }

    func guestDidStop(_ virtualMachine: VZVirtualMachine) {
        finishLocked(reason: "guest", exitCode: 0)
    }

    func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: Error) {
        emit(["event": "error", "stage": "virtual-machine", "message": errorMessage(error)])
        finishLocked(reason: "virtual-machine-error", exitCode: 1)
    }

    func listener(
        _ listener: VZVirtioSocketListener,
        shouldAcceptNewConnection connection: VZVirtioSocketConnection,
        from socketDevice: VZVirtioSocketDevice
    ) -> Bool {
        guard !acceptedGuestConnection else {
            emit([
                "event": "error",
                "stage": "vsock-reconnect",
                "message": "only one guest connection is accepted per VM boot",
            ])
            return false
        }
        let descriptor = connection.fileDescriptor
        let currentFlags = fcntl(descriptor, F_GETFL)
        guard descriptor >= 0,
              currentFlags >= 0,
              fcntl(descriptor, F_SETFL, currentFlags | O_NONBLOCK) == 0 else {
            emit([
                "event": "error",
                "stage": "vsock-accept",
                "message": "failed to configure the guest socket as nonblocking",
            ])
            return false
        }

        acceptedGuestConnection = true
        self.connection = connection
        guestReady = false
        guestBootstrapStarted = false
        guestBootstrapReady = false
        guestBootstrapError = nil
        meshReady = false
        networkFallbackReason = nil
        guestBootstrapTimer?.cancel()
        guestBootstrapTimer = nil
        guestSentReady = false
        handshakeConfigQueued = false
        staticIPAssignmentSent = false
        hostProxyConfigSent = false
        guestMessageCount = 0
        guestReadBuffer.removeAll(keepingCapacity: false)
        guestWriteBuffer.removeAll(keepingCapacity: false)

        let readSource = DispatchSource.makeReadSource(fileDescriptor: descriptor, queue: queue)
        readSource.setEventHandler { [weak self] in
            self?.drainGuestReadsLocked(descriptor: descriptor)
        }
        guestReadSource = readSource

        emit([
            "event": "vsock_connected",
            "sourcePort": Int(connection.sourcePort),
            "destinationPort": Int(connection.destinationPort),
        ])

        // Queue the ordered handshake after this delegate returns acceptance.
        // This block is enqueued before the read source is resumed, so a
        // buffered guest event cannot overtake either host configuration frame.
        queue.async { [weak self] in
            guard let self,
                  self.connection?.fileDescriptor == descriptor else { return }
            _ = self.enqueueGuestHandshakeLocked()
        }
        readSource.resume()
        return true
    }
}

#if !OVM_BOOTSTRAP_TEST
@main
private enum Main {
    static func main() {
        signal(SIGPIPE, SIG_IGN)
        do {
            let options = try Options.parse(CommandLine.arguments)
            if options.mode == "support" {
                emit(["event": "support", "supported": VZVirtualMachine.isSupported])
                return
            }

            let probeQueue = DispatchQueue(label: "local.lee.claude-vm-mcp.probe")
            if options.mode == "probe" {
                let hvc0 = ConsoleDrain(queue: probeQueue)
                let hvc1 = ConsoleDrain(queue: probeQueue)
                let isolatedNetworkSink = try IsolatedNetworkSink(queue: probeQueue)
                defer {
                    hvc0.close()
                    hvc1.close()
                    isolatedNetworkSink.close()
                }
                let configuration = try makeConfiguration(
                    options: options,
                    hvc0: hvc0,
                    hvc1: hvc1,
                    isolatedNetworkSink: isolatedNetworkSink
                )
                emit([
                    "event": "probe",
                    "supported": VZVirtualMachine.isSupported,
                    "configurationValid": true,
                    "cpuCount": configuration.cpuCount,
                    "memorySize": configuration.memorySize,
                    "networkMode": options.networkMode,
                    "distributionMode": options.distributionMode,
                    "networkForwarding": options.networkMode == "nat",
                    "networkIsolated": options.networkMode == "isolated",
                    "networkConfigurationShare": options.networkShareURL != nil,
                ])
                return
            }

            let controller = VMController(options: options)
            var inputBuffer = Data()
            let inputQueue = DispatchQueue(label: "local.lee.claude-vm-mcp.stdin")
            FileHandle.standardInput.readabilityHandler = { handle in
                let data = handle.availableData
                if data.isEmpty {
                    FileHandle.standardInput.readabilityHandler = nil
                    controller.requestStop(reason: "stdin-eof")
                    return
                }
                inputQueue.async {
                    inputBuffer.append(data)
                    while let newline = inputBuffer.firstIndex(of: 0x0a) {
                        let line = inputBuffer[..<newline]
                        inputBuffer.removeSubrange(...newline)
                        guard !line.isEmpty else { continue }
                        guard line.count <= hostCommandCapacity else {
                            emit([
                                "event": "error",
                                "stage": "stdin",
                                "message": "runner command exceeded the JSONL input limit",
                            ])
                            continue
                        }
                        guard let object = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any] else {
                            emit([
                                "event": "error",
                                "stage": "stdin",
                                "message": "runner command is not valid JSON",
                            ])
                            continue
                        }
                        controller.handle(object)
                    }
                    if inputBuffer.count > hostCommandCapacity {
                        inputBuffer.removeAll(keepingCapacity: false)
                        emit([
                            "event": "error",
                            "stage": "stdin",
                            "message": "unterminated runner command exceeded the JSONL input limit",
                        ])
                        controller.requestStop(reason: "stdin-command-too-large")
                    }
                }
            }

            signal(SIGINT, SIG_IGN)
            signal(SIGTERM, SIG_IGN)
            let signalQueue = DispatchQueue(label: "local.lee.claude-vm-mcp.signals")
            let interruptSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: signalQueue)
            interruptSource.setEventHandler { controller.requestStop(reason: "SIGINT") }
            interruptSource.resume()
            let terminateSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: signalQueue)
            terminateSource.setEventHandler { controller.requestStop(reason: "SIGTERM") }
            terminateSource.resume()

            withExtendedLifetime((controller, interruptSource, terminateSource)) {
                controller.begin()
                dispatchMain()
            }
        } catch {
            emit(["event": "error", "stage": "main", "message": errorMessage(error)])
            Foundation.exit(64)
        }
    }
}
#endif
