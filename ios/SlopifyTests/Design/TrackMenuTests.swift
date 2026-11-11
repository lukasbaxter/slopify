import XCTest
@testable import Slopify

private func menuTrack(_ id: String, artists: [String] = ["A"], ids: [String] = ["a1"], album: String = "Alb", albumId: String = "al1") -> Track {
    Track(id: id, title: "T\(id)", artist: artists.joined(separator: ", "), artists: artists, artistIds: ids, albumId: albumId, album: album,
          albumArtist: artists.first ?? "", trackNo: nil, discNo: nil, year: nil, genres: nil, durationMs: 1000, codec: nil, bitrate: nil,
          cover: nil, format: nil, gain: nil, addedAt: nil, plays: nil)
}

private func labels(_ items: [MenuItem]) -> [String] { items.map { $0.kind == .separator ? "—" : $0.label } }

/// The shared track row menu (TrackRow.jsx:210-236; UI.md 5.4.5).
@MainActor
final class TrackMenuTests: XCTestCase {
    func testOnlineMenuOrder() {
        let t = menuTrack("1")
        let s = TrackMenu.State(track: t, liked: false, excluded: false, playlists: [Playlist(id: "pl_1", name: "Road")])
        let items = TrackMenu.items(s, .init())
        XCTAssertEqual(labels(items), [L("Add to queue"), L("Add to playlist"), L("Add to Liked Songs"), L("Exclude from your taste profile"), "—",
                                       L("Go to song radio"), L("Go to artist"), L("Go to album"), L("Sync Lyrics"), L("Share")])
        XCTAssertEqual(labels(items[1].sub ?? []), [L("New playlist"), "—", "Road"])
    }

    func testLikedExcludedSyncingAndSeveralArtists() {
        let t = menuTrack("1", artists: ["A", "B"], ids: ["a1", "b1"])
        let s = TrackMenu.State(track: t, liked: true, excluded: true, syncing: true)
        let items = TrackMenu.items(s, .init())
        XCTAssertTrue(labels(items).contains(L("Remove from Liked Songs")))
        XCTAssertTrue(labels(items).contains(L("Include in your taste profile")))
        let sync = items.first { $0.label == L("Syncing Lyrics…") }
        XCTAssertEqual(sync?.disabled, true)
        let artist = items.first { $0.label == L("Go to artist") }
        XCTAssertEqual(artist?.sub?.map(\.label), ["A", "B"])
        XCTAssertEqual(labels(items[1].sub ?? []), [L("New playlist")], "no separator without playlists")
    }

    func testOfflineKeepsArtistAndAlbumOnly() {
        let t = menuTrack("1", artists: ["A", "B"], ids: ["a1", "b1"])
        let off = TrackMenu.items(.init(track: t, liked: false, excluded: false, offline: true), .init())
        XCTAssertEqual(labels(off), [L("Go to artist"), L("Go to album")])
        XCTAssertEqual(off[0].sub?.count, 2)
        let kept = TrackMenu.items(.init(track: t, liked: false, excluded: false, downloaded: true, offline: true), .init())
        // offlineMenu keeps the inner separator (TrackRow.jsx:184-188).
        XCTAssertEqual(labels(kept), [L("Add to queue"), "—", L("Go to artist"), L("Go to album")])
    }

    func testActionsRunWithTheTrack() {
        var opened: String?
        var liked: Bool?
        let t = menuTrack("1")
        var a = TrackMenu.Actions()
        a.openAlbum = { opened = $0 }
        a.like = { _, on in liked = on }
        let items = TrackMenu.items(.init(track: t, liked: false, excluded: false), a)
        items.first { $0.label == L("Go to album") }?.action?()
        items.first { $0.label == L("Add to Liked Songs") }?.action?()
        XCTAssertEqual(opened, "al1")
        XCTAssertEqual(liked, true)
    }

    func testRemoveOnlyWhenThePageGivesIt() {
        let t = menuTrack("1")
        XCTAssertFalse(labels(TrackMenu.items(.init(track: t, liked: false, excluded: false), .init())).contains(L("Remove from this playlist")))
        var removed: String?
        var a = TrackMenu.Actions()
        a.remove = { removed = $0.id }
        let items = TrackMenu.items(.init(track: t, liked: false, excluded: false), a)
        XCTAssertEqual(labels(items)[2], L("Remove from this playlist"))
        items[2].action?()
        XCTAssertEqual(removed, "1")
    }

