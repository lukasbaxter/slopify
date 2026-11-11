import Foundation

/// The ids sent in `hello` (API.md §20.3, §2).
enum SocketIdentity {
    static let defaultsKey = "slopify.clientId"
    /// Random per process launch: lets the server tell a reconnect from a second copy.
    static let instance = "i_" + random(16)

    /// Persisted per install. A stored value that does not match the server's rule is replaced.
    static func clientId(_ defaults: UserDefaults = .standard) -> String {
        if let id = defaults.string(forKey: defaultsKey), isValid(id) { return id }
        let id = "c_" + random(16)
        defaults.set(id, forKey: defaultsKey)
        return id
    }

    /// `^[\w-]{4,64}$`, never `server:*` (the colon already fails the pattern).
    static func isValid(_ id: String) -> Bool {
        guard (4...64).contains(id.count) else { return false }
        return id.unicodeScalars.allSatisfy { $0 == "_" || $0 == "-" || ($0.isASCII && CharacterSet.alphanumerics.contains($0)) }
    }

    static func random(_ n: Int) -> String {
        let chars = Array("abcdefghijklmnopqrstuvwxyz0123456789")
        return String((0..<n).map { _ in chars.randomElement()! })
    }

    /// ws/wss + /api/ws, same rule as `APIClient.webSocketURL`.
    static func webSocketURL(base: URL) -> URL {
        var c = URLComponents(url: base.appendingPathComponent("api/ws"), resolvingAgainstBaseURL: false)!
        c.scheme = c.scheme == "https" ? "wss" : "ws"
        return c.url!
    }
}
