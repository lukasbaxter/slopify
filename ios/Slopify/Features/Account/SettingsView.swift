import SwiftUI

/// Phone Settings (UI.md 7.2; web Library.jsx:748-878). Rows save to the account at once
/// (`patchPrefs`: optimistic, relayed to the other devices). Left out until built (DECISIONS 6):
/// theme colour pickers, Spotify import, admin settings, Logs. Log out lives in the drawer.
struct SettingsView: View {
    @Environment(Account.self) private var account
    @Environment(Navigator.self) private var nav
    @Environment(ThemeStore.self) private var themeStore: ThemeStore?
    @Environment(\.theme) private var theme
    @State private var sheet: AccountSettingsSheet?
    @State private var languagePick = Localizer.shared.userPick
    @State private var showIcons = false
    @State private var appIcon = AccountAppIcon.current

    var body: some View {
        let prefs = account.prefs
        AccountSettingsScaffold(title: L("Settings")) {
            profileRow

            AccountSettingsHeading(L("Playback"))
            AccountSettingsRow(title: L("Streaming quality on phones"), subtitle: L(AccountSettingsLogic.quality(.phoneQuality, prefs: prefs).label)) {
                sheet = qualitySheet(.phoneQuality, prefs: prefs)
            }
            AccountSettingsRow(title: L("Streaming quality elsewhere"), subtitle: L(AccountSettingsLogic.quality(.quality, prefs: prefs).label)) {
                sheet = qualitySheet(.quality, prefs: prefs)
            }
            AccountSettingsRow(title: L("Normalize volume"),
                        subtitle: AccountSettingsLogic.normalizeOn(prefs) ? L("On: every song at the same loudness") : L("Off"),
                        chevron: false) {
                save(AccountSettingsLogic.togglePatch("normalize", prefs: prefs))
            }
            // DECISIONS 3: crossfade and gapless run natively, so no "Not on iPhone yet".
            AccountSettingsRow(title: L("Crossfade"), subtitle: AccountSettingsLogic.crossfadeLabel(AccountSettingsLogic.crossfade(prefs))) {
                sheet = crossfadeSheet(prefs: prefs)
            }
            AccountSettingsRow(title: L("Gapless playback"), subtitle: AccountSettingsLogic.gaplessOn(prefs) ? L("On") : L("Off"), chevron: false) {
                save(AccountSettingsLogic.togglePatch("gapless", prefs: prefs))
            }

            AccountSettingsHeading(L("Scrobbling"))
            AccountSettingsRow(title: L("Scrobbling"), subtitle: AccountSettingsLogic.scrobblingSubtitle(.init(prefs: prefs))) {
                nav.push(.scrobbling)
            }

            AccountSettingsHeading(L("Language"))
            AccountSettingsRow(title: L("Language"), subtitle: AccountSettingsLogic.languageLabel(pick: languagePick)) {
                sheet = languageSheet()
            }

            AccountSettingsHeading(L("Appearance"))
            AccountSettingsRow(title: L("Theme"), subtitle: AccountSettingsLogic.themeLabel(colors)) {
                sheet = themeSheet()
            }
            AccountSettingsRow(title: L("App icon"), subtitle: appIcon.label) {
                showIcons = true
            }
            AccountSettingsRow(title: L("Reset to default"), subtitle: nil, chevron: false) {
                setTheme(.default)
            }
            .disabled(!AccountSettingsLogic.canReset(colors))
            AccountSettingsCaption(L("Saved to your account and applied to every Slopify you have open."))

            // TODO(lead): "Server" › "Server address" row (UI.md 7.2.2 #17) needs a native address screen to open.
            AccountAboutBlock()
        }
        .accountSettingsSheet($sheet)
        .bottomSheet(isPresented: $showIcons, onDismiss: { appIcon = AccountAppIcon.current }) { AccountAppIconPicker() }
        .onAppear { languagePick = Localizer.shared.userPick }
        .onChange(of: account.pref("language")) { _, _ in languagePick = Localizer.shared.userPick }
    }

    private var colors: ThemeColors { themeStore?.colors ?? ThemeColors(pref: account.pref("theme")) }

    private var profileRow: some View {
        AccountSettingsRow(title: account.user?.name ?? "", subtitle: L("View profile"), bold: true,
                    verticalPadding: (12, 16), action: { nav.push(.profile) }) {
            AccountAvatar(userId: account.user?.id, name: account.user?.name, size: 56,
                          background: Theme.Fixed.drawerAvatarFallback, initialSize: 22, initialColor: .white)
        }
    }

    // MARK: sheets

    private func qualitySheet(_ key: AccountSettingsLogic.QualityKey, prefs: [String: JSONValue]) -> AccountSettingsSheet {
        let cur = AccountSettingsLogic.quality(key, prefs: prefs)
        let phone = key == .phoneQuality
        return AccountSettingsSheet(
            icon: .play,
            title: phone ? L("Streaming quality on phones") : L("Streaming quality elsewhere"),
            subtitle: phone ? L("Applies from the next track on every phone signed in as you.")
                : L("Desktop and tablet. Applies from the next track. Speakers always get the original file."),
            options: AccountSettingsLogic.qualities.map { q in
                AccountSettingsOption(label: L(q.label), mark: q.id == cur.id ? .check : .none) { save([key.rawValue: .string(q.id)]) }
            })
    }

