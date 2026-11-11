import SwiftUI
import Observation

/// The app's words in the person's language (UI.md 8). The English text is the key; the
/// translation comes from the bundled web locale JSON (Resources/Locales, copied by
/// ios/tools/sync-locales.sh), falling back to the English. `{name}` placeholders are filled from
/// `vars`; a placeholder with no value stays literal.
///
/// Language = the person's pick (`prefs.language`), else the server default (`/api/i18n`), else
/// the device languages, else English. Changing it swaps the table live (views that call `L`
/// in `body` re-render, because `L` reads the observable `language`).
@Observable
final class Localizer: @unchecked Sendable {
    static let shared = Localizer()

    /// `LANGUAGES` from web/src/i18n.js, in Settings picker order. Names are not translated.
    static let languages: [(code: String, name: String)] = [
        ("en", "English"), ("es", "Español"), ("fr", "Français"), ("de", "Deutsch"), ("it", "Italiano"),
        ("pt-BR", "Português (Brasil)"), ("nl", "Nederlands"), ("pl", "Polski"), ("ru", "Русский"),
        ("uk", "Українська"), ("tr", "Türkçe"), ("sv", "Svenska"), ("da", "Dansk"), ("nb", "Norsk bokmål"),
        ("fi", "Suomi"), ("cs", "Čeština"), ("ja", "日本語"), ("ko", "한국어"), ("zh-CN", "简体中文"),
        ("zh-TW", "繁體中文"), ("id", "Bahasa Indonesia"), ("vi", "Tiếng Việt"),
    ]

    static let userKey = "slopify.lang.user"
    static let serverKey = "slopify.lang.server"

    /// The resolved language code in use.
    private(set) var language = "en"

    @ObservationIgnored private let lock = NSLock()
    @ObservationIgnored private var dict: [String: String] = [:]
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let bundle: Bundle
    @ObservationIgnored private let preferred: () -> [String]
    @ObservationIgnored private var observing = false

    init(defaults: UserDefaults = .standard, bundle: Bundle = .main, preferred: @escaping () -> [String] = { Locale.preferredLanguages }) {
        self.defaults = defaults
        self.bundle = bundle
        self.preferred = preferred
        apply()
    }

    /// The person's pick ("" = Automatic), cached on the device.
    var userPick: String { defaults.string(forKey: Self.userKey) ?? "" }
    /// The server's default, last seen.
    var serverDefault: String { defaults.string(forKey: Self.serverKey) ?? "" }

    /// For `Locale`-aware formatting (counts, dates) in the app's language.
    var locale: Locale { _ = language; return Locale(identifier: language) }

    // MARK: lookup

    func t(_ key: String, _ vars: [String: CustomStringConvertible] = [:]) -> String {
        _ = language // observation: re-render on a language change
        let raw = lock.withLock { dict[key] } ?? key
        return Self.fill(raw, vars)
    }

    /// `{name}` replacement (i18n.js `t`): only `\w+` names; unknown names stay literal.
    static func fill(_ s: String, _ vars: [String: CustomStringConvertible]) -> String {
        guard !vars.isEmpty, s.contains("{") else { return s }
        var out = "", i = s.startIndex
        while i < s.endIndex {
            if s[i] == "{", let close = s[i...].firstIndex(of: "}") {
                let name = s[s.index(after: i)..<close]
                if !name.isEmpty, name.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "_" }) {
                    if let v = vars[String(name)] { out += v.description } else { out += s[i...close] }
                    i = s.index(after: close)
                    continue
                }
            }
            out.append(s[i]); i = s.index(after: i)
        }
        return out
    }

    // MARK: choosing the language

    /// i18n.js `match`: the closest shipped language for a code like `pt`, `pt-PT`, `zh-Hant-TW`, `no`.
    static func match(_ code: String?) -> String? {
        guard let code, !code.isEmpty, code != "auto" else { return nil }
        let c = code.replacingOccurrences(of: "_", with: "-").lowercased()
        if let exact = languages.first(where: { $0.code.lowercased() == c }) { return exact.code }
        if c.hasPrefix("zh") { return c.range(of: "tw|hk|mo|hant", options: .regularExpression) != nil ? "zh-TW" : "zh-CN" }
        if c == "no" || c.hasPrefix("nn") || c.hasPrefix("no-") || c.hasPrefix("nb") { return "nb" }
        let base = c.split(separator: "-").first.map(String.init) ?? c
        return languages.first { $0.code.lowercased().split(separator: "-").first.map(String.init) == base }?.code
    }

    /// i18n.js `resolve`.
    static func resolve(user: String?, server: String?, device: [String]) -> String {
        match(user) ?? match(server) ?? device.lazy.compactMap { match($0) }.first ?? "en"
    }

    /// Set the person's pick ("" = Automatic) and switch now. Saving it to the account
    /// (`prefs.language`) is the Settings screen's job.
    func setUserPick(_ code: String) {
        defaults.set(code.isEmpty ? nil : code, forKey: Self.userKey)
        apply()
    }

    /// Fetch `/api/i18n` (public) and switch if the server default changes what is shown.
    @MainActor
    func refreshServerDefault(api: APIClient) async {
        struct R: Decodable { var language: String? }
        guard let r: R = try? await api.get("api/i18n") else { return }
        let v = r.language ?? ""
        defaults.set(v.isEmpty || v == "auto" ? nil : v, forKey: Self.serverKey)
        apply()
    }

    /// Follow `account.prefs["language"]` live (also picks arriving from other devices).
    @MainActor
    func follow(_ account: Account) {
        guard !observing else { return }
        observing = true
        track(account)
    }

    @MainActor
    private func track(_ account: Account) {
        let pick = withObservationTracking { account.pref("language")?.string } onChange: { [weak self, weak account] in
            Task { @MainActor in
                guard let self, let account else { return }
                self.track(account)
            }
        }
        if let pick, pick != userPick { setUserPick(pick == "auto" ? "" : pick) }
    }

    /// Re-resolve and load the table.
    func apply() {
        let code = Self.resolve(user: userPick, server: serverDefault, device: preferred())
        let table = code == "en" ? [:] : Self.load(code, bundle: bundle)
        lock.withLock { dict = table }
        if language != code { language = code }
    }

    static func load(_ code: String, bundle: Bundle) -> [String: String] {
        guard let url = bundle.url(forResource: code, withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        return obj.compactMapValues { $0 as? String }
    }

    /// Test hook: use this table directly.
    func install(_ table: [String: String], language code: String) {
        lock.withLock { dict = table }
        language = code
    }
}

/// Translate an English key: `L("Added to {name}", ["name": playlist.name])`.
func L(_ key: String, _ vars: [String: CustomStringConvertible] = [:]) -> String {
    Localizer.shared.t(key, vars)
}

/// Translate and parse inline `<b>…</b>` markup (UI.md 8.1) into bold runs.
func LBold(_ key: String, _ vars: [String: CustomStringConvertible] = [:]) -> AttributedString {
    boldMarkup(L(key, vars))
}

/// `<b>x</b>` -> bold `x` (split on `<b>(.*?)</b>`, odd parts bold).
func boldMarkup(_ s: String) -> AttributedString {
    var out = AttributedString()
    let parts = s.components(separatedBy: "<b>")
    for (i, p) in parts.enumerated() {
        if i == 0 { out += AttributedString(p); continue }
        let pieces = p.components(separatedBy: "</b>")
        var bold = AttributedString(pieces[0])
        bold.inlinePresentationIntent = .stronglyEmphasized
        out += bold
        if pieces.count > 1 { out += AttributedString(pieces.dropFirst().joined(separator: "</b>")) }
    }
    return out
}
