import XCTest
@testable import Slopify

@MainActor
final class WidgetLogicTests: XCTestCase {
    private func now(playing: Bool = true, position: Double = 30, duration: Double = 200, at: Date = Date(timeIntervalSince1970: 1000)) -> WidgetSnapshot.Now {
        .init(id: "t1", title: "Song", artist: "Artist", cover: "c.img", tint: [10, 20, 30], playing: playing, position: position, duration: duration, at: at)
    }

    func testProgressLineRunsFromTheSongsStartToItsEndOnlyWhilePlaying() {
        let n = now()
        let span = WidgetLogic.progressSpan(n, at: n.at)
        XCTAssertEqual(span?.lowerBound, Date(timeIntervalSince1970: 970))
        XCTAssertEqual(span?.upperBound, Date(timeIntervalSince1970: 1170))
        XCTAssertNil(WidgetLogic.progressSpan(now(playing: false), at: n.at), "paused: no line")
        XCTAssertNil(WidgetLogic.progressSpan(now(duration: 0), at: n.at), "no length: no line")
        XCTAssertNil(WidgetLogic.progressSpan(n, at: Date(timeIntervalSince1970: 1171)), "the song would be over")
    }

    func testThePlayheadMovingAsPredictedDoesNotRedrawTheWidgets() {
        let a = now()
        XCTAssertFalse(WidgetLogic.differs(a, now(position: 40.5, at: a.at.addingTimeInterval(10))))
        XCTAssertTrue(WidgetLogic.differs(a, now(position: 120, at: a.at.addingTimeInterval(10))), "a seek")
        XCTAssertTrue(WidgetLogic.differs(a, now(playing: false)), "paused")
        XCTAssertTrue(WidgetLogic.differs(nil, a))
        XCTAssertTrue(WidgetLogic.differs(a, nil))
        XCTAssertFalse(WidgetLogic.differs(nil, nil))
        var other = a; other.id = "t2"
        XCTAssertTrue(WidgetLogic.differs(a, other))
        // Paused, the playhead stays where it was however long ago that was.
        let p = now(playing: false)
        XCTAssertFalse(WidgetLogic.differs(p, now(playing: false, at: p.at.addingTimeInterval(600))))
    }

    func testLinksRoundTripAndForeignURLsAreIgnored() {
        for l in [WidgetLink.nowPlaying, .album("al1"), .playlist("pl 1"), .artist("ar1"), .radio(seedId: "t1", name: "A Song & More"), .radio(seedId: "t1", name: nil)] {
            XCTAssertEqual(WidgetLink(l.url), l)
        }
        XCTAssertNil(WidgetLink(URL(string: "https://example.com/album/al1")!))
        XCTAssertNil(WidgetLink(URL(string: "slopify-widget://album/")!))
        XCTAssertNil(WidgetLink(URL(string: "slopify-widget://nope/x")!))
        XCTAssertEqual(WidgetFeed.route(.album("al1")), .album(id: "al1"))
        XCTAssertEqual(WidgetFeed.route(.radio(seedId: "t1", name: "S")), .radio(seedId: "t1", name: "S"))
        XCTAssertNil(WidgetFeed.route(.nowPlaying))
    }

    func testTilesAreTheFourLatestShortcutsWithoutLikedSongsAndArtistsAreCircles() {
        let album = { (id: String) in Album(id: id, name: "Album " + id, artist: "X", artistId: nil, year: nil, trackCount: nil, durationMs: nil, cover: "h" + id, addedAt: nil, likedAt: nil) }
        let shortcuts: [HomeLogic.Shortcut] = [
            .liked, .album(album("a1")), .artist(.init(id: "ar1", name: "Someone", image: "img")),
            .playlist(Playlist(id: "p1", name: "Mix", userId: nil, created: nil, updated: nil, trackCount: nil, cover: nil, aiPrompt: nil)),
            .album(album("a2")), .album(album("a3")),
        ]
        let tiles = WidgetFeed.tiles(shortcuts)
        XCTAssertEqual(tiles.map(\.tile.title), ["Album a1", "Someone", "Mix", "Album a2"])
        XCTAssertEqual(tiles.map(\.tile.round), [false, true, false, false])
        XCTAssertEqual(tiles.map { WidgetLink(URL(string: $0.tile.link)!) }, [.album("a1"), .artist("ar1"), .playlist("p1"), .album("a2")])
        XCTAssertEqual(tiles[1].source, .artist(id: "ar1", image: "img"))
    }

    func testSnapshotSurvivesTheTripThroughTheSharedFile() throws {
        let s = WidgetSnapshot(now: now(), recents: [.init(link: WidgetLink.artist("ar1").url.absoluteString, title: "Someone", cover: nil, round: true)])
        XCTAssertEqual(try JSONDecoder().decode(WidgetSnapshot.self, from: JSONEncoder().encode(s)), s)
    }
}
