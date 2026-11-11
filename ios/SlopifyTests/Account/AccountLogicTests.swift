import XCTest
@testable import Slopify

final class AccountSettingsLogicTests: XCTestCase {
    func testQualityDefaultsAndFallback() {
        XCTAssertEqual(AccountSettingsLogic.quality(.phoneQuality, prefs: [:]).id, "high")
        XCTAssertEqual(AccountSettingsLogic.quality(.quality, prefs: [:]).id, "original")
        XCTAssertEqual(AccountSettingsLogic.quality(.quality, prefs: ["quality": .string("low")]).id, "low")
        XCTAssertEqual(AccountSettingsLogic.quality(.phoneQuality, prefs: ["phoneQuality": .string("bogus")]).id, "high")
    }

    func testTogglesFollowWeb() {
        XCTAssertTrue(AccountSettingsLogic.normalizeOn([:]))
        XCTAssertFalse(AccountSettingsLogic.normalizeOn(["normalize": .bool(false)]))
        XCTAssertTrue(AccountSettingsLogic.gaplessOn(["gapless": .string("x")]))
        // `{ key: prefs.key === false }`
        XCTAssertEqual(AccountSettingsLogic.togglePatch("normalize", prefs: [:]), ["normalize": .bool(false)])
        XCTAssertEqual(AccountSettingsLogic.togglePatch("normalize", prefs: ["normalize": .bool(false)]), ["normalize": .bool(true)])
        XCTAssertEqual(AccountSettingsLogic.togglePatch("gapless", prefs: ["gapless": .bool(true)]), ["gapless": .bool(false)])
    }

    func testCrossfade() {
        XCTAssertEqual(AccountSettingsLogic.crossfade([:]), 0)
        XCTAssertEqual(AccountSettingsLogic.crossfade(["crossfade": .number(5)]), 5)
        XCTAssertEqual(AccountSettingsLogic.crossfade(["crossfade": .string("8")]), 8)
        XCTAssertEqual(AccountSettingsLogic.crossfade(["crossfade": .bool(true)]), 0)
        XCTAssertEqual(AccountSettingsLogic.crossfadeLabel(0), "Off")
        XCTAssertEqual(AccountSettingsLogic.crossfadeLabel(1), "1 second")
        XCTAssertEqual(AccountSettingsLogic.crossfadeLabel(12), "12 seconds")
    }

    func testScrobbling() {
        let off = AccountSettingsLogic.ListenBrainz(prefs: [:])
        XCTAssertFalse(off.connected)
        XCTAssertEqual(AccountSettingsLogic.scrobblingSubtitle(off), "Off")
        XCTAssertEqual(AccountSettingsLogic.scrobblingStatus(off), "Scrobbling is off until a token is saved.")
        let on = AccountSettingsLogic.ListenBrainz(prefs: ["listenbrainz": .object(["user": .string("ava"), "token": .string("t")])])
        XCTAssertEqual(AccountSettingsLogic.scrobblingSubtitle(on), "On, as ava")
        XCTAssertEqual(AccountSettingsLogic.scrobblingStatus(on), "Scrobbling as ava.")
        let anon = AccountSettingsLogic.ListenBrainz(token: "t")
        XCTAssertEqual(AccountSettingsLogic.scrobblingSubtitle(anon), "On, as your account")
        XCTAssertFalse(AccountSettingsLogic.scrobblingDirty(draft: on, saved: on))
        XCTAssertTrue(AccountSettingsLogic.scrobblingDirty(draft: anon, saved: on))
        XCTAssertEqual(AccountSettingsLogic.scrobblingSubmit(.init(user: " a ", token: "\tx\n")), .init(user: "a", token: "x"))
        XCTAssertEqual(AccountSettingsLogic.ListenBrainz().prefValue, .object(["user": .string(""), "token": .string("")]))
    }

