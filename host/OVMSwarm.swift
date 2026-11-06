import Darwin
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


// High-precision millisecond clock
private func nowMs() -> Double {
    Double(clock_gettime_nsec_np(CLOCK_UPTIME_RAW)) / 1_000_000.0
}

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

struct WorkerTask: Codable {
    let name: String
    let command: String
    var baseRootfs: String? = nil
    var preserveRootfs: String? = nil
    var timeoutSeconds: Double? = nil
    var networkShare: String? = nil
    var artifactShare: String? = nil
    var artifactCapture: Bool? = nil
    var distributionMode: String? = nil
    var runtimeProfilePath: String? = nil
}

func taskOutputLimit(_ task: WorkerTask) -> Int {
    // A 256 KiB file expands to about 350 KiB in its base64 capture receipt.
    // The controller sets this only for its own fixed artifact capture command.
    task.artifactCapture == true ? 400 * 1024 : 64 * 1024
}

func artifactShareConfiguration(_ directory: String) throws -> VZVirtioFileSystemDeviceConfiguration {
    var isDirectory: ObjCBool = false
    guard directory.hasPrefix("/"), !directory.utf8.contains(0),
          FileManager.default.fileExists(atPath: directory, isDirectory: &isDirectory), isDirectory.boolValue else {
        throw NSError(domain: "OVMArtifacts", code: 66, userInfo: [NSLocalizedDescriptionKey: "artifactShare must be an absolute existing directory"])
    }
    let fileSystem = VZVirtioFileSystemDeviceConfiguration(tag: "ovm-artifacts")
    fileSystem.share = VZSingleDirectoryShare(directory: VZSharedDirectory(url: URL(fileURLWithPath: directory, isDirectory: true), readOnly: true))
    return fileSystem
}

func artifactMountScript(_ enabled: Bool) -> String {
    guard enabled else { return "" }
    return """
if [ "$bootstrap_rc" -eq 0 ]; then
    mkdir -p /ovm/artifacts && mount -t virtiofs -o ro ovm-artifacts /ovm/artifacts || bootstrap_rc=$?
fi
"""
}

struct WorkerMetrics {
    var cloneMs: Double = 0
    var bootMs: Double = 0
    var execMs: Double = 0
    var teardownMs: Double = 0
    var totalMs: Double = 0
    var output: String = ""
    var exitCode: Int = 0
    var bootstrapExitCode: Int? = nil
    var meshReady = false
    var networkFallbackReason: String? = nil
    var stopped = false
    var dynamicSpawn: [WorkerTask] = []
}

// Each finished command retains its guest services until all fleet commands
// have finished or failed. Every wait shares the latest bounded task deadline.
final class FleetTaskBarrier {
    private let condition = NSCondition()
    private let workerCount: Int
    private var arrived = Set<Int>()
    let deadline: Date

    init(workerCount: Int, deadline: Date) {
        self.workerCount = workerCount
        self.deadline = deadline
    }

    func arrive(_ id: Int) {
        condition.lock()
        arrived.insert(id)
        condition.broadcast()
        condition.unlock()
    }

    func wait() -> Bool {
        condition.lock()
        defer { condition.unlock() }
        while arrived.count < workerCount {
            if !condition.wait(until: deadline) { return arrived.count == workerCount }
        }
        return true
    }
}

final class SwarmWorker: NSObject, VZVirtualMachineDelegate {
    let id: Int
    let task: WorkerTask
    let queue: DispatchQueue
    let rootfsPath: String
    let sessionPath: String
    let markerPrefix: String
    let pipeIn = Pipe()
    let pipeOut = Pipe()

    var vm: VZVirtualMachine?
    var metrics = WorkerMetrics()
    var isDone = false
    var executionCompleted = false
    var errorMsg: String?
    var tTeardownStart: Double = 0
    private let fileLock = NSLock()
    private var filesFinalized = false
    private let completionLock = NSLock()
    private var completionCalled = false

    init(id: Int, task: WorkerTask, runId: String) {
        self.id = id
        self.task = task
        self.queue = DispatchQueue(label: "local.lee.ovm.swarm.worker.\(id)")
        self.rootfsPath = "/tmp/ovm_swarm_\(runId)_w\(id)_rootfs.img"
        self.sessionPath = "/tmp/ovm_swarm_\(runId)_w\(id)_session.img"
        self.markerPrefix = "===OVM_\(runId)_W\(id)_"
        super.init()
    }

