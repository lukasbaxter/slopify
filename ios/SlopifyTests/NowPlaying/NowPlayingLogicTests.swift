import XCTest
@testable import Slopify

final class NowPlayingMathTests: XCTestCase {
    func testTimeFormat() {
        XCTAssertEqual(NowPlayingMath.time(0), "0:00")
        XCTAssertEqual(NowPlayingMath.time(65.9), "1:05")
        XCTAssertEqual(NowPlayingMath.time(3725), "62:05")
        XCTAssertEqual(NowPlayingMath.time(-3), "0:00")
        XCTAssertEqual(NowPlayingMath.time(.nan), "0:00")
        XCTAssertEqual(NowPlayingMath.remaining(30, duration: 200), "-2:50")
        XCTAssertEqual(NowPlayingMath.remaining(250, duration: 200), "-0:00")
    }

    func testScrubValueClampsAndScales() {
        XCTAssertEqual(NowPlayingMath.scrubValue(x: 50, width: 100, duration: 200), 100)
        XCTAssertEqual(NowPlayingMath.scrubValue(x: -20, width: 100, duration: 200), 0)
        XCTAssertEqual(NowPlayingMath.scrubValue(x: 150, width: 100, duration: 200), 200)
        // Range is 0...max(1, duration).
        XCTAssertEqual(NowPlayingMath.scrubValue(x: 100, width: 100, duration: 0), 1)
        XCTAssertEqual(NowPlayingMath.scrubValue(x: 10, width: 0, duration: 200), 0)
        XCTAssertEqual(NowPlayingMath.scrubHold(mirroring: true), 1.5)
        XCTAssertEqual(NowPlayingMath.scrubHold(mirroring: false), 0.25)
    }

    func testFraction() {
        XCTAssertEqual(NowPlayingMath.fraction(50, duration: 200), 0.25)
        XCTAssertEqual(NowPlayingMath.fraction(500, duration: 200), 1)
        XCTAssertEqual(NowPlayingMath.fraction(5, duration: 0), 0)
    }

    func testSkipSwipe() {
        XCTAssertEqual(NowPlayingMath.skip(dx: -61, dy: 10, velocityX: 0), .next)
        XCTAssertEqual(NowPlayingMath.skip(dx: 61, dy: -10, velocityX: 0), .previous)
        XCTAssertNil(NowPlayingMath.skip(dx: 60, dy: 0, velocityX: 0))
        XCTAssertNil(NowPlayingMath.skip(dx: -100, dy: 110, velocityX: -900), "more down than sideways")
        // Owner 11-12: forgiving. A sloppy diagonal, a slow swipe and a short flick all skip.
        XCTAssertEqual(NowPlayingMath.skip(dx: -100, dy: 60, velocityX: 0), .next)
        XCTAssertEqual(NowPlayingMath.skip(dx: -30, dy: 5, velocityX: -900), .next)
        XCTAssertNil(NowPlayingMath.skip(dx: -30, dy: 5, velocityX: 900), "flicked back")
        XCTAssertNil(NowPlayingMath.skip(dx: -20, dy: 0, velocityX: -900), "a twitch")
        let f = NowPlayingMath.skipFollow(dx: -120)
        XCTAssertEqual(f.offset, -80)
        XCTAssertEqual(f.opacity, 0.6, accuracy: 1e-9)
        XCTAssertEqual(NowPlayingMath.skipFollow(dx: 5).offset, 0)
        XCTAssertTrue(NowPlayingMath.abandonsSwipe(dx: 3, dy: 8))
        XCTAssertFalse(NowPlayingMath.abandonsSwipe(dx: 8, dy: 20))
    }

    func testNowPlayingDismiss() {
        let d = Gestures.nowPlayingDismissDistance
        XCTAssertTrue(SwipeDismiss.shouldDismiss(along: 141, velocity: 0, distance: d))
        XCTAssertFalse(SwipeDismiss.shouldDismiss(along: 140, velocity: 0, distance: d))
        XCTAssertTrue(SwipeDismiss.shouldDismiss(along: 61, velocity: 700, distance: d), "flick")
        XCTAssertFalse(SwipeDismiss.shouldDismiss(along: 61, velocity: 100, distance: d))
    }

