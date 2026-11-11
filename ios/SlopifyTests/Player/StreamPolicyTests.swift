import XCTest
@testable import Slopify

final class StreamPolicyTests: XCTestCase {
    func testQualityMapping() {
        XCTAssertEqual(StreamPolicy.profile(forQuality: "original"), "alac")
        XCTAssertEqual(StreamPolicy.profile(forQuality: "high"), "aac-320")
        XCTAssertEqual(StreamPolicy.profile(forQuality: "normal"), "aac-160")
        XCTAssertEqual(StreamPolicy.profile(forQuality: "low"), "aac-96")
        XCTAssertEqual(StreamPolicy.profile(forQuality: nil), "aac-320")
    }

    func testPhoneVsTabletPref() {
        XCTAssertEqual(StreamPolicy.quality(prefs: [:], tablet: false), "high")
        XCTAssertEqual(StreamPolicy.quality(prefs: [:], tablet: true), "original")
        let p: [String: JSONValue] = ["phoneQuality": .string("low"), "quality": .string("normal")]
        XCTAssertEqual(StreamPolicy.quality(prefs: p, tablet: false), "low")
        XCTAssertEqual(StreamPolicy.quality(prefs: p, tablet: true), "normal")
    }

    func testNormModeAlbumOnlyFromItsAlbum() {
        let t = makeTrack("a", album: "al1")
        XCTAssertEqual(StreamPolicy.normMode(track: t, context: "al1", normalize: true), "album")
        XCTAssertEqual(StreamPolicy.normMode(track: t, context: "pl_x", normalize: true), "track")
        XCTAssertEqual(StreamPolicy.normMode(track: t, context: nil, normalize: true), "track")
        XCTAssertNil(StreamPolicy.normMode(track: t, context: "al1", normalize: false))
        XCTAssertTrue(StreamPolicy.normalize(prefs: [:]))
        XCTAssertFalse(StreamPolicy.normalize(prefs: ["normalize": .bool(false)]))
    }

    func testGainRule() {
        let both = makeTrack("a", gain: Gain(track: -6, album: -4))
        XCTAssertEqual(StreamPolicy.gainDb(track: both, mode: "album"), -4)
        XCTAssertEqual(StreamPolicy.gainDb(track: both, mode: "track"), -6)
        let trackOnly = makeTrack("b", gain: Gain(track: -3, album: nil))
        XCTAssertEqual(StreamPolicy.gainDb(track: trackOnly, mode: "album"), -3, "album falls back to track")
        XCTAssertEqual(StreamPolicy.gainDb(track: makeTrack("c"), mode: "track"), 0, "unmeasured plays as is")
        XCTAssertEqual(StreamPolicy.gainDb(track: both, mode: nil), 0)
    }

    func testClientGainOnlyForLossless() {
        let t = makeTrack("a", gain: Gain(track: -6.0206, album: nil))
        XCTAssertEqual(StreamPolicy.clientGain(track: t, context: nil, normalize: true, profile: "aac-320"), 1)
        XCTAssertEqual(StreamPolicy.clientGain(track: t, context: nil, normalize: true, profile: "alac"), 0.5, accuracy: 0.001)
        XCTAssertEqual(StreamPolicy.clientGain(track: t, context: nil, normalize: false, profile: "alac"), 1)
        let loud = makeTrack("b", gain: Gain(track: 4, album: nil))
        XCTAssertEqual(StreamPolicy.clientGain(track: loud, context: nil, normalize: true, profile: "alac"), 1, "positive gain capped")
    }

    func testTransitionPlan() {
        let a = makeTrack("a", album: "al1", ms: 200_000), b = makeTrack("b", album: "al1", ms: 200_000)
        let c = makeTrack("c", album: "al2", ms: 9_000)
        XCTAssertEqual(StreamPolicy.transition(current: a, next: b, context: "al1", crossfade: 5, gapless: true, repeatOne: false, sleepEndOfTrack: false), .gapless, "album in order never fades")
        XCTAssertEqual(StreamPolicy.transition(current: a, next: b, context: "pl", crossfade: 5, gapless: true, repeatOne: false, sleepEndOfTrack: false), .crossfade(5))
        XCTAssertEqual(StreamPolicy.transition(current: a, next: c, context: nil, crossfade: 5, gapless: true, repeatOne: false, sleepEndOfTrack: false), .crossfade(3), "a third of the shorter song")
        XCTAssertEqual(StreamPolicy.transition(current: a, next: b, context: nil, crossfade: 0, gapless: false, repeatOne: false, sleepEndOfTrack: false), AudioTransition.none)
        XCTAssertEqual(StreamPolicy.transition(current: a, next: b, context: nil, crossfade: 5, gapless: true, repeatOne: false, sleepEndOfTrack: true), AudioTransition.none)
        XCTAssertEqual(StreamPolicy.crossfadeSetting(prefs: ["crossfade": .number(30)]), 12)
    }

    func testWarmIds() {
        let rows = tracks("a", "b", "c", "d", "e").map { QueueEntry(track: $0) }
        XCTAssertEqual(StreamPolicy.warmIds(entries: rows, index: 0, repeatAll: false), ["b", "c", "d"])
        XCTAssertEqual(StreamPolicy.warmIds(entries: rows, index: 4, repeatAll: false), [])
        XCTAssertEqual(StreamPolicy.warmIds(entries: rows, index: 4, repeatAll: true), ["a"])
    }

    func testDislikesDropped() {
        let p: [String: JSONValue] = ["dislikes": .object(["b": .number(1)])]
        XCTAssertEqual(StreamPolicy.dropDisliked(tracks("a", "b", "c"), prefs: p).map(\.id), ["a", "c"])
    }

    func testVolumeStepper() {
        var s = VolumeStepper()
        XCTAssertEqual(s.step(from: 50, step: 1, now: 1000), 55)
        XCTAssertNil(s.step(from: 55, step: 1, now: 1100), "one step per 300 ms")
        XCTAssertEqual(s.step(from: 55, step: 1, now: 1400), 60)
        XCTAssertEqual(s.step(from: 60, step: 1, now: 1800), 65)
        XCTAssertEqual(s.step(from: 65, step: 1, now: 2200), 70)
        XCTAssertNil(s.step(from: 70, step: 1, now: 2600), "a run goes at most 20 up")
        XCTAssertEqual(s.step(from: 70, step: 1, now: 6000), 75, "after a 3 s rest")
        XCTAssertEqual(s.step(from: 75, step: -1, now: 6400), 70)
    }

    func testCappedProfile() {
        XCTAssertEqual(StreamPolicy.capped("alac"), "aac-320")
        XCTAssertEqual(StreamPolicy.capped("aac-96"), "aac-96")
    }
}
