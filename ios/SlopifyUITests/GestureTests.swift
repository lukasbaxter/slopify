import XCTest

/// One gesture language (owner 11-12): swipe right goes back, swipe down closes, the mini
/// player swipes up to open and sideways to skip, track rows swipe right to queue.
final class SwipeBackTests: GestureTestCase {
    /// Home -> album (opened from its tile), swipe right from mid-screen, a bit diagonal.
    func testHomePageSwipesBackFromMidScreen() {
        let tile = app.buttons["Analytical"].firstMatch
        XCTAssertTrue(tile.waitForExistence(timeout: 15))
        tile.tap()
        XCTAssertTrue(backButton.waitForExistence(timeout: 10))
        let start = point(0.35, 0.3)
        drag(start, moved(start, 190, 35))
        XCTAssertTrue(waitGone(backButton), "swipe right mid-screen did not go back on a Home page")
    }

    /// Search -> a browse page, swipe right mid-page (not on a track row).
    func testSearchPageSwipesBackFromMidPage() {
        app.buttons["Search"].tap()
        let tile = app.buttons["Electronic"].firstMatch
        XCTAssertTrue(tile.waitForExistence(timeout: 10))
        tile.tap()
        XCTAssertTrue(backButton.waitForExistence(timeout: 10))
        let start = point(0.4, 0.3)
        drag(start, moved(start, 170, -25))
        XCTAssertTrue(waitGone(backButton), "swipe right mid-page did not go back on a Search page")
    }

    /// A back swipe that starts on the playlist cover never opens "Edit details" (11-13: it
    /// flashed it, the finger lifts over the cover as the page moves with it). Short of popping
    /// the page springs back, so a stray tap would leave the dialog open.
    func testBackSwipeOnPlaylistCoverDoesNotOpenEditor() {
        openPlaylist()
        let cover = app.buttons["Choose photo"].firstMatch
        XCTAssertTrue(cover.waitForExistence(timeout: 10))
        let start = point(on: cover, 0.3, 0.5)
        drag(start, moved(start, 50, 4), velocity: .default)
        sleep(1)
        XCTAssertFalse(app.staticTexts["Edit details"].exists, "a swipe on the cover opened Edit details")
        cover.tap()
        XCTAssertTrue(app.staticTexts["Edit details"].waitForExistence(timeout: 5), "a tap on the cover did not open Edit details")
    }

    /// Library -> playlist scrolled down: swipe right on the top bar goes back.
    func testLibraryPageSwipesBackWhenScrolled() {
        openPlaylist()
        let c = point(0.5, 0.8)
        drag(c, moved(c, 0, -420), velocity: .slow)
        sleep(1)
        let start = point(0.45, 0.085)
        drag(start, moved(start, 160, 30))
        XCTAssertTrue(waitGone(backButton), "swipe right did not go back once the page was scrolled")
    }

    /// Settings (no track rows): a short fast flick from the middle goes back.
    func testSettingsSwipesBackWithShortFlick() {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Guest'")).firstMatch.tap()
        let settings = app.buttons["Settings"].firstMatch
        XCTAssertTrue(settings.waitForExistence(timeout: 5))
        settings.tap()
        XCTAssertTrue(backButton.waitForExistence(timeout: 10))
        let start = point(0.3, 0.55)
        drag(start, moved(start, 110, 12))
        XCTAssertTrue(waitGone(backButton), "a short flick right did not go back from Settings")
    }

    /// A swipe right on a track row queues it and stays on the page.
    func testSwipeRightOnTrackRowQueuesNotBack() {
        openPlaylist()
        let row = trackRows.element(boundBy: 2)
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        let start = point(on: row, 0.3, 0.5)
        drag(start, moved(start, 140, 8), velocity: .default)
        XCTAssertTrue(app.staticTexts["Added to queue"].waitForExistence(timeout: 3), "swipe right on a row did not queue")
        XCTAssertTrue(backButton.exists && backButton.isHittable, "swipe right on a row also went back")
    }

    /// Root tab page: swipe right opens the account drawer, swipe left closes it.
    func testRootSwipeRightOpensDrawerAndSwipeLeftCloses() {
        openLibrary()
        let start = point(0.3, 0.55)
        drag(start, moved(start, 180, 30))
        let history = app.buttons["Listening history"]
        XCTAssertTrue(history.waitForExistence(timeout: 3), "swipe right on a root page did not open the drawer")
        let s2 = point(0.6, 0.6)
        drag(s2, moved(s2, -150, 25))
        XCTAssertTrue(waitGone(history), "swipe left did not close the drawer")
    }
}

