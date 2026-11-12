import SwiftUI

/// Liked Songs (UI.md 6.3.5): a pinned find bar (with the back chevron) over the page, the
/// 180 pt Liked tile hero, ⋯ | shuffle, play, then the liked songs newest first (or sorted).
/// Rows follow the likes store live; songs liked elsewhere are fetched in.
struct LikedSongsView: View {
    @Environment(AppModel.self) private var app
    @Environment(Navigator.self) private var nav
    @Environment(Account.self) private var account
    @Environment(Player.self) private var player
    @Environment(Likes.self) private var likes
    @Environment(SessionClient.self) private var session
    @Environment(OfflineStore.self) private var offline
    @Environment(\.theme) private var theme
    @Environment(\.dismiss) private var dismiss

    @State private var store = LibraryStore.shared
    @State private var find = ""
    @State private var debounced = ""
    @State private var sort: LibraryText.LikedSort = .recent
    @State private var menu: MenuSheet?
    @State private var nameDialog: NameDialog?
    @State private var confirm: ConfirmDialog?
    /// Liked-at times: the store's fetch until the likes store reports, then the likes store.
    @State private var likedAt: [String: Double] = [:]
    @State private var loading = true

    private let context = "liked"
    private var menus: TrackMenuBuilder { TrackMenuBuilder(app: app) { nameDialog = $0 } }
    private var ctx: LibraryContext { LibraryContext(api: account.api, account: account, player: player, likes: likes, nav: nav, session: session) }
    private var hero: RGB { ColorMath.detailHero(isLiked: true) }
    private var all: [Track] { LibraryText.likedOrder(likedAt, rows: store.likedRows, sort: sort) }

    var body: some View {
        let rows = all
        let shown = debounced.trimmingCharacters(in: .whitespaces).isEmpty ? rows : rows.filter { LibraryText.matches($0, query: debounced) }
        DetailScaffold(title: L("Liked Songs"), heroColor: hero, barStyle: .hidden, onRefresh: { await store.loadLiked() }) {
            hero.color.frame(height: findBarHeight)
            HeroHeader(color: hero, title: L("Liked Songs"), coverSize: 180) {
                LikedCover()
            } meta: {
                HeroOwner(name: account.user?.name ?? L("You"), action: { nav.push(.profile) }) {
                    Avatar(userId: account.user?.id, name: account.user?.name, size: 20, drawer: true)
                }
                Text(LibraryText.likedStats(count: likedAt.count))
            }
            .environment(\.detailTopInset, 16 - Shell.topBar)
            ActionRow(heroColor: hero) {
                if !rows.isEmpty { OfflineDownloadButton(actions: download(rows)) }
                IconButton(.dots24, label: L("More options")) { menu = heroMenu(rows) }
            } trailing: {
                IconButton(on: player.shuffle != .off, label: player.shuffle == .off ? L("Enable shuffle") : L("Disable shuffle"), action: ctx.toggleShuffle) {
                    ShuffleGlyph(mode: player.shuffle == .smart ? .smart : player.shuffle == .on ? .on : .off, size: 24)
                }
                BigPlayButton(playing: ctx.isPlayingPage(context)) { ctx.playPage(shown, context: context) }
                    .padding(.leading, 4)
            }
            list(shown, all: rows)
        }
        .overlay(alignment: .top) { findBar }
        .background(GeometryReader { g in
            Color.clear.onAppear { topInset = g.safeAreaInsets.top }.onChange(of: g.safeAreaInsets.top) { _, v in topInset = v }
        })
        .contextMenuSheet($menu)
        .nameDialog($nameDialog)
        .confirmDialog($confirm)
        .task {
            ctx.attachStore()
            likedAt = likes.tracks.isEmpty ? store.likedAt : likes.tracks
            await store.loadLiked()
            if likes.tracks.isEmpty { likedAt = store.likedAt }
            loading = false
            await fillMissing()
        }
        .onChange(of: likes.tracks) { _, t in likedAt = t; Task { await fillMissing() } }
        .task(id: find) {
            try? await Task.sleep(nanoseconds: 80_000_000)
            if !Task.isCancelled { debounced = find }
        }
    }

    @State private var topInset: CGFloat = 0
    /// `10 + inset` + 36 field + 8, then the hero's own 16.
    private var findBarHeight: CGFloat { 10 + topInset + 36 + 8 }

    // MARK: - Find bar (pinned)