    func testMiniPlayerSwipeUp() {
        XCTAssertTrue(NowPlayingMath.opensNowPlaying(dx: 10, dy: -41, velocityY: 0))
        XCTAssertTrue(NowPlayingMath.opensNowPlaying(dx: 0, dy: -20, velocityY: -800), "short flick")
        XCTAssertFalse(NowPlayingMath.opensNowPlaying(dx: 0, dy: -20, velocityY: -100))
        XCTAssertFalse(NowPlayingMath.opensNowPlaying(dx: 60, dy: -50, velocityY: -900), "sideways: a skip")
        XCTAssertFalse(NowPlayingMath.opensNowPlaying(dx: 0, dy: 80, velocityY: 900), "down")
    }

    func testReorderTargetClampsToUpcoming() {
        // current index 2, 10 rows: only 3...9 are valid slots.
        XCTAssertEqual(NowPlayingMath.reorderTarget(from: 5, dy: 130, rowHeight: 64, current: 2, count: 10), 7)
        XCTAssertEqual(NowPlayingMath.reorderTarget(from: 5, dy: -1000, rowHeight: 64, current: 2, count: 10), 3)
        XCTAssertEqual(NowPlayingMath.reorderTarget(from: 5, dy: 1000, rowHeight: 64, current: 2, count: 10), 9)
        XCTAssertEqual(NowPlayingMath.reorderTarget(from: 5, dy: 31, rowHeight: 64, current: 2, count: 10), 5)
        XCTAssertEqual(NowPlayingMath.reorderTarget(from: 5, dy: 33, rowHeight: 0, current: 2, count: 10), 6)
    }

    func testReorderShift() {
        // Dragging 3 down to 5: rows 4 and 5 move up.
        XCTAssertEqual(NowPlayingMath.reorderShift(row: 4, from: 3, to: 5, rowHeight: 64), -64)
        XCTAssertEqual(NowPlayingMath.reorderShift(row: 5, from: 3, to: 5, rowHeight: 64), -64)
        XCTAssertEqual(NowPlayingMath.reorderShift(row: 6, from: 3, to: 5, rowHeight: 64), 0)
        // Dragging 6 up to 4: rows 4 and 5 move down.
        XCTAssertEqual(NowPlayingMath.reorderShift(row: 4, from: 6, to: 4, rowHeight: 64), 64)
        XCTAssertEqual(NowPlayingMath.reorderShift(row: 3, from: 6, to: 4, rowHeight: 64), 0)
    }

    func testSleepLabels() {
        let now = 1_000_000.0
        XCTAssertEqual(NowPlayingMath.sleepLabel(at: nil, endOfTrack: false, now: now), "Sleep timer")
        XCTAssertEqual(NowPlayingMath.sleepLabel(at: nil, endOfTrack: true, now: now), "Sleep timer: end of track")
        XCTAssertEqual(NowPlayingMath.sleepLabel(at: now + 10_000, endOfTrack: false, now: now), "Sleep timer: 1 min left")
        XCTAssertEqual(NowPlayingMath.sleepLabel(at: now + 29.5 * 60_000, endOfTrack: false, now: now), "Sleep timer: 30 min left")
        XCTAssertEqual(NowPlayingMath.sleepLabel(at: now + 120 * 60_000, endOfTrack: false, now: now), "Sleep timer: 2 h left")
        XCTAssertEqual(NowPlayingMath.sleepLabel(at: now + 75 * 60_000, endOfTrack: false, now: now), "Sleep timer: 1 h 15 min left")
    }

    func testVolumeValueAndThrottle() {
        XCTAssertEqual(NowPlayingMath.volumeValue(x: 33.4, width: 100), 33)
        XCTAssertEqual(NowPlayingMath.volumeValue(x: -5, width: 100), 0)
        XCTAssertEqual(NowPlayingMath.volumeValue(x: 500, width: 100), 100)
        var t = NowPlayingMath.Throttle(interval: 0.12)
        XCTAssertEqual(t.offer(10, now: 1.0), .send(10))
        guard case .wait(let d) = t.offer(20, now: 1.05) else { return XCTFail("expected wait") }
        XCTAssertEqual(d, 0.07, accuracy: 1e-9)
        _ = t.offer(30, now: 1.08)
        XCTAssertEqual(t.flush(now: 1.12), 30)
        XCTAssertNil(t.flush(now: 1.2))
        XCTAssertEqual(t.offer(40, now: 1.3), .send(40))
    }
}

