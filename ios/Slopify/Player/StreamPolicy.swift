import Foundation

/// Which stream to ask for and how loud to play it (API.md §12.3, §12.7). Pure.
enum StreamPolicy {
    /// Web quality id -> HLS `max` profile (API.md §12.7).
    static func profile(forQuality q: String?) -> String {
        switch q {
        case "original": return "alac"
        case "normal": return "aac-160"
        case "low": return "aac-96"
        default: return "aac-320"   // "high" and unknown
        }
    }

    /// Phones read `phoneQuality` (default high), tablets `quality` (default original).
    static func quality(prefs: [String: JSONValue], tablet: Bool) -> String {
        tablet ? (prefs["quality"]?.string ?? "original") : (prefs["phoneQuality"]?.string ?? "high")
    }

    static func normalize(prefs: [String: JSONValue]) -> Bool { prefs["normalize"]?.bool != false }

    /// web `normModeFor`: album gain when the queue was played from this track's album.
    static func normMode(track: Track, context: String?, normalize: Bool) -> String? {
        guard normalize else { return nil }
        return context != nil && context == track.albumId ? "album" : "track"
    }

    /// web `gainDbFor`: album falls back to track; unmeasured = 0 dB.
    static func gainDb(track: Track, mode: String?) -> Double {
        guard let mode, let g = track.gain else { return 0 }
        return (mode == "album" ? (g.album ?? g.track) : g.track) ?? 0
    }

    /// Linear factor the player itself applies. Only where the server did not bake the
    /// gain in: lossless HLS and downloaded originals. Capped at 1 because AVPlayer volume
    /// cannot amplify (positive gains play at 0 dB; see the report).
    static func clientGain(track: Track, context: String?, normalize: Bool, profile: String) -> Float {
        // AAC: baked in by the server (HLS, or the whole-file download with norm). Lossless
        // HLS and original downloads (§13) never carry it.
        guard profile == "alac" else { return 1 }
        let db = gainDb(track: track, mode: normMode(track: track, context: context, normalize: normalize))
        return Float(min(1, pow(10, db / 20)))
    }

    /// Mobile-data stall cap (web linkWatch.js): one rung lower for a while.
    static func capped(_ profile: String) -> String {
        ["alac": "aac-320", "aac-320": "aac-160", "aac-160": "aac-96"][profile] ?? profile
    }

    static func crossfadeSetting(prefs: [String: JSONValue]) -> Double { min(12, max(0, prefs["crossfade"]?.double ?? 0)) }
    static func gapless(prefs: [String: JSONValue]) -> Bool { prefs["gapless"]?.bool != false }

    /// web `transitionPlan`: how the current song hands over to the next when it ends by
    /// itself. An album in order is always gapless; fades are at most a third of either song.
    static func transition(current: Track, next: Track, context: String?, crossfade: Double, gapless: Bool,
                           repeatOne: Bool, sleepEndOfTrack: Bool) -> AudioTransition {
        if repeatOne || sleepEndOfTrack { return .none }
        let inAlbum = context != nil && current.albumId == context && next.albumId == current.albumId
        var fade = inAlbum ? 0 : crossfade
        if fade > 0 { fade = min(fade, current.duration / 3, next.duration / 3) }
        if fade > 0 { return .crossfade(fade) }
        return gapless ? .gapless : .none
    }

    /// Ids to warm (web `preloadRef`): the next three, or the first one under repeat all.
    static func warmIds(entries: [QueueEntry], index: Int, repeatAll: Bool) -> [String] {
        var ids = entries.dropFirst(index + 1).prefix(3).map(\.track.id)
        if ids.isEmpty, repeatAll, let f = entries.first { ids = [f.track.id] }
        return ids
    }

    /// Prefs `dislikes` (`{ trackId: ms }`): dropped from every mix (web `instantMix`).
    static func dropDisliked(_ tracks: [Track], prefs: [String: JSONValue]) -> [Track] {
        guard let d = prefs["dislikes"]?.object, !d.isEmpty else { return tracks }
        return tracks.filter { d[$0.id] == nil }
    }
}

/// Hardware volume steps (web `makeVolumeStepper`): one step per 300 ms, 5 per step, a run
/// goes at most 20 above where it began until the buttons rest for 3 s.
struct VolumeStepper {
    private var last: Double = 0
    private var runFrom: Double?

    mutating func step(from: Double, step: Int, now: Double) -> Double? {
        guard step != 0, now - last >= 300 else { return nil }
        if runFrom == nil || now - last > 3000 { runFrom = from }
        last = now
        let want = max(0, min(100, from + Double(step.signum()) * 5))
        let next = min(want, max(from, (runFrom ?? from) + 20))
        return next == from ? nil : next
    }
}

/// Localization keys (web locales, English key = text). TODO(lead): route through L() once
/// Design/Localization exists; the keys below are the web's.
enum PlayerText {
    static func format(_ key: String, _ args: [String: String] = [:]) -> String {
        args.reduce(key) { $0.replacingOccurrences(of: "{\($1.key)}", with: $1.value) }
    }
}
