import Foundation

/// Pure rules of the sign-in flow (validation, messages, invite links). No UI, no network.
enum SignInRules {
    /// What the server form found wrong (mobile/App.js ServerForm.submit), nil when it may probe.
    static func serverFormError(main: String, home: String) -> String? {
        let m = main.trimmingCharacters(in: .whitespacesAndNewlines)
        if m.isEmpty { return L("Enter the address of your Slopify server.") }
        if Address.candidates(m).isEmpty { return L("That server address doesn’t look right. Try something like music.example.com.") }
        let h = home.trimmingCharacters(in: .whitespacesAndNewlines)
        if !h.isEmpty, Address.candidates(h).isEmpty { return L("That home address doesn’t look right. Try something like 192.168.1.10:8080.") }
        return nil
    }

    static func noServerMessage(typed: String) -> String {
        let host = Address.candidates(typed).first.map(hostLabel) ?? typed
        return L("No Slopify server answered at {host}. Check the address, and that the phone can reach it.", ["host": host])
    }

    /// `hostLabel` in web/src/api/address.js: no scheme, no path.
    static func hostLabel(_ url: URL) -> String {
        var s = url.absoluteString
        if let r = s.range(of: "://") { s = String(s[r.upperBound...]) }
        if let slash = s.firstIndex(of: "/") { s = String(s[..<slash]) }
        return s
    }

    /// ChangePassword.submit in web/src/App.jsx.
    static func newPasswordError(_ pw: String, again: String) -> String? {
        if pw.count < 8 { return L("Use 8 characters or more.") }
        if pw != again { return L("The two passwords differ.") }
        return nil
    }

    /// The text the web shows for a failed call (`${status}: ${error}`, or "You’re offline").
    static func message(for error: Error) -> String {
        switch error {
        case APIError.offline: return L("You’re offline")
        case APIError.http(let status, let msg): return msg.isEmpty ? "\(status)" : "\(status): \(String(msg.prefix(180)))"
        case APIError.unauthorized: return "401: unauthorized"
        case APIError.passwordChangeRequired: return "403: password change required"
        default: return error.localizedDescription
        }
    }

    /// An invite link (`<base>/?invite=<code>`): the server it came from and the code.
    static func invite(from url: URL) -> (base: URL, code: String)? {
        guard let c = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let code = c.queryItems?.first(where: { $0.name == "invite" })?.value, !code.isEmpty,
              let scheme = c.scheme, let host = c.host,
              let base = Address.normalise("\(scheme)://\(host)\(c.port.map { ":\($0)" } ?? "")") else { return nil }
        return (base, code)
    }
}
