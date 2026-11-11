import XCTest
@testable import Slopify

private func detailTrack(_ id: String, artists: [String] = ["A"], ids: [String] = ["a1"], album: String = "Alb", albumId: String = "al1", plays: Int? = nil) -> Track {
    Track(id: id, title: "T\(id)", artist: artists.joined(separator: ", "), artists: artists, artistIds: ids, albumId: albumId, album: album,
          albumArtist: artists.first ?? "", trackNo: nil, discNo: nil, year: nil, genres: nil, durationMs: 1000, codec: nil, bitrate: nil,
          cover: nil, format: nil, gain: nil, addedAt: nil, plays: plays)
}

private func detailRelease(_ title: String, type: String? = "Album", year: String? = nil, date: String? = nil, inLib: String? = nil, mbid: String? = nil, status: String? = nil) -> Release {
    Release(album_id: mbid, title: title, artist: nil, rtype: type, year: year, date: date, image: nil, total_tracks: nil,
            inLibrary: inLib, localName: nil, artistId: nil, requestStatus: status)
}

@MainActor
final class DetailLogicTests: XCTestCase {
    func testReleaseTypeOrder() {
        XCTAssertEqual(DetailLogic.releaseType(name: "Hits", albumArtist: "Various Artists", count: 2, durationMs: nil), "Compilation")
        XCTAssertEqual(DetailLogic.releaseType(name: "Night Drive EP", albumArtist: "X", count: 12, durationMs: 3_600_000), "EP")
        XCTAssertEqual(DetailLogic.releaseType(name: "Song - EP", albumArtist: "X", count: 12, durationMs: nil), "EP")
        XCTAssertEqual(DetailLogic.releaseType(name: "Song – Single", albumArtist: "X", count: 12, durationMs: nil), "Single")
        XCTAssertEqual(DetailLogic.releaseType(name: "Song (single)", albumArtist: "X", count: 12, durationMs: nil), "Single")
        XCTAssertEqual(DetailLogic.releaseType(name: "Short", albumArtist: "X", count: 3, durationMs: 10 * 60_000), "Single")
        XCTAssertEqual(DetailLogic.releaseType(name: "Mid", albumArtist: "X", count: 5, durationMs: nil), "EP")
        XCTAssertEqual(DetailLogic.releaseType(name: "Long few", albumArtist: "X", count: 3, durationMs: 40 * 60_000), "Album")
        XCTAssertEqual(DetailLogic.releaseType(name: "Unknown", albumArtist: "X", count: nil, durationMs: nil), "Album")
        // "Deep" ends in "ep" but not as a word.
        XCTAssertEqual(DetailLogic.releaseType(name: "Deep", albumArtist: "X", count: 10, durationMs: nil), "Album")
    }

    func testPopularOrderPutsKnownFirstAndKeepsRest() {
        let ts = ["a", "b", "c", "d"].map { detailTrack($0) }
        XCTAssertEqual(DetailLogic.popularOrder(ts, ids: ["c", "x", "a"]).map(\.id), ["c", "a", "b", "d"])
        XCTAssertEqual(DetailLogic.popularOrder(ts, ids: []).map(\.id), ["a", "b", "c", "d"])
    }

    func testPlaysSubtitle() {
        let en = Locale(identifier: "en_US")
        XCTAssertEqual(DetailLogic.playsSubtitle(detailTrack("a", plays: 1), locale: en), L("1 play"))
        XCTAssertEqual(DetailLogic.playsSubtitle(detailTrack("a", plays: 1234), locale: en), L("{n} plays", ["n": "1,234"]))
        XCTAssertEqual(DetailLogic.playsSubtitle(detailTrack("a", album: "OK", plays: 0), locale: en), "OK")
    }

    func testEntriesMergeLibraryOnlyAlbumsAndSortNewest() {
        let rels = [detailRelease("Old", year: "1999", inLib: "L1"), detailRelease("New", type: "Single", year: "2020", date: "2020-05-01", mbid: "m2"),
                    detailRelease("New2", type: "", year: "2020", date: "2020-09-01", mbid: "m3")]
        let albums = [Album(id: "L1", name: "Old", artist: "A", year: 1999), Album(id: "L9", name: "Lib only", artist: "A", year: 2010, trackCount: 12)]
        let e = DetailLogic.entries(releases: rels, albums: albums)
        XCTAssertEqual(e.count, 4, "L1 listed by the catalogue is not added twice")
        XCTAssertEqual(e.last?.inLib, "L9")
        XCTAssertEqual(e[2].type, "Album", "empty rtype falls back to Album")
        XCTAssertEqual(DetailLogic.newestFirst(e).map(\.title), ["New2", "New", "Lib only", "Old"])
    }

