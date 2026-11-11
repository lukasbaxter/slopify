import XCTest
@testable import Slopify

final class FakeSocket: SocketTransport, @unchecked Sendable {
    let url: URL
    let events: AsyncStream<SocketConnection.Event>
    private let cont: AsyncStream<SocketConnection.Event>.Continuation
    var started = false, closed = false
    var sent: [[String: Any]] = []
    init(url: URL) { self.url = url; (events, cont) = AsyncStream.makeStream() }
    func start() { started = true }
    func send(_ data: Data) { sent.append(try! JSONSerialization.jsonObject(with: data) as! [String: Any]) }
    func close() { closed = true; cont.finish() }
    var types: [String] { sent.compactMap { $0["type"] as? String } }
}

@MainActor
final class SessionClientTests: XCTestCase {
    var sockets: [FakeSocket] = []
    var client: SessionClient!

    override func setUp() async throws {
        sockets = []
        let d = UserDefaults(suiteName: "SessionClientTests.\(UUID().uuidString)")!
        client = SessionClient(defaults: d, makeSocket: { [unowned self] url in
            let s = FakeSocket(url: url); self.sockets.append(s); return s
        })
    }

    private var sock: FakeSocket { sockets.last! }
    private func helloOk(_ id: String = "c_server_given") {
        client.handle(.message(.helloOk(.init(clientId: id, userId: "u", offsets: ["cast:a": 0.1], now: 1_000, sleep: nil))))
    }
    private func np(playing: Bool = true) -> NowPlaying {
        NowPlaying(itemId: "t", title: "T", artist: "A", playing: playing, position: 5)
    }

    func testHelloFirstAndDropsBeforeHelloOk() throws {
        client.connect(base: URL(string: "https://music.example.com")!, token: "tok")
        XCTAssertEqual(sock.url.absoluteString, "wss://music.example.com/api/ws")
        XCTAssertTrue(sock.started)
        XCTAssertEqual(client.connection, .connecting)
        client.send(.toggle, to: "c_b")                    // not open yet: dropped
        client.handle(.open)
        XCTAssertEqual(sock.types, ["hello"])
        let h = sock.sent[0]
        XCTAssertEqual(h["token"] as? String, "tok"); XCTAssertEqual(h["kind"] as? String, "phone")
        XCTAssertEqual(h["canPlay"] as? Bool, true); XCTAssertTrue(["phone", "tablet"].contains(h["form"] as? String ?? ""))
        XCTAssertEqual(h["clientId"] as? String, client.clientId)
        client.sendPrefs(["a": .bool(true)])               // before hello-ok: dropped
        XCTAssertEqual(sock.types, ["hello"])
        helloOk()
        XCTAssertEqual(client.connection, .connected)
        XCTAssertEqual(client.clientId, "c_server_given")
        XCTAssertEqual(client.offsets, ["cast:a": 0.1])
        client.send(.toggle, to: "c_b")
        XCTAssertEqual(sock.types, ["hello", "command"])
        XCTAssertEqual(sock.sent[1]["to"] as? String, "c_b")
    }

    func testConnectIsIdempotent() {
        let base = URL(string: "http://h.test")!
        client.connect(base: base, token: "t")
        client.connect(base: base, token: "t")
        XCTAssertEqual(sockets.count, 1)
        client.connect(base: base, token: "t2")
        XCTAssertEqual(sockets.count, 2); XCTAssertTrue(sockets[0].closed)
    }