final class SwipeDownTests: GestureTestCase {

    private var npQueueButton: XCUIElement { app.buttons["Queue"].firstMatch }


    /// A short fast flick down from the artwork closes now playing.
    func testNowPlayingClosesWithShortFlickOnArtwork() {
        startPlayback()
        openNowPlaying()
        let start = point(0.5, 0.35)
        drag(start, moved(start, 30, 110))
        XCTAssertTrue(waitGone(npQueueButton), "a short flick down on the art did not close now playing")
    }

    /// A slow drag down, diagonal, from the controls area closes it.
    func testNowPlayingClosesWithSlowDiagonalDrag() {
        startPlayback()
        openNowPlaying()
        let start = point(0.25, 0.62)
        drag(start, moved(start, 70, 260), velocity: .slow)
        XCTAssertTrue(waitGone(npQueueButton), "a slow diagonal drag did not close now playing")
    }

    /// The queue list at its top: a drag down that starts on a row closes it.
    func testQueueClosesFromListRow() {
        startPlayback()
        openNowPlaying()
        npQueueButton.tap()
        let close = app.buttons["Close panel"]
        XCTAssertTrue(close.waitForExistence(timeout: 5))
        let start = point(0.4, 0.45)
        drag(start, moved(start, -20, 240), velocity: .default)
        XCTAssertTrue(waitGone(close), "a drag down on the queue list did not close it")
    }

    /// A context menu: drag down that starts on a menu item closes it.
    func testContextMenuClosesFromItem() {
        openPlaylist()
        let more = app.buttons.matching(identifier: "More options").element(boundBy: 0)
        XCTAssertTrue(more.waitForExistence(timeout: 10))
        more.tap()
        let item = app.buttons["Add to queue"].firstMatch
        XCTAssertTrue(item.waitForExistence(timeout: 5))
        let start = point(on: item, 0.4, 0.5)
        drag(start, moved(start, 25, 200), velocity: .default)
        XCTAssertTrue(waitGone(item), "drag down on a menu item did not close the menu")
    }

    /// The "Add to playlist" sub-sheet closes with a swipe down too (it was not draggable).
    func testSubMenuClosesWithSwipeDown() {
        openPlaylist()
        let more = trackRows.element(boundBy: 0).buttons["More options"]
        XCTAssertTrue(more.waitForExistence(timeout: 10))
        more.tap()
        let add = app.buttons["Add to playlist"].firstMatch
        XCTAssertTrue(add.waitForExistence(timeout: 5))
        add.tap()
        let new = app.buttons["New playlist"].firstMatch
        XCTAssertTrue(new.waitForExistence(timeout: 5))
        let start = point(on: new, 0.5, 0.5)
        drag(start, moved(start, -30, 220), velocity: .default)
        XCTAssertTrue(waitGone(new), "swipe down did not close the sub-sheet")
    }

    /// A sheet taller than the screen (the app icons): once scrolled down, a swipe down scrolls
    /// back up instead of closing it (11-13: it closed). Only at the top does it close.
    func testTallSheetScrollsBackUpBeforeClosing() {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Guest'")).firstMatch.tap()
        let settings = app.buttons["Settings"].firstMatch
        XCTAssertTrue(settings.waitForExistence(timeout: 5))
        settings.tap()
        let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'App icon'")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        drag(point(0.5, 0.7), point(0.5, 0.3), velocity: .default)
        row.tap()
        let first = app.buttons["Slopify"].firstMatch
        XCTAssertTrue(first.waitForExistence(timeout: 5), "the icon sheet did not open")
        let last = app.buttons["Neon RGB ring"].firstMatch
        for _ in 0..<4 where !last.isHittable { drag(point(0.5, 0.75), point(0.5, 0.35), velocity: .default) }
        XCTAssertTrue(last.isHittable, "the icon sheet did not scroll down")
        XCTAssertFalse(first.isHittable, "the first icon is still on screen after scrolling down")
        for _ in 0..<3 where !first.isHittable {
            let start = point(0.5, 0.5)
            drag(start, moved(start, 10, 200), velocity: .fast)
            XCTAssertTrue(last.exists, "a swipe down while scrolled closed the sheet instead of scrolling up")
        }
        XCTAssertTrue(first.isHittable, "swipes down did not scroll the icon sheet back to the top")
    }

