import XCTest
@testable import Slopify

// Fixtures shaped like API.md §5.
private func searchTrack(_ id: String, _ title: String, artists: [String] = ["Radiohead"], album: String = "a1") -> Track {
    Track(id: id, title: title, artist: artists.joined(separator: ", "), artists: artists, artistIds: artists.map { "id-\($0)" },
          albumId: album, album: "OK Computer", albumArtist: "Radiohead", trackNo: nil, discNo: nil, year: 1997, genres: nil,
          durationMs: 1000, codec: nil, bitrate: nil, cover: nil, format: nil, gain: nil, addedAt: nil, plays: nil)
}
private func searchAlbum(_ id: String, _ name: String, year: Int? = 1997) -> Album { Album(id: id, name: name, artist: "Radiohead", year: year) }
private func searchArtist(_ id: String, _ name: String) -> Artist { Artist(id: id, name: name) }
private func searchPlaylist(_ id: String, _ name: String) -> Playlist { Playlist(id: id, name: name) }

final class SearchLogicTests: XCTestCase {
    func testTopResultPrefersArtistThenAlbumThenSongPrefix() {
        let r = SearchResults(tracks: [searchTrack("t1", "Karma Police")], albums: [searchAlbum("al", "Kid A")], artists: [searchArtist("ar", "Radiohead")])
        XCTAssertEqual(SearchLogic.topResult(query: "radio", results: r)?.key, "Artist:ar")
        XCTAssertEqual(SearchLogic.topResult(query: "KID", results: r)?.key, "Album:al")
        XCTAssertEqual(SearchLogic.topResult(query: "karma", results: r)?.key, "Song:t1")
        // No prefix match: first artist.
        XCTAssertEqual(SearchLogic.topResult(query: "zzz", results: r)?.key, "Artist:ar")
        XCTAssertNil(SearchLogic.topResult(query: "x", results: SearchResults(tracks: [], albums: [], artists: [])))
    }

    func testTopResultNormalisesNFKC() {
        let r = SearchResults(tracks: [], albums: [], artists: [searchArtist("ar", "ＡＢＢＡ")])
        XCTAssertEqual(SearchLogic.topResult(query: "abba", results: r)?.key, "Artist:ar")
    }

    func testPhoneRowsOrderAndDedupe() {
        let tracks = (1...6).map { searchTrack("t\($0)", "Song \($0)") }
        let artists = (1...3).map { searchArtist("r\($0)", "Zed \($0)") }
        let albums = (1...3).map { searchAlbum("a\($0)", "Album \($0)") }
        let res = SearchResults(tracks: tracks, albums: albums, artists: artists)
        let page = SearchPage(query: "zed", results: res, playlists: [searchPlaylist("p1", "zed mix"), searchPlaylist("p2", "Zed two"), searchPlaylist("p3", "other")])
        let keys = SearchLogic.phoneRows(page, type: .all).map(\.key)
        XCTAssertEqual(keys, ["Artist:r1", "Song:t1", "Song:t2", "Song:t3", "Song:t4", "Artist:r2", "Album:a1", "Album:a2", "Playlist:p1",
                              "Song:t5", "Song:t6", "Artist:r3", "Album:a3", "Playlist:p2"])
        XCTAssertEqual(Set(keys).count, keys.count)
    }

    func testPhoneRowsFilterByType() {
        let res = SearchResults(tracks: [searchTrack("t1", "x")], albums: [searchAlbum("a1", "x")], artists: [searchArtist("r1", "x")])
        let page = SearchPage(query: "x", results: res, playlists: [])
        XCTAssertEqual(SearchLogic.phoneRows(page, type: .albums).map(\.key), ["Album:a1"])
        XCTAssertEqual(SearchLogic.phoneRows(page, type: .songs).map(\.key), ["Song:t1"])
        XCTAssertEqual(SearchLogic.phoneRows(page, type: .everywhere), [])
    }

    func testPlaylistsFilteredBySubstringCaseInsensitive() {
        let page = SearchPage(query: "Road", results: SearchResults(tracks: [], albums: [], artists: []),
                              playlists: [searchPlaylist("p1", "Road Trip"), searchPlaylist("p2", "Crossroads"), searchPlaylist("p3", "Gym")])
        XCTAssertEqual(page.playlists.map(\.id), ["p1", "p2"])
    }

