import XCTest
@testable import Slopify

/// Add to playlist with songs already there (API.md 8.2).
final class PlaylistAddLogicTests: XCTestCase {
    func testDuplicatesAreTheOnesThereAndRepeatsInTheBatch() {
        XCTAssertEqual(PlaylistAdd.duplicates(["a", "b", "c", "b", "a"], existing: ["c"]), [false, false, true, true, true])
        XCTAssertEqual(PlaylistAdd.duplicates(["a", "b"], existing: []), [false, false])
    }

    func testEachDuplicateIsAskedAndNewOnesAlwaysGoIn() async {
        let ids = ["a", "x", "b", "y"]
        var asked: [(Int, Int)] = []
        let r = await PlaylistAdd.resolve(ids, duplicates: [false, true, false, true]) { i, left in
            asked.append((i, left)); return .init(add: i == 3)
        }
        XCTAssertEqual(asked.map(\.0), [1, 3])
        XCTAssertEqual(asked.map(\.1), [2, 1])
        XCTAssertEqual(r.kept, ["a", "b", "y"])
        XCTAssertEqual(r.skipped, 1)
    }

    func testDoThisForAllStopsAsking() async {
        let ids = ["x", "y", "a", "z"]
        var asked = 0
        let skip = await PlaylistAdd.resolve(ids, duplicates: [true, true, false, true]) { _, _ in asked += 1; return .init(add: false, forAll: true) }
        XCTAssertEqual(asked, 1)
        XCTAssertEqual(skip.kept, ["a"]); XCTAssertEqual(skip.skipped, 3)
        asked = 0
        let add = await PlaylistAdd.resolve(ids, duplicates: [true, true, false, true]) { i, _ in asked += 1; return .init(add: true, forAll: i == 1) }
        XCTAssertEqual(asked, 2)
        XCTAssertEqual(add.kept, ids); XCTAssertEqual(add.skipped, 0)
    }

    func testToast() {
        XCTAssertEqual(PlaylistAdd.toast(added: 3, skipped: 0, name: "Road"), "Added to Road")
        XCTAssertEqual(PlaylistAdd.toast(added: 0, skipped: 2, name: "Road"), "Already in Road")
        XCTAssertEqual(PlaylistAdd.toast(added: 12, skipped: 3, name: "Road"), "Added 12 to Road, skipped 3 already there")
    }
}

/// The shared path: asks the server what is there, asks about duplicates, posts only what is kept.
@MainActor
final class PlaylistAddStoreTests: XCTestCase {
    final class PlaylistAddStub: URLProtocol {
        nonisolated(unsafe) static var existing: [String] = []
        nonisolated(unsafe) static var calls: [(path: String, ids: [String])] = []
        override class func canInit(with request: URLRequest) -> Bool { true }
        override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
        override func startLoading() {
            let path = request.url?.path ?? ""
            var body = "{}"
            if request.httpMethod == "POST" {
                let data = request.httpBody ?? request.httpBodyStream.map { s in
                    s.open(); defer { s.close() }
                    var d = Data(); var buf = [UInt8](repeating: 0, count: 4096)
                    while s.hasBytesAvailable { let n = s.read(&buf, maxLength: buf.count); if n <= 0 { break }; d.append(buf, count: n) }
                    return d
                } ?? Data()
                let ids = ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])?["trackIds"] as? [String] ?? []
                Self.calls.append((path, ids))
                if path.hasSuffix("/contains") {
                    let ex = ids.filter { Self.existing.contains($0) }
                    body = String(data: try! JSONSerialization.data(withJSONObject: ["ids": Array(NSOrderedSet(array: ex)) as! [String]]), encoding: .utf8)!
                } else { body = #"{"ok":true}"# }
            } else if path.hasSuffix("/api/playlists") {
                body = #"{"items":[]}"#
            }
            let r = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: r, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(body.utf8))
            client?.urlProtocolDidFinishLoading(self)
        }
        override func stopLoading() {}
    }

    private func track(_ id: String) -> Track {
        Track(id: id, title: "Song \(id)", artist: "A", artists: ["A"], artistIds: [], albumId: "al", album: "Al", albumArtist: "A",
              trackNo: nil, discNo: nil, year: nil, genres: nil, durationMs: 1000, codec: nil, bitrate: nil, cover: nil, format: nil, gain: nil, addedAt: nil, plays: nil)
    }

    private func playlist() throws -> Playlist {
        try JSONDecoder().decode(Playlist.self, from: Data(#"{"id":"pl_1","name":"Road","userId":"u","created":1,"updated":1,"trackCount":2,"cover":null,"aiPrompt":null}"#.utf8))
    }

    private func makeStore() -> (LibraryStore, APIClient) {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [PlaylistAddStub.self]
        let api = APIClient(baseURL: URL(string: "https://example.invalid")!, token: "t", session: URLSession(configuration: cfg))
        let store = LibraryStore()
        store.attach(api: api, userId: "test-\(UUID().uuidString)")
        return (store, api)
    }

    func testAsksAboutEachDuplicateAndPostsOnlyWhatIsKept() async throws {
        PlaylistAddStub.existing = ["b"]; PlaylistAddStub.calls = []
        let (store, api) = makeStore()
        defer { withExtendedLifetime(api) {} }
        var asked: [(String, Bool)] = []
        store.askDuplicate = { t, p, showAll in
            XCTAssertEqual(p.name, "Road")
            asked.append((t.title, showAll))
            return .init(add: t.id == "a") // the second "a" goes in again, "b" does not
        }
        let ok = await store.add([track("a"), track("b"), track("c"), track("a")], to: try playlist())
        XCTAssertTrue(ok)
        XCTAssertEqual(asked.map(\.0), ["Song b", "Song a"])
        XCTAssertEqual(asked.map(\.1), [true, false]) // "Do this for all" only while more than one is left
        let posts = PlaylistAddStub.calls.filter { !$0.path.hasSuffix("/api/playlists") }
        XCTAssertEqual(posts.map(\.path), ["/api/playlists/pl_1/contains", "/api/playlists/pl_1/tracks"])
        XCTAssertEqual(posts[0].ids, ["a", "b", "c", "a"])
        XCTAssertEqual(posts[1].ids, ["a", "c", "a"])
        XCTAssertEqual(store.revision["pl_1"], 1)
    }

    func testNoDuplicatesNoQuestionAndAllSkippedNoPost() async throws {
        PlaylistAddStub.existing = ["b"]; PlaylistAddStub.calls = []
        let (store, api) = makeStore()
        defer { withExtendedLifetime(api) {} }
        var asked = 0
        store.askDuplicate = { _, _, _ in asked += 1; return .init(add: false) }
        await store.add([track("a"), track("c")], to: try playlist())
        XCTAssertEqual(asked, 0)
        XCTAssertEqual(PlaylistAddStub.calls.last { $0.path.hasSuffix("/tracks") }?.ids, ["a", "c"])
        PlaylistAddStub.calls = []
        await store.add([track("b")], to: try playlist())
        XCTAssertEqual(asked, 1)
        XCTAssertTrue(PlaylistAddStub.calls.allSatisfy { !$0.path.hasSuffix("/tracks") })
        XCTAssertEqual(store.revision["pl_1"], 1) // only the first add changed it
    }
}
