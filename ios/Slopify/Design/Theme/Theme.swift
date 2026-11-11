import SwiftUI

/// Every colour token of the web app (UI.md 2.1, 7.9), derived from 4 theme colours exactly as
/// `applyTheme()` in web/src/api/prefs.js. Read it with `@Environment(\.theme)`.
///
/// Token names match the CSS variables: `bgBase` = `--bg-base`, `fgSub` = `--fg-sub`, ...
/// `rgb` holds the raw values (for blending); the `Color` accessors are what views use.
struct Theme: Hashable, Sendable {
    struct Tokens: Hashable, Sendable {
        var accent, accentInk, accentOnDark, accentHover, accentPress, seekAccent, onAccent, onFg: RGB
        var bgBase, bgHighlight, bgElevated, bgElevatedHi, card, cardHover: RGB
        var tint, tintHi, tintPress: RGB
        var fg, fgDim, fgChrome, fgSub, fgFaint: RGB
        var themeFg, themeFgDim, themeOnFg: RGB
        var black, page, chip, field, sheet, green, danger, dangerBg: RGB
    }

    let colors: ThemeColors
    /// `data-light="1"`: Paper and other light themes.
    let isLight: Bool
    let rgb: Tokens

    init(_ input: ThemeColors = .default) {
        let d = ThemeColors.default
        let accent = RGB.strictHex(input.accent) ?? RGB(hex: d.accent)!
        let bg = RGB.strictHex(input.bg) ?? RGB(hex: d.bg)!
        let surface = RGB.strictHex(input.surface) ?? RGB(hex: d.surface)!
        let fg = RGB.strictHex(input.fg) ?? RGB(hex: d.fg)!
        colors = ThemeColors(accent: accent.hex, bg: bg.hex, surface: surface.hex, fg: fg.hex)
        let light = bg.isLight
        isLight = light
        let fgDim = fg.mix(bg, light ? 0.28 : 0.3)
        var ink = accent
        if light {
            var i = 0
            while i < 12 && ink.contrast(bg.mix(fg, 0.2)) < 4.5 { ink = ink.mix(.black, 0.1); i += 1 }
        }
        func h(_ x: UInt32) -> RGB { RGB(hex: x) }
        rgb = Tokens(
            accent: accent,
            accentInk: ink,
            accentOnDark: light ? accent.mix(.white, 0.45) : accent,
            accentHover: accent.mix(light ? .black : .white, 0.12),
            accentPress: accent.mix(.black, 0.12),
            seekAccent: accent,
            onAccent: accent.inkOn,
            onFg: fg.inkOn,
            bgBase: bg,
            bgHighlight: surface,
            bgElevated: surface,
            bgElevatedHi: surface.mix(fg, 0.08),
            card: bg.mix(surface, 0.5),
            cardHover: surface.mix(fg, 0.06),
            tint: light ? RGB(hex: 0x000000, alpha: 0x1a / 255) : RGB(hex: 0xffffff, alpha: 0x1a / 255),
            tintHi: light ? RGB(hex: 0x000000, alpha: 0x24 / 255) : RGB(hex: 0xffffff, alpha: 0x24 / 255),
            tintPress: light ? RGB(hex: 0x000000, alpha: 0x36 / 255) : RGB(hex: 0xffffff, alpha: 0x36 / 255),
            fg: fg,
            fgDim: fgDim,
            fgChrome: fgDim,
            fgSub: light ? fgDim : h(0xa7a7a7),
            fgFaint: light ? fgDim : h(0x727272),
            themeFg: fg,
            themeFgDim: fgDim,
            themeOnFg: fg.inkOn,
            black: light ? bg.mix(fg, 0.05) : h(0x000000),
            page: light ? bg : h(0x121212),
            chip: light ? surface.mix(fg, 0.08) : h(0x2a2a2a),
            field: light ? surface.mix(fg, 0.05) : h(0x1f1f1f),
            sheet: light ? surface : h(0x282828),
            green: light ? ink : h(0x1ed760),
            danger: light ? h(0xb3261e) : h(0xf3727f),
            dangerBg: light ? h(0xfbe4e2) : h(0x2a1618))
    }

    private init(colors: ThemeColors, isLight: Bool, rgb: Tokens) {
        self.colors = colors; self.isLight = isLight; self.rgb = rgb
    }

    static let `default` = Theme()

