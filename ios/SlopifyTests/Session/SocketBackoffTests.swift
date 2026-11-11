import XCTest
@testable import Slopify

final class SocketBackoffTests: XCTestCase {
    func testDoublesToTwentySeconds() {
        var b = SocketBackoff()
        let seq = (0..<8).map { _ in b.take() }
        XCTAssertEqual(seq, [1, 2, 4, 8, 16, 20, 20, 20])
    }

    func testResetOnlyAfterLongConnection() {
        var b = SocketBackoff()
        _ = b.take(); _ = b.take()                          // next = 4
        b.connectionEnded(lived: 3); XCTAssertEqual(b.next, 4)
        b.connectionEnded(lived: nil); XCTAssertEqual(b.next, 4)
        b.connectionEnded(lived: 5); XCTAssertEqual(b.next, 4)
        b.connectionEnded(lived: 5.1); XCTAssertEqual(b.next, 1)
    }

    func testCloseActions() {
        XCTAssertEqual(SocketCloseAction(code: 4000), .replaced)
        XCTAssertEqual(SocketCloseAction(code: 4001), .reconnect)
        XCTAssertEqual(SocketCloseAction(code: 4003), .signedOut)
        XCTAssertEqual(SocketCloseAction(code: 1009), .shrinkAndReconnect)
        XCTAssertEqual(SocketCloseAction(code: 1006), .reconnect)
        XCTAssertEqual(SocketCloseAction(code: nil), .reconnect)
    }
}
