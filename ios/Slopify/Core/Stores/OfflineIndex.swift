import Foundation

/// What a downloaded collection is (web offline/store.js `kind`). Liked Songs uses `likedId`.
enum OfflineKind: String, Codable, Sendable { case playlist, album, liked }

/// A saved playlist / album / Liked Songs: which songs it holds, in order.
struct OfflineCollection: Codable, Hashable, Identifiable, Sendable {
    var id: String
    var name: String
    var kind: OfflineKind
    var trackIds: [String]
    /// Epoch ms.
    var added: Double
}

/// One song as kept on this device. Downloaded = has `file` (a name in the files folder).
struct OfflineTrack: Codable, Hashable, Sendable {
    var track: Track
    /// The quality it was saved at: `original` or an AAC profile (`aac-320`...). Saving again at
    /// another quality downloads it again.
    var q: String
    /// Gain baked into the AAC file: `track`, `album` or none.
    var norm: String?
    var file: String?
    var bytes: Int64 = 0
}

/// A play the server could not be told about; sent later with `client: "offline"`.
struct OfflinePlay: Codable, Hashable, Sendable {
    var id: String
    var at: Double
}

/// `{have}/{total}` of one collection.
struct OfflineSummary: Hashable, Sendable {
    var have: Int
    var total: Int
}

/// The running download of one collection (web store.js `active`).
struct OfflineProgress: Hashable, Sendable {
    var id: String
    var name: String
    var done: Int
    var total: Int
    var failed: Int
}

/// One account's offline library as plain data (web store.js upsert / remove / summary), kept
/// apart from the store so the rules are tested without files or a network.
struct OfflineIndex: Codable, Equatable, Sendable {
    var collections: [OfflineCollection] = []
    var tracks: [String: OfflineTrack] = [:]
    var plays: [OfflinePlay] = []

    static let likedId = "__liked__"

    /// Adds or replaces a collection (new ones first); returns the ids still to download.
    /// A song kept at another quality loses its file, so it downloads again.
    @discardableResult
    mutating func upsert(_ col: OfflineCollection, songs: [OfflineTrack]) -> (missing: [String], replaced: [String]) {
        var col = col
        col.trackIds = Self.unique(songs.map(\.track.id))
        if let at = collections.firstIndex(where: { $0.id == col.id }) { collections[at] = col } else { collections.insert(col, at: 0) }
        var replaced: [String] = []
        for s in songs {
            let was = tracks[s.track.id]
            let same = was?.file != nil && was?.q == s.q
            if let f = was?.file, !same { replaced.append(f) }
            tracks[s.track.id] = OfflineTrack(track: s.track, q: same ? was!.q : s.q, norm: same ? was!.norm : s.norm,
                                              file: same ? was!.file : nil, bytes: same ? was!.bytes : 0)
        }
        return (col.trackIds.filter { tracks[$0]?.file == nil }, replaced)
    }

    /// Drops a collection and the songs no other collection holds; returns their file names.
    mutating func remove(_ id: String) -> [String] {
        guard let col = collections.first(where: { $0.id == id }) else { return [] }
        collections.removeAll { $0.id == id }
        let kept = Set(collections.flatMap(\.trackIds))
        var files: [String] = []
        for t in col.trackIds where !kept.contains(t) {
            if let f = tracks[t]?.file { files.append(f) }
            tracks[t] = nil
        }
        return files
    }

    func summary(_ id: String) -> OfflineSummary? {
        guard let c = collections.first(where: { $0.id == id }) else { return nil }
        return OfflineSummary(have: c.trackIds.filter { tracks[$0]?.file != nil }.count, total: c.trackIds.count)
    }

    func collection(_ id: String) -> OfflineCollection? { collections.first { $0.id == id } }

    var downloadedIds: Set<String> { Set(tracks.compactMap { $0.value.file == nil ? nil : $0.key }) }
    var files: Set<String> { Set(tracks.values.compactMap(\.file)) }
    var bytes: Int64 { tracks.values.reduce(0) { $0 + $1.bytes } }

    /// A collection's downloaded songs in its order (a page that cannot load offline).
    func downloadedTracks(of id: String) -> [Track] {
        (collection(id)?.trackIds ?? []).compactMap { tracks[$0]?.file == nil ? nil : tracks[$0]?.track }
    }

    /// `searchOffline`: downloaded songs whose title, artist or album holds every typed word,
    /// accents folded, at most 50.
    func search(_ q: String) -> [Track] {
        let words = Self.fold(q).split(whereSeparator: \.isWhitespace).map(String.init)
        guard !words.isEmpty else { return [] }
        return tracks.values
            .filter { $0.file != nil }
            .map(\.track)
            .sorted { ($0.title, $0.id) < ($1.title, $1.id) }
            .filter { t in
                let hay = Self.fold("\(t.title) \(TrackRowArtist.line(t)) \(t.album)")
                return words.allSatisfy { hay.contains($0) }
            }
            .prefix(50).map { $0 }
    }

