import Foundation
import MediaPlayer

/// Pure CarPlay rules: which rows each list shows, the player context each list plays under
/// (the same strings the phone screens use), offline filtering and the Now Playing button states.
/// CarPlayController turns these into CPListTemplates.
enum CarPlayLogic {
    /// What a row opens.
    enum Target: Hashable, Sendable {
        case album(id: String, name: String)
        case playlist(id: String, name: String)
        case artist(id: String, name: String)
        case liked
        /// Home "Made For You": `number` is the 1-based place on the shelf.
        case mix(artistId: String, number: Int, seedName: String)
        case topSongs(year: Int)
        /// A downloaded collection (OfflineIndex), played from the files on the device.
        case downloaded(id: String, kind: OfflineKind, name: String)
        case libraryPlaylists, libraryAlbums, libraryArtists, libraryDownloaded
        /// Row `index` of the list's tracks.
        case track(id: String, index: Int)
        /// Queue position (Up Next).
        case queue(index: Int)
    }

    enum Glyph: Hashable, Sendable { case liked, playlist, album, artist, mix, song, downloaded }

    struct Row: Hashable, Sendable {
        var title: String
        var subtitle: String?
        var art: CoverSource?
        var glyph: Glyph
        var target: Target
        /// Track rows: the song id, for the playing mark.
        var trackId: String? {
            switch target {
            case .track(let id, _): id
            default: nil
            }
        }
    }

    struct Section: Hashable, Sendable {
        var title: String?
        var rows: [Row]
    }

    // MARK: Contexts

    /// Player context per list, as the phone passes it (AlbumView `id`, PlaylistView `id`,
    /// DetailArtistModel `artist:<id>`, LikedSongsView `liked`, DailyMixView `mix:<id>`,
    /// TopSongsView `top:<year>`).
    static func context(_ t: Target) -> String? {
        switch t {
        case .album(let id, _), .playlist(let id, _): id
        case .artist(let id, _): "artist:\(id)"
        case .liked: "liked"
        case .mix(let id, _, _): "mix:\(id)"
        case .topSongs(let year): "top:\(year)"
        case .downloaded(let id, let kind, _): kind == .liked ? "liked" : id
        default: nil
        }
    }

    /// The list title a drill-in shows.
    static func title(_ t: Target) -> String {
        switch t {
        case .album(_, let name), .playlist(_, let name), .artist(_, let name): name
        case .liked: L("Liked Songs")
        case .mix(_, let n, _): L("Daily Mix {n}", ["n": n])
        case .topSongs(let year): L("Your Top Songs {year}", ["year": year])
        case .downloaded(_, let kind, let name): kind == .liked ? L("Liked Songs") : name
        case .libraryPlaylists: L("Playlists")
        case .libraryAlbums: L("Albums")
        case .libraryArtists: L("Artists")
        case .libraryDownloaded: L("Downloaded")
        case .track, .queue: ""
        }
    }

    // MARK: Rows

    static func albumRow(_ a: Album) -> Row {
        Row(title: a.name, subtitle: a.artist.isEmpty ? L("Album") : a.artist, art: CoverSource(a), glyph: .album,
            target: .album(id: a.id, name: a.name))
    }

    static func playlistRow(_ p: Playlist) -> Row {
        Row(title: p.name, subtitle: p.trackCount.map { L("Playlist • {n} songs", ["n": $0]) } ?? L("Playlist"),
            art: CoverSource(p), glyph: .playlist, target: .playlist(id: p.id, name: p.name))
    }

    static func artistRow(id: String, name: String, image: String?) -> Row {
        Row(title: name, subtitle: L("Artist"), art: .artist(id: id, image: image), glyph: .artist, target: .artist(id: id, name: name))
    }

    static func likedRow(count: Int?) -> Row {
        Row(title: L("Liked Songs"), subtitle: count.map { L("Playlist • {n} songs", ["n": $0]) } ?? L("Playlist"),
            art: nil, glyph: .liked, target: .liked)
    }

    static func mixRow(_ seed: HomeLogic.RankedArtist, number: Int, summary: DailyMixSummary? = nil) -> Row {
        Row(title: L("Daily Mix {n}", ["n": number]), subtitle: HomeLogic.dailyMixSub(seedName: seed.name, summary: summary),
            art: .artist(id: seed.id, image: seed.image), glyph: .mix,
            target: .mix(artistId: seed.id, number: number, seedName: seed.name))
    }

