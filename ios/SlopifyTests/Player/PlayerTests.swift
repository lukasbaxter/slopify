import XCTest
@testable import Slopify

@MainActor
final class PlayerTests: XCTestCase {
    private func settle() async {
        for _ in 0..<8 { await Task.yield(); try? await Task.sleep(for: .milliseconds(15)) }
    }

    // MARK: local start

    func testPlayClaimsLoadsReportsAndPublishes() {
        let (p, e, l, _) = makePlayer()
        p.play(tracks("a", "b", "c"), startAt: 1, context: "pl_1")
        XCTAssertEqual(l.claims, 1)
        XCTAssertEqual(e.loads.count, 1)
        XCTAssertEqual(e.loads[0].0.id, "b")
        let url = e.loads[0].0.url.absoluteString
        XCTAssertTrue(url.contains("max=aac-320"), url)
        XCTAssertTrue(url.contains("norm=track"), url)
        XCTAssertEqual(p.current?.id, "b")
        XCTAssertTrue(p.isPlaying)
        XCTAssertTrue(p.isLoading)
        XCTAssertFalse(p.isRemote)
        let last = l.reports.last!!
        XCTAssertEqual(last.itemId, "b")
        XCTAssertEqual(last.queueIndex, 1)
        XCTAssertTrue(last.playing)
        XCTAssertEqual(last.held, true)
        XCTAssertEqual(last.device?.id, "local")
        XCTAssertEqual(l.published.last?.map(\.Id), ["a", "b", "c"])
        p.audioHeard("b")
        XCTAssertFalse(p.isLoading)
        XCTAssertEqual(l.reports.last??.held, false)
    }

    func testAlbumContextUsesAlbumGainAndLosslessAppliesGain() {
        let (p, e, _, _) = makePlayer(prefs: ["phoneQuality": .string("original")])
        p.play([makeTrack("a", album: "al1", gain: Gain(track: -6.0206, album: -12.0412))], context: "al1")
        let item = e.loads[0].0
        XCTAssertTrue(item.url.absoluteString.contains("max=alac"))
        XCTAssertEqual(item.gain, 0.25, accuracy: 0.001, "album gain applied by the player for lossless")
        let (p2, e2, _, _) = makePlayer()
        p2.play([makeTrack("a", album: "al1")], context: "al1")
        XCTAssertTrue(e2.loads[0].0.url.absoluteString.contains("norm=album"))
    }

    func testLocalFileWinsOverStream() {
        let (p, e, _, _) = makePlayer()
        let file = URL(fileURLWithPath: "/tmp/a.m4a")
        p.localFile = { $0 == "a" ? file : nil }
        p.play(tracks("a"))
        XCTAssertEqual(e.loads[0].0.url, file)
    }

    func testShuffleArgumentKeepsChosenFirst() {
        let (p, _, _, _) = makePlayer()
        p.play(tracks("a", "b", "c", "d"), startAt: 2, shuffle: true)
        XCTAssertEqual(p.shuffle, .on)
        XCTAssertEqual(p.index, 0)
        XCTAssertEqual(p.current?.id, "c")
        p.setShuffle(.off)
        XCTAssertEqual(p.queue.map(\.id), ["a", "b", "c", "d"])
        XCTAssertEqual(p.current?.id, "c")
    }

    func testAddToQueueFlagsAndPreview() {
        let (p, _, _, _) = makePlayer()
        p.addToQueue(tracks("x"))
        XCTAssertEqual(p.queue.map(\.id), ["x"])
        XCTAssertFalse(p.isPlaying, "an empty queue just shows them paused")
        p.play(tracks("a", "b"))
        p.addToQueue(tracks("q1"))
        p.addToQueue(tracks("q2"))
        XCTAssertEqual(p.queue.map(\.id), ["a", "q1", "q2", "b"])
        XCTAssertEqual(p.queuedFlags, [false, true, true, false])
        p.clearQueued()
        XCTAssertEqual(p.queue.map(\.id), ["a", "b"])
    }