    private func crossfadeSheet(prefs: [String: JSONValue]) -> AccountSettingsSheet {
        let cur = AccountSettingsLogic.crossfade(prefs)
        return AccountSettingsSheet(
            icon: .play, title: L("Crossfade"),
            subtitle: L("Songs that end by themselves fade into the next. Albums played in order stay gapless."),
            options: AccountSettingsLogic.crossfades.map { s in
                AccountSettingsOption(label: AccountSettingsLogic.crossfadeLabel(s), mark: s == cur ? .check : .none) { save(["crossfade": .number(Double(s))]) }
            })
    }

    private func languageSheet() -> AccountSettingsSheet {
        let all = [(code: "", name: L("Automatic"))] + Localizer.languages
        return AccountSettingsSheet(
            icon: .gear, title: L("Language"),
            subtitle: L("Saved to your account. Automatic follows the server, then this device."),
            options: all.map { l in
                AccountSettingsOption(label: l.name, mark: l.code == languagePick ? .check : .none) { pickLanguage(l.code) }
            })
    }

    private func themeSheet() -> AccountSettingsSheet {
        let current = ThemePreset.matching(colors)
        return AccountSettingsSheet(
            icon: .photo, title: L("Theme"), subtitle: L("Applied to every Slopify you have open, instantly."),
            options: ThemePreset.all.map { p in
                AccountSettingsOption(label: p.label, mark: current?.name == p.name ? .check : .dot(RGB(hex: p.colors.accent)?.color ?? theme.accent)) {
                    setTheme(p.colors)
                }
            })
    }

    // MARK: saving

    /// App.jsx:611: a refused save toasts; the setting stays as picked.
    private func save(_ patch: [String: JSONValue]) {
        Task {
            do { try await account.patchPrefsThrowing(patch) }
            catch { ToastCenter.shared.show(L("Could not save settings: {error}", ["error": error.localizedDescription])) }
        }
    }

    private func setTheme(_ c: ThemeColors) {
        if let themeStore { Task { await themeStore.set(c) } } else { save(["theme": c.prefValue]) }
    }

    /// The pick switches strings live here (no reload), then saves to the account.
    private func pickLanguage(_ code: String) {
        Localizer.shared.setUserPick(code)
        languagePick = code
        save(["language": .string(code)])
    }
}

/// About (UI.md 7.6.3, web components/About.jsx), phone variant: two hint paragraphs.
private struct AccountAboutBlock: View {
    @Environment(Account.self) private var account
    @Environment(\.theme) private var theme
    @State private var info: Info?

    struct Info: Decodable { var version: String?; var source: String? }

    static let defaultSource = "https://github.com/lukasbaxter/slopify"
    static let license = "https://www.gnu.org/licenses/agpl-3.0.html"

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(AccountAboutText.paragraph(version: info?.version, source: info?.source, fg: theme.fg))
                .padding(.top, 6)
            Text(L("Not affiliated with Spotify.")).padding(.top, 14)
        }
        .font(.system(size: 14))
        .foregroundStyle(theme.fgDim)
        .tint(theme.fg)
        .fixedSize(horizontal: false, vertical: true)
        .padding(.top, 24)
        .task { info = try? await account.api.get("api/server") }
    }
}

enum AccountAboutText {
    /// `{app} is free software under the <a>GNU AGPL v3</a>.` + ` Source code · What leaves your server`.
    static func paragraph(version: String?, source: String?, fg: Color) -> AttributedString {
        let app = "Slopify" + (version.map { $0.isEmpty ? "" : " " + $0 } ?? "")
        let src = (source?.isEmpty == false ? source! : "https://github.com/lukasbaxter/slopify")
        var out = linked(L("{app} is free software under the <a>GNU AGPL v3</a>.", ["app": app]),
                         url: URL(string: "https://www.gnu.org/licenses/agpl-3.0.html"), fg: fg)
        out += AttributedString(" ")
        out += link(L("Source code"), URL(string: src), fg: fg)
        out += AttributedString(" · ")
        out += link(L("What leaves your server"), URL(string: src + "/blob/main/docs/PRIVACY.md"), fg: fg)
        return out
    }

    /// `<a>x</a>` in a translated string becomes a link.
    static func linked(_ s: String, url: URL?, fg: Color) -> AttributedString {
        guard let open = s.range(of: "<a>"), let close = s.range(of: "</a>", range: open.upperBound..<s.endIndex) else {
            return AttributedString(s)
        }
        var out = AttributedString(String(s[..<open.lowerBound]))
        out += link(String(s[open.upperBound..<close.lowerBound]), url, fg: fg)
        out += AttributedString(String(s[close.upperBound...]))
        return out
    }

    private static func link(_ text: String, _ url: URL?, fg: Color) -> AttributedString {
        var a = AttributedString(text)
        a.link = url
        a.underlineStyle = .single
        a.foregroundColor = fg
        return a
    }
}
