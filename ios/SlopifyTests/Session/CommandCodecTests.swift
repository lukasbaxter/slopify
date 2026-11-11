import XCTest
@testable import Slopify

final class CommandCodecTests: XCTestCase {
    private func roundTrip(_ c: Command, file: StaticString = #filePath, line: UInt = #line) throws -> [String: Any] {
        let data = try JSONEncoder().encode(c)
        let back = try JSONDecoder().decode(Command.self, from: data)
        XCTAssertEqual(back, c, file: file, line: line)
        return try JSONSerialization.jsonObject(with: data) as! [String: Any]
    }

    func testEveryActionRoundTrips() throws {
        let transfer = Command.Transfer(trackIds: ["a", "b"], queued: [false, true], index: 1, position: 12.5,
                                        playing: true, ctx: "pl_1", original: ["b", "a"], deviceId: "local")
        let all: [(Command, String)] = [
            (.play(trackIds: ["a"], index: 0, ctx: "alb", startAt: 3.5), "play"),
            (.play(trackIds: ["a", "b"], index: 1, ctx: nil, startAt: nil), "play"),
            (.transfer(transfer), "transfer"),
            (.enqueue(trackIds: ["x"]), "enqueue"),
            (.queueRemove(index: 4), "queueRemove"),
            (.queueMove(from: 1, to: 3), "queueMove"),
            (.queueClear, "queueClear"),
            (.skipTo(index: 2), "skipTo"),
            (.toggle, "toggle"),
            (.setPlaying(false), "setPlaying"),
            (.seek(pos: 81.42), "seek"),
            (.setVolume(level: 80), "setVolume"),
            (.volumeStep(-1), "volumeStep"),
            (.next, "next"),
            (.previous, "previous"),
            (.setRepeat("one"), "setRepeat"),
            (.setShuffle("smart"), "setShuffle"),
            (.patchLiked(itemId: "t1", liked: true), "patchLiked"),
            (.yield, "yield"),
            (.unknown("dance"), "dance"),
        ]
        for (c, action) in all {
            let obj = try roundTrip(c)
            XCTAssertEqual(obj["action"] as? String, action)
        }
    }

    func testFlatWireKeys() throws {
        let t = try roundTrip(.transfer(.init(trackIds: ["a"], queued: nil, index: 0, position: 1, playing: false,
                                              ctx: nil, original: nil, deviceId: "bluos:1")))
        XCTAssertEqual(t["deviceId"] as? String, "bluos:1")
        XCTAssertEqual(t["position"] as? Double, 1)
        XCTAssertEqual(try roundTrip(.seek(pos: 2))["pos"] as? Double, 2)
        XCTAssertEqual(try roundTrip(.setVolume(level: 3))["level"] as? Double, 3)
        XCTAssertEqual(try roundTrip(.volumeStep(1))["step"] as? Int, 1)
        XCTAssertEqual(try roundTrip(.setRepeat("all"))["mode"] as? String, "all")
        XCTAssertEqual(try roundTrip(.setPlaying(true))["playing"] as? Bool, true)
        let mv = try roundTrip(.queueMove(from: 5, to: 6))
        XCTAssertEqual(mv["from"] as? Int, 5); XCTAssertEqual(mv["to"] as? Int, 6)
    }

    func testDecodesWebShapes() throws {
        let json = #"{"action":"transfer","trackIds":["a","b"],"queued":[false,false],"index":1,"position":81.4,"playing":true,"ctx":"artist:a9","original":["a","b"],"deviceId":"local"}"#
        let c = try JSONDecoder().decode(Command.self, from: Data(json.utf8))
        guard case let .transfer(t) = c else { return XCTFail("not transfer") }
        XCTAssertEqual(t.index, 1); XCTAssertEqual(t.position, 81.4); XCTAssertEqual(t.ctx, "artist:a9")
        let play = try JSONDecoder().decode(Command.self, from: Data(#"{"action":"play","trackIds":["a"]}"#.utf8))
        XCTAssertEqual(play, .play(trackIds: ["a"], index: 0, ctx: nil, startAt: nil))
        let ctxNull = try JSONDecoder().decode(Command.self, from: Data(#"{"action":"play","trackIds":["a"],"index":0,"ctx":null}"#.utf8))
        XCTAssertEqual(ctxNull, .play(trackIds: ["a"], index: 0, ctx: nil, startAt: nil))
    }
}
