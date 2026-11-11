import Foundation

/// Pure Home rules, ported from web/src/components/Home.jsx and Library.jsx (UI.md 6.1, 6.3).
enum HomeLogic {
    /// An artist as Home ranks it (from the user's top tracks) or as the library lists it.
    struct RankedArtist: Codable, Hashable, Identifiable, Sendable {
        var id: String
        var name: String
        /// `Artist.image` hash when it came from the library list.
        var image: String?
        /// Ranking score (`1 + plays` per track) or, for recentArtists, unused.
        var score: Int = 0
    }

    enum Filter: String, CaseIterable, Sendable { case all, music, artists }

    enum Section: Hashable, Sendable { case shortcuts, madeForYou, topSongs, recent, jumpBackIn, radar, topArtists }

    enum Shortcut: Hashable, Identifiable, Sendable {
        case liked
        case album(Album)
        case playlist(Playlist)
        var id: String {
            switch self {
            case .liked: "__liked__"
            case .album(let a): "al:" + a.id
            case .playlist(let p): "pl:" + p.id
            }
        }
    }

    /// Home.jsx `rankTopArtists`: every artist on every track scores `1 + plays`; most first.
    /// Ties keep first-seen order (JS sort is stable, Map keeps insertion order).
    static func rankTopArtists(_ tracks: [Track]) -> [RankedArtist] {
        var order: [String] = []
        var map: [String: RankedArtist] = [:]
        for t in tracks {
            for (name, id) in t.artistCredits {
                guard let id, !id.isEmpty else { continue }
                if map[id] == nil { order.append(id); map[id] = RankedArtist(id: id, name: name) }
                map[id]!.score += 1 + (t.plays ?? 0)
            }
        }
        var ranked: [(i: Int, a: RankedArtist)] = []
        for (i, id) in order.enumerated() {
            if let a = map[id] { ranked.append((i: i, a: a)) }
        }
        ranked.sort { (x, y) -> Bool in
            if x.a.score != y.a.score { return x.a.score > y.a.score }
            return x.i < y.i
        }
        return ranked.map { $0.a }
    }

    /// Home.jsx `recentArtists`: latest last-played date per artist, newest first, 16.
    /// An artist only counts once a track has a date (`'' > ''` is false in the web).
    static func recentArtists(_ tracks: [Track], lastPlayed: (Track) -> String?) -> [RankedArtist] {
        var order: [String] = []
        var map: [String: (a: RankedArtist, lp: String)] = [:]
        for t in tracks {
            let lp = lastPlayed(t) ?? ""
            for (name, id) in t.artistCredits {
                guard let id, !id.isEmpty else { continue }
                if lp > (map[id]?.lp ?? "") {
                    if map[id] == nil { order.append(id) }
                    map[id] = (RankedArtist(id: id, name: name), lp)
                }
            }
        }
        var ranked: [(i: Int, a: RankedArtist, lp: String)] = []
        for (i, id) in order.enumerated() {
            guard let e = map[id] else { continue }
            ranked.append((i: i, a: e.a, lp: e.lp))
        }
        ranked.sort { (x, y) -> Bool in
            if x.lp != y.lp { return x.lp > y.lp }
            return x.i < y.i
        }
        return ranked.prefix(16).map { $0.a }
    }

    private static let tileInner = try! NSRegularExpression(
        pattern: #"\s*[(\[](?:feat|ft|with|featuring|radio edit|remaster|remastered|deluxe|version|edit|mix|live|bonus)[^)\]]*[)\]]"#,
        options: [.caseInsensitive])
    private static let tileTail = try! NSRegularExpression(
        pattern: #"\s+[-–]\s+(?:\d{4}\s+)?(?:remaster|remastered|radio edit|single version|deluxe|live|edit|version|mix).*$"#,
        options: [.caseInsensitive])

