import XCTest
@testable import Slopify

// Fixtures shaped like API.md §5.4 / §8.1.
private func pl(_ id: String, _ n: Int = 0) -> Playlist { Playlist(id: id, name: "P \(id)", userId: "u", created: 0, updated: 0, trackCount: n, cover: nil, aiPrompt: nil) }
private func al(_ id: String) -> Album { Album(id: id, name: "A \(id)", artist: "Band", artistId: "ar", year: 2000, trackCount: 1, durationMs: 1, cover: nil, addedAt: 0, likedAt: 0) }
private func ar(_ id: String) -> Artist { Artist(id: id, name: "R \(id)", trackCount: 1, albumCount: 1, image: nil, banner: nil, followedAt: 0) }
private func folder(_ id: String, _ items: [String], name: String = "F") -> LibraryLayout.Folder { .init(id: id, name: name, cover: nil, items: items) }
private func track(_ id: String, _ title: String, artist: String = "X", album: String = "Y") -> Track {
    Track(id: id, title: title, artist: artist, artists: [artist], artistIds: [], albumId: "al", album: album, albumArtist: artist,
          trackNo: nil, discNo: nil, year: nil, genres: nil, durationMs: 1000, codec: nil, bitrate: nil, cover: nil, format: nil, gain: nil, addedAt: nil, plays: nil)
}

final class LibraryArrangementTests: XCTestCase {
    func testOrderFoldersFreshAndPins() {
        // Sidebar.jsx:103-125: folder kids leave the top level, order kept, folders not in
        // order go on top, unplaced ("fresh") above all known, pinned float keeping list order.
        let layout = LibraryLayout(order: ["p2", "fd1", "a1", "gone"], folders: [folder("fd1", ["p3"]), folder("fd2", [])])
        let a = LibraryArrangement(playlists: [pl("p1"), pl("p2"), pl("p3")], albums: [al("a1")], artists: [ar("r1")], layout: layout, pinned: [])
        XCTAssertEqual(a.top.map(\.id), ["p1", "r1", "fd2", "p2", "fd1", "a1"])
        XCTAssertEqual(a.kids["fd1"]?.map(\.id), ["p3"])
        let pinned = LibraryArrangement(playlists: [pl("p1"), pl("p2"), pl("p3")], albums: [al("a1")], artists: [ar("r1")], layout: layout, pinned: ["a1", "p2"])
        XCTAssertEqual(pinned.top.map(\.id), ["p2", "a1", "p1", "r1", "fd2", "fd1"])
    }

    func testChildInTwoFoldersIsPlacedOnce() {
        let layout = LibraryLayout(order: [], folders: [folder("f1", ["p1"]), folder("f2", ["p1", "p2"])])
        let a = LibraryArrangement(playlists: [pl("p1"), pl("p2")], albums: [], artists: [], layout: layout, pinned: [])
        XCTAssertEqual(a.kids["f1"]?.map(\.id), ["p1"])
        XCTAssertEqual(a.kids["f2"]?.map(\.id), ["p2"])
    }

    func testTreeAndFlatShown() {
        let layout = LibraryLayout(order: ["fd1", "a1", "p2"], folders: [folder("fd1", ["p1"])])
        let a = LibraryArrangement(playlists: [pl("p1"), pl("p2")], albums: [al("a1")], artists: [], layout: layout, pinned: [])
        XCTAssertEqual(a.shown(filter: nil, query: "", offline: false, downloaded: [], openFolders: [], shut: false).map(\.id), ["fd1", "a1", "p2"])
        let open = a.shown(filter: nil, query: "", offline: false, downloaded: [], openFolders: ["fd1"], shut: false)
        XCTAssertEqual(open.map(\.id), ["fd1", "p1", "a1", "p2"])
        XCTAssertEqual(open[1].parent, "fd1")
        XCTAssertEqual(a.shown(filter: nil, query: "", offline: false, downloaded: [], openFolders: ["fd1"], shut: true).map(\.id), ["fd1", "a1", "p2"])
        // Flat: children inline at the folder's place, no folders.
        XCTAssertEqual(a.shown(filter: .playlist, query: "", offline: false, downloaded: [], openFolders: [], shut: false).map(\.id), ["p1", "p2"])
        XCTAssertEqual(a.shown(filter: nil, query: "  a A1 ", offline: false, downloaded: [], openFolders: [], shut: false).map(\.id), ["a1"])
        XCTAssertEqual(a.shown(filter: nil, query: "", offline: true, downloaded: ["p2"], openFolders: [], shut: false).map(\.id), ["p2"])
    }