    static func topSongsRow(_ y: TopSongYears.Year, currentYear: Int) -> Row {
        Row(title: L("Your Top Songs {year}", ["year": y.year]), subtitle: HomeLogic.topSongsSub(y.year, currentYear: currentYear),
            art: y.top.map { .album(id: $0.albumId, art: $0.cover) }, glyph: .mix, target: .topSongs(year: y.year))
    }

    static func downloadedRow(_ c: OfflineCollection, summary: OfflineSummary?) -> Row {
        let kind: String = switch c.kind { case .album: L("Album"); case .playlist, .liked: L("Playlist") }
        let count = summary.map { L("{n} songs", ["n": $0.have]) }
        let art: CoverSource? = switch c.kind {
        case .album: .album(id: c.id, art: nil)
        case .playlist: .playlist(id: c.id, cover: nil)
        case .liked: nil
        }
        return Row(title: c.kind == .liked ? L("Liked Songs") : c.name, subtitle: [kind, count].compactMap { $0 }.joined(separator: " • "),
                   art: art, glyph: c.kind == .liked ? .liked : .downloaded, target: .downloaded(id: c.id, kind: c.kind, name: c.name))
    }

    /// `Artists.join(', ') || AlbumArtist`, as the phone's track rows.
    static func artistLine(_ t: Track) -> String {
        let names = t.artists.filter { !$0.isEmpty }
        if !names.isEmpty { return names.joined(separator: ", ") }
        return t.artist.isEmpty ? t.albumArtist : t.artist
    }

    static func trackRows(_ tracks: [Track], cap: Int) -> [Row] {
        tracks.prefix(max(0, cap)).enumerated().map { i, t in
            Row(title: t.title, subtitle: artistLine(t), art: CoverSource(t), glyph: .song, target: .track(id: t.id, index: i))
        }
    }

    // MARK: Home

    /// Home's shelves in the phone's order (HomeLogic.sections, without the shortcut grid and the
    /// radar, whose missing releases cannot play). Offline only recently played albums that are
    /// downloaded stay; mixes and top songs need the server.
    static func homeSections(_ d: HomeStore.Snapshot, mixSeeds: [HomeLogic.RankedArtist], offline: Bool, held: Set<String>,
                             currentYear: Int, perSection: Int) -> [Section] {
        if offline {
            let recent = d.recent.filter { held.contains($0.id) }.prefix(perSection).map(albumRow)
            return recent.isEmpty ? [] : [Section(title: L("Recently played"), rows: Array(recent))]
        }
        let counts = HomeLogic.Counts(mixes: mixSeeds.count, years: d.topYears.count, recent: d.recent.count,
                                      recentArtists: d.recentArtists.count, radar: 0, topArtists: d.topArtists.count)
        var out: [Section] = []
        for s in HomeLogic.sections(filter: .all, counts: counts) {
            switch s {
            case .madeForYou:
                out.append(Section(title: L("Made For You"), rows: mixSeeds.prefix(perSection).enumerated().map { mixRow($0.element, number: $0.offset + 1, summary: d.mixSummaries?[$0.element.id]) }))
            case .topSongs:
                out.append(Section(title: L("Your Top Songs"), rows: d.topYears.prefix(perSection).map { topSongsRow($0, currentYear: currentYear) }))
            case .recent:
                out.append(Section(title: L("Recently played"), rows: d.recent.prefix(perSection).map(albumRow)))
            case .jumpBackIn:
                out.append(Section(title: L("Jump back in"), rows: d.recentArtists.prefix(perSection).map { artistRow(id: $0.id, name: $0.name, image: $0.image) }))
            case .topArtists:
                out.append(Section(title: L("Your top artists"), rows: d.topArtists.prefix(min(16, perSection)).map { artistRow(id: $0.id, name: $0.name, image: $0.image) }))
            case .shortcuts, .radar:
                break
            }
        }
        return out.filter { !$0.rows.isEmpty }
    }

    // MARK: Library

    /// Your Library's top list. Offline: no artists (the phone hides that filter), and Liked
    /// Songs only once some of it is downloaded.
    static func libraryRoot(likedCount: Int?, offline: Bool, held: Set<String>) -> [Row] {
        var rows: [Row] = []
        if !offline || held.contains(OfflineIndex.likedId) { rows.append(likedRow(count: likedCount)) }
        rows.append(Row(title: L("Playlists"), subtitle: nil, art: nil, glyph: .playlist, target: .libraryPlaylists))
        rows.append(Row(title: L("Albums"), subtitle: nil, art: nil, glyph: .album, target: .libraryAlbums))
        if !offline { rows.append(Row(title: L("Artists"), subtitle: nil, art: nil, glyph: .artist, target: .libraryArtists)) }
        rows.append(Row(title: L("Downloaded"), subtitle: nil, art: nil, glyph: .downloaded, target: .libraryDownloaded))
        return rows
    }