    // MARK: Dark islands (app.css:51-59)

    /// The token set that places sitting on artwork keep on a light theme: now playing,
    /// Browse tiles, the mini player row, `.rightpanel.with-bg`. Same theme on dark themes.
    var darkIsland: Theme { isLight ? island(fgSub: RGB(hex: 0xa7a7a7)) : self }

    /// `.hero` (detail headers, profile hero, the top bar over a hero): the dark set with
    /// `--fg-sub: #d0d0d0`. Same theme on dark themes.
    var heroIsland: Theme { isLight ? island(fgSub: RGB(hex: 0xd0d0d0)) : self }

    private func island(fgSub: RGB) -> Theme {
        var t = rgb
        t.fg = RGB(hex: 0xffffff); t.fgDim = RGB(hex: 0xb3b3b3); t.fgChrome = RGB(hex: 0xb3b3b3)
        t.fgSub = fgSub; t.fgFaint = RGB(hex: 0x727272)
        t.accentInk = rgb.accentOnDark; t.onFg = RGB(hex: 0x000000)
        t.bgBase = RGB(hex: 0x121212); t.bgHighlight = RGB(hex: 0x1f1f1f); t.bgElevated = RGB(hex: 0x1f1f1f)
        t.bgElevatedHi = RGB(hex: 0x2a2a2a); t.card = RGB(hex: 0x181818); t.cardHover = RGB(hex: 0x282828)
        t.tint = RGB(hex: 0xffffff, alpha: 0x1a / 255); t.tintHi = RGB(hex: 0xffffff, alpha: 0x24 / 255)
        t.tintPress = RGB(hex: 0xffffff, alpha: 0x36 / 255)
        t.page = RGB(hex: 0x121212); t.chip = RGB(hex: 0x2a2a2a); t.field = RGB(hex: 0x1f1f1f)
        t.sheet = RGB(hex: 0x282828); t.danger = RGB(hex: 0xf3727f)
        return Theme(colors: colors, isLight: false, rgb: t)
    }

    /// A sheet opened from the mini player gets the theme's own ink back (app.css:1272).
    var themeInk: Theme {
        var t = rgb
        t.fg = rgb.themeFg; t.fgDim = rgb.themeFgDim; t.onFg = rgb.themeOnFg
        return Theme(colors: colors, isLight: isLight, rgb: t)
    }

    // MARK: Colours

    var accent: Color { rgb.accent.color }
    var accentInk: Color { rgb.accentInk.color }
    var accentOnDark: Color { rgb.accentOnDark.color }
    var accentHover: Color { rgb.accentHover.color }
    var accentPress: Color { rgb.accentPress.color }
    /// The liked heart fill.
    var seekAccent: Color { rgb.seekAccent.color }
    var onAccent: Color { rgb.onAccent.color }
    var onFg: Color { rgb.onFg.color }
    var bgBase: Color { rgb.bgBase.color }
    var bgHighlight: Color { rgb.bgHighlight.color }
    var bgElevated: Color { rgb.bgElevated.color }
    var bgElevatedHi: Color { rgb.bgElevatedHi.color }
    var card: Color { rgb.card.color }
    var cardHover: Color { rgb.cardHover.color }
    var tint: Color { rgb.tint.color }
    var tintHi: Color { rgb.tintHi.color }
    var tintPress: Color { rgb.tintPress.color }
    var fg: Color { rgb.fg.color }
    var fgDim: Color { rgb.fgDim.color }
    var fgChrome: Color { rgb.fgChrome.color }
    var fgSub: Color { rgb.fgSub.color }
    var fgFaint: Color { rgb.fgFaint.color }
    var black: Color { rgb.black.color }
    var page: Color { rgb.page.color }
    var chip: Color { rgb.chip.color }
    var field: Color { rgb.field.color }
    var sheet: Color { rgb.sheet.color }
    var green: Color { rgb.green.color }
    var danger: Color { rgb.danger.color }
    var dangerBg: Color { rgb.dangerBg.color }

    /// `rgba(var(--fg-rgb), a)`: pressed rows (.08), dividers (.1), separators (.14), grabbers (.25).
    func fg(_ alpha: Double) -> Color { rgb.fg.opacity(alpha).color }
    /// `rgba(var(--page-rgb), a)`.
    func page(_ alpha: Double) -> Color { rgb.page.opacity(alpha).color }