    func testPreviousRestartsPastThreeSeconds() {
        let (p, e, _, _) = makePlayer()
        p.play(tracks("a", "b"), startAt: 1)
        e.currentTime = 12
        p.previous()
        XCTAssertEqual(e.seeks, [0])
        XCTAssertEqual(p.current?.id, "b")
        e.currentTime = 1
        p.previous()
        XCTAssertEqual(p.current?.id, "a")
    }

    func testNextAtEndAutoplaysDroppingSeed() async {
        let (p, e, _, b) = makePlayer()
        p.play(tracks("a", "b"), startAt: 1)
        await settle()   // the early extension found nothing
        b.mixes["b"] = tracks("b", "c", "d")
        b.mixCalls = []
        p.audioEnded("b")
        await settle()
        XCTAssertEqual(b.mixCalls.first?.0, "b")
        XCTAssertEqual(b.mixCalls.first?.1, 25)
        XCTAssertEqual(b.mixCalls.first?.2, "continue")
        XCTAssertEqual(p.queue.map(\.id), ["a", "b", "c", "d"])
        XCTAssertEqual(p.current?.id, "c")
        XCTAssertEqual(e.loads.last?.0.id, "c")
    }

    func testEarlyExtensionAppendsBeforeTheEnd() async {
        let (p, _, _, b) = makePlayer()
        b.mixes["c"] = tracks("c", "x", "y")
        p.play(tracks("a", "b", "c"), startAt: 1)
        await settle()
        XCTAssertEqual(p.queue.map(\.id), ["a", "b", "c", "x", "y"])
    }

    func testRepeatAllRestartsAndRepeatOneReplays() {
        let (p, e, _, _) = makePlayer()
        p.play(tracks("a", "b"), startAt: 1)
        p.setRepeat(.all)
        p.audioEnded("b")
        XCTAssertEqual(p.current?.id, "a")
        p.setRepeat(.one)
        p.audioEnded("a")
        XCTAssertEqual(p.current?.id, "a")
        XCTAssertEqual(e.loads.map(\.0.id), ["b", "a", "a"])
    }

    func testSleepEndOfTrackParksPaused() {
        let (p, e, l, _) = makePlayer()
        p.play(tracks("a", "b"))
        l.sleep = (nil, true)
        p.audioEnded("a")
        XCTAssertEqual(p.current?.id, "b")
        XCTAssertFalse(p.isPlaying)
        XCTAssertEqual(p.position, 0)
        XCTAssertEqual(l.sleepDones, 1)
        XCTAssertGreaterThan(e.unloads, 0)
    }

    func testGaplessPreloadAndAutomaticAdvance() async {
        let (p, e, l, _) = makePlayer()
        p.play(tracks("a", "b"), context: "pl_1")
        p.audioHeard("a")
        await settle()
        XCTAssertEqual(e.next?.0?.id, "b")
        XCTAssertEqual(e.next?.1, .gapless)
        p.audioAdvanced(to: "b")
        XCTAssertEqual(p.current?.id, "b")
        XCTAssertEqual(e.loads.count, 1, "no reload for a gapless hand-over")
        XCTAssertEqual(l.reports.last??.itemId, "b")
    }

    func testCrossfadePref() async {
        let (p, e, _, _) = makePlayer(prefs: ["crossfade": .number(5)])
        p.play(tracks("a", "b"), context: "pl_1")
        p.audioHeard("a")
        await settle()
        XCTAssertEqual(e.next?.1, .crossfade(5))
    }

    func testWarmsUpcoming() async {
        let (p, _, _, b) = makePlayer()
        p.play(tracks("a", "b", "c", "d", "e"))
        p.audioHeard("a")
        try? await Task.sleep(for: .seconds(3.3))
        XCTAssertEqual(b.warms.last, ["b", "c", "d"])
    }

