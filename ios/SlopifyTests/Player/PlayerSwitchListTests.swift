import XCTest
@testable import Slopify

/// Owner report (iPhone 16): "played a daily mix, then went to a personal playlist and was
/// unable to start the song". Each test plays a mix, leaves the Player in one of the states a
/// mix can leave behind, then plays another list from a row: it must start there.
@MainActor
final class PlayerSwitchListTests: XCTestCase {
    private let mixContext = "mix:ar1"
    private let playlist = "pl_mine"

    private func settle() async {
        for _ in 0..<8 { await Task.yield(); try? await Task.sleep(for: .milliseconds(15)) }
    }

    private func mixTracks() -> [Track] { (1...6).map { makeTrack("m\($0)", album: "al\($0)") } }
    private func listTracks() -> [Track] { (1...5).map { makeTrack("p\($0)", album: "bl\($0)") } }

    private func assertStarted(_ p: Player, _ e: FakeEngine, _ id: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(p.current?.id, id, file: file, line: line)
        XCTAssertEqual(p.context, playlist, file: file, line: line)
        XCTAssertTrue(p.isPlaying, file: file, line: line)
        XCTAssertNil(p.error, file: file, line: line)
        XCTAssertFalse(p.isRemote, file: file, line: line)
        XCTAssertEqual(e.currentId, id, "the engine must hold the tapped song", file: file, line: line)
        XCTAssertEqual(e.loads.last?.0.id, id, file: file, line: line)
        XCTAssertTrue(e.playing, file: file, line: line)
    }

    /// The exact sequence: mix playing (next song prepared), touch-down prewarm on a playlist
    /// row, then the tap.
    func testMixThenPrewarmThenPlaylistRowStarts() async {
        let (p, e, l, b) = makePlayer()
        p.play(mixTracks(), startAt: 0, context: mixContext)
        p.audioHeard("m1")
        await settle()
        XCTAssertEqual(e.next?.0?.id, "m2", "the mix had its next song prepared")
        let list = listTracks()
        p.prewarm(list[2])
        await settle()
        XCTAssertEqual(b.prewarms.count, 1)
        p.play(list, startAt: 2, context: playlist)
        assertStarted(p, e, "p3")
        XCTAssertEqual(p.queue.map(\.id), list.map(\.id))
        XCTAssertEqual(l.reports.last??.itemId, "p3")
        p.audioHeard("p3")
        await settle()
        XCTAssertEqual(e.next?.0?.id, "p4", "the next song follows the new list, not the mix")
    }

    /// A mix skipped through quickly leaves a debounced load pending.
    func testPendingSkipDebounceDoesNotSwallowTheNewPlay() async {
        let (p, e, _, _) = makePlayer()
        p.play(mixTracks(), context: mixContext)
        p.next(); p.next()   // second one is "rapid": its load waits 300 ms
        p.play(listTracks(), startAt: 1, context: playlist)
        assertStarted(p, e, "p2")
        try? await Task.sleep(for: .milliseconds(400))
        assertStarted(p, e, "p2")   // the stale deferred load must not replace it
    }

    /// The mix ended and autoplay is still fetching when the new list is played.
    func testAutoplayInFlightDoesNotOverrideTheNewPlay() async {
        let (p, e, _, b) = makePlayer()
        p.play(mixTracks(), startAt: 5, context: mixContext)
        await settle()
        b.mixes["m6"] = (1...3).map { makeTrack("x\($0)") }
        p.audioEnded("m6")             // autoplay Task starts
        p.play(listTracks(), startAt: 0, context: playlist)
        await settle()
        assertStarted(p, e, "p1")
        XCTAssertEqual(p.queue.map(\.id), listTracks().map(\.id), "no mix songs appended to the new list")
    }

    /// A mix song that failed (error strip up, nothing playing) must not block a new play.
    func testFailedMixSongDoesNotBlock() {
        let (p, e, _, _) = makePlayer()
        p.play(mixTracks(), context: mixContext)
        p.audioFailed("m1", message: "transcode failed")
        XCTAssertNotNil(p.error)
        XCTAssertFalse(p.isPlaying)
        p.play(listTracks(), startAt: 3, context: playlist)
        assertStarted(p, e, "p4")
    }

    /// Paused mix, then the playlist: still a fresh start (not a toggle of the mix song).
    func testPausedMixThenPlaylist() {
        let (p, e, _, _) = makePlayer()
        p.play(mixTracks(), context: mixContext)
        p.togglePlay()
        XCTAssertFalse(p.isPlaying)
        p.play(listTracks(), startAt: 0, context: playlist)
        assertStarted(p, e, "p1")
    }

    /// The same song in both lists (a mix often contains playlist songs).
    func testSameSongInMixAndPlaylist() async {
        let (p, e, _, _) = makePlayer()
        var list = listTracks(); list[1] = makeTrack("m2", album: "al2")
        p.play(mixTracks(), context: mixContext)
        p.audioHeard("m1")
        await settle()
        XCTAssertEqual(e.next?.0?.id, "m2")
        p.play(list, startAt: 1, context: playlist)
        assertStarted(p, e, "m2")
    }

    /// Shuffle left on from the mix: the tapped row still plays first.
    func testShuffleFromMixKeepsTappedRowFirst() {
        let (p, e, _, _) = makePlayer()
        p.play(mixTracks(), context: mixContext, shuffle: true)
        p.play(listTracks(), startAt: 4, context: playlist)
        assertStarted(p, e, "p5")
        XCTAssertEqual(p.index, 0)
    }
}
