import Foundation

@main
enum BarrierTests {
    static func main() {
        let waiting = FleetTaskBarrier(workerCount: 2, deadline: Date().addingTimeInterval(1))
        let released = DispatchSemaphore(value: 0)
        waiting.arrive(0)
        DispatchQueue.global().async {
            precondition(waiting.wait(), "all arrivals must release the waiter")
            released.signal()
        }
        precondition(released.wait(timeout: .now() + 0.05) == .timedOut,
                     "a finished worker must remain alive while its peer is running")
        waiting.arrive(1)
        precondition(released.wait(timeout: .now() + 0.5) == .success,
                     "the last completed or failed worker must release its peers")

        let deadline = FleetTaskBarrier(workerCount: 2, deadline: Date().addingTimeInterval(0.05))
        deadline.arrive(0)
        deadline.arrive(0)
        precondition(!deadline.wait(), "duplicate arrivals must not satisfy a missing peer")
        print("fleet barrier: peer wait, release and bounded timeout passed")
    }
}