    func testSubtitlesAreLocalisedAndDropEmptyParts() {
        XCTAssertEqual(SearchItem.album(searchAlbum("a", "Kid A", year: nil)).subtitle, "\(L("Album")) • Radiohead")
        XCTAssertEqual(SearchItem.album(searchAlbum("a", "Kid A")).subtitle, "\(L("Album")) • 1997 • Radiohead")
        XCTAssertEqual(SearchItem.song(searchTrack("t", "x", artists: ["A", "B"])).subtitle, "\(L("Song")) • A, B")
        // No artists: falls back to the album artist.
        XCTAssertEqual(SearchItem.song(searchTrack("t", "x", artists: [])).subtitle, "\(L("Song")) • Radiohead")
        XCTAssertEqual(SearchItem.artist(searchArtist("r", "x")).subtitle, L("Artist"))
    }

    func testTileColoursCycleThroughSixteen() {
        XCTAssertEqual(SearchLogic.tileColor(0).hex, "#e13300")
        XCTAssertEqual(SearchLogic.tileColor(15).hex, "#e61e32")
        XCTAssertEqual(SearchLogic.tileColor(16).hex, "#e13300")
        let tiles = [BrowseTile(id: "genre:Rock", name: "Rock"), BrowseTile(id: "genre:Jazz", name: "Jazz")]
        XCTAssertEqual(SearchBrowseData.tileColor(genre: "Jazz", tiles: tiles)?.hex, "#1e3264")
        XCTAssertNil(SearchBrowseData.tileColor(genre: "Pop", tiles: tiles))
    }

    func testGenreHeroUsesTileColour() {
        // UI.md 6.3.1 table: #1e3264 -> #18233e, default #3d3c3c -> #2a2929.
        XCTAssertEqual(ColorMath.heroTint(SearchLogic.tileColor(1)).hex, "#18233e")
        XCTAssertEqual(ColorMath.heroTint(Theme.Fixed.defaultHero).hex, "#2a2929")
        XCTAssertEqual(ColorMath.heroTint(Theme.Fixed.radarHero).hex, "#402d4d")
    }

    func testTopArtistRanking() {
        var a = searchTrack("1", "x", artists: ["A"]); a.plays = 1
        var b = searchTrack("2", "x", artists: ["B"]); b.plays = 5
        let c = searchTrack("3", "x", artists: ["A", "C"])
        XCTAssertEqual(SearchLogic.topArtistIds([a, b, c]), ["id-B", "id-A", "id-C"])
    }

    @MainActor func testChartsAlbumsFromTracks() {
        let t = [searchTrack("1", "x", album: "a1"), searchTrack("2", "y", album: "a2"), searchTrack("3", "z", album: "a1")]
        XCTAssertEqual(SearchBrowsePage.albumsFromTracks(t, unknown: "?").map(\.id), ["a1", "a2"])
    }

    func testRequestStates() {
        XCTAssertEqual(SearchRequestState.state(server: nil, mine: "queued"), "queued")
        XCTAssertEqual(SearchRequestState.state(server: "failed", mine: "queued"), "queued")
        XCTAssertEqual(SearchRequestState.state(server: "downloading", mine: "queued"), "downloading")
        XCTAssertEqual(SearchRequestState.state(server: "failed", mine: nil), "failed")
        XCTAssertEqual(SearchRequestState.ui(nil).label, L("Request"))
        XCTAssertTrue(SearchRequestState.ui("exists").busy)
        XCTAssertEqual(SearchRequestState.ui("failed").label, L("Retry"))
        XCTAssertFalse(SearchRequestState.ui("error").busy)
    }
}

final class SearchRecentTests: XCTestCase {
    func testEntryFromSongUsesAlbumAsArt() {
        let e = SearchRecent(query: "  karma ", item: .song(searchTrack("t1", "Karma Police")))
        XCTAssertEqual(e.q, "karma")
        XCTAssertEqual(e.kind, .song)
        XCTAssertEqual(e.art, "a1")
        XCTAssertEqual(e.sub, "\(L("Song")) • Radiohead")
        XCTAssertEqual(SearchRecent(query: "x", item: .artist(searchArtist("r", "R"))).art, "r")
    }