    func testLanguageAndTheme() {
        XCTAssertEqual(AccountSettingsLogic.languageLabel(pick: ""), "Automatic")
        XCTAssertEqual(AccountSettingsLogic.languageLabel(pick: "de"), "Deutsch")
        XCTAssertEqual(AccountSettingsLogic.themeLabel(.default), "Spotify")
        XCTAssertEqual(AccountSettingsLogic.themeLabel(ThemeColors(accent: "#123456", bg: "#000000", surface: "#111111", fg: "#ffffff")), "Custom")
        XCTAssertFalse(AccountSettingsLogic.canReset(ThemeColors(accent: "#1ED760", bg: "#121212", surface: "#1f1f1f", fg: "#FFFFFF")))
        XCTAssertTrue(AccountSettingsLogic.canReset(ThemePreset.all[1].colors))
    }

    func testAboutLinks() {
        let a = AccountAboutText.paragraph(version: "1.2", source: nil, fg: .white)
        let text = String(a.characters)
        XCTAssertTrue(text.hasPrefix("Slopify 1.2 is free software under the GNU AGPL v3."))
        XCTAssertFalse(text.contains("<a>"))
        let links = a.runs.compactMap(\.link).map(\.absoluteString)
        XCTAssertEqual(links, ["https://www.gnu.org/licenses/agpl-3.0.html", "https://github.com/lukasbaxter/slopify",
                               "https://github.com/lukasbaxter/slopify/blob/main/docs/PRIVACY.md"])
    }

    func testDrawerSwipe() {
        XCTAssertTrue(AccountDrawerLogic.isCloseSwipe(dx: -60, dy: 10))
        XCTAssertFalse(AccountDrawerLogic.isCloseSwipe(dx: -40, dy: 0))
        XCTAssertFalse(AccountDrawerLogic.isCloseSwipe(dx: -60, dy: 50))
        XCTAssertFalse(AccountDrawerLogic.isCloseSwipe(dx: 80, dy: 0))
    }
}

final class AccountProfileLogicTests: XCTestCase {
    private func track(_ id: String, artists: [(String, String)], plays: Int?) -> Track {
        Track(id: id, title: id, artist: artists.first?.0 ?? "", artists: artists.map(\.0), artistIds: artists.map(\.1),
              albumId: "al", album: "Al", albumArtist: "", durationMs: 1000, plays: plays)
    }

    func testTopArtistsScoring() {
        let top = AccountProfileLogic.topArtists([
            track("1", artists: [("A", "a")], plays: 2),           // a 3
            track("2", artists: [("B", "b"), ("A", "a")], plays: 0), // b 1, a 4
            track("3", artists: [("C", "c")], plays: nil),          // c 1
            track("4", artists: [("B", "b")], plays: 0),            // b 2
        ])
        XCTAssertEqual(top.map(\.id), ["a", "b", "c"])
        XCTAssertEqual(top.map(\.score), [4, 2, 1])
        XCTAssertEqual(AccountProfileLogic.topArtists((0..<30).map { track("\($0)", artists: [("x\($0)", "x\($0)")], plays: 0) }).count, 16)
    }

    func testTexts() {
        XCTAssertEqual(AccountProfileLogic.playlistCount(1), "1 public playlist")
        XCTAssertEqual(AccountProfileLogic.playlistCount(3), "3 public playlists")
        XCTAssertEqual(AccountProfileLogic.initial("lukas"), "L")
        XCTAssertEqual(AccountProfileLogic.initial(nil), "?")
        XCTAssertEqual(AccountProfileLogic.initial(""), "?")
    }

    func testPhotoReencodedAsSmallJPEG() throws {
        let img = UIGraphicsImageRenderer(size: CGSize(width: 2000, height: 1000), format: {
            let f = UIGraphicsImageRendererFormat.default(); f.scale = 1; return f }()).image { c in
            UIColor.red.setFill(); c.fill(CGRect(x: 0, y: 0, width: 2000, height: 1000))
        }
        let jpeg = try XCTUnwrap(AccountProfilePhoto.jpeg(try XCTUnwrap(img.pngData())))
        XCTAssertEqual(Array(jpeg.prefix(2)), [0xFF, 0xD8])
        let back = try XCTUnwrap(UIImage(data: jpeg))
        XCTAssertEqual(back.size.width * back.scale, 1024)
        XCTAssertNil(AccountProfilePhoto.jpeg(Data("nope".utf8)))
    }
}
