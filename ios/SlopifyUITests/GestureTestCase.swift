import XCTest

/// Base for the gesture UI tests. They drive the real app against a fixture server whose
/// address comes from `SLOPIFY_UITEST_SERVER` (`make uitest` starts one); without it they skip.
/// Swipes are deliberately sloppy: diagonal, mid-screen, short and fast, like a thumb.
class GestureTestCase: XCTestCase {
    var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        guard let server = ProcessInfo.processInfo.environment["SLOPIFY_UITEST_SERVER"], !server.isEmpty else {
            throw XCTSkip("SLOPIFY_UITEST_SERVER not set (run `make uitest`)")
        }
        app = XCUIApplication()
        app.launch()
        try signInIfNeeded(server)
    }

    private func signInIfNeeded(_ server: String) throws {
        let tab = app.buttons["Your Library"]
        if tab.waitForExistence(timeout: 6) { return }
        let field = app.textFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 10), "no server address field")
        field.tap()
        field.typeText(server + "\n")
        XCTAssertTrue(tab.waitForExistence(timeout: 30), "demo sign-in did not reach the shell")
    }

    // MARK: Points

    /// A point in the app window, as fractions of its size.
    func point(_ x: CGFloat, _ y: CGFloat) -> XCUICoordinate {
        app.coordinate(withNormalizedOffset: CGVector(dx: x, dy: y))
    }

    func point(on e: XCUIElement, _ x: CGFloat = 0.5, _ y: CGFloat = 0.5) -> XCUICoordinate {
        e.coordinate(withNormalizedOffset: CGVector(dx: x, dy: y))
    }

    /// A finger drag from `a` to `b` at `velocity` pt/s (XCUI default is slow and precise; a thumb is not).
    func drag(_ a: XCUICoordinate, _ b: XCUICoordinate, velocity: XCUIGestureVelocity = .fast, hold: TimeInterval = 0.05) {
        a.press(forDuration: hold, thenDragTo: b, withVelocity: velocity, thenHoldForDuration: 0)
    }

    /// Offset a coordinate by points.
    func moved(_ c: XCUICoordinate, _ dx: CGFloat, _ dy: CGFloat) -> XCUICoordinate {
        c.withOffset(CGVector(dx: dx, dy: dy))
    }

    // MARK: Navigation helpers

    func openLibrary() {
        app.buttons["Your Library"].tap()
    }

    /// Opens the fixture playlist from Your Library and waits for its page.
    func openPlaylist(_ name: String = "Gesture Mix") {
        openLibrary()
        let row = app.staticTexts[name].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 15), "playlist \(name) not in the library")
        row.tap()
        XCTAssertTrue(backButton.waitForExistence(timeout: 10), "playlist page did not open")
    }

    /// Pushed pages: "Go back" (detail pages) or "Back" (Settings).
    var backButton: XCUIElement { app.buttons.matching(NSPredicate(format: "label == 'Go back' OR label == 'Back'")).firstMatch }

    /// Track rows ("Title, Artist, More options").
    var trackRows: XCUIElementQuery { app.buttons.matching(NSPredicate(format: "label CONTAINS ', More options'")) }

    /// Opens the fixture playlist and plays its first song.
    func startPlayback() {
        openPlaylist()
        let row = trackRows.element(boundBy: 0)
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        row.tap()
        XCTAssertTrue(app.buttons["Pause"].firstMatch.waitForExistence(timeout: 15), "playback did not start")
    }

    /// Taps the mini player open.
    func openNowPlaying() {
        point(0.3, 0.84).tap()
        XCTAssertTrue(app.buttons["Queue"].firstMatch.waitForExistence(timeout: 5), "now playing did not open")
    }

    /// True once `e` is gone (or hidden from hit testing) within `timeout`.
    func waitGone(_ e: XCUIElement, timeout: TimeInterval = 4) -> Bool {
        let p = NSPredicate(format: "exists == false OR hittable == false")
        return XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: p, object: e)], timeout: timeout) == .completed
    }
}