    func testAddMovesToTopAndCapsAtTen() {
        var list: [SearchRecent] = []
        for i in 0..<12 { list = SearchRecent.adding(SearchRecent(q: "", kind: .album, id: "a\(i)", art: nil, name: "", sub: ""), to: list) }
        XCTAssertEqual(list.count, 10)
        XCTAssertEqual(list.first?.id, "a11")
        list = SearchRecent.adding(SearchRecent(q: "", kind: .album, id: "a5", art: nil, name: "", sub: ""), to: list)
        XCTAssertEqual(list.first?.id, "a5")
        XCTAssertEqual(list.filter { $0.id == "a5" }.count, 1)
        // Same id, other kind: a separate entry.
        list = SearchRecent.adding(SearchRecent(q: "", kind: .artist, id: "a5", art: nil, name: "", sub: ""), to: list)
        XCTAssertEqual(list.filter { $0.id == "a5" }.count, 2)
    }

    func testPrefsRoundTripIgnoresJunk() throws {
        let json = #"["old string", {"q":"x","kind":"Artist","id":"r1","art":"r1","name":"Radiohead","sub":"Artist"}, {"kind":"Album"}, {"kind":"Nope","id":"z"}]"#
        let v = try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))
        let list = SearchRecent.list(v)
        XCTAssertEqual(list.map(\.key), ["Artist:r1"])
        XCTAssertEqual(SearchRecent.list(SearchRecent.json(list)), list)
        XCTAssertEqual(SearchRecent(q: "", kind: .song, id: "s", art: nil, name: "", sub: "").subtitle, L("Song"))
    }
}

/// Records calls; replies can be delayed per query. Closures hold the fake strongly: a model task can outlive its test.
@MainActor private final class SearchFakeBackend {
    var calls: [String] = []
    var delays: [String: Duration] = [:]
    var fail: Error?
    var everywhere: Result<EverywhereResults, Error> = .success(EverywhereResults(albums: [], artists: []))
    var everywhereCalls = 0
    var requestStatus: String? = "queued"

    var backend: SearchModel.Backend {
        SearchModel.Backend(
            search: { q in
                self.calls.append(q)
                if let d = self.delays[q] { try await Task.sleep(for: d) }
                if let e = self.fail { throw e }
                return SearchResults(tracks: [searchTrack("t-\(q)", q)], albums: [], artists: [])
            },
            playlists: { [searchPlaylist("p1", "abc list")] },
            everywhere: { _ in self.everywhereCalls += 1; return try self.everywhere.get() },
            request: { _ in self.requestStatus })
    }
}

@MainActor
final class SearchModelTests: XCTestCase {
    private func make(_ fake: SearchFakeBackend) -> SearchModel {
        let m = SearchModel(backend: fake.backend)
        m.searchDelay = .milliseconds(30)
        m.everywhereDelay = .milliseconds(30)
        m.pollInterval = .milliseconds(30)
        return m
    }

    /// Polls the main actor until `cond` holds (2 s cap, never hangs).
    private func searchWait(_ cond: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
        for _ in 0..<200 where !cond() { try? await Task.sleep(for: .milliseconds(10)) }
        XCTAssertTrue(cond(), "timed out", file: file, line: line)
    }

    func testDebounceSendsOnlyTheLastQuery() async {
        let fake = SearchFakeBackend(), m = make(fake)
        m.setQuery("a"); m.setQuery("ab"); m.setQuery("abc")
        await searchWait { m.page != nil }
        XCTAssertEqual(fake.calls, ["abc"])
        XCTAssertEqual(m.page?.query, "abc")
        XCTAssertEqual(m.page?.playlists.map(\.id), ["p1"])
        XCTAssertTrue(m.showsChips)
    }

