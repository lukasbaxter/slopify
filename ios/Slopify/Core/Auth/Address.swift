import Foundation

/// Typed server address handling (API.md §4.1), same rules as web/src/api/address.js.
enum Address {
    /// Candidate URLs to try, best guess first. Empty when the input cannot be an address.
    static func candidates(_ raw: String) -> [URL] {
        let s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return [] }
        if s.contains("://") { return [normalise(s)].compactMap { $0 } }
        let host = s.split(separator: "/").first.map(String.init) ?? s
        let bareHost = host.split(separator: ":").first.map(String.init) ?? host
        let http = isLocal(bareHost)
        let first = normalise((http ? "http://" : "https://") + s)
        let second = normalise((http ? "https://" : "http://") + s)
        return [first, second].compactMap { $0 }
    }

    static func normalise(_ s: String) -> URL? {
        guard var c = URLComponents(string: s), let scheme = c.scheme?.lowercased(), ["http", "https"].contains(scheme), let host = c.host, !host.isEmpty,
              host.range(of: #"^[A-Za-z0-9.-]+$|^\[[0-9A-Fa-f:.]+\]$"#, options: .regularExpression) != nil,
              !host.hasPrefix("."), !host.hasPrefix("-"), !host.hasSuffix("."), !host.hasSuffix("-") else { return nil }
        c.scheme = scheme
        c.host = host.lowercased()
        if (scheme == "http" && c.port == 80) || (scheme == "https" && c.port == 443) { c.port = nil }
        c.query = nil; c.fragment = nil
        while c.path.hasSuffix("/") { c.path.removeLast() }
        return c.url
    }

    /// Bare IPv4, *.local, or a one-word host: plain http by default.
    static func isLocal(_ host: String) -> Bool {
        let h = host.lowercased()
        if h.hasSuffix(".local") || !h.contains(".") { return true }
        let parts = h.split(separator: ".")
        return parts.count == 4 && parts.allSatisfy { UInt8($0) != nil }
    }

    /// LAN-only addresses are pointless on cellular (§4.4 step 2). Tailscale 100.x is not LAN-only.
    static func isLANOnly(_ url: URL) -> Bool {
        guard let h = url.host?.lowercased() else { return false }
        if h.hasSuffix(".local") || !h.contains(".") { return true }
        let p = h.split(separator: ".").compactMap { Int($0) }
        guard p.count == 4 else { return false }
        return p[0] == 10 || (p[0] == 172 && (16...31).contains(p[1])) || (p[0] == 192 && p[1] == 168) || p[0] == 127 || (p[0] == 169 && p[1] == 254)
    }

    static func origin(_ url: URL) -> String {
        var c = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        c.path = ""; c.query = nil; c.fragment = nil
        return c.string ?? url.absoluteString
    }
}