    var colorScheme: ColorScheme { isLight ? .light : .dark }

    // MARK: Fixed colours that are not tokens (UI.md 2.1)

    enum Fixed {
        static let avatarFallback = RGB(hex: 0x509bf5).color
        static let drawerAvatarFallback = RGB(hex: 0x535353).color
        static let offlinePill = RGB(hex: 0x3a3a3a).color
        static let drawerScrim = Color.black.opacity(0.55)
        static let sheetScrim = Color.black.opacity(0.6)
        /// Home mix tiles (Home.jsx:43).
        static let mixPalette: [RGB] = [0xe8115b, 0x1e3264, 0x8d67ab, 0xe13300, 0x148a08, 0x0d73ec, 0x7d4b32, 0xba5d07].map { RGB(hex: $0) }
        /// Liked Songs tile gradient, 135deg (app.css:469-473).
        static let likedGradient = [RGB(hex: 0x450af5).color, RGB(hex: 0xc4efd9).color]
        static let likedHero = RGB(hex: 0x5038a0)
        static let radarHero = RGB(hex: 0x8d67ab)
        /// `.content --hero` default (app.css:283), not clamped.
        static let defaultHero = RGB(hex: 0x3d3c3c)
        /// Now playing gradient fallback when there is no cover colour.
        static let nowPlayingFallback = RGB(hex: 0x535353)
        static let textFieldBorder = RGB(hex: 0x555555).color
        static let secondaryButtonBorder = RGB(hex: 0x7a7a7a).color
        /// The settings/theme sheet check is hard-coded green (UI.md 7.9).
        static let checkGreen = RGB(hex: 0x1ed760).color
        /// `TILE_COLORS` (Library.jsx:270): the Search genre tiles, in server order.
        static let browseTiles: [RGB] = [0xe13300, 0x1e3264, 0x8d67ab, 0xe8115b, 0x148a08, 0x0d73ec, 0x7d4b32, 0xba5d07,
                                         0x477d95, 0x503750, 0x27856a, 0xd84000, 0xe1118c, 0xa56752, 0x4b7d9b, 0xe61e32].map { RGB(hex: $0) }
        /// Search "Start browsing" tiles (Library.jsx:1740-1757); Charts and Liked reuse radarHero / likedHero.
        static let madeForYouTile = RGB(hex: 0x1e3264)
        static let newReleasesTile = RGB(hex: 0xe13300)
        /// The white search field: black text, `#121212` at .85 for the placeholder (app.css:1296-1300).
        static let searchFieldBackground = Color.white
        static let searchFieldText = Color.black
        static let searchFieldPlaceholder = RGB(hex: 0x121212).color.opacity(0.85)
        /// `.verified svg` (app.css:368).
        static let verified = RGB(hex: 0x4cb3ff).color
        /// Profile hero (Library.jsx:1032).
        static let profileHero = RGB(hex: 0x4a4a4a)
        /// A falling stat in Listening history (app.css:1620).
        static let deltaDown = RGB(hex: 0xf87171).color
        /// The native server-address field border (mobile/App.js).
        static let fieldBorder = RGB(hex: 0x3e3e3e).color
    }
}

// MARK: - Environment

private struct ThemeKey: EnvironmentKey {
    static let defaultValue = Theme.default
}

extension EnvironmentValues {
    /// The active token set. Set at the root by `.themed(_:)`; dark islands override it.
    var theme: Theme {
        get { self[ThemeKey.self] }
        set { self[ThemeKey.self] = newValue }
    }
}

extension View {
    /// Places on artwork colour (now playing, tiles, mini player row) keep dark tokens on light themes.
    func darkIsland() -> some View { modifier(IslandModifier(kind: 0)) }
    /// Detail-page heroes: dark tokens with `--fg-sub #d0d0d0` on light themes.
    func heroIsland() -> some View { modifier(IslandModifier(kind: 1)) }
    /// Give back the theme's own ink inside an island (device sheet from the mini player).
    func themeInk() -> some View { modifier(IslandModifier(kind: 2)) }
}

private struct IslandModifier: ViewModifier {
    let kind: Int
    @Environment(\.theme) private var theme
    func body(content: Content) -> some View {
        let t = kind == 0 ? theme.darkIsland : kind == 1 ? theme.heroIsland : theme.themeInk
        content.environment(\.theme, t).environment(\.colorScheme, t.colorScheme)
    }
}