    func testPausePositionAndLockReports() {
        let (p, e, l, _) = makePlayer()
        p.play(tracks("a"))
        p.audioHeard("a")
        e.currentTime = 42
        p.togglePlay()
        XCTAssertFalse(p.isPlaying)
        XCTAssertFalse(e.playing)
        XCTAssertEqual(p.position, 42)
        XCTAssertEqual(l.reports.last??.playing, false)
        XCTAssertEqual(l.reports.last??.position, 42)
    }

    func testPlayAfterRestoreLoadsAtSavedPosition() {
        let (p, e, l, _) = makePlayer()
        p.addToQueue(tracks("a"))
        p.seek(to: 30)
        p.setPlaying(true)
        XCTAssertEqual(l.claims, 1)
        XCTAssertEqual(e.loads.last?.0.id, "a")
        XCTAssertEqual(e.loads.last?.1, 30)
    }

    func testPlaysPostedOnlyWithoutSocket() async {
        let (p, _, l, b) = makePlayer()
        p.play(tracks("a"))
        p.audioHeard("a")
        p.countListen(9)
        await settle()
        XCTAssertEqual(b.plays, [], "socket up: the server logs it")
        l.connection = .disconnected
        p.previous()   // replay from the top counts again
        p.audioHeard("a")
        p.countListen(5)
        await settle()
        XCTAssertEqual(b.plays, [])
        p.countListen(4)
        await settle()
        XCTAssertEqual(b.plays, ["a"])
    }

    // MARK: mirror

    private func mirror(_ p: Player, _ l: FakeLink, playing: Bool = true) {
        l.activeClientId = "desk"
        l.players = [RosterPlayer(id: "desk", name: "Desk", kind: "desktop", form: "laptop", canPlay: true,
                                  nowPlaying: np("y", index: 1, playing: playing, position: 33), sameNetwork: true)]
        l.queues["desk"] = tracks("x", "y", "z").map { QueueItem($0) }
        p.sessionChanged()
    }

    func testMirrorRendersRemoteAndRoutesControls() {
        let (p, e, l, _) = makePlayer()
        mirror(p, l)
        XCTAssertTrue(p.isRemote)
        XCTAssertEqual(p.remoteClientId, "desk")
        XCTAssertEqual(p.output.name, "Desk")
        XCTAssertEqual(p.queue.map(\.id), ["x", "y", "z"])
        XCTAssertEqual(p.index, 1)
        XCTAssertTrue(p.isPlaying)
        XCTAssertEqual(p.position, 33)
        XCTAssertEqual(p.volume, 70)
        XCTAssertEqual(p.repeatMode, .all)
        let reportsBefore = l.reports.count
        p.togglePlay()
        p.next(); p.previous(); p.seek(to: 5); p.skip(to: 2); p.setVolume(20)
        p.setRepeat(.one); p.setShuffle(.on); p.addToQueue(tracks("n")); p.removeFromQueue(at: 2)
        p.moveInQueue(from: 2, to: 1); p.clearQueued()
        p.play(tracks("k", "m"), startAt: 1, context: "al9")
        XCTAssertEqual(l.sent.map(\.1), Array(repeating: "desk", count: 13))
        XCTAssertEqual(l.sent.map(\.0), [
            .setPlaying(false), .next, .previous, .seek(pos: 5), .skipTo(index: 2), .setVolume(level: 20),
            .setRepeat("one"), .setShuffle("on"), .enqueue(trackIds: ["n"]), .queueRemove(index: 2),
            .queueMove(from: 2, to: 1), .queueClear, .play(trackIds: ["k", "m"], index: 1, ctx: "al9", startAt: nil),
        ])
        XCTAssertEqual(l.reports.count, reportsBefore, "mirrors never report")
        XCTAssertEqual(l.claims, 0)
        XCTAssertTrue(e.loads.isEmpty)
    }

    func testMirrorEndsBackToLocal() {
        let (p, _, l, _) = makePlayer()
        p.addToQueue(tracks("a"))
        mirror(p, l)
        XCTAssertTrue(p.isRemote)
        l.activeClientId = nil
        l.players = []
        p.sessionChanged()
        XCTAssertFalse(p.isRemote)
        XCTAssertEqual(p.queue.map(\.id), ["a"])
    }