    static func fold(_ s: String) -> String {
        s.folding(options: [.diacriticInsensitive, .caseInsensitive, .widthInsensitive], locale: nil).lowercased()
    }

    private static func unique(_ ids: [String]) -> [String] {
        var seen = Set<String>()
        return ids.filter { seen.insert($0).inserted }
    }
}

/// The artist line the web keeps per song (`Artists.join(', ') || AlbumArtist`).
private enum TrackRowArtist {
    static func line(_ t: Track) -> String {
        let names = t.artists.filter { !$0.isEmpty }
        return names.isEmpty ? (t.albumArtist.isEmpty ? t.artist : t.albumArtist) : names.joined(separator: ", ")
    }
}

/// Pure rules of the download button and offline playback (Library.jsx:1256-1349, usePlayer.js).
enum OfflineRules {
    /// The glyph: busy while this collection downloads; done once every song of the page is
    /// here; part when some are; none when nothing is held.
    static func glyph(held: OfflineSummary?, busy: OfflineProgress?, pageTotal: Int) -> DownloadGlyph.State {
        if let busy { return .busy(progress: busy.total > 0 ? Double(busy.done) / Double(busy.total) : 0) }
        guard let held else { return .none }
        return held.have >= pageTotal ? .done : .part
    }

    /// `{have}/{total}` under the button (busy or part), nil otherwise.
    static func countLabel(held: OfflineSummary?, busy: OfflineProgress?, pageTotal: Int) -> String? {
        if let busy { return "\(busy.done)/\(busy.total)" }
        guard let held, held.have < pageTotal else { return nil }
        return "\(held.have)/\(pageTotal)"
    }

    /// Accessibility label (keys from Library.jsx:1338).
    static func label(held: OfflineSummary?, busy: OfflineProgress?, pageTotal: Int) -> String {
        if let busy { return L("Downloading {have} of {total}", ["have": busy.done, "total": busy.total]) }
        guard let held else { return L("Download for offline") }
        return held.have >= pageTotal ? L("Downloaded") : L("Downloaded {have} of {total}", ["have": held.have, "total": pageTotal])
    }

    /// What the player gets for a tap on row `index`: online, the list as it is; offline, the
    /// list filtered to downloaded songs, or nil when the tapped song is not downloaded.
    static func playable(_ tracks: [Track], at index: Int, offline: Bool, has: (String) -> Bool) -> (tracks: [Track], index: Int)? {
        guard tracks.indices.contains(index) else { return nil }
        guard offline else { return (tracks, index) }
        guard has(tracks[index].id) else { return nil }
        let before = tracks[..<index].filter { has($0.id) }.count
        return (tracks.filter { has($0.id) }, before)
    }

    /// A page's play button: offline it starts at the first downloaded song.
    static func playablePage(_ tracks: [Track], offline: Bool, has: (String) -> Bool) -> [Track]? {
        let list = offline ? tracks.filter { has($0.id) } : tracks
        return list.isEmpty ? nil : list
    }

    /// web `estimateBytes`: AAC 40 kB/s, lossless 120 kB/s of duration.
    static func estimateBytes(_ tracks: [Track], lossless: Bool) -> Double {
        tracks.reduce(0) { $0 + Double($1.durationMs) / 1000 * (lossless ? 120_000 : 40_000) }
    }

    /// What Safari (and AVPlayer) plays from the original file; anything else is saved as AAC.
    static func playsOriginal(_ t: Track) -> Bool {
        let c = (t.codec ?? t.format?.codec ?? "").lowercased()
        return c.range(of: "flac|layer 3|mp3|aac|alac|pcm|wav|aiff", options: .regularExpression) != nil
    }

    /// web `saveOffline`: Lossless keeps the original file (no gain baked in); otherwise AAC at
    /// the streaming profile with album gain for an album, track gain otherwise.
    static func plan(_ t: Track, kind: OfflineKind, prefs: [String: JSONValue], tablet: Bool) -> (q: String, norm: String?) {
        let quality = StreamPolicy.quality(prefs: prefs, tablet: tablet)
        if quality == "original" && playsOriginal(t) { return ("original", nil) }
        var profile = StreamPolicy.profile(forQuality: quality)
        if profile == "alac" { profile = "aac-320" }   // no whole file for lossless (API.md §12.5)
        let norm = StreamPolicy.normalize(prefs: prefs) ? (kind == .album ? "album" : "track") : nil
        return (profile, norm)
    }

    static func savesLossless(prefs: [String: JSONValue], tablet: Bool) -> Bool {
        StreamPolicy.quality(prefs: prefs, tablet: tablet) == "original"
    }

    /// The finish toast (App.jsx:1336-1338).
    static func finishedText(_ f: OfflineProgress) -> String {
        if f.failed > 0 {
            return L("{name}: {done} of {total} songs downloaded, {failed} failed (Update download to retry)",
                     ["name": f.name, "done": f.done, "total": f.total, "failed": f.failed])
        }
        return f.done == 1 ? L("{name} is ready offline (1 song)", ["name": f.name]) : L("{name} is ready offline ({n} songs)", ["name": f.name, "n": f.done])
    }
}
