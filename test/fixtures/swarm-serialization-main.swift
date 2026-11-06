import Foundation

@main
enum SwarmSerializationTests {
    static func main() throws {
        let data = FileHandle.standardInput.readDataToEndOfFile()
        let task = try JSONDecoder().decode(WorkerTask.self, from: data)
        let startMarker = "===FIXTURE_START==="
        let endMarker = "===FIXTURE_END==="
        let exitMarker = "===FIXTURE_EXIT==="
        let bootstrapMarker = "===FIXTURE_BOOTSTRAP==="
        let readinessMarker = "===FIXTURE_READINESS==="
        // The test substitutes the exact production statements here. It does
        // not reimplement encoding or boot a VM.
        __SWARM_COMMAND_ENCODING__
        __SWARM_PAYLOAD__
        FileHandle.standardOutput.write(Data(payload.utf8))
    }
}
