import Foundation
import CoreGraphics

/// One shown lyric line. `start` in seconds; `gap` = an inserted "♪".
struct NowPlayingLyricLine: Hashable, Sendable {
    var text: String
    var start: Double?
    var gap = false
}

/// Lyric rules (RightPanel.jsx:264-330; UI.md 3.4).
enum NowPlayingLyrics {
    static let gapSeconds = 5.0
    /// Lyrics appear slightly early (`LEAD_SECONDS`).
    static let lead = 0.25

    /// Server lines (`start` in ms, API.md §10) to seconds.
    static func lines(_ l: Lyrics) -> [NowPlayingLyricLine] {
        l.lines.map { NowPlayingLyricLine(text: $0.text, start: $0.start.map { Double($0) / 1000 }) }
    }

    /// `phoneLines`: blanks dropped; synced gaps longer than `max(5, 2.5 x median spacing)` get a "♪".
    static func phoneLines(_ lines: [NowPlayingLyricLine]) -> [NowPlayingLyricLine] {
        let kept = lines.filter { !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        guard kept.contains(where: { $0.start != nil }) else { return kept }
        var spacings: [Double] = []
        for i in kept.indices.dropFirst() {
            if let a = kept[i - 1].start, let b = kept[i].start, b - a > 0 { spacings.append(b - a) }
        }
        spacings.sort()
        let median = spacings.isEmpty ? gapSeconds : spacings[spacings.count / 2]
        let threshold = max(gapSeconds, 2.5 * median)
        var out: [NowPlayingLyricLine] = []
        if let first = kept.first?.start, first > threshold { out.append(NowPlayingLyricLine(text: "♪", start: 0, gap: true)) }
        for (i, l) in kept.enumerated() {
            out.append(l)
            if i + 1 < kept.count, let a = l.start, let b = kept[i + 1].start, b - a > threshold {
                out.append(NowPlayingLyricLine(text: "♪", start: a + min(5, (b - a) / 2), gap: true))
            }
        }
        return out
    }

    /// Top edge fade only when scrolled down (> 1 pt) or past the first line (owner rule, web too).
    static func showsTopFade(scrollOffset: CGFloat, activeIndex: Int) -> Bool { scrollOffset > 1 || activeIndex > 0 }

    static func isSynced(_ lines: [NowPlayingLyricLine]) -> Bool { lines.contains { $0.start != nil } }

    /// The time used to pick the line: `playhead - speakerDelay + 0.25`.
    static func lookupTime(playhead: Double, speakerDelay: Double) -> Double { playhead - speakerDelay + lead }

    /// The last line with `start <= at`; -1 before the first.
    static func activeIndex(_ lines: [NowPlayingLyricLine], at: Double) -> Int {
        var idx = -1
        for (i, l) in lines.enumerated() { if let s = l.start, at >= s { idx = i } }
        return idx
    }

    /// Retry delays after a failed fetch: 2, 4, 8 s, then "none".
    static func retryDelay(attempt: Int) -> Double? { attempt < 3 ? 2 * pow(2, Double(attempt)) : nil }
}
