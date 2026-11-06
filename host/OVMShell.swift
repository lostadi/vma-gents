import Darwin
import Foundation
import Virtualization

private let browserProxyPort: UInt32 = 18080
// All bridge callbacks run on the VM queue. Bound transaction diagnostics;
// forwarded HTTP bytes, URLs, headers, and cookie values are never logged.
private var browserProxyLogCount = 0
private func browserProxyLog(_ message: String) {
    if browserProxyLogCount < 200 { fputs("[ovm-shell] \(message)\n", stderr) }
    else if browserProxyLogCount == 200 { fputs("[ovm-shell] proxy diagnostics limit reached\n", stderr) }
    browserProxyLogCount += 1
}

private func proxyNonblocking(_ descriptor: Int32) -> Bool {
    let flags = fcntl(descriptor, F_GETFL)
    guard flags >= 0, fcntl(descriptor, F_SETFL, flags | O_NONBLOCK) == 0 else { return false }
    _ = fcntl(descriptor, F_SETFD, FD_CLOEXEC)
    var enabled: Int32 = 1
    _ = setsockopt(descriptor, SOL_SOCKET, SO_NOSIGPIPE, &enabled, socklen_t(MemoryLayout<Int32>.size))
    return true
}

private func connectProxySocket(_ path: String) throws -> (Int32, Bool) {
    var address = sockaddr_un()
    let bytes = Array(path.utf8)
    guard path.hasPrefix("/"), bytes.count < MemoryLayout.size(ofValue: address.sun_path) else {
        throw NSError(domain: "OVMProxy", code: 64, userInfo: [NSLocalizedDescriptionKey: "Proxy socket must be an absolute Unix path shorter than 104 UTF-8 bytes"])
    }
    address.sun_family = sa_family_t(AF_UNIX)
    address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    withUnsafeMutableBytes(of: &address.sun_path) { destination in
        destination.copyBytes(from: bytes)
        destination[bytes.count] = 0
    }
    let descriptor = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
    guard descriptor >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
    guard proxyNonblocking(descriptor) else {
        let error = errno
        Darwin.close(descriptor)
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(error))
    }
    let length = socklen_t(address.sun_len)
    let result = withUnsafePointer(to: &address) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(descriptor, $0, length) }
    }
    if result == 0 { return (descriptor, false) }
    if errno == EINPROGRESS || errno == EAGAIN { return (descriptor, true) }
    let error = errno
    Darwin.close(descriptor)
    throw NSError(domain: NSPOSIXErrorDomain, code: Int(error))
}

/// Two bounded nonblocking streams. Buffer pressure pauses the corresponding
/// input; EOF half-closes only after its queued bytes reach the other endpoint.
private final class BrowserProxyRelay {
    private let descriptors: [Int32]
    private let queue: DispatchQueue
    private let closeGuest: () -> Void
    private let onClose: () -> Void
    private let capacity = 256 * 1024
    private var pending = [Data(), Data()]
    private var reads: [DispatchSourceRead?] = [nil, nil]
    private var writes: [DispatchSourceWrite?] = [nil, nil]
    private var readPaused = [false, false]
    private var eof = [false, false]
    private var halfClosed = [false, false]
    private var connecting: Bool
    private var closed = false
    private var received: [Int] = [0, 0]
    private var forwarded: [Int] = [0, 0]

    init(guest: Int32, proxy: Int32, connecting: Bool, queue: DispatchQueue,
         closeGuest: @escaping () -> Void, onClose: @escaping () -> Void) {
        self.descriptors = [guest, proxy]
        self.connecting = connecting
        self.queue = queue
        self.closeGuest = closeGuest
        self.onClose = onClose
    }

    func start() {
        guard !closed else { return }
        browserProxyLog("proxy relay started guestFD=\(descriptors[0]) unixFD=\(descriptors[1]) connecting=\(connecting)")
        installRead(0)
        if connecting { armWrite(0) } else { installRead(1) }
    }

    private func installRead(_ side: Int) {
        guard !closed, reads[side] == nil, !eof[side] else { return }
        let source = DispatchSource.makeReadSource(fileDescriptor: descriptors[side], queue: queue)
        source.setEventHandler { [weak self] in self?.drain(side) }
        reads[side] = source
        source.resume()
    }