    func testHandOffToClientStopsHere() {
        let (p, e, l, _) = makePlayer()
        p.play(tracks("a", "b"), startAt: 1, context: "pl_1")
        e.currentTime = 50
        p.transfer(toClient: "desk")
        guard case let .transfer(t)? = l.sent.last?.0 else { return XCTFail("no transfer") }
        XCTAssertEqual(l.sent.last?.1, "desk")
        XCTAssertEqual(t.trackIds, ["a", "b"])
        XCTAssertEqual(t.index, 1)
        XCTAssertEqual(t.position, 50)
        XCTAssertTrue(t.playing)
        XCTAssertEqual(t.ctx, "pl_1")
        XCTAssertEqual(t.deviceId, "local")
        XCTAssertFalse(p.isPlaying)
        XCTAssertGreaterThan(e.unloads, 0)
    }

    func testSpeakerTransferGoesViaClient() {
        let (p, _, l, _) = makePlayer()
        p.play(tracks("a"))
        p.transfer(toSpeaker: LanDevice(id: "bluos:1", kind: "bluos", name: "Node", model: nil, group: nil, state: nil, viaClient: "server:u1"))
        guard case let .transfer(t)? = l.sent.last?.0 else { return XCTFail("no transfer") }
        XCTAssertEqual(l.sent.last?.1, "server:u1")
        XCTAssertEqual(t.deviceId, "bluos:1")
    }

    func testTakeOverFromMirror() {
        let (p, e, l, _) = makePlayer()
        mirror(p, l)
        p.transfer(toClient: nil)
        XCTAssertEqual(l.claims, 1)
        XCTAssertFalse(p.isRemote)
        XCTAssertEqual(p.queue.map(\.id), ["x", "y", "z"])
        XCTAssertEqual(e.loads.last?.0.id, "y")
        XCTAssertEqual(e.loads.last?.1, 33)
        XCTAssertTrue(p.isPlaying)
    }

    func testMirrorHandOffBuildsFromActiveQueue() {
        let (p, _, l, _) = makePlayer()
        mirror(p, l)
        p.transfer(toClient: "tv")
        guard case let .transfer(t)? = l.sent.last?.0 else { return XCTFail("no transfer") }
        XCTAssertEqual(l.sent.last?.1, "tv")
        XCTAssertEqual(t.trackIds, ["x", "y", "z"])
        XCTAssertEqual(t.index, 1)
        XCTAssertEqual(t.position, 33)
    }

    // MARK: commands

    func testTransferCommandStartsThenFillsQueue() async {
        let (p, e, l, b) = makePlayer()
        for t in tracks("x", "y", "z") { b.library[t.id] = t }
        p.handle(.transfer(.init(trackIds: ["x", "y", "z"], queued: [false, false, true], index: 1, position: 20,
                                 playing: true, ctx: "pl_2", original: nil, deviceId: "local")), from: "desk")
        XCTAssertEqual(l.claims, 1)
        await settle()
        XCTAssertEqual(e.loads.first?.0.id, "y")
        XCTAssertEqual(e.loads.first?.1, 20)
        XCTAssertEqual(e.loads.count, 1, "the queue fill does not restart the song")
        XCTAssertEqual(p.queue.map(\.id), ["x", "y", "z"])
        XCTAssertEqual(p.queuedFlags, [false, false, true])
        XCTAssertEqual(p.index, 1)
        XCTAssertEqual(p.context, "pl_2")
    }

    func testPausedTransferShowsWithoutLoading() async {
        let (p, e, _, b) = makePlayer()
        b.library["x"] = makeTrack("x")
        p.handle(.transfer(.init(trackIds: ["x"], queued: nil, index: 0, position: 9, playing: false, ctx: nil, original: nil, deviceId: "local")), from: "desk")
        await settle()
        XCTAssertEqual(p.current?.id, "x")
        XCTAssertEqual(p.position, 9)
        XCTAssertFalse(p.isPlaying)
        XCTAssertTrue(e.loads.isEmpty)
    }

