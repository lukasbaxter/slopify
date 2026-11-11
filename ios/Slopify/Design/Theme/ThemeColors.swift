import Foundation

/// The four colours a theme is made of (prefs `theme`, API.md §16). Everything else is derived
/// by `Theme(_:)`. Values are `#rrggbb` strings as stored on the server.
struct ThemeColors: Hashable, Sendable, Codable {
    var accent: String
    var bg: String
    var surface: String
    var fg: String

    /// prefs.js `DEFAULT_THEME` (the "Classic" preset).
    static let `default` = ThemeColors(accent: "#1ed760", bg: "#121212", surface: "#1f1f1f", fg: "#ffffff")

    /// From the account prefs value; missing or malformed keys fall back per key (prefs.js applyTheme).
    init(pref: JSONValue?) {
        let o = pref?.object ?? [:]
        func pick(_ k: String, _ d: String) -> String { RGB.strictHex(o[k]?.string) != nil ? o[k]!.string! : d }
        let d = Self.default
        self.init(accent: pick("accent", d.accent), bg: pick("bg", d.bg), surface: pick("surface", d.surface), fg: pick("fg", d.fg))
    }

    init(accent: String, bg: String, surface: String, fg: String) {
        self.accent = accent; self.bg = bg; self.surface = surface; self.fg = fg
    }

    /// For `account.patchPrefs(["theme": colors.prefValue])`.
    var prefValue: JSONValue {
        .object(["accent": .string(accent), "bg": .string(bg), "surface": .string(surface), "fg": .string(fg)])
    }

    /// prefs.js `themeEquals`: the 4 keys, case-insensitive.
    func matches(_ other: ThemeColors) -> Bool {
        accent.lowercased() == other.accent.lowercased() && bg.lowercased() == other.bg.lowercased()
            && surface.lowercased() == other.surface.lowercased() && fg.lowercased() == other.fg.lowercased()
    }
}

/// A named preset (prefs.js `THEME_PRESETS`). `name` is an i18n key.
struct ThemePreset: Hashable, Sendable, Identifiable {
    var name: String
    var colors: ThemeColors
    var id: String { name }
    /// The label to show.
    var label: String { L(name) }

    static let all: [ThemePreset] = [
        ThemePreset(name: "Classic", colors: .default),
        ThemePreset(name: "Midnight", colors: ThemeColors(accent: "#4c8dff", bg: "#0b1020", surface: "#151d33", fg: "#ffffff")),
        ThemePreset(name: "Ember", colors: ThemeColors(accent: "#ff7a3d", bg: "#151010", surface: "#241a18", fg: "#fff5ee")),
        ThemePreset(name: "Orchid", colors: ThemeColors(accent: "#c77dff", bg: "#120f18", surface: "#1e1826", fg: "#ffffff")),
        ThemePreset(name: "Mono", colors: ThemeColors(accent: "#ffffff", bg: "#000000", surface: "#161616", fg: "#ffffff")),
        ThemePreset(name: "Paper", colors: ThemeColors(accent: "#1a7f4b", bg: "#f4f1ea", surface: "#ffffff", fg: "#141414")),
    ]

    /// The preset these colours equal, or nil ("Custom").
    static func matching(_ c: ThemeColors) -> ThemePreset? { all.first { $0.colors.matches(c) } }
}