    func finalizeFiles(preserveChanges: Bool) {
        fileLock.lock()
        defer { fileLock.unlock() }
        if filesFinalized { return }
        filesFinalized = true

        if preserveChanges,
           let preserve = task.preserveRootfs,
           FileManager.default.fileExists(atPath: rootfsPath) {
            let replacement = "\(preserve).ovm-\(getpid())-\(id).tmp"
            let parent = URL(fileURLWithPath: preserve).deletingLastPathComponent().path
            do {
                try FileManager.default.createDirectory(
                    atPath: parent,
                    withIntermediateDirectories: true,
                    attributes: [.posixPermissions: 0o700]
                )
            } catch {
                errorMsg = errorMsg ?? "Persistent rootfs directory creation failed: \(error.localizedDescription)"
                unlink(rootfsPath)
                unlink(sessionPath)
                return
            }
            unlink(replacement)
            var copied = clonefile(rootfsPath, replacement, 0) == 0
            if !copied {
                do {
                    try FileManager.default.copyItem(atPath: rootfsPath, toPath: replacement)
                    copied = true
                } catch {
                    errorMsg = errorMsg ?? "Persistent rootfs copy failed: \(error.localizedDescription)"
                }
            }
            if copied {
                if rename(replacement, preserve) != 0 {
                    errorMsg = errorMsg ?? "Persistent rootfs publish failed: \(String(cString: strerror(errno)))"
                    unlink(replacement)
                } else if let profile = task.runtimeProfilePath {
                    let receipt = preserve + ".ovm-guest-v1.json"
                    if !FileManager.default.fileExists(atPath: receipt) {
                        do {
                            try FileManager.default.copyItem(atPath: profile, toPath: receipt)
                            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: receipt)
                        } catch {
                            errorMsg = errorMsg ?? "Persistent runtime receipt failed: \(error.localizedDescription)"
                        }
                    }
                }
            }
        }
        unlink(rootfsPath)
        unlink(sessionPath)
    }

    func completeOnce(_ completion: @escaping () -> Void) {
        completionLock.lock()
        defer { completionLock.unlock() }
        if completionCalled { return }
        completionCalled = true
        completion()
    }

    private func stopAfterPeerBarrier() {
        if !isDone {
            let shutdown = "sync; poweroff -f\n"
            let input = pipeIn.fileHandleForWriting.fileDescriptor
            _ = shutdown.withCString { Darwin.write(input, $0, strlen($0)) }
            let gracefulDeadline = Date().addingTimeInterval(5)
            while !isDone && Date() < gracefulDeadline { usleep(5_000) }
        }
        if !isDone {
            let stopped = DispatchSemaphore(value: 0)
            queue.async { [self] in
                guard let vm else { isDone = true; stopped.signal(); return }
                if vm.state == .stopped || vm.state == .error {
                    isDone = true
                    stopped.signal()
                    return
                }
                vm.stop { [self] error in
                    if let error {
                        errorMsg = errorMsg ?? "Forced VM stop failed: \(error.localizedDescription)"
                    } else { isDone = true }
                    stopped.signal()
                }
            }
            if stopped.wait(timeout: .now() + 3) == .timedOut {
                errorMsg = errorMsg ?? "VM stop confirmation exceeded its deadline"
            }
        }
        metrics.stopped = queue.sync { vm == nil || vm?.state == .stopped || vm?.state == .error }
        if !metrics.stopped { errorMsg = errorMsg ?? "VM did not reach a stopped state before finalization" }
    }

    func run(bundleURL: URL, smolURL: URL, memoryMB: UInt64, cpuCount: Int, networkMode: String, barrier: FleetTaskBarrier, completion: @escaping () -> Void) {
        let tStart = nowMs()

        // 1. Instant APFS Copy-on-Write Zero-Copy Clone
        unlink(rootfsPath)
        unlink(sessionPath)
        let tClone0 = nowMs()
        let srcRootfs = task.baseRootfs ?? bundleURL.appendingPathComponent("rootfs.img").path
        let c1 = clonefile(srcRootfs, rootfsPath, 0)
        let c2 = clonefile(bundleURL.appendingPathComponent("sessiondata.img").path, sessionPath, 0)
        let tClone1 = nowMs()
        metrics.cloneMs = tClone1 - tClone0

        guard c1 == 0 && c2 == 0 else {
            errorMsg = "APFS CoW snapshotting failed from \(srcRootfs)"
            metrics.stopped = true
            finalizeFiles(preserveChanges: false)
            barrier.arrive(id)
            completeOnce(completion)
            return
        }

        queue.async { [self] in
            do {
                let config = VZVirtualMachineConfiguration()
                config.cpuCount = cpuCount
                config.memorySize = memoryMB * 1024 * 1024

                let platform = VZGenericPlatformConfiguration()
                platform.machineIdentifier = VZGenericMachineIdentifier()
                config.platform = platform

                let bootLoader = VZLinuxBootLoader(kernelURL: bundleURL.appendingPathComponent("vmlinuz"))
                bootLoader.initialRamdiskURL = bundleURL.appendingPathComponent("initrd")
                bootLoader.commandLine = "root=LABEL=cloudimg-rootfs rw console=hvc0 panic=1 init=/bin/bash quiet ovm.network=\(networkMode) ovm.distribution=\(task.distributionMode ?? "auto") ovm.network_index=0 --login"
                config.bootLoader = bootLoader

                func writableNVMe(_ path: String) throws -> VZNVMExpressControllerDeviceConfiguration {
                    let attachment = try VZDiskImageStorageDeviceAttachment(
                        url: URL(fileURLWithPath: path),
                        readOnly: false,
                        cachingMode: .cached,
                        synchronizationMode: .fsync
                    )
                    return VZNVMExpressControllerDeviceConfiguration(attachment: attachment)
                }

                let smolAttachment = try VZDiskImageStorageDeviceAttachment(url: smolURL, readOnly: true)
                config.storageDevices = [
                    try writableNVMe(rootfsPath),
                    try writableNVMe(sessionPath),
                    VZVirtioBlockDeviceConfiguration(attachment: smolAttachment),
                ]

                config.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]
                config.memoryBalloonDevices = [VZVirtioTraditionalMemoryBalloonDeviceConfiguration()]
                if networkMode == "nat" {
                    let network = VZVirtioNetworkDeviceConfiguration()
                    network.attachment = VZNATNetworkDeviceAttachment()
                    network.macAddress = VZMACAddress.randomLocallyAdministered()
                    config.networkDevices = [network]
                }
                if let networkShare = task.networkShare {
                    var isDirectory: ObjCBool = false
                    guard FileManager.default.fileExists(atPath: networkShare, isDirectory: &isDirectory), isDirectory.boolValue else {
                        throw NSError(domain: "OVMSwarm", code: 66, userInfo: [NSLocalizedDescriptionKey: "network configuration share is not a directory: \(networkShare)"])
                    }
                    let configShare = VZVirtioFileSystemDeviceConfiguration(tag: "ovmconfig")
                    configShare.share = VZSingleDirectoryShare(directory: VZSharedDirectory(url: URL(fileURLWithPath: networkShare), readOnly: true))
                    config.directorySharingDevices = [configShare]
                }
                if let artifactShare = task.artifactShare {
                    config.directorySharingDevices.append(try artifactShareConfiguration(artifactShare))
                }

                let serialAttachment = VZFileHandleSerialPortAttachment(
                    fileHandleForReading: pipeIn.fileHandleForReading,
                    fileHandleForWriting: pipeOut.fileHandleForWriting
                )
                let console = VZVirtioConsoleDeviceConfiguration()
                let port0 = VZVirtioConsolePortConfiguration()
                port0.name = "console"
                port0.isConsole = true
                port0.attachment = serialAttachment
                console.ports[0] = port0
                config.consoleDevices = [console]

                try config.validate()

                let machine = VZVirtualMachine(configuration: config, queue: queue)
                machine.delegate = self
                self.vm = machine

                let tBoot0 = nowMs()
                machine.start { result in
                    let tBoot1 = nowMs()
                    self.metrics.bootMs = tBoot1 - tBoot0
                    if case .failure(let error) = result {
                        self.errorMsg = "Virtual machine start failed: \(error.localizedDescription)"
                        self.isDone = true
                    }
                }
            } catch {
                self.errorMsg = "Configuration failed: \(error.localizedDescription)"
                self.isDone = true
            }
        }

        // Monitoring and Task Execution Thread
        DispatchQueue.global().async { [self] in
            let fdIn = pipeIn.fileHandleForWriting.fileDescriptor
            let fdOut = pipeOut.fileHandleForReading.fileDescriptor
            _ = fcntl(fdOut, F_SETFL, O_NONBLOCK)

            var rawBuffer = ""
            var sent = false
            var tExec0: Double = 0
            let commandBase64 = Data(task.command.utf8).base64EncodedString()
            let startMarker = "\(markerPrefix)TASK_EXEC_START==="
            let endMarker = "\(markerPrefix)TASK_EXEC_END==="
            let exitMarker = "\(markerPrefix)TASK_EXIT_CODE==="
            let bootstrapMarker = "\(markerPrefix)BOOTSTRAP_EXIT_CODE==="
            let readinessMarker = "\(markerPrefix)BOOTSTRAP_RECEIPT==="

            let taskDeadline = min(120.0, max(1.0, task.timeoutSeconds ?? 30.0))
            let deadline = Date().addingTimeInterval(taskDeadline)
            while Date() < deadline && !isDone {
                var buf = [UInt8](repeating: 0, count: 2048)
                let n = read(fdOut, &buf, 2048)
                if n > 0 {
                    let chunk = String(bytes: buf.prefix(n), encoding: .utf8) ?? ""
                    rawBuffer += chunk

                    // Match a complete output line, not the echoed wrapper's
                    // `echo '...marker...'` source, which arrives before execution.
                    let outputLines = rawBuffer.replacingOccurrences(of: "\r", with: "").components(separatedBy: "\n")
                    if outputLines.contains(endMarker) {
                        executionCompleted = true
                        tTeardownStart = nowMs()
                        break
                    }

                    if !sent && (rawBuffer.contains("#") || rawBuffer.contains("clean")) {
                        tExec0 = nowMs()
                        // Transfer the model-produced command as data. A command cannot
                        // terminate this heredoc or alter the wrapper that owns shutdown.
                        let payload = """
cat << 'SCRIPT_EOF' > /tmp/run_task.sh
mount -t proc proc /proc 2>/dev/null
mount -t devpts devpts /dev/pts 2>/dev/null
printf '%s' '\(commandBase64)' | base64 -d > /tmp/agent_task.sh
chmod 0700 /tmp/agent_task.sh
echo '\(startMarker)'
bootstrap_rc=0
if [ -x /usr/local/sbin/ovm-guest-start ]; then
    /usr/local/sbin/ovm-guest-start || bootstrap_rc=$?
else
    printf 'Prepared OVM guest runtime is missing; run ovm guests setup.\n'
    bootstrap_rc=127
fi
\(artifactMountScript(task.artifactShare != nil))
printf '\n%s%s\n' '\(bootstrapMarker)' "$bootstrap_rc"
if [ -r /run/ovm/ready.json ]; then
    printf '\n%s' '\(readinessMarker)'
    python3 -c 'import json; print(json.dumps(json.load(open("/run/ovm/ready.json")),separators=(",",":")))'
fi
set -o pipefail
if [ "$bootstrap_rc" -eq 0 ]; then
    bash /tmp/agent_task.sh 2>&1 | tail -c \(taskOutputLimit(task))
    task_rc=${PIPESTATUS[0]}
else
    printf 'OVM guest bootstrap failed (exit=%s); task was not run.\n' "$bootstrap_rc"
    task_rc=$bootstrap_rc
fi
sync
printf '\n%s%s\n' '\(exitMarker)' "$task_rc"
echo '\(endMarker)'
SCRIPT_EOF
bash /tmp/run_task.sh > /dev/hvc0 2>&1

"""
                        _ = payload.withCString { write(fdIn, $0, strlen($0)) }
                        sent = true
                                            }
                }
                usleep(5000)
            }

            let tExec1 = nowMs()
            metrics.execMs = sent ? tExec1 - tExec0 : 0

            let cleanBuffer = rawBuffer.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")

            // Extract dynamic spawn instructions if present
            if let spawnEnd = cleanBuffer.range(of: "===OVM_DYNAMIC_SPAWN_END===", options: .backwards),
               let spawnStart = cleanBuffer[..<spawnEnd.lowerBound].range(of: "===OVM_DYNAMIC_SPAWN===", options: .backwards) {
                let jsonStr = cleanBuffer[spawnStart.upperBound..<spawnEnd.lowerBound].trimmingCharacters(in: .whitespacesAndNewlines)
                if let data = jsonStr.data(using: .utf8) {
                    if let spawned = try? JSONDecoder().decode([WorkerTask].self, from: data) {
                        metrics.dynamicSpawn = spawned
                    }
                }
            }

            // Extract content between execution markers and strip dynamic spawn block
            if let endRange = cleanBuffer.range(of: endMarker, options: .backwards),
               let startRange = cleanBuffer[..<endRange.lowerBound].range(of: startMarker, options: .backwards) {
                var extracted = String(cleanBuffer[startRange.upperBound..<endRange.lowerBound])
                if let exitLine = extracted.components(separatedBy: "\n").last(where: { $0.hasPrefix(exitMarker) }) {
                    metrics.exitCode = Int(exitLine.dropFirst(exitMarker.count)) ?? 1
                } else {
                    metrics.exitCode = 1
                }
                if let bootstrapLine = extracted.components(separatedBy: "\n").last(where: { $0.hasPrefix(bootstrapMarker) }) {
                    metrics.bootstrapExitCode = Int(bootstrapLine.dropFirst(bootstrapMarker.count))
                    if metrics.bootstrapExitCode != 0 {
                        errorMsg = "Guest bootstrap failed (exit=\(metrics.bootstrapExitCode ?? -1)); task was not run"
                    }
                } else {
                    errorMsg = errorMsg ?? "Guest wrapper returned no bootstrap status"
                }
                if let readinessLine = extracted.components(separatedBy: "\n").first(where: { $0.hasPrefix(readinessMarker) }),
                   let readinessData = String(readinessLine.dropFirst(readinessMarker.count)).data(using: .utf8),
                   let readiness = try? JSONSerialization.jsonObject(with: readinessData) as? [String: Any],
                   readiness["schema"] as? String == "ovm.guest-ready/v2",
                   readiness["distributionMode"] as? String == task.distributionMode,
                   readiness["networkMode"] as? String == networkMode {
                    metrics.meshReady = metrics.bootstrapExitCode == 0 && readiness["meshReady"] as? Bool == true
                    metrics.networkFallbackReason = readiness["fallbackReason"] as? String
                }
                extracted = extracted.components(separatedBy: "\n")
                    .filter { !$0.hasPrefix(exitMarker) && !$0.hasPrefix(bootstrapMarker) && !$0.hasPrefix(readinessMarker) }
                    .joined(separator: "\n")
                if let s1 = extracted.range(of: "===OVM_DYNAMIC_SPAWN==="),
                   let s2 = extracted.range(of: "===OVM_DYNAMIC_SPAWN_END===", options: .backwards),
                   s1.lowerBound <= s2.upperBound {
                    extracted.removeSubrange(s1.lowerBound..<s2.upperBound)
                    extracted = extracted.replacingOccurrences(of: "===OVM_DYNAMIC_SPAWN_END===", with: "")
                }
                metrics.output = extracted.trimmingCharacters(in: .whitespacesAndNewlines)
            } else {
                metrics.output = cleanBuffer.trimmingCharacters(in: .whitespacesAndNewlines)
            }

            if !executionCompleted {
                errorMsg = errorMsg ?? "Guest task did not reach its completion marker before the deadline"
                metrics.exitCode = 1
            }
            barrier.arrive(id)
            if !barrier.wait() {
                errorMsg = errorMsg ?? "Fleet peer barrier exceeded the bounded task deadline"
            }
            tTeardownStart = nowMs()
            stopAfterPeerBarrier()
            metrics.teardownMs = nowMs() - tTeardownStart
            metrics.totalMs = nowMs() - tStart
            // Never publish a snapshot while the guest can still modify it.
            if metrics.stopped {
                finalizeFiles(preserveChanges: executionCompleted)
            }

            completeOnce(completion)
        }
    }

    func guestDidStop(_ virtualMachine: VZVirtualMachine) {
        if !isDone {
            isDone = true
        }
    }

    func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: Error) {
        isDone = true
        errorMsg = errorMsg ?? "Virtual machine stopped with error: \(error.localizedDescription)"
    }
}

