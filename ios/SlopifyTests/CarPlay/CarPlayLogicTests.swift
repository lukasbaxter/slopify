import MediaPlayer
import XCTest
@testable import Slopify

private func cpTrack(_ id: String, artists: [String] = ["A"], albumArtist: String = "AA") -> Track {
    Track(id: id, title: "T\(id)", artist: artists.joined(separator: ", "), artists: artists, artistIds: artists.map { "ar_" + $0 },
          albumId: "al_\(id)", album: "Album", albumArtist: albumArtist, trackNo: nil, discNo: nil, year: nil, genres: nil,
          durationMs: 1000, codec: nil, bitrate: nil, cover: nil, format: nil, gain: nil, addedAt: nil, plays: nil)
}

private func cpAlbum(_ id: String, artist: String = "X") -> Album {
    Album(id: id, name: "N\(id)", artist: artist, artistId: nil, year: nil, trackCount: nil, durationMs: nil, cover: "h\(id)", addedAt: nil, likedAt: nil)
}

private func cpPlaylist(_ id: String, count: Int? = nil) -> Playlist {
    Playlist(id: id, name: "P\(id)", userId: nil, created: nil, updated: nil, trackCount: count, cover: nil, aiPrompt: nil)
}

private func cpArtist(_ id: String) -> Artist {
    Artist(id: id, name: "Ar\(id)", trackCount: nil, albumCount: nil, image: nil, banner: nil, followedAt: nil)
}

@MainActor
final class CarPlayLogicTests: XCTestCase {
    override func setUp() { Localizer.shared.setUserPick("en") }

    // MARK: Contexts

    func testContextsMatchThePhoneScreens() {
        XCTAssertEqual(CarPlayLogic.context(.album(id: "al1", name: "x")), "al1")
        XCTAssertEqual(CarPlayLogic.context(.playlist(id: "pl_1", name: "x")), "pl_1")
        XCTAssertEqual(CarPlayLogic.context(.artist(id: "ar1", name: "x")), "artist:ar1")
        XCTAssertEqual(CarPlayLogic.context(.liked), "liked")
        XCTAssertEqual(CarPlayLogic.context(.mix(artistId: "ar2", number: 1, seedName: "S")), "mix:ar2")
        XCTAssertEqual(CarPlayLogic.context(.topSongs(year: 2025)), "top:2025")
        XCTAssertEqual(CarPlayLogic.context(.downloaded(id: OfflineIndex.likedId, kind: .liked, name: "")), "liked")
        XCTAssertEqual(CarPlayLogic.context(.downloaded(id: "al9", kind: .album, name: "")), "al9")
        XCTAssertNil(CarPlayLogic.context(.libraryPlaylists))
        XCTAssertNil(CarPlayLogic.context(.track(id: "t", index: 0)))
    }

    func testTitles() {
        XCTAssertEqual(CarPlayLogic.title(.mix(artistId: "a", number: 3, seedName: "S")), "Daily Mix 3")
        XCTAssertEqual(CarPlayLogic.title(.topSongs(year: 2024)), "Your Top Songs 2024")
        XCTAssertEqual(CarPlayLogic.title(.liked), "Liked Songs")
        XCTAssertEqual(CarPlayLogic.title(.downloaded(id: "pl", kind: .playlist, name: "Road")), "Road")
        XCTAssertEqual(CarPlayLogic.title(.libraryDownloaded), "Downloaded")
    }

    // MARK: Rows

    func testRowTitlesAndSubtitles() {
        let a = CarPlayLogic.albumRow(cpAlbum("1"))
        XCTAssertEqual(a.title, "N1"); XCTAssertEqual(a.subtitle, "X"); XCTAssertEqual(a.art, .album(id: "1", art: "h1"))
        XCTAssertEqual(CarPlayLogic.albumRow(cpAlbum("2", artist: "")).subtitle, "Album")
        XCTAssertEqual(CarPlayLogic.playlistRow(cpPlaylist("pl_1", count: 4)).subtitle, "Playlist • 4 songs")
        XCTAssertEqual(CarPlayLogic.playlistRow(cpPlaylist("pl_2")).subtitle, "Playlist")
        let m = CarPlayLogic.mixRow(.init(id: "ar", name: "Bob"), number: 2)
        XCTAssertEqual(m.title, "Daily Mix 2"); XCTAssertEqual(m.subtitle, "Bob and more")
        XCTAssertEqual(m.target, .mix(artistId: "ar", number: 2, seedName: "Bob"))
    }

    func testArtistLineFallsBackToAlbumArtist() {
        XCTAssertEqual(CarPlayLogic.artistLine(cpTrack("1", artists: ["A", "B"])), "A, B")
        XCTAssertEqual(CarPlayLogic.artistLine(cpTrack("1", artists: [], albumArtist: "AA")), "AA")
    }

    func testTrackRowsIndexAndCap() {
        let rows = CarPlayLogic.trackRows([cpTrack("1"), cpTrack("2"), cpTrack("3")], cap: 2)
        XCTAssertEqual(rows.map(\.target), [.track(id: "1", index: 0), .track(id: "2", index: 1)])
        XCTAssertEqual(rows.first?.trackId, "1")
    }

