import Foundation
import CoreGraphics

/// Pure rules behind the player screens (UI.md 3.1-3.3), kept apart so they are testable.
enum NowPlayingMath {
    /// `fmt` (FullScreen.jsx:18): `m:ss`, minutes unbounded, bad input = 0:00.
    static func time(_ seconds: Double) -> String {
        guard seconds.isFinite, seconds >= 0 else { return "0:00" }
        let m = Int(seconds / 60)
        let s = Int(seconds.truncatingRemainder(dividingBy: 60))
        return "\(m):" + (s < 10 ? "0\(s)" : "\(s)")
    }

    /// The right-hand label: `-(duration - shown)` clamped at 0.
    static func remaining(_ shown: Double, duration: Double) -> String {
        "-" + time(max(0, duration - shown))
    }

    /// Played fraction 0...1 (`pct = position / duration`).
    static func fraction(_ position: Double, duration: Double) -> Double {
        guard duration > 0, position.isFinite else { return 0 }
        return min(1, max(0, position / duration))
    }

    /// Seek bar: the finger x drives the value, `clamp((x - left) / width * duration, 0, duration)`.
    /// The range is `0...max(1, duration)`.
    static func scrubValue(x: CGFloat, width: CGFloat, duration: Double) -> Double {
        let d = max(1, duration)
        guard width > 0 else { return 0 }
        return min(d, max(0, Double(x / width) * d))
    }

    /// How long the scrubbed value is held after release so the thumb does not snap back.
    static func scrubHold(mirroring: Bool) -> Double { mirroring ? 1.5 : 0.25 }

    // MARK: Swipe to skip (mini player, now playing art) and swipe up (mini player)

    enum Skip: Equatable { case next, previous }

    /// Left = next, right = previous: past 60 pt and more sideways than up/down, or a sideways
    /// flick past 24 pt. No time limit, so an unhurried swipe skips too (owner 11-12).
    static func skip(dx: CGFloat, dy: CGFloat, velocityX: CGFloat) -> Skip? {
        guard abs(dx) > abs(dy) else { return nil }
        let far = abs(dx) > Gestures.skipDistance
        let flick = abs(dx) > 24 && abs(velocityX) > Gestures.flickVelocity && (velocityX < 0) == (dx < 0)
        guard far || flick else { return nil }
        return dx < 0 ? .next : .previous
    }

    /// Mini player swipe up opens now playing: up past 40 pt and more up than sideways, or an
    /// upward flick past 16 pt.
    static func opensNowPlaying(dx: CGFloat, dy: CGFloat, velocityY: CGFloat) -> Bool {
        guard dy < 0, abs(dy) > abs(dx) else { return false }
        return -dy > 40 || (-dy > 16 && velocityY < -Gestures.flickVelocity)
    }

    /// The row follows the finger once `|dx| > 6`: offset clamp(dx, -80, 80), opacity `1 - min(80,|dx|)/200`.
    static func skipFollow(dx: CGFloat) -> (offset: CGFloat, opacity: Double) {
        guard abs(dx) > 6 else { return (0, 1) }
        return (min(80, max(-80, dx)), 1 - Double(min(80, abs(dx))) / 200)
    }

    /// The first 6 pt of movement pick the axis: sideways skips, up/down does not.
    static func abandonsSwipe(dx: CGFloat, dy: CGFloat) -> Bool { abs(dx) <= 6 && abs(dy) > abs(dx) }

    // MARK: Now playing swipe down

    /// Swipe down closes from anywhere on the Album tab. On the Lyrics tab only a swipe that starts
    /// on the header (chevron, title, artist) closes it; one on the lyric lines never does
    /// (owner's rule, overrides UI.md 3.2.5). `startY` and `headerBottom` in the same space.
    static func swipeDismissAllowed(lyricsShowing: Bool, startY: CGFloat, headerBottom: CGFloat) -> Bool {
        !lyricsShowing || startY <= headerBottom
    }

    // MARK: Lyrics backdrop
    // The web uses blur(60px) brightness(.32) saturate(1.3) (mobile-nowplaying.css:83). Native is
    // brighter on purpose so more of the cover shows; a scrim then caps light covers.

