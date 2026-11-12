import XCTest
import SwiftUI
@testable import Slopify

/// Regression: a long title widened the whole now playing page (owner bug, Valley
/// "There's Still a Light in the House"). Each line must fit the width it is offered.
@MainActor
final class NowPlayingLayoutTests: XCTestCase {
    private let long = "There's Still a Light in the House (Extended Version) - Valley, Somebody Else, Another Artist"

    private func width<V: View>(_ v: V, proposed: CGFloat) -> CGFloat {
        let host = UIHostingController(rootView: v)
        return host.sizeThatFits(in: CGSize(width: proposed, height: 200)).width
    }

    func testMarqueeNeverWiderThanOffered() {
        // Fails without `minWidth: 0` on Marquee's frames: it reported its full text width.
        XCTAssertLessThanOrEqual(width(Marquee(long).font(.system(size: 24, weight: .bold)), proposed: 300), 300.5)
    }

    func testMetaRowFits() {
        let row = HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 0) {
                Marquee(long).font(.system(size: 24, weight: .bold))
                Text(long).lineLimit(1)
            }
            .frame(minWidth: 0, maxWidth: .infinity, alignment: .leading)
            Color.clear.frame(width: 44, height: 44)
        }
        XCTAssertLessThanOrEqual(width(row, proposed: 345), 345.5)
    }

    func testDeviceButtonFits() {
        let b = NowPlayingDeviceButton(casting: true, label: long, showName: true) {}
            .frame(minWidth: 0, maxWidth: .infinity, alignment: .leading)
        XCTAssertLessThanOrEqual(width(b, proposed: 250), 250.5)
    }

    func testSwipeDismissRegions() {
        // Album tab: anywhere.
        XCTAssertTrue(NowPlayingMath.swipeDismissAllowed(lyricsShowing: false, startY: 600, headerBottom: 115))
        // Lyrics tab: only from the header (chevron, title, artist), never from the lines.
        XCTAssertTrue(NowPlayingMath.swipeDismissAllowed(lyricsShowing: true, startY: 80, headerBottom: 115))
        XCTAssertTrue(NowPlayingMath.swipeDismissAllowed(lyricsShowing: true, startY: 115, headerBottom: 115))
        XCTAssertFalse(NowPlayingMath.swipeDismissAllowed(lyricsShowing: true, startY: 116, headerBottom: 115))
        XCTAssertFalse(NowPlayingMath.swipeDismissAllowed(lyricsShowing: true, startY: 500, headerBottom: 115))
    }

    /// The queue (and every sheet) uses the shared rule: header always (no scroll view under
    /// it), the list only at its top; pull-down bounce counts as the top.
    func testQueueSwipeStartRule() {
        let down = CGPoint(x: 2, y: 12)
        XCTAssertTrue(SwipeDismiss.shouldBegin(translation: down, velocity: .zero, direction: .down, scrollAtTop: true))
        XCTAssertFalse(SwipeDismiss.shouldBegin(translation: down, velocity: .zero, direction: .down, scrollAtTop: false))
        XCTAssertTrue(SwipeDismiss.isAtTop(offsetY: 1, insetTop: 0))
        XCTAssertFalse(SwipeDismiss.isAtTop(offsetY: 1.5, insetTop: 0))
        XCTAssertTrue(SwipeDismiss.isAtTop(offsetY: -20, insetTop: 0))
    }

    func testLyricsBackdropValues() {
        // Brighter than the web's brightness(.32) saturate(1.3), on purpose.
        XCTAssertEqual(NowPlayingMath.lyricsBackdropBrightness, 0.42)
        XCTAssertEqual(NowPlayingMath.lyricsBackdropSaturation, 1.4)
    }

    func testLightCoverGetsScrimSoWhiteTextStaysReadable() {
        let white = RGB(hex: 0xffffff), pale = RGB(hex: 0xf2e6c8)
        for cover in [white, pale] {
            let a = NowPlayingMath.lyricsScrimOpacity(average: cover)
            XCTAssertGreaterThan(a, 0)
            let k = NowPlayingMath.lyricsBackdropBrightness * (1 - a)
            let bg = RGB(cover.r * k, cover.g * k, cover.b * k)
            XCTAssertGreaterThanOrEqual(white.contrast(bg), 7)
            // The 50 % upcoming lines still read against it.
            XCTAssertGreaterThanOrEqual(white.opacity(0.5).flattened(on: bg).contrast(bg), 2.4)
        }
        // Without the scrim a white cover at 0.55 would be too bright for white text.
        let raw = RGB(255 * 0.55, 255 * 0.55, 255 * 0.55)
        XCTAssertLessThan(white.contrast(raw), 4.5)
    }

    func testDarkCoverNoScrim() {
        XCTAssertEqual(NowPlayingMath.lyricsScrimOpacity(average: RGB(hex: 0x2a1a40)), 0)
        XCTAssertEqual(NowPlayingMath.lyricsScrimOpacity(average: RGB(hex: 0x000000)), 0)
    }

    func testAverageColor() {
        XCTAssertNil(NowPlayingMath.averageColor([]))
        let px: [UInt8] = [255, 0, 0, 255, 0, 0, 255, 255, 0, 0, 0, 0]
        let avg = NowPlayingMath.averageColor(px)
        XCTAssertEqual(avg?.r, 127.5); XCTAssertEqual(avg?.b, 127.5); XCTAssertEqual(avg?.g, 0)
    }
}

private extension RGB {
    /// Composite this (with its alpha) over an opaque background.
    func flattened(on bg: RGB) -> RGB {
        RGB(r * alpha + bg.r * (1 - alpha), g * alpha + bg.g * (1 - alpha), b * alpha + bg.b * (1 - alpha))
    }
}