    private func drain(_ side: Int) {
        guard !closed else { return }
        var chunk = [UInt8](repeating: 0, count: 64 * 1024)
        // Yield periodically so a busy download cannot starve VM callbacks.
        for _ in 0..<16 {
            let available = capacity - pending[side].count
            if available <= 0 {
                if !readPaused[side] { reads[side]?.suspend(); readPaused[side] = true }
                return
            }
            let count = Darwin.read(descriptors[side], &chunk, min(chunk.count, available))
            if count > 0 {
                received[side] += count
                pending[side].append(contentsOf: chunk.prefix(count))
                flush(side)
                if closed { return }
            } else if count == 0 {
                browserProxyLog("proxy EOF side=\(side == 0 ? "guest" : "unix") received=\(received[side]) forwarded=\(forwarded[side]) pending=\(pending[side].count)")
                eof[side] = true
                reads[side]?.cancel()
                reads[side] = nil
                flush(side)
                return
            } else if errno == EINTR {
                continue
            } else if errno == EAGAIN || errno == EWOULDBLOCK {
                return
            } else {
                close(reason: "read side=\(side) errno=\(errno)")
                return
            }
        }
    }

    private func completeConnect() -> Bool {
        guard connecting else { return true }
        var error: Int32 = 0
        var length = socklen_t(MemoryLayout<Int32>.size)
        let result = getsockopt(descriptors[1], SOL_SOCKET, SO_ERROR, &error, &length)
        guard result == 0, error == 0 else {
            close(reason: "unix connect errno=\(result == 0 ? error : errno)")
            return false
        }
        connecting = false
        installRead(1)
        return true
    }

    private func armWrite(_ side: Int) {
        guard !closed, writes[side] == nil else { return }
        let source = DispatchSource.makeWriteSource(fileDescriptor: descriptors[1 - side], queue: queue)
        source.setEventHandler { [weak self] in
            guard let self, !self.closed else { return }
            if side == 0 && !self.completeConnect() { return }
            self.flush(side)
        }
        writes[side] = source
        source.resume()
    }

    private func flush(_ side: Int) {
        guard !closed else { return }
        if side == 0 && connecting { armWrite(side); return }
        while !pending[side].isEmpty {
            let count = pending[side].withUnsafeBytes { bytes in
                Darwin.write(descriptors[1 - side], bytes.baseAddress, bytes.count)
            }
            if count > 0 { forwarded[side] += count; pending[side].removeFirst(count) }
            else if count < 0 && errno == EINTR { continue }
            else if count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK) { armWrite(side); return }
            else { close(reason: "write side=\(1 - side) errno=\(errno) result=\(count)"); return }
        }
        writes[side]?.cancel()
        writes[side] = nil
        if readPaused[side] {
            readPaused[side] = false
            reads[side]?.resume()
        }
        if eof[side] && !halfClosed[side] {
            halfClosed[side] = true
            if Darwin.shutdown(descriptors[1 - side], SHUT_WR) != 0 {
                browserProxyLog("proxy half-close side=\(1 - side) errno=\(errno)")
            }
        }
        if eof[0] && eof[1] && pending[0].isEmpty && pending[1].isEmpty { close(reason: "complete") }
    }

    func close(reason: String = "VM stopped") {
        guard !closed else { return }
        closed = true
        browserProxyLog("proxy relay closed reason=\(reason) received=\(received) forwarded=\(forwarded) pending=\(pending.map { $0.count })")
        for side in 0..<2 {
            if readPaused[side] { readPaused[side] = false; reads[side]?.resume() }
            reads[side]?.cancel(); reads[side] = nil
            writes[side]?.cancel(); writes[side] = nil
        }
        Darwin.close(descriptors[1])
        closeGuest()
        onClose()
    }
}

private final class BrowserProxyListener: NSObject, VZVirtioSocketListenerDelegate {
    private let path: String
    private let queue: DispatchQueue
    private let listener = VZVirtioSocketListener()
    private var connections: [UUID: BrowserProxyRelay] = [:]

    init(path: String, queue: DispatchQueue, device: VZVirtioSocketDevice) {
        self.path = path
        self.queue = queue
        super.init()
        listener.delegate = self
        device.setSocketListener(listener, forPort: browserProxyPort)
    }

