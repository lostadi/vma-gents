import Foundation
import Virtualization

@main
enum ArtifactShareTests {
    static func main() throws {
        if CommandLine.arguments.dropFirst().first == "--mount-script" {
            print(artifactMountScript(true))
            return
        }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("ovm-artifacts-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("artifact.txt")
        try Data("artifact bytes".utf8).write(to: file)
        let configuration = try artifactShareConfiguration(directory.path)
        precondition(configuration.tag == "ovm-artifacts")
        let share = configuration.share as! VZSingleDirectoryShare
        precondition(share.directory.isReadOnly, "canonical host artifacts must be immutable to a guest")
        precondition(share.directory.url.path == directory.path)
        for invalid in ["relative/path", file.path, directory.appendingPathComponent("missing").path] {
            var rejected = false
            do { _ = try artifactShareConfiguration(invalid) } catch { rejected = true }
            precondition(rejected, "only an absolute directory may be mounted")
        }
        precondition(artifactMountScript(false).isEmpty, "tasks without artifacts need no extra mount")
        let task = try JSONDecoder().decode(WorkerTask.self, from: JSONSerialization.data(withJSONObject: ["name": "reader", "command": "cat /ovm/artifacts/artifact.txt", "artifactShare": directory.path]))
        precondition(task.artifactShare == directory.path)
        precondition(taskOutputLimit(task) == 65_536, "ordinary VM output must retain its existing bound")
        let capture = try JSONDecoder().decode(WorkerTask.self, from: JSONSerialization.data(withJSONObject: ["name": "capture", "command": "fixed capture command", "artifactCapture": true]))
        precondition(taskOutputLimit(capture) == 409_600, "capture output must fit a complete 256 KiB base64 file receipt")
        precondition(taskOutputLimit(capture) > ((256 * 1024 + 2) / 3) * 4 + 4096)
        print("artifact share: readonly host directory, validation, optional mount and task decoding passed; bounded capture expansion passed")
    }
}