    func testClaimReassertAndYield() {
        let base = URL(string: "http://h.test")!
        client.connect(base: base, token: "t"); client.handle(.open); helloOk()
        client.claim()
        XCTAssertEqual(sock.types.last, "claim"); XCTAssertNil(sock.sent.last?["reassert"])
        XCTAssertTrue(client.claimState.claimed)
        client.report(np()); client.publishQueue([])
        // Network drop, reconnect: claim reasserted first, then the last nowplaying.
        client.handle(.closed(code: 1006))
        XCTAssertEqual(client.connection, .disconnected)
        client.connect(base: base, token: "t")             // foreground-style prompt reconnect
        XCTAssertEqual(sockets.count, 2)
        client.handle(.open); helloOk()
        XCTAssertEqual(Array(sock.types.prefix(3)), ["hello", "claim", "nowplaying"])
        XCTAssertEqual(sock.sent[1]["reassert"] as? Bool, true)
        XCTAssertGreaterThanOrEqual(sock.sent[1]["ago"] as? Double ?? -1, 0)
        // Someone else takes over.
        var got: [(Command, String)] = []
        client.onCommand = { got.append(($0, $1)) }
        client.handle(.message(.command(.yield, from: "c_other")))
        XCTAssertEqual(got.first?.0, .yield); XCTAssertEqual(got.first?.1, "c_other")
        XCTAssertFalse(client.claimState.claimed)
        XCTAssertEqual(client.activeClientId, "c_other")
        // Mirror now: reports are dropped, and a reconnect does not reassert.
        let before = sock.sent.count
        client.report(np())
        XCTAssertEqual(sock.sent.count, before)
        client.handle(.closed(code: nil))
        client.connect(base: base, token: "t"); client.handle(.open); helloOk()
        XCTAssertEqual(sock.types, ["hello"])
    }

    func testReportGating() {
        client.connect(base: URL(string: "http://h.test")!, token: "t"); client.handle(.open); helloOk()
        client.report(np())                                // nobody active: allowed
        XCTAssertEqual(sock.types.last, "nowplaying")
        client.handle(.message(.roster(.init(players: [], lanDevices: [], activeClientId: "c_other"))))
        let n = sock.sent.count
        client.report(np()); client.report(nil)
        XCTAssertEqual(sock.sent.count, n)
        client.handle(.message(.roster(.init(players: [], lanDevices: [], activeClientId: client.clientId))))
        XCTAssertTrue(client.isActiveHere)
        client.report(nil)
        XCTAssertEqual(sock.types.last, "nowplaying"); XCTAssertTrue(sock.sent.last?["nowPlaying"] is NSNull)
    }

    func testCloseCodes() {
        let base = URL(string: "http://h.test")!
        var signedOut = 0
        client.onSignedOut = { signedOut += 1 }
        client.connect(base: base, token: "t"); client.handle(.open); helloOk()
        client.handle(.closed(code: 4000))                 // replaced: no retry scheduled
        XCTAssertEqual(client.connection, .disconnected)
        XCTAssertEqual(client.backoff.next, 1)
        client.connect(base: base, token: "t"); client.handle(.open)
        client.handle(.closed(code: 4003))
        XCTAssertEqual(signedOut, 1)
        // Stopped: the same connect is a fresh start, but nothing reconnects by itself.
        XCTAssertEqual(sockets.count, 2)
    }

    func testBackoffGrowsOnFailures() {
        client.connect(base: URL(string: "http://h.test")!, token: "t")
        client.handle(.closed(code: nil))                  // never opened
        XCTAssertEqual(client.backoff.next, 2)
    }

    func testMoveReconnectsSameIdentity() {
        client.connect(base: URL(string: "https://main.test")!, token: "t"); client.handle(.open); helloOk("c_kept")
        client.move(to: URL(string: "http://192.168.1.2:8080")!)
        XCTAssertTrue(sockets[0].closed)
        XCTAssertEqual(sock.url.absoluteString, "ws://192.168.1.2:8080/api/ws")
        client.handle(.open)
        XCTAssertEqual(sock.sent[0]["clientId"] as? String, "c_kept")
        XCTAssertEqual(sock.sent[0]["instance"] as? String, sockets[0].sent[0]["instance"] as? String)
        client.move(to: URL(string: "http://192.168.1.2:8080")!)
        XCTAssertEqual(sockets.count, 2)
    }