    func testShowLiked() {
        XCTAssertTrue(LibraryArrangement.showLiked(filter: nil, query: "", likedName: "Liked Songs", offline: false, likedDownloaded: false))
        XCTAssertTrue(LibraryArrangement.showLiked(filter: .playlist, query: "liked", likedName: "Liked Songs", offline: false, likedDownloaded: false))
        XCTAssertFalse(LibraryArrangement.showLiked(filter: .album, query: "", likedName: "Liked Songs", offline: false, likedDownloaded: false))
        XCTAssertFalse(LibraryArrangement.showLiked(filter: nil, query: "zzz", likedName: "Liked Songs", offline: false, likedDownloaded: false))
        XCTAssertFalse(LibraryArrangement.showLiked(filter: nil, query: "", likedName: "Liked Songs", offline: true, likedDownloaded: false))
    }

    func testDraftKeepsUnknownIdsAndRoundTrips() {
        let layout = LibraryLayout(order: ["p1", "unknown"], folders: [.init(id: "fd1", name: "Gym", cover: "c1", items: ["p2", "lost"])])
        let a = LibraryArrangement(playlists: [pl("p1"), pl("p2")], albums: [], artists: [], layout: layout, pinned: [])
        let d = a.draft(layout: layout)
        // fd1 is not in `order`, so it goes on top; ids the client does not know are kept.
        XCTAssertEqual(d.order, ["fd1", "p1", "unknown"])
        XCTAssertEqual(d.folders["fd1"], ["p2", "lost"])
        let back = d.layout
        XCTAssertEqual(back.folders.first?.name, "Gym")
        XCTAssertEqual(back.folders.first?.cover, "c1")
        XCTAssertTrue(back.order.contains("unknown"))
    }

    func testCreateRenameDeleteFolder() {
        let layout = LibraryLayout(order: ["a", "fd1", "b"], folders: [folder("fd1", ["x", "y"])])
        let a = LibraryArrangement(playlists: [pl("a"), pl("b"), pl("x"), pl("y")], albums: [], artists: [], layout: layout, pinned: [])
        let d = a.draft(layout: layout)
        let created = LibraryArrangement.creatingFolder(d, tempId: "fd_new1", name: "New")
        XCTAssertEqual(created.order.first, "fd_new1")
        XCTAssertEqual(created.layout.folders.map(\.id), ["fd1", "fd_new1"])
        XCTAssertEqual(LibraryArrangement.renamingFolder(d, id: "fd1", name: "Run").layout.folders.first?.name, "Run")
        // What it held goes back where the folder was.
        let deleted = LibraryArrangement.deletingFolder(d, id: "fd1")
        XCTAssertEqual(deleted.order, ["a", "x", "y", "b"])
        XCTAssertTrue(deleted.layout.folders.isEmpty)
    }

    func testDropRules() {
        // Rows shown: fd1 (open) > x, then a, b, fdE (open, empty).
        let layout = LibraryLayout(order: ["fd1", "a", "b", "fdE"], folders: [folder("fd1", ["x"]), folder("fdE", [])])
        let a = LibraryArrangement(playlists: [pl("a"), pl("b"), pl("x")], albums: [], artists: [], layout: layout, pinned: [])
        let open: Set<String> = ["fd1", "fdE"]
        let shown = a.shown(filter: nil, query: "", offline: false, downloaded: [], openFolders: open, shut: false)
        let rows = shown.map(\.id)
        XCTAssertEqual(rows, ["fd1", "x", "a", "b", "fdE"])
        let d = a.draft(layout: layout)
        func drop(_ id: String, _ to: Int, into: String? = nil) -> LibraryArrangement.Draft {
            a.dropping(d, id: id, to: to, into: into, rows: rows, shown: shown, openFolders: open, shut: false)
        }
        // Onto a folder: first in it.
        XCTAssertEqual(drop("b", 0, into: "fd1").folders["fd1"], ["b", "x"])
        // Before a folder's first child: in the folder.
        let between = drop("b", 1)
        XCTAssertEqual(between.folders["fd1"], ["b", "x"])
        XCTAssertFalse(between.order.contains("b"))
        // Right under an open empty folder: in it.
        XCTAssertEqual(drop("a", 4).folders["fdE"], ["a"])
        // Top level after the row above (a child counts as its folder).
        XCTAssertEqual(drop("b", 2).order, ["fd1", "b", "a", "fdE"])
        XCTAssertEqual(drop("b", 0).order, ["b", "fd1", "a", "fdE"])
        // A folder never goes inside a folder.
        XCTAssertEqual(drop("fdE", 1).order, ["fd1", "fdE", "a", "b"])
    }