    // MARK: Home

    private var snapshot: HomeStore.Snapshot {
        var d = HomeStore.Snapshot()
        d.recent = [cpAlbum("r1"), cpAlbum("r2")]
        d.topArtists = [.init(id: "a1", name: "A1"), .init(id: "a2", name: "A2")]
        d.topYears = [.init(year: 2026, songs: 1, plays: 1, top: cpTrack("y"))]
        d.radar = []
        return d
    }

    func testHomeSectionsFollowThePhoneOrder() {
        let d = snapshot
        let s = CarPlayLogic.homeSections(d, mixSeeds: HomeLogic.mixSeeds(topArtists: d.topArtists, libraryArtists: []),
                                          offline: false, held: [], currentYear: 2026, perSection: 12)
        XCTAssertEqual(s.map(\.title), ["Made For You", "Your Top Songs", "Recently played", "Your top artists"])
        XCTAssertEqual(s[0].rows.map(\.title), ["Daily Mix 1", "Daily Mix 2"])
        XCTAssertEqual(s[1].rows.first?.subtitle, "Your most played songs of 2026 so far")
        XCTAssertEqual(s[1].rows.first?.art, .album(id: "al_y", art: nil))
    }

    func testHomeSectionsCapPerSection() {
        let d = snapshot
        let s = CarPlayLogic.homeSections(d, mixSeeds: HomeLogic.mixSeeds(topArtists: d.topArtists, libraryArtists: []),
                                          offline: false, held: [], currentYear: 2026, perSection: 1)
        XCTAssertTrue(s.allSatisfy { $0.rows.count == 1 })
    }

    func testHomeOfflineShowsOnlyDownloadedRecentAlbums() {
        let s = CarPlayLogic.homeSections(snapshot, mixSeeds: [.init(id: "a1", name: "A1")], offline: true, held: ["r2"],
                                          currentYear: 2026, perSection: 12)
        XCTAssertEqual(s.map(\.title), ["Recently played"])
        XCTAssertEqual(s[0].rows.map(\.target), [.album(id: "r2", name: "Nr2")])
        XCTAssertTrue(CarPlayLogic.homeSections(snapshot, mixSeeds: [], offline: true, held: [], currentYear: 2026, perSection: 12).isEmpty)
    }

    // MARK: Library

    func testLibraryRootOnlineAndOffline() {
        XCTAssertEqual(CarPlayLogic.libraryRoot(likedCount: 3, offline: false, held: []).map(\.target),
                       [.liked, .libraryPlaylists, .libraryAlbums, .libraryArtists, .libraryDownloaded])
        XCTAssertEqual(CarPlayLogic.libraryRoot(likedCount: 3, offline: false, held: []).first?.subtitle, "Playlist • 3 songs")
        XCTAssertEqual(CarPlayLogic.libraryRoot(likedCount: nil, offline: true, held: []).map(\.target),
                       [.libraryPlaylists, .libraryAlbums, .libraryDownloaded])
        XCTAssertEqual(CarPlayLogic.libraryRoot(likedCount: nil, offline: true, held: [OfflineIndex.likedId]).first?.target, .liked)
    }

    func testLibraryListsFilterOffline() {
        let pls = [cpPlaylist("pl_1"), cpPlaylist("pl_2")]
        XCTAssertEqual(CarPlayLogic.playlists(pls, offline: false, held: [], cap: 10).count, 2)
        XCTAssertEqual(CarPlayLogic.playlists(pls, offline: true, held: ["pl_2"], cap: 10).map(\.title), ["Ppl_2"])
        XCTAssertEqual(CarPlayLogic.albums([cpAlbum("1"), cpAlbum("2")], offline: true, held: ["1"], cap: 10).map(\.title), ["N1"])
        XCTAssertEqual(CarPlayLogic.albums([cpAlbum("1"), cpAlbum("2")], offline: false, held: [], cap: 1).count, 1)
        XCTAssertEqual(CarPlayLogic.artists([cpArtist("1")], offline: false, cap: 10).map(\.subtitle), ["Artist"])
        XCTAssertTrue(CarPlayLogic.artists([cpArtist("1")], offline: true, cap: 10).isEmpty)
    }

    func testDownloadedListsCollectionsWithFiles() {
        var idx = OfflineIndex()
        idx.upsert(OfflineCollection(id: "al1", name: "Album 1", kind: .album, trackIds: [], added: 1),
                   songs: [OfflineTrack(track: cpTrack("1"), q: "aac-160"), OfflineTrack(track: cpTrack("2"), q: "aac-160")])
        idx.upsert(OfflineCollection(id: OfflineIndex.likedId, name: "Liked", kind: .liked, trackIds: [], added: 2),
                   songs: [OfflineTrack(track: cpTrack("3"), q: "aac-160")])
        XCTAssertTrue(CarPlayLogic.downloaded(idx, cap: 10).isEmpty)
        idx.tracks["1"]?.file = "1.m4a"
        idx.tracks["3"]?.file = "3.m4a"
        let rows = CarPlayLogic.downloaded(idx, cap: 10)
        XCTAssertEqual(rows.map(\.title), ["Liked Songs", "Album 1"])
        XCTAssertEqual(rows[1].subtitle, "Album • 1 songs")
        XCTAssertEqual(rows[1].target, .downloaded(id: "al1", kind: .album, name: "Album 1"))
    }

