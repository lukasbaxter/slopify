import XCTest
@testable import Slopify

func homeTrack(_ id: String, artists: [(String, String)], plays: Int? = nil, album: String = "al", ms: Int = 1000) -> Track {
    Track(id: id, title: "T\(id)", artist: artists.map(\.0).joined(separator: ", "), artists: artists.map(\.0), artistIds: artists.map(\.1),
          albumId: album, album: "Album", albumArtist: artists.first?.0 ?? "", trackNo: nil, discNo: nil, year: nil, genres: nil,
          durationMs: ms, codec: nil, bitrate: nil, cover: nil, format: nil, gain: nil, addedAt: nil, plays: plays)
}

func homeAlbum(_ id: String, _ name: String = "A") -> Album {
    Album(id: id, name: name, artist: "X", artistId: nil, year: nil, trackCount: nil, durationMs: nil, cover: nil, addedAt: nil, likedAt: nil)
}

func homePlaylist(_ id: String) -> Playlist {
    Playlist(id: id, name: "P\(id)", userId: nil, created: nil, updated: nil, trackCount: nil, cover: nil, aiPrompt: nil)
}

@MainActor
final class HomeLogicTests: XCTestCase {
    override func setUp() { Localizer.shared.setUserPick("en") }

    func testRankTopArtistsScoresOnePlusPlaysAndKeepsTieOrder() {
        let tracks = [
            homeTrack("1", artists: [("A", "a"), ("B", "b")], plays: 2),   // a 3, b 3
            homeTrack("2", artists: [("C", "c")], plays: 5),               // c 6
            homeTrack("3", artists: [("B", "b"), ("Nameless", "")]),        // b 4; empty id skipped
            homeTrack("4", artists: [("D", "d")], plays: 2),               // d 3 (ties a, after it)
        ]
        let r = HomeLogic.rankTopArtists(tracks)
        XCTAssertEqual(r.map(\.id), ["c", "b", "a", "d"])
        XCTAssertEqual(r.map(\.score), [6, 4, 3, 3])
        XCTAssertEqual(r.first?.name, "C")
    }

    func testRecentArtistsNeedsADate() {
        let tracks = [homeTrack("1", artists: [("A", "a")]), homeTrack("2", artists: [("B", "b")])]
        XCTAssertTrue(HomeLogic.recentArtists(tracks) { _ in nil }.isEmpty)
        let dates = ["1": "2026-01-01", "2": "2026-02-01"]
        XCTAssertEqual(HomeLogic.recentArtists(tracks) { dates[$0.id] }.map(\.id), ["b", "a"])
    }

    func testRecentArtistsKeepsTheLatestDateAndCapsAt16() {
        let many = (0..<20).map { homeTrack("\($0)", artists: [("N\($0)", "id\($0)")]) }
        XCTAssertEqual(HomeLogic.recentArtists(many) { _ in "2026" }.count, 16)
        let t = [homeTrack("1", artists: [("A", "a")]), homeTrack("2", artists: [("A", "a"), ("B", "b")])]
        let lp = ["1": "2026-03", "2": "2026-01"]
        XCTAssertEqual(HomeLogic.recentArtists(t) { lp[$0.id] }.map(\.id), ["a", "b"])
    }

    func testTileTitleStripsSuffixes() {
        XCTAssertEqual(HomeLogic.tileTitle("Song (feat. Someone)"), "Song")
        XCTAssertEqual(HomeLogic.tileTitle("Album [Deluxe Edition]"), "Album")
        XCTAssertEqual(HomeLogic.tileTitle("Track - 2011 Remaster"), "Track")
        XCTAssertEqual(HomeLogic.tileTitle("Track – Radio Edit"), "Track")
        XCTAssertEqual(HomeLogic.tileTitle("Live at Leeds"), "Live at Leeds")
        XCTAssertEqual(HomeLogic.tileTitle("Mixtape (Live)"), "Mixtape")
        XCTAssertEqual(HomeLogic.tileTitle("(Remastered)"), "(Remastered)")
    }

    func testShortcutsOrderAndCap() {
        // What was picked and played from (owner, 11-14), newest first: an album, an artist,
        // a playlist; then playlists and library albums not yet there.
        func pick(_ kind: String, _ id: String) -> HomePick { HomePick(kind: kind, id: id, name: "N\(id)") }
        let picks = [pick("album", "r1"), pick("artist", "a1"), pick("playlist", "p2")]
        let pls = [homePlaylist("p1"), homePlaylist("p2")]
        let lib = [homeAlbum("r1"), homeAlbum("l1"), homeAlbum("l2"), homeAlbum("l3"), homeAlbum("l4")]
        let s = HomeLogic.shortcuts(picks: picks, playlists: pls, albums: lib)
        XCTAssertEqual(s.map(\.id), ["__liked__", "al:r1", "ar:a1", "pl:p2", "pl:p1", "al:l1", "al:l2", "al:l3"])
        // A picked playlist is the library's own row (its real name), not the bare pick.
        if case .playlist(let p) = s[3] { XCTAssertEqual(p.name, "Pp2") } else { XCTFail("a playlist") }
        XCTAssertEqual(HomeLogic.shortcuts(picks: [], playlists: [], albums: []).map(\.id), ["__liked__"])
        let ten = (0..<10).map { pick("album", "x\($0)") }
        XCTAssertEqual(HomeLogic.shortcuts(picks: ten, playlists: pls, albums: lib).count, 8)
    }