    func testOlderReplyNeverOverwritesNewer() async {
        let fake = SearchFakeBackend(), m = make(fake)
        fake.delays["slow"] = .milliseconds(300)
        m.setQuery("slow")
        await searchWait { fake.calls == ["slow"] }
        m.setQuery("fast")
        await searchWait { m.page?.query == "fast" }
        try? await Task.sleep(for: .milliseconds(400))
        XCTAssertEqual(m.page?.query, "fast")
    }

    func testResultsStayWhileTypingAndClearOnEmpty() async {
        let fake = SearchFakeBackend(), m = make(fake)
        m.setQuery("abc")
        await searchWait { m.page != nil }
        fake.delays["abcd"] = .milliseconds(200)
        m.setQuery("abcd")
        XCTAssertEqual(m.page?.query, "abc")
        m.setQuery("   ")
        XCTAssertNil(m.page)
        XCTAssertNil(m.rows)
        XCTAssertFalse(m.focusMode)
    }

    func testFocusModeAndCancel() {
        let m = make(SearchFakeBackend())
        XCTAssertFalse(m.focusMode)
        m.focused = true
        XCTAssertTrue(m.focusMode)
        m.setQuery("x")
        m.cancel()
        XCTAssertEqual(m.query, "")
        XCTAssertFalse(m.focusMode)
        m.setQuery("y"); m.leftTab()
        XCTAssertTrue(m.focusMode) // a query keeps focus mode after leaving the tab
    }

    func testErrorShowsBannerButOfflineDoesNot() async {
        let fake = SearchFakeBackend(), m = make(fake)
        fake.fail = APIError.http(500, "boom")
        m.setQuery("x")
        await searchWait { m.error != nil }
        XCTAssertEqual(m.error, "boom")
        fake.fail = APIError.offline
        m.clearError()
        m.setQuery("xy")
        try? await Task.sleep(for: .milliseconds(150))
        XCTAssertNil(m.error)
    }

    func testEverywhereWaitsThenLoadsOrFails() async {
        let fake = SearchFakeBackend(), m = make(fake)
        m.setQuery("abc")
        XCTAssertNil(m.everywhere)
        m.setType(.everywhere)
        guard case .waiting? = m.everywhere else { return XCTFail("not waiting") }
        await searchWait { if case .loaded? = m.everywhere { true } else { false } }
        XCTAssertNil(m.rows)
        fake.everywhere = .failure(APIError.offline)
        m.setQuery("abcd")
        await searchWait { if case .failed? = m.everywhere { true } else { false } }
        XCTAssertNil(m.error)
        m.setType(.all)
        XCTAssertNil(m.everywhere)
    }

    func testRequestMarksPendingAndPolls() async {
        let fake = SearchFakeBackend(), m = make(fake)
        let rel = Release(album_id: "mb1", title: "Kid A")
        fake.everywhere = .success(EverywhereResults(albums: [rel], artists: []))
        m.setType(.everywhere)
        m.setQuery("kid")
        await searchWait { if case .loaded? = m.everywhere { true } else { false } }
        XCTAssertFalse(m.hasPending)
        fake.requestStatus = "exists"
        await m.request(rel)
        XCTAssertEqual(m.state(of: rel), "exists")
        XCTAssertTrue(m.hasPending)
        let before = fake.everywhereCalls
        await searchWait { fake.everywhereCalls > before }
        // The server now has it: polling stops.
        var owned = rel; owned.inLibrary = "al1"
        fake.everywhere = .success(EverywhereResults(albums: [owned], artists: []))
        await searchWait { !m.hasPending }
        let settled = fake.everywhereCalls
        try? await Task.sleep(for: .milliseconds(150))
        XCTAssertEqual(fake.everywhereCalls, settled)
        m.setType(.all)
    }

    func testFailedRequestShowsFailed() async {
        let fake = SearchFakeBackend(), m = make(fake)
        let rel = Release(album_id: "mb2", title: "x")
        m.backend.request = { _ in throw APIError.http(502, "lidarr down") }
        await m.request(rel)
        XCTAssertEqual(m.state(of: rel), "error")
        XCTAssertEqual(SearchRequestState.ui(m.state(of: rel)).label, L("Failed"))
        XCTAssertEqual(m.error, "lidarr down")
        _ = fake
    }
}