    func listener(_ listener: VZVirtioSocketListener, shouldAcceptNewConnection connection: VZVirtioSocketConnection,
                  from socketDevice: VZVirtioSocketDevice) -> Bool {
        guard connections.count < 32 else {
            browserProxyLog("proxy rejected: 32 active connections")
            return false
        }
        guard proxyNonblocking(connection.fileDescriptor) else {
            browserProxyLog("proxy rejected: guestFD=\(connection.fileDescriptor) nonblocking errno=\(errno)")
            return false
        }
        do {
            let (proxy, connecting) = try connectProxySocket(path)
            let identifier = UUID()
            let relay = BrowserProxyRelay(guest: connection.fileDescriptor, proxy: proxy, connecting: connecting, queue: queue,
                closeGuest: { connection.close() }, onClose: { [weak self] in self?.connections.removeValue(forKey: identifier) })
            connections[identifier] = relay
            browserProxyLog("proxy accepted sourcePort=\(connection.sourcePort) destinationPort=\(connection.destinationPort) active=\(connections.count)")
            // VZ owns acceptance; start reading only after the delegate returns.
            queue.async { relay.start() }
            return true
        } catch {
            browserProxyLog("proxy connection failed: \(error.localizedDescription)")
            return false
        }
    }

    func close() { for connection in Array(connections.values) { connection.close() } }
}

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


private var originalTermios = termios()
private var terminalConfigured = false

private func requiredURL(
    flag: String,
    environment: String,
    isDirectory: Bool = false
) -> URL {
    let arguments = CommandLine.arguments
    if let index = arguments.firstIndex(of: flag), index + 1 < arguments.count {
        return URL(fileURLWithPath: arguments[index + 1], isDirectory: isDirectory)
    }
    if let value = ProcessInfo.processInfo.environment[environment], !value.isEmpty {
        return URL(fileURLWithPath: value, isDirectory: isDirectory)
    }
    fputs("missing \(flag) PATH (or \(environment))\n", stderr)
    Darwin.exit(64)
}

private func restoreTerminal() {
    if terminalConfigured {
        tcsetattr(STDIN_FILENO, TCSANOW, &originalTermios)
        terminalConfigured = false
    }
}

private final class ShellController: NSObject, VZVirtualMachineDelegate {
    // Retain strong reference so the VM is not deallocated by ARC while running
    var vm: VZVirtualMachine?
    var browserProxy: BrowserProxyListener?

    func guestDidStop(_ virtualMachine: VZVirtualMachine) {
        browserProxy?.close()
        restoreTerminal()
        Darwin.exit(0)
    }

    func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: Error) {
        browserProxy?.close()
        restoreTerminal()
        fputs("\n[ovm-shell] Virtual machine stopped with error: \(error.localizedDescription)\n", stderr)
        Darwin.exit(1)
    }
}

@main
private enum Main {
    static let controller = ShellController()
    static let queue = DispatchQueue(label: "local.lee.ovm.shell")

