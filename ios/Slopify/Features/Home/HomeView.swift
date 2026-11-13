import SwiftUI

/// Home tab root (UI.md 6.1): floating avatar over a sticky All / Music / Artists chip row, the
/// shortcut grid, then the shelves in the web's order. No greeting on phone, no loading states:
/// sections appear when their data does. Pull to refresh reloads every source.
struct HomeView: View {
    @Environment(Account.self) private var account
    @Environment(Navigator.self) private var nav
    @Environment(AppModel.self) private var app
    @Environment(\.theme) private var theme

    @State private var store = HomeStore.shared
    @State private var filter: HomeLogic.Filter = .all
    @State private var scrollTop: CGFloat = 0
    @State private var menu: MenuSheet?
    private let space = "home-scroll"

    var body: some View {
        GeometryReader { outer in
            let topInset = outer.safeAreaInsets.top
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
                        Section {
                            content.padding(.top, 16).padding(.bottom, 24)
                        } header: {
                            chipBar(topInset: topInset)
                        }
                    }
                    .id("home-top")
                    .shellContentPadding()
                    .background(alignment: .top) {
                        // The soft wash over the first 250 pt scrolls with the content.
                        LinearGradient(colors: [theme.chip, theme.page], startPoint: .top, endPoint: .bottom)
                            .frame(height: 250)
                    }
                    .background(GeometryReader { g in
                        Color.clear.preference(key: HomeScrollKey.self, value: -g.frame(in: .named(space)).minY)
                    })
                }
                .scrollIndicators(.hidden)
                .coordinateSpace(name: space)
                .ignoresSafeArea(edges: .top)
                .onPreferenceChange(HomeScrollKey.self) { scrollTop = $0 }
                .refreshable { await refresh(force: true) }
                .onChange(of: nav.scrollToTop[.home]) { _, _ in
                    withAnimation(Motion.ease(0.3)) { proxy.scrollTo("home-top", anchor: .top) }
                }
            }
            .overlay(alignment: .topLeading) {
                Button { nav.drawerOpen = true } label: {
                    Avatar(userId: account.user?.id, name: account.user?.name, size: 32)
                }
                .buttonStyle(.pressFade)
                // The reader's frame starts below the status bar: 8 + safe-area-top from the screen top.
                .padding(.top, 8)
                .padding(.leading, Spacing.gutter)
                .accessibilityLabel(account.user?.name ?? L("Account"))
            }
        }
        .background(theme.bgBase.ignoresSafeArea())
        .toolbar(.hidden, for: .navigationBar)
        .contextMenuSheet($menu)
        .task(id: HomeStore.key(for: account)) {
            store.use(key: HomeStore.key(for: account))
            await refresh(force: false)
        }
    }

    private func refresh(force: Bool) async {
        await store.load(api: account.api, maxAge: force ? 0 : 60)
    }

    // MARK: Header

    private func chipBar(topInset: CGFloat) -> some View {
        HStack(spacing: 8) {
            Chip(L("All"), on: filter == .all) { filter = .all }
            Chip(L("Music"), on: filter == .music) { filter = .music }
            Chip(L("Artists"), on: filter == .artists) { filter = .artists }
        }
        .padding(.top, 8 + topInset)
        .padding(.trailing, Spacing.gutter)
        .padding(.bottom, 8)
        .padding(.leading, 56)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(theme.bgBase.opacity(scrollTop > 8 ? 1 : 0).animation(.linear(duration: 0.2), value: scrollTop > 8))
    }

    // MARK: Body

    @ViewBuilder private var content: some View {
        let sections = store.sections(filter)
        VStack(alignment: .leading, spacing: 0) {
            ForEach(sections, id: \.self) { s in
                section(s).padding(.bottom, 24)
            }
        }
    }

    @ViewBuilder private func section(_ s: HomeLogic.Section) -> some View {
        switch s {
        case .shortcuts: shortcutGrid
        case .madeForYou: madeForYou
        case .topSongs: topSongs
        case .recent:
            shelf(L("Recently played"), seeAll: { nav.pushFromHome(.seeAll(.albums)) }) {
                Shelf(items: store.data.recent, style: .home) { a in
                    MediaCard(.init(a), title: a.name, subtitle: a.artist.isEmpty ? L("Album") : a.artist, style: .home, artSize: 150) {
                        nav.pushFromHome(.album(id: a.id))
                    } onLongPress: {
                        menu = CardMenuBuilder(app: app).album(a.id, name: a.name, artist: a.artist, artistId: a.artistId)
                    }
                    .homeZoomSource(.album(id: a.id))
                }
            }
        case .jumpBackIn:
            shelf(L("Jump back in"), seeAll: { nav.push(.seeAll(.artists)) }) { artistShelf(store.data.recentArtists) }
        case .radar:
            shelf(L("Release Radar"), seeAll: { nav.pushFromHome(.releaseRadar) }) {
                Shelf(items: store.radarShelf, style: .home) { r in radarCard(r) }
            }
        case .topArtists:
            shelf(L("Your top artists"), seeAll: { nav.push(.seeAll(.topArtists)) }) { artistShelf(Array(store.data.topArtists.prefix(16))) }
        }
    }

    private static func route(_ s: HomeLogic.Shortcut) -> Route {
        switch s {
        case .liked: .likedSongs
        case .album(let a): .album(id: a.id)
        case .playlist(let p): .playlist(id: p.id)
        }
    }

    private var shortcutGrid: some View {
        LazyVGrid(columns: [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)], spacing: 8) {
            ForEach(store.shortcuts) { s in
                HomeShortcutTile(shortcut: s) {
                    switch s {
                    case .liked: nav.pushFromHome(.likedSongs)
                    case .album(let a): nav.pushFromHome(.album(id: a.id))
                    case .playlist(let p): nav.pushFromHome(.playlist(id: p.id))
                    }
                } onLongPress: {
                    let m = CardMenuBuilder(app: app)
                    switch s {
                    case .liked: menu = m.likedSongs()
                    case .album(let a): menu = m.album(a.id, name: a.name, artist: a.artist, artistId: a.artistId)
                    case .playlist(let p): menu = m.playlist(p.id, name: p.name)
                    }
                }
                .homeZoomSource(Self.route(s))
            }
        }
        .padding(.horizontal, Spacing.gutter)
    }

    private var madeForYou: some View {
        let seeds = store.mixSeeds
        return shelf(L("Made For You"), seeAll: nil) {
            Shelf(items: Array(seeds.enumerated()).map { MixItem(index: $0.offset, artist: $0.element) }, style: .home) { m in
                let label = L("Daily Mix {n}", ["n": m.index + 1])
                MediaCard(title: label, subtitle: store.mixSub(artistId: m.artist.id, seedName: m.artist.name), style: .home,
                          action: { nav.pushFromHome(.dailyMix(artistId: m.artist.id, number: m.index + 1, seedName: m.artist.name)) }) {
                    HomeMixArt(source: .artist(id: m.artist.id, image: m.artist.image), color: mixColor(m.index), label: label, pixelSize: 150)
                }
                .homeZoomSource(.dailyMix(artistId: m.artist.id, number: m.index + 1, seedName: m.artist.name))
            }
        }
    }

    private var topSongs: some View {
        let year = Calendar.current.component(.year, from: Date())
        let years = Array(store.data.topYears.enumerated()).map { YearItem(index: $0.offset, year: $0.element) }
        return shelf(L("Your Top Songs"), seeAll: nil) {
            Shelf(items: years, style: .home) { y in
                let label = L("Your Top Songs {year}", ["year": y.year.year])
                MediaCard(title: label, subtitle: HomeLogic.topSongsSub(y.year.year, currentYear: year), style: .home,
                          action: { nav.pushFromHome(.topSongs(year: y.year.year, colorIndex: y.index)) }) {
                    HomeMixArt(source: y.year.top.map { CoverSource.album(id: $0.albumId, art: $0.cover) }, color: mixColor(y.index), label: label, pixelSize: 150)
                }
                .homeZoomSource(.topSongs(year: y.year.year, colorIndex: y.index))
            }
        }
    }

    private func artistShelf(_ list: [HomeLogic.RankedArtist]) -> some View {
        Shelf(items: list, style: .home) { a in
            MediaCard(.artist(id: a.id, image: a.image), title: a.name, subtitle: L("Artist"), round: true, style: .home, artSize: 150) {
                nav.pushFromHome(.artist(id: a.id))
            } onLongPress: {
                menu = CardMenuBuilder(app: app).artist(a.id, name: a.name)
            }
            .homeZoomSource(.artist(id: a.id))
        }
    }

    @ViewBuilder private func radarCard(_ r: Release) -> some View {
        if let lib = r.inLibrary {
            MediaCard(.album(id: lib, art: nil), title: r.title, subtitle: HomeLogic.radarShelfSub(r), style: .home, artSize: 150) {
                nav.pushFromHome(.album(id: lib))
            } onLongPress: {
                menu = CardMenuBuilder(app: app).album(lib, name: r.title, artist: r.artist, artistId: r.artistId)
            }
            .homeZoomSource(.album(id: lib))
        } else {
            // Not in the library yet: the artist's page, where it can be requested.
            MediaCard(.url(r.image.flatMap(URL.init(string:))), title: r.title, subtitle: HomeLogic.radarShelfSub(r), style: .home, artSize: 150) {
                if let a = r.artistId { nav.pushFromHome(.artist(id: a)) }
            }
            .homeZoomSource(r.artistId.map { Route.artist(id: $0) } ?? .releaseRadar)
        }
    }

    /// A Home shelf: 24/700 heading (tappable when it has a see-all target; no "Show all" on Home).
    private func shelf<C: View>(_ title: String, seeAll: (() -> Void)?, @ViewBuilder rows: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionHeader(title, style: .home)
                .contentShape(Rectangle())
                .onTapGesture { seeAll?() }
                .accessibilityAddTraits(seeAll == nil ? [] : .isButton)
            rows()
        }
    }

    private func mixColor(_ i: Int) -> RGB { Theme.Fixed.mixPalette[HomeLogic.mixColorIndex(i)] }
}

private struct MixItem: Identifiable { let index: Int; let artist: HomeLogic.RankedArtist; var id: String { artist.id } }
private struct YearItem: Identifiable { let index: Int; let year: TopSongYears.Year; var id: Int { year.year } }

private struct HomeScrollKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}
