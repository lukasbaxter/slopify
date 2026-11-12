import SwiftUI

/// Static (unthemed) tokens, app.css:40-45, plus the phone shell metrics every screen shares.
enum Radius {
    /// `--r-panel`
    static let panel: CGFloat = 8
    /// `--r-art` (hero cover, sheet header image, skeleton art)
    static let art: CGFloat = 4
    /// `--r-row` (mini player card, skeleton bars)
    static let row: CGFloat = 6
    /// Track-row artwork.
    static let rowArt: CGFloat = 3
    /// Home / see-all / other-page cards (mobile-home-search.css:98).
    static let card: CGFloat = 2
    /// Bottom sheet top corners.
    static let sheet: CGFloat = 16
    /// Dialog card, toast, error banner.
    static let dialog: CGFloat = 8
}

enum Spacing {
    /// `--gap`
    static let gap: CGFloat = 8
    /// Page side gutter.
    static let gutter: CGFloat = 16
    /// Gap between cards in a shelf.
    static let shelfGap: CGFloat = 16
}

/// Phone shell metrics (UI.md 2.3, 2.6).
enum Shell {
    /// Tab bar height above the bottom safe area.
    static let tabBar: CGFloat = 49
    /// Mini player card height, and its margin above the tab bar.
    static let miniPlayer: CGFloat = 56
    static let miniPlayerGap: CGFloat = 8
    /// Fade zone above the mini player card.
    static let miniPlayerFade: CGFloat = 24
    /// Root-page header row (avatar + title), above the top inset.
    static let header: CGFloat = 48
    /// Detail top bar row, above the top inset.
    static let topBar: CGFloat = 56
    /// Bottom padding of every scroll view, above the bottom inset: 24 + 56 + 8 + 49.
    static let contentBottom: CGFloat = 137
    /// Fixed track-row height in long lists (VirtualList, UI.md 5.3); 84 with a lyric snippet.
    static let trackRow: CGFloat = 64
    static let trackRowWithSnippet: CGFloat = 84
}

/// Timing curves (UI.md 2.1, 3.8, 5.5).
enum Motion {
    /// `--ease: cubic-bezier(.3, 0, 0, 1)`.
    static func ease(_ duration: Double) -> Animation { .timingCurve(0.3, 0, 0, 1, duration: duration) }
    /// Phone sheets and pushes: `cubic-bezier(.2,.7,.2,1)`.
    static func sheet(_ duration: Double) -> Animation { .timingCurve(0.2, 0.7, 0.2, 1, duration: duration) }
    /// Sheet in (0.2 s), drawer in (0.25 s), now playing in (0.3 s).
    static let sheetIn = sheet(0.2)
    static let drawerIn = sheet(0.25)
    static let nowPlayingIn = sheet(0.3)
    /// The one dismiss used for every sheet: slide down 0.25 s ease-in (DECISIONS).
    static let sheetOut = Animation.easeIn(duration: 0.25)
    /// Spring back after a drag that did not dismiss or skip.
    static let snapBack = Animation.spring(response: 0.3, dampingFraction: 0.82)
    /// Image fade-in (Home FadeImg).
    static let imageFade = Animation.easeOut(duration: 0.15)
    /// Scrim fade.
    static let scrim = Animation.linear(duration: 0.2)
}

/// Gesture thresholds (UI.md 2.8).
enum Gestures {
    static let longPressDuration: Double = 0.45
    static let longPressSlop: CGFloat = 10
    /// Swipe down to close (`SwipeDismiss`): past this distance, or a flick.
    static let sheetDismissDistance: CGFloat = 100
    static let nowPlayingDismissDistance: CGFloat = 140
    /// Swipe to skip (mini player, now playing art): past this, or a flick.
    static let skipDistance: CGFloat = 60
    /// A flick, pt/s.
    static let flickVelocity: CGFloat = 500
}
