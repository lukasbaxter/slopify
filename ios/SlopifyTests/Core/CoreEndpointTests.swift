import XCTest
@testable import Slopify

/// Records every request and answers from a per-path table (JSON shapes from API.md).
final class CoreStubProtocol: URLProtocol {
    struct Seen { var method: String; var url: URL; var headers: [String: String]; var body: Data? }
    nonisolated(unsafe) static var seen: [Seen] = []
    nonisolated(unsafe) static var answers: [String: (Int, String)] = [:]

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        var body = request.httpBody
        if body == nil, let s = request.httpBodyStream {
            s.open(); defer { s.close() }
            var d = Data(); var buf = [UInt8](repeating: 0, count: 4096)
            while s.hasBytesAvailable { let n = s.read(&buf, maxLength: buf.count); if n <= 0 { break }; d.append(buf, count: n) }
            body = d
        }
        Self.seen.append(Seen(method: request.httpMethod ?? "GET", url: request.url!, headers: request.allHTTPHeaderFields ?? [:], body: body))
        let path = request.url?.path ?? ""
        let (status, json) = Self.answers.first { path.hasSuffix($0.key) }?.value ?? (200, "{}")
        let r = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: r, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(json.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}

    @MainActor static func client() -> APIClient {
        seen = []; answers = [:]
        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [CoreStubProtocol.self]
        return APIClient(baseURL: URL(string: "https://m.example.com")!, token: "T", session: URLSession(configuration: cfg))
    }
}

