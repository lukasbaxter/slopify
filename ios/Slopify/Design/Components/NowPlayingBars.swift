import SwiftUI

/// Spotify's animated "now playing" mark (TrackRow.jsx:113-116, app.css:827-832): 14x14, three
/// 3 pt bars 2 pt apart, bottom-aligned, accent, heights 40/90/60 %, each scaling .4 -> 1 -> .4
/// over 0.9 s ease-in-out, delays 0 / .25 / .5 s. Static (no animation) when `animating` is false.
struct NowPlayingBars: View {
    var animating = true
    @Environment(\.theme) private var theme

    var body: some View {
        TimelineView(.animation(paused: !animating)) { ctx in
            let t = ctx.date.timeIntervalSinceReferenceDate
            HStack(alignment: .bottom, spacing: 2) {
                bar(0.4, t, delay: 0)
                bar(0.9, t, delay: 0.25)
                bar(0.6, t, delay: 0.5)
            }
            .frame(width: 14, height: 14, alignment: .bottomLeading)
        }
        .accessibilityLabel(L("Now playing"))
    }

    private func bar(_ base: CGFloat, _ t: TimeInterval, delay: Double) -> some View {
        // keyframes 0%,100% scaleY(.4), 50% scaleY(1), ease-in-out per half
        var p = ((t - delay) / 0.9).truncatingRemainder(dividingBy: 1)
        if p < 0 { p += 1 }
        let half = p < 0.5 ? p * 2 : (1 - p) * 2
        let eased = half * half * (3 - 2 * half)
        let s = animating ? 0.4 + 0.6 * eased : 1
        return Rectangle().fill(theme.accent)
            .frame(width: 3, height: 14 * base)
            .scaleEffect(x: 1, y: s, anchor: .bottom)
    }
}

#Preview { NowPlayingBars().padding().background(Theme.default.page) }