    func testPinToggle() {
        XCTAssertEqual(LibraryArrangement.togglingPin(["a"], id: "b"), ["a", "b"])
        XCTAssertEqual(LibraryArrangement.togglingPin(["a", "b"], id: "a"), ["b"])
    }

    func testEmptyStates() {
        XCTAssertEqual(LibraryEmptyState.pick(offline: true, showLiked: false, shownCount: 0, query: "", filter: nil, loading: false, settled: false, likedCountKnown: false), .nothingDownloaded)
        XCTAssertEqual(LibraryEmptyState.pick(offline: false, showLiked: true, shownCount: 0, query: "", filter: nil, loading: false, settled: true, likedCountKnown: true), .createFirst)
        XCTAssertNil(LibraryEmptyState.pick(offline: false, showLiked: true, shownCount: 0, query: "", filter: nil, loading: false, settled: false, likedCountKnown: true))
        XCTAssertEqual(LibraryEmptyState.pick(offline: false, showLiked: false, shownCount: 0, query: " zz ", filter: nil, loading: false, settled: true, likedCountKnown: true), .noMatch("zz"))
        XCTAssertEqual(LibraryEmptyState.pick(offline: false, showLiked: false, shownCount: 0, query: "", filter: .artist, loading: false, settled: true, likedCountKnown: true), .noArtists)
        XCTAssertEqual(LibraryEmptyState.pick(offline: false, showLiked: false, shownCount: 0, query: "", filter: .album, loading: false, settled: true, likedCountKnown: true), .noAlbums)
        XCTAssertNil(LibraryEmptyState.pick(offline: false, showLiked: false, shownCount: 0, query: "", filter: .album, loading: true, settled: true, likedCountKnown: true))
    }
}

final class LibraryDragTests: XCTestCase {
    private func listRows(_ n: Int, folderAt: Int? = nil) -> [LibraryDrag.Row] {
        (0..<n).map { LibraryDrag.Row(id: "r\($0)", folder: $0 == folderAt, rect: CGRect(x: 16, y: CGFloat($0) * 80, width: 361, height: 80)) }
    }

    func testHalvesPickBeforeOrAfter() {
        let rows = listRows(4)
        let start = LibraryDrag.Target(to: 0, into: nil)
        // Lifted row 0; finger over row 2's upper half -> slot 1 (before it among the others).
        XCTAssertEqual(LibraryDrag.target(rows, from: 0, current: start, at: CGPoint(x: 100, y: 170), canEnter: true), .init(to: 1, into: nil))
        XCTAssertEqual(LibraryDrag.target(rows, from: 0, current: start, at: CGPoint(x: 100, y: 230), canEnter: true), .init(to: 2, into: nil))
        // Above everything / below everything.
        XCTAssertEqual(LibraryDrag.target(rows, from: 2, current: .init(to: 2), at: CGPoint(x: 100, y: -20), canEnter: true).to, 0)
        XCTAssertEqual(LibraryDrag.target(rows, from: 0, current: start, at: CGPoint(x: 100, y: 999), canEnter: true).to, 3)
    }

    func testFolderMiddleBand() {
        let rows = listRows(3, folderAt: 2)
        let t = LibraryDrag.target(rows, from: 0, current: .init(to: 0), at: CGPoint(x: 100, y: 200), canEnter: true)
        XCTAssertEqual(t.into, "r2")
        XCTAssertNil(LibraryDrag.target(rows, from: 0, current: .init(to: 0), at: CGPoint(x: 100, y: 200), canEnter: false).into)
        XCTAssertNil(LibraryDrag.dropLine(rows, from: 0, target: t))
    }

