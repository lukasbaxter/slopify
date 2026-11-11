import Foundation

/// Text and list maths for the library screens (Sidebar.jsx, Library.jsx), kept pure for tests.
enum LibraryText {
    /// ` • ` (U+2022 with spaces).
    static let dot = " \u{2022} "

    /// Library row subtitle without the pin / download mark (UI.md 5.2.8).
    static func subtitle(_ e: LibraryEntry, folderCount: Int) -> String {
        switch e.kind {
        case .album: return L("Album") + dot + (e.album?.artist ?? "")
        case .artist: return L("Artist")
        case .folder: return L("Folder") + dot + L("{n} items", ["n": folderCount])
        case .playlist:
            let n = e.playlist?.trackCount ?? 0
            return L("Playlist") + (n > 0 ? dot + L("{n} songs", ["n": n]) : "")
        }
    }

    static func likedSubtitle(count: Int?) -> String {
        L("Playlist") + (count.map { dot + L("{n} songs", ["n": $0]) } ?? "")
    }

    /// `fmtTotalShort`: "3h 7min", "9min 39sec".
    static func totalShort(ms: Int) -> String {
        let s = Int((Double(ms) / 1000).rounded())
        let h = s / 3600, m = (s % 3600) / 60, sec = s % 60
        return h > 0 ? L("{h}h {m}min", ["h": h, "m": m]) : L("{m}min {sec}sec", ["m": m, "sec": sec])
    }

    /// Playlist hero stats: `Playlist • 3h 7min`, or the song count when there is no duration.
    static func playlistStats(tracks: [Track]) -> String {
        let total = tracks.reduce(0) { $0 + $1.durationMs }
        return L("Playlist") + dot + (total > 0 ? totalShort(ms: total) : L("{n} songs", ["n": tracks.count]))
    }

    static func likedStats(count: Int) -> String {
        count == 1 ? L("Playlist • 1 song") : L("Playlist • {n} songs", ["n": count])
    }

    /// Scoped "find": every query word is a substring of title + artists + album + album artist,
    /// NFKC-lowercased (API.md §6).
    static func matches(_ t: Track, query: String) -> Bool {
        let words = fold(query).split(whereSeparator: \.isWhitespace)
        guard !words.isEmpty else { return true }
        let hay = fold([t.title, t.artists.joined(separator: " "), t.artist, t.album, t.albumArtist].joined(separator: " "))
        return words.allSatisfy { hay.contains($0) }
    }

    static func fold(_ s: String) -> String { s.precomposedStringWithCompatibilityMapping.lowercased() }

    /// Liked Songs sort sheet options (Library.jsx SORTS).
    enum LikedSort: String, CaseIterable, Sendable {
        case recent, title, artist, album
        var label: String {
            switch self {
            case .recent: L("Recently added")
            case .title: L("Title")
            case .artist: L("Artist")
            case .album: L("Album")
            }
        }
    }

    /// Newest liked first (ties by id so the order is stable), then the phone sort.
    static func likedOrder(_ at: [String: Double], rows: [String: Track], sort: LikedSort) -> [Track] {
        let ids = at.sorted { $0.value != $1.value ? $0.value > $1.value : $0.key < $1.key }.map(\.key)
        let list = ids.compactMap { rows[$0] }
        guard sort != .recent else { return list }
        func key(_ t: Track) -> String {
            switch sort {
            case .title: t.title
            case .artist: t.artists.first ?? t.albumArtist
            case .album: t.album
            case .recent: ""
            }
        }
        // localeCompare(..., {sensitivity: 'base'}); stable for equal keys.
        return list.enumerated().sorted { a, b in
            let r = key(a.element).compare(key(b.element), options: [.caseInsensitive, .diacriticInsensitive], locale: Localizer.shared.locale)
            return r == .orderedSame ? a.offset < b.offset : r == .orderedAscending
        }.map(\.element)
    }

    static func moved<T>(_ list: [T], from: Int, to: Int) -> [T] {
        guard list.indices.contains(from), to >= 0, to < list.count else { return list }
        var l = list
        let x = l.remove(at: from)
        l.insert(x, at: to)
        return l
    }
}
