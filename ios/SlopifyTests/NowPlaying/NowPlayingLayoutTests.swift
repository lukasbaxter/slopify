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

    func testLyricsSwipeNeverDismisses() {
        XCTAssertFalse(NowPlayingMath.swipeDismissAllowed(lyricsShowing: true))
        XCTAssertTrue(NowPlayingMath.swipeDismissAllowed(lyricsShowing: false))
    }

    func testLyricsBackdropMatchesWebFilter() {
        // mobile-nowplaying.css:83 `brightness(.32) saturate(1.3)`; brightness is a multiply.
        XCTAssertEqual(NowPlayingMath.lyricsBackdropBrightness, 0.32)
        XCTAssertEqual(NowPlayingMath.lyricsBackdropSaturation, 1.3)
    }
}