    func testShiftsAndLine() {
        let rows = listRows(3)
        // Lifted 0 aimed at slot 2: rows 1 and 2 move up one place.
        XCTAssertEqual(LibraryDrag.shift(rows, from: 0, to: 2, 1), CGSize(width: 0, height: -80))
        XCTAssertEqual(LibraryDrag.shift(rows, from: 0, to: 2, 2), CGSize(width: 0, height: -80))
        XCTAssertEqual(LibraryDrag.shift(rows, from: 0, to: 1, 2), .zero)
        XCTAssertNil(LibraryDrag.dropLine(rows, from: 1, target: .init(to: 1)))
        XCTAssertEqual(LibraryDrag.dropLine(rows, from: 0, target: .init(to: 2)), CGRect(x: 20, y: 199, width: 353, height: 2))
    }

    func testGridUsesLeftRightHalves() {
        let rows = (0..<4).map { i in LibraryDrag.Row(id: "g\(i)", folder: false, rect: CGRect(x: i % 2 == 0 ? 16 : 204, y: CGFloat(i / 2) * 220, width: 172, height: 210)) }
        XCTAssertEqual(LibraryDrag.target(rows, from: 0, current: .init(to: 0), at: CGPoint(x: 350, y: 300), canEnter: true).to, 3)
        XCTAssertEqual(LibraryDrag.target(rows, from: 0, current: .init(to: 0), at: CGPoint(x: 220, y: 300), canEnter: true).to, 2)
    }

    func testAutoScroll() {
        XCTAssertEqual(LibraryDrag.autoScroll(y: 0, height: 600), -18)
        XCTAssertEqual(LibraryDrag.autoScroll(y: 28, height: 600), -9)
        XCTAssertEqual(LibraryDrag.autoScroll(y: 300, height: 600), 0)
        XCTAssertEqual(LibraryDrag.autoScroll(y: 600, height: 600), 18)
    }
}

final class LibraryTextTests: XCTestCase {
    func testMovedUsesFinalIndexes() {
        // A song drag's slot is its final index, the server's `{from, to}` (web splice).
        XCTAssertEqual(LibraryText.moved(["a", "b", "c", "d"], from: 3, to: 0), ["d", "a", "b", "c"])
        XCTAssertEqual(LibraryText.moved(["a", "b", "c", "d"], from: 0, to: 2), ["b", "c", "a", "d"])
    }

    func testTotalShort() {
        XCTAssertEqual(LibraryText.totalShort(ms: 579_400), Localizer.fill(L("{m}min {sec}sec"), ["m": 9, "sec": 39]))
        XCTAssertEqual(LibraryText.totalShort(ms: 11_220_000), Localizer.fill(L("{h}h {m}min"), ["h": 3, "m": 7]))
    }

    func testFindMatchesEveryWord() {
        let t = track("1", "Paranoid Android", artist: "Radiohead", album: "OK Computer")
        XCTAssertTrue(LibraryText.matches(t, query: "android radio"))
        XCTAssertTrue(LibraryText.matches(t, query: "ＯＫ"))
        XCTAssertFalse(LibraryText.matches(t, query: "android blur"))
        XCTAssertTrue(LibraryText.matches(t, query: "  "))
    }

    func testLikedOrderNewestFirstThenSort() {
        let rows = ["a": track("a", "Zebra", artist: "Beta", album: "m"), "b": track("b", "apple", artist: "alpha", album: "z"), "c": track("c", "Mango", artist: "Gamma", album: "a")]
        let at: [String: Double] = ["a": 3, "b": 1, "c": 2, "missing": 9]
        XCTAssertEqual(LibraryText.likedOrder(at, rows: rows, sort: .recent).map(\.id), ["a", "c", "b"])
        XCTAssertEqual(LibraryText.likedOrder(at, rows: rows, sort: .title).map(\.id), ["b", "c", "a"])
        XCTAssertEqual(LibraryText.likedOrder(at, rows: rows, sort: .artist).map(\.id), ["b", "a", "c"])
        XCTAssertEqual(LibraryText.likedOrder(at, rows: rows, sort: .album).map(\.id), ["c", "a", "b"])
    }