final class NowPlayingLyricsTests: XCTestCase {
    private func line(_ t: String, _ s: Double?) -> NowPlayingLyricLine { NowPlayingLyricLine(text: t, start: s) }

    func testServerMillisecondsBecomeSeconds() {
        let l = Lyrics(kind: "synced", source: nil, lines: [.init(start: 12340, text: "a"), .init(start: nil, text: "b")])
        let out = NowPlayingLyrics.lines(l)
        XCTAssertEqual(out[0].start, 12.34)
        XCTAssertNil(out[1].start)
    }

    func testPlainLinesDropBlanksOnly() {
        let out = NowPlayingLyrics.phoneLines([line("a", nil), line("  ", nil), line("", nil), line("b", nil)])
        XCTAssertEqual(out.map(\.text), ["a", "b"])
        XCTAssertFalse(NowPlayingLyrics.isSynced(out))
    }

    func testGapMarkersUseMedianThreshold() {
        // Spacing 3 s -> median 3 -> threshold max(5, 7.5) = 7.5.
        let input = [line("a", 2), line("b", 5), line("c", 8), line("", 9), line("d", 11), line("e", 30)]
        let out = NowPlayingLyrics.phoneLines(input)
        XCTAssertEqual(out.map(\.text), ["a", "b", "c", "d", "♪", "e"])
        let gap = out[4]
        XCTAssertTrue(gap.gap)
        XCTAssertEqual(gap.start, 16) // 11 + min(5, 19/2)
    }

    func testLeadingGapMarker() {
        let out = NowPlayingLyrics.phoneLines([line("a", 20), line("b", 22), line("c", 24)])
        XCTAssertEqual(out.first?.text, "♪")
        XCTAssertEqual(out.first?.start, 0)
        XCTAssertEqual(out.count, 4)
    }

    func testShortGapNoMarker() {
        let out = NowPlayingLyrics.phoneLines([line("a", 1), line("b", 3), line("c", 5.5)])
        XCTAssertEqual(out.count, 3)
    }

    func testActiveLineTiming() {
        let lines = [line("a", 10), line("b", 12), line("c", 15)]
        XCTAssertEqual(NowPlayingLyrics.activeIndex(lines, at: 9.9), -1)
        XCTAssertEqual(NowPlayingLyrics.activeIndex(lines, at: 10), 0)
        XCTAssertEqual(NowPlayingLyrics.activeIndex(lines, at: 14.99), 1)
        XCTAssertEqual(NowPlayingLyrics.activeIndex(lines, at: 100), 2)
        // The 0.25 s lead shows a line slightly early; a speaker delay pushes it later.
        XCTAssertEqual(NowPlayingLyrics.activeIndex(lines, at: NowPlayingLyrics.lookupTime(playhead: 11.8, speakerDelay: 0)), 1)
        XCTAssertEqual(NowPlayingLyrics.activeIndex(lines, at: NowPlayingLyrics.lookupTime(playhead: 11.8, speakerDelay: 0.5)), 0)
    }

    func testTopFadePredicate() {
        XCTAssertFalse(NowPlayingLyrics.showsTopFade(scrollOffset: 0, activeIndex: -1))
        XCTAssertFalse(NowPlayingLyrics.showsTopFade(scrollOffset: 1, activeIndex: 0))
        XCTAssertFalse(NowPlayingLyrics.showsTopFade(scrollOffset: -30, activeIndex: 0)) // overscroll bounce
        XCTAssertTrue(NowPlayingLyrics.showsTopFade(scrollOffset: 1.5, activeIndex: 0))
        XCTAssertTrue(NowPlayingLyrics.showsTopFade(scrollOffset: 0, activeIndex: 1))
    }

