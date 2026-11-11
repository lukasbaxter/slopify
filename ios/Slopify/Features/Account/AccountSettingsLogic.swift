import Foundation

/// The pure parts of the phone Settings page (UI.md 7.2, web Library.jsx:748-878, api/prefs.js).
/// Every read takes the prefs object so it can be tested without an `Account`.
enum AccountSettingsLogic {
    /// api/prefs.js `QUALITIES`.
    struct Quality: Hashable, Identifiable {
        var id: String
        var label: String
    }

    static let qualities: [Quality] = [
        Quality(id: "original", label: "Lossless (original file)"),
        Quality(id: "high", label: "Very high (320 kbps)"),
        Quality(id: "normal", label: "Normal (160 kbps)"),
        Quality(id: "low", label: "Low (96 kbps)"),
    ]

    /// prefs.js `CROSSFADES`.
    static let crossfades: [Int] = [0, 1, 2, 3, 5, 8, 12]

    enum QualityKey: String { case phoneQuality, quality }

    /// The selected quality for a key; unknown ids fall back like the web (`find(...) || QUALITIES[n]`).
    static func quality(_ key: QualityKey, prefs: [String: JSONValue]) -> Quality {
        let raw = prefs[key.rawValue]?.string ?? ""
        let def = key == .phoneQuality ? "high" : "original"
        let id = raw.isEmpty ? def : raw
        return qualities.first { $0.id == id } ?? qualities.first { $0.id == def }!
    }

    /// `normalize !== false`.
    static func normalizeOn(_ prefs: [String: JSONValue]) -> Bool { prefs["normalize"]?.bool != false }
    /// `gapless !== false`.
    static func gaplessOn(_ prefs: [String: JSONValue]) -> Bool { prefs["gapless"]?.bool != false }

    /// The toggle patch: `{ key: prefs.key === false }` (false -> true, anything else -> false).
    static func togglePatch(_ key: String, prefs: [String: JSONValue]) -> [String: JSONValue] {
        [key: .bool(prefs[key]?.bool == false)]
    }

    /// `Number(prefs.crossfade) || 0`.
    static func crossfade(_ prefs: [String: JSONValue]) -> Int {
        switch prefs["crossfade"] {
        case .number(let n)?: return n.isFinite ? Int(n) : 0
        case .string(let s)?: return Double(s.trimmingCharacters(in: .whitespaces)).map { $0.isFinite ? Int($0) : 0 } ?? 0
        default: return 0
        }
    }

    /// prefs.js `crossfadeLabel`.
    static func crossfadeLabel(_ seconds: Int) -> String {
        if seconds <= 0 { return L("Off") }
        if seconds == 1 { return L("1 second") }
        return L("{n} seconds", ["n": seconds])
    }

    /// ListenBrainz credentials as saved (`prefs.listenbrainz`).
    struct ListenBrainz: Equatable {
        var user = ""
        var token = ""
        var connected: Bool { !token.isEmpty }

        init(user: String = "", token: String = "") { self.user = user; self.token = token }
        init(prefs: [String: JSONValue]) {
            user = prefs["listenbrainz"]?["user"]?.string ?? ""
            token = prefs["listenbrainz"]?["token"]?.string ?? ""
        }

        var prefValue: JSONValue { .object(["user": .string(user), "token": .string(token)]) }
    }

    /// Settings row subtitle for Scrobbling.
    static func scrobblingSubtitle(_ lb: ListenBrainz) -> String {
        guard lb.connected else { return L("Off") }
        return lb.user.isEmpty ? L("On, as your account") : L("On, as {user}", ["user": lb.user])
    }

    /// Scrobbling sub-page status caption.
    static func scrobblingStatus(_ lb: ListenBrainz) -> String {
        guard lb.connected else { return L("Scrobbling is off until a token is saved.") }
        return lb.user.isEmpty ? L("Scrobbling as your account.") : L("Scrobbling as {user}.", ["user": lb.user])
    }

    /// The Save button is live only while the draft differs from what is saved.
    static func scrobblingDirty(draft: ListenBrainz, saved: ListenBrainz) -> Bool { draft != saved }

    /// Submit trims both fields.
    static func scrobblingSubmit(_ draft: ListenBrainz) -> ListenBrainz {
        ListenBrainz(user: draft.user.trimmingCharacters(in: .whitespacesAndNewlines),
                     token: draft.token.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    /// The Language row subtitle: the native name of the stored pick, or Automatic.
    static func languageLabel(pick: String) -> String {
        Localizer.languages.first { $0.code == pick }?.name ?? L("Automatic")
    }

    /// The Theme row subtitle: the matching preset name, or Custom.
    static func themeLabel(_ colors: ThemeColors) -> String {
        ThemePreset.matching(colors)?.label ?? L("Custom")
    }

    /// "Reset to default" is disabled while the theme already is the default.
    static func canReset(_ colors: ThemeColors) -> Bool { !colors.matches(.default) }
}
