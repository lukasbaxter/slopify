import XCTest
import UIKit
@testable import Slopify

final class SwipeToQueueTests: XCTestCase {
    func testThresholdIs80OrAQuarterOfTheWidth() {
        XCTAssertEqual(SwipeToQueue.threshold(width: 390), 80)
        XCTAssertEqual(SwipeToQueue.threshold(width: 320), 80)
        XCTAssertEqual(SwipeToQueue.threshold(width: 200), 50)
        XCTAssertEqual(SwipeToQueue.threshold(width: 0), 80, "not measured yet")
    }

    func testOffsetFollowsThenRubberBands() {
        let t: CGFloat = 80
        XCTAssertEqual(SwipeToQueue.displayOffset(-30, threshold: t), 0, "never moves left")
        XCTAssertEqual(SwipeToQueue.displayOffset(40, threshold: t), 40)
        XCTAssertEqual(SwipeToQueue.displayOffset(80, threshold: t), 80)
        let a = SwipeToQueue.displayOffset(120, threshold: t), b = SwipeToQueue.displayOffset(300, threshold: t)
        XCTAssertGreaterThan(a, 80); XCTAssertLessThan(a, 120)
        XCTAssertGreaterThan(b, a)
        XCTAssertLessThan(SwipeToQueue.displayOffset(5000, threshold: t), 2 * t)
    }

    func testProgressAndArming() {
        XCTAssertEqual(SwipeToQueue.progress(40, threshold: 80), 0.5)
        XCTAssertEqual(SwipeToQueue.progress(200, threshold: 80), 1)
        XCTAssertEqual(SwipeToQueue.progress(-10, threshold: 80), 0)
        XCTAssertFalse(SwipeToQueue.isArmed(79, threshold: 80))
        XCTAssertTrue(SwipeToQueue.isArmed(80, threshold: 80))
    }

    func testOnlyRightwardHorizontalBegins() {
        func begin(_ t: CGPoint, v: CGPoint = .zero, x: CGFloat = 100, held: TimeInterval = 0.1, ok: Bool = true) -> Bool {
            SwipeToQueue.shouldBegin(startX: x, translation: t, velocity: v, heldFor: held, queueable: ok)
        }
        XCTAssertTrue(begin(CGPoint(x: 10, y: 2)))
        XCTAssertFalse(begin(CGPoint(x: -10, y: 0)), "leftward")
        XCTAssertFalse(begin(CGPoint(x: 3, y: 10)), "vertical")
        XCTAssertFalse(begin(CGPoint(x: 6, y: 6)), "45 degrees is not horizontal enough")
        XCTAssertTrue(begin(.zero, v: CGPoint(x: 400, y: 50)), "velocity when nothing moved yet")
        XCTAssertFalse(begin(CGPoint(x: 10, y: 0), x: 12), "edge swipe zone")
        XCTAssertTrue(begin(CGPoint(x: 10, y: 0), x: 20))
        XCTAssertFalse(begin(CGPoint(x: 10, y: 0), held: 0.5), "after the 450 ms menu press")
        XCTAssertFalse(begin(CGPoint(x: 10, y: 0), ok: false), "not queueable")
    }

    func testEarlyFailOnVerticalOrLeftwardMovement() {
        XCTAssertFalse(SwipeToQueue.shouldFailEarly(CGPoint(x: 2, y: 3)), "still deciding")
        XCTAssertTrue(SwipeToQueue.shouldFailEarly(CGPoint(x: 2, y: 7)))
        XCTAssertTrue(SwipeToQueue.shouldFailEarly(CGPoint(x: 1, y: -9)))
        XCTAssertTrue(SwipeToQueue.shouldFailEarly(CGPoint(x: -7, y: 0)))
        XCTAssertFalse(SwipeToQueue.shouldFailEarly(CGPoint(x: 12, y: 7)), "mostly horizontal")
    }

    func testOfflineOnlyDownloadedSongsQueue() {
        XCTAssertTrue(SwipeToQueue.canQueue(offline: false, downloaded: false))
        XCTAssertTrue(SwipeToQueue.canQueue(offline: true, downloaded: true))
        XCTAssertFalse(SwipeToQueue.canQueue(offline: true, downloaded: false))
    }

    func testOfflineRuleMatchesTheMenu() {
        let t = Track.preview()
        for downloaded in [false, true] {
            let items = TrackMenu.items(.init(track: t, liked: false, excluded: false, downloaded: downloaded, offline: true), .init())
            XCTAssertEqual(items.contains { $0.label == L("Add to queue") }, SwipeToQueue.canQueue(offline: true, downloaded: downloaded))
        }
    }
}

final class SwipeBackTests: XCTestCase {
    private func input(_ f: (inout SwipeBack.Input) -> Void = { _ in }) -> SwipeBack.Input {
        var i = SwipeBack.Input(isActiveTab: true, stackCount: 2, start: CGPoint(x: 150, y: 200),
                                direction: CGPoint(x: 10, y: 1), claimed: false)
        f(&i)
        return i
    }

    func testGoesBackOnAPushedPage() {
        XCTAssertEqual(SwipeBack.action(input()), .back)
        XCTAssertEqual(SwipeBack.action(input { $0.stackCount = 4 }), .back)
    }