    func testOpenFoldersPersist() {
        let d = UserDefaults(suiteName: "library-tests-\(UUID().uuidString)")!
        XCTAssertEqual(LibraryOpenFolders.load(d), [])
        LibraryOpenFolders.save(["fd2", "fd1"], d)
        XCTAssertEqual(d.string(forKey: LibraryOpenFolders.key), #"["fd1","fd2"]"#)
        XCTAssertEqual(LibraryOpenFolders.load(d), ["fd1", "fd2"])
    }

    func testRevShape() {
        XCTAssertNotNil(LibraryStore.newRev().range(of: "^r[0-9a-z]+$", options: .regularExpression))
        XCTAssertLessThanOrEqual(LibraryStore.newRev().count, 64)
    }
}

/// Layout saves are optimistic and roll back when the server refuses (Sidebar.jsx `commit`).
@MainActor
final class LibraryStoreCommitTests: XCTestCase {
    final class LibraryStubProtocol: URLProtocol {
        nonisolated(unsafe) static var putStatus = 200
        nonisolated(unsafe) static var revs: [String] = []
        override class func canInit(with request: URLRequest) -> Bool { true }
        override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
        override func startLoading() {
            let path = request.url?.path ?? ""
            var status = 200
            var body = "{}"
            if path.hasSuffix("/api/library/layout") && request.httpMethod == "PUT" {
                Self.revs.append(request.value(forHTTPHeaderField: "X-Slopify-Rev") ?? "")
                status = Self.putStatus
                body = status == 200 ? #"{"order":["p2","p1"],"folders":[]}"# : #"{"error":"nope"}"#
            } else if path.hasSuffix("/api/library/layout") {
                body = #"{"order":["p1","p2"],"folders":[]}"#
            } else if path.hasSuffix("/api/playlists") {
                body = #"{"items":[{"id":"p1","name":"One","userId":"u","created":1,"updated":1,"trackCount":0,"cover":null,"aiPrompt":null},{"id":"p2","name":"Two","userId":"u","created":1,"updated":1,"trackCount":0,"cover":null,"aiPrompt":null}]}"#
            } else if path.hasSuffix("/api/likes/albums") || path.hasSuffix("/api/likes/artists") {
                body = #"{"items":[]}"#
            }
            let r = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: r, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(body.utf8))
            client?.urlProtocolDidFinishLoading(self)
        }
        override func stopLoading() {}
    }

    private func makeStore() -> (LibraryStore, APIClient) {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [LibraryStubProtocol.self]
        let api = APIClient(baseURL: URL(string: "https://example.invalid")!, token: "t", session: URLSession(configuration: cfg))
        let store = LibraryStore()
        store.attach(api: api, userId: "test-\(UUID().uuidString)")
        return (store, api)
    }

    private func wait(_ cond: () -> Bool) async {
        for _ in 0..<200 where !cond() { try? await Task.sleep(nanoseconds: 10_000_000) }
    }

    func testRefreshThenSavedLayoutWins() async {
        LibraryStubProtocol.putStatus = 200; LibraryStubProtocol.revs = []
        let (store, api) = makeStore()
        defer { withExtendedLifetime(api) {} } // the store holds the client weakly (Account owns it)
        await store.refresh()
        await wait { store.layout != nil }
        XCTAssertEqual(store.playlists.map(\.id), ["p1", "p2"])
        XCTAssertFalse(store.loading)
        let a = store.arrangement(pinned: [])
        var d = a.draft(layout: store.layout)
        d.order = ["p2", "p1"]
        store.saveArrangement(d)
        XCTAssertEqual(store.layout?.order, ["p2", "p1"]) // shown at once
        await wait { !LibraryStubProtocol.revs.isEmpty }
        XCTAssertTrue(LibraryStubProtocol.revs[0].hasPrefix("r"))
        try? await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(store.layout?.order, ["p2", "p1"])
    }

