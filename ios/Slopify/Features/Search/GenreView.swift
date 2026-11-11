import SwiftUI

/// A genre page (UI.md 6.3.8), coloured like the tile it was opened from (DECISIONS).
struct GenreView: View {
    let name: String
    var body: some View { SearchBrowsePage(kind: .genre(name)) }
}

/// Shelf needs Identifiable rows; the Core type is not.
private struct GenreArtist: Identifiable { var id: String; var name: String }

/// Genre and Charts pages (`kind 'Browse'`, Library.jsx:672-742): text-only hero, Shuffle + Play,
/// then Top artists, Albums, New additions and Popular.
struct SearchBrowsePage: View {
    enum Kind: Hashable {
        case genre(String)
        case charts
    }

    let kind: Kind

    @Environment(AppModel.self) private var app
    @Environment(Account.self) private var account
    @Environment(Player.self) private var player
    @Environment(Likes.self) private var likes
    @Environment(Navigator.self) private var nav
    @Environment(\.theme) private var theme

    @State private var hub: GenreDetail?
    @State private var tracks: [Track] = []
    @State private var loading = true
    @State private var failed = false
    @State private var menu: MenuSheet?
    @State private var nameDialog: NameDialog?

    private var genre: String? { if case .genre(let n) = kind { n } else { nil } }
    private var title: String { genre ?? L("Charts") }
    /// The player context (`item.Id`, `browse:<tile id>`).
    private var context: String { genre.map { "browse:genre:\($0)" } ?? "browse:charts" }

    private var hero: RGB {
        guard let genre else { return ColorMath.heroTint(Theme.Fixed.radarHero) }
        let tiles = SearchBrowseData.storageKey(account: account).flatMap(SearchBrowseData.load)?.tiles
        return ColorMath.heroTint(SearchBrowseData.tileColor(genre: genre, tiles: tiles) ?? Theme.Fixed.defaultHero)
    }

    var body: some View {
        let hero = hero
        DetailScaffold(title: title, heroColor: hero) {
            SearchBrowseHero(color: hero, title: title, meta: meta)
            ActionRow(heroColor: hero) {
                EmptyView()
            } trailing: {
                IconButton(label: L("Shuffle"), action: { playMix(shuffle: true) }) { ShuffleGlyph(mode: .off, size: 24) }
                BigPlayButton(playing: false) { playMix(shuffle: false) }
                    .padding(.leading, 4)
            }
            sections
        }
        .contextMenuSheet($menu)
        .nameDialog($nameDialog)
        .task(id: kind) { await load() }
    }

    // MARK: data

    private func load() async {
        loading = true; failed = false
        do {
            switch kind {
            case .genre(let n):
                async let h = account.api.genre(n)
                async let t = account.api.genreTracks(n)
                let (hh, tt) = try await (h, t)
                hub = hh; tracks = Array(tt.prefix(30))
            case .charts:
                // The web's `topTracks({ limit: 100 })` reads /api/home (at most 50), keeps 50.
                tracks = Array(try await account.api.home().topTracks.prefix(50))
            }
        } catch {
            if !(error is CancellationError) { failed = true }
        }
        loading = false
    }

    private var meta: String {
        if let hub {
            return L("{songs} songs • {albums} albums", ["songs": Self.number(hub.trackCount ?? 0), "albums": Self.number(hub.albumCount ?? 0)])
        }
        if !tracks.isEmpty { return L("{n} most played", ["n": tracks.count]) }
        if loading { return L("Loading…") }
        if failed { return Connectivity.shared.offline ? L("Not available offline") : L("Couldn’t load this — try again") }
        return L("Nothing in this genre yet")
    }

    static func number(_ n: Int) -> String {
        let f = NumberFormatter()
        f.numberStyle = .decimal
        f.locale = Localizer.shared.locale
        return f.string(from: NSNumber(value: n)) ?? String(n)
    }