    func testFilters() {
        let e = DetailLogic.entries(releases: [detailRelease("A", year: "2001", inLib: "x"), detailRelease("S", type: "Single", year: "2002"),
                                               detailRelease("C", type: "Compilation", year: "2003")], albums: [])
        XCTAssertEqual(DetailLogic.typeFilters(e), [.all, .album, .single, .compilation])
        XCTAssertEqual(DetailLogic.filtered(e, type: .all, lib: .missing).map(\.title), ["C", "S"])
        XCTAssertEqual(DetailLogic.filtered(e, type: .single, lib: .all).map(\.title), ["S"])
        XCTAssertEqual(DetailLogic.filtered(e, type: .all, lib: .have).map(\.title), ["A"])
        XCTAssertEqual(e[0].subtitle, "2001 • \(L("Album"))")
    }

    func testRequestStateAndLabels() {
        XCTAssertEqual(DetailLogic.requestState(mine: "queued", server: nil), "queued")
        XCTAssertEqual(DetailLogic.requestState(mine: "queued", server: "failed"), "queued", "a retry must not flash the old failure")
        XCTAssertEqual(DetailLogic.requestState(mine: "queued", server: "downloading"), "downloading")
        XCTAssertEqual(DetailLogic.requestState(mine: nil, server: "failed"), "failed")
        XCTAssertEqual(DetailLogic.requestLabel(nil).key, "Request")
        XCTAssertEqual(DetailLogic.requestLabel("exists").key, "Requested")
        XCTAssertTrue(DetailLogic.requestLabel("downloading").busy)
        XCTAssertEqual(DetailLogic.requestLabel("failed").key, "Retry")
        XCTAssertFalse(DetailLogic.requestLabel("error").busy)
    }

    func testAlbumStats() {
        let a = Album(id: "x", name: "OK Computer", artist: "Radiohead", year: 1997, trackCount: 12, durationMs: 53 * 60_000)
        XCTAssertEqual(DetailLogic.albumStats(a, tracks: []), "\(L("Album")) • 1997")
        let b = Album(id: "y", name: "Thing", artist: "R", year: nil, trackCount: nil, durationMs: nil)
        XCTAssertEqual(DetailLogic.albumStats(b, tracks: [detailTrack("1")]), L("Single"))
    }
}

@MainActor
final class DetailCacheTests: XCTestCase {
    func testRoundTripPerScopeAndTrim() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("detail-cache-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let c = DetailCache(dir: dir)
        c.save(["x": 1], "al.1", scope: "u1")
        XCTAssertEqual(c.load("al.1", scope: "u1", as: [String: Int].self), ["x": 1])
        XCTAssertNil(c.load("al.1", scope: "u2", as: [String: Int].self))
        // A fresh instance reads from disk.
        XCTAssertEqual(DetailCache(dir: dir).load("al.1", scope: "u1", as: [String: Int].self), ["x": 1])
        for i in 0..<(DetailCache.limit + 5) { c.save([i], "al.n\(i)", scope: "u1") }
        let files = try FileManager.default.contentsOfDirectory(atPath: dir.path)
        XCTAssertEqual(files.count, DetailCache.limit)
    }

    func testAlbumDetailDecodesFromAPIShape() throws {
        let json = """
        {"id":"al1","name":"OK Computer","artist":"Radiohead","artistId":"ar1","year":1997,"trackCount":1,"durationMs":383000,"cover":null,"addedAt":1,
         "tracks":[{"id":"t1","title":"Paranoid Android","artist":"Radiohead","artists":["Radiohead"],"artistIds":["ar1"],"albumId":"al1","album":"OK Computer",
         "albumArtist":"Radiohead","trackNo":2,"discNo":1,"year":1997,"genres":[],"durationMs":383000,"codec":"FLAC","bitrate":1011000,"cover":null}]}
        """
        let d = try JSONDecoder().decode(AlbumDetail.self, from: Data(json.utf8))
        XCTAssertEqual(d.album.artistId, "ar1")
        XCTAssertEqual(d.tracks.first?.artistCredits.first?.id, "ar1")
        // Kept copies survive a round trip.
        let again = try JSONDecoder().decode(AlbumDetail.self, from: JSONEncoder().encode(d))
        XCTAssertEqual(again.tracks, d.tracks)
    }
}
