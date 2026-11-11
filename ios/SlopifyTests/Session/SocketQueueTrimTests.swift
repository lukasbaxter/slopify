import XCTest
@testable import Slopify

final class SocketQueueTrimTests: XCTestCase {
    private func items(_ n: Int, nameLength: Int = 100) -> [QueueItem] {
        let name = String(repeating: "x", count: nameLength)
        let json = "[" + (0..<n).map { #"{"Id":"\#(String(format: "%032x", $0))","Name":"\#(name)"}"# }.joined(separator: ",") + "]"
        return try! JSONDecoder().decode([QueueItem].self, from: Data(json.utf8))
    }

    func testSmallQueueUntouched() throws {
        let q = items(10)
        let r = SocketQueueTrim.frame(q)
        XCTAssertEqual(r.queue, q)
        let obj = try JSONSerialization.jsonObject(with: r.frame) as! [String: Any]
        XCTAssertEqual(obj["type"] as? String, "queue")
        XCTAssertEqual((obj["queue"] as? [Any])?.count, 10)
    }

    func testCutsToEightyPercentUntilItFits() {
        let q = items(100)
        let one = SocketQueueTrim.encode(Array(q.prefix(1))).count
        let budget = SocketQueueTrim.encode(Array(q.prefix(50))).count
        let r = SocketQueueTrim.frame(q, maxBytes: budget)
        // 100 -> 80 -> 64 -> 52 -> 42: first count whose frame fits.
        XCTAssertEqual(r.queue.count, 42)
        XCTAssertEqual(r.queue, Array(q.prefix(42)))
        XCTAssertLessThanOrEqual(r.frame.count, budget)
        XCTAssertGreaterThan(one, 0)
    }

    func testNeverBelowOneItem() {
        let r = SocketQueueTrim.frame(items(5, nameLength: 1000), maxBytes: 10)
        XCTAssertEqual(r.queue.count, 1)
    }

    /// Regression: 2 items over budget used to loop forever (ceil(1.6) == 2).
    func testTwoItemsOverBudgetEnds() {
        XCTAssertEqual(SocketQueueTrim.frame(items(2, nameLength: 1000), maxBytes: 10).queue.count, 1)
        // One item over the limit is sent as-is, like the web (its loop needs > 1 item).
        XCTAssertEqual(SocketQueueTrim.frame(items(1, nameLength: 1000), maxBytes: 10).queue.count, 1)
    }

    func testRealBudgetHoldsFiveThousand() {
        let r = SocketQueueTrim.frame(items(5000, nameLength: 700))
        XCTAssertLessThanOrEqual(r.frame.count, SocketQueueTrim.maxBytes)
        XCTAssertLessThan(r.queue.count, 5000)
    }
}