    /// Owner 11-12: from anywhere, on every tab (was: Library only, top half, scrolled to the top).
    func testAnywhereOnAnyPage() {
        XCTAssertEqual(SwipeBack.action(input { $0.start.y = 700 }), .back, "bottom half")
        XCTAssertEqual(SwipeBack.action(input { $0.direction = CGPoint(x: 12, y: 11) }), .back, "nearly diagonal")
    }

    func testRootOpensTheDrawer() {
        XCTAssertEqual(SwipeBack.action(input { $0.stackCount = 1 }), .drawer)
        XCTAssertEqual(SwipeBack.action(input { $0.stackCount = 1; $0.start.x = 4 }), .drawer, "from the edge too")
    }

    func testEachGate() {
        XCTAssertNil(SwipeBack.action(input { $0.isActiveTab = false }), "a hidden tab")
        XCTAssertNil(SwipeBack.action(input { $0.covered = true }), "now playing / drawer over the page")
        XCTAssertNil(SwipeBack.action(input { $0.start.x = 10 }), "edge: the system swipe")
        XCTAssertNil(SwipeBack.action(input { $0.direction = CGPoint(x: -10, y: 0) }), "leftward")
        XCTAssertNil(SwipeBack.action(input { $0.direction = CGPoint(x: 2, y: 10) }), "vertical")
        XCTAssertNil(SwipeBack.action(input { $0.claimed = true }), "rows queue, charts scrub")
        XCTAssertNil(SwipeBack.action(input { $0.inScrolledShelf = true }), "a scrolled shelf scrolls")
        XCTAssertNil(SwipeBack.action(input { $0.stackCount = 1; $0.claimed = true }))
        XCTAssertNil(SwipeBack.action(input { $0.heldFor = 0.5 }), "press-and-drag (library reorder)")
    }

    func testBackstop() {
        XCTAssertTrue(SwipeBack.backstopPops(dx: 81, vx: 0))
        XCTAssertFalse(SwipeBack.backstopPops(dx: 79, vx: 0))
        XCTAssertTrue(SwipeBack.backstopPops(dx: 40, vx: 900), "flick")
        XCTAssertFalse(SwipeBack.backstopPops(dx: 20, vx: 900), "a twitch")
    }

    @MainActor func testPopHandlerIsFound() throws {
        let nav = UINavigationController(rootViewController: UIViewController())
        let pop = try XCTUnwrap(nav.interactivePopGestureRecognizer)
        let (target, action) = try XCTUnwrap(SwipeBack.popHandler(of: pop))
        XCTAssertTrue(target.responds(to: action))
    }
}

final class SwipeDismissTests: XCTestCase {
    func testDirection() {
        XCTAssertTrue(SwipeDismiss.isDismissward(CGPoint(x: 30, y: 40), .down), "diagonal down")
        XCTAssertFalse(SwipeDismiss.isDismissward(CGPoint(x: 50, y: 40), .down), "more sideways than down")
        XCTAssertFalse(SwipeDismiss.isDismissward(CGPoint(x: 0, y: -10), .down), "up")
        XCTAssertTrue(SwipeDismiss.isDismissward(CGPoint(x: -40, y: 25), .left))
        XCTAssertFalse(SwipeDismiss.isDismissward(CGPoint(x: 40, y: 0), .left))
    }

    func testBeginsOnlyWithTheScrollAtItsTop() {
        XCTAssertTrue(SwipeDismiss.shouldBegin(translation: CGPoint(x: 3, y: 12), velocity: .zero, direction: .down, scrollAtTop: true))
        XCTAssertFalse(SwipeDismiss.shouldBegin(translation: CGPoint(x: 3, y: 12), velocity: .zero, direction: .down, scrollAtTop: false))
        XCTAssertTrue(SwipeDismiss.shouldBegin(translation: .zero, velocity: CGPoint(x: 0, y: 900), direction: .down, scrollAtTop: true), "velocity before any movement")
        XCTAssertTrue(SwipeDismiss.isAtTop(offsetY: -59, insetTop: 59))
        XCTAssertTrue(SwipeDismiss.isAtTop(offsetY: -80, insetTop: 59), "pulled down past the top")
        XCTAssertFalse(SwipeDismiss.isAtTop(offsetY: 2, insetTop: 0))
    }

    func testFollowsAndRubberBands() {
        XCTAssertEqual(SwipeDismiss.displayOffset(80, rubberBand: true), 80)
        let up = SwipeDismiss.displayOffset(-200, rubberBand: true)
        XCTAssertLessThan(up, 0)
        XCTAssertGreaterThan(up, -SwipeDismiss.rubberMax)
        XCTAssertEqual(SwipeDismiss.displayOffset(-200, rubberBand: false), 0)
    }

    /// Distance or a flick, however long the drag took (was: a 300 ms window).
    func testDismissRule() {
        XCTAssertTrue(SwipeDismiss.shouldDismiss(along: 101, velocity: 0, distance: 100))
        XCTAssertFalse(SwipeDismiss.shouldDismiss(along: 99, velocity: 0, distance: 100))
        XCTAssertTrue(SwipeDismiss.shouldDismiss(along: 30, velocity: 900, distance: 100), "short fast flick")
        XCTAssertFalse(SwipeDismiss.shouldDismiss(along: 10, velocity: 900, distance: 100), "a twitch")
        XCTAssertFalse(SwipeDismiss.shouldDismiss(along: 160, velocity: -900, distance: 100), "flung back up")
    }
}
