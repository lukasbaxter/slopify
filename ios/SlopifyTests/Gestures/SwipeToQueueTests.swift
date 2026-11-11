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

final class LibrarySwipeBackTests: XCTestCase {
    private let screen = CGSize(width: 390, height: 844)

    private func input(_ f: (inout LibrarySwipeBack.Input) -> Void = { _ in }) -> LibrarySwipeBack.Input {
        var i = LibrarySwipeBack.Input(isLibraryTab: true, stackCount: 2, start: CGPoint(x: 150, y: 200), screen: screen,
                                       direction: CGPoint(x: 10, y: 1), scrollAtTop: true, onTrackRow: false)
        f(&i)
        return i
    }

    func testBeginsOnALibraryPageTopHalfAtTop() {
        XCTAssertTrue(LibrarySwipeBack.shouldBegin(input()))
    }

    func testEachGate() {
        XCTAssertFalse(LibrarySwipeBack.shouldBegin(input { $0.isLibraryTab = false }), "Home / Search")
        XCTAssertFalse(LibrarySwipeBack.shouldBegin(input { $0.stackCount = 1 }), "Library root")
        XCTAssertTrue(LibrarySwipeBack.shouldBegin(input { $0.stackCount = 4 }))
        XCTAssertFalse(LibrarySwipeBack.shouldBegin(input { $0.start.y = 422 }), "bottom half")
        XCTAssertTrue(LibrarySwipeBack.shouldBegin(input { $0.start.y = 421 }))
        XCTAssertFalse(LibrarySwipeBack.shouldBegin(input { $0.start.x = 10 }), "edge: the system swipe")
        XCTAssertFalse(LibrarySwipeBack.shouldBegin(input { $0.direction = CGPoint(x: -10, y: 0) }), "leftward")
        XCTAssertFalse(LibrarySwipeBack.shouldBegin(input { $0.direction = CGPoint(x: 2, y: 10) }), "vertical")
        XCTAssertFalse(LibrarySwipeBack.shouldBegin(input { $0.scrollAtTop = false }), "scrolled down")
        XCTAssertFalse(LibrarySwipeBack.shouldBegin(input { $0.onTrackRow = true }), "rows queue instead")
        XCTAssertFalse(LibrarySwipeBack.shouldBegin(input { $0.inScrolledShelf = true }), "a scrolled shelf scrolls")
    }

    func testAtTop() {
        XCTAssertTrue(LibrarySwipeBack.isAtTop(offsetY: -59, insetTop: 59))
        XCTAssertTrue(LibrarySwipeBack.isAtTop(offsetY: -80, insetTop: 59), "pulled down past the top")
        XCTAssertTrue(LibrarySwipeBack.isAtTop(offsetY: 0.5, insetTop: 0), "epsilon")
        XCTAssertFalse(LibrarySwipeBack.isAtTop(offsetY: 2, insetTop: 0))
        XCTAssertFalse(LibrarySwipeBack.isAtTop(offsetY: -40, insetTop: 59))
    }

    @MainActor func testPopHandlerIsFound() throws {
        let nav = UINavigationController(rootViewController: UIViewController())
        let pop = try XCTUnwrap(nav.interactivePopGestureRecognizer)
        let (target, action) = try XCTUnwrap(LibrarySwipeBack.popHandler(of: pop))
        XCTAssertTrue(target.responds(to: action))
    }
}