    /// Genre: everything in the genre weighted to plays and likes; Charts: its own tracks.
    private func playMix(shuffle: Bool) {
        Task {
            var mix = tracks
            if let genre, let m = try? await account.api.genreMix(genre) { mix = m }
            guard !mix.isEmpty else { return }
            if shuffle { player.setShuffle(.on) }
            player.play(mix, startAt: shuffle ? Int.random(in: 0..<mix.count) : 0, context: context)
        }
    }

    // MARK: sections

    /// Charts has no hub: its albums come from the tracks, first appearance order.
    static func albumsFromTracks(_ tracks: [Track], unknown: String) -> [Album] {
        var seen = Set<String>(), out: [Album] = []
        for t in tracks where !t.albumId.isEmpty && seen.insert(t.albumId).inserted {
            out.append(Album(id: t.albumId, name: t.album.isEmpty ? unknown : t.album,
                             artist: t.albumArtist.isEmpty ? (t.artists.first ?? "") : t.albumArtist, cover: t.cover))
        }
        return out
    }

    private var albums: [Album] {
        let list = hub?.albums ?? Self.albumsFromTracks(tracks, unknown: L("Unknown album"))
        return Array(list.prefix(18))
    }

    @ViewBuilder private var sections: some View {
        let artists = (hub?.topArtists ?? []).map { GenreArtist(id: $0.id, name: $0.name) }
        let recent = Array((hub?.recent ?? []).prefix(12))
        if !artists.isEmpty {
            SectionHeader(L("Top artists"), first: true)
            Shelf(items: artists) { a in
                MediaCard(.artist(id: a.id, image: nil), title: a.name, subtitle: L("Artist"), round: true) {
                    nav.push(.artist(id: a.id))
                }
            }
        }
        if !albums.isEmpty {
            SectionHeader(L("Albums"), first: artists.isEmpty)
            CardGrid(items: albums) { a in
                MediaCard(CoverSource(a), title: a.name, subtitle: [a.artist, a.year.map(String.init) ?? ""].filter { !$0.isEmpty }.joined(separator: " • "),
                          artSize: 175) { nav.push(.album(id: a.id)) }
            }
        }
        if !recent.isEmpty {
            SectionHeader(L("New additions"), first: artists.isEmpty && albums.isEmpty)
            Shelf(items: recent) { a in
                MediaCard(CoverSource(a), title: a.name, subtitle: a.artist) { nav.push(.album(id: a.id)) }
            }
        }
        if !tracks.isEmpty {
            SectionHeader(L("Popular"), first: artists.isEmpty && albums.isEmpty && recent.isEmpty)
            LazyVStack(spacing: 0) {
                ForEach(Array(tracks.enumerated()), id: \.offset) { i, t in
                    TrackRow(track: t, showArt: true, isCurrent: player.current?.id == t.id,
                             onTap: {
                                 if player.current?.id == t.id { player.togglePlay() }
                                 else { player.play(tracks, startAt: i, context: context) }
                             },
                             onMore: { menu = TrackMenuBuilder(app: app) { nameDialog = $0 }.sheet(t) },
                             onArt: { if !t.albumId.isEmpty { nav.push(.album(id: t.albumId)) } },
                             onTouchDown: { player.prewarm(t) })
                }
            }
        }
    }
}

/// The text-only hero of genre / chart pages (`.hero.browse-hero`): `--hero` with the page wash,
/// padding `56 + inset` 16 8, 24/700 title (2 lines), meta 13 pt white 70 %. The "Genre" kind
/// label is hidden on phone.
private struct SearchBrowseHero: View {
    var color: RGB
    var title: String
    var meta: String
    @Environment(\.detailTopInset) private var topInset
    @Environment(\.theme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).textStyle(.pageTitle).foregroundStyle(theme.heroIsland.fg).lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
            Text(meta).font(.system(size: 13)).foregroundStyle(theme.heroIsland.fg(0.7))
        }
        .padding(.top, Shell.topBar + topInset)
        .padding(.horizontal, Spacing.gutter)
        .padding(.bottom, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background {
            color.color.overlay(LinearGradient(colors: [theme.page(0), theme.heroIsland.page(0.3)], startPoint: .top, endPoint: .bottom))
        }
        .heroIsland()
        .reportsHeroHeight()
    }
}
