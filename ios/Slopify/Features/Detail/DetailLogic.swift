import Foundation

/// Pure rules behind the album and artist pages (Library.jsx), kept apart so they are tested.
enum DetailLogic {
    // MARK: Release type (Library.jsx:181-191)

    /// The i18n key: "Album", "EP", "Single" or "Compilation".
    static func releaseType(name: String, albumArtist: String, count: Int?, durationMs: Int?) -> String {
        let n = count ?? 0
        let mins = Double(durationMs ?? 0) / 60_000
        let short = mins == 0 || mins < 30
        if albumArtist.range(of: "various artists", options: .caseInsensitive) != nil { return "Compilation" }
        if matches(name, #"\b(EP)\b\s*$|\s[-–]\s*EP\s*$"#) { return "EP" }
        if matches(name, #"\s[-–]\s*Single\s*$|\(single\)$"#) { return "Single" }
        if n > 0 && n <= 3 && short { return "Single" }
        if n > 0 && n <= 6 && short { return "EP" }
        return "Album"
    }

    static func releaseType(_ a: Album, tracks: [Track] = []) -> String {
        let total = tracks.reduce(0) { $0 + $1.durationMs }
        let dur = (a.durationMs ?? 0) > 0 ? a.durationMs : total
        return releaseType(name: a.name, albumArtist: a.artist, count: a.trackCount ?? (tracks.isEmpty ? nil : tracks.count), durationMs: dur)
    }

    private static func matches(_ s: String, _ pattern: String) -> Bool {
        s.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil
    }

    /// Album hero stats: "Album • 2013" (the year left out when unknown).
    static func albumStats(_ a: Album, tracks: [Track]) -> String {
        [L(releaseType(a, tracks: tracks)), a.year.map { String($0) }].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " • ")
    }

    // MARK: Artist page

    /// Popular order (App.jsx:885-895): tracks the popular list names first, in its order;
    /// the rest keep their order after them.
    static func popularOrder(_ tracks: [Track], ids: [String]) -> [Track] {
        guard !ids.isEmpty else { return tracks }
        var pos: [String: Int] = [:]
        for (i, id) in ids.enumerated() where pos[id] == nil { pos[id] = i }
        let known = tracks.filter { pos[$0.id] != nil }.sorted { pos[$0.id]! < pos[$1.id]! }
        let seen = Set(known.map(\.id))
        return known + tracks.filter { !seen.contains($0.id) }
    }

    /// Popular row subtitle: play count when known, else the album name.
    static func playsSubtitle(_ t: Track, locale: Locale = .current) -> String? {
        if let p = t.plays, p > 0 {
            if p == 1 { return L("1 play") }
            return L("{n} plays", ["n": p.formatted(.number.locale(locale))])
        }
        return t.album.isEmpty ? nil : t.album
    }

    // MARK: Discography (Library.jsx:1401-1430)

    struct Entry: Identifiable, Hashable {
        var id: String
        var title: String
        /// i18n key of the release type.
        var type: String
        var year: String
        var date: String
        /// Library album id when owned.
        var inLib: String?
        /// Upstream id (MusicBrainz) for requests; nil for library-only albums.
        var mbid: String?
        var image: URL?
        var requestStatus: String?

        var subtitle: String { year.isEmpty ? L(type) : "\(year) • \(L(type))" }
        var sortYear: Int { Int(String((date.isEmpty ? year : date).prefix(4))) ?? 0 }
    }

    /// Discography releases plus the library albums the catalogue does not list.
    static func entries(releases: [Release], albums: [Album]) -> [Entry] {
        var out: [Entry] = releases.enumerated().map { i, r in
            Entry(id: "\(r.inLibrary ?? r.album_id ?? r.title)-\(i)", title: r.localName ?? r.title,
                  type: r.rtype?.isEmpty == false ? r.rtype! : "Album", year: r.year ?? "", date: r.date ?? "",
                  inLib: r.inLibrary, mbid: r.album_id, image: r.image.flatMap(URL.init(string:)), requestStatus: r.requestStatus)
        }
        let listed = Set(releases.compactMap(\.inLibrary))
        out += albums.filter { !listed.contains($0.id) }.map { a in
            Entry(id: a.id, title: a.name, type: releaseType(a), year: a.year.map { String($0) } ?? "", date: "", inLib: a.id)
        }
        return out
    }

    /// Newest first: by year, then the date string descending; stable otherwise.
    static func newestFirst(_ e: [Entry]) -> [Entry] {
        e.enumerated().sorted { a, b in
            if a.element.sortYear != b.element.sortYear { return a.element.sortYear > b.element.sortYear }
            if a.element.date != b.element.date { return a.element.date > b.element.date }
            return a.offset < b.offset
        }.map(\.element)
    }

    enum TypeFilter: String, CaseIterable, Sendable { case all, album, single, ep, compilation
        var key: String {
            switch self {
            case .all: "All"
            case .album: "Albums"
            case .single: "Singles"
            case .ep: "EPs"
            case .compilation: "Compilations"
            }
        }
        var type: String? {
            switch self {
            case .all: nil
            case .album: "Album"
            case .single: "Single"
            case .ep: "EP"
            case .compilation: "Compilation"
            }
        }
    }

    enum LibFilter: String, CaseIterable, Sendable { case all, have, missing
        var key: String {
            switch self {
            case .all: "Everything"
            case .have: "In your library"
            case .missing: "Not in library"
            }
        }
    }

    /// "All" plus the types that exist, in the web's order.
    static func typeFilters(_ e: [Entry]) -> [TypeFilter] {
        let types = Set(e.map(\.type))
        return TypeFilter.allCases.filter { $0 == .all || types.contains($0.type!) }
    }

    static func filtered(_ e: [Entry], type: TypeFilter, lib: LibFilter) -> [Entry] {
        newestFirst(e.filter { x in
            (type.type == nil || x.type == type.type) &&
            (lib == .all || (lib == .have ? x.inLib != nil : x.inLib == nil))
        })
    }

    // MARK: Request pill (Library.jsx:428-438)

    static let pending: Set<String> = ["queued", "exists", "downloading"]

    /// The server's state wins once it reports progress; until then the tap's own.
    static func requestState(mine: String?, server: String?) -> String? {
        if let mine, server == nil || server == "failed" { return mine }
        return server ?? mine
    }

    static func requestLabel(_ st: String?) -> (key: String, busy: Bool) {
        let key: String
        switch st {
        case "queued", "exists": key = "Requested"
        case "downloading": key = "Downloading…"
        case "failed": key = "Retry"
        case "error": key = "Failed"
        default: key = "Request"
        }
        return (key, st.map { pending.contains($0) } ?? false)
    }
}
