import XCTest

/// The home screen widget: Slopify is in the widget gallery, the widget shows the song that is
/// playing, its button pauses without opening the app, and a tap opens Now Playing.
final class WidgetTests: GestureTestCase {
    private let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")

    private func shot(_ name: String) {
        let a = XCTAttachment(screenshot: XCUIScreen.main.screenshot()); a.name = name; a.lifetime = .keepAlways; add(a)
    }

    func testWidgetShowsTheSongPausesItAndOpensNowPlaying() throws {
        startPlayback()
        XCUIDevice.shared.press(.home)
        sleep(1)

        // Small, medium, and the song radio one.
        for page in 0..<3 { addWidget(page: page) }
        sleep(2)
        shot("home-playing")

        // The widget shows a song (its Pause button), and the button works from here.
        // (Which song is not checked: the fixture's songs are five seconds long.)
        let pause = springboard.buttons["Pause"].firstMatch
        XCTAssertTrue(pause.waitForExistence(timeout: 10), "the widget shows no song with a Pause button")
        pause.tap()
        let play = springboard.buttons["Play"].firstMatch
        XCTAssertTrue(play.waitForExistence(timeout: 10), "the widget did not turn to paused")
        XCTAssertEqual(app.state, .runningBackground, "pausing from the widget brought the app forward")
        shot("home-paused")

        // A tap on the widget opens the app on Now Playing.
        play.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).withOffset(CGVector(dx: -150, dy: 0)).tap()
        XCTAssertTrue(app.buttons["Queue"].firstMatch.waitForExistence(timeout: 10), "the widget did not open Now Playing")
        XCTAssertTrue(app.buttons["Play"].firstMatch.exists, "the app is not paused after the widget's Pause")
    }

    /// Adds the Slopify widget on `page` of its gallery sheet (0 = small) to the home screen.
    private func addWidget(page: Int) {
        springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.93)).press(forDuration: 1.6)
        let edit = springboard.buttons["Edit"].firstMatch
        XCTAssertTrue(edit.waitForExistence(timeout: 8), "home screen did not enter edit mode")
        edit.tap()
        let add = springboard.buttons["Add Widget"].firstMatch
        XCTAssertTrue(add.waitForExistence(timeout: 5), "no Add Widget in the Edit menu")
        add.tap()
        let search = springboard.searchFields.firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 8), "widget gallery did not open")
        search.tap()
        search.typeText("Slopify")
        let entry = springboard.cells.containing(NSPredicate(format: "label CONTAINS 'Slopify'")).firstMatch
        let hit = entry.waitForExistence(timeout: 8) ? entry : springboard.staticTexts["Slopify"].firstMatch
        XCTAssertTrue(hit.waitForExistence(timeout: 5), "Slopify is not in the widget gallery")
        hit.tap()
        let addButton = springboard.buttons.matching(NSPredicate(format: "label CONTAINS 'Add Widget'")).firstMatch
        XCTAssertTrue(addButton.waitForExistence(timeout: 8), "no Add Widget button for Slopify")
        for _ in 0..<page {
            springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.55))
                .press(forDuration: 0.05, thenDragTo: springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.55)))
            sleep(1)
        }
        shot("picker-\(page)")
        addButton.tap()
        sleep(1)
        let done = springboard.buttons["Done"].firstMatch
        if done.waitForExistence(timeout: 5) { done.tap() }
        sleep(1)
    }
}
