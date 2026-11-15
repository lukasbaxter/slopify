import XCTest

/// Your Library's "+" sheet offers the generated playlist, and it opens the Generate dialog.
final class CreateSheetTests: GestureTestCase {
    func testPlusSheetOpensTheGenerateDialog() {
        openLibrary()
        let plus = app.buttons["Create playlist"].firstMatch
        XCTAssertTrue(plus.waitForExistence(timeout: 10))
        plus.tap()
        let row = app.buttons["Generated playlist (AI)"].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 5), "the + sheet has no Generated playlist (AI) row")
        XCTAssertTrue(app.buttons["Playlist"].firstMatch.exists)
        XCTAssertTrue(app.buttons["Folder"].firstMatch.exists)
        row.tap()
        XCTAssertTrue(app.staticTexts["Generated playlist"].waitForExistence(timeout: 5), "the Generate dialog did not open")
        let cancel = app.buttons["Cancel"].firstMatch
        XCTAssertTrue(cancel.waitForExistence(timeout: 5))
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.lifetime = .keepAlways; add(shot)
        cancel.tap()
        XCTAssertTrue(waitGone(app.staticTexts["Generated playlist"]), "Cancel did not close the dialog")
    }
}