    static let lyricsBackdropBrightness = 0.42
    static let lyricsBackdropSaturation = 1.4
    /// Highest backdrop luminance allowed. White text then has >= 7:1 contrast and the 50 %
    /// upcoming lines stay as readable as on the web's darkest-allowed backdrop.
    static let lyricsBackdropMaxLuminance = 0.09

    /// Black scrim opacity over the backdrop so a cover with this average colour, after the
    /// brightness multiply, stays at or under `lyricsBackdropMaxLuminance`. 0 for dark covers.
    static func lyricsScrimOpacity(average: RGB) -> Double {
        func lum(_ a: Double) -> Double {
            let k = lyricsBackdropBrightness * (1 - a)
            return RGB(average.r * k, average.g * k, average.b * k).luminance
        }
        guard lum(0) > lyricsBackdropMaxLuminance else { return 0 }
        var lo = 0.0, hi = 1.0
        for _ in 0..<30 { let m = (lo + hi) / 2; if lum(m) > lyricsBackdropMaxLuminance { lo = m } else { hi = m } }
        return hi
    }

    /// Mean colour of RGBA bytes (alpha-weighted, so transparent pixels count as nothing).
    static func averageColor(_ px: [UInt8]) -> RGB? {
        var r = 0.0, g = 0.0, b = 0.0, n = 0.0
        var i = 0
        while i + 3 < px.count {
            let a = Double(px[i + 3]) / 255
            if a > 0 { r += Double(px[i]) / a; g += Double(px[i + 1]) / a; b += Double(px[i + 2]) / a; n += 1 }
            i += 4
        }
        guard n > 0 else { return nil }
        return RGB(min(255, r / n), min(255, g / n), min(255, b / n))
    }

    // MARK: Queue reorder (RightPanel.jsx:170-207)

    /// Target slot `pos + round(dy / rowHeight)`, clamped to the upcoming rows `[current+1, count-1]`.
    static func reorderTarget(from pos: Int, dy: CGFloat, rowHeight: CGFloat, current: Int, count: Int) -> Int {
        let h = rowHeight > 0 ? rowHeight : 64
        let raw = pos + Int((dy / h).rounded())
        let lo = current + 1, hi = count - 1
        guard hi >= lo else { return pos }
        return min(hi, max(lo, raw))
    }

    /// Shift of row `i` while row `from` is dragged to `to`: rows in between move by one row.
    static func reorderShift(row i: Int, from: Int, to: Int, rowHeight: CGFloat) -> CGFloat {
        if to > from, i > from, i <= to { return -rowHeight }
        if to < from, i >= to, i < from { return rowHeight }
        return 0
    }

    // MARK: Sleep timer label (FullScreen.jsx:44-60)

    /// `at` and `now` in ms.
    static func sleepLabel(at: Double?, endOfTrack: Bool, now: Double) -> String {
        if endOfTrack { return L("Sleep timer: end of track") }
        guard let at else { return L("Sleep timer") }
        let left = max(1, Int(((at - now) / 60000).rounded(.up)))
        if left < 60 { return L("Sleep timer: {m} min left", ["m": left]) }
        let h = left / 60, m = left % 60
        return m == 0 ? L("Sleep timer: {h} h left", ["h": h]) : L("Sleep timer: {h} h {m} min left", ["h": h, "m": m])
    }
    // MARK: Speaker volume (DevicePicker.jsx:64-108)

    /// `round(clamp01((x - left) / width) * 100)`.
    static func volumeValue(x: CGFloat, width: CGFloat) -> Double {
        guard width > 0 else { return 0 }
        return (min(1, max(0, Double(x / width))) * 100).rounded()
    }

    /// One send per `interval`, keeping the latest value for a trailing send (`useThrottledVolume`).
    struct Throttle: Equatable {
        enum Decision: Equatable { case send(Double), wait(Double) }
        var interval: Double
        var lastSent: Double = -.infinity
        var pending: Double?

        /// `now` in seconds. `.wait(d)`: arm one timer for `d` s, then call `flush`.
        mutating func offer(_ v: Double, now: Double) -> Decision {
            if now - lastSent >= interval { lastSent = now; pending = nil; return .send(v) }
            pending = v
            return .wait(interval - (now - lastSent))
        }

        /// The pending value, if any (timer fired or release).
        mutating func flush(now: Double) -> Double? {
            guard let p = pending else { return nil }
            pending = nil; lastSent = now
            return p
        }
    }
}
