import XCTest
@testable import Slopify

final class SocketClockTests: XCTestCase {
    private func np(playing: Bool = true, held: Bool? = nil, position: Double = 10, serverAt: Double? = nil) -> NowPlaying {
        NowPlaying(itemId: "t", title: "T", artist: "A", playing: playing, held: held, position: position, serverAt: serverAt)
    }

    func testPongPicksShortRoundTrips() {
        var c = SocketClock()
        c.pong(now: 5000, t: 1000, localNow: 1100)            // rtt 100
        XCTAssertEqual(c.offset, 3950); XCTAssertEqual(c.bestRtt, 100)
        c.pong(now: 9000, t: 2000, localNow: 2200)            // rtt 200 > 100 + 15: ignored
        XCTAssertEqual(c.offset, 3950)
        c.pong(now: 6000, t: 2000, localNow: 2110)            // rtt 110 within slack: taken
        XCTAssertEqual(c.offset, 6000 - 2055); XCTAssertEqual(c.bestRtt, 100)
        c.pong(now: 6000, t: 3000, localNow: 2990)            // negative rtt: ignored
        XCTAssertEqual(c.offset, 6000 - 2055)
    }

    func testHelloOkOnlyWhenUnknown() {
        var c = SocketClock()
        c.helloOk(now: 10_000, localNow: 2000, openedAt: 1800) // rtt 200
        XCTAssertEqual(c.offset, 10_000 - (2000 - 100)); XCTAssertEqual(c.bestRtt, 200)
        c.helloOk(now: 99_999, localNow: 3000, openedAt: 2900)
        XCTAssertEqual(c.offset, 8100)
        XCTAssertEqual(c.serverNow(localNow: 100), 8200)
    }

    func testPlayheadFrozenWhenPausedOrHeld() {
        var c = SocketClock(); c.pong(now: 1000, t: 0, localNow: 0)
        XCTAssertEqual(c.playhead(np(playing: false, serverAt: 0), rxAt: 0, localNow: 50_000), 10)
        XCTAssertEqual(c.playhead(np(held: true, serverAt: 0), rxAt: 0, localNow: 50_000), 10)
    }

    func testPlayheadUsesServerClock() {
        var c = SocketClock()
        c.pong(now: 100_000, t: 1000, localNow: 1000)          // offset 99_000
        // serverNow = 3000 + 99_000 = 102_000, reported at 100_500 -> 1.5 s later
        XCTAssertEqual(c.playhead(np(serverAt: 100_500), rxAt: 0, localNow: 3000), 11.5, accuracy: 1e-9)
        // Report stamped "in the future" never moves the playhead back.
        XCTAssertEqual(c.playhead(np(serverAt: 200_000), rxAt: nil, localNow: 3000), 10)
    }

    func testPlayheadFallsBackToReceiptTime() {
        let c = SocketClock()                                  // no offset yet
        XCTAssertEqual(c.playhead(np(serverAt: 1), rxAt: 1000, localNow: 3500), 12.5, accuracy: 1e-9)
        XCTAssertEqual(c.playhead(np(), rxAt: nil, localNow: 3500), 10)
    }
}
