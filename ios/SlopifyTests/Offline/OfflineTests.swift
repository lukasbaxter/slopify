import XCTest
@testable import Slopify

/// Canned file answers for `/api/stream/:id/whole/:profile` and `/api/download/:id` (API.md §12.5,
/// §13); no real server. Ids in `failing` answer 503, ids in `unreachable` fail to connect.
final class OfflineStubProtocol: URLProtocol {
    nonisolated(unsafe) static var failing: Set<String> = []
    nonisolated(unsafe) static var unreachable: Set<String> = []
    nonisolated(unsafe) static var requests: [String] = []
    private static let lock = NSLock()

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let url = request.url!
        let parts = url.path.split(separator: "/").map(String.init)   // api, stream|download, id, ...
        let id = parts.count > 2 ? parts[2] : ""
        Self.lock.lock(); Self.requests.append(url.path + "?" + (url.query ?? "")); let fail = Self.failing.contains(id); let down = Self.unreachable.contains(id); Self.lock.unlock()
        if down { client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost)); return }
        if url.path == "/api/plays" {
            let r = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: r, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(#"{"ok":true}"#.utf8))
            client?.urlProtocolDidFinishLoading(self)
            return
        }
        let original = parts.count > 1 && parts[1] == "download"
        let headers = fail ? ["Content-Type": "application/json"]
            : original ? ["Content-Type": "audio/flac", "Content-Disposition": "attachment; filename=\"A - \(id).flac\""]
            : ["Content-Type": "audio/mp4"]
        let r = HTTPURLResponse(url: url, statusCode: fail ? 503 : 200, httpVersion: nil, headerFields: headers)!
        client?.urlProtocol(self, didReceive: r, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data((fail ? #"{"error":"busy"}"# : "audio-\(id)").utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}

    static func reset() { lock.lock(); failing = []; unreachable = []; requests = []; lock.unlock() }
    static var seen: [String] { lock.lock(); defer { lock.unlock() }; return requests }
}

@MainActor
final class OfflineTests: XCTestCase {
    private var root: URL!
    private var offlineFlag = false

    override func setUp() {
        OfflineStubProtocol.reset()
        offlineFlag = false
        root = FileManager.default.temporaryDirectory.appendingPathComponent("offline-tests-\(UUID().uuidString)", isDirectory: true)
    }

    override func tearDown() { try? FileManager.default.removeItem(at: root) }

    private func session() -> URLSession {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [OfflineStubProtocol.self]
        return URLSession(configuration: cfg)
    }

    private func makeStore(user: String = "u1", prefs: [String: JSONValue] = [:]) -> OfflineStore {
        let s = session()
        let store = OfflineStore(root: root, transport: { OfflineSessionTransport(session: s) })
        store.retryDelay = 0.01
        store.freeSpace = { nil }
        store.isOffline = { [unowned self] in self.offlineFlag }
        store.noteUnreachable = {}
        let api = APIClient(baseURL: URL(string: "https://music.invalid")!, token: "tok", session: s)
        store.attach(api: api, server: OfflineStore.serverKey("https://music.invalid"), userId: user, prefs: { prefs }, tablet: false)
        return store
    }

    /// Waits until nothing is queued or downloading, at most 5 s.
    private func settle(_ store: OfflineStore) async {
        for _ in 0..<500 where store.working { try? await Task.sleep(for: .milliseconds(10)) }
        XCTAssertFalse(store.working, "downloads did not settle")
        store.flushWrites()
    }

    private func filesDir() -> URL {
        root.appendingPathComponent("music.invalid", isDirectory: true).appendingPathComponent("files", isDirectory: true)
    }

    // MARK: index maths (pure)

    func testUpsertSummaryAndSharedSongs() {
        var ix = OfflineIndex()
        let a = OfflineCollection(id: "p1", name: "One", kind: .playlist, trackIds: [], added: 1)
        let r = ix.upsert(a, songs: ["x", "y", "x"].map { OfflineTrack(track: makeTrack($0), q: "aac-320", norm: "track") })
        XCTAssertEqual(r.missing, ["x", "y"], "duplicates counted once")
        XCTAssertEqual(ix.summary("p1"), OfflineSummary(have: 0, total: 2))
        ix.tracks["x"]?.file = "x.m4a"
        XCTAssertEqual(ix.summary("p1"), OfflineSummary(have: 1, total: 2))
        // A second collection sharing x: x is not downloaded again.
        let b = OfflineCollection(id: "al1", name: "Two", kind: .album, trackIds: [], added: 2)
        XCTAssertEqual(ix.upsert(b, songs: ["x", "z"].map { OfflineTrack(track: makeTrack($0), q: "aac-320", norm: "album") }).missing, ["z"])
        XCTAssertEqual(ix.collections.map(\.id), ["al1", "p1"], "newest first")
        XCTAssertEqual(ix.summary("al1"), OfflineSummary(have: 1, total: 2))
        // Removing p1 keeps x (held by al1), drops y.
        XCTAssertEqual(ix.remove("p1"), [])
        XCTAssertNil(ix.tracks["y"])
        XCTAssertNotNil(ix.tracks["x"])
        XCTAssertEqual(ix.remove("al1"), ["x.m4a"])
        XCTAssertTrue(ix.tracks.isEmpty)
    }

    func testSavingAtAnotherQualityDownloadsAgain() {
        var ix = OfflineIndex()
        let c = OfflineCollection(id: "p", name: "P", kind: .playlist, trackIds: [], added: 1)
        ix.upsert(c, songs: [OfflineTrack(track: makeTrack("x"), q: "aac-320", norm: "track")])
        ix.tracks["x"]?.file = "x.m4a"
        XCTAssertEqual(ix.upsert(c, songs: [OfflineTrack(track: makeTrack("x"), q: "aac-320", norm: "track")]).missing, [])
        let r = ix.upsert(c, songs: [OfflineTrack(track: makeTrack("x"), q: "original", norm: nil)])
        XCTAssertEqual(r.missing, ["x"])
        XCTAssertEqual(r.replaced, ["x.m4a"])
        XCTAssertNil(ix.tracks["x"]?.file)
    }

    func testPlanFollowsQualityAndKind() {
        var flac = makeTrack("f"); flac.codec = "FLAC"
        var opus = makeTrack("o"); opus.codec = "opus"
        let lossless: [String: JSONValue] = ["phoneQuality": .string("original")]
        XCTAssertEqual(OfflineRules.plan(flac, kind: .album, prefs: lossless, tablet: false).q, "original")
        XCTAssertNil(OfflineRules.plan(flac, kind: .album, prefs: lossless, tablet: false).norm)
        let o = OfflineRules.plan(opus, kind: .album, prefs: lossless, tablet: false)
        XCTAssertEqual(o.q, "aac-320"); XCTAssertEqual(o.norm, "album")
        let n = OfflineRules.plan(flac, kind: .playlist, prefs: ["phoneQuality": .string("normal")], tablet: false)
        XCTAssertEqual(n.q, "aac-160"); XCTAssertEqual(n.norm, "track")
        XCTAssertNil(OfflineRules.plan(flac, kind: .liked, prefs: ["normalize": .bool(false)], tablet: false).norm)
    }

    // MARK: glyph state

    func testGlyphStatesAndLabels() {
        XCTAssertEqual(OfflineRules.glyph(held: nil, busy: nil, pageTotal: 3), .none)
        XCTAssertEqual(OfflineRules.glyph(held: OfflineSummary(have: 1, total: 3), busy: nil, pageTotal: 3), .part)
        XCTAssertEqual(OfflineRules.glyph(held: OfflineSummary(have: 3, total: 3), busy: nil, pageTotal: 3), .done)
        // The page grew since it was saved: part again.
        XCTAssertEqual(OfflineRules.glyph(held: OfflineSummary(have: 3, total: 3), busy: nil, pageTotal: 4), .part)
        let busy = OfflineProgress(id: "p", name: "P", done: 1, total: 4, failed: 0)
        XCTAssertEqual(OfflineRules.glyph(held: OfflineSummary(have: 1, total: 4), busy: busy, pageTotal: 4), .busy(progress: 0.25))
        XCTAssertEqual(OfflineRules.countLabel(held: OfflineSummary(have: 1, total: 4), busy: busy, pageTotal: 4), "1/4")
        XCTAssertEqual(OfflineRules.countLabel(held: OfflineSummary(have: 2, total: 4), busy: nil, pageTotal: 4), "2/4")
        XCTAssertNil(OfflineRules.countLabel(held: OfflineSummary(have: 4, total: 4), busy: nil, pageTotal: 4))
        XCTAssertNil(OfflineRules.countLabel(held: nil, busy: nil, pageTotal: 4))
    }

    func testPlayableOfflineFiltersToDownloaded() {
        let list = tracks("a", "b", "c", "d")
        let has: (String) -> Bool = { ["b", "d"].contains($0) }
        XCTAssertEqual(OfflineRules.playable(list, at: 2, offline: false, has: has)?.index, 2)
        XCTAssertNil(OfflineRules.playable(list, at: 2, offline: true, has: has), "a tapped song not downloaded refuses")
        let p = OfflineRules.playable(list, at: 3, offline: true, has: has)
        XCTAssertEqual(p?.tracks.map(\.id), ["b", "d"]); XCTAssertEqual(p?.index, 1)
        XCTAssertEqual(OfflineRules.playablePage(list, offline: true, has: has)?.map(\.id), ["b", "d"])
        XCTAssertNil(OfflineRules.playablePage(list, offline: true, has: { _ in false }))
    }

    // MARK: store

    func testSaveDownloadsPersistsAndReloads() async throws {
        let store = makeStore()
        var finished: OfflineProgress?
        store.onFinished = { finished = $0 }
        XCTAssertEqual(try store.save(id: "p1", name: "Mix", kind: .playlist, tracks: tracks("a", "b", "c")), .now)
        await settle(store)
        XCTAssertEqual(finished, OfflineProgress(id: "p1", name: "Mix", done: 3, total: 3, failed: 0))
        XCTAssertEqual(store.downloaded, ["a", "b", "c"])
        XCTAssertEqual(store.glyph("p1", pageTotal: 3), .done)
        XCTAssertTrue(OfflineStubProtocol.seen.contains { $0.hasPrefix("/api/stream/a/whole/aac-320?") && $0.contains("norm=track") && $0.contains("token=tok") })
        XCTAssertEqual(try String(contentsOf: filesDir().appendingPathComponent("a.m4a"), encoding: .utf8), "audio-a")

        // A new run (relaunch) reads the same index from disk.
        store.detach()
        let again = makeStore()
        XCTAssertEqual(again.summary("p1"), OfflineSummary(have: 3, total: 3))
        XCTAssertEqual(again.downloaded, ["a", "b", "c"])
        XCTAssertEqual(again.index.collections.first?.name, "Mix")
    }

    func testOriginalKeepsServerExtension() async throws {
        var t = makeTrack("f"); t.codec = "flac"
        let store = makeStore(prefs: ["phoneQuality": .string("original")])
        try store.save(id: "al", name: "A", kind: .album, tracks: [t])
        await settle(store)
        XCTAssertEqual(store.localFile("f")?.lastPathComponent, "f.flac")
        XCTAssertTrue(OfflineStubProtocol.seen.contains { $0.hasPrefix("/api/download/f?") && $0.contains("fmt=original") })
    }

    func testFailuresCountAndUpdateRetries() async throws {
        OfflineStubProtocol.failing = ["b"]
        let store = makeStore()
        var finished: OfflineProgress?
        store.onFinished = { finished = $0 }
        try store.save(id: "p", name: "P", kind: .playlist, tracks: tracks("a", "b"))
        await settle(store)
        XCTAssertEqual(finished?.failed, 1)
        XCTAssertEqual(finished?.done, 1)
        XCTAssertEqual(OfflineStubProtocol.seen.filter { $0.hasPrefix("/api/stream/b/") }.count, 3, "3 tries")
        XCTAssertEqual(store.glyph("p", pageTotal: 2), .part)
        OfflineStubProtocol.failing = []
        finished = nil
        try store.save(id: "p", name: "P", kind: .playlist, tracks: tracks("a", "b"))
        await settle(store)
        XCTAssertEqual(store.summary("p"), OfflineSummary(have: 2, total: 2))
        XCTAssertEqual(OfflineStubProtocol.seen.filter { $0.hasPrefix("/api/stream/a/") }.count, 1, "a is not fetched again")
    }

    func testResumeAfterRelaunchFinishesTheRest() async throws {
        OfflineStubProtocol.unreachable = ["b", "c"]
        let store = makeStore()
        var toasts = 0
        store.onFinished = { _ in toasts += 1 }
        try store.save(id: "p", name: "P", kind: .playlist, tracks: tracks("a", "b", "c"))
        await settle(store)
        XCTAssertEqual(toasts, 0, "cut off by the network: no finish toast")
        XCTAssertEqual(store.summary("p")?.have, 1)
        store.detach()

        OfflineStubProtocol.unreachable = []
        let again = makeStore()
        var finished: OfflineProgress?
        again.onFinished = { finished = $0 }
        again.resume()
        await settle(again)
        XCTAssertEqual(again.summary("p"), OfflineSummary(have: 3, total: 3))
        XCTAssertEqual(finished?.done, 3)
    }

    func testResumeAdoptsFilesPlacedInTheBackground() throws {
        let store = makeStore()
        offlineFlag = true
        XCTAssertEqual(try store.save(id: "p", name: "P", kind: .playlist, tracks: tracks("a")), .later)
        XCTAssertNil(store.active)
        XCTAssertTrue(OfflineStubProtocol.seen.isEmpty, "offline: only remembered")
        // A background download finished while the app was gone.
        try FileManager.default.createDirectory(at: filesDir(), withIntermediateDirectories: true)
        try Data("bg".utf8).write(to: filesDir().appendingPathComponent("a.m4a"))
        offlineFlag = false
        store.resume()
        XCTAssertTrue(store.has("a"))
        XCTAssertEqual(store.summary("p"), OfflineSummary(have: 1, total: 1))
    }

    func testRemovalKeepsWhatOthersHold() async throws {
        let store = makeStore()
        try store.save(id: "p1", name: "One", kind: .playlist, tracks: tracks("a", "b"))
        await settle(store)
        try store.save(id: "p2", name: "Two", kind: .playlist, tracks: tracks("b", "c"))
        await settle(store)
        store.remove("p1")
        store.flushWrites()
        let fm = FileManager.default
        XCTAssertFalse(fm.fileExists(atPath: filesDir().appendingPathComponent("a.m4a").path))
        XCTAssertTrue(fm.fileExists(atPath: filesDir().appendingPathComponent("b.m4a").path), "p2 still holds b")
        XCTAssertNil(store.summary("p1"))
        XCTAssertEqual(store.glyph("p1", pageTotal: 2), .none)
        XCTAssertEqual(store.downloaded, ["b", "c"])

        // Another account on this server holds c: removing it here keeps the file.
        store.detach()
        let other = makeStore(user: "u2")
        XCTAssertTrue(other.index.collections.isEmpty, "libraries are per account")
        try other.save(id: "p9", name: "Theirs", kind: .playlist, tracks: tracks("c"))
        await settle(other)
        other.detach()
        let mine = makeStore()
        XCTAssertEqual(mine.summary("p2"), OfflineSummary(have: 2, total: 2), "survives sign-out")
        mine.remove("p2")
        XCTAssertFalse(fm.fileExists(atPath: filesDir().appendingPathComponent("b.m4a").path))
        XCTAssertTrue(fm.fileExists(atPath: filesDir().appendingPathComponent("c.m4a").path))
    }

    func testLocalFileResolutionFeedsThePlayer() async throws {
        let store = makeStore()
        try store.save(id: "p", name: "P", kind: .playlist, tracks: tracks("a"))
        await settle(store)
        let file = try XCTUnwrap(store.localFile("a"))
        XCTAssertTrue(file.isFileURL)
        XCTAssertNil(store.localFile("zzz"))
        let (p, e, _, _) = makePlayer()
        p.localFile = { store.localFile($0) }
        p.play(tracks("a", "b"))
        XCTAssertEqual(e.loads[0].0.url, file)
        // The file went missing from disk: stream instead.
        try FileManager.default.removeItem(at: file)
        XCTAssertNil(store.localFile("a"))
    }

    func testOfflinePlaysAndSearch() async throws {
        var t = makeTrack("a"); t.title = "Café del Mar"
        let store = makeStore()
        try store.save(id: "p", name: "P", kind: .playlist, tracks: [t, makeTrack("b")])
        await settle(store)
        XCTAssertEqual(store.search("cafe mar").map(\.id), ["a"])
        XCTAssertEqual(store.search("artist").count, 2)
        XCTAssertTrue(store.search("nothing").isEmpty)
        store.recordPlay("a", at: 20)
        store.recordPlay("b", at: 10)
        XCTAssertEqual(store.index.plays.count, 2)
        await store.flushPlays()
        XCTAssertTrue(store.index.plays.isEmpty)
        XCTAssertEqual(OfflineStubProtocol.seen.filter { $0.hasPrefix("/api/plays") }.count, 2)
    }

    func testSearchOfflineUsesDownloadedSongs() async throws {
        var calls = 0
        var b = SearchModel.Backend(search: { _ in calls += 1; throw APIError.offline }, playlists: { [] },
                                    everywhere: { _ in throw CancellationError() }, request: { _ in nil })
        var offline = true
        b.offline = { offline }
        b.searchOffline = { q in q == "mar" ? [makeTrack("a")] : [] }
        let m = SearchModel(backend: b)
        m.searchDelay = .milliseconds(1)
        m.setQuery("mar")
        for _ in 0..<200 where m.page == nil { try? await Task.sleep(for: .milliseconds(5)) }
        XCTAssertEqual(m.page?.tracks.map(\.id), ["a"])
        XCTAssertEqual(calls, 0, "offline: no request")
        // Online, but the request finds no server: the downloaded songs too, no banner.
        offline = false
        m.setQuery("mar ")
        m.setQuery("mar")
        for _ in 0..<200 where calls == 0 { try? await Task.sleep(for: .milliseconds(5)) }
        try? await Task.sleep(for: .milliseconds(20))
        XCTAssertEqual(m.page?.tracks.map(\.id), ["a"])
        XCTAssertNil(m.error)
    }
}
