import CryptoKit
import Foundation

/// Proves a home (LAN) address is really this server before any token goes to it (API.md §4.3).
enum HomeProof {
    static func nonce() -> String {
        (0..<16).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
    }

    static func expected(keyHex: String, nonce: String) -> String? {
        guard let key = Data(hex: keyHex) else { return nil }
        let mac = HMAC<SHA256>.authenticationCode(for: Data(nonce.utf8), using: SymmetricKey(data: key))
        return Data(mac).map { String(format: "%02x", $0) }.joined()
    }

    static func verify(keyHex: String, nonce: String, proof: String) -> Bool {
        guard let want = expected(keyHex: keyHex, nonce: nonce), want.count == proof.count else { return false }
        // constant time
        return zip(want.utf8, proof.lowercased().utf8).reduce(0) { $0 | ($1.0 ^ $1.1) } == 0
    }

    /// Asks `home` for a proof. No token is sent. Short timeout: this runs on every network change.
    static func check(home: URL, userId: String, keyHex: String, timeout: TimeInterval) async -> Bool {
        let n = nonce()
        var c = URLComponents(url: home.appendingPathComponent("api/server/proof"), resolvingAgainstBaseURL: false)!
        c.queryItems = [URLQueryItem(name: "u", value: userId), URLQueryItem(name: "n", value: n)]
        var req = URLRequest(url: c.url!, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        req.httpMethod = "GET"
        struct R: Decodable { var proof: String }
        guard let (data, resp) = try? await URLSession.shared.data(for: req),
              (resp as? HTTPURLResponse)?.statusCode == 200,
              let r = try? JSONDecoder().decode(R.self, from: data) else { return false }
        return verify(keyHex: keyHex, nonce: n, proof: r.proof)
    }
}

extension Data {
    init?(hex: String) {
        guard hex.count % 2 == 0 else { return nil }
        var d = Data(capacity: hex.count / 2)
        var i = hex.startIndex
        while i < hex.endIndex {
            let j = hex.index(i, offsetBy: 2)
            guard let b = UInt8(hex[i..<j], radix: 16) else { return nil }
            d.append(b); i = j
        }
        self = d
    }
}