    func testPlayableOfflineKeepsDownloadedOnly() {
        let t = [cpTrack("1"), cpTrack("2"), cpTrack("3")]
        XCTAssertEqual(CarPlayLogic.playable(t, offline: false) { _ in false }.map(\.id), ["1", "2", "3"])
        XCTAssertEqual(CarPlayLogic.playable(t, offline: true) { $0 != "2" }.map(\.id), ["1", "3"])
    }

    // MARK: Queue

    func testQueuePartsSplitLikeQueueView() {
        let p = CarPlayLogic.queueParts(count: 6, index: 1, queuedFlags: [false, false, true, true, false, false],
                                        hasContext: true, fromName: "Mix", cap: 100)
        XCTAssertEqual(p, [.init(title: "Now playing", indices: [1]), .init(title: "Next in queue", indices: [2, 3]),
                           .init(title: "Next from: Mix", indices: [4, 5])])
        let noCtx = CarPlayLogic.queueParts(count: 2, index: 0, queuedFlags: [], hasContext: false, fromName: "", cap: 100)
        XCTAssertEqual(noCtx.last?.title, "Next up")
        XCTAssertTrue(CarPlayLogic.queueParts(count: 0, index: 0, queuedFlags: [], hasContext: false, fromName: "", cap: 10).isEmpty)
        let capped = CarPlayLogic.queueParts(count: 10, index: 0, queuedFlags: [], hasContext: true, fromName: "X", cap: 3)
        XCTAssertEqual(capped.flatMap(\.indices), [0, 1, 2])
    }

    // MARK: Now Playing

    func testShuffleAndRepeatCycleLikeThePhone() {
        XCTAssertEqual(CarPlayLogic.nextShuffle(.off), .on)
        XCTAssertEqual(CarPlayLogic.nextShuffle(.on), .smart)
        XCTAssertEqual(CarPlayLogic.nextShuffle(.smart), .off)
        XCTAssertEqual(CarPlayLogic.nextRepeat(.off), .all)
        XCTAssertEqual(CarPlayLogic.nextRepeat(.all), .one)
        XCTAssertEqual(CarPlayLogic.nextRepeat(.one), .off)
        XCTAssertFalse(CarPlayLogic.shuffleSelected(.off)); XCTAssertTrue(CarPlayLogic.shuffleSelected(.smart))
        XCTAssertFalse(CarPlayLogic.repeatSelected(.off)); XCTAssertTrue(CarPlayLogic.repeatSelected(.one))
        XCTAssertEqual(CarPlayLogic.repeatType(.one), .one)
        XCTAssertEqual(CarPlayLogic.repeatType(.all), .all)
        XCTAssertEqual(CarPlayLogic.shuffleType(.smart), .items)
        XCTAssertEqual(CarPlayLogic.shuffleType(.off), .off)
        XCTAssertEqual(CarPlayLogic.likeSymbol(true), "heart.fill")
        XCTAssertEqual(CarPlayLogic.likeSymbol(false), "heart")
    }

    func testPlayingMarks() {
        let track = CarPlayLogic.trackRows([cpTrack("1")], cap: 1)[0]
        XCTAssertTrue(CarPlayLogic.isPlaying(track, currentId: "1", playerContext: "other"))
        XCTAssertFalse(CarPlayLogic.isPlaying(track, currentId: nil, playerContext: nil))
        let album = CarPlayLogic.albumRow(cpAlbum("al1"))
        XCTAssertTrue(CarPlayLogic.isPlaying(album, currentId: "x", playerContext: "al1"))
        XCTAssertFalse(CarPlayLogic.isPlaying(album, currentId: "x", playerContext: "al2"))
        let liked = CarPlayLogic.likedRow(count: nil)
        XCTAssertTrue(CarPlayLogic.isPlaying(liked, currentId: "x", playerContext: OfflineIndex.likedId))
        let q = CarPlayLogic.Row(title: "", subtitle: nil, art: nil, glyph: .song, target: .queue(index: 2))
        XCTAssertTrue(CarPlayLogic.isPlaying(q, currentId: "x", playerContext: nil, playerIndex: 2))
        XCTAssertFalse(CarPlayLogic.isPlaying(q, currentId: "x", playerContext: nil, playerIndex: 1))
        XCTAssertFalse(CarPlayLogic.isPlaying(CarPlayLogic.libraryRoot(likedCount: nil, offline: false, held: [])[1], currentId: "x", playerContext: "x"))
    }

    func testImagePixels() {
        XCTAssertEqual(CarPlayLogic.imagePixels(CGSize(width: 44, height: 44), scale: 2), 88)
        XCTAssertEqual(CarPlayLogic.imagePixels(CGSize(width: 44, height: 40), scale: 0), 44)
    }
}