    func testPlayCommandHonoursShuffle() async {
        let (p, e, _, b) = makePlayer()
        for t in tracks("a", "b", "c", "d") { b.library[t.id] = t }
        p.setShuffle(.on)
        p.handle(.play(trackIds: ["a", "b", "c", "d"], index: 2, ctx: nil, startAt: nil), from: "phone2")
        await settle()
        XCTAssertEqual(e.loads.first?.0.id, "c")
        XCTAssertEqual(p.current?.id, "c")
        XCTAssertEqual(p.index, 0)
        XCTAssertEqual(Set(p.queue.map(\.id)), ["a", "b", "c", "d"])
    }

    func testSimpleCommands() async {
        let (p, e, l, b) = makePlayer()
        b.library["n"] = makeTrack("n")
        p.play(tracks("a", "b", "c"))
        p.handle(.setVolume(level: 30), from: "x")
        XCTAssertEqual(p.volume, 30)
        XCTAssertEqual(e.volume, 0.3, accuracy: 0.001)
        p.handle(.volumeStep(1), from: "x")
        XCTAssertEqual(p.volume, 35)
        p.handle(.setRepeat("all"), from: "x")
        XCTAssertEqual(p.repeatMode, .all)
        p.handle(.seek(pos: 12), from: "x")
        XCTAssertEqual(e.seeks.last, 12)
        p.handle(.next, from: "x")
        XCTAssertEqual(p.current?.id, "b")
        p.handle(.skipTo(index: 0), from: "x")
        try? await Task.sleep(for: .milliseconds(400))
        XCTAssertEqual(p.current?.id, "a")
        p.handle(.enqueue(trackIds: ["n"]), from: "x")
        await settle()
        XCTAssertEqual(p.queue.map(\.id), ["a", "n", "b", "c"])
        p.handle(.queueRemove(index: 1), from: "x")
        XCTAssertEqual(p.queue.map(\.id), ["a", "b", "c"])
        p.handle(.patchLiked(itemId: "a", liked: true), from: "x")
        XCTAssertEqual(l.reports.last??.liked, true)
        p.handle(.setPlaying(false), from: "server")
        XCTAssertFalse(p.isPlaying)
        p.handle(.toggle, from: "x")
        XCTAssertTrue(p.isPlaying)
        p.handle(.unknown("dance"), from: "x")
        XCTAssertTrue(l.sent.isEmpty, "commands are executed here, never routed back")
    }

    func testYieldUnloadsAndStopsReporting() {
        let (p, e, l, _) = makePlayer()
        p.play(tracks("a"))
        p.handle(.yield, from: "desk")
        XCTAssertFalse(p.isPlaying)
        XCTAssertNil(e.currentId)
        let n = l.reports.count
        p.setVolume(10)
        XCTAssertEqual(l.reports.count, n, "nothing loaded and not active: no reports")
    }

    func testOnCommandIsWired() {
        let (p, _, l, _) = makePlayer()
        p.play(tracks("a"))
        l.onCommand?(.setPlaying(false), "desk")
        XCTAssertFalse(p.isPlaying)
    }

    // MARK: session snapshot (§20.4)

    func testAdoptsSessionWhenEmpty() {
        let (p, e, l, _) = makePlayer()
        l.lastSession = (np("y", index: 1, playing: false, position: 77), tracks("x", "y").map { QueueItem($0) }, 1000)
        p.sessionChanged()
        XCTAssertEqual(p.queue.map(\.id), ["x", "y"])
        XCTAssertEqual(p.index, 1)
        XCTAssertEqual(p.position, 77)
        XCTAssertFalse(p.isPlaying)
        XCTAssertTrue(e.loads.isEmpty)
    }

    func testIgnoresSessionWhilePlayingHere() {
        let (p, _, l, _) = makePlayer()
        p.play(tracks("a"))
        l.lastSession = (np("y", playing: false), tracks("y").map { QueueItem($0) }, Date().timeIntervalSince1970 * 1000 + 10_000)
        p.sessionChanged()
        XCTAssertEqual(p.current?.id, "a")
    }