    private var findBar: some View {
        HStack(spacing: 8) {
            HStack(spacing: 8) {
                IconView(.magnifier, size: 16).foregroundStyle(theme.fg)
                TextField("", text: $find, prompt: Text(L("Find in Liked Songs")).foregroundStyle(theme.fg(0.75)))
                    .font(.system(size: 14, weight: .medium)).foregroundStyle(theme.fg)
                    .autocorrectionDisabled().textInputAutocapitalization(.never)
                if !find.isEmpty {
                    Button { find = "" } label: { IconView(.close, size: 20).foregroundStyle(theme.fg) }
                        .buttonStyle(.pressFade).accessibilityLabel(L("Clear"))
                }
            }
            .padding(.horizontal, 10)
            .frame(height: 36)
            .background(theme.fg(0.14), in: RoundedRectangle(cornerRadius: Radius.art))
            Button { menu = sortMenu() } label: {
                Text(L("Sort")).font(.system(size: 13, weight: .bold)).foregroundStyle(theme.fg)
                    .padding(.horizontal, 16).frame(height: 36)
                    .background(theme.fg(0.14), in: Capsule())
            }
            .buttonStyle(.pressFade)
        }
        .padding(.top, 10).padding(.trailing, Spacing.gutter).padding(.bottom, 8).padding(.leading, 56)
        .overlay(alignment: .leading) {
            Button { dismiss() } label: {
                IconView(.backChevron, size: 18).foregroundStyle(theme.fg)
                    .frame(width: 32, height: 32).frame(width: 48, height: 48).contentShape(Rectangle())
            }
            .buttonStyle(.pressFade)
            .padding(.leading, Spacing.gutter - 8)
            .padding(.top, 2)
            .accessibilityLabel(L("Go back"))
        }
        .background(hero.color.ignoresSafeArea(edges: .top))
        .heroIsland()
    }

    // MARK: - Rows

    @ViewBuilder
    private func list(_ shown: [Track], all: [Track]) -> some View {
        let offline = ctx.offline
        if all.isEmpty && loading && !store.likedLoaded {
            SkeletonRows(count: 8, art: true)
        } else if all.isEmpty {
            PlaceholderNote(text: L("Songs you like will appear here. Save songs by tapping the heart icon."))
        } else if shown.isEmpty {
            PlaceholderNote(text: L("No matches for “{query}” in here.", ["query": debounced.trimmingCharacters(in: .whitespaces)]))
        } else {
            LazyVStack(spacing: 0) {
                ForEach(Array(shown.enumerated()), id: \.element.id) { i, t in
                    TrackRow(track: t, showArt: true, isCurrent: player.current?.id == t.id, isPlaying: player.isPlaying,
                             isDownloaded: self.offline.has(t.id),
                             isUnavailable: offline && !self.offline.has(t.id),
                             onTap: { ctx.play(shown, at: i, context: context) },
                             onMore: { menu = trackMenu(t) },
                             onArt: { if !t.albumId.isEmpty { nav.push(.album(id: t.albumId)) } },
                             onTouchDown: { player.prewarm(t) })
                        .frame(height: Shell.trackRow)
                }
            }
        }
    }

    private func fillMissing() async {
        let missing = likedAt.keys.filter { store.likedRows[$0] == nil }
        await store.fillLiked(Array(missing))
    }

    // MARK: - Menus

    private func trackMenu(_ t: Track) -> MenuSheet { menus.sheet(t) }

    /// The whole list (not the find filter), as the web saves it.
    private func download(_ rows: [Track]) -> OfflineCollectionActions {
        OfflineCollectionActions(store: offline, id: OfflineIndex.likedId, name: L("Liked Songs"), kind: .liked, tracks: rows) { confirm = $0 }
    }

    private func sortMenu() -> MenuSheet {
        MenuSheet(header: MenuHeader(art: .icon(.playlist), title: L("Sort by"), subtitle: sort.label),
                  items: LibraryText.LikedSort.allCases.map { s in
                      MenuItem(s.label, icon: s == sort ? .check : nil) { sort = s }
                  })
    }

    private func heroMenu(_ tracks: [Track]) -> MenuSheet {
        let ctx = ctx
        var items: [MenuItem] = [MenuItem(L("Add to queue"), icon: .queue, offline: true) { ctx.player.addToQueue(tracks) }]
        if !tracks.isEmpty {
            var sub: [MenuItem] = [MenuItem(L("New playlist"), icon: .plus) { nameDialog = menus.newPlaylistDialog(seed: tracks.first) }]
            sub += ctx.store.playlists.map { p in MenuItem(p.name) { Task { await ctx.store.add(tracks.map(\.id), to: p) } } }
            items.append(MenuItem(L("Add to playlist"), icon: .plus, sub: sub))
        }
        items += download(tracks).menuItems
        let header = MenuHeader(art: .liked, title: L("Liked Songs"), subtitle: L("Playlist"))
        return MenuSheet(header: header, items: ctx.offline ? MenuItem.offlineSubset(items) : items)
    }
}