    func testTopSongsColoursStartCyanThenYellowWithDarkLabels() {
        XCTAssertEqual(Theme.Fixed.topPalette[HomeLogic.mixColorIndex(0)], RGB(hex: 0x22d3ee))
        XCTAssertEqual(Theme.Fixed.topPalette[HomeLogic.mixColorIndex(9)], RGB(hex: 0xfde047))
        XCTAssertTrue(Theme.Fixed.topPalette.allSatisfy { $0.luminance > 0.28 })    // dark labels
        XCTAssertTrue(Theme.Fixed.mixPalette.allSatisfy { $0.luminance <= 0.28 })   // Daily Mix keeps white
    }

    func testMixSeedsFallBackToLibraryArtists() {
        let top = (0..<8).map { HomeLogic.RankedArtist(id: "t\($0)", name: "T") }
        XCTAssertEqual(HomeLogic.mixSeeds(topArtists: top, libraryArtists: []).map(\.id), (0..<6).map { "t\($0)" })
        let lib = [Artist(id: "l1", name: "L", image: "hash")]
        let seeds = HomeLogic.mixSeeds(topArtists: [], libraryArtists: lib)
        XCTAssertEqual(seeds.map(\.id), ["l1"])
        XCTAssertEqual(seeds.first?.image, "hash")
    }

    func testSectionsOrderFiltersAndHiddenMadeForYou() {
        let full = HomeLogic.Counts(mixes: 6, stations: 3, topMixes: 2, years: 2, recentArtists: 4, radar: 5, topArtists: 6)
        // The web's order: Made For You, Recommended Stations, Your top mixes, Jump back in, Release
        // Radar, Your top artists, then Your Top Songs last. No Recently played.
        XCTAssertEqual(HomeLogic.sections(filter: .all, counts: full),
                       [.shortcuts, .madeForYou, .stations, .topMixes, .jumpBackIn, .radar, .topArtists, .topSongs])
        XCTAssertEqual(HomeLogic.sections(filter: .music, counts: full), [.shortcuts, .madeForYou, .stations, .topMixes, .radar, .topSongs])
        XCTAssertEqual(HomeLogic.sections(filter: .artists, counts: full), [.jumpBackIn, .topArtists])
        // No mixes: no Made For You (DECISIONS), and empty lists hide their shelves.
        XCTAssertEqual(HomeLogic.sections(filter: .all, counts: .init()), [.shortcuts])
    }

    func testMixColourIndexWraps() {
        XCTAssertEqual(HomeLogic.mixColorIndex(0), 0)
        XCTAssertEqual(HomeLogic.mixColorIndex(9), 1)
        XCTAssertEqual(Theme.Fixed.mixPalette[HomeLogic.mixColorIndex(8)], RGB(hex: 0xe8115b))
    }

    func testTopSongsSubtitleByYear() {
        XCTAssertEqual(HomeLogic.topSongsSub(2026, currentYear: 2026), "Your most played songs of 2026 so far")
        XCTAssertEqual(HomeLogic.topSongsSub(2024, currentYear: 2026), "The songs you played most in 2024")
    }

    func testTotalShortAndMixStats() {
        XCTAssertEqual(HomeLogic.totalShort(ms: 579_400), "9min 39sec")
        XCTAssertEqual(HomeLogic.totalShort(ms: 11_220_000), "3h 7min")
        XCTAssertEqual(HomeLogic.totalShort(ms: 499), "0min 0sec")
        XCTAssertEqual(HomeLogic.totalShort(ms: 500), "0min 1sec")
        XCTAssertEqual(HomeLogic.mixStats(sub: "Daft Punk and more", totalMs: 9_060_000), "Daft Punk and more • 2h 31min")
        XCTAssertEqual(HomeLogic.mixStats(sub: "X and more", totalMs: 0), "X and more")
        XCTAssertEqual(HomeLogic.mixStats(sub: nil, totalMs: 60_000), "1min 0sec")
    }

    func testRadarSubtitles() {
        let r = Release(album_id: "m", title: "New", rtype: "EP", date: "2026-11-01", image: nil, artistId: "a", artistName: "Band")
        XCTAssertEqual(HomeLogic.radarShelfSub(r), "Band • EP")
        XCTAssertEqual(HomeLogic.radarOwnedSub(r), "Band • 2026-11-01")
        XCTAssertEqual(HomeLogic.radarMissingTail(r), " • EP • 2026-11-01")
        var noType = r; noType.rtype = nil
        XCTAssertEqual(HomeLogic.radarShelfSub(noType), "Band • Album")
        XCTAssertEqual(HomeLogic.radarMissingTail(noType), " • 2026-11-01")
        XCTAssertNotEqual(r.id, Release(album_id: "m", title: "New", artistId: "b").id)
    }