    func testSessionWithoutMatchingQueueShowsTrackAlone() {
        let (p, _, l, _) = makePlayer()
        l.lastSession = (np("q", index: 0, playing: false, position: 5), [], 1000)
        p.sessionChanged()
        XCTAssertEqual(p.queue.map(\.id), ["q"])
        XCTAssertEqual(p.current?.title, "Tq")
    }

    // MARK: persistence

    func testPersistenceRoundTrip() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = PlayerPersistence(dir: dir)
        let (p, e, _, _) = makePlayer()
        p.configure(backend: FakeBackend(), link: FakeLink(), prefs: { [:] }, engine: e, audioSession: nil, lockScreen: nil, store: store)
        p.play(tracks("a", "b", "c"), startAt: 1)
        p.addToQueue(tracks("q"))
        p.setRepeat(.all)
        e.currentTime = 64
        p.flushPersistence()

        let (p2, e2, _, _) = makePlayer()
        p2.configure(backend: FakeBackend(), link: FakeLink(), prefs: { [:] }, engine: e2, audioSession: nil, lockScreen: nil, store: store)
        XCTAssertEqual(p2.queue.map(\.id), ["a", "b", "q", "c"])
        XCTAssertEqual(p2.queuedFlags, [false, false, true, false])
        XCTAssertEqual(p2.current?.id, "b")
        XCTAssertEqual(p2.position, 64)
        XCTAssertEqual(p2.repeatMode, .all)
        XCTAssertFalse(p2.isPlaying, "a relaunch shows the last song paused")
        XCTAssertTrue(e2.loads.isEmpty)
        XCTAssertGreaterThan(p2.savedAt, 0)
    }

    func testNewerOwnPlayheadBeatsOlderSession() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = PlayerPersistence(dir: dir)
        let (p, e, _, _) = makePlayer()
        p.configure(backend: FakeBackend(), link: FakeLink(), prefs: { [:] }, engine: e, audioSession: nil, lockScreen: nil, store: store)
        p.play(tracks("a"))
        p.flushPersistence()
        let (p2, e2, l2, _) = makePlayer()
        p2.configure(backend: FakeBackend(), link: l2, prefs: { [:] }, engine: e2, audioSession: nil, lockScreen: nil, store: store)
        l2.lastSession = (np("old", playing: false), [], 1000)
        p2.sessionChanged()
        XCTAssertEqual(p2.current?.id, "a")
        l2.lastSession = (np("new", playing: false), [], Date().timeIntervalSince1970 * 1000 + 60_000)
        p2.sessionChanged()
        XCTAssertEqual(p2.current?.id, "new")
    }

    // MARK: report shape

    func testNowPlayingReportShape() {
        let t = makeTrack("a", album: "al1", artistId: "ar1")
        let r = SessionReports.nowPlaying(.init(track: t, index: 2, playing: true, held: false, position: 10, duration: 200, volume: 80,
                                                repeatMode: .one, shuffle: .smart, liked: true, device: .local("This Phone"),
                                                artUrl: nil, now: 5))
        XCTAssertEqual(r.itemId, "a")
        XCTAssertEqual(r.artists, [NameId(Id: "ar1", Name: "Artist")])
        XCTAssertEqual(r.artistId, "ar1")
        XCTAssertEqual(r.repeat, "one")
        XCTAssertEqual(r.shuffle, "smart")
        XCTAssertEqual(r.held, false)
        XCTAssertEqual(r.queueIndex, 2)
    }

    func testTrackFromQueueItemRoundTrip() {
        let t = makeTrack("a", ms: 383_000, gain: Gain(track: -6.3, album: -5.8))
        let back = Track(item: QueueItem(t))
        XCTAssertEqual(back.id, "a")
        XCTAssertEqual(back.durationMs, 383_000)
        XCTAssertEqual(back.gain, t.gain)
        XCTAssertEqual(back.artistIds, ["ar1"])
        XCTAssertEqual(back.albumId, "al1")
    }
}
