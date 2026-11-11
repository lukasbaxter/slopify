import XCTest
@testable import Slopify

/// Canned server answers (JSON shapes from API.md §6, §8, §14.2, §15.3); no real server.
final class HomeStubProtocol: URLProtocol {
    nonisolated(unsafe) static var bodies: [String: String] = [:]
    nonisolated(unsafe) static var failing: Set<String> = []
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let path = request.url?.path ?? ""
        let fail = Self.failing.contains(path)
        let body = fail ? #"{"error":"boom"}"# : (Self.bodies[path] ?? "{}")
        let r = HTTPURLResponse(url: request.url!, statusCode: fail ? 500 : 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: r, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@MainActor
final class HomeStoreTests: XCTestCase {
    private func track(_ id: String, _ artist: String, _ artistId: String, plays: Int) -> String {
        #"{"id":"\#(id)","title":"T","artist":"\#(artist)","artists":["\#(artist)"],"artistIds":["\#(artistId)"],"albumId":"al","album":"A","albumArtist":"\#(artist)","trackNo":1,"discNo":1,"year":2020,"genres":[],"durationMs":1000,"codec":null,"bitrate":null,"cover":null,"format":null,"gain":{"track":null,"album":null},"identity":{"state":"matched","score":1},"addedAt":1,"plays":\#(plays)}"#
    }

    private func api() -> APIClient {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [HomeStubProtocol.self]
        return APIClient(baseURL: URL(string: "https://home.invalid")!, token: "t", session: URLSession(configuration: cfg))
    }

    override func setUp() {
        HomeStubProtocol.failing = []
        HomeStubProtocol.bodies = [
            "/api/home": #"{"recentAlbums":[{"id":"r1","name":"Recent","artist":"X","artistId":"x","year":2020,"trackCount":3,"cover":null}],"topTracks":[\#(track("1", "Low", "a", plays: 1)),\#(track("2", "High", "b", plays: 9))],"newestAlbums":[]}"#,
            "/api/top-songs": #"{"years":[{"year":2026,"songs":40,"plays":300,"top":null}]}"#,
            "/api/radar": #"{"releases":[{"album_id":"m1","title":"New","rtype":"EP","date":"2026-11-01","image":null,"artistId":"b","artistName":"High","inLibrary":null,"localName":null,"requestStatus":null}]}"#,
            "/api/playlists": #"{"items":[{"id":"pl_1","name":"Mine","userId":"u","created":1,"updated":1,"trackCount":2,"cover":null,"aiPrompt":null}]}"#,
            "/api/albums": #"{"items":[{"id":"l1","name":"Lib","artist":"Y","artistId":null,"year":null,"trackCount":1,"durationMs":1,"cover":null,"addedAt":1}],"total":1}"#,
            "/api/artists": #"{"items":[{"id":"z","name":"Zed","trackCount":1,"albumCount":1,"image":null,"banner":null}],"total":1}"#,
        ]
    }

    func testLoadFillsEverySectionInWebOrder() async {
        let store = HomeStore(); store.cacheDir = nil
        await store.load(api: api())
        XCTAssertEqual(store.data.topArtists.map(\.id), ["b", "a"])
        XCTAssertEqual(store.mixSeeds.map(\.id), ["b", "a"])
        XCTAssertEqual(store.shortcuts.map(\.id), ["__liked__", "al:r1", "pl:pl_1", "al:l1"])
        XCTAssertEqual(store.radarShelf.first?.artistName, "High")
        XCTAssertTrue(store.radarLoaded)
        // No last-played dates in /api/home: Jump back in stays hidden, as on the web.
        XCTAssertEqual(store.sections(.all), [.shortcuts, .madeForYou, .topSongs, .recent, .radar, .topArtists])
    }

    func testFailuresAreSilentAndKeepOldData() async {
        let store = HomeStore(); store.cacheDir = nil
        await store.load(api: api())
        HomeStubProtocol.failing = ["/api/home", "/api/radar"]
        await store.load(api: api())
        XCTAssertEqual(store.data.recent.map(\.id), ["r1"])
        XCTAssertEqual(store.data.radar.count, 1)
        XCTAssertNotNil(store.radarError)
    }

    func testKeptCopyPaintsFirstAndAccountsDoNotMix() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("home-test-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let a = HomeStore(); a.cacheDir = dir
        a.use(key: "srv|u1")
        await a.load(api: api())

        let b = HomeStore(); b.cacheDir = dir
        b.use(key: "srv|u1")
        XCTAssertEqual(b.data.recent.map(\.id), ["r1"])
        b.use(key: "srv|u2")
        XCTAssertTrue(b.data.recent.isEmpty)
    }

    func testNoMixesHidesMadeForYou() async {
        HomeStubProtocol.bodies["/api/home"] = #"{"recentAlbums":[],"topTracks":[],"newestAlbums":[]}"#
        HomeStubProtocol.bodies["/api/artists"] = #"{"items":[],"total":0}"#
        let store = HomeStore(); store.cacheDir = nil
        await store.load(api: api())
        XCTAssertFalse(store.sections(.all).contains(.madeForYou))
    }
}
