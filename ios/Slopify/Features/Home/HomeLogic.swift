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

    enum Section: Hashable, Sendable { case shortcuts, madeForYou, stations, topMixes, jumpBackIn, radar, topArtists, topSongs }

    enum Shortcut: Hashable, Identifiable, Sendable {
        case liked
        case album(Album)
        case playlist(Playlist)
        case artist(RankedArtist)
        var id: String {
            switch self {
            case .liked: "__liked__"
            case .album(let a): "al:" + a.id
            case .playlist(let p): "pl:" + p.id
            case .artist(let a): "ar:" + a.id
            }
        }
        /// The bare id, as the web compares them across kinds.
        var itemId: String? {
            switch self {
            case .liked: nil
            case .album(let a): a.id
            case .playlist(let p): p.id
            case .artist(let a): a.id
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

    /// Home.jsx `shortcuts`: Liked Songs first, then the latest album, playlist and artist the
    /// listener picked and played from (never what autoplay went on to), then (a new account)
    /// playlists and library albums not yet there; 8 max.
    static func shortcuts(picks: [HomePick], playlists: [Playlist], albums: [Album]) -> [Shortcut] {
        var out: [Shortcut] = [.liked]
        func add(_ s: Shortcut) {
            guard out.count < 8, let id = s.itemId, !id.isEmpty, !out.contains(where: { $0.itemId == id }) else { return }
            out.append(s)
        }
        for p in picks {
            switch p.kind {
            case "playlist":
                add(.playlist(playlists.first { $0.id == p.id }
                    ?? Playlist(id: p.id, name: p.name, userId: p.userId, created: nil, updated: nil, trackCount: p.trackCount, cover: p.cover, aiPrompt: p.aiPrompt)))
            case "artist": add(.artist(RankedArtist(id: p.id, name: p.name, image: p.image)))
            case "album":
                add(.album(Album(id: p.id, name: p.name, artist: p.artist ?? "", artistId: p.artistId, year: p.year, trackCount: p.trackCount,
                                 durationMs: nil, cover: p.cover, addedAt: nil, likedAt: nil)))
            default: break
            }
        }
        for p in playlists { add(.playlist(p)) }
        for a in albums { add(.album(a)) }
        return out
    }

    /// Spotify's mix subtitle, "A, B, C and more", from who is in a mix or radio (§14.1); nil without names.
    static func mixSub(_ artists: [MixArtist]?) -> String? {
        let names = (artists ?? []).map(\.name).filter { !$0.isEmpty }
        return names.isEmpty ? nil : L("{name} and more", ["name": names.joined(separator: ", ")])
    }

    /// A Recommended Stations tile's subtitle: "With A, B and more"; nil without names.
    static func stationSub(_ with: [MixArtist]?) -> String? {
        let names = (with ?? []).map(\.name).filter { !$0.isEmpty }
        return names.isEmpty ? nil : L("With {name} and more", ["name": names.joined(separator: ", ")])
    }

    /// What a Home mix tile shows. A drawn tile (the server drew the whole picture: Daily Mix,
    /// station, top mix) is the picture as is, no band over it and no title under it, only the sub.
    struct MixTile: Equatable, Sendable {
        var image: CoverSource?
        /// The label on the colour band over the picture; nil: no band.
        var band: String?
        /// The title line under the picture; nil: none.
        var title: String?
        var sub: String?
        var drawn: Bool { band == nil && title == nil }
    }

    /// A Daily Mix tile: the server's drawn `art` when it sent one, else today's look (photo,
    /// band and title "Daily Mix {n}").
    static func dailyMixTile(label: String, sub: String?, art: String?, photo: CoverSource) -> MixTile {
        if let art, !art.isEmpty { return MixTile(image: .drawn(id: art), band: nil, title: nil, sub: sub) }
        return MixTile(image: photo, band: label, title: label, sub: sub)
    }

    static func stationTile(_ s: HomeStation) -> MixTile {
        MixTile(image: s.art.map { .drawn(id: $0) }, band: nil, title: nil, sub: stationSub(s.with))
    }

    static func topMixTile(_ m: HomeTopMix) -> MixTile {
        MixTile(image: m.art.map { .drawn(id: $0) }, band: nil, title: nil, sub: mixSub(m.artists))
    }

    /// A tile colour the server sent ("#rrggbb"), else the mix palette's first.
    static func color(_ hex: String?) -> RGB { hex.flatMap { RGB(hex: $0) } ?? Theme.Fixed.mixPalette[0] }

    /// The player context of one of Your top mixes (the web's `topmix:<genre>`).
    static func topMixContext(_ genre: String) -> String { "topmix:\(genre)" }

    /// A Daily Mix tile's (and its page's) subtitle: today's artists (§14.3), else the seed alone.
    static func dailyMixSub(seedName: String, summary: DailyMixSummary?) -> String? {
        mixSub(summary?.artists) ?? (seedName.isEmpty ? nil : L("{name} and more", ["name": seedName]))
    }

    /// Daily Mix seeds: the first 6 top artists, or the first 6 library artists without plays.
    static func mixSeeds(topArtists: [RankedArtist], libraryArtists: [Artist]) -> [RankedArtist] {
        if !topArtists.isEmpty { return Array(topArtists.prefix(6)) }
        return libraryArtists.prefix(6).map { RankedArtist(id: $0.id, name: $0.name, image: $0.image) }
    }

    struct Counts: Sendable {
        var mixes = 0, stations = 0, topMixes = 0, years = 0, recentArtists = 0, radar = 0, topArtists = 0
    }

    /// Which sections show, in the web's order (UI.md 6.1.3): shortcuts, Made For You,
    /// Recommended Stations, Your top mixes, Jump back in, Release Radar, Your top artists, Your
    /// Top Songs. No Recently played (the shortcuts are what was played last). Made For You hides
    /// without mixes (DECISIONS: web bug fixed).
    static func sections(filter: Filter, counts c: Counts) -> [Section] {
        let music = filter != .artists, artists = filter != .music
        var out: [Section] = []
        if music { out.append(.shortcuts) }
        if music && c.mixes > 0 { out.append(.madeForYou) }
        if music && c.stations > 0 { out.append(.stations) }
        if music && c.topMixes > 0 { out.append(.topMixes) }
        if artists && c.recentArtists > 0 { out.append(.jumpBackIn) }
        if music && c.radar > 0 { out.append(.radar) }
        if artists && c.topArtists > 0 { out.append(.topArtists) }
        if music && c.years > 0 { out.append(.topSongs) }
        return out
    }

    /// `MIX_COLORS[i % 8]` (and `TOP_COLORS[i % 8]`: both palettes have 8).
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

    /// Home's shelf: only releases in the library (the server fetches the rest; they show once
    /// they land), 16 at most.
    static func radarShelf(_ all: [Release]) -> [Release] { Array(all.filter { $0.inLibrary != nil }.prefix(16)) }

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