    func testNewSongResetsScrollOnce() {
        var r = NowPlayingLyricsReset()
        XCTAssertEqual(r.loaded(trackId: "a", activeIndex: -1), .top)
        // Same song again (sync finished, reload): never moves the list.
        XCTAssertNil(r.loaded(trackId: "a", activeIndex: 4))
        // Next song joined mid-way: go to its active line, once.
        XCTAssertEqual(r.loaded(trackId: "b", activeIndex: 7), .line(7))
        XCTAssertNil(r.loaded(trackId: "b", activeIndex: 9))
        // Back to the first song: it is new again.
        XCTAssertEqual(r.loaded(trackId: "a", activeIndex: 0), .line(0))
    }

    func testRetryDelays() {
        XCTAssertEqual(NowPlayingLyrics.retryDelay(attempt: 0), 2)
        XCTAssertEqual(NowPlayingLyrics.retryDelay(attempt: 1), 4)
        XCTAssertEqual(NowPlayingLyrics.retryDelay(attempt: 2), 8)
        XCTAssertNil(NowPlayingLyrics.retryDelay(attempt: 3))
    }
}

final class NowPlayingDevicesTests: XCTestCase {
    private func player(_ id: String, name: String, form: String? = nil, canPlay: Bool = true, np: NowPlaying? = nil) -> RosterPlayer {
        RosterPlayer(id: id, name: name, kind: "phone", form: form, canPlay: canPlay, nowPlaying: np, sameNetwork: true)
    }
    private func np(device: OutputDevice?) -> NowPlaying {
        NowPlaying(itemId: "t1", title: "T", artist: "A", device: device, playing: true, position: 0)
    }
    private func lan(_ id: String, _ kind: String, _ name: String, model: String? = nil, group: [String]? = nil) -> LanDevice {
        LanDevice(id: id, kind: kind, name: name, model: model, group: group, state: nil, viaClient: "server:u1")
    }

    func testListOrderAndModels() {
        let players = [player("c1", name: "MacBook", form: "laptop"), player("c2", name: "Off", canPlay: false), player("server:u1", name: "Server", canPlay: false)]
        let devs = NowPlayingDevices.devices(players: players, lan: [lan("b1", "bluos", "Kitchen"), lan("b1", "bluos", "Dup"), lan("r1", "roku", "Den", model: "Roku Ultra")])
        XCTAssertEqual(devs.map(\.id), ["relay:c1", "b1", "r1"])
        XCTAssertEqual(devs[0].model, "Laptop")
        XCTAssertEqual(devs[1].model, "Bluesound")
        XCTAssertEqual(devs[2].form, "tv")
        XCTAssertEqual(NowPlayingDevices.icon(devs[0]), .deviceLaptop)
        XCTAssertEqual(NowPlayingDevices.icon(devs[1]), .deviceSpeaker)
        XCTAssertEqual(NowPlayingDevices.icon(devs[2]), .deviceTV)
        XCTAssertEqual(NowPlayingDevices.icon(.local), .devicePhone)
    }

    func testTVRegex() {
        XCTAssertTrue(NowPlayingDevices.looksLikeTV(kind: "upnp", model: "Sony BRAVIA"))
        XCTAssertTrue(NowPlayingDevices.looksLikeTV(kind: "cast", model: "Living Room TV"))
        XCTAssertFalse(NowPlayingDevices.looksLikeTV(kind: "cast", model: "Nest Audio"))
        XCTAssertFalse(NowPlayingDevices.looksLikeTV(kind: "bridge", model: "TVX"))
    }

    func testSessionDeviceHereIsLocal() {
        let d = NowPlayingDevices.sessionDevice(activeId: "me", myId: "me", players: [], devices: [])
        XCTAssertEqual(d.id, "local")
        XCTAssertNil(NowPlayingDevices.elsewhereLabel(activeId: nil, myId: "me", players: []))
    }