    func testPlaylistRowsAddTheTrack() {
        var added: (String, String)?
        var a = TrackMenu.Actions()
        a.addTo = { p, t in added = (p.id, t.id) }
        let items = TrackMenu.items(.init(track: menuTrack("9"), liked: false, excluded: false, playlists: [Playlist(id: "p1", name: "Road")]), a)
        items[1].sub?.last?.action?()
        XCTAssertEqual(added?.0, "p1")
        XCTAssertEqual(added?.1, "9")
    }

    /// FullScreen.jsx:221-240: no taste-profile row, a separator before Sync Lyrics, trailing rows.
    func testNowPlayingStyle() {
        let t = menuTrack("1", artists: [], ids: ["a9"])
        let s = TrackMenu.State(track: t, liked: false, excluded: false, style: .nowPlaying, trailing: [MenuItem("Sleep timer")])
        var opened: String?
        var a = TrackMenu.Actions()
        a.openArtist = { opened = $0 }
        let items = TrackMenu.items(s, a)
        XCTAssertEqual(labels(items), [L("Add to queue"), L("Add to playlist"), L("Add to Liked Songs"), "—",
                                       L("Go to song radio"), L("Go to artist"), L("Go to album"), "—", L("Sync Lyrics"), L("Share"), "Sleep timer"])
        items.first { $0.label == L("Go to artist") }?.action?()
        XCTAssertEqual(opened, "a9", "falls back to the first artist id")
    }

    func testNewPlaylistName() {
        XCTAssertEqual(TrackMenu.newPlaylistName(menuTrack("1", album: "OK Computer")), "OK Computer")
        XCTAssertEqual(TrackMenu.newPlaylistName(menuTrack("1", album: "")), L("My Playlist"))
        XCTAssertEqual(TrackMenu.newPlaylistName(nil), L("My Playlist"))
    }

    func testShareURL() {
        XCTAssertEqual(TrackMenu.shareURL(main: "https://music.example.org//", kind: .album, id: "abc")?.absoluteString, "https://music.example.org/?album=abc")
        XCTAssertEqual(TrackMenu.shareTitle("Song", by: "Band"), "Song — Band")
        XCTAssertEqual(TrackMenu.shareTitle("Song", by: ""), "Song")
        XCTAssertEqual(TrackMenu.shareBy(menuTrack("1", artists: ["A", "B"], ids: ["a", "b"])), "A, B")
    }

    func testDislikesPatch() {
        let prefs: [String: JSONValue] = ["dislikes": .object(["old": .number(1)])]
        XCTAssertTrue(TrackMenu.isExcluded("old", prefs: prefs))
        XCTAssertFalse(TrackMenu.isExcluded("new", prefs: prefs))
        let added = TrackMenu.dislikes(prefs, setting: "new", excluded: true, now: 5)
        XCTAssertEqual(added, ["old": .number(1), "new": .number(5)])
        XCTAssertEqual(TrackMenu.dislikes(prefs, setting: "old", excluded: false, now: 5), [:])
    }
}