    func testStateFromServer() {
        client.connect(base: URL(string: "http://h.test")!, token: "t"); client.handle(.open); helloOk()
        var likes: [String] = [], prefs: [[String: JSONValue]] = []
        client.onLike = { id, _ in likes.append(id) }
        client.onPrefs = { prefs.append($0) }
        var remote = np(); remote.serverAt = 1
        client.handle(.message(.roster(.init(players: [RosterPlayer(id: "c_b", name: "B", nowPlaying: remote)], lanDevices: [], activeClientId: "c_b"))))
        XCTAssertEqual(client.remoteActive?.id, "c_b")
        XCTAssertGreaterThanOrEqual(client.playhead(remote), 5)
        client.handle(.message(.queue(from: "c_b", queue: [])))
        XCTAssertNotNil(client.queues["c_b"])
        client.handle(.message(.queue(from: "c_b", queue: nil)))
        XCTAssertNil(client.queues["c_b"])
        client.handle(.message(.session(nowPlaying: np(playing: false), queue: [], at: 7)))
        XCTAssertEqual(client.lastSession?.at, 7)
        client.handle(.message(.sleep(.init(at: 9, endOfTrack: false))))
        XCTAssertEqual(client.sleep?.at, 9)
        client.handle(.message(.sleep(nil)))
        XCTAssertNil(client.sleep)
        client.handle(.message(.offset(id: "cast:a", offset: nil)))
        XCTAssertEqual(client.offsets, [:])
        client.handle(.message(.like(itemId: "x", liked: true)))
        client.handle(.message(.prefs(["k": .null])))
        XCTAssertEqual(likes, ["x"]); XCTAssertEqual(prefs.count, 1)
        client.disconnect()
        XCTAssertEqual(client.players, []); XCTAssertEqual(client.connection, .disconnected)
    }

    func testSleepMessages() {
        client.connect(base: URL(string: "http://h.test")!, token: "t"); client.handle(.open); helloOk()
        client.setSleep(minutes: 30); client.setSleep(minutes: nil); client.setSleepEndOfTrack(); client.sleepDone()
        let s = sock.sent.suffix(4)
        XCTAssertEqual(s.map { $0["type"] as? String }, ["sleep", "sleep", "sleep", "sleep"])
        XCTAssertEqual(s[s.startIndex]["minutes"] as? Int, 30)
        XCTAssertEqual(s[s.startIndex + 1]["off"] as? Bool, true)
        XCTAssertEqual(s[s.startIndex + 2]["endOfTrack"] as? Bool, true)
        XCTAssertEqual(s[s.startIndex + 3]["done"] as? Bool, true)
    }

    func testQueueDebounced() async throws {
        client.connect(base: URL(string: "http://h.test")!, token: "t"); client.handle(.open); helloOk()
        let json = #"[{"Id":"a"},{"Id":"b"}]"#
        let q = try JSONDecoder().decode([QueueItem].self, from: Data(json.utf8))
        client.publishQueue(q); client.publishQueue(q)
        XCTAssertFalse(sock.types.contains("queue"))
        try await Task.sleep(for: .milliseconds(800))
        XCTAssertEqual(sock.types.filter { $0 == "queue" }.count, 1)
    }

    func testRepeatsPlayingReport() async throws {
        client.connect(base: URL(string: "http://h.test")!, token: "t"); client.handle(.open); helloOk()
        client.report(np())
        try await Task.sleep(for: .milliseconds(2300))
        let reports = sock.sent.filter { $0["type"] as? String == "nowplaying" }
        XCTAssertEqual(reports.count, 2)
        let pos = (reports[1]["nowPlaying"] as? [String: Any])?["position"] as? Double ?? 0
        XCTAssertGreaterThan(pos, 6.5)                     // advanced ~2 s from 5
        client.report(np(playing: false))
        try await Task.sleep(for: .milliseconds(2300))
        XCTAssertEqual(sock.sent.filter { $0["type"] as? String == "nowplaying" }.count, 3)
    }
}
