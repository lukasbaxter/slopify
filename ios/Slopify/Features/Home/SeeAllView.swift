import SwiftUI

/// See-all pages (UI.md 6.3.10): Albums, Artists, Your top artists. A sticky All / Music / Artists
/// chip row under the top bar, an inline heading and a two-column grid of Home-style cards.
struct SeeAllView: View {
    let kind: Route.SeeAll

    @Environment(Account.self) private var account
    @Environment(Navigator.self) private var nav
    @Environment(AppModel.self) private var app
    @Environment(\.theme) private var theme
    @State private var store = HomeStore.shared
    @State private var menu: MenuSheet?

    var body: some View {
        // The bar mixes the page's default `--hero` (#3d3c3c), as on the web.
        DetailScaffold(title: Self.title(kind), heroColor: Theme.Fixed.defaultHero) {
            LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
                Section {
                    Text(Self.title(kind)).font(.system(size: 24, weight: .bold)).foregroundStyle(theme.fg)
                        .padding(.horizontal, Spacing.gutter)
                        .padding(.bottom, 16)
                    grid
                } header: {
                    SeeAllChips(kind: kind, select: select)
                }
            }
        }
        .contextMenuSheet($menu)
        .task {
            store.use(key: HomeStore.key(for: account))
            await store.load(api: account.api, maxAge: 60)
        }
    }

    static func title(_ k: Route.SeeAll) -> String {
        switch k {
        case .albums: L("Albums")
        case .artists: L("Artists")
        case .topArtists: L("Your top artists")
        }
    }

    @ViewBuilder private var grid: some View {
        switch kind {
        case .albums:
            CardGrid(items: store.data.albums) { a in
                MediaCard(.init(a), title: a.name, subtitle: a.artist, style: .home, artSize: 175) { nav.push(.album(id: a.id)) } onLongPress: {
                    menu = CardMenuBuilder(app: app).album(a.id, name: a.name, artist: a.artist, artistId: a.artistId)
                }
            }
        case .artists:
            CardGrid(items: store.data.artists) { a in
                MediaCard(.init(a), title: a.name, subtitle: L("Artist"), round: true, style: .home, artSize: 175) { nav.push(.artist(id: a.id)) } onLongPress: {
                    menu = CardMenuBuilder(app: app).artist(a.id, name: a.name)
                }
            }
        case .topArtists:
            CardGrid(items: store.data.topArtists) { a in
                MediaCard(.artist(id: a.id, image: a.image), title: a.name, subtitle: L("Artist"), round: true, style: .home, artSize: 175) {
                    nav.push(.artist(id: a.id))
                } onLongPress: {
                    menu = CardMenuBuilder(app: app).artist(a.id, name: a.name)
                }
            }
        }
    }

    /// All → Home; Music / Artists swap this page for the other list (the web replaces, not pushes).
    private func select(_ target: Route.SeeAll?) {
        guard let target else {
            if nav.tab == .home { nav.paths[.home] = NavigationPath() } else { nav.select(.home) }
            return
        }
        guard target != kind else { return }
        var path = nav.paths[nav.tab] ?? NavigationPath()
        if !path.isEmpty { path.removeLast() }
        path.append(Route.seeAll(target))
        nav.paths[nav.tab] = path
    }
}

/// The sticky chip row: padding `56 + inset` 16 8, `--bg-base`. Music is on for Albums, Artists for
/// Artists, none for Your top artists.
private struct SeeAllChips: View {
    let kind: Route.SeeAll
    var select: (Route.SeeAll?) -> Void
    @Environment(\.theme) private var theme
    @Environment(\.detailTopInset) private var topInset

    var body: some View {
        HStack(spacing: 8) {
            Chip(L("All")) { select(nil) }
            Chip(L("Music"), on: kind == .albums) { select(.albums) }
            Chip(L("Artists"), on: kind == .artists) { select(.artists) }
        }
        .padding(.top, Shell.topBar + topInset)
        .padding(.horizontal, Spacing.gutter)
        .padding(.bottom, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(theme.bgBase)
    }
}