/// Canned `/api/lyrics` answers (API.md §10); no real server.
final class TrackMenuLyricStub: URLProtocol {
    nonisolated(unsafe) static var polls: [String] = []
    nonisolated(unsafe) static var post = ""
    nonisolated(unsafe) static var mine = #"{"jobs":[]}"#
    nonisolated(unsafe) static var seen: [String] = []
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let url = request.url!
        Self.seen.append("\(request.httpMethod ?? "GET") \(url.path)?\(url.query ?? "")")
        let body: String
        if request.httpMethod == "POST" { body = Self.post }
        else if url.query?.contains("mine=1") == true { body = Self.mine }
        else { body = Self.polls.count > 1 ? Self.polls.removeFirst() : (Self.polls.first ?? #"{"jobs":[]}"#) }
        let r = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: r, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@MainActor
final class LyricJobsTests: XCTestCase {
    private func api() -> APIClient {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [TrackMenuLyricStub.self]
        return APIClient(baseURL: URL(string: "https://lyrics.invalid")!, token: "t", session: URLSession(configuration: cfg))
    }

    private func job(_ id: String, _ state: String, step: String? = nil, ahead: Int = 0, result: String? = nil) -> String {
        let s = step.map { "\"\($0)\"" } ?? "null", r = result.map { "\"\($0)\"" } ?? "null"
        return #"{"trackId":"\#(id)","title":"Song \#(id)","state":"\#(state)","step":\#(s),"ahead":\#(ahead),"result":\#(r),"requested":1,"finished":null}"#
    }

    private func until(_ cond: () -> Bool) async {
        for _ in 0..<150 where !cond() { try? await Task.sleep(nanoseconds: 20_000_000) }
    }

    override func setUp() {
        TrackMenuLyricStub.polls = []; TrackMenuLyricStub.seen = []
        TrackMenuLyricStub.post = ""; TrackMenuLyricStub.mine = #"{"jobs":[]}"#
        ToastCenter.shared.lyricSync = nil
    }

    func testJobLabel() {
        let base = LyricJob(trackId: "t", title: nil, state: "queued", step: nil, ahead: 2, result: nil, requested: nil, finished: nil)
        XCTAssertEqual(LyricJobStore.label(base), "Waiting · 2 ahead")
        var j = base; j.ahead = 0
        XCTAssertEqual(LyricJobStore.label(j), "Starting")
        j.state = "running"; j.step = "Aligning"
        XCTAssertEqual(LyricJobStore.label(j), "Aligning")
        XCTAssertTrue(LyricJobStore.isActive(j))
        j.state = "done"
        XCTAssertFalse(LyricJobStore.isActive(j))
    }

    /// Start, follow every interval, finish: pill, menu row and lyrics revision agree.
    func testSyncPollsUntilDone() async {
        let jobs = LyricJobStore()
        jobs.interval = 0.05
        TrackMenuLyricStub.post = String(job("t1", "queued", ahead: 2).dropLast()) + #","already":false}"#
        TrackMenuLyricStub.polls = [#"{"jobs":[\#(job("t1", "running", step: "Aligning"))]}"#, #"{"jobs":[\#(job("t1", "done", result: "Synced"))]}"#]

        await jobs.sync(menuTrack("t1"), api: api())
        XCTAssertTrue(jobs.isSyncing("t1"))
        XCTAssertEqual(ToastCenter.shared.lyricSync?.stage, "Waiting · 2 ahead")
        let row = TrackMenu.items(.init(track: menuTrack("t1"), liked: false, excluded: false, syncing: jobs.isSyncing("t1")), .init())
        XCTAssertEqual(row.first { $0.label == L("Syncing Lyrics…") }?.disabled, true)

        await until { ToastCenter.shared.lyricSync?.stage == "Aligning" }
        XCTAssertEqual(ToastCenter.shared.lyricSync?.title, "Song t1")
        await until { !jobs.isSyncing("t1") }
        XCTAssertFalse(jobs.isSyncing("t1"))
        XCTAssertNil(ToastCenter.shared.lyricSync)
        XCTAssertEqual(jobs.revision["t1"], 1)
        XCTAssertEqual(ToastCenter.shared.toast?.text, "Song t1: Synced")
        XCTAssertTrue(TrackMenuLyricStub.seen.contains("GET /api/lyrics/sync?ids=t1"))
    }

    /// `resumeLyricJobs`: this account's unfinished jobs come back after sign-in.
    func testResumePicksUpMine() async {
        let jobs = LyricJobStore()
        jobs.interval = 60
        TrackMenuLyricStub.mine = #"{"jobs":[\#(job("a", "running", step: "Aligning")),\#(job("b", "queued", ahead: 1))]}"#
        await jobs.resume(api: api())
        XCTAssertEqual(jobs.order, ["a", "b"])
        XCTAssertEqual(ToastCenter.shared.lyricSync, .init(title: "Song a", stage: "Aligning", more: 1))
        jobs.reset()
        XCTAssertTrue(jobs.jobs.isEmpty)
        XCTAssertNil(ToastCenter.shared.lyricSync)
    }

    /// A finished job nobody followed is ignored; a follow-up of an unknown job is not toasted.
    func testAbsorbIgnoresUnknownFinishedJobs() {
        let jobs = LyricJobStore()
        jobs.absorb([LyricJob(trackId: "x", title: "X", state: "done", step: nil, ahead: 0, result: "Synced", requested: 1, finished: 2)])
        XCTAssertTrue(jobs.jobs.isEmpty)
        XCTAssertNil(jobs.revision["x"])
    }

    func testAlreadySyncingToasts() async {
        let jobs = LyricJobStore()
        jobs.interval = 60
        TrackMenuLyricStub.post = String(job("t2", "running", step: "Aligning").dropLast()) + #","already":true}"#
        await jobs.sync(menuTrack("t2"), api: api())
        XCTAssertEqual(ToastCenter.shared.toast?.text, L("Already syncing \"{name}\"", ["name": "Tt2"]))
        XCTAssertTrue(jobs.isSyncing("t2"))
        jobs.reset()
    }
}