    /// Offline only collections with a downloaded song show (LibraryArrangement.shown).
    static func playlists(_ list: [Playlist], offline: Bool, held: Set<String>, cap: Int) -> [Row] {
        list.filter { !offline || held.contains($0.id) }.prefix(max(0, cap)).map(playlistRow)
    }

    static func albums(_ list: [Album], offline: Bool, held: Set<String>, cap: Int) -> [Row] {
        list.filter { !offline || held.contains($0.id) }.prefix(max(0, cap)).map(albumRow)
    }

    static func artists(_ list: [Artist], offline: Bool, cap: Int) -> [Row] {
        offline ? [] : list.prefix(max(0, cap)).map { artistRow(id: $0.id, name: $0.name, image: $0.image) }
    }

    /// Collections with at least one downloaded song, newest saved first (index order).
    static func downloaded(_ index: OfflineIndex, cap: Int) -> [Row] {
        index.collections.compactMap { c -> Row? in
            guard let s = index.summary(c.id), s.have > 0 else { return nil }
            return downloadedRow(c, summary: s)
        }.prefix(max(0, cap)).map { $0 }
    }

    /// What a track list shows and plays: offline only downloaded songs (the phone greys the
    /// others out and refuses to play them; a car list has no greyed rows, so they are left out).
    static func playable(_ tracks: [Track], offline: Bool, has: (String) -> Bool) -> [Track] {
        offline ? tracks.filter { has($0.id) } : tracks
    }

    // MARK: Queue (Up Next)

    struct QueuePart: Equatable, Sendable {
        var title: String
        var indices: [Int]
    }

    /// QueueView's sections: Now playing, the queued run after it, then the rest of the context.
    static func queueParts(count: Int, index: Int, queuedFlags: [Bool], hasContext: Bool, fromName: String, cap: Int) -> [QueuePart] {
        guard count > 0 else { return [] }
        var out: [QueuePart] = []
        var budget = max(0, cap)
        if (0..<count).contains(index), budget > 0 { out.append(QueuePart(title: L("Now playing"), indices: [index])); budget -= 1 }
        let base = index + 1
        var split = 0
        while base + split < min(count, queuedFlags.count), queuedFlags[base + split] { split += 1 }
        if split > 0, budget > 0 {
            let idx = Array(base..<(base + min(split, budget)))
            out.append(QueuePart(title: L("Next in queue"), indices: idx)); budget -= idx.count
        }
        let start = base + split
        if start < count, budget > 0 {
            let idx = Array(start..<min(count, start + min(80, budget)))
            out.append(QueuePart(title: hasContext ? L("Next from: {name}", ["name": fromName]) : L("Next up"), indices: idx))
        }
        return out
    }

    // MARK: Now Playing buttons

    /// Same cycling as the phone's Now Playing (off -> on -> smart -> off).
    static func nextShuffle(_ s: Player.Shuffle) -> Player.Shuffle { s.nowPlayingNext }
    /// off -> all -> one -> off.
    static func nextRepeat(_ r: Player.Repeat) -> Player.Repeat { r.nowPlayingNext }
    static func shuffleSelected(_ s: Player.Shuffle) -> Bool { s != .off }
    static func repeatSelected(_ r: Player.Repeat) -> Bool { r != .off }

    /// What the CarPlay repeat button draws (it reads the command centre's current type).
    static func repeatType(_ r: Player.Repeat) -> MPRepeatType {
        switch r { case .off: .off; case .all: .all; case .one: .one }
    }

    static func shuffleType(_ s: Player.Shuffle) -> MPShuffleType { s == .off ? .off : .items }

    static func likeSymbol(_ liked: Bool) -> String { liked ? "heart.fill" : "heart" }

    /// A row's playing mark: track rows by song (like the phone's `isCurrent`), queue rows by
    /// position, collection rows when they are the playing context.
    static func isPlaying(_ row: Row, currentId: String?, playerContext: String?, playerIndex: Int = -1) -> Bool {
        switch row.target {
        case .track(let id, _): return currentId != nil && id == currentId
        case .queue(let i): return i == playerIndex
        default:
            guard let c = context(row.target), let p = playerContext else { return false }
            return c == p || (c == "liked" && p == OfflineIndex.likedId)
        }
    }

    /// The pixel size to ask the server for, for a CarPlay list image.
    static func imagePixels(_ size: CGSize, scale: CGFloat) -> Int {
        max(1, Int((max(size.width, size.height) * max(1, scale)).rounded(.up)))
    }
}
