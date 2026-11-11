import XCTest
@testable import Slopify

/// Every derived token must equal what prefs.js `applyTheme()` writes, for every preset plus a
/// pale-accent light theme and a theme with bad keys.
final class ThemeTests: XCTestCase {
    private func token(_ t: Theme, _ v: String) -> RGB? {
        let r = t.rgb
        let map: [String: RGB] = [
            "--accent": r.accent, "--accent-ink": r.accentInk, "--accent-on-dark": r.accentOnDark, "--accent-hover": r.accentHover,
            "--accent-press": r.accentPress, "--seek-accent": r.seekAccent, "--on-accent": r.onAccent, "--on-fg": r.onFg,
            "--bg-base": r.bgBase, "--bg-highlight": r.bgHighlight, "--bg-elevated": r.bgElevated, "--bg-elevated-hi": r.bgElevatedHi,
            "--card": r.card, "--card-hover": r.cardHover, "--tint": r.tint, "--tint-hi": r.tintHi, "--tint-press": r.tintPress,
            "--fg": r.fg, "--fg-dim": r.fgDim, "--fg-chrome": r.fgChrome, "--theme-fg": r.themeFg, "--theme-fg-dim": r.themeFgDim,
            "--theme-on-fg": r.themeOnFg, "--fg-sub": r.fgSub, "--fg-faint": r.fgFaint, "--black": r.black, "--page": r.page,
            "--chip": r.chip, "--field": r.field, "--sheet": r.sheet, "--green": r.green, "--danger": r.danger, "--danger-bg": r.dangerBg,
        ]
        return map[v]
    }

    private func rgbString(_ c: RGB) -> String { c.ints.map(String.init).joined(separator: ",") }

    func testAllThemesMatchApplyTheme() {
        let cases = ColorFixtures.shared.themes
        XCTAssertEqual(cases.count, 8)
        for c in cases {
            let t = Theme(ThemeColors(accent: c.theme["accent"]!, bg: c.theme["bg"]!, surface: c.theme["surface"]!, fg: c.theme["fg"]!))
            XCTAssertEqual(t.isLight, c.light, c.name)
            XCTAssertEqual(t.colorScheme == .light ? "light" : "dark", c.colorScheme, c.name)
            var checked = 0
            for (v, expected) in c.vars {
                if v.hasSuffix("-rgb") {
                    let src: RGB = v == "--accent-rgb" ? t.rgb.accent : v == "--page-rgb" ? t.rgb.page : t.rgb.fg
                    XCTAssertEqual(rgbString(src), expected, "\(c.name) \(v)"); checked += 1; continue
                }
                guard let tok = token(t, v), let want = RGB(hex: expected) else { XCTFail("\(c.name): unmapped \(v)"); continue }
                XCTAssertEqual(tok.hex, want.hex, "\(c.name) \(v)")
                XCTAssertEqual(tok.alpha, want.alpha, accuracy: 0.002, "\(c.name) \(v) alpha")
                checked += 1
            }
            XCTAssertEqual(checked, c.vars.count, c.name)
        }
    }

    func testPresetsAndEquality() {
        XCTAssertEqual(ThemePreset.all.map(\.name), ["Spotify", "Midnight", "Ember", "Orchid", "Mono", "Paper"])
        XCTAssertEqual(ThemePreset.matching(ThemeColors(accent: "#1ED760", bg: "#121212", surface: "#1F1F1F", fg: "#FFFFFF"))?.name, "Spotify")
        XCTAssertNil(ThemePreset.matching(ThemeColors(accent: "#123456", bg: "#121212", surface: "#1f1f1f", fg: "#ffffff")))
    }

    func testPrefParsingFallsBackPerKey() {
        let c = ThemeColors(pref: .object(["accent": .string("#4c8dff"), "bg": .string("bad"), "fg": .number(3)]))
        XCTAssertEqual(c, ThemeColors(accent: "#4c8dff", bg: "#121212", surface: "#1f1f1f", fg: "#ffffff"))
        XCTAssertEqual(ThemeColors(pref: nil), .default)
    }

    func testDarkIslandsOnLightTheme() {
        let paper = Theme(ThemePreset.all.last!.colors)
        XCTAssertTrue(paper.isLight)
        XCTAssertEqual(paper.darkIsland.rgb.fg.hex, "#ffffff")
        XCTAssertEqual(paper.darkIsland.rgb.fgSub.hex, "#a7a7a7")
        XCTAssertEqual(paper.heroIsland.rgb.fgSub.hex, "#d0d0d0")
        XCTAssertEqual(paper.darkIsland.rgb.accentInk.hex, paper.rgb.accentOnDark.hex)
        XCTAssertEqual(paper.darkIsland.rgb.sheet.hex, "#282828")
        XCTAssertFalse(paper.darkIsland.isLight)
        // dark themes are unchanged
        XCTAssertEqual(Theme.default.darkIsland, Theme.default)
    }

    @MainActor
    func testThemeStoreFollowsAccountPrefs() async {
        let store = ThemeStore()
        XCTAssertEqual(store.theme.rgb.accent.hex, "#1ed760")
        store.fallback = ThemePreset.all[1].colors
        XCTAssertEqual(store.theme.rgb.accent.hex, "#4c8dff")
        XCTAssertEqual(store.preset?.name, "Midnight")
    }
}
