import XCTest
@testable import Slopify

/// Frames copied from API.md §20.4 / §20.5 (placeholders filled in).
final class SocketMessageTests: XCTestCase {
    static let nowPlayingJSON = #"""
    { "itemId": "0f6c", "title": "Paranoid Android", "artist": "Radiohead", "album": "OK Computer",
      "artUrl": "https://music.example.com/api/image/0f6c?size=128&token=x", "albumId": "1a2b", "artistId": "a9b8",
      "artists": [{ "Id": "a9b8", "Name": "Radiohead" }], "liked": true,
      "device": { "id": "local", "kind": "local", "name": "iPhone 16" }, "queueIndex": 3,
      "playing": true, "held": false, "position": 81.42, "duration": 383.0, "volume": 80, "repeat": "off", "shuffle": "off",
      "at": 1762800000000, "serverAt": 1762800000031 }
    """#
    static let queueItemJSON = #"""
    { "Id": "0f6c", "Name": "Paranoid Android", "Artists": ["Radiohead"], "AlbumArtist": "Radiohead", "Album": "OK Computer",
      "AlbumId": "1a2b", "RunTimeTicks": 3830000000,
      "ArtistItems": [{ "Id": "a9b8", "Name": "Radiohead" }], "AlbumArtists": [{ "Id": "a9b8", "Name": "Radiohead" }],
      "UserData": { "IsFavorite": true }, "_queued": false, "_gain": { "track": -6.3, "album": -5.8 } }
    """#

    func testHelloOk() {
        let m = SocketMessage.parse(#"{ "type": "hello-ok", "clientId": "c_k3j2h1", "userId": "3f2a", "offsets": { "cast:abc": 0.12 }, "now": 1762800000000, "sleep": { "at": 1762803600000, "endOfTrack": false }, "web": "assets/index-abc123.js" }"#)
        XCTAssertEqual(m, .helloOk(.init(clientId: "c_k3j2h1", userId: "3f2a", offsets: ["cast:abc": 0.12], now: 1762800000000,
                                         sleep: .init(at: 1762803600000, endOfTrack: false))))
        guard case let .helloOk(h)? = SocketMessage.parse(#"{"type":"hello-ok","clientId":"c_x","sleep":null}"#) else { return XCTFail() }
        XCTAssertNil(h.sleep); XCTAssertEqual(h.offsets, [:])
    }

    func testPong() {
        XCTAssertEqual(SocketMessage.parse(#"{ "type": "pong", "now": 5, "t": 3 }"#), .pong(now: 5, t: 3))
    }

    func testRoster() {
        let json = #"""
        { "type": "roster",
          "players": [
            { "id": "c_desktop1", "name": "Lukas MacBook", "kind": "desktop", "form": "laptop", "canPlay": true, "nowPlaying": \#(Self.nowPlayingJSON), "sameNetwork": true },
            { "id": "server:3f2a", "name": "Home speakers", "kind": "server", "form": null, "canPlay": false, "nowPlaying": null, "sameNetwork": true },
            { "broken": true }
          ],
          "lanDevices": [
            { "id": "bluos:192.168.1.20", "kind": "bluos", "name": "Node", "model": "NODE 2i", "host": "192.168.1.20", "port": 11000,
              "group": ["bluos:192.168.1.20", "bluos:192.168.1.21"],
              "state": { "volume": 30, "muted": false, "state": "pause", "playing": false, "title": null, "artist": null, "album": null, "image": null, "input": null, "inputs": [{ "id": "x", "name": "TV" }] },
              "viaClient": "server:3f2a" },
            { "id": "tv:192.168.1.50", "kind": "tv", "name": "Living Room TV", "model": "Slopify TV", "host": "192.168.1.50", "port": 7781, "viaClient": "server:3f2a" }
          ],
          "activeClientId": "c_desktop1" }
        """#
        guard case let .roster(r)? = SocketMessage.parse(json) else { return XCTFail("no roster") }
        XCTAssertEqual(r.players.map(\.id), ["c_desktop1", "server:3f2a"])
        XCTAssertTrue(r.players[1].isServer)
        XCTAssertEqual(r.players[0].nowPlaying?.position, 81.42)
        XCTAssertEqual(r.players[0].nowPlaying?.serverAt, 1762800000031)
        XCTAssertEqual(r.lanDevices.count, 2)
        XCTAssertEqual(r.lanDevices[0].state?.volume, 30)
        XCTAssertEqual(r.lanDevices[0].group?.count, 2)
        XCTAssertEqual(r.activeClientId, "c_desktop1")
        guard case let .roster(empty)? = SocketMessage.parse(#"{"type":"roster","players":[],"lanDevices":[],"activeClientId":null}"#) else { return XCTFail() }
        XCTAssertNil(empty.activeClientId)
    }

    func testQueueAndSession() {
        guard case let .queue(from, q)? = SocketMessage.parse(#"{ "type": "queue", "from": "c_a", "queue": [\#(Self.queueItemJSON)] }"#) else { return XCTFail() }
        XCTAssertEqual(from, "c_a"); XCTAssertEqual(q?.first?.RunTimeTicks, 3830000000); XCTAssertEqual(q?.first?._gain?.track, -6.3)
        XCTAssertEqual(SocketMessage.parse(#"{ "type": "queue", "from": "c_a", "queue": null }"#), .queue(from: "c_a", queue: nil))
        guard case let .session(np, sq, at)? = SocketMessage.parse(#"{ "type": "session", "nowPlaying": \#(Self.nowPlayingJSON), "queue": [\#(Self.queueItemJSON)], "at": 1762800000000 }"#) else { return XCTFail() }
        XCTAssertEqual(np.itemId, "0f6c"); XCTAssertEqual(sq.count, 1); XCTAssertEqual(at, 1762800000000)
    }

    func testCommandLikePrefsSleepOffset() {
        XCTAssertEqual(SocketMessage.parse(#"{ "type": "command", "from": "server", "command": { "action": "setPlaying", "playing": false } }"#),
                       .command(.setPlaying(false), from: "server"))
        XCTAssertEqual(SocketMessage.parse(#"{ "type": "command", "from": "c_b", "command": { "action": "yield" } }"#), .command(.yield, from: "c_b"))
        XCTAssertEqual(SocketMessage.parse(#"{ "type": "like", "itemId": "t1", "liked": true, "at": 1 }"#), .like(itemId: "t1", liked: true))
        XCTAssertEqual(SocketMessage.parse(#"{ "type": "prefs", "prefs": { "_libraryLayout": "r7", "theme": { "a": 1 } } }"#),
                       .prefs(["_libraryLayout": .string("r7"), "theme": .object(["a": .number(1)])]))
        XCTAssertEqual(SocketMessage.parse(#"{ "type": "sleep", "sleep": { "at": null, "endOfTrack": true } }"#), .sleep(.init(at: nil, endOfTrack: true)))
        XCTAssertEqual(SocketMessage.parse(#"{ "type": "sleep", "sleep": null }"#), .sleep(nil))
        XCTAssertEqual(SocketMessage.parse(#"{ "type": "offset", "id": "cast:abc", "offset": 0.2 }"#), .offset(id: "cast:abc", offset: 0.2))
        XCTAssertEqual(SocketMessage.parse(#"{ "type": "offset", "id": "cast:abc", "offset": null }"#), .offset(id: "cast:abc", offset: nil))
    }

    func testIgnoredFrames() {
        XCTAssertEqual(SocketMessage.parse(#"{ "type": "future-thing", "x": 1 }"#), .unknown("future-thing"))
        XCTAssertNil(SocketMessage.parse("[1,2]"))
        XCTAssertNil(SocketMessage.parse("not json"))
        XCTAssertNil(SocketMessage.parse(#"{ "type": "pong" }"#))
    }

    // MARK: outgoing

    private func obj(_ m: SocketOutgoing) throws -> [String: Any] {
        try JSONSerialization.jsonObject(with: m.data()) as! [String: Any]
    }

    func testOutgoingShapes() throws {
        let h = try obj(.hello(.init(token: "tok", clientId: "c_1234", instance: "i_x", name: "iPhone", kind: "phone", form: "phone", canPlay: true)))
        XCTAssertEqual(h["type"] as? String, "hello"); XCTAssertEqual(h["token"] as? String, "tok")
        XCTAssertEqual(h["kind"] as? String, "phone"); XCTAssertEqual(h["canPlay"] as? Bool, true)
        let nilNp = try obj(.nowPlaying(nil))
        XCTAssertEqual(nilNp["type"] as? String, "nowplaying"); XCTAssertTrue(nilNp["nowPlaying"] is NSNull)
        XCTAssertEqual(try obj(.claim(reassertAgo: nil)).count, 1)
        let re = try obj(.claim(reassertAgo: 1234.4))
        XCTAssertEqual(re["reassert"] as? Bool, true); XCTAssertEqual(re["ago"] as? Double, 1234)
        let cmd = try obj(.command(.seek(pos: 4), to: "c_b"))
        XCTAssertEqual(cmd["to"] as? String, "c_b"); XCTAssertEqual((cmd["command"] as? [String: Any])?["action"] as? String, "seek")
        XCTAssertEqual(try obj(.sleep(.minutes(5000)))["minutes"] as? Int, 1440)
        XCTAssertEqual(try obj(.sleep(.minutes(0)))["minutes"] as? Int, 1)
        XCTAssertEqual(try obj(.sleep(.endOfTrack))["endOfTrack"] as? Bool, true)
        let done = try obj(.sleep(.done)); XCTAssertEqual(done["off"] as? Bool, true); XCTAssertEqual(done["done"] as? Bool, true)
        XCTAssertEqual(try obj(.sleep(.off)).count, 2)
        XCTAssertEqual((try obj(.prefs(["a": .bool(true)]))["prefs"] as? [String: Any])?["a"] as? Bool, true)
    }

    func testIdentity() {
        let d = UserDefaults(suiteName: "SocketMessageTests.\(UUID().uuidString)")!
        let id = SocketIdentity.clientId(d)
        XCTAssertTrue(id.hasPrefix("c_")); XCTAssertTrue(SocketIdentity.isValid(id))
        XCTAssertEqual(SocketIdentity.clientId(d), id)
        d.set("server:abc", forKey: SocketIdentity.defaultsKey)
        XCTAssertNotEqual(SocketIdentity.clientId(d), "server:abc")
        XCTAssertFalse(SocketIdentity.isValid("abc")); XCTAssertFalse(SocketIdentity.isValid("c_é1234"))
        XCTAssertTrue(SocketIdentity.isValid("c_A-b_9"))
        XCTAssertTrue(SocketIdentity.instance.hasPrefix("i_"))
        XCTAssertEqual(SocketIdentity.webSocketURL(base: URL(string: "https://music.example.com")!).absoluteString, "wss://music.example.com/api/ws")
        XCTAssertEqual(SocketIdentity.webSocketURL(base: URL(string: "http://192.168.1.85:8080")!).absoluteString, "ws://192.168.1.85:8080/api/ws")
    }
}
