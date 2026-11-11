import XCTest
@testable import Slopify

/// clearError, recFlags, deliveredProfile, outputLag, prewarm (lead request queue).
@MainActor
final class PlayerSurfaceTests: XCTestCase {
    func testClearErrorHidesTheStrip() {
        let (p, _, _, _) = makePlayer()
        p.play(tracks("a"))
        p.audioFailed("a", message: "boom")
        XCTAssertEqual(p.error, "boom")
        p.clearError()
        XCTAssertNil(p.error)
    }

    func testRecFlagsFollowTheQueue() async {
        let (p, _, _, b) = makePlayer()
        b.mixes["a"] = tracks("r1", "r2", "r3", "r4", "r5")
        p.play(tracks("a", "b", "c", "d", "e", "f"))
        XCTAssertEqual(p.recFlags, Array(repeating: false, count: 6))
        p.setShuffle(.smart)
        for _ in 0..<100 where !p.recFlags.contains(true) { try? await Task.sleep(nanoseconds: 10_000_000) }
        XCTAssertEqual(p.recFlags.count, p.queue.count)
        XCTAssertTrue(p.recFlags.contains(true))
        for (t, rec) in zip(p.queue, p.recFlags) { XCTAssertEqual(rec, t.id.hasPrefix("r"), t.id) }
    }

    func testDeliveredProfileIsWhatWasLoaded() {
        let (p, _, _, _) = makePlayer(prefs: ["phoneQuality": .string("normal")])
        XCTAssertNil(p.deliveredProfile)
        p.play(tracks("a"))
        XCTAssertEqual(p.deliveredProfile, .hls(profile: "aac-160"))
        let (p2, _, _, _) = makePlayer()
        p2.localFile = { _ in URL(fileURLWithPath: "/tmp/a.m4a") }
        p2.play(tracks("a"))
        XCTAssertEqual(p2.deliveredProfile, .file)
    }

    func testOutputLagOnlyWhilePlayingHere() {
        let (p, _, _, _) = makePlayer()
        XCTAssertEqual(p.outputLag(), 0)
        p.play(tracks("a"))
        XCTAssertEqual(p.outputLag(), 0, "no audio session in tests")
    }

    func testPrewarmOncePerMinuteAndNotForFiles() async {
        let (p, _, _, b) = makePlayer()
        p.prewarm(makeTrack("a"))
        p.prewarm(makeTrack("a"))
        p.localFile = { $0 == "f" ? URL(fileURLWithPath: "/tmp/f.m4a") : nil }
        p.prewarm(makeTrack("f"))
        for _ in 0..<50 where b.prewarms.isEmpty { try? await Task.sleep(nanoseconds: 10_000_000) }
        try? await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertEqual(b.prewarms.count, 1)
        XCTAssertTrue(b.prewarms[0].absoluteString.contains("/a/hls/master.m3u8"), b.prewarms[0].absoluteString)
    }

    func testHLSPlaylistParsing() {
        let master = """
        #EXTM3U
        #EXT-X-STREAM-INF:BANDWIDTH=96000,CODECS="mp4a.40.2"
        aac-96g-5.2/index.m3u8?token=T&abr=1
        #EXT-X-STREAM-INF:BANDWIDTH=320000,CODECS="mp4a.40.2"
        aac-320g-5.2/index.m3u8?token=T&abr=1
        """
        XCTAssertEqual(HLSPlaylist.variants(master).first, "aac-96g-5.2/index.m3u8?token=T&abr=1")
        let alac = """
        #EXTM3U
        #EXT-X-TARGETDURATION:5
        #EXT-X-MAP:URI="init.mp4?token=T"
        #EXTINF:4.017063,
        s0000.m4s?token=T
        #EXTINF:4.017063,
        s0001.m4s?token=T
        #EXTINF:4.017063,
        s0002.m4s?token=T
        #EXT-X-ENDLIST
        """
        XCTAssertEqual(HLSPlaylist.segments(alac, count: 2), ["init.mp4?token=T", "s0000.m4s?token=T", "s0001.m4s?token=T"])
        XCTAssertEqual(HLSPlaylist.segments("#EXTM3U\n#EXTINF:4,\ns0000.ts\n", count: 2), ["s0000.ts"])
    }
}