    func testSessionDeviceOtherClient() {
        let players = [player("c1", name: "MacBook", form: "laptop", np: np(device: .local("This Computer")))]
        let devs = NowPlayingDevices.devices(players: players, lan: [])
        let d = NowPlayingDevices.sessionDevice(activeId: "c1", myId: "me", players: players, devices: devs)
        XCTAssertEqual(d.id, "relay:c1")
        XCTAssertEqual(NowPlayingDevices.elsewhereLabel(activeId: "c1", myId: "me", players: players), "MacBook")
        // This Phone is offered first among the others, the active client is not.
        XCTAssertEqual(NowPlayingDevices.others(devs, active: d).map(\.id), ["local"])
    }

    func testSessionDeviceSpeakerGroup() {
        let sp = OutputDevice(id: "k", kind: "bridge", name: "Kitchen", members: ["d"])
        let players = [player("server:u1", name: "Server", canPlay: false, np: np(device: sp))]
        let devs = NowPlayingDevices.devices(players: players, lan: [lan("k", "bridge", "Kitchen", group: ["k", "d"]), lan("d", "bridge", "Den"), lan("o", "cast", "Office")])
        let all = [NowPlayingDevice.local] + devs
        let d = NowPlayingDevices.sessionDevice(activeId: "server:u1", myId: "me", players: players, devices: devs)
        XCTAssertEqual(d.playingOn, ["k", "d"])
        XCTAssertEqual(NowPlayingDevices.label(d, in: all), "Kitchen + Den")
        XCTAssertEqual(NowPlayingDevices.subtitle(d, in: all), "Grouped with Den")
        XCTAssertEqual(NowPlayingDevices.elsewhereLabel(activeId: "server:u1", myId: "me", players: players), "Kitchen")
        XCTAssertEqual(NowPlayingDevices.others(devs, active: d).map(\.id), ["local", "o"])
    }

    func testMissingRelayRowIsSynthesised() {
        let players = [player("c9", name: "Tablet", form: "tablet", canPlay: false)]
        let d = NowPlayingDevices.sessionDevice(activeId: "c9", myId: "me", players: players, devices: [])
        XCTAssertEqual(d.id, "relay:c9")
        XCTAssertEqual(d.name, "Tablet")
        XCTAssertEqual(NowPlayingDevices.icon(d), .deviceTablet)
    }

    func testSublineFallsBackToKind() {
        let cast = NowPlayingDevice(id: "x", kind: "cast", name: "C", model: "")
        XCTAssertEqual(NowPlayingDevices.subline(cast, in: []), "Google Cast")
        XCTAssertEqual(NowPlayingDevices.subline(.local, in: []), "Phone playback")
        XCTAssertEqual(NowPlayingDevices.nameFor(.local), "This Phone")
    }
}

final class NowPlayingFromTests: XCTestCase {
    func testImmediateContexts() {
        XCTAssertEqual(NowPlayingFrom.immediate(nil), NowPlayingFrom(kind: "PLAYING FROM", name: "Your Library"))
        XCTAssertEqual(NowPlayingFrom.immediate("liked")?.name, "Liked Songs")
        XCTAssertEqual(NowPlayingFrom.immediate("radar")?.name, "Release Radar")
        XCTAssertEqual(NowPlayingFrom.immediate("genre:Jazz"), NowPlayingFrom(kind: "PLAYING FROM GENRE", name: "Jazz"))
        XCTAssertNil(NowPlayingFrom.immediate("al123"))
        XCTAssertEqual(NowPlayingFrom.itemId("artist:ar1"), "ar1")
        XCTAssertEqual(NowPlayingFrom.itemId("mix:ar2"), "ar2")
        XCTAssertEqual(NowPlayingFrom.itemId("al1"), "al1")
    }

    func testModeCycles() {
        XCTAssertEqual(Player.Shuffle.off.nowPlayingNext, .on)
        XCTAssertEqual(Player.Shuffle.on.nowPlayingNext, .smart)
        XCTAssertEqual(Player.Shuffle.smart.nowPlayingNext, .off)
        XCTAssertEqual(Player.Repeat.all.nowPlayingNext, .one)
        XCTAssertEqual(Player.Repeat.one.nowPlayingGlyph, .one)
        XCTAssertEqual(Player.Shuffle.smart.nowPlayingGlyph, .smart)
    }
}