@MainActor
final class CoreEndpointTests: XCTestCase {
    /// Regression: `appendingPathComponent` split "R&B/Soul" into two segments (a 404).
    func testGenreNamesStayOneSegment() async throws {
        let api = CoreStubProtocol.client()
        CoreStubProtocol.answers = ["/tracks": (200, #"{"items":[]}"#), "/mix": (200, #"{"items":[]}"#),
                                    "Soul": (200, #"{"name":"R&B/Soul","topArtists":[],"albums":[],"recent":[]}"#)]
        _ = try await api.genre("R&B/Soul")
        _ = try await api.genreTracks("R&B/Soul")
        _ = try await api.genreMix("Hip Hop/Rap?")
        let urls = CoreStubProtocol.seen.map(\.url.absoluteString)
        XCTAssertEqual(urls[0], "https://m.example.com/api/genres/R&B%2FSoul")
        XCTAssertEqual(urls[1], "https://m.example.com/api/genres/R&B%2FSoul/tracks")
        XCTAssertEqual(urls[2], "https://m.example.com/api/genres/Hip%20Hop%2FRap%3F/mix")
    }

    func testPlainPathsAndQueriesUnchanged() {
        let api = APIClient(baseURL: URL(string: "https://m.example.com/sub")!, token: "T")
        XCTAssertEqual(api.url("api/albums/abc", ["limit": "2"]).absoluteString, "https://m.example.com/sub/api/albums/abc?limit=2")
        XCTAssertEqual(api.imageURL(id: "pl_1", size: 300, bust: "0123456789abc").absoluteString,
                       "https://m.example.com/sub/api/image/pl_1?c=0123456789&size=300")
    }

    func testRequestAlbumPostsTheMbid() async throws {
        let api = CoreStubProtocol.client()
        CoreStubProtocol.answers = ["/api/requests": (200, #"{"status":"queued","id":12,"artist":"A","title":"T"}"#)]
        let st = try await api.requestAlbum("mb-1")
        XCTAssertEqual(st, "queued")
        let r = CoreStubProtocol.seen[0]
        XCTAssertEqual(r.method, "POST")
        XCTAssertEqual(try JSONSerialization.jsonObject(with: r.body ?? Data()) as? [String: String], ["album_id": "mb-1"])
    }

    func testRadarKeepsArtistName() async throws {
        let api = CoreStubProtocol.client()
        CoreStubProtocol.answers = ["/api/radar": (200, #"{"releases":[{"album_id":"m","title":"New","rtype":"Album","date":"2026-11-01","image":null,"artistId":"a","artistName":"Band","inLibrary":null,"localName":null,"requestStatus":null}]}"#)]
        let r = try await api.radar()
        XCTAssertEqual(r.first?.artistName, "Band")
        XCTAssertEqual(r.first?.id, "m:a")
    }

    func testLimitsAndBrowse() async throws {
        let api = CoreStubProtocol.client()
        CoreStubProtocol.answers = ["/api/albums": (200, #"{"items":[],"total":0}"#), "/api/artists": (200, #"{"items":[],"total":0}"#),
                                    "/api/browse": (200, #"{"tiles":[]}"#)]
        _ = try await api.albums(limit: 2)
        _ = try await api.artists(limit: 1)
        _ = try await api.browse()
        XCTAssertEqual(CoreStubProtocol.seen.map(\.url.query), ["limit=2", "limit=1", nil])
    }

    func testDownloadsAndRetry() async throws {
        let api = CoreStubProtocol.client()
        CoreStubProtocol.answers = ["/api/downloads": (200, #"{"scope":"all","items":[{"id":7,"title":"T","state":"failed","total":10,"done":2}],"counts":{},"stuckAfterMs":1000,"watcher":null,"now":1}"#),
                                    "/retry": (200, #"{"ok":true,"id":7}"#)]
        let d = try await api.downloads(scope: .all)
        XCTAssertEqual(d.items.first?.id, 7)
        try await api.retryDownload(7)
        XCTAssertEqual(CoreStubProtocol.seen[0].url.query, "scope=all")
        XCTAssertEqual(CoreStubProtocol.seen[1].method, "POST")
        XCTAssertEqual(CoreStubProtocol.seen[1].url.path, "/api/downloads/7/retry")
    }

    func testHistoryStatsSendsRangeAndOffset() async throws {
        let api = CoreStubProtocol.client()
        CoreStubProtocol.answers = ["/api/history": (200, #"{"connected":true,"streams":3,"minutes":9,"topTracks":[],"byHour":[]}"#)]
        let s = try await api.historyStats(range: "4w")
        XCTAssertEqual(s.numbers.streams, 3)
        let q = URLComponents(url: CoreStubProtocol.seen[0].url, resolvingAgainstBaseURL: false)!.queryItems!
        XCTAssertEqual(q.first { $0.name == "range" }?.value, "4w")
        XCTAssertEqual(q.first { $0.name == "tzo" }?.value, String(-TimeZone.current.secondsFromGMT() / 60))
    }

    func testLyricJobLists() async throws {
        let api = CoreStubProtocol.client()
        CoreStubProtocol.answers = ["/api/lyrics/sync": (200, #"{"jobs":[{"trackId":"t1","title":"X","state":"running","step":"align","ahead":0,"result":null,"requested":1,"finished":null}]}"#),
                                    "/t1/sync": (200, #"{"trackId":"t1","title":"X","state":"queued","step":null,"ahead":2,"result":null,"requested":1,"finished":null,"already":true}"#)]
        let a = try await api.lyricJobs(ids: ["t1", "t2"])
        let b = try await api.myLyricJobs()
        let none = try await api.lyricJobs(ids: [])
        let job = try await api.requestLyricSync("t1")
        XCTAssertEqual(a.first?.state, "running")
        XCTAssertEqual(b.count, 1)
        XCTAssertTrue(none.isEmpty)
        XCTAssertEqual(job.already, true)
        XCTAssertEqual(CoreStubProtocol.seen.map(\.url.query), ["ids=t1,t2", "mine=1", nil])
    }

    func testFolderCoverCarriesRev() async throws {
        let api = CoreStubProtocol.client()
        CoreStubProtocol.answers = ["/cover": (200, #"{"ok":true,"cover":"abc"}"#)]
        let r = try await api.setFolderCover("fd_1", jpeg: Data([1, 2, 3]), rev: "r123")
        XCTAssertEqual(r.cover, "abc")
        let s = CoreStubProtocol.seen[0]
        XCTAssertEqual(s.url.path, "/api/library/folders/fd_1/cover")
        XCTAssertEqual(s.headers["X-Slopify-Rev"], "r123")
        XCTAssertEqual(s.headers["Content-Type"], "image/jpeg")
    }

    func testReachabilityIsReported() async {
        let api = CoreStubProtocol.client()
        var seen: [Bool] = []
        api.onReachability = { seen.append($0) }
        _ = try? await api.me()
        XCTAssertEqual(seen, [true])
    }
}

@MainActor
final class CoreLikesTests: XCTestCase {
    func testSetRollsBackAndThrows() async {
        let api = CoreStubProtocol.client()
        CoreStubProtocol.answers = ["/api/likes/t1": (500, #"{"error":"disk full"}"#)]
        let likes = Likes(); likes.attach(api)
        do { try await likes.set("t1", liked: true); XCTFail("should throw") }
        catch { XCTAssertEqual(error.localizedDescription, "disk full") }
        XCTAssertFalse(likes.isLiked("t1"))
        // The old signature still swallows.
        await likes.toggle("t1")
        XCTAssertFalse(likes.isLiked("t1"))
        withExtendedLifetime(api) {}
    }

    func testToggleThrowingAndLoaded() async throws {
        let api = CoreStubProtocol.client()
        CoreStubProtocol.answers = ["/api/likes/t1": (200, #"{"ok":true,"at":42}"#), "/api/likes": (200, #"{"at":{"t9":1}}"#),
                                    "/api/likes/albums": (200, #"{"items":[]}"#), "/api/likes/artists": (200, #"{"items":[]}"#)]
        let likes = Likes(); likes.attach(api)
        XCTAssertFalse(likes.loaded)
        try await likes.toggleThrowing("t1")
        XCTAssertEqual(likes.tracks["t1"], 42)
        await likes.refresh()
        XCTAssertTrue(likes.loaded)
        likes.reset()
        XCTAssertFalse(likes.loaded)
        XCTAssertTrue(likes.tracks.isEmpty)
        withExtendedLifetime(api) {}
    }
}

@MainActor
final class CoreFindServerTests: XCTestCase {
    func testBothSchemesInParallelFirstGuessWins() async {
        let start = Date()
        let found = await Account.findServer("music.example.com", timeout: 6) { url, _ in
            try? await Task.sleep(nanoseconds: 200_000_000)
            return true
        }
        XCTAssertEqual(found?.absoluteString, "https://music.example.com")
        XCTAssertLessThan(Date().timeIntervalSince(start), 0.39, "probes run in parallel")
        let http = await Account.findServer("music.example.com", timeout: 6) { url, _ in url.scheme == "http" }
        XCTAssertEqual(http?.absoluteString, "http://music.example.com")
        let none = await Account.findServer("music.example.com", timeout: 6) { _, _ in false }
        XCTAssertNil(none)
        XCTAssertEqual(Account.mainProbeTimeout, 6)
        XCTAssertEqual(Account.homeProbeTimeout, 3)
    }
}

@MainActor
final class CoreConnectivityTests: XCTestCase {
    private func wait(_ cond: () -> Bool) async {
        for _ in 0..<200 where !cond() { try? await Task.sleep(nanoseconds: 5_000_000) }
    }

    func testFailureIsConfirmedBeforeGoingOffline() async {
        let c = Connectivity()
        c.retryInterval = .seconds(60)
        var healthy = true
        var changes: [Bool] = []
        c.healthCheck = { _ in healthy }
        c.onChange = { changes.append($0) }
        c.note(reachable: false)
        try? await Task.sleep(nanoseconds: 30_000_000)
        XCTAssertFalse(c.offline, "the health check answered")
        healthy = false
        c.note(reachable: false)
        await wait { c.offline }
        XCTAssertTrue(c.offline)
        c.note(reachable: true)
        XCTAssertFalse(c.offline)
        XCTAssertEqual(changes, [true, false])
    }

    func testNoPathIsOfflineAtOnceAndRetries() async {
        let c = Connectivity()
        c.retryInterval = .milliseconds(20)
        var healthy = false
        c.healthCheck = { _ in healthy }
        c.pathChanged(satisfied: false)
        XCTAssertTrue(c.offline)
        healthy = true
        await wait { !c.offline }
        XCTAssertFalse(c.offline, "the 15 s retry (shortened here) ends it")
    }
}