    /// Lyrics at their top: a swipe down from mid-screen goes back to the cover, like the
    /// chevron there; now playing stays open (11-13).
    func testLyricsSwipeDownAtTopShowsCover() {
        startPlayback()
        openNowPlaying()
        app.buttons["Lyrics"].firstMatch.tap()
        XCTAssertTrue(waitGone(npQueueButton), "the lyrics did not open")
        let start = point(0.5, 0.45)
        drag(start, moved(start, 10, 200), velocity: .default)
        XCTAssertTrue(npQueueButton.waitForExistence(timeout: 4), "a swipe down on the lyrics did not go back to the cover")
    }

    /// The device sheet closes with a flick down from its middle.
    func testDeviceSheetClosesWithFlick() {
        app.buttons["Playing on This Phone"].firstMatch.tap()
        let title = app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] 'device'")).firstMatch
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        let start = point(0.5, 0.8)
        drag(start, moved(start, 10, 120))
        XCTAssertTrue(waitGone(title), "a flick down did not close the device sheet")
    }

    /// A page opened from a Home tile closes with a swipe down from mid-screen.
    func testHomeZoomPageClosesWithSwipeDown() {
        let tile = app.buttons["Analytical"].firstMatch
        XCTAssertTrue(tile.waitForExistence(timeout: 15))
        tile.tap()
        XCTAssertTrue(backButton.waitForExistence(timeout: 10))
        sleep(1)
        let start = point(0.45, 0.5)
        drag(start, moved(start, 25, 260), velocity: .default)
        XCTAssertTrue(waitGone(backButton), "swipe down did not close the zoomed page")
    }
}

final class PlayerSwipeTests: GestureTestCase {

    private func label(_ id: String) -> String {
        let e = app.descendants(matching: .any)[id].firstMatch
        return e.exists ? e.label : ""
    }

    private func waitChange(_ id: String, from before: String) -> Bool {
        let p = NSPredicate { _, _ in self.label(id) != before && !self.label(id).isEmpty }
        return XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: p, object: nil)], timeout: 4) == .completed
    }

    func testMiniPlayerSwipeUpOpensNowPlaying() {
        startPlayback()
        let start = point(0.35, 0.845)
        drag(start, moved(start, 15, -160))
        XCTAssertTrue(app.buttons["Queue"].firstMatch.waitForExistence(timeout: 3), "swipe up on the mini player did not open now playing")
    }

    /// Fixture songs are a few seconds long: pause so only the swipe can change the title.
    private func pause() {
        app.buttons["Pause"].firstMatch.tap()
        XCTAssertTrue(app.buttons["Play"].firstMatch.waitForExistence(timeout: 3))
    }

    func testMiniPlayerSwipeLeftSkips() {
        startPlayback()
        pause()
        let before = label("mini-title")
        XCTAssertFalse(before.isEmpty)
        let start = point(0.5, 0.845)
        drag(start, moved(start, -120, 10))
        XCTAssertTrue(waitChange("mini-title", from: before), "swipe left on the mini player did not skip")
    }

    func testNowPlayingArtworkSwipeLeftSkips() {
        startPlayback()
        pause()
        openNowPlaying()
        let before = label("np-title")
        XCTAssertFalse(before.isEmpty)
        let start = point(0.75, 0.35)
        drag(start, moved(start, -180, 20))
        XCTAssertTrue(waitChange("np-title", from: before), "swipe left on the art did not skip")
        XCTAssertTrue(app.buttons["Queue"].firstMatch.exists, "the skip swipe closed now playing")
    }
}

final class LongPressTests: GestureTestCase {
    /// Home cards and tiles open the same menu a row does on a long press.
    func testLongPressOnHomeTileOpensMenu() {
        let tile = app.buttons["Analytical"].firstMatch
        XCTAssertTrue(tile.waitForExistence(timeout: 15))
        tile.press(forDuration: 0.8)
        XCTAssertTrue(app.buttons["Add to queue"].firstMatch.waitForExistence(timeout: 3), "long press on a Home tile opened no menu")
        XCTAssertFalse(backButton.exists && backButton.isHittable, "the long press also opened the page")
    }
}
