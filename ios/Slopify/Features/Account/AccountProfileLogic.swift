import Foundation

/// Profile page data (web App.jsx:938-955 `openProfile`, UI.md 7.4.4).
enum AccountProfileLogic {
    struct TopArtist: Equatable, Identifiable {
        var id: String
        var name: String
        var score: Int
    }

    /// Artists of the top tracks, each scored `sum(1 + playCount)`, best 16. Ties keep first-seen order.
    static func topArtists(_ tracks: [Track], limit: Int = 16) -> [TopArtist] {
        var order: [String] = []
        var by: [String: TopArtist] = [:]
        for t in tracks {
            let w = 1 + (t.plays ?? 0)
            for (name, id) in t.artistCredits {
                guard let id, !id.isEmpty else { continue }
                if by[id] == nil { order.append(id); by[id] = TopArtist(id: id, name: name, score: 0) }
                by[id]!.score += w
            }
        }
        let ranked = order.enumerated().sorted { a, b in
            let x = by[a.element]!.score, y = by[b.element]!.score
            return x != y ? x > y : a.offset < b.offset
        }
        return ranked.prefix(limit).map { by[$0.element]! }
    }

    /// `'1 public playlist'` / `'{n} public playlists'`.
    static func playlistCount(_ n: Int) -> String {
        n == 1 ? L("1 public playlist") : L("{n} public playlists", ["n": n])
    }

    /// First letter, uppercased, or "?".
    static func initial(_ name: String?) -> String {
        guard let c = name?.first else { return "?" }
        return String(c).uppercased()
    }
}