    func testRefusedSaveRollsBack() async {
        LibraryStubProtocol.putStatus = 500; LibraryStubProtocol.revs = []
        let (store, api) = makeStore()
        defer { withExtendedLifetime(api) {} } // the store holds the client weakly (Account owns it)
        await store.refresh()
        await wait { store.layout != nil }
        let before = store.layout?.order
        var d = store.arrangement(pinned: []).draft(layout: store.layout)
        d.order = ["p2", "p1"]
        store.saveArrangement(d)
        XCTAssertEqual(store.layout?.order, ["p2", "p1"])
        await wait { store.layout?.order == before }
        XCTAssertEqual(store.layout?.order, before)
    }
}

/// The live drag shared by Your Library and playlist songs, all in list coordinates: a still
/// hold is the menu, a move lands in a slot (the playlist sends it as `{from, to}`).
@MainActor
final class LibraryDragControllerTests: XCTestCase {
    private func songs(_ n: Int) -> [LibraryDrag.Row] {
        (0..<n).map { LibraryDrag.Row(id: "s\($0)", folder: false, rect: CGRect(x: 0, y: CGFloat($0) * 64, width: 393, height: 64)) }
    }

    func testStillHoldIsTheMenu() {
        let c = LibraryDragController()
        c.begin(id: "s1", rows: songs(4), at: CGPoint(x: 100, y: 100))
        c.move(to: CGPoint(x: 103, y: 104))
        XCTAssertEqual(c.end(), .hold("s1"))
        XCTAssertFalse(c.isLifted)
    }

    func testDragDownLandsInFinalSlot() {
        let c = LibraryDragController()
        c.begin(id: "s0", rows: songs(4), at: CGPoint(x: 100, y: 30))
        c.move(to: CGPoint(x: 100, y: 30 + 64 * 2 + 40))
        XCTAssertEqual(c.offset(for: "s0").height, 64 * 2 + 40) // under the finger
        XCTAssertEqual(c.offset(for: "s1").height, -64)         // slid up out of the way
        XCTAssertEqual(c.end(), .drop(id: "s0", to: 2, into: nil, rows: ["s0", "s1", "s2", "s3"]))
    }

    func testMovedBackIsNoDrop() {
        let c = LibraryDragController()
        c.begin(id: "s2", rows: songs(4), at: CGPoint(x: 100, y: 150))
        c.move(to: CGPoint(x: 100, y: 60))   // aims at slot 1
        // Back over the lower half of s1 (now slid down into slot 2): its own slot again.
        c.move(to: CGPoint(x: 100, y: 170))
        XCTAssertNil(c.end())
    }

    func testListScrollingUnderStillFingerRetargets() {
        // Auto-scroll: the finger stays put on screen but its list point moves 3 rows down.
        let c = LibraryDragController()
        c.begin(id: "s0", rows: songs(8), at: CGPoint(x: 100, y: 30))
        c.move(to: CGPoint(x: 100, y: 40))
        c.move(to: CGPoint(x: 100, y: 40 + 64 * 3))
        XCTAssertEqual(c.lift?.target.to, 3)
        XCTAssertEqual(c.end(), .drop(id: "s0", to: 3, into: nil, rows: (0..<8).map { "s\($0)" }))
    }

    func testCancelPutsBack() {
        let c = LibraryDragController()
        c.begin(id: "s0", rows: songs(4), at: CGPoint(x: 100, y: 30))
        c.move(to: CGPoint(x: 100, y: 200))
        c.cancel()
        XCTAssertFalse(c.isLifted)
        XCTAssertNil(c.end())
        XCTAssertEqual(c.offset(for: "s0"), .zero)
    }

    func testRecognizerOnlyBeginsOverADragRow() {
        // Flat mode / Liked Songs / hero: no row under the finger, so the scroll view keeps the touch.
        let c = LibraryDragController()
        XCTAssertNil(c.rowId(at: CGPoint(x: 100, y: 30)))
        c.rows = { [LibraryDrag.Row(id: "a", folder: false, rect: CGRect(x: 16, y: 80, width: 361, height: 80))] }
        XCTAssertNil(c.rowId(at: CGPoint(x: 100, y: 40)))   // the Liked row above
        XCTAssertEqual(c.rowId(at: CGPoint(x: 100, y: 120)), "a")
    }
}