    static func main() {
        let bundleURL = requiredURL(flag: "--bundle", environment: "OVM_BUNDLE", isDirectory: true)
        let smolURL = requiredURL(flag: "--smol", environment: "OVM_SMOL")
        let shareURL = requiredURL(flag: "--share", environment: "OVM_SHARE", isDirectory: true)
        let arguments = CommandLine.arguments
        let provisioning = arguments.contains("--provision")
        func optionalValue(_ flag: String) -> String? {
            guard let index = arguments.firstIndex(of: flag) else { return nil }
            guard index + 1 < arguments.count, !arguments[index + 1].hasPrefix("--") else {
                fputs("\(flag) requires a value\n", stderr)
                Darwin.exit(64)
            }
            return arguments[index + 1]
        }
        func optionalInteger(_ flag: String, default defaultValue: Int, range: ClosedRange<Int>) -> Int {
            guard let value = optionalValue(flag) else { return defaultValue }
            guard let parsed = Int(value), range.contains(parsed) else {
                fputs("\(flag) must be an integer from \(range.lowerBound) to \(range.upperBound)\n", stderr)
                Darwin.exit(64)
            }
            return parsed
        }
        // Keep ordinary shell VMs at their established allocation. Dedicated
        // controllers may request a smaller allocation before admission.
        let memoryMB = optionalInteger("--memory-mb", default: 4096, range: 512...8192)
        let cpuCount = optionalInteger("--cpu-count", default: 4, range: 1...8)
        let networkMode = optionalValue("--network") ?? (provisioning ? "nat" : ProcessInfo.processInfo.environment["OVM_NETWORK_MODE"] ?? "nat")
        let proxySocket = optionalValue("--proxy-socket")
        if let proxySocket {
            guard proxySocket.hasPrefix("/"), proxySocket.utf8.count < 104 else {
                fputs("--proxy-socket requires an absolute Unix path shorter than 104 UTF-8 bytes\n", stderr)
                Darwin.exit(64)
            }
            signal(SIGPIPE, SIG_IGN)
        }
        guard ["nat", "isolated"].contains(networkMode) else {
            fputs("--network must be nat or isolated\n", stderr)
            Darwin.exit(64)
        }
        let distributionMode = optionalValue("--distribution") ?? ProcessInfo.processInfo.environment["OVM_DISTRIBUTION_MODE"] ?? "auto"
        guard ["auto", "local", "required"].contains(distributionMode) else {
            fputs("--distribution must be auto, local, or required\n", stderr)
            Darwin.exit(64)
        }
        var networkShareURL = optionalValue("--network-share").map { URL(fileURLWithPath: $0, isDirectory: true) }
        if !provisioning {
            do {
                let prepared = try prepareGuestNetworkShare(bundleURL: bundleURL, identity: "bundle:\(bundleURL.resolvingSymlinksInPath().path)", distributionMode: distributionMode, runtimeOnly: networkMode == "isolated" || networkShareURL != nil)
                networkShareURL = networkShareURL ?? prepared.networkShare
            } catch {
                fputs("Guest network setup failed: \(error.localizedDescription)\n", stderr)
                Darwin.exit(1)
            }
        }
        let exportShareURL = optionalValue("--export-share").map { URL(fileURLWithPath: $0, isDirectory: true) }

        signal(SIGINT, SIG_IGN)
        signal(SIGTERM, SIG_IGN)
        atexit {
            restoreTerminal()
        }

        if isatty(STDIN_FILENO) != 0 {
            tcgetattr(STDIN_FILENO, &originalTermios)
            var raw = originalTermios
            cfmakeraw(&raw)
            tcsetattr(STDIN_FILENO, TCSANOW, &raw)
            terminalConfigured = true
        }

        queue.async {
            do {
                guard VZVirtualMachine.isSupported else {
                    restoreTerminal()
                    fputs("Apple Virtualization is not supported on this host\n", stderr)
                    Darwin.exit(1)
                }

                let configuration = VZVirtualMachineConfiguration()
                configuration.cpuCount = cpuCount
                configuration.memorySize = UInt64(memoryMB) * 1024 * 1024

                let identifierData = try Data(contentsOf: bundleURL.appendingPathComponent("machineIdentifier"))
                guard let identifier = VZGenericMachineIdentifier(dataRepresentation: identifierData) else {
                    restoreTerminal()
                    fputs("invalid machineIdentifier\n", stderr)
                    Darwin.exit(1)
                }
                let platform = VZGenericPlatformConfiguration()
                platform.machineIdentifier = identifier
                configuration.platform = platform

                let bootLoader = VZLinuxBootLoader(kernelURL: bundleURL.appendingPathComponent("vmlinuz"))
                bootLoader.initialRamdiskURL = bundleURL.appendingPathComponent("initrd")
                bootLoader.commandLine = "root=LABEL=cloudimg-rootfs rw console=hvc0 panic=1 init=/bin/bash quiet ovm.network=\(networkMode) ovm.distribution=\(distributionMode) ovm.network_index=0 ovm.provision=\(provisioning ? 1 : 0) --login"
                configuration.bootLoader = bootLoader

                func writableNVMe(_ name: String) throws -> VZNVMExpressControllerDeviceConfiguration {
                    let attachment = try VZDiskImageStorageDeviceAttachment(
                        url: bundleURL.appendingPathComponent(name),
                        readOnly: false,
                        cachingMode: .cached,
                        synchronizationMode: .fsync
                    )
                    return VZNVMExpressControllerDeviceConfiguration(attachment: attachment)
                }
                let smolAttachment = try VZDiskImageStorageDeviceAttachment(url: smolURL, readOnly: true)
                configuration.storageDevices = [
                    try writableNVMe("rootfs.img"),
                    try writableNVMe("sessiondata.img"),
                    VZVirtioBlockDeviceConfiguration(attachment: smolAttachment),
                ]

                configuration.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]
                configuration.memoryBalloonDevices = [VZVirtioTraditionalMemoryBalloonDeviceConfiguration()]
                configuration.socketDevices = [VZVirtioSocketDeviceConfiguration()]

                if networkMode == "nat" {
                    let networkConfig = VZVirtioNetworkDeviceConfiguration()
                    networkConfig.attachment = VZNATNetworkDeviceAttachment()
                    networkConfig.macAddress = VZMACAddress.randomLocallyAdministered()
                    configuration.networkDevices = [networkConfig]
                }

                let fileSystem = VZVirtioFileSystemDeviceConfiguration(tag: "claudeshared")
                let sharedDirectory = VZSharedDirectory(url: shareURL, readOnly: true)
                fileSystem.share = VZSingleDirectoryShare(directory: sharedDirectory)
                configuration.directorySharingDevices = [fileSystem]
                if let networkShareURL {
                    var isDirectory: ObjCBool = false
                    guard FileManager.default.fileExists(atPath: networkShareURL.path, isDirectory: &isDirectory), isDirectory.boolValue else {
                        throw NSError(domain: "OVMShell", code: 66, userInfo: [NSLocalizedDescriptionKey: "network configuration share is not a directory: \(networkShareURL.path)"])
                    }
                    let configShare = VZVirtioFileSystemDeviceConfiguration(tag: "ovmconfig")
                    configShare.share = VZSingleDirectoryShare(directory: VZSharedDirectory(url: networkShareURL, readOnly: true))
                    configuration.directorySharingDevices.append(configShare)
                }
                if let exportShareURL {
                    var isDirectory: ObjCBool = false
                    guard FileManager.default.fileExists(atPath: exportShareURL.path, isDirectory: &isDirectory), isDirectory.boolValue else {
                        throw NSError(domain: "OVMShell", code: 66, userInfo: [NSLocalizedDescriptionKey: "export share is not a directory: \(exportShareURL.path)"])
                    }
                    // Provisioning exports are the only explicitly requested
                    // writable host share. The normal shared directory stays RO.
                    let exportShare = VZVirtioFileSystemDeviceConfiguration(tag: "ovmexport")
                    exportShare.share = VZSingleDirectoryShare(directory: VZSharedDirectory(url: exportShareURL, readOnly: false))
                    configuration.directorySharingDevices.append(exportShare)
                }

                let serialAttachment = VZFileHandleSerialPortAttachment(
                    fileHandleForReading: FileHandle.standardInput,
                    fileHandleForWriting: FileHandle.standardOutput
                )
                let console = VZVirtioConsoleDeviceConfiguration()
                let port0 = VZVirtioConsolePortConfiguration()
                port0.name = "console"
                port0.isConsole = true
                port0.attachment = serialAttachment
                console.ports[0] = port0
                configuration.consoleDevices = [console]

                try configuration.validate()

                let vm = VZVirtualMachine(configuration: configuration, queue: queue)
                vm.delegate = controller
                controller.vm = vm
                if let proxySocket {
                    guard let device = vm.socketDevices.first as? VZVirtioSocketDevice else {
                        throw NSError(domain: "OVMProxy", code: 69, userInfo: [NSLocalizedDescriptionKey: "Virtio socket device unavailable"])
                    }
                    controller.browserProxy = BrowserProxyListener(path: proxySocket, queue: queue, device: device)
                    fputs("[ovm-shell] HTTP proxy bridge ready on guest VSOCK port \(browserProxyPort)\n", stderr)
                }

                vm.start { result in
                    switch result {
                    case .success:
                        break
                    case .failure(let error):
                        restoreTerminal()
                        fputs("\nFailed to start VM: \(error.localizedDescription)\n", stderr)
                        Darwin.exit(1)
                    }
                }
            } catch {
                restoreTerminal()
                fputs("Configuration error: \(error.localizedDescription)\n", stderr)
                Darwin.exit(1)
            }
        }

        dispatchMain()
    }
}