#if !OVM_BARRIER_TEST
@main
enum SwarmMain {
    static var activeWorkers: [SwarmWorker] = []
    static var signalSources: [DispatchSourceSignal] = []

    static func main() {
        signal(SIGPIPE, SIG_IGN)
        let args = CommandLine.arguments
        let isJson = args.contains("--json")
        let benchmark = args.contains("--benchmark")

        var workerCount = 2
        if let idx = args.firstIndex(of: "--workers"), idx + 1 < args.count, let n = Int(args[idx + 1]) {
            workerCount = max(1, min(16, n))
        }

        var memoryMB: UInt64 = 1024
        if let idx = args.firstIndex(of: "--memory-mb"), idx + 1 < args.count, let n = UInt64(args[idx + 1]) {
            memoryMB = max(512, min(8192, n))
        }

        var cpuCount = 2
        if let idx = args.firstIndex(of: "--cpu-count"), idx + 1 < args.count, let n = Int(args[idx + 1]) {
            cpuCount = max(1, min(8, n))
        }

        let bundleURL = requiredURL(flag: "--bundle", environment: "OVM_BUNDLE", isDirectory: true)
        let smolURL = requiredURL(flag: "--smol", environment: "OVM_SMOL")
        var networkMode = ProcessInfo.processInfo.environment["OVM_NETWORK_MODE"] ?? "nat"
        if let index = args.firstIndex(of: "--network") {
            guard index + 1 < args.count else {
                fputs("--network requires nat or isolated\n", stderr)
                Darwin.exit(64)
            }
            networkMode = args[index + 1]
        }
        guard ["nat", "isolated"].contains(networkMode) else {
            fputs("--network must be nat or isolated\n", stderr)
            Darwin.exit(64)
        }
        var distributionMode = ProcessInfo.processInfo.environment["OVM_DISTRIBUTION_MODE"] ?? "auto"
        if let index = args.firstIndex(of: "--distribution") {
            guard index + 1 < args.count else {
                fputs("--distribution requires auto, local, or required\n", stderr)
                Darwin.exit(64)
            }
            distributionMode = args[index + 1]
        }
        guard ["auto", "local", "required"].contains(distributionMode) else {
            fputs("--distribution must be auto, local, or required\n", stderr)
            Darwin.exit(64)
        }
        let runId = String(format: "%06x", UInt32.random(in: 0...0xFFFFFF))

        let defaultTasks: [WorkerTask] = [
            WorkerTask(
                name: "Agent-Compiler",
                command: "echo 'int fib(int n){return n<=1?n:fib(n-1)+fib(n-2);} int main(){return fib(10);}' > /tmp/fib.c && gcc -O3 /tmp/fib.c -o /tmp/fib && /tmp/fib; echo \"C-binary fib(10) exit=$?\""
            ),
            WorkerTask(
                name: "Agent-DataTopology",
                command: "uname -a; echo 'CPU Cores:' $(nproc); echo 'Memory:' $(free -m | awk '/Mem:/ {print $2}') MB; python3 -c 'import math; print(\"Math calculation sqrt(42) =\", math.sqrt(42))'"
            ),
            WorkerTask(
                name: "Agent-SecurityAudit",
                command: "cat /etc/os-release | grep PRETTY_NAME; id; echo 'Open file descriptors:' $(ls /proc/self/fd 2>/dev/null | wc -l)"
            ),
            WorkerTask(
                name: "Agent-StorageCoW",
                command: "df -h /; touch /tmp/cow_divergence.tmp && echo 'SUCCESS: Private CoW divergence verified' || echo 'FAIL'"
            )
        ]

        func parseTasks(_ data: Data) -> [WorkerTask]? {
            do {
                return try JSONDecoder().decode([WorkerTask].self, from: data)
            } catch {
                if !isJson {
                    print("\u{001B}[31mTask JSON Decode Error: \(error)\u{001B}[0m")
                }
                return nil
            }
        }

        var loadedTasks: [WorkerTask]? = nil
        if let idx = args.firstIndex(of: "--tasks-json"), idx + 1 < args.count {
            if let data = args[idx + 1].data(using: .utf8) {
                loadedTasks = parseTasks(data)
            }
        } else if let idx = args.firstIndex(of: "--tasks-file"), idx + 1 < args.count {
            if let data = try? Data(contentsOf: URL(fileURLWithPath: args[idx + 1])) {
                loadedTasks = parseTasks(data)
            }
        } else if args.contains("--tasks-stdin") {
            let data = FileHandle.standardInput.readDataToEndOfFile()
            loadedTasks = parseTasks(data)
        }

        var selectedTasks: [WorkerTask]
        if let custom = loadedTasks, !custom.isEmpty {
            selectedTasks = custom
            workerCount = custom.count
        } else {
            selectedTasks = Array(defaultTasks.prefix(workerCount))
        }
        do {
                for index in selectedTasks.indices {
                    let taskDistributionMode = selectedTasks[index].distributionMode ?? distributionMode
                    guard ["auto", "local", "required"].contains(taskDistributionMode) else {
                        throw NSError(domain: "OVMNetwork", code: 64, userInfo: [NSLocalizedDescriptionKey: "Task distributionMode must be auto, local, or required"])
                    }
                    selectedTasks[index].distributionMode = taskDistributionMode
                    let identity = selectedTasks[index].preserveRootfs.map {
                        "rootfs:\(URL(fileURLWithPath: $0).standardizedFileURL.path)"
                    } ?? "fleet:\(UUID().uuidString):\(index)"
                    let prepared = try prepareGuestNetworkShare(bundleURL: bundleURL, identity: identity,
                        sourceRootfs: selectedTasks[index].baseRootfs,
                        distributionMode: taskDistributionMode,
                        runtimeOnly: networkMode == "isolated" || selectedTasks[index].networkShare != nil)
                    selectedTasks[index].networkShare = selectedTasks[index].networkShare ?? prepared.networkShare?.path
                    selectedTasks[index].runtimeProfilePath = prepared.profilePath
                }
        } catch {
            fputs("Guest preparation failed: \(error.localizedDescription)\n", stderr)
            Darwin.exit(1)
        }

        for (signalNumber, exitCode) in [(SIGINT, 130), (SIGTERM, 143)] {
            signal(signalNumber, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
            source.setEventHandler {
                for worker in SwarmMain.activeWorkers {
                    worker.finalizeFiles(preserveChanges: false)
                }
                Darwin.exit(Int32(exitCode))
            }
            source.resume()
            signalSources.append(source)
        }

        if !isJson {
            print("""

\u{001B}[1;36m  ╭────────────────────────────────────────────────────────────────────────╮
  │              \u{001B}[1;35movm-swarm\u{001B}[1;36m · Distributed MicroVM Agent Fleet                     │
  │      Apple Virtualization.framework · Instant APFS CoW Virtualization  │
  ╰────────────────────────────────────────────────────────────────────────╯\u{001B}[0m
  Fleet Size:      \u{001B}[1m\(workerCount) autonomous microVMs\u{001B}[0m
  Memory / Worker: \u{001B}[1m\(memoryMB) MiB RAM\u{001B}[0m  |  vCPUs / Worker: \u{001B}[1m\(cpuCount) cores\u{001B}[0m
  Network:         \u{001B}[32m\(networkMode == "nat" ? "NAT; distribution " + distributionMode : "isolated; no network device")\u{001B}[0m
  Hypervisor:      \u{001B}[32mApple Virtualization (ARM64 EL2)\u{001B}[0m
  Disk Snapshot:   \u{001B}[33mAPFS copy-on-write clone per worker\u{001B}[0m
""")
        }

        let workers = (0..<workerCount).map { i in
            SwarmWorker(id: i, task: selectedTasks[i % selectedTasks.count], runId: runId)
        }
        activeWorkers = workers

        let group = DispatchGroup()
        let tGlobalStart = nowMs()
        let maximumTaskSeconds = selectedTasks.map { min(120.0, max(1.0, $0.timeoutSeconds ?? 30.0)) }.max() ?? 30.0
        let barrier = FleetTaskBarrier(workerCount: workerCount, deadline: Date().addingTimeInterval(maximumTaskSeconds + 1))

        for w in workers {
            group.enter()
            if !isJson {
                print("  \u{001B}[34m▸ Forking and booting Worker #\(w.id) [\(w.task.name)]...\u{001B}[0m")
            }
            w.run(bundleURL: bundleURL, smolURL: smolURL, memoryMB: memoryMB, cpuCount: cpuCount, networkMode: networkMode, barrier: barrier) {
                group.leave()
            }
        }

        group.notify(queue: .main) {
            let tGlobalTotal = nowMs() - tGlobalStart
            let scratchFilesRemaining = workers.flatMap { [$0.rootfsPath, $0.sessionPath] }
                .filter { FileManager.default.fileExists(atPath: $0) }

            if isJson {
                let jsonDict: [String: Any] = [
                    "fleetSize": workerCount,
                    "memoryMBPerWorker": memoryMB,
                    "cpuCountPerWorker": cpuCount,
                    "networkMode": networkMode,
                    "distributionMode": distributionMode,
                    "networkForwarding": networkMode == "nat",
                    "networkIsolated": networkMode == "isolated",
                    "allGuestsStopped": workers.allSatisfy { $0.metrics.stopped },
                    "scratchFilesRemaining": scratchFilesRemaining,
                    "globalElapsedMs": tGlobalTotal,
                    "workers": workers.map { w in
                        [
                            "id": w.id,
                            "agent": w.task.name,
                            "cloneMs": w.metrics.cloneMs,
                            "bootMs": w.metrics.bootMs,
                            "execMs": w.metrics.execMs,
                            "teardownMs": w.metrics.teardownMs,
                            "totalMs": w.metrics.totalMs,
                            "output": w.metrics.output,
                            "exitCode": w.metrics.exitCode,
                            "bootstrapExitCode": w.metrics.bootstrapExitCode as Any,
                            "stopped": w.metrics.stopped,
                            "networkMode": networkMode,
                            "distributionMode": w.task.distributionMode as Any,
                            "meshReady": w.metrics.meshReady,
                            "networkFallbackReason": w.metrics.networkFallbackReason as Any,
                            "networkConfigurationShare": w.task.networkShare != nil,
                            "artifactDirectory": w.task.artifactShare != nil ? "/ovm/artifacts" as Any : NSNull(),
                            "dynamicSpawn": w.metrics.dynamicSpawn.map { t in
                                [
                                    "name": t.name,
                                    "command": t.command,
                                    "baseRootfs": t.baseRootfs as Any,
                                    "preserveRootfs": t.preserveRootfs as Any,
                                    "networkShare": t.networkShare as Any,
                                    "artifactShare": t.artifactShare as Any,
                                    "distributionMode": t.distributionMode as Any
                                ]
                            },
                            "error": w.errorMsg as Any
                        ]
                    }
                ]
                if let data = try? JSONSerialization.data(withJSONObject: jsonDict, options: [.prettyPrinted, .sortedKeys]),
                   let str = String(data: data, encoding: .utf8) {
                    print(str)
                }
            } else {
                print("\n\u{001B}[1;32m✓ All \(workerCount) microVM agents completed in \(String(format: "%.2f", tGlobalTotal)) ms!\u{001B}[0m\n")

                for w in workers {
                    print("\u{001B}[1;35m━━━ Worker #\(w.id): \(w.task.name) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\u{001B}[0m")
                    print("\u{001B}[90mCoW Clone: \(String(format: "%.2f", w.metrics.cloneMs))ms | Boot: \(String(format: "%.1f", w.metrics.bootMs))ms | Execution: \(String(format: "%.1f", w.metrics.execMs))ms\u{001B}[0m")
                    for line in w.metrics.output.components(separatedBy: "\n") {
                        if !line.isEmpty {
                            print("  │ \(line)")
                        }
                    }
                    if !w.metrics.dynamicSpawn.isEmpty {
                        print("  \u{001B}[1;36m↳ Dynamically Requested Children (\(w.metrics.dynamicSpawn.count)):\u{001B}[0m")
                        for child in w.metrics.dynamicSpawn {
                            print("    ✦ \(child.name): \(child.command)")
                        }
                    }
                    print("")
                }

                if benchmark {
                    let count = Double(workers.count)
                    let avgClone = workers.map { $0.metrics.cloneMs }.reduce(0, +) / count
                    let avgBoot = workers.map { $0.metrics.bootMs }.reduce(0, +) / count
                    let avgExec = workers.map { $0.metrics.execMs }.reduce(0, +) / count
                    let avgTeardown = workers.map { $0.metrics.teardownMs }.reduce(0, +) / count

                    print("""
\u{001B}[1;33m═══ EMPIRICAL HYPERVISOR TELEMETRY (Honest Systems Report) ═══════════════\u{001B}[0m
  Metric                       Worker 0        Worker 1        Swarm Avg (All \(workers.count))
  ────────────────────────────────────────────────────────────────────────
  APFS CoW Fork Latency:       \(String(format: "%6.2f ms", workers[0].metrics.cloneMs))      \(String(format: "%6.2f ms", workers[1 % workers.count].metrics.cloneMs))      \(String(format: "%6.2f ms", avgClone))
  Kernel Boot Stage:           \(String(format: "%6.1f ms", workers[0].metrics.bootMs))      \(String(format: "%6.1f ms", workers[1 % workers.count].metrics.bootMs))      \(String(format: "%6.1f ms", avgBoot))
  Agent Task Execution:        \(String(format: "%6.1f ms", workers[0].metrics.execMs))      \(String(format: "%6.1f ms", workers[1 % workers.count].metrics.execMs))      \(String(format: "%6.1f ms", avgExec))
  ACPI Teardown & Reap:        \(String(format: "%6.1f ms", workers[0].metrics.teardownMs))      \(String(format: "%6.1f ms", workers[1 % workers.count].metrics.teardownMs))      \(String(format: "%6.1f ms", avgTeardown))
  Hardware Domain:             ARM64 EL2       ARM64 EL2       Type-2 Hypervisor
  ────────────────────────────────────────────────────────────────────────
""")
                }

                if scratchFilesRemaining.isEmpty {
                    print("\u{001B}[32m✓ MicroVM scratch files reclaimed.\u{001B}[0m\n")
                } else {
                    print("\u{001B}[31mMicroVM scratch files retained because cleanup was not confirmed: \(scratchFilesRemaining.joined(separator: ", "))\u{001B}[0m\n")
                }
            }

            Darwin.exit(0)
        }

        dispatchMain()
    }
}
#endif