    func testRequestStateAndLabels() {
        XCTAssertEqual(HomeLogic.requestState(server: nil, mine: "queued"), "queued")
        XCTAssertEqual(HomeLogic.requestState(server: "failed", mine: "queued"), "queued")
        XCTAssertEqual(HomeLogic.requestState(server: "downloading", mine: "queued"), "downloading")
        XCTAssertEqual(HomeLogic.requestState(server: "failed", mine: nil), "failed")
        XCTAssertNil(HomeLogic.requestState(server: nil, mine: nil))
        XCTAssertEqual(HomeLogic.requestUI(nil).label, "Request")
        XCTAssertEqual(HomeLogic.requestUI("exists").label, "Requested")
        XCTAssertTrue(HomeLogic.requestUI("downloading").busy)
        XCTAssertEqual(HomeLogic.requestUI("failed").label, "Retry")
        XCTAssertFalse(HomeLogic.requestUI("failed").busy)
        XCTAssertEqual(HomeLogic.requestUI("error").label, "Failed")
    }

    func testDrawnTilesHaveNoBandAndNoTitle() {
        let photo = CoverSource.artist(id: "a", image: nil)
        let drawn = HomeLogic.dailyMixTile(label: "Daily Mix 1", sub: "Drake, Future and more", art: "art_" + String(repeating: "a", count: 40), photo: photo)
        XCTAssertEqual(drawn.image, .drawn(id: "art_" + String(repeating: "a", count: 40)))
        XCTAssertNil(drawn.band); XCTAssertNil(drawn.title); XCTAssertTrue(drawn.drawn)
        XCTAssertEqual(drawn.sub, "Drake, Future and more")
        // An older server (no art): today's look, photo + band + title.
        let old = HomeLogic.dailyMixTile(label: "Daily Mix 1", sub: "Drake and more", art: nil, photo: photo)
        XCTAssertEqual(old.image, photo); XCTAssertEqual(old.band, "Daily Mix 1"); XCTAssertEqual(old.title, "Daily Mix 1"); XCTAssertFalse(old.drawn)

        let st = HomeLogic.stationTile(HomeStation(id: "a", name: "Drake", with: [.init(id: "b", name: "Future"), .init(id: "c", name: "Travis Scott")], color: "#e8115b", art: "art_s"))
        XCTAssertEqual(st, .init(image: .drawn(id: "art_s"), band: nil, title: nil, sub: "With Future, Travis Scott and more"))
        let tm = HomeLogic.topMixTile(HomeTopMix(genre: "Hip-Hop", name: "Hip-Hop Mix", artists: [.init(id: "a", name: "Drake"), .init(id: "b", name: "Future")], color: "#1e3264", art: "art_m", day: "2026-11-17"))
        XCTAssertEqual(tm, .init(image: .drawn(id: "art_m"), band: nil, title: nil, sub: "Drake, Future and more"))
        XCTAssertNil(HomeLogic.stationSub([]))
        XCTAssertEqual(HomeLogic.color("#1e3264"), RGB(hex: 0x1e3264))
        XCTAssertEqual(HomeLogic.color(nil), Theme.Fixed.mixPalette[0])
    }

    func testRadarShelfOnlyListsReleasesInTheLibrary() {
        let owned = Release(album_id: "m1", title: "In", artist: nil, rtype: nil, year: nil, date: nil, image: nil, total_tracks: nil,
                            inLibrary: "al1", localName: nil, artistId: nil, artistName: nil, requestStatus: nil)
        var missing = owned; missing.album_id = "m2"; missing.inLibrary = nil
        XCTAssertEqual(HomeLogic.radarShelf([missing, owned]).map(\.album_id), ["m1"])
        XCTAssertEqual(HomeLogic.sections(filter: .all, counts: .init(radar: HomeLogic.radarShelf([missing]).count)), [.shortcuts])
    }

    func testRadarReleaseDecodesServerShape() throws {
        let json = #"{"releases":[{"album_id":"mb1","artist":"Band","title":"New","rtype":"Single","year":2026,"date":"2026-10-30","image":"https://x.invalid/a.jpg","total_tracks":1,"secondary":[],"artistId":"a1","artistName":"Band","inLibrary":null,"localName":null,"requestStatus":"queued"}]}"#
        struct R: Decodable { var releases: [Release] }
        let r = try JSONDecoder().decode(R.self, from: Data(json.utf8)).releases
        XCTAssertEqual(r.first?.artistName, "Band")
        XCTAssertEqual(r.first?.requestStatus, "queued")
        XCTAssertNil(r.first?.inLibrary)
    }
}
