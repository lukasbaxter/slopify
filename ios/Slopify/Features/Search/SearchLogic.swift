import Foundation

/// Pure rules of the search page (UI.md 6.2, web Library.jsx / api/search.js). No UI, no I/O.
enum SearchKind: String, Codable, Hashable, Sendable {
    case artist = "Artist", album = "Album", song = "Song", playlist = "Playlist"

    var label: String { L(rawValue) }
}

/// The chips (`SEARCH_TYPES`). Raw values are the i18n keys.
enum SearchType: String, CaseIterable, Hashable, Sendable {
    case all = "All", songs = "Songs", artists = "Artists", albums = "Albums", playlists = "Playlists", everywhere = "Everywhere"

    func shows(_ kind: SearchKind) -> Bool {
        switch self {
        case .all: true
        case .songs: kind == .song
        case .artists: kind == .artist
        case .albums: kind == .album
        case .playlists: kind == .playlist
        case .everywhere: false
        }
    }
}

/// One row of the phone result list.
enum SearchItem: Hashable, Sendable {
    case song(Track)
    case artist(Artist)
    case album(Album)
    case playlist(Playlist)

    var kind: SearchKind {
        switch self {
        case .song: .song
        case .artist: .artist
        case .album: .album
        case .playlist: .playlist
        }
    }

    var id: String {
        switch self {
        case .song(let t): t.id
        case .artist(let a): a.id
        case .album(let a): a.id
        case .playlist(let p): p.id
        }
    }

    var name: String {
        switch self {
        case .song(let t): t.title
        case .artist(let a): a.name
        case .album(let a): a.name
        case .playlist(let p): p.name
        }
    }

    /// `kind:id`, the de-duplication key of `phoneRows` and the recents.
    var key: String { "\(kind.rawValue):\(id)" }

    /// `subOf` (Library.jsx:1653-1656): "Kind • detail", empty parts dropped. Localised, including
    /// the "Song" prefix the web leaves in English (DECISIONS).
    var subtitle: String {
        switch self {
        case .artist: return L("Artist")
        case .playlist: return L("Playlist")
        case .album(let a):
            return [L("Album"), a.year.map(String.init) ?? "", a.artist].filter { !$0.isEmpty }.joined(separator: " • ")
        case .song(let t):
            return Self.songSubtitle(t)
        }
    }

    static func songSubtitle(_ t: Track) -> String {
        let names = t.artists.filter { !$0.isEmpty }.joined(separator: ", ")
        return [L("Song"), names.isEmpty ? t.albumArtist : names].filter { !$0.isEmpty }.joined(separator: " • ")
    }
}

/// A finished search: the server lists, the matching playlists and the client-picked top result.
struct SearchPage: Sendable {
    var query: String
    var tracks: [Track]
    var albums: [Album]
    var artists: [Artist]
    var playlists: [Playlist]
    var top: SearchItem?

    init(query: String, results: SearchResults, playlists: [Playlist]) {
        self.query = query
        tracks = results.tracks; albums = results.albums; artists = results.artists
        let q = query.lowercased()
        self.playlists = playlists.filter { $0.name.lowercased().contains(q) }
        top = SearchLogic.topResult(query: query, results: results)
    }
}

enum SearchLogic {
    /// NFKC + lowercase (api/search.js `norm`).
    static func norm(_ s: String) -> String { s.precomposedStringWithCompatibilityMapping.lowercased() }

    /// api/search.js: artist that starts with the query, else album, else song, else the first
    /// artist / album / song.
    static func topResult(query: String, results r: SearchResults) -> SearchItem? {
        let q = norm(query.trimmingCharacters(in: .whitespacesAndNewlines))
        if let a = r.artists.first, norm(a.name).hasPrefix(q) { return .artist(a) }
        if let a = r.albums.first, norm(a.name).hasPrefix(q) { return .album(a) }
        if let t = r.tracks.first, norm(t.title).hasPrefix(q) { return .song(t) }
        if let a = r.artists.first { return .artist(a) }
        if let a = r.albums.first { return .album(a) }
        if let t = r.tracks.first { return .song(t) }
        return nil
    }