    /// Home.jsx `tileTitle`: shortcut labels drop "(feat. …)", "- Remaster" style suffixes.
    static func tileTitle(_ name: String) -> String {
        var s = name
        s = tileInner.stringByReplacingMatches(in: s, range: NSRange(s.startIndex..., in: s), withTemplate: "")
        // JS `$` without the m flag is end of input, like NSRegularExpression's default.
        if let m = tileTail.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)), let r = Range(m.range, in: s) {
            s.removeSubrange(r)
        }
        let out = s.trimmingCharacters(in: .whitespacesAndNewlines)
        return out.isEmpty ? name : out
    }

    /// Liked Songs first, then recent albums, playlists, then library albums not yet there; 8 max.
    static func shortcuts(recent: [Album], playlists: [Playlist], albums: [Album]) -> [Shortcut] {
        var out: [Shortcut] = [.liked]
        for a in recent { if out.count >= 8 { break }; out.append(.album(a)) }
        for p in playlists { if out.count >= 8 { break }; out.append(.playlist(p)) }
        for a in albums {
            if out.count >= 8 { break }
            // The web compares bare ids across kinds (`o.item?.Id === a.Id`).
            let taken = out.contains {
                switch $0 { case .album(let x): x.id == a.id; case .playlist(let p): p.id == a.id; case .liked: false }
            }
            if !taken { out.append(.album(a)) }
        }
        return out
    }

    /// Daily Mix seeds: the first 6 top artists, or the first 6 library artists without plays.
    static func mixSeeds(topArtists: [RankedArtist], libraryArtists: [Artist]) -> [RankedArtist] {
        if !topArtists.isEmpty { return Array(topArtists.prefix(6)) }
        return libraryArtists.prefix(6).map { RankedArtist(id: $0.id, name: $0.name, image: $0.image) }
    }

    struct Counts: Sendable {
        var mixes = 0, years = 0, recent = 0, recentArtists = 0, radar = 0, topArtists = 0
    }

    /// Which sections show, in the web's order (UI.md 6.1.3). Made For You hides without mixes
    /// (DECISIONS: web bug fixed).
    static func sections(filter: Filter, counts c: Counts) -> [Section] {
        let music = filter != .artists, artists = filter != .music
        var out: [Section] = []
        if music { out.append(.shortcuts) }
        if music && c.mixes > 0 { out.append(.madeForYou) }
        if music && c.years > 0 { out.append(.topSongs) }
        if music && c.recent > 0 { out.append(.recent) }
        if artists && c.recentArtists > 0 { out.append(.jumpBackIn) }
        if music && c.radar > 0 { out.append(.radar) }
        if artists && c.topArtists > 0 { out.append(.topArtists) }
        return out
    }

    /// `MIX_COLORS[i % 8]`.
    static func mixColorIndex(_ i: Int) -> Int { ((i % 8) + 8) % 8 }

    /// Home.jsx `topSongsSub`.
    static func topSongsSub(_ year: Int, currentYear: Int) -> String {
        year == currentYear ? L("Your most played songs of {year} so far", ["year": year])
                            : L("The songs you played most in {year}", ["year": year])
    }

    /// Library.jsx `fmtTotalShort`: "3h 7min", "9min 39sec". `ms` total duration.
    static func totalShort(ms: Int) -> String {
        let s = Int((Double(ms) / 1000).rounded(.toNearestOrAwayFromZero))
        let h = s / 3600, m = (s % 3600) / 60, sec = s % 60
        return h > 0 ? L("{h}h {m}min", ["h": h, "m": m]) : L("{m}min {sec}sec", ["m": m, "sec": sec])
    }

    /// Mix hero stats: "{sub} • {duration}", the duration only once there is one.
    static func mixStats(sub: String?, totalMs: Int) -> String {
        [sub, totalMs > 0 ? totalShort(ms: totalMs) : nil].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " • ")
    }

    // MARK: Release Radar

    /// Home shelf subtitle: "{artistName} • {t(rtype) or t('Album')}".
    static func radarShelfSub(_ r: Release) -> String {
        "\(r.artistName ?? "") • \(r.rtype.map { L($0) } ?? L("Album"))"
    }

    /// Radar page, owned card: "{artistName} • {date}".
    static func radarOwnedSub(_ r: Release) -> String {
        [r.artistName, r.date].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " • ")
    }

    /// Radar page, missing card, after the artist link: " • {t(rtype)} • {date}". Empty parts are
    /// skipped (the web prints a double bullet when rtype is missing).
    static func radarMissingTail(_ r: Release) -> String {
        [r.rtype.map { L($0) }, r.date].compactMap { $0 }.filter { !$0.isEmpty }.map { " • " + $0 }.joined()
    }

    /// Library.jsx `stateOf`: the server state wins once it reports progress; until then the tap's own.
    static func requestState(server: String?, mine: String?) -> String? {
        if let mine, server == nil || server == "failed" { return mine }
        return server ?? mine
    }

    /// Library.jsx `requestUi`.
    static func requestUI(_ state: String?) -> (label: String, busy: Bool) {
        switch state {
        case "queued", "exists": (L("Requested"), true)
        case "downloading": (L("Downloading…"), true)
        case "failed": (L("Retry"), false)
        case "error": (L("Failed"), false)
        default: (L("Request"), false)
        }
    }
}
