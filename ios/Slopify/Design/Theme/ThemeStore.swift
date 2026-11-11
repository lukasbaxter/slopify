import SwiftUI

/// Follows `account.prefs["theme"]` (live, including patches from other devices) and hands out
/// the derived `Theme`. Install once at the root: `.themed(themeStore)`.
@MainActor @Observable
final class ThemeStore {
    /// Colours to use while not signed in or before prefs load.
    var fallback: ThemeColors = .default
    @ObservationIgnored private weak var account: Account?
    @ObservationIgnored private var cache: (ThemeColors, Theme) = (.default, .default)

    init(account: Account? = nil) { self.account = account }

    func attach(_ account: Account) { self.account = account }

    /// The account's theme colours (read through Observation, so views update on a prefs change).
    var colors: ThemeColors {
        guard let account, let pref = account.pref("theme") else { return fallback }
        return ThemeColors(pref: pref)
    }

    var theme: Theme {
        let c = colors
        if cache.0 != c { cache = (c, Theme(c)) }
        return cache.1
    }

    /// The preset these colours equal, or nil for "Custom".
    var preset: ThemePreset? { ThemePreset.matching(colors) }

    /// Save a theme to the account (other devices apply it live via the relay).
    func set(_ c: ThemeColors) async {
        await account?.patchPrefs(["theme": c.prefValue])
    }
}

extension View {
    /// Root installation: puts the store and its `Theme` in the environment, sets the colour scheme.
    func themed(_ store: ThemeStore) -> some View { modifier(ThemedRoot(store: store)) }
}

private struct ThemedRoot: ViewModifier {
    let store: ThemeStore
    func body(content: Content) -> some View {
        let t = store.theme
        content
            .environment(store)
            .environment(\.theme, t)
            .environment(\.colorScheme, t.colorScheme)
            .tint(t.accent)
    }
}