    /// `phoneRows` (Library.jsx:1687-1706): top result, 4 songs, 2 artists, 2 albums, 1 playlist,
    /// then the rest of each list; duplicates by `kind:id` skipped.
    static func phoneRows(_ p: SearchPage, type: SearchType) -> [SearchItem] {
        guard type != .everywhere else { return [] }
        var rows: [SearchItem] = [], seen = Set<String>()
        func push(_ it: SearchItem) { if seen.insert(it.key).inserted { rows.append(it) } }
        let songs = type.shows(.song) ? p.tracks.map(SearchItem.song) : []
        let artists = type.shows(.artist) ? p.artists.map(SearchItem.artist) : []
        let albums = type.shows(.album) ? p.albums.map(SearchItem.album) : []
        let playlists = type.shows(.playlist) ? p.playlists.map(SearchItem.playlist) : []
        if let top = p.top, type.shows(top.kind) { push(top) }
        songs.prefix(4).forEach(push); artists.prefix(2).forEach(push)
        albums.prefix(2).forEach(push); playlists.prefix(1).forEach(push)
        (songs + artists + albums + playlists).forEach(push)
        return rows
    }

    /// Browse tile colour when the server sends none (`TILE_COLORS[i % 16]`).
    static func tileColor(_ index: Int) -> RGB { Theme.Fixed.browseTiles[index % Theme.Fixed.browseTiles.count] }

    /// Home's `rankTopArtists`: 1 + plays per credited artist, highest first.
    static func topArtistIds(_ tracks: [Track]) -> [String] {
        var score: [String: Int] = [:], order: [String] = []
        for t in tracks {
            for id in t.artistIds where !id.isEmpty {
                if score[id] == nil { order.append(id) }
                score[id, default: 0] += 1 + (t.plays ?? 0)
            }
        }
        // Stable like JS sort: ties keep first-seen order.
        return order.enumerated().sorted { a, b in
            let x = score[a.element]!, y = score[b.element]!
            return x != y ? x > y : a.offset < b.offset
        }.map(\.element)
    }
}

// MARK: - Recent searches (prefs `recentSearches`, UI.md 6.2.6)

struct SearchRecent: Codable, Hashable, Sendable {
    var q: String
    var kind: SearchKind
    var id: String
    /// Album id for songs, else the item id.
    var art: String?
    var name: String
    var sub: String

    var key: String { "\(kind.rawValue):\(id)" }
    /// The stored line, else the kind label.
    var subtitle: String { sub.isEmpty ? kind.label : sub }

    init(q: String, kind: SearchKind, id: String, art: String?, name: String, sub: String) {
        self.q = q; self.kind = kind; self.id = id; self.art = art; self.name = name; self.sub = sub
    }

    /// `remember(q, hit)`: what was opened from a result.
    init(query: String, item: SearchItem) {
        let art: String? = if case .song(let t) = item { t.albumId.isEmpty ? t.id : t.albumId } else { item.id }
        self.init(q: query.trimmingCharacters(in: .whitespacesAndNewlines), kind: item.kind, id: item.id, art: art, name: item.name, sub: item.subtitle)
    }

    init?(_ v: JSONValue) {
        guard let o = v.object, let id = o["id"]?.string, !id.isEmpty,
              let kind = o["kind"]?.string.flatMap(SearchKind.init(rawValue:)) else { return nil }
        self.init(q: o["q"]?.string ?? "", kind: kind, id: id, art: o["art"]?.string, name: o["name"]?.string ?? "", sub: o["sub"]?.string ?? "")
    }

    var json: JSONValue {
        .object(["q": .string(q), "kind": .string(kind.rawValue), "id": .string(id),
                 "art": art.map(JSONValue.string) ?? .null, "name": .string(name), "sub": .string(sub)])
    }

    /// Entries from prefs; old string entries and junk are ignored (Library.jsx:220-223).
    static func list(_ v: JSONValue?) -> [SearchRecent] { (v?.array ?? []).compactMap(SearchRecent.init) }

    /// Newest first, unique by `kind:id`, at most 10.
    static func adding(_ e: SearchRecent, to list: [SearchRecent]) -> [SearchRecent] {
        Array(([e] + list.filter { $0.key != e.key }).prefix(10))
    }

    static func removing(_ e: SearchRecent, from list: [SearchRecent]) -> [SearchRecent] { list.filter { $0.key != e.key } }

    static func json(_ list: [SearchRecent]) -> JSONValue { .array(list.map(\.json)) }
}

// MARK: - Release requests (UI.md 6.0.7)

enum SearchRequestState {
    static let pending: Set<String> = ["queued", "exists", "downloading"]

    /// `stateOf`: the server's state wins once it reports progress; until then the tap's own.
    static func state(server: String?, mine: String?) -> String? {
        if let mine, server == nil || server == "failed" { return mine }
        return server ?? mine
    }

    /// `requestUi`: label and busy flag.
    static func ui(_ st: String?) -> (label: String, busy: Bool) {
        let label: String = switch st {
        case "queued", "exists": L("Requested")
        case "downloading": L("Downloading…")
        case "failed": L("Retry")
        case "error": L("Failed")
        default: L("Request")
        }
        return (label, st.map(pending.contains) ?? false)
    }
}
